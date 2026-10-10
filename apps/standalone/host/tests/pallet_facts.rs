mod support;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use http_body_util::BodyExt;
use markiro_host::auth::AuthDevice;
use markiro_host::db::begin_write;
use markiro_host::error::ApiJson;
use markiro_host::routes::facts::{receive_facts, IncomingFacts};
use markiro_proto::DeviceKind;
use serde_json::{json, Value};
use support::app::{
    accepted, admin, audit_rows, box_closed, box_id, close_from_office, fact, host_revision,
    instant, issue_block, issue_pallet_block, ok_scan, open_floor, open_pallet_floor, pair_device,
    pallet_closed, pallet_id, pallet_sscc, receipts, record_id, rejected, send_facts, shift_setup,
    sscc_of, Admin, Floor,
};

const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const PALLET_REQUEST: &str = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";
const OTHER_REQUEST: &str = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";
const OPERATOR: &str = "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d";

/// A host whose station is inside an open shift with pallets, with a box
/// block (1500–3499) and a pallet block (40–239).
async fn pallet_floor() -> (Admin, Floor, Value, Value) {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    (admin, floor, block, pallets)
}

/// The record `n` of `kind` in the floor's shift, by the operator.
fn record(floor: &Floor, n: u32, kind: &str, data: Value) -> Value {
    let mut record = fact(&record_id(n), kind, &floor.shift, data);
    record["operatorId"] = json!(OPERATOR);
    record
}

/// Box `box_n` holding code `box_n`, scanned at second `box_n` and closed
/// at second `100 + box_n` with box serial `1499 + box_n`, on `pallet` (or
/// on none): the scan is record `box_n`, the close record `100 + box_n`.
fn boxed(floor: &Floor, block: &Value, box_n: u32, pallet: Option<&str>) -> [Value; 2] {
    let mut closed = box_closed(
        &box_id(box_n),
        block,
        1499 + u64::from(box_n),
        &[box_n],
        &instant(box_n, 0),
        &instant(100 + box_n, 0),
    );
    if let Some(pallet) = pallet {
        closed["palletId"] = json!(pallet);
    }
    [
        record(
            floor,
            box_n,
            "scan",
            ok_scan(box_n, &box_id(box_n), &instant(box_n, 0)),
        ),
        record(floor, 100 + box_n, "box_closed", closed),
    ]
}

/// A pallet row: `(shift, device, opened at, closed at, sscc, block, serial,
/// count reported, operator, received at)`.
async fn pallet_row(admin: &Admin, id: &str) -> Option<Value> {
    type PalletRow = (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<String>,
        String,
    );
    let row: Option<PalletRow> = sqlx::query_as(
        "SELECT shift_id, device_id, opened_at, closed_at, sscc, block_id, serial, \
         box_count_reported, operator_id, received_at FROM pallets WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&admin.app.state.pool)
    .await
    .unwrap();
    row.map(|row| json!(row))
}

/// The pallet each closed box of the shift joined, by box id.
async fn box_pallets(admin: &Admin) -> Vec<(String, Option<String>)> {
    sqlx::query_as("SELECT id, pallet_id FROM boxes WHERE closed_at IS NOT NULL ORDER BY id")
        .fetch_all(&admin.app.state.pool)
        .await
        .unwrap()
}

async fn consumed_through(admin: &Admin, block: &Value) -> Option<i64> {
    sqlx::query_scalar("SELECT consumed_through FROM sscc_blocks WHERE id = ?")
        .bind(block["id"].as_str().unwrap())
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

async fn pallet_count(admin: &Admin) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM pallets")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

/// Boxes that close on a pallet open it and join it; the pallet's close
/// takes a serial of the station's pallet block, raises its use and keeps
/// what the station reported, with the station's opening instant. Facts
/// take no revision and write no audit row.
#[tokio::test]
async fn boxes_closed_on_a_pallet_open_it_and_its_close_takes_a_pallet_serial() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    let pallet = pallet_id(1);
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let mut batch = Vec::new();
    batch.extend(boxed(&floor, &block, 1, Some(&pallet)));
    batch.extend(boxed(&floor, &block, 2, Some(&pallet)));
    let at = admin.app.state.timestamp();
    let answered = receipts(&admin.app, &floor.key, &batch).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
    // The first box opened the pallet at its own close.
    assert_eq!(
        pallet_row(&admin, &pallet).await,
        Some(json!([
            floor.shift,
            floor.station,
            instant(101, 0),
            null,
            null,
            null,
            null,
            null,
            null,
            at
        ]))
    );
    assert_eq!(
        box_pallets(&admin).await,
        vec![
            (box_id(1), Some(pallet.clone())),
            (box_id(2), Some(pallet.clone()))
        ]
    );
    let close = record(
        &floor,
        201,
        "pallet_closed",
        pallet_closed(
            &pallet,
            &pallets,
            40,
            2,
            &instant(100, 500),
            &instant(150, 0),
        ),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[close]).await,
        vec![accepted(&record_id(201))]
    );
    assert_eq!(
        pallet_row(&admin, &pallet).await,
        Some(json!([
            floor.shift,
            floor.station,
            instant(100, 500),
            instant(150, 0),
            pallet_sscc(40),
            pallets["id"],
            40,
            2,
            OPERATOR,
            at
        ]))
    );
    assert_eq!(consumed_through(&admin, &pallets).await, Some(40));
    assert_eq!(consumed_through(&admin, &block).await, Some(1501));
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

/// A pallet's SSCC is of the pallet extension (1) and the shift's prefix,
/// its serial lies in a live pallet block of this device, both ends
/// included, and one serial is one label whatever the check digit says.
/// A refused close leaves its pallet open.
#[tokio::test]
async fn a_pallet_sscc_lies_in_a_live_pallet_block_of_this_device_and_is_one_label() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let other = issue_pallet_block(&admin.app, &colleague_key, PALLET_REQUEST).await;
    // Blocks: this station's 40–239, the colleague's 240–439, this
    // station's revoked one 440–639.
    let revoked = issue_pallet_block(&admin.app, &floor.key, OTHER_REQUEST).await;
    sqlx::query("UPDATE sscc_blocks SET revoked_at = '2026-10-08T06:00:00Z' WHERE id = ?")
        .bind(revoked["id"].as_str().unwrap())
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    // Ten pallets, one box each.
    let mut batch = Vec::new();
    for n in 1..=10 {
        batch.extend(boxed(&floor, &block, n, Some(&pallet_id(n))));
    }
    receipts(&admin.app, &floor.key, &batch).await;
    let close = |n: u32, data: Value| record(&floor, 200 + n, "pallet_closed", data);
    let closing = |n: u32, block: &Value, serial: u64| {
        pallet_closed(
            &pallet_id(n),
            block,
            serial,
            1,
            &instant(100, 0),
            &instant(150, 0),
        )
    };
    let mut box_extension = closing(1, &pallets, 50);
    box_extension["sscc"] = json!(sscc_of(0, "460068200", 50));
    let mut box_block = closing(2, &block, 1500);
    box_block["sscc"] = json!(pallet_sscc(1500));
    let mut other_digit = closing(9, &pallets, 41);
    let sscc = pallet_sscc(41);
    let digit = (sscc.as_bytes()[17] - b'0' + 1) % 10;
    other_digit["sscc"] = json!(format!("{}{digit}", &sscc[..17]));
    let batch = vec![
        close(1, box_extension),
        close(2, box_block),
        close(3, closing(3, &pallets, 39)),
        close(4, closing(4, &pallets, 240)),
        close(5, closing(5, &other, 260)),
        close(6, closing(6, &revoked, 440)),
        close(7, closing(7, &pallets, 40)),
        close(8, closing(8, &pallets, 239)),
        close(9, other_digit),
        close(10, closing(10, &pallets, 239)),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            rejected(Some(&record_id(201)), "sscc_not_issued", None),
            rejected(Some(&record_id(202)), "sscc_not_issued", None),
            rejected(Some(&record_id(203)), "sscc_not_issued", None),
            rejected(Some(&record_id(204)), "sscc_not_issued", None),
            rejected(Some(&record_id(205)), "sscc_not_issued", None),
            rejected(Some(&record_id(206)), "sscc_not_issued", None),
            accepted(&record_id(207)),
            accepted(&record_id(208)),
            accepted(&record_id(209)),
            rejected(Some(&record_id(210)), "sscc_taken", None),
        ]
    );
    // The refused closes left their pallets open; the accepted ones raised
    // the block's use to its last serial.
    for n in [1, 2, 3, 4, 5, 6, 10] {
        assert_eq!(
            pallet_row(&admin, &pallet_id(n)).await.unwrap()[3],
            Value::Null,
            "{n}"
        );
    }
    assert_eq!(consumed_through(&admin, &pallets).await, Some(239));
    assert_eq!(consumed_through(&admin, &other).await, None);
    assert_eq!(consumed_through(&admin, &revoked).await, None);
    // Pallet 9 closed on serial 41 under another check digit: no other
    // pallet takes serial 41 under the right one.
    let again = record(&floor, 211, "pallet_closed", closing(10, &pallets, 41));
    assert_eq!(
        receipts(&admin.app, &floor.key, &[again]).await,
        vec![rejected(Some(&record_id(211)), "sscc_taken", None)]
    );
}

/// The same close sent again under another id changes nothing, another SSCC
/// for a closed pallet is `pallet_already_closed`, and the block's use
/// never goes down when pallets close out of order.
#[tokio::test]
async fn a_pallet_closed_again_changes_nothing_and_its_block_use_never_goes_down() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    let mut batch = Vec::new();
    batch.extend(boxed(&floor, &block, 1, Some(&pallet_id(1))));
    batch.extend(boxed(&floor, &block, 2, Some(&pallet_id(2))));
    receipts(&admin.app, &floor.key, &batch).await;
    let closing = |n: u32, serial: u64| {
        pallet_closed(
            &pallet_id(n),
            &pallets,
            serial,
            1,
            &instant(100, 0),
            &instant(150, 0),
        )
    };
    let first = record(&floor, 201, "pallet_closed", closing(1, 100));
    receipts(&admin.app, &floor.key, &[first]).await;
    let row = pallet_row(&admin, &pallet_id(1)).await;
    let mut other_sscc = closing(1, 101);
    other_sscc["blockId"] = pallets["id"].clone();
    let batch = vec![
        record(&floor, 202, "pallet_closed", closing(1, 100)),
        record(&floor, 203, "pallet_closed", other_sscc),
        record(&floor, 204, "pallet_closed", closing(2, 50)),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            accepted(&record_id(202)),
            rejected(Some(&record_id(203)), "pallet_already_closed", None),
            accepted(&record_id(204)),
        ]
    );
    assert_eq!(pallet_row(&admin, &pallet_id(1)).await, row);
    assert_eq!(consumed_through(&admin, &pallets).await, Some(100));
}

/// A pallet whose close reached the host before any of its boxes (their
/// records were refused and sent again under new ids, say) opens closed,
/// so its printed SSCC is held; the boxes that name it later join it.
#[tokio::test]
async fn a_pallet_closed_before_its_boxes_opens_closed_and_its_boxes_join_it_later() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    let pallet = pallet_id(1);
    let close = record(
        &floor,
        201,
        "pallet_closed",
        pallet_closed(&pallet, &pallets, 40, 1, &instant(100, 0), &instant(150, 0)),
    );
    let at = admin.app.state.timestamp();
    assert_eq!(
        receipts(&admin.app, &floor.key, &[close]).await,
        vec![accepted(&record_id(201))]
    );
    assert_eq!(
        pallet_row(&admin, &pallet).await,
        Some(json!([
            floor.shift,
            floor.station,
            instant(100, 0),
            instant(150, 0),
            pallet_sscc(40),
            pallets["id"],
            40,
            1,
            OPERATOR,
            at
        ]))
    );
    let late = boxed(&floor, &block, 1, Some(&pallet));
    let answered = receipts(&admin.app, &floor.key, &late).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
    assert_eq!(
        box_pallets(&admin).await,
        vec![(box_id(1), Some(pallet.clone()))]
    );
    // The pallet is as its close left it.
    assert_eq!(
        pallet_row(&admin, &pallet).await.unwrap()[3],
        json!(instant(150, 0))
    );
}

/// A pallet of another device or of another shift is `pallet_unknown`, to a
/// closed box and to a pallet's close alike; nothing of the record is
/// written.
#[tokio::test]
async fn a_pallet_of_another_device_or_shift_is_unknown() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_pallet_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let colleague_block = issue_block(&admin.app, &colleague.key, BLOCK_REQUEST).await;
    // The colleague's box 2001 (serial 3500, its block's first) opens pallet
    // 50 on the colleague's shift; this station's box 1 opens pallet 1.
    let theirs = boxed(&colleague, &colleague_block, 2001, Some(&pallet_id(50)));
    let answered = receipts(&admin.app, &colleague.key, &theirs).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
    let mine = boxed(&floor, &block, 1, Some(&pallet_id(1)));
    receipts(&admin.app, &floor.key, &mine).await;
    // A pallet of the colleague in this very shift (no route makes one in
    // stage 2a, where a shift takes one station; the host still keeps a
    // device to its own pallets).
    sqlx::query(
        "INSERT INTO pallets (id, shift_id, device_id, opened_at, received_at) \
         VALUES (?, ?, ?, '2026-10-08T06:00:00.000Z', '2026-10-08T06:00:00Z')",
    )
    .bind(pallet_id(60))
    .bind(&floor.shift)
    .bind(&colleague.station)
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    // A second shift of this station's line, which it enters too.
    let second = open_pallet_floor(&admin, &setup, &floor.key, &setup.line).await;
    let closing = |floor: &Floor, n: u32, pallet: u32| {
        record(
            floor,
            n,
            "pallet_closed",
            pallet_closed(
                &pallet_id(pallet),
                &pallets,
                40,
                1,
                &instant(100, 0),
                &instant(150, 0),
            ),
        )
    };
    let in_second = boxed(&second, &block, 2, Some(&pallet_id(1)));
    let batch = vec![
        boxed(&floor, &block, 3, Some(&pallet_id(50)))[0].clone(),
        boxed(&floor, &block, 3, Some(&pallet_id(50)))[1].clone(),
        closing(&floor, 201, 50),
        in_second[0].clone(),
        in_second[1].clone(),
        closing(&second, 202, 1),
        boxed(&floor, &block, 4, Some(&pallet_id(60)))[0].clone(),
        boxed(&floor, &block, 4, Some(&pallet_id(60)))[1].clone(),
        closing(&floor, 203, 60),
    ];
    let answered = receipts(&admin.app, &floor.key, &batch).await;
    assert_eq!(
        [1, 2, 4, 5, 7, 8].map(|n| answered[n].clone()),
        [
            rejected(Some(&record_id(103)), "pallet_unknown", None),
            rejected(Some(&record_id(201)), "pallet_unknown", None),
            rejected(Some(&record_id(102)), "pallet_unknown", None),
            rejected(Some(&record_id(202)), "pallet_unknown", None),
            rejected(Some(&record_id(104)), "pallet_unknown", None),
            rejected(Some(&record_id(203)), "pallet_unknown", None),
        ]
    );
    // Boxes 2, 3 and 4 stay open, the pallets as they were, the pallet
    // block unused.
    assert_eq!(
        box_pallets(&admin).await,
        vec![
            (box_id(1), Some(pallet_id(1))),
            (box_id(2001), Some(pallet_id(50)))
        ]
    );
    assert_eq!(
        pallet_row(&admin, &pallet_id(50)).await.unwrap()[1],
        json!(colleague.station)
    );
    assert_eq!(
        pallet_row(&admin, &pallet_id(1)).await.unwrap()[3],
        Value::Null
    );
    assert_eq!(consumed_through(&admin, &pallets).await, None);
}

/// A shift without pallets takes no pallet: a closed box that names one and
/// a pallet's close are `no_pallets`, and nothing is written.
#[tokio::test]
async fn a_shift_without_pallets_takes_no_pallet() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let named = boxed(&floor, &block, 1, Some(&pallet_id(1)));
    let close = record(
        &floor,
        201,
        "pallet_closed",
        pallet_closed(
            &pallet_id(1),
            &pallets,
            40,
            1,
            &instant(100, 0),
            &instant(150, 0),
        ),
    );
    let answered = receipts(
        &admin.app,
        &floor.key,
        &[named[0].clone(), named[1].clone(), close],
    )
    .await;
    assert_eq!(
        answered[1..].to_vec(),
        vec![
            rejected(Some(&record_id(101)), "no_pallets", None),
            rejected(Some(&record_id(201)), "no_pallets", None),
        ]
    );
    assert_eq!(box_pallets(&admin).await, vec![]);
    assert_eq!(pallet_count(&admin).await, 0);
    // The same box closes without a pallet.
    let plain = boxed(&floor, &block, 1, None);
    let mut closing = plain[1].clone();
    closing["id"] = json!(record_id(102));
    assert_eq!(
        receipts(&admin.app, &floor.key, &[closing]).await,
        vec![accepted(&record_id(102))]
    );
}

/// A box's close sent again names the same pallet, or none when it named
/// none: on another pallet, or without its pallet, it is another close.
#[tokio::test]
async fn a_box_closed_again_on_another_pallet_is_refused() {
    let (admin, floor, block, _) = pallet_floor().await;
    let first = boxed(&floor, &block, 1, Some(&pallet_id(1)));
    receipts(&admin.app, &floor.key, &first).await;
    let again = |n: u32, pallet: Option<&str>| {
        let mut closing = boxed(&floor, &block, 1, pallet)[1].clone();
        closing["id"] = json!(record_id(n));
        closing
    };
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[
                again(111, Some(&pallet_id(1))),
                again(112, Some(&pallet_id(2))),
                again(113, None),
            ]
        )
        .await,
        vec![
            accepted(&record_id(111)),
            rejected(Some(&record_id(112)), "box_already_closed", None),
            rejected(Some(&record_id(113)), "box_already_closed", None),
        ]
    );
    // Pallet 2 was never opened.
    assert_eq!(pallet_row(&admin, &pallet_id(2)).await, None);
    // A box closed without a pallet, sent again with one, is another close.
    let plain = boxed(&floor, &block, 2, None);
    receipts(&admin.app, &floor.key, &plain).await;
    let mut named = boxed(&floor, &block, 2, Some(&pallet_id(1)))[1].clone();
    named["id"] = json!(record_id(122));
    assert_eq!(
        receipts(&admin.app, &floor.key, &[named]).await,
        vec![rejected(Some(&record_id(122)), "box_already_closed", None)]
    );
}

/// The fields of a pallet's close and a box's pallet have the form the
/// station gives them; a record that breaks one is `invalid_record` on it.
#[tokio::test]
async fn a_pallet_close_and_a_boxs_pallet_have_their_form() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    let good = pallet_closed(
        &pallet_id(1),
        &pallets,
        40,
        1,
        &instant(100, 0),
        &instant(150, 0),
    );
    let changed = |key: &str, value: Value| {
        let mut data = good.clone();
        data[key] = value;
        data
    };
    let mut extra = good.clone();
    extra["boxes"] = json!([]);
    let cases = [
        (
            changed("palletId", json!("pallet-1")),
            Some("data.palletId"),
        ),
        (changed("blockId", json!("block")), Some("data.blockId")),
        (
            changed("openedAt", json!("2026-10-08T06:01:40Z")),
            Some("data.openedAt"),
        ),
        (
            changed("closedAt", json!("yesterday")),
            Some("data.closedAt"),
        ),
        (
            changed("sscc", json!("14600682000000040")),
            Some("data.sscc"),
        ),
        (
            changed("sscc", json!("1460068200000004a9")),
            Some("data.sscc"),
        ),
        (changed("boxCount", json!(0)), Some("data.boxCount")),
        (
            changed("serial", json!(9_223_372_036_854_775_808u64)),
            Some("data.serial"),
        ),
        (extra, Some("data")),
    ];
    let batch: Vec<Value> = cases
        .iter()
        .enumerate()
        .map(|(n, (data, _))| record(&floor, 300 + n as u32, "pallet_closed", data.clone()))
        .collect();
    let expected: Vec<Value> = cases
        .iter()
        .enumerate()
        .map(|(n, (_, field))| rejected(Some(&record_id(300 + n as u32)), "invalid_record", *field))
        .collect();
    assert_eq!(receipts(&admin.app, &floor.key, &batch).await, expected);
    let [scan, mut closing] = boxed(&floor, &block, 1, Some("pallet-1"));
    closing["id"] = json!(record_id(101));
    assert_eq!(
        receipts(&admin.app, &floor.key, &[scan, closing]).await[1],
        rejected(
            Some(&record_id(101)),
            "invalid_record",
            Some("data.palletId")
        )
    );
    assert_eq!(pallet_count(&admin).await, 0);
}

async fn receive_as(admin: &Admin, id: &str, records: &[Value]) -> (StatusCode, Value) {
    let batch: IncomingFacts = serde_json::from_value(json!({ "records": records })).unwrap();
    let outcome = receive_facts(
        State(admin.app.state.clone()),
        AuthDevice {
            id: id.to_owned(),
            kind: DeviceKind::Station,
        },
        ApiJson(batch),
    )
    .await;
    let response = match outcome {
        Ok(receipts) => receipts.into_response(),
        Err(error) => error.into_response(),
    };
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

/// A batch waiting for the write lock checks the pallet's serial inside
/// its own transaction: a close another batch is still writing on the same
/// serial is seen, and the second close is `sscc_taken`.
#[tokio::test]
async fn a_pallet_close_waiting_for_the_write_lock_sees_the_serial_taken_meanwhile() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    let mut batch = Vec::new();
    batch.extend(boxed(&floor, &block, 1, Some(&pallet_id(1))));
    batch.extend(boxed(&floor, &block, 2, Some(&pallet_id(2))));
    receipts(&admin.app, &floor.key, &batch).await;
    let closing = |n: u32| {
        record(
            &floor,
            200 + n,
            "pallet_closed",
            pallet_closed(
                &pallet_id(n),
                &pallets,
                40,
                1,
                &instant(100, 0),
                &instant(150, 0),
            ),
        )
    };
    let mut holder = begin_write(&admin.app.state.pool).await.unwrap();
    let first = markiro_host::facts::receive(
        &mut holder,
        &floor.station,
        &closing(1),
        &admin.app.state.timestamp(),
        &mut None,
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(first).unwrap(),
        accepted(&record_id(201))
    );
    let second = [closing(2)];
    let mut waiting = Box::pin(receive_as(&admin, &floor.station, &second));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(200), &mut waiting)
            .await
            .is_err(),
        "the batch answered while another writer held the lock"
    );
    holder.commit().await.unwrap();
    assert_eq!(
        waiting.await,
        (
            StatusCode::OK,
            json!({ "receipts": [rejected(Some(&record_id(202)), "sscc_taken", None)] })
        )
    );
    assert_eq!(
        pallet_row(&admin, &pallet_id(2)).await.unwrap()[3],
        Value::Null
    );
}

/// A batch is written whole or not at all: a pallet close that fails in the
/// database after its pallet row was written leaves nothing of the batch,
/// its boxes included, and the same batch goes through afterwards.
#[tokio::test]
async fn a_pallet_close_is_written_with_its_batch_or_not_at_all() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    let mut batch = Vec::new();
    batch.extend(boxed(&floor, &block, 1, Some(&pallet_id(1))));
    batch.push(record(
        &floor,
        201,
        "pallet_closed",
        pallet_closed(
            &pallet_id(1),
            &pallets,
            40,
            1,
            &instant(100, 0),
            &instant(150, 0),
        ),
    ));
    // The pallet block refuses its update after the pallet row was written.
    sqlx::query(
        "CREATE TRIGGER break_the_pallet_block BEFORE UPDATE ON sscc_blocks \
         WHEN NEW.consumed_through = 40 BEGIN SELECT RAISE(ABORT, 'broken'); END",
    )
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    let (status, failed) = send_facts(&admin.app, &floor.key, &batch).await;
    assert_eq!(
        (status, failed["error"]["code"].clone()),
        (StatusCode::INTERNAL_SERVER_ERROR, json!("internal"))
    );
    assert_eq!(pallet_count(&admin).await, 0);
    assert_eq!(box_pallets(&admin).await, vec![]);
    assert_eq!(consumed_through(&admin, &block).await, None);
    sqlx::query("DROP TRIGGER break_the_pallet_block")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let answered = receipts(&admin.app, &floor.key, &batch).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
    assert_eq!(consumed_through(&admin, &pallets).await, Some(40));
}

/// The schema holds what no pallet row may break: a closed pallet is whole
/// (its SSCC, block, serial and count together), its SSCC is a pallet's,
/// one SSCC and one serial of a block are one pallet, a pallet taken apart
/// was closed, and only a closed box is on a pallet.
#[tokio::test]
async fn the_schema_refuses_the_pallet_rows_no_fact_may_leave() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    let mut batch = Vec::new();
    batch.extend(boxed(&floor, &block, 1, Some(&pallet_id(1))));
    batch.extend(boxed(&floor, &block, 2, Some(&pallet_id(2))));
    batch.push(record(
        &floor,
        201,
        "pallet_closed",
        pallet_closed(
            &pallet_id(1),
            &pallets,
            40,
            1,
            &instant(100, 0),
            &instant(150, 0),
        ),
    ));
    batch.push(record(
        &floor,
        3,
        "scan",
        ok_scan(3, &box_id(3), &instant(3, 0)),
    ));
    receipts(&admin.app, &floor.key, &batch).await;
    let closed = pallet_id(1);
    let open = pallet_id(2);
    let refuses = |sql: String| {
        let pool = admin.app.state.pool.clone();
        async move {
            sqlx::query(&sql)
                .execute(&pool)
                .await
                .err()
                .unwrap_or_else(|| panic!("the schema took {sql:?}"))
                .to_string()
        }
    };
    for (sql, constraint) in [
        (
            format!("UPDATE pallets SET sscc = NULL WHERE id = '{closed}'"),
            "CHECK",
        ),
        (
            format!("UPDATE pallets SET block_id = NULL WHERE id = '{closed}'"),
            "CHECK",
        ),
        (
            format!("UPDATE pallets SET serial = NULL WHERE id = '{closed}'"),
            "CHECK",
        ),
        (
            format!("UPDATE pallets SET box_count_reported = NULL WHERE id = '{closed}'"),
            "CHECK",
        ),
        (
            format!("UPDATE pallets SET box_count_reported = 0 WHERE id = '{closed}'"),
            "CHECK",
        ),
        (
            format!(
                "UPDATE pallets SET sscc = '{}' WHERE id = '{closed}'",
                sscc_of(0, "460068200", 40)
            ),
            "CHECK",
        ),
        (
            format!("UPDATE pallets SET disassembled_at = 'x' WHERE id = '{open}'"),
            "CHECK",
        ),
        (
            format!(
                "UPDATE pallets SET closed_at = 'x', sscc = '{}', block_id = '{}', serial = 41, \
                 box_count_reported = 1 WHERE id = '{open}'",
                pallet_sscc(40),
                pallets["id"].as_str().unwrap()
            ),
            "UNIQUE",
        ),
        (
            format!(
                "UPDATE pallets SET closed_at = 'x', sscc = '{}', block_id = '{}', serial = 40, \
                 box_count_reported = 1 WHERE id = '{open}'",
                pallet_sscc(41),
                pallets["id"].as_str().unwrap()
            ),
            "UNIQUE",
        ),
        (
            format!(
                "UPDATE boxes SET pallet_id = '{open}' WHERE id = '{}'",
                box_id(3)
            ),
            "CHECK",
        ),
    ] {
        let message = refuses(sql.clone()).await;
        assert!(message.contains(constraint), "{sql}: {message}");
    }
    // The rows the facts wrote are what the schema takes.
    sqlx::query(&format!(
        "UPDATE pallets SET closed_at = 'x', sscc = '{}', block_id = '{}', serial = 41, \
         box_count_reported = 1 WHERE id = '{open}'",
        pallet_sscc(41),
        pallets["id"].as_str().unwrap()
    ))
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

// Tests beyond the plan's own: the pallet's SSCC form, replays, overlapping
// blocks, late closes, refused records that must leave no pallet, and the
// station's counts kept as evidence.

/// The kind a kept receipt of record `record` names.
async fn kept_receipt_kind(admin: &Admin, record: &str) -> Option<String> {
    sqlx::query_scalar("SELECT kind FROM fact_receipts WHERE record_id = ?")
        .bind(record)
        .fetch_optional(&admin.app.state.pool)
        .await
        .unwrap()
}

async fn receipt_count(admin: &Admin) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM fact_receipts")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

/// `names_serial` reads the first 17 characters only, so the SSCC's form is
/// checked first: a pallet's SSCC is 18 digits, whatever its first 17 say.
/// A text of 17 digits, of 19, with a letter as its check digit or none at
/// all names no pallet; none of them takes the serial, which a right close
/// takes afterwards.
#[tokio::test]
async fn a_pallet_sscc_that_is_not_eighteen_digits_is_refused_whatever_its_first_seventeen_say() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    receipts(
        &admin.app,
        &floor.key,
        &boxed(&floor, &block, 1, Some(&pallet_id(1))),
    )
    .await;
    let right = pallet_sscc(40);
    let forms = [
        right[..17].to_owned(),
        format!("{}x", &right[..17]),
        format!("{right}0"),
        format!("{right}x"),
        format!("{}é", &right[..17]),
        format!("{}\n", &right[..17]),
        String::new(),
    ];
    let batch: Vec<Value> = forms
        .iter()
        .enumerate()
        .map(|(n, sscc)| {
            let mut data = pallet_closed(
                &pallet_id(1),
                &pallets,
                40,
                1,
                &instant(100, 0),
                &instant(150, 0),
            );
            data["sscc"] = json!(sscc);
            record(&floor, 400 + n as u32, "pallet_closed", data)
        })
        .collect();
    let expected: Vec<Value> = (0..forms.len())
        .map(|n| {
            rejected(
                Some(&record_id(400 + n as u32)),
                "invalid_record",
                Some("data.sscc"),
            )
        })
        .collect();
    assert_eq!(receipts(&admin.app, &floor.key, &batch).await, expected);
    assert_eq!(
        pallet_row(&admin, &pallet_id(1)).await.unwrap()[3],
        Value::Null
    );
    assert_eq!(consumed_through(&admin, &pallets).await, None);
    let close = record(
        &floor,
        450,
        "pallet_closed",
        pallet_closed(
            &pallet_id(1),
            &pallets,
            40,
            1,
            &instant(100, 0),
            &instant(150, 0),
        ),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[close]).await,
        vec![accepted(&record_id(450))]
    );
}

/// A pallet close comes again as it came and gets the receipt it had, even
/// after its block was revoked; with another body under the same id it is a
/// `payload_mismatch` and changes nothing; a refusal is kept for good, and
/// the corrected close goes under a new id. The same close under another id
/// changes nothing, whatever else the new record says.
#[tokio::test]
async fn a_pallet_close_comes_again_with_the_receipt_it_had_and_a_refusal_is_kept_for_good() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    let mut batch = Vec::new();
    batch.extend(boxed(&floor, &block, 1, Some(&pallet_id(1))));
    batch.extend(boxed(&floor, &block, 2, Some(&pallet_id(2))));
    receipts(&admin.app, &floor.key, &batch).await;
    let closing = |n: u32, serial: u64, boxes: u32| {
        pallet_closed(
            &pallet_id(n),
            &pallets,
            serial,
            boxes,
            &instant(100, 0),
            &instant(150, 0),
        )
    };
    let first = record(&floor, 201, "pallet_closed", closing(1, 40, 1));
    // A close the host refuses: serial 39 is in no block of this station.
    let refused = record(&floor, 210, "pallet_closed", closing(2, 39, 1));
    assert_eq!(
        receipts(&admin.app, &floor.key, &[first.clone(), refused.clone()]).await,
        vec![
            accepted(&record_id(201)),
            rejected(Some(&record_id(210)), "sscc_not_issued", None)
        ]
    );
    assert_eq!(
        kept_receipt_kind(&admin, &record_id(201)).await.as_deref(),
        Some("pallet_closed")
    );
    let row = pallet_row(&admin, &pallet_id(1)).await;
    let (kept, used) = (
        receipt_count(&admin).await,
        consumed_through(&admin, &pallets).await,
    );
    // The same bytes: the same receipts, nothing new.
    assert_eq!(
        receipts(&admin.app, &floor.key, &[first.clone(), refused.clone()]).await,
        vec![
            accepted(&record_id(201)),
            rejected(Some(&record_id(210)), "sscc_not_issued", None)
        ]
    );
    // Another body under a used id.
    let changed = record(&floor, 201, "pallet_closed", closing(1, 40, 3));
    let corrected = record(&floor, 210, "pallet_closed", closing(2, 41, 1));
    assert_eq!(
        receipts(&admin.app, &floor.key, &[changed, corrected]).await,
        vec![
            rejected(Some(&record_id(201)), "payload_mismatch", None),
            rejected(Some(&record_id(210)), "payload_mismatch", None)
        ]
    );
    assert_eq!(pallet_row(&admin, &pallet_id(1)).await, row);
    assert_eq!(
        pallet_row(&admin, &pallet_id(2)).await.unwrap()[3],
        Value::Null
    );
    assert_eq!(
        (
            receipt_count(&admin).await,
            consumed_through(&admin, &pallets).await
        ),
        (kept, used)
    );
    // The corrected close under a new id is taken.
    let sent_again = record(&floor, 211, "pallet_closed", closing(2, 41, 1));
    assert_eq!(
        receipts(&admin.app, &floor.key, &[sent_again]).await,
        vec![accepted(&record_id(211))]
    );
    // The pallet block is revoked: a close already answered keeps its
    // answer, and the same close of a closed pallet under a new id changes
    // nothing, whatever its body says besides the SSCC.
    sqlx::query("UPDATE sscc_blocks SET revoked_at = '2026-10-08T06:00:00Z' WHERE id = ?")
        .bind(pallets["id"].as_str().unwrap())
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let mut later = closing(1, 40, 9);
    later["closedAt"] = json!(instant(900, 0));
    later["openedAt"] = json!(instant(800, 0));
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[first, record(&floor, 212, "pallet_closed", later)]
        )
        .await,
        vec![accepted(&record_id(201)), accepted(&record_id(212))]
    );
    assert_eq!(pallet_row(&admin, &pallet_id(1)).await, row);
    assert_eq!(consumed_through(&admin, &pallets).await, Some(41));
}

/// One label is one pallet even where two blocks of a counter overlap (a
/// repaired counter, say): the SSCC alone holds the serial, so a second
/// pallet on it under the other block is `sscc_taken` and not a database
/// error that would fail every batch it came in.
#[tokio::test]
async fn one_sscc_is_one_pallet_even_under_another_block_that_covers_its_serial() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    sqlx::query(
        "INSERT INTO sscc_blocks (id, issuer_prefix, extension, device_id, request_id, \
         from_serial, to_serial, issued_at) \
         VALUES ('d0000000-0000-4000-8000-000000000001', '460068200', 1, ?, ?, 100, 300, \
         '2026-10-08T06:00:00Z')",
    )
    .bind(&floor.station)
    .bind(OTHER_REQUEST)
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    let overlapping = json!({ "id": "d0000000-0000-4000-8000-000000000001" });
    let mut batch = Vec::new();
    batch.extend(boxed(&floor, &block, 1, Some(&pallet_id(1))));
    batch.extend(boxed(&floor, &block, 2, Some(&pallet_id(2))));
    receipts(&admin.app, &floor.key, &batch).await;
    let first = record(
        &floor,
        201,
        "pallet_closed",
        pallet_closed(
            &pallet_id(1),
            &pallets,
            150,
            1,
            &instant(100, 0),
            &instant(150, 0),
        ),
    );
    let second = record(
        &floor,
        202,
        "pallet_closed",
        pallet_closed(
            &pallet_id(2),
            &overlapping,
            150,
            1,
            &instant(100, 0),
            &instant(150, 0),
        ),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[first, second]).await,
        vec![
            accepted(&record_id(201)),
            rejected(Some(&record_id(202)), "sscc_taken", None)
        ]
    );
    assert_eq!(
        pallet_row(&admin, &pallet_id(2)).await.unwrap()[3],
        Value::Null
    );
}

/// A pallet's close that comes after the office closed the shift is a late
/// fact all the same: it is taken and marks the shift, as a box's does.
#[tokio::test]
async fn a_pallet_close_after_the_shift_was_closed_is_taken_and_marks_it_late() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    receipts(
        &admin.app,
        &floor.key,
        &boxed(&floor, &block, 1, Some(&pallet_id(1))),
    )
    .await;
    close_from_office(&admin, &floor.shift, "Станция не отвечает").await;
    let marked = |admin: &Admin| {
        let pool = admin.app.state.pool.clone();
        let shift = floor.shift.clone();
        async move {
            sqlx::query_scalar::<_, Option<String>>("SELECT late_data_at FROM shifts WHERE id = ?")
                .bind(shift)
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };
    assert_eq!(marked(&admin).await, None);
    let at = admin.app.state.timestamp();
    let close = record(
        &floor,
        201,
        "pallet_closed",
        pallet_closed(
            &pallet_id(1),
            &pallets,
            40,
            1,
            &instant(100, 0),
            &instant(150, 0),
        ),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[close]).await,
        vec![accepted(&record_id(201))]
    );
    assert_eq!(marked(&admin).await, Some(at));
    assert_eq!(consumed_through(&admin, &pallets).await, Some(40));
}

/// A record the host refuses leaves no pallet behind: a box that is
/// unknown, whose SSCC is no box block's or is taken, or whose block is a
/// pallet block, does not open the pallet it names.
#[tokio::test]
async fn a_box_the_host_refuses_opens_no_pallet() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    receipts(
        &admin.app,
        &floor.key,
        &boxed(&floor, &block, 1, Some(&pallet_id(1))),
    )
    .await;
    // Scans for boxes 2, 3 and 4 (box 5 is never scanned).
    let mut batch = Vec::new();
    for n in 2..=4 {
        batch.push(record(
            &floor,
            n,
            "scan",
            ok_scan(n, &box_id(n), &instant(n, 0)),
        ));
    }
    receipts(&admin.app, &floor.key, &batch).await;
    let close = |n: u32, box_n: u32, serial: u64, block: &Value, pallet: u32| {
        let mut data = box_closed(
            &box_id(box_n),
            block,
            serial,
            &[box_n],
            &instant(box_n, 0),
            &instant(100 + box_n, 0),
        );
        data["palletId"] = json!(pallet_id(pallet));
        record(&floor, 100 + n, "box_closed", data)
    };
    let batch = vec![
        // Box 5 was never scanned: unknown.
        close(5, 5, 1504, &block, 5),
        // Serial 1499 is in no block of this station.
        close(2, 2, 1499, &block, 6),
        // Serial 1500 is box 1's.
        close(3, 3, 1500, &block, 7),
        // A pallet block holds no box serial.
        close(4, 4, 50, &pallets, 8),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            rejected(Some(&record_id(105)), "box_unknown", None),
            rejected(Some(&record_id(102)), "sscc_not_issued", None),
            rejected(Some(&record_id(103)), "sscc_taken", None),
            rejected(Some(&record_id(104)), "sscc_not_issued", None),
        ]
    );
    for n in 5..=8 {
        assert_eq!(pallet_row(&admin, &pallet_id(n)).await, None, "{n}");
    }
    assert_eq!(pallet_count(&admin).await, 1);
    assert_eq!(consumed_through(&admin, &block).await, Some(1500));
    assert_eq!(consumed_through(&admin, &pallets).await, None);
}

/// What the station counted is evidence the host keeps, not a rule it
/// enforces: a close that counts more boxes than the pallet's capacity, or
/// other than the boxes the host holds, or that opened after it closed, is
/// taken as sent (the reports compare; plan О-Х). A change of that decision
/// must be deliberate, so it is pinned.
#[tokio::test]
async fn the_stations_count_and_instants_of_a_pallet_are_kept_as_sent() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    let mut batch = Vec::new();
    batch.extend(boxed(&floor, &block, 1, Some(&pallet_id(1))));
    batch.extend(boxed(&floor, &block, 2, Some(&pallet_id(1))));
    batch.extend(boxed(&floor, &block, 3, Some(&pallet_id(2))));
    receipts(&admin.app, &floor.key, &batch).await;
    // Capacity is 40: the first close counts 41, the host holds two boxes;
    // the second counts one for a box it holds, closing before it opened.
    let over = record(
        &floor,
        201,
        "pallet_closed",
        pallet_closed(
            &pallet_id(1),
            &pallets,
            40,
            41,
            &instant(100, 0),
            &instant(150, 0),
        ),
    );
    let backwards = record(
        &floor,
        202,
        "pallet_closed",
        pallet_closed(
            &pallet_id(2),
            &pallets,
            41,
            1,
            &instant(150, 0),
            &instant(100, 0),
        ),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[over, backwards]).await,
        vec![accepted(&record_id(201)), accepted(&record_id(202))]
    );
    let count: i64 = sqlx::query_scalar("SELECT box_count_reported FROM pallets WHERE id = ?")
        .bind(pallet_id(1))
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 41);
    let (opened, closed): (String, String) =
        sqlx::query_as("SELECT opened_at, closed_at FROM pallets WHERE id = ?")
            .bind(pallet_id(2))
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!((opened, closed), (instant(150, 0), instant(100, 0)));
}

/// A serial in a block of another issuer prefix is not this shift's, though
/// the SSCC names the shift's prefix and a serial inside the block's range;
/// the SSCC under the block's own prefix is not the shift's either.
#[tokio::test]
async fn a_pallet_serial_in_a_block_of_another_issuer_prefix_is_not_issued() {
    let (admin, floor, block, _) = pallet_floor().await;
    sqlx::query(
        "INSERT INTO sscc_counters (issuer_prefix, extension, next_serial, rev) \
         VALUES ('460068201', 1, 0, 1)",
    )
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO sscc_blocks (id, issuer_prefix, extension, device_id, request_id, \
         from_serial, to_serial, issued_at) \
         VALUES ('d0000000-0000-4000-8000-000000000002', '460068201', 1, ?, ?, 300, 399, \
         '2026-10-08T06:00:00Z')",
    )
    .bind(&floor.station)
    .bind(OTHER_REQUEST)
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    let foreign = json!({ "id": "d0000000-0000-4000-8000-000000000002" });
    receipts(
        &admin.app,
        &floor.key,
        &boxed(&floor, &block, 1, Some(&pallet_id(1))),
    )
    .await;
    let mut shifts_prefix = pallet_closed(
        &pallet_id(1),
        &foreign,
        350,
        1,
        &instant(100, 0),
        &instant(150, 0),
    );
    shifts_prefix["sscc"] = json!(pallet_sscc(350));
    let mut blocks_prefix = shifts_prefix.clone();
    blocks_prefix["sscc"] = json!(sscc_of(1, "460068201", 350));
    let batch = vec![
        record(&floor, 201, "pallet_closed", shifts_prefix),
        record(&floor, 202, "pallet_closed", blocks_prefix),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            rejected(Some(&record_id(201)), "sscc_not_issued", None),
            rejected(Some(&record_id(202)), "sscc_not_issued", None),
        ]
    );
    assert_eq!(
        pallet_row(&admin, &pallet_id(1)).await.unwrap()[3],
        Value::Null
    );
}
