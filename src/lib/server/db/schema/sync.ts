import {
	bigint,
	check,
	index,
	integer,
	jsonb,
	numeric,
	primaryKey,
	smallint,
	text,
	timestamp,
	unique,
	uniqueIndex
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { table, ts, tsNow } from './_shared.ts';

export type SyncMode = 'full' | 'incremental' | 'ondemand' | 'repair';
export type SyncStatus =
	| 'queued'
	| 'running'
	| 'paused_rate_limited'
	| 'paused_auth'
	| 'completed'
	| 'failed'
	| 'cancelled';

const ACTIVE_STATUSES = sql`('queued','running','paused_rate_limited','paused_auth')`;

export const syncRuns = table(
	'sync_runs',
	{
		id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		mode: text().$type<SyncMode>().notNull(),
		status: text().$type<SyncStatus>().notNull(),
		trigger: text().notNull(),
		startedAt: ts(),
		finishedAt: ts(),
		error: text(),
		apiRequests: integer().notNull().default(0),
		stats: jsonb().notNull().default(sql`'{}'::jsonb`),
		createdAt: tsNow()
	},
	(t) => [
		check('sync_runs_mode', sql`${t.mode} in ('full','incremental','ondemand','repair')`),
		check(
			'sync_runs_status',
			sql`${t.status} in ('queued','running','paused_rate_limited','paused_auth','completed','failed','cancelled')`
		),
		// At most one live run, enforced by the database rather than app logic.
		uniqueIndex('sync_runs_one_active_ix')
			.on(sql`(true)`)
			.where(sql`${t.status} in ${ACTIVE_STATUSES}`),
		index('sync_runs_created_ix').on(sql`${t.createdAt} desc`)
	]
);

/**
 * One row per pipeline phase per run. `done`/`total` are the progress bar and
 * are incremented by leaf tasks *inside the same transaction as their data
 * write*, so a crashed-and-retried job can never double-count.
 */
export const syncPhases = table(
	'sync_phases',
	{
		id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		runId: bigint({ mode: 'number' })
			.notNull()
			.references(() => syncRuns.id, { onDelete: 'cascade' }),
		ordinal: smallint().notNull(),
		key: text().notNull(),
		label: text().notNull(),
		status: text().notNull().default('pending'),
		total: integer().notNull().default(0),
		done: integer().notNull().default(0),
		failed: integer().notNull().default(0),
		/** Domain rows written (tracks, albums…), distinct from job count. */
		items: bigint({ mode: 'number' }).notNull().default(0),
		startedAt: ts(),
		finishedAt: ts(),
		meta: jsonb().notNull().default(sql`'{}'::jsonb`)
	},
	(t) => [
		unique('sync_phases_run_key_uq').on(t.runId, t.key),
		check(
			'sync_phases_status',
			sql`${t.status} in ('pending','seeding','running','completed','failed','skipped')`
		)
	]
);

export const syncEvents = table(
	'sync_events',
	{
		id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		runId: bigint({ mode: 'number' }).references(() => syncRuns.id, { onDelete: 'cascade' }),
		phaseKey: text(),
		level: text().notNull(),
		message: text().notNull(),
		data: jsonb(),
		at: tsNow()
	},
	(t) => [
		check('sync_events_level', sql`${t.level} in ('debug','info','warn','error')`),
		index('sync_events_run_ix').on(t.runId, sql`${t.id} desc`)
	]
);

/**
 * Single-row token bucket + circuit breaker, deliberately in Postgres rather
 * than in memory. A 429's Retry-After can be measured in hours; if that
 * penalty evaporated on a dev-server reload we would walk straight back into
 * the ban. Postgres also makes it correct across the Bun and Node processes.
 */
export const rateLimiter = table(
	'rate_limiter',
	{
		id: smallint().primaryKey().default(1),
		tokens: numeric().notNull().default('20'),
		capacity: numeric().notNull().default('20'),
		refillPerSec: numeric().notNull().default('1'),
		targetPerSec: numeric().notNull().default('2.5'),
		lastRefill: tsNow(),
		blockedUntil: ts(),
		// Named explicitly: the snake_case deriver does not split a
		// letter→digit boundary, so `last429At` would become `last429_at`.
		last429At: timestamp('last_429_at', { withTimezone: true }),
		last429RetryAfterS: integer('last_429_retry_after_s'),
		consecutive429: integer('consecutive_429').notNull().default(0),
		requestsTotal: bigint({ mode: 'number' }).notNull().default(0),
		updatedAt: tsNow()
	},
	(t) => [check('rate_limiter_singleton', sql`${t.id} = 1`)]
);

/** Per-minute API counters; drives the sparkline and the live ETA. */
export const apiCallStats = table('api_call_stats', {
	bucket: timestamp({ withTimezone: true }).primaryKey(),
	requests: integer().notNull().default(0),
	errors: integer().notNull().default(0),
	rateLimited: integer().notNull().default(0),
	bytes: bigint({ mode: 'number' }).notNull().default(0)
});

/**
 * Verbatim API payloads, on by default (~300 MB for this library).
 *
 * Insurance against schema regret: a forgotten column becomes a 10-second SQL
 * re-derive instead of a 40-minute refetch against an API that keeps deleting
 * endpoints. Toggle with settings['sync.store_raw_payloads'].
 */
export const ingestRaw = table(
	'ingest_raw',
	{
		entityType: text().notNull(),
		entityId: text().notNull(),
		fetchedAt: tsNow(),
		payload: jsonb().notNull()
	},
	(t) => [
		primaryKey({ columns: [t.entityType, t.entityId] }),
		check(
			'ingest_raw_entity_type',
			sql`${t.entityType} in ('track','album','artist','playlist','user')`
		)
	]
);
