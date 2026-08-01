import { sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { ingestRaw } from '../db/schema/index.ts';
import { loadSettings } from '../settings.ts';
import { chunkRows, dedupeBy, type Executor } from './_bulk.ts';

/** Constrained by the `ingest_raw_entity_type` check constraint. */
export type RawEntityType = 'track' | 'album' | 'artist' | 'playlist' | 'user';

const CACHE_MS = 30_000;
let cached: { at: number; enabled: boolean } | null = null;

/**
 * `storeRaw` is called once per API batch — several thousand times per full
 * sync — for a setting a human changes by hand. Re-reading the settings table
 * each time would roughly double the statement count of the ingest path.
 */
async function storeRawEnabled(): Promise<boolean> {
	if (cached && Date.now() - cached.at < CACHE_MS) return cached.enabled;
	const settings = await loadSettings();
	cached = { at: Date.now(), enabled: settings['sync.storeRawPayloads'] };
	return cached.enabled;
}

/** Makes a settings change take effect now rather than within 30s. */
export function resetRawPayloadCache(): void {
	cached = null;
}

/**
 * Keeps the verbatim payloads a row was derived from, so a column we failed to
 * model becomes a SQL re-derive instead of a refetch. A no-op while
 * settings['sync.storeRawPayloads'] is off.
 */
export async function storeRaw(
	entityType: RawEntityType,
	rows: Array<{ id: string; payload: unknown }>,
	on?: Executor
): Promise<void> {
	if (rows.length === 0) return;
	if (!(await storeRawEnabled())) return;

	const values = dedupeBy(
		rows.filter((r) => r.id),
		(r) => r.id
	).map((r) => ({
		entityType,
		entityId: r.id,
		payload: r.payload,
		fetchedAt: new Date()
	}));

	const exec = on ?? db;
	// A payload is a few KB, so the row cap is about statement size here rather
	// than about the bind-parameter ceiling.
	for (const part of chunkRows(values, 200)) {
		await exec
			.insert(ingestRaw)
			.values(part)
			.onConflictDoUpdate({
				target: [ingestRaw.entityType, ingestRaw.entityId],
				set: { payload: sql`excluded.payload`, fetchedAt: sql`now()` }
			});
	}
}
