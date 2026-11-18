//! A playlist named by what you paste: a Spotify link, a `spotify:` URI or
//! a bare id. The app's share links (`spotify.link/…`) are short links that
//! are followed to the playlist they open.

use std::time::Duration;

use anyhow::{bail, Context, Result};

/// The playlist id in `text`, without asking anyone; `None` for a short
/// link, or for what names no playlist.
pub fn parse(text: &str) -> Option<String> {
    let text = text.trim();
    if is_id(text) {
        return Some(text.to_owned());
    }
    // `open.spotify.com/playlist/{id}?si=…`, `…/intl-de/playlist/{id}`,
    // `…/user/{name}/playlist/{id}`, `spotify:playlist:{id}`,
    // `spotify:user:{name}:playlist:{id}`; in a longer text too.
    for (at, _) in text.match_indices("playlist") {
        let rest = &text[at + "playlist".len()..];
        let Some(rest) = rest.strip_prefix('/').or_else(|| rest.strip_prefix(':')) else { continue };
        let id: String = rest.chars().take_while(char::is_ascii_alphanumeric).collect();
        if is_id(&id) {
            return Some(id);
        }
    }
    None
}

/// A short link the Spotify app shares, to be followed.
pub fn short(text: &str) -> Option<reqwest::Url> {
    let url = text.split_whitespace().find_map(|word| reqwest::Url::parse(word).ok())?;
    let host = url.host_str()?;
    (matches!(url.scheme(), "https" | "http") && is_short_host(host)).then_some(url)
}

fn is_short_host(host: &str) -> bool {
    matches!(host, "spotify.link" | "spotify.app.link")
}

/// The playlist a short link opens: where it redirects, else the link in
/// the page it serves.
pub async fn follow(http: &reqwest::Client, url: reqwest::Url) -> Result<Option<String>> {
    let response = http
        .get(url)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .context("Spotify's short link could not be followed")?;
    if let Some(id) = parse(response.url().as_str()) {
        return Ok(Some(id));
    }
    if !response.status().is_success() {
        bail!("Spotify's short link answered {}", response.status());
    }
    // A link it doesn't know goes to Spotify's home page, which links to
    // playlists of its own.
    if !response.url().host_str().is_some_and(is_short_host) {
        return Ok(None);
    }
    let page = response.text().await.unwrap_or_default();
    Ok(page.match_indices("open.spotify.com/").find_map(|(at, _)| {
        let end = page[at..].find(['"', '\'', '<', ' ', '\n']).map_or(page.len(), |n| at + n);
        parse(&page[at..end])
    }))
}

/// Spotify's ids are 22 characters of base 62.
fn is_id(text: &str) -> bool {
    text.len() == 22 && text.chars().all(|c| c.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "37i9dQZF1DXcBWIGoYBM5M";

    #[test]
    fn finds_the_id() {
        for text in [
            ID,
            "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
            "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=0a1b2c3d4e5f",
            " open.spotify.com/intl-sv/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x\n",
            "https://open.spotify.com/user/someone/playlist/37i9dQZF1DXcBWIGoYBM5M",
            "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M",
            "spotify:user:someone:playlist:37i9dQZF1DXcBWIGoYBM5M",
            "Listen to Today's Top Hits on Spotify: https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
        ] {
            assert_eq!(parse(text).as_deref(), Some(ID), "{text}");
        }
    }

    #[test]
    fn refuses_what_is_no_playlist() {
        for text in [
            "",
            "hello",
            "https://open.spotify.com/album/37i9dQZF1DXcBWIGoYBM5M",
            "https://open.spotify.com/track/37i9dQZF1DXcBWIGoYBM5M",
            "https://open.spotify.com/playlist/short",
            "https://spotify.link/AbCdEfGhIjK",
        ] {
            assert_eq!(parse(text), None, "{text}");
        }
    }

    #[test]
    fn knows_short_links() {
        assert!(short("https://spotify.link/AbCdEfGhIjK").is_some());
        assert!(short("Check this out https://spotify.app.link/AbCdEf?_p=1").is_some());
        assert!(short("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M").is_none());
    }
}
