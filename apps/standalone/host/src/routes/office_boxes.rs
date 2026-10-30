//! A shift's boxes and pallets as the office lists them (plan ЧЗ, for the
//! shift's card of plan О-Ф): `GET /v1/office/shifts/{id}/boxes` and
//! `…/pallets`, every office role. Counts are derived from the facts at the
//! moment of reading, as the cloud's pallet card derives them, and never
//! stored; each list reads in one snapshot through the indexes of `0010` and
//! `0012`.

use axum::extract::State;
use axum::Json;
use markiro_proto::{OfficeBox, OfficePallet};
use sqlx::SqliteConnection;

use crate::auth::OfficeContext;
use crate::error::{ApiError, ApiPath};
use crate::server::AppState;

/// Every box of the shift, opened first first, with its live items.
pub const BOXES_SQL: &str = "SELECT b.id, b.device_id, b.sscc, b.opened_at, b.closed_at, \
     b.disassembled_at, COALESCE(wp.id,b.pallet_id) AS pallet_id, \
     CASE WHEN wp.id IS NOT NULL THEN 'warehouse' END AS pallet_kind, \
     (SELECT COUNT(*) FROM box_items i WHERE i.box_id = b.id \
      AND i.removed_at IS NULL AND i.displaced_at IS NULL) AS units, \
     b.item_count_reported, b.digest_matches, b.print_verified_at, b.print_skipped_at, \
     op.name AS operator_name \
     FROM boxes b LEFT JOIN operators op ON op.id = b.operator_id \
     LEFT JOIN warehouse_pallet_boxes wb ON wb.box_sscc=b.sscc AND wb.removed_at IS NULL \
     LEFT JOIN warehouse_pallets wp ON wp.id=wb.pallet_id AND wp.disassembled_at IS NULL \
     WHERE b.shift_id = ? ORDER BY b.opened_at, b.id";

/// Every pallet of the shift, opened first first, with what stands on it:
/// its closed boxes not taken apart and their live items.
pub const PALLETS_SQL: &str = "SELECT p.id, p.device_id, p.sscc, p.opened_at, p.closed_at, \
     p.disassembled_at, \
     (SELECT COUNT(*) FROM boxes b WHERE b.pallet_id = p.id \
      AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL) AS boxes, \
     (SELECT COUNT(*) FROM boxes b JOIN box_items i ON i.box_id = b.id \
      AND i.removed_at IS NULL AND i.displaced_at IS NULL \
      WHERE b.pallet_id = p.id AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL) \
      AS units, \
     p.box_count_reported, p.print_verified_at, p.print_skipped_at, \
     (SELECT COUNT(*) FROM boxes b WHERE b.pallet_id = p.id \
      AND b.disassembled_at IS NOT NULL) AS disassembled_boxes \
     FROM pallets p WHERE p.shift_id = ? ORDER BY p.opened_at, p.id";

#[derive(sqlx::FromRow)]
struct BoxRow {
    id: String,
    device_id: String,
    sscc: Option<String>,
    opened_at: String,
    closed_at: Option<String>,
    disassembled_at: Option<String>,
    pallet_id: Option<String>,
    pallet_kind: Option<String>,
    units: i64,
    item_count_reported: Option<u32>,
    digest_matches: Option<bool>,
    print_verified_at: Option<String>,
    print_skipped_at: Option<String>,
    operator_name: Option<String>,
}

#[derive(sqlx::FromRow)]
struct PalletRow {
    id: String,
    device_id: String,
    sscc: Option<String>,
    opened_at: String,
    closed_at: Option<String>,
    disassembled_at: Option<String>,
    boxes: i64,
    units: i64,
    box_count_reported: Option<u32>,
    print_verified_at: Option<String>,
    print_skipped_at: Option<String>,
    disassembled_boxes: i64,
}

/// `not_found` for a shift the host does not have (also plan КНФ's review).
pub(crate) async fn require_shift(conn: &mut SqliteConnection, id: &str) -> Result<(), ApiError> {
    let found: Option<i64> = sqlx::query_scalar("SELECT 1 FROM shifts WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(ApiError::internal)?;
    found
        .map(|_| ())
        .ok_or_else(|| ApiError::not_found("no such shift"))
}

/// `GET /v1/office/shifts/{id}/boxes`: an unknown shift is `not_found`.
pub async fn list_boxes(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<Vec<OfficeBox>>, ApiError> {
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let rows = async {
        require_shift(&mut tx, &id).await?;
        sqlx::query_as::<_, BoxRow>(BOXES_SQL)
            .bind(&id)
            .fetch_all(&mut *tx)
            .await
            .map_err(ApiError::internal)
    }
    .await;
    tx.rollback().await.map_err(ApiError::internal)?;
    rows?
        .into_iter()
        .map(|row| {
            Ok(OfficeBox {
                id: row.id,
                device_id: row.device_id,
                sscc: row.sscc,
                opened_at: row.opened_at,
                closed_at: row.closed_at,
                disassembled_at: row.disassembled_at,
                pallet_id: row.pallet_id,
                pallet_kind: row.pallet_kind,
                units: u32::try_from(row.units).map_err(ApiError::internal)?,
                item_count_reported: row.item_count_reported,
                digest_matches: row.digest_matches,
                print_verified_at: row.print_verified_at,
                print_skipped_at: row.print_skipped_at,
                operator_name: row.operator_name,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()
        .map(Json)
}

/// `GET /v1/office/shifts/{id}/pallets`: an unknown shift is `not_found`.
pub async fn list_pallets(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<Vec<OfficePallet>>, ApiError> {
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let rows = async {
        require_shift(&mut tx, &id).await?;
        sqlx::query_as::<_, PalletRow>(PALLETS_SQL)
            .bind(&id)
            .fetch_all(&mut *tx)
            .await
            .map_err(ApiError::internal)
    }
    .await;
    tx.rollback().await.map_err(ApiError::internal)?;
    rows?
        .into_iter()
        .map(|row| {
            Ok(OfficePallet {
                id: row.id,
                device_id: row.device_id,
                sscc: row.sscc,
                opened_at: row.opened_at,
                closed_at: row.closed_at,
                disassembled_at: row.disassembled_at,
                boxes: u32::try_from(row.boxes).map_err(ApiError::internal)?,
                units: u64::try_from(row.units).map_err(ApiError::internal)?,
                box_count_reported: row.box_count_reported,
                disassembled_boxes: u32::try_from(row.disassembled_boxes)
                    .map_err(ApiError::internal)?,
                print_verified_at: row.print_verified_at,
                print_skipped_at: row.print_skipped_at,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()
        .map(Json)
}
