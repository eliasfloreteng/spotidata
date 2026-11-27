<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import Chip from '$lib/components/Chip.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import DownloadButton from '$lib/components/DownloadButton.svelte';
	import SearchBox from '$lib/components/SearchBox.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import { CATEGORICAL } from '$lib/charts/index.ts';
	import { provideDownloads } from '$lib/downloads.svelte.ts';
	import { num, relativeTime, trackTime } from '$lib/utils/format.ts';
	import { trackHref } from '$lib/utils/qs.ts';
	import type { Activity, EngineDownload, KeptPlaylist, SpotifyStatus } from '$lib/server/engine/client.ts';
	import type { Queue } from '$lib/server/engine/queue.ts';
	import { untrack } from 'svelte';

	let { data, form } = $props();

	/** Newer than the load: the queue as the page has followed it since. */
	let live = $state<Queue | null>(null);
	$effect.pre(() => {
		void data;
		untrack(() => (live = null));
	});
	const queueRead = $derived(live?.queue ?? data.queue);
	const recordings = $derived(live?.recordings ?? data.recordings);
	const queue = $derived(queueRead.ok ? queueRead.value : null);
	const downloads = $derived(queue?.downloads ?? []);

	const ACTIVE = new Set(['queued', 'searching', 'downloading', 'finishing']);
	const active = $derived(downloads.filter((d) => ACTIVE.has(d.state)).sort((a, b) => a.id - b.id));
	const waiting = $derived(downloads.filter((d) => d.state === 'waiting'));
	const failed = $derived(downloads.filter((d) => d.state === 'failed'));
	const done = $derived(downloads.filter((d) => d.state === 'done'));
	const keptOf = (s: SpotifyStatus) => s.playlists.filter((p) => p.selected);
	const challenges = $derived((queue?.challenges ?? []).filter((c) => c.waiting > 0));
	const sources = $derived([...(queue?.sources ?? [])].sort((a, b) => a.rank - b.rank));

	/** Get Music's results, with buttons of their own. */
	provideDownloads(() => ({
		statuses: data.results,
		refs: (data.found ?? []).map((t) => ({ id: t.id, isrc: t.isrc }))
	}));

	/**
	 * While the engine is at work, the page follows its queue (cheap), and
	 * reads everything again once the queue is done, for the playlists' counts.
	 */
	$effect(() => {
		if (active.length === 0) return;
		const timer = setTimeout(async () => {
			const res = await fetch('/api/downloads/queue').catch(() => null);
			if (!res?.ok) return;
			const next = (await res.json()) as Queue;
			const still = next.queue.ok && next.queue.value.downloads.some((d) => ACTIVE.has(d.state));
			live = next;
			if (!still) void invalidateAll();
		}, 3000);
		return () => clearTimeout(timer);
	});

	const PHASE: Record<string, string> = {
		queued: 'Queued',
		searching: 'Finding a source',
		downloading: 'Downloading',
		finishing: 'Tagging and filing',
		waiting: 'Waiting for you'
	};
	const OUTCOME: Record<string, string> = {
		ok: 'got it',
		not_found: "doesn't have it",
		unavailable: 'unavailable',
		bad_file: 'sent a bad file',
		needs_you: 'needs a check solved'
	};

	const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
	const when = (ms: number | undefined) => (ms ? relativeTime(new Date(ms)) : '—');
	const share = (d: EngineDownload) => (d.total && d.received ? Math.min(1, d.received / d.total) : null);
	const href = (d: EngineDownload) => {
		const canonical = recordings[d.id];
		if (canonical) return trackHref(canonical);
		return d.track.id.startsWith('spotify:') ? `/track/spotify/${d.track.id.slice(8)}` : null;
	};
	const tried = (d: EngineDownload) =>
		d.attempts.map((a) => `${a.source} ${OUTCOME[a.outcome] ?? a.outcome}${a.detail ? ` (${a.detail})` : ''}`);
	const playlistShare = (p: KeptPlaylist) => {
		const total = p.have + p.getting + p.missing;
		return total > 0 ? { have: p.have / total, getting: p.getting / total } : null;
	};

	const ACTIVITY: Record<Activity['kind'], (a: Activity) => string> = {
		kept: () => 'Started keeping',
		dropped: (a) => `Stopped keeping${a.detail ? `; ${a.detail}` : ''}`,
		read: (a) => `Read ${num(a.count)} tracks`,
		changed: (a) => `Changed on Spotify: ${num(a.added)} added, ${num(a.removed)} removed`,
		queued: (a) => `Queued ${num(a.count)} ${a.count === 1 ? 'download' : 'downloads'}`,
		retried: (a) => `Tried ${num(a.count)} failed ${a.count === 1 ? 'download' : 'downloads'} again`,
		landed: (a) => `${num(a.count)} ${a.count === 1 ? 'track' : 'tracks'} landed in the folder`,
		failed: (a) => `Couldn't read Spotify${a.detail ? `: ${a.detail}` : ''}`,
		recovered: () => 'Reading Spotify works again',
		paused: () => 'Checks paused',
		resumed: () => 'Checks resumed'
	};

	/** Forms here answer by reloading the page's data; the error, if any, shows at the top. */
	const reload = () => {
		return async ({ update }: { update: (opts?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
		};
	};
</script>

<svelte:head><title>Downloads · Spotidata</title></svelte:head>

<header class="head">
	<div>
		<h1>Downloads</h1>
		<p class="muted">
			Deckhand's engine gets lossless copies of the tracks you ask for, and of the playlists it keeps,
			into the music folder that Syncthing puts on the DJ stick. It only ever adds files.
		</p>
	</div>
	<SearchBox value={data.q} placeholder="Find a track to download" />
</header>

{#if form?.error}
	<div class="alert">{form.error}</div>
{/if}
{#if !queueRead.ok}
	<div class="alert">
		{queueRead.error} Downloads can't be queued or changed until it is back; what it already did still
		shows on every track.
	</div>
{/if}

{#if data.q}
	<section class="card">
		<h2>Get music</h2>
		{#if data.found === null}
			<p class="faint sub">Spotify's catalog could not be searched just now.</p>
		{:else if data.found.length === 0}
			<p class="faint sub">Nothing on Spotify matches “{data.q}”.</p>
		{:else}
			<p class="faint sub">Spotify's catalog for “{data.q}”. A tick means the folder has the recording already.</p>
			<div class="scroll-x">
				<table>
					<tbody>
						{#each data.found as t (t.id)}
							<tr>
								<td>
									<div class="cell">
										<Cover src={t.cover ?? null} alt="{t.album} cover" size={34} />
										<div class="text">
											<a class="title" href="/track/spotify/{t.id}">{t.title}</a>
											{#if t.explicit}<span class="ex" title="Explicit">E</span>{/if}
											<div class="faint xs">{t.artists.join(', ')} · {t.album}</div>
										</div>
									</div>
								</td>
								<td class="r num muted nowrap">{trackTime(t.duration_ms)}</td>
								<td class="dl"><DownloadButton id={t.id} title={t.title} /></td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
{/if}

{#if queue}
	<section class="tiles">
		<StatTile
			label="Under way"
			value={num(active.length)}
			sub={active.length > 0 ? `${num(active.filter((d) => d.state === 'downloading').length)} downloading now` : 'nothing queued'}
			accent={CATEGORICAL[0]}
			muted={active.length === 0}
		/>
		<StatTile
			label="Waiting for you"
			value={num(waiting.length)}
			sub={waiting.length > 0 ? 'a check to solve in the app' : 'nothing waiting'}
			accent={CATEGORICAL[1]}
			muted={waiting.length === 0}
		/>
		<StatTile
			label="Failed"
			value={num(failed.length)}
			sub="in the last two weeks"
			accent={CATEGORICAL[3]}
			muted={failed.length === 0}
		/>
		<StatTile label="Done" value={num(done.length)} sub="in the last two weeks" accent={CATEGORICAL[2]} />
	</section>

	{#if challenges.length > 0}
		{#each challenges as c (c.id)}
			<div class="alert warn">
				{num(c.waiting)} {c.waiting === 1 ? 'download waits' : 'downloads wait'} for {c.site}'s check.
				It can only be solved in the Deckhand app, on the site's own page; the downloads start again once
				it is.
			</div>
		{/each}
	{/if}

	<section class="card">
		<h2>Under way</h2>
		{#if active.length === 0 && waiting.length === 0}
			<p class="faint sub">
				Nothing is being downloaded. Ask for a track here, on its page, or from an album, a playlist or
				the library.
			</p>
		{:else}
			<p class="faint sub">Oldest first, a few at a time. Each asks every source at once, then tries the best first.</p>
			<ul class="rows">
				{#each [...active, ...waiting] as d (d.id)}
					{@const link = href(d)}
					{@const part = share(d)}
					<li>
						<Cover src={d.track.cover ?? null} alt="{d.track.album} cover" size={40} />
						<div class="text">
							<div class="title">
								{#if link}<a href={link}>{d.track.title}</a>{:else}{d.track.title}{/if}
							</div>
							<div class="faint xs">
								{d.track.artists.join(', ')}{#if d.playlist} · for <span class="muted">{d.playlist}</span>{/if}
							</div>
							<div class="progress">
								<span class="phase" class:waiting={d.state === 'waiting'}>
									{PHASE[d.state] ?? d.state}{#if d.source && d.state !== 'waiting'} · {d.source}{/if}
									{#if d.state === 'downloading' && d.received > 0}
										· {megabytes(d.received)}{#if d.total} of {megabytes(d.total)}{/if}
									{/if}
								</span>
								{#if d.state === 'waiting' && d.error}<span class="faint xs">{d.error}</span>{/if}
								{#if d.state === 'downloading'}
									<span class="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={part == null ? undefined : Math.round(part * 100)}>
										<span class="fill" class:unknown={part == null} style="width:{part == null ? 30 : part * 100}%"></span>
									</span>
								{/if}
							</div>
						</div>
						<form method="POST" action="?/remove" use:enhance={reload}>
							<input type="hidden" name="id" value={d.id} />
							<button class="btn small" title="Stop this download">Stop</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	{#if failed.length > 0}
		<section class="card">
			<header class="cardhead">
				<div>
					<h2>Failed</h2>
					<p class="faint sub">
						No source delivered a file that checked out. A kept playlist tries its own again after a day.
					</p>
				</div>
				<form method="POST" action="?/retryFailed" use:enhance={reload}>
					<button class="btn small">Try all {num(failed.length)} again</button>
				</form>
			</header>
			<ul class="rows">
				{#each failed as d (d.id)}
					{@const link = href(d)}
					<li>
						<Cover src={d.track.cover ?? null} alt="{d.track.album} cover" size={40} />
						<div class="text">
							<div class="title">
								{#if link}<a href={link}>{d.track.title}</a>{:else}{d.track.title}{/if}
							</div>
							<div class="faint xs">
								{d.track.artists.join(', ')} · {when(d.updated_ms)}{#if d.playlist} · for {d.playlist}{/if}
							</div>
							{#if d.error}<div class="error xs">{d.error}</div>{/if}
							{#if d.attempts.length > 0}
								<details class="xs faint">
									<summary>{num(d.attempts.length)} {d.attempts.length === 1 ? 'source' : 'sources'} tried</summary>
									<ul class="tried">
										{#each tried(d) as line, i (i)}<li>{line}</li>{/each}
									</ul>
								</details>
							{/if}
						</div>
						<div class="buttons">
							<form method="POST" action="?/retry" use:enhance={reload}>
								<input type="hidden" name="id" value={d.id} />
								<button class="btn small">Retry</button>
							</form>
							<form method="POST" action="?/remove" use:enhance={reload}>
								<input type="hidden" name="id" value={d.id} />
								<button class="btn small quiet" title="Take it off the list">Forget</button>
							</form>
						</div>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
{/if}

<section class="card">
	{#await data.spotify}
		<h2>Kept playlists</h2>
		<p class="faint sub">Asking the engine…</p>
	{:then read}
		{@const spotify = read.ok ? read.value : null}
		{@const kept = spotify ? keptOf(spotify) : []}
		<header class="cardhead">
			<div>
				<h2>Kept playlists</h2>
				{#if spotify}
					<p class="faint sub">
						Every track downloaded and the playlist written as an <span class="mono">.m3u8</span>,
						followed as it changes on Spotify.
						{#if spotify.paused}
							Checks are paused: Spotify is read only when you ask.
						{:else if spotify.checking}
							Checking now…
						{:else}
							Checked {when(spotify.checked_ms)}, next {when(spotify.next_check_ms)}.
						{/if}
					</p>
				{:else if !read.ok}
					<p class="faint sub">{read.error}</p>
				{/if}
			</div>
			{#if spotify}
				<div class="buttons">
					<form method="POST" action="?/check" use:enhance={reload}>
						<button class="btn small" disabled={spotify.checking}>Check now</button>
					</form>
					<form method="POST" action="?/pause" use:enhance={reload}>
						<input type="hidden" name="paused" value={String(!spotify.paused)} />
						<button class="btn small quiet">{spotify.paused ? 'Resume checks' : 'Pause checks'}</button>
					</form>
				</div>
			{/if}
		</header>
		{#if spotify?.error}<p class="error xs">The last check failed: {spotify.error}</p>{/if}

		{#if spotify}
			{#if kept.length === 0}
				<p class="faint sub">None yet. Open a playlist and choose “Keep on the stick”, or paste a link below.</p>
			{:else}
				<ul class="rows">
					{#each kept as p (p.id)}
						{@const part = playlistShare(p)}
						<li>
							<Cover src={p.image ?? null} alt="{p.name} cover" size={40} />
							<div class="text">
								<div class="title">
									<a href="/playlist/{p.id}">{p.name}</a>
									{#if p.linked}<Chip title="Kept by its link; not in your Spotify library">By link</Chip>{/if}
								</div>
								<div class="faint xs">
									{#if p.read_ms}
										<span class="good">{num(p.have)} here</span>{#if p.getting > 0}{' · '}<span
												class="getting">{num(p.getting)} on the way</span
											>{/if}{#if p.missing > 0}{' · '}{num(p.missing)} missing{/if}
										{#if p.file} · <span class="mono">{p.file}</span>{/if}
									{:else}
										{num(p.tracks)} tracks · not read yet
									{/if}
								</div>
								{#if part}
									<span
										class="meter stacked"
										role="img"
										aria-label="{p.have} of {p.have + p.getting + p.missing} in the folder"
									>
										<span class="fill" style="width:{part.have * 100}%"></span><span
											class="fill getting"
											style="width:{part.getting * 100}%"
										></span>
									</span>
								{/if}
								{#if p.error}<div class="error xs">{p.error}</div>{/if}
							</div>
							<div class="buttons">
								<form method="POST" action="?/checkPlaylist" use:enhance={reload}>
									<input type="hidden" name="playlist" value={p.id} />
									<button class="btn small quiet" title="Read it again and retry its failed tracks now">
										Check
									</button>
								</form>
								<form method="POST" action="?/stopKeeping" use:enhance={reload}>
									<input type="hidden" name="playlist" value={p.id} />
									<button
										class="btn small quiet"
										title="Its tracks stay in the folder; its playlist file goes unless you edited it"
									>
										Stop keeping
									</button>
								</form>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
			<form class="add" method="POST" action="?/keepLink" use:enhance={reload}>
				<input
					name="link"
					type="text"
					placeholder="Keep any playlist: paste its Spotify link"
					aria-label="A Spotify playlist link"
					autocomplete="off"
				/>
				<button class="btn small">Keep</button>
			</form>
		{/if}
	{/await}
</section>

{#if queue && done.length > 0}
	<section class="card">
		<header class="cardhead">
			<div>
				<h2>Done</h2>
				<p class="faint sub">The last two weeks, newest first. Forgetting one leaves its file where it is.</p>
			</div>
			<form method="POST" action="?/clearDone" use:enhance={reload}>
				<button class="btn small quiet">Clear the list</button>
			</form>
		</header>
		<div class="scroll-x">
			<table>
				<thead>
					<tr>
						<th>Track</th>
						<th class="wide-only">File</th>
						<th class="wide-only">From</th>
						<th class="r">When</th>
					</tr>
				</thead>
				<tbody>
					{#each done as d (d.id)}
						{@const link = href(d)}
						<tr>
							<td>
								<div class="cell">
									<Cover src={d.track.cover ?? null} alt="{d.track.album} cover" size={32} />
									<div class="text">
										{#if link}<a href={link}>{d.track.title}</a>{:else}{d.track.title}{/if}
										<div class="faint xs">
											{d.track.artists.join(', ')}{#if d.playlist} · for {d.playlist}{/if}
										</div>
									</div>
								</div>
							</td>
							<td class="muted xs wide-only file">{d.file ?? '—'}</td>
							<td class="muted xs wide-only nowrap">
								{d.source === 'library' ? 'already in the folder' : (d.source ?? '—')}{#if d.quality}<div class="faint">{d.quality}</div>{/if}
							</td>
							<td class="r muted xs nowrap">{when(d.updated_ms)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
{/if}

{#if queue}
	<div class="split">
		<section class="card">
			<h2>Sources</h2>
			<p class="faint sub">
				Free community mirrors that come and go, in the order the next download tries them: by a running
				average of how reliable and fast each has been.
			</p>
			<div class="scroll-x">
				<table>
					<thead>
						<tr>
							<th class="r">#</th>
							<th>Mirror</th>
							<th class="r">Works</th>
							<th class="r wide-only">Speed</th>
							<th class="r wide-only">Got</th>
						</tr>
					</thead>
					<tbody>
						{#each sources as s (s.id)}
							{@const resting = s.resting_until_ms != null && s.resting_until_ms > Date.now()}
							<tr class:resting>
								<td class="r num faint">{s.rank}</td>
								<td>
									<div>{s.source}</div>
									<div class="faint xs host">
										{s.host}{#if resting} · resting until {new Date(s.resting_until_ms ?? 0).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}{/if}
									</div>
									{#if s.last_error && resting}<div class="error xs host">{s.last_error}</div>{/if}
								</td>
								<td class="r num" class:faint={s.reliability < 0.5}>{Math.round(s.reliability * 100)}%</td>
								<td class="r num muted wide-only nowrap">
									{s.speed_kbps == null ? '—' : s.speed_kbps >= 1000 ? `${(s.speed_kbps / 1000).toFixed(1)} MB/s` : `${Math.round(s.speed_kbps)} kB/s`}
								</td>
								<td class="r num muted wide-only">{num(s.downloads)}</td>
							</tr>
						{:else}
							<tr><td colspan="5" class="faint">No sources are on.</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>

		<div class="side">
			<section class="card">
				<h2>Filing</h2>
				<form method="POST" action="?/settings" use:enhance={reload} class="setting">
					<label>
						<input
							type="checkbox"
							name="aiff"
							checked={queue.settings.aiff}
							onchange={(e) => e.currentTarget.form?.requestSubmit()}
						/>
						<span>
							Convert FLAC to AIFF
							<span class="faint xs">
								For players that don't play FLAC: downloads and imports are filed as AIFF from now on, the
								same samples with the tags in an ID3 chunk. What is in the folder stays as it is.
							</span>
						</span>
					</label>
					<noscript><button class="btn small">Save</button></noscript>
				</form>
			</section>

			{#if data.activity.ok && data.activity.value.length > 0}
				<section class="card">
					<h2>What the playlists did</h2>
					<ul class="activity">
						{#each data.activity.value as a (a.id)}
							<li>
								<span class="xs faint nowrap">{when(a.ms)}</span>
								<span class="small">
									{#if a.name}
										{#if a.playlist}<a href="/playlist/{a.playlist}">{a.name}</a>{:else}{a.name}{/if}:
									{/if}
									{ACTIVITY[a.kind]?.(a) ?? a.kind}
								</span>
							</li>
						{/each}
					</ul>
				</section>
			{/if}
		</div>
	</div>
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
		max-width: 64ch;
	}
	.alert {
		padding: 10px 16px;
		border-radius: var(--radius-sm);
		margin-bottom: var(--gap);
		background: rgba(244, 63, 94, 0.12);
		border: 1px solid rgba(244, 63, 94, 0.32);
		font-size: 0.88rem;
	}
	.alert.warn {
		background: rgba(251, 191, 36, 0.1);
		border-color: rgba(251, 191, 36, 0.3);
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
		max-width: 80ch;
	}
	.cardhead {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 8px 16px;
		flex-wrap: wrap;
		margin-bottom: 12px;
	}
	.cardhead .sub {
		margin: 0;
	}
	.buttons {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.btn.small {
		padding: 6px 13px;
		font-size: 0.8rem;
	}
	.btn.quiet {
		color: var(--text-muted);
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.xs {
		font-size: 0.75rem;
	}
	.small {
		font-size: 0.85rem;
	}
	.mono {
		font-family: var(--mono);
		font-size: 0.92em;
	}
	.good {
		color: var(--good);
	}
	.getting {
		color: #c4b5fd;
	}
	.error {
		color: var(--bad);
		overflow-wrap: anywhere;
	}
	.nowrap {
		white-space: nowrap;
	}

	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.rows > li {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 9px 0;
		border-top: 1px solid rgba(255, 255, 255, 0.04);
	}
	.rows > li:first-child {
		border-top: 0;
	}
	.text {
		flex: 1;
		min-width: 0;
	}
	.title {
		line-height: 1.3;
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.progress {
		margin-top: 4px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.phase {
		font-size: 0.76rem;
		color: #c4b5fd;
	}
	.phase.waiting {
		color: var(--warn);
	}
	.meter {
		display: flex;
		height: 4px;
		max-width: 320px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.06);
		overflow: hidden;
	}
	.meter.stacked {
		margin-top: 6px;
	}
	.fill {
		display: block;
		height: 100%;
		background: linear-gradient(90deg, var(--accent), var(--accent-2));
		transition: width 0.6s ease;
	}
	.meter.stacked .fill {
		background: var(--good);
	}
	.meter.stacked .fill.getting {
		background: var(--accent);
	}
	.fill.unknown {
		animation: slide 1.4s ease-in-out infinite;
	}
	@keyframes slide {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(340%);
		}
	}
	details summary {
		cursor: pointer;
		margin-top: 3px;
	}
	.tried {
		margin: 4px 0 0;
		padding-left: 16px;
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
		white-space: nowrap;
	}
	td {
		padding: 7px 10px 7px 0;
		border-bottom: 1px solid rgba(255, 255, 255, 0.03);
		vertical-align: middle;
	}
	th.r,
	td.r {
		text-align: right;
	}
	td:last-child,
	th:last-child {
		padding-right: 0;
	}
	tr.resting td {
		opacity: 0.6;
	}
	.cell {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.file {
		overflow-wrap: anywhere;
		max-width: 320px;
	}
	.host {
		overflow-wrap: anywhere;
	}
	.ex {
		display: inline-block;
		margin-left: 5px;
		font-size: 0.62rem;
		padding: 0 4px;
		border-radius: 3px;
		background: rgba(255, 255, 255, 0.08);
		color: var(--text-faint);
		vertical-align: middle;
	}
	a:hover {
		text-decoration: underline;
	}

	.add {
		display: flex;
		gap: 8px;
		margin-top: 12px;
	}
	.add input {
		flex: 1;
		min-width: 0;
		padding: 7px 12px;
		border-radius: 999px;
		border: 1px solid var(--hairline-strong);
		background: var(--bg-elevated);
		font-size: 0.84rem;
	}

	.split {
		display: grid;
		grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
		gap: var(--gap);
		align-items: start;
	}
	.split > .card,
	.side > .card:last-child {
		margin-bottom: 0;
	}
	@media (max-width: 820px) {
		.split {
			grid-template-columns: 1fr;
		}
	}
	.setting label {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		cursor: pointer;
		margin-top: 10px;
		font-size: 0.88rem;
	}
	.setting input {
		margin-top: 4px;
		accent-color: var(--accent);
	}
	.setting .xs {
		display: block;
		margin-top: 2px;
	}
	.activity {
		list-style: none;
		margin: 10px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.activity li {
		display: grid;
		grid-template-columns: 92px 1fr;
		gap: 10px;
		align-items: baseline;
	}
</style>
