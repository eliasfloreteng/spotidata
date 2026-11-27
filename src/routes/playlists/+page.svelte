<script lang="ts">
	import Chip from '$lib/components/Chip.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import FilterBar from '$lib/components/FilterBar.svelte';
	import Pager from '$lib/components/Pager.svelte';
	import SearchBox from '$lib/components/SearchBox.svelte';
	import SpotifyLink from '$lib/components/SpotifyLink.svelte';
	import { PLAYLIST_FILTERS } from '$lib/filters.ts';
	import { duration, longDuration, num, plainText, shortDate } from '$lib/utils/format.ts';

	let { data } = $props();

	const SORTS = [
		{ key: 'tracks', label: 'Tracks' },
		{ key: 'name', label: 'Name', initial: 'asc' as const },
		{ key: 'library', label: 'In library' },
		{ key: 'duration', label: 'Time' },
		{ key: 'added', label: 'Last add' },
		{ key: 'owner', label: 'Owner', initial: 'asc' as const },
		{ key: 'listened', label: 'Listened' }
	];

	const owned = $derived(data.rows.filter((p) => p.isOwned).length);
</script>

<svelte:head><title>Playlists · Spotidata</title></svelte:head>

<header class="head">
	<div>
		<h1>Playlists</h1>
		<p class="muted">
			{num(data.total)} playlists{#if data.q} matching “{data.q}”{/if} — {num(owned)} of the ones
			shown are yours and count toward the library.
		</p>
	</div>
	<SearchBox value={data.q} placeholder="Search playlists" />
</header>

<FilterBar
	groups={PLAYLIST_FILTERS}
	active={data.filters}
	sorts={SORTS}
	sort={data.sort}
	dir={data.dir}
/>

<section class="card">
	<ul class="list cards">
		{#each data.rows as p (p.id)}
			<li>
				<a class="pl lead" href="/playlist/{p.id}">
					<Cover src={p.cover} alt="{p.name} cover" size={56} />
					<span class="body">
						<span class="row1">
							<span class="name">{p.name}</span>
							{#if p.isOwned}<Chip tone="accent">Yours</Chip>{/if}
							{#if p.collaborative}<Chip tone="good">Collab</Chip>{/if}
							{#if p.public === false}<Chip>Private</Chip>{/if}
						</span>
						{#if p.description}
							<span class="desc faint">{plainText(p.description)}</span>
						{/if}
						<span class="narrow-only faint xs clip">
							{p.ownerName ?? p.ownerId ?? 'unknown owner'}
						</span>
						<span class="stats faint xs wide-only">
							<span class="num">{num(p.tracks)}</span> tracks ·
							<span class="num">{longDuration(p.durationMs)}</span> ·
							<span class="num">{num(p.libraryTracks)}</span> in library ·
							{#if p.plays > 0}
								<span
									class="num"
									title="Listening to the recordings this playlist holds, wherever you played them from"
								>{longDuration(p.msPlayed)}</span> played ·
							{/if}
							{p.ownerName ?? p.ownerId ?? 'unknown owner'}
							{#if p.lastAddedAt}· last add {shortDate(p.lastAddedAt)}{/if}
						</span>
					</span>
				</a>
				<!-- A phone lays the same facts out as labelled stats, aligned down the list. -->
				<span class="narrow-only" data-label="Tracks" class:on={data.sort === 'tracks'}>{num(p.tracks)}</span>
				<span class="narrow-only" data-label="In library" class:on={data.sort === 'library'}>
					{num(p.libraryTracks)}
				</span>
				<span class="narrow-only" data-label="Length" class:on={data.sort === 'duration'}>
					{duration(p.durationMs / 1000)}
				</span>
				<span
					class="narrow-only"
					class:faint={p.plays === 0}
					data-label="Played"
					class:on={data.sort === 'listened'}
				>
					{p.plays > 0 ? duration(p.msPlayed / 1000) : '—'}
				</span>
				<span class="narrow-only" data-label="Last add" class:on={data.sort === 'added'}>
					{shortDate(p.lastAddedAt)}
				</span>
				<span class="corner">
					<SpotifyLink kind="playlist" id={p.id} compact label="Open {p.name} in Spotify" />
				</span>
			</li>
		{:else}
			<li class="empty faint">No playlists match that search.</li>
		{/each}
	</ul>
	<Pager page={data.page} pages={data.pages} total={data.total} pageSize={data.pageSize} unit="playlists" />
</section>

<style>
	.head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 16px;
		margin-bottom: var(--gap);
		flex-wrap: wrap;
	}
	.head p {
		margin: 4px 0 0;
		font-size: 0.86rem;
	}
	.card {
		padding: 10px var(--card-px) var(--card-py);
	}
	.list {
		list-style: none;
		margin: 0 0 6px;
		padding: 0;
	}
	.list li {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 9px 0;
		border-bottom: 1px solid rgba(255, 255, 255, 0.03);
	}
	.pl {
		display: flex;
		align-items: center;
		gap: 14px;
		flex: 1;
		min-width: 0;
	}
	.pl:hover .name {
		color: #fff;
	}
	.body {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.row1 {
		display: flex;
		align-items: center;
		gap: 7px;
		flex-wrap: wrap;
	}
	.name {
		font-size: 0.95rem;
	}
	.desc {
		font-size: 0.8rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 78ch;
	}
	.xs {
		font-size: 0.75rem;
	}
	.empty {
		padding: 30px 0;
		justify-content: center;
	}

	.clip {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* Phone: a row card (app.css › Rows as cards). The stats line was five
	   facts strung together and wrapped wherever it ran out; they become
	   labelled stats that line up down the list, the owner a line of its own. */
	@media (max-width: 640px) {
		.list {
			--card-cols: minmax(0, 0.75fr) minmax(0, 0.9fr) repeat(2, minmax(0, 1fr)) minmax(0, 1.65fr);
			--card-gap: 10px;
		}
		.pl {
			align-items: flex-start;
		}
		.pl :global(img),
		.pl :global(.placeholder) {
			width: 52px !important;
			height: 52px !important;
		}
		.desc {
			font-size: 0.78rem;
		}
	}
</style>
