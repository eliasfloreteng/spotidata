<script lang="ts">
	import { onMount } from 'svelte';
	import { num, duration, relativeTime } from '$lib/utils/format.ts';
	import type { SyncStatus } from '$lib/server/queue/status.ts';

	let { data } = $props();

	let status = $state<SyncStatus>(data.status);
	let busy = $state(false);

	const run = $derived(status.run);
	const isActive = $derived(
		run !== null &&
			['queued', 'running', 'paused_rate_limited', 'paused_auth'].includes(run.status)
	);
	const blocked = $derived(
		status.limiter?.blockedUntil ? new Date(status.limiter.blockedUntil) > new Date() : false
	);
	/**
	 * Weighted by PHASE, not by job count. A phase only learns its `total` when
	 * its seeder runs, so summing job counts reports ~78% while seven of eleven
	 * phases have not started — each finished phase contributes 1, the running
	 * one contributes its own fraction, and the rest contribute 0.
	 */
	const overall = $derived.by(() => {
		if (status.phases.length === 0) return 0;
		const score = status.phases.reduce((a, p) => {
			if (p.status === 'completed' || p.status === 'skipped') return a + 1;
			if (p.total > 0) return a + Math.min(1, p.done / p.total);
			return a;
		}, 0);
		return score / status.phases.length;
	});
	const currentPhase = $derived(
		status.phases.find((p) => p.status === 'running' || p.status === 'seeding') ?? null
	);
	const phaseIndex = $derived(
		status.phases.filter((p) => p.status === 'completed' || p.status === 'skipped').length
	);
	const peakThroughput = $derived(Math.max(1, ...status.throughput.map((t) => t.requests)));

	async function poll() {
		try {
			const res = await fetch('/api/sync/status');
			if (res.ok) status = await res.json();
		} catch {
			// Transient; the next tick will pick it up.
		}
	}

	async function act(action: 'start' | 'cancel' | 'resume', mode?: 'full' | 'incremental') {
		busy = true;
		try {
			await fetch(`/api/sync/${action}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mode })
			});
			await poll();
		} finally {
			busy = false;
		}
	}

	onMount(() => {
		// Poll faster while something is happening, and back off when idle so an
		// open tab is not a permanent database load.
		let timer: ReturnType<typeof setTimeout>;
		const tick = async () => {
			await poll();
			timer = setTimeout(tick, isActive ? 1000 : 15_000);
		};
		timer = setTimeout(tick, 1000);
		return () => clearTimeout(timer);
	});

	const toneFor = (s: string) =>
		s === 'completed'
			? 'good'
			: s === 'failed'
				? 'bad'
				: s === 'running' || s === 'seeding'
					? 'active'
					: s === 'skipped'
						? 'faint'
						: 'idle';
</script>

<svelte:head><title>Sync · Spotidata</title></svelte:head>

<header class="head">
	<div>
		<h1>Sync</h1>
		{#if run}
			<p class="muted">
				Run #{run.id} · {run.mode} · {run.trigger} · started {relativeTime(run.startedAt)}
				{#if run.finishedAt}· finished {relativeTime(run.finishedAt)}{/if}
			</p>
		{:else}
			<p class="muted">No sync has run yet.</p>
		{/if}
	</div>
	<div class="actions">
		{#if isActive}
			<button class="btn" disabled={busy} onclick={() => act('cancel')}>Cancel</button>
		{:else}
			<button class="btn" disabled={busy} onclick={() => act('start', 'incremental')}>
				Sync now
			</button>
			<button class="btn btn-primary" disabled={busy} onclick={() => act('start', 'full')}>
				Full resync
			</button>
		{/if}
	</div>
</header>

{#if blocked}
	<div class="banner bad">
		<strong>Rate limited.</strong>
		Spotify asked us to wait until {new Date(status.limiter!.blockedUntil!).toLocaleTimeString()}
		{#if status.limiter?.last429RetryAfterS}
			(Retry-After {duration(status.limiter.last429RetryAfterS)})
		{/if}
		— all Spotify jobs are paused. Resuming early risks a longer block.
		<button class="btn" disabled={busy} onclick={() => act('resume')}>Resume anyway</button>
	</div>
{/if}

{#if run?.status === 'paused_auth'}
	<div class="banner bad">
		<strong>Authorization expired.</strong>
		<a href="/auth/login">Re-authorize</a> to continue — your data is preserved.
	</div>
{/if}

{#if run?.error}
	<div class="banner bad"><strong>Error:</strong> {run.error}</div>
{/if}

<section class="card overall">
	<div class="bar-row">
		<div class="bar big"><div class="fill" style="width:{overall * 100}%"></div></div>
		<span class="num pctlabel">{(overall * 100).toFixed(0)}%</span>
	</div>
	<p class="faint small phaseline">
		Phase {Math.min(phaseIndex + 1, status.phases.length)} of {status.phases.length}{#if currentPhase}
			· {currentPhase.label}{/if}
	</p>
	<dl class="metrics">
		<div><dt>API requests</dt><dd class="num">{num(status.limiter?.requestsTotal)}</dd></div>
		<div>
			<dt>Rate</dt>
			<dd class="num">
				{Math.round((status.limiter?.refillPerSec ?? 0) * 60)}
				<span class="faint">/ {Math.round((status.limiter?.targetPerSec ?? 0) * 60)} rpm</span>
			</dd>
		</div>
		<div>
			<!-- Only covers phases that have been seeded; later phases cannot be
			     estimated until their seeder discovers how much work exists. -->
			<dt>ETA <span class="faint">(known work)</span></dt>
			<dd class="num">{duration(status.etaSeconds)}</dd>
		</div>
		<div><dt>Queued jobs</dt><dd class="num">{num(status.queue.pending)}</dd></div>
		<div>
			<dt>Failing</dt>
			<dd class="num" class:bad={status.queue.failing > 0}>{num(status.queue.failing)}</dd>
		</div>
		<div><dt>429s</dt><dd class="num">{num(status.limiter?.consecutive429)}</dd></div>
	</dl>
</section>

<section class="card">
	<h2>Phases</h2>
	<div class="scroll-x">
		<table>
			<thead>
				<tr>
					<th>Phase</th><th>Status</th>
					<th class="r">Progress</th><th class="r">Rows</th>
					<th class="r">Rate</th><th class="r">ETA</th>
				</tr>
			</thead>
			<tbody>
				{#each status.phases as p (p.key)}
					<tr class:dim={p.status === 'pending' || p.status === 'skipped'}>
						<td>{p.label}</td>
						<td><span class="pill {toneFor(p.status)}">{p.status}</span></td>
						<td class="r">
							<div class="bar-row">
								<div class="bar">
									<div
										class="fill"
										style="width:{p.total > 0 ? Math.min(100, (p.done / p.total) * 100) : 0}%"
									></div>
							</div>
							<span class="num small">{num(p.done)}/{num(p.total)}</span>
						</div>
					</td>
					<td class="r num">{p.items > 0 ? num(p.items) : '—'}</td>
					<td class="r num small">{p.rate ? `${p.rate.toFixed(1)}/s` : '—'}</td>
					<td class="r num small">{duration(p.etaSeconds)}</td>
				</tr>
				{/each}
			</tbody>
		</table>
	</div>
</section>

<div class="split">
	<section class="card">
		<h2>API throughput <span class="faint small">requests per minute, last 2h</span></h2>
		{#if status.throughput.length === 0}
			<p class="faint">No requests yet.</p>
		{:else}
			<div class="spark" role="img" aria-label="API requests per minute over the last two hours">
				{#each status.throughput as t (t.bucket)}
					<div
						class="spark-bar"
						class:err={t.rateLimited > 0}
						style="height:{Math.max(2, (t.requests / peakThroughput) * 100)}%"
						title="{new Date(t.bucket).toLocaleTimeString()} · {t.requests} req{t.rateLimited
							? ` · ${t.rateLimited} rate-limited`
							: ''}"
					></div>
				{/each}
			</div>
			<p class="faint small">peak {peakThroughput} req/min</p>
		{/if}
	</section>

	<section class="card">
		<h2>Database</h2>
		<dl class="metrics tall">
			{#each Object.entries(status.counts) as [key, value] (key)}
				<div><dt>{key}</dt><dd class="num">{num(value)}</dd></div>
			{/each}
		</dl>
	</section>
</div>

<section class="card">
	<h2>Event log</h2>
	{#if status.events.length === 0}
		<p class="faint">Nothing logged for this run.</p>
	{:else}
		<ul class="events">
			{#each status.events as e (e.id)}
				<li>
					<span class="pill {e.level}">{e.level}</span>
					<span class="msg">{e.message}</span>
					{#if e.phaseKey}<span class="faint small">{e.phaseKey}</span>{/if}
					<time class="faint small">{relativeTime(e.at)}</time>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<section class="card">
	<h2>Recent runs</h2>
	<div class="scroll-x">
		<table>
			<thead>
				<tr><th>#</th><th>Mode</th><th>Status</th><th class="r">Requests</th><th class="r">Started</th></tr>
			</thead>
			<tbody>
				{#each data.runs as r (r.id)}
					<tr>
						<td class="num">{r.id}</td>
						<td>{r.mode}</td>
						<td><span class="pill {toneFor(r.status)}">{r.status}</span></td>
						<td class="r num">{r.apiRequests > 0 ? num(r.apiRequests) : '—'}</td>
						<td class="r faint small">{relativeTime(r.startedAt)}</td>
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
	}
	.head p {
		margin: 4px 0 0;
		font-size: 0.88rem;
	}
	.actions {
		display: flex;
		gap: 8px;
	}
	section {
		padding: var(--card-py) var(--card-px);
		margin-bottom: var(--gap);
	}
	/* The run summary is a long sentence; sharing a row with two buttons on a
	   phone left it three words wide. Title, then summary, then the actions —
	   which get the full width, since starting a resync is the reason to be
	   on this page from a phone at all. */
	@media (max-width: 640px) {
		.head {
			flex-direction: column;
			gap: 12px;
		}
		.actions {
			width: 100%;
		}
		.actions :global(.btn) {
			flex: 1;
			justify-content: center;
		}
	}
	h2 {
		margin-bottom: 14px;
		display: flex;
		align-items: baseline;
		gap: 10px;
	}
	.split {
		display: grid;
		grid-template-columns: 1.6fr 1fr;
		gap: var(--gap);
	}
	/* A track's auto minimum is min-content; without this the widest metric
	   name decides the page width. */
	.split > :global(*) {
		min-width: 0;
	}
	@media (max-width: 860px) {
		.split {
			grid-template-columns: 1fr;
		}
	}

	.banner {
		padding: 12px 16px;
		border-radius: var(--radius-sm);
		margin-bottom: var(--gap);
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.banner.bad {
		background: rgba(244, 63, 94, 0.12);
		border: 1px solid rgba(244, 63, 94, 0.35);
	}

	.bar-row {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.bar {
		flex: 1;
		min-width: 90px;
		height: 6px;
		background: rgba(255, 255, 255, 0.07);
		border-radius: 999px;
		overflow: hidden;
	}
	.bar.big {
		height: 10px;
	}
	.fill {
		height: 100%;
		background: linear-gradient(90deg, var(--accent), var(--accent-2), var(--accent-3));
		transition: width 0.4s ease;
	}
	.phaseline {
		margin: 8px 0 0;
	}
	.pctlabel {
		min-width: 56px;
		text-align: right;
		font-weight: 600;
	}

	.metrics {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
		gap: 14px;
		margin: 18px 0 0;
	}
	.metrics.tall {
		grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
		margin-top: 0;
	}
	.metrics dt {
		color: var(--text-muted);
		font-size: 0.78rem;
		text-transform: capitalize;
	}
	.metrics dd {
		margin: 2px 0 0;
		font-size: 1.15rem;
		font-weight: 600;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
		/* Under this the phase name wraps to four lines and the rate runs into
		   the row count; the lane scrolls instead. */
		min-width: 560px;
	}
	th {
		text-align: left;
		font-weight: 500;
		color: var(--text-muted);
		font-size: 0.78rem;
		padding-bottom: 8px;
		border-bottom: 1px solid var(--hairline);
		white-space: nowrap;
	}
	td {
		padding: 7px 10px 7px 0;
		border-bottom: 1px solid rgba(255, 255, 255, 0.03);
	}
	th:last-child,
	td:last-child {
		padding-right: 0;
	}
	th.r,
	td.r {
		text-align: right;
	}
	td.r .bar-row {
		justify-content: flex-end;
	}
	tr.dim {
		opacity: 0.45;
	}

	.pill {
		display: inline-block;
		padding: 1px 9px;
		border-radius: 999px;
		font-size: 0.72rem;
		background: rgba(255, 255, 255, 0.07);
		color: var(--text-muted);
	}
	.pill.good,
	.pill.info {
		background: rgba(52, 211, 153, 0.14);
		color: var(--good);
	}
	.pill.active {
		background: var(--accent-soft);
		color: #c4b5fd;
	}
	.pill.bad,
	.pill.error {
		background: rgba(244, 63, 94, 0.15);
		color: var(--bad);
	}
	.pill.warn {
		background: rgba(251, 191, 36, 0.14);
		color: var(--warn);
	}

	.spark {
		display: flex;
		align-items: flex-end;
		gap: 1px;
		height: 90px;
	}
	.spark-bar {
		flex: 1;
		min-width: 2px;
		background: linear-gradient(180deg, var(--accent-2), var(--accent));
		border-radius: 1px 1px 0 0;
	}
	.spark-bar.err {
		background: var(--bad);
	}

	.events {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: 320px;
		overflow-y: auto;
	}
	.events li {
		display: flex;
		align-items: baseline;
		gap: 10px;
		padding: 5px 0;
		border-bottom: 1px solid rgba(255, 255, 255, 0.03);
		font-size: 0.88rem;
	}
	.msg {
		flex: 1;
	}
	.small {
		font-size: 0.78rem;
	}
	.bad {
		color: var(--bad);
	}
</style>
