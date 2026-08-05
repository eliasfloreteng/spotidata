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

/**
 * Adds or removes one value of a repeatable param — the genre picker's whole
 * interaction, as a plain link.
 *
 * The page is dropped for the same reason every filter drops it: row 340 of
 * the old result set means nothing in the new one. `sort()` is stable across
 * equal keys, so the remaining values keep the order they were picked in.
 */
export function toggleParam(url: URL, param: string, value: string): string {
	const next = new URL(url);
	const values = next.searchParams.getAll(param);
	next.searchParams.delete(param);
	for (const v of values) if (v !== value) next.searchParams.append(param, v);
	if (!values.includes(value)) next.searchParams.append(param, value);
	next.searchParams.delete('page');
	next.searchParams.sort();
	return `${next.pathname}${next.search}`;
}

/** Canonical track ids contain a colon, so they must be encoded in links. */
export const trackHref = (canonicalId: string): string =>
	`/track/${encodeURIComponent(canonicalId)}`;
