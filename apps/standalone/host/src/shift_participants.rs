//! A device's part in a shift (plan 2b; spec
//! `docs/superpowers/specs/2026-10-20-standalone-multi-station-shift-design.md` §4.2; host
//! migration `0052`). The decisions are pure functions, pinned by the tests below and by
//! `proto/fixtures/shift-close-reason-shared.json`, which the station and the handheld read too.
//! The functions after the rules are the only writers of `shift_participants`' state columns; every
//! caller runs inside its own write transaction and stamps the shift's `rev` with its revision.

use markiro_proto::{DeviceKind, ParticipantClosedBy, ParticipantState, ShiftParticipant};
use sqlx::sqlite::SqliteQueryResult;
use sqlx::SqliteConnection;

use crate::error::ApiError;
use crate::facts::rules::close_reason_required;

/// What an entry into an OPEN shift does for a device (a planned shift's first entry opens it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryDecision {
    /// An active participant enters again: nothing changes but `last_entered_at`.
    Reenter,
    /// A participant that closed its part reads the shift back; nothing is written.
    ReadClosed,
    /// A participant that left takes a slot again.
    Rejoin,
    /// A new participant takes a slot.
    Join,
    /// A device that did not name `multi-station-v1` meets a shift another device works: stage
    /// 2a's `shift_busy`, which every older build shows as «занято».
    Busy,
    /// Every slot of the line's limit is held by another device (`shift_line_full`).
    LineFull { max_stations: u32, active: u32 },
}

/// The entry of a device whose state in the shift is `current` (`None`: it never entered), while
/// `active_others` other live devices hold a slot of a line that allows `max_stations`.
pub fn decide_entry(
    current: Option<ParticipantState>,
    active_others: u32,
    max_stations: u32,
    multi_capable: bool,
) -> EntryDecision {
    match current {
        Some(ParticipantState::Active) => EntryDecision::Reenter,
        Some(ParticipantState::Closed) => EntryDecision::ReadClosed,
        None if !multi_capable => EntryDecision::Busy,
        Some(ParticipantState::Left) | None if active_others >= max_stations => {
            EntryDecision::LineFull {
                max_stations,
                active: active_others,
            }
        }
        Some(ParticipantState::Left) => EntryDecision::Rejoin,
        None => EntryDecision::Join,
    }
}

/// What a participant's `shift_closed` does to an active shift.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseDecision {
    /// The part closes, and the shift with it when `closes_shift`.
    ClosePart { closes_shift: bool },
    /// The part closed before: nothing more changes.
    AlreadyClosed,
}

/// The close of a participant in `current` state while `open_others` other participants are
/// active or left.
pub fn decide_close(current: ParticipantState, open_others: u32) -> CloseDecision {
    match current {
        ParticipantState::Closed => CloseDecision::AlreadyClosed,
        ParticipantState::Active | ParticipantState::Left => CloseDecision::ClosePart {
            closes_shift: open_others == 0,
        },
    }
}

/// Whether a leave changes anything: only an active participant leaves.
pub fn leaves(current: ParticipantState) -> bool {
    current == ParticipantState::Active
}

/// Whether a participant's close needs a reason code (spec §4.2 «План и причина», §12.9).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReasonNeed {
    /// No reason is needed; one sent is kept with the part.
    None,
    /// Stage 2a's rule, for a shift that only ever had this device: a close without the reason
    /// is refused (`invalid_record` on `data.reasonCode`), as the station decided it itself.
    Required,
    /// A shared shift's total missed the host's plan: a close without a reason still closes the
    /// shift, marked `close_reason_missing`, and the office gives the code.
    Shared,
}

/// The reason a close needs. `closes_shift`: no other participant stays active or left;
/// `participants_ever`: every participant the shift had, this one included; `fact_planned` and
/// `own_actual`: the plan the device saw and its own count; `host_planned`: the shift's plan on
/// the host now; `shift_accepted`: the whole shift's accepted units.
pub fn reason_need(
    closes_shift: bool,
    participants_ever: u32,
    fact_planned: Option<u32>,
    own_actual: u32,
    host_planned: Option<u32>,
    shift_accepted: u64,
) -> ReasonNeed {
    if !closes_shift {
        return ReasonNeed::None;
    }
    if participants_ever <= 1 {
        return if close_reason_required(fact_planned, own_actual) {
            ReasonNeed::Required
        } else {
            ReasonNeed::None
        };
    }
    match host_planned {
        Some(planned) if u64::from(planned) != shift_accepted => ReasonNeed::Shared,
        _ => ReasonNeed::None,
    }
}

/// The state of `device_id` in `shift_id`; `None` when it never entered.
pub async fn state_of(
    conn: &mut SqliteConnection,
    shift_id: &str,
    device_id: &str,
) -> Result<Option<ParticipantState>, ApiError> {
    let state: Option<String> = sqlx::query_scalar(
        "SELECT state FROM shift_participants WHERE shift_id = ? AND device_id = ?",
    )
    .bind(shift_id)
    .bind(device_id)
    .fetch_optional(conn)
    .await
    .map_err(ApiError::internal)?;
    state
        .map(|state| state.parse().map_err(ApiError::internal))
        .transpose()
}

async fn count(
    conn: &mut SqliteConnection,
    sql: &str,
    first: &str,
    second: Option<&str>,
) -> Result<u32, ApiError> {
    let mut query = sqlx::query_scalar::<_, i64>(sql).bind(first);
    if let Some(second) = second {
        query = query.bind(second);
    }
    let count = query.fetch_one(conn).await.map_err(ApiError::internal)?;
    u32::try_from(count).map_err(ApiError::internal)
}

/// How many devices other than `device_id` hold a slot of the shift: active participants whose
/// device is not revoked (a revoked device's slot is free, spec §12.5).
pub async fn active_others(
    conn: &mut SqliteConnection,
    shift_id: &str,
    device_id: &str,
) -> Result<u32, ApiError> {
    count(
        conn,
        "SELECT COUNT(*) FROM shift_participants p JOIN devices d ON d.id = p.device_id \
         WHERE p.shift_id = ? AND p.device_id <> ? AND p.state = 'active' \
         AND d.revoked_at IS NULL",
        shift_id,
        Some(device_id),
    )
    .await
}

/// How many participants other than `device_id` have not closed their part (active or left,
/// revoked or not: a revoked device's part closes only with the office's close).
pub async fn open_others(
    conn: &mut SqliteConnection,
    shift_id: &str,
    device_id: &str,
) -> Result<u32, ApiError> {
    count(
        conn,
        "SELECT COUNT(*) FROM shift_participants \
         WHERE shift_id = ? AND device_id <> ? AND state IN ('active', 'left')",
        shift_id,
        Some(device_id),
    )
    .await
}

/// Every participant the shift ever had.
pub async fn count_all(conn: &mut SqliteConnection, shift_id: &str) -> Result<u32, ApiError> {
    count(
        conn,
        "SELECT COUNT(*) FROM shift_participants WHERE shift_id = ?",
        shift_id,
        None,
    )
    .await
}

/// The busiest active shift of `line_id`: its slots held by live devices (a lower limit must
/// leave room for them, `routes/lines.rs`).
pub async fn line_slots_in_use(
    conn: &mut SqliteConnection,
    line_id: &str,
) -> Result<u32, ApiError> {
    count(
        conn,
        "SELECT COALESCE(MAX(n), 0) FROM (SELECT COUNT(*) AS n FROM shifts s \
         JOIN shift_participants p ON p.shift_id = s.id JOIN devices d ON d.id = p.device_id \
         WHERE s.line_id = ? AND s.status = 'active' AND p.state = 'active' \
         AND d.revoked_at IS NULL GROUP BY s.id)",
        line_id,
        None,
    )
    .await
}

/// A writer that must change exactly one participant: anything else means the state moved
/// under it inside its own transaction, which no request can cause.
fn one_row(result: SqliteQueryResult, what: &str) -> Result<(), ApiError> {
    if result.rows_affected() == 1 {
        Ok(())
    } else {
        Err(ApiError::internal(format!(
            "{what}: no participant in the expected state"
        )))
    }
}

/// A new participant takes a slot at `at`.
pub async fn join(
    conn: &mut SqliteConnection,
    shift_id: &str,
    device_id: &str,
    at: &str,
) -> Result<(), ApiError> {
    let result = sqlx::query(
        "INSERT INTO shift_participants (shift_id, device_id, first_entered_at, \
         last_entered_at, state, joined_at) VALUES (?, ?, ?, ?, 'active', ?)",
    )
    .bind(shift_id)
    .bind(device_id)
    .bind(at)
    .bind(at)
    .bind(at)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    one_row(result, "join")
}

/// A participant that left takes a slot again.
pub async fn rejoin(
    conn: &mut SqliteConnection,
    shift_id: &str,
    device_id: &str,
    at: &str,
) -> Result<(), ApiError> {
    let result = sqlx::query(
        "UPDATE shift_participants SET state = 'active', left_at = NULL, joined_at = ?, \
         last_entered_at = ? WHERE shift_id = ? AND device_id = ? AND state = 'left'",
    )
    .bind(at)
    .bind(at)
    .bind(shift_id)
    .bind(device_id)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    one_row(result, "rejoin")
}

/// An active participant enters again.
pub async fn touch(
    conn: &mut SqliteConnection,
    shift_id: &str,
    device_id: &str,
    at: &str,
) -> Result<(), ApiError> {
    let result = sqlx::query(
        "UPDATE shift_participants SET last_entered_at = ? \
         WHERE shift_id = ? AND device_id = ? AND state = 'active'",
    )
    .bind(at)
    .bind(shift_id)
    .bind(device_id)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    one_row(result, "touch")
}

/// An active participant pauses and frees its slot.
pub async fn leave(
    conn: &mut SqliteConnection,
    shift_id: &str,
    device_id: &str,
    at: &str,
) -> Result<(), ApiError> {
    let result = sqlx::query(
        "UPDATE shift_participants SET state = 'left', left_at = ? \
         WHERE shift_id = ? AND device_id = ? AND state = 'active'",
    )
    .bind(at)
    .bind(shift_id)
    .bind(device_id)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    one_row(result, "leave")
}

/// A participant's own close of its part (its `shift_closed` fact), with its count and reason.
pub async fn close_by_device(
    conn: &mut SqliteConnection,
    shift_id: &str,
    device_id: &str,
    closed_at: &str,
    actual_qty: u32,
    reason_code: Option<&str>,
) -> Result<(), ApiError> {
    let result = sqlx::query(
        "UPDATE shift_participants SET state = 'closed', left_at = NULL, closed_at = ?, \
         closed_by_kind = 'device', closed_actual_qty = ?, closed_reason = ? \
         WHERE shift_id = ? AND device_id = ? AND state IN ('active', 'left')",
    )
    .bind(closed_at)
    .bind(actual_qty)
    .bind(reason_code)
    .bind(shift_id)
    .bind(device_id)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    one_row(result, "close_by_device")
}

/// The office's close of the whole shift closes every part still open; returns those parts as
/// they were, first entry first (the `notClosed` of `shift.force_closed`).
pub async fn close_open_by_office(
    conn: &mut SqliteConnection,
    shift_id: &str,
    at: &str,
) -> Result<Vec<(String, ParticipantState)>, ApiError> {
    let open: Vec<(String, String)> = sqlx::query_as(
        "SELECT device_id, state FROM shift_participants \
         WHERE shift_id = ? AND state IN ('active', 'left') ORDER BY first_entered_at, device_id",
    )
    .bind(shift_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE shift_participants SET state = 'closed', left_at = NULL, closed_at = ?, \
         closed_by_kind = 'office_user' WHERE shift_id = ? AND state IN ('active', 'left')",
    )
    .bind(at)
    .bind(shift_id)
    .execute(&mut *conn)
    .await
    .map_err(ApiError::internal)?;
    open.into_iter()
        .map(|(device_id, state)| Ok((device_id, state.parse().map_err(ApiError::internal)?)))
        .collect()
}

/// The first fact of a closed part marks it late, once; whether this call marked it.
pub async fn mark_late(
    conn: &mut SqliteConnection,
    shift_id: &str,
    device_id: &str,
    at: &str,
) -> Result<bool, ApiError> {
    let result = sqlx::query(
        "UPDATE shift_participants SET late_data_at = ? WHERE shift_id = ? AND device_id = ? \
         AND state = 'closed' AND late_data_at IS NULL",
    )
    .bind(at)
    .bind(shift_id)
    .bind(device_id)
    .execute(conn)
    .await
    .map_err(ApiError::internal)?;
    Ok(result.rows_affected() == 1)
}

#[derive(sqlx::FromRow)]
struct ParticipantRow {
    device_id: String,
    kind: String,
    name: String,
    state: String,
    first_entered_at: String,
    joined_at: String,
    left_at: Option<String>,
    closed_at: Option<String>,
    closed_by_kind: Option<String>,
    closed_actual_qty: Option<u32>,
    closed_reason: Option<String>,
    late_data_at: Option<String>,
    last_seen_at: Option<String>,
}

/// The shift's participants, first entry first (ties by device id).
pub async fn list(
    conn: &mut SqliteConnection,
    shift_id: &str,
) -> Result<Vec<ShiftParticipant>, ApiError> {
    let rows: Vec<ParticipantRow> = sqlx::query_as(
        "SELECT p.device_id, d.kind, d.name, p.state, p.first_entered_at, \
         COALESCE(p.joined_at, p.first_entered_at) AS joined_at, p.left_at, p.closed_at, \
         p.closed_by_kind, p.closed_actual_qty, p.closed_reason, p.late_data_at, d.last_seen_at \
         FROM shift_participants p JOIN devices d ON d.id = p.device_id \
         WHERE p.shift_id = ? ORDER BY p.first_entered_at, p.device_id",
    )
    .bind(shift_id)
    .fetch_all(conn)
    .await
    .map_err(ApiError::internal)?;
    rows.into_iter()
        .map(|row| {
            let device_kind: DeviceKind = row.kind.parse().map_err(ApiError::internal)?;
            let closed_by: Option<ParticipantClosedBy> = row
                .closed_by_kind
                .map(|kind| kind.parse().map_err(ApiError::internal))
                .transpose()?;
            Ok(ShiftParticipant {
                device_id: row.device_id,
                device_kind,
                device_name: row.name,
                state: row.state.parse().map_err(ApiError::internal)?,
                first_entered_at: row.first_entered_at,
                joined_at: row.joined_at,
                left_at: row.left_at,
                closed_at: row.closed_at,
                closed_by,
                closed_actual_qty: row.closed_actual_qty,
                closed_reason_code: row.closed_reason,
                late_data_at: row.late_data_at,
                last_seen_at: row.last_seen_at,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use markiro_proto::ParticipantState::{Active, Closed, Left};

    #[test]
    fn an_entry_follows_the_state_the_slots_and_the_capability() {
        let cases = [
            ((None, 0, 1, true), EntryDecision::Join),
            ((None, 1, 2, true), EntryDecision::Join),
            (
                (None, 1, 1, true),
                EntryDecision::LineFull {
                    max_stations: 1,
                    active: 1,
                },
            ),
            ((None, 0, 1, false), EntryDecision::Busy),
            ((None, 0, 4, false), EntryDecision::Busy),
            ((Some(Active), 9, 1, false), EntryDecision::Reenter),
            ((Some(Closed), 0, 1, false), EntryDecision::ReadClosed),
            ((Some(Left), 0, 1, false), EntryDecision::Rejoin),
            (
                (Some(Left), 1, 1, true),
                EntryDecision::LineFull {
                    max_stations: 1,
                    active: 1,
                },
            ),
            ((Some(Left), 0, 1, true), EntryDecision::Rejoin),
            ((Some(Left), 0, 2, true), EntryDecision::Rejoin),
            // A left participant is already in the shift, so the capability check (which only
            // guards a first entry) does not apply; the slots decide.
            (
                (Some(Left), 1, 1, false),
                EntryDecision::LineFull {
                    max_stations: 1,
                    active: 1,
                },
            ),
            ((Some(Active), 0, 1, true), EntryDecision::Reenter),
            ((Some(Closed), 1, 1, true), EntryDecision::ReadClosed),
            ((Some(Closed), 5, 1, false), EntryDecision::ReadClosed),
            (
                (None, 3, 2, true),
                EntryDecision::LineFull {
                    max_stations: 2,
                    active: 3,
                },
            ),
            (
                (Some(Left), 3, 2, true),
                EntryDecision::LineFull {
                    max_stations: 2,
                    active: 3,
                },
            ),
        ];
        for ((current, others, max, multi), expected) in cases {
            assert_eq!(
                decide_entry(current, others, max, multi),
                expected,
                "{current:?} {others} {max} {multi}"
            );
        }
    }

    #[test]
    fn a_close_closes_the_part_and_the_shift_only_with_nobody_else_open() {
        assert_eq!(
            decide_close(Active, 0),
            CloseDecision::ClosePart { closes_shift: true }
        );
        assert_eq!(
            decide_close(Active, 2),
            CloseDecision::ClosePart {
                closes_shift: false
            }
        );
        assert_eq!(
            decide_close(Left, 1),
            CloseDecision::ClosePart {
                closes_shift: false
            }
        );
        assert_eq!(decide_close(Closed, 0), CloseDecision::AlreadyClosed);
    }

    #[test]
    fn only_an_active_participant_leaves() {
        assert!(leaves(Active));
        assert!(!leaves(Left));
        assert!(!leaves(Closed));
    }

    #[test]
    fn the_reason_rule_is_the_shared_fixtures() {
        let file: serde_json::Value = serde_json::from_str(include_str!(
            "../../proto/fixtures/shift-close-reason-shared.json"
        ))
        .unwrap();
        let cases = file["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 12);
        let number = |value: &serde_json::Value| value.as_u64().map(|n| u32::try_from(n).unwrap());
        for case in cases {
            for key in [
                "closesShift",
                "participantsEver",
                "factPlanned",
                "actualQty",
                "hostPlanned",
                "shiftAccepted",
                "need",
            ] {
                assert!(case.get(key).is_some(), "missing {key}: {case}");
            }
            let expected = match case["need"].as_str().unwrap() {
                "none" => ReasonNeed::None,
                "required" => ReasonNeed::Required,
                "shared" => ReasonNeed::Shared,
                other => panic!("unknown need {other}"),
            };
            assert_eq!(
                reason_need(
                    case["closesShift"].as_bool().unwrap(),
                    number(&case["participantsEver"]).unwrap(),
                    number(&case["factPlanned"]),
                    number(&case["actualQty"]).unwrap(),
                    number(&case["hostPlanned"]),
                    case["shiftAccepted"].as_u64().unwrap(),
                ),
                expected,
                "{case}"
            );
        }
    }
}
