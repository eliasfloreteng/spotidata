import type { JobHelpers, AddJobsJobSpec } from 'graphile-worker';
import { db } from '../db/index.ts';
import type { Executor } from '../ingest/_bulk.ts';
import { SpotifyRateLimited, SpotifyAuthExpired } from '../spotify/errors.ts';
import { bumpPhase, completePhase, logEvent, setRunStatus, type PhaseKey } from './phases.ts';
import { SPOTIFY_FLAG } from './constants.ts';

/** Postgres deadlock_detected / serialization_failure. */
const RETRYABLE_PG_CODES = new Set(['40P01', '40001']);

function pgCode(err: unknown): string | undefined {
	// Drizzle wraps the driver error; the SQLSTATE lives on the cause chain.
	for (let e = err as { code?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
		if (typeof e.code === 'string') return e.code;
	}
	return undefined;
}

/**
 * Wraps a leaf task so its data write and its phase-counter increment commit
 * together, and so rate-limit / auth failures are handled once here rather
 * than in every task.
 *
 * `fetch` runs OUTSIDE the transaction and exactly once; `write` runs inside
 * it and may be retried. Keeping the HTTP call out of the retry path matters
 * because a deadlock retry would otherwise spend a second request from a
 * budget of roughly three per second.
 *
 * The counter still moves in the same transaction as the rows, so a crashed
 * and re-run job cannot double-count and the progress bar cannot lie.
 *
 * On `SpotifyRateLimited` the job RESCHEDULES ITSELF at the unblock time and
 * returns successfully. Throwing would burn an attempt and eventually drop the
 * work — and there is nothing to retry into anyway, since `forbiddenFlags`
 * already stops the pool while the breaker is open.
 */
export async function runLeafTask<T>(
	helpers: JobHelpers,
	opts: {
		runId: number;
		phase: PhaseKey;
		/** The API call. Runs once, outside any transaction. */
		fetch: () => Promise<T>;
		/** Persists `data`. Returns rows written, surfaced as phase `items`. */
		write: (tx: Executor, data: T) => Promise<number>;
	}
): Promise<void> {
	let justFinished = false;
	try {
		const data = await opts.fetch();

		// Concurrent workers upserting overlapping artists and albums can still
		// deadlock despite consistent lock ordering; Postgres picks a victim and
		// rolls it back cleanly, so replaying just the write is the right move.
		for (let attempt = 0; ; attempt++) {
			try {
				await db.transaction(async (tx) => {
					const items = await opts.write(tx, data);
					const progress = await bumpPhase(tx, opts.runId, opts.phase, { items });
					justFinished = progress.justFinished;
				});
				break;
			} catch (err) {
				if (attempt >= 4 || !RETRYABLE_PG_CODES.has(pgCode(err) ?? '')) throw err;
				await new Promise((r) => setTimeout(r, 50 * 2 ** attempt + Math.random() * 50));
			}
		}
	} catch (err) {
		if (err instanceof SpotifyRateLimited) {
			await rescheduleForRateLimit(helpers, err);
			return;
		}
		if (err instanceof SpotifyAuthExpired) {
			await setRunStatus(opts.runId, 'paused_auth');
			await logEvent(
				opts.runId,
				'error',
				'Authorization expired — re-authorization required',
				null,
				opts.phase
			);
			return;
		}
		throw err;
	}

	if (justFinished) {
		await completePhase(opts.runId, opts.phase);
		await helpers.addJob(
			'phase:complete',
			{ runId: opts.runId, phaseKey: opts.phase },
			{ jobKey: `sync:${opts.runId}:done:${opts.phase}`, jobKeyMode: 'unsafe_dedupe' }
		);
	}
}

export async function rescheduleForRateLimit(
	helpers: JobHelpers,
	err: SpotifyRateLimited
): Promise<void> {
	const job = helpers.job;
	await helpers.addJob(job.task_identifier, job.payload as object, {
		jobKey: job.key ?? undefined,
		jobKeyMode: 'replace',
		runAt: err.until,
		flags: [SPOTIFY_FLAG],
		maxAttempts: job.max_attempts
	});
	helpers.logger.info(`rate limited; rescheduled for ${err.until.toISOString()}`);
}

/** Splits ids into API-sized batches and enqueues them in bulk. */
export async function seedBatchJobs(
	helpers: JobHelpers,
	opts: {
		runId: number;
		task: string;
		ids: string[];
		batchSize: number;
		keyPrefix: string;
		priority?: number;
	}
): Promise<number> {
	const batches: string[][] = [];
	for (let i = 0; i < opts.ids.length; i += opts.batchSize) {
		batches.push(opts.ids.slice(i, i + opts.batchSize));
	}

	// One addJobs call per 500 specs; 3,000+ jobs insert in well under a second.
	for (let i = 0; i < batches.length; i += 500) {
		const specs: AddJobsJobSpec[] = batches.slice(i, i + 500).map((ids, n) => ({
			identifier: opts.task,
			payload: { runId: opts.runId, ids },
			jobKey: `${opts.keyPrefix}:${i + n}`,
			flags: [SPOTIFY_FLAG],
			maxAttempts: 5,
			priority: opts.priority ?? 0
		}));
		// addJobs forbids jobKeyMode; the boolean is how it expresses
		// preserve_run_at, so re-seeding does not reset a job's schedule.
		await helpers.addJobs(specs, true);
	}
	return batches.length;
}

/** Standard job options for anything that talks to Spotify. */
export const spotifyJob: Pick<AddJobsJobSpec, 'flags' | 'maxAttempts'> = {
	flags: [SPOTIFY_FLAG],
	// 25 (the default) would retry for days. Five is plenty given that
	// rate-limit and auth failures are handled without consuming an attempt.
	maxAttempts: 5
};
