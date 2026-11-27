<!--
  AreaChart — time series, with an optional bar rendering and an optional
  cumulative transform.

  ONE y axis, always. A second series is allowed only because it is the same
  measure on the same scale (this year vs last year, plays vs skips) — never a
  second unit on a second axis. `cumulative` transforms *every* series, so the
  scale stays shared.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { bisectCenter, extent, max } from 'd3-array';
	import { area, line } from 'd3-shape';
	import { scaleLinear, scaleTime } from 'd3-scale';
	import { timeFormat } from 'd3-time-format';
	import ChartFrame from './ChartFrame.svelte';
	import Legend from './Legend.svelte';
	import Tooltip from './Tooltip.svelte';
	import {
		barPathV,
		clamp,
		fmtCompact,
		fmtInt,
		niceTicks,
		seriesColor,
		toDate,
		type Geometry
	} from './scales';
	import type { AreaSeries } from './types';

	type Props = {
		/** One or two series — they must share a unit, because they share the axis. */
		series: AreaSeries[];
		/** Plot running totals instead of per-period values. */
		cumulative?: boolean;
		title?: string;
		subtitle?: string;
		ariaLabel?: string;
		height?: number;
		valueFormat?: (n: number) => string;
		/** d3-time-format spec for the x ticks. */
		tickFormat?: string;
		unit?: string;
		/** Controls parked at the top right of the header. */
		actions?: Snippet;
	};

	let {
		series,
		cumulative = false,
		title = 'Over time',
		subtitle,
		ariaLabel,
		height = 260,
		valueFormat = fmtInt,
		tickFormat = '%b %Y',
		unit = 'plays',
		actions
	}: Props = $props();

	const fmtX = $derived(timeFormat(tickFormat));
	const fmtFull = timeFormat('%-d %b %Y');

	type Prepared = {
		key: string;
		label: string;
		color: string;
		render: 'area' | 'bar';
		points: { t: number; date: Date; value: number }[];
	};

	const prepared = $derived.by<Prepared[]>(() =>
		series.slice(0, 2).map((s, i) => {
			const sorted = s.points
				.map((p) => {
					const date = toDate(p.date);
					return { t: date.getTime(), date, value: Number.isFinite(p.value) ? p.value : 0 };
				})
				.filter((p) => Number.isFinite(p.t))
				.sort((a, b) => a.t - b.t);
			let running = 0;
			return {
				key: s.key,
				label: s.label,
				color: seriesColor(i),
				render: s.render ?? 'area',
				points: cumulative
					? sorted.map((p) => ({ ...p, value: (running += p.value) }))
					: sorted
			};
		})
	);

	const allPoints = $derived(prepared.flatMap((s) => s.points));
	const times = $derived(prepared[0]?.points.map((p) => p.t) ?? []);
	const isEmpty = $derived(allPoints.length === 0);
	const hasBars = $derived(prepared.some((s) => s.render === 'bar'));

	const yMax = $derived(max(allPoints, (p) => p.value) ?? 0);
	// Counts have no fractions: a series of whole numbers gets only whole ticks,
	// or a peak of 1 is labelled 0, 0, 0, 1, 1, 1 after rounding.
	const wholeOnly = $derived(allPoints.every((p) => Number.isInteger(p.value)));
	const yTicks = $derived(
		niceTicks(0, yMax || 1, 4).filter((t) => !wholeOnly || Number.isInteger(t))
	);
	const yTop = $derived(Math.max(yTicks[yTicks.length - 1] ?? 1, yMax, 1));

	const xDomain = $derived.by<[Date, Date]>(() => {
		const e = extent(allPoints, (p) => p.date);
		const lo = e[0] ?? new Date();
		const hi = e[1] ?? new Date();
		if (lo.getTime() === hi.getTime()) {
			return [new Date(lo.getTime() - 86400000), new Date(hi.getTime() + 86400000)];
		}
		return [lo, hi];
	});

	/** Bars need a slot, so the x range is inset by half a slot when they exist. */
	const slot = $derived.by(() => {
		const pts = prepared.find((s) => s.render === 'bar')?.points ?? [];
		if (pts.length < 2) return 0;
		const gaps: number[] = [];
		for (let i = 1; i < pts.length; i++) gaps.push((pts[i]?.t ?? 0) - (pts[i - 1]?.t ?? 0));
		gaps.sort((a, b) => a - b);
		return gaps[Math.floor(gaps.length / 2)] ?? 0;
	});

	function xScale(g: Geometry) {
		// Columns need half a slot of air at each end so the first/last bar is
		// never sliced by the plot edge.
		const inset = hasBars ? 14 : 0;
		return scaleTime()
			.domain(xDomain)
			.range([inset, Math.max(inset + 1, g.innerWidth - inset)]);
	}

	function yScale(g: Geometry) {
		return scaleLinear().domain([0, yTop]).range([Math.max(1, g.innerHeight), 0]).clamp(true);
	}

	function areaPath(s: Prepared, g: Geometry): string {
		const x = xScale(g);
		const y = yScale(g);
		return (
			area<{ date: Date; value: number }>()
				.x((d) => x(d.date))
				.y0(g.innerHeight)
				.y1((d) => y(d.value))(s.points) ?? ''
		);
	}

	function linePath(s: Prepared, g: Geometry): string {
		const x = xScale(g);
		const y = yScale(g);
		return (
			line<{ date: Date; value: number }>()
				.x((d) => x(d.date))
				.y((d) => y(d.value))(s.points) ?? ''
		);
	}

	/** Column width: the slot minus the 2px surface gap, capped at 24px. */
	function barWidth(g: Geometry): number {
		const x = xScale(g);
		if (slot <= 0) return Math.min(24, Math.max(3, g.innerWidth / 3));
		const w = x(new Date(xDomain[0].getTime() + slot)) - x(xDomain[0]) - 2;
		return clamp(w, 2, 24);
	}

	/** Approximate advance of one x-tick character (10px tabular type). */
	const TICK_CHAR_W = 6.2;
	const TICK_PAD = 8;

	/**
	 * d3's time ticks can return a single value on a short/narrow plot, which
	 * leaves the axis unreadable — fall back to the domain ends then. The ends
	 * are anchored inward so they stay inside the plot, which can push the last
	 * label onto its neighbour on a phone ("Jan 2024Jan 2026"); a label that
	 * would touch the one before it is dropped rather than drawn over it.
	 * Ticks that all fall on 1 January say only the year.
	 */
	function xTicks(
		scale: ReturnType<typeof xScale>,
		innerW: number
	): { t: Date; x: number; text: string; anchor: 'start' | 'middle' | 'end' }[] {
		const want = Math.max(2, Math.min(7, Math.floor(innerW / 90)));
		const out = scale.ticks(want);
		const ticks = out.length >= 2 ? out : xDomain.slice();
		const yearly =
			ticks.length >= 2 && ticks.every((t) => t.getMonth() === 0 && t.getDate() === 1);
		const fmt = yearly ? fmtYear : fmtX;

		const kept: { t: Date; x: number; text: string; anchor: 'start' | 'middle' | 'end' }[] = [];
		// Walk from the right so the newest date — the one a reader looks for —
		// always survives.
		let nextLeft = Infinity;
		for (const t of [...ticks].reverse()) {
			const x = scale(t);
			const text = fmt(t);
			const anchor = x < 26 ? 'start' : x > innerW - 26 ? 'end' : 'middle';
			const w = text.length * TICK_CHAR_W;
			const left = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
			if (left + w + TICK_PAD > nextLeft) continue;
			nextLeft = left;
			kept.unshift({ t, x, text, anchor });
		}
		return kept;
	}
	const fmtYear = timeFormat('%Y');

	let hoverIdx = $state<number | null>(null);
	let plotW = $state(0);

	function onMove(event: PointerEvent, g: Geometry) {
		if (times.length === 0) return;
		const rect = (event.currentTarget as SVGRectElement).getBoundingClientRect();
		const x = xScale(g);
		const t = x.invert(event.clientX - rect.left).getTime();
		hoverIdx = bisectCenter(times, t);
		plotW = g.width;
	}

	const label = $derived(
		ariaLabel ??
			`${cumulative ? 'Cumulative ' : ''}${unit} over time` +
				(prepared.length > 0
					? `. ${prepared
							.map((s) => {
								const first = s.points[0];
								const last = s.points[s.points.length - 1];
								return first && last
									? `${s.label} from ${valueFormat(first.value)} (${fmtFull(first.date)}) to ${valueFormat(last.value)} (${fmtFull(last.date)})`
									: `${s.label} has no data`;
							})
							.join('; ')}. Peak ${valueFormat(yMax)}.`
					: '.')
	);
</script>

<ChartFrame
	{title}
	{actions}
	{subtitle}
	ariaLabel={label}
	{height}
	margin={(w: number) => (w < 420 ? { top: 12, right: 10, bottom: 26, left: 36 } : { top: 12, right: 18, bottom: 28, left: 52 })}
	empty={isEmpty}
>
	{#snippet legend()}
		{#if prepared.length > 1}
			<Legend
				items={prepared.map((s) => ({
					key: s.key,
					label: s.label,
					color: s.color,
					value: valueFormat(s.points[s.points.length - 1]?.value ?? 0)
				}))}
			/>
		{/if}
	{/snippet}

	{#snippet children(g: Geometry)}
		{@const x = xScale(g)}
		{@const y = yScale(g)}
		{@const bw = barWidth(g)}
		{@const hoverT = hoverIdx !== null ? times[hoverIdx] : undefined}

		{#each yTicks as t (t)}
			<line class="grid" x1="0" x2={g.innerWidth} y1={y(t)} y2={y(t)} />
			<text class="y-tick" x="-10" y={y(t) + 4}>{fmtCompact(t)}</text>
		{/each}

		{#each xTicks(x, g.innerWidth) as tick (tick.t.getTime())}
			<text class="x-tick" x={tick.x} y={g.innerHeight + 18} style:text-anchor={tick.anchor}
				>{tick.text}</text
			>
		{/each}

		{#each prepared as s (s.key)}
			{#if s.render === 'bar'}
				{#each s.points as p (p.t)}
					<path
						d={barPathV(x(p.date) - bw / 2, y(p.value), bw, g.innerHeight - y(p.value))}
						fill={s.color}
						opacity={hoverT !== undefined && p.t !== hoverT ? 0.45 : 0.9}
					/>
				{/each}
			{:else}
				<path class="wash" d={areaPath(s, g)} fill={s.color} />
				<path class="stroke" d={linePath(s, g)} stroke={s.color} />
			{/if}
		{/each}

		<!-- crosshair -->
		{#if hoverT !== undefined}
			<line class="crosshair" x1={x(hoverT)} x2={x(hoverT)} y1="0" y2={g.innerHeight} />
			{#each prepared as s (s.key)}
				{@const p = hoverIdx !== null ? s.points[hoverIdx] : undefined}
				{#if p && s.render !== 'bar'}
					<circle class="dot" cx={x(p.date)} cy={y(p.value)} r="4.5" fill={s.color} />
				{/if}
			{/each}
		{/if}

		<!-- single-point fallback: a lone dot has no line to read -->
		{#each prepared as s (s.key)}
			{#if s.points.length === 1 && s.render !== 'bar'}
				{@const p = s.points[0]}
				{#if p}<circle class="dot" cx={x(p.date)} cy={y(p.value)} r="5" fill={s.color} />{/if}
			{/if}
		{/each}

		<rect
			class="hit"
			x="0"
			y="0"
			width={g.innerWidth}
			height={g.innerHeight}
			onpointermove={(e) => onMove(e, g)}
			onpointerleave={() => (hoverIdx = null)}
			role="presentation"
		/>
	{/snippet}

	{#snippet overlay(g: Geometry)}
		{#if hoverIdx !== null}
			{@const idx = hoverIdx}
			{@const t = times[idx]}
			{#if t !== undefined}
				{@const at = new Date(t)}
				<Tooltip
					x={g.margin.left + xScale(g)(at)}
					y={g.margin.top + g.innerHeight / 2}
					containerWidth={plotW || g.width}
					title={fmtFull(at)}
					rows={prepared.map((s) => ({
						label: s.label,
						value: valueFormat(s.points[idx]?.value ?? 0),
						color: s.color
					}))}
				/>
			{/if}
		{/if}
	{/snippet}
</ChartFrame>

<style>
	:global(.chart-frame) .grid {
		stroke: var(--hairline);
		stroke-width: 1;
	}

	:global(.chart-frame) text.y-tick {
		fill: var(--text-faint);
		font-size: 10px;
		text-anchor: end;
		font-variant-numeric: tabular-nums;
	}

	:global(.chart-frame) text.x-tick {
		fill: var(--text-faint);
		font-size: 10px;
		text-anchor: middle;
		font-variant-numeric: tabular-nums;
	}

	.wash {
		opacity: 0.14;
	}

	.stroke {
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.crosshair {
		stroke: var(--hairline-strong);
		stroke-width: 1;
	}

	.dot {
		stroke: var(--card);
		stroke-width: 2;
	}

	.hit {
		fill: transparent;
	}
</style>
