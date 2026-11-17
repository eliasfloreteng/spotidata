//! Keeps the store in step with the music folder.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::time::UNIX_EPOCH;

use anyhow::Result;
use deckhand_model::{is_audio, is_mirrored};
use tracing::{info, warn};

use crate::analyse;
use crate::store::{State, Store};

/// One pass over the folder. Returns whether anything changed.
pub fn scan(music: &Path, store: &Store) -> Result<bool> {
    let known: HashMap<String, (u64, i64, String)> =
        store.all()?.into_iter().map(|r| (r.name, (r.size, r.mtime_ms, r.hash))).collect();
    let mut seen = std::collections::HashSet::new();
    let mut changed = false;
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
                store.touch(&name, size, mtime_ms)?;
                changed = true;
                continue;
            }
        }
        if is_audio(&name) {
            let source = match analyse::source_from_tags(&path) {
                Ok(source) => serde_json::to_string(&source).ok(),
                Err(e) => {
                    warn!(%name, error = %e, "could not read tags");
                    None
                }
            };
            info!(%name, "new or changed track");
            store.upsert(&name, size, mtime_ms, &hash, State::Pending, source.as_deref())?;
        } else {
            store.upsert(&name, size, mtime_ms, &hash, State::Other, None)?;
        }
        changed = true;
    }
    for (name, (size, _, _)) in &known {
        if !seen.contains(name) {
            info!(%name, "removed");
            store.remove(name, *size)?;
            changed = true;
        }
    }
    Ok(changed)
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
