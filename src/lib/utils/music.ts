/**
 * Musical keys and the Camelot wheel, for the DJ tab.
 *
 * Keys are written as an ASCII root plus a scale ("G#", "minor"), which is
 * correct and ugly. These turn it into what a musician would write, and into
 * the Camelot code a DJ would sort by.
 */

const SHARP_TO_UNICODE: Record<string, string> = {
	'A#': 'A♯',
	'C#': 'C♯',
	'D#': 'D♯',
	'F#': 'F♯',
	'G#': 'G♯'
};

export function musicalKey(key: string | null, scale: string | null): string | null {
	if (!key) return null;
	const root = SHARP_TO_UNICODE[key] ?? key;
	return scale ? `${root} ${scale}` : root;
}

/**
 * The Camelot wheel: keys a fifth apart, or relative major/minor, land on
 * adjacent codes, so two tracks whose codes differ by one mix.
 */
export const CAMELOT: Record<string, string> = {
	'C major': '8B',
	'C# major': '3B',
	'D major': '10B',
	'D# major': '5B',
	'E major': '12B',
	'F major': '7B',
	'F# major': '2B',
	'G major': '9B',
	'G# major': '4B',
	'A major': '11B',
	'A# major': '6B',
	'B major': '1B',
	'C minor': '5A',
	'C# minor': '12A',
	'D minor': '7A',
	'D# minor': '2A',
	'E minor': '9A',
	'F minor': '4A',
	'F# minor': '11A',
	'G minor': '6A',
	'G# minor': '1A',
	'A minor': '8A',
	'A# minor': '3A',
	'B minor': '10A'
};

// ------------------------------------------------------------------ mixing

/**
 * What a DJ needs from the wheel: which codes sit next to which.
 *
 * This is the one definition of a harmonic move in the app. The server asks
 * `movesFrom` for the codes a track may be followed by and hands them to
 * Postgres as a table, and the set builder labels each transition with
 * `keyMove` — so what the suggestions offer and what the set calls the move
 * cannot disagree.
 */
export interface Camelot {
	n: number;
	letter: 'A' | 'B';
}

export function parseCamelot(code: string | null | undefined): Camelot | null {
	const m = code?.match(/^(1[0-2]|[1-9])([AB])$/);
	return m ? { n: Number(m[1]), letter: m[2] as 'A' | 'B' } : null;
}

/** 1A, 1B, 2A … 12B — the wheel read clockwise, minor inside major. */
export const CAMELOT_CODES: string[] = Array.from({ length: 12 }, (_, i) => [
	`${i + 1}A`,
	`${i + 1}B`
]).flat();

/** The musical key a Camelot code stands for, for a tooltip. */
export function keyForCamelot(code: string): string | null {
	const hit = Object.entries(CAMELOT).find(([, c]) => c === code)?.[0];
	if (!hit) return null;
	const [root, scale] = hit.split(' ');
	return musicalKey(root ?? null, scale ?? null);
}

export type KeyMove = 'same' | 'relative' | 'up' | 'down' | 'diagonal' | 'boost' | 'semitone';

/**
 * Every move worth making, with how safe it is.
 *
 * The weights rank suggestions, they do not gate them: the key mode decides
 * which moves are offered at all, and within that the safest blend comes first.
 * The last two are energy changes rather than blends — they work on a cut or a
 * short overlap and sound wrong over a long one, which is why they are opt-in.
 */
export const KEY_MOVES: Record<KeyMove, { label: string; title: string; weight: number }> = {
	same: { label: 'Same key', title: 'Identical key — the safest blend there is', weight: 1 },
	relative: {
		label: 'Relative',
		title: 'Relative major/minor: the same notes in a different mood',
		weight: 0.9
	},
	up: { label: '+1', title: 'A fifth up — blends cleanly and lifts the energy', weight: 0.85 },
	down: { label: '−1', title: 'A fifth down — blends cleanly and eases off', weight: 0.85 },
	diagonal: {
		label: 'Diagonal',
		title: 'One step round and across the wheel — works, with a careful blend',
		weight: 0.6
	},
	boost: {
		label: '+2 boost',
		title: 'A whole step up — an energy boost, best on a quick transition',
		weight: 0.5
	},
	semitone: {
		label: '+7 lift',
		title: 'A semitone up — the key-change lift; cut rather than blend',
		weight: 0.4
	}
};

/** The move from one code to the next, or null when the two keys clash. */
export function keyMove(from: string | null, to: string | null): KeyMove | null {
	const a = parseCamelot(from);
	const b = parseCamelot(to);
	if (!a || !b) return null;
	const d = (b.n - a.n + 12) % 12;
	if (a.letter === b.letter) {
		if (d === 0) return 'same';
		if (d === 1) return 'up';
		if (d === 11) return 'down';
		if (d === 2) return 'boost';
		if (d === 7) return 'semitone';
		return null;
	}
	if (d === 0) return 'relative';
	// 8A → 9B and 8B → 7A: round one and across, in the direction that keeps
	// the shared notes.
	if ((a.letter === 'A' && d === 1) || (a.letter === 'B' && d === 11)) return 'diagonal';
	return null;
}

export const KEY_MODES = {
	harmonic: { label: 'Harmonic', title: 'Same key, relative, ±1 and diagonal' },
	energy: { label: '+ Energy moves', title: 'Also the +2 boost and the +7 semitone lift' },
	any: { label: 'Any key', title: 'Ignore the key; clashes rank last' }
} as const;
export type KeyMode = keyof typeof KEY_MODES;

const HARMONIC: ReadonlySet<KeyMove> = new Set(['same', 'relative', 'up', 'down', 'diagonal']);

/** Every code a track in `from` may be followed by, with its move and weight. */
export function movesFrom(
	from: string,
	mode: KeyMode
): { code: string; move: KeyMove | null; weight: number }[] {
	return CAMELOT_CODES.flatMap((code) => {
		const move = keyMove(from, code);
		if (mode === 'any') return [{ code, move, weight: move ? KEY_MOVES[move].weight : 0 }];
		if (!move || (mode === 'harmonic' && !HARMONIC.has(move))) return [];
		return [{ code, move, weight: KEY_MOVES[move].weight }];
	});
}

/** Pitch-fader ranges, as a percentage either side of the playing track. */
export const TEMPO_TOLERANCES = [3, 6, 10] as const;
export type TempoTolerance = (typeof TEMPO_TOLERANCES)[number];

/** "+2.4%" — signed, because the direction is the whole point. */
export function tempoShift(pct: number | null): string {
	if (pct == null) return '—';
	const r = Math.round(pct * 10) / 10;
	if (r === 0) return '±0%';
	return `${r > 0 ? '+' : '−'}${Math.abs(r).toFixed(1)}%`;
}
