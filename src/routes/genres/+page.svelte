<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import ArtistLinks from '$lib/components/ArtistLinks.svelte';
	import Chip from '$lib/components/Chip.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import { duration, longDuration, num, pct, relativeTime, trackTime } from '$lib/utils/format.ts';
	import { genreHref, toggleValue, trackHref, withParams } from '$lib/utils/qs.ts';

	let { data, form } = $props();

	/** Genres shown before the list asks to be expanded. */
	const VISIBLE_GENRES = 72;

	/**
	 * What the chips are ranked and sized by. Client-side, because the whole
	 * vocabulary is already here — 531 genres is one small array, and a sort that
	 * costs a round trip discourages the comparison it exists to make.
	 */
	const METRICS = [
		{ key: 'tracks', label: 'Owned' },
		{ key: 'plays', label: 'Played' },
		{ key: 'listened', label: 'Time' },
		{ key: 'az', label: 'A–Z' }
	] as const;
	type Metric = (typeof METRICS)[number]['key'];

	let metric = $state<Metric>('tracks');
	let filter = $state('');
	let expanded = $state(false);
	let creating = $state(false);

	type GenreRow = (typeof data.genres)[number];
	const weightOf = (g: GenreRow) =>
		metric === 'plays' ? g.plays : metric === 'listened' ? g.msPlayed : g.tracks;
	const countOf = (g: GenreRow) =>
		metric === 'plays'
			? `${num(g.plays)} plays`
			: metric === 'listened'
				? duration(g.msPlayed / 1000)
				: `${num(g.tracks)} recordings`;

	const ranked = $derived.by(() => {
		const rows = [...data.genres];
		return metric === 'az'
			? rows.sort((a, b) => a.genre.localeCompare(b.genre))
			: rows.sort((a, b) => weightOf(b) - weightOf(a) || a.genre.localeCompare(b.genre));
	});
	const heaviest = $derived(Math.max(1, ...data.genres.map(weightOf)));

	const matching = $derived(
		ranked.filter((g) => g.genre.includes(filter.trim().toLowerCase()))
	);
	const shown = $derived(expanded || filter ? matching : matching.slice(0, VISIBLE_GENRES));

	/**
	 * Chip size is the square root of the metric, not the metric: `pop` holds
	 * fifty times what `italo disco` does, and a linear scale would make one
	 * unreadable to keep the other legible. Sqrt is the same correction an area
	 * encoding needs, which is what a chip's footprint is.
	 */
	const size = (g: GenreRow) => Math.sqrt(weightOf(g) / heaviest);

	const staged = $derived(new Set(data.selected));
	/** Genres already filtering a saved collection — worth knowing while building another. */
	const collected = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const c of data.collections) {
			for (const g of c.genres) counts.set(g, (counts.get(g) ?? 0) + 1);
		}
		return counts;
	});

	const toggleHref = (genre: string) => toggleValue(page.url, 'g', genre);
	const clearHref = $derived(withParams(page.url, { g: null, m: null }));
	const matchHref = (m: 'any' | 'all') => withParams(page.url, { m: m === 'any' ? null : 'all' });

	const stats = $derived(data.stats);
	/** Which of the staged genres put a track in the set — only interesting under "any". */
	const why = (genres: string[]) =>
		data.match === 'any' && data.selected.length > 1
			? genres.filter((g) => staged.has(g)).slice(0, 2)
			: [];
</script>

<svelte:head><title>Genres · Spotidata</title></svelte:head>

<header class="head">
	<div class="intro">
		<h1>Genres</h1>
		<p class="muted">
			{num(data.genres.length)} genres from MusicBrainz, which tags the recording rather than the
			artist. Stage a few, watch the set add up, and keep it as a Spotify playlist that recomputes
			itself.
		</p>
	</div>

	<div class="coverage" title="{num(data.coverage.described)} of {num(data.coverage.library)} recordings carry a genre">
		<div class="bar" aria-hidden="true">
			<span style="width:{Math.round((data.coverage.described / Math.max(1, data.coverage.library)) * 100)}%"></span>
		</div>
		<p class="faint xs">
			{pct(data.coverage.described / Math.max(1, data.coverage.library))} of your library is
			described — <a href="/enrich">enrichment</a> raises it.
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
			{creating ? 'Cancel' : 'Empty collection'}
		</button>
	</div>

	{#if creating}
		<form class="card new" method="POST" action="?/create" use:enhance>
			<label for="new-name">Name</label>
			<input id="new-name" name="name" placeholder="Late-night house" required />
			<button class="primary" type="submit">Create</button>
			<span class="faint xs">Genres get added on the collection's own page.</span>
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
			No collections yet. Stage genres below and name the set — that is all a collection is.
		</p>
	{/if}
</section>

<section class="card picker">
	<div class="section-head">
		<h2>Explore</h2>
		<div class="controls">
			<div class="segmented" role="group" aria-label="Rank genres by">
				{#each METRICS as m (m.key)}
					<button class:on={metric === m.key} onclick={() => (metric = m.key)}>{m.label}</button>
				{/each}
			</div>
			<input
				type="search"
				bind:value={filter}
				placeholder="Filter genres…"
				aria-label="Filter the genre list"
			/>
		</div>
	</div>

	<div class="chips">
		{#each shown as g (g.genre)}
			{@const on = staged.has(g.genre)}
			<span class="chip" class:on style="--w:{size(g)}">
				<a
					class="pick"
					href={toggleHref(g.genre)}
					data-sveltekit-noscroll
					data-sveltekit-keepfocus
					title="{on ? 'Remove' : 'Stage'} {g.genre} — {countOf(g)}, {num(g.plays)} plays"
				>
					{#if collected.has(g.genre)}
						<span class="dot" aria-hidden="true" title="in a collection"></span>
					{/if}
					{g.genre}<span class="n faint num">
						{metric === 'listened' ? duration(g.msPlayed / 1000) : num(weightOf(g))}
					</span>
				</a>
				<a class="go" href={genreHref(g.genre)} aria-label="Open {g.genre}" title="Open {g.genre}">
					›
				</a>
			</span>
		{:else}
			<span class="faint small">No genre matches “{filter}”.</span>
		{/each}
	</div>

	{#if !filter && matching.length > VISIBLE_GENRES}
		<button class="ghost more" onclick={() => (expanded = !expanded)}>
			{expanded ? 'Show fewer' : `Show all ${num(matching.length)} genres`}
		</button>
	{:else if !data.selected.length}
		<p class="faint xs hint">
			Stage a genre and this page counts the set as you build it. The arrow opens the genre itself.
		</p>
	{/if}
</section>

<!-- The staged set. Sticky at the bottom because it is the thing being built:
     the chips are above it, the resolved tracks below, and both are read
     against these numbers. It exists only while something is staged. -->
{#if data.selected.length}
	<div class="cart" aria-label="Staged genres">
		<div class="picked">
			{#each data.selected as g (g)}
				<a class="tag" href={toggleHref(g)} data-sveltekit-noscroll title="Remove {g}">
					{g}<span aria-hidden="true">×</span>
				</a>
			{/each}
			<a class="clearall faint xs" href={clearHref}>Clear</a>
		</div>

		<div class="sums">
			<span class="match" role="group" aria-label="Match mode">
				<a href={matchHref('any')} class:on={data.match === 'any'} data-sveltekit-noscroll>any</a>
				<a href={matchHref('all')} class:on={data.match === 'all'} data-sveltekit-noscroll>all</a>
			</span>
			<span class="figure"><strong class="num">{num(stats.tracks)}</strong> recordings</span>
			<span class="faint">{num(stats.artists)} artists</span>
			<span class="faint">{longDuration(stats.durationMs)} long</span>
			<span class="faint">{num(stats.plays)} plays · {longDuration(stats.msPlayed)} listened</span>
		</div>

		<div class="keep">
			<form method="POST" action="?/create" use:enhance>
				{#each data.selected as g (g)}<input type="hidden" name="genre" value={g} />{/each}
				<input type="hidden" name="match" value={data.match} />
				<label class="sr" for="keep-name">Collection name</label>
				<input id="keep-name" name="name" placeholder="Name this set…" required />
				<button class="primary" type="submit" disabled={stats.tracks === 0}>Keep as collection</button>
			</form>

			{#if data.collections.length}
				<form method="POST" action="?/add" use:enhance>
					{#each data.selected as g (g)}<input type="hidden" name="genre" value={g} />{/each}
					<label class="sr" for="add-to">Add to collection</label>
					<select id="add-to" name="collection">
						{#each data.collections as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
					</select>
					<button class="ghost" type="submit">Add to it</button>
				</form>
			{/if}
		</div>
	</div>

	<section class="card preview">
		<div class="section-head">
			<h2>
				{data.match === 'all' ? 'All of' : 'Any of'}
				{data.selected.length} genre{data.selected.length === 1 ? '' : 's'}
			</h2>
			<p class="faint xs">
				{#if stats.tracks > data.previewLimit}
					Most-played {num(data.previewLimit)} of {num(stats.tracks)} — a collection holds the
					whole set, in your chosen order.
				{:else if stats.tracks}
					Most-played first.
				{/if}
			</p>
		</div>

		<ol class="tracks">
			{#each data.preview as t (t.canonicalTrackId)}
				<li>
					<Cover src={t.cover} alt="{t.albumName ?? t.title} cover" size={32} />
					<span class="who">
						<a href={trackHref(t.canonicalTrackId)}>{t.title}</a>
						<span class="faint xs"><ArtistLinks artists={t.artists} /></span>
					</span>
					{#each why(t.genres) as g (g)}
						<a class="tag why" href={genreHref(g)}>{g}</a>
					{/each}
					<span class="faint xs nowrap">{trackTime(t.durationMs)}</span>
					<span class="faint xs nowrap num" title="Plays in your history">{t.plays || '—'}</span>
				</li>
			{:else}
				<li class="faint">
					{data.match === 'all'
						? 'Nothing carries all of those at once. Fewer genres, or match any.'
						: 'Nothing in your library carries those genres yet.'}
				</li>
			{/each}
		</ol>
	</section>
{/if}

<style>
	.head {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--gap);
		flex-wrap: wrap;
		margin-bottom: var(--gap);
	}
	.intro {
		max-width: 62ch;
	}
	.head p {
		margin: 4px 0 0;
		font-size: 0.86rem;
	}
	.head a,
	.notice a {
		text-decoration: underline;
	}
	/* The coverage number explains every surprising result on this page, so it
	   is a reading rather than a clause in a paragraph. */
	.coverage {
		flex: 0 1 260px;
	}
	.coverage .bar {
		height: 5px;
		border-radius: 999px;
		background: var(--bg-elevated);
		border: 1px solid var(--hairline);
		overflow: hidden;
	}
	.coverage .bar span {
		display: block;
		height: 100%;
		background: linear-gradient(90deg, var(--accent), var(--accent-2));
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
	.section-head p {
		margin: 0;
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
	.primary:hover:not(:disabled) {
		border-color: rgba(124, 58, 237, 0.9);
	}
	.primary:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.ghost:hover {
		color: var(--text);
	}
	.picker {
		margin-bottom: var(--gap);
	}
	.controls {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.segmented {
		display: inline-flex;
		border: 1px solid var(--hairline-strong);
		background: var(--bg-elevated);
		border-radius: 999px;
		padding: 2px;
	}
	.segmented button {
		border: 0;
		background: none;
		color: var(--text-faint);
		font-family: inherit;
		font-size: 0.76rem;
		padding: 4px 10px;
		border-radius: 999px;
		cursor: pointer;
	}
	.segmented button.on {
		color: #ddd6fe;
		background: var(--accent-soft);
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		/* Deep into the tail the list is long; it scrolls rather than pushing the
		   collections off the screen. */
		max-height: 320px;
		overflow-y: auto;
	}
	/* One pill, two destinations: the label stages the genre, the arrow opens it.
	   Nested anchors are not markup, so the pill is a container and the border
	   lives on it rather than on either link. */
	.chip {
		display: inline-flex;
		align-items: stretch;
		border-radius: 999px;
		border: 1px solid var(--hairline-strong);
		background: var(--bg-elevated);
		font-size: calc(0.73rem + var(--w) * 0.19rem);
		line-height: 1.55;
		white-space: nowrap;
		/* Weight reads twice: the type gets bigger and the edge gets brighter,
		   which survives both a glance and a screenshot at 50%. */
		border-color: color-mix(in srgb, var(--accent) calc(var(--w) * 55%), var(--hairline-strong));
	}
	.chip .pick {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 3px 4px 3px 11px;
		color: var(--text-muted);
		border-radius: 999px 0 0 999px;
	}
	.chip .go {
		display: inline-flex;
		align-items: center;
		padding: 0 9px 0 5px;
		color: var(--text-faint);
		border-radius: 0 999px 999px 0;
		opacity: 0;
	}
	.chip:hover .go,
	.chip:focus-within .go {
		opacity: 1;
	}
	.chip .go:hover {
		color: var(--text);
		background: var(--card-hover);
	}
	.chip:hover .pick {
		color: var(--text);
	}
	.chip.on {
		color: #ddd6fe;
		background: var(--accent-soft);
		border-color: rgba(124, 58, 237, 0.55);
	}
	.chip.on .pick {
		color: #ddd6fe;
	}
	.chip .n {
		font-size: 0.7rem;
	}
	.chip .dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--good);
		opacity: 0.75;
	}
	.more {
		margin-top: 12px;
	}
	.hint {
		margin: 12px 0 0;
	}

	/* ── The staged set ──────────────────────────────────────────────────── */
	.cart {
		position: sticky;
		bottom: max(10px, env(safe-area-inset-bottom));
		z-index: 15;
		margin-bottom: var(--gap);
		padding: 10px var(--card-px) 12px;
		border-radius: var(--radius);
		border: 1px solid rgba(124, 58, 237, 0.35);
		background: color-mix(in srgb, var(--card) 88%, transparent);
		backdrop-filter: blur(14px);
		-webkit-backdrop-filter: blur(14px);
		box-shadow: var(--shadow);
		max-height: 48vh;
		overflow-y: auto;
	}
	.picked {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 5px;
		max-height: 66px;
		overflow-y: auto;
	}
	.picked .tag {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 2px 9px;
		font-size: 0.76rem;
		color: #ddd6fe;
		background: var(--accent-soft);
		border-color: rgba(124, 58, 237, 0.4);
	}
	.picked .tag:hover {
		border-color: var(--bad);
		color: var(--bad);
	}
	.clearall {
		text-decoration: underline;
		margin-left: 4px;
	}
	.sums {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 4px 10px;
		margin-top: 9px;
		font-size: 0.82rem;
	}
	.sums .figure strong {
		font-size: 1.05rem;
		font-weight: 650;
	}
	.match {
		display: inline-flex;
		border: 1px solid var(--hairline-strong);
		border-radius: 999px;
		padding: 2px;
		margin-right: 2px;
	}
	.match a {
		padding: 2px 10px;
		border-radius: 999px;
		font-size: 0.74rem;
		color: var(--text-faint);
	}
	.match a.on {
		color: #ddd6fe;
		background: var(--accent-soft);
	}
	.keep {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 10px;
	}
	.keep form {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.keep form:first-child {
		flex: 1 1 280px;
	}
	.keep form:first-child input {
		flex: 1;
		min-width: 0;
	}

	/* ── What it resolves to ─────────────────────────────────────────────── */
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
	.why {
		white-space: nowrap;
	}
	.why:hover {
		color: var(--text-muted);
		border-color: var(--hairline-strong);
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
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}

	@media (pointer: coarse) {
		.chip .pick {
			padding: 7px 4px 7px 14px;
		}
		.chip .go {
			opacity: 1;
			padding: 0 12px 0 6px;
		}
	}
	@media (max-width: 640px) {
		.coverage {
			flex: 1 1 100%;
		}
		.controls input[type='search'] {
			flex: 1 1 100%;
		}
		/* Pinned, the set has to stay a strip: the numbers that matter are the
		   count and the match mode, and the rest can wrap out of the way. */
		.sums {
			font-size: 0.78rem;
		}
		.why {
			display: none;
		}
	}
</style>
