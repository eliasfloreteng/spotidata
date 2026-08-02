<script lang="ts">
	import { page as pageState } from '$app/state';
	import { withParams } from '$lib/utils/qs.ts';
	import { num } from '$lib/utils/format.ts';

	interface Props {
		page: number;
		pages: number;
		total: number;
		pageSize: number;
		unit?: string;
	}
	let { page, pages, total, pageSize, unit = 'rows' }: Props = $props();

	const href = (p: number) => withParams(pageState.url, { page: p === 1 ? null : p });
	const from = $derived(total === 0 ? 0 : (page - 1) * pageSize + 1);
	const to = $derived(Math.min(page * pageSize, total));

	/** First, last, and a window around the current page — with gaps elided. */
	const numbers = $derived.by(() => {
		const want = new Set([1, pages, page - 1, page, page + 1]);
		if (page <= 3) [2, 3, 4].forEach((n) => want.add(n));
		if (page >= pages - 2) [pages - 3, pages - 2, pages - 1].forEach((n) => want.add(n));
		const list = [...want].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
		const out: Array<number | null> = [];
		let prev = 0;
		for (const n of list) {
			if (prev && n - prev > 1) out.push(null);
			out.push(n);
			prev = n;
		}
		return out;
	});
</script>

<nav class="pager" aria-label="Pagination">
	<span class="faint small">
		{num(from)}–{num(to)} of {num(total)}
		{unit}
	</span>
	{#if pages > 1}
		<div class="pages">
			<a class="pg" class:off={page <= 1} href={href(Math.max(1, page - 1))} rel="prev">Prev</a>
			{#each numbers as n, i (n === null ? `gap${i}` : n)}
				{#if n === null}
					<span class="gap">…</span>
				{:else}
					<a class="pg num" class:on={n === page} href={href(n)} aria-current={n === page ? 'page' : undefined}>
						{n}
					</a>
				{/if}
			{/each}
			<a class="pg" class:off={page >= pages} href={href(Math.min(pages, page + 1))} rel="next">
				Next
			</a>
		</div>
	{/if}
</nav>

<style>
	.pager {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		flex-wrap: wrap;
		padding-top: 14px;
		margin-top: 4px;
		border-top: 1px solid var(--hairline);
	}
	.pages {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
	}
	.pg {
		display: inline-block;
		min-width: 30px;
		text-align: center;
		padding: 4px 9px;
		border-radius: 8px;
		font-size: 0.82rem;
		color: var(--text-muted);
		border: 1px solid transparent;
	}
	.pg:hover {
		color: var(--text);
		background: rgba(255, 255, 255, 0.05);
	}
	.pg.on {
		color: #ddd6fe;
		background: var(--accent-soft);
		border-color: rgba(124, 58, 237, 0.4);
	}
	.pg.off {
		opacity: 0.3;
		pointer-events: none;
	}
	.gap {
		color: var(--text-faint);
		padding: 4px 2px;
	}
	.small {
		font-size: 0.8rem;
	}

	@media (pointer: coarse) {
		.pg {
			min-width: 42px;
			padding: 10px 10px;
			font-size: 0.86rem;
		}
		.gap {
			padding: 10px 2px;
		}
	}
	@media (max-width: 640px) {
		/* Prev/Next carry the paging on a phone; the numbers stay for orientation
		   and to jump, and get their own centred row rather than being squeezed
		   against the count. */
		.pager {
			justify-content: center;
			gap: 8px;
		}
		.pages {
			flex: 1 0 100%;
			justify-content: center;
		}
	}
</style>
