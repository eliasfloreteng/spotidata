import { error } from '@sveltejs/kit';
import { removeDownload } from '$lib/server/engine/client.ts';
import { engineRoute } from '$lib/server/engine/http.ts';
import type { RequestHandler } from './$types';

/** Stops a download under way, or forgets a finished one. The file, if any, stays. */
export const DELETE: RequestHandler = async ({ params }) => {
	if (!/^\d+$/.test(params.id)) error(400, 'Not a download id.');
	return engineRoute(async () => {
		await removeDownload(Number(params.id));
		return new Response(null, { status: 204 });
	});
};
