//! Content-addressed files: analysis and artwork, named by their BLAKE3.
//! Immutable, so the phone caches them forever.

use std::io::Write;
use std::path::PathBuf;

use anyhow::Result;

#[derive(Clone)]
pub struct Blobs {
    root: PathBuf,
}

impl Blobs {
    pub fn new(root: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    /// Stores the bytes and returns their hash.
    pub fn put(&self, bytes: &[u8]) -> Result<String> {
        let hash = blake3::hash(bytes).to_hex().to_string();
        let path = self.path(&hash).ok_or_else(|| anyhow::anyhow!("bad hash"))?;
        if path.is_file() {
            return Ok(hash);
        }
        let dir = path.parent().unwrap_or(&self.root);
        std::fs::create_dir_all(dir)?;
        let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
        tmp.write_all(bytes)?;
        tmp.as_file().sync_all()?;
        tmp.persist(&path)?;
        Ok(hash)
    }

    /// Where a blob lives, if the hash is well-formed.
    pub fn path(&self, hash: &str) -> Option<PathBuf> {
        let valid = hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase());
        valid.then(|| self.root.join(&hash[..2]).join(hash))
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_by_hash_and_rejects_bad_names() {
        let dir = tempfile::tempdir().unwrap();
        let blobs = Blobs::new(dir.path().join("b")).unwrap();
        let hash = blobs.put(b"hello").unwrap();
        assert_eq!(std::fs::read(blobs.path(&hash).unwrap()).unwrap(), b"hello");
        assert_eq!(blobs.put(b"hello").unwrap(), hash);
        assert!(blobs.path("../etc/passwd").is_none());
        assert!(blobs.path(&"A".repeat(64)).is_none());
    }
}
