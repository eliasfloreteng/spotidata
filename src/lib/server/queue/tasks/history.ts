import type { Task } from 'graphile-worker';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { loadSettings } from '../../settings.ts';
import { getRecentlyPlayed, getTracks, BATCH } from '../../spotify/endpoints.ts';
import { SpotifyAuthExpired, SpotifyRateLimited } from '../../spotify/errors.ts';
import { upsertFullTracks } from '../../ingest/upsert-tracks.ts';
import { storeRaw } from '../../ingest/raw.ts';
import {
	insertPlays,
	linkPlays,
	markResolveAttempted,
	refreshPlayStats,
	unresolvedTrackIds
} from '../../ingest/upsert-plays.ts';
import type { PlayInput } from '../../import/streaming-history.ts';
import { runPlayImport } from '../../import/run.ts';
import { runLeafTask, seedBatchJobs } from '../helpers.ts';
import { logEvent, startPhase } from '../phases.ts';

/**
 * Listening history: the archive importer, the recently-played poller, and the
 * phase that turns played URIs into catalog rows.
 */

// ------------------------------------------------------------------ import

/** Runs one uploaded or pointed-at archive. Progress lives on `play_imports`. */
export const importHistory: Task = async (payload) => {
	const { importId } = payload as { importId: number };
	await runPlayImport(importId);
};

// ------------------------------------------------------------------- poll

/**
 * Fetches whatever `/me/player/recently-played` has that we do not.
 *
 * The watermark is the newest polled play rather than the newest play of any
 * kind: an import can land history from months ago without meaning that the
 * last few hours were already seen. `after` is exclusive and in milliseconds,
 * and the endpoint caps at 50 items regardless, so a long gap simply loses its
 * middle — the import is the only cure for that, and it is why this runs on a
 * short cron rather than only during a sync.
 */
export async function pollRecentPlays(): Promise<{ fetched: number; inserted: number }> {
	const { rows } = await db.execute<{ newest: string | null }>(sql`
		select max(played_at)::text as newest from plays where source = 'recent'
	`);
	const newest = rows[0]?.newest ? new Date(rows[0].newest) : null;

	const page = await getRecentlyPlayed(newest ? newest.getTime() : undefined);
	const items = page.items ?? [];
	if (items.length === 0) return { fetched: 0, inserted: 0 };

	// The tracks come back as full objects, so the catalog learns them for free
	// — no resolve pass needed for anything played in the last 50 streams.
	const tracks = items.map((i) => i.track).filter((t) => t?.id);
	if (tracks.length > 0) {
		await db.transaction(async (tx) => {
			await upsertFullTracks(tracks, tx);
			await storeRaw('track', tracks.map((t) => ({ id: t.id!, payload: t })), tx);
		});
	}

	const plays: PlayInput[] = items.map((item) => {
		const at = new Date(item.played_at);
		// Whole seconds, so a later import of the same play collides on the
		// unique key instead of doubling it.
		at.setUTCMilliseconds(0);
		return {
			playedAt: at.toISOString(),
			// Unknown, and deliberately not guessed at from the track duration:
			// NULL is what tells the rollup to leave this row out of the
			// completed/skipped split rather than to assume a full listen.
			msPlayed: null,
			itemKind: 'track',
			itemUri: item.track.uri,
			trackName: item.track.name,
			artistName: item.track.artists?.[0]?.name ?? null,
			albumName: item.track.album?.name ?? null,
			episodeName: null,
			showName: null,
			platform: null,
			connCountry: null,
			reasonStart: null,
			reasonEnd: null,
			shuffle: null,
			skipped: null,
			offline: null,
			incognito: null
		};
	});

	const { inserted } = await insertPlays(plays, { source: 'recent' });
	if (inserted > 0) {
		await linkPlays();
		await refreshPlayStats();
	}
	return { fetched: items.length, inserted };
}

/** The cron entry. A rate limit or an expired grant waits for the next tick. */
export const pollRecent: Task = async (_payload, helpers) => {
	const settings = await loadSettings();
	if (!settings['history.pollRecentlyPlayed']) return;
	try {
		const { fetched, inserted } = await pollRecentPlays();
		if (inserted > 0) helpers.logger.info(`recently-played: ${inserted} new of ${fetched}`);
	} catch (err) {
		if (err instanceof SpotifyRateLimited || err instanceof SpotifyAuthExpired) return;
		throw err;
	}
};

/** The same poll as a sync phase, so /sync shows it and retries own it. */
export const syncRecentPlays: Task = async (payload, helpers) => {
	const { runId } = payload as { runId: number };
	await startPhase(runId, 'plays', 1);

	await runLeafTask(helpers, {
		runId,
		phase: 'plays',
		fetch: () => pollRecentPlays(),
		write: async (_tx, { fetched, inserted }) => {
			await logEvent(
				runId,
				'info',
				`Recently played: ${inserted} new play(s) of ${fetched} returned`,
				null,
				'plays'
			);
			return inserted;
		}
	});
};

// ------------------------------------------------------------------ resolve

/**
 * Seeds the fetch of every track the log names but the catalog has never seen.
 *
 * Most of what you listen to was never saved, so on a first import this is a
 * few hundred requests against ~26k unique URIs — worth it, because it is what
 * lets a play join an artist, an album and a recording rather than sitting in
 * the log as a name. Ids that come back empty are marked attempted and never
 * asked about again; /history has the button that clears those marks.
 */
export const seedPlaysResolve: Task = async (payload, helpers) => {
	const { runId } = payload as { runId: number };
	const settings = await loadSettings();

	const ids = settings['history.resolvePlayedTracks'] ? await unresolvedTrackIds() : [];

	const batches = await seedBatchJobs(helpers, {
		runId,
		task: 'sync:plays-resolve-batch',
		ids,
		batchSize: BATCH.tracks,
		keyPrefix: `sync:${runId}:play`
	});

	await startPhase(runId, 'plays_resolve', batches);
	await logEvent(
		runId,
		'info',
		ids.length > 0
			? `Played tracks: ${ids.length} unknown to the catalog, in ${batches} batches`
			: 'Played tracks: nothing new to resolve',
		null,
		'plays_resolve'
	);

	if (batches === 0) {
		await helpers.addJob('phase:complete', { runId, phaseKey: 'plays_resolve' }, {
			jobKey: `sync:${runId}:done:plays_resolve`,
			jobKeyMode: 'unsafe_dedupe'
		});
	}
};

export const playsResolveBatch: Task = async (payload, helpers) => {
	const { runId, ids } = payload as { runId: number; ids: string[] };

	await runLeafTask(helpers, {
		runId,
		phase: 'plays_resolve',
		fetch: () => getTracks(ids),
		write: async (tx, { tracks }) => {
			const found = tracks.filter((t): t is NonNullable<typeof t> => t !== null);
			if (found.length > 0) {
				await upsertFullTracks(found, tx);
				await storeRaw(
					'track',
					found.filter((t) => t.id).map((t) => ({ id: t.id!, payload: t })),
					tx
				);
			}
			// Every id in the batch is marked, found or not: the point is to ask
			// once. The ones that resolved get their plays linked below anyway.
			await markResolveAttempted(ids, tx);
			return found.length;
		}
	});
};
