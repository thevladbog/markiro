//! What devices and the office read about the update (plan ОБН-3, spec
//! §10.11.3, §10.11.7). `GET /v1/device/update` answers any protocol version
//! (and none), outside the protocol guard, but only a live device key; a
//! restore's hold does not hold it. `GET /v1/office/update-status` gives
//! every office role the versions of the devices against the host.

mod support;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use support::app::{admin, empty, pair_device, request, with_device, Admin, TestApp};
use support::update::{flip_byte, installer_name, sha256_hex, write_package};

/// `GET /v1/device/update` with `key` and the protocol header `protocol`
/// (none at all for `None`).
async fn offer(app: &TestApp, key: &str, protocol: Option<&str>) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method("GET")
        .uri("/v1/device/update")
        .header("authorization", format!("Bearer {key}"));
    if let Some(protocol) = protocol {
        builder = builder.header(markiro_proto::PROTOCOL_HEADER, protocol);
    }
    app.send(builder.body(Body::empty()).unwrap()).await
}

/// A host of `host` with a current package of `current`, if any.
async fn host_with(current: Option<&str>, host: &str) -> Admin {
    let mut admin = admin().await;
    if let Some(version) = current {
        write_package(&admin.app.dir().join("updates"), "current", version);
    }
    admin.app.keep_updates(host);
    admin
}

#[tokio::test]
async fn a_device_reads_the_current_package_of_the_hosts_version() {
    let mut admin = admin().await;
    let (manifest, bytes) = write_package(&admin.app.dir().join("updates"), "current", "0.3.0");
    admin.app.keep_updates("0.3.0");
    let (status, body) = offer(&admin.app, &admin.key, Some("3")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        json!({
            "hostVersion": "0.3.0",
            "package": {
                "state": "ok", "manifest": manifest, "version": "0.3.0",
                "sizeBytes": bytes.len(), "sha256": sha256_hex(&bytes)
            }
        })
    );
}

#[tokio::test]
async fn each_state_of_the_package_is_told_and_only_ok_carries_the_manifest() {
    for (current, host, state) in [
        (None, "0.3.0", "missing"),
        (Some("0.2.0"), "0.3.0", "mismatch"),
    ] {
        let admin = host_with(current, host).await;
        let (_, body) = offer(&admin.app, &admin.key, Some("3")).await;
        assert_eq!(
            body,
            json!({ "hostVersion": host, "package": { "state": state } }),
            "{state}"
        );
    }
    let mut admin = admin().await;
    let updates = admin.app.dir().join("updates");
    write_package(&updates, "current", "0.3.0");
    flip_byte(&updates.join("current").join(installer_name("0.3.0")), 10);
    admin.app.keep_updates("0.3.0");
    let (_, body) = offer(&admin.app, &admin.key, Some("3")).await;
    assert_eq!(body["package"], json!({ "state": "invalid" }));

    // A file changed after the check: `verifying` at once, then the result.
    let admin = host_with(Some("0.3.0"), "0.3.0").await;
    let updates = admin.app.dir().join("updates");
    flip_byte(&updates.join("current").join(installer_name("0.3.0")), 10);
    let (_, body) = offer(&admin.app, &admin.key, Some("3")).await;
    assert_eq!(body["package"], json!({ "state": "verifying" }));
    let mut state = Value::Null;
    for _ in 0..200 {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        // Past the 30 requests a minute of task 6.
        admin.app.clock.advance(time::Duration::seconds(3));
        state = offer(&admin.app, &admin.key, Some("3")).await.1["package"]["state"].clone();
        if state != json!("verifying") {
            break;
        }
    }
    assert_eq!(state, json!("invalid"));
}

#[tokio::test]
async fn the_offer_answers_any_protocol_but_only_a_live_device_key() {
    let admin = host_with(Some("0.3.0"), "0.3.0").await;
    for protocol in [Some("1"), Some("7"), Some("abc"), None] {
        let (status, body) = offer(&admin.app, &admin.key, protocol).await;
        assert_eq!(
            (status, &body["package"]["state"]),
            (StatusCode::OK, &json!("ok")),
            "{protocol:?}"
        );
    }
    // Every other device route still refuses an unknown protocol.
    let (status, body) = admin
        .app
        .send(empty(
            Request::builder()
                .method("GET")
                .uri("/v1/device")
                .header(markiro_proto::PROTOCOL_HEADER, "7")
                .header("authorization", format!("Bearer {}", admin.key)),
        ))
        .await;
    assert_eq!(
        (status, &body["error"]["code"]),
        (StatusCode::BAD_REQUEST, &json!("protocol_unsupported"))
    );
    // No key, an office session without a key, a revoked key: 401 on the device.
    let (status, body) = admin
        .app
        .send(empty(request("GET", "/v1/device/update")))
        .await;
    assert_eq!(
        (status, &body["error"]["details"]),
        (StatusCode::UNAUTHORIZED, &json!({ "credential": "device" }))
    );
    let (status, _) = admin
        .app
        .send(empty(
            request("GET", "/v1/device/update")
                .header(markiro_proto::OFFICE_SESSION_HEADER, &admin.token),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (station, key) = pair_device(&admin.app, "station").await;
    let (status, _) = admin
        .call(
            "POST",
            &format!("/v1/office/devices/{station}/revoke"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = offer(&admin.app, &key, Some("3")).await;
    assert_eq!(
        (status, &body["error"]["details"]),
        (StatusCode::UNAUTHORIZED, &json!({ "credential": "device" }))
    );
}

#[tokio::test]
async fn a_read_outside_the_guard_still_records_the_devices_version() {
    // Plan ОБН-1 (its Д8) records the version on every writing `AuthDevice`
    // and reads the protocol from the header outside the guard (spec §10.11.7).
    let admin = host_with(Some("0.3.0"), "0.3.0").await;
    let (_, me) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), &admin.key)))
        .await;
    let id = me["id"].as_str().unwrap().to_owned();
    let (status, _) = admin
        .app
        .send(empty(
            Request::builder()
                .method("GET")
                .uri("/v1/device/update")
                .header("authorization", format!("Bearer {}", admin.key))
                .header(markiro_proto::PROTOCOL_HEADER, "2")
                .header(markiro_proto::APP_VERSION_HEADER, "0.2.5"),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    let row: (String, i64, bool) = sqlx::query_as(
        "SELECT app_version, protocol, version_seen_at IS NOT NULL FROM devices WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(row, ("0.2.5".to_owned(), 2, true));
}

#[tokio::test]
async fn a_restore_hold_does_not_hold_the_update() {
    let admin = host_with(Some("0.3.0"), "0.3.0").await;
    sqlx::query("UPDATE site SET facts_held_since = '2026-11-03T06:00:00Z' WHERE id = 1")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, body) = offer(&admin.app, &admin.key, Some("3")).await;
    assert_eq!(
        (status, &body["package"]["state"]),
        (StatusCode::OK, &json!("ok"))
    );
}

#[tokio::test]
async fn a_host_that_keeps_no_packages_offers_nothing() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let (status, body) = offer(&app, &key, Some("3")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({ "hostVersion": markiro_host::HOST_VERSION, "package": { "state": "missing" } })
    );
}

/// Set what the host knows of a device's version, as plan ОБН-1 records it.
async fn version_of(admin: &Admin, id: &str, version: &str, protocol: i64, seen: Option<&str>) {
    sqlx::query(
        "UPDATE devices SET app_version = ?, protocol = ?, version_seen_at = ? WHERE id = ?",
    )
    .bind(version)
    .bind(protocol)
    .bind(seen)
    .bind(id)
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

async fn audit_insert(
    admin: &Admin,
    action: &str,
    actor: (&str, &str),
    target: Option<&str>,
    at: &str,
    details: Value,
) {
    sqlx::query(
        "INSERT INTO audit_log (at, actor_kind, actor_id, action, target_type, target_id, result, details) \
         VALUES (?, ?, ?, ?, ?, ?, 'ok', ?)",
    )
    .bind(at)
    .bind(actor.0)
    .bind(actor.1)
    .bind(action)
    .bind(target.map(|_| "device"))
    .bind(target)
    .bind(details.to_string())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn the_office_reads_every_devices_version_against_the_host() {
    let admin = host_with(Some("0.3.0"), "0.3.0").await;
    let (_, me) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), &admin.key)))
        .await;
    let here = me["id"].as_str().unwrap().to_owned();
    let (behind, _) = pair_device(&admin.app, "station").await;
    // A handheld pairs by a code; the test needs only its kind, so a station is re-kinded.
    let (newer, _) = pair_device(&admin.app, "station").await;
    sqlx::query("UPDATE devices SET kind = 'handheld' WHERE id = ?")
        .bind(&newer)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (old, _) = pair_device(&admin.app, "station").await;
    let (unknown, _) = pair_device(&admin.app, "station").await;
    let (revoked, _) = pair_device(&admin.app, "station").await;
    admin
        .call(
            "POST",
            &format!("/v1/office/devices/{revoked}/revoke"),
            None,
        )
        .await;
    version_of(&admin, &here, "0.3.0", 3, Some("2026-11-03T07:10:00Z")).await;
    version_of(&admin, &behind, "0.2.1", 3, Some("2026-11-02T15:00:00Z")).await;
    version_of(&admin, &newer, "4.2.0", 3, Some("2026-11-03T08:00:00Z")).await;
    // Below the host's minimum protocol: it does not connect.
    version_of(&admin, &old, "0.0.9", 0, Some("2026-10-20T10:00:00Z")).await;
    sqlx::query(
        "UPDATE devices SET line_id = (SELECT id FROM lines WHERE name = 'Линия 1') WHERE id = ?",
    )
    .bind(&here)
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    audit_insert(
        &admin,
        "update.download",
        ("device", &behind),
        None,
        "2026-11-03T06:55:00Z",
        json!({ "version": "0.3.0", "sha256": "ab", "sizeBytes": 1 }),
    )
    .await;
    audit_insert(
        &admin,
        "app.update.start",
        ("office_user", &admin.id),
        Some(&behind),
        "2026-11-03T07:00:00Z",
        json!({ "deviceId": behind, "from": "0.2.1", "to": "0.3.0" }),
    )
    .await;
    // A row that names its device only in the details (Д14).
    audit_insert(
        &admin,
        "app.update.start",
        ("office_user", &admin.id),
        None,
        "2026-11-03T07:05:00Z",
        json!({ "deviceId": newer, "from": "0.3.0", "to": "0.4.0" }),
    )
    .await;

    let (status, body) = admin.call("GET", "/v1/office/update-status", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        (
            &body["hostVersion"],
            &body["protocol"],
            &body["minProtocol"]
        ),
        (
            &json!("0.3.0"),
            &json!(markiro_proto::PROTOCOL_VERSION),
            &json!(markiro_proto::MIN_PROTOCOL_VERSION)
        )
    );
    assert_eq!(
        (
            &body["package"]["state"],
            &body["package"]["version"],
            &body["package"]["staged"]
        ),
        (&json!("ok"), &json!("0.3.0"), &Value::Null)
    );
    assert!(body["package"]["diskBytes"].as_u64().unwrap() > 0);
    let device = |id: &str| -> Value {
        body["devices"]
            .as_array()
            .unwrap()
            .iter()
            .find(|device| device["id"] == id)
            .cloned()
            .unwrap_or(Value::Null)
    };
    assert_eq!(
        device(&revoked),
        Value::Null,
        "a revoked device is not listed"
    );
    assert_eq!(body["devices"].as_array().unwrap().len(), 5);
    assert_eq!(
        (&device(&here)["state"], &device(&here)["lineName"]),
        (&json!("compatible"), &json!("Линия 1"))
    );
    // Another app version, a protocol inside the window: no comparison, no state of its own.
    assert_eq!(device(&behind)["state"], json!("compatible"));
    assert_eq!(
        device(&behind)["downloaded"],
        json!({ "at": "2026-11-03T06:55:00Z", "version": "0.3.0" })
    );
    assert_eq!(
        device(&behind)["installStarted"],
        json!({ "at": "2026-11-03T07:00:00Z", "version": "0.3.0" })
    );
    // A handheld on its own version line (4.x against the host's 0.3.0) is just compatible.
    assert_eq!(device(&newer)["kind"], json!("handheld"));
    assert_eq!(device(&newer)["state"], json!("compatible"));
    assert_eq!(
        device(&newer)["installStarted"],
        json!({ "at": "2026-11-03T07:05:00Z", "version": "0.4.0" })
    );
    assert_eq!(device(&old)["state"], json!("incompatible"));
    assert_eq!(
        (
            &device(&unknown)["state"],
            &device(&unknown)["versionSeenAt"]
        ),
        (&json!("unknown"), &Value::Null)
    );
    assert_eq!(
        body["history"][0],
        json!({
            "at": "2026-11-03T07:05:00Z", "action": "app.update.start", "result": "ok",
            "actor": "Ирина Смирнова", "version": null, "from": "0.3.0", "to": "0.4.0"
        })
    );
    assert_eq!(body["history"][2]["action"], json!("update.download"));
    assert_eq!(body["history"][2]["actor"], json!("Тестовое устройство"));
}

#[tokio::test]
async fn the_technologist_reads_it_too_and_a_device_key_alone_does_not() {
    let admin = host_with(None, "0.3.0").await;
    let tech = admin.technologist().await;
    let (status, body) = admin
        .call_as(&tech, "GET", "/v1/office/update-status", None)
        .await;
    assert_eq!(
        (status, &body["package"]["state"]),
        (StatusCode::OK, &json!("missing"))
    );
    let (status, body) = admin
        .app
        .send(empty(with_device(
            request("GET", "/v1/office/update-status"),
            &admin.key,
        )))
        .await;
    assert_eq!(
        (status, &body["error"]["details"]),
        (
            StatusCode::UNAUTHORIZED,
            &json!({ "credential": "session" })
        )
    );
}
