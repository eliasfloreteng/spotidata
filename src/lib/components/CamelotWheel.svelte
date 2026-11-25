<script lang="ts">
	import { num } from '$lib/utils/format.ts';
	import { keyForCamelot, KEY_MOVES, movesFrom } from '$lib/utils/music.ts';

	interface Props {
		/** Recordings per Camelot code; a missing code is zero. */
		counts: { code: string; tracks: number }[];
		selected: string | null;
		/** The link each segment follows — selecting, or deselecting when it is the one selected. */
		href: (code: string | null) => string;
	}
	let { counts, selected, href }: Props = $props();

	const SIZE = 300;
	const C = SIZE / 2;
	/** Minor keys inside, major outside, the way the wheel is always drawn. */
	const RINGS = { A: [62, 102], B: [104, 146] } as const;

	const byCode = $derived(new Map(counts.map((c) => [c.code, c.tracks])));
	const most = $derived(Math.max(1, ...counts.map((c) => c.tracks)));

	/** The codes that mix out of the selected one — lit, so the wheel teaches itself. */
	const neighbours = $derived(
		new Map(
			selected
				? movesFrom(selected, 'harmonic')
						.filter((m) => m.code !== selected)
						.map((m) => [m.code, m.move])
				: []
		)
	);

	const polar = (r: number, deg: number) => {
		const rad = ((deg - 90) * Math.PI) / 180;
		return [C + r * Math.cos(rad), C + r * Math.sin(rad)];
	};

	/** One annular sector, 1 at twelve o'clock and clockwise from there. */
	function sector(n: number, r0: number, r1: number): string {
		const a0 = (n - 1) * 30 - 14.2;
		const a1 = (n - 1) * 30 + 14.2;
		const [x0, y0] = polar(r1, a0);
		const [x1, y1] = polar(r1, a1);
		const [x2, y2] = polar(r0, a1);
		const [x3, y3] = polar(r0, a0);
		return `M${x0} ${y0}A${r1} ${r1} 0 0 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 0 0 ${x3} ${y3}Z`;
	}

	const segments = $derived(
		(['A', 'B'] as const).flatMap((letter) =>
			Array.from({ length: 12 }, (_, i) => {
				const n = i + 1;
				const code = `${n}${letter}`;
				const [r0, r1] = RINGS[letter];
				const [lx, ly] = polar((r0 + r1) / 2, (n - 1) * 30);
				const tracks = byCode.get(code) ?? 0;
				return {
					code,
					tracks,
					path: sector(n, r0, r1),
					lx,
					ly,
					// Square root, as the genre chips do: the busiest key holds ten
					// times the quietest, and linear would leave half the wheel black.
					fill: tracks ? 0.12 + 0.7 * Math.sqrt(tracks / most) : 0.03,
					move: neighbours.get(code) ?? null
				};
			})
		)
	);
</script>

<svg viewBox="0 0 {SIZE} {SIZE}" class="wheel" role="group" aria-label="Camelot wheel">
	{#each segments as s (s.code)}
		{@const on = s.code === selected}
		{@const label = `${s.code} · ${keyForCamelot(s.code)} · ${num(s.tracks)} recordings${s.move ? ` · ${KEY_MOVES[s.move].label} from ${selected}` : ''}`}
		<a href={href(on ? null : s.code)} aria-label={label} aria-current={on ? 'true' : undefined}>
			<title>{label}</title>
			<path
				d={s.path}
				class="seg"
				class:on
				class:near={s.move != null}
				style="--fill: {s.fill}"
			/>
			<text x={s.lx} y={s.ly - 4} class="code" class:dim={!s.tracks}>{s.code}</text>
			<text x={s.lx} y={s.ly + 9} class="n">{s.tracks ? num(s.tracks) : ''}</text>
		</a>
	{/each}
	<text x={C} y={C - 6} class="hub">{selected ?? 'Key'}</text>
	<text x={C} y={C + 12} class="hub-sub">
		{selected ? keyForCamelot(selected) : 'pick one'}
	</text>
</svg>

<style>
	.wheel {
		width: 100%;
		max-width: 320px;
		height: auto;
		display: block;
		margin: 0 auto;
	}
	.seg {
		fill: rgba(124, 58, 237, var(--fill));
		stroke: var(--bg);
		stroke-width: 1.5;
		transition: fill 0.15s ease;
	}
	.seg.near {
		stroke: #c4b5fd;
		stroke-width: 1.5;
		stroke-dasharray: 3 2;
	}
	.seg.on {
		fill: var(--accent-2);
		stroke: #f5d0fe;
		stroke-width: 2;
	}
	a:hover .seg:not(.on) {
		fill: rgba(192, 38, 211, 0.55);
	}
	a:focus-visible {
		outline: none;
	}
	a:focus-visible .seg {
		stroke: #fff;
		stroke-width: 2.5;
	}
	text {
		text-anchor: middle;
		pointer-events: none;
		font-variant-numeric: tabular-nums;
	}
	.code {
		fill: var(--text);
		font-size: 11px;
		font-weight: 600;
	}
	.code.dim {
		fill: var(--text-faint);
	}
	.n {
		fill: rgba(236, 237, 241, 0.6);
		font-size: 8.5px;
	}
	.hub {
		fill: var(--text);
		font-size: 22px;
		font-weight: 650;
		letter-spacing: -0.02em;
	}
	.hub-sub {
		fill: var(--text-faint);
		font-size: 10.5px;
	}
</style>
