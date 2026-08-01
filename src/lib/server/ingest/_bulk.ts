import { db, type Db } from '../db/index.ts';
import { chunk } from '../spotify/endpoints.ts';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * The pool, or a transaction opened by the caller. Every upsert accepts one so
 * a caller that must write several tables atomically — a paged playlist
 * replace, say — can hand its transaction down instead of committing halfway.
 */
export type Executor = Db | Tx;

/** Postgres rejects any statement carrying more than 65535 bind parameters. */
const MAX_BIND_PARAMS = 65_535;

/**
 * Splits rows so one INSERT can never exceed the bind-parameter ceiling. The
 * 500-row cap binds for narrow tables; the division only bites for wide ones
 * (spotify_tracks writes 20 columns per row).
 */
export function chunkRows<T extends Record<string, unknown>>(rows: T[], maxRows = 500): T[][] {
	const first = rows[0];
	const columns = first ? Object.keys(first).length : 1;
	return chunk(rows, Math.max(1, Math.min(maxRows, Math.floor(MAX_BIND_PARAMS / columns))));
}

/** Chunks a key list for `where <col> in (…)` — one bind parameter per id. */
export function chunkIds(ids: string[]): string[][] {
	return chunk(ids, 1000);
}

/**
 * ON CONFLICT DO UPDATE aborts with "cannot affect row a second time" when a
 * single statement proposes the same key twice, and a batch of 50 tracks
 * routinely names one artist repeatedly. The last occurrence wins.
 *
 * The result is also SORTED BY KEY, which is load-bearing rather than tidy:
 * eight workers upserting overlapping artist and album sets took row locks in
 * arrival order and deadlocked constantly (291 deadlocks in one partial sync).
 * Sorting gives every transaction the same lock ordering, which makes the
 * cycle impossible.
 */
export function dedupeBy<T>(rows: T[], key: (row: T) => string): T[] {
	const byKey = new Map<string, T>();
	for (const row of rows) byKey.set(key(row), row);
	return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row);
}

/** Runs `fn` on the caller's executor, or in a transaction of its own. */
export function withTx<T>(on: Executor | undefined, fn: (tx: Executor) => Promise<T>): Promise<T> {
	return on ? fn(on) : db.transaction((tx) => fn(tx));
}
