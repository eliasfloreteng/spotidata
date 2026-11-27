import { json } from '@sveltejs/kit';
import { readQueue } from '$lib/server/engine/queue.ts';
import type { RequestHandler } from './$types';

/** The engine's queue as the downloads page shows it, for the page to follow while it runs. */
export const GET: RequestHandler = async () =>
	json(await readQueue(), { headers: { 'cache-control': 'no-store' } });
