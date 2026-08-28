//! On-disk agent state under `%APPDATA%\app.markiro.signer\signer.json`.
//!
//! The agent secret is never stored in the clear: `agent_secret_protected`
//! holds a base64 DPAPI blob (see `storage_dpapi.rs`), which is bound to the
//! Windows user account, so copying the file to another machine or profile
//! yields nothing.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::SignerError;

const CONFIG_FILE: &str = "signer.json";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cert_thumbprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_secret_protected: Option<String>,
}

impl AgentConfig {
    pub fn is_paired(&self) -> bool {
        self.agent_secret_protected.is_some() && self.server_url.is_some()
    }
}

pub trait SecretStore: Send + Sync {
    fn protect(&self, plaintext: &str) -> Result<String, SignerError>;
    fn unprotect(&self, protected: &str) -> Result<String, SignerError>;
}

fn config_path(dir: &Path) -> PathBuf {
    dir.join(CONFIG_FILE)
}

pub fn read_config(dir: &Path) -> Result<AgentConfig, SignerError> {
    match fs::read_to_string(config_path(dir)) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| SignerError::Storage(e.to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(AgentConfig::default()),
        Err(error) => Err(SignerError::Storage(error.to_string())),
    }
}

/// Writes through a temp file and an atomic rename so a crash mid-write leaves
/// the previous config intact rather than a truncated one.
pub fn write_config(dir: &Path, config: &AgentConfig) -> Result<(), SignerError> {
    fs::create_dir_all(dir).map_err(|e| SignerError::Storage(e.to_string()))?;
    let text = serde_json::to_string_pretty(config).map_err(|e| SignerError::Storage(e.to_string()))?;
    let temp = dir.join(format!(".{CONFIG_FILE}.tmp"));
    {
        let mut file = fs::File::create(&temp).map_err(|e| SignerError::Storage(e.to_string()))?;
        file.write_all(text.as_bytes())
            .map_err(|e| SignerError::Storage(e.to_string()))?;
        file.sync_all().map_err(|e| SignerError::Storage(e.to_string()))?;
    }
    fs::rename(&temp, config_path(dir)).map_err(|e| SignerError::Storage(e.to_string()))
}

/// Drops everything tied to the cloud identity but keeps what the operator
/// would otherwise have to re-enter: the server URL and the chosen certificate.
pub fn clear_credential(dir: &Path) -> Result<(), SignerError> {
    let existing = read_config(dir)?;
    write_config(
        dir,
        &AgentConfig {
            agent_id: None,
            tenant_name: None,
            server_url: existing.server_url,
            cert_thumbprint: existing.cert_thumbprint,
            agent_secret_protected: None,
        },
    )
}

/// The server URL reaches us from a human-typed service screen, so reject the
/// shapes that would leak the agent secret: non-HTTP schemes and embedded
/// credentials.
pub fn validate_http_url(value: &str) -> Result<(), SignerError> {
    let value = value.trim();
    let rest = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
        .ok_or_else(|| SignerError::Storage("the server URL must be http or https".into()))?;
    let authority = rest.split('/').next().unwrap_or_default();
    if authority.is_empty() {
        return Err(SignerError::Storage("the server URL has no host".into()));
    }
    if authority.contains('@') {
        return Err(SignerError::Storage(
            "the server URL must not embed credentials".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_config_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let config = AgentConfig {
            agent_id: Some("a-1".into()),
            tenant_name: Some("ООО Ромашка".into()),
            server_url: Some("https://admin.markiro.app".into()),
            cert_thumbprint: Some("AB12".into()),
            agent_secret_protected: Some("cGxhaW4=".into()),
        };
        write_config(dir.path(), &config).unwrap();
        assert_eq!(read_config(dir.path()).unwrap(), config);
    }

    #[test]
    fn a_missing_file_reads_as_an_empty_config_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_config(dir.path()).unwrap(), AgentConfig::default());
    }

    #[test]
    fn clearing_the_credential_keeps_the_server_url_and_drops_the_secret() {
        let dir = tempfile::tempdir().unwrap();
        write_config(
            dir.path(),
            &AgentConfig {
                agent_id: Some("a-1".into()),
                tenant_name: Some("T".into()),
                server_url: Some("https://admin.markiro.app".into()),
                cert_thumbprint: Some("AB12".into()),
                agent_secret_protected: Some("secret".into()),
            },
        )
        .unwrap();
        clear_credential(dir.path()).unwrap();
        let after = read_config(dir.path()).unwrap();
        assert_eq!(after.server_url.as_deref(), Some("https://admin.markiro.app"));
        // The chosen certificate survives a re-pairing; the credential does not.
        assert_eq!(after.cert_thumbprint.as_deref(), Some("AB12"));
        assert_eq!(after.agent_secret_protected, None);
        assert_eq!(after.agent_id, None);
        assert_eq!(after.tenant_name, None);
    }

    #[test]
    fn a_partially_written_file_does_not_replace_a_good_one() {
        let dir = tempfile::tempdir().unwrap();
        let good = AgentConfig {
            agent_id: Some("a-1".into()),
            ..AgentConfig::default()
        };
        write_config(dir.path(), &good).unwrap();
        // Simulate a crashed write leaving a stray temp file behind.
        std::fs::write(dir.path().join(".signer-tmp-leftover"), b"{ broken").unwrap();
        assert_eq!(read_config(dir.path()).unwrap(), good);
    }

    #[test]
    fn rejects_a_server_url_carrying_credentials() {
        assert!(validate_http_url("https://user:pass@admin.markiro.app").is_err());
        assert!(validate_http_url("ftp://admin.markiro.app").is_err());
        assert!(validate_http_url("https://admin.markiro.app").is_ok());
    }
}
