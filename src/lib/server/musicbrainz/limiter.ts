import { sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { ServiceBlocked } from './errors.ts';

/** Longest we will hold a worker slot waiting for a token. */
const MAX_INLINE_WAIT_MS = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AcquireRow extends Record<string, unknown> {
	granted: boolean;
	wait_ms: number;
	blocked_until: Date | null;
}

/**
 * Blocks until this service's bucket hands over a token.
 *
 * The distinction that matters: an empty bucket is a wait measured in
 * milliseconds and is slept through inline, while an open breaker is a penalty
 * measured in minutes and is thrown, so the caller can put the job back on the
 * queue rather than pin a worker on it.
 */
export async function pace(service: string, cost = 1): Promise<void> {
	for (;;) {
		const { rows } = await db.execute<AcquireRow>(
			sql`select * from spotidata.xrl_acquire(${service}, ${cost})`
		);
		const slot = rows[0];
		if (slot?.granted) return;
		if (slot?.blocked_until) throw new ServiceBlocked(service, slot.blocked_until);
		await sleep(Math.min(slot?.wait_ms ?? 1000, MAX_INLINE_WAIT_MS));
	}
}

/** Opens the breaker for everyone and returns when it lifts. */
export async function penalize(service: string, seconds: number): Promise<Date> {
	const { rows } = await db.execute<{ until: Date }>(
		sql`select spotidata.xrl_penalize(${service}, ${seconds}) as until`
	);
	return rows[0]?.until ?? new Date(Date.now() + seconds * 1000);
}

export interface LimiterRow extends Record<string, unknown> {
	service: string;
	blockedUntil: Date | null;
	requestsTotal: number;
	refillPerSec: number;
}

export async function readLimiters(): Promise<LimiterRow[]> {
	const { rows } = await db.execute<LimiterRow>(sql`
		select service,
		       blocked_until   as "blockedUntil",
		       requests_total  as "requestsTotal",
		       refill_per_sec  as "refillPerSec"
		  from external_limiters
		 order by service
	`);
	return rows;
}
