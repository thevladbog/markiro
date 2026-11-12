//! Resolve a scanned set mark and release its components through an applied
//! office document. The assembly fact and the outer mark survive permanently.

use markiro_proto::SetAssembledFact;
use sqlx::SqliteConnection;

use crate::error::ApiError;
use crate::facts::{rules, scan};

use super::{classify, Target};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SetTarget {
    pub device_id: String,
    pub record_id: String,
    shift_id: String,
    parent_hash: String,
}

/// Strip the same scanner transport as the shared GS1 parser. Store the input
/// for review, but look up and deduplicate the set by its AI 01/21 identity.
pub(crate) fn read_input(input: &str) -> Option<(&str, &str)> {
    let input = input.trim_matches([' ', '\t', '\r', '\n']);
    let canonical = input
        .strip_prefix("]d2")
        .unwrap_or(input)
        .trim_matches([' ', '\t']);
    if input.len() > scan::MAX_CANONICAL_BYTES + 3
        || canonical.len() > scan::MAX_CANONICAL_BYTES
        || canonical
            .chars()
            .any(|ch| ch == '\u{fffd}' || (ch.is_ascii_control() && ch != '\u{1d}'))
    {
        return None;
    }
    let mut segments = canonical.split('\u{1d}');
    let code = segments.next()?;
    let serial = code.get(18..)?;
    if !code.starts_with("01")
        || code.get(16..18) != Some("21")
        || !code.get(2..16)?.bytes().all(|byte| byte.is_ascii_digit())
        || !(1..=scan::MAX_SERIAL_BYTES).contains(&serial.len())
        || serial.chars().any(char::is_control)
    {
        return None;
    }
    let mut seen = std::collections::HashSet::new();
    for segment in segments {
        let ai = segment.get(..2)?;
        if segment.len() == 2 || !ai.bytes().all(|byte| byte.is_ascii_digit()) || !seen.insert(ai) {
            return None;
        }
    }
    Some((input, code))
}

#[derive(sqlx::FromRow)]
struct SetRow {
    device_id: String,
    record_id: String,
    shift_id: String,
    product_id: String,
    shift_closed: bool,
    released: bool,
    code_count: i64,
}

pub(crate) async fn resolve(
    conn: &mut SqliteConnection,
    code: &str,
) -> Result<Option<Target>, ApiError> {
    let parent_hash = rules::sha256_hex(code.as_bytes());
    let row: Option<SetRow> = sqlx::query_as(
        "SELECT a.device_id, a.record_id, a.shift_id, s.product_id,
                s.status = 'closed' AS shift_closed, r.line_id IS NOT NULL AS released,
                json_array_length(a.data, '$.items') AS code_count
         FROM set_codes c
         JOIN set_assemblies a ON a.device_id = c.device_id AND a.record_id = c.record_id
         JOIN shifts s ON s.id = a.shift_id
         LEFT JOIN set_releases r ON r.device_id = a.device_id AND r.record_id = a.record_id
         WHERE c.code_hash = ? AND a.outcome = 'accepted'
           AND c.code_hash = json_extract(a.data, '$.setCode.codeHash')",
    )
    .bind(&parent_hash)
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(row.map(|row| Target {
        box_id: None,
        pallet_id: None,
        warehouse_pallet_id: None,
        status: classify(true, row.shift_closed, row.released),
        product_id: Some(row.product_id),
        cloud: false,
        product_name: None,
        code_count: row.code_count,
        set: Some(SetTarget {
            device_id: row.device_id,
            record_id: row.record_id,
            shift_id: row.shift_id,
            parent_hash,
        }),
    }))
}

pub(crate) async fn release(
    conn: &mut SqliteConnection,
    line_id: &str,
    set: &SetTarget,
    code_count: i64,
    at: &str,
    rev: i64,
) -> Result<usize, ApiError> {
    let count = sqlx::query(
        "DELETE FROM set_codes WHERE device_id = ? AND record_id = ? AND code_hash <> ?",
    )
    .bind(&set.device_id)
    .bind(&set.record_id)
    .bind(&set.parent_hash)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?
    .rows_affected();
    if i64::try_from(count).map_err(ApiError::internal)? != code_count {
        return Err(ApiError::internal(
            "the set's claims do not match its assembly",
        ));
    }
    sqlx::query(
        "INSERT INTO set_releases (line_id, device_id, record_id, rev) VALUES (?, ?, ?, ?)",
    )
    .bind(line_id)
    .bind(&set.device_id)
    .bind(&set.record_id)
    .bind(rev)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE shifts SET late_data_at = ?, rev = ? WHERE id = ? AND late_data_at IS NULL",
    )
    .bind(at)
    .bind(rev)
    .bind(&set.shift_id)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    usize::try_from(count).map_err(ApiError::internal)
}

pub(crate) fn read_assembly(data: &str) -> Result<SetAssembledFact, ApiError> {
    serde_json::from_str(data).map_err(ApiError::internal)
}
