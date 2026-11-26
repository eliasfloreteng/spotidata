ALTER TABLE "album_musicbrainz" DROP CONSTRAINT "album_musicbrainz_release_mbid_mb_releases_mbid_fkey";--> statement-breakpoint
ALTER TABLE "artist_musicbrainz" DROP CONSTRAINT "artist_musicbrainz_mbid_mb_artists_mbid_fkey";--> statement-breakpoint
ALTER TABLE "audio_features" DROP CONSTRAINT "audio_features_recording_mbid_mb_recordings_mbid_fkey";--> statement-breakpoint
ALTER TABLE "isrc_recordings" DROP CONSTRAINT "isrc_recordings_recording_mbid_mb_recordings_mbid_fkey";--> statement-breakpoint
ALTER TABLE "mb_recording_artists" DROP CONSTRAINT "mb_recording_artists_recording_mbid_mb_recordings_mbid_fkey";--> statement-breakpoint
ALTER TABLE "mb_releases" DROP CONSTRAINT "mb_releases_release_group_mbid_mb_release_groups_mbid_fkey";--> statement-breakpoint
DROP TABLE "album_musicbrainz";--> statement-breakpoint
DROP TABLE "artist_musicbrainz";--> statement-breakpoint
DROP TABLE "audio_features";--> statement-breakpoint
DROP TABLE "enrich_stages";--> statement-breakpoint
DROP TABLE "external_tokens";--> statement-breakpoint
DROP TABLE "isrc_recordings";--> statement-breakpoint
DROP TABLE "mb_artists";--> statement-breakpoint
DROP TABLE "mb_genres";--> statement-breakpoint
DROP TABLE "mb_recording_artists";--> statement-breakpoint
DROP TABLE "mb_recordings";--> statement-breakpoint
DROP TABLE "mb_release_groups";--> statement-breakpoint
DROP TABLE "mb_releases";--> statement-breakpoint
DROP TABLE "mb_tags";