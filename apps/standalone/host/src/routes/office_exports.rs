//! A shift's exports (plan ЧЗ): `GET /v1/office/shifts/{id}/export-source`
//! and `POST …/exports`, every office role. The host only reads and records:
//! the office ports the cloud's source rules and its completeness checks
//! over these rows, renders the files with `@markiro/domain`, saves them and
//! then records the export in the audit trail. One read transaction gives
//! every row one snapshot, as the cloud's export reads in one
//! repeatable-read transaction; each query searches by an index of `0010` or
//! `0012`, never through every fact of the host.

use std::future::Future;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::review::{OfficeShiftExport, OfficeShiftExports, SHIFT_EXPORT_HISTORY_LIMIT};
use markiro_proto::{
    ExportBox, ExportCode, ExportItem, ExportOrganization, ExportPallet, ExportShift,
    ShiftExportRecord, ShiftExportRows, ShiftStatus,
};
use serde_json::json;
use sqlx::{SqliteConnection, SqlitePool};

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::routes::office_boxes::require_shift;
use crate::server::AppState;
use crate::shifts;
use crate::validate;

/// The shift formats `@markiro/domain` advertises (`SHIFT_EXPORT_FORMATS`),
/// with their versions; `proto/fixtures/export-formats.json` holds the same
/// list, and both suites check it against the fixture.
pub const SHIFT_FORMATS: [(&str, u32); 11] = [
    ("shift_txt_flat", 1),
    ("shift_txt_boxes", 2),
    ("shift_txt_boxes_reversed", 1),
    ("shift_csv_flat", 1),
    ("shift_csv_boxes", 2),
    ("shift_xml_gismt_aggregation", 1),
    ("shift_txt_pallets", 1),
    ("shift_csv_pallets", 1),
    ("shift_xml_gismt_aggregation_pallets", 1),
    ("shift_txt_pallet_boxes", 1),
    ("shift_xml_gismt_pallet_boxes", 1),
];

/// The pallet formats (`PALLET_EXPORT_FORMATS`).
pub const PALLET_FORMATS: [(&str, u32); 1] = [("pallet_xml_gismt_aggregation", 1)];

/// The bounds of `maxLines`, as the domain's `INVALID_LINE_LIMIT`.
const MIN_LINES: u32 = 2;
const MAX_LINES: u32 = 1_000_000;

/// The shift, its product's name now and the instant of the station's
/// close the host accepted (one at most: the first close of an active
/// shift is the one accepted, any later one `already_closed`).
pub const SHIFT_SQL: &str = "SELECT s.id, s.number_month_key, s.number_seq, s.created_from, \
     s.status, s.production_date, p.name AS product_name, s.pallets_enabled, s.closed_at, \
     (SELECT e.closed_at FROM shift_close_events e WHERE e.shift_id = s.id \
      AND e.outcome = 'accepted' ORDER BY e.received_at, e.id LIMIT 1) AS station_closed_at, \
     s.late_data_at \
     FROM shifts s JOIN products p ON p.id = s.product_id WHERE s.id = ?";

/// The organization the ЧЗ document names.
pub const ORGANIZATION_SQL: &str = "SELECT name, inn FROM org_profile WHERE id = 1";

/// The codes the shift owns, through its scans (`scans_shift`), each with
/// the canonical text of its owning scan.
pub const CODES_SQL: &str = "SELECT o.code_hash, o.scanned_at, s.canonical FROM scans s \
     JOIN code_owners o ON o.scan_id = s.id WHERE s.shift_id = ? \
     ORDER BY o.scanned_at, o.code_hash";

/// Every box of the shift.
pub const BOXES_SQL: &str = "SELECT id, sscc, opened_at, closed_at, disassembled_at, pallet_id \
     FROM boxes WHERE shift_id = ? ORDER BY opened_at, id";

/// The live items of the shift's boxes, through `box_items_live`: an item
/// taken out or taken by an earlier scan elsewhere is no row here, as the
/// cloud's rules drop it before reading anything else of it.
pub const ITEMS_SQL: &str = "SELECT i.box_id, i.code_hash FROM boxes b \
     JOIN box_items i ON i.box_id = b.id AND i.removed_at IS NULL AND i.displaced_at IS NULL \
     WHERE b.shift_id = ? ORDER BY i.box_id, i.code_hash";

/// Every pallet of the shift.
pub const PALLETS_SQL: &str = "SELECT id, sscc, opened_at, closed_at, disassembled_at \
     FROM pallets WHERE shift_id = ? ORDER BY opened_at, id";

#[derive(sqlx::FromRow)]
struct ShiftRow {
    id: String,
    number_month_key: String,
    number_seq: i64,
    created_from: String,
    status: String,
    production_date: String,
    product_name: String,
    pallets_enabled: bool,
    closed_at: Option<String>,
    station_closed_at: Option<String>,
    late_data_at: Option<String>,
}

/// `GET /v1/office/shifts/{id}/export-source`: an unknown shift is
/// `not_found`; a planned one answers with empty lists.
pub async fn export_source(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<ShiftExportRows>, ApiError> {
    read_rows(&state.pool, &id, |_| async {})
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("no such shift"))
}

/// The shift's saved exports, newest first; ?1 the shift, ?2 the limit. The
/// audit trail keeps each export's record (`record_export`), `audit_log_target`
/// (`0027`) finds them by the shift.
pub const EXPORT_HISTORY_SQL: &str = "SELECT a.id, a.at, u.name AS user_name, a.details \
     FROM audit_log a LEFT JOIN office_users u ON a.actor_kind = 'office_user' AND u.id = a.actor_id \
     WHERE a.target_id = ?1 AND a.action = 'shift.export' AND a.result = 'ok' \
     ORDER BY a.at DESC, a.id DESC LIMIT ?2";

#[derive(sqlx::FromRow)]
struct HistoryRow {
    id: i64,
    at: String,
    user_name: Option<String>,
    details: String,
}

/// `GET /v1/office/shifts/{id}/exports`: the history of the shift's saved
/// exports, every office role; an unknown shift is `not_found`.
pub async fn list_exports(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<OfficeShiftExports>, ApiError> {
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let read = async {
        require_shift(&mut tx, &id).await?;
        let rows = sqlx::query_as::<_, HistoryRow>(EXPORT_HISTORY_SQL)
            .bind(&id)
            .bind(i64::from(SHIFT_EXPORT_HISTORY_LIMIT))
            .fetch_all(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        // The files each export stored on the host (migration `0029`), by the
        // export's `documentId`; an export from before they were stored has none.
        let batches = rows
            .iter()
            .filter_map(|row| {
                serde_json::from_str::<ShiftExportRecord>(&row.details)
                    .ok()
                    .map(|record| record.document_id)
            })
            .collect::<Vec<_>>();
        let files =
            crate::routes::office_export_files::files_of_batches(&mut tx, &id, &batches).await?;
        Ok::<_, ApiError>((rows, files))
    }
    .await;
    tx.rollback().await.map_err(ApiError::internal)?;
    let (rows, files) = read?;
    let items = rows
        .into_iter()
        .map(|row| {
            let record: ShiftExportRecord =
                serde_json::from_str(&row.details).map_err(ApiError::internal)?;
            Ok(OfficeShiftExport {
                files: files.get(&record.document_id).cloned().unwrap_or_default(),
                id: row.id,
                recorded_at: row.at,
                user_name: row.user_name,
                format_id: record.format_id,
                format_version: record.format_version,
                max_lines: record.max_lines,
                pallet_id: record.pallet_id,
                document_id: record.document_id,
                part_count: record.part_count,
                code_count: record.code_count,
                box_count: record.box_count,
                pallet_count: record.pallet_count,
                open_pallet_suppressed_box_count: record.open_pallet_suppressed_box_count,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Json(OfficeShiftExports { items }))
}

/// The six reads of a shift's export source in one plain deferred
/// transaction: nothing here writes, so it is rolled back, and the reads
/// share one WAL snapshot. `after_query` is called with the name of each
/// query just read (`shift`, `organization`, `codes`, `boxes`, `items`,
/// `pallets`); the route passes a closure that does nothing, a test writes
/// from another connection there to prove that no write lands in the answer.
pub async fn read_rows<F, Fut>(
    pool: &SqlitePool,
    id: &str,
    after_query: F,
) -> Result<Option<ShiftExportRows>, ApiError>
where
    F: FnMut(&'static str) -> Fut,
    Fut: Future<Output = ()>,
{
    let mut tx = pool.begin().await.map_err(ApiError::internal)?;
    let rows = read(&mut tx, id, after_query).await;
    tx.rollback().await.map_err(ApiError::internal)?;
    rows
}

async fn read<F, Fut>(
    conn: &mut SqliteConnection,
    id: &str,
    mut after_query: F,
) -> Result<Option<ShiftExportRows>, ApiError>
where
    F: FnMut(&'static str) -> Fut,
    Fut: Future<Output = ()>,
{
    let shift: Option<ShiftRow> = sqlx::query_as(SHIFT_SQL)
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    after_query("shift").await;
    let Some(shift) = shift else {
        return Ok(None);
    };
    let (name, inn): (String, Option<String>) = sqlx::query_as(ORGANIZATION_SQL)
        .fetch_one(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    after_query("organization").await;
    let codes: Vec<(String, String, String)> = sqlx::query_as(CODES_SQL)
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    after_query("codes").await;
    type BoxRow = (
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let boxes: Vec<BoxRow> = sqlx::query_as(BOXES_SQL)
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    after_query("boxes").await;
    let items: Vec<(String, String)> = sqlx::query_as(ITEMS_SQL)
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    after_query("items").await;
    type PalletRow = (
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
    );
    let pallets: Vec<PalletRow> = sqlx::query_as(PALLETS_SQL)
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    after_query("pallets").await;
    let created_from = shift.created_from.parse().map_err(ApiError::internal)?;
    Ok(Some(ShiftExportRows {
        shift: ExportShift {
            number: shifts::format_number(&shift.number_month_key, shift.number_seq, created_from),
            id: shift.id,
            status: shift.status.parse().map_err(ApiError::internal)?,
            production_date: shift.production_date,
            product_name: shift.product_name,
            pallets_enabled: shift.pallets_enabled,
            closed_at: shift.closed_at,
            station_closed_at: shift.station_closed_at,
            late_data_at: shift.late_data_at,
        },
        organization: ExportOrganization { name, inn },
        codes: codes
            .into_iter()
            .map(|(code_hash, scanned_at, canonical)| ExportCode {
                code_hash,
                scanned_at,
                canonical,
            })
            .collect(),
        boxes: boxes
            .into_iter()
            .map(
                |(id, sscc, opened_at, closed_at, disassembled_at, pallet_id)| ExportBox {
                    id,
                    sscc,
                    opened_at,
                    closed_at,
                    disassembled_at,
                    pallet_id,
                },
            )
            .collect(),
        items: items
            .into_iter()
            .map(|(box_id, code_hash)| ExportItem { box_id, code_hash })
            .collect(),
        pallets: pallets
            .into_iter()
            .map(
                |(id, sscc, opened_at, closed_at, disassembled_at)| ExportPallet {
                    id,
                    sscc,
                    opened_at,
                    closed_at,
                    disassembled_at,
                },
            )
            .collect(),
    }))
}

/// `POST /v1/office/shifts/{id}/exports`: one `shift.export` row with what
/// the export wrote, `204`. A shift's export needs a closed shift (`conflict`
/// on `shift_status`, as the cloud refuses one); a pallet's needs a pallet of
/// this shift, and its state is not checked again: the files are written
/// already, and the row records that they were.
pub async fn record_export(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(record): ApiJson<ShiftExportRecord>,
) -> Result<StatusCode, ApiError> {
    let format = (record.format_id.as_str(), record.format_version);
    let of_pallet = PALLET_FORMATS.contains(&format);
    if !of_pallet && !SHIFT_FORMATS.contains(&format) {
        return Err(ApiError::validation(
            "formatId",
            "not a format the office exports",
        ));
    }
    match (&record.pallet_id, of_pallet) {
        (Some(pallet), true) => validate::client_uuid("palletId", pallet)?,
        (None, false) => {}
        _ => {
            return Err(ApiError::validation(
                "palletId",
                "a pallet's export names its pallet, a shift's none",
            ))
        }
    }
    if let Some(lines) = record.max_lines {
        if of_pallet || !(MIN_LINES..=MAX_LINES).contains(&lines) {
            return Err(ApiError::validation(
                "maxLines",
                "2-1 000 000 lines a part, none for a pallet",
            ));
        }
    }
    validate::client_uuid("documentId", &record.document_id)?;
    if record.part_count == 0 || (of_pallet && record.part_count != 1) {
        return Err(ApiError::validation(
            "partCount",
            "at least one part, exactly one for a pallet",
        ));
    }
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_session_in(&mut tx).await?;
    let status: Option<String> = sqlx::query_scalar("SELECT status FROM shifts WHERE id = ?")
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let status: ShiftStatus = status
        .ok_or_else(|| ApiError::not_found("no such shift"))?
        .parse()
        .map_err(ApiError::internal)?;
    if !of_pallet && status != ShiftStatus::Closed {
        return Err(shifts::status_conflict(status));
    }
    if let Some(pallet) = &record.pallet_id {
        let found: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM pallets WHERE id = ? AND shift_id = ?")
                .bind(pallet)
                .bind(&id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(ApiError::internal)?;
        if found.is_none() {
            return Err(ApiError::validation(
                "palletId",
                "no such pallet in the shift",
            ));
        }
    }
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::SHIFT_EXPORT,
            target_type: Some("shift"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({
                "formatId": record.format_id,
                "formatVersion": record.format_version,
                "maxLines": record.max_lines,
                "palletId": record.pallet_id,
                "documentId": record.document_id,
                "partCount": record.part_count,
                "codeCount": record.code_count,
                "boxCount": record.box_count,
                "palletCount": record.pallet_count,
                "openPalletSuppressedBoxCount": record.open_pallet_suppressed_box_count,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}
