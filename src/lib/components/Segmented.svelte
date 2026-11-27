<!--
  Segmented — a small pill of mutually exclusive views, for a card that shows
  one of several cuts of the same question (hours played or tracks saved, by
  device or by country). The card keeps its place on the page and swaps what
  it draws; nothing navigates.
-->
<script lang="ts" generics="K extends string">
	interface Props {
		options: ReadonlyArray<{ key: K; label: string }>;
		value: K;
		/** What a screen reader hears for the group, e.g. "Measure". */
		label: string;
	}
	let { options, value = $bindable(), label }: Props = $props();
</script>

<div class="seg" role="group" aria-label={label}>
	{#each options as o (o.key)}
		<button
			type="button"
			class:on={value === o.key}
			aria-pressed={value === o.key}
			onclick={() => (value = o.key)}
		>
			{o.label}
		</button>
	{/each}
</div>

<style>
	.seg {
		display: inline-flex;
		gap: 2px;
		padding: 2px;
		background: var(--bg-elevated);
		border: 1px solid var(--hairline);
		border-radius: 999px;
	}
	button {
		border: 0;
		background: transparent;
		color: var(--text-muted);
		padding: 3px 10px;
		border-radius: 999px;
		font: inherit;
		font-size: 0.74rem;
		white-space: nowrap;
		cursor: pointer;
		transition:
			background 0.15s ease,
			color 0.15s ease;
	}
	button:hover {
		color: var(--text);
	}
	button.on {
		background: var(--accent-soft);
		color: #ddd6fe;
	}
</style>
