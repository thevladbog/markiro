use markiro_host::shifts::{civil_date, format_number, month_key_of};
use markiro_proto::ShiftOrigin;
use serde_json::Value;

/// `proto/fixtures/shift-numbers.json`: the cases the host's shift number and
/// the domain's (`shiftMonthKey`, `formatShiftNumber`) must answer alike; the
/// webview's `test/shift-numbers.test.ts` reads it too.
fn fixture() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../proto/fixtures/shift-numbers.json"
    );
    let text = std::fs::read_to_string(path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    serde_json::from_str(&text).unwrap()
}

#[test]
fn every_month_key_of_the_fixture_matches() {
    let fixture = fixture();
    let cases = fixture["monthKeys"].as_array().expect("monthKeys");
    assert_eq!(cases.len(), 22);
    for case in cases {
        let date = case["date"].as_str().expect("date");
        assert_eq!(
            month_key_of(date).as_deref(),
            case["monthKey"].as_str(),
            "{date:?}"
        );
    }
}

#[test]
fn every_number_of_the_fixture_matches() {
    let fixture = fixture();
    let cases = fixture["numbers"].as_array().expect("numbers");
    assert_eq!(cases.len(), 5);
    for case in cases {
        let origin: ShiftOrigin = serde_json::from_value(case["createdFrom"].clone()).unwrap();
        assert_eq!(
            format_number(
                case["monthKey"].as_str().unwrap(),
                case["seq"].as_i64().unwrap(),
                origin
            ),
            case["number"].as_str().unwrap(),
            "{case}"
        );
    }
}

/// The cloud's civil dates run from the year 1; the domain's month key alone
/// would read `0000-01-15` as `JAN00`, so the fixture leaves that year out.
#[test]
fn the_year_zero_is_no_civil_date() {
    assert_eq!(civil_date("0000-01-15"), None);
    assert_eq!(month_key_of("0000-01-15"), None);
    assert_eq!(month_key_of("0001-01-15").as_deref(), Some("JAN01"));
    assert_eq!(month_key_of("9999-12-31").as_deref(), Some("DEC99"));
}

/// Only four, two and two ASCII digits joined by two dashes make a date: the
/// fixture's short or padded texts do not reach the separator and digit checks.
#[test]
fn only_digits_and_dashes_make_a_date() {
    for text in [
        "2026/10/08",
        "2026-10/08",
        "2026/10-08",
        "2026 10 08",
        "20x6-10-08",
        // `a` is a hex digit, not a decimal one: it must not read as 49.
        "202a-10-08",
        "2026-1a-08",
        "2026-10-0x",
        "+026-10-08",
        "2026-+1-08",
    ] {
        assert_eq!(civil_date(text), None, "{text:?}");
    }
    assert!(civil_date("2026-10-08").is_some());
}
