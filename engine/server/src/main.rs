//! Deckhand's server as its own process: `DECKHAND_MUSIC`, `DECKHAND_DATA`
//! and `DECKHAND_BIND` say where, `DECKHAND_DATABASE_URL` (required) which
//! Postgres holds its state (in the schema `deckhand`), `DECKHAND_SPOTIDATA`
//! (required) where Spotidata is; see `lib.rs`.
//!
//! - `deckhand-server` serves, after bringing the schema up to date;
//! - `deckhand-server migrate` only brings the schema up to date.

use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use tracing::info;

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_owned())
}

fn required(name: &str, why: &str) -> Result<String> {
    std::env::var(name).ok().filter(|s| !s.trim().is_empty()).with_context(|| format!("{name} must be set to {why}"))
}

fn database() -> Result<String> {
    required("DECKHAND_DATABASE_URL", "the Postgres database the server keeps its state in (postgres://…)")
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,tower_http=warn,sqlx=warn".into()),
        )
        .init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        [] => serve().await,
        ["migrate"] => {
            deckhand_server::migrate(&database()?).await?;
            info!("the deckhand schema is up to date");
            Ok(())
        }
        _ => bail!("usage: deckhand-server [migrate]"),
    }
}

async fn serve() -> Result<()> {
    let bind = env("DECKHAND_BIND", "0.0.0.0:8080");
    let spotidata = required("DECKHAND_SPOTIDATA", "Spotidata's address, which Spotify is read through")?;
    let server = deckhand_server::Server::start(deckhand_server::Config {
        music: PathBuf::from(env("DECKHAND_MUSIC", "/music")),
        data: PathBuf::from(env("DECKHAND_DATA", "/data")),
        analysis_threads: env("DECKHAND_ANALYSIS_THREADS", "2").parse().unwrap_or(2),
        spotidata,
        database: database()?,
    })
    .await?;

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    info!(%bind, "listening");
    axum::serve(listener, server.router())
        .with_graceful_shutdown(async {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
        })
        .await?;
    Ok(())
}
