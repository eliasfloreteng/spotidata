import { resolveRange, dataVersion, zonedDay } from '$lib/server/stats/range.ts';
import * as q from '$lib/server/stats/plays.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, locals, setHeaders }) => {
	// 'history' rather than 'library': all-time here starts at the first play,
	// which an import routinely puts years before the first save.
	const range = await resolveRange(url, locals.settings['ui.timezone'], 'history');

	const [
		totals,
		byDay,
		byMonth,
		clock,
		devices,
		countries,
		ends,
		completion,
		tracks,
		neverSaved,
		artists,
		albums,
		bump,
		discovery,
		streaks,
		recent,
		coverage
	] = await Promise.all([
		q.listeningTotals(range),
		q.minutesByDay(range),
		q.listeningByMonth(range),
		q.listeningClock(range),
		q.deviceShare(range),
		q.countryShare(range),
		q.endReasons(range),
		q.completionBuckets(range),
		q.topPlayedTracks(range, { limit: 20 }),
		q.topPlayedTracks(range, { limit: 12, inLibrary: false }),
		q.topPlayedArtists(range, 20),
		q.topPlayedAlbums(range, 12),
		q.topArtistsByYearPlayed(range, 10),
		q.discoveryVsRepeat(range),
		q.listeningStreaks(range),
		q.playLog(range, { limit: 25, offset: 0 }),
		q.coverage()
	]);

	setHeaders({ 'cache-control': 'private, max-age=0, must-revalidate' });

	return {
		range: {
			from: range.from.toISOString(),
			to: range.to.toISOString(),
			preset: range.preset,
			days: {
				from: zonedDay(range.from, range.tz),
				to: zonedDay(new Date(range.to.getTime() - 1), range.tz)
			}
		},
		version: await dataVersion(),
		totals,
		byDay,
		byMonth,
		clock,
		devices,
		countries,
		ends,
		completion,
		tracks,
		neverSaved,
		artists,
		albums,
		bump,
		discovery,
		streaks,
		recent,
		coverage,
		weekStart: locals.settings['ui.weekStart']
	};
};
