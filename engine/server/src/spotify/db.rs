//! What the server knows about the Spotify playlists, in SQLite.

use anyhow::Result;
use rusqlite::{params, OptionalExtension};

use deckhand_model::spotify::{Activity, ActivityKind};

use super::remote::{RemotePlaylist, RemoteTrack};
use crate::store::{now_ms, Store};

pub fn migrate(store: &Store) -> Result<()> {
    store.conn().execute_batch(
        "create table if not exists spotify_playlists(
             id text primary key,
             name text not null,
             owner text not null default '',
             owned integer not null default 0,
             image text,
             total integer not null default 0,
             snapshot text not null default '',
             position integer not null default 0,
             gone integer not null default 0,
             selected integer not null default 0,
             read_snapshot text,
             read_ms integer,
             file text,
             file_hash text,
             error text
         );
         create table if not exists spotify_tracks(
             playlist text not null,
             position integer not null,
             track text not null,
             primary key(playlist, position)
         );
         create table if not exists spotify_links(
             key text primary key,
             download integer not null
         );
         create table if not exists spotify_activity(
             id integer primary key,
             ms integer not null,
             kind text not null,
             playlist text,
             name text,
             count integer not null default 0,
             added integer not null default 0,
             removed integer not null default 0,
             detail text
         );",
    )?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct Row {
    pub id: String,
    pub name: String,
    pub owner: String,
    pub owned: bool,
    pub image: Option<String>,
    pub total: usize,
    pub snapshot: String,
    pub gone: bool,
    pub selected: bool,
    pub read_snapshot: Option<String>,
    pub read_ms: Option<i64>,
    pub file: Option<String>,
    pub file_hash: Option<String>,
    pub error: Option<String>,
}

const COLUMNS: &str =
    "id, name, owner, owned, image, total, snapshot, gone, selected, read_snapshot, read_ms, file, file_hash, error";

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok(Row {
        id: r.get(0)?,
        name: r.get(1)?,
        owner: r.get(2)?,
        owned: r.get(3)?,
        image: r.get(4)?,
        total: usize::try_from(r.get::<_, i64>(5)?).unwrap_or(0),
        snapshot: r.get(6)?,
        gone: r.get(7)?,
        selected: r.get(8)?,
        read_snapshot: r.get(9)?,
        read_ms: r.get(10)?,
        file: r.get(11)?,
        file_hash: r.get(12)?,
        error: r.get(13)?,
    })
}

/// Every playlist, in the account's order; gone ones last.
pub fn all(store: &Store) -> Result<Vec<Row>> {
    let conn = store.conn();
    let mut stmt = conn.prepare(&format!("select {COLUMNS} from spotify_playlists order by gone, position"))?;
    let rows = stmt.query_map([], row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get(store: &Store, id: &str) -> Result<Option<Row>> {
    Ok(store
        .conn()
        .query_row(&format!("select {COLUMNS} from spotify_playlists where id = ?1"), params![id], row)
        .optional()?)
}

/// Records the account's playlists as Spotify lists them now; the rest are
/// marked gone.
pub fn replace_list(store: &Store, list: &[RemotePlaylist]) -> Result<()> {
    let mut conn = store.conn();
    let tx = conn.transaction()?;
    tx.execute("update spotify_playlists set gone = 1", [])?;
    for (position, p) in list.iter().enumerate() {
        tx.execute(
            "insert into spotify_playlists(id, name, owner, owned, image, total, snapshot, position, gone)
             values(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)
             on conflict(id) do update set name = ?2, owner = ?3, owned = ?4, image = ?5, total = ?6,
                 snapshot = ?7, position = ?8, gone = 0",
            params![
                p.id,
                p.name,
                p.owner,
                p.owned,
                p.image,
                i64::try_from(p.tracks).unwrap_or(0),
                p.snapshot_id,
                i64::try_from(position).unwrap_or(0)
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Whether the playlist exists; selecting an unknown one is refused.
pub fn select(store: &Store, id: &str, selected: bool) -> Result<bool> {
    Ok(store.conn().execute(
        "update spotify_playlists set selected = ?2, error = case when ?2 then error else null end where id = ?1",
        params![id, selected],
    )? > 0)
}

pub fn tracks(store: &Store, id: &str) -> Result<Vec<RemoteTrack>> {
    let conn = store.conn();
    let mut stmt = conn.prepare("select track from spotify_tracks where playlist = ?1 order by position")?;
    let rows = stmt.query_map(params![id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.iter().filter_map(|json| serde_json::from_str(json).ok()).collect())
}

/// Stores a playlist's tracks as read at `snapshot`.
pub fn replace_tracks(store: &Store, id: &str, snapshot: &str, tracks: &[RemoteTrack]) -> Result<()> {
    let mut conn = store.conn();
    let tx = conn.transaction()?;
    tx.execute("delete from spotify_tracks where playlist = ?1", params![id])?;
    for (position, track) in tracks.iter().enumerate() {
        tx.execute(
            "insert into spotify_tracks(playlist, position, track) values(?1, ?2, ?3)",
            params![id, i64::try_from(position).unwrap_or(0), serde_json::to_string(track)?],
        )?;
    }
    tx.execute(
        "update spotify_playlists set read_snapshot = ?2, read_ms = ?3, error = null where id = ?1",
        params![id, snapshot, now_ms()],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn set_error(store: &Store, id: &str, error: Option<&str>) -> Result<()> {
    store.conn().execute("update spotify_playlists set error = ?2 where id = ?1", params![id, error])?;
    Ok(())
}

/// The playlist file written for it, and a hash of what was written.
pub fn set_file(store: &Store, id: &str, file: Option<&str>, hash: Option<&str>) -> Result<()> {
    store
        .conn()
        .execute("update spotify_playlists set file = ?2, file_hash = ?3 where id = ?1", params![id, file, hash])?;
    Ok(())
}

/// The download last started for a recording.
pub fn link(store: &Store, key: &str) -> Result<Option<i64>> {
    Ok(store
        .conn()
        .query_row("select download from spotify_links where key = ?1", params![key], |r| r.get(0))
        .optional()?)
}

pub fn set_link(store: &Store, key: &str, download: i64) -> Result<()> {
    store.conn().execute(
        "insert into spotify_links(key, download) values(?1, ?2) on conflict(key) do update set download = ?2",
        params![key, download],
    )?;
    Ok(())
}

/// Entries kept; older ones go.
const ACTIVITY_KEPT: i64 = 500;
/// Repeats of a counted kind for one playlist within this are one entry.
const MERGE_WITHIN_MS: i64 = 30 * 60 * 1000;

/// What a new entry says.
#[derive(Debug, Clone, Default)]
pub struct Event<'a> {
    pub playlist: Option<(&'a str, &'a str)>,
    pub count: usize,
    pub added: usize,
    pub removed: usize,
    pub detail: Option<&'a str>,
}

fn kind_name(kind: ActivityKind) -> String {
    serde_json::to_value(kind).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

/// Records what the sync did. Queued, retried and landed tracks of one
/// playlist add up in one entry while they keep coming.
pub fn log(store: &Store, kind: ActivityKind, event: &Event<'_>) -> Result<()> {
    let now = now_ms();
    let name = kind_name(kind);
    let (playlist, playlist_name) = event.playlist.unzip();
    let count = i64::try_from(event.count).unwrap_or(0);
    let mut conn = store.conn();
    let tx = conn.transaction()?;
    let merged = matches!(kind, ActivityKind::Queued | ActivityKind::Retried | ActivityKind::Landed)
        && tx.execute(
            "update spotify_activity set count = count + ?4, ms = ?5, name = ?3
             where id = (select max(id) from spotify_activity where playlist is ?2)
               and kind = ?1 and ms > ?5 - ?6",
            params![name, playlist, playlist_name, count, now, MERGE_WITHIN_MS],
        )? > 0;
    if !merged {
        tx.execute(
            "insert into spotify_activity(ms, kind, playlist, name, count, added, removed, detail)
             values(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                now,
                name,
                playlist,
                playlist_name,
                count,
                i64::try_from(event.added).unwrap_or(0),
                i64::try_from(event.removed).unwrap_or(0),
                event.detail
            ],
        )?;
        tx.execute(
            "delete from spotify_activity where id <= (select max(id) from spotify_activity) - ?1",
            params![ACTIVITY_KEPT],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// The newest entries first, for one playlist or all.
pub fn activity(store: &Store, playlist: Option<&str>, limit: usize) -> Result<Vec<Activity>> {
    let conn = store.conn();
    let mut stmt = conn.prepare(
        "select id, ms, kind, playlist, name, count, added, removed, detail from spotify_activity
         where ?1 is null or playlist = ?1 order by id desc limit ?2",
    )?;
    let rows = stmt
        .query_map(params![playlist, i64::try_from(limit).unwrap_or(100)], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, i64>(7)?,
                r.get::<_, Option<String>>(8)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let count = |n: i64| usize::try_from(n).unwrap_or(0);
    Ok(rows
        .into_iter()
        .filter_map(|(id, ms, kind, playlist, name, n, added, removed, detail)| {
            let kind = serde_json::from_value(serde_json::Value::String(kind)).ok()?;
            Some(Activity {
                id,
                ms,
                kind,
                playlist,
                name,
                count: count(n),
                added: count(added),
                removed: count(removed),
                detail,
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeats_close_together_add_up() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("t.db")).unwrap();
        migrate(&store).unwrap();
        let house = Event { playlist: Some(("p1", "House")), count: 3, ..Event::default() };
        log(&store, ActivityKind::Queued, &house).unwrap();
        log(&store, ActivityKind::Queued, &Event { count: 2, ..house.clone() }).unwrap();
        log(&store, ActivityKind::Landed, &Event { count: 1, ..house.clone() }).unwrap();
        log(&store, ActivityKind::Landed, &Event { count: 4, ..house.clone() }).unwrap();
        // Not merged: something else for the playlist came in between.
        log(&store, ActivityKind::Queued, &Event { count: 1, ..house.clone() }).unwrap();
        log(&store, ActivityKind::Failed, &Event { detail: Some("down"), ..Event::default() }).unwrap();
        let all = activity(&store, None, 10).unwrap();
        let summary: Vec<_> = all.iter().map(|a| (a.kind, a.count)).collect();
        assert_eq!(
            summary,
            vec![
                (ActivityKind::Failed, 0),
                (ActivityKind::Queued, 1),
                (ActivityKind::Landed, 5),
                (ActivityKind::Queued, 5)
            ]
        );
        assert_eq!(activity(&store, Some("p1"), 10).unwrap().len(), 3);
    }
}
