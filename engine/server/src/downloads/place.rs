//! Moves a finished download into the music folder without ever touching a
//! file that is already there.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// "Title - Artist, Artist.flac", the folder's naming, safe on the stick's
/// exFAT/FAT32 and within its 255-byte name limit.
pub fn file_name(title: &str, artists: &[String], ext: &str) -> String {
    let clean = |s: &str| -> String {
        let s: String = s
            .chars()
            .map(|c| match c {
                '/' | '\\' | '|' => '-',
                ':' => '-',
                '"' => '\'',
                '*' | '?' | '<' | '>' => '_',
                c if c.is_control() => ' ',
                c => c,
            })
            .collect();
        s.split_whitespace().collect::<Vec<_>>().join(" ")
    };
    let mut title = clean(title);
    let artist = clean(&artists.join(", "));
    let suffix = format!(" - {artist}.{ext}");
    // Keep the artist; shorten the title if the name would be too long.
    let budget = 240usize.saturating_sub(suffix.len()).max(40);
    if title.len() > budget {
        let mut cut = budget;
        while !title.is_char_boundary(cut) {
            cut -= 1;
        }
        title.truncate(cut);
        title = title.trim_end().to_owned();
    }
    let name = format!("{title}{suffix}");
    // A leading dot would hide it from the scan and the stick.
    name.trim_start_matches('.').to_owned()
}

/// Copies `staged` into `music` under `name` (or "name (2)" if taken) and
/// returns the name it got. Written as a Syncthing temporary first, so
/// neither Syncthing nor the scanner sees a half-written file.
pub fn place(staged: &Path, music: &Path, name: &str) -> Result<String> {
    let tmp = music.join(format!(".syncthing.{name}.tmp"));
    std::fs::copy(staged, &tmp).with_context(|| format!("copying into {}", music.display()))?;
    std::fs::File::open(&tmp)?.sync_all()?;
    let (stem, ext) = name.rsplit_once('.').unwrap_or((name, ""));
    let result = (1..100).find_map(|n| {
        let candidate = if n == 1 { name.to_owned() } else { format!("{stem} ({n}).{ext}") };
        let target: PathBuf = music.join(&candidate);
        // A hard link fails if the name exists, unlike a rename.
        match std::fs::hard_link(&tmp, &target) {
            Ok(()) => Some(Ok(candidate)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => None,
            Err(e) => Some(Err(anyhow::Error::from(e).context("moving into the music folder"))),
        }
    });
    let _ = std::fs::remove_file(&tmp);
    result.unwrap_or_else(|| Err(anyhow::anyhow!("{name} and 98 variants are all taken")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_stick_safe() {
        assert_eq!(
            file_name(
                "4 Minutes (feat. Justin Timberlake & Timbaland)",
                &["Madonna".into(), "Timbaland".into()],
                "flac"
            ),
            "4 Minutes (feat. Justin Timberlake & Timbaland) - Madonna, Timbaland.flac"
        );
        assert_eq!(file_name("AC/DC: Live?", &["A".into()], "flac"), "AC-DC- Live_ - A.flac");
        assert_eq!(file_name("...Ready", &["A".into()], "flac"), "Ready - A.flac");
        let long = "x".repeat(400);
        assert!(file_name(&long, &["A".into()], "flac").len() <= 255);
    }

    #[test]
    fn never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let music = dir.path().join("music");
        std::fs::create_dir(&music).unwrap();
        std::fs::write(music.join("a - b.flac"), b"old").unwrap();
        let staged = dir.path().join("staged");
        std::fs::write(&staged, b"new").unwrap();
        let name = place(&staged, &music, "a - b.flac").unwrap();
        assert_eq!(name, "a - b (2).flac");
        assert_eq!(std::fs::read(music.join("a - b.flac")).unwrap(), b"old");
        assert_eq!(std::fs::read(music.join(&name)).unwrap(), b"new");
        assert_eq!(std::fs::read_dir(&music).unwrap().count(), 2, "no temporary left behind");
    }
}
