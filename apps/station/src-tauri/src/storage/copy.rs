use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Debug)]
pub(crate) enum CopyError {
    /// Another process holds a file open (a Windows sharing violation).
    InUse,
    Failed(String),
}

impl From<io::Error> for CopyError {
    fn from(error: io::Error) -> Self {
        CopyError::Failed(error.to_string())
    }
}

/// The files that make up a station store: every top-level regular file
/// except interrupted config writes (`*.tmp`) and SQLite shared memory
/// (`-shm`, rebuilt on open). The database's `-journal` is included: an exact
/// copy lets SQLite roll back a hot journal where it lands.
pub(crate) fn store_files(dir: &Path) -> io::Result<Vec<OsString>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_file() && !is_transient(&entry.file_name()) {
            names.push(entry.file_name());
        }
    }
    names.sort();
    Ok(names)
}

fn is_transient(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    name.ends_with(".tmp") || name.ends_with("-shm")
}

/// Source files opened without sharing. Nobody can write them while they are
/// copied and compared, and a handle open elsewhere (another computer over
/// SMB) makes the open fail instead of producing a torn copy.
pub(crate) struct HeldFiles {
    files: Vec<(OsString, File)>,
}

pub(crate) fn hold(dir: &Path, names: &[OsString]) -> Result<HeldFiles, CopyError> {
    let mut files = Vec::with_capacity(names.len());
    for name in names {
        files.push((name.clone(), open_exclusive(&dir.join(name))?));
    }
    Ok(HeldFiles { files })
}

#[cfg(windows)]
fn open_exclusive(path: &Path) -> Result<File, CopyError> {
    use std::os::windows::fs::OpenOptionsExt;
    const ERROR_SHARING_VIOLATION: i32 = 32;
    fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(path)
        .map_err(|error| {
            if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION) {
                CopyError::InUse
            } else {
                CopyError::Failed(error.to_string())
            }
        })
}

#[cfg(not(windows))]
fn open_exclusive(path: &Path) -> Result<File, CopyError> {
    File::open(path).map_err(CopyError::from)
}

impl HeldFiles {
    pub(crate) fn copy_to(&mut self, staging: &Path) -> Result<(), CopyError> {
        fs::create_dir_all(staging)?;
        for (name, source) in &mut self.files {
            source.seek(SeekFrom::Start(0))?;
            let mut target = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(staging.join(&*name))?;
            io::copy(source, &mut target)?;
            target.sync_all()?;
        }
        Ok(())
    }

    pub(crate) fn verify(&mut self, staging: &Path) -> Result<(), CopyError> {
        for (name, source) in &mut self.files {
            source.seek(SeekFrom::Start(0))?;
            let mut copy = File::open(staging.join(&*name))?;
            if !same_bytes(source, &mut copy)? {
                return Err(CopyError::Failed(format!(
                    "the copy of {} differs from its source",
                    name.to_string_lossy()
                )));
            }
        }
        Ok(())
    }
}

fn same_bytes(left: &mut impl Read, right: &mut impl Read) -> io::Result<bool> {
    let mut left_buffer = vec![0u8; 64 * 1024];
    let mut right_buffer = vec![0u8; 64 * 1024];
    loop {
        let left_read = read_full(left, &mut left_buffer)?;
        let right_read = read_full(right, &mut right_buffer)?;
        if left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
    }
}

/// `read` may return fewer bytes than asked before the end, so fill the
/// buffer: both sides are then compared in the same chunks.
fn read_full(reader: &mut impl Read, buffer: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..])? {
            0 => break,
            read => filled += read,
        }
    }
    Ok(filled)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use uuid::Uuid;

    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("markiro-storage-copy-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn store_files_keep_the_journal_and_backups_but_not_transients_or_folders() {
        let dir = temp_dir();
        for name in [
            "station.json",
            "station-mirror.db",
            "station-mirror.db-journal",
            "station-mirror.db-shm",
            ".station-1.bak",
            ".station-2.tmp",
        ] {
            fs::write(dir.join(name), name).unwrap();
        }
        fs::create_dir(dir.join("EBWebView")).unwrap();
        assert_eq!(
            store_files(&dir).unwrap(),
            vec![
                OsString::from(".station-1.bak"),
                OsString::from("station-mirror.db"),
                OsString::from("station-mirror.db-journal"),
                OsString::from("station.json"),
            ]
        );
    }

    #[test]
    fn copies_verify_byte_for_byte_and_a_changed_copy_is_caught() {
        let source = temp_dir();
        let large: Vec<u8> = (0..200_000u32).map(|value| (value % 251) as u8).collect();
        fs::write(source.join("station-mirror.db"), &large).unwrap();
        fs::write(source.join("station.json"), b"{}").unwrap();
        let names = store_files(&source).unwrap();

        let staging = temp_dir().join("staging");
        let mut held = hold(&source, &names).unwrap();
        held.copy_to(&staging).unwrap();
        held.verify(&staging).unwrap();
        assert_eq!(fs::read(staging.join("station-mirror.db")).unwrap(), large);

        let mut flipped = large.clone();
        flipped[150_000] ^= 1;
        fs::write(staging.join("station-mirror.db"), flipped).unwrap();
        assert!(matches!(held.verify(&staging), Err(CopyError::Failed(_))));
    }

    /// SQLite opens files with read/write sharing but no exclusive access.
    #[cfg(windows)]
    #[test]
    fn a_file_open_elsewhere_cannot_be_held() {
        let dir = temp_dir();
        fs::write(dir.join("station-mirror.db"), b"db").unwrap();
        let _other = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(dir.join("station-mirror.db"))
            .unwrap();
        assert!(matches!(
            hold(&dir, &[OsString::from("station-mirror.db")]),
            Err(CopyError::InUse)
        ));
    }
}
