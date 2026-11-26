<script lang="ts">
	import ArtistLinks from '$lib/components/ArtistLinks.svelte';
	import Chip from '$lib/components/Chip.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import SpotifyLink from '$lib/components/SpotifyLink.svelte';
	import StatTile from '$lib/components/StatTile.svelte';
	import { CATEGORICAL } from '$lib/charts/index.ts';
	import { longDuration, num, plainText, trackTime } from '$lib/utils/format.ts';
	import { trackHref } from '$lib/utils/qs.ts';

	let { data } = $props();

	const r = $derived(data.radio);
	const seed = $derived(r.tracks.find((t) => t.id === r.seed));
	const kept = $derived(r.tracks.filter((t) => t.in_library).length);
	const liked = $derived(r.tracks.filter((t) => t.liked).length);
	const played = $derived(r.tracks.filter((t) => t.plays > 0).length);
	const duration = $derived(r.tracks.reduce((sum, t) => sum + t.duration_ms, 0));
	/** A track the archive has grouped opens its recording; any other resolves on demand. */
	const href = (t: (typeof r.tracks)[number]) =>
		t.canonical_id ? trackHref(t.canonical_id) : `/track/spotify/${t.id}`;
</script>

<svelte:head><title>{r.name} · Spotidata</title></svelte:head>

<header class="hero">
	<Cover src={r.image ?? null} alt="{r.name} cover" size={200} />
	<div class="meta">
		<p class="eyebrow faint">Song radio</p>
		<h1>{r.name}</h1>
		{#if r.description}<p class="desc muted">{plainText(r.description)}</p>{/if}
		{#if seed}
			<p class="muted small">
				Built by Spotify from <a href={href(seed)}>{seed.title}</a>
				· {num(r.tracks.length)} tracks · {longDuration(duration)}
			</p>
		{/if}
		<div class="chips">
			<Chip title="Read anonymously from Spotify's web player, so it is the radio anyone would get">
				Not personalised
			</Chip>
			<Chip title="Spotify regenerates a radio; this is what it plays right now">Live, not stored</Chip>
		</div>
		<div class="actions"><SpotifyLink kind="playlist" id={r.id} /></div>
	</div>
</header>

<section class="tiles">
	<StatTile label="Tracks" value={num(r.tracks.length)} sub={longDuration(duration)} accent={CATEGORICAL[0]} />
	<StatTile
		label="In your library"
		value={num(kept)}
		sub="{r.tracks.length > 0 ? Math.round((kept / r.tracks.length) * 100) : 0}% of the radio"
		accent={CATEGORICAL[2]}
	/>
	<StatTile label="Liked" value={num(liked)} sub="under any copy" accent={CATEGORICAL[3]} />
	<StatTile
		label="New to you"
		value={num(r.tracks.length - played)}
		sub="never in your listening history"
		accent={CATEGORICAL[4]}
	/>
</section>

<section class="card">
	<h2>Tracks</h2>
	<p class="faint sub">
		In the radio's order. Highlighted rows are recordings your library already holds, matched on
		the ISRC, so a different release of a song you keep still counts.
	</p>
	<div class="scroll-x">
		<table>
			<thead>
				<tr>
					<th class="idx">#</th>
					<th>Title</th>
					<th>Album</th>
					<th class="r">Length</th>
					<th class="r">Plays</th>
					<th class="r"><span class="sr">Spotify</span></th>
				</tr>
			</thead>
			<tbody>
				{#each r.tracks as t, i (t.id)}
					<tr class:mine={t.in_library}>
						<td class="idx num faint">{i + 1}</td>
						<td>
							<div class="cell">
								<Cover src={t.cover ?? null} alt="{t.album?.name ?? t.title} cover" size={32} />
								<div>
									<div class="title">
										<a href={href(t)}>{t.title}</a>
										{#if t.liked}<span class="heart" title="Liked">♥</span>{/if}
										{#if t.explicit}<span class="ex" title="Explicit">E</span>{/if}
									</div>
									<div class="faint xs"><ArtistLinks artists={t.artists} /></div>
								</div>
							</div>
						</td>
						<td class="muted small">
							{#if t.album}<a href="/album/{t.album.id}">{t.album.name}</a>{:else}<span class="faint">—</span>{/if}
						</td>
						<td class="r num muted">{trackTime(t.duration_ms)}</td>
						<td class="r num muted">{t.plays > 0 ? num(t.plays) : '—'}</td>
						<td class="r">
							<SpotifyLink kind="track" id={t.id} compact label="Open {t.title} in Spotify" />
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</section>

<style>
	.hero {
		display: flex;
		gap: 24px;
		align-items: flex-end;
		margin-bottom: var(--gap);
		flex-wrap: wrap;
	}
	.meta {
		flex: 1;
		min-width: 260px;
	}
	@media (max-width: 640px) {
		.hero {
			gap: 14px;
			align-items: flex-start;
		}
		.hero :global(img),
		.hero :global(.placeholder) {
			max-width: 42vw;
			max-height: 42vw;
		}
		.meta {
			flex: 1 1 100%;
			min-width: 0;
		}
	}
	.eyebrow {
		margin: 0 0 6px;
		font-size: 0.72rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	h1 {
		font-size: 2rem;
		margin-bottom: 6px;
	}
	.desc {
		margin: 0 0 6px;
		font-size: 0.9rem;
		max-width: 70ch;
	}
	.small {
		font-size: 0.85rem;
		margin: 0;
	}
	.xs {
		font-size: 0.74rem;
	}
	.chips {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		margin-top: 12px;
	}
	.actions {
		margin-top: 14px;
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
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
		min-width: 620px;
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
		padding: 6px 10px 6px 0;
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
	tr.mine {
		background: rgba(124, 58, 237, 0.05);
	}
	.cell {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.title {
		line-height: 1.25;
	}
	.heart {
		color: var(--accent-2);
		font-size: 0.8rem;
		margin-left: 4px;
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
	/* In flow at 1px: an absolutely positioned label would escape the scroll lane. */
	.sr {
		display: inline-block;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	a:hover {
		text-decoration: underline;
	}
	th.idx,
	td.idx {
		text-align: right;
		padding-right: 12px;
		width: 46px;
	}
</style>
