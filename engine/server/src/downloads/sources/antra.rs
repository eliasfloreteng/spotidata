//! The Antra mirrors: one operator relaying Tidal, Qobuz, Deezer and Amazon
//! (github.com/anandprtp/Antra). Hosts and the shared client key are
//! published in a gist the Antra app reads too; it is re-read every hour and
//! the last copy kept, so a GitHub outage does not stop downloads.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{json, Decrypt, Found, LookupError, Media, Source};
use crate::downloads::Wanted;
use crate::store::Store;

const MANIFEST_URL: &str = "https://gist.githubusercontent.com/anandprtp/fdc2c16b7bfdc2d337fbc86161b79371/raw";
const META_KEY: &str = "antra_manifest";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Published {
    #[serde(default)]
    mirrors: HashMap<String, String>,
    #[serde(default)]
    api_key: String,
}

/// The published hosts and key, shared by the four services.
#[derive(Clone)]
pub struct Manifest {
    store: Store,
    current: Arc<RwLock<Published>>,
    /// When it was last fetched; held while fetching, so the four services
    /// refreshing together fetch once.
    fetched: Arc<tokio::sync::Mutex<Option<std::time::Instant>>>,
}

impl Manifest {
    pub fn new(store: Store) -> Self {
        let saved =
            store.meta(META_KEY).ok().flatten().and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default();
        Self { store, current: Arc::new(RwLock::new(saved)), fetched: Arc::default() }
    }

    fn read(&self) -> Published {
        self.current.read().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }

    async fn refresh(&self, http: &reqwest::Client) {
        let mut last = self.fetched.lock().await;
        if last.is_some_and(|t| t.elapsed() < std::time::Duration::from_secs(300)) {
            return;
        }
        *last = Some(std::time::Instant::now());
        let fetched = async {
            let response = http.get(MANIFEST_URL).timeout(std::time::Duration::from_secs(15)).send().await.ok()?;
            let published: Published = response.error_for_status().ok()?.json().await.ok()?;
            (!published.mirrors.is_empty()).then_some(published)
        }
        .await;
        let Some(published) = fetched else {
            tracing::warn!("could not read the Antra mirror list; keeping the last one");
            return;
        };
        if let Ok(json) = serde_json::to_string(&published) {
            let _ = self.store.set_meta(META_KEY, &json);
        }
        *self.current.write().unwrap_or_else(std::sync::PoisonError::into_inner) = published;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Service {
    Tidal,
    Qobuz,
    Deezer,
    Amazon,
}

impl Service {
    fn key(self) -> &'static str {
        match self {
            Self::Tidal => "tidal",
            Self::Qobuz => "qobuz",
            Self::Deezer => "deezer",
            Self::Amazon => "amazon",
        }
    }
}

pub struct Antra {
    service: Service,
    manifest: Manifest,
}

impl Antra {
    pub fn new(service: Service, manifest: Manifest) -> Self {
        Self { service, manifest }
    }

    fn get(&self, http: &reqwest::Client, url: String) -> reqwest::RequestBuilder {
        http.get(url)
            .header("X-API-Key", self.manifest.read().api_key)
            .header("Accept", "application/json")
            .timeout(std::time::Duration::from_secs(20))
    }

    /// The service's id for the recording.
    async fn find_id(&self, http: &reqwest::Client, base: &str, want: &Wanted) -> Result<String, LookupError> {
        let Some(isrc) = &want.isrc else {
            return Err(LookupError::NotFound("needs an ISRC".to_owned()));
        };
        let found = json(self.get(http, format!("{base}/api/search/isrc/{isrc}")).send().await?).await?;
        let id = ["track_id", "asin"]
            .iter()
            .find_map(|k| found.get(*k))
            .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned))
            .filter(|id| !id.is_empty() && id != "null")
            .ok_or_else(|| LookupError::NotFound("not in its catalogue".to_owned()))?;
        if let Some(ms) = found.get("duration_ms").and_then(Value::as_f64) {
            if !want.duration_fits(ms / 1000.0) {
                return Err(LookupError::NotFound(format!("its version is {:.0} s long", ms / 1000.0)));
            }
        }
        Ok(id)
    }

    /// The file comes straight through the mirror.
    fn relay(&self, base: &str, id: &str) -> Found {
        Found {
            media: Media::Url {
                url: format!("{base}/api/stream/{id}?prefer_16=1&require_lossless=1"),
                headers: vec![("X-API-Key".to_owned(), self.manifest.read().api_key)],
            },
            decrypt: None,
            ext: "flac",
        }
    }

    /// The mirror hands out the service's own CDN link and the key to it.
    async fn direct(&self, http: &reqwest::Client, base: &str, id: &str) -> Result<Found, LookupError> {
        let track = json(self.get(http, format!("{base}/api/track/{id}")).send().await?).await?;
        let codec = track.get("codec").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase();
        if !codec.contains("flac") {
            return Err(LookupError::NotFound(format!("only offers {codec}")));
        }
        let url = track
            .get("streamUrl")
            .and_then(Value::as_str)
            .ok_or_else(|| LookupError::Unavailable("gave no link".to_owned()))?
            .to_owned();
        let key = track
            .get("decryptionKey")
            .and_then(Value::as_str)
            .ok_or_else(|| LookupError::Unavailable("gave no key".to_owned()))?
            .to_owned();
        let decrypt = match self.service {
            Service::Deezer => Decrypt::DeezerBlowfish { key: key.into_bytes() },
            _ => Decrypt::Cenc { key_hex: key },
        };
        Ok(Found { media: Media::Url { url, headers: vec![] }, decrypt: Some(decrypt), ext: "flac" })
    }
}

impl Source for Antra {
    fn name(&self) -> &'static str {
        self.service.key()
    }

    fn mirrors(&self) -> Vec<String> {
        self.manifest.read().mirrors.get(self.service.key()).cloned().into_iter().collect()
    }

    fn lookup<'a>(
        &'a self,
        http: &'a reqwest::Client,
        mirror: &'a str,
        want: &'a Wanted,
    ) -> BoxFuture<'a, Result<Found, LookupError>> {
        Box::pin(async move {
            let base = mirror.trim_end_matches('/');
            // Deezer ids come with the catalog; the rest are looked up by ISRC.
            let id = match (self.service, want.deezer_id) {
                (Service::Deezer, Some(id)) => id.to_string(),
                _ => self.find_id(http, base, want).await?,
            };
            match self.service {
                Service::Tidal | Service::Qobuz => Ok(self.relay(base, &id)),
                Service::Deezer | Service::Amazon => self.direct(http, base, &id).await,
            }
        })
    }

    fn refresh<'a>(&'a self, http: &'a reqwest::Client) -> BoxFuture<'a, ()> {
        Box::pin(self.manifest.refresh(http))
    }
}
