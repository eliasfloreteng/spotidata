//! Spotify as it shows anyone, without an account or an app of our own: what
//! a library on the phone reads playlists through, having no Spotidata.
//!
//! The embed player's page (`open.spotify.com/embed/playlist/{id}`) carries
//! an anonymous session token, and with it the query Spotify's web player
//! itself sends (`fetchPlaylist`) reads a playlist in pages: its name, owner,
//! cover, revision and tracks. Editorial playlists and Spotify's mixes read
//! too, which an app signed in to an account can't.
//!
//! Neither is a published API, so either can change under us. The query is
//! named by the hash of its text in the web player; when Spotify stops
//! taking it, the embed page's own list (the first 100 tracks) stands in,
//! and a longer playlist says it can't be read whole.

use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};

use super::remote::{Gone, RemotePlaylist, RemotePlaylistTracks, RemoteTrack};
use crate::store::now_ms;

/// The web player's `fetchPlaylist` query, by the hash of its text.
const QUERY_HASH: &str = "19ff1327c29e99c208c86d7a9d8f1929cfdf3d3202a0ff4253c821f1901aa94d";
const QUERY_URL: &str = "https://api-partner.spotify.com/pathfinder/v2/query";
/// Tracks asked for at once; Spotify takes up to 1000.
const PAGE: usize = 500;
/// What the embed page lists at most.
const EMBED_CAP: usize = 100;
/// The embed page is served to browsers.
const BROWSER: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 \
                       (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

pub struct Public {
    http: reqwest::Client,
    /// The anonymous token and when it expires, ms since the epoch.
    token: Mutex<Option<(String, i64)>>,
}

/// The query was not taken: Spotify's web player changed.
#[derive(Debug)]
struct Unsupported(String);

impl std::fmt::Display for Unsupported {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Spotify didn't take the playlist query ({})", self.0)
    }
}

impl std::error::Error for Unsupported {}

impl Public {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http, token: Mutex::default() }
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    /// The playlist without its tracks.
    pub async fn info(&self, id: &str) -> Result<RemotePlaylist> {
        check_id(id)?;
        match self.query(id, 0, 1).await {
            Ok(p) => Ok(describe(id, &p)),
            Err(e) if e.is::<Unsupported>() => {
                let entity = self.embed(id).await?.1;
                let tracks = embed_tracks(&entity);
                Ok(RemotePlaylist {
                    id: id.to_owned(),
                    name: str_at(&entity, "/name"),
                    owner: str_at(&entity, "/subtitle"),
                    owned: false,
                    snapshot_id: fingerprint(&tracks),
                    tracks: tracks.len(),
                    image: entity.pointer("/coverArt/sources/0/url").and_then(Value::as_str).map(str::to_owned),
                })
            }
            Err(e) => Err(e),
        }
    }

    /// The playlist's tracks, in its order.
    pub async fn playlist(&self, id: &str) -> Result<RemotePlaylistTracks> {
        self.playlist_in_pages(id, PAGE).await
    }

    async fn playlist_in_pages(&self, id: &str, page_size: usize) -> Result<RemotePlaylistTracks> {
        check_id(id)?;
        let first = match self.query(id, 0, page_size).await {
            Ok(first) => first,
            Err(e) if e.is::<Unsupported>() => {
                let tracks = embed_tracks(&self.embed(id).await?.1);
                if tracks.len() >= EMBED_CAP {
                    return Err(e.context(format!(
                        "Spotify shows only the first {EMBED_CAP} tracks of this playlist without an account \
                         right now; Deckhand needs an update to read the rest."
                    )));
                }
                return Ok(RemotePlaylistTracks { snapshot_id: fingerprint(&tracks), tracks });
            }
            Err(e) => return Err(e),
        };
        let total = first.pointer("/content/totalCount").and_then(Value::as_u64).unwrap_or(0) as usize;
        let snapshot_id = str_at(&first, "/revisionId");
        let mut tracks = Vec::with_capacity(total);
        let mut page = first;
        let mut offset = 0;
        loop {
            let items = page.pointer("/content/items").and_then(Value::as_array).cloned().unwrap_or_default();
            offset += items.len();
            tracks.extend(items.iter().filter_map(track));
            if items.is_empty() || offset >= total {
                break;
            }
            page = self.query(id, offset, page_size).await?;
        }
        Ok(RemotePlaylistTracks { snapshot_id, tracks })
    }

    /// `playlistV2` of the web player's query, with a fresh token if the
    /// one held has lapsed.
    async fn query(&self, id: &str, offset: usize, limit: usize) -> Result<Value> {
        for attempt in 0..2 {
            let token = self.token(id).await?;
            let body = json!({
                "variables": { "uri": format!("spotify:playlist:{id}"), "offset": offset, "limit": limit },
                "operationName": "fetchPlaylist",
                "extensions": { "persistedQuery": { "version": 1, "sha256Hash": QUERY_HASH } },
            });
            let response = self
                .http
                .post(QUERY_URL)
                .bearer_auth(&token)
                .header("App-Platform", "WebPlayer")
                .json(&body)
                .timeout(Duration::from_secs(30))
                .send()
                .await
                .context("Spotify is unreachable")?;
            let status = response.status();
            if status == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                *lock(&self.token) = None;
                continue;
            }
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                bail!("Spotify asks to wait before reading more.");
            }
            if !status.is_success() {
                return Err(Unsupported(format!("it answered {}", status.as_u16())).into());
            }
            let answer: Value = response.json().await.context("Spotify answered something unexpected")?;
            if let Some(error) = answer.pointer("/errors/0/message").and_then(Value::as_str) {
                return Err(Unsupported(error.to_owned()).into());
            }
            let playlist = answer.pointer("/data/playlistV2").cloned().unwrap_or(Value::Null);
            return match playlist.get("__typename").and_then(Value::as_str) {
                Some("Playlist") => Ok(playlist),
                Some("NotFound") => Err(Gone.into()),
                _ => Err(Unsupported("no playlist in the answer".to_owned()).into()),
            };
        }
        Err(anyhow!("Spotify keeps refusing its own token"))
    }

    async fn token(&self, id: &str) -> Result<String> {
        if let Some((token, expires)) = lock(&self.token).clone() {
            if expires > now_ms() + 60_000 {
                return Ok(token);
            }
        }
        Ok(self.embed(id).await?.0)
    }

    /// The embed page's anonymous token, which it also keeps, and its
    /// description of the playlist.
    async fn embed(&self, id: &str) -> Result<(String, Value)> {
        let response = self
            .http
            .get(format!("https://open.spotify.com/embed/playlist/{id}"))
            .header(reqwest::header::USER_AGENT, BROWSER)
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .context("Spotify is unreachable")?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(Gone.into());
        }
        let page = response.error_for_status().context("Spotify's player page")?.text().await?;
        let data = next_data(&page).context("Spotify's player page has changed")?;
        let state = data.pointer("/props/pageProps/state").context("Spotify's player page has changed")?;
        let token = str_at(state, "/settings/session/accessToken");
        if token.is_empty() {
            bail!("Spotify's player page gave no session");
        }
        let expires = state.pointer("/settings/session/accessTokenExpirationTimestampMs").and_then(Value::as_i64);
        *lock(&self.token) = Some((token.clone(), expires.unwrap_or_else(|| now_ms() + 30 * 60_000)));
        let entity = state.pointer("/data/entity").cloned().unwrap_or(Value::Null);
        if entity.is_null() {
            return Err(Gone.into());
        }
        Ok((token, entity))
    }
}

fn check_id(id: &str) -> Result<()> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        bail!("not a playlist id");
    }
    Ok(())
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn str_at(v: &Value, pointer: &str) -> String {
    v.pointer(pointer).and_then(Value::as_str).unwrap_or_default().to_owned()
}

/// The page's `__NEXT_DATA__`, the state it was rendered from.
fn next_data(page: &str) -> Option<Value> {
    let start = page.find(r#"<script id="__NEXT_DATA__" type="application/json">"#)?;
    let json = &page[start..];
    let json = &json[json.find('>')? + 1..];
    serde_json::from_str(&json[..json.find("</script>")?]).ok()
}

fn describe(id: &str, p: &Value) -> RemotePlaylist {
    RemotePlaylist {
        id: id.to_owned(),
        name: str_at(p, "/name"),
        owner: str_at(p, "/ownerV2/data/name"),
        owned: false,
        snapshot_id: str_at(p, "/revisionId"),
        tracks: p.pointer("/content/totalCount").and_then(Value::as_u64).unwrap_or(0) as usize,
        image: p.pointer("/images/items/0/sources/0/url").and_then(Value::as_str).map(str::to_owned),
    }
}

/// One entry of the query's list: a track, or a local file; `None` for
/// what can't be got (a podcast episode, a track Spotify withdrew).
fn track(item: &Value) -> Option<RemoteTrack> {
    let data = item.pointer("/itemV2/data")?;
    let local = match data.get("__typename").and_then(Value::as_str)? {
        "Track" => false,
        "LocalTrack" => true,
        _ => return None,
    };
    let names = |pointer: &str| -> Vec<String> {
        data.pointer(pointer)
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.pointer("/profile/name")?.as_str().map(str::to_owned)).collect())
            .unwrap_or_default()
    };
    let cover = data.pointer("/albumOfTrack/coverArt/sources").and_then(Value::as_array).and_then(|sources| {
        // About 300 px, as the catalog's covers are.
        sources
            .iter()
            .find(|s| s.get("width").and_then(Value::as_u64) == Some(300))
            .or_else(|| sources.first())
            .and_then(|s| s.get("url")?.as_str().map(str::to_owned))
    });
    Some(RemoteTrack {
        id: if local { None } else { str_at(data, "/uri").strip_prefix("spotify:track:").map(str::to_owned) },
        title: str_at(data, "/name"),
        artists: names("/artists/items"),
        album: str_at(data, "/albumOfTrack/name"),
        isrc: None,
        duration_ms: data.pointer("/trackDuration/totalMilliseconds").and_then(Value::as_u64).unwrap_or(0),
        cover,
    })
}

/// The embed page's list: id, title, artists and length only.
fn embed_tracks(entity: &Value) -> Vec<RemoteTrack> {
    entity
        .get("trackList")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter(|t| t.get("entityType").and_then(Value::as_str).is_none_or(|kind| kind == "track"))
                .map(|t| RemoteTrack {
                    id: str_at(t, "/uri").strip_prefix("spotify:track:").map(str::to_owned),
                    title: str_at(t, "/title"),
                    artists: str_at(t, "/subtitle")
                        .split(',')
                        .map(|a| a.trim_matches(|c: char| c.is_whitespace() || c == '\u{a0}').to_owned())
                        .filter(|a| !a.is_empty())
                        .collect(),
                    album: String::new(),
                    isrc: None,
                    duration_ms: t.get("duration").and_then(Value::as_u64).unwrap_or(0),
                    cover: None,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Stands in for a revision when only the embed page could be read: it
/// changes when the tracks do.
fn fingerprint(tracks: &[RemoteTrack]) -> String {
    let mut hasher = blake3::Hasher::new();
    for t in tracks {
        hasher.update(t.id.as_deref().unwrap_or(&t.title).as_bytes());
        hasher.update(b"\n");
    }
    format!("embed:{}", &hasher.finalize().to_hex()[..16])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_track_and_skips_an_episode() {
        let item = json!({ "itemV2": { "data": {
            "__typename": "Track",
            "uri": "spotify:track:1GjbTNFImFrjFsNdleDe78",
            "name": "Never Tear Us Apart",
            "artists": { "items": [{ "profile": { "name": "INXS" } }] },
            "albumOfTrack": { "name": "Kick", "coverArt": { "sources": [
                { "url": "https://i.scdn.co/640", "width": 640 }, { "url": "https://i.scdn.co/300", "width": 300 } ] } },
            "trackDuration": { "totalMilliseconds": 184_586 },
        } } });
        let t = track(&item).unwrap();
        assert_eq!(t.id.as_deref(), Some("1GjbTNFImFrjFsNdleDe78"));
        assert_eq!((t.title.as_str(), t.artists.as_slice(), t.album.as_str()), ("Never Tear Us Apart", &["INXS".to_owned()][..], "Kick"));
        assert_eq!(t.duration_sec(), 185);
        assert_eq!(t.cover.as_deref(), Some("https://i.scdn.co/300"));
        assert!(track(&json!({ "itemV2": { "data": { "__typename": "Episode" } } })).is_none());
    }

    /// Over the network, against Spotify: `cargo test -p deckhand-server -- --ignored public`.
    #[tokio::test]
    #[ignore = "reads Spotify"]
    async fn reads_a_long_editorial_playlist_without_an_account() {
        let public = Public::new(reqwest::Client::new());
        let id = "37i9dQZF1DX4UtSsGT1Sbe"; // All Out 80s: 150 tracks.
        let info = public.info(id).await.unwrap();
        assert_eq!(info.name, "All Out 80s");
        assert!(!info.snapshot_id.is_empty());
        assert!(info.tracks > EMBED_CAP, "{}", info.tracks);
        // Read in pages past what the embed page lists. (Spotify serves an
        // editorial playlist in versions, each with its own revision.)
        let read = public.playlist(id).await.unwrap();
        assert!(read.tracks.len() > EMBED_CAP, "{}", read.tracks.len());
        assert!(!read.snapshot_id.is_empty());
        let paged = public.playlist_in_pages(id, 40).await.unwrap();
        assert_eq!(paged.tracks.len(), read.tracks.len());
        assert!(read.tracks.iter().all(|t| t.id.is_some() && !t.artists.is_empty() && t.duration_ms > 0));
        assert!(public.info("0000000000000000000000").await.unwrap_err().is::<Gone>());
    }

    #[test]
    fn reads_the_embed_pages_list() {
        let page = r#"<html><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"state":{"data":{"entity":{"name":"Set","trackList":[{"uri":"spotify:track:abc","title":"One","subtitle":"A, B","duration":200000,"entityType":"track"}]}}}}}}</script></html>"#;
        let data = next_data(page).unwrap();
        let tracks = embed_tracks(data.pointer("/props/pageProps/state/data/entity").unwrap());
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].artists, vec!["A".to_owned(), "B".to_owned()]);
        assert_eq!(tracks[0].id.as_deref(), Some("abc"));
    }
}
