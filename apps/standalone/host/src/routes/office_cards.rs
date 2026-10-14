//! A box's and a pallet's cards in the office (plan КРТ, parity spec §5.3,
//! the cloud's `GET /code-search/boxes/:id` and `…/pallets/:id`). Every
//! office role reads them; a device key alone never does. Read only:
//! nothing is written, not even an audit row. Each card reads in one
//! snapshot, each query by an index; no full code is read (a code is its
//! GTIN and serial, its full text is the code card's).

use axum::extract::State;
use axum::Json;
use markiro_proto::code_search::CodePlacementState;
use markiro_proto::pack_cards::{
    OfficeBoxCard, OfficeBoxException, OfficeBoxItem, OfficePackDocument, OfficePackPallet,
    OfficePackShift, OfficePalletBox, OfficePalletCard, OfficePalletException, CARD_ROW_LIMIT,
};
use markiro_proto::{ExceptionKind, PalletExceptionKind, ShiftOrigin, ShiftStatus};
use serde::de::DeserializeOwned;
use sqlx::SqliteConnection;

use crate::auth::OfficeContext;
use crate::error::{ApiError, ApiPath};
use crate::server::AppState;
use crate::{shifts, validate};

/// The box with its shift, product and line now, its station, operator
/// and pallet, and its live items counted through `box_items_live`.
pub const BOX_SQL: &str = "SELECT b.id, b.sscc, b.opened_at, b.closed_at, b.disassembled_at, \
     b.item_count_reported, b.digest_matches, b.print_verified_at, b.print_skipped_at, \
     b.device_id, d.name AS device_name, op.name AS operator_name, \
     (SELECT COUNT(*) FROM box_items i WHERE i.box_id = b.id \
      AND i.removed_at IS NULL AND i.displaced_at IS NULL) AS units, \
     sh.id AS shift_id, sh.number_month_key, sh.number_seq, sh.created_from, \
     sh.status AS shift_status, sh.production_date, pr.name AS product_name, \
     l.name AS line_name, p.id AS pallet_id, p.sscc AS pallet_sscc, \
     p.closed_at AS pallet_closed_at, p.disassembled_at AS pallet_disassembled_at \
     FROM boxes b JOIN shifts sh ON sh.id = b.shift_id \
     JOIN products pr ON pr.id = sh.product_id JOIN lines l ON l.id = sh.line_id \
     JOIN devices d ON d.id = b.device_id LEFT JOIN operators op ON op.id = b.operator_id \
     LEFT JOIN pallets p ON p.id = b.pallet_id WHERE b.id = ?1";

/// Every item the box ever had, newest first: every accepted scan into the
/// box names it (`scans_ok_box`, plan «Поиск кодов»), and each item is the
/// one of its scan. A scan that lost its code to an earlier one has no item.
pub const BOX_ITEMS_SQL: &str = "SELECT i.scan_id, i.code_hash, s.gtin14, s.serial, \
     i.added_at, i.removed_at, i.displaced_at, op.name AS operator_name \
     FROM scans s JOIN box_items i ON i.scan_id = s.id \
     LEFT JOIN operators op ON op.id = s.operator_id \
     WHERE s.box_id = ?1 AND s.verdict = 'ok' \
     ORDER BY i.added_at DESC, i.scan_id DESC LIMIT ?2";

/// The box's exceptions, oldest first.
pub const BOX_EXCEPTIONS_SQL: &str = "SELECT e.id, e.kind, e.code_hash, e.reason_code, \
     e.reason_text, e.occurred_at, e.received_at, d.name AS device_name, \
     op.name AS operator_name FROM box_exceptions e JOIN devices d ON d.id = e.device_id \
     LEFT JOIN operators op ON op.id = e.operator_id \
     WHERE e.box_id = ?1 ORDER BY e.occurred_at, e.id LIMIT ?2";

/// The pallet with its shift, product and line now, its station and
/// operator, and what stands on it (closed boxes not taken apart and their
/// live items), as `office_boxes::PALLETS_SQL` derives them.
pub const PALLET_SQL: &str = "SELECT p.id, p.sscc, p.opened_at, p.closed_at, \
     p.disassembled_at, p.box_count_reported, p.print_verified_at, p.print_skipped_at, \
     p.device_id, d.name AS device_name, op.name AS operator_name, \
     (SELECT COUNT(*) FROM boxes b WHERE b.pallet_id = p.id \
      AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL) AS boxes, \
     (SELECT COUNT(*) FROM boxes b JOIN box_items i ON i.box_id = b.id \
      AND i.removed_at IS NULL AND i.displaced_at IS NULL \
      WHERE b.pallet_id = p.id AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL) \
      AS units, \
     sh.id AS shift_id, sh.number_month_key, sh.number_seq, sh.created_from, \
     sh.status AS shift_status, sh.production_date, pr.name AS product_name, \
     l.name AS line_name \
     FROM pallets p JOIN shifts sh ON sh.id = p.shift_id \
     JOIN products pr ON pr.id = sh.product_id JOIN lines l ON l.id = sh.line_id \
     JOIN devices d ON d.id = p.device_id LEFT JOIN operators op ON op.id = p.operator_id \
     WHERE p.id = ?1";

/// Every box that joined the pallet, taken apart or not (the only evidence
/// that a labelled pallet left a box short), closed newest first.
pub const PALLET_BOXES_SQL: &str = "SELECT b.id, b.sscc, b.closed_at, b.disassembled_at, \
     (SELECT COUNT(*) FROM box_items i WHERE i.box_id = b.id \
      AND i.removed_at IS NULL AND i.displaced_at IS NULL) AS units \
     FROM boxes b WHERE b.pallet_id = ?1 ORDER BY b.closed_at DESC, b.id LIMIT ?2";

/// The pallet's exceptions, oldest first.
pub const PALLET_EXCEPTIONS_SQL: &str = "SELECT e.id, e.kind, e.reason_code, e.reason_text, \
     e.occurred_at, e.received_at, d.name AS device_name, op.name AS operator_name \
     FROM pallet_exceptions e JOIN devices d ON d.id = e.device_id \
     LEFT JOIN operators op ON op.id = e.operator_id \
     WHERE e.pallet_id = ?1 ORDER BY e.occurred_at, e.id LIMIT ?2";

/// Plan ДЗГ's applied documents that took the box apart: an applied
/// document's `ok` line names the box (the office branch of the readers'
/// union, `AGENTS.md` «Disaggregation documents»). A draft's or a cancelled
/// document's lines and a line that found the box taken apart already are
/// not.
pub const BOX_DOCUMENTS_SQL: &str = "SELECT d.id, d.doc_no, d.applied_at, \
     r.name AS reason_name, u.name AS applied_by_name \
     FROM disaggregation_document_lines l \
     JOIN disaggregation_documents d ON d.id = l.document_id AND d.status = 'applied' \
     LEFT JOIN disaggregation_reasons r ON r.id = d.reason_id \
     LEFT JOIN office_users u ON u.id = d.applied_by \
     WHERE l.box_id = ?1 AND l.status = 'ok' ORDER BY d.applied_at, d.id LIMIT ?2";

/// The same of a pallet.
pub const PALLET_DOCUMENTS_SQL: &str = "SELECT d.id, d.doc_no, d.applied_at, \
     r.name AS reason_name, u.name AS applied_by_name \
     FROM disaggregation_document_lines l \
     JOIN disaggregation_documents d ON d.id = l.document_id AND d.status = 'applied' \
     LEFT JOIN disaggregation_reasons r ON r.id = d.reason_id \
     LEFT JOIN office_users u ON u.id = d.applied_by \
     WHERE l.pallet_id = ?1 AND l.status = 'ok' ORDER BY d.applied_at, d.id LIMIT ?2";

/// Every query of this module by name, for the test that each one searches
/// by an index.
pub const QUERIES: [(&str, &str); 8] = [
    ("box", BOX_SQL),
    ("box items", BOX_ITEMS_SQL),
    ("box exceptions", BOX_EXCEPTIONS_SQL),
    ("pallet", PALLET_SQL),
    ("pallet boxes", PALLET_BOXES_SQL),
    ("pallet exceptions", PALLET_EXCEPTIONS_SQL),
    ("box documents", BOX_DOCUMENTS_SQL),
    ("pallet documents", PALLET_DOCUMENTS_SQL),
];

#[derive(sqlx::FromRow)]
struct BoxRow {
    id: String,
    sscc: Option<String>,
    opened_at: String,
    closed_at: Option<String>,
    disassembled_at: Option<String>,
    item_count_reported: Option<u32>,
    digest_matches: Option<bool>,
    print_verified_at: Option<String>,
    print_skipped_at: Option<String>,
    device_id: String,
    device_name: String,
    operator_name: Option<String>,
    units: i64,
    shift_id: String,
    number_month_key: String,
    number_seq: i64,
    created_from: String,
    shift_status: String,
    production_date: String,
    product_name: String,
    line_name: String,
    pallet_id: Option<String>,
    pallet_sscc: Option<String>,
    pallet_closed_at: Option<String>,
    pallet_disassembled_at: Option<String>,
}

#[derive(sqlx::FromRow)]
struct ItemRow {
    scan_id: String,
    code_hash: String,
    gtin14: String,
    serial: String,
    added_at: String,
    removed_at: Option<String>,
    displaced_at: Option<String>,
    operator_name: Option<String>,
}

#[derive(sqlx::FromRow)]
struct ExceptionRow {
    id: String,
    kind: String,
    code_hash: Option<String>,
    reason_code: Option<String>,
    reason_text: Option<String>,
    occurred_at: String,
    received_at: String,
    device_name: String,
    operator_name: Option<String>,
}

#[derive(sqlx::FromRow)]
struct DocumentRow {
    id: String,
    doc_no: String,
    applied_at: String,
    reason_name: Option<String>,
    applied_by_name: Option<String>,
}

#[derive(sqlx::FromRow)]
struct PalletRow {
    id: String,
    sscc: Option<String>,
    opened_at: String,
    closed_at: Option<String>,
    disassembled_at: Option<String>,
    box_count_reported: Option<u32>,
    print_verified_at: Option<String>,
    print_skipped_at: Option<String>,
    device_id: String,
    device_name: String,
    operator_name: Option<String>,
    boxes: i64,
    units: i64,
    shift_id: String,
    number_month_key: String,
    number_seq: i64,
    created_from: String,
    shift_status: String,
    production_date: String,
    product_name: String,
    line_name: String,
}

#[derive(sqlx::FromRow)]
struct MemberRow {
    id: String,
    sscc: Option<String>,
    closed_at: Option<String>,
    disassembled_at: Option<String>,
    units: i64,
}

#[derive(sqlx::FromRow)]
struct PalletExceptionRow {
    id: String,
    kind: String,
    reason_code: String,
    reason_text: Option<String>,
    occurred_at: String,
    received_at: String,
    device_name: String,
    operator_name: Option<String>,
}

/// A stored word read back into its wire enum.
pub(crate) fn stored<T: DeserializeOwned>(text: &str) -> Result<T, ApiError> {
    serde_json::from_value(serde_json::Value::String(text.to_owned())).map_err(ApiError::internal)
}

/// The shift of a card, its number as people read it.
pub(crate) struct ShiftColumns {
    pub id: String,
    pub month_key: String,
    pub seq: i64,
    pub created_from: String,
    pub status: String,
    pub production_date: String,
    pub product_name: String,
    pub line_name: String,
}

pub(crate) fn pack_shift(shift: ShiftColumns) -> Result<OfficePackShift, ApiError> {
    let origin: ShiftOrigin = shift.created_from.parse().map_err(ApiError::internal)?;
    let status: ShiftStatus = shift.status.parse().map_err(ApiError::internal)?;
    Ok(OfficePackShift {
        number: shifts::format_number(&shift.month_key, shift.seq, origin),
        id: shift.id,
        status,
        production_date: shift.production_date,
        product_name: shift.product_name,
        line_name: shift.line_name,
    })
}

/// Where an item stands, as the code search's placements (`office_codes`):
/// taken out wins over taken elsewhere.
fn item_state(row: &ItemRow, box_closed: bool) -> (CodePlacementState, Option<String>) {
    match (&row.removed_at, &row.displaced_at) {
        (Some(at), _) => (CodePlacementState::Removed, Some(at.clone())),
        (None, Some(at)) => (CodePlacementState::Displaced, Some(at.clone())),
        (None, None) if box_closed => (CodePlacementState::Packed, None),
        (None, None) => (CodePlacementState::OpenBox, None),
    }
}

/// The rows a card keeps and whether there were more than `limit` of them
/// (a query asks for one row beyond the limit to tell).
fn take_capped<T>(mut rows: Vec<T>, limit: usize) -> (Vec<T>, bool) {
    let capped = rows.len() > limit;
    rows.truncate(limit);
    (rows, capped)
}

/// The id of a box or a pallet in a path: the station's lower-case UUID.
pub(crate) fn pack_id(id: &str) -> Result<(), ApiError> {
    validate::client_uuid("id", id)
}

async fn read_box(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<OfficeBoxCard>, ApiError> {
    let limit = i64::from(CARD_ROW_LIMIT);
    let Some(row): Option<BoxRow> = sqlx::query_as(BOX_SQL)
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?
    else {
        return Ok(None);
    };
    let items: Vec<ItemRow> = sqlx::query_as(BOX_ITEMS_SQL)
        .bind(id)
        .bind(limit + 1)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let (items, items_capped) = take_capped(items, CARD_ROW_LIMIT as usize);
    let exceptions: Vec<ExceptionRow> = sqlx::query_as(BOX_EXCEPTIONS_SQL)
        .bind(id)
        .bind(limit)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let documents = box_documents(&mut *conn, id).await?;
    let closed = row.closed_at.is_some();
    let items = items
        .into_iter()
        .map(|item| {
            let (state, left_at) = item_state(&item, closed);
            OfficeBoxItem {
                scan_id: item.scan_id,
                code_hash: item.code_hash,
                gtin14: item.gtin14,
                serial: item.serial,
                added_at: item.added_at,
                state,
                left_at,
                operator_name: item.operator_name,
            }
        })
        .collect();
    let exceptions = exceptions
        .into_iter()
        .map(|exception| {
            Ok(OfficeBoxException {
                kind: stored::<ExceptionKind>(&exception.kind)?,
                id: exception.id,
                code_hash: exception.code_hash,
                reason_code: exception.reason_code,
                reason_text: exception.reason_text,
                occurred_at: exception.occurred_at,
                received_at: exception.received_at,
                device_name: exception.device_name,
                operator_name: exception.operator_name,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Some(OfficeBoxCard {
        shift: pack_shift(ShiftColumns {
            id: row.shift_id,
            month_key: row.number_month_key,
            seq: row.number_seq,
            created_from: row.created_from,
            status: row.shift_status,
            production_date: row.production_date,
            product_name: row.product_name,
            line_name: row.line_name,
        })?,
        pallet: row.pallet_id.map(|id| OfficePackPallet {
            id,
            sscc: row.pallet_sscc,
            closed_at: row.pallet_closed_at,
            disassembled_at: row.pallet_disassembled_at,
        }),
        units: u32::try_from(row.units).map_err(ApiError::internal)?,
        id: row.id,
        sscc: row.sscc,
        device_id: row.device_id,
        device_name: row.device_name,
        operator_name: row.operator_name,
        opened_at: row.opened_at,
        closed_at: row.closed_at,
        disassembled_at: row.disassembled_at,
        item_count_reported: row.item_count_reported,
        digest_matches: row.digest_matches,
        print_verified_at: row.print_verified_at,
        print_skipped_at: row.print_skipped_at,
        items,
        items_capped,
        exceptions,
        documents,
    }))
}

/// The applied disaggregation documents that took the box apart (plan ДЗГ).
async fn box_documents(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Vec<OfficePackDocument>, ApiError> {
    documents(conn, BOX_DOCUMENTS_SQL, id).await
}

/// The documents of one box or pallet, oldest first.
async fn documents(
    conn: &mut SqliteConnection,
    sql: &str,
    id: &str,
) -> Result<Vec<OfficePackDocument>, ApiError> {
    let rows: Vec<DocumentRow> = sqlx::query_as(sql)
        .bind(id)
        .bind(i64::from(CARD_ROW_LIMIT))
        .fetch_all(conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(rows
        .into_iter()
        .map(|row| OfficePackDocument {
            id: row.id,
            doc_no: row.doc_no,
            applied_at: row.applied_at,
            reason_name: row.reason_name,
            applied_by_name: row.applied_by_name,
        })
        .collect())
}

/// `GET /v1/office/boxes/{id}`: a malformed id is `validation_failed`, a box
/// the host never saw `not_found`.
pub async fn box_card(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<OfficeBoxCard>, ApiError> {
    pack_id(&id)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let card = read_box(&mut tx, &id).await;
    tx.rollback().await.map_err(ApiError::internal)?;
    card?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("no such box"))
}

async fn read_pallet(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<OfficePalletCard>, ApiError> {
    let limit = i64::from(CARD_ROW_LIMIT);
    let Some(row): Option<PalletRow> = sqlx::query_as(PALLET_SQL)
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?
    else {
        return Ok(None);
    };
    let members: Vec<MemberRow> = sqlx::query_as(PALLET_BOXES_SQL)
        .bind(id)
        .bind(limit + 1)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let (members, members_capped) = take_capped(members, CARD_ROW_LIMIT as usize);
    let exceptions: Vec<PalletExceptionRow> = sqlx::query_as(PALLET_EXCEPTIONS_SQL)
        .bind(id)
        .bind(limit)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let documents = pallet_documents(&mut *conn, id).await?;
    let members = members
        .into_iter()
        .map(|member| {
            Ok(OfficePalletBox {
                units: u32::try_from(member.units).map_err(ApiError::internal)?,
                id: member.id,
                sscc: member.sscc,
                closed_at: member.closed_at,
                disassembled_at: member.disassembled_at,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    let exceptions = exceptions
        .into_iter()
        .map(|exception| {
            Ok(OfficePalletException {
                kind: stored::<PalletExceptionKind>(&exception.kind)?,
                id: exception.id,
                reason_code: exception.reason_code,
                reason_text: exception.reason_text,
                occurred_at: exception.occurred_at,
                received_at: exception.received_at,
                device_name: exception.device_name,
                operator_name: exception.operator_name,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Some(OfficePalletCard {
        shift: pack_shift(ShiftColumns {
            id: row.shift_id,
            month_key: row.number_month_key,
            seq: row.number_seq,
            created_from: row.created_from,
            status: row.shift_status,
            production_date: row.production_date,
            product_name: row.product_name,
            line_name: row.line_name,
        })?,
        boxes: u32::try_from(row.boxes).map_err(ApiError::internal)?,
        units: u64::try_from(row.units).map_err(ApiError::internal)?,
        id: row.id,
        sscc: row.sscc,
        device_id: row.device_id,
        device_name: row.device_name,
        operator_name: row.operator_name,
        opened_at: row.opened_at,
        closed_at: row.closed_at,
        disassembled_at: row.disassembled_at,
        box_count_reported: row.box_count_reported,
        print_verified_at: row.print_verified_at,
        print_skipped_at: row.print_skipped_at,
        members,
        members_capped,
        exceptions,
        documents,
    }))
}

/// The applied disaggregation documents that took the pallet apart (plan ДЗГ).
async fn pallet_documents(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Vec<OfficePackDocument>, ApiError> {
    documents(conn, PALLET_DOCUMENTS_SQL, id).await
}

/// `GET /v1/office/pallets/{id}`: a malformed id is `validation_failed`, a
/// pallet the host never saw `not_found`.
pub async fn pallet_card(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<OfficePalletCard>, ApiError> {
    pack_id(&id)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let card = read_pallet(&mut tx, &id).await;
    tx.rollback().await.map_err(ApiError::internal)?;
    card?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("no such pallet"))
}

#[cfg(test)]
mod tests {
    use super::take_capped;

    #[test]
    fn a_card_keeps_the_limit_and_says_when_there_was_more() {
        assert_eq!(take_capped(vec![1, 2, 3], 3), (vec![1, 2, 3], false));
        assert_eq!(take_capped(vec![1, 2, 3, 4], 3), (vec![1, 2, 3], true));
        assert_eq!(take_capped(Vec::<u8>::new(), 3), (vec![], false));
    }
}
