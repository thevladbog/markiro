//! The license shapes (plan ЛЦ-2) against their fixtures, which
//! `test/license-protocol.test.ts` parses with the Zod schemas too.

use markiro_proto::license::{
    constraints, plans, refusals, states, warnings, DeviceLicense, LicenseLoadRequest,
    LicensePreview, OfficeLicense, FEATURE_KEYS, QUOTA_KEYS,
};
use markiro_proto::{codes, DeviceInfo, ErrorBody};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let path = format!("{}/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {path}: {error}"))
}

/// Deserialize into `T` and serialize back: the JSON must survive unchanged.
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

fn keys(value: &Value) -> Vec<String> {
    value.as_object().unwrap().keys().cloned().collect()
}

#[test]
fn the_office_reads_the_license_with_its_seats_features_and_binding() {
    let license: OfficeLicense = round_trip("office-license.json");
    assert_eq!(license.state, states::ACTIVE);
    assert!(license.opens_new_shifts);
    assert!(license.warnings.is_empty());
    let summary = license.license.expect("the fixture has a file");
    assert_eq!(
        (summary.sequence, summary.plan.as_str()),
        (3, plans::SUBSCRIPTION)
    );
    assert_eq!(license.quotas.stations.limit, Some(3));
    assert!(license.quotas.stations.over);
    assert_eq!(license.quotas.kiosks.limit, None);
    assert!(!license.features.public_api && license.features.handheld);
    assert_eq!(license.binding.inn_matches, Some(true));
    // The wire names of the quotas and features are the cloud's (plan ЛЦ-1).
    let value = fixture("office-license.json");
    let mut quota_keys = keys(&value["quotas"]);
    let mut feature_keys = keys(&value["features"]);
    let mut expected_quotas: Vec<String> = QUOTA_KEYS.iter().map(|key| key.to_string()).collect();
    let mut expected_features: Vec<String> =
        FEATURE_KEYS.iter().map(|key| key.to_string()).collect();
    for list in [
        &mut quota_keys,
        &mut feature_keys,
        &mut expected_quotas,
        &mut expected_features,
    ] {
        list.sort();
    }
    assert_eq!(
        (quota_keys, feature_keys),
        (expected_quotas, expected_features)
    );
}

#[test]
fn a_newer_host_may_add_fields_and_states() {
    let mut value = fixture("office-license.json");
    value["addedLater"] = Value::Bool(true);
    value["state"] = Value::String("some_future_state".into());
    let license: OfficeLicense = serde_json::from_value(value).unwrap();
    assert_eq!(license.state, "some_future_state");
    let mut device = fixture("device-license.json");
    device["license"]["state"] = Value::String("some_future_state".into());
    device["license"]["addedLater"] = Value::Bool(true);
    let info: DeviceInfo = serde_json::from_value(device).unwrap();
    assert_eq!(info.license.unwrap().state, "some_future_state");
}

#[test]
fn the_preview_names_what_changes_and_warns_of_seats_over_the_file() {
    let preview: LicensePreview = round_trip("office-license-preview.json");
    assert_eq!(preview.before.plan, plans::TRIAL);
    assert_eq!(preview.before.license_id, None);
    assert_eq!(preview.after.sequence, Some(1));
    assert!(preview.after.quotas.stations.over);
    assert_eq!(preview.warnings, [warnings::OVER_LIMIT]);
    assert!(preview.changes.contains(&"quotas.stations".to_owned()));
}

#[test]
fn a_device_reads_the_license_with_its_record_and_an_older_host_sends_none() {
    let info: DeviceInfo = round_trip("device-license.json");
    let license: DeviceLicense = info.license.expect("the fixture has a license");
    assert_eq!(license.state, states::GRACE);
    assert_eq!(license.emergency_until, None);
    let older: DeviceInfo = round_trip("device-info.json");
    assert_eq!(older.license, None);
}

#[test]
fn the_load_request_is_strict() {
    let request: LicenseLoadRequest = round_trip("license-load-request.json");
    assert!(request.file.starts_with("eyJ"));
    let mut value = fixture("license-load-request.json");
    value["extra"] = Value::Bool(true);
    assert!(serde_json::from_value::<LicenseLoadRequest>(value).is_err());
}

#[test]
fn the_refusals_name_their_constraint_or_reason() {
    let restricted: ErrorBody = round_trip("error-license-restricted.json");
    assert_eq!(restricted.error.code, codes::CONFLICT);
    let details = restricted.error.details.unwrap();
    assert_eq!(details["constraint"], constraints::LICENSE_RESTRICTED);
    assert_eq!(details["state"], states::RESTRICTED);
    let seats: ErrorBody = round_trip("error-seat-limit.json");
    let details = seats.error.details.unwrap();
    assert_eq!(details["constraint"], constraints::SEAT_LIMIT);
    assert_eq!(
        (details["used"].as_u64(), details["limit"].as_u64()),
        (Some(3), Some(3))
    );
    let feature: ErrorBody = round_trip("error-feature-disabled.json");
    assert_eq!(
        feature.error.details.unwrap()["constraint"],
        constraints::FEATURE_DISABLED
    );
    let refused: ErrorBody = round_trip("error-license-refused.json");
    assert_eq!(refused.error.code, codes::VALIDATION_FAILED);
    let details = refused.error.details.unwrap();
    assert_eq!(details["field"], "file");
    assert!(refusals::ALL.contains(&details["reason"].as_str().unwrap()));
}

#[test]
fn every_list_holds_its_codes_once() {
    for list in [
        constraints::ALL,
        refusals::ALL,
        warnings::ALL,
        states::ALL,
        plans::ALL,
    ] {
        let mut sorted = list.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), list.len(), "{list:?}");
    }
    assert_eq!(states::ALL.len(), 8);
    assert_eq!(refusals::ALL.len(), 7);
}
