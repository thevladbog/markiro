use std::collections::{HashMap, HashSet};

use markiro_proto::{
    CodeOwner, FactOutcome, ScannedCode, SetAssembledFact, ShiftOrigin, MAX_SET_ITEMS,
};
use serde_json::{json, Value};
use sqlx::SqliteConnection;

use super::{rules, scan, Applied, Context, Failure, Reject};
use crate::{error::ApiError, shifts};

fn valid_identity(code: &ScannedCode) -> bool {
    let key = format!("01{}21{}", code.gtin14, code.serial);
    (1..=scan::MAX_SERIAL_BYTES).contains(&code.serial.len())
        && !code.serial.chars().any(char::is_control)
        && code.canonical.len() <= scan::MAX_CANONICAL_BYTES
        && code.canonical.split('\u{1d}').next() == Some(&key)
        && code
            .canonical
            .chars()
            .all(|ch| ch == '\u{1d}' || (!ch.is_ascii_control() && ch != '\u{fffd}'))
        && code.code_hash == rules::sha256_hex(key.as_bytes())
}

fn check<'a>(
    context: &Context<'_>,
    assembly: &'a SetAssembledFact,
) -> Result<Vec<&'a str>, Reject> {
    if rules::device_instant(&assembly.assembled_at).is_none() {
        return Err(Reject::field("data.assembledAt"));
    }
    if assembly.set_code.gtin14 != context.shift.gtin14 || !valid_identity(&assembly.set_code) {
        return Err(Reject::field("data.setCode"));
    }
    if assembly.items.is_empty() || assembly.items.len() > MAX_SET_ITEMS as usize {
        return Err(Reject::field("data.items"));
    }
    let mut remaining: HashMap<_, _> = context
        .shift
        .set_items
        .iter()
        .map(|item| (item.gtin14.as_str(), item.quantity))
        .collect();
    let mut seen = HashSet::from([assembly.set_code.code_hash.as_str()]);
    let mut hashes = Vec::with_capacity(assembly.items.len() + 1);
    hashes.push(assembly.set_code.code_hash.as_str());
    for item in &assembly.items {
        let Some(count) = remaining.get_mut(item.gtin14.as_str()) else {
            return Err(Reject::field("data.items"));
        };
        if *count == 0 || !valid_identity(item) || !seen.insert(&item.code_hash) {
            return Err(Reject::field("data.items"));
        }
        *count -= 1;
        hashes.push(item.code_hash.as_str());
    }
    if remaining.values().any(|count| *count != 0) {
        return Err(Reject::field("data.items"));
    }
    Ok(hashes)
}

/// The transaction that receives the outbox record also checks ownership and writes the
/// assembly and its code claims. Previously scanned production can be used as a component.
pub async fn apply(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let assembly: SetAssembledFact =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    let hashes = check(context, &assembly)?;
    let hashes_json = serde_json::to_string(&hashes).map_err(ApiError::internal)?;
    let collision: Option<(String, String, i64, String, String, String, String)> = sqlx::query_as(
        "SELECT s.id, s.number_month_key, s.number_seq, s.number_origin, a.device_id,                 a.assembled_at, c.code_hash
         FROM json_each(?) h
         JOIN set_codes c ON c.code_hash = h.value
         JOIN set_assemblies a ON a.device_id = c.device_id AND a.record_id = c.record_id
         JOIN shifts s ON s.id = a.shift_id
         ORDER BY h.key LIMIT 1",
    )
    .bind(&hashes_json)
    .fetch_optional(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    let applied = match collision {
        Some((shift_id, month, seq, origin, device_id, assembled_at, hash)) => {
            let origin: ShiftOrigin = origin.parse().map_err(ApiError::internal)?;
            let winner = CodeOwner {
                shift_id,
                shift_number: shifts::format_number(&month, seq, origin),
                same_device: device_id == context.device_id,
                device_id,
                scanned_at: assembled_at,
            };
            Applied {
                outcome: FactOutcome::Conflict,
                details: Some(json!({ "winner": winner, "codeHash": hash })),
                close: None,
            }
        }
        None => Applied::accepted(),
    };

    sqlx::query(
        "INSERT INTO set_assemblies (device_id, record_id, shift_id, operator_id, assembled_at,          data, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(context.device_id)
    .bind(context.record_id)
    .bind(&context.shift.id)
    .bind(context.operator_id)
    .bind(&assembly.assembled_at)
    .bind(serde_json::to_string(&assembly).map_err(ApiError::internal)?)
    .bind(applied.outcome.as_str())
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    if applied.outcome == FactOutcome::Accepted {
        sqlx::query(
            "INSERT INTO set_codes (code_hash, device_id, record_id)
             SELECT value, ?, ? FROM json_each(?)",
        )
        .bind(context.device_id)
        .bind(context.record_id)
        .bind(&hashes_json)
        .execute(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    }
    Ok(applied)
}
