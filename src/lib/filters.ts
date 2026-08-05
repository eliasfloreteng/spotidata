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
	/** What the reset chip says. "All" is right for a subset, wrong for a mode. */
	anyLabel?: string;
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

/**
 * "Saved but never listened to" is a question neither table can answer alone,
 * which makes it the most useful thing the listening history adds to a list
 * page. It reads the play rollup, so it is only meaningful once a history has
 * been imported — the option is harmless before then, it just matches
 * everything.
 */
const PLAYED: FilterGroup = {
	param: 'played',
	label: 'Listening',
	options: [
		{ value: 'played', label: 'Played' },
		{ value: 'never', label: 'Never played', title: 'Saved, but absent from your listening history' }
	]
};

export const LIBRARY_FILTERS: FilterGroup[] = [
	{
		param: 'source',
		label: 'Source',
		options: [
			{ value: 'liked', label: 'Liked' },
			{ value: 'playlist', label: 'In your playlists' },
			{ value: 'liked-only', label: 'Liked, not in a playlist' },
			{ value: 'playlist-only', label: 'In a playlist, not liked' }
		]
	},
	PLAYED,
	COPIES,
	EXPLICIT
];

export const LIKED_FILTERS: FilterGroup[] = [COPIES, EXPLICIT];

/**
 * The genre browser's two mode switches, which are filters in shape only.
 *
 * `src` picks which catalog's opinion counts: MusicBrainz tags the recording,
 * Spotify tags the artist, and they neither agree on a vocabulary nor cover
 * the same half of the library — so the honest default is both at once.
 *
 * `match` is what several selected genres mean together. Widening ("any") is
 * how you fill a playlist; narrowing ("all") is how you find the disco house
 * rather than everything disco and everything house.
 */
export const GENRE_FILTERS: FilterGroup[] = [
	{
		param: 'src',
		label: 'Tagged by',
		anyLabel: 'Both',
		options: [
			{ value: 'recording', label: 'Recording', title: 'MusicBrainz tags on the recording itself' },
			{ value: 'artist', label: 'Artist', title: "Spotify's genres for the credited artist" }
		]
	},
	{
		param: 'match',
		label: 'Match',
		anyLabel: 'Any selected',
		options: [
			{ value: 'all', label: 'All selected', title: 'Only tracks carrying every genre you picked' }
		]
	},
	PLAYED,
	EXPLICIT
];

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
