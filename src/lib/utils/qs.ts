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
 * Adds a value to a repeated query param, or removes it if it is already there.
 *
 * The genre explorer stages a set in the URL, so every toggle is an ordinary
 * link: the back button walks the selection, a set can be bookmarked or pasted,
 * and the counts come from the same load function whether or not JS ran.
 */
export function toggleValue(url: URL, name: string, value: string): string {
	const next = new URL(url);
	const current = next.searchParams.getAll(name);
	const kept = current.filter((v) => v !== value);
	if (kept.length === current.length) kept.push(value);

	next.searchParams.delete(name);
	for (const v of kept) next.searchParams.append(name, v);
	next.searchParams.sort();
	return `${next.pathname}${next.search}`;
}

/** Canonical track ids contain a colon, so they must be encoded in links. */
export const trackHref = (canonicalId: string): string =>
	`/track/${encodeURIComponent(canonicalId)}`;

/** Genres are their own name — spaces, slashes and ampersands included. */
export const genreHref = (genre: string): string => `/genre/${encodeURIComponent(genre)}`;
