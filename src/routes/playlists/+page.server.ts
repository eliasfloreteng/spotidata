import { filterParams, PLAYLIST_FILTERS } from '$lib/filters.ts';
import { PLAYLIST_SORTS, playlistIndex } from '$lib/server/entities/lists.ts';
import {
	INDEX_PAGE_SIZE,
	pageParam,
	paged,
	searchParam,
	sortParam
} from '$lib/server/entities/shared.ts';
import { keptPlaylists } from '$lib/server/engine/downloads.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const page = pageParam(url);
	const q = searchParam(url);
	const sort = sortParam(url, PLAYLIST_SORTS, 'tracks', 'desc');
	const filters = filterParams(url, PLAYLIST_FILTERS);

	const rows = await playlistIndex({
		order: sort.clause,
		limit: INDEX_PAGE_SIZE,
		offset: (page - 1) * INDEX_PAGE_SIZE,
		q,
		filters
	});

	const keeping = await keptPlaylists(rows.map((r) => r.id));
	const kept = rows.filter((r) => keeping[r.id]?.kept).map((r) => r.id);

	return { ...paged(rows, page, INDEX_PAGE_SIZE), kept, q, sort: sort.key, dir: sort.dir, filters };
};
