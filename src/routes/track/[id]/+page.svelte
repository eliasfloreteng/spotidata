<script lang="ts">
	import ArtistLinks from '$lib/components/ArtistLinks.svelte';
	import Chip from '$lib/components/Chip.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import SpotifyLink from '$lib/components/SpotifyLink.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import { CATEGORICAL } from '$lib/charts/index.ts';
	import { num, shortDate, trackTime, relativeTime } from '$lib/utils/format.ts';

	let { data } = $props();

	const t = $derived(data.track);
	const copies = $derived(data.copies);
	const distinctNames = $derived(new Set(copies.map((c) => c.name)).size);
	const distinctAlbums = $derived(new Set(copies.map((c) => c.albumId)).size);
	/** Withdrawn and local tracks reach the catalog with an empty name. */
	const title = $derived(t.title || '(untitled)');
	const plural = (n: number, one: string, many = one + 's') => (n === 1 ? one : many);
</script>

<svelte:head><title>{title} · Spotidata</title></svelte:head>

<header class="hero">
	<Cover src={t.cover} alt="{t.title} cover" size={168} />
	<div class="meta">
		<p class="eyebrow faint">Recording</p>
		<h1>{title}</h1>
		<p class="artists">
			<ArtistLinks artists={t.artists} fallback="Unknown artist" dot />
		</p>
		{#if t.primaryAlbumId}
			<p class="muted small">
				<a href="/album/{t.primaryAlbumId}">{t.primaryAlbumName}</a>
				{#if t.earliestReleaseDate}<span class="faint"> · first released {shortDate(t.earliestReleaseDate)}</span>{/if}
			</p>
		{/if}

		<div class="chips">
			<Chip>{trackTime(t.durationMs)}</Chip>
			{#if t.explicit}<Chip tone="warn">Explicit</Chip>{/if}
			{#if t.kind === 'isrc'}
				<Chip title="International Standard Recording Code — the identity every copy shares">
					ISRC <span class="mono">{t.isrc}</span>
				</Chip>
			{:else}
				<Chip tone="warn" title="No ISRC on any copy; grouped on title, duration and artist instead">
					Grouped by heuristic
				</Chip>
			{/if}
			{#if t.liked}<Chip tone="good">Liked {t.likedAt ? relativeTime(t.likedAt) : ''}</Chip>{/if}
			{#if t.copyCount > 1}<Chip tone="accent">{t.copyCount} Spotify copies</Chip>{/if}
		</div>

		<div class="actions">
			<SpotifyLink kind="track" id={t.representativeTrackId} />
		</div>
	</div>
</header>

{#if t.kind === 'fallback'}
	<p class="explain faint small">
		Spotify returned no ISRC for any copy of this track, so the copies below were grouped by a
		heuristic on title, duration and artist rather than by the recording's real identity. It may
		be over- or under-grouped.
	</p>
{/if}

<section class="tiles">
	<StatTile label="Copies on Spotify" value={num(t.copyCount)} sub="{num(distinctAlbums)} {plural(distinctAlbums, 'album')} · {num(distinctNames)} distinct {plural(distinctNames, 'title')}" accent={CATEGORICAL[0]} />
	<StatTile label="Peak popularity" value={t.maxPopularity == null ? '—' : String(t.maxPopularity)} sub="best of all copies" accent={CATEGORICAL[1]} />
	<StatTile label="In your library" value={t.copyCountInLibrary > 0 ? `${num(t.copyCountInLibrary)} ${plural(t.copyCountInLibrary, 'copy', 'copies')}` : 'No'} sub={t.firstAddedAt ? `first added ${shortDate(t.firstAddedAt)}` : 'not saved'} accent={CATEGORICAL[2]} />
	<StatTile label="Playlists" value={num(data.playlists.length)} sub="{num(t.ownedPlaylistCount)} of them yours" accent={CATEGORICAL[3]} />
</section>

<section class="card">
	<h2>Every Spotify copy</h2>
	<p class="faint sub">
		One recording, {num(t.copyCount)}
		{t.copyCount === 1 ? 'track id' : 'track ids'} — singles, album cuts, deluxe editions and
		regional releases all collapse here.
	</p>
	<div class="scroll">
		<table>
			<thead>
				<tr>
					<th>Title</th>
					<th>Album</th>
					<th>Released</th>
					<th class="r">Length</th>
					<th class="r">Pop.</th>
					<th class="state">State</th>
					<th class="r"><span class="sr">Spotify</span></th>
				</tr>
			</thead>
			<tbody>
				{#each copies as c (c.id)}
					<tr class:rep={c.isRepresentative}>
						<td>
							<div class="cell">
								<Cover src={c.albumCover} alt="{c.albumName ?? c.name} cover" size={34} />
								<div>
									<div class="title">
										{c.name || '(untitled)'}
										{#if c.isRepresentative}<span class="star" title="The copy shown across the app">★</span>{/if}
									</div>
									<div class="faint xs">
										{c.artists.map((a) => a.name).join(', ') || '—'}
										{#if c.linkedFromId}<span title="Track relinking substituted this id"> · relinked</span>{/if}
									</div>
								</div>
							</div>
						</td>
						<td>
							{#if c.albumId}
								<a href="/album/{c.albumId}">{c.albumName || '(untitled album)'}</a>
								<div class="faint xs">{c.albumType ?? '—'} · disc {c.discNumber}, track {c.trackNumber}</div>
							{:else}
								<span class="faint">—</span>
							{/if}
						</td>
						<td class="num muted nowrap">{c.albumReleaseDate ?? '—'}</td>
						<td class="r num muted">{trackTime(c.durationMs)}</td>
						<td class="r num">{c.popularity ?? '—'}</td>
						<td class="state">
							<div class="chips tight">
								{#if c.likedAt}<Chip tone="good" title="Liked {shortDate(c.likedAt)}">Liked</Chip>{/if}
								{#if c.inLibrary && !c.likedAt}<Chip tone="accent">Library</Chip>{/if}
								{#if c.playlistCount > 0}<Chip>{c.playlistCount} pl</Chip>{/if}
								{#if !c.inLibrary && c.playlistCount === 0}<span class="faint xs">—</span>{/if}
							</div>
						</td>
						<td class="r"><SpotifyLink kind="track" id={c.id} compact label="Open {c.name || 'track'} in Spotify" /></td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</section>

<section class="card">
	<h2>Playlists</h2>
	{#if data.playlists.length === 0}
		<p class="faint sub">Not in any playlist you follow or own.</p>
	{:else}
		<table>
			<thead>
				<tr>
					<th>Playlist</th><th>Owner</th><th class="r">Times</th><th class="r">Added</th>
				</tr>
			</thead>
			<tbody>
				{#each data.playlists as p (p.id)}
					<tr>
						<td>
							<a href="/playlist/{p.id}">{p.name}</a>
							{#if p.collaborative}<span class="faint xs"> · collaborative</span>{/if}
						</td>
						<td>
							{#if p.isOwned}
								<Chip tone="accent">Yours</Chip>
							{:else}
								<span class="muted small">{p.addedByName ?? p.addedById ?? 'followed'}</span>
							{/if}
						</td>
						<td class="r num">{p.occurrences}</td>
						<td class="r muted small nowrap" title={p.addedAt ?? ''}>{p.addedAt ? shortDate(p.addedAt) : '—'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>

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
	.artists {
		margin: 0 0 4px;
		font-size: 0.98rem;
	}
	.small {
		font-size: 0.85rem;
		margin: 0;
	}
	.xs {
		font-size: 0.75rem;
	}
	.chips {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		margin-top: 12px;
	}
	th.state,
	td.state {
		padding-left: 14px;
	}
	.chips.tight {
		margin-top: 0;
		gap: 4px;
	}
	.actions {
		margin-top: 14px;
	}
	.explain {
		margin: 0 0 var(--gap);
		max-width: 70ch;
		font-size: 0.82rem;
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(168px, 1fr));
		gap: var(--gap);
		margin-bottom: var(--gap);
	}
	.card {
		padding: 16px 18px;
		margin-bottom: var(--gap);
	}
	h2 {
		margin-bottom: 2px;
	}
	.sub {
		font-size: 0.8rem;
		margin: 0 0 12px;
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
		padding: 8px 10px 8px 0;
		border-bottom: 1px solid rgba(255, 255, 255, 0.03);
		vertical-align: middle;
	}
	th.r,
	td.r {
		text-align: right;
	}
	th:last-child,
	td:last-child {
		padding-right: 0;
	}
	tr.rep {
		background: rgba(124, 58, 237, 0.06);
	}
	.cell {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.title {
		line-height: 1.25;
	}
	.star {
		color: var(--accent-2);
		font-size: 0.7rem;
		vertical-align: super;
	}
	.mono {
		font-family: var(--mono);
		font-size: 0.9em;
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
	.nowrap {
		white-space: nowrap;
	}
</style>
