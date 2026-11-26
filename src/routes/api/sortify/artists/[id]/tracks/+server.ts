import { handle, json } from '$lib/server/sortify/http.ts';
import { parseSource, tracksByArtist } from '$lib/server/sortify/tracks.ts';
import type { RequestHandler } from './$types';

/**
 * GET ?source=… — every song by this artist that bulk sorting reaches: the
 * liked songs, plus the playlist being gone through when `source` names one.
 */
export const GET: RequestHandler = ({ url, params }) =>
	handle(url, async () => json(await tracksByArtist(params.id, parseSource(url.searchParams.get('source')))));
