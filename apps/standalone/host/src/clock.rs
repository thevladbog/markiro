//! Time source. Handlers read the clock from `AppState`, so tests can move
//! time forward (session expiry, rate limits) without sleeping.

use std::sync::Mutex;

use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, UtcOffset};

pub trait Clock: Send + Sync + 'static {
    fn now(&self) -> OffsetDateTime;

    /// Time since an arbitrary start that never goes back, whatever happens
    /// to the PC's clock: the license's time may run no faster (plan ЛЦ-2,
    /// spec 2026-10-13 §7).
    fn monotonic(&self) -> std::time::Duration;
}

/// The instant the process first asked for its monotonic time.
static PROCESS_START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// The real UTC clock.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> OffsetDateTime {
        OffsetDateTime::now_utc()
    }

    fn monotonic(&self) -> std::time::Duration {
        PROCESS_START.get_or_init(std::time::Instant::now).elapsed()
    }
}

/// A clock that moves only when told to; for tests.
#[derive(Debug)]
pub struct ManualClock {
    now: Mutex<OffsetDateTime>,
    monotonic: Mutex<std::time::Duration>,
}

impl ManualClock {
    pub fn new(start: OffsetDateTime) -> Self {
        Self {
            now: Mutex::new(start),
            monotonic: Mutex::new(std::time::Duration::ZERO),
        }
    }

    /// Time passes: the PC's clock and the monotonic time move together. A
    /// negative step is the PC's clock set back, which leaves the monotonic
    /// time where it was.
    pub fn advance(&self, by: time::Duration) {
        let mut now = self.now.lock().expect("clock lock");
        *now += by;
        if let Ok(forward) = std::time::Duration::try_from(by) {
            *self.monotonic.lock().expect("clock lock") += forward;
        }
    }

    /// Move only the PC's clock, as a person who changes the date in
    /// Windows: no time passes for the process.
    pub fn move_wall(&self, by: time::Duration) {
        let mut now = self.now.lock().expect("clock lock");
        *now += by;
    }
}

impl Clock for ManualClock {
    fn now(&self) -> OffsetDateTime {
        *self.now.lock().expect("clock lock")
    }

    fn monotonic(&self) -> std::time::Duration {
        *self.monotonic.lock().expect("clock lock")
    }
}

/// UTC RFC 3339 without fractional seconds — the host's own timestamp format
/// in the database, so comparing two of them as text orders the instants. A
/// device's instant in the facts' tables has milliseconds (24 characters,
/// `rules::device_instant`) and is compared only with another of its kind:
/// `.` sorts before `Z`, so a host timestamp and a device instant of the same
/// second are not ordered by their text.
pub fn format_timestamp(at: OffsetDateTime) -> String {
    at.to_offset(UtcOffset::UTC)
        .replace_nanosecond(0)
        .expect("zero nanoseconds is always valid")
        .format(&Rfc3339)
        .expect("RFC 3339 formatting of a UTC time cannot fail")
}

/// Parse a timestamp written by [`format_timestamp`].
pub fn parse_timestamp(text: &str) -> Result<OffsetDateTime, time::error::Parse> {
    OffsetDateTime::parse(text, &Rfc3339)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn a_manual_clock_moves_its_monotonic_time_only_when_time_passes() {
        let clock = ManualClock::new(OffsetDateTime::UNIX_EPOCH);
        clock.advance(time::Duration::hours(2));
        assert_eq!(clock.monotonic(), Duration::from_secs(7200));
        // The PC's clock set back, or moved by a person: the process's time stays.
        clock.advance(time::Duration::hours(-3));
        clock.move_wall(time::Duration::days(400));
        assert_eq!(clock.monotonic(), Duration::from_secs(7200));
        assert_eq!(
            clock.now(),
            OffsetDateTime::UNIX_EPOCH - time::Duration::hours(1) + time::Duration::days(400)
        );
    }

    #[test]
    fn the_system_clocks_monotonic_time_never_goes_back() {
        let first = SystemClock.monotonic();
        let second = SystemClock.monotonic();
        assert!(second >= first);
    }
}
