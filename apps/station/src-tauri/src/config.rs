use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

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
/// provisioning bundle instead of truncating it. On Unix the sibling is
/// created at mode 0600; Windows uses the per-user app-config directory.
pub fn write_config(dir: &Path, cfg: &StationConfig) -> Result<(), String> {
    write_config_with_parent_sync(dir, cfg, sync_parent_directory)
}

/// The sync operation is injected only so the post-replacement failure path
/// can be proven in a unit test. Production always uses `sync_parent_directory`.
fn write_config_with_parent_sync<F>(
    dir: &Path,
    cfg: &StationConfig,
    parent_sync: F,
) -> Result<(), String>
where
    F: Fn(&Path) -> Result<(), String>,
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
    replace_config_file(&temporary, &path).map_err(|e| {
        let _ = fs::remove_file(&temporary);
        let _ = fs::remove_file(&backup);
        e.to_string()
    })?;
    match parent_sync(dir) {
        Ok(()) => {
            let _ = fs::remove_file(&backup);
            Ok(())
        }
        Err(sync_error) => {
            let restored = if had_previous {
                replace_config_file(&backup, &path).map_err(|error| error.to_string())
            } else {
                fs::remove_file(&path).map_err(|error| error.to_string())
            };
            match restored {
                Ok(()) => {
                    // Restore uses the real fsync primitive: the injected
                    // failure models only the failed commit, not a second
                    // failed rollback. The old config is readable even if a
                    // later physical flush remains uncertain.
                    let _ = sync_parent_directory(dir);
                    let _ = fs::remove_file(&backup);
                    Err(format!(
                        "Configuration write was rolled back after directory sync failed: {sync_error}"
                    ))
                }
                Err(restore_error) => Err(format!(
                    "Configuration durability is uncertain after replacement; automatic restoration failed: {restore_error}; original sync error: {sync_error}"
                )),
            }
        }
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

/// Replaces the destination without truncating it in place. Windows cannot
/// rely on `rename` replacing an existing file, so it uses `ReplaceFileW`
/// when a prior config exists; that API either keeps the old destination or
/// atomically installs the completed sibling. A first write has no destination
/// and uses `MoveFileExW` with write-through semantics instead.
#[cfg(windows)]
fn replace_config_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH, REPLACEFILE_WRITE_THROUGH,
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
        if destination.exists() {
            ReplaceFileW(
                destination_wide.as_ptr(),
                temporary_wide.as_ptr(),
                null(),
                REPLACEFILE_WRITE_THROUGH,
                null(),
                null(),
            ) != 0
        } else {
            MoveFileExW(
                temporary_wide.as_ptr(),
                destination_wide.as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            ) != 0
        }
    };
    if succeeded {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(windows))]
fn replace_config_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(temporary, destination)
}

#[cfg(unix)]
fn sync_parent_directory(dir: &Path) -> Result<(), String> {
    fs::File::open(dir)
        .and_then(|directory| directory.sync_all())
        .map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn sync_parent_directory(_dir: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn write_owner_only(path: &Path, data: &[u8]) -> Result<(), String> {
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
fn write_owner_only(path: &Path, data: &[u8]) -> Result<(), String> {
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

        let result = write_config_with_parent_sync(&dir, &replacement, |_| {
            Err("injected directory sync failure".to_string())
        });

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

        let result = write_config_with_parent_sync(&dir, &cfg, |_| {
            Err("injected directory sync failure".to_string())
        });

        assert!(result.is_err());
        assert!(!config_path(&dir).exists());
        assert!(fs::read_dir(&dir).unwrap().all(|entry| {
            let name = entry.unwrap().file_name();
            let name = name.to_string_lossy();
            !name.ends_with(".tmp") && !name.ends_with(".bak")
        }));
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
