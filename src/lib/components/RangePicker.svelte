<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';

	const PRESETS = [
		{ key: 'all', label: 'All time' },
		{ key: '1y', label: '1Y' },
		{ key: '6m', label: '6M' },
		{ key: '90d', label: '90D' },
		{ key: '30d', label: '30D' },
		{ key: 'ytd', label: 'YTD' }
	];

	// The range lives in the URL so charts render server-side, links are
	// shareable, and back/forward behaves.
	const active = $derived(page.url.searchParams.get('preset') ?? 'all');

	function select(preset: string) {
		const url = new URL(page.url);
		url.searchParams.delete('from');
		url.searchParams.delete('to');
		if (preset === 'all') url.searchParams.delete('preset');
		else url.searchParams.set('preset', preset);
		goto(url, { keepFocus: true, noScroll: true });
	}
</script>

<div class="range" role="group" aria-label="Time range">
	{#each PRESETS as p (p.key)}
		<button
			class="opt"
			class:on={active === p.key}
			aria-pressed={active === p.key}
			onclick={() => select(p.key)}
		>
			{p.label}
		</button>
	{/each}
</div>

<style>
	.range {
		display: inline-flex;
		gap: 2px;
		padding: 3px;
		background: var(--bg-elevated);
		border: 1px solid var(--hairline);
		border-radius: 999px;
	}
	.opt {
		border: 0;
		background: transparent;
		color: var(--text-muted);
		padding: 5px 12px;
		border-radius: 999px;
		font-size: 0.82rem;
		cursor: pointer;
		transition: background 0.15s ease, color 0.15s ease;
	}
	.opt:hover {
		color: var(--text);
	}
	.opt.on {
		background: var(--accent-soft);
		color: #ddd6fe;
	}
</style>
