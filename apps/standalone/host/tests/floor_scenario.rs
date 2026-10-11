//! One shift on one PC, the station's side replayed through the host's router
//! (plan 2a8): `proto/fixtures/floor-scenario.json` holds every record a
//! station wrote for it, in its outbox's order, and every send of that
//! outbox — the records' ids and how the send ended. The webview's own
//! modules write it (`test/floor-scenario.test.ts`, which fails when they
//! write anything else). The host must take every record of it — each
//! receipt `accepted`, the same receipts for a batch sent again — and end
//! with the station's numbers, the shift closed by the station and not late.
//! The shift has pallets (plan ПЛ-Ц): its boxes join pallets, a full pallet
//! closes with its last box, the second closes early and is taken apart.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, close_from_office, fact_rows, issue_block, issue_pallet_block, open_pallet_floor,
    pallet_sscc, record_id, send_facts, shift_setup, Admin, Floor,
};

/// The scenario, with the station's ids of the shift, of the block and of
/// the pallet block replaced by the host's: the fixture was written by a
/// station whose shift and blocks the host never issued.
fn scenario(shift: &str, block: &str, pallet_block: &str) -> Value {
    let path = format!(
        "{}/../proto/fixtures/floor-scenario.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    let raw: Value = serde_json::from_str(&text).unwrap();
    let station_shift = raw["station"]["shiftId"].as_str().unwrap().to_owned();
    let station_block = raw["station"]["blockId"].as_str().unwrap().to_owned();
    let station_pallet_block = raw["station"]["palletBlockId"].as_str().unwrap().to_owned();
    serde_json::from_str(
        &text
            .replace(&station_shift, shift)
            .replace(&station_block, block)
            .replace(&station_pallet_block, pallet_block),
    )
    .unwrap()
}

/// A station inside its open shift with pallets, with the site's first
/// block (1500–3499, the serials of the scenario's boxes) and its first
/// pallet block (40–239, the serials of its pallets), and the scenario
/// under the host's ids.
async fn station() -> (Admin, Floor, Value) {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(
        &admin.app,
        &floor.key,
        "7e6d5c4b-3a2f-4e1d-9c8b-7a6f5e4d3c2b",
    )
    .await;
    assert_eq!(
        (block["fromSerial"].clone(), block["toSerial"].clone()),
        (json!(1500), json!(3499))
    );
    let pallets = issue_pallet_block(
        &admin.app,
        &floor.key,
        "8f7e6d5c-4b3a-4f2e-8d1c-9b8a7f6e5d4c",
    )
    .await;
    assert_eq!(
        (pallets["fromSerial"].clone(), pallets["toSerial"].clone()),
        (json!(40), json!(239))
    );
    let scenario = scenario(
        &floor.shift,
        block["id"].as_str().unwrap(),
        pallets["id"].as_str().unwrap(),
    );
    (admin, floor, scenario)
}

/// The records of a send, in its order.
fn batch(scenario: &Value, send: &Value) -> Vec<Value> {
    let records = scenario["records"].as_array().unwrap();
    send["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| {
            records
                .iter()
                .find(|record| &record["id"] == id)
                .unwrap_or_else(|| panic!("no record {id}"))
                .clone()
        })
        .collect()
}

/// Sends the records and answers the host's receipts (status 200 only).
async fn receipts_of(admin: &Admin, floor: &Floor, records: &[Value]) -> Vec<Value> {
    let (status, body) = send_facts(&admin.app, &floor.key, records).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["receipts"].as_array().unwrap().clone()
}

/// The receipt `accepted` of every record, as the station's side was answered.
fn all_accepted(records: &[Value]) -> Vec<Value> {
    records
        .iter()
        .map(|record| json!({ "id": record["id"], "outcome": "accepted" }))
        .collect()
}

/// The office's totals of the shift and its state.
async fn office(admin: &Admin, shift: &str) -> Value {
    let (status, shift) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{shift}");
    shift
}

/// Who closed the shift, its reason, and whether a fact came after the close.
async fn close_columns(admin: &Admin, shift: &str) -> (String, Option<String>, bool) {
    let (by, reason, late): (String, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT closed_by_kind, close_reason_code, late_data_at FROM shifts WHERE id = ?",
    )
    .bind(shift)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    (by, reason, late.is_some())
}

/// The boxes as the host keeps them: the serial, whether the station's digest
/// matched the host's items, and whether it was taken apart.
async fn boxes(admin: &Admin) -> Vec<(i64, Option<i64>, bool)> {
    let rows: Vec<(i64, Option<i64>, Option<String>)> =
        sqlx::query_as("SELECT serial, digest_matches, disassembled_at FROM boxes ORDER BY serial")
            .fetch_all(&admin.app.state.pool)
            .await
            .unwrap();
    rows.into_iter()
        .map(|(serial, digest, disassembled)| (serial, digest, disassembled.is_some()))
        .collect()
}

/// The pallets as the host keeps them: the serial, the boxes the station
/// counted at the close, how many of its boxes the host holds, and whether
/// it was taken apart.
async fn pallets(admin: &Admin) -> Vec<(i64, Option<i64>, i64, bool)> {
    let rows: Vec<(i64, Option<i64>, i64, Option<String>)> = sqlx::query_as(
        "SELECT p.serial, p.box_count_reported, \
         (SELECT count(*) FROM boxes b WHERE b.pallet_id = p.id), p.disassembled_at \
         FROM pallets p ORDER BY p.serial",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|(serial, reported, boxes, disassembled)| {
            (serial, reported, boxes, disassembled.is_some())
        })
        .collect()
}

/// What the host keeps of the pallets, read by their serials: whether each
/// label was checked or skipped and the pallet taken apart, the pallet
/// exceptions with their reasons, and the pallet each box holds.
async fn pallet_state(admin: &Admin) -> Value {
    let pallets: Vec<(i64, Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT serial, print_verified_at, print_skipped_at, disassembled_at \
         FROM pallets ORDER BY serial",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    let exceptions: Vec<(String, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT e.kind, e.reason_code, e.reason_text, p.serial \
         FROM pallet_exceptions e JOIN pallets p ON p.id = e.pallet_id \
         ORDER BY e.occurred_at, e.record_id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    let boxes: Vec<(i64, Option<i64>)> = sqlx::query_as(
        "SELECT b.serial, p.serial FROM boxes b LEFT JOIN pallets p ON p.id = b.pallet_id \
         ORDER BY b.serial",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    json!({
        "pallets": pallets.into_iter().map(|(serial, verified, skipped, disassembled)| json!({
            "serial": serial,
            "verified": verified.is_some(),
            "skipped": skipped.is_some(),
            "disassembled": disassembled.is_some(),
        })).collect::<Vec<_>>(),
        "exceptions": exceptions.into_iter().map(|(kind, reason, text, pallet)| json!({
            "kind": kind, "reason": reason, "text": text, "pallet": pallet,
        })).collect::<Vec<_>>(),
        "boxes": boxes.into_iter().map(|(box_serial, pallet)| json!({
            "box": box_serial, "pallet": pallet,
        })).collect::<Vec<_>>(),
    })
}

#[tokio::test]
async fn the_host_takes_every_record_of_the_stations_shift_once_and_ends_with_its_numbers() {
    let (admin, floor, scenario) = station().await;
    let sends = scenario["sends"].as_array().unwrap();
    assert_eq!(sends.len(), 4);
    for send in sends {
        // A send that found no host never reached it.
        if send["answer"] == "unreachable" {
            continue;
        }
        // A lost answer: the host took the batch, the station never heard.
        let records = batch(&scenario, send);
        assert_eq!(
            receipts_of(&admin, &floor, &records).await,
            all_accepted(&records)
        );
    }
    // The last batch once more: the same receipts, and nothing written -
    // not a row counted, not a pallet's or a box's pallet changed (the last
    // batch holds the pallets' closes, labels and exceptions).
    let before = (fact_rows(&admin.app).await, pallet_state(&admin).await);
    let last = batch(&scenario, sends.last().unwrap());
    assert!(last.iter().any(|record| record["kind"] == "pallet_closed"));
    assert!(last.iter().any(|record| record["kind"] == "pallet_label"));
    assert!(last
        .iter()
        .any(|record| record["kind"] == "pallet_exception"));
    assert_eq!(
        receipts_of(&admin, &floor, &last).await,
        all_accepted(&last)
    );
    assert_eq!(
        (fact_rows(&admin.app).await, pallet_state(&admin).await),
        before
    );

    let shift = office(&admin, &floor.shift).await;
    let station = &scenario["station"];
    assert_eq!(shift["status"], "closed");
    assert_eq!(
        (
            shift["totals"]["acceptedUnits"].clone(),
            shift["totals"]["closedBoxes"].clone(),
            shift["totals"]["openBoxes"].clone(),
            shift["totals"]["closedPallets"].clone(),
            shift["totals"]["openPallets"].clone(),
        ),
        (
            station["acceptedUnits"].clone(),
            station["closedBoxes"].clone(),
            json!(0),
            station["closedPallets"].clone(),
            json!(0)
        )
    );
    assert_eq!(
        close_columns(&admin, &floor.shift).await,
        (
            "device".to_owned(),
            Some("production_order_changed".to_owned()),
            false
        )
    );
    // Each box's digest, counted by the station after its undo and clear,
    // matches the host's items; the first box is taken apart.
    assert_eq!(
        boxes(&admin).await,
        vec![
            (1500, Some(1), true),
            (1501, Some(1), false),
            (1502, Some(1), false)
        ]
    );
    // The first pallet closed with its second box and holds both (the first
    // box taken apart since); the second closed early with one box and was
    // taken apart (plan ПЛ-Ц).
    assert_eq!(
        pallets(&admin).await,
        vec![(40, Some(2), 2, false), (41, Some(1), 1, true)]
    );
    // What the host kept of them: both labels checked, the exceptions with
    // their reasons, and each box on the pallet it closed on - the box taken
    // apart and the boxes of the pallet taken apart keep theirs.
    assert_eq!(
        pallet_state(&admin).await,
        json!({
            "pallets": [
                { "serial": 40, "verified": true, "skipped": false, "disassembled": false },
                { "serial": 41, "verified": true, "skipped": false, "disassembled": true },
            ],
            "exceptions": [
                { "kind": "reprint", "reason": "unreadable_label", "text": null, "pallet": 40 },
                {
                    "kind": "disassemble", "reason": "other",
                    "text": "Собрана не на тот заказ", "pallet": 41
                },
            ],
            "boxes": [
                { "box": 1500, "pallet": 40 },
                { "box": 1501, "pallet": 40 },
                { "box": 1502, "pallet": 41 },
            ],
        })
    );
}

/// Every record of the scenario, each batch once, as the station's sends
/// reached the host.
async fn take_all(admin: &Admin, floor: &Floor, scenario: &Value) {
    for send in scenario["sends"].as_array().unwrap() {
        if send["answer"] == "unreachable" {
            continue;
        }
        let records = batch(scenario, send);
        assert_eq!(
            receipts_of(admin, floor, &records).await,
            all_accepted(&records)
        );
    }
}

/// The scenario's first record of `kind` that `wanted` accepts, copied.
fn record_of(scenario: &Value, kind: &str, wanted: impl Fn(&Value) -> bool) -> Value {
    scenario["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|record| record["kind"] == kind && wanted(record))
        .unwrap_or_else(|| panic!("no {kind} record"))
        .clone()
}

/// `record` sent again under the record id `n`: the host sees another record.
fn under_id(record: &Value, n: u32) -> Value {
    let mut copy = record.clone();
    copy["id"] = json!(record_id(n));
    copy
}

/// One record sent alone: its receipt.
async fn receipt_of(admin: &Admin, floor: &Floor, record: &Value) -> Value {
    receipts_of(admin, floor, std::slice::from_ref(record))
        .await
        .remove(0)
}

#[tokio::test]
async fn a_close_sent_again_under_another_id_is_accepted_and_changes_no_pallet() {
    let (admin, floor, scenario) = station().await;
    take_all(&admin, &floor, &scenario).await;
    let before = pallet_state(&admin).await;
    // The first pallet's close and its box's close, as the station could
    // write them a second time: the host holds them, so nothing changes.
    let pallet = record_of(&scenario, "pallet_closed", |r| r["data"]["serial"] == 40);
    let closed_box = record_of(&scenario, "box_closed", |r| {
        r["data"]["palletId"] == pallet["data"]["palletId"]
    });
    for (n, record) in [(900, &pallet), (901, &closed_box)] {
        assert_eq!(
            receipt_of(&admin, &floor, &under_id(record, n)).await,
            json!({ "id": record_id(n), "outcome": "accepted" })
        );
    }
    assert_eq!(pallet_state(&admin).await, before);
}

#[tokio::test]
async fn a_box_that_names_another_pallet_than_the_one_it_closed_on_is_refused() {
    let (admin, floor, scenario) = station().await;
    take_all(&admin, &floor, &scenario).await;
    let before = pallet_state(&admin).await;
    // The third box closed on the second pallet; a record that puts it on
    // the first is another close of a closed box.
    let first = record_of(&scenario, "pallet_closed", |r| r["data"]["serial"] == 40);
    let second = record_of(&scenario, "pallet_closed", |r| r["data"]["serial"] == 41);
    let third = record_of(&scenario, "box_closed", |r| {
        r["data"]["palletId"] == second["data"]["palletId"]
    });
    let mut onto_first = under_id(&third, 902);
    onto_first["data"]["palletId"] = first["data"]["palletId"].clone();
    assert_eq!(
        receipt_of(&admin, &floor, &onto_first).await,
        json!({ "id": record_id(902), "outcome": "rejected", "code": "box_already_closed" })
    );
    assert_eq!(pallet_state(&admin).await, before);
}

#[tokio::test]
async fn a_pallet_taken_apart_stays_taken_apart_and_a_closed_pallet_keeps_its_close() {
    let (admin, floor, scenario) = station().await;
    take_all(&admin, &floor, &scenario).await;
    let before = pallet_state(&admin).await;
    let second = record_of(&scenario, "pallet_closed", |r| r["data"]["serial"] == 41);
    let pallet_id = second["data"]["palletId"].clone();
    let exception = record_of(&scenario, "pallet_exception", |r| {
        r["data"]["exception"] == "disassemble"
    });
    assert_eq!(exception["data"]["palletId"], pallet_id);
    // Taken apart again, or printed again after: the pallet is no longer
    // one the station can act on.
    let again = under_id(&exception, 904);
    let mut reprint = under_id(&exception, 905);
    reprint["data"]["exception"] = json!("reprint");
    reprint["data"]["reasonCode"] = json!("damaged_label");
    reprint["data"]["reasonText"] = Value::Null;
    for (n, record) in [(904, &again), (905, &reprint)] {
        assert_eq!(
            receipt_of(&admin, &floor, record).await,
            json!({ "id": record_id(n), "outcome": "rejected", "code": "pallet_state" })
        );
    }
    // A close of the same pallet with another SSCC does not move it.
    let mut other_sscc = under_id(&second, 906);
    other_sscc["data"]["sscc"] = json!(pallet_sscc(99));
    assert_eq!(
        receipt_of(&admin, &floor, &other_sscc).await,
        json!({ "id": record_id(906), "outcome": "rejected", "code": "pallet_already_closed" })
    );
    assert_eq!(pallet_state(&admin).await, before);
}

#[tokio::test]
async fn the_stations_facts_after_the_offices_close_are_taken_and_mark_the_shift_late() {
    let (admin, floor, scenario) = station().await;
    let sends = scenario["sends"].as_array().unwrap();
    let first = batch(&scenario, &sends[0]);
    assert_eq!(
        receipts_of(&admin, &floor, &first).await,
        all_accepted(&first)
    );
    // The station is away; the office closes its shift.
    close_from_office(&admin, &floor.shift, "Станция не отвечает").await;
    let rest = batch(&scenario, &sends[3]);
    let mut expected = all_accepted(&rest);
    let close = expected.last_mut().unwrap();
    close["details"] = json!({ "alreadyClosed": true });
    assert_eq!(rest.last().unwrap()["kind"], "shift_closed");
    assert_eq!(receipts_of(&admin, &floor, &rest).await, expected);
    let shift = office(&admin, &floor.shift).await;
    assert_eq!(
        (
            shift["totals"]["acceptedUnits"].clone(),
            shift["totals"]["closedBoxes"].clone()
        ),
        (
            scenario["station"]["acceptedUnits"].clone(),
            scenario["station"]["closedBoxes"].clone()
        )
    );
    assert_eq!(
        close_columns(&admin, &floor.shift).await,
        ("office_user".to_owned(), None, true)
    );
}
