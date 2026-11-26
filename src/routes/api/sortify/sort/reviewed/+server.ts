import { handle } from '$lib/server/sortify/http.ts';
import { resetReviewed } from '$lib/server/sortify/sort.ts';
import type { RequestHandler } from './$types';

/** DELETE — brings every reviewed song back into the queue. Turned-down suggestions stay turned down. */
export const DELETE: RequestHandler = ({ url }) =>
	handle(url, async () => {
		await resetReviewed();
		return new Response(null, { status: 204 });
	});
