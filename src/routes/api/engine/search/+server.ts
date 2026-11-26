import { error, json } from '@sveltejs/kit';
import { searchCatalog } from '$lib/server/engine/search.ts';
import { spotifyFailure } from '$lib/server/spotify/errors.ts';
import type { RequestHandler } from './$types';

/**
 * Spotify's catalog for Deckhand's engine, which serves it to the apps as
 * `/api/catalog/search` with what the music folder already holds marked
 * (`src/lib/server/engine/search.ts`). Unauthenticated like every route here:
 * the host is tailnet-only, and the engine calls it over the stack's network.
 */
export const GET: RequestHandler = async ({ url }) => {
	const q = url.searchParams.get('q')?.trim() ?? '';
	if (!q) error(400, 'Search for something.');
	const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10) || 40;
	try {
		return json(await searchCatalog(q, limit), { headers: { 'cache-control': 'no-store' } });
	} catch (err) {
		const failure = spotifyFailure(err);
		if (failure) return failure;
		throw err;
	}
};
