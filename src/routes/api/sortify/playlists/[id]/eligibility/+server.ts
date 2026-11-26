import { setEligibility } from '$lib/server/sortify/catalog.ts';
import { apiError, body, handle, json } from '$lib/server/sortify/http.ts';
import type { RequestHandler } from './$types';

/**
 * PUT {eligible: boolean} — sort into this playlist or not. Stored only where
 * it differs from the default; answers with the playlist as the catalog lists it.
 */
export const PUT: RequestHandler = ({ url, request, params }) =>
	handle(url, async () => {
		const input = await body<{ eligible?: unknown }>(request);
		if (typeof input.eligible !== 'boolean') return apiError(400, 'invalid', 'eligible must be true or false.');
		try {
			const playlist = await setEligibility(params.id, input.eligible);
			return playlist ? json(playlist) : apiError(404, 'not_found', 'No such playlist.');
		} catch (err) {
			return apiError(400, 'invalid', err instanceof Error ? err.message : String(err));
		}
	});
