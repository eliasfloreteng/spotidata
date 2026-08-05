import type { Task, TaskList } from 'graphile-worker';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { logEvent } from '../phases.ts';
import {
	syncProfile,
	seedLiked,
	likedPage,
	seedPlaylists,
	playlistItems
} from './sync-library.ts';
import {
	seedAlbums,
	albumsBatch,
	albumTracks,
	seedArtists,
	artistsBatch,
	seedHydrate,
	tracksHydrate
} from './sync-catalog.ts';
import {
	syncStart,
	phaseComplete,
	canonicalize,
	derive,
	canonicalizeFinal,
	finalize,
	rateRecover,
	watchdog,
	pruneEvents,
	cancelRun
} from './sync-control.ts';
import {
	importHistory,
	pollRecent,
	syncRecentPlays,
	seedPlaysResolve,
	playsResolveBatch
} from './history.ts';
import { ondemandEntity } from './ondemand.ts';
import { enrichTick, enrichRetryMisses } from './enrich.ts';

/**
 * Album-track overflow is seeded implicitly: `sync:albums-batch` enqueues a
 * job (and increments this phase's total) for each album whose track list
 * exceeded the 50 embedded in the album payload. By the time albums finish,
 * `total` already holds the right number — so this task only has to decide
 * whether there is anything to wait for.
 */
const seedAlbumTracks: Task = async (payload, helpers) => {
	const { runId } = payload as { runId: number };
	const { rows } = await db.execute<{ total: number; done: number }>(sql`
		select total, done from sync_phases where run_id = ${runId} and key = 'album_tracks'
	`);
	const total = rows[0]?.total ?? 0;

	if (total === 0) {
		await db.execute(sql`
			update sync_phases set status = 'completed', finished_at = now()
			 where run_id = ${runId} and key = 'album_tracks'
		`);
		await helpers.addJob('phase:complete', { runId, phaseKey: 'album_tracks' }, {
			jobKey: `sync:${runId}:done:album_tracks`,
			jobKeyMode: 'unsafe_dedupe'
		});
		return;
	}

	await db.execute(sql`
		update sync_phases set status = 'running', started_at = coalesce(started_at, now())
		 where run_id = ${runId} and key = 'album_tracks'
	`);
	await logEvent(runId, 'info', `Album track overflow: ${total} long albums`, null, 'album_tracks');

	// The jobs are already queued; if they all finished before this ran, close
	// the phase out here rather than waiting for an increment that never comes.
	if ((rows[0]?.done ?? 0) >= total) {
		await helpers.addJob('phase:complete', { runId, phaseKey: 'album_tracks' }, {
			jobKey: `sync:${runId}:done:album_tracks`,
			jobKeyMode: 'unsafe_dedupe'
		});
	}
};

export const taskList: TaskList = {
	// Orchestration
	'sync:start': syncStart,
	'phase:complete': phaseComplete,
	'sync:cancel': cancelRun,

	// Library
	'sync:profile': syncProfile,
	'sync:seed-liked': seedLiked,
	'sync:liked-page': likedPage,
	'sync:seed-playlists': seedPlaylists,
	'sync:playlist-items': playlistItems,

	// Catalog
	'sync:seed-albums': seedAlbums,
	'sync:albums-batch': albumsBatch,
	'sync:seed-album-tracks': seedAlbumTracks,
	'sync:album-tracks': albumTracks,
	'sync:seed-artists': seedArtists,
	'sync:artists-batch': artistsBatch,
	'sync:seed-hydrate': seedHydrate,
	'sync:tracks-hydrate': tracksHydrate,

	// Listening history
	'sync:recent-plays': syncRecentPlays,
	'sync:seed-plays-resolve': seedPlaysResolve,
	'sync:plays-resolve-batch': playsResolveBatch,
	'history:import': importHistory,
	'history:poll-recent': pollRecent,

	// Derived
	'sync:canonicalize': canonicalize,
	'sync:derive': derive,
	'sync:canonicalize-final': canonicalizeFinal,
	'sync:finalize': finalize,

	// On-demand page fetches; run at priority -1000 so they preempt a sync.
	'ondemand:entity': ondemandEntity,

	// MusicBrainz / AcousticBrainz. One self-chaining job, paced at 1 req/s.
	'enrich:tick': enrichTick,
	'enrich:retry-misses': enrichRetryMisses,

	// Maintenance
	'maintenance:rate-recover': rateRecover,
	'maintenance:watchdog': watchdog,
	'maintenance:prune-events': pruneEvents
};
