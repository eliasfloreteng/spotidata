<script lang="ts">
	import { page } from '$app/state';
	import ArtistLinks from '$lib/components/ArtistLinks.svelte';
	import Chip from '$lib/components/Chip.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import FilterBar from '$lib/components/FilterBar.svelte';
	import Pager from '$lib/components/Pager.svelte';
	import SearchBox from '$lib/components/SearchBox.svelte';
	import SortTh from '$lib/components/SortTh.svelte';
	import SpotifyLink from '$lib/components/SpotifyLink.svelte';
	import { LIBRARY_FILTERS } from '$lib/filters.ts';
	import { longDuration, num, shortDate, trackTime } from '$lib/utils/format.ts';
	import { trackHref, withParams } from '$lib/utils/qs.ts';

	let { data } = $props();

	const c = $derived(data.composition);

	/** The table's own sorts, for a phone, where the rows have no header to click. */
	const SORTS = [
		{ key: 'added', label: 'First added' },
		{ key: 'plays', label: 'Plays' },
		{ key: 'popularity', label: 'Popularity' },
		{ key: 'copies', label: 'Copies' },
		{ key: 'duration', label: 'Length' },
		{ key: 'name', label: 'Name', initial: 'asc' as const },
		{ key: 'artist', label: 'Artist', initial: 'asc' as const }
	];

	/** The list with just this filter: the other filters and the search reset. */
	const only = (params: Record<string, string>) =>
		withParams(page.url, {
			...Object.fromEntries(LIBRARY_FILTERS.map((g) => [g.param, null])),
			q: null,
			page: null,
			...params
		});
</script>

<svelte:head><title>Library · Spotidata</title></svelte:head>

<header class="head">
	<div>
		<h1>Library</h1>
		<!-- What the library is made of, each part a way into it: liked songs are
		     the first link rather than a page of their own. -->
		<p class="muted">
			{num(c.recordings)} recordings:
			<a href={only({ source: 'liked' })}>{num(c.liked)} liked</a>,
			<a href={only({ source: 'playlist-only' })}>{num(c.playlistOnly)} only in your playlists</a>.
			{num(c.trackIds - c.recordings)} more Spotify tracks are the same recordings again, folded in
			by ISRC.
		</p>

	</div>
	<SearchBox value={data.q} placeholder="Search recordings" />
</header>

<FilterBar
	groups={LIBRARY_FILTERS}
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
					<SortTh key="name" label="Recording" active={data.sort} dir={data.dir} initial="asc" />
					<SortTh
						key="artist"
						label="Artist"
						active={data.sort}
						dir={data.dir}
						initial="asc"
						class="wide-only"
					/>
					<th class="wide-only">Album</th>
					<SortTh key="copies" label="Copies" active={data.sort} dir={data.dir} right />
					<SortTh key="duration" label="Length" active={data.sort} dir={data.dir} right />
					<SortTh key="popularity" label="Pop." active={data.sort} dir={data.dir} right />
					<SortTh key="plays" label="Plays" active={data.sort} dir={data.dir} right />
					<SortTh
						key="added"
						label="First added"
						active={data.sort}
						dir={data.dir}
						right
					/>
					<th class="r"><span class="sr">Spotify</span></th>
				</tr>
			</thead>
			<tbody>
				{#each data.rows as t, i (t.canonicalTrackId)}
					<tr>
						<td class="idx num faint wide-only">{(data.page - 1) * data.pageSize + i + 1}</td>
						<td class="lead">
							<div class="cell">
								<Cover src={t.cover} alt="{t.albumName ?? t.title} cover" size={34} />
								<div class="lines">
									<div class="title">
										<a href={trackHref(t.canonicalTrackId)}>{t.title}</a>
										{#if t.liked}<span class="heart" title="Liked">♥</span>{/if}
										{#if t.explicit}<span class="ex" title="Explicit">E</span>{/if}
									</div>
									<!-- A phone has no artist or album column: they are lines of
									     their own, each cut short rather than wrapped. -->
									<div class="narrow-only muted xs clip"><ArtistLinks artists={t.artists} /></div>
									<div class="faint xs clip">
										<span class="narrow-only">
											{#if t.albumId}<a href="/album/{t.albumId}">{t.albumName}</a> ·{/if}
										</span>
										{#if t.kind === 'fallback'}
											<span title="No ISRC — grouped by heuristic">heuristic group</span> ·
										{/if}
										{t.ownedPlaylistCount > 0
											? `${t.ownedPlaylistCount} owned playlist${t.ownedPlaylistCount === 1 ? '' : 's'}`
											: 'liked only'}
									</div>
								</div>
							</div>
						</td>
						<td class="muted small wide-only">
							<ArtistLinks artists={t.artists} />
						</td>
						<td class="muted small wide-only">
							{#if t.albumId}<a href="/album/{t.albumId}">{t.albumName}</a>{:else}—{/if}
						</td>
						<td class="r" data-label="Copies" class:on={data.sort === 'copies'}>
							{#if t.copyCount > 1}
								<Chip tone="accent" title="{t.copyCountInLibrary} of them in your library">
									{t.copyCount}
								</Chip>
							{:else}
								<span class="faint num">1</span>
							{/if}
						</td>
						<td class="r num muted" data-label="Length" class:on={data.sort === 'duration'}>
							{trackTime(t.durationMs)}
						</td>
						<td class="r num" data-label="Pop." class:on={data.sort === 'popularity'}>
							{t.popularity ?? '—'}
						</td>
						<td
							class="r num"
							data-label="Plays"
							class:on={data.sort === 'plays'}
							class:faint={t.plays === 0}
							title={t.plays > 0
								? `${longDuration(t.msPlayed)} listened, last ${shortDate(t.lastPlayedAt)}`
								: 'Never played, or before your imported history begins'}
						>
							{t.plays || '—'}
						</td>
						<td
							class="r muted small nowrap"
							data-label="First added"
							class:on={data.sort === 'added'}
							title={t.firstAddedAt}
						>
							{shortDate(t.firstAddedAt)}
						</td>
						<td class="r corner">
							<SpotifyLink
								kind="track"
								id={t.representativeTrackId}
								compact
								label="Open {t.title} in Spotify"
							/>
						</td>
					</tr>
				{:else}
					<tr><td colspan="10" class="empty faint">No recordings match that search.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
	<Pager page={data.page} pages={data.pages} total={data.total} pageSize={data.pageSize} unit="recordings" />
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
		max-width: 62ch;
	}
	.head p a {
		color: var(--text);
		text-decoration: underline;
		text-decoration-color: var(--hairline-strong);
		text-underline-offset: 3px;
	}
	.card {
		padding: var(--card-py) var(--card-px);
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
		/* Under this the columns crush each other; the lane scrolls instead. */
		min-width: 840px;
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
	.title {
		line-height: 1.3;
	}
	.small {
		font-size: 0.82rem;
	}
	.xs {
		font-size: 0.73rem;
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
	a:hover {
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
	.lines {
		min-width: 0;
	}
	.clip {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* Phone: each recording is a row card (app.css › Rows as cards) — the
	   title, its artists and album, then the five numbers in one aligned row,
	   the date given the room a date needs. */
	@media (max-width: 640px) {
		table {
			--card-cols: repeat(4, minmax(0, 1fr)) minmax(0, 1.7fr);
		}
		.cell {
			align-items: flex-start;
		}
		.cell :global(img),
		.cell :global(.placeholder) {
			width: 48px !important;
			height: 48px !important;
		}
		.title {
			font-size: 0.95rem;
		}
		.xs {
			font-size: 0.78rem;
		}
	}
</style>
