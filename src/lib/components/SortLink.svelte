<script lang="ts">
	import { page } from '$app/state';
	import { withParams } from '$lib/utils/qs.ts';

	interface Props {
		/** The `?sort=` value this control selects. */
		key: string;
		label: string;
		active: string;
		dir: 'asc' | 'desc';
		/** Direction applied when the column is first clicked. */
		initial?: 'asc' | 'desc';
		/** Standalone pill styling, for lists that have no table header to live in. */
		chip?: boolean;
	}
	let { key, label, active, dir, initial = 'desc', chip = false }: Props = $props();

	const on = $derived(active === key);
	const next = $derived(on ? (dir === 'asc' ? 'desc' : 'asc') : initial);
	const href = $derived(withParams(page.url, { sort: key, dir: next, page: null }));
</script>

<a {href} class:on class:chip>
	{label}
	<span class="caret" aria-hidden="true">{on ? (dir === 'asc' ? '▲' : '▼') : '↕'}</span>
</a>

<style>
	a {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: inherit;
	}
	a:hover {
		color: var(--text);
	}
	a.on {
		color: #ddd6fe;
	}
	.caret {
		font-size: 0.6rem;
		opacity: 0.5;
	}
	a.on .caret {
		opacity: 1;
	}
	a.chip {
		padding: 3px 10px;
		border-radius: 999px;
		border: 1px solid var(--hairline-strong);
		background: var(--bg-elevated);
		color: var(--text-muted);
		font-size: 0.76rem;
		line-height: 1.6;
		white-space: nowrap;
	}
	a.chip.on {
		color: #ddd6fe;
		background: var(--accent-soft);
		border-color: rgba(124, 58, 237, 0.4);
	}

	@media (pointer: coarse) {
		a.chip {
			padding: 8px 14px;
			font-size: 0.82rem;
		}
		/* Column headers stay small — the table is dense by design — but the tap
		   area is grown downward into the header's own padding. */
		a:not(.chip) {
			padding: 6px 0;
		}
	}
</style>
