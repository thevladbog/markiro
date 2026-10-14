//! The import's wire types (plan IMP) against the export tool's golden file
//! `cloud-export-file.json`: the request the office builds from it is
//! `{ importId, dryRun, formatVersion, exportedAt, rehearsal, source, payload }`
//! (`cloudImportRequest` in `src/host/cloud-import.ts`), and the host's answer
//! to it on a new site is `cloud-import-summary.json`.

use markiro_proto::cloud_import::{
    CloudImportRequest, CloudImportSummary, CLOUD_IMPORT_FORMAT_VERSION,
    CLOUD_IMPORT_FORMAT_VERSIONS,
};
use serde_json::{json, Value};

fn fixture(name: &str) -> Value {
    let path = format!("{}/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {path}: {error}"))
}

/// The request the office sends for the golden file.
fn request() -> Value {
    let file = fixture("cloud-export-file.json");
    json!({
        "importId": "8f14e45f-ceea-467a-9d9b-1c7e0b1a2d3e",
        "dryRun": false,
        "formatVersion": file["formatVersion"],
        "exportedAt": file["exportedAt"],
        "rehearsal": file["rehearsal"],
        "source": file["source"],
        "payload": file["payload"],
    })
}

/// Every credential verifier of the request: the PIN and badge hashes and
/// the badge salt, read from the golden file (never spelled out here).
fn verifiers(body: &Value) -> Vec<String> {
    let payload = &body["payload"];
    let mut found = Vec::new();
    for operator in payload["operators"].as_array().unwrap() {
        found.push(operator["pinPhc"].as_str().unwrap().to_owned());
    }
    for badge in payload["badges"].as_array().unwrap() {
        found.push(badge["badgePhc"].as_str().unwrap().to_owned());
    }
    found.push(payload["badgeSalt"].as_str().unwrap().to_owned());
    found
}

#[test]
fn the_request_of_the_golden_file_round_trips() {
    let original = request();
    let typed: CloudImportRequest = serde_json::from_value(original.clone()).unwrap();
    assert_eq!(serde_json::to_value(&typed).unwrap(), original);
    assert_eq!(typed.format_version, CLOUD_IMPORT_FORMAT_VERSION);
    let payload = &typed.payload;
    assert_eq!(
        (
            payload.lines.len(),
            payload.counterparties.len(),
            payload.templates.len(),
            payload.products.len(),
            payload.operators.len(),
            payload.badges.len(),
            payload.sscc_counters.len(),
            payload.shift_number_counters.len(),
        ),
        (3, 2, 5, 4, 3, 3, 4, 3)
    );
}

/// The tool writes format 2 since plan ТОВ; a file of format 1 stays good.
#[test]
fn the_format_versions_this_build_reads_are_one_and_two() {
    assert_eq!(CLOUD_IMPORT_FORMAT_VERSION, 2);
    assert_eq!(CLOUD_IMPORT_FORMAT_VERSIONS, [1, 2]);
}

#[test]
fn the_summary_fixture_round_trips_and_tolerates_new_fields() {
    let original = fixture("cloud-import-summary.json");
    let typed: CloudImportSummary = serde_json::from_value(original.clone()).unwrap();
    assert_eq!(serde_json::to_value(&typed).unwrap(), original);
    let mut newer = original;
    newer["warnings"] = json!([]);
    newer["ssccCounters"][0]["owner"] = json!("organization");
    newer["shiftNumberCounters"][0]["closedAt"] = json!("2026-10-09");
    let read: CloudImportSummary = serde_json::from_value(newer).unwrap();
    assert_eq!(read, typed);
}

#[test]
fn the_summary_needs_every_field_it_names() {
    let original = fixture("cloud-import-summary.json");
    for key in original.as_object().unwrap().keys() {
        let mut body = original.clone();
        body.as_object_mut().unwrap().remove(key);
        assert!(
            serde_json::from_value::<CloudImportSummary>(body).is_err(),
            "a summary without {key} was read"
        );
    }
    for (list, key) in [
        ("ssccCounters", "issuerPrefix"),
        ("ssccCounters", "extension"),
        ("ssccCounters", "nextSerial"),
        ("shiftNumberCounters", "monthKey"),
        ("shiftNumberCounters", "lastSeq"),
    ] {
        let mut body = original.clone();
        body[list][0].as_object_mut().unwrap().remove(key);
        assert!(
            serde_json::from_value::<CloudImportSummary>(body).is_err(),
            "a {list} row without {key} was read"
        );
    }
}

#[test]
fn the_request_refuses_a_field_it_does_not_know_at_every_level() {
    for pointer in [
        "",
        "/source",
        "/payload",
        "/payload/organization",
        "/payload/lines/0",
        "/payload/counterparties/0",
        "/payload/templates/0",
        "/payload/templateDefaults",
        "/payload/templateDefaults/categories/0",
        "/payload/products/0",
        "/payload/operators/0",
        "/payload/badges/0",
        "/payload/ssccCounters/0",
        "/payload/shiftNumberCounters/0",
    ] {
        let mut body = request();
        body.pointer_mut(pointer)
            .and_then(Value::as_object_mut)
            .unwrap_or_else(|| panic!("{pointer} is an object"))
            .insert("unitPrice".to_owned(), json!("89.90"));
        assert!(
            serde_json::from_value::<CloudImportRequest>(body).is_err(),
            "{pointer} took an unknown field"
        );
    }
}

/// A required field is required at every level: a request that lacks one is
/// refused, not defaulted (only `badgeSalt` and the nullable fields may be
/// absent, and they are `null` in the golden file).
#[test]
fn the_request_needs_every_field_that_is_not_nullable() {
    for (pointer, key) in [
        ("", "importId"),
        ("", "dryRun"),
        ("", "formatVersion"),
        ("", "exportedAt"),
        ("", "rehearsal"),
        ("", "source"),
        ("", "payload"),
        ("/source", "tenantId"),
        ("/source", "tenantName"),
        ("/payload", "organization"),
        ("/payload", "lines"),
        ("/payload", "counterparties"),
        ("/payload", "templates"),
        ("/payload", "templateDefaults"),
        ("/payload", "products"),
        ("/payload", "operators"),
        ("/payload", "badges"),
        ("/payload", "ssccCounters"),
        ("/payload", "shiftNumberCounters"),
        ("/payload/organization", "name"),
        ("/payload/organization", "gln"),
        ("/payload/organization", "gs1Prefixes"),
        ("/payload/organization", "timeZone"),
        ("/payload/lines/0", "id"),
        ("/payload/lines/0", "name"),
        ("/payload/counterparties/0", "id"),
        ("/payload/counterparties/0", "name"),
        ("/payload/counterparties/0", "gln"),
        ("/payload/counterparties/0", "gs1Prefixes"),
        ("/payload/templates/0", "id"),
        ("/payload/templates/0", "name"),
        ("/payload/templates/0", "purpose"),
        ("/payload/templates/0", "enabled"),
        ("/payload/templates/0", "spec"),
        ("/payload/templateDefaults", "categories"),
        (
            "/payload/templateDefaults/categories/0",
            "chzProductGroupCode",
        ),
        ("/payload/templateDefaults/categories/0", "purpose"),
        ("/payload/templateDefaults/categories/0", "templateId"),
        ("/payload/products/0", "id"),
        ("/payload/products/0", "gtin14"),
        ("/payload/products/0", "name"),
        ("/payload/products/0", "archived"),
        ("/payload/operators/0", "id"),
        ("/payload/operators/0", "login"),
        ("/payload/operators/0", "name"),
        ("/payload/operators/0", "pinPhc"),
        ("/payload/operators/0", "active"),
        ("/payload/badges/0", "id"),
        ("/payload/badges/0", "operatorId"),
        ("/payload/badges/0", "badgePhc"),
        ("/payload/ssccCounters/0", "issuerPrefix"),
        ("/payload/ssccCounters/0", "extension"),
        ("/payload/ssccCounters/0", "nextSerial"),
        ("/payload/shiftNumberCounters/0", "monthKey"),
        ("/payload/shiftNumberCounters/0", "lastSeq"),
    ] {
        let mut body = request();
        body.pointer_mut(pointer)
            .and_then(Value::as_object_mut)
            .unwrap_or_else(|| panic!("{pointer} is an object"))
            .remove(key)
            .unwrap_or_else(|| panic!("{pointer}/{key} is in the golden file"));
        assert!(
            serde_json::from_value::<CloudImportRequest>(body).is_err(),
            "a request without {pointer}/{key} was read"
        );
    }
}

/// The nullable fields read as `null` and as absent alike, and a request with
/// no badge salt (a site whose cloud never had a badge) round-trips as `null`.
#[test]
fn the_nullable_fields_may_be_null() {
    let mut body = request();
    body["payload"]["badgeSalt"] = Value::Null;
    body["payload"]["organization"]["inn"] = Value::Null;
    body["payload"]["products"][0]["printName"] = Value::Null;
    body["payload"]["products"][0]["boxCapacity"] = Value::Null;
    body["payload"]["operators"][0]["role"] = Value::Null;
    body["payload"]["badges"][0]["label"] = Value::Null;
    body["payload"]["templates"][0]["chzProductGroupCodes"] = Value::Null;
    body["payload"]["templateDefaults"]["defaultBoxTemplateId"] = Value::Null;
    let typed: CloudImportRequest = serde_json::from_value(body.clone()).unwrap();
    assert!(typed.payload.badge_salt.is_none());
    assert_eq!(serde_json::to_value(&typed).unwrap(), body);
}

/// The scalar types are the host's limits: a value that does not fit is
/// refused at the wire, before any row rule runs.
#[test]
fn the_request_refuses_a_value_the_wire_type_cannot_hold() {
    for (pointer, value) in [
        ("/payload/ssccCounters/0/extension", json!(256)),
        ("/payload/ssccCounters/0/extension", json!(-1)),
        ("/payload/ssccCounters/0/nextSerial", json!(-1)),
        (
            "/payload/shiftNumberCounters/0/lastSeq",
            json!(4_294_967_296_u64),
        ),
        ("/payload/shiftNumberCounters/0/lastSeq", json!(-1)),
        ("/payload/products/0/boxCapacity", json!(4_294_967_296_u64)),
        ("/payload/products/0/palletBoxCapacity", json!(-1)),
        ("/payload/products/0/shelfLifeDays", json!(-1)),
        (
            "/payload/products/0/chzProductGroupCode",
            json!(4_294_967_296_u64),
        ),
        ("/payload/templates/0/chzProductGroupCodes", json!([-1])),
        ("/payload/templates/0/purpose", json!("labels")),
        (
            "/payload/templateDefaults/categories/0/purpose",
            json!("labels"),
        ),
        ("/payload/templates/0/enabled", json!("yes")),
        ("/payload/products/0/archived", json!(0)),
        ("/dryRun", json!("false")),
        ("/formatVersion", json!(-1)),
        ("/rehearsal", json!(null)),
        ("/payload/operators/0/pinPhc", json!(5)),
        ("/payload/badges/0/badgePhc", json!(null)),
        ("/payload/badgeSalt", json!(5)),
    ] {
        let mut body = request();
        *body.pointer_mut(pointer).unwrap() = value.clone();
        assert!(
            serde_json::from_value::<CloudImportRequest>(body).is_err(),
            "{pointer} took {value}"
        );
    }
    // The far end of what fits is read as it is.
    let mut body = request();
    body["payload"]["ssccCounters"][0]["extension"] = json!(255);
    body["payload"]["ssccCounters"][0]["nextSerial"] = json!(u64::MAX);
    body["payload"]["shiftNumberCounters"][0]["lastSeq"] = json!(u32::MAX);
    let typed: CloudImportRequest = serde_json::from_value(body.clone()).unwrap();
    assert_eq!(serde_json::to_value(&typed).unwrap(), body);
}

/// The hashes and the salt are `Secret`s: a stray `{:?}` prints none, in the
/// one-line and in the pretty form, with the salt present and absent.
#[test]
fn a_debug_print_of_the_request_holds_no_verifier() {
    let body = request();
    let secrets = verifiers(&body);
    assert_eq!(secrets.len(), 7);
    let typed: CloudImportRequest = serde_json::from_value(body).unwrap();
    for printed in [format!("{typed:?}"), format!("{typed:#?}")] {
        for secret in &secrets {
            assert!(
                !printed.contains(secret.as_str()),
                "a verifier was printed in the Debug of the request"
            );
        }
        assert!(!printed.contains("pbkdf2$"));
        assert_eq!(printed.matches("Secret(***)").count(), 7);
    }
    let mut without_salt = typed;
    without_salt.payload.badge_salt = None;
    let printed = format!("{without_salt:?}");
    assert_eq!(printed.matches("Secret(***)").count(), 6);
}

/// Each part that holds a verifier hides it on its own, so a `{:?}` of one
/// operator, one badge or the payload is as safe as the whole request.
#[test]
fn a_debug_print_of_a_part_holds_no_verifier() {
    let body = request();
    let secrets = verifiers(&body);
    let typed: CloudImportRequest = serde_json::from_value(body).unwrap();
    let parts = [
        format!("{:?}", typed.payload),
        format!("{:?}", typed.payload.operators),
        format!("{:?}", typed.payload.operators[0]),
        format!("{:?}", typed.payload.badges),
        format!("{:?}", typed.payload.badges[0]),
        format!("{:?}", typed.payload.badge_salt),
    ];
    for printed in parts {
        for secret in &secrets {
            assert!(
                !printed.contains(secret.as_str()),
                "a part printed a verifier"
            );
        }
    }
    assert_eq!(
        format!("{:?}", typed.payload.operators[0])
            .matches("Secret(***)")
            .count(),
        1
    );
    assert_eq!(
        format!("{:?}", typed.payload.badges[0])
            .matches("Secret(***)")
            .count(),
        1
    );
    assert_eq!(
        format!("{:?}", typed.payload.badge_salt),
        "Some(Secret(***))"
    );
}

/// A refusal's text (what the host puts in a `validation_failed` body) names
/// fields, never values: no verifier reaches it.
#[test]
fn a_parse_error_holds_no_verifier() {
    let body = request();
    let secrets = verifiers(&body);
    for pointer in ["/payload/operators/0", "/payload/badges/0", "/payload"] {
        let mut broken = body.clone();
        broken
            .pointer_mut(pointer)
            .and_then(Value::as_object_mut)
            .unwrap()
            .insert("unitPrice".to_owned(), json!("89.90"));
        let message = serde_json::from_value::<CloudImportRequest>(broken)
            .unwrap_err()
            .to_string();
        for secret in &secrets {
            assert!(
                !message.contains(secret.as_str()),
                "{pointer}: a verifier in the error"
            );
        }
    }
    let text = serde_json::to_string(&body)
        .unwrap()
        .replace("\"dryRun\":false", "\"dryRun\":7");
    let message = serde_json::from_str::<CloudImportRequest>(&text)
        .unwrap_err()
        .to_string();
    for secret in &secrets {
        assert!(
            !message.contains(secret.as_str()),
            "a verifier in the error"
        );
    }
}
