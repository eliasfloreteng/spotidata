<script lang="ts">
	import Cover from '$lib/components/Cover.svelte';
	import Pager from '$lib/components/Pager.svelte';
	import RangePicker from '$lib/components/RangePicker.svelte';
	import SearchBox from '$lib/components/SearchBox.svelte';
	import { num, streamTime } from '$lib/utils/format.ts';

	let { data } = $props();

	const stamp = new Intl.DateTimeFormat('en-GB', {
		day: 'numeric',
		month: 'short',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});

	// A phone groups the log by day, so a row needs only the time.
	const dayFmt = new Intl.DateTimeFormat('en-GB', {
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		year: 'numeric'
	});
	const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
	const dayOf = (iso: string) => dayFmt.format(new Date(iso));

	const END_LABELS: Record<string, string> = {
		trackdone: 'played out',
		fwdbtn: 'skipped',
		backbtn: 'skipped back',
		endplay: 'stopped',
		logout: 'signed out',
		remote: 'handed over',
		'unexpected-exit': 'app closed',
		'unexpected-exit-while-paused': 'app closed',
		trackerror: 'error',
		unknown: 'unknown'
	};
</script>

<svelte:head><title>Play log · Spotidata</title></svelte:head>

<header class="head">
	<div>
		<h1>Play log</h1>
		<p class="muted">
			{num(data.total)} streams{#if data.q} matching “{data.q}”{/if} — every play, newest first.
			<a href="/history">Back to the charts →</a>
		</p>
	</div>
	<div class="headright">
		<SearchBox value={data.q} placeholder="Search track or artist" />
		<RangePicker days={data.range.days} />
	</div>
</header>

<section class="card">
	<div class="scroll-x">
		<table class="cards">
			<thead>
				<tr>
					<th class="wide-only">Played</th>
					<th>Track</th>
					<th class="wide-only">Artist</th>
					<th class="wide-only">Album</th>
					<th class="r">Listened</th>
					<th>How it ended</th>
					<th>Device</th>
				</tr>
			</thead>
			<tbody>
				{#each data.rows as p, i (p.id)}
					{@const ended = END_LABELS[p.reasonEnd ?? ''] ?? p.reasonEnd ?? '—'}
					{@const day = dayOf(p.playedAt)}
					{#if i === 0 || dayOf(data.rows[i - 1].playedAt) !== day}
						<tr class="day narrow-only"><td class="lead" colspan="7">{day}</td></tr>
					{/if}
					<tr class:bare={!p.reasonEnd && !p.platform}>
						<td class="muted small nowrap wide-only">{stamp.format(new Date(p.playedAt))}</td>
						<td class="lead">
							<div class="cell">
								<Cover src={p.cover} alt="{p.title} cover" size={30} />
								<div class="lines">
									<div class="titleline">
										{#if p.canonicalTrackId}
											<a class="ellipsis" href="/track/{p.canonicalTrackId}">{p.title}</a>
										{:else}
											<span class="ellipsis faint" title="Not in the catalog — the log's own label">
												{p.title}
											</span>
										{/if}
										{#if p.shuffle}<span class="tag" title="Played on shuffle">⤮</span>{/if}
									</div>
									<span class="narrow-only muted small ellipsis">{p.artist ?? '—'}</span>
									{#if p.album}<span class="narrow-only faint small ellipsis">{p.album}</span>{/if}
								</div>
							</div>
						</td>
						<td class="muted small wide-only">
							<span class="ellipsis">
								{#if p.artistId}<a href="/artist/{p.artistId}">{p.artist}</a>{:else}{p.artist ??
										'—'}{/if}
							</span>
						</td>
						<td class="muted small wide-only"><span class="ellipsis">{p.album ?? '—'}</span></td>
						<td class="narrow-only num when" data-label="Time">{timeFmt.format(new Date(p.playedAt))}</td>
						<td
							class="r num nowrap len"
							data-label="Listened"
							title={p.estimated ? 'Estimated from the gap to the previous play' : ''}
						>
							{streamTime(p.msPlayed, p.estimated)}
						</td>
						<td class="faint small" data-label="Ended">{ended}</td>
						<td class="faint small" data-label="Device" title={p.platform ?? ''}>
							<span class="ellipsis">{p.platform ?? '—'}</span>
						</td>
					</tr>
				{:else}
					<tr><td colspan="7" class="empty faint">No plays in this range.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
	<Pager
		page={data.page}
		pages={data.pages}
		total={data.total}
		pageSize={data.pageSize}
		unit="plays"
	/>
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
	.head p a {
		text-decoration: underline;
	}
	.headright {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		/* Lets the range picker scroll inside the row instead of widening it. */
		min-width: 0;
	}
	@media (max-width: 640px) {
		.headright {
			width: 100%;
		}
	}
	.card {
		padding: var(--card-py) var(--card-px);
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
		min-width: 860px;
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
		padding: 6px 10px 6px 0;
		border-bottom: 1px solid rgba(255, 255, 255, 0.03);
	}
	th.r,
	td.r {
		text-align: right;
	}
	/* The right-aligned length would otherwise run into how the play ended. */
	th.r + th,
	td.r + td {
		padding-left: 14px;
	}
	.cell {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}
	.cell a:hover {
		text-decoration: underline;
	}
	.ellipsis {
		display: inline-block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 30ch;
		vertical-align: bottom;
	}
	.nowrap {
		white-space: nowrap;
	}
	.small {
		font-size: 0.78rem;
	}
	.lines,
	.titleline {
		display: flex;
		min-width: 0;
	}
	.lines {
		flex-direction: column;
	}
	.titleline {
		align-items: center;
		gap: 8px;
	}
	.tag {
		flex: none;
		color: var(--text-muted);
		font-size: 0.8rem;
	}
	.empty {
		padding: 26px 0;
		text-align: center;
	}
	/* Phone: a row card (app.css › Rows as cards) under a heading for its
	   day, so each row needs only the time; the artist and album are lines of
	   their own, cut short rather than wrapped. */
	@media (max-width: 640px) {
		/* The time and length sit at the right of the title, where a log is
		   scanned; how it ended and on what is a row under it, for the plays
		   that know (the archive's do, the API's do not). */
		table {
			--card-cols: minmax(0, 1fr) minmax(0, 1fr) auto;
		}
		tr:not(.day) .lead {
			grid-column: 1 / 3 !important;
			grid-row: 1 / span 2;
		}
		.when,
		.len {
			grid-column: 3;
			text-align: right !important;
		}
		.when {
			grid-row: 1;
			color: var(--text);
		}
		.len {
			grid-row: 2;
			color: var(--text-muted);
			font-size: 0.8rem;
		}
		.when::before,
		.len::before {
			display: none !important;
		}
		tr.bare td[data-label='Ended'],
		tr.bare td[data-label='Device'] {
			display: none;
		}
		tr.day {
			padding: 18px 0 2px !important;
			border-bottom: 0 !important;
		}
		tr.day:first-child {
			padding-top: 4px !important;
		}
		tr.day td {
			font-size: 0.78rem;
			font-weight: 600;
			color: var(--text-muted);
		}
		.cell {
			align-items: flex-start;
		}
		.cell :global(img),
		.cell :global(.placeholder) {
			width: 44px !important;
			height: 44px !important;
		}
		.ellipsis {
			max-width: none;
			display: block;
		}
		.lines {
			flex: 1;
		}
	}
</style>
