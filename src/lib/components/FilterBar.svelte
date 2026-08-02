<script lang="ts">
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	import type { ActiveFilters, FilterGroup } from '$lib/filters.ts';
	import { withParams } from '$lib/utils/qs.ts';
	import SortLink from './SortLink.svelte';

	interface Props {
		groups: FilterGroup[];
		/** The values the load function actually applied, so the UI can't disagree with the query. */
		active: ActiveFilters;
		/** Sort controls for pages whose rows are a list rather than a table. */
		sorts?: { key: string; label: string; initial?: 'asc' | 'desc' }[];
		sort?: string;
		dir?: 'asc' | 'desc';
		/** Controls that don't fit the closed-vocabulary chip model, e.g. a long select. */
		children?: Snippet;
	}
	let { groups, active, sorts = [], sort = '', dir = 'desc', children }: Props = $props();

	/** Every filter link resets the page: row 340 of the old result set means nothing in the new one. */
	const href = (param: string, value: string | null) =>
		withParams(page.url, { [param]: value, page: null });

	const anyActive = $derived(groups.some((g) => active[g.param]));
	const clearHref = $derived(
		withParams(page.url, {
			...Object.fromEntries(groups.map((g) => [g.param, null])),
			page: null
		})
	);
</script>

<div class="bar">
	{#if sorts.length}
		<div class="group">
			<span class="lbl">Sort</span>
			{#each sorts as s (s.key)}
				<SortLink key={s.key} label={s.label} active={sort} {dir} initial={s.initial} chip />
			{/each}
		</div>
	{/if}

	{#each groups as group (group.param)}
		<div class="group">
			<span class="lbl">{group.label}</span>
			<a class="chip" class:on={!active[group.param]} href={href(group.param, null)}>All</a>
			{#each group.options as option (option.value)}
				<a
					class="chip"
					class:on={active[group.param] === option.value}
					title={option.title}
					href={href(
						group.param,
						active[group.param] === option.value ? null : option.value
					)}
				>
					{option.label}
				</a>
			{/each}
		</div>
	{/each}

	{@render children?.()}

	{#if anyActive}
		<a class="clear" href={clearHref}>Clear filters</a>
	{/if}
</div>

<style>
	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 18px;
		margin-bottom: var(--gap);
	}
	.group {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}
	.lbl {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-faint);
		margin-right: 2px;
	}
	.chip {
		padding: 3px 10px;
		border-radius: 999px;
		border: 1px solid var(--hairline-strong);
		background: var(--bg-elevated);
		color: var(--text-muted);
		font-size: 0.76rem;
		line-height: 1.6;
		white-space: nowrap;
	}
	.chip:hover {
		color: var(--text);
	}
	.chip.on {
		color: #ddd6fe;
		background: var(--accent-soft);
		border-color: rgba(124, 58, 237, 0.4);
	}
	.clear {
		font-size: 0.76rem;
		color: var(--text-faint);
		text-decoration: underline;
	}
	.clear:hover {
		color: var(--text);
	}

	@media (pointer: coarse) {
		/* A 24px pill is a cursor target, not a finger one. */
		.chip {
			padding: 8px 14px;
			font-size: 0.82rem;
		}
		.clear {
			padding: 8px 2px;
			font-size: 0.82rem;
		}
	}
	@media (max-width: 640px) {
		.bar {
			gap: 8px 14px;
		}
	}
</style>
