<script lang="ts">
	import ArtistLinks from '$lib/components/ArtistLinks.svelte';
	import Chip from '$lib/components/Chip.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import Pager from '$lib/components/Pager.svelte';
	import SearchBox from '$lib/components/SearchBox.svelte';
	import SortTh from '$lib/components/SortTh.svelte';
	import SpotifyLink from '$lib/components/SpotifyLink.svelte';
	import { num, shortDate, trackTime } from '$lib/utils/format.ts';
	import { trackHref } from '$lib/utils/qs.ts';

	let { data } = $props();
</script>

<svelte:head><title>Library · Spotidata</title></svelte:head>

<header class="head">
	<div>
		<h1>Library</h1>
		<p class="muted">
			{num(data.total)} distinct recordings{#if data.q} matching “{data.q}”{/if} — liked songs
			plus everything in a playlist you own, deduplicated by ISRC.
		</p>
	</div>
	<SearchBox value={data.q} placeholder="Search recordings" />
</header>

<section class="card">
	<div class="scroll">
		<table>
			<thead>
				<tr>
					<th class="idx">#</th>
					<SortTh key="name" label="Recording" active={data.sort} dir={data.dir} initial="asc" />
					<SortTh key="artist" label="Artist" active={data.sort} dir={data.dir} initial="asc" />
					<th>Album</th>
					<SortTh key="copies" label="Copies" active={data.sort} dir={data.dir} right />
					<SortTh key="duration" label="Length" active={data.sort} dir={data.dir} right />
					<SortTh key="popularity" label="Pop." active={data.sort} dir={data.dir} right />
					<SortTh key="added" label="First added" active={data.sort} dir={data.dir} right />
					<th class="r"><span class="sr">Spotify</span></th>
				</tr>
			</thead>
			<tbody>
				{#each data.rows as t, i (t.canonicalTrackId)}
					<tr>
						<td class="idx num faint">{(data.page - 1) * data.pageSize + i + 1}</td>
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
						<td class="muted small">
							<ArtistLinks artists={t.artists} />
						</td>
						<td class="muted small">
							{#if t.albumId}<a href="/album/{t.albumId}">{t.albumName}</a>{:else}—{/if}
						</td>
						<td class="r">
							{#if t.copyCount > 1}
								<Chip tone="accent" title="{t.copyCountInLibrary} of them in your library">
									{t.copyCount}
								</Chip>
							{:else}
								<span class="faint num">1</span>
							{/if}
						</td>
						<td class="r num muted">{trackTime(t.durationMs)}</td>
						<td class="r num">{t.popularity ?? '—'}</td>
						<td class="r muted small nowrap" title={t.firstAddedAt}>{shortDate(t.firstAddedAt)}</td>
						<td class="r">
							<SpotifyLink
								kind="track"
								id={t.representativeTrackId}
								compact
								label="Open {t.title} in Spotify"
							/>
						</td>
					</tr>
				{:else}
					<tr><td colspan="9" class="empty faint">No recordings match that search.</td></tr>
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
	.card {
		padding: 16px 18px;
	}
	.scroll {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
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
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
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
