import { error, json } from '@sveltejs/kit';
import { liveFailure, livePlaylist } from '$lib/server/export/live-playlists.ts';
import type { RequestHandler } from './$types';

/**
 * One playlist's name, owner, cover, size and `snapshot_id`, live from
 * Spotify, without its tracks: any playlist Spotify shows this app.
 */
export const GET: RequestHandler = async ({ params }) => {
	if (!/^[A-Za-z0-9]{10,40}$/.test(params.id)) error(400, 'Not a playlist id.');
	try {
		return json(await livePlaylist(params.id), { headers: { 'cache-control': 'no-store' } });
	} catch (err) {
		const failure = liveFailure(err);
		if (failure) return failure;
		throw err;
	}
};
