import { sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { syncPhases } from '../db/schema/index.ts';
import type { Executor } from '../ingest/_bulk.ts';

/**
 * The pipeline, in dependency order. Each phase's seeder is what discovers its
 * own work units, so `total` is only known once the previous phase finished.
 *
 * Ordering note: `/me/tracks` and playlist items already return FULL track
 * objects carrying ISRC, so the *library* is correctly canonicalized after
 * `canonicalize` — every chart works at that point. `hydrate` only sharpens
 * album-completion percentages across editions, so it runs last and cheap.
 */
export const PHASES = [
	{ key: 'profile', label: 'Profile, follows & saved albums' },
	{ key: 'liked', label: 'Liked songs' },
	{ key: 'playlists', label: 'Playlists' },
	{ key: 'playlist_items', label: 'Playlist tracks' },
	{ key: 'albums', label: 'Albums' },
	{ key: 'album_tracks', label: 'Album track overflow' },
	{ key: 'artists', label: 'Artists' },
	{ key: 'canonicalize', label: 'Group by ISRC' },
	{ key: 'derive', label: 'Build library' },
	{ key: 'hydrate', label: 'Enrich album tracks' },
	{ key: 'finalize', label: 'Finalize' }
] as const;

export type PhaseKey = (typeof PHASES)[number]['key'];

export async function createPhases(runId: number, on: Executor = db): Promise<void> {
	await on
		.insert(syncPhases)
		.values(PHASES.map((p, i) => ({ runId, ordinal: i, key: p.key, label: p.label })))
		.onConflictDoNothing();
}

/**
 * Creates the run and its phase rows atomically.
 *
 * Doing these separately is a trap: if phase creation fails, the run row is
 * already committed as active, so the retry hits the "one active run" index,
 * logs "already running", and succeeds — permanently hiding the real error
 * behind a zombie run. Rolling both back together makes the failure visible.
 *
 * Returns null when a sync is genuinely already in flight.
 */
export async function beginRun(
	mode: 'full' | 'incremental' | 'ondemand' | 'repair',
	trigger: string
): Promise<number | null> {
	return db.transaction(async (tx) => {
		const { rows } = await tx.execute<{ id: number }>(sql`
			insert into sync_runs (mode, status, trigger, started_at)
			values (${mode}, 'running', ${trigger}, now())
			on conflict do nothing
			returning id
		`);
		const runId = rows[0]?.id;
		if (runId === undefined) return null;
		await createPhases(runId, tx);
		return runId;
	});
}

export async function startPhase(runId: number, key: PhaseKey, total: number): Promise<void> {
	await db.execute(sql`
		update sync_phases
		   set status = case when ${total} = 0 then 'completed' else 'running' end,
		       total = ${total},
		       started_at = coalesce(started_at, now()),
		       finished_at = case when ${total} = 0 then now() else null end
		 where run_id = ${runId} and key = ${key}
	`);
}

export async function skipPhase(runId: number, key: PhaseKey, reason?: string): Promise<void> {
	await db.execute(sql`
		update sync_phases
		   set status = 'skipped', finished_at = now(),
		       meta = meta || ${JSON.stringify({ reason: reason ?? null })}::jsonb
		 where run_id = ${runId} and key = ${key}
	`);
}

export async function completePhase(runId: number, key: PhaseKey): Promise<void> {
	await db.execute(sql`
		update sync_phases
		   set status = 'completed', finished_at = now()
		 where run_id = ${runId} and key = ${key} and status <> 'completed'
	`);
}

/**
 * Advances a phase counter using the SAME connection (and therefore the same
 * transaction) as the caller's data write.
 *
 * Atomicity is the whole point: if the counter moved in its own transaction, a
 * job that crashed after incrementing but before committing its rows would be
 * retried and double-count, and the progress bar would lie. Returns whether
 * this was the increment that finished the phase.
 */
export async function bumpPhase(
	tx: Executor,
	runId: number,
	key: PhaseKey,
	opts: { done?: number; failed?: number; items?: number } = {}
): Promise<{ done: number; total: number; justFinished: boolean }> {
	const { rows } = await tx.execute<{ done: number; total: number }>(sql`
		update sync_phases
		   set done = done + ${opts.done ?? 1},
		       failed = failed + ${opts.failed ?? 0},
		       items = items + ${opts.items ?? 0}
		 where run_id = ${runId} and key = ${key}
		 returning done, total
	`);
	const row = rows[0];
	if (!row) return { done: 0, total: 0, justFinished: false };
	return {
		done: row.done,
		total: row.total,
		justFinished: row.total > 0 && row.done >= row.total
	};
}

// ------------------------------------------------------------------ events

export async function logEvent(
	runId: number | null,
	level: 'debug' | 'info' | 'warn' | 'error',
	message: string,
	data?: unknown,
	phaseKey?: string
): Promise<void> {
	await db.execute(sql`
		insert into sync_events (run_id, phase_key, level, message, data)
		values (${runId}, ${phaseKey ?? null}, ${level}, ${message},
		        ${data === undefined ? null : JSON.stringify(data)}::jsonb)
	`);
}

// -------------------------------------------------------------------- runs

export async function createRun(
	mode: 'full' | 'incremental' | 'ondemand' | 'repair',
	trigger: string
): Promise<number | null> {
	// The partial unique index on sync_runs rejects a second active run, which
	// is exactly the concurrency guard we want — treat the conflict as "already
	// running" rather than an error.
	const { rows } = await db.execute<{ id: number }>(sql`
		insert into sync_runs (mode, status, trigger, started_at)
		values (${mode}, 'running', ${trigger}, now())
		on conflict do nothing
		returning id
	`);
	return rows[0]?.id ?? null;
}

export async function finishRun(
	runId: number,
	status: 'completed' | 'failed' | 'cancelled',
	error?: string
): Promise<void> {
	await db.execute(sql`
		update sync_runs
		   set status = ${status}, finished_at = now(), error = ${error ?? null}
		 where id = ${runId}
	`);
}

export async function setRunStatus(
	runId: number,
	status: 'running' | 'paused_rate_limited' | 'paused_auth'
): Promise<void> {
	await db.execute(sql`update sync_runs set status = ${status} where id = ${runId}`);
}

export async function activeRun(): Promise<{ id: number; status: string; mode: string } | null> {
	const { rows } = await db.execute<{ id: number; status: string; mode: string }>(sql`
		select id, status, mode from sync_runs
		 where status in ('queued','running','paused_rate_limited','paused_auth')
		 limit 1
	`);
	return rows[0] ?? null;
}
