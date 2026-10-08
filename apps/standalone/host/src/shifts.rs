//! Shifts (stage 2a spec §4.2). The number is the host's: a counter per
//! month, `MONYY-NNN`, with `/S` for a shift created at a station — the
//! domain's `shiftMonthKey` and `formatShiftNumber`
//! (`packages/domain/src/shift-number.ts`) rewritten, so a number reads the
//! same as the cloud's. `proto/fixtures/shift-numbers.json` holds the cases
//! both must answer alike; `host/tests/shift_numbers.rs` and the webview's
//! `test/shift-numbers.test.ts` read every one.

use markiro_proto::ShiftOrigin;

/// The month names of a shift number: a fixed English table, never a
/// locale's, because the number is an identifier.
const MONTH_KEYS: [&str; 12] = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

/// A civil date as `YYYY-MM-DD`: four, two and two ASCII digits naming a
/// real calendar day of the years 1–9999, as the cloud's `civilDateSchema`.
/// The domain's `shiftMonthKey` also takes the year 0000 (its `Date.UTC`
/// reads the years 0–99 as 1900–1999); no shift date can be that year here.
pub fn civil_date(text: &str) -> Option<time::Date> {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let number = |part: &[u8]| -> Option<u16> {
        part.iter().try_fold(0u16, |value, byte| {
            byte.is_ascii_digit()
                .then(|| value * 10 + u16::from(byte - b'0'))
        })
    };
    let year = number(&bytes[0..4])?;
    let month = number(&bytes[5..7])?;
    let day = number(&bytes[8..10])?;
    if year == 0 {
        return None;
    }
    let month = time::Month::try_from(u8::try_from(month).ok()?).ok()?;
    time::Date::from_calendar_date(i32::from(year), month, u8::try_from(day).ok()?).ok()
}

/// The month a shift number is drawn from, as `MONYY` (`OCT26`).
pub fn month_key(date: time::Date) -> String {
    let month = MONTH_KEYS[usize::from(u8::from(date.month())) - 1];
    format!("{month}{:02}", date.year() % 100)
}

/// [`month_key`] of a civil date's text, `None` when it is no civil date.
pub fn month_key_of(text: &str) -> Option<String> {
    civil_date(text).map(month_key)
}

/// The shift number as people read it: `OCT26-004`, `OCT26-004/S` for a
/// station's, and never cut short past 999 (`OCT26-1234`).
pub fn format_number(month_key: &str, seq: i64, origin: ShiftOrigin) -> String {
    let station = match origin {
        ShiftOrigin::Office => "",
        ShiftOrigin::Station => "/S",
    };
    format!("{month_key}-{seq:03}{station}")
}
