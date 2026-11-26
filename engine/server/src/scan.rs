//! Keeps the store in step with the music folder.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::Path;
use std::time::UNIX_EPOCH;

use anyhow::Result;
use deckhand_model::{is_audio, is_mirrored};
use tracing::{info, warn};

use crate::analyse;
use crate::store::{State, Store};

/// What a pass over the folder found to record.
enum Change {
    /// Only the stat changed: the content is the same.
    Touched {
        name: String,
        size: u64,
        mtime_ms: i64,
    },
    /// A new file, or new content under an old name.
    Changed {
        name: String,
        size: u64,
        mtime_ms: i64,
        hash: String,
        state: State,
        source: Option<String>,
    },
    Removed {
        name: String,
        size: u64,
    },
}

/// One pass over the folder. Returns whether anything changed.
pub async fn scan(music: &Path, store: &Store) -> Result<bool> {
    let known: HashMap<String, (u64, i64, String)> =
        store.all().await?.into_iter().map(|r| (r.name, (r.size, r.mtime_ms, r.hash))).collect();
    let folder = music.to_owned();
    let changes = tokio::task::spawn_blocking(move || look(&folder, &known)).await??;
    let changed = !changes.is_empty();
    for change in changes {
        match change {
            Change::Touched { name, size, mtime_ms } => store.touch(&name, size, mtime_ms).await?,
            Change::Changed { name, size, mtime_ms, hash, state, source } => {
                store.upsert(&name, size, mtime_ms, &hash, state, source.as_deref()).await?;
            }
            Change::Removed { name, size } => {
                info!(%name, "removed");
                store.remove(&name, size).await?;
            }
        }
    }
    // Which recording each file holds, so a search can say it is already here.
    let unread = store.isrc_unread().await?;
    if !unread.is_empty() {
        let folder = music.to_owned();
        let read: Vec<(String, Option<String>)> = tokio::task::spawn_blocking(move || {
            unread
                .into_iter()
                .map(|name| {
                    let isrc = crate::tags::isrc(&folder.join(&name));
                    (name, isrc)
                })
                .collect()
        })
        .await?;
        for (name, isrc) in read {
            store.set_isrc(&name, isrc.as_deref()).await?;
        }
    }
    Ok(changed)
}

/// Compares the folder with what the store knows, reading and hashing what
/// changed.
fn look(music: &Path, known: &HashMap<String, (u64, i64, String)>) -> Result<Vec<Change>> {
    let mut seen = HashSet::new();
    let mut changes = Vec::new();
    for entry in std::fs::read_dir(music)? {
        let entry = entry?;
        let Ok(name) = entry.file_name().into_string() else {
            warn!(name = ?entry.file_name(), "skipping a file name that is not UTF-8");
            continue;
        };
        if !is_mirrored(&name) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(meta) if meta.is_file() => meta,
            _ => continue,
        };
        let size = meta.len();
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .and_then(|d| i64::try_from(d.as_millis()).ok())
            .unwrap_or(0);
        seen.insert(name.clone());
        if let Some((s, m, _)) = known.get(&name) {
            if *s == size && *m == mtime_ms {
                continue;
            }
        }
        let path = entry.path();
        // A file still being written (a download, Syncthing) shows up again
        // next pass; hashing it now would only be wasted.
        if std::time::SystemTime::now().duration_since(meta.modified().unwrap_or(UNIX_EPOCH)).unwrap_or_default()
            < std::time::Duration::from_secs(5)
        {
            continue;
        }
        let hash = match hash_file(&path) {
            Ok(hash) => hash,
            Err(e) => {
                warn!(%name, error = %e, "could not read file");
                continue;
            }
        };
        if let Some((_, _, old)) = known.get(&name) {
            if *old == hash {
                changes.push(Change::Touched { name, size, mtime_ms });
                continue;
            }
        }
        let (state, source) = if is_audio(&name) {
            let source = match analyse::source_from_tags(&path) {
                Ok(source) => serde_json::to_string(&source).ok(),
                Err(e) => {
                    warn!(%name, error = %e, "could not read tags");
                    None
                }
            };
            info!(%name, "new or changed track");
            (State::Pending, source)
        } else {
            (State::Other, None)
        };
        changes.push(Change::Changed { name, size, mtime_ms, hash, state, source });
    }
    for (name, (size, _, _)) in known {
        if !seen.contains(name) {
            changes.push(Change::Removed { name: name.clone(), size: *size });
        }
    }
    Ok(changes)
}

pub fn hash_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}
