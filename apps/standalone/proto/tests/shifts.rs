//! The wire of the shift modes (plan РЕЖ, protocol 4): a validation shift as
//! the office plans and sees it and as a station enters it, the body of the
//! entry naming what the station can work, and a validation scan accepted
//! without a box. Every fixture round-trips.

use markiro_proto::{
    shift_supports, DeviceShift, FactKind, FactRecord, OfficeShift, ScanFact, ScanVerdict,
    ShiftCreate, ShiftEnter, ShiftMode, PROTOCOL_VERSION,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};

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
fn protocol_4_carries_the_shift_modes() {
    // Protocol 4 brought them; 5 (part B, `validation_print.rs`) keeps them.
    assert_eq!(PROTOCOL_VERSION, 7);
    assert_eq!(shift_supports::VALIDATION, "validation-v1");
    assert_eq!(
        shift_supports::VALIDATION_DM_DUPLICATE,
        "validation-dm-duplicate-v1"
    );
}

#[test]
fn a_validation_shift_is_planned_without_pallets() {
    let create: ShiftCreate = round_trip("shift-create-validation.json");
    assert_eq!(create.mode, ShiftMode::Validation);
    assert!(!create.pallets_enabled);
    assert_eq!(create.pallet_template_id, None);
}

#[test]
fn the_office_sees_a_validation_shift_without_boxes() {
    let shift: OfficeShift = round_trip("office-shift-validation.json");
    assert_eq!(shift.mode, ShiftMode::Validation);
    assert!(!shift.pallets_enabled);
    let totals = shift.totals;
    assert_eq!(
        (
            totals.closed_boxes,
            totals.open_boxes,
            totals.units_in_closed_boxes
        ),
        (0, 0, 0)
    );
    assert!(totals.accepted_units > 0);
}

#[test]
fn a_station_enters_a_validation_shift_with_its_snapshot() {
    let entered: DeviceShift = round_trip("device-shift-entered-validation.json");
    assert_eq!(entered.mode, ShiftMode::Validation);
    assert!(entered.snapshot.is_some());
}

#[test]
fn the_entry_names_what_the_station_can_work() {
    let enter: ShiftEnter = round_trip("shift-enter.json");
    // Part B (task B6): the station also prints the Data Matrix duplicate.
    assert_eq!(
        enter.supports,
        [
            shift_supports::VALIDATION,
            shift_supports::VALIDATION_DM_DUPLICATE
        ]
    );
    // An entry without a body, as a station of protocol 3 sends it, and one
    // with an empty object, both read as a station that names nothing.
    let empty: ShiftEnter = round_trip("shift-enter-empty.json");
    assert_eq!(empty, ShiftEnter::default());
    assert!(empty.supports.is_empty());
}

#[test]
fn the_entry_refuses_a_field_it_does_not_know() {
    let mut value = fixture("shift-enter.json");
    value["addedLater"] = json!(true);
    assert!(serde_json::from_value::<ShiftEnter>(value).is_err());
    assert!(serde_json::from_value::<ShiftEnter>(json!({ "supports": "validation-v1" })).is_err());
}

#[test]
fn a_validation_scan_is_accepted_without_a_box() {
    let record: FactRecord = round_trip("fact-scan-validation.json");
    assert_eq!(record.kind, FactKind::Scan);
    let scan: ScanFact = serde_json::from_value(record.data).unwrap();
    assert_eq!(scan.verdict, ScanVerdict::Ok);
    assert!(scan.code.is_some());
    assert_eq!(scan.box_id, None);
}
