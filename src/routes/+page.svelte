<script lang="ts">
	import {
		AreaChart,
		BarList,
		BumpChart,
		CalendarHeatmap,
		Histogram,
		CATEGORICAL
	} from '$lib/charts/index.ts';
	import StatTile from '$lib/components/StatTile.svelte';
	import RangePicker from '$lib/components/RangePicker.svelte';
	import { num, longDuration, pct, shortDate } from '$lib/utils/format.ts';

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

	const artistBars = $derived(
		data.artists.map((a) => ({
			label: a.name,
			value: a.tracks,
			sublabel: `${a.albums} album${a.albums === 1 ? '' : 's'}`
		}))
	);
	const albumPctBars = $derived(
		data.albumsByPct.map((a) => ({
			label: a.name,
			value: a.saved,
			secondary: a.pct,
			sublabel: `${a.artist ?? '—'} · ${a.saved}/${a.totalTracks}`
		}))
	);
	const albumSavedBars = $derived(
		data.albumsBySaved.map((a) => ({
			label: a.name,
			value: a.saved,
			secondary: a.pct,
			sublabel: `${a.artist ?? '—'} · ${a.totalTracks} tracks`
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
	<RangePicker />
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
		topN={6}
		subtitle="These artists ranked against each other by tracks added — hover a line to isolate it"
		unit="tracks"
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
		/>
	</section>
	<section class="card">
		<BarList
			data={albumSavedBars}
			title="Albums with the most saved tracks"
			subtitle="Absolute count"
			unit="tracks"
			limit={12}
		/>
	</section>
</div>

<div class="grid two">
	<section class="card">
		<BarList
			data={albumPctBars}
			title="Most complete albums"
			subtitle="Share of the album held, minimum 5 tracks"
			unit="tracks"
			limit={12}
		/>
	</section>
	<section class="card">
		<BarList data={labelBars} title="Top labels" unit="tracks" limit={10} color={CATEGORICAL[2]} />
	</section>
</div>

<div class="grid two">
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
	<section class="card">
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
</div>

<section class="card">
	<h2>Most duplicated recordings</h2>
	<p class="faint sub">One ISRC, many Spotify tracks — these collapse into a single recording.</p>
	<table>
		<thead>
			<tr><th>Recording</th><th>Artist</th><th class="r">Copies</th><th>Appears as</th></tr>
		</thead>
		<tbody>
			{#each data.duplicates as d (d.canonicalTrackId)}
				<tr>
					<td><a href="/track/{d.canonicalTrackId}">{d.title || '(untitled)'}</a></td>
					<td class="muted">{d.artist ?? '—'}</td>
					<td class="r num">{d.copies}</td>
					<td class="faint small">{(d.names ?? []).slice(0, 3).join(' · ')}</td>
				</tr>
			{/each}
		</tbody>
	</table>
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
	.grid.two {
		grid-template-columns: 1fr 1fr;
	}
	@media (max-width: 900px) {
		.grid.two {
			grid-template-columns: 1fr;
		}
	}
	.card {
		padding: 16px 18px;
	}
	.card.wide {
		margin-bottom: var(--gap);
		overflow-x: auto;
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
