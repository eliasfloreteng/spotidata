import { error, json } from '@sveltejs/kit';
import { MAX_QUEUE, queueTracks } from '$lib/server/engine/downloads.ts';
import { engineRoute, jsonBody } from '$lib/server/engine/http.ts';
import type { RequestHandler } from './$types';

const TRACK_ID = /^[A-Za-z0-9]{22}$/;

/**
 * `{tracks: [spotify id]}`: has Deckhand's engine download them into the music
 * folder, leaving out what it holds or is getting already. Answers how many
 * were queued and where each track now stands.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await jsonBody(request)) as { tracks?: unknown } | null;
	const tracks = body?.tracks;
	if (!Array.isArray(tracks) || tracks.length === 0 || !tracks.every((t) => typeof t === 'string' && TRACK_ID.test(t))) {
		error(400, 'Expected {tracks: [Spotify track id, …]}.');
	}
	if (tracks.length > MAX_QUEUE) error(400, `At most ${MAX_QUEUE} tracks at once.`);
	return engineRoute(async () => json(await queueTracks(tracks as string[]), { headers: { 'cache-control': 'no-store' } }));
};
