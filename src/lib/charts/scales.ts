/**
 * Shared chart scales, colour ramps and formatters.
 *
 * ── Colour policy ───────────────────────────────────────────────────────────
 * The brand accent is a three-stop gradient (violet → magenta → orange). It is
 * a fine *sequential* ramp — lightness rises monotonically along it, so "more"
 * reads as "brighter". It is a terrible *categorical* palette: its mid hues
 * (#7C3AED → #C026D3) sit ~0.05 OKLCH-L apart and collapse into one another
 * when two series sit side by side, and they collapse completely under
 * deuteranopia. So identity gets its own ramp.
 *
 * `CATEGORICAL` below is eight hue families anchored on the brand violet,
 * stepped for the card surface (#131318) and validated with the dataviz
 * skill's `validate_palette.js` (Machado–Oliveira–Fernandes CVD simulation,
 * ΔE in OKLab ×100):
 *
 *   dark / surface #131318 / adjacent pairs
 *     Lightness band       PASS  all 8 inside L 0.48–0.67
 *     Chroma floor         PASS  all 8 >= 0.10
 *     CVD separation       PASS  worst adjacent #d13c4a↔#15a7a7 ΔE 13.0 (deutan)
 *     Normal-vision floor  PASS  worst adjacent #15a7a7↔#b75f0c ΔE 24.9
 *     Contrast vs surface  PASS  all 8 >= 3:1 (3.90 – 6.28)
 *
 * The slot ORDER is the CVD-safety mechanism — it was picked by enumerating
 * orderings and keeping the one with the best worst-adjacent separation. Never
 * reorder it, never cycle it: a ninth series folds into `OTHER_COLOR`.
 *
 * All-pairs caveat: under `--pairs all` (any two marks can touch — scatter,
 * bubble, choropleth) only the first THREE slots clear the floors. Forms where
 * arbitrary series meet — the bump chart's crossing lines — therefore carry
 * secondary encoding: direct labels at both ends, plus hover isolation.
 */

import { ticks as d3Ticks } from 'd3-array';
import { format } from 'd3-format';
import { interpolateLab } from 'd3-interpolate';
import { scaleLinear } from 'd3-scale';

/* ── Categorical: identity ─────────────────────────────────────────────────*/

/** Fixed slot order. Assign in sequence; never cycle, never sort by value. */
export const CATEGORICAL = [
	'#805edc', // 1 · violet  — anchors on the brand accent
	'#0f942a', // 2 · green
	'#bd429c', // 3 · magenta
	'#a5810f', // 4 · amber
	'#0e78e4', // 5 · blue
	'#b75f0c', // 6 · orange
	'#15a7a7', // 7 · aqua
	'#d13c4a' // 8 · rose
] as const;

/** Everything past slot 8 — series should be folded into an "Other" bucket. */
export const OTHER_COLOR = '#6b6b7d';

/** Colour for categorical slot `i` (0-based). Past slot 8 → the Other grey. */
export function seriesColor(i: number): string {
	return CATEGORICAL[i] ?? OTHER_COLOR;
}

/* ── Sequential: magnitude ─────────────────────────────────────────────────*/

/**
 * The brand gradient, extended down to a near-surface base so "no activity"
 * recedes into the card. Stop positions are spaced so OKLCH lightness climbs
 * monotonically: 0.231 → 0.313 → 0.541 → 0.610 → 0.705.
 */
export const SEQUENTIAL_STOPS = ['#1c1c26', '#3d2270', '#7c3aed', '#c026d3', '#f97316'] as const;

const sequential = scaleLinear<string>()
	.domain([0, 0.22, 0.5, 0.76, 1])
	.range([...SEQUENTIAL_STOPS])
	.interpolate(interpolateLab as unknown as (a: string, b: string) => (t: number) => string)
	.clamp(true);

/** Continuous brand ramp. `t` in [0,1]; 0 = near-surface, 1 = accent orange. */
export function interpolateSpotify(t: number): string {
	return sequential(Number.isFinite(t) ? t : 0);
}

/**
 * `n` discrete steps of the sequential ramp for bucketed marks (heatmap cells).
 * Starts at t = 0.10 — near-zero is *meant* to recede toward the surface, and a
 * grid where every cell shouts reads as noise rather than as magnitude.
 */
export function sequentialSteps(n: number): string[] {
	const count = Math.max(1, Math.floor(n));
	if (count === 1) return [interpolateSpotify(1)];
	return Array.from({ length: count }, (_, i) => interpolateSpotify(0.1 + (0.9 * i) / (count - 1)));
}

/** Fill for a heatmap cell with no data / a zero value. */
export const EMPTY_CELL = 'rgba(255,255,255,0.045)';

/* ── Chrome ────────────────────────────────────────────────────────────────*/

/** Chart chrome tokens, mirrored from app.css. Text never wears a data colour. */
export const INK = {
	surface: '#131318',
	grid: 'rgba(255,255,255,0.06)',
	axis: 'rgba(255,255,255,0.12)',
	text: '#ecedf1',
	muted: '#9a9bab',
	faint: '#63647a'
} as const;

/* ── Geometry ──────────────────────────────────────────────────────────────*/

export type Margin = { top: number; right: number; bottom: number; left: number };

export type Geometry = {
	/** Full measured width of the plot container, in px. */
	width: number;
	/** Full svg height, in px. */
	height: number;
	/** Width inside the margins. */
	innerWidth: number;
	/** Height inside the margins. */
	innerHeight: number;
	margin: Margin;
};

export const DEFAULT_MARGIN: Margin = { top: 10, right: 16, bottom: 26, left: 44 };

/* ── Ticks ─────────────────────────────────────────────────────────────────*/

/**
 * Round tick values across [min, max], guaranteed non-empty and safe for the
 * degenerate cases (equal bounds, a single data point, non-finite input).
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
	if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
	if (min === max) return [min];
	const lo = Math.min(min, max);
	const hi = Math.max(min, max);
	const out = d3Ticks(lo, hi, Math.max(2, count));
	return out.length > 0 ? out : [lo, hi];
}

/** A [0, max] domain padded up to the next round tick, so bars never touch the top. */
export function niceMax(max: number, count = 5): number {
	if (!Number.isFinite(max) || max <= 0) return 1;
	const t = niceTicks(0, max, count);
	const last = t[t.length - 1] ?? max;
	return last >= max ? last : max;
}

/* ── Formatters ────────────────────────────────────────────────────────────*/

const int = format(',d');
const si = format('.2~s');
const pct1 = format('.1f');

/** 1284 → "1,284" */
export function fmtInt(n: number): string {
	return Number.isFinite(n) ? int(Math.round(n)) : '–';
}

/** 1284 → "1.3k", 4_200_000 → "4.2M" */
export function fmtCompact(n: number): string {
	if (!Number.isFinite(n)) return '–';
	const abs = Math.abs(n);
	if (abs < 1000) return int(Math.round(n));
	return si(n).replace('G', 'B').replace('T', 'T');
}

/** 0.184 → "18.4%" (input is a fraction) */
export function fmtPct(fraction: number, digits = 1): string {
	if (!Number.isFinite(fraction)) return '–';
	const v = fraction * 100;
	return `${digits === 0 ? Math.round(v).toString() : pct1(v)}%`;
}

/** Milliseconds → "3:42" / "1:04:22". Track and session lengths. */
export function fmtDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return '–';
	const total = Math.round(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (v: number) => v.toString().padStart(2, '0');
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Milliseconds → "1,204 h" / "48 min" — for listening-time totals. */
export function fmtListening(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return '–';
	const minutes = ms / 60000;
	if (minutes < 90) return `${Math.round(minutes)} min`;
	return `${fmtCompact(minutes / 60)} h`;
}

/** Minutes → "1,204 h" / "48 min", for data already stored in minutes. */
export function fmtMinutes(minutes: number): string {
	return fmtListening(minutes * 60000);
}

/* ── Mark path helpers ─────────────────────────────────────────────────────*/

/**
 * Horizontal bar: square at the baseline (left), 4px rounded at the data end.
 * Radius collapses on short bars so nothing renders as a lozenge.
 */
export function barPathH(x: number, y: number, w: number, h: number, r = 4): string {
	const width = Math.max(0, w);
	const radius = Math.max(0, Math.min(r, width, h / 2));
	if (radius === 0) return `M${x},${y}h${width}v${h}h${-width}Z`;
	return (
		`M${x},${y}h${width - radius}a${radius},${radius} 0 0 1 ${radius},${radius}` +
		`v${h - 2 * radius}a${radius},${radius} 0 0 1 ${-radius},${radius}h${-(width - radius)}Z`
	);
}

/**
 * Vertical column: square at the baseline (bottom), 4px rounded cap.
 * `y` is the top of the column, `h` its height.
 */
export function barPathV(x: number, y: number, w: number, h: number, r = 4): string {
	const height = Math.max(0, h);
	const radius = Math.max(0, Math.min(r, height, w / 2));
	if (radius === 0) return `M${x},${y}h${w}v${height}h${-w}Z`;
	return (
		`M${x},${y + height}v${-(height - radius)}a${radius},${radius} 0 0 1 ${radius},${-radius}` +
		`h${w - 2 * radius}a${radius},${radius} 0 0 1 ${radius},${radius}v${height - radius}Z`
	);
}

/* ── Misc ──────────────────────────────────────────────────────────────────*/

/** Coerce the several shapes a date arrives in into a Date. */
export function toDate(v: string | number | Date): Date {
	if (v instanceof Date) return v;
	if (typeof v === 'number') return new Date(v);
	// 'YYYY-MM' → first of the month; 'YYYY-MM-DD' → local midnight (not UTC,
	// so a day never lands in the previous cell of the calendar heatmap).
	const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(v);
	if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3] ?? '1'));
	return new Date(v);
}

/** Clamp helper used by tooltips to stay inside the plot. */
export function clamp(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v;
}
