import type { Settings } from '../settings.ts';
import * as p from './plays.ts';
import * as q from './queries.ts';
import { resolveRange, zonedDay } from './range.ts';
import { dataVersion } from './version.ts';

type OverviewSettings = Pick<Settings, 'ui.timezone' | 'ui.weekStart'>;
export type Overview = Awaited<ReturnType<typeof compute>>;

/**
 * The overview: what was saved and what was played, over one window.
 *
 * The range picks saves by when they were first added and plays by when they
 * were played, so "the last 90 days" means both at once. Wherever the two
 * answer the same question (top artists, the calendar, the bump chart) the
 * page shows one card that switches between them rather than two cards.
 */
async function compute(url: URL, settings: OverviewSettings) {
	// 'both': all time starts at the first save or the first play, whichever
	// is earlier, so neither half is clipped.
	const range = await resolveRange(url, settings['ui.timezone'], 'both');

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
		weekStart: settings['ui.weekStart']
	};
}

/**
 * The overview is ~30 GROUP BYs over every play and every save, which keeps
 * the Pi's four cores busy for about five seconds, and its answer only
 * changes when the data does. So it is computed once per data version (see
 * `dataVersion`) and served from memory until something is written.
 *
 * Kept for an hour at most even when nothing is written: a preset like "the
 * last 30 days" and the streak that ends today move with the clock alone.
 * A few windows are kept, since the picker is used to compare them.
 */
const MAX_AGE_MS = 60 * 60_000;
const KEEP = 6;

interface Entry {
	version: string;
	at: number;
	value: Promise<Overview>;
}
const cache = new Map<string, Entry>();

/** What the result depends on besides the data: the window as asked for, and how it is bucketed. */
function keyOf(url: URL, settings: OverviewSettings): string {
	const s = url.searchParams;
	const from = s.get('from');
	const to = s.get('to');
	const window = from || to ? ['custom', from, to] : [s.get('preset') ?? 'all'];
	return JSON.stringify([settings['ui.timezone'], settings['ui.weekStart'], ...window]);
}

function fresh(entry: Entry | undefined, version: string, slackMs = 0): entry is Entry {
	return !!entry && entry.version === version && Date.now() - entry.at < MAX_AGE_MS - slackMs;
}

function store(key: string, version: string, url: URL, settings: OverviewSettings): Promise<Overview> {
	const value = compute(url, settings);
	cache.delete(key);
	cache.set(key, { version, at: Date.now(), value });
	// A failed computation is not an answer: the next request tries again.
	value.catch(() => {
		if (cache.get(key)?.value === value) cache.delete(key);
	});
	while (cache.size > KEEP) cache.delete(cache.keys().next().value!);
	return value;
}

export async function overview(url: URL, settings: OverviewSettings): Promise<Overview> {
	const key = keyOf(url, settings);
	const version = await dataVersion();
	const hit = cache.get(key);
	if (!fresh(hit, version)) return store(key, version, url, settings);
	// Most recently used last, so the oldest window is the one evicted.
	cache.delete(key);
	cache.set(key, hit);
	return hit.value;
}

const WARM_EVERY_MS = 60_000;

/**
 * Keeps the default view (all time) computed ahead of the visit, so opening
 * the app does not wait on it after the history poll lands a few plays.
 *
 * Only once the version has held still for a tick: during a sync it moves
 * with every batch, and recomputing the page between batches would only slow
 * the sync down. A visit during a sync computes the page itself.
 */
export function warmOverview(load: () => Promise<OverviewSettings>): () => void {
	let last: string | null = null;
	let running = false;
	const tick = async (first: boolean) => {
		if (running) return;
		running = true;
		try {
			const version = await dataVersion();
			const settled = first || version === last;
			last = version;
			if (!settled) return;
			const settings = await load();
			const url = new URL('http://overview/');
			const key = keyOf(url, settings);
			// Renewed a little before it expires, so a visit never finds it gone.
			if (fresh(cache.get(key), version, 2 * WARM_EVERY_MS)) return;
			await store(key, version, url, settings);
		} catch (err) {
			console.error('[overview] warming failed:', err instanceof Error ? err.message : err);
		} finally {
			running = false;
		}
	};
	void tick(true);
	const timer = setInterval(() => void tick(false), WARM_EVERY_MS);
	timer.unref();
	return () => clearInterval(timer);
}
