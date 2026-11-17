//! Undoes the encryption some sources pass through from the service.

use std::path::Path;

use anyhow::{Context, Result};
use cbc::cipher::block_padding::NoPadding;
use cbc::cipher::{BlockModeDecrypt, KeyIvInit};
#[cfg(test)]
use md5::{Digest, Md5};

use super::sources::Decrypt;

pub async fn decrypt(path: &Path, cipher: &Decrypt) -> Result<()> {
    match cipher {
        Decrypt::DeezerBlowfish { key } => {
            let (path, key) = (path.to_owned(), key.clone());
            tokio::task::spawn_blocking(move || {
                let mut data = std::fs::read(&path)?;
                deezer(&mut data, &key)?;
                std::fs::write(&path, data).context("writing the decrypted file")
            })
            .await?
        }
        Decrypt::Cenc { key_hex } => cenc(path, key_hex).await,
    }
}

/// Whether ffmpeg is installed; the Amazon source depends on it.
pub fn have_ffmpeg() -> bool {
    std::process::Command::new("ffmpeg")
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// Decrypts a CENC MP4 and copies its FLAC out, without re-encoding.
async fn cenc(path: &Path, key_hex: &str) -> Result<()> {
    if key_hex.len() != 32 || !key_hex.chars().all(|c| c.is_ascii_hexdigit()) {
        anyhow::bail!("the key is not a 128-bit hex key");
    }
    to_flac(path, &["-decryption_key", key_hex]).await
}

/// Copies FLAC out of an MP4 wrapper; fails for any other codec.
pub async fn unwrap_mp4(path: &Path) -> Result<()> {
    to_flac(path, &[]).await
}

async fn to_flac(path: &Path, input_options: &[&str]) -> Result<()> {
    let out = path.with_extension("flac");
    let output = tokio::process::Command::new("ffmpeg")
        .args(["-nostdin", "-v", "error", "-y"])
        .args(input_options)
        .arg("-i")
        .arg(path)
        .args(["-map", "0:a:0", "-c:a", "copy", "-f", "flac"])
        .arg(&out)
        .output()
        .await
        .context("running ffmpeg")?;
    if !output.status.success() {
        let _ = tokio::fs::remove_file(&out).await;
        anyhow::bail!("could not unpack it: {}", String::from_utf8_lossy(&output.stderr).trim());
    }
    tokio::fs::rename(&out, path).await.context("replacing the encrypted file")
}

/// Deriving Deezer's key from a track id, for sources that do not send it.
#[cfg(test)]
fn deezer_key(track_id: &str) -> Vec<u8> {
    const SECRET: &[u8; 16] = b"g4el58wc0zvf9na1";
    let hash = hex(&Md5::digest(track_id.as_bytes()));
    let hash = hash.as_bytes();
    (0..16).map(|i| hash[i] ^ hash[i + 16] ^ SECRET[i]).collect()
}

/// Deezer's stripes: of each run of three 2048-byte chunks the first is
/// Blowfish-CBC with a fixed IV.
fn deezer(data: &mut [u8], key: &[u8]) -> Result<()> {
    const IV: [u8; 8] = [0, 1, 2, 3, 4, 5, 6, 7];
    for (i, chunk) in data.chunks_mut(2048).enumerate() {
        if i % 3 == 0 && chunk.len() == 2048 {
            cbc::Decryptor::<blowfish::Blowfish>::new_from_slices(key, &IV)
                .map_err(|_| anyhow::anyhow!("bad key"))?
                .decrypt_padded::<NoPadding>(chunk)
                .map_err(|_| anyhow::anyhow!("could not decrypt"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cbc::cipher::BlockModeEncrypt;

    #[test]
    fn deezer_stripes_round_trip() {
        let original: Vec<u8> = (0..7000u32).map(|i| (i * 31 % 251) as u8).collect();
        let mut data = original.clone();
        // Encrypt the way the service does, then undo it.
        let key = deezer_key("3135556");
        for (i, chunk) in data.chunks_mut(2048).enumerate() {
            if i % 3 == 0 && chunk.len() == 2048 {
                let len = chunk.len();
                cbc::Encryptor::<blowfish::Blowfish>::new_from_slices(&key, &[0, 1, 2, 3, 4, 5, 6, 7])
                    .unwrap()
                    .encrypt_padded::<NoPadding>(chunk, len)
                    .unwrap();
            }
        }
        assert_ne!(data, original);
        deezer(&mut data, &key).unwrap();
        assert_eq!(data, original);
    }
}
