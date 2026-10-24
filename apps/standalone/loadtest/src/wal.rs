//! The wal-index header of SQLite (`host.db-shm`): how many frames of the
//! write-ahead log no checkpoint has copied into the database yet. The file
//! is read from outside the host without a lock, so a torn read (the two
//! copies of the header differ) answers `None` and the caller reads again.
//!
//! Layout (sqlite `wal.c`, native byte order): `WalIndexHdr` is 48 bytes
//! written twice back to back (`iVersion`, unused, `iChange`, `isInit`,
//! `bigEndCksum`, `szPage`, `mxFrame` at 16, `nPage`, checksums and salts);
//! `WalCkptInfo` follows at 96 and starts with `nBackfill`.

pub const MIN_LEN: usize = 100;

fn word(bytes: &[u8], at: usize) -> u32 {
    u32::from_ne_bytes(bytes[at..at + 4].try_into().expect("four bytes"))
}

/// `mxFrame - nBackfill`, or `None` for a file too short, not initialised or
/// read in the middle of a write.
pub fn backlog(shm: &[u8]) -> Option<u64> {
    if shm.len() < MIN_LEN || shm[12] == 0 {
        return None;
    }
    if shm[..48] != shm[48..96] {
        return None;
    }
    let frames = word(shm, 16);
    let copied = word(shm, 96);
    Some(u64::from(frames.saturating_sub(copied)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(frames: u32, copied: u32) -> Vec<u8> {
        let mut bytes = vec![0u8; 136];
        bytes[12] = 1;
        bytes[16..20].copy_from_slice(&frames.to_ne_bytes());
        let copy: Vec<u8> = bytes[..48].to_vec();
        bytes[48..96].copy_from_slice(&copy);
        bytes[96..100].copy_from_slice(&copied.to_ne_bytes());
        bytes
    }

    #[test]
    fn the_backlog_is_the_frames_no_checkpoint_has_copied() {
        assert_eq!(backlog(&header(1200, 1000)), Some(200));
        assert_eq!(backlog(&header(0, 0)), Some(0));
        // A checkpoint that read the header after the log restarted.
        assert_eq!(backlog(&header(10, 50)), Some(0));
    }

    #[test]
    fn a_torn_a_short_or_an_unset_header_is_not_a_number() {
        let mut torn = header(1200, 1000);
        torn[16] ^= 0xFF;
        assert_eq!(backlog(&torn), None);
        assert_eq!(backlog(&[0u8; 50]), None);
        let mut fresh = header(5, 0);
        fresh[12] = 0;
        let copy: Vec<u8> = fresh[..48].to_vec();
        fresh[48..96].copy_from_slice(&copy);
        assert_eq!(backlog(&fresh), None);
    }
}
