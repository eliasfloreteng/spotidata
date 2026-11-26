import { apiError, handle, json, minPlays } from '$lib/server/sortify/http.ts';
import { fill } from '$lib/server/sortify/sort.ts';
import type { RequestHandler } from './$types';

/**
 * GET ?min_plays= — the best songs for one playlist, reviewed ones included,
 * since a playlist fills up long after its songs went by. `ticked` is set only
 * where the model confirmed a strong fit.
 */
export const GET: RequestHandler = ({ url, params }) =>
	handle(url, async () => {
		const body = await fill(params.id, minPlays(url));
		return body ? json(body) : apiError(404, 'not_found', 'Not a playlist Sortify sorts into.');
	});
