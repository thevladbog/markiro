//! `device.json` in the app's config directory (spec §5.2): the host this
//! device is paired with and its protected key. Written atomically: a crash
//! leaves either the old file or the new one, never a torn file.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use markiro_proto::DeviceKind;
use serde::{Deserialize, Serialize};

use crate::secret_store::ProtectedSecret;

pub const FILE_NAME: &str = "device.json";
const TEMPORARY_NAME: &str = ".device.json.tmp";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceConfig {
    /// `https://<host>:<port>` of the paired host.
    pub host_address: String,
    /// Lower-case hex SHA-256 of the host certificate, pinned at pairing.
    pub fingerprint: String,
    pub host_id: String,
    pub device_id: String,
    pub kind: DeviceKind,
    pub line_id: Option<String>,
    pub device_key: ProtectedSecret,
}

#[derive(Debug, thiserror::Error)]
pub enum DeviceConfigError {
    #[error("device config {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("device config {path} is unreadable: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

pub fn path(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// `Ok(None)` when this device is not paired yet.
pub fn load(dir: &Path) -> Result<Option<DeviceConfig>, DeviceConfigError> {
    let path = path(dir);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(DeviceConfigError::Io { path, source }),
    };
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|source| DeviceConfigError::Parse { path, source })
}

pub fn save(dir: &Path, config: &DeviceConfig) -> Result<(), DeviceConfigError> {
    let io = |path: &Path| {
        let path = path.to_path_buf();
        move |source| DeviceConfigError::Io { path, source }
    };
    fs::create_dir_all(dir).map_err(io(dir))?;
    let target = path(dir);
    let temporary = dir.join(TEMPORARY_NAME);
    // A leftover from a crash may have other permissions; start clean.
    let _ = fs::remove_file(&temporary);
    let data = serde_json::to_vec_pretty(config).expect("DeviceConfig serializes");
    if let Err(source) = write_owner_only(&temporary, &data) {
        let _ = fs::remove_file(&temporary);
        return Err(DeviceConfigError::Io {
            path: temporary,
            source,
        });
    }
    if let Err(source) = fs::rename(&temporary, &target) {
        let _ = fs::remove_file(&temporary);
        return Err(DeviceConfigError::Io {
            path: target,
            source,
        });
    }
    sync_dir(dir).map_err(io(dir))
}

/// Remove `device.json` and, on Unix, the plaintext key a leftover temporary
/// file may still hold. Tolerates either file already being absent.
pub fn clear(dir: &Path) -> Result<(), DeviceConfigError> {
    let target = path(dir);
    let mut removed_any = false;
    match fs::remove_file(&target) {
        Ok(()) => removed_any = true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(source) => {
            return Err(DeviceConfigError::Io {
                path: target,
                source,
            })
        }
    }
    let temporary = dir.join(TEMPORARY_NAME);
    match fs::remove_file(&temporary) {
        Ok(()) => removed_any = true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(source) => {
            return Err(DeviceConfigError::Io {
                path: temporary,
                source,
            })
        }
    }
    if removed_any {
        sync_dir(dir).map_err(|source| DeviceConfigError::Io {
            path: dir.to_path_buf(),
            source,
        })
    } else {
        Ok(())
    }
}

fn write_owner_only(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(data)?;
    file.sync_all()
}

/// Make the rename durable (Unix); Windows commits the rename itself.
#[cfg(unix)]
fn sync_dir(dir: &Path) -> std::io::Result<()> {
    fs::File::open(dir)?.sync_all()
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret_store::Scheme;

    fn sample() -> DeviceConfig {
        DeviceConfig {
            host_address: "https://127.0.0.1:45710".into(),
            fingerprint: "ab".repeat(32),
            host_id: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f".into(),
            device_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7".into(),
            kind: DeviceKind::Station,
            line_id: None,
            device_key: ProtectedSecret {
                scheme: Scheme::Plain,
                value: "device-key-value".into(),
            },
        }
    }

    #[test]
    fn a_missing_file_means_not_paired() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()).unwrap(), None);
    }

    #[test]
    fn saves_atomically_and_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), &sample()).unwrap();
        let mut changed = sample();
        changed.line_id = Some("2b2d7ab8-2e1c-4a7e-9d2b-7b9b1f3c4d5e".into());
        save(dir.path(), &changed).unwrap();
        assert_eq!(load(dir.path()).unwrap(), Some(changed));
        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(
            names,
            vec![FILE_NAME.to_owned()],
            "no temporary file is left behind"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), &sample()).unwrap();
        let mode = fs::metadata(path(dir.path())).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn a_stale_temporary_file_does_not_block_saving() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(TEMPORARY_NAME), "left by a crash").unwrap();
        save(dir.path(), &sample()).unwrap();
        assert_eq!(load(dir.path()).unwrap(), Some(sample()));
        assert!(!dir.path().join(TEMPORARY_NAME).exists());
    }

    #[test]
    fn a_corrupt_file_is_reported_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(path(dir.path()), "{ not json").unwrap();
        assert!(matches!(
            load(dir.path()),
            Err(DeviceConfigError::Parse { .. })
        ));
        assert_eq!(fs::read_to_string(path(dir.path())).unwrap(), "{ not json");
    }

    #[test]
    fn clear_removes_the_file_and_tolerates_absence() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), &sample()).unwrap();
        clear(dir.path()).unwrap();
        assert_eq!(load(dir.path()).unwrap(), None);
        clear(dir.path()).unwrap();
    }

    #[test]
    fn clear_removes_a_stray_temporary_file_too() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), &sample()).unwrap();
        fs::write(dir.path().join(TEMPORARY_NAME), "leftover key material").unwrap();
        clear(dir.path()).unwrap();
        assert_eq!(load(dir.path()).unwrap(), None);
        assert!(!dir.path().join(TEMPORARY_NAME).exists());
    }
}
