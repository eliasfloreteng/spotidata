import { defineRelations } from 'drizzle-orm';
import * as schema from './schema/index.ts';

/**
 * Relations v2 (`defineRelations`). Note `from`/`to` replace v1's
 * `fields`/`references`, and `.through()` expresses many-to-many without
 * surfacing the junction table in queries.
 */
export const relations = defineRelations(schema, (r) => ({
	artists: {
		genres: r.many.genres({
			from: r.artists.id.through(r.artistGenres.artistId),
			to: r.genres.name.through(r.artistGenres.genre)
		}),
		images: r.many.artistImages({
			from: r.artists.id,
			to: r.artistImages.artistId
		}),
		albums: r.many.albums({
			from: r.artists.id.through(r.albumArtists.artistId),
			to: r.albums.id.through(r.albumArtists.albumId)
		}),
		tracks: r.many.spotifyTracks({
			from: r.artists.id.through(r.trackArtists.artistId),
			to: r.spotifyTracks.id.through(r.trackArtists.trackId)
		}),
		followed: r.one.followedArtists({
			from: r.artists.id,
			to: r.followedArtists.artistId
		})
	},

	albums: {
		artists: r.many.artists({
			from: r.albums.id.through(r.albumArtists.albumId),
			to: r.artists.id.through(r.albumArtists.artistId)
		}),
		images: r.many.albumImages({
			from: r.albums.id,
			to: r.albumImages.albumId
		}),
		genres: r.many.genres({
			from: r.albums.id.through(r.albumGenres.albumId),
			to: r.genres.name.through(r.albumGenres.genre)
		}),
		tracks: r.many.spotifyTracks({
			from: r.albums.id,
			to: r.spotifyTracks.albumId
		}),
		saved: r.one.savedAlbums({ from: r.albums.id, to: r.savedAlbums.albumId }),
		group: r.one.albumGroups({ from: r.albums.albumGroupId, to: r.albumGroups.id })
	},

	albumGroups: {
		editions: r.many.albums({ from: r.albumGroups.id, to: r.albums.albumGroupId }),
		representative: r.one.albums({
			from: r.albumGroups.representativeAlbumId,
			to: r.albums.id
		}),
		primaryArtist: r.one.artists({
			from: r.albumGroups.primaryArtistId,
			to: r.artists.id
		})
	},

	spotifyTracks: {
		album: r.one.albums({ from: r.spotifyTracks.albumId, to: r.albums.id }),
		artists: r.many.artists({
			from: r.spotifyTracks.id.through(r.trackArtists.trackId),
			to: r.artists.id.through(r.trackArtists.artistId)
		}),
		canonical: r.one.canonicalTracks({
			from: r.spotifyTracks.canonicalTrackId,
			to: r.canonicalTracks.id
		}),
		saved: r.one.savedTracks({ from: r.spotifyTracks.id, to: r.savedTracks.trackId }),
		inLibrary: r.one.libraryTracks({
			from: r.spotifyTracks.id,
			to: r.libraryTracks.trackId
		}),
		playlistEntries: r.many.playlistTracks({
			from: r.spotifyTracks.id,
			to: r.playlistTracks.trackId
		})
	},

	canonicalTracks: {
		copies: r.many.spotifyTracks({
			from: r.canonicalTracks.id,
			to: r.spotifyTracks.canonicalTrackId
		}),
		representative: r.one.spotifyTracks({
			from: r.canonicalTracks.representativeTrackId,
			to: r.spotifyTracks.id
		}),
		primaryArtist: r.one.artists({
			from: r.canonicalTracks.primaryArtistId,
			to: r.artists.id
		}),
		primaryAlbum: r.one.albums({
			from: r.canonicalTracks.primaryAlbumId,
			to: r.albums.id
		}),
		artists: r.many.artists({
			from: r.canonicalTracks.id.through(r.canonicalTrackArtists.canonicalTrackId),
			to: r.artists.id.through(r.canonicalTrackArtists.artistId)
		}),
		library: r.one.libraryCanonical({
			from: r.canonicalTracks.id,
			to: r.libraryCanonical.canonicalTrackId
		})
	},

	playlists: {
		owner: r.one.spotifyUsers({ from: r.playlists.ownerId, to: r.spotifyUsers.id }),
		images: r.many.playlistImages({
			from: r.playlists.id,
			to: r.playlistImages.playlistId
		}),
		items: r.many.playlistTracks({
			from: r.playlists.id,
			to: r.playlistTracks.playlistId
		})
	},

	playlistTracks: {
		playlist: r.one.playlists({ from: r.playlistTracks.playlistId, to: r.playlists.id }),
		track: r.one.spotifyTracks({ from: r.playlistTracks.trackId, to: r.spotifyTracks.id })
	},

	syncRuns: {
		phases: r.many.syncPhases(),
		events: r.many.syncEvents()
	},
	syncPhases: {
		run: r.one.syncRuns({ from: r.syncPhases.runId, to: r.syncRuns.id })
	},
	syncEvents: {
		run: r.one.syncRuns({ from: r.syncEvents.runId, to: r.syncRuns.id })
	}
}));
