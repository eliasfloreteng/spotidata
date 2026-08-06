import { fail, redirect } from '@sveltejs/kit';
import {
	addGenres,
	createCollection,
	genreCoverage,
	genreVocabulary,
	listCollections,
	resolveTracks,
	selectionStats,
	updateCollection
} from '$lib/server/entities/genres.ts';
import { canWritePlaylists, readAuthState } from '$lib/server/spotify/auth.ts';
import type { Actions, PageServerLoad } from './$types';

/** The explorer previews a set, it does not page through it — the collection does that. */
const PREVIEW_TRACKS = 20;

/**
 * A ceiling on the staged set, not on a collection.
 *
 * The query string is the right place for a selection being *assembled* — it
 * makes every toggle a link and every count a plain load — and the wrong place
 * for one being *kept*, which is why a saved collection stores its genres in
 * Postgres. Twenty-four is comfortably below where a URL starts to hurt and far
 * past any set somebody assembles by hand in one sitting.
 */
const MAX_STAGED = 24;

/** The staged genres, deduplicated, in the order they were picked. */
function stagedGenres(url: URL): string[] {
	const picked = new Set<string>();
	for (const raw of url.searchParams.getAll('g')) {
		const genre = raw.trim().slice(0, 120);
		if (genre) picked.add(genre);
		if (picked.size >= MAX_STAGED) break;
	}
	return [...picked];
}

const matchOf = (url: URL): 'any' | 'all' => (url.searchParams.get('m') === 'all' ? 'all' : 'any');

export const load: PageServerLoad = async ({ url }) => {
	const genres = stagedGenres(url);
	const match = matchOf(url);
	const spec = { genres, match, sort: 'plays' as const };

	const [collections, vocabulary, coverage, auth, stats, preview] = await Promise.all([
		listCollections(),
		genreVocabulary(),
		genreCoverage(),
		readAuthState(),
		selectionStats(spec),
		genres.length ? resolveTracks(spec, { limit: PREVIEW_TRACKS, offset: 0 }) : []
	]);

	return {
		collections,
		genres: vocabulary,
		coverage,
		selected: genres,
		match,
		stats,
		preview,
		previewLimit: PREVIEW_TRACKS,
		canWrite: canWritePlaylists(auth?.scope) && !auth?.needsReauth
	};
};

/** Both actions land on the collection: it is what the staged set was for. */
export const actions: Actions = {
	create: async ({ request }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '')
			.trim()
			.slice(0, 100);
		const genres = form.getAll('genre').map((g) => String(g).trim()).filter(Boolean);
		if (!name) return fail(400, { error: 'Give the collection a name.' });

		const id = await createCollection(name, genres);
		if (form.get('match') === 'all') await updateCollection(id, { match: 'all' });
		redirect(303, `/genres/${id}`);
	},

	add: async ({ request }) => {
		const form = await request.formData();
		const id = String(form.get('collection') ?? '');
		const genres = form.getAll('genre').map((g) => String(g).trim()).filter(Boolean);
		if (!id || genres.length === 0) return fail(400, { error: 'Pick a collection.' });

		await addGenres(id, genres);
		redirect(303, `/genres/${id}`);
	}
};
