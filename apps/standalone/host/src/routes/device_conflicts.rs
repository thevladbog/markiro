//! What a device learns of its own conflicts (plan КНФ, the cloud's
//! `POST /station/conflicts/status`): `POST /v1/device/conflicts/status` — of
//! the records it names (1–200), those whose scan lost a conflict the office
//! has reviewed, with when; `GET /v1/device/displacements` — the scans of this
//! device an earlier scan elsewhere took the code from, oldest detection first
//! after the cursor it holds (`afterAt` and `afterId` together), a page of
//! `DISPLACEMENT_PAGE_SIZE`. Reads only, through `AskingDevice`: neither waits
//! for a writer. A device hears of its own scans only, whatever it names.

use axum::extract::State;
use axum::Json;
use markiro_proto::review::{
    ConflictStatusRequest, ConflictStatusResponse, DeviceDisplacement, DeviceDisplacements,
    ReviewedRecord, DISPLACEMENT_PAGE_SIZE, MAX_CONFLICT_STATUS_RECORDS,
};
use markiro_proto::{CodeOwner, ShiftOrigin};
use serde::Deserialize;

use crate::auth::AskingDevice;
use crate::error::{ApiError, ApiJson, ApiQuery};
use crate::server::AppState;
use crate::shifts;
use crate::validate;

pub const STATUS_SQL: &str = "SELECT l.record_id, c.reviewed_at FROM scans l \
     JOIN code_conflicts c ON c.loser_scan_id = l.id \
     WHERE l.device_id = ?1 AND l.record_id IN (SELECT value FROM json_each(?2)) \
     AND c.reviewed_at IS NOT NULL ORDER BY l.record_id";

pub const DISPLACEMENTS_SQL: &str = "SELECT c.id, l.record_id, l.shift_id, c.code_hash, l.box_id, \
     c.detected_at, c.reviewed_at, w.shift_id AS w_shift_id, ws.number_month_key, \
     ws.number_seq, ws.created_from, w.device_id AS w_device_id, w.scanned_at AS w_scanned_at \
     FROM code_conflicts c JOIN scans l ON l.id = c.loser_scan_id \
     JOIN scans w ON w.id = c.winner_scan_id JOIN shifts ws ON ws.id = w.shift_id \
     WHERE c.kind = 'displaced' AND l.device_id = ?1 \
     AND (c.detected_at > ?2 OR (c.detected_at = ?2 AND c.id > ?3)) \
     ORDER BY c.detected_at, c.id LIMIT ?4";

pub async fn conflict_status(
    State(state): State<AppState>,
    AskingDevice(device): AskingDevice,
    ApiJson(request): ApiJson<ConflictStatusRequest>,
) -> Result<Json<ConflictStatusResponse>, ApiError> {
    if !(1..=MAX_CONFLICT_STATUS_RECORDS).contains(&request.record_ids.len()) {
        return Err(ApiError::validation("recordIds", "1-200 record ids"));
    }
    for id in &request.record_ids {
        validate::client_uuid("recordIds", id)?;
    }
    let ids = serde_json::to_string(&request.record_ids).map_err(ApiError::internal)?;
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    let rows: Vec<(String, String)> = sqlx::query_as(STATUS_SQL)
        .bind(&device.id)
        .bind(ids)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(ConflictStatusResponse {
        reviewed: rows
            .into_iter()
            .map(|(record_id, reviewed_at)| ReviewedRecord {
                record_id,
                reviewed_at,
            })
            .collect(),
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisplacementQuery {
    after_at: Option<String>,
    after_id: Option<String>,
}

#[derive(sqlx::FromRow)]
struct DisplacementRow {
    id: String,
    record_id: String,
    shift_id: String,
    code_hash: String,
    box_id: Option<String>,
    detected_at: String,
    reviewed_at: Option<String>,
    w_shift_id: String,
    number_month_key: String,
    number_seq: i64,
    created_from: String,
    w_device_id: String,
    w_scanned_at: String,
}

pub async fn list_displacements(
    State(state): State<AppState>,
    AskingDevice(device): AskingDevice,
    ApiQuery(query): ApiQuery<DisplacementQuery>,
) -> Result<Json<DeviceDisplacements>, ApiError> {
    let (after_at, after_id) = match (query.after_at, query.after_id) {
        (None, None) => (String::new(), String::new()),
        (Some(at), Some(id)) => {
            crate::clock::parse_timestamp(&at)
                .map_err(|_| ApiError::validation("afterAt", "a host timestamp"))?;
            validate::client_uuid("afterId", &id)?;
            (at, id)
        }
        _ => {
            return Err(ApiError::validation(
                "afterId",
                "afterAt and afterId together",
            ))
        }
    };
    let limit = i64::from(DISPLACEMENT_PAGE_SIZE);
    let mut conn = state.pool.acquire().await.map_err(ApiError::internal)?;
    let mut rows: Vec<DisplacementRow> = sqlx::query_as(DISPLACEMENTS_SQL)
        .bind(&device.id)
        .bind(&after_at)
        .bind(&after_id)
        .bind(limit + 1)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let page = usize::try_from(DISPLACEMENT_PAGE_SIZE).map_err(ApiError::internal)?;
    let more = rows.len() > page;
    rows.truncate(page);
    let items = rows
        .into_iter()
        .map(|row| {
            let origin: ShiftOrigin = row.created_from.parse().map_err(ApiError::internal)?;
            Ok(DeviceDisplacement {
                winner: CodeOwner {
                    shift_number: shifts::format_number(
                        &row.number_month_key,
                        row.number_seq,
                        origin,
                    ),
                    shift_id: row.w_shift_id,
                    same_device: row.w_device_id == device.id,
                    device_id: row.w_device_id,
                    scanned_at: row.w_scanned_at,
                },
                conflict_id: row.id,
                record_id: row.record_id,
                shift_id: row.shift_id,
                code_hash: row.code_hash,
                box_id: row.box_id,
                detected_at: row.detected_at,
                reviewed_at: row.reviewed_at,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Json(DeviceDisplacements { items, more }))
}
