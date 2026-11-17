//! Deckhand's server: watches the music folder, analyses new tracks, and
//! serves the library to the phone that syncs the DJ stick.

mod analyse;
mod api;
mod blobs;
mod downloads;
mod library;
mod push;
mod rekordbox;
mod scan;
mod store;
mod tags;
mod worker;

use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;
use tracing::{info, warn};

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_owned())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,tower_http=warn".into()),
        )
        .init();

    let music = PathBuf::from(env("DECKHAND_MUSIC", "/music"));
    let data = PathBuf::from(env("DECKHAND_DATA", "/data"));
    let bind = env("DECKHAND_BIND", "0.0.0.0:8080");
    let threads: usize = env("DECKHAND_ANALYSIS_THREADS", "2").parse().unwrap_or(2);
    std::fs::create_dir_all(&data)?;

    let store = store::Store::open(&data.join("deckhand.db"))?;
    let blobs = blobs::Blobs::new(data.join("blobs"))?;

    {
        let (music, store) = (music.clone(), store.clone());
        std::thread::Builder::new().name("scan".into()).spawn(move || loop {
            match scan::scan(&music, &store) {
                Ok(true) => info!("music folder changed"),
                Ok(false) => {}
                Err(e) => warn!(error = %e, "scan failed"),
            }
            std::thread::sleep(Duration::from_secs(20));
        })?;
    }
    worker::spawn(threads, music.clone(), store.clone(), blobs.clone());

    let push = push::Push::new(store.clone());
    let downloads = downloads::Service::new(store.clone(), music.clone(), &data, push.clone())?;
    downloads.spawn();

    let app = api::App {
        music,
        data,
        store,
        blobs,
        cache: std::sync::Arc::default(),
        ingesting: std::sync::Arc::default(),
        downloads,
        push,
    };
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    info!(%bind, "listening");
    axum::serve(listener, api::router(app))
        .with_graceful_shutdown(async {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("SIGTERM handler");
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
        })
        .await?;
    Ok(())
}
