//! How each mirror of each source has been doing, and the order the next
//! download tries them in.
//!
//! The sources are free proxies that come and go and whose speed swings by
//! the hour, so nothing is ranked by hand: every lookup, download and
//! background probe updates a running average of whether the mirror
//! answered, how fast it answered and how fast it sent the file. A mirror
//! that keeps failing rests for a while (doubling each time, up to an hour)
//! and is tried only after the rest.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use deckhand_model::downloads::SourceHealth;
use serde::{Deserialize, Serialize};

use crate::store::{at_ms, ms, now_ms, to_i64, to_u64, Store};

/// The columns of `endpoints` but its id, as a `Record` reads and `save` writes them.
macro_rules! columns {
    () => {
        "reliability, speed_kbps, latency_ms, downloads, failures_in_row, resting_until, last_error, last_ok, last_probe"
    };
}

/// Weight of the newest observation in the running averages.
const ALPHA: f64 = 0.3;
/// A typical track, for turning speed into time.
const TYPICAL_BYTES: f64 = 35_000_000.0;
/// What an untried mirror is assumed to manage: hopeful, so it gets a turn.
const PRIOR_RELIABILITY: f64 = 0.8;
const PRIOR_SPEED_KBPS: f64 = 1_500.0;
const PRIOR_LATENCY_MS: f64 = 1_500.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Health {
    pub reliability: f64,
    pub speed_kbps: Option<f64>,
    pub latency_ms: f64,
    pub downloads: u64,
    pub failures_in_row: u32,
    pub resting_until_ms: Option<i64>,
    pub last_error: Option<String>,
    pub last_ok_ms: Option<i64>,
    #[serde(default)]
    pub last_probe_ms: Option<i64>,
}

impl Default for Health {
    fn default() -> Self {
        Self {
            reliability: PRIOR_RELIABILITY,
            speed_kbps: None,
            latency_ms: PRIOR_LATENCY_MS,
            downloads: 0,
            failures_in_row: 0,
            resting_until_ms: None,
            last_error: None,
            last_ok_ms: None,
            last_probe_ms: None,
        }
    }
}

impl Health {
    fn ewma(old: f64, new: f64) -> f64 {
        old.mul_add(1.0 - ALPHA, new * ALPHA)
    }

    fn ok(&mut self) {
        self.reliability = Self::ewma(self.reliability, 1.0);
        self.failures_in_row = 0;
        self.resting_until_ms = None;
        self.last_ok_ms = Some(now_ms());
    }

    fn fail(&mut self, error: &str, weight: f64) {
        // The running average towards 0, harder for worse failures.
        self.reliability *= 1.0 - ALPHA * weight;
        self.failures_in_row += 1;
        self.last_error = Some(error.chars().take(200).collect());
        // One failure can be a blip, unless it never worked; from the second
        // on (or the first, for a mirror never seen working), rest 1, 2, 4… min.
        if self.failures_in_row >= 2 || self.last_ok_ms.is_none() {
            let minutes = 1i64 << self.failures_in_row.saturating_sub(2).min(6);
            self.resting_until_ms = Some(now_ms() + minutes.min(60) * 60_000);
        }
    }

    pub fn is_resting(&self, now: i64) -> bool {
        self.resting_until_ms.is_some_and(|until| until > now)
    }

    /// Expected seconds to get a typical track from here; lower is better.
    pub fn cost(&self, now: i64) -> f64 {
        let speed = self.speed_kbps.unwrap_or(PRIOR_SPEED_KBPS).max(10.0);
        let seconds = self.latency_ms / 1000.0 + TYPICAL_BYTES / 1000.0 / speed;
        let reliability = self.reliability.clamp(0.02, 1.0);
        let resting = if self.is_resting(now) { 100_000.0 } else { 0.0 };
        seconds / (reliability * reliability) + resting
    }
}

/// What happened when a mirror was used.
#[derive(Debug, Clone)]
pub enum Event {
    /// It answered a lookup, found or not.
    Answered { latency_ms: f64 },
    /// It sent the file.
    Downloaded { bytes: u64, secs: f64 },
    /// It started sending but too slowly to wait for.
    Slow { kbps: f64, error: String },
    /// Down, refused, timed out, or answered nonsense.
    Failed { error: String },
    /// It sent something that is not the track.
    BadFile { error: String },
    /// It asked to be left alone for a while.
    RateLimited { secs: u64 },
}

#[derive(Clone)]
pub struct Registry {
    store: Store,
    map: Arc<Mutex<HashMap<String, Health>>>,
}

impl Registry {
    pub async fn load(store: Store) -> anyhow::Result<Self> {
        let rows: Vec<Record> =
            sqlx::query_as(concat!("select id, ", columns!(), " from endpoints")).fetch_all(store.pool()).await?;
        let map = rows.into_iter().map(|r| (r.id.clone(), Health::from(r))).collect();
        Ok(Self { store, map: Arc::new(Mutex::new(map)) })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Health>> {
        self.map.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn get(&self, id: &str) -> Health {
        self.lock().get(id).cloned().unwrap_or_default()
    }

    pub async fn record(&self, id: &str, event: Event) {
        let health = {
            let mut map = self.lock();
            let health = map.entry(id.to_owned()).or_default();
            match event {
                Event::Answered { latency_ms } => {
                    health.latency_ms = Health::ewma(health.latency_ms, latency_ms);
                    health.ok();
                }
                Event::Downloaded { bytes, secs } => {
                    #[allow(clippy::cast_precision_loss)]
                    let kbps = bytes as f64 / 1000.0 / secs.max(0.1);
                    health.speed_kbps = Some(health.speed_kbps.map_or(kbps, |old| Health::ewma(old, kbps)));
                    health.downloads += 1;
                    health.ok();
                }
                Event::Slow { kbps, error } => {
                    health.speed_kbps = Some(health.speed_kbps.map_or(kbps, |old| Health::ewma(old, kbps)));
                    health.fail(&error, 0.5);
                }
                Event::Failed { error } => health.fail(&error, 1.0),
                Event::BadFile { error } => health.fail(&error, 1.5),
                Event::RateLimited { secs } => {
                    health.fail("rate limited", 0.3);
                    let until = now_ms() + i64::try_from(secs).unwrap_or(3600) * 1000;
                    health.resting_until_ms = Some(health.resting_until_ms.map_or(until, |t| t.max(until)));
                }
            }
            health.clone()
        };
        self.save(id, &health).await;
    }

    pub async fn probed(&self, id: &str) {
        let health = {
            let mut map = self.lock();
            let health = map.entry(id.to_owned()).or_default();
            health.last_probe_ms = Some(now_ms());
            health.clone()
        };
        self.save(id, &health).await;
    }

    async fn save(&self, id: &str, health: &Health) {
        if let Err(e) = save(self.store.pool(), id, health).await {
            tracing::warn!(error = %e, "could not save a source's health");
        }
    }

    /// `ids` cheapest first.
    pub fn rank(&self, ids: &mut [String]) {
        let now = now_ms();
        let map = self.lock();
        let cost = |id: &String| map.get(id).cloned().unwrap_or_default().cost(now);
        ids.sort_by(|a, b| cost(a).total_cmp(&cost(b)));
    }

    /// Every endpoint, in the order the next download would try them.
    pub fn report(&self, mut ids: Vec<String>) -> Vec<SourceHealth> {
        self.rank(&mut ids);
        let now = now_ms();
        ids.into_iter()
            .enumerate()
            .map(|(i, id)| {
                let h = self.get(&id);
                let (source, host) =
                    id.split_once(':').map_or((id.clone(), String::new()), |(s, h)| (s.to_owned(), h.to_owned()));
                SourceHealth {
                    id,
                    source,
                    host,
                    rank: i + 1,
                    reliability: h.reliability,
                    speed_kbps: h.speed_kbps,
                    latency_ms: h.latency_ms,
                    downloads: h.downloads,
                    resting_until_ms: h.resting_until_ms.filter(|&until| until > now),
                    last_error: h.last_error,
                    last_ok_ms: h.last_ok_ms,
                }
            })
            .collect()
    }
}

/// A row of `endpoints` as stored.
#[derive(sqlx::FromRow)]
pub struct Record {
    pub id: String,
    pub reliability: f64,
    pub speed_kbps: Option<f64>,
    pub latency_ms: f64,
    pub downloads: i64,
    pub failures_in_row: i32,
    pub resting_until: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub last_ok: Option<DateTime<Utc>>,
    pub last_probe: Option<DateTime<Utc>>,
}

impl From<Record> for Health {
    fn from(r: Record) -> Self {
        Self {
            reliability: r.reliability,
            speed_kbps: r.speed_kbps,
            latency_ms: r.latency_ms,
            downloads: to_u64(r.downloads),
            failures_in_row: u32::try_from(r.failures_in_row).unwrap_or(0),
            resting_until_ms: r.resting_until.map(ms),
            last_error: r.last_error,
            last_ok_ms: r.last_ok.map(ms),
            last_probe_ms: r.last_probe.map(ms),
        }
    }
}

/// Writes a mirror's health; with `executor` the import's transaction.
pub async fn save<'e, E: sqlx::PgExecutor<'e>>(executor: E, id: &str, health: &Health) -> sqlx::Result<()> {
    sqlx::query(concat!(
        "insert into endpoints(id, ",
        columns!(),
        ") values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict(id) do update set reliability = $2, speed_kbps = $3, latency_ms = $4, downloads = $5,
             failures_in_row = $6, resting_until = $7, last_error = $8, last_ok = $9, last_probe = $10"
    ))
    .bind(id)
    .bind(health.reliability)
    .bind(health.speed_kbps)
    .bind(health.latency_ms)
    .bind(to_i64(health.downloads))
    .bind(i32::try_from(health.failures_in_row).unwrap_or(i32::MAX))
    .bind(health.resting_until_ms.map(at_ms))
    .bind(&health.last_error)
    .bind(health.last_ok_ms.map(at_ms))
    .bind(health.last_probe_ms.map(at_ms))
    .execute(executor)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[sqlx::test(migrations = false)]
    async fn failing_mirrors_rest_and_sink(
        _: sqlx::postgres::PgPoolOptions,
        options: sqlx::postgres::PgConnectOptions,
    ) {
        let store = crate::store::tests::store(options).await;
        let reg = Registry::load(store.clone()).await.unwrap();
        reg.record("a:x", Event::Downloaded { bytes: 30_000_000, secs: 30.0 }).await;
        reg.record("b:y", Event::Downloaded { bytes: 30_000_000, secs: 10.0 }).await;
        let mut ids = vec!["a:x".to_owned(), "b:y".to_owned(), "c:z".to_owned()];
        reg.rank(&mut ids);
        assert_eq!(ids[0], "b:y", "the fastest goes first");
        reg.record("b:y", Event::Failed { error: "502".into() }).await;
        reg.record("b:y", Event::Failed { error: "502".into() }).await;
        assert!(reg.get("b:y").is_resting(now_ms()));
        reg.rank(&mut ids);
        assert_eq!(ids[2], "b:y", "a resting mirror goes last");
        reg.record("b:y", Event::Answered { latency_ms: 300.0 }).await;
        assert!(!reg.get("b:y").is_resting(now_ms()), "an answer ends the rest");
        // Kept across a restart.
        let again = Registry::load(store).await.unwrap();
        let (was, now) = (reg.get("b:y"), again.get("b:y"));
        assert_eq!((was.reliability, was.downloads, was.last_ok_ms), (now.reliability, now.downloads, now.last_ok_ms));
    }
}
