import { sql, type SQL } from 'drizzle-orm';
import type { ActiveFilters } from '../../filters.ts';
import { query } from '../db/index.ts';
import { recordings } from '../engine/recordings.ts';
import { cover, iso, like, thumb, total, trackArtistsJson, type ArtistRef } from './shared.ts';

/**
 * Looks a filter value up in a per-query table of SQL fragments.
 *
 * The value has already been checked against the group's vocabulary by
 * `filterParams`, but this lookup is what actually keeps it out of the SQL:
 * the fragments are literals written here, and an unrecognised value simply
 * finds nothing.
 */
function clauseFor(value: string, table: Record<string, SQL>): SQL | null {
	return (value && table[value]) || null;
}

/** ANDs the active fragments onto a WHERE that already ends in a condition. */
function andAll(parts: (SQL | null)[]): SQL {
	const active = parts.filter((p): p is SQL => p !== null);
	return active.length ? sql` and ${sql.join(active, sql` and `)}` : sql``;
}

/** Same, as a HAVING clause — for predicates over aggregates. */
function havingAll(parts: (SQL | null)[]): SQL {
	const active = parts.filter((p): p is SQL => p !== null);
	return active.length ? sql`having ${sql.join(active, sql` and `)}` : sql``;
}

// ---------------------------------------------------------------- library

/**
 * The library list is one row per recording, liked or in a playlist you own:
 * liked songs are `source=liked`, not a list of their own. Liking the single
 * and the album cut of a song is one recording with two copies, and the
 * copies column says so.
 *
 * Play counts read `canonical_play_stats`, not `plays`. The rollup is the
 * whole reason that table exists: sorting 9k recordings by play count would
 * otherwise group 180k events on every page load, and a list page has no time
 * range to justify it — the range picker lives on the overview. A recording
 * with no plays has no row there, hence the coalesce everywhere.
 */

/** `copies` counts the recording under every Spotify track id it has. */
const COPIES_CLAUSES = (expr: SQL) => ({
	dupes: sql`${expr} > 1`,
	unique: sql`${expr} = 1`
});

const EXPLICIT_CLAUSES = (expr: SQL) => ({
	yes: sql`${expr}`,
	no: sql`not ${expr}`
});

export const LIBRARY_SORTS = {
	added: 'lc.first_added_at',
	name: 'ct.title',
	artist: 'pa.name',
	popularity: 'ct.max_popularity',
	duration: 'ct.duration_ms',
	copies: 'ct.copy_count',
	plays: 'coalesce(cps.plays, 0)',
	listened: 'coalesce(cps.ms_played, 0)',
	lastPlayed: 'cps.last_played_at'
} as const;
export type LibrarySort = keyof typeof LIBRARY_SORTS;

export interface LibraryRow {
	total: number;
	canonicalTrackId: string;
	representativeTrackId: string;
	title: string;
	kind: 'isrc' | 'fallback';
	durationMs: number;
	popularity: number | null;
	explicit: boolean;
	copyCount: number;
	copyCountInLibrary: number;
	liked: boolean;
	firstAddedAt: string;
	ownedPlaylistCount: number;
	albumId: string | null;
	albumName: string | null;
	cover: string | null;
	artists: ArtistRef[];
	plays: number;
	msPlayed: number;
	lastPlayedAt: string | null;
}

const LIBRARY_SOURCE_CLAUSES = {
	liked: sql`lc.liked`,
	playlist: sql`lc.owned_playlist_count > 0`,
	'liked-only': sql`lc.liked and lc.owned_playlist_count = 0`,
	'playlist-only': sql`lc.owned_playlist_count > 0 and not lc.liked`
};

/** Saved and never listened to is a category the library tables cannot express. */
const PLAYED_CLAUSES = {
	played: sql`coalesce(cps.plays, 0) > 0`,
	never: sql`cps.canonical_track_id is null`
};

/** Matched on the ISRC, as everywhere Spotidata reads the music folder. */
const DOWNLOADED_CLAUSES = (rec: SQL) => ({
	yes: sql`exists (select 1 from ${rec} r where r.isrc = upper(ct.isrc))`,
	no: sql`not exists (select 1 from ${rec} r where r.isrc = upper(ct.isrc))`
});

export async function libraryRecordings(opts: {
	order: SQL;
	limit: number;
	offset: number;
	q: string;
	filters: ActiveFilters;
}): Promise<LibraryRow[]> {
	const filter = opts.q
		? sql` and (${like(sql`ct.title`, opts.q)} or ${like(sql`pa.name`, opts.q)} or ${like(sql`al.name`, opts.q)})`
		: sql``;
	const where = andAll([
		clauseFor(opts.filters.source, LIBRARY_SOURCE_CLAUSES),
		clauseFor(opts.filters.copies, COPIES_CLAUSES(sql`ct.copy_count`)),
		clauseFor(opts.filters.explicit, EXPLICIT_CLAUSES(sql`ct.explicit`)),
		clauseFor(opts.filters.played, PLAYED_CLAUSES),
		clauseFor(opts.filters.downloaded, DOWNLOADED_CLAUSES(await recordings()))
	]);
	return query<LibraryRow>(sql`
		select ${total},
		       ct.id                 as "canonicalTrackId",
		       ct.representative_track_id as "representativeTrackId",
		       ct.title,
		       ct.kind,
		       ct.duration_ms        as "durationMs",
		       ct.max_popularity     as popularity,
		       ct.explicit,
		       ct.copy_count         as "copyCount",
		       lc.copy_count_in_library as "copyCountInLibrary",
		       lc.liked,
		       ${iso('lc.first_added_at')} as "firstAddedAt",
		       lc.owned_playlist_count as "ownedPlaylistCount",
		       al.id                 as "albumId",
		       al.name               as "albumName",
		       ${thumb('album_images', 'album_id', 'al.id')} as cover,
		       coalesce((
		         select jsonb_agg(jsonb_build_object('id', ar.id, 'name', ar.name)
		                          order by cta.position)
		           from canonical_track_artists cta
		           join artists ar on ar.id = cta.artist_id
		          where cta.canonical_track_id = ct.id and cta.on_representative
		       ), '[]'::jsonb)       as artists,
		       coalesce(cps.plays, 0) as plays,
		       coalesce(cps.ms_played, 0)::bigint as "msPlayed",
		       ${iso('cps.last_played_at')} as "lastPlayedAt"
		  from library_canonical lc
		  join canonical_tracks ct on ct.id = lc.canonical_track_id
		  left join canonical_play_stats cps on cps.canonical_track_id = lc.canonical_track_id
		  left join albums al on al.id = ct.primary_album_id
		  left join artists pa on pa.id = ct.primary_artist_id
		 where true${filter}${where}
		 order by ${opts.order}, ct.id
		 limit ${opts.limit} offset ${opts.offset}
	`);
}

export interface LibraryComposition {
	recordings: number;
	liked: number;
	/** In a playlist you own and not liked. */
	playlistOnly: number;
	/** Spotify track ids behind the recordings, duplicates included. */
	trackIds: number;
}

/** What the library is made of, for the line above the list. */
export async function libraryComposition(): Promise<LibraryComposition> {
	const rows = await query<LibraryComposition>(sql`
		select count(*)::int                                     as recordings,
		       count(*) filter (where liked)::int                as liked,
		       count(*) filter (where not liked)::int            as "playlistOnly",
		       coalesce(sum(copy_count_in_library), 0)::int      as "trackIds"
		  from library_canonical
	`);
	return rows[0] ?? { recordings: 0, liked: 0, playlistOnly: 0, trackIds: 0 };
}

// ----------------------------------------------------------- index pages

export const ARTIST_SORTS = {
	tracks: 'count(distinct lc.canonical_track_id)',
	name: 'a.name',
	albums: 'count(distinct lc.primary_album_id)',
	duration: 'sum(lc.duration_ms)',
	popularity: 'a.popularity',
	followers: 'a.followers_total',
	// max() over a value that is constant within the group: `artist_plays` has
	// one row per artist, but an aggregate query cannot say so without it.
	plays: 'coalesce(max(ps.plays), 0)',
	listened: 'coalesce(max(ps.ms), 0)'
} as const;
export type ArtistSort = keyof typeof ARTIST_SORTS;

const FOLLOWED_CLAUSES = {
	yes: sql`bool_or(fa.artist_id is not null)`,
	no: sql`not bool_or(fa.artist_id is not null)`
};

export interface ArtistIndexRow {
	total: number;
	id: string;
	name: string;
	popularity: number | null;
	followersTotal: number | null;
	image: string | null;
	tracks: number;
	albums: number;
	durationMs: number;
	genre: string | null;
	followed: boolean;
	plays: number;
	msPlayed: number;
}

export async function artistIndex(opts: {
	order: SQL;
	limit: number;
	offset: number;
	q: string;
	genre: string;
	filters: ActiveFilters;
}): Promise<ArtistIndexRow[]> {
	const filter = opts.q ? sql` and ${like(sql`a.name`, opts.q)}` : sql``;
	// A genre is free text rather than a closed vocabulary, so it is bound as a
	// parameter and matched exactly against the artist's own genre rows.
	const genre = opts.genre
		? sql` and exists (select 1 from artist_genres g
		                    where g.artist_id = a.id and g.genre = ${opts.genre})`
		: sql``;
	const having = havingAll([clauseFor(opts.filters.followed, FOLLOWED_CLAUSES)]);
	return query<ArtistIndexRow>(sql`
		-- Counted over EVERY recording credited to the artist, not just the ones
		-- in the library: half of what you play by an artist you never saved,
		-- and a column that quietly excluded it would contradict the overview.
		-- Summed for every artist in one pass rather than per artist: a lateral
		-- here runs once per credit row the group is built from, ~14k probes of
		-- the credits table, where the one GROUP BY is a pair of hash joins.
		with artist_plays as (
		  select x.artist_id, sum(c.plays) as plays, sum(c.ms_played) as ms
		    from canonical_play_stats c
		    join canonical_track_artists x
		      on x.canonical_track_id = c.canonical_track_id and x.on_representative
		   group by x.artist_id
		)
		select ${total},
		       a.id,
		       a.name,
		       a.popularity,
		       a.followers_total as "followersTotal",
		       ${thumb('artist_images', 'artist_id', 'a.id')} as image,
		       count(distinct lc.canonical_track_id)::int as tracks,
		       count(distinct lc.primary_album_id)::int   as albums,
		       coalesce(sum(lc.duration_ms), 0)::bigint   as "durationMs",
		       (select g.genre from artist_genres g where g.artist_id = a.id order by g.genre limit 1)
		                         as genre,
		       bool_or(fa.artist_id is not null) as followed,
		       coalesce(max(ps.plays), 0)::int as plays,
		       coalesce(max(ps.ms), 0)::bigint as "msPlayed"
		  from artists a
		  join canonical_track_artists cta on cta.artist_id = a.id
		  join library_canonical lc on lc.canonical_track_id = cta.canonical_track_id
		  left join followed_artists fa on fa.artist_id = a.id and fa.removed_at is null
		  left join artist_plays ps on ps.artist_id = a.id
		 where true${filter}${genre}
		 group by a.id, a.name, a.popularity, a.followers_total
		 ${having}
		 order by ${opts.order}, a.name
		 limit ${opts.limit} offset ${opts.offset}
	`);
}

/**
 * Genres that actually occur among the artists in the library, most common
 * first — the vocabulary for the genre filter. Spotify hands out hundreds of
 * these, so the tail is cut off rather than rendered into a select nobody can
 * scan.
 */
export async function libraryGenres(limit = 40): Promise<{ genre: string; artists: number }[]> {
	return query<{ genre: string; artists: number }>(sql`
		select g.genre, count(distinct a.id)::int as artists
		  from artist_genres g
		  join artists a on a.id = g.artist_id
		  join canonical_track_artists cta on cta.artist_id = a.id
		  join library_canonical lc on lc.canonical_track_id = cta.canonical_track_id
		 group by g.genre
		 order by artists desc, g.genre
		 limit ${limit}
	`);
}

/** How much of the album is in the library, as a fraction — the "coverage" bar. */
const albumShare = 'count(distinct st.canonical_track_id)::numeric / nullif(al.total_tracks, 0)';

/**
 * An album's listening, over every recording it carries, whether or not the
 * copy you played was the one on this edition: the same "do I play this
 * record?" reading the coverage column uses.
 *
 * A subquery in the select list rather than a lateral join, so that Postgres
 * evaluates it after the sort and limit: for the 50 rows on the page, unless
 * the page is sorted by it. As a lateral it ran for every library track of
 * every album, ~11k times, before the first row could be returned.
 */
const albumListening = (column: 'plays' | 'ms_played') => `(
	select coalesce(sum(c.${column}), 0)
	  from canonical_play_stats c
	 where c.canonical_track_id in (
	   select t.canonical_track_id from spotify_tracks t
	    where t.album_id = al.id and t.canonical_track_id is not null
	 ))`;

export const ALBUM_SORTS = {
	tracks: 'count(distinct st.canonical_track_id)',
	coverage: albumShare,
	name: 'al.name',
	artist: 'max(pa.name)',
	released: 'al.release_date_start',
	total: 'al.total_tracks',
	popularity: 'al.popularity',
	plays: albumListening('plays'),
	listened: albumListening('ms_played')
} as const;
export type AlbumSort = keyof typeof ALBUM_SORTS;

const ALBUM_TYPE_CLAUSES = {
	album: sql`al.album_type = 'album'`,
	single: sql`al.album_type = 'single'`,
	compilation: sql`al.album_type = 'compilation'`
};

const ALBUM_SAVED_CLAUSES = {
	yes: sql`bool_or(sa.album_id is not null)`,
	no: sql`not bool_or(sa.album_id is not null)`
};

/** Albums with an unknown track count match neither side; there is nothing to compare against. */
const ALBUM_COVERAGE_CLAUSES = {
	full: sql`count(distinct st.canonical_track_id) >= al.total_tracks`,
	partial: sql`count(distinct st.canonical_track_id) < al.total_tracks`
};

export interface AlbumIndexRow {
	total: number;
	id: string;
	name: string;
	albumType: string | null;
	releaseDate: string | null;
	totalTracks: number | null;
	popularity: number | null;
	cover: string | null;
	tracks: number;
	saved: boolean;
	artist: string | null;
	artistId: string | null;
	plays: number;
	msPlayed: number;
}

export async function albumIndex(opts: {
	order: SQL;
	limit: number;
	offset: number;
	q: string;
	filters: ActiveFilters;
}): Promise<AlbumIndexRow[]> {
	const filter = opts.q ? sql` and (${like(sql`al.name`, opts.q)} or ${like(sql`pa.name`, opts.q)})` : sql``;
	const where = andAll([clauseFor(opts.filters.type, ALBUM_TYPE_CLAUSES)]);
	const having = havingAll([
		clauseFor(opts.filters.saved, ALBUM_SAVED_CLAUSES),
		clauseFor(opts.filters.coverage, ALBUM_COVERAGE_CLAUSES)
	]);
	return query<AlbumIndexRow>(sql`
		select ${total},
		       al.id,
		       al.name,
		       al.album_type   as "albumType",
		       al.release_date as "releaseDate",
		       al.total_tracks as "totalTracks",
		       al.popularity,
		       ${thumb('album_images', 'album_id', 'al.id')} as cover,
		       count(distinct st.canonical_track_id)::int as tracks,
		       bool_or(sa.album_id is not null) as saved,
		       max(pa.name) as artist,
		       max(pa.id)   as "artistId",
		       ${sql.raw(ALBUM_SORTS.plays)} as plays,
		       ${sql.raw(ALBUM_SORTS.listened)} as "msPlayed"
		  from albums al
		  join spotify_tracks st on st.album_id = al.id
		  join library_tracks lt on lt.track_id = st.id
		  left join saved_albums sa on sa.album_id = al.id and sa.removed_at is null
		  left join lateral (
		    select ar.id, ar.name from album_artists aa join artists ar on ar.id = aa.artist_id
		     where aa.album_id = al.id order by aa.position limit 1
		  ) pa on true
		 where true${filter}${where}
		 group by al.id, al.name, al.album_type, al.release_date, al.release_date_start,
		          al.total_tracks, al.popularity
		 ${having}
		 order by ${opts.order}, al.name
		 limit ${opts.limit} offset ${opts.offset}
	`);
}

/**
 * A playlist's listening, summed over its DISTINCT recordings rather than
 * over its item rows: a playlist that lists the same song twice would
 * otherwise double its own plays, and a playlist is a set of songs for this
 * purpose. In the select list, like `albumListening`, so that it runs for the
 * rows on the page only.
 */
const playlistListening = (column: 'plays' | 'ms_played') => `(
	select coalesce(sum(c.${column}), 0)
	  from canonical_play_stats c
	 where c.canonical_track_id in (
	   select st2.canonical_track_id
	     from playlist_tracks pt2
	     join spotify_tracks st2 on st2.id = pt2.track_id
	    where pt2.playlist_id = p.id and st2.canonical_track_id is not null
	 ))`;

export const PLAYLIST_SORTS = {
	tracks: 's.stored',
	name: 'p.name',
	library: 's.in_library',
	duration: 's.duration_ms',
	added: 's.last_added',
	owner: 'coalesce(u.display_name, p.owner_id)',
	plays: playlistListening('plays'),
	listened: playlistListening('ms_played')
} as const;
export type PlaylistSort = keyof typeof PLAYLIST_SORTS;

const PLAYLIST_OWNER_CLAUSES = {
	mine: sql`p.is_owned`,
	others: sql`not p.is_owned`
};

const PLAYLIST_ACCESS_CLAUSES = {
	collab: sql`p.collaborative`,
	public: sql`p.public`,
	private: sql`p.public is false`
};

export interface PlaylistIndexRow {
	total: number;
	id: string;
	name: string;
	description: string | null;
	ownerId: string | null;
	ownerName: string | null;
	isOwned: boolean;
	collaborative: boolean;
	public: boolean | null;
	cover: string | null;
	tracks: number;
	libraryTracks: number;
	durationMs: number;
	lastAddedAt: string | null;
	plays: number;
	msPlayed: number;
}

export async function playlistIndex(opts: {
	order: SQL;
	limit: number;
	offset: number;
	q: string;
	filters: ActiveFilters;
}): Promise<PlaylistIndexRow[]> {
	const filter = opts.q
		? sql` and (${like(sql`p.name`, opts.q)} or ${like(sql`coalesce(p.description, '')`, opts.q)})`
		: sql``;
	const where = andAll([
		clauseFor(opts.filters.owner, PLAYLIST_OWNER_CLAUSES),
		clauseFor(opts.filters.access, PLAYLIST_ACCESS_CLAUSES)
	]);
	return query<PlaylistIndexRow>(sql`
		select ${total},
		       p.id,
		       p.name,
		       p.description,
		       p.owner_id      as "ownerId",
		       u.display_name  as "ownerName",
		       p.is_owned      as "isOwned",
		       p.collaborative,
		       p.public,
		       ${cover('playlist_images', 'playlist_id', 'p.id')} as cover,
		       s.stored        as tracks,
		       s.in_library    as "libraryTracks",
		       s.duration_ms   as "durationMs",
		       ${iso('s.last_added')} as "lastAddedAt",
		       ${sql.raw(PLAYLIST_SORTS.plays)} as plays,
		       ${sql.raw(PLAYLIST_SORTS.listened)} as "msPlayed"
		  from playlists p
		  left join spotify_users u on u.id = p.owner_id
		  left join lateral (
		    select count(*)::int                      as stored,
		           count(distinct lt.track_id)::int   as in_library,
		           coalesce(sum(st.duration_ms), 0)::bigint as duration_ms,
		           max(pt.added_at)                   as last_added
		      from playlist_tracks pt
		      left join spotify_tracks st on st.id = pt.track_id
		      left join library_tracks lt on lt.track_id = pt.track_id
		     where pt.playlist_id = p.id
		  ) s on true
		 where p.removed_at is null${filter}${where}
		 order by ${opts.order}, p.name
		 limit ${opts.limit} offset ${opts.offset}
	`);
}
