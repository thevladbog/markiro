//! `markiro_proto::trust` against the signed fixtures it shares with
//! `@markiro/domain` (`packages/domain/fixtures/standalone-license/`, made by
//! `packages/domain/scripts/generate-standalone-fixtures.mjs` with the test
//! keys): both sides must give every file and every payload case the same
//! answer.

use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use markiro_proto::trust::{
    is_opaque_id, parse_keysets, verify_compact, verify_license, verify_update_manifest,
    ActivationRequest, DocumentKind, Keyset, Keysets, LicensePayloadV1, LicensePlan, TrustError,
    UpdateChannel, UpdateManifestV1, LICENSE_TYP, MAX_LICENSE_BYTES, MAX_UPDATE_MANIFEST_BYTES,
    UPDATE_TYP,
};
use serde_json::{json, Value};

const HOST_ID: &str = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

fn domain_fixture(name: &str) -> String {
    let path = format!(
        "{}/../../../packages/domain/fixtures/standalone-license/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"))
}

/// A signed fixture without the line end the generator writes.
fn signed(name: &str) -> String {
    domain_fixture(name).trim().to_owned()
}

fn test_keysets() -> Keysets {
    parse_keysets(&domain_fixture("test-keyset.json")).unwrap()
}

/// The `role` ("license" or "update") test key, to sign what no fixture holds.
fn signer(role: &str) -> (String, EcdsaKeyPair) {
    let keys: Value = serde_json::from_str(&domain_fixture("test-private-keys.json")).unwrap();
    let jwk = &keys[role]["privateJwk"];
    let part = |name: &str| URL_SAFE_NO_PAD.decode(jwk[name].as_str().unwrap()).unwrap();
    let mut point = vec![0x04];
    point.extend(part("x"));
    point.extend(part("y"));
    let pair = EcdsaKeyPair::from_private_key_and_public_key(
        &ECDSA_P256_SHA256_FIXED_SIGNING,
        &part("d"),
        &point,
    )
    .unwrap();
    (keys[role]["kid"].as_str().unwrap().to_owned(), pair)
}

fn sign_raw(pair: &EcdsaKeyPair, header: &[u8], payload: &[u8]) -> String {
    let input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header),
        URL_SAFE_NO_PAD.encode(payload)
    );
    let signature = pair.sign(&SystemRandom::new(), input.as_bytes()).unwrap();
    format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.as_ref()))
}

fn header(typ: &str, kid: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({ "typ": typ, "alg": "ES256", "kid": kid })).unwrap()
}

/// The segments of a fixture, the signature decoded.
fn split(compact: &str) -> (String, String, Vec<u8>) {
    let parts: Vec<&str> = compact.split('.').collect();
    (
        parts[0].to_owned(),
        parts[1].to_owned(),
        URL_SAFE_NO_PAD.decode(parts[2]).unwrap(),
    )
}

#[test]
fn a_fixture_license_verifies_under_its_typ_and_kid() {
    let keysets = test_keysets();
    let verified = verify_compact(
        &signed("license-subscription.jws"),
        LICENSE_TYP,
        &keysets.license,
    )
    .unwrap();
    assert_eq!(verified.kid, "test-lic-1");
    let payload: Value = serde_json::from_slice(&verified.payload).unwrap();
    assert_eq!(payload["hostId"], HOST_ID);
    let manifest =
        verify_compact(&signed("update-manifest.jws"), UPDATE_TYP, &keysets.update).unwrap();
    assert_eq!(manifest.kid, "test-upd-1");
}

#[test]
fn a_changed_payload_a_foreign_signature_or_a_short_one_is_a_bad_signature() {
    let keysets = test_keysets();
    let check = |compact: &str| verify_compact(compact, LICENSE_TYP, &keysets.license);
    assert_eq!(
        check(&signed("license-tampered.jws")),
        Err(TrustError::BadSignature)
    );
    // The release key's signature under the license kid.
    let (_, update_key) = signer("update");
    let (_, payload, _) = split(&signed("license-subscription.jws"));
    let foreign = sign_raw(
        &update_key,
        &header(LICENSE_TYP, "test-lic-1"),
        &URL_SAFE_NO_PAD.decode(payload).unwrap(),
    );
    assert_eq!(check(&foreign), Err(TrustError::BadSignature));
    let (head, body, signature) = split(&signed("license-subscription.jws"));
    let short = format!("{head}.{body}.{}", URL_SAFE_NO_PAD.encode(&signature[..63]));
    assert_eq!(check(&short), Err(TrustError::BadSignature));
}

#[test]
fn an_unknown_retired_or_ambiguous_kid_is_an_unknown_key() {
    let keysets = test_keysets();
    let compact = signed("license-subscription.jws");
    assert_eq!(
        verify_compact(
            &signed("license-unknown-kid.jws"),
            LICENSE_TYP,
            &keysets.license
        ),
        Err(TrustError::UnknownKey)
    );
    let retired = Keyset {
        retired_kids: vec!["test-lic-1".to_owned()],
        ..keysets.license.clone()
    };
    assert_eq!(
        verify_compact(&compact, LICENSE_TYP, &retired),
        Err(TrustError::UnknownKey)
    );
    let key = keysets.license.keys[0].clone();
    let twice = Keyset {
        keys: vec![key.clone(), key],
        ..keysets.license.clone()
    };
    assert_eq!(
        verify_compact(&compact, LICENSE_TYP, &twice),
        Err(TrustError::UnknownKey)
    );
    // The right signature under the other keyset's keys.
    assert_eq!(
        verify_compact(&compact, LICENSE_TYP, &keysets.update),
        Err(TrustError::UnknownKey)
    );
}

#[test]
fn the_typ_keeps_a_license_and_an_update_manifest_apart() {
    let keysets = test_keysets();
    assert_eq!(
        verify_compact(&signed("update-manifest.jws"), LICENSE_TYP, &keysets.update),
        Err(TrustError::Malformed)
    );
    assert_eq!(
        verify_compact(
            &signed("license-subscription.jws"),
            UPDATE_TYP,
            &keysets.license
        ),
        Err(TrustError::Malformed)
    );
}

#[test]
fn a_header_other_than_typ_alg_kid_is_malformed_even_when_signed() {
    let keysets = test_keysets();
    let (kid, key) = signer("license");
    let payload = br#"{"any":"payload"}"#;
    for header in [
        json!({ "typ": LICENSE_TYP, "alg": "ES256", "kid": kid, "cty": "json" }),
        json!({ "typ": LICENSE_TYP, "alg": "ES384", "kid": kid }),
        json!({ "typ": LICENSE_TYP, "alg": "ES256" }),
        json!({ "typ": LICENSE_TYP, "alg": "ES256", "kid": "" }),
        json!({ "typ": LICENSE_TYP, "alg": "ES256", "kid": "k".repeat(129) }),
        json!([LICENSE_TYP, "ES256", kid]),
    ] {
        let compact = sign_raw(&key, &serde_json::to_vec(&header).unwrap(), payload);
        assert_eq!(
            verify_compact(&compact, LICENSE_TYP, &keysets.license),
            Err(TrustError::Malformed),
            "{header}"
        );
    }
    let bom = sign_raw(
        &key,
        &[b"\xEF\xBB\xBF".as_slice(), &header(LICENSE_TYP, &kid)].concat(),
        payload,
    );
    assert_eq!(
        verify_compact(&bom, LICENSE_TYP, &keysets.license),
        Err(TrustError::Malformed)
    );
    // The same payload under the plain header verifies: the header alone failed.
    let plain = sign_raw(&key, &header(LICENSE_TYP, &kid), payload);
    assert!(verify_compact(&plain, LICENSE_TYP, &keysets.license).is_ok());
}

#[test]
fn non_canonical_base64url_and_wrong_segment_counts_are_malformed() {
    let keysets = test_keysets();
    let compact = signed("license-subscription.jws");
    let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let last = compact.chars().last().unwrap();
    let bumped = alphabet
        .chars()
        .nth(alphabet.find(last).unwrap() + 1)
        .unwrap();
    let (head, body, _) = split(&compact);
    let signature = compact.rsplit('.').next().unwrap();
    for broken in [
        format!("{}{bumped}", &compact[..compact.len() - 1]),
        format!("{compact}="),
        format!("{head}.{body}"),
        format!("{compact}.{signature}"),
        format!("{head}..{signature}"),
        format!(
            "{head}.{body}.{}",
            signature.replace('-', "+").replace('_', "/")
        ),
        format!(" {compact}"),
        String::new(),
    ] {
        assert_eq!(
            verify_compact(&broken, LICENSE_TYP, &keysets.license),
            Err(TrustError::Malformed),
            "{broken}"
        );
    }
}

#[test]
fn the_refusal_codes_name_the_document() {
    let codes: Vec<&str> = [
        TrustError::Malformed,
        TrustError::UnknownKey,
        TrustError::BadSignature,
    ]
    .iter()
    .flat_map(|error| {
        [
            error.code(DocumentKind::License),
            error.code(DocumentKind::Update),
        ]
    })
    .collect();
    assert_eq!(
        codes,
        [
            "license_malformed",
            "update_malformed",
            "license_unknown_key",
            "update_unknown_key",
            "license_signature",
            "update_signature"
        ]
    );
    assert_eq!(TrustError::BadSignature.reason(), "bad_signature");
}

#[test]
fn a_keyset_document_takes_public_p256_keys_alone() {
    let real: Value = serde_json::from_str(&domain_fixture("test-keyset.json")).unwrap();
    let jwk = real["license"]["keys"][0]["jwk"].clone();
    let zero = URL_SAFE_NO_PAD.encode([0u8; 32]);
    let document = |license: Value, update: Value| json!({ "license": license, "update": update });
    let license = |keys: Value| json!({ "origin": "https://license.test.invalid", "keys": keys, "retiredKids": [] });
    let empty_update = json!({ "keys": [], "retiredKids": [] });
    let mut private = jwk.clone();
    private["d"] = json!(URL_SAFE_NO_PAD.encode([7u8; 32]));
    let mut p384 = jwk.clone();
    p384["crv"] = json!("P-384");
    let mut encrypting = jwk.clone();
    encrypting["use"] = json!("enc");
    let mut short = jwk.clone();
    short["x"] = json!(URL_SAFE_NO_PAD.encode([1u8; 31]));
    let off_curve = json!({ "kty": "EC", "crv": "P-256", "x": zero, "y": zero });
    for (name, text) in [
        (
            "private key",
            document(
                license(json!([{ "kid": "a", "jwk": private }])),
                empty_update.clone(),
            ),
        ),
        (
            "P-384",
            document(
                license(json!([{ "kid": "a", "jwk": p384 }])),
                empty_update.clone(),
            ),
        ),
        (
            "encryption key",
            document(
                license(json!([{ "kid": "a", "jwk": encrypting }])),
                empty_update.clone(),
            ),
        ),
        (
            "31-byte x",
            document(
                license(json!([{ "kid": "a", "jwk": short }])),
                empty_update.clone(),
            ),
        ),
        (
            "off the curve",
            document(
                license(json!([{ "kid": "a", "jwk": off_curve }])),
                empty_update.clone(),
            ),
        ),
        (
            "kid twice",
            document(
                license(json!([{ "kid": "a", "jwk": jwk }, { "kid": "a", "jwk": jwk }])),
                empty_update.clone(),
            ),
        ),
        (
            "empty kid",
            document(
                license(json!([{ "kid": "", "jwk": jwk }])),
                empty_update.clone(),
            ),
        ),
        (
            "keys without origin",
            document(
                json!({ "origin": null, "keys": [{ "kid": "a", "jwk": jwk }], "retiredKids": [] }),
                empty_update.clone(),
            ),
        ),
        (
            "release origin",
            document(
                license(json!([])),
                json!({ "origin": "https://x.invalid", "keys": [], "retiredKids": [] }),
            ),
        ),
        (
            "unknown field",
            json!({ "license": license(json!([])), "update": empty_update, "comment": "x" }),
        ),
    ] {
        assert!(parse_keysets(&text.to_string()).is_err(), "{name}");
    }
    let fine = document(license(json!([{ "kid": "a", "jwk": jwk }])), empty_update);
    let keysets = parse_keysets(&fine.to_string()).unwrap();
    assert_eq!(keysets.license.keys[0].public_key.len(), 65);
    assert_eq!(keysets.license.keys[0].public_key[0], 0x04);
}

/// The base of a schema case with its `set` and `remove` applied (dotted
/// paths, as `test/standalone-license.test.ts` applies them).
fn apply(base: &Value, case: &Value) -> Value {
    let mut value = base.clone();
    if let Some(set) = case.get("set").and_then(Value::as_object) {
        for (path, next) in set {
            let (target, key) = parent(&mut value, path);
            target.insert(key, next.clone());
        }
    }
    if let Some(remove) = case.get("remove").and_then(Value::as_array) {
        for path in remove {
            let path = path.as_str().unwrap();
            let (target, key) = parent(&mut value, path);
            assert!(target.remove(&key).is_some(), "nothing at {path}");
        }
    }
    value
}

fn parent<'a>(root: &'a mut Value, path: &str) -> (&'a mut serde_json::Map<String, Value>, String) {
    let mut parts: Vec<&str> = path.split('.').collect();
    let key = parts.pop().unwrap().to_owned();
    let mut target = root;
    for part in parts {
        target = target
            .get_mut(part)
            .unwrap_or_else(|| panic!("no object for {path}"));
    }
    (
        target
            .as_object_mut()
            .unwrap_or_else(|| panic!("no object for {path}")),
        key,
    )
}

fn license_fits(bytes: &[u8]) -> bool {
    LicensePayloadV1::from_json(bytes).is_ok()
}
fn manifest_fits(bytes: &[u8]) -> bool {
    UpdateManifestV1::from_json(bytes).is_ok()
}
fn activation_fits(bytes: &[u8]) -> bool {
    ActivationRequest::from_json(bytes).is_ok()
}

#[test]
fn the_payload_rules_answer_the_shared_cases_as_the_zod_schemas_do() {
    let cases: Value = serde_json::from_str(&domain_fixture("schema-cases.json")).unwrap();
    let mut checked = 0;
    for (group, fits) in [
        ("license", license_fits as fn(&[u8]) -> bool),
        ("manifest", manifest_fits),
        ("activation", activation_fits),
    ] {
        let base = &cases[group]["base"];
        for case in cases[group]["cases"].as_array().unwrap() {
            let bytes = serde_json::to_vec(&apply(base, case)).unwrap();
            assert_eq!(
                fits(&bytes),
                case["valid"].as_bool().unwrap(),
                "{group}: {}",
                case["name"]
            );
            checked += 1;
        }
    }
    assert!(checked >= 90, "{checked}");
}

#[test]
fn a_payload_that_is_an_array_or_no_utf8_json_is_refused() {
    let base: Value = serde_json::from_str(&domain_fixture("schema-cases.json")).unwrap();
    let license = &base["license"]["base"];
    let as_array = Value::Array(license.as_object().unwrap().values().cloned().collect());
    assert!(!license_fits(&serde_json::to_vec(&as_array).unwrap()));
    assert!(!license_fits(b"\xEF\xBB\xBF{}"));
    assert!(!license_fits(b"{\"version\":1,"));
    assert!(!license_fits(&[0xff, 0xfe]));
    // A repeated key keeps its last value, as JSON.parse does.
    let mut text = serde_json::to_string(license).unwrap();
    text.insert_str(1, "\"graceDays\":99,");
    assert!(license_fits(text.as_bytes()));
}

#[test]
fn the_signed_fixtures_verify_as_the_domain_says() {
    let keysets = test_keysets();
    let expectations: Vec<Value> =
        serde_json::from_str(&domain_fixture("expectations.json")).unwrap();
    assert!(expectations.len() >= 11);
    for expectation in &expectations {
        let file = expectation["file"].as_str().unwrap();
        let compact = signed(file);
        let outcome = match expectation["as"].as_str().unwrap() {
            "license" => verify_license(&compact, &keysets.license).map(|_| ()),
            "update" => verify_update_manifest(&compact, &keysets.update).map(|_| ()),
            other => panic!("{other}"),
        };
        assert_eq!(
            outcome.map_or_else(TrustError::reason, |()| "ok"),
            expectation["result"].as_str().unwrap(),
            "{file} as {}",
            expectation["as"]
        );
    }
}

#[test]
fn a_verified_license_carries_its_fields_and_kid() {
    let keysets = test_keysets();
    let (subscription, kid) =
        verify_license(&signed("license-subscription.jws"), &keysets.license).unwrap();
    assert_eq!(kid, "test-lic-1");
    assert_eq!(subscription.host_id, HOST_ID);
    assert_eq!(subscription.plan, LicensePlan::Subscription);
    assert_eq!(subscription.customer.inn, "7707083893");
    assert_eq!(subscription.quotas.stations, Some(5));
    assert!(subscription.features.handheld);
    assert_eq!(subscription.replaces, None);
    let (upgrade, _) = verify_license(&signed("license-upgrade.jws"), &keysets.license).unwrap();
    assert_eq!(upgrade.sequence, 2);
    assert_eq!(upgrade.quotas.stations, Some(8));
    assert_eq!(
        upgrade.replaces.as_deref(),
        Some(subscription.license_id.as_str())
    );
    let (demo, _) = verify_license(&signed("license-demo.jws"), &keysets.license).unwrap();
    assert_eq!((demo.plan, demo.grace_days), (LicensePlan::Demo, 0));
    let (manifest, kid) =
        verify_update_manifest(&signed("update-manifest.jws"), &keysets.update).unwrap();
    assert_eq!(kid, "test-upd-1");
    assert_eq!(manifest.version, "0.3.0");
    assert_eq!(manifest.channel, UpdateChannel::Stable);
    assert_eq!(
        manifest.installer.name,
        "markiro-standalone-0.3.0-windows-x86_64-setup.exe"
    );
}

#[test]
fn a_license_of_another_issuer_or_with_an_unknown_field_is_malformed_after_its_signature() {
    let keysets = test_keysets();
    let compact = signed("license-subscription.jws");
    let other = Keyset {
        origin: Some("https://other.invalid".to_owned()),
        ..keysets.license.clone()
    };
    assert_eq!(verify_license(&compact, &other), Err(TrustError::Malformed));
    let none = Keyset {
        origin: None,
        ..keysets.license.clone()
    };
    assert_eq!(verify_license(&compact, &none), Err(TrustError::Malformed));
    let (kid, key) = signer("license");
    let (_, body, _) = split(&compact);
    let mut payload: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(body).unwrap()).unwrap();
    payload["limits"] = json!({});
    let extra = sign_raw(
        &key,
        &header(LICENSE_TYP, &kid),
        &serde_json::to_vec(&payload).unwrap(),
    );
    assert_eq!(
        verify_license(&extra, &keysets.license),
        Err(TrustError::Malformed)
    );
}

#[test]
fn an_oversized_file_is_refused_unread() {
    let keysets = test_keysets();
    assert_eq!(MAX_LICENSE_BYTES, 16 * 1024);
    assert_eq!(MAX_UPDATE_MANIFEST_BYTES, 64 * 1024);
    let compact = signed("license-subscription.jws");
    assert!(compact.len() < MAX_LICENSE_BYTES);
    // A valid license followed by padding up to one byte over the limit: the
    // size alone refuses it, before any segment is read.
    let oversized = format!(
        "{compact}{}",
        " ".repeat(MAX_LICENSE_BYTES + 1 - compact.len())
    );
    assert_eq!(
        verify_license(&oversized, &keysets.license),
        Err(TrustError::Malformed)
    );
    let manifest = signed("update-manifest.jws");
    let oversized = format!(
        "{manifest}{}",
        " ".repeat(MAX_UPDATE_MANIFEST_BYTES + 1 - manifest.len())
    );
    assert_eq!(
        verify_update_manifest(&oversized, &keysets.update),
        Err(TrustError::Malformed)
    );
}

#[test]
fn the_activation_request_round_trips_as_the_host_will_write_it() {
    let original: Value = serde_json::from_str(&domain_fixture("activation-request.json")).unwrap();
    let request = ActivationRequest::from_json(&serde_json::to_vec(&original).unwrap()).unwrap();
    assert_eq!(request.host_id, HOST_ID);
    assert!(request.is_valid());
    assert_eq!(serde_json::to_value(&request).unwrap(), original);
}

#[test]
fn tenant_and_site_ids_are_opaque_ids_kept_as_the_counterparty_wrote_them() {
    let keysets = test_keysets();
    let (subscription, _) =
        verify_license(&signed("license-subscription.jws"), &keysets.license).unwrap();
    // Not a UUID, mixed case, kept byte for byte.
    assert_eq!(subscription.tenant_id, "Zq4bL0x9cabinetTenant01");
    for good in [
        "7",
        "Acme",
        "acme",
        "acme.site_01:main-2",
        "00000000-0000-0000-0000-000000000000",
        &"a".repeat(64),
    ] {
        assert!(is_opaque_id(good), "{good:?}");
    }
    for hostile in [
        "",
        &"a".repeat(65),
        "a b",
        " acme",
        "a\u{0}b",
        "a\tb",
        "acme\n",
        "tenant/1",
        "tenant\\1",
        "t\u{435}nant",
        "\u{ff41}cme",
        "acme\u{200b}",
        "acme\u{a0}",
    ] {
        assert!(!is_opaque_id(hostile), "{hostile:?}");
    }
}
