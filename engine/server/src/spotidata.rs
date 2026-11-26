//! Spotidata, the engine's other half in the same stack: it holds the
//! account's Spotify sign-in and the rate limiter every Spotify call goes
//! through, and every playlist in its own tables, which the engine reads
//! directly (`spotidata.engine_playlists`, `spotidata.engine_playlist_tracks`).
//! What needs Spotify itself goes through its engine routes
//! (`src/routes/api/engine/` there):
//!
//! - `GET  /api/engine/search?q=&limit=`  Spotify's catalog, for Get Music;
//! - `POST /api/engine/playlists/check`   `{ids, force}`: the snapshot check
//!   of the kept playlists, which reads again those that changed;
//! - `PUT  /api/engine/playlists/{id}`    fetch a playlist (one added by its
//!   link) into Spotidata's tables, as its pages do for an entity they show.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// A track of Spotify's catalog.
#[derive(Debug, Clone, Deserialize)]
pub struct CatalogTrack {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub artists: Vec<String>,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub isrc: Option<String>,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub cover: Option<String>,
    #[serde(default)]
    pub explicit: bool,
}

/// What the check found for one kept playlist.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Checked {
    /// Its snapshot hadn't moved.
    Unchanged,
    /// Its tracks were read again.
    Read,
    /// Spotify no longer has it, or no longer shows it to the account.
    Gone,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CheckedPlaylist {
    pub id: String,
    pub state: Checked,
}

#[derive(Deserialize)]
struct CheckAnswer {
    playlists: Vec<CheckedPlaylist>,
}

/// Whether Spotidata has a playlist's tracks yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Fetched {
    Ready,
    /// Being read; it shows up shortly.
    Pending,
}

#[derive(Deserialize)]
struct FetchAnswer {
    state: Fetched,
}

/// A playlist Spotify no longer has (or no longer shows this account).
#[derive(Debug)]
pub struct Gone;

impl std::fmt::Display for Gone {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Spotify no longer has this playlist.")
    }
}

impl std::error::Error for Gone {}

#[derive(Clone)]
pub struct Spotidata {
    base: String,
    http: reqwest::Client,
}

impl Spotidata {
    pub fn new(base: &str) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("deckhand-engine/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        Self { base: base.trim_end_matches('/').to_owned(), http }
    }

    /// The client, for following a short link.
    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    /// Tracks matching free text, best first.
    pub async fn search(&self, query: &str, limit: usize) -> Result<Vec<CatalogTrack>> {
        let limit = limit.clamp(1, 50).to_string();
        let request = self.http.get(self.url("/api/engine/search")).query(&[("q", query), ("limit", &limit)]);
        answer(request.timeout(Duration::from_secs(30))).await
    }

    /// The snapshot check: the account's playlists listed again (one request
    /// per 50), each of `ids` the account doesn't list asked for by id, and
    /// the tracks read again of those whose snapshot moved, and of `force`
    /// whatever their snapshot.
    pub async fn check(&self, ids: &[String], force: &[String]) -> Result<Vec<CheckedPlaylist>> {
        #[derive(Serialize)]
        struct Body<'a> {
            ids: &'a [String],
            force: &'a [String],
        }
        let request = self.http.post(self.url("/api/engine/playlists/check")).json(&Body { ids, force });
        // A big playlist is 25 Spotify pages, each paced by Spotidata.
        let answer: CheckAnswer = answer(request.timeout(Duration::from_secs(300))).await?;
        Ok(answer.playlists)
    }

    /// Has Spotidata fetch a playlist (any one Spotify shows the account,
    /// not only its own) into its tables.
    pub async fn fetch(&self, id: &str) -> Result<Fetched> {
        if !is_id(id) {
            bail!("not a playlist id");
        }
        let request = self.http.put(self.url(&format!("/api/engine/playlists/{id}")));
        let answer: FetchAnswer = answer(request.timeout(Duration::from_secs(90))).await?;
        Ok(answer.state)
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }
}

/// A Spotify id: base62.
pub fn is_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric())
}

async fn answer<T: serde::de::DeserializeOwned>(request: reqwest::RequestBuilder) -> Result<T> {
    let response = request.send().await.context("Spotidata is unreachable")?;
    let status = response.status();
    if status.is_success() {
        return response.json().await.context("Spotidata answered something unexpected");
    }
    if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::FORBIDDEN {
        return Err(Gone.into());
    }
    // Spotidata explains Spotify's trouble (a pause it asked for, a sign-in
    // that expired) in plain text.
    let text = response.text().await.unwrap_or_default();
    let text = text.trim();
    if !text.is_empty() && text.len() < 300 && !text.starts_with('<') && !text.starts_with('{') {
        bail!("{text}");
    }
    bail!("Spotidata answered {status}")
}
