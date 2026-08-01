import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { playlistImages, playlistTracks, playlists } from '../db/schema/index.ts';
import { isFullTrack, type PlaylistTrackItem, type SimplifiedPlaylist } from '../spotify/types.ts';
import { chunkIds, chunkRows, dedupeBy, withTx, type Executor } from './_bulk.ts';
import { isCatalogTrack, upsertFullTracks } from './upsert-tracks.ts';
import { upsertPublicUser } from './upsert-users.ts';

/**
 * Playlist metadata only. `itemsSyncedSnapshotId` / `itemsSyncedAt` are
 * deliberately untouched: they claim the stored items match a snapshot, which
 * is a promise only the item sync is in a position to make.
 */
export async function upsertPlaylists(
	input: SimplifiedPlaylist[],
	meId: string,
	on?: Executor
): Promise<void> {
	const list = dedupeBy(input, (p) => p.id);
	if (list.length === 0) return;

	// Owners are the FK target and number in the dozens even for hundreds of
	// playlists, so the per-row path in upsert-users is fine here.
	for (const owner of dedupeBy(
		list.map((p) => p.owner).filter((o) => o?.id != null),
		(o) => o.id
	)) {
		await upsertPublicUser(owner);
	}

	const rows = list.map((p) => ({
		id: p.id,
		name: p.name,
		description: p.description ?? null,
		ownerId: p.owner?.id ?? null,
		isOwned: p.owner?.id === meId,
		collaborative: p.collaborative ?? false,
		public: p.public ?? null,
		snapshotId: p.snapshot_id,
		totalTracks: p.tracks?.total ?? null,
		href: p.href ?? null,
		uri: p.uri,
		externalUrls: p.external_urls ?? {}
	}));

	await withTx(on, async (tx) => {
		for (const part of chunkRows(rows)) {
			await tx
				.insert(playlists)
				.values(part)
				.onConflictDoUpdate({
					target: playlists.id,
					set: {
						name: sql`excluded.name`,
						description: sql`coalesce(excluded.description, ${playlists.description})`,
						ownerId: sql`coalesce(excluded.owner_id, ${playlists.ownerId})`,
						isOwned: sql`excluded.is_owned`,
						collaborative: sql`excluded.collaborative`,
						// null means "not visible to us", not "made private".
						public: sql`coalesce(excluded.public, ${playlists.public})`,
						snapshotId: sql`excluded.snapshot_id`,
						totalTracks: sql`coalesce(excluded.total_tracks, ${playlists.totalTracks})`,
						href: sql`coalesce(excluded.href, ${playlists.href})`,
						uri: sql`coalesce(excluded.uri, ${playlists.uri})`,
						externalUrls: sql`coalesce(nullif(excluded.external_urls, '{}'::jsonb), ${playlists.externalUrls})`,
						// Seeing it in the listing again is proof it came back.
						removedAt: null,
						updatedAt: sql`now()`
					}
				});
		}

		await replacePlaylistImages(tx, list);
	});
}

/**
 * Drops every stored item of a playlist. Separate from the insert so a paged
 * sync can clear once and then append page by page — inside one transaction if
 * the caller passes one — instead of deleting the tail it just wrote.
 */
export async function clearPlaylistItems(playlistId: string, on?: Executor): Promise<void> {
	const exec = on ?? db;
	await exec.delete(playlistTracks).where(eq(playlistTracks.playlistId, playlistId));
}

/**
 * Writes one page of playlist items. The PK is (playlist_id, position), so the
 * caller's page offset is what makes the rows addressable; a track repeated in
 * a playlist must stay repeated.
 */
export async function replacePlaylistItems(
	playlistId: string,
	items: PlaylistTrackItem[],
	startOffset: number,
	on?: Executor
): Promise<void> {
	if (items.length === 0) return;

	await withTx(on, async (tx) => {
		// The catalog row has to exist before playlist_tracks.track_id can point
		// at it. Episodes and local files never get one.
		await upsertFullTracks(
			items.map((i) => i.track).filter(isFullTrack).filter(isCatalogTrack),
			tx
		);

		const rows = items.map((item, index) => {
			const track = item.track;
			const catalog = isFullTrack(track) && isCatalogTrack(track) ? track : null;
			// Local files and episodes have no catalog row; keeping their label is
			// the difference between a named entry and a hole in the playlist.
			const unlinked = catalog === null ? track : null;
			return {
				playlistId,
				position: startOffset + index,
				trackId: catalog?.id ?? null,
				addedAt: item.added_at ? new Date(item.added_at) : null,
				addedById: item.added_by?.id ?? null,
				isLocal: item.is_local ?? false,
				localName: unlinked?.name ?? null,
				localArtist: isFullTrack(unlinked) ? (unlinked.artists?.[0]?.name ?? null) : null
			};
		});

		for (const part of chunkRows(rows)) {
			await tx
				.insert(playlistTracks)
				.values(part)
				.onConflictDoUpdate({
					target: [playlistTracks.playlistId, playlistTracks.position],
					set: {
						trackId: sql`excluded.track_id`,
						addedAt: sql`excluded.added_at`,
						addedById: sql`excluded.added_by_id`,
						isLocal: sql`excluded.is_local`,
						localName: sql`excluded.local_name`,
						localArtist: sql`excluded.local_artist`
					}
				});
		}
	});
}

async function replacePlaylistImages(tx: Executor, list: SimplifiedPlaylist[]): Promise<void> {
	// `images` is null for playlists whose cover Spotify has not rendered yet.
	const withImages = list.filter((p) => p.images?.length);
	if (withImages.length === 0) return;

	for (const ids of chunkIds(withImages.map((p) => p.id))) {
		await tx.delete(playlistImages).where(inArray(playlistImages.playlistId, ids));
	}

	const rows = withImages.flatMap((p) =>
		(p.images ?? []).map((img, position) => ({
			playlistId: p.id,
			position,
			url: img.url,
			width: img.width,
			height: img.height
		}))
	);
	for (const part of chunkRows(rows)) {
		await tx
			.insert(playlistImages)
			.values(part)
			.onConflictDoUpdate({
				target: [playlistImages.playlistId, playlistImages.position],
				set: { url: sql`excluded.url`, width: sql`excluded.width`, height: sql`excluded.height` }
			});
	}
}
