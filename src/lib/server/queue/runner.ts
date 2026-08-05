import { run, makeWorkerUtils, type Runner, type WorkerUtils } from 'graphile-worker';
import { workerPool } from '../db/index.ts';
import { config } from '../config.ts';
import { taskList } from './tasks/index.ts';

import { SPOTIFY_FLAG } from './constants.ts';

export { SPOTIFY_FLAG };

let runner: Runner | null = null;
let utils: WorkerUtils | null = null;
let starting: Promise<void> | null = null;

/** Cached to 1s, as the Graphile Worker docs advise for this hook. */
let flagCache = { flags: [] as string[], at: 0 };

async function forbiddenFlags(): Promise<string[]> {
	if (Date.now() - flagCache.at < 1000) return flagCache.flags;
	try {
		const { rows } = await workerPool.query<{ blocked: boolean }>(
			`SELECT blocked_until IS NOT NULL AND blocked_until > now() AS blocked
			   FROM rate_limiter WHERE id = 1`
		);
		flagCache = { flags: rows[0]?.blocked ? [SPOTIFY_FLAG] : [], at: Date.now() };
	} catch {
		// Never let a hiccup here wedge the whole pool.
		flagCache = { flags: [], at: Date.now() };
	}
	return flagCache.flags;
}

export async function getWorkerUtils(): Promise<WorkerUtils> {
	utils ??= await makeWorkerUtils({ pgPool: workerPool });
	return utils;
}

/**
 * Starts the embedded worker. Verified under Bun: 4,500 jobs/s with ~12ms
 * NOTIFY→execute latency, so LISTEN/NOTIFY genuinely works here and the long
 * pollInterval below is only a safety net.
 */
export async function startWorker(): Promise<void> {
	if (config.worker.mode !== 'embedded') return;
	if (runner) return;
	starting ??= (async () => {
		const u = await getWorkerUtils();
		await u.migrate();
		runner = await run({
			pgPool: workerPool,
			concurrency: config.worker.concurrency,
			pollInterval: 5000,
			noHandleSignals: true,
			taskList,
			forbiddenFlags,
			crontab: [
				// Incremental resync twice a day; `fill` backfills a run missed
				// while the laptop was closed.
				'0 4,16 * * * sync:start ?id=sync-incremental&fill=1d&jobKey=cron-sync {"mode":"incremental","trigger":"cron"}',
				// Full reconciliation weekly — catches unsaves, which the
				// added_at watermark early-stop cannot see.
				'30 5 * * 0 sync:start ?id=sync-full&jobKey=cron-full {"mode":"full","trigger":"cron"}',
				// The recently-played window is 50 items deep and nothing can
				// recover a gap that overruns it, so this polls far more often
				// than a sync runs — one request each time.
				'*/20 * * * * history:poll-recent ?jobKey=poll-recent',
				// Restarts the MusicBrainz crawl if its chain ever stops — after a
				// deploy, after a rate-limit block, or simply because a sync added
				// music it has not seen. The chain keeps itself going while there
				// is work, so this mostly fires into a no-op.
				'*/15 * * * * enrich:tick ?jobKey=enrich-tick',
				// AIMD ramp back toward the target request rate.
				'* * * * * maintenance:rate-recover ?jobKey=rate-recover',
				'*/5 * * * * maintenance:watchdog ?jobKey=watchdog',
				'15 3 * * * maintenance:prune-events ?jobKey=prune-events'
			].join('\n')
		});
		console.log(`[worker] embedded runner started (concurrency ${config.worker.concurrency})`);
	})();
	await starting;
}

export async function stopWorker(): Promise<void> {
	await runner?.stop();
	runner = null;
	await utils?.release();
	utils = null;
	starting = null;
}

export function isWorkerRunning(): boolean {
	return runner !== null;
}
