//! Trust in signed documents (spec 2026-10-13 §4-5, plan ЛЦ-1): a compact
//! JWS with ES256 — `header.payload.signature`, the header exactly
//! `{"typ", "alg": "ES256", "kid"}`, the 64-byte IEEE P1363 signature over
//! the exact bytes `header.payload`, every segment canonical unpadded
//! base64url — checked against a keyset of public P-256 keys by `kid`.
//! `@markiro/domain` (`verifyCompactJws`, `verifyStandaloneLicense`) is the
//! TypeScript twin; the fixtures of `packages/domain/fixtures/standalone-license/`
//! hold both to the same answers (`tests/trust.rs`).
//!
//! The keysets a build trusts come from `fixtures/trust-keys.json` (public
//! keys only). The domain's test keys join them only under `cfg(test)` or the
//! `test-keys` feature, which only the host's dev-dependency enables: a
//! release build never trusts them (`markiro-host trust-keys`, checked in CI).

use std::sync::OnceLock;

use aws_lc_rs::signature::{ParsedPublicKey, UnparsedPublicKey, ECDSA_P256_SHA256_FIXED};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;

/// `typ` of a license file's header.
pub const LICENSE_TYP: &str = "markiro-standalone-license+jws";
/// `typ` of an update manifest's header.
pub const UPDATE_TYP: &str = "markiro-standalone-update+jws";
/// The longest `kid`, in UTF-16 code units as the domain's Zod counts.
const MAX_KID_UNITS: usize = 128;

const PRODUCTION_KEYS: &str = include_str!("../fixtures/trust-keys.json");
#[cfg(any(test, feature = "test-keys"))]
const TEST_KEYS: &str =
    include_str!("../../../../packages/domain/fixtures/standalone-license/test-keyset.json");

/// Why a signed document is refused. The order of the checks is the
/// domain's: form, then `kid`, then signature, then the payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustError {
    /// Size, segments, base64url, header, `typ`, payload or issuer.
    Malformed,
    /// The `kid` is not in the keyset once, or is retired.
    UnknownKey,
    /// The signature is not 64 bytes or does not verify.
    BadSignature,
}

/// What a refused document is, for its refusal code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentKind {
    License,
    Update,
}

impl TrustError {
    /// The reason the domain gives (`CompactJwsFailure`).
    pub const fn reason(self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::UnknownKey => "unknown_key",
            Self::BadSignature => "bad_signature",
        }
    }

    /// The refusal code a caller reports for a document of `kind`: the
    /// license's are the host's validation reasons of spec §4.3.
    pub const fn code(self, kind: DocumentKind) -> &'static str {
        match (kind, self) {
            (DocumentKind::License, Self::Malformed) => "license_malformed",
            (DocumentKind::License, Self::UnknownKey) => "license_unknown_key",
            (DocumentKind::License, Self::BadSignature) => "license_signature",
            (DocumentKind::Update, Self::Malformed) => "update_malformed",
            (DocumentKind::Update, Self::UnknownKey) => "update_unknown_key",
            (DocumentKind::Update, Self::BadSignature) => "update_signature",
        }
    }
}

impl std::fmt::Display for TrustError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.reason())
    }
}

impl std::error::Error for TrustError {}

/// A public P-256 key: `public_key` is the SEC1 uncompressed point
/// (`04 || x || y`) of its JWK.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedKey {
    pub kid: String,
    pub public_key: Vec<u8>,
}

/// Keys by `kid`; `origin` is the license issuer (`None` for the release
/// keyset, and for a license keyset without keys).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Keyset {
    pub origin: Option<String>,
    pub keys: Vec<TrustedKey>,
    pub retired_kids: Vec<String>,
}

/// A keyset document: the license keyset and the release keyset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Keysets {
    pub license: Keyset,
    pub update: Keyset,
}

/// A verified document: its `kid` and the payload's bytes, unread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified {
    pub kid: String,
    pub payload: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KeysetsFile {
    license: KeysetFile,
    update: KeysetFile,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct KeysetFile {
    origin: Option<String>,
    keys: Vec<KeyFile>,
    retired_kids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyFile {
    kid: String,
    jwk: PublicJwk,
}

/// A public JWK: a private one carries `d`, an unknown field here.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PublicJwk {
    kty: String,
    crv: String,
    x: String,
    y: String,
    alg: Option<String>,
    #[serde(rename = "use")]
    usage: Option<String>,
}

/// Reads a keyset document (`fixtures/trust-keys.json`, the domain's
/// `test-keyset.json`). Refused, with the reason: a private key (`d`), a key
/// that is not a P-256 signing key or not a point of the curve, an empty or
/// repeated `kid`, a license keyset with keys but no origin, a release
/// keyset with an origin.
pub fn parse_keysets(text: &str) -> Result<Keysets, String> {
    let file: KeysetsFile =
        serde_json::from_str(text).map_err(|error| format!("keyset document: {error}"))?;
    let license = keyset(file.license, "license")?;
    let update = keyset(file.update, "update")?;
    if !license.keys.is_empty() && license.origin.is_none() {
        return Err("license: keys need an origin".to_owned());
    }
    if update.origin.is_some() {
        return Err("update: a release keyset has no origin".to_owned());
    }
    Ok(Keysets { license, update })
}

fn keyset(file: KeysetFile, name: &str) -> Result<Keyset, String> {
    if file.origin.as_deref() == Some("") {
        return Err(format!("{name}: an empty origin"));
    }
    let mut keys: Vec<TrustedKey> = Vec::with_capacity(file.keys.len());
    for entry in file.keys {
        if entry.kid.is_empty() || entry.kid.encode_utf16().count() > MAX_KID_UNITS {
            return Err(format!("{name}: a kid is empty or too long"));
        }
        if keys.iter().any(|key| key.kid == entry.kid) {
            return Err(format!("{name}: kid {} twice", entry.kid));
        }
        let public_key = public_point(&entry.jwk)
            .map_err(|reason| format!("{name}: kid {}: {reason}", entry.kid))?;
        keys.push(TrustedKey {
            kid: entry.kid,
            public_key,
        });
    }
    Ok(Keyset {
        origin: file.origin,
        keys,
        retired_kids: file.retired_kids,
    })
}

fn public_point(jwk: &PublicJwk) -> Result<Vec<u8>, &'static str> {
    if jwk.kty != "EC" || jwk.crv != "P-256" {
        return Err("not a P-256 key");
    }
    if jwk.alg.as_deref().is_some_and(|alg| alg != "ES256")
        || jwk.usage.as_deref().is_some_and(|usage| usage != "sig")
    {
        return Err("not a signing key");
    }
    let x = decode_segment(&jwk.x).ok_or("x is not canonical base64url")?;
    let y = decode_segment(&jwk.y).ok_or("y is not canonical base64url")?;
    if x.len() != 32 || y.len() != 32 {
        return Err("a coordinate is not 32 bytes");
    }
    let mut point = Vec::with_capacity(65);
    point.push(0x04);
    point.extend_from_slice(&x);
    point.extend_from_slice(&y);
    ParsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, &point).map_err(|_| "not a point of P-256")?;
    Ok(point)
}

/// The bytes of a canonical unpadded base64url segment (the domain's
/// `decodeBase64UrlCanonical`): re-encoding them gives the same text.
fn decode_segment(segment: &str) -> Option<Vec<u8>> {
    if segment.is_empty()
        || !segment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(segment).ok()?;
    (URL_SAFE_NO_PAD.encode(&bytes) == segment).then_some(bytes)
}

/// A JSON object of `bytes` as `T`, the way the domain's `JSON.parse` and
/// Zod read it. serde alone would also take a struct from a JSON array (its
/// fields in order), which Zod refuses: every pointer of `objects` must hold
/// an object, every pointer of `nullable` an object or `null`. Parsed
/// through a `Value`, a repeated key keeps its last value, as in JavaScript.
fn read_object<T: DeserializeOwned>(
    bytes: &[u8],
    objects: &[&str],
    nullable: &[&str],
) -> Result<T, TrustError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| TrustError::Malformed)?;
    let shaped = objects
        .iter()
        .all(|pointer| value.pointer(pointer).is_some_and(Value::is_object))
        && nullable.iter().all(|pointer| {
            value
                .pointer(pointer)
                .map_or(true, |field| field.is_object() || field.is_null())
        });
    if !shaped {
        return Err(TrustError::Malformed);
    }
    serde_json::from_value(value).map_err(|_| TrustError::Malformed)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProtectedHeader {
    typ: String,
    alg: String,
    kid: String,
}

/// Checks a compact JWS of type `typ` against `keyset` (the domain's
/// `verifyCompactJws`): the payload comes back unread.
pub fn verify_compact(compact: &str, typ: &str, keyset: &Keyset) -> Result<Verified, TrustError> {
    let mut parts = compact.split('.');
    let (Some(encoded_header), Some(encoded_payload), Some(encoded_signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(TrustError::Malformed);
    };
    let header_bytes = decode_segment(encoded_header).ok_or(TrustError::Malformed)?;
    let header: ProtectedHeader = read_object(&header_bytes, &[""], &[])?;
    if header.typ != typ
        || header.alg != "ES256"
        || header.kid.is_empty()
        || header.kid.encode_utf16().count() > MAX_KID_UNITS
    {
        return Err(TrustError::Malformed);
    }
    let payload = decode_segment(encoded_payload).ok_or(TrustError::Malformed)?;
    let signature = decode_segment(encoded_signature).ok_or(TrustError::Malformed)?;
    if keyset.retired_kids.contains(&header.kid) {
        return Err(TrustError::UnknownKey);
    }
    // An ambiguous keyset fails closed rather than trusting the order.
    let mut named = keyset.keys.iter().filter(|key| key.kid == header.kid);
    let (Some(key), None) = (named.next(), named.next()) else {
        return Err(TrustError::UnknownKey);
    };
    if signature.len() != 64 {
        return Err(TrustError::BadSignature);
    }
    let signed = &compact.as_bytes()[..encoded_header.len() + 1 + encoded_payload.len()];
    UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, &key.public_key)
        .verify(signed, &signature)
        .map_err(|_| TrustError::BadSignature)?;
    Ok(Verified {
        kid: header.kid,
        payload,
    })
}

fn production_keysets() -> Keysets {
    parse_keysets(PRODUCTION_KEYS).expect("fixtures/trust-keys.json is a valid keyset document")
}

fn built_in() -> &'static Keysets {
    static KEYSETS: OnceLock<Keysets> = OnceLock::new();
    KEYSETS.get_or_init(|| {
        #[allow(unused_mut)]
        let mut keysets = production_keysets();
        #[cfg(any(test, feature = "test-keys"))]
        {
            let test = parse_keysets(TEST_KEYS).expect("the domain's test keyset is valid");
            keysets.license = with_test_keys(keysets.license, test.license);
            keysets.update = with_test_keys(keysets.update, test.update);
        }
        keysets
    })
}

/// The production keys and the test keys together. A keyset has one origin,
/// so a test build takes licenses of the test issuer alone.
#[cfg(any(test, feature = "test-keys"))]
fn with_test_keys(mut production: Keyset, test: Keyset) -> Keyset {
    for key in test.keys {
        assert!(
            !production.keys.iter().any(|known| known.kid == key.kid),
            "the test kid {} is a production kid",
            key.kid
        );
        production.keys.push(key);
    }
    production.retired_kids.extend(test.retired_kids);
    if test.origin.is_some() {
        production.origin = test.origin;
    }
    production
}

/// The license keyset this build trusts.
pub fn license_keyset() -> Keyset {
    built_in().license.clone()
}

/// The release keyset this build trusts.
pub fn update_keyset() -> Keyset {
    built_in().update.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_production_keysets_are_public_keys_without_a_test_kid() {
        let production = production_keysets();
        for key in production
            .license
            .keys
            .iter()
            .chain(&production.update.keys)
        {
            assert!(!key.kid.starts_with("test-"), "{}", key.kid);
        }
        assert!(production.license.keys.is_empty() || production.license.origin.is_some());
        assert_eq!(production.update.origin, None);
    }

    #[test]
    fn a_test_build_trusts_the_test_keys_beside_the_production_ones() {
        let production = production_keysets();
        let license = license_keyset();
        let update = update_keyset();
        assert!(license.keys.iter().any(|key| key.kid == "test-lic-1"));
        assert!(update.keys.iter().any(|key| key.kid == "test-upd-1"));
        assert_eq!(
            license.origin.as_deref(),
            Some("https://license.test.invalid")
        );
        for key in &production.license.keys {
            assert!(license.keys.contains(key), "{}", key.kid);
        }
        for key in &production.update.keys {
            assert!(update.keys.contains(key), "{}", key.kid);
        }
    }
}
