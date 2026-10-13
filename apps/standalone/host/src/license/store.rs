//! The license's rows (migration `0030`): the files, append-only, and the one
//! row of the license clock. Plain reads and writes; the decisions are
//! `state.rs`'s and `mod.rs`'s.

use markiro_proto::trust::Keyset;
use sqlx::SqliteConnection;

use super::bounded_ms;
use super::state::{Features, Quotas, StoredLicense};
use super::verify;

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

/// A stored file's id and number, read from its row whether or not the
/// rest of the row decodes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileKey {
    pub license_id: String,
    pub sequence: i64,
}

/// What the host reads of its stored files.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Files {
    /// Every file the host can use, by `sequence`.
    pub usable: Vec<StoredLicense>,
    /// The row of the highest `sequence`, used or not: no older file comes
    /// in under a row the host cannot read (spec §4.3 step 7), and the
    /// activation request names it.
    pub newest: Option<FileKey>,
    /// The issue of every row whose issue is in range ([`bounded_ms`]), used
    /// or not: the floor of the time (§7) is never weakened by a row that
    /// does not decode.
    pub issued_at: Vec<i64>,
}

/// Every stored file, by `sequence`. A row with a time out of range
/// ([`bounded_ms`]) is not used: the host never wrote one, so it is not a
/// file the office loaded. A row whose terms (`quotas`, `features`) do not
/// read as the file's is read again from its signed text (`compact`, with
/// every key of `keyset`, retired ones too: the file was trusted when it was
/// loaded) when that verifies and names the row's host, number and id; else
/// it is not used either. The service log names only the row's id. Skipping
/// a row keeps the license (and every device, which reads it with its
/// record) working on the files before it.
pub async fn files(conn: &mut SqliteConnection, keyset: &Keyset) -> Result<Files, sqlx::Error> {
    let rows: Vec<LicenseRow> = sqlx::query_as(
        "SELECT license_id, sequence, kid, host_id, issued_at, valid_from, valid_until, \
         grace_days, plan, plan_version_id, customer_name, customer_inn, quotas, features \
         FROM licenses ORDER BY sequence",
    )
    .fetch_all(&mut *conn)
    .await?;
    let newest = rows.last().map(|row| FileKey {
        license_id: row.license_id.clone(),
        sequence: row.sequence,
    });
    let issued_at = rows
        .iter()
        .filter_map(|row| bounded_ms(row.issued_at))
        .collect();
    let mut usable = Vec::with_capacity(rows.len());
    for row in rows {
        match decoded(row) {
            Decoded::Usable(license) => usable.push(license),
            Decoded::OutOfRange => {}
            Decoded::BrokenTerms(key, host_id) => {
                if let Some(license) = signed(&mut *conn, keyset, &key, &host_id).await? {
                    usable.push(license);
                }
            }
        }
    }
    Ok(Files {
        usable,
        newest,
        issued_at,
    })
}

enum Decoded {
    Usable(StoredLicense),
    OutOfRange,
    /// The row's id and number, and its host.
    BrokenTerms(FileKey, String),
}

/// `row` as a file; out of range (logged by its id) when the host could not
/// have written it; broken terms to read again from the signed text.
fn decoded(row: LicenseRow) -> Decoded {
    let in_range = [row.issued_at, row.valid_from, row.valid_until]
        .into_iter()
        .all(|ms| bounded_ms(ms).is_some());
    if !in_range {
        tracing::warn!(
            license_id = %row.license_id,
            "a stored license file holds a time out of range; it is not used"
        );
        return Decoded::OutOfRange;
    }
    let terms: Result<(Quotas, Features), serde_json::Error> = serde_json::from_str(&row.quotas)
        .and_then(|quotas| Ok((quotas, serde_json::from_str(&row.features)?)));
    let Ok((quotas, features)) = terms else {
        return Decoded::BrokenTerms(
            FileKey {
                license_id: row.license_id,
                sequence: row.sequence,
            },
            row.host_id,
        );
    };
    Decoded::Usable(StoredLicense {
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

/// The file of a row whose terms do not decode, read from its signed text:
/// only when it verifies with every key of `keyset` (retired ones too) and
/// names the row's host, number and id. Else none, logged by the id.
async fn signed(
    conn: &mut SqliteConnection,
    keyset: &Keyset,
    key: &FileKey,
    host_id: &str,
) -> Result<Option<StoredLicense>, sqlx::Error> {
    let compact: String = sqlx::query_scalar("SELECT compact FROM licenses WHERE license_id = ?")
        .bind(&key.license_id)
        .fetch_one(conn)
        .await?;
    let every_key = Keyset {
        retired_kids: Vec::new(),
        ..keyset.clone()
    };
    let license = verify::read(&compact, &every_key)
        .ok()
        .map(|verified| verified.license)
        .filter(|license| {
            license.license_id == key.license_id
                && license.sequence == key.sequence
                && license.host_id == host_id
        });
    if license.is_some() {
        tracing::warn!(
            license_id = %key.license_id,
            "a stored license file holds terms of the wrong shape; read from its signed text"
        );
    } else {
        tracing::warn!(
            license_id = %key.license_id,
            "a stored license file holds terms of the wrong shape; it is not used"
        );
    }
    Ok(license)
}

/// Put the trial's stored start back to `at` when it is after it (spec §3.4:
/// the state counts such a start from now; written, it does not slide with
/// the time). A start out of range ([`bounded_ms`]) reads as a trial that is
/// over and stays. True when it wrote.
pub async fn clamp_trial_start(conn: &mut SqliteConnection, at: i64) -> Result<bool, sqlx::Error> {
    let done = sqlx::query(
        "UPDATE license_clock SET trial_started_at = ?1 \
         WHERE id = 1 AND trial_started_at > ?1 AND trial_started_at <= 9007199254740991",
    )
    .bind(at)
    .execute(conn)
    .await?;
    Ok(done.rows_affected() > 0)
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
