<script lang="ts">
	import ArtistLinks from '$lib/components/ArtistLinks.svelte';
	import Chip from '$lib/components/Chip.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import SpotifyLink from '$lib/components/SpotifyLink.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import { AreaChart, CATEGORICAL } from '$lib/charts/index.ts';
	import { longDuration, num, pct, shortDate, trackTime, streamTime, relativeTime } from '$lib/utils/format.ts';
	import { camelot, musicalKey, tempoLabel, traits } from '$lib/utils/music.ts';

	let { data } = $props();

	const e = $derived(data.enrichment);
	const key = $derived(e ? musicalKey(e.keyKey, e.keyScale) : null);
	const wheel = $derived(e ? camelot(e.keyKey, e.keyScale) : null);
	const tempo = $derived(e ? tempoLabel(e.bpm) : null);
	const traitList = $derived(e ? traits(e as unknown as Record<string, number | null>) : []);

	const t = $derived(data.track);
	const p = $derived(data.plays);
	const playSeries = $derived([
		{
			key: 'plays',
			label: 'Plays',
			points: data.playsByMonth.map((m) => ({ date: `${m.period}-01`, value: m.plays })),
			render: 'bar' as const
		}
	]);
	/** The tile's sparkline: the last two years of the same series. */
	const playTrend = $derived(data.playsByMonth.slice(-24).map((m) => m.plays));
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
	<StatTile
		label="Times played"
		value={p.plays > 0 ? num(p.plays) : '—'}
		sub={p.plays > 0
			? `${longDuration(p.msPlayed)} listened`
			: 'not in your listening history'}
		accent={CATEGORICAL[4]}
		trend={playTrend}
		muted={p.plays === 0}
	/>
</section>

{#if e}
	<section class="card">
		<header class="cardhead">
			<div>
				<h2>The recording itself</h2>
				<p class="faint sub">
					From MusicBrainz, matched on this recording's ISRC — and, where someone has
					submitted an analysis of the audio, from AcousticBrainz.
				</p>
			</div>
			<a class="more" href="https://musicbrainz.org/recording/{e.recordingMbid}" rel="noreferrer">
				MusicBrainz →
			</a>
		</header>

		<div class="mbgrid">
			{#if e.bpm != null || e.keyKey}
				<div class="analysis">
					{#if e.bpm != null}
						<div class="big">
							<span class="num">{Math.round(e.bpm)}</span><span class="unit">BPM</span>
							{#if tempo}<em class="faint">{tempo}</em>{/if}
						</div>
					{/if}
					{#if key}
						<div class="big">
							<span class="num">{key}</span>
							{#if wheel}
								<span class="unit" title="Camelot wheel code — adjacent codes mix">{wheel}</span>
							{/if}
							{#if e.keyStrength != null}
								<em class="faint" title="How confident the key estimate is">
									{pct(e.keyStrength)} confident
								</em>
							{/if}
						</div>
					{/if}
				</div>
			{/if}

			<dl>
				{#if e.genres?.length}
					<dt>Genres</dt>
					<dd class="chips">
						{#each e.genres.slice(0, 8) as g (g)}<Chip tone="accent">{g}</Chip>{/each}
					</dd>
				{/if}
				{#if e.mbFirstReleaseDate}
					<dt>First released</dt>
					<dd>
						{shortDate(e.mbFirstReleaseDate)}
						{#if t.earliestReleaseDate && t.earliestReleaseDate.slice(0, 10) !== e.mbFirstReleaseDate}
							<span class="faint small">
								· Spotify's earliest edition says {shortDate(t.earliestReleaseDate)}
							</span>
						{/if}
					</dd>
				{/if}
				{#if e.mbTitle && e.mbTitle !== t.title}
					<dt>Titled</dt>
					<dd>{e.mbTitle}{#if e.mbDisambiguation}<span class="faint"> ({e.mbDisambiguation})</span>{/if}</dd>
				{/if}
				{#if traitList.length > 0}
					<dt>Reads as</dt>
					<dd class="chips">
						{#each traitList as tr (tr.label)}
							<Chip title="{pct(tr.value)} confidence">{tr.label}</Chip>
						{/each}
					</dd>
				{/if}
				{#if e.genreRosamerica}
					<dt>Classifier</dt>
					<dd class="faint">
						sounds like <strong>{e.genreRosamerica}</strong>
						{#if e.moodMirex}· mood cluster {e.moodMirex.replace('Cluster', '')}{/if}
					</dd>
				{/if}
			</dl>
		</div>
	</section>
{/if}

{#if p.plays > 0}
	<section class="card">
		<header class="cardhead">
			<div>
				<h2>Listening</h2>
				<p class="faint sub">
					First played {shortDate(p.firstPlayedAt)}, most recently {relativeTime(p.lastPlayedAt)}.
					{num(p.completed)} of {num(p.plays)} streams ran past 30 seconds.
				</p>
			</div>
			<a class="more" href="/history">All listening →</a>
		</header>

		<div class="playgrid">
			<div class="chartwrap">
				<AreaChart series={playSeries} title="Plays per month" unit="plays" height={230} />
			</div>
			<ul class="log">
				{#each data.recentPlays as r (r.id)}
					<li>
						<span class="when muted small" title={r.playedAt}>{relativeTime(r.playedAt)}</span>
						<span
							class="dur num small"
							title={r.estimated ? 'Estimated from the gap to the previous play' : ''}
						>
							{streamTime(r.msPlayed, r.estimated)}
						</span>
						<span class="how faint xs">
							{r.platform ?? r.source}{#if r.reasonEnd} · {r.reasonEnd}{/if}
						</span>
					</li>
				{/each}
			</ul>
		</div>
	</section>
{/if}

<section class="card">
	<h2>Every Spotify copy</h2>
	<p class="faint sub">
		One recording, {num(t.copyCount)}
		{t.copyCount === 1 ? 'track id' : 'track ids'} — singles, album cuts, deluxe editions and
		regional releases all collapse here.
	</p>
	<div class="scroll-x">
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
	/* The analysis reads as a pair of readouts beside the facts, so the two
	   numbers people came for are legible before anything is read. */
	.mbgrid {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 20px 32px;
		align-items: start;
	}
	@media (max-width: 700px) {
		.mbgrid {
			grid-template-columns: 1fr;
			gap: 16px;
		}
	}
	.analysis {
		display: grid;
		gap: 12px;
		min-width: 150px;
	}
	.big {
		display: flex;
		align-items: baseline;
		gap: 7px;
		flex-wrap: wrap;
	}
	.big .num {
		font-size: 1.9rem;
		font-weight: 600;
		line-height: 1;
	}
	.big .unit {
		font-size: 0.78rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.big em {
		font-style: normal;
		font-size: 0.78rem;
		flex-basis: 100%;
	}
	.mbgrid dl {
		display: grid;
		grid-template-columns: 130px 1fr;
		gap: 9px 16px;
		margin: 0;
	}
	.mbgrid dt {
		color: var(--text-muted);
		font-size: 0.84rem;
	}
	.mbgrid dd {
		margin: 0;
		min-width: 0;
		font-size: 0.9rem;
		overflow-wrap: anywhere;
	}
	.mbgrid dd.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}
	@media (max-width: 640px) {
		.mbgrid dl {
			grid-template-columns: 1fr;
			gap: 3px;
		}
		.mbgrid dd + dt {
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
	@media (max-width: 640px) {
		.tiles {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 10px;
		}
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
	/* The chart takes the width it needs and the recent plays sit beside it;
	   below 820px they stack, because a 10-row log squeezed into a third of a
	   phone is unreadable in either place. */
	.playgrid {
		display: grid;
		grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
		gap: var(--gap);
		align-items: start;
	}
	@media (max-width: 820px) {
		.playgrid {
			grid-template-columns: 1fr;
		}
	}
	.log {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}
	.log li {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0 10px;
		padding: 6px 0;
		border-bottom: 1px solid rgba(255, 255, 255, 0.03);
	}
	.log .how {
		grid-column: 1 / -1;
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
	.nowrap {
		white-space: nowrap;
	}
</style>
