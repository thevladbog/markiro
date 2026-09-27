//! Where the station keeps `station.json` and `station-mirror.db`.
//!
//! Tauri's `app_config_dir()` is the roaming AppData folder on Windows, so a
//! roaming profile or AppData folder redirection carried the station identity
//! and its offline journal to other computers. The files now live in
//! `app_local_data_dir()` (`%LOCALAPPDATA%`), and [`resolve`] moves an existing
//! installation there exactly once. Design:
//! docs/superpowers/specs/2026-09-27-station-local-storage-design.md.

mod copy;
mod gate;
mod probe;
mod record;
mod resolve;

use std::path::{Path, PathBuf};

use serde::Serialize;

pub use gate::{storage_gate, StorageGate};
pub use probe::{profile_facts, LessDurableReason};
pub use resolve::resolve;

pub(crate) const CONFIG_FILE: &str = "station.json";
pub(crate) const DATABASE_FILE: &str = "station-mirror.db";
/// A claimed roaming folder is named `<legacy name>.migrating-<uuid>`.
pub(crate) const CLAIM_MARKER: &str = ".migrating-";

/// Where this process reads and writes the station files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StationStorage {
    pub dir: PathBuf,
    pub mode: StorageMode,
    pub notices: Vec<StorageNotice>,
}

/// `Local`: the machine-local folder is authoritative. `Legacy`: today's
/// behaviour in the roaming folder, or in a claimed copy of it, because moving
/// was unsafe or failed this time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageMode {
    Local,
    Legacy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum StorageNotice {
    /// Another process, in practice another computer over SMB, holds the
    /// station files, so the move was postponed.
    LegacyInUse,
    /// The move failed for another reason; the next start retries it.
    MoveFailed,
    /// `%LOCALAPPDATA%` would not survive sign-out on this Windows profile.
    LocalLessDurable { reason: LessDurableReason },
    /// Station files appeared in the roaming folder after the move.
    RoamedCopyPresent { same_machine_id: bool },
    /// The claimed roaming folder could not be removed completely.
    ClaimLeftovers,
}

impl StationStorage {
    pub fn database_path(&self) -> PathBuf {
        self.dir.join(DATABASE_FILE)
    }

    /// Legacy mode from a claimed folder: the move is under way, and the
    /// folder is only authoritative while it holds the station files.
    pub fn runs_from_claim(&self) -> bool {
        self.mode == StorageMode::Legacy
            && self
                .dir
                .file_name()
                .is_some_and(|name| name.to_string_lossy().contains(CLAIM_MARKER))
    }
}

/// `sqlite:` URL for tauri-plugin-sql. The plugin keeps an absolute path as it
/// is (`PathBuf::push` replaces its base), and sqlx percent-decodes the file
/// name, so `%`, `?` and `#` are encoded.
pub fn database_url(path: &Path) -> String {
    let mut url = String::from("sqlite:");
    for character in path.to_string_lossy().chars() {
        match character {
            '%' => url.push_str("%25"),
            '?' => url.push_str("%3F"),
            '#' => url.push_str("%23"),
            other => url.push(other),
        }
    }
    url
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use sqlx::sqlite::SqliteConnectOptions;

    use super::*;

    #[test]
    fn database_url_round_trips_through_sqlx() {
        for path in [
            "/tmp/Markiro Station/station-mirror.db",
            "/tmp/Оператор/станция/station-mirror.db",
            "/tmp/100%/station-mirror.db",
            "/tmp/line#2/station-mirror.db",
            "/tmp/what?/station-mirror.db",
            r"C:\Users\Оператор 1\AppData\Local\app.markiro.station\station-mirror.db",
        ] {
            let options = SqliteConnectOptions::from_str(&database_url(Path::new(path)))
                .expect("the URL parses");
            assert_eq!(options.get_filename(), Path::new(path), "{path}");
        }
    }

    #[test]
    fn notices_serialize_for_the_webview() {
        let storage = StationStorage {
            dir: PathBuf::from("/tmp/local"),
            mode: StorageMode::Legacy,
            notices: vec![
                StorageNotice::LegacyInUse,
                StorageNotice::LocalLessDurable {
                    reason: LessDurableReason::DeleteRoamingCache,
                },
                StorageNotice::RoamedCopyPresent {
                    same_machine_id: true,
                },
            ],
        };
        assert_eq!(
            serde_json::to_value(&storage).unwrap(),
            serde_json::json!({
                "dir": "/tmp/local",
                "mode": "legacy",
                "notices": [
                    { "kind": "legacy_in_use" },
                    { "kind": "local_less_durable", "reason": "delete_roaming_cache" },
                    { "kind": "roamed_copy_present", "sameMachineId": true }
                ]
            })
        );
    }
}
