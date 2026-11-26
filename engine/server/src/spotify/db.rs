//! The Spotify playlists: what Spotify says about them is Spotidata's, read
//! from its views `spotidata.engine_playlists` and
//! `spotidata.engine_playlist_tracks` (read-only); what the engine did with
//! them is its own, in `deckhand.spotify_*`.

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use deckhand_model::spotify::{Activity, ActivityKind};

use crate::store::{ms, Store};

#[derive(Debug, Clone)]
pub struct Row {
    pub id: String,
    pub name: String,
    pub owner: String,
    pub owned: bool,
    pub image: Option<String>,
    pub total: usize,
    /// The snapshot whose tracks Spotidata holds; `None` until read.
    pub items_snapshot: Option<String>,
    /// When Spotidata last read its tracks.
    pub read_ms: Option<i64>,
    /// In the account's playlists.
    pub listed: bool,
    pub selected: bool,
    /// Added by its link (when), rather than picked from the account's
    /// list: kept and read whether or not the account lists it.
    pub linked_ms: Option<i64>,
    pub file: Option<String>,
    pub file_hash: Option<String>,
    pub error: Option<String>,
    /// The tracks the engine last compared, at this snapshot.
    pub seen_snapshot: Option<String>,
    pub seen_tracks: Vec<String>,
}

impl Row {
    /// Whether its tracks can be read: Spotidata has read them.
    pub fn readable(&self) -> bool {
        self.items_snapshot.is_some()
    }
}

/// A playlist as the views and the engine's table join it.
#[derive(sqlx::FromRow)]
struct Record {
    id: String,
    name: String,
    owner: String,
    owned: bool,
    image: Option<String>,
    total: i32,
    items_snapshot: Option<String>,
    read_at: Option<DateTime<Utc>>,
    listed: bool,
    selected: bool,
    linked_at: Option<DateTime<Utc>>,
    file: Option<String>,
    file_hash: Option<String>,
    error: Option<String>,
    seen_snapshot: Option<String>,
    seen_tracks: Vec<String>,
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
            items_snapshot: r.items_snapshot,
            read_ms: r.read_at.map(ms),
            listed: r.listed,
            selected: r.selected,
            linked_ms: r.linked_at.map(ms),
            file: r.file,
            file_hash: r.file_hash,
            error: r.error,
            seen_snapshot: r.seen_snapshot,
            seen_tracks: r.seen_tracks,
        }
    }
}

/// Every playlist the account lists, and every one the engine kept, with
/// what each side knows.
macro_rules! playlists {
    () => {
        "select coalesce(k.id, e.id) as id, coalesce(e.name, k.name) as name, coalesce(e.owner, '') as owner,
             coalesce(e.owned, false) as owned, e.image, coalesce(e.tracks, 0) as total, e.items_snapshot, e.items_synced_at as read_at, coalesce(e.listed, false) as listed,
             coalesce(k.selected, false) as selected, k.linked_at, k.file, k.file_hash, k.error, k.seen_snapshot,
             coalesce(k.seen_tracks, '{}') as seen_tracks
         from spotidata.engine_playlists e
         full join spotify_playlists k on k.id = e.id"
    };
}

fn count(n: usize) -> i32 {
    i32::try_from(n).unwrap_or(i32::MAX)
}

/// The account's playlists by name, then those kept by their link in the
/// order they were added, then those kept that Spotify no longer lists.
pub async fn all(store: &Store) -> Result<Vec<Row>> {
    let rows: Vec<Record> = sqlx::query_as(concat!(
        playlists!(),
        " where e.listed or k.id is not null
          order by k.linked_at is not null, not coalesce(e.listed, false), k.linked_at,
                   lower(coalesce(e.name, k.name)), coalesce(k.id, e.id)"
    ))
    .fetch_all(store.pool())
    .await?;
    Ok(rows.into_iter().map(Row::from).collect())
}

/// One playlist the account lists or the engine knows, or that Spotidata
/// fetched (by its link).
pub async fn get(store: &Store, id: &str) -> Result<Option<Row>> {
    let row: Option<Record> = sqlx::query_as(concat!(playlists!(), " where coalesce(k.id, e.id) = $1"))
        .bind(id)
        .fetch_optional(store.pool())
        .await?;
    Ok(row.map(Row::from))
}

/// The ids of the kept playlists.
pub async fn kept(store: &Store) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar("select id from spotify_playlists where selected order by id")
        .fetch_all(store.pool())
        .await?)
}

/// A playlist added by its link: kept from now on, whether or not the
/// account lists it.
pub async fn add_linked(store: &Store, id: &str, name: &str) -> Result<()> {
    sqlx::query(
        "insert into spotify_playlists(id, name, selected, linked_at) values($1, $2, true, now())
         on conflict(id) do update set name = $2, selected = true,
             linked_at = coalesce(spotify_playlists.linked_at, now())",
    )
    .bind(id)
    .bind(name)
    .execute(store.pool())
    .await?;
    Ok(())
}

/// Starts or stops keeping a playlist the account lists or the engine knows.
/// One added by its link that you stop keeping is the account's again: it
/// stays listed only if the account lists it.
pub async fn select(store: &Store, id: &str, name: &str, selected: bool) -> Result<()> {
    sqlx::query(
        "insert into spotify_playlists(id, name, selected) values($1, $2, $3)
         on conflict(id) do update set name = $2, selected = $3,
             error = case when $3 then spotify_playlists.error end,
             linked_at = case when $3 then spotify_playlists.linked_at end",
    )
    .bind(id)
    .bind(name)
    .bind(selected)
    .execute(store.pool())
    .await?;
    Ok(())
}

/// A playlist's tracks as Spotidata last read them, in Spotify's order.
pub async fn tracks(store: &Store, id: &str) -> Result<Vec<PlaylistTrack>> {
    #[derive(sqlx::FromRow)]
    struct Item {
        track_id: Option<String>,
        title: String,
        artists: Vec<String>,
        album: String,
        isrc: Option<String>,
        duration_ms: i32,
        cover: Option<String>,
    }
    let rows: Vec<Item> = sqlx::query_as(
        "select track_id, title, artists, album, isrc, duration_ms, cover
         from spotidata.engine_playlist_tracks where playlist_id = $1 order by position",
    )
    .bind(id)
    .fetch_all(store.pool())
    .await?;
    Ok(rows
        .into_iter()
        .map(|t| PlaylistTrack {
            id: t.track_id,
            title: t.title,
            artists: t.artists,
            album: t.album,
            isrc: t.isrc,
            duration_ms: u64::try_from(t.duration_ms).unwrap_or(0),
            cover: t.cover,
        })
        .collect())
}

/// What the engine compared last: the tracks at a snapshot, and its name then.
pub async fn set_seen(store: &Store, id: &str, name: &str, snapshot: &str, tracks: &[String]) -> Result<()> {
    sqlx::query(
        "update spotify_playlists set name = $2, seen_snapshot = $3, seen_tracks = $4, seen_at = now() where id = $1",
    )
    .bind(id)
    .bind(name)
    .bind(snapshot)
    .bind(tracks)
    .execute(store.pool())
    .await?;
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

/// One track of a playlist, as Spotidata holds it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaylistTrack {
    /// `None` for a local file.
    pub id: Option<String>,
    pub title: String,
    pub artists: Vec<String>,
    pub album: String,
    pub isrc: Option<String>,
    pub duration_ms: u64,
    pub cover: Option<String>,
}

impl PlaylistTrack {
    pub fn duration_sec(&self) -> u32 {
        u32::try_from((self.duration_ms + 500) / 1000).unwrap_or(0)
    }

    /// What identifies the recording across playlists: its ISRC, else its
    /// Spotify id. `None` for a local file.
    pub fn key(&self) -> Option<String> {
        match (&self.isrc, &self.id) {
            (Some(isrc), _) => Some(format!("isrc:{isrc}")),
            (None, Some(id)) => Some(format!("spotify:{id}")),
            (None, None) => None,
        }
    }

    /// The recording, or for a local file its title and artists: what
    /// `seen_tracks` holds, to count what was added and removed.
    pub fn seen_key(&self) -> String {
        self.key().unwrap_or_else(|| format!("local:{}|{}", self.title, self.artists.join(",")))
    }
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
pub mod tests {
    use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

    use super::*;

    /// Spotidata's two views, as tables a test fills (the real ones are in
    /// Spotidata's db/sql/post/110_engine.sql).
    pub async fn spotidata(store: &Store) {
        sqlx::raw_sql(
            "create schema spotidata;
             create table spotidata.engine_playlists(id text primary key, name text not null, owner text not null,
                 owned boolean not null, image text, tracks integer not null, snapshot_id text not null,
                 items_snapshot text, items_synced_at timestamptz, listed boolean not null);
             create table spotidata.engine_playlist_tracks(playlist_id text not null, position integer not null,
                 track_id text, title text not null, artists text[] not null, album text not null, isrc text,
                 duration_ms integer not null, cover text);",
        )
        .execute(store.pool())
        .await
        .unwrap();
    }

    /// A playlist as Spotidata would hold it, its tracks read at `snapshot`.
    pub async fn playlist(store: &Store, id: &str, listed: bool, snapshot: &str, tracks: &[&str]) {
        sqlx::query(
            "insert into spotidata.engine_playlists values($1, $1, '', false, null, $2, $3, $3, now(), $4)
             on conflict(id) do update set snapshot_id = $3, items_snapshot = $3, listed = $4, tracks = $2",
        )
        .bind(id)
        .bind(count(tracks.len()))
        .bind(snapshot)
        .bind(listed)
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query("delete from spotidata.engine_playlist_tracks where playlist_id = $1")
            .bind(id)
            .execute(store.pool())
            .await
            .unwrap();
        for (position, track) in tracks.iter().enumerate() {
            sqlx::query(
                "insert into spotidata.engine_playlist_tracks values($1, $2, $3, $3, '{}', '', null, 1000, null)",
            )
            .bind(id)
            .bind(count(position))
            .bind(track)
            .execute(store.pool())
            .await
            .unwrap();
        }
    }

    #[sqlx::test(migrations = false)]
    async fn linked_playlists_outlast_the_list(_: PgPoolOptions, options: PgConnectOptions) {
        let store = crate::store::tests::store(options).await;
        spotidata(&store).await;
        playlist(&store, "a", true, "s1", &[]).await;
        playlist(&store, "b", true, "s1", &[]).await;
        // Fetched by its link, not the account's.
        playlist(&store, "x", false, "s1", &[]).await;
        add_linked(&store, "x", "x").await.unwrap();
        // Also the account's: still kept by its link once it isn't.
        add_linked(&store, "b", "b").await.unwrap();
        playlist(&store, "b", false, "s1", &[]).await;
        let rows = all(&store).await.unwrap();
        let shown: Vec<_> = rows.iter().map(|p| (p.id.as_str(), p.listed, p.selected)).collect();
        // The linked ones after the account's, in the order they were linked.
        assert_eq!(shown, vec![("a", true, false), ("x", false, true), ("b", false, true)]);
        // Stopped: the account's again, so no longer shown.
        select(&store, "x", "x", false).await.unwrap();
        let rows = all(&store).await.unwrap();
        let x = rows.iter().find(|p| p.id == "x").unwrap();
        assert!(!x.selected && x.linked_ms.is_none());
        assert_eq!(kept(&store).await.unwrap(), ["b"]);
    }

    #[sqlx::test(migrations = false)]
    async fn tracks_keep_spotifys_order(_: PgPoolOptions, options: PgConnectOptions) {
        let store = crate::store::tests::store(options).await;
        spotidata(&store).await;
        playlist(&store, "a", true, "s1", &["t2", "t1", "t3"]).await;
        let ids: Vec<_> = tracks(&store, "a").await.unwrap().into_iter().filter_map(|t| t.id).collect();
        assert_eq!(ids, ["t2", "t1", "t3"]);
        let row = get(&store, "a").await.unwrap().unwrap();
        assert_eq!(row.items_snapshot.as_deref(), Some("s1"));
        assert!(row.read_ms.is_some() && row.readable());
        select(&store, "a", "a", true).await.unwrap();
        set_seen(&store, "a", "a", "s1", &["spotify:t2".to_owned()]).await.unwrap();
        let row = get(&store, "a").await.unwrap().unwrap();
        assert_eq!((row.seen_snapshot.as_deref(), row.seen_tracks.len()), (Some("s1"), 1));
    }

    #[sqlx::test(migrations = false)]
    async fn repeats_close_together_add_up(_: PgPoolOptions, options: PgConnectOptions) {
        let store = crate::store::tests::store(options).await;
        spotidata(&store).await;
        select(&store, "p1", "House", true).await.unwrap();
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
