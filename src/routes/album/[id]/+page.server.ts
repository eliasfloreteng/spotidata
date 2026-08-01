import { error } from '@sveltejs/kit';
import { getAlbum, getAlbumEditions, getAlbumTracks } from '$lib/server/entities/album.ts';
import { ensureEntity } from '$lib/server/ingest/ensure.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const id = params.id;

	// ensureEntity does its own freshness check and returns immediately for a
	// row that is already full and recent, so this is the whole staleness
	// policy — one indexed lookup on the hot path.
	const state = await ensureEntity('album', id);

	const album = await getAlbum(id);
	if (!album) {
		if (state.missing) error(404, 'Spotify has no album with that id.');
		return { pending: true as const, id };
	}

	const [tracks, editions] = await Promise.all([getAlbumTracks(id), getAlbumEditions(id)]);
	return { pending: false as const, id, album, tracks, editions, refreshing: state.pending };
};
