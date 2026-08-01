/**
 * Public data shapes for the chart components.
 *
 * They live here rather than inside the `.svelte` files so plain `tsc` (and any
 * consumer that isn't running the Svelte language tooling) can import them.
 */

/** One day in the calendar heatmap. `day` is `YYYY-MM-DD`, read as local time. */
export type CalendarDatum = { day: string; value: number };

/** One (series, period) observation in the bump chart. `rank` is 1-based. */
export type BumpDatum = {
	period: string | number;
	key: string;
	label: string;
	rank: number;
	value: number;
	/** Change in `value` since the previous period, shown in the tooltip. */
	delta?: number;
};

/** A point in a time series. Strings may be `YYYY-MM` or `YYYY-MM-DD`. */
export type AreaPoint = { date: string | number | Date; value: number };

export type AreaSeries = {
	key: string;
	label: string;
	points: AreaPoint[];
	/** 'area' (default) draws a 2px line + 10% wash; 'bar' draws columns. */
	render?: 'area' | 'bar';
};

export type BarListDatum = {
	label: string;
	value: number;
	/** Optional second measure, rendered as a trailing percent by default. */
	secondary?: number;
	/** Small line under the label — album artist, label owner, etc. */
	sublabel?: string;
};

export type DonutDatum = { key?: string; label: string; value: number };

export type LegendItem = {
	key: string;
	label: string;
	color: string;
	value?: string;
	/** Draws the mark hollow — for series whose hue is a second-cycle repeat. */
	hollow?: boolean;
};

export type TooltipRow = { label: string; value: string; color?: string };
