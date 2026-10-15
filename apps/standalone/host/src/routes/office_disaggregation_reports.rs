//! A disaggregation document's act and ЧЗ file in the office (plan ДЗГ-О):
//! `GET /v1/office/disaggregation/{id}/report-data?variant=boxes|full` and
//! `POST …/exports`, every office role. The host only reads and records:
//! the office maps the rows to the cloud's act input and draws it with
//! `@markiro/domain`, and forms the ГИС МТ «Расформирование упаковки» file
//! there too. One read transaction gives every row one snapshot; each query
//! searches by an index, and the codes of `full` are read one pass over a
//! shift's scans per shift of the document, never per box.

use std::collections::HashMap;
use std::future::Future;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::disaggregation::{
    constraints, DisaggregationExportRecord, DisaggregationReportBox, DisaggregationReportLine,
    DisaggregationReportRows, DisaggregationReportVariant, DisaggregationStatus,
    DISAGGREGATION_XML_FORMAT_ID, DISAGGREGATION_XML_FORMAT_VERSION,
};
use markiro_proto::{BoxReportItem, ExportOrganization};
use serde::Deserialize;
use serde_json::json;
use sqlx::{SqliteConnection, SqlitePool};

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::begin_write;
use crate::error::{ApiError, ApiJson, ApiPath, ApiQuery};
use crate::routes::office_exports::ORGANIZATION_SQL;
use crate::server::AppState;

/// The document with the names of its reason and of the users who made and
/// applied it.
pub const DOCUMENT_SQL: &str = "SELECT d.id, d.doc_no, d.status, d.created_at, d.applied_at, \
     d.comment, cu.name AS created_by_name, au.name AS applied_by_name, r.name AS reason_name \
     FROM disaggregation_documents d \
     JOIN office_users cu ON cu.id = d.created_by \
     LEFT JOIN office_users au ON au.id = d.applied_by \
     LEFT JOIN disaggregation_reasons r ON r.id = d.reason_id \
     WHERE d.id = ?";

/// The lines with an SSCC, in the order they were added, each with its
/// product's name now (the cloud's `listLines` joins the live product).
pub const LINES_SQL: &str = "SELECT l.id, l.sscc, l.box_id, l.pallet_id, \
     p.name AS product_name, l.code_count FROM disaggregation_document_lines l \
     LEFT JOIN products p ON p.id = l.product_id \
     WHERE l.document_id = ? AND l.sscc IS NOT NULL ORDER BY l.position, l.id";

/// The shifts of the document's boxes, each read once by `SHIFT_ITEMS_SQL`.
pub const LINE_SHIFTS_SQL: &str = "SELECT DISTINCT b.shift_id \
     FROM disaggregation_document_lines l JOIN boxes b ON b.id = l.box_id \
     WHERE l.document_id = ? AND l.sscc IS NOT NULL ORDER BY b.shift_id";

/// The codes the act prints of the document's boxes of one shift: «Состав
/// короба»'s rule (`office_reports::BOX_ITEMS_SQL`) — not displaced, and
/// live or taken out by the box's own disassembly — through `scans_shift`,
/// since no index names a box's items that are no longer live.
pub const SHIFT_ITEMS_SQL: &str = "SELECT i.box_id, s.gtin14, s.serial, s.canonical \
     FROM scans s JOIN box_items i ON i.scan_id = s.id JOIN boxes b ON b.id = i.box_id \
     WHERE s.shift_id = ?1 AND i.box_id IN (SELECT l.box_id FROM disaggregation_document_lines l \
       WHERE l.document_id = ?2 AND l.box_id IS NOT NULL AND l.sscc IS NOT NULL) \
     AND i.displaced_at IS NULL \
     AND (i.removed_at IS NULL OR i.removed_at = b.disassembled_at) \
     ORDER BY s.gtin14, s.serial";

/// The boxes standing on the document's pallets: not taken apart (the
/// cloud's `isNull(boxes.disassembledAt)`; a box taken off before keeps
/// its `pallet_id`), closed first, with their live units.
pub const PALLET_BOXES_SQL: &str = "SELECT b.pallet_id, b.sscc, \
     (SELECT COUNT(*) FROM box_items i WHERE i.box_id = b.id \
      AND i.removed_at IS NULL AND i.displaced_at IS NULL) AS units \
     FROM boxes b WHERE b.pallet_id IN (SELECT l.pallet_id FROM disaggregation_document_lines l \
       WHERE l.document_id = ? AND l.pallet_id IS NOT NULL AND l.sscc IS NOT NULL) \
     AND b.disassembled_at IS NULL ORDER BY b.pallet_id, b.closed_at, b.id";

/// The packages the document's ЧЗ file names: its distinct SSCCs.
pub const PACKINGS_SQL: &str = "SELECT COUNT(DISTINCT sscc) FROM disaggregation_document_lines \
     WHERE document_id = ? AND sscc IS NOT NULL";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportQuery {
    #[serde(default)]
    variant: Option<DisaggregationReportVariant>,
}

#[derive(sqlx::FromRow)]
struct DocumentRow {
    id: String,
    doc_no: String,
    status: String,
    created_at: String,
    applied_at: Option<String>,
    comment: Option<String>,
    created_by_name: Option<String>,
    applied_by_name: Option<String>,
    reason_name: Option<String>,
}

#[derive(sqlx::FromRow)]
struct LineRow {
    id: String,
    sscc: String,
    box_id: Option<String>,
    pallet_id: Option<String>,
    product_name: Option<String>,
    code_count: i64,
}

pub async fn report_data(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiQuery(query): ApiQuery<ReportQuery>,
) -> Result<Json<DisaggregationReportRows>, ApiError> {
    let variant = query.variant.unwrap_or(DisaggregationReportVariant::Boxes);
    read_report_rows(&state.pool, &id, variant, |_| async {})
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("no such disaggregation document"))
}

/// The reads of an act in one plain deferred transaction, rolled back, as
/// `office_reports::read_box_rows`. `after_query` is called with each
/// query's name (`document`, `organization`, `lines`, `items`, `boxes`).
pub async fn read_report_rows<F, Fut>(
    pool: &SqlitePool,
    id: &str,
    variant: DisaggregationReportVariant,
    after_query: F,
) -> Result<Option<DisaggregationReportRows>, ApiError>
where
    F: FnMut(&'static str) -> Fut,
    Fut: Future<Output = ()>,
{
    let mut tx = pool.begin().await.map_err(ApiError::internal)?;
    let rows = read(&mut tx, id, variant, after_query).await;
    tx.rollback().await.map_err(ApiError::internal)?;
    rows
}

async fn read<F, Fut>(
    conn: &mut SqliteConnection,
    id: &str,
    variant: DisaggregationReportVariant,
    mut after_query: F,
) -> Result<Option<DisaggregationReportRows>, ApiError>
where
    F: FnMut(&'static str) -> Fut,
    Fut: Future<Output = ()>,
{
    let found: Option<DocumentRow> = sqlx::query_as(DOCUMENT_SQL)
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    after_query("document").await;
    let Some(document) = found else {
        return Ok(None);
    };
    let (name, inn): (String, Option<String>) = sqlx::query_as(ORGANIZATION_SQL)
        .fetch_one(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    after_query("organization").await;
    let lines: Vec<LineRow> = sqlx::query_as(LINES_SQL)
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    after_query("lines").await;
    let mut items: HashMap<String, Vec<BoxReportItem>> = HashMap::new();
    let mut boxes: HashMap<String, Vec<DisaggregationReportBox>> = HashMap::new();
    if variant == DisaggregationReportVariant::Full {
        let shifts: Vec<String> = sqlx::query_scalar(LINE_SHIFTS_SQL)
            .bind(id)
            .fetch_all(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        for shift in shifts {
            let rows: Vec<(String, String, String, String)> = sqlx::query_as(SHIFT_ITEMS_SQL)
                .bind(&shift)
                .bind(id)
                .fetch_all(&mut *conn)
                .await
                .map_err(ApiError::internal)?;
            for (box_id, gtin14, serial, canonical) in rows {
                items.entry(box_id).or_default().push(BoxReportItem {
                    gtin14,
                    serial,
                    canonical,
                });
            }
        }
        after_query("items").await;
        let rows: Vec<(String, Option<String>, i64)> = sqlx::query_as(PALLET_BOXES_SQL)
            .bind(id)
            .fetch_all(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        for (pallet_id, sscc, units) in rows {
            boxes
                .entry(pallet_id)
                .or_default()
                .push(DisaggregationReportBox {
                    sscc,
                    units: u32::try_from(units).map_err(ApiError::internal)?,
                });
        }
        after_query("boxes").await;
    }
    let status: DisaggregationStatus = document.status.parse().map_err(ApiError::internal)?;
    let lines = lines
        .into_iter()
        .map(|line| {
            Ok(DisaggregationReportLine {
                // A box is on the act once: a repeat keeps `sscc = NULL` (plan ДЗГ, Р12).
                items: line
                    .box_id
                    .as_ref()
                    .and_then(|b| items.remove(b))
                    .unwrap_or_default(),
                boxes: line
                    .pallet_id
                    .as_ref()
                    .and_then(|p| boxes.remove(p))
                    .unwrap_or_default(),
                code_count: u32::try_from(line.code_count).map_err(ApiError::internal)?,
                id: line.id,
                sscc: line.sscc,
                box_id: line.box_id,
                pallet_id: line.pallet_id,
                product_name: line.product_name,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Some(DisaggregationReportRows {
        id: document.id,
        doc_no: document.doc_no,
        status,
        created_at: document.created_at,
        applied_at: document.applied_at,
        created_by_name: document.created_by_name,
        applied_by_name: document.applied_by_name,
        reason_name: document.reason_name,
        comment: document.comment,
        organization: ExportOrganization { name, inn },
        variant,
        lines,
    }))
}

/// `POST /v1/office/disaggregation/{id}/exports`: one `disaggregation.export`
/// row with what the file named, `204`. Only an applied document has a file
/// (`conflict` on `document_not_applied`); `packingCount` must be its distinct
/// SSCCs — an applied document's lines never change, so another count is
/// the office's mistake, not a race.
pub async fn record_export(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(record): ApiJson<DisaggregationExportRecord>,
) -> Result<StatusCode, ApiError> {
    if record.format_id != DISAGGREGATION_XML_FORMAT_ID
        || record.format_version != DISAGGREGATION_XML_FORMAT_VERSION
    {
        return Err(ApiError::validation(
            "formatId",
            "not a file the office forms for a disaggregation document",
        ));
    }
    context.require_disaggregation()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_disaggregation_in(&mut tx).await?;
    let status: Option<String> =
        sqlx::query_scalar("SELECT status FROM disaggregation_documents WHERE id = ?")
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    let status: DisaggregationStatus = status
        .ok_or_else(|| ApiError::not_found("no such disaggregation document"))?
        .parse()
        .map_err(ApiError::internal)?;
    if status != DisaggregationStatus::Applied {
        return Err(ApiError::conflict(
            constraints::NOT_APPLIED,
            "only an applied document has a ЧЗ file",
        ));
    }
    let packings: i64 = sqlx::query_scalar(PACKINGS_SQL)
        .bind(&id)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if i64::from(record.packing_count) != packings {
        return Err(ApiError::validation(
            "packingCount",
            "the file names each SSCC of the document once",
        ));
    }
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: actions::DISAGGREGATION_EXPORT,
            target_type: Some("disaggregation_document"),
            target_id: Some(&id),
            outcome: Outcome::Ok,
            details: json!({
                "formatId": record.format_id,
                "formatVersion": record.format_version,
                "packingCount": record.packing_count,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}
