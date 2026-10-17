//! Code conflicts in the office (plan КНФ, the cloud's `/conflicts`):
//! `GET /v1/office/conflicts` lists them newest detection first, a page at a
//! time, narrowed by the LOSING shift (`?shift=`, the side whose box differs
//! from what was packed — the cloud's filter too) and by review
//! (`?reviewed=true|false`); every office role reads it. `POST
//! /v1/office/conflicts/{id}/review` marks one reviewed (administrators and
//! technologists): once, with its reviewer, an audit row and a host revision
//! so the stations' streams wake and ask after their conflicts (plan КНФ,
//! task 7); a conflict reviewed already answers as it is and writes nothing.
//! The code goes by its hash, GTIN and serial: its canonical text, with the
//! crypto tail, never leaves this module.

use axum::extract::State;
use axum::Json;
use markiro_proto::review::{
    ConflictKind, OfficeConflict, OfficeConflictPage, OfficeConflictScan, CONFLICT_MAX_PAGE,
    CONFLICT_PAGE_SIZE,
};
use markiro_proto::ShiftOrigin;
use serde::Deserialize;
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiPath, ApiQuery};
use crate::server::AppState;
use crate::shifts;
use crate::validate;

/// Both sides of a conflict: the loser's (`l`) and the winner's (`w`) scan,
/// shift, device, operator and box, and who reviewed it. Bound: ?1 the losing
/// shift or NULL, ?2 reviewed (0/1) or NULL.
pub const FROM: &str = "FROM code_conflicts c \
     JOIN scans l ON l.id = c.loser_scan_id JOIN shifts ls ON ls.id = l.shift_id \
     JOIN devices ld ON ld.id = l.device_id LEFT JOIN operators lo ON lo.id = l.operator_id \
     LEFT JOIN boxes lb ON lb.id = l.box_id \
     JOIN scans w ON w.id = c.winner_scan_id JOIN shifts ws ON ws.id = w.shift_id \
     JOIN devices wd ON wd.id = w.device_id LEFT JOIN operators wo ON wo.id = w.operator_id \
     LEFT JOIN boxes wb ON wb.id = w.box_id \
     LEFT JOIN office_users ru ON ru.id = c.reviewed_by";

const COLUMNS: &str = "SELECT c.id, c.kind, c.code_hash, l.gtin14, l.serial, c.detected_at, \
     c.reviewed_at, ru.name AS reviewed_by_name, \
     l.shift_id AS l_shift_id, ls.number_month_key AS l_month_key, ls.number_seq AS l_seq, \
     ls.created_from AS l_origin, l.device_id AS l_device_id, ld.name AS l_device_name, \
     lo.name AS l_operator_name, l.scanned_at AS l_scanned_at, l.box_id AS l_box_id, \
     lb.sscc AS l_box_sscc, ls.status = 'closed' AS l_shift_closed, \
     lb.disassembled_at IS NOT NULL AS l_box_disassembled, \
     w.shift_id AS w_shift_id, ws.number_month_key AS w_month_key, ws.number_seq AS w_seq, \
     ws.created_from AS w_origin, w.device_id AS w_device_id, wd.name AS w_device_name, \
     wo.name AS w_operator_name, w.scanned_at AS w_scanned_at, w.box_id AS w_box_id, \
     wb.sscc AS w_box_sscc, ws.status = 'closed' AS w_shift_closed, \
     wb.disassembled_at IS NOT NULL AS w_box_disassembled, NULL AS w_number ";

const CLOUD: &str = "SELECT c.id, 'late' AS kind, c.code_hash, l.gtin14, l.serial, c.detected_at,
 c.reviewed_at, ru.name AS reviewed_by_name,
 l.shift_id AS l_shift_id,ls.number_month_key AS l_month_key,ls.number_seq AS l_seq,ls.created_from AS l_origin,
 l.device_id AS l_device_id,ld.name AS l_device_name,lo.name AS l_operator_name,l.scanned_at AS l_scanned_at,
 l.box_id AS l_box_id,lb.sscc AS l_box_sscc,ls.status='closed' AS l_shift_closed,lb.disassembled_at IS NOT NULL AS l_box_disassembled,
 c.winner_shift_id AS w_shift_id,'' AS w_month_key,0 AS w_seq,'' AS w_origin,
 '00000000-0000-0000-0000-000000000000' AS w_device_id,'Облачная история' AS w_device_name,NULL AS w_operator_name,
 c.winner_scanned_at AS w_scanned_at,c.winner_box_id AS w_box_id,wb.sscc AS w_box_sscc,1 AS w_shift_closed,
 wb.disassembled_at IS NOT NULL AS w_box_disassembled,c.winner_number AS w_number
 FROM cloud_history_conflicts c JOIN scans l ON l.id=c.loser_scan_id JOIN shifts ls ON ls.id=l.shift_id
 JOIN devices ld ON ld.id=l.device_id LEFT JOIN operators lo ON lo.id=l.operator_id LEFT JOIN boxes lb ON lb.id=l.box_id
 LEFT JOIN cloud_history_boxes wb ON wb.id=c.winner_box_id LEFT JOIN office_users ru ON ru.id=c.reviewed_by";

fn union_query() -> String {
    format!("{COLUMNS}{FROM} UNION ALL {CLOUD}")
}

pub const COUNT: &str = "SELECT COUNT(*) FROM code_conflicts c \
     JOIN scans l ON l.id = c.loser_scan_id \
     WHERE (?1 IS NULL OR l.shift_id = ?1) AND (?2 IS NULL OR (c.reviewed_at IS NOT NULL) = ?2)";

#[derive(sqlx::FromRow)]
struct ConflictRow {
    id: String,
    kind: String,
    code_hash: String,
    gtin14: String,
    serial: String,
    detected_at: String,
    reviewed_at: Option<String>,
    reviewed_by_name: Option<String>,
    l_shift_id: String,
    l_month_key: String,
    l_seq: i64,
    l_origin: String,
    l_device_id: String,
    l_device_name: String,
    l_operator_name: Option<String>,
    l_scanned_at: String,
    l_box_id: Option<String>,
    l_box_sscc: Option<String>,
    l_shift_closed: bool,
    l_box_disassembled: bool,
    w_number: Option<String>,
    w_shift_id: String,
    w_month_key: String,
    w_seq: i64,
    w_origin: String,
    w_device_id: String,
    w_device_name: String,
    w_operator_name: Option<String>,
    w_scanned_at: String,
    w_box_id: Option<String>,
    w_box_sscc: Option<String>,
    w_shift_closed: bool,
    w_box_disassembled: bool,
}

fn number(month_key: &str, seq: i64, origin: &str) -> Result<String, ApiError> {
    let origin: ShiftOrigin = origin.parse().map_err(ApiError::internal)?;
    Ok(shifts::format_number(month_key, seq, origin))
}

fn conflict(row: ConflictRow) -> Result<OfficeConflict, ApiError> {
    Ok(OfficeConflict {
        kind: row
            .kind
            .parse::<ConflictKind>()
            .map_err(ApiError::internal)?,
        loser: OfficeConflictScan {
            shift_number: number(&row.l_month_key, row.l_seq, &row.l_origin)?,
            shift_id: row.l_shift_id,
            device_id: row.l_device_id,
            device_name: row.l_device_name,
            operator_name: row.l_operator_name,
            scanned_at: row.l_scanned_at,
            box_id: row.l_box_id,
            box_sscc: row.l_box_sscc,
            shift_closed: row.l_shift_closed,
            box_disassembled: row.l_box_disassembled,
        },
        winner: OfficeConflictScan {
            shift_number: match row.w_number {
                Some(number) => number,
                None => number(&row.w_month_key, row.w_seq, &row.w_origin)?,
            },
            shift_id: row.w_shift_id,
            device_id: row.w_device_id,
            device_name: row.w_device_name,
            operator_name: row.w_operator_name,
            scanned_at: row.w_scanned_at,
            box_id: row.w_box_id,
            box_sscc: row.w_box_sscc,
            shift_closed: row.w_shift_closed,
            box_disassembled: row.w_box_disassembled,
        },
        id: row.id,
        code_hash: row.code_hash,
        gtin14: row.gtin14,
        serial: row.serial,
        detected_at: row.detected_at,
        reviewed_at: row.reviewed_at,
        reviewed_by_name: row.reviewed_by_name,
    })
}

/// One conflict by id, both sides read now.
pub(crate) async fn read_conflict(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<OfficeConflict>, ApiError> {
    let row: Option<ConflictRow> =
        sqlx::query_as(&format!("SELECT * FROM ({}) WHERE id = ?", union_query()))
            .bind(id)
            .fetch_optional(conn)
            .await
            .map_err(ApiError::internal)?;
    row.map(conflict).transpose()
}

/// `GET /v1/office/conflicts?…`: every parameter is text, so a malformed one
/// is `validation_failed` naming it.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConflictListQuery {
    shift: Option<String>,
    reviewed: Option<String>,
    page: Option<String>,
}

fn page_of(text: Option<&str>) -> Result<u32, ApiError> {
    match text {
        None => Ok(1),
        Some(text) => text
            .parse::<u32>()
            .ok()
            .filter(|_| text.bytes().all(|byte| byte.is_ascii_digit()))
            .filter(|page| (1..=CONFLICT_MAX_PAGE).contains(page))
            .ok_or_else(|| ApiError::validation("page", format!("1-{CONFLICT_MAX_PAGE}"))),
    }
}

pub async fn list_conflicts(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiQuery(query): ApiQuery<ConflictListQuery>,
) -> Result<Json<OfficeConflictPage>, ApiError> {
    if let Some(shift) = &query.shift {
        validate::client_uuid("shift", shift)?;
    }
    let reviewed = match query.reviewed.as_deref() {
        None => None,
        Some("true") => Some(true),
        Some("false") => Some(false),
        Some(_) => return Err(ApiError::validation("reviewed", "true or false")),
    };
    let page = page_of(query.page.as_deref())?;
    let size = i64::from(CONFLICT_PAGE_SIZE);
    let offset = i64::from(page - 1) * size;
    // One snapshot: the count and the rows agree.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let read = async {
        let total: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM ({}) WHERE (?1 IS NULL OR l_shift_id=?1) AND (?2 IS NULL OR (reviewed_at IS NOT NULL)=?2)",union_query()))
            .bind(&query.shift)
            .bind(reviewed)
            .fetch_one(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        let rows: Vec<ConflictRow> = sqlx::query_as(&format!("SELECT * FROM ({}) WHERE (?1 IS NULL OR l_shift_id=?1) AND (?2 IS NULL OR (reviewed_at IS NOT NULL)=?2) ORDER BY detected_at DESC,l_scanned_at DESC,id DESC LIMIT ?3 OFFSET ?4",union_query()))
            .bind(&query.shift)
            .bind(reviewed)
            .bind(size)
            .bind(offset)
            .fetch_all(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        Ok::<_, ApiError>((total, rows))
    }
    .await;
    tx.rollback().await.map_err(ApiError::internal)?;
    let (total, rows) = read?;
    let total = u32::try_from(total).map_err(ApiError::internal)?;
    Ok(Json(OfficeConflictPage {
        items: rows.into_iter().map(conflict).collect::<Result<_, _>>()?,
        page,
        // The list reaches `CONFLICT_MAX_PAGE` pages; `total` stays exact.
        page_count: total
            .div_ceil(CONFLICT_PAGE_SIZE)
            .clamp(1, CONFLICT_MAX_PAGE),
        total,
    }))
}

pub async fn review_conflict(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<OfficeConflict>, ApiError> {
    context.require_conflict_review()?;
    // A conflict's id is the host's UUID: anything else is no conflict, refused before the lock.
    validate::client_uuid("id", &id)?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_conflict_review_in(&mut tx).await?;
    let current = read_conflict(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such conflict"))?;
    if current.reviewed_at.is_some() {
        // Reviewed already: the first reviewer stays, nothing is written.
        tx.rollback().await.map_err(ApiError::internal)?;
        return Ok(Json(current));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    let table = if current.winner.device_id == uuid::Uuid::nil().to_string() {
        "cloud_history_conflicts"
    } else {
        "code_conflicts"
    };
    let updated = sqlx::query(&format!(
        "UPDATE {table} SET reviewed_at = ?, reviewed_by = ? WHERE id = ? AND reviewed_at IS NULL"
    ))
    .bind(&at)
    .bind(&context.user.id)
    .bind(&id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    // The write lock holds since the read above: no audit row without its review.
    if updated.rows_affected() != 1 {
        return Err(ApiError::internal("the conflict's review was not written"));
    }
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::CONFLICT_REVIEW,
            target_type: Some("code_conflict"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({
                "kind": current.kind.as_str(),
                "loserShiftId": current.loser.shift_id,
                "loserDeviceId": current.loser.device_id,
                "winnerShiftId": current.winner.shift_id,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    let reviewed = read_conflict(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::internal("conflict vanished"))?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(reviewed))
}
