import { error, json, text } from '@sveltejs/kit';
import { fetchPlaylist } from '$lib/server/engine/playlists.ts';
import type { RequestHandler } from './$types';

/**
 * Has a playlist fetched into the tables (any one Spotify shows this app), for
 * one Deckhand keeps by its link: `{state: "ready" | "pending"}`, or 404 when
 * Spotify will not show it.
 */
export const PUT: RequestHandler = async ({ params }) => {
	if (!/^[A-Za-z0-9]{1,40}$/.test(params.id)) error(400, 'Not a playlist id.');
	const state = await fetchPlaylist(params.id);
	if (state === 'missing') return text('Spotify will not show this playlist to this app.', { status: 404 });
	return json({ state }, { headers: { 'cache-control': 'no-store' } });
};
