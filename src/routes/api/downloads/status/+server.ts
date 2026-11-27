import { error, json } from '@sveltejs/kit';
import { statusesFor } from '$lib/server/engine/downloads.ts';
import { jsonBody } from '$lib/server/engine/http.ts';
import type { TrackRef } from '$lib/downloads.ts';
import type { RequestHandler } from './$types';

/**
 * `{tracks: [{id, isrc?}]}`: where each track stands with the engine, for the
 * download buttons to look again while something is under way. A POST because
 * a playlist's worth of ids does not fit a URL.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await jsonBody(request)) as { tracks?: unknown } | null;
	const tracks = body?.tracks;
	const valid = (t: unknown): t is TrackRef =>
		typeof t === 'object' &&
		t !== null &&
		typeof (t as TrackRef).id === 'string' &&
		((t as TrackRef).isrc == null || typeof (t as TrackRef).isrc === 'string');
	if (!Array.isArray(tracks) || tracks.length > 5000 || !tracks.every(valid)) {
		error(400, 'Expected {tracks: [{id, isrc?}, …]}.');
	}
	return json(await statusesFor(tracks), { headers: { 'cache-control': 'no-store' } });
};
