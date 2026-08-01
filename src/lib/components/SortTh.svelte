<script lang="ts">
	import SortLink from './SortLink.svelte';

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
</script>

<th class:r={right} aria-sort={on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
	<SortLink {key} {label} {active} {dir} {initial} />
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
</style>
