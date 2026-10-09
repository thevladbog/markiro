//! `scan` facts: the journal of every scan of the work screen. An accepted
//! scan (`ok`) opens its box when the host does not know it yet, and claims
//! its code in the registry (`registry::claim`); the others are journal
//! rows only. An `invalid` scan keeps no text, only its length and what it
//! looked like.

use markiro_proto::{receipt_codes, ScanFact, ScanRawKind, ScanVerdict};
use serde_json::Value;
use sqlx::SqliteConnection;

use super::registry::{self, Claim};
use super::{boxes, rules, Applied, Context, Failure, Reject};
use crate::error::ApiError;
use crate::validate;

/// The longest serial the host keeps, in bytes of UTF-8; a serial of the
/// GS1 system has 20 characters of ASCII at most, so this only keeps a
/// broken device out.
pub const MAX_SERIAL_BYTES: usize = 64;
/// The longest canonical code the host keeps, in bytes of UTF-8.
pub const MAX_CANONICAL_BYTES: usize = 1024;

/// The fields of a scan agree with its verdict: an `invalid` scan has no
/// code and looked like no code, a `duplicate` names who found it, an `ok`
/// one names its box; and the code, when there is one, has the shape the
/// domain gives it.
fn check(scan: &ScanFact) -> Result<(), Reject> {
    let invalid = scan.verdict == ScanVerdict::Invalid;
    if rules::device_instant(&scan.scanned_at).is_none() {
        return Err(Reject::field("data.scannedAt"));
    }
    if invalid == (scan.raw_kind == ScanRawKind::Km) {
        return Err(Reject::field("data.rawKind"));
    }
    if invalid != scan.code.is_none() {
        return Err(Reject::field("data.code"));
    }
    if (scan.verdict == ScanVerdict::Duplicate) != scan.duplicate_source.is_some() {
        return Err(Reject::field("data.duplicateSource"));
    }
    match &scan.box_id {
        Some(box_id) if scan.verdict == ScanVerdict::Ok => {
            if validate::client_uuid("data.boxId", box_id).is_err() {
                return Err(Reject::field("data.boxId"));
            }
        }
        None if scan.verdict != ScanVerdict::Ok => {}
        _ => return Err(Reject::field("data.boxId")),
    }
    if let Some(code) = &scan.code {
        if !rules::is_code_hash(&code.code_hash) {
            return Err(Reject::field("data.code.codeHash"));
        }
        if code.gtin14.len() != 14 || !code.gtin14.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(Reject::field("data.code.gtin14"));
        }
        if !(1..=MAX_SERIAL_BYTES).contains(&code.serial.len())
            || code.serial.chars().any(char::is_control)
        {
            return Err(Reject::field("data.code.serial"));
        }
        if !(1..=MAX_CANONICAL_BYTES).contains(&code.canonical.len())
            || code.canonical.contains('\0')
        {
            return Err(Reject::field("data.code.canonical"));
        }
    }
    Ok(())
}

pub async fn apply(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let scan: ScanFact = serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    check(&scan)?;
    let accepted = match (&scan.code, &scan.box_id) {
        (Some(code), Some(box_id)) if scan.verdict == ScanVerdict::Ok => {
            if code.gtin14 != context.shift.gtin14 {
                return Err(Reject::new(receipt_codes::GTIN_MISMATCH).into());
            }
            match boxes::find(&mut *conn, context, box_id).await? {
                Some(found) if found.closed_at.is_some() => {
                    return Err(Reject::new(receipt_codes::BOX_CLOSED).into());
                }
                Some(_) => {}
                None => {
                    sqlx::query(
                        "INSERT INTO boxes (id, shift_id, device_id, opened_at, received_at) \
                         VALUES (?, ?, ?, ?, ?)",
                    )
                    .bind(box_id)
                    .bind(&context.shift.id)
                    .bind(context.device_id)
                    .bind(&scan.scanned_at)
                    .bind(context.received_at)
                    .execute(&mut *conn)
                    .await
                    .map_err(ApiError::internal)?;
                }
            }
            Some((code, box_id))
        }
        _ => None,
    };
    let scan_id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, duplicate_source, \
         raw_kind, raw_length, code_hash, gtin14, serial, canonical, box_id, operator_id, \
         scanned_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&scan_id)
    .bind(context.record_id)
    .bind(context.device_id)
    .bind(&context.shift.id)
    .bind(scan.verdict.as_str())
    .bind(scan.duplicate_source.map(|source| source.as_str()))
    .bind(scan.raw_kind.as_str())
    .bind(scan.raw_length)
    .bind(scan.code.as_ref().map(|code| &code.code_hash))
    .bind(scan.code.as_ref().map(|code| &code.gtin14))
    .bind(scan.code.as_ref().map(|code| &code.serial))
    .bind(scan.code.as_ref().map(|code| &code.canonical))
    .bind(&scan.box_id)
    .bind(context.operator_id)
    .bind(&scan.scanned_at)
    .bind(context.received_at)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    match accepted {
        Some((code, box_id)) => Ok(registry::claim(
            conn,
            context,
            &Claim {
                scan_id: &scan_id,
                code_hash: &code.code_hash,
                box_id,
                scanned_at: &scan.scanned_at,
            },
        )
        .await?),
        None => Ok(Applied::accepted()),
    }
}
