import { forgetVerdicts } from '$lib/server/sortify/ai.ts';
import { handle } from '$lib/server/sortify/http.ts';
import type { RequestHandler } from './$types';

/** DELETE — forgets every verdict the model gave, so the next page is asked afresh. */
export const DELETE: RequestHandler = ({ url }) =>
	handle(url, async () => {
		await forgetVerdicts();
		return new Response(null, { status: 204 });
	});
