<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import ArtistLinks from '$lib/components/ArtistLinks.svelte';
	import Chip from '$lib/components/Chip.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import { num, pct, relativeTime, trackTime } from '$lib/utils/format.ts';
	import { trackHref, withParams } from '$lib/utils/qs.ts';

	let { data, form } = $props();

	/** Genres shown before the list asks to be expanded. */
	const VISIBLE_GENRES = 60;

	let filter = $state('');
	let expanded = $state(false);
	let creating = $state(false);

	const matching = $derived(
		data.genres.filter((g) => g.genre.includes(filter.trim().toLowerCase()))
	);
	const shown = $derived(expanded || filter ? matching : matching.slice(0, VISIBLE_GENRES));
	const exploreHref = (genre: string) =>
		withParams(page.url, { g: genre === data.explore ? null : genre });
</script>

<svelte:head><title>Genres · Spotidata</title></svelte:head>

<header class="head">
	<div>
		<h1>Genres</h1>
		<p class="muted">
			{num(data.genres.length)} genres from MusicBrainz, which tags the recording rather than the
			artist — {pct(data.coverage.described / Math.max(1, data.coverage.library))} of your library
			has one so far, and <a href="/enrich">enrichment</a> raises that. Collect genres and Spotidata
			keeps a Spotify playlist of everything in them.
		</p>
	</div>
</header>

{#if !data.canWrite}
	<div class="notice">
		This Spotify authorization cannot modify playlists — it predates the feature.
		<a href="/auth/login">Re-authorize</a> to let collections create and update playlists. Everything
		else on this page works either way.
	</div>
{/if}

{#if form?.error}
	<div class="notice bad">{form.error}</div>
{/if}

<section class="collections">
	<div class="section-head">
		<h2>Collections</h2>
		<button class="ghost" onclick={() => (creating = !creating)}>
			{creating ? 'Cancel' : 'New collection'}
		</button>
	</div>

	{#if creating}
		<form class="card new" method="POST" action="?/create" use:enhance>
			<label for="new-name">Name</label>
			<input id="new-name" name="name" placeholder="Late-night house" required />
			{#if data.explore}
				<input type="hidden" name="genre" value={data.explore} />
				<span class="faint small">starts with <strong>{data.explore}</strong></span>
			{/if}
			<button class="primary" type="submit">Create</button>
		</form>
	{/if}

	{#if data.collections.length}
		<div class="grid">
			{#each data.collections as c (c.id)}
				<a class="card collection" href="/genres/{c.id}">
					<div class="row">
						<h3>{c.name}</h3>
						{#if c.spotifyPlaylistId}
							<Chip tone={c.lastSyncError ? 'bad' : 'good'}>
								{c.lastSyncError ? 'sync failed' : `${num(c.syncedTrackCount)} in Spotify`}
							</Chip>
						{:else}
							<Chip>not created</Chip>
						{/if}
					</div>
					<p class="tags">
						{#each c.genres.slice(0, 6) as g (g)}<span class="tag">{g}</span>{/each}
						{#if c.genres.length > 6}<span class="faint xs">+{c.genres.length - 6}</span>{/if}
						{#if c.genres.length === 0}<span class="faint xs">no genres yet</span>{/if}
					</p>
					<p class="faint xs meta">
						{num(c.trackCount)} tracks · {c.match === 'all' ? 'all genres' : 'any genre'}
						{#if c.autoSync}· auto-sync{/if}
						{#if c.lastSyncedAt}· synced {relativeTime(c.lastSyncedAt)}{/if}
					</p>
				</a>
			{/each}
		</div>
	{:else}
		<p class="faint empty">
			No collections yet. Pick a genre below, then “New collection” — or start one empty.
		</p>
	{/if}
</section>

<section class="card picker">
	<div class="section-head">
		<h2>Explore</h2>
		<input
			type="search"
			bind:value={filter}
			placeholder="Filter genres…"
			aria-label="Filter the genre list"
		/>
	</div>

	<div class="chips">
		{#each shown as g (g.genre)}
			<a
				class="chip"
				class:on={g.genre === data.explore}
				href={exploreHref(g.genre)}
				title="{g.tracks} recordings, {g.plays} plays"
			>
				{g.genre}<span class="n faint">{num(g.tracks)}</span>
			</a>
		{:else}
			<span class="faint small">No genre matches “{filter}”.</span>
		{/each}
	</div>

	{#if !filter && matching.length > VISIBLE_GENRES}
		<button class="ghost more" onclick={() => (expanded = !expanded)}>
			{expanded ? 'Show fewer' : `Show all ${num(matching.length)} genres`}
		</button>
	{/if}
</section>

{#if data.explore}
	<section class="card preview">
		<div class="section-head">
			<h2>{data.explore}</h2>
			<form class="add" method="POST" action="?/add" use:enhance>
				<input type="hidden" name="genre" value={data.explore} />
				{#if data.collections.length}
					<label class="sr" for="add-to">Add to collection</label>
					<select id="add-to" name="collection">
						{#each data.collections as c (c.id)}
							<option value={c.id}>{c.name}</option>
						{/each}
					</select>
					<button class="primary" type="submit">Add genre</button>
				{:else}
					<button class="primary" type="button" onclick={() => (creating = true)}>
						Start a collection with it
					</button>
				{/if}
			</form>
		</div>

		<ol class="tracks">
			{#each data.preview as t (t.canonicalTrackId)}
				<li>
					<Cover src={t.cover} alt="{t.albumName ?? t.title} cover" size={32} />
					<span class="who">
						<a href={trackHref(t.canonicalTrackId)}>{t.title}</a>
						<span class="faint xs"><ArtistLinks artists={t.artists} /></span>
					</span>
					<span class="faint xs nowrap">{trackTime(t.durationMs)}</span>
					<span class="faint xs nowrap num" title="Plays in your history">{t.plays || '—'}</span>
				</li>
			{:else}
				<li class="faint">Nothing in your library carries that genre yet.</li>
			{/each}
		</ol>
		<p class="faint xs">Most-played first. A collection shows the whole set, in your chosen order.</p>
	</section>
{/if}

<style>
	.head {
		margin-bottom: var(--gap);
	}
	.head p {
		margin: 4px 0 0;
		font-size: 0.86rem;
		max-width: 70ch;
	}
	.head a,
	.notice a {
		text-decoration: underline;
	}
	.notice {
		padding: 10px 16px;
		border-radius: var(--radius-sm);
		margin-bottom: var(--gap);
		font-size: 0.86rem;
		background: rgba(251, 191, 36, 0.1);
		border: 1px solid rgba(251, 191, 36, 0.3);
	}
	.notice.bad {
		background: rgba(244, 63, 94, 0.12);
		border-color: rgba(244, 63, 94, 0.32);
	}
	.card {
		padding: var(--card-py) var(--card-px);
	}
	.collections {
		margin-bottom: var(--gap);
	}
	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
		margin-bottom: 12px;
	}
	h2 {
		font-size: 1rem;
		margin: 0;
	}
	h3 {
		font-size: 0.96rem;
		margin: 0;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: 12px;
	}
	.collection {
		display: block;
	}
	.collection:hover {
		border-color: var(--hairline-strong);
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin: 10px 0 8px;
	}
	.tag {
		padding: 1px 8px;
		border-radius: 999px;
		border: 1px solid var(--hairline);
		font-size: 0.7rem;
		color: var(--text-faint);
	}
	.meta {
		margin: 0;
	}
	.empty {
		font-size: 0.86rem;
	}
	.new {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-bottom: 12px;
	}
	.new label {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-faint);
	}
	input,
	select {
		padding: 7px 12px;
		border-radius: 999px;
		border: 1px solid var(--hairline-strong);
		background: var(--bg-elevated);
		color: var(--text);
		font-size: 0.84rem;
		font-family: inherit;
		outline: none;
	}
	input:focus,
	select:focus {
		border-color: rgba(124, 58, 237, 0.6);
	}
	.new input {
		flex: 1 1 220px;
	}
	.primary,
	.ghost {
		border-radius: 999px;
		border: 1px solid var(--hairline-strong);
		background: var(--bg-elevated);
		color: var(--text-muted);
		font-family: inherit;
		font-size: 0.82rem;
		padding: 7px 14px;
		cursor: pointer;
	}
	.primary {
		color: #ddd6fe;
		background: var(--accent-soft);
		border-color: rgba(124, 58, 237, 0.45);
	}
	.primary:hover {
		border-color: rgba(124, 58, 237, 0.9);
	}
	.ghost:hover {
		color: var(--text);
	}
	.picker {
		margin-bottom: var(--gap);
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		/* Deep into the tail the list is long; it scrolls rather than pushing the
		   collections off the screen. */
		max-height: 300px;
		overflow-y: auto;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 3px 10px;
		border-radius: 999px;
		border: 1px solid var(--hairline-strong);
		background: var(--bg-elevated);
		color: var(--text-muted);
		font-size: 0.76rem;
		line-height: 1.6;
		white-space: nowrap;
	}
	.chip:hover {
		color: var(--text);
	}
	.chip.on {
		color: #ddd6fe;
		background: var(--accent-soft);
		border-color: rgba(124, 58, 237, 0.4);
	}
	.chip .n {
		font-variant-numeric: tabular-nums;
		font-size: 0.7rem;
	}
	.more {
		margin-top: 12px;
	}
	.add {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
	}
	.tracks {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 2px;
	}
	.tracks li {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 4px 0;
		border-bottom: 1px solid rgba(255, 255, 255, 0.03);
		font-size: 0.86rem;
	}
	.who {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		line-height: 1.25;
	}
	.who a:hover {
		text-decoration: underline;
	}
	.xs {
		font-size: 0.73rem;
	}
	.small {
		font-size: 0.82rem;
	}
	.nowrap {
		white-space: nowrap;
	}
	.preview p {
		margin: 10px 0 0;
	}
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}

	@media (pointer: coarse) {
		.chip {
			padding: 8px 14px;
			font-size: 0.82rem;
		}
	}
	@media (max-width: 640px) {
		.section-head input[type='search'] {
			flex: 1 1 100%;
		}
	}
</style>
