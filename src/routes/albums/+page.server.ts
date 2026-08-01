import { ALBUM_FILTERS, filterParams } from '$lib/filters.ts';
import { ALBUM_SORTS, albumIndex } from '$lib/server/entities/lists.ts';
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
	const sort = sortParam(url, ALBUM_SORTS, 'tracks', 'desc');
	const filters = filterParams(url, ALBUM_FILTERS);

	const rows = await albumIndex({
		order: sort.clause,
		limit: INDEX_PAGE_SIZE,
		offset: (page - 1) * INDEX_PAGE_SIZE,
		q,
		filters
	});

	return { ...paged(rows, page, INDEX_PAGE_SIZE), q, sort: sort.key, dir: sort.dir, filters };
};
