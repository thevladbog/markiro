use markiro_proto::{
    certificate_fingerprint, codes, compatibility, compatibility_for, display_fingerprint,
    BlockSizesUpdate, BootstrapRequest, BootstrapResponse, Compatibility, DeviceInfo, DeviceKind,
    ErrorBody, Hello, HelloEnvelope, LocalPairRequest, OfficeLoginRequest, OfficeRole,
    OfficeSession, OfficeUser, OfficeUserCreate, OfficeUserRecord, OfficeUserUpdate, OrgProfile,
    OrgProfileUpdate, PairResponse, PasswordSet, SsccCounterUpdate, SsccState, HOST_PRODUCT,
    PROTOCOL_VERSION,
};
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

#[test]
fn hello_fixture_round_trips() {
    let hello: Hello = round_trip("hello.json");
    assert_eq!(hello.product, HOST_PRODUCT);
    assert_eq!(hello.protocol, PROTOCOL_VERSION);
}

#[test]
fn error_fixtures_round_trip() {
    let not_found: ErrorBody = round_trip("error-not-found.json");
    assert_eq!(not_found.error.code, codes::NOT_FOUND);
    assert!(not_found.error.details.is_none());
    let unsupported: ErrorBody = round_trip("error-with-details.json");
    assert_eq!(unsupported.error.code, codes::PROTOCOL_UNSUPPORTED);
}

#[test]
fn hello_ignores_fields_added_by_newer_hosts() {
    let hello: Hello = serde_json::from_value(fixture("hello-future.json")).unwrap();
    assert_eq!(hello.protocol, 3);
    assert!(hello.initialized);
}

#[test]
fn envelope_decides_compatibility_before_the_rest() {
    let future: HelloEnvelope = serde_json::from_value(fixture("hello-future.json")).unwrap();
    assert_eq!(compatibility_for(1, &future), Compatibility::AppTooOld);
    assert_eq!(compatibility_for(2, &future), Compatibility::Compatible);
    assert_eq!(compatibility_for(4, &future), Compatibility::HostTooOld);
    let current: HelloEnvelope = serde_json::from_value(fixture("hello.json")).unwrap();
    assert_eq!(compatibility(&current), Compatibility::Compatible);
}

#[test]
fn display_fingerprint_groups_the_first_32_characters() {
    assert_eq!(
        display_fingerprint(&"0123456789abcdef".repeat(4)),
        "0123 4567 89AB CDEF 0123 4567 89AB CDEF"
    );
}

#[test]
fn fingerprint_is_lower_case_hex_sha256() {
    assert_eq!(
        certificate_fingerprint(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

#[test]
fn error_details_must_be_an_object() {
    let mut value = fixture("error-with-details.json");
    value["error"]["details"] = Value::String("not an object".into());
    assert!(serde_json::from_value::<ErrorBody>(value).is_err());
}

#[test]
fn pairing_fixtures_round_trip() {
    let request: LocalPairRequest = round_trip("local-pair-request.json");
    assert_eq!(request.kind, DeviceKind::Station);
    let _: PairResponse = round_trip("pair-response.json");
    let info: DeviceInfo = round_trip("device-info.json");
    assert!(info.line_id.is_none());
}

#[test]
fn requests_reject_unknown_fields() {
    let mut value = fixture("local-pair-request.json");
    value["extra"] = Value::Bool(true);
    assert!(serde_json::from_value::<LocalPairRequest>(value).is_err());
}

#[test]
fn office_auth_fixtures_round_trip() {
    let _: OfficeLoginRequest = round_trip("office-login-request.json");
    let user: OfficeUser = round_trip("office-user.json");
    assert_eq!(user.role, OfficeRole::Admin);
    let session: OfficeSession = round_trip("office-session.json");
    assert_eq!(session.user, user);
}

#[test]
fn bootstrap_and_org_fixtures_round_trip() {
    let bootstrap: BootstrapRequest = round_trip("bootstrap-request.json");
    assert_eq!(bootstrap.sscc.pallet_next_serial, 0);
    assert_eq!(bootstrap.lines, vec!["Линия 1".to_owned()]);
    let response: BootstrapResponse = round_trip("bootstrap-response.json");
    assert_eq!(response.session.user.login, "admin");
    let _: OrgProfile = round_trip("org-profile.json");
    let update: OrgProfileUpdate = round_trip("org-profile-update.json");
    assert!(update.inn.is_none());
}

#[test]
fn sscc_and_user_admin_fixtures_round_trip() {
    let state: SsccState = round_trip("sscc-state.json");
    assert_eq!(state.counters[0].max_serial, 9_999_999);
    let _: SsccCounterUpdate = round_trip("sscc-counter-update.json");
    let _: BlockSizesUpdate = round_trip("block-sizes-update.json");
    let record: OfficeUserRecord = round_trip("office-user-record.json");
    assert!(record.active);
    let _: OfficeUserCreate = round_trip("office-user-create.json");
    let _: OfficeUserUpdate = round_trip("office-user-update.json");
    let _: PasswordSet = round_trip("password-set.json");
}
