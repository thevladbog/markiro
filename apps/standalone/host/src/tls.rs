//! Self-signed TLS identity of the host. Devices pin the SHA-256 of the
//! certificate DER, so the names inside the certificate do not matter; the
//! file pair must survive restarts or every paired device loses trust.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};

#[derive(Debug, thiserror::Error)]
pub enum TlsError {
    #[error("TLS file {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("only one of cert.der and key.der exists in {dir}; restore both or remove both")]
    Incomplete { dir: PathBuf },
    #[error("no TLS identity in {dir}")]
    Missing { dir: PathBuf },
    #[error("certificate generation failed: {0}")]
    Generate(String),
    #[error("TLS configuration rejected the host key: {0}")]
    Config(String),
}

pub struct TlsIdentity {
    pub cert_der: Vec<u8>,
    private_der: Vec<u8>,
    pub fingerprint: String,
}

impl std::fmt::Debug for TlsIdentity {
    // Prints only the fingerprint: the private key must never reach a log.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TlsIdentity")
            .field("fingerprint", &self.fingerprint)
            .finish_non_exhaustive()
    }
}

impl TlsIdentity {
    /// Load an existing TLS identity without creating or modifying anything,
    /// and validate the key against the certificate via [`Self::server_config`]
    /// (rustls rejects a key that does not match the certificate).
    pub fn load(tls_dir: &Path) -> Result<Self, TlsError> {
        let cert_path = tls_dir.join("cert.der");
        let key_path = tls_dir.join("key.der");
        match (cert_path.exists(), key_path.exists()) {
            (true, true) => {
                let cert_der = read(&cert_path)?;
                let private_der = read(&key_path)?;
                let fingerprint = markiro_proto::certificate_fingerprint(&cert_der);
                let identity = Self {
                    cert_der,
                    private_der,
                    fingerprint,
                };
                identity.server_config()?;
                Ok(identity)
            }
            (false, false) => Err(TlsError::Missing {
                dir: tls_dir.to_path_buf(),
            }),
            _ => Err(TlsError::Incomplete {
                dir: tls_dir.to_path_buf(),
            }),
        }
    }

    pub fn load_or_create(tls_dir: &Path, host_id: &str) -> Result<Self, TlsError> {
        let cert_path = tls_dir.join("cert.der");
        let key_path = tls_dir.join("key.der");
        match (cert_path.exists(), key_path.exists()) {
            (true, true) => {
                let cert_der = read(&cert_path)?;
                let private_der = read(&key_path)?;
                let fingerprint = markiro_proto::certificate_fingerprint(&cert_der);
                Ok(Self {
                    cert_der,
                    private_der,
                    fingerprint,
                })
            }
            (false, false) => {
                let names = vec!["localhost".to_owned(), format!("markiro-host-{host_id}")];
                let certified = rcgen::generate_simple_self_signed(names)
                    .map_err(|error| TlsError::Generate(error.to_string()))?;
                let cert_der = certified.cert.der().to_vec();
                let private_der = certified.signing_key.serialize_der();
                write_private(&key_path, &private_der)?;
                write_file(&cert_path, &cert_der)?;
                let fingerprint = markiro_proto::certificate_fingerprint(&cert_der);
                Ok(Self {
                    cert_der,
                    private_der,
                    fingerprint,
                })
            }
            _ => Err(TlsError::Incomplete {
                dir: tls_dir.to_path_buf(),
            }),
        }
    }

    /// Server configuration with the aws-lc-rs provider chosen explicitly: the
    /// workspace never relies on a process-wide default provider.
    pub fn server_config(&self) -> Result<Arc<rustls::ServerConfig>, TlsError> {
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let config = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|error| TlsError::Config(error.to_string()))?
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(self.cert_der.clone())],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.private_der.clone())),
            )
            .map_err(|error| TlsError::Config(error.to_string()))?;
        Ok(Arc::new(config))
    }
}

fn read(path: &Path) -> Result<Vec<u8>, TlsError> {
    fs::read(path).map_err(|source| TlsError::Io {
        path: path.to_path_buf(),
        source,
    })
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<(), TlsError> {
    fs::write(path, bytes).map_err(|source| TlsError::Io {
        path: path.to_path_buf(),
        source,
    })
}

/// Owner-only on Unix. On Windows the file inherits the data directory's ACL;
/// the installer hardens that directory in stage 5.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), TlsError> {
    use std::io::Write;
    let io = |source: std::io::Error| TlsError::Io {
        path: path.to_path_buf(),
        source,
    };
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(io)?;
    file.write_all(bytes).map_err(io)?;
    file.sync_all().map_err(io)
}
