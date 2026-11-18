//! Spotify playlists kept in the music folder.
//!
//! You pick playlists in the app, from the account's or by pasting a link to
//! any other. Every ten minutes (and when asked) the server reads the
//! account's playlists through Spotidata (and each one added by its link
//! that the account doesn't list) and, for a picked one whose snapshot
//! changed, its tracks. Then, against the folder:
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
//!
//! Paused, the account is read only when you ask, and nothing is
//! downloaded by itself; what is already coming still lands. What the sync
//! does is kept as activity (`db::log`), for the app to show.

pub mod db;
pub mod link;
pub mod m3u;
mod public;
pub mod remote;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use deckhand_model::downloads::{CatalogTrack, Download, State as DownloadState};
use deckhand_model::spotify::{Activity, ActivityKind, Playlist, PlaylistTracks, Spotify as Status, Track, TrackState};
use tokio::sync::Notify;
use tracing::{info, warn};

use self::db::Event;
use self::remote::{Gone, Remote, RemotePlaylistTracks, RemoteTrack};
use crate::downloads::catalog::LibraryNames;
use crate::store::{now_ms, State as FileState, Store};

/// How often the account is read.
const CHECK_EVERY: Duration = Duration::from_secs(10 * 60);
/// How often the folder is compared again, when it changed.
const RECONCILE_EVERY: Duration = Duration::from_secs(15);
/// A failed download of a playlist's track is tried again after this.
const RETRY_AFTER_MS: i64 = 24 * 3600 * 1000;
/// Where pausing is remembered.
const PAUSED_KEY: &str = "spotify.paused";

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
    /// Read only when asked.
    paused: AtomicBool,
    /// You asked for a check; it runs even while paused.
    asked: AtomicBool,
    /// When the last check ran, for when the next one does.
    last_check: Mutex<Option<std::time::Instant>>,
    /// Playlists you asked to check: read again whatever their snapshot,
    /// and their failed tracks tried again now rather than after a day.
    force: Mutex<HashSet<String>>,
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
    /// `spotidata` is Spotidata's address, for an account's playlists;
    /// without it, playlists are kept by their link only, read as Spotify
    /// shows anyone.
    pub fn new(store: Store, music: PathBuf, downloads: crate::downloads::Service, spotidata: Option<&str>) -> Result<Self> {
        db::migrate(&store)?;
        let http = reqwest::Client::builder()
            .user_agent(concat!("deckhand/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        let remote = Some(match spotidata.filter(|s| !s.is_empty()) {
            Some(base) => Remote::Spotidata(remote::Spotidata::new(base, http)),
            None => {
                info!("DECKHAND_SPOTIDATA is not set; Spotify playlists are kept by their link, without an account");
                Remote::Public(Arc::new(public::Public::new(http)))
            }
        });
        let paused = store.meta(PAUSED_KEY)?.as_deref() == Some("1");
        Ok(Self {
            inner: Arc::new(Inner {
                store,
                music,
                downloads,
                remote,
                wake: Notify::new(),
                checking: AtomicBool::new(false),
                paused: AtomicBool::new(paused),
                asked: AtomicBool::new(false),
                last_check: Mutex::default(),
                force: Mutex::default(),
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
                let asked = this.inner.asked.swap(false, Ordering::Relaxed);
                let paused = this.paused();
                if asked || (this.until_check().is_zero() && !paused) {
                    this.check().await;
                    // Waking (pausing, resuming) doesn't move the next one.
                    *lock(&this.inner.last_check) = Some(std::time::Instant::now());
                }
                if let Err(e) = this.reconcile(asked || !paused).await {
                    warn!(error = %e, "could not keep the Spotify playlists");
                }
                let wait = this.until_check();
                tokio::select! {
                    () = this.inner.wake.notified() => {}
                    () = tokio::time::sleep(wait) => {}
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
                if let Err(e) = this.reconcile(!this.paused()).await {
                    warn!(error = %e, "could not keep the Spotify playlists");
                }
            }
        });
    }

    /// Reads the account now rather than at the next check, paused or not.
    pub fn check_soon(&self) {
        self.inner.asked.store(true, Ordering::Relaxed);
        self.inner.wake.notify_one();
    }

    fn paused(&self) -> bool {
        self.inner.paused.load(Ordering::Relaxed)
    }

    /// How long until the next check is due; zero when it is.
    fn until_check(&self) -> Duration {
        lock(&self.inner.last_check).map_or(Duration::ZERO, |last| CHECK_EVERY.saturating_sub(last.elapsed()))
    }

    /// Pauses or resumes the checks every ten minutes.
    pub fn set_paused(&self, paused: bool) -> Result<()> {
        if self.inner.paused.swap(paused, Ordering::Relaxed) == paused {
            return Ok(());
        }
        self.inner.store.set_meta(PAUSED_KEY, if paused { "1" } else { "0" })?;
        let kind = if paused { ActivityKind::Paused } else { ActivityKind::Resumed };
        db::log(&self.inner.store, kind, &Event::default())?;
        info!(paused, "Spotify checks");
        // Picks up the change; a check overdue while paused runs now.
        self.inner.wake.notify_one();
        Ok(())
    }

    /// Reads one playlist again now and tries its failed tracks again;
    /// `false` for an unknown playlist.
    pub fn check_playlist(&self, id: &str) -> Result<bool> {
        let Some(row) = db::get(&self.inner.store, id)? else { return Ok(false) };
        info!(playlist = %row.name, "asked to check a Spotify playlist");
        lock(&self.inner.force).insert(row.id);
        self.check_soon();
        Ok(true)
    }

    /// What the sync did, newest first.
    pub fn activity(&self, playlist: Option<&str>, limit: usize) -> Result<Vec<Activity>> {
        db::activity(&self.inner.store, playlist, limit.clamp(1, 500))
    }

    // MARK: API

    pub fn status(&self) -> Result<Status> {
        let index = self.index()?;
        let playlists = db::all(&self.inner.store)?
            .into_iter()
            .filter(|p| !p.gone || p.selected)
            .map(|p| self.describe(&p, &index))
            .collect::<Result<Vec<_>>>()?;
        let (checked_ms, error) = lock(&self.inner.last).clone();
        let paused = self.paused();
        Ok(Status {
            configured: self.inner.remote.is_some(),
            account: self.inner.remote.as_ref().is_some_and(Remote::has_account),
            checking: self.inner.checking.load(Ordering::Relaxed),
            checked_ms,
            error,
            paused,
            next_check_ms: (!paused && self.inner.remote.is_some())
                .then(|| now_ms() + i64::try_from(self.until_check().as_millis()).unwrap_or(0)),
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
                    Ok(read) => self.store_read(&row, &read)?,
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

    /// Starts keeping the playlist a link (or `spotify:` URI, or id) names,
    /// whether or not the account lists it. `Err` inside says why not, for
    /// you to read.
    pub async fn add(&self, link: &str) -> Result<Result<Playlist, String>> {
        let Some(remote) = &self.inner.remote else {
            return Ok(Err("The server isn't set up to read Spotify.".to_owned()));
        };
        let id = match (link::parse(link), link::short(link)) {
            (Some(id), _) => id,
            (None, Some(url)) => match link::follow(remote.http(), url).await? {
                Some(id) => id,
                None => return Ok(Err("That link doesn't open a playlist.".to_owned())),
            },
            (None, None) => return Ok(Err("That isn't a link to a Spotify playlist.".to_owned())),
        };
        let p = match remote.info(&id).await {
            Ok(p) => p,
            Err(e) if e.is::<Gone>() => {
                return Ok(Err(if remote.has_account() {
                    "Spotify won't show this playlist to the server. Its own mixes and editorial \
                     playlists can't be read by apps; a copy of one in your library can."
                } else {
                    "Spotify doesn't show this playlist to anyone without an account: it's private, or gone."
                }
                .to_owned()));
            }
            Err(e) => return Err(e),
        };
        let store = &self.inner.store;
        let was = db::get(store, &p.id)?;
        db::add_linked(store, &p)?;
        if !was.as_ref().is_some_and(|row| row.selected) {
            info!(playlist = %p.name, "keeping a Spotify playlist added by its link");
            let event = Event { playlist: Some((p.id.as_str(), p.name.as_str())), ..Event::default() };
            db::log(store, ActivityKind::Kept, &event)?;
        }
        self.check_soon();
        let row = db::get(store, &p.id)?.context("the playlist just added is not there")?;
        let index = self.index()?;
        Ok(Ok(self.describe(&row, &index)?))
    }

    /// Starts or stops keeping a playlist; `false` for an unknown one.
    pub fn select(&self, id: &str, selected: bool) -> Result<bool> {
        let store = &self.inner.store;
        let Some(row) = db::get(store, id)? else { return Ok(false) };
        db::select(store, id, selected)?;
        if row.selected != selected {
            info!(id, selected, "Spotify playlist selection changed");
            let playlist = Some((row.id.as_str(), row.name.as_str()));
            // A dropped playlist with a file is logged once the file is seen to.
            if selected {
                db::log(store, ActivityKind::Kept, &Event { playlist, ..Event::default() })?;
            } else if row.file.is_none() {
                db::log(store, ActivityKind::Dropped, &Event { playlist, ..Event::default() })?;
            }
        }
        self.check_soon();
        Ok(true)
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
            (None, true) if p.linked_ms.is_some() => Some(Gone.to_string()),
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
            linked: p.linked_ms.is_some(),
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
        let (was, now) = {
            let mut last = lock(&self.inner.last);
            let was = last.1.clone();
            match &result {
                Ok(()) => *last = (Some(now_ms()), None),
                Err(e) => {
                    warn!(error = %e, "could not read Spotify");
                    last.1 = Some(format!("{e:#}"));
                }
            }
            (was, last.1.clone())
        };
        // Once per trouble, not every ten minutes while it lasts.
        let logged = match (&was, &now) {
            (_, Some(error)) if was.as_ref() != Some(error) => {
                db::log(&self.inner.store, ActivityKind::Failed, &Event { detail: Some(error), ..Event::default() })
            }
            (Some(_), None) => db::log(&self.inner.store, ActivityKind::Recovered, &Event::default()),
            _ => Ok(()),
        };
        if let Err(e) = logged {
            warn!(error = %e, "could not record Spotify activity");
        }
    }

    async fn read(&self, remote: &Remote) -> Result<()> {
        let store = &self.inner.store;
        let list = remote.playlists().await?;
        db::replace_list(store, &list)?;
        // Kept by their link but not the account's: asked one by one.
        let listed: HashSet<&str> = list.iter().map(|p| p.id.as_str()).collect();
        for p in db::all(store)?.into_iter().filter(|p| p.selected && p.linked_ms.is_some()) {
            if listed.contains(p.id.as_str()) {
                continue;
            }
            match remote.info(&p.id).await {
                Ok(info) => db::update_info(store, &info)?,
                Err(e) if e.is::<Gone>() => {
                    db::set_gone(store, &p.id)?;
                    db::set_error(store, &p.id, Some(&e.to_string()))?;
                }
                Err(e) => {
                    db::set_error(store, &p.id, Some(&format!("{e:#}")))?;
                    return Err(e);
                }
            }
        }
        for p in db::all(store)?.into_iter().filter(|p| p.selected && !p.gone) {
            let forced = lock(&self.inner.force).contains(&p.id);
            if p.read_snapshot.as_deref() == Some(p.snapshot.as_str()) && !forced {
                continue;
            }
            match remote.playlist(&p.id).await {
                Ok(read) => {
                    info!(playlist = %p.name, tracks = read.tracks.len(), "read a changed Spotify playlist");
                    self.store_read(&p, &read)?;
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

    /// Stores a playlist's tracks as just read, and records what changed.
    fn store_read(&self, p: &db::Row, read: &RemotePlaylistTracks) -> Result<()> {
        let store = &self.inner.store;
        let before = db::tracks(store, &p.id)?;
        db::replace_tracks(store, &p.id, &read.snapshot_id, &read.tracks)?;
        if !p.selected {
            return Ok(());
        }
        let playlist = Some((p.id.as_str(), p.name.as_str()));
        if p.read_snapshot.is_none() {
            let event = Event { playlist, count: read.tracks.len(), ..Event::default() };
            return db::log(store, ActivityKind::Read, &event);
        }
        let (added, removed) = diff(&before, &read.tracks);
        if added + removed > 0 {
            db::log(store, ActivityKind::Changed, &Event { playlist, added, removed, ..Event::default() })?;
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

    /// Writes the kept playlists' files and, with `get`, downloads what they
    /// lack.
    async fn reconcile(&self, get: bool) -> Result<()> {
        let _pass = self.inner.pass.lock().await;
        let store = &self.inner.store;
        let index = self.index()?;
        // Asked-for playlists are seen to by a pass that gets.
        let forced = if get { std::mem::take(&mut *lock(&self.inner.force)) } else { HashSet::new() };
        let mut taken: HashSet<String> = HashSet::new();
        for p in db::all(store)? {
            let playlist = Some((p.id.as_str(), p.name.as_str()));
            if !p.selected {
                if let Some(file) = &p.file {
                    let detail = if m3u::remove(&self.inner.music, file, p.file_hash.as_deref())? {
                        info!(playlist = %p.name, %file, "no longer kept; its playlist file is gone");
                        "removed"
                    } else {
                        info!(playlist = %p.name, %file, "no longer kept; its playlist file was edited, so it stays");
                        "edited"
                    };
                    db::set_file(store, &p.id, None, None)?;
                    db::log(store, ActivityKind::Dropped, &Event { playlist, detail: Some(detail), ..Event::default() })?;
                }
                continue;
            }
            if p.read_snapshot.is_none() {
                continue;
            }
            let tracks = db::tracks(store, &p.id)?;
            let now = forced.contains(&p.id);
            let mut entries = Vec::new();
            let (mut queued, mut retried) = (0, 0);
            for t in &tracks {
                let found = self.find(&index, t)?;
                match (found.state, found.file) {
                    (TrackState::Here, Some(file)) => entries.push((file, t)),
                    (TrackState::Missing, _) if get => match self.get(t, found.download.as_ref(), &p.name, now).await {
                        Got::Queued => queued += 1,
                        Got::Retried => retried += 1,
                        Got::Nothing => {}
                    },
                    _ => {}
                }
            }
            if queued > 0 {
                db::log(store, ActivityKind::Queued, &Event { playlist, count: queued, ..Event::default() })?;
            }
            if retried > 0 {
                db::log(store, ActivityKind::Retried, &Event { playlist, count: retried, ..Event::default() })?;
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
            // Downloads that joined the playlist since its file was last
            // written; not tracks Spotify added that the folder had.
            let mut landed = 0;
            if let Some(old) = &p.file {
                let before = m3u::files(&self.inner.music.join(old));
                for (file, t) in &entries {
                    if !before.contains(file) && t.key().map(|key| db::link(store, &key)).transpose()?.flatten().is_some() {
                        landed += 1;
                    }
                }
            }
            if let Some(old) = p.file.as_ref().filter(|old| **old != name) {
                // Renamed on Spotify.
                m3u::remove(&self.inner.music, old, p.file_hash.as_deref())?;
            }
            if m3u::write(&self.inner.music, &name, &text)? {
                info!(playlist = %p.name, file = %name, tracks = entries.len(), of = tracks.len(), "playlist file written");
            }
            if landed > 0 {
                db::log(store, ActivityKind::Landed, &Event { playlist, count: landed, ..Event::default() })?;
            }
            db::set_file(store, &p.id, Some(&name), Some(&m3u::hash(&text)))?;
        }
        Ok(())
    }

    /// Queues a missing track, or tries a failed download again once it
    /// has rested a day (`now`: at once).
    async fn get(&self, t: &RemoteTrack, last: Option<&Download>, playlist: &str, now: bool) -> Got {
        let downloads = &self.inner.downloads;
        if let Some(d) = last {
            match d.state {
                DownloadState::Failed if now || now_ms() - d.updated_ms > RETRY_AFTER_MS => {
                    info!(title = %t.title, %playlist, "trying a playlist's track again");
                    return match downloads.retry(d.id) {
                        Ok(_) => Got::Retried,
                        Err(e) => {
                            warn!(error = %e, "could not retry a download");
                            Got::Nothing
                        }
                    };
                }
                // Done but the file is gone: get it again below.
                DownloadState::Done => {}
                // Resting, or stopped by you.
                _ => return Got::Nothing,
            }
        }
        let Some(key) = t.key() else { return Got::Nothing };
        let Some(id) = &t.id else { return Got::Nothing };
        let catalog = match &t.isrc {
            Some(isrc) => match downloads.by_isrc(isrc).await {
                Ok(found) => found,
                Err(e) => {
                    // Asked again next pass.
                    warn!(error = %e, title = %t.title, "the catalog could not be asked");
                    return Got::Nothing;
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
                Got::Queued
            }
            Err(e) => {
                warn!(error = %e, title = %t.title, "could not queue a playlist's track");
                Got::Nothing
            }
        }
    }
}

/// What `get` did for a missing track.
enum Got {
    Queued,
    Retried,
    Nothing,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Tracks added to and removed from a playlist between two reads, by
/// recording (local files by title and artists).
fn diff(before: &[RemoteTrack], after: &[RemoteTrack]) -> (usize, usize) {
    let key = |t: &RemoteTrack| t.key().unwrap_or_else(|| format!("local:{}|{}", t.title, t.artists.join(",")));
    let mut counts: HashMap<String, i64> = HashMap::new();
    for t in after {
        *counts.entry(key(t)).or_default() += 1;
    }
    for t in before {
        *counts.entry(key(t)).or_default() -= 1;
    }
    let added = counts.values().filter(|n| **n > 0).map(|n| n.unsigned_abs()).sum::<u64>();
    let removed = counts.values().filter(|n| **n < 0).map(|n| n.unsigned_abs()).sum::<u64>();
    (usize::try_from(added).unwrap_or(0), usize::try_from(removed).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: &str) -> RemoteTrack {
        RemoteTrack {
            id: Some(id.to_owned()),
            title: id.to_owned(),
            artists: vec![],
            album: String::new(),
            isrc: None,
            duration_ms: 0,
            cover: None,
        }
    }

    #[test]
    fn diff_counts_recordings() {
        let before = [track("a"), track("b"), track("c")];
        let after = [track("b"), track("c"), track("d"), track("e"), track("b")];
        assert_eq!(diff(&before, &after), (3, 1));
        assert_eq!(diff(&after, &after), (0, 0));
    }
}
