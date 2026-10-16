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
    accepted, admin, audit_rows, box_closed, box_exception, box_id, close_from_office, fact,
    host_revision, instant, issue_block, issue_pallet_block, ok_scan, open_floor,
    open_pallet_floor, pair_device, pallet_closed, pallet_id, pallet_sscc, receipts, record_id,
    rejected, send_facts, shift_setup, sscc_of, Admin, Floor,
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
            key_hash: None,
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

/// Two closed pallets (1 with box 1, 2 with box 2), an open one (3 with
/// box 3), as the floor's first facts.
async fn three_pallets(admin: &Admin, floor: &Floor, block: &Value, pallets: &Value) {
    let mut batch = Vec::new();
    for n in 1..=3 {
        batch.extend(boxed(floor, block, n, Some(&pallet_id(n))));
    }
    for n in 1..=2 {
        batch.push(record(
            floor,
            200 + n,
            "pallet_closed",
            pallet_closed(
                &pallet_id(n),
                pallets,
                39 + u64::from(n),
                1,
                &instant(100, 0),
                &instant(150, 0),
            ),
        ));
    }
    let answered = receipts(&admin.app, &floor.key, &batch).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
}

/// A pallet's label checks and when it was taken apart: `(verified at,
/// skipped at, disassembled at)`.
async fn pallet_marks(admin: &Admin, id: &str) -> (Option<String>, Option<String>, Option<String>) {
    sqlx::query_as(
        "SELECT print_verified_at, print_skipped_at, disassembled_at FROM pallets WHERE id = ?",
    )
    .bind(id)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap()
}

fn label(pallet: &str, outcome: &str, at: &str) -> Value {
    json!({ "palletId": pallet, "outcome": outcome, "at": at })
}

fn pallet_exception(kind: &str, pallet: &str, reason: &str, text: Value, at: &str) -> Value {
    json!({
        "exception": kind, "palletId": pallet, "reasonCode": reason, "reasonText": text,
        "occurredAt": at
    })
}

/// A label check marks a closed pallet of this device and shift with the
/// station's instant, `verified` or `skipped`, a later check again; an open
/// pallet is `pallet_state`, an unknown one `pallet_unknown`.
#[tokio::test]
async fn a_pallet_label_check_marks_a_closed_pallet_of_its_own() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    three_pallets(&admin, &floor, &block, &pallets).await;
    let batch = vec![
        record(
            &floor,
            301,
            "pallet_label",
            label(&pallet_id(1), "verified", &instant(160, 0)),
        ),
        record(
            &floor,
            302,
            "pallet_label",
            label(&pallet_id(2), "skipped", &instant(161, 0)),
        ),
        record(
            &floor,
            303,
            "pallet_label",
            label(&pallet_id(3), "verified", &instant(162, 0)),
        ),
        record(
            &floor,
            304,
            "pallet_label",
            label(&pallet_id(9), "verified", &instant(163, 0)),
        ),
        record(
            &floor,
            305,
            "pallet_label",
            label(&pallet_id(1), "verified", &instant(170, 0)),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            accepted(&record_id(301)),
            accepted(&record_id(302)),
            rejected(Some(&record_id(303)), "pallet_state", None),
            rejected(Some(&record_id(304)), "pallet_unknown", None),
            accepted(&record_id(305)),
        ]
    );
    assert_eq!(
        pallet_marks(&admin, &pallet_id(1)).await,
        (Some(instant(170, 0)), None, None)
    );
    assert_eq!(
        pallet_marks(&admin, &pallet_id(2)).await,
        (None, Some(instant(161, 0)), None)
    );
    assert_eq!(
        pallet_marks(&admin, &pallet_id(3)).await,
        (None, None, None)
    );
    // Its form: the pallet's id and the instant.
    let bad = vec![
        record(
            &floor,
            306,
            "pallet_label",
            label("pallet-1", "verified", &instant(171, 0)),
        ),
        record(
            &floor,
            307,
            "pallet_label",
            label(&pallet_id(1), "verified", "2026-10-08T06:02:51Z"),
        ),
        record(
            &floor,
            308,
            "pallet_label",
            label(&pallet_id(1), "seen", &instant(171, 0)),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &bad).await,
        vec![
            rejected(
                Some(&record_id(306)),
                "invalid_record",
                Some("data.palletId")
            ),
            rejected(Some(&record_id(307)), "invalid_record", Some("data.at")),
            rejected(Some(&record_id(308)), "invalid_record", Some("data")),
        ]
    );
}

/// A reprint or a disassembly takes a closed pallet not taken apart and a
/// reason code of its kind, with words only for `other`; a disassembly
/// marks the pallet and leaves its boxes as they are; each is kept, field
/// by field.
#[tokio::test]
async fn a_pallet_reprint_or_disassembly_needs_a_closed_pallet_and_a_reason() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    three_pallets(&admin, &floor, &block, &pallets).await;
    let exception = |n: u32, data: Value| record(&floor, n, "pallet_exception", data);
    let batch = vec![
        exception(
            401,
            pallet_exception(
                "reprint",
                &pallet_id(1),
                "damaged_label",
                Value::Null,
                &instant(160, 0),
            ),
        ),
        exception(
            402,
            pallet_exception(
                "disassemble",
                &pallet_id(1),
                "other",
                json!("  Перепутали товар  "),
                &instant(161, 0),
            ),
        ),
        exception(
            403,
            pallet_exception(
                "reprint",
                &pallet_id(1),
                "damaged_label",
                Value::Null,
                &instant(162, 0),
            ),
        ),
        exception(
            404,
            pallet_exception(
                "disassemble",
                &pallet_id(1),
                "wrong_product",
                Value::Null,
                &instant(163, 0),
            ),
        ),
        exception(
            405,
            pallet_exception(
                "reprint",
                &pallet_id(3),
                "printer_jam",
                Value::Null,
                &instant(164, 0),
            ),
        ),
        exception(
            406,
            pallet_exception(
                "reprint",
                &pallet_id(9),
                "printer_jam",
                Value::Null,
                &instant(165, 0),
            ),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            accepted(&record_id(401)),
            accepted(&record_id(402)),
            rejected(Some(&record_id(403)), "pallet_state", None),
            rejected(Some(&record_id(404)), "pallet_state", None),
            rejected(Some(&record_id(405)), "pallet_state", None),
            rejected(Some(&record_id(406)), "pallet_unknown", None),
        ]
    );
    assert_eq!(
        pallet_marks(&admin, &pallet_id(1)).await,
        (None, None, Some(instant(161, 0)))
    );
    // The pallet's box stays on it, closed and not taken apart; the SSCC
    // stays the pallet's.
    let (pallet, disassembled): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT pallet_id, disassembled_at FROM boxes WHERE id = ?")
            .bind(box_id(1))
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!((pallet, disassembled), (Some(pallet_id(1)), None));
    assert_eq!(
        pallet_row(&admin, &pallet_id(1)).await.unwrap()[4],
        json!(pallet_sscc(40))
    );
    type ExceptionRow = (
        String,
        String,
        String,
        Option<String>,
        String,
        String,
        Option<String>,
        String,
        String,
    );
    let rows: Vec<ExceptionRow> = sqlx::query_as(
        "SELECT record_id, kind, reason_code, reason_text, shift_id, device_id, operator_id, \
         occurred_at, received_at FROM pallet_exceptions ORDER BY occurred_at",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    let at = admin.app.state.timestamp();
    assert_eq!(
        rows,
        vec![
            (
                record_id(401),
                "reprint".to_owned(),
                "damaged_label".to_owned(),
                None,
                floor.shift.clone(),
                floor.station.clone(),
                Some(OPERATOR.to_owned()),
                instant(160, 0),
                at.clone()
            ),
            (
                record_id(402),
                "disassemble".to_owned(),
                "other".to_owned(),
                Some("Перепутали товар".to_owned()),
                floor.shift.clone(),
                floor.station.clone(),
                Some(OPERATOR.to_owned()),
                instant(161, 0),
                at
            ),
        ]
    );
    // The reason fits the kind; words go only with `other`.
    let refused = vec![
        exception(
            411,
            pallet_exception(
                "reprint",
                &pallet_id(2),
                "wrong_product",
                Value::Null,
                &instant(170, 0),
            ),
        ),
        exception(
            412,
            pallet_exception(
                "disassemble",
                &pallet_id(2),
                "printer_jam",
                Value::Null,
                &instant(171, 0),
            ),
        ),
        exception(
            413,
            pallet_exception(
                "reprint",
                &pallet_id(2),
                "printer_jam",
                json!("Застрял"),
                &instant(172, 0),
            ),
        ),
        exception(
            414,
            pallet_exception(
                "reprint",
                &pallet_id(2),
                "other",
                json!("   "),
                &instant(173, 0),
            ),
        ),
        exception(
            415,
            pallet_exception(
                "reprint",
                &pallet_id(2),
                "other",
                json!("я".repeat(201)),
                &instant(174, 0),
            ),
        ),
        exception(
            416,
            pallet_exception(
                "reprint",
                "pallet-2",
                "printer_jam",
                Value::Null,
                &instant(175, 0),
            ),
        ),
        exception(
            417,
            pallet_exception(
                "reprint",
                &pallet_id(2),
                "printer_jam",
                Value::Null,
                "today",
            ),
        ),
        exception(
            418,
            pallet_exception(
                "undo",
                &pallet_id(2),
                "printer_jam",
                Value::Null,
                &instant(176, 0),
            ),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &refused).await,
        vec![
            rejected(
                Some(&record_id(411)),
                "invalid_record",
                Some("data.reasonCode")
            ),
            rejected(
                Some(&record_id(412)),
                "invalid_record",
                Some("data.reasonCode")
            ),
            rejected(
                Some(&record_id(413)),
                "invalid_record",
                Some("data.reasonText")
            ),
            rejected(
                Some(&record_id(414)),
                "invalid_record",
                Some("data.reasonText")
            ),
            rejected(
                Some(&record_id(415)),
                "invalid_record",
                Some("data.reasonText")
            ),
            rejected(
                Some(&record_id(416)),
                "invalid_record",
                Some("data.palletId")
            ),
            rejected(
                Some(&record_id(417)),
                "invalid_record",
                Some("data.occurredAt")
            ),
            rejected(Some(&record_id(418)), "invalid_record", Some("data")),
        ]
    );
    // 200 characters of `other` are taken.
    let longest = exception(
        419,
        pallet_exception(
            "reprint",
            &pallet_id(2),
            "other",
            json!("я".repeat(200)),
            &instant(177, 0),
        ),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[longest]).await,
        vec![accepted(&record_id(419))]
    );
    // A label check of the pallet taken apart is still taken (it is closed).
    let check = record(
        &floor,
        420,
        "pallet_label",
        label(&pallet_id(1), "verified", &instant(180, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[check]).await,
        vec![accepted(&record_id(420))]
    );
}

/// A shift without pallets answers a label check and an exception of a
/// pallet `no_pallets`.
#[tokio::test]
async fn a_shift_without_pallets_answers_pallet_checks_and_exceptions_no_pallets() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let batch = vec![
        record(
            &floor,
            301,
            "pallet_label",
            label(&pallet_id(1), "verified", &instant(160, 0)),
        ),
        record(
            &floor,
            401,
            "pallet_exception",
            pallet_exception(
                "reprint",
                &pallet_id(1),
                "printer_jam",
                Value::Null,
                &instant(161, 0),
            ),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            rejected(Some(&record_id(301)), "no_pallets", None),
            rejected(Some(&record_id(401)), "no_pallets", None),
        ]
    );
}

/// The schema keeps a pallet exception whole: one row per record, a known
/// kind, a reason code, and words only with `other`.
#[tokio::test]
async fn the_schema_refuses_the_pallet_exception_rows_no_fact_may_leave() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    three_pallets(&admin, &floor, &block, &pallets).await;
    let reprint = record(
        &floor,
        401,
        "pallet_exception",
        pallet_exception(
            "reprint",
            &pallet_id(1),
            "printer_jam",
            Value::Null,
            &instant(160, 0),
        ),
    );
    receipts(&admin.app, &floor.key, &[reprint]).await;
    let insert = |record: &str, kind: &str, reason: &str, text: &str| {
        format!(
            "INSERT INTO pallet_exceptions (id, record_id, kind, pallet_id, reason_code, \
             reason_text, shift_id, device_id, operator_id, occurred_at, received_at) \
             SELECT '{record}-row', '{record}', '{kind}', pallet_id, '{reason}', {text}, \
             shift_id, device_id, operator_id, occurred_at, received_at FROM pallet_exceptions"
        )
    };
    for (sql, constraint) in [
        (
            insert(&record_id(401), "reprint", "printer_jam", "NULL"),
            "UNIQUE",
        ),
        (
            insert(&record_id(402), "undo", "printer_jam", "NULL"),
            "CHECK",
        ),
        (
            insert(&record_id(403), "reprint", "printer_jam", "'Застрял'"),
            "CHECK",
        ),
    ] {
        let message = sqlx::query(&sql)
            .execute(&admin.app.state.pool)
            .await
            .err()
            .unwrap_or_else(|| panic!("the schema took {sql:?}"))
            .to_string();
        assert!(message.contains(constraint), "{sql}: {message}");
    }
    sqlx::query(&insert(
        &record_id(404),
        "disassemble",
        "other",
        "'Перепутали'",
    ))
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

/// The office's totals of a shift with pallets count its closed pallets
/// that were not taken apart and its open pallets that hold a box not taken
/// apart; the list and the shift's own answer agree.
#[tokio::test]
async fn the_office_reads_a_shifts_pallets_from_its_facts() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    // Pallet 1 closes with boxes 1 and 2, pallet 2 closes with box 3 and is
    // taken apart, pallet 3 stays open with box 4, pallet 4 stays open and
    // its only box 5 is taken apart, pallet 5 closes with box 6.
    let mut batch = Vec::new();
    for (box_n, pallet) in [(1, 1), (2, 1), (3, 2), (4, 3), (5, 4), (6, 5)] {
        batch.extend(boxed(&floor, &block, box_n, Some(&pallet_id(pallet))));
    }
    for (n, pallet, serial) in [(201, 1, 40), (202, 2, 41), (203, 5, 42)] {
        batch.push(record(
            &floor,
            n,
            "pallet_closed",
            pallet_closed(
                &pallet_id(pallet),
                &pallets,
                serial,
                1,
                &instant(100, 0),
                &instant(150, 0),
            ),
        ));
    }
    batch.push(record(
        &floor,
        301,
        "pallet_exception",
        pallet_exception(
            "disassemble",
            &pallet_id(2),
            "wrong_product",
            Value::Null,
            &instant(160, 0),
        ),
    ));
    let mut apart = box_exception("disassemble", &box_id(5), &instant(161, 0));
    apart["reasonCode"] = json!("damaged_package");
    batch.push(record(&floor, 302, "box_exception", apart));
    admin.app.clock.advance(time::Duration::minutes(5));
    let at = admin.app.state.timestamp();
    let answered = receipts(&admin.app, &floor.key, &batch).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
    let (status, shift) = admin
        .call("GET", &format!("/v1/office/shifts/{}", floor.shift), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{shift}");
    assert_eq!(
        shift["totals"],
        json!({
            "acceptedUnits": 5, "unitsInClosedBoxes": 5, "closedBoxes": 5, "openBoxes": 0,
            "lastFactAt": at, "deviceIds": [floor.station],
            "closedPallets": 2, "openPallets": 1
        })
    );
    let (_, list) = admin.call("GET", "/v1/office/shifts", None).await;
    assert_eq!(list[0]["totals"], shift["totals"]);
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

// Tests beyond the plan's own for the pallet label and exception facts
// (plan ПЛ-Х task 5): the scope of a pallet, replays, the effect of a
// disassembly, the form of the data and the batch's rollback.

async fn pallet_exception_count(admin: &Admin) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM pallet_exceptions")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

/// A pallet's marks: `(id, verified at, skipped at, disassembled at)`.
type PalletMarks = (String, Option<String>, Option<String>, Option<String>);

/// Every pallet's marks.
async fn every_pallet_mark(admin: &Admin) -> Vec<PalletMarks> {
    sqlx::query_as(
        "SELECT id, print_verified_at, print_skipped_at, disassembled_at FROM pallets ORDER BY id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap()
}

/// Every box as a pallet fact may leave it: `(id, pallet, closed at,
/// disassembled at)`.
async fn every_box(admin: &Admin) -> Vec<(String, Option<String>, Option<String>, Option<String>)> {
    sqlx::query_as("SELECT id, pallet_id, closed_at, disassembled_at FROM boxes ORDER BY id")
        .fetch_all(&admin.app.state.pool)
        .await
        .unwrap()
}

/// What a pallet fact never changes of a pallet: `(id, shift, device,
/// closed at, sscc, block, serial, count reported, operator, received at)`.
type PalletBody = (
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

async fn every_pallet_body(admin: &Admin) -> Vec<PalletBody> {
    sqlx::query_as(
        "SELECT id, shift_id, device_id, closed_at, sscc, block_id, serial, \
         box_count_reported, operator_id, received_at FROM pallets ORDER BY id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap()
}

/// A label check and an exception name a pallet of their own device and
/// shift: a closed pallet of another shift of the same station, and one of
/// another station, are `pallet_unknown` for both kinds, and nothing is
/// marked or written; the same records are fine for the pallet's own shift.
#[tokio::test]
async fn a_pallet_label_or_exception_of_another_device_or_shift_is_unknown() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_pallet_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    // A closed pallet of this station in a second shift of its line.
    let second = open_pallet_floor(&admin, &setup, &floor.key, &setup.line).await;
    let mut batch = Vec::new();
    batch.extend(boxed(&second, &block, 2, Some(&pallet_id(70))));
    batch.push(record(
        &second,
        270,
        "pallet_closed",
        pallet_closed(
            &pallet_id(70),
            &pallets,
            40,
            1,
            &instant(100, 0),
            &instant(150, 0),
        ),
    ));
    let answered = receipts(&admin.app, &floor.key, &batch).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
    // A closed pallet of the colleague's station in the colleague's shift.
    sqlx::query(
        "INSERT INTO pallets (id, shift_id, device_id, opened_at, closed_at, sscc, block_id, \
         serial, box_count_reported, received_at) \
         VALUES (?, ?, ?, '2026-10-08T06:00:00.000Z', '2026-10-08T06:30:00.000Z', ?, ?, 41, 1, \
         '2026-10-08T06:30:00Z')",
    )
    .bind(pallet_id(80))
    .bind(&colleague.shift)
    .bind(&colleague.station)
    .bind(pallet_sscc(41))
    .bind(pallets["id"].as_str().unwrap())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    let marks = every_pallet_mark(&admin).await;
    let batch = vec![
        record(
            &floor,
            301,
            "pallet_label",
            label(&pallet_id(70), "verified", &instant(160, 0)),
        ),
        record(
            &floor,
            302,
            "pallet_label",
            label(&pallet_id(80), "skipped", &instant(161, 0)),
        ),
        record(
            &floor,
            401,
            "pallet_exception",
            pallet_exception(
                "disassemble",
                &pallet_id(70),
                "wrong_product",
                Value::Null,
                &instant(162, 0),
            ),
        ),
        record(
            &floor,
            402,
            "pallet_exception",
            pallet_exception(
                "reprint",
                &pallet_id(80),
                "printer_jam",
                Value::Null,
                &instant(163, 0),
            ),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            rejected(Some(&record_id(301)), "pallet_unknown", None),
            rejected(Some(&record_id(302)), "pallet_unknown", None),
            rejected(Some(&record_id(401)), "pallet_unknown", None),
            rejected(Some(&record_id(402)), "pallet_unknown", None),
        ]
    );
    assert_eq!(every_pallet_mark(&admin).await, marks);
    assert_eq!(pallet_exception_count(&admin).await, 0);
    // The pallet's own shift takes the same check and exception.
    let own = vec![
        record(
            &second,
            303,
            "pallet_label",
            label(&pallet_id(70), "verified", &instant(160, 0)),
        ),
        record(
            &second,
            403,
            "pallet_exception",
            pallet_exception(
                "reprint",
                &pallet_id(70),
                "printer_jam",
                Value::Null,
                &instant(163, 0),
            ),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &own).await,
        vec![accepted(&record_id(303)), accepted(&record_id(403))]
    );
}

/// A check or an exception sent again gets the receipt it had and changes
/// nothing, whatever was written since: an older check does not overwrite a
/// later one, a disassembly keeps its instant, a refusal stays a refusal
/// after the pallet became fit. Another body under a used id is a
/// `payload_mismatch`; the same exception under a new id is a second one,
/// refused as a second disassembly. Each kind is kept under its own name.
#[tokio::test]
async fn a_pallet_label_or_exception_comes_again_with_the_receipt_it_had() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    three_pallets(&admin, &floor, &block, &pallets).await;
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let first = record(
        &floor,
        301,
        "pallet_label",
        label(&pallet_id(1), "verified", &instant(160, 0)),
    );
    let later = record(
        &floor,
        302,
        "pallet_label",
        label(&pallet_id(1), "verified", &instant(170, 0)),
    );
    let apart = record(
        &floor,
        401,
        "pallet_exception",
        pallet_exception(
            "disassemble",
            &pallet_id(1),
            "other",
            json!("Перепутали товар"),
            &instant(180, 0),
        ),
    );
    let early = record(
        &floor,
        402,
        "pallet_exception",
        pallet_exception(
            "reprint",
            &pallet_id(3),
            "printer_jam",
            Value::Null,
            &instant(181, 0),
        ),
    );
    let batch = [first, later, apart, early];
    let expected = vec![
        accepted(&record_id(301)),
        accepted(&record_id(302)),
        accepted(&record_id(401)),
        rejected(Some(&record_id(402)), "pallet_state", None),
    ];
    assert_eq!(receipts(&admin.app, &floor.key, &batch).await, expected);
    for (record, kind) in [
        (301, "pallet_label"),
        (302, "pallet_label"),
        (401, "pallet_exception"),
        (402, "pallet_exception"),
    ] {
        assert_eq!(
            kept_receipt_kind(&admin, &record_id(record))
                .await
                .as_deref(),
            Some(kind),
            "record {record}"
        );
    }
    // Pallet 3 closes now: a new reprint of it would be taken.
    let closing = record(
        &floor,
        203,
        "pallet_closed",
        pallet_closed(
            &pallet_id(3),
            &pallets,
            42,
            1,
            &instant(100, 0),
            &instant(190, 0),
        ),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[closing]).await,
        vec![accepted(&record_id(203))]
    );
    let (marks, kept) = (every_pallet_mark(&admin).await, receipt_count(&admin).await);
    assert_eq!(
        marks[0],
        (
            pallet_id(1),
            Some(instant(170, 0)),
            None,
            Some(instant(180, 0))
        )
    );
    assert_eq!(pallet_exception_count(&admin).await, 1);
    // The same bytes: the same receipts, nothing new, the older check does
    // not take the mark back, the refusal of the open pallet stands.
    assert_eq!(receipts(&admin.app, &floor.key, &batch).await, expected);
    assert_eq!(every_pallet_mark(&admin).await, marks);
    assert_eq!(receipt_count(&admin).await, kept);
    assert_eq!(pallet_exception_count(&admin).await, 1);
    // Another body under a used id.
    let changed_check = record(
        &floor,
        301,
        "pallet_label",
        label(&pallet_id(1), "skipped", &instant(160, 0)),
    );
    let changed_exception = record(
        &floor,
        401,
        "pallet_exception",
        pallet_exception(
            "disassemble",
            &pallet_id(1),
            "other",
            json!("Другие слова"),
            &instant(180, 0),
        ),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[changed_check, changed_exception]).await,
        vec![
            rejected(Some(&record_id(301)), "payload_mismatch", None),
            rejected(Some(&record_id(401)), "payload_mismatch", None)
        ]
    );
    assert_eq!(every_pallet_mark(&admin).await, marks);
    assert_eq!(pallet_exception_count(&admin).await, 1);
    // The same exception under a new id is a second disassembly.
    let again = record(
        &floor,
        410,
        "pallet_exception",
        pallet_exception(
            "disassemble",
            &pallet_id(1),
            "other",
            json!("Перепутали товар"),
            &instant(180, 0),
        ),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[again]).await,
        vec![rejected(Some(&record_id(410)), "pallet_state", None)]
    );
    assert_eq!(every_pallet_mark(&admin).await, marks);
    assert_eq!(pallet_exception_count(&admin).await, 1);
    // Pallet facts take no revision and write no audit row.
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

/// A reprint changes nothing of the pallet (its `closedAt` stays the first
/// close's); a disassembly sets one instant of the pallet and leaves the
/// rest: its SSCC, block, serial and count, its boxes with their pallet,
/// the other pallets and the block's use. The SSCC stays used: no other
/// pallet takes it, and the close of the pallet sent again does not revive
/// it. Reprints repeat; a label check of the pallet is still taken.
#[tokio::test]
async fn a_reprint_changes_nothing_and_a_disassembly_marks_only_its_pallet() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    three_pallets(&admin, &floor, &block, &pallets).await;
    let (rows, boxes, marks) = (
        every_pallet_body(&admin).await,
        every_box(&admin).await,
        every_pallet_mark(&admin).await,
    );
    let used = consumed_through(&admin, &pallets).await;
    let exception = |n: u32, kind: &str, pallet: u32, reason: &str, at: u32| {
        record(
            &floor,
            n,
            "pallet_exception",
            pallet_exception(
                kind,
                &pallet_id(pallet),
                reason,
                Value::Null,
                &instant(at, 0),
            ),
        )
    };
    // Two reprints, one of another pallet: nothing of any pallet changes.
    let reprints = vec![
        exception(401, "reprint", 1, "damaged_label", 160),
        exception(402, "reprint", 1, "printer_jam", 161),
        exception(403, "reprint", 2, "damaged_label", 162),
    ];
    let answered = receipts(&admin.app, &floor.key, &reprints).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
    assert_eq!(every_pallet_body(&admin).await, rows);
    assert_eq!(every_box(&admin).await, boxes);
    assert_eq!(every_pallet_mark(&admin).await, marks);
    assert_eq!(pallet_exception_count(&admin).await, 3);
    // The disassembly of pallet 1.
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[exception(404, "disassemble", 1, "wrong_product", 170)]
        )
        .await,
        vec![accepted(&record_id(404))]
    );
    assert_eq!(every_pallet_body(&admin).await, rows);
    assert_eq!(every_box(&admin).await, boxes);
    let mut apart = marks.clone();
    apart[0].3 = Some(instant(170, 0));
    assert_eq!(every_pallet_mark(&admin).await, apart);
    assert_eq!(consumed_through(&admin, &pallets).await, used);
    assert_eq!(pallet_exception_count(&admin).await, 4);
    // Its SSCC is taken for good.
    let theirs = vec![
        record(
            &floor,
            204,
            "pallet_closed",
            pallet_closed(
                &pallet_id(4),
                &pallets,
                40,
                1,
                &instant(100, 0),
                &instant(171, 0),
            ),
        ),
        record(
            &floor,
            205,
            "pallet_closed",
            pallet_closed(
                &pallet_id(1),
                &pallets,
                41,
                1,
                &instant(100, 0),
                &instant(172, 0),
            ),
        ),
        record(
            &floor,
            206,
            "pallet_closed",
            pallet_closed(
                &pallet_id(1),
                &pallets,
                40,
                1,
                &instant(100, 0),
                &instant(173, 0),
            ),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &theirs).await,
        vec![
            rejected(Some(&record_id(204)), "sscc_taken", None),
            rejected(Some(&record_id(205)), "pallet_already_closed", None),
            accepted(&record_id(206)),
        ]
    );
    assert_eq!(every_pallet_body(&admin).await, rows);
    assert_eq!(every_pallet_mark(&admin).await, apart);
    // The pallet taken apart takes no reprint and no second disassembly,
    // but its label check.
    let after = vec![
        exception(405, "reprint", 1, "damaged_label", 180),
        exception(406, "disassemble", 1, "wrong_product", 181),
        record(
            &floor,
            301,
            "pallet_label",
            label(&pallet_id(1), "skipped", &instant(182, 0)),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &after).await,
        vec![
            rejected(Some(&record_id(405)), "pallet_state", None),
            rejected(Some(&record_id(406)), "pallet_state", None),
            accepted(&record_id(301)),
        ]
    );
    apart[0].2 = Some(instant(182, 0));
    assert_eq!(every_pallet_mark(&admin).await, apart);
    assert_eq!(every_box(&admin).await, boxes);
    assert_eq!(pallet_exception_count(&admin).await, 4);
}

/// The form of a pallet check and of a pallet exception: no field beyond
/// the kind's, a reason code that is a string, words that are text.
#[tokio::test]
async fn a_pallet_check_and_a_pallet_exception_take_no_other_form() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    three_pallets(&admin, &floor, &block, &pallets).await;
    let marks = every_pallet_mark(&admin).await;
    let mut extra_check = label(&pallet_id(1), "verified", &instant(160, 0));
    extra_check["boxCount"] = json!(1);
    let reprint = || {
        pallet_exception(
            "reprint",
            &pallet_id(1),
            "printer_jam",
            Value::Null,
            &instant(160, 0),
        )
    };
    let mut extra_exception = reprint();
    extra_exception["boxId"] = json!(box_id(1));
    let mut no_reason = reprint();
    no_reason.as_object_mut().unwrap().remove("reasonCode");
    let mut null_reason = reprint();
    null_reason["reasonCode"] = Value::Null;
    let number_words = pallet_exception(
        "reprint",
        &pallet_id(1),
        "other",
        json!(7),
        &instant(160, 0),
    );
    let empty_reason =
        pallet_exception("reprint", &pallet_id(1), "", Value::Null, &instant(160, 0));
    let batch = vec![
        record(&floor, 301, "pallet_label", extra_check),
        record(&floor, 401, "pallet_exception", extra_exception),
        record(&floor, 402, "pallet_exception", no_reason),
        record(&floor, 403, "pallet_exception", null_reason),
        record(&floor, 404, "pallet_exception", number_words),
        record(&floor, 405, "pallet_exception", empty_reason),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            rejected(Some(&record_id(301)), "invalid_record", Some("data")),
            rejected(Some(&record_id(401)), "invalid_record", Some("data")),
            rejected(Some(&record_id(402)), "invalid_record", Some("data")),
            rejected(Some(&record_id(403)), "invalid_record", Some("data")),
            rejected(Some(&record_id(404)), "invalid_record", Some("data")),
            rejected(
                Some(&record_id(405)),
                "invalid_record",
                Some("data.reasonCode")
            ),
        ]
    );
    assert_eq!(every_pallet_mark(&admin).await, marks);
    assert_eq!(pallet_exception_count(&admin).await, 0);
}

/// A database error in a pallet check or exception fails the whole batch
/// with a 500: what the batch wrote before it, a mark or an exception of
/// another pallet, is gone, and the same batch goes through once the
/// database is well.
#[tokio::test]
async fn a_pallet_check_or_exception_is_written_with_its_batch_or_not_at_all() {
    let (admin, floor, block, pallets) = pallet_floor().await;
    three_pallets(&admin, &floor, &block, &pallets).await;
    let marks = every_pallet_mark(&admin).await;
    let kept = receipt_count(&admin).await;
    let check = |n: u32, pallet: u32, outcome: &str| {
        record(
            &floor,
            n,
            "pallet_label",
            label(&pallet_id(pallet), outcome, &instant(160 + n % 100, 0)),
        )
    };
    let exception = |n: u32, kind: &str, pallet: u32| {
        record(
            &floor,
            n,
            "pallet_exception",
            pallet_exception(
                kind,
                &pallet_id(pallet),
                if kind == "reprint" {
                    "printer_jam"
                } else {
                    "wrong_product"
                },
                Value::Null,
                &instant(160 + n % 100, 0),
            ),
        )
    };
    let cases = [
        (
            "the label mark of pallet 2",
            "CREATE TRIGGER broken BEFORE UPDATE OF print_skipped_at ON pallets \
             BEGIN SELECT RAISE(ABORT, 'broken'); END",
            vec![check(301, 1, "verified"), check(302, 2, "skipped")],
        ),
        (
            "the disassembly mark of pallet 2",
            "CREATE TRIGGER broken BEFORE UPDATE OF disassembled_at ON pallets \
             BEGIN SELECT RAISE(ABORT, 'broken'); END",
            vec![
                exception(403, "reprint", 1),
                exception(404, "disassemble", 2),
            ],
        ),
        (
            "the exception row of pallet 2",
            "CREATE TRIGGER broken BEFORE INSERT ON pallet_exceptions \
             WHEN NEW.kind = 'disassemble' BEGIN SELECT RAISE(ABORT, 'broken'); END",
            vec![
                exception(405, "reprint", 1),
                exception(406, "disassemble", 2),
            ],
        ),
    ];
    for (name, trigger, batch) in cases {
        sqlx::query(trigger)
            .execute(&admin.app.state.pool)
            .await
            .unwrap();
        let (status, failed) = send_facts(&admin.app, &floor.key, &batch).await;
        assert_eq!(
            (status, failed["error"]["code"].clone()),
            (StatusCode::INTERNAL_SERVER_ERROR, json!("internal")),
            "{name}"
        );
        assert_eq!(every_pallet_mark(&admin).await, marks, "{name}");
        assert_eq!(pallet_exception_count(&admin).await, 0, "{name}");
        assert_eq!(receipt_count(&admin).await, kept, "{name}");
        sqlx::query("DROP TRIGGER broken")
            .execute(&admin.app.state.pool)
            .await
            .unwrap();
        let answered = receipts(&admin.app, &floor.key, &batch).await;
        assert!(
            answered.iter().all(|r| r["outcome"] == "accepted"),
            "{name}: {answered:?}"
        );
        // Start the next case from the same state.
        for reset in [
            "UPDATE pallets SET print_verified_at = NULL, print_skipped_at = NULL, \
             disassembled_at = NULL",
            "DELETE FROM pallet_exceptions",
            "DELETE FROM fact_receipts WHERE kind IN ('pallet_label', 'pallet_exception')",
        ] {
            sqlx::query(reset)
                .execute(&admin.app.state.pool)
                .await
                .unwrap();
        }
    }
}

// Tests beyond the plan's own for the office's pallet totals (plan ПЛ-Х
// task 6): each shift counts its own pallets, a closed pallet counts with or
// without boxes, an open pallet counts once, and the answer of an office
// write carries the figures.

/// A shift's pallet counts as the office reads them: `(closedPallets,
/// openPallets)` of `GET /v1/office/shifts/{id}`.
async fn pallet_totals(admin: &Admin, shift: &str) -> (Value, Value) {
    let (status, body) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    (
        body["totals"]["closedPallets"].clone(),
        body["totals"]["openPallets"].clone(),
    )
}

/// Each shift's totals count the pallets of that shift only: two shifts with
/// pallets of different states and one without pallets read differently,
/// the list agrees shift by shift, a closed pallet counts whether its boxes
/// are alive, taken apart or not yet received, an open pallet counts once
/// however many boxes it holds, and the answer of the office's close of a
/// shift carries the figures.
#[tokio::test]
async fn each_shift_counts_its_own_pallets_and_a_pallet_counts_once() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_pallet_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let colleague_block = issue_block(&admin.app, &colleague.key, BLOCK_REQUEST).await;
    let colleague_pallets = issue_pallet_block(&admin.app, &colleague.key, PALLET_REQUEST).await;
    let (_, third_key) = pair_device(&admin.app, "station").await;
    let third = open_floor(&admin, &setup, &third_key, &setup.line).await;
    let third_block = issue_block(&admin.app, &third.key, BLOCK_REQUEST).await;

    let closing = |floor: &Floor, n: u32, pallet: u32, block: &Value, serial: u64| {
        record(
            floor,
            n,
            "pallet_closed",
            pallet_closed(
                &pallet_id(pallet),
                block,
                serial,
                1,
                &instant(100, 0),
                &instant(150, 0),
            ),
        )
    };
    // This station: pallet 1 closed with a live box, pallet 2 closed and its
    // only box (2) taken apart, pallet 3 closed before any box of it was
    // received, pallet 4 open with three boxes (3 and 5 live, 6 taken apart).
    let mut batch = Vec::new();
    for (box_n, pallet) in [(1, 1), (2, 2), (3, 4), (5, 4), (6, 4)] {
        batch.extend(boxed(&floor, &block, box_n, Some(&pallet_id(pallet))));
    }
    batch.push(closing(&floor, 201, 1, &pallets, 40));
    batch.push(closing(&floor, 202, 2, &pallets, 41));
    batch.push(closing(&floor, 203, 3, &pallets, 42));
    for (n, box_n) in [(301, 2), (302, 6)] {
        let mut apart = box_exception("disassemble", &box_id(box_n), &instant(161, 0));
        apart["reasonCode"] = json!("damaged_package");
        batch.push(record(&floor, n, "box_exception", apart));
    }
    let answered = receipts(&admin.app, &floor.key, &batch).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
    // The colleague: pallets 50 and 51 closed with boxes, pallet 52 open
    // with one; box 2001 has serial 3500, the first of its block.
    let mut theirs = Vec::new();
    for (box_n, pallet) in [(2001, 50), (2002, 51), (2003, 52)] {
        theirs.extend(boxed(
            &colleague,
            &colleague_block,
            box_n,
            Some(&pallet_id(pallet)),
        ));
    }
    theirs.push(closing(&colleague, 2201, 50, &colleague_pallets, 240));
    theirs.push(closing(&colleague, 2202, 51, &colleague_pallets, 241));
    let answered = receipts(&admin.app, &colleague.key, &theirs).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
    // The third station works a shift without pallets: a box, no pallet.
    let answered = receipts(
        &admin.app,
        &third.key,
        &boxed(&third, &third_block, 4001, None),
    )
    .await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );

    let expected = [
        (&floor.shift, (json!(3), json!(1))),
        (&colleague.shift, (json!(2), json!(1))),
        (&third.shift, (json!(0), json!(0))),
    ];
    let (status, list) = admin.call("GET", "/v1/office/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list.as_array().unwrap().len(), 3, "{list}");
    for (shift, counts) in &expected {
        assert_eq!(&pallet_totals(&admin, shift).await, counts, "{shift}");
        let listed = list
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == shift.as_str())
            .unwrap_or_else(|| panic!("{shift} is not listed"));
        assert_eq!(
            (
                &listed["totals"]["closedPallets"],
                &listed["totals"]["openPallets"]
            ),
            (&counts.0, &counts.1),
            "{shift}"
        );
    }
    // The office's close answers with the figures, and a closed shift keeps
    // them.
    let closed = close_from_office(&admin, &floor.shift, "Станция не отвечает").await;
    assert_eq!(
        (
            &closed["totals"]["closedPallets"],
            &closed["totals"]["openPallets"]
        ),
        (&json!(3), &json!(1))
    );
    assert_eq!(
        pallet_totals(&admin, &floor.shift).await,
        (json!(3), json!(1))
    );
}
