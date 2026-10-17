use crate::{
    auth::OfficeContext,
    cloud_history::read,
    error::{ApiError, ApiPath, ApiQuery},
    server::AppState,
};
use axum::{extract::State, Json};
use markiro_proto::cloud_history::{CloudShiftCard, CloudShiftPage};
use markiro_proto::ShiftExportRows;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListQuery {
    page: Option<u32>,
    product_id: Option<String>,
    mode: Option<String>,
    from: Option<String>,
    to: Option<String>,
}

pub async fn list(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiQuery(q): ApiQuery<ListQuery>,
) -> Result<Json<CloudShiftPage>, ApiError> {
    let page = q.page.unwrap_or(1);
    if !(1..=100_000).contains(&page) {
        return Err(ApiError::validation("page", "1-100000"));
    }
    if let Some(id) = &q.product_id {
        crate::validate::client_uuid("productId", id)?;
    }
    if q.mode
        .as_deref()
        .is_some_and(|v| v != "aggregation" && v != "validation")
    {
        return Err(ApiError::validation("mode", "aggregation or validation"));
    }
    for (key, value) in [("from", &q.from), ("to", &q.to)] {
        if let Some(value) = value {
            crate::validate::civil_date(key, value)?;
        }
    }
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let filter="FROM cloud_history_shifts s JOIN cloud_history_batches b ON b.id=s.batch_id AND b.status='complete' WHERE s.in_window=1 AND (?1 IS NULL OR s.product_id=?1) AND (?2 IS NULL OR s.mode=?2) AND (?3 IS NULL OR s.production_date>=?3) AND (?4 IS NULL OR s.production_date<=?4)";
    let total: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) {filter}"))
        .bind(&q.product_id)
        .bind(&q.mode)
        .bind(&q.from)
        .bind(&q.to)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let ids: Vec<String> = sqlx::query_scalar(&format!(
        "SELECT s.id {filter} ORDER BY s.closed_at DESC,s.id DESC LIMIT 50 OFFSET ?5"
    ))
    .bind(&q.product_id)
    .bind(&q.mode)
    .bind(&q.from)
    .bind(&q.to)
    .bind(i64::from(page - 1) * 50)
    .fetch_all(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let mut items = Vec::with_capacity(ids.len());
    for id in ids {
        items.push(
            read::card(&mut tx, &id)
                .await?
                .ok_or_else(|| ApiError::internal("missing snapshot shift"))?,
        );
    }
    tx.rollback().await.map_err(ApiError::internal)?;
    Ok(Json(CloudShiftPage {
        items,
        total: total as u64,
        page,
        page_count: (total as u64).div_ceil(50).max(1),
    }))
}

pub async fn detail(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<CloudShiftCard>, ApiError> {
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let result = read::card(&mut tx, &id).await?;
    tx.rollback().await.map_err(ApiError::internal)?;
    result
        .map(Json)
        .ok_or_else(|| ApiError::not_found("no such cloud shift"))
}
pub async fn export_source(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<ShiftExportRows>, ApiError> {
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let result = read::export_rows(&mut tx, &id).await?;
    tx.rollback().await.map_err(ApiError::internal)?;
    result
        .map(Json)
        .ok_or_else(|| ApiError::not_found("no such cloud shift"))
}

macro_rules! snapshot_route {
    ($name:ident,$wire:ty,$reader:ident,$message:literal) => {
        pub async fn $name(
            State(state): State<AppState>,
            _context: OfficeContext,
            ApiPath(id): ApiPath<String>,
        ) -> Result<Json<$wire>, ApiError> {
            let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
            let result = read::$reader(&mut tx, &id).await?;
            tx.rollback().await.map_err(ApiError::internal)?;
            result
                .map(Json)
                .ok_or_else(|| ApiError::not_found($message))
        }
    };
}
snapshot_route!(
    pallet,
    markiro_proto::cloud_history::CloudPalletRows,
    pallet_rows,
    "no such cloud pallet"
);
snapshot_route!(
    box_report,
    markiro_proto::BoxReportRows,
    box_report,
    "no such cloud box"
);
pub async fn boxes(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<Vec<markiro_proto::cloud_history::CloudBoxCard>>, ApiError> {
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    read::shift(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such cloud shift"))?;
    let rows = read::box_cards(&mut tx, read::BoxCardScope::Shift(&id)).await?;
    tx.rollback().await.map_err(ApiError::internal)?;
    Ok(Json(rows))
}
pub async fn box_card(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<markiro_proto::cloud_history::CloudBoxCard>, ApiError> {
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let row = read::box_cards(&mut tx, read::BoxCardScope::Box(&id))
        .await?
        .pop();
    tx.rollback().await.map_err(ApiError::internal)?;
    row.map(Json)
        .ok_or_else(|| ApiError::not_found("no such cloud box"))
}
pub async fn pallets(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<Vec<markiro_proto::cloud_history::CloudPalletRows>>, ApiError> {
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    read::shift(&mut tx, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("no such cloud shift"))?;
    let ids:Vec<String>=sqlx::query_scalar("SELECT p.id FROM cloud_history_pallets p JOIN cloud_history_batches b ON b.id=p.batch_id AND b.status='complete' WHERE p.shift_id=? ORDER BY p.opened_at,p.id").bind(&id).fetch_all(&mut *tx).await.map_err(ApiError::internal)?;
    let mut rows = Vec::new();
    for id in ids {
        rows.push(
            read::pallet_rows(&mut tx, &id)
                .await?
                .ok_or_else(|| ApiError::internal("missing snapshot pallet"))?,
        );
    }
    tx.rollback().await.map_err(ApiError::internal)?;
    Ok(Json(rows))
}
