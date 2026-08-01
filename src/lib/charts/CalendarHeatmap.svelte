<!--
  CalendarHeatmap — commit-graph layout for daily listening.

  Day-of-week rows × week columns, month labels along the top, one row-block per
  year so a multi-year range stacks instead of scrolling sideways. Magnitude is
  the job, so colour is the brand sequential ramp in five quantile buckets
  (listening days are heavily skewed — quantiles keep the busy end readable).
-->
<script lang="ts">
	import { max, quantile } from 'd3-array';
	import { timeFormat } from 'd3-time-format';
	import { timeDay, timeMonday, timeMonth, timeSunday } from 'd3-time';
	import ChartFrame from './ChartFrame.svelte';
	import Tooltip from './Tooltip.svelte';
	import { EMPTY_CELL, fmtInt, sequentialSteps, type Geometry } from './scales';
	import type { CalendarDatum } from './types';

	type Props = {
		data: CalendarDatum[];
		weekStart?: 'monday' | 'sunday';
		title?: string;
		subtitle?: string;
		ariaLabel?: string;
		/** Render one block per calendar year (default) or one continuous block. */
		groupByYear?: boolean;
		/** Formats the value in the tooltip and the aria summary. */
		valueFormat?: (n: number) => string;
		/** Noun for the value, e.g. "plays". */
		unit?: string;
	};

	let {
		data,
		weekStart = 'monday',
		title = 'Listening calendar',
		subtitle,
		ariaLabel,
		groupByYear = true,
		valueFormat = fmtInt,
		unit = 'plays'
	}: Props = $props();

	const BUCKETS = 5;
	const STEPS = sequentialSteps(BUCKETS);
	const GAP = 2; // the surface gap — never a stroke
	const MIN_CELL = 3; // pitch, not cell size — the gap shrinks with it
	const MAX_CELL = 16;
	const GUTTER = 30; // weekday gutter, dropped when the cells get tiny
	const MONTH_H = 16;
	const YEAR_H = 20;
	const BLOCK_GAP = 16;

	const fmtDay = timeFormat('%a %-d %b %Y');
	const fmtMonth = timeFormat('%b');

	const weekOf = $derived(weekStart === 'monday' ? timeMonday : timeSunday);
	const dowOffset = $derived(weekStart === 'monday' ? 1 : 0);
	const dowLabels = $derived(
		weekStart === 'monday'
			? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
			: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
	);

	type Cell = { date: Date; value: number; row: number; col: number };
	type Block = { label: string; cells: Cell[]; columns: number; months: { col: number; name: string }[] };

	const parsed = $derived(
		data
			.map((d) => {
				const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d.day);
				if (!m) return null;
				return {
					date: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
					value: Number.isFinite(d.value) ? d.value : 0
				};
			})
			.filter((d): d is { date: Date; value: number } => d !== null)
			.sort((a, b) => a.date.getTime() - b.date.getTime())
	);

	const byDay = $derived(new Map(parsed.map((d) => [d.date.getTime(), d.value])));

	/**
	 * Bucket breaks over the non-zero days. Not even quintiles: those hand a
	 * fifth of every ordinary day the loudest colour and the grid stops reading
	 * as magnitude. The breaks are pulled toward the top of the distribution
	 * (q^0.45), so roughly half the active days sit in the quietest step and the
	 * brightest one is genuinely rare.
	 */
	const thresholds = $derived.by(() => {
		const nonZero = parsed
			.map((d) => d.value)
			.filter((v) => v > 0)
			.sort((a, b) => a - b);
		if (nonZero.length === 0) return [] as number[];
		const out: number[] = [];
		for (let i = 1; i < BUCKETS; i++) {
			out.push(quantile(nonZero, (i / BUCKETS) ** 0.45) ?? 0);
		}
		return out;
	});

	function colorFor(v: number): string {
		if (!(v > 0)) return EMPTY_CELL;
		let i = 0;
		while (i < thresholds.length && v > (thresholds[i] ?? Infinity)) i++;
		return STEPS[Math.min(i, STEPS.length - 1)] ?? EMPTY_CELL;
	}

	const blocks = $derived.by<Block[]>(() => {
		const first = parsed[0];
		const last = parsed[parsed.length - 1];
		if (!first || !last) return [];

		const ranges: { label: string; from: Date; to: Date }[] = [];
		if (groupByYear) {
			for (let y = first.date.getFullYear(); y <= last.date.getFullYear(); y++) {
				ranges.push({
					label: String(y),
					from: new Date(Math.max(new Date(y, 0, 1).getTime(), first.date.getTime())),
					to: new Date(Math.min(new Date(y, 11, 31).getTime(), last.date.getTime()))
				});
			}
		} else {
			ranges.push({ label: '', from: first.date, to: last.date });
		}

		return ranges.map(({ label, from, to }) => {
			const origin = weekOf.floor(from);
			const days = timeDay.range(from, timeDay.offset(to, 1));
			const cells: Cell[] = days.map((date) => ({
				date,
				value: byDay.get(date.getTime()) ?? 0,
				row: (date.getDay() - dowOffset + 7) % 7,
				col: weekOf.count(origin, date)
			}));
			const months = timeMonth
				.range(timeMonth.floor(from), timeDay.offset(to, 1))
				.map((mDate) => {
					const anchor = mDate < from ? from : mDate;
					return { col: weekOf.count(origin, anchor), name: fmtMonth(mDate) };
				});
			const columns = (cells[cells.length - 1]?.col ?? 0) + 1;
			return { label, cells, columns, months };
		});
	});

	const maxColumns = $derived(max(blocks, (b) => b.columns) ?? 53);
	const showYearLabel = $derived(groupByYear && blocks.length > 1);

	/**
	 * Cell pitch that FITS: the grid is never allowed to overflow its card, so a
	 * narrow column gets small cells rather than a chart that spills sideways.
	 */
	function step(innerWidth: number): number {
		const raw = Math.floor((innerWidth - gutter(innerWidth)) / Math.max(1, maxColumns));
		return Math.max(MIN_CELL, Math.min(MAX_CELL + GAP, raw));
	}

	/** The weekday gutter only earns its space once the labels are legible. */
	function gutter(innerWidth: number): number {
		return Math.floor((innerWidth - GUTTER) / Math.max(1, maxColumns)) >= 9 ? GUTTER : 0;
	}

	function blockHeight(innerWidth: number): number {
		return 7 * step(innerWidth) + MONTH_H + (showYearLabel ? YEAR_H : 0) + BLOCK_GAP;
	}

	const height = (innerWidth: number) =>
		Math.max(60, blocks.length * blockHeight(innerWidth) - BLOCK_GAP + 4);

	const total = $derived(parsed.reduce((t, d) => t + d.value, 0));
	const activeDays = $derived(parsed.filter((d) => d.value > 0).length);
	const peak = $derived(max(parsed, (d) => d.value) ?? 0);

	const label = $derived(
		ariaLabel ??
			`Calendar heatmap of daily ${unit}. ${valueFormat(total)} across ${fmtInt(activeDays)} active days` +
				`${parsed.length > 0 ? `, ${blocks.map((b) => b.label).filter(Boolean).join(' to ') || 'single period'}` : ''}. ` +
				`Busiest day ${valueFormat(peak)}.`
	);

	let hover = $state<{ x: number; y: number; date: Date; value: number } | null>(null);
</script>

<ChartFrame
	{title}
	{subtitle}
	ariaLabel={label}
	{height}
	margin={{ top: 4, right: 8, bottom: 4, left: 6 }}
	empty={parsed.length === 0}
>
	{#snippet legend()}
		<div class="scale">
			<span class="cap">Less</span>
			<i class="key" style:background={EMPTY_CELL}></i>
			{#each STEPS as c (c)}<i class="key" style:background={c}></i>{/each}
			<span class="cap">More</span>
			{#if peak > 0}
				<span class="cap peak num">peak {valueFormat(peak)}</span>
			{/if}
		</div>
	{/snippet}

	{#snippet children(g: Geometry)}
		{@const s = step(g.innerWidth)}
		{@const cell = s - (s >= 6 ? GAP : 1)}
		{@const bh = blockHeight(g.innerWidth)}
		{@const LABEL_W = gutter(g.innerWidth)}
		{#each blocks as block, bi (block.label + bi)}
			{@const top = bi * bh}
			{@const gridTop = top + (showYearLabel ? YEAR_H : 0) + MONTH_H}
			{#if showYearLabel}
				<text class="year" x="0" y={top + 13}>{block.label}</text>
			{/if}
			{#each block.months as month (month.name + month.col)}
				{#if month.col * s + 26 <= block.columns * s && s >= 6}
					<text class="month" x={LABEL_W + month.col * s} y={gridTop - 5}>{month.name}</text>
				{/if}
			{/each}
			{#each dowLabels as dow, i (dow)}
				{#if i % 2 === 0 && cell >= 9 && LABEL_W > 0}
					<text class="dow" x={LABEL_W - 6} y={gridTop + i * s + cell / 2 + 3}>{dow}</text>
				{/if}
			{/each}
			{#each block.cells as c (c.date.getTime())}
				<rect
					class="cell"
					x={LABEL_W + c.col * s}
					y={gridTop + c.row * s}
					width={cell}
					height={cell}
					rx={Math.min(3, cell / 3)}
					fill={colorFor(c.value)}
					role="presentation"
					onmouseenter={() =>
						(hover = {
							x: g.margin.left + LABEL_W + c.col * s + cell / 2,
							y: g.margin.top + gridTop + c.row * s + cell / 2,
							date: c.date,
							value: c.value
						})}
					onmouseleave={() => (hover = null)}
				/>
			{/each}
		{/each}
	{/snippet}

	{#snippet overlay(g: Geometry)}
		{#if hover}
			<Tooltip
				x={hover.x}
				y={hover.y}
				containerWidth={g.width}
				title={fmtDay(hover.date)}
				rows={[{ label: unit, value: valueFormat(hover.value) }]}
			/>
		{/if}
	{/snippet}
</ChartFrame>

<style>
	.scale {
		display: flex;
		align-items: center;
		gap: 3px;
		font-size: 0.72rem;
		color: var(--text-faint);
	}

	.cap {
		margin: 0 4px;
	}

	.cap.peak {
		margin-left: auto;
		font-variant-numeric: tabular-nums;
	}

	.key {
		width: 11px;
		height: 11px;
		border-radius: 3px;
	}

	:global(.chart-frame) text.year {
		fill: var(--text-muted);
		font-size: 11px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	:global(.chart-frame) text.month {
		fill: var(--text-faint);
		font-size: 10px;
	}

	:global(.chart-frame) text.dow {
		fill: var(--text-faint);
		font-size: 10px;
		text-anchor: end;
	}

	.cell {
		transition: opacity 0.1s ease;
	}

	.cell:hover {
		opacity: 0.75;
	}
</style>
