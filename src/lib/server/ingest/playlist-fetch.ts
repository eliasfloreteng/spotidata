import { sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { getPlaylist, getPlaylistItems, PAGE } from '../spotify/endpoints.ts';
import { SpotifyNotFound } from '../spotify/errors.ts';
import type { PlaylistTrackItem, SimplifiedPlaylist } from '../spotify/types.ts';
import { storeRaw } from './raw.ts';
import { getMe } from './upsert-users.ts';
import { clearPlaylistItems, replacePlaylistItems, upsertPlaylists } from './upsert-playlists.ts';

/**
 * One playlist and every item in it, stored.
 *
 * Extracted from the on-demand task because two other callers want exactly this
 * and neither is a page fetch: an automation refreshes a source playlist whose
 * snapshot moved, and the queue does the same in the background. The sync
 * pipeline keeps its own copy of the logic — it has a phase counter, a run id
 * and a retry contract to honour — but everything else routes through here.
 *
 * Items are stored as a REPLACE of the whole playlist, never a diff: the
 * primary key is (playlist_id, position), so a partial update leaves phantom
 * rows behind wherever the playlist got shorter.
 */
export async function ingestPlaylist(playlist: SimplifiedPlaylist): Promise<number> {
	const me = await getMe();
	await upsertPlaylists([playlist], me?.id ?? '');
	await storeRaw('playlist', [{ id: playlist.id, payload: playlist }]);

	// Every page is fetched BEFORE the transaction opens. Holding one open
	// across dozens of throttled round-trips pins a connection and blocks
	// VACUUM for as long as the playlist is long.
	const items: PlaylistTrackItem[] = [];
	for (let offset = 0; ; offset += PAGE.playlistItems) {
		const page = await getPlaylistItems(playlist.id, offset);
		items.push(...page.items);
		if (!page.next) break;
	}

	await db.transaction(async (tx) => {
		await clearPlaylistItems(playlist.id, tx);
		if (items.length > 0) await replacePlaylistItems(playlist.id, items, 0, tx);
		// The snapshot claim is made against the row we just wrote, not against
		// the payload we started from: a playlist edited mid-fetch then stays
		// marked stale and is picked up again rather than being called clean.
		await tx.execute(sql`
			update playlists
			   set items_synced_snapshot_id = snapshot_id, items_synced_at = now()
			 where id = ${playlist.id}
		`);
	});

	return items.length;
}

/** The same, for a caller holding only an id. Throws `SpotifyNotFound` for a playlist Spotify will not serve. */
export async function ingestPlaylistById(id: string): Promise<number> {
	const playlist = await getPlaylist(id);
	if (!playlist) throw new SpotifyNotFound(`/playlists/${id}`);
	return ingestPlaylist(playlist);
}
