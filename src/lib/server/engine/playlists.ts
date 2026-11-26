import { sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { notIn } from '../db/arrays.ts';
import { ensureEntity } from '../ingest/ensure.ts';
import { ingestPlaylist } from '../ingest/playlist-fetch.ts';
import { storeRaw } from '../ingest/raw.ts';
import { upsertPlaylists } from '../ingest/upsert-playlists.ts';
import { getMe } from '../ingest/upsert-users.ts';
import { getMyPlaylists, getPlaylist, PAGE } from '../spotify/endpoints.ts';
import { SpotifyForbidden, SpotifyNotFound } from '../spotify/errors.ts';
import type { SimplifiedPlaylist } from '../spotify/types.ts';

/**
 * The playlists Deckhand keeps on the DJ stick, kept fresh.
 *
 * The engine (engine/) reads every playlist straight from these tables, through
 * `spotidata.engine_playlists` and `spotidata.engine_playlist_tracks`
 * (db/sql/post/110_engine.sql). The sync reads them twice a day; a track added
 * to a kept playlist in the afternoon should be on the stick that evening, so
 * the engine has the kept ones checked every ten minutes, and when the app asks.
 * Which playlists are kept is the engine's to know (`deckhand.spotify_playlists`),
 * so it names them.
 *
 * A check is the sync's own snapshot gate, for those playlists only: the
 * account's listing (one request per 50 playlists, which also refreshes every
 * playlist's snapshot), one request for each kept playlist the account does not
 * list (one kept by its link), and the item pages only of the kept ones whose
 * snapshot moved. A quiet check is a handful of requests.
 */

export type Checked = 'unchanged' | 'read' | 'gone';

export interface CheckedPlaylist {
	id: string;
	state: Checked;
}

export async function checkPlaylists(ids: string[], force: string[] = []): Promise<CheckedPlaylist[]> {
	const me = await getMe();
	if (!me) throw new Error('Spotidata has not read the account yet: sign in and run a sync first.');

	const listed = new Map<string, SimplifiedPlaylist>();
	for (let offset = 0; ; offset += PAGE.playlists) {
		const page = await getMyPlaylists(offset);
		const items = page.items.filter((p): p is SimplifiedPlaylist => p !== null);
		if (items.length > 0) {
			await upsertPlaylists(items, me.id);
			await storeRaw('playlist', items.map((p) => ({ id: p.id, payload: p })));
			for (const p of items) listed.set(p.id, p);
		}
		if (!page.next || page.items.length === 0) break;
	}
	// The listing is whole, so what it lacks left the library, as the sync records it.
	if (listed.size > 0) {
		await db.execute(sql`
			update playlists set removed_at = now()
			 where removed_at is null and id ${notIn([...listed.keys()])}
		`);
	}

	const forced = new Set(force);
	const out: CheckedPlaylist[] = [];
	for (const id of new Set(ids)) {
		let live = listed.get(id) ?? null;
		if (!live) {
			try {
				live = await getPlaylist(id);
			} catch (err) {
				if (!(err instanceof SpotifyForbidden || err instanceof SpotifyNotFound)) throw err;
			}
			if (!live) {
				out.push({ id, state: 'gone' });
				continue;
			}
			await upsertPlaylists([live], me.id, undefined, { listed: false });
		}
		if ((await storedSnapshot(id)) === live.snapshot_id && !forced.has(id)) {
			out.push({ id, state: 'unchanged' });
			continue;
		}
		await ingestPlaylist(live);
		out.push({ id, state: 'read' });
	}

	// New tracks need their recording, as a page's fetch does; only when
	// something was read, since it costs a few seconds over the whole catalog.
	if (out.some((p) => p.state === 'read')) await refreshAfterIngest();
	return out;
}

/** The snapshot whose items are stored, or null for a playlist never read. */
async function storedSnapshot(id: string): Promise<string | null> {
	const { rows } = await db.execute<{ snapshot: string | null }>(sql`
		select items_synced_snapshot_id as snapshot from playlists where id = ${id}
	`);
	return rows[0]?.snapshot ?? null;
}

async function refreshAfterIngest(): Promise<void> {
	await db.execute(sql`select spotidata.refresh_canonical_tracks()`);
	await db.execute(sql`select spotidata.refresh_album_completeness()`);
	await db.execute(sql`select spotidata.refresh_album_groups()`);
}

export type Fetched = 'ready' | 'pending' | 'missing';

/**
 * A playlist, any one Spotify shows this app, into the tables: the way a page
 * fetches an entity it is asked to show (`ensureEntity`), through the queue, so
 * Deckhand can keep a playlist by its link. Waits long enough for most
 * playlists to be read; a longer one is `pending` and lands shortly after.
 */
export async function fetchPlaylist(id: string): Promise<Fetched> {
	const result = await ensureEntity('playlist', id, 60_000);
	if (result.missing) return 'missing';
	return result.ready ? 'ready' : 'pending';
}
