<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';

	let { children, data } = $props();

	const NAV = [
		{ href: '/', label: 'Overview' },
		{ href: '/history', label: 'Listening' },
		{ href: '/library', label: 'Library' },
		{ href: '/liked', label: 'Liked' },
		{ href: '/genres', label: 'Genres' },
		{ href: '/artists', label: 'Artists' },
		{ href: '/albums', label: 'Albums' },
		{ href: '/playlists', label: 'Playlists' }
	];

	const current = $derived(page.url.pathname);
	const isActive = (href: string) =>
		href === '/' ? current === '/' : current.startsWith(href);

	let navList = $state<HTMLUListElement | null>(null);

	/**
	 * On a phone the destinations live in a lane that scrolls sideways, so the
	 * current one can start out of view — the page then gives no sign of where
	 * you are. Centre it in the lane, adjusting the lane's own scroll offset
	 * rather than calling scrollIntoView, which would also move the page.
	 * A no-op wherever the lane is wide enough to show everything.
	 */
	$effect(() => {
		current;
		const link = navList?.querySelector<HTMLElement>('a.on');
		if (!navList || !link) return;
		const lane = navList.getBoundingClientRect();
		const target = link.getBoundingClientRect();
		navList.scrollLeft += target.left - lane.left - (lane.width - target.width) / 2;
	});
</script>

<div class="app">
	<nav aria-label="Main">
		<a class="brand" href="/">
			<span class="mark" aria-hidden="true"></span>
			<span>Spotidata</span>
		</a>
		<ul bind:this={navList}>
			{#each NAV as item (item.href)}
				<li>
					<a href={item.href} class:on={isActive(item.href)} aria-current={isActive(item.href) ? 'page' : undefined}>
						{item.label}
					</a>
				</li>
			{/each}
		</ul>
		<div class="right">
			<a href="/sync" class="chip" class:live={data.activeSync}>
				{#if data.activeSync}<span class="dot" aria-hidden="true"></span>Syncing{:else}Sync{/if}
			</a>
			<a href="/enrich" class="chip">Enrich</a>
			<a href="/settings" class="chip">Settings</a>
		</div>
	</nav>

	{#if data.auth.needsReauth}
		<div class="alert">
			Spotify authorization expired. <a href="/auth/login">Re-authorize</a> — your data is kept.
		</div>
	{:else if data.auth.daysLeft !== null && data.auth.daysLeft < 30}
		<div class="alert warn">
			Spotify authorization expires in {data.auth.daysLeft} days.
			<a href="/auth/login">Renew now</a>
		</div>
	{/if}

	<main>{@render children?.()}</main>
</div>

<style>
	.app {
		max-width: 1220px;
		margin: 0 auto;
		/* max() rather than + : the notch gutter replaces the page gutter in
		   landscape instead of stacking on top of it. */
		padding-left: max(var(--page-px), env(safe-area-inset-left));
		padding-right: max(var(--page-px), env(safe-area-inset-right));
		padding-bottom: calc(80px + env(safe-area-inset-bottom));
	}
	nav {
		display: flex;
		align-items: center;
		gap: 22px;
		padding: 18px 0 22px;
		flex-wrap: wrap;
	}
	nav ul {
		flex-wrap: wrap;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 9px;
		font-weight: 650;
		letter-spacing: -0.02em;
	}
	.mark {
		width: 22px;
		height: 22px;
		border-radius: 7px;
		background: linear-gradient(135deg, var(--accent), var(--accent-2) 55%, var(--accent-3));
	}
	nav ul {
		display: flex;
		gap: 4px;
		list-style: none;
		margin: 0;
		padding: 0;
	}
	nav ul a {
		display: block;
		padding: 6px 12px;
		border-radius: 999px;
		font-size: 0.88rem;
		color: var(--text-muted);
	}
	@media (hover: hover) {
		nav ul a:hover {
			color: var(--text);
			background: rgba(255, 255, 255, 0.04);
		}
	}
	nav ul a.on {
		color: #ddd6fe;
		background: var(--accent-soft);
	}
	.right {
		margin-left: auto;
		display: flex;
		gap: 8px;
	}
	.chip {
		padding: 6px 13px;
		border-radius: 999px;
		border: 1px solid var(--hairline);
		font-size: 0.82rem;
		color: var(--text-muted);
	}
	@media (hover: hover) {
		.chip:hover {
			color: var(--text);
			border-color: var(--hairline-strong);
		}
	}
	.chip.live {
		color: #c4b5fd;
		border-color: rgba(124, 58, 237, 0.5);
		display: inline-flex;
		align-items: center;
		gap: 7px;
	}
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent-2);
		animation: pulse 1.4s ease-in-out infinite;
	}
	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.25;
		}
	}
	.alert {
		padding: 10px 16px;
		border-radius: var(--radius-sm);
		margin-bottom: 16px;
		background: rgba(244, 63, 94, 0.12);
		border: 1px solid rgba(244, 63, 94, 0.32);
		font-size: 0.88rem;
	}
	.alert.warn {
		background: rgba(251, 191, 36, 0.1);
		border-color: rgba(251, 191, 36, 0.3);
	}
	.alert a {
		text-decoration: underline;
	}

	/* ── Phone header ──────────────────────────────────────────────────────
	   Six destinations do not fit one phone row, and wrapping them pushed the
	   bar to three lines. Instead the links become their own full-bleed lane
	   that scrolls sideways, under a compact brand row — and the whole bar
	   sticks, because every page here is long enough to lose the nav. */
	@media (max-width: 760px) {
		nav {
			position: sticky;
			top: 0;
			z-index: 20;
			gap: 10px;
			padding: calc(10px + env(safe-area-inset-top)) 0 8px;
			margin-inline: calc(max(var(--page-px), env(safe-area-inset-left)) * -1);
			padding-inline: max(var(--page-px), env(safe-area-inset-left));
			background: color-mix(in srgb, var(--bg) 86%, transparent);
			backdrop-filter: blur(14px);
			-webkit-backdrop-filter: blur(14px);
			border-bottom: 1px solid var(--hairline);
		}
		nav ul {
			order: 3;
			flex: 1 0 100%;
			flex-wrap: nowrap;
			overflow-x: auto;
			overscroll-behavior-x: contain;
			scroll-snap-type: x proximity;
			scrollbar-width: none;
			/* Full-bleed lane: the active pill can sit flush to the screen edge,
			   which is what makes it read as scrollable. */
			margin-inline: calc(max(var(--page-px), env(safe-area-inset-left)) * -1);
			padding-inline: max(var(--page-px), env(safe-area-inset-left));
		}
		nav ul::-webkit-scrollbar {
			display: none;
		}
		nav ul li {
			flex: none;
			scroll-snap-align: center;
		}
		nav ul a {
			padding: 8px 14px;
			font-size: 0.92rem;
		}
		.brand {
			font-size: 0.98rem;
		}
		.chip {
			padding: 8px 14px;
			font-size: 0.85rem;
		}
		.alert {
			margin-top: 12px;
		}
	}
</style>
