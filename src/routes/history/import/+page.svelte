<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { num, pct, relativeTime, shortDate } from '$lib/utils/format.ts';

	let { data, form } = $props();

	let file = $state<File | null>(null);
	let uploading = $state(false);
	let uploadPct = $state(0);
	let uploadError = $state<string | null>(null);

	const running = $derived(
		data.imports.some((i) => i.status === 'queued' || i.status === 'running')
	);

	/**
	 * XHR rather than fetch: this is the one place a progress event matters, and
	 * `fetch` still cannot report upload progress. The body is the File itself —
	 * no multipart wrapper — so the server streams it straight to disk.
	 */
	function upload(event: SubmitEvent) {
		event.preventDefault();
		if (!file || uploading) return;
		uploading = true;
		uploadPct = 0;
		uploadError = null;

		const xhr = new XMLHttpRequest();
		xhr.open('POST', `/api/history/upload?name=${encodeURIComponent(file.name)}`);
		xhr.upload.addEventListener('progress', (e) => {
			if (e.lengthComputable) uploadPct = e.loaded / e.total;
		});
		xhr.addEventListener('load', () => {
			uploading = false;
			if (xhr.status >= 200 && xhr.status < 300) {
				file = null;
				void invalidateAll();
			} else {
				uploadError = readError(xhr.responseText, xhr.status);
			}
		});
		xhr.addEventListener('error', () => {
			uploading = false;
			uploadError = 'The upload failed before it reached the server.';
		});
		xhr.send(file);
	}

	function readError(body: string, status: number): string {
		try {
			return (JSON.parse(body) as { message?: string }).message ?? `Upload failed (${status})`;
		} catch {
			return `Upload failed (${status})`;
		}
	}

	/** While an import runs, the page refreshes itself to move the bar. */
	$effect(() => {
		if (!running) return;
		const timer = setInterval(() => void invalidateAll(), 1500);
		return () => clearInterval(timer);
	});

	const STATUS_LABEL: Record<string, string> = {
		queued: 'Queued',
		running: 'Importing',
		completed: 'Done',
		failed: 'Failed',
		cancelled: 'Cancelled'
	};
</script>

<svelte:head><title>Import listening history · Spotidata</title></svelte:head>

<header class="head">
	<div>
		<h1>Listening history</h1>
		<p class="muted">
			Spotify's API only ever returns the last 50 plays. Everything before that has to come from
			an export. <a href="/history">Back to the charts →</a>
		</p>
	</div>
</header>

<section class="tiles">
	<div class="tile">
		<span class="label">Plays stored</span>
		<span class="value num">{num(data.stats.plays)}</span>
		<span class="sub faint">
			{#if data.stats.plays > 0}
				{shortDate(data.stats.firstPlayed)} — {shortDate(data.stats.lastPlayed)}
			{:else}
				nothing yet
			{/if}
		</span>
	</div>
	<div class="tile">
		<span class="label">Matched to the catalog</span>
		<span class="value num">
			{pct(data.stats.plays > 0 ? data.stats.resolved / data.stats.plays : null, 1)}
		</span>
		<span class="sub faint">{num(data.stats.resolved)} of {num(data.stats.plays)}</span>
	</div>
	<div class="tile">
		<span class="label">Waiting to be looked up</span>
		<span class="value num">{num(data.stats.pending)}</span>
		<span class="sub faint">fetched by the next sync</span>
	</div>
	<div class="tile">
		<span class="label">Saved but never played</span>
		<span class="value num">{num(data.stats.savedNeverPlayed)}</span>
		<span class="sub faint">recordings in your library</span>
	</div>
</section>

{#if data.missingScopes.length > 0}
	<div class="alert">
		Your Spotify authorization predates the listening features and is missing
		<code>{data.missingScopes.join(', ')}</code>. Polling recently-played will fail until you
		<a href="/auth/login">re-authorize</a> — your data is kept.
	</div>
{/if}

<div class="grid two">
	<section class="card">
		<h2>Upload the archive</h2>
		<p class="faint sub">
			The <strong>Extended streaming history</strong> zip, as Spotify emailed it — up to
			{data.maxUploadMb} MB. It is read once and deleted.
		</p>

		<form onsubmit={upload}>
			<label class="drop" class:has={file !== null}>
				<input
					type="file"
					accept=".zip,application/zip"
					disabled={uploading}
					onchange={(e) => (file = e.currentTarget.files?.[0] ?? null)}
				/>
				{#if file}
					<strong>{file.name}</strong>
					<span class="faint">{(file.size / 1024 / 1024).toFixed(0)} MB</span>
				{:else}
					<strong>Choose a .zip</strong>
					<span class="faint">my_spotify_data.zip</span>
				{/if}
			</label>

			{#if uploading}
				<div class="bar"><div class="fill" style="width:{uploadPct * 100}%"></div></div>
				<p class="faint small">Uploading — {pct(uploadPct, 0)}</p>
			{/if}
			{#if uploadError}<p class="err">{uploadError}</p>{/if}

			<button type="submit" disabled={!file || uploading}>
				{uploading ? 'Uploading…' : 'Upload and import'}
			</button>
		</form>
	</section>

	<section class="card">
		<h2>Or point at a folder</h2>
		<p class="faint sub">
			Nothing is copied and nothing is deleted — the fastest route when the download is already
			on this machine. A folder or a .zip both work.
		</p>

		<form method="POST" action="?/fromPath" use:enhance>
			<input
				type="text"
				name="path"
				placeholder="~/Downloads/my_spotify_data"
				spellcheck="false"
				autocapitalize="off"
			/>
			<button type="submit">Import from path</button>
		</form>

		{#if form?.error}<p class="err">{form.error}</p>{/if}
		{#if form?.queued}<p class="ok">Queued as import #{form.queued}.</p>{/if}
		{#if form?.undone !== undefined}<p class="ok">Removed {num(form.undone)} plays.</p>{/if}
		{#if form?.retried !== undefined}
			<p class="ok">Cleared {num(form.retried)} marks and started a sync.</p>
		{/if}
	</section>
</div>

<section class="card">
	<header class="cardhead">
		<div>
			<h2>Imports</h2>
			<p class="faint sub">
				Re-importing the same archive is free — every play is keyed on when it ended, so a
				second pass inserts nothing.
			</p>
		</div>
		{#if data.stats.unresolvable > 0}
			<form method="POST" action="?/retry" use:enhance>
				<button class="ghost" type="submit">
					Retry {num(data.stats.unresolvable)} unmatched
				</button>
			</form>
		{/if}
	</header>

	<div class="scroll-x">
		<table>
			<thead>
				<tr>
					<th>Archive</th>
					<th>Status</th>
					<th class="r">Read</th>
					<th class="r">New</th>
					<th class="r">Already had</th>
					<th class="pad">Period covered</th>
					<th>When</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				{#each data.imports as i (i.id)}
					<tr>
						<td class="ellipsis" title={i.label}>{i.label}</td>
						<td>
							<span class="pill {i.status}">{STATUS_LABEL[i.status] ?? i.status}</span>
							{#if i.status === 'running' && i.files > 0}
								<span class="faint small">{i.filesDone}/{i.files} files</span>
							{/if}
							{#if i.error}<div class="err small">{i.error}</div>{/if}
						</td>
						<td class="r num">{num(i.rowsRead)}</td>
						<td class="r num">{num(i.playsInserted)}</td>
						<td class="r num faint">{num(i.duplicates)}</td>
						<td class="faint small nowrap pad">
							{#if i.firstPlayedAt}{i.firstPlayedAt} → {i.lastPlayedAt}{:else}—{/if}
						</td>
						<td class="faint small nowrap">{relativeTime(i.createdAt)}</td>
						<td class="r">
							{#if i.livePlays > 0}
								<form method="POST" action="?/undo" use:enhance>
									<input type="hidden" name="id" value={i.id} />
									<button
										class="ghost danger"
										type="submit"
										title="Delete the {i.livePlays} plays this import added"
									>
										Undo
									</button>
								</form>
							{/if}
						</td>
					</tr>
				{:else}
					<tr><td colspan="8" class="empty faint">No imports yet.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
</section>

<section class="card prose">
	<h2>Getting the file</h2>
	<ol>
		<li>
			Open <a href="https://www.spotify.com/account/privacy/" rel="noreferrer">Spotify's privacy
			page</a> and tick <strong>Extended streaming history</strong>. It is the second checkbox —
			the first one is a much smaller export that only covers a year, times plays to the minute
			and carries no track ids, and the importer refuses it for that reason.
		</li>
		<li>Confirm the email Spotify sends. The archive itself takes about a month.</li>
		<li>Upload the zip here, or unzip it and point at the folder.</li>
	</ol>
	<p class="faint">
		Between exports, <code>/me/player/recently-played</code> is polled every 20 minutes, which
		keeps the log current so long as you do not play more than 50 tracks in that window. The API
		reports no duration, so a polled play's listening time is inferred from the gap back to the
		previous one, capped at the track's length, and shown as <code>~3:12</code>; the first play
		after a break has nothing to measure against and counts as a play with no time. An import
		always wins over a poll for the span it covers, and replaces every estimate in it with what
		Spotify actually recorded.
	</p>
</section>

<style>
	.head {
		margin-bottom: var(--gap);
	}
	.head p {
		margin: 4px 0 0;
		font-size: 0.86rem;
		max-width: 72ch;
	}
	.head p a,
	.prose a {
		text-decoration: underline;
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(168px, 1fr));
		gap: var(--gap);
		margin-bottom: var(--gap);
	}
	.tile {
		background: var(--card);
		border: 1px solid var(--hairline);
		border-radius: var(--radius);
		padding: 15px 17px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.label {
		font-size: 0.76rem;
		color: var(--text-muted);
	}
	.value {
		font-size: 1.5rem;
		letter-spacing: -0.02em;
	}
	.sub {
		font-size: 0.76rem;
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
		padding: var(--card-py) var(--card-px);
		margin-bottom: var(--gap);
	}
	.card .sub {
		margin: 2px 0 14px;
		font-size: 0.8rem;
		max-width: 62ch;
	}
	.cardhead {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}
	.drop {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 4px;
		padding: 26px 18px;
		border: 1px dashed var(--hairline-strong);
		border-radius: var(--radius-sm);
		cursor: pointer;
		text-align: center;
		font-size: 0.88rem;
	}
	.drop:hover {
		border-color: var(--accent-2);
	}
	.drop.has {
		border-style: solid;
		border-color: var(--accent-2);
	}
	.drop input {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
	}
	.bar {
		height: 6px;
		margin-top: 12px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.07);
		overflow: hidden;
	}
	.fill {
		height: 100%;
		background: linear-gradient(90deg, var(--accent), var(--accent-2));
		transition: width 0.2s linear;
	}
	input[type='text'] {
		width: 100%;
		padding: 9px 12px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--hairline);
		background: rgba(255, 255, 255, 0.03);
		color: var(--text);
		font-size: 0.88rem;
		font-family: inherit;
	}
	button {
		margin-top: 12px;
		padding: 9px 18px;
		border-radius: 999px;
		border: 0;
		background: var(--accent-soft);
		color: #ddd6fe;
		font-size: 0.86rem;
		font-family: inherit;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	button.ghost {
		margin: 0;
		padding: 5px 12px;
		background: none;
		border: 1px solid var(--hairline);
		color: var(--text-muted);
		font-size: 0.78rem;
	}
	button.ghost:hover {
		color: var(--text);
		border-color: var(--hairline-strong);
	}
	button.danger:hover {
		color: #fda4af;
		border-color: rgba(244, 63, 94, 0.5);
	}
	.err {
		margin: 10px 0 0;
		color: #fda4af;
		font-size: 0.84rem;
	}
	.ok {
		margin: 10px 0 0;
		color: #86efac;
		font-size: 0.84rem;
	}
	.alert {
		padding: 10px 16px;
		border-radius: var(--radius-sm);
		margin-bottom: var(--gap);
		background: rgba(251, 191, 36, 0.1);
		border: 1px solid rgba(251, 191, 36, 0.3);
		font-size: 0.86rem;
	}
	.alert a {
		text-decoration: underline;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.88rem;
		min-width: 760px;
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
		padding: 8px 10px 8px 0;
		border-bottom: 1px solid rgba(255, 255, 255, 0.03);
		vertical-align: top;
	}
	th.r,
	td.r {
		text-align: right;
	}
	/* The right-aligned counts end flush against the next column; this is the
	   gutter that keeps "Already had" from reading as part of the date span. */
	.pad {
		padding-left: 18px;
	}
	.pill {
		display: inline-block;
		padding: 2px 9px;
		border-radius: 999px;
		font-size: 0.74rem;
		border: 1px solid var(--hairline);
		color: var(--text-muted);
	}
	.pill.running,
	.pill.queued {
		color: #c4b5fd;
		border-color: rgba(124, 58, 237, 0.5);
	}
	.pill.completed {
		color: #86efac;
		border-color: rgba(34, 197, 94, 0.35);
	}
	.pill.failed {
		color: #fda4af;
		border-color: rgba(244, 63, 94, 0.4);
	}
	.ellipsis {
		max-width: 28ch;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.nowrap {
		white-space: nowrap;
	}
	.small {
		font-size: 0.78rem;
	}
	.empty {
		padding: 26px 0;
		text-align: center;
	}
	.prose ol {
		margin: 0 0 14px;
		padding-left: 20px;
		font-size: 0.88rem;
		max-width: 78ch;
	}
	.prose li {
		margin-bottom: 8px;
	}
	.prose p {
		font-size: 0.84rem;
		max-width: 78ch;
	}
	code {
		font-size: 0.85em;
		padding: 1px 5px;
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.06);
	}
</style>
