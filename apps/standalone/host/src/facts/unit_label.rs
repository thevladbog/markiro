//! `unit_label` facts (plan РЕЖ, part B): one event of the job that prints
//! the Data Matrix duplicate of a code a validation shift accepted. The job
//! belongs to the shift the station entered and to its accepted scan of the
//! code, so an event is taken only in a validation shift that prints a
//! duplicate, for a code this station accepted in this shift. The host keeps
//! the events as sent (`unit_label_events`) and counts them in the shift's
//! totals; it runs no state machine of its own (the station's is the
//! domain's), so it checks every rule a row must keep, that a decision of
//! the operator names the operator, and that a job keeps its code and its
//! printed text, and nothing more.

use markiro_proto::{receipt_codes, UnitLabelFact};
use serde_json::Value;
use sqlx::SqliteConnection;

use super::{rules, Applied, Context, Failure, Reject};
use crate::error::ApiError;
use crate::validate;

/// An accepted scan of a code (`?1`) in a shift (`?2`) by a station (`?3`),
/// found through `scans_code_hash` (a unit test pins the plan). Whatever
/// became of the scan's code since: a scan displaced by an earlier one, or
/// answered `conflict`, is still the scan its label was printed for (the
/// label exists on the floor; a refusal for good would lose its trace),
/// unlike the cloud, which quarantines such an event (`ownership_conflict`).
const ACCEPTED_SCAN: &str = "SELECT 1 FROM scans WHERE code_hash = ?1 AND shift_id = ?2 \
     AND device_id = ?3 AND verdict = 'ok' LIMIT 1";

/// What the shift knows of a job (`?1` the shift, `?2` the job) already:
/// the station, the code, the printed text's digest and the bytes' digest of
/// one of its events, found through `unit_label_events_shift` (a unit test
/// pins the plan).
const JOB_SUBJECT: &str = "SELECT device_id, code_hash, payload_digest, bytes_digest \
     FROM unit_label_events WHERE shift_id = ?1 AND job_id = ?2 LIMIT 1";

/// The event's own fields: the job a client UUID, the rules both sides hold
/// (`UnitLabelFact::check`, every `CHECK` of `unit_label_events`), a device's
/// instant; then the record's operator, which a decision of the operator
/// names (`UnitLabelFact::is_operator_decision`). Each broken one is
/// `invalid_record` on its field, never a database error, which a station
/// would send again forever.
fn check(fact: &UnitLabelFact, operator_id: Option<&str>) -> Result<(), Reject> {
    if validate::client_uuid("data.jobId", &fact.job_id).is_err() {
        return Err(Reject::field("data.jobId"));
    }
    fact.check()
        .map_err(|field| Reject::field(&format!("data.{field}")))?;
    if rules::device_instant(&fact.at).is_none() {
        return Err(Reject::field("data.at"));
    }
    if fact.is_operator_decision() && operator_id.is_none() {
        return Err(Reject::field("operatorId"));
    }
    Ok(())
}

pub async fn apply(
    conn: &mut SqliteConnection,
    context: &Context<'_>,
    data: &Value,
) -> Result<Applied, Failure> {
    let fact: UnitLabelFact =
        serde_json::from_value(data.clone()).map_err(|_| Reject::field("data"))?;
    check(&fact, context.operator_id)?;
    // `facts::admits` took the record only in a validation shift; one that
    // prints nothing has no label job.
    if !context.shift.prints_duplicate {
        return Err(Reject::field("validationPrint").into());
    }
    let scanned: Option<i64> = sqlx::query_scalar(ACCEPTED_SCAN)
        .bind(&fact.code_hash)
        .bind(&context.shift.id)
        .bind(context.device_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    if scanned.is_none() {
        return Err(Reject::new(receipt_codes::SUBJECT_UNKNOWN).into());
    }
    // A job is one station's and prints one code with one text in the same
    // bytes in every attempt (the domain refuses a reprint of other bytes):
    // an event of a job the shift knows names them as its first event did.
    // Only the shift's owner enters it, so another station's event of the
    // job can come only from a row the API did not write.
    let known: Option<(String, String, String, String)> = sqlx::query_as(JOB_SUBJECT)
        .bind(&context.shift.id)
        .bind(&fact.job_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(ApiError::internal)?;
    if let Some((device_id, code_hash, payload_digest, bytes_digest)) = known {
        if device_id != context.device_id {
            return Err(Reject::field("data.jobId").into());
        }
        if code_hash != fact.code_hash || payload_digest != fact.payload_digest {
            return Err(Reject::field("data.codeHash").into());
        }
        if bytes_digest != fact.bytes_digest {
            return Err(Reject::field("data.bytesDigest").into());
        }
    }
    sqlx::query(
        "INSERT INTO unit_label_events (id, record_id, device_id, shift_id, operator_id, job_id, \
         code_hash, attempt_no, event, reason, error_code, payload_digest, bytes_digest, at, \
         received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(context.record_id)
    .bind(context.device_id)
    .bind(&context.shift.id)
    .bind(context.operator_id)
    .bind(&fact.job_id)
    .bind(&fact.code_hash)
    .bind(fact.attempt_no)
    .bind(fact.event.as_str())
    .bind(fact.reason.map(|reason| reason.as_str()))
    .bind(&fact.error_code)
    .bind(&fact.payload_digest)
    .bind(&fact.bytes_digest)
    .bind(&fact.at)
    .bind(context.received_at)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(Applied::accepted())
}

#[cfg(test)]
mod tests {
    use sqlx::Row;

    use super::{ACCEPTED_SCAN, JOB_SUBJECT};

    /// The accepted scan of a code by a station in a shift is found through
    /// `scans_code_hash`, never a scan of the journal.
    #[tokio::test]
    async fn the_accepted_scan_of_a_code_is_found_by_its_hash() {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::open(&dir.path().join("plan.db")).await.unwrap();
        let plan: Vec<String> = sqlx::query(&format!("EXPLAIN QUERY PLAN {ACCEPTED_SCAN}"))
            .bind("a")
            .bind("b")
            .bind("c")
            .fetch_all(&pool)
            .await
            .unwrap()
            .iter()
            .map(|row| row.get::<String, _>("detail"))
            .collect();
        assert_eq!(
            plan,
            ["SEARCH scans USING INDEX scans_code_hash (code_hash=?)"],
            "{plan:?}"
        );
    }

    /// What the shift knows of a job is found through
    /// `unit_label_events_shift`, never a scan of the table.
    #[tokio::test]
    async fn a_job_of_a_shift_is_found_by_its_index() {
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::db::open(&dir.path().join("plan.db")).await.unwrap();
        let plan: Vec<String> = sqlx::query(&format!("EXPLAIN QUERY PLAN {JOB_SUBJECT}"))
            .bind("a")
            .bind("b")
            .fetch_all(&pool)
            .await
            .unwrap()
            .iter()
            .map(|row| row.get::<String, _>("detail"))
            .collect();
        assert_eq!(
            plan,
            ["SEARCH unit_label_events USING INDEX unit_label_events_shift (shift_id=? AND job_id=?)"],
            "{plan:?}"
        );
    }
}
