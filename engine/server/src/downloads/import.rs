//! Files sent from the phone: checked, named like a download and filed in
//! the music folder, where they are analysed and go to the stick like one.
//! The file keeps its own tags; it is only added, never over another.

use std::path::Path;

use anyhow::Result;
use deckhand_model::downloads::{CatalogTrack, Imported};
use lofty::file::FileType;
use tracing::info;

use super::{db, place, Service};
use crate::tags;

impl Service {
    /// An empty file to receive an upload in, removed when dropped.
    pub fn staging_file(&self) -> Result<tempfile::NamedTempFile> {
        Ok(tempfile::Builder::new().prefix("import-").suffix(".part").tempfile_in(&self.inner.staging)?)
    }

    /// Files `staged`, which the phone sent as `original`, unless the folder
    /// holds the recording already. The inner error says, for the app, why
    /// the file can't go on the stick.
    pub fn import(&self, staged: &Path, original: &str) -> Result<Result<Imported, String>> {
        let store = &self.inner.store;
        let Ok(probe) = tags::probe(staged) else {
            return Ok(Err(format!("Deckhand can't read {original} as audio.")));
        };
        let Some(ext) = extension(probe.file_type) else {
            return Ok(Err(format!(
                "{original} can't go on the stick: the players take FLAC, AIFF, WAV, MP3 and M4A."
            )));
        };

        let hash = crate::scan::hash_file(staged)?;
        let id = format!("file:{hash}");
        let isrc = tags::isrc(staged);
        // One at a time, so the same file sent twice is filed once.
        let _one = self.inner.importing.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let existing = match store.by_hash(&hash)? {
            Some(file) => Some(file),
            // Sent moments ago: filed, but not yet scanned.
            None => db::files_for(store, &id)?.into_iter().find(|f| self.inner.music.join(f).is_file()),
        };
        let existing = existing.or_else(|| isrc.as_ref().and_then(|isrc| store.isrcs().ok()?.remove(isrc)));
        if let Some(file) = existing {
            info!(%original, %file, "import already in the folder");
            return Ok(Ok(Imported { file, added: false, download: None }));
        }

        // Untagged, it keeps the name it had: often "Artist - Title".
        let named = tags::named(staged)?;
        let stem = original.rsplit_once('.').map_or(original, |(stem, _)| stem);
        let title = if named.title.is_empty() { stem.trim().to_owned() } else { named.title };
        let artists: Vec<String> = Some(named.artist).filter(|a| !a.is_empty()).into_iter().collect();
        let name = place::file_name(&title, &artists, ext);
        let file = place::place(staged, &self.inner.music, &name)?;
        info!(%original, %file, "imported");

        let track = CatalogTrack {
            id,
            title,
            artists,
            album: named.album,
            isrc,
            duration_sec: probe.duration_sec.round() as u32,
            cover: None,
            explicit: false,
            in_library: None,
        };
        let download = db::insert_done(store, &track, &file, "file", &probe.quality())?;
        Ok(Ok(Imported { file, added: true, download: Some(download) }))
    }
}

/// The name a format is filed under; `None` for what the players can't play.
fn extension(file_type: FileType) -> Option<&'static str> {
    match file_type {
        FileType::Flac => Some("flac"),
        FileType::Aiff => Some("aiff"),
        FileType::Wav => Some("wav"),
        FileType::Mpeg => Some("mp3"),
        FileType::Mp4 => Some("m4a"),
        _ => None,
    }
}
