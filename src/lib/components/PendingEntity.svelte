<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';

	interface Props {
		kind: 'track' | 'album' | 'artist' | 'playlist';
		id: string;
	}
	let { kind, id }: Props = $props();

	const MAX_TRIES = 20;
	let tries = $state(0);
	let gaveUp = $state(false);

	onMount(() => {
		// The row does not exist yet: an on-demand fetch is queued behind the
		// rate limiter. Re-running the load is the whole check — as soon as the
		// worker commits the row this component is replaced by the real page.
		let timer: ReturnType<typeof setTimeout>;
		const tick = async () => {
			if (tries >= MAX_TRIES) {
				gaveUp = true;
				return;
			}
			tries += 1;
			await invalidateAll();
			timer = setTimeout(tick, 1500);
		};
		timer = setTimeout(tick, 1500);
		return () => clearTimeout(timer);
	});
</script>

<section class="card pending">
	<div class="row">
		<div class="block art"></div>
		<div class="lines">
			<div class="block l1"></div>
			<div class="block l2"></div>
			<div class="block l3"></div>
		</div>
	</div>

	<p class="note">
		{#if gaveUp}
			Still waiting on Spotify after {MAX_TRIES} checks. The fetch stays queued —
			<a href="/sync">check the queue</a> or reload this page.
		{:else}
			Fetching this {kind} from Spotify. The request is queued behind the shared rate limiter;
			this page refreshes itself
			<span class="num">({tries}/{MAX_TRIES})</span>.
		{/if}
	</p>
	<p class="faint small">{kind} <span class="mono">{id}</span></p>

	<div class="rows">
		{#each Array.from({ length: 6 }, (_, i) => i) as i (i)}
			<div class="block line"></div>
		{/each}
	</div>
</section>

<style>
	.pending {
		padding: 22px 24px;
	}
	.row {
		display: flex;
		gap: 20px;
		align-items: flex-end;
	}
	.lines {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.block {
		background: linear-gradient(
			100deg,
			rgba(255, 255, 255, 0.04) 30%,
			rgba(255, 255, 255, 0.09) 50%,
			rgba(255, 255, 255, 0.04) 70%
		);
		background-size: 300% 100%;
		animation: shimmer 1.5s linear infinite;
		border-radius: 8px;
	}
	@keyframes shimmer {
		to {
			background-position: -300% 0;
		}
	}
	.art {
		width: 160px;
		height: 160px;
		border-radius: 14px;
	}
	.l1 {
		height: 34px;
		width: 55%;
	}
	.l2 {
		height: 16px;
		width: 35%;
	}
	.l3 {
		height: 16px;
		width: 45%;
	}
	.rows {
		display: flex;
		flex-direction: column;
		gap: 9px;
		margin-top: 18px;
	}
	.line {
		height: 15px;
	}
	.rows .line:nth-child(even) {
		width: 82%;
	}
	.note {
		margin: 20px 0 2px;
		font-size: 0.88rem;
		color: var(--text-muted);
	}
	.note a {
		text-decoration: underline;
	}
	.small {
		font-size: 0.78rem;
		margin: 0;
	}
	.mono {
		font-family: var(--mono);
	}
</style>
