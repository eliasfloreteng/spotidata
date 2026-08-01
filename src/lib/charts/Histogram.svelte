<!--
  Histogram — distribution of a single measure (release year, track duration).

  One measure, one series, one hue — no legend, because the title names what is
  plotted. Bins come from d3-array; columns are capped at 24px with a 2px
  surface gap so neighbours separate without a stroke.
-->
<script lang="ts">
	import { bin, extent, max, mean, median } from 'd3-array';
	import { scaleLinear } from 'd3-scale';
	import ChartFrame from './ChartFrame.svelte';
	import Tooltip from './Tooltip.svelte';
	import { barPathV, CATEGORICAL, fmtCompact, fmtInt, niceTicks, type Geometry } from './scales';

	type Props = {
		/** Raw observations. Binned here. */
		values: number[];
		/** Target bin count — d3 picks the nearest nice step. */
		binCount?: number;
		/** Force the x extent, e.g. [1960, 2026]. */
		domain?: [number, number];
		title?: string;
		subtitle?: string;
		ariaLabel?: string;
		height?: number;
		/** Formats x ticks and the tooltip's bin range. */
		xFormat?: (n: number) => string;
		/** Formats the count. */
		yFormat?: (n: number) => string;
		/** Noun for the x measure, e.g. "release year". */
		xLabel?: string;
		/** Noun for the count, e.g. "tracks". */
		unit?: string;
		color?: string;
		/** Draw a dashed marker at the median. */
		showMedian?: boolean;
	};

	let {
		values,
		binCount = 24,
		domain,
		title = 'Distribution',
		subtitle,
		ariaLabel,
		height = 240,
		xFormat = (n: number) => fmtCompact(n),
		yFormat = fmtInt,
		xLabel = 'value',
		unit = 'items',
		color = CATEGORICAL[0],
		showMedian = true
	}: Props = $props();

	const clean = $derived(values.filter((v) => Number.isFinite(v)));

	const xDomain = $derived.by<[number, number]>(() => {
		if (domain) return domain;
		const e = extent(clean);
		const lo = e[0] ?? 0;
		const hi = e[1] ?? 1;
		return lo === hi ? [lo - 0.5, hi + 0.5] : [lo, hi];
	});

	const bins = $derived.by(() => {
		if (clean.length === 0) return [];
		return bin()
			.domain(xDomain)
			.thresholds(Math.max(2, binCount))(clean)
			.map((b) => ({
				x0: b.x0 ?? xDomain[0],
				x1: b.x1 ?? xDomain[1],
				count: b.length
			}));
	});

	const yMax = $derived(max(bins, (b) => b.count) ?? 0);
	const yTicks = $derived(niceTicks(0, yMax || 1, 4));
	const yTop = $derived(Math.max(yTicks[yTicks.length - 1] ?? 1, yMax, 1));
	const mid = $derived(median(clean) ?? 0);
	const avg = $derived(mean(clean) ?? 0);

	function xScale(g: Geometry) {
		return scaleLinear().domain(xDomain).range([0, Math.max(1, g.innerWidth)]);
	}

	function yScale(g: Geometry) {
		return scaleLinear().domain([0, yTop]).range([Math.max(1, g.innerHeight), 0]);
	}

	let hover = $state<{ i: number; x: number; y: number } | null>(null);

	const label = $derived(
		ariaLabel ??
			`Histogram of ${xLabel} across ${fmtInt(clean.length)} ${unit}, ` +
				`${xFormat(xDomain[0])} to ${xFormat(xDomain[1])}. ` +
				`Median ${xFormat(mid)}, mean ${xFormat(avg)}. Tallest bin holds ${yFormat(yMax)} ${unit}.`
	);
</script>

<ChartFrame
	{title}
	subtitle={subtitle ?? (clean.length > 0 ? `${fmtInt(clean.length)} ${unit} · median ${xFormat(mid)}` : undefined)}
	ariaLabel={label}
	{height}
	margin={{ top: 12, right: 14, bottom: 30, left: 46 }}
	empty={clean.length === 0}
>
	{#snippet children(g: Geometry)}
		{@const x = xScale(g)}
		{@const y = yScale(g)}

		{#each yTicks as t (t)}
			<line class="grid" x1="0" x2={g.innerWidth} y1={y(t)} y2={y(t)} />
			<text class="y-tick" x="-10" y={y(t) + 4}>{fmtCompact(t)}</text>
		{/each}

		{#each niceTicks(xDomain[0], xDomain[1], Math.max(2, Math.floor(g.innerWidth / 78))) as t (t)}
			{#if t >= xDomain[0] && t <= xDomain[1]}
				{@const tx = x(t)}
				<text
					class="x-tick"
					x={tx}
					y={g.innerHeight + 18}
					style:text-anchor={tx < 22 ? 'start' : tx > g.innerWidth - 22 ? 'end' : 'middle'}
					>{xFormat(t)}</text
				>
			{/if}
		{/each}

		{#each bins as b, i (b.x0)}
			{@const w = Math.max(1, Math.min(24, x(b.x1) - x(b.x0) - 2))}
			{@const bx = x(b.x0) + (x(b.x1) - x(b.x0) - w) / 2}
			<path
				d={barPathV(bx, y(b.count), w, g.innerHeight - y(b.count))}
				fill={color}
				opacity={hover !== null && hover.i !== i ? 0.5 : 1}
			/>
			<rect
				class="hit"
				x={x(b.x0)}
				y="0"
				width={Math.max(1, x(b.x1) - x(b.x0))}
				height={g.innerHeight}
				role="presentation"
				onmouseenter={() =>
					(hover = { i, x: g.margin.left + bx + w / 2, y: g.margin.top + y(b.count) })}
				onmouseleave={() => (hover = null)}
			/>
		{/each}

		{#if showMedian && clean.length > 1}
			<line class="median" x1={x(mid)} x2={x(mid)} y1="-2" y2={g.innerHeight} />
			<text class="median-label" x={x(mid)} y={-2}>median {xFormat(mid)}</text>
		{/if}

		<line class="axis" x1="0" x2={g.innerWidth} y1={g.innerHeight} y2={g.innerHeight} />
	{/snippet}

	{#snippet overlay(g: Geometry)}
		{#if hover}
			{@const b = bins[hover.i]}
			{#if b}
				<Tooltip
					x={hover.x}
					y={hover.y}
					containerWidth={g.width}
					title="{xFormat(b.x0)} – {xFormat(b.x1)}"
					rows={[{ label: unit, value: yFormat(b.count), color }]}
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

	:global(.chart-frame) .axis {
		stroke: var(--hairline-strong);
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

	.median {
		stroke: var(--text-faint);
		stroke-width: 1;
		stroke-dasharray: 3 3;
	}

	:global(.chart-frame) text.median-label {
		fill: var(--text-muted);
		font-size: 10px;
		text-anchor: middle;
		font-variant-numeric: tabular-nums;
	}

	.hit {
		fill: transparent;
	}
</style>
