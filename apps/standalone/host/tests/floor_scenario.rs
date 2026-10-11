//! One shift on one PC, the station's side replayed through the host's router
//! (plan 2a8): `proto/fixtures/floor-scenario.json` holds every record a
//! station wrote for it, in its outbox's order, and every send of that
//! outbox — the records' ids and how the send ended. The webview's own
//! modules write it (`test/floor-scenario.test.ts`, which fails when they
//! write anything else). The host must take every record of it — each
//! receipt `accepted`, the same receipts for a batch sent again — and end
//! with the station's numbers, the shift closed by the station and not late.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, close_from_office, fact_rows, issue_block, open_floor, send_facts, shift_setup, Admin,
    Floor,
};

/// The scenario, with the station's ids of the shift and of the block
/// replaced by the host's: the fixture was written by a station whose
/// shift and block the host never issued.
fn scenario(shift: &str, block: &str) -> Value {
    let path = format!(
        "{}/../proto/fixtures/floor-scenario.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {path}: {error}"));
    let raw: Value = serde_json::from_str(&text).unwrap();
    let station_shift = raw["station"]["shiftId"].as_str().unwrap().to_owned();
    let station_block = raw["station"]["blockId"].as_str().unwrap().to_owned();
    serde_json::from_str(
        &text
            .replace(&station_shift, shift)
            .replace(&station_block, block),
    )
    .unwrap()
}

/// A station inside its open shift with the site's first block (1500–3499,
/// the serials of the scenario's boxes), and the scenario under the host's
/// ids.
async fn station() -> (Admin, Floor, Value) {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
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
    let scenario = scenario(&floor.shift, block["id"].as_str().unwrap());
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
    // The last batch once more: the same receipts, and nothing written.
    let before = fact_rows(&admin.app).await;
    let last = batch(&scenario, sends.last().unwrap());
    assert_eq!(
        receipts_of(&admin, &floor, &last).await,
        all_accepted(&last)
    );
    assert_eq!(fact_rows(&admin.app).await, before);

    let shift = office(&admin, &floor.shift).await;
    let station = &scenario["station"];
    assert_eq!(shift["status"], "closed");
    assert_eq!(
        (
            shift["totals"]["acceptedUnits"].clone(),
            shift["totals"]["closedBoxes"].clone(),
            shift["totals"]["openBoxes"].clone(),
        ),
        (
            station["acceptedUnits"].clone(),
            station["closedBoxes"].clone(),
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
