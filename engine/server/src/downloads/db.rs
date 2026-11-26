//! The download queue, in `deckhand.downloads`.

use anyhow::Result;
use chrono::{DateTime, Utc};
use deckhand_model::downloads::{Attempt, CatalogTrack, Download, State};
use sqlx::types::Json;

use crate::store::{ms, Store};

/// The columns a `Record` reads.
macro_rules! columns {
    () => {
        "id, track, state, source, quality, file, error, attempts, created_at, updated_at, playlist"
    };
}

fn state_str(state: State) -> &'static str {
    match state {
        State::Queued => "queued",
        State::Searching => "searching",
        State::Downloading => "downloading",
        State::Finishing => "finishing",
        State::Waiting => "waiting",
        State::Done => "done",
        State::Failed => "failed",
        State::Cancelled => "cancelled",
    }
}

fn parse_state(s: &str) -> State {
    match s {
        "searching" => State::Searching,
        "downloading" => State::Downloading,
        "finishing" => State::Finishing,
        "waiting" => State::Waiting,
        "done" => State::Done,
        "failed" => State::Failed,
        "cancelled" => State::Cancelled,
        _ => State::Queued,
    }
}

/// A row of `downloads` as stored.
#[derive(sqlx::FromRow)]
struct Record {
    id: i64,
    track: Json<CatalogTrack>,
    state: String,
    source: Option<String>,
    quality: Option<String>,
    file: Option<String>,
    error: Option<String>,
    attempts: Json<serde_json::Value>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    playlist: Option<String>,
}

impl From<Record> for Download {
    fn from(r: Record) -> Self {
        Self {
            id: r.id,
            track: r.track.0,
            state: parse_state(&r.state),
            source: r.source,
            received: 0,
            total: None,
            quality: r.quality,
            file: r.file,
            error: r.error,
            attempts: serde_json::from_value(r.attempts.0).unwrap_or_default(),
            created_ms: ms(r.created_at),
            updated_ms: ms(r.updated_at),
            playlist: r.playlist,
        }
    }
}

/// Downloads a restart interrupted start over.
pub async fn requeue_interrupted(store: &Store) -> Result<()> {
    sqlx::query("update downloads set state = 'queued' where state in ('searching', 'downloading', 'finishing')")
        .execute(store.pool())
        .await?;
    Ok(())
}

/// Queues a track; `playlist` names the Spotify playlist that wants it.
pub async fn insert(store: &Store, track: &CatalogTrack, playlist: Option<&str>) -> Result<Download> {
    let record: Record = sqlx::query_as(concat!(
        "insert into downloads(catalog_id, track, state, playlist) values($1, $2, 'queued', $3) returning ",
        columns!()
    ))
    .bind(&track.id)
    .bind(Json(track))
    .bind(playlist)
    .fetch_one(store.pool())
    .await?;
    Ok(record.into())
}

/// A file sent from the phone, recorded as done the moment it is filed, so
/// it shows among the downloads and goes to the stick like one.
pub async fn insert_done(
    store: &Store,
    track: &CatalogTrack,
    file: &str,
    source: &str,
    quality: &str,
) -> Result<Download> {
    let record: Record = sqlx::query_as(concat!(
        "insert into downloads(catalog_id, track, state, file, source, quality) values($1, $2, 'done', $3, $4, $5)
         returning ",
        columns!()
    ))
    .bind(&track.id)
    .bind(Json(track))
    .bind(file)
    .bind(source)
    .bind(quality)
    .fetch_one(store.pool())
    .await?;
    Ok(record.into())
}

pub async fn get(store: &Store, id: i64) -> Result<Option<Download>> {
    let record: Option<Record> = sqlx::query_as(concat!("select ", columns!(), " from downloads where id = $1"))
        .bind(id)
        .fetch_optional(store.pool())
        .await?;
    Ok(record.map(Download::from))
}

/// The active download of a catalog track, if there is one.
pub async fn active_for(store: &Store, catalog_id: &str) -> Result<Option<Download>> {
    let record: Option<Record> = sqlx::query_as(concat!(
        "select ",
        columns!(),
        " from downloads where catalog_id = $1
          and state in ('queued', 'searching', 'downloading', 'finishing', 'waiting') order by id desc limit 1"
    ))
    .bind(catalog_id)
    .fetch_optional(store.pool())
    .await?;
    Ok(record.map(Download::from))
}

/// The files finished downloads of a catalog track went to, newest first.
pub async fn files_for(store: &Store, catalog_id: &str) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar(
        "select file from downloads where catalog_id = $1 and state = 'done' and file is not null order by id desc",
    )
    .bind(catalog_id)
    .fetch_all(store.pool())
    .await?)
}

/// Newest first; finished ones only from the last two weeks.
pub async fn list(store: &Store) -> Result<Vec<Download>> {
    let records: Vec<Record> = sqlx::query_as(concat!(
        "select ",
        columns!(),
        " from downloads
          where state in ('queued', 'searching', 'downloading', 'finishing', 'waiting')
             or updated_at > now() - interval '14 days'
          order by id desc limit 200"
    ))
    .fetch_all(store.pool())
    .await?;
    Ok(records.into_iter().map(Download::from).collect())
}

/// The oldest queued download not in `running`.
pub async fn next_queued(store: &Store, running: &std::collections::HashSet<i64>) -> Result<Option<i64>> {
    let running: Vec<i64> = running.iter().copied().collect();
    Ok(sqlx::query_scalar("select id from downloads where state = 'queued' and id <> all($1) order by id limit 1")
        .bind(running)
        .fetch_optional(store.pool())
        .await?)
}

pub async fn set_state(store: &Store, id: i64, state: State, source: Option<&str>) -> Result<()> {
    sqlx::query("update downloads set state = $2, source = coalesce($3, source), updated_at = now() where id = $1")
        .bind(id)
        .bind(state_str(state))
        .bind(source)
        .execute(store.pool())
        .await?;
    Ok(())
}

pub async fn set_attempts(store: &Store, id: i64, attempts: &[Attempt]) -> Result<()> {
    sqlx::query("update downloads set attempts = $2, updated_at = now() where id = $1")
        .bind(id)
        .bind(Json(attempts))
        .execute(store.pool())
        .await?;
    Ok(())
}

pub async fn done(store: &Store, id: i64, file: &str, source: &str, quality: Option<&str>) -> Result<()> {
    sqlx::query(
        "update downloads set state = 'done', file = $2, source = $3, quality = $4, error = null, updated_at = now()
         where id = $1",
    )
    .bind(id)
    .bind(file)
    .bind(source)
    .bind(quality)
    .execute(store.pool())
    .await?;
    Ok(())
}

pub async fn failed(store: &Store, id: i64, error: &str) -> Result<()> {
    sqlx::query("update downloads set state = 'failed', error = $2, source = null, updated_at = now() where id = $1")
        .bind(id)
        .bind(error)
        .execute(store.pool())
        .await?;
    Ok(())
}

/// Waiting for a check to be solved; `why` says which.
pub async fn waiting(store: &Store, id: i64, why: &str) -> Result<()> {
    sqlx::query("update downloads set state = 'waiting', error = $2, source = null, updated_at = now() where id = $1")
        .bind(id)
        .bind(why)
        .execute(store.pool())
        .await?;
    Ok(())
}

/// Every waiting download back to the queue; returns how many.
pub async fn requeue_waiting(store: &Store) -> Result<u64> {
    Ok(sqlx::query("update downloads set state = 'queued', error = null, updated_at = now() where state = 'waiting'")
        .execute(store.pool())
        .await?
        .rows_affected())
}

pub async fn count_waiting(store: &Store) -> Result<usize> {
    let n: i64 =
        sqlx::query_scalar("select count(*) from downloads where state = 'waiting'").fetch_one(store.pool()).await?;
    Ok(usize::try_from(n).unwrap_or(0))
}

/// Back to the queue, as if new.
pub async fn requeue(store: &Store, id: i64) -> Result<bool> {
    let n = sqlx::query(
        "update downloads set state = 'queued', source = null, quality = null, file = null, error = null,
             attempts = '[]', updated_at = now()
         where id = $1 and state in ('failed', 'cancelled', 'waiting')",
    )
    .bind(id)
    .execute(store.pool())
    .await?
    .rows_affected();
    Ok(n > 0)
}

pub async fn delete(store: &Store, id: i64) -> Result<bool> {
    Ok(sqlx::query("delete from downloads where id = $1").bind(id).execute(store.pool()).await?.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

    use super::*;

    fn track(id: &str) -> CatalogTrack {
        CatalogTrack {
            id: id.to_owned(),
            title: "Harder, Better, Faster, Stronger".to_owned(),
            artists: vec!["Daft Punk".to_owned()],
            album: "Discovery".to_owned(),
            isrc: Some("GBDUW0000059".to_owned()),
            duration_sec: 226,
            cover: None,
            explicit: false,
            in_library: None,
        }
    }

    #[sqlx::test(migrations = false)]
    async fn the_queue_runs_oldest_first_and_retries(_: PgPoolOptions, options: PgConnectOptions) {
        let store = crate::store::tests::store(options).await;
        let a = insert(&store, &track("deezer:1"), Some("House")).await.unwrap();
        let b = insert(&store, &track("deezer:2"), None).await.unwrap();
        assert!(b.id > a.id);
        assert_eq!(a.playlist.as_deref(), Some("House"));
        assert!((a.created_ms - crate::store::now_ms()).abs() < 60_000);
        assert_eq!(next_queued(&store, &Default::default()).await.unwrap(), Some(a.id));
        assert_eq!(next_queued(&store, &[a.id].into()).await.unwrap(), Some(b.id));
        assert_eq!(active_for(&store, "deezer:1").await.unwrap().map(|d| d.id), Some(a.id));

        let attempts = [Attempt {
            source: "deezer:x".to_owned(),
            outcome: deckhand_model::downloads::Outcome::NotFound,
            detail: "no".to_owned(),
            ms: 12,
        }];
        set_attempts(&store, a.id, &attempts).await.unwrap();
        failed(&store, a.id, "No source has this track.").await.unwrap();
        let got = get(&store, a.id).await.unwrap().unwrap();
        assert_eq!((got.state, got.attempts.len()), (State::Failed, 1));
        assert!(active_for(&store, "deezer:1").await.unwrap().is_none());
        assert!(requeue(&store, a.id).await.unwrap());
        let got = get(&store, a.id).await.unwrap().unwrap();
        assert_eq!((got.state, got.attempts.len(), got.error), (State::Queued, 0, None));

        done(&store, b.id, "b.flac", "deezer", Some("FLAC")).await.unwrap();
        assert_eq!(files_for(&store, "deezer:2").await.unwrap(), vec!["b.flac".to_owned()]);
        assert_eq!(list(&store).await.unwrap().len(), 2);
        waiting(&store, a.id, "check").await.unwrap();
        assert_eq!(count_waiting(&store).await.unwrap(), 1);
        assert_eq!(requeue_waiting(&store).await.unwrap(), 1);
        assert!(delete(&store, b.id).await.unwrap());
        assert!(get(&store, b.id).await.unwrap().is_none());
    }
}
