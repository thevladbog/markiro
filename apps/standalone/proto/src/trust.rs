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
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

/// `typ` of a license file's header.
pub const LICENSE_TYP: &str = "markiro-standalone-license+jws";
/// `typ` of an update manifest's header.
pub const UPDATE_TYP: &str = "markiro-standalone-update+jws";
/// A license file above this many bytes is refused unread (spec §4.3).
pub const MAX_LICENSE_BYTES: usize = 16 * 1024;
/// An update manifest above this many bytes is refused unread (spec §10.11.2).
pub const MAX_UPDATE_MANIFEST_BYTES: usize = 64 * 1024;
/// `format` of the host's activation request (spec §6.3).
pub const ACTIVATION_REQUEST_FORMAT: &str = "markiro-activation-request-v1";
/// The longest `kid`, in UTF-16 code units as the domain's Zod counts.
const MAX_KID_UNITS: usize = 128;
/// `Number.MAX_SAFE_INTEGER`: the domain reads every count and instant as a
/// JavaScript number, so a larger one is malformed on both sides.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

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

/// An origin as the cloud's `SAAS_ADMIN_ORIGIN` serializes it: `https://`, a
/// lower-case host and an optional port, no path and no trailing `/`. A
/// license's `issuer` is compared with it byte for byte.
fn is_origin(text: &str) -> bool {
    let Some(authority) = text.strip_prefix("https://") else {
        return false;
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (authority, None),
    };
    // Every DNS label non-empty, of lower-case letters, digits and inner hyphens.
    host.split('.').all(|label| {
        !label.is_empty()
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    }) && port.map_or(true, |port| {
        (1..=5).contains(&port.len())
            && port.bytes().all(|byte| byte.is_ascii_digit())
            && !port.starts_with('0')
            && port.parse::<u16>().is_ok()
    })
}

fn keyset(file: KeysetFile, name: &str) -> Result<Keyset, String> {
    if file
        .origin
        .as_deref()
        .is_some_and(|origin| !is_origin(origin))
    {
        return Err(format!("{name}: the origin is not https://host[:port]"));
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

/// Reads an `Option` field that must be present, `null` or a value: serde
/// alone would read a missing `Option` as `None`, where the domain's Zod
/// refuses it.
fn required<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// A lower-case canonical UUID of versions 1-8 and the RFC variant.
fn is_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(byte),
        })
        && (b'1'..=b'8').contains(&bytes[14])
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}

/// An identifier the counterparty chooses (the license's `tenantId` and
/// `siteId`, owner decision 2026-10-13): 1-64 ASCII letters, digits and `.`,
/// `_`, `:`, `-`, compared byte for byte (never lower-cased or trimmed). The
/// domain's `STANDALONE_OPAQUE_ID_PATTERN` is the twin.
pub fn is_opaque_id(text: &str) -> bool {
    (1..=64).contains(&text.len())
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn is_lower_hex(text: &str, length: usize) -> bool {
    text.len() == length
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Ten or twelve ASCII digits: the shape; the check digits are the host's
/// (`markiro_host::inn`), since a wrong one is a mismatch, not a bad file.
fn is_inn_shape(text: &str) -> bool {
    (text.len() == 10 || text.len() == 12) && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// Non-empty, at most `max` UTF-16 units, and no character that changes how
/// the text around it shows: C0 and C1 controls with DEL, the line and
/// paragraph separators, the bidirectional embeddings, overrides and
/// isolates (the domain's `isPlainText`).
fn is_plain_text(text: &str, max: usize) -> bool {
    !text.is_empty()
        && utf16_len(text) <= max
        && !text.chars().any(|character| {
            matches!(
                character,
                '\u{0}'..='\u{1f}'
                    | '\u{7f}'..='\u{9f}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202a}'..='\u{202e}'
                    | '\u{2066}'..='\u{2069}'
            )
        })
}

/// `0` or a decimal without a leading zero, at most 19 digits.
fn is_decimal_revision(text: &str) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 19
        && bytes.iter().all(u8::is_ascii_digit)
        && (bytes.len() == 1 || bytes[0] != b'0')
}

/// `YYYY-MM-DDTHH:MM:SS[.fraction]Z`, the shape the domain's Zod checks.
fn is_utc_instant(text: &str) -> bool {
    let bytes = text.as_bytes();
    let shape = b"dddd-dd-ddTdd:dd:dd";
    if bytes.len() < shape.len() + 1 || bytes.last() != Some(&b'Z') {
        return false;
    }
    let fixed = shape.iter().zip(bytes).all(|(expected, byte)| {
        if *expected == b'd' {
            byte.is_ascii_digit()
        } else {
            expected == byte
        }
    });
    let fraction = &bytes[shape.len()..bytes.len() - 1];
    fixed
        && (fraction.is_empty()
            || (fraction[0] == b'.'
                && (2..=10).contains(&fraction.len())
                && fraction[1..].iter().all(u8::is_ascii_digit)))
}

/// `X.Y.Z`, each part `0` or up to nine digits without a leading zero.
fn version_parts(text: &str) -> Option<[u32; 3]> {
    let mut parts = text.split('.');
    let mut out = [0u32; 3];
    for slot in &mut out {
        let part = parts.next()?;
        if part.is_empty()
            || part.len() > 9
            || !part.bytes().all(|byte| byte.is_ascii_digit())
            || (part.len() > 1 && part.starts_with('0'))
        {
            return None;
        }
        *slot = part.parse().ok()?;
    }
    parts.next().is_none().then_some(out)
}

/// A license file's payload (spec §4.2), the domain's
/// `standaloneLicensePayloadV1Schema`: read strictly, an unknown field is
/// malformed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LicensePayloadV1 {
    pub version: u8,
    pub license_id: String,
    pub sequence: u64,
    pub issuer: String,
    pub tenant_id: String,
    pub site_id: String,
    pub host_id: String,
    pub customer: LicenseCustomer,
    pub plan: LicensePlan,
    pub plan_version_id: String,
    pub entitlement_revision: String,
    pub issued_at: u64,
    pub valid_from: u64,
    pub valid_until: u64,
    pub grace_days: u8,
    pub quotas: LicenseQuotas,
    pub features: LicenseFeatures,
    #[serde(deserialize_with = "required")]
    pub replaces: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LicenseCustomer {
    pub name: String,
    pub inn: String,
}

/// Read from a JSON string only: serde alone would also take an enum from a
/// one-key object (`{"demo": null}`), which the domain's `z.enum` refuses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", try_from = "String")]
pub enum LicensePlan {
    Demo,
    Subscription,
}

impl TryFrom<String> for LicensePlan {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "demo" => Ok(Self::Demo),
            "subscription" => Ok(Self::Subscription),
            _ => Err("not a license plan"),
        }
    }
}

/// The cloud's quotas; `None` is no limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LicenseQuotas {
    #[serde(deserialize_with = "required")]
    pub lines: Option<u64>,
    #[serde(deserialize_with = "required")]
    pub stations: Option<u64>,
    #[serde(deserialize_with = "required")]
    pub kiosks: Option<u64>,
    #[serde(deserialize_with = "required")]
    pub cabinet_users: Option<u64>,
}

/// The cloud's features.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LicenseFeatures {
    pub label_editor: bool,
    pub public_api: bool,
    pub pallets: bool,
    pub chz_integration: bool,
    pub inventory: bool,
    pub commerce_ml: bool,
    pub handheld: bool,
    /// Custom branding: the organization's own logo on printed forms and
    /// labels. Absent from a file issued before it existed, which reads as
    /// off (the Markiro logo), whatever else the file says.
    #[serde(default)]
    pub custom_logo: bool,
}

impl LicensePayloadV1 {
    /// The payload of `bytes`, if it is one (shape and rules).
    pub fn from_json(bytes: &[u8]) -> Result<Self, TrustError> {
        let payload: Self = read_object(bytes, &["", "/customer", "/quotas", "/features"], &[])?;
        if payload.is_valid() {
            Ok(payload)
        } else {
            Err(TrustError::Malformed)
        }
    }

    /// The rules serde does not check (the domain's refinements).
    pub fn is_valid(&self) -> bool {
        let quotas = [
            self.quotas.lines,
            self.quotas.stations,
            self.quotas.kiosks,
            self.quotas.cabinet_users,
        ];
        self.version == 1
            && is_uuid(&self.license_id)
            && (1..=MAX_SAFE_INTEGER).contains(&self.sequence)
            && !self.issuer.is_empty()
            && utf16_len(&self.issuer) <= 256
            && is_opaque_id(&self.tenant_id)
            && is_opaque_id(&self.site_id)
            && is_uuid(&self.host_id)
            && is_plain_text(&self.customer.name, 300)
            && is_inn_shape(&self.customer.inn)
            && is_uuid(&self.plan_version_id)
            && is_decimal_revision(&self.entitlement_revision)
            && [self.issued_at, self.valid_from, self.valid_until]
                .iter()
                .all(|instant| *instant <= MAX_SAFE_INTEGER)
            && self.valid_from < self.valid_until
            && self.grace_days <= 60
            && quotas
                .iter()
                .flatten()
                .all(|limit| *limit <= MAX_SAFE_INTEGER)
            && self.replaces.as_deref().map_or(true, is_uuid)
    }
}

/// The signed update manifest (spec §10.2), the domain's
/// `standaloneUpdateManifestV1Schema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct UpdateManifestV1 {
    pub v: u8,
    pub product: String,
    pub version: String,
    pub channel: UpdateChannel,
    pub released_at: String,
    pub source_sha: String,
    pub installer: UpdateInstaller,
    pub protocol: u32,
    pub min_protocol: u32,
    pub min_upgrade_from: String,
    pub notes: Vec<String>,
}

/// Read from a JSON string only, as `LicensePlan`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", try_from = "String")]
pub enum UpdateChannel {
    Beta,
    Stable,
}

impl TryFrom<String> for UpdateChannel {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "beta" => Ok(Self::Beta),
            "stable" => Ok(Self::Stable),
            _ => Err("not an update channel"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct UpdateInstaller {
    pub name: String,
    pub sha256: String,
    pub size_bytes: u64,
}

impl UpdateManifestV1 {
    /// The manifest of `bytes`, if it is one (shape and rules).
    pub fn from_json(bytes: &[u8]) -> Result<Self, TrustError> {
        let manifest: Self = read_object(bytes, &["", "/installer"], &[])?;
        if manifest.is_valid() {
            Ok(manifest)
        } else {
            Err(TrustError::Malformed)
        }
    }

    /// The rules serde does not check (the domain's refinements).
    pub fn is_valid(&self) -> bool {
        let (Some(version), Some(oldest)) = (
            version_parts(&self.version),
            version_parts(&self.min_upgrade_from),
        ) else {
            return false;
        };
        self.v == 1
            && self.product == "markiro-standalone"
            && oldest <= version
            && is_utc_instant(&self.released_at)
            && is_lower_hex(&self.source_sha, 40)
            && self.installer.name
                == format!(
                    "markiro-standalone-{}-windows-x86_64-setup.exe",
                    self.version
                )
            && is_lower_hex(&self.installer.sha256, 64)
            && (1..=MAX_SAFE_INTEGER).contains(&self.installer.size_bytes)
            && self.min_protocol >= 1
            && self.min_protocol <= self.protocol
            && self.notes.len() <= 30
            && self.notes.iter().all(|note| is_plain_text(note, 200))
    }
}

/// The host's activation request (spec §6.3), the domain's
/// `standaloneActivationRequestSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ActivationRequest {
    pub format: String,
    pub host_id: String,
    pub host_fingerprint: String,
    pub host_version: String,
    pub organization: ActivationOrganization,
    #[serde(deserialize_with = "required")]
    pub trial: Option<ActivationTrial>,
    #[serde(deserialize_with = "required")]
    pub current_license: Option<ActivationLicense>,
    pub usage: ActivationUsage,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivationOrganization {
    pub name: String,
    /// Empty while the organization has none.
    pub inn: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ActivationTrial {
    pub started_at: String,
    pub inn: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ActivationLicense {
    pub license_id: String,
    pub sequence: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ActivationUsage {
    pub stations: u64,
    pub cabinet_users: u64,
    pub lines: u64,
}

impl ActivationRequest {
    /// The request of `bytes`, if it is one (shape and rules).
    pub fn from_json(bytes: &[u8]) -> Result<Self, TrustError> {
        let request: Self = read_object(
            bytes,
            &["", "/organization", "/usage"],
            &["/trial", "/currentLicense"],
        )?;
        if request.is_valid() {
            Ok(request)
        } else {
            Err(TrustError::Malformed)
        }
    }

    /// The rules serde does not check; the host checks what it builds.
    pub fn is_valid(&self) -> bool {
        let inn_or_none = |inn: &str| inn.is_empty() || is_inn_shape(inn);
        self.format == ACTIVATION_REQUEST_FORMAT
            && is_uuid(&self.host_id)
            && is_lower_hex(&self.host_fingerprint, 64)
            && version_parts(&self.host_version).is_some()
            && is_plain_text(&self.organization.name, 300)
            && inn_or_none(&self.organization.inn)
            && self.trial.as_ref().map_or(true, |trial| {
                is_utc_instant(&trial.started_at) && inn_or_none(&trial.inn)
            })
            && self.current_license.as_ref().map_or(true, |license| {
                is_uuid(&license.license_id) && (1..=MAX_SAFE_INTEGER).contains(&license.sequence)
            })
            && [
                self.usage.stations,
                self.usage.cabinet_users,
                self.usage.lines,
            ]
            .iter()
            .all(|count| *count <= MAX_SAFE_INTEGER)
            && is_utc_instant(&self.created_at)
    }
}

/// Steps 1-4 of the host's check (spec §4.3): size, form, `kid`, signature,
/// the payload strictly and its issuer against the keyset's origin. The
/// binding (`hostId`, INN, `sequence`) is the host's.
pub fn verify_license(
    compact: &str,
    keyset: &Keyset,
) -> Result<(LicensePayloadV1, String), TrustError> {
    if compact.len() > MAX_LICENSE_BYTES {
        return Err(TrustError::Malformed);
    }
    let verified = verify_compact(compact, LICENSE_TYP, keyset)?;
    let license = LicensePayloadV1::from_json(&verified.payload)?;
    if keyset.origin.as_deref() != Some(license.issuer.as_str()) {
        return Err(TrustError::Malformed);
    }
    Ok((license, verified.kid))
}

/// The same for an update manifest, against the release keyset.
pub fn verify_update_manifest(
    compact: &str,
    keyset: &Keyset,
) -> Result<(UpdateManifestV1, String), TrustError> {
    if compact.len() > MAX_UPDATE_MANIFEST_BYTES {
        return Err(TrustError::Malformed);
    }
    let verified = verify_compact(compact, UPDATE_TYP, keyset)?;
    Ok((
        UpdateManifestV1::from_json(&verified.payload)?,
        verified.kid,
    ))
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

    /// What of the test keysets a production keyset holds: the kids of keys
    /// whose point is a test key's, and `"origin"` when the license issuer is
    /// the test one.
    fn test_material_in(production: &Keysets, test: &Keysets) -> Vec<String> {
        let test_points: Vec<&Vec<u8>> = test
            .license
            .keys
            .iter()
            .chain(&test.update.keys)
            .map(|key| &key.public_key)
            .collect();
        let mut found: Vec<String> = production
            .license
            .keys
            .iter()
            .chain(&production.update.keys)
            .filter(|key| test_points.contains(&&key.public_key))
            .map(|key| key.kid.clone())
            .collect();
        if production.license.origin.is_some() && production.license.origin == test.license.origin {
            found.push("origin".to_owned());
        }
        found
    }

    /// A test key under a production-looking kid, or the test issuer, would
    /// let anyone holding the committed test private key sign licenses and
    /// update manifests a release trusts: the key material and the origin are
    /// compared, not only the kid prefix.
    #[test]
    fn the_production_keysets_hold_no_test_key_material_and_not_the_test_issuer() {
        let test = parse_keysets(TEST_KEYS).unwrap();
        assert_eq!(
            test_material_in(&production_keysets(), &test),
            Vec::<String>::new()
        );
        // The check itself: the test license key renamed, and the test issuer.
        let disguised = Keysets {
            license: Keyset {
                origin: test.license.origin.clone(),
                keys: vec![TrustedKey {
                    kid: "lic-2026-10".to_owned(),
                    public_key: test.license.keys[0].public_key.clone(),
                }],
                retired_kids: Vec::new(),
            },
            update: Keyset {
                origin: None,
                keys: vec![TrustedKey {
                    kid: "upd-2026-10".to_owned(),
                    public_key: test.update.keys[0].public_key.clone(),
                }],
                retired_kids: Vec::new(),
            },
        };
        assert_eq!(
            test_material_in(&disguised, &test),
            ["lic-2026-10", "upd-2026-10", "origin"]
        );
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
