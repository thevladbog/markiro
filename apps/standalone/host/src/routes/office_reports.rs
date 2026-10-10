//! The data of a shift's printed forms (plan О-Ф): `GET
//! /v1/office/boxes/{id}/report-data`, every office role. The host only
//! reads: the office maps these rows to the cloud's form inputs and renders
//! the forms with `@markiro/domain`. One read transaction gives every row
//! one snapshot, and each query searches by an index, never through every
//! fact of the host.

use std::future::Future;

use axum::extract::State;
use axum::Json;
use markiro_proto::{BoxReportItem, BoxReportRows, ExportOrganization};
use sqlx::{SqliteConnection, SqlitePool};

use crate::auth::OfficeContext;
use crate::error::{ApiError, ApiPath};
use crate::routes::office_exports::ORGANIZATION_SQL;
use crate::server::AppState;

/// The box with its shift's product's name now.
pub const BOX_SQL: &str = "SELECT b.id, b.shift_id, b.sscc, b.opened_at, b.closed_at, \
     b.disassembled_at, p.name AS product_name FROM boxes b \
     JOIN shifts s ON s.id = b.shift_id JOIN products p ON p.id = s.product_id WHERE b.id = ?";

/// The codes the cloud's «Состав короба» prints: the box's items neither
/// displaced nor taken out, or taken out by the box's own disassembly. They
/// are found through the scans of the box's shift (`scans_shift`, then
/// `box_items` by its key): no index of `box_items` names a box's items
/// that are no longer live, and a year of items must not be read for one box.
pub const BOX_ITEMS_SQL: &str = "SELECT s.gtin14, s.serial, s.canonical FROM boxes b \
     JOIN scans s ON s.shift_id = b.shift_id \
     JOIN box_items i ON i.scan_id = s.id AND i.box_id = b.id \
     WHERE b.id = ? AND i.displaced_at IS NULL \
     AND (i.removed_at IS NULL OR i.removed_at = b.disassembled_at) \
     ORDER BY s.gtin14, s.serial";

#[derive(sqlx::FromRow)]
struct BoxRow {
    id: String,
    shift_id: String,
    sscc: Option<String>,
    opened_at: String,
    closed_at: Option<String>,
    disassembled_at: Option<String>,
    product_name: String,
}

/// `GET /v1/office/boxes/{id}/report-data`: an unknown box is `not_found`.
pub async fn box_report(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<BoxReportRows>, ApiError> {
    read_box_rows(&state.pool, &id, |_| async {})
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("no such box"))
}

/// The three reads of a box's form in one plain deferred transaction:
/// nothing here writes, so it is rolled back, and the reads share one WAL
/// snapshot. `after_query` is called with the name of each query just read
/// (`box`, `organization`, `items`); the route passes a closure that does
/// nothing, a test writes from another connection there to prove that no
/// write lands in the answer.
pub async fn read_box_rows<F, Fut>(
    pool: &SqlitePool,
    id: &str,
    after_query: F,
) -> Result<Option<BoxReportRows>, ApiError>
where
    F: FnMut(&'static str) -> Fut,
    Fut: Future<Output = ()>,
{
    let mut tx = pool.begin().await.map_err(ApiError::internal)?;
    let rows = read_box(&mut tx, id, after_query).await;
    tx.rollback().await.map_err(ApiError::internal)?;
    rows
}

async fn read_box<F, Fut>(
    conn: &mut SqliteConnection,
    id: &str,
    mut after_query: F,
) -> Result<Option<BoxReportRows>, ApiError>
where
    F: FnMut(&'static str) -> Fut,
    Fut: Future<Output = ()>,
{
    let found: Option<BoxRow> = sqlx::query_as(BOX_SQL)
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    after_query("box").await;
    let Some(found) = found else {
        return Ok(None);
    };
    let (name, inn): (String, Option<String>) = sqlx::query_as(ORGANIZATION_SQL)
        .fetch_one(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    after_query("organization").await;
    let items: Vec<(String, String, String)> = sqlx::query_as(BOX_ITEMS_SQL)
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    after_query("items").await;
    Ok(Some(BoxReportRows {
        id: found.id,
        shift_id: found.shift_id,
        sscc: found.sscc,
        opened_at: found.opened_at,
        closed_at: found.closed_at,
        disassembled_at: found.disassembled_at,
        product_name: found.product_name,
        organization: ExportOrganization { name, inn },
        items: items
            .into_iter()
            .map(|(gtin14, serial, canonical)| BoxReportItem {
                gtin14,
                serial,
                canonical,
            })
            .collect(),
    }))
}
