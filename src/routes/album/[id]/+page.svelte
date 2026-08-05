<script lang="ts">
	import ArtistLinks from '$lib/components/ArtistLinks.svelte';
	import Chip from '$lib/components/Chip.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import PendingEntity from '$lib/components/PendingEntity.svelte';
	import SpotifyLink from '$lib/components/SpotifyLink.svelte';
	import { num, shortDate, trackTime, longDuration } from '$lib/utils/format.ts';
	import { trackHref } from '$lib/utils/qs.ts';
	import type { AlbumEdition, AlbumTrack } from '$lib/server/entities/album.ts';

	let { data } = $props();

	const album = $derived(data.pending ? null : data.album);
	const mb = $derived(data.pending ? null : data.enrichment);
	/** "Album + Live + Remix" reads better than four separate chips. */
	const releaseKind = $derived(
		mb ? [mb.primaryType, ...(mb.secondaryTypes ?? [])].filter(Boolean).join(' · ') : null
	);
	const tracks = $derived<AlbumTrack[]>(data.pending ? [] : data.tracks);
	const editions = $derived<AlbumEdition[]>(data.pending ? [] : data.editions);

	const held = $derived(tracks.filter((t) => t.inLibrary).length);
	const viaCopy = $derived(tracks.filter((t) => t.viaOtherCopy).length);
	const totalTracks = $derived(album?.totalTracks ?? tracks.length);
	const completion = $derived(totalTracks > 0 ? held / totalTracks : 0);
	const runtime = $derived(tracks.reduce((a, t) => a + t.durationMs, 0));

	/** Multi-disc releases get a heading per disc; single-disc ones do not. */
	const discs = $derived.by(() => {
		const map = new Map<number, AlbumTrack[]>();
		for (const t of tracks) {
			const list = map.get(t.discNumber);
			if (list) list.push(t);
			else map.set(t.discNumber, [t]);
		}
		return [...map.entries()].sort((a, b) => a[0] - b[0]);
	});
</script>

<svelte:head><title>{album?.name ?? 'Album'} · Spotidata</title></svelte:head>

{#if data.pending}
	<h1>Album</h1>
	<PendingEntity kind="album" id={data.id} />
{:else if album}
	<header class="hero">
		<Cover src={album.cover} alt="{album.name} cover" size={200} />
		<div class="meta">
			<p class="eyebrow faint">{album.albumType ?? 'release'}</p>
			<h1>{album.name}</h1>
			<p class="artists">
				<ArtistLinks artists={album.artists} fallback="Unknown artist" dot />
			</p>
			<p class="muted small">
				{album.releaseDate ?? 'unknown date'} · {num(totalTracks)} tracks · {longDuration(runtime)}
				{#if album.label}· {album.label}{/if}
			</p>

			<div class="chips">
				{#if album.popularity != null}<Chip>Popularity {album.popularity}</Chip>{/if}
				{#if album.savedAt}<Chip tone="good">Saved {shortDate(album.savedAt)}</Chip>{/if}
				{#if album.upc}<Chip title="Universal Product Code">UPC <span class="mono">{album.upc}</span></Chip>{/if}
				{#if album.marketCount > 0}<Chip>{num(album.marketCount)} markets</Chip>{/if}
				{#if editions.length > 0}
					<Chip tone="accent" title="Other releases with exactly these recordings">
						{editions.length + 1} editions
					</Chip>
				{/if}
				{#each album.genres as g (g)}<Chip tone="accent">{g}</Chip>{/each}
				{#if data.refreshing}<Chip tone="warn">Refreshing from Spotify…</Chip>{/if}
			</div>

			<div class="actions"><SpotifyLink kind="album" id={album.id} /></div>
		</div>

		<div class="completion card">
			<div class="pct num">{Math.round(completion * 100)}%</div>
			<div class="faint xs">you have</div>
			<div class="held num">{num(held)} <span class="faint">of {num(totalTracks)}</span></div>
			<div class="meter" role="img" aria-label="{held} of {totalTracks} tracks in your library">
				<div class="fill" style="width:{Math.min(100, completion * 100)}%"></div>
			</div>
			{#if viaCopy > 0}
				<div class="faint xs">
					+{num(viaCopy)} more you own as a different release of the same recording
				</div>
			{/if}
			{#if data.plays.plays > 0}
				<div class="listened xs">
					<span class="num">{longDuration(data.plays.msPlayed)}</span> played ·
					{num(data.plays.plays)} streams
				</div>
			{/if}
		</div>
	</header>

	{#if !album.tracksComplete && tracks.length < totalTracks}
		<p class="warnline faint small">
			Showing {num(tracks.length)} of {num(totalTracks)} tracks — the rest have not been fetched yet.
		</p>
	{/if}

	<section class="card">
		<h2>Tracks</h2>
		<p class="faint sub">
			A filled dot marks a track in your library; a hollow one means you hold the same recording on
			another release.
		</p>
		<div class="scroll-x">
			<table>
				<thead>
					<tr>
						<th class="c"><span class="sr">In library</span></th>
						<th class="idx">#</th>
						<th>Title</th>
						<th>Artists</th>
						<th class="r">Length</th>
						<th class="r">Pop.</th>
						<th class="r">Plays</th>
						<th class="r"><span class="sr">Spotify</span></th>
					</tr>
				</thead>
				<tbody>
					{#each discs as [disc, list] (disc)}
						{#if discs.length > 1}
							<tr class="discrow"><td colspan="8" class="faint xs">Disc {disc}</td></tr>
						{/if}
						{#each list as t (t.id)}
							<tr class:mine={t.inLibrary}>
								<td class="c">
									{#if t.inLibrary}
										<span class="dot on" title={t.liked ? 'Liked' : 'In an owned playlist'}></span>
									{:else if t.viaOtherCopy}
										<span class="dot alt" title="Same recording held on another release"></span>
									{:else}
										<span class="dot" title="Not in your library"></span>
									{/if}
								</td>
								<td class="idx num faint">{t.trackNumber}</td>
								<td>
									{#if t.canonicalTrackId}
										<a href={trackHref(t.canonicalTrackId)}>{t.name}</a>
									{:else}
										{t.name}
									{/if}
									{#if t.explicit}<span class="ex" title="Explicit">E</span>{/if}
								</td>
								<td class="muted small">
									<ArtistLinks artists={t.artists} />
								</td>
								<td class="r num muted">{trackTime(t.durationMs)}</td>
								<td class="r num">{t.popularity ?? '—'}</td>
								<td
									class="r num"
									class:faint={t.plays === 0}
									title={t.plays > 0
										? `${longDuration(t.msPlayed)} listened, counting every release of this recording`
										: 'Not in your listening history'}
								>
									{t.plays || '—'}
								</td>
								<td class="r"><SpotifyLink kind="track" id={t.id} compact label="Open {t.name} in Spotify" /></td>
							</tr>
						{/each}
					{/each}
				</tbody>
			</table>
		</div>
	</section>

	{#if mb}
		<section class="card mb">
			<header class="cardhead">
				<div>
					<h2>The release</h2>
					<p class="faint sub">
						MusicBrainz catalogues the physical and digital editions Spotify flattens into
						one: who issued this pressing, under what number, and in which countries.
					</p>
				</div>
				<a class="more" href="https://musicbrainz.org/release/{mb.releaseMbid}" rel="noreferrer">
					MusicBrainz →
				</a>
			</header>
			<dl>
				{#if mb.labelName}
					<dt>Label</dt>
					<dd>
						{mb.labelName}
						{#if mb.catalogNumber}<span class="faint">· cat. {mb.catalogNumber}</span>{/if}
						{#if album.label && album.label !== mb.labelName}
							<span class="faint">· Spotify credits {album.label}</span>
						{/if}
					</dd>
				{/if}
				{#if releaseKind}
					<dt>Type</dt>
					<dd>{releaseKind}{#if mb.releaseStatus && mb.releaseStatus !== 'Official'}<span class="faint"> · {mb.releaseStatus}</span>{/if}</dd>
				{/if}
				{#if mb.groupFirstReleaseDate}
					<dt>First released</dt>
					<dd>
						{mb.groupFirstReleaseDate}
						{#if mb.releaseDate && mb.releaseDate !== mb.groupFirstReleaseDate}
							<span class="faint">· this edition {mb.releaseDate}</span>
						{/if}
					</dd>
				{/if}
				{#if mb.genres?.length}
					<dt>Genres</dt>
					<dd class="chips">
						{#each mb.genres.slice(0, 8) as g (g)}<Chip tone="accent">{g}</Chip>{/each}
					</dd>
				{/if}
				{#if mb.barcode || mb.country || mb.packaging}
					<dt>Issued</dt>
					<dd class="faint">
						{#if mb.country}{mb.country}{/if}
						{#if mb.packaging}· {mb.packaging}{/if}
						{#if mb.barcode}· barcode {mb.barcode}{/if}
					</dd>
				{/if}
			</dl>
		</section>
	{/if}

	{#if editions.length > 0}
		<section class="card">
			<h2>Other editions</h2>
			<p class="faint sub">
				{editions.length === 1 ? 'One other release carries' : `${num(editions.length)} other releases carry`}
				exactly these recordings — a re-issue, a regional duplicate or the same record filed under
				a second type.
			</p>
			<ul class="editions">
				{#each editions as e (e.id)}
					<li>
						<a href="/album/{e.id}">
							<Cover src={e.cover} alt="{e.name} cover" size={44} />
							<span class="ed">
								<span class="edname">{e.name}</span>
								<span class="faint xs">
									{e.albumType ?? 'release'} · {e.releaseDate ?? 'unknown date'}
								</span>
							</span>
						</a>
						{#if e.representative}<Chip>Primary</Chip>{/if}
						{#if e.saved}<Chip tone="good">Saved</Chip>{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if album.copyrights && album.copyrights.length > 0}
		<section class="card">
			<h2>Copyright</h2>
			<ul class="copy">
				{#each album.copyrights as c, i (i)}
					<li>
						<span class="ctype faint">{c.type === 'P' ? '℗' : c.type === 'C' ? '©' : c.type}</span>
						<span class="muted">{c.text}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
{/if}

<style>
	.cardhead {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}
	.more {
		flex: none;
		font-size: 0.78rem;
		color: var(--text-muted);
		white-space: nowrap;
	}
	.more:hover {
		color: var(--text);
	}
	.mb dl {
		display: grid;
		grid-template-columns: 130px 1fr;
		gap: 9px 16px;
		margin: 0;
	}
	.mb dt {
		color: var(--text-muted);
		font-size: 0.84rem;
	}
	.mb dd {
		margin: 0;
		min-width: 0;
		font-size: 0.9rem;
		overflow-wrap: anywhere;
	}
	.mb dd.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}
	@media (max-width: 640px) {
		.mb dl {
			grid-template-columns: 1fr;
			gap: 3px;
		}
		.mb dd + dt {
			margin-top: 9px;
		}
	}
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
	/* Phone: the three blocks stack, so the artwork gives up the half-screen it
	   would otherwise take before the title. max-* rather than width, so it
	   overrides Cover's inline square without an !important. */
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
		.completion {
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
	.artists {
		margin: 0 0 4px;
		font-size: 0.98rem;
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
	.completion {
		padding: var(--card-py) var(--card-px);
		min-width: 200px;
		align-self: stretch;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		gap: 3px;
	}
	.pct {
		font-size: 2rem;
		font-weight: 650;
		line-height: 1;
		background: linear-gradient(100deg, var(--accent), var(--accent-2));
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
	}
	.held {
		font-size: 0.9rem;
		margin-top: 2px;
	}
	.listened {
		margin-top: 8px;
		padding-top: 8px;
		border-top: 1px solid var(--hairline);
		color: var(--text-muted);
	}
	.meter {
		height: 6px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.07);
		overflow: hidden;
		margin: 8px 0 4px;
	}
	.meter .fill {
		height: 100%;
		background: linear-gradient(90deg, var(--accent), var(--accent-2));
	}
	.warnline {
		margin: 0 0 var(--gap);
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
		min-width: 640px;
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
	th.c,
	td.c {
		width: 22px;
		text-align: center;
		padding-right: 6px;
	}
	tr.discrow td {
		border: 0;
		padding-top: 14px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	tr.mine {
		background: rgba(124, 58, 237, 0.05);
	}
	.dot {
		display: inline-block;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		border: 1px solid var(--hairline-strong);
	}
	.dot.on {
		background: var(--accent-2);
		border-color: var(--accent-2);
	}
	.dot.alt {
		border-color: var(--accent-2);
	}
	.ex {
		display: inline-block;
		margin-left: 6px;
		font-size: 0.62rem;
		padding: 0 4px;
		border-radius: 3px;
		background: rgba(255, 255, 255, 0.08);
		color: var(--text-faint);
		vertical-align: middle;
	}
	.editions {
		list-style: none;
		margin: 10px 0 0;
		padding: 0;
		display: grid;
		gap: 8px;
	}
	.editions li {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.editions a {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
		flex: 1;
	}
	.ed {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.edname {
		font-size: 0.9rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.copy {
		list-style: none;
		margin: 10px 0 0;
		padding: 0;
		font-size: 0.85rem;
		display: grid;
		gap: 6px;
	}
	.ctype {
		display: inline-block;
		width: 18px;
	}
	.mono {
		font-family: var(--mono);
		font-size: 0.9em;
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
</style>
