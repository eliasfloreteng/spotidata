<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import ArtistLinks from '$lib/components/ArtistLinks.svelte';
	import Chip from '$lib/components/Chip.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import Pager from '$lib/components/Pager.svelte';
	import SearchBox from '$lib/components/SearchBox.svelte';
	import SpotifyLink from '$lib/components/SpotifyLink.svelte';
	import { longDuration, num, relativeTime, shortDate, trackTime } from '$lib/utils/format.ts';
	import { genreHref, trackHref } from '$lib/utils/qs.ts';

	let { data, form } = $props();

	const SORT_LABELS: Record<string, string> = {
		added: 'Recently added',
		plays: 'Most played',
		listened: 'Most listened',
		popularity: 'Most popular',
		released: 'Newest release',
		title: 'Title',
		artist: 'Artist',
		random: 'Shuffled (stable)'
	};

	let showSettings = $state(false);

	/**
	 * Adding genres is a repeated action, so the field empties itself and keeps
	 * focus — the default would leave "disco" sitting there while you type the
	 * next one. Everything else about `enhance` stays default: apply the result,
	 * reload the collection, which is where the new track list comes from.
	 */
	const clearOnSuccess: SubmitFunction = () => {
		return async ({ result, update }) => {
			await update();
			if (result.type === 'success') {
				const field = document.querySelector<HTMLInputElement>('#genre');
				if (field) {
					field.value = '';
					field.focus();
				}
			}
		};
	};

	const c = $derived(data.collection);
	/** Everything past the limit is shown, greyed — it is what the next genre would displace. */
	const cut = $derived(Math.min(data.total, c.trackLimit));
	const inCollection = $derived(new Set(c.genres));
	const suggestions = $derived(data.genres.filter((g) => !inCollection.has(g.genre)).slice(0, 200));
</script>

<svelte:head><title>{c.name} · Genres · Spotidata</title></svelte:head>

<header class="head">
	<div>
		<p class="crumb"><a href="/genres">Genres</a> /</p>
		<h1>{c.name}</h1>
		<p class="muted">
			{num(data.total)} recordings carrying
			{c.match === 'all' ? `all ${c.genres.length}` : `any of ${c.genres.length}`}
			genre{c.genres.length === 1 ? '' : 's'}, {SORT_LABELS[c.sort]?.toLowerCase()}
			{#if data.total > c.trackLimit}
				· first {num(c.trackLimit)} pushed
			{/if}
		</p>
	</div>
	<SearchBox value={data.q} placeholder="Search these tracks" />
</header>

{#if form?.error}
	<div class="notice bad">{form.error}</div>
{:else if form?.sync}
	<div class="notice good">
		{form.sync.message}
		{#if form.sync.requests}<span class="faint">({form.sync.requests} API requests)</span>{/if}
	</div>
{/if}

{#if !data.canWrite}
	<div class="notice">
		This Spotify authorization cannot modify playlists.
		<a href="/auth/login">Re-authorize</a> to create and update this one.
	</div>
{/if}

<section class="card playlist">
	<div class="state">
		{#if c.spotifyPlaylistId}
			<div class="row">
				<Chip tone={c.lastSyncError ? 'bad' : 'good'}>
					{c.lastSyncError ? 'last sync failed' : `${num(c.syncedTrackCount)} tracks in Spotify`}
				</Chip>
				<SpotifyLink kind="playlist" id={c.spotifyPlaylistId} label="Open the playlist" />
			</div>
			<p class="faint xs">
				{#if c.lastSyncedAt}Last synced {relativeTime(c.lastSyncedAt)}.{/if}
				{c.autoSync
					? 'Rewritten automatically after every sync and hourly.'
					: 'Auto-sync is off — it only changes when you press sync.'}
			</p>
			{#if c.lastSyncError}<p class="err xs">{c.lastSyncError}</p>{/if}
		{:else}
			<p class="faint small">
				No Spotify playlist yet. Syncing creates one and fills it with the {num(cut)} tracks below.
			</p>
		{/if}
	</div>

	<div class="actions">
		<form method="POST" action="?/sync" use:enhance>
			<button class="primary" type="submit" disabled={!data.canWrite || c.genres.length === 0}>
				{c.spotifyPlaylistId ? 'Sync now' : 'Create playlist'}
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
			<input id="name" name="name" value={c.name} maxlength="100" required />
		</div>
		<div class="field wide">
			<label for="description">Playlist description</label>
			<input
				id="description"
				name="description"
				value={c.description ?? ''}
				maxlength="250"
				placeholder="Left blank, it lists the genres"
			/>
		</div>
		<div class="field">
			<label for="match">Match</label>
			<select id="match" name="match" value={c.match}>
				<option value="any">Any of the genres</option>
				<option value="all">All of the genres</option>
			</select>
		</div>
		<div class="field">
			<label for="sort">Order</label>
			<select id="sort" name="sort" value={c.sort}>
				{#each data.sorts as s (s)}<option value={s}>{SORT_LABELS[s] ?? s}</option>{/each}
			</select>
		</div>
		<div class="field">
			<label for="trackLimit">Track limit</label>
			<input
				id="trackLimit"
				name="trackLimit"
				type="number"
				min="1"
				max={data.maxTracks}
				value={c.trackLimit}
			/>
		</div>
		<label class="check">
			<input type="checkbox" name="autoSync" checked={c.autoSync} />
			Keep the playlist updated automatically
		</label>
		<label class="check">
			<input type="checkbox" name="playlistPublic" checked={c.playlistPublic} />
			Public playlist (applies when it is created)
		</label>

		<div class="save">
			<button class="primary" type="submit">Save</button>
			{#if c.spotifyPlaylistId}
				<button class="ghost" type="submit" formaction="?/unlink">
					Forget the playlist
				</button>
			{/if}
			<button class="danger" type="submit" formaction="?/delete">Delete collection</button>
		</div>
	</form>
{/if}

<section class="card genres">
	<div class="chips">
		<span class="lbl">Genres</span>
		{#each c.genres as g (g)}
			<form method="POST" action="?/removeGenre" class="inline" use:enhance>
				<input type="hidden" name="genre" value={g} />
				<button class="chip on" type="submit" title="Remove {g}">
					{g}<span class="x" aria-hidden="true">×</span>
				</button>
			</form>
		{:else}
			<span class="faint small">None yet — add one to give the collection something to hold.</span>
		{/each}
	</div>

	<form class="add" method="POST" action="?/addGenre" use:enhance={clearOnSuccess}>
		<label class="sr" for="genre">Add a genre</label>
		<input
			id="genre"
			name="genre"
			list="genre-options"
			placeholder="Add a genre…"
			autocomplete="off"
		/>
		<!-- The whole vocabulary in a datalist: native autocomplete, no JS, and no
		     500-option select to scroll. -->
		<datalist id="genre-options">
			{#each suggestions as g (g.genre)}<option value={g.genre}>{g.tracks} recordings</option>{/each}
		</datalist>
		<button class="ghost" type="submit">Add</button>
	</form>
</section>

<section class="card">
	<div class="scroll-x">
		<table>
			<thead>
				<tr>
					<th class="idx">#</th>
					<th>Recording</th>
					<th>Artist</th>
					<th>Genres</th>
					<th class="r">Length</th>
					<th class="r">Plays</th>
					<th class="r">First added</th>
					<th class="r"><span class="sr">Spotify</span></th>
				</tr>
			</thead>
			<tbody>
				{#each data.rows as t (t.canonicalTrackId)}
					<tr class:beyond={t.rank > c.trackLimit}>
						<td class="idx num faint">{num(t.rank)}</td>
						<td>
							<div class="cell">
								<Cover src={t.cover} alt="{t.albumName ?? t.title} cover" size={34} />
								<div>
									<div class="title">
										<a href={trackHref(t.canonicalTrackId)}>{t.title}</a>
										{#if t.liked}<span class="heart" title="Liked">♥</span>{/if}
									</div>
									<div class="faint xs">
										{#if t.albumId}<a href="/album/{t.albumId}">{t.albumName}</a>{:else}—{/if}
									</div>
								</div>
							</div>
						</td>
						<td class="muted small"><ArtistLinks artists={t.artists} /></td>
						<td class="tags">
							{#each t.genres.slice(0, 3) as g (g)}
								<a class="tag" class:on={inCollection.has(g)} href={genreHref(g)}>{g}</a>
							{/each}
							{#if t.genres.length > 3}
								<span class="faint xs" title={t.genres.join(', ')}>+{t.genres.length - 3}</span>
							{/if}
						</td>
						<td class="r num muted">{trackTime(t.durationMs)}</td>
						<td
							class="r num"
							class:faint={t.plays === 0}
							title={t.plays > 0 ? `${longDuration(t.msPlayed)} listened` : 'Never played'}
						>
							{t.plays || '—'}
						</td>
						<td class="r muted small nowrap">{shortDate(t.firstAddedAt)}</td>
						<td class="r">
							<SpotifyLink kind="track" id={t.trackId} compact label="Open {t.title} in Spotify" />
						</td>
					</tr>
				{:else}
					<tr>
						<td colspan="8" class="none faint">
							{c.genres.length
								? 'Nothing in your library carries those genres yet.'
								: 'Add a genre and its tracks appear here.'}
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
		unit="recordings"
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
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
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
	input,
	select {
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
	input:focus,
	select:focus {
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
	.danger {
		color: var(--bad);
		border-color: rgba(244, 63, 94, 0.35);
		margin-left: auto;
	}
	.genres .chips {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}
	.lbl {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-faint);
		margin-right: 2px;
	}
	.inline {
		display: contents;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px;
		border-radius: 999px;
		border: 1px solid var(--hairline-strong);
		background: var(--bg-elevated);
		color: var(--text-muted);
		font-size: 0.76rem;
		font-family: inherit;
		line-height: 1.6;
		white-space: nowrap;
		cursor: pointer;
	}
	.chip.on {
		color: #ddd6fe;
		background: var(--accent-soft);
		border-color: rgba(124, 58, 237, 0.4);
	}
	.chip:hover {
		border-color: rgba(244, 63, 94, 0.5);
	}
	.chip .x {
		font-size: 0.9rem;
		line-height: 1;
	}
	.add {
		display: flex;
		gap: 8px;
		margin-top: 12px;
	}
	.add input {
		flex: 0 1 280px;
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
	th.idx,
	td.idx {
		text-align: right;
		padding-right: 12px;
		width: 52px;
	}
	/* Past the track limit: still listed, because knowing what just missed the
	   cut is how you decide whether to raise it. */
	tr.beyond td:not(.idx) {
		opacity: 0.4;
	}
	tr.beyond td.idx {
		color: var(--warn);
	}
	.cell {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.title {
		line-height: 1.3;
	}
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		max-width: 260px;
	}
	.tag {
		padding: 1px 8px;
		border-radius: 999px;
		border: 1px solid var(--hairline);
		font-size: 0.7rem;
		color: var(--text-faint);
		white-space: nowrap;
	}
	.tag.on {
		color: #ddd6fe;
		background: var(--accent-soft);
		border-color: rgba(124, 58, 237, 0.4);
	}
	.tag:hover {
		border-color: var(--hairline-strong);
		color: var(--text-muted);
	}
	.tag.on:hover {
		border-color: rgba(124, 58, 237, 0.9);
		color: #ede9fe;
	}
	.heart {
		color: var(--accent-2);
		font-size: 0.78rem;
		margin-left: 4px;
	}
	.small {
		font-size: 0.82rem;
	}
	.xs {
		font-size: 0.73rem;
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
