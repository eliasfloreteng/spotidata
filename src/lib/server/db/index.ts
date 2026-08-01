import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { config } from '../config.ts';

import { relations } from './relations.ts';

const { Pool, types } = pg;

// node-postgres hands back `numeric` as a string to avoid precision loss. Every
// numeric in this schema is a small rate-limiter quantity, so parse to number.
types.setTypeParser(types.builtins.NUMERIC, (v) => Number.parseFloat(v));
// int8 (bigint) counts stay well inside Number.MAX_SAFE_INTEGER here.
types.setTypeParser(types.builtins.INT8, (v) => Number.parseInt(v, 10));

/**
 * The application pool, used by SvelteKit request handlers.
 *
 * Graphile Worker gets its own pool (`workerPool`): it holds one connection
 * permanently open for LISTEN/NOTIFY plus one per concurrent job, and sharing
 * a pool would let a burst of job fan-out starve page loads.
 */
export const appPool = new Pool({
	connectionString: config.databaseUrl,
	max: 10,
	idleTimeoutMillis: 30_000,
	application_name: 'spotidata-app'
});

export const workerPool = new Pool({
	connectionString: config.databaseUrl,
	max: config.worker.concurrency + 4,
	idleTimeoutMillis: 30_000,
	application_name: 'spotidata-worker'
});

// An idle client erroring out (server restart, network blip) emits on the pool.
// Without a listener node-postgres escalates it to an uncaught exception.
for (const [name, pool] of [
	['app', appPool],
	['worker', workerPool]
] as const) {
	pool.on('error', (err) => {
		console.error(`[db] idle client error in ${name} pool:`, err.message);
	});
}

// Drizzle v1 takes the client in the config object (a positional client is
// silently reinterpreted as a PoolConfig, which drops the password), dropped
// the `schema` option in favour of `relations`, and replaced the `casing`
// option with per-table `snakeCase.table()`.
export const db = drizzle({ client: appPool, relations });
export const workerDb = drizzle({ client: workerPool, relations });

export type Db = typeof db;

export async function closePools(): Promise<void> {
	await Promise.allSettled([appPool.end(), workerPool.end()]);
}

/**
 * `db.execute<T>` constrains T to Record<string, unknown>, which forces that
 * index signature onto every result interface in the codebase. This wrapper
 * absorbs the cast once and returns plain rows.
 */
export async function query<T>(statement: Parameters<Db['execute']>[0]): Promise<T[]> {
	const { rows } = await db.execute<T & Record<string, unknown>>(statement);
	return rows as T[];
}
