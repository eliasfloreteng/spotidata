//! Where Spotify is read from: Spotidata, which holds the account's sign-in
//! and the rate limiter every Spotify call of the house goes through, and
//! reads the playlists live (`GET /api/playlists`, `/api/playlists/{id}`,
//! `/api/playlists/{id}/info` for one added by its link).

use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct RemotePlaylist {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub owned: bool,
    pub snapshot_id: String,
    #[serde(default)]
    pub tracks: usize,
    #[serde(default)]
    pub image: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteTrack {
    /// `None` for a local file.
    #[serde(default)]
    pub id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub artists: Vec<String>,
    #[serde(default)]
    pub album: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isrc: Option<String>,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
}

impl RemoteTrack {
    pub fn duration_sec(&self) -> u32 {
        u32::try_from((self.duration_ms + 500) / 1000).unwrap_or(0)
    }

    /// What identifies the recording across playlists: its ISRC, else its
    /// Spotify id. `None` for a local file.
    pub fn key(&self) -> Option<String> {
        match (&self.isrc, &self.id) {
            (Some(isrc), _) => Some(format!("isrc:{isrc}")),
            (None, Some(id)) => Some(format!("spotify:{id}")),
            (None, None) => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct RemotePlaylistTracks {
    pub snapshot_id: String,
    pub tracks: Vec<RemoteTrack>,
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
    pub fn new(base: &str, http: reqwest::Client) -> Self {
        Self { base: base.trim_end_matches('/').to_owned(), http }
    }

    /// The client, for following a short link.
    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    /// The account's playlists.
    pub async fn playlists(&self) -> Result<Vec<RemotePlaylist>> {
        self.get("/api/playlists").await
    }

    pub async fn playlist(&self, id: &str) -> Result<RemotePlaylistTracks> {
        if !id.chars().all(|c| c.is_ascii_alphanumeric()) {
            bail!("not a playlist id");
        }
        self.get(&format!("/api/playlists/{id}")).await
    }

    /// Any playlist Spotify shows the account, as the list describes it,
    /// without its tracks.
    pub async fn info(&self, id: &str) -> Result<RemotePlaylist> {
        if !id.chars().all(|c| c.is_ascii_alphanumeric()) {
            bail!("not a playlist id");
        }
        self.get(&format!("/api/playlists/{id}/info")).await
    }

    async fn get<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T> {
        let response = self
            .http
            .get(format!("{}{path}", self.base))
            // A big playlist is 25 Spotify pages, each paced by Spotidata.
            .timeout(Duration::from_secs(180))
            .send()
            .await
            .context("Spotidata is unreachable")?;
        let status = response.status();
        if status.is_success() {
            return response.json().await.context("Spotidata answered something unexpected");
        }
        if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::FORBIDDEN {
            return Err(Gone.into());
        }
        // Spotidata explains Spotify's trouble in plain text.
        let text = response.text().await.unwrap_or_default();
        let text = text.trim();
        if !text.is_empty() && text.len() < 300 && !text.starts_with('<') {
            bail!("{text}");
        }
        bail!("Spotidata answered {status}")
    }
}
