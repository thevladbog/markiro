//! The catalog (spec §4.3). `GET /v1/office/product-groups` lists the ЧЗ
//! product groups: the cloud's static lookup, read by every office role and
//! written by nobody.

use axum::extract::State;
use axum::Json;
use markiro_proto::ProductGroup;

use crate::auth::OfficeContext;
use crate::error::ApiError;
use crate::server::AppState;

/// `GET /v1/office/product-groups`: every group, by code.
pub async fn list_product_groups(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<Vec<ProductGroup>>, ApiError> {
    let rows: Vec<(u32, String, String)> =
        sqlx::query_as("SELECT code, alias, name FROM chz_product_groups ORDER BY code")
            .fetch_all(&state.pool)
            .await
            .map_err(ApiError::internal)?;
    Ok(Json(
        rows.into_iter()
            .map(|(code, alias, name)| ProductGroup { code, alias, name })
            .collect(),
    ))
}
