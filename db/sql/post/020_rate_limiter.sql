-- Token bucket + circuit breaker, held in Postgres so that a multi-hour
-- Retry-After survives a process restart and is shared by every worker.

INSERT INTO rate_limiter (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Returns granted=false with a wait hint rather than sleeping, so the caller
-- decides whether to wait or hand the job back to the queue.
CREATE OR REPLACE FUNCTION spotidata.rl_acquire(p_cost numeric DEFAULT 1)
RETURNS TABLE (granted boolean, wait_ms integer, blocked_until timestamptz)
LANGUAGE plpgsql AS $$
DECLARE
  r rate_limiter;
  now_ts timestamptz := clock_timestamp();
  refilled numeric;
BEGIN
  -- FOR UPDATE serializes concurrent callers; the row is tiny and the lock is
  -- held for microseconds.
  SELECT * INTO r FROM rate_limiter WHERE id = 1 FOR UPDATE;

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
    UPDATE rate_limiter
       SET tokens = refilled - p_cost,
           last_refill = now_ts,
           requests_total = requests_total + 1,
           updated_at = now_ts
     WHERE id = 1;
    RETURN QUERY SELECT true, 0, NULL::timestamptz;
  ELSE
    UPDATE rate_limiter SET tokens = refilled, last_refill = now_ts WHERE id = 1;
    RETURN QUERY SELECT false,
      (((p_cost - refilled) / r.refill_per_sec) * 1000)::int,
      NULL::timestamptz;
  END IF;
END $$;

-- Multiplicative decrease on 429. Halving the refill rate (rather than only
-- honouring Retry-After) is what stops a second, longer ban.
CREATE OR REPLACE FUNCTION spotidata.rl_penalize(p_retry_after_s integer)
RETURNS timestamptz LANGUAGE sql AS $$
  UPDATE rate_limiter SET
    blocked_until = clock_timestamp() + make_interval(secs => greatest(p_retry_after_s, 5)),
    tokens = 0,
    refill_per_sec = greatest(0.5, refill_per_sec * 0.5),
    last_429_at = clock_timestamp(),
    last_429_retry_after_s = p_retry_after_s,
    consecutive_429 = consecutive_429 + 1,
    updated_at = clock_timestamp()
  WHERE id = 1
  RETURNING blocked_until;
$$;

-- Additive increase, called once a minute by maintenance:rate-recover.
CREATE OR REPLACE FUNCTION spotidata.rl_recover()
RETURNS numeric LANGUAGE sql AS $$
  UPDATE rate_limiter SET
    refill_per_sec = least(target_per_sec, refill_per_sec * 1.25),
    consecutive_429 = CASE
      WHEN last_429_at IS NULL OR last_429_at < now() - interval '30 minutes'
      THEN 0 ELSE consecutive_429 END,
    updated_at = clock_timestamp()
  WHERE id = 1
    AND (blocked_until IS NULL OR blocked_until < now() - interval '5 minutes')
    AND (last_429_at IS NULL OR last_429_at < now() - interval '10 minutes')
    AND refill_per_sec < target_per_sec
  RETURNING refill_per_sec;
$$;

-- Per-minute counters for the sync page sparkline and the live ETA.
CREATE OR REPLACE FUNCTION spotidata.rl_record(
  p_requests int, p_errors int, p_rate_limited int, p_bytes bigint
) RETURNS void LANGUAGE sql AS $$
  INSERT INTO api_call_stats (bucket, requests, errors, rate_limited, bytes)
  VALUES (date_trunc('minute', now()), p_requests, p_errors, p_rate_limited, p_bytes)
  ON CONFLICT (bucket) DO UPDATE SET
    requests     = api_call_stats.requests + excluded.requests,
    errors       = api_call_stats.errors + excluded.errors,
    rate_limited = api_call_stats.rate_limited + excluded.rate_limited,
    bytes        = api_call_stats.bytes + excluded.bytes;
$$;
