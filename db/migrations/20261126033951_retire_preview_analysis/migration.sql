-- Tempo and key come from the real files now (deckhand.recordings, Deckhand's
-- engine), so the analysis of Deezer's 30-second previews is gone, with the
-- Deezer limiter it alone used. Its view and functions live in the
-- `spotidata` schema, which drizzle does not manage, so they are dropped here,
-- once, ahead of the migration that drops the tables. The numbers it measured
-- are deleted, not kept as a fallback: a preview is not the record.
DROP VIEW IF EXISTS spotidata.analyse_candidates;
--> statement-breakpoint
DROP FUNCTION IF EXISTS spotidata.xrl_acquire(text, numeric);
--> statement-breakpoint
DROP FUNCTION IF EXISTS spotidata.xrl_penalize(text, integer);
--> statement-breakpoint
DELETE FROM settings WHERE key = 'analysis.enabled';
--> statement-breakpoint
-- The chain's job, queued under its key; on a fresh database the queue is not
-- installed yet, and there is nothing to remove.
DO $$
BEGIN
  IF to_regproc('graphile_worker.remove_job') IS NOT NULL THEN
    PERFORM graphile_worker.remove_job('analyse-tick');
  END IF;
END $$;
