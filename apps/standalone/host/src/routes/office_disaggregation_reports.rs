//! Disaggregation acts and ЧЗ files in the office (plan ДЗГ-О):
//! `GET /v1/office/disaggregation/{id}/report-data?variant=boxes|full` and
//! `GET /v1/office/shifts/{id}/disaggregation-report?variant=boxes|full`
//! read the source. `POST …/exports` records a document's saved file.
//! the office maps the rows to the cloud's act input and draws it with
//! `@markiro/domain`, and forms the ГИС МТ «Расформирование упаковки» file
//! there too. One read transaction gives every row one snapshot; each query
//! searches by an index, and the codes of `full` are read one pass over a
//! shift's scans per shift of the document, never per box.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::future::Future;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::disaggregation::{
    constraints, DisaggregationExportRecord, DisaggregationReportBox, DisaggregationReportLine,
    DisaggregationReportRows, DisaggregationReportVariant, DisaggregationStatus,
    DISAGGREGATION_JSON_FORMAT_ID, DISAGGREGATION_JSON_FORMAT_VERSION,
    DISAGGREGATION_XML_FORMAT_ID, DISAGGREGATION_XML_FORMAT_VERSION,
};
use markiro_proto::{BoxReportItem, ExportOrganization, ShiftOrigin};
use serde::Deserialize;
use serde_json::json;
use sqlx::{SqliteConnection, SqlitePool};

use crate::audit::{self, actions, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::begin_write;
use crate::disaggregation::sets;
use crate::error::{ApiError, ApiJson, ApiPath, ApiQuery};
use crate::routes::office_exports::ORGANIZATION_SQL;
use crate::server::AppState;
use crate::shifts;

/// The document with the names of its reason and of the users who made and
/// applied it.
pub const DOCUMENT_SQL: &str = "SELECT d.id, d.doc_no, d.status, d.created_at, d.applied_at, \
     d.comment, authors.created_by_name, authors.name AS applied_by_name, r.name AS reason_name \
     FROM disaggregation_documents d \
     JOIN disaggregation_authors authors ON authors.document_id = d.id \
     LEFT JOIN disaggregation_reasons r ON r.id = d.reason_id \
     WHERE d.id = ?";

/// The lines with a recognized package code, in the order they were added, each with its
/// product's name now (the cloud's `listLines` joins the live product).
pub const LINES_SQL: &str = "SELECT l.id, l.sscc, l.set_code, COALESCE(l.box_id,l.cloud_box_id) AS box_id, COALESCE(l.pallet_id,l.cloud_pallet_id,l.warehouse_pallet_id) AS pallet_id, \
     COALESCE(l.cloud_product_name,p.name) AS product_name, l.code_count FROM disaggregation_document_lines l \
     LEFT JOIN products p ON p.id = l.product_id \
     WHERE l.document_id = ? AND (l.sscc IS NOT NULL OR l.set_code IS NOT NULL) ORDER BY l.position, l.id";

/// The full act keeps the original composition of a released set.
pub const SET_ITEMS_SQL: &str = "SELECT l.id, a.data FROM disaggregation_document_lines l \
     JOIN set_assemblies a ON a.device_id = l.set_device_id AND a.record_id = l.set_record_id \
     WHERE l.document_id = ? AND l.set_record_id IS NOT NULL";

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

/// Union by line id also covers a package that belongs to the shift by both
/// its own source shift and the assembly document.
const SHIFT_LINES_SQL: &str = "WITH selected(id) AS (
    SELECT l.id FROM boxes b CROSS JOIN disaggregation_document_lines l ON l.box_id = b.id
      WHERE b.shift_id = ?1
    UNION
    SELECT l.id FROM pallets p CROSS JOIN disaggregation_document_lines l ON l.pallet_id = p.id
      WHERE p.shift_id = ?1
    UNION
    SELECT l.id FROM set_assemblies a CROSS JOIN disaggregation_document_lines l
      ON l.set_device_id = a.device_id AND l.set_record_id = a.record_id
      WHERE a.shift_id = ?1 AND l.set_record_id IS NOT NULL
    UNION
    SELECT l.id FROM disaggregation_documents d CROSS JOIN disaggregation_document_lines l
      ON l.document_id = d.id WHERE d.status = 'applied' AND json_valid(d.device_request_json)
      AND json_extract(d.device_request_json, '$.kind') = 'set_assembly'
      AND json_extract(d.device_request_json, '$.shiftId') = ?1
)
SELECT l.id, l.sscc, l.set_code, l.box_id, l.pallet_id, p.name AS product_name,
       l.code_count, d.applied_at, b.shift_id AS box_shift_id
  FROM selected CROSS JOIN disaggregation_document_lines l ON l.id = selected.id
  CROSS JOIN disaggregation_documents d ON d.id = l.document_id
  LEFT JOIN products p ON p.id = l.product_id
  LEFT JOIN boxes b ON b.id = l.box_id
  WHERE d.status = 'applied' AND l.status = 'ok' AND (l.sscc IS NOT NULL OR l.set_code IS NOT NULL)
  ORDER BY d.applied_at, d.seq, l.position, l.id";

/// One pass over each selected box's source shift, including boxes from the
/// other shifts referenced by automatic documents.
const SHIFT_BOX_ITEMS_SQL: &str = "SELECT i.box_id, s.gtin14, s.serial, s.canonical
  FROM json_each(?1) src CROSS JOIN scans s ON s.shift_id = src.value
  CROSS JOIN box_items i ON i.scan_id = s.id JOIN boxes b ON b.id = i.box_id
  WHERE i.box_id IN (SELECT value FROM json_each(?2)) AND i.displaced_at IS NULL
    AND (i.removed_at IS NULL OR i.removed_at = b.disassembled_at)
  ORDER BY s.gtin14, s.serial";

const SHIFT_PALLET_BOXES_SQL: &str = "SELECT b.pallet_id, b.sscc,
    (SELECT COUNT(*) FROM box_items i WHERE i.box_id = b.id
     AND i.removed_at IS NULL AND i.displaced_at IS NULL) AS units
  FROM json_each(?) selected CROSS JOIN boxes b ON b.pallet_id = selected.value
  WHERE b.disassembled_at IS NULL ORDER BY b.pallet_id, b.closed_at, b.id";

const SHIFT_SET_ITEMS_SQL: &str = "SELECT l.id, a.data FROM json_each(?) selected
  CROSS JOIN disaggregation_document_lines l ON l.id = selected.value
  JOIN set_assemblies a ON a.device_id = l.set_device_id AND a.record_id = l.set_record_id";

/// The distinct packages of the document: SSCCs and set codes.
pub const PACKINGS_SQL: &str = "SELECT COUNT(DISTINCT COALESCE(sscc, set_code)) \
     FROM disaggregation_document_lines WHERE document_id = ?";

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
    sscc: Option<String>,
    set_code: Option<String>,
    box_id: Option<String>,
    pallet_id: Option<String>,
    product_name: Option<String>,
    code_count: i64,
}

#[derive(sqlx::FromRow)]
struct ShiftLineRow {
    #[sqlx(flatten)]
    line: LineRow,
    applied_at: String,
    box_shift_id: Option<String>,
}

#[derive(Default)]
struct Contents {
    items: HashMap<String, Vec<BoxReportItem>>,
    set_items: HashMap<String, Vec<BoxReportItem>>,
    boxes: HashMap<String, Vec<DisaggregationReportBox>>,
}

impl Contents {
    fn add_items(&mut self, rows: Vec<(String, String, String, String)>) {
        for (box_id, gtin14, serial, canonical) in rows {
            self.items.entry(box_id).or_default().push(BoxReportItem {
                gtin14,
                serial,
                canonical,
            });
        }
    }

    fn add_sets(&mut self, rows: Vec<(String, String)>) -> Result<(), ApiError> {
        for (line_id, data) in rows {
            let components = sets::read_assembly(&data)?
                .items
                .into_iter()
                .map(|code| BoxReportItem {
                    gtin14: code.gtin14,
                    serial: code.serial,
                    canonical: code.canonical,
                })
                .collect();
            self.set_items.insert(line_id, components);
        }
        Ok(())
    }

    fn add_pallets(&mut self, rows: Vec<(String, Option<String>, i64)>) -> Result<(), ApiError> {
        for (pallet_id, sscc, units) in rows {
            self.boxes
                .entry(pallet_id)
                .or_default()
                .push(DisaggregationReportBox {
                    sscc,
                    units: u32::try_from(units).map_err(ApiError::internal)?,
                });
        }
        Ok(())
    }

    fn lines(
        mut self,
        lines: impl IntoIterator<Item = LineRow>,
    ) -> Result<Vec<DisaggregationReportLine>, ApiError> {
        lines
            .into_iter()
            .map(|line| {
                Ok(DisaggregationReportLine {
                    items: self
                        .set_items
                        .remove(&line.id)
                        .or_else(|| line.box_id.as_ref().and_then(|id| self.items.remove(id)))
                        .unwrap_or_default(),
                    boxes: line
                        .pallet_id
                        .as_ref()
                        .and_then(|id| self.boxes.remove(id))
                        .unwrap_or_default(),
                    code_count: u32::try_from(line.code_count).map_err(ApiError::internal)?,
                    id: line.id,
                    sscc: line.sscc,
                    set_code: line.set_code,
                    box_id: line.box_id,
                    pallet_id: line.pallet_id,
                    product_name: line.product_name,
                })
            })
            .collect()
    }
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

pub async fn shift_report_data(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiQuery(query): ApiQuery<ReportQuery>,
) -> Result<Json<DisaggregationReportRows>, ApiError> {
    let variant = query.variant.unwrap_or(DisaggregationReportVariant::Boxes);
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let rows = read_shift(&mut tx, &id, variant).await;
    tx.rollback().await.map_err(ApiError::internal)?;
    rows.map(Json)
}

async fn read_shift(
    conn: &mut SqliteConnection,
    id: &str,
    variant: DisaggregationReportVariant,
) -> Result<DisaggregationReportRows, ApiError> {
    let (month, seq, origin, created_at): (String, i64, String, String) = sqlx::query_as(
        "SELECT number_month_key, number_seq, number_origin, created_at FROM shifts WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?
    .ok_or_else(|| ApiError::not_found("no such shift"))?;
    let origin: ShiftOrigin = origin.parse().map_err(ApiError::internal)?;
    let (name, inn): (String, Option<String>) = sqlx::query_as(ORGANIZATION_SQL)
        .fetch_one(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let mut selected: Vec<ShiftLineRow> = sqlx::query_as(SHIFT_LINES_SQL)
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let applied_at = selected.last().map(|row| row.applied_at.clone());
    let mut packages = HashSet::new();
    selected.retain(|row| {
        row.line
            .sscc
            .as_ref()
            .or(row.line.set_code.as_ref())
            .is_some_and(|code| packages.insert(code.clone()))
    });
    let mut contents = Contents::default();
    if variant == DisaggregationReportVariant::Full {
        let box_shifts: BTreeSet<_> = selected
            .iter()
            .filter_map(|row| row.box_shift_id.as_deref())
            .collect();
        if !box_shifts.is_empty() {
            let box_ids: Vec<_> = selected
                .iter()
                .filter_map(|row| row.line.box_id.as_deref())
                .collect();
            contents.add_items(
                sqlx::query_as(SHIFT_BOX_ITEMS_SQL)
                    .bind(serde_json::to_string(&box_shifts).map_err(ApiError::internal)?)
                    .bind(serde_json::to_string(&box_ids).map_err(ApiError::internal)?)
                    .fetch_all(&mut *conn)
                    .await
                    .map_err(ApiError::internal)?,
            );
        }
        let pallet_ids: Vec<_> = selected
            .iter()
            .filter_map(|row| row.line.pallet_id.as_deref())
            .collect();
        if !pallet_ids.is_empty() {
            contents.add_pallets(
                sqlx::query_as(SHIFT_PALLET_BOXES_SQL)
                    .bind(serde_json::to_string(&pallet_ids).map_err(ApiError::internal)?)
                    .fetch_all(&mut *conn)
                    .await
                    .map_err(ApiError::internal)?,
            )?;
        }
        let set_lines: Vec<_> = selected
            .iter()
            .filter(|row| row.line.set_code.is_some())
            .map(|row| &row.line.id)
            .collect();
        if !set_lines.is_empty() {
            contents.add_sets(
                sqlx::query_as(SHIFT_SET_ITEMS_SQL)
                    .bind(serde_json::to_string(&set_lines).map_err(ApiError::internal)?)
                    .fetch_all(&mut *conn)
                    .await
                    .map_err(ApiError::internal)?,
            )?;
        }
    }
    Ok(DisaggregationReportRows {
        id: id.to_owned(),
        doc_no: shifts::format_number(&month, seq, origin),
        status: DisaggregationStatus::Applied,
        created_at,
        applied_at,
        created_by_name: None,
        applied_by_name: None,
        reason_name: None,
        comment: None,
        organization: ExportOrganization {
            name,
            inn,
            time_zone: None,
        },
        variant,
        lines: contents.lines(selected.into_iter().map(|row| row.line))?,
    })
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
    let mut contents = Contents::default();
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
            contents.add_items(rows);
        }
        let cloud_boxes:Vec<String>=sqlx::query_scalar("SELECT cloud_box_id FROM disaggregation_document_lines WHERE document_id=? AND cloud_box_id IS NOT NULL AND sscc IS NOT NULL ORDER BY position").bind(id).fetch_all(&mut *conn).await.map_err(ApiError::internal)?;
        for id in cloud_boxes {
            let report = crate::cloud_history::read::box_report(&mut *conn, &id)
                .await?
                .ok_or_else(|| ApiError::internal("missing imported box"))?;
            contents.items.insert(id, report.items);
        }
        let assembled: Vec<(String, String)> = sqlx::query_as(SET_ITEMS_SQL)
            .bind(id)
            .fetch_all(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        contents.add_sets(assembled)?;
        after_query("items").await;
        let rows: Vec<(String, Option<String>, i64)> = sqlx::query_as(PALLET_BOXES_SQL)
            .bind(id)
            .fetch_all(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        contents.add_pallets(rows)?;
        let warehouse_boxes:Vec<(String,Option<String>,i64)>=sqlx::query_as("SELECT wb.pallet_id,b.sscc,(SELECT COUNT(*) FROM box_items i WHERE i.box_id=b.id AND i.removed_at IS NULL AND i.displaced_at IS NULL) FROM disaggregation_document_lines l JOIN warehouse_pallets wp ON wp.id=l.warehouse_pallet_id JOIN warehouse_pallet_boxes wb ON wb.pallet_id=wp.id JOIN boxes b ON b.sscc=wb.box_sscc WHERE l.document_id=? AND l.sscc IS NOT NULL AND b.disassembled_at IS NULL AND (wb.removed_at IS NULL OR wb.removed_at=wp.disassembled_at) ORDER BY wb.pallet_id,wb.added_at,wb.id")
            .bind(id).fetch_all(&mut *conn).await.map_err(ApiError::internal)?;
        contents.add_pallets(warehouse_boxes)?;
        let cloud_pallets:Vec<String>=sqlx::query_scalar("SELECT cloud_pallet_id FROM disaggregation_document_lines WHERE document_id=? AND cloud_pallet_id IS NOT NULL AND sscc IS NOT NULL ORDER BY position").bind(id).fetch_all(&mut *conn).await.map_err(ApiError::internal)?;
        for id in cloud_pallets {
            let rows = crate::cloud_history::read::pallet_rows(&mut *conn, &id)
                .await?
                .ok_or_else(|| ApiError::internal("missing imported pallet"))?;
            contents.boxes.insert(
                id,
                rows.boxes
                    .into_iter()
                    .filter(|b| b.pack.disassembled_at.is_none())
                    .map(|b| {
                        Ok(DisaggregationReportBox {
                            sscc: b.pack.sscc,
                            units: u32::try_from(b.units).map_err(ApiError::internal)?,
                        })
                    })
                    .collect::<Result<Vec<_>, ApiError>>()?,
            );
        }
        after_query("boxes").await;
    }
    let status: DisaggregationStatus = document.status.parse().map_err(ApiError::internal)?;
    let lines = contents.lines(lines)?;
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
        organization: ExportOrganization {
            name,
            inn,
            time_zone: None,
        },
        variant,
        lines,
    }))
}

pub(crate) async fn require_xml_eligible(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<(), ApiError> {
    let has_sets: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM disaggregation_document_lines WHERE document_id = ? AND set_code IS NOT NULL)",
    )
    .bind(id)
    .fetch_one(conn)
    .await
    .map_err(ApiError::internal)?;
    if has_sets {
        return Err(ApiError::conflict(
            constraints::SET_XML_UNSUPPORTED,
            "the SSCC XML cannot represent the document's marked sets",
        )
        .with_details(json!({ "constraint": constraints::SET_XML_UNSUPPORTED })));
    }
    Ok(())
}

pub(crate) async fn require_applied_document(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<(), ApiError> {
    let status: Option<String> =
        sqlx::query_scalar("SELECT status FROM disaggregation_documents WHERE id = ?")
            .bind(id)
            .fetch_optional(conn)
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
    Ok(())
}

/// `POST /v1/office/disaggregation/{id}/exports`: one `disaggregation.export`
/// row with what the file named, `204`. Only an applied document has a file
/// (`conflict` on `document_not_applied`); `packingCount` counts its packages.
pub async fn record_export(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath(id): ApiPath<String>,
    ApiJson(record): ApiJson<DisaggregationExportRecord>,
) -> Result<StatusCode, ApiError> {
    let xml = match (record.format_id.as_str(), record.format_version) {
        (DISAGGREGATION_XML_FORMAT_ID, DISAGGREGATION_XML_FORMAT_VERSION) => true,
        (DISAGGREGATION_JSON_FORMAT_ID, DISAGGREGATION_JSON_FORMAT_VERSION) => false,
        _ => {
            return Err(ApiError::validation(
                "formatId",
                "not a file the office forms for a disaggregation document",
            ))
        }
    };
    context.require_disaggregation()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_disaggregation_in(&mut tx).await?;
    require_applied_document(&mut tx, &id).await?;
    if xml {
        require_xml_eligible(&mut tx, &id).await?;
    }
    let packings: i64 = sqlx::query_scalar(PACKINGS_SQL)
        .bind(&id)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if i64::from(record.packing_count) != packings {
        return Err(ApiError::validation(
            "packingCount",
            "the file names each package of the document once",
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
