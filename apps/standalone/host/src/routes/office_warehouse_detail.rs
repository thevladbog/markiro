//! Bounded, consistent warehouse card and document source. Historic membership stays visible.
use crate::{
    auth::OfficeContext,
    error::{ApiError, ApiPath},
    server::AppState,
    shifts,
};
use axum::{extract::State, Json};
use markiro_proto::{
    OfficeWarehousePalletDetail, OfficeWarehousePalletMember, OfficeWarehousePalletOrganization,
    ShiftOrigin,
};

#[derive(sqlx::FromRow)]
struct PalletRow {
    id: String,
    sscc: Option<String>,
    source: String,
    demo: bool,
    created_by_name: Option<String>,
    device_name: String,
    product_id: String,
    product_name: String,
    gtin14: String,
    shelf_life_days: Option<u32>,
    opened_at: String,
    closed_at: Option<String>,
    disassembled_at: Option<String>,
}
#[derive(sqlx::FromRow)]
struct MemberRow {
    membership_id: String,
    id: String,
    sscc: String,
    shift_id: String,
    number_month_key: String,
    number_seq: i64,
    created_from: String,
    production_date: String,
    units: u32,
    disassembled_at: Option<String>,
    removed_at: Option<String>,
}

pub async fn get(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<OfficeWarehousePalletDetail>, ApiError> {
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let row: Option<PalletRow> = sqlx::query_as("SELECT wp.id, wp.sscc, wp.source, p.demo, u.name AS created_by_name, d.name AS device_name, wp.product_id, p.name AS product_name, wp.gtin14, p.shelf_life_days, wp.opened_at, wp.closed_at, wp.disassembled_at FROM warehouse_pallets wp JOIN devices d ON d.id=wp.device_id JOIN products p ON p.id=wp.product_id LEFT JOIN office_users u ON u.id=wp.created_by_user_id WHERE wp.id=?")
        .bind(&id).fetch_optional(&mut *tx).await.map_err(ApiError::internal)?;
    let Some(row) = row else {
        return Err(ApiError::not_found("no such warehouse pallet"));
    };
    let (name, inn, time_zone): (String, Option<String>, String) =
        sqlx::query_as("SELECT name,inn,time_zone FROM org_profile WHERE id=1")
            .fetch_one(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    // Limit every read even if a corrupt/legacy source exceeds the office's 1000-box input cap.
    let rows: Vec<MemberRow> = sqlx::query_as("SELECT CAST(wb.id AS TEXT) AS membership_id, b.id, b.sscc, b.shift_id, s.number_month_key, s.number_seq, s.created_from, s.production_date, b.disassembled_at, wb.removed_at, (SELECT COUNT(*) FROM box_items i WHERE i.box_id=b.id AND i.removed_at IS NULL AND i.displaced_at IS NULL) AS units FROM warehouse_pallet_boxes wb JOIN boxes b ON b.sscc=wb.box_sscc JOIN shifts s ON s.id=b.shift_id WHERE wb.pallet_id=? ORDER BY wb.added_at, wb.id LIMIT 10001")
        .bind(&id).fetch_all(&mut *tx).await.map_err(ApiError::internal)?;
    if rows.len() > 10_000 {
        return Err(ApiError::conflict(
            "pallet_members_limit",
            "warehouse pallet membership exceeds the card limit",
        ));
    }
    let mut members = Vec::with_capacity(rows.len());
    let (mut boxes, mut units) = (0u32, 0u32);
    for member in rows {
        if member.removed_at.is_none() && member.disassembled_at.is_none() {
            boxes += 1;
            units = units
                .checked_add(member.units)
                .ok_or_else(|| ApiError::internal("pallet unit count overflow"))?;
        }
        let origin: ShiftOrigin = member.created_from.parse().map_err(ApiError::internal)?;
        members.push(OfficeWarehousePalletMember {
            membership_id: member.membership_id,
            id: member.id,
            sscc: member.sscc,
            shift_id: member.shift_id,
            shift_number: shifts::format_number(
                &member.number_month_key,
                member.number_seq,
                origin,
            ),
            production_date: member.production_date,
            units: member.units,
            disassembled_at: member.disassembled_at,
            removed_at: member.removed_at,
        });
    }
    tx.rollback().await.map_err(ApiError::internal)?;
    Ok(Json(OfficeWarehousePalletDetail {
        id: row.id,
        sscc: row.sscc,
        source: row.source,
        demo: row.demo,
        created_by_name: row.created_by_name,
        device_name: row.device_name,
        product_id: row.product_id,
        product_name: row.product_name,
        gtin14: row.gtin14,
        shelf_life_days: row.shelf_life_days,
        opened_at: row.opened_at,
        closed_at: row.closed_at,
        disassembled_at: row.disassembled_at,
        boxes,
        units,
        organization: OfficeWarehousePalletOrganization {
            name,
            inn,
            time_zone,
        },
        members,
    }))
}
