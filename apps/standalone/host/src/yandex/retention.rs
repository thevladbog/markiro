//! Rotation is scoped to the bound application/account/host, after confirmation.
use super::state::{Binding, CloudAuditAction, CloudAuditEvent, DeliveryStore};
use markiro_backup_cloud::{
    model::{SnapshotId, OBJECTS},
    Error, Result,
};
use std::{future::Future, pin::Pin};
use time::OffsetDateTime;
use uuid::Uuid;
pub struct CopyStamp {
    pub host_id: Uuid,
    pub id: SnapshotId,
    pub at: OffsetDateTime,
}
pub fn candidates(copies: &[CopyStamp], host: Uuid, confirmed: SnapshotId) -> Vec<SnapshotId> {
    let dated: Vec<_> = copies
        .iter()
        .filter(|c| c.host_id == host)
        .map(|c| (c.id.0.to_string(), c.at))
        .collect();
    let mut keep = crate::backup::retention::keep(&dated);
    keep.insert(confirmed.0.to_string());
    copies
        .iter()
        .filter(|c| c.host_id == host && !keep.contains(&c.id.0.to_string()))
        .map(|c| c.id)
        .collect()
}
pub trait Remote: Send + Sync {
    fn copies(&self) -> Pin<Box<dyn Future<Output = Result<Vec<CopyStamp>>> + Send + '_>>;
    fn delete<'a>(
        &'a self,
        id: SnapshotId,
        name: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>>;
}
pub async fn rotate_due(
    remote: &impl Remote,
    store: &DeliveryStore,
    binding: &Binding,
    now: impl Fn() -> OffsetDateTime,
) -> Result<()> {
    let state = store.status().await?;
    if state.retention_retry_at > now().unix_timestamp() {
        return Ok(());
    }
    let at = crate::clock::format_timestamp(now());
    match rotate(remote, store, binding, &at).await {
        Ok(()) => store.retention_result(binding.generation, None, 0).await,
        Err(Error::InvalidAttempt) => Ok(()),
        Err(error) => {
            let code = super::connection::error_code(&error);
            let delay = match error {
                Error::RetryAfter { seconds, .. } => seconds,
                _ => 3600,
            };
            let deadline = now()
                .unix_timestamp()
                .saturating_add(i64::try_from(delay).unwrap_or(i64::MAX))
                .min(253402300799);
            store
                .retention_result(binding.generation, Some(code), deadline)
                .await
        }
    }
}
pub async fn rotate(
    remote: &impl Remote,
    store: &DeliveryStore,
    binding: &Binding,
    at: &str,
) -> Result<()> {
    let state = store.status().await?;
    if state.binding.as_ref() != Some(binding) || state.paused {
        return Err(Error::InvalidAttempt);
    }
    if !state.retention_due {
        return Ok(());
    }
    let confirmed = state.last_snapshot.ok_or(Error::InvalidAttempt)?;
    // Reconcile durable deletions before discovering additional candidates.
    for intent in state.purges.iter().filter(|p| p.binding == *binding) {
        if !store.is_current(binding.generation).await? {
            return Err(Error::InvalidAttempt);
        }
        if !intent.marker_removed {
            remote.delete(intent.snapshot, "complete.json").await?;
            store.marker_removed(intent.event.event_id).await?;
        }
        for name in OBJECTS {
            if !store.is_current(binding.generation).await? {
                return Err(Error::InvalidAttempt);
            }
            remote.delete(intent.snapshot, name).await?;
        }
        store.finish_purge(intent.event.event_id).await?;
    }
    let copies = remote.copies().await?;
    // Without a visible current confirmed marker, withdraw nothing.
    if !copies
        .iter()
        .any(|c| c.host_id == binding.host_id && c.id == confirmed)
    {
        return Err(Error::Integrity);
    }
    for id in candidates(&copies, binding.host_id, confirmed) {
        let event = CloudAuditEvent {
            event_id: Uuid::new_v4(),
            at: at.into(),
            actor_user_id: None,
            action: CloudAuditAction::Purge,
            target_id: id.0,
            client_id: binding.client_id.clone(),
            account_id: binding.account_id.clone(),
            host_id: binding.host_id,
            snapshot_id: Some(id),
        };
        let intent = store.begin_purge(binding.generation, id, event).await?;
        remote.delete(id, "complete.json").await?;
        store.marker_removed(intent.event.event_id).await?;
        for name in OBJECTS {
            if !store.is_current(binding.generation).await? {
                return Err(Error::InvalidAttempt);
            }
            remote.delete(id, name).await?;
        }
        store.finish_purge(intent.event.event_id).await?;
    }
    store.retention_done(binding.generation).await
}
