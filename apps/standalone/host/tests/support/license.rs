//! License files for the host's tests (plan ЛЦ-2). The TEST key of
//! `packages/domain/fixtures/standalone-license/test-private-keys.json`
//! (plan ЛЦ-1) signs any payload, so a test picks its own terms, host and
//! INN relative to the manual clock's start. Never a real key.

use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use axum::http::StatusCode;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};

use super::app::{Admin, TestApp, START};

/// The kid of the test license key.
pub const TEST_KID: &str = "test-lic-1";
/// The organization's INN in `bootstrap_body` (its check digit holds).
pub const INN: &str = "7707083893";
/// Another INN whose check digit holds: weights 2,4,10,3,5,9,4,6,8 over
/// 770123456 give 176, and 176 mod 11 mod 10 is 0.
pub const OTHER_INN: &str = "7701234560";
pub const DAY_MS: i64 = 86_400_000;
/// The manual clock's start in milliseconds.
pub const START_MS: i64 = START * 1000;
/// The host the license fixtures of plan ЛЦ-1 are issued to.
pub const FIXTURE_HOST_ID: &str = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

fn domain_fixture(name: &str) -> String {
    let path = format!(
        "{}/../../../packages/domain/fixtures/standalone-license/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"))
}

/// A license fixture of plan ЛЦ-1 (`license-subscription.jws`, …).
pub fn fixture_file(name: &str) -> String {
    domain_fixture(name).trim().to_owned()
}

/// The private JWK of `kid`, wherever the fixture file holds it (under
/// `privateJwk` or `jwk` next to the `kid`, or in the object itself).
fn private_jwk(kid: &str) -> Value {
    fn find(value: &Value, kid: &str) -> Option<Value> {
        match value {
            Value::Object(map) => {
                if map.get("kid").and_then(Value::as_str) == Some(kid) {
                    let jwk = map
                        .get("privateJwk")
                        .or_else(|| map.get("jwk"))
                        .unwrap_or(value);
                    if jwk.get("d").is_some() {
                        return Some(jwk.clone());
                    }
                }
                map.values().find_map(|inner| find(inner, kid))
            }
            Value::Array(items) => items.iter().find_map(|inner| find(inner, kid)),
            _ => None,
        }
    }
    let keys: Value = serde_json::from_str(&domain_fixture("test-private-keys.json")).unwrap();
    find(&keys, kid).unwrap_or_else(|| panic!("no private key {kid} in test-private-keys.json"))
}

/// `payload` signed by the test license key under the header's `kid`.
pub fn sign_with_kid(payload: &Value, kid: &str) -> String {
    let jwk = private_jwk(TEST_KID);
    let decode = |field: &str| {
        URL_SAFE_NO_PAD
            .decode(jwk[field].as_str().unwrap())
            .unwrap()
    };
    let mut public = vec![4u8];
    public.extend(decode("x"));
    public.extend(decode("y"));
    let pair = EcdsaKeyPair::from_private_key_and_public_key(
        &ECDSA_P256_SHA256_FIXED_SIGNING,
        &decode("d"),
        &public,
    )
    .unwrap();
    // The header's bytes as the format writes them: `typ`, `alg`, `kid`.
    let header =
        format!(r#"{{"typ":"markiro-standalone-license+jws","alg":"ES256","kid":"{kid}"}}"#);
    let signing_input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header),
        URL_SAFE_NO_PAD.encode(payload.to_string())
    );
    let signature = pair
        .sign(&SystemRandom::new(), signing_input.as_bytes())
        .unwrap();
    format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature.as_ref())
    )
}

/// `payload` signed by the test license key.
pub fn sign(payload: &Value) -> String {
    sign_with_kid(payload, TEST_KID)
}

/// The issuer the test keyset trusts.
pub fn issuer() -> String {
    markiro_proto::trust::license_keyset()
        .origin
        .expect("the test keyset names its origin")
}

/// The id of file `n`, a canonical UUID.
pub fn license_id(n: u32) -> String {
    format!("6d1f0a52-3c4b-4e8f-9a1d-{n:012}")
}

/// A year's subscription from the manual clock's start for `host_id`, issued
/// to `INN`, with every feature, no quota and 14 days of grace.
pub fn terms(host_id: &str) -> Value {
    json!({
        "version": 1,
        "licenseId": license_id(1),
        "sequence": 1,
        "issuer": issuer(),
        "tenantId": "11111111-2222-4333-8444-555555555555",
        "siteId": "66666666-7777-4888-9999-aaaaaaaaaaaa",
        "hostId": host_id,
        "customer": { "name": "ООО «Атолл»", "inn": INN },
        "plan": "subscription",
        "planVersionId": "0b7c2d9e-1f3a-4b5c-8d6e-7f8091a2b3c4",
        "entitlementRevision": "42",
        "issuedAt": START_MS,
        "validFrom": START_MS,
        "validUntil": START_MS + 365 * DAY_MS,
        "graceDays": 14,
        "quotas": { "lines": null, "stations": null, "kiosks": null, "cabinetUsers": null },
        "features": {
            "labelEditor": true, "publicApi": true, "pallets": true, "chzIntegration": true,
            "inventory": true, "commerceMl": true, "handheld": true
        },
        "replaces": null
    })
}

/// `terms(host_id)` changed by `edit`, signed.
pub fn file(host_id: &str, edit: impl FnOnce(&mut Value)) -> String {
    let mut payload = terms(host_id);
    edit(&mut payload);
    sign(&payload)
}

/// The payload of a compact file, as JSON.
pub fn payload_of(file: &str) -> Value {
    let segment = file.split('.').nth(1).expect("three segments");
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(segment).unwrap()).unwrap()
}

/// Set the organization's INN in the profile (`null` clears it; the profile
/// takes any 10 or 12 digits, plan ЛЦ-2 leaves its rule alone).
pub async fn set_org_inn(admin: &Admin, inn: Value) {
    let (status, org) = admin.call("GET", "/v1/office/org", None).await;
    assert_eq!(status, StatusCode::OK, "{org}");
    let body = json!({
        "name": org["name"], "inn": inn, "gln": org["gln"],
        "gs1Prefixes": org["gs1Prefixes"], "timeZone": org["timeZone"], "expectedRev": org["rev"]
    });
    let (status, updated) = admin.call("PUT", "/v1/office/org", Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{updated}");
}

/// The host's timestamp text of `ms`.
pub fn text(ms: i64) -> String {
    markiro_host::license::ms_text(ms)
}

/// Put the file of `payload` straight into `licenses`, as a load would.
pub async fn seed(app: &TestApp, payload: &Value) {
    sqlx::query(
        "INSERT INTO licenses (license_id, sequence, compact, kid, host_id, issued_at, \
         valid_from, valid_until, grace_days, plan, plan_version_id, customer_name, \
         customer_inn, quotas, features, loaded_at, loaded_by) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
    )
    .bind(payload["licenseId"].as_str().unwrap())
    .bind(payload["sequence"].as_i64().unwrap())
    .bind(sign(payload))
    .bind(TEST_KID)
    .bind(payload["hostId"].as_str().unwrap())
    .bind(payload["issuedAt"].as_i64().unwrap())
    .bind(payload["validFrom"].as_i64().unwrap())
    .bind(payload["validUntil"].as_i64().unwrap())
    .bind(payload["graceDays"].as_i64().unwrap())
    .bind(payload["plan"].as_str().unwrap())
    .bind(payload["planVersionId"].as_str().unwrap())
    .bind(payload["customer"]["name"].as_str().unwrap())
    .bind(payload["customer"]["inn"].as_str().unwrap())
    .bind(payload["quotas"].to_string())
    .bind(payload["features"].to_string())
    .bind(app.state.timestamp())
    .execute(&app.state.pool)
    .await
    .unwrap();
}

/// `PUT /v1/office/license` as the administrator.
pub async fn load(admin: &Admin, file: &str) -> (StatusCode, Value) {
    admin
        .call("PUT", "/v1/office/license", Some(json!({ "file": file })))
        .await
}

/// `load`, which must be accepted; returns the answer.
pub async fn load_ok(admin: &Admin, file: &str) -> Value {
    let (status, body) = load(admin, file).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

/// `POST /v1/office/license/preview` as the administrator.
pub async fn preview(admin: &Admin, file: &str) -> (StatusCode, Value) {
    admin
        .call(
            "POST",
            "/v1/office/license/preview",
            Some(json!({ "file": file })),
        )
        .await
}

/// The office's `GET /v1/office/license` as the administrator.
pub async fn office_license(admin: &Admin) -> Value {
    let (status, body) = admin.call("GET", "/v1/office/license", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

/// Claim a pairing code from the LAN as a device of `kind`; the status and
/// the body.
pub async fn claim_device(admin: &Admin, code: &Value, kind: &str) -> (StatusCode, Value) {
    admin
        .app
        .send_from(
            super::app::LAN,
            super::app::json(
                super::app::request("POST", "/v1/pairing/claim"),
                json!({ "code": code["code"], "kind": kind, "name": "Устройство в сети",
                    "appVersion": "1.2.0", "capabilities": [] }),
            ),
        )
        .await
}

/// A new pairing code from the administrator.
pub async fn pairing_code(admin: &Admin) -> Value {
    let (status, code) = admin.call("POST", "/v1/office/pairing-codes", None).await;
    assert_eq!(status, StatusCode::OK, "{code}");
    code
}

/// What the minute's look does (`LicenseService::refresh`).
pub async fn refresh(app: &TestApp) {
    app.state.license.refresh(&app.state).await.unwrap();
}
