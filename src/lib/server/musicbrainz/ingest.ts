import { sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { chunkRows, dedupeBy, type Executor } from '../ingest/_bulk.ts';
import {
	albumMusicbrainz,
	artistMusicbrainz,
	audioFeatures,
	isrcRecordings,
	mbArtists,
	mbGenres,
	mbRecordingArtists,
	mbRecordings,
	mbReleaseGroups,
	mbReleases,
	mbTags
} from '../db/schema/index.ts';
import type { AudioAnalysis } from './acousticbrainz.ts';
import type { MbArtist, MbGenre, MbRecording, MbRelease, MbTag } from './types.ts';

type TagEntity = 'recording' | 'artist' | 'release' | 'release_group';

/**
 * Tags and genres share a table and differ only in `isGenre`. MusicBrainz
 * serves genres as a *subset* of tags under a separate `inc`, so an entity
 * fetched with both returns the genre twice — the genre write must therefore
 * come second and win the conflict.
 */
async function writeTags(
	tx: Executor,
	entityType: TagEntity,
	entityMbid: string,
	tags: MbTag[] | undefined,
	genres: MbGenre[] | undefined
): Promise<void> {
	const rows = [
		...(tags ?? []).map((t) => ({
			entityType,
			entityMbid,
			tag: t.name,
			count: t.count ?? 0,
			isGenre: false
		})),
		...(genres ?? []).map((g) => ({
			entityType,
			entityMbid,
			tag: g.name,
			count: g.count ?? 0,
			isGenre: true
		}))
	];
	if (rows.length === 0) return;

	// Last occurrence wins, which is why genres are appended after tags.
	for (const batch of chunkRows(dedupeBy(rows, (r) => r.tag))) {
		await tx
			.insert(mbTags)
			.values(batch)
			.onConflictDoUpdate({
				target: [mbTags.entityType, mbTags.entityMbid, mbTags.tag],
				set: {
					count: sql`excluded.count`,
					// Never demote: an entity known to carry a genre keeps saying so.
					isGenre: sql`${mbTags.isGenre} or excluded.is_genre`
				}
			});
	}
}

// -------------------------------------------------------------- recordings

/**
 * Which of an ISRC's recordings to treat as *the* recording.
 *
 * One ISRC routinely names several MusicBrainz recordings — the album edit,
 * the radio edit, a remaster — and they are genuinely different rows there.
 * The earliest release is the original, which is the one a listening history
 * means when it says you played the song; ties fall to the longest known
 * length and then to the MBID, so the choice is stable across runs.
 */
export function pickRecording(recordings: MbRecording[]): MbRecording | null {
	if (recordings.length === 0) return null;
	return [...recordings].sort((a, b) => {
		const da = a['first-release-date'] || '9999';
		const dbb = b['first-release-date'] || '9999';
		if (da !== dbb) return da < dbb ? -1 : 1;
		if ((a.length ?? 0) !== (b.length ?? 0)) return (b.length ?? 0) - (a.length ?? 0);
		return a.id < b.id ? -1 : 1;
	})[0]!;
}

/**
 * Persists every recording an ISRC resolved to, then points the ISRC at the
 * chosen one.
 *
 * The siblings are kept because they arrived in the same response — they cost
 * nothing — and because their artist credits widen the request-free artist
 * match: a featured artist credited on only the extended edit still gets
 * identified.
 */
export async function saveIsrcLookup(
	isrc: string,
	recordings: MbRecording[],
	on: Executor = db
): Promise<string | null> {
	const chosen = pickRecording(recordings);

	if (!chosen) {
		await on
			.insert(isrcRecordings)
			.values({ isrc, recordingMbid: null, status: 'not_found', candidates: 0 })
			.onConflictDoUpdate({
				target: isrcRecordings.isrc,
				set: {
					recordingMbid: null,
					status: 'not_found',
					candidates: 0,
					lookedUpAt: sql`now()`
				}
			});
		return null;
	}

	for (const rec of recordings) {
		await on
			.insert(mbRecordings)
			.values({
				mbid: rec.id,
				title: rec.title,
				lengthMs: rec.length ?? null,
				firstReleaseDate: rec['first-release-date'] || null,
				disambiguation: rec.disambiguation || null,
				video: rec.video ?? false
			})
			.onConflictDoUpdate({
				target: mbRecordings.mbid,
				set: {
					title: sql`excluded.title`,
					lengthMs: sql`excluded.length_ms`,
					firstReleaseDate: sql`excluded.first_release_date`,
					disambiguation: sql`excluded.disambiguation`,
					video: sql`excluded.video`,
					fetchedAt: sql`now()`
				}
			});

		await writeTags(on, 'recording', rec.id, rec.tags, rec.genres);
		await saveArtistCredits(on, rec);
	}

	await on
		.insert(isrcRecordings)
		.values({
			isrc,
			recordingMbid: chosen.id,
			status: 'matched',
			candidates: recordings.length
		})
		.onConflictDoUpdate({
			target: isrcRecordings.isrc,
			set: {
				recordingMbid: sql`excluded.recording_mbid`,
				status: 'matched',
				candidates: sql`excluded.candidates`,
				lookedUpAt: sql`now()`
			}
		});

	return chosen.id;
}

/**
 * The credit list, plus a stub row for each artist named in it.
 *
 * The stub is the point: it carries the MBID, so `match_artists_by_credit()`
 * can wire thousands of Spotify artists to MusicBrainz without spending a
 * single request on them.
 */
async function saveArtistCredits(tx: Executor, rec: MbRecording): Promise<void> {
	const credits = rec['artist-credit'] ?? [];
	if (credits.length === 0) return;

	const stubs = dedupeBy(
		credits.map((c) => ({
			mbid: c.artist.id,
			name: c.artist.name,
			sortName: c.artist['sort-name'] ?? null,
			type: c.artist.type ?? null,
			country: c.artist.country ?? null,
			disambiguation: c.artist.disambiguation || null
		})),
		(a) => a.mbid
	);

	await tx
		.insert(mbArtists)
		.values(stubs)
		.onConflictDoUpdate({
			target: mbArtists.mbid,
			set: {
				// A stub must never overwrite a full row's columns with nulls, so
				// everything here coalesces onto what is already stored.
				name: sql`excluded.name`,
				sortName: sql`coalesce(excluded.sort_name, ${mbArtists.sortName})`,
				type: sql`coalesce(excluded.type, ${mbArtists.type})`,
				country: sql`coalesce(excluded.country, ${mbArtists.country})`,
				disambiguation: sql`coalesce(excluded.disambiguation, ${mbArtists.disambiguation})`
			}
		});

	for (const c of credits) {
		await writeTags(tx, 'artist', c.artist.id, c.artist.tags, c.artist.genres);
	}

	const links = credits.map((c, position) => ({
		recordingMbid: rec.id,
		position,
		artistMbid: c.artist.id,
		creditName: c.name || c.artist.name,
		joinPhrase: c.joinphrase || null
	}));

	await tx
		.insert(mbRecordingArtists)
		.values(links)
		.onConflictDoUpdate({
			target: [mbRecordingArtists.recordingMbid, mbRecordingArtists.position],
			set: {
				artistMbid: sql`excluded.artist_mbid`,
				creditName: sql`excluded.credit_name`,
				joinPhrase: sql`excluded.join_phrase`
			}
		});
}

// ----------------------------------------------------------------- artists

export async function saveArtistDetail(artist: MbArtist, on: Executor = db): Promise<void> {
	const life = artist['life-span'] ?? {};
	await on
		.insert(mbArtists)
		.values({
			mbid: artist.id,
			name: artist.name,
			sortName: artist['sort-name'] ?? null,
			type: artist.type ?? null,
			gender: artist.gender ?? null,
			country: artist.country ?? null,
			areaName: artist.area?.name ?? null,
			beginAreaName: artist['begin-area']?.name ?? null,
			beginDate: life.begin ?? null,
			endDate: life.end ?? null,
			ended: life.ended ?? false,
			disambiguation: artist.disambiguation || null,
			ratingValue: artist.rating?.value ?? null,
			ratingVotes: artist.rating?.['votes-count'] ?? null,
			isnis: artist.isnis ?? [],
			detailLevel: 'full'
		})
		.onConflictDoUpdate({
			target: mbArtists.mbid,
			set: {
				name: sql`excluded.name`,
				sortName: sql`excluded.sort_name`,
				type: sql`excluded.type`,
				gender: sql`excluded.gender`,
				country: sql`excluded.country`,
				areaName: sql`excluded.area_name`,
				beginAreaName: sql`excluded.begin_area_name`,
				beginDate: sql`excluded.begin_date`,
				endDate: sql`excluded.end_date`,
				ended: sql`excluded.ended`,
				disambiguation: sql`excluded.disambiguation`,
				ratingValue: sql`excluded.rating_value`,
				ratingVotes: sql`excluded.rating_votes`,
				isnis: sql`excluded.isnis`,
				detailLevel: 'full',
				fetchedAt: sql`now()`
			}
		});

	await writeTags(on, 'artist', artist.id, artist.tags, artist.genres);
}

export async function linkArtist(
	spotifyArtistId: string,
	mbid: string | null,
	source: 'url' | 'credit' | null,
	on: Executor = db
): Promise<void> {
	await on
		.insert(artistMusicbrainz)
		.values({
			artistId: spotifyArtistId,
			mbid,
			status: mbid ? 'matched' : 'not_found',
			source: mbid ? source : null
		})
		.onConflictDoUpdate({
			target: artistMusicbrainz.artistId,
			set: {
				mbid: sql`excluded.mbid`,
				status: sql`excluded.status`,
				source: sql`excluded.source`,
				lookedUpAt: sql`now()`
			}
		});
}

// ---------------------------------------------------------------- releases

export async function saveRelease(release: MbRelease, on: Executor = db): Promise<void> {
	const group = release['release-group'] ?? null;

	if (group) {
		await on
			.insert(mbReleaseGroups)
			.values({
				mbid: group.id,
				title: group.title,
				primaryType: group['primary-type'] ?? null,
				secondaryTypes: group['secondary-types'] ?? [],
				firstReleaseDate: group['first-release-date'] || null,
				disambiguation: group.disambiguation || null
			})
			.onConflictDoUpdate({
				target: mbReleaseGroups.mbid,
				set: {
					title: sql`excluded.title`,
					primaryType: sql`excluded.primary_type`,
					secondaryTypes: sql`excluded.secondary_types`,
					firstReleaseDate: sql`excluded.first_release_date`,
					disambiguation: sql`excluded.disambiguation`,
					fetchedAt: sql`now()`
				}
			});
		await writeTags(on, 'release_group', group.id, group.tags, group.genres);
	}

	const label = release['label-info']?.find((l) => l.label) ?? release['label-info']?.[0];

	await on
		.insert(mbReleases)
		.values({
			mbid: release.id,
			title: release.title,
			status: release.status ?? null,
			date: release.date || null,
			country: release.country ?? null,
			barcode: release.barcode || null,
			packaging: release.packaging ?? null,
			language: release['text-representation']?.language ?? null,
			script: release['text-representation']?.script ?? null,
			labelName: label?.label?.name ?? null,
			catalogNumber: label?.['catalog-number'] ?? null,
			releaseGroupMbid: group?.id ?? null
		})
		.onConflictDoUpdate({
			target: mbReleases.mbid,
			set: {
				title: sql`excluded.title`,
				status: sql`excluded.status`,
				date: sql`excluded.date`,
				country: sql`excluded.country`,
				barcode: sql`excluded.barcode`,
				packaging: sql`excluded.packaging`,
				language: sql`excluded.language`,
				script: sql`excluded.script`,
				labelName: sql`excluded.label_name`,
				catalogNumber: sql`excluded.catalog_number`,
				releaseGroupMbid: sql`excluded.release_group_mbid`,
				fetchedAt: sql`now()`
			}
		});

	await writeTags(on, 'release', release.id, release.tags, release.genres);
}

export async function linkAlbum(
	spotifyAlbumId: string,
	releaseMbid: string | null,
	source: 'url' | 'barcode' | null,
	on: Executor = db
): Promise<void> {
	await on
		.insert(albumMusicbrainz)
		.values({
			albumId: spotifyAlbumId,
			releaseMbid,
			status: releaseMbid ? 'matched' : 'not_found',
			source: releaseMbid ? source : null
		})
		.onConflictDoUpdate({
			target: albumMusicbrainz.albumId,
			set: {
				releaseMbid: sql`excluded.release_mbid`,
				status: sql`excluded.status`,
				source: sql`excluded.source`,
				lookedUpAt: sql`now()`
			}
		});
}

// ----------------------------------------------------------------- audio

/**
 * Re-analysis is rare but real (a better extractor, a second submission), so
 * every column is refreshed rather than left alone on conflict — including a
 * 'missing' row that has since been filled in.
 */
export async function saveAudioAnalysis(rows: AudioAnalysis[], on: Executor = db): Promise<void> {
	if (rows.length === 0) return;
	for (const batch of chunkRows(dedupeBy(rows, (r) => r.recordingMbid))) {
		await on
			.insert(audioFeatures)
			.values(batch)
			.onConflictDoUpdate({
				target: audioFeatures.recordingMbid,
				set: {
					status: sql`excluded.status`,
					bpm: sql`excluded.bpm`,
					beatsCount: sql`excluded.beats_count`,
					onsetRate: sql`excluded.onset_rate`,
					danceabilityRaw: sql`excluded.danceability_raw`,
					keyKey: sql`excluded.key_key`,
					keyScale: sql`excluded.key_scale`,
					keyStrength: sql`excluded.key_strength`,
					chordsKey: sql`excluded.chords_key`,
					chordsScale: sql`excluded.chords_scale`,
					chordsChangesRate: sql`excluded.chords_changes_rate`,
					tuningFrequency: sql`excluded.tuning_frequency`,
					averageLoudness: sql`excluded.average_loudness`,
					replayGain: sql`excluded.replay_gain`,
					lengthSeconds: sql`excluded.length_seconds`,
					dynamicComplexity: sql`excluded.dynamic_complexity`,
					spectralCentroid: sql`excluded.spectral_centroid`,
					danceable: sql`excluded.danceable`,
					aggressive: sql`excluded.aggressive`,
					electronic: sql`excluded.electronic`,
					acoustic: sql`excluded.acoustic`,
					happy: sql`excluded.happy`,
					sad: sql`excluded.sad`,
					party: sql`excluded.party`,
					relaxed: sql`excluded.relaxed`,
					bright: sql`excluded.bright`,
					tonal: sql`excluded.tonal`,
					instrumental: sql`excluded.instrumental`,
					female: sql`excluded.female`,
					moodMirex: sql`excluded.mood_mirex`,
					genreDortmund: sql`excluded.genre_dortmund`,
					genreElectronic: sql`excluded.genre_electronic`,
					genreRosamerica: sql`excluded.genre_rosamerica`,
					genreTzanetakis: sql`excluded.genre_tzanetakis`,
					fetchedAt: sql`now()`
				}
			});
	}
}

// ------------------------------------------------------------- vocabulary

export async function saveGenreVocabulary(names: string[], on: Executor = db): Promise<number> {
	if (names.length === 0) return 0;
	const rows = dedupeBy(
		names.map((name) => ({ name })),
		(r) => r.name
	);
	for (const batch of chunkRows(rows, 1000)) {
		await on.insert(mbGenres).values(batch).onConflictDoNothing();
	}
	return rows.length;
}
