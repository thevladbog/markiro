use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::config;

pub(crate) const RECORD_FILE: &str = "station-storage.json";
/// Record writes go through `.station-storage-<uuid>.tmp`.
pub(crate) const TEMP_PREFIX: &str = ".station-storage-";
const RECORD_VERSION: u32 = 1;

/// Progress of the move. It lives in the machine-local folder, so neither a
/// roaming download nor another computer can change what this machine
/// believes about it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum StorageRecord {
    /// The roaming folder is being renamed to `claim_dir`. Until the commit,
    /// `claim_dir` (or `legacy_dir` if the rename never happened) is
    /// authoritative.
    Claiming {
        legacy_dir: PathBuf,
        claim_dir: PathBuf,
    },
    /// The machine-local folder is authoritative. `pending_cleanup` names a
    /// claimed folder that still has to be removed.
    Committed {
        origin: Origin,
        pending_cleanup: Option<PathBuf>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Origin {
    Fresh,
    Adopted,
    Migrated,
}

#[derive(Serialize, Deserialize)]
struct RecordFile {
    version: u32,
    record: StorageRecord,
}

/// The errors name the record file: support reads them on the station.
pub(crate) fn read(local_dir: &Path) -> Result<Option<StorageRecord>, String> {
    let path = local_dir.join(RECORD_FILE);
    let data = match fs::read(&path) {
        Ok(data) => data,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "the station storage record {} is unreadable: {error}",
                path.display()
            ))
        }
    };
    let file: RecordFile = serde_json::from_slice(&data).map_err(|error| {
        format!(
            "the station storage record {} is damaged: {error}",
            path.display()
        )
    })?;
    if file.version != RECORD_VERSION {
        return Err(format!(
            "the station storage record {} has version {}, which this station version does not support",
            path.display(),
            file.version
        ));
    }
    Ok(Some(file.record))
}

/// Atomic replace with the same primitives as `station.json`.
pub(crate) fn write(local_dir: &Path, record: &StorageRecord) -> Result<(), String> {
    fs::create_dir_all(local_dir).map_err(|error| error.to_string())?;
    let data = serde_json::to_vec_pretty(&RecordFile {
        version: RECORD_VERSION,
        record: record.clone(),
    })
    .map_err(|error| error.to_string())?;
    let temporary = local_dir.join(format!("{TEMP_PREFIX}{}.tmp", Uuid::new_v4()));
    if let Err(error) = config::write_owner_only(&temporary, &data) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    if let Err(error) = config::replace_config_file(&temporary, &local_dir.join(RECORD_FILE)) {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    config::sync_parent_directory(local_dir)
}

pub(crate) fn remove(local_dir: &Path) -> Result<(), String> {
    match fs::remove_file(local_dir.join(RECORD_FILE)) {
        Ok(()) => config::sync_parent_directory(local_dir),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("markiro-storage-record-{}", Uuid::new_v4()))
    }

    #[test]
    fn a_missing_record_is_none_and_a_written_one_round_trips() {
        let dir = temp_dir();
        assert_eq!(read(&dir).unwrap(), None);
        let claiming = StorageRecord::Claiming {
            legacy_dir: PathBuf::from("/roaming/app.markiro.station"),
            claim_dir: PathBuf::from("/roaming/app.markiro.station.migrating-1"),
        };
        write(&dir, &claiming).unwrap();
        assert_eq!(read(&dir).unwrap(), Some(claiming));
    }

    /// On Windows the second write goes through `ReplaceFileW`.
    #[test]
    fn a_second_write_replaces_the_first_without_leftovers() {
        let dir = temp_dir();
        write(
            &dir,
            &StorageRecord::Committed {
                origin: Origin::Migrated,
                pending_cleanup: Some(PathBuf::from("/roaming/claimed")),
            },
        )
        .unwrap();
        let done = StorageRecord::Committed {
            origin: Origin::Migrated,
            pending_cleanup: None,
        };
        write(&dir, &done).unwrap();
        assert_eq!(read(&dir).unwrap(), Some(done));
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from(RECORD_FILE)]);
    }

    /// Support reads these errors on the station: they name the record file.
    #[test]
    fn garbage_or_an_unknown_version_is_an_error() {
        let dir = temp_dir();
        let path = dir.join(RECORD_FILE).display().to_string();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(RECORD_FILE), b"{not json").unwrap();
        assert!(read(&dir).unwrap_err().contains(&path));
        fs::write(
            dir.join(RECORD_FILE),
            br#"{"version":2,"record":{"state":"committed","origin":"fresh","pending_cleanup":null}}"#,
        )
        .unwrap();
        let error = read(&dir).unwrap_err();
        assert!(
            error.contains(&path) && error.contains("version 2"),
            "{error}"
        );
    }

    #[test]
    fn removing_a_missing_record_succeeds() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        remove(&dir).unwrap();
        write(
            &dir,
            &StorageRecord::Committed {
                origin: Origin::Fresh,
                pending_cleanup: None,
            },
        )
        .unwrap();
        remove(&dir).unwrap();
        assert_eq!(read(&dir).unwrap(), None);
    }
}
