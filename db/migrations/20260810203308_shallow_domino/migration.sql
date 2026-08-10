CREATE TABLE "automation_added_tracks" (
	"automation_id" text,
	"track_id" text,
	"canonical_track_id" text,
	"source_playlist_id" text,
	"origin" text DEFAULT 'added' NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_added_tracks_pkey" PRIMARY KEY("automation_id","track_id"),
	CONSTRAINT "automation_added_origin" CHECK ("origin" in ('added','seeded'))
);
--> statement-breakpoint
CREATE TABLE "automation_sources" (
	"automation_id" text,
	"playlist_id" text,
	"label" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_sources_pkey" PRIMARY KEY("automation_id","playlist_id")
);
--> statement-breakpoint
CREATE TABLE "playlist_automations" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"description" text,
	"spotify_playlist_id" text,
	"playlist_public" boolean DEFAULT false NOT NULL,
	"auto_run" boolean DEFAULT true NOT NULL,
	"backfill" boolean DEFAULT true NOT NULL,
	"added_track_count" integer DEFAULT 0 NOT NULL,
	"last_added_count" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_run_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "automation_added_canonical_ix" ON "automation_added_tracks" ("automation_id","canonical_track_id");--> statement-breakpoint
CREATE INDEX "automation_sources_playlist_ix" ON "automation_sources" ("playlist_id");--> statement-breakpoint
CREATE INDEX "playlist_automations_autorun_ix" ON "playlist_automations" ("auto_run") WHERE "auto_run";--> statement-breakpoint
ALTER TABLE "automation_added_tracks" ADD CONSTRAINT "automation_added_tracks_Tv8JPaaKOW4H_fkey" FOREIGN KEY ("automation_id") REFERENCES "playlist_automations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "automation_sources" ADD CONSTRAINT "automation_sources_automation_id_playlist_automations_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "playlist_automations"("id") ON DELETE CASCADE;