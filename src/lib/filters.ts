/**
 * Filter vocabularies for the index pages.
 *
 * Each group is one query param with a closed set of values. The definitions
 * live here — outside `$lib/server` — because both ends need them: the load
 * function validates `?param=` against the values, and the page renders the
 * labels as links. Keeping one source of truth means a value can never be
 * offered in the UI without the query knowing how to apply it.
 */

export interface FilterOption {
	/** The `?param=` value. Never the empty string — "no filter" is the absence of the param. */
	value: string;
	label: string;
	title?: string;
}

export interface FilterGroup {
	param: string;
	label: string;
	options: FilterOption[];
}

/** The resolved `param -> value` map, where `''` means the group is inactive. */
export type ActiveFilters = Record<string, string>;

/**
 * Resolves a page's filter params against their vocabularies. An unknown value —
 * a hand-edited URL, or a link left over from an older build — reads as no
 * filter at all rather than an error, which keeps the list page always loadable.
 */
export function filterParams(url: URL, groups: readonly FilterGroup[]): ActiveFilters {
	const active: ActiveFilters = {};
	for (const group of groups) {
		const raw = url.searchParams.get(group.param) ?? '';
		active[group.param] = group.options.some((o) => o.value === raw) ? raw : '';
	}
	return active;
}

const EXPLICIT: FilterGroup = {
	param: 'explicit',
	label: 'Content',
	options: [
		{ value: 'yes', label: 'Explicit' },
		{ value: 'no', label: 'Clean' }
	]
};

const COPIES: FilterGroup = {
	param: 'copies',
	label: 'Copies',
	options: [
		{ value: 'dupes', label: 'Duplicated', title: 'The same recording under more than one track id' },
		{ value: 'unique', label: 'Single copy' }
	]
};

export const LIBRARY_FILTERS: FilterGroup[] = [
	{
		param: 'source',
		label: 'Source',
		options: [
			{ value: 'liked', label: 'Liked' },
			{ value: 'playlist', label: 'In your playlists' },
			{ value: 'liked-only', label: 'Liked, not in a playlist' }
		]
	},
	COPIES,
	EXPLICIT
];

export const LIKED_FILTERS: FilterGroup[] = [COPIES, EXPLICIT];

export const ARTIST_FILTERS: FilterGroup[] = [
	{
		param: 'followed',
		label: 'Following',
		options: [
			{ value: 'yes', label: 'Followed' },
			{ value: 'no', label: 'Not followed' }
		]
	}
];

export const ALBUM_FILTERS: FilterGroup[] = [
	{
		param: 'type',
		label: 'Type',
		options: [
			{ value: 'album', label: 'Albums' },
			{ value: 'single', label: 'Singles' },
			{ value: 'compilation', label: 'Compilations' }
		]
	},
	{
		param: 'saved',
		label: 'Saved',
		options: [
			{ value: 'yes', label: 'In your albums' },
			{ value: 'no', label: 'Not saved' }
		]
	},
	{
		param: 'coverage',
		label: 'Coverage',
		options: [
			{ value: 'full', label: 'Complete', title: 'Every track on the album is in your library' },
			{ value: 'partial', label: 'Partial' }
		]
	}
];

export const PLAYLIST_FILTERS: FilterGroup[] = [
	{
		param: 'owner',
		label: 'Owner',
		options: [
			{ value: 'mine', label: 'Yours' },
			{ value: 'others', label: "Others'" }
		]
	},
	{
		param: 'access',
		label: 'Access',
		options: [
			{ value: 'collab', label: 'Collaborative' },
			{ value: 'public', label: 'Public' },
			{ value: 'private', label: 'Private' }
		]
	}
];
