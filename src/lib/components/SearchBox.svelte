<script lang="ts">
	import { page } from '$app/state';
	import { withParams } from '$lib/utils/qs.ts';

	interface Props {
		value: string;
		placeholder?: string;
	}
	let { value, placeholder = 'Search…' }: Props = $props();

	/**
	 * A GET form submits only its own fields, so the sort order and every active
	 * filter ride along as hidden inputs — searching narrows the current view
	 * rather than resetting it. Only the page number is dropped, since the
	 * result set changes underneath it.
	 */
	const carried = $derived(
		[...page.url.searchParams].filter(([name]) => name !== 'q' && name !== 'page')
	);
	const clearHref = $derived(withParams(page.url, { q: null, page: null }));
</script>

<form class="search" method="GET" action={page.url.pathname} role="search">
	{#each carried as [name, v], i (i)}
		<input type="hidden" {name} value={v} />
	{/each}
	<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
		<path
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			d="M10.5 3a7.5 7.5 0 105.3 12.8A7.5 7.5 0 0010.5 3zm5.3 12.8L21 21"
		/>
	</svg>
	<input name="q" type="search" {placeholder} {value} autocomplete="off" aria-label={placeholder} />
	{#if value}
		<a class="clear" href={clearHref} aria-label="Clear search">×</a>
	{/if}
</form>

<style>
	.search {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 0 12px;
		height: 36px;
		border-radius: 999px;
		border: 1px solid var(--hairline-strong);
		background: var(--bg-elevated);
		color: var(--text-faint);
	}
	.search:focus-within {
		border-color: rgba(124, 58, 237, 0.6);
	}
	input[name='q'] {
		border: 0;
		background: none;
		outline: none;
		width: 220px;
		font-size: 0.86rem;
		color: var(--text);
	}
	input[name='q']::placeholder {
		color: var(--text-faint);
	}
	.clear {
		color: var(--text-faint);
		font-size: 1.1rem;
		line-height: 1;
	}
	.clear:hover {
		color: var(--text);
	}
</style>
