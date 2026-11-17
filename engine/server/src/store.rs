//! What the server knows about the music folder, in SQLite.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use anyhow::{Context, Result};
use deckhand_model::{Analysis, Artwork, Origin};
use rusqlite::{params, Connection, OptionalExtension};

/// Bump to analyse every track again (a better analyser, a format fix).
pub const ANALYSIS_RECIPE: i64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// Not audio: a playlist or another mirrored file.
    Other,
    Pending,
    Ready,
    Failed,
}

impl State {
    fn as_str(self) -> &'static str {
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

#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
    /// Bumped on every write, so the manifest can be cached between them.
    version: Arc<AtomicU64>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        conn.execute_batch(
            "pragma journal_mode = wal;
             pragma synchronous = normal;
             create table if not exists files(
                 name text primary key,
                 size integer not null,
                 mtime_ms integer not null,
                 hash text not null,
                 first_seen_ms integer not null,
                 state text not null,
                 error text,
                 source text,
                 origin text,
                 dat text,
                 ext text,
                 two_ex text,
                 art_small text,
                 art_medium text,
                 recipe integer not null default 0
             );
             create table if not exists tombstones(
                 name text primary key,
                 size integer not null,
                 deleted_ms integer not null
             );
             create table if not exists meta(key text primary key, value text not null);
             create table if not exists rekordbox(name text primary key, facts text not null);
             create table if not exists downloads(
                 id integer primary key autoincrement,
                 catalog_id text not null,
                 track text not null,
                 state text not null,
                 source text,
                 quality text,
                 file text,
                 error text,
                 attempts text not null default '[]',
                 created_ms integer not null,
                 updated_ms integer not null
             );
             create table if not exists endpoints(
                 id text primary key,
                 health text not null
             );
             create table if not exists devices(
                 token text primary key,
                 environment text not null,
                 updated_ms integer not null
             );",
        )?;
        // Added after the first release: the recording a file holds.
        let has_isrc = conn.prepare("select 1 from pragma_table_info('files') where name = 'isrc'")?.exists([])?;
        if !has_isrc {
            conn.execute("alter table files add column isrc text", [])?;
        }
        // Added with Spotify playlists: the playlist a download was for.
        let has_playlist =
            conn.prepare("select 1 from pragma_table_info('downloads') where name = 'playlist'")?.exists([])?;
        if !has_playlist {
            conn.execute("alter table downloads add column playlist text", [])?;
        }
        // Downloads a restart interrupted start over.
        conn.execute(
            "update downloads set state = 'queued' where state in ('searching', 'downloading', 'finishing')",
            [],
        )?;
        // A recipe change sends every analysed track back to the queue; the
        // rekordbox ones keep theirs.
        conn.execute(
            "update files set state = 'pending' where state in ('ready', 'failed') and recipe < ?1 and coalesce(origin, '') != 'rekordbox'",
            params![ANALYSIS_RECIPE],
        )?;
        Ok(Self { conn: Arc::new(Mutex::new(conn)), version: Arc::new(AtomicU64::new(1)) })
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        // A panic while holding the lock leaves SQLite consistent; carry on.
        self.conn.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn changed(&self) {
        self.version.fetch_add(1, Ordering::Relaxed);
    }

    pub fn version(&self) -> u64 {
        self.version.load(Ordering::Relaxed)
    }

    pub fn all(&self) -> Result<Vec<Row>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "select name, size, mtime_ms, hash, first_seen_ms, state, error, source, origin, dat, ext, two_ex, art_small, art_medium
             from files order by name",
        )?;
        let rows = stmt.query_map([], row_of)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn get(&self, name: &str) -> Result<Option<Row>> {
        let conn = self.lock();
        Ok(conn
            .query_row(
                "select name, size, mtime_ms, hash, first_seen_ms, state, error, source, origin, dat, ext, two_ex, art_small, art_medium
                 from files where name = ?1",
                params![name],
                row_of,
            )
            .optional()?)
    }

    /// Only the stat and hash changed: the content is the same.
    pub fn touch(&self, name: &str, size: u64, mtime_ms: i64) -> Result<()> {
        self.lock().execute(
            "update files set size = ?2, mtime_ms = ?3 where name = ?1",
            params![name, to_i64(size), mtime_ms],
        )?;
        self.changed();
        Ok(())
    }

    /// A new file, or new content under an old name.
    pub fn upsert(&self, name: &str, size: u64, mtime_ms: i64, hash: &str, state: State, source: Option<&str>) -> Result<()> {
        let now = now_ms();
        let conn = self.lock();
        conn.execute(
            "insert into files(name, size, mtime_ms, hash, first_seen_ms, state, source)
             values(?1, ?2, ?3, ?4, ?5, ?6, ?7)
             on conflict(name) do update set size = ?2, mtime_ms = ?3, hash = ?4, state = ?6, source = ?7,
                 error = null, origin = null, dat = null, ext = null, two_ex = null, art_small = null, art_medium = null, recipe = 0,
                 isrc = null",
            params![name, to_i64(size), mtime_ms, hash, now, state.as_str(), source],
        )?;
        conn.execute("delete from tombstones where name = ?1", params![name])?;
        drop(conn);
        self.changed();
        Ok(())
    }

    pub fn remove(&self, name: &str, size: u64) -> Result<()> {
        let conn = self.lock();
        conn.execute("delete from files where name = ?1", params![name])?;
        conn.execute(
            "insert into tombstones(name, size, deleted_ms) values(?1, ?2, ?3)
             on conflict(name) do update set size = ?2, deleted_ms = ?3",
            params![name, to_i64(size), now_ms()],
        )?;
        drop(conn);
        self.changed();
        Ok(())
    }

    pub fn tombstones(&self) -> Result<Vec<Tombstone>> {
        let conn = self.lock();
        let mut stmt = conn.prepare("select name, size, deleted_ms from tombstones order by name")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Tombstone { name: r.get(0)?, size: to_u64(r.get(1)?), deleted_ms: r.get(2)? })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// The next track to analyse, newest first: that is the one about to be played.
    pub fn next_pending(&self, skip: &std::collections::HashSet<String>) -> Result<Option<Row>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "select name, size, mtime_ms, hash, first_seen_ms, state, error, source, origin, dat, ext, two_ex, art_small, art_medium
             from files where state = 'pending' order by mtime_ms desc",
        )?;
        let mut rows = stmt.query_map([], row_of)?;
        for row in rows.by_ref() {
            let row = row?;
            if !skip.contains(&row.name) {
                return Ok(Some(row));
            }
        }
        Ok(None)
    }

    /// Records an analysis, unless the file changed while it ran.
    pub fn analysed(&self, name: &str, hash: &str, source: &str, analysis: &Analysis, artwork: Option<&Artwork>) -> Result<bool> {
        let n = self.lock().execute(
            "update files set state = 'ready', error = null, source = ?3, origin = ?4, dat = ?5, ext = ?6, two_ex = ?7,
                 art_small = ?8, art_medium = ?9, recipe = ?10
             where name = ?1 and hash = ?2 and state = 'pending'",
            params![
                name,
                hash,
                source,
                origin_str(analysis.origin),
                analysis.dat,
                analysis.ext,
                analysis.two_ex,
                artwork.map(|a| a.small.as_str()),
                artwork.map(|a| a.medium.as_str()),
                ANALYSIS_RECIPE,
            ],
        )?;
        self.changed();
        Ok(n > 0)
    }

    pub fn failed(&self, name: &str, hash: &str, error: &str, source: Option<&str>, artwork: Option<&Artwork>) -> Result<()> {
        self.lock().execute(
            "update files set state = 'failed', error = ?3, source = coalesce(?4, source), art_small = ?5, art_medium = ?6, recipe = ?7
             where name = ?1 and hash = ?2",
            params![
                name,
                hash,
                error,
                source,
                artwork.map(|a| a.small.as_str()),
                artwork.map(|a| a.medium.as_str()),
                ANALYSIS_RECIPE
            ],
        )?;
        self.changed();
        Ok(())
    }

    /// rekordbox's facts about a file name, as JSON.
    pub fn rekordbox_facts(&self, name: &str) -> Result<Option<String>> {
        Ok(self
            .lock()
            .query_row("select facts from rekordbox where name = ?1", params![name], |r| r.get(0))
            .optional()?)
    }

    /// Replaces what rekordbox says, and queues every track whose analysis
    /// that changes: the worker applies rekordbox's facts before analysing.
    pub fn replace_rekordbox(&self, facts: &[(String, String)]) -> Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let old: std::collections::HashMap<String, String> = {
            let mut stmt = tx.prepare("select name, facts from rekordbox")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        tx.execute("delete from rekordbox", [])?;
        for (name, json) in facts {
            tx.execute("insert into rekordbox(name, facts) values(?1, ?2)", params![name, json])?;
            if old.get(name) != Some(json) {
                tx.execute("update files set state = 'pending' where name = ?1 and state != 'other'", params![name])?;
            }
        }
        // Tracks rekordbox no longer vouches for go back to rbxport.
        tx.execute(
            "update files set state = 'pending' where origin = 'rekordbox' and name not in (select name from rekordbox)",
            [],
        )?;
        tx.commit()?;
        drop(conn);
        self.changed();
        Ok(())
    }

    /// Audio files whose ISRC has not been read yet.
    pub fn isrc_unread(&self) -> Result<Vec<String>> {
        let conn = self.lock();
        let mut stmt = conn.prepare("select name from files where isrc is null and state != 'other'")?;
        let rows = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(rows)
    }

    /// Records a file's ISRC; empty when it has none.
    pub fn set_isrc(&self, name: &str, isrc: &str) -> Result<()> {
        self.lock().execute("update files set isrc = ?2 where name = ?1", params![name, isrc])?;
        Ok(())
    }

    /// Every file that holds a known recording, by ISRC.
    pub fn isrcs(&self) -> Result<std::collections::HashMap<String, String>> {
        let conn = self.lock();
        let mut stmt = conn.prepare("select isrc, name from files where isrc is not null and isrc != ''")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?.to_ascii_uppercase(), r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    pub fn conn(&self) -> MutexGuard<'_, Connection> {
        self.lock()
    }

    pub fn meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .lock()
            .query_row("select value from meta where key = ?1", params![key], |r| r.get(0))
            .optional()?)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.lock().execute(
            "insert into meta(key, value) values(?1, ?2) on conflict(key) do update set value = ?2",
            params![key, value],
        )?;
        self.changed();
        Ok(())
    }
}

fn row_of(r: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    let origin: Option<String> = r.get(8)?;
    let dat: Option<String> = r.get(9)?;
    let analysis = match (origin.as_deref(), dat) {
        (Some(origin), Some(dat)) => Some(Analysis {
            origin: if origin == "rekordbox" { Origin::Rekordbox } else { Origin::Rbxport },
            dat,
            ext: r.get(10)?,
            two_ex: r.get(11)?,
        }),
        _ => None,
    };
    let small: Option<String> = r.get(12)?;
    let medium: Option<String> = r.get(13)?;
    let artwork = small.zip(medium).map(|(small, medium)| Artwork { small, medium });
    let state: String = r.get(5)?;
    Ok(Row {
        name: r.get(0)?,
        size: to_u64(r.get(1)?),
        mtime_ms: r.get(2)?,
        hash: r.get(3)?,
        first_seen_ms: r.get(4)?,
        state: State::parse(&state),
        error: r.get(6)?,
        source: r.get(7)?,
        analysis,
        artwork,
    })
}

fn origin_str(origin: Origin) -> &'static str {
    match origin {
        Origin::Rekordbox => "rekordbox",
        Origin::Rbxport => "rbxport",
    }
}

fn to_i64(n: u64) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

fn to_u64(n: i64) -> u64 {
    u64::try_from(n).unwrap_or(0)
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
