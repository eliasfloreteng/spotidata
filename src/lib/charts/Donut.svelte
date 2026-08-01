<!--
  Donut — part-to-whole for a small, fixed set of categories.

  Slices are a stack, so the ADJACENT pairlist governs and the palette's fixed
  slot order is safe. Anything past `maxSlices` folds into a grey "Other" rather
  than inventing a ninth hue. Segments are separated by a 2px surface gap (a
  pad angle in surface colour), never a stroke around the mark.
-->
<script lang="ts">
	import { arc, pie } from 'd3-shape';
	import ChartFrame from './ChartFrame.svelte';
	import Legend from './Legend.svelte';
	import Tooltip from './Tooltip.svelte';
	import { fmtInt, fmtPct, OTHER_COLOR, seriesColor, type Geometry } from './scales';
	import type { DonutDatum } from './types';

	type Props = {
		data: DonutDatum[];
		/** Slices past this fold into a single grey "Other". Hard cap of 8. */
		maxSlices?: number;
		title?: string;
		subtitle?: string;
		ariaLabel?: string;
		height?: number;
		/** Big number in the hole. Defaults to the total. */
		centerValue?: string;
		/** Caption under the centre value. */
		centerLabel?: string;
		valueFormat?: (n: number) => string;
		unit?: string;
	};

	let {
		data,
		maxSlices = 6,
		title = 'Share',
		subtitle,
		ariaLabel,
		height = 240,
		centerValue,
		centerLabel = 'total',
		valueFormat = fmtInt,
		unit = 'plays'
	}: Props = $props();

	type Slice = { key: string; label: string; value: number; color: string; share: number };

	const slices = $derived.by<Slice[]>(() => {
		const clean = data
			.filter((d) => Number.isFinite(d.value) && d.value > 0)
			.sort((a, b) => b.value - a.value);
		const total = clean.reduce((t, d) => t + d.value, 0);
		if (total <= 0) return [];
		const cap = Math.max(1, Math.min(8, maxSlices));
		const head = clean.slice(0, cap);
		const tailSum = clean.slice(cap).reduce((t, d) => t + d.value, 0);
		const out: Slice[] = head.map((d, i) => ({
			key: d.key ?? d.label,
			label: d.label,
			value: d.value,
			color: seriesColor(i),
			share: d.value / total
		}));
		if (tailSum > 0) {
			out.push({
				key: '__other__',
				label: `Other (${clean.length - cap})`,
				value: tailSum,
				color: OTHER_COLOR,
				share: tailSum / total
			});
		}
		return out;
	});

	const total = $derived(slices.reduce((t, s) => t + s.value, 0));

	const layout = $derived(
		pie<Slice>()
			.value((d) => d.value)
			.sort(null)
			.padAngle(0.012)(slices)
	);

	let hovered = $state<string | null>(null);
	let tip = $state<{ x: number; y: number; slice: Slice } | null>(null);

	const label = $derived(
		ariaLabel ??
			`Donut chart of ${unit} by share. Total ${valueFormat(total)}. ` +
				slices.map((s) => `${s.label} ${fmtPct(s.share)}`).join(', ') +
				'.'
	);
</script>

<ChartFrame
	{title}
	{subtitle}
	ariaLabel={label}
	{height}
	margin={{ top: 4, right: 4, bottom: 4, left: 4 }}
	empty={slices.length === 0}
>
	{#snippet legend()}
		<Legend
			active={hovered}
			onhover={(k) => (hovered = k)}
			items={slices.map((s) => ({
				key: s.key,
				label: s.label,
				color: s.color,
				value: fmtPct(s.share)
			}))}
		/>
	{/snippet}

	{#snippet children(g: Geometry)}
		{@const r = Math.max(20, Math.min(g.innerWidth, g.innerHeight) / 2)}
		{@const cx = g.innerWidth / 2}
		{@const cy = g.innerHeight / 2}
		{@const gen = arc<(typeof layout)[number]>()
			.innerRadius(r * 0.62)
			.outerRadius(r)
			.cornerRadius(2)
			.padRadius(r)}
		<g transform="translate({cx},{cy})">
			{#each layout as a (a.data.key)}
				{@const dim = hovered !== null && hovered !== a.data.key}
				<path
					d={gen(a) ?? ''}
					fill={a.data.color}
					opacity={dim ? 0.28 : 1}
					class="slice"
					role="presentation"
					onmouseenter={() => {
						hovered = a.data.key;
						const c = gen.centroid(a);
						tip = {
							x: g.margin.left + cx + (c[0] ?? 0),
							y: g.margin.top + cy + (c[1] ?? 0),
							slice: a.data
						};
					}}
					onmouseleave={() => {
						hovered = null;
						tip = null;
					}}
				/>
			{/each}
			<text class="center-value num" y={-2}>{centerValue ?? valueFormat(total)}</text>
			<text class="center-label" y={16}>{centerLabel}</text>
		</g>
	{/snippet}

	{#snippet overlay(g: Geometry)}
		{#if tip}
			<Tooltip
				x={tip.x}
				y={tip.y}
				containerWidth={g.width}
				title={tip.slice.label}
				rows={[
					{ label: unit, value: valueFormat(tip.slice.value), color: tip.slice.color },
					{ label: 'share', value: fmtPct(tip.slice.share) }
				]}
			/>
		{/if}
	{/snippet}
</ChartFrame>

<style>
	.slice {
		/* the 2px surface gap between neighbours — a stroke in the card colour,
		   not a border around the mark */
		stroke: var(--card);
		stroke-width: 2;
		transition: opacity 0.15s ease;
		cursor: pointer;
	}

	:global(.chart-frame) text.center-value {
		fill: var(--text);
		font-size: 22px;
		font-weight: 600;
		text-anchor: middle;
		font-variant-numeric: tabular-nums;
	}

	:global(.chart-frame) text.center-label {
		fill: var(--text-faint);
		font-size: 11px;
		text-anchor: middle;
	}
</style>
