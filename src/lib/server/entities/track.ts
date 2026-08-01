import { sql } from 'drizzle-orm';
import { query } from '../db/index.ts';
import { cover, iso, trackArtistsJson, type ArtistRef } from './shared.ts';

export interface CanonicalTrackView {
	id: string;
	kind: 'isrc' | 'fallback';
	isrc: string | null;
	title: string;
	durationMs: number;
	explicit: boolean;
	representativeTrackId: string;
	maxPopularity: number | null;
	copyCount: number;
	earliestReleaseDate: string | null;
	primaryAlbumId: string | null;
	primaryAlbumName: string | null;
	cover: string | null;
	artists: ArtistRef[];
	/** Present only when the recording is in the library. */
	firstAddedAt: string | null;
	latestAddedAt: string | null;
	liked: boolean;
	likedAt: string | null;
	copyCountInLibrary: number;
	ownedPlaylistCount: number;
}

export async function getCanonicalTrack(id: string): Promise<CanonicalTrackView | null> {
	const rows = await query<CanonicalTrackView>(sql`
		select ct.id,
		       ct.kind,
		       ct.isrc,
		       ct.title,
		       ct.duration_ms                        as "durationMs",
		       ct.explicit,
		       ct.representative_track_id            as "representativeTrackId",
		       ct.max_popularity                     as "maxPopularity",
		       ct.copy_count                         as "copyCount",
		       ct.earliest_release_date::text        as "earliestReleaseDate",
		       ct.primary_album_id                   as "primaryAlbumId",
		       al.name                               as "primaryAlbumName",
		       ${cover('album_images', 'album_id', 'ct.primary_album_id')} as cover,
		       coalesce((
		         select jsonb_agg(jsonb_build_object('id', ar.id, 'name', ar.name)
		                          order by cta.position)
		           from canonical_track_artists cta
		           join artists ar on ar.id = cta.artist_id
		          where cta.canonical_track_id = ct.id
		       ), '[]'::jsonb)                       as artists,
		       ${iso('lc.first_added_at')}           as "firstAddedAt",
		       ${iso('lc.latest_added_at')}          as "latestAddedAt",
		       coalesce(lc.liked, false)             as liked,
		       ${iso(`(select min(s.added_at) from saved_tracks s
		               join spotify_tracks st2 on st2.id = s.track_id
		              where st2.canonical_track_id = ct.id and s.removed_at is null)`)} as "likedAt",
		       coalesce(lc.copy_count_in_library, 0) as "copyCountInLibrary",
		       coalesce(lc.owned_playlist_count, 0)  as "ownedPlaylistCount"
		  from canonical_tracks ct
		  left join albums al on al.id = ct.primary_album_id
		  left join library_canonical lc on lc.canonical_track_id = ct.id
		 where ct.id = ${id}
	`);
	return rows[0] ?? null;
}

export interface TrackCopy {
	id: string;
	name: string;
	durationMs: number;
	popularity: number | null;
	explicit: boolean;
	discNumber: number;
	trackNumber: number;
	isLocal: boolean;
	isrc: string | null;
	linkedFromId: string | null;
	albumId: string | null;
	albumName: string | null;
	albumType: string | null;
	albumReleaseDate: string | null;
	albumCover: string | null;
	artists: ArtistRef[];
	isRepresentative: boolean;
	inLibrary: boolean;
	likedAt: string | null;
	playlistCount: number;
}

/** Every Spotify track row that collapses into this recording. */
export async function getTrackCopies(canonicalId: string): Promise<TrackCopy[]> {
	return query<TrackCopy>(sql`
		select st.id,
		       st.name,
		       st.duration_ms   as "durationMs",
		       st.popularity,
		       st.explicit,
		       st.disc_number   as "discNumber",
		       st.track_number  as "trackNumber",
		       st.is_local      as "isLocal",
		       st.isrc,
		       st.linked_from_id as "linkedFromId",
		       al.id            as "albumId",
		       al.name          as "albumName",
		       al.album_type    as "albumType",
		       al.release_date  as "albumReleaseDate",
		       ${cover('album_images', 'album_id', 'al.id')}     as "albumCover",
		       ${trackArtistsJson('st.id')}                      as artists,
		       (st.id = ct.representative_track_id)              as "isRepresentative",
		       (lt.track_id is not null)                         as "inLibrary",
		       ${iso('sv.added_at')}                             as "likedAt",
		       (select count(*)::int from playlist_tracks pt where pt.track_id = st.id)
		                                                         as "playlistCount"
		  from spotify_tracks st
		  join canonical_tracks ct on ct.id = st.canonical_track_id
		  left join albums al on al.id = st.album_id
		  left join library_tracks lt on lt.track_id = st.id
		  left join saved_tracks sv on sv.track_id = st.id and sv.removed_at is null
		 where st.canonical_track_id = ${canonicalId}
		 order by (st.id = ct.representative_track_id) desc,
		          st.popularity desc nulls last,
		          al.release_date_start asc nulls last,
		          st.id
	`);
}

export interface TrackPlaylistRef {
	id: string;
	name: string;
	isOwned: boolean;
	collaborative: boolean;
	occurrences: number;
	addedAt: string | null;
	addedById: string | null;
	addedByName: string | null;
	positions: number[];
}

export async function getTrackPlaylists(canonicalId: string): Promise<TrackPlaylistRef[]> {
	return query<TrackPlaylistRef>(sql`
		select p.id,
		       p.name,
		       p.is_owned            as "isOwned",
		       p.collaborative,
		       count(*)::int         as occurrences,
		       ${iso('min(pt.added_at)')} as "addedAt",
		       min(pt.added_by_id)   as "addedById",
		       min(u.display_name)   as "addedByName",
		       array_agg(pt.position order by pt.position) as positions
		  from playlist_tracks pt
		  join spotify_tracks st on st.id = pt.track_id
		  join playlists p on p.id = pt.playlist_id
		  left join spotify_users u on u.id = pt.added_by_id
		 where st.canonical_track_id = ${canonicalId} and p.removed_at is null
		 group by p.id, p.name, p.is_owned, p.collaborative
		 order by p.is_owned desc, min(pt.added_at) asc nulls last, p.name
	`);
}

/** Resolves a Spotify track id to the recording it belongs to. */
export async function canonicalIdForSpotifyTrack(id: string): Promise<string | null> {
	const rows = await query<{ canonicalTrackId: string | null }>(sql`
		select canonical_track_id as "canonicalTrackId" from spotify_tracks where id = ${id}
	`);
	return rows[0]?.canonicalTrackId ?? null;
}
