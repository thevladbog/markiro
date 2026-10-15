//! `POST /v1/device/sscc/blocks/known` (plan РК): after `markiro-host
//! restore` (`hello` names a new `restoreEpoch`) a station sends every block
//! of SSCC serials it holds, and the host takes back the ones its copy lost,
//! so the station's boxes closed with their serials are not refused as
//! `sscc_not_issued`.
//!
//! Each block, in order, in one write transaction:
//!
//! - a block with its id is `known` when it is this station's with the same
//!   prefix, extension and serials, and `refused` `block_mismatch` otherwise;
//! - else it is `refused` `range_invalid` for an extension above 9 (the wire
//!   bounds the digit to 0-9; a byte can say more), `prefix_unknown` without
//!   a counter of its prefix and extension, `range_invalid` when its serials
//!   are no range of that prefix, and `block_overlap` when any block (of any
//!   device, revoked ones too: their serials may be printed) holds one of
//!   its serials;
//! - else it is `registered`: stored under the station with its own id as
//!   the request id, and the counter moves past it if it was below.
//!
//! One revision when anything was registered, and one
//! `sscc.block.register` audit row per registered block. The station is
//! marked as having sent its blocks for the current epoch
//! (`devices.known_blocks_epoch`) — on the last part of its run only (`more`
//! absent; plan ОЧ), which may be empty for a station that never took a block
//! (plan ХП) — which the office shows before it resumes the facts. Only a
//! station, only after a restore (`conflict` on `no_restore` before any),
//! 0 to [`MAX_BLOCKS`] blocks, none only in the last part. A part with more
//! to come registers its blocks like any other and marks nothing. The facts'
//! hold does not stop it.

use axum::extract::State;
use axum::Json;
use markiro_proto::backup::{
    known_block_codes, KnownBlock, KnownBlockOutcome, KnownBlockResult, KnownBlocksRequest,
    KnownBlocksResponse,
};
use markiro_proto::DeviceKind;
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit::{self, actions, Actor, Entry, Outcome};
use crate::auth::AuthDevice;
use crate::db::{begin_write, commit_with_revision, next_revision};
use crate::error::{ApiError, ApiJson};
use crate::server::AppState;
use crate::validate;

/// The most blocks one request may carry; a station holds one or two per
/// prefix.
pub const MAX_BLOCKS: usize = 64;

/// The largest extension digit an SSCC has. The wire schema (Zod) bounds the
/// digit to 0-9 while the Rust type is a byte, so what lies between is no
/// digit: `range_invalid`, not a counter that is merely missing.
const MAX_EXTENSION: u8 = 9;

const FORBIDDEN: &str = "only a station or a handheld registers SSCC blocks";

fn refused(id: &str, code: &str) -> KnownBlockResult {
    KnownBlockResult {
        id: id.to_owned(),
        outcome: KnownBlockOutcome::Refused,
        code: Some(code.to_owned()),
    }
}

fn result(id: &str, outcome: KnownBlockOutcome) -> KnownBlockResult {
    KnownBlockResult {
        id: id.to_owned(),
        outcome,
        code: None,
    }
}

/// The block's serials as stored, if they are a range of its prefix.
fn serials(block: &KnownBlock) -> Option<(i64, i64)> {
    let capacity = validate::serial_capacity(&block.issuer_prefix);
    if block.from_serial > block.to_serial || block.to_serial >= capacity {
        return None;
    }
    Some((
        i64::try_from(block.from_serial).ok()?,
        i64::try_from(block.to_serial).ok()?,
    ))
}

/// What becomes of one block; its serials when it is to be registered.
async fn decide(
    conn: &mut SqliteConnection,
    device_id: &str,
    block: &KnownBlock,
) -> Result<(KnownBlockResult, Option<(i64, i64)>), ApiError> {
    let stored: Option<(String, String, i64, i64, i64)> = sqlx::query_as(
        "SELECT device_id, issuer_prefix, extension, from_serial, to_serial \
         FROM sscc_blocks WHERE id = ?",
    )
    .bind(&block.id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    if let Some((device, prefix, extension, from, to)) = stored {
        let same = device == device_id
            && prefix == block.issuer_prefix
            && extension == i64::from(block.extension)
            && i64::try_from(block.from_serial) == Ok(from)
            && i64::try_from(block.to_serial) == Ok(to);
        return Ok(if same {
            (result(&block.id, KnownBlockOutcome::Known), None)
        } else {
            (refused(&block.id, known_block_codes::BLOCK_MISMATCH), None)
        });
    }
    if block.extension > MAX_EXTENSION {
        return Ok((refused(&block.id, known_block_codes::RANGE_INVALID), None));
    }
    let prefix_ok = (4..=12).contains(&block.issuer_prefix.len())
        && block
            .issuer_prefix
            .bytes()
            .all(|byte| byte.is_ascii_digit());
    let counter: Option<i64> = if prefix_ok {
        sqlx::query_scalar("SELECT 1 FROM sscc_counters WHERE issuer_prefix = ? AND extension = ?")
            .bind(&block.issuer_prefix)
            .bind(i64::from(block.extension))
            .fetch_optional(&mut *conn)
            .await
            .map_err(ApiError::internal)?
    } else {
        None
    };
    if counter.is_none() {
        return Ok((refused(&block.id, known_block_codes::PREFIX_UNKNOWN), None));
    }
    let Some((from, to)) = serials(block) else {
        return Ok((refused(&block.id, known_block_codes::RANGE_INVALID), None));
    };
    let overlapping: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM sscc_blocks WHERE issuer_prefix = ? AND extension = ? \
         AND from_serial <= ? AND to_serial >= ? LIMIT 1",
    )
    .bind(&block.issuer_prefix)
    .bind(i64::from(block.extension))
    .bind(to)
    .bind(from)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    if overlapping.is_some() {
        return Ok((refused(&block.id, known_block_codes::BLOCK_OVERLAP), None));
    }
    // The block's id becomes its request id; one the station used for
    // another block already makes it another block.
    let request_taken: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM sscc_blocks WHERE device_id = ? AND request_id = ?")
            .bind(device_id)
            .bind(&block.id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
    if request_taken.is_some() {
        return Ok((refused(&block.id, known_block_codes::BLOCK_MISMATCH), None));
    }
    Ok((
        result(&block.id, KnownBlockOutcome::Registered),
        Some((from, to)),
    ))
}

pub async fn register_known_blocks(
    State(state): State<AppState>,
    device: AuthDevice,
    ApiJson(request): ApiJson<KnownBlocksRequest>,
) -> Result<Json<KnownBlocksResponse>, ApiError> {
    if !matches!(device.kind, DeviceKind::Station | DeviceKind::Handheld) {
        return Err(ApiError::forbidden(FORBIDDEN));
    }
    if request.blocks.len() > MAX_BLOCKS || (request.blocks.is_empty() && request.more) {
        return Err(ApiError::validation(
            "blocks",
            "0-64 blocks, none only in the last part",
        ));
    }
    for (index, block) in request.blocks.iter().enumerate() {
        validate::client_uuid(&format!("blocks.{index}.id"), &block.id)?;
    }
    let at = state.timestamp();
    let mut tx = begin_write(&state.pool).await.map_err(ApiError::internal)?;
    device
        .require_kinds_in(
            &mut tx,
            &[DeviceKind::Station, DeviceKind::Handheld],
            FORBIDDEN,
        )
        .await?;
    let epoch: Option<String> = sqlx::query_scalar("SELECT restore_epoch FROM site WHERE id = 1")
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let Some(epoch) = epoch else {
        return Err(ApiError::conflict(
            "no_restore",
            "the host was never restored: it lost no block",
        ));
    };
    let mut results = Vec::with_capacity(request.blocks.len());
    let mut rev = None;
    for block in &request.blocks {
        let (outcome, registered) = decide(&mut tx, &device.id, block).await?;
        if let Some((from, to)) = registered {
            let rev = match rev {
                Some(rev) => rev,
                None => {
                    let new = next_revision(&mut tx).await.map_err(ApiError::internal)?;
                    rev = Some(new);
                    new
                }
            };
            sqlx::query(
                "INSERT INTO sscc_blocks (id, issuer_prefix, extension, device_id, request_id, \
                 from_serial, to_serial, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&block.id)
            .bind(&block.issuer_prefix)
            .bind(i64::from(block.extension))
            .bind(&device.id)
            .bind(&block.id)
            .bind(from)
            .bind(to)
            .bind(&at)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
            // The counter only moves forward: past the block if it was not.
            sqlx::query(
                "UPDATE sscc_counters SET next_serial = ?1, rev = ?2 \
                 WHERE issuer_prefix = ?3 AND extension = ?4 AND next_serial < ?1",
            )
            .bind(to + 1)
            .bind(rev)
            .bind(&block.issuer_prefix)
            .bind(i64::from(block.extension))
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
            audit::record(
                &mut tx,
                &at,
                Entry {
                    actor: Actor::Device(&device.id),
                    action: actions::SSCC_BLOCK_REGISTER,
                    target_type: Some("sscc_block"),
                    target_id: Some(&block.id),
                    outcome: Outcome::Ok,
                    details: json!({
                        "issuerPrefix": block.issuer_prefix,
                        "extension": block.extension,
                        "fromSerial": block.from_serial,
                        "toSerial": block.to_serial,
                    }),
                },
            )
            .await
            .map_err(ApiError::internal)?;
        }
        results.push(outcome);
    }
    // The station gave its blocks back for this epoch, whatever became of
    // each, once its last part is in (plan ОЧ): the office lists the stations
    // that did not yet.
    let marked = if request.more {
        0
    } else {
        sqlx::query(
            "UPDATE devices SET known_blocks_epoch = ?1 WHERE id = ?2 \
             AND known_blocks_epoch IS NOT ?1",
        )
        .bind(&epoch)
        .bind(&device.id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?
        .rows_affected()
    };
    match rev {
        Some(rev) => commit_with_revision(tx, &state.revisions, rev)
            .await
            .map_err(ApiError::internal)?,
        // Devices are no feed data: marking one takes no revision.
        None if marked > 0 => tx.commit().await.map_err(ApiError::internal)?,
        // Nothing changed: the transaction rolls back when dropped.
        None => drop(tx),
    }
    Ok(Json(KnownBlocksResponse { results }))
}
