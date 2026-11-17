//! Tags, artwork and rbxport's analysis of one audio file.
//!
//! The decode-and-analyse loop follows rbxport's `src-tauri/src/analysis.rs`
//! (`analyse_file_with` and `usb_source`), GPL-2.0-or-later, without the live
//! waveform drawing the desktop app does.

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use deckhand_model::Artwork;
use rbl_export::SourceTrack;

use crate::blobs::Blobs;

/// The longest stretch decoded for tempo and key; rbxport's `DECODE_CAP_SECS`.
const DECODE_CAP_SECS: f64 = 1800.0;

/// What a track looks like before analysis: its tags.
pub fn source_from_tags(path: &Path) -> Result<SourceTrack> {
    let tags = rbl_db::import::read_tags(path).map_err(|e| anyhow!("{e}"))?;
    let title = if tags.title.trim().is_empty() {
        path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
    } else {
        tags.title
    };
    Ok(SourceTrack {
        id: 0,
        title,
        artist: tags.artist,
        album: tags.album,
        genre: tags.genre,
        label: tags.label,
        key: tags.key,
        comment: tags.comment,
        duration_sec: u16::try_from(tags.duration_sec).unwrap_or(u16::MAX),
        bitrate: tags.bitrate,
        sample_rate: tags.sample_rate,
        file_size: tags.file_size,
        year: tags.year,
        metadata: rbl_core::ExportMetadata {
            track_number: u32::from(tags.track_no),
            bit_depth: u16::from(tags.bit_depth),
            ..rbl_core::ExportMetadata::default()
        },
        cues: Some(Vec::new()),
        ..SourceTrack::default()
    })
}

/// The cover, at the two sizes a stick holds.
pub fn artwork(path: &Path, blobs: &Blobs) -> Result<Option<Artwork>> {
    let Some(bytes) = rbl_db::import::read_artwork(path).map_err(|e| anyhow!("{e}"))? else {
        return Ok(None);
    };
    let image = image::load_from_memory(&bytes).context("decoding the cover")?;
    let jpeg = |side: u32| -> Result<Vec<u8>> {
        let resized = image.resize_to_fill(side, side, image::imageops::FilterType::Lanczos3).to_rgb8();
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90).encode_image(&resized)?;
        Ok(out)
    };
    Ok(Some(Artwork { small: blobs.put(&jpeg(80)?)?, medium: blobs.put(&jpeg(240)?)? }))
}

pub struct Analysed {
    pub bpm_x100: u32,
    pub key: Option<String>,
    pub duration_sec: u16,
    pub dat: Vec<u8>,
    pub ext: Vec<u8>,
    pub two_ex: Vec<u8>,
}

/// Beat grid, key and waveforms, as ANLZ files.
pub fn analyse(path: &Path) -> Result<Analysed> {
    let mut options = rbl_analysis::AnalysisPreset::Rekordbox.options();
    options.tempo.min_bpm = 70.0;
    options.tempo.max_bpm = 180.0;
    options.tempo.placement = rbl_analysis::tempo::Placement::Attack;

    let mut stream = rbl_audio::MonoStream::open(path).map_err(|e| anyhow!("decoding: {e}"))?;
    let rate = stream.sample_rate();
    let mut creator = rbl_analysis::wave_creator::WaveCreator::new(rate);
    if let Some(frames) = stream.expected_frames() {
        creator.reserve(frames);
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let cap = (DECODE_CAP_SECS * f64::from(rate)) as usize;
    let mut head: Vec<f32> = Vec::with_capacity(cap.min(1 << 24));
    // Past the head, the overview waveform still needs the rest.
    let mut builder: Option<rbl_analysis::waveform::Builder> = None;
    let mut past_head = false;
    while let Some((chunk, frames)) = stream.next_frames() {
        creator.push(frames);
        if past_head {
            if let Some(builder) = builder.as_mut() {
                builder.push(chunk);
            }
        } else {
            head.extend_from_slice(chunk);
            if head.len() > cap {
                let mut b = rbl_analysis::waveform::Builder::new(rate);
                b.push(&head);
                builder = Some(b);
                head.truncate(cap);
                head.shrink_to_fit();
                past_head = true;
            }
        }
    }
    if head.is_empty() {
        return Err(anyhow!("decoded no samples"));
    }
    let mut analysis = rbl_analysis::analyse_with(&head, rate, options);
    #[allow(clippy::cast_precision_loss)]
    let mut duration = head.len() as f64 / f64::from(rate.max(1));
    if let Some(builder) = builder {
        #[allow(clippy::cast_precision_loss)]
        {
            duration = builder.samples() as f64 / f64::from(rate.max(1));
        }
        analysis.tempo.extend_to(duration);
    }
    let waves = creator.finish();
    let waves = rbl_anlz::RekordboxWaves {
        pwav: waves.pwav,
        pwv2: waves.pwv2,
        pwvc: waves.pwvc,
        pwv3: waves.pwv3,
        pwv4: waves.pwv4,
        pwv5: waves.pwv5,
        pwv6: waves.pwv6,
        pwv7: waves.pwv7,
    };
    let beats: Vec<rbl_anlz::Beat> = analysis
        .tempo
        .beats
        .iter()
        .map(|b| rbl_anlz::Beat { beat_number: b.beat_number, tempo_x100: b.tempo_x100, time_ms: b.time_ms })
        .collect();
    // The path inside the files is rewritten by the export to where the
    // track lands on the stick.
    let files = rbl_anlz::author_with_rekordbox_waves(
        "/pending",
        &beats,
        &waves,
        rbl_anlz::Existing { dat: None, ext: None, two_ex: None },
    );
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let bpm_x100 = (analysis.tempo.bpm * 100.0).round().clamp(0.0, f64::from(u32::MAX)) as u32;
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let duration_sec = duration.round().clamp(0.0, f64::from(u16::MAX)) as u16;
    Ok(Analysed {
        bpm_x100,
        key: analysis.key.as_ref().map(|k| k.name.clone()),
        duration_sec,
        dat: files.dat,
        ext: files.ext,
        two_ex: files.two_ex,
    })
}
