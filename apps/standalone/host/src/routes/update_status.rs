//! `GET /v1/office/update-status` (plan ОБН-3, spec §10.11.7; every office
//! role): the host's version and packages, each unrevoked device's version
//! against the host's, its last download (`update.download`) and its last
//! installation (`app.update.start`), and the last rows of the
//! distribution's audit. Reads only; nothing here needs a write lock.

use std::cmp::Ordering;
use std::collections::HashMap;

use axum::extract::State;
use axum::Json;
use markiro_proto::update::distribution::{
    DeviceVersion, DeviceVersionState, HostPackage, OfficeUpdateStatus, PackageState,
    UpdateHistoryItem, UpdateMark,
};
use markiro_proto::update::AppVersion;
use markiro_proto::{DeviceKind, MIN_PROTOCOL_VERSION, PROTOCOL_VERSION};
use serde_json::Value;
use sqlx::SqliteConnection;

use crate::audit::actions;
use crate::auth::OfficeContext;
use crate::error::ApiError;
use crate::server::AppState;

/// How many rows of the distribution's audit the office sees.
pub const HISTORY_ROWS: i64 = 20;

/// A device's version against the host's (spec §10.11.6). A device that
/// never sent its version (`seen` false) is unknown, whatever its pairing
/// recorded.
pub fn device_state(
    host: Option<AppVersion>,
    min_protocol: u32,
    app_version: &str,
    protocol: u32,
    seen: bool,
) -> DeviceVersionState {
    let (Some(host), Some(app), true) = (host, app_version.parse::<AppVersion>().ok(), seen) else {
        return DeviceVersionState::Unknown;
    };
    match app.cmp(&host) {
        Ordering::Equal => DeviceVersionState::Current,
        Ordering::Greater => DeviceVersionState::Newer,
        Ordering::Less if protocol >= min_protocol => DeviceVersionState::Behind,
        Ordering::Less => DeviceVersionState::Incompatible,
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
    host: Option<AppVersion>,
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
                host,
                MIN_PROTOCOL_VERSION,
                &row.app_version,
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
    let host = host_version.parse::<AppVersion>().ok();
    // One snapshot for the devices and the audit; nothing is written.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let read = read_tables(&mut tx, host).await;
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
    use markiro_proto::update::AppVersion;

    use super::device_state;

    #[test]
    fn a_devices_state_follows_the_versions_and_the_protocol_window() {
        let host = "0.3.0".parse::<AppVersion>().ok();
        assert_eq!(
            device_state(host, 3, "0.3.0", 4, true),
            DeviceVersionState::Current
        );
        assert_eq!(
            device_state(host, 3, "0.2.1", 3, true),
            DeviceVersionState::Behind
        );
        assert_eq!(
            device_state(host, 3, "0.1.0", 2, true),
            DeviceVersionState::Incompatible
        );
        assert_eq!(
            device_state(host, 3, "0.4.0", 4, true),
            DeviceVersionState::Newer
        );
        assert_eq!(
            device_state(host, 3, "0.3.0", 4, false),
            DeviceVersionState::Unknown
        );
        assert_eq!(
            device_state(host, 3, "dev", 4, true),
            DeviceVersionState::Unknown
        );
        assert_eq!(
            device_state(None, 3, "0.3.0", 4, true),
            DeviceVersionState::Unknown
        );
    }
}
