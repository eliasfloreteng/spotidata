//! Where files come from. Each source is a family of interchangeable
//! mirrors (community proxies in front of one streaming service); the
//! health registry decides which mirror and which source go first.

mod antra;
mod hifi;
mod monochrome;

use std::sync::Arc;

use futures_util::future::BoxFuture;

use super::Wanted;
use crate::store::Store;

/// How to get the audio once a source has found the track.
#[derive(Debug, Clone)]
pub enum Media {
    /// One file.
    Url { url: String, headers: Vec<(String, String)> },
}

/// What the file needs after download before it is playable.
#[derive(Debug, Clone)]
pub enum Decrypt {
    /// Deezer's stripe cipher: every third 2048-byte chunk is Blowfish-CBC.
    DeezerBlowfish { key: Vec<u8> },
    /// A CENC-encrypted MP4 holding FLAC: ffmpeg decrypts and unwraps it.
    Cenc { key_hex: String },
}

#[derive(Debug, Clone)]
pub struct Found {
    pub media: Media,
    pub decrypt: Option<Decrypt>,
    /// The extension the file gets.
    pub ext: &'static str,
}

#[derive(Debug, Clone)]
pub enum LookupError {
    /// The mirror answered but the service does not have it.
    NotFound(String),
    /// The mirror did not answer usefully.
    Unavailable(String),
    /// The mirror asked to be left alone for this many seconds.
    RateLimited(u64),
}

impl std::fmt::Display for LookupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(s) | Self::Unavailable(s) => f.write_str(s),
            Self::RateLimited(_) => f.write_str("rate limited"),
        }
    }
}

impl From<reqwest::Error> for LookupError {
    fn from(e: reqwest::Error) -> Self {
        Self::Unavailable(describe(&e))
    }
}

/// A reqwest error in a few words, without the URL.
pub fn describe(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "timed out".to_owned()
    } else if e.is_connect() {
        "could not connect".to_owned()
    } else if let Some(status) = e.status() {
        format!("answered {}", status.as_u16())
    } else if e.is_decode() {
        "answered something unreadable".to_owned()
    } else if e.is_body() {
        "the connection dropped".to_owned()
    } else {
        "the request failed".to_owned()
    }
}

pub trait Source: Send + Sync {
    /// `tidal`, `qobuz`, …: the first half of every endpoint id.
    fn name(&self) -> &'static str;
    /// The mirrors, as hosts (or base URLs).
    fn mirrors(&self) -> Vec<String>;
    /// Finds the track on one mirror and says how to fetch it.
    fn lookup<'a>(
        &'a self,
        http: &'a reqwest::Client,
        mirror: &'a str,
        want: &'a Wanted,
    ) -> BoxFuture<'a, Result<Found, LookupError>>;
    /// Rediscovers the mirrors, for sources whose operators publish them.
    fn refresh<'a>(&'a self, _http: &'a reqwest::Client) -> BoxFuture<'a, ()> {
        Box::pin(async {})
    }
}

/// Every source this server can use. Amazon needs ffmpeg to decrypt.
pub fn all(store: &Store, ffmpeg: bool) -> Vec<Arc<dyn Source>> {
    let antra = antra::Manifest::new(store.clone());
    let mut sources: Vec<Arc<dyn Source>> = vec![
        Arc::new(antra::Antra::new(antra::Service::Tidal, antra.clone())),
        Arc::new(monochrome::Monochrome),
        Arc::new(antra::Antra::new(antra::Service::Deezer, antra.clone())),
        Arc::new(antra::Antra::new(antra::Service::Qobuz, antra.clone())),
        Arc::new(hifi::Hifi::default()),
    ];
    if ffmpeg {
        sources.push(Arc::new(antra::Antra::new(antra::Service::Amazon, antra)));
    }
    // `DECKHAND_SOURCES_OFF=qobuz,hifi` turns sources off.
    let off = std::env::var("DECKHAND_SOURCES_OFF").unwrap_or_default();
    let off: Vec<&str> = off.split(',').map(str::trim).collect();
    sources.retain(|s| !off.contains(&s.name()));
    sources
}

/// The endpoint id of a mirror: `tidal:example.org`.
pub fn endpoint(source: &str, mirror: &str) -> String {
    let host = mirror.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/');
    format!("{source}:{host}")
}

/// Reads a JSON answer, telling "not here" from "broken".
pub async fn json(response: reqwest::Response) -> Result<serde_json::Value, LookupError> {
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(LookupError::NotFound("not in its catalogue".to_owned()));
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(LookupError::RateLimited(retry_after(&response)));
    }
    if !status.is_success() {
        return Err(LookupError::Unavailable(format!("answered {}", status.as_u16())));
    }
    response.json().await.map_err(|_| LookupError::Unavailable("answered something unreadable".to_owned()))
}

/// How long a 429 asks to wait, within reason; two minutes if it does not say.
pub fn retry_after(response: &reqwest::Response) -> u64 {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(120)
        .clamp(30, 3600)
}

/// Whether a candidate from a text search is the wanted recording.
pub fn same_track(want: &Wanted, isrc: Option<&str>, title: &str, artists: &[&str], duration_sec: f64) -> bool {
    if let (Some(a), Some(b)) = (want.isrc.as_deref(), isrc) {
        if !b.is_empty() {
            return a.eq_ignore_ascii_case(b);
        }
    }
    let norm = super::catalog::normalise;
    let first = want.artists.first().map(|a| norm(a)).unwrap_or_default();
    norm(title) == norm(&want.title)
        && artists.iter().any(|a| !first.is_empty() && norm(a).contains(&first))
        && want.duration_fits(duration_sec)
}
