import { error } from '@sveltejs/kit';
import { getPlaylist, getPlaylistItems } from '$lib/server/entities/playlist.ts';
import { ensureEntity } from '$lib/server/ingest/ensure.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const id = params.id;

	const state = await ensureEntity('playlist', id);

	const playlist = await getPlaylist(id);
	if (!playlist) {
		if (state.missing) error(404, 'Spotify has no playlist with that id.');
		return { pending: true as const, id };
	}

	const items = await getPlaylistItems(id);
	return { pending: false as const, id, playlist, items, refreshing: state.pending };
};
