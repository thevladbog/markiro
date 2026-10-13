//! The time the license trusts (plan ЛЦ-2, spec 2026-10-13 §7): the PC's
//! clock, never earlier than the last time the host knew, never further
//! ahead than the process's monotonic time allows while it runs, at most 400
//! days ahead of the last mark at a start, and never before a loaded file's
//! issue less a day. A clock set back only stops the license's time; a
//! clock set far ahead is flagged and not believed.

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
    /// clock, `mono` the monotonic time, `floor` the newest file's issue less
    /// a day.
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
            behind_ms: (effective - wall).max(0),
            ahead: wall - effective > AHEAD_FLAG_MS,
        }
    }

    /// A file loaded now proves the time is not before its issue less a day.
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
