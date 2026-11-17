//! The HTTP API.
//!
//! - `GET  /api/health`
//! - `GET  /api/library`        the manifest (gzip)
//! - `GET  /api/music/{name}`   a file of the music folder, with ranges
//! - `GET  /api/blobs/{hash}`   analysis and artwork, immutable
//! - `PUT  /api/rekordbox`      a rekordbox snapshot (tar), see `rekordbox.rs`
//! - `GET  /api/catalog/search?q=`  tracks to get, marked when already here
//! - `GET  /api/downloads`      the queue, recent results and source health
//! - `POST /api/downloads`      `{track}`: get a catalog track
//! - `POST /api/downloads/{id}/retry`
//! - `DELETE /api/downloads/{id}`  stop it, or forget a finished one
//! - `POST /api/challenges/{id}`  a solved check's pass (see `Challenge`)
//! - `POST /api/devices`        a phone to notify

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
        .route("/api/downloads/{id}/retry", post(retry_download))
        .route("/api/downloads/{id}", delete(remove_download))
        .route("/api/challenges/{id}", post(solve_challenge))
        .route("/api/devices", post(register_device))
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

async fn retry_download(State(app): State<App>, Path(id): Path<i64>) -> Result<Response, Error> {
    Ok(match app.downloads.retry(id)? {
        Some(download) => Json(download).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    })
}

async fn remove_download(State(app): State<App>, Path(id): Path<i64>) -> Result<Response, Error> {
    Ok(if app.downloads.remove(id)? { StatusCode::NO_CONTENT } else { StatusCode::NOT_FOUND }.into_response())
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
