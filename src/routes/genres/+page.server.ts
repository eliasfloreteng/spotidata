import { fail, redirect } from '@sveltejs/kit';
import {
	addGenres,
	createCollection,
	genreCoverage,
	genreVocabulary,
	listCollections,
	resolveTracks
} from '$lib/server/entities/genres.ts';
import { canWritePlaylists, readAuthState } from '$lib/server/spotify/auth.ts';
import type { Actions, PageServerLoad } from './$types';

/** The explorer previews a genre, it does not page through it — the collection does that. */
const PREVIEW_TRACKS = 25;

export const load: PageServerLoad = async ({ url }) => {
	const explore = (url.searchParams.get('g') ?? '').trim().slice(0, 120);

	const [collections, genres, coverage, auth, preview] = await Promise.all([
		listCollections(),
		genreVocabulary(),
		genreCoverage(),
		readAuthState(),
		explore
			? resolveTracks(
					{ genres: [explore], match: 'any', sort: 'plays' },
					{ limit: PREVIEW_TRACKS, offset: 0 }
				)
			: Promise.resolve([])
	]);

	return {
		collections,
		genres,
		coverage,
		explore,
		preview,
		canWrite: canWritePlaylists(auth?.scope) && !auth?.needsReauth
	};
};

export const actions: Actions = {
	/** New collection, optionally seeded with the genre you were looking at. */
	create: async ({ request }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim().slice(0, 100);
		const seed = String(form.get('genre') ?? '').trim();
		if (!name) return fail(400, { error: 'Give the collection a name.' });

		const id = await createCollection(name, seed ? [seed] : []);
		redirect(303, `/genres/${id}`);
	},

	/** Add the genre being explored to an existing collection, from the explorer. */
	add: async ({ request }) => {
		const form = await request.formData();
		const id = String(form.get('collection') ?? '');
		const genre = String(form.get('genre') ?? '').trim();
		if (!id || !genre) return fail(400, { error: 'Pick a collection.' });

		await addGenres(id, [genre]);
		redirect(303, `/genres/${id}`);
	}
};
