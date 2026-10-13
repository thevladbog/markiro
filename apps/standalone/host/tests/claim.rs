mod support;

use axum::http::StatusCode;
use markiro_host::secrets::key_hash;
use serde_json::{json, Value};
use support::app::{
    audit_trail, bootstrap, empty, json as json_request, pair_device, request, with_device,
    with_session, AuditRow, TestApp, LAN, LOOPBACK,
};

async fn claim_audit(app: &TestApp) -> Vec<AuditRow> {
    audit_trail(app, "device.claim").await
}

/// A host after the wizard: the host device's key and the admin's session.
async fn host(app: &TestApp) -> (String, String) {
    let (_, key) = pair_device(app, "station").await;
    let token = bootstrap(app, &key).await;
    (key, token)
}

/// A new code from the office; returns the code and its row id.
async fn new_code(app: &TestApp, key: &str, token: &str) -> (String, String) {
    let (status, body) = app
        .send(empty(with_session(
            request("POST", "/v1/office/pairing-codes"),
            key,
            token,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let code = body["code"].as_str().unwrap().to_owned();
    let id = sqlx::query_scalar("SELECT id FROM pairing_codes WHERE code_hash = ?")
        .bind(key_hash(&code))
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    (code, id)
}

fn claim_body(code: &str) -> Value {
    json!({ "code": code, "kind": "station", "name": "Станция 2", "appVersion": "0.1.0" })
}

async fn claim(app: &TestApp, body: Value) -> (StatusCode, Value) {
    app.send_from(
        LAN,
        json_request(request("POST", "/v1/pairing/claim"), body),
    )
    .await
}

async fn failed_attempts(app: &TestApp, id: &str) -> i64 {
    sqlx::query_scalar("SELECT failed_attempts FROM pairing_codes WHERE id = ?")
        .bind(id)
        .fetch_one(&app.state.pool)
        .await
        .unwrap()
}

fn denied(reason: &str, target: Option<&str>) -> AuditRow {
    (
        "system".into(),
        None,
        "device.claim".into(),
        Some("pairing_code".into()),
        target.map(str::to_owned),
        "denied".into(),
        json!({ "reason": reason, "kind": "station", "name": "Станция 2", "address": "192.168.1.20" }),
    )
}

#[tokio::test]
async fn a_device_in_the_network_pairs_with_a_code_typed_in_any_case() {
    let app = TestApp::new().await;
    let (key, token) = host(&app).await;
    let (code, code_id) = new_code(&app, &key, &token).await;
    let typed = format!("{}-{}", &code[..5], &code[5..]).to_lowercase();

    let (status, body) = claim(&app, claim_body(&typed)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let device_id = body["deviceId"].as_str().unwrap().to_owned();
    let device_key = body["deviceKey"].as_str().unwrap().to_owned();
    assert_eq!(device_key.len(), 43);
    assert_eq!(body["hostId"], app.state.host_id);

    let (kind, name, stored_hash, protocol, paired_at): (String, String, String, i64, String) =
        sqlx::query_as(
            "SELECT kind, name, key_hash, protocol, paired_at FROM devices WHERE id = ?",
        )
        .bind(&device_id)
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(
        (kind.as_str(), name.as_str(), protocol, paired_at),
        ("station", "Станция 2", 4, app.state.timestamp())
    );
    assert_eq!(stored_hash, key_hash(&device_key));
    let used_at: Option<String> =
        sqlx::query_scalar("SELECT used_at FROM pairing_codes WHERE id = ?")
            .bind(&code_id)
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(used_at, Some(app.state.timestamp()));

    // The new key works from the network.
    let (status, me) = app
        .send_from(
            LAN,
            empty(with_device(request("GET", "/v1/device"), &device_key)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{me}");
    assert_eq!(me["name"], "Станция 2");

    assert_eq!(
        claim_audit(&app).await,
        vec![(
            "device".into(),
            Some(device_id.clone()),
            "device.claim".into(),
            Some("device".into()),
            Some(device_id),
            "ok".into(),
            json!({ "kind": "station", "name": "Станция 2", "pairingCodeId": code_id, "address": "192.168.1.20" }),
        )]
    );
}

#[tokio::test]
async fn a_code_is_claimed_once() {
    let app = TestApp::new().await;
    let (key, token) = host(&app).await;
    let (code, code_id) = new_code(&app, &key, &token).await;
    assert_eq!(claim(&app, claim_body(&code)).await.0, StatusCode::OK);

    let (status, body) = claim(&app, claim_body(&code)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "pairing_code_invalid");
    let devices: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM devices")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(devices, 2, "the host device and the one that claimed first");
    let rows = claim_audit(&app).await;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1], denied("code_used", Some(&code_id)));
}

#[tokio::test]
async fn a_code_expires_after_ten_minutes() {
    let app = TestApp::new().await;
    let (key, token) = host(&app).await;
    let (code, code_id) = new_code(&app, &key, &token).await;
    app.clock.advance(time::Duration::minutes(10));

    let (status, body) = claim(&app, claim_body(&code)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "pairing_code_expired");
    assert_eq!(
        claim_audit(&app).await,
        vec![denied("code_expired", Some(&code_id))]
    );
}

#[tokio::test]
async fn five_wrong_codes_kill_every_live_code() {
    let app = TestApp::new().await;
    let (key, token) = host(&app).await;
    let (code, code_id) = new_code(&app, &key, &token).await;
    for attempt in 1..=5 {
        let wrong = if attempt == 3 { "hello" } else { "0000000000" };
        let (status, body) = claim(&app, claim_body(wrong)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["error"]["code"], "pairing_code_invalid");
        assert_eq!(failed_attempts(&app, &code_id).await, attempt);
    }

    let (status, body) = claim(&app, claim_body(&code)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "pairing_code_invalid");
    let rows = claim_audit(&app).await;
    assert_eq!(rows.len(), 6);
    assert_eq!(rows[0], denied("unknown_code", None));
    assert_eq!(rows[1], denied("unknown_code", None));
    assert_eq!(rows[2], denied("unknown_code", None));
    assert_eq!(rows[3], denied("unknown_code", None));
    assert_eq!(rows[4], denied("unknown_code", None));
    assert_eq!(rows[5], denied("too_many_attempts", Some(&code_id)));
}

#[tokio::test]
async fn a_wrong_code_counts_against_every_live_code_only() {
    let app = TestApp::new().await;
    let (key, token) = host(&app).await;
    // A, B and C exist before any clock movement.
    let (_, a_id) = new_code(&app, &key, &token).await;
    let (_, b_id) = new_code(&app, &key, &token).await;
    let (c_code, c_id) = new_code(&app, &key, &token).await;
    assert_eq!(claim(&app, claim_body(&c_code)).await.0, StatusCode::OK);
    // D shares A and B's expiry window: created at the same instant.
    let (_, d_id) = new_code(&app, &key, &token).await;
    // Exactly one code lifetime later, A, B and D (all unused) are expired,
    // and so is C: being used does not exempt a code from also expiring. C
    // is excluded from the counter below by both conditions at once, which
    // is why G exists — it isolates `used_at IS NULL` on its own.
    app.clock.advance(time::Duration::minutes(10));
    // E and F are fresh, live codes created after the advance.
    let (_, e_id) = new_code(&app, &key, &token).await;
    let (_, f_id) = new_code(&app, &key, &token).await;
    // G is claimed right after the advance too, so — unlike C — it is used
    // well before its own expiry: only `used_at IS NULL` excludes it below.
    let (g_code, g_id) = new_code(&app, &key, &token).await;
    assert_eq!(claim(&app, claim_body(&g_code)).await.0, StatusCode::OK);

    let (status, body) = claim(&app, claim_body("0000000000")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["code"], "pairing_code_invalid");

    assert_eq!(failed_attempts(&app, &a_id).await, 0, "A is expired");
    assert_eq!(failed_attempts(&app, &b_id).await, 0, "B is expired");
    assert_eq!(failed_attempts(&app, &c_id).await, 0, "C is used");
    assert_eq!(failed_attempts(&app, &d_id).await, 0, "D is expired");
    assert_eq!(failed_attempts(&app, &g_id).await, 0, "G is used");
    assert_eq!(failed_attempts(&app, &e_id).await, 1, "E is live");
    assert_eq!(failed_attempts(&app, &f_id).await, 1, "F is live");
}

#[tokio::test]
async fn claims_are_limited_per_address_separately_from_logins() {
    let app = TestApp::new().await;
    let (key, _) = host(&app).await;
    for _ in 0..10 {
        assert_eq!(
            claim(&app, claim_body("0000000000")).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    let (status, body) = claim(&app, claim_body("0000000000")).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["error"]["code"], "rate_limited");
    assert_eq!(
        claim_audit(&app).await.len(),
        10,
        "a refused-by-limit attempt writes no row"
    );

    // Another address still gets an answer, and logins from this address are not affected.
    let (status, _) = app
        .send_from(
            LOOPBACK,
            json_request(
                request("POST", "/v1/pairing/claim"),
                claim_body("0000000000"),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, body) = app
        .send_from(
            LAN,
            json_request(
                with_device(request("POST", "/v1/office/login"), &key),
                json!({ "login": "admin", "password": "correct horse battery" }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn a_claim_is_checked_before_the_code() {
    let app = TestApp::new().await;
    let (key, token) = host(&app).await;
    let (code, code_id) = new_code(&app, &key, &token).await;

    // Both invalid requests carry a wrong code, not the live one: if
    // validation ran after the code lookup, a wrong code would already have
    // reached the every-live-code counting branch by the time validation
    // failed, which the assertions below would catch.
    let (status, body) = claim(
        &app,
        json!({ "code": "0000000000", "kind": "station", "name": "  ", "appVersion": "0.1.0" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "validation_failed");
    assert_eq!(body["error"]["details"]["field"], "name");
    let mut extra = claim_body("0000000000");
    extra["extra"] = json!(true);
    let (status, body) = claim(&app, extra).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "validation_failed");

    assert_eq!(failed_attempts(&app, &code_id).await, 0);
    assert!(claim_audit(&app).await.is_empty());

    // The real code was never touched by either invalid attempt: it still works.
    assert_eq!(claim(&app, claim_body(&code)).await.0, StatusCode::OK);
}

/// The device's name obeys the one control-character rule here too, and the
/// refusal comes before the code is looked at: the code is neither used nor
/// counted against.
#[tokio::test]
async fn a_claim_with_a_control_character_in_the_device_name_creates_no_device() {
    let app = TestApp::new().await;
    let (key, token) = host(&app).await;
    let (code, code_id) = new_code(&app, &key, &token).await;

    for name in ["\u{0}Станция 2", "Стан\tция 2"] {
        let mut body = claim_body(&code);
        body["name"] = json!(name);
        let (status, response) = claim(&app, body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{name:?}");
        assert_eq!(response["error"]["code"], "validation_failed", "{name:?}");
        assert_eq!(response["error"]["details"]["field"], "name", "{name:?}");
    }
    let devices: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM devices")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(devices, 1, "only the host's own device exists");
    assert_eq!(failed_attempts(&app, &code_id).await, 0);
    assert!(claim_audit(&app).await.is_empty());
    // The code was never touched: it still pairs a device with a clean name.
    assert_eq!(claim(&app, claim_body(&code)).await.0, StatusCode::OK);
}

#[tokio::test]
async fn a_handheld_pairs_with_a_code() {
    let app = TestApp::new().await;
    let (key, token) = host(&app).await;
    let (code, _) = new_code(&app, &key, &token).await;
    let (status, body) = claim(
        &app,
        json!({ "code": code, "kind": "handheld", "name": "ТСД 1", "appVersion": "1.2.0", "capabilities": ["scanner"] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (kind, capabilities): (String, String) =
        sqlx::query_as("SELECT kind, capabilities FROM devices WHERE id = ?")
            .bind(body["deviceId"].as_str().unwrap())
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(
        (kind.as_str(), capabilities.as_str()),
        ("handheld", r#"["scanner"]"#)
    );
}
