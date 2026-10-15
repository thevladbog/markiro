//! A shift's scan history for the office: `GET /v1/office/shifts/{id}/scans`,
//! every office role, read-only. The scans of the work screen as the journal
//! (`scans`) keeps them, newest first, a page at a time by a cursor — the
//! last row's instant and id — so a page costs the same however long the
//! shift was. Narrowed by the verdict (`result`), the station (`device`), the
//! box (`box`), a range of the device's instants in milliseconds since 1970
//! (`fromMs` inclusive, `toMs` exclusive) and the last characters of the
//! serial (`q`). The code never travels whole: its GTIN and the last four
//! characters of its serial. Every parameter and the cursor are plain URL
//! characters, because the shell lets only those through to the host.

use axum::extract::State;
use axum::Json;
use markiro_proto::review::{
    OfficeScanHistoryItem, OfficeScanHistoryPage, ScanHistoryVerdict, SCAN_HISTORY_MAX_PAGE_SIZE,
    SCAN_HISTORY_PAGE_SIZE,
};
use serde::Deserialize;

use crate::auth::OfficeContext;
use crate::error::{ApiError, ApiPath, ApiQuery};
use crate::facts::rules::device_instant;
use crate::routes::office_boxes::require_shift;
use crate::routes::office_codes::period_end;
use crate::server::AppState;
use crate::validate;

/// Bound: ?1 the shift, ?2 the verdict, ?3 the device, ?4 the box, ?5 from,
/// ?6 to, ?7 the serial's tail, ?8 and ?9 the cursor's instant and id, ?10 the
/// page's size plus one (the extra row only says another page follows).
pub const SCANS_SQL: &str = "SELECT s.id, s.scanned_at, s.received_at, s.device_id, \
     d.name AS device_name, o.name AS operator_name, s.verdict, s.duplicate_source, s.gtin14, \
     substr(s.serial, -4) AS serial_tail, s.box_id, b.sscc AS box_sscc, b.pallet_id, \
     p.sscc AS pallet_sscc \
     FROM scans s JOIN devices d ON d.id = s.device_id \
     LEFT JOIN operators o ON o.id = s.operator_id \
     LEFT JOIN boxes b ON b.id = s.box_id LEFT JOIN pallets p ON p.id = b.pallet_id \
     WHERE s.shift_id = ?1 AND (?2 IS NULL OR s.verdict = ?2) \
     AND (?3 IS NULL OR s.device_id = ?3) AND (?4 IS NULL OR s.box_id = ?4) \
     AND (?5 IS NULL OR s.scanned_at >= ?5) AND (?6 IS NULL OR s.scanned_at < ?6) \
     AND (?7 IS NULL OR substr(s.serial, -length(?7)) = ?7) \
     AND (?8 IS NULL OR (s.scanned_at, s.id) < (?8, ?9)) \
     ORDER BY s.scanned_at DESC, s.id DESC LIMIT ?10";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ScanHistoryQuery {
    result: Option<String>,
    device: Option<String>,
    r#box: Option<String>,
    from_ms: Option<String>,
    to_ms: Option<String>,
    q: Option<String>,
    cursor: Option<String>,
    limit: Option<String>,
}

#[derive(sqlx::FromRow)]
struct ScanRow {
    id: String,
    scanned_at: String,
    received_at: String,
    device_id: String,
    device_name: String,
    operator_name: Option<String>,
    verdict: String,
    duplicate_source: Option<String>,
    gtin14: Option<String>,
    serial_tail: Option<String>,
    box_id: Option<String>,
    box_sscc: Option<String>,
    pallet_id: Option<String>,
    pallet_sscc: Option<String>,
}

/// `<ms>~<id>`: the instant of the last scan of a page in milliseconds, and its id.
fn decode_cursor(text: &Option<String>) -> Result<(Option<String>, Option<String>), ApiError> {
    let Some(text) = text else {
        return Ok((None, None));
    };
    let refused = || ApiError::validation("cursor", "a cursor this list gave");
    let (millis, id) = text.split_once('~').ok_or_else(refused)?;
    validate::client_uuid("cursor", id).map_err(|_| refused())?;
    let at = period_end("cursor", millis).map_err(|_| refused())?;
    Ok((Some(at), Some(id.to_owned())))
}

fn encode_cursor(scanned_at: &str, id: &str) -> Result<String, ApiError> {
    let at = device_instant(scanned_at)
        .ok_or_else(|| ApiError::internal("a scan's instant is no device instant"))?;
    Ok(format!("{}~{id}", at.unix_timestamp_nanos() / 1_000_000))
}

pub async fn list_scans(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiQuery(query): ApiQuery<ScanHistoryQuery>,
) -> Result<Json<OfficeScanHistoryPage>, ApiError> {
    let verdict = match &query.result {
        None => None,
        Some(text) => Some(
            text.parse::<ScanHistoryVerdict>()
                .map_err(|_| ApiError::validation("result", "ok, duplicate, wrong_gtin, invalid"))?
                .as_str(),
        ),
    };
    if let Some(device) = &query.device {
        validate::client_uuid("device", device)?;
    }
    if let Some(found) = &query.r#box {
        validate::client_uuid("box", found)?;
    }
    let from = query
        .from_ms
        .as_deref()
        .map(|value| period_end("fromMs", value))
        .transpose()?;
    let to = query
        .to_ms
        .as_deref()
        .map(|value| period_end("toMs", value))
        .transpose()?;
    if let (Some(from), Some(to)) = (&from, &to) {
        if from >= to {
            return Err(ApiError::validation(
                "toMs",
                "the period ends before it starts",
            ));
        }
    }
    let tail = match &query.q {
        None => None,
        Some(text) => {
            let count = text.chars().count();
            if !(1..=32).contains(&count) {
                return Err(ApiError::validation("q", "1-32 characters"));
            }
            Some(text.clone())
        }
    };
    let (cursor_at, cursor_id) = decode_cursor(&query.cursor)?;
    let size = match &query.limit {
        None => SCAN_HISTORY_PAGE_SIZE,
        Some(text) => text
            .parse::<u32>()
            .ok()
            .filter(|_| text.bytes().all(|byte| byte.is_ascii_digit()))
            .filter(|size| (1..=SCAN_HISTORY_MAX_PAGE_SIZE).contains(size))
            .ok_or_else(|| {
                ApiError::validation("limit", format!("1-{SCAN_HISTORY_MAX_PAGE_SIZE}"))
            })?,
    };
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let read = async {
        require_shift(&mut tx, &id).await?;
        sqlx::query_as::<_, ScanRow>(SCANS_SQL)
            .bind(&id)
            .bind(verdict)
            .bind(&query.device)
            .bind(&query.r#box)
            .bind(&from)
            .bind(&to)
            .bind(&tail)
            .bind(&cursor_at)
            .bind(&cursor_id)
            .bind(i64::from(size) + 1)
            .fetch_all(&mut *tx)
            .await
            .map_err(ApiError::internal)
    }
    .await;
    tx.rollback().await.map_err(ApiError::internal)?;
    let mut rows = read?;
    let more = rows.len() > size as usize;
    rows.truncate(size as usize);
    let next_cursor = match rows.last() {
        Some(row) if more => Some(encode_cursor(&row.scanned_at, &row.id)?),
        _ => None,
    };
    let items = rows
        .into_iter()
        .map(|row| {
            Ok(OfficeScanHistoryItem {
                verdict: row
                    .verdict
                    .parse::<ScanHistoryVerdict>()
                    .map_err(ApiError::internal)?,
                id: row.id,
                scanned_at: row.scanned_at,
                received_at: row.received_at,
                device_id: row.device_id,
                device_name: row.device_name,
                operator_name: row.operator_name,
                duplicate_source: row.duplicate_source,
                gtin14: row.gtin14,
                serial_tail: row.serial_tail,
                box_id: row.box_id,
                box_sscc: row.box_sscc,
                pallet_id: row.pallet_id,
                pallet_sscc: row.pallet_sscc,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Json(OfficeScanHistoryPage { items, next_cursor }))
}
