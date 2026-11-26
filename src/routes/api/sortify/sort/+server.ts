import { handle, json, minPlays, strings } from '$lib/server/sortify/http.ts';
import { queue } from '$lib/server/sortify/sort.ts';
import type { RequestHandler } from './$types';

/**
 * GET ?min_plays=2&limit=16&exclude=<song>,… — the sort queue: liked songs
 * played at least `min_plays` times that the user has not been through, the
 * most played and most left out first, each with its suggested playlists
 * (`selected` is what to tick). The counts are over the whole queue.
 */
export const GET: RequestHandler = ({ url }) =>
	handle(url, async () => {
		const limit = Math.min(64, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '16', 10) || 16));
		const exclude = strings((url.searchParams.get('exclude') ?? '').split(','));
		return json(await queue(minPlays(url), limit, exclude));
	});
