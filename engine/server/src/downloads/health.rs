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

use deckhand_model::downloads::SourceHealth;
use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::store::{now_ms, Store};

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
    pub fn load(store: Store) -> anyhow::Result<Self> {
        let map = {
            let conn = store.conn();
            let mut stmt = conn.prepare("select id, health from endpoints")?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            let mut map = HashMap::new();
            for row in rows {
                let (id, json) = row?;
                map.insert(id, serde_json::from_str(&json).unwrap_or_default());
            }
            map
        };
        Ok(Self { store, map: Arc::new(Mutex::new(map)) })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Health>> {
        self.map.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn get(&self, id: &str) -> Health {
        self.lock().get(id).cloned().unwrap_or_default()
    }

    pub fn record(&self, id: &str, event: Event) {
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
        self.save(id, &health);
    }

    pub fn probed(&self, id: &str) {
        let health = {
            let mut map = self.lock();
            let health = map.entry(id.to_owned()).or_default();
            health.last_probe_ms = Some(now_ms());
            health.clone()
        };
        self.save(id, &health);
    }

    fn save(&self, id: &str, health: &Health) {
        let Ok(json) = serde_json::to_string(health) else {
            return;
        };
        let result = self.store.conn().execute(
            "insert into endpoints(id, health) values(?1, ?2) on conflict(id) do update set health = ?2",
            params![id, json],
        );
        if let Err(e) = result {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failing_mirrors_rest_and_sink() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("t.db")).unwrap();
        let reg = Registry::load(store).unwrap();
        reg.record("a:x", Event::Downloaded { bytes: 30_000_000, secs: 30.0 });
        reg.record("b:y", Event::Downloaded { bytes: 30_000_000, secs: 10.0 });
        let mut ids = vec!["a:x".to_owned(), "b:y".to_owned(), "c:z".to_owned()];
        reg.rank(&mut ids);
        assert_eq!(ids[0], "b:y", "the fastest goes first");
        reg.record("b:y", Event::Failed { error: "502".into() });
        reg.record("b:y", Event::Failed { error: "502".into() });
        assert!(reg.get("b:y").is_resting(now_ms()));
        reg.rank(&mut ids);
        assert_eq!(ids[2], "b:y", "a resting mirror goes last");
        reg.record("b:y", Event::Answered { latency_ms: 300.0 });
        assert!(!reg.get("b:y").is_resting(now_ms()), "an answer ends the rest");
    }
}
