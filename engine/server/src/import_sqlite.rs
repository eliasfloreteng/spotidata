//! The one-time move from the SQLite database the server kept before
//! Postgres (`deckhand.db` in the data dir): `deckhand-server import-sqlite
//! <deckhand.db>`.
//!
//! Every row of every table is copied into the `deckhand` schema, converted:
//! `*_ms` integers to `timestamptz`, JSON text to `jsonb`, 0/1 to booleans,
//! the settings in `meta` to JSON values, each mirror's health from JSON to
//! columns. It refuses to run into a schema that holds anything, and runs in
//! one transaction: a row that does not convert (or breaks a constraint) is
//! reported, and nothing is kept unless `--keep-going` says to keep the rest.
//! The analysis and artwork blobs stay files in the data dir's `blobs/`; their
//! hashes are copied as they are and checked against that folder.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::types::Value;
use sqlx::postgres::PgArguments;
use sqlx::query::Query;
use sqlx::{Connection, PgConnection, Postgres};

use crate::store::Store;

/// The tables, in the order they are filled (foreign keys first).
const TABLES: [&str; 11] = [
    "files",
    "tombstones",
    "meta",
    "rekordbox",
    "downloads",
    "endpoints",
    "devices",
    "spotify_playlists",
    "spotify_tracks",
    "spotify_links",
    "spotify_activity",
];

pub struct Options {
    /// The old `deckhand.db`; its `-wal` is read with it.
    pub sqlite: PathBuf,
    /// The data dir's `blobs/`, to check the rows' hashes against.
    pub blobs: Option<PathBuf>,
    /// Keep the rows that converted when some did not.
    pub keep_going: bool,
}

/// One row of an old table, by column name.
struct Old {
    columns: HashMap<String, Value>,
}

impl Old {
    fn value(&self, column: &str) -> Result<&Value, String> {
        self.columns.get(column).ok_or_else(|| format!("no column {column}"))
    }

    fn text(&self, column: &str) -> Result<Option<String>, String> {
        match self.value(column)? {
            Value::Null => Ok(None),
            Value::Text(t) => Ok(Some(t.clone())),
            Value::Integer(n) => Ok(Some(n.to_string())),
            other => Err(format!("{column} is not text: {other:?}")),
        }
    }

    fn required_text(&self, column: &str) -> Result<String, String> {
        self.text(column)?.ok_or_else(|| format!("{column} is null"))
    }

    fn int(&self, column: &str) -> Result<Option<i64>, String> {
        match self.value(column)? {
            Value::Null => Ok(None),
            Value::Integer(n) => Ok(Some(*n)),
            Value::Text(t) => t.trim().parse().map(Some).map_err(|_| format!("{column} is not a number: {t:?}")),
            other => Err(format!("{column} is not a number: {other:?}")),
        }
    }

    fn required_int(&self, column: &str) -> Result<i64, String> {
        self.int(column)?.ok_or_else(|| format!("{column} is null"))
    }

    fn int32(&self, column: &str) -> Result<i32, String> {
        let n = self.required_int(column)?;
        i32::try_from(n).map_err(|_| format!("{column} is out of range: {n}"))
    }

    fn flag(&self, column: &str) -> Result<bool, String> {
        match self.required_int(column)? {
            0 => Ok(false),
            1 => Ok(true),
            n => Err(format!("{column} is not 0 or 1: {n}")),
        }
    }

    fn time(&self, column: &str) -> Result<Option<DateTime<Utc>>, String> {
        self.int(column)?.map(|ms| time(ms).ok_or_else(|| format!("{column} is not a time: {ms}"))).transpose()
    }

    fn required_time(&self, column: &str) -> Result<DateTime<Utc>, String> {
        self.time(column)?.ok_or_else(|| format!("{column} is null"))
    }
}

fn time(ms: i64) -> Option<DateTime<Utc>> {
    DateTime::from_timestamp_millis(ms)
}

/// The old database, read whole: it is a few megabytes.
struct Sqlite {
    tables: HashMap<&'static str, Vec<Old>>,
    /// `sqlite_sequence`: the last id AUTOINCREMENT handed out, by table.
    sequences: HashMap<String, i64>,
}

impl Sqlite {
    fn read(path: &Path) -> Result<Self> {
        let conn = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .with_context(|| format!("opening {}", path.display()))?;
        let mut tables = HashMap::new();
        for table in TABLES {
            let mut stmt = conn.prepare(&format!("select * from {table} order by rowid"))?;
            let names: Vec<String> = stmt.column_names().into_iter().map(str::to_owned).collect();
            let rows = stmt
                .query_map([], |r| {
                    let mut columns = HashMap::new();
                    for (i, name) in names.iter().enumerate() {
                        columns.insert(name.clone(), r.get::<_, Value>(i)?);
                    }
                    Ok(Old { columns })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
                .with_context(|| format!("reading {table}"))?;
            tables.insert(table, rows);
        }
        let sequences = conn
            .prepare("select name, seq from sqlite_sequence")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(Self { tables, sequences })
    }

    fn rows(&self, table: &str) -> &[Old] {
        self.tables.get(table).map_or(&[], Vec::as_slice)
    }
}

/// A row that did not make it.
struct Failure {
    table: &'static str,
    key: String,
    why: String,
}

#[derive(Default)]
struct Report {
    imported: HashMap<&'static str, usize>,
    failures: Vec<Failure>,
    notes: Vec<String>,
}

type Insert = Query<'static, Postgres, PgArguments>;

impl Report {
    /// Runs one row's insert in a savepoint, so a row that breaks a
    /// constraint is reported and the rest carry on.
    async fn put(
        &mut self,
        conn: &mut PgConnection,
        table: &'static str,
        key: String,
        insert: Result<Insert, String>,
    ) -> Result<()> {
        let insert = match insert {
            Ok(insert) => insert,
            Err(why) => {
                self.failures.push(Failure { table, key, why });
                return Ok(());
            }
        };
        let mut savepoint = conn.begin().await?;
        match insert.execute(&mut *savepoint).await {
            Ok(_) => {
                savepoint.commit().await?;
                *self.imported.entry(table).or_default() += 1;
            }
            Err(e) => {
                savepoint.rollback().await?;
                self.failures.push(Failure { table, key, why: e.to_string() });
            }
        }
        Ok(())
    }
}

/// The key a row is reported by.
fn key(row: &Old, columns: &[&str]) -> String {
    columns
        .iter()
        .map(|c| match row.columns.get(*c) {
            Some(Value::Text(t)) => t.clone(),
            Some(Value::Integer(n)) => n.to_string(),
            other => format!("{other:?}"),
        })
        .collect::<Vec<_>>()
        .join(" / ")
}

pub async fn run(database: &str, options: Options) -> Result<()> {
    import(&Store::connect(database).await?, options).await
}

async fn import(store: &Store, options: Options) -> Result<()> {
    let pool = store.pool();
    for table in TABLES {
        let n: i64 =
            sqlx::query_scalar(sqlx::AssertSqlSafe(format!("select count(*) from {table}"))).fetch_one(pool).await?;
        if n > 0 {
            bail!("the deckhand schema already holds data ({n} rows in {table}); import only into an empty one");
        }
    }
    let path = options.sqlite.clone();
    let old = tokio::task::spawn_blocking(move || Sqlite::read(&path)).await??;
    println!("Importing {} into the deckhand schema", options.sqlite.display());

    let mut report = Report::default();
    let mut tx = pool.begin().await?;
    files(&old, &mut tx, &mut report).await?;
    tombstones(&old, &mut tx, &mut report).await?;
    meta(&old, &mut tx, &mut report).await?;
    rekordbox(&old, &mut tx, &mut report).await?;
    downloads(&old, &mut tx, &mut report).await?;
    endpoints(&old, &mut tx, &mut report).await?;
    devices(&old, &mut tx, &mut report).await?;
    spotify(&old, &mut tx, &mut report).await?;

    // Ids handed out from now on follow the old ones.
    for (table, after) in [("downloads", old.sequences.get("downloads").copied().unwrap_or(0)), ("spotify_activity", 0)]
    {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "select setval(pg_get_serial_sequence('deckhand.{table}', 'id'), greatest(max(id), $1)) from {table}
             having greatest(max(id), $1) > 0"
        )))
        .bind(after)
        .execute(&mut *tx)
        .await?;
    }

    println!();
    println!("{:<20} {:>8} {:>9} {:>7} {:>9}", "table", "sqlite", "imported", "failed", "postgres");
    for table in TABLES {
        let in_postgres: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("select count(*) from {table}")))
            .fetch_one(&mut *tx)
            .await?;
        let failed = report.failures.iter().filter(|f| f.table == table).count();
        println!(
            "{table:<20} {:>8} {:>9} {failed:>7} {in_postgres:>9}",
            old.rows(table).len(),
            report.imported.get(table).copied().unwrap_or(0),
        );
    }
    println!();
    check_blobs(&old, options.blobs.as_deref(), &mut report);
    for note in &report.notes {
        println!("{note}");
    }
    for f in &report.failures {
        println!("FAILED {} [{}]: {}", f.table, f.key, f.why);
    }
    if !report.failures.is_empty() && !options.keep_going {
        tx.rollback().await?;
        bail!("{} rows did not convert; nothing was imported (--keep-going keeps the rest)", report.failures.len());
    }
    tx.commit().await?;
    println!("Imported.");
    Ok(())
}

async fn files(old: &Sqlite, conn: &mut PgConnection, report: &mut Report) -> Result<()> {
    for row in old.rows("files") {
        let insert = (|| {
            // Null: not read yet; empty: read, and the file has none.
            let (isrc, isrc_read) = match row.text("isrc")? {
                None => (None, false),
                Some(isrc) if isrc.trim().is_empty() => (None, true),
                Some(isrc) => (Some(isrc.trim().to_ascii_uppercase()), true),
            };
            Ok(sqlx::query(
                "insert into files(name, size, mtime, hash, first_seen, state, error, source, isrc, isrc_read,
                     origin, dat, ext, two_ex, art_small, art_medium, recipe)
                 values($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, $17)",
            )
            .bind(row.required_text("name")?)
            .bind(row.required_int("size")?)
            .bind(row.required_time("mtime_ms")?)
            .bind(row.required_text("hash")?)
            .bind(row.required_time("first_seen_ms")?)
            .bind(row.required_text("state")?)
            .bind(row.text("error")?)
            .bind(row.text("source")?)
            .bind(isrc)
            .bind(isrc_read)
            .bind(row.text("origin")?)
            .bind(row.text("dat")?)
            .bind(row.text("ext")?)
            .bind(row.text("two_ex")?)
            .bind(row.text("art_small")?)
            .bind(row.text("art_medium")?)
            .bind(row.int32("recipe")?))
        })();
        report.put(conn, "files", key(row, &["name"]), insert).await?;
    }
    Ok(())
}

async fn tombstones(old: &Sqlite, conn: &mut PgConnection, report: &mut Report) -> Result<()> {
    for row in old.rows("tombstones") {
        let insert = (|| {
            Ok(sqlx::query("insert into tombstones(name, size, deleted_at) values($1, $2, $3)")
                .bind(row.required_text("name")?)
                .bind(row.required_int("size")?)
                .bind(row.required_time("deleted_ms")?))
        })();
        report.put(conn, "tombstones", key(row, &["name"]), insert).await?;
    }
    Ok(())
}

/// A setting as the server now keeps it: its key, and its value as JSON.
fn setting(key: &str, value: &str) -> Result<(String, serde_json::Value), String> {
    use serde_json::Value as Json;
    let flag = |value: &str| match value {
        "1" => Ok(Json::Bool(true)),
        "0" | "" => Ok(Json::Bool(false)),
        other => Err(format!("not 0 or 1: {other:?}")),
    };
    let id = |value: &str| value.trim().parse::<u64>().map(Json::from).map_err(|_| format!("not a number: {value:?}"));
    let json = |value: &str| serde_json::from_str::<Json>(value).map_err(|e| format!("not JSON: {e}"));
    Ok(match key {
        "downloads.aiff" | "spotify.paused" => (key.to_owned(), flag(value)?),
        "rekordbox_db_id" => (crate::rekordbox::DB_ID_KEY.to_owned(), id(value)?),
        "rekordbox_cloud_db_id" => (crate::rekordbox::CLOUD_DB_ID_KEY.to_owned(), id(value)?),
        "rekordbox_snapshot_ms" => {
            let ms = value.trim().parse::<i64>().map_err(|_| format!("not a time: {value:?}"))?;
            let at = time(ms).ok_or_else(|| format!("not a time: {ms}"))?;
            (crate::rekordbox::SNAPSHOT_KEY.to_owned(), Json::String(at.to_rfc3339()))
        }
        // Empty: no pass.
        "flacdownloader_pass" if value.is_empty() => (key.to_owned(), Json::Null),
        "flacdownloader_pass" | "antra_manifest" => (key.to_owned(), json(value)?),
        _ => return Err("a setting this server doesn't know".to_owned()),
    })
}

async fn meta(old: &Sqlite, conn: &mut PgConnection, report: &mut Report) -> Result<()> {
    for row in old.rows("meta") {
        let insert = (|| {
            let (key, value) = setting(&row.required_text("key")?, &row.required_text("value")?)?;
            Ok(sqlx::query("insert into meta(key, value) values($1, $2)").bind(key).bind(sqlx::types::Json(value)))
        })();
        report.put(conn, "meta", key(row, &["key"]), insert).await?;
    }
    Ok(())
}

async fn rekordbox(old: &Sqlite, conn: &mut PgConnection, report: &mut Report) -> Result<()> {
    for row in old.rows("rekordbox") {
        let insert = (|| {
            Ok(sqlx::query("insert into rekordbox(name, facts) values($1, $2::jsonb)")
                .bind(row.required_text("name")?)
                .bind(row.required_text("facts")?))
        })();
        report.put(conn, "rekordbox", key(row, &["name"]), insert).await?;
    }
    Ok(())
}

async fn downloads(old: &Sqlite, conn: &mut PgConnection, report: &mut Report) -> Result<()> {
    for row in old.rows("downloads") {
        let insert = (|| {
            Ok(sqlx::query(
                "insert into downloads(id, catalog_id, track, state, source, quality, file, error, attempts, playlist,
                     created_at, updated_at)
                 overriding system value
                 values($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)",
            )
            .bind(row.required_int("id")?)
            .bind(row.required_text("catalog_id")?)
            .bind(row.required_text("track")?)
            .bind(row.required_text("state")?)
            .bind(row.text("source")?)
            .bind(row.text("quality")?)
            .bind(row.text("file")?)
            .bind(row.text("error")?)
            .bind(row.required_text("attempts")?)
            .bind(row.text("playlist")?)
            .bind(row.required_time("created_ms")?)
            .bind(row.required_time("updated_ms")?))
        })();
        report.put(conn, "downloads", key(row, &["id"]), insert).await?;
    }
    Ok(())
}

async fn endpoints(old: &Sqlite, conn: &mut PgConnection, report: &mut Report) -> Result<()> {
    for row in old.rows("endpoints") {
        let parsed = (|| {
            let health: crate::downloads::health::Health = serde_json::from_str(&row.required_text("health")?)
                .map_err(|e| format!("health is not readable: {e}"))?;
            Ok((row.required_text("id")?, health))
        })();
        let key = key(row, &["id"]);
        match parsed {
            Ok((id, health)) => {
                let mut savepoint = conn.begin().await?;
                match crate::downloads::health::save(&mut *savepoint, &id, &health).await {
                    Ok(()) => {
                        savepoint.commit().await?;
                        *report.imported.entry("endpoints").or_default() += 1;
                    }
                    Err(e) => {
                        savepoint.rollback().await?;
                        report.failures.push(Failure { table: "endpoints", key, why: e.to_string() });
                    }
                }
            }
            Err(why) => report.failures.push(Failure { table: "endpoints", key, why }),
        }
    }
    Ok(())
}

async fn devices(old: &Sqlite, conn: &mut PgConnection, report: &mut Report) -> Result<()> {
    for row in old.rows("devices") {
        let insert = (|| {
            Ok(sqlx::query("insert into devices(token, environment, updated_at) values($1, $2, $3)")
                .bind(row.required_text("token")?)
                .bind(row.required_text("environment")?)
                .bind(row.required_time("updated_ms")?))
        })();
        // Tokens are secrets of a kind: reported by their start.
        let key: String = key(row, &["token"]).chars().take(8).collect();
        report.put(conn, "devices", format!("{key}…"), insert).await?;
    }
    Ok(())
}

async fn spotify(old: &Sqlite, conn: &mut PgConnection, report: &mut Report) -> Result<()> {
    for row in old.rows("spotify_playlists") {
        let insert = (|| {
            Ok(sqlx::query(
                "insert into spotify_playlists(id, name, owner, owned, image, total, snapshot, position, gone,
                     selected, read_snapshot, read_at, file, file_hash, error, linked_at)
                 values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)",
            )
            .bind(row.required_text("id")?)
            .bind(row.required_text("name")?)
            .bind(row.required_text("owner")?)
            .bind(row.flag("owned")?)
            .bind(row.text("image")?)
            .bind(row.int32("total")?)
            .bind(row.required_text("snapshot")?)
            .bind(row.int32("position")?)
            .bind(row.flag("gone")?)
            .bind(row.flag("selected")?)
            .bind(row.text("read_snapshot")?)
            .bind(row.time("read_ms")?)
            .bind(row.text("file")?)
            .bind(row.text("file_hash")?)
            .bind(row.text("error")?)
            .bind(row.time("linked_ms")?))
        })();
        report.put(conn, "spotify_playlists", key(row, &["id"]), insert).await?;
    }
    for row in old.rows("spotify_tracks") {
        let insert = (|| {
            Ok(sqlx::query("insert into spotify_tracks(playlist, position, track) values($1, $2, $3::jsonb)")
                .bind(row.required_text("playlist")?)
                .bind(row.int32("position")?)
                .bind(row.required_text("track")?))
        })();
        report.put(conn, "spotify_tracks", key(row, &["playlist", "position"]), insert).await?;
    }
    for row in old.rows("spotify_links") {
        let insert = (|| {
            Ok(sqlx::query("insert into spotify_links(key, download) values($1, $2)")
                .bind(row.required_text("key")?)
                .bind(row.required_int("download")?))
        })();
        report.put(conn, "spotify_links", key(row, &["key"]), insert).await?;
    }
    for row in old.rows("spotify_activity") {
        let insert = (|| {
            Ok(sqlx::query(
                "insert into spotify_activity(id, at, kind, playlist, name, count, added, removed, detail)
                 overriding system value
                 values($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            )
            .bind(row.required_int("id")?)
            .bind(row.required_time("ms")?)
            .bind(row.required_text("kind")?)
            .bind(row.text("playlist")?)
            .bind(row.text("name")?)
            .bind(row.int32("count")?)
            .bind(row.int32("added")?)
            .bind(row.int32("removed")?)
            .bind(row.text("detail")?))
        })();
        report.put(conn, "spotify_activity", key(row, &["id"]), insert).await?;
    }
    Ok(())
}

/// Says whether every blob the rows name is in `blobs/`.
fn check_blobs(old: &Sqlite, blobs: Option<&Path>, report: &mut Report) {
    let mut named = BTreeSet::new();
    for row in old.rows("files") {
        for column in ["dat", "ext", "two_ex", "art_small", "art_medium"] {
            if let Ok(Some(hash)) = row.text(column) {
                named.insert(hash);
            }
        }
    }
    for row in old.rows("rekordbox") {
        let Ok(facts) = row.required_text("facts") else {
            continue;
        };
        let Ok(facts) = serde_json::from_str::<serde_json::Value>(&facts) else {
            continue;
        };
        for part in ["dat", "ext", "two_ex"] {
            if let Some(hash) = facts.pointer(&format!("/analysis/{part}")).and_then(serde_json::Value::as_str) {
                named.insert(hash.to_owned());
            }
        }
    }
    let Some(dir) = blobs.filter(|dir| dir.is_dir()) else {
        report.notes.push(format!("Blobs: the rows name {}; not checked (no blobs folder given)", named.len()));
        return;
    };
    let store = crate::blobs::Blobs::new(dir.to_owned());
    let missing: Vec<&String> = named
        .iter()
        .filter(|hash| !store.as_ref().ok().and_then(|s| s.path(hash)).is_some_and(|p| p.is_file()))
        .collect();
    report.notes.push(format!(
        "Blobs: the rows name {}, {} of them missing from {}",
        named.len(),
        missing.len(),
        dir.display()
    ));
    for hash in missing.iter().take(20) {
        report.notes.push(format!("  missing blob {hash}"));
    }
}

#[cfg(test)]
mod tests {
    use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

    use super::*;

    /// The last SQLite schema, as the server created it.
    const OLD_SCHEMA: &str = "
        create table files(name text primary key, size integer not null, mtime_ms integer not null,
            hash text not null, first_seen_ms integer not null, state text not null, error text, source text,
            origin text, dat text, ext text, two_ex text, art_small text, art_medium text,
            recipe integer not null default 0, isrc text);
        create table tombstones(name text primary key, size integer not null, deleted_ms integer not null);
        create table meta(key text primary key, value text not null);
        create table rekordbox(name text primary key, facts text not null);
        create table downloads(id integer primary key autoincrement, catalog_id text not null, track text not null,
            state text not null, source text, quality text, file text, error text,
            attempts text not null default '[]', created_ms integer not null, updated_ms integer not null,
            playlist text);
        create table endpoints(id text primary key, health text not null);
        create table devices(token text primary key, environment text not null, updated_ms integer not null);
        create table spotify_playlists(id text primary key, name text not null, owner text not null default '',
            owned integer not null default 0, image text, total integer not null default 0,
            snapshot text not null default '', position integer not null default 0, gone integer not null default 0,
            selected integer not null default 0, read_snapshot text, read_ms integer, file text, file_hash text,
            error text, linked_ms integer);
        create table spotify_tracks(playlist text not null, position integer not null, track text not null,
            primary key(playlist, position));
        create table spotify_links(key text primary key, download integer not null);
        create table spotify_activity(id integer primary key, ms integer not null, kind text not null,
            playlist text, name text, count integer not null default 0, added integer not null default 0,
            removed integer not null default 0, detail text);";

    fn old_database(dir: &Path, bad_row: bool) -> PathBuf {
        let path = dir.join("deckhand.db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(OLD_SCHEMA).unwrap();
        let (hash, token) = ("b".repeat(64), "c".repeat(64));
        conn.execute_batch(&format!(
            "insert into files values('a.flac', 10, 1795080312721, '{hash}', 1795080312000, 'ready', null,
                 '{{\"title\":\"A\",\"bpm_x100\":12400,\"key\":\"8A\"}}', 'rbxport', '{hash}', null, null,
                 null, null, 1, 'gbduw0000059');
             insert into files values('b.m3u8', 5, 1795080312721, '{hash}', 1795080312000, 'other', null, null,
                 null, null, null, null, null, null, 0, null);
             insert into tombstones values('gone.flac', 3, 1795080312000);
             insert into rekordbox values('a.flac', '{{\"content_id\":5,\"bpm_x100\":12400}}');
             insert into devices values('{token}', 'development', 1795080312000);
             insert into meta values('downloads.aiff', '1');
             insert into meta values('rekordbox_snapshot_ms', '1795080312720');
             insert into meta values('flacdownloader_pass', '');
             insert into downloads(catalog_id, track, state, file, created_ms, updated_ms)
                 values('deezer:1', '{{\"id\":\"deezer:1\",\"title\":\"A\",\"artists\":[],\"album\":\"\",\"duration_sec\":1,\"explicit\":false}}',
                 'done', 'a.flac', 1795080312000, 1795080312000);
             insert into endpoints values('deezer:x', '{{\"reliability\":0.9999999999999997,\"speed_kbps\":null,
                 \"latency_ms\":12.5,\"downloads\":3,\"failures_in_row\":0,\"resting_until_ms\":null,
                 \"last_error\":null,\"last_ok_ms\":1795080312000}}');
             insert into spotify_playlists(id, name, selected, read_ms) values('p1', 'House', 1, 1795080312000);
             insert into spotify_tracks values('p1', 0, '{{\"id\":\"t1\",\"title\":\"A\",\"artists\":[],
                 \"album\":\"\",\"isrc\":null,\"duration_ms\":1000,\"cover\":null}}');
             insert into spotify_links values('isrc:GBDUW0000059', 1);
             insert into spotify_activity values(7, 1795080312000, 'queued', 'p1', 'House', 1, 0, 0, null);"
        ))
        .unwrap();
        if bad_row {
            // Not a state a file can be in.
            conn.execute_batch(&format!(
                "insert into files values('c.flac', 1, 1, '{hash}', 1, 'weird', null, null, null, null, null, null,
                     null, null, 0, null);"
            ))
            .unwrap();
        }
        path
    }

    async fn count(store: &Store, table: &str) -> i64 {
        sqlx::query_scalar(sqlx::AssertSqlSafe(format!("select count(*) from {table}")))
            .fetch_one(store.pool())
            .await
            .unwrap()
    }

    #[sqlx::test(migrations = false)]
    async fn copies_every_table(_: PgPoolOptions, options: PgConnectOptions) {
        let store = crate::store::tests::store(options).await;
        let dir = tempfile::tempdir().unwrap();
        let sqlite = old_database(dir.path(), false);
        import(&store, Options { sqlite: sqlite.clone(), blobs: None, keep_going: false }).await.unwrap();
        for table in TABLES {
            let expected = if table == "files" {
                2
            } else if table == "meta" {
                3
            } else {
                1
            };
            assert_eq!(count(&store, table).await, expected, "{table}");
        }
        let a = store.get("a.flac").await.unwrap().unwrap();
        assert_eq!((a.mtime_ms, a.first_seen_ms), (1_795_080_312_721, 1_795_080_312_000));
        assert_eq!(store.isrcs().await.unwrap().get("GBDUW0000059").map(String::as_str), Some("a.flac"));
        assert!(store.isrc_unread().await.unwrap().is_empty());
        assert_eq!(store.meta::<bool>("downloads.aiff").await.unwrap(), Some(true));
        let snapshot: String = store.meta(crate::rekordbox::SNAPSHOT_KEY).await.unwrap().unwrap();
        assert_eq!(DateTime::parse_from_rfc3339(&snapshot).unwrap().timestamp_millis(), 1_795_080_312_720);
        let health = crate::downloads::health::Registry::load(store.clone()).await.unwrap().get("deezer:x");
        assert_eq!((health.reliability, health.downloads), (0.999_999_999_999_999_7, 3));
        // New ids follow the old ones.
        let track = crate::downloads::db::get(&store, 1).await.unwrap().unwrap().track;
        let next = crate::downloads::db::insert(&store, &track, None).await.unwrap();
        assert_eq!(next.id, 2);
        crate::spotify::db::log(&store, deckhand_model::spotify::ActivityKind::Kept, &Default::default())
            .await
            .unwrap();
        let newest = crate::spotify::db::activity(&store, None, 1).await.unwrap();
        assert_eq!(newest[0].id, 8);
        // Once is enough.
        let again = import(&store, Options { sqlite, blobs: None, keep_going: false }).await;
        assert!(again.unwrap_err().to_string().contains("already holds data"));
    }

    #[sqlx::test(migrations = false)]
    async fn a_bad_row_keeps_nothing_unless_asked(_: PgPoolOptions, options: PgConnectOptions) {
        let store = crate::store::tests::store(options).await;
        let dir = tempfile::tempdir().unwrap();
        let sqlite = old_database(dir.path(), true);
        let refused = import(&store, Options { sqlite: sqlite.clone(), blobs: None, keep_going: false }).await;
        assert!(refused.unwrap_err().to_string().contains("1 rows did not convert"));
        assert_eq!(count(&store, "files").await, 0);
        import(&store, Options { sqlite, blobs: None, keep_going: true }).await.unwrap();
        assert_eq!(count(&store, "files").await, 2);
        assert_eq!(count(&store, "downloads").await, 1);
    }
}
