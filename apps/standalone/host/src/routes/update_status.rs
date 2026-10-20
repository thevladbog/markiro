//! `GET /v1/office/update-status` (plan ОБН-3, spec §10.11.7; every office
//! role): the host's version and packages, each unrevoked device's version
//! and protocol (the protocol against the host's window, never the app version), its last download (`update.download`) and its last
//! installation (`app.update.start`), and the last rows of the
//! distribution's audit. Reads only; nothing here needs a write lock.

use std::collections::HashMap;

use axum::extract::State;
use axum::Json;
use markiro_proto::update::distribution::{
    DeviceVersion, DeviceVersionState, HostPackage, OfficeUpdateStatus, PackageState,
    UpdateHistoryItem, UpdateMark,
};
use markiro_proto::{DeviceKind, MIN_PROTOCOL_VERSION, PROTOCOL_VERSION};
use serde_json::Value;
use sqlx::SqliteConnection;

use crate::audit::actions;
use crate::auth::OfficeContext;
use crate::error::ApiError;
use crate::server::AppState;

/// How many rows of the distribution's audit the office sees.
pub const HISTORY_ROWS: i64 = 20;

/// A device's protocol against the host's window (spec §10.11.6). The app version is not
/// compared: the office, stations and handhelds have their own version lines. A device that
/// never sent its version (`seen` false) is unknown, whatever its pairing recorded. The window
/// is the host's for every device kind (`protocol_guard` applies it to all of them).
pub fn device_state(
    min_protocol: u32,
    max_protocol: u32,
    protocol: u32,
    seen: bool,
) -> DeviceVersionState {
    if !seen {
        DeviceVersionState::Unknown
    } else if protocol < min_protocol {
        DeviceVersionState::Incompatible
    } else if protocol > max_protocol {
        DeviceVersionState::HostOlder
    } else {
        DeviceVersionState::Compatible
    }
}

#[derive(sqlx::FromRow)]
struct DeviceRow {
    id: String,
    kind: String,
    name: String,
    line_id: Option<String>,
    line_name: Option<String>,
    app_version: String,
    protocol: i64,
    version_seen_at: Option<String>,
    last_seen_at: Option<String>,
}

fn text(details: &Value, key: &str) -> Option<String> {
    details.get(key).and_then(Value::as_str).map(str::to_owned)
}

async fn read_tables(
    conn: &mut SqliteConnection,
) -> Result<(Vec<DeviceVersion>, Vec<UpdateHistoryItem>), ApiError> {
    let rows: Vec<DeviceRow> = sqlx::query_as(
        "SELECT d.id, d.kind, d.name, d.line_id, l.name AS line_name, d.app_version, \
         d.protocol, d.version_seen_at, d.last_seen_at \
         FROM devices d LEFT JOIN lines l ON l.id = d.line_id \
         WHERE d.revoked_at IS NULL ORDER BY d.kind, d.name, d.id",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let marks: Vec<(
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
    )> = sqlx::query_as(
        "SELECT action, actor_kind, actor_id, \
             CASE WHEN target_type = 'device' THEN target_id END, at, details \
             FROM audit_log WHERE action IN (?, ?) AND result = 'ok' ORDER BY id",
    )
    .bind(actions::UPDATE_DOWNLOAD)
    .bind(actions::APP_UPDATE_START)
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let mut downloaded: HashMap<String, UpdateMark> = HashMap::new();
    let mut started: HashMap<String, UpdateMark> = HashMap::new();
    for (action, actor_kind, actor_id, target_device, at, details) in marks {
        let details: Value = serde_json::from_str(&details).unwrap_or(Value::Null);
        if action == actions::UPDATE_DOWNLOAD {
            if let (Some(device), "device") = (actor_id, actor_kind.as_str()) {
                let version = text(&details, "version");
                downloaded.insert(device, UpdateMark { at, version });
            }
        } else if let Some(device) = target_device.or_else(|| text(&details, "deviceId")) {
            let version = text(&details, "to");
            started.insert(device, UpdateMark { at, version });
        }
    }
    let devices = rows
        .into_iter()
        .map(|row| {
            let kind: DeviceKind = row.kind.parse().map_err(ApiError::internal)?;
            let protocol = u32::try_from(row.protocol).unwrap_or(0);
            let state = device_state(
                MIN_PROTOCOL_VERSION,
                PROTOCOL_VERSION,
                protocol,
                row.version_seen_at.is_some(),
            );
            Ok(DeviceVersion {
                downloaded: downloaded.remove(&row.id),
                install_started: started.remove(&row.id),
                id: row.id,
                kind,
                name: row.name,
                line_id: row.line_id,
                line_name: row.line_name,
                app_version: row.app_version,
                protocol,
                version_seen_at: row.version_seen_at,
                last_seen_at: row.last_seen_at,
                state,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    let history: Vec<(String, String, String, Option<String>, String)> = sqlx::query_as(
        "SELECT a.at, a.action, a.result, COALESCE(u.name, d.name), a.details \
         FROM audit_log a \
         LEFT JOIN office_users u ON a.actor_kind = 'office_user' AND u.id = a.actor_id \
         LEFT JOIN devices d ON a.actor_kind = 'device' AND d.id = a.actor_id \
         WHERE a.action IN (?, ?, ?, ?, ?) ORDER BY a.id DESC LIMIT ?",
    )
    .bind(actions::HOST_UPGRADE)
    .bind(actions::UPDATE_PACKAGE_STAGE)
    .bind(actions::UPDATE_PACKAGE_PROMOTE)
    .bind(actions::UPDATE_DOWNLOAD)
    .bind(actions::APP_UPDATE_START)
    .bind(HISTORY_ROWS)
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let history = history
        .into_iter()
        .map(|(at, action, result, actor, details)| {
            let details: Value = serde_json::from_str(&details).unwrap_or(Value::Null);
            UpdateHistoryItem {
                version: text(&details, "version"),
                from: text(&details, "from"),
                to: text(&details, "to"),
                at,
                action,
                result,
                actor,
            }
        })
        .collect();
    Ok((devices, history))
}

pub async fn update_status(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<OfficeUpdateStatus>, ApiError> {
    let (host_version, package) = match state.updates.as_ref() {
        Some(store) => {
            let reading = store.clone();
            let package = tokio::task::spawn_blocking(move || reading.status_blocking())
                .await
                .map_err(ApiError::internal)?;
            (store.host_version().to_owned(), package)
        }
        None => (
            crate::HOST_VERSION.to_owned(),
            HostPackage {
                state: PackageState::Missing,
                version: None,
                staged: None,
                previous: None,
                disk_bytes: 0,
            },
        ),
    };
    // One snapshot for the devices and the audit; nothing is written.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let read = read_tables(&mut tx).await;
    tx.rollback().await.map_err(ApiError::internal)?;
    let (devices, history) = read?;
    Ok(Json(OfficeUpdateStatus {
        host_version,
        protocol: PROTOCOL_VERSION,
        min_protocol: MIN_PROTOCOL_VERSION,
        package,
        devices,
        history,
    }))
}

#[cfg(test)]
mod tests {
    use markiro_proto::update::distribution::DeviceVersionState;

    use super::device_state;

    #[test]
    fn a_devices_state_follows_the_protocol_window_only() {
        // The window is 3..=4 here; the app version is not an input at all.
        assert_eq!(device_state(3, 4, 4, true), DeviceVersionState::Compatible);
        assert_eq!(device_state(3, 4, 3, true), DeviceVersionState::Compatible);
        assert_eq!(
            device_state(3, 4, 2, true),
            DeviceVersionState::Incompatible
        );
        assert_eq!(device_state(3, 4, 5, true), DeviceVersionState::HostOlder);
        assert_eq!(device_state(3, 4, 4, false), DeviceVersionState::Unknown);
    }
}
