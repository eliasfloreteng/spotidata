CREATE TABLE "track_analysis" (
	"isrc" text PRIMARY KEY,
	"status" text NOT NULL,
	"deezer_track_id" bigint,
	"matched_by" text,
	"bpm" real,
	"bpm_confidence" real,
	"key_name" text,
	"camelot" text,
	"seconds" real,
	"rms" real,
	"analyser" text NOT NULL,
	"error" text,
	"analysed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "track_analysis_status" CHECK ("status" in ('ok','missing','failed')),
	CONSTRAINT "track_analysis_matched_by" CHECK ("matched_by" in ('isrc','search'))
);
--> statement-breakpoint
CREATE INDEX "track_analysis_status_ix" ON "track_analysis" ("status");