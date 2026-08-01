import { json } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { db, appPool, workerPool } from '$lib/server/db/index.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	const started = performance.now();

	// db.execute returns a node-postgres Result; the rows live on `.rows`.
	const { rows } = await db.execute<{
		version: string;
		now: string;
		tables: number;
		functions: number;
	}>(sql`
		select version() as version,
		       now()::text as now,
		       (select count(*)::int from information_schema.tables
		         where table_schema = 'public') as tables,
		       (select count(*)::int from pg_proc p
		          join pg_namespace n on n.oid = p.pronamespace
		         where n.nspname = 'spotidata') as functions
	`);

	const row = rows[0];
	if (!row) return json({ ok: false, error: 'no result' }, { status: 500 });

	return json({
		ok: true,
		database: {
			version: row.version.split(' on ')[0],
			now: row.now,
			tables: row.tables,
			functions: row.functions
		},
		pools: {
			app: { total: appPool.totalCount, idle: appPool.idleCount, waiting: appPool.waitingCount },
			worker: {
				total: workerPool.totalCount,
				idle: workerPool.idleCount,
				waiting: workerPool.waitingCount
			}
		},
		latencyMs: Math.round((performance.now() - started) * 100) / 100
	});
};
