/**
 * Spotidata chart library — d3 computes, Svelte renders.
 *
 * Every chart composes ChartFrame (title, legend, responsive measurement,
 * margins, empty state), takes its colours from `scales.ts`, and carries a
 * `role="img"` + `aria-label` summary of the data it draws.
 */

export { default as AreaChart } from './AreaChart.svelte';
export { default as BarList } from './BarList.svelte';
export { default as BumpChart } from './BumpChart.svelte';
export { default as CalendarHeatmap } from './CalendarHeatmap.svelte';
export { default as ChartFrame } from './ChartFrame.svelte';
export { default as Donut } from './Donut.svelte';
export { default as Histogram } from './Histogram.svelte';
export { default as Legend } from './Legend.svelte';
export { default as Sparkline } from './Sparkline.svelte';
export { default as Tooltip } from './Tooltip.svelte';

export type {
	AreaPoint,
	AreaSeries,
	BarListDatum,
	BumpDatum,
	CalendarDatum,
	DonutDatum,
	LegendItem,
	TooltipRow
} from './types';

export {
	barPathH,
	barPathV,
	CATEGORICAL,
	clamp,
	DEFAULT_MARGIN,
	EMPTY_CELL,
	fmtCompact,
	fmtDuration,
	fmtInt,
	fmtListening,
	fmtMinutes,
	fmtPct,
	INK,
	interpolateSpotify,
	niceMax,
	niceTicks,
	OTHER_COLOR,
	SEQUENTIAL_STOPS,
	sequentialSteps,
	seriesColor,
	toDate
} from './scales';

export type { Geometry, Margin } from './scales';
