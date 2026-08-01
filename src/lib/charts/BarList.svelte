<!--
  BarList — horizontal ranked bars for top artists / albums / labels.

  Nominal categories, so every bar wears the SAME slot-1 hue: bar length already
  encodes the value, and spending the identity channel to re-encode it would be
  wrong. Laid out in flow (HTML) rather than SVG so long names wrap and truncate
  with real text metrics — a label is never clipped by its own mark. Rows carrying
  an `href` become links to the entity, which is also why the frame drops its
  `role="img"` summary for those lists.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { max } from 'd3-array';
	import { scaleLinear } from 'd3-scale';
	import ChartFrame from './ChartFrame.svelte';
	import { CATEGORICAL, fmtInt, fmtPct, type Geometry } from './scales';
	import type { BarListDatum } from './types';

	type Props = {
		data: BarListDatum[];
		/** Show only the first N rows. */
		limit?: number;
		title?: string;
		subtitle?: string;
		ariaLabel?: string;
		valueFormat?: (n: number) => string;
		/** How the secondary number is rendered. Defaults to a percent. */
		secondaryFormat?: (n: number) => string;
		/** Show each row's share of the total instead of a passed `secondary`. */
		showShare?: boolean;
		/** Rank number in front of each row. */
		showRank?: boolean;
		unit?: string;
		/** Bar colour. One hue for the whole list by design. */
		color?: string;
		/** Artwork edge, in px. */
		artSize?: number;
		/** Controls parked at the top right of the header — a "see all" link. */
		actions?: Snippet;
	};

	let {
		data,
		limit = 10,
		title = 'Top',
		subtitle,
		ariaLabel,
		valueFormat = fmtInt,
		secondaryFormat = (n: number) => fmtPct(n),
		showShare = false,
		showRank = true,
		unit = 'plays',
		color = CATEGORICAL[0],
		artSize = 34,
		actions
	}: Props = $props();

	const ROW = 34;

	const rows = $derived(
		data.filter((d) => Number.isFinite(d.value)).slice(0, Math.max(1, limit))
	);
	/** A null url still reserves the column; only an absent key drops it. */
	const hasArt = $derived(rows.some((d) => d.image !== undefined));
	const linked = $derived(rows.some((d) => d.href));
	const total = $derived(data.reduce((t, d) => t + (Number.isFinite(d.value) ? d.value : 0), 0));
	const top = $derived(max(rows, (d) => d.value) ?? 0);
	const scale = $derived(scaleLinear().domain([0, top || 1]).range([0, 100]).clamp(true));

	function secondaryOf(d: BarListDatum): string | null {
		if (showShare) return total > 0 ? secondaryFormat(d.value / total) : null;
		return d.secondary === undefined ? null : secondaryFormat(d.secondary);
	}

	const label = $derived(
		ariaLabel ??
			`Ranked bar list of ${rows.length} items by ${unit}. ` +
				rows
					.slice(0, 5)
					.map((d, i) => `${i + 1} ${d.label} ${valueFormat(d.value)}`)
					.join(', ') +
				'.'
	);

	const height = (): number => Math.max(60, rows.length * ROW);
</script>

<ChartFrame
	{title}
	{subtitle}
	{actions}
	ariaLabel={label}
	{height}
	layout="flow"
	semantic={linked}
	margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
	empty={rows.length === 0}
>
	{#snippet children(_g: Geometry)}
		<ol class="bars">
			{#each rows as d, i (d.label + i)}
				<li>
					{#if showRank}<span class="rank num">{i + 1}</span>{/if}
					{#if hasArt}
						{#if d.image}
							<img
								class="art"
								class:round={d.round}
								src={d.image}
								alt=""
								width={artSize}
								height={artSize}
								style:width="{artSize}px"
								style:height="{artSize}px"
								loading="lazy"
								decoding="async"
							/>
						{:else}
							<span
								class="art blank"
								class:round={d.round}
								style:width="{artSize}px"
								style:height="{artSize}px"
								aria-hidden="true"
							></span>
						{/if}
					{/if}
					<span class="body">
						<span class="line">
							{#if d.href}
								<a class="name" href={d.href} title={d.label}>{d.label}</a>
							{:else}
								<span class="name" title={d.label}>{d.label}</span>
							{/if}
							<span class="values">
								<span class="value num">{valueFormat(d.value)}</span>
								{#if secondaryOf(d)}<span class="pct num">{secondaryOf(d)}</span>{/if}
							</span>
						</span>
						<span class="track">
							<span class="fill" style:width="{scale(d.value)}%" style:background={color}></span>
						</span>
						{#if d.sublabel}<span class="sub">{d.sublabel}</span>{/if}
					</span>
				</li>
			{/each}
		</ol>
	{/snippet}
</ChartFrame>

<style>
	.bars {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	li {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		min-width: 0;
	}

	li:hover .fill {
		filter: brightness(1.18);
	}

	.rank {
		flex: none;
		width: 16px;
		text-align: right;
		padding-top: 1px;
		font-size: 0.72rem;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}

	.art {
		flex: none;
		display: block;
		object-fit: cover;
		border-radius: 5px;
		background: var(--bg-elevated);
		border: 1px solid var(--hairline);
	}

	.art.round {
		border-radius: 50%;
	}

	.blank {
		background: linear-gradient(135deg, rgba(124, 58, 237, 0.18), rgba(192, 38, 211, 0.08));
	}

	.body {
		flex: 1;
		min-width: 0;
	}

	.line {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 5px;
	}

	.name {
		font-size: 0.82rem;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	a.name:hover {
		color: #fff;
		text-decoration: underline;
	}

	.values {
		flex: none;
		display: inline-flex;
		align-items: baseline;
		gap: 8px;
	}

	.value {
		font-size: 0.82rem;
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}

	.pct {
		font-size: 0.72rem;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
		min-width: 38px;
		text-align: right;
	}

	.track {
		display: block;
		height: 8px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.05);
		overflow: hidden;
	}

	.fill {
		display: block;
		height: 100%;
		/* square at the baseline, 4px rounded at the data end */
		border-radius: 0 4px 4px 0;
		min-width: 2px;
		transition: filter 0.15s ease;
	}

	.sub {
		display: block;
		margin-top: 4px;
		font-size: 0.72rem;
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
