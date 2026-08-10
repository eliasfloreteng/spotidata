<script lang="ts">
	import { enhance } from '$app/forms';
	import ArtistLinks from '$lib/components/ArtistLinks.svelte';
	import Chip from '$lib/components/Chip.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import Pager from '$lib/components/Pager.svelte';
	import SearchBox from '$lib/components/SearchBox.svelte';
	import SpotifyLink from '$lib/components/SpotifyLink.svelte';
	import { num, relativeTime, shortDate, trackTime } from '$lib/utils/format.ts';
	import { trackHref } from '$lib/utils/qs.ts';

	let { data, form } = $props();

	let showSettings = $state(false);
	let showHistory = $state(false);

	const a = $derived(data.automation);
	const attached = $derived(new Set(data.sources.map((s) => s.playlistId)));
	/** Playlists not already feeding this one — the datalist for the add field. */
	const addable = $derived(
		data.playlists.filter((p) => !attached.has(p.id) && p.id !== a.spotifyPlaylistId)
	);
</script>

<svelte:head><title>{a.name} · Automations · Spotidata</title></svelte:head>

<header class="head">
	<div>
		<p class="crumb"><a href="/automations">Automations</a> /</p>
		<h1>{a.name}</h1>
		<p class="muted">
			{#if data.total > 0}
				{num(data.total)} track{data.total === 1 ? '' : 's'} waiting to be added from
			{:else}
				Nothing waiting from
			{/if}
			{data.sources.length} source playlist{data.sources.length === 1 ? '' : 's'} · {num(
				a.addedTrackCount
			)} added so far
		</p>
	</div>
	<SearchBox value={data.q} placeholder="Search these tracks" />
</header>

{#if form?.error}
	<div class="notice bad">{form.error}</div>
{:else if form?.run}
	<div class="notice good">
		{form.run.message}
		{#if form.run.requests}<span class="faint">({form.run.requests} API requests)</span>{/if}
	</div>
{/if}

{#if !data.canWrite}
	<div class="notice">
		This Spotify authorization cannot modify playlists.
		<a href="/auth/login">Re-authorize</a> to let this automation fill one.
	</div>
{/if}

<section class="card playlist">
	<div class="state">
		{#if a.spotifyPlaylistId}
			<div class="row">
				<Chip tone={a.lastRunError ? 'bad' : 'good'}>
					{a.lastRunError ? 'last run failed' : `${num(a.addedTrackCount)} tracks added`}
				</Chip>
				<SpotifyLink kind="playlist" id={a.spotifyPlaylistId} label="Open the playlist" />
			</div>
			<p class="faint xs">
				{#if a.lastRunAt}Last ran {relativeTime(a.lastRunAt)}{#if a.lastAddedCount}, adding {num(
						a.lastAddedCount
					)}{/if}.{/if}
				{a.autoRun
					? 'Runs hourly and after every sync.'
					: 'Automatic runs are off — it only collects when you press the button.'}
			</p>
			<p class="faint xs">
				It only ever appends. Add, reorder or delete tracks in Spotify freely — a track you remove
				stays removed.
			</p>
			{#if a.lastRunError}<p class="err xs">{a.lastRunError}</p>{/if}
		{:else}
			<p class="faint small">
				No playlist yet. Running creates one called “{a.name}” and puts {num(data.total)} track{data.total ===
				1
					? ''
					: 's'} in it.
			</p>
			<!-- Or feed a playlist that already exists. Its current contents are
			     recorded on the first run, not pushed — nothing already there is
			     touched, and nothing gets added twice. -->
			<form class="link" method="POST" action="?/link" use:enhance>
				<label class="sr" for="destination">Use an existing playlist</label>
				<input
					id="destination"
					name="playlist"
					list="destination-options"
					placeholder="…or feed a playlist you already have"
					autocomplete="off"
				/>
				<datalist id="destination-options">
					{#each addable.filter((p) => p.isOwned) as p (p.id)}
						<option value={p.id}>{p.name} — {num(p.tracks)} tracks</option>
					{/each}
				</datalist>
				<button class="ghost" type="submit">Use it</button>
			</form>
		{/if}
	</div>

	<div class="actions">
		<form method="POST" action="?/run" use:enhance>
			<button class="primary" type="submit" disabled={!data.canWrite || data.sources.length === 0}>
				{a.spotifyPlaylistId ? 'Run now' : 'Create playlist'}
			</button>
		</form>
		<button class="ghost" onclick={() => (showSettings = !showSettings)}>
			{showSettings ? 'Close settings' : 'Settings'}
		</button>
	</div>
</section>

{#if showSettings}
	<form class="card settings" method="POST" action="?/settings" use:enhance>
		<div class="field">
			<label for="name">Name</label>
			<input id="name" name="name" value={a.name} maxlength="100" required />
		</div>
		<div class="field wide">
			<label for="description">Playlist description</label>
			<input
				id="description"
				name="description"
				value={a.description ?? ''}
				maxlength="250"
				placeholder="Only used when the playlist is created"
			/>
		</div>
		<label class="check">
			<input type="checkbox" name="autoRun" checked={a.autoRun} />
			Collect automatically, every hour
		</label>
		<label class="check">
			<input type="checkbox" name="backfill" checked={a.backfill} />
			New sources bring everything they already hold
		</label>
		<label class="check">
			<input type="checkbox" name="playlistPublic" checked={a.playlistPublic} />
			Public playlist (applies when it is created)
		</label>

		<div class="save">
			<button class="primary" type="submit">Save</button>
			{#if a.spotifyPlaylistId}
				<button
					class="ghost"
					type="submit"
					formaction="?/unlink"
					title="Leaves the playlist untouched on Spotify, and forgets what was added to it"
				>
					Forget the playlist
				</button>
			{/if}
			<button class="danger" type="submit" formaction="?/delete">Delete automation</button>
		</div>
	</form>
{/if}

<section class="card sources">
	<div class="section-head">
		<h2>Sources</h2>
		<span class="faint xs">Spotify's API cannot see folders — a folder is the playlists you pick.</span>
	</div>

	{#if data.sources.length}
		<ul class="source-list">
			{#each data.sources as s (s.playlistId)}
				<li>
					<Cover src={s.cover} alt="{s.name ?? s.label ?? 'Playlist'} cover" size={34} />
					<div class="who">
						<div class="title">
							<a href="/playlist/{s.playlistId}">{s.name ?? s.label ?? s.playlistId}</a>
							{#if s.isOwned === false}<span class="faint xs">· {s.ownerName ?? 'followed'}</span
								>{/if}
						</div>
						<div class="faint xs">
							{num(s.tracks)} tracks · {num(s.contributed)} taken
							{#if s.itemsSyncedAt}· read {relativeTime(s.itemsSyncedAt)}{:else}· not fetched yet{/if}
						</div>
					</div>
					<SpotifyLink kind="playlist" id={s.playlistId} compact label="Open in Spotify" />
					<form method="POST" action="?/removeSource" use:enhance>
						<input type="hidden" name="playlist" value={s.playlistId} />
						<button class="x" type="submit" title="Stop collecting from this playlist">×</button>
					</form>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="faint small">
			No sources yet. Everything in the playlists you add here gets collected into one.
		</p>
	{/if}

	<form class="add" method="POST" action="?/addSource" use:enhance>
		<label class="sr" for="playlist">Add a source playlist</label>
		<input
			id="playlist"
			name="playlist"
			list="playlist-options"
			placeholder="Pick a playlist, or paste a Spotify link…"
			autocomplete="off"
		/>
		<!-- The value is the id, so the datalist doubles as an id-or-link field:
		     a playlist this database has never seen is fetched on demand. -->
		<datalist id="playlist-options">
			{#each addable as p (p.id)}
				<option value={p.id}>{p.name} — {num(p.tracks)} tracks</option>
			{/each}
		</datalist>
		<button class="ghost" type="submit">Add source</button>
	</form>
</section>

<section class="card">
	<div class="section-head">
		<h2>Waiting to be added</h2>
		{#if a.addedTrackCount > 0}
			<button class="ghost small" onclick={() => (showHistory = !showHistory)}>
				{showHistory ? 'Back to pending' : 'What it has added'}
			</button>
		{/if}
	</div>

	{#if showHistory}
		<div class="scroll-x">
			<table>
				<thead>
					<tr>
						<th>Track</th>
						<th>Artist</th>
						<th>From</th>
						<th class="r">Added</th>
						<th class="r"><span class="sr">Spotify</span></th>
					</tr>
				</thead>
				<tbody>
					{#each data.contributed as t (t.trackId)}
						<tr>
							<td>
								<div class="cell">
									<Cover src={t.cover} alt="{t.albumName ?? t.title} cover" size={34} />
									<div>
										<div class="title">{t.title}</div>
										<div class="faint xs">
											{#if t.albumId}<a href="/album/{t.albumId}">{t.albumName}</a>{:else}—{/if}
										</div>
									</div>
								</div>
							</td>
							<td class="muted small"><ArtistLinks artists={t.artists} /></td>
							<td class="muted small">
								{#if t.sourcePlaylistId}
									<a href="/playlist/{t.sourcePlaylistId}">{t.sourceName ?? t.sourcePlaylistId}</a>
								{:else}—{/if}
							</td>
							<td class="r muted small nowrap">{shortDate(t.addedAt)}</td>
							<td class="r">
								<SpotifyLink kind="track" id={t.trackId} compact label="Open {t.title} in Spotify" />
							</td>
						</tr>
					{:else}
						<tr><td colspan="5" class="none faint">Nothing added yet.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="faint xs foot">The {num(data.contributed.length)} most recent. A track listed here is never offered again, even if you delete it from the playlist.</p>
	{:else}
		<div class="scroll-x">
			<table>
				<thead>
					<tr>
						<th>Track</th>
						<th>Artist</th>
						<th>From</th>
						<th class="r">Length</th>
						<th class="r">In source since</th>
						<th class="r"><span class="sr">Spotify</span></th>
					</tr>
				</thead>
				<tbody>
					{#each data.rows as t (t.trackId)}
						<tr>
							<td>
								<div class="cell">
									<Cover src={t.cover} alt="{t.albumName ?? t.title} cover" size={34} />
									<div>
										<div class="title">
											{#if t.canonicalTrackId}
												<a href={trackHref(t.canonicalTrackId)}>{t.title}</a>
											{:else}{t.title}{/if}
										</div>
										<div class="faint xs">
											{#if t.albumId}<a href="/album/{t.albumId}">{t.albumName}</a>{:else}—{/if}
										</div>
									</div>
								</div>
							</td>
							<td class="muted small"><ArtistLinks artists={t.artists} /></td>
							<td class="muted small">
								<a href="/playlist/{t.sourcePlaylistId}">{t.sourceName ?? t.sourcePlaylistId}</a>
							</td>
							<td class="r num muted">{trackTime(t.durationMs)}</td>
							<td class="r muted small nowrap">{t.addedAt ? shortDate(t.addedAt) : '—'}</td>
							<td class="r">
								<SpotifyLink kind="track" id={t.trackId} compact label="Open {t.title} in Spotify" />
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="6" class="none faint">
								{data.sources.length
									? 'Nothing new — everything the sources hold is already accounted for.'
									: 'Add a source playlist and its tracks appear here.'}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<Pager
			page={data.page}
			pages={data.pages}
			total={data.total}
			pageSize={data.pageSize}
			unit="tracks"
		/>
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
	.crumb {
		margin: 0 0 2px;
		font-size: 0.76rem;
		color: var(--text-faint);
	}
	.crumb a:hover {
		text-decoration: underline;
	}
	.head p.muted {
		margin: 4px 0 0;
		font-size: 0.86rem;
		max-width: 66ch;
	}
	.card {
		padding: var(--card-py) var(--card-px);
		margin-bottom: var(--gap);
	}
	.notice {
		padding: 10px 16px;
		border-radius: var(--radius-sm);
		margin-bottom: var(--gap);
		font-size: 0.86rem;
		background: rgba(251, 191, 36, 0.1);
		border: 1px solid rgba(251, 191, 36, 0.3);
	}
	.notice.bad {
		background: rgba(244, 63, 94, 0.12);
		border-color: rgba(244, 63, 94, 0.32);
	}
	.notice.good {
		background: rgba(52, 211, 153, 0.1);
		border-color: rgba(52, 211, 153, 0.3);
	}
	.notice a {
		text-decoration: underline;
	}
	.playlist {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
	}
	.state .row {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.state p {
		margin: 8px 0 0;
		max-width: 68ch;
	}
	.err {
		color: var(--bad);
		max-width: 70ch;
	}
	.actions {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.settings {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 14px 18px;
		align-items: end;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 5px;
		min-width: 0;
	}
	.field.wide {
		grid-column: 1 / -1;
	}
	label {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-faint);
	}
	.check {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.82rem;
		text-transform: none;
		letter-spacing: 0;
		color: var(--text-muted);
	}
	.check input {
		accent-color: var(--accent-2);
		width: 16px;
		height: 16px;
	}
	.save {
		grid-column: 1 / -1;
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		border-top: 1px solid var(--hairline);
		padding-top: 12px;
	}
	input {
		padding: 7px 12px;
		border-radius: 999px;
		border: 1px solid var(--hairline-strong);
		background: var(--bg-elevated);
		color: var(--text);
		font-size: 0.84rem;
		font-family: inherit;
		outline: none;
		min-width: 0;
	}
	input:focus {
		border-color: rgba(124, 58, 237, 0.6);
	}
	.primary,
	.ghost,
	.danger {
		border-radius: 999px;
		border: 1px solid var(--hairline-strong);
		background: var(--bg-elevated);
		color: var(--text-muted);
		font-family: inherit;
		font-size: 0.82rem;
		padding: 8px 16px;
		cursor: pointer;
	}
	.primary {
		color: #ddd6fe;
		background: var(--accent-soft);
		border-color: rgba(124, 58, 237, 0.45);
	}
	.primary:hover:not(:disabled) {
		border-color: rgba(124, 58, 237, 0.9);
	}
	.primary:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.ghost:hover {
		color: var(--text);
	}
	.ghost.small {
		padding: 5px 12px;
		font-size: 0.78rem;
	}
	.danger {
		color: var(--bad);
		border-color: rgba(244, 63, 94, 0.35);
		margin-left: auto;
	}
	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 12px;
		flex-wrap: wrap;
	}
	.section-head h2 {
		margin: 0;
		font-size: 0.95rem;
	}
	.source-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 4px;
	}
	.source-list li {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 5px 0;
		border-bottom: 1px solid rgba(255, 255, 255, 0.03);
	}
	.who {
		min-width: 0;
		flex: 1;
	}
	.who .title {
		font-size: 0.88rem;
		line-height: 1.3;
	}
	.x {
		border: 1px solid var(--hairline-strong);
		background: var(--bg-elevated);
		color: var(--text-faint);
		border-radius: 999px;
		width: 26px;
		height: 26px;
		font-size: 0.95rem;
		line-height: 1;
		font-family: inherit;
		cursor: pointer;
	}
	.x:hover {
		color: var(--bad);
		border-color: rgba(244, 63, 94, 0.5);
	}
	.add,
	.link {
		display: flex;
		gap: 8px;
		margin-top: 14px;
	}
	.add input,
	.link input {
		flex: 0 1 340px;
	}
	.link {
		margin-top: 10px;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
		min-width: 820px;
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
	}
	th.r,
	td.r {
		text-align: right;
	}
	th:last-child,
	td:last-child {
		padding-right: 0;
	}
	.cell {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.cell .title {
		line-height: 1.3;
	}
	.small {
		font-size: 0.82rem;
	}
	.xs {
		font-size: 0.73rem;
	}
	.foot {
		margin: 10px 0 0;
	}
	.nowrap {
		white-space: nowrap;
	}
	.none {
		padding: 28px 0;
		text-align: center;
	}
	a:hover {
		text-decoration: underline;
	}
	/* See the note in /library: absolute positioning would escape the scroll lane. */
	.sr {
		display: inline-block;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	@media (max-width: 640px) {
		.playlist,
		.actions {
			width: 100%;
		}
		.actions button,
		.actions form {
			flex: 1;
		}
		.danger {
			margin-left: 0;
		}
	}
</style>
