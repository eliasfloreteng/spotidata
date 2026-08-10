import { sql } from 'drizzle-orm';
import { anyOf } from '../db/arrays.ts';
import { query } from '../db/index.ts';
import {
	getAutomation,
	MAX_PLAYLIST_ITEMS,
	pendingTrackIds,
	recordLedger,
	type Automation,
	type LedgerEntry
} from '../entities/automations.ts';
import { ingestPlaylist } from '../ingest/playlist-fetch.ts';
import { getMe } from '../ingest/upsert-users.ts';
import { canWritePlaylists, readAuthState } from '../spotify/auth.ts';
import {
	addPlaylistItems,
	createPlaylist,
	getPlaylist,
	getPlaylistItemIds,
	PAGE,
	PLAYLIST_ITEMS_PER_REQUEST
} from '../spotify/endpoints.ts';
import { spotifyLink } from '../../utils/spotify-uri.ts';
import { PlaylistScopeError } from './sync.ts';

/**
 * Running an automation: collect what the sources have gained, append it to the
 * destination, write down what was appended.
 *
 * This is the append-only counterpart to `syncCollection`, and the contrast is
 * the whole point. A genre collection OWNS its playlist and rewrites it with
 * `PUT`, so anything added by hand is gone at the next sync. An automation only
 * ever calls `POST /playlists/{id}/tracks`. It issues no PUT and no DELETE, so:
 *
 *   - nothing it did not add can ever be removed;
 *   - the destination stays a perfectly ordinary playlist — add to it in
 *     Spotify, reorder it, rename it, and the automation carries on around you;
 *   - a track you delete from the destination stays deleted, because the run
 *     asks the ledger "have I added this before", not the playlist "is this
 *     still there".
 *
 * The description is written once, at creation, and never touched again — the
 * playlist belongs to the user from that moment on.
 */

export interface AutomationRunResult {
	status: 'added' | 'unchanged' | 'idle';
	playlistId: string | null;
	/** Tracks appended by this run. */
	added: number;
	/** Tracks the sources offered — `added` plus whatever was already in the playlist. */
	candidates: number;
	requests: number;
	created: boolean;
	/** Source playlists whose contents were re-read from Spotify. */
	refreshed: number;
	/** True when Spotify's 10,000-item ceiling cut the run short. */
	truncated: boolean;
	message: string;
}

/** Only used for a playlist this app creates; the user owns the text afterwards. */
function describe(automation: Automation, sources: number): string {
	const base =
		automation.description?.trim() ||
		`Tracks collected from ${sources} playlist${sources === 1 ? '' : 's'}`;
	return `${base} · filled by Spotidata`.slice(0, 300);
}

export async function runAutomation(id: string): Promise<AutomationRunResult> {
	const automation = await getAutomation(id);
	if (!automation) throw new Error(`No automation ${id}`);

	const auth = await readAuthState();
	if (!auth || auth.needsReauth || !canWritePlaylists(auth.scope)) throw new PlaylistScopeError();

	if (automation.sources.length === 0) {
		await recordChecked(id);
		return {
			status: 'idle',
			playlistId: automation.spotifyPlaylistId,
			added: 0,
			candidates: 0,
			requests: 0,
			created: false,
			refreshed: 0,
			truncated: false,
			message: 'No source playlists yet — add one and this has something to collect.'
		};
	}

	let requests = 0;
	let refreshed = 0;
	let created = false;
	let playlistId = automation.spotifyPlaylistId;

	try {
		// --- what the sources hold now ---------------------------------------
		//
		// The mirror is only as fresh as the last sync, and a run an hour after
		// somebody dropped a song into a folder should carry that song. One GET
		// per source answers whether anything moved; the item pages are only
		// fetched for the sources whose snapshot actually changed, which on a
		// quiet hour is none of them.
		for (const sourceId of automation.sources) {
			const live = await getPlaylist(sourceId);
			requests++;
			// A source Spotify will not serve (deleted, unfollowed, made private)
			// is not an error: what was ingested from it stays usable, and the
			// automation simply stops learning anything new from it.
			if (!live) continue;

			const stored = await storedSnapshot(sourceId);
			if (stored === live.snapshot_id) continue;

			const items = await ingestPlaylist(live);
			requests += Math.max(1, Math.ceil(items / PAGE.playlistItems));
			refreshed++;
		}

		// Tracks that arrived with that refresh have no ISRC group yet, and the
		// candidate query dedupes on exactly that — without this, a song already
		// in the destination under another id reads as new. Only run it when
		// something actually changed; it is a few seconds over the whole catalog.
		if (refreshed > 0) await query(sql`select spotidata.refresh_canonical_tracks()`);

		const candidates = await pendingTrackIds(id);
		if (candidates.length === 0) {
			await recordChecked(id);
			return {
				status: 'unchanged',
				playlistId,
				added: 0,
				candidates: 0,
				requests,
				created: false,
				refreshed,
				truncated: false,
				message: 'Nothing new in the sources.'
			};
		}

		// --- the destination --------------------------------------------------
		//
		// A playlist the user deleted in the app is only *unfollowed*, and Spotify
		// keeps serving it by id, so null here means genuinely gone — a wiped
		// account, an id from a restored database. Forgetting it and making a new
		// one is the only repair that leaves the ledger meaningful.
		let live = playlistId ? await getPlaylist(playlistId) : null;
		if (playlistId) requests++;

		if (playlistId && !live) {
			playlistId = null;
			await query(sql`
				update playlist_automations set spotify_playlist_id = null where id = ${id}
			`);
		}

		if (!playlistId) {
			const me = await getMe();
			if (!me) throw new Error('No Spotify profile stored yet — run a sync first.');
			const playlist = await createPlaylist(me.id, {
				name: automation.name,
				description: describe(automation, automation.sources.length),
				public: automation.playlistPublic
			});
			requests++;
			created = true;
			playlistId = playlist.id;
			live = playlist;
			// Stored before anything is pushed: a failure between here and the
			// first append must not leave an orphan playlist and create a second
			// one on the next run.
			await query(sql`
				update playlist_automations
				   set spotify_playlist_id = ${playlistId}, updated_at = now()
				 where id = ${id}
			`);
		}

		// --- what it already holds -------------------------------------------
		//
		// Read live, not from the mirror: the whole premise is that this playlist
		// is edited by hand between runs, and adding a duplicate of something the
		// user put there themselves is exactly the interference this must not
		// cause.
		const present: string[] = [];
		if (!created && (live?.tracks?.total ?? 0) > 0) {
			for (let offset = 0; ; offset += PAGE.playlistItems) {
				const page = await getPlaylistItemIds(playlistId, offset);
				requests++;
				for (const item of page.items) {
					if (item?.track?.id) present.push(item.track.id);
				}
				if (!page.next) break;
			}
		}
		const presentIds = new Set(present);
		const presentCanonical = await canonicalIdsFor(present);

		// Something already in the playlist is recorded rather than re-offered:
		// it is in the destination, which is all the automation was ever trying
		// to achieve, and leaving it pending would show it as "to add" forever.
		const already: LedgerEntry[] = [];
		const wanted: LedgerEntry[] = [];
		for (const c of candidates) {
			const here =
				presentIds.has(c.trackId) ||
				(c.canonicalTrackId !== null && presentCanonical.has(c.canonicalTrackId));
			(here ? already : wanted).push(c);
		}
		await recordLedger(id, already, 'seeded');

		// Spotify rejects an add that would take a playlist past 10,000 items, and
		// it counts every item — including the local files and episodes that never
		// made it into `present`, hence the total off the playlist itself.
		const held = Math.max(present.length, live?.tracks?.total ?? 0);
		const room = Math.max(0, MAX_PLAYLIST_ITEMS - held);
		const truncated = wanted.length > room;
		const toAdd = truncated ? wanted.slice(0, room) : wanted;

		for (let i = 0; i < toAdd.length; i += PLAYLIST_ITEMS_PER_REQUEST) {
			const slice = toAdd.slice(i, i + PLAYLIST_ITEMS_PER_REQUEST);
			await addPlaylistItems(
				playlistId,
				slice.map((t) => spotifyLink('track', t.trackId, 'uri'))
			);
			requests++;
			// Written per chunk, not at the end: a run that dies halfway has
			// already appended those tracks, and a ledger that did not know it
			// would add them a second time on the retry.
			await recordLedger(id, slice, 'added');
		}

		await query(sql`
			update playlist_automations
			   set added_track_count = added_track_count + ${toAdd.length},
			       last_added_count = ${toAdd.length},
			       last_run_at = now(),
			       last_run_error = null
			 where id = ${id}
		`);

		return {
			status: toAdd.length > 0 ? 'added' : 'unchanged',
			playlistId,
			added: toAdd.length,
			candidates: candidates.length,
			requests,
			created,
			refreshed,
			truncated,
			message: message(toAdd.length, already.length, created, truncated)
		};
	} catch (err) {
		const text = err instanceof Error ? err.message : String(err);
		await recordError(id, text.slice(0, 500));
		throw err;
	}
}

function message(added: number, already: number, created: boolean, truncated: boolean): string {
	if (truncated) {
		return `Playlist is at Spotify's 10,000-track ceiling — added ${added} and stopped.`;
	}
	if (added === 0) {
		return already > 0
			? `Nothing to add — all ${already} were already in the playlist.`
			: 'Nothing new in the sources.';
	}
	const tail = already > 0 ? ` (${already} were already there)` : '';
	return created
		? `Playlist created with ${added} track${added === 1 ? '' : 's'}${tail}.`
		: `Added ${added} track${added === 1 ? '' : 's'}${tail}.`;
}

/** The snapshot whose items are stored, or null for a playlist never ingested. */
async function storedSnapshot(playlistId: string): Promise<string | null> {
	const rows = await query<{ snapshot: string | null }>(sql`
		select items_synced_snapshot_id as snapshot from playlists where id = ${playlistId}
	`);
	return rows[0]?.snapshot ?? null;
}

/**
 * The recordings behind a set of Spotify track ids.
 *
 * A playlist that already holds the single release of a song must not receive
 * the album cut of the same recording, and only the ISRC grouping can say they
 * are the same. Ids the catalog has never seen contribute nothing, which is the
 * right answer — an unknown id can only be matched literally.
 */
async function canonicalIdsFor(trackIds: string[]): Promise<Set<string>> {
	if (trackIds.length === 0) return new Set();
	const found = new Set<string>();
	for (let i = 0; i < trackIds.length; i += 1000) {
		const rows = await query<{ canonicalTrackId: string }>(sql`
			select distinct canonical_track_id as "canonicalTrackId"
			  from spotify_tracks
			 where id = ${anyOf(trackIds.slice(i, i + 1000))} and canonical_track_id is not null
		`);
		for (const row of rows) found.add(row.canonicalTrackId);
	}
	return found;
}

/** A run that reached Spotify and found nothing to do still counts as a run. */
const recordChecked = (id: string) =>
	query(sql`
		update playlist_automations
		   set last_run_error = null, last_added_count = 0, last_run_at = now()
		 where id = ${id}
	`);

/** A failure leaves `last_run_at` alone: nothing ran to completion. */
const recordError = (id: string, error: string) =>
	query(sql`update playlist_automations set last_run_error = ${error} where id = ${id}`);

/** Every automation the background job is allowed to run. */
export async function autoRunAutomationIds(): Promise<string[]> {
	const rows = await query<{ id: string }>(sql`
		select a.id
		  from playlist_automations a
		 where a.auto_run
		   and exists (select 1 from automation_sources s where s.automation_id = a.id)
		 order by a.updated_at
	`);
	return rows.map((r) => r.id);
}
