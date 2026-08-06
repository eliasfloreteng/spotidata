<script lang="ts">
	import { enhance } from '$app/forms';
	import { page as pageState } from '$app/state';
	import ArtistLinks from '$lib/components/ArtistLinks.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import Pager from '$lib/components/Pager.svelte';
	import SearchBox from '$lib/components/SearchBox.svelte';
	import SpotifyLink from '$lib/components/SpotifyLink.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import { CATEGORICAL } from '$lib/charts/index.ts';
	import { longDuration, num, pct, relativeTime, shortDate, trackTime } from '$lib/utils/format.ts';
	import { genreHref, trackHref, withParams } from '$lib/utils/qs.ts';

	let { data, form } = $props();

	const g = $derived(data.summary);
	const share = $derived(g.tracks / Math.max(1, data.libraryTracks));

	/**
	 * A subset of the collection sort keys. All eight are accepted from the URL —
	 * a collection can be ordered by any of them — but a genre is browsed, and
	 * eight chips is a control panel rather than a reading order.
	 */
	const SORTS = [
		{ key: 'plays', label: 'Most played' },
		{ key: 'listened', label: 'Most listened' },
		{ key: 'added', label: 'Recently added' },
		{ key: 'released', label: 'Newest' },
		{ key: 'title', label: 'Title' }
	] as const;
	const sortHref = (key: string) => withParams(pageState.url, { sort: key, page: null });

	const stage = (...genres: string[]) =>
		`/genres?${genres.map((x) => `g=${encodeURIComponent(x)}`).join('&')}`;
</script>

<svelte:head><title>{data.genre} · Genres · Spotidata</title></svelte:head>

<header class="head">
	<div>
		<p class="crumb"><a href="/genres">Genres</a> /</p>
		<h1>{data.genre}</h1>
		<p class="muted small">
			{#if g.tracks}
				{num(g.tracks)} recordings in your library · {pct(share, 1)} of it
				{#if g.catalogTracks > g.tracks}
					· {num(g.catalogTracks - g.tracks)} more in the ingested catalog
				{/if}
			{:else}
				none of yours · {num(g.catalogTracks)} recordings in the ingested catalog
			{/if}
			{#if g.topVotes > 1}· best-voted use has {g.topVotes} MusicBrainz votes{/if}
		</p>
	</div>

	<!-- A genre nothing of yours carries would build an empty playlist, so it
	     offers no way to build one. -->
	{#if g.tracks > 0}
		<div class="actions">
			<a class="ghost" href={stage(data.genre)}>Build a set from it</a>
			{#if data.collections.length}
				<form method="POST" action="?/add" use:enhance>
					<label class="sr" for="add-to">Add to collection</label>
					<select id="add-to" name="collection">
						{#each data.collections as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
					</select>
					<button class="ghost" type="submit">Add</button>
				</form>
			{/if}
			<form method="POST" action="?/create" use:enhance>
				<input type="hidden" name="name" value={data.genre} />
				<button class="primary" type="submit">New collection</button>
			</form>
		</div>
	{/if}
</header>

{#if form?.error}<div class="notice bad">{form.error}</div>{/if}

{#if g.tracks === 0}
	<section class="card empty">
		<p>
			Nothing in your library is tagged <strong>{data.genre}</strong> yet.
			{#if g.catalogTracks}
				{num(g.catalogTracks)} recordings elsewhere in the ingested catalog carry it — mostly other
				people's playlists.
			{/if}
		</p>
		<p class="faint small">
			Recording tags arrive with the crawl, so a genre can fill in later. <a href="/enrich"
				>Enrichment</a
			> is what raises coverage.
		</p>
	</section>
{:else}
	<section class="tiles">
		<StatTile
			label="Recordings"
			value={num(g.tracks)}
			sub="{num(g.liked)} liked · {pct(share, 1)} of your library"
			accent={CATEGORICAL[0]}
		/>
		<StatTile
			label="Runtime"
			value={longDuration(g.durationMs)}
			sub="one pass through"
			accent={CATEGORICAL[1]}
		/>
		<StatTile
			label="You have played"
			value={g.plays > 0 ? longDuration(g.msPlayed) : '—'}
			sub={g.plays > 0 ? `${num(g.plays)} plays` : 'never'}
			accent={CATEGORICAL[2]}
		/>
		<StatTile
			label="Artists"
			value={num(g.artists)}
			sub="{num(g.albums)} albums represented"
			accent={CATEGORICAL[3]}
		/>
		<StatTile
			label="Last played"
			value={g.lastPlayedAt ? relativeTime(g.lastPlayedAt) : '—'}
			sub={g.firstAddedAt ? `first added ${shortDate(g.firstAddedAt)}` : 'not in your library'}
			accent={CATEGORICAL[4]}
		/>
	</section>

	{#if data.related.length}
		<section class="card">
			<div class="section-head">
				<h2>Sounds like the same records</h2>
				<p class="faint xs">
					Genres tagged on the same recordings, ranked by how much of each set is the other — not by
					raw overlap, which would answer “pop” every time.
				</p>
			</div>
			<div class="chips">
				{#each data.related as r (r.genre)}
					<span class="chip" style="--w:{r.overlap}">
						<a
							class="pick"
							href={genreHref(r.genre)}
							title="{num(r.shared)} of your {num(g.tracks)} {data.genre} recordings are also {r.genre} ({num(r.tracks)} in total)"
						>
							{r.genre}<span class="n faint num">{pct(r.overlap)}</span>
						</a>
						<a
							class="go"
							href={stage(data.genre, r.genre)}
							aria-label="Stage {data.genre} and {r.genre} together"
							title="Stage both in the explorer"
						>
							+
						</a>
					</span>
				{/each}
			</div>
		</section>
	{/if}

	{#if data.artists.length}
		<section class="card">
			<div class="section-head">
				<h2>Who it is, for you</h2>
				<p class="faint xs">By recordings you own, credited as the primary artist.</p>
			</div>
			<div class="people">
				{#each data.artists as a (a.id)}
					<a class="person" href="/artist/{a.id}">
						<Cover src={a.image} alt="{a.name} photo" size={52} round />
						<span class="name">{a.name}</span>
						<span class="faint xs">
							{num(a.tracks)} recordings
							{#if a.plays > 0}· {num(a.plays)} plays{/if}
						</span>
					</a>
				{/each}
			</div>
		</section>
	{/if}

	<section class="card">
		<div class="section-head">
			<div class="sorts">
				{#each SORTS as s (s.key)}
					<a class="sort" class:on={data.sort === s.key} href={sortHref(s.key)}>{s.label}</a>
				{/each}
			</div>
			<SearchBox value={data.q} placeholder="Search these recordings" />
		</div>

		<div class="scroll-x">
			<table>
				<thead>
					<tr>
						<th class="idx">#</th>
						<th>Recording</th>
						<th>Artist</th>
						<th>Also tagged</th>
						<th class="r">Length</th>
						<th class="r">Plays</th>
						<th class="r">First added</th>
						<th class="r"><span class="sr">Spotify</span></th>
					</tr>
				</thead>
				<tbody>
					{#each data.rows as t (t.canonicalTrackId)}
						<tr>
							<td class="idx num faint">{num(t.rank)}</td>
							<td>
								<div class="cell">
									<Cover src={t.cover} alt="{t.albumName ?? t.title} cover" size={34} />
									<div>
										<div class="title">
											<a href={trackHref(t.canonicalTrackId)}>{t.title}</a>
											{#if t.liked}<span class="heart" title="Liked">♥</span>{/if}
										</div>
										<div class="faint xs">
											{#if t.albumId}<a href="/album/{t.albumId}">{t.albumName}</a>{:else}—{/if}
										</div>
									</div>
								</div>
							</td>
							<td class="muted small"><ArtistLinks artists={t.artists} /></td>
							<td class="tags">
								{#each t.genres.filter((x) => x !== data.genre).slice(0, 2) as other (other)}
									<a class="tag" href={genreHref(other)}>{other}</a>
								{/each}
							</td>
							<td class="r num muted">{trackTime(t.durationMs)}</td>
							<td
								class="r num"
								class:faint={t.plays === 0}
								title={t.plays > 0 ? `${longDuration(t.msPlayed)} listened` : 'Never played'}
							>
								{t.plays || '—'}
							</td>
							<td class="r muted small nowrap">{shortDate(t.firstAddedAt)}</td>
							<td class="r">
								<SpotifyLink kind="track" id={t.trackId} compact label="Open {t.title} in Spotify" />
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="8" class="none faint">Nothing here matches “{data.q}”.</td>
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
		align-items: flex-end;
		gap: 16px;
		margin-bottom: var(--gap);
		flex-wrap: wrap;
	}
	.crumb {
		margin: 0;
		font-size: 0.76rem;
		color: var(--text-faint);
	}
	.crumb a:hover {
		color: var(--text);
	}
	h1 {
		margin: 2px 0 0;
		font-size: 1.6rem;
		letter-spacing: -0.02em;
	}
	.head p.small {
		margin: 4px 0 0;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.actions form {
		display: flex;
		gap: 6px;
		align-items: center;
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
		margin-bottom: var(--gap);
	}
	.empty p {
		margin: 0 0 6px;
		font-size: 0.9rem;
	}
	.empty a {
		text-decoration: underline;
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(168px, 1fr));
		gap: 12px;
		margin-bottom: var(--gap);
	}
	.section-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
		margin-bottom: 12px;
	}
	.section-head p {
		margin: 0;
		max-width: 58ch;
	}
	h2 {
		font-size: 1rem;
		margin: 0;
	}

	/* Same two-destination pill as the explorer: the label walks to that genre,
	   the + stages both here together. */
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.chip {
		display: inline-flex;
		align-items: stretch;
		border-radius: 999px;
		border: 1px solid
			color-mix(in srgb, var(--accent) calc(var(--w) * 130%), var(--hairline-strong));
		background: var(--bg-elevated);
		font-size: 0.78rem;
		line-height: 1.6;
		white-space: nowrap;
	}
	.chip .pick {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 3px 4px 3px 11px;
		color: var(--text-muted);
	}
	.chip:hover .pick {
		color: var(--text);
	}
	.chip .go {
		display: inline-flex;
		align-items: center;
		padding: 0 10px 0 5px;
		color: var(--text-faint);
		border-radius: 0 999px 999px 0;
	}
	.chip .go:hover {
		color: #ddd6fe;
		background: var(--accent-soft);
	}
	.chip .n {
		font-size: 0.7rem;
	}

	.people {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(126px, 1fr));
		gap: 10px;
	}
	.person {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: 4px;
		padding: 10px 6px;
		border-radius: var(--radius-sm);
		border: 1px solid transparent;
	}
	.person:hover {
		background: var(--card-hover);
		border-color: var(--hairline);
	}
	.person .name {
		font-size: 0.84rem;
		line-height: 1.25;
	}

	.sorts {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.sort {
		padding: 3px 10px;
		border-radius: 999px;
		border: 1px solid var(--hairline-strong);
		background: var(--bg-elevated);
		color: var(--text-muted);
		font-size: 0.76rem;
		white-space: nowrap;
	}
	.sort:hover {
		color: var(--text);
	}
	.sort.on {
		color: #ddd6fe;
		background: var(--accent-soft);
		border-color: rgba(124, 58, 237, 0.4);
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.86rem;
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
	th.r,
	td.r {
		text-align: right;
	}
	td {
		padding: 6px 10px 6px 0;
		border-bottom: 1px solid rgba(255, 255, 255, 0.03);
		vertical-align: middle;
	}
	td:last-child,
	th:last-child {
		padding-right: 0;
	}
	.idx {
		width: 34px;
	}
	.cell {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 210px;
	}
	.title a:hover {
		text-decoration: underline;
	}
	.heart {
		color: var(--accent-2);
		font-size: 0.8rem;
		margin-left: 5px;
	}
	.tags {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
		max-width: 230px;
	}
	.tag {
		padding: 1px 8px;
		border-radius: 999px;
		border: 1px solid var(--hairline);
		font-size: 0.7rem;
		color: var(--text-faint);
	}
	.tag:hover {
		color: var(--text-muted);
		border-color: var(--hairline-strong);
	}
	.none {
		padding: 18px 0;
		text-align: center;
	}
	.ghost,
	.primary {
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
	select {
		padding: 7px 12px;
		border-radius: 999px;
		border: 1px solid var(--hairline-strong);
		background: var(--bg-elevated);
		color: var(--text);
		font-size: 0.84rem;
		font-family: inherit;
		outline: none;
		max-width: 190px;
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

	@media (max-width: 640px) {
		.tags {
			display: none;
		}
	}
</style>
