//! Deckhand's server: watches the music folder, analyses new tracks, gets
//! music, and serves the library to the phone that syncs the DJ stick.
//!
//! It runs as its own process on a home server (`main.rs`), or inside the
//! app on the phone itself (`deckhand-core`), where the phone holds the
//! music folder and does the searching, downloading and analysis.

mod analyse;
mod api;
mod blobs;
mod downloads;
mod library;
mod push;
mod rekordbox;
mod scan;
mod spotify;
mod store;
mod tags;
mod worker;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use tracing::{info, warn};

pub struct Config {
    /// The music folder: flat, audio and `.m3u8` playlists.
    pub music: PathBuf,
    /// The database, analysis blobs and downloads being staged.
    pub data: PathBuf,
    /// Tracks analysed at once.
    pub analysis_threads: usize,
    /// Spotidata's address, for an account's playlists; without it,
    /// playlists are kept by their link only.
    pub spotidata: Option<String>,
    /// How often the music folder is looked at for changes.
    pub scan_every: Duration,
}

/// A running server: its background work started, its API ready to serve.
#[derive(Clone)]
pub struct Server {
    app: api::App,
}

impl Server {
    /// Opens the store and starts the scanner, the analysis workers, the
    /// download queue and the Spotify sync. Call it inside a tokio runtime,
    /// which keeps them running.
    pub fn start(config: Config) -> Result<Self> {
        let Config { music, data, analysis_threads, spotidata, scan_every } = config;
        std::fs::create_dir_all(&data)?;
        std::fs::create_dir_all(&music)?;

        let store = store::Store::open(&data.join("deckhand.db"))?;
        let blobs = blobs::Blobs::new(data.join("blobs"))?;

        // Counts the music folder's changes, for waking the phone.
        let changes = Arc::new(AtomicU64::new(0));
        {
            let (music, store, changes) = (music.clone(), store.clone(), changes.clone());
            std::thread::Builder::new().name("scan".into()).spawn(move || loop {
                match scan::scan(&music, &store) {
                    Ok(true) => {
                        info!("music folder changed");
                        changes.fetch_add(1, Ordering::Relaxed);
                    }
                    Ok(false) => {}
                    Err(e) => warn!(error = %e, "scan failed"),
                }
                std::thread::sleep(scan_every);
            })?;
        }
        worker::spawn(analysis_threads, music.clone(), store.clone(), blobs.clone());

        let push = push::Push::new(store.clone());
        if push.is_configured() {
            // New files: wake the phone to download them ahead of the next
            // sync. At most every ten minutes while they keep coming, and
            // once more after the last.
            let push = push.clone();
            tokio::spawn(async move {
                let mut seen = changes.load(Ordering::Relaxed);
                loop {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    let now = changes.load(Ordering::Relaxed);
                    if now != seen {
                        seen = now;
                        push.wake().await;
                        tokio::time::sleep(Duration::from_secs(9 * 60)).await;
                    }
                }
            });
        }
        let downloads = downloads::Service::new(store.clone(), music.clone(), &data, push.clone())?;
        downloads.spawn();
        let spotify = spotify::Spotify::new(store.clone(), music.clone(), downloads.clone(), spotidata.as_deref())?;
        spotify.spawn();

        Ok(Self {
            app: api::App {
                music,
                data,
                store,
                blobs,
                cache: Arc::default(),
                ingesting: Arc::default(),
                downloads,
                spotify,
                push,
            },
        })
    }

    /// The HTTP API; see `api.rs`.
    pub fn router(&self) -> axum::Router {
        api::router(self.app.clone())
    }
}
