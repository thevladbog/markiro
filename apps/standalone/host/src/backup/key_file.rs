//! The file that receives the host's private key beside a copy (plan I1).
//! It is created exclusively and held open while the guard closes it, and
//! the key goes through that same handle: nothing reopens it by its name.
//! On Unix it is born `0600`. On Windows it is opened without sharing
//! (`share_mode(0)`): while the host holds it nobody else can open it for
//! reading or writing, delete it or rename it. icacls changes its DACL
//! through `READ_CONTROL | WRITE_DAC`, which sharing does not govern.
//! `std` only, so a probe crate can type-check the Windows part on any
//! system.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;

/// Create `path` exclusively, never through a link left under its name:
/// owner-only on Unix, unshared on Windows.
pub fn create(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    options.open(path)
}

/// Whether `path` still names the file `file` is open on. Unix: the same
/// device and inode, read without following a link (a link has its own),
/// so neither a link nor another file put in its place passes. Elsewhere
/// always: the unshared handle of [`create`] forbids renaming or deleting
/// the file while it is open.
pub fn still_named(file: &File, path: &Path) -> io::Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let open = file.metadata()?;
        let named = std::fs::symlink_metadata(path)?;
        Ok(open.dev() == named.dev() && open.ino() == named.ino())
    }
    #[cfg(not(unix))]
    {
        let _ = (file, path);
        Ok(true)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::io::Write as _;

    use super::*;

    #[test]
    fn a_name_moved_away_or_replaced_no_longer_names_the_open_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("key.identity.partial");
        let file = create(&path).unwrap();
        assert!(still_named(&file, &path).unwrap());
        assert!(create(&path).is_err(), "never created twice");
        // Moved away, another file put in its place.
        std::fs::rename(&path, dir.path().join("aside")).unwrap();
        assert!(still_named(&file, &path).is_err(), "nothing under the name");
        std::fs::write(&path, b"planted").unwrap();
        assert!(!still_named(&file, &path).unwrap());
        // A link to the very file is no plain file of that name either.
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(dir.path().join("aside"), &path).unwrap();
        assert!(!still_named(&file, &path).unwrap());
    }

    #[test]
    fn the_file_is_born_owner_only_and_writable_through_its_handle() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("key.identity.partial");
        let mut file = create(&path).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        file.write_all(b"written").unwrap();
        drop(file);
        assert_eq!(std::fs::read(&path).unwrap(), b"written");
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use std::io::Write as _;
    use std::path::PathBuf;

    use super::*;

    /// ERROR_SHARING_VIOLATION.
    const SHARING_VIOLATION: i32 = 32;

    fn scratch(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!(
            "markiro-key-file-{}-{stamp}-{name}",
            std::process::id()
        ))
    }

    #[test]
    fn while_the_host_holds_the_key_file_nobody_else_can_open_move_or_delete_it() {
        let path = scratch("key.identity.partial");
        let moved = scratch("moved");
        let mut file = create(&path).unwrap();
        let read = File::open(&path).unwrap_err();
        assert_eq!(read.raw_os_error(), Some(SHARING_VIOLATION), "{read}");
        let write = OpenOptions::new().write(true).open(&path).unwrap_err();
        assert_eq!(write.raw_os_error(), Some(SHARING_VIOLATION), "{write}");
        assert!(std::fs::rename(&path, &moved).is_err());
        assert!(std::fs::remove_file(&path).is_err());
        assert!(still_named(&file, &path).unwrap());
        file.write_all(b"written").unwrap();
        file.sync_all().unwrap();
        drop(file);
        assert_eq!(std::fs::read(&path).unwrap(), b"written");
        std::fs::remove_file(&path).unwrap();
    }
}
