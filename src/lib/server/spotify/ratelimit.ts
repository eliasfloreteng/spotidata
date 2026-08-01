import { sql } from 'drizzle-orm';
import { db } from '../db/index.ts';

export interface AcquireResult {
	granted: boolean;
	waitMs: number;
	blockedUntil: Date | null;
}

export async function acquire(cost = 1): Promise<AcquireResult> {
	const { rows } = await db.execute<{
		granted: boolean;
		wait_ms: number;
		blocked_until: Date | null;
	}>(sql`select * from spotidata.rl_acquire(${cost})`);
	const r = rows[0];
	return {
		granted: r?.granted ?? false,
		waitMs: r?.wait_ms ?? 1000,
		blockedUntil: r?.blocked_until ?? null
	};
}

export async function penalize(retryAfterSeconds: number): Promise<Date> {
	const { rows } = await db.execute<{ rl_penalize: Date }>(
		sql`select spotidata.rl_penalize(${retryAfterSeconds}) as rl_penalize`
	);
	return rows[0]?.rl_penalize ?? new Date(Date.now() + retryAfterSeconds * 1000);
}

export async function recover(): Promise<number | null> {
	const { rows } = await db.execute<{ rl_recover: number | null }>(
		sql`select spotidata.rl_recover() as rl_recover`
	);
	return rows[0]?.rl_recover ?? null;
}

export interface LimiterState extends Record<string, unknown> {
	tokens: number;
	capacity: number;
	refillPerSec: number;
	targetPerSec: number;
	blockedUntil: Date | null;
	last429At: Date | null;
	last429RetryAfterS: number | null;
	consecutive429: number;
	requestsTotal: number;
}

export async function readLimiter(): Promise<LimiterState | null> {
	const { rows } = await db.execute<LimiterState>(sql`
		select tokens, capacity,
		       refill_per_sec as "refillPerSec",
		       target_per_sec as "targetPerSec",
		       blocked_until as "blockedUntil",
		       last_429_at as "last429At",
		       last_429_retry_after_s as "last429RetryAfterS",
		       consecutive_429 as "consecutive429",
		       requests_total as "requestsTotal"
		  from rate_limiter where id = 1
	`);
	return rows[0] ?? null;
}

/** Applied at the start of a sync: throttle the first full crawl. */
export async function setTargetRpm(rpm: number, alsoSetCurrent = false): Promise<void> {
	const perSec = rpm / 60;
	await db.execute(sql`
		update rate_limiter
		   set target_per_sec = ${perSec},
		       refill_per_sec = ${alsoSetCurrent ? sql`${perSec}` : sql`least(refill_per_sec, ${perSec})`},
		       updated_at = now()
		 where id = 1
	`);
}

export async function clearBlock(): Promise<void> {
	await db.execute(sql`
		update rate_limiter
		   set blocked_until = null, consecutive_429 = 0, updated_at = now()
		 where id = 1
	`);
}

/**
 * Batched per-minute counters. Flushing on a timer rather than per request
 * keeps the hot path to a single round-trip (rl_acquire).
 */
let pending = { requests: 0, errors: 0, rateLimited: 0, bytes: 0 };
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function recordCall(kind: 'ok' | 'error' | 'rate_limited', bytes = 0): void {
	pending.requests++;
	if (kind === 'error') pending.errors++;
	if (kind === 'rate_limited') pending.rateLimited++;
	pending.bytes += bytes;

	flushTimer ??= setTimeout(() => {
		flushTimer = null;
		void flushCallStats();
	}, 2000);
	// Do not hold the process open for a stats flush.
	flushTimer.unref?.();
}

export async function flushCallStats(): Promise<void> {
	if (pending.requests === 0) return;
	const batch = pending;
	pending = { requests: 0, errors: 0, rateLimited: 0, bytes: 0 };
	try {
		await db.execute(
			sql`select spotidata.rl_record(${batch.requests}, ${batch.errors}, ${batch.rateLimited}, ${batch.bytes})`
		);
	} catch {
		// Stats are best-effort; never fail a sync over them.
	}
}
