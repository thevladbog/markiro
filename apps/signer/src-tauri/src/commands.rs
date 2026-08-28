use std::sync::Arc;

use signer_core::cloud::PairError;
use signer_core::runtime::{AgentStatus, Runtime};
use signer_core::signer::{CertificateSummary, Signer};
use signer_core::storage::{self, SecretStore};

pub struct SignerState {
    pub runtime: Arc<Runtime>,
}

#[tauri::command]
pub fn signer_status(state: tauri::State<'_, SignerState>) -> AgentStatus {
    state.runtime.status()
}

#[tauri::command]
pub async fn signer_pair(
    state: tauri::State<'_, SignerState>,
    code: String,
) -> Result<String, String> {
    let config = state.runtime.config().map_err(|e| e.to_string())?;
    let server_url = config
        .server_url
        .unwrap_or_else(|| crate::default_server_url().to_string());
    state
        .runtime
        .pair(&server_url, &code)
        .await
        .map_err(|error| match error {
            // The cloud deliberately does not distinguish wrong from expired
            // from rate-limited, so neither do we.
            PairError::Rejected => "rejected".to_string(),
            PairError::Network(_) => "unavailable".to_string(),
        })
}

#[tauri::command]
pub fn signer_unpair(state: tauri::State<'_, SignerState>) -> Result<(), String> {
    state.runtime.unpair().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn signer_list_certificates(
    state: tauri::State<'_, SignerState>,
) -> Result<Vec<CertificateSummary>, String> {
    state.runtime.certificates().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn signer_select_certificate(
    state: tauri::State<'_, SignerState>,
    thumbprint: String,
) -> Result<(), String> {
    state
        .runtime
        .select_certificate(&thumbprint)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn signer_set_server_url(
    state: tauri::State<'_, SignerState>,
    url: String,
) -> Result<(), String> {
    storage::validate_http_url(&url).map_err(|e| e.to_string())?;
    state.runtime.set_server_url(&url).map_err(|e| e.to_string())
}

/// The agent only ships for Windows; on other platforms the shell still builds
/// (so `cargo test` runs in CI on Linux) but every capability refuses.
#[cfg(not(windows))]
pub fn unsupported_platform_backends() -> (Arc<dyn Signer>, Arc<dyn SecretStore>) {
    use signer_core::SignerError;

    struct Unsupported;
    impl Signer for Unsupported {
        fn list_certificates(&self) -> Result<Vec<CertificateSummary>, SignerError> {
            Err(SignerError::CryptoProviderMissing("Windows only".into()))
        }
        fn sign_attached(&self, _t: &str, _p: &[u8]) -> Result<String, SignerError> {
            Err(SignerError::CryptoProviderMissing("Windows only".into()))
        }
    }
    impl SecretStore for Unsupported {
        fn protect(&self, _plaintext: &str) -> Result<String, SignerError> {
            Err(SignerError::Storage("Windows only".into()))
        }
        fn unprotect(&self, _protected: &str) -> Result<String, SignerError> {
            Err(SignerError::Storage("Windows only".into()))
        }
    }
    (Arc::new(Unsupported), Arc::new(Unsupported))
}
