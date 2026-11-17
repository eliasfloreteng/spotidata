import { json } from '@sveltejs/kit';
import { liveFailure, livePlaylists } from '$lib/server/export/live-playlists.ts';
import type { RequestHandler } from './$types';

/**
 * The account's playlists, live from Spotify, with each one's `snapshot_id`
 * (see `src/lib/server/export/live-playlists.ts`). Read-only and
 * unauthenticated like every other route here: the host is tailnet-only.
 */
export const GET: RequestHandler = async () => {
	try {
		return json(await livePlaylists(), { headers: { 'cache-control': 'no-store' } });
	} catch (err) {
		const failure = liveFailure(err);
		if (failure) return failure;
		throw err;
	}
};
