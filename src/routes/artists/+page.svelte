<script lang="ts">
	import Cover from '$lib/components/Cover.svelte';
	import FilterBar from '$lib/components/FilterBar.svelte';
	import Pager from '$lib/components/Pager.svelte';
	import SearchBox from '$lib/components/SearchBox.svelte';
	import SelectFilter from '$lib/components/SelectFilter.svelte';
	import SpotifyLink from '$lib/components/SpotifyLink.svelte';
	import { ARTIST_FILTERS } from '$lib/filters.ts';
	import { duration, num, longDuration } from '$lib/utils/format.ts';

	let { data } = $props();

	const SORTS = [
		{ key: 'tracks', label: 'Recordings' },
		{ key: 'name', label: 'Name', initial: 'asc' as const },
		{ key: 'albums', label: 'Albums' },
		{ key: 'duration', label: 'Time' },
		{ key: 'popularity', label: 'Popularity' },
		{ key: 'followers', label: 'Followers' },
		{ key: 'listened', label: 'Listened' },
		{ key: 'plays', label: 'Plays' }
	];

	/** The bar is scaled to the current page, so it stays readable however the list is sorted. */
	const peak = $derived(Math.max(1, ...data.rows.map((r) => r.tracks)));
</script>

<svelte:head><title>Artists · Spotidata</title></svelte:head>

<header class="head">
	<div>
		<h1>Artists</h1>
		<p class="muted">
			{num(data.total)} artists{#if data.q} matching “{data.q}”{/if}{#if data.genre} in
				{data.genre}{/if} — everyone credited on a recording in your library.
		</p>
	</div>
	<SearchBox value={data.q} placeholder="Search artists" />
</header>

<FilterBar
	groups={ARTIST_FILTERS}
	active={data.filters}
	sorts={SORTS}
	sort={data.sort}
	dir={data.dir}
	extraActive={data.genre ? 1 : 0}
>
	<SelectFilter
		param="genre"
		label="Genre"
		value={data.genre}
		anyLabel="Any genre"
		options={data.genres.map((g) => ({ value: g.genre, label: `${g.genre} (${g.artists})` }))}
	/>
</FilterBar>

<section class="card">
	<ol class="list cards" start={(data.page - 1) * data.pageSize + 1}>
		{#each data.rows as a (a.id)}
			<li>
				<span class="rank num faint wide-only">{a.tracks}</span>
				<a class="who lead" href="/artist/{a.id}">
					<Cover src={a.image} alt="{a.name} photo" size={44} round />
					<span class="names">
						<span class="name">{a.name}</span>
						<span class="faint xs narrow-only clip">
							{a.genre ?? 'no genre'}{#if a.followed}{' · '}<span class="follow">followed</span>{/if}
						</span>
						<span class="faint xs wide-only">
							{a.genre ?? 'no genre'} · {num(a.albums)} albums · {longDuration(a.durationMs)}
							{#if a.plays > 0}
								· <span
										class="played"
										title="{num(a.plays)} plays, over every recording credited to them — saved or not"
									>{longDuration(a.msPlayed)} played</span
								>
							{/if}
							{#if a.followed}· <span class="follow">followed</span>{/if}
						</span>
					</span>
				</a>
				<span class="bar wide-only" aria-hidden="true">
					<span class="fill" style="width:{(a.tracks / peak) * 100}%"></span>
				</span>
				<span class="pop num faint wide-only" title="Spotify popularity">{a.popularity ?? '—'}</span>
				<!-- A phone lays the same facts out as labelled stats, aligned down the list. -->
				<span class="narrow-only" data-label="Recordings" class:on={data.sort === 'tracks'}>{num(a.tracks)}</span>
				<span class="narrow-only" data-label="Albums" class:on={data.sort === 'albums'}>{num(a.albums)}</span>
				<span class="narrow-only" data-label="Pop." class:on={data.sort === 'popularity'}>{a.popularity ?? '—'}</span>
				<span class="narrow-only" data-label="Saved" class:on={data.sort === 'duration'}>{duration(a.durationMs / 1000)}</span>
				<span
					class="narrow-only"
					class:faint={a.plays === 0}
					data-label="Played"
					class:on={data.sort === 'listened' || data.sort === 'plays'}
					title="{num(a.plays)} plays"
				>
					{a.plays > 0 ? duration(a.msPlayed / 1000) : '—'}
				</span>
				<span class="corner">
					<SpotifyLink kind="artist" id={a.id} compact label="Open {a.name} in Spotify" />
				</span>
			</li>
		{:else}
			<li class="empty faint">No artists match that search.</li>
		{/each}
	</ol>
	<Pager page={data.page} pages={data.pages} total={data.total} pageSize={data.pageSize} unit="artists" />
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
	.card {
		padding: 10px var(--card-px) var(--card-py);
	}
	.list {
		list-style: none;
		margin: 0 0 6px;
		padding: 0;
	}
	.list li {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 8px 0;
		border-bottom: 1px solid rgba(255, 255, 255, 0.03);
	}
	.rank {
		width: 42px;
		text-align: right;
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--text-muted);
	}
	.who {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
		flex: 1 1 260px;
	}
	.who:hover .name {
		color: #fff;
	}
	.names {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.name {
		font-size: 0.94rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.xs {
		font-size: 0.74rem;
	}
	.follow {
		color: var(--good);
	}
	.played {
		color: var(--text-muted);
	}
	.bar {
		flex: 1 1 120px;
		height: 6px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.05);
		overflow: hidden;
		min-width: 60px;
	}
	.fill {
		display: block;
		height: 100%;
		background: linear-gradient(90deg, var(--accent), var(--accent-2));
	}
	.pop {
		width: 30px;
		text-align: right;
		font-size: 0.8rem;
	}
	.empty {
		padding: 30px 0;
		justify-content: center;
	}

	.clip {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* Phone: a row card (app.css › Rows as cards). The comparison bar goes —
	   60px of track next to a photo compares nothing — and the facts the
	   sub-line strung together become stats that line up down the list. */
	@media (max-width: 640px) {
		.list {
			--card-cols: minmax(0, 1.2fr) minmax(0, 0.8fr) minmax(0, 0.6fr) repeat(2, minmax(0, 1.15fr));
		}
		.name {
			font-size: 0.98rem;
		}
		.xs {
			font-size: 0.8rem;
		}
	}
</style>
