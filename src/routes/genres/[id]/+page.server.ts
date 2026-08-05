import { error, fail, redirect } from '@sveltejs/kit';
import {
	addGenres,
	COLLECTION_SORTS,
	deleteCollection,
	genreVocabulary,
	getCollection,
	isSort,
	MAX_TRACKS,
	removeGenre,
	resolveTracks,
	unlinkPlaylist,
	updateCollection
} from '$lib/server/entities/genres.ts';
import { PlaylistScopeError, syncCollection } from '$lib/server/playlists/sync.ts';
import { canWritePlaylists, readAuthState } from '$lib/server/spotify/auth.ts';
import { SpotifyRateLimited } from '$lib/server/spotify/errors.ts';
import { PAGE_SIZE, pageParam, paged, searchParam } from '$lib/server/entities/shared.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, url }) => {
	const collection = await getCollection(params.id);
	if (!collection) error(404, 'No such collection');

	const page = pageParam(url);
	const q = searchParam(url);

	const [rows, genres, auth] = await Promise.all([
		resolveTracks(collection, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, q }),
		genreVocabulary(),
		readAuthState()
	]);

	return {
		collection,
		...paged(rows, page, PAGE_SIZE),
		q,
		genres,
		sorts: Object.keys(COLLECTION_SORTS),
		maxTracks: MAX_TRACKS,
		canWrite: canWritePlaylists(auth?.scope) && !auth?.needsReauth
	};
};

/**
 * Every action ends in a reload of the same page, so the collection and its
 * track list are always read back from the database rather than patched in the
 * browser — the whole point of a collection is that its contents are derived,
 * and a client-side guess at what changed would be a second definition.
 */
export const actions: Actions = {
	addGenre: async ({ params, request }) => {
		const form = await request.formData();
		const genre = String(form.get('genre') ?? '').trim().slice(0, 120);
		if (!genre) return fail(400, { error: 'Type or pick a genre.' });
		await addGenres(params.id, [genre]);
		return { added: genre };
	},

	removeGenre: async ({ params, request }) => {
		const form = await request.formData();
		await removeGenre(params.id, String(form.get('genre') ?? ''));
		return { removed: true };
	},

	settings: async ({ params, request }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim().slice(0, 100);
		const description = String(form.get('description') ?? '').trim().slice(0, 250);
		const match = form.get('match') === 'all' ? 'all' : 'any';
		const sortRaw = String(form.get('sort') ?? 'added');
		const limit = Number(form.get('trackLimit'));

		if (!name) return fail(400, { error: 'A collection needs a name.' });
		if (!Number.isFinite(limit) || limit < 1 || limit > MAX_TRACKS) {
			return fail(400, { error: `Track limit must be between 1 and ${MAX_TRACKS}.` });
		}

		await updateCollection(params.id, {
			name,
			description: description || null,
			match,
			sort: isSort(sortRaw) ? sortRaw : 'added',
			trackLimit: Math.floor(limit),
			autoSync: form.get('autoSync') === 'on',
			playlistPublic: form.get('playlistPublic') === 'on'
		});
		return { saved: true };
	},

	/**
	 * Runs the push inline rather than queueing it: it is a handful of requests,
	 * and somebody who just pressed the button should see the failure — a
	 * missing scope, a rate limit — instead of a job silently retrying.
	 */
	sync: async ({ params }) => {
		try {
			const result = await syncCollection(params.id, { force: true });
			return { sync: result };
		} catch (err) {
			if (err instanceof PlaylistScopeError) return fail(403, { error: err.message });
			if (err instanceof SpotifyRateLimited) {
				return fail(429, {
					error: `Spotify is rate limiting — try again after ${err.until.toLocaleTimeString()}. Auto-sync will pick it up on its own.`
				});
			}
			return fail(502, { error: err instanceof Error ? err.message : String(err) });
		}
	},

	unlink: async ({ params }) => {
		await unlinkPlaylist(params.id);
		return { unlinked: true };
	},

	delete: async ({ params }) => {
		await deleteCollection(params.id);
		redirect(303, '/genres');
	}
};
