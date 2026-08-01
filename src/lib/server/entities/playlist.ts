import { sql } from 'drizzle-orm';
import { query } from '../db/index.ts';
import { cover, iso, trackArtistsJson, type ArtistRef } from './shared.ts';

export interface PlaylistView {
	id: string;
	name: string;
	description: string | null;
	ownerId: string | null;
	ownerName: string | null;
	isOwned: boolean;
	collaborative: boolean;
	public: boolean | null;
	snapshotId: string;
	totalTracks: number | null;
	cover: string | null;
	itemsSyncedAt: string | null;
	itemsSyncedSnapshotId: string | null;
	storedTracks: number;
	resolvedTracks: number;
	localTracks: number;
	durationMs: number;
	distinctRecordings: number;
	inLibrary: number;
	firstAddedAt: string | null;
	lastAddedAt: string | null;
	contributorCount: number;
}

export async function getPlaylist(id: string): Promise<PlaylistView | null> {
	const rows = await query<PlaylistView>(sql`
		select p.id,
		       p.name,
		       p.description,
		       p.owner_id                      as "ownerId",
		       u.display_name                  as "ownerName",
		       p.is_owned                      as "isOwned",
		       p.collaborative,
		       p.public,
		       p.snapshot_id                   as "snapshotId",
		       p.total_tracks                  as "totalTracks",
		       ${cover('playlist_images', 'playlist_id', 'p.id')} as cover,
		       ${iso('p.items_synced_at')}      as "itemsSyncedAt",
		       p.items_synced_snapshot_id      as "itemsSyncedSnapshotId",
		       s.stored                        as "storedTracks",
		       s.resolved                      as "resolvedTracks",
		       s.locals                        as "localTracks",
		       s.duration_ms                   as "durationMs",
		       s.recordings                    as "distinctRecordings",
		       s.in_library                    as "inLibrary",
		       ${iso('s.first_added')}         as "firstAddedAt",
		       ${iso('s.last_added')}          as "lastAddedAt",
		       s.contributors                  as "contributorCount"
		  from playlists p
		  left join spotify_users u on u.id = p.owner_id
		  left join lateral (
		    select count(*)::int                                        as stored,
		           (count(*) filter (where pt.track_id is not null))::int as resolved,
		           (count(*) filter (where pt.is_local))::int           as locals,
		           coalesce(sum(st.duration_ms), 0)::bigint             as duration_ms,
		           count(distinct st.canonical_track_id)::int           as recordings,
		           count(distinct lt.track_id)::int                     as in_library,
		           min(pt.added_at)                                     as first_added,
		           max(pt.added_at)                                     as last_added,
		           count(distinct pt.added_by_id)::int                  as contributors
		      from playlist_tracks pt
		      left join spotify_tracks st on st.id = pt.track_id
		      left join library_tracks lt on lt.track_id = pt.track_id
		     where pt.playlist_id = p.id
		  ) s on true
		 where p.id = ${id}
	`);
	return rows[0] ?? null;
}

export interface PlaylistItem {
	position: number;
	trackId: string | null;
	name: string;
	durationMs: number | null;
	explicit: boolean;
	popularity: number | null;
	canonicalTrackId: string | null;
	copyCount: number | null;
	albumId: string | null;
	albumName: string | null;
	cover: string | null;
	artists: ArtistRef[];
	localArtist: string | null;
	isLocal: boolean;
	addedAt: string | null;
	addedById: string | null;
	addedByName: string | null;
	inLibrary: boolean;
	liked: boolean;
}

/**
 * `track_id` is nullable — local files, episodes and items Spotify has since
 * withdrawn keep only `local_name`/`local_artist`, so the row still renders.
 */
export async function getPlaylistItems(id: string): Promise<PlaylistItem[]> {
	return query<PlaylistItem>(sql`
		select pt.position,
		       pt.track_id                     as "trackId",
		       coalesce(st.name, pt.local_name, '(unavailable)') as name,
		       st.duration_ms                  as "durationMs",
		       coalesce(st.explicit, false)    as explicit,
		       st.popularity,
		       st.canonical_track_id           as "canonicalTrackId",
		       ct.copy_count                   as "copyCount",
		       al.id                           as "albumId",
		       al.name                         as "albumName",
		       ${cover('album_images', 'album_id', 'al.id')} as cover,
		       ${trackArtistsJson('pt.track_id')} as artists,
		       pt.local_artist                 as "localArtist",
		       pt.is_local                     as "isLocal",
		       ${iso('pt.added_at')}           as "addedAt",
		       pt.added_by_id                  as "addedById",
		       u.display_name                  as "addedByName",
		       (lt.track_id is not null)       as "inLibrary",
		       (sv.track_id is not null)       as liked
		  from playlist_tracks pt
		  left join spotify_tracks st on st.id = pt.track_id
		  left join canonical_tracks ct on ct.id = st.canonical_track_id
		  left join albums al on al.id = st.album_id
		  left join spotify_users u on u.id = pt.added_by_id
		  left join library_tracks lt on lt.track_id = pt.track_id
		  left join saved_tracks sv on sv.track_id = pt.track_id and sv.removed_at is null
		 where pt.playlist_id = ${id}
		 order by pt.position
	`);
}
