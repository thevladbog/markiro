//! The immutable assembly journal used to review a shift and prepare its exports.

use axum::{extract::State, Json};
use markiro_proto::{OfficeSet, SetAssembledFact};

use crate::auth::OfficeContext;
use crate::error::{ApiError, ApiPath};
use crate::server::AppState;

pub async fn list_sets(
    State(state): State<AppState>,
    _context: OfficeContext,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<Vec<OfficeSet>>, ApiError> {
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM shifts WHERE id = ?)")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if !exists {
        return Err(ApiError::not_found("no such shift"));
    }
    type Row = (String, String, Option<String>, String, String);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT record_id, device_id, operator_id, data, outcome FROM set_assemblies          WHERE shift_id = ? ORDER BY assembled_at, device_id, record_id",
    )
    .bind(&id)
    .fetch_all(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    rows.into_iter()
        .map(|(id, device_id, operator_id, data, outcome)| {
            Ok(OfficeSet {
                id,
                device_id,
                operator_id,
                assembly: serde_json::from_str::<SetAssembledFact>(&data)
                    .map_err(ApiError::internal)?,
                outcome: outcome.parse().map_err(ApiError::internal)?,
            })
        })
        .collect::<Result<_, _>>()
        .map(Json)
}
