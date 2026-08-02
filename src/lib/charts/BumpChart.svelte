<!--
  BumpChart — rank over time.

  Identity is the job, so series wear the validated categorical slots in a fixed
  order (assigned by their rank in the first period they appear, so a filter that
  drops a series never repaints the survivors). Lines cross freely, which is the
  all-pairs case the palette caps at three slots — so every series carries
  secondary encoding: a direct label at BOTH ends plus hover isolation.

  Past the eight slots the palette cycles rather than folding the tail into one
  grey, which would leave those series identical to EACH OTHER — the one thing
  the slots exist to prevent. Each pass over the hues takes its own stroke
  pattern (solid, dashed, dotted) and every pass after the first draws hollow
  dots, so a repeated hue is still a distinct mark, and the ordering guarantees
  the members of a hue's family are ranks apart rather than adjacent.
-->
<script lang="ts">
	import { line, curveBumpX } from 'd3-shape';
	import { scalePoint, scaleLinear } from 'd3-scale';
	import ChartFrame from './ChartFrame.svelte';
	import Legend from './Legend.svelte';
	import Tooltip from './Tooltip.svelte';
	import { CATEGORICAL, fmtInt, seriesColor, type Geometry } from './scales';
	import type { BumpDatum } from './types';

	type Props = {
		data: BumpDatum[];
		/** Ranks below this are dropped. */
		topN?: number;
		title?: string;
		subtitle?: string;
		ariaLabel?: string;
		height?: number;
		valueFormat?: (n: number) => string;
		/** Noun for the value in the tooltip. */
		unit?: string;
		/** Label for a datum's `delta` row; omitted when no datum carries one. */
		deltaLabel?: string;
	};

	let {
		data,
		topN = 8,
		title = 'Rank over time',
		subtitle,
		ariaLabel,
		height = 340,
		valueFormat = fmtInt,
		unit = 'plays',
		deltaLabel = 'new this period'
	}: Props = $props();

	const DOT_R = 4.5;
	const RANK_GUTTER = 26;

	const clean = $derived(data.filter((d) => Number.isFinite(d.rank) && d.rank >= 1 && d.rank <= topN));

	/**
	 * The y domain follows the ranks actually present, not topN: a series can
	 * sit out a period, so a cohort of N often never fills N places at once and
	 * a fixed domain would leave dead gridlines under the lines.
	 */
	const maxRank = $derived(Math.max(2, ...clean.map((d) => d.rank)));

	/** Periods in first-seen order, numerically sorted when they are numbers. */
	const periods = $derived.by(() => {
		const seen: (string | number)[] = [];
		for (const d of clean) if (!seen.includes(d.period)) seen.push(d.period);
		const allNumeric = seen.every((p) => typeof p === 'number' || /^\d+$/.test(String(p)));
		return allNumeric ? seen.slice().sort((a, b) => Number(a) - Number(b)) : seen;
	});

	type Series = {
		key: string;
		label: string;
		color: string;
		/** Stroke pattern for this pass over the palette; undefined is solid. */
		dash: string | undefined;
		/** Past the first pass round the palette — drawn with hollow dots. */
		repeat: boolean;
		points: (BumpDatum | null)[];
	};

	/** One stroke per pass over the hues: 8 slots × 3 = 24 distinguishable series. */
	const DASHES = [undefined, '7 5', '1.5 4'];

	const series = $derived.by<Series[]>(() => {
		const groups = new Map<string, BumpDatum[]>();
		for (const d of clean) {
			const bucket = groups.get(d.key);
			if (bucket) bucket.push(d);
			else groups.set(d.key, [d]);
		}
		// Colour follows the entity: ordered by (first period seen, then rank there).
		const ordered = [...groups.entries()].sort((a, b) => {
			const fa = a[1].reduce((best, d) => Math.min(best, periods.indexOf(d.period)), Infinity);
			const fb = b[1].reduce((best, d) => Math.min(best, periods.indexOf(d.period)), Infinity);
			if (fa !== fb) return fa - fb;
			const ra = a[1].find((d) => periods.indexOf(d.period) === fa)?.rank ?? topN;
			const rb = b[1].find((d) => periods.indexOf(d.period) === fb)?.rank ?? topN;
			return ra - rb;
		});
		return ordered.map(([key, rows], i) => {
			const pass = Math.floor(i / CATEGORICAL.length);
			return {
				key,
				label: rows[0]?.label ?? key,
				color: seriesColor(i % CATEGORICAL.length),
				dash: DASHES[pass % DASHES.length],
				repeat: pass > 0,
				points: periods.map((p) => rows.find((r) => r.period === p) ?? null)
			};
		});
	});

	/**
	 * A cohort that is the union of each period's top N runs to many times N, and
	 * a legend that long is a wall of names rather than a key — it costs more rows
	 * than the plot and nobody scans it for the entry they want. Past the point
	 * where hue plus stroke still names a series on its own, the direct labels at
	 * both ends of every line carry identity by themselves and the legend is
	 * dropped.
	 */
	const keyable = $derived(series.length <= CATEGORICAL.length * DASHES.length);

	/** Reserve just enough gutter for the longest label, within sane bounds. */
	const labelWidth = $derived(
		Math.min(150, Math.max(70, 7 * Math.max(6, ...series.map((s) => s.label.length))))
	);

	/** With a single period there is no line — one label per series, on the right. */
	const singlePeriod = $derived(periods.length < 2);

	/**
	 * A series that only holds a place for part of the span is labelled where it
	 * enters or leaves, and that label sits inside the plot rather than in a
	 * gutter — so the periods have to stand a label apart, not just a dot apart,
	 * or the interior names run into their neighbours.
	 */
	const interiorLabels = $derived(
		series.some((s) => {
			const first = s.points.findIndex((p) => p !== null);
			const revIdx = [...s.points].reverse().findIndex((p) => p !== null);
			const last = revIdx < 0 ? -1 : s.points.length - 1 - revIdx;
			return first > 0 || (last >= 0 && last < periods.length - 1);
		})
	);

	/**
	 * Below this the periods sit closer together than their marks are wide and
	 * the crossings stop being readable, so the chart scrolls instead. Both label
	 * gutters have to fit inside it or the plot area itself goes to nothing.
	 *
	 * An interior gap can hold two names — one series leaving at this period, the
	 * next arriving at the following one — and each stands its own RANK_GUTTER off
	 * its dot, so the gap owes a label plus both of those clearances or the two
	 * names meet in the middle and read as one.
	 */
	const minWidth = $derived(
		singlePeriod
			? 0
			: periods.length * (interiorLabels ? labelWidth + 2 * RANK_GUTTER : 46) +
				2 * (labelWidth + RANK_GUTTER)
	);

	/**
	 * Gutters are a function of the measured width: in a narrow card the plot
	 * must not be squeezed to nothing (or the marks pile up on the axis), so the
	 * label gutter gives way first, down to a floor.
	 */
	const margin = $derived((width: number) => {
		const budget = Math.max(0, width - 120);
		// RANK_GUTTER keeps the rank numbers off the direct labels.
		const right = Math.max(52, Math.min(labelWidth + RANK_GUTTER, singlePeriod ? budget : budget / 2));
		const left = singlePeriod ? RANK_GUTTER : right;
		return { top: 30, right, bottom: 24, left };
	});

	function xScale(g: Geometry) {
		return scalePoint<string>()
			.domain(periods.map(String))
			.range([0, Math.max(1, g.innerWidth)])
			.padding(periods.length === 1 ? 0.5 : 0);
	}

	function yScale(g: Geometry) {
		return scaleLinear()
			.domain([1, maxRank])
			.range([0, Math.max(1, g.innerHeight)]);
	}

	function pathFor(s: Series, g: Geometry): string {
		const x = xScale(g);
		const y = yScale(g);
		const gen = line<{ p: string; rank: number | null }>()
			.defined((d) => d.rank !== null)
			.x((d) => x(d.p) ?? 0)
			.y((d) => y(d.rank ?? 1))
			.curve(curveBumpX);
		return gen(periods.map((p, i) => ({ p: String(p), rank: s.points[i]?.rank ?? null }))) ?? '';
	}

	let hovered = $state<string | null>(null);
	let tip = $state<{ x: number; y: number; label: string; color: string; period: string; rank: number; value: number; delta?: number } | null>(null);

	const firstPeriod = $derived(periods[0]);
	const lastPeriod = $derived(periods[periods.length - 1]);

	const label = $derived(
		ariaLabel ??
			`Bump chart of top ${topN} ${unit} rank across ${periods.length} periods` +
				`${firstPeriod !== undefined ? `, ${firstPeriod} to ${lastPeriod}` : ''}. ` +
				series
					.slice(0, topN)
					.map((s) => {
						const last = [...s.points].reverse().find((p) => p !== null);
						return last ? `${s.label} ends at rank ${last.rank}` : `${s.label} no longer ranked`;
					})
					.join('; ') +
				'.'
	);
</script>

{#snippet legendRow()}
	<Legend
		mark="dot"
		active={hovered}
		onhover={(k) => (hovered = k)}
		items={series.map((s) => ({
			key: s.key,
			label: s.label,
			color: s.color,
			hollow: s.repeat
		}))}
	/>
{/snippet}

<ChartFrame
	{title}
	{subtitle}
	ariaLabel={label}
	{height}
	{minWidth}
	{margin}
	legend={keyable ? legendRow : undefined}
	empty={series.length === 0 || periods.length === 0}
>
	{#snippet children(g: Geometry)}
		{@const x = xScale(g)}
		{@const y = yScale(g)}

		<!-- rank gridlines -->
		{#each Array.from({ length: maxRank }, (_, i) => i + 1) as rank (rank)}
			<line class="grid" x1="0" x2={g.innerWidth} y1={y(rank)} y2={y(rank)} />
			<text class="rank-tick" x="-9" y={y(rank) + 4}>{rank}</text>
			<text class="rank-tick" x={g.innerWidth + 9} y={y(rank) + 4} text-anchor="start">{rank}</text>
		{/each}

		<!-- period ticks -->
		{#each periods as p (p)}
			<text class="period" x={x(String(p)) ?? 0} y={-15}>{p}</text>
		{/each}

		<!-- Three passes, because z-order is what makes the hover honest: every fat
		     hit line goes down first, so a dot is always the topmost thing under
		     the cursor and the tooltip can never disagree with the highlight. -->
		{#each series as s (s.key)}
			<path
				class="hit"
				d={pathFor(s, g)}
				onmouseenter={() => (hovered = s.key)}
				onmouseleave={() => {
					hovered = null;
					tip = null;
				}}
				role="presentation"
			/>
		{/each}

		{#each series as s (s.key)}
			{@const dim = hovered !== null && hovered !== s.key}
			<path
				class="line"
				d={pathFor(s, g)}
				stroke={s.color}
				stroke-width={hovered === s.key ? 3 : 2}
				stroke-dasharray={s.dash}
				opacity={dim ? 0.14 : 1}
			/>
		{/each}

		{#each series as s (s.key)}
			{@const dim = hovered !== null && hovered !== s.key}
			{@const firstIdx = s.points.findIndex((p) => p !== null)}
			{@const revIdx = [...s.points].reverse().findIndex((p) => p !== null)}
			{@const lastIdx = revIdx < 0 ? -1 : s.points.length - 1 - revIdx}
			{@const head = firstIdx >= 0 ? (s.points[firstIdx] ?? null) : null}
			{@const tail = lastIdx >= 0 ? (s.points[lastIdx] ?? null) : null}
			{@const headX = x(String(periods[firstIdx] ?? '')) ?? 0}
			{@const tailX = x(String(periods[lastIdx] ?? '')) ?? 0}
			<!--
				A series that holds a place in exactly one period is a single dot, and
				both of its ends are that same dot — so it takes one label rather than
				two printed back to back around it. It goes on whichever side lands in
				a gutter: the right when the dot sits in the last period, the left
				otherwise.
			-->
			{@const oneDot = firstIdx >= 0 && firstIdx === lastIdx}
			{@const atLastPeriod = lastIdx === periods.length - 1}
			{@const showHead = head !== null && !singlePeriod && !(oneDot && atLastPeriod)}
			{@const showTail = tail !== null && (!oneDot || singlePeriod || atLastPeriod)}
			<g class="series" opacity={dim ? 0.14 : 1}>
				{#each s.points as pt, i (i)}
					{#if pt}
						<circle
							cx={x(String(periods[i] ?? '')) ?? 0}
							cy={y(pt.rank)}
							r={DOT_R}
							fill={s.repeat ? 'var(--card)' : s.color}
							stroke={s.repeat ? s.color : undefined}
							class="dot"
							role="presentation"
							onmouseenter={() => {
								hovered = s.key;
								tip = {
									x: g.margin.left + (x(String(periods[i] ?? '')) ?? 0),
									y: g.margin.top + y(pt.rank),
									label: s.label,
									color: s.color,
									period: String(pt.period),
									rank: pt.rank,
									value: pt.value,
									delta: pt.delta
								};
							}}
							onmouseleave={() => {
								hovered = null;
								tip = null;
							}}
						/>
					{/if}
				{/each}

				<!-- direct labels at both ends: the secondary encoding that lets 8
				     crossing series share a palette validated for adjacency only -->
				{#if showHead && head}
					<text class="end-label" text-anchor="end" x={headX - RANK_GUTTER} y={y(head.rank)}
						>{s.label}</text
					>
				{/if}
				{#if showTail && tail}
					<text class="end-label" text-anchor="start" x={tailX + RANK_GUTTER} y={y(tail.rank)}
						>{s.label}</text
					>
				{/if}
			</g>
		{/each}
	{/snippet}

	{#snippet overlay(g: Geometry)}
		{#if tip}
			<Tooltip
				x={tip.x}
				y={tip.y}
				containerWidth={g.width}
				title={tip.label}
				rows={[
					{ label: String(tip.period), value: `#${tip.rank}`, color: tip.color },
					{ label: unit, value: valueFormat(tip.value) },
					...(tip.delta === undefined
						? []
						: [
								{
									label: deltaLabel,
									// Signed, because a delta against a previous period can fall.
									value: `${tip.delta < 0 ? '−' : '+'}${valueFormat(Math.abs(tip.delta))}`
								}
							])
				]}
			/>
		{/if}
	{/snippet}
</ChartFrame>

<style>
	:global(.chart-frame) .grid {
		stroke: var(--hairline);
		stroke-width: 1;
	}

	:global(.chart-frame) text.rank-tick {
		fill: var(--text-faint);
		font-size: 10px;
		text-anchor: end;
		font-variant-numeric: tabular-nums;
	}

	:global(.chart-frame) text.period {
		fill: var(--text-muted);
		font-size: 11px;
		text-anchor: middle;
		font-variant-numeric: tabular-nums;
	}

	:global(.chart-frame) text.end-label {
		fill: var(--text);
		font-size: 11px;
		dominant-baseline: middle;
	}

	.series {
		transition: opacity 0.15s ease;
	}

	.line {
		fill: none;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.hit {
		fill: none;
		stroke: transparent;
		stroke-width: 14;
		cursor: pointer;
	}

	.dot {
		/* the 2px surface ring keeps dots legible where lines cross */
		stroke: var(--card);
		stroke-width: 2;
		cursor: pointer;
	}
</style>
