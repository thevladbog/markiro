//! Time source. Handlers read the clock from `AppState`, so tests can move
//! time forward (session expiry, rate limits) without sleeping.

use std::sync::Mutex;

use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, UtcOffset};

pub trait Clock: Send + Sync + 'static {
    fn now(&self) -> OffsetDateTime;
}

/// The real UTC clock.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> OffsetDateTime {
        OffsetDateTime::now_utc()
    }
}

/// A clock that moves only when told to; for tests.
#[derive(Debug)]
pub struct ManualClock {
    now: Mutex<OffsetDateTime>,
}

impl ManualClock {
    pub fn new(start: OffsetDateTime) -> Self {
        Self {
            now: Mutex::new(start),
        }
    }

    pub fn advance(&self, by: time::Duration) {
        let mut now = self.now.lock().expect("clock lock");
        *now += by;
    }
}

impl Clock for ManualClock {
    fn now(&self) -> OffsetDateTime {
        *self.now.lock().expect("clock lock")
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
