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

/// A thumbprint prefix short enough to survive the journal's credential
/// redaction while still identifying which certificate a message is about.
pub fn short_thumbprint(thumbprint: &str) -> String {
    thumbprint.chars().take(8).collect()
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
    /// Built once and reused for every True API round trip. `Client::new()`
    /// panics if the TLS backend or resolver cannot initialise, which would
    /// abort the agent task with no journal entry and no UI signal; building
    /// it here, with the fallible builder form, keeps that failure inside
    /// `SignerError` and lets the client be reused across polls instead of
    /// reconnecting every task.
    http: reqwest::Client,
}

impl Runtime {
    pub fn new(
        config_dir: PathBuf,
        signer: Arc<dyn Signer>,
        secrets: Arc<dyn SecretStore>,
        app_version: String,
    ) -> Result<Self, SignerError> {
        let http = reqwest::Client::builder()
            .build()
            .map_err(|e| SignerError::Network(e.to_string()))?;
        Ok(Self {
            config_dir,
            signer,
            secrets,
            app_version,
            journal: Mutex::new(Journal::default()),
            http,
        })
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
                    if let Err(unpair_error) = self.unpair() {
                        // `unpair` failing (read-only profile, full disk) means
                        // `is_paired()` still reports true, so without the
                        // backoff below this branch would busy-spin, firing
                        // `on_change` at full speed.
                        self.note("Could not clear the local credential", Some(&unpair_error.to_string()));
                    }
                    on_change(self.status());
                    tokio::time::sleep(backoff_for(failures)).await;
                    failures = failures.saturating_add(1);
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
                    if let Err(unpair_error) = self.unpair() {
                        // Same busy-spin hazard as above: if the write fails,
                        // `is_paired()` stays true and, with no throttle here,
                        // the loop would hammer the cloud with 401s (the auth
                        // guard rejects before the long-poll hold, so polling
                        // itself provides no natural delay).
                        self.note("Could not clear the local credential", Some(&unpair_error.to_string()));
                    }
                    on_change(self.status());
                    tokio::time::sleep(backoff_for(failures)).await;
                    failures = failures.saturating_add(1);
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
            if let Err(error) = client.fail(secret, &task.id, &body).await {
                self.note_report_failure("Could not report the missing certificate", &error);
            }
            self.note("No certificate selected", None);
            return;
        };

        // Look up the certificate's report metadata *before* the (comparatively
        // slow) True API round trip below, and never swallow a failure here:
        // these fields are `skip_serializing_if = "Option::is_none"` and the
        // cloud writes them unconditionally on every report, so silently
        // sending `None` would null out the operator-facing certificate
        // metadata in the cabinet on the success path -- exactly where the
        // certificate has just demonstrably worked. If enumeration fails or
        // the selected thumbprint is gone, journal it and keep going with
        // whatever was found; the sign itself does not depend on this lookup.
        let certificate = match self.signer.list_certificates() {
            Ok(certs) => {
                let found = certs.into_iter().find(|c| c.thumbprint == thumbprint);
                if found.is_none() {
                    // A full thumbprint is a long hex run, which the journal's
                    // credential redaction rewrites to `[redacted]` -- leaving
                    // the operator no way to tell which certificate went
                    // missing. A short prefix identifies it and stays legible.
                    self.note(
                        "Selected certificate is missing from the certificate list",
                        Some(&short_thumbprint(&thumbprint)),
                    );
                }
                found
            }
            Err(error) => {
                self.note(
                    "Could not enumerate certificates for report metadata",
                    Some(&error.to_string()),
                );
                None
            }
        };

        let outcome = obtain_token(
            &self.http,
            &task.payload.true_api_base_url,
            task.payload.inn.as_deref(),
            &thumbprint,
            self.signer.as_ref(),
        )
        .await;

        match outcome {
            Ok(token) => {
                let body = TaskComplete {
                    token: token.token,
                    expires_at: token.expires_at.clone(),
                    cert_thumbprint: thumbprint,
                    cert_subject: certificate.as_ref().map(|c| c.subject.clone()),
                    cert_inn: certificate.as_ref().and_then(|c| c.inn.clone()),
                    cert_not_after: certificate.as_ref().map(|c| c.not_after.clone()),
                };

                // The PIN prompt, container access and True API round trip have
                // already succeeded by this point; a single transient failure
                // here must not throw that work away and leave the cloud
                // sitting on the claim for its full 30-minute deadline, so
                // retry a bounded number of times before giving up.
                const COMPLETE_ATTEMPTS: u32 = 3;
                let mut attempt = 0u32;
                let result = loop {
                    let outcome = client.complete(secret, &task.id, &body).await;
                    attempt += 1;
                    // `Revoked` and `Protocol` are terminal verdicts from the
                    // cloud -- a 401 will not become a 200, and a 404 means the
                    // claim is already gone. Retrying either only burns time.
                    let done = matches!(
                        outcome,
                        Ok(()) | Err(SignerError::Revoked) | Err(SignerError::Protocol(_))
                    )
                        || attempt >= COMPLETE_ATTEMPTS;
                    if done {
                        break outcome;
                    }
                    tokio::time::sleep(backoff_for(attempt - 1)).await;
                };

                match result {
                    Ok(()) => {
                        self.note("True API token delivered", None);
                        let mut status = self.status();
                        status.last_token_expires_at = Some(token.expires_at);
                        on_change(status);
                    }
                    Err(error) => {
                        self.note_report_failure("Could not report the token", &error);
                        let mut status = self.status();
                        status.phase = AgentPhase::Degraded;
                        status.last_error = Some(error.to_string());
                        on_change(status);
                    }
                }
            }
            Err(error) => {
                self.note("Signing failed", Some(&error.to_string()));
                if let Some(code) = classify(&error) {
                    let body = TaskFail::new(code, error.to_string());
                    if let Err(fail_error) = client.fail(secret, &task.id, &body).await {
                        self.note_report_failure("Could not report the failure", &fail_error);
                    }
                }
                let mut status = self.status();
                status.phase = AgentPhase::Degraded;
                status.last_error = Some(error.to_string());
                on_change(status);
            }
        }
    }

    pub fn certificates(&self) -> Result<Vec<crate::signer::CertificateSummary>, SignerError> {
        self.signer.list_certificates()
    }

    pub fn select_certificate(&self, thumbprint: &str) -> Result<(), SignerError> {
        let mut config = self.config()?;
        config.cert_thumbprint = Some(thumbprint.to_string());
        storage::write_config(&self.config_dir, &config)?;
        self.note("Certificate selected", Some(thumbprint));
        Ok(())
    }

    pub fn set_server_url(&self, url: &str) -> Result<(), SignerError> {
        storage::validate_http_url(url)?;
        let mut config = self.config()?;
        config.server_url = Some(url.trim_end_matches('/').to_string());
        storage::write_config(&self.config_dir, &config)
    }

    /// Journals a failed report call (`complete`/`fail`), distinguishing a
    /// revocation from any other failure: a 401 here means the cabinet revoked
    /// this agent mid-task, which is a materially different situation from a
    /// generic report failure and was previously indistinguishable in the
    /// journal (or, for `fail`, produced no entry at all). The actual unpair
    /// still happens on the next poll -- this only makes the entry legible.
    fn note_report_failure(&self, message: &str, error: &SignerError) {
        if matches!(error, SignerError::Revoked) {
            self.note(&format!("{message}: the cabinet revoked this agent"), None);
        } else {
            self.note(message, Some(&error.to_string()));
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

    #[test]
    fn a_short_thumbprint_survives_journal_redaction() {
        let full = "AB12CD34EF56AB12CD34EF56AB12CD34EF56AB12";
        let short = short_thumbprint(full);
        assert_eq!(short, "AB12CD34");
        // The whole point: the shortened form must not itself be mistaken for
        // a credential by the journal.
        let entry = crate::journal::JournalEntry::new("cert missing", Some(&short));
        assert_eq!(entry.detail.as_deref(), Some("AB12CD34"));
        // ...while the full one is redacted, which is why we shorten it.
        let full_entry = crate::journal::JournalEntry::new("cert missing", Some(full));
        assert_eq!(full_entry.detail.as_deref(), Some("[redacted]"));
    }

    #[test]
    fn selecting_a_certificate_persists_it() {
        use crate::signer::CertificateSummary;
        struct NoSigner;
        impl Signer for NoSigner {
            fn list_certificates(&self) -> Result<Vec<CertificateSummary>, SignerError> {
                Ok(vec![])
            }
            fn sign_attached(&self, _t: &str, _p: &[u8]) -> Result<String, SignerError> {
                Err(SignerError::PinRequired)
            }
        }
        struct PlainStore;
        impl SecretStore for PlainStore {
            fn protect(&self, plaintext: &str) -> Result<String, SignerError> {
                Ok(plaintext.to_string())
            }
            fn unprotect(&self, protected: &str) -> Result<String, SignerError> {
                Ok(protected.to_string())
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let runtime = Runtime::new(
            dir.path().to_path_buf(),
            Arc::new(NoSigner),
            Arc::new(PlainStore),
            "0.1.0".into(),
        )
        .unwrap();
        runtime.select_certificate("AB12").unwrap();
        assert_eq!(runtime.config().unwrap().cert_thumbprint.as_deref(), Some("AB12"));
    }
}
