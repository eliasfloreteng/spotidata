//! The download queue in SQLite.

use anyhow::Result;
use deckhand_model::downloads::{Attempt, CatalogTrack, Download, State};
use rusqlite::{params, OptionalExtension};

use crate::store::{now_ms, Store};

const COLUMNS: &str = "id, track, state, source, quality, file, error, attempts, created_ms, updated_ms, playlist";

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

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Download> {
    let track: String = r.get(1)?;
    let state: String = r.get(2)?;
    let attempts: String = r.get(7)?;
    Ok(Download {
        id: r.get(0)?,
        track: serde_json::from_str(&track).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?,
        state: parse_state(&state),
        source: r.get(3)?,
        received: 0,
        total: None,
        quality: r.get(4)?,
        file: r.get(5)?,
        error: r.get(6)?,
        attempts: serde_json::from_str(&attempts).unwrap_or_default(),
        created_ms: r.get(8)?,
        updated_ms: r.get(9)?,
        playlist: r.get(10)?,
    })
}

/// Queues a track; `playlist` names the Spotify playlist that wants it.
pub fn insert(store: &Store, track: &CatalogTrack, playlist: Option<&str>) -> Result<Download> {
    let now = now_ms();
    let conn = store.conn();
    conn.execute(
        "insert into downloads(catalog_id, track, state, created_ms, updated_ms, playlist)
         values(?1, ?2, 'queued', ?3, ?3, ?4)",
        params![track.id, serde_json::to_string(track)?, now, playlist],
    )?;
    let id = conn.last_insert_rowid();
    Ok(conn.query_row(&format!("select {COLUMNS} from downloads where id = ?1"), params![id], row)?)
}

/// A file sent from the phone, recorded as done the moment it is filed, so
/// it shows among the downloads and goes to the stick like one.
pub fn insert_done(store: &Store, track: &CatalogTrack, file: &str, source: &str, quality: &str) -> Result<Download> {
    let now = now_ms();
    let conn = store.conn();
    conn.execute(
        "insert into downloads(catalog_id, track, state, file, source, quality, created_ms, updated_ms)
         values(?1, ?2, 'done', ?3, ?4, ?5, ?6, ?6)",
        params![track.id, serde_json::to_string(track)?, file, source, quality, now],
    )?;
    let id = conn.last_insert_rowid();
    Ok(conn.query_row(&format!("select {COLUMNS} from downloads where id = ?1"), params![id], row)?)
}

pub fn get(store: &Store, id: i64) -> Result<Option<Download>> {
    Ok(store
        .conn()
        .query_row(&format!("select {COLUMNS} from downloads where id = ?1"), params![id], row)
        .optional()?)
}

/// The active download of a catalog track, if there is one.
pub fn active_for(store: &Store, catalog_id: &str) -> Result<Option<Download>> {
    Ok(store
        .conn()
        .query_row(
            &format!(
                "select {COLUMNS} from downloads where catalog_id = ?1
                 and state in ('queued', 'searching', 'downloading', 'finishing', 'waiting') order by id desc limit 1"
            ),
            params![catalog_id],
            row,
        )
        .optional()?)
}

/// The files finished downloads of a catalog track went to, newest first.
pub fn files_for(store: &Store, catalog_id: &str) -> Result<Vec<String>> {
    let conn = store.conn();
    let mut stmt = conn.prepare(
        "select file from downloads where catalog_id = ?1 and state = 'done' and file is not null order by id desc",
    )?;
    let files = stmt.query_map(params![catalog_id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    Ok(files)
}

/// Newest first; finished ones only from the last two weeks.
pub fn list(store: &Store) -> Result<Vec<Download>> {
    let since = now_ms() - 14 * 24 * 3600 * 1000;
    let conn = store.conn();
    let mut stmt = conn.prepare(&format!(
        "select {COLUMNS} from downloads
         where state in ('queued', 'searching', 'downloading', 'finishing', 'waiting') or updated_ms > ?1
         order by id desc limit 200"
    ))?;
    let rows = stmt.query_map(params![since], row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The oldest queued download not in `running`.
pub fn next_queued(store: &Store, running: &std::collections::HashSet<i64>) -> Result<Option<i64>> {
    let conn = store.conn();
    let mut stmt = conn.prepare("select id from downloads where state = 'queued' order by id")?;
    let ids = stmt.query_map([], |r| r.get::<_, i64>(0))?;
    for id in ids {
        let id = id?;
        if !running.contains(&id) {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

pub fn set_state(store: &Store, id: i64, state: State, source: Option<&str>) -> Result<()> {
    store.conn().execute(
        "update downloads set state = ?2, source = coalesce(?3, source), updated_ms = ?4 where id = ?1",
        params![id, state_str(state), source, now_ms()],
    )?;
    Ok(())
}

pub fn set_attempts(store: &Store, id: i64, attempts: &[Attempt]) -> Result<()> {
    store.conn().execute(
        "update downloads set attempts = ?2, updated_ms = ?3 where id = ?1",
        params![id, serde_json::to_string(attempts)?, now_ms()],
    )?;
    Ok(())
}

pub fn done(store: &Store, id: i64, file: &str, source: &str, quality: Option<&str>) -> Result<()> {
    store.conn().execute(
        "update downloads set state = 'done', file = ?2, source = ?3, quality = ?4, error = null, updated_ms = ?5 where id = ?1",
        params![id, file, source, quality, now_ms()],
    )?;
    Ok(())
}

pub fn failed(store: &Store, id: i64, error: &str) -> Result<()> {
    store.conn().execute(
        "update downloads set state = 'failed', error = ?2, source = null, updated_ms = ?3 where id = ?1",
        params![id, error, now_ms()],
    )?;
    Ok(())
}

/// Waiting for a check to be solved; `why` says which.
pub fn waiting(store: &Store, id: i64, why: &str) -> Result<()> {
    store.conn().execute(
        "update downloads set state = 'waiting', error = ?2, source = null, updated_ms = ?3 where id = ?1",
        params![id, why, now_ms()],
    )?;
    Ok(())
}

/// Every waiting download back to the queue; returns how many.
pub fn requeue_waiting(store: &Store) -> Result<usize> {
    Ok(store.conn().execute(
        "update downloads set state = 'queued', error = null, updated_ms = ?1 where state = 'waiting'",
        params![now_ms()],
    )?)
}

pub fn count_waiting(store: &Store) -> Result<usize> {
    let n: i64 = store.conn().query_row("select count(*) from downloads where state = 'waiting'", [], |r| r.get(0))?;
    Ok(usize::try_from(n).unwrap_or(0))
}

/// Back to the queue, as if new.
pub fn requeue(store: &Store, id: i64) -> Result<bool> {
    let n = store.conn().execute(
        "update downloads set state = 'queued', source = null, quality = null, file = null, error = null,
             attempts = '[]', updated_ms = ?2
         where id = ?1 and state in ('failed', 'cancelled', 'waiting')",
        params![id, now_ms()],
    )?;
    Ok(n > 0)
}

pub fn delete(store: &Store, id: i64) -> Result<bool> {
    Ok(store.conn().execute("delete from downloads where id = ?1", params![id])? > 0)
}
