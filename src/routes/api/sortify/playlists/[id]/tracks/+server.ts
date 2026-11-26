import { apiError, body, handle, json, strings } from '$lib/server/sortify/http.ts';
import { addTracks, removeTracks } from '$lib/server/sortify/writes.ts';
import type { RequestHandler } from './$types';

async function trackIds(request: Request): Promise<string[]> {
	return strings((await body<{ tracks?: unknown }>(request)).tracks).slice(0, 2000);
}

/**
 * POST {tracks: [track id]} — adds the songs whose recording is not in the
 * playlist yet. Answers with the track ids sent to Spotify and each
 * recording's owned playlists now, so the app can update without refetching.
 */
export const POST: RequestHandler = ({ url, request, params }) =>
	handle(url, async () => {
		const tracks = await trackIds(request);
		if (tracks.length === 0) return apiError(400, 'invalid', 'Name at least one track.');
		return json(await addTracks(params.id, tracks));
	});

/** DELETE {tracks: [track id]} — removes every copy of these recordings from the playlist. */
export const DELETE: RequestHandler = ({ url, request, params }) =>
	handle(url, async () => {
		const tracks = await trackIds(request);
		if (tracks.length === 0) return apiError(400, 'invalid', 'Name at least one track.');
		return json(await removeTracks(params.id, tracks));
	});
