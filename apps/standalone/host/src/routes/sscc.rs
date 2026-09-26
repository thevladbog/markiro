//! SSCC counters and block sizes: `GET /v1/office/sscc` (every role);
//! `PUT …/counters/{prefix}/{extension}` and `PUT …/block-sizes`
//! (administrators). Counters only move forward (spec §4.3); the checks for
//! active shifts and issued blocks join with the blocks in plan 2a.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use markiro_proto::{codes, BlockSizesUpdate, SsccCounter, SsccCounterUpdate, SsccState};
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, Entry, Outcome};
use crate::auth::OfficeContext;
use crate::db::{begin_write, next_revision};
use crate::error::{ApiError, ApiJson, ApiPath};
use crate::server::AppState;
use crate::validate;

fn counter(
    issuer_prefix: String,
    extension: i64,
    next_serial: i64,
    rev: i64,
) -> Result<SsccCounter, ApiError> {
    let max_serial = validate::serial_capacity(&issuer_prefix) - 1;
    Ok(SsccCounter {
        issuer_prefix,
        extension: u8::try_from(extension).map_err(ApiError::internal)?,
        next_serial: u64::try_from(next_serial).map_err(ApiError::internal)?,
        max_serial,
        rev,
    })
}

/// Read the counters, block sizes and current issuer prefix through `conn`.
/// Both callers pass an open transaction: `get_sscc` a plain deferred read
/// transaction (one consistent WAL snapshot for all three queries below) and
/// `put_block_sizes` its write transaction (so the response reflects exactly
/// what it just wrote, read before the commit releases the write lock,
/// without a second connection from `state.pool`).
async fn read_state(conn: &mut SqliteConnection) -> Result<SsccState, ApiError> {
    let rows: Vec<(String, i64, i64, i64)> = sqlx::query_as(
        "SELECT issuer_prefix, extension, next_serial, rev FROM sscc_counters ORDER BY issuer_prefix, extension",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let (box_block_size, pallet_block_size, block_sizes_rev): (i64, i64, i64) =
        sqlx::query_as("SELECT box_block_size, pallet_block_size, rev FROM site WHERE id = 1")
            .fetch_one(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    // Same defensive pattern as `read_org` (routes/org.rs): office routes
    // only ever run after the wizard has created `org_profile`, but a
    // missing row becomes `not_found`, not a 500, if that invariant is ever
    // violated.
    let gln: Option<String> = sqlx::query_scalar("SELECT gln FROM org_profile WHERE id = 1")
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    let gln = gln.ok_or_else(|| ApiError::not_found("the host is not initialized"))?;
    Ok(SsccState {
        counters: rows
            .into_iter()
            .map(|(prefix, extension, next, rev)| counter(prefix, extension, next, rev))
            .collect::<Result<_, _>>()?,
        box_block_size: u32::try_from(box_block_size).map_err(ApiError::internal)?,
        pallet_block_size: u32::try_from(pallet_block_size).map_err(ApiError::internal)?,
        current_issuer_prefix: validate::issuer_prefix(&gln).to_owned(),
        block_sizes_rev,
    })
}

pub async fn get_sscc(
    State(state): State<AppState>,
    _context: OfficeContext,
) -> Result<Json<SsccState>, ApiError> {
    // A plain deferred transaction (`BEGIN`, not `BEGIN IMMEDIATE`) gives the
    // three reads inside `read_state` one consistent WAL snapshot. Without
    // it, each read runs as its own implicit transaction on the pooled
    // connection, so a write landing between them — a GLN change, say —
    // could report a `currentIssuerPrefix` whose counters are missing from
    // the counter list. Nothing here writes, so the transaction is rolled
    // back rather than committed.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let snapshot = read_state(&mut tx).await;
    tx.rollback().await.map_err(ApiError::internal)?;
    snapshot.map(Json)
}

pub async fn put_counter(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiPath((prefix, extension)): ApiPath<(String, u8)>,
    ApiJson(update): ApiJson<SsccCounterUpdate>,
) -> Result<Json<SsccCounter>, ApiError> {
    context.require_admin()?;
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let row: Option<(i64, i64)> = sqlx::query_as(
        "SELECT next_serial, rev FROM sscc_counters WHERE issuer_prefix = ? AND extension = ?",
    )
    .bind(&prefix)
    .bind(i64::from(extension))
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let (current, rev) = row.ok_or_else(|| ApiError::not_found("no such SSCC counter"))?;
    if rev != update.expected_rev {
        return Err(ApiError::stale_revision(rev));
    }
    let current = u64::try_from(current).map_err(ApiError::internal)?;
    if update.next_serial == current {
        // Nothing actually changed: report the counter as-is without bumping
        // the revision, writing a row nobody changed, or auditing a no-op.
        return counter(
            prefix,
            i64::from(extension),
            i64::try_from(current).map_err(ApiError::internal)?,
            rev,
        )
        .map(Json);
    }
    if update.next_serial < current {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            codes::SSCC_BELOW_FLOOR,
            "an SSCC counter only moves forward",
        )
        .with_details(json!({ "minSerial": current })));
    }
    validate::sscc_serial("nextSerial", extension, &prefix, update.next_serial)?;
    let new_rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE sscc_counters SET next_serial = ?, rev = ? WHERE issuer_prefix = ? AND extension = ?",
    )
    .bind(i64::try_from(update.next_serial).map_err(ApiError::internal)?)
    .bind(new_rev)
    .bind(&prefix)
    .bind(i64::from(extension))
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let target = format!("{prefix}/{extension}");
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: "sscc.counter.update",
            target_type: Some("sscc_counter"),
            target_id: Some(&target),
            outcome: Outcome::Ok,
            details: json!({ "from": current, "to": update.next_serial }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    counter(
        prefix,
        i64::from(extension),
        i64::try_from(update.next_serial).map_err(ApiError::internal)?,
        new_rev,
    )
    .map(Json)
}

pub async fn put_block_sizes(
    State(state): State<AppState>,
    context: OfficeContext,
    ApiJson(update): ApiJson<BlockSizesUpdate>,
) -> Result<Json<SsccState>, ApiError> {
    context.require_admin()?;
    if !(1..=100_000).contains(&update.box_block_size) {
        return Err(ApiError::validation(
            "boxBlockSize",
            "1-100000 serials per block",
        ));
    }
    if !(1..=10_000).contains(&update.pallet_block_size) {
        return Err(ApiError::validation(
            "palletBlockSize",
            "1-10000 serials per block",
        ));
    }
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    context.require_admin_in(&mut tx).await?;
    let (current_box, current_pallet, rev): (i64, i64, i64) =
        sqlx::query_as("SELECT box_block_size, pallet_block_size, rev FROM site WHERE id = 1")
            .fetch_one(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    if rev != update.expected_rev {
        return Err(ApiError::stale_revision(rev));
    }
    if i64::from(update.box_block_size) == current_box
        && i64::from(update.pallet_block_size) == current_pallet
    {
        // Nothing actually changed: report state as-is without bumping the
        // revision, writing a row nobody changed, or auditing a no-op. Read
        // through the still-open transaction, then let it roll back on drop:
        // taking a second pooled connection here (pool size 4) could wait
        // behind another writer's busy_timeout instead of returning at once.
        let unchanged = read_state(&mut tx).await?;
        return Ok(Json(unchanged));
    }
    let new_rev = next_revision(&mut tx).await.map_err(ApiError::internal)?;
    sqlx::query("UPDATE site SET box_block_size = ?, pallet_block_size = ?, rev = ? WHERE id = 1")
        .bind(i64::from(update.box_block_size))
        .bind(i64::from(update.pallet_block_size))
        .bind(new_rev)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    audit::record(
        &mut tx,
        &at,
        Entry {
            actor: context.actor(),
            action: "sscc.block_sizes.update",
            target_type: Some("site"),
            target_id: Some("1"),
            outcome: Outcome::Ok,
            details: json!({
                "boxBlockSize": update.box_block_size,
                "palletBlockSize": update.pallet_block_size,
            }),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    // Read the just-written state through the same transaction, before the
    // commit below releases the write lock: reading afterward on a fresh
    // pooled connection could race a later writer and return state this
    // request never wrote.
    let updated = read_state(&mut tx).await?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(updated))
}
