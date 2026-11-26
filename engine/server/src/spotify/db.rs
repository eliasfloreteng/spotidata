//! What the server knows about the Spotify playlists, in `deckhand.spotify_*`.

use anyhow::Result;
use chrono::{DateTime, Utc};
use sqlx::types::Json;

use deckhand_model::spotify::{Activity, ActivityKind};

use super::remote::{RemotePlaylist, RemoteTrack};
use crate::store::{ms, Store};

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
    /// Added by its link (when), rather than picked from the account's
    /// list: kept and read whether or not the account lists it.
    pub linked_ms: Option<i64>,
}

/// A row of `spotify_playlists` as stored.
#[derive(sqlx::FromRow)]
struct Record {
    id: String,
    name: String,
    owner: String,
    owned: bool,
    image: Option<String>,
    total: i32,
    snapshot: String,
    gone: bool,
    selected: bool,
    read_snapshot: Option<String>,
    read_at: Option<DateTime<Utc>>,
    file: Option<String>,
    file_hash: Option<String>,
    error: Option<String>,
    linked_at: Option<DateTime<Utc>>,
}

impl From<Record> for Row {
    fn from(r: Record) -> Self {
        Self {
            id: r.id,
            name: r.name,
            owner: r.owner,
            owned: r.owned,
            image: r.image,
            total: usize::try_from(r.total).unwrap_or(0),
            snapshot: r.snapshot,
            gone: r.gone,
            selected: r.selected,
            read_snapshot: r.read_snapshot,
            read_ms: r.read_at.map(ms),
            file: r.file,
            file_hash: r.file_hash,
            error: r.error,
            linked_ms: r.linked_at.map(ms),
        }
    }
}

macro_rules! columns {
    () => {
        "id, name, owner, owned, image, total, snapshot, gone, selected, read_snapshot, read_at, file, file_hash, error, linked_at"
    };
}

fn count(n: usize) -> i32 {
    i32::try_from(n).unwrap_or(i32::MAX)
}

/// Every playlist, in the account's order; gone ones last.
pub async fn all(store: &Store) -> Result<Vec<Row>> {
    let rows: Vec<Record> =
        sqlx::query_as(concat!("select ", columns!(), " from spotify_playlists order by gone, position, id"))
            .fetch_all(store.pool())
            .await?;
    Ok(rows.into_iter().map(Row::from).collect())
}

pub async fn get(store: &Store, id: &str) -> Result<Option<Row>> {
    let row: Option<Record> = sqlx::query_as(concat!("select ", columns!(), " from spotify_playlists where id = $1"))
        .bind(id)
        .fetch_optional(store.pool())
        .await?;
    Ok(row.map(Row::from))
}

/// Records the account's playlists as Spotify lists them now; the rest are
/// marked gone, but for those added by their link, which follow the list.
pub async fn replace_list(store: &Store, list: &[RemotePlaylist]) -> Result<()> {
    let mut tx = store.pool().begin().await?;
    sqlx::query("update spotify_playlists set gone = true where linked_at is null").execute(&mut *tx).await?;
    for (position, p) in list.iter().enumerate() {
        sqlx::query(
            "insert into spotify_playlists(id, name, owner, owned, image, total, snapshot, position, gone)
             values($1, $2, $3, $4, $5, $6, $7, $8, false)
             on conflict(id) do update set name = $2, owner = $3, owned = $4, image = $5, total = $6,
                 snapshot = $7, position = $8, gone = false",
        )
        .bind(&p.id)
        .bind(&p.name)
        .bind(&p.owner)
        .bind(p.owned)
        .bind(&p.image)
        .bind(count(p.tracks))
        .bind(&p.snapshot_id)
        .bind(count(position))
        .execute(&mut *tx)
        .await?;
    }
    let ids: Vec<&str> = list.iter().map(|p| p.id.as_str()).collect();
    let unlisted: Vec<String> = sqlx::query_scalar(
        "select id from spotify_playlists where linked_at is not null and id <> all($1) order by linked_at, id",
    )
    .bind(&ids)
    .fetch_all(&mut *tx)
    .await?;
    for (n, id) in unlisted.iter().enumerate() {
        sqlx::query("update spotify_playlists set position = $2 where id = $1")
            .bind(id)
            .bind(count(list.len() + n))
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// A playlist added by its link: kept from now on, after the account's own.
pub async fn add_linked(store: &Store, p: &RemotePlaylist) -> Result<()> {
    sqlx::query(
        "insert into spotify_playlists(id, name, owner, owned, image, total, snapshot, position, gone, selected, linked_at)
         values($1, $2, $3, $4, $5, $6, $7, (select coalesce(max(position), -1) + 1 from spotify_playlists),
             false, true, now())
         on conflict(id) do update set name = $2, owner = $3, owned = $4, image = $5, total = $6, snapshot = $7,
             gone = false, selected = true, linked_at = coalesce(spotify_playlists.linked_at, now())",
    )
    .bind(&p.id)
    .bind(&p.name)
    .bind(&p.owner)
    .bind(p.owned)
    .bind(&p.image)
    .bind(count(p.tracks))
    .bind(&p.snapshot_id)
    .execute(store.pool())
    .await?;
    Ok(())
}

/// A playlist added by its link, as Spotify describes it now.
pub async fn update_info(store: &Store, p: &RemotePlaylist) -> Result<()> {
    sqlx::query(
        "update spotify_playlists set name = $2, owner = $3, owned = $4, image = $5, total = $6, snapshot = $7,
             gone = false
         where id = $1",
    )
    .bind(&p.id)
    .bind(&p.name)
    .bind(&p.owner)
    .bind(p.owned)
    .bind(&p.image)
    .bind(count(p.tracks))
    .bind(&p.snapshot_id)
    .execute(store.pool())
    .await?;
    Ok(())
}

/// Spotify no longer shows a playlist added by its link.
pub async fn set_gone(store: &Store, id: &str) -> Result<()> {
    sqlx::query("update spotify_playlists set gone = true where id = $1").bind(id).execute(store.pool()).await?;
    Ok(())
}

/// Whether the playlist exists; selecting an unknown one is refused. One
/// added by its link that you stop keeping is the account's again: it
/// stays listed only if the account lists it.
pub async fn select(store: &Store, id: &str, selected: bool) -> Result<bool> {
    Ok(sqlx::query(
        "update spotify_playlists set selected = $2,
             error = case when $2 then error end,
             linked_at = case when $2 then linked_at end
         where id = $1",
    )
    .bind(id)
    .bind(selected)
    .execute(store.pool())
    .await?
    .rows_affected()
        > 0)
}

pub async fn tracks(store: &Store, id: &str) -> Result<Vec<RemoteTrack>> {
    let rows: Vec<Json<serde_json::Value>> =
        sqlx::query_scalar("select track from spotify_tracks where playlist = $1 order by position")
            .bind(id)
            .fetch_all(store.pool())
            .await?;
    Ok(rows.into_iter().filter_map(|Json(track)| serde_json::from_value(track).ok()).collect())
}

/// Stores a playlist's tracks as read at `snapshot`.
pub async fn replace_tracks(store: &Store, id: &str, snapshot: &str, tracks: &[RemoteTrack]) -> Result<()> {
    let mut tx = store.pool().begin().await?;
    sqlx::query("delete from spotify_tracks where playlist = $1").bind(id).execute(&mut *tx).await?;
    let json = tracks.iter().map(serde_json::to_string).collect::<serde_json::Result<Vec<_>>>()?;
    sqlx::query(
        "insert into spotify_tracks(playlist, position, track)
         select $1, t.position - 1, t.track::jsonb from unnest($2::text[]) with ordinality as t(track, position)",
    )
    .bind(id)
    .bind(&json)
    .execute(&mut *tx)
    .await?;
    sqlx::query("update spotify_playlists set read_snapshot = $2, read_at = now(), error = null where id = $1")
        .bind(id)
        .bind(snapshot)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn set_error(store: &Store, id: &str, error: Option<&str>) -> Result<()> {
    sqlx::query("update spotify_playlists set error = $2 where id = $1")
        .bind(id)
        .bind(error)
        .execute(store.pool())
        .await?;
    Ok(())
}

/// The playlist file written for it, and a hash of what was written.
pub async fn set_file(store: &Store, id: &str, file: Option<&str>, hash: Option<&str>) -> Result<()> {
    sqlx::query("update spotify_playlists set file = $2, file_hash = $3 where id = $1")
        .bind(id)
        .bind(file)
        .bind(hash)
        .execute(store.pool())
        .await?;
    Ok(())
}

/// The download last started for a recording.
pub async fn link(store: &Store, key: &str) -> Result<Option<i64>> {
    Ok(sqlx::query_scalar("select download from spotify_links where key = $1")
        .bind(key)
        .fetch_optional(store.pool())
        .await?)
}

pub async fn set_link(store: &Store, key: &str, download: i64) -> Result<()> {
    sqlx::query("insert into spotify_links(key, download) values($1, $2) on conflict(key) do update set download = $2")
        .bind(key)
        .bind(download)
        .execute(store.pool())
        .await?;
    Ok(())
}

/// Entries kept; older ones go.
const ACTIVITY_KEPT: i64 = 500;

/// What a new entry says.
#[derive(Debug, Clone, Default)]
pub struct Event<'a> {
    pub playlist: Option<(&'a str, &'a str)>,
    pub count: usize,
    pub added: usize,
    pub removed: usize,
    pub detail: Option<&'a str>,
}

pub fn kind_name(kind: ActivityKind) -> String {
    serde_json::to_value(kind).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

/// Records what the sync did. Queued, retried and landed tracks of one
/// playlist add up in one entry while they keep coming (half an hour).
pub async fn log(store: &Store, kind: ActivityKind, event: &Event<'_>) -> Result<()> {
    let name = kind_name(kind);
    let (playlist, playlist_name) = event.playlist.unzip();
    let mut tx = store.pool().begin().await?;
    let merged = matches!(kind, ActivityKind::Queued | ActivityKind::Retried | ActivityKind::Landed)
        && sqlx::query(
            "update spotify_activity set count = count + $4, at = now(), name = $3
             where id = (select max(id) from spotify_activity where playlist is not distinct from $2)
               and kind = $1 and at > now() - interval '30 minutes'",
        )
        .bind(&name)
        .bind(playlist)
        .bind(playlist_name)
        .bind(count(event.count))
        .execute(&mut *tx)
        .await?
        .rows_affected()
            > 0;
    if !merged {
        sqlx::query(
            "insert into spotify_activity(kind, playlist, name, count, added, removed, detail)
             values($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(&name)
        .bind(playlist)
        .bind(playlist_name)
        .bind(count(event.count))
        .bind(count(event.added))
        .bind(count(event.removed))
        .bind(event.detail)
        .execute(&mut *tx)
        .await?;
        sqlx::query("delete from spotify_activity where id <= (select max(id) from spotify_activity) - $1")
            .bind(ACTIVITY_KEPT)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// The newest entries first, for one playlist or all.
pub async fn activity(store: &Store, playlist: Option<&str>, limit: usize) -> Result<Vec<Activity>> {
    #[derive(sqlx::FromRow)]
    struct Entry {
        id: i64,
        at: DateTime<Utc>,
        kind: String,
        playlist: Option<String>,
        name: Option<String>,
        count: i32,
        added: i32,
        removed: i32,
        detail: Option<String>,
    }
    let rows: Vec<Entry> = sqlx::query_as(
        "select id, at, kind, playlist, name, count, added, removed, detail from spotify_activity
         where $1::text is null or playlist = $1 order by id desc limit $2",
    )
    .bind(playlist)
    .bind(i64::try_from(limit).unwrap_or(100))
    .fetch_all(store.pool())
    .await?;
    let count = |n: i32| usize::try_from(n).unwrap_or(0);
    Ok(rows
        .into_iter()
        .filter_map(|e| {
            let kind = serde_json::from_value(serde_json::Value::String(e.kind)).ok()?;
            Some(Activity {
                id: e.id,
                ms: ms(e.at),
                kind,
                playlist: e.playlist,
                name: e.name,
                count: count(e.count),
                added: count(e.added),
                removed: count(e.removed),
                detail: e.detail,
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

    use super::*;

    fn remote(id: &str) -> RemotePlaylist {
        RemotePlaylist {
            id: id.to_owned(),
            name: id.to_owned(),
            owner: String::new(),
            owned: false,
            snapshot_id: "s1".to_owned(),
            tracks: 0,
            image: None,
        }
    }

    #[sqlx::test(migrations = false)]
    async fn linked_playlists_outlast_the_list(_: PgPoolOptions, options: PgConnectOptions) {
        let store = crate::store::tests::store(options).await;
        replace_list(&store, &[remote("a"), remote("b")]).await.unwrap();
        add_linked(&store, &remote("x")).await.unwrap();
        // Also the account's: still kept by its link once it isn't.
        add_linked(&store, &remote("b")).await.unwrap();
        replace_list(&store, &[remote("a")]).await.unwrap();
        let rows = all(&store).await.unwrap();
        let shown: Vec<_> = rows.iter().map(|p| (p.id.as_str(), p.gone, p.selected)).collect();
        // The linked ones after the account's, in the order they were linked.
        assert_eq!(shown, vec![("a", false, false), ("x", false, true), ("b", false, true)]);
        // Stopped: the account's again, so gone at the next list.
        select(&store, "x", false).await.unwrap();
        replace_list(&store, &[remote("a")]).await.unwrap();
        let x = get(&store, "x").await.unwrap().unwrap();
        assert!(x.gone && x.linked_ms.is_none());
    }

    #[sqlx::test(migrations = false)]
    async fn tracks_keep_spotifys_order(_: PgPoolOptions, options: PgConnectOptions) {
        let store = crate::store::tests::store(options).await;
        replace_list(&store, &[remote("a")]).await.unwrap();
        let track = |id: &str| RemoteTrack {
            id: Some(id.to_owned()),
            title: id.to_owned(),
            artists: vec![],
            album: String::new(),
            isrc: None,
            duration_ms: 1000,
            cover: None,
        };
        replace_tracks(&store, "a", "s1", &[track("t2"), track("t1"), track("t3")]).await.unwrap();
        let ids: Vec<_> = tracks(&store, "a").await.unwrap().into_iter().filter_map(|t| t.id).collect();
        assert_eq!(ids, ["t2", "t1", "t3"]);
        let row = get(&store, "a").await.unwrap().unwrap();
        assert_eq!(row.read_snapshot.as_deref(), Some("s1"));
        assert!(row.read_ms.is_some());
        replace_tracks(&store, "a", "s2", &[]).await.unwrap();
        assert!(tracks(&store, "a").await.unwrap().is_empty());
    }

    #[sqlx::test(migrations = false)]
    async fn repeats_close_together_add_up(_: PgPoolOptions, options: PgConnectOptions) {
        let store = crate::store::tests::store(options).await;
        replace_list(&store, &[remote("p1")]).await.unwrap();
        let house = Event { playlist: Some(("p1", "House")), count: 3, ..Event::default() };
        log(&store, ActivityKind::Queued, &house).await.unwrap();
        log(&store, ActivityKind::Queued, &Event { count: 2, ..house.clone() }).await.unwrap();
        log(&store, ActivityKind::Landed, &Event { count: 1, ..house.clone() }).await.unwrap();
        log(&store, ActivityKind::Landed, &Event { count: 4, ..house.clone() }).await.unwrap();
        // Not merged: something else for the playlist came in between.
        log(&store, ActivityKind::Queued, &Event { count: 1, ..house.clone() }).await.unwrap();
        log(&store, ActivityKind::Failed, &Event { detail: Some("down"), ..Event::default() }).await.unwrap();
        let all = activity(&store, None, 10).await.unwrap();
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
        assert_eq!(activity(&store, Some("p1"), 10).await.unwrap().len(), 3);
    }
}
