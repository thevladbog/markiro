use markiro_proto::review::{
    ConflictKind, ConflictStatusRequest, ConflictStatusResponse, DeviceDisplacements,
    ExceptionSource, ExceptionSubject, OfficeConflictPage, OfficeShiftExceptions,
    OfficeShiftRejections, CONFLICT_MAX_PAGE, CONFLICT_PAGE_SIZE, DISPLACEMENT_PAGE_SIZE,
    MAX_CONFLICT_STATUS_RECORDS, SHIFT_REVIEW_LIMIT,
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
    assert_eq!(exceptions.items[0].source, ExceptionSource::Office);
    assert_eq!(exceptions.items[0].kind, ExceptionKind::Disassemble);
    // An office disassembly names its document and user, never a station.
    assert!(exceptions.items[0].device_id.is_none() && exceptions.items[0].document_no.is_some());
    assert_eq!(exceptions.items[1].subject, ExceptionSubject::Pallet);
    assert_eq!(exceptions.items[1].source, ExceptionSource::Station);
    assert_eq!(exceptions.items[2].kind, ExceptionKind::Undo);
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

#[test]
fn a_devices_conflict_status_and_displacements_round_trip() {
    let request: ConflictStatusRequest = round_trip("conflict-status-request.json");
    assert_eq!(request.record_ids.len(), 2);
    let response: ConflictStatusResponse = round_trip("conflict-status-response.json");
    assert_eq!(response.reviewed[0].reviewed_at, "2026-10-08T09:00:00Z");
    let page: DeviceDisplacements = round_trip("device-displacements.json");
    assert!(!page.items[0].winner.same_device && !page.more);
    assert_eq!(
        (MAX_CONFLICT_STATUS_RECORDS, DISPLACEMENT_PAGE_SIZE),
        (200, 100)
    );
}

#[test]
fn a_status_request_with_a_field_it_does_not_know_is_refused() {
    let mut request = fixture("conflict-status-request.json");
    request["extra"] = serde_json::json!(1);
    assert!(serde_json::from_value::<ConflictStatusRequest>(request).is_err());
}
