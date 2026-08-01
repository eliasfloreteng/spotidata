import { sql } from 'drizzle-orm';
import { query } from '../db/index.ts';
import { cover, iso } from './shared.ts';

export interface ArtistView {
	id: string;
	name: string;
	popularity: number | null;
	followersTotal: number | null;
	detailLevel: 'simplified' | 'full';
	image: string | null;
	genres: string[];
	followedAt: string | null;
}

export async function getArtist(id: string): Promise<ArtistView | null> {
	const rows = await query<ArtistView>(sql`
		select a.id,
		       a.name,
		       a.popularity,
		       a.followers_total as "followersTotal",
		       a.detail_level    as "detailLevel",
		       ${cover('artist_images', 'artist_id', 'a.id')} as image,
		       coalesce((
		         select array_agg(g.genre order by g.genre)
		           from artist_genres g where g.artist_id = a.id
		       ), '{}')          as genres,
		       ${iso('fa.first_seen_at')} as "followedAt"
		  from artists a
		  left join followed_artists fa on fa.artist_id = a.id and fa.removed_at is null
		 where a.id = ${id}
	`);
	return rows[0] ?? null;
}

export interface ArtistStats {
	libraryRecordings: number;
	libraryCopies: number;
	durationMs: number;
	albumsInLibrary: number;
	likedRecordings: number;
	firstAddedAt: string | null;
	latestAddedAt: string | null;
	catalogAlbums: number;
}

export async function getArtistStats(id: string): Promise<ArtistStats> {
	const rows = await query<ArtistStats>(sql`
		with mine as (
		  select lc.*
		    from library_canonical lc
		    join canonical_track_artists cta on cta.canonical_track_id = lc.canonical_track_id
		   where cta.artist_id = ${id}
		)
		select (select count(*)::int from mine)                              as "libraryRecordings",
		       (select coalesce(sum(copy_count_in_library), 0)::int from mine) as "libraryCopies",
		       (select coalesce(sum(duration_ms), 0)::bigint from mine)      as "durationMs",
		       (select count(distinct primary_album_id)::int from mine)      as "albumsInLibrary",
		       (select (count(*) filter (where liked))::int from mine)       as "likedRecordings",
		       ${iso('(select min(first_added_at) from mine)')}              as "firstAddedAt",
		       ${iso('(select max(latest_added_at) from mine)')}             as "latestAddedAt",
		       (select count(*)::int from album_artists aa where aa.artist_id = ${id})
		                                                                     as "catalogAlbums"
	`);
	return (
		rows[0] ?? {
			libraryRecordings: 0,
			libraryCopies: 0,
			durationMs: 0,
			albumsInLibrary: 0,
			likedRecordings: 0,
			firstAddedAt: null,
			latestAddedAt: null,
			catalogAlbums: 0
		}
	);
}

export interface ArtistAlbum {
	id: string;
	name: string;
	albumType: string;
	releaseDate: string | null;
	totalTracks: number | null;
	cover: string | null;
	libraryTracks: number;
	saved: boolean;
}

/** Every album crediting this artist, newest first, with library coverage. */
export async function getArtistAlbums(id: string): Promise<ArtistAlbum[]> {
	return query<ArtistAlbum>(sql`
		select al.id,
		       al.name,
		       coalesce(al.album_type, 'other') as "albumType",
		       al.release_date   as "releaseDate",
		       al.total_tracks   as "totalTracks",
		       ${cover('album_images', 'album_id', 'al.id')} as cover,
		       (select count(distinct st.canonical_track_id)::int
		          from spotify_tracks st
		          join library_tracks lt on lt.track_id = st.id
		         where st.album_id = al.id)     as "libraryTracks",
		       (sa.album_id is not null)        as saved
		  from albums al
		  join album_artists aa on aa.album_id = al.id
		  left join saved_albums sa on sa.album_id = al.id and sa.removed_at is null
		 where aa.artist_id = ${id}
		 order by al.release_date_start desc nulls last, al.name
	`);
}

export interface ArtistTopTrack {
	canonicalTrackId: string;
	title: string;
	durationMs: number;
	popularity: number | null;
	explicit: boolean;
	copyCount: number;
	liked: boolean;
	firstAddedAt: string;
	albumId: string | null;
	albumName: string | null;
	cover: string | null;
}

export async function getArtistTopTracks(id: string, limit = 20): Promise<ArtistTopTrack[]> {
	return query<ArtistTopTrack>(sql`
		select ct.id             as "canonicalTrackId",
		       ct.title,
		       ct.duration_ms    as "durationMs",
		       ct.max_popularity as popularity,
		       ct.explicit,
		       ct.copy_count     as "copyCount",
		       lc.liked,
		       ${iso('lc.first_added_at')} as "firstAddedAt",
		       ct.primary_album_id as "albumId",
		       al.name           as "albumName",
		       ${cover('album_images', 'album_id', 'ct.primary_album_id')} as cover
		  from library_canonical lc
		  join canonical_track_artists cta on cta.canonical_track_id = lc.canonical_track_id
		  join canonical_tracks ct on ct.id = lc.canonical_track_id
		  left join albums al on al.id = ct.primary_album_id
		 where cta.artist_id = ${id}
		 order by ct.max_popularity desc nulls last, ct.title
		 limit ${limit}
	`);
}
