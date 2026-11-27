import { filterParams, LIBRARY_FILTERS } from '$lib/filters.ts';
import { libraryComposition, libraryRecordings, LIBRARY_SORTS } from '$lib/server/entities/lists.ts';
import { PAGE_SIZE, pageParam, paged, searchParam, sortParam } from '$lib/server/entities/shared.ts';
import { statusesFor } from '$lib/server/engine/downloads.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const page = pageParam(url);
	const q = searchParam(url);
	const sort = sortParam(url, LIBRARY_SORTS, 'added', 'desc');
	const filters = filterParams(url, LIBRARY_FILTERS);

	const [rows, composition] = await Promise.all([
		libraryRecordings({
			order: sort.clause,
			limit: PAGE_SIZE,
			offset: (page - 1) * PAGE_SIZE,
			q,
			filters
		}),
		libraryComposition()
	]);

	return {
		...paged(rows, page, PAGE_SIZE),
		downloads: await statusesFor(rows.map((r) => ({ id: r.representativeTrackId }))),
		composition,
		q,
		sort: sort.key,
		dir: sort.dir,
		filters
	};
};
