import { ARTIST_FILTERS, filterParams } from '$lib/filters.ts';
import { ARTIST_SORTS, artistIndex, libraryGenres } from '$lib/server/entities/lists.ts';
import {
	INDEX_PAGE_SIZE,
	pageParam,
	paged,
	searchParam,
	sortParam
} from '$lib/server/entities/shared.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const page = pageParam(url);
	const q = searchParam(url);
	const sort = sortParam(url, ARTIST_SORTS, 'tracks', 'desc');
	const filters = filterParams(url, ARTIST_FILTERS);
	const genre = (url.searchParams.get('genre') ?? '').trim().slice(0, 120);

	const [rows, genres] = await Promise.all([
		artistIndex({
			order: sort.clause,
			limit: INDEX_PAGE_SIZE,
			offset: (page - 1) * INDEX_PAGE_SIZE,
			q,
			genre,
			filters
		}),
		libraryGenres()
	]);

	return { ...paged(rows, page, INDEX_PAGE_SIZE), q, sort: sort.key, dir: sort.dir, filters, genre, genres };
};
