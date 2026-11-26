//! FLAC to AIFF, for players that don't play FLAC: the same samples, bit
//! depth and rate, with the tags (and cover) as an ID3 chunk.

use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::Path;

use anyhow::{Context, Result};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as Decode;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::tags;

/// Writes the FLAC `src` as an AIFF at `dst`, tags included.
pub fn convert(src: &Path, dst: &Path) -> Result<()> {
    decode_into(src, dst).context("converting to AIFF")?;
    tags::copy(src, dst).context("tagging the AIFF")
}

fn decode_into(src: &Path, dst: &Path) -> Result<()> {
    let stream = MediaSourceStream::new(Box::new(File::open(src)?), Default::default());
    let mut hint = Hint::new();
    hint.with_extension("flac");
    let mut format = symphonia::default::get_probe()
        .format(&hint, stream, &FormatOptions::default(), &MetadataOptions::default())?
        .format;
    let track = format.default_track().context("no audio in the file")?;
    let (track_id, params) = (track.id, track.codec_params.clone());
    let channels = params.channels.context("unknown channel count")?.count();
    let rate = params.sample_rate.context("unknown sample rate")?;
    let bits = params.bits_per_sample.context("unknown bit depth")?;
    let width = bits.div_ceil(8) as usize;
    let mut decoder = symphonia::default::get_codecs().make(&params, &DecoderOptions::default())?;

    let mut out = BufWriter::new(File::create(dst)?);
    // Sizes and the frame count are filled in once the samples are written.
    out.write_all(b"FORM\0\0\0\0AIFF")?;
    out.write_all(b"COMM")?;
    out.write_all(&18u32.to_be_bytes())?;
    out.write_all(&u16::try_from(channels)?.to_be_bytes())?;
    out.write_all(&0u32.to_be_bytes())?;
    out.write_all(&u16::try_from(bits)?.to_be_bytes())?;
    out.write_all(&extended(rate))?;
    out.write_all(b"SSND\0\0\0\0")?;
    out.write_all(&[0; 8])?; // offset, block size

    let mut samples: Option<SampleBuffer<i32>> = None;
    let mut bytes = Vec::new();
    let mut written = 0u64;
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(Decode::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(e.into()),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = decoder.decode(&packet)?;
        let buffer = samples.get_or_insert_with(|| SampleBuffer::new(decoded.capacity() as u64, *decoded.spec()));
        buffer.copy_interleaved_ref(decoded);
        // Full-scale i32 in; big-endian, left-justified in `width` bytes out.
        bytes.clear();
        for sample in buffer.samples() {
            bytes.extend_from_slice(&sample.to_be_bytes()[..width]);
        }
        out.write_all(&bytes)?;
        written += bytes.len() as u64;
    }
    let frames = written / (channels * width) as u64;
    if frames == 0 {
        anyhow::bail!("no samples decoded");
    }
    if written % 2 == 1 {
        out.write_all(&[0])?; // chunks are of even length
    }
    let ssnd = u32::try_from(written + 8).context("too long for an AIFF")?;
    let form = 4 + (8 + 18) + (8 + u64::from(ssnd) + written % 2);
    let mut out = out.into_inner().map_err(std::io::IntoInnerError::into_error)?;
    out.seek(SeekFrom::Start(4))?;
    out.write_all(&u32::try_from(form)?.to_be_bytes())?;
    out.seek(SeekFrom::Start(22))?;
    out.write_all(&u32::try_from(frames)?.to_be_bytes())?;
    out.seek(SeekFrom::Start(42))?;
    out.write_all(&ssnd.to_be_bytes())?;
    out.sync_all()?;
    Ok(())
}

/// A sample rate as the 80-bit IEEE extended float AIFF wants.
fn extended(rate: u32) -> [u8; 10] {
    let mut out = [0; 10];
    if rate == 0 {
        return out;
    }
    let shift = u64::from(rate).leading_zeros();
    let exponent = 16383 + 63 - shift as u16;
    out[..2].copy_from_slice(&exponent.to_be_bytes());
    out[2..].copy_from_slice(&(u64::from(rate) << shift).to_be_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs ffmpeg, which makes the test FLACs and checks the result.
    fn ffmpeg(args: &[&str]) -> Option<Vec<u8>> {
        let out = std::process::Command::new("ffmpeg").args(["-v", "error", "-y"]).args(args).output().ok()?;
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        Some(out.stdout)
    }

    fn pcm(path: &Path) -> Vec<u8> {
        ffmpeg(&["-i", path.to_str().unwrap(), "-f", "s32le", "-"]).unwrap()
    }

    #[test]
    fn same_samples_and_tags() {
        let dir = tempfile::tempdir().unwrap();
        for (bits, rate, channels) in [("s16", "44100", "2"), ("s32", "96000", "2"), ("s32", "48000", "1")] {
            let flac = dir.path().join(format!("{bits}-{rate}-{channels}.flac"));
            let aiff = flac.with_extension("aiff");
            let made = ffmpeg(&[
                "-f", "lavfi", "-i", "sine=frequency=997:duration=1.37",
                "-af", "volume=0.9", "-ar", rate, "-ac", channels, "-sample_fmt", bits,
                "-c:a", "flac", flac.to_str().unwrap(),
            ]);
            if made.is_none() {
                eprintln!("ffmpeg is missing; skipped");
                return;
            }
            let meta = tags::Meta {
                title: "Song".into(),
                artists: vec!["Artist".into()],
                isrc: Some("GBDUW0000059".into()),
                cover: Some(std::fs::read(env!("CARGO_MANIFEST_DIR").to_owned() + "/../../apple/Deckhand/Assets.xcassets/AppIcon.appiconset/icon.png").unwrap()),
                ..tags::Meta::default()
            };
            tags::write(&flac, &meta).unwrap();

            convert(&flac, &aiff).unwrap();

            assert_eq!(pcm(&aiff), pcm(&flac), "{bits} {rate} {channels}");
            let probe = tags::probe(&aiff).unwrap();
            assert_eq!(probe.file_type, lofty::file::FileType::Aiff);
            assert_eq!(probe.quality(), tags::probe(&flac).unwrap().quality().replace("FLAC", "AIFF"));
            assert_eq!(tags::isrc(&aiff).as_deref(), Some("GBDUW0000059"));
            assert_eq!(tags::named(&aiff).unwrap().title, "Song");
            use lofty::file::TaggedFileExt;
            let file = lofty::read_from_path(&aiff).unwrap();
            assert_eq!(file.primary_tag().unwrap().pictures().len(), 1, "the cover");
        }
    }

    #[test]
    fn sample_rates() {
        assert_eq!(extended(44_100), [0x40, 0x0E, 0xAC, 0x44, 0, 0, 0, 0, 0, 0]);
        assert_eq!(extended(48_000), [0x40, 0x0E, 0xBB, 0x80, 0, 0, 0, 0, 0, 0]);
        assert_eq!(extended(96_000), [0x40, 0x0F, 0xBB, 0x80, 0, 0, 0, 0, 0, 0]);
    }
}
