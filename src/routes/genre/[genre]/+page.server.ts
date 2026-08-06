import { error, fail, redirect } from '@sveltejs/kit';
import {
	addGenres,
	createCollection,
	genreArtists,
	genreCoverage,
	genreSummary,
	isSort,
	listCollections,
	relatedGenres,
	resolveTracks
} from '$lib/server/entities/genres.ts';
import { PAGE_SIZE, pageParam, paged, searchParam } from '$lib/server/entities/shared.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * One genre, as a place rather than a filter.
 *
 * The track list is `resolveTracks` with a single-genre "any" spec — the same
 * function a collection resolves through, so what this page shows and what a
 * playlist built from this genre would contain can never drift apart.
 */
export const load: PageServerLoad = async ({ params, url }) => {
	const genre = params.genre.trim();
	if (!genre) error(404, 'No such genre');

	const summary = await genreSummary(genre);
	if (!summary) error(404, `MusicBrainz has never tagged anything here “${genre}”`);

	const sortRaw = url.searchParams.get('sort') ?? 'plays';
	const sort = isSort(sortRaw) ? sortRaw : 'plays';
	const page = pageParam(url);
	const q = searchParam(url);

	const [rows, related, artists, collections, coverage] = await Promise.all([
		resolveTracks(
			{ genres: [genre], match: 'any', sort },
			{ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, q }
		),
		relatedGenres(genre),
		genreArtists(genre),
		listCollections(),
		genreCoverage()
	]);

	return {
		genre,
		summary,
		...paged(rows, page, PAGE_SIZE),
		q,
		sort,
		related,
		artists,
		collections,
		libraryTracks: coverage.library
	};
};

export const actions: Actions = {
	/** Straight from the genre to a playlist, without a detour through the explorer. */
	create: async ({ params, request }) => {
		const form = await request.formData();
		const name =
			String(form.get('name') ?? '')
				.trim()
				.slice(0, 100) || params.genre;
		const id = await createCollection(name, [params.genre]);
		redirect(303, `/genres/${id}`);
	},

	add: async ({ params, request }) => {
		const form = await request.formData();
		const id = String(form.get('collection') ?? '');
		if (!id) return fail(400, { error: 'Pick a collection.' });
		await addGenres(id, [params.genre]);
		redirect(303, `/genres/${id}`);
	}
};
