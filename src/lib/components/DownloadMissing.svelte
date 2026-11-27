<script lang="ts">
	import { useDownloads } from '$lib/downloads.svelte.ts';
	import { isMissing } from '$lib/downloads.ts';
	import { num } from '$lib/utils/format.ts';

	interface Props {
		/** The Spotify ids of every track the list shows, in order. */
		ids: string[];
	}
	let { ids }: Props = $props();

	const tracker = useDownloads();
	const unique = $derived([...new Set(ids)]);
	const here = $derived(unique.filter((id) => tracker.status(id).state === 'here').length);
	const getting = $derived(unique.filter((id) => tracker.status(id).state === 'getting').length);
	const failed = $derived(unique.filter((id) => tracker.status(id).state === 'failed').length);
	const missing = $derived(unique.filter((id) => isMissing(tracker.status(id))));
</script>

{#if unique.length > 0}
	<div class="bar">
		<span class="muted">
			<span class="num">{num(here)}</span> of {num(unique.length)} in the music folder{#if getting > 0}{' · '}<span
					class="getting">{num(getting)} on the way</span
				>{/if}{#if failed > 0}{' · '}<span class="bad">{num(failed)} failed</span>{/if}
		</span>
		{#if missing.length > 0}
			<button
				type="button"
				class="btn"
				onclick={() => tracker.downloadAll(missing)}
				disabled={tracker.bulkBusy}
				title="Queue every track here the folder lacks; failed ones are tried again"
			>
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" /></svg>
				{tracker.bulkBusy
					? 'Queuing…'
					: missing.length === unique.length
						? `Download all ${num(missing.length)}`
						: `Download the ${num(missing.length)} missing`}
			</button>
		{/if}
		{#if tracker.bulkError}<span class="bad err">{tracker.bulkError}</span>{/if}
	</div>
{/if}

<style>
	.bar {
		display: flex;
		align-items: center;
		gap: 10px 14px;
		flex-wrap: wrap;
		font-size: 0.82rem;
	}
	.getting {
		color: #c4b5fd;
	}
	.bad {
		color: var(--bad);
	}
	.err {
		flex-basis: 100%;
	}
	.btn {
		padding: 6px 13px;
		font-size: 0.82rem;
	}
	.btn:disabled {
		opacity: 0.6;
		cursor: progress;
	}
	svg {
		width: 14px;
		height: 14px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.7;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
</style>
