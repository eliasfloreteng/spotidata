import { apiError, body, handle, json, minPlays, strings } from '$lib/server/sortify/http.ts';
import { judge } from '$lib/server/sortify/sort.ts';
import type { RequestHandler } from './$types';

/**
 * POST {songs: [song key]} — asks the model about the songs it has not seen
 * (one request for the lot, at most sixteen) and answers with them as the queue
 * would show them now. Waits for the model; songs already asked come straight back.
 */
export const POST: RequestHandler = ({ url, request }) =>
	handle(url, async () => {
		const songs = strings((await body<{ songs?: unknown }>(request)).songs);
		if (songs.length === 0) return apiError(400, 'invalid', 'Name at least one song.');
		return json(await judge(songs, minPlays(url)));
	});
