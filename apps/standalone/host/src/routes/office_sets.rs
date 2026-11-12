//! The immutable assembly journal used to review a shift and prepare its exports.

use axum::{extract::State, Json};
use markiro_proto::OfficeSet;

use crate::auth::OfficeContext;
use crate::disaggregation::sets;
use crate::error::{ApiError, ApiPath};
use crate::server::AppState;

#[derive(sqlx::FromRow)]
struct SetRow {
    record_id: String,
    device_id: String,
    operator_id: Option<String>,
    data: String,
    outcome: String,
    disassembled_at: Option<String>,
    disaggregation_document_id: Option<String>,
}

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
    let rows: Vec<SetRow> = sqlx::query_as(
        "SELECT a.record_id, a.device_id, a.operator_id, a.data, a.outcome,
                d.applied_at AS disassembled_at, d.id AS disaggregation_document_id
         FROM set_assemblies a
         LEFT JOIN set_releases r ON r.device_id = a.device_id AND r.record_id = a.record_id
         LEFT JOIN disaggregation_document_lines l ON l.id = r.line_id
         LEFT JOIN disaggregation_documents d ON d.id = l.document_id
         WHERE a.shift_id = ? ORDER BY a.assembled_at, a.device_id, a.record_id",
    )
    .bind(&id)
    .fetch_all(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    rows.into_iter()
        .map(|row| {
            Ok(OfficeSet {
                id: row.record_id,
                device_id: row.device_id,
                operator_id: row.operator_id,
                assembly: sets::read_assembly(&row.data)?,
                outcome: row.outcome.parse().map_err(ApiError::internal)?,
                disassembled_at: row.disassembled_at,
                disaggregation_document_id: row.disaggregation_document_id,
            })
        })
        .collect::<Result<_, _>>()
        .map(Json)
}
