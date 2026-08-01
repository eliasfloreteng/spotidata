import { artistIndex } from '$lib/server/entities/lists.ts';
import {
	INDEX_PAGE_SIZE,
	pageParam,
	paged,
	searchParam
} from '$lib/server/entities/shared.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const page = pageParam(url);
	const q = searchParam(url);
	const rows = await artistIndex({
		limit: INDEX_PAGE_SIZE,
		offset: (page - 1) * INDEX_PAGE_SIZE,
		q
	});
	return { ...paged(rows, page, INDEX_PAGE_SIZE), q };
};
