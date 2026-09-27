use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::Duration;

use uuid::Uuid;

use super::copy::{self, CopyError};
use super::probe::{LessDurableReason, ProfileFacts};
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
    let in_legacy = has_station_files(legacy_dir)?;
    let in_local = has_station_files(local_dir)?;
    let orphaned = !in_legacy && unfinished_claim_exists(legacy_dir)?;
    let guard = facts.local_less_durable();
    if let Some(reason) = guard {
        // Stay in the roaming folder where the files are, or where a fresh
        // station starts; never point at an empty one while they sit elsewhere.
        if in_legacy || (!in_local && !orphaned) {
            return Ok(legacy(
                legacy_dir,
                vec![StorageNotice::LocalLessDurable { reason }],
            ));
        }
    }
    let mut storage = match (in_legacy, in_local) {
        (true, true) => {
            return Err("station files exist in both the roaming and the local folder".to_string())
        }
        (true, false) => return migrate(legacy_dir, local_dir, hook),
        // This machine's record may have been lost, and the claimed files may be
        // newer than any local copy: neither side can be declared authoritative.
        (false, _) if orphaned => {
            return Err(
                "an unfinished move of station files was found next to the roaming folder"
                    .to_string(),
            )
        }
        (false, true) => commit_without_move(local_dir, Origin::Adopted),
        (false, false) => commit_without_move(local_dir, Origin::Fresh),
    };
    if let Some(reason) = guard {
        storage
            .notices
            .push(StorageNotice::LocalLessDurable { reason });
    }
    Ok(storage)
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
    let renamed = hook(Step::Claim).and_then(|()| rename_with_retries(legacy_dir, claim_dir));
    // What is on disk decides: over SMB a rename can land and still report an
    // error when the server's reply is lost.
    if renamed.is_ok() || has_station_files(claim_dir)? {
        return move_claimed(claim_dir, local_dir, hook);
    }
    if has_station_files(legacy_dir)? {
        // Another computer holds the database over SMB, or a scanner holds a
        // file. Withdraw the intent: nothing moved, and the next start retries.
        let _ = record::remove(local_dir);
        return Ok(legacy(legacy_dir, vec![StorageNotice::LegacyInUse]));
    }
    Err("the station files disappeared while they were being claimed".to_string())
}

fn rename_with_retries(from: &Path, to: &Path) -> Result<(), String> {
    let mut attempt = 1;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            // Gone: an earlier attempt may have landed without saying so.
            Err(error) if attempt >= CLAIM_ATTEMPTS || error.kind() == ErrorKind::NotFound => {
                return Err(error.to_string())
            }
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
    discard_station_files(local_dir, &names)?;
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
            return Ok(undo_claim(legacy_dir, claim_dir, local_dir, reason));
        }
        remove_stale_staging(local_dir);
        return move_claimed(claim_dir, local_dir, hook);
    }
    if has_station_files(legacy_dir)? {
        // The intent was recorded, but the rename never happened.
        if let Some(reason) = guard {
            return Ok(forget_move(legacy_dir, local_dir, reason));
        }
        return claim(legacy_dir, claim_dir, local_dir, hook);
    }
    Err("station files named by an unfinished move are missing".to_string())
}

/// The profile now wipes local data, and the record would go with it. Put the
/// claimed folder back under its roaming name and forget the move, so the
/// next start finds the files where it looks without any record.
fn undo_claim(
    legacy_dir: &Path,
    claim_dir: &Path,
    local_dir: &Path,
    reason: LessDurableReason,
) -> StationStorage {
    // tauri-plugin-sql recreates an empty roaming folder whenever the station
    // opens its database; `remove_dir` only ever removes an empty one.
    let _ = fs::remove_dir(legacy_dir);
    if fs::rename(claim_dir, legacy_dir).is_err() {
        // The record still names the claim: run from it and retry next start.
        return legacy(claim_dir, vec![StorageNotice::LocalLessDurable { reason }]);
    }
    forget_move(legacy_dir, local_dir, reason)
}

/// Drops any partial local copy, then the record. The other order would leave
/// station files on both sides, which blocks the next start.
fn forget_move(legacy_dir: &Path, local_dir: &Path, reason: LessDurableReason) -> StationStorage {
    let names = copy::store_files(legacy_dir).unwrap_or_default();
    if discard_station_files(local_dir, &names).is_ok() {
        let _ = record::remove(local_dir);
    }
    legacy(legacy_dir, vec![StorageNotice::LocalLessDurable { reason }])
}

/// Removes `station.json`, the database with its SQLite sidecars and `extra`
/// from the local folder. Only called while the record says the local folder
/// is not authoritative.
fn discard_station_files(local_dir: &Path, extra: &[OsString]) -> std::io::Result<()> {
    let database_sidecars = DATABASE_SIDECARS.map(|suffix| format!("{DATABASE_FILE}{suffix}"));
    let fixed = [CONFIG_FILE, DATABASE_FILE]
        .into_iter()
        .chain(database_sidecars.iter().map(String::as_str));
    for name in fixed
        .map(OsStr::new)
        .chain(extra.iter().map(|name| name.as_os_str()))
    {
        match fs::remove_file(local_dir.join(name)) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
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

    #[test]
    fn a_claim_rename_that_lands_but_reports_an_error_still_moves_the_pair() {
        let dirs = fresh_dirs();
        let original = seed(&dirs.legacy, "machine-1");
        let (legacy_dir, local_dir) = (dirs.legacy.clone(), dirs.local.clone());
        let storage = resolve(&dirs.legacy, &dirs.local, local_profile(), &mut |step| {
            if step == Step::Claim {
                // Over SMB the rename lands on the server, but the reply is lost.
                let Some(StorageRecord::Claiming { claim_dir, .. }) = record::read(&local_dir).unwrap()
                else {
                    panic!("the intent is recorded before the claim");
                };
                fs::rename(&legacy_dir, claim_dir).unwrap();
                return Err("the network name is no longer available".to_string());
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(storage, local(&dirs.local, Vec::new()));
        assert_eq!(files(&dirs.local), original);
        assert!(claims(&dirs).is_empty());
    }

    #[test]
    fn station_files_that_vanish_during_the_claim_block() {
        let dirs = fresh_dirs();
        seed(&dirs.legacy, "machine-1");
        let legacy_dir = dirs.legacy.clone();
        let result = resolve(&dirs.legacy, &dirs.local, local_profile(), &mut |step| {
            if step == Step::Claim {
                fs::remove_dir_all(&legacy_dir).unwrap();
                return Err("not found".to_string());
            }
            Ok(())
        });
        assert!(result.is_err());
    }

    #[test]
    fn a_pending_claim_is_put_back_when_the_profile_starts_wiping_local_data() {
        let dirs = fresh_dirs();
        let original = seed(&dirs.legacy, "machine-1");
        // Start 1: the claim lands, but another computer holds the database.
        resolve(&dirs.legacy, &dirs.local, local_profile(), &mut |step| {
            if step == Step::Hold {
                Err("in use".to_string())
            } else {
                Ok(())
            }
        })
        .unwrap();
        assert_eq!(claims(&dirs).len(), 1);
        // A partial install, and the empty roaming folder tauri-plugin-sql
        // recreates whenever the station opens its database.
        fs::write(dirs.local.join(DATABASE_FILE), b"partial").unwrap();
        fs::create_dir_all(&dirs.legacy).unwrap();

        // Start 2: the delete-cache policy has arrived.
        let wiping = ProfileFacts {
            roaming: true,
            delete_roaming_cache: true,
            ..ProfileFacts::default()
        };
        let notice = vec![StorageNotice::LocalLessDurable {
            reason: LessDurableReason::DeleteRoamingCache,
        }];
        assert_eq!(
            run(&dirs, wiping).unwrap(),
            legacy(&dirs.legacy, notice.clone())
        );
        assert_eq!(files(&dirs.legacy), original);
        assert!(claims(&dirs).is_empty());
        assert!(files(&dirs.local).is_empty());
        assert_eq!(record::read(&dirs.local).unwrap(), None);

        // Sign-out wipes the local profile copy; the files are still found.
        fs::remove_dir_all(&dirs.local).unwrap();
        assert_eq!(run(&dirs, wiping).unwrap(), legacy(&dirs.legacy, notice));
        // Once the policy is gone, the move goes ahead.
        assert_eq!(
            run(&dirs, local_profile()).unwrap(),
            local(&dirs.local, Vec::new())
        );
        assert_eq!(files(&dirs.local), original);
    }

    #[test]
    fn the_guard_never_points_at_an_empty_roaming_folder_while_files_are_elsewhere() {
        let wiping = ProfileFacts {
            temporary: true,
            ..ProfileFacts::default()
        };
        // Files only in the local folder: use them, and say so.
        let dirs = fresh_dirs();
        let placed = seed(&dirs.local, "machine-1");
        assert_eq!(
            run(&dirs, wiping).unwrap(),
            local(
                &dirs.local,
                vec![StorageNotice::LocalLessDurable {
                    reason: LessDurableReason::TemporaryProfile
                }]
            )
        );
        assert_eq!(files(&dirs.local), placed);

        // An orphaned claim: block rather than start empty.
        let dirs = fresh_dirs();
        seed(
            &dirs
                .legacy
                .with_file_name("app.markiro.station.migrating-orphan"),
            "machine-1",
        );
        assert!(run(&dirs, wiping).is_err());
    }

    #[test]
    fn an_orphaned_claim_is_never_shadowed_by_a_stale_local_copy() {
        let dirs = fresh_dirs();
        seed(&dirs.local, "machine-1");
        seed(
            &dirs
                .legacy
                .with_file_name("app.markiro.station.migrating-orphan"),
            "machine-1",
        );
        assert!(run(&dirs, local_profile()).is_err());
    }

    #[test]
    fn failed_record_writes_follow_what_is_on_disk() {
        // The intent never reached the disk: nothing moved.
        let dirs = fresh_dirs();
        let original = seed(&dirs.legacy, "machine-1");
        let storage = resolve(&dirs.legacy, &dirs.local, local_profile(), &mut |step| {
            if step == Step::Record {
                Err("disk full".to_string())
            } else {
                Ok(())
            }
        })
        .unwrap();
        assert_eq!(
            storage,
            legacy(&dirs.legacy, vec![StorageNotice::MoveFailed])
        );
        assert_eq!(files(&dirs.legacy), original);
        assert_eq!(record::read(&dirs.local).unwrap(), None);

        // The commit never reached the disk: the claim stays authoritative.
        let dirs = fresh_dirs();
        let original = seed(&dirs.legacy, "machine-1");
        let storage = resolve(&dirs.legacy, &dirs.local, local_profile(), &mut |step| {
            if step == Step::Commit {
                Err("disk full".to_string())
            } else {
                Ok(())
            }
        })
        .unwrap();
        assert_eq!(storage.mode, StorageMode::Legacy);
        assert_eq!(storage.notices, vec![StorageNotice::MoveFailed]);
        assert_eq!(files(&storage.dir), original);
        assert_eq!(
            run(&dirs, local_profile()).unwrap(),
            local(&dirs.local, Vec::new())
        );
        assert_eq!(files(&dirs.local), original);
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
