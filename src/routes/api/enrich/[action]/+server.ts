import { error, json } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db/index.ts';
import { getWorkerUtils } from '$lib/server/queue/runner.ts';
import { setSetting } from '$lib/server/settings.ts';
import { ENRICH_JOB_KEY } from '$lib/server/queue/tasks/enrich.ts';
import { PRIORITY_ENRICH } from '$lib/server/queue/constants.ts';
import {
	getCoverage,
	getLimiters,
	getTotals,
	isChainQueued
} from '$lib/server/entities/enrichment.ts';
import type { RequestHandler } from './$types';

/** POST /api/enrich/start|pause|retry-misses|unblock */
export const POST: RequestHandler = async ({ params, request }) => {
	const utils = await getWorkerUtils();

	switch (params.action) {
		case 'start': {
			await setSetting('enrich.enabled', true);
			await utils.addJob(
				'enrich:tick',
				{},
				{ jobKey: ENRICH_JOB_KEY, jobKeyMode: 'replace', priority: PRIORITY_ENRICH }
			);
			return json({ ok: true, queued: true });
		}

		case 'pause': {
			// The running tick finishes its slice — at most half a minute — and
			// then finds the setting off and stops chaining.
			await setSetting('enrich.enabled', false);
			await db.execute(sql`
				delete from graphile_worker._private_jobs where key = ${ENRICH_JOB_KEY}
			`);
			return json({ ok: true, paused: true });
		}

		case 'retry-misses': {
			const body = (await request.json().catch(() => ({}))) as { scope?: string };
			await utils.addJob(
				'enrich:retry-misses',
				{ scope: body.scope ?? 'all' },
				{ jobKey: 'enrich-retry', jobKeyMode: 'replace', priority: PRIORITY_ENRICH }
			);
			return json({ ok: true });
		}

		case 'unblock': {
			// Manual override of a 429/503 penalty. Same caveat as the Spotify
			// one: clearing a block early is how you earn a longer one.
			await db.execute(sql`update external_limiters set blocked_until = null, updated_at = now()`);
			await utils.addJob(
				'enrich:tick',
				{},
				{ jobKey: ENRICH_JOB_KEY, jobKeyMode: 'replace', priority: PRIORITY_ENRICH }
			);
			return json({ ok: true });
		}

		default:
			error(404, `Unknown action ${params.action}`);
	}
};

/** GET /api/enrich/status — polled by the page while the crawl runs. */
export const GET: RequestHandler = async ({ params }) => {
	if (params.action !== 'status') error(404, `Unknown action ${params.action}`);

	const [coverage, totals, limiters, queued] = await Promise.all([
		getCoverage(),
		getTotals(),
		getLimiters(),
		isChainQueued()
	]);
	return json({ coverage, totals, limiters, queued });
};
