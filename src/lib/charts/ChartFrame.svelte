<!--
  ChartFrame — the card every chart lives in.

  Owns: the title/subtitle block, the legend row, responsive width measurement,
  the margin convention, and the empty state. Charts compose it and render
  their marks through the `children` snippet, which receives the measured
  Geometry so every scale can be a `$derived` of it.

  `height` may be a function of innerWidth for charts whose height depends on
  how many rows fit (the calendar heatmap).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { DEFAULT_MARGIN, type Geometry, type Margin } from './scales';

	type Props = {
		/** Card heading. Omit for a bare plot. */
		title?: string;
		/** One line under the title — units, range, method. */
		subtitle?: string;
		/** Required: what a screen reader hears instead of the marks. */
		ariaLabel: string;
		/** SVG height in px, or a function of the inner (post-margin) width. */
		height: number | ((innerWidth: number) => number);
		/** Overrides merged over DEFAULT_MARGIN; may depend on measured width. */
		margin?: Partial<Margin> | ((width: number) => Partial<Margin>);
		/** 'svg' wraps children in <svg><g transform>; 'flow' renders plain HTML. */
		layout?: 'svg' | 'flow';
		/** Render the empty state instead of the plot. */
		empty?: boolean;
		emptyMessage?: string;
		/** Legend row, between the header and the plot. Required for ≥2 series. */
		legend?: Snippet;
		/** Controls parked at the top right of the header. */
		actions?: Snippet;
		/** Absolutely-positioned HTML over the plot — tooltips live here. */
		overlay?: Snippet<[Geometry]>;
		/** Notes under the plot. */
		footer?: Snippet;
		children: Snippet<[Geometry]>;
	};

	let {
		title,
		subtitle,
		ariaLabel,
		height,
		margin,
		layout = 'svg',
		empty = false,
		emptyMessage = 'No data in this range',
		legend,
		actions,
		overlay,
		footer,
		children
	}: Props = $props();

	let width = $state(0);

	const m = $derived<Margin>({
		...DEFAULT_MARGIN,
		...(typeof margin === 'function' ? margin(width) : margin)
	});
	const innerWidth = $derived(Math.max(0, width - m.left - m.right));
	const svgHeight = $derived(typeof height === 'function' ? height(innerWidth) : height);
	const innerHeight = $derived(Math.max(0, svgHeight - m.top - m.bottom));
	const geom = $derived<Geometry>({
		width,
		height: svgHeight,
		innerWidth,
		innerHeight,
		margin: m
	});
	const fallbackHeight = $derived(typeof height === 'function' ? 180 : height);
</script>

<figure class="chart-frame card">
	{#if title || subtitle || actions}
		<header>
			<div class="titles">
				{#if title}<h3>{title}</h3>{/if}
				{#if subtitle}<p class="sub">{subtitle}</p>{/if}
			</div>
			{#if actions}<div class="actions">{@render actions()}</div>{/if}
		</header>
	{/if}

	{#if legend && !empty}
		<div class="legend">{@render legend()}</div>
	{/if}

	<div class="plot" bind:clientWidth={width}>
		{#if empty}
			<div class="empty" style:min-height="{Math.min(fallbackHeight, 200)}px">
				<span>{emptyMessage}</span>
			</div>
		{:else if width > 0 && svgHeight > 0}
			{#if layout === 'svg'}
				<svg
					{width}
					height={svgHeight}
					viewBox="0 0 {width} {svgHeight}"
					role="img"
					aria-label={ariaLabel}
				>
					<g transform="translate({m.left},{m.top})">
						{@render children(geom)}
					</g>
				</svg>
			{:else}
				<div class="flow" role="img" aria-label={ariaLabel}>
					{@render children(geom)}
				</div>
			{/if}
			{#if overlay}{@render overlay(geom)}{/if}
		{/if}
	</div>

	{#if footer}
		<figcaption class="foot">{@render footer()}</figcaption>
	{/if}
</figure>

<style>
	.chart-frame {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin: 0;
		padding: 18px 18px 16px;
		min-width: 0;
	}

	header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}

	.titles {
		min-width: 0;
	}

	h3 {
		font-size: 0.95rem;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text);
	}

	.sub {
		margin: 3px 0 0;
		font-size: 0.78rem;
		line-height: 1.35;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.actions {
		flex: none;
	}

	.legend {
		margin-top: -2px;
	}

	.plot {
		position: relative;
		width: 100%;
		min-width: 0;
	}

	.plot :global(svg) {
		display: block;
		overflow: visible;
	}

	.empty {
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1px dashed var(--hairline-strong);
		border-radius: var(--radius-sm);
		color: var(--text-faint);
		font-size: 0.82rem;
	}

	.foot {
		font-size: 0.75rem;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
</style>
