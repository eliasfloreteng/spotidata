//! The library as the server publishes it at `GET /api/library`.
//!
//! The music folder on the server is the source of truth (Syncthing keeps the
//! same folder on the stick). Everything the stick's player databases need
//! that is not in the audio files themselves (analysis, artwork, metadata)
//! travels with the manifest, so the phone can build the export offline.

use serde::{Deserialize, Serialize};

/// Bumped when the manifest changes shape incompatibly.
pub const FORMAT: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Library {
    pub format: u32,
    /// Changes whenever anything a sync would write changes.
    pub generation: String,
    /// Regular, non-hidden files of the music folder: audio and `.m3u8`.
    pub files: Vec<File>,
    pub tracks: Vec<Track>,
    pub playlists: Vec<Playlist>,
    /// Files the server saw and that have since been deleted there. The
    /// phone removes a stick file only when it matches one of these, so a
    /// file added on another Syncthing peer is never deleted by mistake.
    pub tombstones: Vec<Tombstone>,
    pub status: Status,
}

/// One file of the music folder, as Syncthing would mirror it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct File {
    /// File name; the folder is flat.
    pub name: String,
    pub size: u64,
    /// Modification time, milliseconds since the epoch.
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    /// File name in the music folder.
    pub file: String,
    /// BLAKE3 of the audio.
    pub hash: String,
    /// `None` until the server has analysed the track.
    pub analysis: Option<Analysis>,
    pub artwork: Option<Artwork>,
    /// Why the server could not analyse it, when it could not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// What the export writes for this track. `source_path`, `analysis` and
    /// `analysis_source` are empty: the phone fills them in from the stick
    /// and its blob cache.
    pub source: rbl_export::SourceTrack,
}

/// The track's ANLZ files, by blob hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Analysis {
    pub origin: Origin,
    pub dat: String,
    pub ext: Option<String>,
    #[serde(rename = "2ex")]
    pub two_ex: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    /// rekordbox analysed it (and the cues are yours).
    Rekordbox,
    /// The server analysed it with rbxport's analyser.
    Rbxport,
}

/// The cover at the two sizes a stick holds, as JPEG blob hashes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Artwork {
    /// 80×80.
    pub small: String,
    /// 240×240.
    pub medium: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Playlist {
    pub name: String,
    /// File names of the tracks, in order. Entries the folder does not hold
    /// are left out.
    pub tracks: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tombstone {
    pub name: String,
    pub size: u64,
    pub deleted_ms: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Status {
    pub tracks: usize,
    /// Tracks waiting for (or in) analysis.
    pub analysing: usize,
    /// Tracks whose analysis failed; they sync without waveforms.
    pub failed: usize,
    /// Tracks whose analysis came from rekordbox.
    pub from_rekordbox: usize,
    /// When rekordbox's library was last uploaded, ms since the epoch.
    pub rekordbox_snapshot_ms: Option<i64>,
}

/// Whether a name is one of the audio formats players read.
#[must_use]
pub fn is_audio(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".flac", ".mp3", ".m4a", ".aac", ".aiff", ".aif", ".wav", ".alac"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// Whether a file of the music folder belongs in the mirror: not hidden, not
/// a Syncthing or download temporary.
#[must_use]
pub fn is_mirrored(name: &str) -> bool {
    !name.starts_with('.')
        && !name.starts_with("~syncthing~")
        && !name.ends_with(".part")
        && !name.ends_with(".tmp")
}
