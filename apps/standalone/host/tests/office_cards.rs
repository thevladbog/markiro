//! The office's box and pallet cards (plan КРТ, parity spec §5.3): `GET
//! /v1/office/boxes/{id}` and `GET /v1/office/pallets/{id}`. Every office
//! role reads them; nothing else does; a read writes nothing.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    add_operator, admin, audit_rows, box_closed, box_exception, box_id, code_hash, empty, fact,
    fact_rows, instant, issue_block, issue_pallet_block, login, ok_scan, open_pallet_floor,
    pair_device, pallet_closed, pallet_id, pallet_sscc, receipts, record_id, request, shift_setup,
    sscc, with_device, with_session, Admin, Floor,
};

const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const PALLET_REQUEST: &str = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";
const COLLEAGUE_BLOCK_REQUEST: &str = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";
const COLLEAGUE_PALLET_REQUEST: &str = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

/// A day of two stations on two lines, both shifts with pallets.
/// The station: codes 1-3 into box 1 (2 by Анна), 3 undone; box 1 closed
/// (serial 1500) on pallet 1; codes 4, 5 into box 2, closed (1501) on
/// pallet 1; pallet 1 closed (serial 40, two boxes counted); box 2 then
/// taken apart (`wrong_quantity`); pallet 1's label printed again.
/// The colleague, a day later by the host's clock: an earlier scan of
/// code 2 into box 11 takes it from box 1; box 11 closed (3500) on
/// pallet 2, closed (240) before pallet 1; code 6 into box 12, closed
/// (3501) on pallet 3, which stays open.
struct Yard {
    admin: Admin,
    floor: Floor,
    colleague: Floor,
    tech: String,
    admin_token: String,
}

async fn accept(admin: &Admin, floor: &Floor, records: &[Value]) {
    let answered = receipts(&admin.app, &floor.key, records).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
}

async fn yard() -> Yard {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let (operator, _) = add_operator(&admin, "1001").await;
    let shift = floor.shift.clone();
    let scan = |record: u32, code: u32, n: u32, second: u32| {
        fact(
            &record_id(record),
            "scan",
            &shift,
            ok_scan(code, &box_id(n), &instant(second, 0)),
        )
    };
    let mut by_anna = scan(2, 2, 1, 11);
    by_anna["operatorId"] = json!(operator);
    let mut undo = box_exception("undo", &box_id(1), &instant(13, 0));
    undo["codeHash"] = json!(code_hash(3));
    undo["targetScannedAt"] = json!(instant(12, 0));
    let mut closed1 = box_closed(
        &box_id(1),
        &block,
        1500,
        &[1, 2],
        &instant(10, 0),
        &instant(20, 0),
    );
    closed1["palletId"] = json!(pallet_id(1));
    let mut closed2 = box_closed(
        &box_id(2),
        &block,
        1501,
        &[4, 5],
        &instant(30, 0),
        &instant(40, 0),
    );
    closed2["palletId"] = json!(pallet_id(1));
    let mut taken_apart = box_exception("disassemble", &box_id(2), &instant(50, 0));
    taken_apart["reasonCode"] = json!("wrong_quantity");
    let reprint = json!({
        "exception": "reprint", "palletId": pallet_id(1), "reasonCode": "damaged_label",
        "reasonText": null, "occurredAt": instant(55, 0)
    });
    let mut closed1_fact = fact(&record_id(5), "box_closed", &shift, closed1);
    closed1_fact["operatorId"] = json!(operator);
    accept(
        &admin,
        &floor,
        &[
            scan(1, 1, 1, 10),
            by_anna,
            scan(3, 3, 1, 12),
            fact(&record_id(4), "box_exception", &shift, undo),
            closed1_fact,
            scan(6, 4, 2, 30),
            scan(7, 5, 2, 31),
            fact(&record_id(8), "box_closed", &shift, closed2),
            fact(
                &record_id(9),
                "pallet_closed",
                &shift,
                pallet_closed(
                    &pallet_id(1),
                    &pallets,
                    40,
                    2,
                    &instant(20, 0),
                    &instant(41, 0),
                ),
            ),
            fact(&record_id(10), "box_exception", &shift, taken_apart),
            fact(&record_id(11), "pallet_exception", &shift, reprint),
        ],
    )
    .await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_pallet_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let colleague_block = issue_block(&admin.app, &colleague.key, COLLEAGUE_BLOCK_REQUEST).await;
    let colleague_pallets =
        issue_pallet_block(&admin.app, &colleague.key, COLLEAGUE_PALLET_REQUEST).await;
    // The host's clock moves past the station's day: the colleague's take of
    // code 2 is the last thing that happened to it.
    admin.app.clock.advance(time::Duration::days(17));
    let other = colleague.shift.clone();
    let mut closed11 = box_closed(
        &box_id(11),
        &colleague_block,
        3500,
        &[2],
        &instant(5, 0),
        &instant(6, 0),
    );
    closed11["palletId"] = json!(pallet_id(2));
    let mut closed12 = box_closed(
        &box_id(12),
        &colleague_block,
        3501,
        &[6],
        &instant(7, 0),
        &instant(8, 0),
    );
    closed12["palletId"] = json!(pallet_id(3));
    accept(
        &admin,
        &colleague,
        &[
            fact(
                &record_id(1),
                "scan",
                &other,
                ok_scan(2, &box_id(11), &instant(5, 0)),
            ),
            fact(&record_id(2), "box_closed", &other, closed11),
            fact(
                &record_id(3),
                "pallet_closed",
                &other,
                pallet_closed(
                    &pallet_id(2),
                    &colleague_pallets,
                    240,
                    1,
                    &instant(6, 0),
                    &instant(9, 0),
                ),
            ),
            fact(
                &record_id(4),
                "scan",
                &other,
                ok_scan(6, &box_id(12), &instant(7, 0)),
            ),
            fact(&record_id(5), "box_closed", &other, closed12),
        ],
    )
    .await;
    let tech = admin.technologist().await;
    let admin_token = login(&admin.app, &admin.key, "admin", "correct horse battery").await;
    Yard {
        admin,
        floor,
        colleague,
        tech,
        admin_token,
    }
}

impl Yard {
    async fn get(&self, path: &str) -> (StatusCode, Value) {
        self.admin.call_as(&self.tech, "GET", path, None).await
    }
}

/// The box's card: its shift, station, operator and pallet, every item it
/// ever had newest first with where it stands now, and its exceptions.
#[tokio::test]
async fn a_box_card_tells_its_items_their_states_and_its_exceptions() {
    let yard = yard().await;
    let (status, card) = yard.get(&format!("/v1/office/boxes/{}", box_id(1))).await;
    assert_eq!(status, StatusCode::OK, "{card}");
    assert_eq!(card["sscc"], sscc(1500));
    assert_eq!(card["shift"]["number"], yard.floor.number);
    assert_eq!(card["operatorName"], "Анна Кузнецова");
    assert_eq!(card["pallet"]["sscc"], pallet_sscc(40));
    assert_eq!(
        card["units"], 1,
        "code 2 was taken by the colleague's earlier scan"
    );
    let items: Vec<(String, String)> = card["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            (
                i["serial"].as_str().unwrap().to_owned(),
                i["state"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        items,
        [
            ("S000003".to_owned(), "removed".to_owned()),
            ("S000002".to_owned(), "displaced".to_owned()),
            ("S000001".to_owned(), "packed".to_owned()),
        ]
    );
    assert_eq!(card["items"][0]["leftAt"], instant(13, 0));
    assert_eq!(card["items"][1]["operatorName"], "Анна Кузнецова");
    assert_eq!(card["exceptions"].as_array().unwrap().len(), 1);
    assert_eq!(card["exceptions"][0]["kind"], "undo");
    assert_eq!(card["exceptions"][0]["codeHash"], code_hash(3));
    assert_eq!(card["documents"], json!([]));
    assert_eq!(card["itemsCapped"], false);
}

/// A box taken apart: its items left at its disassembly's instant, its
/// exception names the reason; no full code anywhere in the answer.
#[tokio::test]
async fn a_box_taken_apart_shows_its_disassembly_and_no_full_code() {
    let yard = yard().await;
    let (status, card) = yard.get(&format!("/v1/office/boxes/{}", box_id(2))).await;
    assert_eq!(status, StatusCode::OK, "{card}");
    assert_eq!(card["disassembledAt"], instant(50, 0));
    assert!(card["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|i| i["state"] == "removed" && i["leftAt"] == instant(50, 0)));
    assert_eq!(card["exceptions"][0]["reasonCode"], "wrong_quantity");
    let text = card.to_string();
    assert!(
        !text.contains("Tail") && !text.contains("\\u001d"),
        "{text}"
    );
}

/// The colleague's box 12: closed on the open pallet 3, which has no SSCC
/// yet, in the colleague's shift.
#[tokio::test]
async fn a_box_of_another_shift_on_an_open_pallet_is_read_too() {
    let yard = yard().await;
    let (status, card) = yard.get(&format!("/v1/office/boxes/{}", box_id(12))).await;
    assert_eq!(status, StatusCode::OK, "{card}");
    assert_eq!(card["shift"]["number"], yard.colleague.number);
    assert_eq!(card["shift"]["lineName"], "Линия 2");
    assert_eq!(card["deviceId"], yard.colleague.station);
    assert_eq!(card["pallet"]["id"], pallet_id(3));
    assert_eq!(card["pallet"]["sscc"], Value::Null);
    assert_eq!(card["items"].as_array().unwrap().len(), 1);
    assert_eq!(card["items"][0]["state"], "packed");
    assert_eq!(card["operatorName"], Value::Null);
}

/// The colleague's box 11 took code 2 from box 1 with an earlier scan: box 1
/// shows it displaced, box 11 shows it packed.
#[tokio::test]
async fn a_code_taken_by_another_box_is_displaced_here_and_packed_there() {
    let yard = yard().await;
    let (_, there) = yard.get(&format!("/v1/office/boxes/{}", box_id(11))).await;
    assert_eq!(there["items"][0]["serial"], "S000002");
    assert_eq!(there["items"][0]["state"], "packed");
    assert_eq!(there["units"], 1);
}

#[tokio::test]
async fn an_unknown_box_is_not_found_and_a_malformed_id_is_refused() {
    let yard = yard().await;
    let (status, body) = yard
        .get("/v1/office/boxes/b0000000-0000-4000-8000-000000000099")
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    let (status, body) = yard
        .get("/v1/office/boxes/B0000000-0000-4000-8000-000000000001")
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["details"]["field"], "id");
}

/// Only an office session reads a card; a refusal carries nothing of the
/// box; a read writes nothing, not even an audit row.
#[tokio::test]
async fn only_an_office_session_reads_a_card_and_a_read_writes_nothing() {
    let yard = yard().await;
    let app = &yard.admin.app;
    let (_, other) = pair_device(app, "station").await;
    let facts_before = fact_rows(app).await;
    let audit_before = audit_rows(app).await;
    let path = format!("/v1/office/boxes/{}", box_id(1));
    for (who, builder) in [
        (
            "the station's key",
            with_device(request("GET", &path), &yard.floor.key),
        ),
        (
            "another device with the admin's session",
            with_session(request("GET", &path), &other, &yard.admin_token),
        ),
        (
            "a made-up session",
            with_session(request("GET", &path), &yard.floor.key, "operator-pin-4821"),
        ),
        ("nothing", request("GET", &path)),
    ] {
        let (status, body) = app.send(empty(builder)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{who}: {body}");
        let text = body.to_string();
        for secret in [sscc(1500).as_str(), "S000001", "Кузнецова"] {
            assert!(!text.contains(secret), "{who} leaked {secret}: {text}");
        }
    }
    let (status, _) = yard
        .admin
        .call_as(&yard.admin_token, "GET", &path, None)
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = yard.get(&path).await; // the technologist
    assert_eq!(status, StatusCode::OK);
    assert_eq!(fact_rows(app).await, facts_before);
    assert_eq!(audit_rows(app).await, audit_before);
}

/// Every query of the cards searches by an index, never through a table.
#[tokio::test]
async fn every_card_query_searches_by_an_index() {
    let admin = admin().await;
    for (name, sql) in markiro_host::routes::office_cards::QUERIES {
        let plan: Vec<(i64, i64, i64, String)> =
            sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
                .bind("b0000000-0000-4000-8000-000000000001")
                .bind(10_001_i64)
                .fetch_all(&admin.app.state.pool)
                .await
                .unwrap();
        let steps: Vec<&str> = plan.iter().map(|(_, _, _, step)| step.as_str()).collect();
        assert!(
            steps.iter().all(|step| !step.starts_with("SCAN")),
            "{name}: {steps:?}"
        );
        let driving = match name {
            "box items" => Some("scans_ok_box"),
            "box exceptions" => Some("box_exceptions_box"),
            "pallet boxes" => Some("boxes_pallet"),
            "pallet exceptions" => Some("pallet_exceptions_pallet"),
            _ => None,
        };
        if let Some(index) = driving {
            assert!(
                steps.iter().any(|s| s.contains(&format!("INDEX {index}"))),
                "{name}: {steps:?}"
            );
        }
    }
}
