<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { untrack } from 'svelte';

	interface Props {
		/** The span the load function settled on, as whole days in the display zone. */
		days: { from: string; to: string };
	}
	let { days }: Props = $props();

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
	const custom = $derived(
		page.url.searchParams.has('from') || page.url.searchParams.has('to')
	);
	const active = $derived(custom ? 'custom' : (page.url.searchParams.get('preset') ?? 'all'));

	// A custom span arrives with the fields already open, so the dates behind the
	// charts are readable rather than hidden one click away. Applying one keeps
	// them open; picking a preset closes them.
	// Only the span the page loaded with decides this; from then on the button
	// and the presets do, so the initial read is deliberately untracked.
	let open = $state(untrack(() => custom));

	function select(preset: string) {
		const url = new URL(page.url);
		url.searchParams.delete('from');
		url.searchParams.delete('to');
		if (preset === 'all') url.searchParams.delete('preset');
		else url.searchParams.set('preset', preset);
		open = false;
		goto(url, { keepFocus: true, noScroll: true });
	}

	function apply(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
		event.preventDefault();
		const fields = new FormData(event.currentTarget);
		const from = String(fields.get('from') ?? '');
		const to = String(fields.get('to') ?? '');
		if (!from || !to) return;
		const url = new URL(page.url);
		url.searchParams.delete('preset');
		url.searchParams.set('from', from);
		url.searchParams.set('to', to);
		goto(url, { keepFocus: true, noScroll: true });
	}
</script>

<div class="picker">
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
		<button
			class="opt"
			class:on={active === 'custom'}
			aria-pressed={active === 'custom'}
			aria-expanded={open}
			onclick={() => (open = !open)}
		>
			Custom
		</button>
	</div>

	{#if open}
		<!-- The fields are seeded from the resolved span, so they re-seed on their
		     own when a preset is clicked while they're open. -->
		<form class="span" onsubmit={apply}>
			<label>
				<span>From</span>
				<input type="date" name="from" value={days.from} required />
			</label>
			<label>
				<span>To</span>
				<input type="date" name="to" value={days.to} required />
			</label>
			<button class="apply" type="submit">Apply</button>
		</form>
	{/if}
</div>

<style>
	.picker {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 8px;
	}
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
	.span {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
	}
	.span label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-faint);
	}
	.span input {
		font: inherit;
		font-size: 0.82rem;
		text-transform: none;
		letter-spacing: normal;
		color: var(--text);
		background: var(--bg-elevated);
		border: 1px solid var(--hairline-strong);
		border-radius: 8px;
		padding: 4px 8px;
		color-scheme: dark;
	}
	.span input:focus-visible {
		outline: 1px solid var(--accent);
		outline-offset: 1px;
	}
	.apply {
		font: inherit;
		font-size: 0.82rem;
		padding: 5px 12px;
		border-radius: 999px;
		border: 1px solid rgba(124, 58, 237, 0.4);
		background: var(--accent-soft);
		color: #ddd6fe;
		cursor: pointer;
	}
	.apply:hover {
		border-color: var(--accent);
	}
</style>
