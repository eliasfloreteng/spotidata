CREATE TABLE "sortify_ai_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sortify_ai_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"items" integer NOT NULL,
	"cost_usd" double precision,
	"duration_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sortify_ai_requests_kind" CHECK ("kind" in ('card','songs','playlist','ideas'))
);
--> statement-breakpoint
CREATE TABLE "sortify_asked_songs" (
	"song_key" text PRIMARY KEY,
	"idea" text,
	"model" text NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sortify_card_suggestions" (
	"track_id" text PRIMARY KEY,
	"playlist_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"ideas" text[] DEFAULT '{}'::text[] NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sortify_dismissals" (
	"song_key" text,
	"playlist_id" text,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sortify_dismissals_pkey" PRIMARY KEY("song_key","playlist_id")
);
--> statement-breakpoint
CREATE TABLE "sortify_ideas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"song_keys" text[] NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sortify_playlist_overrides" (
	"playlist_id" text PRIMARY KEY,
	"eligible" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sortify_reviewed_songs" (
	"song_key" text PRIMARY KEY,
	"track_id" text,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sortify_verdicts" (
	"song_key" text,
	"playlist_id" text,
	"confidence" smallint,
	"why" text,
	"via" text NOT NULL,
	"model" text NOT NULL,
	"judged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sortify_verdicts_pkey" PRIMARY KEY("song_key","playlist_id"),
	CONSTRAINT "sortify_verdicts_via" CHECK ("via" in ('songs','playlist')),
	CONSTRAINT "sortify_verdicts_confidence" CHECK ("confidence" is null or "confidence" between 1 and 3)
);
--> statement-breakpoint
CREATE INDEX "sortify_verdicts_playlist_ix" ON "sortify_verdicts" ("playlist_id");