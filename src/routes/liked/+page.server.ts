import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Params the library list reads the same way the liked list did. */
const CARRIED = ['q', 'sort', 'dir', 'copies', 'explicit'];

/**
 * Liked songs used to be a list of their own, one row per liked track id.
 * They are now the library filtered to `source=liked`: the same recordings,
 * with a liked single and album cut of one song as one row with two copies.
 */
export const load: PageServerLoad = ({ url }) => {
	const to = new URLSearchParams({ source: 'liked' });
	for (const key of CARRIED) {
		const value = url.searchParams.get(key);
		if (value) to.set(key, value);
	}
	redirect(308, `/library?${to}`);
};
