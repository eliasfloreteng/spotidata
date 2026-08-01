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
</style>
