import { sql, type SQL } from 'drizzle-orm';
import { anyOf } from '../db/arrays.ts';
import { query } from '../db/index.ts';
import { iso, like, thumb, total, type ArtistRef } from './shared.ts';

/**
 * Genres, and the collections built out of them.
 *
 * Everything reads `spotidata.track_genres` (db/sql/post/100_genres.sql) —
 * MusicBrainz recording tags, the only genre this catalog has that describes a
 * *track* rather than the artist who happened to record it.
 *
 * A collection is a saved set of genres plus a match mode. It is never a saved
 * set of tracks: the track list is recomputed from the genres every time it is
 * read or pushed, so enriching a recording tomorrow puts it in the playlist
 * tomorrow without anyone editing anything.
 */

export const COLLECTION_SORTS = {
	added: 'lc.first_added_at desc',
	plays: 'coalesce(cps.plays, 0) desc',
	listened: 'coalesce(cps.ms_played, 0) desc',
	popularity: 'ct.max_popularity desc nulls last',
	released: 'ct.earliest_release_date desc nulls last',
	title: 'ct.title asc',
	artist: 'pa.name asc nulls last',
	random: 'md5(ct.id) asc'
} as const;
export type CollectionSort = keyof typeof COLLECTION_SORTS;

export const SORT_LABELS: Record<CollectionSort, string> = {
	added: 'Recently added',
	plays: 'Most played',
	listened: 'Most listened',
	popularity: 'Most popular',
	released: 'Newest release',
	title: 'Title',
	artist: 'Artist',
	random: 'Shuffled (stable)'
};

export const isSort = (v: string): v is CollectionSort => v in COLLECTION_SORTS;

/** Spotify's own playlist ceiling; a collection's limit is checked against it. */
export const MAX_TRACKS = 10_000;

// ---------------------------------------------------------------- vocabulary

export interface GenreOption {
	genre: string;
	/** Recordings in the library carrying this genre. */
	tracks: number;
	plays: number;
}

/**
 * Every genre that describes something in the library, most-used first.
 *
 * Not a top-N: a genre already in a collection but missing from the list would
 * be a filter the page can neither show nor remove.
 */
export async function genreVocabulary(): Promise<GenreOption[]> {
	return query<GenreOption>(sql`
		select tg.genre,
		       count(distinct tg.canonical_track_id)::int as tracks,
		       coalesce(sum(cps.plays), 0)::int           as plays
		  from spotidata.track_genres tg
		  join library_canonical lc on lc.canonical_track_id = tg.canonical_track_id
		  left join canonical_play_stats cps on cps.canonical_track_id = tg.canonical_track_id
		 group by tg.genre
		 order by tracks desc, tg.genre
	`);
}

/** How much of the library has a MusicBrainz genre at all — the honest denominator. */
export async function genreCoverage(): Promise<{ described: number; library: number }> {
	const rows = await query<{ described: number; library: number }>(sql`
		select (select count(distinct tg.canonical_track_id)::int
		          from spotidata.track_genres tg
		          join library_canonical lc on lc.canonical_track_id = tg.canonical_track_id) as described,
		       (select count(*)::int from library_canonical) as library
	`);
	return rows[0] ?? { described: 0, library: 0 };
}

// --------------------------------------------------------------- collections

export interface Collection {
	id: string;
	name: string;
	description: string | null;
	match: 'any' | 'all';
	sort: CollectionSort;
	trackLimit: number;
	spotifyPlaylistId: string | null;
	playlistPublic: boolean;
	autoSync: boolean;
	syncedFingerprint: string | null;
	syncedSnapshotId: string | null;
	syncedTrackCount: number;
	lastSyncedAt: string | null;
	lastSyncError: string | null;
	updatedAt: string;
	genres: string[];
}

const COLLECTION_COLUMNS = sql`
	       c.id,
	       c.name,
	       c.description,
	       c.match,
	       c.sort,
	       c.track_limit          as "trackLimit",
	       c.spotify_playlist_id  as "spotifyPlaylistId",
	       c.playlist_public      as "playlistPublic",
	       c.auto_sync            as "autoSync",
	       c.synced_fingerprint   as "syncedFingerprint",
	       c.synced_snapshot_id   as "syncedSnapshotId",
	       c.synced_track_count   as "syncedTrackCount",
	       ${iso('c.last_synced_at')} as "lastSyncedAt",
	       c.last_sync_error      as "lastSyncError",
	       ${iso('c.updated_at')} as "updatedAt",
	       coalesce((select array_agg(g.genre order by g.genre)
	                   from genre_collection_genres g
	                  where g.collection_id = c.id), '{}'::text[]) as genres`;

export interface CollectionSummary extends Collection {
	/** Tracks the collection currently resolves to — recomputed, never stored. */
	trackCount: number;
}

/**
 * The index. The per-collection count is a correlated subquery rather than a
 * join: each one has its own genre set and match mode, and there is no single
 * GROUP BY that answers for all of them.
 */
export async function listCollections(): Promise<CollectionSummary[]> {
	return query<CollectionSummary>(sql`
		select ${COLLECTION_COLUMNS},
		       (select count(*)::int
		          from library_canonical lc
		          join canonical_tracks ct on ct.id = lc.canonical_track_id
		         where case when c.match = 'all'
		                    then (select count(distinct tg.genre) from spotidata.track_genres tg
		                           where tg.canonical_track_id = ct.id
		                             and tg.genre in (select g.genre from genre_collection_genres g
		                                               where g.collection_id = c.id))
		                         = (select count(*) from genre_collection_genres g where g.collection_id = c.id)
		                    else exists (select 1 from spotidata.track_genres tg
		                                  where tg.canonical_track_id = ct.id
		                                    and tg.genre in (select g.genre from genre_collection_genres g
		                                                      where g.collection_id = c.id))
		               end
		           and exists (select 1 from genre_collection_genres g where g.collection_id = c.id)
		       ) as "trackCount"
		  from genre_collections c
		 order by c.updated_at desc
	`);
}

export async function getCollection(id: string): Promise<Collection | null> {
	const rows = await query<Collection>(sql`
		select ${COLLECTION_COLUMNS} from genre_collections c where c.id = ${id}
	`);
	return rows[0] ?? null;
}

/**
 * A readable, stable id. The slug comes from the name so a URL says what it
 * points at, and a numeric suffix resolves the collision rather than a random
 * tail nobody can read — but it is minted once and never follows a rename.
 */
export async function createCollection(name: string, genres: string[] = []): Promise<string> {
	const base =
		name
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')
			.slice(0, 48) || 'collection';

	const taken = await query<{ id: string }>(sql`
		select id from genre_collections where id = ${base} or id like ${base + '-%'}
	`);
	const ids = new Set(taken.map((r) => r.id));
	let id = base;
	for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;

	await query(sql`insert into genre_collections (id, name) values (${id}, ${name})`);
	if (genres.length) await addGenres(id, genres);
	return id;
}

export async function addGenres(id: string, genres: string[]): Promise<void> {
	if (genres.length === 0) return;
	await query(sql`
		insert into genre_collection_genres (collection_id, genre)
		select ${id}, value from jsonb_array_elements_text(${JSON.stringify(genres)}::jsonb)
		    on conflict do nothing
	`);
	await touch(id);
}

export async function removeGenre(id: string, genre: string): Promise<void> {
	await query(sql`
		delete from genre_collection_genres where collection_id = ${id} and genre = ${genre}
	`);
	await touch(id);
}

export async function updateCollection(
	id: string,
	patch: {
		name?: string;
		description?: string | null;
		match?: 'any' | 'all';
		sort?: CollectionSort;
		trackLimit?: number;
		autoSync?: boolean;
		playlistPublic?: boolean;
	}
): Promise<void> {
	const sets: SQL[] = [];
	if (patch.name !== undefined) sets.push(sql`name = ${patch.name}`);
	if (patch.description !== undefined) sets.push(sql`description = ${patch.description}`);
	if (patch.match !== undefined) sets.push(sql`match = ${patch.match}`);
	if (patch.sort !== undefined) sets.push(sql`sort = ${patch.sort}`);
	if (patch.trackLimit !== undefined) sets.push(sql`track_limit = ${patch.trackLimit}`);
	if (patch.autoSync !== undefined) sets.push(sql`auto_sync = ${patch.autoSync}`);
	if (patch.playlistPublic !== undefined) sets.push(sql`playlist_public = ${patch.playlistPublic}`);
	if (sets.length === 0) return;
	await query(sql`
		update genre_collections set ${sql.join(sets, sql`, `)}, updated_at = now() where id = ${id}
	`);
}

export async function deleteCollection(id: string): Promise<void> {
	await query(sql`delete from genre_collections where id = ${id}`);
}

/**
 * Forgets the Spotify playlist without touching it. The copy on Spotify stays
 * exactly as it is and simply stops being rewritten — deleting somebody's
 * playlist from here would be the wrong default, and Spotify has no
 * delete-playlist call anyway, only "unfollow".
 */
export async function unlinkPlaylist(id: string): Promise<void> {
	await query(sql`
		update genre_collections
		   set spotify_playlist_id = null, synced_fingerprint = null,
		       synced_snapshot_id = null, synced_track_count = 0,
		       last_sync_error = null, updated_at = now()
		 where id = ${id}
	`);
}

const touch = (id: string) =>
	query(sql`update genre_collections set updated_at = now() where id = ${id}`);

// ------------------------------------------------------------- the tracks

/**
 * The membership test, which is the whole definition of a collection.
 *
 * "All" is a count rather than a chain of EXISTS: one index scan per track
 * either way, and it stays one clause however many genres are selected. Both
 * forms are false for an empty selection, which is what an empty collection
 * should resolve to — no genres, no tracks.
 */
function matches(genres: string[], match: 'any' | 'all'): SQL {
	if (genres.length === 0) return sql`false`;
	const wanted = sql`tg.canonical_track_id = ct.id and tg.genre = ${anyOf(genres)}`;
	return match === 'all'
		? sql`(select count(distinct tg.genre) from spotidata.track_genres tg
		        where ${wanted}) = ${genres.length}`
		: sql`exists (select 1 from spotidata.track_genres tg where ${wanted})`;
}

const TRACKS_FROM = sql`
	  from library_canonical lc
	  join canonical_tracks ct on ct.id = lc.canonical_track_id
	  left join canonical_play_stats cps on cps.canonical_track_id = lc.canonical_track_id
	  left join albums al on al.id = ct.primary_album_id
	  left join artists pa on pa.id = ct.primary_artist_id`;

export interface GenreTrackRow {
	total: number;
	canonicalTrackId: string;
	/** The copy the playlist gets — one Spotify id per recording, never fourteen. */
	trackId: string;
	title: string;
	durationMs: number;
	popularity: number | null;
	explicit: boolean;
	liked: boolean;
	firstAddedAt: string;
	albumId: string | null;
	albumName: string | null;
	cover: string | null;
	artists: ArtistRef[];
	genres: string[];
	plays: number;
	msPlayed: number;
	/** Position in the pushed list — beyond the limit it would be cut. */
	rank: number;
}

/**
 * One page of what a genre set resolves to.
 *
 * `rank` comes from a window over the *same* ORDER BY the push uses, so the
 * page can show exactly where the track limit falls. Ordering is by the
 * collection's sort then `ct.id`, which keeps paging stable when a sort key
 * ties — and it must, or a track could appear on two pages and on neither.
 */
export async function resolveTracks(
	spec: { genres: string[]; match: 'any' | 'all'; sort: CollectionSort },
	opts: { limit: number; offset: number; q?: string }
): Promise<GenreTrackRow[]> {
	if (spec.genres.length === 0) return [];
	const order = sql.raw(`${COLLECTION_SORTS[spec.sort]}, ct.id`);
	const search = opts.q
		? sql` and (${like(sql`ct.title`, opts.q)} or ${like(sql`pa.name`, opts.q)} or ${like(sql`al.name`, opts.q)})`
		: sql``;
	return query<GenreTrackRow>(sql`
		select ${total},
		       row_number() over (order by ${order})::int as rank,
		       ct.id                      as "canonicalTrackId",
		       ct.representative_track_id as "trackId",
		       ct.title,
		       ct.duration_ms             as "durationMs",
		       ct.max_popularity          as popularity,
		       ct.explicit,
		       lc.liked,
		       ${iso('lc.first_added_at')} as "firstAddedAt",
		       al.id                      as "albumId",
		       al.name                    as "albumName",
		       ${thumb('album_images', 'album_id', 'al.id')} as cover,
		       coalesce((
		         select jsonb_agg(jsonb_build_object('id', ar.id, 'name', ar.name)
		                          order by cta.position)
		           from canonical_track_artists cta
		           join artists ar on ar.id = cta.artist_id
		          where cta.canonical_track_id = ct.id and cta.on_representative
		       ), '[]'::jsonb)            as artists,
		       -- Why this track is here, in the order that answers it: the genres
		       -- you picked first, then whatever else it carries, best-voted first.
		       coalesce((
		         select array_agg(g.genre) from (
		           select tg.genre
		             from spotidata.track_genres tg
		            where tg.canonical_track_id = ct.id
		            group by tg.genre
		            order by (tg.genre = ${anyOf(spec.genres)}) desc, max(tg.votes) desc, tg.genre
		            limit 8
		         ) g
		       ), '{}'::text[])           as genres,
		       coalesce(cps.plays, 0)     as plays,
		       coalesce(cps.ms_played, 0)::bigint as "msPlayed"
		       ${TRACKS_FROM}
		 where ${matches(spec.genres, spec.match)}${search}
		 order by ${order}
		 limit ${opts.limit} offset ${opts.offset}
	`);
}

/**
 * The same set as bare Spotify track ids, in the same order — this is what
 * gets written to the playlist, so the reading order has to be the paste
 * order.
 */
export async function resolveTrackIds(
	spec: { genres: string[]; match: 'any' | 'all'; sort: CollectionSort },
	limit: number
): Promise<string[]> {
	if (spec.genres.length === 0) return [];
	const rows = await query<{ trackId: string }>(sql`
		select ct.representative_track_id as "trackId"
		       ${TRACKS_FROM}
		 where ${matches(spec.genres, spec.match)}
		 order by ${sql.raw(`${COLLECTION_SORTS[spec.sort]}, ct.id`)}
		 limit ${Math.min(limit, MAX_TRACKS)}
	`);
	return rows.map((r) => r.trackId);
}
