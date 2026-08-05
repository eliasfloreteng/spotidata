/**
 * The slices of the MusicBrainz XML Web Service (v2, `?fmt=json`) this app
 * actually reads. Hand-written rather than generated: the schema is enormous,
 * every field is optional in practice, and half of it is relationships we
 * never ask for.
 */

export interface MbTag {
	name: string;
	count?: number;
}

/** `inc=genres` returns the same shape as tags, filtered to real genres. */
export type MbGenre = MbTag;

export interface MbArtistStub {
	id: string;
	name: string;
	'sort-name'?: string;
	type?: string | null;
	country?: string | null;
	disambiguation?: string;
	tags?: MbTag[];
	genres?: MbGenre[];
}

export interface MbArtistCredit {
	name: string;
	joinphrase?: string;
	artist: MbArtistStub;
}

export interface MbRecording {
	id: string;
	title: string;
	length?: number | null;
	disambiguation?: string;
	video?: boolean | null;
	'first-release-date'?: string;
	'artist-credit'?: MbArtistCredit[];
	tags?: MbTag[];
	genres?: MbGenre[];
}

export interface MbIsrcResponse {
	isrc: string;
	recordings: MbRecording[];
}

export interface MbArea {
	name?: string;
	'sort-name'?: string;
	'iso-3166-1-codes'?: string[];
}

export interface MbLifeSpan {
	begin?: string | null;
	end?: string | null;
	ended?: boolean | null;
}

export interface MbRating {
	value?: number | null;
	'votes-count'?: number | null;
}

export interface MbArtist extends MbArtistStub {
	gender?: string | null;
	area?: MbArea | null;
	'begin-area'?: MbArea | null;
	'life-span'?: MbLifeSpan;
	rating?: MbRating;
	isnis?: string[];
}

export interface MbReleaseGroup {
	id: string;
	title: string;
	'primary-type'?: string | null;
	'secondary-types'?: string[];
	'first-release-date'?: string;
	disambiguation?: string;
	tags?: MbTag[];
	genres?: MbGenre[];
}

export interface MbLabelInfo {
	'catalog-number'?: string | null;
	label?: { id: string; name: string } | null;
}

export interface MbRelease {
	id: string;
	title: string;
	status?: string | null;
	date?: string | null;
	country?: string | null;
	barcode?: string | null;
	packaging?: string | null;
	'text-representation'?: { language?: string | null; script?: string | null } | null;
	'release-group'?: MbReleaseGroup | null;
	'label-info'?: MbLabelInfo[];
	tags?: MbTag[];
	genres?: MbGenre[];
}

/**
 * A URL lookup answers with the URL entity and its relationships. Which
 * entity is attached depends on `inc`, so both possibilities are optional and
 * the caller picks the one it asked for.
 */
export interface MbUrlRelation {
	type?: string;
	'target-type'?: string;
	artist?: MbArtistStub;
	release?: MbRelease;
}

export interface MbUrlResponse {
	id: string;
	resource: string;
	relations?: MbUrlRelation[];
}
