# Signer local storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Markiro signer's state (`signer.json` with the DPAPI-protected agent secret, and the journal) out of the Windows roaming profile into `%LOCALAPPDATA%`, once and crash-safely, and stop deleting a credential that merely fails to decrypt.

**Architecture:** A new host-testable module `signer_core::storage_location` decides at startup which folder the agent uses and moves the data once: copy → verify → commit a record in the local folder → retire the roaming folder. The rule "no committed record ⇒ roaming folder is authoritative; committed ⇒ local folder is" makes every interruption safe. The Tauri shell calls it before building the `Runtime`; the runtime exposes storage notices in `AgentStatus` and keeps an unreadable credential instead of wiping it; the webview shows the notices.

**Tech Stack:** Rust (signer-core, Tauri 2.11.5, windows-sys 0.61, serde), React 19 + i18next + Vitest 4 (apps/signer webview).

**Spec:** `docs/superpowers/specs/2026-09-27-signer-local-storage-design.md` (commit `5c74967f6`), owner decisions S1-S4 accepted 2026-09-27.

**Validation of this plan:** every code block below was applied task by task to a clean copy of `apps/signer` (at `05364ba06`) and run: after Task 4 the Cargo workspace passed with `signer_core` 111 tests (80 existing + 31 new) and `markiro_signer_lib` 7 tests, no warnings; the Windows-only code type-checked for `x86_64-pc-windows-msvc`; after Task 5 the webview passed 12 files / 49 tests (43 existing + 6 new), `tsc` and ESLint clean.

## Global Constraints

- **Folders.** Target: `app_local_data_dir()` = `%LOCALAPPDATA%\app.markiro.signer`. Legacy: `app_config_dir()` = `%APPDATA%\app.markiro.signer` (roaming).
- **File names.** `signer.json` and `journal\signer.jsonl*` keep their names. New files in the local folder: `signer-storage.json` (the move record) and `signer-storage.lock`.
- **The one rule.** Without a committed record in the local folder the legacy folder is authoritative; with one, the local folder is. Never load a roaming `signer.json` after the commit. Delete from the roaming folder only a `signer.json` whose bytes match what was copied.
- **S2 / station D2.** Temporary, mandatory, and roaming-with-`DeleteRoamingCache = 1` profiles keep the roaming folder and show a notice.
- **S2 / station D3.** Pairing data that appears in the roaming folder after the move is reported, never loaded, never deleted.
- **S2 / station D4.** Notices go to the journal and to `AgentStatus.storageNotices`; the Status tab shows all, the pairing screen shows `credentialUnreadable` and temporary/mandatory profile.
- **S3.** A credential DPAPI cannot decrypt is kept: phase `unpaired`, notice `credentialUnreadable`, decryption retried with the existing backoff, a new pairing overwrites the file. A 401 from the cloud still clears the credential.
- **No other changes.** No cloud API, contract, Postgres or installer change. No new crates and no new npm packages: only `windows-sys` features. Keep exact version pins.
- **Journal messages** stay in English, like every existing journal line. Every user-visible webview string goes into both `src/i18n/ru.json` and `src/i18n/en.json`.
- **TypeScript.** Strict mode with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
- **Compile prerequisite.** The Tauri crate compiles only after `apps/signer/dist` exists (`tauri::generate_context!`).
- **Loopback for wiremock.** 26 existing signer-core tests (and one new) start a wiremock server on 127.0.0.1. In a sandbox without local port binding they fail with `Failed to bind an OS port` — that is the environment, not a regression; run them where loopback binding is allowed (CI does).
- **Commits.** Conventional prefix with a Russian summary, following the repo style; end each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage explicit paths only. Never use `git stash`.

---

## Prerequisites (once per worktree)

- [ ] **Install and build the webview and its workspace dependencies**

```bash
pnpm install --frozen-lockfile
pnpm turbo build --filter '@markiro/signer...'
```

Expected: `apps/signer/dist/index.html` exists (the Tauri crate needs it to compile).

- [ ] **Record a green baseline**

```bash
cargo test --manifest-path apps/signer/Cargo.toml
pnpm --filter @markiro/signer test
pnpm --filter @markiro/signer typecheck
```

Expected: `signer_core` 80 passed, `markiro_signer_lib` 7 passed; Vitest `10 passed (10)` files, `43 passed (43)` tests; `tsc` prints nothing. If anything fails before any change, stop and report it (loopback: see Global Constraints). Do not fix unrelated failures.

## File Structure

- `apps/signer/signer-core/src/storage_location.rs` (new): where the agent state lives and the one-time move. Types `StorageNotice`, `LessDurableReason`, `ProfileFacts`, trait `ProfileProbe`, `SystemProfileProbe` (Task 1); `resolve`, `roamed_copy`, `Resolution`, `Step`, `Hooks`, `NoHooks`, the record, copy and retire (Task 2).
- `apps/signer/signer-core/src/storage.rs`: `write_atomic` (shared temp-file + rename helper) and `CONFIG_FILE` become `pub(crate)` (Task 2); header comment corrected (Task 6).
- `apps/signer/signer-core/src/journal.rs`: `JOURNAL_DIR` and `LOG_FILE_NAME` become `pub(crate)` (Task 2).
- `apps/signer/signer-core/src/runtime.rs`: journal folder constant (Task 2); `AgentStatus.storage_notices`, `apply_storage_resolution`, `report_storage_notice`, the non-destructive unreadable credential (Task 3).
- `apps/signer/signer-core/src/storage_dpapi.rs`: header comment corrected (Task 6).
- `apps/signer/signer-core/src/lib.rs`, `apps/signer/signer-core/Cargo.toml`: module declaration and `windows-sys` features (Task 1).
- `apps/signer/src-tauri/src/lib.rs`: resolve before `Runtime::new`, background roamed-copy check (Task 4).
- `apps/signer/src/lib/bridge.ts`, `src/lib/storage-notices.ts` (new), `src/components/StorageNotices.tsx` (new), `src/pages/Status.tsx`, `src/pages/Pairing.tsx`, `src/App.tsx`, `src/signer.css`, `src/i18n/{ru,en}.json`, tests (Task 5).
- Docs: `docs/runbooks/signer-agent-manual-e2e.md`, `docs/runbooks/signer-windows-acceptance.md`, `apps/signer/README.md`, `docs/architecture.md`, `docs/superpowers/specs/2026-08-28-chz-signer-agent-design.md` (Task 6).

---

### Task 1: Storage notices and the Windows profile probe

**Files:**

- Modify: `apps/signer/signer-core/Cargo.toml` (the `windows-sys` feature list)
- Modify: `apps/signer/signer-core/src/lib.rs` (module list)
- Create: `apps/signer/signer-core/src/storage_location.rs`

**Interfaces:**

- Consumes: nothing new.
- Produces (all in `signer_core::storage_location`):
  - `pub enum StorageNotice { LocalLessDurable { reason: LessDurableReason }, MovePostponed, LegacyCleanupPending, RoamedCopyPresent { same_agent: bool }, CredentialUnreadable }` — `Serialize` as `{"kind": "<camelCase variant>", <camelCase fields>}`; `PartialEq`, `Eq`, `Clone`, `Debug`.
  - `impl StorageNotice { pub fn journal_message(&self) -> &'static str }`
  - `pub enum LessDurableReason { TemporaryProfile, MandatoryProfile, DeleteRoamingCache }` (`Copy`, serializes camelCase).
  - `pub struct ProfileFacts { pub temporary: bool, pub mandatory: bool, pub roaming: bool, pub delete_roaming_cache: bool }` (`Default`, `Copy`) with `pub fn local_less_durable(&self) -> Option<LessDurableReason>`.
  - `pub trait ProfileProbe { fn facts(&self) -> ProfileFacts; }` and `pub struct SystemProfileProbe;` implementing it.

- [ ] **Step 1: Enable the Windows APIs and declare the module**

In `apps/signer/signer-core/Cargo.toml`, replace the `windows-sys` entry:

```toml
windows-sys = { version = "0.61", features = [
  "Win32_Foundation",
  "Win32_Security_Cryptography",
  "Win32_System_GroupPolicy",
  "Win32_System_Registry",
  "Win32_System_SystemInformation",
  "Win32_UI_Shell",
] }
```

`Win32_UI_Shell` brings `GetProfileType`, `Win32_System_GroupPolicy` its `PT_*` flags, `Win32_System_Registry` `RegGetValueW`. No new crate.

In `apps/signer/signer-core/src/lib.rs`, add the module after `pub mod storage;`:

```rust
pub mod storage;
pub mod storage_location;
```

- [ ] **Step 2: Write the failing tests**

Create `apps/signer/signer-core/src/storage_location.rs` with the module comment, one import and the test module only:

```rust
//! Where the agent keeps its state, and the one-time move of that state out of
//! the Windows roaming profile.
//!
//! Releases up to 0.1.4 kept `signer.json` and the journal in
//! `app_config_dir()`, which on Windows is the roaming `%APPDATA%`. A roaming
//! profile or AppData folder redirection carried that folder, agent secret
//! included, to every computer the same Windows user signed in to, and the
//! user's DPAPI keys went with it. The state now lives in
//! `app_local_data_dir()` (`%LOCALAPPDATA%`), which Windows neither roams nor
//! redirects. Design: `docs/superpowers/specs/2026-09-27-signer-local-storage-design.md`.
//!
//! One rule carries the move: without a committed record in the local folder
//! the legacy folder is authoritative; with one, the local folder is. The
//! record is a single atomic write, so an interruption at any point leaves
//! exactly one authoritative copy.
use serde::Serialize;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notices_serialize_for_the_webview() {
        assert_eq!(
            serde_json::to_value(StorageNotice::RoamedCopyPresent { same_agent: true }).unwrap(),
            serde_json::json!({ "kind": "roamedCopyPresent", "sameAgent": true })
        );
        assert_eq!(
            serde_json::to_value(StorageNotice::LocalLessDurable {
                reason: LessDurableReason::TemporaryProfile
            })
            .unwrap(),
            serde_json::json!({ "kind": "localLessDurable", "reason": "temporaryProfile" })
        );
        assert_eq!(
            serde_json::to_value(StorageNotice::MovePostponed).unwrap(),
            serde_json::json!({ "kind": "movePostponed" })
        );
    }

    #[test]
    fn only_profiles_that_discard_the_local_folder_are_less_durable() {
        let facts = |temporary, mandatory, roaming, delete_roaming_cache| ProfileFacts {
            temporary,
            mandatory,
            roaming,
            delete_roaming_cache,
        };
        assert_eq!(facts(false, false, false, false).local_less_durable(), None);
        assert_eq!(facts(false, false, true, false).local_less_durable(), None);
        assert_eq!(facts(false, false, false, true).local_less_durable(), None);
        assert_eq!(
            facts(true, false, false, false).local_less_durable(),
            Some(LessDurableReason::TemporaryProfile)
        );
        assert_eq!(
            facts(false, true, false, false).local_less_durable(),
            Some(LessDurableReason::MandatoryProfile)
        );
        assert_eq!(
            facts(false, false, true, true).local_less_durable(),
            Some(LessDurableReason::DeleteRoamingCache)
        );
        // A temporary profile loses everything at sign-out, so it wins.
        assert_eq!(
            facts(true, true, true, true).local_less_durable(),
            Some(LessDurableReason::TemporaryProfile)
        );
    }

    #[test]
    fn every_notice_has_its_own_journal_line() {
        let notices = [
            StorageNotice::LocalLessDurable { reason: LessDurableReason::TemporaryProfile },
            StorageNotice::LocalLessDurable { reason: LessDurableReason::MandatoryProfile },
            StorageNotice::LocalLessDurable { reason: LessDurableReason::DeleteRoamingCache },
            StorageNotice::MovePostponed,
            StorageNotice::LegacyCleanupPending,
            StorageNotice::RoamedCopyPresent { same_agent: true },
            StorageNotice::RoamedCopyPresent { same_agent: false },
            StorageNotice::CredentialUnreadable,
        ];
        let mut lines: Vec<&str> = notices.iter().map(StorageNotice::journal_message).collect();
        assert!(lines.iter().all(|line| !line.is_empty()));
        lines.sort_unstable();
        lines.dedup();
        assert_eq!(lines.len(), notices.len());
    }

    #[cfg(windows)]
    #[test]
    fn the_runner_profile_is_local() {
        let facts = SystemProfileProbe.facts();
        assert!(!facts.temporary && !facts.mandatory, "{facts:?}");
        assert_eq!(facts.local_less_durable(), None, "{facts:?}");
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/signer/Cargo.toml -p signer-core storage_location`
Expected: compilation fails, because `StorageNotice`, `LessDurableReason`, `ProfileFacts` and `SystemProfileProbe` are not defined yet.

- [ ] **Step 4: Write the implementation**

In `storage_location.rs`, insert between `use serde::Serialize;` and `#[cfg(test)]`:

```rust
/// A storage fact the operator should know about. Each one reaches the
/// journal and `AgentStatus.storageNotices`; the webview words it
/// (`src/i18n`, keys under `storage`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum StorageNotice {
    /// The local folder would not survive sign-out, so the agent stays in the
    /// roaming one.
    LocalLessDurable { reason: LessDurableReason },
    /// The roaming folder could not be read, or the copy failed. This run uses
    /// the roaming folder; the next start tries again.
    MovePostponed,
    /// The moved roaming copy could not be removed yet. This computer no
    /// longer uses it.
    LegacyCleanupPending,
    /// Pairing data turned up in the roaming folder after the move. It is
    /// never loaded and never deleted. `same_agent`: it holds this agent's id,
    /// so a copy of this agent may be running on another computer.
    RoamedCopyPresent { same_agent: bool },
    /// DPAPI could not decrypt the saved credential. The file is kept and the
    /// agent asks for a new pairing (spec §7.6).
    CredentialUnreadable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LessDurableReason {
    TemporaryProfile,
    MandatoryProfile,
    DeleteRoamingCache,
}

impl StorageNotice {
    /// The journal line for this notice. English, like every journal message.
    pub fn journal_message(&self) -> &'static str {
        match self {
            Self::LocalLessDurable {
                reason: LessDurableReason::TemporaryProfile,
            } => "Temporary Windows profile: agent data stays in the roaming folder and is lost at sign-out",
            Self::LocalLessDurable {
                reason: LessDurableReason::MandatoryProfile,
            } => "Mandatory Windows profile: agent data stays in the roaming folder and is lost at sign-out",
            Self::LocalLessDurable {
                reason: LessDurableReason::DeleteRoamingCache,
            } => "Local profile copies are deleted at sign-out: agent data stays in the roaming folder",
            Self::MovePostponed => {
                "Agent data could not be moved out of the roaming folder yet; retrying at the next start"
            }
            Self::LegacyCleanupPending => {
                "The old roaming copy of the agent data could not be removed yet; it is no longer used"
            }
            Self::RoamedCopyPresent { same_agent: true } => {
                "A copy of this agent's pairing appeared in the roaming folder; the agent may also run on another computer"
            }
            Self::RoamedCopyPresent { same_agent: false } => {
                "Another pairing appeared in the roaming folder; it is not used"
            }
            Self::CredentialUnreadable => "Stored credential is unreadable",
        }
    }
}

/// What Windows says about the signed-in user's profile.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProfileFacts {
    pub temporary: bool,
    pub mandatory: bool,
    pub roaming: bool,
    pub delete_roaming_cache: bool,
}

impl ProfileFacts {
    /// A temporary or mandatory profile is discarded at sign-out, and the
    /// "delete cached copies of roaming profiles" policy deletes the local
    /// profile copy, `%LOCALAPPDATA%` included. There the roaming folder is the
    /// only copy that survives, so the agent must not move into the local one
    /// (station decision D2, carried over as signer decision S2).
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

pub trait ProfileProbe {
    fn facts(&self) -> ProfileFacts;
}

/// `GetProfileType` and the `DeleteRoamingCache` policy on Windows; a local
/// profile everywhere else (the agent ships only for Windows).
pub struct SystemProfileProbe;

impl ProfileProbe for SystemProfileProbe {
    fn facts(&self) -> ProfileFacts {
        system_profile_facts()
    }
}

#[cfg(windows)]
fn system_profile_facts() -> ProfileFacts {
    use windows_sys::Win32::System::GroupPolicy::{
        PT_MANDATORY, PT_ROAMING, PT_ROAMING_PREEXISTING, PT_TEMPORARY,
    };
    use windows_sys::Win32::UI::Shell::GetProfileType;

    let mut flags = 0u32;
    // SAFETY: `flags` is a valid, writable u32 for the duration of the call.
    let known = unsafe { GetProfileType(&mut flags) } != 0;
    ProfileFacts {
        temporary: known && flags & PT_TEMPORARY != 0,
        mandatory: known && flags & PT_MANDATORY != 0,
        // An unknown profile counts as roaming, so the delete-cache policy on
        // its own still keeps the agent where it is.
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
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD,
    };

    let key: Vec<u16> = key.encode_utf16().chain(once(0)).collect();
    let value: Vec<u16> = value.encode_utf16().chain(once(0)).collect();
    let mut data = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: both names are NUL-terminated UTF-16 buffers that outlive the
    // call; `data` and `size` describe one writable u32, which is what
    // RRF_RT_REG_DWORD returns.
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

#[cfg(not(windows))]
fn system_profile_facts() -> ProfileFacts {
    ProfileFacts::default()
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test --manifest-path apps/signer/Cargo.toml -p signer-core storage_location`
Expected: `test result: ok. 3 passed` and no compiler warnings. (`the_runner_profile_is_local` is `#[cfg(windows)]`; it runs in the `signer-windows-build` CI job on `windows-latest`, whose profile is local.)

- [ ] **Step 6: Commit**

```bash
git add apps/signer/signer-core/Cargo.toml apps/signer/signer-core/src/lib.rs apps/signer/signer-core/src/storage_location.rs
git commit -m "feat(signer): уведомления о хранилище и проверка профиля Windows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The one-time move out of the roaming folder

**Files:**

- Modify: `apps/signer/signer-core/src/storage.rs:16` and `:56-69` (`CONFIG_FILE`, `write_config` → `write_atomic`)
- Modify: `apps/signer/signer-core/src/journal.rs:18` (`LOG_FILE_NAME`, new `JOURNAL_DIR`)
- Modify: `apps/signer/signer-core/src/runtime.rs:166` (journal folder)
- Modify: `apps/signer/signer-core/src/storage_location.rs` (imports, move code, `move_tests`)

**Interfaces:**

- Consumes: everything Task 1 produced.
- Produces:
  - `pub(crate) fn storage::write_atomic(dir: &Path, file_name: &str, bytes: &[u8]) -> std::io::Result<()>`; `pub(crate) const storage::CONFIG_FILE: &str = "signer.json"`.
  - `pub(crate) const journal::JOURNAL_DIR: &str = "journal"`; `pub(crate) const journal::LOG_FILE_NAME: &str = "signer.jsonl"`.
  - `pub const storage_location::RECORD_FILE: &str = "signer-storage.json"`, `pub const LOCK_FILE: &str = "signer-storage.lock"`.
  - `pub enum Step { CopyConfig, VerifyConfig, CopyJournal, Commit, Retire, DeleteRetired }`, `pub trait Hooks { fn before(&self, _step: Step) -> io::Result<()> { Ok(()) } }`, `pub struct NoHooks;`.
  - `pub struct Resolution { pub dir: PathBuf, pub notices: Vec<StorageNotice>, pub moved: bool, pub journal_left_behind: bool, pub check_roamed_copy: bool }` (`Debug`, `Clone`, `PartialEq`, `Eq`).
  - `pub fn resolve(legacy_dir: &Path, local_dir: &Path, probe: &dyn ProfileProbe, hooks: &dyn Hooks) -> Resolution` — never fails.
  - `pub fn roamed_copy(legacy_dir: &Path, local_dir: &Path) -> Option<StorageNotice>` — run off the startup path.

- [ ] **Step 1: Share the atomic write and the journal names (refactor under green tests)**

In `apps/signer/signer-core/src/storage.rs`, replace `const CONFIG_FILE: &str = "signer.json";` with:

```rust
/// The agent state file. `storage_location` moves it; nothing else names it.
pub(crate) const CONFIG_FILE: &str = "signer.json";
```

and replace the whole `write_config` function with:

```rust
/// Writes `bytes` to `dir/file_name` through a temp file and an atomic rename,
/// so a crash mid-write leaves the previous content intact rather than a
/// truncated file. `storage_location` writes its move record the same way.
pub(crate) fn write_atomic(dir: &Path, file_name: &str, bytes: &[u8]) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let temp = dir.join(format!(".{file_name}.tmp"));
    {
        let mut file = fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&temp, dir.join(file_name))
}

/// Writes through a temp file and an atomic rename so a crash mid-write leaves
/// the previous config intact rather than a truncated one.
pub fn write_config(dir: &Path, config: &AgentConfig) -> Result<(), SignerError> {
    let text = serde_json::to_string_pretty(config).map_err(|e| SignerError::Storage(e.to_string()))?;
    write_atomic(dir, CONFIG_FILE, text.as_bytes()).map_err(|e| SignerError::Storage(e.to_string()))
}
```

The temp name stays `.signer.json.tmp`, which `a_partially_written_file_does_not_replace_a_good_one` depends on.

In `apps/signer/signer-core/src/journal.rs`, replace `const LOG_FILE_NAME: &str = "signer.jsonl";` with:

```rust
/// The folder, under the agent state folder, that holds the journal files.
pub(crate) const JOURNAL_DIR: &str = "journal";
pub(crate) const LOG_FILE_NAME: &str = "signer.jsonl";
```

In `apps/signer/signer-core/src/runtime.rs` (`Runtime::new`), replace
`let journal = match Journal::open(config_dir.join("journal")) {` with:

```rust
        let journal = match Journal::open(config_dir.join(crate::journal::JOURNAL_DIR)) {
```

Run: `cargo test --manifest-path apps/signer/Cargo.toml -p signer-core -- storage journal`
Expected: all selected tests pass (the existing `storage::tests`, `journal::tests` and Task 1's `storage_location::tests`), no warnings.

- [ ] **Step 2: Write the failing tests**

Append this second test module at the end of `storage_location.rs` (after the closing `}` of `mod tests`):

```rust
#[cfg(test)]
mod move_tests {
    use super::*;

    const PAIRED: &[u8] = br#"{"agentId":"a-1","serverUrl":"https://admin.markiro.app","agentSecretProtected":"cGxhaW4="}"#;
    const PAIRED_OTHER_CERT: &[u8] = br#"{"agentId":"a-1","serverUrl":"https://admin.markiro.app","certThumbprint":"CD34","agentSecretProtected":"cGxhaW4="}"#;
    const OTHER_AGENT: &[u8] = br#"{"agentId":"a-2","serverUrl":"https://admin.markiro.app","agentSecretProtected":"b3RoZXI="}"#;

    struct Dirs {
        _root: tempfile::TempDir,
        legacy: PathBuf,
        local: PathBuf,
    }

    /// `Roaming/app.markiro.signer` and `Local/app.markiro.signer` under a
    /// temp root. Both parents exist, as `%APPDATA%` and `%LOCALAPPDATA%` do.
    fn dirs() -> Dirs {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("Roaming").join("app.markiro.signer");
        let local = root.path().join("Local").join("app.markiro.signer");
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::create_dir_all(local.parent().unwrap()).unwrap();
        Dirs { _root: root, legacy, local }
    }

    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn seed_legacy(dirs: &Dirs) {
        write(&dirs.legacy.join(CONFIG_FILE), PAIRED);
        write(&dirs.legacy.join(CONFIG_TEMP_FILE), b"{ half-written");
        write(&dirs.legacy.join("journal").join("signer.jsonl"), b"{\"message\":\"new\"}\n");
        write(&dirs.legacy.join("journal").join("signer.jsonl.1"), b"{\"message\":\"old\"}\n");
    }

    fn record(dirs: &Dirs) -> Option<Record> {
        match read_record(&dirs.local) {
            RecordState::Committed(record) => Some(record),
            RecordState::Absent | RecordState::Unreadable => None,
        }
    }

    /// Everything in `Roaming/` whose name starts with the legacy folder's.
    fn roaming_leftovers(dirs: &Dirs) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dirs.legacy.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("app.markiro.signer"))
            .collect();
        names.sort();
        names
    }

    struct Local;
    impl ProfileProbe for Local {
        fn facts(&self) -> ProfileFacts {
            ProfileFacts::default()
        }
    }

    struct Facts(ProfileFacts);
    impl ProfileProbe for Facts {
        fn facts(&self) -> ProfileFacts {
            self.0
        }
    }

    struct FailAt(Step);
    impl Hooks for FailAt {
        fn before(&self, step: Step) -> io::Result<()> {
            if step == self.0 {
                Err(io::Error::other("injected failure"))
            } else {
                Ok(())
            }
        }
    }

    /// Runs `action` just before `step`, then lets the step proceed.
    struct At<F: Fn()>(Step, F);
    impl<F: Fn()> Hooks for At<F> {
        fn before(&self, step: Step) -> io::Result<()> {
            if step == self.0 {
                (self.1)();
            }
            Ok(())
        }
    }

    fn resolve_local(dirs: &Dirs) -> Resolution {
        resolve(&dirs.legacy, &dirs.local, &Local, &NoHooks)
    }

    #[test]
    fn a_fresh_start_commits_fresh_and_leaves_the_roaming_folder_alone() {
        let dirs = dirs();
        let resolution = resolve_local(&dirs);
        assert_eq!(resolution.dir, dirs.local);
        assert!(!resolution.moved);
        assert!(resolution.notices.is_empty());
        assert_eq!(record(&dirs).map(|r| r.how), Some(How::Fresh));
        assert!(!dirs.legacy.exists(), "the roaming folder must not be created");
    }

    #[test]
    fn moves_the_config_and_journal_byte_for_byte_and_retires_the_roaming_folder() {
        let dirs = dirs();
        seed_legacy(&dirs);

        let resolution = resolve_local(&dirs);

        assert_eq!(resolution.dir, dirs.local);
        assert!(resolution.moved);
        assert!(!resolution.journal_left_behind);
        assert!(resolution.notices.is_empty());
        assert_eq!(fs::read(dirs.local.join(CONFIG_FILE)).unwrap(), PAIRED);
        assert_eq!(
            fs::read(dirs.local.join("journal").join("signer.jsonl")).unwrap(),
            b"{\"message\":\"new\"}\n"
        );
        assert_eq!(
            fs::read(dirs.local.join("journal").join("signer.jsonl.1")).unwrap(),
            b"{\"message\":\"old\"}\n"
        );
        assert!(!dirs.local.join(CONFIG_TEMP_FILE).exists(), "the half-written temp file is not copied");
        let record = record(&dirs).unwrap();
        assert_eq!(record.how, How::Migrated);
        assert_eq!(record.cleanup, Some(Cleanup::Done));
        assert!(roaming_leftovers(&dirs).is_empty(), "left in Roaming: {:?}", roaming_leftovers(&dirs));
    }

    #[test]
    fn an_interruption_at_any_step_leaves_one_authoritative_copy_and_converges() {
        for step in [
            Step::CopyConfig,
            Step::VerifyConfig,
            Step::CopyJournal,
            Step::Commit,
            Step::Retire,
            Step::DeleteRetired,
        ] {
            let dirs = dirs();
            seed_legacy(&dirs);

            let interrupted = resolve(&dirs.legacy, &dirs.local, &Local, &FailAt(step));

            // Exactly one location is authoritative and holds the whole file.
            match record(&dirs) {
                Some(_) => {
                    assert_eq!(interrupted.dir, dirs.local, "{step:?}");
                    assert_eq!(fs::read(dirs.local.join(CONFIG_FILE)).unwrap(), PAIRED, "{step:?}");
                }
                None => {
                    assert_eq!(interrupted.dir, dirs.legacy, "{step:?}");
                    assert_eq!(interrupted.notices, vec![StorageNotice::MovePostponed], "{step:?}");
                    assert_eq!(fs::read(dirs.legacy.join(CONFIG_FILE)).unwrap(), PAIRED, "{step:?}");
                }
            }

            let rerun = resolve_local(&dirs);

            assert_eq!(rerun.dir, dirs.local, "{step:?}");
            assert!(rerun.notices.is_empty(), "{step:?}: {:?}", rerun.notices);
            assert_eq!(fs::read(dirs.local.join(CONFIG_FILE)).unwrap(), PAIRED, "{step:?}");
            assert_eq!(record(&dirs).unwrap().cleanup, Some(Cleanup::Done), "{step:?}");
            assert!(roaming_leftovers(&dirs).is_empty(), "{step:?}: {:?}", roaming_leftovers(&dirs));
        }
    }

    #[test]
    fn a_journal_that_cannot_be_copied_does_not_stop_the_move() {
        let dirs = dirs();
        seed_legacy(&dirs);

        let resolution = resolve(&dirs.legacy, &dirs.local, &Local, &FailAt(Step::CopyJournal));

        assert_eq!(resolution.dir, dirs.local);
        assert!(resolution.moved);
        assert!(resolution.journal_left_behind);
        assert_eq!(fs::read(dirs.local.join(CONFIG_FILE)).unwrap(), PAIRED);
    }

    #[test]
    fn without_a_record_the_roaming_copy_wins_over_a_local_leftover() {
        let dirs = dirs();
        seed_legacy(&dirs);
        write(&dirs.local.join(CONFIG_FILE), OTHER_AGENT);

        let resolution = resolve_local(&dirs);

        assert!(resolution.moved);
        assert_eq!(fs::read(dirs.local.join(CONFIG_FILE)).unwrap(), PAIRED);
    }

    #[test]
    fn a_second_run_after_the_commit_changes_nothing() {
        let dirs = dirs();
        seed_legacy(&dirs);
        resolve_local(&dirs);
        let before = fs::read(dirs.local.join(RECORD_FILE)).unwrap();

        let again = resolve_local(&dirs);

        assert_eq!(again.dir, dirs.local);
        assert!(!again.moved);
        assert!(again.notices.is_empty());
        assert_eq!(fs::read(dirs.local.join(RECORD_FILE)).unwrap(), before);
    }

    #[test]
    fn two_concurrent_resolutions_move_once() {
        let dirs = dirs();
        seed_legacy(&dirs);
        let (legacy, local) = (dirs.legacy.clone(), dirs.local.clone());

        let handles: Vec<_> = (0..2)
            .map(|_| {
                let (legacy, local) = (legacy.clone(), local.clone());
                thread::spawn(move || resolve(&legacy, &local, &Local, &NoHooks))
            })
            .collect();
        let results: Vec<Resolution> = handles.into_iter().map(|h| h.join().unwrap()).collect();

        assert_eq!(results.iter().filter(|r| r.moved).count(), 1);
        assert!(results.iter().all(|r| r.dir == dirs.local));
        assert_eq!(fs::read(dirs.local.join(CONFIG_FILE)).unwrap(), PAIRED);
        assert!(roaming_leftovers(&dirs).is_empty());
    }

    #[test]
    fn a_refused_rename_is_retried_at_the_next_start() {
        let dirs = dirs();
        seed_legacy(&dirs);

        let first = resolve(&dirs.legacy, &dirs.local, &Local, &FailAt(Step::Retire));

        assert_eq!(first.dir, dirs.local);
        assert_eq!(first.notices, vec![StorageNotice::LegacyCleanupPending]);
        assert!(!first.check_roamed_copy, "our own unretired copy is not a roamed copy");
        assert_eq!(record(&dirs).unwrap().cleanup, Some(Cleanup::Pending));
        assert!(dirs.legacy.join(CONFIG_FILE).exists());

        let second = resolve_local(&dirs);

        assert!(second.notices.is_empty());
        assert_eq!(record(&dirs).unwrap().cleanup, Some(Cleanup::Done));
        assert!(roaming_leftovers(&dirs).is_empty());
    }

    #[test]
    fn a_roaming_config_rewritten_before_the_rename_is_left_in_place() {
        let dirs = dirs();
        seed_legacy(&dirs);
        let legacy_config = dirs.legacy.join(CONFIG_FILE);

        // Another computer writes its own pairing between the copy and the retire.
        let resolution = resolve(
            &dirs.legacy,
            &dirs.local,
            &Local,
            &At(Step::Commit, || fs::write(&legacy_config, OTHER_AGENT).unwrap()),
        );

        assert!(resolution.moved);
        assert!(resolution.check_roamed_copy);
        assert_eq!(fs::read(&legacy_config).unwrap(), OTHER_AGENT, "never deleted");
        assert_eq!(fs::read(dirs.local.join(CONFIG_FILE)).unwrap(), PAIRED);
        assert_eq!(
            roamed_copy(&dirs.legacy, &dirs.local),
            Some(StorageNotice::RoamedCopyPresent { same_agent: false })
        );
    }

    #[test]
    fn a_config_changed_after_the_rename_stays_in_the_retired_folder() {
        let dirs = dirs();
        seed_legacy(&dirs);
        let roaming = dirs.legacy.parent().unwrap().to_path_buf();

        let resolution = resolve(
            &dirs.legacy,
            &dirs.local,
            &Local,
            &At(Step::DeleteRetired, || {
                let retired = fs::read_dir(&roaming)
                    .unwrap()
                    .map(|entry| entry.unwrap().path())
                    .find(|path| path.to_string_lossy().contains(".retired-"))
                    .unwrap();
                fs::write(retired.join(CONFIG_FILE), PAIRED_OTHER_CERT).unwrap();
            }),
        );

        assert_eq!(
            resolution.notices,
            vec![StorageNotice::RoamedCopyPresent { same_agent: true }]
        );
        let leftovers = roaming_leftovers(&dirs);
        assert_eq!(leftovers.len(), 1);
        assert!(leftovers[0].contains(".retired-"));
        assert_eq!(
            fs::read(roaming.join(&leftovers[0]).join(CONFIG_FILE)).unwrap(),
            PAIRED_OTHER_CERT
        );
    }

    #[test]
    fn a_roamed_copy_after_the_commit_is_reported_never_loaded_or_deleted() {
        for (bytes, same_agent) in [(PAIRED, true), (OTHER_AGENT, false)] {
            let dirs = dirs();
            seed_legacy(&dirs);
            resolve_local(&dirs);
            write(&dirs.legacy.join(CONFIG_FILE), bytes);

            let resolution = resolve_local(&dirs);

            assert_eq!(resolution.dir, dirs.local);
            assert!(resolution.check_roamed_copy);
            assert_eq!(
                roamed_copy(&dirs.legacy, &dirs.local),
                Some(StorageNotice::RoamedCopyPresent { same_agent })
            );
            assert_eq!(fs::read(dirs.legacy.join(CONFIG_FILE)).unwrap(), bytes);
            assert_eq!(fs::read(dirs.local.join(CONFIG_FILE)).unwrap(), PAIRED);
        }
    }

    #[test]
    fn nothing_in_the_roaming_folder_means_no_roamed_copy() {
        let dirs = dirs();
        assert_eq!(roamed_copy(&dirs.legacy, &dirs.local), None);
    }

    #[test]
    fn a_profile_that_would_lose_the_local_folder_keeps_the_roaming_one() {
        let cases = [
            (
                ProfileFacts { temporary: true, ..ProfileFacts::default() },
                LessDurableReason::TemporaryProfile,
            ),
            (
                ProfileFacts { mandatory: true, ..ProfileFacts::default() },
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
        ];
        for (facts, reason) in cases {
            let dirs = dirs();
            seed_legacy(&dirs);

            let resolution = resolve(&dirs.legacy, &dirs.local, &Facts(facts), &NoHooks);

            assert_eq!(resolution.dir, dirs.legacy);
            assert_eq!(resolution.notices, vec![StorageNotice::LocalLessDurable { reason }]);
            assert!(record(&dirs).is_none(), "no record: the guard is re-evaluated at every start");
            assert!(!dirs.local.join(CONFIG_FILE).exists());

            // Once the policy clears, the move runs.
            assert!(resolve_local(&dirs).moved);
        }
    }

    #[test]
    fn a_roaming_profile_without_the_delete_policy_moves() {
        let dirs = dirs();
        seed_legacy(&dirs);
        let facts = ProfileFacts { roaming: true, ..ProfileFacts::default() };
        assert!(resolve(&dirs.legacy, &dirs.local, &Facts(facts), &NoHooks).moved);
    }

    #[test]
    fn an_unreachable_roaming_folder_postpones_the_move() {
        let root = tempfile::tempdir().unwrap();
        // `Roaming` itself does not exist: an offline redirected share.
        let legacy = root.path().join("Roaming").join("app.markiro.signer");
        let local = root.path().join("Local").join("app.markiro.signer");

        let resolution = resolve(&legacy, &local, &Local, &NoHooks);

        assert_eq!(resolution.dir, legacy);
        assert_eq!(resolution.notices, vec![StorageNotice::MovePostponed]);
        assert!(!local.join(RECORD_FILE).exists(), "never commit `fresh` on an unreachable share");
    }

    #[test]
    fn a_copy_that_does_not_read_back_postpones_the_move() {
        let dirs = dirs();
        seed_legacy(&dirs);
        let local_config = dirs.local.join(CONFIG_FILE);

        let resolution = resolve(
            &dirs.legacy,
            &dirs.local,
            &Local,
            &At(Step::VerifyConfig, || fs::write(&local_config, b"{\"flipped\":true}").unwrap()),
        );

        assert_eq!(resolution.dir, dirs.legacy);
        assert_eq!(resolution.notices, vec![StorageNotice::MovePostponed]);
        assert!(record(&dirs).is_none());
        assert!(resolve_local(&dirs).moved, "the next start completes");
        assert_eq!(fs::read(&local_config).unwrap(), PAIRED);
    }

    #[test]
    fn the_same_folder_needs_no_move() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("app.markiro.signer");
        write(&dir.join(CONFIG_FILE), PAIRED);

        let resolution = resolve(&dir, &dir, &Local, &NoHooks);

        assert_eq!(resolution.dir, dir);
        assert!(!resolution.moved);
        assert_eq!(fs::read(dir.join(CONFIG_FILE)).unwrap(), PAIRED);
    }

    #[test]
    fn an_unreadable_record_keeps_a_local_config_and_deletes_nothing() {
        let dirs = dirs();
        seed_legacy(&dirs);
        write(&dirs.local.join(CONFIG_FILE), OTHER_AGENT);
        write(&dirs.local.join(RECORD_FILE), b"{ not json");

        let resolution = resolve_local(&dirs);

        assert_eq!(resolution.dir, dirs.local);
        assert!(!resolution.moved);
        assert_eq!(fs::read(dirs.local.join(CONFIG_FILE)).unwrap(), OTHER_AGENT);
        assert_eq!(fs::read(dirs.legacy.join(CONFIG_FILE)).unwrap(), PAIRED);
    }

    #[test]
    fn an_unreadable_record_without_a_local_config_counts_as_absent() {
        let dirs = dirs();
        seed_legacy(&dirs);
        write(&dirs.local.join(RECORD_FILE), b"{ not json");

        assert!(resolve_local(&dirs).moved);
        assert_eq!(record(&dirs).unwrap().how, How::Migrated);
    }

    #[test]
    fn a_support_placed_local_config_is_adopted() {
        let dirs = dirs();
        write(&dirs.local.join(CONFIG_FILE), PAIRED);

        let resolution = resolve_local(&dirs);

        assert_eq!(resolution.dir, dirs.local);
        assert_eq!(record(&dirs).unwrap().how, How::Adopted);
        assert_eq!(fs::read(dirs.local.join(CONFIG_FILE)).unwrap(), PAIRED);
    }

    #[test]
    fn a_journal_without_a_config_still_moves() {
        let dirs = dirs();
        write(&dirs.legacy.join("journal").join("signer.jsonl"), b"{\"message\":\"unpaired\"}\n");

        let resolution = resolve_local(&dirs);

        assert!(resolution.moved);
        assert!(!dirs.local.join(CONFIG_FILE).exists());
        assert!(dirs.local.join("journal").join("signer.jsonl").exists());
        assert!(roaming_leftovers(&dirs).is_empty());
    }

    #[test]
    fn the_fingerprint_is_fnv1a_64() {
        // Published FNV-1a 64-bit test vectors.
        assert_eq!(Fingerprint::of(b"").fnv1a64, "cbf29ce484222325");
        assert_eq!(Fingerprint::of(b"a").fnv1a64, "af63dc4c8601ec8c");
        assert_eq!(Fingerprint::of(b"foobar").fnv1a64, "85944171f73967e8");
        assert_eq!(Fingerprint::of(b"foobar").len, 6);
    }

    #[cfg(windows)]
    #[test]
    fn a_dpapi_blob_still_decrypts_after_the_move() {
        use crate::storage::SecretStore as _;
        use crate::storage_dpapi::DpapiStore;

        let dirs = dirs();
        let blob = DpapiStore.protect("example-agent-secret").unwrap();
        storage::write_config(
            &dirs.legacy,
            &storage::AgentConfig {
                agent_id: Some("a-1".into()),
                server_url: Some("https://admin.markiro.app".into()),
                agent_secret_protected: Some(blob),
                ..storage::AgentConfig::default()
            },
        )
        .unwrap();

        let resolution = resolve_local(&dirs);

        let moved = storage::read_config(&resolution.dir).unwrap();
        assert_eq!(
            DpapiStore.unprotect(&moved.agent_secret_protected.unwrap()).unwrap(),
            "example-agent-secret"
        );
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/signer/Cargo.toml -p signer-core storage_location`
Expected: compilation fails, because `resolve`, `roamed_copy`, `Resolution`, `Step`, `Hooks`, `read_record`, `Record` and the other move items are not defined yet.

- [ ] **Step 4: Write the implementation**

In `storage_location.rs`, replace the single import `use serde::Serialize;` with:

```rust
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::journal::{JOURNAL_DIR, LOG_FILE_NAME};
use crate::storage::{self, CONFIG_FILE};
```

Then insert this block immediately before `#[cfg(test)]` / `mod tests {` (that is, after the non-Windows `fn system_profile_facts`):

```rust
/// The move record, in the local folder.
pub const RECORD_FILE: &str = "signer-storage.json";
/// Held while resolving: the single-instance mutex is per logon session, so
/// two sessions of one user on a terminal server could otherwise race.
pub const LOCK_FILE: &str = "signer-storage.lock";

const CONFIG_TEMP_FILE: &str = ".signer.json.tmp";
const RECORD_VERSION: u32 = 1;
const RENAME_ATTEMPTS: u32 = 3;
const RENAME_RETRY_DELAY: Duration = Duration::from_millis(250);

/// The points where a test can make the move fail. Production passes
/// `NoHooks`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    CopyConfig,
    VerifyConfig,
    CopyJournal,
    Commit,
    Retire,
    DeleteRetired,
}

pub trait Hooks {
    fn before(&self, _step: Step) -> io::Result<()> {
        Ok(())
    }
}

pub struct NoHooks;

impl Hooks for NoHooks {}

/// What `resolve` decided for this run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolution {
    /// The folder the runtime reads and writes this run.
    pub dir: PathBuf,
    pub notices: Vec<StorageNotice>,
    /// This run moved the data out of the roaming folder.
    pub moved: bool,
    /// The move could not carry the previous journal over completely.
    pub journal_left_behind: bool,
    /// Run `roamed_copy` off the startup path: the local folder is
    /// authoritative and the roaming folder should hold nothing of ours.
    pub check_roamed_copy: bool,
}

impl Resolution {
    fn local(dir: &Path) -> Self {
        Self {
            dir: dir.to_path_buf(),
            notices: Vec::new(),
            moved: false,
            journal_left_behind: false,
            check_roamed_copy: false,
        }
    }

    fn legacy(dir: &Path, notice: StorageNotice) -> Self {
        Self {
            notices: vec![notice],
            ..Self::local(dir)
        }
    }
}

/// Decides where the agent state lives this run, moving it out of the roaming
/// folder once. Never fails: every problem falls back to a usable folder plus
/// a notice, because the worst outcome for the agent is a new pairing.
pub fn resolve(
    legacy_dir: &Path,
    local_dir: &Path,
    probe: &dyn ProfileProbe,
    hooks: &dyn Hooks,
) -> Resolution {
    if legacy_dir == local_dir {
        // macOS: both folders are Application Support. Nothing to move.
        let _ = write_record(local_dir, &Record::committed(How::SameDirectory));
        return Resolution::local(local_dir);
    }
    let _lock = match lock_local(local_dir) {
        Ok(lock) => lock,
        Err(_) => return Resolution::legacy(legacy_dir, StorageNotice::MovePostponed),
    };
    match read_record(local_dir) {
        RecordState::Committed(record) => {
            return finish_committed(legacy_dir, local_dir, record, hooks)
        }
        // Never guess at a record we cannot read: the local copy stays
        // authoritative and nothing is deleted.
        RecordState::Unreadable if local_dir.join(CONFIG_FILE).exists() => {
            return Resolution::local(local_dir)
        }
        RecordState::Unreadable | RecordState::Absent => {}
    }
    if let Some(reason) = probe.facts().local_less_durable() {
        return Resolution::legacy(legacy_dir, StorageNotice::LocalLessDurable { reason });
    }
    let legacy = match LegacyContents::read(legacy_dir) {
        Ok(legacy) => legacy,
        Err(_) => return Resolution::legacy(legacy_dir, StorageNotice::MovePostponed),
    };
    if legacy.is_empty() {
        let how = if local_dir.join(CONFIG_FILE).exists() {
            How::Adopted
        } else {
            How::Fresh
        };
        // A `fresh` record matters: without it, a copy that roams in later
        // would be moved in as if it were ours.
        return match write_record(local_dir, &Record::committed(how)) {
            Ok(()) => Resolution::local(local_dir),
            Err(_) => Resolution::legacy(legacy_dir, StorageNotice::MovePostponed),
        };
    }
    migrate(legacy_dir, local_dir, &legacy, hooks)
}

/// Reports pairing data that turned up in the roaming folder after the move.
/// It is never loaded and never deleted (station decision D3): it may be
/// another computer's live copy. Run it off the startup path, because a
/// redirected share can hang for its whole network timeout; every error
/// counts as "nothing there".
pub fn roamed_copy(legacy_dir: &Path, local_dir: &Path) -> Option<StorageNotice> {
    let theirs = legacy_dir.join(CONFIG_FILE);
    if !fs::exists(&theirs).unwrap_or(false) {
        return None;
    }
    Some(StorageNotice::RoamedCopyPresent {
        same_agent: same_agent(&theirs, &local_dir.join(CONFIG_FILE)),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    version: u32,
    how: How,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cleanup: Option<Cleanup>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retired_dir: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    copied_config: Option<Fingerprint>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum How {
    Fresh,
    Adopted,
    Migrated,
    SameDirectory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Cleanup {
    Pending,
    Done,
}

impl Record {
    fn committed(how: How) -> Self {
        Self {
            version: RECORD_VERSION,
            how,
            cleanup: None,
            retired_dir: None,
            copied_config: None,
        }
    }

    fn migrated(retired_dir: PathBuf, copied_config: Option<Fingerprint>) -> Self {
        Self {
            cleanup: Some(Cleanup::Pending),
            retired_dir: Some(retired_dir),
            copied_config,
            ..Self::committed(How::Migrated)
        }
    }
}

/// Identifies the exact `signer.json` bytes the move copied, so the retire
/// step deletes only that file and never one another computer wrote since.
/// FNV-1a is enough: it guards against a changed file, not an adversary, and
/// needs no new crate. The record keeps no credential material.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fingerprint {
    len: u64,
    fnv1a64: String,
}

impl Fingerprint {
    fn of(bytes: &[u8]) -> Self {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        Self {
            len: bytes.len() as u64,
            fnv1a64: format!("{hash:016x}"),
        }
    }
}

enum RecordState {
    Absent,
    Committed(Record),
    Unreadable,
}

fn read_record(local_dir: &Path) -> RecordState {
    match fs::read(local_dir.join(RECORD_FILE)) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(record) => RecordState::Committed(record),
            Err(_) => RecordState::Unreadable,
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => RecordState::Absent,
        Err(_) => RecordState::Unreadable,
    }
}

fn write_record(local_dir: &Path, record: &Record) -> io::Result<()> {
    let bytes = serde_json::to_vec_pretty(record).map_err(io::Error::other)?;
    storage::write_atomic(local_dir, RECORD_FILE, &bytes)
}

fn lock_local(local_dir: &Path) -> io::Result<File> {
    fs::create_dir_all(local_dir)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(local_dir.join(LOCK_FILE))?;
    file.lock()?;
    Ok(file)
}

/// What the legacy folder holds that the move carries over.
struct LegacyContents {
    config: Option<Vec<u8>>,
    journal: Vec<OsString>,
}

impl LegacyContents {
    fn read(legacy_dir: &Path) -> io::Result<Self> {
        ensure_parent_reachable(legacy_dir)?;
        let config = match fs::read(legacy_dir.join(CONFIG_FILE)) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        Ok(Self {
            config,
            journal: journal_files(&legacy_dir.join(JOURNAL_DIR))?,
        })
    }

    fn is_empty(&self) -> bool {
        self.config.is_none() && self.journal.is_empty()
    }
}

/// "Not found" is believed only when the roaming folder's parent answers:
/// Windows can report an offline network path as not found as well, and a
/// redirected `%APPDATA%` is a network path.
fn ensure_parent_reachable(dir: &Path) -> io::Result<()> {
    match dir.parent() {
        Some(parent) => fs::metadata(parent).map(|_| ()),
        None => Ok(()),
    }
}

/// The journal files (`signer.jsonl`, `signer.jsonl.1`, …) in `dir`.
fn journal_files(dir: &Path) -> io::Result<Vec<OsString>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        if name.to_string_lossy().starts_with(LOG_FILE_NAME) && entry.file_type()?.is_file() {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

fn migrate(
    legacy_dir: &Path,
    local_dir: &Path,
    legacy: &LegacyContents,
    hooks: &dyn Hooks,
) -> Resolution {
    // Until the record is written the legacy folder stays authoritative, so
    // anything already in the local folder is a leftover of an interrupted run
    // and is overwritten.
    let copied_config = match &legacy.config {
        Some(bytes) => match copy_verified(local_dir, bytes, hooks) {
            Ok(()) => Some(Fingerprint::of(bytes)),
            Err(_) => return Resolution::legacy(legacy_dir, StorageNotice::MovePostponed),
        },
        None => None,
    };
    // The journal is diagnostics: a failed copy is noted, not fatal.
    let journal_left_behind = copy_journal(legacy_dir, local_dir, &legacy.journal, hooks).is_err();

    let record = Record::migrated(retired_dir_for(legacy_dir), copied_config);
    if hooks
        .before(Step::Commit)
        .and_then(|()| write_record(local_dir, &record))
        .is_err()
    {
        return Resolution::legacy(legacy_dir, StorageNotice::MovePostponed);
    }

    // From here on the local folder is authoritative.
    let cleanup = finish_cleanup(legacy_dir, local_dir, record, hooks);
    Resolution {
        notices: cleanup.notices,
        moved: true,
        journal_left_behind,
        check_roamed_copy: cleanup.check_roamed_copy,
        ..Resolution::local(local_dir)
    }
}

fn copy_verified(local_dir: &Path, bytes: &[u8], hooks: &dyn Hooks) -> io::Result<()> {
    hooks.before(Step::CopyConfig)?;
    storage::write_atomic(local_dir, CONFIG_FILE, bytes)?;
    hooks.before(Step::VerifyConfig)?;
    if fs::read(local_dir.join(CONFIG_FILE))? != bytes {
        return Err(io::Error::other("the copied signer.json does not match the original"));
    }
    Ok(())
}

fn copy_journal(
    legacy_dir: &Path,
    local_dir: &Path,
    names: &[OsString],
    hooks: &dyn Hooks,
) -> io::Result<()> {
    let target = local_dir.join(JOURNAL_DIR);
    for stale in journal_files(&target)? {
        fs::remove_file(target.join(stale))?;
    }
    hooks.before(Step::CopyJournal)?;
    for name in names {
        let bytes = fs::read(legacy_dir.join(JOURNAL_DIR).join(name))?;
        let name = name
            .to_str()
            .ok_or_else(|| io::Error::other("a journal file name is not UTF-8"))?;
        storage::write_atomic(&target, name, &bytes)?;
    }
    Ok(())
}

/// `<legacy>.retired-<unix nanos>-<pid>`: a sibling, so the rename stays on
/// one volume, and unique without a UUID crate.
fn retired_dir_for(legacy_dir: &Path) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let mut name = legacy_dir
        .file_name()
        .map(OsString::from)
        .unwrap_or_else(|| OsString::from("app.markiro.signer"));
    name.push(format!(".retired-{nanos:x}-{}", std::process::id()));
    legacy_dir.with_file_name(name)
}

fn finish_committed(
    legacy_dir: &Path,
    local_dir: &Path,
    record: Record,
    hooks: &dyn Hooks,
) -> Resolution {
    let mut resolution = Resolution::local(local_dir);
    match (record.how, record.cleanup) {
        (How::SameDirectory, _) => {}
        (How::Migrated, Some(Cleanup::Pending)) => {
            let cleanup = finish_cleanup(legacy_dir, local_dir, record, hooks);
            resolution.notices = cleanup.notices;
            resolution.check_roamed_copy = cleanup.check_roamed_copy;
        }
        _ => resolution.check_roamed_copy = true,
    }
    resolution
}

struct CleanupOutcome {
    notices: Vec<StorageNotice>,
    check_roamed_copy: bool,
}

/// Retires the legacy folder named in the record and records the result.
fn finish_cleanup(
    legacy_dir: &Path,
    local_dir: &Path,
    mut record: Record,
    hooks: &dyn Hooks,
) -> CleanupOutcome {
    let Some(retired_dir) = record.retired_dir.clone() else {
        return CleanupOutcome {
            notices: Vec::new(),
            check_roamed_copy: true,
        };
    };
    match retire(legacy_dir, &retired_dir, record.copied_config.as_ref(), hooks) {
        Ok(retired) => {
            record.cleanup = Some(Cleanup::Done);
            // Best effort: if this write fails, the next start retires again,
            // which is a no-op once the folders are gone.
            let _ = write_record(local_dir, &record);
            let notices = match retired {
                Retired::KeptChanged => vec![StorageNotice::RoamedCopyPresent {
                    same_agent: same_agent(
                        &retired_dir.join(CONFIG_FILE),
                        &local_dir.join(CONFIG_FILE),
                    ),
                }],
                Retired::Done | Retired::Foreign => Vec::new(),
            };
            CleanupOutcome {
                notices,
                // `Foreign` left a roaming `signer.json` in place: the
                // background check reports it.
                check_roamed_copy: true,
            }
        }
        // The legacy folder still holds our own copy; reporting it as a
        // roamed copy would be a false alarm.
        Err(_) => CleanupOutcome {
            notices: vec![StorageNotice::LegacyCleanupPending],
            check_roamed_copy: false,
        },
    }
}

enum Retired {
    /// The copied files are gone from the roaming folder.
    Done,
    /// The roaming folder holds a `signer.json` the move did not copy. It
    /// belongs to someone else now and is left in place.
    Foreign,
    /// A `signer.json` changed between the check and the rename; it stays in
    /// the retired folder.
    KeptChanged,
}

fn retire(
    legacy_dir: &Path,
    retired_dir: &Path,
    copied: Option<&Fingerprint>,
    hooks: &dyn Hooks,
) -> io::Result<Retired> {
    ensure_parent_reachable(legacy_dir)?;
    if !fs::exists(retired_dir)? {
        if !fs::exists(legacy_dir)? {
            return Ok(Retired::Done);
        }
        if !holds_only_copied_config(&legacy_dir.join(CONFIG_FILE), copied)? {
            return Ok(Retired::Foreign);
        }
        hooks.before(Step::Retire)?;
        rename_with_retries(legacy_dir, retired_dir)?;
    }
    hooks.before(Step::DeleteRetired)?;
    let config = retired_dir.join(CONFIG_FILE);
    let kept = !holds_only_copied_config(&config, copied)?;
    if !kept {
        remove_if_present(&config)?;
    }
    remove_if_present(&retired_dir.join(CONFIG_TEMP_FILE))?;
    let journal = retired_dir.join(JOURNAL_DIR);
    for name in journal_files(&journal)? {
        fs::remove_file(journal.join(name))?;
    }
    // Both succeed only when empty: unknown files stay where they are.
    let _ = fs::remove_dir(&journal);
    let _ = fs::remove_dir(retired_dir);
    Ok(if kept { Retired::KeptChanged } else { Retired::Done })
}

/// True when `path` is absent, or holds exactly the bytes the move copied.
fn holds_only_copied_config(path: &Path, copied: Option<&Fingerprint>) -> io::Result<bool> {
    match fs::read(path) {
        Ok(bytes) => Ok(copied == Some(&Fingerprint::of(&bytes))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error),
    }
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Antivirus and the search indexer hold files open for a moment; a few
/// retries ride that out.
fn rename_with_retries(from: &Path, to: &Path) -> io::Result<()> {
    let mut attempt = 1;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) if attempt >= RENAME_ATTEMPTS => return Err(error),
            Err(_) => {
                attempt += 1;
                thread::sleep(RENAME_RETRY_DELAY);
            }
        }
    }
}

fn same_agent(theirs: &Path, ours: &Path) -> bool {
    let theirs = fs::read(theirs).ok().and_then(|bytes| agent_id(&bytes));
    let ours = fs::read(ours).ok().and_then(|bytes| agent_id(&bytes));
    theirs.is_some() && theirs == ours
}

/// Only the agent id: a roamed copy is inspected, never loaded.
fn agent_id(bytes: &[u8]) -> Option<String> {
    #[derive(Deserialize)]
    struct Identity {
        #[serde(rename = "agentId")]
        agent_id: Option<String>,
    }
    serde_json::from_slice::<Identity>(bytes).ok()?.agent_id
}
```

Notes for the reviewer:

- `copy_verified` reads the copy back and compares it byte for byte; a failure there runs this start from the roaming folder (`MovePostponed`) and the next start retries.
- `retire` renames the roaming folder only when its `signer.json` still matches the copied fingerprint; a different file belongs to someone else (`Retired::Foreign`) and is left in place for the roamed-copy check to report.
- `ensure_parent_reachable` guards "not found": an offline redirected `%APPDATA%` must never be mistaken for "no roaming data" and committed as `fresh`.
- `resolve` holds `signer-storage.lock` (`std::fs::File::lock`, stable since Rust 1.89; CI uses stable, local 1.93 works) while it runs.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test --manifest-path apps/signer/Cargo.toml -p signer-core storage`
Expected: `test result: ok. 31 passed` (6 in `storage::tests`, 3 in `storage_location::tests`, 22 in `storage_location::move_tests`), no warnings. `a_dpapi_blob_still_decrypts_after_the_move` is `#[cfg(windows)]` and runs in the `signer-windows-build` job.

- [ ] **Step 6: Commit**

```bash
git add apps/signer/signer-core/src/storage.rs apps/signer/signer-core/src/journal.rs apps/signer/signer-core/src/runtime.rs apps/signer/signer-core/src/storage_location.rs
git commit -m "feat(signer): однократный перенос данных агента из перемещаемого профиля

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Runtime — storage notices and a kept credential

**Files:**

- Modify: `apps/signer/signer-core/src/runtime.rs`

**Interfaces:**

- Consumes: `storage_location::{Resolution, StorageNotice}` (Tasks 1-2).
- Produces:
  - `AgentStatus.storage_notices: Vec<StorageNotice>` — JSON field `storageNotices`.
  - `pub fn Runtime::apply_storage_resolution(&self, resolution: &Resolution)` — journals the move and reports each notice.
  - `pub fn Runtime::report_storage_notice(&self, notice: StorageNotice)` — shows it once and journals it once.
  - Private: `enum Unlock { Secret { secret: String, recovered: bool }, Unreadable }`, `fn unlock_secret(&self, protected: &str) -> Unlock`, `fn add_notice`, `fn remove_notice`.

- [ ] **Step 1: Write the failing tests**

In the `#[cfg(test)] mod tests` of `runtime.rs`, insert these helpers immediately before `    struct PayloadSigner;`:

```rust
    /// Refuses to decrypt until `readable` is set, like DPAPI when the blob
    /// belongs to another Windows user or the user's keys are out of reach.
    struct ToggleStore {
        readable: std::sync::atomic::AtomicBool,
    }
    impl ToggleStore {
        fn unreadable() -> Self {
            Self {
                readable: std::sync::atomic::AtomicBool::new(false),
            }
        }
        fn make_readable(&self) {
            self.readable.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    impl SecretStore for ToggleStore {
        fn protect(&self, plaintext: &str) -> Result<String, SignerError> {
            Ok(plaintext.to_string())
        }
        fn unprotect(&self, protected: &str) -> Result<String, SignerError> {
            if self.readable.load(std::sync::atomic::Ordering::SeqCst) {
                Ok(protected.to_string())
            } else {
                Err(SignerError::Storage(
                    "DPAPI could not read the stored secret; re-pair this agent".into(),
                ))
            }
        }
    }

    fn paired_config() -> AgentConfig {
        AgentConfig {
            agent_id: Some("a-1".into()),
            tenant_name: Some("ООО Ромашка".into()),
            server_url: Some("https://admin.markiro.app".into()),
            cert_thumbprint: Some("AB12".into()),
            agent_secret_protected: Some("protected".into()),
        }
    }

    fn runtime_with_store(store: Arc<ToggleStore>) -> (tempfile::TempDir, Runtime) {
        let dir = tempfile::tempdir().unwrap();
        storage::write_config(dir.path(), &paired_config()).unwrap();
        let runtime = Runtime::new(
            dir.path().to_path_buf(),
            Arc::new(NoSigner),
            store,
            "0.1.0".into(),
        )
        .unwrap();
        (dir, runtime)
    }

    fn journal_count(runtime: &Runtime, message: &str) -> usize {
        runtime
            .status()
            .journal
            .iter()
            .filter(|entry| entry.message == message)
            .count()
    }
```

and insert these tests immediately before `    #[test]` / `fn a_short_thumbprint_survives_journal_redaction() {`:

```rust
    #[test]
    fn an_unreadable_credential_is_kept_and_asks_for_a_new_pairing() {
        let (dir, runtime) = runtime_with_store(Arc::new(ToggleStore::unreadable()));

        assert_eq!(runtime.unlock_secret("protected"), Unlock::Unreadable);
        assert_eq!(runtime.unlock_secret("protected"), Unlock::Unreadable);

        // The file keeps the credential: a local decryption failure is not a
        // reason to destroy it (spec §7.6).
        assert_eq!(storage::read_config(dir.path()).unwrap(), paired_config());
        let status = runtime.status();
        assert_eq!(status.phase, AgentPhase::Unpaired);
        assert_eq!(status.storage_notices, vec![StorageNotice::CredentialUnreadable]);
        assert_eq!(journal_count(&runtime, "Stored credential is unreadable"), 1);
    }

    #[test]
    fn a_credential_that_becomes_readable_again_returns_to_work() {
        let store = Arc::new(ToggleStore::unreadable());
        let (_dir, runtime) = runtime_with_store(store.clone());
        assert_eq!(runtime.unlock_secret("protected"), Unlock::Unreadable);

        store.make_readable();

        assert_eq!(
            runtime.unlock_secret("protected"),
            Unlock::Secret {
                secret: "protected".into(),
                recovered: true
            }
        );
        let status = runtime.status();
        assert_eq!(status.phase, AgentPhase::Idle);
        assert!(status.storage_notices.is_empty());
        assert_eq!(
            runtime.unlock_secret("protected"),
            Unlock::Secret {
                secret: "protected".into(),
                recovered: false
            }
        );
    }

    #[test]
    fn unpairing_clears_the_unreadable_notice() {
        let (dir, runtime) = runtime_with_store(Arc::new(ToggleStore::unreadable()));
        runtime.unlock_secret("protected");

        runtime.unpair().unwrap();

        assert!(runtime.status().storage_notices.is_empty());
        assert_eq!(storage::read_config(dir.path()).unwrap().agent_secret_protected, None);
    }

    #[tokio::test]
    async fn pairing_again_clears_the_unreadable_notice() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/signer-agent/pair"))
            .respond_with(ResponseTemplate::new(201).set_body_string(
                r#"{"agentId":"3f0e0f5e-8d1c-4d7a-9b1a-111111111111",
                    "agentSecret":"example-agent-secret-not-a-real-credential",
                    "tenantName":"ООО Ромашка"}"#,
            ))
            .expect(1)
            .mount(&server)
            .await;
        let (dir, runtime) = runtime_with_store(Arc::new(ToggleStore::unreadable()));
        runtime.unlock_secret("protected");

        runtime.pair(&server.uri(), "01234567").await.unwrap();

        let status = runtime.status();
        assert!(status.storage_notices.is_empty());
        assert_eq!(status.phase, AgentPhase::Idle);
        assert_eq!(
            storage::read_config(dir.path()).unwrap().agent_secret_protected.as_deref(),
            Some("example-agent-secret-not-a-real-credential")
        );
    }

    #[test]
    fn storage_notices_reach_the_status_and_the_journal_once() {
        let (_dir, runtime) = test_runtime();
        let resolution = Resolution {
            dir: std::path::PathBuf::from("unused"),
            notices: vec![StorageNotice::LegacyCleanupPending],
            moved: true,
            journal_left_behind: true,
            check_roamed_copy: false,
        };

        runtime.apply_storage_resolution(&resolution);
        runtime.report_storage_notice(StorageNotice::LegacyCleanupPending);
        runtime.report_storage_notice(StorageNotice::RoamedCopyPresent { same_agent: true });

        assert_eq!(
            runtime.status().storage_notices,
            vec![
                StorageNotice::LegacyCleanupPending,
                StorageNotice::RoamedCopyPresent { same_agent: true },
            ]
        );
        assert_eq!(journal_count(&runtime, "Agent data moved out of the roaming profile"), 1);
        assert_eq!(
            journal_count(&runtime, "The previous journal could not be carried over completely"),
            1
        );
        assert_eq!(
            journal_count(&runtime, StorageNotice::LegacyCleanupPending.journal_message()),
            1
        );
    }

    #[test]
    fn the_status_carries_storage_notices_for_the_webview() {
        let (_dir, runtime) = test_runtime();
        runtime.report_storage_notice(StorageNotice::RoamedCopyPresent { same_agent: true });

        let json = serde_json::to_value(runtime.status()).unwrap();

        assert_eq!(
            json["storageNotices"],
            serde_json::json!([{ "kind": "roamedCopyPresent", "sameAgent": true }])
        );
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/signer/Cargo.toml -p signer-core runtime::tests`
Expected: compilation fails, because `Unlock`, `unlock_secret`, `apply_storage_resolution`, `report_storage_notice` and `AgentStatus.storage_notices` do not exist yet, and `Resolution`/`StorageNotice` are not imported.

- [ ] **Step 3: Write the implementation**

All edits are in `apps/signer/signer-core/src/runtime.rs`.

(a) Imports — after `use crate::storage::{self, AgentConfig, SecretStore};` add:

```rust
use crate::storage_location::{Resolution, StorageNotice};
```

(b) `AgentStatus` — after `pub journal: Vec<JournalEntry>,` add:

```rust
    /// Storage facts the operator should see: where the data lives and why,
    /// and a credential DPAPI cannot read (spec
    /// `2026-09-27-signer-local-storage-design.md` §7.7).
    pub storage_notices: Vec<StorageNotice>,
```

(c) Immediately before `#[derive(Debug, Clone, Copy, PartialEq, Eq)]` / `enum PollTransition {` add:

```rust
/// The outcome of decrypting the stored credential for one loop iteration.
#[derive(Debug, PartialEq, Eq)]
enum Unlock {
    /// Decrypted. `recovered`: the previous attempt had failed, so the UI must
    /// leave the pairing screen it was showing.
    Secret { secret: String, recovered: bool },
    /// DPAPI refused; the file is kept (spec §7.6).
    Unreadable,
}

```

(d) `struct Runtime` — after `last_error: Mutex<Option<String>>,` add `storage_notices: Mutex<Vec<StorageNotice>>,`; in `Runtime::new`, after `last_error: Mutex::new(None),` add `storage_notices: Mutex::new(Vec::new()),`.

(e) `status()` and the new methods — replace the end of `status()`

```rust
            last_error: self.last_error.lock().ok().and_then(|g| g.clone()),
            journal: self.journal_entries(),
        }
    }
```

with:

```rust
            last_error: self.last_error.lock().ok().and_then(|g| g.clone()),
            journal: self.journal_entries(),
            storage_notices: self
                .storage_notices
                .lock()
                .map(|notices| notices.clone())
                .unwrap_or_default(),
        }
    }

    /// Journals what `storage_location::resolve` did at startup and keeps its
    /// notices for `status()`.
    pub fn apply_storage_resolution(&self, resolution: &Resolution) {
        if resolution.moved {
            self.note("Agent data moved out of the roaming profile", None);
            if resolution.journal_left_behind {
                self.note("The previous journal could not be carried over completely", None);
            }
        }
        for notice in &resolution.notices {
            self.report_storage_notice(notice.clone());
        }
    }

    /// Shows `notice` in the status and journals it the first time.
    pub fn report_storage_notice(&self, notice: StorageNotice) {
        if self.add_notice(notice.clone()) {
            self.note(notice.journal_message(), None);
        }
    }

    /// Adds `notice` unless it is already shown; true when it was added.
    fn add_notice(&self, notice: StorageNotice) -> bool {
        let Ok(mut notices) = self.storage_notices.lock() else {
            return false;
        };
        if notices.contains(&notice) {
            return false;
        }
        notices.push(notice);
        true
    }

    /// True when `notice` was shown and is now gone.
    fn remove_notice(&self, notice: &StorageNotice) -> bool {
        let Ok(mut notices) = self.storage_notices.lock() else {
            return false;
        };
        let before = notices.len();
        notices.retain(|shown| shown != notice);
        notices.len() != before
    }

    /// Decrypts the stored credential for one loop iteration. A failure never
    /// deletes it (spec §7.6): the blob may belong to another Windows user, or
    /// DPAPI may be unable to reach this user's keys right now, for example
    /// when a redirected roaming folder's share is offline. The pairing screen
    /// explains, the loop keeps trying, and a new pairing overwrites the file.
    fn unlock_secret(&self, protected: &str) -> Unlock {
        match self.secrets.unprotect(protected) {
            Ok(secret) => {
                let recovered = self.remove_notice(&StorageNotice::CredentialUnreadable);
                if recovered {
                    self.note("Stored credential is readable again", None);
                    self.set_phase(AgentPhase::Idle);
                }
                Unlock::Secret { secret, recovered }
            }
            Err(error) => {
                if self.add_notice(StorageNotice::CredentialUnreadable) {
                    self.note("Stored credential is unreadable", Some(&error.to_string()));
                }
                self.set_phase(AgentPhase::Unpaired);
                Unlock::Unreadable
            }
        }
    }
```

(f) `pair()` — between the `write_config(...)...map_err(...)?;` and `self.set_phase(AgentPhase::Idle);` add:

```rust
        self.remove_notice(&StorageNotice::CredentialUnreadable);
```

(g) `unpair()` — after `storage::clear_credential(&self.config_dir)?;` add the same line:

```rust
        self.remove_notice(&StorageNotice::CredentialUnreadable);
```

(h) `run()` — replace the whole `let secret = match self.secrets.unprotect(&protected) { ... };` statement (the branch that called `self.unpair()` on a DPAPI failure) with:

```rust
            let secret = match self.unlock_secret(&protected) {
                Unlock::Secret { secret, recovered } => {
                    if recovered {
                        on_change(self.status());
                    }
                    secret
                }
                Unlock::Unreadable => {
                    // `is_paired()` stays true while the file is kept, so the
                    // backoff is what stops this branch from busy-spinning.
                    on_change(self.status());
                    tokio::time::sleep(backoff_for(failures)).await;
                    failures = failures.saturating_add(1);
                    continue;
                }
            };
```

The old comment "The blob belongs to another user or profile: pairing again is the only recovery" goes away with it; `unlock_secret`'s doc comment replaces it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path apps/signer/Cargo.toml -p signer-core`
Expected (loopback allowed): `test result: ok. 111 passed`, no warnings. In a sandbox without loopback, 27 wiremock tests fail with `Failed to bind an OS port` — including the new `pairing_again_clears_the_unreadable_notice`; everything else passes.

- [ ] **Step 5: Commit**

```bash
git add apps/signer/signer-core/src/runtime.rs
git commit -m "fix(signer): нечитаемый секрет больше не стирается, уведомления о хранилище в статусе

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The shell uses the local folder

**Files:**

- Modify: `apps/signer/src-tauri/src/lib.rs:7`, `:39-41`, `:61-62`, `:94-96`

**Interfaces:**

- Consumes: `storage_location::{resolve, roamed_copy, NoHooks, SystemProfileProbe}`, `Resolution.{dir, check_roamed_copy}`, `Runtime::{apply_storage_resolution, report_storage_notice, status}`.
- Produces: the running app keeps its state in `resolution.dir`.

- [ ] **Step 1: Wire the resolution into `setup`**

(a) After `use signer_core::runtime::Runtime;` add:

```rust
use signer_core::storage_location::{self, NoHooks, SystemProfileProbe};
```

(b) Replace

```rust
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let version = app.package_info().version.to_string();
```

with:

```rust
        .setup(|app| {
            // Releases up to 0.1.4 kept the agent state in the roaming
            // %APPDATA% folder; it moves once into %LOCALAPPDATA%, which
            // Windows neither roams nor redirects
            // (docs/superpowers/specs/2026-09-27-signer-local-storage-design.md).
            let legacy_dir = app.path().app_config_dir()?;
            let local_dir = app.path().app_local_data_dir()?;
            let storage =
                storage_location::resolve(&legacy_dir, &local_dir, &SystemProfileProbe, &NoHooks);
            let version = app.package_info().version.to_string();
```

The resolution runs synchronously on purpose: the window starts hidden (`tauri.conf.json` `"visible": false`), today's `Runtime::new` already reads the same folder synchronously, and after the move startup no longer touches the roaming folder.

(c) Replace

```rust
            let runtime = Runtime::new(config_dir, signer, secrets, version)?;
            let runtime = Arc::new(runtime);
```

with:

```rust
            let runtime = Runtime::new(storage.dir.clone(), signer, secrets, version)?;
            runtime.apply_storage_resolution(&storage);
            let runtime = Arc::new(runtime);
```

(d) After the `app.manage(commands::SignerState { runtime: runtime.clone(), });` statement add:

```rust

            if storage.check_roamed_copy {
                // Off the startup path: a redirected roaming share can hang for
                // its whole network timeout.
                let runtime = runtime.clone();
                let handle = app.handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Some(notice) = storage_location::roamed_copy(&legacy_dir, &local_dir) {
                        runtime.report_storage_notice(notice);
                        let status = runtime.status();
                        handle
                            .state::<tray::TrayController>()
                            .update_status(&handle, &status);
                        let _ = handle.emit(STATUS_EVENT, status);
                    }
                });
            }
```

It must come after `app.manage(tray_controller)`, because it reads the tray state.

- [ ] **Step 2: Build and run the whole workspace**

Run:

```bash
cargo build --manifest-path apps/signer/Cargo.toml
cargo test --manifest-path apps/signer/Cargo.toml
```

Expected: the build finishes without warnings; `markiro_signer_lib` 7 passed and `signer_core` 111 passed (loopback allowed). The shell has no unit test for `setup`; its behaviour is covered by the manual checks in Task 7.

- [ ] **Step 3: Commit**

```bash
git add apps/signer/src-tauri/src/lib.rs
git commit -m "feat(signer): агент хранит данные в %LOCALAPPDATA%

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Webview — notices on the Status and pairing screens

**Files:**

- Modify: `apps/signer/src/lib/bridge.ts`
- Create: `apps/signer/src/lib/storage-notices.ts`
- Create: `apps/signer/src/components/StorageNotices.tsx`
- Modify: `apps/signer/src/pages/Status.tsx`, `apps/signer/src/pages/Pairing.tsx`, `apps/signer/src/App.tsx`, `apps/signer/src/signer.css`
- Modify: `apps/signer/src/i18n/en.json`, `apps/signer/src/i18n/ru.json`
- Test: `apps/signer/test/storage-notices.test.tsx` (new), `apps/signer/test/i18n-parity.test.ts` (new), fixtures in `test/app-state.test.ts`, `test/app-status-race.test.tsx`, `test/status-journal.test.tsx`

**Interfaces:**

- Consumes: the JSON field `storageNotices` from Task 3 (`{"kind": ..., ...}` objects, Task 1 serialization).
- Produces:
  - `export type StorageNotice` and `AgentStatus.storageNotices: StorageNotice[]` in `src/lib/bridge.ts`.
  - `export function storageNoticeKey(notice: StorageNotice): string` and `export function concernsPairing(notice: StorageNotice): boolean` in `src/lib/storage-notices.ts`.
  - `export function StorageNotices({ notices }: { notices: readonly StorageNotice[] }): ReactElement | null`.
  - `Pairing` gets the optional prop `notices?: readonly StorageNotice[]`.

- [ ] **Step 1: Write the failing tests**

Create `apps/signer/test/storage-notices.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { App } from "../src/App.js";
import type { AgentStatus, StorageNotice } from "../src/lib/bridge.js";
import { concernsPairing, storageNoticeKey } from "../src/lib/storage-notices.js";
import { Pairing } from "../src/pages/Pairing.js";
import { Status } from "../src/pages/Status.js";

vi.mock("../src/lib/bridge.js", () => ({
  bridge: {
    autostartEnabled: vi.fn().mockResolvedValue(true),
    setAutostartEnabled: vi.fn(),
    status: vi.fn(),
    onStatus: vi.fn(() => Promise.resolve(() => {})),
    listCertificates: vi.fn().mockResolvedValue([]),
    selectCertificate: vi.fn(),
    unpair: vi.fn(),
    pair: vi.fn(),
    exportJournal: vi.fn(),
  },
}));

const EVERY_NOTICE: StorageNotice[] = [
  { kind: "localLessDurable", reason: "temporaryProfile" },
  { kind: "localLessDurable", reason: "mandatoryProfile" },
  { kind: "localLessDurable", reason: "deleteRoamingCache" },
  { kind: "movePostponed" },
  { kind: "legacyCleanupPending" },
  { kind: "roamedCopyPresent", sameAgent: true },
  { kind: "roamedCopyPresent", sameAgent: false },
  { kind: "credentialUnreadable" },
];

function status(overrides: Partial<AgentStatus>): AgentStatus {
  return {
    phase: "idle",
    appVersion: "0.2.0",
    hostname: "BUH-PC",
    tenantName: "ООО Ромашка",
    certThumbprint: null,
    lastTokenExpiresAt: null,
    lastError: null,
    journal: [],
    storageNotices: [],
    ...overrides,
  };
}

describe("storage notices", () => {
  it("words every notice in both languages", () => {
    for (const notice of EVERY_NOTICE) {
      const key = storageNoticeKey(notice);
      expect(i18n.exists(key, { lng: "ru" }), `${key} (ru)`).toBe(true);
      expect(i18n.exists(key, { lng: "en" }), `${key} (en)`).toBe(true);
    }
  });

  it("shows every notice on the status tab", () => {
    render(
      <Status
        status={status({
          storageNotices: [
            { kind: "roamedCopyPresent", sameAgent: true },
            { kind: "movePostponed" },
          ],
        })}
        onChanged={vi.fn()}
        onCheckForUpdate={vi.fn().mockResolvedValue({ status: "current" })}
      />,
    );

    expect(screen.getByText(/копия привязки этого агента/)).toBeDefined();
    expect(screen.getByText(/пока не удалось перенести/)).toBeDefined();
  });

  it("shows nothing extra when there is nothing to report", () => {
    const { container } = render(
      <Status
        status={status({})}
        onChanged={vi.fn()}
        onCheckForUpdate={vi.fn().mockResolvedValue({ status: "current" })}
      />,
    );

    expect(container.querySelector(".signer-storage-notices")).toBeNull();
  });

  it("repeats on the pairing screen only what concerns pairing", () => {
    render(
      <Pairing
        hostname="BUH-PC"
        onPair={vi.fn()}
        notices={[
          { kind: "credentialUnreadable" },
          { kind: "localLessDurable", reason: "temporaryProfile" },
          { kind: "movePostponed" },
        ]}
      />,
    );

    expect(screen.getByText(/не может прочитать этот пользователь Windows/)).toBeDefined();
    expect(screen.getByText(/временным профилем/)).toBeDefined();
    expect(screen.queryByText(/пока не удалось перенести/)).toBeNull();
    expect(EVERY_NOTICE.filter(concernsPairing)).toEqual([
      { kind: "localLessDurable", reason: "temporaryProfile" },
      { kind: "localLessDurable", reason: "mandatoryProfile" },
      { kind: "credentialUnreadable" },
    ]);
  });

  it("explains an unreadable credential on the pairing screen the app opens", async () => {
    const { bridge } = await import("../src/lib/bridge.js");
    vi.mocked(bridge.status).mockResolvedValue(
      status({
        phase: "unpaired",
        tenantName: null,
        storageNotices: [{ kind: "credentialUnreadable" }],
      }),
    );

    render(<App />);

    expect(await screen.findByText(/не может прочитать этот пользователь Windows/)).toBeDefined();
    expect(screen.getByLabelText(/код привязки/i)).toBeDefined();
  });
});
```

Create `apps/signer/test/i18n-parity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import en from "../src/i18n/en.json";
import ru from "../src/i18n/ru.json";

function keys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("i18n dictionaries", () => {
  it("have the same keys in Russian and English", () => {
    expect(keys(en).sort()).toEqual(keys(ru).sort());
  });
});
```

Add `storageNotices: []` to the five existing `AgentStatus` fixtures:

```diff
--- a/apps/signer/test/app-state.test.ts
+++ b/apps/signer/test/app-state.test.ts
@@ -17,6 +17,7 @@
         lastTokenExpiresAt: null,
         lastError: null,
         journal: [],
+        storageNotices: [],
       }),
     ).toBe("pairing");
   });
@@ -33,6 +34,7 @@
           lastTokenExpiresAt: null,
           lastError: null,
           journal: [],
+          storageNotices: [],
         }),
       ).toBe("ready");
     }
--- a/apps/signer/test/app-status-race.test.tsx
+++ b/apps/signer/test/app-status-race.test.tsx
@@ -42,6 +42,7 @@
   lastTokenExpiresAt: null,
   lastError: "boom",
   journal: [],
+  storageNotices: [],
 };

 const staleSnapshot: AgentStatus = {
@@ -53,6 +54,7 @@
   lastTokenExpiresAt: null,
   lastError: null,
   journal: [],
+  storageNotices: [],
 };

 describe("App status race", () => {
--- a/apps/signer/test/status-journal.test.tsx
+++ b/apps/signer/test/status-journal.test.tsx
@@ -28,6 +28,7 @@
     message: `Событие ${index + 1}`,
     detail: index === 20 ? "Подробности последнего события" : null,
   })),
+  storageNotices: [],
 };

 describe("Status journal", () => {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/signer exec vitest run test/storage-notices.test.tsx test/i18n-parity.test.ts`
Expected: `storage-notices.test.tsx` fails to load (`Failed to resolve import "../src/lib/storage-notices.js"`); `i18n-parity.test.ts` passes (the dictionaries already match) and must stay green after the next step.

- [ ] **Step 3: Write the implementation**

`apps/signer/src/lib/bridge.ts`:

```diff
--- a/apps/signer/src/lib/bridge.ts
+++ b/apps/signer/src/lib/bridge.ts
@@ -17,8 +17,21 @@
   lastTokenExpiresAt: string | null;
   lastError: string | null;
   journal: JournalEntry[];
+  /** Storage facts the operator should see; `storage.*` in i18n words them. */
+  storageNotices: StorageNotice[];
 }

+/** Mirrors `signer_core::storage_location::StorageNotice`. */
+export type StorageNotice =
+  | {
+      kind: "localLessDurable";
+      reason: "temporaryProfile" | "mandatoryProfile" | "deleteRoamingCache";
+    }
+  | { kind: "movePostponed" }
+  | { kind: "legacyCleanupPending" }
+  | { kind: "roamedCopyPresent"; sameAgent: boolean }
+  | { kind: "credentialUnreadable" };
+
 export interface JournalEntry {
   occurredAt: string;
   message: string;
```

Create `apps/signer/src/lib/storage-notices.ts`:

```ts
import type { StorageNotice } from "./bridge.js";

/** The i18n key that words a storage notice. */
export function storageNoticeKey(notice: StorageNotice): string {
  switch (notice.kind) {
    case "localLessDurable":
      return `storage.localLessDurable.${notice.reason}`;
    case "movePostponed":
      return "storage.movePostponed";
    case "legacyCleanupPending":
      return "storage.legacyCleanupPending";
    case "roamedCopyPresent":
      return notice.sameAgent ? "storage.roamedCopy.sameAgent" : "storage.roamedCopy.otherAgent";
    case "credentialUnreadable":
      return "storage.credentialUnreadable";
  }
}

/** The pairing screen repeats only what affects the pairing itself: a
 *  credential this Windows user cannot read, and a profile that discards
 *  everything at sign-out. */
export function concernsPairing(notice: StorageNotice): boolean {
  return (
    notice.kind === "credentialUnreadable" ||
    (notice.kind === "localLessDurable" && notice.reason !== "deleteRoamingCache")
  );
}
```

Create `apps/signer/src/components/StorageNotices.tsx`:

```tsx
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "@markiro/ui";
import type { StorageNotice } from "../lib/bridge.js";
import { storageNoticeKey } from "../lib/storage-notices.js";

/** Where the agent data lives and why, as Rust reported it
 *  (`AgentStatus.storageNotices`). Renders nothing when all is well. */
export function StorageNotices({
  notices,
}: {
  notices: readonly StorageNotice[];
}): ReactElement | null {
  const { t } = useTranslation();
  if (notices.length === 0) return null;
  return (
    <div className="signer-storage-notices">
      {notices.map((notice) => {
        const key = storageNoticeKey(notice);
        return (
          <Alert key={key} tone="warn">
            {t(key)}
          </Alert>
        );
      })}
    </div>
  );
}
```

`apps/signer/src/pages/Status.tsx`, `apps/signer/src/pages/Pairing.tsx`, `apps/signer/src/App.tsx`, `apps/signer/src/signer.css`:

```diff
--- a/apps/signer/src/pages/Status.tsx
+++ b/apps/signer/src/pages/Status.tsx
@@ -5,6 +5,7 @@
 import { AutostartControl } from "../components/AutostartControl.js";
 import { CertificatePicker } from "../components/CertificatePicker.js";
 import { JournalList } from "../components/JournalList.js";
+import { StorageNotices } from "../components/StorageNotices.js";
 import { UpdateControl } from "../components/UpdateControl.js";
 import type { UpdateCheckResult } from "../lib/updates.js";

@@ -112,6 +113,7 @@
                 : t("status.noToken")}
             </p>
             {status.lastError ? <p className="signer-status__error">{status.lastError}</p> : null}
+            <StorageNotices notices={status.storageNotices} />
           </section>

           <section className="signer-status__section">
--- a/apps/signer/src/pages/Pairing.tsx
+++ b/apps/signer/src/pages/Pairing.tsx
@@ -1,15 +1,19 @@
 import { useState, type ReactElement } from "react";
 import { useTranslation } from "react-i18next";
 import { Alert, Button, Card, Input } from "@markiro/ui";
-import type { PairOutcome } from "../lib/bridge.js";
+import { StorageNotices } from "../components/StorageNotices.js";
+import type { PairOutcome, StorageNotice } from "../lib/bridge.js";
+import { concernsPairing } from "../lib/storage-notices.js";

 interface PairingProps {
   hostname: string;
   onPair: (code: string) => Promise<PairOutcome>;
   onPaired?: () => void;
+  /** All current notices; the screen shows only the ones about pairing. */
+  notices?: readonly StorageNotice[];
 }

-export function Pairing({ hostname, onPair, onPaired }: PairingProps): ReactElement {
+export function Pairing({ hostname, onPair, onPaired, notices = [] }: PairingProps): ReactElement {
   const { t } = useTranslation();
   const [code, setCode] = useState("");
   const [busy, setBusy] = useState(false);
@@ -37,6 +41,7 @@
     <Card title={t("pairing.title")} className="signer-pairing">
       <div className="signer-pairing__content">
         <p className="signer-pairing__hint">{t("pairing.hint", { hostname })}</p>
+        <StorageNotices notices={notices.filter(concernsPairing)} />
         <Input
           label={t("pairing.codeLabel")}
           value={code}
--- a/apps/signer/src/App.tsx
+++ b/apps/signer/src/App.tsx
@@ -87,6 +87,7 @@
     return (
       <Pairing
         hostname={status?.hostname ?? ""}
+        notices={status?.storageNotices ?? []}
         onPair={(code) => bridge.pair(code)}
         onPaired={() => void bridge.status().then(setStatus)}
       />
--- a/apps/signer/src/signer.css
+++ b/apps/signer/src/signer.css
@@ -45,6 +45,12 @@

 .signer-pairing__content {
   gap: 20px;
+}
+
+.signer-storage-notices {
+  display: flex;
+  flex-direction: column;
+  gap: 8px;
 }

 .signer-pairing__hint,
```

Add the `storage` block at the end of both dictionaries (after `journal`):

```diff
--- a/apps/signer/src/i18n/en.json
+++ b/apps/signer/src/i18n/en.json
@@ -78,5 +78,19 @@
     "exporting": "Exporting…",
     "exported": "Journal saved: {{path}}",
     "exportFailed": "Could not export the journal. Choose another folder and try again."
+  },
+  "storage": {
+    "localLessDurable": {
+      "temporaryProfile": "Windows signed you in with a temporary profile. The pairing will be lost when you sign out. Ask your IT team to fix the profile, then pair the agent.",
+      "mandatoryProfile": "This Windows profile is mandatory: changes, including the pairing, are discarded at sign-out. Ask your IT team for a regular profile on this computer.",
+      "deleteRoamingCache": "A domain policy deletes the local profile copy at sign-out, so the agent keeps its data in the roaming profile, which can follow you to other computers. Ask your IT team to review the policy for this computer."
+    },
+    "movePostponed": "The agent data could not be moved out of the roaming profile yet. The agent keeps working and will retry at the next start.",
+    "legacyCleanupPending": "The old copy of the agent data in the roaming profile could not be removed yet. This computer no longer uses it; the agent will retry at the next start.",
+    "roamedCopy": {
+      "sameAgent": "A copy of this agent's pairing appeared in the roaming profile. If the agent also runs on another computer under this Windows account, revoke it in the cabinet and pair only the computer that holds the qualified certificate.",
+      "otherAgent": "Another pairing appeared in the roaming profile. This computer does not use it."
+    },
+    "credentialUnreadable": "The saved pairing cannot be read by this Windows user on this computer. If you have just signed in to the domain, wait a minute; otherwise pair the agent again."
   }
 }
--- a/apps/signer/src/i18n/ru.json
+++ b/apps/signer/src/i18n/ru.json
@@ -78,5 +78,19 @@
     "exporting": "Экспортируем…",
     "exported": "Журнал сохранён: {{path}}",
     "exportFailed": "Не удалось экспортировать журнал. Выберите другой каталог и повторите."
+  },
+  "storage": {
+    "localLessDurable": {
+      "temporaryProfile": "Windows выполнил вход с временным профилем. Привязка пропадёт при выходе из системы. Попросите ИТ-службу исправить профиль и затем привяжите агента.",
+      "mandatoryProfile": "Этот профиль Windows обязательный: изменения, включая привязку, сбрасываются при выходе. Попросите ИТ-службу выдать обычный профиль на этом компьютере.",
+      "deleteRoamingCache": "Политика домена удаляет локальную копию профиля при выходе, поэтому агент хранит данные в перемещаемом профиле, а он может попасть на другие компьютеры. Попросите ИТ-службу пересмотреть политику для этого компьютера."
+    },
+    "movePostponed": "Данные агента пока не удалось перенести из перемещаемого профиля. Агент продолжает работать и повторит перенос при следующем запуске.",
+    "legacyCleanupPending": "Старую копию данных агента в перемещаемом профиле пока не удалось удалить. Этот компьютер её больше не использует; агент повторит удаление при следующем запуске.",
+    "roamedCopy": {
+      "sameAgent": "В перемещаемом профиле появилась копия привязки этого агента. Если агент запущен и на другом компьютере под этой учётной записью Windows, отзовите его в кабинете и привяжите только компьютер с квалифицированным сертификатом.",
+      "otherAgent": "В перемещаемом профиле появилась другая привязка. Этот компьютер её не использует."
+    },
+    "credentialUnreadable": "Сохранённую привязку не может прочитать этот пользователь Windows на этом компьютере. Если вы только что вошли в домен, подождите минуту; иначе привяжите агента заново."
   }
 }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
pnpm --filter @markiro/signer test
pnpm --filter @markiro/signer typecheck
pnpm --filter @markiro/signer lint
pnpm exec prettier --check apps/signer/src apps/signer/test
```

Expected: Vitest `12 passed (12)` files and `49 passed (49)` tests; `tsc` prints nothing; ESLint prints nothing; Prettier reports all files formatted. A missing i18n key throws in tests (`src/i18n/index.ts`), so a typo in a key fails loudly.

- [ ] **Step 5: Commit**

```bash
git add apps/signer/src/lib/bridge.ts apps/signer/src/lib/storage-notices.ts apps/signer/src/components/StorageNotices.tsx apps/signer/src/pages/Status.tsx apps/signer/src/pages/Pairing.tsx apps/signer/src/App.tsx apps/signer/src/signer.css apps/signer/src/i18n/en.json apps/signer/src/i18n/ru.json apps/signer/test/storage-notices.test.tsx apps/signer/test/i18n-parity.test.ts apps/signer/test/app-state.test.ts apps/signer/test/app-status-race.test.tsx apps/signer/test/status-journal.test.tsx
git commit -m "feat(signer): уведомления о хранилище на экранах состояния и привязки

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Documentation — where the data lives and what DPAPI guarantees

**Files:**

- Modify: `apps/signer/signer-core/src/storage.rs:1-6`, `apps/signer/signer-core/src/storage_dpapi.rs:1-6`
- Modify: `docs/runbooks/signer-agent-manual-e2e.md:125-127`, `docs/runbooks/signer-windows-acceptance.md` (new section before `## Evidence`)
- Modify: `apps/signer/README.md` (new section at the end), `docs/architecture.md` (§6), `docs/superpowers/specs/2026-08-28-chz-signer-agent-design.md:190`

**Interfaces:** none (comments and documents).

- [ ] **Step 1: Correct the two Rust module headers**

In `storage.rs`, replace the first six lines

```rust
//! On-disk agent state under `%APPDATA%\app.markiro.signer\signer.json`.
//!
//! The agent secret is never stored in the clear: `agent_secret_protected`
//! holds a base64 DPAPI blob (see `storage_dpapi.rs`), which is bound to the
//! Windows user account, so copying the file to another machine or profile
//! yields nothing.
```

with:

```rust
//! On-disk agent state: `signer.json` in `%LOCALAPPDATA%\app.markiro.signer\`,
//! moved once from the roaming `%APPDATA%` folder by `storage_location`.
//!
//! The agent secret is never stored in the clear: `agent_secret_protected`
//! holds a base64 user-scope DPAPI blob (see `storage_dpapi.rs`). Another
//! Windows user cannot decrypt it, but the same user can on any computer that
//! has their DPAPI keys, which a roaming profile or redirected AppData
//! provides. That is why this file must stay in non-roaming storage.
```

In `storage_dpapi.rs`, replace the first six lines

```rust
//! DPAPI-backed secret storage (per-user scope).
//!
//! `CryptProtectData` ties the ciphertext to the Windows account, which is
//! exactly the boundary we want: the agent runs as the operator who owns the
//! UKEP, and nobody else — including another account on the same machine —
//! can recover the agent secret from the config file.
```

with:

```rust
//! DPAPI-backed secret storage (per-user scope).
//!
//! `CryptProtectData` without `CRYPTPROTECT_LOCAL_MACHINE` ties the ciphertext
//! to the Windows account: the agent runs as the operator who owns the UKEP,
//! and nobody else, including another account on the same machine, can
//! recover the agent secret from the config file. It does not tie the
//! ciphertext to this computer: the user's DPAPI master keys travel with a
//! roaming profile or redirected AppData, and Microsoft documents that such a
//! user "can decrypt the data from another computer on the network". Keeping
//! the file in non-roaming storage is `storage_location`'s job.
```

- [ ] **Step 2: Update the runbooks**

In `docs/runbooks/signer-agent-manual-e2e.md`, replace

```markdown
- Revoke the agent in the cabinet: the tray window must return to the pairing
  screen on the next poll, and `%APPDATA%\app.markiro.signer\signer.json` must
  no longer contain `agentSecretProtected`.
```

with:

```markdown
- Revoke the agent in the cabinet: the tray window must return to the pairing
  screen on the next poll, and `%LOCALAPPDATA%\app.markiro.signer\signer.json`
  must no longer contain `agentSecretProtected`.
```

In `docs/runbooks/signer-windows-acceptance.md`, insert before `## Evidence`:

```markdown
## Local storage

Run these on the first release that moves the agent data out of the roaming
profile (`docs/superpowers/specs/2026-09-27-signer-local-storage-design.md`),
starting from a paired previous stable with a selected certificate.

- [ ] After the update the agent keeps its identity: the cabinet shows no new
      agent, the certificate selection is kept, and the next token refresh
      completes through CryptoPro.
- [ ] `%LOCALAPPDATA%\app.markiro.signer\` holds `signer.json`,
      `signer-storage.json` and `journal\`; `%APPDATA%\app.markiro.signer\`
      no longer exists.
- [ ] The journal shows "Agent data moved out of the roaming profile" once, and
      the earlier events are still listed.
- [ ] Restarting the agent moves nothing again and adds no storage entry.
- [ ] Copy `signer.json` from the local folder into a new
      `%APPDATA%\app.markiro.signer\` and restart: the agent keeps working, the
      Status tab reports a copy of this agent's pairing in the roaming profile,
      and the copy is left untouched.

### Domain checks (test Active Directory)

- [ ] Roaming profile: move on computer A, sign out, and check that the profile
      share no longer holds `app.markiro.signer`. Sign in on computer B with the
      Signer installed: it shows the pairing screen, not A's identity.
- [ ] AppData(Roaming) redirection: computer B still on the previous version
      shows the pairing screen within one poll after A upgrades.
- [ ] Redirection without Offline Files, share taken offline: the Status or
      pairing screen reports an unreadable credential, `signer.json` is kept,
      and the agent recovers when the share returns.
- [ ] `DeleteRoamingCache = 1`, a temporary profile and a mandatory profile:
      nothing moves and the Status tab explains why.
```

- [ ] **Step 3: Update the README, the architecture and the old spec**

Append to `apps/signer/README.md`:

```markdown
## Где хранятся данные

Агент хранит `signer.json` (привязку, выбранный сертификат и секрет агента под
DPAPI) и журнал в `%LOCALAPPDATA%\app.markiro.signer\`. Версии до 0.1.4
держали их в перемещаемом `%APPDATA%\app.markiro.signer\`; при первом запуске
новой версии данные однократно переносятся, запись о переносе лежит рядом в
`signer-storage.json`.

Перемещаемая папка не годится: при перемещаемом профиле или перенаправленном
AppData она вместе с ключами DPAPI пользователя попадает на другие компьютеры,
и второй компьютер становится тем же агентом. Агент остаётся в перемещаемой
папке и объясняет почему на вкладке «Состояние» только при временном или
обязательном профиле и при политике удаления локальных копий профиля при
выходе.

Для ИТ-службы: на компьютере с УКЭП используйте локальную учётную запись или
профиль без перемещения и перенаправления AppData; привязывайте агента после
развёртывания образа диска, а не до.

Возврат на версию до переноса делается вручную: скопировать `signer.json`
обратно в `%APPDATA%\app.markiro.signer\` и удалить `signer-storage.json`.
```

In `docs/architecture.md`, section `## 6. AuthN/AuthZ`, add after the **Kiosk device** bullet (before `### Cabinet authorization`):

```markdown
- **Signer agent: separate secret.** The Chestny ZNAK signer redeems a
  single-use pairing code for a random agent secret; the API stores only its
  hash and authenticates `x-signer-token` against it. The agent keeps the
  secret under user-scope DPAPI in `%LOCALAPPDATA%`, never in the roaming
  profile: DPAPI user keys roam with a roaming profile or redirected AppData,
  so a roamed copy would decrypt on another computer and clone the agent
  (`docs/superpowers/specs/2026-09-27-signer-local-storage-design.md`).
```

In `docs/superpowers/specs/2026-08-28-chz-signer-agent-design.md`, replace

```markdown
- `agentSecret` is stored via DPAPI; agent config lives under `%APPDATA%\Markiro Signer`.
```

with:

```markdown
- `agentSecret` is stored via DPAPI; agent config lives under `%APPDATA%\Markiro Signer`.
  (Superseded: the config lived in `%APPDATA%\app.markiro.signer` and moves to
  `%LOCALAPPDATA%\app.markiro.signer`; see `2026-09-27-signer-local-storage-design.md`.)
```

- [ ] **Step 4: Check formatting and build**

Run:

```bash
pnpm exec prettier --check apps/signer/README.md docs/runbooks/signer-agent-manual-e2e.md docs/runbooks/signer-windows-acceptance.md docs/architecture.md docs/superpowers/specs/2026-08-28-chz-signer-agent-design.md
cargo build --manifest-path apps/signer/Cargo.toml
git diff --check
```

Expected: Prettier reports all files formatted (if it rewraps something, run `--write` on that file only and re-read the result); the build has no warnings; `git diff --check` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add apps/signer/signer-core/src/storage.rs apps/signer/signer-core/src/storage_dpapi.rs docs/runbooks/signer-agent-manual-e2e.md docs/runbooks/signer-windows-acceptance.md apps/signer/README.md docs/architecture.md docs/superpowers/specs/2026-08-28-chz-signer-agent-design.md
git commit -m "docs(signer): где хранятся данные агента и что гарантирует DPAPI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Final verification

**Files:** none new.

- [ ] **Step 1: Run the signer gates**

```bash
cargo test --manifest-path apps/signer/Cargo.toml --workspace
pnpm --filter @markiro/signer test
pnpm --filter @markiro/signer typecheck
pnpm --filter @markiro/signer lint
pnpm --filter @markiro/signer build
pnpm test:signer-release:contract
pnpm format:check
git fetch origin main
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
```

Expected: `signer_core` 111 passed and `markiro_signer_lib` 7 passed (loopback allowed); Vitest 12 files / 49 tests; typecheck, lint, build, release contract and format check green; the three-dot diff touches only the files in this plan plus the spec and plan documents. If `graphify-out/` exists, run `graphify update .`.

- [ ] **Step 2: Confirm CI coverage**

`tools/ci/affected.mjs` maps `apps/signer/signer-core/` and `apps/signer/src-tauri/` to `signer_rust` and `signer_windows_build`, and `apps/signer/src` additionally to `verify_static` and `verify_app_tests`. On the PR, confirm that **signer-windows-build** actually ran: it is the only job that executes the `#[cfg(windows)]` tests (`the_runner_profile_is_local`, `a_dpapi_blob_still_decrypts_after_the_move`, the DPAPI round trip). A skipped job verifies nothing.

- [ ] **Step 3: Report**

Report, per `AGENTS.md`: behaviour changed, files changed, automated checks with their counts, and — separately — what was not verified. The following need a real Windows PC or a test domain and cannot be claimed from CI or host tests (spec section 10):

1. Upgrade from signer 0.1.4 with a paired agent on Windows 10 and 11 (local account): same agent in the cabinet, certificate kept, a refresh completes through CryptoPro, the roaming folder gone, the journal continuous.
2. Uninstall with and without "delete application data" (Tauri's NSIS removes both folders only when ticked).
3. Test domain, roaming profile: the premise (before the fix B decrypts A's blob), then the fix (profile share cleaned after sign-out; B shows pairing), and `GetProfileType` reporting a roaming profile.
4. Test domain, AppData(Roaming) redirection: B on 0.1.4 drops to pairing after A upgrades; the local AppData path is not redirected.
5. Redirection without Offline Files with the share offline: `credentialUnreadable`, file kept, recovery.
6. `DeleteRoamingCache = 1`, a temporary profile and a mandatory profile: no move, notices shown.

Release (beta → section 10 → stable via `signer-stable-release.yml`) and the operational step S5 (revoke and re-pair for tenants known to use roaming) are separate outcomes and need the owner's go-ahead.

## Self-review notes

- Spec coverage: §7.1 units → Tasks 1, 2, 4; §7.2 layout and lock → Task 2; §7.3 algorithm and §7.4 interruptions → Task 2 (`move_tests`); §7.5 durability guard → Tasks 1-2; §7.6 kept credential → Task 3; §7.7 notices → Tasks 1, 3, 5; §7.8 existing copies → documented in the README and runbooks (Task 6), no code; §7.9 rollback → README (Task 6); §8 tests → Tasks 1-5; §9 documents → Task 6; §10 manual checks → Task 6 runbook and Task 7 report.
- Deviations from the spec text, all stricter than it:
  - `Step::VerifyConfig` is an extra hook point so a test can corrupt the copy between the write and the read-back (spec §8 test 9, "compare failure").
  - The record stores `copiedConfig`, an FNV-1a fingerprint and length of the copied `signer.json` (no credential material), so "delete `signer.json` only if its bytes equal what was copied" (spec §7.3 step 6) still holds when the cleanup resumes after a restart.
  - Before renaming, `retire` checks the roaming `signer.json` against that fingerprint. A different file is not renamed at all (`Retired::Foreign`) and is reported by the roamed-copy check, so the move never takes over another computer's live folder. The spec only protected the file after the rename.
