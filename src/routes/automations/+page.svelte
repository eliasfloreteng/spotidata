<script lang="ts">
	import { enhance } from '$app/forms';
	import Chip from '$lib/components/Chip.svelte';
	import { num, relativeTime } from '$lib/utils/format.ts';

	let { data, form } = $props();

	let creating = $state(false);
	let filter = $state('');
	let picked = $state(new Set<string>());

	const matching = $derived(
		data.playlists.filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase()))
	);

	function toggle(id: string) {
		// A new Set, not a mutation: `picked` is reassigned so the derived count
		// and every checkbox read from the same state.
		const next = new Set(picked);
		if (!next.delete(id)) next.add(id);
		picked = next;
	}
</script>

<svelte:head><title>Automations · Spotidata</title></svelte:head>

<header class="head">
	<div class="intro">
		<h1>Automations</h1>
		<p class="muted">
			Collect everything from a set of playlists into one playlist, and keep collecting as they
			grow. An automation only ever <strong>adds</strong> — it never removes a track, never rewrites
			the order, and never touches anything it did not put there, so the destination stays a normal
			playlist you can edit in Spotify.
		</p>
	</div>
</header>

{#if !data.canWrite}
	<div class="notice">
		This Spotify authorization cannot modify playlists.
		<a href="/auth/login">Re-authorize</a> to let an automation create and fill one.
	</div>
{/if}

{#if form?.error}
	<div class="notice bad">{form.error}</div>
{/if}

<section class="list">
	<div class="section-head">
		<h2>Your automations</h2>
		<button class="ghost" onclick={() => (creating = !creating)}>
			{creating ? 'Cancel' : 'New automation'}
		</button>
	</div>

	{#if creating}
		<form class="card new" method="POST" action="?/create" use:enhance>
			<div class="field">
				<label for="new-name">Name</label>
				<input id="new-name" name="name" placeholder="Everything from Jazz" required />
				<span class="faint xs">Also the name of the playlist it creates.</span>
			</div>

			<fieldset class="field">
				<legend>What it does with what the sources already hold</legend>
				<label class="check">
					<input type="radio" name="backfill" value="all" checked />
					Add all of it, then keep up
				</label>
				<label class="check">
					<input type="radio" name="backfill" value="new" />
					Only tracks added from now on
				</label>
			</fieldset>

			<div class="field wide">
				<div class="picker-head">
					<label for="source-filter">Source playlists</label>
					<span class="faint xs">{picked.size} picked</span>
				</div>
				<!-- Spotify's API cannot see folders — `GET /me/playlists` is flat and
				     nothing exposes the tree the app shows — so a folder is whatever
				     you tick here. Any playlist qualifies, in a folder or not. -->
				<p class="faint xs hint">
					Spotify's API does not expose folders, so pick the playlists a folder holds. Anything else
					you want feeding this can go in the same list.
				</p>
				<input
					id="source-filter"
					type="search"
					bind:value={filter}
					placeholder="Filter {data.playlists.length} playlists…"
					autocomplete="off"
				/>
				<div class="options">
					{#each matching.slice(0, 400) as p (p.id)}
						<label class="option" class:on={picked.has(p.id)}>
							<input
								type="checkbox"
								name="source"
								value={p.id}
								checked={picked.has(p.id)}
								onchange={() => toggle(p.id)}
							/>
							<span class="name">{p.name}</span>
							<span class="faint xs">
								{num(p.tracks)}
								{#if !p.isOwned}· {p.ownerName ?? 'followed'}{/if}
							</span>
						</label>
					{:else}
						<p class="faint xs none">No playlist matches that. Sync first if the list looks short.</p>
					{/each}
				</div>
				<span class="faint xs">More can be added later, including by pasting a link.</span>
			</div>

			<div class="save">
				<button class="primary" type="submit">Create</button>
			</div>
		</form>
	{/if}

	{#if data.automations.length}
		<div class="grid">
			{#each data.automations as a (a.id)}
				<a class="card automation" href="/automations/{a.id}">
					<div class="row">
						<h3>{a.name}</h3>
						{#if a.lastRunError}
							<Chip tone="bad">last run failed</Chip>
						{:else if a.pending > 0}
							<Chip tone="warn">{num(a.pending)} to add</Chip>
						{:else if a.spotifyPlaylistId}
							<Chip tone="good">up to date</Chip>
						{:else}
							<Chip>not created</Chip>
						{/if}
					</div>
					<p class="tags">
						{#each a.sourceNames.slice(0, 4) as name (name)}<span class="tag">{name}</span>{/each}
						{#if a.sources.length > a.sourceNames.slice(0, 4).length}
							<span class="faint xs">+{a.sources.length - Math.min(4, a.sourceNames.length)}</span>
						{/if}
						{#if a.sources.length === 0}<span class="faint xs">no sources yet</span>{/if}
					</p>
					<p class="faint xs meta">
						{num(a.addedTrackCount)} added in total
						{#if a.autoRun}· hourly{:else}· manual{/if}
						{#if !a.backfill}· new tracks only{/if}
						{#if a.lastRunAt}· ran {relativeTime(a.lastRunAt)}{/if}
					</p>
				</a>
			{/each}
		</div>
	{:else}
		<p class="faint empty">
			No automations yet. One is a set of source playlists plus the playlist their tracks land in.
		</p>
	{/if}
</section>

<style>
	.head {
		margin-bottom: var(--gap);
	}
	.intro p {
		margin: 6px 0 0;
		font-size: 0.9rem;
		max-width: 72ch;
	}
	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 12px;
	}
	.section-head h2 {
		margin: 0;
		font-size: 1rem;
	}
	.card {
		padding: var(--card-py) var(--card-px);
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
	.notice a {
		text-decoration: underline;
	}
	.new {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 14px 18px;
		align-items: start;
		margin-bottom: var(--gap);
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 5px;
		min-width: 0;
		border: 0;
		padding: 0;
		margin: 0;
	}
	.field.wide {
		grid-column: 1 / -1;
	}
	label,
	legend {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-faint);
		padding: 0;
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
		width: 15px;
		height: 15px;
	}
	.picker-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 10px;
	}
	.hint {
		margin: 0 0 4px;
		max-width: 70ch;
	}
	.new input:not([type='checkbox']):not([type='radio']) {
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
	.new input:focus {
		border-color: rgba(124, 58, 237, 0.6);
	}
	.options {
		margin-top: 8px;
		max-height: 320px;
		overflow-y: auto;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: 2px 14px;
		border: 1px solid var(--hairline);
		border-radius: var(--radius-sm);
		padding: 8px 10px;
	}
	.option {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 6px;
		border-radius: 8px;
		font-size: 0.84rem;
		text-transform: none;
		letter-spacing: 0;
		color: var(--text-muted);
		cursor: pointer;
		min-width: 0;
	}
	.option:hover {
		background: rgba(255, 255, 255, 0.04);
		color: var(--text);
	}
	.option.on {
		color: #ddd6fe;
	}
	.option input {
		accent-color: var(--accent-2);
		width: 15px;
		height: 15px;
		flex: none;
	}
	.option .name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.option .xs {
		margin-left: auto;
		white-space: nowrap;
	}
	.none {
		padding: 10px 4px;
	}
	.save {
		grid-column: 1 / -1;
		display: flex;
		gap: 8px;
		border-top: 1px solid var(--hairline);
		padding-top: 12px;
	}
	.primary,
	.ghost {
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
	.ghost:hover {
		color: var(--text);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 12px;
	}
	.automation {
		display: block;
	}
	.automation:hover {
		border-color: var(--hairline-strong);
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}
	.row h3 {
		margin: 0;
		font-size: 0.98rem;
	}
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin: 10px 0 0;
	}
	.tag {
		padding: 1px 8px;
		border-radius: 999px;
		border: 1px solid var(--hairline);
		font-size: 0.7rem;
		color: var(--text-faint);
		max-width: 15ch;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.meta {
		margin: 10px 0 0;
	}
	.empty {
		padding: 24px 0;
	}
	.xs {
		font-size: 0.73rem;
	}
</style>
