//! The agent loop: claim a task, obtain a token, report, repeat.
//!
//! Two rules shape it. A 401 on any authenticated call means the cabinet
//! revoked this agent, so local state is wiped and the UI returns to pairing.
//! A network failure is *not* reported as a task failure: the claim stays with
//! us until the cloud's 30-minute deadline, and reporting `fail` would burn the
//! refresh window over a blip.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::cloud::{CloudClient, PairError};
use crate::contracts::{SignerErrorCode, TaskComplete, TaskFail};
use crate::journal::{Journal, JournalEntry};
use crate::signer::Signer;
use crate::storage::{self, AgentConfig, SecretStore};
use crate::trueapi::obtain_token;
use crate::SignerError;

const POLL_WAIT_MS: u32 = 25_000;
const MAX_BACKOFF: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentPhase {
    Unpaired,
    Idle,
    Working,
    Degraded,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub phase: AgentPhase,
    pub tenant_name: Option<String>,
    pub cert_thumbprint: Option<String>,
    pub last_token_expires_at: Option<String>,
    pub last_error: Option<String>,
    pub journal: Vec<JournalEntry>,
}

/// Which failures are worth telling the cloud about. `None` means "keep the
/// claim and retry locally".
pub fn classify(error: &SignerError) -> Option<SignerErrorCode> {
    match error {
        SignerError::CryptoProviderMissing(_) => Some(SignerErrorCode::CryptoProviderMissing),
        SignerError::CertNotFound(_) => Some(SignerErrorCode::CryptoCertNotFound),
        SignerError::CertExpired(_) => Some(SignerErrorCode::CryptoCertExpired),
        SignerError::ContainerUnavailable(_) => Some(SignerErrorCode::CryptoContainerUnavailable),
        SignerError::PinRequired => Some(SignerErrorCode::CryptoPinRequired),
        SignerError::TrueApi(_) => Some(SignerErrorCode::TrueApi),
        SignerError::Network(_) | SignerError::Revoked | SignerError::Storage(_) | SignerError::Protocol(_) => None,
    }
}

pub fn backoff_for(attempt: u32) -> Duration {
    let seconds = 2u64.saturating_pow(attempt.min(6) + 1);
    Duration::from_secs(seconds).min(MAX_BACKOFF)
}

pub struct Runtime {
    config_dir: PathBuf,
    signer: Arc<dyn Signer>,
    secrets: Arc<dyn SecretStore>,
    app_version: String,
    journal: Mutex<Journal>,
}

impl Runtime {
    pub fn new(
        config_dir: PathBuf,
        signer: Arc<dyn Signer>,
        secrets: Arc<dyn SecretStore>,
        app_version: String,
    ) -> Self {
        Self {
            config_dir,
            signer,
            secrets,
            app_version,
            journal: Mutex::new(Journal::default()),
        }
    }

    pub fn config(&self) -> Result<AgentConfig, SignerError> {
        storage::read_config(&self.config_dir)
    }

    fn note(&self, message: &str, detail: Option<&str>) {
        if let Ok(mut journal) = self.journal.lock() {
            journal.append(JournalEntry::new(message, detail));
        }
    }

    fn journal_entries(&self) -> Vec<JournalEntry> {
        self.journal
            .lock()
            .map(|journal| journal.entries())
            .unwrap_or_default()
    }

    pub fn status(&self) -> AgentStatus {
        let config = self.config().unwrap_or_default();
        AgentStatus {
            phase: if config.is_paired() { AgentPhase::Idle } else { AgentPhase::Unpaired },
            tenant_name: config.tenant_name,
            cert_thumbprint: config.cert_thumbprint,
            last_token_expires_at: None,
            last_error: None,
            journal: self.journal_entries(),
        }
    }

    /// Redeems a pairing code and persists the DPAPI-protected secret.
    pub async fn pair(&self, server_url: &str, code: &str, hostname: &str) -> Result<String, PairError> {
        storage::validate_http_url(server_url)
            .map_err(|e| PairError::Network(e.to_string()))?;
        let client = CloudClient::new(server_url, &self.app_version)
            .map_err(|e| PairError::Network(e.to_string()))?;
        let paired = client.pair(code, hostname).await?;
        let protected = self
            .secrets
            .protect(&paired.agent_secret)
            .map_err(|e| PairError::Network(e.to_string()))?;
        let existing = self.config().unwrap_or_default();
        storage::write_config(
            &self.config_dir,
            &AgentConfig {
                agent_id: Some(paired.agent_id),
                tenant_name: Some(paired.tenant_name.clone()),
                server_url: Some(server_url.trim_end_matches('/').to_string()),
                cert_thumbprint: existing.cert_thumbprint,
                agent_secret_protected: Some(protected),
            },
        )
        .map_err(|e| PairError::Network(e.to_string()))?;
        self.note("Agent paired", Some(&paired.tenant_name));
        Ok(paired.tenant_name)
    }

    /// Wipes the credential locally — used both on revocation and on operator
    /// request.
    pub fn unpair(&self) -> Result<(), SignerError> {
        storage::clear_credential(&self.config_dir)?;
        self.note("Agent unpaired", None);
        Ok(())
    }

    pub async fn run<F>(self: Arc<Self>, on_change: F)
    where
        F: Fn(AgentStatus) + Send + Sync + 'static,
    {
        let mut failures: u32 = 0;
        loop {
            let config = match self.config() {
                Ok(config) => config,
                Err(error) => {
                    self.note("Could not read the local configuration", Some(&error.to_string()));
                    tokio::time::sleep(backoff_for(failures)).await;
                    failures = failures.saturating_add(1);
                    continue;
                }
            };
            if !config.is_paired() {
                on_change(self.status());
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
            let (Some(server_url), Some(protected)) =
                (config.server_url.clone(), config.agent_secret_protected.clone())
            else {
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            };
            let secret = match self.secrets.unprotect(&protected) {
                Ok(secret) => secret,
                Err(error) => {
                    // The blob belongs to another user or profile: pairing again
                    // is the only recovery.
                    self.note("Stored credential is unreadable", Some(&error.to_string()));
                    let _ = self.unpair();
                    on_change(self.status());
                    continue;
                }
            };
            let client = match CloudClient::new(&server_url, &self.app_version) {
                Ok(client) => client,
                Err(error) => {
                    self.note("Could not build the cloud client", Some(&error.to_string()));
                    tokio::time::sleep(backoff_for(failures)).await;
                    failures = failures.saturating_add(1);
                    continue;
                }
            };

            match client.poll(&secret, POLL_WAIT_MS).await {
                Ok(None) => {
                    failures = 0;
                    on_change(self.status());
                }
                Ok(Some(task)) => {
                    failures = 0;
                    self.note("Task received", Some(&task.id));
                    self.execute(&client, &secret, &config, &task, &on_change).await;
                }
                Err(SignerError::Revoked) => {
                    self.note("The cabinet revoked this agent", None);
                    let _ = self.unpair();
                    on_change(self.status());
                }
                Err(error) => {
                    self.note("Poll failed", Some(&error.to_string()));
                    tokio::time::sleep(backoff_for(failures)).await;
                    failures = failures.saturating_add(1);
                    let mut status = self.status();
                    status.phase = AgentPhase::Degraded;
                    status.last_error = Some(error.to_string());
                    on_change(status);
                }
            }
        }
    }

    async fn execute<F>(
        &self,
        client: &CloudClient,
        secret: &str,
        config: &AgentConfig,
        task: &crate::contracts::SignerTask,
        on_change: &F,
    ) where
        F: Fn(AgentStatus) + Send + Sync + 'static,
    {
        let mut status = self.status();
        status.phase = AgentPhase::Working;
        on_change(status);

        let Some(thumbprint) = config.cert_thumbprint.clone() else {
            let body = TaskFail::new(
                SignerErrorCode::CryptoCertNotFound,
                "no certificate has been selected in the agent",
            );
            let _ = client.fail(secret, &task.id, &body).await;
            self.note("No certificate selected", None);
            return;
        };

        let http = reqwest::Client::new();
        let outcome = obtain_token(
            &http,
            &task.payload.true_api_base_url,
            task.payload.inn.as_deref(),
            &thumbprint,
            self.signer.as_ref(),
        )
        .await;

        match outcome {
            Ok(token) => {
                let certificate = self
                    .signer
                    .list_certificates()
                    .ok()
                    .and_then(|certs| certs.into_iter().find(|c| c.thumbprint == thumbprint));
                // Send every cert field on every report: the cloud writes them
                // unconditionally, so omitting one nulls a stored value.
                let body = TaskComplete {
                    token: token.token,
                    expires_at: token.expires_at.clone(),
                    cert_thumbprint: thumbprint,
                    cert_subject: certificate.as_ref().map(|c| c.subject.clone()),
                    cert_inn: certificate.as_ref().and_then(|c| c.inn.clone()),
                    cert_not_after: certificate.as_ref().map(|c| c.not_after.clone()),
                };
                match client.complete(secret, &task.id, &body).await {
                    Ok(()) => {
                        self.note("True API token delivered", None);
                        let mut status = self.status();
                        status.last_token_expires_at = Some(token.expires_at);
                        on_change(status);
                    }
                    Err(error) => self.note("Could not report the token", Some(&error.to_string())),
                }
            }
            Err(error) => {
                self.note("Signing failed", Some(&error.to_string()));
                if let Some(code) = classify(&error) {
                    let body = TaskFail::new(code, error.to_string());
                    let _ = client.fail(secret, &task.id, &body).await;
                }
                let mut status = self.status();
                status.phase = AgentPhase::Degraded;
                status.last_error = Some(error.to_string());
                on_change(status);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::SignerErrorCode;

    #[test]
    fn maps_crypto_failures_onto_wire_error_codes() {
        assert_eq!(
            classify(&SignerError::PinRequired),
            Some(SignerErrorCode::CryptoPinRequired)
        );
        assert_eq!(
            classify(&SignerError::ContainerUnavailable("x".into())),
            Some(SignerErrorCode::CryptoContainerUnavailable)
        );
        assert_eq!(
            classify(&SignerError::CryptoProviderMissing("x".into())),
            Some(SignerErrorCode::CryptoProviderMissing)
        );
        assert_eq!(
            classify(&SignerError::CertNotFound("x".into())),
            Some(SignerErrorCode::CryptoCertNotFound)
        );
        assert_eq!(
            classify(&SignerError::TrueApi("x".into())),
            Some(SignerErrorCode::TrueApi)
        );
        // A transient network failure must NOT be reported as a task failure:
        // the cloud re-enqueues after its own timeout, and failing the task
        // would waste the whole refresh window on a blip.
        assert_eq!(classify(&SignerError::Network("x".into())), None);
        assert_eq!(classify(&SignerError::Revoked), None);
    }

    #[test]
    fn backoff_grows_and_is_capped() {
        assert_eq!(backoff_for(0).as_secs(), 2);
        assert_eq!(backoff_for(1).as_secs(), 4);
        assert_eq!(backoff_for(2).as_secs(), 8);
        assert_eq!(backoff_for(10).as_secs(), 60, "must be capped so a recovered link is picked up promptly");
    }
}
