import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { query } from '../db/index.ts';
import {
	getCollection,
	resolveTrackIds,
	type Collection,
	type CollectionSort
} from '../entities/genres.ts';
import { getMe } from '../ingest/upsert-users.ts';
import { canWritePlaylists, readAuthState } from '../spotify/auth.ts';
import {
	addPlaylistItems,
	changePlaylistDetails,
	createPlaylist,
	getPlaylist,
	PLAYLIST_ITEMS_PER_REQUEST,
	replacePlaylistItems
} from '../spotify/endpoints.ts';
import { plainText } from '../../utils/format.ts';
import { spotifyLink } from '../../utils/spotify-uri.ts';

/**
 * Pushing a genre collection into a real Spotify playlist, and keeping it
 * there.
 *
 * One function, two callers: the button on the collection page runs it inline
 * so a failure is visible while you are looking at it, and `playlist:sync` runs
 * it from the queue for every auto-syncing collection. Both must behave
 * identically, which is why neither owns any of the logic.
 *
 * The push is a REWRITE, never a diff. `PUT /playlists/{id}/tracks` replaces
 * the contents with up to 100 uris and `POST` appends the rest, so the
 * playlist ends up as exactly the computed list in exactly the computed
 * order — no reconciliation, no way for a crash halfway to leave duplicates,
 * and removals fall out for free. What it costs is that anything you add to
 * the playlist by hand is gone at the next sync, which is the deal a generated
 * playlist makes; `autoSync` off is how you stop it.
 */

export interface SyncResult {
	status: 'synced' | 'unchanged' | 'empty' | 'skipped';
	playlistId: string | null;
	tracks: number;
	requests: number;
	created: boolean;
	message: string;
}

export class PlaylistScopeError extends Error {
	constructor() {
		super(
			'This Spotify authorization cannot modify playlists. Re-authorize to grant playlist access.'
		);
		this.name = 'PlaylistScopeError';
	}
}

const fingerprint = (ids: string[]) => createHash('md5').update(ids.join(',')).digest('hex');

/** Truncated to Spotify's 300-character ceiling; it rejects anything longer. */
function describe(collection: Collection): string {
	const genres = collection.genres.join(', ');
	const base =
		collection.description?.trim() ||
		`${collection.match === 'all' ? 'Every one of' : 'Any of'}: ${genres}`;
	return `${base} · kept in sync by Spotidata`.slice(0, 300);
}

export async function syncCollection(
	id: string,
	opts: { force?: boolean } = {}
): Promise<SyncResult> {
	const collection = await getCollection(id);
	if (!collection) throw new Error(`No collection ${id}`);

	const auth = await readAuthState();
	if (!auth || auth.needsReauth || !canWritePlaylists(auth.scope)) throw new PlaylistScopeError();

	const ids = await resolveTrackIds(
		{
			genres: collection.genres,
			match: collection.match,
			sort: collection.sort as CollectionSort
		},
		collection.trackLimit
	);

	// An empty push would silently empty the playlist, which is never what an
	// empty collection means — it means "not finished picking yet".
	if (ids.length === 0) {
		await recordChecked(id);
		return {
			status: 'empty',
			playlistId: collection.spotifyPlaylistId,
			tracks: 0,
			requests: 0,
			created: false,
			message: collection.genres.length
				? 'No tracks in your library carry those genres yet.'
				: 'Add a genre first.'
		};
	}

	let requests = 0;
	let created = false;
	let playlistId = collection.spotifyPlaylistId;

	try {
		// --- the playlist itself -------------------------------------------
		//
		// One GET answers both questions: is it still there, and has anyone
		// touched it since we last wrote. A playlist the user deleted in the app
		// is only *unfollowed* and Spotify keeps serving it by id, so the null
		// case is the genuinely gone one — a wiped account, an id from a restored
		// database. The repair for an unfollowed playlist is Settings → Forget.
		let live = playlistId ? await getPlaylist(playlistId) : null;
		if (playlistId) requests++;

		if (playlistId && !live) {
			playlistId = null;
			await query(sql`
				update genre_collections set spotify_playlist_id = null where id = ${id}
			`);
		}

		if (!playlistId) {
			const me = await getMe();
			if (!me) throw new Error('No Spotify profile stored yet — run a sync first.');
			const playlist = await createPlaylist(me.id, {
				name: collection.name,
				description: describe(collection),
				public: collection.playlistPublic
			});
			requests++;
			created = true;
			playlistId = playlist.id;
			await query(sql`
				update genre_collections
				   set spotify_playlist_id = ${playlistId},
				       synced_fingerprint = null,
				       synced_snapshot_id = null,
				       updated_at = now()
				 where id = ${id}
			`);
		}

		// --- is there anything to do? ---------------------------------------
		const stamp = fingerprint(ids);
		const drifted = live ? live.snapshot_id !== collection.syncedSnapshotId : true;

		if (!opts.force && !created && stamp === collection.syncedFingerprint && !drifted) {
			await recordChecked(id);
			return {
				status: 'unchanged',
				playlistId,
				tracks: ids.length,
				requests,
				created,
				message: `Already up to date — ${ids.length} tracks.`
			};
		}

		// --- rewrite ---------------------------------------------------------
		//
		// Description first, and only when it differs — Spotify entity-escapes
		// what it gives back, hence comparing through `plainText`.
		const wanted = describe(collection);
		if (!created && live && plainText(live.description) !== plainText(wanted)) {
			await changePlaylistDetails(playlistId, { description: wanted });
			requests++;
		}

		const chunks: string[][] = [];
		for (let i = 0; i < ids.length; i += PLAYLIST_ITEMS_PER_REQUEST) {
			chunks.push(ids.slice(i, i + PLAYLIST_ITEMS_PER_REQUEST));
		}

		for (const [i, chunk] of chunks.entries()) {
			const uris = chunk.map((trackId) => spotifyLink('track', trackId, 'uri'));
			if (i === 0) await replacePlaylistItems(playlistId, uris);
			else await addPlaylistItems(playlistId, uris);
			requests++;
		}

		// The snapshot a write RETURNS is not the snapshot a read reports: the
		// response can sit a version ahead of the head `GET /playlists/{id}`
		// serves, so storing it means comparing two different clocks and finding
		// drift on every subsequent run — 46 tracks rewritten forever to arrive
		// at the same 46 tracks. Re-reading the head costs one request, and only
		// on runs that actually wrote.
		const head = await getPlaylist(playlistId);
		requests++;
		const snapshot = head?.snapshot_id ?? '';

		await query(sql`
			update genre_collections
			   set synced_fingerprint = ${stamp},
			       synced_snapshot_id = ${snapshot || null},
			       synced_track_count = ${ids.length},
			       last_synced_at = now(),
			       last_sync_error = null
			 where id = ${id}
		`);

		return {
			status: 'synced',
			playlistId,
			tracks: ids.length,
			requests,
			created,
			message: created
				? `Playlist created with ${ids.length} tracks.`
				: `Playlist rewritten — ${ids.length} tracks.`
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await recordError(id, message.slice(0, 500));
		throw err;
	}
}

/**
 * A run that reached Spotify and found nothing to do still counts as synced —
 * "checked, and it is correct" is what the page means by it.
 */
const recordChecked = (id: string) =>
	query(sql`
		update genre_collections
		   set last_sync_error = null, last_synced_at = now()
		 where id = ${id}
	`);

/** A failure leaves `last_synced_at` alone: nothing was synced. */
const recordError = (id: string, error: string) =>
	query(sql`update genre_collections set last_sync_error = ${error} where id = ${id}`);

/** Every collection the background job is allowed to rewrite. */
export async function autoSyncCollectionIds(): Promise<string[]> {
	const rows = await query<{ id: string }>(sql`
		select c.id
		  from genre_collections c
		 where c.auto_sync
		   and exists (select 1 from genre_collection_genres g where g.collection_id = c.id)
		 order by c.updated_at
	`);
	return rows.map((r) => r.id);
}
