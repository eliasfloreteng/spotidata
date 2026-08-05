import { error } from '@sveltejs/kit';
import { getAlbum, getAlbumEditions, getAlbumTracks } from '$lib/server/entities/album.ts';
import { albumPlaySummary } from '$lib/server/entities/play-stats.ts';
import { ensureEntity } from '$lib/server/ingest/ensure.ts';
import { getAlbumEnrichment } from '$lib/server/entities/enrichment.ts';
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

	const [tracks, editions, plays, enrichment] = await Promise.all([
		getAlbumTracks(id),
		getAlbumEditions(id),
		albumPlaySummary(id),
		getAlbumEnrichment(id)
	]);
	return {
		pending: false as const,
		id,
		album,
		tracks,
		editions,
		plays,
		enrichment,
		refreshing: state.pending
	};
};
