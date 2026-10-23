//! Service lifecycle and refresh schedule; independent of office UI lifetime.
use super::{
    audit_outbox,
    connection::{error_code, YandexService},
    state::SourceContext,
};
use crate::server::AppState;
use markiro_backup_cloud::{Error, Result};
use markiro_proto::yandex_backups::ErrorCode;
use std::sync::Arc;
use tokio::{sync::watch, task::JoinHandle};

pub(super) fn require_refresh_allowed(code: Option<ErrorCode>) -> Result<()> {
    let reason = match code {
        Some(ErrorCode::ClientCredentialsInvalid) => "client_credentials_invalid",
        Some(ErrorCode::ReauthRequired) => "reauth",
        Some(ErrorCode::SecretUnavailable) => "secret_unavailable",
        Some(ErrorCode::ClientSecretRequired) => "client_secret_required",
        Some(ErrorCode::AccessDenied) => "access_denied",
        _ => return Ok(()),
    };
    Err(Error::Provider(reason))
}

/// Source epochs are checked before any provider request. Permanent OAuth
/// failures require a new native connection; transient failures survive restart.
pub async fn tick(state: &AppState, service: &Arc<YandexService>) -> Result<()> {
    audit_outbox::flush_events(&state.pool, &service.journal).await?;
    let status = service.journal.status().await?;
    let Some(binding) = status.binding else {
        return Ok(());
    };
    let source = {
        let mut conn = state
            .pool
            .acquire()
            .await
            .map_err(|_| Error::Io(std::io::ErrorKind::Other.into()))?;
        SourceContext::read(&mut conn)
            .await
            .map_err(|_| Error::InvalidFormat)?
    };
    if service
        .journal
        .observe_source(binding.generation, &source)
        .await?
        || require_refresh_allowed(status.connection_error).is_err()
    {
        return Ok(());
    }
    let now = state.now().unix_timestamp();
    if status.refresh_retry_at > now {
        return Ok(());
    }
    match service.tokens.tick(now).await {
        Ok(_) => {
            service
                .journal
                .refresh_result(binding.generation, None, 0)
                .await?
        }
        Err(Error::InvalidAttempt) => {} // a newer connection owns the journal
        Err(error) => {
            let code = error_code(&error);
            let retry_at = if require_refresh_allowed(Some(code)).is_ok() {
                let delay = match error {
                    Error::RetryAfter { seconds, .. } => seconds,
                    _ => {
                        let base =
                            [30u64, 120, 600, 3600][(status.refresh_failures as usize).min(3)];
                        let random = UuidJitter::sample();
                        base * 80 / 100 + random % (base * 40 / 100 + 1)
                    }
                };
                state
                    .now()
                    .unix_timestamp()
                    .saturating_add(i64::try_from(delay).unwrap_or(i64::MAX))
                    .min(253402300799)
            } else {
                0
            };
            match service
                .journal
                .refresh_result(binding.generation, Some(code), retry_at)
                .await
            {
                Ok(()) | Err(Error::InvalidAttempt) => {}
                Err(e) => return Err(e),
            }
        }
    }
    Ok(())
}

struct UuidJitter;
impl UuidJitter {
    fn sample() -> u64 {
        let id = uuid::Uuid::new_v4();
        let mut bytes = [0; 8];
        bytes.copy_from_slice(&id.as_bytes()[..8]);
        u64::from_le_bytes(bytes)
    }
}

pub fn spawn(
    state: AppState,
    service: Arc<YandexService>,
    mut stopping: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let delivery = super::delivery::run(state.clone(), service.clone(), stopping.clone());
        let refresh = async {
            loop {
                if *stopping.borrow() {
                    break;
                }
                let pass = tick(&state, &service);
                tokio::select! {
                    result=pass=>{if result.is_err(){tracing::warn!("Yandex backup service pass failed");}},
                    _=stopping.wait_for(|s|*s)=>break,
                }
                tokio::select! {
                    _=tokio::time::sleep(std::time::Duration::from_secs(30))=>{},
                    _=service.wake_refresh.notified()=>{},
                    _=stopping.wait_for(|s|*s)=>break,
                }
            }
        };
        tokio::join!(refresh, delivery);
    })
}
