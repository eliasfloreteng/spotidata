//! Tidal through "hifi-api" proxies (github.com/binimum/hifi-api), the
//! protocol Monochrome and SpotiFLAC speak. The instances come and go; the
//! list Monochrome publishes is re-read every hour, plus any in
//! `DECKHAND_HIFI_INSTANCES` (comma-separated base URLs).

use std::sync::RwLock;

use base64::Engine;
use futures_util::future::BoxFuture;
use serde_json::Value;

use super::{json, same_track, Found, LookupError, Media, Source};
use crate::downloads::Wanted;

const INSTANCES_URL: &str = "https://raw.githubusercontent.com/monochrome-music/monochrome/main/public/instances.json";

#[derive(Default)]
pub struct Hifi {
    instances: RwLock<Vec<String>>,
}

fn configured() -> Vec<String> {
    std::env::var("DECKHAND_HIFI_INSTANCES")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().trim_end_matches('/').to_owned())
        .filter(|s| s.starts_with("http"))
        .collect()
}

impl Hifi {
    /// The first item of the answer that looks like a track list.
    fn items(value: &Value) -> Vec<Value> {
        for pointer in ["/data/items", "/items", "/data/tracks/items", "/tracks/items"] {
            if let Some(items) = value.pointer(pointer).and_then(Value::as_array) {
                return items.clone();
            }
        }
        Vec::new()
    }

    async fn search(&self, http: &reqwest::Client, base: &str, query: &str) -> Result<Vec<Value>, LookupError> {
        let response = http
            .get(format!("{base}/search/"))
            .query(&[("s", query)])
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await?;
        Ok(Self::items(&json(response).await?))
    }

    fn matches(want: &Wanted, item: &Value) -> bool {
        let mut artists: Vec<&str> = item
            .get("artists")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.get("name").and_then(Value::as_str)).collect())
            .unwrap_or_default();
        if let Some(name) = item.pointer("/artist/name").and_then(Value::as_str) {
            artists.push(name);
        }
        same_track(
            want,
            item.get("isrc").and_then(Value::as_str),
            item.get("title").and_then(Value::as_str).unwrap_or_default(),
            &artists,
            item.get("duration").and_then(Value::as_f64).unwrap_or(0.0),
        )
    }
}

impl Source for Hifi {
    fn name(&self) -> &'static str {
        "hifi"
    }

    fn mirrors(&self) -> Vec<String> {
        let mut all = configured();
        for instance in self.instances.read().unwrap_or_else(std::sync::PoisonError::into_inner).iter() {
            if !all.contains(instance) {
                all.push(instance.clone());
            }
        }
        all
    }

    fn lookup<'a>(
        &'a self,
        http: &'a reqwest::Client,
        mirror: &'a str,
        want: &'a Wanted,
    ) -> BoxFuture<'a, Result<Found, LookupError>> {
        Box::pin(async move {
            let base = mirror.trim_end_matches('/');
            let mut items = match &want.isrc {
                Some(isrc) => self.search(http, base, isrc).await?,
                None => Vec::new(),
            };
            if !items.iter().any(|i| Self::matches(want, i)) {
                items = self.search(http, base, &want.query()).await?;
            }
            let id = items
                .iter()
                .find(|i| Self::matches(want, i))
                .and_then(|i| i.get("id"))
                .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned))
                .ok_or_else(|| LookupError::NotFound("not in its catalogue".to_owned()))?;

            let response = http
                .get(format!("{base}/track/"))
                .query(&[("id", id.as_str()), ("quality", "LOSSLESS")])
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await?;
            let answer = json(response).await?;
            // An object, or a list with the playback info among its items.
            let info = answer
                .get("data")
                .cloned()
                .or_else(|| answer.as_array().and_then(|a| a.iter().find(|x| x.get("manifest").is_some()).cloned()))
                .unwrap_or(answer);
            if info.get("assetPresentation").and_then(Value::as_str) == Some("PREVIEW") {
                return Err(LookupError::Unavailable("only had a preview".to_owned()));
            }
            let mime = info.get("manifestMimeType").and_then(Value::as_str).unwrap_or_default();
            if mime != "application/vnd.tidal.bts" {
                return Err(LookupError::Unavailable(format!("sent an unsupported manifest ({mime})")));
            }
            let manifest = info
                .get("manifest")
                .and_then(Value::as_str)
                .and_then(|m| base64::engine::general_purpose::STANDARD.decode(m).ok())
                .and_then(|m| serde_json::from_slice::<Value>(&m).ok())
                .ok_or_else(|| LookupError::Unavailable("sent an unreadable manifest".to_owned()))?;
            if manifest.get("encryptionType").and_then(Value::as_str).is_some_and(|e| e != "NONE") {
                return Err(LookupError::Unavailable("sent an encrypted stream".to_owned()));
            }
            let codec = manifest.get("codecs").and_then(Value::as_str).unwrap_or("flac");
            if !codec.contains("flac") {
                return Err(LookupError::NotFound(format!("only offers {codec}")));
            }
            let url = manifest
                .pointer("/urls/0")
                .and_then(Value::as_str)
                .ok_or_else(|| LookupError::Unavailable("gave no link".to_owned()))?
                .to_owned();
            Ok(Found { media: Media::Url { url, headers: vec![] }, decrypt: None, ext: "flac" })
        })
    }

    fn refresh<'a>(&'a self, http: &'a reqwest::Client) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let fetched = async {
                let response = http.get(INSTANCES_URL).timeout(std::time::Duration::from_secs(15)).send().await.ok()?;
                let value: Value = response.error_for_status().ok()?.json().await.ok()?;
                let mut list: Vec<String> = Vec::new();
                for key in ["streaming", "api"] {
                    for url in value.get(key).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str)
                    {
                        let url = url.trim().trim_end_matches('/').to_owned();
                        if url.starts_with("https://") && !list.contains(&url) {
                            list.push(url);
                        }
                    }
                }
                Some(list)
            }
            .await;
            if let Some(list) = fetched {
                *self.instances.write().unwrap_or_else(std::sync::PoisonError::into_inner) = list;
            }
        })
    }
}
