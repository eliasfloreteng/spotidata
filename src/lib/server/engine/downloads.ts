import { sql } from 'drizzle-orm';
import { query } from '../db/index.ts';
import { anyOf } from '../db/arrays.ts';
import { chunk, getTracks } from '../spotify/endpoints.ts';
import { isFullTrack, type FullTrack } from '../spotify/types.ts';
import type { DownloadPhase, DownloadStatus, TrackRef } from '../../downloads.ts';
import {
	engineDownloads,
	queueDownload,
	EngineUnavailable,
	type CatalogTrack as EngineTrack
} from './client.ts';
import { engineSchema } from './recordings.ts';
import { toCatalogTrack, type CatalogTrack } from './search.ts';

/**
 * What every page that lists tracks says about getting them: whether the
 * music folder holds each one, or the engine is getting it, or failed to.
 *
 * Read from the engine's own tables rather than its API, the way the track
 * page reads tempo and key: a playlist of a thousand tracks is one query, and
 * the pages still load while the engine is down. Only live progress (bytes so
 * far) lives in the engine's memory, so that alone is asked of it, and only
 * while something is downloading.
 *
 * A track is in the folder when `deckhand.recordings` has its ISRC, or when the
 * download that got it filed a file the engine has not seen leave (one the
 * scanner has yet to read, or a track Spotify gives no ISRC). Otherwise its newest download decides, found by the ISRC it
 * was asked for with or by its Spotify id. A download you stopped counts as
 * none, so the button to get it comes back.
 */

interface Row {
	id: string;
	recordingFile: string | null;
	downloadId: number | null;
	state: DownloadPhase | 'done' | 'failed' | null;
	source: string | null;
	error: string | null;
	file: string | null;
	/** The engine saw the file leave the folder (and not come back). */
	fileGone: boolean;
}

export async function downloadStatuses(refs: TrackRef[]): Promise<Record<string, DownloadStatus>> {
	const out: Record<string, DownloadStatus> = {};
	if (refs.length === 0) return out;
	for (const ref of refs) out[ref.id] = { state: 'none' };
	if (!(await engineSchema())) return out;

	const wanted = JSON.stringify(refs.map((r) => ({ id: r.id, isrc: r.isrc ?? null })));
	const rows = await query<Row>(sql`
		with t as (
		  select distinct on (r.id) r.id,
		         coalesce(nullif(upper(trim(r.isrc)), ''), nullif(upper(trim(st.isrc)), '')) as isrc
		    from jsonb_to_recordset(${wanted}::jsonb) as r(id text, isrc text)
		    left join spotify_tracks st on st.id = r.id
		),
		dl as (
		  select distinct on (v.k) v.k, d.id, d.state, d.source, d.error, d.file
		    from deckhand.downloads d
		   cross join lateral (values
		           (case when coalesce(d.track ->> 'isrc', '') <> ''
		                 then 'isrc:' || upper(d.track ->> 'isrc') end),
		           (d.catalog_id)) as v(k)
		   where v.k is not null and d.state <> 'cancelled'
		   order by v.k, d.id desc
		)
		select t.id,
		       rec.file                    as "recordingFile",
		       d.id                        as "downloadId",
		       d.state,
		       d.source,
		       d.error,
		       d.file,
		       (gone.name is not null and f.name is null) as "fileGone"
		  from t
		  left join deckhand.recordings rec on rec.isrc = t.isrc
		  left join dl a on a.k = 'isrc:' || t.isrc
		  left join dl b on b.k = 'spotify:' || t.id
		  left join lateral (
		    select x.* from (values (a.id, a.state, a.source, a.error, a.file),
		                            (b.id, b.state, b.source, b.error, b.file))
		                 as x(id, state, source, error, file)
		     where x.id is not null
		     order by x.id desc limit 1
		  ) d on true
		  left join deckhand.files f on f.name = d.file
		  left join deckhand.tombstones gone on gone.name = d.file
	`);

	for (const r of rows) out[r.id] = toStatus(r);
	return out;
}

function toStatus(r: Row): DownloadStatus {
	if (r.recordingFile) return { state: 'here', file: r.recordingFile };
	if (r.downloadId === null || r.state === null) return { state: 'none' };
	switch (r.state) {
		case 'done':
			// Filed by the download, but perhaps not yet seen by the engine's
			// scanner: in the folder unless the engine saw it leave.
			return r.file && !r.fileGone ? { state: 'here', file: r.file } : { state: 'none' };
		case 'failed':
			return { state: 'failed', id: r.downloadId, error: r.error };
		default:
			return {
				state: 'getting',
				id: r.downloadId,
				phase: r.state,
				source: r.source,
				detail: r.state === 'waiting' ? r.error : null
			};
	}
}

/**
 * The statuses with each running download's bytes so far, from the engine.
 * Without the engine they are still right, only without the percentage.
 */
export async function withProgress(statuses: Record<string, DownloadStatus>): Promise<Record<string, DownloadStatus>> {
	const running = Object.values(statuses).some((s) => s.state === 'getting' && s.phase === 'downloading');
	if (!running) return statuses;
	let live: Map<number, { received: number; total: number | null }>;
	try {
		const { downloads } = await engineDownloads();
		live = new Map(downloads.map((d) => [d.id, { received: d.received, total: d.total ?? null }]));
	} catch (err) {
		if (err instanceof EngineUnavailable) return statuses;
		throw err;
	}
	const out: Record<string, DownloadStatus> = {};
	for (const [id, s] of Object.entries(statuses)) {
		const l = s.state === 'getting' ? live.get(s.id) : undefined;
		out[id] = l && s.state === 'getting' ? { ...s, ...l } : s;
	}
	return out;
}

/** Statuses for a page's load: one query, plus the engine's progress while something downloads. */
export async function statusesFor(refs: TrackRef[]): Promise<Record<string, DownloadStatus>> {
	return withProgress(await downloadStatuses(refs));
}

/**
 * The tracks as the engine is to be handed them, from the archive, and for
 * any it has never stored (a song radio's) from Spotify, through the one
 * rate limiter. Ids Spotify no longer serves are left out.
 */
async function catalogTracks(ids: string[]): Promise<Map<string, CatalogTrack>> {
	const rows = await query<CatalogTrack>(sql`
		select st.id,
		       st.name                                     as title,
		       array(select ar.name from track_artists ta join artists ar on ar.id = ta.artist_id
		              where ta.track_id = st.id order by ta.position) as artists,
		       coalesce(al.name, '')                       as album,
		       nullif(upper(trim(st.isrc)), '')            as isrc,
		       st.duration_ms,
		       (select i.url from album_images i where i.album_id = st.album_id
		         order by (coalesce(i.width, 0) < 200), coalesce(i.width, 0) limit 1) as cover,
		       coalesce(st.explicit, false)                as explicit
		  from spotify_tracks st
		  left join albums al on al.id = st.album_id
		 where st.id = ${anyOf(ids)} and st.name <> '' and st.duration_ms > 0
	`);
	const found = new Map<string, CatalogTrack>(rows.map((r) => [r.id, { ...r, isrc: r.isrc ?? undefined, cover: r.cover ?? undefined }]));
	const unknown = ids.filter((id) => !found.has(id));
	for (const ids of chunk(unknown, 50)) {
		const { tracks } = await getTracks(ids);
		for (const t of tracks) {
			if (isFullTrack(t) && t.id) found.set(t.id, toCatalogTrack(t as FullTrack & { id: string }));
		}
	}
	return found;
}

function forEngine(t: CatalogTrack): EngineTrack {
	return {
		id: `spotify:${t.id}`,
		title: t.title,
		artists: t.artists,
		album: t.album,
		isrc: t.isrc,
		duration_sec: Math.round(t.duration_ms / 1000),
		cover: t.cover,
		explicit: t.explicit
	};
}

/** The most one request may queue: an album, a playlist, a page of the library. */
export const MAX_QUEUE = 500;

export interface Queued {
	/** Downloads the engine queued (or already had under way). */
	queued: number;
	/** Already in the folder or on the way, so not asked for again. */
	skipped: number;
	/** Ids Spotify could not describe, so the engine cannot look for them. */
	unknown: string[];
	statuses: Record<string, DownloadStatus>;
}

/**
 * Has the engine get these tracks, leaving out what the folder holds and what
 * it is getting already. The engine itself answers a track it is already
 * getting with that download, so a double click queues it once.
 */
export async function queueTracks(ids: string[]): Promise<Queued> {
	const unique = [...new Set(ids)].slice(0, MAX_QUEUE);
	const before = await downloadStatuses(unique.map((id) => ({ id })));
	const wanted = unique.filter((id) => {
		const s = before[id];
		return !s || s.state === 'none' || s.state === 'failed';
	});
	const tracks = await catalogTracks(wanted);
	let queued = 0;
	for (const id of wanted) {
		const track = tracks.get(id);
		if (!track) continue;
		await queueDownload(forEngine(track));
		queued++;
	}
	return {
		queued,
		skipped: unique.length - wanted.length,
		unknown: wanted.filter((id) => !tracks.has(id)),
		statuses: await downloadStatuses(unique.map((id) => ({ id, isrc: tracks.get(id)?.isrc })))
	};
}

export interface PlaylistKeeping {
	kept: boolean;
	/** The `.m3u8` the engine wrote for it in the music folder. */
	file: string | null;
	/** Why the engine could not read it last time. */
	error: string | null;
}

/** Which of these playlists the engine keeps in the music folder. */
export async function keptPlaylists(ids: string[]): Promise<Record<string, PlaylistKeeping>> {
	const out: Record<string, PlaylistKeeping> = {};
	if (ids.length === 0 || !(await engineSchema())) return out;
	const rows = await query<PlaylistKeeping & { id: string }>(sql`
		select id, selected as kept, file, error
		  from deckhand.spotify_playlists
		 where id = ${anyOf(ids)}
	`);
	for (const { id, ...keeping } of rows) out[id] = keeping;
	return out;
}

/**
 * The recording each of the engine's downloads is of, for the downloads page
 * to link to: by the Spotify id it was asked for with, else by its ISRC.
 * Downloads of recordings the archive has never seen are left out.
 */
export async function recordingsOf(
	downloads: { id: number; track: { id: string; isrc?: string } }[]
): Promise<Record<number, string>> {
	if (downloads.length === 0) return {};
	const wanted = JSON.stringify(
		downloads.map((d) => ({
			id: d.id,
			spotify: d.track.id.startsWith('spotify:') ? d.track.id.slice('spotify:'.length) : null,
			isrc: d.track.isrc ?? null
		}))
	);
	const rows = await query<{ id: number; canonical: string }>(sql`
		select d.id,
		       coalesce(st.canonical_track_id,
		                (select c.id from canonical_tracks c
		                  where c.id in ('isrc:' || d.isrc, 'isrc:' || lower(d.isrc)) limit 1)) as canonical
		  from jsonb_to_recordset(${wanted}::jsonb) as d(id bigint, spotify text, isrc text)
		  left join spotify_tracks st on st.id = d.spotify
	`);
	const out: Record<number, string> = {};
	for (const r of rows) if (r.canonical) out[r.id] = r.canonical;
	return out;
}

/** How many downloads are queued or running (not waiting for you): for the header. */
export async function activeDownloads(): Promise<number> {
	if (!(await engineSchema())) return 0;
	const [row] = await query<{ n: number }>(sql`
		select count(*)::int as n from deckhand.downloads
		 where state in ('queued', 'searching', 'downloading', 'finishing')
	`);
	return row?.n ?? 0;
}
