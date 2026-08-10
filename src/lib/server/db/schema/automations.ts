import { boolean, check, index, integer, primaryKey, text } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { table, ts, tsNow } from './_shared.ts';

/**
 * Playlist automations: a set of source playlists, and the playlist their
 * tracks are copied into.
 *
 * The other write path in this app (genre collections) OWNS its playlist and
 * rewrites it wholesale. This one does the opposite and the difference is the
 * whole design: an automation only ever APPENDS. It never issues a PUT, never
 * removes an item, and never touches anything it did not put there — so the
 * destination stays an ordinary playlist that can be edited, reordered and
 * added to in Spotify, and the automation keeps feeding it regardless.
 *
 * Which means there is no fingerprint here and no snapshot to compare. What a
 * rewrite gets from recomputing the whole list, this gets from remembering:
 * `automation_added_tracks` is every track the automation has contributed, and
 * a track in there is never offered again. That is what makes a manual removal
 * stick — delete a song from the destination and it stays deleted, because the
 * automation's question is "have I ever added this", not "is it there now".
 *
 * Spotify's API has no concept of a folder: `GET /me/playlists` is flat, and
 * nothing exposes the tree the desktop app shows. So a "folder" here is the set
 * of playlists you picked, which also means a source needs no relation to a
 * folder at all — any playlist can feed any automation.
 */
export const playlistAutomations = table(
	'playlist_automations',
	{
		/** A slug minted from the name at creation, then immutable — renaming must not break a link. */
		id: text().primaryKey(),
		name: text().notNull(),
		description: text(),

		/** Null until the destination playlist has been created; a plain id, deliberately not a FK. */
		spotifyPlaylistId: text(),
		/**
		 * No FK to `playlists`, for the same reason genre collections have none:
		 * that table mirrors what the *sync* has seen, and a playlist created here
		 * exists on Spotify for hours before the next sync ingests it.
		 */
		playlistPublic: boolean().notNull().default(false),
		/** Whether the background job runs this automation on its own. */
		autoRun: boolean().notNull().default(true),
		/**
		 * What the first run does with what the sources already hold. True copies
		 * all of it; false records it as already-seen without adding anything, so
		 * the automation only carries tracks added to a source from then on.
		 * Applied per source, at the moment the source is added.
		 */
		backfill: boolean().notNull().default(true),

		/** Lifetime count of tracks this automation has put in the playlist. */
		addedTrackCount: integer().notNull().default(0),
		/** What the last run added, which is what the page reports. */
		lastAddedCount: integer().notNull().default(0),
		lastRunAt: ts(),
		lastRunError: text(),

		createdAt: tsNow(),
		updatedAt: tsNow()
	},
	(t) => [index('playlist_automations_autorun_ix').on(t.autoRun).where(sql`${t.autoRun}`)]
);

export const automationSources = table(
	'automation_sources',
	{
		automationId: text()
			.notNull()
			.references(() => playlistAutomations.id, { onDelete: 'cascade' }),
		/**
		 * A Spotify playlist id. No FK: a source can be added by pasting a link to
		 * a playlist this database has never ingested, and the row has to exist
		 * before the fetch that would satisfy the constraint.
		 */
		playlistId: text().notNull(),
		/** The name as it read when the source was added — all the page has until the playlist is ingested. */
		label: text(),
		addedAt: tsNow()
	},
	(t) => [
		primaryKey({ columns: [t.automationId, t.playlistId] }),
		index('automation_sources_playlist_ix').on(t.playlistId)
	]
);

/**
 * Every track an automation has accounted for — the ledger that makes "never
 * add the same thing twice" and "never undo a manual removal" the same rule.
 *
 * Keyed on the Spotify track id, but carrying the canonical id too: the same
 * recording appears in this catalog under a dozen ids (album cut, single,
 * per-market release), and a ledger that only knew ids would happily add the
 * deluxe-edition copy of a song it added last week.
 */
export const automationAddedTracks = table(
	'automation_added_tracks',
	{
		automationId: text()
			.notNull()
			.references(() => playlistAutomations.id, { onDelete: 'cascade' }),
		/** No FK to `spotify_tracks`: a cascade there would make the automation re-add the track. */
		trackId: text().notNull(),
		canonicalTrackId: text(),
		/** Which source it came from, as it stood at the time. */
		sourcePlaylistId: text(),
		/**
		 * 'added' was pushed to Spotify. 'seeded' was already in a source when the
		 * source was added to a no-backfill automation: recorded so it is never
		 * offered, never pushed.
		 */
		origin: text().$type<'added' | 'seeded'>().notNull().default('added'),
		addedAt: tsNow()
	},
	(t) => [
		primaryKey({ columns: [t.automationId, t.trackId] }),
		index('automation_added_canonical_ix').on(t.automationId, t.canonicalTrackId),
		check('automation_added_origin', sql`${t.origin} in ('added','seeded')`)
	]
);
