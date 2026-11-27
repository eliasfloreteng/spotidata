<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import Icon, { type IconName } from '$lib/components/Icon.svelte';
	import Sheet from '$lib/components/Sheet.svelte';

	let { children, data } = $props();

	const NAV = [
		{ href: '/', label: 'Overview' },
		{ href: '/library', label: 'Library' },
		{ href: '/dj', label: 'DJ' },
		{ href: '/artists', label: 'Artists' },
		{ href: '/albums', label: 'Albums' },
		{ href: '/playlists', label: 'Playlists' },
		{ href: '/automations', label: 'Automations' }
	];

	const current = $derived(page.url.pathname);
	// The log and the importer are the overview's own subpages.
	const isActive = (href: string) =>
		href === '/' ? current === '/' || current.startsWith('/history') : current.startsWith(href);

	/**
	 * A phone gets a tab bar along the bottom instead: four destinations a thumb
	 * reaches without looking, and the rest one tap further in a sheet. A detail
	 * page lights the tab of the list it belongs to.
	 */
	const TABS: { href: string; label: string; icon: IconName; match: string[] }[] = [
		{ href: '/', label: 'Overview', icon: 'overview', match: ['/history'] },
		{ href: '/library', label: 'Library', icon: 'library', match: ['/library', '/track', '/liked'] },
		{ href: '/artists', label: 'Artists', icon: 'artists', match: ['/artist'] },
		{ href: '/playlists', label: 'Playlists', icon: 'playlists', match: ['/playlist', '/radio'] }
	];
	const MORE: { href: string; label: string; icon: IconName; note: string }[] = [
		{ href: '/albums', label: 'Albums', icon: 'albums', note: 'Every album in the library' },
		{ href: '/dj', label: 'DJ', icon: 'dj', note: 'Build a set by key and tempo' },
		{ href: '/automations', label: 'Automations', icon: 'automations', note: 'Playlists that collect from others' },
		{ href: '/history/log', label: 'Play log', icon: 'log', note: 'Every play, newest first' },
		{ href: '/history/import', label: 'Listening history', icon: 'import', note: 'Import Spotify’s streaming archive' },
		{ href: '/sync', label: 'Sync', icon: 'sync', note: 'Runs, phases and the event log' },
		{ href: '/settings', label: 'Settings', icon: 'settings', note: 'Account, links, display and sync' }
	];

	const tabOn = (tab: (typeof TABS)[number]) =>
		tab.href === '/'
			? current === '/' || tab.match.some((m) => current.startsWith(m))
			: tab.match.some((m) => current.startsWith(m));
	const moreOn = (href: string) => current === href || current.startsWith(href + '/') || (href === '/albums' && current.startsWith('/album/'));
	const inMore = $derived(!TABS.some(tabOn));

	let moreOpen = $state(false);
	// Following a link out of the sheet lands on a new page: the sheet goes.
	$effect(() => {
		current;
		moreOpen = false;
	});
</script>

<div class="app">
	<nav aria-label="Main">
		<a class="brand" href="/">
			<span class="mark" aria-hidden="true"></span>
			<span>Spotidata</span>
		</a>
		<ul>
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
			<a href="/settings" class="chip settings">Settings</a>
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

<nav class="tabs" aria-label="Sections">
	{#each TABS as tab (tab.href)}
		{@const on = tabOn(tab)}
		<a href={tab.href} class:on aria-current={on ? 'page' : undefined}>
			<Icon name={tab.icon} size={22} />
			<span>{tab.label}</span>
		</a>
	{/each}
	<button type="button" class:on={inMore} aria-haspopup="dialog" onclick={() => (moreOpen = true)}>
		<Icon name="more" size={22} />
		<span>More</span>
	</button>
</nav>

<Sheet bind:open={moreOpen} title="More">
	<ul class="more">
		{#each MORE as item (item.href)}
			{@const on = moreOn(item.href)}
			<li>
				<a href={item.href} class:on aria-current={on ? 'page' : undefined}>
					<span class="glyph"><Icon name={item.icon} /></span>
					<span class="text">
						<span class="label">
							{item.label}
							{#if item.href === '/sync' && data.activeSync}<span class="dot" aria-label="running"></span>{/if}
						</span>
						<span class="note">{item.note}</span>
					</span>
					<Icon name="chevron" size={16} />
				</a>
			</li>
		{/each}
	</ul>
</Sheet>

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

	/* The tab bar and its sheet exist on a phone only. */
	.tabs {
		display: none;
	}
	.more {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.more a {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 11px 4px;
		color: var(--text-faint);
		border-bottom: 1px solid var(--hairline);
	}
	.more li:last-child a {
		border-bottom: 0;
	}
	.glyph {
		display: grid;
		place-items: center;
		width: 38px;
		height: 38px;
		border-radius: 11px;
		background: rgba(255, 255, 255, 0.04);
		color: var(--text-muted);
	}
	.more a.on .glyph {
		background: var(--accent-soft);
		color: #ddd6fe;
	}
	.text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.label {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		color: var(--text);
		font-size: 0.95rem;
	}
	.more a.on .label {
		color: #ddd6fe;
	}
	.note {
		font-size: 0.78rem;
		color: var(--text-faint);
	}

	/* ── Phone ─────────────────────────────────────────────────────────────
	   Seven destinations never fit one phone row, and a sideways-scrolling
	   lane of them hid where you were. The header keeps the brand and the sync
	   state; the destinations move to a tab bar on the bottom edge, where the
	   thumb already is, with the rest in a sheet behind More. */
	@media (max-width: 760px) {
		.app {
			padding-bottom: calc(96px + env(safe-area-inset-bottom));
		}
		nav:not(.tabs) {
			padding: calc(12px + env(safe-area-inset-top)) 0 14px;
			flex-wrap: nowrap;
		}
		nav:not(.tabs) ul,
		.settings {
			display: none;
		}
		.brand {
			font-size: 0.98rem;
		}
		.chip {
			padding: 7px 14px;
			font-size: 0.85rem;
		}
		.tabs {
			position: fixed;
			z-index: 30;
			inset: auto 0 0;
			display: grid;
			grid-template-columns: repeat(5, 1fr);
			gap: 0;
			padding: 6px max(6px, env(safe-area-inset-left)) calc(6px + env(safe-area-inset-bottom))
				max(6px, env(safe-area-inset-right));
			background: color-mix(in srgb, var(--bg) 88%, transparent);
			backdrop-filter: blur(16px) saturate(1.4);
			-webkit-backdrop-filter: blur(16px) saturate(1.4);
			border-top: 1px solid var(--hairline-strong);
		}
		.tabs a,
		.tabs button {
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 3px;
			min-height: 50px;
			padding: 6px 0 4px;
			border: 0;
			border-radius: 12px;
			background: none;
			color: var(--text-faint);
			font: inherit;
			font-size: 0.68rem;
			font-weight: 500;
			letter-spacing: 0.01em;
			cursor: pointer;
		}
		.tabs .on {
			color: #ddd6fe;
		}
		.tabs .on :global(svg) {
			filter: drop-shadow(0 2px 8px rgba(124, 58, 237, 0.55));
		}
		.tabs a:active,
		.tabs button:active {
			background: rgba(255, 255, 255, 0.05);
		}
		.alert {
			margin-top: 0;
		}
	}
</style>
