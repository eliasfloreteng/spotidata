<script lang="ts">
	import Chip from '$lib/components/Chip.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import FilterBar from '$lib/components/FilterBar.svelte';
	import Pager from '$lib/components/Pager.svelte';
	import SearchBox from '$lib/components/SearchBox.svelte';
	import SortTh from '$lib/components/SortTh.svelte';
	import SpotifyLink from '$lib/components/SpotifyLink.svelte';
	import { ALBUM_FILTERS } from '$lib/filters.ts';
	import { longDuration, num } from '$lib/utils/format.ts';

	let { data } = $props();

	/** The table's own sorts, for a phone, where the rows have no header to click. */
	const SORTS = [
		{ key: 'tracks', label: 'Yours' },
		{ key: 'listened', label: 'Listened' },
		{ key: 'released', label: 'Released' },
		{ key: 'coverage', label: 'Coverage' },
		{ key: 'popularity', label: 'Popularity' },
		{ key: 'name', label: 'Name', initial: 'asc' as const },
		{ key: 'artist', label: 'Artist', initial: 'asc' as const }
	];
</script>

<svelte:head><title>Albums · Spotidata</title></svelte:head>

<header class="head">
	<div>
		<h1>Albums</h1>
		<p class="muted">
			{num(data.total)} albums{#if data.q} matching “{data.q}”{/if} — every album with at least
			one track in your library.
		</p>
	</div>
	<SearchBox value={data.q} placeholder="Search albums or artists" />
</header>

<FilterBar
	groups={ALBUM_FILTERS}
	active={data.filters}
	sorts={SORTS}
	sortsNarrowOnly
	sort={data.sort}
	dir={data.dir}
/>

<section class="card">
	<div class="scroll-x">
		<table class="cards">
			<thead>
				<tr>
					<th class="idx wide-only">#</th>
					<SortTh key="name" label="Album" active={data.sort} dir={data.dir} initial="asc" />
					<SortTh
						key="artist"
						label="Artist"
						active={data.sort}
						dir={data.dir}
						initial="asc"
						class="wide-only"
					/>
					<th class="wide-only">Type</th>
					<SortTh key="released" label="Released" active={data.sort} dir={data.dir} right />
					<SortTh key="tracks" label="Yours" active={data.sort} dir={data.dir} right />
					<SortTh key="coverage" label="Coverage" active={data.sort} dir={data.dir} class="wide-only" />
					<SortTh key="popularity" label="Pop." active={data.sort} dir={data.dir} right />
					<SortTh key="listened" label="Listened" active={data.sort} dir={data.dir} right />
					<th class="r"><span class="sr">Spotify</span></th>
				</tr>
			</thead>
			<tbody>
				{#each data.rows as a, i (a.id)}
					{@const share = a.totalTracks ? Math.min(1, a.tracks / a.totalTracks) : 0}
					<tr>
						<td class="idx num faint wide-only">{(data.page - 1) * data.pageSize + i + 1}</td>
						<td class="lead">
							<a class="cell" href="/album/{a.id}">
								<Cover src={a.cover} alt="{a.name} cover" size={40} />
								<span class="lines">
									<span class="name">{a.name}</span>
									<span class="narrow-only muted small clip">{a.artist ?? '—'}</span>
									<span class="narrow-only faint small clip">
										{a.albumType ?? 'album'}{#if a.saved}<span class="saved"> · saved</span>{/if}
									</span>
								</span>
							</a>
						</td>
						<td class="muted small wide-only">
							{#if a.artistId}<a href="/artist/{a.artistId}">{a.artist}</a>{:else}—{/if}
						</td>
						<td class="wide-only">
							{#if a.saved}
								<Chip tone="good" title="Saved to your albums">{a.albumType ?? 'album'}</Chip>
							{:else}
								<span class="faint small">{a.albumType ?? '—'}</span>
							{/if}
						</td>
						<td
							class="r num muted small nowrap"
							data-label="Released"
							class:on={data.sort === 'released'}
						>
							{a.releaseDate ?? '—'}
						</td>
						<td
							class="r num"
							data-label="Yours"
							class:on={data.sort === 'tracks' || data.sort === 'coverage'}
							title="{Math.round(share * 100)}% of the album"
						>
							{a.tracks}<span class="faint">/{num(a.totalTracks)}</span>
						</td>
						<td class="cov wide-only">
							<span class="bar" aria-label="{Math.round(share * 100)}% of the album">
								<span class="fill" style="width:{share * 100}%"></span>
							</span>
						</td>
						<td class="r num" data-label="Pop." class:on={data.sort === 'popularity'}>
							{a.popularity ?? '—'}
						</td>
						<td
							class="r num small nowrap"
							data-label="Listened"
							class:on={data.sort === 'listened'}
							class:faint={a.plays === 0}
							title={a.plays > 0 ? `${num(a.plays)} plays` : 'Never played'}
						>
							{a.plays > 0 ? longDuration(a.msPlayed) : '—'}
						</td>
						<td class="r corner"><SpotifyLink kind="album" id={a.id} compact label="Open {a.name} in Spotify" /></td>
					</tr>
				{:else}
					<tr><td colspan="10" class="empty faint">No albums match that search.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
	<Pager page={data.page} pages={data.pages} total={data.total} pageSize={data.pageSize} unit="albums" />
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
		padding: var(--card-py) var(--card-px);
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
		/* Under this the columns crush each other; the lane scrolls instead. */
		min-width: 800px;
	}
	th {
		text-align: left;
		font-weight: 500;
		color: var(--text-muted);
		font-size: 0.76rem;
		padding-bottom: 8px;
		border-bottom: 1px solid var(--hairline);
		white-space: nowrap;
		/* The cells' own gutter, so a right-aligned header sits over its numbers. */
		padding-right: 10px;
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
	.cell {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.cell:hover .name {
		color: #fff;
	}
	.name {
		line-height: 1.3;
	}
	.lines {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.small {
		font-size: 0.82rem;
	}
	td.cov {
		padding-left: 14px;
	}
	.bar {
		display: block;
		width: 90px;
		height: 6px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.05);
		overflow: hidden;
	}
	.fill {
		display: block;
		height: 100%;
		background: linear-gradient(90deg, var(--accent), var(--accent-2));
	}
	.empty {
		padding: 28px 0;
		text-align: center;
	}
	/* Absolute positioning would escape the table's scroll lane — with no
	   positioned ancestor its containing block is the viewport, so a label
	   parked 800px along the header drags the whole document that wide. In
	   flow at 1px it cannot. */
	.sr {
		display: inline-block;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	td a:hover {
		text-decoration: underline;
	}
	th.idx,
	td.idx {
		text-align: right;
		padding-right: 12px;
		width: 46px;
	}
	.nowrap {
		white-space: nowrap;
	}
	/* Phone: the album and how long it was played; the rest is folded under the
	   title and the other sorts are chips above the table. */
	.lines {
		min-width: 0;
	}
	.clip {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.saved {
		color: var(--good);
	}
	/* Phone: a row card (app.css › Rows as cards). Coverage is the Yours
	   fraction already, so its bar stays on the wide screen. */
	@media (max-width: 640px) {
		table {
			--card-cols: minmax(0, 1.3fr) minmax(0, 0.9fr) minmax(0, 0.7fr) minmax(0, 1.6fr);
		}
		.cell {
			align-items: flex-start;
		}
		.cell :global(img),
		.cell :global(.placeholder) {
			width: 48px !important;
			height: 48px !important;
		}
		.name {
			font-size: 0.95rem;
		}
	}
</style>
