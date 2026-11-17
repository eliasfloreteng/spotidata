//! Tags the analyser does not read: the ISRC a file holds, and the tags a
//! downloaded file gets before it joins the folder.

use std::path::Path;

use anyhow::{Context, Result};
use lofty::config::WriteOptions;
use lofty::file::FileType;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::*;
use lofty::tag::Tag;

/// Opens an audio file by its content, not its name: downloads are staged
/// under a neutral one.
fn read(path: &Path) -> Result<lofty::file::TaggedFile> {
    Ok(lofty::probe::Probe::open(path)?.guess_file_type()?.read()?)
}

/// The recording a file holds, upper-cased; `None` when it has no ISRC.
pub fn isrc(path: &Path) -> Option<String> {
    let file = read(path).ok()?;
    file.tags()
        .iter()
        .find_map(|t| t.get_string(ItemKey::Isrc))
        .map(|s| s.trim().to_ascii_uppercase())
        .filter(|s| !s.is_empty())
}

/// What a file's own tags call it; empty where it says nothing.
#[derive(Debug, Clone, Default)]
pub struct Named {
    pub title: String,
    pub artist: String,
    pub album: String,
}

pub fn named(path: &Path) -> Result<Named> {
    let file = read(path)?;
    let Some(tag) = file.primary_tag().or_else(|| file.first_tag()) else { return Ok(Named::default()) };
    let text = |s: Option<std::borrow::Cow<'_, str>>| s.map(|s| s.trim().to_owned()).unwrap_or_default();
    Ok(Named { title: text(tag.title()), artist: text(tag.artist()), album: text(tag.album()) })
}

/// What a downloaded file turned out to be.
#[derive(Debug, Clone, Copy)]
pub struct Probe {
    pub file_type: FileType,
    pub duration_sec: f64,
    pub bit_depth: Option<u8>,
    pub sample_rate: Option<u32>,
}

impl Probe {
    pub fn is_lossless(&self) -> bool {
        matches!(self.file_type, FileType::Flac | FileType::Aiff | FileType::Wav)
    }

    /// "FLAC 16-bit 44.1 kHz".
    pub fn quality(&self) -> String {
        let format = match self.file_type {
            FileType::Flac => "FLAC",
            FileType::Aiff => "AIFF",
            FileType::Wav => "WAV",
            FileType::Mp4 => "M4A",
            FileType::Mpeg => "MP3",
            _ => "Audio",
        };
        let mut parts = vec![format.to_owned()];
        if let Some(bits) = self.bit_depth {
            parts.push(format!("{bits}-bit"));
        }
        if let Some(rate) = self.sample_rate {
            let khz = f64::from(rate) / 1000.0;
            parts.push(if khz.fract() == 0.0 { format!("{khz:.0} kHz") } else { format!("{khz:.1} kHz") });
        }
        parts.join(" ")
    }
}

pub fn probe(path: &Path) -> Result<Probe> {
    let file = read(path).context("not an audio file")?;
    let props = file.properties();
    Ok(Probe {
        file_type: file.file_type(),
        duration_sec: props.duration().as_secs_f64(),
        bit_depth: props.bit_depth(),
        sample_rate: props.sample_rate(),
    })
}

/// The tags a downloaded track is filed under.
#[derive(Debug, Clone, Default)]
pub struct Meta {
    pub title: String,
    pub artists: Vec<String>,
    pub album: String,
    pub album_artist: String,
    pub isrc: Option<String>,
    pub date: String,
    pub track_number: Option<u32>,
    pub disc_number: Option<u32>,
    pub genre: String,
    pub label: String,
    /// JPEG or PNG.
    pub cover: Option<Vec<u8>>,
}

/// Replaces whatever tags the source wrote with `meta`.
pub fn write(path: &Path, meta: &Meta) -> Result<()> {
    let mut file = read(path).context("reading the downloaded file")?;
    let mut tag = Tag::new(file.primary_tag_type());
    let mut text = |key: ItemKey, value: &str| {
        if !value.trim().is_empty() {
            tag.insert_text(key, value.trim().to_owned());
        }
    };
    text(ItemKey::TrackTitle, &meta.title);
    text(ItemKey::TrackArtist, &meta.artists.join(", "));
    text(ItemKey::AlbumTitle, &meta.album);
    text(ItemKey::AlbumArtist, &meta.album_artist);
    text(ItemKey::Isrc, meta.isrc.as_deref().unwrap_or_default());
    text(ItemKey::RecordingDate, &meta.date);
    text(ItemKey::Genre, &meta.genre);
    text(ItemKey::Label, &meta.label);
    if let Some(n) = meta.track_number {
        text(ItemKey::TrackNumber, &n.to_string());
    }
    if let Some(n) = meta.disc_number {
        text(ItemKey::DiscNumber, &n.to_string());
    }
    if let Some(cover) = &meta.cover {
        let mime = if cover.starts_with(&[0x89, b'P', b'N', b'G']) { MimeType::Png } else { MimeType::Jpeg };
        tag.push_picture(Picture::unchecked(cover.clone()).pic_type(PictureType::CoverFront).mime_type(mime).build());
    }
    file.clear();
    file.insert_tag(tag);
    file.save_to_path(path, WriteOptions::default()).context("writing tags")?;
    Ok(())
}
