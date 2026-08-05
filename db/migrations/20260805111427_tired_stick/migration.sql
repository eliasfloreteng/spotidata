CREATE TABLE "album_musicbrainz" (
	"album_id" text PRIMARY KEY,
	"release_mbid" text,
	"status" text NOT NULL,
	"source" text,
	"looked_up_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "album_musicbrainz_status" CHECK ("status" in ('matched','not_found')),
	CONSTRAINT "album_musicbrainz_source" CHECK ("source" is null or "source" in ('url','barcode'))
);
--> statement-breakpoint
CREATE TABLE "artist_musicbrainz" (
	"artist_id" text PRIMARY KEY,
	"mbid" text,
	"status" text NOT NULL,
	"source" text,
	"looked_up_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artist_musicbrainz_status" CHECK ("status" in ('matched','not_found')),
	CONSTRAINT "artist_musicbrainz_source" CHECK ("source" is null or "source" in ('url','credit'))
);
--> statement-breakpoint
CREATE TABLE "audio_features" (
	"recording_mbid" text PRIMARY KEY,
	"status" text NOT NULL,
	"bpm" real,
	"beats_count" integer,
	"onset_rate" real,
	"danceability_raw" real,
	"key_key" text,
	"key_scale" text,
	"key_strength" real,
	"chords_key" text,
	"chords_scale" text,
	"chords_changes_rate" real,
	"tuning_frequency" real,
	"average_loudness" real,
	"replay_gain" real,
	"length_seconds" real,
	"dynamic_complexity" real,
	"spectral_centroid" real,
	"danceable" real,
	"aggressive" real,
	"electronic" real,
	"acoustic" real,
	"happy" real,
	"sad" real,
	"party" real,
	"relaxed" real,
	"bright" real,
	"tonal" real,
	"instrumental" real,
	"female" real,
	"mood_mirex" text,
	"genre_dortmund" text,
	"genre_electronic" text,
	"genre_rosamerica" text,
	"genre_tzanetakis" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audio_features_status" CHECK ("status" in ('ok','missing'))
);
--> statement-breakpoint
CREATE TABLE "enrich_stages" (
	"key" text PRIMARY KEY,
	"status" text DEFAULT 'idle' NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"missed" integer DEFAULT 0 NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_run_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrich_stages_status" CHECK ("status" in ('idle','running','complete','error','blocked'))
);
--> statement-breakpoint
CREATE TABLE "external_limiters" (
	"service" text PRIMARY KEY,
	"tokens" real DEFAULT 1 NOT NULL,
	"capacity" real DEFAULT 1 NOT NULL,
	"refill_per_sec" real DEFAULT 1 NOT NULL,
	"last_refill" timestamp with time zone DEFAULT now() NOT NULL,
	"blocked_until" timestamp with time zone,
	"requests_total" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_tokens" (
	"service" text PRIMARY KEY,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"token_type" text DEFAULT 'Bearer' NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"access_expires_at" timestamp with time zone,
	"authorized_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refresh_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "isrc_recordings" (
	"isrc" text PRIMARY KEY,
	"recording_mbid" text,
	"status" text NOT NULL,
	"candidates" smallint DEFAULT 0 NOT NULL,
	"looked_up_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "isrc_recordings_status" CHECK ("status" in ('matched','not_found'))
);
--> statement-breakpoint
CREATE TABLE "mb_artists" (
	"mbid" text PRIMARY KEY,
	"name" text NOT NULL,
	"sort_name" text,
	"type" text,
	"gender" text,
	"country" text,
	"area_name" text,
	"begin_area_name" text,
	"begin_date" text,
	"end_date" text,
	"ended" boolean DEFAULT false NOT NULL,
	"disambiguation" text,
	"rating_value" real,
	"rating_votes" integer,
	"isnis" text[] DEFAULT '{}'::text[] NOT NULL,
	"detail_level" text DEFAULT 'stub' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mb_artists_detail_level" CHECK ("detail_level" in ('stub','full'))
);
--> statement-breakpoint
CREATE TABLE "mb_genres" (
	"name" text PRIMARY KEY,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mb_recording_artists" (
	"recording_mbid" text,
	"position" smallint,
	"artist_mbid" text NOT NULL,
	"credit_name" text NOT NULL,
	"join_phrase" text,
	CONSTRAINT "mb_recording_artists_pkey" PRIMARY KEY("recording_mbid","position")
);
--> statement-breakpoint
CREATE TABLE "mb_recordings" (
	"mbid" text PRIMARY KEY,
	"title" text NOT NULL,
	"length_ms" integer,
	"first_release_date" text,
	"first_release_date_start" date GENERATED ALWAYS AS (spotidata.parse_release_date(first_release_date)) STORED,
	"disambiguation" text,
	"video" boolean DEFAULT false NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mb_release_groups" (
	"mbid" text PRIMARY KEY,
	"title" text NOT NULL,
	"primary_type" text,
	"secondary_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"first_release_date" text,
	"disambiguation" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mb_releases" (
	"mbid" text PRIMARY KEY,
	"title" text NOT NULL,
	"status" text,
	"date" text,
	"country" text,
	"barcode" text,
	"packaging" text,
	"language" text,
	"script" text,
	"label_name" text,
	"catalog_number" text,
	"release_group_mbid" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mb_tags" (
	"entity_type" text,
	"entity_mbid" text,
	"tag" text,
	"count" integer DEFAULT 0 NOT NULL,
	"is_genre" boolean DEFAULT false NOT NULL,
	CONSTRAINT "mb_tags_pkey" PRIMARY KEY("entity_type","entity_mbid","tag"),
	CONSTRAINT "mb_tags_entity_type" CHECK ("entity_type" in ('recording','artist','release','release_group'))
);
--> statement-breakpoint
CREATE INDEX "album_musicbrainz_release_ix" ON "album_musicbrainz" ("release_mbid");--> statement-breakpoint
CREATE INDEX "artist_musicbrainz_mbid_ix" ON "artist_musicbrainz" ("mbid");--> statement-breakpoint
CREATE INDEX "audio_features_bpm_ix" ON "audio_features" ("bpm") WHERE "bpm" is not null;--> statement-breakpoint
CREATE INDEX "audio_features_key_ix" ON "audio_features" ("key_key","key_scale");--> statement-breakpoint
CREATE INDEX "isrc_recordings_mbid_ix" ON "isrc_recordings" ("recording_mbid");--> statement-breakpoint
CREATE INDEX "mb_artists_needs_detail_ix" ON "mb_artists" ("mbid") WHERE "detail_level" = 'stub';--> statement-breakpoint
CREATE INDEX "mb_recording_artists_artist_ix" ON "mb_recording_artists" ("artist_mbid");--> statement-breakpoint
CREATE INDEX "mb_recordings_release_ix" ON "mb_recordings" ("first_release_date_start");--> statement-breakpoint
CREATE INDEX "mb_releases_group_ix" ON "mb_releases" ("release_group_mbid");--> statement-breakpoint
CREATE INDEX "mb_releases_barcode_ix" ON "mb_releases" ("barcode") WHERE "barcode" is not null;--> statement-breakpoint
CREATE INDEX "mb_tags_tag_ix" ON "mb_tags" ("tag");--> statement-breakpoint
CREATE INDEX "mb_tags_genre_ix" ON "mb_tags" ("entity_type","tag") WHERE "is_genre";--> statement-breakpoint
ALTER TABLE "album_musicbrainz" ADD CONSTRAINT "album_musicbrainz_album_id_albums_id_fkey" FOREIGN KEY ("album_id") REFERENCES "albums"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "album_musicbrainz" ADD CONSTRAINT "album_musicbrainz_release_mbid_mb_releases_mbid_fkey" FOREIGN KEY ("release_mbid") REFERENCES "mb_releases"("mbid") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "artist_musicbrainz" ADD CONSTRAINT "artist_musicbrainz_artist_id_artists_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artist_musicbrainz" ADD CONSTRAINT "artist_musicbrainz_mbid_mb_artists_mbid_fkey" FOREIGN KEY ("mbid") REFERENCES "mb_artists"("mbid") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "audio_features" ADD CONSTRAINT "audio_features_recording_mbid_mb_recordings_mbid_fkey" FOREIGN KEY ("recording_mbid") REFERENCES "mb_recordings"("mbid") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "isrc_recordings" ADD CONSTRAINT "isrc_recordings_recording_mbid_mb_recordings_mbid_fkey" FOREIGN KEY ("recording_mbid") REFERENCES "mb_recordings"("mbid") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "mb_recording_artists" ADD CONSTRAINT "mb_recording_artists_recording_mbid_mb_recordings_mbid_fkey" FOREIGN KEY ("recording_mbid") REFERENCES "mb_recordings"("mbid") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mb_releases" ADD CONSTRAINT "mb_releases_release_group_mbid_mb_release_groups_mbid_fkey" FOREIGN KEY ("release_group_mbid") REFERENCES "mb_release_groups"("mbid") ON DELETE SET NULL;