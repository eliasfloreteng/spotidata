import { overview } from '$lib/server/stats/overview.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, locals, setHeaders }) => {
	setHeaders({ 'cache-control': 'private, max-age=0, must-revalidate' });
	return overview(url, locals.settings);
};
