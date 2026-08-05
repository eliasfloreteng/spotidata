<script lang="ts">
	import { onMount } from 'svelte';
	import Chip from '$lib/components/Chip.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import { CATEGORICAL } from '$lib/charts/index.ts';
	import { num, duration, relativeTime, pct } from '$lib/utils/format.ts';

	let { data } = $props();

	let coverage = $state(data.coverage);
	let totals = $state(data.totals);
	let limiters = $state(data.limiters);
	let queued = $state(data.queued);
	let enabled = $state(data.enabled);
	let busy = $state(false);

	const mb = $derived(limiters.find((l) => l.service === 'musicbrainz') ?? null);
	const blockedUntil = $derived(
		limiters
			.map((l) => l.blockedUntil)
			.filter((v): v is string => Boolean(v))
			.filter((v) => new Date(v) > new Date())
			.sort()
			.at(-1) ?? null
	);

	/** Only the stages that actually cost requests count toward "done". */
	const crawled = $derived(coverage.filter((c) => c.stage !== 'genres'));
	const remaining = $derived(
		crawled.reduce((a, c) => a + Math.max(0, c.candidates - c.matched - c.missed), 0)
	);
	const overall = $derived.by(() => {
		const total = crawled.reduce((a, c) => a + c.candidates, 0);
		if (total === 0) return 0;
		return crawled.reduce((a, c) => a + c.matched + c.missed, 0) / total;
	});

	/**
	 * MusicBrainz allows one request per second and the album stage spends two
	 * per album, so the honest estimate counts requests rather than entities.
	 * AcousticBrainz batches 25 at a time and barely registers next to that.
	 */
	const etaSeconds = $derived.by(() => {
		const perStage: Record<string, number> = { recordings: 1, audio: 0.08, artists: 1.4, albums: 2 };
		return crawled.reduce((a, c) => {
			const left = Math.max(0, c.candidates - c.matched - c.missed);
			return a + left * (perStage[c.stage] ?? 1);
		}, 0);
	});

	const running = $derived(queued && enabled);

	async function refresh() {
		try {
			const res = await fetch('/api/enrich/status');
			if (!res.ok) return;
			const next = await res.json();
			coverage = next.coverage;
			totals = next.totals;
			limiters = next.limiters;
			queued = next.queued;
		} catch {
			// Transient; the next tick picks it up.
		}
	}

	async function act(action: string, body?: unknown) {
		busy = true;
		try {
			await fetch(`/api/enrich/${action}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body ?? {})
			});
			if (action === 'start') enabled = true;
			if (action === 'pause') enabled = false;
			await refresh();
		} finally {
			busy = false;
		}
	}

	onMount(() => {
		let timer: ReturnType<typeof setTimeout>;
		const tick = async () => {
			await refresh();
			// The coverage view costs ~150 ms and the numbers move by ~25 a minute,
			// so a faster poll would be pure database load on a crawl that runs
			// for a day.
			timer = setTimeout(tick, running ? 10_000 : 60_000);
		};
		timer = setTimeout(tick, 10_000);
		return () => clearTimeout(timer);
	});

	const toneFor = (status: string | null) =>
		status === 'complete'
			? 'good'
			: status === 'error'
				? 'bad'
				: status === 'blocked'
					? 'warn'
					: status === 'running'
						? 'active'
						: 'idle';
</script>

<svelte:head><title>Enrichment · Spotidata</title></svelte:head>

<header class="head">
	<div>
		<h1>Enrichment</h1>
		<p class="muted">
			What Spotify does not return — genres, artist origins, labels and barcodes from
			MusicBrainz, BPM and musical key from AcousticBrainz.
		</p>
	</div>
	<div class="actions">
		{#if running}
			<button class="btn" disabled={busy} onclick={() => act('pause')}>Pause</button>
		{:else}
			<button class="btn btn-primary" disabled={busy} onclick={() => act('start')}>
				{enabled ? 'Resume' : 'Start crawling'}
			</button>
		{/if}
		<button class="btn" disabled={busy} onclick={() => act('retry-misses')} title="Clear the recorded misses so everything is asked again — MusicBrainz is edited continuously">
			Retry misses
		</button>
	</div>
</header>

{#if blockedUntil}
	<p class="alert warn">
		Rate-limit block in force until {relativeTime(blockedUntil)}. The crawl resumes on its own.
		<button class="linkish" disabled={busy} onclick={() => act('unblock')}>Clear now</button>
	</p>
{:else if !enabled}
	<p class="alert">
		Enrichment is switched off. Nothing is being fetched; everything already gathered stays.
	</p>
{/if}

<section class="tiles">
	<StatTile
		label="Overall"
		value={pct(overall, 1)}
		sub="{num(remaining)} entities left to look up"
		accent={CATEGORICAL[0]}
	/>
	<StatTile
		label="Recordings identified"
		value={num(totals.recordings)}
		sub="matched by ISRC"
		accent={CATEGORICAL[1]}
	/>
	<StatTile
		label="With BPM & key"
		value={num(totals.analysed)}
		sub="AcousticBrainz analyses"
		accent={CATEGORICAL[2]}
	/>
	<StatTile
		label="Genres in use"
		value={num(totals.genresInUse)}
		sub="of {num(totals.vocabulary)} MusicBrainz knows"
		accent={CATEGORICAL[3]}
	/>
	<StatTile
		label="Time remaining"
		value={etaSeconds > 0 ? duration(etaSeconds) : '—'}
		sub={mb ? `at ${mb.refillPerSec} request/s` : 'paced by MusicBrainz'}
		accent={CATEGORICAL[4]}
		muted={!running}
	/>
</section>

<section class="card">
	<header class="cardhead">
		<div>
			<h2>Stages</h2>
			<p class="faint sub">
				Each stage feeds the next: nothing can be asked about a recording before its ISRC has
				resolved to one, and no artist is identified for free before its recordings exist.
			</p>
		</div>
	</header>

	<ul class="stages">
		{#each coverage as c (c.stage)}
			{@const settled = c.matched + c.missed}
			{@const ratio = c.candidates > 0 ? settled / c.candidates : c.status === 'complete' ? 1 : 0}
			<li>
				<div class="stagehead">
					<span class="name">{c.label}</span>
					<Chip tone={toneFor(c.status) === 'good' ? 'good' : toneFor(c.status) === 'bad' ? 'bad' : toneFor(c.status) === 'warn' ? 'warn' : 'neutral'}>
						{c.status ?? 'pending'}
					</Chip>
				</div>
				<div class="bar" role="img" aria-label="{pct(ratio)} done">
					<span class="fill" style="width:{Math.round(ratio * 100)}%"></span>
					{#if c.candidates > 0}
						<span class="miss" style="width:{Math.round((c.missed / c.candidates) * 100)}%"></span>
					{/if}
				</div>
				<div class="stagefoot faint small">
					{#if c.candidates > 0}
						{num(c.matched)} found · {num(c.missed)} not in MusicBrainz ·
						{num(Math.max(0, c.candidates - settled))} to go
					{:else}
						nothing to do
					{/if}
					{#if c.requests > 0}· {num(c.requests)} requests{/if}
					{#if c.lastRunAt}· last ran {relativeTime(c.lastRunAt)}{/if}
				</div>
				{#if c.lastError}<p class="err small">{c.lastError}</p>{/if}
			</li>
		{/each}
	</ul>
</section>

{#if data.genres.length > 0}
	<section class="card">
		<header class="cardhead">
			<div>
				<h2>Your genres</h2>
				<p class="faint sub">
					From the tags MusicBrainz carries on each recording, filtered to its curated genre
					list and weighted by how much you have actually played.
				</p>
			</div>
		</header>
		<ul class="genres">
			{#each data.genres as g (g.genre)}
				<li>
					<span class="g">{g.genre}</span>
					<span class="n num faint small">{num(g.plays)} plays · {num(g.recordings)} recordings</span>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<section class="card">
	<header class="cardhead"><div><h2>Sources</h2></div></header>
	<dl>
		<dt>MusicBrainz</dt>
		<dd>
			{num(mb?.requestsTotal ?? 0)} requests · one per second, the published ceiling for
			anonymous clients. No account is needed to read it.
		</dd>
		<dt>AcousticBrainz</dt>
		<dd>
			{num(limiters.find((l) => l.service === 'acousticbrainz')?.requestsTotal ?? 0)} requests ·
			25 recordings each. Submissions closed in 2022, so coverage is fixed and partial — a
			recording with no analysis will never get one.
		</dd>
		<dt>MusicBrainz account</dt>
		<dd>
			{#if !data.oauth.configured}
				<span class="faint">Not configured, and not needed — the enrichment above is read-only.</span>
			{:else if data.oauth.authorized}
				Connected <span class="faint">({data.oauth.scope})</span> ·
				<form method="POST" action="/auth/musicbrainz/logout" class="inline">
					<button class="linkish" type="submit">Disconnect</button>
				</form>
				{#if data.oauth.error}<span class="tone-bad small">{data.oauth.error}</span>{/if}
			{:else}
				<a href="/auth/musicbrainz/login">Connect</a>
				<span class="faint">
					— optional. It does not raise the rate limit and unlocks nothing read here; it is
					what submitting data back to MusicBrainz would need.
				</span>
			{/if}
		</dd>
	</dl>
	<p class="faint small">
		Which stages run is configured under <a href="/settings">Settings</a>.
	</p>
</section>

<style>
	.head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: var(--gap);
		flex-wrap: wrap;
		margin-bottom: var(--gap);
	}
	.head p {
		max-width: 60ch;
	}
	.actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: var(--gap);
		margin-bottom: var(--gap);
	}
	.card {
		padding: 20px 22px;
		margin-bottom: var(--gap);
	}
	.cardhead {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: var(--gap);
		margin-bottom: 14px;
	}
	.sub {
		max-width: 68ch;
		font-size: 0.82rem;
		margin-top: 3px;
	}
	.alert {
		padding: 9px 14px;
		border-radius: var(--radius-sm);
		background: var(--bg-elevated);
		border: 1px solid var(--hairline-strong);
		font-size: 0.88rem;
		margin-bottom: var(--gap);
	}
	.alert.warn {
		background: rgba(251, 191, 36, 0.1);
		border-color: rgba(251, 191, 36, 0.32);
	}
	.stages {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 16px;
	}
	.stagehead {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 6px;
	}
	.name {
		font-size: 0.9rem;
		font-weight: 550;
	}
	.bar {
		position: relative;
		display: flex;
		height: 8px;
		border-radius: 999px;
		background: var(--bg-elevated);
		border: 1px solid var(--hairline);
		overflow: hidden;
	}
	.fill {
		background: linear-gradient(90deg, var(--accent), var(--accent-2));
		transition: width 0.4s ease;
	}
	/* Misses ride at the end of the filled run: they are settled work, but not
	   data — showing them as progress would overstate what was found. */
	.miss {
		position: absolute;
		right: 0;
		top: 0;
		bottom: 0;
		background: repeating-linear-gradient(
			45deg,
			var(--hairline-strong) 0 3px,
			transparent 3px 6px
		);
	}
	.stagefoot {
		margin-top: 5px;
	}
	.err {
		color: var(--bad);
		margin-top: 4px;
		overflow-wrap: anywhere;
	}
	.genres {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
		gap: 6px 18px;
	}
	.genres li {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		align-items: baseline;
		border-bottom: 1px solid var(--hairline);
		padding: 4px 0;
	}
	.g {
		font-size: 0.88rem;
	}
	dl {
		display: grid;
		grid-template-columns: 190px 1fr;
		gap: 10px 16px;
		margin: 0 0 12px;
	}
	dt {
		color: var(--text-muted);
		font-size: 0.86rem;
	}
	dd {
		margin: 0;
		min-width: 0;
		font-size: 0.88rem;
		overflow-wrap: anywhere;
	}
	@media (max-width: 640px) {
		.card {
			padding: var(--card-py) var(--card-px);
		}
		dl {
			grid-template-columns: 1fr;
			gap: 4px;
		}
		dt {
			font-size: 0.78rem;
			text-transform: uppercase;
			letter-spacing: 0.06em;
			color: var(--text-faint);
		}
		dd + dt {
			margin-top: 8px;
		}
	}
	.inline {
		display: inline;
	}
	.linkish {
		background: none;
		border: 0;
		padding: 0;
		color: var(--accent-2);
		cursor: pointer;
		font: inherit;
		text-decoration: underline;
	}
	.small {
		font-size: 0.8rem;
	}
	.tone-bad {
		color: var(--bad);
	}
</style>
