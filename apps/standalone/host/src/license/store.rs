//! The license's rows (migration `0030`): the files, append-only, and the one
//! row of the license clock. Plain reads and writes; the decisions are
//! `state.rs`'s and `mod.rs`'s.

use sqlx::SqliteConnection;

use super::bounded_ms;
use super::state::{Features, Quotas, StoredLicense};

/// `license_clock`, times in ms UTC.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClockRow {
    pub max_seen_at: Option<i64>,
    pub trial_started_at: Option<i64>,
    pub trial_inn: Option<String>,
    pub emergency_used_for: Option<String>,
    pub emergency_until: Option<i64>,
    pub wrong_host_since: Option<i64>,
    pub last_state: Option<String>,
    pub last_state_at: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct LicenseRow {
    license_id: String,
    sequence: i64,
    kid: String,
    host_id: String,
    issued_at: i64,
    valid_from: i64,
    valid_until: i64,
    grace_days: i64,
    plan: String,
    plan_version_id: String,
    customer_name: String,
    customer_inn: String,
    quotas: String,
    features: String,
}

#[derive(sqlx::FromRow)]
struct ClockRecord {
    max_seen_at: Option<i64>,
    trial_started_at: Option<i64>,
    trial_inn: Option<String>,
    emergency_used_for: Option<String>,
    emergency_until: Option<i64>,
    wrong_host_since: Option<i64>,
    last_state: Option<String>,
    last_state_at: Option<i64>,
}

/// Every stored file, by `sequence`. A row with a time out of range
/// ([`bounded_ms`]) or terms of the wrong shape (`quotas`, `features` that
/// do not read as the file's) is not used: the host never wrote one, so it
/// is not a file the office loaded; the service log names only its id.
/// Skipping it keeps the license (and every device, which reads it with its
/// record) working on the files before it.
pub async fn licenses(conn: &mut SqliteConnection) -> Result<Vec<StoredLicense>, sqlx::Error> {
    let rows: Vec<LicenseRow> = sqlx::query_as(
        "SELECT license_id, sequence, kid, host_id, issued_at, valid_from, valid_until, \
         grace_days, plan, plan_version_id, customer_name, customer_inn, quotas, features \
         FROM licenses ORDER BY sequence",
    )
    .fetch_all(conn)
    .await?;
    Ok(rows.into_iter().filter_map(usable).collect())
}

/// `row` as a file, or none (logged by its id) when the host could not have
/// written it.
fn usable(row: LicenseRow) -> Option<StoredLicense> {
    let in_range = [row.issued_at, row.valid_from, row.valid_until]
        .into_iter()
        .all(|ms| bounded_ms(ms).is_some());
    if !in_range {
        tracing::warn!(
            license_id = %row.license_id,
            "a stored license file holds a time out of range; it is not used"
        );
        return None;
    }
    let terms: Result<(Quotas, Features), serde_json::Error> = serde_json::from_str(&row.quotas)
        .and_then(|quotas| Ok((quotas, serde_json::from_str(&row.features)?)));
    let Ok((quotas, features)) = terms else {
        tracing::warn!(
            license_id = %row.license_id,
            "a stored license file holds terms of the wrong shape; it is not used"
        );
        return None;
    };
    Some(StoredLicense {
        quotas,
        features,
        license_id: row.license_id,
        sequence: row.sequence,
        kid: row.kid,
        host_id: row.host_id,
        issued_at: row.issued_at,
        valid_from: row.valid_from,
        valid_until: row.valid_until,
        grace_days: row.grace_days,
        plan: row.plan,
        plan_version_id: row.plan_version_id,
        customer_name: row.customer_name,
        customer_inn: row.customer_inn,
    })
}

/// The one row of `license_clock` (migration `0030` seeds it). A time out
/// of range ([`bounded_ms`]) is read the safe way: the trial's start, the
/// emergency's end and a wrong host's first sighting as the epoch (the trial
/// is over, the extension used and over, the window over — never an endless
/// trial, a second extension or a fresh window), the mark and the last
/// state's time as none (the PC's clock, now).
pub async fn clock_row(conn: &mut SqliteConnection) -> Result<ClockRow, sqlx::Error> {
    let row: ClockRecord = sqlx::query_as(
        "SELECT max_seen_at, trial_started_at, trial_inn, emergency_used_for, emergency_until, \
         wrong_host_since, last_state, last_state_at FROM license_clock WHERE id = 1",
    )
    .fetch_one(conn)
    .await?;
    let over = |ms: Option<i64>| ms.map(|ms| bounded_ms(ms).unwrap_or(0));
    Ok(ClockRow {
        max_seen_at: row.max_seen_at.and_then(bounded_ms),
        trial_started_at: over(row.trial_started_at),
        trial_inn: row.trial_inn,
        emergency_used_for: row.emergency_used_for,
        emergency_until: over(row.emergency_until),
        wrong_host_since: over(row.wrong_host_since),
        last_state: row.last_state,
        last_state_at: row.last_state_at.and_then(bounded_ms),
    })
}

/// The organization's INN as stored; `None` before the wizard or without one.
pub async fn org_inn(conn: &mut SqliteConnection) -> Result<Option<String>, sqlx::Error> {
    Ok(
        sqlx::query_scalar::<_, Option<String>>("SELECT inn FROM org_profile WHERE id = 1")
            .fetch_optional(conn)
            .await?
            .flatten(),
    )
}

/// Keep a verified file (spec §4.4); `compact` is its text.
pub async fn insert(
    conn: &mut SqliteConnection,
    license: &StoredLicense,
    compact: &str,
    loaded_at: &str,
    loaded_by: Option<&str>,
) -> Result<(), sqlx::Error> {
    let encode = |error: serde_json::Error| sqlx::Error::Encode(Box::new(error));
    sqlx::query(
        "INSERT INTO licenses (license_id, sequence, compact, kid, host_id, issued_at, \
         valid_from, valid_until, grace_days, plan, plan_version_id, customer_name, \
         customer_inn, quotas, features, loaded_at, loaded_by) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&license.license_id)
    .bind(license.sequence)
    .bind(compact)
    .bind(&license.kid)
    .bind(&license.host_id)
    .bind(license.issued_at)
    .bind(license.valid_from)
    .bind(license.valid_until)
    .bind(license.grace_days)
    .bind(&license.plan)
    .bind(&license.plan_version_id)
    .bind(&license.customer_name)
    .bind(&license.customer_inn)
    .bind(serde_json::to_string(&license.quotas).map_err(encode)?)
    .bind(serde_json::to_string(&license.features).map_err(encode)?)
    .bind(loaded_at)
    .bind(loaded_by)
    .execute(conn)
    .await?;
    Ok(())
}

/// The stored mark raised to `?1`: never lowered, but a mark out of range
/// ([`bounded_ms`]), which the host never wrote, is replaced, or it would
/// win every `max` and never move again.
const RAISED_MARK: &str = "CASE WHEN max_seen_at BETWEEN 0 AND 9007199254740991 \
     THEN max(max_seen_at, ?1) ELSE ?1 END";

/// Raise the stored mark to `mark` (never lower it).
pub async fn persist_mark(conn: &mut SqliteConnection, mark: i64) -> Result<(), sqlx::Error> {
    sqlx::query(&format!(
        "UPDATE license_clock SET max_seen_at = {RAISED_MARK} WHERE id = 1"
    ))
    .bind(mark)
    .execute(conn)
    .await?;
    Ok(())
}

/// The state a `license.state` row (or the first look) named, and when; the
/// mark with it.
pub async fn set_state(
    conn: &mut SqliteConnection,
    state: &str,
    at: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(&format!(
        "UPDATE license_clock SET last_state = ?2, last_state_at = ?1, \
         max_seen_at = {RAISED_MARK} WHERE id = 1"
    ))
    .bind(at)
    .bind(state)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn set_wrong_host_since(
    conn: &mut SqliteConnection,
    since: Option<i64>,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE license_clock SET wrong_host_since = ? WHERE id = 1")
        .bind(since)
        .execute(conn)
        .await?;
    Ok(())
}

/// The emergency extension of `key` (a file's id or `trial`) until `until`.
/// An update of no row (the clock's row is gone) is an error: the caller
/// must not record or answer an extension that was not stored.
pub async fn set_emergency(
    conn: &mut SqliteConnection,
    key: &str,
    until: i64,
) -> Result<(), sqlx::Error> {
    let done = sqlx::query(
        "UPDATE license_clock SET emergency_used_for = ?, emergency_until = ? WHERE id = 1",
    )
    .bind(key)
    .bind(until)
    .execute(conn)
    .await?;
    if done.rows_affected() != 1 {
        return Err(sqlx::Error::RowNotFound);
    }
    Ok(())
}
