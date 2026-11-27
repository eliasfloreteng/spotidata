<!--
  SavedVsHeard — where the two halves of the archive meet. The recordings
  saved in the range, split by how they relate to listening (heard first and
  kept later, kept on first listen, kept unheard, never played), and the three
  numbers that only exist once both are known: what has gone quiet, how much a
  saved recording gets played, and how much listening the library never kept.
-->
<script lang="ts">
	import { CATEGORICAL, OTHER_COLOR } from '$lib/charts/index.ts';
	import { longDuration, num, pct } from '$lib/utils/format.ts';

	interface Props {
		saved: number;
		heardFirst: number;
		onFirstListen: number;
		savedFirst: number;
		neverPlayed: number;
		medianLagDays: number;
		medianPlays: number;
		dormant: number;
		/** Recordings heard in the range that the library does not hold. */
		unsavedRecordings: number;
		/** Listening time in the range on recordings the library does not hold. */
		unsavedMs: number;
	}
	let p: Props = $props();

	/** A gap in days, in the coarsest unit that still reads as a number. */
	function span(days: number): string {
		if (days < 14) return `${Math.round(days)} days`;
		if (days < 60) return `${Math.round(days / 7)} weeks`;
		if (days < 730) return `${Math.round(days / 30.44)} months`;
		return `${(days / 365.25).toFixed(1)} years`;
	}

	const segments = $derived(
		[
			{
				key: 'heard',
				label: 'Heard first',
				note: p.heardFirst > 0 ? `kept a median ${span(p.medianLagDays)} later` : 'kept later',
				value: p.heardFirst,
				color: CATEGORICAL[0]
			},
			{
				key: 'first',
				label: 'Kept on first listen',
				note: 'within a day of first hearing it',
				value: p.onFirstListen,
				color: CATEGORICAL[1]
			},
			{
				key: 'unheard',
				label: 'Saved unheard',
				note: 'first played days or more after',
				value: p.savedFirst,
				color: CATEGORICAL[4]
			},
			{
				key: 'never',
				label: 'Never played',
				note: 'not once since',
				value: p.neverPlayed,
				color: OTHER_COLOR
			}
		].filter((s) => s.value > 0)
	);

	const share = (n: number) => (p.saved > 0 ? n / p.saved : 0);
</script>

<section class="card meet" aria-labelledby="meet-title">
	<header>
		<h2 id="meet-title">Saved and heard</h2>
		<p class="faint sub">
			How the {num(p.saved)} recordings saved in this range met your listening, over their whole
			life in the log
		</p>
	</header>

	{#if p.saved > 0}
		<div
			class="bar"
			role="img"
			aria-label={segments.map((s) => `${s.label} ${pct(share(s.value))}`).join(', ')}
		>
			{#each segments as s (s.key)}
				<span style:flex-grow={s.value} style:background={s.color} title="{s.label}: {num(s.value)}"
				></span>
			{/each}
		</div>
		<ul class="legend">
			{#each segments as s (s.key)}
				<li>
					<i style:background={s.color}></i>
					<span class="what">{s.label}</span>
					<span class="num">{num(s.value)} <span class="faint">· {pct(share(s.value))}</span></span>
					<span class="faint note">{s.note}</span>
				</li>
			{/each}
		</ul>
	{/if}

	<dl class="facts">
		<div>
			<dt>Gone quiet</dt>
			<dd class="num">{num(p.dormant)}</dd>
			<dd class="faint">{pct(share(p.dormant))} of them, played once but not this past year</dd>
		</div>
		<div>
			<dt>Plays per save</dt>
			<dd class="num">{num(Math.round(p.medianPlays))}</dd>
			<dd class="faint">the median saved recording, all time</dd>
		</div>
		<div>
			<dt>Played, never saved</dt>
			<dd class="num">{num(p.unsavedRecordings)}</dd>
			<dd class="faint">recordings in this range, {longDuration(p.unsavedMs)} of listening</dd>
		</div>
	</dl>
</section>

<style>
	.meet {
		padding: var(--card-py) var(--card-px);
		margin-bottom: var(--gap);
	}
	h2 {
		margin-bottom: 2px;
	}
	.sub {
		font-size: 0.8rem;
		margin: 0 0 14px;
	}
	.bar {
		display: flex;
		gap: 2px;
		height: 14px;
		border-radius: 999px;
		overflow: hidden;
	}
	.bar span {
		flex-basis: 0;
		min-width: 3px;
	}
	.legend {
		list-style: none;
		margin: 12px 0 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 10px 18px;
	}
	.legend li {
		display: grid;
		grid-template-columns: 10px 1fr;
		column-gap: 8px;
		align-items: baseline;
		font-size: 0.82rem;
		min-width: 0;
	}
	.legend i {
		width: 10px;
		height: 10px;
		border-radius: 3px;
		align-self: center;
	}
	.legend .num,
	.legend .note {
		grid-column: 2;
	}
	.legend .note {
		font-size: 0.74rem;
	}
	.facts {
		margin: 18px 0 0;
		padding-top: 14px;
		border-top: 1px solid var(--hairline);
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 14px 18px;
	}
	.facts div {
		min-width: 0;
	}
	dt {
		color: var(--text-muted);
		font-size: 0.76rem;
	}
	dd {
		margin: 0;
	}
	dd.num {
		font-size: 1.25rem;
		font-weight: 650;
		letter-spacing: -0.02em;
		margin-top: 2px;
	}
	dd.faint {
		font-size: 0.74rem;
		margin-top: 2px;
	}
	@media (max-width: 640px) {
		.legend {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.facts {
			grid-template-columns: 1fr;
		}
	}
</style>
