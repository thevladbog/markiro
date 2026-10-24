//! Exactly-once business audit from an at-least-once private delivery outbox.
use super::state::{CloudAuditAction, CloudAuditEvent, DeliveryStore};
use crate::audit::{self, actions, Actor, Entry, Outcome};
use markiro_backup_cloud::{Error, Result};
use sqlx::{SqliteConnection, SqlitePool};
use uuid::Uuid;

/// Caller holds a business write transaction, so concurrent replays serialize.
/// Returns IDs to acknowledge only AFTER that transaction commits.
pub async fn write_events_in(
    conn: &mut SqliteConnection,
    events: &[CloudAuditEvent],
) -> Result<Vec<Uuid>> {
    let mut ids = Vec::new();
    for event in events {
        let action = match event.action {
            CloudAuditAction::Connect => actions::BACKUP_YANDEX_CONNECT,
            CloudAuditAction::Disconnect => actions::BACKUP_YANDEX_DISCONNECT,
            CloudAuditAction::Upload => actions::BACKUP_YANDEX_UPLOAD,
            CloudAuditAction::Purge => actions::BACKUP_YANDEX_PURGE,
        };
        let target = event.target_id.to_string();
        let id = event.event_id.to_string();
        let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM audit_log WHERE action=? AND target_id=? AND json_extract(details,'$.eventId')=?)").bind(action).bind(&target).bind(&id).fetch_one(&mut *conn).await.map_err(|_|Error::Provider("audit_unavailable"))?;
        if !exists {
            let user = event.actor_user_id.map(|u| u.to_string());
            let actor = user.as_deref().map_or(Actor::System, Actor::OfficeUser);
            let mut details = serde_json::json!({"eventId":event.event_id,"clientId":event.client_id,"accountId":event.account_id,"hostId":event.host_id});
            if let Some(snapshot) = event.snapshot_id {
                details["snapshotId"] = serde_json::json!(snapshot);
            }
            audit::record(
                conn,
                &event.at,
                Entry {
                    actor,
                    action,
                    target_type: Some(match event.action {
                        CloudAuditAction::Connect | CloudAuditAction::Disconnect => {
                            "backup_yandex_connection"
                        }
                        _ => "backup_yandex_snapshot",
                    }),
                    target_id: Some(&target),
                    outcome: Outcome::Ok,
                    details,
                },
            )
            .await
            .map_err(|_| Error::Provider("audit_unavailable"))?;
        }
        ids.push(event.event_id);
    }
    Ok(ids)
}

pub async fn flush_events(pool: &SqlitePool, store: &DeliveryStore) -> Result<()> {
    let events = store.events().await?;
    if events.is_empty() {
        return Ok(());
    }
    let mut tx = crate::db::begin_write(pool)
        .await
        .map_err(|_| Error::Provider("audit_unavailable"))?;
    let ids = write_events_in(&mut tx, &events).await?;
    tx.commit()
        .await
        .map_err(|_| Error::Provider("audit_unavailable"))?;
    for id in ids {
        store.ack_event(id).await?;
    }
    Ok(())
}
