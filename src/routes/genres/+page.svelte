<script lang="ts">
	import { page } from '$app/state';
	import ArtistLinks from '$lib/components/ArtistLinks.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import FilterBar from '$lib/components/FilterBar.svelte';
	import Pager from '$lib/components/Pager.svelte';
	import SearchBox from '$lib/components/SearchBox.svelte';
	import SortTh from '$lib/components/SortTh.svelte';
	import SpotifyLink from '$lib/components/SpotifyLink.svelte';
	import { GENRE_FILTERS } from '$lib/filters.ts';
	import { longDuration, num, shortDate, trackTime } from '$lib/utils/format.ts';
	import { toggleParam, trackHref, withParams } from '$lib/utils/qs.ts';

	let { data } = $props();

	/** What Spotify's own paste swallows in one go without complaining. */
	const BATCH = 100;
	/** Genres shown before the list asks to be expanded. */
	const VISIBLE_GENRES = 60;

	const genreHref = (genre: string) => toggleParam(page.url, 'g', genre);
	const clearHref = $derived(withParams(page.url, { g: null, page: null }));
	const linksHref = $derived(`/genres/links${page.url.search}`);

	// ---------------------------------------------------------- genre picker

	let filter = $state('');
	let expanded = $state(false);

	const matching = $derived(
		data.genres.filter((g) => g.genre.includes(filter.trim().toLowerCase()))
	);
	const shown = $derived(expanded || filter ? matching : matching.slice(0, VISIBLE_GENRES));
	const selectedOptions = $derived(
		data.selected.map((genre) => data.genres.find((g) => g.genre === genre) ?? { genre, tracks: 0 })
	);

	// -------------------------------------------------------- the selection

	/**
	 * Tracks struck off by hand, by Spotify id.
	 *
	 * SvelteKit reuses this component across pagination, sorting and search, so
	 * a removal made on page 1 still applies on page 4 — and the copy filters by
	 * id, which is what makes that safe. Changing the genres or the filters asks
	 * a different question, so the marks carry the selection they were made
	 * against and read as empty under any other.
	 */
	const selectionKey = $derived(
		[
			data.filters.src,
			data.filters.match,
			data.filters.explicit,
			data.filters.played,
			...data.selected
		].join('|')
	);
	let marks = $state<{ key: string; ids: Record<string, true> }>({ key: '', ids: {} });
	const dropped = $derived(marks.key === selectionKey ? marks.ids : {});
	const droppedCount = $derived(Object.keys(dropped).length);

	const restore = () => (marks = { key: selectionKey, ids: {} });

	function toggle(trackId: string): void {
		const ids = { ...dropped };
		if (ids[trackId]) delete ids[trackId];
		else ids[trackId] = true;
		marks = { key: selectionKey, ids };
	}

	const capped = $derived(Math.min(data.total, data.maxLinks));
	const copyable = $derived(Math.max(0, capped - droppedCount));
	const batches = $derived(
		copyable > BATCH
			? Array.from({ length: Math.ceil(copyable / BATCH) }, (_, i) => i * BATCH)
			: []
	);

	// ----------------------------------------------------------- the copying

	let cached = $state<{ key: string; links: string[] } | null>(null);
	let busy = $state(false);
	let status = $state('');
	let failed = $state(false);

	/** The id is the last path segment; the endpoint is the one place a link is built. */
	const idOf = (link: string) => link.slice(link.lastIndexOf('/') + 1);

	async function selectionLinks(): Promise<string[]> {
		const key = page.url.search;
		if (cached?.key === key) return cached.links;
		const res = await fetch(linksHref);
		if (!res.ok) throw new Error(`the server returned ${res.status}`);
		const links = (await res.text()).split('\n').filter(Boolean);
		cached = { key, links };
		return links;
	}

	async function copy(from = 0, count = Number.POSITIVE_INFINITY): Promise<void> {
		busy = true;
		failed = false;
		status = '';
		try {
			const links = (await selectionLinks()).filter((link) => !dropped[idOf(link)]);
			const slice = links.slice(from, Number.isFinite(count) ? from + count : undefined);
			if (slice.length === 0) {
				status = 'Nothing left to copy — every track in that batch was removed.';
				return;
			}
			await navigator.clipboard.writeText(slice.join('\n'));
			status = `${num(slice.length)} link${slice.length === 1 ? '' : 's'} copied. Paste into a Spotify playlist.`;
		} catch (err) {
			failed = true;
			status = `Could not copy — ${err instanceof Error ? err.message : String(err)}.`;
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Genres · Spotidata</title></svelte:head>

<header class="head">
	<div>
		<h1>Genres</h1>
		<p class="muted">
			{num(data.genres.length)} genres across your library. Pick as many as you like, strike off
			what does not belong, and copy the open.spotify.com links straight into a playlist.
		</p>
	</div>
	<SearchBox value={data.q} placeholder="Search these tracks" />
</header>

<section class="card picker">
	{#if data.selected.length}
		<div class="chosen">
			<span class="lbl">Selected</span>
			{#each selectedOptions as g (g.genre)}
				<a class="chip on" href={genreHref(g.genre)} title="Remove {g.genre}">
					{g.genre}
					<span class="x" aria-hidden="true">×</span>
				</a>
			{/each}
			<a class="clear" href={clearHref}>Clear genres</a>
		</div>
	{/if}

	<div class="find">
		<input
			type="search"
			bind:value={filter}
			placeholder="Filter genres…"
			aria-label="Filter the genre list"
		/>
		<span class="faint xs">
			{#if filter}{num(matching.length)} match “{filter}”{:else}most-used first{/if}
		</span>
	</div>

	<div class="chips">
		{#each shown as g (g.genre)}
			<a
				class="chip"
				class:on={data.selected.includes(g.genre)}
				href={genreHref(g.genre)}
				title="{g.tracks} recordings"
			>
				{g.genre}<span class="n faint">{num(g.tracks)}</span>
			</a>
		{:else}
			<span class="faint small">No genre matches “{filter}”.</span>
		{/each}
	</div>

	{#if !filter && matching.length > VISIBLE_GENRES}
		<button class="more" onclick={() => (expanded = !expanded)}>
			{expanded ? 'Show fewer' : `Show all ${num(matching.length)} genres`}
		</button>
	{/if}
</section>

<FilterBar groups={GENRE_FILTERS} active={data.filters} />

{#if data.selected.length === 0}
	<section class="card empty">
		<p>Pick a genre above to see its tracks.</p>
		<p class="faint small">
			Genres come from two catalogs that disagree: MusicBrainz tags the recording, Spotify tags the
			artist. “Tagged by” chooses between them — recording tags are more precise, artist genres
			cover more of the library.
		</p>
	</section>
{:else}
	<section class="card copy" class:bad={failed}>
		<div class="counts">
			<strong>{num(copyable)}</strong>
			<span class="muted small">
				link{copyable === 1 ? '' : 's'} ready
				{#if droppedCount}· <button class="link" onclick={restore}>
						{num(droppedCount)} removed — restore
					</button>{/if}
				{#if data.total > data.maxLinks}
					· <span class="warn">capped at {num(data.maxLinks)} of {num(data.total)}</span>
				{/if}
			</span>
		</div>

		<div class="actions">
			<button class="primary" onclick={() => copy()} disabled={busy || copyable === 0}>
				{busy ? 'Copying…' : `Copy ${num(copyable)} links`}
			</button>
			{#if batches.length}
				<span class="lbl">In {BATCH}s</span>
				{#each batches as start (start)}
					<button class="batch" onclick={() => copy(start, BATCH)} disabled={busy}>
						{num(start + 1)}–{num(Math.min(start + BATCH, copyable))}
					</button>
				{/each}
			{/if}
			<a class="plain" href={linksHref} target="_blank" rel="noreferrer">Plain text</a>
		</div>

		{#if status}
			<p class="status" class:bad={failed} aria-live="polite">{status}</p>
		{:else}
			<p class="status faint" aria-live="polite">
				Spotify takes a multi-line paste; batches of {BATCH} land reliably.
			</p>
		{/if}
	</section>

	<section class="card">
		<div class="scroll-x">
			<table>
				<thead>
					<tr>
						<th class="pick"><span class="sr">Include</span></th>
						<SortTh key="name" label="Recording" active={data.sort} dir={data.dir} initial="asc" />
						<SortTh key="artist" label="Artist" active={data.sort} dir={data.dir} initial="asc" />
						<th>Genres</th>
						<SortTh key="duration" label="Length" active={data.sort} dir={data.dir} right />
						<SortTh key="popularity" label="Pop." active={data.sort} dir={data.dir} right />
						<SortTh key="plays" label="Plays" active={data.sort} dir={data.dir} right />
						<SortTh key="added" label="First added" active={data.sort} dir={data.dir} right />
						<th class="r"><span class="sr">Spotify</span></th>
					</tr>
				</thead>
				<tbody>
					{#each data.rows as t (t.canonicalTrackId)}
						<tr class:off={dropped[t.trackId]}>
							<td class="pick">
								<input
									type="checkbox"
									checked={!dropped[t.trackId]}
									onchange={() => toggle(t.trackId)}
									aria-label="Include {t.title}"
								/>
							</td>
							<td>
								<div class="cell">
									<Cover src={t.cover} alt="{t.albumName ?? t.title} cover" size={34} />
									<div>
										<div class="title">
											<a href={trackHref(t.canonicalTrackId)}>{t.title}</a>
											{#if t.liked}<span class="heart" title="Liked">♥</span>{/if}
											{#if t.explicit}<span class="ex" title="Explicit">E</span>{/if}
										</div>
										<div class="faint xs">
											{#if t.albumId}<a href="/album/{t.albumId}">{t.albumName}</a>{:else}—{/if}
										</div>
									</div>
								</div>
							</td>
							<td class="muted small"><ArtistLinks artists={t.artists} /></td>
							<td class="tags">
								{#each t.genres.slice(0, 3) as g (g)}
									<a class="tag" class:on={data.selected.includes(g)} href={genreHref(g)}>{g}</a>
								{/each}
								{#if t.genres.length > 3}
									<span class="faint xs" title={t.genres.join(', ')}>+{t.genres.length - 3}</span>
								{/if}
							</td>
							<td class="r num muted">{trackTime(t.durationMs)}</td>
							<td class="r num">{t.popularity ?? '—'}</td>
							<td
								class="r num"
								class:faint={t.plays === 0}
								title={t.plays > 0 ? `${longDuration(t.msPlayed)} listened` : 'Never played'}
							>
								{t.plays || '—'}
							</td>
							<td class="r muted small nowrap" title={t.firstAddedAt}>{shortDate(t.firstAddedAt)}</td>
							<td class="r">
								<SpotifyLink
									kind="track"
									id={t.trackId}
									compact
									label="Open {t.title} in Spotify"
								/>
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="9" class="none faint">
								Nothing in {data.selected.length === 1 ? 'that genre' : 'those genres'} matches the
								current filters.
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<Pager
			page={data.page}
			pages={data.pages}
			total={data.total}
			pageSize={data.pageSize}
			unit="recordings"
		/>
	</section>
{/if}

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
		max-width: 62ch;
	}
	.card {
		padding: var(--card-py) var(--card-px);
	}

	/* ── the picker ─────────────────────────────────────────────────────── */
	.picker {
		margin-bottom: var(--gap);
	}
	.chosen {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		padding-bottom: 12px;
		margin-bottom: 12px;
		border-bottom: 1px solid var(--hairline);
	}
	.lbl {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-faint);
		margin-right: 2px;
	}
	.find {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 12px;
	}
	.find input {
		flex: 0 1 260px;
		min-width: 0;
		padding: 6px 12px;
		border-radius: 999px;
		border: 1px solid var(--hairline-strong);
		background: var(--bg-elevated);
		color: var(--text);
		font-size: 0.84rem;
		font-family: inherit;
		outline: none;
	}
	.find input:focus {
		border-color: rgba(124, 58, 237, 0.6);
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		/* Deep into the tail the list is long; it scrolls rather than pushing the
		   tracks off the screen. */
		max-height: 320px;
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
	.chip .x {
		font-size: 0.9rem;
		line-height: 1;
	}
	.more {
		margin-top: 12px;
		padding: 4px 12px;
		border-radius: 999px;
		border: 1px solid var(--hairline-strong);
		background: var(--bg-elevated);
		color: var(--text-muted);
		font-size: 0.78rem;
		font-family: inherit;
		cursor: pointer;
	}
	.more:hover {
		color: var(--text);
	}
	.clear,
	.link {
		font-size: 0.76rem;
		color: var(--text-faint);
		text-decoration: underline;
		background: none;
		border: 0;
		padding: 0;
		font-family: inherit;
		cursor: pointer;
	}
	.clear:hover,
	.link:hover {
		color: var(--text);
	}

	/* ── the copy bar ───────────────────────────────────────────────────── */
	.copy {
		position: sticky;
		top: 8px;
		z-index: 5;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px 18px;
		margin-bottom: var(--gap);
		background: color-mix(in srgb, var(--bg-elevated) 92%, transparent);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		border-color: rgba(124, 58, 237, 0.35);
	}
	.copy.bad {
		border-color: rgba(244, 63, 94, 0.4);
	}
	.counts strong {
		font-size: 1.1rem;
		font-variant-numeric: tabular-nums;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}
	.primary,
	.batch {
		border-radius: 999px;
		border: 1px solid var(--hairline-strong);
		background: var(--bg-elevated);
		color: var(--text-muted);
		font-family: inherit;
		cursor: pointer;
	}
	.primary {
		padding: 8px 16px;
		font-size: 0.86rem;
		color: #ddd6fe;
		background: var(--accent-soft);
		border-color: rgba(124, 58, 237, 0.45);
	}
	.primary:hover:not(:disabled) {
		border-color: rgba(124, 58, 237, 0.9);
	}
	.batch {
		padding: 4px 10px;
		font-size: 0.74rem;
		font-variant-numeric: tabular-nums;
	}
	.batch:hover:not(:disabled) {
		color: var(--text);
	}
	.primary:disabled,
	.batch:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.plain {
		font-size: 0.76rem;
		color: var(--text-faint);
		text-decoration: underline;
	}
	.plain:hover {
		color: var(--text);
	}
	.status {
		flex: 1 0 100%;
		margin: 0;
		font-size: 0.78rem;
		color: var(--good);
	}
	.status.bad {
		color: var(--bad);
	}
	.status.faint {
		color: var(--text-faint);
	}
	.warn {
		color: var(--warn);
	}

	/* ── the tracks ─────────────────────────────────────────────────────── */
	.empty {
		text-align: center;
		padding: 34px var(--card-px);
	}
	.empty p {
		margin: 0 auto;
		max-width: 60ch;
	}
	.empty p + p {
		margin-top: 8px;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
		min-width: 880px;
	}
	th {
		text-align: left;
		font-weight: 500;
		color: var(--text-muted);
		font-size: 0.76rem;
		padding-bottom: 8px;
		border-bottom: 1px solid var(--hairline);
		white-space: nowrap;
	}
	td {
		padding: 7px 10px 7px 0;
		border-bottom: 1px solid rgba(255, 255, 255, 0.03);
	}
	th.r,
	td.r {
		text-align: right;
	}
	th:last-child,
	td:last-child {
		padding-right: 0;
	}
	th.pick,
	td.pick {
		width: 34px;
		padding-right: 10px;
	}
	td.pick input {
		accent-color: var(--accent-2);
		width: 16px;
		height: 16px;
		cursor: pointer;
	}
	/* Struck-off rows stay in place — you are working through a list, and a row
	   that vanished would take its own undo with it. */
	tr.off td:not(.pick) {
		opacity: 0.34;
	}
	.cell {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.title {
		line-height: 1.3;
	}
	.small {
		font-size: 0.82rem;
	}
	.xs {
		font-size: 0.73rem;
	}
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		max-width: 260px;
	}
	.tag {
		padding: 1px 8px;
		border-radius: 999px;
		border: 1px solid var(--hairline);
		font-size: 0.7rem;
		color: var(--text-faint);
		white-space: nowrap;
	}
	.tag:hover {
		color: var(--text);
		border-color: var(--hairline-strong);
	}
	.tag.on {
		color: #ddd6fe;
		background: var(--accent-soft);
		border-color: rgba(124, 58, 237, 0.4);
	}
	.heart {
		color: var(--accent-2);
		font-size: 0.78rem;
		margin-left: 4px;
	}
	.ex {
		display: inline-block;
		margin-left: 5px;
		font-size: 0.62rem;
		padding: 0 4px;
		border-radius: 3px;
		background: rgba(255, 255, 255, 0.08);
		color: var(--text-faint);
		vertical-align: middle;
	}
	.none {
		padding: 28px 0;
		text-align: center;
	}
	.nowrap {
		white-space: nowrap;
	}
	a:hover {
		text-decoration: underline;
	}
	/* See the note in /library: absolute positioning would escape the scroll lane. */
	.sr {
		display: inline-block;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	@media (pointer: coarse) {
		.chip {
			padding: 8px 14px;
			font-size: 0.82rem;
		}
		td.pick input {
			width: 20px;
			height: 20px;
		}
	}
	@media (max-width: 640px) {
		.find input {
			flex: 1 1 auto;
		}
		.copy {
			/* Under the sticky phone nav rather than under the viewport edge. */
			top: 96px;
		}
	}
</style>
