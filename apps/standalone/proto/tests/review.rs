use markiro_proto::review::{
    ConflictKind, ExceptionSubject, OfficeConflictPage, OfficeShiftExceptions,
    OfficeShiftRejections, CONFLICT_MAX_PAGE, CONFLICT_PAGE_SIZE, SHIFT_REVIEW_LIMIT,
};
use markiro_proto::{ExceptionKind, FactKind};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let path = format!("{}/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {path}: {error}"))
}

fn round_trip<T: DeserializeOwned + Serialize>(name: &str) -> T {
    let original = fixture(name);
    let typed: T =
        serde_json::from_value(original.clone()).unwrap_or_else(|error| panic!("{name}: {error}"));
    assert_eq!(
        serde_json::to_value(&typed).unwrap(),
        original,
        "{name} changed on round trip"
    );
    typed
}

#[test]
fn a_page_of_conflicts_round_trips_with_both_kinds() {
    let page: OfficeConflictPage = round_trip("office-conflict-page.json");
    assert_eq!(
        page.items.iter().map(|c| c.kind).collect::<Vec<_>>(),
        vec![ConflictKind::Displaced, ConflictKind::Late]
    );
    assert_eq!(ConflictKind::Displaced.as_str(), "displaced");
    assert_eq!(ConflictKind::Late.as_str(), "late");
    // The code travels as its hash, GTIN and serial: never its canonical text.
    let text = fixture("office-conflict-page.json").to_string();
    assert!(!text.contains('\u{1d}') && !text.contains("canonical"));
    assert_eq!((CONFLICT_PAGE_SIZE, CONFLICT_MAX_PAGE), (50, 200));
}

#[test]
fn a_shifts_exceptions_and_refusals_round_trip() {
    let exceptions: OfficeShiftExceptions = round_trip("office-shift-exceptions.json");
    assert_eq!(exceptions.items[0].subject, ExceptionSubject::Pallet);
    assert_eq!(exceptions.items[1].kind, ExceptionKind::Undo);
    let refusals: OfficeShiftRejections = round_trip("office-shift-rejections.json");
    assert_eq!(refusals.items[1].kind, Some(FactKind::Scan));
    assert_eq!(SHIFT_REVIEW_LIMIT, 500);
}

#[test]
fn a_newer_hosts_extra_field_is_tolerated_in_an_answer() {
    let mut page = fixture("office-conflict-page.json");
    page["items"][0]["newField"] = serde_json::json!(1);
    assert!(serde_json::from_value::<OfficeConflictPage>(page).is_ok());
}
