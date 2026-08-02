<!--
  Dev-only chart gallery. Renders every component in src/lib/charts against
  synthetic data, including the awkward cases (empty, single point, flat series,
  multi-year calendar) that are easy to break and hard to notice.
-->
<script lang="ts">
	import {
		AreaChart,
		BarList,
		BumpChart,
		CalendarHeatmap,
		CATEGORICAL,
		Donut,
		fmtCompact,
		fmtDuration,
		fmtInt,
		Histogram,
		Sparkline
	} from '$lib/charts';
	import {
		artistRanks,
		dailyPlays,
		durations,
		monthlyDiscoveries,
		monthlyPlays,
		monthlyTrend,
		playSources,
		releaseYears,
		sparkDiscoveries,
		sparkFlat,
		sparkPlays,
		sparkSingle,
		topArtists,
		topLabels
	} from './sample-data';

	const totalPlays = dailyPlays.reduce((t, d) => t + d.value, 0);

	const tiles = [
		{ label: 'Plays this year', value: fmtInt(11482), delta: '+18.4%', up: true, spark: sparkPlays },
		{
			label: 'New artists',
			value: fmtInt(214),
			delta: '+6.1%',
			up: true,
			spark: sparkDiscoveries,
			color: CATEGORICAL[1]
		},
		{
			label: 'Median track length',
			value: fmtDuration(208_000),
			delta: '−2.0%',
			up: false,
			spark: sparkFlat,
			color: CATEGORICAL[2]
		},
		{
			label: 'Saved albums',
			value: fmtInt(312),
			delta: 'first month',
			up: true,
			spark: sparkSingle,
			color: CATEGORICAL[3]
		}
	];
</script>

<svelte:head><title>Chart gallery · Spotidata</title></svelte:head>

<h1>Chart gallery</h1>
<p class="lede">
	Every component in <code>src/lib/charts</code>, on synthetic data.
	{fmtCompact(totalPlays)} plays across {fmtInt(dailyPlays.length)} days.
</p>

<section class="tiles">
	{#each tiles as t (t.label)}
		<div class="card tile">
			<div class="tile-label">{t.label}</div>
			<div class="tile-row">
				<div class="tile-value num">{t.value}</div>
				<Sparkline values={t.spark} color={t.color ?? CATEGORICAL[0]} width={88} height={30} />
			</div>
			<div class="tile-delta num" class:up={t.up} class:down={!t.up}>{t.delta}</div>
		</div>
	{/each}
</section>

<div class="grid">
	<div class="full">
		<CalendarHeatmap
			data={dailyPlays}
			weekStart="monday"
			title="Listening calendar"
			subtitle="Daily plays, Jan 2023 – Nov 2025. Five colour steps, broken toward the busy tail."
			unit="plays"
		/>
	</div>

	<div class="full">
		<BumpChart
			data={artistRanks}
			topN={8}
			title="Top artists by year"
			subtitle="Rank of the eight most-played artists, 2018–2025. Hover a line to isolate it."
			height={360}
			unit="plays"
		/>
	</div>

	<div class="full">
		<AreaChart
			series={[
				{ key: 'plays', label: 'Plays per month', points: monthlyPlays, render: 'bar' },
				{ key: 'trend', label: '3-month mean', points: monthlyTrend, render: 'area' }
			]}
			title="Monthly plays"
			subtitle="Bars are the raw month; the line is a 3-month trailing mean of the same measure — one axis, one unit."
			height={260}
			unit="plays"
		/>
	</div>







	<AreaChart
		series={[{ key: 'plays', label: 'Plays', points: monthlyPlays }]}
		cumulative
		title="Cumulative plays"
		subtitle="Running total since Jan 2023"
		height={240}
		unit="plays"
	/>

	<AreaChart
		series={[
			{ key: 'plays', label: 'Plays', points: monthlyPlays },
			{ key: 'new', label: 'First-time artists', points: monthlyDiscoveries }
		]}
		title="Plays vs first-time artists"
		subtitle="Both counts, so both share the axis"
		height={240}
		unit="plays"
	/>

	<Donut
		data={[{ label: 'Only source', value: 100 }]}
		title="Donut · single slice"
		subtitle="Degenerate case"
		height={250}
		unit="plays"
	/>

	<Histogram
		values={releaseYears}
		binCount={28}
		title="Release years"
		xLabel="release year"
		unit="tracks"
		xFormat={(n) => String(Math.round(n))}
		color={CATEGORICAL[0]}
	/>

	<Histogram
		values={durations}
		binCount={26}
		title="Track durations"
		xLabel="duration"
		unit="tracks"
		xFormat={(n) => fmtDuration(n * 1000)}
		color={CATEGORICAL[5]}
	/>

	<Donut
		data={playSources}
		maxSlices={5}
		title="Where plays start"
		subtitle="Play source, last 12 months"
		centerLabel="plays"
		height={250}
		unit="plays"
	/>

	<BarList
		data={topLabels}
		title="Top labels"
		subtitle="Share of all plays"
		limit={8}
		showRank={false}
		color={CATEGORICAL[4]}
		unit="plays"
	/>

	<BarList
		data={topArtists}
		title="Top artists"
		subtitle="All time, by play count"
		limit={8}
		showShare
		unit="plays"
	/>
</div>

<h2 class="section">Edge cases</h2>
<div class="grid">
	<AreaChart
		series={[{ key: 'x', label: 'Plays', points: [] }]}
		title="Area · no data"
		height={200}
	/>
	<AreaChart
		series={[{ key: 'x', label: 'Plays', points: [{ date: '2025-06', value: 412 }] }]}
		title="Area · single point"
		subtitle="One observation is a dot, never a line"
		height={200}
	/>
	<BarList data={[]} title="Bar list · no data" />
	<Histogram values={[]} title="Histogram · no data" height={200} />
	<div class="full">
		<CalendarHeatmap
			data={dailyPlays.filter((d) => d.day.startsWith('2024'))}
			title="Calendar · single year, week starts Sunday"
			subtitle="One row-block, no year labels"
			weekStart="sunday"
		/>
	</div>
	<div class="wide">
		<BumpChart
			data={artistRanks.filter((d) => d.period === 2025).slice(0, 4)}
			topN={4}
			title="Bump · single period"
			subtitle="No line to draw — dots and labels still land"
			height={220}
		/>
	</div>
</div>

<style>
	h1 {
		margin-bottom: 6px;
	}

	.lede {
		margin: 0 0 26px;
		color: var(--text-muted);
		font-size: 0.85rem;
		font-variant-numeric: tabular-nums;
	}

	code {
		font-family: var(--mono);
		font-size: 0.8em;
		color: var(--text);
	}

	.section {
		margin: 34px 0 16px;
		color: var(--text-muted);
		font-size: 0.9rem;
	}

	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
		gap: var(--gap);
		margin-bottom: var(--gap);
	}

	.tile {
		padding: var(--card-py) var(--card-px);
	}

	.tile-label {
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.tile-row {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 12px;
		margin-top: 6px;
	}

	.tile-value {
		font-size: 1.7rem;
		font-weight: 600;
		letter-spacing: -0.02em;
		line-height: 1.1;
		font-variant-numeric: tabular-nums;
	}

	.tile-delta {
		margin-top: 6px;
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
	}

	.tile-delta.up {
		color: var(--good);
	}

	.tile-delta.down {
		color: var(--text-muted);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
		gap: var(--gap);
		align-items: start;
	}

	.full {
		grid-column: 1 / -1;
	}

	.wide {
		grid-column: span 2;
	}

	@media (max-width: 760px) {
		.wide {
			grid-column: 1 / -1;
		}
	}
</style>
