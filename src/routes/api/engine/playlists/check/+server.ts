import { error, json } from '@sveltejs/kit';
import { checkPlaylists } from '$lib/server/engine/playlists.ts';
import { spotifyFailure } from '$lib/server/spotify/errors.ts';
import type { RequestHandler } from './$types';

const ID = /^[A-Za-z0-9]{1,40}$/;

/**
 * The check of the playlists Deckhand keeps (`src/lib/server/engine/playlists.ts`):
 * `{ids, force}` in, what became of each out. The engine calls it every ten
 * minutes and when the app asks.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as { ids?: unknown; force?: unknown } | null;
	const ids = Array.isArray(body?.ids) ? body.ids.map(String) : null;
	const force = Array.isArray(body?.force) ? body.force.map(String) : [];
	if (!ids || ![...ids, ...force].every((id) => ID.test(id))) error(400, 'Send {"ids": [playlist ids]}.');
	try {
		return json({ playlists: await checkPlaylists(ids, force) }, { headers: { 'cache-control': 'no-store' } });
	} catch (err) {
		const failure = spotifyFailure(err);
		if (failure) return failure;
		throw err;
	}
};
