import { sql } from 'drizzle-orm';
import { db } from '../db/index.ts';

export interface PhaseStatus extends Record<string, unknown> {
	key: string;
	label: string;
	ordinal: number;
	status: string;
	done: number;
	total: number;
	failed: number;
	items: number;
	startedAt: string | null;
	finishedAt: string | null;
	/** Jobs per second for this phase, from its own elapsed time. */
	rate: number | null;
	etaSeconds: number | null;
}

export interface SyncStatus {
	run: {
		id: number;
		mode: string;
		status: string;
		trigger: string;
		startedAt: string | null;
		finishedAt: string | null;
		error: string | null;
		apiRequests: number;
		stats: Record<string, number>;
	} | null;
	phases: PhaseStatus[];
	limiter: {
		refillPerSec: number;
		targetPerSec: number;
		blockedUntil: string | null;
		last429At: string | null;
		last429RetryAfterS: number | null;
		consecutive429: number;
		requestsTotal: number;
	} | null;
	/** Per-minute API volume for the last two hours. */
	throughput: Array<{ bucket: string; requests: number; errors: number; rateLimited: number }>;
	events: Array<{ id: number; level: string; message: string; phaseKey: string | null; at: string }>;
	queue: { pending: number; failing: number };
	etaSeconds: number | null;
	counts: Record<string, number>;
}

/**
 * One round-trip for the whole /sync page. Every number the UI shows already
 * lives in sync_phases, because leaf tasks increment their counters in the
 * same transaction as their writes.
 */
export async function getSyncStatus(runId?: number): Promise<SyncStatus> {
	const { rows: runRows } = await db.execute<SyncStatus['run'] & object>(sql`
		select id, mode, status, trigger,
		       started_at as "startedAt", finished_at as "finishedAt",
		       error, api_requests as "apiRequests", stats
		  from sync_runs
		 where ${runId ? sql`id = ${runId}` : sql`true`}
		 order by id desc
		 limit 1
	`);
	const run = runRows[0] ?? null;

	const { rows: phases } = await db.execute<PhaseStatus>(sql`
		select key, label, ordinal, status, done, total, failed, items,
		       started_at as "startedAt", finished_at as "finishedAt",
		       case when started_at is not null and done > 0
		            then done / greatest(extract(epoch from coalesce(finished_at, now()) - started_at), 1)
		       end as rate,
		       case when started_at is not null and done > 0 and total > done
		            then (total - done) /
		                 nullif(done / greatest(extract(epoch from now() - started_at), 1), 0)
		       end as "etaSeconds"
		  from sync_phases
		 where run_id = ${run?.id ?? -1}
		 order by ordinal
	`);

	const { rows: limiterRows } = await db.execute<NonNullable<SyncStatus['limiter']>>(sql`
		select refill_per_sec as "refillPerSec", target_per_sec as "targetPerSec",
		       blocked_until as "blockedUntil", last_429_at as "last429At",
		       last_429_retry_after_s as "last429RetryAfterS",
		       consecutive_429 as "consecutive429", requests_total as "requestsTotal"
		  from rate_limiter where id = 1
	`);

	const { rows: throughput } = await db.execute<SyncStatus['throughput'][number]>(sql`
		select bucket, requests, errors, rate_limited as "rateLimited"
		  from api_call_stats
		 where bucket > now() - interval '2 hours'
		 order by bucket
	`);

	const { rows: events } = await db.execute<SyncStatus['events'][number]>(sql`
		select id, level, message, phase_key as "phaseKey", at
		  from sync_events
		 where run_id = ${run?.id ?? -1}
		 order by id desc
		 limit 50
	`);

	const { rows: queueRows } = await db.execute<{ pending: number; failing: number }>(sql`
		select count(*)::int as pending,
		       count(*) filter (where last_error is not null)::int as failing
		  from graphile_worker._private_jobs
	`);

	const { rows: countRows } = await db.execute<Record<string, number>>(sql`
		select (select count(*)::int from spotify_tracks)    as tracks,
		       (select count(*)::int from canonical_tracks)  as recordings,
		       (select count(*)::int from library_canonical) as library,
		       (select count(*)::int from albums)            as albums,
		       (select count(*)::int from artists)           as artists,
		       (select count(*)::int from playlists where removed_at is null) as playlists,
		       (select count(*)::int from saved_tracks where removed_at is null) as liked
	`);

	// Whole-run ETA: remaining work across unfinished phases divided by the
	// rate actually observed in the last few minutes, so throttling stretches
	// the estimate instead of making it a lie.
	const recent = throughput.slice(-3);
	const recentRps =
		recent.length > 0 ? recent.reduce((a, b) => a + b.requests, 0) / (recent.length * 60) : null;
	const remaining = phases
		.filter((p) => p.status !== 'completed' && p.status !== 'skipped')
		.reduce((a, p) => a + Math.max(0, p.total - p.done), 0);

	return {
		run,
		phases,
		limiter: limiterRows[0] ?? null,
		throughput,
		events,
		queue: queueRows[0] ?? { pending: 0, failing: 0 },
		etaSeconds: recentRps && recentRps > 0 && remaining > 0 ? remaining / recentRps : null,
		counts: countRows[0] ?? {}
	};
}

export async function listRuns(limit = 20) {
	const { rows } = await db.execute<{
		id: number;
		mode: string;
		status: string;
		trigger: string;
		startedAt: string | null;
		finishedAt: string | null;
		apiRequests: number;
		stats: Record<string, number>;
	}>(sql`
		select id, mode, status, trigger,
		       started_at as "startedAt", finished_at as "finishedAt",
		       api_requests as "apiRequests", stats
		  from sync_runs order by id desc limit ${limit}
	`);
	return rows;
}
