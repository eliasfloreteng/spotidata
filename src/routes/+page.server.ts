import { resolveRange, dataVersion } from '$lib/server/stats/range.ts';
import * as q from '$lib/server/stats/queries.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, locals, setHeaders }) => {
	const range = await resolveRange(url, locals.settings['ui.timezone']);

	// Every chart is a GROUP BY over ≤20k rows that fit in shared buffers, so
	// the whole dashboard is one round of parallel queries (~130ms measured).
	const [
		totals,
		byDay,
		growth,
		bump,
		artists,
		albumsByPct,
		albumsBySaved,
		labels,
		releaseYears,
		durations,
		clock,
		lag,
		split,
		duplicates,
		streaks,
		popularity
	] = await Promise.all([
		q.totals(range),
		q.additionsByDay(range),
		q.growth(range),
		q.topArtistsByYear(range, 6),
		q.topArtists(range, 15),
		q.albumCompletion(range, { limit: 12, orderBy: 'pct' }),
		q.albumCompletion(range, { limit: 12, orderBy: 'saved', minTracks: 1 }),
		q.topLabels(range, 10),
		q.releaseYears(range),
		q.trackDurations(range),
		q.addTimeHeatmap(range),
		q.discoveryLag(range),
		q.newVsDeepening(range),
		q.duplicates(range, 10),
		q.streaks(range),
		q.popularityDistribution(range)
	]);

	// Data only changes when a sync commits, so a matching ETag turns a
	// re-navigation into a 304.
	setHeaders({ 'cache-control': 'private, max-age=0, must-revalidate' });

	return {
		range: { from: range.from.toISOString(), to: range.to.toISOString(), preset: range.preset },
		version: await dataVersion(),
		totals,
		byDay,
		growth,
		bump,
		artists,
		albumsByPct,
		albumsBySaved,
		labels,
		releaseYears,
		durations,
		clock,
		lag,
		split,
		duplicates,
		streaks,
		// Guarded per the probe finding: popularity reads 0 without a user token.
		popularity: popularity.some((p) => p.bucket > 0) ? popularity : [],
		weekStart: locals.settings['ui.weekStart']
	};
};
