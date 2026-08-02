<script lang="ts">
	import ArtistLinks from '$lib/components/ArtistLinks.svelte';
	import Chip from '$lib/components/Chip.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import PendingEntity from '$lib/components/PendingEntity.svelte';
	import SpotifyLink from '$lib/components/SpotifyLink.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import { CATEGORICAL } from '$lib/charts/index.ts';
	import { num, longDuration, plainText, shortDate, trackTime } from '$lib/utils/format.ts';
	import { trackHref } from '$lib/utils/qs.ts';

	let { data } = $props();

	const p = $derived(data.pending ? null : data.playlist);
	const items = $derived(data.pending ? [] : data.items);
	const description = $derived(plainText(p?.description));
	const multiContributor = $derived((p?.contributorCount ?? 0) > 1);
	const drifted = $derived(p != null && p.itemsSyncedSnapshotId !== p.snapshotId);
</script>

<svelte:head><title>{p?.name ?? 'Playlist'} · Spotidata</title></svelte:head>

{#if data.pending}
	<h1>Playlist</h1>
	<PendingEntity kind="playlist" id={data.id} />
{:else if p}
	<header class="hero">
		<Cover src={p.cover} alt="{p.name} cover" size={200} />
		<div class="meta">
			<p class="eyebrow faint">Playlist</p>
			<h1>{p.name}</h1>
			{#if description}<p class="desc muted">{description}</p>{/if}
			<p class="muted small">
				{#if p.ownerId}
					<a href="https://open.spotify.com/user/{p.ownerId}" rel="noreferrer" target="_blank">
						{p.ownerName ?? p.ownerId}
					</a>
				{:else}
					unknown owner
				{/if}
				· {num(p.storedTracks)} tracks · {longDuration(p.durationMs)}
			</p>

			<div class="chips">
				{#if p.isOwned}
					<Chip tone="accent" title="Owned playlists define the library alongside liked songs">
						Yours — counts toward the library
					</Chip>
				{:else}
					<Chip title="Followed playlists are stored but excluded from library statistics">
						Followed only
					</Chip>
				{/if}
				{#if p.collaborative}<Chip tone="good">Collaborative</Chip>{/if}
				<Chip>{p.public === null ? 'visibility unknown' : p.public ? 'Public' : 'Private'}</Chip>
				{#if multiContributor}<Chip>{num(p.contributorCount)} contributors</Chip>{/if}
				{#if data.refreshing}<Chip tone="warn">Refreshing from Spotify…</Chip>{/if}
			</div>

			<div class="actions"><SpotifyLink kind="playlist" id={p.id} /></div>
		</div>
	</header>

	<section class="tiles">
		<StatTile label="Tracks" value={num(p.storedTracks)} sub="{num(p.distinctRecordings)} distinct recordings" accent={CATEGORICAL[0]} />
		<StatTile label="Duration" value={longDuration(p.durationMs)} sub="end to end" accent={CATEGORICAL[1]} />
		<StatTile label="In your library" value={num(p.inLibrary)} sub="{p.storedTracks > 0 ? Math.round((p.inLibrary / p.storedTracks) * 100) : 0}% of the playlist" accent={CATEGORICAL[2]} />
		<StatTile
			label="Last addition"
			value={p.lastAddedAt ? shortDate(p.lastAddedAt) : '—'}
			sub={p.firstAddedAt ? `started ${shortDate(p.firstAddedAt)}` : 'no timestamps'}
			accent={CATEGORICAL[3]}
		/>
	</section>

	<p class="snap faint small">
		Snapshot <span class="mono">{p.snapshotId}</span>
		{#if p.itemsSyncedAt}· items synced {shortDate(p.itemsSyncedAt)}{/if}
		{#if drifted}· <span class="warn">Spotify has a newer snapshot than the one stored</span>{/if}
		{#if p.localTracks > 0}· {num(p.localTracks)} local files{/if}
	</p>

	<section class="card">
		<h2>Tracks</h2>
		<p class="faint sub">In playlist order. {num(p.storedTracks - p.resolvedTracks)} items have no catalog track (local files, episodes or withdrawn tracks).</p>
		<div class="scroll-x">
			<table>
				<thead>
					<tr>
						<th class="idx">#</th>
						<th>Title</th>
						<th>Album</th>
						<th class="r">Length</th>
						<th class="r">Added</th>
						{#if multiContributor}<th>By</th>{/if}
						<th class="r"><span class="sr">Spotify</span></th>
					</tr>
				</thead>
				<tbody>
					{#each items as it (it.position)}
						<tr class:mine={it.inLibrary}>
							<td class="idx num faint">{it.position + 1}</td>
							<td>
								<div class="cell">
									<Cover src={it.cover} alt="{it.albumName ?? it.name} cover" size={32} />
									<div>
										<div class="title">
											{#if it.canonicalTrackId}
												<a href={trackHref(it.canonicalTrackId)}>{it.name}</a>
											{:else}
												<span class:faint={!it.trackId}>{it.name}</span>
											{/if}
											{#if it.liked}<span class="heart" title="Liked">♥</span>{/if}
											{#if it.explicit}<span class="ex" title="Explicit">E</span>{/if}
											{#if (it.copyCount ?? 0) > 1}<span class="faint xs" title="This recording exists under {it.copyCount} Spotify track ids"> ·{it.copyCount}×</span>{/if}
										</div>
										<div class="faint xs">
											{#if it.artists.length > 0}
												<ArtistLinks artists={it.artists} />
											{:else}
												{it.localArtist ?? (it.isLocal ? 'local file' : 'unavailable')}
											{/if}
										</div>
									</div>
								</div>
							</td>
							<td class="muted small">
								{#if it.albumId}<a href="/album/{it.albumId}">{it.albumName}</a>{:else}<span class="faint">—</span>{/if}
							</td>
							<td class="r num muted">{it.durationMs == null ? '—' : trackTime(it.durationMs)}</td>
							<td class="r muted small nowrap">{it.addedAt ? shortDate(it.addedAt) : '—'}</td>
							{#if multiContributor}
								<td class="muted small">{it.addedByName ?? it.addedById ?? '—'}</td>
							{/if}
							<td class="r">
								{#if it.trackId}
									<SpotifyLink kind="track" id={it.trackId} compact label="Open {it.name} in Spotify" />
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
{/if}

<style>
	.hero {
		display: flex;
		gap: 24px;
		align-items: flex-end;
		margin-bottom: var(--gap);
		flex-wrap: wrap;
	}
	.meta {
		flex: 1;
		min-width: 260px;
	}
	/* Phone: the blocks stack, so the artwork gives up the half-screen it would
	   otherwise take before the title. max-* rather than width, so it overrides
	   Cover's inline square without an !important. */
	@media (max-width: 640px) {
		.hero {
			gap: 14px;
			align-items: flex-start;
		}
		.hero :global(img),
		.hero :global(.placeholder) {
			max-width: 42vw;
			max-height: 42vw;
		}
		.meta {
			flex: 1 1 100%;
			min-width: 0;
		}
	}
	.eyebrow {
		margin: 0 0 6px;
		font-size: 0.72rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	h1 {
		font-size: 2rem;
		margin-bottom: 6px;
	}
	.desc {
		margin: 0 0 6px;
		font-size: 0.9rem;
		max-width: 70ch;
	}
	.small {
		font-size: 0.85rem;
		margin: 0;
	}
	.xs {
		font-size: 0.74rem;
	}
	.chips {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		margin-top: 12px;
	}
	.actions {
		margin-top: 14px;
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(168px, 1fr));
		gap: var(--gap);
		margin-bottom: var(--gap);
	}
	@media (max-width: 640px) {
		.tiles {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 10px;
		}
	}
	.snap {
		margin: 0 0 var(--gap);
		font-size: 0.78rem;
	}
	.warn {
		color: var(--warn);
	}
	.card {
		padding: var(--card-py) var(--card-px);
		margin-bottom: var(--gap);
	}
	h2 {
		margin-bottom: 2px;
	}
	.sub {
		font-size: 0.8rem;
		margin: 0 0 12px;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
		/* Under this the columns crush each other; the lane scrolls instead. */
		min-width: 660px;
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
		padding: 6px 10px 6px 0;
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
	tr.mine {
		background: rgba(124, 58, 237, 0.05);
	}
	.cell {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.title {
		line-height: 1.25;
	}
	.heart {
		color: var(--accent-2);
		font-size: 0.8rem;
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
	.mono {
		font-family: var(--mono);
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
