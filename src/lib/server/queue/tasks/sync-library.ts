import type { Task, AddJobsJobSpec } from 'graphile-worker';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { textArray, timestamptzArray, notIn } from '../../db/arrays.ts';
import type { Executor } from '../../ingest/_bulk.ts';
import { savedTracks, savedAlbums, followedArtists } from '../../db/schema/index.ts';
import {
	getSavedTracks,
	getSavedAlbums,
	getFollowedArtists,
	getMyPlaylists,
	getPlaylistItems,
	PAGE
} from '../../spotify/endpoints.ts';
import { upsertFullTracks } from '../../ingest/upsert-tracks.ts';
import { upsertFullAlbums } from '../../ingest/upsert-albums.ts';
import { upsertFullArtists } from '../../ingest/upsert-artists.ts';
import {
	upsertPlaylists,
	clearPlaylistItems,
	replacePlaylistItems
} from '../../ingest/upsert-playlists.ts';
import { ingestMe, getMe } from '../../ingest/upsert-users.ts';
import { storeRaw } from '../../ingest/raw.ts';
import type { FullArtist, PlaylistTrackItem, SavedAlbum } from '../../spotify/types.ts';
import { runLeafTask, spotifyJob } from '../helpers.ts';
import { startPhase, logEvent, type PhaseKey } from '../phases.ts';

interface RunPayload {
	runId: number;
	mode?: 'full' | 'incremental';
}

/**
 * Phase 0 — identity, follows, saved albums.
 *
 * Small and bounded, so it runs inline rather than fanning out. It must finish
 * before playlists, because `is_owned` (and therefore the whole definition of
 * "library") depends on knowing who "me" is.
 */
export const syncProfile: Task = async (payload, helpers) => {
	const { runId } = payload as RunPayload;
	await startPhase(runId, 'profile', 1);

	await runLeafTask(helpers, {
		runId,
		phase: 'profile',
		// Everything is paged first; the transaction opens only once all the
		// throttled HTTP work is done.
		fetch: async () => {
			const me = await ingestMe();

			// Followed artists are cursor-paginated, not offset-paginated.
			const followed: FullArtist[] = [];
			let after: string | undefined;
			do {
				const page = await getFollowedArtists(after);
				followed.push(...page.artists.items.filter(Boolean));
				after = page.artists.cursors?.after ?? undefined;
			} while (after);

			// Saved albums are newest-first, so a full pass is cheap and exact.
			const saved: SavedAlbum[] = [];
			for (let offset = 0; ; offset += PAGE.savedAlbums) {
				const page = await getSavedAlbums(offset);
				const items = page.items.filter((i) => i?.album);
				saved.push(...items);
				if (items.length === 0 || !page.next) break;
			}

			return { me, followed, saved };
		},
		write: async (tx, { me, followed, saved }) => {
			let rows = 1;

			if (followed.length > 0) {
				await upsertFullArtists(followed, tx);
				await storeRaw('artist', followed.map((a) => ({ id: a.id, payload: a })), tx);
				const ids = followed.map((a) => a.id);
				await tx.execute(sql`
					insert into followed_artists (artist_id)
					select unnest(${textArray(ids)})
					on conflict (artist_id) do update set removed_at = null
				`);
				// Anything previously followed but absent now was unfollowed.
				await tx.execute(sql`
					update followed_artists set removed_at = now()
					 where removed_at is null and artist_id ${notIn(ids)}
				`);
				rows += followed.length;
			}

			if (saved.length > 0) {
				await upsertFullAlbums(saved.map((i) => i.album), tx);
				const ids = saved.map((i) => i.album.id);
				const addedAts = saved.map((i) => i.added_at);
				await tx.execute(sql`
					insert into saved_albums (album_id, added_at)
					select * from unnest(${textArray(ids)}, ${timestamptzArray(addedAts)})
					on conflict (album_id) do update
					   set added_at = excluded.added_at, removed_at = null
				`);
				await tx.execute(sql`
					update saved_albums set removed_at = now()
					 where removed_at is null and album_id ${notIn(ids)}
				`);
				rows += saved.length;
			}

			await logEvent(
				runId,
				'info',
				`Profile synced: ${me.display_name ?? me.id}`,
				{ followedArtists: followed.length, savedAlbums: saved.length },
				'profile'
			);
			return rows;
		}
	});

	await helpers.addJob('sync:seed-liked', { runId, mode: (payload as RunPayload).mode }, { jobKey: `sync:${runId}:seed:liked` });
	await helpers.addJob('sync:seed-playlists', { runId }, { jobKey: `sync:${runId}:seed:playlists` });
	// One request, gating nothing — the poll rides along rather than sitting in
	// the dependency chain, so a rate-limited history never stalls the library.
	await helpers.addJob('sync:recent-plays', { runId }, {
		jobKey: `sync:${runId}:plays`,
		...spotifyJob
	});
};

// ------------------------------------------------------------- liked songs

/**
 * Seeds the liked-songs phase.
 *
 * The first page reveals `total`, which lets every remaining offset be
 * enqueued at once instead of walking the pagination serially.
 *
 * Incremental mode exploits the fact that /me/tracks is ordered newest-first:
 * we stop as soon as a page is entirely older than the newest `added_at` we
 * already have, which usually means one request instead of 204. Removals are
 * invisible to that early stop, so a count mismatch triggers a full pass.
 */
export const seedLiked: Task = async (payload, helpers) => {
	const { runId, mode } = payload as RunPayload;

	const first = await getSavedTracks(0);
	await db.transaction((tx) => ingestSavedTracks(tx, first.items));

	// `::text` then parse: raw SQL hands back timestamps as strings, and
	// comparing a Date against one silently stringifies the Date and compares
	// lexicographically — which is always false, so the early stop never fired.
	const { rows } = await db.execute<{ n: number; newest: string | null }>(sql`
		select count(*)::int as n, max(added_at)::text as newest
		  from saved_tracks where removed_at is null
	`);
	const stored = rows[0]?.n ?? 0;
	const newest = rows[0]?.newest ? new Date(rows[0].newest) : null;

	// /me/tracks is ordered newest-first. If the whole first page is already
	// older than our newest stored save, and the totals agree, nothing was
	// added or removed and the remaining 203 pages are guaranteed redundant.
	const oldestOnFirstPage = first.items.at(-1)?.added_at;
	const canEarlyStop =
		mode === 'incremental' &&
		newest !== null &&
		stored === first.total &&
		oldestOnFirstPage !== undefined &&
		new Date(oldestOnFirstPage).getTime() <= newest.getTime();

	if (canEarlyStop) {
		await startPhase(runId, 'liked', 1);
		await logEvent(runId, 'info', 'Liked songs unchanged — skipped full pass', { total: first.total }, 'liked');
		await helpers.addJob('phase:complete', { runId, phaseKey: 'liked' as PhaseKey }, {
			jobKey: `sync:${runId}:done:liked`,
			jobKeyMode: 'unsafe_dedupe'
		});
		return;
	}

	const pages = Math.ceil(first.total / PAGE.savedTracks);
	await startPhase(runId, 'liked', Math.max(pages, 1));

	// Page 0 is already ingested above; account for it.
	await db.execute(sql`update sync_phases set done = done + 1 where run_id = ${runId} and key = 'liked'`);

	const specs: AddJobsJobSpec[] = [];
	for (let offset = PAGE.savedTracks; offset < first.total; offset += PAGE.savedTracks) {
		specs.push({
			identifier: 'sync:liked-page',
			payload: { runId, offset },
			jobKey: `sync:${runId}:liked:${offset}`,
			...spotifyJob
		});
	}
	for (let i = 0; i < specs.length; i += 500) {
		await helpers.addJobs(specs.slice(i, i + 500), true);
	}

	await logEvent(runId, 'info', `Liked songs: ${first.total} tracks over ${pages} pages`, null, 'liked');
};

export const likedPage: Task = async (payload, helpers) => {
	const { runId, offset } = payload as { runId: number; offset: number };
	await runLeafTask(helpers, {
		runId,
		phase: 'liked',
		fetch: () => getSavedTracks(offset),
		write: (tx, page) => ingestSavedTracks(tx, page.items)
	});
};

type SavedTrackItems = Awaited<ReturnType<typeof getSavedTracks>>['items'];

async function ingestSavedTracks(tx: Executor, items: SavedTrackItems): Promise<number> {
	const withTrack = items.filter((i) => i.track !== null) as Array<{
		added_at: string;
		track: NonNullable<(typeof items)[number]['track']>;
	}>;
	if (withTrack.length === 0) return 0;

	await upsertFullTracks(
		withTrack.map((i) => i.track),
		tx
	);
	await storeRaw(
		'track',
		withTrack.filter((i) => i.track.id).map((i) => ({ id: i.track.id!, payload: i.track })),
		tx
	);

	const ids = withTrack.map((i) => i.track.id).filter((id): id is string => Boolean(id));
	const addedAts = withTrack
		.filter((i) => i.track.id)
		.map((i) => i.added_at);

	if (ids.length > 0) {
		await tx.execute(sql`
			insert into saved_tracks (track_id, added_at)
			select * from unnest(${textArray(ids)}, ${timestamptzArray(addedAts)})
			on conflict (track_id) do update
			   set added_at = excluded.added_at, removed_at = null
		`);
	}
	return ids.length;
}

// --------------------------------------------------------------- playlists

export const seedPlaylists: Task = async (payload, helpers) => {
	const { runId } = payload as RunPayload;
	const me = await getMe();
	if (!me) throw new Error('No `me` user — profile phase must run first');

	const all: Array<{ id: string; snapshotId: string; total: number }> = [];

	for (let offset = 0; ; offset += PAGE.playlists) {
		const page = await getMyPlaylists(offset);
		// Spotify occasionally emits null entries in this list.
		const items = page.items.filter((p): p is NonNullable<typeof p> => p !== null);
		if (items.length > 0) {
			await upsertPlaylists(items, me.id);
			await storeRaw(
				'playlist',
				items.map((p) => ({ id: p.id, payload: p }))
			);
			all.push(
				...items.map((p) => ({ id: p.id, snapshotId: p.snapshot_id, total: p.tracks?.total ?? 0 }))
			);
		}
		if (!page.next) break;
	}

	await startPhase(runId, 'playlists', 1);
	await db.execute(sql`update sync_phases set done = 1 where run_id = ${runId} and key = 'playlists'`);

	if (all.length > 0) {
		const ids = all.map((p) => p.id);
		await db.execute(sql`
			update playlists set removed_at = now()
			 where removed_at is null and id ${notIn(ids)}
		`);
	}

	// snapshot_id changes whenever a playlist's contents change. Anything
	// unchanged since the last successful item sync can be skipped entirely —
	// this is what collapses a resync from ~425 requests to a handful.
	const { rows: stale } = await db.execute<{ id: string; total: number }>(sql`
		select id, coalesce(total_tracks, 0) as total
		  from playlists
		 where removed_at is null
		   and (items_synced_snapshot_id is distinct from snapshot_id)
	`);

	await startPhase(runId, 'playlist_items', stale.length);
	await logEvent(
		runId,
		'info',
		`Playlists: ${all.length} total, ${stale.length} changed since last sync`,
		{ skipped: all.length - stale.length },
		'playlists'
	);

	const specs: AddJobsJobSpec[] = stale.map((p) => ({
		identifier: 'sync:playlist-items',
		payload: { runId, playlistId: p.id },
		jobKey: `sync:${runId}:pli:${p.id}`,
		...spotifyJob
	}));
	for (let i = 0; i < specs.length; i += 500) {
		await helpers.addJobs(specs.slice(i, i + 500), true);
	}

	await helpers.addJob('phase:complete', { runId, phaseKey: 'playlists' }, {
		jobKey: `sync:${runId}:done:playlists`,
		jobKeyMode: 'unsafe_dedupe'
	});

	// A phase seeded with zero work is already complete, but no leaf task will
	// ever run to fire its completion — and the album phase waits on it. On an
	// unchanged incremental sync that is the normal case, so without this the
	// run hangs at 'running' forever.
	if (specs.length === 0) {
		await helpers.addJob('phase:complete', { runId, phaseKey: 'playlist_items' }, {
			jobKey: `sync:${runId}:done:playlist_items`,
			jobKeyMode: 'unsafe_dedupe'
		});
	}
};

/**
 * Fetches every page of one playlist and replaces its rows atomically.
 *
 * Whole-playlist replacement rather than per-row upsert: positions shift on
 * every reorder, and the (playlist_id, position) primary key means a partial
 * update would leave phantom rows behind.
 */
export const playlistItems: Task = async (payload, helpers) => {
	const { runId, playlistId } = payload as { runId: number; playlistId: string };

	await runLeafTask(helpers, {
		runId,
		phase: 'playlist_items',
		// All pages are fetched before the transaction opens: holding one open
		// across dozens of throttled HTTP round-trips would pin a connection
		// and block VACUUM for minutes.
		fetch: async () => {
			const items: PlaylistTrackItem[] = [];
			for (let offset = 0; ; offset += PAGE.playlistItems) {
				const page = await getPlaylistItems(playlistId, offset);
				items.push(...page.items);
				if (!page.next) break;
			}
			return items;
		},
		write: async (tx, items) => {
			await clearPlaylistItems(playlistId, tx);
			if (items.length > 0) await replacePlaylistItems(playlistId, items, 0, tx);
			const total = items.length;
			let snapshotId: string | null = null;

			// Re-read the snapshot we actually stored, so a playlist edited
			// mid-fetch is retried next run rather than marked clean.
			const { rows } = await tx.execute<{ snapshot_id: string }>(
				sql`select snapshot_id from playlists where id = ${playlistId}`
			);
			snapshotId = rows[0]?.snapshot_id ?? null;

			await tx.execute(sql`
				update playlists
				   set items_synced_snapshot_id = ${snapshotId},
				       items_synced_at = now()
				 where id = ${playlistId}
			`);
			return total;
		}
	});
};
