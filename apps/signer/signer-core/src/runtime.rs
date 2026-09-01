//! The agent loop: claim a task, obtain a token, report, repeat.
//!
//! Two rules shape it. A 401 on any authenticated call means the cabinet
//! revoked this agent, so local state is wiped and the UI returns to pairing.
//! A network failure is retried inside the True API flow. If those bounded
//! attempts are exhausted, it is reported so the claim does not stay stuck
//! until the cloud's 30-minute deadline.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::cloud::{CloudClient, PairError};
use crate::contracts::{cap_cert_subject, SignerErrorCode, TaskComplete, TaskFail};
use crate::journal::{redact, Journal, JournalEntry, JournalExportMetadata};
use crate::signer::Signer;
use crate::storage::{self, AgentConfig, SecretStore};
use crate::trueapi::obtain_token;
use crate::SignerError;

const POLL_WAIT_MS: u32 = 25_000;
const POLL_OUTAGE_GRACE: Duration = Duration::from_secs(5 * 60);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
const REPORT_ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentPhase {
    Unpaired,
    Idle,
    Reconnecting,
    Unavailable,
    Working,
    Degraded,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub phase: AgentPhase,
    pub app_version: String,
    /// The resolved machine name (never read from the webview — see
    /// `crate::hostname`), so the pairing screen can show it before pairing
    /// and it stays correct even if the operating system's idea of the
    /// computer name is unusual.
    pub hostname: String,
    pub tenant_name: Option<String>,
    pub cert_thumbprint: Option<String>,
    pub last_token_expires_at: Option<String>,
    pub last_error: Option<String>,
    pub journal: Vec<JournalEntry>,
}

/// Which failures are worth telling the cloud about. True API transport errors
/// reach this point only after the bounded local retry loop is exhausted.
pub fn classify(error: &SignerError) -> Option<SignerErrorCode> {
    match error {
        SignerError::CryptoProviderMissing(_) => Some(SignerErrorCode::CryptoProviderMissing),
        SignerError::CertNotFound(_) => Some(SignerErrorCode::CryptoCertNotFound),
        SignerError::CertExpired(_) => Some(SignerErrorCode::CryptoCertExpired),
        SignerError::ContainerUnavailable(_) => Some(SignerErrorCode::CryptoContainerUnavailable),
        SignerError::PinRequired => Some(SignerErrorCode::CryptoPinRequired),
        SignerError::Network(_) => Some(SignerErrorCode::Network),
        SignerError::TrueApi(_) => Some(SignerErrorCode::TrueApi),
        SignerError::Revoked | SignerError::Storage(_) | SignerError::Protocol(_) => None,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PollTransition {
    Started,
    Retrying,
    BecameUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PollRecovery {
    duration: Duration,
    attempts: u32,
}

#[derive(Debug, Default)]
struct PollIncident {
    started_at: Option<Instant>,
    attempts: u32,
    unavailable_emitted: bool,
}

impl PollIncident {
    fn record_failure(&mut self, now: Instant) -> PollTransition {
        self.attempts = self.attempts.saturating_add(1);
        let Some(started_at) = self.started_at else {
            self.started_at = Some(now);
            return PollTransition::Started;
        };
        if !self.unavailable_emitted
            && now.saturating_duration_since(started_at) >= POLL_OUTAGE_GRACE
        {
            self.unavailable_emitted = true;
            return PollTransition::BecameUnavailable;
        }
        PollTransition::Retrying
    }

    fn recover(&mut self, now: Instant) -> Option<PollRecovery> {
        let started_at = self.started_at?;
        let recovery = PollRecovery {
            duration: now.saturating_duration_since(started_at),
            attempts: self.attempts,
        };
        *self = Self::default();
        Some(recovery)
    }
}

pub struct Runtime {
    config_dir: PathBuf,
    signer: Arc<dyn Signer>,
    secrets: Arc<dyn SecretStore>,
    app_version: String,
    /// Resolved once at startup (the machine name does not change while the
    /// agent runs) via `crate::hostname::resolve_hostname` — never taken from
    /// the webview, whose origin in a Tauri 2 custom-protocol build is
    /// `tauri.localhost`, not the PC name.
    hostname: String,
    journal: Mutex<Journal>,
    phase: Mutex<AgentPhase>,
    /// The two pieces of `AgentStatus` that do not derive from
    /// `AgentConfig` on disk: `status()` used to hard-code both to `None`
    /// and rely on call sites patching a freshly built `AgentStatus`, which
    /// meant the very next `on_change(self.status())` — the next idle poll,
    /// at most `POLL_WAIT_MS` later — overwrote the patch and erased it.
    /// Holding them here makes `status()` read the real, current value.
    last_token_expires_at: Mutex<Option<String>>,
    last_error: Mutex<Option<String>>,
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
        let journal = match Journal::open(config_dir.join("journal")) {
            Ok(journal) => journal,
            Err(error) => {
                tracing::warn!(%error, "could not open persistent signer journal");
                let mut journal = Journal::default();
                journal.append(JournalEntry::new(
                    "Journal persistence unavailable",
                    Some(&error.to_string()),
                ));
                journal
            }
        };
        let phase = match storage::read_config(&config_dir) {
            Ok(config) if config.is_paired() => AgentPhase::Idle,
            _ => AgentPhase::Unpaired,
        };
        Ok(Self {
            config_dir,
            signer,
            secrets,
            app_version,
            hostname: crate::hostname::resolve_hostname(),
            journal: Mutex::new(journal),
            phase: Mutex::new(phase),
            last_token_expires_at: Mutex::new(None),
            last_error: Mutex::new(None),
            http,
        })
    }

    /// Sets the token-expiry field read by `status()`. Private: the only
    /// callers are inside the agent loop, which is why this is a plain
    /// setter rather than something exposed through `AgentStatus` mutation.
    fn set_last_token_expires_at(&self, value: Option<String>) {
        if let Ok(mut guard) = self.last_token_expires_at.lock() {
            *guard = value;
        }
    }

    /// Sets the error field read by `status()` and surfaced in a Windows
    /// notification. Redacts on the way in — not at the read site — so every
    /// caller gets the scrub for free and a raw True API response body (up
    /// to 1000 chars, which can itself contain a token) never reaches the UI
    /// or an OS toast unredacted.
    fn set_last_error(&self, value: Option<String>) {
        if let Ok(mut guard) = self.last_error.lock() {
            *guard = value.map(|v| redact(&v));
        }
    }

    fn set_phase(&self, phase: AgentPhase) {
        if let Ok(mut guard) = self.phase.lock() {
            *guard = phase;
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
            phase: if config.is_paired() {
                self.phase.lock().map(|phase| *phase).unwrap_or(AgentPhase::Degraded)
            } else {
                AgentPhase::Unpaired
            },
            app_version: self.app_version.clone(),
            hostname: self.hostname.clone(),
            tenant_name: config.tenant_name,
            cert_thumbprint: config.cert_thumbprint,
            last_token_expires_at: self.last_token_expires_at.lock().ok().and_then(|g| g.clone()),
            last_error: self.last_error.lock().ok().and_then(|g| g.clone()),
            journal: self.journal_entries(),
        }
    }

    /// Redeems a pairing code and persists the DPAPI-protected secret. The
    /// hostname sent is always the one this `Runtime` resolved at startup —
    /// never something supplied by a caller, so a webview cannot register an
    /// agent under its own custom-protocol origin.
    pub async fn pair(&self, server_url: &str, code: &str) -> Result<String, PairError> {
        storage::validate_http_url(server_url)
            .map_err(|e| PairError::Network(e.to_string()))?;
        let client = CloudClient::new(server_url, &self.app_version)
            .map_err(|e| PairError::Network(e.to_string()))?;
        let paired = client.pair(code, &self.hostname).await?;
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
        self.set_phase(AgentPhase::Idle);
        self.note("Agent paired", Some(&paired.tenant_name));
        Ok(paired.tenant_name)
    }

    /// Wipes the credential locally — used both on revocation and on operator
    /// request.
    pub fn unpair(&self) -> Result<(), SignerError> {
        storage::clear_credential(&self.config_dir)?;
        self.set_last_token_expires_at(None);
        self.set_last_error(None);
        self.set_phase(AgentPhase::Unpaired);
        self.note("Agent unpaired", None);
        Ok(())
    }

    pub async fn run<F>(self: Arc<Self>, on_change: F)
    where
        F: Fn(AgentStatus) + Send + Sync + 'static,
    {
        let mut failures: u32 = 0;
        let mut poll_incident = PollIncident::default();
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
                    if self.finish_poll_incident(&mut poll_incident, Instant::now()) {
                        self.set_phase(AgentPhase::Idle);
                        on_change(self.status());
                    }
                }
                Ok(Some(task)) => {
                    failures = 0;
                    self.finish_poll_incident(&mut poll_incident, Instant::now());
                    self.note("Task received", Some(&task.id));
                    self.execute(&client, &secret, &task, &on_change).await;
                }
                Err(SignerError::Revoked) => {
                    self.finish_poll_incident(&mut poll_incident, Instant::now());
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
                Err(error @ SignerError::Network(_)) => {
                    match poll_incident.record_failure(Instant::now()) {
                        PollTransition::Started => {
                            self.note("Connection interrupted; reconnecting", None);
                            self.set_last_error(None);
                            self.set_phase(AgentPhase::Reconnecting);
                            on_change(self.status());
                        }
                        PollTransition::Retrying => {}
                        PollTransition::BecameUnavailable => {
                            self.note(
                                "Cloud unavailable for five minutes",
                                Some(&error.to_string()),
                            );
                            self.set_last_error(Some(error.to_string()));
                            self.set_phase(AgentPhase::Unavailable);
                            on_change(self.status());
                        }
                    }
                    tokio::time::sleep(backoff_for(failures)).await;
                    failures = failures.saturating_add(1);
                }
                Err(error) => {
                    self.finish_poll_incident(&mut poll_incident, Instant::now());
                    self.note("Poll failed", Some(&error.to_string()));
                    // Emit the Degraded status before sleeping through the
                    // backoff, not after: the sleep can run for up to
                    // `MAX_BACKOFF` (60 s), and delaying `on_change` until it
                    // returns would leave the UI showing nothing wrong for
                    // that whole window after a failure.
                    self.set_last_error(Some(error.to_string()));
                    self.set_phase(AgentPhase::Degraded);
                    on_change(self.status());
                    tokio::time::sleep(backoff_for(failures)).await;
                    failures = failures.saturating_add(1);
                }
            }
        }
    }

    fn finish_poll_incident(&self, incident: &mut PollIncident, now: Instant) -> bool {
        let Some(recovery) = incident.recover(now) else {
            return false;
        };
        let detail = format!(
            "after {} seconds and {} attempts",
            recovery.duration.as_secs(),
            recovery.attempts
        );
        self.note("Connection restored", Some(&detail));
        self.set_last_error(None);
        true
    }

    async fn execute<F>(
        &self,
        client: &CloudClient,
        secret: &str,
        task: &crate::contracts::SignerTask,
        on_change: &F,
    ) where
        F: Fn(AgentStatus) + Send + Sync + 'static,
    {
        self.set_phase(AgentPhase::Working);
        on_change(self.status());

        // Re-read rather than trusting a snapshot taken before the poll that
        // just returned this task: that poll can hold for up to
        // `POLL_WAIT_MS` (25 s), and if the operator selects a certificate
        // while it is in flight, a stale snapshot would fail this task with
        // "no certificate has been selected" even though one now is.
        let Some(thumbprint) = self.config().ok().and_then(|c| c.cert_thumbprint) else {
            let body = TaskFail::new(
                SignerErrorCode::CryptoCertNotFound,
                "no certificate has been selected in the agent",
            );
            if let Err(error) = self
                .fail_with_retry(client, secret, &task.id, &body)
                .await
            {
                self.note_report_failure("Could not report the missing certificate", &error);
            }
            self.note("No certificate selected", None);
            self.set_phase(AgentPhase::Degraded);
            on_change(self.status());
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
            task.payload.token_format,
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
                    cert_subject: certificate.as_ref().map(|c| cap_cert_subject(&c.subject)),
                    cert_inn: certificate.as_ref().and_then(|c| c.inn.clone()),
                    cert_not_after: certificate.as_ref().map(|c| c.not_after.clone()),
                };

                // The PIN prompt, container access and True API round trip have
                // already succeeded by this point; a single transient failure
                // here must not throw that work away and leave the cloud
                // sitting on the claim for its full 30-minute deadline, so
                // retry a bounded number of times before giving up.
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
                    ) || attempt >= REPORT_ATTEMPTS;
                    if done {
                        break outcome;
                    }
                    tokio::time::sleep(backoff_for(attempt - 1)).await;
                };

                match result {
                    Ok(()) => {
                        self.note("True API token delivered", None);
                        self.set_last_token_expires_at(Some(token.expires_at));
                        self.set_last_error(None);
                        self.set_phase(AgentPhase::Idle);
                        on_change(self.status());
                    }
                    Err(error) => {
                        self.note_report_failure("Could not report the token", &error);
                        self.set_last_error(Some(error.to_string()));
                        self.set_phase(AgentPhase::Degraded);
                        on_change(self.status());
                    }
                }
            }
            Err(error) => {
                self.note("Signing failed", Some(&error.to_string()));
                if let Some(code) = classify(&error) {
                    let body = TaskFail::new(code, error.to_string());
                    if let Err(fail_error) =
                        self.fail_with_retry(client, secret, &task.id, &body).await
                    {
                        self.note_report_failure("Could not report the failure", &fail_error);
                    }
                }
                self.set_last_error(Some(error.to_string()));
                self.set_phase(AgentPhase::Degraded);
                on_change(self.status());
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

    pub fn export_journal(&self, destination: &Path) -> Result<(), SignerError> {
        let config = self.config().unwrap_or_default();
        let metadata = JournalExportMetadata {
            app_version: self.app_version.clone(),
            hostname: self.hostname.clone(),
            tenant_name: config.tenant_name,
        };
        self.journal
            .lock()
            .map_err(|_| SignerError::Storage("journal lock is poisoned".into()))?
            .export_zip(destination, &metadata)
            .map_err(|error| SignerError::Storage(error.to_string()))
    }

    async fn fail_with_retry(
        &self,
        client: &CloudClient,
        secret: &str,
        task_id: &str,
        body: &TaskFail,
    ) -> Result<(), SignerError> {
        let mut attempt = 0u32;
        loop {
            let outcome = client.fail(secret, task_id, body).await;
            attempt += 1;
            let done = matches!(
                outcome,
                Ok(()) | Err(SignerError::Revoked) | Err(SignerError::Protocol(_))
            ) || attempt >= REPORT_ATTEMPTS;
            if done {
                return outcome;
            }
            tokio::time::sleep(backoff_for(attempt - 1)).await;
        }
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
    use crate::contracts::{
        SignerErrorCode, SignerTask, TaskType, TokenFormat, TrueApiAuthPayload,
    };
    use crate::signer::CertificateSummary;
    use std::io::ErrorKind;
    use wiremock::matchers::{body_json, body_json_string, method, path};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

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

    struct PayloadSigner;
    impl Signer for PayloadSigner {
        fn list_certificates(&self) -> Result<Vec<CertificateSummary>, SignerError> {
            Ok(vec![])
        }
        fn sign_attached(&self, _thumbprint: &str, payload: &[u8]) -> Result<String, SignerError> {
            Ok(format!("signed-{}", String::from_utf8_lossy(payload)))
        }
    }

    /// A `Runtime` wired to a fresh temp config dir and inert Windows-only
    /// dependencies, for tests that only exercise the loop's own state
    /// (status, journal, pairing bookkeeping) rather than real crypto or a
    /// real cloud.
    fn test_runtime() -> (tempfile::TempDir, Runtime) {
        let dir = tempfile::tempdir().unwrap();
        let runtime = Runtime::new(
            dir.path().to_path_buf(),
            Arc::new(NoSigner),
            Arc::new(PlainStore),
            "0.1.0".into(),
        )
        .unwrap();
        (dir, runtime)
    }

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
        // Network blips are retried before classification. Once those bounded
        // attempts are exhausted, reporting NETWORK releases the claimed task
        // so the cabinet can request another refresh immediately.
        assert_eq!(
            classify(&SignerError::Network("x".into())),
            Some(SignerErrorCode::Network)
        );
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
    fn poll_incident_emits_only_at_start_and_after_the_grace_period() {
        let started_at = Instant::now();
        let mut incident = PollIncident::default();

        assert_eq!(incident.record_failure(started_at), PollTransition::Started);
        assert_eq!(incident.attempts, 1);
        assert_eq!(
            incident.record_failure(started_at + POLL_OUTAGE_GRACE - Duration::from_secs(1)),
            PollTransition::Retrying
        );
        assert_eq!(
            incident.record_failure(started_at + POLL_OUTAGE_GRACE),
            PollTransition::BecameUnavailable
        );
        assert_eq!(
            incident.record_failure(started_at + POLL_OUTAGE_GRACE + Duration::from_secs(30)),
            PollTransition::Retrying,
            "the unavailable transition must not be emitted repeatedly"
        );
        assert_eq!(incident.attempts, 4);
    }

    #[test]
    fn poll_incident_recovers_once_with_duration_and_attempts() {
        let started_at = Instant::now();
        let mut incident = PollIncident::default();
        incident.record_failure(started_at);
        incident.record_failure(started_at + Duration::from_secs(20));

        let recovery = incident
            .recover(started_at + Duration::from_secs(45))
            .expect("an active incident must recover");
        assert_eq!(recovery.duration, Duration::from_secs(45));
        assert_eq!(recovery.attempts, 2);
        assert_eq!(incident.recover(started_at + Duration::from_secs(46)), None);
    }

    #[test]
    fn status_keeps_the_runtime_phase_and_exposes_the_installed_version() {
        let (dir, runtime) = test_runtime();
        storage::write_config(
            dir.path(),
            &AgentConfig {
                server_url: Some("https://admin.markiro.app".into()),
                agent_secret_protected: Some("protected".into()),
                ..AgentConfig::default()
            },
        )
        .unwrap();
        runtime.set_phase(AgentPhase::Reconnecting);
        let status = runtime.status();

        assert_eq!(status.phase, AgentPhase::Reconnecting);
        assert_eq!(status.app_version, "0.1.0");
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
        let (_dir, runtime) = test_runtime();
        runtime.select_certificate("AB12").unwrap();
        assert_eq!(runtime.config().unwrap().cert_thumbprint.as_deref(), Some("AB12"));
    }

    #[test]
    fn journal_entries_survive_runtime_recreation() {
        let dir = tempfile::tempdir().unwrap();
        {
            let runtime = Runtime::new(
                dir.path().to_path_buf(),
                Arc::new(NoSigner),
                Arc::new(PlainStore),
                "0.1.0".into(),
            )
            .unwrap();
            runtime.note("Agent started", Some("safe detail"));
        }

        let restarted = Runtime::new(
            dir.path().to_path_buf(),
            Arc::new(NoSigner),
            Arc::new(PlainStore),
            "0.1.0".into(),
        )
        .unwrap();

        assert_eq!(restarted.status().journal.len(), 1);
        assert_eq!(restarted.status().journal[0].message, "Agent started");
    }

    #[test]
    fn runtime_exports_the_full_journal_with_agent_metadata() {
        use std::io::Read as _;

        let (dir, runtime) = test_runtime();
        runtime.note("Agent started", None);
        let destination = dir.path().join("export.zip");

        runtime.export_journal(&destination).unwrap();

        let file = std::fs::File::open(destination).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut metadata = String::new();
        archive
            .by_name("metadata.json")
            .unwrap()
            .read_to_string(&mut metadata)
            .unwrap();
        assert!(metadata.contains("0.1.0"));
        assert!(metadata.contains(&runtime.status().hostname));
    }

    // --- F1: `status()` must reflect the real, current value of the two
    // fields it used to hard-code to `None` on every call, not just the one
    // `AgentStatus` a call site happened to patch. ---

    #[test]
    fn a_token_expiry_survives_more_than_one_status_call() {
        let (_dir, runtime) = test_runtime();
        runtime.set_last_token_expires_at(Some("2026-08-28T20:00:00.000Z".into()));
        // Simulates the next idle poll's `on_change(self.status())`: the
        // hard-coded-`None` version of `status()` would erase this here.
        assert_eq!(
            runtime.status().last_token_expires_at.as_deref(),
            Some("2026-08-28T20:00:00.000Z")
        );
        assert_eq!(
            runtime.status().last_token_expires_at.as_deref(),
            Some("2026-08-28T20:00:00.000Z"),
            "a second status() call must not have erased it"
        );
    }

    #[test]
    fn a_last_error_survives_more_than_one_status_call() {
        let (_dir, runtime) = test_runtime();
        runtime.set_last_error(Some("boom".into()));
        assert_eq!(runtime.status().last_error.as_deref(), Some("boom"));
        assert_eq!(
            runtime.status().last_error.as_deref(),
            Some("boom"),
            "a second status() call must not have erased it"
        );
    }

    #[tokio::test]
    async fn retries_reporting_an_exhausted_signing_failure_after_a_network_blip() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/auth/key"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(r#"{"uuid":"u-1","data":"challenge-data"}"#),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/signer-agent/tasks/t1/fail"))
            .and(body_json_string(
                r#"{"errorCode":"CRYPTO_PIN_REQUIRED","message":"PIN required for the key container"}"#,
            ))
            .respond_with_err(|_: &Request| {
                std::io::Error::new(ErrorKind::ConnectionReset, "connection reset")
            })
            .with_priority(1)
            .up_to_n_times(1)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/signer-agent/tasks/t1/fail"))
            .and(body_json_string(
                r#"{"errorCode":"CRYPTO_PIN_REQUIRED","message":"PIN required for the key container"}"#,
            ))
            .respond_with(ResponseTemplate::new(204))
            .with_priority(2)
            .expect(1)
            .mount(&server)
            .await;

        let (_dir, runtime) = test_runtime();
        runtime.select_certificate("AB12").unwrap();
        let client = CloudClient::new(&server.uri(), "0.1.0").unwrap();
        let task = SignerTask {
            id: "t1".into(),
            task_type: TaskType::TrueApiAuth,
            payload: TrueApiAuthPayload {
                true_api_base_url: server.uri(),
                inn: None,
                token_format: TokenFormat::Jwt,
            },
        };

        runtime.execute(&client, "secret", &task, &|_| {}).await;
    }

    #[tokio::test]
    async fn reports_network_after_three_fresh_auth_attempts_are_exhausted() {
        let server = MockServer::start().await;
        for attempt in 1..=3 {
            let uuid = format!("u-{attempt}");
            let challenge = format!("challenge-{attempt}");
            Mock::given(method("GET"))
                .and(path("/auth/key"))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "uuid": uuid,
                    "data": challenge,
                })))
                .with_priority(attempt)
                .up_to_n_times(1)
                .expect(1)
                .mount(&server)
                .await;
            Mock::given(method("POST"))
                .and(path("/auth/simpleSignIn"))
                .and(body_json(serde_json::json!({
                    "uuid": format!("u-{attempt}"),
                    "data": format!("signed-challenge-{attempt}"),
                })))
                .respond_with_err(|_: &Request| {
                    std::io::Error::new(ErrorKind::ConnectionReset, "connection reset")
                })
                .with_priority(attempt)
                .up_to_n_times(1)
                .expect(1)
                .mount(&server)
                .await;
        }
        Mock::given(method("POST"))
            .and(path("/signer-agent/tasks/t-network/fail"))
            .and(body_json(serde_json::json!({
                "errorCode": "NETWORK",
                "message": format!(
                    "network failure: error sending request for url ({}/auth/simpleSignIn)",
                    server.uri()
                ),
            })))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let runtime = Runtime::new(
            dir.path().to_path_buf(),
            Arc::new(PayloadSigner),
            Arc::new(PlainStore),
            "0.1.0".into(),
        )
        .unwrap();
        runtime.select_certificate("AB12").unwrap();
        let client = CloudClient::new(&server.uri(), "0.1.0").unwrap();
        let task = SignerTask {
            id: "t-network".into(),
            task_type: TaskType::TrueApiAuth,
            payload: TrueApiAuthPayload {
                true_api_base_url: server.uri(),
                inn: None,
                token_format: TokenFormat::Jwt,
            },
        };

        runtime.execute(&client, "secret", &task, &|_| {}).await;
    }

    #[test]
    fn a_successful_completion_clears_a_previously_set_last_error() {
        let (_dir, runtime) = test_runtime();
        runtime.set_last_error(Some("boom".into()));
        runtime.set_last_error(None);
        assert_eq!(runtime.status().last_error, None);
    }

    #[test]
    fn unpair_clears_both_the_token_expiry_and_the_last_error() {
        let (_dir, runtime) = test_runtime();
        runtime.set_last_token_expires_at(Some("2026-08-28T20:00:00.000Z".into()));
        runtime.set_last_error(Some("boom".into()));
        runtime.unpair().unwrap();
        let status = runtime.status();
        assert_eq!(status.last_token_expires_at, None);
        assert_eq!(status.last_error, None);
    }

    // --- F3: a `TrueApi` error can embed up to 1000 chars of the raw True
    // API response body, which is exactly where a leaked token would sit. ---

    #[test]
    fn a_true_api_error_lands_redacted_in_status() {
        let (_dir, runtime) = test_runtime();
        let error = SignerError::TrueApi(
            r#"{"token":"notarealheader.notarealpayload.notarealsig","status":"ok"}"#.to_string(),
        );
        runtime.set_last_error(Some(error.to_string()));
        let detail = runtime.status().last_error.expect("last_error must be set");
        assert!(!detail.contains("notarealheader.notarealpayload.notarealsig"), "got {detail}");
        assert!(detail.contains("[redacted]"), "got {detail}");
    }

    // --- F2: the pairing screen must show the hostname `Runtime` resolved
    // itself, not something read from the webview. ---

    #[test]
    fn status_exposes_a_non_empty_resolved_hostname() {
        let (_dir, runtime) = test_runtime();
        // The actual value depends on the machine running the test (or its
        // `windows-pc` fallback off-Windows); what matters here is that
        // `AgentStatus` carries *some* resolved name rather than requiring
        // the caller to supply one.
        assert!(!runtime.status().hostname.is_empty());
    }
}
