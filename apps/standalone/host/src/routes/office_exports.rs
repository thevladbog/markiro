//! The data of a shift's exports (plan ЧЗ): `GET
//! /v1/office/shifts/{id}/export-source`, every office role. The host only
//! reads: the office ports the cloud's source rules and its completeness
//! checks over these rows and renders the files with `@markiro/domain`. One
//! read transaction gives every row one snapshot, as the cloud's export reads
//! in one repeatable-read transaction; each query searches by an index of
//! `0010` or `0012`, never through every fact of the host.

use std::future::Future;

use axum::extract::State;
use axum::Json;
use markiro_proto::{
    ExportBox, ExportCode, ExportItem, ExportOrganization, ExportPallet, ExportShift,
    ShiftExportRows,
};
use sqlx::{SqliteConnection, SqlitePool};

use crate::auth::OfficeContext;
use crate::error::{ApiError, ApiPath};
use crate::server::AppState;
use crate::shifts;

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
