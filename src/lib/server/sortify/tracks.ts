import { sql, type SQL } from 'drizzle-orm';
import { query } from '../db/index.ts';
import { textArray } from '../db/arrays.ts';
import { cover, thumb, trackArtistsJson } from '../entities/shared.ts';
import { eligiblePlaylists } from './catalog.ts';

/**
 * Songs as Sortify draws them: enough to show a card and play it, plus the two
 * keys it groups by and the owned playlists that already hold the recording.
 *
 * Membership is by recording, not by Spotify id: the album cut in a playlist
 * means the single you liked is already sorted. It is read live from
 * `playlist_tracks`, which Sortify's own writes keep current (`writes.ts`),
 * rather than from the derived library tables, which only move after a sync.
 */
export interface SortifyTrack {
	id: string;
	name: string;
	artists: Array<{ id: string; name: string }>;
	album: {
		name: string;
		release_date: string | null;
		/** 640 px. */
		image: string | null;
		/** About 300 px. */
		thumb: string | null;
	};
	duration_ms: number;
	/** The canonical recording (`canonical_tracks.id`). */
	recording: string;
	/** `spotidata.sortify_song_key`: every version of one song shares it. */
	song: string;
	/** The credited artists' Spotify genres, primary artist's first. */
	genres?: string[];
	/** Owned playlists holding this recording, under any Spotify id. */
	in: string[];
}

export type FeedSource = { kind: 'unsorted' } | { kind: 'liked' } | { kind: 'playlist'; id: string };

export function parseSource(raw: string | null): FeedSource | null {
	if (!raw || raw === 'unsorted') return { kind: 'unsorted' };
	if (raw === 'liked') return { kind: 'liked' };
	const m = raw.match(/^playlist:([A-Za-z0-9]+)$/);
	return m?.[1] ? { kind: 'playlist', id: m[1] } : null;
}

/** Recording → owned playlists holding it, as a CTE named `membership`. */
const MEMBERSHIP = sql`
	membership as (
	  select st.canonical_track_id as recording,
	         array_agg(distinct pt.playlist_id order by pt.playlist_id) as playlist_ids
	    from playlist_tracks pt
	    join playlists p on p.id = pt.playlist_id and p.is_owned and p.removed_at is null
	    join spotify_tracks st on st.id = pt.track_id
	   where st.canonical_track_id is not null
	   group by 1
	)`;

/**
 * One JSON object per row of `ordered(track_id, ord)`, in `ord` order. Built in
 * Postgres so ten thousand liked songs cross into JS as one string.
 */
function trackJsonArray(ordered: SQL): SQL {
	return sql`
		with ordered as (${ordered}), ${MEMBERSHIP}
		select coalesce(json_agg(json_strip_nulls(json_build_object(
		  'id', st.id,
		  'name', st.name,
		  'duration_ms', st.duration_ms,
		  'artists', ${trackArtistsJson('st.id')},
		  'album', json_build_object(
		    'name', coalesce(al.name, ''),
		    'release_date', al.release_date,
		    'image', ${cover('album_images', 'album_id', 'al.id')},
		    'thumb', ${thumb('album_images', 'album_id', 'al.id')}),
		  'recording', ct.id,
		  'song', spotidata.sortify_song_key(ct.title, ct.id, ct.primary_artist_id),
		  'genres', (
		    select json_agg(g.genre order by g.pos, g.genre)
		      from (select ag.genre, min(ta.position) as pos
		              from track_artists ta
		              join artist_genres ag on ag.artist_id = ta.artist_id
		             where ta.track_id = st.id
		             group by ag.genre
		             order by min(ta.position), ag.genre
		             limit 6) g),
		  'in', coalesce(m.playlist_ids, '{}')
		)) order by o.ord), '[]')::text as body
		  from ordered o
		  join spotify_tracks st on st.id = o.track_id
		  join canonical_tracks ct on ct.id = st.canonical_track_id
		  left join albums al on al.id = st.album_id
		  left join membership m on m.recording = ct.id
	`;
}

async function runJson(statement: SQL): Promise<string> {
	const rows = await query<{ body: string }>(statement);
	return rows[0]?.body ?? '[]';
}

/**
 * A feed as JSON text:
 * - `unsorted` — liked songs whose recording is in no eligible playlist, newest
 *   first. Monthly mixes and the like do not count as sorted.
 * - `liked` — every liked song, newest first.
 * - `playlist:<id>` — any playlist in the mirror, in its own order, each track
 *   once.
 */
export async function feedJson(source: FeedSource): Promise<string> {
	switch (source.kind) {
		case 'unsorted': {
			const eligible = (await eligiblePlaylists()).map((p) => p.id);
			return runJson(
				trackJsonArray(sql`
					select s.track_id, row_number() over (order by s.added_at desc, s.track_id) as ord
					  from saved_tracks s
					  join spotify_tracks st on st.id = s.track_id
					 where s.removed_at is null
					   and not exists (
					     select 1
					       from playlist_tracks pt
					       join spotify_tracks pst on pst.id = pt.track_id
					      where pt.playlist_id = any(${textArray(eligible)})
					        and pst.canonical_track_id = st.canonical_track_id)
				`)
			);
		}
		case 'liked':
			return runJson(
				trackJsonArray(sql`
					select s.track_id, row_number() over (order by s.added_at desc, s.track_id) as ord
					  from saved_tracks s
					 where s.removed_at is null
				`)
			);
		case 'playlist':
			return runJson(
				trackJsonArray(sql`
					select track_id, min(position) as ord
					  from playlist_tracks
					 where playlist_id = ${source.id} and track_id is not null
					 group by track_id
				`)
			);
	}
}

export async function playlistExists(id: string): Promise<boolean> {
	const rows = await query<{ n: number }>(sql`
		select count(*)::int as n from playlists where id = ${id} and removed_at is null
	`);
	return (rows[0]?.n ?? 0) > 0;
}

/** These tracks, in the order given; ids the mirror does not hold are left out. */
export async function tracksByIds(ids: string[]): Promise<SortifyTrack[]> {
	if (ids.length === 0) return [];
	const body = await runJson(
		trackJsonArray(sql`
			select t.id as track_id, t.ord
			  from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) with ordinality as t(id, ord)
		`)
	);
	return JSON.parse(body) as SortifyTrack[];
}

/**
 * Every song by this artist that bulk sorting can reach: the liked songs, plus
 * the playlist being gone through. Newest liked first, then the playlist's
 * own order.
 */
export async function tracksByArtist(artistId: string, source: FeedSource | null): Promise<SortifyTrack[]> {
	const playlistId = source?.kind === 'playlist' ? source.id : null;
	const body = await runJson(
		trackJsonArray(sql`
			select track_id, min(ord) as ord from (
			  select s.track_id, row_number() over (order by s.added_at desc, s.track_id) as ord
			    from saved_tracks s
			   where s.removed_at is null
			     and exists (select 1 from track_artists ta where ta.track_id = s.track_id and ta.artist_id = ${artistId})
			  union all
			  select pt.track_id, 1000000 + pt.position
			    from playlist_tracks pt
			   where pt.playlist_id = ${playlistId} and pt.track_id is not null
			     and exists (select 1 from track_artists ta where ta.track_id = pt.track_id and ta.artist_id = ${artistId})
			) x
			group by track_id
		`)
	);
	return JSON.parse(body) as SortifyTrack[];
}

/** Recording → owned playlists holding it, for the recordings given. */
export async function membershipOf(recordings: string[]): Promise<Record<string, string[]>> {
	if (recordings.length === 0) return {};
	const rows = await query<{ recording: string; playlist_ids: string[] }>(sql`
		select r.recording,
		       coalesce((
		         select array_agg(distinct pt.playlist_id order by pt.playlist_id)
		           from spotify_tracks st
		           join playlist_tracks pt on pt.track_id = st.id
		           join playlists p on p.id = pt.playlist_id and p.is_owned and p.removed_at is null
		          where st.canonical_track_id = r.recording
		       ), '{}') as playlist_ids
		  from unnest(${textArray(recordings)}) as r(recording)
	`);
	return Object.fromEntries(rows.map((r) => [r.recording, r.playlist_ids]));
}
