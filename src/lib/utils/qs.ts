/**
 * Rebuilds the current URL with some query params changed.
 *
 * Pagination, sorting and search are all plain links so the browser back
 * button, middle-click and a JS-free reload all behave; this keeps the other
 * params intact while one of them changes.
 */
export function withParams(
	url: URL,
	patch: Record<string, string | number | null | undefined>
): string {
	const next = new URL(url);
	for (const [key, value] of Object.entries(patch)) {
		if (value === null || value === undefined || value === '') next.searchParams.delete(key);
		else next.searchParams.set(key, String(value));
	}
	next.searchParams.sort();
	return `${next.pathname}${next.search}`;
}

/** Canonical track ids contain a colon, so they must be encoded in links. */
export const trackHref = (canonicalId: string): string =>
	`/track/${encodeURIComponent(canonicalId)}`;
