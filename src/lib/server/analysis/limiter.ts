import { sql } from 'drizzle-orm';
import { db } from '../db/index.ts';

/**
 * Pacing for the third-party APIs the analysis reads, through the per-service
 * token bucket in `external_limiters` (db/sql/post/080_external_limiter.sql).
 * It lives in Postgres for the reason the Spotify one does: a penalty measured
 * in minutes must survive a restart and be shared by every process.
 */

/** Longest we will hold a worker slot waiting for a token. */
const MAX_INLINE_WAIT_MS = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The breaker for a third-party service is open, because it asked us to stop.
 *
 * Carries the instant it lifts, so a self-chaining job can hand itself back to
 * the queue with `runAt` set instead of sleeping on it.
 */
export class ServiceBlocked extends Error {
	constructor(
		readonly service: string,
		readonly until: Date
	) {
		super(`${service} unavailable until ${until.toISOString()}`);
		this.name = 'ServiceBlocked';
	}
}

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
