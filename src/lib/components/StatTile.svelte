<script lang="ts">
	import { Sparkline } from '$lib/charts/index.ts';

	interface Props {
		label: string;
		value: string;
		sub?: string;
		accent?: string;
		trend?: number[];
		muted?: boolean;
	}
	let { label, value, sub, accent, trend, muted = false }: Props = $props();
</script>

<div class="tile" class:muted>
	<div class="top">
		<span class="label">{label}</span>
		{#if trend && trend.length > 1}
			<Sparkline values={trend} color={accent} width={72} height={22} ariaLabel="{label} trend" />
		{/if}
	</div>
	<div class="value num" style={accent ? `color:${accent}` : undefined}>{value}</div>
	{#if sub}<div class="sub">{sub}</div>{/if}
</div>

<style>
	.tile {
		background: var(--card);
		border: 1px solid var(--hairline);
		border-radius: var(--radius);
		padding: 15px 17px;
		min-width: 0;
	}
	.tile.muted {
		opacity: 0.55;
	}
	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-height: 22px;
	}
	.label {
		color: var(--text-muted);
		font-size: 0.76rem;
		letter-spacing: 0.02em;
	}
	.value {
		font-size: 1.65rem;
		font-weight: 650;
		letter-spacing: -0.02em;
		margin-top: 4px;
		line-height: 1.1;
	}
	.sub {
		color: var(--text-faint);
		font-size: 0.76rem;
		margin-top: 3px;
	}

	/* Two tiles share a phone row, so the value has to survive a ~150px column:
	   it scales with the viewport and the longest ones ("22 days 13 hr") wrap
	   rather than forcing the grid wider. */
	@media (max-width: 640px) {
		.tile {
			padding: 12px 13px;
		}
		.label {
			font-size: 0.72rem;
		}
		/* The trend is a garnish, not the reading — on a half-width tile it gives
		   ground to the label rather than crowding it. It has a viewBox, so it
		   scales rather than clips. */
		.top :global(svg) {
			max-width: 46px;
		}
		.value {
			font-size: clamp(1.15rem, 5.4vw, 1.45rem);
			overflow-wrap: break-word;
		}
		.sub {
			font-size: 0.7rem;
		}
	}
</style>
