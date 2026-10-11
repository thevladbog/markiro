use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Persisted station identity/enrollment state. Mirrors idento's
/// `agent_config.json` discipline: a stable machine id, plus enrollment
/// fields filled in once the device is enrolled (Task 8).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StationConfig {
    pub machine_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
}

impl StationConfig {
    fn new_with_machine_id() -> Self {
        StationConfig {
            machine_id: Uuid::new_v4().to_string(),
            tenant_id: None,
            device_id: None,
            device_name: None,
            organization_name: None,
            line_id: None,
            line_name: None,
            api_key: None,
            server_url: None,
        }
    }
}

fn config_path(dir: &Path) -> PathBuf {
    dir.join("station.json")
}

/// Reads `station.json` from `dir`, minting + persisting a stable v4
/// `machine_id` on first run (so `machine_id` is never empty once assigned).
pub fn read_config(dir: &Path) -> Result<StationConfig, String> {
    let path = config_path(dir);
    if !path.exists() {
        let cfg = StationConfig::new_with_machine_id();
        write_config(dir, &cfg)?;
        return Ok(cfg);
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| format!("Invalid station.json: {e}"))
}

/// Atomically replaces `station.json` (create dir, write a private sibling,
/// sync, then replace). A failed write restores the previous readable
/// provisioning bundle instead of truncating it; a replace that loses the file
/// keeps the new and the previous copies beside it. On Unix the sibling is
/// created at mode 0600; on Windows the per-user local app-data folder's ACL applies.
pub fn write_config(dir: &Path, cfg: &StationConfig) -> Result<(), String> {
    write_config_with(
        dir,
        cfg,
        replace_config_file,
        sync_parent_directory,
        sync_parent_directory,
    )
}

/// The replace primitive and the two directory sync operations are injected
/// only so the failure paths can be proven in unit tests. Production always
/// uses `replace_config_file` and `sync_parent_directory`.
fn write_config_with<R, F, G>(
    dir: &Path,
    cfg: &StationConfig,
    replace: R,
    commit_sync: F,
    rollback_sync: G,
) -> Result<(), String>
where
    R: Fn(&Path, &Path) -> std::io::Result<()>,
    F: Fn(&Path) -> Result<(), String>,
    G: Fn(&Path) -> Result<(), String>,
{
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = config_path(dir);
    let data = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    let temporary = dir.join(format!(".station-{}.tmp", Uuid::new_v4()));
    if let Err(error) = write_owner_only(&temporary, data.as_bytes()) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    let backup = dir.join(format!(".station-{}.bak", Uuid::new_v4()));
    let had_previous = match backup_existing_config(&path, &backup) {
        Ok(had_previous) => had_previous,
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            let _ = fs::remove_file(&backup);
            return Err(error);
        }
    };
    // The backup must itself be durable before the destination can change.
    if had_previous {
        if let Err(error) = sync_parent_directory(dir) {
            let _ = fs::remove_file(&temporary);
            let _ = fs::remove_file(&backup);
            return Err(error);
        }
    }
    match install_replacement(&temporary, &path, had_previous, &replace) {
        Ok(()) => {}
        Err(ReplaceFailure::Unchanged(error)) => {
            let _ = fs::remove_file(&temporary);
            let _ = fs::remove_file(&backup);
            return Err(error.to_string());
        }
        Err(ReplaceFailure::Stranded(error)) => {
            return Err(format!(
                "{} could not be replaced and is missing: {error}; the new configuration is kept in {} and the previous one in {}",
                path.display(),
                temporary.display(),
                backup.display()
            ));
        }
    }
    match commit_sync(dir) {
        Ok(()) => {
            let _ = fs::remove_file(&backup);
            Ok(())
        }
        Err(sync_error) => {
            let restored = if had_previous {
                restore_config_from_backup(dir, &backup, &path, &replace)
            } else {
                fs::remove_file(&path).map_err(|error| error.to_string())
            };
            match restored {
                Ok(()) => match rollback_sync(dir) {
                    Ok(()) => {
                        let _ = fs::remove_file(&backup);
                        Err(format!(
                            "Configuration write was rolled back after directory sync failed: {sync_error}"
                        ))
                    }
                    Err(rollback_sync_error) => Err(format!(
                        "Configuration durability is uncertain after replacement; rollback directory sync failed: {rollback_sync_error}; original sync error: {sync_error}"
                    )),
                },
                Err(restore_error) => Err(format!(
                    "Configuration durability is uncertain after replacement; automatic restoration failed: {restore_error}; original sync error: {sync_error}"
                )),
            }
        }
    }
}

/// After a failed replace has lost an existing destination, the temporary
/// sibling is installed again this many times, this far apart (the storage
/// move's rename cadence).
const REINSTALL_ATTEMPTS: u32 = 3;
const REINSTALL_RETRY_DELAY: Duration = Duration::from_millis(250);

/// A replace that did not install the new document.
pub(crate) enum ReplaceFailure {
    /// The destination is as it was, or there never was one: the temporary
    /// sibling, and any backup, may be removed.
    Unchanged(std::io::Error),
    /// An existing destination is gone and the temporary sibling could not be
    /// installed: it and any backup are the only complete copies.
    Stranded(std::io::Error),
}

/// Installs `temporary` at `destination` through `replace`. A failed rename
/// leaves the old destination in place; if an existing destination is gone
/// anyway, the disk decides: `temporary` is the last complete copy, so it is
/// installed again rather than thrown away.
pub(crate) fn install_replacement(
    temporary: &Path,
    destination: &Path,
    had_destination: bool,
    replace: &dyn Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), ReplaceFailure> {
    let mut attempt = 0;
    loop {
        let error = match replace(temporary, destination) {
            Ok(()) => return Ok(()),
            Err(error) => error,
        };
        if !had_destination || fs::symlink_metadata(destination).is_ok() {
            return Err(ReplaceFailure::Unchanged(error));
        }
        if attempt == REINSTALL_ATTEMPTS {
            return Err(ReplaceFailure::Stranded(error));
        }
        attempt += 1;
        sleep(REINSTALL_RETRY_DELAY);
    }
}

/// Makes a private byte-for-byte recovery copy of an existing config. A
/// missing destination is the first-write case and needs no backup.
fn backup_existing_config(destination: &Path, backup: &Path) -> Result<bool, String> {
    match fs::read(destination) {
        Ok(data) => {
            write_owner_only(backup, &data)?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

/// Restores a backup through a fresh private sibling, retaining the backup
/// itself until the final directory sync confirms the restored destination.
/// This path works with Unix rename and the Windows replacement primitive.
fn restore_config_from_backup(
    dir: &Path,
    backup: &Path,
    destination: &Path,
    replace: &dyn Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
    let restoration = dir.join(format!(".station-{}.tmp", Uuid::new_v4()));
    let backup_bytes = fs::read(backup).map_err(|error| error.to_string())?;
    if let Err(error) = write_owner_only(&restoration, &backup_bytes) {
        let _ = fs::remove_file(&restoration);
        return Err(error);
    }
    replace(&restoration, destination).map_err(|error| {
        let _ = fs::remove_file(&restoration);
        error.to_string()
    })
}

/// Replaces the destination without truncating it in place: one rename that
/// either installs the completed sibling or leaves the old destination under
/// its name. On Windows that is `MoveFileExW` with
/// `MOVEFILE_REPLACE_EXISTING`, not `ReplaceFileW`, whose documented errors
/// 1176 and 1177 can leave no file under the destination name.
/// `MOVEFILE_WRITE_THROUGH` returns only once the move is on disk;
/// `REPLACEFILE_WRITE_THROUGH` is documented as unsupported.
#[cfg(windows)]
pub(crate) fn replace_config_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let temporary_wide = temporary
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let succeeded = unsafe {
        MoveFileExW(
            temporary_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        ) != 0
    };
    if succeeded {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(windows))]
pub(crate) fn replace_config_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(temporary, destination)
}

#[cfg(unix)]
pub(crate) fn sync_parent_directory(dir: &Path) -> Result<(), String> {
    fs::File::open(dir)
        .and_then(|directory| directory.sync_all())
        .map_err(|e| e.to_string())
}

#[cfg(not(unix))]
pub(crate) fn sync_parent_directory(_dir: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
pub(crate) fn write_owner_only(path: &Path, data: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(data).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}

#[cfg(not(unix))]
pub(crate) fn write_owner_only(path: &Path, data: &[u8]) -> Result<(), String> {
    let mut file = fs::File::create(path).map_err(|e| e.to_string())?;
    file.write_all(data).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}

/// Removes a rejected credential and all reproducible tenant/place metadata,
/// while retaining the durable installation and station IDs for same-record
/// re-pairing. It deliberately does not touch the SQLite operational journal.
pub fn clear_credential(dir: &Path) -> Result<(), String> {
    let mut cfg = read_config(dir)?;
    cfg.tenant_id = None;
    cfg.device_name = None;
    cfg.organization_name = None;
    cfg.line_id = None;
    cfg.line_name = None;
    cfg.api_key = None;
    write_config(dir, &cfg)
}

/// Validates an operator-entered http(s) URL. Mirrors idento's
/// `build_agent_url` hardening: only http/https, and never any embedded
/// userinfo (a `user:pass@host` URL is a token-leak / SSRF vector).
pub fn validate_http_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("Invalid URL: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(format!("Invalid URL scheme: {}", parsed.scheme()));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Invalid URL: userinfo not allowed".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("markiro-station-{}", Uuid::new_v4()))
    }

    #[test]
    fn read_config_mints_stable_machine_id_and_round_trips() {
        let dir = temp_dir();
        let first = read_config(&dir).expect("first read");
        assert!(!first.machine_id.is_empty());

        // Second read returns the SAME machine id (persisted, not regenerated).
        let second = read_config(&dir).expect("second read");
        assert_eq!(first.machine_id, second.machine_id);
    }

    #[test]
    fn write_then_read_preserves_enrollment_fields() {
        let dir = temp_dir();
        let mut cfg = read_config(&dir).unwrap();
        cfg.tenant_id = Some("org_1".into());
        cfg.device_id = Some("dev_1".into());
        cfg.device_name = Some("Packing station".into());
        cfg.organization_name = Some("Factory".into());
        cfg.line_id = Some("line_1".into());
        cfg.line_name = Some("Packing".into());
        cfg.api_key = Some("credential-placeholder".into());
        cfg.server_url = Some("https://api.markiro.app".into());
        write_config(&dir, &cfg).unwrap();

        let reloaded = read_config(&dir).unwrap();
        assert_eq!(reloaded, cfg);
    }

    #[test]
    fn replace_config_file_installs_a_complete_new_document_over_an_existing_one() {
        let dir = temp_dir();
        let mut original = read_config(&dir).unwrap();
        original.device_id = Some("device_before".into());
        original.api_key = Some("credential-before".into());
        write_config(&dir, &original).unwrap();

        let mut replacement = original.clone();
        replacement.device_id = Some("device_after".into());
        replacement.api_key = Some("credential-after".into());
        replacement.server_url = Some("https://api.example".into());
        write_config(&dir, &replacement).unwrap();

        let on_disk: StationConfig = serde_json::from_str(
            &fs::read_to_string(config_path(&dir)).expect("replacement is readable"),
        )
        .expect("replacement is complete JSON");
        assert_eq!(on_disk, replacement);
        assert!(fs::read_dir(&dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
    }

    #[test]
    fn parent_sync_failure_restores_the_previous_config_and_cleans_recovery_files() {
        let dir = temp_dir();
        let mut original = read_config(&dir).unwrap();
        original.device_id = Some("device_before".into());
        original.api_key = Some("credential-before".into());
        original.server_url = Some("https://api.before.example".into());
        write_config(&dir, &original).unwrap();

        let mut replacement = original.clone();
        replacement.api_key = Some("credential-after".into());
        replacement.server_url = Some("https://api.after.example".into());

        let result = write_config_with(
            &dir,
            &replacement,
            replace_config_file,
            |_| Err("injected directory sync failure".to_string()),
            sync_parent_directory,
        );

        assert!(result.is_err());
        assert_eq!(read_config(&dir).unwrap(), original);
        assert!(fs::read_dir(&dir).unwrap().all(|entry| {
            let name = entry.unwrap().file_name();
            let name = name.to_string_lossy();
            !name.ends_with(".tmp") && !name.ends_with(".bak")
        }));
    }

    #[test]
    fn parent_sync_failure_on_first_write_removes_the_new_config_and_recovery_files() {
        let dir = temp_dir();
        let cfg = StationConfig::new_with_machine_id();

        let result = write_config_with(
            &dir,
            &cfg,
            replace_config_file,
            |_| Err("injected directory sync failure".to_string()),
            sync_parent_directory,
        );

        assert!(result.is_err());
        assert!(!config_path(&dir).exists());
        assert!(fs::read_dir(&dir).unwrap().all(|entry| {
            let name = entry.unwrap().file_name();
            let name = name.to_string_lossy();
            !name.ends_with(".tmp") && !name.ends_with(".bak")
        }));
    }

    #[test]
    fn failed_final_restore_sync_preserves_the_prior_backup_as_durability_recovery() {
        let dir = temp_dir();
        let mut original = read_config(&dir).unwrap();
        original.device_id = Some("device_before".into());
        original.api_key = Some("credential-before".into());
        original.server_url = Some("https://api.before.example".into());
        write_config(&dir, &original).unwrap();

        let mut replacement = original.clone();
        replacement.api_key = Some("credential-after".into());

        let result = write_config_with(
            &dir,
            &replacement,
            replace_config_file,
            |_| Err("injected commit directory sync failure".to_string()),
            |_| Err("injected restore directory sync failure".to_string()),
        );

        expect_durability_uncertainty(&result);
        assert_eq!(read_config(&dir).unwrap(), original);
        assert!(fs::read_dir(&dir).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".bak")
        }));
        assert!(fs::read_dir(&dir).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")
        }));
    }

    #[test]
    fn failed_final_first_write_removal_sync_is_durability_uncertainty_not_rollback() {
        let dir = temp_dir();
        let cfg = StationConfig::new_with_machine_id();

        let result = write_config_with(
            &dir,
            &cfg,
            replace_config_file,
            |_| Err("injected commit directory sync failure".to_string()),
            |_| Err("injected deletion directory sync failure".to_string()),
        );

        expect_durability_uncertainty(&result);
        assert!(!config_path(&dir).exists());
        assert!(fs::read_dir(&dir).unwrap().all(|entry| {
            let name = entry.unwrap().file_name();
            let name = name.to_string_lossy();
            !name.ends_with(".tmp") && !name.ends_with(".bak")
        }));
    }

    fn expect_durability_uncertainty(result: &Result<(), String>) {
        assert!(result
            .as_ref()
            .is_err_and(|error| error.contains("durability is uncertain")));
    }

    /// Fails the way `ReplaceFileW` did with error 1176: the destination is
    /// gone and the replacement keeps its own name.
    fn lose_destination(_temporary: &Path, destination: &Path) -> std::io::Result<()> {
        let _ = fs::remove_file(destination);
        Err(std::io::Error::other("injected: replacement not renamed"))
    }

    /// Fails and leaves both files as they were.
    fn refuse_replace(_temporary: &Path, _destination: &Path) -> std::io::Result<()> {
        Err(std::io::Error::other("injected: destination in use"))
    }

    /// The `.tmp` and `.bak` siblings left in `dir`.
    fn recovery_files(dir: &Path) -> Vec<PathBuf> {
        let mut files: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                let name = path.file_name().unwrap().to_string_lossy();
                name.ends_with(".tmp") || name.ends_with(".bak")
            })
            .collect();
        files.sort();
        files
    }

    fn enrolled(dir: &Path) -> (StationConfig, StationConfig) {
        let mut original = read_config(dir).unwrap();
        original.device_id = Some("device_before".into());
        original.api_key = Some("credential-before".into());
        write_config(dir, &original).unwrap();
        let mut replacement = original.clone();
        replacement.api_key = Some("credential-after".into());
        (original, replacement)
    }

    #[test]
    fn a_failed_replace_that_keeps_the_destination_discards_the_new_copy() {
        let dir = temp_dir();
        let (original, replacement) = enrolled(&dir);

        let result = write_config_with(
            &dir,
            &replacement,
            refuse_replace,
            sync_parent_directory,
            sync_parent_directory,
        );

        assert!(result.is_err());
        assert_eq!(read_config(&dir).unwrap(), original);
        assert!(recovery_files(&dir).is_empty());
    }

    #[test]
    fn a_failed_replace_that_loses_the_destination_installs_the_new_copy() {
        let dir = temp_dir();
        let (_, replacement) = enrolled(&dir);
        let attempts = std::cell::Cell::new(0);

        let result = write_config_with(
            &dir,
            &replacement,
            |temporary: &Path, destination: &Path| {
                attempts.set(attempts.get() + 1);
                if attempts.get() == 1 {
                    lose_destination(temporary, destination)
                } else {
                    replace_config_file(temporary, destination)
                }
            },
            sync_parent_directory,
            sync_parent_directory,
        );

        assert_eq!(result, Ok(()));
        assert_eq!(read_config(&dir).unwrap(), replacement);
        assert!(recovery_files(&dir).is_empty());
    }

    #[test]
    fn a_lost_destination_that_cannot_be_reinstalled_keeps_both_copies() {
        let dir = temp_dir();
        let (original, replacement) = enrolled(&dir);

        let error = write_config_with(
            &dir,
            &replacement,
            lose_destination,
            sync_parent_directory,
            sync_parent_directory,
        )
        .unwrap_err();

        assert!(!config_path(&dir).exists());
        let kept = recovery_files(&dir);
        assert_eq!(kept.len(), 2, "{kept:?}");
        let parsed = |suffix: &str| -> StationConfig {
            let path = kept
                .iter()
                .find(|path| path.to_string_lossy().ends_with(suffix))
                .unwrap();
            serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
        };
        assert_eq!(parsed(".tmp"), replacement);
        assert_eq!(parsed(".bak"), original);
        for path in &kept {
            assert!(error.contains(&path.display().to_string()), "{error}");
        }
    }

    #[test]
    fn a_failed_first_write_leaves_nothing_behind() {
        let dir = temp_dir();

        let result = write_config_with(
            &dir,
            &StationConfig::new_with_machine_id(),
            refuse_replace,
            sync_parent_directory,
            sync_parent_directory,
        );

        assert!(result.is_err());
        assert!(!config_path(&dir).exists());
        assert!(recovery_files(&dir).is_empty());
    }

    #[test]
    fn clear_credential_keeps_the_durable_machine_and_device_identity() {
        let dir = temp_dir();
        let mut cfg = read_config(&dir).unwrap();
        cfg.tenant_id = Some("tenant_1".into());
        cfg.device_id = Some("device_1".into());
        cfg.device_name = Some("Packing station".into());
        cfg.organization_name = Some("Factory".into());
        cfg.line_id = Some("line_1".into());
        cfg.line_name = Some("Packing".into());
        cfg.api_key = Some("credential-placeholder".into());
        cfg.server_url = Some("https://station.example".into());
        write_config(&dir, &cfg).unwrap();

        clear_credential(&dir).unwrap();

        let cleared = read_config(&dir).unwrap();
        assert_eq!(cleared.machine_id, cfg.machine_id);
        assert_eq!(cleared.device_id, cfg.device_id);
        assert_eq!(cleared.tenant_id, None);
        assert_eq!(cleared.device_name, None);
        assert_eq!(cleared.organization_name, None);
        assert_eq!(cleared.line_id, None);
        assert_eq!(cleared.line_name, None);
        assert_eq!(cleared.api_key, None);
        assert_eq!(cleared.server_url, cfg.server_url);
    }

    #[cfg(unix)]
    #[test]
    fn written_config_is_owner_only_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        let cfg = read_config(&dir).unwrap();
        write_config(&dir, &cfg).unwrap();
        let mode = fs::metadata(config_path(&dir))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    /// A pre-existing permissive config (for example, from an older binary)
    /// is replaced by a private sibling rather than retaining its old mode.
    #[cfg(unix)]
    #[test]
    fn write_config_tightens_preexisting_permissive_file_to_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        let path = config_path(&dir);

        // Pre-create the file at a permissive 0644 mode, simulating a file
        // that predates this hardening (or was restored with bad perms).
        fs::write(&path, "{}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let mode_before = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode_before & 0o777, 0o644);

        let cfg = StationConfig::new_with_machine_id();
        write_config(&dir, &cfg).unwrap();

        let mode_after = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode_after & 0o777, 0o600);
    }

    #[test]
    fn validate_http_url_accepts_https_and_rejects_scheme_and_userinfo() {
        assert!(validate_http_url("https://api.markiro.app/").is_ok());
        assert!(validate_http_url("http://127.0.0.1:3000/").is_ok());
        assert!(validate_http_url("ftp://api.markiro.app/").is_err());
        assert!(validate_http_url("https://user:pass@evil.example.com/").is_err());
        assert!(validate_http_url("not a url").is_err());
    }
}
