import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Listening used to have a page of its own; it is now half of the overview,
 * under the same range picker. Old links and bookmarks keep their range.
 */
export const load: PageServerLoad = ({ url }) => {
	redirect(308, `/${url.search}`);
};
