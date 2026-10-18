//! `POST /v1/device/sscc/blocks/known` (plan РК): after a restore a station
//! gives the host back the blocks the copy lost; a block the host knows is
//! `known`, one it cannot take is `refused`, and only a station after a
//! restore is heard.

mod support;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use http_body_util::BodyExt;
use markiro_host::auth::AuthDevice;
use markiro_host::error::ApiJson;
use markiro_host::routes::known_blocks::register_known_blocks;
use markiro_proto::backup::KnownBlocksRequest;
use markiro_proto::DeviceKind;
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, empty, host_revision, json as json_request, pair_device,
    request, with_device, Admin,
};

const PREFIX: &str = "460068200";
const ISSUED: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const LOST: &str = "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER: &str = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";

fn block(id: &str, prefix: &str, extension: u8, from: u64, to: u64) -> Value {
    json!({
        "id": id, "issuerPrefix": prefix, "extension": extension,
        "fromSerial": from, "toSerial": to
    })
}

async fn send(admin: &Admin, key: &str, blocks: Vec<Value>) -> (StatusCode, Value) {
    admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/sscc/blocks/known"), key),
            json!({ "blocks": blocks }),
        ))
        .await
}

/// One part of a run (plan ОЧ): `more` says the station has more parts to send.
async fn send_part(
    admin: &Admin,
    key: &str,
    blocks: Vec<Value>,
    more: bool,
) -> (StatusCode, Value) {
    admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/sscc/blocks/known"), key),
            json!({ "blocks": blocks, "more": more }),
        ))
        .await
}

async fn known_epoch(admin: &Admin, station: &str) -> Option<String> {
    sqlx::query_scalar::<_, Option<String>>("SELECT known_blocks_epoch FROM devices WHERE id = ?")
        .bind(station)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

/// A host after a restore, whose station got the block `ISSUED` (1500 …
/// 3499) before the copy; returns the block as the station holds it.
async fn restored(admin: &Admin) -> Value {
    let (status, issued) = admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/sscc/blocks"), &admin.key),
            json!({ "requestId": ISSUED, "issuerPrefix": PREFIX, "extension": 0 }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{issued}");
    sqlx::query("UPDATE site SET restore_epoch = '5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e'")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    block(issued["id"].as_str().unwrap(), PREFIX, 0, 1500, 3499)
}

async fn box_counter(admin: &Admin) -> (i64, i64) {
    sqlx::query_as(
        "SELECT next_serial, rev FROM sscc_counters WHERE issuer_prefix = ? AND extension = 0",
    )
    .bind(PREFIX)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap()
}

/// Every block row: `(id, device, request, from, to)`, by serial.
async fn block_rows(admin: &Admin) -> Vec<(String, String, String, i64, i64)> {
    sqlx::query_as(
        "SELECT id, device_id, request_id, from_serial, to_serial FROM sscc_blocks \
         ORDER BY from_serial",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap()
}

async fn device_id(admin: &Admin) -> String {
    let (status, device) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), &admin.key)))
        .await;
    assert_eq!(status, StatusCode::OK, "{device}");
    device["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn a_station_gives_back_the_block_a_restore_lost_and_its_known_blocks_change_nothing() {
    let admin = admin().await;
    let issued = restored(&admin).await;
    let station = device_id(&admin).await;
    let rev = host_revision(&admin.app).await;
    let mut wake = admin.app.state.revisions.subscribe();
    let lost = block(LOST, PREFIX, 0, 3500, 5499);
    let (status, body) = send(&admin, &admin.key, vec![issued.clone(), lost.clone()]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body,
        json!({ "results": [
            { "id": issued["id"], "outcome": "known", "code": null },
            { "id": LOST, "outcome": "registered", "code": null },
        ] })
    );
    assert_eq!(host_revision(&admin.app).await, rev + 1);
    assert!(
        wake.has_changed().unwrap(),
        "the registration wakes the streams"
    );
    assert_eq!(*wake.borrow_and_update(), rev + 1);
    assert_eq!(box_counter(&admin).await, (5500, rev + 1));
    let rows = block_rows(&admin).await;
    assert_eq!(
        rows[1],
        (
            LOST.to_owned(),
            station.clone(),
            LOST.to_owned(),
            3500,
            5499
        )
    );
    assert_eq!(
        audit_trail(&admin.app, "sscc.block.register").await,
        [(
            "device".to_owned(),
            Some(station),
            "sscc.block.register".to_owned(),
            Some("sscc_block".to_owned()),
            Some(LOST.to_owned()),
            "ok".to_owned(),
            json!({ "issuerPrefix": PREFIX, "extension": 0, "fromSerial": 3500, "toSerial": 5499 }),
        )]
    );

    // Sent again: known, and nothing is written.
    let rows = audit_rows(&admin.app).await;
    let (status, again) = send(&admin, &admin.key, vec![lost]).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again["results"][0]["outcome"], "known");
    assert_eq!(host_revision(&admin.app).await, rev + 1);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert!(!wake.has_changed().unwrap());
}

#[tokio::test]
async fn a_block_below_the_counter_leaves_the_counter_where_it_is() {
    let admin = admin().await;
    restored(&admin).await;
    // The restore lifted the counter above the lost block already.
    sqlx::query("UPDATE sscc_counters SET next_serial = 9500 WHERE extension = 0")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (_, before_rev) = box_counter(&admin).await;
    let (status, body) = send(&admin, &admin.key, vec![block(LOST, PREFIX, 0, 3500, 5499)]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["results"][0]["outcome"], "registered");
    assert_eq!(box_counter(&admin).await, (9500, before_rev));
}

#[tokio::test]
async fn a_block_the_host_cannot_take_is_refused_and_nothing_is_written() {
    let admin = admin().await;
    let issued = restored(&admin).await;
    let mut changed = issued.clone();
    changed["toSerial"] = json!(3498);
    let blocks = vec![
        changed,
        block(LOST, PREFIX, 0, 3000, 3999),
        block(OTHER, "460068299", 0, 1, 10),
        block("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "46x", 0, 1, 10),
        block("2a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", PREFIX, 2, 1, 10),
        block("3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", PREFIX, 0, 10, 9),
        block(
            "4a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
            PREFIX,
            0,
            9_999_000,
            10_000_000,
        ),
        // The id the station once sent as a request id: another block.
        block(ISSUED, PREFIX, 0, 6000, 6099),
    ];
    let rev = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let counter = box_counter(&admin).await;
    let before = block_rows(&admin).await;
    let (status, body) = send(&admin, &admin.key, blocks).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let codes: Vec<(&str, &str)> = body["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|each| {
            (
                each["outcome"].as_str().unwrap(),
                each["code"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        codes,
        [
            ("refused", "block_mismatch"),
            ("refused", "block_overlap"),
            ("refused", "prefix_unknown"),
            ("refused", "prefix_unknown"),
            ("refused", "prefix_unknown"),
            ("refused", "range_invalid"),
            ("refused", "range_invalid"),
            ("refused", "block_mismatch"),
        ]
    );
    assert_eq!(host_revision(&admin.app).await, rev);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(box_counter(&admin).await, counter);
    assert_eq!(block_rows(&admin).await, before);
}

#[tokio::test]
async fn a_revoked_block_still_holds_its_serials_and_the_last_serial_fits() {
    let admin = admin().await;
    restored(&admin).await;
    sqlx::query("UPDATE sscc_blocks SET revoked_at = '2026-09-21T14:00:00Z'")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (_, body) = send(&admin, &admin.key, vec![block(LOST, PREFIX, 0, 3499, 3600)]).await;
    assert_eq!(body["results"][0]["code"], "block_overlap", "{body}");
    let (_, body) = send(
        &admin,
        &admin.key,
        vec![block(OTHER, PREFIX, 0, 9_999_000, 9_999_999)],
    )
    .await;
    assert_eq!(body["results"][0]["outcome"], "registered", "{body}");
    assert_eq!(box_counter(&admin).await.0, 10_000_000);
}

#[tokio::test]
async fn only_a_station_after_a_restore_is_heard() {
    let admin = admin().await;
    let (status, body) = send(&admin, &admin.key, vec![block(LOST, PREFIX, 0, 1, 10)]).await;
    assert_eq!(
        (
            status,
            body["error"]["code"].clone(),
            body["error"]["details"].clone()
        ),
        (
            StatusCode::CONFLICT,
            json!("conflict"),
            json!({ "constraint": "no_restore" })
        ),
        "a host never restored lost no block"
    );
    restored(&admin).await;
    let (_, office_key) = pair_device(&admin.app, "office").await;
    let (status, body) = send(&admin, &office_key, vec![block(LOST, PREFIX, 0, 1, 10)]).await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
    for (blocks, field) in [
        (vec![block(LOST, PREFIX, 0, 1, 10); 65], "blocks"),
        (
            vec![
                block(LOST, PREFIX, 0, 1, 10),
                block("not-a-uuid", PREFIX, 0, 1, 10),
            ],
            "blocks.1.id",
        ),
    ] {
        let (status, body) = send(&admin, &admin.key, blocks).await;
        assert_eq!(
            (status, body["error"]["details"]["field"].clone()),
            (StatusCode::BAD_REQUEST, json!(field)),
            "{body}"
        );
    }
}

#[tokio::test]
async fn a_station_without_blocks_is_marked_by_an_empty_list_and_nothing_else_changes() {
    let admin = admin().await;
    // Before a restore an empty list is heard as any other: the host lost nothing.
    let (status, body) = send(&admin, &admin.key, vec![]).await;
    assert_eq!(
        (status, body["error"]["details"].clone()),
        (StatusCode::CONFLICT, json!({ "constraint": "no_restore" }))
    );
    restored(&admin).await;
    let station = device_id(&admin).await;
    let known_epoch = || async {
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT known_blocks_epoch FROM devices WHERE id = ?",
        )
        .bind(&station)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
    };
    let rev = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let blocks = block_rows(&admin).await;
    for _ in 0..2 {
        let (status, body) = send(&admin, &admin.key, vec![]).await;
        assert_eq!((status, body), (StatusCode::OK, json!({ "results": [] })));
        assert_eq!(
            known_epoch().await.as_deref(),
            Some("5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e")
        );
    }
    assert_eq!(host_revision(&admin.app).await, rev);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(block_rows(&admin).await, blocks);
}

const EPOCH: &str = "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e";

#[tokio::test]
async fn a_station_is_marked_by_its_last_part_only_and_an_empty_last_part_marks_one_without_blocks()
{
    let admin = admin().await;
    let issued = restored(&admin).await;
    let station = device_id(&admin).await;
    let (status, body) = send_part(&admin, &admin.key, vec![issued.clone()], true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["results"][0]["outcome"], "known");
    assert_eq!(
        known_epoch(&admin, &station).await,
        None,
        "a part with more to come marks nothing"
    );
    let (status, body) = send_part(&admin, &admin.key, vec![], true).await;
    assert_eq!(
        (status, body["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("blocks")),
        "an empty part is only the last one"
    );
    assert_eq!(known_epoch(&admin, &station).await, None);
    let (status, body) = send_part(&admin, &admin.key, vec![], false).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["results"], json!([]));
    assert_eq!(known_epoch(&admin, &station).await.as_deref(), Some(EPOCH));
}

#[tokio::test]
async fn a_part_with_more_to_come_still_registers_its_blocks_and_marks_nothing() {
    let admin = admin().await;
    restored(&admin).await;
    let station = device_id(&admin).await;
    let rev = host_revision(&admin.app).await;
    let (status, body) = send_part(
        &admin,
        &admin.key,
        vec![block(LOST, PREFIX, 0, 3500, 5499)],
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["results"][0]["outcome"], "registered");
    assert_eq!(host_revision(&admin.app).await, rev + 1);
    assert_eq!(known_epoch(&admin, &station).await, None);
    // The last part, the block already taken: `known`, and the station is marked.
    let (status, body) = send_part(
        &admin,
        &admin.key,
        vec![block(LOST, PREFIX, 0, 3500, 5499)],
        false,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["results"][0]["outcome"], "known");
    assert_eq!(known_epoch(&admin, &station).await.as_deref(), Some(EPOCH));
}

#[tokio::test]
async fn a_run_sent_again_after_a_lost_last_answer_is_heard_the_same_and_marks_once() {
    let admin = admin().await;
    let issued = restored(&admin).await;
    let station = device_id(&admin).await;
    let lost = block(LOST, PREFIX, 0, 3500, 5499);
    // First run: the first part registers the lost block; the answer to the
    // last part is lost on the way back, but the host did mark the station.
    let (status, _) = send_part(&admin, &admin.key, vec![lost.clone()], true).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send_part(&admin, &admin.key, vec![issued.clone()], false).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(known_epoch(&admin, &station).await.as_deref(), Some(EPOCH));
    // The station never saw it and sends every part again: `known`, nothing new.
    let rev = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let blocks = block_rows(&admin).await;
    let (status, body) = send_part(&admin, &admin.key, vec![lost], true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["results"][0]["outcome"], "known");
    let (status, body) = send_part(&admin, &admin.key, vec![issued], false).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["results"][0]["outcome"], "known");
    assert_eq!(known_epoch(&admin, &station).await.as_deref(), Some(EPOCH));
    assert_eq!(host_revision(&admin.app).await, rev);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(block_rows(&admin).await, blocks);
}

#[tokio::test]
async fn a_request_without_more_is_a_last_part_and_a_more_that_is_no_boolean_is_refused() {
    let admin = admin().await;
    let issued = restored(&admin).await;
    let station = device_id(&admin).await;
    // An older station never writes `more` (`send` does not): the last part, as before.
    let (status, body) = send(&admin, &admin.key, vec![issued.clone()]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(known_epoch(&admin, &station).await.as_deref(), Some(EPOCH));
    // `more: false` is the same spelled out.
    sqlx::query("UPDATE devices SET known_blocks_epoch = NULL WHERE id = ?")
        .bind(&station)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, body) = send_part(&admin, &admin.key, vec![issued.clone()], false).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(known_epoch(&admin, &station).await.as_deref(), Some(EPOCH));
    sqlx::query("UPDATE devices SET known_blocks_epoch = NULL WHERE id = ?")
        .bind(&station)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, _) = admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/sscc/blocks/known"), &admin.key),
            json!({ "blocks": [issued], "more": "yes" }),
        ))
        .await;
    assert!(status.is_client_error(), "{status}");
    assert_eq!(known_epoch(&admin, &station).await, None);
}

#[tokio::test]
async fn a_request_of_the_largest_size_is_heard_and_one_block_more_is_not() {
    let admin = admin().await;
    let issued = restored(&admin).await;
    let (status, body) = send(&admin, &admin.key, vec![issued.clone(); 64]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["results"].as_array().unwrap().len(), 64);
    let (status, body) = send(&admin, &admin.key, vec![issued; 65]).await;
    assert_eq!(
        (status, body["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("blocks")),
        "{body}"
    );
}

#[tokio::test]
async fn a_station_revoked_while_it_waited_registers_nothing() {
    let admin = admin().await;
    restored(&admin).await;
    let station = device_id(&admin).await;
    sqlx::query("UPDATE devices SET revoked_at = '2026-09-21T14:13:20Z' WHERE id = ?")
        .bind(&station)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let before = block_rows(&admin).await;
    let request: KnownBlocksRequest =
        serde_json::from_value(json!({ "blocks": [block(LOST, PREFIX, 0, 3500, 5499)] })).unwrap();
    let outcome = register_known_blocks(
        State(admin.app.state.clone()),
        AuthDevice {
            dataset_guard: None,
            id: station,
            kind: DeviceKind::Station,
            key_hash: None,
        },
        ApiJson(request),
    )
    .await;
    let response = match outcome {
        Ok(answer) => answer.into_response(),
        Err(error) => error.into_response(),
    };
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        (status, body["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("device"))
    );
    assert_eq!(block_rows(&admin).await, before);
}

#[tokio::test]
async fn a_station_that_sends_only_known_blocks_is_marked_without_a_revision() {
    let admin = admin().await;
    let issued = restored(&admin).await;
    let station = device_id(&admin).await;
    let known_epoch = || async {
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT known_blocks_epoch FROM devices WHERE id = ?",
        )
        .bind(&station)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
    };
    assert_eq!(known_epoch().await, None);
    let rev = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let (status, body) = send(&admin, &admin.key, vec![issued.clone()]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["results"][0]["outcome"], "known");
    assert_eq!(
        known_epoch().await.as_deref(),
        Some("5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e")
    );
    assert_eq!(host_revision(&admin.app).await, rev);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn an_extension_no_serial_can_carry_is_a_range_not_a_missing_counter() {
    let admin = admin().await;
    restored(&admin).await;
    let rev = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let before = block_rows(&admin).await;
    // The wire (Zod) bounds the extension digit to 0-9; Rust reads a `u8`.
    let blocks = vec![
        block("5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", PREFIX, 10, 1, 10),
        block("6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", PREFIX, 255, 1, 10),
        // A digit that is one, but has no counter here: another matter.
        block("7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", PREFIX, 9, 1, 10),
    ];
    let (status, body) = send(&admin, &admin.key, blocks).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let codes: Vec<&str> = body["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|each| each["code"].as_str().unwrap())
        .collect();
    assert_eq!(codes, ["range_invalid", "range_invalid", "prefix_unknown"]);
    assert_eq!(host_revision(&admin.app).await, rev);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(block_rows(&admin).await, before);
    // Past a byte the request is no request.
    let (status, body) = send(
        &admin,
        &admin.key,
        vec![block(LOST, PREFIX, 0, 1, 10), {
            let mut wide = block(OTHER, PREFIX, 0, 1, 10);
            wide["extension"] = json!(256);
            wide
        }],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(block_rows(&admin).await, before);
}

#[tokio::test]
async fn a_block_of_the_host_is_the_stations_only_if_every_part_of_it_matches() {
    let admin = admin().await;
    let issued = restored(&admin).await;
    let before = block_rows(&admin).await;
    let id = issued["id"].as_str().unwrap();
    let mut variants = Vec::new();
    for (field, value) in [
        ("issuerPrefix", json!("460068299")),
        ("extension", json!(1)),
        ("fromSerial", json!(1501)),
        ("toSerial", json!(3500)),
    ] {
        let mut changed = issued.clone();
        changed[field] = value;
        variants.push(changed);
    }
    let (status, body) = send(&admin, &admin.key, variants).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    for result in body["results"].as_array().unwrap() {
        assert_eq!(
            (
                result["id"].as_str().unwrap(),
                result["outcome"].clone(),
                result["code"].clone()
            ),
            (id, json!("refused"), json!("block_mismatch")),
            "{body}"
        );
    }

    // Another station's block is not this station's, whatever its serials.
    let (_, second_key) = pair_device(&admin.app, "station").await;
    let rows = audit_rows(&admin.app).await;
    let (status, body) = send(&admin, &second_key, vec![issued.clone()]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        (
            body["results"][0]["outcome"].clone(),
            body["results"][0]["code"].clone()
        ),
        (json!("refused"), json!("block_mismatch"))
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(block_rows(&admin).await, before);
}

#[tokio::test]
async fn a_block_twice_in_one_request_is_taken_once_and_overlapping_ones_are_not_both_taken() {
    let admin = admin().await;
    restored(&admin).await;
    let rev = host_revision(&admin.app).await;
    let lost = block(LOST, PREFIX, 0, 3500, 5499);
    let other = block(OTHER, PREFIX, 0, 5000, 5999);
    let (status, body) = send(&admin, &admin.key, vec![lost.clone(), lost, other]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let results: Vec<(String, String)> = body["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|each| {
            (
                each["outcome"].as_str().unwrap().to_owned(),
                each["code"].as_str().unwrap_or("").to_owned(),
            )
        })
        .collect();
    assert_eq!(
        results,
        [
            ("registered".to_owned(), String::new()),
            ("known".to_owned(), String::new()),
            ("refused".to_owned(), "block_overlap".to_owned()),
        ]
    );
    assert_eq!(host_revision(&admin.app).await, rev + 1, "one revision");
    assert_eq!(box_counter(&admin).await.0, 5500);
    assert_eq!(block_rows(&admin).await.len(), 2);
    assert_eq!(
        audit_trail(&admin.app, "sscc.block.register").await.len(),
        1
    );
}

#[tokio::test]
async fn a_pallet_block_raises_the_pallet_counter_and_leaves_the_box_counter() {
    let admin = admin().await;
    restored(&admin).await;
    let (status, issued) = admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/sscc/blocks"), &admin.key),
            json!({ "requestId": OTHER, "issuerPrefix": PREFIX, "extension": 1 }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{issued}");
    let boxes = box_counter(&admin).await;
    let pallets = |admin: &Admin| {
        let pool = admin.app.state.pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>(
                "SELECT next_serial FROM sscc_counters WHERE issuer_prefix = ? AND extension = 1",
            )
            .bind(PREFIX)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    let held = pallets(&admin).await;
    let from = u64::try_from(held).unwrap() + 40;
    let lost = block(LOST, PREFIX, 1, from, from + 19);
    let (status, body) = send(&admin, &admin.key, vec![lost]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["results"][0]["outcome"], "registered", "{body}");
    assert_eq!(pallets(&admin).await, i64::try_from(from).unwrap() + 20);
    assert_eq!(box_counter(&admin).await, boxes);
}
