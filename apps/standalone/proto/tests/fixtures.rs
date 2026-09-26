use markiro_proto::{
    certificate_fingerprint, codes, ErrorBody, Hello, HOST_PRODUCT, PROTOCOL_VERSION,
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
fn unknown_fields_are_rejected() {
    let mut value = fixture("hello.json");
    value["extra"] = Value::Bool(true);
    assert!(serde_json::from_value::<Hello>(value).is_err());
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
