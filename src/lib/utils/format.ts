const nf = new Intl.NumberFormat('en-US');

export const num = (n: number | null | undefined): string => (n == null ? '—' : nf.format(n));

/** Compact duration: 2d 3h, 4h 12m, 3m 20s, 45s. */
export function duration(seconds: number | null | undefined): string {
	if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
	const s = Math.round(seconds);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ${m % 60}m`;
	return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Long-form listening time: "24 days 3 hours". */
export function longDuration(ms: number | null | undefined): string {
	if (ms == null) return '—';
	const totalMinutes = Math.round(ms / 60_000);
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${nf.format(days)} days ${hours} hr`;
	if (hours > 0) return `${hours} hr ${minutes} min`;
	return `${minutes} min`;
}

/** Track length: 3:45. */
export function trackTime(ms: number | null | undefined): string {
	if (ms == null) return '—';
	const total = Math.round(ms / 1000);
	const m = Math.floor(total / 60);
	return `${m}:${String(total % 60).padStart(2, '0')}`;
}

export const pct = (v: number | null | undefined, digits = 0): string =>
	v == null ? '—' : `${(v * 100).toFixed(digits)}%`;

export function relativeTime(value: string | Date | null | undefined): string {
	if (!value) return '—';
	const then = new Date(value).getTime();
	const diff = Date.now() - then;
	const abs = Math.abs(diff);
	const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
	const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
		['year', 31_536_000_000],
		['month', 2_592_000_000],
		['day', 86_400_000],
		['hour', 3_600_000],
		['minute', 60_000],
		['second', 1000]
	];
	for (const [unit, ms] of units) {
		if (abs >= ms || unit === 'second') {
			return rtf.format(Math.round(-diff / ms), unit);
		}
	}
	return '—';
}

const ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' '
};

/**
 * Playlist descriptions arrive as an HTML fragment: entity-escaped, and
 * occasionally carrying `<a href="spotify:…">` links. Svelte escapes on
 * output, so rendering the raw string shows the markup verbatim — this
 * unescapes it and drops the tags so the text reads as its author wrote it.
 */
export function plainText(value: string | null | undefined): string {
	if (!value) return '';
	return value
		.replace(/<[^>]*>/g, '')
		.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
			if (body.startsWith('#x') || body.startsWith('#X'))
				return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
			if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
			return ENTITIES[body.toLowerCase()] ?? whole;
		})
		.replace(/\s+/g, ' ')
		.trim();
}

export function shortDate(value: string | Date | null | undefined): string {
	if (!value) return '—';
	return new Date(value).toLocaleDateString('en-GB', {
		day: 'numeric',
		month: 'short',
		year: 'numeric'
	});
}
