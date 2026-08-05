/**
 * Presentation helpers for the acoustic analysis.
 *
 * AcousticBrainz reports the key as an ASCII root plus a scale ("G#",
 * "major"), which is correct and ugly. These turn it into what a musician
 * would write, and into the Camelot code a DJ would sort by.
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
const CAMELOT: Record<string, string> = {
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

export function camelot(key: string | null, scale: string | null): string | null {
	if (!key || !scale) return null;
	return CAMELOT[`${key} ${scale.toLowerCase()}`] ?? null;
}

/** Tempo names as a listener would use them, not as a metronome would. */
export function tempoLabel(bpm: number | null): string | null {
	if (bpm == null) return null;
	if (bpm < 70) return 'slow';
	if (bpm < 100) return 'mid-tempo';
	if (bpm < 125) return 'upbeat';
	if (bpm < 145) return 'fast';
	return 'very fast';
}

/**
 * The classifier probabilities worth showing, strongest first.
 *
 * Essentia's mood models are two-class and independent — a track can read 0.9
 * happy and 0.7 sad — so these are presented as separate readings rather than
 * summed into a profile that would not mean anything.
 */
export interface Trait {
	label: string;
	value: number;
}

export function traits(source: Record<string, number | null>, min = 0.6): Trait[] {
	const LABELS: Record<string, string> = {
		danceable: 'danceable',
		happy: 'happy',
		sad: 'sad',
		party: 'party',
		relaxed: 'relaxed',
		aggressive: 'aggressive',
		acoustic: 'acoustic',
		electronic: 'electronic',
		instrumental: 'instrumental',
		bright: 'bright',
		tonal: 'tonal'
	};
	return Object.entries(LABELS)
		.map(([key, label]) => ({ label, value: source[key] ?? 0 }))
		.filter((t) => t.value >= min)
		.sort((a, b) => b.value - a.value);
}
