//! Analyses pending tracks in the background.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use deckhand_model::{Analysis, Artwork, Origin};
use rbl_export::SourceTrack;
use tracing::{info, warn};

use crate::analyse;
use crate::blobs::Blobs;
use crate::store::{Row, Store};

/// Starts `threads` workers, each analysing one track at a time on a
/// blocking thread.
pub fn spawn(threads: usize, music: PathBuf, store: Store, blobs: Blobs) {
    let busy: Arc<tokio::sync::Mutex<HashSet<String>>> = Arc::default();
    for _ in 0..threads {
        let (music, store, blobs, busy) = (music.clone(), store.clone(), blobs.clone(), busy.clone());
        tokio::spawn(async move {
            loop {
                let next = {
                    let mut busy = busy.lock().await;
                    match store.next_pending(&busy).await {
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
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                };
                let name = row.name.clone();
                if let Err(e) = process(&music, &store, &blobs, row).await {
                    warn!(%name, error = %e, "analysis bookkeeping failed");
                }
                busy.lock().await.remove(&name);
            }
        });
    }
}

/// What analysing one file came to.
enum Outcome {
    Analysed { source: SourceTrack, analysis: Analysis, artwork: Option<Artwork>, secs: f32 },
    Failed { source: SourceTrack, error: String, artwork: Option<Artwork> },
}

async fn process(music: &Path, store: &Store, blobs: &Blobs, row: Row) -> anyhow::Result<()> {
    let facts = match store.rekordbox_facts(&row.name).await? {
        Some(facts) => match serde_json::from_value::<crate::rekordbox::Facts>(facts) {
            Ok(facts) => Some(facts),
            Err(e) => {
                warn!(name = %row.name, error = %e, "unreadable rekordbox facts");
                None
            }
        },
        None => None,
    };
    let (path, blobs_for_task, source) = (music.join(&row.name), blobs.clone(), row.source.clone());
    // A panic in a decoder must not take the worker with it: it ends the
    // blocking task, not this one.
    let outcome = tokio::task::spawn_blocking(move || analyse_file(&path, &blobs_for_task, source.as_deref(), facts));
    match outcome.await {
        Ok(Ok(Outcome::Analysed { source, analysis, artwork, secs })) => {
            let json = serde_json::to_string(&source)?;
            if store.analysed(&row.name, &row.hash, &json, &analysis, artwork.as_ref()).await?
                && analysis.origin == Origin::Rbxport
            {
                info!(name = %row.name, bpm = f64::from(source.bpm_x100) / 100.0, key = %source.key, secs, "analysed");
            }
        }
        Ok(Ok(Outcome::Failed { source, error, artwork })) => {
            warn!(name = %row.name, %error, "analysis failed");
            let json = serde_json::to_string(&source)?;
            store.failed(&row.name, &row.hash, &error, Some(&json), artwork.as_ref()).await?;
        }
        Ok(Err(e)) => return Err(e),
        Err(e) => {
            warn!(name = %row.name, error = %e, "analysis panicked");
            store.failed(&row.name, &row.hash, "the analyser crashed on this file", None, None).await?;
        }
    }
    Ok(())
}

/// Tags, cover and analysis of one file: rekordbox's, when its facts have
/// one, else rbxport's.
fn analyse_file(
    path: &Path,
    blobs: &Blobs,
    source: Option<&str>,
    facts: Option<crate::rekordbox::Facts>,
) -> anyhow::Result<Outcome> {
    let started = Instant::now();
    let mut source: SourceTrack = match source.map(serde_json::from_str) {
        Some(Ok(source)) => source,
        _ => analyse::source_from_tags(path).unwrap_or_else(|_| SourceTrack {
            title: path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
            cues: Some(Vec::new()),
            ..SourceTrack::default()
        }),
    };
    let artwork = match analyse::artwork(path, blobs) {
        Ok(artwork) => artwork,
        Err(e) => {
            warn!(path = %path.display(), error = %e, "could not read the cover");
            None
        }
    };
    if let Some(facts) = facts {
        facts.apply(&mut source);
        if let Some(analysis) = facts.analysis {
            return Ok(Outcome::Analysed { source, analysis, artwork, secs: started.elapsed().as_secs_f32() });
        }
    }
    match analyse::analyse(path) {
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
            Ok(Outcome::Analysed { source, analysis, artwork, secs: started.elapsed().as_secs_f32() })
        }
        Err(e) => Ok(Outcome::Failed { source, error: e.to_string(), artwork }),
    }
}
