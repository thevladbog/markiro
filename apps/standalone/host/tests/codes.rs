mod support;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use http_body_util::BodyExt;
use markiro_host::auth::{AskingDevice, AuthDevice};
use markiro_host::error::ApiPath;
use markiro_host::routes::codes::check_code;
use markiro_proto::DeviceKind;
use serde_json::{json, Value};
use support::app::{
    accepted, admin, audit_rows, box_id, code, code_hash, empty, fact, fact_rows, host_revision,
    instant, ok_scan, open_floor, pair_device, receipts, record_id, request, shift_setup,
    with_device, Admin,
};

/// `GET /v1/device/codes/{hash}` with `key`.
async fn check(admin: &Admin, key: &str, hash: &str) -> (StatusCode, Value) {
    admin
        .app
        .send(empty(with_device(
            request("GET", &format!("/v1/device/codes/{hash}")),
            key,
        )))
        .await
}

#[tokio::test]
async fn a_code_is_free_until_a_scan_owns_it_and_then_names_its_owner() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let (_, office_pc) = pair_device(&admin.app, "office").await;
    assert_eq!(
        check(&admin, &floor.key, &code_hash(1)).await,
        (StatusCode::OK, json!({ "status": "free" }))
    );
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(1),
                "scan",
                &floor.shift,
                ok_scan(1, &box_id(1), &instant(10, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(1))]
    );
    let owner = |same_device: bool| {
        json!({
            "status": "taken",
            "owner": {
                "shiftId": floor.shift, "shiftNumber": floor.number, "deviceId": floor.station,
                "scannedAt": instant(10, 0), "sameDevice": same_device
            }
        })
    };
    // The owner itself, another station and a device of another kind ask.
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let kept = fact_rows(&admin.app).await;
    assert_eq!(
        check(&admin, &floor.key, &code_hash(1)).await,
        (StatusCode::OK, owner(true))
    );
    assert_eq!(
        check(&admin, &colleague.key, &code_hash(1)).await,
        (StatusCode::OK, owner(false))
    );
    assert_eq!(
        check(&admin, &office_pc, &code_hash(1)).await,
        (StatusCode::OK, owner(false))
    );
    assert_eq!(
        check(&admin, &floor.key, &code_hash(2)).await,
        (StatusCode::OK, json!({ "status": "free" }))
    );
    // Asking writes nothing.
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(fact_rows(&admin.app).await, kept);
    // An earlier scan of the colleague takes the code: it names the
    // colleague now.
    assert_eq!(
        receipts(
            &admin.app,
            &colleague.key,
            &[fact(
                &record_id(2),
                "scan",
                &colleague.shift,
                ok_scan(1, &box_id(2), &instant(5, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(2))]
    );
    assert_eq!(
        check(&admin, &floor.key, &code_hash(1)).await,
        (
            StatusCode::OK,
            json!({
                "status": "taken",
                "owner": {
                    "shiftId": colleague.shift, "shiftNumber": colleague.number,
                    "deviceId": colleague.station, "scannedAt": instant(5, 0),
                    "sameDevice": false
                }
            })
        )
    );
}

#[tokio::test]
async fn only_a_code_hash_is_asked_for_and_only_by_a_device() {
    let admin = admin().await;
    for hash in [
        code_hash(1).to_uppercase().replace('0', "A"),
        "0".repeat(63),
        "0".repeat(65),
        format!("{}g", "0".repeat(63)),
        "OCT26-001".to_owned(),
    ] {
        let (status, refused) = check(&admin, &admin.key, &hash).await;
        assert_eq!(
            (
                status,
                refused["error"]["code"].clone(),
                refused["error"]["details"].clone()
            ),
            (
                StatusCode::BAD_REQUEST,
                json!("validation_failed"),
                json!({ "field": "codeHash" })
            ),
            "{hash}"
        );
    }
    let (status, refused) = admin
        .app
        .send(empty(request(
            "GET",
            &format!("/v1/device/codes/{}", code_hash(1)),
        )))
        .await;
    assert_eq!(
        (status, refused["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("device"))
    );
}

/// The check takes no write lock: it answers at once while a batch of facts
/// is being written, with what was committed before it.
#[tokio::test]
async fn a_check_never_waits_for_a_batch_being_written() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let station = floor.station.clone();
    let mut holder = markiro_host::db::begin_write(&admin.app.state.pool)
        .await
        .unwrap();
    let applied = markiro_host::facts::receive(
        &mut holder,
        &station,
        &fact(
            &record_id(1),
            "scan",
            &floor.shift,
            ok_scan(1, &box_id(1), &instant(1, 0)),
        ),
        &admin.app.state.timestamp(),
        &mut None,
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(applied).unwrap(),
        accepted(&record_id(1))
    );
    let answer = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        check_code(
            State(admin.app.state.clone()),
            AskingDevice(AuthDevice {
                id: station.clone(),
                kind: DeviceKind::Station,
            }),
            ApiPath(code_hash(1)),
        ),
    )
    .await
    .expect("the check waited for the writer")
    .unwrap()
    .into_response();
    let body: Value =
        serde_json::from_slice(&answer.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body, json!({ "status": "free" }));
    holder.commit().await.unwrap();
    assert_eq!(
        check(&admin, &floor.key, &code_hash(1)).await.1["status"],
        "taken"
    );
}

/// The device's `last_seen_at`, as the device authentication keeps it.
async fn last_seen(admin: &Admin, device: &str) -> Option<String> {
    sqlx::query_scalar("SELECT last_seen_at FROM devices WHERE id = ?")
        .bind(device)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

/// The same invariant through the router, which is what a station sees: the
/// device authentication in front of the handler must not take the write
/// lock either, so a device seen less than a minute ago is answered at once
/// while a writer holds the lock.
#[tokio::test]
async fn a_check_through_the_router_does_not_wait_for_a_writer_either() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    assert_eq!(
        last_seen(&admin, &floor.station).await,
        Some(admin.app.state.timestamp()),
        "the device was seen just now"
    );
    let holder = markiro_host::db::begin_write(&admin.app.state.pool)
        .await
        .unwrap();
    let answer = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        check(&admin, &floor.key, &code_hash(1)),
    )
    .await
    .expect("the check waited for the writer");
    holder.commit().await.unwrap();
    assert_eq!(answer, (StatusCode::OK, json!({ "status": "free" })));
}

/// The check never takes the write lock, whatever `last_seen_at` says: a
/// station that asked 30 s ago asks again when a full minute has passed
/// since its last touch (the other device routes would write `last_seen_at`
/// now) while a writer holds the lock. Deterministic: the test clock is
/// advanced and the lock is held.
#[tokio::test]
async fn a_check_after_the_touch_minute_does_not_wait_for_a_writer() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, office_pc) = pair_device(&admin.app, "office").await;
    let seen = last_seen(&admin, &floor.station).await.unwrap();
    admin.app.clock.advance(time::Duration::seconds(30));
    assert_eq!(
        check(&admin, &floor.key, &code_hash(1)).await,
        (StatusCode::OK, json!({ "status": "free" }))
    );
    admin.app.clock.advance(time::Duration::seconds(30));
    // A touch would be due now: the stored time is a full minute old.
    assert_eq!(last_seen(&admin, &floor.station).await.unwrap(), seen);
    let holder = markiro_host::db::begin_write(&admin.app.state.pool)
        .await
        .unwrap();
    for key in [&floor.key, &office_pc] {
        let answer = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            check(&admin, key, &code_hash(1)),
        )
        .await
        .expect("the check waited for the writer");
        assert_eq!(answer, (StatusCode::OK, json!({ "status": "free" })));
    }
    holder.commit().await.unwrap();
    // A revoked key is refused without a write too.
    let (status, done) = admin
        .call(
            "POST",
            &format!("/v1/office/devices/{}/revoke", floor.station),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{done}");
    let holder = markiro_host::db::begin_write(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, refused) = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        check(&admin, &floor.key, &code_hash(1)),
    )
    .await
    .expect("a refusal waited for the writer");
    holder.commit().await.unwrap();
    assert_eq!(
        (status, refused["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("device"))
    );
}

/// The sender's key decides who may ask, before the path is looked at: a
/// revoked or unknown key, no key and an older protocol are refused whatever
/// hash is asked for, and only `GET` is routed.
#[tokio::test]
async fn only_a_live_device_of_a_supported_protocol_may_ask() {
    let admin = admin().await;
    let (revoked, revoked_key) = pair_device(&admin.app, "station").await;
    let (_, fresh_key) = pair_device(&admin.app, "station").await;
    assert_eq!(
        check(&admin, &revoked_key, &code_hash(1)).await,
        (StatusCode::OK, json!({ "status": "free" }))
    );
    let (status, done) = admin
        .call(
            "POST",
            &format!("/v1/office/devices/{revoked}/revoke"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{done}");
    // A bad hash does not turn a refused key into a `validation_failed`.
    for (key, hash) in [
        (revoked_key.as_str(), code_hash(1)),
        (revoked_key.as_str(), "not-a-hash".to_owned()),
        ("no-such-key", code_hash(1)),
        ("no-such-key", "not-a-hash".to_owned()),
    ] {
        let (status, refused) = check(&admin, key, &hash).await;
        assert_eq!(
            (
                status,
                refused["error"]["code"].clone(),
                refused["error"]["details"].clone()
            ),
            (
                StatusCode::UNAUTHORIZED,
                json!("unauthorized"),
                json!({ "credential": "device" })
            ),
            "{key} {hash}"
        );
    }
    let (status, refused) = admin
        .app
        .send(empty(request("GET", "/v1/device/codes/not-a-hash")))
        .await;
    assert_eq!(
        (status, refused["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("device"))
    );
    // Another live device is not affected by the revocation.
    assert_eq!(
        check(&admin, &fresh_key, &code_hash(1)).await,
        (StatusCode::OK, json!({ "status": "free" }))
    );
    // No protocol header: the guard in front of every route answers.
    let (status, refused) = admin
        .app
        .send(empty(
            axum::http::Request::builder()
                .method("GET")
                .uri(format!("/v1/device/codes/{}", code_hash(1)))
                .header("authorization", format!("Bearer {fresh_key}")),
        ))
        .await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("protocol_unsupported"))
    );
    // Asking is a read: nothing else is routed on the path.
    for method in ["POST", "PUT", "DELETE"] {
        let (status, refused) = admin
            .app
            .send(empty(with_device(
                request(method, &format!("/v1/device/codes/{}", code_hash(1))),
                &fresh_key,
            )))
            .await;
        assert_eq!(
            (status, refused["error"]["code"].clone()),
            (StatusCode::METHOD_NOT_ALLOWED, json!("method_not_allowed")),
            "{method}"
        );
    }
}

/// Only an accepted scan owns a code: a duplicate, a wrong GTIN and an
/// unreadable scan are journal rows, and a scan that lost the code to an
/// earlier one changes nothing about its owner. The owner a check names is
/// the winner a `conflict` receipt names, for the same asker.
#[tokio::test]
async fn only_an_accepted_scan_owns_a_code_and_the_check_names_the_winner() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let mut wrong_gtin = code(4);
    wrong_gtin["gtin14"] = json!("04600682000020");
    let other = |verdict: &str, raw_kind: &str, code: Value, source: Value, at: &str| {
        json!({
            "scannedAt": at, "verdict": verdict, "duplicateSource": source, "rawKind": raw_kind,
            "rawLength": 14, "code": code, "boxId": null
        })
    };
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[
                fact(
                    &record_id(1),
                    "scan",
                    &floor.shift,
                    other("duplicate", "km", code(3), json!("host"), &instant(1, 0))
                ),
                fact(
                    &record_id(2),
                    "scan",
                    &floor.shift,
                    other("wrong_gtin", "km", wrong_gtin, Value::Null, &instant(2, 0))
                ),
                fact(
                    &record_id(3),
                    "scan",
                    &floor.shift,
                    other(
                        "invalid",
                        "unknown",
                        Value::Null,
                        Value::Null,
                        &instant(3, 0)
                    )
                ),
                fact(
                    &record_id(4),
                    "scan",
                    &floor.shift,
                    ok_scan(5, &box_id(1), &instant(10, 0))
                ),
            ]
        )
        .await,
        vec![
            accepted(&record_id(1)),
            accepted(&record_id(2)),
            accepted(&record_id(3)),
            accepted(&record_id(4))
        ]
    );
    for n in [3, 4] {
        assert_eq!(
            check(&admin, &floor.key, &code_hash(n)).await,
            (StatusCode::OK, json!({ "status": "free" })),
            "code {n}"
        );
    }
    // The colleague scans the owned code later: a conflict, and the check
    // answers with what the receipt named.
    let lost = receipts(
        &admin.app,
        &colleague.key,
        &[fact(
            &record_id(5),
            "scan",
            &colleague.shift,
            ok_scan(5, &box_id(2), &instant(20, 0)),
        )],
    )
    .await;
    assert_eq!(lost[0]["outcome"], "conflict", "{lost:?}");
    let winner = lost[0]["details"]["winner"].clone();
    assert_eq!(
        winner,
        json!({
            "shiftId": floor.shift, "shiftNumber": floor.number, "deviceId": floor.station,
            "scannedAt": instant(10, 0), "sameDevice": false
        })
    );
    assert_eq!(
        check(&admin, &colleague.key, &code_hash(5)).await,
        (
            StatusCode::OK,
            json!({ "status": "taken", "owner": winner })
        )
    );
    let mut own = winner.clone();
    own["sameDevice"] = json!(true);
    assert_eq!(
        check(&admin, &floor.key, &code_hash(5)).await,
        (StatusCode::OK, json!({ "status": "taken", "owner": own }))
    );
}

/// A check never writes `last_seen_at`, a stale time or none at all; any
/// other device route still writes it once a minute and not before (a read
/// of the device itself, `GET /v1/device`, stands for them).
#[tokio::test]
async fn a_check_never_moves_last_seen_and_another_device_route_does_once_a_minute() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let touch = |key: String| {
        let admin = &admin;
        async move {
            admin
                .app
                .send(empty(with_device(request("GET", "/v1/device"), &key)))
                .await
                .0
        }
    };
    let seen = last_seen(&admin, &floor.station).await.unwrap();
    assert_eq!(seen, admin.app.state.timestamp());
    // A check at +60 s (a touch would be due) leaves the stored time alone.
    admin.app.clock.advance(time::Duration::seconds(60));
    assert_eq!(
        check(&admin, &floor.key, &code_hash(1)).await.0,
        StatusCode::OK
    );
    assert_eq!(last_seen(&admin, &floor.station).await.unwrap(), seen);
    // A device never seen (no time stored) stays unseen after a check.
    sqlx::query("UPDATE devices SET last_seen_at = NULL WHERE id = ?")
        .bind(&floor.station)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(
        check(&admin, &floor.key, &code_hash(1)).await.0,
        StatusCode::OK
    );
    assert_eq!(last_seen(&admin, &floor.station).await, None);
    // Another device route touches it at once, then once a minute.
    assert_eq!(touch(floor.key.clone()).await, StatusCode::OK);
    let touched = admin.app.state.timestamp();
    assert_eq!(
        last_seen(&admin, &floor.station).await,
        Some(touched.clone())
    );
    admin.app.clock.advance(time::Duration::seconds(59));
    assert_eq!(touch(floor.key.clone()).await, StatusCode::OK);
    assert_eq!(last_seen(&admin, &floor.station).await, Some(touched));
    admin.app.clock.advance(time::Duration::seconds(1));
    assert_eq!(touch(floor.key.clone()).await, StatusCode::OK);
    assert_eq!(
        last_seen(&admin, &floor.station).await,
        Some(admin.app.state.timestamp())
    );
}
