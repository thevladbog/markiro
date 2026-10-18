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
        "printName": "Молоко 3,2%", "chzProductGroupCode": 8, "shelfLifeDays": 10,
        "egaisCode": null
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
    for kind in ["office", "handheld"] {
        // A handheld pairs by a code, not locally: pair an office device and
        // store its kind as the other (the answer would carry a full code).
        let (id, other) = pair_device(&admin.app, "office").await;
        sqlx::query("UPDATE devices SET kind = ? WHERE id = ?")
            .bind(kind)
            .bind(&id)
            .execute(&admin.app.state.pool)
            .await
            .unwrap();
        for body in [
            json!({ "codeHash": code_hash(1) }),
            json!({ "sscc": sscc(1500) }),
        ] {
            let (status, answer) = lookup(&admin, &other, body).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{kind}: {answer}");
            assert_eq!(answer["error"]["code"], "forbidden", "{kind}");
            assert!(
                !answer
                    .to_string()
                    .contains(&code(1)["canonical"].as_str().unwrap()[..20]),
                "{kind}: {answer}"
            );
        }
    }
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
    let whole = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/routes/warehouse.rs"),
    )
    .unwrap();
    // The lookup is the first half of the file; the records (a write
    // transaction of their own) follow it.
    let (source, _) = whole
        .split_once("/// The body as the host reads it")
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

const SESSION: &str = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const JOB: &str = "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a";

/// Record `n` of a reprint of `subject_id`/`identity` of `kind`, sent.
fn reprint(n: u32, kind: &str, subject_id: &str, identity: &str) -> Value {
    json!({
        "id": record_id(n), "sessionId": SESSION, "jobId": JOB, "attempt": 1,
        "subjectKind": kind, "subjectId": subject_id, "identity": identity,
        "reasonCode": "damaged", "repair": null, "templateId": "template-1", "templateRev": 3,
        "outcome": "sent", "errorCode": null, "operatorId": null, "occurredAt": instant(20, 0)
    })
}

async fn send_records(admin: &Admin, key: &str, records: &[Value]) -> Vec<Value> {
    let (status, body) = post(
        admin,
        key,
        "/v1/device/warehouse/reprints",
        json!({ "records": records }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["receipts"].as_array().unwrap().clone()
}

async fn reprint_rows(admin: &Admin) -> Vec<(String, String, String, i64, Option<String>)> {
    sqlx::query_as(
        "SELECT record_id, subject_kind, outcome, attempt, error_code FROM warehouse_reprints \
         ORDER BY record_id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn records_are_kept_once_and_answered_like_facts() {
    let (admin, _floor, asking, _) = closed_shift_with_a_box().await;
    let (_, unit) = lookup(&admin, &asking, json!({ "codeHash": code_hash(1) })).await;
    let scan = unit["source"]["subjectId"].as_str().unwrap().to_owned();
    let mut unknown = reprint(2, "unit", &scan, &code_hash(1));
    unknown["outcome"] = json!("unknown");
    unknown["errorCode"] = json!("timeout");
    unknown["attempt"] = json!(2);
    let first = [reprint(1, "box", &box_id(1), &sscc(1500)), unknown.clone()];
    assert_eq!(
        send_records(&admin, &asking, &first).await,
        vec![accepted(&record_id(1)), accepted(&record_id(2))]
    );
    // The same records again: the same receipts, nothing written twice.
    assert_eq!(
        send_records(&admin, &asking, &first).await,
        vec![accepted(&record_id(1)), accepted(&record_id(2))]
    );
    assert_eq!(
        reprint_rows(&admin).await,
        vec![
            (record_id(1), "box".into(), "sent".into(), 1, None),
            (
                record_id(2),
                "unit".into(),
                "unknown".into(),
                2,
                Some("timeout".into())
            ),
        ]
    );
    // Other content under a kept id; a subject the host does not have; a
    // record it cannot read, with and without a readable id.
    let mut changed = reprint(1, "box", &box_id(1), &sscc(1500));
    changed["reasonCode"] = json!("lost");
    let mut foreign = reprint(3, "box", &box_id(7), &sscc(1500));
    foreign["subjectId"] = json!(box_id(7));
    let mut broken = reprint(4, "box", &box_id(1), &sscc(1500));
    broken["outcome"] = json!("failed");
    assert_eq!(
        send_records(
            &admin,
            &asking,
            &[changed, foreign, broken, json!({ "id": 5 })]
        )
        .await,
        vec![
            json!({ "id": record_id(1), "outcome": "rejected", "code": "payload_mismatch" }),
            json!({ "id": record_id(3), "outcome": "rejected", "code": "subject_unknown" }),
            json!({ "id": record_id(4), "outcome": "rejected", "code": "invalid_record" }),
            json!({ "id": null, "outcome": "rejected", "code": "invalid_record" }),
        ]
    );
    assert_eq!(reprint_rows(&admin).await.len(), 2);
    // A reprint changes nothing of what it printed.
    let (verified, skipped): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT print_verified_at, print_skipped_at FROM boxes WHERE id = ?")
            .bind(box_id(1))
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!((verified, skipped), (None, None));
}

#[tokio::test]
async fn each_field_of_a_record_keeps_its_rule() {
    let (admin, _floor, asking, _) = closed_shift_with_a_box().await;
    let good = reprint(1, "box", &box_id(1), &sscc(1500));
    let bad: Vec<(&str, Value)> = vec![
        ("id", json!("not-a-uuid")),
        ("sessionId", json!("X")),
        ("attempt", json!(-1)),
        ("subjectKind", json!("crate")),
        ("subjectId", json!("")),
        ("identity", json!("12345")),
        ("reasonCode", json!("other")),
        ("repair", json!("trim")),
        ("templateRev", json!(-1)),
        ("outcome", json!("printed")),
        ("errorCode", json!("timeout")),
        ("operatorId", json!("anna")),
        ("occurredAt", json!("2026-10-08T06:00:20Z")),
    ];
    let mut records = Vec::new();
    for (n, (field, value)) in bad.iter().enumerate() {
        let mut record = good.clone();
        record["id"] = json!(record_id(100 + u32::try_from(n).unwrap()));
        record[*field] = value.clone();
        records.push(record);
    }
    let answered = send_records(&admin, &asking, &records).await;
    for (receipt, (field, _)) in answered.iter().zip(&bad) {
        assert_eq!(receipt["code"], "invalid_record", "{field}: {receipt}");
    }
    // A legacy repair only on a box or a pallet; a unit with one is refused.
    let mut unit = reprint(200, "unit", "scan-1", &code_hash(1));
    unit["repair"] = json!("legacy_tspl_fnc1_literal");
    assert_eq!(
        send_records(&admin, &asking, &[unit]).await[0]["code"],
        "invalid_record"
    );
    let (status, body) = post(
        &admin,
        &asking,
        "/v1/device/warehouse/reprints",
        json!({ "records": [] }),
    )
    .await;
    assert_eq!(
        (status, &body["error"]["details"]["field"]),
        (StatusCode::BAD_REQUEST, &json!("records"))
    );
    assert!(reprint_rows(&admin).await.is_empty());
}

// Tests beyond the plan's own for the records: what each row keeps, the
// identity of the subject, one station's ids against another's, the batch's
// edges, who may record, the nullable keys against the Zod schema, the CHECKs
// of the table, the plans, the shape of the write, and the migration order.

/// Every column of the one row of `record_id`, as text, in table order.
async fn reprint_row(admin: &Admin, device_id: &str, record_id: &str) -> Vec<Option<String>> {
    let row = sqlx::query("SELECT * FROM warehouse_reprints WHERE device_id = ? AND record_id = ?")
        .bind(device_id)
        .bind(record_id)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    use sqlx::Row as _;
    (0..row.columns().len())
        .map(|index| match row.try_get::<Option<String>, _>(index) {
            Ok(text) => text,
            Err(_) => Some(row.get::<i64, _>(index).to_string()),
        })
        .collect()
}

#[tokio::test]
async fn a_record_of_each_kind_is_kept_exactly_as_sent_and_changes_nothing() {
    let (admin, _floor) = a_pallet_of_two_boxes().await;
    let (station, key) = pair_device(&admin.app, "station").await;
    let (_, unit) = lookup(&admin, &key, json!({ "codeHash": code_hash(1) })).await;
    let scan = unit["source"]["subjectId"].as_str().unwrap().to_owned();
    let operator = "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b";
    let mut unit_record = reprint(1, "unit", &scan, &code_hash(1));
    unit_record["operatorId"] = json!(operator);
    let mut box_record = reprint(2, "box", &box_id(1), &sscc(1500));
    box_record["repair"] = json!("legacy_tspl_fnc1_literal");
    box_record["attempt"] = json!(0);
    box_record["reasonCode"] = json!("not_printed");
    let mut pallet_record = reprint(3, "pallet", &pallet_id(1), &pallet_sscc(40));
    pallet_record["outcome"] = json!("failed");
    pallet_record["errorCode"] = json!("printer_offline");
    pallet_record["reasonCode"] = json!("lost");
    pallet_record["templateRev"] = json!(0);
    let records = [
        unit_record.clone(),
        box_record.clone(),
        pallet_record.clone(),
    ];
    let facts_before = support::app::fact_rows(&admin.app).await;
    let audit = || async {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM audit_log")
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap()
    };
    let audit_before = audit().await;
    let revision = support::app::host_revision(&admin.app).await;
    assert_eq!(
        send_records(&admin, &key, &records).await,
        vec![
            accepted(&record_id(1)),
            accepted(&record_id(2)),
            accepted(&record_id(3))
        ]
    );
    let received_at = admin.app.state.timestamp();
    for record in &records {
        let text = |name: &str| record[name].as_str().map(str::to_owned);
        let number = |name: &str| Some(record[name].as_i64().unwrap().to_string());
        let id = record["id"].as_str().unwrap();
        assert_eq!(
            reprint_row(&admin, &station, id).await,
            vec![
                Some(station.clone()),
                text("id"),
                Some(markiro_host::facts::rules::record_digest(record)),
                text("sessionId"),
                text("jobId"),
                number("attempt"),
                text("subjectKind"),
                text("subjectId"),
                text("identity"),
                text("reasonCode"),
                text("repair"),
                text("templateId"),
                number("templateRev"),
                text("outcome"),
                text("errorCode"),
                text("operatorId"),
                text("occurredAt"),
                Some(received_at.clone()),
            ],
            "{record}"
        );
    }
    // Facts, boxes, pallets, codes, the audit trail and the revision are as
    // they were: a reprint is a trail, not a change of what it printed.
    assert_eq!(support::app::fact_rows(&admin.app).await, facts_before);
    assert_eq!(audit().await, audit_before);
    assert_eq!(support::app::host_revision(&admin.app).await, revision);
}

#[tokio::test]
async fn a_record_names_its_subject_by_id_and_identity_together() {
    let (admin, _floor) = a_pallet_of_two_boxes().await;
    let (_, key) = pair_device(&admin.app, "station").await;
    let (_, unit) = lookup(&admin, &key, json!({ "codeHash": code_hash(1) })).await;
    let scan = unit["source"]["subjectId"].as_str().unwrap().to_owned();
    // The right id with another (well-formed) identity, and the right
    // identity with another id, for each kind.
    let records = [
        reprint(1, "unit", &scan, &code_hash(2)),
        reprint(2, "unit", &record_id(77), &code_hash(1)),
        reprint(3, "box", &box_id(1), &sscc(1501)),
        reprint(4, "box", &box_id(2), &sscc(1500)),
        reprint(5, "pallet", &pallet_id(1), &pallet_sscc(41)),
        reprint(6, "pallet", &pallet_id(2), &pallet_sscc(40)),
        // A box's id with a pallet kind, and a pallet's SSCC with a box kind.
        reprint(7, "pallet", &box_id(1), &sscc(1500)),
        reprint(8, "box", &pallet_id(1), &pallet_sscc(40)),
    ];
    let answered = send_records(&admin, &key, &records).await;
    for (n, receipt) in answered.iter().enumerate() {
        assert_eq!(
            receipt,
            &json!({ "id": record_id(u32::try_from(n).unwrap() + 1), "outcome": "rejected",
                     "code": "subject_unknown" }),
        );
    }
    assert!(reprint_rows(&admin).await.is_empty());
    // And the matching ones are kept.
    let right = [
        reprint(11, "unit", &scan, &code_hash(1)),
        reprint(12, "box", &box_id(2), &sscc(1501)),
        reprint(13, "pallet", &pallet_id(1), &pallet_sscc(40)),
    ];
    assert!(send_records(&admin, &key, &right)
        .await
        .iter()
        .all(|receipt| receipt["outcome"] == "accepted"));
    assert_eq!(reprint_rows(&admin).await.len(), 3);
}

#[tokio::test]
async fn a_box_taken_apart_and_a_freed_code_still_leave_the_trail_of_their_reprint() {
    // The host keeps what the station printed even if the box was taken
    // apart (or a code freed) since: the record is history, the lookup is
    // what refuses to print again.
    let (admin, _floor, asking, _) = closed_shift_with_a_box().await;
    sqlx::query("UPDATE boxes SET disassembled_at = '2026-10-08T07:00:00Z' WHERE id = ?")
        .bind(box_id(1))
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(
        send_records(
            &admin,
            &asking,
            &[reprint(1, "box", &box_id(1), &sscc(1500))]
        )
        .await,
        vec![accepted(&record_id(1))]
    );
}

#[tokio::test]
async fn one_stations_record_ids_are_not_anothers() {
    let (admin, _floor, first, _) = closed_shift_with_a_box().await;
    let (second_id, second) = pair_device(&admin.app, "station").await;
    let record = reprint(1, "box", &box_id(1), &sscc(1500));
    let mut other = record.clone();
    other["reasonCode"] = json!("lost");
    // The first station keeps id 1; the second keeps its own record under
    // the same id with other content, and neither is told it clashes.
    assert_eq!(
        send_records(&admin, &first, &[record.clone()]).await,
        vec![accepted(&record_id(1))]
    );
    assert_eq!(
        send_records(&admin, &second, &[other.clone()]).await,
        vec![accepted(&record_id(1))]
    );
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT device_id, reason_code FROM warehouse_reprints WHERE record_id = ?")
            .bind(record_id(1))
            .fetch_all(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert!(rows.contains(&(second_id, "lost".into())), "{rows:?}");
    // Each is still held to its own content.
    assert_eq!(
        send_records(&admin, &first, &[other]).await[0]["code"],
        "payload_mismatch"
    );
    assert_eq!(
        send_records(&admin, &second, &[record]).await[0]["code"],
        "payload_mismatch"
    );
}

#[tokio::test]
async fn a_batch_answers_each_record_in_order_even_with_a_repeat_inside_it() {
    let (admin, _floor, asking, _) = closed_shift_with_a_box().await;
    let first = reprint(1, "box", &box_id(1), &sscc(1500));
    let mut clash = first.clone();
    clash["attempt"] = json!(2);
    let mut broken = reprint(2, "box", &box_id(1), &sscc(1500));
    broken["identity"] = json!("short");
    let batch = [
        first.clone(),
        first,
        clash,
        broken,
        json!("not an object"),
        json!(null),
        reprint(3, "box", &box_id(1), &sscc(1500)),
    ];
    assert_eq!(
        send_records(&admin, &asking, &batch).await,
        vec![
            accepted(&record_id(1)),
            accepted(&record_id(1)),
            json!({ "id": record_id(1), "outcome": "rejected", "code": "payload_mismatch" }),
            json!({ "id": record_id(2), "outcome": "rejected", "code": "invalid_record" }),
            json!({ "id": null, "outcome": "rejected", "code": "invalid_record" }),
            json!({ "id": null, "outcome": "rejected", "code": "invalid_record" }),
            accepted(&record_id(3)),
        ]
    );
    assert_eq!(
        reprint_rows(&admin)
            .await
            .into_iter()
            .map(|row| row.0)
            .collect::<Vec<_>>(),
        vec![record_id(1), record_id(3)]
    );
}

#[tokio::test]
async fn a_batch_is_one_to_a_hundred_records_of_nothing_else() {
    let (admin, _floor, asking, _) = closed_shift_with_a_box().await;
    let path = "/v1/device/warehouse/reprints";
    let hundred: Vec<Value> = (1..=100)
        .map(|n| reprint(n, "box", &box_id(1), &sscc(1500)))
        .collect();
    let answered = send_records(&admin, &asking, &hundred).await;
    assert_eq!(answered.len(), 100);
    assert!(answered
        .iter()
        .all(|receipt| receipt["outcome"] == "accepted"));
    assert_eq!(reprint_rows(&admin).await.len(), 100);
    let mut too_many = hundred.clone();
    too_many.push(reprint(101, "box", &box_id(1), &sscc(1500)));
    let (status, body) = post(&admin, &asking, path, json!({ "records": too_many })).await;
    assert_eq!(
        (status, &body["error"]["details"]["field"]),
        (StatusCode::BAD_REQUEST, &json!("records"))
    );
    assert_eq!(
        reprint_rows(&admin).await.len(),
        100,
        "nothing of 101 is kept"
    );
    for body in [
        json!({ "records": {} }),
        json!({ "records": "x" }),
        json!({}),
        json!({ "records": [reprint(1, "box", &box_id(1), &sscc(1500))], "extra": 1 }),
        json!([]),
    ] {
        let (status, answer) = post(&admin, &asking, path, body.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}: {answer}");
    }
}

#[tokio::test]
async fn only_a_live_station_records_and_a_refused_batch_keeps_nothing() {
    let (admin, _floor, asking, _) = closed_shift_with_a_box().await;
    let record = reprint(1, "box", &box_id(1), &sscc(1500));
    let path = "/v1/device/warehouse/reprints";
    for kind in ["office", "handheld"] {
        // A handheld pairs by a code, not locally: pair an office device and
        // store its kind as the other.
        let (id, other) = pair_device(&admin.app, "office").await;
        sqlx::query("UPDATE devices SET kind = ? WHERE id = ?")
            .bind(kind)
            .bind(&id)
            .execute(&admin.app.state.pool)
            .await
            .unwrap();
        let (status, body) = post(&admin, &other, path, json!({ "records": [record] })).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{kind}: {body}");
        assert_eq!(body["error"]["code"], "forbidden", "{kind}");
        assert!(!body.to_string().contains(&sscc(1500)), "{body}");
    }
    let (status, _) = admin
        .app
        .send(json_request(
            request("POST", path),
            json!({ "records": [record] }),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = post(&admin, "not-a-key", path, json!({ "records": [record] })).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // A station revoked since pairing is no station.
    let (revoked, revoked_key) = pair_device(&admin.app, "station").await;
    sqlx::query("UPDATE devices SET revoked_at = '2026-10-08T07:00:00Z' WHERE id = ?")
        .bind(&revoked)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, _) = post(&admin, &revoked_key, path, json!({ "records": [record] })).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(reprint_rows(&admin).await.is_empty());
    // A live station is answered.
    assert_eq!(
        send_records(&admin, &asking, &[record]).await,
        vec![accepted(&record_id(1))]
    );
}

/// The bounds the host keeps beyond the Zod schema, which takes any text and
/// any non-negative number: what a station's real records never reach, and a
/// record that does is a bad record, not a stored one.
#[tokio::test]
async fn the_bounds_of_a_records_text_codes_and_counts() {
    let (admin, _floor, asking, _) = closed_shift_with_a_box().await;
    let good = reprint(1, "box", &box_id(1), &sscc(1500));
    let failed = |code: &str| {
        let mut record = good.clone();
        record["outcome"] = json!("failed");
        record["errorCode"] = json!(code);
        record
    };
    let with = |field: &str, value: Value| {
        let mut record = good.clone();
        record[field] = value;
        record
    };
    let long = "t".repeat(64);
    let accepted_ones = [
        with("attempt", json!(10_000)),
        with("templateId", json!(long.clone())),
        with("templateId", json!("a")),
        with("templateId", json!("Шаблон 1")),
        failed("timeout"),
        failed("printer_offline"),
        failed(&"e".repeat(64)),
        failed("_"),
    ];
    let refused = [
        with("attempt", json!(10_001)),
        with("attempt", json!(u32::MAX)),
        with("attempt", json!(u64::from(u32::MAX) + 1)),
        with("templateId", json!(format!("{long}t"))),
        with("templateId", json!("")),
        with("templateId", json!(" t")),
        with("templateId", json!("t ")),
        with("templateId", json!("t\nt")),
        with("templateId", json!("t\u{7}")),
        with("subjectId", json!(format!("{long}t"))),
        with("subjectId", json!(" ")),
        with("subjectId", json!("a\tb")),
        with("templateRev", json!(i64::MIN)),
        failed(""),
        failed("Timeout"),
        failed("time-out"),
        failed("time out"),
        failed("timeout2"),
        failed(&"e".repeat(65)),
        failed("тайм"),
        // The identity of a kind is its own: a hash is not a box's, an SSCC
        // is not a unit's, and a full code is nobody's.
        with("identity", json!(code_hash(1))),
        with("identity", json!(format!("{}0", sscc(1500)))),
        with("identity", json!(&sscc(1500)[1..])),
        with("identity", json!("04600682000001500x")),
        with("identity", json!("")),
        with("subjectKind", json!("unit")),
        with("operatorId", json!("8A3C1F0E-2B4D-4E6F-9A1B-3C5D7E9F1A2B")),
        with("operatorId", json!("8a3c1f0e2b4d4e6f9a1b3c5d7e9f1a2b")),
        with("id", json!("00000000-0000-4000-8000-00000000000G")),
        with("jobId", json!("not-a-uuid")),
    ];
    let mut records = Vec::new();
    for (n, record) in accepted_ones.iter().chain(&refused).enumerate() {
        let mut record = record.clone();
        // The record under test keeps its own id unless it is the field under
        // test; every record is a distinct one.
        if record["id"] == good["id"] {
            record["id"] = json!(record_id(300 + u32::try_from(n).unwrap()));
        }
        records.push(record);
    }
    let answered = send_records(&admin, &asking, &records).await;
    for (n, receipt) in answered.iter().enumerate() {
        if n < accepted_ones.len() {
            assert_eq!(
                receipt["outcome"], "accepted",
                "#{n}: {receipt} of {}",
                records[n]
            );
        } else {
            assert_eq!(
                receipt["code"], "invalid_record",
                "#{n}: {receipt} of {}",
                records[n]
            );
        }
    }
    // A unit with a hash identity is a record too.
    let (_, unit) = lookup(&admin, &asking, json!({ "codeHash": code_hash(1) })).await;
    let scan = unit["source"]["subjectId"].as_str().unwrap().to_owned();
    let mut unit_record = reprint(400, "unit", &scan, &code_hash(1));
    let mut with_sscc = unit_record.clone();
    with_sscc["id"] = json!(record_id(401));
    with_sscc["identity"] = json!(sscc(1500));
    let mut upper = unit_record.clone();
    upper["id"] = json!(record_id(402));
    upper["identity"] = json!("A".repeat(64));
    let mut short = unit_record.clone();
    short["id"] = json!(record_id(403));
    short["identity"] = json!(&code_hash(1)[1..]);
    unit_record["outcome"] = json!("unknown");
    unit_record["errorCode"] = json!("timeout");
    let answered = send_records(&admin, &asking, &[unit_record, with_sscc, upper, short]).await;
    assert_eq!(answered[0], accepted(&record_id(400)));
    for receipt in &answered[1..] {
        assert_eq!(receipt["code"], "invalid_record", "{receipt}");
    }
}

#[tokio::test]
async fn every_reason_and_outcome_the_station_records_is_kept() {
    let (admin, _floor, asking, _) = closed_shift_with_a_box().await;
    let mut records = Vec::new();
    for (n, reason) in ["not_printed", "damaged", "lost"].iter().enumerate() {
        let mut record = reprint(
            1 + u32::try_from(n).unwrap(),
            "box",
            &box_id(1),
            &sscc(1500),
        );
        record["reasonCode"] = json!(reason);
        records.push(record);
    }
    for (n, outcome) in ["sent", "unknown", "failed", "verified", "cancelled"]
        .iter()
        .enumerate()
    {
        let mut record = reprint(
            10 + u32::try_from(n).unwrap(),
            "box",
            &box_id(1),
            &sscc(1500),
        );
        record["outcome"] = json!(outcome);
        if *outcome == "unknown" || *outcome == "failed" {
            record["errorCode"] = json!("timeout");
        }
        records.push(record);
    }
    let answered = send_records(&admin, &asking, &records).await;
    assert!(
        answered
            .iter()
            .all(|receipt| receipt["outcome"] == "accepted"),
        "{answered:?}"
    );
    assert_eq!(reprint_rows(&admin).await.len(), 8);
}

#[tokio::test]
async fn a_refusal_names_the_record_only_when_its_id_is_a_uuid() {
    let (admin, _floor, asking, _) = closed_shift_with_a_box().await;
    let mut bad_id = reprint(1, "box", &box_id(1), &sscc(1500));
    bad_id["id"] = json!("not-a-uuid");
    let mut upper_id = reprint(2, "box", &box_id(1), &sscc(1500));
    upper_id["id"] = json!("B0000000-0000-4000-8000-000000000002");
    upper_id["identity"] = json!("short");
    let mut broken = reprint(3, "box", &box_id(1), &sscc(1500));
    broken["identity"] = json!("short");
    let answered = send_records(&admin, &asking, &[bad_id, upper_id, broken]).await;
    assert_eq!(
        answered,
        vec![
            json!({ "id": null, "outcome": "rejected", "code": "invalid_record" }),
            json!({ "id": null, "outcome": "rejected", "code": "invalid_record" }),
            json!({ "id": record_id(3), "outcome": "rejected", "code": "invalid_record" }),
        ]
    );
}

/// The cases of `test/warehouse-protocol.test.ts` («refuses a record with
/// %s»): each is refused by the Zod schema there and by the host here. A
/// `None` is a key the record does not have (Zod's `undefined`). The names
/// are looked up in that file, so the two lists cannot drift apart.
fn refused_by_zod_and_host() -> Vec<(&'static str, &'static str, Option<Value>)> {
    vec![
        ("a record id that is no uuid", "id", Some(json!("x"))),
        (
            "a session id that is no uuid",
            "sessionId",
            Some(json!("x")),
        ),
        ("a job id that is no uuid", "jobId", Some(json!("x"))),
        ("a negative attempt", "attempt", Some(json!(-1))),
        ("a fractional attempt", "attempt", Some(json!(0.5))),
        (
            "a subject kind the host does not print",
            "subjectKind",
            Some(json!("pack")),
        ),
        ("an empty subject id", "subjectId", Some(json!(""))),
        ("an empty identity", "identity", Some(json!(""))),
        (
            "a repair the station does not make",
            "repair",
            Some(json!("other")),
        ),
        ("a repair that is missing", "repair", None),
        ("an empty template id", "templateId", Some(json!(""))),
        (
            "a negative template revision",
            "templateRev",
            Some(json!(-1)),
        ),
        (
            "a fractional template revision",
            "templateRev",
            Some(json!(1.5)),
        ),
        (
            "an outcome the station does not record",
            "outcome",
            Some(json!("queued")),
        ),
        ("an error code that is missing", "errorCode", None),
        (
            "an operator id that is no uuid",
            "operatorId",
            Some(json!("x")),
        ),
        ("an operator id that is missing", "operatorId", None),
        ("an instant that is missing", "occurredAt", None),
    ]
}

#[tokio::test]
async fn the_host_refuses_what_the_zod_schema_refuses_of_the_shared_fixture() {
    let (admin, _floor, asking, _) = closed_shift_with_a_box().await;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let fixture: Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("../proto/fixtures/warehouse-records-request.json"))
            .unwrap(),
    )
    .unwrap();
    let zod = std::fs::read_to_string(root.join("../test/warehouse-protocol.test.ts")).unwrap();
    let records = fixture["records"].as_array().unwrap();
    // The fixture as it stands is readable: the host asks whether it has the
    // subjects. Its box is this host's box 1 (the fixture was cut from the
    // same shapes), its unit is not here.
    let fixture_receipts = send_records(&admin, &asking, records).await;
    assert_eq!(
        fixture_receipts[0],
        accepted(records[0]["id"].as_str().unwrap())
    );
    assert_eq!(fixture_receipts[1]["code"], "subject_unknown");
    for (name, field, value) in refused_by_zod_and_host() {
        assert!(
            zod.contains(&format!("[\"{name}\"")),
            "the Zod test has no case {name:?}"
        );
        let broken: Vec<Value> = records
            .iter()
            .enumerate()
            .map(|(n, record)| {
                let mut record = record.clone();
                record["id"] = json!(record_id(500 + u32::try_from(n).unwrap()));
                match &value {
                    None => {
                        record.as_object_mut().unwrap().remove(field);
                    }
                    Some(value) => record[field] = value.clone(),
                }
                record
            })
            .collect();
        for receipt in send_records(&admin, &asking, &broken).await {
            assert_eq!(receipt["code"], "invalid_record", "{name}: {receipt}");
        }
    }
    assert_eq!(
        reprint_rows(&admin).await.len(),
        1,
        "only the fixture's own box"
    );
    // The edges Zod accepts are not refused as invalid by the host: attempt
    // 0 and revision 0 on the fixture's own records.
    let mut edge = records[0].clone();
    edge["id"] = json!(record_id(600));
    edge["attempt"] = json!(0);
    edge["templateRev"] = json!(0);
    assert_eq!(
        send_records(&admin, &asking, &[edge]).await,
        vec![accepted(&record_id(600))]
    );
}

#[tokio::test]
async fn the_table_refuses_the_rows_no_record_may_leave() {
    let (admin, _floor, _asking, _) = closed_shift_with_a_box().await;
    let (station, _) = pair_device(&admin.app, "station").await;
    // A valid row with `overrides` set (a JSON null is SQL NULL).
    let insert = |overrides: Vec<(&'static str, Value)>| {
        let (station, admin) = (station.clone(), &admin);
        async move {
            let mut row = json!({
                "device_id": station, "record_id": record_id(900),
                "digest": "d".repeat(64), "session_id": SESSION, "job_id": JOB,
                "attempt": 1, "subject_kind": "box", "subject_id": box_id(1),
                "identity": sscc(1500), "reason_code": "damaged", "repair": null,
                "template_id": "t", "template_rev": 1, "outcome": "sent",
                "error_code": null, "operator_id": null,
                "occurred_at": instant(20, 0), "received_at": "2026-10-08T06:01:00Z"
            });
            for (column, value) in overrides {
                row[column] = value;
            }
            let names: Vec<String> = row.as_object().unwrap().keys().cloned().collect();
            let sql = format!(
                "INSERT INTO warehouse_reprints ({}) VALUES ({})",
                names.join(", "),
                vec!["?"; names.len()].join(", ")
            );
            let mut query = sqlx::query(&sql);
            for name in &names {
                query = match &row[name.as_str()] {
                    Value::Null => query.bind(None::<String>),
                    Value::String(text) => query.bind(text.clone()),
                    other => query.bind(other.as_i64().unwrap()),
                };
            }
            let result = query.execute(&admin.app.state.pool).await;
            sqlx::query("DELETE FROM warehouse_reprints")
                .execute(&admin.app.state.pool)
                .await
                .unwrap();
            result
        }
    };
    let legacy = || ("repair", json!("legacy_tspl_fnc1_literal"));
    // What the table allows.
    for allowed in [
        vec![],
        vec![legacy()],
        vec![legacy(), ("subject_kind", json!("pallet"))],
        vec![("attempt", json!(0)), ("template_rev", json!(0))],
        vec![
            ("outcome", json!("failed")),
            ("error_code", json!("timeout")),
        ],
        vec![
            ("outcome", json!("unknown")),
            ("error_code", json!("timeout")),
        ],
        vec![("outcome", json!("verified"))],
        vec![("outcome", json!("cancelled"))],
        vec![("subject_kind", json!("unit"))],
        vec![("reason_code", json!("not_printed"))],
        vec![("reason_code", json!("lost"))],
    ] {
        let shown = format!("{allowed:?}");
        let result = insert(allowed).await;
        assert!(result.is_ok(), "{shown}: {result:?}");
    }
    // What it holds against.
    for refused in [
        vec![("digest", json!("short"))],
        vec![("attempt", json!(-1))],
        vec![("subject_kind", json!("crate"))],
        vec![("reason_code", json!("other"))],
        vec![("repair", json!("trim"))],
        vec![legacy(), ("subject_kind", json!("unit"))],
        vec![("template_rev", json!(-1))],
        vec![("outcome", json!("printed"))],
        vec![("outcome", json!("failed"))],
        vec![("outcome", json!("unknown"))],
        vec![("error_code", json!("timeout"))],
        vec![
            ("outcome", json!("verified")),
            ("error_code", json!("timeout")),
        ],
        vec![("device_id", json!("no-such-device"))],
        vec![("record_id", Value::Null)],
        vec![("identity", Value::Null)],
        vec![("received_at", Value::Null)],
    ] {
        let shown = format!("{refused:?}");
        let error = insert(refused).await.unwrap_err().to_string();
        assert!(
            error.contains("CHECK") || error.contains("FOREIGN KEY") || error.contains("NOT NULL"),
            "{shown}: {error}"
        );
    }
    // One record id once per device: the key.
    let mut tx = admin.app.state.pool.begin().await.unwrap();
    let insert_one = "INSERT INTO warehouse_reprints (device_id, record_id, digest, session_id, \
         job_id, attempt, subject_kind, subject_id, identity, reason_code, template_id, \
         template_rev, outcome, occurred_at, received_at) VALUES (?, ?, ?, ?, ?, 1, 'box', ?, ?, \
         'damaged', 't', 1, 'sent', ?, ?)";
    for round in 0..2 {
        let result = sqlx::query(insert_one)
            .bind(&station)
            .bind(record_id(901))
            .bind("d".repeat(64))
            .bind(SESSION)
            .bind(JOB)
            .bind(box_id(1))
            .bind(sscc(1500))
            .bind(instant(20, 0))
            .bind("2026-10-08T06:01:00Z")
            .execute(&mut *tx)
            .await;
        match round {
            0 => assert!(result.is_ok(), "{result:?}"),
            _ => assert!(
                result.unwrap_err().to_string().contains("UNIQUE"),
                "the same device and record id twice"
            ),
        }
    }
    tx.rollback().await.unwrap();
}

#[tokio::test]
async fn every_query_of_a_record_searches_by_an_index() {
    let admin = admin().await;
    use markiro_host::routes::warehouse::{
        BOX_EXISTS_SQL, PALLET_EXISTS_SQL, STORED_SQL, UNIT_EXISTS_SQL,
    };
    for (sql, index) in [
        (
            STORED_SQL,
            "warehouse_reprints USING INDEX sqlite_autoindex_warehouse_reprints_1 (device_id=? AND record_id=?)",
        ),
        (
            UNIT_EXISTS_SQL,
            "scans USING INDEX sqlite_autoindex_scans_1 (id=?)",
        ),
        (
            BOX_EXISTS_SQL,
            "boxes USING INDEX sqlite_autoindex_boxes_1 (id=?)",
        ),
        (
            PALLET_EXISTS_SQL,
            "pallets USING INDEX sqlite_autoindex_pallets_1 (id=?)",
        ),
    ] {
        let steps: Vec<String> = sqlx::query_as::<_, (i64, i64, i64, String)>(&format!(
            "EXPLAIN QUERY PLAN {sql}"
        ))
        .bind("a")
        .bind("b")
        .fetch_all(&admin.app.state.pool)
            .await
            .unwrap()
            .into_iter()
            .map(|(_, _, _, step)| step)
            .collect();
        assert!(
            steps.iter().all(|step| !step.starts_with("SCAN")),
            "{sql}: {steps:?}"
        );
        assert!(
            steps.iter().any(|step| step.contains(index)),
            "{sql}: no {index} in {steps:?}"
        );
    }
}

/// The office's history of one label reads by what was printed.
#[tokio::test]
async fn the_history_of_one_label_is_read_by_its_identity_through_an_index() {
    let admin = admin().await;
    let steps: Vec<String> = sqlx::query_as::<_, (i64, i64, i64, String)>(
        "EXPLAIN QUERY PLAN SELECT record_id FROM warehouse_reprints WHERE identity = ?",
    )
    .bind("x")
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap()
    .into_iter()
    .map(|(_, _, _, step)| step)
    .collect();
    assert!(
        steps
            .iter()
            .any(|step| step.contains("USING INDEX warehouse_reprints_identity (identity=?)")),
        "{steps:?}"
    );
}

/// The records are written in ONE write transaction taken up front
/// (`BEGIN IMMEDIATE`), after the device is checked inside it, and committed
/// once: a database error in the middle of a batch leaves none of it.
#[test]
fn the_records_are_written_in_one_immediate_transaction_after_the_station_is_checked() {
    let whole = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/routes/warehouse.rs"),
    )
    .unwrap();
    let (_, source) = whole
        .split_once("/// The body as the host reads it")
        .unwrap();
    assert_eq!(source.matches("begin_write(&state.pool)").count(), 1);
    assert_eq!(source.matches("state.pool").count(), 1);
    assert_eq!(source.matches("tx.commit()").count(), 1);
    assert_eq!(source.matches("tx.rollback()").count(), 0);
    let begun = source.find("begin_write(").unwrap();
    let checked = source.find("require_station_in(&mut tx").unwrap();
    let first_record = source.find("receive(&mut tx").unwrap();
    let committed = source.find("tx.commit()").unwrap();
    assert!(begun < checked && checked < first_record && first_record < committed);
}

/// `0015` is numbered above `0013` and `0014` (other plans, other
/// streams): a host that has not got them takes `0015` all the same, and
/// takes them late when they come, as `0011` came after `0012`.
#[tokio::test]
async fn a_database_without_0013_and_0014_takes_0015_and_the_others_late() {
    use sqlx::migrate::Migrator;
    use sqlx::{Connection, SqliteConnection};

    let lacking = Migrator {
        migrations: markiro_host::db::MIGRATOR
            .iter()
            .filter(|migration| migration.version != 13 && migration.version != 14)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..Migrator::DEFAULT
    };
    let mut old = SqliteConnection::connect("sqlite::memory:").await.unwrap();
    lacking.run(&mut old).await.unwrap();
    let versions: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&mut old)
            .await
            .unwrap();
    assert!(
        versions.contains(&15) && !versions.contains(&13) && !versions.contains(&14),
        "{versions:?}"
    );
    sqlx::query("UPDATE site SET initialized_at = '2026-10-09T15:00:00Z' WHERE id = 1")
        .execute(&mut old)
        .await
        .unwrap();
    markiro_host::db::MIGRATOR.run(&mut old).await.unwrap();
    let applied: Vec<(i64, bool)> =
        sqlx::query_as("SELECT version, success FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&mut old)
            .await
            .unwrap();
    assert!(applied.contains(&(15, true)), "{applied:?}");
    assert_eq!(applied.len(), markiro_host::db::MIGRATOR.iter().count());
    assert!(applied.iter().all(|(_, success)| *success));
    let kept: (Option<String>,) = sqlx::query_as("SELECT initialized_at FROM site WHERE id = 1")
        .fetch_one(&mut old)
        .await
        .unwrap();
    assert_eq!(kept.0.as_deref(), Some("2026-10-09T15:00:00Z"));
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM warehouse_reprints")
        .fetch_one(&mut old)
        .await
        .unwrap();
    assert_eq!(rows, 0);
}

/// Plan ТОВ: the lookup answers the EGAIS code the record's shift froze, so a
/// warehouse reprint prints what the first label printed even after the
/// office changed the product's code.
#[tokio::test]
async fn a_lookup_answers_the_egais_code_the_shift_froze() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    // The product becomes beer (ЧЗ group 15) with a code before the shift.
    sqlx::query("UPDATE products SET chz_group_code = 15, egais_code = '0150320000001234567'")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
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
                "boxTemplateId": setup.template, "productionDate": "2026-10-09"
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
    sqlx::query("UPDATE products SET egais_code = '0150320000007654321'")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    for body in [
        json!({ "codeHash": code_hash(1) }),
        json!({ "sscc": sscc(1500) }),
    ] {
        let (status, answer) = lookup(&admin, &key, body.clone()).await;
        assert_eq!(status, StatusCode::OK, "{body}: {answer}");
        assert_eq!(
            answer["source"]["product"]["egaisCode"], "0150320000001234567",
            "{body}"
        );
    }
}
