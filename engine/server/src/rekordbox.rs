//! rekordbox's own analysis and cues, from an uploaded snapshot of the Mac's
//! library. A track rekordbox analysed goes to the stick with rekordbox's
//! grid, waveforms and cues; the rest get rbxport's analysis.
//!
//! The snapshot also gives the stick its owner: the library's DBID and each
//! track's content id, as rekordbox and rbxport's desktop export write them.
//! A stick they synced is continued rather than refused, and its tracks keep
//! their player ids.
//!
//! The snapshot is a tar of `options.json` (rekordboxAgent's, for the
//! database key), `master.db` (and `-wal`), and the `share/` tree's
//! `PIONEER/USBANLZ`. See `scripts/upload-rekordbox.sh`.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{anyhow, Context, Result};
use deckhand_model::{Analysis, Origin};
use rbl_export::SourceTrack;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::blobs::Blobs;
use crate::store::Store;

/// What rekordbox knows about one file that the file's tags do not.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Facts {
    /// `djmdContent.ID`.
    #[serde(default)]
    pub content_id: u64,
    pub bpm_x100: u32,
    pub key: String,
    pub length_sec: u32,
    pub rating: u8,
    pub color_id: u8,
    pub metadata: rbl_core::ExportMetadata,
    pub cues: Vec<rbl_anlz::cues::ExportCue>,
    /// `None` when rekordbox has not analysed the track: the server does.
    pub analysis: Option<Analysis>,
}

impl Facts {
    /// The track as tagged, with rekordbox's identity, cues and (when it
    /// has one) analysis on top.
    pub fn apply(&self, source: &mut SourceTrack) {
        source.id = self.content_id;
        if self.analysis.is_some() {
            source.bpm_x100 = self.bpm_x100;
            if !self.key.is_empty() {
                source.key.clone_from(&self.key);
            }
            if self.length_sec > 0 {
                source.duration_sec = u16::try_from(self.length_sec).unwrap_or(u16::MAX);
            }
        }
        source.rating = self.rating;
        source.color_id = self.color_id;
        let (track_number, bit_depth, analysed) =
            (source.metadata.track_number, source.metadata.bit_depth, source.metadata.analysed);
        source.metadata = self.metadata.clone();
        if self.analysis.is_none() {
            source.metadata.analysed = analysed;
        }
        if source.metadata.track_number == 0 {
            source.metadata.track_number = track_number;
        }
        if source.metadata.bit_depth == 0 {
            source.metadata.bit_depth = bit_depth;
        }
        source.cues = Some(self.cues.clone());
    }
}

/// Unpacks a snapshot and records what it says about each file name.
pub fn ingest(archive: &Path, work: &Path, store: &Store, blobs: &Blobs) -> Result<usize> {
    let dir = tempfile::tempdir_in(work)?;
    let mut tar = tar::Archive::new(std::fs::File::open(archive)?);
    // `unpack` refuses entries that would land outside the directory.
    tar.unpack(dir.path()).context("unpacking the snapshot")?;
    let root = dir.path();

    let mut location = rbl_db::detect_from(&root.join("options.json")).map_err(|e| anyhow!("{e}"))?;
    location.master_db = root.join("master.db");
    location.share_root = root.join("share");
    location.is_real_install = false;
    // Read-write on this private copy, so SQLite can replay the WAL.
    let db = rbl_db::Library::open(location.clone(), rbl_db::OpenMode::ReadWrite).map_err(|e| anyhow!("{e}"))?;
    let conn = db.connection();

    let mut by_id: HashMap<String, (String, u8, u8)> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT ID, FolderPath, Rating, ColorID FROM djmdContent WHERE coalesce(rb_local_deleted, 0) = 0",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                number(r.get_ref(2)?),
                number(r.get_ref(3)?),
            ))
        })?;
        for row in rows {
            let (id, path, rating, color) = row?;
            // Composed, as `Store::rekordbox_facts` looks it up: rekordbox keeps
            // a path in whichever form macOS gave it, decomposed or not.
            let name = crate::store::name_key(path.rsplit(['/', '\\']).next().unwrap_or_default());
            if !id.is_empty() && !name.is_empty() {
                by_id.insert(id, (name, u8::try_from(rating).unwrap_or(0), u8::try_from(color).unwrap_or(0)));
            }
        }
    }
    let db_id = rbl_db::export_info::db_id(conn).map_err(|e| anyhow!("{e}"))?;
    let cloud_db_id = rbl_db::export_info::cloud_db_id(conn).map_err(|e| anyhow!("{e}"))?;
    let ids: Vec<String> = by_id.keys().cloned().collect();
    let extras = rbl_db::export_info::track_extras(conn, &ids).map_err(|e| anyhow!("{e}"))?;

    let mut facts: HashMap<String, Facts> = HashMap::new();
    for (id, (name, rating, color_id)) in by_id {
        let Some(extra) = extras.get(&id) else { continue };
        let Ok(content_id) = id.parse::<u64>() else { continue };
        let analysed = extra.analysis.as_ref().filter(|a| !a.analysis_path.is_empty());
        let analysis = analysed.and_then(|analysed| {
            let dat_path = location.share_root.join(analysed.analysis_path.trim_start_matches(['/', '\\']));
            let read = |ext: &str| -> Option<String> {
                let bytes = std::fs::read(dat_path.with_extension(ext)).ok()?;
                rbl_anlz::parse(&bytes).ok()?;
                blobs.put(&bytes).ok()
            };
            let dat = read("DAT");
            if dat.is_none() {
                warn!(%name, "rekordbox analysis file missing from the snapshot");
            }
            Some(Analysis { origin: Origin::Rekordbox, dat: dat?, ext: read("EXT"), two_ex: read("2EX") })
        });
        let entry = Facts {
            content_id,
            bpm_x100: analysed.map_or(0, |a| a.bpm_x100),
            key: analysed.map(|a| a.key.clone()).unwrap_or_default(),
            length_sec: analysed.map_or(0, |a| a.length_sec),
            rating,
            color_id,
            metadata: extra.metadata.clone(),
            cues: extra.cues.clone(),
            analysis,
        };
        // The same file imported twice: keep the analysed one, then the one
        // with more cues.
        let rank = |f: &Facts| (f.analysis.is_some(), f.cues.len());
        match facts.get(&name) {
            Some(existing) if rank(existing) >= rank(&entry) => {}
            _ => {
                facts.insert(name, entry);
            }
        }
    }
    let count = facts.len();
    let rows: Vec<(String, String)> =
        facts.iter().map(|(name, f)| Ok((name.clone(), serde_json::to_string(f)?))).collect::<Result<_>>()?;
    store.replace_rekordbox(&rows)?;
    store.set_meta("rekordbox_db_id", &db_id.to_string())?;
    store.set_meta("rekordbox_cloud_db_id", &cloud_db_id.to_string())?;
    store.set_meta("rekordbox_snapshot_ms", &crate::store::now_ms().to_string())?;
    info!(tracks = count, db_id, "rekordbox snapshot ingested");
    Ok(count)
}

/// rekordbox keeps some numbers as text (`ColorID` is a key into a table).
fn number(value: rusqlite::types::ValueRef<'_>) -> i64 {
    match value {
        rusqlite::types::ValueRef::Integer(n) => n,
        rusqlite::types::ValueRef::Text(t) => std::str::from_utf8(t).ok().and_then(|t| t.trim().parse().ok()).unwrap_or(0),
        _ => 0,
    }
}
