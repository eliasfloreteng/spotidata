/**
 * Synthetic listening data for the dev-only chart gallery. Deterministic, so a
 * screenshot diff means a rendering change and not a new random draw.
 */

import type { BumpDatum, CalendarDatum } from '$lib/charts/types';

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const rnd = mulberry32(20260731);

const pad = (n: number) => String(n).padStart(2, '0');

/* ── Calendar: three full years of daily plays ─────────────────────────────*/

export const dailyPlays: CalendarDatum[] = (() => {
	const out: CalendarDatum[] = [];
	const start = new Date(2023, 0, 1);
	const end = new Date(2025, 10, 30);
	for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
		const dow = d.getDay();
		const month = d.getMonth();
		// weekends and winter months skew heavier; summer dips
		const weekend = dow === 0 || dow === 6 ? 1.55 : 1;
		const season = 1 + 0.35 * Math.cos(((month - 0) / 12) * 2 * Math.PI);
		const drift = 1 + (d.getFullYear() - 2023) * 0.18;
		const base = 11 * weekend * season * drift;
		const r = rnd();
		// ~11% of days have nothing at all
		const value = r < 0.11 ? 0 : Math.max(0, Math.round(base * (0.35 + rnd() * 1.9)));
		out.push({ day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, value });
	}
	return out;
})();

/* ── Bump: eight artists across eight years ────────────────────────────────*/

const artists = [
	{ key: 'boygenius', label: 'boygenius' },
	{ key: 'fkatwigs', label: 'FKA twigs' },
	{ key: 'kendrick', label: 'Kendrick Lamar' },
	{ key: 'caroline', label: 'Caroline Polachek' },
	{ key: 'floating', label: 'Floating Points' },
	{ key: 'mitski', label: 'Mitski' },
	{ key: 'jamie', label: 'Jamie xx' },
	{ key: 'sufjan', label: 'Sufjan Stevens' }
] as const;

export const artistRanks: BumpDatum[] = (() => {
	const years = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
	// a latent "affinity" per artist that drifts year to year
	const affinity = new Map(artists.map((a, i) => [a.key, 8 - i + rnd() * 1.5]));
	const out: BumpDatum[] = [];
	for (const year of years) {
		for (const a of artists) {
			const prev = affinity.get(a.key) ?? 4;
			affinity.set(a.key, prev + (rnd() - 0.5) * 2.6);
		}
		const ordered = [...artists].sort(
			(x, y) => (affinity.get(y.key) ?? 0) - (affinity.get(x.key) ?? 0)
		);
		ordered.forEach((a, i) => {
			out.push({
				period: year,
				key: a.key,
				label: a.label,
				rank: i + 1,
				value: Math.round(1400 / (i + 1.4) + rnd() * 180)
			});
		});
	}
	return out;
})();

/* ── Monthly series for the area charts ────────────────────────────────────*/

export type MonthPoint = { date: string; value: number };

export const monthlyPlays: MonthPoint[] = (() => {
	const out: MonthPoint[] = [];
	for (let y = 2023; y <= 2025; y++) {
		for (let m = 1; m <= 12; m++) {
			if (y === 2025 && m > 11) break;
			const season = 1 + 0.3 * Math.cos(((m - 1) / 12) * 2 * Math.PI);
			const growth = 1 + (y - 2023) * 0.22;
			out.push({
				date: `${y}-${pad(m)}`,
				value: Math.round(280 * season * growth * (0.75 + rnd() * 0.6))
			});
		}
	}
	return out;
})();

export const monthlyDiscoveries: MonthPoint[] = monthlyPlays.map((p) => ({
	date: p.date,
	value: Math.round(p.value * (0.16 + rnd() * 0.12))
}));

/** Same measure, coarser: a 3-month trailing mean of monthlyPlays. */
export const monthlyTrend: MonthPoint[] = monthlyPlays.map((p, i, all) => {
	const window = all.slice(Math.max(0, i - 2), i + 1);
	return {
		date: p.date,
		value: Math.round(window.reduce((t, w) => t + w.value, 0) / window.length)
	};
});

/* ── Ranked lists ──────────────────────────────────────────────────────────*/

export const topArtists = [
	{ label: 'boygenius', value: 1284, sublabel: '3 albums · 41 tracks' },
	{ label: 'Kendrick Lamar', value: 1102, sublabel: '5 albums · 78 tracks' },
	{ label: 'FKA twigs', value: 913, sublabel: '4 albums · 52 tracks' },
	{ label: 'Caroline Polachek', value: 806, sublabel: '2 albums · 24 tracks' },
	{ label: 'Floating Points', value: 671, sublabel: '3 albums · 29 tracks' },
	{ label: 'Mitski', value: 604, sublabel: '6 albums · 71 tracks' },
	{ label: 'Jamie xx', value: 521, sublabel: '2 albums · 22 tracks' },
	{ label: 'Sufjan Stevens', value: 468, sublabel: '7 albums · 96 tracks' },
	{ label: 'Yeule', value: 377, sublabel: '3 albums · 34 tracks' },
	{ label: 'Alvvays', value: 312, sublabel: '3 albums · 33 tracks' }
];

export const topLabels = [
	{ label: 'Interscope', value: 2140, secondary: 0.184 },
	{ label: 'Young Turks / XL', value: 1832, secondary: 0.157 },
	{ label: 'Dead Oceans', value: 1544, secondary: 0.133 },
	{ label: 'Ninja Tune', value: 1187, secondary: 0.102 },
	{ label: 'Warp Records', value: 964, secondary: 0.083 },
	{ label: 'Sub Pop', value: 702, secondary: 0.06 },
	{ label: '4AD', value: 588, secondary: 0.051 },
	{ label: 'Domino Recording Co.', value: 431, secondary: 0.037 }
];

/* ── Distributions ─────────────────────────────────────────────────────────*/

/** Release years, skewed hard toward the last decade with a long tail. */
export const releaseYears: number[] = (() => {
	const out: number[] = [];
	for (let i = 0; i < 2600; i++) {
		const r = rnd();
		const year =
			r < 0.06
				? 1965 + Math.floor(rnd() * 20)
				: r < 0.2
					? 1985 + Math.floor(rnd() * 15)
					: r < 0.42
						? 2000 + Math.floor(rnd() * 12)
						: 2012 + Math.floor(rnd() * 14);
		out.push(Math.min(2025, year));
	}
	return out;
})();

/** Track durations in seconds — a tight lognormal-ish hump around 3:30. */
export const durations: number[] = (() => {
	const out: number[] = [];
	for (let i = 0; i < 2600; i++) {
		const u = Math.max(1e-6, rnd());
		const v = Math.max(1e-6, rnd());
		const gauss = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
		out.push(Math.round(Math.exp(5.34 + gauss * 0.36)));
	}
	return out.filter((s) => s > 40 && s < 900);
})();

/* ── Donut ─────────────────────────────────────────────────────────────────*/

export const playSources = [
	{ label: 'Album', value: 4820 },
	{ label: 'Own playlist', value: 3140 },
	{ label: 'Radio / autoplay', value: 1690 },
	{ label: 'Editorial playlist', value: 1205 },
	{ label: 'Artist page', value: 640 },
	{ label: 'Search', value: 410 },
	{ label: 'Friend activity', value: 190 },
	{ label: 'Local files', value: 96 }
];

/* ── Sparklines ────────────────────────────────────────────────────────────*/

export const sparkPlays = monthlyPlays.slice(-12).map((p) => p.value);
export const sparkDiscoveries = monthlyDiscoveries.slice(-12).map((p) => p.value);
export const sparkFlat = [42, 42, 42, 42, 42, 42, 42, 42];
export const sparkSingle = [312];
