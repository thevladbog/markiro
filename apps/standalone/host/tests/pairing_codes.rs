mod support;

use axum::http::StatusCode;
use markiro_host::clock::format_timestamp;
use markiro_host::secrets::key_hash;
use serde_json::{json, Value};
use support::app::{
    bootstrap, empty, login, pair_device, request, seed_office_user, test_fingerprint, with_device,
    with_session, TestApp,
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
