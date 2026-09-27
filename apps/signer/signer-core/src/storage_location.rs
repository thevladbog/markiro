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
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::journal::{JOURNAL_DIR, LOG_FILE_NAME};
use crate::storage::{self, CONFIG_FILE};

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
