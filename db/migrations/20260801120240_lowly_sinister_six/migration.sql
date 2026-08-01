CREATE TABLE "album_groups" (
	"id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"representative_album_id" text NOT NULL,
	"primary_artist_id" text,
	"track_count" integer DEFAULT 0 NOT NULL,
	"copy_count" integer DEFAULT 1 NOT NULL,
	"earliest_release_date" date,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "album_groups_kind" CHECK ("kind" in ('tracks','solo'))
);
--> statement-breakpoint
ALTER TABLE "albums" ADD COLUMN "album_group_id" text;--> statement-breakpoint
CREATE INDEX "album_groups_artist_ix" ON "album_groups" ("primary_artist_id");--> statement-breakpoint
CREATE INDEX "album_groups_dupes_ix" ON "album_groups" ("id") WHERE "copy_count" > 1;--> statement-breakpoint
CREATE INDEX "albums_group_ix" ON "albums" ("album_group_id");--> statement-breakpoint
ALTER TABLE "album_groups" ADD CONSTRAINT "album_groups_primary_artist_id_artists_id_fkey" FOREIGN KEY ("primary_artist_id") REFERENCES "artists"("id");--> statement-breakpoint
ALTER TABLE "albums" ADD CONSTRAINT "albums_album_group_id_album_groups_id_fkey" FOREIGN KEY ("album_group_id") REFERENCES "album_groups"("id") ON DELETE SET NULL;