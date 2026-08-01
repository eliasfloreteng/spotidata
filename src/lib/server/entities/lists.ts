import { sql, type SQL } from 'drizzle-orm';
import { query } from '../db/index.ts';
import { cover, iso, thumb, trackArtistsJson, type ArtistRef } from './shared.ts';

/**
 * `count(*) over ()` rides along on the paged query instead of a second
 * COUNT: the window is evaluated before LIMIT, so one round trip yields both
 * the page and the total. Empty pages report zero, which is what the pager
 * should show anyway.
 */
const total = sql`(count(*) over ())::int as total`;

/** Matches a trigram-indexed name; `%` and `_` are escaped so they stay literal. */
function like(expr: SQL, q: string): SQL {
	return sql`${expr} ilike ${'%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'}`;
}

// ------------------------------------------------------------------ liked

export const LIKED_SORTS = {
	added: 'sv.added_at',
	name: 'st.name',
	artist: 'pa.name',
	popularity: 'st.popularity',
	duration: 'st.duration_ms'
} as const;
export type LikedSort = keyof typeof LIKED_SORTS;

export interface LikedRow {
	total: number;
	id: string;
	name: string;
	durationMs: number;
	popularity: number | null;
	explicit: boolean;
	addedAt: string;
	canonicalTrackId: string | null;
	copyCount: number | null;
	albumId: string | null;
	albumName: string | null;
	cover: string | null;
	artists: ArtistRef[];
}

export async function likedTracks(opts: {
	order: SQL;
	limit: number;
	offset: number;
	q: string;
}): Promise<LikedRow[]> {
	const filter = opts.q
		? sql`and (${like(sql`st.name`, opts.q)} or ${like(sql`pa.name`, opts.q)} or ${like(sql`al.name`, opts.q)})`
		: sql``;
	return query<LikedRow>(sql`
		select ${total},
		       st.id,
		       st.name,
		       st.duration_ms        as "durationMs",
		       st.popularity,
		       st.explicit,
		       ${iso('sv.added_at')} as "addedAt",
		       st.canonical_track_id as "canonicalTrackId",
		       ct.copy_count         as "copyCount",
		       al.id                 as "albumId",
		       al.name               as "albumName",
		       ${thumb('album_images', 'album_id', 'al.id')} as cover,
		       ${trackArtistsJson('st.id')} as artists
		  from saved_tracks sv
		  join spotify_tracks st on st.id = sv.track_id
		  left join canonical_tracks ct on ct.id = st.canonical_track_id
		  left join albums al on al.id = st.album_id
		  left join lateral (
		    select ar.name from track_artists ta join artists ar on ar.id = ta.artist_id
		     where ta.track_id = st.id order by ta.position limit 1
		  ) pa on true
		 where sv.removed_at is null ${filter}
		 order by ${opts.order}, st.id
		 limit ${opts.limit} offset ${opts.offset}
	`);
}

// ---------------------------------------------------------------- library

export const LIBRARY_SORTS = {
	added: 'lc.first_added_at',
	name: 'ct.title',
	artist: 'pa.name',
	popularity: 'ct.max_popularity',
	duration: 'ct.duration_ms',
	copies: 'ct.copy_count'
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
}

export async function libraryRecordings(opts: {
	order: SQL;
	limit: number;
	offset: number;
	q: string;
}): Promise<LibraryRow[]> {
	const filter = opts.q
		? sql`where (${like(sql`ct.title`, opts.q)} or ${like(sql`pa.name`, opts.q)} or ${like(sql`al.name`, opts.q)})`
		: sql``;
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
		       ), '[]'::jsonb)       as artists
		  from library_canonical lc
		  join canonical_tracks ct on ct.id = lc.canonical_track_id
		  left join albums al on al.id = ct.primary_album_id
		  left join artists pa on pa.id = ct.primary_artist_id
		  ${filter}
		 order by ${opts.order}, ct.id
		 limit ${opts.limit} offset ${opts.offset}
	`);
}

// ----------------------------------------------------------- index pages

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
}

export async function artistIndex(opts: {
	limit: number;
	offset: number;
	q: string;
}): Promise<ArtistIndexRow[]> {
	const filter = opts.q ? sql`and ${like(sql`a.name`, opts.q)}` : sql``;
	return query<ArtistIndexRow>(sql`
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
		       bool_or(fa.artist_id is not null) as followed
		  from artists a
		  join canonical_track_artists cta on cta.artist_id = a.id
		  join library_canonical lc on lc.canonical_track_id = cta.canonical_track_id
		  left join followed_artists fa on fa.artist_id = a.id and fa.removed_at is null
		 where true ${filter}
		 group by a.id, a.name, a.popularity, a.followers_total
		 order by tracks desc, a.name
		 limit ${opts.limit} offset ${opts.offset}
	`);
}

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
}

export async function albumIndex(opts: {
	limit: number;
	offset: number;
	q: string;
}): Promise<AlbumIndexRow[]> {
	const filter = opts.q ? sql`and (${like(sql`al.name`, opts.q)} or ${like(sql`pa.name`, opts.q)})` : sql``;
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
		       max(pa.id)   as "artistId"
		  from albums al
		  join spotify_tracks st on st.album_id = al.id
		  join library_tracks lt on lt.track_id = st.id
		  left join saved_albums sa on sa.album_id = al.id and sa.removed_at is null
		  left join lateral (
		    select ar.id, ar.name from album_artists aa join artists ar on ar.id = aa.artist_id
		     where aa.album_id = al.id order by aa.position limit 1
		  ) pa on true
		 where true ${filter}
		 group by al.id, al.name, al.album_type, al.release_date, al.total_tracks, al.popularity
		 order by tracks desc, al.release_date_start desc nulls last, al.name
		 limit ${opts.limit} offset ${opts.offset}
	`);
}

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
}

export async function playlistIndex(opts: {
	limit: number;
	offset: number;
	q: string;
}): Promise<PlaylistIndexRow[]> {
	const filter = opts.q
		? sql`and (${like(sql`p.name`, opts.q)} or ${like(sql`coalesce(p.description, '')`, opts.q)})`
		: sql``;
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
		       ${iso('s.last_added')} as "lastAddedAt"
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
		 where p.removed_at is null ${filter}
		 order by s.stored desc nulls last, p.name
		 limit ${opts.limit} offset ${opts.offset}
	`);
}
