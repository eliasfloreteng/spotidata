<script lang="ts">
	import { page } from '$app/state';

	interface Props {
		param: string;
		label: string;
		value: string;
		/** The "no filter" entry, always first. */
		anyLabel?: string;
		options: { value: string; label: string }[];
	}
	let { param, label, value, anyLabel = 'Any', options }: Props = $props();

	/**
	 * Some vocabularies are too long for chips. A GET form keeps this in the same
	 * world as the rest of the controls — the choice ends up in the URL, so it is
	 * bookmarkable and survives a reload — and the hidden inputs carry the other
	 * params across, minus the page, which the new result set invalidates.
	 */
	const carried = $derived(
		[...page.url.searchParams].filter(([name]) => name !== param && name !== 'page')
	);
</script>

<form class="wrap" method="GET" action={page.url.pathname}>
	{#each carried as [name, v], i (i)}
		<input type="hidden" {name} value={v} />
	{/each}
	<label class="lbl" for="filter-{param}">{label}</label>
	<select
		id="filter-{param}"
		name={param}
		class:on={value !== ''}
		{value}
		onchange={(e) => e.currentTarget.form?.requestSubmit()}
	>
		<option value="">{anyLabel}</option>
		{#each options as option (option.value)}
			<option value={option.value}>{option.label}</option>
		{/each}
	</select>
	<noscript><button type="submit">Apply</button></noscript>
</form>

<style>
	.wrap {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.lbl {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-faint);
	}
	select {
		max-width: 200px;
		padding: 3px 8px;
		border-radius: 999px;
		border: 1px solid var(--hairline-strong);
		background: var(--bg-elevated);
		color: var(--text-muted);
		font-size: 0.76rem;
		line-height: 1.6;
		font-family: inherit;
	}
	select:hover {
		color: var(--text);
	}
	select.on {
		color: #ddd6fe;
		background: var(--accent-soft);
		border-color: rgba(124, 58, 237, 0.4);
	}
	button {
		padding: 3px 10px;
		border-radius: 999px;
		border: 1px solid var(--hairline-strong);
		background: var(--bg-elevated);
		color: var(--text-muted);
		font-size: 0.76rem;
		font-family: inherit;
		cursor: pointer;
	}

	@media (max-width: 640px) {
		/* The genre vocabulary is long enough that the native picker is the right
		   control on a phone — it just needs a row of its own to be tappable. */
		.wrap {
			display: flex;
			width: 100%;
			gap: 8px;
		}
		select {
			flex: 1;
			max-width: none;
			min-width: 0;
			padding: 8px 12px;
		}
	}
</style>
