<!--
  Legend — the dependable identity channel. Present whenever a chart carries two
  or more series; a single-series chart is named by its title instead.
  Hovering an entry can drive the same highlight state as hovering a mark.
-->
<script lang="ts">
	import type { LegendItem } from './types';

	type Props = {
		items: LegendItem[];
		/** Currently isolated series key, or null. */
		active?: string | null;
		onhover?: (key: string | null) => void;
		/** 'dot' for lines/areas, 'swatch' for filled marks. */
		mark?: 'dot' | 'swatch';
	};

	let { items, active = null, onhover, mark = 'swatch' }: Props = $props();
</script>

<ul class="legend">
	{#each items as item (item.key)}
		<li class:dim={active !== null && active !== item.key}>
			{#if onhover}
				<button
					type="button"
					onmouseenter={() => onhover(item.key)}
					onmouseleave={() => onhover(null)}
					onfocus={() => onhover(item.key)}
					onblur={() => onhover(null)}
				>
					<i class="mark" class:dot={mark === 'dot'} style:background={item.color}></i>
					<span class="label">{item.label}</span>
					{#if item.value}<span class="value num">{item.value}</span>{/if}
				</button>
			{:else}
				<span class="entry">
					<i class="mark" class:dot={mark === 'dot'} style:background={item.color}></i>
					<span class="label">{item.label}</span>
					{#if item.value}<span class="value num">{item.value}</span>{/if}
				</span>
			{/if}
		</li>
	{/each}
</ul>

<style>
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 14px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	li {
		transition: opacity 0.15s ease;
	}

	li.dim {
		opacity: 0.35;
	}

	button,
	.entry {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 2px 0;
		background: none;
		border: 0;
		cursor: default;
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	button {
		cursor: pointer;
	}

	button:hover .label {
		color: var(--text);
	}

	.mark {
		flex: none;
		width: 10px;
		height: 10px;
		border-radius: 3px;
	}

	.mark.dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
	}

	.label {
		white-space: nowrap;
	}

	.value {
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
</style>
