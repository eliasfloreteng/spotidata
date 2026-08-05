import type { Task } from 'graphile-worker';
import { autoSyncCollectionIds, PlaylistScopeError, syncCollection } from '../../playlists/sync.ts';
import { SpotifyAuthExpired, SpotifyRateLimited } from '../../spotify/errors.ts';
import { SPOTIFY_FLAG } from '../constants.ts';

/**
 * Keeping generated playlists current, in the background.
 *
 * These jobs carry `SPOTIFY_FLAG` like every other API-touching task, so while
 * the rate-limit breaker is open the pool skips them wholesale rather than
 * burning retries — a playlist that is an hour stale is not worth a 429 that
 * stalls the sync.
 *
 * Nothing here is urgent and nothing here is ordered: each collection is its
 * own job, so one failing (a deleted playlist, a revoked scope) leaves the
 * others alone.
 */

/** Fans out to one job per auto-syncing collection. */
export const syncAllPlaylists: Task = async (_payload, helpers) => {
	const ids = await autoSyncCollectionIds();
	for (const id of ids) {
		await helpers.addJob(
			'playlist:sync',
			{ collectionId: id },
			{ jobKey: `playlist-sync:${id}`, jobKeyMode: 'preserve_run_at', flags: [SPOTIFY_FLAG] }
		);
	}
	if (ids.length) helpers.logger.info(`[playlists] queued ${ids.length} collection(s)`);
};

export const syncPlaylist: Task = async (payload, helpers) => {
	const { collectionId, force } = payload as { collectionId: string; force?: boolean };

	try {
		const result = await syncCollection(collectionId, { force });
		helpers.logger.info(`[playlists] ${collectionId}: ${result.status} — ${result.message}`);
	} catch (err) {
		// A missing scope or an expired grant is not a transient failure: every
		// retry costs a request and fails the same way until somebody
		// re-authorizes. The error is already recorded on the collection, which
		// is where the page reads it from.
		if (err instanceof PlaylistScopeError || err instanceof SpotifyAuthExpired) {
			helpers.logger.warn(`[playlists] ${collectionId}: authorization cannot write playlists`);
			return;
		}
		// The breaker is open. Come back when it closes rather than retrying
		// into it — same contract as every other Spotify task.
		if (err instanceof SpotifyRateLimited) {
			await helpers.addJob(
				'playlist:sync',
				{ collectionId, force },
				{
					jobKey: `playlist-sync:${collectionId}`,
					jobKeyMode: 'replace',
					runAt: err.until,
					flags: [SPOTIFY_FLAG]
				}
			);
			return;
		}
		throw err;
	}
};
