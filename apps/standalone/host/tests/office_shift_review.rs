mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    add_operator, admin, box_closed, box_exception, box_id, code_hash, empty, fact, instant,
    issue_block, issue_pallet_block, ok_scan, open_floor, open_pallet_floor, pallet_closed,
    pallet_id, pallet_sscc, receipts, record_id, request, shift_setup, sscc, with_device,
};

const BLOCK: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const PALLETS: &str = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";

/// A shift with pallets: box 1 (codes 1, 2) closed on pallet 1; box 3 open
/// with codes 3 and 4, then the last scan undone by the operator; pallet 1
/// closed, then taken apart («другая причина: Паллета упала»). The
/// exceptions come newest first with what they were made on.
#[tokio::test]
async fn a_shifts_exceptions_name_their_box_or_pallet_reason_station_and_operator() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    sqlx::query("UPDATE devices SET name = 'Станция А' WHERE id = ?")
        .bind(&floor.station)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (operator, _) = add_operator(&admin, "1001").await;
    let block = issue_block(&admin.app, &floor.key, BLOCK).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLETS).await;
    let shift = floor.shift.clone();
    let mut closed = box_closed(
        &box_id(1),
        &block,
        1500,
        &[1, 2],
        &instant(10, 0),
        &instant(20, 0),
    );
    closed["palletId"] = json!(pallet_id(1));
    let mut undo = box_exception("undo", &box_id(3), &instant(55, 0));
    undo["codeHash"] = json!(code_hash(4));
    undo["targetScannedAt"] = json!(instant(50, 0));
    let mut undo_record = fact(&record_id(6), "box_exception", &shift, undo);
    undo_record["operatorId"] = json!(operator);
    let mut pallet_apart = fact(
        &record_id(8),
        "pallet_exception",
        &shift,
        json!({ "exception": "disassemble", "palletId": pallet_id(1), "reasonCode": "other",
                "reasonText": "Паллета упала", "occurredAt": instant(70, 0) }),
    );
    pallet_apart["operatorId"] = json!(operator);
    // Box 1's label printed again, by no operator.
    let mut reprint = box_exception("reprint", &box_id(1), &instant(30, 0));
    reprint["reasonCode"] = json!("damaged_label");
    let answered = receipts(
        &admin.app,
        &floor.key,
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
            fact(&record_id(3), "box_closed", &shift, closed),
            fact(
                &record_id(4),
                "scan",
                &shift,
                ok_scan(3, &box_id(3), &instant(40, 0)),
            ),
            fact(
                &record_id(5),
                "scan",
                &shift,
                ok_scan(4, &box_id(3), &instant(50, 0)),
            ),
            fact(&record_id(9), "box_exception", &shift, reprint),
            undo_record,
            fact(
                &record_id(7),
                "pallet_closed",
                &shift,
                pallet_closed(
                    &pallet_id(1),
                    &pallets,
                    40,
                    1,
                    &instant(10, 0),
                    &instant(60, 0),
                ),
            ),
            pallet_apart,
        ],
    )
    .await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
    let received = admin.app.state.timestamp();
    let (status, body) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{shift}/exceptions"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let items = body["items"].as_array().unwrap();
    assert_eq!(body["total"], 3);
    // Each row is its exception's own: the pallet's first, then the box's.
    let pallet_exception: String = sqlx::query_scalar("SELECT id FROM pallet_exceptions")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let box_exception_id = |kind: &'static str| {
        let pool = admin.app.state.pool.clone();
        async move {
            sqlx::query_scalar::<_, String>("SELECT id FROM box_exceptions WHERE kind = ?")
                .bind(kind)
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };
    assert_eq!(
        items
            .iter()
            .map(|item| item["id"].clone())
            .collect::<Vec<_>>(),
        vec![
            json!(pallet_exception),
            json!(box_exception_id("undo").await),
            json!(box_exception_id("reprint").await)
        ]
    );
    let strip_id = |item: &Value| {
        let mut item = item.clone();
        item.as_object_mut().unwrap().remove("id");
        item
    };
    assert_eq!(
        items.iter().map(strip_id).collect::<Vec<_>>(),
        vec![
            json!({
                "subject": "pallet", "kind": "disassemble", "subjectId": pallet_id(1),
                "sscc": pallet_sscc(40), "serial": null, "reasonCode": "other",
                "reasonText": "Паллета упала", "deviceId": floor.station, "deviceName": "Станция А",
                "operatorName": "Анна Кузнецова", "occurredAt": instant(70, 0), "receivedAt": received
            }),
            json!({
                "subject": "box", "kind": "undo", "subjectId": box_id(3), "sscc": null,
                "serial": "S000004", "reasonCode": null, "reasonText": null,
                "deviceId": floor.station, "deviceName": "Станция А",
                "operatorName": "Анна Кузнецова", "occurredAt": instant(55, 0), "receivedAt": received
            }),
            json!({
                "subject": "box", "kind": "reprint", "subjectId": box_id(1), "sscc": sscc(1500),
                "serial": null, "reasonCode": "damaged_label", "reasonText": null,
                "deviceId": floor.station, "deviceName": "Станция А",
                "operatorName": null, "occurredAt": instant(30, 0), "receivedAt": received
            }),
        ]
    );
    // Another shift's exception is that shift's only.
    let other = open_floor(&admin, &setup, &floor.key, &setup.line).await;
    let answered = receipts(
        &admin.app,
        &floor.key,
        &[
            fact(
                &record_id(31),
                "scan",
                &other.shift,
                ok_scan(9, &box_id(9), &instant(80, 0)),
            ),
            fact(
                &record_id(32),
                "box_exception",
                &other.shift,
                box_exception("clear", &box_id(9), &instant(81, 0)),
            ),
        ],
    )
    .await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
    let (_, again) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{shift}/exceptions"),
            None,
        )
        .await;
    assert_eq!(again, body);
    let (_, of_other) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{}/exceptions", other.shift),
            None,
        )
        .await;
    assert_eq!(of_other["total"], 1);
    assert_eq!(of_other["items"][0]["kind"], "clear");
}

/// A shift lists its newest 500 exceptions and counts them all.
#[tokio::test]
async fn a_shifts_exceptions_stop_at_five_hundred_and_count_all() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let answered = receipts(
        &admin.app,
        &floor.key,
        &[fact(
            &record_id(1),
            "scan",
            &floor.shift,
            ok_scan(1, &box_id(1), &instant(10, 0)),
        )],
    )
    .await;
    assert_eq!(answered[0]["outcome"], "accepted");
    for n in 0..501 {
        sqlx::query(
            "INSERT INTO box_exceptions (id, record_id, kind, box_id, shift_id, device_id, \
             occurred_at, received_at) VALUES (?, ?, 'clear', ?, ?, ?, ?, ?)",
        )
        .bind(format!("e0000000-0000-4000-8000-{n:012}"))
        .bind(format!("10000000-0000-4000-8000-{n:012}"))
        .bind(box_id(1))
        .bind(&floor.shift)
        .bind(&floor.station)
        .bind(instant(100 + n, 0))
        .bind(admin.app.state.timestamp())
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    }
    let (status, body) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{}/exceptions", floor.shift),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let items = body["items"].as_array().unwrap();
    assert_eq!((items.len(), body["total"].clone()), (500, json!(501)));
    // Newest first: the oldest one is left out.
    assert_eq!(items[0]["occurredAt"], instant(600, 0));
    assert_eq!(items[499]["occurredAt"], instant(101, 0));
}

/// A device key alone, or a session that is no session, reads no shift's
/// review: both routes are the office's.
#[tokio::test]
async fn a_shifts_review_needs_an_office_session() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (tech, _) = admin.technologist_session().await;
    for tail in ["exceptions", "rejections"] {
        let path = format!("/v1/office/shifts/{}/{tail}", floor.shift);
        let (status, body) = admin
            .app
            .send(empty(with_device(request("GET", &path), &floor.key)))
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{tail}: {body}");
        let (status, body) = admin.call_as("not-a-session", "GET", &path, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{tail}: {body}");
        let (status, _) = admin.call("GET", &path, None).await;
        assert_eq!(status, StatusCode::OK, "{tail}");
        let (status, _) = admin.call_as(&tech, "GET", &path, None).await;
        assert_eq!(status, StatusCode::OK, "{tail}");
    }
}

/// The shift's refused records newest first: an unreadable field of a scan
/// and a box the host does not know; a refusal of another shift and one that
/// names a shift the host does not know are not this shift's.
#[tokio::test]
async fn a_shifts_refusals_are_its_rejected_receipts_newest_first() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let other = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let first = admin.app.state.timestamp();
    let mut broken = ok_scan(1, &box_id(1), &instant(10, 0));
    broken["boxId"] = json!("not-a-uuid");
    receipts(
        &admin.app,
        &floor.key,
        &[fact(&record_id(21), "scan", &floor.shift, broken)],
    )
    .await;
    admin.app.clock.advance(time::Duration::minutes(1));
    let second = admin.app.state.timestamp();
    let block = issue_block(&admin.app, &floor.key, BLOCK).await;
    receipts(
        &admin.app,
        &floor.key,
        &[
            fact(
                &record_id(22),
                "box_closed",
                &floor.shift,
                box_closed(
                    &box_id(9),
                    &block,
                    1500,
                    &[1],
                    &instant(10, 0),
                    &instant(20, 0),
                ),
            ),
            fact(
                &record_id(23),
                "scan",
                &other.shift,
                json!({ "verdict": "nonsense" }),
            ),
            fact(
                &record_id(24),
                "scan",
                "5a0c9e1e-3d4f-4b8a-9c2d-1e0f9a8b7c6d",
                ok_scan(2, &box_id(2), &instant(12, 0)),
            ),
            fact(
                &record_id(25),
                "scan",
                &floor.shift,
                ok_scan(3, &box_id(3), &instant(13, 0)),
            ),
        ],
    )
    .await;
    let (status, body) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{}/rejections", floor.shift),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let device: String = sqlx::query_scalar("SELECT name FROM devices WHERE id = ?")
        .bind(&floor.station)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(
        body,
        json!({
            "items": [
                { "recordId": record_id(22), "kind": "box_closed", "code": "box_unknown",
                  "details": null, "deviceId": floor.station, "deviceName": device,
                  "receivedAt": second },
                { "recordId": record_id(21), "kind": "scan", "code": "invalid_record",
                  "details": { "field": "data.boxId" }, "deviceId": floor.station,
                  "deviceName": device, "receivedAt": first }
            ],
            "total": 2
        })
    );
}

#[tokio::test]
async fn an_unknown_shift_is_not_found_and_the_refusals_read_their_own_index() {
    let admin = admin().await;
    for tail in ["exceptions", "rejections"] {
        let (status, body) = admin
            .call(
                "GET",
                &format!("/v1/office/shifts/5a0c9e1e-3d4f-4b8a-9c2d-1e0f9a8b7c6d/{tail}"),
                None,
            )
            .await;
        assert_eq!(
            (status, body["error"]["code"].clone()),
            (StatusCode::NOT_FOUND, json!("not_found"))
        );
    }
    let plan: Vec<(i64, i64, i64, String)> = sqlx::query_as(&format!(
        "EXPLAIN QUERY PLAN {}",
        markiro_host::routes::office_shift_review::REJECTIONS_SQL
    ))
    .bind("shift-1")
    .bind(500_i64)
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    let text = plan
        .iter()
        .map(|row| row.3.clone())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("fact_receipts_rejected"), "{text}");
    for sql in [
        markiro_host::routes::office_shift_review::EXCEPTIONS_SQL,
        markiro_host::routes::office_shift_review::EXCEPTIONS_COUNT_SQL,
    ] {
        let plan: Vec<(i64, i64, i64, String)> =
            sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
                .bind("shift-1")
                .bind(500_i64)
                .fetch_all(&admin.app.state.pool)
                .await
                .unwrap();
        let text = plan
            .iter()
            .map(|row| row.3.clone())
            .collect::<Vec<_>>()
            .join("\n");
        for index in ["box_exceptions_shift", "pallet_exceptions_shift"] {
            assert!(text.contains(index), "{sql}: {text}");
        }
        // An undo's serial is looked up by its code's hash.
        if sql.contains("serial FROM scans") {
            assert!(text.contains("scans_code_hash"), "{text}");
        }
        assert!(!text.contains("SCAN e"), "{text}");
    }
}
