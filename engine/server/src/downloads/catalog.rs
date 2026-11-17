//! The catalog the app searches: Deezer's public API. It needs no account,
//! is up far more than any download source, and gives every track an ISRC,
//! which is what the sources are then asked for.

use std::collections::HashMap;

use anyhow::{bail, Context, Result};
use deckhand_model::downloads::CatalogTrack;
use serde::Deserialize;
use serde_json::Value;

use super::Wanted;

const API: &str = "https://api.deezer.com";

#[derive(Deserialize)]
struct Page {
    #[serde(default)]
    data: Vec<DzTrack>,
}

#[derive(Deserialize)]
struct DzTrack {
    id: u64,
    title: String,
    #[serde(default)]
    isrc: Option<String>,
    #[serde(default)]
    duration: u32,
    #[serde(default)]
    explicit_lyrics: bool,
    #[serde(default = "yes")]
    readable: bool,
    artist: DzArtist,
    album: DzAlbum,
    #[serde(default)]
    contributors: Vec<DzArtist>,
    #[serde(default)]
    track_position: Option<u32>,
    #[serde(default)]
    disk_number: Option<u32>,
    #[serde(default)]
    release_date: Option<String>,
}

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
struct DzArtist {
    name: String,
    #[serde(default)]
    role: Option<String>,
}

#[derive(Deserialize)]
struct DzAlbum {
    id: u64,
    title: String,
    #[serde(default)]
    cover_medium: Option<String>,
    #[serde(default)]
    cover_xl: Option<String>,
}

/// Deezer answers errors with 200 and an `error` object.
async fn get(http: &reqwest::Client, url: &str, query: &[(&str, &str)]) -> Result<Value> {
    let value: Value = http
        .get(url)
        .query(query)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .context("the catalog is unreachable")?
        .error_for_status()?
        .json()
        .await?;
    if let Some(error) = value.get("error") {
        bail!("the catalog refused: {}", error.get("message").and_then(Value::as_str).unwrap_or("unknown error"));
    }
    Ok(value)
}

/// Tracks matching free text, best first. `in_library` is filled in from
/// `library`, the folder's files by ISRC, and `names`, by title and artist.
pub async fn search(
    http: &reqwest::Client,
    query: &str,
    limit: usize,
    library: &HashMap<String, String>,
    names: &LibraryNames,
) -> Result<Vec<CatalogTrack>> {
    let limit = limit.clamp(1, 100).to_string();
    let page: Page =
        serde_json::from_value(get(http, &format!("{API}/search/track"), &[("q", query), ("limit", &limit)]).await?)?;
    Ok(page
        .data
        .into_iter()
        .filter(|t| t.readable)
        .map(|t| {
            let mut track = to_catalog(&t);
            track.in_library = track
                .isrc
                .as_ref()
                .and_then(|isrc| library.get(isrc))
                .cloned()
                .or_else(|| names.find(&track.title, &track.artists));
            track
        })
        .collect())
}

fn to_catalog(t: &DzTrack) -> CatalogTrack {
    let mut artists: Vec<String> = t
        .contributors
        .iter()
        .filter(|a| a.role.as_deref().is_none_or(|r| r.eq_ignore_ascii_case("main")))
        .map(|a| a.name.clone())
        .collect();
    if artists.is_empty() {
        artists.push(t.artist.name.clone());
    }
    CatalogTrack {
        id: format!("deezer:{}", t.id),
        title: t.title.clone(),
        artists,
        album: t.album.title.clone(),
        isrc: t.isrc.as_ref().map(|s| s.trim().to_ascii_uppercase()).filter(|s| !s.is_empty()),
        duration_sec: t.duration,
        cover: t.album.cover_medium.clone(),
        explicit: t.explicit_lyrics,
        in_library: None,
    }
}

/// The catalog's track for an ISRC; `None` when Deezer doesn't have it.
pub async fn by_isrc(http: &reqwest::Client, isrc: &str) -> Result<Option<CatalogTrack>> {
    let isrc = isrc.trim().to_ascii_uppercase();
    if isrc.is_empty() || !isrc.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Ok(None);
    }
    let value = match get(http, &format!("{API}/track/isrc:{isrc}"), &[]).await {
        Ok(value) => value,
        // "no data": the catalog answered and doesn't have it.
        Err(e) if e.to_string().contains("no data") => return Ok(None),
        Err(e) => return Err(e),
    };
    let t: DzTrack = serde_json::from_value(value)?;
    Ok(t.readable.then(|| to_catalog(&t)))
}

/// Everything known about a track before asking the sources for it: the
/// full artist list, album details for the tags, and the big cover.
pub async fn details(http: &reqwest::Client, track: &CatalogTrack) -> Wanted {
    let mut wanted = Wanted::from_catalog(track);
    let Some(id) = track.id.strip_prefix("deezer:") else {
        return wanted;
    };
    let Ok(value) = get(http, &format!("{API}/track/{id}"), &[]).await else {
        return wanted;
    };
    let Ok(t) = serde_json::from_value::<DzTrack>(value) else {
        return wanted;
    };
    let full = to_catalog(&t);
    wanted.artists = full.artists;
    wanted.isrc = wanted.isrc.or(full.isrc);
    if t.duration > 0 {
        wanted.duration_sec = t.duration;
    }
    wanted.meta.track_number = t.track_position;
    wanted.meta.disc_number = t.disk_number;
    wanted.meta.date = t.release_date.unwrap_or_default();
    wanted.cover_url = t.album.cover_xl;
    if let Ok(album) = get(http, &format!("{API}/album/{}", t.album.id), &[]).await {
        wanted.meta.label = album.get("label").and_then(Value::as_str).unwrap_or_default().to_owned();
        wanted.meta.album_artist = album.pointer("/artist/name").and_then(Value::as_str).unwrap_or_default().to_owned();
        wanted.meta.genre = album.pointer("/genres/data/0/name").and_then(Value::as_str).unwrap_or_default().to_owned();
    }
    wanted
}

/// The folder's tracks by normalised title and artists, for files without an
/// ISRC tag.
#[derive(Default)]
pub struct LibraryNames(HashMap<String, Vec<(String, String)>>);

impl LibraryNames {
    pub fn new(tracks: impl IntoIterator<Item = (String, String, String)>) -> Self {
        let mut map: HashMap<String, Vec<(String, String)>> = HashMap::new();
        for (file, title, artist) in tracks {
            // The folder's own naming, "Title - Artist, Artist.flac", for a
            // file whose tags say less (some have none at all).
            let stem = file.rsplit_once('.').map_or(file.as_str(), |(stem, _)| stem);
            if let Some((t, a)) = stem.rsplit_once(" - ") {
                if (normalise(t), normalise(a)) != (normalise(&title), normalise(&artist)) {
                    map.entry(normalise(t)).or_default().push((normalise(a), file.clone()));
                }
            }
            map.entry(normalise(&title)).or_default().push((normalise(&artist), file));
        }
        Self(map)
    }

    /// The file whose title matches and whose artists include the first one.
    pub fn find(&self, title: &str, artists: &[String]) -> Option<String> {
        let first = normalise(artists.first()?);
        self.0
            .get(&normalise(title))?
            .iter()
            .find(|(artist, _)| !first.is_empty() && artist.contains(&first))
            .map(|(_, file)| file.clone())
    }
}

/// Lower case, letters and digits only: "9Pm (Till I Come)" → "9pmtillicome".
pub fn normalise(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_match_by_title_and_first_artist() {
        let names = LibraryNames::new([(
            "9Pm (Till I Come) - ATB.flac".to_owned(),
            "9Pm (Till I Come)".to_owned(),
            "ATB".to_owned(),
        )]);
        assert_eq!(
            names.find("9PM (Till I Come)", &["ATB".to_owned()]).as_deref(),
            Some("9Pm (Till I Come) - ATB.flac")
        );
        assert_eq!(names.find("9PM (Till I Come) - Extended", &["ATB".to_owned()]), None);
        assert_eq!(names.find("9PM (Till I Come)", &["Someone".to_owned()]), None);
    }

    #[test]
    fn untagged_files_match_by_their_name() {
        let names = LibraryNames::new([
            ("CODE - Nedaj.flac".to_owned(), "CODE - Nedaj".to_owned(), String::new()),
            (
                "I Want Your Soul - Prospa Remix - Armand Van Helden, Prospa.flac".to_owned(),
                "I Want Your Soul - Prospa Remix - Armand Van Helden, Prospa".to_owned(),
                String::new(),
            ),
        ]);
        assert_eq!(names.find("CODE", &["Nedaj".to_owned()]).as_deref(), Some("CODE - Nedaj.flac"));
        assert!(names.find("I Want Your Soul - Prospa Remix", &["Armand Van Helden".to_owned()]).is_some());
        assert_eq!(names.find("CODE - Nedaj", &["Someone".to_owned()]), None);
    }
}
