//! The registry of codes (stage 2a spec, decision 14): each code is owned by
//! its earliest accepted scan since the code was last freed, whatever order
//! the scans arrive in. A scan earlier than the owner takes the code (the
//! owner's item leaves its box, `displaced_at`); a later one is answered
//! `conflict` with the owner. Both write a `code_conflicts` row; each row says
//! how its loser lost (`kind`); the office reviews it and the device learns of
//! it (plan КНФ). Exceptions
//! release the codes their items owned: after a release the next scan to
//! ARRIVE owns the code, not an earlier displaced item or conflict loser
//! (re-electing the earliest remaining claim is a plan 2b decision).

use markiro_proto::review::ConflictKind;
use markiro_proto::{CodeOwner, FactOutcome, ShiftOrigin};
use sqlx::SqliteConnection;

use super::{Applied, Context};
use crate::error::ApiError;
use crate::shifts;

/// The scan that owns a code now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Owner {
    /// Imported ownership has no local scan; never synthesize a journal fact.
    pub scan_id: Option<String>,
    pub shift_id: String,
    pub shift_number: String,
    pub device_id: String,
    pub scanned_at: String,
}

impl Owner {
    /// The owner as `device_id` is told of it.
    pub fn to_wire(&self, device_id: &str) -> CodeOwner {
        CodeOwner {
            shift_id: self.shift_id.clone(),
            shift_number: self.shift_number.clone(),
            device_id: self.device_id.clone(),
            scanned_at: self.scanned_at.clone(),
            same_device: self.scan_id.is_some() && self.device_id == device_id,
        }
    }
}

/// The owner of `code_hash`, or `None` while the code is free.
pub async fn owner(
    conn: &mut SqliteConnection,
    code_hash: &str,
) -> Result<Option<Owner>, ApiError> {
    if let Some(cloud) = crate::cloud_history::completed_owner(&mut *conn, code_hash).await? {
        return Ok(Some(Owner {
            scan_id: None,
            shift_id: cloud.shift_id,
            shift_number: cloud.number,
            // Protocol sentinel: cloud provenance has no device in this installation.
            device_id: uuid::Uuid::nil().to_string(),
            scanned_at: cloud.scanned_at,
        }));
    }
    type OwnerRow = (String, String, String, i64, String, String, String);
    let row: Option<OwnerRow> = sqlx::query_as(
        "SELECT o.scan_id, o.shift_id, s.number_month_key, s.number_seq, s.created_from, \
         o.device_id, o.scanned_at FROM code_owners o JOIN shifts s ON s.id = o.shift_id \
         WHERE o.code_hash = ?",
    )
    .bind(code_hash)
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    row.map(
        |(scan_id, shift_id, month_key, seq, created_from, device_id, scanned_at)| {
            let origin: ShiftOrigin = created_from.parse().map_err(ApiError::internal)?;
            Ok(Owner {
                scan_id: Some(scan_id),
                shift_id,
                shift_number: shifts::format_number(&month_key, seq, origin),
                device_id,
                scanned_at,
            })
        },
    )
    .transpose()
}

/// An accepted scan, already in the journal, that claims its code: for its
/// box in an aggregation shift, without one in a validation shift (plan
/// РЕЖ).
pub struct Claim<'a> {
    pub scan_id: &'a str,
    pub code_hash: &'a str,
    pub box_id: Option<&'a str>,
    pub scanned_at: &'a str,
}

async fn conflict_row(
    conn: &mut SqliteConnection,
    code_hash: &str,
    winner: &str,
    loser: &str,
    kind: ConflictKind,
    at: &str,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO code_conflicts (id, code_hash, winner_scan_id, loser_scan_id, kind, \
         detected_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(code_hash)
    .bind(winner)
    .bind(loser)
    .bind(kind.as_str())
    .bind(at)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(())
}

/// Give the code to `claim` when it is free or owned by a later scan, and
/// put it in its box when it has one; otherwise keep the owner and answer
/// `conflict` with it. Two scans at the same instant: the owner keeps the
/// code. An owner displaced leaves its box, if it was in one.
pub async fn claim(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    claim: &Claim<'_>,
) -> Result<Applied, ApiError> {
    match owner(&mut *conn, claim.code_hash).await? {
        Some(owner) if owner.scan_id.is_none() => {
            sqlx::query("INSERT INTO cloud_history_conflicts(id,code_hash,loser_scan_id,winner_shift_id,winner_number,winner_scanned_at,winner_box_id,detected_at) SELECT ?,hash,?,shift_id,number,scanned_at,box_id,? FROM cloud_history_owners WHERE hash=? AND released_at IS NULL")
                .bind(uuid::Uuid::new_v4().to_string()).bind(claim.scan_id)
                .bind(context.received_at).bind(claim.code_hash)
                .execute(&mut *conn).await.map_err(ApiError::internal)?;
            return Ok(Applied {
                outcome: FactOutcome::Conflict,
                details: Some(serde_json::json!({"winner": owner.to_wire(context.device_id)})),
                close: None,
            });
        }
        Some(owner) if claim.scanned_at >= owner.scanned_at.as_str() => {
            conflict_row(
                &mut *conn,
                claim.code_hash,
                owner
                    .scan_id
                    .as_deref()
                    .ok_or_else(|| ApiError::internal("missing native scan"))?,
                claim.scan_id,
                ConflictKind::Late,
                context.received_at,
            )
            .await?;
            let winner = serde_json::to_value(owner.to_wire(context.device_id))
                .map_err(ApiError::internal)?;
            return Ok(Applied {
                outcome: FactOutcome::Conflict,
                details: Some(serde_json::json!({ "winner": winner })),
                close: None,
            });
        }
        Some(owner) => {
            // An earlier scan: the owner's item leaves its box first, so the
            // code is never live twice.
            sqlx::query(
                "UPDATE box_items SET displaced_at = ? \
                 WHERE scan_id = ? AND removed_at IS NULL AND displaced_at IS NULL",
            )
            .bind(context.received_at)
            .bind(&owner.scan_id)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
            conflict_row(
                &mut *conn,
                claim.code_hash,
                claim.scan_id,
                owner
                    .scan_id
                    .as_deref()
                    .ok_or_else(|| ApiError::internal("missing native scan"))?,
                ConflictKind::Displaced,
                context.received_at,
            )
            .await?;
            sqlx::query(
                "UPDATE code_owners SET scan_id = ?, shift_id = ?, device_id = ?, box_id = ?, \
                 scanned_at = ? WHERE code_hash = ?",
            )
            .bind(claim.scan_id)
            .bind(&context.shift.id)
            .bind(context.device_id)
            .bind(claim.box_id)
            .bind(claim.scanned_at)
            .bind(claim.code_hash)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        }
        None => {
            sqlx::query(
                "INSERT INTO code_owners (code_hash, scan_id, shift_id, device_id, box_id, \
                 scanned_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(claim.code_hash)
            .bind(claim.scan_id)
            .bind(&context.shift.id)
            .bind(context.device_id)
            .bind(claim.box_id)
            .bind(claim.scanned_at)
            .execute(&mut *conn)
            .await
            .map_err(ApiError::internal)?;
        }
    }
    if let Some(box_id) = claim.box_id {
        sqlx::query(
            "INSERT INTO box_items (scan_id, box_id, code_hash, added_at) VALUES (?, ?, ?, ?)",
        )
        .bind(claim.scan_id)
        .bind(box_id)
        .bind(claim.code_hash)
        .bind(claim.scanned_at)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    }
    Ok(Applied::accepted())
}

/// Free the code the scan `scan_id` owns, if it owns one: its item was
/// taken out of its box. Nobody inherits the code: see the module's note on
/// what the next scan to arrive finds.
pub async fn release(conn: &mut SqliteConnection, scan_id: &str) -> Result<(), ApiError> {
    sqlx::query("DELETE FROM code_owners WHERE scan_id = ?")
        .bind(scan_id)
        .execute(conn)
        .await
        .map_err(ApiError::internal)?;
    Ok(())
}
