import { resolveRange, dataVersion, zonedDay } from '$lib/server/stats/range.ts';
import * as q from '$lib/server/stats/queries.ts';
import * as p from '$lib/server/stats/plays.ts';
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
		playlists,
		recent,
		labels,
		releaseYears,
		durations,
		clock,
		lag,
		split,
		duplicates,
		streaks,
		popularity,
		listening,
		played
	] = await Promise.all([
		q.totals(range),
		q.additionsByDay(range),
		q.growth(range),
		// Ten places per year. The union across years is what becomes lines and it
		// runs well past the palette, so the chart cycles hues across dash passes.
		q.topArtistsByYear(range, 10),
		q.topArtists(range, 15),
		q.albumCompletion(range, { limit: 12, orderBy: 'pct' }),
		q.albumCompletion(range, { limit: 12, orderBy: 'saved', minTracks: 1 }),
		q.topPlaylists(range, 10),
		q.recentAdditions(range, 12),
		q.topLabels(range, 10),
		q.releaseYears(range),
		q.trackDurations(range),
		q.addTimeHeatmap(range),
		q.discoveryLag(range),
		q.newVsDeepening(range),
		q.duplicates(range, 10),
		q.streaks(range),
		q.popularityDistribution(range),
		// The range picker here works in "when it was added", and listening is
		// keyed on when it was played — so these two deliberately answer the
		// whole-history question and link out rather than pretending to share a
		// window. /history is where listening gets a range of its own.
		p.listeningTotals({ ...range, from: new Date(0), to: new Date(8.64e15), isAllTime: true }),
		p.topPlayedTracks(
			{ ...range, from: new Date(0), to: new Date(8.64e15), isAllTime: true },
			{ limit: 10 }
		)
	]);

	// Data only changes when a sync commits, so a matching ETag turns a
	// re-navigation into a 304.
	setHeaders({ 'cache-control': 'private, max-age=0, must-revalidate' });

	return {
		range: {
			from: range.from.toISOString(),
			to: range.to.toISOString(),
			preset: range.preset,
			// The picker works in whole days and shows an inclusive end, so the
			// half-open upper bound steps back inside the window first.
			days: {
				from: zonedDay(range.from, range.tz),
				to: zonedDay(new Date(range.to.getTime() - 1), range.tz)
			}
		},
		version: await dataVersion(),
		totals,
		byDay,
		growth,
		bump,
		artists,
		albumsByPct,
		albumsBySaved,
		playlists,
		recent,
		labels,
		releaseYears,
		durations,
		clock,
		lag,
		split,
		duplicates,
		streaks,
		// Guarded per the probe finding: popularity reads 0 without a user token.
		popularity: popularity.some((b) => b.bucket > 0) ? popularity : [],
		listening,
		played,
		weekStart: locals.settings['ui.weekStart']
	};
};
