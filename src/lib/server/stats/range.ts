import { sql } from 'drizzle-orm';
import { db } from '../db/index.ts';

export interface Range {
	from: Date;
	to: Date;
	tz: string;
	preset: string;
	/** True when the range covers the whole library. */
	isAllTime: boolean;
}

export const PRESETS = [
	{ key: 'all', label: 'All time' },
	{ key: '1y', label: 'Last year' },
	{ key: '6m', label: 'Last 6 months' },
	{ key: '90d', label: 'Last 90 days' },
	{ key: '30d', label: 'Last 30 days' },
	{ key: 'ytd', label: 'This year' }
] as const;

/** Earliest library addition; cached because it only moves on a sync. */
let earliest: { value: Date; at: number } | null = null;

export async function libraryStart(): Promise<Date> {
	if (earliest && Date.now() - earliest.at < 60_000) return earliest.value;
	// Drizzle sets node-postgres to hand back timestamps as strings and maps
	// them itself in the query builder — raw `execute` skips that, so anything
	// date-shaped coming out of raw SQL must be coerced here.
	const { rows } = await db.execute<{ first: string | null }>(
		sql`select min(first_added_at)::text as first from library_canonical`
	);
	const raw = rows[0]?.first;
	const value = raw ? new Date(raw) : new Date('2008-01-01');
	earliest = { value, at: Date.now() };
	return value;
}

export function invalidateRangeCache(): void {
	earliest = null;
}

/** How far `tz` is ahead of UTC at a given instant, in milliseconds. */
function zoneOffset(at: Date, tz: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: tz,
		hour12: false,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	}).formatToParts(at);
	const f = (type: string) => Number(parts.find((p) => p.type === type)?.value);
	// Midnight formats as hour 24 rather than 0 under hour12: false.
	const wall = Date.UTC(f('year'), f('month') - 1, f('day'), f('hour') % 24, f('minute'), f('second'));
	return wall - at.getTime();
}

/**
 * The instant at which `YYYY-MM-DD` starts in `tz`, optionally `plusDays` later.
 *
 * Every chart buckets by day in the same zone, so a custom span typed as two
 * dates has to land on those boundaries — reading the string as a plain `Date`
 * would anchor it to UTC and shift the buckets at both edges.
 */
function zonedMidnight(day: string, tz: string, plusDays = 0): Date {
	const [y, m, d] = day.split('-').map(Number);
	const utc = Date.UTC(y, m - 1, d + plusDays);
	// The offset is itself a function of the instant, so the first guess is
	// refined once; that settles the hour lost or gained on a DST changeover.
	return new Date(utc - zoneOffset(new Date(utc - zoneOffset(new Date(utc), tz)), tz));
}

/** The day `at` falls on in `tz`, as the `YYYY-MM-DD` a date input expects. */
export function zonedDay(at: Date, tz: string): string {
	return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(at);
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses one end of a custom span. The picker writes whole days, which read as
 * zone-local midnight; an end day is inclusive, so it resolves to the midnight
 * after it — the window itself is half-open. A full timestamp still works, for
 * URLs written by hand.
 */
function bound(raw: string | null, tz: string, isEnd: boolean): Date | null {
	if (!raw) return null;
	if (DATE_ONLY.test(raw)) return zonedMidnight(raw, tz, isEnd ? 1 : 0);
	const at = new Date(raw);
	return Number.isNaN(at.getTime()) ? null : at;
}

/** The two ends of a custom span, earlier first, compared as plain instants. */
function ordered(a: string | null, b: string | null, tz: string): [string | null, string | null] {
	const [x, y] = [bound(a, tz, false), bound(b, tz, false)];
	return x && y && y < x ? [b, a] : [a, b];
}

/**
 * Resolves ?from/?to/?preset into a concrete window.
 *
 * Explicit from/to always win, so a URL stays meaningful when shared; `preset`
 * is the shorthand the picker writes. Default is all-time per the brief.
 */
export async function resolveRange(url: URL, tz: string): Promise<Range> {
	const preset = url.searchParams.get('preset') ?? 'all';
	const fromParam = url.searchParams.get('from');
	const toParam = url.searchParams.get('to');

	const now = new Date();
	const start = await libraryStart();

	if (fromParam || toParam) {
		// A backwards span is a slip in the picker rather than a request for an
		// empty library, so the two dates are ordered before either is read as an
		// end — an end day grows by one to stay inclusive, and doing that to the
		// wrong one would move both edges of the window.
		const [lo, hi] = ordered(fromParam, toParam, tz);
		const from = bound(lo, tz, false) ?? start;
		const to = bound(hi, tz, true) ?? now;
		// A one-sided span can still fall outside the library once the missing end
		// defaults in. That window is genuinely empty, but it has to be empty
		// rather than negative — the day series can't run backwards.
		return { from: from > to ? to : from, to, tz, preset: 'custom', isAllTime: false };
	}

	const from = (() => {
		const d = new Date(now);
		switch (preset) {
			case '1y':
				d.setFullYear(d.getFullYear() - 1);
				return d;
			case '6m':
				d.setMonth(d.getMonth() - 6);
				return d;
			case '90d':
				d.setDate(d.getDate() - 90);
				return d;
			case '30d':
				d.setDate(d.getDate() - 30);
				return d;
			case 'ytd':
				return new Date(now.getFullYear(), 0, 1);
			default:
				return start;
		}
	})();

	return { from, to: now, tz, preset, isAllTime: preset === 'all' };
}

/** Cache key that changes whenever a sync commits new data. */
export async function dataVersion(): Promise<string> {
	const { rows } = await db.execute<{ v: string }>(sql`
		select coalesce(max(finished_at)::text, 'none') || ':' ||
		       (select count(*)::text from library_canonical) as v
		  from sync_runs where status = 'completed'
	`);
	return rows[0]?.v ?? 'none';
}
