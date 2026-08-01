CREATE SCHEMA "graphile_worker";
--> statement-breakpoint
CREATE TABLE "auth_states" (
	"state" text PRIMARY KEY,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" smallint PRIMARY KEY DEFAULT 1,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"token_type" text DEFAULT 'Bearer' NOT NULL,
	"scope" text NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"authorized_at" timestamp with time zone NOT NULL,
	"refresh_expires_at" timestamp with time zone GENERATED ALWAYS AS (((authorized_at AT TIME ZONE 'UTC' + interval '180 days') AT TIME ZONE 'UTC')) STORED,
	"last_refresh_at" timestamp with time zone,
	"last_refresh_error" text,
	"needs_reauth" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_tokens_singleton" CHECK ("id" = 1)
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spotify_users" (
	"id" text PRIMARY KEY,
	"display_name" text,
	"href" text,
	"uri" text,
	"external_urls" jsonb DEFAULT '{}' NOT NULL,
	"followers_total" integer,
	"is_me" boolean DEFAULT false NOT NULL,
	"email" text,
	"country" text,
	"product" text,
	"explicit_filter_enabled" boolean,
	"explicit_filter_locked" boolean,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetched_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "album_artists" (
	"album_id" text,
	"artist_id" text,
	"position" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "album_artists_pkey" PRIMARY KEY("album_id","artist_id")
);
--> statement-breakpoint
CREATE TABLE "album_genres" (
	"album_id" text,
	"genre" text,
	CONSTRAINT "album_genres_pkey" PRIMARY KEY("album_id","genre")
);
--> statement-breakpoint
CREATE TABLE "album_images" (
	"album_id" text,
	"position" smallint,
	"url" text NOT NULL,
	"width" integer,
	"height" integer,
	CONSTRAINT "album_images_pkey" PRIMARY KEY("album_id","position")
);
--> statement-breakpoint
CREATE TABLE "albums" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"album_type" text,
	"release_date" text,
	"release_date_precision" text,
	"release_date_start" date GENERATED ALWAYS AS (spotidata.parse_release_date(release_date)) STORED,
	"total_tracks" integer,
	"label" text,
	"popularity" smallint,
	"upc" text,
	"copyrights" jsonb,
	"available_markets" text[] DEFAULT '{}'::text[] NOT NULL,
	"restrictions" jsonb,
	"href" text,
	"uri" text,
	"external_urls" jsonb DEFAULT '{}' NOT NULL,
	"detail_level" text DEFAULT 'simplified' NOT NULL,
	"tracks_complete" boolean DEFAULT false NOT NULL,
	"tracks_fetched_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetched_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "albums_detail_level" CHECK ("detail_level" in ('simplified','full')),
	CONSTRAINT "albums_type" CHECK ("album_type" is null or "album_type" in ('album','single','compilation'))
);
--> statement-breakpoint
CREATE TABLE "artist_genres" (
	"artist_id" text,
	"genre" text,
	CONSTRAINT "artist_genres_pkey" PRIMARY KEY("artist_id","genre")
);
--> statement-breakpoint
CREATE TABLE "artist_images" (
	"artist_id" text,
	"position" smallint,
	"url" text NOT NULL,
	"width" integer,
	"height" integer,
	CONSTRAINT "artist_images_pkey" PRIMARY KEY("artist_id","position")
);
--> statement-breakpoint
CREATE TABLE "artists" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"popularity" smallint,
	"followers_total" integer,
	"href" text,
	"uri" text,
	"external_urls" jsonb DEFAULT '{}' NOT NULL,
	"detail_level" text DEFAULT 'simplified' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetched_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artists_detail_level" CHECK ("detail_level" in ('simplified','full'))
);
--> statement-breakpoint
CREATE TABLE "canonical_overrides" (
	"track_id" text PRIMARY KEY,
	"canonical_track_id" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canonical_track_artists" (
	"canonical_track_id" text,
	"artist_id" text,
	"position" smallint NOT NULL,
	"on_representative" boolean NOT NULL,
	CONSTRAINT "canonical_track_artists_pkey" PRIMARY KEY("canonical_track_id","artist_id")
);
--> statement-breakpoint
CREATE TABLE "canonical_tracks" (
	"id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"isrc" text UNIQUE,
	"title" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"explicit" boolean DEFAULT false NOT NULL,
	"representative_track_id" text NOT NULL,
	"primary_artist_id" text,
	"primary_album_id" text,
	"max_popularity" smallint,
	"copy_count" integer DEFAULT 1 NOT NULL,
	"earliest_release_date" date,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canonical_tracks_kind" CHECK ("kind" in ('isrc','fallback'))
);
--> statement-breakpoint
CREATE TABLE "genres" (
	"name" text PRIMARY KEY,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spotify_tracks" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"album_id" text,
	"duration_ms" integer NOT NULL,
	"disc_number" smallint DEFAULT 1 NOT NULL,
	"track_number" smallint DEFAULT 0 NOT NULL,
	"explicit" boolean DEFAULT false NOT NULL,
	"popularity" smallint,
	"isrc" text,
	"preview_url" text,
	"is_local" boolean DEFAULT false NOT NULL,
	"is_playable" boolean,
	"linked_from_id" text,
	"restriction_reason" text,
	"available_markets" text[] DEFAULT '{}'::text[] NOT NULL,
	"href" text,
	"uri" text NOT NULL,
	"external_urls" jsonb DEFAULT '{}' NOT NULL,
	"detail_level" text DEFAULT 'simplified' NOT NULL,
	"canonical_track_id" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetched_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spotify_tracks_detail_level" CHECK ("detail_level" in ('simplified','full'))
);
--> statement-breakpoint
CREATE TABLE "track_artists" (
	"track_id" text,
	"artist_id" text,
	"position" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "track_artists_pkey" PRIMARY KEY("track_id","artist_id")
);
--> statement-breakpoint
CREATE TABLE "followed_artists" (
	"artist_id" text PRIMARY KEY,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "library_canonical" (
	"canonical_track_id" text PRIMARY KEY,
	"first_added_at" timestamp with time zone NOT NULL,
	"latest_added_at" timestamp with time zone NOT NULL,
	"liked" boolean NOT NULL,
	"copy_count_in_library" integer NOT NULL,
	"owned_playlist_count" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"primary_artist_id" text,
	"primary_album_id" text,
	"explicit" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_tracks" (
	"track_id" text PRIMARY KEY,
	"via_liked" boolean NOT NULL,
	"via_owned_playlist" boolean NOT NULL,
	"liked_at" timestamp with time zone,
	"first_added_at" timestamp with time zone NOT NULL,
	"owned_playlist_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playlist_images" (
	"playlist_id" text,
	"position" smallint,
	"url" text NOT NULL,
	"width" integer,
	"height" integer,
	CONSTRAINT "playlist_images_pkey" PRIMARY KEY("playlist_id","position")
);
--> statement-breakpoint
CREATE TABLE "playlist_tracks" (
	"playlist_id" text,
	"position" integer,
	"track_id" text,
	"added_at" timestamp with time zone,
	"added_by_id" text,
	"is_local" boolean DEFAULT false NOT NULL,
	"local_name" text,
	"local_artist" text,
	CONSTRAINT "playlist_tracks_pkey" PRIMARY KEY("playlist_id","position")
);
--> statement-breakpoint
CREATE TABLE "playlists" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"description" text,
	"owner_id" text,
	"is_owned" boolean DEFAULT false NOT NULL,
	"collaborative" boolean DEFAULT false NOT NULL,
	"public" boolean,
	"snapshot_id" text NOT NULL,
	"total_tracks" integer,
	"href" text,
	"uri" text,
	"external_urls" jsonb DEFAULT '{}' NOT NULL,
	"items_synced_snapshot_id" text,
	"items_synced_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_albums" (
	"album_id" text PRIMARY KEY,
	"added_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "saved_tracks" (
	"track_id" text PRIMARY KEY,
	"added_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "api_call_stats" (
	"bucket" timestamp with time zone PRIMARY KEY,
	"requests" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"rate_limited" integer DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingest_raw" (
	"entity_type" text,
	"entity_id" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "ingest_raw_pkey" PRIMARY KEY("entity_type","entity_id"),
	CONSTRAINT "ingest_raw_entity_type" CHECK ("entity_type" in ('track','album','artist','playlist','user'))
);
--> statement-breakpoint
CREATE TABLE "rate_limiter" (
	"id" smallint PRIMARY KEY DEFAULT 1,
	"tokens" numeric DEFAULT '20' NOT NULL,
	"capacity" numeric DEFAULT '20' NOT NULL,
	"refill_per_sec" numeric DEFAULT '1' NOT NULL,
	"target_per_sec" numeric DEFAULT '2.5' NOT NULL,
	"last_refill" timestamp with time zone DEFAULT now() NOT NULL,
	"blocked_until" timestamp with time zone,
	"last_429_at" timestamp with time zone,
	"last_429_retry_after_s" integer,
	"consecutive_429" integer DEFAULT 0 NOT NULL,
	"requests_total" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limiter_singleton" CHECK ("id" = 1)
);
--> statement-breakpoint
CREATE TABLE "sync_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sync_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" bigint,
	"phase_key" text,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_events_level" CHECK ("level" in ('debug','info','warn','error'))
);
--> statement-breakpoint
CREATE TABLE "sync_phases" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sync_phases_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" bigint NOT NULL,
	"ordinal" smallint NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"items" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"meta" jsonb DEFAULT '{}' NOT NULL,
	CONSTRAINT "sync_phases_run_key_uq" UNIQUE("run_id","key"),
	CONSTRAINT "sync_phases_status" CHECK ("status" in ('pending','seeding','running','completed','failed','skipped'))
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sync_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"trigger" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"api_requests" integer DEFAULT 0 NOT NULL,
	"stats" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_runs_mode" CHECK ("mode" in ('full','incremental','ondemand','repair')),
	CONSTRAINT "sync_runs_status" CHECK ("status" in ('queued','running','paused_rate_limited','paused_auth','completed','failed','cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "spotify_users_me_uq" ON "spotify_users" ((true)) WHERE "is_me";--> statement-breakpoint
CREATE INDEX "album_artists_artist_ix" ON "album_artists" ("artist_id");--> statement-breakpoint
CREATE INDEX "albums_release_ix" ON "albums" ("release_date_start");--> statement-breakpoint
CREATE INDEX "albums_label_ix" ON "albums" ("label") WHERE "label" is not null;--> statement-breakpoint
CREATE INDEX "albums_incomplete_ix" ON "albums" ("id") WHERE not "tracks_complete";--> statement-breakpoint
CREATE INDEX "albums_name_trgm_ix" ON "albums" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "artist_genres_genre_ix" ON "artist_genres" ("genre");--> statement-breakpoint
CREATE INDEX "artists_needs_hydrate_ix" ON "artists" ("id") WHERE "detail_level" = 'simplified';--> statement-breakpoint
CREATE INDEX "artists_name_trgm_ix" ON "artists" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "cta_artist_ix" ON "canonical_track_artists" ("artist_id");--> statement-breakpoint
CREATE INDEX "canonical_tracks_artist_ix" ON "canonical_tracks" ("primary_artist_id");--> statement-breakpoint
CREATE INDEX "canonical_tracks_title_trgm_ix" ON "canonical_tracks" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tracks_album_order_ix" ON "spotify_tracks" ("album_id","disc_number","track_number");--> statement-breakpoint
CREATE INDEX "tracks_isrc_ix" ON "spotify_tracks" ("isrc") WHERE "isrc" is not null;--> statement-breakpoint
CREATE INDEX "tracks_canonical_ix" ON "spotify_tracks" ("canonical_track_id");--> statement-breakpoint
CREATE INDEX "tracks_needs_hydrate_ix" ON "spotify_tracks" ("id") WHERE "detail_level" = 'simplified' and not "is_local";--> statement-breakpoint
CREATE INDEX "tracks_name_trgm_ix" ON "spotify_tracks" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "track_artists_artist_ix" ON "track_artists" ("artist_id");--> statement-breakpoint
CREATE INDEX "library_canonical_added_ix" ON "library_canonical" ("first_added_at");--> statement-breakpoint
CREATE INDEX "library_canonical_artist_ix" ON "library_canonical" ("primary_artist_id");--> statement-breakpoint
CREATE INDEX "library_canonical_album_ix" ON "library_canonical" ("primary_album_id");--> statement-breakpoint
CREATE INDEX "playlist_tracks_track_ix" ON "playlist_tracks" ("track_id");--> statement-breakpoint
CREATE INDEX "playlist_tracks_added_ix" ON "playlist_tracks" ("added_at");--> statement-breakpoint
CREATE INDEX "playlists_owned_ix" ON "playlists" ("is_owned") WHERE "removed_at" is null;--> statement-breakpoint
CREATE INDEX "saved_tracks_added_ix" ON "saved_tracks" ("added_at") WHERE "removed_at" is null;--> statement-breakpoint
CREATE INDEX "sync_events_run_ix" ON "sync_events" ("run_id","id" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "sync_runs_one_active_ix" ON "sync_runs" ((true)) WHERE "status" in ('queued','running','paused_rate_limited','paused_auth');--> statement-breakpoint
CREATE INDEX "sync_runs_created_ix" ON "sync_runs" ("created_at" desc);--> statement-breakpoint
ALTER TABLE "album_artists" ADD CONSTRAINT "album_artists_album_id_albums_id_fkey" FOREIGN KEY ("album_id") REFERENCES "albums"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "album_artists" ADD CONSTRAINT "album_artists_artist_id_artists_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "album_genres" ADD CONSTRAINT "album_genres_album_id_albums_id_fkey" FOREIGN KEY ("album_id") REFERENCES "albums"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "album_genres" ADD CONSTRAINT "album_genres_genre_genres_name_fkey" FOREIGN KEY ("genre") REFERENCES "genres"("name") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "album_images" ADD CONSTRAINT "album_images_album_id_albums_id_fkey" FOREIGN KEY ("album_id") REFERENCES "albums"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artist_genres" ADD CONSTRAINT "artist_genres_artist_id_artists_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artist_genres" ADD CONSTRAINT "artist_genres_genre_genres_name_fkey" FOREIGN KEY ("genre") REFERENCES "genres"("name") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "artist_images" ADD CONSTRAINT "artist_images_artist_id_artists_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "canonical_track_artists" ADD CONSTRAINT "canonical_track_artists_wA7YHl8ozld2_fkey" FOREIGN KEY ("canonical_track_id") REFERENCES "canonical_tracks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "canonical_track_artists" ADD CONSTRAINT "canonical_track_artists_artist_id_artists_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "canonical_tracks" ADD CONSTRAINT "canonical_tracks_primary_artist_id_artists_id_fkey" FOREIGN KEY ("primary_artist_id") REFERENCES "artists"("id");--> statement-breakpoint
ALTER TABLE "canonical_tracks" ADD CONSTRAINT "canonical_tracks_primary_album_id_albums_id_fkey" FOREIGN KEY ("primary_album_id") REFERENCES "albums"("id");--> statement-breakpoint
ALTER TABLE "spotify_tracks" ADD CONSTRAINT "spotify_tracks_album_id_albums_id_fkey" FOREIGN KEY ("album_id") REFERENCES "albums"("id");--> statement-breakpoint
ALTER TABLE "spotify_tracks" ADD CONSTRAINT "spotify_tracks_canonical_track_id_canonical_tracks_id_fkey" FOREIGN KEY ("canonical_track_id") REFERENCES "canonical_tracks"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "track_artists" ADD CONSTRAINT "track_artists_track_id_spotify_tracks_id_fkey" FOREIGN KEY ("track_id") REFERENCES "spotify_tracks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "track_artists" ADD CONSTRAINT "track_artists_artist_id_artists_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "followed_artists" ADD CONSTRAINT "followed_artists_artist_id_artists_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "library_canonical" ADD CONSTRAINT "library_canonical_canonical_track_id_canonical_tracks_id_fkey" FOREIGN KEY ("canonical_track_id") REFERENCES "canonical_tracks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "library_tracks" ADD CONSTRAINT "library_tracks_track_id_spotify_tracks_id_fkey" FOREIGN KEY ("track_id") REFERENCES "spotify_tracks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "playlist_images" ADD CONSTRAINT "playlist_images_playlist_id_playlists_id_fkey" FOREIGN KEY ("playlist_id") REFERENCES "playlists"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "playlist_tracks" ADD CONSTRAINT "playlist_tracks_playlist_id_playlists_id_fkey" FOREIGN KEY ("playlist_id") REFERENCES "playlists"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "playlist_tracks" ADD CONSTRAINT "playlist_tracks_track_id_spotify_tracks_id_fkey" FOREIGN KEY ("track_id") REFERENCES "spotify_tracks"("id");--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_owner_id_spotify_users_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "spotify_users"("id");--> statement-breakpoint
ALTER TABLE "saved_albums" ADD CONSTRAINT "saved_albums_album_id_albums_id_fkey" FOREIGN KEY ("album_id") REFERENCES "albums"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "saved_tracks" ADD CONSTRAINT "saved_tracks_track_id_spotify_tracks_id_fkey" FOREIGN KEY ("track_id") REFERENCES "spotify_tracks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sync_events" ADD CONSTRAINT "sync_events_run_id_sync_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sync_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sync_phases" ADD CONSTRAINT "sync_phases_run_id_sync_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sync_runs"("id") ON DELETE CASCADE;