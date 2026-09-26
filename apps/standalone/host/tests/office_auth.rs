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
    Option<String>,
    String,
    Value,
) {
    let (actor_kind, actor_id, action, target_type, target_id, result, details): (
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
    ) = sqlx::query_as(
        "SELECT actor_kind, actor_id, action, target_type, target_id, result, details \
         FROM audit_log ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&app.state.pool)
    .await
    .unwrap();
    (
        actor_kind,
        actor_id,
        action,
        target_type,
        target_id,
        result,
        serde_json::from_str(&details).unwrap(),
    )
}

async fn session_last_seen(app: &TestApp, token: &str) -> String {
    sqlx::query_scalar("SELECT last_seen_at FROM office_sessions WHERE token_hash = ?")
        .bind(key_hash(token))
        .fetch_one(&app.state.pool)
        .await
        .unwrap()
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
            Some("office_user".into()),
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
    assert_eq!(body["error"]["details"]["credential"], "password");
    assert_eq!(
        last_audit(&app).await,
        (
            "device".into(),
            Some(device_id.clone()),
            "office.login".into(),
            Some("office_user".into()),
            Some(user_id.clone()),
            "denied".into(),
            json!({ "login": "irina" })
        )
    );

    let (status, body) = app
        .send(json_request(
            with_device(request("POST", "/v1/office/login"), &key),
            json!({ "login": "nobody", "password": "correct horse battery" }),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["details"]["credential"], "password");
    assert_eq!(
        last_audit(&app).await,
        (
            "device".into(),
            Some(device_id),
            "office.login".into(),
            Some("office_user".into()),
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
    let (status, body) = app
        .send(json_request(
            with_device(request("POST", "/v1/office/login"), &key),
            json!({ "login": "irina", "password": "correct horse battery" }),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        body["error"]["details"]["credential"], "password",
        "an inactive user is a password-style rejection, not a session one"
    );
}

#[tokio::test]
async fn login_requires_a_device() {
    let app = TestApp::new().await;
    seed_office_user(&app, "irina", "admin", "correct horse battery").await;
    let (status, body) = app
        .send(json_request(
            request("POST", "/v1/office/login"),
            json!({ "login": "irina", "password": "correct horse battery" }),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["code"], "unauthorized");
    assert_eq!(
        body["error"]["details"]["credential"], "device",
        "a missing device key is a device-credential rejection, not a password one"
    );
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

    let (status, body) = app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &other_key,
            &token,
        )))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        body["error"]["details"]["credential"], "session",
        "a token bound to a different device is a session-credential rejection"
    );
    let (status, body) = app
        .send(empty(with_device(request("GET", "/v1/office/me"), &key)))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["details"]["credential"], "session");
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
    assert_eq!(body["error"]["details"]["credential"], "session");
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
async fn session_heartbeat_is_throttled_to_once_a_minute() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "office").await;
    seed_office_user(&app, "irina", "admin", "correct horse battery").await;
    let token = login(&app, &key, "irina", "correct horse battery").await;
    let created_at = session_last_seen(&app, &token).await;

    // Well inside the same minute: the write is skipped, like the device's
    // own throttled `last_seen_at`.
    app.clock.advance(time::Duration::seconds(30));
    let (status, _) = app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &key,
            &token,
        )))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        session_last_seen(&app, &token).await,
        created_at,
        "an office request inside the same minute must not rewrite last_seen_at"
    );

    // A minute after the last write: the heartbeat updates.
    app.clock.advance(time::Duration::seconds(31));
    let (status, _) = app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &key,
            &token,
        )))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        session_last_seen(&app, &token).await,
        app.state.timestamp(),
        "a minute after the last write, the office session heartbeat updates"
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
    let (actor_kind, actor_id, action, target_type, target_id, result, details) =
        last_audit(&app).await;
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
            Some(user_id.as_str()),
            "office.logout",
            Some("office_user"),
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

#[tokio::test]
async fn malformed_logins_are_denied_without_recording_the_input() {
    let app = TestApp::new().await;
    let (device_id, key) = pair_device(&app, "office").await;

    let huge_login = "a".repeat(10_000);
    let (status, body) = app
        .send(json_request(
            with_device(request("POST", "/v1/office/login"), &key),
            json!({ "login": huge_login, "password": "correct horse battery" }),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["code"], "unauthorized");
    assert_eq!(body["error"]["details"]["credential"], "password");
    assert_eq!(
        last_audit(&app).await,
        (
            "device".into(),
            Some(device_id.clone()),
            "office.login".into(),
            Some("office_user".into()),
            None,
            "denied".into(),
            json!({ "reason": "invalid_login" })
        )
    );

    let (status, body) = app
        .send(json_request(
            with_device(request("POST", "/v1/office/login"), &key),
            json!({ "login": "ирина", "password": "correct horse battery" }),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["code"], "unauthorized");
    assert_eq!(body["error"]["details"]["credential"], "password");
    assert_eq!(
        last_audit(&app).await,
        (
            "device".into(),
            Some(device_id),
            "office.login".into(),
            Some("office_user".into()),
            None,
            "denied".into(),
            json!({ "reason": "invalid_login" })
        )
    );
}

async fn host_revision(app: &TestApp) -> i64 {
    sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
        .fetch_one(&app.state.pool)
        .await
        .unwrap()
}

type AuditRow = (
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
);

async fn password_audit(app: &TestApp, result: &str) -> Vec<AuditRow> {
    sqlx::query_as(
        "SELECT actor_kind, actor_id, action, target_type, target_id, result, details \
         FROM audit_log WHERE action = 'office_user.password' AND result = ? ORDER BY id",
    )
    .bind(result)
    .fetch_all(&app.state.pool)
    .await
    .unwrap()
}

fn change(current: &str, new: &str) -> Value {
    json!({ "currentPassword": current, "newPassword": new })
}

#[tokio::test]
async fn a_user_changes_their_own_password() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "office").await;
    let (_, other_key) = pair_device(&app, "office").await;
    let tech_id = seed_office_user(&app, "tech", "technologist", "correct horse battery").await;
    let token = login(&app, &key, "tech", "correct horse battery").await;
    let other_token = login(&app, &other_key, "tech", "correct horse battery").await;
    let before = host_revision(&app).await;

    let (status, body) = app
        .send(json_request(
            with_session(request("PUT", "/v1/office/me/password"), &key, &token),
            change("correct horse battery", "another long password"),
        ))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    assert_eq!(host_revision(&app).await, before + 1);
    let me = app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &key,
            &token,
        )))
        .await;
    assert_eq!(me.0, StatusCode::OK, "the caller's own session stays");
    let other = app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &other_key,
            &other_token,
        )))
        .await;
    assert_eq!(
        other.0,
        StatusCode::UNAUTHORIZED,
        "sessions on other devices end"
    );

    login(&app, &key, "tech", "another long password").await;
    let (status, _) = app
        .send(json_request(
            with_device(request("POST", "/v1/office/login"), &key),
            json!({ "login": "tech", "password": "correct horse battery" }),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        password_audit(&app, "ok").await,
        vec![(
            "office_user".into(),
            Some(tech_id.clone()),
            "office_user.password".into(),
            Some("office_user".into()),
            Some(tech_id),
            "ok".into(),
            "{}".into()
        )]
    );
}

#[tokio::test]
async fn a_wrong_current_password_changes_nothing() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "office").await;
    let tech_id = seed_office_user(&app, "tech", "technologist", "correct horse battery").await;
    let token = login(&app, &key, "tech", "correct horse battery").await;
    let phc: String = sqlx::query_scalar("SELECT password_phc FROM office_users WHERE id = ?")
        .bind(&tech_id)
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    let before = host_revision(&app).await;

    let (status, body) = app
        .send(json_request(
            with_session(request("PUT", "/v1/office/me/password"), &key, &token),
            change("not the password", "another long password"),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["code"], "unauthorized");
    assert_eq!(body["error"]["details"]["credential"], "password");
    let after: String = sqlx::query_scalar("SELECT password_phc FROM office_users WHERE id = ?")
        .bind(&tech_id)
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(after, phc);
    assert_eq!(host_revision(&app).await, before);
    let me = app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &key,
            &token,
        )))
        .await;
    assert_eq!(me.0, StatusCode::OK);
    assert_eq!(
        password_audit(&app, "denied").await,
        vec![(
            "office_user".into(),
            Some(tech_id.clone()),
            "office_user.password".into(),
            Some("office_user".into()),
            Some(tech_id),
            "denied".into(),
            r#"{"reason":"wrong_current_password"}"#.into()
        )]
    );
}

#[tokio::test]
async fn the_new_password_is_validated() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "office").await;
    seed_office_user(&app, "tech", "technologist", "correct horse battery").await;
    let token = login(&app, &key, "tech", "correct horse battery").await;
    let (status, body) = app
        .send(json_request(
            with_session(request("PUT", "/v1/office/me/password"), &key, &token),
            change("correct horse battery", "short"),
        ))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["details"]["field"], "newPassword");
    let (status, body) = app
        .send(json_request(
            with_session(request("PUT", "/v1/office/me/password"), &key, &token),
            json!({ "currentPassword": "correct horse battery", "newPassword": "another long password", "extra": 1 }),
        ))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "validation_failed");
}

#[tokio::test]
async fn changing_a_password_needs_an_office_session() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "office").await;
    let (status, body) = app
        .send(json_request(
            with_device(request("PUT", "/v1/office/me/password"), &key),
            change("correct horse battery", "another long password"),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["details"]["credential"], "session");
}

#[tokio::test]
async fn password_change_attempts_are_rate_limited_and_shared_with_login() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "office").await;
    seed_office_user(&app, "tech", "technologist", "correct horse battery").await;
    let token = login(&app, &key, "tech", "correct horse battery").await;
    let attempt = |peer: ([u8; 4], u16)| {
        let app = &app;
        let key = key.clone();
        let token = token.clone();
        async move {
            app.send_from(
                peer,
                json_request(
                    with_session(request("PUT", "/v1/office/me/password"), &key, &token),
                    change("not the password", "another long password"),
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

    // The limiter is shared with login: the same address is also blocked there.
    let (status, body) = app
        .send_from(
            LAN,
            json_request(
                with_device(request("POST", "/v1/office/login"), &key),
                json!({ "login": "tech", "password": "correct horse battery" }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["error"]["code"], "rate_limited");

    // The limit is per address: loopback is unaffected.
    let (status, body) = attempt(LOOPBACK).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["details"]["credential"], "password");

    app.clock.advance(time::Duration::seconds(61));
    assert_eq!(attempt(LAN).await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn me_is_denied_and_the_session_is_deleted_when_the_user_is_deactivated() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "office").await;
    let user_id = seed_office_user(&app, "irina", "admin", "correct horse battery").await;
    let token = login(&app, &key, "irina", "correct horse battery").await;

    sqlx::query("UPDATE office_users SET active = 0 WHERE id = ?")
        .bind(&user_id)
        .execute(&app.state.pool)
        .await
        .unwrap();

    let (status, _) = app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &key,
            &token,
        )))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let remaining: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM office_sessions WHERE token_hash = ?")
            .bind(key_hash(&token))
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(remaining, 0, "a deactivated user's session is deleted");
}
