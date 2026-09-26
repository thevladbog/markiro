mod support;

use axum::http::StatusCode;
use markiro_host::secrets::key_hash;
use serde_json::{json, Value};
use support::app::{empty, json as json_request, pair_device, request, with_device, TestApp, LAN};

async fn audit_rows(
    app: &TestApp,
) -> Vec<(
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
)> {
    sqlx::query_as(
        "SELECT at, actor_kind, actor_id, action, target_type, target_id, result, details FROM audit_log ORDER BY id",
    )
    .fetch_all(&app.state.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn a_local_station_pairs_and_only_the_key_hash_is_stored() {
    let app = TestApp::new().await;
    let (status, body) = app
        .send(json_request(
            request("POST", "/v1/local-pair"),
            json!({ "kind": "station", "name": "  Станция 1  ", "appVersion": "0.1.0", "capabilities": ["a"] }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let id = body["deviceId"].as_str().unwrap();
    let key = body["deviceKey"].as_str().unwrap();
    assert_eq!(key.len(), 43);
    assert_eq!(body["hostId"], app.state.host_id);

    let (kind, name, stored_hash, capabilities, paired_at): (
        String,
        String,
        String,
        String,
        String,
    ) = sqlx::query_as(
        "SELECT kind, name, key_hash, capabilities, paired_at FROM devices WHERE id = ?",
    )
    .bind(id)
    .fetch_one(&app.state.pool)
    .await
    .unwrap();
    assert_eq!(kind, "station");
    assert_eq!(name, "Станция 1");
    assert_eq!(stored_hash, key_hash(key));
    assert_eq!(capabilities, r#"["a"]"#);
    assert_eq!(paired_at, app.state.timestamp());

    let rows = audit_rows(&app).await;
    assert_eq!(rows.len(), 1);
    let (at, actor_kind, actor_id, action, target_type, target_id, result, details) = &rows[0];
    assert_eq!(at, &app.state.timestamp());
    assert_eq!(actor_kind, "device");
    assert_eq!(actor_id.as_deref(), Some(id));
    assert_eq!(action, "device.local_pair");
    assert_eq!(target_type.as_deref(), Some("device"));
    assert_eq!(target_id.as_deref(), Some(id));
    assert_eq!(result, "ok");
    assert_eq!(
        serde_json::from_str::<Value>(details).unwrap(),
        json!({ "kind": "station", "name": "Станция 1" })
    );
}

#[tokio::test]
async fn local_pairing_from_the_network_is_refused() {
    let app = TestApp::new().await;
    let (status, body) = app
        .send_from(
            LAN,
            json_request(
                request("POST", "/v1/local-pair"),
                json!({ "kind": "station", "name": "Чужая", "appVersion": "0.1.0" }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "loopback_only");
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM devices")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn invalid_local_pair_requests_are_validation_errors() {
    let app = TestApp::new().await;
    let cases = [
        (
            json!({ "kind": "handheld", "name": "ТСД", "appVersion": "0.1.0" }),
            Some("kind"),
        ),
        (
            json!({ "kind": "station", "name": "   ", "appVersion": "0.1.0" }),
            Some("name"),
        ),
        (
            json!({ "kind": "station", "name": "С", "appVersion": "" }),
            Some("appVersion"),
        ),
        (
            json!({ "kind": "station", "name": "С", "appVersion": "0.1.0", "extra": 1 }),
            None,
        ),
    ];
    for (body, field) in cases {
        let (status, response) = app
            .send(json_request(
                request("POST", "/v1/local-pair"),
                body.clone(),
            ))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(response["error"]["code"], "validation_failed", "{body}");
        match field {
            Some(field) => assert_eq!(response["error"]["details"]["field"], field),
            None => assert!(response["error"]["details"].is_null()),
        }
    }
}

#[tokio::test]
async fn protected_routes_require_the_protocol_header() {
    let app = TestApp::new().await;
    let request = axum::http::Request::post("/v1/local-pair")
        .header("content-type", "application/json")
        .body(axum::body::Body::from(
            json!({ "kind": "station", "name": "С", "appVersion": "0.1.0" }).to_string(),
        ))
        .unwrap();
    let (status, body) = app.send(request).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "protocol_unsupported");
}

#[tokio::test]
async fn a_device_reads_itself_with_its_key_until_revoked() {
    let app = TestApp::new().await;
    let (id, key) = pair_device(&app, "office").await;

    app.clock.advance(time::Duration::minutes(5));
    let (status, body) = app
        .send(empty(with_device(request("GET", "/v1/device"), &key)))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["id"], id);
    assert_eq!(body["kind"], "office");
    assert_eq!(body["lineId"], Value::Null);
    let last_seen: String = sqlx::query_scalar("SELECT last_seen_at FROM devices WHERE id = ?")
        .bind(&id)
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(last_seen, app.state.timestamp());

    let (status, body) = app
        .send(empty(with_device(request("GET", "/v1/device"), "wrong")))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["code"], "unauthorized");
    assert_eq!(body["error"]["details"]["credential"], "device");

    sqlx::query("UPDATE devices SET revoked_at = ? WHERE id = ?")
        .bind(app.state.timestamp())
        .bind(&id)
        .execute(&app.state.pool)
        .await
        .unwrap();
    let (status, body) = app
        .send(empty(with_device(request("GET", "/v1/device"), &key)))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["details"]["credential"], "device");
    let (status, body) = app.send(empty(request("GET", "/v1/device"))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["details"]["credential"], "device");
}
