//! The update distribution shapes (plan ОБН-3) against their fixtures, which
//! `test/distribution.test.ts` parses with the Zod schemas too, and the
//! order of app versions (`markiro_proto::update::AppVersion`, plan ОБН-2)
//! the webview mirrors (`app-versions.json`).

use std::cmp::Ordering;

use markiro_proto::codes;
use markiro_proto::update::distribution::{
    DeviceUpdateOffer, DeviceVersionState, OfficeUpdateStatus, PackageState,
    UpdatePackageManifestRequest, UpdatePackageStaged, UpdatePackageUpload, MAX_INSTALLER_BYTES,
    MAX_MANIFEST_BYTES,
};
use markiro_proto::update::AppVersion;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};

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

#[test]
fn versions_read_and_order_as_the_shared_fixture_says() {
    let cases = fixture("app-versions.json");
    for case in cases["valid"].as_array().unwrap() {
        let text = case[0].as_str().unwrap();
        let parts: Vec<u64> = case[1]
            .as_array()
            .unwrap()
            .iter()
            .map(|part| part.as_u64().unwrap())
            .collect();
        let version: AppVersion = text.parse().unwrap_or_else(|_| panic!("{text} reads"));
        assert_eq!(
            vec![
                u64::from(version.major),
                u64::from(version.minor),
                u64::from(version.patch)
            ],
            parts,
            "{text}"
        );
        assert_eq!(version.to_string(), text);
    }
    for text in cases["invalid"].as_array().unwrap() {
        let text = text.as_str().unwrap();
        assert!(text.parse::<AppVersion>().is_err(), "{text:?}");
    }
    for case in cases["order"].as_array().unwrap() {
        let left: AppVersion = case[0].as_str().unwrap().parse().unwrap();
        let right: AppVersion = case[1].as_str().unwrap().parse().unwrap();
        let expected = match case[2].as_i64().unwrap() {
            -1 => Ordering::Less,
            0 => Ordering::Equal,
            _ => Ordering::Greater,
        };
        assert_eq!(left.cmp(&right), expected, "{case}");
    }
}

#[test]
fn a_devices_offer_round_trips_and_reads_a_newer_hosts_answer() {
    let offer: DeviceUpdateOffer = round_trip("device-update-offer.json");
    assert_eq!(offer.package.state, PackageState::Ok);
    assert_eq!(offer.package.size_bytes, Some(61_234_567));
    let missing: DeviceUpdateOffer = round_trip("device-update-offer-missing.json");
    assert_eq!(
        (missing.package.state, missing.package.manifest),
        (PackageState::Missing, None)
    );
    // Frozen like `hello`: a state this build does not know is unknown, not an error.
    let future: DeviceUpdateOffer =
        serde_json::from_value(fixture("device-update-offer-future.json")).unwrap();
    assert_eq!(
        (future.host_version.as_str(), future.package.state),
        ("0.5.0", PackageState::Unknown)
    );
}

#[test]
fn the_upload_shapes_round_trip_and_the_request_takes_no_other_field() {
    let request: UpdatePackageManifestRequest = round_trip("update-package-manifest-request.json");
    assert!(request.manifest.starts_with("eyJ"));
    let mut extra = fixture("update-package-manifest-request.json");
    extra["installer"] = json!("bytes");
    assert!(serde_json::from_value::<UpdatePackageManifestRequest>(extra).is_err());
    let upload: UpdatePackageUpload = round_trip("update-package-upload.json");
    assert_eq!(upload.size_bytes, 61_234_567);
    let staged: UpdatePackageStaged = round_trip("update-package-staged.json");
    assert_eq!(staged.version, "0.3.0");
}

#[test]
fn the_offices_status_round_trips_with_every_device_state() {
    let status: OfficeUpdateStatus = round_trip("office-update-status.json");
    assert_eq!(
        status
            .devices
            .iter()
            .map(|device| device.state)
            .collect::<Vec<_>>(),
        [
            DeviceVersionState::Compatible,
            DeviceVersionState::Compatible,
            DeviceVersionState::Incompatible,
            DeviceVersionState::HostOlder,
            DeviceVersionState::Unknown,
        ]
    );
    assert_eq!(status.package.previous.as_deref(), Some("0.2.1"));
    assert_eq!(status.history.len(), 2);
}

#[test]
fn limits_and_codes_are_the_specs() {
    assert_eq!(MAX_MANIFEST_BYTES, 64 * 1024);
    assert_eq!(MAX_INSTALLER_BYTES, 256 * 1024 * 1024);
    assert!(codes::ALL.contains(&codes::PACKAGE_VERIFYING));
    assert!(codes::ALL.contains(&codes::UPDATE_BUSY));
}

#[cfg(feature = "test-keys")]
#[test]
fn a_manifest_signed_for_tests_checks_out_with_the_test_update_key() {
    let payload = json!({
        "v": 1, "product": "markiro-standalone", "version": "0.3.0", "channel": "stable",
        "releasedAt": "2026-11-02T10:00:00Z",
        "sourceSha": "0123456789abcdef0123456789abcdef01234567",
        "installer": {
            "name": "markiro-standalone-0.3.0-windows-x86_64-setup.exe",
            "sha256": "7863191bce3b1317a5e56211c00c8a962523cc52264414ba528e791d12c1f1ae",
            "sizeBytes": 22
        },
        "protocol": 4, "minProtocol": 3, "minUpgradeFrom": "0.2.0", "notes": ["Тест"]
    });
    let compact = markiro_proto::update::distribution::testing::sign_update_manifest(&payload);
    let (manifest, kid) = markiro_proto::trust::verify_update_manifest(
        &compact,
        &markiro_proto::trust::update_keyset(),
    )
    .expect("the test key signs what the test keyset trusts");
    assert_eq!(
        (manifest.version.as_str(), kid.as_str()),
        ("0.3.0", "test-upd-1")
    );
}
