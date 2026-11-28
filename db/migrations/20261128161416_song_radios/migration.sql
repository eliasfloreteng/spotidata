CREATE TABLE "song_radio_tracks" (
	"seed_track_id" text,
	"position" smallint,
	"track_id" text NOT NULL,
	"isrc" text,
	"title" text NOT NULL,
	"artist_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "song_radio_tracks_pkey" PRIMARY KEY("seed_track_id","position")
);
--> statement-breakpoint
CREATE TABLE "song_radios" (
	"seed_track_id" text PRIMARY KEY,
	"playlist_id" text,
	"name" text,
	"description" text,
	"image" text,
	"track_count" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "song_radio_tracks_track_ix" ON "song_radio_tracks" ("track_id");--> statement-breakpoint
CREATE INDEX "song_radio_tracks_isrc_ix" ON "song_radio_tracks" ("isrc") WHERE "isrc" is not null;--> statement-breakpoint
CREATE INDEX "song_radios_fetched_ix" ON "song_radios" ("fetched_at");--> statement-breakpoint
ALTER TABLE "song_radio_tracks" ADD CONSTRAINT "song_radio_tracks_seed_track_id_song_radios_seed_track_id_fkey" FOREIGN KEY ("seed_track_id") REFERENCES "song_radios"("seed_track_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "song_radios" ADD CONSTRAINT "song_radios_seed_track_id_spotify_tracks_id_fkey" FOREIGN KEY ("seed_track_id") REFERENCES "spotify_tracks"("id") ON DELETE CASCADE;