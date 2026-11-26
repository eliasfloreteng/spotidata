import { apiError, handle } from '$lib/server/sortify/http.ts';
import { deleteIdea } from '$lib/server/sortify/sort.ts';
import type { RequestHandler } from './$types';

/** DELETE — dismisses a proposed playlist. */
export const DELETE: RequestHandler = ({ url, params }) =>
	handle(url, async () =>
		(await deleteIdea(params.id)) ? new Response(null, { status: 204 }) : apiError(404, 'not_found', 'No such idea.')
	);
