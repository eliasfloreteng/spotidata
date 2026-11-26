import { error } from '@sveltejs/kit';
import {
	getArtist,
	getArtistAlbums,
	getArtistStats,
	getArtistTopTracks
} from '$lib/server/entities/artist.ts';
import { artistPlaySummary, artistTopPlayed } from '$lib/server/entities/play-stats.ts';
import { ensureEntity } from '$lib/server/ingest/ensure.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const id = params.id;

	const state = await ensureEntity('artist', id);

	const artist = await getArtist(id);
	if (!artist) {
		if (state.missing) error(404, 'Spotify has no artist with that id.');
		return { pending: true as const, id };
	}

	const [stats, albums, topTracks, plays, topPlayed] = await Promise.all([
		getArtistStats(id),
		getArtistAlbums(id),
		getArtistTopTracks(id, 20),
		artistPlaySummary(id),
		artistTopPlayed(id, 12)
	]);

	return {
		pending: false as const,
		id,
		artist,
		stats,
		albums,
		topTracks,
		plays,
		topPlayed,
		refreshing: state.pending
	};
};
