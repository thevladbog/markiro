mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    add_operator, admin, box_closed, box_exception, box_id, code_hash, empty, fact, instant,
    issue_block, issue_pallet_block, ok_scan, open_pallet_floor, pair_device, pallet_closed,
    pallet_id, pallet_sscc, plan_shift, receipts, record_id, request, shift_body, shift_setup,
    sscc, with_device, Admin, Floor, ShiftSetup,
};

const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const PALLET_REQUEST: &str = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";
const COLLEAGUE_BLOCK_REQUEST: &str = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";
const COLLEAGUE_PALLET_REQUEST: &str = "9b8a7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";

async fn accept(admin: &Admin, floor: &Floor, records: &[Value]) {
    let answered = receipts(&admin.app, &floor.key, records).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
}

/// The `data` of box `n` closed with `serial` over `members`, on `pallet`.
fn closed_on(
    block: &Value,
    n: u32,
    serial: u64,
    members: &[u32],
    opened: u32,
    closed: u32,
    pallet: Option<&str>,
) -> Value {
    let mut data = box_closed(
        &box_id(n),
        block,
        serial,
        members,
        &instant(opened, 0),
        &instant(closed, 0),
    );
    if let Some(pallet) = pallet {
        data["palletId"] = json!(pallet);
    }
    data
}

/// A day of a shift with pallets: box 1 (codes 1 and 2) and box 2 (code
/// 3) closed on pallet 1, box 2 then taken apart; box 3 open with code 4;
/// box 4 (code 5) closed on no pallet, its label skipped; box 5 (code 6)
/// closed on pallet 2, which stays open; pallet 1 closed (the station
/// counted 2 boxes) and its label checked. A colleague's code then takes
/// code 2 from box 1. The colleague's shift has a box and a pallet of its
/// own. The lists name exactly the shift's boxes and pallets, opened first
/// first, with what is live on them now.
#[tokio::test]
async fn the_lists_name_the_shifts_boxes_and_pallets_with_what_is_live_on_them() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let shift = floor.shift.clone();
    let mut disassemble = box_exception("disassemble", &box_id(2), &instant(45, 0));
    disassemble["reasonCode"] = json!("other");
    disassemble["reasonText"] = json!("Помятый короб");
    let scan = |record: u32, code: u32, n: u32, second: u32| {
        fact(
            &record_id(record),
            "scan",
            &shift,
            ok_scan(code, &box_id(n), &instant(second, 0)),
        )
    };
    let p1 = pallet_id(1);
    let p2 = pallet_id(2);
    accept(
        &admin,
        &floor,
        &[
            scan(1, 1, 1, 10),
            scan(2, 2, 1, 11),
            fact(
                &record_id(3),
                "box_closed",
                &shift,
                closed_on(&block, 1, 1500, &[1, 2], 10, 20, Some(&p1)),
            ),
            scan(4, 3, 2, 30),
            fact(
                &record_id(5),
                "box_closed",
                &shift,
                closed_on(&block, 2, 1501, &[3], 30, 40, Some(&p1)),
            ),
            fact(
                &record_id(6),
                "pallet_closed",
                &shift,
                pallet_closed(&p1, &pallets, 40, 2, &instant(20, 0), &instant(41, 500)),
            ),
            fact(
                &record_id(7),
                "pallet_label",
                &shift,
                json!({ "palletId": p1, "outcome": "verified", "at": instant(42, 0) }),
            ),
            fact(&record_id(8), "box_exception", &shift, disassemble),
            scan(9, 4, 3, 50),
            scan(10, 5, 4, 60),
            fact(
                &record_id(11),
                "box_closed",
                &shift,
                closed_on(&block, 4, 1502, &[5], 60, 65, None),
            ),
            fact(
                &record_id(12),
                "box_label",
                &shift,
                json!({ "boxId": box_id(4), "outcome": "skipped", "at": instant(66, 0) }),
            ),
            scan(13, 6, 5, 70),
            fact(
                &record_id(14),
                "box_closed",
                &shift,
                closed_on(&block, 5, 1503, &[6], 70, 75, Some(&p2)),
            ),
        ],
    )
    .await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_pallet_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let colleague_block = issue_block(&admin.app, &colleague.key, COLLEAGUE_BLOCK_REQUEST).await;
    let colleague_pallets =
        issue_pallet_block(&admin.app, &colleague.key, COLLEAGUE_PALLET_REQUEST).await;
    let p11 = pallet_id(11);
    accept(
        &admin,
        &colleague,
        &[
            // An earlier scan of code 2 takes it from box 1.
            fact(
                &record_id(1),
                "scan",
                &colleague.shift,
                ok_scan(2, &box_id(11), &instant(5, 0)),
            ),
            fact(
                &record_id(2),
                "box_closed",
                &colleague.shift,
                closed_on(&colleague_block, 11, 3500, &[2], 5, 6, Some(&p11)),
            ),
            fact(
                &record_id(3),
                "pallet_closed",
                &colleague.shift,
                pallet_closed(
                    &p11,
                    &colleague_pallets,
                    240,
                    1,
                    &instant(6, 0),
                    &instant(7, 0),
                ),
            ),
        ],
    )
    .await;

    let station = floor.station.clone();
    let (status, boxes) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}/boxes"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{boxes}");
    assert_eq!(
        boxes,
        json!([
            {
                "id": box_id(1), "deviceId": station, "operatorName": null, "sscc": sscc(1500),
                "openedAt": instant(10, 0), "closedAt": instant(20, 0), "disassembledAt": null,
                "palletId": p1, "units": 1, "itemCountReported": 2,
                "digestMatches": true, "printVerifiedAt": null, "printSkippedAt": null,
            },
            {
                "id": box_id(2), "deviceId": station, "operatorName": null, "sscc": sscc(1501),
                "openedAt": instant(30, 0), "closedAt": instant(40, 0),
                "disassembledAt": instant(45, 0), "palletId": p1, "units": 0,
                "itemCountReported": 1, "digestMatches": true,
                "printVerifiedAt": null, "printSkippedAt": null,
            },
            {
                "id": box_id(3), "deviceId": station, "operatorName": null, "sscc": null,
                "openedAt": instant(50, 0), "closedAt": null, "disassembledAt": null,
                "palletId": null, "units": 1, "itemCountReported": null,
                "digestMatches": null, "printVerifiedAt": null, "printSkippedAt": null,
            },
            {
                "id": box_id(4), "deviceId": station, "operatorName": null, "sscc": sscc(1502),
                "openedAt": instant(60, 0), "closedAt": instant(65, 0), "disassembledAt": null,
                "palletId": null, "units": 1, "itemCountReported": 1,
                "digestMatches": true, "printVerifiedAt": null, "printSkippedAt": instant(66, 0),
            },
            {
                "id": box_id(5), "deviceId": station, "operatorName": null, "sscc": sscc(1503),
                "openedAt": instant(70, 0), "closedAt": instant(75, 0), "disassembledAt": null,
                "palletId": p2, "units": 1, "itemCountReported": 1,
                "digestMatches": true, "printVerifiedAt": null, "printSkippedAt": null,
            },
        ])
    );
    let (status, listed) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}/pallets"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(
        listed,
        json!([
            {
                // Box 2 was taken apart and code 2 taken from box 1: one
                // box and one unit stand on the pallet, though the station
                // counted two boxes at its close.
                "id": p1, "deviceId": station, "sscc": pallet_sscc(40),
                "openedAt": instant(20, 0), "closedAt": instant(41, 500), "disassembledAt": null,
                "boxes": 1, "units": 1, "boxCountReported": 2,
                "printVerifiedAt": instant(42, 0), "printSkippedAt": null,
            },
            {
                "id": p2, "deviceId": station, "sscc": null,
                "openedAt": instant(75, 0), "closedAt": null, "disassembledAt": null,
                "boxes": 1, "units": 1, "boxCountReported": null,
                "printVerifiedAt": null, "printSkippedAt": null,
            },
        ])
    );
    let (_, theirs) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{}/pallets", colleague.shift),
            None,
        )
        .await;
    assert_eq!(theirs.as_array().map(Vec::len), Some(1), "{theirs}");
    assert_eq!(theirs[0]["units"], 1);
    let (_, their_boxes) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{}/boxes", colleague.shift),
            None,
        )
        .await;
    assert_eq!(
        their_boxes.as_array().map(Vec::len),
        Some(1),
        "{their_boxes}"
    );
}

/// Every office role reads both lists; an unknown shift is `not_found`, a
/// planned one has none; the device key alone is no office session.
#[tokio::test]
async fn every_office_role_reads_the_lists_and_an_unknown_shift_is_not_found() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let planned = plan_shift(&admin, shift_body(&setup)).await;
    let id = planned["id"].as_str().unwrap();
    let technologist = admin.technologist().await;
    for list in ["boxes", "pallets"] {
        let path = format!("/v1/office/shifts/{id}/{list}");
        let (status, body) = admin.call_as(&technologist, "GET", &path, None).await;
        assert_eq!((status, body), (StatusCode::OK, json!([])), "{list}");
        let unknown = format!("/v1/office/shifts/0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b/{list}");
        let (status, body) = admin.call("GET", &unknown, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body["error"]["code"], "not_found");
        let (status, body) = admin
            .app
            .send(empty(with_device(request("GET", &path), &admin.key)))
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    }
}

/// Both lists search by an index, the per-row counts too.
#[tokio::test]
async fn both_lists_search_by_an_index() {
    let admin = admin().await;
    for (name, sql) in [
        ("boxes", markiro_host::routes::office_boxes::BOXES_SQL),
        ("pallets", markiro_host::routes::office_boxes::PALLETS_SQL),
    ] {
        let plan: Vec<(i64, i64, i64, String)> =
            sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
                .bind("0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b")
                .fetch_all(&admin.app.state.pool)
                .await
                .unwrap();
        let steps: Vec<&str> = plan.iter().map(|(_, _, _, step)| step.as_str()).collect();
        assert!(
            steps.iter().all(|step| !step.starts_with("SCAN")),
            "{name}: {steps:?}"
        );
    }
}

// Tests beyond the plan's own: what the lists must let the office flag (a
// box that joined a pallet after it closed, a count that disagrees), the
// order of ties, a code taken out before the close, a close that did not
// compare, a shift of thousands of boxes.

/// An open shift with pallets, and the two SSCC blocks (boxes, pallets) of
/// its station.
async fn pallet_station() -> (Admin, ShiftSetup, Floor, Value, Value) {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    (admin, setup, floor, block, pallets)
}

async fn list(admin: &Admin, shift: &str, which: &str) -> Value {
    let (status, body) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}/{which}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

/// Plan КРТ (П-14): a box closed by an operator lists the operator's name, a
/// box closed with no operator lists `null`.
#[tokio::test]
async fn a_box_lists_the_operator_who_closed_it() {
    let (admin, _, floor, block, _) = pallet_station().await;
    let (operator, _) = add_operator(&admin, "1001").await;
    let shift = floor.shift.clone();
    let mut closed_by_anna = fact(
        &record_id(2),
        "box_closed",
        &shift,
        closed_on(&block, 1, 1500, &[1], 10, 20, None),
    );
    closed_by_anna["operatorId"] = json!(operator);
    accept(
        &admin,
        &floor,
        &[
            fact(
                &record_id(1),
                "scan",
                &shift,
                ok_scan(1, &box_id(1), &instant(10, 0)),
            ),
            closed_by_anna,
            fact(
                &record_id(3),
                "scan",
                &shift,
                ok_scan(2, &box_id(2), &instant(30, 0)),
            ),
            fact(
                &record_id(4),
                "box_closed",
                &shift,
                closed_on(&block, 2, 1501, &[2], 30, 40, None),
            ),
        ],
    )
    .await;
    let boxes = list(&admin, &floor.shift, "boxes").await;
    assert_eq!(boxes[0]["operatorName"], "Анна Кузнецова");
    assert_eq!(boxes[1]["operatorName"], Value::Null);
}

/// A box that closed after its pallet did joins the pallet silently; the
/// lists carry what shows it (the box's `closedAt` after the pallet's), and
/// the pallet's derived count beside the station's own shows the
/// disagreement. A pallet taken apart is listed, labelled, not hidden, and a
/// skipped label check is told apart from none.
#[tokio::test]
async fn a_late_box_and_a_count_that_disagrees_can_be_told_from_the_lists() {
    let (admin, _, floor, block, pallets) = pallet_station().await;
    let shift = floor.shift.clone();
    let scan = |record: u32, code: u32, n: u32, second: u32| {
        fact(
            &record_id(record),
            "scan",
            &shift,
            ok_scan(code, &box_id(n), &instant(second, 0)),
        )
    };
    let p1 = pallet_id(1);
    let p2 = pallet_id(2);
    let late_box = closed_on(&block, 2, 1501, &[2], 85, 90, Some(&p1));
    accept(
        &admin,
        &floor,
        &[
            scan(1, 1, 1, 10),
            fact(
                &record_id(2),
                "box_closed",
                &shift,
                closed_on(&block, 1, 1500, &[1], 10, 50, Some(&p1)),
            ),
            // The station closed pallet 1 counting one box, at 80 s.
            fact(
                &record_id(3),
                "pallet_closed",
                &shift,
                pallet_closed(&p1, &pallets, 40, 1, &instant(40, 0), &instant(80, 0)),
            ),
            scan(4, 2, 2, 85),
            // Box 2 closed at 90 s on the pallet closed at 80 s.
            fact(&record_id(5), "box_closed", &shift, late_box),
            fact(
                &record_id(6),
                "pallet_label",
                &shift,
                json!({ "palletId": p1, "outcome": "skipped", "at": instant(95, 0) }),
            ),
            scan(7, 3, 3, 100),
            fact(
                &record_id(8),
                "box_closed",
                &shift,
                closed_on(&block, 3, 1502, &[3], 100, 105, Some(&p2)),
            ),
            fact(
                &record_id(9),
                "pallet_closed",
                &shift,
                pallet_closed(&p2, &pallets, 41, 1, &instant(105, 0), &instant(110, 0)),
            ),
            fact(
                &record_id(10),
                "pallet_exception",
                &shift,
                json!({
                    "exception": "disassemble", "palletId": p2, "reasonCode": "other",
                    "reasonText": "Перепутали товар", "occurredAt": instant(120, 0)
                }),
            ),
        ],
    )
    .await;
    let station = floor.station.clone();
    let listed = list(&admin, &shift, "pallets").await;
    assert_eq!(
        listed,
        json!([
            {
                "id": p1, "deviceId": station, "sscc": pallet_sscc(40),
                "openedAt": instant(40, 0), "closedAt": instant(80, 0), "disassembledAt": null,
                "boxes": 2, "units": 2, "boxCountReported": 1,
                "printVerifiedAt": null, "printSkippedAt": instant(95, 0),
            },
            {
                // Taken apart, still listed; its box keeps the link, as in
                // the cloud.
                "id": p2, "deviceId": station, "sscc": pallet_sscc(41),
                "openedAt": instant(105, 0), "closedAt": instant(110, 0),
                "disassembledAt": instant(120, 0),
                "boxes": 1, "units": 1, "boxCountReported": 1,
                "printVerifiedAt": null, "printSkippedAt": null,
            },
        ])
    );
    let boxes = list(&admin, &shift, "boxes").await;
    let closed_at = |pallet: &str| {
        listed
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == pallet)
            .unwrap()["closedAt"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    // What the office flags, from the lists alone: a box closed after its
    // pallet, a pallet whose boxes are not the count the station reported.
    let late: Vec<&str> = boxes
        .as_array()
        .unwrap()
        .iter()
        .filter(|b| {
            b["palletId"]
                .as_str()
                .is_some_and(|pallet| b["closedAt"].as_str().unwrap() > closed_at(pallet).as_str())
        })
        .map(|b| b["id"].as_str().unwrap())
        .collect();
    assert_eq!(late, vec![box_id(2).as_str()]);
    let mismatched: Vec<&str> = listed
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| p["boxes"] != p["boxCountReported"])
        .map(|p| p["id"].as_str().unwrap())
        .collect();
    assert_eq!(mismatched, vec![p1.as_str()]);
    assert_eq!(boxes[1]["palletId"], p1);
    assert_eq!(boxes[1]["closedAt"], instant(90, 0));
}

/// Ties and the order of ids: boxes (and pallets) are listed by the instant
/// they opened, then by id, whatever order they reached the host or their
/// ids run in.
#[tokio::test]
async fn ties_in_the_opening_instant_are_listed_by_id() {
    let (admin, _, floor, _, pallets) = pallet_station().await;
    let shift = floor.shift.clone();
    let scan = |record: u32, code: u32, n: u32, second: u32| {
        fact(
            &record_id(record),
            "scan",
            &shift,
            ok_scan(code, &box_id(n), &instant(second, 0)),
        )
    };
    let closed = |record: u32, n: u32, serial: u64, opened: u32, closed: u32| {
        fact(
            &record_id(record),
            "pallet_closed",
            &shift,
            pallet_closed(
                &pallet_id(n),
                &pallets,
                serial,
                1,
                &instant(opened, 0),
                &instant(closed, 0),
            ),
        )
    };
    // Box 3 opens first, boxes 2 and 1 together, 2 arriving first; likewise
    // pallets, none with a box here.
    accept(
        &admin,
        &floor,
        &[
            scan(1, 1, 3, 10),
            scan(2, 2, 2, 20),
            scan(3, 3, 1, 20),
            closed(4, 3, 40, 10, 15),
            closed(5, 2, 41, 20, 25),
            closed(6, 1, 42, 20, 26),
        ],
    )
    .await;
    let boxes = list(&admin, &shift, "boxes").await;
    let ids: Vec<&str> = boxes
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![box_id(3), box_id(1), box_id(2)]);
    let listed = list(&admin, &shift, "pallets").await;
    let ids: Vec<&str> = listed
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![pallet_id(3), pallet_id(1), pallet_id(2)]);
}

/// A code taken out of a box before it closed is no unit of the box or of
/// its pallet; a close whose digest did not compare says so, with the count
/// the station reported beside the live one; a checked label says when.
#[tokio::test]
async fn an_undone_code_is_no_unit_and_a_close_that_did_not_compare_says_so() {
    let (admin, _, floor, block, pallets) = pallet_station().await;
    let shift = floor.shift.clone();
    let p1 = pallet_id(1);
    let mut undo = box_exception("undo", &box_id(1), &instant(12, 0));
    undo["codeHash"] = json!(code_hash(2));
    undo["targetScannedAt"] = json!(instant(11, 0));
    accept(
        &admin,
        &floor,
        &[
            fact(
                &record_id(1),
                "scan",
                &shift,
                ok_scan(1, &box_id(1), &instant(10, 0)),
            ),
            fact(
                &record_id(2),
                "scan",
                &shift,
                ok_scan(2, &box_id(1), &instant(11, 0)),
            ),
            fact(&record_id(3), "box_exception", &shift, undo),
            fact(
                &record_id(4),
                "box_closed",
                &shift,
                closed_on(&block, 1, 1500, &[1], 10, 20, Some(&p1)),
            ),
            fact(
                &record_id(5),
                "pallet_closed",
                &shift,
                pallet_closed(&p1, &pallets, 40, 1, &instant(20, 0), &instant(30, 0)),
            ),
            // Box 2 closes saying it held codes 3 and 4; it holds code 3.
            fact(
                &record_id(6),
                "scan",
                &shift,
                ok_scan(3, &box_id(2), &instant(40, 0)),
            ),
            fact(
                &record_id(7),
                "box_closed",
                &shift,
                closed_on(&block, 2, 1501, &[3, 4], 40, 50, None),
            ),
            fact(
                &record_id(8),
                "box_label",
                &shift,
                json!({ "boxId": box_id(2), "outcome": "verified", "at": instant(51, 0) }),
            ),
        ],
    )
    .await;
    let boxes = list(&admin, &shift, "boxes").await;
    assert_eq!(boxes[0]["units"], 1);
    assert_eq!(boxes[0]["itemCountReported"], 1);
    assert_eq!(boxes[0]["digestMatches"], true);
    assert_eq!(boxes[0]["printVerifiedAt"], Value::Null);
    assert_eq!(boxes[1]["units"], 1);
    assert_eq!(boxes[1]["itemCountReported"], 2);
    assert_eq!(boxes[1]["digestMatches"], false);
    assert_eq!(boxes[1]["printVerifiedAt"], instant(51, 0));
    assert_eq!(boxes[1]["printSkippedAt"], Value::Null);
    let listed = list(&admin, &shift, "pallets").await;
    assert_eq!(listed[0]["boxes"], 1);
    assert_eq!(listed[0]["units"], 1);
}

/// `count` boxes `start + 1..` of `floor`'s shift, closed and with two live
/// items each, five to a pallet (pallet `n` holds boxes `5n - 4..=5n`), written
/// straight into the tables (a day's output is far more than facts can send in
/// a test); box `n` opens `n` seconds after midnight of 9 October 2026 and
/// closes one later, a pallet opens with its first box and closes after its
/// last. `start` is a multiple of 5.
async fn fill_boxes(
    admin: &Admin,
    floor: &Floor,
    blocks: (&Value, &Value),
    start: u32,
    count: u32,
) {
    assert_eq!(start % 5, 0);
    let (box_block, pallet_block) = (
        blocks.0["id"].as_str().unwrap(),
        blocks.1["id"].as_str().unwrap(),
    );
    let at = |second: u32| {
        format!(
            "2026-10-09T{:02}:{:02}:{:02}.000Z",
            second / 3600,
            second / 60 % 60,
            second % 60
        )
    };
    let mut tx = admin.app.state.pool.begin().await.unwrap();
    for pallet in (start / 5 + 1)..=((start + count) / 5) {
        let (first, last) = (pallet * 5 - 4, pallet * 5);
        sqlx::query(
            "INSERT INTO pallets (id, shift_id, device_id, opened_at, closed_at, sscc, block_id, \
               serial, box_count_reported, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 5, ?)",
        )
        .bind(pallet_id(pallet))
        .bind(&floor.shift)
        .bind(&floor.station)
        .bind(at(first))
        .bind(at(last + 1))
        .bind(pallet_sscc(u64::from(pallet) + 100_000))
        .bind(pallet_block)
        .bind(i64::from(pallet) + 100_000)
        .bind("2026-10-09T12:00:00Z")
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    for n in (start + 1)..=(start + count) {
        sqlx::query(
            "INSERT INTO boxes (id, shift_id, device_id, opened_at, closed_at, sscc, block_id, \
               serial, item_count_reported, digest_matches, pallet_id, received_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, 1, ?, ?)",
        )
        .bind(box_id(n))
        .bind(&floor.shift)
        .bind(&floor.station)
        .bind(at(n))
        .bind(at(n + 1))
        .bind(sscc(u64::from(n) + 100_000))
        .bind(box_block)
        .bind(i64::from(n) + 100_000)
        .bind(pallet_id((n - 1) / 5 + 1))
        .bind("2026-10-09T12:00:00Z")
        .execute(&mut *tx)
        .await
        .unwrap();
        for k in 1..=2u32 {
            let scan = format!("c0000000-0000-4000-8000-{:012}", n * 2 + k);
            let hash = format!("{:064x}", u64::from(n) * 2 + u64::from(k) + 0x1000_0000);
            sqlx::query(
                "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, raw_kind, \
                   raw_length, code_hash, gtin14, serial, canonical, box_id, scanned_at, \
                   received_at) \
                 VALUES (?1, ?1, ?2, ?3, 'ok', 'km', 38, ?4, '04600682000013', ?5, ?5, ?6, ?7, ?8)",
            )
            .bind(&scan)
            .bind(&floor.station)
            .bind(&floor.shift)
            .bind(&hash)
            .bind(format!("B{:07}", n * 2 + k))
            .bind(box_id(n))
            .bind(at(n))
            .bind("2026-10-09T12:00:00Z")
            .execute(&mut *tx)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO box_items (scan_id, box_id, code_hash, added_at) VALUES (?, ?, ?, ?)",
            )
            .bind(&scan)
            .bind(box_id(n))
            .bind(&hash)
            .bind(at(n))
            .execute(&mut *tx)
            .await
            .unwrap();
        }
    }
    tx.commit().await.unwrap();
}

/// The plan of each list's query, step by step.
async fn plans(admin: &Admin, shift: &str) -> Vec<(&'static str, Vec<String>)> {
    let mut plans = Vec::new();
    for (name, sql) in [
        ("boxes", markiro_host::routes::office_boxes::BOXES_SQL),
        ("pallets", markiro_host::routes::office_boxes::PALLETS_SQL),
    ] {
        let rows: Vec<(i64, i64, i64, String)> =
            sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
                .bind(shift)
                .fetch_all(&admin.app.state.pool)
                .await
                .unwrap();
        plans.push((name, rows.into_iter().map(|(_, _, _, step)| step).collect()));
    }
    plans
}

/// What each list searches by, named: never a pass through a table, and the
/// per-row counts through the indexes made for them.
fn assert_each_list_uses_its_indexes(plans: &[(&str, Vec<String>)]) {
    let expected: [(&str, &[&str]); 2] = [
        ("boxes", &["boxes_shift", "box_items_live"]),
        (
            "pallets",
            &["pallets_shift", "boxes_pallet", "box_items_live"],
        ),
    ];
    assert_eq!(plans.len(), expected.len());
    for ((name, steps), (expected_name, indexes)) in plans.iter().zip(expected) {
        assert_eq!(*name, expected_name);
        assert!(
            steps.iter().all(|step| !step.starts_with("SCAN")),
            "{name}: {steps:?}"
        );
        for index in indexes {
            assert!(
                steps
                    .iter()
                    .any(|step| step.starts_with("SEARCH") && step.contains(index)),
                "{name} without {index}: {steps:?}"
            );
        }
    }
}

/// With no row at all, each list searches through the index made for it.
#[tokio::test]
async fn each_list_uses_the_indexes_made_for_it() {
    let (admin, _, floor, _, _) = pallet_station().await;
    assert_each_list_uses_its_indexes(&plans(&admin, &floor.shift).await);
}

/// A shift of fifteen hundred boxes on three hundred pallets comes whole, in
/// order and with the right counts in one answer each, the colleague's shift
/// of as many beside it is none of it, and with that many rows the queries
/// still search by their indexes (the host gathers no statistics, so the
/// plan is the one it has in production).
#[tokio::test]
async fn a_shift_of_thousands_of_boxes_comes_whole_in_order_and_still_by_the_indexes() {
    let (admin, setup, floor, block, pallets) = pallet_station().await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_pallet_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    fill_boxes(&admin, &floor, (&block, &pallets), 0, 1500).await;
    fill_boxes(&admin, &colleague, (&block, &pallets), 5000, 700).await;

    let boxes = list(&admin, &floor.shift, "boxes").await;
    let boxes = boxes.as_array().unwrap();
    assert_eq!(boxes.len(), 1500);
    for (index, listed) in boxes.iter().enumerate() {
        let n = u32::try_from(index).unwrap() + 1;
        assert_eq!(listed["id"], box_id(n), "box {n}");
        assert_eq!(listed["units"], 2, "box {n}");
        assert_eq!(listed["palletId"], pallet_id((n - 1) / 5 + 1), "box {n}");
    }
    assert_eq!(
        boxes[999],
        json!({
            "id": box_id(1000), "deviceId": floor.station, "operatorName": null, "sscc": sscc(101_000),
            "openedAt": "2026-10-09T00:16:40.000Z", "closedAt": "2026-10-09T00:16:41.000Z",
            "disassembledAt": null, "palletId": pallet_id(200), "units": 2,
            "itemCountReported": 2, "digestMatches": true,
            "printVerifiedAt": null, "printSkippedAt": null,
        })
    );
    let listed = list(&admin, &floor.shift, "pallets").await;
    let listed = listed.as_array().unwrap();
    assert_eq!(listed.len(), 300);
    for (index, pallet) in listed.iter().enumerate() {
        let n = u32::try_from(index).unwrap() + 1;
        assert_eq!(pallet["id"], pallet_id(n), "pallet {n}");
        assert_eq!(pallet["boxes"], 5, "pallet {n}");
        assert_eq!(pallet["units"], 10, "pallet {n}");
        assert_eq!(pallet["boxCountReported"], 5, "pallet {n}");
    }
    let theirs = list(&admin, &colleague.shift, "boxes").await;
    let theirs = theirs.as_array().unwrap();
    assert_eq!(theirs.len(), 700);
    assert_eq!(theirs[0]["id"], box_id(5001));
    assert_eq!(theirs[699]["id"], box_id(5700));
    let theirs = list(&admin, &colleague.shift, "pallets").await;
    let theirs = theirs.as_array().unwrap();
    assert_eq!(theirs.len(), 140);
    assert_eq!(theirs[0]["id"], pallet_id(1001));
    assert_eq!(theirs[0]["units"], 10);
    assert_each_list_uses_its_indexes(&plans(&admin, &floor.shift).await);
}
