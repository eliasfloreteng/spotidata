//! Deckhand's server: watches the music folder, analyses new tracks, gets
//! music, and serves the library to the apps that sync the DJ stick. It runs
//! on the home server (`main.rs`), with its state in Postgres (`store.rs`).

mod analyse;
mod api;
mod blobs;
mod downloads;
pub mod import_sqlite;
mod library;
mod push;
mod rekordbox;
mod scan;
mod spotidata;
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

pub use store::Database;

pub struct Config {
    /// The music folder: flat, audio and `.m3u8` playlists.
    pub music: PathBuf,
    /// The database, analysis blobs and downloads being staged.
    pub data: PathBuf,
    /// Tracks analysed at once.
    pub analysis_threads: usize,
    /// Spotidata's address, which Spotify is read through
    /// (`http://spotidata:3000` in the stack).
    pub spotidata: String,
    /// The Postgres database whose `deckhand` schema holds the server's state,
    /// which is Spotidata's.
    pub database: Database,
}

/// Connects to the database and brings its `deckhand` schema up to date,
/// as `Server::start` does first.
pub async fn migrate(database: &Database) -> Result<()> {
    store::Store::connect(database).await?;
    Ok(())
}

/// How often the music folder is looked at for changes.
const SCAN_EVERY: Duration = Duration::from_secs(20);

/// A running server: its background work started, its API ready to serve.
#[derive(Clone)]
pub struct Server {
    app: api::App,
}

impl Server {
    /// Connects to the database (migrating its `deckhand` schema) and starts
    /// the scanner, the analysis workers, the download queue and the Spotify
    /// sync, as tasks of the current tokio runtime, which keeps them running.
    pub async fn start(config: Config) -> Result<Self> {
        let Config { music, data, analysis_threads, spotidata, database } = config;
        std::fs::create_dir_all(&data)?;
        std::fs::create_dir_all(&music)?;

        let store = store::Store::connect(&database).await?;
        store.requeue_old_analysis().await?;
        let blobs = blobs::Blobs::new(data.join("blobs"))?;

        // Counts the music folder's changes, for waking the phone.
        let changes = Arc::new(AtomicU64::new(0));
        {
            let (music, store, changes) = (music.clone(), store.clone(), changes.clone());
            tokio::spawn(async move {
                loop {
                    match scan::scan(&music, &store).await {
                        Ok(true) => {
                            info!("music folder changed");
                            changes.fetch_add(1, Ordering::Relaxed);
                        }
                        Ok(false) => {}
                        Err(e) => warn!(error = %e, "scan failed"),
                    }
                    tokio::time::sleep(SCAN_EVERY).await;
                }
            });
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
        let spotidata = spotidata::Spotidata::new(&spotidata);
        let downloads =
            downloads::Service::new(store.clone(), music.clone(), &data, push.clone(), spotidata.clone()).await?;
        downloads.spawn();
        let spotify = spotify::Spotify::new(store.clone(), music.clone(), downloads.clone(), spotidata).await?;
        spotify.spawn();

        Ok(Self {
            app: api::App {
                music,
                data,
                store,
                blobs,
                cache: Arc::default(),
                started_ms: crate::store::now_ms(),
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
