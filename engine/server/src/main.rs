//! Deckhand's server as its own process: `DECKHAND_MUSIC`, `DECKHAND_DATA`
//! and `DECKHAND_BIND` say where; see `lib.rs`.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;
use tracing::info;

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

    let bind = env("DECKHAND_BIND", "0.0.0.0:8080");
    let server = deckhand_server::Server::start(deckhand_server::Config {
        music: PathBuf::from(env("DECKHAND_MUSIC", "/music")),
        data: PathBuf::from(env("DECKHAND_DATA", "/data")),
        analysis_threads: env("DECKHAND_ANALYSIS_THREADS", "2").parse().unwrap_or(2),
        spotidata: std::env::var("DECKHAND_SPOTIDATA").ok(),
        scan_every: Duration::from_secs(20),
    })?;

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    info!(%bind, "listening");
    axum::serve(listener, server.router())
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
