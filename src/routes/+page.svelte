<script lang="ts">
	import {
		AreaChart,
		BarList,
		BumpChart,
		CalendarHeatmap,
		Histogram,
		CATEGORICAL
	} from '$lib/charts/index.ts';
	import ArtistLinks from '$lib/components/ArtistLinks.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import RangePicker from '$lib/components/RangePicker.svelte';
	import { num, longDuration, pct, relativeTime, shortDate } from '$lib/utils/format.ts';

	let { data } = $props();

	const t = $derived(data.totals);

	/** Histogram bins raw values, so bucket counts are expanded back out. */
	const expand = (rows: Array<{ bucket: number; count: number }>) =>
		rows.flatMap((r) => Array.from({ length: r.count }, () => r.bucket));

	const releaseValues = $derived(expand(data.releaseYears));
	const durationValues = $derived(expand(data.durations).map((s) => s / 60));

	const growthSeries = $derived([
		{
			key: 'added',
			label: 'Added per month',
			points: data.growth.map((g) => ({ date: `${g.period}-01`, value: g.added })),
			render: 'bar' as const
		}
	]);
	const cumulativeSeries = $derived([
		{
			key: 'total',
			label: 'Library size',
			points: data.growth.map((g) => ({ date: `${g.period}-01`, value: g.cumulative }))
		}
	]);
	const splitSeries = $derived([
		{
			key: 'new',
			label: 'New artist',
			points: data.split.map((s) => ({ date: `${s.period}-01`, value: s.newArtists }))
		},
		{
			key: 'existing',
			label: 'Artist already in library',
			points: data.split.map((s) => ({ date: `${s.period}-01`, value: s.existing }))
		}
	]);

	const monthlyTrend = $derived(data.growth.slice(-24).map((g) => g.added));

	// Every leaderboard row carries the id it came from, so a bar is a way into
	// the entity rather than a dead end. `image` present-but-null keeps the
	// artwork column aligned; labels omit the key and lose the column.
	const artistBars = $derived(
		data.artists.map((a) => ({
			label: a.name,
			value: a.tracks,
			sublabel: `${a.albums} album${a.albums === 1 ? '' : 's'}`,
			href: `/artist/${a.id}`,
			image: a.imageUrl,
			round: true
		}))
	);
	const albumPctBars = $derived(
		data.albumsByPct.map((a) => ({
			label: a.name,
			value: a.saved,
			secondary: a.pct,
			sublabel: `${a.artist ?? '—'} · ${a.saved}/${a.totalTracks}`,
			href: `/album/${a.id}`,
			image: a.imageUrl
		}))
	);
	const albumSavedBars = $derived(
		data.albumsBySaved.map((a) => ({
			label: a.name,
			value: a.saved,
			secondary: a.pct,
			sublabel: `${a.artist ?? '—'} · ${a.totalTracks} tracks`,
			href: `/album/${a.id}`,
			image: a.imageUrl
		}))
	);
	const playlistBars = $derived(
		data.playlists.map((p) => ({
			label: p.name,
			value: p.tracks,
			sublabel: `${p.isOwned ? 'yours' : 'followed'} · ${num(p.inLibrary)} in library`,
			href: `/playlist/${p.id}`,
			image: p.imageUrl
		}))
	);
	const labelBars = $derived(data.labels.map((l) => ({ label: l.label, value: l.tracks })));

	const lagSeries = $derived([
		{
			key: 'median',
			label: 'Median years between release and save',
			points: data.lag.map((l) => ({ date: `${l.year}-01-01`, value: l.medianDays / 365.25 }))
		}
	]);
</script>

<svelte:head><title>Spotidata</title></svelte:head>

<header class="head">
	<div>
		<h1>Library</h1>
		<p class="muted">{shortDate(t.firstAdded)} — {shortDate(t.lastAdded)}</p>
	</div>
	<RangePicker days={data.range.days} />
</header>

<section class="tiles">
	<StatTile
		label="Recordings"
		value={num(t.recordings)}
		sub="{num(t.copies)} tracks · {num(t.copies - t.recordings)} duplicates"
		accent={CATEGORICAL[0]}
		trend={monthlyTrend}
	/>
	<StatTile
		label="Library duration"
		value={longDuration(t.durationMs)}
		sub="one listen through"
		accent={CATEGORICAL[1]}
	/>
	<StatTile
		label="Artists"
		value={num(t.artists)}
		sub="{num(t.albums)} albums"
		accent={CATEGORICAL[2]}
	/>
	<StatTile
		label="Liked share"
		value={pct(t.likedShare, 0)}
		sub="rest from owned playlists"
		accent={CATEGORICAL[3]}
	/>
	<StatTile
		label="Longest streak"
		value="{data.streaks.longest} days"
		sub="{num(data.streaks.activeDays)} active days"
		accent={CATEGORICAL[4]}
	/>
	<StatTile
		label="Biggest day"
		value={num(data.streaks.busiestCount)}
		sub={shortDate(data.streaks.busiestDay)}
		accent={CATEGORICAL[5]}
	/>
	<!-- Reserved: needs streaming history, which is deliberately out of scope. -->
	<StatTile label="Total listen time" value="—" sub="needs streaming history" muted />
</section>

<section class="card wide">
	<CalendarHeatmap
		data={data.byDay}
		weekStart={data.weekStart}
		title="Additions"
		subtitle="Tracks added to the library per day"
		unit="tracks"
	/>
</section>

<section class="card recent">
	<header class="cardhead">
		<div>
			<h2>Latest additions</h2>
			<p class="faint sub">The newest recordings in this range</p>
		</div>
		<a class="more" href="/library">All tracks →</a>
	</header>
	<ul class="tiles-art">
		{#each data.recent as r (r.canonicalTrackId)}
			<li>
				<a class="art" href="/track/{r.canonicalTrackId}" aria-label={r.title}>
					<Cover src={r.cover} alt="{r.albumName ?? r.title} cover" size="fill" />
				</a>
				<a class="title" href="/track/{r.canonicalTrackId}" title={r.title}>
					{r.title || '(untitled)'}
				</a>
				<span class="by muted">
					<ArtistLinks artists={r.artists} />
				</span>
				<span class="faint when">
					{relativeTime(r.addedAt)}{#if r.liked} · liked{/if}
				</span>
			</li>
		{:else}
			<li class="faint">Nothing added in this range.</li>
		{/each}
	</ul>
</section>

<div class="grid two">
	<section class="card">
		<AreaChart
			series={cumulativeSeries}
			title="Library growth"
			subtitle="Cumulative recordings"
			unit="recordings"
		/>
	</section>
	<section class="card">
		<AreaChart series={growthSeries} title="Added per month" unit="recordings" />
	</section>
</div>

<section class="card wide">
	<BumpChart
		data={data.bump}
		title="Top artists by year"
		topN={10}
		height={430}
		subtitle="The ten artists you added most of each year — most place in a single year, and a line breaks over the years it missed the top ten"
		unit="added that year"
		deltaLabel="vs the year before"
	/>
</section>

<div class="grid two">
	<section class="card">
		<AreaChart
			series={splitSeries}
			title="Breadth vs depth"
			subtitle="Adds for a brand-new artist against one already in the library"
			unit="recordings"
		/>
	</section>
	<section class="card">
		<AreaChart
			series={lagSeries}
			title="Discovery lag"
			subtitle="Median years between a track's release and saving it"
			unit="years"
			valueFormat={(n: number) => `${n.toFixed(1)}y`}
		/>
	</section>
</div>

<div class="grid two">
	<section class="card">
		<BarList
			data={artistBars}
			title="Top artists"
			subtitle="By distinct recordings in the library"
			unit="tracks"
			limit={15}
		>
			{#snippet actions()}<a class="more" href="/artists">All artists →</a>{/snippet}
		</BarList>
	</section>
	<section class="card">
		<BarList
			data={playlistBars}
			title="Biggest playlists"
			subtitle="Items added in this range — the ones you own are what define the library"
			unit="tracks"
			limit={10}
			color={CATEGORICAL[1]}
		>
			{#snippet actions()}<a class="more" href="/playlists">All playlists →</a>{/snippet}
		</BarList>
	</section>
</div>

<div class="grid two">
	<section class="card">
		<BarList
			data={albumSavedBars}
			title="Albums with the most saved tracks"
			subtitle="Absolute count"
			unit="tracks"
			limit={12}
		>
			{#snippet actions()}<a class="more" href="/albums">All albums →</a>{/snippet}
		</BarList>
	</section>
	<section class="card">
		<BarList
			data={albumPctBars}
			title="Most complete albums"
			subtitle="Share of the album held, minimum 5 tracks"
			unit="tracks"
			limit={12}
		/>
	</section>
</div>

<div class="grid two">
	<section class="card">
		<BarList data={labelBars} title="Top labels" unit="tracks" limit={10} color={CATEGORICAL[2]} />
	</section>
	<section class="card">
		<Histogram
			values={releaseValues}
			title="Release years"
			subtitle="When the music you collect came out"
			xLabel="year"
			unit="recordings"
			binCount={40}
			xFormat={(n: number) => String(Math.round(n))}
		/>
	</section>
</div>

<section class="card wide">
	<Histogram
		values={durationValues}
		title="Track lengths"
		xLabel="minutes"
		unit="recordings"
		binCount={30}
		color={CATEGORICAL[3]}
		xFormat={(n: number) => `${n.toFixed(0)}m`}
	/>
</section>

<section class="card">
	<h2>Most duplicated recordings</h2>
	<p class="faint sub">One ISRC, many Spotify tracks — these collapse into a single recording.</p>
	<div class="scroll-x">
		<table>
			<thead>
				<tr><th>Recording</th><th>Artist</th><th class="r">Copies</th><th>Appears as</th></tr>
			</thead>
			<tbody>
				{#each data.duplicates as d (d.canonicalTrackId)}
					<tr>
						<td>
							<a class="rec" href="/track/{d.canonicalTrackId}">
								<Cover src={d.cover} alt="{d.title} cover" size={30} />
								<span class="ellipsis">{d.title || '(untitled)'}</span>
							</a>
						</td>
						<td class="muted">
							{#if d.artistId}<a href="/artist/{d.artistId}">{d.artist}</a>{:else}{d.artist ??
									'—'}{/if}
						</td>
						<td class="r num">{d.copies}</td>
						<td class="faint small">{(d.names ?? []).slice(0, 3).join(' · ')}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
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
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(168px, 1fr));
		gap: var(--gap);
		margin-bottom: var(--gap);
	}
	.grid {
		display: grid;
		gap: var(--gap);
		margin-bottom: var(--gap);
	}
	/* A grid track's auto minimum is its item's min-content, and a bar list's
	   sublabels are nowrap — without this the column grows past the viewport
	   and takes the whole page sideways with it. */
	.grid > :global(*) {
		min-width: 0;
	}
	.grid.two {
		grid-template-columns: 1fr 1fr;
	}
	@media (max-width: 900px) {
		.grid.two {
			grid-template-columns: 1fr;
		}
	}
	/* Two tiles across is the floor: one per row turns the header into a
	   half-screen of scrolling before the first chart. */
	@media (max-width: 640px) {
		.tiles {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 10px;
		}
	}
	.card {
		padding: var(--card-py) var(--card-px);
	}
	.card.wide {
		margin-bottom: var(--gap);
	}
	/* A chart draws its own card. On a phone the section wrapped around it is a
	   second border and 28px of gutter spent framing a frame — 7% of the screen
	   for nothing. It stays on wider viewports, where the inset reads as
	   deliberate rather than as lost width. */
	@media (max-width: 640px) {
		.card:has(> :global(.chart-frame)) {
			padding: 0;
			border: 0;
			background: none;
			box-shadow: none;
		}
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
	.cardhead .sub {
		margin-bottom: 14px;
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
	.tiles-art {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		/* Six across on a full-width card, three on a phone. */
		grid-template-columns: repeat(auto-fill, minmax(124px, 1fr));
		gap: 16px 14px;
	}
	@media (max-width: 640px) {
		.tiles-art {
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 14px 10px;
		}
	}
	.tiles-art li {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.tiles-art .art {
		display: block;
		margin-bottom: 6px;
	}
	.tiles-art .art:hover {
		filter: brightness(1.1);
	}
	.title,
	.by,
	.when {
		font-size: 0.8rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.by,
	.when {
		font-size: 0.74rem;
	}
	a.title:hover {
		text-decoration: underline;
	}
	.rec {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}
	.rec:hover .ellipsis {
		text-decoration: underline;
	}
	.ellipsis {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
		/* Below this the title and the alias list crush each other; the lane
		   scrolls instead. No effect anywhere the card is already wider. */
		min-width: 520px;
	}
	th {
		text-align: left;
		font-weight: 500;
		color: var(--text-muted);
		font-size: 0.76rem;
		padding-bottom: 8px;
		border-bottom: 1px solid var(--hairline);
	}
	td {
		padding: 7px 0;
		border-bottom: 1px solid rgba(255, 255, 255, 0.03);
	}
	th.r,
	td.r {
		text-align: right;
	}
	.small {
		font-size: 0.78rem;
	}
</style>
