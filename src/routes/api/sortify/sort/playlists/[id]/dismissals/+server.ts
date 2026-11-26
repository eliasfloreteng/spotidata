import { apiError, body, handle } from '$lib/server/sortify/http.ts';
import { dismiss } from '$lib/server/sortify/sort.ts';
import type { RequestHandler } from './$types';

/** POST {song} — "not here": this song is never suggested for this playlist again. */
export const POST: RequestHandler = ({ url, request, params }) =>
	handle(url, async () => {
		const { song } = await body<{ song?: unknown }>(request);
		if (typeof song !== 'string' || !song) return apiError(400, 'invalid', 'Name the song.');
		await dismiss(song, params.id);
		return new Response(null, { status: 204 });
	});
