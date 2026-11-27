<script lang="ts">
	import { untrack } from 'svelte';

	interface Props {
		id: string;
		kept: boolean;
		/** The `.m3u8` the engine wrote for it. */
		file: string | null;
		/** Why the engine could not read it last time. */
		error: string | null;
	}
	let props: Props = $props();

	type Keeping = Omit<Props, 'id'>;
	/** The answer to the last toggle, until the page loads anew. */
	let answered = $state<Keeping | null>(null);
	$effect.pre(() => {
		void [props.id, props.kept, props.file, props.error];
		untrack(() => (answered = null));
	});
	const current = $derived<Keeping>(answered ?? props);
	const kept = $derived(current.kept);
	const file = $derived(current.file);
	const error = $derived(current.error);

	let busy = $state(false);
	let failure = $state<string | null>(null);

	async function toggle() {
		busy = true;
		failure = null;
		try {
			const res = await fetch(`/api/downloads/playlists/${props.id}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ kept: !kept })
			}).catch(() => null);
			if (!res) failure = 'Spotidata is not reachable.';
			else if (!res.ok) failure = (await res.text()).trim() || `The request failed (${res.status}).`;
			else answered = (await res.json()) as Keeping;
		} finally {
			busy = false;
		}
	}
</script>

<div class="keep">
	<button
		type="button"
		class="btn"
		class:on={kept}
		onclick={toggle}
		disabled={busy}
		aria-pressed={kept}
		title={kept
			? 'Stop keeping it: its tracks stay in the folder; its playlist file goes unless you edited it'
			: 'Download every track, write the playlist to the music folder, and follow it as it changes on Spotify'}
	>
		{#if kept}
			<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>
			{busy ? 'Stopping…' : 'Kept on the stick'}
		{:else}
			<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
			{busy ? 'Starting…' : 'Keep on the stick'}
		{/if}
	</button>
	{#if failure}
		<span class="note bad">{failure}</span>
	{:else if kept && error}
		<span class="note bad">{error}</span>
	{:else if kept}
		<span class="note faint">
			{file ? `Written as ${file}, and followed` : 'Followed'} as it changes on Spotify.
			<a href="/downloads">Downloads →</a>
		</span>
	{/if}
</div>

<style>
	.keep {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.btn {
		padding: 7px 14px;
		font-size: 0.84rem;
	}
	.btn.on {
		color: var(--good);
		border-color: rgba(52, 211, 153, 0.35);
		background: rgba(52, 211, 153, 0.08);
	}
	.btn:disabled {
		opacity: 0.6;
		cursor: progress;
	}
	.note {
		font-size: 0.78rem;
		overflow-wrap: anywhere;
	}
	.note a {
		color: var(--text-muted);
		text-decoration: underline;
		text-decoration-color: var(--hairline-strong);
		text-underline-offset: 3px;
	}
	.bad {
		color: var(--bad);
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
