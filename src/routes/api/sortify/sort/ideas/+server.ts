import { handle, json, minPlays } from '$lib/server/sortify/http.ts';
import { ideas, propose } from '$lib/server/sortify/sort.ts';
import type { RequestHandler } from './$types';

/**
 * GET ?min_plays= — the proposed new playlists, newest first, with their
 * songs, and how many songs fit no playlist well (`leftovers`).
 */
export const GET: RequestHandler = ({ url }) => handle(url, async () => json(await ideas(minPlays(url))));

/**
 * POST ?min_plays= — asks the model to group the most played leftovers into
 * new playlists (one larger request; it can take a couple of minutes), then
 * answers like GET.
 */
export const POST: RequestHandler = ({ url }) =>
	handle(url, async () => {
		const { added } = await propose(minPlays(url));
		return json({ added, ...(await ideas(minPlays(url))) });
	});
