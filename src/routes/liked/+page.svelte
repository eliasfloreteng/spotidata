<script lang="ts">
	import ArtistLinks from '$lib/components/ArtistLinks.svelte';
	import Chip from '$lib/components/Chip.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import FilterBar from '$lib/components/FilterBar.svelte';
	import Pager from '$lib/components/Pager.svelte';
	import SearchBox from '$lib/components/SearchBox.svelte';
	import SortTh from '$lib/components/SortTh.svelte';
	import SpotifyLink from '$lib/components/SpotifyLink.svelte';
	import { LIKED_FILTERS } from '$lib/filters.ts';
	import { longDuration, num, shortDate, trackTime } from '$lib/utils/format.ts';
	import { trackHref } from '$lib/utils/qs.ts';

	let { data } = $props();
</script>

<svelte:head><title>Liked songs · Spotidata</title></svelte:head>

<header class="head">
	<div>
		<h1>Liked songs</h1>
		<p class="muted">
			{num(data.total)} saved tracks{#if data.q} matching “{data.q}”{/if} — every liked track id,
			duplicates and all.
		</p>
	</div>
	<SearchBox value={data.q} placeholder="Search liked songs" />
</header>

<FilterBar groups={LIKED_FILTERS} active={data.filters} />

<section class="card">
	<div class="scroll-x">
		<table>
			<thead>
				<tr>
					<th class="idx">#</th>
					<SortTh key="name" label="Track" active={data.sort} dir={data.dir} initial="asc" />
					<SortTh key="artist" label="Artist" active={data.sort} dir={data.dir} initial="asc" />
					<th>Album</th>
					<SortTh key="duration" label="Length" active={data.sort} dir={data.dir} right />
					<SortTh key="popularity" label="Pop." active={data.sort} dir={data.dir} right />
					<SortTh key="plays" label="Plays" active={data.sort} dir={data.dir} right />
					<SortTh key="added" label="Added" active={data.sort} dir={data.dir} right />
					<th class="r"><span class="sr">Spotify</span></th>
				</tr>
			</thead>
			<tbody>
				{#each data.rows as t, i (t.id)}
					<tr>
						<td class="idx num faint">{(data.page - 1) * data.pageSize + i + 1}</td>
						<td>
							<div class="cell">
								<Cover src={t.cover} alt="{t.albumName ?? t.name} cover" size={34} />
								<div>
									<div class="title">
										{#if t.canonicalTrackId}
											<a href={trackHref(t.canonicalTrackId)}>{t.name}</a>
										{:else}
											{t.name}
										{/if}
										{#if t.explicit}<span class="ex" title="Explicit">E</span>{/if}
									</div>
									{#if (t.copyCount ?? 0) > 1}
										<Chip tone="accent" title="This recording is in your library under {t.copyCount} different Spotify track ids">
											{t.copyCount} copies
										</Chip>
									{/if}
								</div>
							</div>
						</td>
						<td class="muted small">
							<ArtistLinks artists={t.artists} />
						</td>
						<td class="muted small">
							{#if t.albumId}<a href="/album/{t.albumId}">{t.albumName}</a>{:else}—{/if}
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
						<td class="r muted small nowrap" title={t.addedAt}>{shortDate(t.addedAt)}</td>
						<td class="r"><SpotifyLink kind="track" id={t.id} compact label="Open {t.name} in Spotify" /></td>
					</tr>
				{:else}
					<tr><td colspan="9" class="empty faint">No liked songs match that search.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
	<Pager page={data.page} pages={data.pages} total={data.total} pageSize={data.pageSize} unit="tracks" />
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
		min-width: 760px;
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
</style>
