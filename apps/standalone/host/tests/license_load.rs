//! Loading a license file (plan ЛЦ-2, spec §4.3, §4.8, §7, §8.3): the order
//! of the checks, the `license.load` rows, the preview that writes nothing,
//! the upgrade by `sequence`, the warnings, the rate limit, the floor a
//! file's issue puts under the time, and the files plan ЛЦ-1 signs as the
//! cloud will issue them.

mod support;

use std::sync::Arc;

use axum::http::StatusCode;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use markiro_host::audit::actions;
use markiro_host::license::state::{Features, Quotas, StoredLicense};
use markiro_host::license::trial_mark::NoMark;
use markiro_host::license::verify::{self, Refusal};
use markiro_host::license::{store, LicenseService};
use serde_json::{json, Value};
use support::app::{
    admin, admin_on, audit_rows, audit_trail, empty, host_revision, json as json_body, request,
    with_device, Admin, AuditRow,
};
use support::license::{
    file, fixture_file, license_id, load, load_ok, payload_of, preview, seed, set_org_inn,
    sign_with_kid, terms, text, DAY_MS, FIXTURE_HOST_ID, INN, OTHER_INN, START_MS, TEST_KID,
};

const OTHER_HOST: &str = "9b2e4f60-1a3c-4d5e-8f70-1a2b3c4d5e6f";

fn all_features() -> Value {
    json!({
        "labelEditor": true, "publicApi": true, "pallets": true, "chzIntegration": true,
        "inventory": true, "commerceMl": true, "handheld": true
    })
}

/// The `denied` row of a refused file.
fn denied(admin: &Admin, license_id: Option<&str>, details: Value) -> AuditRow {
    (
        "office_user".to_owned(),
        Some(admin.id.clone()),
        actions::LICENSE_LOAD.to_owned(),
        Some("license".to_owned()),
        license_id.map(str::to_owned),
        "denied".to_owned(),
        details,
    )
}

/// The whole file the host must keep for `payload`, read field by field
/// from the payload's own names: a field the host swapped with another one
/// of the same type shows here.
fn kept_of(payload: &Value) -> StoredLicense {
    let int = |value: &Value| value.as_i64().expect("an integer");
    let string = |value: &Value| value.as_str().expect("a string").to_owned();
    let quota = |key: &str| {
        let limit = &payload["quotas"][key];
        if limit.is_null() {
            None
        } else {
            Some(limit.as_u64().expect("a quota"))
        }
    };
    let feature = |key: &str| payload["features"][key].as_bool().expect("a feature");
    StoredLicense {
        license_id: string(&payload["licenseId"]),
        sequence: int(&payload["sequence"]),
        kid: TEST_KID.to_owned(),
        host_id: string(&payload["hostId"]),
        issued_at: int(&payload["issuedAt"]),
        valid_from: int(&payload["validFrom"]),
        valid_until: int(&payload["validUntil"]),
        grace_days: int(&payload["graceDays"]),
        plan: string(&payload["plan"]),
        plan_version_id: string(&payload["planVersionId"]),
        customer_name: string(&payload["customer"]["name"]),
        customer_inn: string(&payload["customer"]["inn"]),
        quotas: Quotas {
            lines: quota("lines"),
            stations: quota("stations"),
            kiosks: quota("kiosks"),
            cabinet_users: quota("cabinetUsers"),
        },
        features: Features {
            label_editor: feature("labelEditor"),
            public_api: feature("publicApi"),
            pallets: feature("pallets"),
            chz_integration: feature("chzIntegration"),
            inventory: feature("inventory"),
            commerce_ml: feature("commerceMl"),
            handheld: feature("handheld"),
        },
    }
}

async fn stored(admin: &Admin) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM licenses")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

async fn last_load_row(admin: &Admin) -> AuditRow {
    audit_trail(&admin.app, actions::LICENSE_LOAD)
        .await
        .pop()
        .expect("a license.load row")
}

#[tokio::test]
async fn each_refusal_names_its_reason_and_writes_one_denied_row() {
    let admin = admin().await;
    let host = admin.app.state.host_id.clone();
    let good = file(&host, |_| {});
    let parts: Vec<&str> = good.split('.').collect();
    let mut changed = terms(&host);
    changed["graceDays"] = json!(60);
    let tampered = format!(
        "{}.{}.{}",
        parts[0],
        URL_SAFE_NO_PAD.encode(changed.to_string()),
        parts[2]
    );
    let cases: Vec<(&str, String, Option<String>, Value)> = vec![
        (
            "not a file",
            "not a license".to_owned(),
            None,
            json!({ "reason": "license_malformed" }),
        ),
        (
            "16 KiB and a byte",
            "a".repeat(16 * 1024 + 1),
            None,
            json!({ "reason": "license_malformed" }),
        ),
        (
            // The size is the text's as sent: a good file padded past 16 KiB.
            "a good file padded past 16 KiB",
            format!("{good}{}", " ".repeat(16 * 1024)),
            None,
            json!({ "reason": "license_malformed" }),
        ),
        (
            "a key this build does not know",
            sign_with_kid(&terms(&host), "test-lic-9"),
            None,
            json!({ "reason": "license_unknown_key" }),
        ),
        (
            "a changed payload",
            tampered,
            None,
            json!({ "reason": "license_signature" }),
        ),
        (
            "another issuer",
            file(&host, |terms| {
                terms["issuer"] = json!("https://other.invalid")
            }),
            None,
            json!({ "reason": "license_malformed" }),
        ),
        (
            "another host",
            file(OTHER_HOST, |_| {}),
            Some(license_id(1)),
            json!({ "reason": "license_wrong_host", "fileHostId": OTHER_HOST }),
        ),
        (
            // The host comes before the INN (§4.3 steps 5 and 6).
            "another host and another organization",
            file(OTHER_HOST, |terms| {
                terms["customer"]["inn"] = json!(OTHER_INN)
            }),
            Some(license_id(1)),
            json!({ "reason": "license_wrong_host", "fileHostId": OTHER_HOST }),
        ),
        (
            "another organization",
            file(&host, |terms| terms["customer"]["inn"] = json!(OTHER_INN)),
            Some(license_id(1)),
            json!({ "reason": "license_inn_mismatch" }),
        ),
    ];
    for (name, text, target, details) in cases {
        let rows = audit_rows(&admin.app).await;
        let rev = host_revision(&admin.app).await;
        let (status, body) = load(&admin, &text).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{name}: {body}");
        assert_eq!(
            (
                body["error"]["code"].clone(),
                body["error"]["details"]["field"].clone(),
                body["error"]["details"]["reason"].clone()
            ),
            (
                json!("validation_failed"),
                json!("file"),
                details["reason"].clone()
            ),
            "{name}"
        );
        assert_eq!(audit_rows(&admin.app).await, rows + 1, "{name}");
        assert_eq!(host_revision(&admin.app).await, rev, "{name}");
        assert_eq!(
            last_load_row(&admin).await,
            denied(&admin, target.as_deref(), details),
            "{name}"
        );
    }
    let (_, body) = load(&admin, &file(OTHER_HOST, |_| {})).await;
    assert_eq!(
        body["error"]["details"],
        json!({ "field": "file", "reason": "license_wrong_host", "fileHostId": OTHER_HOST })
    );
    assert_eq!(stored(&admin).await, 0);
}

#[tokio::test]
async fn the_inn_is_checked_against_the_profile_and_a_missing_one_is_named() {
    let admin = admin().await;
    let good = file(&admin.app.state.host_id, |_| {});
    set_org_inn(&admin, Value::Null).await;
    let (status, body) = load(&admin, &good).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(
        body["error"]["details"],
        json!({ "field": "file", "reason": "license_inn_missing" })
    );
    assert_eq!(
        last_load_row(&admin).await,
        denied(
            &admin,
            Some(&license_id(1)),
            json!({ "reason": "license_inn_missing" })
        )
    );
    // The profile takes an INN whose check digit fails; it equals nothing.
    set_org_inn(&admin, json!("7707083894")).await;
    let (status, body) = load(&admin, &good).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body["error"]["details"],
        json!({
            "field": "file", "reason": "license_inn_mismatch",
            "fileInn": INN, "orgInn": "7707083894"
        })
    );
    // The INN alone decides: the GLN and the prefixes are not part of it.
    set_org_inn(&admin, json!(INN)).await;
    assert_eq!(stored(&admin).await, 0);
    load_ok(&admin, &good).await;
    assert_eq!(stored(&admin).await, 1);
}

#[tokio::test]
async fn an_accepted_file_is_kept_with_one_row_and_a_revision() {
    let admin = admin().await;
    let good = file(&admin.app.state.host_id, |terms| {
        terms["quotas"]["stations"] = json!(3);
    });
    let rev = host_revision(&admin.app).await;
    let body = load_ok(&admin, &good).await;
    assert_eq!(
        (body["state"].clone(), body["license"]["sequence"].clone()),
        (json!("active"), json!(1))
    );
    assert!(body.get("warnings").is_none(), "{body}");
    // The load takes one revision, the state's change (trial → active) another.
    assert_eq!(host_revision(&admin.app).await, rev + 2);
    assert_eq!(
        audit_trail(&admin.app, actions::LICENSE_LOAD).await,
        [admin.row(
            actions::LICENSE_LOAD,
            "license",
            &license_id(1),
            json!({
                "licenseId": license_id(1),
                "sequence": 1,
                "previousSequence": null,
                "kid": TEST_KID,
                "warnings": [],
                "changed": ["quotas", "features", "validUntil", "plan"],
                "quotas": {
                    "from": null,
                    "to": { "lines": null, "stations": 3, "kiosks": null, "cabinetUsers": null }
                },
                "features": { "from": null, "to": all_features() },
                "validUntil": { "from": null, "to": text(START_MS + 365 * DAY_MS) },
                "plan": { "from": null, "to": "subscription" }
            })
        )]
    );
    let row: (String, Option<String>) =
        sqlx::query_as("SELECT compact, loaded_by FROM licenses WHERE license_id = ?")
            .bind(license_id(1))
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(row, (good.clone(), Some(admin.id.clone())));
    // The same file again: the same answer, nothing written.
    let rows = audit_rows(&admin.app).await;
    let rev = host_revision(&admin.app).await;
    let again = load_ok(&admin, &format!("{good}\n")).await;
    assert_eq!(again["license"], body["license"]);
    assert_eq!(
        (
            audit_rows(&admin.app).await,
            host_revision(&admin.app).await,
            stored(&admin).await
        ),
        (rows, rev, 1)
    );
}

/// A load that committed answers with the file even when the read after the
/// commit fails (review of Task 8): the answer is built from what the load
/// already knew, never a 500 that would make the office load it again.
#[tokio::test]
async fn a_committed_load_answers_when_the_read_after_it_fails() {
    let admin = admin().await;
    // The load's own transaction removes the clock's row: the commit holds,
    // and every read of the license after it fails.
    sqlx::query(
        "CREATE TRIGGER lose_the_clock AFTER INSERT ON licenses \
         BEGIN DELETE FROM license_clock; END",
    )
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    // Issued three days after the PC's clock: the answer is of the time
    // after the floor the file raises (its issue less a day).
    let good = file(&admin.app.state.host_id, |terms| {
        terms["issuedAt"] = json!(START_MS + 3 * DAY_MS);
        terms["quotas"]["stations"] = json!(3);
    });
    let body = load_ok(&admin, &good).await;
    assert_eq!(
        (
            body["state"].clone(),
            body["license"]["sequence"].clone(),
            body["opensNewShifts"].clone(),
            body["quotas"]["stations"].clone(),
            body["effectiveAt"].clone()
        ),
        (
            json!("active"),
            json!(1),
            json!(true),
            json!({ "limit": 3, "used": 1, "over": false }),
            json!(text(START_MS + 2 * DAY_MS))
        ),
        "{body}"
    );
    assert!(body.get("warnings").is_none(), "{body}");
    assert_eq!(stored(&admin).await, 1);
    assert_eq!(
        audit_trail(&admin.app, actions::LICENSE_LOAD).await.len(),
        1
    );
}

#[tokio::test]
async fn a_newer_file_replaces_by_sequence_and_an_older_or_equal_one_is_refused() {
    let admin = admin().await;
    let host = admin.app.state.host_id.clone();
    load_ok(
        &admin,
        &file(&host, |terms| terms["quotas"]["stations"] = json!(3)),
    )
    .await;
    let upgraded = load_ok(
        &admin,
        &file(&host, |terms| {
            terms["licenseId"] = json!(license_id(2));
            terms["sequence"] = json!(2);
            terms["quotas"]["stations"] = json!(5);
            terms["replaces"] = json!(license_id(1));
        }),
    )
    .await;
    // At once: no restart, no edit of data.
    assert_eq!(upgraded["quotas"]["stations"]["limit"], 5);
    assert_eq!(upgraded["license"]["licenseId"], json!(license_id(2)));
    assert_eq!(
        last_load_row(&admin).await,
        admin.row(
            actions::LICENSE_LOAD,
            "license",
            &license_id(2),
            json!({
                "licenseId": license_id(2), "sequence": 2, "previousSequence": 1,
                "kid": TEST_KID, "warnings": [], "changed": ["quotas"],
                "quotas": {
                    "from": { "lines": null, "stations": 3, "kiosks": null, "cabinetUsers": null },
                    "to": { "lines": null, "stations": 5, "kiosks": null, "cabinetUsers": null }
                }
            })
        )
    );
    for (n, sequence) in [(3, 1), (4, 2)] {
        let (status, body) = load(
            &admin,
            &file(&host, |terms| {
                terms["licenseId"] = json!(license_id(n));
                terms["sequence"] = json!(sequence);
                terms["quotas"]["stations"] = json!(50);
            }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(
            body["error"]["details"],
            json!({ "field": "file", "reason": "license_older", "newestSequence": 2 })
        );
        assert_eq!(
            last_load_row(&admin).await,
            denied(
                &admin,
                Some(&license_id(n)),
                json!({ "reason": "license_older" })
            )
        );
    }
    // The INN comes before the order of the files (§4.3 steps 6 and 7).
    let (status, body) = load(
        &admin,
        &file(&host, |terms| {
            terms["licenseId"] = json!(license_id(5));
            terms["customer"]["inn"] = json!(OTHER_INN);
        }),
    )
    .await;
    assert_eq!(
        (status, body["error"]["details"]["reason"].clone()),
        (StatusCode::BAD_REQUEST, json!("license_inn_mismatch"))
    );
    assert_eq!(stored(&admin).await, 2);
    let (status, body) = admin.call("GET", "/v1/office/license", None).await;
    assert_eq!(
        (status, body["license"]["sequence"].clone()),
        (StatusCode::OK, json!(2))
    );
}

#[tokio::test]
async fn the_preview_tells_before_and_after_and_writes_nothing() {
    let admin = admin().await;
    let host = admin.app.state.host_id.clone();
    let rows = audit_rows(&admin.app).await;
    let rev = host_revision(&admin.app).await;
    let (status, body) = preview(
        &admin,
        &file(&host, |terms| {
            terms["quotas"]["stations"] = json!(0);
            terms["features"]["pallets"] = json!(false);
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let unlimited = |lines: u32, stations: u32, users: u32| {
        json!({
            "lines": { "limit": null, "used": lines, "over": false },
            "stations": { "limit": null, "used": stations, "over": false },
            "kiosks": { "limit": null, "used": 0, "over": false },
            "cabinetUsers": { "limit": null, "used": users, "over": false }
        })
    };
    let mut after_quotas = unlimited(2, 1, 1);
    after_quotas["stations"] = json!({ "limit": 0, "used": 1, "over": true });
    let mut after_features = all_features();
    after_features["pallets"] = json!(false);
    assert_eq!(
        body,
        json!({
            "before": {
                "licenseId": null, "sequence": null, "plan": "trial",
                "validFrom": text(START_MS), "validUntil": text(START_MS + 14 * DAY_MS),
                "graceDays": 0, "quotas": unlimited(2, 1, 1), "features": all_features()
            },
            "after": {
                "licenseId": license_id(1), "sequence": 1, "plan": "subscription",
                "validFrom": text(START_MS), "validUntil": text(START_MS + 365 * DAY_MS),
                "graceDays": 14, "quotas": after_quotas, "features": after_features
            },
            "changes": ["plan", "validUntil", "graceDays", "quotas.stations", "features.pallets"],
            "warnings": ["over_limit"]
        })
    );
    let (status, body) = preview(&admin, &file(OTHER_HOST, |_| {})).await;
    assert_eq!(
        (status, body["error"]["details"].clone()),
        (
            StatusCode::BAD_REQUEST,
            json!({ "field": "file", "reason": "license_wrong_host", "fileHostId": OTHER_HOST })
        )
    );
    assert_eq!(
        (
            audit_rows(&admin.app).await,
            host_revision(&admin.app).await,
            stored(&admin).await
        ),
        (rows, rev, 0)
    );
}

#[tokio::test]
async fn the_preview_of_an_upgrade_compares_with_the_file_in_force() {
    let admin = admin().await;
    let host = admin.app.state.host_id.clone();
    load_ok(
        &admin,
        &file(&host, |terms| terms["quotas"]["stations"] = json!(3)),
    )
    .await;
    let (status, body) = preview(
        &admin,
        &file(&host, |terms| {
            terms["licenseId"] = json!(license_id(2));
            terms["sequence"] = json!(2);
            terms["plan"] = json!("demo");
            terms["validFrom"] = json!(START_MS + DAY_MS);
            terms["validUntil"] = json!(START_MS + 30 * DAY_MS);
            terms["graceDays"] = json!(0);
            terms["quotas"]["lines"] = json!(5);
            terms["quotas"]["stations"] = json!(3);
            terms["quotas"]["kiosks"] = json!(1);
            terms["quotas"]["cabinetUsers"] = json!(4);
            for feature in markiro_proto::license::FEATURE_KEYS {
                terms["features"][feature] = json!(false);
            }
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // Plan Д4's order; an unchanged `quotas.stations` is not named.
    assert_eq!(
        body["changes"],
        json!([
            "plan",
            "validFrom",
            "validUntil",
            "graceDays",
            "quotas.lines",
            "quotas.kiosks",
            "quotas.cabinetUsers",
            "features.labelEditor",
            "features.publicApi",
            "features.pallets",
            "features.chzIntegration",
            "features.inventory",
            "features.commerceMl",
            "features.handheld"
        ])
    );
    assert_eq!(
        (
            body["before"]["licenseId"].clone(),
            body["before"]["sequence"].clone(),
            body["before"]["quotas"]["stations"]["limit"].clone(),
            body["after"]["sequence"].clone(),
            body["warnings"].clone()
        ),
        (
            json!(license_id(1)),
            json!(1),
            json!(3),
            json!(2),
            json!(["not_yet_valid"])
        )
    );
    assert_eq!(
        [
            body["after"]["quotas"]["lines"]["limit"].clone(),
            body["after"]["quotas"]["stations"]["limit"].clone(),
            body["after"]["quotas"]["kiosks"]["limit"].clone(),
            body["after"]["quotas"]["cabinetUsers"]["limit"].clone(),
        ],
        [json!(5), json!(3), json!(1), json!(4)]
    );
    assert_eq!(stored(&admin).await, 1);
}

#[tokio::test]
async fn an_expired_a_waiting_and_a_smaller_file_are_taken_with_a_warning() {
    let expired = admin().await;
    let body = load_ok(
        &expired,
        &file(&expired.app.state.host_id, |terms| {
            terms["issuedAt"] = json!(START_MS - 30 * DAY_MS);
            terms["validFrom"] = json!(START_MS - 30 * DAY_MS);
            terms["validUntil"] = json!(START_MS - DAY_MS);
            terms["graceDays"] = json!(0);
        }),
    )
    .await;
    assert_eq!(
        (body["state"].clone(), body["warnings"].clone()),
        (json!("restricted"), json!(["expired"]))
    );
    assert_eq!(
        last_load_row(&expired).await.6["warnings"],
        json!(["expired"])
    );
    let waiting = admin().await;
    let body = load_ok(
        &waiting,
        &file(&waiting.app.state.host_id, |terms| {
            terms["validFrom"] = json!(START_MS + 10 * DAY_MS);
        }),
    )
    .await;
    assert_eq!(
        (
            body["state"].clone(),
            body["license"].clone(),
            body["warnings"].clone()
        ),
        (json!("trial"), Value::Null, json!(["not_yet_valid"]))
    );
    let smaller = admin().await;
    let body = load_ok(
        &smaller,
        &file(&smaller.app.state.host_id, |terms| {
            terms["quotas"]["stations"] = json!(0)
        }),
    )
    .await;
    assert_eq!(body["warnings"], json!(["over_limit"]));
    assert_eq!(
        body["quotas"]["stations"],
        json!({ "limit": 0, "used": 1, "over": true })
    );
}

#[tokio::test]
async fn a_file_issued_ahead_of_the_pcs_clock_moves_the_time_to_its_issue_less_a_day() {
    let admin = admin().await;
    let host = admin.app.state.host_id.clone();
    let body = load_ok(
        &admin,
        &file(&host, |terms| {
            terms["issuedAt"] = json!(START_MS + 10 * DAY_MS);
        }),
    )
    .await;
    assert_eq!(
        (
            body["effectiveAt"].clone(),
            body["flags"]["clockBehindDays"].clone()
        ),
        (json!(text(START_MS + 9 * DAY_MS)), json!(9))
    );
    // A newer file issued earlier never moves the time back.
    let body = load_ok(
        &admin,
        &file(&host, |terms| {
            terms["licenseId"] = json!(license_id(2));
            terms["sequence"] = json!(2);
            terms["issuedAt"] = json!(START_MS + 2 * DAY_MS);
        }),
    )
    .await;
    assert_eq!(body["effectiveAt"], json!(text(START_MS + 9 * DAY_MS)));
}

/// The warnings speak of the time the host keeps after the load: the
/// latest issue of every stored file and the new one less a day. A file in
/// force at that time is not «not yet valid», and one over by then is
/// «expired», whatever the PC's clock said before.
#[tokio::test]
async fn the_warnings_are_of_the_time_after_the_floor_the_file_raises() {
    let admin = admin().await;
    let host = admin.app.state.host_id.clone();
    // Issued ten days ahead of the PC, in force from day five: by the floor
    // (day nine) it is in force.
    let in_force = file(&host, |terms| {
        terms["issuedAt"] = json!(START_MS + 10 * DAY_MS);
        terms["validFrom"] = json!(START_MS + 5 * DAY_MS);
    });
    // In force now, over on day three: by the floor it is over.
    let over = file(&host, |terms| {
        terms["issuedAt"] = json!(START_MS + 10 * DAY_MS);
        terms["validFrom"] = json!(START_MS - 30 * DAY_MS);
        terms["validUntil"] = json!(START_MS + 3 * DAY_MS);
        terms["graceDays"] = json!(0);
    });
    let (status, body) = preview(&admin, &in_force).await;
    assert_eq!(
        (status, body["warnings"].clone()),
        (StatusCode::OK, json!([]))
    );
    let (status, body) = preview(&admin, &over).await;
    assert_eq!(
        (status, body["warnings"].clone()),
        (StatusCode::OK, json!(["expired"]))
    );
    let body = load_ok(&admin, &in_force).await;
    // No warning: the office answer leaves an empty list out.
    assert_eq!(
        (body["state"].clone(), body["warnings"].clone()),
        (json!("active"), Value::Null)
    );
    assert_eq!(last_load_row(&admin).await.6["warnings"], json!([]));

    // A stored file the clock has not met yet counts too: issued on day ten,
    // put in by hand, it holds the floor at day nine for the next file.
    let seeded = admin_on(FIXTURE_HOST_ID).await;
    let mut first = terms(FIXTURE_HOST_ID);
    first["issuedAt"] = json!(START_MS + 10 * DAY_MS);
    seed(&seeded.app, &first).await;
    let (status, body) = preview(
        &seeded,
        &file(FIXTURE_HOST_ID, |terms| {
            terms["licenseId"] = json!(license_id(2));
            terms["sequence"] = json!(2);
            terms["validFrom"] = json!(START_MS + 5 * DAY_MS);
        }),
    )
    .await;
    assert_eq!(
        (status, body["warnings"].clone()),
        (StatusCode::OK, json!([]))
    );
}

/// A body past the route's limit is refused before the handler: no row, and
/// nothing of the rate limit spent.
#[tokio::test]
async fn a_body_past_the_routes_limit_is_refused_before_anything() {
    let admin = admin().await;
    let rows = audit_rows(&admin.app).await;
    let big = "a".repeat(40 * 1024);
    for _ in 0..6 {
        for (method, path) in [
            ("PUT", "/v1/office/license"),
            ("POST", "/v1/office/license/preview"),
        ] {
            let (status, body) = admin.call(method, path, Some(json!({ "file": big }))).await;
            assert_eq!(
                (
                    status,
                    body["error"]["code"].clone(),
                    body["error"]["details"].clone()
                ),
                (
                    StatusCode::BAD_REQUEST,
                    json!("validation_failed"),
                    Value::Null
                ),
                "{method} {path}: {body}"
            );
        }
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
    // Twelve refusals, and the limit of ten is untouched.
    assert_eq!(
        preview(&admin, &file(&admin.app.state.host_id, |_| {}))
            .await
            .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn at_a_start_the_floor_is_the_latest_issue_of_every_stored_file() {
    let admin = admin().await;
    let host = admin.app.state.host_id.clone();
    let mut first = terms(&host);
    first["issuedAt"] = json!(START_MS + 10 * DAY_MS);
    let mut newest = terms(&host);
    newest["licenseId"] = json!(license_id(2));
    newest["sequence"] = json!(2);
    newest["issuedAt"] = json!(START_MS + 3 * DAY_MS);
    seed(&admin.app, &first).await;
    seed(&admin.app, &newest).await;
    // A fresh service on the same data is a start of the host.
    let started = admin
        .app
        .state
        .clone()
        .with_license(Arc::new(LicenseService::new(
            markiro_proto::trust::license_keyset(),
            Arc::new(NoMark),
        )));
    let license = started
        .license
        .office_license_now(&started)
        .await
        .expect("the license now");
    assert_eq!(
        (
            license.effective_at,
            license.license.map(|file| file.sequence)
        ),
        (text(START_MS + 9 * DAY_MS), Some(2))
    );
}

#[tokio::test]
async fn only_an_administrators_session_previews_or_loads() {
    let admin = admin().await;
    let tech = admin.technologist().await;
    let good = json!({ "file": file(&admin.app.state.host_id, |_| {}) });
    let rows = audit_rows(&admin.app).await;
    for (method, path) in [
        ("PUT", "/v1/office/license"),
        ("POST", "/v1/office/license/preview"),
    ] {
        let (status, _) = admin.call_as(&tech, method, path, Some(good.clone())).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}");
        // A device key alone never opens them.
        let (status, body) = admin
            .app
            .send(json_body(
                with_device(request(method, path), &admin.key),
                good.clone(),
            ))
            .await;
        assert_eq!(
            (status, body["error"]["details"]["credential"].clone()),
            (StatusCode::UNAUTHORIZED, json!("session")),
            "{method} {path}: {body}"
        );
        let (status, _) = admin
            .app
            .send(json_body(request(method, path), good.clone()))
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}");
    }
    let (status, _) = admin
        .app
        .send(empty(request("DELETE", "/v1/office/license")))
        .await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(stored(&admin).await, 0);
}

#[tokio::test]
async fn a_refused_role_spends_none_of_the_limit_and_a_role_lost_meanwhile_writes_nothing() {
    let admin = admin().await;
    let tech = admin.technologist().await;
    let good = file(&admin.app.state.host_id, |_| {});
    for (method, path) in [
        ("PUT", "/v1/office/license"),
        ("POST", "/v1/office/license/preview"),
    ] {
        for _ in 0..11 {
            let (status, _) = admin
                .call_as(&tech, method, path, Some(json!({ "file": good })))
                .await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}");
        }
    }
    // Same address, same limiter: the technologist's refusals counted nothing.
    assert_eq!(preview(&admin, &good).await.0, StatusCode::OK);
    // An administrator turned off between the session's check and the write.
    let id = support::app::seed_office_user(&admin.app, "second", "admin", "second admin password")
        .await;
    let token =
        support::app::login(&admin.app, &admin.key, "second", "second admin password").await;
    let rows = audit_rows(&admin.app).await;
    support::app::turn_the_user_off_at_the_next_activity(&admin.app, &id).await;
    admin.app.clock.advance(time::Duration::minutes(2));
    let (status, body) = admin
        .call_as(
            &token,
            "PUT",
            "/v1/office/license",
            Some(json!({ "file": good })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::UNAUTHORIZED, json!("unauthorized")),
        "{body}"
    );
    assert_eq!(
        (audit_rows(&admin.app).await, stored(&admin).await),
        (rows, 0)
    );
}

#[tokio::test]
async fn a_stored_file_of_another_host_is_refused_again_not_taken_as_the_same() {
    let admin = admin().await;
    // A copy restored with its identity kept holds another host's file.
    let foreign = terms(OTHER_HOST);
    seed(&admin.app, &foreign).await;
    let (status, body) = load(&admin, &support::license::sign(&foreign)).await;
    assert_eq!(
        (status, body["error"]["details"]["reason"].clone()),
        (StatusCode::BAD_REQUEST, json!("license_wrong_host"))
    );
}

#[tokio::test]
async fn ten_attempts_a_minute_then_the_limit_refuses_without_a_row() {
    let admin = admin().await;
    for _ in 0..10 {
        assert_eq!(
            load(&admin, "not a license").await.0,
            StatusCode::BAD_REQUEST
        );
    }
    let rows = audit_rows(&admin.app).await;
    // The preview shares the limit with the load.
    let (status, body) = preview(&admin, "not a license").await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::TOO_MANY_REQUESTS, json!("rate_limited"))
    );
    let (status, _) = load(&admin, &file(&admin.app.state.host_id, |_| {})).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(
        audit_trail(&admin.app, actions::LICENSE_LOAD).await.len(),
        10
    );
    assert_eq!(stored(&admin).await, 0);
    admin.app.clock.advance(time::Duration::seconds(61));
    load_ok(&admin, &file(&admin.app.state.host_id, |_| {})).await;
}

#[tokio::test]
async fn the_files_plan_lc1_signs_are_read_as_the_cloud_will_send_them() {
    let admin = admin_on(FIXTURE_HOST_ID).await;
    let subscription = fixture_file("license-subscription.jws");
    let payload = payload_of(&subscription);
    assert_eq!(
        (
            payload["hostId"].clone(),
            payload["customer"]["inn"].clone()
        ),
        (json!(FIXTURE_HOST_ID), json!(INN))
    );
    // Distinct quotas and mixed features, so a swapped field cannot pass.
    assert_eq!(
        (payload["quotas"].clone(), payload["features"].clone()),
        (
            json!({ "lines": 2, "stations": 5, "kiosks": 0, "cabinetUsers": 3 }),
            json!({
                "labelEditor": true, "publicApi": false, "pallets": true, "chzIntegration": true,
                "inventory": false, "commerceMl": false, "handheld": true
            })
        )
    );
    for (name, reason) in [
        ("license-tampered.jws", "license_signature"),
        ("license-unknown-kid.jws", "license_unknown_key"),
        ("license-other-host.jws", "license_wrong_host"),
        ("license-other-inn.jws", "license_inn_mismatch"),
    ] {
        let (status, body) = load(&admin, &fixture_file(name)).await;
        assert_eq!(
            (status, body["error"]["details"]["reason"].clone()),
            (StatusCode::BAD_REQUEST, json!(reason)),
            "{name}"
        );
    }
    // Accepted, whatever its dates. Issued after the manual clock's start, it
    // moves the time to its issue less a day, the eve of its start: it waits.
    let issued = payload["issuedAt"].as_i64().unwrap();
    let body = load_ok(&admin, &subscription).await;
    assert_eq!(
        (
            body["effectiveAt"].clone(),
            body["license"].clone(),
            body["warnings"].clone()
        ),
        (
            json!(text(issued - DAY_MS)),
            Value::Null,
            json!(["not_yet_valid"])
        )
    );
    let upgrade = fixture_file("license-upgrade.jws");
    let upgrade_issued = payload_of(&upgrade)["issuedAt"].as_i64().unwrap();
    let body = load_ok(&admin, &upgrade).await;
    // The upgrade waits for its own start; the subscription is in force.
    assert_eq!(
        (
            body["effectiveAt"].clone(),
            body["license"]["licenseId"].clone(),
            body["warnings"].clone()
        ),
        (
            json!(text(upgrade_issued - DAY_MS)),
            payload["licenseId"].clone(),
            json!(["not_yet_valid"])
        )
    );
    // The rows keep the whole of both files, field by field.
    let mut conn = admin.app.state.pool.acquire().await.unwrap();
    assert_eq!(
        store::licenses(&mut conn).await.unwrap(),
        vec![kept_of(&payload), kept_of(&payload_of(&upgrade))]
    );
    drop(conn);
    let (status, body) = load(&admin, &fixture_file("license-older.jws")).await;
    assert_eq!(
        (status, body["error"]["details"].clone()),
        (
            StatusCode::BAD_REQUEST,
            json!({ "field": "file", "reason": "license_older", "newestSequence": 2 })
        )
    );
}

/// Every license case of plan ЛЦ-1's `expectations.json` reads on the host
/// as the domain reads it: `ok` files pass steps 1–4, the others name the
/// refusal that matches the domain's result.
#[test]
fn the_host_reads_every_license_fixture_as_the_domain_does() {
    let keyset = markiro_proto::trust::license_keyset();
    let expectations: Value = serde_json::from_str(
        &std::fs::read_to_string(format!(
            "{}/../../../packages/domain/fixtures/standalone-license/expectations.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap(),
    )
    .unwrap();
    let mut seen = 0;
    for case in expectations.as_array().unwrap() {
        if case["as"] != "license" || case.get("retiredKids").is_some() {
            continue;
        }
        let name = case["file"].as_str().unwrap();
        let read = verify::read(&fixture_file(name), &keyset);
        match case["result"].as_str().unwrap() {
            "ok" => {
                let verified = read.unwrap_or_else(|refusal| panic!("{name}: {refusal:?}"));
                let payload = payload_of(&fixture_file(name));
                // The whole file: every quota, every feature and every term.
                assert_eq!(verified.license, kept_of(&payload), "{name}");
            }
            result => {
                let expected = match result {
                    "malformed" => Refusal::Malformed,
                    "unknown_key" => Refusal::UnknownKey,
                    "bad_signature" => Refusal::Signature,
                    other => panic!("{name}: unknown result {other}"),
                };
                assert_eq!(read, Err(expected), "{name}");
            }
        }
        seen += 1;
    }
    assert_eq!(seen, 20);
}
