import { snakeCase, pgSchema, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** All app tables use snake_case column names derived from camelCase keys. */
export const table = snakeCase.table;

/**
 * Declared so drizzle-kit treats the Graphile Worker schema as *known* and
 * emits `CREATE SCHEMA IF NOT EXISTS` rather than planning a DROP for it.
 * It intentionally contains no tables — Graphile Worker owns its own DDL via
 * `worker.migrate()`. `scripts/check-migration.ts` is the backstop.
 */
export const graphileWorkerSchema = pgSchema('graphile_worker');

export const tsNow = () => timestamp({ withTimezone: true }).notNull().defaultNow();
export const ts = () => timestamp({ withTimezone: true });

/** Spotify's `external_urls` map; always present, sometimes empty. */
export const externalUrls = () =>
	jsonb().$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`);

/** Rows we ingest from Spotify all carry the same provenance trio. */
export const provenance = {
	firstSeenAt: tsNow(),
	fetchedAt: ts(),
	updatedAt: tsNow()
};

/**
 * Whether a row was built from a *full* Spotify object or a *simplified* one
 * nested inside another entity. Simplified rows lack ISRC/popularity/genres,
 * so the partial index on this column is what drives the hydration phases.
 */
export type DetailLevel = 'simplified' | 'full';
