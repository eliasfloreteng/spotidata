CREATE TABLE "genre_collection_genres" (
	"collection_id" text,
	"genre" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "genre_collection_genres_pkey" PRIMARY KEY("collection_id","genre")
);
--> statement-breakpoint
CREATE TABLE "genre_collections" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"description" text,
	"match" text DEFAULT 'any' NOT NULL,
	"sort" text DEFAULT 'added' NOT NULL,
	"track_limit" integer DEFAULT 500 NOT NULL,
	"spotify_playlist_id" text,
	"playlist_public" boolean DEFAULT false NOT NULL,
	"auto_sync" boolean DEFAULT true NOT NULL,
	"synced_fingerprint" text,
	"synced_snapshot_id" text,
	"synced_track_count" integer DEFAULT 0 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "genre_collections_match" CHECK ("match" in ('any','all')),
	CONSTRAINT "genre_collections_limit" CHECK ("track_limit" between 1 and 10000)
);
--> statement-breakpoint
CREATE INDEX "gcg_genre_ix" ON "genre_collection_genres" ("genre");--> statement-breakpoint
CREATE INDEX "genre_collections_autosync_ix" ON "genre_collections" ("auto_sync") WHERE "auto_sync";--> statement-breakpoint
ALTER TABLE "genre_collection_genres" ADD CONSTRAINT "genre_collection_genres_collection_id_genre_collections_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "genre_collections"("id") ON DELETE CASCADE;