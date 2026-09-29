mod support;

use axum::http::StatusCode;
use markiro_host::clock::format_timestamp;
use markiro_host::secrets::key_hash;
use serde_json::{json, Value};
use support::app::{
    bootstrap, empty, json as json_request, login, pair_device, request, seed_office_user,
    test_fingerprint, with_device, with_session, TestApp, LAN,
};

const CROCKFORD: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

type AuditRow = (
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
);

async fn code_audit(app: &TestApp) -> Vec<AuditRow> {
    sqlx::query_as(
        "SELECT actor_kind, actor_id, action, target_type, target_id, result, details \
         FROM audit_log WHERE action = 'pairing_code.create' ORDER BY id",
    )
    .fetch_all(&app.state.pool)
    .await
    .unwrap()
}

async fn admin_id(app: &TestApp) -> String {
    sqlx::query_scalar("SELECT id FROM office_users WHERE login = 'admin'")
        .fetch_one(&app.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn an_administrator_gets_a_one_time_code_with_the_pairing_payload() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;

    let (status, body) = app
        .send(empty(with_session(
            request("POST", "/v1/office/pairing-codes"),
            &key,
            &token,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let code = body["code"].as_str().unwrap().to_owned();
    assert_eq!(code.len(), 10);
    assert!(code.bytes().all(|byte| CROCKFORD.contains(&byte)), "{code}");
    let expires = format_timestamp(app.state.now() + time::Duration::minutes(10));
    assert_eq!(body["expiresAt"], expires);
    assert_eq!(
        body["payload"],
        format!(
            "markiro-host:1?h=10.0.0.5,192.168.1.10&p=45710&f={}&c={code}",
            test_fingerprint()
        )
    );

    let (id, code_hash, created_by, created_at, expires_at, used_at, failed): (
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        i64,
    ) = sqlx::query_as(
        "SELECT id, code_hash, created_by, created_at, expires_at, used_at, failed_attempts FROM pairing_codes",
    )
    .fetch_one(&app.state.pool)
    .await
    .unwrap();
    let admin = admin_id(&app).await;
    assert_eq!(
        (body["id"].clone(), body["createdAt"].clone()),
        (json!(id), json!(created_at))
    );
    assert_eq!(code_hash, key_hash(&code));
    assert_eq!(created_by, admin);
    assert_eq!(created_at, app.state.timestamp());
    assert_eq!(expires_at, expires);
    assert_eq!(used_at, None);
    assert_eq!(failed, 0);

    let rows = code_audit(&app).await;
    assert_eq!(rows.len(), 1);
    let (actor_kind, actor_id, action, target_type, target_id, result, details) =
        rows.into_iter().next().unwrap();
    assert_eq!(
        (
            actor_kind.as_str(),
            actor_id.as_deref(),
            action.as_str(),
            target_type.as_deref(),
            target_id.as_deref(),
            result.as_str()
        ),
        (
            "office_user",
            Some(admin.as_str()),
            "pairing_code.create",
            Some("pairing_code"),
            Some(id.as_str()),
            "ok"
        )
    );
    assert_eq!(
        serde_json::from_str::<Value>(&details).unwrap(),
        json!({ "expiresAt": expires })
    );
    assert!(
        !details.contains(&code),
        "the audit row never holds the code"
    );
}

#[tokio::test]
async fn every_request_gets_a_new_code() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;
    let mut codes = Vec::new();
    for _ in 0..2 {
        let (status, body) = app
            .send(empty(with_session(
                request("POST", "/v1/office/pairing-codes"),
                &key,
                &token,
            )))
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        codes.push(body["code"].as_str().unwrap().to_owned());
    }
    assert_ne!(codes[0], codes[1]);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pairing_codes")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 2);
}

#[tokio::test]
async fn only_administrators_create_codes() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    seed_office_user(&app, "tech", "technologist", "technologist password").await;
    let tech_token = login(&app, &key, "tech", "technologist password").await;

    let (status, body) = app
        .send(empty(with_session(
            request("POST", "/v1/office/pairing-codes"),
            &key,
            &tech_token,
        )))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let (status, body) = app
        .send(empty(with_device(
            request("POST", "/v1/office/pairing-codes"),
            &key,
        )))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["details"]["credential"], "session");

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pairing_codes")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert!(code_audit(&app).await.is_empty());
}

/// A new code for the session `token`, replacing `replaces` if given.
async fn issue(app: &TestApp, key: &str, token: &str, replaces: Option<&str>) -> Value {
    let builder = with_session(request("POST", "/v1/office/pairing-codes"), key, token);
    let (status, body) = match replaces {
        Some(old) => {
            app.send(json_request(builder, json!({ "replaces": old })))
                .await
        }
        None => app.send(empty(builder)).await,
    };
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["id"].is_string(), "the answer names the code: {body}");
    body
}

async fn claim(app: &TestApp, code: &Value) -> (StatusCode, Value) {
    app.send_from(
        LAN,
        json_request(
            request("POST", "/v1/pairing/claim"),
            json!({ "code": code["code"], "kind": "station", "name": "Станция 2", "appVersion": "0.1.0" }),
        ),
    )
    .await
}

/// `details` of the `pairing_code.create` row of the code `id`.
async fn created_details(app: &TestApp, id: &Value) -> Value {
    let row = code_audit(app)
        .await
        .into_iter()
        .find(|row| row.4.as_deref() == id.as_str())
        .unwrap();
    serde_json::from_str(&row.6).unwrap()
}

#[tokio::test]
async fn a_new_code_replaces_the_administrators_previous_one() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;
    let first = issue(&app, &key, &token, None).await;
    let second = issue(&app, &key, &token, first["id"].as_str()).await;
    assert_ne!(second["id"], first["id"]);

    // The replaced code is refused as expired; the new one pairs.
    let (status, body) = claim(&app, &first).await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("pairing_code_expired"))
    );
    let reason: String = sqlx::query_scalar(
        "SELECT json_extract(details, '$.reason') FROM audit_log \
         WHERE action = 'device.claim' AND result = 'denied'",
    )
    .fetch_one(&app.state.pool)
    .await
    .unwrap();
    assert_eq!(reason, "code_expired");
    let (status, body) = claim(&app, &second).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let admin = admin_id(&app).await;
    let rows = code_audit(&app).await;
    assert_eq!(rows.len(), 2);
    assert_eq!(
        (
            rows[1].0.as_str(),
            rows[1].1.as_deref(),
            rows[1].2.as_str(),
            rows[1].3.as_deref(),
            rows[1].4.as_deref(),
            rows[1].5.as_str()
        ),
        (
            "office_user",
            Some(admin.as_str()),
            "pairing_code.create",
            Some("pairing_code"),
            second["id"].as_str(),
            "ok"
        )
    );
    assert_eq!(
        created_details(&app, &second["id"]).await,
        json!({ "expiresAt": second["expiresAt"], "replaces": first["id"] })
    );
}

#[tokio::test]
async fn a_replaces_naming_no_live_code_of_this_administrator_is_ignored() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;
    let used = issue(&app, &key, &token, None).await;
    assert_eq!(claim(&app, &used).await.0, StatusCode::OK);
    let expired = issue(&app, &key, &token, None).await;
    app.clock.advance(time::Duration::minutes(10));
    seed_office_user(&app, "admin2", "admin", "second admin password").await;
    let other_token = login(&app, &key, "admin2", "second admin password").await;
    let theirs = issue(&app, &key, &other_token, None).await;

    // Another administrator's code, a used one, an expired one and an
    // unknown id: a new code every time, and nothing replaced.
    for old in [
        theirs["id"].as_str().unwrap(),
        used["id"].as_str().unwrap(),
        expired["id"].as_str().unwrap(),
        "9b2e4a6c-0000-4000-8000-000000000000",
    ] {
        let issued = issue(&app, &key, &token, Some(old)).await;
        assert_eq!(
            created_details(&app, &issued["id"]).await,
            json!({ "expiresAt": issued["expiresAt"] }),
            "{old}"
        );
    }
    // The other administrator's code still pairs.
    let (status, body) = claim(&app, &theirs).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn a_code_request_body_is_optional_but_strict() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;
    let builder = || with_session(request("POST", "/v1/office/pairing-codes"), &key, &token);
    let (status, body) = app.send(json_request(builder(), json!({}))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = app
        .send(json_request(builder(), json!({ "replace": body["id"] })))
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed"))
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pairing_codes")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}
