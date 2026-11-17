//! Analyses pending tracks in the background.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use deckhand_model::{Analysis, Origin};
use rbl_export::SourceTrack;
use tracing::{info, warn};

use crate::analyse;
use crate::blobs::Blobs;
use crate::store::{Row, Store};

pub fn spawn(threads: usize, music: PathBuf, store: Store, blobs: Blobs) {
    let busy: Arc<Mutex<HashSet<String>>> = Arc::default();
    for i in 0..threads {
        let (music, store, blobs, busy) = (music.clone(), store.clone(), blobs.clone(), busy.clone());
        std::thread::Builder::new()
            .name(format!("analysis-{i}"))
            .spawn(move || loop {
                let next = {
                    let mut busy = busy.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                    match store.next_pending(&busy) {
                        Ok(Some(row)) => {
                            busy.insert(row.name.clone());
                            Some(row)
                        }
                        Ok(None) => None,
                        Err(e) => {
                            warn!(error = %e, "could not read the queue");
                            None
                        }
                    }
                };
                let Some(row) = next else {
                    std::thread::sleep(Duration::from_secs(5));
                    continue;
                };
                let name = row.name.clone();
                // A panic in a decoder must not take the worker with it.
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    process(&music, &store, &blobs, &row)
                }));
                match outcome {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => warn!(%name, error = %e, "analysis bookkeeping failed"),
                    Err(_) => {
                        warn!(%name, "analysis panicked");
                        let _ = store.failed(&name, &row.hash, "the analyser crashed on this file", None, None);
                    }
                }
                busy.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&name);
            })
            .ok();
    }
}

fn process(music: &std::path::Path, store: &Store, blobs: &Blobs, row: &Row) -> anyhow::Result<()> {
    let path = music.join(&row.name);
    let started = Instant::now();
    let mut source: SourceTrack = match row.source.as_deref().map(serde_json::from_str) {
        Some(Ok(source)) => source,
        _ => analyse::source_from_tags(&path).unwrap_or_else(|_| SourceTrack {
            title: path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
            cues: Some(Vec::new()),
            ..SourceTrack::default()
        }),
    };
    let artwork = match analyse::artwork(&path, blobs) {
        Ok(artwork) => artwork,
        Err(e) => {
            warn!(name = %row.name, error = %e, "could not read the cover");
            None
        }
    };
    if let Some(facts) = store.rekordbox_facts(&row.name)? {
        match serde_json::from_str::<crate::rekordbox::Facts>(&facts) {
            Ok(facts) => {
                facts.apply(&mut source);
                if let Some(analysis) = &facts.analysis {
                    let json = serde_json::to_string(&source)?;
                    store.analysed(&row.name, &row.hash, &json, analysis, artwork.as_ref())?;
                    return Ok(());
                }
            }
            Err(e) => warn!(name = %row.name, error = %e, "unreadable rekordbox facts"),
        }
    }
    match analyse::analyse(&path) {
        Ok(result) => {
            source.bpm_x100 = result.bpm_x100;
            if let Some(key) = result.key {
                source.key = key;
            }
            source.duration_sec = result.duration_sec;
            source.metadata.analysed = u32::try_from(rbl_db::write::ANALYSED_BY_THIS_APP).unwrap_or_default();
            let analysis = Analysis {
                origin: Origin::Rbxport,
                dat: blobs.put(&result.dat)?,
                ext: Some(blobs.put(&result.ext)?),
                two_ex: Some(blobs.put(&result.two_ex)?),
            };
            let json = serde_json::to_string(&source)?;
            if store.analysed(&row.name, &row.hash, &json, &analysis, artwork.as_ref())? {
                info!(name = %row.name, bpm = f64::from(source.bpm_x100) / 100.0, key = %source.key,
                      secs = started.elapsed().as_secs_f32(), "analysed");
            }
        }
        Err(e) => {
            warn!(name = %row.name, error = %e, "analysis failed");
            let json = serde_json::to_string(&source)?;
            store.failed(&row.name, &row.hash, &e.to_string(), Some(&json), artwork.as_ref())?;
        }
    }
    Ok(())
}
