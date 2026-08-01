import { libraryRecordings, LIBRARY_SORTS } from '$lib/server/entities/lists.ts';
import { PAGE_SIZE, pageParam, paged, searchParam, sortParam } from '$lib/server/entities/shared.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const page = pageParam(url);
	const q = searchParam(url);
	const sort = sortParam(url, LIBRARY_SORTS, 'added', 'desc');

	const rows = await libraryRecordings({
		order: sort.clause,
		limit: PAGE_SIZE,
		offset: (page - 1) * PAGE_SIZE,
		q
	});

	return { ...paged(rows, page, PAGE_SIZE), q, sort: sort.key, dir: sort.dir };
};
