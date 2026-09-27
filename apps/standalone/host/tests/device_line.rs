mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    bootstrap, empty, json as json_request, login, pair_device, request, seed_office_user,
    with_device, with_session, TestApp,
};

async fn line_ids(app: &TestApp) -> Vec<String> {
    sqlx::query_scalar("SELECT id FROM lines ORDER BY name")
        .fetch_all(&app.state.pool)
        .await
        .unwrap()
}

async fn select(app: &TestApp, key: &str, body: Value) -> (StatusCode, Value) {
    app.send(json_request(
        with_device(request("PUT", "/v1/device/line"), key),
        body,
    ))
    .await
}

type AuditRow = (
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    String,
    Value,
);

async fn line_audit(app: &TestApp) -> Vec<AuditRow> {
    let rows: Vec<(
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
    )> = sqlx::query_as(
        "SELECT actor_kind, actor_id, action, target_type, target_id, result, details \
             FROM audit_log WHERE action = 'device.line' ORDER BY id",
    )
    .fetch_all(&app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(
            |(kind, id, action, target_type, target_id, result, details)| {
                (
                    kind,
                    id,
                    action,
                    target_type,
                    target_id,
                    result,
                    serde_json::from_str(&details).unwrap(),
                )
            },
        )
        .collect()
}

async fn host_revision(app: &TestApp) -> i64 {
    sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
        .fetch_one(&app.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_station_chooses_an_active_line() {
    let app = TestApp::new().await;
    let (device_id, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let lines = line_ids(&app).await;
    let revision = host_revision(&app).await;

    let (status, body) = select(&app, &key, json!({ "lineId": lines[0] })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["id"], device_id);
    assert_eq!(body["lineId"], lines[0]);
    let (status, info) = app
        .send(empty(with_device(request("GET", "/v1/device"), &key)))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(info["lineId"], lines[0]);
    assert_eq!(
        host_revision(&app).await,
        revision,
        "devices are not in the change feed"
    );

    // The same line again changes nothing; another line is recorded with both values.
    assert_eq!(
        select(&app, &key, json!({ "lineId": lines[0] })).await.0,
        StatusCode::OK
    );
    assert_eq!(
        select(&app, &key, json!({ "lineId": lines[1] })).await.0,
        StatusCode::OK
    );
    let row = |from: Value, to: &str| -> AuditRow {
        (
            "device".into(),
            Some(device_id.clone()),
            "device.line".into(),
            Some("device".into()),
            Some(device_id.clone()),
            "ok".into(),
            json!({ "changed": ["lineId"], "lineId": { "from": from, "to": to } }),
        )
    };
    assert_eq!(
        line_audit(&app).await,
        vec![row(Value::Null, &lines[0]), row(json!(lines[0]), &lines[1])]
    );
}

#[tokio::test]
async fn only_an_existing_active_line_is_accepted() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    bootstrap(&app, &key).await;
    let lines = line_ids(&app).await;
    sqlx::query("UPDATE lines SET archived = 1 WHERE id = ?")
        .bind(&lines[1])
        .execute(&app.state.pool)
        .await
        .unwrap();

    for line_id in [
        lines[1].as_str(),
        "9b2e4a6c-0000-4000-8000-000000000000",
        "not-a-uuid",
    ] {
        let (status, body) = select(&app, &key, json!({ "lineId": line_id })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{line_id}");
        assert_eq!(body["error"]["code"], "validation_failed");
        assert_eq!(body["error"]["details"]["field"], "lineId");
    }
    let (status, body) = select(&app, &key, json!({ "lineId": lines[0], "extra": 1 })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["code"], "validation_failed");
    assert!(line_audit(&app).await.is_empty());
}

#[tokio::test]
async fn only_a_station_works_on_a_line() {
    let app = TestApp::new().await;
    let (_, station_key) = pair_device(&app, "station").await;
    bootstrap(&app, &station_key).await;
    let (_, office_key) = pair_device(&app, "office").await;
    let lines = line_ids(&app).await;

    let (status, _) = select(&app, &office_key, json!({ "lineId": lines[0] })).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = app
        .send(json_request(
            request("PUT", "/v1/device/line"),
            json!({ "lineId": lines[0] }),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["details"]["credential"], "device");
}

#[tokio::test]
async fn the_administrator_lists_paired_devices() {
    let app = TestApp::new().await;
    let (station_id, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;
    let lines = line_ids(&app).await;
    assert_eq!(
        select(&app, &key, json!({ "lineId": lines[0] })).await.0,
        StatusCode::OK
    );
    let (office_id, _) = pair_device(&app, "office").await;

    let (status, body) = app
        .send(empty(with_session(
            request("GET", "/v1/office/devices"),
            &key,
            &token,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let now = app.state.timestamp();
    assert_eq!(
        body,
        json!([
            {
                "id": station_id,
                "kind": "station",
                "name": "Тестовое устройство",
                "lineId": lines[0],
                "appVersion": "0.1.0",
                "pairedAt": now,
                "lastSeenAt": now,
                "revokedAt": null
            },
            {
                "id": office_id,
                "kind": "office",
                "name": "Тестовое устройство",
                "lineId": null,
                "appVersion": "0.1.0",
                "pairedAt": now,
                "lastSeenAt": now,
                "revokedAt": null
            }
        ])
        .as_array()
        .map(|devices| {
            // Same pairing time: the host orders by id then.
            let mut devices = devices.clone();
            devices.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
            Value::Array(devices)
        })
        .unwrap()
    );

    seed_office_user(&app, "tech", "technologist", "technologist password").await;
    let tech = login(&app, &key, "tech", "technologist password").await;
    let (status, _) = app
        .send(empty(with_session(
            request("GET", "/v1/office/devices"),
            &key,
            &tech,
        )))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}
