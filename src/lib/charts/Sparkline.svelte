<!--
  Sparkline — the trend line inside a stat tile.

  Deliberately chrome-free: no axes, no gridlines, no tooltip. It shows shape,
  and the tile's value + delta carry the numbers. Sized in px rather than
  measured, because it lives inline in a fixed-width tile.
-->
<script lang="ts">
	import { extent } from 'd3-array';
	import { scaleLinear } from 'd3-scale';
	import { area, curveMonotoneX, line } from 'd3-shape';
	import { CATEGORICAL, fmtCompact } from './scales';

	type Props = {
		values: number[];
		width?: number;
		height?: number;
		color?: string;
		/** Mark the last point with a dot. */
		showEnd?: boolean;
		/** Draw the 10% wash under the line. */
		filled?: boolean;
		ariaLabel?: string;
		/** Formats numbers in the generated aria-label. */
		valueFormat?: (n: number) => string;
	};

	let {
		values,
		width = 96,
		height = 28,
		color = CATEGORICAL[0],
		showEnd = true,
		filled = true,
		ariaLabel,
		valueFormat = fmtCompact
	}: Props = $props();

	const PAD = 3;

	const clean = $derived(values.filter((v) => Number.isFinite(v)));

	const x = $derived(
		scaleLinear()
			.domain([0, Math.max(1, clean.length - 1)])
			.range([PAD, Math.max(PAD + 1, width - PAD)])
	);

	const y = $derived.by(() => {
		const e = extent(clean);
		const lo = e[0] ?? 0;
		const hi = e[1] ?? 1;
		const pad = hi === lo ? Math.abs(hi || 1) * 0.5 : 0;
		return scaleLinear()
			.domain([lo - pad, hi + pad])
			.range([height - PAD, PAD]);
	});

	const linePath = $derived(
		line<number>()
			.x((_, i) => x(i))
			.y((v) => y(v))
			.curve(curveMonotoneX)(clean) ?? ''
	);

	const areaPath = $derived(
		area<number>()
			.x((_, i) => x(i))
			.y0(height)
			.y1((v) => y(v))
			.curve(curveMonotoneX)(clean) ?? ''
	);

	const last = $derived(clean[clean.length - 1] ?? 0);
	const first = $derived(clean[0] ?? 0);

	const label = $derived(
		ariaLabel ??
			`Trend over ${clean.length} points, ${valueFormat(first)} to ${valueFormat(last)}` +
				`${first !== 0 ? `, ${last >= first ? 'up' : 'down'} ${Math.abs(Math.round(((last - first) / Math.abs(first)) * 100))}%` : ''}.`
	);
</script>

{#if clean.length === 0}
	<span class="spark-empty" style:width="{width}px" style:height="{height}px" aria-hidden="true"
	></span>
{:else if clean.length === 1}
	<!-- one point has no trend: show the mark, not a flat lie -->
	<svg {width} {height} viewBox="0 0 {width} {height}" role="img" aria-label={label}>
		<circle cx={width / 2} cy={height / 2} r="3.5" style:fill={color} />
	</svg>
{:else}
	<svg {width} {height} viewBox="0 0 {width} {height}" role="img" aria-label={label}>
		{#if filled}<path d={areaPath} style:fill={color} class="wash" />{/if}
		<path d={linePath} class="stroke" style:stroke={color} />
		{#if showEnd}
			<circle cx={x(clean.length - 1)} cy={y(last)} r="3" style:fill={color} class="end" />
		{/if}
	</svg>
{/if}

<style>
	svg {
		display: block;
		overflow: visible;
	}

	.wash {
		opacity: 0.16;
	}

	.stroke {
		fill: none;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.end {
		stroke: var(--card);
		stroke-width: 2;
	}

	.spark-empty {
		display: inline-block;
	}
</style>
