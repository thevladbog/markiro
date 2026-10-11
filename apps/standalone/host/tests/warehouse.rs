//! Warehouse label reprint (plan СКЛ): any station looks up a unit, a box or
//! a pallet of any station and any shift of the site, and keeps its records
//! of what it printed.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    accepted, add_operator, admin, box_closed, box_id, code, code_hash, fact, instant, issue_block,
    issue_pallet_block, json as json_request, ok_scan, open_floor, open_pallet_floor, pair_device,
    pallet_closed, pallet_id, pallet_sscc, receipts, record_id, request, shift_closed, shift_setup,
    sscc, with_device, Admin, Floor,
};

const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const PALLET_REQUEST: &str = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";

/// `POST path` with `key` and `body`: the status and the body.
async fn post(admin: &Admin, key: &str, path: &str, body: Value) -> (StatusCode, Value) {
    admin
        .app
        .send(json_request(with_device(request("POST", path), key), body))
        .await
}

async fn lookup(admin: &Admin, key: &str, body: Value) -> (StatusCode, Value) {
    post(admin, key, "/v1/device/warehouse/lookup", body).await
}

/// A record `n` of `kind` in the floor's shift, by `operator`.
fn by(floor: &Floor, n: u32, kind: &str, data: Value, operator: &str) -> Value {
    let mut record = fact(&record_id(n), kind, &floor.shift, data);
    record["operatorId"] = json!(operator);
    record
}

/// A host whose first station scanned code 1 into box 1 and closed it with
/// serial 1500 (by Anna), and then closed its shift; and a second station,
/// which asks. Returns the host, the floor, the asking key and Anna's id.
async fn closed_shift_with_a_box() -> (Admin, Floor, String, String) {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (anna, _) = add_operator(&admin, "0042").await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let records = [
        by(
            &floor,
            1,
            "scan",
            ok_scan(1, &box_id(1), &instant(1, 0)),
            &anna,
        ),
        by(
            &floor,
            2,
            "box_closed",
            box_closed(
                &box_id(1),
                &block,
                1500,
                &[1],
                &instant(1, 0),
                &instant(2, 0),
            ),
            &anna,
        ),
        by(
            &floor,
            3,
            "shift_closed",
            shift_closed(None, 1, 1, None, &instant(10, 0)),
            &anna,
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &records).await,
        vec![
            accepted(&record_id(1)),
            accepted(&record_id(2)),
            accepted(&record_id(3))
        ]
    );
    let (_, asking) = pair_device(&admin.app, "station").await;
    (admin, floor, asking, anna)
}

fn product(admin_product: &str) -> Value {
    json!({
        "id": admin_product, "gtin14": "04600682000013", "name": "Молоко 3,2% 0,9 л",
        "printName": "Молоко 3,2%", "chzProductGroupCode": 8, "shelfLifeDays": 10
    })
}

#[tokio::test]
async fn a_unit_of_another_station_in_a_closed_shift_is_found_with_its_full_code() {
    let (admin, floor, asking, _) = closed_shift_with_a_box().await;
    let (status, body) = lookup(&admin, &asking, json!({ "codeHash": code_hash(1) })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "found");
    let source = &body["source"];
    assert_eq!(source["kind"], "unit");
    assert_eq!(source["identity"], code_hash(1));
    assert_eq!(source["canonical"], code(1)["canonical"]);
    assert!(source.get("sscc").is_none());
    assert_eq!(source["shiftId"], floor.shift);
    assert_eq!(source["shiftNumber"], floor.number);
    assert_eq!(source["productionDate"], "2026-10-08");
    assert_eq!(source["at"], instant(1, 0));
    assert_eq!(source["itemCount"], 1);
    assert_eq!(source["operatorName"], "Анна Кузнецова");
    assert_eq!(source["deviceId"], floor.station);
    assert_eq!(source["counterpartyName"], Value::Null);
    assert_eq!(
        source["product"],
        product(source["product"]["id"].as_str().unwrap())
    );
    // The record the scan wrote is what a reprint record names.
    assert!(source["subjectId"]
        .as_str()
        .is_some_and(|id| !id.is_empty()));
}

#[tokio::test]
async fn a_box_is_found_by_its_sscc_with_the_count_it_was_closed_with() {
    let (admin, floor, asking, _) = closed_shift_with_a_box().await;
    let (status, body) = lookup(&admin, &asking, json!({ "sscc": sscc(1500) })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let source = &body["source"];
    assert_eq!(
        (
            &source["kind"],
            &source["subjectId"],
            &source["sscc"],
            &source["identity"]
        ),
        (
            &json!("box"),
            &json!(box_id(1)),
            &json!(sscc(1500)),
            &json!(sscc(1500))
        )
    );
    assert_eq!(source["at"], instant(2, 0));
    assert_eq!(source["itemCount"], 1);
    assert!(source.get("canonical").is_none());
    assert!(source.get("boxCount").is_none());
    assert_eq!(source["shiftNumber"], floor.number);
}

#[tokio::test]
async fn a_pallet_is_found_by_its_sscc_with_its_boxes_and_their_units() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let mut closed = box_closed(
        &box_id(1),
        &block,
        1500,
        &[1],
        &instant(1, 0),
        &instant(2, 0),
    );
    closed["palletId"] = json!(pallet_id(1));
    let records = [
        fact(
            &record_id(1),
            "scan",
            &floor.shift,
            ok_scan(1, &box_id(1), &instant(1, 0)),
        ),
        fact(&record_id(2), "box_closed", &floor.shift, closed),
        fact(
            &record_id(3),
            "pallet_closed",
            &floor.shift,
            pallet_closed(
                &pallet_id(1),
                &pallets,
                40,
                1,
                &instant(2, 0),
                &instant(3, 0),
            ),
        ),
    ];
    let answered = receipts(&admin.app, &floor.key, &records).await;
    assert!(
        answered
            .iter()
            .all(|receipt| receipt["outcome"] == "accepted"),
        "{answered:?}"
    );
    let (status, body) = lookup(&admin, &floor.key, json!({ "sscc": pallet_sscc(40) })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let source = &body["source"];
    assert_eq!(source["kind"], "pallet");
    assert_eq!(source["subjectId"], pallet_id(1));
    assert_eq!(source["sscc"], pallet_sscc(40));
    assert_eq!(
        (&source["boxCount"], &source["itemCount"]),
        (&json!(1), &json!(1))
    );
    assert_eq!(source["at"], instant(3, 0));
    assert_eq!(source["operatorName"], Value::Null);
}

#[tokio::test]
async fn a_freed_code_and_a_box_taken_apart_are_unavailable_and_an_unknown_one_not_found() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let records = [
        fact(
            &record_id(1),
            "scan",
            &floor.shift,
            ok_scan(1, &box_id(1), &instant(1, 0)),
        ),
        fact(
            &record_id(2),
            "box_closed",
            &floor.shift,
            box_closed(
                &box_id(1),
                &block,
                1500,
                &[1],
                &instant(1, 0),
                &instant(2, 0),
            ),
        ),
        fact(
            &record_id(3),
            "box_exception",
            &floor.shift,
            json!({
                "exception": "disassemble", "boxId": box_id(1), "codeHash": null,
                "targetScannedAt": null, "reasonCode": "wrong_product", "reasonText": null,
                "occurredAt": instant(5, 0)
            }),
        ),
    ];
    let answered = receipts(&admin.app, &floor.key, &records).await;
    assert!(
        answered
            .iter()
            .all(|receipt| receipt["outcome"] == "accepted"),
        "{answered:?}"
    );
    let key = floor.key.clone();
    assert_eq!(
        lookup(&admin, &key, json!({ "sscc": sscc(1500) })).await,
        (
            StatusCode::OK,
            json!({ "status": "unavailable", "reason": "disassembled" })
        )
    );
    assert_eq!(
        lookup(&admin, &key, json!({ "codeHash": code_hash(1) })).await,
        (
            StatusCode::OK,
            json!({ "status": "unavailable", "reason": "released" })
        )
    );
    assert_eq!(
        lookup(&admin, &key, json!({ "codeHash": code_hash(99) })).await,
        (StatusCode::OK, json!({ "status": "not_found" }))
    );
    assert_eq!(
        lookup(&admin, &key, json!({ "sscc": sscc(2000) })).await,
        (StatusCode::OK, json!({ "status": "not_found" }))
    );
}

#[tokio::test]
async fn a_lookup_asks_exactly_one_well_formed_thing_with_a_live_key() {
    let admin = admin().await;
    let key = admin.key.clone();
    for (body, field) in [
        (json!({}), "codeHash"),
        (
            json!({ "codeHash": code_hash(1), "sscc": sscc(1500) }),
            "codeHash",
        ),
        (json!({ "codeHash": "ABC" }), "codeHash"),
        (json!({ "sscc": "12345" }), "sscc"),
        (json!({ "sscc": "04600682000001500a" }), "sscc"),
    ] {
        let (status, answer) = lookup(&admin, &key, body.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}: {answer}");
        assert_eq!(answer["error"]["code"], "validation_failed", "{body}");
        assert_eq!(answer["error"]["details"]["field"], field, "{body}");
    }
    let (status, _) = lookup(&admin, &key, json!({ "raw": "010460068200001321S000001" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, answer) = lookup(&admin, "not-a-key", json!({ "sscc": sscc(1500) })).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{answer}");
}

#[tokio::test]
async fn a_restore_holds_the_warehouse_routes() {
    let admin = admin().await;
    sqlx::query("UPDATE site SET facts_held_since = '2026-10-09T15:00:00Z' WHERE id = 1")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let key = admin.key.clone();
    for path in [
        "/v1/device/warehouse/lookup",
        "/v1/device/warehouse/reprints",
    ] {
        let (status, body) = post(&admin, &key, path, json!({ "sscc": sscc(1500) })).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{path}: {body}");
        assert_eq!(body["error"]["code"], "restore_pending", "{path}");
    }
}

// Tests beyond the plan's own: the shapes the Zod schema leaves to the host,
// whose device may ask, what a lookup leaves untouched, the frozen snapshot,
// the counts of a pallet, and the plan of every query.

#[tokio::test]
async fn a_lookup_of_another_shape_is_refused_by_field() {
    let admin = admin().await;
    let key = admin.key.clone();
    let upper = code_hash(255).to_uppercase();
    for (body, field) in [
        // A hash is 64 lower-case hex digits: not 63, not 65, not upper case,
        // not hex at all, not empty.
        (json!({ "codeHash": &code_hash(1)[1..] }), "codeHash"),
        (
            json!({ "codeHash": format!("0{}", code_hash(1)) }),
            "codeHash",
        ),
        (json!({ "codeHash": upper }), "codeHash"),
        (json!({ "codeHash": "g".repeat(64) }), "codeHash"),
        (json!({ "codeHash": "" }), "codeHash"),
        // An SSCC is exactly 18 ASCII digits.
        (json!({ "sscc": &sscc(1500)[1..] }), "sscc"),
        (json!({ "sscc": format!("{}0", sscc(1500)) }), "sscc"),
        (json!({ "sscc": "٠".repeat(9) }), "sscc"),
        (json!({ "sscc": "0460068200 01500a" }), "sscc"),
        (json!({ "sscc": "" }), "sscc"),
        // Both nulls ask nothing.
        (json!({ "codeHash": null, "sscc": null }), "codeHash"),
    ] {
        let (status, answer) = lookup(&admin, &key, body.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}: {answer}");
        assert_eq!(answer["error"]["code"], "validation_failed", "{body}");
        assert_eq!(answer["error"]["details"]["field"], field, "{body}");
    }
    // A value of another type is no lookup either (the body is unreadable).
    for body in [
        json!({ "sscc": 460068200001500118_u64 }),
        json!({ "codeHash": [] }),
    ] {
        let (status, answer) = lookup(&admin, &key, body.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}: {answer}");
        assert_eq!(answer["error"]["code"], "validation_failed", "{body}");
    }
    // An explicit null reads as an absent field: `Option` on the wire. The
    // station's schema is the stricter side; the host stays the one that
    // decides by what the body holds.
    let (status, answer) = lookup(
        &admin,
        &key,
        json!({ "codeHash": null, "sscc": sscc(2000) }),
    )
    .await;
    assert_eq!(
        (status, answer),
        (StatusCode::OK, json!({ "status": "not_found" }))
    );
}

#[tokio::test]
async fn only_a_station_looks_up_and_without_a_key_nothing_is_answered() {
    let (admin, _, asking, _) = closed_shift_with_a_box().await;
    let (_, office) = pair_device(&admin.app, "office").await;
    let (status, answer) = lookup(&admin, &office, json!({ "codeHash": code_hash(1) })).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{answer}");
    assert_eq!(answer["error"]["code"], "forbidden");
    assert!(
        !answer
            .to_string()
            .contains(&code(1)["canonical"].as_str().unwrap()[..20]),
        "{answer}"
    );
    let (status, answer) = admin
        .app
        .send(json_request(
            request("POST", "/v1/device/warehouse/lookup"),
            json!({ "codeHash": code_hash(1) }),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{answer}");
    // The station itself is answered.
    let (status, _) = lookup(&admin, &asking, json!({ "codeHash": code_hash(1) })).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn a_lookup_writes_no_fact_no_audit_row_and_no_revision() {
    let (admin, _, asking, _) = closed_shift_with_a_box().await;
    // The asking device is already seen, so even its `last_seen_at` is due
    // only after a minute: nothing at all is written.
    let before = support::app::fact_rows(&admin.app).await;
    let audit: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_log")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let revision = support::app::host_revision(&admin.app).await;
    for body in [
        json!({ "codeHash": code_hash(1) }),
        json!({ "sscc": sscc(1500) }),
        json!({ "codeHash": code_hash(99) }),
    ] {
        let (status, _) = lookup(&admin, &asking, body).await;
        assert_eq!(status, StatusCode::OK);
    }
    assert_eq!(support::app::fact_rows(&admin.app).await, before);
    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_log")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(after, audit);
    assert_eq!(support::app::host_revision(&admin.app).await, revision);
}

#[tokio::test]
async fn a_box_is_printed_with_the_count_it_was_closed_with_and_its_operator() {
    let (admin, floor, asking, _) = closed_shift_with_a_box().await;
    let (_, body) = lookup(&admin, &asking, json!({ "sscc": sscc(1500) })).await;
    assert_eq!(body["source"]["operatorName"], "Анна Кузнецова", "{body}");
    assert_eq!(body["source"]["deviceId"], floor.station, "{body}");
    // The reported count wins over what the items add up to now...
    sqlx::query("UPDATE boxes SET item_count_reported = 7")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (_, body) = lookup(&admin, &asking, json!({ "sscc": sscc(1500) })).await;
    assert_eq!(body["source"]["itemCount"], 7, "{body}");
    // ...and a box that reported none is counted by its live items.
    sqlx::query("UPDATE boxes SET item_count_reported = NULL")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (_, body) = lookup(&admin, &asking, json!({ "sscc": sscc(1500) })).await;
    assert_eq!(body["source"]["itemCount"], 1, "{body}");
    sqlx::query("UPDATE box_items SET removed_at = '2026-10-08T06:00:09.000Z'")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (_, body) = lookup(&admin, &asking, json!({ "sscc": sscc(1500) })).await;
    assert_eq!(body["source"]["itemCount"], 0, "{body}");
    sqlx::query(
        "UPDATE box_items SET removed_at = NULL, displaced_at = '2026-10-08T06:00:09.000Z'",
    )
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    let (_, body) = lookup(&admin, &asking, json!({ "sscc": sscc(1500) })).await;
    assert_eq!(body["source"]["itemCount"], 0, "{body}");
}

/// A pallet of two closed boxes (serials 1500 and 1501, one unit each),
/// closed with serial 40 and a count of 2 boxes; the second box can then be
/// taken apart.
async fn a_pallet_of_two_boxes() -> (Admin, Floor) {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (anna, _) = add_operator(&admin, "0042").await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let mut first = box_closed(
        &box_id(1),
        &block,
        1500,
        &[1],
        &instant(1, 0),
        &instant(2, 0),
    );
    first["palletId"] = json!(pallet_id(1));
    let mut second = box_closed(
        &box_id(2),
        &block,
        1501,
        &[2],
        &instant(3, 0),
        &instant(4, 0),
    );
    second["palletId"] = json!(pallet_id(1));
    let records = [
        fact(
            &record_id(1),
            "scan",
            &floor.shift,
            ok_scan(1, &box_id(1), &instant(1, 0)),
        ),
        fact(&record_id(2), "box_closed", &floor.shift, first),
        fact(
            &record_id(3),
            "scan",
            &floor.shift,
            ok_scan(2, &box_id(2), &instant(3, 0)),
        ),
        fact(&record_id(4), "box_closed", &floor.shift, second),
        by(
            &floor,
            5,
            "pallet_closed",
            pallet_closed(
                &pallet_id(1),
                &pallets,
                40,
                2,
                &instant(2, 0),
                &instant(5, 0),
            ),
            &anna,
        ),
    ];
    let answered = receipts(&admin.app, &floor.key, &records).await;
    assert!(
        answered
            .iter()
            .all(|receipt| receipt["outcome"] == "accepted"),
        "{answered:?}"
    );
    (admin, floor)
}

#[tokio::test]
async fn a_pallet_counts_the_units_of_the_boxes_not_taken_apart() {
    let (admin, floor) = a_pallet_of_two_boxes().await;
    let key = floor.key.clone();
    let (_, body) = lookup(&admin, &key, json!({ "sscc": pallet_sscc(40) })).await;
    assert_eq!(
        (&body["source"]["boxCount"], &body["source"]["itemCount"]),
        (&json!(2), &json!(2)),
        "{body}"
    );
    assert_eq!(
        (
            &body["source"]["subjectId"],
            &body["source"]["shiftId"],
            &body["source"]["deviceId"],
            &body["source"]["shiftNumber"]
        ),
        (
            &json!(pallet_id(1)),
            &json!(floor.shift),
            &json!(floor.station),
            &json!(floor.number)
        ),
        "{body}"
    );
    assert_eq!(body["source"]["operatorName"], "Анна Кузнецова", "{body}");
    // A box taken apart leaves the units, the count the pallet was closed
    // with stays what it was printed with.
    let taken = fact(
        &record_id(6),
        "box_exception",
        &floor.shift,
        json!({
            "exception": "disassemble", "boxId": box_id(2), "codeHash": null,
            "targetScannedAt": null, "reasonCode": "wrong_product", "reasonText": null,
            "occurredAt": instant(6, 0)
        }),
    );
    let answered = receipts(&admin.app, &key, &[taken]).await;
    assert_eq!(answered, vec![accepted(&record_id(6))]);
    let (_, body) = lookup(&admin, &key, json!({ "sscc": pallet_sscc(40) })).await;
    assert_eq!(
        (&body["source"]["boxCount"], &body["source"]["itemCount"]),
        (&json!(2), &json!(1)),
        "{body}"
    );
    // Every box taken apart: a pallet with no unit left counts none (and
    // is still a pallet, not an error).
    let taken = fact(
        &record_id(7),
        "box_exception",
        &floor.shift,
        json!({
            "exception": "disassemble", "boxId": box_id(1), "codeHash": null,
            "targetScannedAt": null, "reasonCode": "wrong_product", "reasonText": null,
            "occurredAt": instant(7, 0)
        }),
    );
    let answered = receipts(&admin.app, &key, &[taken]).await;
    assert_eq!(answered, vec![accepted(&record_id(7))]);
    let (status, body) = lookup(&admin, &key, json!({ "sscc": pallet_sscc(40) })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        (&body["source"]["boxCount"], &body["source"]["itemCount"]),
        (&json!(2), &json!(0)),
        "{body}"
    );
}

#[tokio::test]
async fn a_pallet_taken_apart_is_unavailable() {
    let (admin, floor) = a_pallet_of_two_boxes().await;
    let taken = fact(
        &record_id(6),
        "pallet_exception",
        &floor.shift,
        json!({
            "exception": "disassemble", "palletId": pallet_id(1), "reasonCode": "other",
            "reasonText": "Перепутали товар", "occurredAt": instant(6, 0)
        }),
    );
    let answered = receipts(&admin.app, &floor.key, &[taken]).await;
    assert_eq!(answered, vec![accepted(&record_id(6))]);
    let key = floor.key.clone();
    assert_eq!(
        lookup(&admin, &key, json!({ "sscc": pallet_sscc(40) })).await,
        (
            StatusCode::OK,
            json!({ "status": "unavailable", "reason": "disassembled" })
        )
    );
    // The boxes of the pallet are still found on their own.
    let (status, body) = lookup(&admin, &key, json!({ "sscc": sscc(1500) })).await;
    assert_eq!(
        (status, &body["status"]),
        (StatusCode::OK, &json!("found")),
        "{body}"
    );
}

#[tokio::test]
async fn a_label_is_made_from_the_frozen_shift_and_the_counterparty_it_named() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (status, berth) = admin
        .call(
            "POST",
            "/v1/office/counterparties",
            Some(json!({ "name": "ООО «Северный берег»", "gln": "4601234000017", "gs1Prefixes": [] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{berth}");
    // A station's own shift (the number ends `/S`), for a counterparty.
    let key = admin.key.clone();
    let (status, moved) = admin
        .app
        .send(json_request(
            with_device(request("PUT", "/v1/device/line"), &key),
            json!({ "lineId": setup.line }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    let (status, created) = admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/shifts"), &key),
            json!({
                "requestId": BLOCK_REQUEST, "productId": setup.product,
                "boxTemplateId": setup.template, "productionDate": "2026-10-09",
                "counterpartyId": berth["id"]
            }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let shift = created["id"].as_str().unwrap().to_owned();
    let (status, entered) = admin
        .app
        .send(support::app::empty(with_device(
            request("POST", &format!("/v1/device/shifts/{shift}/enter")),
            &key,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    let number = created["number"].as_str().unwrap().to_owned();
    assert!(number.ends_with("/S"), "{number}");
    let block = issue_block(&admin.app, &key, PALLET_REQUEST).await;
    let records = [
        fact(
            &record_id(1),
            "scan",
            &shift,
            ok_scan(1, &box_id(1), &instant(1, 0)),
        ),
        fact(
            &record_id(2),
            "box_closed",
            &shift,
            box_closed(
                &box_id(1),
                &block,
                1500,
                &[1],
                &instant(1, 0),
                &instant(2, 0),
            ),
        ),
    ];
    let answered = receipts(&admin.app, &key, &records).await;
    assert!(
        answered
            .iter()
            .all(|receipt| receipt["outcome"] == "accepted"),
        "{answered:?}"
    );
    // The product is edited in the office afterwards: the label still says
    // what the shift froze.
    sqlx::query("UPDATE products SET name = 'Кефир', print_name = NULL, shelf_life_days = 3")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    for body in [
        json!({ "codeHash": code_hash(1) }),
        json!({ "sscc": sscc(1500) }),
    ] {
        let (status, answer) = lookup(&admin, &key, body.clone()).await;
        assert_eq!(status, StatusCode::OK, "{body}: {answer}");
        let source = &answer["source"];
        assert_eq!(source["shiftNumber"], json!(number), "{body}");
        assert_eq!(source["shiftId"], json!(shift), "{body}");
        assert_eq!(source["productionDate"], "2026-10-09", "{body}");
        assert_eq!(source["counterpartyName"], "ООО «Северный берег»", "{body}");
        assert_eq!(source["product"], product(&setup.product), "{body}");
        // A unit scanned without an operator names none.
        assert_eq!(source["operatorName"], Value::Null, "{body}");
    }
}

#[tokio::test]
async fn every_query_of_a_lookup_searches_by_an_index() {
    let admin = admin().await;
    use markiro_host::routes::warehouse::{
        BOX_SQL, PALLET_SQL, SHIFT_SQL, UNIT_SEEN_SQL, UNIT_SQL,
    };
    // Each query with a value to bind and the indexes its plan must use.
    for (sql, bound, indexes) in [
        (
            UNIT_SQL,
            code_hash(1),
            &[
                "o USING INDEX sqlite_autoindex_code_owners_1 (code_hash=?)",
                "s USING INDEX sqlite_autoindex_scans_1 (id=?)",
                "op USING INDEX sqlite_autoindex_operators_1 (id=?)",
            ][..],
        ),
        (
            UNIT_SEEN_SQL,
            code_hash(1),
            &["scans USING INDEX scans_code_hash (code_hash=?)"][..],
        ),
        (
            BOX_SQL,
            sscc(1500),
            &[
                "b USING INDEX boxes_sscc (sscc=?)",
                "op USING INDEX sqlite_autoindex_operators_1 (id=?)",
                "i USING INDEX box_items_live (box_id=?)",
            ][..],
        ),
        (
            PALLET_SQL,
            pallet_sscc(40),
            &[
                "p USING INDEX pallets_sscc (sscc=?)",
                "op USING INDEX sqlite_autoindex_operators_1 (id=?)",
                "b USING INDEX boxes_pallet (pallet_id=?)",
            ][..],
        ),
        (
            SHIFT_SQL,
            box_id(1),
            &["shifts USING INDEX sqlite_autoindex_shifts_1 (id=?)"][..],
        ),
    ] {
        let plan: Vec<(i64, i64, i64, String)> =
            sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
                .bind(bound)
                .fetch_all(&admin.app.state.pool)
                .await
                .unwrap();
        let steps: Vec<String> = plan.into_iter().map(|(_, _, _, step)| step).collect();
        assert!(
            steps.iter().all(|step| !step.starts_with("SCAN")),
            "{sql}: {steps:?}"
        );
        for index in indexes {
            assert!(
                steps.iter().any(|step| step.contains(index)),
                "{sql}: no {index} in {steps:?}"
            );
        }
    }
}

#[tokio::test]
async fn a_code_that_was_never_accepted_is_not_found_not_released() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    // A scan of the wrong product keeps the code's hash in the journal but
    // makes no unit: the code was never accepted, so it was never freed.
    let wrong = fact(
        &record_id(1),
        "scan",
        &floor.shift,
        json!({
            "scannedAt": instant(1, 0), "verdict": "wrong_gtin", "duplicateSource": null,
            "rawKind": "km", "rawLength": 38, "code": code(5), "boxId": null
        }),
    );
    let answered = receipts(&admin.app, &floor.key, &[wrong]).await;
    assert_eq!(answered, vec![accepted(&record_id(1))]);
    let journal: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scans WHERE code_hash = ?")
        .bind(code_hash(5))
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(journal, 1);
    assert_eq!(
        lookup(
            &admin,
            &floor.key.clone(),
            json!({ "codeHash": code_hash(5) })
        )
        .await,
        (StatusCode::OK, json!({ "status": "not_found" }))
    );
}

/// The lookup reads in one transaction, which is a snapshot of the whole
/// answer (a unit's scan, its freed-or-never test and its shift). A snapshot
/// cannot be interleaved with a writer from a test, so the shape of the
/// handler is pinned: it begins a transaction, reads inside it, and ends it
/// by rolling back (it writes nothing).
#[test]
fn the_lookup_reads_inside_one_transaction_that_it_rolls_back() {
    let source = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/routes/warehouse.rs"),
    )
    .unwrap();
    assert_eq!(source.matches("state.pool.begin()").count(), 1);
    assert_eq!(source.matches("tx.rollback()").count(), 1);
    assert_eq!(source.matches("tx.commit()").count(), 0);
    assert_eq!(
        source.matches("state.pool").count(),
        1,
        "a read outside the transaction"
    );
    assert_eq!(source.matches("&mut tx").count(), 2);
}
