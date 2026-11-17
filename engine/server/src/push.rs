//! Notifications to the phone through APNs, for things only you can do.
//!
//! Configured with `DECKHAND_APNS_KEY` (path to the team's `.p8`),
//! `DECKHAND_APNS_KEY_ID` and `DECKHAND_APNS_TEAM_ID`; without them nothing
//! is sent. Phones register their token at `POST /api/devices`.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use rusqlite::params;
use serde_json::{json, Value};
use tracing::{info, warn};

use crate::store::{now_ms, Store};

const TOPIC: &str = "se.floreteng.Deckhand";
/// Apple wants a new provider token at most every 20 minutes and at least
/// every hour.
const TOKEN_LIFE: Duration = Duration::from_secs(40 * 60);

#[derive(Clone)]
pub struct Push {
    store: Store,
    http: reqwest::Client,
    key: Option<Arc<Key>>,
    token: Arc<Mutex<Option<(Instant, String)>>>,
}

struct Key {
    id: String,
    team: String,
    pem: jsonwebtoken::EncodingKey,
}

impl Push {
    pub fn new(store: Store) -> Self {
        let key = (|| -> Result<Option<Key>> {
            let (Ok(path), Ok(id), Ok(team)) = (
                std::env::var("DECKHAND_APNS_KEY"),
                std::env::var("DECKHAND_APNS_KEY_ID"),
                std::env::var("DECKHAND_APNS_TEAM_ID"),
            ) else {
                return Ok(None);
            };
            let pem = std::fs::read(&path).with_context(|| format!("reading {path}"))?;
            Ok(Some(Key { id, team, pem: jsonwebtoken::EncodingKey::from_ec_pem(&pem)? }))
        })();
        let key = match key {
            Ok(Some(key)) => Some(Arc::new(key)),
            Ok(None) => {
                info!("no APNs key configured; notifications are off");
                None
            }
            Err(e) => {
                warn!(error = %e, "the APNs key is unusable; notifications are off");
                None
            }
        };
        // APNs speaks only HTTP/2, which TLS negotiates.
        let http = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().unwrap_or_default();
        Self { store, http, key, token: Arc::default() }
    }

    pub fn register(&self, token: &str, environment: &str) -> Result<()> {
        let environment = if environment == "production" { "production" } else { "development" };
        let token: String = token.chars().filter(char::is_ascii_hexdigit).collect();
        anyhow::ensure!(token.len() >= 64, "not a device token");
        self.store.conn().execute(
            "insert into devices(token, environment, updated_ms) values(?1, ?2, ?3)
             on conflict(token) do update set environment = ?2, updated_ms = ?3",
            params![token, environment, now_ms()],
        )?;
        Ok(())
    }

    fn provider_token(&self, key: &Key) -> Result<String> {
        let mut cached = self.token.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((made, token)) = cached.as_ref() {
            if made.elapsed() < TOKEN_LIFE {
                return Ok(token.clone());
            }
        }
        let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::ES256);
        header.kid = Some(key.id.clone());
        let claims = json!({ "iss": key.team, "iat": now_ms() / 1000 });
        let token = jsonwebtoken::encode(&header, &claims, &key.pem)?;
        *cached = Some((Instant::now(), token.clone()));
        Ok(token)
    }

    /// Sends an alert to every registered phone. `data` rides along for the
    /// app to act on when it is tapped.
    pub async fn alert(&self, title: &str, body: &str, data: Value) {
        let Some(key) = self.key.clone() else { return };
        let devices: Vec<(String, String)> = {
            let conn = self.store.conn();
            let Ok(mut stmt) = conn.prepare("select token, environment from devices") else { return };
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .map(|rows| rows.filter_map(Result::ok).collect())
                .unwrap_or_default()
        };
        if devices.is_empty() {
            return;
        }
        let token = match self.provider_token(&key) {
            Ok(token) => token,
            Err(e) => {
                warn!(error = %e, "could not sign an APNs token");
                return;
            }
        };
        let mut payload = json!({ "aps": { "alert": { "title": title, "body": body }, "sound": "default" } });
        if let (Some(payload), Value::Object(data)) = (payload.as_object_mut(), data) {
            payload.extend(data);
        }
        for (device, environment) in devices {
            let host = if environment == "production" { "api.push.apple.com" } else { "api.sandbox.push.apple.com" };
            let sent = self
                .http
                .post(format!("https://{host}/3/device/{device}"))
                .bearer_auth(&token)
                .header("apns-topic", TOPIC)
                .header("apns-push-type", "alert")
                .header("apns-priority", "10")
                .json(&payload)
                .send()
                .await;
            match sent {
                Ok(response) if response.status().is_success() => info!("notified a phone"),
                Ok(response) => {
                    let status = response.status();
                    let reason = response.text().await.unwrap_or_default();
                    warn!(%status, %reason, "APNs refused a notification");
                    // The phone uninstalled the app or the token rotated.
                    if status == reqwest::StatusCode::GONE || reason.contains("BadDeviceToken") {
                        let _ = self.store.conn().execute("delete from devices where token = ?1", params![device]);
                    }
                }
                Err(e) => warn!(error = %e, "could not reach APNs"),
            }
        }
    }
}
