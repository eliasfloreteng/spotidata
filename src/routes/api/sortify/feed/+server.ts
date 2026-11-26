import { apiError, bigJson, handle } from '$lib/server/sortify/http.ts';
import { feedJson, parseSource, playlistExists } from '$lib/server/sortify/tracks.ts';
import type { RequestHandler } from './$types';

/**
 * GET ?source=unsorted|liked|playlist:<id> — the songs to go through, as an
 * array of tracks (see `SortifyTrack`). `unsorted`, the default, is the liked
 * songs in no eligible playlist, newest first. Gzipped and ETagged: the liked
 * songs run to megabytes.
 */
export const GET: RequestHandler = ({ url, request }) =>
	handle(url, async () => {
		const source = parseSource(url.searchParams.get('source'));
		if (!source) return apiError(400, 'invalid', 'source is unsorted, liked or playlist:<id>.');
		if (source.kind === 'playlist' && !(await playlistExists(source.id))) {
			return apiError(404, 'not_found', 'No such playlist in the archive.');
		}
		return bigJson(request, await feedJson(source));
	});
