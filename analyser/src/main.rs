//! `rbx-analyse <file>…`: rbxport's tempo and key of each file, one JSON
//! object per line, in the order given. `rbx-analyse --version` names the
//! analysis, so a stored result can say what measured it.
//!
//! A file that cannot be decoded or measured gets `{"file", "error"}` on its
//! line instead, so one bad download never costs the rest of the batch. The
//! exit code is non-zero only for a usage error.

use std::io::{BufWriter, Write};
use std::path::Path;

use serde::Serialize;

/// Longer than any preview; a whole file is only ever read this far, as
/// rbxport's own `DECODE_CAP_SECS` does.
const DECODE_CAP_SECS: f64 = 1800.0;

/// The rbxport rev `Cargo.toml` pins; bump the two together.
const RBXPORT_REV: &str = "ebc7ef22";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Measured<'a> {
    file: &'a str,
    bpm: f64,
    /// 0–1: how far the chosen tempo stands out from the next best that is not a multiple of it.
    bpm_confidence: f64,
    /// Seconds of audio measured.
    seconds: f64,
    /// `None` when rbxport found no key (too short, or no tonal content).
    key: Option<Key>,
    /// RMS over the audio, 0–1.
    rms: f32,
    peak: f32,
}

#[derive(Serialize)]
struct Key {
    /// e.g. `Ebm`.
    name: String,
    camelot: String,
    /// 0 = C.
    tonic: u8,
    minor: bool,
}

#[derive(Serialize)]
struct Failed<'a> {
    file: &'a str,
    error: String,
}

fn measure(path: &str) -> Result<Measured<'_>, String> {
    let audio = rbl_audio::decode_mono(Path::new(path), Some(DECODE_CAP_SECS)).map_err(|e| e.to_string())?;
    // Deckhand's settings: rekordbox's constant-tempo grid over 70–180 BPM,
    // beats placed on the kick attacks.
    let mut options = rbl_analysis::AnalysisPreset::Rekordbox.options();
    options.tempo.placement = rbl_analysis::tempo::Placement::Attack;
    let analysis = rbl_analysis::analyse_with(&audio.samples, audio.sample_rate, options);
    if analysis.tempo.bpm <= 0.0 {
        return Err("no tempo found".into());
    }
    Ok(Measured {
        file: path,
        bpm: analysis.tempo.bpm,
        bpm_confidence: analysis.tempo.confidence,
        seconds: audio.duration_secs(),
        key: analysis.key.map(|k| Key { camelot: k.camelot(), name: k.name, tonic: k.tonic, minor: k.minor }),
        rms: analysis.rms,
        peak: analysis.peak,
    })
}

fn main() {
    let files: Vec<String> = std::env::args().skip(1).collect();
    if files.first().is_some_and(|a| a == "--version") {
        println!("rbxport@{RBXPORT_REV}+{}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if files.is_empty() {
        eprintln!("usage: rbx-analyse <file>…");
        std::process::exit(2);
    }
    let mut out = BufWriter::new(std::io::stdout().lock());
    for file in &files {
        let line = match measure(file) {
            Ok(m) => serde_json::to_string(&m),
            Err(error) => serde_json::to_string(&Failed { file, error }),
        };
        // A line per file as soon as it is measured, so a caller can stream.
        let _ = writeln!(out, "{}", line.unwrap_or_default());
        let _ = out.flush();
    }
}
