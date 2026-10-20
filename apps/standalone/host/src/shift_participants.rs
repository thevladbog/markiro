//! A device's part in a shift (plan 2b; spec
//! `docs/superpowers/specs/2026-10-20-standalone-multi-station-shift-design.md` §4.2; host
//! migration `0052`). The decisions are pure functions, pinned by the tests below and by
//! `proto/fixtures/shift-close-reason-shared.json`, which the station and the handheld read too.

use markiro_proto::ParticipantState;

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
