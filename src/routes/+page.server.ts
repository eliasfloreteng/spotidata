import { resolveRange, dataVersion, zonedDay } from '$lib/server/stats/range.ts';
import * as q from '$lib/server/stats/queries.ts';
import * as p from '$lib/server/stats/plays.ts';
import type { PageServerLoad } from './$types';

/**
 * The overview: what was saved and what was played, over one window.
 *
 * The range picks saves by when they were first added and plays by when they
 * were played, so "the last 90 days" means both at once. Wherever the two
 * answer the same question (top artists, the calendar, the bump chart) the
 * page shows one card that switches between them rather than two cards.
 */
export const load: PageServerLoad = async ({ url, locals, setHeaders }) => {
	// 'both': all time starts at the first save or the first play, whichever
	// is earlier, so neither half is clipped.
	const range = await resolveRange(url, locals.settings['ui.timezone'], 'both');

	// Every query is a GROUP BY over tables that sit in shared buffers (~9k
	// library rows, ~180k plays), so the whole page is one parallel round.
	const [
		library,
		listening,
		meet,
		coverage,
		addsByDay,
		minutesByDay,
		growth,
		byMonth,
		bumpSaved,
		bumpPlayed,
		artistsSaved,
		artistsPlayed,
		tracksPlayed,
		tracksUnsaved,
		albumsPlayed,
		albumsBySaved,
		albumsByPct,
		labels,
		playlists,
		split,
		discovery,
		lag,
		releaseYears,
		durations,
		devices,
		countries,
		ends,
		saveStreaks,
		listenStreaks,
		recentAdds,
		recentPlays
	] = await Promise.all([
		q.totals(range),
		p.listeningTotals(range),
		p.savedVsHeard(range),
		p.coverage(),
		q.additionsByDay(range),
		p.minutesByDay(range),
		q.growth(range),
		p.listeningByMonth(range),
		// Ten places per year. The union across years is what becomes lines and it
		// runs well past the palette, so the chart cycles hues across dash passes.
		q.topArtistsByYear(range, 10),
		p.topArtistsByYearPlayed(range, 10),
		q.topArtists(range, 15),
		p.topPlayedArtists(range, 15),
		p.topPlayedTracks(range, { limit: 15 }),
		p.topPlayedTracks(range, { limit: 15, inLibrary: false }),
		p.topPlayedAlbums(range, 12),
		q.albumCompletion(range, { limit: 12, orderBy: 'saved', minTracks: 1 }),
		q.albumCompletion(range, { limit: 12, orderBy: 'pct' }),
		q.topLabels(range, 10),
		q.topPlaylists(range, 10),
		q.newVsDeepening(range),
		p.discoveryVsRepeat(range),
		q.discoveryLag(range),
		q.releaseYears(range),
		q.trackDurations(range),
		p.deviceShare(range),
		p.countryShare(range),
		p.endReasons(range),
		q.streaks(range),
		p.listeningStreaks(range),
		q.recentAdditions(range, 12),
		p.playLog(range, { limit: 12, offset: 0, withTotal: false })
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
		library,
		listening,
		meet,
		coverage,
		addsByDay,
		minutesByDay,
		growth,
		byMonth,
		bumpSaved,
		bumpPlayed,
		artistsSaved,
		artistsPlayed,
		tracksPlayed,
		tracksUnsaved,
		albumsPlayed,
		albumsBySaved,
		albumsByPct,
		labels,
		playlists,
		split,
		discovery,
		lag,
		releaseYears,
		durations,
		devices,
		countries,
		ends,
		saveStreaks,
		listenStreaks,
		recentAdds,
		recentPlays,
		weekStart: locals.settings['ui.weekStart']
	};
};
