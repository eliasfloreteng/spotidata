<script lang="ts">
	import { useDownloads } from '$lib/downloads.svelte.ts';
	import { phaseLabel, progress } from '$lib/downloads.ts';

	interface Props {
		/** The Spotify track id. */
		id: string;
		/** The track's title, for the button's label. */
		title?: string;
		/**
		 * `row`: one icon, for a table. `full`: words and a second action, for
		 * the track page's header.
		 */
		variant?: 'row' | 'full';
	}
	let { id, title = 'this track', variant = 'row' }: Props = $props();

	const tracker = useDownloads();
	const s = $derived(tracker.status(id));
	const busy = $derived(tracker.busy.has(id));
	const error = $derived(tracker.errors.get(id) ?? null);
	const pct = $derived(progress(s));

	const getting = $derived(
		s.state === 'getting'
			? `${phaseLabel(s.phase)}${pct ? ` ${pct}` : ''}${s.source && s.phase !== 'queued' && s.phase !== 'waiting' ? ` from ${s.source}` : ''}`
			: ''
	);
	const tip = $derived.by(() => {
		if (error) return error;
		switch (s.state) {
			case 'here':
				return `In the music folder: ${s.file}`;
			case 'getting':
				return s.phase === 'waiting'
					? (s.detail ?? 'Waiting for a check to be solved in the Deckhand app.')
					: `${getting}. Click to stop.`;
			case 'failed':
				return `The download failed${s.error ? `: ${s.error}` : ''}. Click to try again.`;
			default:
				return `Download ${title} into the music folder`;
		}
	});

	function primary() {
		if (busy) return;
		if (s.state === 'none') void tracker.download([id]);
		else if (s.state === 'failed') void tracker.retry(id, s.id);
		else if (s.state === 'getting' && variant === 'row') void tracker.stop(id, s.id);
	}
</script>

{#if variant === 'row'}
	{#if s.state === 'here'}
		<span class="icon here" title={tip} aria-label={tip} role="img">
			<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>
		</span>
	{:else}
		<button
			type="button"
			class="icon {s.state}"
			class:err={error}
			class:busy
			title={tip}
			aria-label={tip}
			onclick={primary}
			disabled={busy}
		>
			{#if s.state === 'getting'}
				{#if s.phase === 'waiting'}
					<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.2l2 1.3" /></svg>
				{:else}
					<svg class="spin" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5" /></svg>
					<svg class="stop" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 5l6 6M11 5l-6 6" /></svg>
				{/if}
			{:else if s.state === 'failed' || error}
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v2.8h-2.8" /></svg>
			{:else}
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" /></svg>
			{/if}
		</button>
	{/if}
{:else}
	<span class="full">
		{#if s.state === 'here'}
			<span class="pill here" title={s.file}>
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>
				In the music folder
			</span>
		{:else if s.state === 'getting'}
			<span class="pill getting" title={s.phase === 'waiting' ? (s.detail ?? '') : ''}>
				{#if s.phase === 'waiting'}
					Waiting for a check in the Deckhand app
				{:else}
					<svg class="spin" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5" /></svg>
					{getting}
				{/if}
			</span>
			<button type="button" class="link" onclick={() => s.state === 'getting' && tracker.stop(id, s.id)} disabled={busy}>
				Stop
			</button>
		{:else if s.state === 'failed'}
			<button type="button" class="btn" onclick={primary} disabled={busy}>
				{busy ? 'Queuing…' : 'Try the download again'}
			</button>
		{:else}
			<button type="button" class="btn" onclick={primary} disabled={busy}>
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" /></svg>
				{busy ? 'Queuing…' : 'Download'}
			</button>
		{/if}
	</span>
	{#if error}
		<span class="why bad">{error}</span>
	{:else if s.state === 'failed' && s.error}
		<span class="why">Last try failed: {s.error}</span>
	{/if}
{/if}

<style>
	svg {
		width: 14px;
		height: 14px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.7;
		stroke-linecap: round;
		stroke-linejoin: round;
		flex: none;
	}
	.icon {
		display: inline-grid;
		place-items: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border-radius: 999px;
		border: 1px solid transparent;
		background: none;
		color: var(--text-faint);
		vertical-align: middle;
	}
	.icon > svg {
		grid-area: 1 / 1;
	}
	button.icon {
		cursor: pointer;
		transition:
			color 0.15s ease,
			border-color 0.15s ease,
			background 0.15s ease;
	}
	@media (hover: hover) {
		button.icon:hover {
			color: var(--text);
			border-color: var(--hairline-strong);
			background: var(--bg-elevated);
		}
	}
	@media (pointer: coarse) {
		.icon {
			width: 36px;
			height: 36px;
		}
	}
	.icon.here {
		color: var(--good);
	}
	.icon.getting {
		color: #c4b5fd;
	}
	.icon.failed,
	.icon.err {
		color: var(--bad);
	}
	.icon.busy {
		opacity: 0.5;
		cursor: progress;
	}
	/* A running download shows its spinner, and the way to stop it on hover. */
	.icon .stop {
		opacity: 0;
	}
	@media (hover: hover) {
		.icon.getting:hover .spin {
			opacity: 0;
		}
		.icon.getting:hover .stop {
			opacity: 1;
		}
	}
	.spin {
		animation: spin 0.9s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.full {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 7px 14px;
		border-radius: 999px;
		border: 1px solid var(--hairline-strong);
		font-size: 0.84rem;
	}
	.pill.here {
		color: var(--good);
		border-color: rgba(52, 211, 153, 0.3);
		background: rgba(52, 211, 153, 0.08);
	}
	.pill.getting {
		color: #ddd6fe;
		border-color: rgba(124, 58, 237, 0.4);
		background: var(--accent-soft);
	}
	.btn {
		padding: 7px 14px;
		font-size: 0.84rem;
	}
	.btn:disabled {
		opacity: 0.6;
		cursor: progress;
	}
	.link {
		border: none;
		background: none;
		padding: 4px 2px;
		font-size: 0.82rem;
		color: var(--text-muted);
		cursor: pointer;
		text-decoration: underline;
		text-decoration-color: var(--hairline-strong);
		text-underline-offset: 3px;
	}
	.link:hover {
		color: var(--text);
	}
	.why {
		display: block;
		flex-basis: 100%;
		margin-top: 6px;
		font-size: 0.78rem;
		color: var(--text-faint);
		max-width: 60ch;
		overflow-wrap: anywhere;
	}
	.why.bad {
		color: var(--bad);
	}
</style>
