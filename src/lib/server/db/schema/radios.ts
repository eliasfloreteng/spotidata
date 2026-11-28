import { index, integer, primaryKey, smallint, text } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { table, tsNow } from './_shared.ts';
import { spotifyTracks } from './catalog.ts';

/**
 * Each song's Spotify radio, synced like the rest of the archive.
 *
 * A radio is the 50 records Spotify plays after a seed track — the one
 * "what goes with this" judgement Spotify still hands out, now that the
 * recommendations and related-artists endpoints are gone. The DJ tab ranks its
 * suggestions by it, so it is kept for every library recording rather than
 * fetched on every page load (`queue/tasks/radios.ts`).
 *
 * Keyed on the seed's Spotify track id, not its canonical id, since a
 * regrouping must not orphan a row. A recording's radio is whichever of its
 * copies has one, freshest first: Spotify builds the same radio from the
 * single and the album cut.
 */
export const songRadios = table(
	'song_radios',
	{
		seedTrackId: text()
			.primaryKey()
			.references(() => spotifyTracks.id, { onDelete: 'cascade' }),
		/** The radio playlist. Null when Spotify has no radio for the track, which is an answer too. */
		playlistId: text(),
		name: text(),
		description: text(),
		image: text(),
		trackCount: integer().notNull().default(0),
		fetchedAt: tsNow()
	},
	(t) => [index('song_radios_fetched_ix').on(t.fetchedAt)]
);

/**
 * The records a radio plays, in its order.
 *
 * Self-contained rather than pointing into `spotify_tracks`: fifty records for
 * each of nine thousand seeds is far more of the catalog than the archive
 * otherwise holds, and the radio only needs what matching it to the library
 * takes — the ISRC (the recording), the title and the artists (the song).
 */
export const songRadioTracks = table(
	'song_radio_tracks',
	{
		seedTrackId: text()
			.notNull()
			.references(() => songRadios.seedTrackId, { onDelete: 'cascade' }),
		position: smallint().notNull(),
		trackId: text().notNull(),
		/** Upper-cased, like `deckhand.recordings`. */
		isrc: text(),
		title: text().notNull(),
		/** Every credited artist, the primary one first. */
		artistIds: text().array().notNull().default(sql`'{}'::text[]`)
	},
	(t) => [
		primaryKey({ columns: [t.seedTrackId, t.position] }),
		index('song_radio_tracks_track_ix').on(t.trackId),
		index('song_radio_tracks_isrc_ix').on(t.isrc).where(sql`${t.isrc} is not null`)
	]
);
