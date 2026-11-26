//! What the server knows about the music folder, in Postgres.
//!
//! Everything the server keeps lives in one schema, `deckhand`, which it owns
//! and migrates at startup (`migrations/`); it never touches another schema
//! of the database it is given. Times are `timestamptz` there and `*_ms` in
//! the HTTP API, converted here and in the other `db` modules.

use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use deckhand_model::{Analysis, Artwork, Origin};
use serde::de::DeserializeOwned;
use serde::Serialize;
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions};
use sqlx::types::Json;

/// The schema the server keeps its state in.
pub const SCHEMA: &str = "deckhand";

/// Bump to analyse every track again (a better analyser, a format fix).
pub const ANALYSIS_RECIPE: i32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// Not audio: a playlist or another mirrored file.
    Other,
    Pending,
    Ready,
    Failed,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Other => "other",
            Self::Pending => "pending",
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "pending" => Self::Pending,
            "ready" => Self::Ready,
            "failed" => Self::Failed,
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Row {
    pub name: String,
    pub size: u64,
    pub mtime_ms: i64,
    pub hash: String,
    pub first_seen_ms: i64,
    pub state: State,
    pub error: Option<String>,
    /// `rbl_export::SourceTrack` as JSON, without analysis.
    pub source: Option<String>,
    pub analysis: Option<Analysis>,
    pub artwork: Option<Artwork>,
}

#[derive(Debug, Clone)]
pub struct Tombstone {
    pub name: String,
    pub size: u64,
    pub deleted_ms: i64,
}

/// A row of `files` as stored.
#[derive(sqlx::FromRow)]
struct FileRecord {
    name: String,
    size: i64,
    mtime: DateTime<Utc>,
    hash: String,
    first_seen: DateTime<Utc>,
    state: String,
    error: Option<String>,
    source: Option<String>,
    origin: Option<String>,
    dat: Option<String>,
    ext: Option<String>,
    two_ex: Option<String>,
    art_small: Option<String>,
    art_medium: Option<String>,
}

impl From<FileRecord> for Row {
    fn from(r: FileRecord) -> Self {
        let analysis = match (r.origin.as_deref(), r.dat) {
            (Some(origin), Some(dat)) => Some(Analysis {
                origin: if origin == "rekordbox" { Origin::Rekordbox } else { Origin::Rbxport },
                dat,
                ext: r.ext,
                two_ex: r.two_ex,
            }),
            _ => None,
        };
        let artwork = r.art_small.zip(r.art_medium).map(|(small, medium)| Artwork { small, medium });
        Self {
            name: r.name,
            size: to_u64(r.size),
            mtime_ms: ms(r.mtime),
            hash: r.hash,
            first_seen_ms: ms(r.first_seen),
            state: State::parse(&r.state),
            error: r.error,
            source: r.source,
            analysis,
            artwork,
        }
    }
}

/// The columns a `FileRecord` reads.
macro_rules! file_columns {
    () => {
        "name, size, mtime, hash, first_seen, state, error, source::text as source, origin, dat, ext, two_ex, art_small, art_medium"
    };
}

#[derive(Clone)]
pub struct Store {
    pool: PgPool,
    /// Bumped on every write to the folder's files and the settings, so the
    /// manifest can be cached between them.
    version: Arc<AtomicU64>,
}

impl Store {
    /// Connects to the database at `url` and brings the `deckhand` schema up
    /// to date.
    pub async fn connect(url: &str) -> Result<Self> {
        let options = PgConnectOptions::from_str(url).context("the database URL is not a Postgres URL")?;
        Self::connect_with(options).await
    }

    pub async fn connect_with(options: PgConnectOptions) -> Result<Self> {
        // Unqualified names are the server's own tables.
        let options = options.options([("search_path", SCHEMA)]).application_name("deckhand-server");
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(Duration::from_secs(30))
            .connect_with(options)
            .await
            .context("connecting to Postgres")?;
        let mut migrator = sqlx::migrate!("./migrations");
        // The migrations' bookkeeping lives in the schema too, not in `public`.
        migrator.create_schema(SCHEMA);
        migrator.dangerous_set_table_name(format!("{SCHEMA}._sqlx_migrations"));
        migrator.run(&pool).await.context("migrating the deckhand schema")?;
        Ok(Self { pool, version: Arc::new(AtomicU64::new(1)) })
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// A recipe change sends every analysed track back to the queue; the
    /// rekordbox ones keep theirs.
    pub async fn requeue_old_analysis(&self) -> Result<()> {
        sqlx::query(
            "update files set state = 'pending'
             where state in ('ready', 'failed') and recipe < $1 and origin is distinct from 'rekordbox'",
        )
        .bind(ANALYSIS_RECIPE)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    fn changed(&self) {
        self.version.fetch_add(1, Ordering::Relaxed);
    }

    pub fn version(&self) -> u64 {
        self.version.load(Ordering::Relaxed)
    }

    pub async fn all(&self) -> Result<Vec<Row>> {
        let rows: Vec<FileRecord> = sqlx::query_as(concat!("select ", file_columns!(), " from files order by name"))
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.into_iter().map(Row::from).collect())
    }

    pub async fn get(&self, name: &str) -> Result<Option<Row>> {
        let row: Option<FileRecord> =
            sqlx::query_as(concat!("select ", file_columns!(), " from files where name = $1"))
                .bind(name)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(Row::from))
    }

    /// Only the stat and hash changed: the content is the same.
    pub async fn touch(&self, name: &str, size: u64, mtime_ms: i64) -> Result<()> {
        sqlx::query("update files set size = $2, mtime = $3 where name = $1")
            .bind(name)
            .bind(to_i64(size))
            .bind(at_ms(mtime_ms))
            .execute(&self.pool)
            .await?;
        self.changed();
        Ok(())
    }

    /// A new file, or new content under an old name.
    pub async fn upsert(
        &self,
        name: &str,
        size: u64,
        mtime_ms: i64,
        hash: &str,
        state: State,
        source: Option<&str>,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "insert into files(name, size, mtime, hash, state, source)
             values($1, $2, $3, $4, $5, $6::jsonb)
             on conflict(name) do update set size = $2, mtime = $3, hash = $4, state = $5, source = $6::jsonb,
                 error = null, origin = null, dat = null, ext = null, two_ex = null, art_small = null,
                 art_medium = null, recipe = 0, isrc = null, isrc_read = false",
        )
        .bind(name)
        .bind(to_i64(size))
        .bind(at_ms(mtime_ms))
        .bind(hash)
        .bind(state.as_str())
        .bind(source)
        .execute(&mut *tx)
        .await?;
        sqlx::query("delete from tombstones where name = $1").bind(name).execute(&mut *tx).await?;
        tx.commit().await?;
        self.changed();
        Ok(())
    }

    pub async fn remove(&self, name: &str, size: u64) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("delete from files where name = $1").bind(name).execute(&mut *tx).await?;
        sqlx::query(
            "insert into tombstones(name, size, deleted_at) values($1, $2, now())
             on conflict(name) do update set size = $2, deleted_at = now()",
        )
        .bind(name)
        .bind(to_i64(size))
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        self.changed();
        Ok(())
    }

    pub async fn tombstones(&self) -> Result<Vec<Tombstone>> {
        let rows: Vec<(String, i64, DateTime<Utc>)> =
            sqlx::query_as("select name, size, deleted_at from tombstones order by name").fetch_all(&self.pool).await?;
        Ok(rows
            .into_iter()
            .map(|(name, size, deleted)| Tombstone { name, size: to_u64(size), deleted_ms: ms(deleted) })
            .collect())
    }

    /// The next track to analyse, newest first: that is the one about to be
    /// played. `skip` are being analysed already.
    pub async fn next_pending(&self, skip: &HashSet<String>) -> Result<Option<Row>> {
        let skip: Vec<&str> = skip.iter().map(String::as_str).collect();
        let row: Option<FileRecord> = sqlx::query_as(concat!(
            "select ",
            file_columns!(),
            " from files where state = 'pending' and name <> all($1) order by mtime desc limit 1"
        ))
        .bind(skip)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(Row::from))
    }

    /// Records an analysis, unless the file changed while it ran.
    pub async fn analysed(
        &self,
        name: &str,
        hash: &str,
        source: &str,
        analysis: &Analysis,
        artwork: Option<&Artwork>,
    ) -> Result<bool> {
        let n = sqlx::query(
            "update files set state = 'ready', error = null, source = $3::jsonb, origin = $4, dat = $5, ext = $6,
                 two_ex = $7, art_small = $8, art_medium = $9, recipe = $10
             where name = $1 and hash = $2 and state = 'pending'",
        )
        .bind(name)
        .bind(hash)
        .bind(source)
        .bind(origin_str(analysis.origin))
        .bind(&analysis.dat)
        .bind(&analysis.ext)
        .bind(&analysis.two_ex)
        .bind(artwork.map(|a| a.small.as_str()))
        .bind(artwork.map(|a| a.medium.as_str()))
        .bind(ANALYSIS_RECIPE)
        .execute(&self.pool)
        .await?
        .rows_affected();
        self.changed();
        Ok(n > 0)
    }

    pub async fn failed(
        &self,
        name: &str,
        hash: &str,
        error: &str,
        source: Option<&str>,
        artwork: Option<&Artwork>,
    ) -> Result<()> {
        sqlx::query(
            "update files set state = 'failed', error = $3, source = coalesce($4::jsonb, source), art_small = $5,
                 art_medium = $6, recipe = $7
             where name = $1 and hash = $2",
        )
        .bind(name)
        .bind(hash)
        .bind(error)
        .bind(source)
        .bind(artwork.map(|a| a.small.as_str()))
        .bind(artwork.map(|a| a.medium.as_str()))
        .bind(ANALYSIS_RECIPE)
        .execute(&self.pool)
        .await?;
        self.changed();
        Ok(())
    }

    /// rekordbox's facts about a file name.
    pub async fn rekordbox_facts(&self, name: &str) -> Result<Option<serde_json::Value>> {
        let facts: Option<Json<serde_json::Value>> = sqlx::query_scalar("select facts from rekordbox where name = $1")
            .bind(name_key(name))
            .fetch_optional(&self.pool)
            .await?;
        Ok(facts.map(|Json(facts)| facts))
    }

    /// Replaces what rekordbox says, and queues every track whose analysis
    /// that changes: the worker applies rekordbox's facts before analysing.
    pub async fn replace_rekordbox(&self, facts: &[(String, serde_json::Value)]) -> Result<()> {
        // By the key rekordbox's names are kept under; the last one wins.
        let facts: HashMap<String, &serde_json::Value> =
            facts.iter().map(|(name, facts)| (name_key(name), facts)).collect();
        let mut tx = self.pool.begin().await?;
        let old: HashMap<String, serde_json::Value> = sqlx::query_as("select name, facts from rekordbox")
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .map(|(name, Json(facts)): (String, Json<serde_json::Value>)| (name, facts))
            .collect();
        // The folder's files by the key rekordbox's names are kept under.
        let files: Vec<(String, Option<String>)> =
            sqlx::query_as("select name, origin from files where state <> 'other'").fetch_all(&mut *tx).await?;
        let mut by_key: HashMap<String, Vec<&str>> = HashMap::new();
        for (name, _) in &files {
            by_key.entry(name_key(name)).or_default().push(name);
        }
        sqlx::query("delete from rekordbox").execute(&mut *tx).await?;
        let (names, json): (Vec<&str>, Vec<String>) =
            facts.iter().map(|(name, facts)| (name.as_str(), facts.to_string())).unzip();
        sqlx::query("insert into rekordbox(name, facts) select name, facts::jsonb from unnest($1::text[], $2::text[]) as t(name, facts)")
            .bind(&names)
            .bind(&json)
            .execute(&mut *tx)
            .await?;
        let mut requeue: Vec<&str> = Vec::new();
        for (name, json) in &facts {
            if old.get(name) != Some(*json) {
                requeue.extend(by_key.get(name).into_iter().flatten());
            }
        }
        // Tracks rekordbox no longer vouches for go back to rbxport.
        for (name, origin) in &files {
            if origin.as_deref() == Some("rekordbox") && !facts.contains_key(&name_key(name)) {
                requeue.push(name);
            }
        }
        sqlx::query("update files set state = 'pending' where name = any($1)").bind(&requeue).execute(&mut *tx).await?;
        tx.commit().await?;
        self.changed();
        Ok(())
    }

    /// Audio files whose ISRC has not been read yet.
    pub async fn isrc_unread(&self) -> Result<Vec<String>> {
        Ok(sqlx::query_scalar("select name from files where not isrc_read and state <> 'other'")
            .fetch_all(&self.pool)
            .await?)
    }

    /// Records a file's ISRC; `None` when it has none.
    pub async fn set_isrc(&self, name: &str, isrc: Option<&str>) -> Result<()> {
        let isrc = isrc.map(str::trim).filter(|s| !s.is_empty()).map(str::to_ascii_uppercase);
        sqlx::query("update files set isrc = $2, isrc_read = true where name = $1")
            .bind(name)
            .bind(isrc)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// The file whose content has this hash, if the folder holds one.
    pub async fn by_hash(&self, hash: &str) -> Result<Option<String>> {
        Ok(sqlx::query_scalar("select name from files where hash = $1 order by first_seen, name limit 1")
            .bind(hash)
            .fetch_optional(&self.pool)
            .await?)
    }

    /// Every file that holds a known recording, by ISRC. Of two files of
    /// one recording, the one the scanner saw last.
    pub async fn isrcs(&self) -> Result<HashMap<String, String>> {
        let rows: Vec<(String, String)> =
            sqlx::query_as("select isrc, name from files where isrc is not null order by first_seen, name")
                .fetch_all(&self.pool)
                .await?;
        Ok(rows.into_iter().collect())
    }

    /// A setting or other small state, as JSON.
    pub async fn meta<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        let value: Option<Json<serde_json::Value>> =
            sqlx::query_scalar("select value from meta where key = $1").bind(key).fetch_optional(&self.pool).await?;
        value
            .map(|Json(value)| serde_json::from_value(value).with_context(|| format!("reading the setting {key}")))
            .transpose()
    }

    pub async fn set_meta<T: Serialize + ?Sized + Sync>(&self, key: &str, value: &T) -> Result<()> {
        sqlx::query("insert into meta(key, value) values($1, $2) on conflict(key) do update set value = $2")
            .bind(key)
            .bind(Json(value))
            .execute(&self.pool)
            .await?;
        self.changed();
        Ok(())
    }
}

fn origin_str(origin: Origin) -> &'static str {
    match origin {
        Origin::Rekordbox => "rekordbox",
        Origin::Rbxport => "rbxport",
    }
}

pub fn to_i64(n: u64) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

pub fn to_u64(n: i64) -> u64 {
    u64::try_from(n).unwrap_or(0)
}

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// A time as the API sends it.
pub fn ms(t: DateTime<Utc>) -> i64 {
    t.timestamp_millis()
}

/// A time the API sent, or one in `*_ms`, as stored.
pub fn at_ms(ms: i64) -> DateTime<Utc> {
    DateTime::from_timestamp_millis(ms).unwrap_or_default()
}

/// A file name as rekordbox's facts are kept and looked up by: composed
/// Unicode, so "å" matches whether macOS decomposed it or not.
pub fn name_key(name: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    name.nfc().collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A store in the fresh database `#[sqlx::test]` made for the test.
    pub async fn store(options: PgConnectOptions) -> Store {
        Store::connect_with(options).await.unwrap()
    }

    #[sqlx::test(migrations = false)]
    async fn rekordbox_facts_match_whatever_unicode_form(_: PgPoolOptions, options: PgConnectOptions) {
        let store = store(options).await;
        // The folder's file is composed; rekordbox stored the path decomposed.
        let composed = "17 \u{e5}r - Veronica Maggio.flac";
        let decomposed = "17 a\u{30a}r - Veronica Maggio.flac";
        let hash = "0".repeat(64);
        store.upsert(composed, 1, 1, &hash, State::Ready, None).await.unwrap();
        let facts = serde_json::json!({ "bpm_x100": 12000 });
        store.replace_rekordbox(&[(decomposed.to_owned(), facts.clone())]).await.unwrap();
        assert_eq!(store.rekordbox_facts(composed).await.unwrap(), Some(facts.clone()));
        assert_eq!(store.rekordbox_facts(decomposed).await.unwrap(), Some(facts.clone()));
        // New facts queue the file for analysis with them; the same again doesn't.
        assert_eq!(store.get(composed).await.unwrap().unwrap().state, State::Pending);
        sqlx::query("update files set state = 'ready'").execute(store.pool()).await.unwrap();
        store.replace_rekordbox(&[(decomposed.to_owned(), facts)]).await.unwrap();
        assert_eq!(store.get(composed).await.unwrap().unwrap().state, State::Ready);
    }

    #[sqlx::test(migrations = false)]
    async fn files_keep_their_times_and_leave_tombstones(_: PgPoolOptions, options: PgConnectOptions) {
        let store = store(options).await;
        let hash = "a".repeat(64);
        let mtime_ms = 1_795_080_312_721;
        store
            .upsert("b.flac", 10, mtime_ms, &hash, State::Pending, Some(r#"{"title":"B","bpm_x100":12850}"#))
            .await
            .unwrap();
        store.upsert("a.flac", 10, mtime_ms - 1, &hash, State::Pending, None).await.unwrap();
        let row = store.get("b.flac").await.unwrap().unwrap();
        assert_eq!(row.mtime_ms, mtime_ms);
        let bpm: Option<String> = sqlx::query_scalar("select bpm::text from files where name = 'b.flac'")
            .fetch_one(store.pool())
            .await
            .unwrap();
        assert_eq!(bpm.as_deref(), Some("128.50"));
        // Newest first.
        let next = store.next_pending(&HashSet::new()).await.unwrap().unwrap();
        assert_eq!(next.name, "b.flac");
        let skip = HashSet::from(["b.flac".to_owned()]);
        assert_eq!(store.next_pending(&skip).await.unwrap().unwrap().name, "a.flac");

        store.set_isrc("a.flac", Some("gbduw0000059")).await.unwrap();
        assert_eq!(store.isrcs().await.unwrap().get("GBDUW0000059").map(String::as_str), Some("a.flac"));
        assert_eq!(store.isrc_unread().await.unwrap(), vec!["b.flac".to_owned()]);

        store.remove("a.flac", 10).await.unwrap();
        let tombstones = store.tombstones().await.unwrap();
        assert_eq!(tombstones.len(), 1);
        assert_eq!(tombstones[0].name, "a.flac");
        store.upsert("a.flac", 10, mtime_ms, &hash, State::Pending, None).await.unwrap();
        assert!(store.tombstones().await.unwrap().is_empty(), "a file back loses its tombstone");

        store.set_meta("spotify.paused", &true).await.unwrap();
        assert_eq!(store.meta::<bool>("spotify.paused").await.unwrap(), Some(true));
        assert_eq!(store.meta::<bool>("nothing").await.unwrap(), None);
    }
}
