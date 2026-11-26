import { cardSuggestions, clearCards } from '$lib/server/sortify/ai.ts';
import { apiError, body, handle, json, strings } from '$lib/server/sortify/http.ts';
import type { RequestHandler } from './$types';

/**
 * POST {tracks: [track id]} — the feed card's suggestions for these tracks:
 * `{<track id>: {playlists: [id], ideas: [name]}}`. Cached ones answer at
 * once; the rest wait for the model, ten songs a request.
 */
export const POST: RequestHandler = ({ url, request }) =>
	handle(url, async () => {
		const tracks = strings((await body<{ tracks?: unknown }>(request)).tracks);
		if (tracks.length === 0) return apiError(400, 'invalid', 'Name at least one track.');
		return json(await cardSuggestions(tracks));
	});

/** DELETE — forgets every card suggestion. */
export const DELETE: RequestHandler = ({ url }) =>
	handle(url, async () => {
		await clearCards();
		return new Response(null, { status: 204 });
	});
