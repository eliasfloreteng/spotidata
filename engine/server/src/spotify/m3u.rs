//! Writes a kept playlist into the music folder as `<Name>.m3u8`, the same
//! file the old Spotify downloader wrote, so the playlists it left carry on
//! under the same names.

use std::path::Path;

use anyhow::{Context, Result};

/// "Rally/plucks" → "Rally_plucks.m3u8": safe on the stick's exFAT/FAT32.
pub fn file_name(playlist: &str) -> String {
    let clean: String = playlist
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let mut stem = clean.split_whitespace().collect::<Vec<_>>().join(" ").trim_start_matches('.').to_owned();
    if stem.is_empty() {
        stem = "Playlist".to_owned();
    }
    // Within the 255-byte name limit, with room for " (2)" and the extension.
    if stem.len() > 200 {
        let mut cut = 200;
        while !stem.is_char_boundary(cut) {
            cut -= 1;
        }
        stem.truncate(cut);
    }
    format!("{stem}.m3u8")
}

/// One entry: the file, and what the players show before reading its tags.
pub struct Entry<'a> {
    pub file: &'a str,
    pub duration_sec: u32,
    pub artists: &'a [String],
    pub title: &'a str,
}

pub fn render(entries: &[Entry<'_>]) -> String {
    let mut out = String::from("#EXTM3U\n");
    for e in entries {
        let label = format!("{} - {}", e.artists.join(", "), e.title).replace(['\r', '\n'], " ");
        out.push_str(&format!("#EXTINF:{},{label}\n{}\n", e.duration_sec, e.file));
    }
    out
}

pub fn hash(text: &str) -> String {
    blake3::hash(text.as_bytes()).to_hex()[..32].to_owned()
}

/// Writes `text` as `name` unless the file already says exactly that.
/// Returns whether it wrote. A Syncthing temporary renamed into place, so
/// nothing ever reads half a playlist.
pub fn write(music: &Path, name: &str, text: &str) -> Result<bool> {
    let target = music.join(name);
    if std::fs::read(&target).is_ok_and(|old| old == text.as_bytes()) {
        return Ok(false);
    }
    let tmp = music.join(format!(".syncthing.{name}.tmp"));
    std::fs::write(&tmp, text).with_context(|| format!("writing {name}"))?;
    std::fs::File::open(&tmp)?.sync_all()?;
    std::fs::rename(&tmp, &target).with_context(|| format!("moving {name} into place"))?;
    Ok(true)
}

/// The files a playlist file lists; none when it can't be read.
pub fn files(path: &Path) -> std::collections::HashSet<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_owned)
        .collect()
}

/// Deletes a playlist file the server wrote, unless it was changed since
/// (`hash` is what was written). Returns whether it is gone.
pub fn remove(music: &Path, name: &str, written: Option<&str>) -> Result<bool> {
    let target = music.join(name);
    match std::fs::read(&target) {
        Ok(bytes) => {
            if written != Some(hash(&String::from_utf8_lossy(&bytes)).as_str()) {
                return Ok(false);
            }
            std::fs::remove_file(&target)?;
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_match_the_old_downloader() {
        assert_eq!(file_name("Rally/plucks"), "Rally_plucks.m3u8");
        assert_eq!(file_name("Kräftis & Svettis "), "Kräftis & Svettis.m3u8");
        assert_eq!(file_name("Set 01"), "Set 01.m3u8");
        assert_eq!(file_name("..."), "Playlist.m3u8");
    }

    #[test]
    fn renders_extm3u() {
        let artists = vec!["The Blessed Madonna".to_owned(), "Uffie".to_owned()];
        let text = render(&[Entry {
            file: "Serotonin Moonbeams - The Blessed Madonna, Uffie.flac",
            duration_sec: 287,
            artists: &artists,
            title: "Serotonin Moonbeams",
        }]);
        assert_eq!(
            text,
            "#EXTM3U\n#EXTINF:287,The Blessed Madonna, Uffie - Serotonin Moonbeams\nSerotonin Moonbeams - The Blessed Madonna, Uffie.flac\n"
        );
    }

    #[test]
    fn writes_only_changes_and_removes_only_its_own() {
        let dir = tempfile::tempdir().unwrap();
        assert!(write(dir.path(), "A.m3u8", "#EXTM3U\n").unwrap());
        assert!(!write(dir.path(), "A.m3u8", "#EXTM3U\n").unwrap());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "no temporary left behind");
        // Edited by hand since: kept.
        std::fs::write(dir.path().join("A.m3u8"), "#EXTM3U\nmine.flac\n").unwrap();
        assert!(!remove(dir.path(), "A.m3u8", Some(&hash("#EXTM3U\n"))).unwrap());
        assert!(dir.path().join("A.m3u8").exists());
        assert!(remove(dir.path(), "A.m3u8", Some(&hash("#EXTM3U\nmine.flac\n"))).unwrap());
        assert!(!dir.path().join("A.m3u8").exists());
    }
}
