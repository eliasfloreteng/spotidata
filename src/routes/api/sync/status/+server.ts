import { json } from '@sveltejs/kit';
import { getSyncStatus } from '$lib/server/queue/status.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const runId = url.searchParams.get('runId');
	const status = await getSyncStatus(runId ? Number(runId) : undefined);
	return json(status, { headers: { 'cache-control': 'no-store' } });
};
