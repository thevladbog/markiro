//! The office's view of the license (plan ЛЦ-2, spec §8.2): `GET
//! /v1/office/license` for every role, the activation request for the
//! administrator, and the test keys of plan ЛЦ-1 the other license tests sign
//! with.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{admin, empty, request, test_fingerprint, with_device};
use support::license::{
    claim_device, file, issuer, license_id, pairing_code, seed, terms, text, DAY_MS, INN, START_MS,
    TEST_KID,
};

fn all_features() -> Value {
    json!({
        "labelEditor": true, "publicApi": true, "pallets": true, "chzIntegration": true,
        "inventory": true, "commerceMl": true, "handheld": true
    })
}

fn unlimited(lines: u32, stations: u32, cabinet_users: u32) -> Value {
    json!({
        "lines": { "limit": null, "used": lines, "over": false },
        "stations": { "limit": null, "used": stations, "over": false },
        "kiosks": { "limit": null, "used": 0, "over": false },
        "cabinetUsers": { "limit": null, "used": cabinet_users, "over": false }
    })
}

#[test]
fn the_test_keys_sign_files_the_trust_module_accepts() {
    let keyset = markiro_proto::trust::license_keyset();
    assert!(keyset.keys.iter().any(|key| key.kid == TEST_KID));
    assert_eq!(keyset.origin.as_deref(), Some(issuer().as_str()));
    assert_eq!(issuer(), "https://license.test.invalid");
    let (_, kid) = markiro_proto::trust::verify_license(
        &file(support::license::FIXTURE_HOST_ID, |_| {}),
        &keyset,
    )
    .unwrap();
    assert_eq!(kid, TEST_KID);
}

#[tokio::test]
async fn a_new_site_reads_its_trial_its_seats_and_its_binding() {
    let admin = admin().await;
    let (status, body) = admin.call("GET", "/v1/office/license", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        json!({
            "state": "trial",
            "since": text(START_MS),
            "flags": { "clockBehindDays": null, "clockAhead": false },
            "effectiveAt": text(START_MS),
            "phaseEndsAt": text(START_MS + 14 * DAY_MS),
            "daysLeft": 14,
            "warnDays": 4,
            "opensNewShifts": true,
            "license": null,
            "trial": {
                "startedAt": text(START_MS),
                "endsAt": text(START_MS + 14 * DAY_MS),
                "inn": INN
            },
            "binding": {
                "hostId": admin.app.state.host_id,
                "fingerprint": test_fingerprint(),
                "orgInn": INN,
                "innMatches": null
            },
            // The wizard's two lines, the station that ran it, the administrator.
            "quotas": unlimited(2, 1, 1),
            "features": all_features(),
            "emergency": { "available": false, "until": null }
        })
    );
}

#[tokio::test]
async fn every_office_role_reads_it_and_a_device_key_alone_does_not() {
    let admin = admin().await;
    let tech = admin.technologist().await;
    let (status, body) = admin
        .call_as(&tech, "GET", "/v1/office/license", None)
        .await;
    assert_eq!(
        (status, body["state"].clone()),
        (StatusCode::OK, json!("trial"))
    );
    for path in [
        "/v1/office/license",
        "/v1/office/license/activation-request",
    ] {
        let (status, body) = admin
            .app
            .send(empty(with_device(request("GET", path), &admin.key)))
            .await;
        assert_eq!(
            (status, body["error"]["details"]["credential"].clone()),
            (StatusCode::UNAUTHORIZED, json!("session")),
            "{path}: {body}"
        );
        let (status, _) = admin.app.send(empty(request("GET", path))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}");
    }
}

#[tokio::test]
async fn a_stored_file_is_read_with_its_term_seats_and_features() {
    let admin = admin().await;
    let mut payload = terms(&admin.app.state.host_id);
    payload["quotas"]["stations"] = json!(3);
    payload["features"]["pallets"] = json!(false);
    seed(&admin.app, &payload).await;
    let (status, body) = admin.call("GET", "/v1/office/license", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        (
            body["state"].clone(),
            body["since"].clone(),
            body["phaseEndsAt"].clone(),
            body["daysLeft"].clone(),
            body["warnDays"].clone()
        ),
        (
            json!("active"),
            json!(text(START_MS)),
            json!(text(START_MS + 335 * DAY_MS)),
            json!(365),
            json!(30)
        )
    );
    assert_eq!(
        body["license"],
        json!({
            "licenseId": license_id(1),
            "sequence": 1,
            "kid": TEST_KID,
            "customer": { "name": "ООО «Атолл»", "inn": INN },
            "plan": "subscription",
            "planVersionId": "0b7c2d9e-1f3a-4b5c-8d6e-7f8091a2b3c4",
            "issuedAt": text(START_MS),
            "validFrom": text(START_MS),
            "validUntil": text(START_MS + 365 * DAY_MS),
            "graceDays": 14
        })
    );
    assert_eq!(body["binding"]["innMatches"], true);
    assert_eq!(
        body["quotas"]["stations"],
        json!({ "limit": 3, "used": 1, "over": false })
    );
    assert_eq!(body["features"]["pallets"], false);
    // The trial is still told: its start goes into the activation request.
    assert_eq!(body["trial"]["startedAt"], text(START_MS));
}

/// The seats (spec §4.7): stations and handhelds not revoked share
/// `stations`, an office PC takes none; `cabinetUsers` counts active office
/// users; `lines` counts lines not archived. A file below the use is `over`
/// and changes nothing else.
#[tokio::test]
async fn the_seats_count_what_the_spec_names() {
    let admin = admin().await;
    let pool = &admin.app.state.pool;
    // A handheld (with a code from the LAN), a second station and an office PC.
    let (status, handheld) = claim_device(&admin, &pairing_code(&admin).await, "handheld").await;
    assert_eq!(status, StatusCode::OK, "{handheld}");
    let (second_station, _) = support::app::pair_device(&admin.app, "station").await;
    support::app::pair_device(&admin.app, "office").await;
    admin.technologist().await;
    let used = |body: &Value| {
        (
            body["quotas"]["stations"]["used"].clone(),
            body["quotas"]["cabinetUsers"]["used"].clone(),
            body["quotas"]["lines"]["used"].clone(),
        )
    };
    let body = support::license::office_license(&admin).await;
    assert_eq!(used(&body), (json!(3), json!(2), json!(2)));

    // A revoked device, a user turned off and an archived line free a seat.
    sqlx::query("UPDATE devices SET revoked_at = ? WHERE id = ?")
        .bind(admin.app.state.timestamp())
        .bind(&second_station)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE office_users SET active = 0 WHERE login = 'tech'")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE lines SET archived = 1 WHERE id = (SELECT min(id) FROM lines)")
        .execute(pool)
        .await
        .unwrap();
    let body = support::license::office_license(&admin).await;
    assert_eq!(used(&body), (json!(2), json!(1), json!(1)));

    // A file allowing one station of the two in use: over, nothing refused here.
    let mut payload = terms(&admin.app.state.host_id);
    payload["quotas"]["stations"] = json!(1);
    payload["quotas"]["lines"] = json!(1);
    seed(&admin.app, &payload).await;
    let body = support::license::office_license(&admin).await;
    assert_eq!(
        (
            body["quotas"]["stations"].clone(),
            body["quotas"]["lines"].clone()
        ),
        (
            json!({ "limit": 1, "used": 2, "over": true }),
            json!({ "limit": 1, "used": 1, "over": false })
        )
    );
}

#[tokio::test]
async fn the_activation_request_names_the_host_the_organization_the_trial_and_the_usage() {
    let admin = admin().await;
    let tech = admin.technologist().await;
    let (status, body) = admin
        .call_as(&tech, "GET", "/v1/office/license/activation-request", None)
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden")),
        "{body}"
    );
    let (status, body) = admin
        .call("GET", "/v1/office/license/activation-request", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        json!({
            "format": "markiro-activation-request-v1",
            "hostId": admin.app.state.host_id,
            "hostFingerprint": test_fingerprint(),
            "hostVersion": env!("CARGO_PKG_VERSION"),
            "organization": { "name": "ООО «Атолл»", "inn": INN },
            "trial": { "startedAt": text(START_MS), "inn": INN },
            "currentLicense": null,
            // The technologist made above is a second office user.
            "usage": { "stations": 1, "cabinetUsers": 2, "lines": 2 },
            "createdAt": text(START_MS)
        })
    );
    // Plan ЛЦ-1's type reads it with its rules (shape, UUIDs, hex, INNs).
    markiro_proto::trust::ActivationRequest::from_json(body.to_string().as_bytes())
        .expect("plan ЛЦ-1's type reads it");
    let fixture: Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/domain/fixtures/standalone-license/activation-request.json"
        ))
        .unwrap(),
    )
    .unwrap();
    let keys = |value: &Value| {
        let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    };
    assert_eq!(keys(&body), keys(&fixture));
    seed(&admin.app, &terms(&admin.app.state.host_id)).await;
    let (_, body) = admin
        .call("GET", "/v1/office/license/activation-request", None)
        .await;
    assert_eq!(
        body["currentLicense"],
        json!({ "licenseId": license_id(1), "sequence": 1 })
    );
    markiro_proto::trust::ActivationRequest::from_json(body.to_string().as_bytes())
        .expect("with a file, too");
}

/// An organization without an INN (the profile allows none) is told with an
/// empty INN, as plan ЛЦ-1's type wants, never `null`.
#[tokio::test]
async fn an_organization_without_an_inn_is_told_with_an_empty_one() {
    let admin = admin().await;
    sqlx::query("UPDATE org_profile SET inn = NULL WHERE id = 1")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, body) = admin
        .call("GET", "/v1/office/license/activation-request", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["organization"],
        json!({ "name": "ООО «Атолл»", "inn": "" })
    );
    markiro_proto::trust::ActivationRequest::from_json(body.to_string().as_bytes())
        .expect("an empty INN is allowed");
}
