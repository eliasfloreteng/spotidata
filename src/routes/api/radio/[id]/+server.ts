import { error, json } from '@sveltejs/kit';
import { radioFailure, songRadio } from '$lib/server/entities/radio.ts';
import type { RequestHandler } from './$types';

/**
 * A track's Spotify radio, by the track's Spotify id: the radio playlist's id,
 * name and cover, and its tracks in order with ISRCs and what the library
 * holds of each (see `src/lib/server/entities/radio.ts`).
 */
export const GET: RequestHandler = async ({ params }) => {
	if (!/^[A-Za-z0-9]{22}$/.test(params.id)) error(400, 'Not a track id.');
	try {
		const radio = await songRadio(params.id);
		if (!radio) error(404, 'Spotify has no radio for that track.');
		return json(radio, { headers: { 'cache-control': 'no-store' } });
	} catch (err) {
		const failure = radioFailure(err);
		if (!failure) throw err;
		const headers: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8' };
		if (failure.retryAfterSeconds) headers['retry-after'] = String(failure.retryAfterSeconds);
		return new Response(failure.message, { status: failure.status, headers });
	}
};
