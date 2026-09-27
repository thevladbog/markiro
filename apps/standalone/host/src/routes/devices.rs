//! A device's own record (`GET /v1/device`), a station's choice of line
//! (`PUT /v1/device/line`) and the administrator's list of paired devices
//! (`GET /v1/office/devices`). Renaming, reassigning and revoking from the
//! office arrive in plan 1d.

use axum::extract::State;
use axum::Json;
use markiro_proto::{DeviceInfo, DeviceKind, DeviceLineRequest, DeviceRecord};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::auth::{AuthDevice, OfficeContext};
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson};
use crate::server::AppState;

async fn read_info(
    conn: &mut SqliteConnection,
    device: &AuthDevice,
) -> Result<DeviceInfo, ApiError> {
    let (name, line_id, paired_at): (String, Option<String>, String) =
        sqlx::query_as("SELECT name, line_id, paired_at FROM devices WHERE id = ?")
            .bind(&device.id)
            .fetch_one(conn)
            .await
            .map_err(ApiError::internal)?;
    Ok(DeviceInfo {
        id: device.id.clone(),
        kind: device.kind,
        name,
        line_id,
        paired_at,
    })
}

pub async fn device_info(
    State(state): State<AppState>,
    device: AuthDevice,
) -> Result<Json<DeviceInfo>, ApiError> {
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    read_info(&mut conn, &device).await.map(Json)
}

/// A station picks the line it works on: only an existing, active line.
/// Devices are not in the change feed, so the host revision stays.
pub async fn select_line(
    State(state): State<AppState>,
    device: AuthDevice,
    ApiJson(request): ApiJson<DeviceLineRequest>,
) -> Result<Json<DeviceInfo>, ApiError> {
    if device.kind != DeviceKind::Station {
        return Err(ApiError::forbidden("only a station works on a line"));
    }
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    let archived: Option<i64> = sqlx::query_scalar("SELECT archived FROM lines WHERE id = ?")
        .bind(&request.line_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if archived != Some(0) {
        return Err(ApiError::validation("lineId", "no such active line"));
    }
    let current: Option<String> = sqlx::query_scalar("SELECT line_id FROM devices WHERE id = ?")
        .bind(&device.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if let Some(details) =
        audit::update_details(&[("lineId", json!(current), json!(request.line_id))])
    {
        sqlx::query("UPDATE devices SET line_id = ? WHERE id = ?")
            .bind(&request.line_id)
            .bind(&device.id)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        audit::record(
            &mut tx,
            &at,
            Entry {
                actor: Actor::Device(&device.id),
                action: actions::DEVICE_LINE,
                target_type: Some("device"),
                target_id: Some(&device.id),
                outcome: Outcome::Ok,
                details,
            },
        )
        .await
        .map_err(ApiError::internal)?;
    }
    let info = read_info(&mut tx, &device).await?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(info))
}

#[derive(sqlx::FromRow)]
struct DeviceRow {
    id: String,
    kind: String,
    name: String,
    line_id: Option<String>,
    app_version: String,
    paired_at: String,
    last_seen_at: Option<String>,
    revoked_at: Option<String>,
}

/// `GET /v1/office/devices` (administrators): every paired device, revoked
/// ones included, in pairing order.
pub async fn list_devices(
    State(state): State<AppState>,
    context: OfficeContext,
) -> Result<Json<Vec<DeviceRecord>>, ApiError> {
    context.require_admin()?;
    let rows: Vec<DeviceRow> = sqlx::query_as(
        "SELECT id, kind, name, line_id, app_version, paired_at, last_seen_at, revoked_at \
         FROM devices ORDER BY paired_at, id",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    rows.into_iter()
        .map(|row| {
            let kind: DeviceKind = serde_json::from_value(serde_json::Value::String(row.kind))
                .map_err(ApiError::internal)?;
            Ok(DeviceRecord {
                id: row.id,
                kind,
                name: row.name,
                line_id: row.line_id,
                app_version: row.app_version,
                paired_at: row.paired_at,
                last_seen_at: row.last_seen_at,
                revoked_at: row.revoked_at,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()
        .map(Json)
}
