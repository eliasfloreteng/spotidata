import { error, json } from '@sveltejs/kit';
import { retryDownload } from '$lib/server/engine/client.ts';
import { engineRoute } from '$lib/server/engine/http.ts';
import type { RequestHandler } from './$types';

/** Puts a failed, stopped or waiting download back in the queue. */
export const POST: RequestHandler = async ({ params }) => {
	if (!/^\d+$/.test(params.id)) error(400, 'Not a download id.');
	return engineRoute(async () => json(await retryDownload(Number(params.id))));
};
