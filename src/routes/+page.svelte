<script lang="ts">
	import {
		AreaChart,
		BarList,
		BumpChart,
		CalendarHeatmap,
		Donut,
		Histogram,
		CATEGORICAL
	} from '$lib/charts/index.ts';
	import ArtistLinks from '$lib/components/ArtistLinks.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import RangePicker from '$lib/components/RangePicker.svelte';
	import SavedVsHeard from '$lib/components/SavedVsHeard.svelte';
	import Segmented from '$lib/components/Segmented.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import { num, longDuration, pct, relativeTime, shortDate, streamTime } from '$lib/utils/format.ts';

	let { data } = $props();

	const lib = $derived(data.library);
	const t = $derived(data.listening);

	/**
	 * Before an export is imported there is nothing to switch to, so every card
	 * that can show either half opens on the saving side.
	 */
	const hasPlays = $derived(data.coverage.plays > 0);

	type Side = 'played' | 'saved';
	const SIDES = [
		{ key: 'played', label: 'Listened' },
		{ key: 'saved', label: 'Saved' }
	] as const;

	// Seeded once from whether there is any listening; from then on the toggles
	// are the reader's.
	const initial: Side = (() => (data.coverage.plays > 0 ? 'played' : 'saved'))();
	let calendarSide = $state<Side>(initial);
	let bumpSide = $state<Side>(initial);
	let artistSide = $state<Side>(initial);
	let monthView = $state<'played' | 'saved' | 'size'>(initial);
	let trackView = $state<'all' | 'unsaved'>('all');
	let albumView = $state<'played' | 'saved' | 'complete'>(initial);
	let shelfView = $state<'labels' | 'playlists'>('labels');
	let discoveryView = $state<'plays' | 'saves' | 'lag'>(initial === 'played' ? 'plays' : 'saves');
	let spreadView = $state<'years' | 'lengths'>('years');
	let whereView = $state<'devices' | 'countries'>('devices');
	let recentSide = $state<Side>(initial);

	const hours = (ms: number) => Math.round((ms / 3600000) * 10) / 10;
	const fmtHours = (n: number) => `${n.toFixed(1)}h`;

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

	// ------------------------------------------------------------ the header

	/** The span the data actually covers: first save or play to the last. */
	const firstSeen = $derived(
		[lib.firstAdded, t.firstPlayed].filter((d): d is string => !!d).sort()[0] ?? null
	);
	const lastSeen = $derived(
		[lib.lastAdded, t.lastPlayed].filter((d): d is string => !!d).sort().at(-1) ?? null
	);

	const perActiveDay = $derived(t.activeDays > 0 ? t.msPlayed / t.activeDays / 3600000 : 0);
	const resolvedShare = $derived(
		data.coverage.plays > 0 ? data.coverage.resolved / data.coverage.plays : 1
	);

	// ----------------------------------------------------------- over time

	const month = (period: string) => `${period}-01`;
	const monthSeries = $derived(
		monthView === 'played'
			? [
					{
						key: 'library',
						label: 'From your library',
						points: data.byMonth.map((m) => ({ date: month(m.period), value: m.libraryMinutes })),
						render: 'bar' as const
					},
					{
						key: 'outside',
						label: 'Everything else',
						points: data.byMonth.map((m) => ({
							date: month(m.period),
							value: Math.max(0, m.minutes - m.libraryMinutes)
						})),
						render: 'bar' as const
					}
				]
			: monthView === 'saved'
				? [
						{
							key: 'added',
							label: 'Added per month',
							points: data.growth.map((g) => ({ date: month(g.period), value: g.added })),
							render: 'bar' as const
						}
					]
				: [
						{
							key: 'total',
							label: 'Library size',
							points: data.growth.map((g) => ({ date: month(g.period), value: g.cumulative }))
						}
					]
	);

	const discoverySeries = $derived(
		discoveryView === 'plays'
			? [
					{
						key: 'first',
						label: 'Heard for the first time',
						points: data.discovery.map((d) => ({ date: month(d.period), value: d.firstTime }))
					},
					{
						key: 'again',
						label: 'Heard before',
						points: data.discovery.map((d) => ({ date: month(d.period), value: d.revisited }))
					}
				]
			: discoveryView === 'saves'
				? [
						{
							key: 'new',
							label: 'New artist',
							points: data.split.map((s) => ({ date: month(s.period), value: s.newArtists }))
						},
						{
							key: 'existing',
							label: 'Artist already in library',
							points: data.split.map((s) => ({ date: month(s.period), value: s.existing }))
						}
					]
				: [
						{
							key: 'median',
							label: 'Median years between release and save',
							points: data.lag.map((l) => ({
								date: `${l.year}-01-01`,
								value: l.medianDays / 365.25
							}))
						}
					]
	);

	// --------------------------------------------------------- leaderboards

	const artistBars = $derived(
		artistSide === 'played'
			? data.artistsPlayed.map((a) => ({
					label: a.name,
					value: hours(a.msPlayed),
					sublabel: `${num(a.plays)} plays · ${num(a.recordings)} recordings`,
					href: `/artist/${a.id}`,
					image: a.imageUrl,
					round: true
				}))
			: data.artistsSaved.map((a) => ({
					label: a.name,
					value: a.tracks,
					sublabel: `${a.albums} album${a.albums === 1 ? '' : 's'}`,
					href: `/artist/${a.id}`,
					image: a.imageUrl,
					round: true
				}))
	);

	const trackBars = $derived(
		(trackView === 'all' ? data.tracksPlayed : data.tracksUnsaved).map((r) => ({
			label: r.title || '(untitled)',
			value: hours(r.msPlayed),
			sublabel:
				`${r.artists.map((a) => a.name).join(', ') || '—'} · ` +
				(trackView === 'all'
					? `${num(r.plays)} plays${r.inLibrary ? '' : ' · not saved'}`
					: `last ${relativeTime(r.lastPlayedAt)}`),
			href: `/track/${r.canonicalTrackId}`,
			image: r.cover
		}))
	);

	const albumBars = $derived(
		albumView === 'played'
			? data.albumsPlayed.map((a) => ({
					label: a.name,
					value: hours(a.msPlayed),
					sublabel: `${a.artist ?? '—'} · ${num(a.plays)} plays`,
					href: `/album/${a.id}`,
					image: a.imageUrl
				}))
			: (albumView === 'saved' ? data.albumsBySaved : data.albumsByPct).map((a) => ({
					label: a.name,
					value: a.saved,
					secondary: a.pct,
					sublabel: `${a.artist ?? '—'} · ${a.saved}/${a.totalTracks}`,
					href: `/album/${a.id}`,
					image: a.imageUrl
				}))
	);

	const shelfBars = $derived(
		shelfView === 'labels'
			? data.labels.map((l) => ({ label: l.label, value: l.tracks }))
			: data.playlists.map((p) => ({
					label: p.name,
					value: p.tracks,
					sublabel: `${p.isOwned ? 'yours' : 'followed'} · ${num(p.inLibrary)} in library`,
					href: `/playlist/${p.id}`,
					image: p.imageUrl
				}))
	);

	const endBars = $derived(
		data.ends.map((e) => ({ label: END_LABELS[e.label] ?? e.label, value: e.value }))
	);

	// --------------------------------------------------------- distributions

	/** Histogram bins raw values, so bucket counts are expanded back out. */
	const expand = (rows: Array<{ bucket: number; count: number }>) =>
		rows.flatMap((r) => Array.from({ length: r.count }, () => r.bucket));
	const releaseValues = $derived(expand(data.releaseYears));
	const lengthValues = $derived(expand(data.durations).map((s) => s / 60));
</script>

<svelte:head><title>Spotidata</title></svelte:head>

<header class="head">
	<div>
		<h1>Overview</h1>
		<p class="muted">
			{#if firstSeen}{shortDate(firstSeen)} — {shortDate(lastSeen)}{:else}Nothing in this range{/if}
		</p>
	</div>
	<div class="headright">
		<a class="chip" href="/history/log">The log →</a>
		<a class="chip" href="/history/import">Import</a>
		<RangePicker days={data.range.days} />
	</div>
</header>

<section class="tiles">
	<StatTile
		label="Listened"
		value={hasPlays ? longDuration(t.msPlayed) : '—'}
		sub={hasPlays
			? `${num(t.plays)} streams · ${perActiveDay.toFixed(1)} h per active day`
			: 'import your streaming history'}
		accent={CATEGORICAL[0]}
		trend={data.byMonth.slice(-24).map((m) => m.minutes)}
		muted={!hasPlays}
	/>
	<StatTile
		label="Saved"
		value={num(lib.recordings)}
		sub="{num(lib.artists)} artists · {num(lib.albums)} albums · {pct(lib.likedShare, 0)} liked"
		accent={CATEGORICAL[1]}
		trend={data.growth.slice(-24).map((g) => g.added)}
	/>
	<StatTile
		label="Heard"
		value={num(t.recordings)}
		sub="{num(t.artists)} artists · {pct(t.msPlayed > 0 ? t.libraryMs / t.msPlayed : null, 0)} of the time on saved music"
		accent={CATEGORICAL[2]}
		muted={!hasPlays}
	/>
	<StatTile
		label="Play-through"
		value={longDuration(lib.durationMs)}
		sub="everything saved, once · {num(lib.copies - lib.recordings)} duplicates folded"
		accent={CATEGORICAL[3]}
	/>
	<StatTile
		label="Played to the end"
		value={pct(t.plays > 0 ? t.completed / t.plays : null, 0)}
		sub="{num(t.skipped)} cut short"
		accent={CATEGORICAL[4]}
		muted={!hasPlays}
	/>
	<StatTile
		label="Longest streak"
		value="{hasPlays ? data.listenStreaks.longest : data.saveStreaks.longest} days"
		sub={hasPlays
			? `of listening, on ${num(t.activeDays)} of ${num(t.spanDays)} days · ${data.saveStreaks.longest} of saving`
			: `saving · ${num(data.saveStreaks.activeDays)} active days`}
		accent={CATEGORICAL[5]}
	/>
	<StatTile
		label="Biggest day"
		value={hasPlays
			? longDuration(data.listenStreaks.busiestMinutes * 60000)
			: `${num(data.saveStreaks.busiestCount)} saved`}
		sub={hasPlays
			? `listened ${shortDate(data.listenStreaks.busiestDay)} · ${num(data.saveStreaks.busiestCount)} saved ${shortDate(data.saveStreaks.busiestDay)}`
			: shortDate(data.saveStreaks.busiestDay)}
		accent={CATEGORICAL[6]}
	/>
	<StatTile
		label="Downloaded"
		value={lib.recordings > 0 ? pct(lib.downloaded / lib.recordings, 0) : '—'}
		sub="{num(lib.downloaded)} of {num(lib.recordings)} as files, for the DJ stick"
		accent={CATEGORICAL[7]}
		muted={lib.downloaded === 0}
	/>
</section>

{#if !hasPlays}
	<p class="note">
		No listening history yet. Spotify's API only ever serves the last 50 plays, so the years before
		that come from the <strong>Extended streaming history</strong> download.
		<a href="/history/import">Import an export →</a>
	</p>
{:else if resolvedShare < 0.995}
	<p class="note">
		{pct(resolvedShare, 1)} of the plays name a track the catalog knows.
		{#if data.coverage.pending > 0}
			{num(data.coverage.pending)} are waiting on the next sync to be looked up;
		{/if}
		until then they count toward the listening totals but not toward any per-artist or
		per-recording figure. <a href="/history/import">Details →</a>
	</p>
{/if}

<SavedVsHeard
	{...data.meet}
	unsavedRecordings={Math.max(0, t.recordings - t.libraryRecordings)}
	unsavedMs={Math.max(0, t.msPlayed - t.libraryMs)}
/>

{#snippet sides(label: string, get: () => Side, set: (v: Side) => void)}
	{#if hasPlays}
		<Segmented options={SIDES} bind:value={get, set} {label} />
	{/if}
{/snippet}

<section class="card wide">
	<CalendarHeatmap
		data={calendarSide === 'played' ? data.minutesByDay : data.addsByDay}
		weekStart={data.weekStart}
		title="Every day"
		subtitle={calendarSide === 'played' ? 'Minutes played per day' : 'Recordings saved per day'}
		unit={calendarSide === 'played' ? 'minutes' : 'recordings'}
	>
		{#snippet actions()}
			{@render sides('Calendar measure', () => calendarSide, (v) => (calendarSide = v))}
		{/snippet}
	</CalendarHeatmap>
</section>

<section class="card wide">
	<AreaChart
		series={monthSeries}
		title="Every month"
		subtitle={monthView === 'played'
			? 'Minutes played, split by whether your library holds the recording'
			: monthView === 'saved'
				? 'Recordings saved'
				: 'Recordings in the library, cumulative'}
		unit={monthView === 'played' ? 'minutes' : 'recordings'}
		height={260}
	>
		{#snippet actions()}
			<Segmented
				options={hasPlays
					? [
							{ key: 'played', label: 'Listened' },
							{ key: 'saved', label: 'Saved' },
							{ key: 'size', label: 'Library size' }
						]
					: [
							{ key: 'saved', label: 'Saved' },
							{ key: 'size', label: 'Library size' }
						]}
				bind:value={monthView}
				label="Monthly measure"
			/>
		{/snippet}
	</AreaChart>
</section>

<section class="card wide">
	<BumpChart
		data={bumpSide === 'played' ? data.bumpPlayed : data.bumpSaved}
		title="Top artists by year"
		topN={10}
		height={430}
		subtitle={bumpSide === 'played'
			? 'The ten artists you spent the most hours on each year, ranked on that year alone; a line breaks over the years an artist missed the top ten'
			: 'The ten artists you saved the most of each year; a line breaks over the years an artist missed the top ten'}
		unit={bumpSide === 'played' ? 'hours' : 'saved that year'}
		deltaLabel="vs the year before"
	>
		{#snippet actions()}
			{@render sides('Rank by', () => bumpSide, (v) => (bumpSide = v))}
		{/snippet}
	</BumpChart>
</section>

<div class="grid two">
	<section class="card">
		<BarList
			data={artistBars}
			title="Top artists"
			subtitle={artistSide === 'played'
				? 'Hours played, every credit counted'
				: 'Distinct recordings saved'}
			unit={artistSide === 'played' ? 'hours' : 'tracks'}
			limit={15}
			valueFormat={artistSide === 'played' ? fmtHours : undefined}
		>
			{#snippet actions()}
				{@render sides('Rank by', () => artistSide, (v) => (artistSide = v))}
			{/snippet}
		</BarList>
	</section>
	<section class="card">
		<BarList
			data={trackBars}
			title="Top recordings"
			subtitle={trackView === 'all'
				? 'Hours played'
				: 'Hours played on recordings your library has no record of'}
			unit="hours"
			limit={15}
			color={trackView === 'all' ? CATEGORICAL[1] : CATEGORICAL[3]}
			valueFormat={fmtHours}
		>
			{#snippet actions()}
				<Segmented
					options={[
						{ key: 'all', label: 'All' },
						{ key: 'unsaved', label: 'Never saved' }
					]}
					bind:value={trackView}
					label="Which recordings"
				/>
			{/snippet}
		</BarList>
	</section>
</div>

<div class="grid two">
	<section class="card">
		<BarList
			data={albumBars}
			title="Top albums"
			subtitle={albumView === 'played'
				? 'Hours played; singles and compilations excluded'
				: albumView === 'saved'
					? 'Most tracks saved'
					: 'Largest share of the album saved, minimum 5 tracks'}
			unit={albumView === 'played' ? 'hours' : 'tracks'}
			limit={12}
			color={CATEGORICAL[2]}
			valueFormat={albumView === 'played' ? fmtHours : undefined}
		>
			{#snippet actions()}
				<Segmented
					options={hasPlays
						? [
								{ key: 'played', label: 'Listened' },
								{ key: 'saved', label: 'Saved' },
								{ key: 'complete', label: 'Complete' }
							]
						: [
								{ key: 'saved', label: 'Saved' },
								{ key: 'complete', label: 'Complete' }
							]}
					bind:value={albumView}
					label="Rank by"
				/>
			{/snippet}
		</BarList>
	</section>
	<section class="card">
		<BarList
			data={shelfBars}
			title={shelfView === 'labels' ? 'Top labels' : 'Biggest playlists'}
			subtitle={shelfView === 'labels'
				? 'Recordings saved, by the label that released them'
				: 'Items added in this range; the ones you own make up the library'}
			unit="tracks"
			limit={10}
			color={CATEGORICAL[4]}
		>
			{#snippet actions()}
				<Segmented
					options={[
						{ key: 'labels', label: 'Labels' },
						{ key: 'playlists', label: 'Playlists' }
					]}
					bind:value={shelfView}
					label="Group by"
				/>
			{/snippet}
		</BarList>
	</section>
</div>

<div class="grid two">
	<section class="card">
		<AreaChart
			series={discoverySeries}
			title="Discovery"
			subtitle={discoveryView === 'plays'
				? 'Plays of a recording heard for the first time, against one already known'
				: discoveryView === 'saves'
					? 'Saves by an artist new to the library, against one already in it'
					: 'Median years between a recording’s release and saving it'}
			unit={discoveryView === 'plays' ? 'plays' : discoveryView === 'saves' ? 'recordings' : 'years'}
			valueFormat={discoveryView === 'lag' ? (n: number) => `${n.toFixed(1)}y` : undefined}
		>
			{#snippet actions()}
				<Segmented
					options={hasPlays
						? [
								{ key: 'plays', label: 'Listening' },
								{ key: 'saves', label: 'Saving' },
								{ key: 'lag', label: 'Lag' }
							]
						: [
								{ key: 'saves', label: 'Saving' },
								{ key: 'lag', label: 'Lag' }
							]}
					bind:value={discoveryView}
					label="Discovery measure"
				/>
			{/snippet}
		</AreaChart>
	</section>
	<section class="card">
		<Histogram
			values={spreadView === 'years' ? releaseValues : lengthValues}
			title={spreadView === 'years' ? 'Release years' : 'Track lengths'}
			subtitle={spreadView === 'years'
				? 'When the music you saved came out'
				: 'How long the recordings you saved run'}
			xLabel={spreadView === 'years' ? 'year' : 'minutes'}
			unit="recordings"
			binCount={spreadView === 'years' ? 40 : 30}
			color={spreadView === 'years' ? CATEGORICAL[0] : CATEGORICAL[3]}
			xFormat={spreadView === 'years'
				? (n: number) => String(Math.round(n))
				: (n: number) => `${n.toFixed(0)}m`}
		>
			{#snippet actions()}
				<Segmented
					options={[
						{ key: 'years', label: 'Released' },
						{ key: 'lengths', label: 'Length' }
					]}
					bind:value={spreadView}
					label="Distribution"
				/>
			{/snippet}
		</Histogram>
	</section>
</div>

{#if hasPlays}
	<div class="grid two">
		<section class="card">
			<Donut
				data={whereView === 'devices' ? data.devices : data.countries}
				title="Where you listen"
				subtitle={whereView === 'devices'
					? 'Minutes by device'
					: 'Minutes by the country the client connected from'}
				unit="minutes"
				centerValue={whereView === 'devices'
					? longDuration(t.msPlayed)
					: String(data.countries.length)}
				centerLabel={whereView === 'devices'
					? 'total'
					: data.countries.length === 1
						? 'country'
						: 'countries'}
			>
				{#snippet actions()}
					<Segmented
						options={[
							{ key: 'devices', label: 'Device' },
							{ key: 'countries', label: 'Country' }
						]}
						bind:value={whereView}
						label="Split by"
					/>
				{/snippet}
			</Donut>
		</section>
		<section class="card">
			<BarList
				data={endBars}
				title="How streams end"
				subtitle="Spotify records why playback stopped"
				unit="streams"
				limit={8}
				color={CATEGORICAL[5]}
			/>
		</section>
	</div>
{/if}

<section class="card">
	<header class="cardhead">
		<div>
			<h2>Recently</h2>
			<p class="faint sub">
				{recentSide === 'played'
					? 'The last plays in this range, newest first'
					: 'The newest recordings saved in this range'}
			</p>
		</div>
		<div class="cardactions">
			{@render sides('Show', () => recentSide, (v) => (recentSide = v))}
			<a class="more" href={recentSide === 'played' ? '/history/log' : '/library'}>
				{recentSide === 'played' ? 'Full log →' : 'All tracks →'}
			</a>
		</div>
	</header>
	{#if recentSide === 'played'}
		<div class="scroll-x">
			<table>
				<thead>
					<tr>
						<th class="wide-only">Played</th><th>Track</th><th class="wide-only">Artist</th><th
							class="r wide-only">Listened</th
						><th class="wide-only">Ended</th>
					</tr>
				</thead>
				<tbody>
					{#each data.recentPlays as p (p.id)}
						{@const ended = END_LABELS[p.reasonEnd ?? ''] ?? p.reasonEnd ?? '—'}
						<tr>
							<td class="faint small nowrap wide-only" title={p.playedAt}>{relativeTime(p.playedAt)}</td>
							<td>
								<div class="rec">
									<Cover src={p.canonicalTrackId ? p.cover : null} alt="" size={28} />
									<div class="lines">
										{#if p.canonicalTrackId}
											<a class="ellipsis" href="/track/{p.canonicalTrackId}">{p.title}</a>
										{:else}
											<span class="ellipsis" title="Not in the catalog">{p.title}</span>
										{/if}
										<!-- A phone has room for one column: the rest of the row
										     folds into a line under the title. -->
										<span class="narrow-only faint small ellipsis">
											{p.artist ?? '—'} · <span title={p.playedAt}>{relativeTime(p.playedAt)}</span
											>{#if p.reasonEnd} · {ended}{/if}
										</span>
									</div>
								</div>
							</td>
							<td class="muted ellipsis wide-only">
								{#if p.artistId}<a href="/artist/{p.artistId}">{p.artist}</a>{:else}{p.artist ??
										'—'}{/if}
							</td>
							<td
								class="r num wide-only"
								title={p.estimated ? 'Estimated from the gap to the previous play' : ''}
							>
								{streamTime(p.msPlayed, p.estimated)}
							</td>
							<td class="faint small wide-only">{ended}</td>
						</tr>
					{:else}
						<tr><td class="faint" colspan="5">Nothing played in this range.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<ul class="tiles-art">
			{#each data.recentAdds as r (r.canonicalTrackId)}
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
				<li class="faint">Nothing saved in this range.</li>
			{/each}
		</ul>
	{/if}
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
	.headright {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		min-width: 0;
	}
	@media (max-width: 640px) {
		.headright {
			width: 100%;
		}
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
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: var(--gap);
		margin-bottom: var(--gap);
	}
	/* Two tiles across is the floor: one per row turns the header into a
	   half-screen of scrolling before the first chart. */
	@media (max-width: 900px) {
		.tiles {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	@media (max-width: 640px) {
		.tiles {
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
		flex-wrap: wrap;
		align-items: flex-start;
		justify-content: space-between;
		gap: 8px 16px;
	}
	.cardhead > div:first-child {
		flex: 1 1 16rem;
		min-width: 0;
	}
	.cardhead .sub {
		margin-bottom: 14px;
	}
	.cardactions {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 12px;
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
	.rec a:hover {
		text-decoration: underline;
	}
	.lines {
		display: flex;
		flex-direction: column;
		min-width: 0;
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
	/* A right-aligned number would otherwise run straight into the words after it. */
	th.r + th,
	td.r + td {
		padding-left: 14px;
	}
	.small {
		font-size: 0.78rem;
	}
	@media (max-width: 640px) {
		table {
			min-width: 0;
			table-layout: fixed;
		}
		.ellipsis {
			max-width: none;
		}
	}
</style>
