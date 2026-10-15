//! The floor scenario replayed by a handheld (plan ТСД-Х, task Х8): the records of
//! `proto/fixtures/floor-scenario.json` — the scans, boxes, labels, exceptions, pallets and the close
//! of one shift with pallets — reach the host from a HANDHELD key and get the station's receipts and
//! numbers; then the same handheld builds a warehouse pallet of what the shift left free.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, instant, issue_block, issue_pallet_block, send_facts, shift_setup, Admin, Floor,
};
use support::handheld::{
    accepted, added, event, open_handheld_pallet_floor, opened, receipts_of, rejected, PALLET_A,
};

/// The scenario, with the station's ids of the shift, the box block and the pallet block replaced by
/// the host's (the fixture was written by a station whose shift and blocks the host never issued).
fn scenario(shift: &str, block: &str, pallet_block: &str) -> Value {
    let path = format!(
        "{}/../proto/fixtures/floor-scenario.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    let raw: Value = serde_json::from_str(&text).unwrap();
    let station = |key: &str| raw["station"][key].as_str().unwrap().to_owned();
    serde_json::from_str(
        &text
            .replace(&station("shiftId"), shift)
            .replace(&station("blockId"), block)
            .replace(&station("palletBlockId"), pallet_block),
    )
    .unwrap()
}

async fn handheld() -> (Admin, Floor, Value, String) {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_handheld_pallet_floor(&admin, &setup).await;
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
    (admin, floor, scenario, setup.product)
}

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

fn all_accepted(records: &[Value]) -> Vec<Value> {
    records
        .iter()
        .map(|record| json!({ "id": record["id"], "outcome": "accepted" }))
        .collect()
}

async fn take_all(admin: &Admin, floor: &Floor, scenario: &Value) {
    for send in scenario["sends"].as_array().unwrap() {
        if send["answer"] == "unreachable" {
            continue;
        }
        let records = batch(scenario, send);
        let (status, body) = send_facts(&admin.app, &floor.key, &records).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["receipts"], Value::Array(all_accepted(&records)));
    }
}

async fn receipt_rows(admin: &Admin) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM fact_receipts")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn the_host_takes_every_record_of_the_shift_from_a_handheld_and_ends_with_the_numbers() {
    let (admin, floor, scenario, _) = handheld().await;
    take_all(&admin, &floor, &scenario).await;
    let (status, shift) = admin
        .call("GET", &format!("/v1/office/shifts/{}", floor.shift), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{shift}");
    let station = &scenario["station"];
    assert_eq!(shift["status"], "closed");
    assert_eq!(
        (
            shift["totals"]["acceptedUnits"].clone(),
            shift["totals"]["closedBoxes"].clone(),
            shift["totals"]["closedPallets"].clone()
        ),
        (
            station["acceptedUnits"].clone(),
            station["closedBoxes"].clone(),
            station["closedPallets"].clone()
        )
    );
    // The close is the handheld's own: a device, with the station's reason, and not late.
    let (by, reason, late): (String, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT closed_by_kind, close_reason_code, late_data_at FROM shifts WHERE id = ?",
    )
    .bind(&floor.shift)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        (by.as_str(), reason.as_deref(), late),
        ("device", Some("production_order_changed"), None)
    );
    // The last batch again: the same receipts, nothing written.
    let before = receipt_rows(&admin).await;
    let last = batch(
        &scenario,
        scenario["sends"].as_array().unwrap().last().unwrap(),
    );
    let (status, body) = send_facts(&admin.app, &floor.key, &last).await;
    assert_eq!(
        (status, body["receipts"].clone()),
        (StatusCode::OK, Value::Array(all_accepted(&last)))
    );
    assert_eq!(before, receipt_rows(&admin).await);
}

#[tokio::test]
async fn what_the_shift_left_free_goes_onto_a_warehouse_pallet_and_the_rest_is_refused_with_its_pallet(
) {
    let (admin, floor, scenario, product) = handheld().await;
    take_all(&admin, &floor, &scenario).await;
    // After the scenario: box 1500 is taken apart, box 1501 stands on the first pallet (SSCC …409),
    // box 1502 stood on the second pallet, which was taken apart: it is free.
    let free = "046006820000015024";
    let on_pallet = "046006820000015017";
    let apart = "046006820000015000";
    let got = receipts_of(
        &admin,
        &floor.key,
        &[
            opened(1, PALLET_A, &product, &instant(400, 0)),
            added(2, PALLET_A, free, &instant(401, 0)),
            added(3, PALLET_A, on_pallet, &instant(402, 0)),
            added(4, PALLET_A, apart, &instant(403, 0)),
            event(
                5,
                "pallet_box_removed",
                json!({ "palletId": PALLET_A, "boxSscc": free, "removedAt": instant(404, 0) }),
            ),
            added(6, PALLET_A, free, &instant(405, 0)),
        ],
    )
    .await;
    assert_eq!(
        got,
        vec![
            accepted(1),
            accepted(2),
            rejected(
                3,
                "box_on_pallet",
                Some(json!({
                    "palletSscc": "146006820000000409",
                    "palletId": scenario_pallet(&scenario, 40)
                }))
            ),
            rejected(4, "box_not_closed", None),
            accepted(5),
            accepted(6),
        ]
    );
}

/// The id the scenario gave the pallet of `serial`.
fn scenario_pallet(scenario: &Value, serial: u64) -> Value {
    scenario["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|record| record["kind"] == "pallet_closed" && record["data"]["serial"] == serial)
        .map(|record| record["data"]["palletId"].clone())
        .expect("the scenario closes that pallet")
}
