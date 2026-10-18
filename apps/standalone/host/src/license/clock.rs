//! The time the license trusts (plan ЛЦ-2, spec 2026-10-13 §7):
//! `max(the PC's clock, the mark)`, the mark being the last time the host
//! knew; while the host runs, never further ahead than the process's
//! monotonic time since the last believable reading plus
//! [`RUNNING_SLACK_MS`]; at a start, at most 400 days ahead of the stored
//! mark; and never before the latest issue of a loaded file less a day.
//!
//! What this allows, plainly:
//! - A clock set back freezes the license's time while it runs: the mark
//!   holds until the PC's clock catches up, so the time never runs back, and
//!   a clock more than a day behind is flagged.
//! - A clock set far ahead in one step is flagged and believed only up to
//!   the ceiling.
//! - Every believable reading moves the ceiling's anchor to it, so a clock
//!   moved forward in steps, each under the slack, makes the license's time
//!   run faster than real time. That only shortens the customer's own term;
//!   it never lengthens it.

use std::time::Duration;

use super::state::DAY_MS;

/// How much faster than the process the PC's clock may run while the host
/// runs (NTP corrections, a person putting the clock right).
pub const RUNNING_SLACK_MS: i64 = 5 * 60 * 1000;
/// The longest jump of the PC's clock a start believes: a host switched off
/// for a holiday gets its time.
pub const START_JUMP_MS: i64 = 400 * DAY_MS;
/// A PC's clock behind the mark by more than this is flagged.
pub const BEHIND_FLAG_MS: i64 = DAY_MS;
/// A PC's clock ahead of the trusted time by more than this is flagged.
pub const AHEAD_FLAG_MS: i64 = DAY_MS;
/// How often the mark is written to the database at most, besides every
/// change of state.
pub const PERSIST_EVERY_MS: i64 = 60 * 60 * 1000;

/// The floor loaded files put under the time (§7): the latest issue among
/// all of them (not only the newest by `sequence`) less a day; `None`
/// without a file. Saturating: a corrupt row neither panics nor wraps.
pub fn issue_floor(issued_at: impl IntoIterator<Item = i64>) -> Option<i64> {
    issued_at
        .into_iter()
        .map(|issued| issued.saturating_sub(DAY_MS))
        .max()
}

/// One look at the time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reading {
    /// The time the license trusts, ms UTC.
    pub effective: i64,
    /// How far the PC's clock is behind it.
    pub behind_ms: i64,
    /// The PC's clock is more than a day ahead of it.
    pub ahead: bool,
}

impl Reading {
    /// Whole days the PC's clock is behind, once that is more than a day.
    pub fn behind_days(&self) -> Option<u32> {
        (self.behind_ms > BEHIND_FLAG_MS).then(|| {
            u32::try_from(self.behind_ms / DAY_MS)
                .unwrap_or(u32::MAX)
                .max(1)
        })
    }
}

/// The mark in memory: the last effective time, and the anchor the
/// monotonic ceiling counts from.
#[derive(Debug, Clone)]
pub struct LicenseClock {
    mark: i64,
    anchor: i64,
    anchor_mono: Duration,
}

fn millis(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

impl LicenseClock {
    /// At a start: `stored` is `license_clock.max_seen_at`, `wall` the PC's
    /// clock, `mono` the monotonic time, `floor` the latest issue of any
    /// stored file less a day ([`issue_floor`]).
    pub fn at_start(stored: Option<i64>, wall: i64, mono: Duration, floor: Option<i64>) -> Self {
        let base = stored.unwrap_or(wall);
        let mut mark = if wall >= base {
            wall.min(base.saturating_add(START_JUMP_MS))
        } else {
            base
        };
        if let Some(floor) = floor {
            mark = mark.max(floor);
        }
        Self {
            mark,
            anchor: mark,
            anchor_mono: mono,
        }
    }

    /// The last effective time: what `license_clock.max_seen_at` gets.
    pub fn mark(&self) -> i64 {
        self.mark
    }

    /// The effective time now.
    pub fn observe(&mut self, wall: i64, mono: Duration) -> Reading {
        let ceiling = self
            .anchor
            .saturating_add(millis(mono.saturating_sub(self.anchor_mono)))
            .saturating_add(RUNNING_SLACK_MS);
        let effective = wall.min(ceiling).max(self.mark);
        if wall <= ceiling && wall >= self.mark {
            // The PC's clock is believable: the next ceiling counts from it,
            // so a monotonic clock that drifts from the PC's over weeks
            // changes nothing.
            self.anchor = effective;
            self.anchor_mono = mono;
        }
        self.mark = effective;
        Reading {
            effective,
            behind_ms: effective.saturating_sub(wall).max(0),
            ahead: wall.saturating_sub(effective) > AHEAD_FLAG_MS,
        }
    }

    /// Files just stored prove the time is not before `floor`, the latest
    /// issue of any stored file less a day ([`issue_floor`]).
    pub fn raise_floor(&mut self, floor: i64, mono: Duration) {
        if floor > self.mark {
            self.mark = floor;
            self.anchor = floor;
            self.anchor_mono = mono;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    const T0: i64 = 1_790_000_000_000;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn a_first_start_trusts_the_pcs_clock() {
        let mut clock = LicenseClock::at_start(None, T0, secs(0), None);
        assert_eq!(
            clock.observe(T0, secs(0)),
            Reading {
                effective: T0,
                behind_ms: 0,
                ahead: false
            }
        );
        assert_eq!(
            clock.observe(T0 + 3_600_000, secs(3600)).effective,
            T0 + 3_600_000
        );
    }

    #[test]
    fn a_clock_set_back_two_days_moves_no_time_back_and_is_flagged() {
        let mut started = LicenseClock::at_start(Some(T0), T0 - 2 * DAY_MS, secs(0), None);
        let reading = started.observe(T0 - 2 * DAY_MS, secs(0));
        assert_eq!((reading.effective, reading.behind_days()), (T0, Some(2)));
        let mut running = LicenseClock::at_start(None, T0, secs(0), None);
        running.observe(T0 + 3_600_000, secs(3600));
        let reading = running.observe(T0 - 2 * DAY_MS + 3_600_000, secs(3601));
        assert_eq!(
            (reading.effective, reading.behind_days()),
            (T0 + 3_600_000, Some(2))
        );
        // Within a day, a clock behind is no flag (summer time, NTP).
        let mut slightly = LicenseClock::at_start(Some(T0), T0 - 3_600_000, secs(0), None);
        assert_eq!(
            slightly.observe(T0 - 3_600_000, secs(0)).behind_days(),
            None
        );
    }

    #[test]
    fn a_jump_at_a_start_is_taken_up_to_400_days() {
        let mut taken = LicenseClock::at_start(Some(T0), T0 + 399 * DAY_MS, secs(0), None);
        let reading = taken.observe(T0 + 399 * DAY_MS, secs(0));
        assert_eq!(
            (reading.effective, reading.ahead),
            (T0 + 399 * DAY_MS, false)
        );
        let mut capped = LicenseClock::at_start(Some(T0), T0 + 402 * DAY_MS, secs(0), None);
        let reading = capped.observe(T0 + 402 * DAY_MS, secs(0));
        assert_eq!(
            (reading.effective, reading.ahead),
            (T0 + START_JUMP_MS + RUNNING_SLACK_MS, true)
        );
        // The limit is 400 days exactly (spec §7).
        let mut edge = LicenseClock::at_start(Some(T0), T0 + 400 * DAY_MS, secs(0), None);
        assert_eq!(edge.mark(), T0 + 400 * DAY_MS);
        let past = LicenseClock::at_start(Some(T0), T0 + 400 * DAY_MS + 1, secs(0), None);
        assert_eq!(past.mark(), T0 + 400 * DAY_MS);
        assert!(!edge.observe(T0 + 400 * DAY_MS, secs(0)).ahead);
    }

    #[test]
    fn while_running_the_time_moves_no_faster_than_the_process() {
        let mut clock = LicenseClock::at_start(None, T0, secs(100), None);
        let reading = clock.observe(T0 + 365 * DAY_MS, secs(160));
        assert_eq!(
            (reading.effective, reading.ahead),
            (T0 + 60_000 + RUNNING_SLACK_MS, true)
        );
        // The clock put right: time runs with the process again.
        let mut fresh = LicenseClock::at_start(None, T0, secs(100), None);
        assert_eq!(
            fresh.observe(T0 + 7_200_000, secs(7300)).effective,
            T0 + 7_200_000
        );
    }

    #[test]
    fn a_files_issue_is_a_floor_of_the_time() {
        let mut clock = LicenseClock::at_start(None, T0, secs(0), Some(T0 + 10 * DAY_MS));
        let reading = clock.observe(T0, secs(0));
        assert_eq!(
            (reading.effective, reading.behind_days()),
            (T0 + 10 * DAY_MS, Some(10))
        );
        clock.raise_floor(T0 + 20 * DAY_MS, secs(5));
        assert_eq!(
            clock.observe(T0 + 5000, secs(5)).effective,
            T0 + 20 * DAY_MS
        );
        assert_eq!(clock.mark(), T0 + 20 * DAY_MS);
        // A lower floor never moves the time back.
        clock.raise_floor(T0 + 15 * DAY_MS, secs(6));
        assert_eq!(clock.mark(), T0 + 20 * DAY_MS);
        assert_eq!(
            clock.observe(T0 + 6000, secs(6)).effective,
            T0 + 20 * DAY_MS
        );
    }

    #[test]
    fn a_believable_reading_moves_the_anchor_of_the_ceiling() {
        let hour = 3_600_000;
        let mut clock = LicenseClock::at_start(None, T0, secs(100), None);
        clock.observe(T0, secs(100));
        clock.observe(T0 + hour, secs(100 + 3600));
        // One second of the process later the PC's clock says ten minutes:
        // the ceiling counts from the last believable reading.
        let reading = clock.observe(T0 + hour + 600_000, secs(100 + 3601));
        assert_eq!(reading.effective, T0 + hour + 1000 + RUNNING_SLACK_MS);
    }

    #[test]
    fn ahead_is_flagged_past_exactly_one_day() {
        let reading = |ahead_by: i64| {
            let mut clock = LicenseClock::at_start(None, T0, secs(0), None);
            clock.observe(T0 + RUNNING_SLACK_MS + ahead_by, secs(0))
        };
        let edge = reading(DAY_MS);
        assert_eq!((edge.effective, edge.ahead), (T0 + RUNNING_SLACK_MS, false));
        assert!(reading(DAY_MS + 1).ahead);
    }

    #[test]
    fn corrupt_times_neither_panic_nor_wrap() {
        let mut ahead = LicenseClock::at_start(Some(i64::MAX), i64::MIN, secs(0), Some(i64::MIN));
        let reading = ahead.observe(i64::MIN, secs(0));
        assert_eq!(
            (reading.effective, reading.behind_ms, reading.ahead),
            (i64::MAX, i64::MAX, false)
        );
        assert_eq!(reading.behind_days(), Some(u32::MAX));
        let mut behind = LicenseClock::at_start(Some(i64::MIN), i64::MAX, secs(5), None);
        assert_eq!(behind.mark(), i64::MIN + START_JUMP_MS);
        // The ceiling is the mark plus the process's time: still capped.
        let reading = behind.observe(i64::MAX, Duration::MAX);
        assert_eq!(
            (reading.effective, reading.behind_ms, reading.ahead),
            (START_JUMP_MS + RUNNING_SLACK_MS - 1, 0, true)
        );
        let mut early = LicenseClock::at_start(None, 0, secs(0), None);
        early.raise_floor(i64::MAX, secs(0));
        assert!(!early.observe(i64::MIN, secs(0)).ahead);
    }

    #[test]
    fn the_floor_is_the_latest_issue_of_any_file_less_a_day() {
        assert_eq!(issue_floor([]), None);
        assert_eq!(
            issue_floor([T0, T0 + 5 * DAY_MS, T0 + 2 * DAY_MS]),
            Some(T0 + 4 * DAY_MS)
        );
        assert_eq!(issue_floor([i64::MIN]), Some(i64::MIN));
    }

    #[test]
    fn the_days_behind_round_down_and_start_after_a_whole_day() {
        let reading = |behind_ms| Reading {
            effective: T0,
            behind_ms,
            ahead: false,
        };
        assert_eq!(reading(DAY_MS).behind_days(), None);
        assert_eq!(reading(DAY_MS + 1).behind_days(), Some(1));
        assert_eq!(reading(3 * DAY_MS + 5).behind_days(), Some(3));
    }
}
