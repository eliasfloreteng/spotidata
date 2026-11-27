<script lang="ts">
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';
	import type { ActiveFilters, FilterGroup } from '$lib/filters.ts';
	import { withParams } from '$lib/utils/qs.ts';
	import Icon from './Icon.svelte';
	import Sheet from './Sheet.svelte';
	import SortLink from './SortLink.svelte';

	interface Props {
		groups: FilterGroup[];
		/** The values the load function actually applied, so the UI can't disagree with the query. */
		active: ActiveFilters;
		/** Sort controls for pages whose rows are a list rather than a table. */
		sorts?: { key: string; label: string; initial?: 'asc' | 'desc' }[];
		/**
		 * Show the sort chips on a phone only: for a table whose headers sort on
		 * a wide screen but fold away on a narrow one.
		 */
		sortsNarrowOnly?: boolean;
		sort?: string;
		dir?: 'asc' | 'desc';
		/** Controls that don't fit the closed-vocabulary chip model, e.g. a long select. */
		children?: Snippet;
		/** How many of those extra controls are set, for the phone's filter count. */
		extraActive?: number;
	}
	let {
		groups,
		active,
		sorts = [],
		sortsNarrowOnly = false,
		sort = '',
		dir = 'desc',
		children,
		extraActive = 0
	}: Props = $props();

	/** Every filter link resets the page: row 340 of the old result set means nothing in the new one. */
	const href = (param: string, value: string | null) =>
		withParams(page.url, { [param]: value, page: null });

	const anyActive = $derived(groups.some((g) => active[g.param]));

	/** The filters in force, by name, so a phone shows them without opening the sheet. */
	const applied = $derived(
		groups.flatMap((g) => {
			const option = g.options.find((o) => o.value === active[g.param]);
			return option ? [{ param: g.param, group: g.label, label: option.label }] : [];
		})
	);
	const sortLabel = $derived(sorts.find((s) => s.key === sort)?.label ?? 'Sort');

	let open = $state(false);
	const clearHref = $derived(
		withParams(page.url, {
			...Object.fromEntries(groups.map((g) => [g.param, null])),
			page: null
		})
	);
</script>

{#snippet controls()}
	{#if sorts.length}
		<div class={['group', { 'narrow-only': sortsNarrowOnly }]}>
			<span class="lbl">Sort</span>
			<div class="opts">
				{#each sorts as s (s.key)}
					<SortLink key={s.key} label={s.label} active={sort} {dir} initial={s.initial} chip />
				{/each}
			</div>
		</div>
	{/if}

	{#each groups as group (group.param)}
		<div class="group">
			<span class="lbl">{group.label}</span>
			<div class="opts">
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
		</div>
	{/each}

	{@render children?.()}
{/snippet}

<!-- A wide screen has room to lay every control out in the open. -->
<div class="bar wide-only">
	{@render controls()}
	{#if anyActive}
		<a class="clear" href={clearHref}>Clear filters</a>
	{/if}
</div>

<!-- A phone does not: a page of chips stood between the title and the first
     row. The controls move into a sheet behind two buttons that name the
     current sort and count the filters; the filters in force stay listed,
     each one tap from removal. -->
<div class="tools narrow-only">
	{#if sorts.length}
		<button type="button" class="tool" onclick={() => (open = true)} aria-haspopup="dialog">
			<Icon name="sort" size={16} />
			<span class="faint">Sort</span>
			<span class="val">{sortLabel}</span>
			<span class="caret" aria-label={dir === 'asc' ? 'ascending' : 'descending'}>
				{dir === 'asc' ? '▲' : '▼'}
			</span>
		</button>
	{/if}
	<button type="button" class="tool" onclick={() => (open = true)} aria-haspopup="dialog">
		<Icon name="filter" size={16} />
		<span>Filters</span>
		{#if applied.length + extraActive}<span class="count">{applied.length + extraActive}</span>{/if}
	</button>
</div>
{#if applied.length}
	<div class="applied narrow-only">
		{#each applied as f (f.param)}
			<a class="chip on" href={href(f.param, null)} aria-label="Remove {f.group}: {f.label}">
				{f.label}
				<Icon name="close" size={12} />
			</a>
		{/each}
	</div>
{/if}

<Sheet bind:open title={sorts.length ? 'Sort and filter' : 'Filter'}>
	{#snippet actions()}
		{#if anyActive}<a class="clear" href={clearHref} data-sveltekit-noscroll>Clear all</a>{/if}
	{/snippet}
	<!-- The sheet stays up while choices land, so several can be made in a row
	     and the list behind it updates under the dimmed page. -->
	<div class="stack" data-sveltekit-noscroll data-sveltekit-keepfocus>
		{@render controls()}
	</div>
</Sheet>

<style>
	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 18px;
		margin-bottom: var(--gap);
	}
	.group,
	.opts {
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
	/* ── Phone ── */
	.tools {
		display: flex;
		gap: 8px;
		margin-bottom: var(--gap);
	}
	.tool {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		min-height: 42px;
		padding: 0 14px;
		border-radius: 999px;
		border: 1px solid var(--hairline-strong);
		background: var(--bg-elevated);
		color: var(--text-muted);
		font-size: 0.86rem;
		cursor: pointer;
		min-width: 0;
	}
	.tool:first-child {
		flex: 1;
	}
	.tool:last-child {
		margin-left: auto;
	}
	.tool:active {
		background: var(--card-hover);
	}
	.val {
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.caret {
		font-size: 0.6rem;
		color: #ddd6fe;
	}
	.count {
		display: grid;
		place-items: center;
		min-width: 20px;
		height: 20px;
		padding: 0 6px;
		border-radius: 999px;
		background: var(--accent);
		color: #fff;
		font-size: 0.72rem;
		font-weight: 600;
	}
	.applied {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: calc(var(--gap) * -0.4) 0 var(--gap);
	}
	.applied .chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 6px 10px 6px 13px;
	}
	/* In the sheet each group is a labelled block, its options wrapping under
	   the label rather than around it, so every group starts on the same edge. */
	.stack {
		display: flex;
		flex-direction: column;
		gap: 18px;
	}
	.stack .group {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 8px;
	}
	.stack .lbl {
		margin: 0;
	}
	.stack .chip,
	.stack :global(a.chip) {
		padding: 9px 15px;
		font-size: 0.86rem;
	}
	.clear {
		padding: 8px 6px;
	}
</style>
