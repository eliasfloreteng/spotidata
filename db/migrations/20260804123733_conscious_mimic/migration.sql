CREATE TABLE "canonical_play_stats" (
	"canonical_track_id" text PRIMARY KEY,
	"plays" integer DEFAULT 0 NOT NULL,
	"completed_plays" integer DEFAULT 0 NOT NULL,
	"skips" integer DEFAULT 0 NOT NULL,
	"ms_played" bigint DEFAULT 0 NOT NULL,
	"first_played_at" timestamp with time zone,
	"last_played_at" timestamp with time zone,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "play_imports" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "play_imports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"label" text NOT NULL,
	"path" text NOT NULL,
	"kind" text NOT NULL,
	"size_bytes" bigint,
	"temporary" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"files" integer DEFAULT 0 NOT NULL,
	"files_done" integer DEFAULT 0 NOT NULL,
	"rows_read" bigint DEFAULT 0 NOT NULL,
	"plays_inserted" bigint DEFAULT 0 NOT NULL,
	"duplicates" bigint DEFAULT 0 NOT NULL,
	"first_played_at" timestamp with time zone,
	"last_played_at" timestamp with time zone,
	"error" text,
	"meta" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "play_imports_kind" CHECK ("kind" in ('zip','folder')),
	CONSTRAINT "play_imports_status" CHECK ("status" in ('queued','running','completed','failed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "plays" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "plays_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"played_at" timestamp with time zone NOT NULL,
	"ms_played" integer,
	"item_kind" text DEFAULT 'track' NOT NULL,
	"item_uri" text NOT NULL,
	"track_id" text,
	"resolve_attempted_at" timestamp with time zone,
	"track_name" text,
	"artist_name" text,
	"album_name" text,
	"episode_name" text,
	"show_name" text,
	"platform" text,
	"conn_country" text,
	"reason_start" text,
	"reason_end" text,
	"shuffle" boolean,
	"skipped" boolean,
	"offline" boolean,
	"incognito" boolean,
	"source" text NOT NULL,
	"import_id" bigint,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plays_event_uq" UNIQUE NULLS NOT DISTINCT("played_at","item_uri","ms_played"),
	CONSTRAINT "plays_source" CHECK ("source" in ('extended','recent')),
	CONSTRAINT "plays_item_kind" CHECK ("item_kind" in ('track','episode','audiobook','unknown'))
);
--> statement-breakpoint
CREATE INDEX "tracks_linked_from_ix" ON "spotify_tracks" ("linked_from_id") WHERE "linked_from_id" is not null;--> statement-breakpoint
CREATE INDEX "cps_plays_ix" ON "canonical_play_stats" ("plays" desc);--> statement-breakpoint
CREATE INDEX "cps_ms_ix" ON "canonical_play_stats" ("ms_played" desc);--> statement-breakpoint
CREATE INDEX "cps_last_ix" ON "canonical_play_stats" ("last_played_at" desc);--> statement-breakpoint
CREATE INDEX "play_imports_created_ix" ON "play_imports" ("created_at" desc);--> statement-breakpoint
CREATE INDEX "plays_played_ix" ON "plays" ("played_at" desc);--> statement-breakpoint
CREATE INDEX "plays_track_ix" ON "plays" ("track_id","played_at");--> statement-breakpoint
CREATE INDEX "plays_uri_ix" ON "plays" ("item_uri","played_at");--> statement-breakpoint
CREATE INDEX "plays_unresolved_ix" ON "plays" ("item_uri") WHERE "track_id" is null and "item_kind" = 'track' and "resolve_attempted_at" is null;--> statement-breakpoint
ALTER TABLE "canonical_play_stats" ADD CONSTRAINT "canonical_play_stats_N1WLDfmltURk_fkey" FOREIGN KEY ("canonical_track_id") REFERENCES "canonical_tracks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "plays" ADD CONSTRAINT "plays_track_id_spotify_tracks_id_fkey" FOREIGN KEY ("track_id") REFERENCES "spotify_tracks"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "plays" ADD CONSTRAINT "plays_import_id_play_imports_id_fkey" FOREIGN KEY ("import_id") REFERENCES "play_imports"("id") ON DELETE SET NULL;