//! The wire of the warehouse reprint (plan СКЛ): every fixture round-trips,
//! and the receipt codes are the fixture's, as the webview reads them.

use markiro_proto::{
    warehouse_receipt_codes, FactOutcome, FactReceipts, WarehouseBatch, WarehouseLookup,
    WarehouseLookupResult, WarehouseSubjectKind, WarehouseUnavailable, WAREHOUSE_OUTCOMES,
    WAREHOUSE_REASONS,
};
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
fn a_lookup_asks_by_the_hash_of_a_code_or_by_an_sscc() {
    let code: WarehouseLookup = round_trip("warehouse-lookup-code.json");
    assert_eq!(code.sscc, None);
    assert_eq!(code.code_hash.as_deref().map(str::len), Some(64));
    let sscc: WarehouseLookup = round_trip("warehouse-lookup-sscc.json");
    assert_eq!(sscc.code_hash, None);
    assert_eq!(sscc.sscc.as_deref(), Some("046006820000015000"));
    // A field the host does not know is refused, not ignored.
    assert!(serde_json::from_value::<WarehouseLookup>(
        serde_json::json!({ "sscc": "046006820000015000", "raw": "x" })
    )
    .is_err());
}

#[test]
fn every_lookup_answer_round_trips() {
    let unit: WarehouseLookupResult = round_trip("warehouse-lookup-found-unit.json");
    let WarehouseLookupResult::Found { source } = unit else {
        panic!("the unit fixture is found");
    };
    assert_eq!(source.kind, WarehouseSubjectKind::Unit);
    assert!(source.canonical.as_deref().unwrap().contains('\u{1d}'));
    assert_eq!((source.sscc, source.box_count), (None, None));
    let pallet: WarehouseLookupResult = round_trip("warehouse-lookup-found-pallet.json");
    let WarehouseLookupResult::Found { source } = pallet else {
        panic!("the pallet fixture is found");
    };
    assert_eq!(source.kind, WarehouseSubjectKind::Pallet);
    assert_eq!(source.box_count, Some(40));
    assert_eq!(source.canonical, None);
    let imported: WarehouseLookupResult = round_trip("warehouse-lookup-found-imported-unit.json");
    let WarehouseLookupResult::Found { source } = imported else {
        panic!("the imported unit fixture is found");
    };
    assert!(source.imported);
    assert_eq!(source.operator_name, None);
    // A native record leaves the marker out of the wire.
    let native: WarehouseLookupResult = round_trip("warehouse-lookup-found-unit.json");
    let WarehouseLookupResult::Found { source } = native else {
        panic!("the unit fixture is found");
    };
    assert!(!source.imported);
    for (name, reason) in [
        (
            "warehouse-lookup-unavailable-imported-no-shift.json",
            WarehouseUnavailable::ImportedNoShift,
        ),
        (
            "warehouse-lookup-unavailable-imported-no-production-date.json",
            WarehouseUnavailable::ImportedNoProductionDate,
        ),
        (
            "warehouse-lookup-unavailable-imported-product-unknown.json",
            WarehouseUnavailable::ImportedProductUnknown,
        ),
    ] {
        let answer: WarehouseLookupResult = round_trip(name);
        assert_eq!(
            answer,
            WarehouseLookupResult::Unavailable { reason },
            "{name}"
        );
    }
    let missing: WarehouseLookupResult = round_trip("warehouse-lookup-not-found.json");
    assert_eq!(missing, WarehouseLookupResult::NotFound);
    let gone: WarehouseLookupResult = round_trip("warehouse-lookup-unavailable.json");
    assert_eq!(
        gone,
        WarehouseLookupResult::Unavailable {
            reason: WarehouseUnavailable::Disassembled
        }
    );
}

#[test]
fn records_round_trip_and_are_answered_with_fact_receipts() {
    let batch: WarehouseBatch = round_trip("warehouse-records-request.json");
    assert_eq!(batch.records.len(), 2);
    assert_eq!(batch.records[0].subject_kind.as_str(), "box");
    assert_eq!(batch.records[1].error_code.as_deref(), Some("timeout"));
    let receipts: FactReceipts = round_trip("warehouse-records-response.json");
    assert_eq!(receipts.receipts[0].outcome, FactOutcome::Accepted);
    assert_eq!(
        receipts.receipts[1].code.as_deref(),
        Some(warehouse_receipt_codes::SUBJECT_UNKNOWN)
    );
    let mut extra = fixture("warehouse-records-request.json")["records"][0].clone();
    extra["addedLater"] = Value::from(1);
    assert!(serde_json::from_value::<markiro_proto::WarehouseRecord>(extra).is_err());
}

#[test]
fn the_receipt_codes_reasons_and_outcomes_are_the_fixtures() {
    let codes = fixture("warehouse-receipt-codes.json");
    assert_eq!(
        serde_json::from_value::<Vec<String>>(codes["codes"].clone()).unwrap(),
        warehouse_receipt_codes::ALL
    );
    assert_eq!(WAREHOUSE_REASONS, ["not_printed", "damaged", "lost"]);
    assert_eq!(
        WAREHOUSE_OUTCOMES,
        ["sent", "unknown", "failed", "verified", "cancelled"]
    );
}

#[test]
fn the_names_on_the_wire_are_the_names_the_webview_reads() {
    for (kind, name) in [
        (WarehouseSubjectKind::Unit, "unit"),
        (WarehouseSubjectKind::Box, "box"),
        (WarehouseSubjectKind::Pallet, "pallet"),
    ] {
        assert_eq!(kind.as_str(), name);
        assert_eq!(serde_json::to_value(kind).unwrap(), Value::from(name));
    }
    assert_eq!(
        serde_json::to_value(WarehouseLookupResult::Unavailable {
            reason: WarehouseUnavailable::Released
        })
        .unwrap(),
        serde_json::json!({ "status": "unavailable", "reason": "released" })
    );
    assert_eq!(
        serde_json::to_value(WarehouseLookupResult::NotFound).unwrap(),
        serde_json::json!({ "status": "not_found" })
    );
}

#[test]
fn a_batch_and_a_record_refuse_what_the_host_does_not_know() {
    let mut batch = fixture("warehouse-records-request.json");
    batch["addedLater"] = Value::from(1);
    assert!(serde_json::from_value::<WarehouseBatch>(batch).is_err());
    // An unknown kind of subject is refused.
    let mut record = fixture("warehouse-records-request.json")["records"][0].clone();
    record["subjectKind"] = Value::from("pack");
    assert!(serde_json::from_value::<markiro_proto::WarehouseRecord>(record).is_err());
}
