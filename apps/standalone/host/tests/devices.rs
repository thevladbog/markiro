mod support;

use std::time::Duration;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, code_hash, empty, host_revision, login, pair_device, request,
    seed_office_user, with_device, with_session, Admin,
};

async fn line_ids(admin: &Admin) -> Vec<String> {
    sqlx::query_scalar("SELECT id FROM lines ORDER BY name")
        .fetch_all(&admin.app.state.pool)
        .await
        .unwrap()
}

/// The office's record of one device.
async fn device(admin: &Admin, id: &str) -> Value {
    let (status, list) = admin.call("GET", "/v1/office/devices", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    list.as_array()
        .unwrap()
        .iter()
        .find(|device| device["id"] == id)
        .unwrap()
        .clone()
}

#[tokio::test]
async fn an_administrator_renames_a_device_and_sets_its_line() {
    let admin = admin().await;
    let (station, station_key) = pair_device(&admin.app, "station").await;
    let lines = line_ids(&admin).await;
    let path = format!("/v1/office/devices/{station}");
    let revision = host_revision(&admin.app).await;

    let (status, renamed) = admin
        .call("PUT", &path, Some(json!({ "name": " Станция упаковки " })))
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    assert_eq!(
        (renamed["name"].clone(), renamed["lineId"].clone()),
        (json!("Станция упаковки"), Value::Null)
    );
    let (status, assigned) = admin
        .call("PUT", &path, Some(json!({ "lineId": lines[0] })))
        .await;
    assert_eq!(
        (status, assigned["lineId"].clone()),
        (StatusCode::OK, json!(lines[0]))
    );
    // The station sees its line.
    let (_, info) = admin
        .app
        .send(empty(with_device(
            request("GET", "/v1/device"),
            &station_key,
        )))
        .await;
    assert_eq!(info["lineId"], json!(lines[0]));
    let (status, cleared) = admin
        .call("PUT", &path, Some(json!({ "lineId": null })))
        .await;
    assert_eq!(
        (status, cleared["lineId"].clone(), cleared["name"].clone()),
        (StatusCode::OK, Value::Null, json!("Станция упаковки"))
    );
    assert_eq!(cleared, device(&admin, &station).await);
    assert_eq!(
        host_revision(&admin.app).await,
        revision + 2,
        "assigning a line and clearing it each take a revision; the rename takes none"
    );
    assert_eq!(
        audit_trail(&admin.app, "device.update").await,
        vec![
            admin.row(
                "device.update",
                "device",
                &station,
                json!({ "changed": ["name"], "name": { "from": "Тестовое устройство", "to": "Станция упаковки" } })
            ),
            admin.row(
                "device.update",
                "device",
                &station,
                json!({ "changed": ["lineId"], "lineId": { "from": null, "to": lines[0] } })
            ),
            admin.row(
                "device.update",
                "device",
                &station,
                json!({ "changed": ["lineId"], "lineId": { "from": lines[0], "to": null } })
            ),
        ]
    );
    // Nothing to change: no row.
    let (status, same) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "name": "Станция упаковки", "lineId": null })),
        )
        .await;
    assert_eq!((status, same), (StatusCode::OK, cleared));
    assert_eq!(audit_trail(&admin.app, "device.update").await.len(), 3);
}

#[tokio::test]
async fn a_device_line_is_an_active_line_and_only_a_stations() {
    let admin = admin().await;
    let (station, _) = pair_device(&admin.app, "station").await;
    let (office, _) = pair_device(&admin.app, "office").await;
    let lines = line_ids(&admin).await;
    sqlx::query("UPDATE lines SET archived = 1 WHERE id = ?")
        .bind(&lines[1])
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    for (device, line) in [
        (&station, lines[1].as_str()),
        (&station, "9b2e4a6c-0000-4000-8000-000000000000"),
        (&office, lines[0].as_str()),
    ] {
        let (status, body) = admin
            .call(
                "PUT",
                &format!("/v1/office/devices/{device}"),
                Some(json!({ "lineId": line })),
            )
            .await;
        assert_eq!(
            (status, body["error"]["details"]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!("lineId")),
            "{device} {line}"
        );
    }
    // Clearing is always allowed; an office device has no line to clear.
    let (status, _) = admin
        .call(
            "PUT",
            &format!("/v1/office/devices/{office}"),
            Some(json!({ "lineId": null })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = admin
        .call(
            "PUT",
            &format!("/v1/office/devices/{station}"),
            Some(json!({ "name": " " })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("name"))
    );
    let (status, body) = admin
        .call(
            "PUT",
            &format!("/v1/office/devices/{station}"),
            Some(json!({ "kind": "office" })),
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed"))
    );
    assert!(audit_trail(&admin.app, "device.update").await.is_empty());
}

/// An office line assignment takes one host revision, so open streams wake
/// and the station can read `GET /v1/device` again, but it produces no feed
/// item: devices are not in the feed. A rename and a no-op take no revision.
#[tokio::test]
async fn a_line_change_takes_one_revision_and_wakes_the_streams_without_a_feed_item() {
    let admin = admin().await;
    let (station, station_key) = pair_device(&admin.app, "station").await;
    let lines = line_ids(&admin).await;
    let path = format!("/v1/office/devices/{station}");
    let mut wake = admin.app.state.revisions.subscribe();
    let start = host_revision(&admin.app).await;

    // A rename alone takes no revision and wakes nobody.
    let (status, _) = admin
        .call("PUT", &path, Some(json!({ "name": "Станция упаковки" })))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(host_revision(&admin.app).await, start);
    assert!(!wake.has_changed().unwrap());

    // A line assignment takes exactly one revision...
    let (status, _) = admin
        .call("PUT", &path, Some(json!({ "lineId": lines[0] })))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(host_revision(&admin.app).await, start + 1);
    // ...and wakes the streams with it...
    tokio::time::timeout(Duration::from_secs(5), wake.changed())
        .await
        .expect("the streams are woken by the line change")
        .unwrap();
    assert_eq!(*wake.borrow_and_update(), start + 1);
    // ...but the feed has no item for it: the station reads its device.
    let (status, feed) = admin
        .app
        .send(empty(with_device(
            request("GET", &format!("/v1/changes?since={start}")),
            &station_key,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{feed}");
    assert_eq!(
        feed,
        json!({ "hostId": admin.app.state.host_id, "rev": start + 1, "hasMore": false, "items": [] })
    );

    // The same line again changes nothing: no revision, no wake, no row.
    let (status, _) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "name": "Станция упаковки", "lineId": lines[0] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(host_revision(&admin.app).await, start + 1);
    assert!(!wake.has_changed().unwrap());
    assert_eq!(audit_trail(&admin.app, "device.update").await.len(), 2);

    // Another line, and a rename together with clearing the line, take one
    // revision each.
    let (status, _) = admin
        .call("PUT", &path, Some(json!({ "lineId": lines[1] })))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(host_revision(&admin.app).await, start + 2);
    let (status, cleared) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "name": "Резерв", "lineId": null })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert_eq!(host_revision(&admin.app).await, start + 3);
    assert_eq!(
        audit_trail(&admin.app, "device.update").await.last(),
        Some(&admin.row(
            "device.update",
            "device",
            &station,
            json!({
                "changed": ["name", "lineId"],
                "name": { "from": "Станция упаковки", "to": "Резерв" },
                "lineId": { "from": lines[1], "to": null }
            })
        ))
    );
}

/// A full-form save `{ name, lineId }` re-sends the station's current line.
/// Archiving a line leaves its stations on it, so that line may be archived by
/// now; re-sending it is «keep», not a refusal, and it takes no revision.
#[tokio::test]
async fn re_sending_a_stations_current_line_keeps_it_even_when_the_line_is_archived() {
    let admin = admin().await;
    let (station, _) = pair_device(&admin.app, "station").await;
    let lines = line_ids(&admin).await;
    let path = format!("/v1/office/devices/{station}");
    let (status, _) = admin
        .call("PUT", &path, Some(json!({ "lineId": lines[0] })))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, archived) = admin
        .call(
            "PUT",
            &format!("/v1/office/lines/{}", lines[0]),
            Some(json!({ "archived": true, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    let revision = host_revision(&admin.app).await;

    let (status, saved) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "name": "Станция упаковки", "lineId": lines[0] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(
        (saved["name"].clone(), saved["lineId"].clone()),
        (json!("Станция упаковки"), json!(lines[0]))
    );
    assert_eq!(saved, device(&admin, &station).await);
    assert_eq!(
        host_revision(&admin.app).await,
        revision,
        "keeping the line takes no revision"
    );
    let trail = audit_trail(&admin.app, "device.update").await;
    assert_eq!(trail.len(), 2, "the assignment and the rename");
    assert_eq!(
        trail[1],
        admin.row(
            "device.update",
            "device",
            &station,
            json!({ "changed": ["name"], "name": { "from": "Тестовое устройство", "to": "Станция упаковки" } })
        )
    );

    // Re-sending it alone changes nothing at all.
    let (status, body) = admin
        .call("PUT", &path, Some(json!({ "lineId": lines[0] })))
        .await;
    assert_eq!((status, body), (StatusCode::OK, saved));
    assert_eq!(audit_trail(&admin.app, "device.update").await.len(), 2);
    // Only the station's own line is «keep»: another archived line is refused.
    let other = admin
        .call(
            "PUT",
            &format!("/v1/office/lines/{}", lines[1]),
            Some(json!({ "archived": true, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(other.0, StatusCode::OK);
    let (status, body) = admin
        .call("PUT", &path, Some(json!({ "lineId": lines[1] })))
        .await;
    assert_eq!(
        (status, body["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("lineId"))
    );
}

/// A rename obeys the one control-character rule: a NUL first used to fail
/// the table's CHECK as a 500, and a tab inside was stored as sent.
#[tokio::test]
async fn a_device_name_with_a_control_character_is_refused_on_update() {
    let admin = admin().await;
    let (station, _) = pair_device(&admin.app, "station").await;
    let path = format!("/v1/office/devices/{station}");
    let before = device(&admin, &station).await;
    let revision = host_revision(&admin.app).await;
    for name in ["\u{0}Станция", "Стан\tция", "Станция\u{0}"] {
        let (status, body) = admin
            .call("PUT", &path, Some(json!({ "name": name })))
            .await;
        assert_eq!(
            (
                status,
                body["error"]["code"].clone(),
                body["error"]["details"]["field"].clone()
            ),
            (
                StatusCode::BAD_REQUEST,
                json!("validation_failed"),
                json!("name")
            ),
            "{name:?}"
        );
    }
    assert_eq!(device(&admin, &station).await, before);
    assert_eq!(host_revision(&admin.app).await, revision);
    assert!(audit_trail(&admin.app, "device.update").await.is_empty());
}

#[tokio::test]
async fn revoking_a_device_refuses_its_key_and_ends_its_office_sessions() {
    let admin = admin().await;
    let (office, office_key) = pair_device(&admin.app, "office").await;
    seed_office_user(&admin.app, "tech", "technologist", "technologist password").await;
    let tech_on_office = login(&admin.app, &office_key, "tech", "technologist password").await;
    let tech_on_station = login(&admin.app, &admin.key, "tech", "technologist password").await;

    let (status, revoked) = admin
        .call("POST", &format!("/v1/office/devices/{office}/revoke"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{revoked}");
    assert_eq!(revoked["revokedAt"], json!(admin.app.state.timestamp()));
    // A revoked device stays listed.
    assert_eq!(device(&admin, &office).await, revoked);
    // Its key is refused at once, the office session on it included...
    for path in ["/v1/device", "/v1/changes", "/v1/changes/stream"] {
        let (status, body) = admin
            .app
            .send(empty(with_device(request("GET", path), &office_key)))
            .await;
        assert_eq!(
            (status, body["error"]["details"]["credential"].clone()),
            (StatusCode::UNAUTHORIZED, json!("device")),
            "{path}"
        );
    }
    let (status, _) = admin
        .app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &office_key,
            &tech_on_office,
        )))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // ...its sessions are gone, and a session on another device stays.
    let sessions: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM office_sessions WHERE device_id = ?")
            .bind(&office)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(sessions, 0);
    let (status, _) = admin
        .app
        .send(empty(with_session(
            request("GET", "/v1/office/me"),
            &admin.key,
            &tech_on_station,
        )))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        audit_trail(&admin.app, "device.revoke").await,
        vec![admin.row(
            "device.revoke",
            "device",
            &office,
            json!({ "kind": "office", "name": "Тестовое устройство" })
        )]
    );

    // Revoking it again, later, changes nothing: not the record, and above
    // all not `revokedAt`, which a rewrite would move to the new time. The
    // clock moves first, so a rewritten time shows.
    admin.app.clock.advance(time::Duration::minutes(5));
    let (status, again) = admin
        .call("POST", &format!("/v1/office/devices/{office}/revoke"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again["revokedAt"], revoked["revokedAt"]);
    assert_eq!(again, revoked);
    assert_eq!(device(&admin, &office).await, revoked);
    assert_eq!(audit_trail(&admin.app, "device.revoke").await.len(), 1);
}

#[tokio::test]
async fn an_administrator_may_revoke_the_device_they_use() {
    let admin = admin().await;
    let own: String = sqlx::query_scalar("SELECT device_id FROM office_sessions WHERE user_id = ?")
        .bind(&admin.id)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, revoked) = admin
        .call("POST", &format!("/v1/office/devices/{own}/revoke"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{revoked}");
    let (status, body) = admin.call("GET", "/v1/office/me", None).await;
    assert_eq!(
        (status, body["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("device"))
    );
}

#[tokio::test]
async fn technologists_cannot_manage_devices() {
    let admin = admin().await;
    let (station, _) = pair_device(&admin.app, "station").await;
    let tech = admin.technologist().await;
    let (status, _) = admin
        .call_as(
            &tech,
            "PUT",
            &format!("/v1/office/devices/{station}"),
            Some(json!({ "name": "Станция" })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = admin
        .call_as(
            &tech,
            "POST",
            &format!("/v1/office/devices/{station}/revoke"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(device(&admin, &station).await["revokedAt"], Value::Null);
    assert!(audit_trail(&admin.app, "device.update").await.is_empty());
    assert!(audit_trail(&admin.app, "device.revoke").await.is_empty());
}

#[tokio::test]
async fn an_unknown_device_is_not_found_once_the_body_is_valid() {
    let admin = admin().await;
    let path = "/v1/office/devices/9b2e4a6c-0000-4000-8000-000000000000";
    let (status, body) = admin.call("PUT", path, Some(json!({ "name": " " }))).await;
    assert_eq!(
        (status, body["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("name"))
    );
    let (status, body) = admin
        .call("PUT", path, Some(json!({ "name": "Станция" })))
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    let (status, body) = admin.call("POST", &format!("{path}/revoke"), None).await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
}

/// The office reads a device's protocol and when its version was last
/// reported (plan ОБН-1): a device paired now spoke protocol 3 at pairing
/// and has reported nothing since.
#[tokio::test]
async fn the_office_reads_a_devices_protocol_and_when_its_version_was_seen() {
    let admin = admin().await;
    let (station, _) = pair_device(&admin.app, "station").await;
    let record = device(&admin, &station).await;
    assert_eq!(
        (
            record["appVersion"].clone(),
            record["protocol"].clone(),
            record["versionSeenAt"].clone()
        ),
        (
            json!("0.1.0"),
            json!(markiro_proto::PROTOCOL_VERSION),
            Value::Null
        )
    );
}

/// `0031` adds `version_seen_at` to the devices a host already has: each
/// keeps its row, and the column stays empty until the device reports.
#[tokio::test]
async fn migration_0031_keeps_every_device_and_adds_an_empty_version_seen_at() {
    use sqlx::migrate::Migrator;
    use sqlx::{Connection, SqliteConnection};

    let before = Migrator {
        migrations: markiro_host::db::MIGRATOR
            .iter()
            .filter(|migration| migration.version != 31)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    };
    assert_eq!(
        before.iter().count() + 1,
        markiro_host::db::MIGRATOR.iter().count()
    );
    let mut old = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    before.run(&mut old).await.unwrap();
    sqlx::query(
        "INSERT INTO devices (id, kind, name, key_hash, app_version, protocol, paired_at) \
         VALUES ('d1', 'station', 'Станция', 'hash-1', '0.1.0', 2, '2026-10-01T08:00:00Z')",
    )
    .execute(&mut old)
    .await
    .unwrap();

    markiro_host::db::MIGRATOR.run(&mut old).await.unwrap();

    let row: (String, String, i64, Option<String>) =
        sqlx::query_as("SELECT id, app_version, protocol, version_seen_at FROM devices")
            .fetch_one(&mut old)
            .await
            .unwrap();
    assert_eq!(row, ("d1".to_owned(), "0.1.0".to_owned(), 2, None));
}

/// `GET /v1/device` with `key`, naming `version` in the app's header when
/// given (plan ОБН-1).
async fn ask_device(admin: &Admin, key: &str, version: Option<&str>) -> StatusCode {
    let mut builder = with_device(request("GET", "/v1/device"), key);
    if let Some(version) = version {
        builder = builder.header(markiro_proto::APP_VERSION_HEADER, version);
    }
    admin.app.send(empty(builder)).await.0
}

/// A device's version, protocol and when they were seen, as the office reads
/// them.
async fn version_of(admin: &Admin, id: &str) -> (Value, Value, Value) {
    let record = device(admin, id).await;
    (
        record["appVersion"].clone(),
        record["protocol"].clone(),
        record["versionSeenAt"].clone(),
    )
}

/// Every device request records the version the app names, once it changes
/// (plan ОБН-1, spec §10.11.7): no revision, no audit row, a request without
/// the header or with a version that is no plain text changes nothing, and
/// the code check, which writes nothing, does not record it either.
#[tokio::test]
async fn a_device_request_records_the_version_the_app_names_once_it_changes() {
    let admin = admin().await;
    let (station, key) = pair_device(&admin.app, "station").await;
    let protocol = json!(markiro_proto::PROTOCOL_VERSION);
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;

    let first = admin.app.state.timestamp();
    assert_eq!(
        ask_device(&admin, &key, Some("0.2.0")).await,
        StatusCode::OK
    );
    assert_eq!(
        version_of(&admin, &station).await,
        (json!("0.2.0"), protocol.clone(), json!(first))
    );
    // The same version later: nothing is written, the time stays the first.
    admin.app.clock.advance(time::Duration::minutes(5));
    assert_eq!(
        ask_device(&admin, &key, Some("0.2.0")).await,
        StatusCode::OK
    );
    assert_eq!(ask_device(&admin, &key, None).await, StatusCode::OK);
    let long = "9".repeat(51);
    assert_eq!(ask_device(&admin, &key, Some(&long)).await, StatusCode::OK);
    assert_eq!(
        version_of(&admin, &station).await,
        (json!("0.2.0"), protocol.clone(), json!(first))
    );
    // The code check answers within 300 ms and never writes.
    let (status, _) = admin
        .app
        .send(empty(
            with_device(
                request("GET", &format!("/v1/device/codes/{}", code_hash(1))),
                &key,
            )
            .header(markiro_proto::APP_VERSION_HEADER, "0.4.0"),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        version_of(&admin, &station).await,
        (json!("0.2.0"), protocol.clone(), json!(first))
    );
    // A new version: recorded with the time it was first heard.
    let second = admin.app.state.timestamp();
    assert_eq!(
        ask_device(&admin, &key, Some("0.3.0-beta.1")).await,
        StatusCode::OK
    );
    assert_eq!(
        version_of(&admin, &station).await,
        (json!("0.3.0-beta.1"), protocol.clone(), json!(second))
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

/// An office request records the version of the device it comes from: the
/// office session rides on the device's key (`OfficeContext`).
#[tokio::test]
async fn an_office_request_records_the_version_of_its_device() {
    let admin = admin().await;
    let (status, _) = admin
        .app
        .send(empty(
            with_session(request("GET", "/v1/office/me"), &admin.key, &admin.token)
                .header(markiro_proto::APP_VERSION_HEADER, "0.5.0"),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    let own: String = sqlx::query_scalar("SELECT id FROM devices WHERE key_hash = ?")
        .bind(markiro_host::secrets::key_hash(&admin.key))
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(
        version_of(&admin, &own).await,
        (
            json!("0.5.0"),
            json!(markiro_proto::PROTOCOL_VERSION),
            json!(admin.app.state.timestamp())
        )
    );
}

/// `GET /v1/device` with `key`, naming `version` and speaking `protocol`.
async fn ask_device_speaking(admin: &Admin, key: &str, version: &str, protocol: u32) -> StatusCode {
    let builder = with_device(
        axum::http::Request::builder()
            .method("GET")
            .uri("/v1/device")
            .header(markiro_proto::PROTOCOL_HEADER, protocol.to_string()),
        key,
    )
    .header(markiro_proto::APP_VERSION_HEADER, version);
    admin.app.send(empty(builder)).await.0
}

/// The first report records its time even when it names the version the
/// device paired with, and a new protocol under the same version is a new
/// report (plan ОБН-1).
#[tokio::test]
async fn the_first_report_and_a_new_protocol_are_recorded() {
    let admin = admin().await;
    let (station, key) = pair_device(&admin.app, "station").await;
    let current = markiro_proto::PROTOCOL_VERSION;
    assert_eq!(version_of(&admin, &station).await.2, Value::Null);

    let first = admin.app.state.timestamp();
    assert_eq!(
        ask_device_speaking(&admin, &key, "0.1.0", current).await,
        StatusCode::OK
    );
    assert_eq!(
        version_of(&admin, &station).await,
        (json!("0.1.0"), json!(current), json!(first))
    );

    admin.app.clock.advance(time::Duration::minutes(5));
    let older = markiro_proto::MIN_PROTOCOL_VERSION;
    assert_ne!(older, current);
    let second = admin.app.state.timestamp();
    assert_eq!(
        ask_device_speaking(&admin, &key, "0.1.0", older).await,
        StatusCode::OK
    );
    assert_eq!(
        version_of(&admin, &station).await,
        (json!("0.1.0"), json!(older), json!(second))
    );
}

/// A device that names the version already stored takes no write lock for
/// it (plan ОБН-1): a working station asks while a writer holds the lock and
/// is answered at once, once its `last_seen_at` is not due. Deterministic:
/// the test clock is advanced and the lock is held.
#[tokio::test]
async fn a_device_naming_its_stored_version_does_not_wait_for_a_writer() {
    let admin = admin().await;
    let (_, key) = pair_device(&admin.app, "station").await;
    assert_eq!(
        ask_device(&admin, &key, Some("0.2.0")).await,
        StatusCode::OK
    );
    admin.app.clock.advance(time::Duration::seconds(30));
    let holder = markiro_host::db::begin_write(&admin.app.state.pool)
        .await
        .unwrap();
    let status = tokio::time::timeout(
        Duration::from_secs(1),
        ask_device(&admin, &key, Some("0.2.0")),
    )
    .await
    .expect("the request waited for the writer");
    holder.commit().await.unwrap();
    assert_eq!(status, StatusCode::OK);
}
