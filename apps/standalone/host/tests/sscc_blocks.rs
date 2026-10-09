mod support;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use http_body_util::BodyExt;
use markiro_host::auth::AuthDevice;
use markiro_host::db::{begin_write, commit_with_revision, next_revision};
use markiro_host::error::ApiJson;
use markiro_host::routes::sscc_blocks::issue_block;
use markiro_proto::{DeviceKind, SsccBlockRequest};
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, audit_trail, empty, host_revision, json as json_request, pair_device,
    request, with_device, Admin, AuditRow, LAN,
};

const PREFIX: &str = "460068200";
const FIRST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const SECOND: &str = "8d7c6b5a-4e3f-4a2b-9c1d-0e9f8a7b6c5d";
const THIRD: &str = "0f1e2d3c-4b5a-4968-8776-655443322110";

fn block_request(request_id: &str) -> Value {
    json!({ "requestId": request_id, "issuerPrefix": PREFIX, "extension": 0 })
}

/// `POST /v1/device/sscc/blocks` with `key`.
async fn ask(admin: &Admin, key: &str, body: Value) -> (StatusCode, Value) {
    admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/sscc/blocks"), key),
            body,
        ))
        .await
}

/// The box counter of `PREFIX` as the office reads it.
async fn box_counter(admin: &Admin) -> Value {
    let (status, state) = admin.call("GET", "/v1/office/sscc", None).await;
    assert_eq!(status, StatusCode::OK, "{state}");
    state["counters"]
        .as_array()
        .unwrap()
        .iter()
        .find(|counter| counter["issuerPrefix"] == PREFIX && counter["extension"] == 0)
        .cloned()
        .expect("the wizard made the box counter")
}

async fn device_id(admin: &Admin, key: &str) -> String {
    let (status, device) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), key)))
        .await;
    assert_eq!(status, StatusCode::OK, "{device}");
    device["id"].as_str().unwrap().to_owned()
}

fn issued(device: &str, block: &Value) -> AuditRow {
    (
        "device".to_owned(),
        Some(device.to_owned()),
        "sscc.block.issue".to_owned(),
        Some("sscc_block".to_owned()),
        Some(block["id"].as_str().unwrap().to_owned()),
        "ok".to_owned(),
        json!({
            "issuerPrefix": PREFIX, "extension": 0,
            "fromSerial": block["fromSerial"], "toSerial": block["toSerial"]
        }),
    )
}

#[tokio::test]
async fn a_station_gets_a_block_and_the_counter_moves_past_it() {
    let admin = admin().await;
    let station = device_id(&admin, &admin.key).await;
    // The wizard started the box counter at 1500 (revision 1); a block is
    // 2000 serials by default.
    let before = box_counter(&admin).await;
    let (status, block) = ask(&admin, &admin.key, block_request(FIRST)).await;
    assert_eq!(status, StatusCode::OK, "{block}");
    assert_eq!(
        block,
        json!({
            "id": block["id"], "issuerPrefix": PREFIX, "extension": 0,
            "fromSerial": 1500, "toSerial": 3499
        })
    );
    assert!(uuid::Uuid::try_parse(block["id"].as_str().unwrap()).is_ok());
    let counter = box_counter(&admin).await;
    assert_eq!(
        (counter["nextSerial"].clone(), counter["rev"].clone()),
        (json!(3500), json!(2))
    );
    assert_eq!(host_revision(&admin.app).await, 2);
    assert_eq!(
        audit_trail(&admin.app, "sscc.block.issue").await,
        vec![issued(&station, &block)]
    );
    // The same request again is the same block: no revision, no row.
    let rows = audit_rows(&admin.app).await;
    let (status, repeated) = ask(&admin, &admin.key, block_request(FIRST)).await;
    assert_eq!((status, repeated), (StatusCode::OK, block.clone()));
    assert_eq!(host_revision(&admin.app).await, 2);
    assert_eq!(audit_rows(&admin.app).await, rows);
    // The next request gets the next serials.
    let (status, next) = ask(&admin, &admin.key, block_request(SECOND)).await;
    assert_eq!(
        (status, next["fromSerial"].clone(), next["toSerial"].clone()),
        (StatusCode::OK, json!(3500), json!(5499))
    );
    // A counter form opened before the blocks is stale now, and the counter
    // never goes back under an issued serial.
    let path = format!("/v1/office/sscc/counters/{PREFIX}/0");
    let (status, refused) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "nextSerial": 2000, "expectedRev": before["rev"] })),
        )
        .await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("stale_revision"))
    );
    let (status, refused) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "nextSerial": 5499, "expectedRev": 3 })),
        )
        .await;
    assert_eq!(
        (
            status,
            refused["error"]["code"].clone(),
            refused["error"]["details"].clone()
        ),
        (
            StatusCode::CONFLICT,
            json!("sscc_below_floor"),
            json!({ "minSerial": 5500 })
        )
    );
}

#[tokio::test]
async fn a_block_is_cut_short_at_the_end_of_the_prefix_and_then_exhausted() {
    let admin = admin().await;
    // A nine-digit prefix leaves seven digits of serials: 9 999 999 at most.
    let path = format!("/v1/office/sscc/counters/{PREFIX}/0");
    let (status, moved) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "nextSerial": 9_999_000, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    let (status, block) = ask(&admin, &admin.key, block_request(FIRST)).await;
    assert_eq!(
        (
            status,
            block["fromSerial"].clone(),
            block["toSerial"].clone()
        ),
        (StatusCode::OK, json!(9_999_000), json!(9_999_999))
    );
    assert_eq!(box_counter(&admin).await["nextSerial"], json!(10_000_000));
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let (status, refused) = ask(&admin, &admin.key, block_request(SECOND)).await;
    assert_eq!(
        (
            status,
            refused["error"]["code"].clone(),
            refused["error"]["details"].clone()
        ),
        (
            StatusCode::CONFLICT,
            json!("sscc_exhausted"),
            json!({ "issuerPrefix": PREFIX, "extension": 0 })
        )
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
}

#[tokio::test]
async fn the_last_serial_of_a_prefix_is_a_block_of_one_and_then_none_is_left() {
    let admin = admin().await;
    let (status, moved) = admin
        .call(
            "PUT",
            &format!("/v1/office/sscc/counters/{PREFIX}/0"),
            Some(json!({ "nextSerial": 9_999_999, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    // Serial 9 999 999 is still free: a counter on it is not exhausted.
    let (status, block) = ask(&admin, &admin.key, block_request(FIRST)).await;
    assert_eq!(
        (
            status,
            block["fromSerial"].clone(),
            block["toSerial"].clone()
        ),
        (StatusCode::OK, json!(9_999_999), json!(9_999_999)),
        "{block}"
    );
    assert_eq!(box_counter(&admin).await["nextSerial"], json!(10_000_000));
    let (status, refused) = ask(&admin, &admin.key, block_request(SECOND)).await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("sscc_exhausted"))
    );
    assert_eq!(block_rows(&admin).await.len(), 1);
}

#[tokio::test]
async fn a_block_takes_the_sites_block_size() {
    let admin = admin().await;
    let (status, sizes) = admin
        .call(
            "PUT",
            "/v1/office/sscc/block-sizes",
            Some(json!({ "boxBlockSize": 1, "palletBlockSize": 200, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{sizes}");
    let (status, block) = ask(&admin, &admin.key, block_request(FIRST)).await;
    assert_eq!(
        (
            status,
            block["fromSerial"].clone(),
            block["toSerial"].clone()
        ),
        (StatusCode::OK, json!(1500), json!(1500))
    );
    assert_eq!(box_counter(&admin).await["nextSerial"], json!(1501));
}

#[tokio::test]
async fn only_a_station_gets_blocks_and_only_of_a_known_box_counter() {
    let admin = admin().await;
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let field = |name: &str| {
        (
            StatusCode::BAD_REQUEST,
            json!({ "code": "validation_failed", "field": name }),
        )
    };
    for (change, expected) in [
        (
            json!({ "issuerPrefix": "460123400" }),
            field("issuerPrefix"),
        ),
        (json!({ "issuerPrefix": "4600682" }), field("issuerPrefix")),
        (json!({ "extension": 1 }), field("extension")),
        (json!({ "requestId": "first" }), field("requestId")),
        (
            json!({ "requestId": FIRST.to_uppercase() }),
            field("requestId"),
        ),
    ] {
        let mut body = block_request(FIRST);
        for (key, value) in change.as_object().unwrap() {
            body[key] = value.clone();
        }
        let (status, refused) = ask(&admin, &admin.key, body).await;
        assert_eq!(
            (
                status,
                json!({
                    "code": refused["error"]["code"],
                    "field": refused["error"]["details"]["field"]
                })
            ),
            expected,
            "{change}"
        );
    }
    let mut body = block_request(FIRST);
    body["size"] = json!(10);
    let (status, refused) = ask(&admin, &admin.key, body).await;
    assert_eq!(
        (status, refused["error"]["details"].clone()),
        (StatusCode::BAD_REQUEST, Value::Null)
    );
    let (_, office_pc) = pair_device(&admin.app, "office").await;
    let (status, refused) = ask(&admin, &office_pc, block_request(FIRST)).await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
    let (status, refused) = admin
        .app
        .send(json_request(
            request("POST", "/v1/device/sscc/blocks"),
            block_request(FIRST),
        ))
        .await;
    assert_eq!(
        (status, refused["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("device"))
    );
    // Pairing the office PC wrote its row; nothing else changed.
    assert_eq!(audit_rows(&admin.app).await, rows + 1);
    assert_eq!(host_revision(&admin.app).await, revision);
    // Another station's request with the same id is its own block.
    let (status, mine) = ask(&admin, &admin.key, block_request(FIRST)).await;
    assert_eq!(status, StatusCode::OK, "{mine}");
    let (_, other) = pair_device(&admin.app, "station").await;
    let (status, theirs) = ask(&admin, &other, block_request(FIRST)).await;
    assert_eq!(
        (status, theirs["fromSerial"].clone()),
        (StatusCode::OK, json!(3500))
    );
}

/// A handheld device paired with a code, as the office hands one out;
/// returns its key.
async fn pair_handheld(admin: &Admin) -> String {
    let (status, code) = admin.call("POST", "/v1/office/pairing-codes", None).await;
    assert_eq!(status, StatusCode::OK, "{code}");
    let (status, paired) = admin
        .app
        .send_from(
            LAN,
            json_request(
                request("POST", "/v1/pairing/claim"),
                json!({ "code": code["code"], "kind": "handheld", "name": "ТСД 1",
                    "appVersion": "1.2.0", "capabilities": ["scanner"] }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{paired}");
    paired["deviceKey"].as_str().unwrap().to_owned()
}

/// The handler called directly as device `id` of `kind`, bypassing the
/// device authentication in front of it (which writes `last_seen_at`, and
/// has read the key before the handler's transaction starts).
async fn issue_as(admin: &Admin, id: &str, kind: DeviceKind, body: Value) -> (StatusCode, Value) {
    let request: SsccBlockRequest = serde_json::from_value(body).unwrap();
    let outcome = issue_block(
        State(admin.app.state.clone()),
        AuthDevice {
            id: id.to_owned(),
            kind,
        },
        ApiJson(request),
    )
    .await;
    let response = match outcome {
        Ok(block) => block.into_response(),
        Err(error) => error.into_response(),
    };
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

/// Every block row, by serial: `(device, request, from, to)`.
async fn block_rows(admin: &Admin) -> Vec<(String, String, i64, i64)> {
    sqlx::query_as(
        "SELECT device_id, request_id, from_serial, to_serial FROM sscc_blocks \
         ORDER BY from_serial",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn a_repeated_request_answers_its_own_block_after_others_were_issued() {
    let admin = admin().await;
    let (_, colleague) = pair_device(&admin.app, "station").await;
    let mut blocks = Vec::new();
    for id in [FIRST, SECOND, THIRD] {
        let (status, block) = ask(&admin, &admin.key, block_request(id)).await;
        assert_eq!(status, StatusCode::OK, "{block}");
        blocks.push(block);
    }
    let (status, theirs) = ask(&admin, &colleague, block_request(FIRST)).await;
    assert_eq!(
        (
            status,
            theirs["fromSerial"].clone(),
            theirs["toSerial"].clone()
        ),
        (StatusCode::OK, json!(7500), json!(9499))
    );
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let counter = box_counter(&admin).await;
    // Each request, oldest first and newest first, gets back its own block;
    // so does the colleague's request with the same id.
    for (id, block) in [FIRST, SECOND, THIRD, THIRD, SECOND, FIRST]
        .into_iter()
        .zip([
            &blocks[0], &blocks[1], &blocks[2], &blocks[2], &blocks[1], &blocks[0],
        ])
    {
        let (status, repeated) = ask(&admin, &admin.key, block_request(id)).await;
        assert_eq!((status, &repeated), (StatusCode::OK, block), "{id}");
    }
    let (status, repeated) = ask(&admin, &colleague, block_request(FIRST)).await;
    assert_eq!((status, repeated), (StatusCode::OK, theirs));
    // The repeated request is answered whatever the body names now, as the
    // shifts' are: the station's retry after a lost answer makes no block.
    let mut other = block_request(FIRST);
    other["issuerPrefix"] = json!("460123400");
    let (status, repeated) = ask(&admin, &admin.key, other).await;
    assert_eq!((status, &repeated), (StatusCode::OK, &blocks[0]));
    // None of it took a revision, wrote a row or moved the counter.
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(box_counter(&admin).await, counter);
    assert_eq!(block_rows(&admin).await.len(), 4);
}

#[tokio::test]
async fn an_issue_stores_the_block_whole_wakes_the_streams_and_touches_no_other_counter() {
    let admin = admin().await;
    let station = device_id(&admin, &admin.key).await;
    let pallet_counter = |state: &Value| {
        state["counters"]
            .as_array()
            .unwrap()
            .iter()
            .find(|counter| counter["extension"] == 1)
            .cloned()
            .unwrap()
    };
    let (_, state) = admin.call("GET", "/v1/office/sscc", None).await;
    let pallets = pallet_counter(&state);
    assert_eq!(
        (pallets["nextSerial"].clone(), pallets["rev"].clone()),
        (json!(40), json!(1))
    );
    admin.app.clock.advance(time::Duration::minutes(5));
    let issued_at = admin.app.state.timestamp();
    let mut wake = admin.app.state.revisions.subscribe();
    wake.borrow_and_update();
    let (status, block) = ask(&admin, &admin.key, block_request(FIRST)).await;
    assert_eq!(status, StatusCode::OK, "{block}");
    // The issue wakes the streams with its revision.
    assert!(wake.has_changed().unwrap());
    assert_eq!(*wake.borrow_and_update(), 2);
    assert_eq!(*admin.app.state.revisions.borrow(), 2);
    // The row keeps what the station asked for and when.
    let row: (
        String,
        String,
        i64,
        String,
        String,
        i64,
        i64,
        Option<i64>,
        String,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT id, issuer_prefix, extension, device_id, request_id, from_serial, to_serial, \
             consumed_through, issued_at, revoked_at FROM sscc_blocks",
    )
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        row,
        (
            block["id"].as_str().unwrap().to_owned(),
            PREFIX.to_owned(),
            0,
            station.clone(),
            FIRST.to_owned(),
            1500,
            3499,
            None,
            issued_at,
            None
        )
    );
    // The pallet counter of the same prefix stays where it was.
    let (_, state) = admin.call("GET", "/v1/office/sscc", None).await;
    assert_eq!(pallet_counter(&state), pallets);
    // Neither a repeat nor a refusal wakes anything.
    let (status, _) = ask(&admin, &admin.key, block_request(FIRST)).await;
    assert_eq!(status, StatusCode::OK);
    let mut bad = block_request(SECOND);
    bad["extension"] = json!(1);
    let (status, _) = ask(&admin, &admin.key, bad).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(!wake.has_changed().unwrap());
}

#[tokio::test]
async fn a_block_that_just_fits_is_whole_and_the_next_request_is_exhausted() {
    let admin = admin().await;
    let (status, sizes) = admin
        .call(
            "PUT",
            "/v1/office/sscc/block-sizes",
            Some(json!({ "boxBlockSize": 1000, "palletBlockSize": 200, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{sizes}");
    let (status, moved) = admin
        .call(
            "PUT",
            &format!("/v1/office/sscc/counters/{PREFIX}/0"),
            Some(json!({ "nextSerial": 9_999_000, "expectedRev": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    let (status, block) = ask(&admin, &admin.key, block_request(FIRST)).await;
    assert_eq!(
        (
            status,
            block["fromSerial"].clone(),
            block["toSerial"].clone()
        ),
        (StatusCode::OK, json!(9_999_000), json!(9_999_999))
    );
    let counter = box_counter(&admin).await;
    assert_eq!(counter["nextSerial"], json!(10_000_000));
    let (status, refused) = ask(&admin, &admin.key, block_request(SECOND)).await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("sscc_exhausted"))
    );
    // The refusal leaves the counter, and the blocks, as they were.
    assert_eq!(box_counter(&admin).await, counter);
    assert_eq!(block_rows(&admin).await.len(), 1);
}

#[tokio::test]
async fn only_a_station_asks_whatever_the_body_says() {
    let admin = admin().await;
    let (office_id, office_pc) = pair_device(&admin.app, "office").await;
    let handheld = pair_handheld(&admin).await;
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    // The kind is checked before the body: a bad body is no reason to tell
    // another kind of device about it.
    for key in [&office_pc, &handheld] {
        for body in [
            block_request(FIRST),
            json!({ "requestId": "first", "issuerPrefix": PREFIX, "extension": 3 }),
        ] {
            let (status, refused) = ask(&admin, key, body).await;
            assert_eq!(
                (status, refused["error"]["code"].clone()),
                (StatusCode::FORBIDDEN, json!("forbidden"))
            );
        }
    }
    // The transaction reads the kind again: a device that is no station is
    // refused there as well, whatever the request says it is.
    let (status, refused) = issue_as(
        &admin,
        &office_id,
        DeviceKind::Station,
        block_request(FIRST),
    )
    .await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert!(block_rows(&admin).await.is_empty());
}

/// The transaction reads the device again: a station revoked after the
/// device authentication read its key (the request waited for the write
/// lock) gets nothing, not even the block it asked for before.
#[tokio::test]
async fn a_station_revoked_meanwhile_gets_no_block() {
    let admin = admin().await;
    let (colleague, colleague_key) = pair_device(&admin.app, "station").await;
    let (status, block) = ask(&admin, &colleague_key, block_request(FIRST)).await;
    assert_eq!(status, StatusCode::OK, "{block}");
    sqlx::query("UPDATE devices SET revoked_at = ? WHERE id = ?")
        .bind(admin.app.state.timestamp())
        .bind(&colleague)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let counter = box_counter(&admin).await;
    for id in [FIRST, SECOND] {
        let (status, refused) =
            issue_as(&admin, &colleague, DeviceKind::Station, block_request(id)).await;
        assert_eq!(
            (status, refused["error"]["details"]["credential"].clone()),
            (StatusCode::UNAUTHORIZED, json!("device")),
            "{id}"
        );
    }
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(box_counter(&admin).await, counter);
    assert_eq!(block_rows(&admin).await.len(), 1);
}

/// The issue reads the counter only after it holds the write lock. A
/// colleague's issue that is still being written when this station's request
/// arrives is therefore seen, and the two blocks do not overlap; with a
/// deferred transaction the stale counter would be read first, and the write
/// would fail with a database error.
#[tokio::test]
async fn an_issue_waiting_for_the_write_lock_starts_after_the_block_that_held_it() {
    let admin = admin().await;
    let station = device_id(&admin, &admin.key).await;
    let (colleague, _) = pair_device(&admin.app, "station").await;

    // The colleague's issue, held open at the moment it has written.
    let mut holder = begin_write(&admin.app.state.pool).await.unwrap();
    let rev = next_revision(&mut holder).await.unwrap();
    sqlx::query(
        "UPDATE sscc_counters SET next_serial = 3500, rev = ? \
         WHERE issuer_prefix = ? AND extension = 0",
    )
    .bind(rev)
    .bind(PREFIX)
    .execute(&mut *holder)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO sscc_blocks (id, issuer_prefix, extension, device_id, request_id, \
         from_serial, to_serial, issued_at) VALUES (?, ?, 0, ?, ?, 1500, 3499, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(PREFIX)
    .bind(&colleague)
    .bind(SECOND)
    .bind(admin.app.state.timestamp())
    .execute(&mut *holder)
    .await
    .unwrap();

    // This station's request arrives meanwhile and has to wait for the lock.
    let mut waiting = Box::pin(issue_as(
        &admin,
        &station,
        DeviceKind::Station,
        block_request(FIRST),
    ));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(200), &mut waiting)
            .await
            .is_err(),
        "the issue answered while another writer held the lock"
    );
    commit_with_revision(holder, &admin.app.state.revisions, rev)
        .await
        .unwrap();

    let (status, block) = waiting.await;
    assert_eq!(
        (
            status,
            block["fromSerial"].clone(),
            block["toSerial"].clone()
        ),
        (StatusCode::OK, json!(3500), json!(5499)),
        "{block}"
    );
    assert_eq!(
        block_rows(&admin).await,
        vec![
            (colleague, SECOND.to_owned(), 1500, 3499),
            (station, FIRST.to_owned(), 3500, 5499)
        ]
    );
    let counter = box_counter(&admin).await;
    assert_eq!(
        (counter["nextSerial"].clone(), counter["rev"].clone()),
        (json!(5500), json!(3))
    );
}

#[tokio::test]
async fn requests_arriving_together_get_disjoint_blocks_and_a_repeat_gets_the_same() {
    let admin = admin().await;
    let (_, colleague) = pair_device(&admin.app, "station").await;
    let (first, second, again, other) = tokio::join!(
        ask(&admin, &admin.key, block_request(FIRST)),
        ask(&admin, &colleague, block_request(FIRST)),
        ask(&admin, &admin.key, block_request(FIRST)),
        ask(&admin, &admin.key, block_request(SECOND)),
    );
    for (status, body) in [&first, &second, &again, &other] {
        assert_eq!(*status, StatusCode::OK, "{body}");
    }
    // The same request of the same station made one block, whichever of the
    // two arrived first.
    assert_eq!(first.1, again.1);
    let rows = block_rows(&admin).await;
    assert_eq!(rows.len(), 3);
    let mut serials: Vec<(i64, i64)> = rows.iter().map(|row| (row.2, row.3)).collect();
    serials.sort();
    assert_eq!(serials, vec![(1500, 3499), (3500, 5499), (5500, 7499)]);
    assert_eq!(box_counter(&admin).await["nextSerial"], json!(7500));
    assert_eq!(audit_trail(&admin.app, "sscc.block.issue").await.len(), 3);
}
