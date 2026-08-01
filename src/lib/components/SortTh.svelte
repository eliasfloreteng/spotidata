<script lang="ts">
	import { page } from '$app/state';
	import { withParams } from '$lib/utils/qs.ts';

	interface Props {
		/** The `?sort=` value this column selects. */
		key: string;
		label: string;
		active: string;
		dir: 'asc' | 'desc';
		/** Direction applied when the column is first clicked. */
		initial?: 'asc' | 'desc';
		right?: boolean;
	}
	let { key, label, active, dir, initial = 'desc', right = false }: Props = $props();

	const on = $derived(active === key);
	const next = $derived(on ? (dir === 'asc' ? 'desc' : 'asc') : initial);
	const href = $derived(withParams(page.url, { sort: key, dir: next, page: null }));
</script>

<th class:r={right} aria-sort={on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
	<a {href} class:on>
		{label}
		<span class="caret" aria-hidden="true">{on ? (dir === 'asc' ? '▲' : '▼') : '↕'}</span>
	</a>
</th>

<style>
	th {
		text-align: left;
		font-weight: 500;
		color: var(--text-muted);
		font-size: 0.76rem;
		padding-bottom: 8px;
		border-bottom: 1px solid var(--hairline);
		white-space: nowrap;
	}
	th.r {
		text-align: right;
	}
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
</style>
