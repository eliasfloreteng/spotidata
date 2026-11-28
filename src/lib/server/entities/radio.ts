import { sql } from 'drizzle-orm';
import { anyOf } from '../db/arrays.ts';
import { db, query } from '../db/index.ts';
import { pickImage } from '../spotify/images.ts';
import { BATCH, chunk, getTracks } from '../spotify/endpoints.ts';
import {
	SpotifyApiError,
	SpotifyAuthExpired,
	SpotifyForbidden,
	SpotifyNotFound,
	SpotifyRateLimited
} from '../spotify/errors.ts';
import type { FullTrack } from '../spotify/types.ts';
import { webPlayerGet, WebPlayerError } from '../spotify/web-player.ts';
import type { ArtistRef } from './shared.ts';

/**
 * A song's Spotify radio: the 50-track "<Song> Radio" playlist Spotify builds
 * from one seed track.
 *
 * Three hops, because no single API holds all of it. Spotify's internal API
 * (see `spotify/web-player.ts`) names the radio playlist and lists its track
 * ids — the Web API will show this app neither. The Web API's `/tracks` then
 * fills in what a list needs (ISRC, album, artist ids, cover) in one request
 * per 50, through the same bucket as the sync. And the archive says which of
 * them the library already holds, matched on the recording rather than the
 * Spotify id, since a radio often plays a different release of a song you
 * keep.
 *
 * Every radio fetched is stored (`song_radios`, `song_radio_tracks`), whether
 * a page asked for it or the background sync did (`syncSongRadio`), so what
 * the DJ tab ranks by is the last radio anyone saw. A page still reads Spotify
 * live: a radio is regenerated, and that page is for seeing what it plays now.
 */

export interface RadioTrack {
	id: string;
	title: string;
	artists: ArtistRef[];
	album: { id: string; name: string } | null;
	isrc?: string;
	duration_ms: number;
	explicit: boolean;
	/** About 300 px. */
	cover?: string;
	/** The recording this archive groups the track under, when it has seen any copy of it. */
	canonical_id: string | null;
	/** Liked, or in a playlist you own — under any copy of the recording. */
	in_library: boolean;
	liked: boolean;
	/** Your plays of the recording, under any copy. */
	plays: number;
}

export interface SongRadio {
	/** The track the radio was built from. */
	seed: string;
	/** The radio's playlist id. Spotify-owned, so the Web API answers 404 for it. */
	id: string;
	name: string;
	description: string;
	image?: string;
	tracks: RadioTrack[];
}

interface SeedToPlaylist {
	mediaItems?: Array<{ uri?: string }>;
}

interface PlaylistV2 {
	attributes?: {
		name?: string;
		description?: string;
		pictureSize?: Array<{ targetName?: string; url?: string }>;
	};
	contents?: { items?: Array<{ uri?: string }> };
}

/** Why a radio could not be fetched, as an HTTP status and a sentence for a person. */
export interface RadioFailure {
	status: number;
	message: string;
	retryAfterSeconds?: number;
}

/**
 * Every way fetching a radio fails for a reason outside this app, as a status
 * the page, the API route and the MCP tool all report the same way. Null for
 * anything else, which is a bug and should stay a 500.
 */
export function radioFailure(err: unknown): RadioFailure | null {
	if (err instanceof WebPlayerError) {
		return {
			status: err.status === 429 ? 503 : err.status === 504 ? 504 : 502,
			message: `Spotify's web player failed (${err.status}) at ${err.path}.`,
			retryAfterSeconds: err.retryAfterSeconds
		};
	}
	if (err instanceof SpotifyRateLimited) {
		return {
			status: 503,
			message: `The radio was found, but the Web API that fills in its tracks is rate limited until ${err.until.toISOString()}.`,
			retryAfterSeconds: Math.max(1, err.retryAfterSeconds)
		};
	}
	if (err instanceof SpotifyAuthExpired) {
		return { status: 503, message: 'The Spotify sign-in has expired. Sign in to Spotidata again.' };
	}
	if (err instanceof SpotifyApiError || err instanceof SpotifyForbidden || err instanceof SpotifyNotFound) {
		const status = err instanceof SpotifyApiError ? err.status : err instanceof SpotifyForbidden ? 403 : 404;
		return { status: 502, message: `Spotify's Web API answered ${status} for ${err.path}.` };
	}
	return null;
}

const TRACK_URI = /^spotify:track:([A-Za-z0-9]{22})$/;
const PLAYLIST_URI = /^spotify:playlist:([A-Za-z0-9]{22})$/;

interface RadioPlaylist {
	id: string;
	name: string;
	description: string;
	image?: string;
	trackIds: string[];
}

/**
 * The radio's playlist and its track ids, from the web player. Null when
 * Spotify has no such track or no radio for it.
 */
async function radioPlaylist(trackId: string): Promise<RadioPlaylist | null> {
	let playlistId: string | undefined;
	let playlist: PlaylistV2 | null;
	try {
		const seed = await webPlayerGet<SeedToPlaylist>(
			`/inspiredby-mix/v2/seed_to_playlist/spotify:track:${trackId}?response-format=json`,
			trackId
		);
		playlistId = seed?.mediaItems?.[0]?.uri?.match(PLAYLIST_URI)?.[1];
		if (!playlistId) return null;
		// Spotify answers the lookup for any id, a made-up one included, and only
		// the playlist it names turns out not to exist.
		playlist = await webPlayerGet<PlaylistV2>(
			`/playlist/v2/playlist/${playlistId}?decorate=attributes`,
			trackId
		);
	} catch (err) {
		// The embed page 404s for a track that does not exist.
		if (err instanceof WebPlayerError && err.status === 404) return null;
		throw err;
	}
	if (!playlist) return null;
	const a = playlist.attributes ?? {};
	return {
		id: playlistId,
		name: a.name ?? 'Radio',
		description: a.description ?? '',
		image: (a.pictureSize?.find((p) => p.targetName === 'default') ?? a.pictureSize?.[0])?.url,
		trackIds: (playlist.contents?.items ?? []).flatMap((i) => i.uri?.match(TRACK_URI)?.[1] ?? [])
	};
}

/** A full track for each id Spotify still serves, in the radio's order. */
async function fullTracks(ids: string[]): Promise<Array<FullTrack & { id: string }>> {
	const full: Array<FullTrack & { id: string }> = [];
	for (const batch of chunk(ids, BATCH.tracks)) {
		const { tracks } = await getTracks(batch);
		// A null is a track Spotify no longer serves to this market.
		for (const t of tracks) if (t?.id) full.push({ ...t, id: t.id });
	}
	return full;
}

/** Null when Spotify has no such track, or no radio for it. Stores what it read. */
export async function songRadio(trackId: string): Promise<SongRadio | null> {
	const playlist = await radioPlaylist(trackId);
	if (!playlist) {
		await storeRadio(trackId, null, []);
		return null;
	}
	const full = await fullTracks(playlist.trackIds);
	await storeRadio(
		trackId,
		playlist,
		full.map((t) => ({
			trackId: t.id,
			isrc: normalIsrc(t.external_ids?.isrc) ?? null,
			title: t.name,
			artistIds: t.artists.map((x) => x.id)
		}))
	);

	const marks = await libraryMarks(
		full.map((t) => ({ id: t.id, isrc: normalIsrc(t.external_ids?.isrc) ?? null }))
	);
	return {
		seed: trackId,
		id: playlist.id,
		name: playlist.name,
		description: playlist.description,
		image: playlist.image,
		tracks: full.map((t) => {
			const m = marks.get(t.id);
			return {
				id: t.id,
				title: t.name,
				artists: t.artists.map((x) => ({ id: x.id, name: x.name })),
				album: t.album ? { id: t.album.id, name: t.album.name } : null,
				isrc: normalIsrc(t.external_ids?.isrc),
				duration_ms: t.duration_ms,
				explicit: t.explicit,
				cover: pickImage(t.album?.images),
				canonical_id: m?.canonicalId ?? null,
				in_library: m?.inLibrary ?? false,
				liked: m?.liked ?? false,
				plays: m?.plays ?? 0
			};
		})
	};
}

// ------------------------------------------------------------------ stored

/** One record of a stored radio: what matching it to the library takes. */
interface StoredTrack {
	trackId: string;
	isrc: string | null;
	title: string;
	artistIds: string[];
}

/**
 * Fetches a track's radio and stores it, spending as little of the Web API as
 * it can: the archive already holds most of what a radio plays as full tracks
 * (ISRC and artists included), so only the rest is asked for — usually one
 * `/tracks` request, often none. Returns whether Spotify had a radio.
 */
export async function syncSongRadio(trackId: string): Promise<boolean> {
	const playlist = await radioPlaylist(trackId);
	if (!playlist) {
		await storeRadio(trackId, null, []);
		return false;
	}
	const known = await query<StoredTrack>(sql`
		select st.id as "trackId",
		       upper(nullif(btrim(st.isrc), '')) as isrc,
		       st.name as title,
		       coalesce(array_agg(ta.artist_id order by ta.position)
		                  filter (where ta.artist_id is not null), '{}') as "artistIds"
		  from spotify_tracks st
		  left join track_artists ta on ta.track_id = st.id
		 where st.id = ${anyOf(playlist.trackIds)} and st.detail_level = 'full'
		 group by st.id
	`);
	const byId = new Map(known.map((t) => [t.trackId, t]));
	for (const t of await fullTracks(playlist.trackIds.filter((id) => !byId.has(id)))) {
		byId.set(t.id, {
			trackId: t.id,
			isrc: normalIsrc(t.external_ids?.isrc) ?? null,
			title: t.name,
			artistIds: t.artists.map((x) => x.id)
		});
	}
	await storeRadio(
		trackId,
		playlist,
		playlist.trackIds.flatMap((id) => byId.get(id) ?? [])
	);
	return true;
}

/**
 * Replaces the stored radio of `seed`, or records that it has none. A seed
 * the archive has never seen (a radio page opened for any track at all) is
 * not stored: the rows key on `spotify_tracks`, and nothing ranks by its radio.
 */
async function storeRadio(
	seed: string,
	playlist: RadioPlaylist | null,
	tracks: StoredTrack[]
): Promise<void> {
	await db.transaction(async (tx) => {
		const { rows } = await tx.execute<{ seed: string }>(sql`
			insert into song_radios (seed_track_id, playlist_id, name, description, image, track_count, fetched_at)
			select st.id, ${playlist?.id ?? null}, ${playlist?.name ?? null}, ${playlist?.description ?? null},
			       ${playlist?.image ?? null}, ${tracks.length}, now()
			  from spotify_tracks st where st.id = ${seed}
			on conflict (seed_track_id) do update
			   set playlist_id = excluded.playlist_id, name = excluded.name,
			       description = excluded.description, image = excluded.image,
			       track_count = excluded.track_count, fetched_at = excluded.fetched_at
			returning seed_track_id as seed
		`);
		if (rows.length === 0) return;
		await tx.execute(sql`delete from song_radio_tracks where seed_track_id = ${seed}`);
		if (tracks.length === 0) return;
		await tx.execute(sql`
			insert into song_radio_tracks (seed_track_id, position, track_id, isrc, title, artist_ids)
			select ${seed}, t.position, t."trackId", t.isrc, t.title,
			       array(select jsonb_array_elements_text(t."artistIds"))
			  from jsonb_to_recordset(${JSON.stringify(tracks.map((t, position) => ({ ...t, position })))}::jsonb)
			    as t(position int, "trackId" text, isrc text, title text, "artistIds" jsonb)
		`);
	});
}

const normalIsrc = (isrc: string | undefined) => isrc?.trim().toUpperCase() || undefined;

interface Mark {
	id: string;
	canonicalId: string | null;
	inLibrary: boolean;
	liked: boolean;
	plays: number;
}

/**
 * What the archive knows of each track, by its own id or, for a release it
 * has never seen, by the recording's ISRC — the canonical id is `isrc:<ISRC>`
 * for every recording that has one.
 */
async function libraryMarks(tracks: Array<{ id: string; isrc: string | null }>): Promise<Map<string, Mark>> {
	if (tracks.length === 0) return new Map();
	const rows = await query<Mark>(sql`
		select t.id,
		       ct.id                                      as "canonicalId",
		       lc.canonical_track_id is not null          as "inLibrary",
		       coalesce(lc.liked, false)                  as liked,
		       coalesce(cps.plays, 0)::int                as plays
		  from jsonb_to_recordset(${JSON.stringify(tracks)}::jsonb) as t(id text, isrc text)
		  left join spotify_tracks st        on st.id = t.id
		  left join canonical_tracks ct      on ct.id = coalesce(st.canonical_track_id, 'isrc:' || t.isrc)
		  left join library_canonical lc     on lc.canonical_track_id = ct.id
		  left join canonical_play_stats cps on cps.canonical_track_id = ct.id
	`);
	return new Map(rows.map((r) => [r.id, r]));
}
