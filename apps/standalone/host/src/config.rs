//! Host data directory layout and the persisted host identity (`host.json`).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("host data {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("host config {path} is unreadable: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("host config {path}: {reason}")]
    Invalid { path: PathBuf, reason: String },
}

/// Every file the host owns lives under one data directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostPaths {
    pub data_dir: PathBuf,
}

impl HostPaths {
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
        }
    }

    /// `%ProgramData%\Markiro\Host` on Windows; `./.markiro-host` elsewhere,
    /// which is for development only.
    pub fn default_data_dir() -> PathBuf {
        #[cfg(windows)]
        {
            if let Some(program_data) = std::env::var_os("ProgramData") {
                return PathBuf::from(program_data).join("Markiro").join("Host");
            }
        }
        PathBuf::from(".markiro-host")
    }

    pub fn config_file(&self) -> PathBuf {
        self.data_dir.join("host.json")
    }

    pub fn database_file(&self) -> PathBuf {
        self.data_dir.join("host.db")
    }

    pub fn tls_dir(&self) -> PathBuf {
        self.data_dir.join("tls")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.data_dir.join("logs")
    }

    pub fn ensure(&self) -> Result<(), ConfigError> {
        for dir in [self.data_dir.clone(), self.tls_dir(), self.logs_dir()] {
            fs::create_dir_all(&dir).map_err(|source| ConfigError::Io {
                path: dir.clone(),
                source,
            })?;
        }
        Ok(())
    }
}

/// Persisted identity and listening port.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostConfig {
    pub host_id: String,
    pub port: u16,
}

impl HostConfig {
    /// Load `host.json`, creating it with a fresh host id and the default port
    /// on first start. `port_override` (`--port`) is persisted for the next
    /// start. A corrupt file is reported, never replaced.
    pub fn load_or_create(
        paths: &HostPaths,
        port_override: Option<u16>,
    ) -> Result<Self, ConfigError> {
        let path = paths.config_file();
        let mut config = match fs::read_to_string(&path) {
            Ok(text) => {
                serde_json::from_str::<HostConfig>(&text).map_err(|source| ConfigError::Parse {
                    path: path.clone(),
                    source,
                })?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => HostConfig {
                host_id: uuid::Uuid::new_v4().to_string(),
                port: markiro_proto::DEFAULT_PORT,
            },
            Err(source) => return Err(ConfigError::Io { path, source }),
        };
        if uuid::Uuid::parse_str(&config.host_id).is_err() {
            return Err(ConfigError::Invalid {
                path,
                reason: "hostId is not a UUID".into(),
            });
        }
        if let Some(port) = port_override {
            config.port = port;
        }
        if config.port == 0 {
            return Err(ConfigError::Invalid {
                path,
                reason: "port must not be 0".into(),
            });
        }
        let bytes = serde_json::to_vec_pretty(&config).expect("host config serializes");
        write_atomically(&path, &bytes)?;
        Ok(config)
    }
}

/// Write through a sibling temporary file and rename it over the target, so a
/// crash never leaves a half-written `host.json`.
fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), ConfigError> {
    let io = |source: std::io::Error| ConfigError::Io {
        path: path.to_path_buf(),
        source,
    };
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    {
        let mut file = fs::File::create(&tmp).map_err(io)?;
        file.write_all(bytes).map_err(io)?;
        file.sync_all().map_err(io)?;
    }
    fs::rename(&tmp, path).map_err(io)
}
