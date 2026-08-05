import {
	genreSelection,
	genreTracks,
	genreVocabulary,
	MAX_LINKS
} from '$lib/server/entities/genres.ts';
import { PAGE_SIZE, pageParam, paged } from '$lib/server/entities/shared.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const page = pageParam(url);
	const sel = genreSelection(url);

	// The vocabulary is asked for even with nothing selected — it *is* the page
	// until something is.
	const [genres, rows] = await Promise.all([
		genreVocabulary(sel.filters.src),
		genreTracks(sel, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })
	]);

	return {
		...paged(rows, page, PAGE_SIZE),
		genres,
		selected: sel.genres,
		q: sel.q,
		sort: sel.sort,
		dir: sel.dir,
		filters: sel.filters,
		maxLinks: MAX_LINKS
	};
};
