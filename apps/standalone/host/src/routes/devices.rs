//! A device's own record (`GET /v1/device`), a station's choice of line
//! (`PUT /v1/device/line`) and the administrator's devices:
//! `GET /v1/office/devices`, `PUT /v1/office/devices/{id}` (name and line)
//! and `POST /v1/office/devices/{id}/revoke`. Devices are not in the change
//! feed and have no `rev`: office writes are last-write-wins and leave the
//! host revision alone.

use axum::extract::State;
use axum::Json;
use markiro_proto::{DeviceInfo, DeviceKind, DeviceLineRequest, DeviceRecord, DeviceUpdate};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::auth::{AuthDevice, OfficeContext};
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::server::AppState;
use crate::validate;

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

/// `line_id` names an existing, active line.
async fn require_active_line(conn: &mut SqliteConnection, line_id: &str) -> Result<(), ApiError> {
    let archived: Option<i64> = sqlx::query_scalar("SELECT archived FROM lines WHERE id = ?")
        .bind(line_id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    if archived == Some(0) {
        Ok(())
    } else {
        Err(ApiError::validation("lineId", "no such active line"))
    }
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
    require_active_line(&mut tx, &request.line_id).await?;
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

const DEVICES: &str = "SELECT id, kind, name, line_id, app_version, paired_at, last_seen_at, \
     revoked_at FROM devices";

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

fn record(row: DeviceRow) -> Result<DeviceRecord, ApiError> {
    let kind: DeviceKind = row.kind.parse().map_err(ApiError::internal)?;
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
}

async fn read_record(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<DeviceRecord>, ApiError> {
    let row: Option<DeviceRow> = sqlx::query_as(&format!("{DEVICES} WHERE id = ?"))
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    row.map(record).transpose()
}

/// `GET /v1/office/devices` (administrators): every paired device, revoked
/// ones included, in pairing order.
pub async fn list_devices(
    State(state): State<AppState>,
    context: OfficeContext,
) -> Result<Json<Vec<DeviceRecord>>, ApiError> {
    context.require_admin()?;
    let rows: Vec<DeviceRow> = sqlx::query_as(&format!("{DEVICES} ORDER BY paired_at, id"))
        .fetch_all(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    rows.into_iter()
        .map(record)
        .collect::<Result<Vec<_>, _>>()
        .map(Json)
}

/// `PUT /v1/office/devices/{id}` (administrators): rename a device or set
/// its line — only a station's, only an active line; `lineId: null` clears
/// it.
pub async fn update_device(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(update): ApiJson<DeviceUpdate>,
) -> Result<Json<DeviceRecord>, ApiError> {
    context.require_admin()?;
    let name = update
        .name
        .as_deref()
        .map(|name| validate::device_name("name", name))
        .transpose()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let current = read_record(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such device"))?;
    let line_id = match &update.line_id {
        None => current.line_id.clone(),
        Some(None) => None,
        Some(Some(line_id)) => {
            if current.kind != DeviceKind::Station {
                return Err(ApiError::validation(
                    "lineId",
                    "only a station works on a line",
                ));
            }
            require_active_line(&mut tx, line_id).await?;
            Some(line_id.clone())
        }
    };
    let name = name.map_or_else(|| current.name.clone(), str::to_owned);
    let Some(details) = audit::update_details(&[
        ("name", json!(current.name), json!(name)),
        ("lineId", json!(current.line_id), json!(line_id)),
    ]) else {
        // Nothing actually changed: report the device as-is without writing a
        // row nobody changed or auditing a no-op.
        return Ok(Json(current));
    };
    sqlx::query("UPDATE devices SET name = ?, line_id = ? WHERE id = ?")
        .bind(&name)
        .bind(&line_id)
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::DEVICE_UPDATE,
            target_type: Some("device"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let updated = read_record(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("device vanished"))?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(updated))
}

/// `POST /v1/office/devices/{id}/revoke` (administrators): the device's key
/// stops working at once, its office sessions end and, after the commit, its
/// open change streams close (`AppState::revocations`). The device stays
/// listed with `revokedAt`; revoking it again changes nothing.
pub async fn revoke_device(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<DeviceRecord>, ApiError> {
    context.require_admin()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let current = read_record(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such device"))?;
    if current.revoked_at.is_some() {
        // Already revoked: no row write, no audit row.
        return Ok(Json(current));
    }
    sqlx::query("UPDATE devices SET revoked_at = ? WHERE id = ?")
        .bind(&at)
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    sqlx::query("DELETE FROM office_sessions WHERE device_id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::DEVICE_REVOKE,
            target_type: Some("device"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({ "kind": current.kind.as_str(), "name": current.name }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let revoked = read_record(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("device vanished"))?;
    tx.commit().await.map_err(ApiError::internal)?;
    // After the commit, like a revision: a stream that checks its device at
    // once already reads the revocation.
    state
        .revocations
        .send_modify(|count| *count = count.wrapping_add(1));
    Ok(Json(revoked))
}
