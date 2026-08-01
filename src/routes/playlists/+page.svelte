<script lang="ts">
	import Chip from '$lib/components/Chip.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import Pager from '$lib/components/Pager.svelte';
	import SearchBox from '$lib/components/SearchBox.svelte';
	import SpotifyLink from '$lib/components/SpotifyLink.svelte';
	import { longDuration, num, plainText, shortDate } from '$lib/utils/format.ts';

	let { data } = $props();

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
	<SearchBox value={data.q} placeholder="Search playlists" keep={[]} />
</header>

<section class="card">
	<ul class="list">
		{#each data.rows as p (p.id)}
			<li>
				<a class="pl" href="/playlist/{p.id}">
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
						<span class="stats faint xs">
							<span class="num">{num(p.tracks)}</span> tracks ·
							<span class="num">{longDuration(p.durationMs)}</span> ·
							<span class="num">{num(p.libraryTracks)}</span> in library ·
							{p.ownerName ?? p.ownerId ?? 'unknown owner'}
							{#if p.lastAddedAt}· last add {shortDate(p.lastAddedAt)}{/if}
						</span>
					</span>
				</a>
				<SpotifyLink kind="playlist" id={p.id} compact label="Open {p.name} in Spotify" />
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
		padding: 10px 18px 16px;
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
</style>
