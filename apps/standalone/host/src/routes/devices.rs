//! A device's own record (`GET /v1/device`), a station's choice of line
//! (`PUT /v1/device/line`) and the administrator's devices:
//! `GET /v1/office/devices`, `PUT /v1/office/devices/{id}` (name and line)
//! and `POST /v1/office/devices/{id}/revoke`. Devices are not in the change
//! feed and have no `rev`: office writes are last-write-wins. A change of a
//! device's line still takes one host revision, without a feed item, so open
//! streams wake and the station can read `GET /v1/device` again; a rename and
//! a revocation take none.

use axum::extract::State;
use axum::Json;
use markiro_proto::{DeviceInfo, DeviceKind, DeviceLineRequest, DeviceRecord, DeviceUpdate};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::auth::{AuthDevice, OfficeContext};
use crate::db::{begin_write, commit_and_notify, commit_with_revision, next_revision};
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
        // `GET /v1/device` adds the license (plan ЛЦ-2); the line's answer has none.
        license: None,
    })
}

pub async fn device_info(
    State(state): State<AppState>,
    device: AuthDevice,
) -> Result<Json<DeviceInfo>, ApiError> {
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let mut info = read_info(&mut tx, &device).await?;
    // The site's license as the host computes it (plan ЛЦ-2). It only
    // informs, so a license the host cannot read costs the device nothing:
    // the record goes without the line, and the reason is logged.
    match state.license.snapshot(&state, &mut tx).await {
        Ok(snapshot) => info.license = Some(crate::license::routes::device_license(&snapshot)),
        Err(error) => tracing::warn!(%error, "the license was not read for a device"),
    }
    // A read: the record is whole, and a rollback that fails (the reader's
    // connection lost after a failed read) is the pool's, not the device's.
    if let Err(error) = tx.rollback().await {
        tracing::warn!(%error, "a device's read did not roll back");
    }
    Ok(Json(info))
}

/// `line_id` names an existing, active line: `validation_failed` on
/// `lineId` otherwise.
pub async fn require_active_line(
    conn: &mut SqliteConnection,
    line_id: &str,
) -> Result<(), ApiError> {
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
/// Devices are not in the change feed, and the station already knows what it
/// chose, so the host revision stays (an office assignment takes one:
/// `update_device`).
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
/// it, and re-sending the line the station is already on keeps it. A line
/// change takes one host revision (no feed item), so open streams wake and
/// the station can read its device again; a rename takes none.
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
        // The line the station is already on is «keep», even if it has been
        // archived since (archiving leaves stations on their line): a
        // full-form save `{ name, lineId }` must still be able to rename it.
        Some(Some(line_id)) if current.line_id.as_deref() == Some(line_id.as_str()) => {
            current.line_id.clone()
        }
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
    // Only a line change is news for a station: it takes the one revision
    // that wakes the streams. Devices are not in the feed, so the revision
    // carries no item; the station reads `GET /v1/device` after it.
    let rev = if line_id == current.line_id {
        None
    } else {
        Some(next_revision(&mut tx).await.map_err(ApiError::internal)?)
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
    match rev {
        Some(rev) => commit_with_revision(tx, &state.revisions, rev).await,
        None => tx.commit().await,
    }
    .map_err(ApiError::internal)?;
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
        // Already revoked: no row write, no audit row. The streams are woken
        // once more, though: a woken stream only re-reads its own device, so
        // this costs one read each, and it recovers a wake-up an earlier
        // attempt lost, for the administrator who retries.
        state
            .revocations
            .send_modify(|count| *count = count.wrapping_add(1));
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
    // The commit and the wake-up are one task the caller going away cannot
    // split, and the wake-up comes after the commit, like a revision: a
    // stream that checks its device at once already reads the revocation.
    let revocations = state.revocations.clone();
    commit_and_notify(tx, move || {
        revocations.send_modify(|count| *count = count.wrapping_add(1));
    })
    .await
    .map_err(ApiError::internal)?;
    Ok(Json(revoked))
}
