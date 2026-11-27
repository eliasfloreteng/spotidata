import { error } from '@sveltejs/kit';
import { getPlaylist, getPlaylistItems } from '$lib/server/entities/playlist.ts';
import { playlistPlaySummary } from '$lib/server/entities/play-stats.ts';
import { ensureEntity } from '$lib/server/ingest/ensure.ts';
import { keptPlaylists, statusesFor } from '$lib/server/engine/downloads.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const id = params.id;

	const state = await ensureEntity('playlist', id);

	const playlist = await getPlaylist(id);
	if (!playlist) {
		if (state.missing) error(404, 'Spotify has no playlist with that id.');
		return { pending: true as const, id };
	}

	const [items, plays, kept] = await Promise.all([
		getPlaylistItems(id),
		playlistPlaySummary(id),
		keptPlaylists([id])
	]);
	const tracks = [...new Set(items.flatMap((it) => (it.trackId && !it.isLocal ? [it.trackId] : [])))];
	return {
		pending: false as const,
		id,
		playlist,
		items,
		plays,
		downloads: await statusesFor(tracks.map((t) => ({ id: t }))),
		keeping: kept[id] ?? { kept: false, file: null, error: null },
		refreshing: state.pending
	};
};
