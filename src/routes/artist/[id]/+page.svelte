<script lang="ts">
	import Chip from '$lib/components/Chip.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import PendingEntity from '$lib/components/PendingEntity.svelte';
	import SpotifyLink from '$lib/components/SpotifyLink.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import { CATEGORICAL } from '$lib/charts/index.ts';
	import { num, relativeTime, shortDate, trackTime, longDuration } from '$lib/utils/format.ts';
	import { trackHref } from '$lib/utils/qs.ts';
	import type { ArtistAlbum } from '$lib/server/entities/artist.ts';

	let { data } = $props();

	const e = $derived(data.pending ? null : data.enrichment);
	/**
	 * MusicBrainz genres come off the artist's own entry and Spotify's come off
	 * an opaque model, so they disagree usefully. Showing only what Spotify does
	 * not already say keeps the row short and every chip informative.
	 */
	const extraGenres = $derived.by(() => {
		if (!e?.genres || data.pending) return [];
		const known = new Set(data.artist.genres.map((g) => g.toLowerCase()));
		return e.genres.filter((g) => !known.has(g.toLowerCase())).slice(0, 8);
	});
	const origin = $derived(e ? (e.beginAreaName ?? e.areaName ?? e.country) : null);
	const matchNote = $derived(
		e?.matchSource === 'url'
			? 'through the Spotify link MusicBrainz stores for them'
			: 'through a recording they are credited on'
	);
	const life = $derived.by(() => {
		if (!e?.beginDate) return null;
		const from = e.beginDate.slice(0, 4);
		if (e.endDate) return `${from} – ${e.endDate.slice(0, 4)}`;
		return e.ended ? `${from} – ?` : `since ${from}`;
	});

	const artist = $derived(data.pending ? null : data.artist);
	const stats = $derived(data.pending ? null : data.stats);
	const albums = $derived<ArtistAlbum[]>(data.pending ? [] : data.albums);
	const unsavedTop = $derived(
		data.pending ? 0 : data.topPlayed.filter((t) => !t.inLibrary).length
	);

	const ORDER = ['album', 'single', 'compilation', 'other'];
	const LABELS: Record<string, string> = {
		album: 'Albums',
		single: 'Singles & EPs',
		compilation: 'Compilations',
		other: 'Other releases'
	};

	const orderedGroups = $derived.by(() => {
		const map = new Map<string, ArtistAlbum[]>();
		for (const a of albums) {
			const list = map.get(a.albumType);
			if (list) list.push(a);
			else map.set(a.albumType, [a]);
		}
		const rank = (k: string) => (ORDER.indexOf(k) < 0 ? 99 : ORDER.indexOf(k));
		return [...map.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
	});
</script>

<svelte:head><title>{artist?.name ?? 'Artist'} · Spotidata</title></svelte:head>

{#if data.pending}
	<h1>Artist</h1>
	<PendingEntity kind="artist" id={data.id} />
{:else if artist && stats}
	<header class="hero">
		<Cover src={artist.image} alt="{artist.name} photo" size={168} round />
		<div class="meta">
			<p class="eyebrow faint">Artist</p>
			<h1>{artist.name}</h1>
			<p class="muted small">
				{artist.followersTotal == null ? 'followers unknown' : `${num(artist.followersTotal)} followers`}
				{#if artist.popularity != null}· popularity {artist.popularity}{/if}
				{#if artist.followedAt}· <span class="good">you follow them</span>{/if}
			</p>

			<div class="chips">
				{#if artist.genres.length > 0}
					{#each artist.genres as g (g)}<Chip tone="accent">{g}</Chip>{/each}
				{:else}
					<span class="faint small">No genres from Spotify for this artist.</span>
				{/if}
				{#if data.refreshing}<Chip tone="warn">Refreshing from Spotify…</Chip>{/if}
			</div>

			<div class="actions"><SpotifyLink kind="artist" id={artist.id} /></div>
		</div>
	</header>

	<section class="tiles">
		<StatTile label="Recordings" value={num(stats.libraryRecordings)} sub="{num(stats.libraryCopies)} track ids" accent={CATEGORICAL[0]} />
		<!-- "Runtime", not "Listen time": the tile beside it now reports actual
		     listening, and two tiles both called listening would be a trap. -->
		<StatTile label="Runtime" value={longDuration(stats.durationMs)} sub="one pass through" accent={CATEGORICAL[1]} />
		<StatTile label="Liked" value={num(stats.likedRecordings)} sub="{num(stats.albumsInLibrary)} albums represented" accent={CATEGORICAL[2]} />
		<StatTile
			label="First added"
			value={stats.firstAddedAt ? shortDate(stats.firstAddedAt) : '—'}
			sub={stats.latestAddedAt ? `latest ${shortDate(stats.latestAddedAt)}` : 'not in your library'}
			accent={CATEGORICAL[3]}
		/>
		<StatTile
			label="You have played"
			value={data.plays.plays > 0 ? longDuration(data.plays.msPlayed) : '—'}
			sub={data.plays.plays > 0
				? `${num(data.plays.plays)} plays · last ${relativeTime(data.plays.lastPlayedAt)}`
				: 'not in your listening history'}
			accent={CATEGORICAL[4]}
			muted={data.plays.plays === 0}
		/>
	</section>

	<!-- A stub match carries an MBID and nothing else; the card waits until the
	     artist's own lookup has filled something in worth showing. -->
	{#if e && (e.type || origin || life || e.ratingValue != null || extraGenres.length > 0)}
		<section class="card mb">
			<header class="cardhead">
				<div>
					<h2>On MusicBrainz</h2>
					<p class="faint sub">
						Matched {matchNote}. Spotify knows an artist as a name and a set of
						genre guesses; MusicBrainz knows where they are from and when they existed.
					</p>
				</div>
				<a class="more" href="https://musicbrainz.org/artist/{e.mbid}" rel="noreferrer">
					MusicBrainz →
				</a>
			</header>
			<dl>
				{#if e.type}
					<dt>Type</dt>
					<dd>
						{e.type}{#if e.gender}<span class="faint"> · {e.gender}</span>{/if}
						{#if e.disambiguation}<span class="faint"> · {e.disambiguation}</span>{/if}
					</dd>
				{/if}
				{#if origin}
					<dt>From</dt>
					<dd>
						{origin}
						{#if e.areaName && e.beginAreaName && e.areaName !== e.beginAreaName}
							<span class="faint">· based in {e.areaName}</span>
						{/if}
					</dd>
				{/if}
				{#if life}
					<dt>{e.type === 'Person' ? 'Born' : 'Active'}</dt>
					<dd>{life}</dd>
				{/if}
				{#if extraGenres.length > 0}
					<dt>Also tagged</dt>
					<dd class="chips">
						{#each extraGenres as g (g)}<Chip>{g}</Chip>{/each}
					</dd>
				{/if}
				{#if e.ratingValue != null}
					<dt>Rating</dt>
					<dd>{e.ratingValue.toFixed(1)} / 5 <span class="faint">({num(e.ratingVotes)} votes)</span></dd>
				{/if}
			</dl>
		</section>
	{/if}

	{#if data.topPlayed.length > 0}
		<section class="card">
			<header class="cardhead">
				<div>
					<h2>Most listened</h2>
					<p class="faint sub">
						By hours played, across everything credited to them — saved or not{#if unsavedTop > 0}, and
							{unsavedTop} of these you never saved{/if}.
					</p>
				</div>
				<a class="more" href="/history">All listening →</a>
			</header>
			<div class="scroll-x">
				<table>
					<thead>
						<tr>
							<th class="idx">#</th><th>Track</th>
							<th class="r">Plays</th><th class="r">Listened</th><th class="r">Last</th>
						</tr>
					</thead>
					<tbody>
						{#each data.topPlayed as t, i (t.canonicalTrackId)}
							<tr>
								<td class="idx num faint">{i + 1}</td>
								<td>
									<div class="cell">
										<Cover src={t.cover} alt="{t.title} cover" size={32} />
										<div>
											<a href={trackHref(t.canonicalTrackId)}>{t.title}</a>
											{#if !t.inLibrary}
												<span class="faint xs" title="Played, but never saved"> · not saved</span>
											{/if}
										</div>
									</div>
								</td>
								<td class="r num">{num(t.plays)}</td>
								<td class="r num muted small">{longDuration(t.msPlayed)}</td>
								<td class="r muted small nowrap">{relativeTime(t.lastPlayedAt)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}

	<section class="card">
		<h2>Top tracks in your library</h2>
		<p class="faint sub">By peak Spotify popularity across every copy of the recording.</p>
		{#if data.topTracks.length === 0}
			<p class="faint">Nothing by this artist is in your library.</p>
		{:else}
			<div class="scroll-x">
				<table>
					<thead>
						<tr>
							<th class="idx">#</th><th>Track</th><th>Album</th>
							<th class="r">Length</th><th class="r">Pop.</th><th class="r">Added</th>
						</tr>
					</thead>
					<tbody>
						{#each data.topTracks as t, i (t.canonicalTrackId)}
							<tr>
								<td class="idx num faint">{i + 1}</td>
								<td>
									<div class="cell">
										<Cover src={t.cover} alt="{t.albumName ?? t.title} cover" size={32} />
										<div>
											<a href={trackHref(t.canonicalTrackId)}>{t.title}</a>
											{#if t.liked}<span class="heart" title="Liked">♥</span>{/if}
											{#if t.copyCount > 1}<span class="faint xs"> · {t.copyCount} copies</span>{/if}
										</div>
									</div>
								</td>
								<td class="muted small">
									{#if t.albumId}<a href="/album/{t.albumId}">{t.albumName}</a>{:else}—{/if}
								</td>
								<td class="r num muted">{trackTime(t.durationMs)}</td>
								<td class="r num">{t.popularity ?? '—'}</td>
								<td class="r muted small nowrap">{shortDate(t.firstAddedAt)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	{#each orderedGroups as [type, list] (type)}
		<section class="card">
			<h2>{LABELS[type] ?? type}</h2>
			<p class="faint sub">{num(list.length)} releases · newest first</p>
			<div class="grid">
				{#each list as a (a.id)}
					<a class="release" href="/album/{a.id}">
						<Cover src={a.cover} alt="{a.name} cover" size={132} />
						<div class="rname">{a.name}</div>
						<div class="faint xs">
							{a.releaseDate?.slice(0, 4) ?? '—'} · {num(a.totalTracks)} tracks
						</div>
						{#if a.libraryTracks > 0}
							<div class="have num xs">{a.libraryTracks}/{num(a.totalTracks)} in library</div>
						{/if}
					</a>
				{/each}
			</div>
		</section>
	{/each}
{/if}

<style>
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
	/* Phone: portrait and name side by side rather than stacked — a round 168px
	   photo above the title is all headroom and no information. */
	@media (max-width: 640px) {
		.hero {
			gap: 14px;
			align-items: center;
		}
		.hero :global(img),
		.hero :global(.placeholder) {
			max-width: 30vw;
			max-height: 30vw;
		}
		.meta {
			flex: 1 1 180px;
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
		font-size: 2.1rem;
		margin-bottom: 6px;
	}
	.small {
		font-size: 0.85rem;
		margin: 0;
	}
	.xs {
		font-size: 0.74rem;
	}
	.good {
		color: var(--good);
	}
	.chips {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		align-items: center;
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
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
		/* Under this the columns crush each other; the lane scrolls instead. */
		min-width: 620px;
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
	.heart {
		color: var(--accent-2);
		font-size: 0.8rem;
		margin-left: 4px;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
		gap: 16px;
	}
	@media (max-width: 640px) {
		.grid {
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 14px 10px;
		}
	}
	.release {
		display: block;
	}
	.release:hover .rname {
		color: #fff;
	}
	.rname {
		margin-top: 8px;
		font-size: 0.85rem;
		line-height: 1.3;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.have {
		color: #c4b5fd;
		margin-top: 2px;
	}
	a:hover {
		text-decoration: none;
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
