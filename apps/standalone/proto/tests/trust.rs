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
    parse_keysets, verify_compact, DocumentKind, Keyset, Keysets, TrustError, LICENSE_TYP,
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
