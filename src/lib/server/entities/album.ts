import { sql } from 'drizzle-orm';
import { query } from '../db/index.ts';
import { cover, iso, thumb, trackArtistsJson, type ArtistRef } from './shared.ts';

export interface Copyright {
	text: string;
	type: string;
}

export interface AlbumView {
	id: string;
	name: string;
	albumType: string | null;
	releaseDate: string | null;
	releaseDatePrecision: string | null;
	totalTracks: number | null;
	label: string | null;
	popularity: number | null;
	upc: string | null;
	copyrights: Copyright[] | null;
	detailLevel: 'simplified' | 'full';
	tracksComplete: boolean;
	marketCount: number;
	cover: string | null;
	savedAt: string | null;
	artists: ArtistRef[];
	genres: string[];
}

export async function getAlbum(id: string): Promise<AlbumView | null> {
	const rows = await query<AlbumView>(sql`
		select al.id,
		       al.name,
		       al.album_type              as "albumType",
		       al.release_date            as "releaseDate",
		       al.release_date_precision  as "releaseDatePrecision",
		       al.total_tracks            as "totalTracks",
		       al.label,
		       al.popularity,
		       al.upc,
		       al.copyrights,
		       al.detail_level            as "detailLevel",
		       al.tracks_complete         as "tracksComplete",
		       coalesce(array_length(al.available_markets, 1), 0) as "marketCount",
		       ${cover('album_images', 'album_id', 'al.id')} as cover,
		       ${iso('sa.added_at')}      as "savedAt",
		       coalesce((
		         select jsonb_agg(jsonb_build_object('id', ar.id, 'name', ar.name)
		                          order by aa.position)
		           from album_artists aa join artists ar on ar.id = aa.artist_id
		          where aa.album_id = al.id
		       ), '[]'::jsonb)            as artists,
		       coalesce((
		         select array_agg(ag.genre order by ag.genre)
		           from album_genres ag where ag.album_id = al.id
		       ), '{}')                   as genres
		  from albums al
		  left join saved_albums sa on sa.album_id = al.id and sa.removed_at is null
		 where al.id = ${id}
	`);
	return rows[0] ?? null;
}

export interface AlbumTrack {
	id: string;
	name: string;
	discNumber: number;
	trackNumber: number;
	durationMs: number;
	explicit: boolean;
	popularity: number | null;
	canonicalTrackId: string | null;
	artists: ArtistRef[];
	/** This exact Spotify track is in the library. */
	inLibrary: boolean;
	/** The recording is in the library, but through a copy on another album. */
	viaOtherCopy: boolean;
	liked: boolean;
}

export interface AlbumEdition {
	id: string;
	name: string;
	albumType: string | null;
	releaseDate: string | null;
	cover: string | null;
	saved: boolean;
	/** The edition the group resolves to; the one the rest are duplicates of. */
	representative: boolean;
}

/**
 * The *other* albums carrying exactly this album's canonical tracks — regional
 * re-issues, a re-release under a tidier title, an `album`/`compilation` pair.
 * Empty unless `spotidata.refresh_album_groups()` actually found a duplicate.
 */
export async function getAlbumEditions(albumId: string): Promise<AlbumEdition[]> {
	return query<AlbumEdition>(sql`
		select al.id,
		       al.name,
		       al.album_type   as "albumType",
		       al.release_date as "releaseDate",
		       ${thumb('album_images', 'album_id', 'al.id')} as cover,
		       (sa.album_id is not null)                 as saved,
		       (al.id = g.representative_album_id)       as representative
		  from albums me
		  join album_groups g on g.id = me.album_group_id and g.copy_count > 1
		  join albums al on al.album_group_id = g.id and al.id <> me.id
		  left join saved_albums sa on sa.album_id = al.id and sa.removed_at is null
		 where me.id = ${albumId}
		 order by al.release_date_start nulls last, al.id
	`);
}

export async function getAlbumTracks(albumId: string): Promise<AlbumTrack[]> {
	return query<AlbumTrack>(sql`
		select st.id,
		       st.name,
		       st.disc_number        as "discNumber",
		       st.track_number       as "trackNumber",
		       st.duration_ms        as "durationMs",
		       st.explicit,
		       st.popularity,
		       st.canonical_track_id as "canonicalTrackId",
		       ${trackArtistsJson('st.id')} as artists,
		       (lt.track_id is not null)    as "inLibrary",
		       (lt.track_id is null and lc.canonical_track_id is not null) as "viaOtherCopy",
		       (sv.track_id is not null)    as liked
		  from spotify_tracks st
		  left join library_tracks lt on lt.track_id = st.id
		  left join library_canonical lc on lc.canonical_track_id = st.canonical_track_id
		  left join saved_tracks sv on sv.track_id = st.id and sv.removed_at is null
		 where st.album_id = ${albumId}
		 order by st.disc_number, st.track_number, st.name
	`);
}
