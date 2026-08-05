-- Token bucket per external service, held in Postgres for the same reason the
-- Spotify one is (db/sql/post/020): a penalty measured in minutes must survive
-- a process restart and must be shared by the SvelteKit and worker processes.
--
-- Kept separate from `rate_limiter` rather than generalising it: that table is
-- a singleton with a Spotify-specific AIMD controller and a `forbiddenFlags`
-- hook wired to its `blocked_until`. These services need neither — they need a
-- hard, unnegotiable pace (MusicBrainz: one request per second, no exceptions)
-- and a place to park a 503 backoff.

INSERT INTO external_limiters (service, tokens, capacity, refill_per_sec) VALUES
  -- MusicBrainz publishes 1 req/s for anonymous clients and blocks IPs that
  -- exceed it. capacity = 1 means no burst is even possible.
  ('musicbrainz', 1, 1, 1),
  -- AcousticBrainz asks only that clients be reasonable; 2/s with a small
  -- burst, and each request carries 25 recordings.
  ('acousticbrainz', 4, 4, 2)
ON CONFLICT (service) DO NOTHING;

-- Returns granted=false with a wait hint rather than sleeping, so the caller
-- decides between waiting inline and handing the job back to the queue.
CREATE OR REPLACE FUNCTION spotidata.xrl_acquire(p_service text, p_cost numeric DEFAULT 1)
RETURNS TABLE (granted boolean, wait_ms integer, blocked_until timestamptz)
LANGUAGE plpgsql AS $$
DECLARE
  r external_limiters;
  now_ts timestamptz := clock_timestamp();
  refilled numeric;
BEGIN
  SELECT * INTO r FROM external_limiters WHERE service = p_service FOR UPDATE;

  -- An unknown service is a programming error, not a reason to hammer someone
  -- else's server: fail closed with a one-second wait.
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 1000, NULL::timestamptz;
    RETURN;
  END IF;

  IF r.blocked_until IS NOT NULL AND r.blocked_until > now_ts THEN
    RETURN QUERY SELECT false,
      (extract(epoch FROM r.blocked_until - now_ts) * 1000)::int,
      r.blocked_until;
    RETURN;
  END IF;

  refilled := least(
    r.capacity,
    r.tokens + extract(epoch FROM now_ts - r.last_refill) * r.refill_per_sec
  );

  IF refilled >= p_cost THEN
    UPDATE external_limiters
       SET tokens = refilled - p_cost,
           last_refill = now_ts,
           requests_total = requests_total + 1,
           updated_at = now_ts
     WHERE service = p_service;
    RETURN QUERY SELECT true, 0, NULL::timestamptz;
  ELSE
    UPDATE external_limiters
       SET tokens = refilled, last_refill = now_ts
     WHERE service = p_service;
    RETURN QUERY SELECT false,
      (((p_cost - refilled) / r.refill_per_sec) * 1000)::int,
      NULL::timestamptz;
  END IF;
END $$;

-- Opens the breaker for everyone until `p_seconds` have passed. MusicBrainz
-- answers overload with 503 and a Retry-After, and the only correct response
-- is to stop entirely — slowing down still costs them a request.
CREATE OR REPLACE FUNCTION spotidata.xrl_penalize(p_service text, p_seconds integer)
RETURNS timestamptz LANGUAGE sql AS $$
  UPDATE external_limiters SET
    blocked_until = clock_timestamp() + make_interval(secs => greatest(p_seconds, 1)),
    tokens = 0,
    updated_at = clock_timestamp()
  WHERE service = p_service
  RETURNING blocked_until;
$$;
