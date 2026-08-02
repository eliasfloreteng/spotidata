<!--
  Tooltip — the hover layer every chart shares.

  Positioned in the plot container's coordinate space (so charts pass the
  cursor/mark position plus the container width, and it flips itself to stay
  inside). Values are tabular; the series colour rides a swatch beside the
  label, never the text itself.
-->
<script lang="ts">
	import { clamp } from './scales';

	import type { TooltipRow } from './types';

	type Props = {
		/** Anchor x in plot-container px. */
		x: number;
		/** Anchor y in plot-container px. */
		y: number;
		/** Plot container width, used to keep the box on screen. */
		containerWidth: number;
		title: string;
		rows: TooltipRow[];
		/** Extra gap between the anchor and the box. */
		offset?: number;
	};

	let { x, y, containerWidth, title, rows, offset = 12 }: Props = $props();

	/** Never wider than the plot it has to stay inside. */
	const WIDTH = $derived(Math.min(178, Math.max(120, containerWidth - 16)));
	const flip = $derived(x + offset + WIDTH > containerWidth && x - offset - WIDTH > 0);
	const left = $derived(clamp(flip ? x - offset - WIDTH : x + offset, 0, Math.max(0, containerWidth - WIDTH)));
</script>

<div class="tip" style:left="{left}px" style:top="{y}px" style:width="{WIDTH}px" aria-hidden="true">
	<div class="tip-title">{title}</div>
	{#each rows as row (row.label)}
		<div class="tip-row">
			<span class="key">
				{#if row.color}<i class="swatch" style:background={row.color}></i>{/if}
				<span class="label">{row.label}</span>
			</span>
			<span class="num">{row.value}</span>
		</div>
	{/each}
</div>

<style>
	.tip {
		position: absolute;
		z-index: 5;
		transform: translateY(-50%);
		pointer-events: none;
		padding: 9px 11px;
		border-radius: 10px;
		background: rgba(20, 20, 26, 0.97);
		border: 1px solid var(--hairline-strong);
		box-shadow: 0 6px 24px rgba(0, 0, 0, 0.55);
		font-size: 0.75rem;
		line-height: 1.35;
	}

	.tip-title {
		color: var(--text);
		font-weight: 550;
		margin-bottom: 4px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.tip-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 10px;
		color: var(--text-muted);
	}

	.key {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.swatch {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 2px;
	}

	.num {
		flex: none;
		color: var(--text);
		font-variant-numeric: tabular-nums;
		font-feature-settings: 'tnum' 1;
	}
</style>
