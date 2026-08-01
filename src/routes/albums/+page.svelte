<script lang="ts">
	import Chip from '$lib/components/Chip.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import Pager from '$lib/components/Pager.svelte';
	import SearchBox from '$lib/components/SearchBox.svelte';
	import SpotifyLink from '$lib/components/SpotifyLink.svelte';
	import { num } from '$lib/utils/format.ts';

	let { data } = $props();
</script>

<svelte:head><title>Albums · Spotidata</title></svelte:head>

<header class="head">
	<div>
		<h1>Albums</h1>
		<p class="muted">
			{num(data.total)} albums{#if data.q} matching “{data.q}”{/if} — ranked by how many of their
			tracks are in your library.
		</p>
	</div>
	<SearchBox value={data.q} placeholder="Search albums or artists" keep={[]} />
</header>

<section class="card">
	<div class="scroll">
		<table>
			<thead>
				<tr>
					<th class="idx">#</th>
					<th>Album</th>
					<th>Artist</th>
					<th>Type</th>
					<th class="r">Released</th>
					<th class="r">Yours</th>
					<th class="cov">Coverage</th>
					<th class="r">Pop.</th>
					<th class="r"><span class="sr">Spotify</span></th>
				</tr>
			</thead>
			<tbody>
				{#each data.rows as a, i (a.id)}
					{@const share = a.totalTracks ? Math.min(1, a.tracks / a.totalTracks) : 0}
					<tr>
						<td class="idx num faint">{(data.page - 1) * data.pageSize + i + 1}</td>
						<td>
							<a class="cell" href="/album/{a.id}">
								<Cover src={a.cover} alt="{a.name} cover" size={40} />
								<span class="name">{a.name}</span>
							</a>
						</td>
						<td class="muted small">
							{#if a.artistId}<a href="/artist/{a.artistId}">{a.artist}</a>{:else}—{/if}
						</td>
						<td>
							{#if a.saved}
								<Chip tone="good" title="Saved to your albums">{a.albumType ?? 'album'}</Chip>
							{:else}
								<span class="faint small">{a.albumType ?? '—'}</span>
							{/if}
						</td>
						<td class="r num muted small nowrap">{a.releaseDate ?? '—'}</td>
						<td class="r num">{a.tracks}<span class="faint">/{num(a.totalTracks)}</span></td>
						<td class="cov">
							<span class="bar" aria-label="{Math.round(share * 100)}% of the album">
								<span class="fill" style="width:{share * 100}%"></span>
							</span>
						</td>
						<td class="r num">{a.popularity ?? '—'}</td>
						<td class="r"><SpotifyLink kind="album" id={a.id} compact label="Open {a.name} in Spotify" /></td>
					</tr>
				{:else}
					<tr><td colspan="9" class="empty faint">No albums match that search.</td></tr>
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
	.cell:hover .name {
		color: #fff;
	}
	.name {
		line-height: 1.3;
	}
	.small {
		font-size: 0.82rem;
	}
	th.cov,
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
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
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
</style>
