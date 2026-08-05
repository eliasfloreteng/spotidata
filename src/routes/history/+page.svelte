<script lang="ts">
	import {
		AreaChart,
		BarList,
		BumpChart,
		CalendarHeatmap,
		Donut,
		CATEGORICAL
	} from '$lib/charts/index.ts';
	import Cover from '$lib/components/Cover.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import RangePicker from '$lib/components/RangePicker.svelte';
	import { num, longDuration, pct, relativeTime, shortDate, streamTime } from '$lib/utils/format.ts';

	let { data } = $props();

	const t = $derived(data.totals);

	const hours = (ms: number) => ms / 3600000;

	/** The export's own vocabulary for why a stream stopped, spelled out. */
	const END_LABELS: Record<string, string> = {
		trackdone: 'Played to the end',
		fwdbtn: 'Skipped forward',
		backbtn: 'Skipped back',
		endplay: 'Stopped',
		logout: 'Signed out',
		remote: 'Handed to another device',
		'unexpected-exit': 'App closed',
		'unexpected-exit-while-paused': 'App closed while paused',
		clickrow: 'Something else was picked',
		trackerror: 'Playback error',
		unknown: 'Unknown'
	};

	/** Hours per day of the window — the number that makes six years legible. */
	const perActiveDay = $derived(
		t.activeDays > 0 ? t.msPlayed / t.activeDays / 3600000 : 0
	);

	const minutesSeries = $derived([
		{
			key: 'library',
			label: 'From your library',
			points: data.byMonth.map((m) => ({ date: `${m.period}-01`, value: m.libraryMinutes })),
			render: 'bar' as const
		},
		{
			key: 'outside',
			label: 'Everything else',
			points: data.byMonth.map((m) => ({
				date: `${m.period}-01`,
				value: Math.max(0, m.minutes - m.libraryMinutes)
			})),
			render: 'bar' as const
		}
	]);

	const discoverySeries = $derived([
		{
			key: 'first',
			label: 'Heard for the first time',
			points: data.discovery.map((d) => ({ date: `${d.period}-01`, value: d.firstTime }))
		},
		{
			key: 'again',
			label: 'Heard before',
			points: data.discovery.map((d) => ({ date: `${d.period}-01`, value: d.revisited }))
		}
	]);

	const trend = $derived(data.byMonth.slice(-24).map((m) => m.minutes));

	const trackBars = $derived(
		data.tracks.map((r) => ({
			label: r.title || '(untitled)',
			value: Math.round(hours(r.msPlayed) * 10) / 10,
			secondary: r.plays,
			sublabel: `${r.artists.map((a) => a.name).join(', ') || '—'} · ${num(r.plays)} plays`,
			href: `/track/${r.canonicalTrackId}`,
			image: r.cover
		}))
	);
	const neverSavedBars = $derived(
		data.neverSaved.map((r) => ({
			label: r.title || '(untitled)',
			value: Math.round(hours(r.msPlayed) * 10) / 10,
			sublabel: `${r.artists.map((a) => a.name).join(', ') || '—'} · last ${relativeTime(r.lastPlayedAt)}`,
			href: `/track/${r.canonicalTrackId}`,
			image: r.cover
		}))
	);
	const artistBars = $derived(
		data.artists.map((a) => ({
			label: a.name,
			value: Math.round(hours(a.msPlayed) * 10) / 10,
			sublabel: `${num(a.plays)} plays · ${num(a.recordings)} recordings`,
			href: `/artist/${a.id}`,
			image: a.imageUrl,
			round: true
		}))
	);
	const albumBars = $derived(
		data.albums.map((a) => ({
			label: a.name,
			value: Math.round(hours(a.msPlayed) * 10) / 10,
			sublabel: `${a.artist ?? '—'} · ${num(a.plays)} plays`,
			href: `/album/${a.id}`,
			image: a.imageUrl
		}))
	);
	const endBars = $derived(
		data.ends.map((e) => ({ label: END_LABELS[e.label] ?? e.label, value: e.value }))
	);

	const resolvedShare = $derived(
		data.coverage.plays > 0 ? data.coverage.resolved / data.coverage.plays : 1
	);
</script>

<svelte:head><title>Listening · Spotidata</title></svelte:head>

<header class="head">
	<div>
		<h1>Listening</h1>
		<p class="muted">
			{#if t.plays > 0}
				{shortDate(t.firstPlayed)} — {shortDate(t.lastPlayed)}
			{:else}
				No plays in this range
			{/if}
		</p>
	</div>
	<div class="headright">
		<a class="chip" href="/history/log">The log →</a>
		<a class="chip" href="/history/import">Import</a>
		<RangePicker days={data.range.days} />
	</div>
</header>

{#if data.coverage.plays === 0}
	<section class="card empty">
		<h2>No listening history yet</h2>
		<p class="muted">
			Spotify's API only ever serves the last 50 plays, so the years before that have to come
			from the <strong>Extended streaming history</strong> download — request it from Spotify's
			privacy page and it arrives in about a month.
		</p>
		<p><a class="btn" href="/history/import">Import an export →</a></p>
	</section>
{:else}
	<section class="tiles">
		<StatTile
			label="Listening time"
			value={longDuration(t.msPlayed)}
			sub="{num(t.plays)} streams"
			accent={CATEGORICAL[0]}
			{trend}
		/>
		<StatTile
			label="Per active day"
			value="{perActiveDay.toFixed(1)} h"
			sub="{num(t.activeDays)} of {num(t.spanDays)} days"
			accent={CATEGORICAL[1]}
		/>
		<StatTile
			label="Recordings"
			value={num(t.recordings)}
			sub="{num(t.artists)} artists"
			accent={CATEGORICAL[2]}
		/>
		<StatTile
			label="From your library"
			value={pct(t.plays > 0 ? t.inLibraryPlays / t.plays : null, 0)}
			sub="the rest was never saved"
			accent={CATEGORICAL[3]}
		/>
		<StatTile
			label="Played to the end"
			value={pct(t.plays > 0 ? t.completed / t.plays : null, 0)}
			sub="{num(t.skipped)} cut short"
			accent={CATEGORICAL[4]}
		/>
		<StatTile
			label="Longest streak"
			value="{data.streaks.longest} days"
			sub={data.streaks.longestEnd ? `to ${shortDate(data.streaks.longestEnd)}` : '—'}
			accent={CATEGORICAL[5]}
		/>
		<StatTile
			label="Biggest day"
			value={longDuration(data.streaks.busiestMinutes * 60000)}
			sub={shortDate(data.streaks.busiestDay)}
			accent={CATEGORICAL[6]}
		/>
	</section>

	{#if resolvedShare < 0.995}
		<p class="note">
			{pct(resolvedShare, 1)} of these plays name a track the catalog knows.
			{#if data.coverage.pending > 0}
				{num(data.coverage.pending)} are waiting on the next sync to be looked up;
			{/if}
			until then they count toward the totals above but not toward any per-artist or
			per-recording figure. <a href="/history/import">Details →</a>
		</p>
	{/if}

	<section class="card wide">
		<CalendarHeatmap
			data={data.byDay}
			weekStart={data.weekStart}
			title="Listening"
			subtitle="Minutes played per day"
			unit="minutes"
		/>
	</section>

	<section class="card wide">
		<AreaChart
			series={minutesSeries}
			title="Minutes per month"
			subtitle="Split by whether the recording is one your library holds"
			unit="minutes"
			height={280}
		/>
	</section>

	<section class="card wide">
		<BumpChart
			data={data.bump}
			title="Top artists by year"
			topN={10}
			height={430}
			subtitle="The ten artists you spent the most hours on each year, ranked on that year alone — a line breaks over the years an artist missed the top ten"
			unit="hours"
			deltaLabel="vs the year before"
		/>
	</section>

	<div class="grid two">
		<section class="card">
			<BarList
				data={artistBars}
				title="Most listened artists"
				subtitle="Hours played, every credit counted"
				unit="hours"
				limit={15}
				valueFormat={(n: number) => `${n.toFixed(1)}h`}
			>
				{#snippet actions()}<a class="more" href="/artists">All artists →</a>{/snippet}
			</BarList>
		</section>
		<section class="card">
			<BarList
				data={trackBars}
				title="Most listened recordings"
				subtitle="Hours played"
				unit="hours"
				limit={15}
				color={CATEGORICAL[1]}
				valueFormat={(n: number) => `${n.toFixed(1)}h`}
			/>
		</section>
	</div>

	<div class="grid two">
		<section class="card">
			<BarList
				data={albumBars}
				title="Most listened albums"
				subtitle="Singles excluded — a single is an album of one by definition"
				unit="hours"
				limit={12}
				color={CATEGORICAL[2]}
				valueFormat={(n: number) => `${n.toFixed(1)}h`}
			/>
		</section>
		<section class="card">
			<BarList
				data={neverSavedBars}
				title="Played, never saved"
				subtitle="The listening your library has no record of at all"
				unit="hours"
				limit={12}
				color={CATEGORICAL[3]}
				valueFormat={(n: number) => `${n.toFixed(1)}h`}
			/>
		</section>
	</div>

	<div class="grid two">
		<section class="card">
			<AreaChart
				series={discoverySeries}
				title="Discovery vs repetition"
				subtitle="Plays of a recording heard for the first time, against one already known"
				unit="plays"
			/>
		</section>
		<section class="card">
			<Donut
				data={data.devices}
				title="Where you listen"
				subtitle="Minutes by device"
				unit="minutes"
				centerValue={longDuration(t.msPlayed)}
				centerLabel="total"
			/>
		</section>
	</div>

	<div class="grid two">
		<section class="card">
			<BarList
				data={endBars}
				title="How streams end"
				subtitle="Spotify records why playback stopped"
				unit="streams"
				limit={8}
				color={CATEGORICAL[4]}
			/>
		</section>
		<section class="card">
			<Donut
				data={data.countries}
				title="Where in the world"
				subtitle="Minutes by the country the client connected from"
				unit="minutes"
				centerValue={String(data.countries.length)}
				centerLabel={data.countries.length === 1 ? 'country' : 'countries'}
			/>
		</section>
	</div>

	<section class="card">
		<header class="cardhead">
			<div>
				<h2>The last 25 plays</h2>
				<p class="faint sub">Newest first, straight from the log.</p>
			</div>
			<a class="more" href="/history/log">Full log →</a>
		</header>
		<div class="scroll-x">
			<table>
				<thead>
					<tr>
						<th>Played</th><th>Track</th><th>Artist</th><th class="r">Listened</th><th>Ended</th>
					</tr>
				</thead>
				<tbody>
					{#each data.recent as p (p.id)}
						<tr>
							<td class="faint small nowrap" title={p.playedAt}>{relativeTime(p.playedAt)}</td>
							<td>
								{#if p.canonicalTrackId}
									<a class="rec" href="/track/{p.canonicalTrackId}">
										<Cover src={p.cover} alt="{p.title} cover" size={28} />
										<span class="ellipsis">{p.title}</span>
									</a>
								{:else}
									<span class="rec">
										<Cover src={null} alt="" size={28} />
										<span class="ellipsis" title="Not in the catalog">{p.title}</span>
									</span>
								{/if}
							</td>
							<td class="muted ellipsis">
								{#if p.artistId}<a href="/artist/{p.artistId}">{p.artist}</a>{:else}{p.artist ??
										'—'}{/if}
							</td>
							<td
								class="r num"
								title={p.estimated ? 'Estimated from the gap to the previous play' : ''}
							>
								{streamTime(p.msPlayed, p.estimated)}
							</td>
							<td class="faint small">{END_LABELS[p.reasonEnd ?? ''] ?? p.reasonEnd ?? '—'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
{/if}

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
	.headright {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.chip {
		padding: 6px 13px;
		border-radius: 999px;
		border: 1px solid var(--hairline);
		font-size: 0.82rem;
		color: var(--text-muted);
	}
	.chip:hover {
		color: var(--text);
		border-color: var(--hairline-strong);
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
	.note {
		margin: 0 0 var(--gap);
		padding: 10px 14px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--hairline);
		background: var(--card);
		font-size: 0.83rem;
		color: var(--text-muted);
	}
	.note a {
		text-decoration: underline;
	}
	.grid {
		display: grid;
		gap: var(--gap);
		margin-bottom: var(--gap);
	}
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
	.card {
		padding: var(--card-py) var(--card-px);
	}
	.card.wide {
		margin-bottom: var(--gap);
	}
	@media (max-width: 640px) {
		.card:has(> :global(.chart-frame)) {
			padding: 0;
			border: 0;
			background: none;
			box-shadow: none;
		}
	}
	.empty {
		text-align: center;
		padding: 44px 24px;
	}
	.empty p {
		max-width: 58ch;
		margin: 10px auto 0;
		font-size: 0.9rem;
	}
	.btn {
		display: inline-block;
		margin-top: 14px;
		padding: 9px 18px;
		border-radius: 999px;
		background: var(--accent-soft);
		color: #ddd6fe;
		font-size: 0.88rem;
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
	.rec {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}
	a.rec:hover .ellipsis {
		text-decoration: underline;
	}
	.ellipsis {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 34ch;
	}
	.nowrap {
		white-space: nowrap;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
		min-width: 620px;
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
