import { playLog } from '$lib/server/stats/plays.ts';
import { resolveRange, zonedDay } from '$lib/server/stats/range.ts';
import { PAGE_SIZE, pageParam, paged, searchParam } from '$lib/server/entities/shared.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, locals }) => {
	const range = await resolveRange(url, locals.settings['ui.timezone'], 'history');
	const page = pageParam(url);
	const q = searchParam(url);

	const rows = await playLog(range, {
		limit: PAGE_SIZE,
		offset: (page - 1) * PAGE_SIZE,
		q
	});

	return {
		...paged(rows, page, PAGE_SIZE),
		q,
		range: {
			preset: range.preset,
			days: {
				from: zonedDay(range.from, range.tz),
				to: zonedDay(new Date(range.to.getTime() - 1), range.tz)
			}
		}
	};
};
