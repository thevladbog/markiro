//! Native admin OAuth attempts and the service-owned connection coordinator.
use super::{
    secret_store::{Protector, ServiceCredentialStore, ServiceDpapi},
    state::{CloudAuditAction, CloudAuditEvent, DeliveryStore, Phase, SourceContext},
    tokens::TokenSupervisor,
};
use markiro_backup_cloud::{
    client::DiskClient,
    model::{ClientProfile, RuntimeCredentials, Secret},
    oauth::{DirectTransport, OAuthAttempt, OAuthClient, Transport},
    Error, Result,
};
use markiro_proto::yandex_backups::{
    AuthBeginReply, ConnectionState, DeliveryState, ErrorCode, YandexBackupStatus,
};
use std::{
    collections::HashMap,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    sync::{Mutex, Notify},
    time::Instant,
};
use uuid::Uuid;

pub type ServiceTokens = TokenSupervisor<Arc<dyn Transport>, Box<dyn Protector>>;
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttemptOwner {
    pub user_id: String,
    pub device_id: String,
    pub session_id: String,
    pub source: SourceContext,
}
impl AttemptOwner {
    fn same_session(&self, other: &Self) -> bool {
        self.user_id == other.user_id
            && self.device_id == other.device_id
            && self.session_id == other.session_id
    }
}
pub struct VerifiedAccount {
    pub id: String,
    pub label: String,
}
pub trait AccountVerifier: Send + Sync {
    fn verify(
        &self,
        access: &Secret,
    ) -> Pin<Box<dyn Future<Output = Result<VerifiedAccount>> + Send + '_>>;
}
struct DirectVerifier;
impl AccountVerifier for DirectVerifier {
    fn verify(
        &self,
        access: &Secret,
    ) -> Pin<Box<dyn Future<Output = Result<VerifiedAccount>> + Send + '_>> {
        let access = access.clone();
        Box::pin(async move {
            let disk = DiskClient::new(access)?;
            disk.check_folder().await?;
            let account = disk.account().await?;
            Ok(VerifiedAccount {
                id: account.id.clone(),
                label: account.display_name.unwrap_or(account.id),
            })
        })
    }
}
struct ReadyAttempt {
    owner: AttemptOwner,
    profile: ClientProfile,
    secret: Secret,
    oauth: OAuthAttempt,
    expected: Option<Uuid>,
    started_at: i64,
    expires_at: i64,
    deadline: Instant,
}
struct Inflight {
    owner: AttemptOwner,
    cancelled: Arc<AtomicBool>,
    expires_at: i64,
    deadline: Instant,
}
#[derive(Default)]
struct Attempts {
    ready: HashMap<Uuid, ReadyAttempt>,
    inflight: HashMap<Uuid, Inflight>,
}
impl Attempts {
    fn prune(&mut self, now: i64) {
        self.ready.retain(|_, a| {
            a.started_at <= now && a.expires_at > now && Instant::now() < a.deadline
        });
        self.inflight
            .retain(|_, a| a.expires_at > now && Instant::now() < a.deadline);
    }
}
pub struct PreparedConnection {
    id: Uuid,
    owner: AttemptOwner,
    credentials: RuntimeCredentials,
    expected: Option<Uuid>,
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
}

pub struct YandexService {
    pub journal: Arc<DeliveryStore>,
    pub tokens: Arc<ServiceTokens>,
    pub queue: Arc<super::queue::CloudQueue>,
    pub wake: Notify,
    pub private_dir: PathBuf,
    pub host_id: Uuid,
    oauth: OAuthClient<Arc<dyn Transport>>,
    verifier: Arc<dyn AccountVerifier>,
    attempts: Mutex<Attempts>,
    control: Mutex<()>,
}
impl YandexService {
    pub async fn new(data_dir: &Path, host_id: Uuid) -> Result<Arc<Self>> {
        Self::with_dependencies(
            data_dir,
            host_id,
            Arc::new(DirectTransport::new()?),
            Box::new(ServiceDpapi),
            Arc::new(DirectVerifier),
        )
        .await
    }
    pub async fn with_dependencies(
        data_dir: &Path,
        host_id: Uuid,
        transport: Arc<dyn Transport>,
        protector: Box<dyn Protector>,
        verifier: Arc<dyn AccountVerifier>,
    ) -> Result<Arc<Self>> {
        if host_id.is_nil() {
            return Err(Error::InvalidFormat);
        }
        let private_dir = data_dir.join("cloud-private");
        let store = Arc::new(ServiceCredentialStore::with_protector(
            &private_dir,
            protector,
        )?);
        let journal =
            Arc::new(DeliveryStore::open(&private_dir.join("cloud-backup-state.db")).await?);
        let queue = super::queue::CloudQueue::open(journal.clone()).await?;
        let tokens = Arc::new(TokenSupervisor::new(
            store,
            journal.clone(),
            host_id,
            OAuthClient::new(transport.clone()),
        ));
        Ok(Arc::new(Self {
            journal,
            tokens,
            queue,
            wake: Notify::new(),
            private_dir,
            host_id,
            oauth: OAuthClient::new(transport),
            verifier,
            attempts: Mutex::new(Attempts::default()),
            control: Mutex::new(()),
        }))
    }
    pub async fn begin(
        &self,
        owner: &AttemptOwner,
        client_id: &str,
        secret: Secret,
        expected: Option<Uuid>,
        now: i64,
    ) -> Result<AuthBeginReply> {
        let _control = self.control.lock().await;
        if self.journal.status().await?.connection_generation != expected {
            return Err(Error::InvalidAttempt);
        }
        let profile = ClientProfile::new(client_id)?;
        if secret.expose().len() > 512 {
            return Err(Error::InvalidFormat);
        }
        let oauth = OAuthAttempt::new(client_id, now)?;
        let authorization_url = oauth.authorization_url()?.to_string();
        let expires_at = now.checked_add(600).ok_or(Error::InvalidFormat)?;
        let mut attempts = self.attempts.lock().await;
        attempts.prune(now);
        // A second start by this session supersedes its old, unconsumed grant.
        attempts.ready.retain(|_, a| !a.owner.same_session(owner));
        if attempts.ready.len() + attempts.inflight.len() >= 32 {
            return Err(Error::Provider("rate_limited"));
        }
        let id = Uuid::new_v4();
        attempts.ready.insert(
            id,
            ReadyAttempt {
                owner: owner.clone(),
                profile,
                secret,
                oauth,
                expected,
                started_at: now,
                expires_at,
                deadline: Instant::now() + Duration::from_secs(600),
            },
        );
        Ok(AuthBeginReply {
            attempt_id: id.to_string(),
            authorization_url,
            expires_at: timestamp(expires_at)?,
        })
    }
    pub async fn prepare_complete(
        &self,
        owner: &AttemptOwner,
        id: Uuid,
        state: &str,
        code: &str,
        now: i64,
    ) -> Result<PreparedConnection> {
        let (mut attempt, cancelled) = {
            let mut attempts = self.attempts.lock().await;
            attempts.prune(now);
            if attempts.ready.get(&id).is_none_or(|a| a.owner != *owner) {
                return Err(Error::InvalidAttempt);
            }
            let attempt = attempts.ready.remove(&id).ok_or(Error::InvalidAttempt)?;
            let cancelled = Arc::new(AtomicBool::new(false));
            attempts.inflight.insert(
                id,
                Inflight {
                    owner: owner.clone(),
                    cancelled: cancelled.clone(),
                    expires_at: attempt.expires_at,
                    deadline: attempt.deadline,
                },
            );
            (attempt, cancelled)
        };
        let result = tokio::time::timeout_at(attempt.deadline, async {
            if self.journal.status().await?.connection_generation != attempt.expected {
                return Err(Error::InvalidAttempt);
            }
            let tokens = self
                .oauth
                .complete(&mut attempt.oauth, state, code, now)
                .await?;
            if cancelled.load(Ordering::Acquire) {
                return Err(Error::Provider("cancelled"));
            }
            let account = self.verifier.verify(&tokens.access).await?;
            validate_account(&account)?;
            let mut credentials = RuntimeCredentials {
                profile: attempt.profile,
                client_secret: attempt.secret,
                tokens,
                account_id: account.id,
                host_id: self.host_id,
                generation: Uuid::new_v4(),
            };
            credentials.tokens = self.oauth.refresh(&credentials, now).await?;
            if cancelled.load(Ordering::Acquire) {
                return Err(Error::Provider("cancelled"));
            }
            let verified = self.verifier.verify(&credentials.tokens.access).await?;
            validate_account(&verified)?;
            if verified.id != credentials.account_id {
                return Err(Error::Integrity);
            }
            if cancelled.load(Ordering::Acquire) {
                return Err(Error::Provider("cancelled"));
            }
            Ok(PreparedConnection {
                id,
                owner: owner.clone(),
                credentials,
                expected: attempt.expected,
                cancelled,
                deadline: attempt.deadline,
            })
        })
        .await
        .map_err(|_| Error::InvalidAttempt)
        .and_then(|r| r);
        if result.is_err() {
            self.attempts.lock().await.inflight.remove(&id);
        }
        result
    }
    pub async fn commit(&self, prepared: PreparedConnection, at: &str) -> Result<()> {
        let _control = self.control.lock().await;
        if prepared.cancelled.load(Ordering::Acquire) || Instant::now() >= prepared.deadline {
            return Err(Error::Provider("cancelled"));
        }
        let event = CloudAuditEvent {
            event_id: prepared.credentials.generation,
            at: at.into(),
            actor_user_id: Some(
                Uuid::parse_str(&prepared.owner.user_id).map_err(|_| Error::InvalidAttempt)?,
            ),
            action: CloudAuditAction::Connect,
            target_id: prepared.credentials.generation,
            client_id: prepared.credentials.profile.client_id.clone(),
            account_id: prepared.credentials.account_id.clone(),
            host_id: self.host_id,
            snapshot_id: None,
        };
        let result = self
            .queue
            .transition(self.tokens.replace_for_source(
                prepared.credentials,
                prepared.expected,
                Some(event),
                prepared.owner.source,
            ))
            .await;
        self.attempts.lock().await.inflight.remove(&prepared.id);
        if result.is_ok() {
            self.cancel_all().await;
            self.wake.notify_one();
        }
        result
    }
    pub async fn cancel(&self, owner: &AttemptOwner, id: Uuid) -> Result<()> {
        let _control = self.control.lock().await;
        let mut attempts = self.attempts.lock().await;
        if attempts
            .ready
            .get(&id)
            .is_some_and(|a| !a.owner.same_session(owner))
            || attempts
                .inflight
                .get(&id)
                .is_some_and(|a| !a.owner.same_session(owner))
        {
            return Err(Error::InvalidAttempt);
        }
        attempts.ready.remove(&id);
        if let Some(attempt) = attempts.inflight.remove(&id) {
            attempt.cancelled.store(true, Ordering::Release);
        }
        Ok(())
    }
    async fn cancel_all(&self) {
        let mut attempts = self.attempts.lock().await;
        attempts.ready.clear();
        for (_, attempt) in attempts.inflight.drain() {
            attempt.cancelled.store(true, Ordering::Release);
        }
    }
    pub async fn disconnect(&self, owner: &AttemptOwner, generation: Uuid, at: &str) -> Result<()> {
        let _control = self.control.lock().await;
        let binding = self.journal.status().await?.binding;
        let Some(binding) = binding else {
            return Ok(());
        };
        if binding.generation != generation {
            return Err(Error::InvalidAttempt);
        }
        let event = CloudAuditEvent {
            event_id: Uuid::new_v4(),
            at: at.into(),
            actor_user_id: Some(
                Uuid::parse_str(&owner.user_id).map_err(|_| Error::InvalidAttempt)?,
            ),
            action: CloudAuditAction::Disconnect,
            target_id: generation,
            client_id: binding.client_id,
            account_id: binding.account_id,
            host_id: self.host_id,
            snapshot_id: None,
        };
        self.queue
            .transition(self.tokens.disconnect_with_event(generation, Some(event)))
            .await?;
        self.cancel_all().await;
        self.wake.notify_one();
        Ok(())
    }
    pub async fn status(&self, now: i64) -> Result<YandexBackupStatus> {
        let _control = self.control.lock().await;
        let state = self.journal.status().await?;
        let mut attempts = self.attempts.lock().await;
        attempts.prune(now);
        let connecting = !attempts.ready.is_empty() || !attempts.inflight.is_empty();
        drop(attempts);
        let mut result = YandexBackupStatus {
            state: if connecting {
                ConnectionState::Connecting
            } else {
                ConnectionState::Disconnected
            },
            ..Default::default()
        };
        result.connection_generation = state.connection_generation.map(|g| g.to_string());
        if let Some(binding) = state.binding {
            result.connection_generation = Some(binding.generation.to_string());
            result.client_id = Some(binding.client_id);
            result.account_label = Some(binding.account_id.clone());
            result.account_id = Some(binding.account_id);
            result.state = ConnectionState::Connected;
            if let Err(error) = self.tokens.current_credentials().await {
                result.state = ConnectionState::ReauthRequired;
                result.error_code = Some(error_code(&error));
            }
        }
        result.last_confirmed_snapshot_id = state.last_snapshot.map(|id| id.0.to_string());
        result.last_confirmed_at = state.last_upload_at;
        result.last_confirmed_copy_created_at = state.last_copy_at;
        result.delivery_state = match state.active {
            Some(job) => {
                if job.retry_at > 0 {
                    result.next_attempt_at = Some(timestamp(job.retry_at)?);
                }
                match job.phase {
                    Phase::Queued => DeliveryState::Queued,
                    Phase::Staging => DeliveryState::Staging,
                    Phase::Uploading => DeliveryState::Uploading,
                    Phase::Verifying => DeliveryState::Verifying,
                    Phase::Publishing => DeliveryState::Publishing,
                }
            }
            None if state.pending.is_some() => DeliveryState::Queued,
            None if state.last_snapshot.is_some() => DeliveryState::Confirmed,
            _ => DeliveryState::Idle,
        };
        if let Some(code) = state.error {
            result.error_code = Some(error_code(&Error::Provider(safe_internal_code(&code))));
            result.delivery_state = DeliveryState::Failed;
        }
        if let Some(code) = state.connection_error {
            result.error_code = Some(code);
            if super::runtime::require_refresh_allowed(Some(code)).is_err() {
                result.state = ConnectionState::ReauthRequired;
            }
        }
        if state.refresh_retry_at > 0 {
            result.next_attempt_at = Some(timestamp(state.refresh_retry_at)?);
        }
        if result.error_code.is_none() {
            if let Some(error) = state.retention_error {
                result.error_code = Some(error);
            }
        }
        if result.next_attempt_at.is_none() && state.retention_retry_at > 0 {
            result.next_attempt_at = Some(timestamp(state.retention_retry_at)?);
        }
        Ok(result)
    }
}
fn validate_account(account: &VerifiedAccount) -> Result<()> {
    if account.id.is_empty()
        || account.id.len() > 200
        || !account
            .id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        || account.label.chars().count() > 200
        || account.label.chars().any(char::is_control)
    {
        return Err(Error::InvalidFormat);
    }
    Ok(())
}
fn timestamp(now: i64) -> Result<String> {
    time::OffsetDateTime::from_unix_timestamp(now)
        .map_err(|_| Error::InvalidFormat)?
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| Error::InvalidFormat)
}
fn safe_internal_code(code: &str) -> &'static str {
    match code {
        "rate_limited" => "rate_limited",
        "quota" => "quota",
        "access_denied" => "access_denied",
        "reauth" => "reauth",
        "identity_missing" => "identity_missing",
        "integrity" => "integrity",
        "unsupported_format" => "unsupported_format",
        "incompatible_version" => "incompatible_version",
        "local_space" => "local_space",
        "remote_conflict" => "remote_conflict",
        "cancelled" => "cancelled",
        "client_credentials_invalid" => "client_credentials_invalid",
        "secret_unavailable" => "secret_unavailable",
        "client_secret_required" => "client_secret_required",
        _ => "network",
    }
}
pub fn error_code(error: &Error) -> ErrorCode {
    if let Error::RetryAfter { status: 429, .. } = error {
        return ErrorCode::RateLimited;
    }
    match error {
        Error::SecretUnavailable => ErrorCode::SecretUnavailable,
        Error::Crypto | Error::Integrity => ErrorCode::IntegrityFailed,
        Error::InvalidFormat | Error::SizeLimit => ErrorCode::UnsupportedFormat,
        Error::InvalidAttempt => ErrorCode::Cancelled,
        Error::Io(_) => ErrorCode::LocalSpace,
        Error::Provider(code) => match *code {
            "rate_limited" => ErrorCode::RateLimited,
            "quota" => ErrorCode::QuotaExceeded,
            "access_denied" => ErrorCode::AccessDenied,
            "reauth" => ErrorCode::ReauthRequired,
            "identity_missing" => ErrorCode::IdentityMissing,
            "integrity" => ErrorCode::IntegrityFailed,
            "unsupported_format" => ErrorCode::UnsupportedFormat,
            "incompatible_version" => ErrorCode::IncompatibleVersion,
            "local_space" => ErrorCode::LocalSpace,
            "remote_conflict" => ErrorCode::RemoteConflict,
            "cancelled" => ErrorCode::Cancelled,
            "client_credentials_invalid" => ErrorCode::ClientCredentialsInvalid,
            "secret_unavailable" => ErrorCode::SecretUnavailable,
            "client_secret_required" => ErrorCode::ClientSecretRequired,
            _ => ErrorCode::Network,
        },
        _ => ErrorCode::Network,
    }
}
