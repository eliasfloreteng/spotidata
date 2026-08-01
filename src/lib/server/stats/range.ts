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
		const from = fromParam ? new Date(fromParam) : start;
		const to = toParam ? new Date(toParam) : now;
		return {
			from: Number.isNaN(from.getTime()) ? start : from,
			to: Number.isNaN(to.getTime()) ? now : to,
			tz,
			preset: 'custom',
			isAllTime: false
		};
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
