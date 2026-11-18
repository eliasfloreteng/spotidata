//! The HTTP API.
//!
//! - `GET  /api/health`
//! - `GET  /api/library`        the manifest (gzip)
//! - `GET  /api/music/{name}`   a file of the music folder, with ranges
//! - `GET  /api/blobs/{hash}`   analysis and artwork, immutable
//! - `PUT  /api/rekordbox`      a rekordbox snapshot (tar), see `rekordbox.rs`
//! - `GET  /api/catalog/search?q=`  tracks to get, marked when already here
//! - `GET  /api/downloads`      the queue, recent results, source health and settings
//! - `PUT  /api/downloads/settings`  `{aiff}`: file FLAC as AIFF from now on
//! - `POST /api/downloads`      `{track}`: get a catalog track
//! - `POST /api/downloads/{id}/retry`
//! - `DELETE /api/downloads/{id}`  stop it, or forget a finished one
//! - `POST /api/imports?name=`  an audio file from the phone, as the body
//! - `POST /api/challenges/{id}`  a solved check's pass (see `Challenge`)
//! - `POST /api/devices`        a phone to notify
//! - `GET  /api/spotify`        the Spotify playlists, which are kept, and the checks
//! - `PUT  /api/spotify`        `{paused}`: check only when asked, or every ten minutes
//! - `POST /api/spotify/check`  read Spotify now
//! - `GET  /api/spotify/activity?playlist=&limit=`  what the sync did, newest first
//! - `POST /api/spotify/playlists`  `{link}`: keep the playlist a link names, any playlist
//! - `GET  /api/spotify/playlists/{id}`  its tracks and where each stands
//! - `PUT  /api/spotify/playlists/{id}`  `{selected}`: keep it, or stop
//! - `POST /api/spotify/playlists/{id}/check`  read it again, retry its failed tracks now

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::{Path, Query, Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use futures_util::TryStreamExt;
use tokio::io::AsyncWriteExt;
use tower::ServiceExt;
use tower_http::compression::CompressionLayer;
use tower_http::services::ServeFile;

use crate::blobs::Blobs;
use crate::store::Store;

#[derive(Clone)]
pub struct App {
    pub music: PathBuf,
    pub data: PathBuf,
    pub store: Store,
    pub blobs: Blobs,
    /// The last manifest, with the store version it was built at.
    pub cache: Arc<Mutex<Option<(u64, Arc<Vec<u8>>)>>>,
    pub ingesting: Arc<tokio::sync::Mutex<()>>,
    pub downloads: crate::downloads::Service,
    pub spotify: crate::spotify::Spotify,
    pub push: crate::push::Push,
}

pub fn router(app: App) -> Router {
    let library = Router::new().route("/api/library", get(library)).layer(CompressionLayer::new());
    Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/music/{name}", get(music))
        .route("/api/blobs/{hash}", get(blob))
        .route("/api/rekordbox", put(rekordbox))
        .route("/api/catalog/search", get(search))
        .route("/api/downloads", get(downloads).post(add_download))
        .route("/api/downloads/settings", put(set_download_settings))
        .route("/api/downloads/{id}/retry", post(retry_download))
        .route("/api/downloads/{id}", delete(remove_download))
        .route("/api/imports", post(import))
        .route("/api/challenges/{id}", post(solve_challenge))
        .route("/api/devices", post(register_device))
        .route("/api/spotify", get(spotify).put(set_spotify))
        .route("/api/spotify/check", post(check_spotify))
        .route("/api/spotify/activity", get(spotify_activity))
        .route("/api/spotify/playlists", post(add_playlist))
        .route("/api/spotify/playlists/{id}", get(spotify_playlist).put(select_playlist))
        .route("/api/spotify/playlists/{id}/check", post(check_playlist))
        .merge(library)
        .with_state(app)
}

struct Error(anyhow::Error);

impl<E: Into<anyhow::Error>> From<E> for Error {
    fn from(e: E) -> Self {
        Self(e.into())
    }
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        tracing::warn!(error = %self.0, "request failed");
        (StatusCode::INTERNAL_SERVER_ERROR, self.0.to_string()).into_response()
    }
}

async fn library(State(app): State<App>) -> Result<Response, Error> {
    let version = app.store.version();
    let cached = app.cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
    let body = match cached {
        Some((v, body)) if v == version => body,
        _ => {
            let (music, store) = (app.music.clone(), app.store.clone());
            let lib = tokio::task::spawn_blocking(move || crate::library::build(&music, &store)).await??;
            let body = Arc::new(serde_json::to_vec(&lib)?);
            *app.cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some((version, body.clone()));
            body
        }
    };
    Ok(([(header::CONTENT_TYPE, "application/json")], Body::from(body.as_ref().clone())).into_response())
}

async fn music(State(app): State<App>, Path(name): Path<String>, req: Request) -> Result<Response, Error> {
    // Only files the store knows: no paths, no hidden files.
    if name.contains(['/', '\\']) || !deckhand_model::is_mirrored(&name) || app.store.get(&name)?.is_none() {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let response = ServeFile::new(app.music.join(&name)).oneshot(req).await?;
    Ok(response.map(Body::new))
}

async fn blob(State(app): State<App>, Path(hash): Path<String>) -> Result<Response, Error> {
    let Some(path) = app.blobs.path(&hash) else { return Ok(StatusCode::NOT_FOUND.into_response()) };
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let mut response = Body::from(bytes).into_response();
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable"));
            Ok(response)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(StatusCode::NOT_FOUND.into_response()),
        Err(e) => Err(e.into()),
    }
}

async fn rekordbox(State(app): State<App>, req: Request) -> Result<Response, Error> {
    let Ok(_guard) = app.ingesting.try_lock() else {
        return Ok((StatusCode::CONFLICT, "a snapshot is already being ingested").into_response());
    };
    let work = app.data.join("rekordbox");
    tokio::fs::create_dir_all(&work).await?;
    let archive = work.join("upload.tar");
    let mut file = tokio::fs::File::create(&archive).await?;
    let mut stream = req.into_body().into_data_stream();
    while let Some(chunk) = stream.try_next().await? {
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    drop(file);
    let (store, blobs, path) = (app.store.clone(), app.blobs.clone(), archive.clone());
    let result = tokio::task::spawn_blocking(move || crate::rekordbox::ingest(&path, &work, &store, &blobs)).await?;
    let _ = tokio::fs::remove_file(&archive).await;
    let tracks = result?;
    Ok(Json(serde_json::json!({ "tracks": tracks })).into_response())
}

#[derive(serde::Deserialize)]
struct SearchQuery {
    q: String,
    #[serde(default)]
    limit: Option<usize>,
}

async fn search(State(app): State<App>, Query(query): Query<SearchQuery>) -> Result<Response, Error> {
    let q = query.q.trim();
    if q.is_empty() {
        return Ok(Json(Vec::<deckhand_model::downloads::CatalogTrack>::new()).into_response());
    }
    match app.downloads.search(q, query.limit.unwrap_or(40)).await {
        Ok(tracks) => Ok(Json(tracks).into_response()),
        // The catalog being down is not the server failing.
        Err(e) => Ok((StatusCode::BAD_GATEWAY, format!("{e:#}")).into_response()),
    }
}

async fn downloads(State(app): State<App>) -> Result<Response, Error> {
    Ok(Json(app.downloads.list()?).into_response())
}

async fn add_download(
    State(app): State<App>,
    Json(body): Json<deckhand_model::downloads::NewDownload>,
) -> Result<Response, Error> {
    Ok((StatusCode::CREATED, Json(app.downloads.add(&body.track)?)).into_response())
}

async fn set_download_settings(
    State(app): State<App>,
    Json(settings): Json<deckhand_model::downloads::Settings>,
) -> Result<Response, Error> {
    Ok(Json(app.downloads.set_settings(settings)?).into_response())
}

async fn retry_download(State(app): State<App>, Path(id): Path<i64>) -> Result<Response, Error> {
    Ok(match app.downloads.retry(id)? {
        Some(download) => Json(download).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    })
}

async fn remove_download(State(app): State<App>, Path(id): Path<i64>) -> Result<Response, Error> {
    Ok(if app.downloads.remove(id)? { StatusCode::NO_CONTENT } else { StatusCode::NOT_FOUND }.into_response())
}

/// Hour-long WAV mixes fit; anything larger is not a track.
const MAX_IMPORT: u64 = 2 << 30;

#[derive(serde::Deserialize)]
struct ImportQuery {
    /// The file's name on the phone.
    name: String,
}

async fn import(State(app): State<App>, Query(query): Query<ImportQuery>, req: Request) -> Result<Response, Error> {
    let staged = app.downloads.staging_file()?;
    let mut file = tokio::fs::File::from_std(staged.as_file().try_clone()?);
    let mut stream = req.into_body().into_data_stream();
    let mut size = 0u64;
    while let Some(chunk) = stream.try_next().await? {
        size += chunk.len() as u64;
        if size > MAX_IMPORT {
            return Ok((StatusCode::PAYLOAD_TOO_LARGE, format!("{} is too large to be a track.", query.name))
                .into_response());
        }
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    drop(file);
    let downloads = app.downloads.clone();
    let result = tokio::task::spawn_blocking(move || downloads.import(staged.path(), &query.name)).await??;
    Ok(match result {
        Ok(imported) => {
            (if imported.added { StatusCode::CREATED } else { StatusCode::OK }, Json(imported)).into_response()
        }
        Err(why) => (StatusCode::UNPROCESSABLE_ENTITY, why).into_response(),
    })
}

async fn solve_challenge(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(solved): Json<deckhand_model::downloads::Solved>,
) -> Result<Response, Error> {
    Ok(match app.downloads.solve(&id, solved).await? {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(why) => (StatusCode::UNPROCESSABLE_ENTITY, why).into_response(),
    })
}

async fn register_device(
    State(app): State<App>,
    Json(device): Json<deckhand_model::downloads::Device>,
) -> Result<Response, Error> {
    app.push.register(&device.token, &device.environment)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn spotify(State(app): State<App>) -> Result<Response, Error> {
    Ok(Json(app.spotify.status()?).into_response())
}

async fn set_spotify(
    State(app): State<App>,
    Json(settings): Json<deckhand_model::spotify::Settings>,
) -> Result<Response, Error> {
    app.spotify.set_paused(settings.paused)?;
    Ok(Json(app.spotify.status()?).into_response())
}

async fn check_spotify(State(app): State<App>) -> Result<Response, Error> {
    app.spotify.check_soon();
    Ok(StatusCode::ACCEPTED.into_response())
}

#[derive(serde::Deserialize)]
struct ActivityQuery {
    playlist: Option<String>,
    limit: Option<usize>,
}

async fn spotify_activity(State(app): State<App>, Query(query): Query<ActivityQuery>) -> Result<Response, Error> {
    Ok(Json(app.spotify.activity(query.playlist.as_deref(), query.limit.unwrap_or(100))?).into_response())
}

async fn check_playlist(State(app): State<App>, Path(id): Path<String>) -> Result<Response, Error> {
    Ok(if app.spotify.check_playlist(&id)? {
        StatusCode::ACCEPTED.into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    })
}

async fn add_playlist(
    State(app): State<App>,
    Json(add): Json<deckhand_model::spotify::AddPlaylist>,
) -> Result<Response, Error> {
    Ok(match app.spotify.add(&add.link).await? {
        Ok(playlist) => (StatusCode::CREATED, Json(playlist)).into_response(),
        Err(why) => (StatusCode::UNPROCESSABLE_ENTITY, why).into_response(),
    })
}

async fn spotify_playlist(State(app): State<App>, Path(id): Path<String>) -> Result<Response, Error> {
    Ok(match app.spotify.playlist(&id).await? {
        Some(playlist) => Json(playlist).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    })
}

async fn select_playlist(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(selection): Json<deckhand_model::spotify::Selection>,
) -> Result<Response, Error> {
    Ok(if app.spotify.select(&id, selection.selected)? {
        app.spotify.status()?.playlists.into_iter().find(|p| p.id == id).map_or_else(
            || StatusCode::NO_CONTENT.into_response(),
            |playlist| Json(playlist).into_response(),
        )
    } else {
        StatusCode::NOT_FOUND.into_response()
    })
}
