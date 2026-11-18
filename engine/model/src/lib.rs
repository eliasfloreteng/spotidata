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
    /// The rekordbox library the tracks' ids come from, once a snapshot was
    /// uploaded. A stick rekordbox or rbxport synced from it is continued.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rekordbox: Option<RekordboxLibrary>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RekordboxLibrary {
    /// `djmdProperty.DBID`.
    pub db_id: u64,
    /// The Cloud Library Sync id, 0 for none.
    pub cloud_db_id: u32,
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

/// Getting music: a catalog to search, and downloads the server runs into
/// the music folder (`/api/catalog/search`, `/api/downloads`).
pub mod downloads {
    use serde::{Deserialize, Serialize};

    /// A track the catalog knows, which may or may not be in the folder yet.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct CatalogTrack {
        /// `deezer:<id>`.
        pub id: String,
        pub title: String,
        pub artists: Vec<String>,
        pub album: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub isrc: Option<String>,
        pub duration_sec: u32,
        /// A cover around 250 px.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub cover: Option<String>,
        #[serde(default)]
        pub explicit: bool,
        /// The file in the music folder that already holds this recording.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub in_library: Option<String>,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub enum State {
        Queued,
        /// Asking the sources who has it.
        Searching,
        Downloading,
        /// Checking, tagging and moving the file into the folder.
        Finishing,
        /// Only a source behind a check you solve in the app has it left;
        /// it starts again once you have.
        Waiting,
        Done,
        Failed,
        Cancelled,
    }

    impl State {
        /// Still to finish: queued, running, or waiting for you.
        #[must_use]
        pub fn is_active(self) -> bool {
            matches!(self, Self::Queued | Self::Searching | Self::Downloading | Self::Finishing | Self::Waiting)
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct Download {
        pub id: i64,
        pub track: CatalogTrack,
        pub state: State,
        /// The source being tried, or the one that delivered the file.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub source: Option<String>,
        /// Bytes so far and, when known, in all.
        #[serde(default)]
        pub received: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub total: Option<u64>,
        /// "FLAC 16-bit 44.1 kHz".
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub quality: Option<String>,
        /// The file in the music folder, once done.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub file: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub error: Option<String>,
        /// Every source tried, in order.
        #[serde(default)]
        pub attempts: Vec<Attempt>,
        /// The Spotify playlist it was got for; `None` when you asked for it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub playlist: Option<String>,
        pub created_ms: i64,
        pub updated_ms: i64,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct Attempt {
        pub source: String,
        pub outcome: Outcome,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        pub detail: String,
        pub ms: u64,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum Outcome {
        Ok,
        /// The source answered but does not have the track.
        NotFound,
        /// Down, timed out, refused, or too slow to wait for.
        Unavailable,
        /// It sent something that is not the track (a preview, a lossy or
        /// wrong-length file).
        BadFile,
        /// It has the track but wants a check solved in the app first.
        NeedsYou,
    }

    /// How one mirror of one source has been doing.
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    pub struct SourceHealth {
        /// `tidal:example.org`.
        pub id: String,
        /// `tidal`, `qobuz`, `deezer`, `amazon`.
        pub source: String,
        pub host: String,
        /// Order the next download tries them in, from 1.
        pub rank: usize,
        /// Recent share of requests that worked, 0–1.
        pub reliability: f64,
        /// Recent download speed, kB/s; `None` before the first download.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub speed_kbps: Option<f64>,
        /// Recent time to answer, ms.
        pub latency_ms: f64,
        pub downloads: u64,
        /// Resting after failures until then, ms since the epoch.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub resting_until_ms: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub last_error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub last_ok_ms: Option<i64>,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    pub struct Downloads {
        pub downloads: Vec<Download>,
        pub sources: Vec<SourceHealth>,
        #[serde(default)]
        pub challenges: Vec<Challenge>,
        #[serde(default)]
        pub settings: Settings,
    }

    /// How downloads are filed (`PUT /api/downloads/settings`).
    #[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
    pub struct Settings {
        /// Convert FLAC to AIFF before filing it, downloads and imported
        /// files alike, for players that don't play FLAC. What is in the
        /// folder already stays as it is.
        #[serde(default)]
        pub aiff: bool,
    }

    /// A source that hands out files only after a person solves a check
    /// (Cloudflare Turnstile) on its site. The app shows the check; solving it
    /// gives a pass the server then uses on its own for a while.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct Challenge {
        /// `flacdownloader`.
        pub id: String,
        /// "flacdownloader.com".
        pub site: String,
        /// The page the check runs on: its origin is the site's.
        pub page: String,
        /// The Turnstile site key.
        pub sitekey: String,
        /// Downloads waiting until it is solved.
        pub waiting: usize,
        /// Whether the server holds a working pass.
        pub solved: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub expires_ms: Option<i64>,
        /// Downloads the pass has left, when the site says.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub remaining: Option<u32>,
    }

    /// What the app sends after solving a check: the site's pass, and the
    /// browser it was solved in, which the server then poses as.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct Solved {
        pub pass: String,
        #[serde(default)]
        pub remaining: Option<u32>,
        pub user_agent: String,
    }

    /// A phone to notify (`POST /api/devices`).
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct Device {
        /// The APNs device token, hex.
        pub token: String,
        /// `development` (sandbox) or `production`.
        pub environment: String,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct NewDownload {
        pub track: CatalogTrack,
    }

    /// What became of a file sent from the phone (`POST /api/imports`).
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct Imported {
        /// The file in the music folder that holds it.
        pub file: String,
        /// False when the folder had the recording already (the same file,
        /// or the same ISRC) and nothing was added.
        pub added: bool,
        /// Its entry among the downloads, when it was added.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub download: Option<Download>,
    }
}

/// Spotify playlists kept in the music folder (`/api/spotify`): the server
/// reads the ones you pick, gets the tracks the folder lacks and writes each
/// as a `.m3u8`, which the next sync puts on the stick.
pub mod spotify {
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct Spotify {
        /// Whether the server is set up to read Spotify at all.
        pub configured: bool,
        /// A check is running now.
        pub checking: bool,
        /// The last check that read the account, ms since the epoch.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub checked_ms: Option<i64>,
        /// Why the last check failed, when it did.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub error: Option<String>,
        /// Spotify is read only when you ask (`POST /api/spotify/check`),
        /// not every ten minutes; nothing new is downloaded by itself.
        #[serde(default)]
        pub paused: bool,
        /// When the next check runs by itself; `None` while paused.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub next_check_ms: Option<i64>,
        /// The account's playlists, in its own order.
        pub playlists: Vec<Playlist>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct Playlist {
        /// Spotify's playlist id.
        pub id: String,
        pub name: String,
        pub owner: String,
        /// Yours, rather than one you follow.
        pub owned: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub image: Option<String>,
        /// Tracks on Spotify.
        pub tracks: usize,
        /// Kept in the folder and on the stick.
        pub selected: bool,
        /// Added by its link rather than picked from the account's list:
        /// kept whether or not the account lists it, and listed only while
        /// kept (unless the account lists it too).
        #[serde(default)]
        pub linked: bool,
        /// The playlist's file in the music folder, once written.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub file: Option<String>,
        /// When its tracks were last read from Spotify.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub read_ms: Option<i64>,
        /// Of its tracks, once read: in the folder, being got, and neither.
        pub have: usize,
        pub getting: usize,
        pub missing: usize,
        /// Why it could not be read or kept, when it could not.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub error: Option<String>,
    }

    /// `GET /api/spotify/playlists/{id}`.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct PlaylistTracks {
        pub playlist: Playlist,
        pub tracks: Vec<Track>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct Track {
        /// `None` for a local file on Spotify, which cannot be got.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub spotify_id: Option<String>,
        pub title: String,
        pub artists: Vec<String>,
        pub album: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub isrc: Option<String>,
        pub duration_sec: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub cover: Option<String>,
        pub state: TrackState,
        /// The folder's file that holds it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub file: Option<String>,
        /// The download getting it, or that last tried.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub download: Option<i64>,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub enum TrackState {
        /// In the folder.
        Here,
        /// Being downloaded, or waiting for a check you solve.
        Getting,
        /// Not in the folder and not being got: the playlist isn't kept, or
        /// a download failed (it is tried again after a day).
        Missing,
        /// A local file on Spotify; there is nothing to download.
        Local,
    }

    /// `POST /api/spotify/playlists`: a playlist to keep, by what you paste
    /// (a link, a short link the Spotify app shares, a `spotify:` URI, an id).
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct AddPlaylist {
        pub link: String,
    }

    /// `PUT /api/spotify/playlists/{id}`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    pub struct Selection {
        pub selected: bool,
    }

    /// `PUT /api/spotify`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    pub struct Settings {
        pub paused: bool,
    }

    /// One thing the Spotify sync did (`GET /api/spotify/activity`), newest
    /// first. Repeats close together are one entry with a count.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct Activity {
        pub id: i64,
        /// When it happened (the latest time, for a merged entry).
        pub ms: i64,
        pub kind: ActivityKind,
        /// The playlist, for what concerns one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub playlist: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub name: Option<String>,
        /// Tracks: read, queued, retried or landed.
        #[serde(default)]
        pub count: usize,
        /// For `changed`: tracks added and removed on Spotify.
        #[serde(default)]
        pub added: usize,
        #[serde(default)]
        pub removed: usize,
        /// What went wrong, or what became of the playlist file.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub detail: Option<String>,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum ActivityKind {
        /// You started keeping a playlist.
        Kept,
        /// You stopped; `detail` says whether its file went.
        Dropped,
        /// A kept playlist was read for the first time (`count` tracks).
        Read,
        /// It changed on Spotify (`added`, `removed`).
        Changed,
        /// Downloads queued for its missing tracks.
        Queued,
        /// Failed downloads tried again.
        Retried,
        /// Tracks that landed in the folder and joined its playlist file.
        Landed,
        /// Spotify couldn't be read (`detail`).
        Failed,
        /// Reading Spotify works again after a failure.
        Recovered,
        /// You paused or resumed the checks.
        Paused,
        Resumed,
    }
}
