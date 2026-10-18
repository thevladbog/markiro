//! The data of a shift's printed forms (plan О-Ф): `GET
//! /v1/office/boxes/{id}/report-data` and `GET
//! /v1/office/shifts/{id}/pallet-report-data`, every office role. The host
//! only reads: the office maps these rows to the cloud's form inputs and renders
//! the forms with `@markiro/domain`. One read transaction gives every row
//! one snapshot, and each query searches by an index, never through every
//! fact of the host.

use std::future::Future;

use axum::extract::State;
use axum::Json;
use markiro_proto::{
    BoxReportItem, BoxReportRows, ExportOrganization, PalletReportRows, ReportPallet,
    ReportPalletBox, ReportShift,
};
use sqlx::{SqliteConnection, SqlitePool};

use crate::auth::OfficeContext;
use crate::error::{ApiError, ApiPath};
use crate::routes::office_exports::ORGANIZATION_SQL;
use crate::server::AppState;
use crate::shifts;

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
        product_name: Some(found.product_name),
        organization: ExportOrganization {
            name,
            inn,
            time_zone: None,
        },
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

/// The shift with its product now.
pub const PALLET_SHIFT_SQL: &str = "SELECT s.id, s.number_month_key, s.number_seq, \
     s.created_from, s.production_date, p.name AS product_name, p.gtin14, p.shelf_life_days \
     FROM shifts s JOIN products p ON p.id = s.product_id WHERE s.id = ?";

/// Every pallet of the shift, opened first first.
pub const PALLETS_SQL: &str = "SELECT id, sscc, opened_at, closed_at, disassembled_at \
     FROM pallets WHERE shift_id = ? ORDER BY opened_at, id";

/// Every box of the shift that stood on a pallet, closed first first on each
/// pallet (the cloud's `closed_at, id`), with its live items through
/// `box_items_live`.
pub const PALLET_BOXES_SQL: &str = "SELECT b.pallet_id, b.id, b.sscc, b.closed_at, \
     b.disassembled_at, \
     (SELECT COUNT(*) FROM box_items i WHERE i.box_id = b.id \
      AND i.removed_at IS NULL AND i.displaced_at IS NULL) AS units \
     FROM boxes b WHERE b.shift_id = ? AND b.pallet_id IS NOT NULL \
     ORDER BY b.pallet_id, b.closed_at, b.id";

#[derive(sqlx::FromRow)]
struct ShiftRow {
    id: String,
    number_month_key: String,
    number_seq: i64,
    created_from: String,
    production_date: String,
    product_name: String,
    gtin14: String,
    shelf_life_days: Option<u32>,
}

#[derive(sqlx::FromRow)]
struct PalletRow {
    id: String,
    sscc: Option<String>,
    opened_at: String,
    closed_at: Option<String>,
    disassembled_at: Option<String>,
}

#[derive(sqlx::FromRow)]
struct PalletBoxRow {
    pallet_id: String,
    id: String,
    sscc: Option<String>,
    closed_at: String,
    disassembled_at: Option<String>,
    units: i64,
}

/// `GET /v1/office/shifts/{id}/pallet-report-data`: an unknown shift is
/// `not_found`; a shift without pallets answers with none.
pub async fn pallet_report(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<PalletReportRows>, ApiError> {
    read_pallet_rows(&state.pool, &id, |_| async {})
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("no such shift"))
}

/// The four reads of a shift's pallet forms in one plain deferred
/// transaction, as [`read_box_rows`]: nothing here writes, so it is rolled
/// back, and the reads share one WAL snapshot. `after_query` is called with
/// the name of each query just read (`shift`, `organization`, `pallets`,
/// `boxes`); the route passes a closure that does nothing, a test writes
/// from another connection there to prove that no write lands in the answer.
pub async fn read_pallet_rows<F, Fut>(
    pool: &SqlitePool,
    id: &str,
    after_query: F,
) -> Result<Option<PalletReportRows>, ApiError>
where
    F: FnMut(&'static str) -> Fut,
    Fut: Future<Output = ()>,
{
    let mut tx = pool.begin().await.map_err(ApiError::internal)?;
    let rows = read_pallets(&mut tx, id, after_query).await;
    tx.rollback().await.map_err(ApiError::internal)?;
    rows
}

async fn read_pallets<F, Fut>(
    conn: &mut SqliteConnection,
    id: &str,
    mut after_query: F,
) -> Result<Option<PalletReportRows>, ApiError>
where
    F: FnMut(&'static str) -> Fut,
    Fut: Future<Output = ()>,
{
    let shift: Option<ShiftRow> = sqlx::query_as(PALLET_SHIFT_SQL)
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
    let pallets: Vec<PalletRow> = sqlx::query_as(PALLETS_SQL)
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    after_query("pallets").await;
    let boxes: Vec<PalletBoxRow> = sqlx::query_as(PALLET_BOXES_SQL)
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    after_query("boxes").await;
    let mut on_pallets: std::collections::HashMap<String, Vec<ReportPalletBox>> =
        std::collections::HashMap::new();
    for row in boxes {
        on_pallets
            .entry(row.pallet_id)
            .or_default()
            .push(ReportPalletBox {
                id: row.id,
                sscc: row.sscc,
                closed_at: row.closed_at,
                disassembled_at: row.disassembled_at,
                units: u32::try_from(row.units).map_err(ApiError::internal)?,
            });
    }
    let created_from = shift.created_from.parse().map_err(ApiError::internal)?;
    Ok(Some(PalletReportRows {
        shift: ReportShift {
            number: shifts::format_number(&shift.number_month_key, shift.number_seq, created_from),
            id: shift.id,
            production_date: shift.production_date,
            product_name: shift.product_name,
            gtin14: shift.gtin14,
            shelf_life_days: shift.shelf_life_days,
        },
        organization: ExportOrganization {
            name,
            inn,
            time_zone: None,
        },
        pallets: pallets
            .into_iter()
            .map(|row| ReportPallet {
                boxes: on_pallets.remove(&row.id).unwrap_or_default(),
                id: row.id,
                sscc: row.sscc,
                opened_at: row.opened_at,
                closed_at: row.closed_at,
                disassembled_at: row.disassembled_at,
            })
            .collect(),
    }))
}
