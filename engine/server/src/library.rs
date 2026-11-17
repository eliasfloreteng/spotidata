//! Builds the manifest the phone syncs from.

use std::collections::HashSet;
use std::path::Path;

use anyhow::Result;
use deckhand_model::{is_audio, File, Library, Playlist, Status, Tombstone, Track, FORMAT};
use rbl_export::SourceTrack;

use crate::store::{State, Store};

pub fn build(music: &Path, store: &Store) -> Result<Library> {
    let rows = store.all()?;
    let audio: HashSet<&str> = rows.iter().filter(|r| is_audio(&r.name)).map(|r| r.name.as_str()).collect();
    let mut status = Status::default();
    let mut tracks = Vec::new();
    let mut playlists = Vec::new();
    for row in &rows {
        if row.state == State::Other {
            if row.name.to_ascii_lowercase().ends_with(".m3u8") || row.name.to_ascii_lowercase().ends_with(".m3u") {
                if let Ok(text) = std::fs::read(music.join(&row.name)) {
                    let name = row.name.rsplit_once('.').map_or(row.name.as_str(), |(stem, _)| stem).to_owned();
                    playlists.push(Playlist { name, tracks: parse_m3u(&String::from_utf8_lossy(&text), &audio) });
                }
            }
            continue;
        }
        status.tracks += 1;
        match row.state {
            State::Pending => status.analysing += 1,
            State::Failed => status.failed += 1,
            _ => {}
        }
        if row.analysis.as_ref().is_some_and(|a| a.origin == deckhand_model::Origin::Rekordbox) {
            status.from_rekordbox += 1;
        }
        let mut source: SourceTrack = row
            .source
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_else(|| SourceTrack {
                title: row.name.rsplit_once('.').map_or(row.name.as_str(), |(s, _)| s).to_owned(),
                cues: Some(Vec::new()),
                ..SourceTrack::default()
            });
        // Added = when it first landed in the folder.
        let added = row.mtime_ms.min(row.first_seen_ms);
        source.date_added = chrono::DateTime::from_timestamp_millis(added)
            .map(|d| d.format("%Y-%m-%d").to_string())
            .unwrap_or_default();
        source.file_size = row.size;
        tracks.push(Track {
            file: row.name.clone(),
            hash: row.hash.clone(),
            analysis: row.analysis.clone(),
            artwork: row.artwork.clone(),
            error: if row.state == State::Failed { row.error.clone() } else { None },
            source,
        });
    }
    playlists.sort_by(|a, b| natural_cmp(&a.name, &b.name));
    let files: Vec<File> =
        rows.iter().map(|r| File { name: r.name.clone(), size: r.size, mtime_ms: r.mtime_ms }).collect();
    let tombstones: Vec<Tombstone> = store
        .tombstones()?
        .into_iter()
        .map(|t| Tombstone { name: t.name, size: t.size, deleted_ms: t.deleted_ms })
        .collect();
    status.rekordbox_snapshot_ms = store.meta("rekordbox_snapshot_ms")?.and_then(|v| v.parse().ok());

    let mut hasher = blake3::Hasher::new();
    hasher.update(serde_json::to_string(&(&files, &tracks, &playlists))?.as_bytes());
    let generation = hasher.finalize().to_hex()[..16].to_owned();
    Ok(Library { format: FORMAT, generation, files, tracks, playlists, tombstones, status })
}

/// The entries of an M3U playlist that the folder holds, by file name.
pub fn parse_m3u(text: &str, present: &HashSet<&str>) -> Vec<String> {
    text.lines()
        .map(|l| l.trim().trim_start_matches('\u{feff}'))
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| l.rsplit(['/', '\\']).next().unwrap_or(l))
        .filter(|name| present.contains(name))
        .map(str::to_owned)
        .collect()
}

/// "Set 2" before "Set 10".
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    fn chunks(s: &str) -> Vec<(bool, String)> {
        let mut out: Vec<(bool, String)> = Vec::new();
        for c in s.chars() {
            let digit = c.is_ascii_digit();
            match out.last_mut() {
                Some((d, chunk)) if *d == digit => chunk.push(c),
                _ => out.push((digit, c.to_string())),
            }
        }
        out
    }
    let (ca, cb) = (chunks(&a.to_lowercase()), chunks(&b.to_lowercase()));
    for ((da, sa), (db, sb)) in ca.iter().zip(cb.iter()) {
        let ord = if *da && *db {
            sa.trim_start_matches('0').len().cmp(&sb.trim_start_matches('0').len()).then_with(|| sa.cmp(sb))
        } else {
            sa.cmp(sb)
        };
        if ord != std::cmp::Ordering::Equal {
            return ord;
        }
    }
    ca.len().cmp(&cb.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn m3u_keeps_known_files_in_order() {
        let present: HashSet<&str> = ["a.flac", "b - x.flac"].into_iter().collect();
        let text = "\u{feff}#EXTM3U\n#EXTINF:1,x\nb - x.flac\nmissing.flac\n../music/a.flac\r\n";
        assert_eq!(parse_m3u(text, &present), vec!["b - x.flac", "a.flac"]);
    }

    #[test]
    fn natural_order() {
        let mut v = vec!["Set 10", "Set 2", "House", "Set 01"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["House", "Set 01", "Set 2", "Set 10"]);
    }
}
