use markiro_proto::cloud_history::{
    CloudHistoryImportRequest, CloudHistoryManifest, CloudHistoryPart,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[test]
fn export_source_effective_operation_time_round_trips_without_inventing_a_close() {
    let fixture: Value =
        serde_json::from_str(include_str!("../fixtures/cloud-history-read.json")).unwrap();
    for source in fixture["exportSources"]
        .as_array()
        .unwrap()
        .iter()
        .chain(std::iter::once(&fixture["nullCloseExportSource"]))
    {
        let typed: markiro_proto::ShiftExportRows = serde_json::from_value(source.clone()).unwrap();
        assert!(typed.shift.effective_operation_date_time.is_some());
        assert_eq!(serde_json::to_value(typed).unwrap(), *source);
    }
    let null_close: markiro_proto::ShiftExportRows =
        serde_json::from_value(fixture["nullCloseExportSource"].clone()).unwrap();
    assert!(null_close.shift.closed_at.is_none());
    assert!(null_close.shift.station_closed_at.is_none());
    assert_eq!(
        null_close.shift.effective_operation_date_time.as_deref(),
        fixture["request"]["manifest"]["exportedAt"].as_str()
    );
}

#[test]
fn shared_golden_roundtrips_without_debugging_codes() {
    let lines: Vec<Value> = include_str!("../fixtures/cloud-history.jsonl")
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let manifest: CloudHistoryManifest = serde_json::from_value(lines[0].clone()).unwrap();
    let part: CloudHistoryPart = serde_json::from_value(lines[1].clone()).unwrap();
    assert_eq!(serde_json::to_value(&manifest).unwrap(), lines[0]);
    assert_eq!(serde_json::to_value(&part).unwrap(), lines[1]);
    assert!(part.payload.codes[1].flat_only);
    assert!(part.payload.codes[0]
        .canonical
        .expose()
        .contains('\u{001d}'));
    let request = CloudHistoryImportRequest {
        manifest,
        part,
        dry_run: false,
    };
    let debug = format!("{request:?}");
    assert!(!debug.contains("SERIAL"));
    for code in &request.part.payload.codes {
        assert!(!debug.contains(code.hash.expose()));
    }
    let mut unknown = lines[1].clone();
    unknown["extra"] = true.into();
    assert!(serde_json::from_value::<CloudHistoryPart>(unknown).is_err());
}

#[test]
fn nullable_source_fields_are_explicit_and_checksums_match_node() {
    let lines: Vec<Value> = include_str!("../fixtures/cloud-history.jsonl")
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    for original in &lines {
        let mut value = original.clone();
        let expected = value.as_object_mut().unwrap().remove("checksum").unwrap();
        let bytes = serde_json::to_vec(&value).unwrap();
        assert_eq!(expected, format!("sha256:{:x}", Sha256::digest(bytes)));
    }
    let mut missing = lines[1].clone();
    missing["payload"]["shifts"][0]
        .as_object_mut()
        .unwrap()
        .remove("plannedDate");
    assert!(serde_json::from_value::<CloudHistoryPart>(missing).is_err());
    let mut missing = lines[0].clone();
    let mut missing_shelf_life = lines[1].clone();
    missing_shelf_life["payload"]["shifts"][0]
        .as_object_mut()
        .unwrap()
        .remove("shelfLifeDays");
    assert!(serde_json::from_value::<CloudHistoryPart>(missing_shelf_life).is_err());
    for field in ["productName", "gtin14", "shelfLifeDays"] {
        let mut missing = lines[1].clone();
        missing["payload"]["pallets"][0]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(serde_json::from_value::<CloudHistoryPart>(missing).is_err());
    }
    missing["organization"]
        .as_object_mut()
        .unwrap()
        .remove("inn");
    assert!(serde_json::from_value::<CloudHistoryManifest>(missing).is_err());
}
