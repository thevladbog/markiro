//! Administrator extraction precedes buffering and all body errors are sanitized.

use crate::cloud_history::conflict;
use crate::{
    audit::{self, actions, Entry, Outcome},
    auth::OfficeContext,
    cloud_history as history,
    db::{begin_write, commit_with_revision, next_revision},
    error::ApiError,
    server::AppState,
};
use axum::{
    extract::{FromRequest, FromRequestParts, Request, State},
    Json,
};
use markiro_proto::cloud_history::*;
use serde::de::DeserializeOwned;
use serde_json::json;
use sqlx::SqliteConnection;

async fn was_cancelled(conn: &mut SqliteConnection, batch: &str) -> Result<bool, ApiError> {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM audit_log WHERE action=? AND target_id=? AND result='ok')",
    )
    .bind(actions::IMPORT_CLOUD_HISTORY_CANCEL)
    .bind(batch)
    .fetch_one(conn)
    .await
    .map_err(ApiError::internal)
}

async fn advance_counters(conn: &mut SqliteConnection, rev: i64) -> Result<(), ApiError> {
    // Source numbers have been parsed strictly before staging. The SQL keeps row-sized memory.
    sqlx::query("INSERT INTO shift_number_counters(month_key,last_seq) SELECT month_key,MAX(seq) FROM (SELECT json_extract(source_json,'$.numberMonthKey') AS month_key,CAST(json_extract(source_json,'$.numberSeq') AS INTEGER) AS seq FROM cloud_history_shifts UNION ALL SELECT substr(number,1,5),CAST(substr(number,7) AS INTEGER) FROM cloud_history_owners) GROUP BY month_key ON CONFLICT(month_key) DO UPDATE SET last_seq=excluded.last_seq WHERE excluded.last_seq>shift_number_counters.last_seq")
        .execute(&mut *conn).await.map_err(ApiError::internal)?;
    let counters: Vec<(String, i64)> =
        sqlx::query_as("SELECT issuer_prefix,extension FROM sscc_counters")
            .fetch_all(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    for (prefix, extension) in counters {
        if !(4..=12).contains(&prefix.len())
            || !prefix.bytes().all(|b| b.is_ascii_digit())
            || !(0..=9).contains(&extension)
        {
            return Err(conflict("history_counter"));
        }
        let maximum:Option<i64>=sqlx::query_scalar("SELECT MAX(CAST(substr(sscc,?1+2,16-?1) AS INTEGER)) FROM (SELECT sscc FROM cloud_history_boxes UNION ALL SELECT sscc FROM cloud_history_pallets) WHERE substr(sscc,1,1)=?2 AND substr(sscc,2,?1)=?3")
            .bind(prefix.len() as i64).bind(extension.to_string()).bind(&prefix).fetch_one(&mut *conn).await.map_err(ApiError::internal)?;
        if let Some(maximum) = maximum {
            let next = maximum
                .checked_add(1)
                .ok_or_else(|| conflict("history_counter_overflow"))?;
            if next < 0 || next as u64 > crate::validate::serial_capacity(&prefix) {
                return Err(conflict("history_counter_overflow"));
            }
            sqlx::query("UPDATE sscc_counters SET next_serial=?,rev=? WHERE issuer_prefix=? AND extension=? AND next_serial<?")
                .bind(next).bind(rev).bind(&prefix).bind(extension).bind(next).execute(&mut *conn).await.map_err(ApiError::internal)?;
        }
    }
    Ok(())
}

pub async fn cancel(
    State(state): State<AppState>,
    AdminBody { context, body: r }: AdminBody<CloudHistoryCompleteRequest>,
) -> Result<Json<()>, ApiError> {
    if !history::validation::checksum_shape(&r.batch_id) {
        return Err(ApiError::validation("batchId", "invalid history batch"));
    }
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    if was_cancelled(&mut tx, &r.batch_id).await? {
        return Ok(Json(()));
    }
    let current = history::state(&mut tx)
        .await?
        .ok_or_else(|| history::conflict("history_missing"))?;
    if current.batch_id != r.batch_id {
        return Err(history::conflict("history_batch_changed"));
    }
    if current.status != CloudHistoryStatus::Pending {
        return Err(history::conflict("history_already_complete"));
    }
    for table in [
        "cloud_history_owners",
        "cloud_history_items",
        "cloud_history_codes",
        "cloud_history_boxes",
        "cloud_history_pallets",
        "cloud_history_shifts",
        "cloud_history_parts",
        "cloud_history_batches",
    ] {
        let key = if table == "cloud_history_batches" {
            "id"
        } else {
            "batch_id"
        };
        sqlx::query(&format!("DELETE FROM {table} WHERE {key}=?"))
            .bind(&r.batch_id)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    }
    let at = state.timestamp();
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    audit::record(&mut tx,&at,Entry{actor:context.actor(),action:actions::IMPORT_CLOUD_HISTORY_CANCEL,target_type:Some("cloud_history"),target_id:Some(&r.batch_id),outcome:Outcome::Ok,
        details:json!({"sourceTenantId":current.source.tenant_id,"receivedParts":current.received_indices.len(),"counts":current.counts})}).await.map_err(ApiError::internal)?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(()))
}
pub struct AdminBody<T> {
    context: OfficeContext,
    body: T,
}
impl<T: DeserializeOwned + Send> FromRequest<AppState> for AdminBody<T> {
    type Rejection = ApiError;
    async fn from_request(request: Request, state: &AppState) -> Result<Self, ApiError> {
        let (mut parts, body) = request.into_parts();
        let context = OfficeContext::from_request_parts(&mut parts, state).await?;
        context.require_admin()?;
        let Json(body) = Json::<T>::from_request(Request::from_parts(parts, body), state)
            .await
            .map_err(|_| ApiError::malformed("invalid or oversized cloud history request"))?;
        Ok(Self { context, body })
    }
}
pub async fn get(
    State(state): State<AppState>,
    context: OfficeContext,
) -> Result<Json<Option<CloudHistoryImportState>>, ApiError> {
    context.require_admin()?;
    // Hold one snapshot across manifest, status and receipt reads; cancellation may
    // delete the batch concurrently but cannot tear this response.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let result = history::state(&mut tx).await?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(result))
}
pub async fn import(
    State(state): State<AppState>,
    AdminBody { context, body: r }: AdminBody<CloudHistoryImportRequest>,
) -> Result<Json<CloudHistoryImportState>, ApiError> {
    history::validation::check(&r)?;
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    if was_cancelled(&mut tx, &r.manifest.checksum).await? {
        return Err(history::conflict("history_cancelled"));
    }
    if let Some(m) = history::manifest(&mut tx).await? {
        if m != r.manifest {
            return Err(history::conflict("history_batch_changed"));
        }
        let accepted: Option<String> = sqlx::query_scalar(
            "SELECT checksum FROM cloud_history_parts WHERE batch_id=? AND part_index=?",
        )
        .bind(&m.checksum)
        .bind(i64::from(r.part.index))
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
        if let Some(checksum) = accepted {
            if checksum != r.part.checksum {
                return Err(history::conflict("history_part_changed"));
            }
            return Ok(Json(
                history::state(&mut tx)
                    .await?
                    .ok_or_else(|| ApiError::internal("missing history state"))?,
            ));
        }
    }
    history::require_site(&mut tx, &r.manifest).await?;
    let at = state.timestamp();
    // Staging on the transaction also validates duplicate identities for dry runs.
    history::stage(&mut tx, &r, &at).await?;
    let result = history::state(&mut tx)
        .await?
        .ok_or_else(|| ApiError::internal("missing history state"))?;
    if r.dry_run {
        tx.rollback().await.map_err(ApiError::internal)?;
        return Ok(Json(result));
    }
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    audit::record(&mut tx,&at,Entry{actor:context.actor(),action:actions::IMPORT_CLOUD_HISTORY_PART,target_type:Some("cloud_history"),target_id:Some(&r.manifest.checksum),outcome:Outcome::Ok,
        details:json!({"sourceTenantId":r.manifest.source.tenant_id,"partIndex":r.part.index,"counts":r.part.payload.counts()})}).await.map_err(ApiError::internal)?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(result))
}
pub async fn complete(
    State(state): State<AppState>,
    AdminBody { context, body: r }: AdminBody<CloudHistoryCompleteRequest>,
) -> Result<Json<CloudHistoryImportState>, ApiError> {
    if !history::validation::checksum_shape(&r.batch_id) {
        return Err(ApiError::validation("batchId", "invalid history batch"));
    }
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let m = history::manifest(&mut tx)
        .await?
        .ok_or_else(|| history::conflict("history_missing"))?;
    if m.checksum != r.batch_id {
        return Err(history::conflict("history_batch_changed"));
    }
    let current = history::state(&mut tx)
        .await?
        .ok_or_else(|| ApiError::internal("missing history state"))?;
    if current.status == CloudHistoryStatus::Complete {
        return Ok(Json(current));
    }
    history::require_site(&mut tx, &m).await?;
    if current.received_indices.len() != m.parts.len() || current.counts != m.counts {
        return Err(history::conflict("history_incomplete"));
    }
    history::validate_graph(&mut tx, &m).await?;
    let at = state.timestamp();
    sqlx::query("UPDATE cloud_history_batches SET status='complete',completed_at=? WHERE id=?")
        .bind(&at)
        .bind(&r.batch_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    advance_counters(&mut tx, rev).await?;
    audit::record(&mut tx,&at,Entry{actor:context.actor(),action:actions::IMPORT_CLOUD_HISTORY_COMPLETE,target_type:Some("cloud_history"),target_id:Some(&r.batch_id),outcome:Outcome::Ok,
        details:json!({"sourceTenantId":m.source.tenant_id,"totalParts":m.parts.len(),"counts":m.counts})}).await.map_err(ApiError::internal)?;
    commit_with_revision(tx, &state.revisions, rev)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(CloudHistoryImportState {
        status: CloudHistoryStatus::Complete,
        ..current
    }))
}
