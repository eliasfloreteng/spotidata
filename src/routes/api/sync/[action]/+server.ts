import { error, json } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db/index.ts';
import { getWorkerUtils } from '$lib/server/queue/runner.ts';
import { activeRun, finishRun, logEvent } from '$lib/server/queue/phases.ts';
import { clearBlock } from '$lib/server/spotify/ratelimit.ts';
import type { RequestHandler } from './$types';

/** POST /api/sync/start|cancel|resume */
export const POST: RequestHandler = async ({ params, request }) => {
	const utils = await getWorkerUtils();

	switch (params.action) {
		case 'start': {
			const body = (await request.json().catch(() => ({}))) as { mode?: 'full' | 'incremental' };
			const existing = await activeRun();
			if (existing) error(409, `A sync is already ${existing.status} (run ${existing.id})`);

			await utils.addJob(
				'sync:start',
				{ mode: body.mode ?? 'incremental', trigger: 'manual' },
				{ jobKey: 'sync:start:manual' }
			);
			return json({ ok: true, queued: true });
		}

		case 'cancel': {
			const existing = await activeRun();
			if (!existing) error(404, 'No active sync');

			// Drop this run's queued work; the jobKey prefix scopes the delete so
			// on-demand fetches and maintenance keep running.
			await db.execute(sql`
				delete from graphile_worker._private_jobs
				 where key like ${'sync:' + existing.id + ':%'}
			`);
			await finishRun(existing.id, 'cancelled', 'cancelled by user');
			await logEvent(existing.id, 'warn', 'Sync cancelled by user');
			return json({ ok: true, cancelled: existing.id });
		}

		case 'resume': {
			// Manual override after an hours-long Retry-After. Deliberately not
			// automatic: clearing a long ban early is how you earn a longer one.
			await clearBlock();
			const existing = await activeRun();
			if (existing) {
				await db.execute(sql`update sync_runs set status = 'running' where id = ${existing.id}`);
				await logEvent(existing.id, 'info', 'Rate-limit block cleared by user');
			}
			return json({ ok: true });
		}

		default:
			error(404, `Unknown action ${params.action}`);
	}
};
