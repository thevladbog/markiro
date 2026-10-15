//! `GET /v1/office/warehouse-pallets`: the pallets handhelds built outside shifts (plan ТСД-Х,
//! task Х5, decision В-6): open ones first, then closed newest first, the latest 200. A list only:
//! no card, no export, no disassembly (the parity wave of the office).

use axum::extract::State;
use axum::Json;
use markiro_proto::{OfficeWarehousePallet, OfficeWarehousePallets};

use crate::auth::OfficeContext;
use crate::error::ApiError;
use crate::server::AppState;

const LIMIT: i64 = 200;

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    device_id: String,
    device_name: String,
    product_id: String,
    product_name: String,
    opened_at: String,
    closed_at: Option<String>,
    sscc: Option<String>,
    box_count_reported: Option<i64>,
    boxes: i64,
}

pub async fn list(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<OfficeWarehousePallets>, ApiError> {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT wp.id AS id, wp.device_id AS device_id, d.name AS device_name, \
         wp.product_id AS product_id, pr.name AS product_name, wp.opened_at AS opened_at, \
         wp.closed_at AS closed_at, wp.sscc AS sscc, wp.box_count_reported AS box_count_reported, \
         (SELECT COUNT(*) FROM warehouse_pallet_boxes wb \
          WHERE wb.pallet_id = wp.id AND wb.removed_at IS NULL) AS boxes \
         FROM warehouse_pallets wp JOIN devices d ON d.id = wp.device_id \
         JOIN products pr ON pr.id = wp.product_id \
         ORDER BY ifnull(wp.closed_at, '~') DESC, wp.id DESC LIMIT ?",
    )
    .bind(LIMIT)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    Ok(Json(OfficeWarehousePallets {
        pallets: rows
            .into_iter()
            .map(|row| OfficeWarehousePallet {
                id: row.id,
                device_id: row.device_id,
                device_name: row.device_name,
                product_id: row.product_id,
                product_name: row.product_name,
                opened_at: row.opened_at,
                closed_at: row.closed_at,
                sscc: row.sscc,
                boxes: u32::try_from(row.boxes).unwrap_or(0),
                box_count_reported: row
                    .box_count_reported
                    .and_then(|count| u32::try_from(count).ok()),
            })
            .collect(),
    }))
}
