mod support;

use axum::http::StatusCode;
use markiro_host::secrets::key_hash;
use serde_json::{json, Value};
use support::app::{
    empty, json as json_request, login, pair_device, request, seed_office_user, with_device,
    with_session, TestApp, LAN, LOOPBACK,
};

async fn last_audit(
    app: &TestApp,
) -> (
    String,
    Option<String>,
    String,
    Option<String>,
    String,
    Value,
) {
    let (actor_kind, actor_id, action, target_id, result, details): (String, Option<String>, String, Option<String>, String, String) =
        sqlx::query_as(
            "SELECT actor_kind, actor_id, action, target_id, result, details FROM audit_log ORDER BY id DESC LIMIT 1",
        )
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    (
        actor_kind,
        actor_id,
        action,
        target_id,
        result,
        serde_json::from_str(&details).unwrap(),
    )
}

#[tokio::test]
async fn login_opens_a_session_bound_to_the_device() {
    let app = TestApp::new().await;
    let (device_id, key) = pair_device(&app, "office").await;
    let user_id = seed_office_user(&app, "irina", "admin", "correct horse battery").await;

    let (status, body) = app
        .send(json_request(
            with_device(request("POST", "/v1/office/login"), &key),
            json!({ "login": "IRINA", "password": "correct horse battery" }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let token = body["token"].as_str().unwrap();
    assert_eq!(token.len(), 43);
    assert_eq!(
        body["user"],
        json!({ "id": user_id, "login": "irina", "name": "Пользователь irina", "role": "admin" })
    );
    let expected_expiry =
        markiro_host::clock::format_timestamp(app.state.now() + time::Duration::hours(12));
    assert_eq!(body["expiresAt"], expected_expiry);

    let (stored_user, stored_device): (String, String) =
        sqlx::query_as("SELECT user_id, device_id FROM office_sessions WHERE token_hash = ?")
            .bind(key_hash(token))
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(
        (stored_user.as_str(), stored_device.as_str()),
        (user_id.as_str(), device_id.as_str())
    );
    assert_eq!(
        last_audit(&app).await,
        (
            "device".into(),
            Some(device_id),
            "office.login".into(),
            Some(user_id),
            "ok".into(),
            json!({ "login": "irina" })
        )
    );
}

#[tokio::test]
async fn wrong_password_unknown_login_and_inactive_user_are_denied_and_audited() {
    let app = TestApp::new().await;
    let (device_id, key) = pair_device(&app, "office").await;
    let user_id = seed_office_user(&app, "irina", "admin", "correct horse battery").await;

    let (status, body) = app
        .send(json_request(
            with_device(request("POST", "/v1/office/login"), &key),
            json!({ "login": "irina", "password": "wrong password" }),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["code"], "unauthorized");
    assert_eq!(
        last_audit(&app).await,
        (
            "device".into(),
            Some(device_id.clone()),
            "office.login".into(),
            Some(user_id.clone()),
            "denied".into(),
            json!({ "login": "irina" })
        )
    );

    let (status, _) = app
        .send(json_request(
            with_device(request("POST", "/v1/office/login"), &key),
            json!({ "login": "nobody", "password": "correct horse battery" }),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        last_audit(&app).await,
        (
            "device".into(),
            Some(device_id),
            "office.login".into(),
            None,
            "denied".into(),
            json!({ "login": "nobody" })
        )
    );

    sqlx::query("UPDATE office_users SET active = 0 WHERE id = ?")
        .bind(&user_id)
        .execute(&app.state.pool)
        .await
        .unwrap();
    let (status, _) = app
        .send(json_request(
            with_device(request("POST", "/v1/office/login"), &key),
            json!({ "login": "irina", "password": "correct horse battery" }),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn login_requires_a_device() {
    let app = TestApp::new().await;
    seed_office_user(&app, "irina", "admin", "correct horse battery").await;
    let (status, _) = app
        .send(json_request(
            request("POST", "/v1/office/login"),
            json!({ "login": "irina", "password": "correct horse battery" }),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn me_reloads_role_and_rejects_foreign_devices() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "office").await;
    let (_, other_key) = pair_device(&app, "office").await;
    let user_id = seed_office_user(&app, "irina", "admin", "correct horse battery").await;
    let token = login(&app, &key, "irina", "correct horse battery").await;

    let (status, body) = app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &key,
            &token,
        )))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["role"], "admin");

    sqlx::query("UPDATE office_users SET role = 'technologist' WHERE id = ?")
        .bind(&user_id)
        .execute(&app.state.pool)
        .await
        .unwrap();
    let (_, body) = app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &key,
            &token,
        )))
        .await;
    assert_eq!(body["role"], "technologist");

    let (status, _) = app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &other_key,
            &token,
        )))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = app
        .send(empty(with_device(request("GET", "/v1/office/me"), &key)))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn sessions_end_after_idle_and_absolute_limits() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "office").await;
    seed_office_user(&app, "irina", "admin", "correct horse battery").await;

    let token = login(&app, &key, "irina", "correct horse battery").await;
    app.clock.advance(time::Duration::minutes(29));
    let (status, _) = app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &key,
            &token,
        )))
        .await;
    assert_eq!(status, StatusCode::OK);
    app.clock.advance(time::Duration::minutes(31));
    let (status, body) = app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &key,
            &token,
        )))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["message"], "office session expired");
    let remaining: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM office_sessions WHERE token_hash = ?")
            .bind(key_hash(&token))
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(remaining, 0, "an expired session is deleted");

    let token = login(&app, &key, "irina", "correct horse battery").await;
    for _ in 0..24 {
        app.clock.advance(time::Duration::minutes(29));
        let (status, _) = app
            .send(empty(with_session(
                request("GET", "/v1/office/me"),
                &key,
                &token,
            )))
            .await;
        assert_eq!(status, StatusCode::OK);
    }
    app.clock.advance(time::Duration::minutes(29));
    let (status, _) = app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &key,
            &token,
        )))
        .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "12 hours is the absolute limit"
    );
}

#[tokio::test]
async fn logout_ends_the_session_and_is_audited() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "office").await;
    let user_id = seed_office_user(&app, "irina", "admin", "correct horse battery").await;
    let token = login(&app, &key, "irina", "correct horse battery").await;

    let (status, body) = app
        .send(empty(with_session(
            request("POST", "/v1/office/logout"),
            &key,
            &token,
        )))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(body, Value::Null);
    let (status, _) = app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &key,
            &token,
        )))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (actor_kind, actor_id, action, target_id, result, details) = last_audit(&app).await;
    assert_eq!(
        (
            actor_kind.as_str(),
            actor_id.as_deref(),
            action.as_str(),
            target_id.as_deref(),
            result.as_str()
        ),
        (
            "office_user",
            Some(user_id.as_str()),
            "office.logout",
            Some(user_id.as_str()),
            "ok"
        )
    );
    assert_eq!(details, json!({}));
}

#[tokio::test]
async fn login_attempts_are_limited_per_address() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "office").await;
    let attempt = |peer: ([u8; 4], u16)| {
        let app = &app;
        let key = key.clone();
        async move {
            app.send_from(
                peer,
                json_request(
                    with_device(request("POST", "/v1/office/login"), &key),
                    json!({ "login": "nobody", "password": "whatever-password" }),
                ),
            )
            .await
        }
    };
    for _ in 0..10 {
        assert_eq!(attempt(LAN).await.0, StatusCode::UNAUTHORIZED);
    }
    let (status, body) = attempt(LAN).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["error"]["code"], "rate_limited");
    assert_eq!(attempt(LOOPBACK).await.0, StatusCode::UNAUTHORIZED);
    app.clock.advance(time::Duration::seconds(61));
    assert_eq!(attempt(LAN).await.0, StatusCode::UNAUTHORIZED);
}
