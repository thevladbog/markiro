use std::fs;
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

/// Writes `station.json` atomically-ish (create dir, write, tighten perms).
/// On unix the file is forced to mode 0600 (owner read/write only); on
/// Windows the app-config dir is already per-user, so ACLs govern access.
pub fn write_config(dir: &Path, cfg: &StationConfig) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = config_path(dir);
    let data = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())?;
    set_owner_only(&path)?;
    Ok(())
}

#[cfg(unix)]
fn set_owner_only(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn set_owner_only(_path: &Path) -> Result<(), String> {
    Ok(())
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
        cfg.api_key = Some("mk_secret".into());
        cfg.server_url = Some("https://api.markiro.app".into());
        write_config(&dir, &cfg).unwrap();

        let reloaded = read_config(&dir).unwrap();
        assert_eq!(reloaded, cfg);
    }

    #[cfg(unix)]
    #[test]
    fn written_config_is_owner_only_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        let cfg = read_config(&dir).unwrap();
        write_config(&dir, &cfg).unwrap();
        let mode = fs::metadata(config_path(&dir)).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
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
