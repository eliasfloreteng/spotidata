<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import ArtistLinks from '$lib/components/ArtistLinks.svelte';
	import CamelotWheel from '$lib/components/CamelotWheel.svelte';
	import Chip from '$lib/components/Chip.svelte';
	import Cover from '$lib/components/Cover.svelte';
	import Pager from '$lib/components/Pager.svelte';
	import SearchBox from '$lib/components/SearchBox.svelte';
	import SelectFilter from '$lib/components/SelectFilter.svelte';
	import SortTh from '$lib/components/SortTh.svelte';
	import SpotifyLink from '$lib/components/SpotifyLink.svelte';
	import { duration, num, pct, trackTime } from '$lib/utils/format.ts';
	import {
		keyForCamelot,
		keyMove,
		KEY_MODES,
		KEY_MOVES,
		TEMPO_TOLERANCES,
		tempoShift,
		type KeyMode,
		type KeyMove
	} from '$lib/utils/music.ts';
	import { genreHref, trackHref, withParams } from '$lib/utils/qs.ts';
	import { spotifyLink } from '$lib/utils/spotify-uri.ts';

	let { data, form } = $props();

	/**
	 * The set is the repeated `?s=` param, in order. Rebuilding it by hand
	 * rather than through `withParams` because that helper sets one value per
	 * name; a search is dropped on every change, since it was for finding the
	 * track that was just added.
	 */
	function setHref(ids: string[]): string {
		const next = new URL(page.url);
		next.searchParams.delete('s');
		next.searchParams.delete('q');
		next.searchParams.delete('page');
		for (const id of ids) next.searchParams.append('s', id);
		return `${next.pathname}${next.search}`;
	}

	/** A move's tone: blends are good, energy moves are a choice, clashes are not. */
	const moveTone = (move: KeyMove | null): 'good' | 'warn' | 'bad' =>
		move == null
			? 'bad'
			: move === 'diagonal' || move === 'boost' || move === 'semitone'
				? 'warn'
				: 'good';

	const factorLabel = (f: number | null) => (f === 2 ? '2×' : f === 0.5 ? '½×' : null);

	const bpm = (v: number | null) => (v == null ? '—' : Math.round(v).toString());
</script>

<svelte:head><title>{data.mode === 'set' ? 'DJ set' : 'DJ'} · Spotidata</title></svelte:head>

{#if data.mode === 'browse'}
	{@const shape = data.shape}
	{@const f = data.filters}
	{@const most = Math.max(1, ...shape.tempo.map((t) => t.tracks))}
	<header class="head">
		<div>
			<h1>DJ</h1>
			<p class="muted">
				Find what mixes. {num(shape.pool)} of {num(shape.library)} recordings have a tempo and a key
				measured by AcousticBrainz. Narrow by key and tempo, pick a record to start a set, and every
				next one is ranked by how well it blends out of the last.
			</p>
		</div>
		<SearchBox value={data.q} placeholder="Search tracks to start from" />
	</header>

	<div class="browse-grid">
		<section class="card pad">
			<header class="cardhead">
				<h2>Key</h2>
				<p class="faint sub">
					The Camelot wheel: neighbours mix. Pick a key and the codes that blend out of it light up.
				</p>
			</header>
			<CamelotWheel
				counts={shape.keys}
				selected={f.camelot}
				href={(code) => withParams(page.url, { key: code, page: null })}
			/>
		</section>

		<section class="card pad">
			<header class="cardhead">
				<h2>Tempo</h2>
				<p class="faint sub">
					Recordings per 5 BPM. AcousticBrainz is sometimes an octave out, so a 174 BPM record can
					sit at 87 — the set builder matches across that.
				</p>
			</header>
			<div class="strip" role="group" aria-label="Tempo">
				{#each shape.tempo as t (t.bin)}
					{@const on =
						f.bpmMin != null && f.bpmMax != null && t.bin >= f.bpmMin && t.bin + data.bin <= f.bpmMax}
					{@const single = f.bpmMin === t.bin && f.bpmMax === t.bin + data.bin}
					<a
						class="bar"
						class:on
						href={withParams(page.url, {
							min: single ? null : t.bin,
							max: single ? null : t.bin + data.bin,
							page: null
						})}
						title="{t.bin}–{t.bin + data.bin} BPM · {num(t.tracks)} recordings"
						aria-label="{t.bin} to {t.bin + data.bin} BPM, {num(t.tracks)} recordings"
					>
						<span style="height: {Math.max(2, Math.sqrt(t.tracks / most) * 100)}%"></span>
					</a>
				{/each}
			</div>
			<div class="axis faint" aria-hidden="true">
				<span>{shape.tempo[0]?.bin ?? ''}</span>
				<span>BPM</span>
				<span>{(shape.tempo.at(-1)?.bin ?? 0) + data.bin}</span>
			</div>

			<form class="range" method="GET" action={page.url.pathname}>
				{#each [...page.url.searchParams].filter(([n]) => !['min', 'max', 'page'].includes(n)) as [name, v], i (i)}
					<input type="hidden" {name} value={v} />
				{/each}
				<label>
					<span class="lbl">From</span>
					<input name="min" type="number" inputmode="numeric" min="1" max="399" value={f.bpmMin ?? ''} placeholder="60" />
				</label>
				<label>
					<span class="lbl">to</span>
					<input name="max" type="number" inputmode="numeric" min="1" max="399" value={f.bpmMax ?? ''} placeholder="200" />
				</label>
				<button class="btn small" type="submit">Apply</button>
				{#if f.bpmMin != null || f.bpmMax != null}
					<a class="clear" href={withParams(page.url, { min: null, max: null, page: null })}>Any tempo</a>
				{/if}
			</form>

			<div class="genre-pick">
				<SelectFilter
					param="genre"
					label="Genre"
					value={data.genre ?? ''}
					anyLabel="Any genre"
					options={shape.genres.map((g) => ({ value: g.genre, label: `${g.genre} (${num(g.tracks)})` }))}
				/>
			</div>
		</section>
	</div>

	<section class="card pad">
		<header class="cardhead row">
			<h2>
				{num(data.total)} to start from
				{#if f.camelot}<span class="faint"> · {f.camelot}</span>{/if}
				{#if f.bpmMin != null || f.bpmMax != null}
					<span class="faint"> · {f.bpmMin ?? '…'}–{f.bpmMax ?? '…'} BPM</span>
				{/if}
				{#if data.genre}<span class="faint"> · {data.genre}</span>{/if}
			</h2>
			{#if f.camelot || f.bpmMin != null || f.bpmMax != null || data.genre || data.q}
				<a class="clear" href="/dj">Clear all</a>
			{/if}
		</header>
		<div class="scroll-x">
			<table>
				<thead>
					<tr>
						<th>Recording</th>
						<SortTh key="bpm" label="BPM" active={data.sort} dir={data.dir} initial="asc" right />
						<SortTh key="key" label="Key" active={data.sort} dir={data.dir} initial="asc" />
						<th>Genres</th>
						<SortTh key="dance" label="Dance" active={data.sort} dir={data.dir} right />
						<SortTh key="plays" label="Plays" active={data.sort} dir={data.dir} right />
						<th class="r"><span class="sr">Start a set</span></th>
					</tr>
				</thead>
				<tbody>
					{#each data.rows as t (t.canonicalTrackId)}
						<tr>
							<td>
								<div class="cell">
									<Cover src={t.cover} alt="{t.title} cover" size={34} />
									<div class="min">
										<div class="title">
											<a href={trackHref(t.canonicalTrackId)}>{t.title}</a>
											{#if t.liked}<span class="heart" title="Liked">♥</span>{/if}
										</div>
										<div class="faint xs"><ArtistLinks artists={t.artists} /></div>
									</div>
								</div>
							</td>
							<td class="r num">{bpm(t.bpm)}</td>
							<td class="nowrap">
								<a class="code" href={withParams(page.url, { key: t.camelot, page: null })} title={keyForCamelot(t.camelot) ?? ''}>{t.camelot}</a>
								{#if t.keyStrength != null && t.keyStrength < 0.5}
									<span class="faint xs" title="AcousticBrainz is only {pct(t.keyStrength)} confident in this key">?</span>
								{/if}
							</td>
							<td class="genres">
								{#each (t.genres ?? []).slice(0, 2) as g (g)}
									<a href={genreHref(g)}><Chip>{g}</Chip></a>
								{/each}
							</td>
							<td class="r num muted">{t.danceable != null ? pct(t.danceable) : '—'}</td>
							<td class="r num" class:faint={t.plays === 0}>{t.plays || '—'}</td>
							<td class="r">
								<a class="btn small" href="/dj?s={encodeURIComponent(t.canonicalTrackId)}">Start set</a>
							</td>
						</tr>
					{:else}
						<tr><td colspan="7" class="empty faint">Nothing in the pool matches those filters.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
		<Pager page={data.page} pages={data.pages} total={data.total} pageSize={data.pageSize} unit="recordings" />
	</section>
{:else}
	{@const set = data.set}
	{@const seed = data.seed}
	{@const ids = set.map((t) => t.canonicalTrackId)}
	{@const runtime = set.reduce((sum, t) => sum + t.durationMs, 0)}
	<header class="head">
		<div>
			<p class="eyebrow faint"><a href="/dj">DJ</a> / set</p>
			<h1>Your set</h1>
			<p class="muted">
				{set.length} track{set.length === 1 ? '' : 's'} · {duration(runtime / 1000)}. Each suggestion
				is ranked against the last track: key move first, then how little pitching it takes, then
				shared genres and feel.
			</p>
		</div>
		<a class="btn" href="/dj">New set</a>
	</header>

	{#if form?.error}
		<div class="notice bad">{form.error}</div>
	{:else if form?.saved}
		<div class="notice good">
			Saved as a private playlist of {form.saved.tracks} tracks.
			<a href={spotifyLink('playlist', form.saved.playlistId, page.data.linkScheme ?? 'uri')}>Open it in Spotify</a>
			— or point Deckhand at it to put it on the stick.
		</div>
	{/if}

	<div class="set-grid">
		<section class="card pad">
			<header class="cardhead row">
				<h2>Running order</h2>
				{#if set.length > 1}
					<a class="clear" href={setHref(ids.slice(0, -1))} title="Remove the last track">Undo last</a>
				{/if}
			</header>
			<ol class="set">
				{#each set as t, i (t.canonicalTrackId)}
					{#if i > 0}
						{@const prev = set[i - 1]}
						{@const move = keyMove(prev?.camelot ?? null, t.camelot)}
						{@const known = prev?.camelot != null && t.camelot != null}
						<li class="step {known ? moveTone(move) : 'unknown'}" aria-label="Transition">
							<span class="arrow" aria-hidden="true">↓</span>
							{#if known}
								<span title={move ? KEY_MOVES[move].title : 'These keys clash'}>
									{prev?.camelot} → {t.camelot} · {move ? KEY_MOVES[move].label : 'clash'}
								</span>
							{:else}
								<span>key unknown</span>
							{/if}
							<span class="faint">·</span>
							<span class="num">
								{tempoShift(t.tempoPct)}
								{#if factorLabel(t.tempoFactor)}<em>{factorLabel(t.tempoFactor)}</em>{/if}
							</span>
						</li>
					{/if}
					<li class="track" class:last={i === set.length - 1}>
						<span class="pos num faint">{i + 1}</span>
						<Cover src={t.cover} alt="{t.title} cover" size={38} />
						<div class="min grow">
							<div class="title"><a href={trackHref(t.canonicalTrackId)}>{t.title}</a></div>
							<div class="faint xs"><ArtistLinks artists={t.artists} /></div>
						</div>
						<div class="readout">
							<span class="num">{bpm(t.bpm)}<small> BPM</small></span>
							<span class="code" title={t.camelot ? (keyForCamelot(t.camelot) ?? '') : 'No key measured'}>{t.camelot ?? '—'}</span>
						</div>
						<a class="x" href={setHref(ids.filter((id) => id !== t.canonicalTrackId))} aria-label="Remove {t.title} from the set">×</a>
					</li>
				{/each}
			</ol>

			{#if data.canWrite}
				<form class="save" method="POST" action="?/save" use:enhance>
					{#each ids as id (id)}<input type="hidden" name="s" value={id} />{/each}
					<input name="name" required maxlength="100" placeholder="Name the set" aria-label="Playlist name" value={`Set · ${new Date().toLocaleDateString('sv-SE')}`} />
					<button class="btn btn-primary" type="submit">Save to Spotify</button>
				</form>
			{:else}
				<p class="faint xs note">
					This Spotify authorization cannot create playlists. <a href="/auth/login">Re-authorize</a>
					to save sets.
				</p>
			{/if}
		</section>

		<section class="card pad">
			<header class="cardhead">
				<h2>Next up</h2>
				{#if seed}
					<p class="faint sub">
						Out of <strong class="muted">{seed.title}</strong>
						{#if seed.bpm != null && seed.camelot}
							· {bpm(seed.bpm)} BPM · {seed.camelot} ({keyForCamelot(seed.camelot)})
						{/if}
					</p>
				{/if}
			</header>

			{#if !seed || seed.bpm == null || !seed.camelot}
				<p class="empty faint">
					AcousticBrainz never measured the last track, so there is nothing to match it against.
					Remove it, or pick what follows from <a href="/dj">the pool</a>.
				</p>
			{:else}
				<div class="controls">
					<div class="group">
						<span class="lbl">Pitch</span>
						{#each TEMPO_TOLERANCES as tol (tol)}
							<a class="pill" class:on={data.tolerance === tol} href={withParams(page.url, { tol: tol === 6 ? null : tol })}>±{tol}%</a>
						{/each}
					</div>
					<div class="group">
						<span class="lbl">Keys</span>
						{#each Object.entries(KEY_MODES) as [mode, m] (mode)}
							<a
								class="pill"
								class:on={data.keyMode === mode}
								title={m.title}
								href={withParams(page.url, { keys: (mode as KeyMode) === 'harmonic' ? null : mode })}
							>{m.label}</a>
						{/each}
					</div>
					{#if seed.genres?.length || data.genre}
						<div class="group">
							<span class="lbl">Stay in</span>
							{#each [...new Set([...(data.genre ? [data.genre] : []), ...(seed.genres ?? []).slice(0, 5)])] as g (g)}
								<a class="pill" class:on={data.genre === g} href={withParams(page.url, { genre: data.genre === g ? null : g })}>{g}</a>
							{/each}
						</div>
					{/if}
					<SearchBox value={data.q} placeholder="Where would a track fit?" />
				</div>

				{#if data.q}
					<p class="faint xs note">
						Searching ignores the pitch and key limits — results are still ranked by how well they
						follow.
					</p>
				{/if}

				<ul class="next">
					{#each data.next as t (t.canonicalTrackId)}
						<li>
							<Cover src={t.cover} alt="{t.title} cover" size={38} />
							<div class="min grow">
								<div class="title">
									<a href={trackHref(t.canonicalTrackId)}>{t.title}</a>
									{#if t.liked}<span class="heart" title="Liked">♥</span>{/if}
								</div>
								<div class="faint xs"><ArtistLinks artists={t.artists} /></div>
								<div class="why">
									<Chip tone={moveTone(t.move)} title={t.move ? KEY_MOVES[t.move].title : 'These keys clash'}>
										{t.camelot} · {t.move ? KEY_MOVES[t.move].label : 'clash'}
									</Chip>
									<Chip title="{bpm(t.bpm)} BPM, pitched {tempoShift(t.tempoPct)} to match">
										{bpm(t.bpm)} BPM · {tempoShift(t.tempoPct)}{#if factorLabel(t.tempoFactor)}&nbsp;({factorLabel(t.tempoFactor)}){/if}
									</Chip>
									{#each t.sharedGenres.slice(0, 2) as g (g)}
										<Chip tone="accent">{g}</Chip>
									{/each}
									{#if t.plays > 0}<span class="faint xs">{num(t.plays)} plays</span>{/if}
								</div>
							</div>
							<div class="act">
								<span class="score" title="Match {pct(t.score)}"><span style="width: {t.score * 100}%"></span></span>
								{#if ids.length < data.maxSet}
									<a class="btn small" href={setHref([...ids, t.canonicalTrackId])}>Add</a>
								{/if}
								<SpotifyLink kind="track" id={t.representativeTrackId} compact label="Open {t.title} in Spotify" />
							</div>
						</li>
					{:else}
						<li class="empty faint">
							{#if data.q}
								Nothing in the pool matches “{data.q}”.
							{:else}
								Nothing follows within ±{data.tolerance}% in these keys. Widen the pitch, allow
								energy moves, or drop the genre.
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>
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
	.eyebrow {
		margin: 0 0 2px !important;
		font-size: 0.74rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.pad {
		padding: var(--card-py) var(--card-px);
	}
	.card + .card,
	.browse-grid + .card {
		margin-top: var(--gap);
	}
	.cardhead {
		margin-bottom: 12px;
	}
	.cardhead.row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}
	.sub {
		margin: 4px 0 0;
		font-size: 0.8rem;
	}
	.browse-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
		gap: var(--gap);
	}
	.browse-grid > .card + .card {
		margin-top: 0;
	}
	.set-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr);
		gap: var(--gap);
		align-items: start;
	}
	.set-grid > .card + .card {
		margin-top: 0;
	}
	@media (max-width: 900px) {
		.browse-grid,
		.set-grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	/* ── tempo strip ───────────────────────────────────────── */
	.strip {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		height: 120px;
	}
	.bar {
		flex: 1;
		height: 100%;
		display: flex;
		align-items: flex-end;
		min-width: 0;
	}
	.bar span {
		display: block;
		width: 100%;
		border-radius: 3px 3px 0 0;
		background: rgba(124, 58, 237, 0.5);
		transition: background 0.15s ease;
	}
	.bar:hover span {
		background: rgba(192, 38, 211, 0.7);
	}
	.bar.on span {
		background: var(--accent-2);
	}
	.axis {
		display: flex;
		justify-content: space-between;
		font-size: 0.72rem;
		margin-top: 4px;
	}
	.range {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 10px;
		margin-top: 14px;
	}
	.range label {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.range input,
	.save input {
		height: 34px;
		padding: 0 10px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--hairline-strong);
		background: var(--bg-elevated);
		font-size: 0.86rem;
	}
	.range input {
		width: 76px;
	}
	.genre-pick {
		margin-top: 14px;
	}
	.lbl {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-faint);
	}
	.btn.small {
		padding: 4px 12px;
		font-size: 0.78rem;
		white-space: nowrap;
	}
	@media (pointer: coarse) {
		.btn.small {
			min-height: 36px;
			padding: 6px 14px;
		}
	}
	.clear {
		font-size: 0.78rem;
		color: var(--text-faint);
		text-decoration: underline;
	}

	/* ── tables & rows ─────────────────────────────────────── */
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
		min-width: 760px;
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
	.min {
		min-width: 0;
	}
	.grow {
		flex: 1;
	}
	.title {
		line-height: 1.3;
	}
	.title a:hover {
		text-decoration: underline;
	}
	.xs {
		font-size: 0.73rem;
	}
	.heart {
		color: var(--accent-2);
		font-size: 0.78rem;
		margin-left: 4px;
	}
	td.genres a + a {
		margin-left: 4px;
	}
	.code {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
		color: #ddd6fe;
	}
	.nowrap {
		white-space: nowrap;
	}
	.empty {
		padding: 28px 0;
		text-align: center;
	}
	.sr {
		display: inline-block;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	/* ── the set ───────────────────────────────────────────── */
	ol.set,
	ul.next {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.track {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 7px 0;
	}
	.track.last {
		background: linear-gradient(90deg, var(--accent-soft), transparent 70%);
		border-radius: var(--radius-sm);
		margin-inline: -8px;
		padding-inline: 8px;
	}
	.pos {
		width: 18px;
		text-align: right;
		font-size: 0.8rem;
	}
	.readout {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		font-size: 0.84rem;
		line-height: 1.3;
	}
	.readout small {
		color: var(--text-faint);
		font-size: 0.68rem;
	}
	.x {
		color: var(--text-faint);
		font-size: 1.1rem;
		padding: 0 4px;
	}
	.x:hover {
		color: var(--bad);
	}
	.step {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 1px 0 1px 26px;
		font-size: 0.74rem;
	}
	.step .arrow {
		width: 14px;
		color: var(--text-faint);
	}
	.step.good {
		color: var(--good);
	}
	.step.warn {
		color: var(--warn);
	}
	.step.bad {
		color: var(--bad);
	}
	.step.unknown {
		color: var(--text-faint);
	}
	.step em {
		font-style: normal;
		opacity: 0.8;
		margin-left: 2px;
	}
	.save {
		display: flex;
		gap: 8px;
		margin-top: 16px;
		padding-top: 14px;
		border-top: 1px solid var(--hairline);
		flex-wrap: wrap;
	}
	.save input {
		flex: 1;
		min-width: 160px;
	}
	.note {
		margin: 12px 0 0;
	}
	.notice {
		padding: 10px 16px;
		border-radius: var(--radius-sm);
		margin-bottom: var(--gap);
		font-size: 0.88rem;
		border: 1px solid var(--hairline-strong);
	}
	.notice a {
		text-decoration: underline;
	}
	.notice.good {
		background: rgba(52, 211, 153, 0.08);
		border-color: rgba(52, 211, 153, 0.3);
	}
	.notice.bad {
		background: rgba(244, 63, 94, 0.1);
		border-color: rgba(244, 63, 94, 0.32);
	}

	/* ── next up ───────────────────────────────────────────── */
	.controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px 18px;
		margin-bottom: 12px;
	}
	.group {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}
	.pill {
		padding: 3px 10px;
		border-radius: 999px;
		border: 1px solid var(--hairline-strong);
		background: var(--bg-elevated);
		color: var(--text-muted);
		font-size: 0.76rem;
		line-height: 1.6;
		white-space: nowrap;
	}
	.pill.on {
		color: #ddd6fe;
		background: var(--accent-soft);
		border-color: rgba(124, 58, 237, 0.4);
	}
	@media (pointer: coarse) {
		.pill {
			padding: 7px 13px;
			font-size: 0.82rem;
		}
	}
	ul.next li {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 9px 0;
		border-bottom: 1px solid rgba(255, 255, 255, 0.03);
	}
	ul.next li.empty {
		display: block;
	}
	.why {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
		margin-top: 5px;
	}
	.act {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: none;
	}
	.score {
		width: 44px;
		height: 4px;
		border-radius: 2px;
		background: var(--hairline-strong);
		overflow: hidden;
	}
	.score span {
		display: block;
		height: 100%;
		background: linear-gradient(90deg, var(--accent), var(--accent-2));
	}
	@media (max-width: 640px) {
		.score {
			display: none;
		}
	}
</style>
