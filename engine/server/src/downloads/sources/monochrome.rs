//! Monochrome's track service (monochrome.tf): a text search with ISRCs and
//! a plain lossless FLAC per track, no account.

use futures_util::future::BoxFuture;
use serde_json::Value;

use super::{json, same_track, Found, LookupError, Media, Source};
use crate::downloads::Wanted;

const BASE: &str = "https://tracks.monochrome.st";

pub struct Monochrome;

impl Source for Monochrome {
    fn name(&self) -> &'static str {
        "monochrome"
    }

    fn mirrors(&self) -> Vec<String> {
        vec![BASE.to_owned()]
    }

    fn lookup<'a>(
        &'a self,
        http: &'a reqwest::Client,
        mirror: &'a str,
        want: &'a Wanted,
    ) -> BoxFuture<'a, Result<Found, LookupError>> {
        Box::pin(async move {
            let base = mirror.trim_end_matches('/');
            let response = http
                .get(format!("{base}/search/tracks"))
                .query(&[("q", want.query().as_str()), ("limit", "15")])
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await?;
            let results = json(response).await?;
            let tracks = results.get("tracks").and_then(Value::as_array).cloned().unwrap_or_default();
            let hit = tracks.iter().find(|t| {
                let artists: Vec<&str> = t
                    .get("artistNames")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                t.get("playable").and_then(Value::as_bool).unwrap_or(true)
                    && same_track(
                        want,
                        t.get("isrc").and_then(Value::as_str),
                        t.get("title").and_then(Value::as_str).unwrap_or_default(),
                        &artists,
                        t.get("duration").and_then(Value::as_f64).unwrap_or(0.0) / 1000.0,
                    )
            });
            let id = hit
                .and_then(|t| t.get("trackId").or_else(|| t.get("id")))
                .and_then(Value::as_str)
                .ok_or_else(|| LookupError::NotFound("not in its catalogue".to_owned()))?;
            Ok(Found {
                media: Media::Url { url: format!("{base}/track/{id}"), headers: vec![] },
                decrypt: None,
                ext: "flac",
            })
        })
    }
}
