<script lang="ts">
	import Cover from '$lib/components/Cover.svelte';
	import Pager from '$lib/components/Pager.svelte';
	import RangePicker from '$lib/components/RangePicker.svelte';
	import SearchBox from '$lib/components/SearchBox.svelte';
	import { num, trackTime } from '$lib/utils/format.ts';

	let { data } = $props();

	const stamp = new Intl.DateTimeFormat('en-GB', {
		day: 'numeric',
		month: 'short',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});

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
		<table>
			<thead>
				<tr>
					<th>Played</th>
					<th>Track</th>
					<th>Artist</th>
					<th>Album</th>
					<th class="r">Listened</th>
					<th>How it ended</th>
					<th>Device</th>
				</tr>
			</thead>
			<tbody>
				{#each data.rows as p (p.id)}
					<tr>
						<td class="muted small nowrap">{stamp.format(new Date(p.playedAt))}</td>
						<td>
							<div class="cell">
								<Cover src={p.cover} alt="{p.title} cover" size={30} />
								{#if p.canonicalTrackId}
									<a class="ellipsis" href="/track/{p.canonicalTrackId}">{p.title}</a>
								{:else}
									<span class="ellipsis faint" title="Not in the catalog — the log's own label">
										{p.title}
									</span>
								{/if}
								{#if p.shuffle}<span class="tag" title="Played on shuffle">⤮</span>{/if}
							</div>
						</td>
						<td class="muted small ellipsis">
							{#if p.artistId}<a href="/artist/{p.artistId}">{p.artist}</a>{:else}{p.artist ??
									'—'}{/if}
						</td>
						<td class="muted small ellipsis">{p.album ?? '—'}</td>
						<td class="r num">{p.msPlayed == null ? '—' : trackTime(p.msPlayed)}</td>
						<td class="faint small">{END_LABELS[p.reasonEnd ?? ''] ?? p.reasonEnd ?? '—'}</td>
						<td class="faint small ellipsis" title={p.platform ?? ''}>{p.platform ?? '—'}</td>
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
	.tag {
		flex: none;
		color: var(--text-muted);
		font-size: 0.8rem;
	}
	.empty {
		padding: 26px 0;
		text-align: center;
	}
</style>
