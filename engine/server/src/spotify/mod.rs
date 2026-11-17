//! Spotify playlists kept in the music folder.
//!
//! You pick playlists in the app. Every ten minutes (and when asked) the
//! server reads the account's playlists through Spotidata and, for a picked
//! one whose snapshot changed, its tracks. Then, against the folder:
//!
//! 1. each track is found by ISRC, else by title and first artist, else by
//!    the download that got it;
//! 2. a track the folder lacks is queued as a download (as Deezer's catalog
//!    knows it, else as Spotify does); one that failed is tried again a day
//!    later; one you stopped is left alone;
//! 3. the playlist is written as `<Name>.m3u8` in Spotify's order, with the
//!    tracks the folder holds.
//!
//! The scanner then sees the new files, the analyser analyses them and the
//! next sync (automatic while the stick is plugged in) puts them on it.
//! Removing a track from a playlist on Spotify takes it out of the playlist
//! file, never out of the folder. A playlist you stop keeping loses its
//! file, unless it was edited since the server wrote it.

pub mod db;
pub mod m3u;
pub mod remote;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use deckhand_model::downloads::{CatalogTrack, Download, State as DownloadState};
use deckhand_model::spotify::{Playlist, PlaylistTracks, Spotify as Status, Track, TrackState};
use tokio::sync::Notify;
use tracing::{info, warn};

use self::remote::{Gone, Remote, RemoteTrack};
use crate::downloads::catalog::LibraryNames;
use crate::store::{now_ms, State as FileState, Store};

/// How often the account is read.
const CHECK_EVERY: Duration = Duration::from_secs(10 * 60);
/// How often the folder is compared again, when it changed.
const RECONCILE_EVERY: Duration = Duration::from_secs(15);
/// A failed download of a playlist's track is tried again after this.
const RETRY_AFTER_MS: i64 = 24 * 3600 * 1000;

#[derive(Clone)]
pub struct Spotify {
    inner: Arc<Inner>,
}

struct Inner {
    store: Store,
    music: PathBuf,
    downloads: crate::downloads::Service,
    remote: Option<Remote>,
    wake: Notify,
    checking: AtomicBool,
    /// The last check: when it worked, and why it didn't.
    last: Mutex<(Option<i64>, Option<String>)>,
    /// One pass over the folder at a time.
    pass: tokio::sync::Mutex<()>,
    index: Mutex<Option<(u64, Arc<Index>)>>,
}

/// The folder's tracks, for finding a Spotify track in it.
struct Index {
    files: HashSet<String>,
    isrcs: HashMap<String, String>,
    names: LibraryNames,
}

/// Where one Spotify track stands.
struct Found {
    state: TrackState,
    file: Option<String>,
    download: Option<Download>,
}

impl Spotify {
    /// `spotidata` is Spotidata's address; without it Spotify is off.
    pub fn new(store: Store, music: PathBuf, downloads: crate::downloads::Service, spotidata: Option<&str>) -> Result<Self> {
        db::migrate(&store)?;
        let remote = spotidata.filter(|s| !s.is_empty()).map(|base| {
            let http = reqwest::Client::builder()
                .user_agent(concat!("deckhand/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(Duration::from_secs(10))
                .build()
                .unwrap_or_default();
            Remote::new(base, http)
        });
        if remote.is_none() {
            info!("DECKHAND_SPOTIDATA is not set; Spotify playlists are off");
        }
        Ok(Self {
            inner: Arc::new(Inner {
                store,
                music,
                downloads,
                remote,
                wake: Notify::new(),
                checking: AtomicBool::new(false),
                last: Mutex::default(),
                pass: tokio::sync::Mutex::new(()),
                index: Mutex::default(),
            }),
        })
    }

    pub fn spawn(&self) {
        let this = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            loop {
                this.check().await;
                if let Err(e) = this.reconcile().await {
                    warn!(error = %e, "could not keep the Spotify playlists");
                }
                tokio::select! {
                    () = this.inner.wake.notified() => {}
                    () = tokio::time::sleep(CHECK_EVERY) => {}
                }
            }
        });
        // Downloads landing (and the files the last pass wrote) change the
        // folder; follow it between checks.
        let this = self.clone();
        tokio::spawn(async move {
            let mut seen = 0;
            loop {
                tokio::time::sleep(RECONCILE_EVERY).await;
                let version = this.inner.store.version();
                if version == seen {
                    continue;
                }
                seen = version;
                if let Err(e) = this.reconcile().await {
                    warn!(error = %e, "could not keep the Spotify playlists");
                }
            }
        });
    }

    /// Reads the account now rather than at the next check.
    pub fn check_soon(&self) {
        self.inner.wake.notify_one();
    }

    // MARK: API

    pub fn status(&self) -> Result<Status> {
        let index = self.index()?;
        let playlists = db::all(&self.inner.store)?
            .into_iter()
            .filter(|p| !p.gone || p.selected)
            .map(|p| self.describe(&p, &index))
            .collect::<Result<Vec<_>>>()?;
        let (checked_ms, error) = self.inner.last.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        Ok(Status {
            configured: self.inner.remote.is_some(),
            checking: self.inner.checking.load(Ordering::Relaxed),
            checked_ms,
            error,
            playlists,
        })
    }

    /// A playlist with each track's state, read from Spotify first when what
    /// the server has is older than the account's list.
    pub async fn playlist(&self, id: &str) -> Result<Option<PlaylistTracks>> {
        let store = &self.inner.store;
        let Some(row) = db::get(store, id)? else { return Ok(None) };
        if row.read_snapshot.as_deref() != Some(row.snapshot.as_str()) && !row.gone {
            if let Some(remote) = &self.inner.remote {
                match remote.playlist(id).await {
                    Ok(read) => db::replace_tracks(store, id, &read.snapshot_id, &read.tracks)?,
                    Err(e) => db::set_error(store, id, Some(&e.to_string()))?,
                }
            }
        }
        let Some(row) = db::get(store, id)? else { return Ok(None) };
        let index = self.index()?;
        let tracks = db::tracks(store, id)?
            .into_iter()
            .map(|t| {
                let found = self.find(&index, &t)?;
                Ok(Track {
                    spotify_id: t.id.clone(),
                    duration_sec: t.duration_sec(),
                    title: t.title,
                    artists: t.artists,
                    album: t.album,
                    isrc: t.isrc,
                    cover: t.cover,
                    state: found.state,
                    file: found.file,
                    download: found.download.map(|d| d.id),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Some(PlaylistTracks { playlist: self.describe(&row, &index)?, tracks }))
    }

    /// Starts or stops keeping a playlist; `false` for an unknown one.
    pub fn select(&self, id: &str, selected: bool) -> Result<bool> {
        let known = db::select(&self.inner.store, id, selected)?;
        if known {
            info!(id, selected, "Spotify playlist selection changed");
            self.check_soon();
        }
        Ok(known)
    }

    fn describe(&self, p: &db::Row, index: &Index) -> Result<Playlist> {
        let (mut have, mut getting, mut missing) = (0, 0, 0);
        if p.read_snapshot.is_some() {
            for t in db::tracks(&self.inner.store, &p.id)? {
                match self.find(index, &t)?.state {
                    TrackState::Here => have += 1,
                    TrackState::Getting => getting += 1,
                    TrackState::Missing | TrackState::Local => missing += 1,
                }
            }
        }
        let error = match (&p.error, p.gone) {
            (Some(error), _) => Some(error.clone()),
            (None, true) => Some("It's no longer in your Spotify library.".to_owned()),
            (None, false) => None,
        };
        Ok(Playlist {
            id: p.id.clone(),
            name: p.name.clone(),
            owner: p.owner.clone(),
            owned: p.owned,
            image: p.image.clone(),
            tracks: p.total,
            selected: p.selected,
            file: p.file.clone(),
            read_ms: p.read_ms,
            have,
            getting,
            missing,
            error,
        })
    }

    // MARK: Check

    /// Reads the account's playlists, and the tracks of the kept ones that
    /// changed.
    async fn check(&self) {
        let Some(remote) = &self.inner.remote else { return };
        self.inner.checking.store(true, Ordering::Relaxed);
        let result = self.read(remote).await;
        self.inner.checking.store(false, Ordering::Relaxed);
        let mut last = self.inner.last.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        match result {
            Ok(()) => *last = (Some(now_ms()), None),
            Err(e) => {
                warn!(error = %e, "could not read Spotify");
                last.1 = Some(format!("{e:#}"));
            }
        }
    }

    async fn read(&self, remote: &Remote) -> Result<()> {
        let store = &self.inner.store;
        let list = remote.playlists().await?;
        db::replace_list(store, &list)?;
        for p in db::all(store)?.into_iter().filter(|p| p.selected && !p.gone) {
            if p.read_snapshot.as_deref() == Some(p.snapshot.as_str()) {
                continue;
            }
            match remote.playlist(&p.id).await {
                Ok(read) => {
                    info!(playlist = %p.name, tracks = read.tracks.len(), "read a changed Spotify playlist");
                    db::replace_tracks(store, &p.id, &read.snapshot_id, &read.tracks)?;
                }
                Err(e) if e.is::<Gone>() => db::set_error(store, &p.id, Some(&e.to_string()))?,
                Err(e) => {
                    db::set_error(store, &p.id, Some(&format!("{e:#}")))?;
                    // Rate limited or unreachable: the rest would be too.
                    return Err(e);
                }
            }
        }
        Ok(())
    }

    // MARK: Folder

    fn index(&self) -> Result<Arc<Index>> {
        let store = &self.inner.store;
        let version = store.version();
        let mut cached = self.inner.index.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((v, index)) = cached.as_ref() {
            if *v == version {
                return Ok(index.clone());
            }
        }
        let rows = store.all()?;
        let files = rows.iter().filter(|r| r.state != FileState::Other).map(|r| r.name.clone()).collect();
        let names = LibraryNames::new(rows.into_iter().filter(|r| r.state != FileState::Other).filter_map(|row| {
            let source: rbl_export::SourceTrack = serde_json::from_str(row.source.as_deref()?).ok()?;
            Some((row.name, source.title, source.artist))
        }));
        let index = Arc::new(Index { files, isrcs: store.isrcs()?, names });
        *cached = Some((version, index.clone()));
        Ok(index)
    }

    fn find(&self, index: &Index, t: &RemoteTrack) -> Result<Found> {
        let here = |file: String| Found { state: TrackState::Here, file: Some(file), download: None };
        if let Some(file) = t.isrc.as_ref().and_then(|isrc| index.isrcs.get(isrc)) {
            return Ok(here(file.clone()));
        }
        if let Some(file) = index.names.find(&t.title, &t.artists) {
            return Ok(here(file));
        }
        let Some(key) = t.key().filter(|_| t.id.is_some()) else {
            return Ok(Found { state: TrackState::Local, file: None, download: None });
        };
        let download = match db::link(&self.inner.store, &key)? {
            Some(id) => self.inner.downloads.get(id)?,
            None => None,
        };
        let state = match &download {
            Some(d) if d.state == DownloadState::Done => {
                match d.file.clone() {
                    Some(file) if index.files.contains(&file) => {
                        return Ok(Found { state: TrackState::Here, file: Some(file), download });
                    }
                    // Just landed; the scanner hasn't seen it yet.
                    Some(file) if self.inner.music.join(&file).exists() => TrackState::Getting,
                    _ => TrackState::Missing,
                }
            }
            Some(d) if d.state.is_active() => TrackState::Getting,
            _ => TrackState::Missing,
        };
        Ok(Found { state, file: None, download })
    }

    /// Gets what the kept playlists lack and writes their files.
    async fn reconcile(&self) -> Result<()> {
        let _pass = self.inner.pass.lock().await;
        let store = &self.inner.store;
        let index = self.index()?;
        let mut taken: HashSet<String> = HashSet::new();
        for p in db::all(store)? {
            if !p.selected {
                if let Some(file) = &p.file {
                    if m3u::remove(&self.inner.music, file, p.file_hash.as_deref())? {
                        info!(playlist = %p.name, %file, "no longer kept; its playlist file is gone");
                    } else {
                        info!(playlist = %p.name, %file, "no longer kept; its playlist file was edited, so it stays");
                    }
                    db::set_file(store, &p.id, None, None)?;
                }
                continue;
            }
            if p.read_snapshot.is_none() {
                continue;
            }
            let tracks = db::tracks(store, &p.id)?;
            let mut entries = Vec::new();
            for t in &tracks {
                let found = self.find(&index, t)?;
                match (found.state, found.file) {
                    (TrackState::Here, Some(file)) => entries.push((file, t)),
                    (TrackState::Missing, _) => self.get(t, found.download.as_ref(), &p.name).await,
                    _ => {}
                }
            }
            let mut name = m3u::file_name(&p.name);
            for n in 2.. {
                if taken.insert(name.to_lowercase()) {
                    break;
                }
                let base = m3u::file_name(&p.name);
                name = format!("{} ({n}).m3u8", base.trim_end_matches(".m3u8"));
            }
            // A playlist with nothing in the folder yet gets its file once
            // the first track lands.
            if entries.is_empty() && p.file.is_none() {
                continue;
            }
            let text = m3u::render(
                &entries
                    .iter()
                    .map(|(file, t)| m3u::Entry {
                        file,
                        duration_sec: t.duration_sec(),
                        artists: &t.artists,
                        title: &t.title,
                    })
                    .collect::<Vec<_>>(),
            );
            if let Some(old) = p.file.as_ref().filter(|old| **old != name) {
                // Renamed on Spotify.
                m3u::remove(&self.inner.music, old, p.file_hash.as_deref())?;
            }
            if m3u::write(&self.inner.music, &name, &text)? {
                info!(playlist = %p.name, file = %name, tracks = entries.len(), of = tracks.len(), "playlist file written");
            }
            db::set_file(store, &p.id, Some(&name), Some(&m3u::hash(&text)))?;
        }
        Ok(())
    }

    /// Queues a missing track, or tries a failed download again once it
    /// has rested a day.
    async fn get(&self, t: &RemoteTrack, last: Option<&Download>, playlist: &str) {
        let downloads = &self.inner.downloads;
        if let Some(d) = last {
            match d.state {
                DownloadState::Failed if now_ms() - d.updated_ms > RETRY_AFTER_MS => {
                    info!(title = %t.title, %playlist, "trying a playlist's track again");
                    if let Err(e) = downloads.retry(d.id) {
                        warn!(error = %e, "could not retry a download");
                    }
                    return;
                }
                // Done but the file is gone: get it again below.
                DownloadState::Done => {}
                // Resting, or stopped by you.
                _ => return,
            }
        }
        let Some(key) = t.key() else { return };
        let Some(id) = &t.id else { return };
        let catalog = match &t.isrc {
            Some(isrc) => match downloads.by_isrc(isrc).await {
                Ok(found) => found,
                Err(e) => {
                    // Asked again next pass.
                    warn!(error = %e, title = %t.title, "the catalog could not be asked");
                    return;
                }
            },
            None => None,
        };
        let catalog = catalog.unwrap_or_else(|| CatalogTrack {
            id: format!("spotify:{id}"),
            title: t.title.clone(),
            artists: t.artists.clone(),
            album: t.album.clone(),
            isrc: t.isrc.clone(),
            duration_sec: t.duration_sec(),
            cover: t.cover.clone(),
            explicit: false,
            in_library: None,
        });
        match downloads.add_for(&catalog, Some(playlist)) {
            Ok(download) => {
                if let Err(e) = db::set_link(&self.inner.store, &key, download.id) {
                    warn!(error = %e, "could not link a download to its playlist track");
                }
            }
            Err(e) => warn!(error = %e, title = %t.title, "could not queue a playlist's track"),
        }
    }
}
