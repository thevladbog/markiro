# Station Storage Off the Roaming Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the cloud station's `station.json` and `station-mirror.db` from the roaming `%APPDATA%` folder to `%LOCALAPPDATA%` exactly once and crash-safely, and show where the data lives and why on the station itself.

**Architecture:** A Tauri-free `storage` module (`apps/station/src-tauri/src/storage/`) decides where the files live and performs the one-time move under a file lock. The move record lives in the non-roaming folder. The legacy folder is claimed by renaming it. Files are copied under exclusive handles, verified byte for byte, installed, committed, and the claim is cleaned up. `setup` runs the resolution on a background thread and publishes it through a `tokio::sync::watch` gate. Every storage-dependent command awaits that gate. The webview opens SQLite through a URL returned by Rust and shows storage notices on the Update screen.

**Tech Stack:** Rust (Tauri 2.11.5, sqlx 0.8.6, tokio 1.53.1, windows-sys 0.61), React 19 + TypeScript (Vitest, Testing Library, i18next), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-27-station-local-storage-design.md`. The owner accepted decisions D1–D4 on 2026-09-27. D5 is adjusted in Task 9; see "Deviations from the spec".

## Global Constraints

- **Paths.** Target folder: `app_local_data_dir()` (`%LOCALAPPDATA%\app.markiro.station` on Windows). Legacy folder: `app_config_dir()` (`%APPDATA%\app.markiro.station`).
- **File names.** `station.json` and `station-mirror.db` keep their names. New files in the target folder: `station-storage.json` (the move record) and `station-storage.lock`.
- **Pair, once.** The pair moves together, once. At every point exactly one location is authoritative and holds the complete pair byte for byte. Never mint a new identity while station files exist anywhere. Never load files from the roaming folder after the commit.
- **D2.** Temporary, mandatory, and roaming-with-`DeleteRoamingCache = 1` profiles keep the roaming folder and show a notice.
- **D3.** Station files that reappear in the roaming folder are reported. They are never loaded and never deleted.
- **D4 and spec §6.5.** Notices go to the stderr log and to the Update screen's "Station data" section. The pairing screen warns on temporary and mandatory profiles.
- **No other changes.** No cloud API change, no Postgres or SQLite schema change. No new crates and no new npm packages: only `windows-sys` features. Keep exact version pins.
- **Compile prerequisite.** The station crate compiles only after `apps/station/dist` exists (`tauri::generate_context!`). Build the webview first (Prerequisites).
- **Commits.**
  - Use a Conventional prefix and a Russian summary, following the repo style, and end each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Stage explicit paths only. Never use `git stash`.
- **TypeScript.** Strict mode with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. Every user-visible string goes into both `ru.json` and `en.json`; the key-parity test enforces this.

## Prerequisites (once per worktree)

- [ ] **Install and build the webview and its workspace dependencies**

```bash
pnpm install --frozen-lockfile
pnpm turbo build --filter '@markiro/station...'
```

Expected: `apps/station/dist/index.html` exists.

- [ ] **Record a green baseline**

```bash
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
pnpm --filter @markiro/station test
```

Expected: both pass. If either fails before any change, stop and report it. Do not fix unrelated failures.

## File Structure

Create:

| File                                             | Responsibility                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `apps/station/src-tauri/src/storage/mod.rs`      | Public types (`StationStorage`, `StorageMode`, `StorageNotice`), `database_url`, module wiring |
| `apps/station/src-tauri/src/storage/probe.rs`    | Windows profile facts and the durability guard                                                 |
| `apps/station/src-tauri/src/storage/record.rs`   | The move record in the local folder                                                            |
| `apps/station/src-tauri/src/storage/copy.rs`     | Store-file selection, exclusive-handle copy, byte verification                                 |
| `apps/station/src-tauri/src/storage/gate.rs`     | Watch-channel gate that commands await                                                         |
| `apps/station/src-tauri/src/storage/resolve.rs`  | The resolution state machine and the one-time move                                             |
| `apps/station/src/lib/storage-status.ts`         | Status type, tolerant reader, notice i18n keys and tones                                       |
| `apps/station/test/storage-status.test.ts`       | Reader and notice-mapping tests                                                                |
| `apps/station/test/sqlite-database-url.test.ts`  | `tauriExecutor` opens the resolved URL                                                         |
| `apps/station/test/app-storage-blocked.test.tsx` | A blocked storage stops on the recovery screen and never reads the config                      |

Modify:

- **Rust shell:**
  - `apps/station/src-tauri/Cargo.toml`: `windows-sys` features.
  - `apps/station/src-tauri/src/config.rs`: three helpers become `pub(crate)`.
  - `apps/station/src-tauri/src/lib.rs`: `mod storage;`, background resolution, command registration.
  - `apps/station/src-tauri/src/commands.rs`: gate-backed config commands and two new commands.
  - `apps/station/src-tauri/src/grant_transaction.rs`: the database path comes from the gate.
- **Webview:** `apps/station/src/lib/sqlite.ts`, `src/App.tsx`, `src/pages/UpdateCenter.tsx`, `src/pages/Enrollment.tsx`, `src/station.css`, `src/i18n/en.json`, `src/i18n/ru.json`, `test/update-center.test.tsx`, `test/enrollment.test.tsx`.
- **CI:** `.github/workflows/ci.yml`.
- **Release contract and docs:**
  - `docs/acceptance/station-dual-origin-release.md` and `docs/acceptance/station-stable-release.md`;
  - `tools/station-release/test/docs.test.mjs`;
  - `docs/runbooks/station-beta-release.md` and `docs/runbooks/station-stable-release.md`;
  - `docs/operations/first-customer-inventory/README.md` and `protocol-v1.md`;
  - `docs/architecture.md` and `apps/station/README.md`;
  - the spec itself (implementation notes).

`dead_code` warnings from `src/storage/` are expected until Task 6 wires the module into the shell.

---

### Task 1: Storage types, database URL and the profile probe

**Files:**

- Create: `apps/station/src-tauri/src/storage/mod.rs`
- Create: `apps/station/src-tauri/src/storage/probe.rs`
- Modify: `apps/station/src-tauri/src/lib.rs` (module list)
- Modify: `apps/station/src-tauri/Cargo.toml` (`windows-sys` features)

**Interfaces:**

- Produces:
  - `storage::StationStorage { dir: PathBuf, mode: StorageMode, notices: Vec<StorageNotice> }` with `fn database_path(&self) -> PathBuf`.
  - `storage::StorageMode::{Local, Legacy}`.
  - `storage::StorageNotice::{LegacyInUse, MoveFailed, LocalLessDurable { reason }, RoamedCopyPresent { same_machine_id }, ClaimLeftovers}`.
  - `storage::database_url(&Path) -> String`.
  - `storage::ProfileFacts { temporary, mandatory, roaming, delete_roaming_cache }` with `fn local_less_durable(&self) -> Option<LessDurableReason>`.
  - `storage::LessDurableReason::{TemporaryProfile, MandatoryProfile, DeleteRoamingCache}`.
  - `storage::profile_facts() -> ProfileFacts`.
  - Crate-private constants `CONFIG_FILE = "station.json"` and `DATABASE_FILE = "station-mirror.db"`.
  - Serialized JSON: `mode` is `"local"`/`"legacy"`; notices look like `{ "kind": "local_less_durable", "reason": "delete_roaming_cache" }` and `{ "kind": "roamed_copy_present", "sameMachineId": true }`.

- [ ] **Step 1: Add the `windows-sys` features and the module declaration**

In `apps/station/src-tauri/Cargo.toml`, replace:

```toml
  "Win32_Security",
  "Win32_System_Power",
  "Win32_System_Threading",
] }
```

with:

```toml
  "Win32_Security",
  "Win32_System_Power",
  "Win32_System_Threading",
  # storage/probe.rs: GetProfileType (UI_Shell), its PT_* flags (GroupPolicy)
  # and the DeleteRoamingCache policy value (Registry).
  "Win32_System_GroupPolicy",
  "Win32_System_Registry",
  "Win32_UI_Shell",
] }
```

In `apps/station/src-tauri/src/lib.rs`, replace `mod scanner;\nmod updater;` with:

```rust
mod scanner;
mod storage;
mod updater;
```

- [ ] **Step 2: Write the failing tests**

Create `apps/station/src-tauri/src/storage/probe.rs` containing only the tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_profiles_that_lose_local_data_keep_the_roaming_folder() {
        let local = ProfileFacts::default();
        assert_eq!(local.local_less_durable(), None);
        let roaming = ProfileFacts { roaming: true, ..local };
        assert_eq!(roaming.local_less_durable(), None);
        let deleting = ProfileFacts { delete_roaming_cache: true, ..roaming };
        assert_eq!(
            deleting.local_less_durable(),
            Some(LessDurableReason::DeleteRoamingCache)
        );
        // The policy only deletes roaming profiles' local copies.
        let local_with_policy = ProfileFacts { delete_roaming_cache: true, ..local };
        assert_eq!(local_with_policy.local_less_durable(), None);
        assert_eq!(
            ProfileFacts { temporary: true, ..local }.local_less_durable(),
            Some(LessDurableReason::TemporaryProfile)
        );
        assert_eq!(
            ProfileFacts { mandatory: true, ..local }.local_less_durable(),
            Some(LessDurableReason::MandatoryProfile)
        );
    }

    /// The GitHub Windows runner signs in with an ordinary local profile.
    #[cfg(windows)]
    #[test]
    fn the_runner_profile_allows_the_move() {
        assert_eq!(profile_facts().local_less_durable(), None);
    }
}
```

Create `apps/station/src-tauri/src/storage/mod.rs` containing the module wiring and only the tests:

```rust
//! Where the station keeps `station.json` and `station-mirror.db`.
//!
//! Tauri's `app_config_dir()` is the roaming AppData folder on Windows, so a
//! roaming profile or AppData folder redirection carried the station identity
//! and its offline journal to other computers. The files now live in
//! `app_local_data_dir()` (`%LOCALAPPDATA%`), and [`resolve`] moves an existing
//! installation there exactly once. Design:
//! docs/superpowers/specs/2026-09-27-station-local-storage-design.md.

mod probe;

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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/station/src-tauri/Cargo.toml storage::`
Expected: FAIL to compile, with `cannot find type 'ProfileFacts'`, `cannot find function 'database_url'` and similar.

- [ ] **Step 4: Implement the probe**

Insert above the test module in `apps/station/src-tauri/src/storage/probe.rs`:

```rust
use serde::Serialize;

/// What the Windows profile says about how long `%LOCALAPPDATA%` survives.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProfileFacts {
    pub temporary: bool,
    pub mandatory: bool,
    pub roaming: bool,
    pub delete_roaming_cache: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LessDurableReason {
    TemporaryProfile,
    MandatoryProfile,
    DeleteRoamingCache,
}

impl ProfileFacts {
    /// A temporary or mandatory profile is discarded at sign-out, and the
    /// "delete cached copies of roaming profiles" policy deletes the local
    /// profile copy, `%LOCALAPPDATA%` included. There the roaming copy is the
    /// only one that survives, so the station must not move into Local.
    pub fn local_less_durable(&self) -> Option<LessDurableReason> {
        if self.temporary {
            Some(LessDurableReason::TemporaryProfile)
        } else if self.mandatory {
            Some(LessDurableReason::MandatoryProfile)
        } else if self.roaming && self.delete_roaming_cache {
            Some(LessDurableReason::DeleteRoamingCache)
        } else {
            None
        }
    }
}

#[cfg(windows)]
pub fn profile_facts() -> ProfileFacts {
    use windows_sys::Win32::System::GroupPolicy::{
        PT_MANDATORY, PT_ROAMING, PT_ROAMING_PREEXISTING, PT_TEMPORARY,
    };
    use windows_sys::Win32::UI::Shell::GetProfileType;

    let mut flags = 0u32;
    let known = unsafe { GetProfileType(&mut flags) } != 0;
    ProfileFacts {
        temporary: known && flags & PT_TEMPORARY != 0,
        mandatory: known && flags & PT_MANDATORY != 0,
        // An unknown profile counts as roaming, so the delete-cache policy on
        // its own still keeps the station where it is.
        roaming: !known || flags & (PT_ROAMING | PT_ROAMING_PREEXISTING) != 0,
        delete_roaming_cache: policy_dword(
            r"SOFTWARE\Policies\Microsoft\Windows\System",
            "DeleteRoamingCache",
        ) == Some(1),
    }
}

#[cfg(windows)]
fn policy_dword(key: &str, value: &str) -> Option<u32> {
    use std::iter::once;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD};

    let key: Vec<u16> = key.encode_utf16().chain(once(0)).collect();
    let value: Vec<u16> = value.encode_utf16().chain(once(0)).collect();
    let mut data = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut data as *mut u32).cast(),
            &mut size,
        )
    };
    (status == ERROR_SUCCESS).then_some(data)
}

/// Outside Windows there are no roaming profiles.
#[cfg(not(windows))]
pub fn profile_facts() -> ProfileFacts {
    ProfileFacts::default()
}
```

- [ ] **Step 5: Implement the public types and the URL**

In `apps/station/src-tauri/src/storage/mod.rs`, replace the line `mod probe;` with:

```rust
mod probe;

use std::path::{Path, PathBuf};

use serde::Serialize;

pub use probe::{profile_facts, LessDurableReason, ProfileFacts};

pub(crate) const CONFIG_FILE: &str = "station.json";
pub(crate) const DATABASE_FILE: &str = "station-mirror.db";

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
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test --manifest-path apps/station/src-tauri/Cargo.toml storage::`
Expected: PASS, 3 tests on macOS/Linux: `database_url_round_trips_through_sqlx`, `notices_serialize_for_the_webview` and `only_profiles_that_lose_local_data_keep_the_roaming_folder`.

- [ ] **Step 7: Commit**

```bash
git add apps/station/src-tauri/Cargo.toml apps/station/src-tauri/src/lib.rs apps/station/src-tauri/src/storage/mod.rs apps/station/src-tauri/src/storage/probe.rs
git commit -m "feat(station): типы хранилища станции и проверка профиля Windows" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The move record

**Files:**

- Create: `apps/station/src-tauri/src/storage/record.rs`
- Modify: `apps/station/src-tauri/src/storage/mod.rs` (add `mod record;`)
- Modify: `apps/station/src-tauri/src/config.rs:176-261` (three helpers become `pub(crate)`)

**Interfaces:**

- Consumes: `config::write_owner_only(&Path, &[u8]) -> Result<(), String>`, `config::replace_config_file(&Path, &Path) -> std::io::Result<()>`, `config::sync_parent_directory(&Path) -> Result<(), String>`.
- Produces (crate-private):
  - `record::RECORD_FILE = "station-storage.json"`.
  - `record::StorageRecord::{Claiming { legacy_dir, claim_dir }, Committed { origin, pending_cleanup: Option<PathBuf> }}`.
  - `record::Origin::{Fresh, Adopted, Migrated}`.
  - `record::read(&Path) -> Result<Option<StorageRecord>, String>`.
  - `record::write(&Path, &StorageRecord) -> Result<(), String>`.
  - `record::remove(&Path) -> Result<(), String>`.
  - On-disk JSON: `{"version":1,"record":{"state":"claiming","legacy_dir":...,"claim_dir":...}}`.

- [ ] **Step 1: Expose the atomic-write helpers**

In `apps/station/src-tauri/src/config.rs`, change these five signatures (Windows and non-Windows variants) from `fn` to `pub(crate) fn`, changing nothing else:

```rust
pub(crate) fn replace_config_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
```

(both the `#[cfg(windows)]` and the `#[cfg(not(windows))]` variant),

```rust
pub(crate) fn sync_parent_directory(dir: &Path) -> Result<(), String> {
```

```rust
pub(crate) fn sync_parent_directory(_dir: &Path) -> Result<(), String> {
```

```rust
pub(crate) fn write_owner_only(path: &Path, data: &[u8]) -> Result<(), String> {
```

(both the `#[cfg(unix)]` and the `#[cfg(not(unix))]` variant).

In the same file, the doc comment above `pub fn write_config` ends with `created at mode 0600; Windows uses the per-user app-config directory.`. Replace that line with:

```rust
/// created at mode 0600; on Windows the per-user local app-data folder's ACL applies.
```

In `apps/station/src-tauri/src/storage/mod.rs` replace `mod probe;` with:

```rust
mod probe;
mod record;
```

- [ ] **Step 2: Write the failing tests**

Create `apps/station/src-tauri/src/storage/record.rs` with only the tests:

```rust
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

    #[test]
    fn garbage_or_an_unknown_version_is_an_error() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(RECORD_FILE), b"{not json").unwrap();
        assert!(read(&dir).is_err());
        fs::write(
            dir.join(RECORD_FILE),
            br#"{"version":2,"record":{"state":"committed","origin":"fresh","pending_cleanup":null}}"#,
        )
        .unwrap();
        assert!(read(&dir).is_err());
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/station/src-tauri/Cargo.toml storage::record`
Expected: FAIL to compile (`cannot find type 'StorageRecord'`, `cannot find function 'read'`).

- [ ] **Step 4: Implement the record**

Insert above the test module in `apps/station/src-tauri/src/storage/record.rs`:

```rust
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::config;

pub(crate) const RECORD_FILE: &str = "station-storage.json";
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

pub(crate) fn read(local_dir: &Path) -> Result<Option<StorageRecord>, String> {
    let data = match fs::read(local_dir.join(RECORD_FILE)) {
        Ok(data) => data,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("station storage record unreadable: {error}")),
    };
    let file: RecordFile = serde_json::from_slice(&data)
        .map_err(|error| format!("station storage record invalid: {error}"))?;
    if file.version != RECORD_VERSION {
        return Err(format!(
            "station storage record version {} is not supported",
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
    let temporary = local_dir.join(format!(".station-storage-{}.tmp", Uuid::new_v4()));
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test --manifest-path apps/station/src-tauri/Cargo.toml storage::record`
Expected: PASS (4 tests). Then run `cargo test --manifest-path apps/station/src-tauri/Cargo.toml config::`. Expected: PASS; the existing `config.rs` tests are unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/station/src-tauri/src/config.rs apps/station/src-tauri/src/storage/mod.rs apps/station/src-tauri/src/storage/record.rs
git commit -m "feat(station): запись о переносе хранилища станции" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Exclusive-handle copy and verification

**Files:**

- Create: `apps/station/src-tauri/src/storage/copy.rs`
- Modify: `apps/station/src-tauri/src/storage/mod.rs` (add `mod copy;`)

**Interfaces:**

- Produces (crate-private):
  - `copy::CopyError::{InUse, Failed(String)}`, with `From<std::io::Error>`.
  - `copy::store_files(&Path) -> io::Result<Vec<OsString>>`: top-level regular files, sorted, without `*.tmp` and `-shm`.
  - `copy::hold(&Path, &[OsString]) -> Result<HeldFiles, CopyError>`.
  - `HeldFiles::copy_to(&mut self, staging: &Path) -> Result<(), CopyError>`.
  - `HeldFiles::verify(&mut self, staging: &Path) -> Result<(), CopyError>`.

- [ ] **Step 1: Declare the module**

In `apps/station/src-tauri/src/storage/mod.rs`, replace `mod probe;\nmod record;` with:

```rust
mod copy;
mod probe;
mod record;
```

- [ ] **Step 2: Write the failing tests**

Create `apps/station/src-tauri/src/storage/copy.rs` with only the tests:

```rust
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/station/src-tauri/Cargo.toml storage::copy`
Expected: FAIL to compile (`cannot find function 'store_files'`).

- [ ] **Step 4: Implement the copy**

Insert above the test module in `apps/station/src-tauri/src/storage/copy.rs`:

```rust
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test --manifest-path apps/station/src-tauri/Cargo.toml storage::copy`
Expected: PASS (2 tests on macOS/Linux; 3 on Windows).

- [ ] **Step 6: Commit**

```bash
git add apps/station/src-tauri/src/storage/mod.rs apps/station/src-tauri/src/storage/copy.rs
git commit -m "feat(station): копирование файлов станции под эксклюзивными дескрипторами" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The storage gate

**Files:**

- Create: `apps/station/src-tauri/src/storage/gate.rs`
- Modify: `apps/station/src-tauri/src/storage/mod.rs`

**Interfaces:**

- Consumes: `StationStorage` (Task 1).
- Produces:
  - `storage::storage_gate() -> (StorageGateSender, StorageGate)`.
  - `StorageGateSender::resolve(self, Result<StationStorage, String>)`.
  - `StorageGate: Clone`, with `async fn ready(&self) -> Result<StationStorage, String>`.

- [ ] **Step 1: Declare the module and its exports**

In `apps/station/src-tauri/src/storage/mod.rs`, replace:

```rust
mod copy;
mod probe;
mod record;
```

with:

```rust
mod copy;
mod gate;
mod probe;
mod record;
```

and replace `pub use probe::{profile_facts, LessDurableReason, ProfileFacts};` with:

```rust
pub use gate::{storage_gate, StorageGate, StorageGateSender};
pub use probe::{profile_facts, LessDurableReason, ProfileFacts};
```

- [ ] **Step 2: Write the failing tests**

Create `apps/station/src-tauri/src/storage/gate.rs` with only the tests:

```rust
#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::super::{StationStorage, StorageMode};
    use super::*;

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    fn storage() -> StationStorage {
        StationStorage {
            dir: PathBuf::from("/tmp/local"),
            mode: StorageMode::Local,
            notices: Vec::new(),
        }
    }

    #[test]
    fn callers_wait_for_the_resolution_and_later_callers_get_it_at_once() {
        runtime().block_on(async {
            let (sender, gate) = storage_gate();
            let waiting = tokio::spawn({
                let gate = gate.clone();
                async move { gate.ready().await }
            });
            tokio::task::yield_now().await;
            assert!(!waiting.is_finished());
            sender.resolve(Ok(storage()));
            assert_eq!(waiting.await.unwrap(), Ok(storage()));
            assert_eq!(gate.ready().await, Ok(storage()));
        });
    }

    #[test]
    fn a_blocked_resolution_and_a_lost_sender_are_errors() {
        runtime().block_on(async {
            let (sender, gate) = storage_gate();
            sender.resolve(Err("blocked".into()));
            assert_eq!(gate.ready().await, Err("blocked".to_string()));

            let (sender, gate) = storage_gate();
            drop(sender);
            assert!(gate.ready().await.is_err());
        });
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/station/src-tauri/Cargo.toml storage::gate`
Expected: FAIL to compile (`cannot find function 'storage_gate'`).

- [ ] **Step 4: Implement the gate**

Insert above the test module in `apps/station/src-tauri/src/storage/gate.rs`:

```rust
use tokio::sync::watch;

use super::StationStorage;

type Resolution = Option<Result<StationStorage, String>>;

/// Commands wait here until the background thread has resolved storage.
#[derive(Clone)]
pub struct StorageGate(watch::Receiver<Resolution>);

pub struct StorageGateSender(watch::Sender<Resolution>);

pub fn storage_gate() -> (StorageGateSender, StorageGate) {
    let (sender, receiver) = watch::channel(None);
    (StorageGateSender(sender), StorageGate(receiver))
}

impl StorageGateSender {
    pub fn resolve(self, resolution: Result<StationStorage, String>) {
        let _ = self.0.send(Some(resolution));
    }
}

impl StorageGate {
    /// The resolved storage, or why the station must not start. A sender
    /// dropped without an answer (the resolving thread died) is an error too,
    /// never a fallback to the roaming folder.
    pub async fn ready(&self) -> Result<StationStorage, String> {
        let mut receiver = self.0.clone();
        let resolved = receiver
            .wait_for(Option::is_some)
            .await
            .map_err(|_| "station storage was not resolved".to_string())?;
        match &*resolved {
            Some(resolution) => resolution.clone(),
            None => Err("station storage was not resolved".to_string()),
        }
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test --manifest-path apps/station/src-tauri/Cargo.toml storage::gate`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/station/src-tauri/src/storage/mod.rs apps/station/src-tauri/src/storage/gate.rs
git commit -m "feat(station): ожидание разрешённого хранилища для команд станции" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Resolve — the one-time move

**Files:**

- Create: `apps/station/src-tauri/src/storage/resolve.rs`
- Modify: `apps/station/src-tauri/src/storage/mod.rs`

**Interfaces:**

- Consumes: Tasks 1–4 (`ProfileFacts`, `record::*`, `copy::*`, `StationStorage`, `StorageNotice`, `CONFIG_FILE`, `DATABASE_FILE`).
- Produces:
  - `storage::resolve(legacy_dir: &Path, local_dir: &Path, facts: ProfileFacts, hook: &mut dyn FnMut(Step) -> Result<(), String>) -> Result<StationStorage, String>`. `Err` means the station must not start.
  - `storage::Step::{Record, Claim, Hold, Verify, Install, Commit, Cleanup}`.
  - Production passes `&mut |_| Ok(())`.

- [ ] **Step 1: Declare the module and its export**

In `apps/station/src-tauri/src/storage/mod.rs`, replace:

```rust
mod probe;
mod record;
```

with:

```rust
mod probe;
mod record;
mod resolve;
```

and add after the `pub use probe::...` line:

```rust
pub use resolve::{resolve, Step};
```

- [ ] **Step 2: Write the failing tests**

Create `apps/station/src-tauri/src/storage/resolve.rs` with only the tests. These cover spec §7 items 1–11 plus the Windows-only item 14.

```rust
#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::ffi::OsString;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    use super::super::LessDurableReason;
    use super::*;

    struct Dirs {
        legacy: PathBuf,
        local: PathBuf,
    }

    fn fresh_dirs() -> Dirs {
        let root = std::env::temp_dir().join(format!("markiro-storage-{}", Uuid::new_v4()));
        Dirs {
            legacy: root.join("Roaming").join("app.markiro.station"),
            local: root.join("Local").join("app.markiro.station"),
        }
    }

    type Files = BTreeMap<OsString, Vec<u8>>;

    /// A store as the current release leaves it: the pair, a hot journal, a
    /// durability backup of the config, and an interrupted config write.
    fn seed(dir: &Path, machine_id: &str) -> Files {
        fs::create_dir_all(dir).unwrap();
        let config = format!(
            r#"{{"machine_id":"{machine_id}","device_id":"device-1","api_key":"credential-placeholder","server_url":"https://api.example"}}"#
        );
        let files: Files = [
            (CONFIG_FILE, config.into_bytes()),
            (
                DATABASE_FILE,
                (0..70_000u32).map(|value| (value % 253) as u8).collect(),
            ),
            ("station-mirror.db-journal", b"hot journal".to_vec()),
            (".station-11111111.bak", b"previous config".to_vec()),
        ]
        .into_iter()
        .map(|(name, bytes)| (OsString::from(name), bytes))
        .collect();
        for (name, bytes) in &files {
            fs::write(dir.join(name), bytes).unwrap();
        }
        fs::write(dir.join(".station-22222222.tmp"), b"interrupted").unwrap();
        files
    }

    /// Top-level files of a folder, without the move's bookkeeping and
    /// without transient `*.tmp` writes.
    fn files(dir: &Path) -> Files {
        let Ok(entries) = fs::read_dir(dir) else {
            return Files::new();
        };
        entries
            .map(Result::unwrap)
            .filter(|entry| entry.file_type().unwrap().is_file())
            .map(|entry| entry.file_name())
            .filter(|name| {
                name.as_os_str() != RECORD_FILE
                    && name.as_os_str() != LOCK_FILE
                    && !name.to_string_lossy().ends_with(".tmp")
            })
            .map(|name| {
                let bytes = fs::read(dir.join(&name)).unwrap();
                (name, bytes)
            })
            .collect()
    }

    fn claims(dirs: &Dirs) -> Vec<PathBuf> {
        let Ok(entries) = fs::read_dir(dirs.legacy.parent().unwrap()) else {
            return Vec::new();
        };
        entries
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("app.markiro.station.migrating-")
            })
            .collect()
    }

    fn staging(dirs: &Dirs) -> Vec<PathBuf> {
        let Ok(entries) = fs::read_dir(&dirs.local) else {
            return Vec::new();
        };
        entries
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(STAGING_PREFIX)
            })
            .collect()
    }

    fn ok(_: Step) -> Result<(), String> {
        Ok(())
    }

    fn run(dirs: &Dirs, facts: ProfileFacts) -> Result<StationStorage, String> {
        resolve(&dirs.legacy, &dirs.local, facts, &mut ok)
    }

    fn local_profile() -> ProfileFacts {
        ProfileFacts::default()
    }

    /// Where the pair must be, judged only from what is on disk.
    fn authoritative(dirs: &Dirs) -> PathBuf {
        match record::read(&dirs.local).unwrap() {
            None => dirs.legacy.clone(),
            Some(StorageRecord::Claiming {
                legacy_dir,
                claim_dir,
            }) => {
                if claim_dir.exists() {
                    claim_dir
                } else {
                    legacy_dir
                }
            }
            Some(StorageRecord::Committed { .. }) => dirs.local.clone(),
        }
    }

    #[test]
    fn a_fresh_station_starts_in_the_local_folder() {
        let dirs = fresh_dirs();
        assert_eq!(
            run(&dirs, local_profile()).unwrap(),
            local(&dirs.local, Vec::new())
        );
        assert_eq!(
            record::read(&dirs.local).unwrap(),
            Some(StorageRecord::Committed {
                origin: Origin::Fresh,
                pending_cleanup: None
            })
        );
        assert!(!dirs.legacy.exists());
    }

    #[test]
    fn moves_the_pair_byte_for_byte_and_empties_the_roaming_side() {
        let dirs = fresh_dirs();
        let original = seed(&dirs.legacy, "machine-1");
        let storage = run(&dirs, local_profile()).unwrap();
        assert_eq!(storage, local(&dirs.local, Vec::new()));
        assert_eq!(files(&dirs.local), original);
        assert!(!dirs.local.join(".station-22222222.tmp").exists());
        assert!(!dirs.legacy.exists());
        assert!(claims(&dirs).is_empty());
        assert!(staging(&dirs).is_empty());
        assert_eq!(
            record::read(&dirs.local).unwrap(),
            Some(StorageRecord::Committed {
                origin: Origin::Migrated,
                pending_cleanup: None
            })
        );
        // A second start changes nothing.
        assert_eq!(run(&dirs, local_profile()).unwrap(), storage);
        assert_eq!(files(&dirs.local), original);
    }

    #[test]
    fn a_crash_at_any_step_loses_nothing_and_the_next_start_finishes() {
        for crash_at in [
            Step::Record,
            Step::Claim,
            Step::Hold,
            Step::Verify,
            Step::Install,
            Step::Commit,
            Step::Cleanup,
        ] {
            let dirs = fresh_dirs();
            let original = seed(&dirs.legacy, "machine-1");
            let crashed = catch_unwind(AssertUnwindSafe(|| {
                resolve(&dirs.legacy, &dirs.local, local_profile(), &mut |step| {
                    if step == crash_at {
                        panic!("simulated crash at {step:?}");
                    }
                    Ok(())
                })
            }));
            assert!(crashed.is_err(), "{crash_at:?}");
            assert_eq!(
                files(&authoritative(&dirs)),
                original,
                "the authoritative copy after a crash at {crash_at:?}"
            );

            assert_eq!(
                run(&dirs, local_profile()).unwrap(),
                local(&dirs.local, Vec::new()),
                "{crash_at:?}"
            );
            assert_eq!(files(&dirs.local), original, "{crash_at:?}");
            assert!(!dirs.legacy.exists(), "{crash_at:?}");
            assert!(claims(&dirs).is_empty(), "{crash_at:?}");
            assert!(staging(&dirs).is_empty(), "{crash_at:?}");
        }
    }

    #[test]
    fn two_concurrent_starts_move_the_pair_once() {
        let dirs = fresh_dirs();
        let original = seed(&dirs.legacy, "machine-1");
        let results = std::thread::scope(|scope| {
            let first = scope.spawn(|| run(&dirs, local_profile()));
            let second = scope.spawn(|| run(&dirs, local_profile()));
            [first.join().unwrap(), second.join().unwrap()]
        });
        for result in results {
            assert_eq!(result.unwrap(), local(&dirs.local, Vec::new()));
        }
        assert_eq!(files(&dirs.local), original);
        assert!(claims(&dirs).is_empty());
    }

    #[test]
    fn a_refused_claim_keeps_today_s_folder_and_the_next_start_moves() {
        let dirs = fresh_dirs();
        let original = seed(&dirs.legacy, "machine-1");
        let storage = resolve(&dirs.legacy, &dirs.local, local_profile(), &mut |step| {
            if step == Step::Claim {
                Err("sharing violation".to_string())
            } else {
                Ok(())
            }
        })
        .unwrap();
        assert_eq!(
            storage,
            legacy(&dirs.legacy, vec![StorageNotice::LegacyInUse])
        );
        assert_eq!(files(&dirs.legacy), original);
        assert_eq!(record::read(&dirs.local).unwrap(), None);

        assert_eq!(
            run(&dirs, local_profile()).unwrap(),
            local(&dirs.local, Vec::new())
        );
        assert_eq!(files(&dirs.local), original);
    }

    #[test]
    fn a_held_file_runs_the_station_from_the_claim_until_the_next_start() {
        let dirs = fresh_dirs();
        let original = seed(&dirs.legacy, "machine-1");
        let storage = resolve(&dirs.legacy, &dirs.local, local_profile(), &mut |step| {
            if step == Step::Hold {
                Err("in use".to_string())
            } else {
                Ok(())
            }
        })
        .unwrap();
        let claimed = claims(&dirs);
        assert_eq!(claimed.len(), 1);
        assert_eq!(
            storage,
            legacy(&claimed[0], vec![StorageNotice::LegacyInUse])
        );
        assert_eq!(files(&claimed[0]), original);
        assert!(files(&dirs.local).is_empty());

        assert_eq!(
            run(&dirs, local_profile()).unwrap(),
            local(&dirs.local, Vec::new())
        );
        assert_eq!(files(&dirs.local), original);
        assert!(claims(&dirs).is_empty());
    }

    #[test]
    fn a_copy_that_differs_from_its_source_is_never_installed() {
        let dirs = fresh_dirs();
        let original = seed(&dirs.legacy, "machine-1");
        let local_dir = dirs.local.clone();
        let storage = resolve(&dirs.legacy, &dirs.local, local_profile(), &mut |step| {
            if step == Step::Verify {
                let staged = fs::read_dir(&local_dir)
                    .unwrap()
                    .map(|entry| entry.unwrap().path())
                    .find(|path| {
                        path.file_name()
                            .unwrap()
                            .to_string_lossy()
                            .starts_with(STAGING_PREFIX)
                    })
                    .unwrap()
                    .join(DATABASE_FILE);
                let mut bytes = fs::read(&staged).unwrap();
                bytes[10] ^= 1;
                fs::write(&staged, bytes).unwrap();
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(storage.mode, StorageMode::Legacy);
        assert_eq!(storage.notices, vec![StorageNotice::MoveFailed]);
        assert_eq!(files(&storage.dir), original);
        assert!(files(&dirs.local).is_empty());
        assert!(staging(&dirs).is_empty());

        assert_eq!(
            run(&dirs, local_profile()).unwrap(),
            local(&dirs.local, Vec::new())
        );
        assert_eq!(files(&dirs.local), original);
    }

    #[test]
    fn leftovers_of_an_interrupted_install_are_replaced_not_trusted() {
        let dirs = fresh_dirs();
        let mut expected = seed(&dirs.legacy, "machine-1");
        let _ = catch_unwind(AssertUnwindSafe(|| {
            resolve(&dirs.legacy, &dirs.local, local_profile(), &mut |step| {
                if step == Step::Hold {
                    panic!("simulated crash");
                }
                Ok(())
            })
        }));
        // As if an earlier install had been cut short, plus a WAL the source
        // never had: SQLite would replay a stale sidecar next to a fresh copy.
        fs::write(dirs.local.join(DATABASE_FILE), b"stale").unwrap();
        fs::write(dirs.local.join("station-mirror.db-wal"), b"stale wal").unwrap();
        // The source's journal was rolled back in the meantime.
        let claim = claims(&dirs).remove(0);
        fs::remove_file(claim.join("station-mirror.db-journal")).unwrap();
        expected.remove(&OsString::from("station-mirror.db-journal"));

        assert_eq!(
            run(&dirs, local_profile()).unwrap(),
            local(&dirs.local, Vec::new())
        );
        assert_eq!(files(&dirs.local), expected);
    }

    #[test]
    fn station_files_that_roam_back_are_reported_and_never_loaded() {
        let dirs = fresh_dirs();
        let original = seed(&dirs.legacy, "machine-1");
        run(&dirs, local_profile()).unwrap();

        let roamed = seed(&dirs.legacy, "machine-1");
        assert_eq!(
            run(&dirs, local_profile()).unwrap(),
            local(
                &dirs.local,
                vec![StorageNotice::RoamedCopyPresent {
                    same_machine_id: true
                }]
            )
        );
        assert_eq!(files(&dirs.local), original);
        assert_eq!(files(&dirs.legacy), roamed);

        fs::write(
            dirs.legacy.join(CONFIG_FILE),
            br#"{"machine_id":"machine-2"}"#,
        )
        .unwrap();
        assert_eq!(
            run(&dirs, local_profile()).unwrap().notices,
            vec![StorageNotice::RoamedCopyPresent {
                same_machine_id: false
            }]
        );
    }

    #[test]
    fn files_placed_only_in_the_local_folder_are_adopted() {
        let dirs = fresh_dirs();
        let placed = seed(&dirs.local, "machine-1");
        assert_eq!(
            run(&dirs, local_profile()).unwrap(),
            local(&dirs.local, Vec::new())
        );
        assert_eq!(files(&dirs.local), placed);
        assert_eq!(
            record::read(&dirs.local).unwrap(),
            Some(StorageRecord::Committed {
                origin: Origin::Adopted,
                pending_cleanup: None
            })
        );
    }

    #[test]
    fn ambiguous_states_block_instead_of_minting() {
        // Station files on both sides and no record.
        let dirs = fresh_dirs();
        let roaming = seed(&dirs.legacy, "machine-1");
        let placed = seed(&dirs.local, "machine-1");
        assert!(run(&dirs, local_profile()).is_err());
        assert_eq!(files(&dirs.legacy), roaming);
        assert_eq!(files(&dirs.local), placed);

        // An unreadable record.
        let dirs = fresh_dirs();
        fs::create_dir_all(&dirs.local).unwrap();
        fs::write(dirs.local.join(RECORD_FILE), b"{").unwrap();
        assert!(run(&dirs, local_profile()).is_err());

        // A recorded claim whose files are gone.
        let dirs = fresh_dirs();
        record::write(
            &dirs.local,
            &StorageRecord::Claiming {
                legacy_dir: dirs.legacy.clone(),
                claim_dir: dirs
                    .legacy
                    .with_file_name("app.markiro.station.migrating-gone"),
            },
        )
        .unwrap();
        assert!(run(&dirs, local_profile()).is_err());

        // A claimed folder but no record: this machine's record may be lost.
        let dirs = fresh_dirs();
        seed(
            &dirs
                .legacy
                .with_file_name("app.markiro.station.migrating-orphan"),
            "machine-1",
        );
        assert!(run(&dirs, local_profile()).is_err());
    }

    #[test]
    fn profiles_that_wipe_local_data_keep_the_roaming_folder() {
        for (facts, reason) in [
            (
                ProfileFacts {
                    temporary: true,
                    ..ProfileFacts::default()
                },
                LessDurableReason::TemporaryProfile,
            ),
            (
                ProfileFacts {
                    mandatory: true,
                    ..ProfileFacts::default()
                },
                LessDurableReason::MandatoryProfile,
            ),
            (
                ProfileFacts {
                    roaming: true,
                    delete_roaming_cache: true,
                    ..ProfileFacts::default()
                },
                LessDurableReason::DeleteRoamingCache,
            ),
        ] {
            let dirs = fresh_dirs();
            let original = seed(&dirs.legacy, "machine-1");
            assert_eq!(
                run(&dirs, facts).unwrap(),
                legacy(
                    &dirs.legacy,
                    vec![StorageNotice::LocalLessDurable { reason }]
                )
            );
            assert_eq!(files(&dirs.legacy), original);
            assert_eq!(record::read(&dirs.local).unwrap(), None);

            // A fresh station there starts in the roaming folder as well.
            let fresh = fresh_dirs();
            assert_eq!(run(&fresh, facts).unwrap().dir, fresh.legacy);

            // Already moved before the policy arrived: stay, but say so.
            let moved = fresh_dirs();
            seed(&moved.legacy, "machine-1");
            run(&moved, local_profile()).unwrap();
            assert_eq!(
                run(&moved, facts).unwrap(),
                local(
                    &moved.local,
                    vec![StorageNotice::LocalLessDurable { reason }]
                )
            );
        }

        // A roaming profile without the policy moves.
        let dirs = fresh_dirs();
        seed(&dirs.legacy, "machine-1");
        let roaming = ProfileFacts {
            roaming: true,
            ..ProfileFacts::default()
        };
        assert_eq!(run(&dirs, roaming).unwrap().mode, StorageMode::Local);
    }

    #[test]
    fn the_same_folder_on_both_sides_needs_no_move() {
        let dirs = fresh_dirs();
        let original = seed(&dirs.local, "machine-1");
        assert_eq!(
            resolve(&dirs.local, &dirs.local, local_profile(), &mut ok).unwrap(),
            local(&dirs.local, Vec::new())
        );
        assert_eq!(files(&dirs.local), original);
        assert_eq!(record::read(&dirs.local).unwrap(), None);
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn a_moved_database_opens_with_the_same_facts_and_counters() {
        use sqlx::sqlite::SqliteConnectOptions;
        use sqlx::{Connection, SqliteConnection};

        let dirs = fresh_dirs();
        fs::create_dir_all(&dirs.legacy).unwrap();
        fs::write(
            dirs.legacy.join(CONFIG_FILE),
            br#"{"machine_id":"machine-1"}"#,
        )
        .unwrap();
        let runtime = runtime();
        runtime.block_on(async {
            let options = SqliteConnectOptions::new()
                .filename(dirs.legacy.join(DATABASE_FILE))
                .create_if_missing(true);
            let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
            for statement in [
                "CREATE TABLE outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)",
                "CREATE TABLE sscc_pool(issuer_prefix TEXT NOT NULL, extension_digit INTEGER NOT NULL, from_serial INTEGER NOT NULL, to_serial INTEGER NOT NULL, next_serial INTEGER NOT NULL, PRIMARY KEY(issuer_prefix, extension_digit, from_serial))",
                "CREATE TABLE station_meta(key TEXT PRIMARY KEY, value TEXT)",
                "CREATE TABLE station_device_recovery(id INTEGER PRIMARY KEY CHECK(id=1), machine_id TEXT NOT NULL)",
                "INSERT INTO outbox(payload) VALUES('scan-1'),('scan-2'),('scan-3')",
                "DELETE FROM outbox WHERE id=3",
                "INSERT INTO sscc_pool VALUES('460000000',0,1,1000,42)",
                "INSERT INTO station_meta VALUES('install_id','install-1')",
                "INSERT INTO station_device_recovery VALUES(1,'machine-1')",
            ] {
                sqlx::query(statement).execute(&mut connection).await.unwrap();
            }
            connection.close().await.unwrap();
        });

        assert_eq!(
            run(&dirs, local_profile()).unwrap().mode,
            StorageMode::Local
        );
        assert!(!dirs.legacy.exists());

        runtime.block_on(async {
            let options = SqliteConnectOptions::new()
                .filename(dirs.local.join(DATABASE_FILE))
                .create_if_missing(false);
            let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
            let check: String = sqlx::query_scalar("PRAGMA quick_check")
                .fetch_one(&mut connection)
                .await
                .unwrap();
            assert_eq!(check, "ok");
            let next_serial: i64 = sqlx::query_scalar("SELECT next_serial FROM sscc_pool")
                .fetch_one(&mut connection)
                .await
                .unwrap();
            assert_eq!(next_serial, 42);
            let install_id: String =
                sqlx::query_scalar("SELECT value FROM station_meta WHERE key='install_id'")
                    .fetch_one(&mut connection)
                    .await
                    .unwrap();
            assert_eq!(install_id, "install-1");
            let machine_id: String =
                sqlx::query_scalar("SELECT machine_id FROM station_device_recovery")
                    .fetch_one(&mut connection)
                    .await
                    .unwrap();
            assert_eq!(machine_id, "machine-1");
            // The AUTOINCREMENT counter continues, so batch ids never repeat.
            let id: i64 =
                sqlx::query_scalar("INSERT INTO outbox(payload) VALUES('scan-4') RETURNING id")
                    .fetch_one(&mut connection)
                    .await
                    .unwrap();
            assert_eq!(id, 4);
            connection.close().await.unwrap();
        });
    }

    /// Another computer over SMB looks like any other open handle.
    #[cfg(windows)]
    #[test]
    fn a_database_open_elsewhere_postpones_the_move() {
        use sqlx::sqlite::SqliteConnectOptions;
        use sqlx::{Connection, SqliteConnection};

        let dirs = fresh_dirs();
        fs::create_dir_all(&dirs.legacy).unwrap();
        fs::write(
            dirs.legacy.join(CONFIG_FILE),
            br#"{"machine_id":"machine-1"}"#,
        )
        .unwrap();
        let runtime = runtime();
        let connection = runtime.block_on(async {
            let options = SqliteConnectOptions::new()
                .filename(dirs.legacy.join(DATABASE_FILE))
                .create_if_missing(true);
            let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
            sqlx::query("CREATE TABLE facts(value TEXT)")
                .execute(&mut connection)
                .await
                .unwrap();
            connection
        });

        let storage = run(&dirs, local_profile()).unwrap();
        assert_eq!(storage.mode, StorageMode::Legacy);
        assert_eq!(storage.notices, vec![StorageNotice::LegacyInUse]);
        assert!(storage.dir.join(DATABASE_FILE).exists());
        assert!(files(&dirs.local).is_empty());
        runtime.block_on(connection.close()).unwrap();
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/station/src-tauri/Cargo.toml storage::resolve`
Expected: FAIL to compile (`cannot find function 'resolve'`, `cannot find type 'Step'`, `cannot find value 'LOCK_FILE'`).

- [ ] **Step 4: Implement the resolution**

Insert above the test module in `apps/station/src-tauri/src/storage/resolve.rs`:

```rust
use std::fs::{self, File};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::Duration;

use uuid::Uuid;

use super::copy::{self, CopyError};
use super::probe::ProfileFacts;
use super::record::{self, Origin, StorageRecord, RECORD_FILE};
use super::{StationStorage, StorageMode, StorageNotice, CONFIG_FILE, DATABASE_FILE};

const LOCK_FILE: &str = "station-storage.lock";
const CLAIM_ATTEMPTS: u32 = 3;
const CLAIM_RETRY_DELAY: Duration = Duration::from_millis(250);
const STAGING_PREFIX: &str = ".migration-";
/// SQLite companions of the database. A stale one next to a fresh copy would
/// be replayed as a hot journal, so an interrupted install removes them all.
const DATABASE_SIDECARS: [&str; 3] = ["-journal", "-wal", "-shm"];

/// Where tests step in. The hook runs just before the named operation: an
/// `Err` is treated as that operation failing, and a panic stands for the
/// process dying there. Production passes `&mut |_| Ok(())`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Writing the `claiming` record.
    Record,
    /// Renaming the roaming folder to its claimed name.
    Claim,
    /// Opening the claimed files without sharing.
    Hold,
    /// Comparing the copies with their sources.
    Verify,
    /// Renaming the verified copies into the local folder.
    Install,
    /// Writing the `committed` record.
    Commit,
    /// Removing the claimed folder.
    Cleanup,
}

type Hook<'a> = dyn FnMut(Step) -> Result<(), String> + 'a;

/// Decides where the station files live and, when needed, moves them from the
/// roaming folder (`legacy_dir`) to the machine-local one (`local_dir`)
/// exactly once. `Err` means the station must not start: data may exist that
/// this process cannot place, and minting a new identity would split it.
pub fn resolve(
    legacy_dir: &Path,
    local_dir: &Path,
    facts: ProfileFacts,
    hook: &mut Hook<'_>,
) -> Result<StationStorage, String> {
    if legacy_dir == local_dir {
        return Ok(local(local_dir, Vec::new()));
    }
    fs::create_dir_all(local_dir)
        .map_err(|error| format!("station storage folder unavailable: {error}"))?;
    let lock = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(local_dir.join(LOCK_FILE))
        .map_err(|error| format!("station storage lock unavailable: {error}"))?;
    // Two logon sessions of one user can each run a station instance. The
    // lock is released when `lock` drops, also when a panic unwinds.
    lock.lock()
        .map_err(|error| format!("station storage lock unavailable: {error}"))?;
    match record::read(local_dir)? {
        Some(StorageRecord::Committed {
            origin,
            pending_cleanup,
        }) => Ok(committed(
            legacy_dir,
            local_dir,
            origin,
            pending_cleanup,
            facts,
            hook,
        )),
        Some(StorageRecord::Claiming {
            legacy_dir: recorded,
            claim_dir,
        }) => resume(&recorded, &claim_dir, local_dir, facts, hook),
        None => decide(legacy_dir, local_dir, facts, hook),
    }
}

fn decide(
    legacy_dir: &Path,
    local_dir: &Path,
    facts: ProfileFacts,
    hook: &mut Hook<'_>,
) -> Result<StationStorage, String> {
    if let Some(reason) = facts.local_less_durable() {
        return Ok(legacy(
            legacy_dir,
            vec![StorageNotice::LocalLessDurable { reason }],
        ));
    }
    match (has_station_files(legacy_dir)?, has_station_files(local_dir)?) {
        (true, true) => {
            Err("station files exist in both the roaming and the local folder".to_string())
        }
        (true, false) => migrate(legacy_dir, local_dir, hook),
        (false, true) => Ok(commit_without_move(local_dir, Origin::Adopted)),
        (false, false) => {
            if unfinished_claim_exists(legacy_dir)? {
                return Err(
                    "an unfinished move of station files was found next to the roaming folder"
                        .to_string(),
                );
            }
            Ok(commit_without_move(local_dir, Origin::Fresh))
        }
    }
}

/// A failed record write is harmless here: without a record the next start
/// finds station files only in the local folder and adopts them, and a copy
/// that roams in meanwhile is a conflict, never adopted.
fn commit_without_move(local_dir: &Path, origin: Origin) -> StationStorage {
    let _ = record::write(
        local_dir,
        &StorageRecord::Committed {
            origin,
            pending_cleanup: None,
        },
    );
    local(local_dir, Vec::new())
}

fn migrate(
    legacy_dir: &Path,
    local_dir: &Path,
    hook: &mut Hook<'_>,
) -> Result<StationStorage, String> {
    let claim_dir = claim_path(legacy_dir);
    let intent = StorageRecord::Claiming {
        legacy_dir: legacy_dir.to_path_buf(),
        claim_dir: claim_dir.clone(),
    };
    let recorded = hook(Step::Record).and_then(|()| record::write(local_dir, &intent));
    // What is on disk decides, not what the write reported.
    if recorded.is_err() && record::read(local_dir)? != Some(intent) {
        return Ok(legacy(legacy_dir, vec![StorageNotice::MoveFailed]));
    }
    claim(legacy_dir, &claim_dir, local_dir, hook)
}

fn claim(
    legacy_dir: &Path,
    claim_dir: &Path,
    local_dir: &Path,
    hook: &mut Hook<'_>,
) -> Result<StationStorage, String> {
    if hook(Step::Claim)
        .and_then(|()| rename_with_retries(legacy_dir, claim_dir))
        .is_err()
    {
        // Another computer holds the database over SMB, or a scanner holds a
        // file. Withdraw the intent: nothing moved, and the next start retries.
        let _ = record::remove(local_dir);
        return Ok(legacy(legacy_dir, vec![StorageNotice::LegacyInUse]));
    }
    move_claimed(claim_dir, local_dir, hook)
}

fn rename_with_retries(from: &Path, to: &Path) -> Result<(), String> {
    let mut attempt = 1;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) if attempt >= CLAIM_ATTEMPTS => return Err(error.to_string()),
            Err(_) => {
                attempt += 1;
                sleep(CLAIM_RETRY_DELAY);
            }
        }
    }
}

/// Copy, verify, install, commit, clean up. Until the commit the claimed
/// folder stays authoritative: every failure runs the station from it, and
/// the next start comes back here.
fn move_claimed(
    claim_dir: &Path,
    local_dir: &Path,
    hook: &mut Hook<'_>,
) -> Result<StationStorage, String> {
    let staging = local_dir.join(format!("{STAGING_PREFIX}{}", Uuid::new_v4()));
    let copied = copy_into_local(claim_dir, local_dir, &staging, hook);
    let _ = fs::remove_dir_all(&staging);
    if let Err(error) = copied {
        let notice = match error {
            CopyError::InUse => StorageNotice::LegacyInUse,
            CopyError::Failed(reason) => {
                eprintln!("station: moving the station files failed: {reason}");
                StorageNotice::MoveFailed
            }
        };
        return Ok(legacy(claim_dir, vec![notice]));
    }
    let done = StorageRecord::Committed {
        origin: Origin::Migrated,
        pending_cleanup: Some(claim_dir.to_path_buf()),
    };
    let committed = hook(Step::Commit).and_then(|()| record::write(local_dir, &done));
    if committed.is_err() && record::read(local_dir)? != Some(done) {
        return Ok(legacy(claim_dir, vec![StorageNotice::MoveFailed]));
    }
    Ok(clean_up(local_dir, Origin::Migrated, claim_dir, hook))
}

fn copy_into_local(
    claim_dir: &Path,
    local_dir: &Path,
    staging: &Path,
    hook: &mut Hook<'_>,
) -> Result<(), CopyError> {
    let mut names = copy::store_files(claim_dir)?;
    names.retain(|name| name.as_os_str() != RECORD_FILE && name.as_os_str() != LOCK_FILE);
    // The record proves the local folder held no station files before the
    // claim, so anything named like one is a leftover of an earlier attempt.
    let database_sidecars = DATABASE_SIDECARS.map(|suffix| format!("{DATABASE_FILE}{suffix}"));
    let fixed = [CONFIG_FILE, DATABASE_FILE]
        .into_iter()
        .chain(database_sidecars.iter().map(String::as_str));
    for name in fixed
        .map(std::ffi::OsStr::new)
        .chain(names.iter().map(|name| name.as_os_str()))
    {
        match fs::remove_file(local_dir.join(name)) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    hook(Step::Hold).map_err(|_| CopyError::InUse)?;
    let mut held = copy::hold(claim_dir, &names)?;
    held.copy_to(staging)?;
    hook(Step::Verify).map_err(CopyError::Failed)?;
    held.verify(staging)?;
    drop(held);
    hook(Step::Install).map_err(CopyError::Failed)?;
    for name in &names {
        fs::rename(staging.join(name), local_dir.join(name))?;
    }
    Ok(())
}

fn clean_up(
    local_dir: &Path,
    origin: Origin,
    claim_dir: &Path,
    hook: &mut Hook<'_>,
) -> StationStorage {
    let removed = hook(Step::Cleanup).is_ok() && remove_claimed(claim_dir).is_ok();
    if !removed {
        return local(local_dir, vec![StorageNotice::ClaimLeftovers]);
    }
    let _ = record::write(
        local_dir,
        &StorageRecord::Committed {
            origin,
            pending_cleanup: None,
        },
    );
    local(local_dir, Vec::new())
}

/// Removes every top-level file of the claimed folder (all of them were
/// verified in the local folder, or are transient), then the folder itself. A
/// subfolder nobody expected stays and is reported.
fn remove_claimed(claim_dir: &Path) -> Result<(), String> {
    let entries = match fs::read_dir(claim_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_type().map_err(|error| error.to_string())?.is_file() {
            fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
        }
    }
    fs::remove_dir(claim_dir).map_err(|error| error.to_string())
}

fn committed(
    legacy_dir: &Path,
    local_dir: &Path,
    origin: Origin,
    pending_cleanup: Option<PathBuf>,
    facts: ProfileFacts,
    hook: &mut Hook<'_>,
) -> StationStorage {
    let mut storage = match pending_cleanup {
        Some(claim_dir) => clean_up(local_dir, origin, &claim_dir, hook),
        None => local(local_dir, Vec::new()),
    };
    // Already moved: report a profile that now wipes local data, but stay.
    if let Some(reason) = facts.local_less_durable() {
        storage
            .notices
            .push(StorageNotice::LocalLessDurable { reason });
    }
    if let Some(same_machine_id) = roamed_copy(legacy_dir, local_dir) {
        storage
            .notices
            .push(StorageNotice::RoamedCopyPresent { same_machine_id });
    }
    storage
}

/// Station files in the roaming folder after the move are never loaded. When
/// they carry this station's own machine id, a copy of this station may be
/// running elsewhere. Errors (an unreachable redirected folder) count as
/// "nothing there": they must not stop a station whose data is local.
fn roamed_copy(legacy_dir: &Path, local_dir: &Path) -> Option<bool> {
    if !has_station_files(legacy_dir).unwrap_or(false) {
        return None;
    }
    let theirs = machine_id(&legacy_dir.join(CONFIG_FILE));
    Some(theirs.is_some() && theirs == machine_id(&local_dir.join(CONFIG_FILE)))
}

fn machine_id(path: &Path) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Identity {
        machine_id: String,
    }
    let data = fs::read(path).ok()?;
    serde_json::from_slice::<Identity>(&data)
        .ok()
        .map(|identity| identity.machine_id)
}

fn resume(
    legacy_dir: &Path,
    claim_dir: &Path,
    local_dir: &Path,
    facts: ProfileFacts,
    hook: &mut Hook<'_>,
) -> Result<StationStorage, String> {
    let guard = facts.local_less_durable();
    if claim_dir
        .try_exists()
        .map_err(|error| format!("cannot inspect {}: {error}", claim_dir.display()))?
    {
        if !has_station_files(claim_dir)? {
            return Err("the claimed folder of an unfinished move holds no station files".into());
        }
        if let Some(reason) = guard {
            return Ok(legacy(
                claim_dir,
                vec![StorageNotice::LocalLessDurable { reason }],
            ));
        }
        remove_stale_staging(local_dir);
        return move_claimed(claim_dir, local_dir, hook);
    }
    if has_station_files(legacy_dir)? {
        // The intent was recorded, but the rename never happened.
        if let Some(reason) = guard {
            let _ = record::remove(local_dir);
            return Ok(legacy(
                legacy_dir,
                vec![StorageNotice::LocalLessDurable { reason }],
            ));
        }
        return claim(legacy_dir, claim_dir, local_dir, hook);
    }
    Err("station files named by an unfinished move are missing".to_string())
}

fn remove_stale_staging(local_dir: &Path) {
    let Ok(entries) = fs::read_dir(local_dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(STAGING_PREFIX)
        {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

fn has_station_files(dir: &Path) -> Result<bool, String> {
    for name in [CONFIG_FILE, DATABASE_FILE] {
        if dir
            .join(name)
            .try_exists()
            .map_err(|error| format!("cannot inspect {}: {error}", dir.display()))?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// A claimed folder with station files but no record here: this machine's
/// record may have been lost, so the files cannot be declared someone else's.
fn unfinished_claim_exists(legacy_dir: &Path) -> Result<bool, String> {
    let (Some(parent), Some(name)) = (legacy_dir.parent(), legacy_dir.file_name()) else {
        return Ok(false);
    };
    let prefix = format!("{}.migrating-", name.to_string_lossy());
    let entries = match fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("cannot inspect {}: {error}", parent.display())),
    };
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_name().to_string_lossy().starts_with(&prefix)
            && has_station_files(&entry.path())?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn claim_path(legacy_dir: &Path) -> PathBuf {
    let name = legacy_dir
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    legacy_dir.with_file_name(format!("{name}.migrating-{}", Uuid::new_v4()))
}

fn local(dir: &Path, notices: Vec<StorageNotice>) -> StationStorage {
    StationStorage {
        dir: dir.to_path_buf(),
        mode: StorageMode::Local,
        notices,
    }
}

fn legacy(dir: &Path, notices: Vec<StorageNotice>) -> StationStorage {
    StationStorage {
        dir: dir.to_path_buf(),
        mode: StorageMode::Legacy,
        notices,
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test --manifest-path apps/station/src-tauri/Cargo.toml storage::`
Expected: PASS, 25 storage tests on macOS/Linux (14 in `storage::resolve`). The crash test prints seven `simulated crash at ...` panic messages; that output is expected.

- [ ] **Step 6: Commit**

```bash
git add apps/station/src-tauri/src/storage/mod.rs apps/station/src-tauri/src/storage/resolve.rs
git commit -m "feat(station): однократный перенос хранилища станции из перемещаемого профиля" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Wire storage into the Tauri shell

**Files:**

- Modify: `apps/station/src-tauri/src/commands.rs:7-37` (config commands) and its `mod tests`
- Modify: `apps/station/src-tauri/src/grant_transaction.rs:1-6, 114-132`
- Modify: `apps/station/src-tauri/src/lib.rs` (setup and handler list)

**Interfaces:**

- Consumes: `storage::{storage_gate, resolve, profile_facts, database_url, StationStorage, StorageGate}`.
- Produces:
  - Tauri commands `read_config`, `write_config` and `clear_credential`. They keep the same names and arguments, are now async, and wait for the gate.
  - A new command `station_database_url() -> String` (a `sqlite:` URL).
  - A new command `station_storage_status() -> StationStorage`, serialized as in Task 1.
  - `grant_atomic_execute` keeps its `{ statements }` argument.

- [ ] **Step 1: Write the failing command tests**

In `apps/station/src-tauri/src/commands.rs`, append inside the existing `#[cfg(test)] mod tests { ... }`, before its closing brace:

```rust
    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime")
    }

    fn temp_dir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("markiro-station-commands-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn config_commands_use_the_resolved_folder() {
        runtime().block_on(async {
            let dir = temp_dir();
            let (sender, gate) = storage::storage_gate();
            sender.resolve(Ok(StationStorage {
                dir: dir.clone(),
                mode: crate::storage::StorageMode::Local,
                notices: Vec::new(),
            }));
            let mut cfg = read_config_in(&gate).await.unwrap();
            assert!(dir.join("station.json").exists());
            cfg.api_key = Some("credential-placeholder".into());
            cfg.server_url = Some("https://api.example".into());
            write_config_in(&gate, &cfg).await.unwrap();
            clear_credential_in(&gate).await.unwrap();
            assert_eq!(read_config_in(&gate).await.unwrap().api_key, None);
            assert_eq!(
                database_url_in(&gate).await.unwrap(),
                storage::database_url(&dir.join("station-mirror.db"))
            );
        });
    }

    #[test]
    fn a_blocked_gate_refuses_every_command_and_mints_nothing() {
        runtime().block_on(async {
            let (sender, gate) = storage::storage_gate();
            sender.resolve(Err("blocked".into()));
            assert_eq!(read_config_in(&gate).await, Err("blocked".to_string()));
            assert!(clear_credential_in(&gate).await.is_err());
            assert!(database_url_in(&gate).await.is_err());
            let cfg = StationConfig {
                machine_id: "machine-1".into(),
                tenant_id: None,
                device_id: None,
                device_name: None,
                organization_name: None,
                line_id: None,
                line_name: None,
                api_key: None,
                server_url: Some("ftp://nope".into()),
            };
            // URL validation still runs first, as before.
            assert!(write_config_in(&gate, &cfg)
                .await
                .unwrap_err()
                .contains("scheme"));
        });
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/station/src-tauri/Cargo.toml commands::`
Expected: FAIL to compile (`cannot find function 'read_config_in'`).

- [ ] **Step 3: Replace the config commands**

In `apps/station/src-tauri/src/commands.rs`, replace everything from `use tauri::{AppHandle, Manager};` down to the end of `pub fn clear_credential(...) { ... }` (lines 7-37) with the block below. The file's existing `use tauri::State;` (line 41) already imports `State`; do not add a second import.

```rust
use tauri::{AppHandle, Manager};

use crate::config::{self, StationConfig};
use crate::storage::{self, StationStorage, StorageGate};

/// Reads `station.json` from the resolved storage folder, minting a stable
/// machine id on first run. Waits until storage is resolved; a blocked
/// resolution is an error and never mints a new identity.
#[tauri::command]
pub async fn read_config(gate: State<'_, StorageGate>) -> Result<StationConfig, String> {
    read_config_in(gate.inner()).await
}

/// Persists the station config (mode 0600 on unix). `server_url`, when set,
/// is validated as http(s) with no userinfo before the write is attempted.
#[tauri::command]
pub async fn write_config(gate: State<'_, StorageGate>, cfg: StationConfig) -> Result<(), String> {
    write_config_in(gate.inner(), &cfg).await
}

/// Clears only the rejected station credential and reproducible display
/// metadata. `machine_id` and `device_id` stay durable for a same-record
/// recovery pairing; local production facts live in SQLite and are untouched.
#[tauri::command]
pub async fn clear_credential(gate: State<'_, StorageGate>) -> Result<(), String> {
    clear_credential_in(gate.inner()).await
}

/// The `sqlite:` URL `src/lib/sqlite.ts` opens. Never the plugin's relative
/// form, which resolves against the roaming app-config folder.
#[tauri::command]
pub async fn station_database_url(gate: State<'_, StorageGate>) -> Result<String, String> {
    database_url_in(gate.inner()).await
}

/// Storage folder, mode and notices for the Update screen.
#[tauri::command]
pub async fn station_storage_status(
    gate: State<'_, StorageGate>,
) -> Result<StationStorage, String> {
    gate.ready().await
}

async fn read_config_in(gate: &StorageGate) -> Result<StationConfig, String> {
    config::read_config(&gate.ready().await?.dir)
}

async fn write_config_in(gate: &StorageGate, cfg: &StationConfig) -> Result<(), String> {
    if let Some(url) = &cfg.server_url {
        config::validate_http_url(url)?;
    }
    config::write_config(&gate.ready().await?.dir, cfg)
}

async fn clear_credential_in(gate: &StorageGate) -> Result<(), String> {
    config::clear_credential(&gate.ready().await?.dir)
}

async fn database_url_in(gate: &StorageGate) -> Result<String, String> {
    Ok(storage::database_url(&gate.ready().await?.database_path()))
}
```

- [ ] **Step 4: Make `grant_atomic_execute` use the gate**

In `apps/station/src-tauri/src/grant_transaction.rs`, replace the header:

```rust
use serde::Deserialize;
use serde_json::Value;
use sqlx::{sqlite::SqliteConnectOptions, Connection, Executor, SqliteConnection};
use tauri::Manager;

const DATABASE_NAME: &str = "station-mirror.db";
const MAX_STATEMENTS: usize = 32;
```

with:

```rust
use serde::Deserialize;
use serde_json::Value;
use sqlx::{sqlite::SqliteConnectOptions, Connection, Executor, SqliteConnection};

use crate::storage::StorageGate;

const MAX_STATEMENTS: usize = 32;
```

and replace the command:

```rust
#[tauri::command]
pub async fn grant_atomic_execute(
    app: tauri::AppHandle,
    statements: Vec<AtomicStatement>,
) -> Result<Vec<u64>, String> {
    validate(&statements)?;
    let path = app
        .path()
        .app_config_dir()
        .map_err(|_| "station database directory unavailable".to_string())?
        .join(DATABASE_NAME);
```

with:

```rust
#[tauri::command]
pub async fn grant_atomic_execute(
    gate: tauri::State<'_, StorageGate>,
    statements: Vec<AtomicStatement>,
) -> Result<Vec<u64>, String> {
    validate(&statements)?;
    let path = gate
        .ready()
        .await
        .map_err(|_| "station database directory unavailable".to_string())?
        .database_path();
```

Leave the rest of the function (`SqliteConnectOptions::new().filename(path)...`) unchanged.

- [ ] **Step 5: Resolve storage in `setup` and register the commands**

In `apps/station/src-tauri/src/lib.rs`, replace:

```rust
        .setup(|app| {
            app.manage(scanner::manager(app.handle().clone()));
```

with:

```rust
        .setup(|app| {
            app.manage(scanner::manager(app.handle().clone()));
            start_storage_resolution(app)?;
```

In the `tauri::generate_handler![...]` list, replace `commands::clear_credential,` with:

```rust
            commands::clear_credential,
            commands::station_database_url,
            commands::station_storage_status,
```

and append at the end of the file:

```rust
/// Resolves where `station.json` and `station-mirror.db` live, on a background
/// thread: `setup` runs on the UI thread after the main window exists, and the
/// one-time move copies the database. Storage commands wait on the gate.
fn start_storage_resolution(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let (resolved, gate) = storage::storage_gate();
    app.manage(gate);
    let legacy_dir = app.path().app_config_dir()?;
    let local_dir = app.path().app_local_data_dir()?;
    std::thread::Builder::new()
        .name("station-storage".into())
        .spawn(move || {
            let resolution = storage::resolve(
                &legacy_dir,
                &local_dir,
                storage::profile_facts(),
                &mut |_| Ok(()),
            );
            match &resolution {
                Ok(storage) if !storage.notices.is_empty() => eprintln!(
                    "station: storage {:?} in {} with notices {:?}",
                    storage.mode,
                    storage.dir.display(),
                    storage.notices
                ),
                Ok(_) => {}
                Err(reason) => eprintln!("station: storage blocked: {reason}"),
            }
            resolved.resolve(resolution);
        })?;
    Ok(())
}
```

- [ ] **Step 6: Run the whole crate to verify**

Run:

```bash
cargo build --manifest-path apps/station/src-tauri/Cargo.toml
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
```

Expected:

- the build succeeds with no `dead_code` warnings from `src/storage/`;
- all tests pass, including `commands::tests::config_commands_use_the_resolved_folder` and `commands::tests::a_blocked_gate_refuses_every_command_and_mints_nothing`;
- `git grep -n "app_config_dir" apps/station/src-tauri/src` shows only `lib.rs` (the legacy folder passed to `resolve`) and the module comment in `storage/mod.rs`.

- [ ] **Step 7: Commit**

```bash
git add apps/station/src-tauri/src/commands.rs apps/station/src-tauri/src/grant_transaction.rs apps/station/src-tauri/src/lib.rs
git commit -m "feat(station): команды станции берут хранилище из %LOCALAPPDATA% через перенос" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The webview opens SQLite through the resolved URL

**Files:**

- Modify: `apps/station/src/lib/sqlite.ts:5-11`
- Create: `apps/station/test/sqlite-database-url.test.ts`
- Create: `apps/station/test/app-storage-blocked.test.tsx`

**Interfaces:**

- Consumes: Tauri command `station_database_url` (Task 6).
- Produces: `tauriExecutor` unchanged in shape. The first use calls `invoke("station_database_url")` once and then `Database.load(url)` once.

- [ ] **Step 1: Write the failing executor test**

Create `apps/station/test/sqlite-database-url.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, loadMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  loadMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: loadMock } }));

beforeEach(() => {
  // `sqlite.ts` caches the open database for the process; every test needs a
  // fresh module instance.
  vi.resetModules();
  invokeMock.mockReset();
  loadMock.mockReset();
});

describe("tauriExecutor", () => {
  it("opens the database at the URL the Rust side resolved, once", async () => {
    const url = "sqlite:C:\\Users\\op\\AppData\\Local\\app.markiro.station\\station-mirror.db";
    invokeMock.mockImplementation(async (command: string) =>
      command === "station_database_url" ? url : undefined,
    );
    const database = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn().mockResolvedValue([]),
    };
    loadMock.mockResolvedValue(database);
    const { tauriExecutor } = await import("../src/lib/sqlite.js");

    await tauriExecutor.run("SELECT 1");
    await tauriExecutor.all("SELECT 2");

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("station_database_url");
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(loadMock).toHaveBeenCalledWith(url);
    expect(database.execute).toHaveBeenCalledWith("SELECT 1", []);
    expect(database.select).toHaveBeenCalledWith("SELECT 2", []);
  });

  it("never falls back to the relative URL the plugin resolves in the roaming folder", async () => {
    invokeMock.mockRejectedValue(new Error("station storage was not resolved"));
    const { tauriExecutor } = await import("../src/lib/sqlite.js");

    await expect(tauriExecutor.run("SELECT 1")).rejects.toThrow("station storage was not resolved");
    expect(loadMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @markiro/station exec vitest run test/sqlite-database-url.test.ts`
Expected: FAIL. `loadMock` is called with `"sqlite:station-mirror.db"`, and `invokeMock` is not called.

- [ ] **Step 3: Load through `station_database_url`**

In `apps/station/src/lib/sqlite.ts`, replace:

```ts
/** Opens (once) the on-device SQLite mirror DB via tauri-plugin-sql. */
function db(): Promise<Database> {
  if (!dbPromise) dbPromise = Database.load("sqlite:station-mirror.db");
  return dbPromise;
}
```

with:

```ts
/**
 * Opens (once) the on-device SQLite mirror DB via tauri-plugin-sql. The Rust
 * side says where it lives (`station_database_url`): the machine-local folder,
 * or the roaming one while the one-time move is postponed. Never the relative
 * `sqlite:station-mirror.db`, which the plugin resolves against the roaming
 * app-config folder.
 */
function db(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = invoke<string>("station_database_url").then((url) => Database.load(url));
  }
  return dbPromise;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @markiro/station exec vitest run test/sqlite-database-url.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the blocked-storage App test**

This lives in its own file because `sqlite.ts` caches the database promise per module graph, and `test/App.test.tsx` loads it once for the whole file. Create `apps/station/test/app-storage-blocked.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as HardwareModule from "../src/lib/hardware.js";
import type * as LockdownModule from "../src/lib/lockdown.js";

// Station files in both folders, or an unreadable move record, make
// `station_database_url` fail. The mocks below are the smallest set the
// first render of <App /> needs; test/App.test.tsx lines 16-148 are the
// full reference if another boundary turns out to be required.
const mocks = vi.hoisted(() => {
  const snapshot = {
    mode: "locked",
    pending: false,
    error: null,
  } as LockdownModule.LockdownSnapshot;
  return {
    invoke: vi.fn<(command: string, payload?: unknown) => Promise<unknown>>(async (command) => {
      if (command === "station_database_url") {
        throw new Error("station files exist in both the roaming and the local folder");
      }
      return undefined;
    }),
    load: vi.fn(),
    hardware: {
      listScannerPorts: vi.fn(async () => []),
      listUsbPrinters: vi.fn(async () => []),
      configureScanners: vi.fn(async () => {}),
      closeScanner: vi.fn(async () => {}),
      onScannerConnections: vi.fn(async () => () => {}),
      onScan: vi.fn(async () => () => {}),
      onScannerStatus: vi.fn(async () => () => {}),
      print: vi.fn(async () => {}),
    },
    lockdown: {
      start: () => () => {},
      enter: async () => {},
      exit: async () => {},
      subscribe: () => () => {},
      getSnapshot: () => snapshot,
      clearError: () => {},
      whenSettled: async () => {},
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class FakeChannel {
    onmessage: (payload: unknown) => void = () => undefined;
  },
  invoke: (command: string, payload?: unknown) => mocks.invoke(command, payload),
}));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: mocks.load } }));
vi.mock("../src/lib/lockdown.js", async (importOriginal) => ({
  ...(await importOriginal<typeof LockdownModule>()),
  createLockdownLifecycle: () => mocks.lockdown,
}));
vi.mock("../src/lib/hardware.js", async (importOriginal) => ({
  ...(await importOriginal<typeof HardwareModule>()),
  tauriHardware: mocks.hardware,
}));

import i18n from "../src/i18n/index.js";
import { App } from "../src/App.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("App with blocked station storage", () => {
  it("stops on the recovery screen and never reads or mints the config", async () => {
    render(<App />);

    expect(
      await screen.findByText(
        "Local work is sealed, but station recovery could not be completed. Retry or contact support.",
      ),
    ).toBeDefined();
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.map(([command]) => command)).not.toContain("read_config");
    expect(screen.queryByText("Connect station")).toBeNull();
  });
});
```

- [ ] **Step 6: Run it to verify it passes**

Run: `pnpm --filter @markiro/station exec vitest run test/app-storage-blocked.test.tsx`
Expected: PASS (1 test). If the render fails on another mount-time boundary, copy that boundary's mock from `test/App.test.tsx` (lines 16-148) into this file. Do not weaken the three assertions.

- [ ] **Step 7: Run the station suite and typecheck**

Run:

```bash
pnpm --filter @markiro/station test
pnpm --filter @markiro/station typecheck
```

Expected: both pass. `test/App.test.tsx` keeps passing because its `invokeMock` answers the new command with `undefined`, and its plugin-sql fake ignores the URL.

- [ ] **Step 8: Commit**

```bash
git add apps/station/src/lib/sqlite.ts apps/station/test/sqlite-database-url.test.ts apps/station/test/app-storage-blocked.test.tsx
git commit -m "feat(station): SQLite станции открывается по пути, который вернул Rust" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Station data on the Update screen and the pairing warning

**Files:**

- Create: `apps/station/src/lib/storage-status.ts`
- Create: `apps/station/test/storage-status.test.ts`
- Modify: `apps/station/src/i18n/en.json`, `apps/station/src/i18n/ru.json`
- Modify: `apps/station/src/pages/UpdateCenter.tsx`, `apps/station/test/update-center.test.tsx`
- Modify: `apps/station/src/pages/Enrollment.tsx`, `apps/station/test/enrollment.test.tsx`
- Modify: `apps/station/src/App.tsx`, `apps/station/src/station.css`

**Interfaces:**

- Consumes: Tauri command `station_storage_status` (Task 6), with this JSON shape:

  ```
  {
    dir,
    mode: "local" | "legacy",
    notices: [
      { kind: "legacy_in_use" | "move_failed" | "claim_leftovers" }
      | { kind: "local_less_durable", reason }
      | { kind: "roamed_copy_present", sameMachineId }
    ]
  }
  ```

- Produces:
  - `readStorageStatus(): Promise<StationStorageStatus | null>`. It never rejects.
  - `storageNoticeKey(notice): string` (an i18n key).
  - `storageNoticeTone(notice): "warn" | "info" | "error"`.
  - `pairingUnsafe(notices): boolean`.
  - An `UpdateCenter` prop `storageStatus?: StationStorageStatus | null`.
  - An `Enrollment` prop `storageNotices?: readonly StorageNotice[]`.

- [ ] **Step 1: Write the failing status tests**

Create `apps/station/test/storage-status.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import i18n from "../src/i18n/index.js";
import {
  pairingUnsafe,
  readStorageStatus,
  storageNoticeKey,
  storageNoticeTone,
  type StorageNotice,
} from "../src/lib/storage-status.js";

const everyNotice: StorageNotice[] = [
  { kind: "legacy_in_use" },
  { kind: "move_failed" },
  { kind: "local_less_durable", reason: "temporary_profile" },
  { kind: "local_less_durable", reason: "mandatory_profile" },
  { kind: "local_less_durable", reason: "delete_roaming_cache" },
  { kind: "roamed_copy_present", sameMachineId: true },
  { kind: "roamed_copy_present", sameMachineId: false },
  { kind: "claim_leftovers" },
];

beforeEach(() => {
  invokeMock.mockReset();
});

describe("readStorageStatus", () => {
  it("returns the status the Rust side reports", async () => {
    const status = {
      dir: "C:\\Users\\op\\AppData\\Local\\app.markiro.station",
      mode: "local",
      notices: everyNotice,
    };
    invokeMock.mockResolvedValue(status);

    await expect(readStorageStatus()).resolves.toEqual(status);
    expect(invokeMock).toHaveBeenCalledWith("station_storage_status");
  });

  it("hides diagnostics instead of failing on an error or an unknown shape", async () => {
    invokeMock.mockRejectedValueOnce(new Error("station files exist in both folders"));
    await expect(readStorageStatus()).resolves.toBeNull();

    for (const value of [
      undefined,
      null,
      {},
      { dir: "x", mode: "cloud", notices: [] },
      { dir: "x", mode: "local", notices: [{ kind: "new_kind" }] },
    ]) {
      invokeMock.mockResolvedValueOnce(value);
      await expect(readStorageStatus()).resolves.toBeNull();
    }
  });
});

describe("storage notices", () => {
  it("have copy in both languages", () => {
    for (const notice of everyNotice) {
      const key = storageNoticeKey(notice);
      for (const lng of ["ru", "en"]) {
        expect(i18n.exists(key, { lng }), `${key} (${lng})`).toBe(true);
      }
    }
    for (const key of [
      "storage.title",
      "storage.mode.local",
      "storage.mode.legacy",
      "storage.pairingUnsafe",
    ]) {
      for (const lng of ["ru", "en"]) {
        expect(i18n.exists(key, { lng }), `${key} (${lng})`).toBe(true);
      }
    }
  });

  it("flag a possible clone as an error and only sign-out-wiped profiles as unsafe for pairing", () => {
    expect(storageNoticeTone({ kind: "roamed_copy_present", sameMachineId: true })).toBe("error");
    expect(storageNoticeTone({ kind: "legacy_in_use" })).toBe("warn");
    expect(storageNoticeTone({ kind: "claim_leftovers" })).toBe("info");
    expect(pairingUnsafe([{ kind: "local_less_durable", reason: "temporary_profile" }])).toBe(true);
    expect(pairingUnsafe([{ kind: "local_less_durable", reason: "mandatory_profile" }])).toBe(true);
    expect(
      pairingUnsafe([
        { kind: "local_less_durable", reason: "delete_roaming_cache" },
        { kind: "legacy_in_use" },
      ]),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @markiro/station exec vitest run test/storage-status.test.ts`
Expected: FAIL (`Failed to resolve import "../src/lib/storage-status.js"`).

- [ ] **Step 3: Implement the status module**

Create `apps/station/src/lib/storage-status.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";

export type LessDurableReason = "temporary_profile" | "mandatory_profile" | "delete_roaming_cache";

/** Mirrors `StorageNotice` in src-tauri/src/storage/mod.rs. */
export type StorageNotice =
  | { kind: "legacy_in_use" }
  | { kind: "move_failed" }
  | { kind: "local_less_durable"; reason: LessDurableReason }
  | { kind: "roamed_copy_present"; sameMachineId: boolean }
  | { kind: "claim_leftovers" };

export interface StationStorageStatus {
  dir: string;
  mode: "local" | "legacy";
  notices: StorageNotice[];
}

const REASONS: readonly string[] = [
  "temporary_profile",
  "mandatory_profile",
  "delete_roaming_cache",
];

function isNotice(value: unknown): value is StorageNotice {
  if (typeof value !== "object" || value === null) return false;
  const notice = value as Record<string, unknown>;
  switch (notice.kind) {
    case "legacy_in_use":
    case "move_failed":
    case "claim_leftovers":
      return true;
    case "local_less_durable":
      return typeof notice.reason === "string" && REASONS.includes(notice.reason);
    case "roamed_copy_present":
      return typeof notice.sameMachineId === "boolean";
    default:
      return false;
  }
}

function isStatus(value: unknown): value is StationStorageStatus {
  if (typeof value !== "object" || value === null) return false;
  const status = value as Record<string, unknown>;
  return (
    typeof status.dir === "string" &&
    (status.mode === "local" || status.mode === "legacy") &&
    Array.isArray(status.notices) &&
    status.notices.every(isNotice)
  );
}

/**
 * Where the station files live and why, for diagnostics. Never rejects: a
 * blocked storage already stops startup through `readConfig`, and a missing
 * or unknown answer only hides the diagnostics.
 */
export async function readStorageStatus(): Promise<StationStorageStatus | null> {
  try {
    const status: unknown = await invoke("station_storage_status");
    return isStatus(status) ? status : null;
  } catch {
    return null;
  }
}

/** The i18n key under `storage.notices` for one notice. */
export function storageNoticeKey(notice: StorageNotice): string {
  switch (notice.kind) {
    case "local_less_durable":
      return `storage.notices.local_less_durable.${notice.reason}`;
    case "roamed_copy_present":
      return notice.sameMachineId
        ? "storage.notices.roamed_copy_present.sameMachine"
        : "storage.notices.roamed_copy_present.otherMachine";
    default:
      return `storage.notices.${notice.kind}`;
  }
}

/** A copy of this station elsewhere risks duplicate SSCCs: an error. */
export function storageNoticeTone(notice: StorageNotice): "warn" | "info" | "error" {
  switch (notice.kind) {
    case "roamed_copy_present":
      return notice.sameMachineId ? "error" : "warn";
    case "claim_leftovers":
      return "info";
    case "legacy_in_use":
    case "move_failed":
    case "local_less_durable":
      return "warn";
  }
}

/** Temporary and mandatory profiles lose the pairing and data at sign-out. */
export function pairingUnsafe(notices: readonly StorageNotice[]): boolean {
  return notices.some(
    (notice) =>
      notice.kind === "local_less_durable" &&
      (notice.reason === "temporary_profile" || notice.reason === "mandatory_profile"),
  );
}
```

- [ ] **Step 4: Add the copy in both languages**

In `apps/station/src/i18n/en.json`, replace the end of the file:

```json
    "waitingHint": "The old device may work offline until {{time}}. Stay connected: work will unlock when the server confirms the safe handover."
  }
}
```

with:

```json
    "waitingHint": "The old device may work offline until {{time}}. Stay connected: work will unlock when the server confirms the safe handover."
  },
  "storage": {
    "title": "Station data",
    "mode": {
      "local": "Stored on this computer:",
      "legacy": "Stored in the roaming Windows profile:"
    },
    "notices": {
      "legacy_in_use": "Station data is open on another computer under the same Windows account. The move to the local folder is postponed. Contact your administrator.",
      "move_failed": "Station data could not be moved to the local folder. The station works as before and retries the move at the next start.",
      "local_less_durable": {
        "temporary_profile": "Windows loaded a temporary profile: station data will be deleted at sign-out. Do not pair this station; sign out and contact your administrator.",
        "mandatory_profile": "A mandatory Windows profile does not keep data after sign-out. Run the station under a local account.",
        "delete_roaming_cache": "A Windows policy deletes the local profile copy at sign-out, so station data stays in the roaming profile. Run the station under a local account."
      },
      "roamed_copy_present": {
        "sameMachine": "This station's data reappeared in the roaming profile: a copy of it may be running on another computer. Contact support.",
        "otherMachine": "Another station's data was found in the roaming profile. This station does not use it. Tell your administrator."
      },
      "claim_leftovers": "The old station data folder was not removed completely. Work is not affected; tell your administrator."
    },
    "pairingUnsafe": "Windows loaded a temporary or mandatory profile: after sign-out the station would lose its pairing and data. Do not pair it on this profile; contact your administrator."
  }
}
```

In `apps/station/src/i18n/ru.json`, replace the end of the file:

```json
    "waitingHint": "Старое устройство может работать автономно до {{time}}. Оставьте подключение к серверу: работа станет доступна после подтверждения безопасного перехода."
  }
}
```

with:

```json
    "waitingHint": "Старое устройство может работать автономно до {{time}}. Оставьте подключение к серверу: работа станет доступна после подтверждения безопасного перехода."
  },
  "storage": {
    "title": "Данные станции",
    "mode": {
      "local": "Хранятся на этом компьютере:",
      "legacy": "Хранятся в перемещаемом профиле Windows:"
    },
    "notices": {
      "legacy_in_use": "Данные станции открыты на другом компьютере под этой же учётной записью Windows. Перенос в локальную папку отложен. Обратитесь к администратору.",
      "move_failed": "Не удалось перенести данные станции в локальную папку. Станция работает как раньше и повторит перенос при следующем запуске.",
      "local_less_durable": {
        "temporary_profile": "Windows загрузил временный профиль: данные станции будут удалены при выходе. Не привязывайте станцию — выйдите из Windows и обратитесь к администратору.",
        "mandatory_profile": "Обязательный профиль Windows не сохраняет данные после выхода. Запускайте станцию под локальной учётной записью.",
        "delete_roaming_cache": "Политика Windows удаляет локальную копию профиля при выходе, поэтому данные станции остаются в перемещаемом профиле. Запускайте станцию под локальной учётной записью."
      },
      "roamed_copy_present": {
        "sameMachine": "В перемещаемом профиле снова появились данные этой станции: её копия может работать на другом компьютере. Обратитесь в поддержку.",
        "otherMachine": "В перемещаемом профиле найдены данные другой станции. Эта станция их не использует. Сообщите администратору."
      },
      "claim_leftovers": "Старая папка данных станции удалена не полностью. Работе это не мешает; сообщите администратору."
    },
    "pairingUnsafe": "Windows загрузил временный или обязательный профиль: после выхода станция потеряет привязку и данные. Не привязывайте станцию на этом профиле — обратитесь к администратору."
  }
}
```

- [ ] **Step 5: Run the status and i18n tests to verify they pass**

Run: `pnpm --filter @markiro/station exec vitest run test/storage-status.test.ts test/i18n.test.tsx`
Expected: PASS. The key-parity test in `test/i18n.test.tsx` stays green.

- [ ] **Step 6: Write the failing UI tests**

In `apps/station/test/update-center.test.tsx`, add inside `describe("UpdateCenter", ...)`:

```tsx
it("shows where station data lives and every storage notice", () => {
  render(
    <UpdateCenter
      controller={controllerFixture()}
      activeShift={false}
      pendingOutbox={0}
      onBack={() => {}}
      storageStatus={{
        dir: "C:\\Users\\op\\AppData\\Roaming\\app.markiro.station",
        mode: "legacy",
        notices: [{ kind: "legacy_in_use" }, { kind: "roamed_copy_present", sameMachineId: true }],
      }}
    />,
  );

  expect(screen.getByText("Station data")).toBeDefined();
  expect(screen.getByText("Stored in the roaming Windows profile:")).toBeDefined();
  expect(screen.getByText("C:\\Users\\op\\AppData\\Roaming\\app.markiro.station")).toBeDefined();
  expect(
    screen.getByText(
      "Station data is open on another computer under the same Windows account. The move to the local folder is postponed. Contact your administrator.",
    ),
  ).toBeDefined();
  expect(
    screen.getByText(
      "This station's data reappeared in the roaming profile: a copy of it may be running on another computer. Contact support.",
    ),
  ).toBeDefined();
});

it("leaves the station data section out until its status is known", () => {
  render(
    <UpdateCenter
      controller={controllerFixture()}
      activeShift={false}
      pendingOutbox={0}
      onBack={() => {}}
    />,
  );

  expect(screen.queryByText("Station data")).toBeNull();
});
```

In `apps/station/test/enrollment.test.tsx`, add inside `describe("Enrollment", ...)`:

```tsx
it("warns against pairing on a profile that Windows discards at sign-out", () => {
  const warning =
    "Windows loaded a temporary or mandatory profile: after sign-out the station would lose its pairing and data. Do not pair it on this profile; contact your administrator.";
  const { rerender } = render(
    <Enrollment
      machineId="machine-1"
      onEnrolled={() => {}}
      pairingServerUrl="https://api.factory.example"
      storageNotices={[{ kind: "local_less_durable", reason: "temporary_profile" }]}
    />,
  );
  expect(screen.getByText(warning)).toBeDefined();

  rerender(
    <Enrollment
      machineId="machine-1"
      onEnrolled={() => {}}
      pairingServerUrl="https://api.factory.example"
      storageNotices={[{ kind: "local_less_durable", reason: "delete_roaming_cache" }]}
    />,
  );
  expect(screen.queryByText(warning)).toBeNull();
});
```

- [ ] **Step 7: Run them to verify they fail**

Run: `pnpm --filter @markiro/station exec vitest run test/update-center.test.tsx test/enrollment.test.tsx`
Expected: FAIL. The new tests cannot find "Station data" or the warning text, and TypeScript reports unknown props in the editor.

- [ ] **Step 8: Render the storage section on the Update screen**

In `apps/station/src/pages/UpdateCenter.tsx`:

After `import type { StationUpdaterController } from "../lib/use-station-updater.js";` add:

```tsx
import {
  storageNoticeKey,
  storageNoticeTone,
  type StationStorageStatus,
} from "../lib/storage-status.js";
```

Replace:

```tsx
  onBack: () => void;
  readInstalledVersion?: () => Promise<string>;
}
```

with:

```tsx
  onBack: () => void;
  readInstalledVersion?: () => Promise<string>;
  /** From `station_storage_status`; the section is hidden until it is known. */
  storageStatus?: StationStorageStatus | null;
}
```

Replace:

```tsx
  readInstalledVersion = getVersion,
}: UpdateCenterProps) {
  const { t } = useTranslation();
  const sourceTitleId = useId();
```

with:

```tsx
  readInstalledVersion = getVersion,
  storageStatus = null,
}: UpdateCenterProps) {
  const { t } = useTranslation();
  const sourceTitleId = useId();
  const storageTitleId = useId();
```

Replace:

```
        {activeShift ? <Alert tone="warn">{t("updates.activeShift")}</Alert> : null}
```

with:

```
        {storageStatus ? (
          <section
            className="station-update-center__source station-update-center__storage"
            aria-labelledby={storageTitleId}
          >
            <p id={storageTitleId} className="station-update-center__source-label">
              {t("storage.title")}
            </p>
            <p className="station-update-center__storage-folder">
              <span>{t(`storage.mode.${storageStatus.mode}`)}</span>{" "}
              <code>{storageStatus.dir}</code>
            </p>
            {storageStatus.notices.map((notice) => (
              <Alert key={storageNoticeKey(notice)} tone={storageNoticeTone(notice)}>
                {t(storageNoticeKey(notice))}
              </Alert>
            ))}
          </section>
        ) : null}
        {activeShift ? <Alert tone="warn">{t("updates.activeShift")}</Alert> : null}
```

In `apps/station/src/station.css`, after the `.station-update-center__source-note { ... }` rule, add:

```css
.station-update-center__storage-folder {
  margin: 0;
  color: var(--fg-2);
  font: var(--floor-body);
  overflow-wrap: anywhere;
}
```

- [ ] **Step 9: Show the pairing warning**

In `apps/station/src/pages/Enrollment.tsx`:

Add to the imports:

```tsx
import { pairingUnsafe, type StorageNotice } from "../lib/storage-status.js";
```

In `EnrollmentProps`, replace:

```tsx
  /** Serializes credential/config persistence with any identity migration. */
  runConfigTransition?: (transition: () => Promise<void>) => Promise<void>;
}
```

with:

```tsx
  /** Serializes credential/config persistence with any identity migration. */
  runConfigTransition?: (transition: () => Promise<void>) => Promise<void>;
  /** From `station_storage_status`: a temporary or mandatory Windows profile
   * would lose the pairing and every local fact at sign-out. */
  storageNotices?: readonly StorageNotice[];
}
```

In the destructuring, replace:

```tsx
  runConfigTransition = directConfigTransition,
}: EnrollmentProps) {
```

with:

```tsx
  runConfigTransition = directConfigTransition,
  storageNotices,
}: EnrollmentProps) {
```

and replace:

```
        {sealedWork ? (
          <Alert tone="warn">
            <RecoveryWorkSummary summary={sealedWork} />
          </Alert>
        ) : null}
        {status}
```

with:

```
        {sealedWork ? (
          <Alert tone="warn">
            <RecoveryWorkSummary summary={sealedWork} />
          </Alert>
        ) : null}
        {storageNotices && pairingUnsafe(storageNotices) ? (
          <Alert tone="warn">{t("storage.pairingUnsafe")}</Alert>
        ) : null}
        {status}
```

- [ ] **Step 10: Feed both screens from App**

In `apps/station/src/App.tsx`:

After `import { RecoveryWorkSummary } from "./ui/RecoveryWorkSummary.js";` add:

```tsx
import { readStorageStatus, type StationStorageStatus } from "./lib/storage-status.js";
```

After `const [savedWork, setSavedWork] = useState<SealedWorkSummary | undefined>();` add:

```
  const [storageStatus, setStorageStatus] = useState<StationStorageStatus | null>(null);
```

Immediately before the startup effect that begins with `useEffect(() => {` followed by the comment `// Applied once on startup, before the mirror is read by OperatorLogin`, add:

```
  // Diagnostics only: `readStorageStatus` never rejects, and a blocked
  // storage already stops startup through `readConfig`.
  useEffect(() => {
    let cancelled = false;
    void readStorageStatus().then((status) => {
      if (!cancelled) setStorageStatus(status);
    });
    return () => {
      cancelled = true;
    };
  }, []);

```

In the `<UpdateCenter ... />` element, replace `pendingOutbox={syncState.pending}` with:

```tsx
          pendingOutbox={syncState.pending}
          storageStatus={storageStatus}
```

`App.tsx` renders `<Enrollment>` twice: once for credential-recovery re-pairing (around line 1463, inside `if (credentialRecovery)`) and once for first pairing (around line 1580). Both need the warning. A recovery re-pair on a temporary profile is the more dangerous case, because it replaces the real device key. In each element, directly after its `pairingServerUrl={pairingServerUrl(config, configuredStationApiUrl())}` line, add at that element's indentation:

```
{...(storageStatus ? { storageNotices: storageStatus.notices } : {})}
```

Afterwards `grep -c "storageNotices: storageStatus.notices" apps/station/src/App.tsx` must print `2`.

- [ ] **Step 11: Run the UI tests and the suite to verify they pass**

Run:

```bash
pnpm --filter @markiro/station exec vitest run test/update-center.test.tsx test/enrollment.test.tsx test/storage-status.test.ts test/screen-gallery.test.tsx
pnpm --filter @markiro/station test
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
```

Expected: all pass. The gallery renders `UpdateCenter` and `Enrollment` without the new props, so it is unaffected.

- [ ] **Step 12: Commit**

```bash
git add apps/station/src/lib/storage-status.ts apps/station/test/storage-status.test.ts apps/station/src/i18n/en.json apps/station/src/i18n/ru.json apps/station/src/pages/UpdateCenter.tsx apps/station/test/update-center.test.tsx apps/station/src/pages/Enrollment.tsx apps/station/test/enrollment.test.tsx apps/station/src/App.tsx apps/station/src/station.css
git commit -m "feat(station): данные станции в центре обновлений и предупреждение о временном профиле" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Compile the Windows-only Rust tests in PR CI

**Files:**

- Modify: `.github/workflows/ci.yml` (job `station-windows-build`)

**Interfaces:**

- Consumes: nothing new. `tools/ci/affected.mjs` already routes every `apps/station/` change to `station_windows_build`, so no classifier change is needed.

- [ ] **Step 1: Add the compile step**

In `.github/workflows/ci.yml`, job `station-windows-build`, replace:

```
      - name: Build station webview + workspace deps
        run: pnpm turbo build --filter '@markiro/station...'
      - name: Compile the Windows Tauri application
        run: pnpm --filter @markiro/station tauri build --debug --no-bundle
```

with:

```
      - name: Build station webview + workspace deps
        run: pnpm turbo build --filter '@markiro/station...'
      # `#[cfg(windows)]` tests (storage move, exclusive handles, profile
      # probe) must at least compile on Windows. They are not launched: on
      # Windows Server 2025 the Tauri test harness can fail before main() with
      # STATUS_ENTRYPOINT_NOT_FOUND (see station-stable-release.yml).
      - name: Compile station Rust tests for Windows
        run: cargo test --manifest-path apps/station/src-tauri/Cargo.toml --no-run
      - name: Compile the Windows Tauri application
        run: pnpm --filter @markiro/station tauri build --debug --no-bundle
```

Only the `station-windows-build` job in `ci.yml` changes. The job list stays the same, so `tools/ci/test/workflow.test.mjs` and `required-results.test.mjs` need no update.

- [ ] **Step 2: Verify the CI policy tests**

Run: `pnpm test:ci-policy`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(station): компилировать Windows-тесты Rust станции в PR" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Release contracts, runbooks and docs

**Files:**

- Modify: `docs/acceptance/station-dual-origin-release.md` (rows `BOOTSTRAP-PRESERVE-02`, `BETA-PRESERVE-02`, `PRESERVE-02`; rollback paragraph)
- Modify: `tools/station-release/test/docs.test.mjs:110, 333, 655`
- Modify: `docs/acceptance/station-stable-release.md:61`
- Modify: `docs/runbooks/station-beta-release.md:282-288`
- Modify: `docs/runbooks/station-stable-release.md:158-162, 239-240`
- Modify: `docs/operations/first-customer-inventory/README.md:85-101`, `docs/operations/first-customer-inventory/protocol-v1.md:215-216`
- Modify: `docs/architecture.md` (after the "Local DB" bullet)
- Modify: `apps/station/README.md:7-8` and add a section
- Modify: `docs/superpowers/specs/2026-09-27-station-local-storage-design.md` (implementation notes)

**Interfaces:** Documentation only. The dual-origin table is compared cell by cell with `expectedAcceptanceScenarios` in `docs.test.mjs`, so each row text must change in both files identically. Row texts contain neither `—` nor `|`.

- [ ] **Step 1: Change the contract test first**

In `tools/station-release/test/docs.test.mjs`, make three replacements.

Line 110, replace:

```js
    "the resolved Station SQLite path and `station-mirror.db` remain unchanged, readable, and contain the prior data",
```

with:

```js
    "`station-mirror.db` stays readable with the prior data at the resolved Station SQLite path, which a storage-move build relocates once from the roaming profile to the local app data folder",
```

Line 333, replace:

```js
    "the resolved Station SQLite path and `station-mirror.db` remain unchanged and readable after validation/candidate update",
```

with:

```js
    "`station-mirror.db` stays readable at the resolved Station SQLite path after validation/candidate update; a storage-move build relocates it once from the roaming profile to the local app data folder",
```

Line 655, replace:

```js
    "the resolved Station SQLite path and `station-mirror.db` remain unchanged and readable",
```

with:

```js
    "`station-mirror.db` stays readable at the resolved Station SQLite path; a storage-move build relocates it once from the roaming profile to the local app data folder",
```

- [ ] **Step 2: Run the contract to verify it fails**

Run: `pnpm test:station-release:contract`
Expected: FAIL. The `deepStrictEqual` diff in the dual-origin table names the three rows.

- [ ] **Step 3: Change the acceptance documents**

In `docs/acceptance/station-dual-origin-release.md`, replace the three rows. Column padding does not matter here; Prettier realigns the table below. The new rows:

```text
| BOOTSTRAP-PRESERVE-02 — `station-mirror.db` stays readable with the prior data at the resolved Station SQLite path, which a storage-move build relocates once from the roaming profile to the local app data folder | BOOTSTRAP_READY | Windows data preservation | NOT_RUN | | | | |
| BETA-PRESERVE-02 — `station-mirror.db` stays readable at the resolved Station SQLite path after validation/candidate update; a storage-move build relocates it once from the roaming profile to the local app data folder | BETA_SIGN_OFF | Windows data preservation | NOT_RUN | | | | |
| PRESERVE-02 — `station-mirror.db` stays readable at the resolved Station SQLite path; a storage-move build relocates it once from the roaming profile to the local app data folder | EVERY_STABLE_SIGN_OFF | Windows data preservation | NOT_RUN | | | | |
```

Then replace the rollback sentence:

```text
immutable NSIS. Preserve application ID, SQLite path, pairing, settings,
journals, boxes, exceptions, and outbox; deletion is not rollback.
```

with:

```text
immutable NSIS. Preserve application ID, SQLite path, pairing, settings,
journals, boxes, exceptions, and outbox; deletion is not rollback. A build
from before the storage move reads only the roaming folder: before installing
it, copy `station.json` and `station-mirror.db*` back from
`%LOCALAPPDATA%\app.markiro.station` to `%APPDATA%\app.markiro.station` and
delete `station-storage.json` there, or the older build starts unpaired.
```

In `docs/acceptance/station-stable-release.md`, replace the row text `Station SQLite path and database remain unchanged` with `Station SQLite database unchanged; path local after the first start`. Keep `NOT RUN` and `Path + before/after counts`. This row holds the document's only "SQLite", which `docs.test.mjs` requires (`assert.match(stableAcceptance, /SQLite/i)`), so the word must stay.

Realign both tables:

```bash
pnpm exec prettier --write docs/acceptance/station-dual-origin-release.md docs/acceptance/station-stable-release.md
```

- [ ] **Step 4: Run the contract to verify it passes**

Run: `pnpm test:station-release:contract`
Expected: PASS.

- [ ] **Step 5: Update the runbooks**

In `docs/runbooks/station-beta-release.md`, replace:

```text
До и после install-over зафиксируйте application ID `app.markiro.station`,
фактический абсолютный путь к SQLite и относительное имя
`sqlite:station-mirror.db`, Station identity, pairing, hardware settings,
журналы, короба, исключения и pending outbox. Путь берите из реально
установленной Windows Station, не восстанавливайте его по предположению о
профиле пользователя. Удаление или создание новой SQLite/outbox не является
migration или recovery.
```

with:

```text
До и после install-over зафиксируйте application ID `app.markiro.station`,
фактический абсолютный путь к SQLite (Центр обновлений → «Данные станции»),
Station identity, pairing, hardware settings, журналы, короба, исключения и
pending outbox. Путь берите из реально установленной Windows Station, не
восстанавливайте его по предположению о профиле пользователя. Первая сборка с
переносом хранилища один раз переносит базу из перемещаемого профиля в
`%LOCALAPPDATA%\app.markiro.station`; дальше путь не меняется. Удаление или
создание новой SQLite/outbox не является migration или recovery.
```

In `docs/runbooks/station-stable-release.md`, replace:

```text
До и после установки зафиксируйте application ID `app.markiro.station`,
фактический абсолютный путь к базе и относительное имя
`sqlite:station-mirror.db`, pairing, settings, journals, boxes, exceptions и
pending outbox. Не выводите путь из предположения о Windows user profile:
снимите его с установленной Station до и после install-over.
```

with:

```text
До и после установки зафиксируйте application ID `app.markiro.station`,
фактический абсолютный путь к базе (Центр обновлений → «Данные станции»),
pairing, settings, journals, boxes, exceptions и pending outbox. Не выводите
путь из предположения о Windows user profile: снимите его с установленной
Station до и после install-over. Первая сборка с переносом хранилища один раз
переносит базу из перемещаемого профиля в `%LOCALAPPDATA%\app.markiro.station`.
```

and replace:

```text
Application ID, SQLite path, pairing, settings, journals, boxes, exceptions и
outbox сохраняются; удаление данных запрещено.
```

with:

```text
Application ID, SQLite path, pairing, settings, journals, boxes, exceptions и
outbox сохраняются; удаление данных запрещено. Сборка до переноса хранилища
читает только перемещаемую папку: перед её установкой верните `station.json` и
`station-mirror.db*` из `%LOCALAPPDATA%\app.markiro.station` в
`%APPDATA%\app.markiro.station` и удалите там `station-storage.json`, иначе
станция запустится без привязки.
```

- [ ] **Step 6: Update the first-customer inventory docs**

In `docs/operations/first-customer-inventory/README.md`, replace:

````text
Текущая Station загружает `sqlite:station-mirror.db`. Закреплённый в Cargo.lock
`tauri-plugin-sql` 2.4.0 разрешает этот относительный URL от app-scoped каталога
конфигурации Tauri `BaseDirectory::AppConfig`. Идентификатор приложения равен
`app.markiro.station`, поэтому ожидаемый путь в Windows:

```text
%APPDATA%\app.markiro.station\station-mirror.db
```

Этот путь выведен из текущего кода и зависимости. Он не проверен на рабочем
Windows-устройстве. Перед чтением закройте Station, чтобы зафиксировать снимок.
````

with:

````text
Путь к базе показывает сама Station: Центр обновлений → «Данные станции».
Начиная со сборки с переносом хранилища база лежит в неперемещаемой папке:

```text
%LOCALAPPDATA%\app.markiro.station\station-mirror.db
```

Если в «Данных станции» указан перемещаемый профиль (`%APPDATA%`), перенос
отложен: используйте путь, который показан там. Перед чтением закройте
Station, чтобы зафиксировать снимок.
````

and replace `$stationDb = Join-Path $env:APPDATA 'app.markiro.station\station-mirror.db'` with `$stationDb = Join-Path $env:LOCALAPPDATA 'app.markiro.station\station-mirror.db'`.

In `docs/operations/first-customer-inventory/protocol-v1.md`, replace:

```text
проверяет существование
`%APPDATA%\app.markiro.station\station-mirror.db`, запускает команду
```

with:

```text
проверяет существование базы по пути из «Данных станции» в Центре обновлений
(обычно `%LOCALAPPDATA%\app.markiro.station\station-mirror.db`), запускает команду
```

- [ ] **Step 7: Record the invariant and the IT guidance**

In `docs/architecture.md`, after the bullet that starts with `- **Local DB:** SQLite via \`tauri-plugin-sql\``, add:

```markdown
- **Local storage location:** `station.json` (device identity and key) and
  `station-mirror.db` live together in machine-local app data
  (`%LOCALAPPDATA%\app.markiro.station`), never in a roaming or redirected
  profile: a copy on another PC prints duplicate SSCCs offline and stalls its
  outbox on batch-id collisions. Older installs move there once, crash-safely
  (`apps/station/src-tauri/src/storage/`).
```

In `apps/station/README.md`, replace:

```text
URL in a `0600` `station.json` (OS app-config dir). A shift is downloaded in
```

with:

```text
URL in a `0600` `station.json` in machine-local app data
(`%LOCALAPPDATA%\app.markiro.station` on Windows, next to the SQLite mirror). A shift is downloaded in
```

and insert immediately before the line `## Dev run (macOS)`:

```markdown
## Windows account and station data

Station keeps `station.json` and `station-mirror.db` in
`%LOCALAPPDATA%\app.markiro.station`. Builds before the storage move kept them
in the roaming `%APPDATA%\app.markiro.station`; the first start of a newer
build moves them once (design:
`docs/superpowers/specs/2026-09-27-station-local-storage-design.md`).

- Run the station under a local Windows account, or a domain account without a
  roaming profile or AppData folder redirection. On a temporary, mandatory or
  "delete cached copies" roaming profile the station keeps its data in the
  roaming folder and says so on the Update screen; pairing warns as well.
- Pair a station after disk imaging, never before: an image of a paired station
  clones its identity.
- Update screen → «Данные станции» shows the data folder and any storage
  notices.
```

- [ ] **Step 8: Record the implementation notes in the spec**

Append to `docs/superpowers/specs/2026-09-27-station-local-storage-design.md`:

```markdown
## 13. Implementation notes (plan 2026-09-27)

These supersede the named parts of sections 6-8.

- **Probe (6.1).** It is a function, `profile_facts()`, not a trait: `resolve`
  takes the resulting `ProfileFacts` value, and tests pass values directly. It
  reports temporary, mandatory and roaming profiles plus the
  `DeleteRoamingCache` policy. It has no folder-redirection check: no decision
  needs one, and the record's `legacy_dir` shows a UNC path when redirected.
  Test 15 drops its `FOLDERID_RoamingAppData` assertion.
- **Notices (6.6).**
  - The notices are `LegacyInUse`, `MoveFailed`,
    `LocalLessDurable { reason }`, `RoamedCopyPresent { same_machine_id }` and
    `ClaimLeftovers`.
  - `TemporaryProfile` is `LocalLessDurable { reason: temporary_profile }`.
  - A committed station whose profile later becomes less durable stays local
    and reports `LocalLessDurable`.
- **Extra blocks (6.3).** A claimed folder with station files but no record
  blocks, because this machine's record may be lost. So does a recorded claim
  whose folder holds no station files.
- **Stale sidecars (6.3 step 4).** Before a resumed install, every
  `station.json`, `station-mirror.db` and `-journal`/`-wal`/`-shm` in the local
  folder is removed. SQLite would otherwise replay a stale journal next to a
  fresh copy.
- **UI (D4).** No diagnostics screen exists. The Update screen gets a "Station
  data" section (folder and notices), and the pairing screen warns on
  temporary and mandatory profiles (6.5).
- **CI (D5).** PR CI compiles the Windows-only tests
  (`cargo test --no-run` in `station-windows-build`) but does not run them. On
  Windows Server 2025 the Tauri test harness can fail before `main()` with
  `STATUS_ENTRYPOINT_NOT_FOUND`, so the stable gate is also compile-only.
  Running them needs a follow-up: a Tauri-free storage crate, or a test-binary
  manifest fix.
- **Rollback (6.8).** The release acceptance and runbooks now say that
  installing a build from before the move requires restoring the files to the
  roaming folder first.
```

- [ ] **Step 9: Verify formatting and the contract**

Run:

```bash
pnpm exec prettier --check docs/acceptance/station-dual-origin-release.md docs/acceptance/station-stable-release.md docs/runbooks/station-beta-release.md docs/runbooks/station-stable-release.md docs/operations/first-customer-inventory/README.md docs/operations/first-customer-inventory/protocol-v1.md docs/architecture.md apps/station/README.md docs/superpowers/specs/2026-09-27-station-local-storage-design.md
pnpm test:station-release:contract
git diff --check
```

Expected: all pass. If Prettier reports a file, run `--write` on that file only and re-check.

- [ ] **Step 10: Commit**

```bash
git add tools/station-release/test/docs.test.mjs docs/acceptance/station-dual-origin-release.md docs/acceptance/station-stable-release.md docs/runbooks/station-beta-release.md docs/runbooks/station-stable-release.md docs/operations/first-customer-inventory/README.md docs/operations/first-customer-inventory/protocol-v1.md docs/architecture.md apps/station/README.md docs/superpowers/specs/2026-09-27-station-local-storage-design.md
git commit -m "docs(station): инварианты релиза и runbook под перенос хранилища станции" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Final verification

- [ ] **Step 1: Run every relevant gate**

```bash
pnpm turbo build --filter '@markiro/station...'
cargo build --manifest-path apps/station/src-tauri/Cargo.toml
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
pnpm --filter @markiro/station test
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
pnpm --filter @markiro/station build
pnpm test:station-release:contract
pnpm test:ci-policy
pnpm format:check
git diff --check
```

Expected: all pass. If `graphify-out/` exists, also run `graphify update .`.

- [ ] **Step 2: Review the whole diff against the spec**

```bash
git fetch origin main
git log --oneline origin/main..HEAD
git diff origin/main...HEAD --stat
```

Check every item in spec sections 6-8 and 13 against the diff. Check that `app_config_dir` appears in code only in `lib.rs`, and that no file outside the lists above changed.

- [ ] **Step 3: Report**

The report must list:

- behaviour changed;
- files changed;
- automated checks with their results;
- which Windows-only tests were only compiled, not run;
- that none of the manual checks below were performed by automation.

Do not push or open a PR unless the owner asks.

## Deviations from the spec

- **D5.** Windows-only Rust tests are compiled in PR CI, not run, because of the known Tauri harness failure on Windows Server 2025. Running them needs a follow-up the owner has to choose: a Tauri-free storage crate, or a test-binary manifest fix.
- **Probe, notices, extra blocks, stale sidecars, UI placement.** See spec section 13 (written in Task 10).

## Manual validation (not provable by automation)

All from spec section 9. Run these on a beta before promoting to stable.

- **Local account, Windows 10 and 11.** Upgrade from the current stable with an enrolled station and scans made offline. Expected: the queue drains, SSCCs continue, no re-pairing, and «Данные станции» shows `%LOCALAPPDATA%`.
- **Test AD with a roaming profile.**
  1. Migrate on PC A and sign out.
  2. Check that the profile share no longer holds the files.
  3. Sign in on PC B with the station installed.

  Expected: B shows enrollment, not A's identity.

- **Redirected AppData, station running on a second computer.** Expected: `LegacyInUse` on the Update screen, and the station keeps working.
- **`DeleteRoamingCache = 1`.** Expected: no move, and a `LocalLessDurable` notice.
- **Temporary profile.** Expected: the pairing screen shows the warning.
