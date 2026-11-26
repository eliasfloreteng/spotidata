import { apiError, handle, json, minPlays } from '$lib/server/sortify/http.ts';
import { judgePlaylistCandidates } from '$lib/server/sortify/sort.ts';
import type { RequestHandler } from './$types';

/**
 * POST — has the model judge up to thirty candidates it has not judged for
 * this playlist, with two dozen of the playlist's own songs as context; answers
 * like GET on the playlist.
 */
export const POST: RequestHandler = ({ url, params }) =>
	handle(url, async () => {
		const body = await judgePlaylistCandidates(params.id, minPlays(url));
		return body ? json(body) : apiError(404, 'not_found', 'Not a playlist Sortify sorts into.');
	});
