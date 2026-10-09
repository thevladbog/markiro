mod support;

use axum::body::Body;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use http_body_util::BodyExt;
use markiro_host::auth::AuthDevice;
use markiro_host::db::begin_write;
use markiro_host::error::ApiJson;
use markiro_host::facts::rules::record_digest;
use markiro_host::routes::facts::{receive_facts, IncomingFacts};
use markiro_proto::DeviceKind;
use serde_json::{json, Value};
use support::app::{
    accepted, admin, audit_rows, box_closed, box_id, code, code_hash, fact, fact_rows,
    host_revision, instant, issue_block, members_digest, ok_scan, open_floor, pair_device,
    plan_shift, receipts, record_id, rejected, request, send_facts, shift_body, shift_setup, sscc,
    sscc_under, with_device, Admin, Floor,
};

/// A scan of `verdict` at `at`, with no box; `code` and `source` as given.
fn other_scan(verdict: &str, raw_kind: &str, code: Value, source: Value, at: &str) -> Value {
    json!({
        "scannedAt": at, "verdict": verdict, "duplicateSource": source, "rawKind": raw_kind,
        "rawLength": 14, "code": code, "boxId": null
    })
}

/// The journal as the host keeps it, oldest scan first.
async fn scan_rows(admin: &Admin) -> Vec<Value> {
    type ScanRow = (
        String,
        String,
        String,
        String,
        Option<String>,
        String,
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        String,
    );
    let rows: Vec<ScanRow> = sqlx::query_as(
        "SELECT record_id, device_id, shift_id, verdict, duplicate_source, raw_kind, raw_length, \
         code_hash, gtin14, serial, canonical, box_id, operator_id, scanned_at, received_at \
         FROM scans ORDER BY scanned_at, record_id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|row| {
            json!([
                row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8, row.9, row.10,
                row.11, row.12, row.13, row.14
            ])
        })
        .collect()
}

/// The registry: `(code hash, owner's record, shift, device, box, scanned at)`.
async fn owners(admin: &Admin) -> Vec<Value> {
    let rows: Vec<(String, String, String, String, String, String)> = sqlx::query_as(
        "SELECT o.code_hash, s.record_id, o.shift_id, o.device_id, o.box_id, o.scanned_at \
         FROM code_owners o JOIN scans s ON s.id = o.scan_id ORDER BY o.code_hash",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|row| json!([row.0, row.1, row.2, row.3, row.4, row.5]))
        .collect()
}

/// A box's items: `(record of the scan, code hash, added, removed, displaced)`.
async fn items(admin: &Admin, box_id: &str) -> Vec<Value> {
    let rows: Vec<(String, String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT s.record_id, i.code_hash, i.added_at, i.removed_at, i.displaced_at \
         FROM box_items i JOIN scans s ON s.id = i.scan_id WHERE i.box_id = ? \
         ORDER BY i.added_at, s.record_id",
    )
    .bind(box_id)
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|row| json!([row.0, row.1, row.2, row.3, row.4]))
        .collect()
}

/// The conflicts: `(code hash, winner's record, loser's record, detected)`.
async fn conflicts(admin: &Admin) -> Vec<Value> {
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT c.code_hash, w.record_id, l.record_id, c.detected_at FROM code_conflicts c \
         JOIN scans w ON w.id = c.winner_scan_id JOIN scans l ON l.id = c.loser_scan_id \
         ORDER BY w.record_id, l.record_id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|row| json!([row.0, row.1, row.2, row.3]))
        .collect()
}

/// The kept receipts: `(device, record, kind, shift, outcome, code, details)`.
async fn kept_receipts(admin: &Admin) -> Vec<Value> {
    type ReceiptRow = (
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
    );
    let rows: Vec<ReceiptRow> = sqlx::query_as(
        "SELECT device_id, record_id, kind, shift_id, outcome, code, details FROM fact_receipts \
         ORDER BY record_id, device_id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|row| {
            json!([
                row.0,
                row.1,
                row.2,
                row.3,
                row.4,
                row.5,
                row.6
                    .map(|details| serde_json::from_str::<Value>(&details).unwrap())
            ])
        })
        .collect()
}

/// An administrator's host with the station on the first line inside an
/// open shift.
async fn floor() -> (Admin, Floor) {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    (admin, floor)
}

#[tokio::test]
async fn a_batch_is_answered_record_by_record_and_kept_once() {
    let (admin, floor) = floor().await;
    let mut wrong = code(3);
    wrong["gtin14"] = json!("04600682000099");
    let mut first = fact(
        &record_id(1),
        "scan",
        &floor.shift,
        ok_scan(1, &box_id(1), &instant(1, 0)),
    );
    first["operatorId"] = json!("c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d");
    let batch = vec![
        first,
        fact(
            &record_id(2),
            "scan",
            &floor.shift,
            ok_scan(2, &box_id(1), &instant(2, 0)),
        ),
        fact(
            &record_id(3),
            "scan",
            &floor.shift,
            other_scan("duplicate", "km", code(1), json!("local"), &instant(3, 0)),
        ),
        fact(
            &record_id(4),
            "scan",
            &floor.shift,
            other_scan("wrong_gtin", "km", wrong, Value::Null, &instant(4, 0)),
        ),
        fact(
            &record_id(5),
            "scan",
            &floor.shift,
            other_scan("invalid", "gtin", Value::Null, Value::Null, &instant(5, 0)),
        ),
    ];
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let mut wake = admin.app.state.revisions.subscribe();
    wake.borrow_and_update();
    let answered = receipts(&admin.app, &floor.key, &batch).await;
    let expected: Vec<Value> = (1..=5).map(|n| accepted(&record_id(n))).collect();
    assert_eq!(answered, expected);
    let at = admin.app.state.timestamp();
    let (s, d) = (&floor.shift, &floor.station);
    assert_eq!(
        scan_rows(&admin).await,
        vec![
            json!([
                record_id(1),
                d,
                s,
                "ok",
                null,
                "km",
                38,
                code_hash(1),
                "04600682000013",
                "S000001",
                "010460068200001321S000001\u{1d}93Tail1",
                box_id(1),
                "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d",
                instant(1, 0),
                at
            ]),
            json!([
                record_id(2),
                d,
                s,
                "ok",
                null,
                "km",
                38,
                code_hash(2),
                "04600682000013",
                "S000002",
                "010460068200001321S000002\u{1d}93Tail2",
                box_id(1),
                null,
                instant(2, 0),
                at
            ]),
            json!([
                record_id(3),
                d,
                s,
                "duplicate",
                "local",
                "km",
                14,
                code_hash(1),
                "04600682000013",
                "S000001",
                "010460068200001321S000001\u{1d}93Tail1",
                null,
                null,
                instant(3, 0),
                at
            ]),
            json!([
                record_id(4),
                d,
                s,
                "wrong_gtin",
                null,
                "km",
                14,
                code_hash(3),
                "04600682000099",
                "S000003",
                "010460068200001321S000003\u{1d}93Tail3",
                null,
                null,
                instant(4, 0),
                at
            ]),
            json!([
                record_id(5),
                d,
                s,
                "invalid",
                null,
                "gtin",
                14,
                null,
                null,
                null,
                null,
                null,
                null,
                instant(5, 0),
                at
            ]),
        ]
    );
    // The first accepted scan opened the box; both own their codes.
    let opened: (String, String, String, Option<String>) =
        sqlx::query_as("SELECT shift_id, device_id, opened_at, closed_at FROM boxes WHERE id = ?")
            .bind(box_id(1))
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(opened, (s.clone(), d.clone(), instant(1, 0), None));
    assert_eq!(
        owners(&admin).await,
        vec![
            json!([code_hash(1), record_id(1), s, d, box_id(1), instant(1, 0)]),
            json!([code_hash(2), record_id(2), s, d, box_id(1), instant(2, 0)]),
        ]
    );
    assert_eq!(
        items(&admin, &box_id(1)).await,
        vec![
            json!([record_id(1), code_hash(1), instant(1, 0), null, null]),
            json!([record_id(2), code_hash(2), instant(2, 0), null, null]),
        ]
    );
    // Facts are production data: no revision, no stream wake, no audit row.
    assert_eq!(host_revision(&admin.app).await, revision);
    assert!(!wake.has_changed().unwrap());
    assert_eq!(audit_rows(&admin.app).await, rows);
    let kept = fact_rows(&admin.app).await;
    assert_eq!(
        kept,
        json!({
            "fact_receipts": 5, "scans": 5, "boxes": 1, "box_items": 2, "code_owners": 2,
            "code_conflicts": 0, "box_exceptions": 0, "shift_close_events": 0
        })
    );

    // The same batch again, later: the same receipts, nothing new.
    admin.app.clock.advance(time::Duration::minutes(3));
    assert_eq!(receipts(&admin.app, &floor.key, &batch).await, expected);
    assert_eq!(fact_rows(&admin.app).await, kept);
    // One record of it with its keys in another order is the same record.
    let text = format!(
        r#"{{"records":[{{"data":{},"shiftId":"{}","operatorId":null,"kind":"scan","id":"{}"}}]}}"#,
        batch[1]["data"],
        floor.shift,
        record_id(2)
    );
    let (status, body) = admin
        .app
        .send(
            with_device(request("POST", "/v1/device/facts"), &floor.key)
                .header("content-type", "application/json")
                .body(Body::from(text))
                .unwrap(),
        )
        .await;
    assert_eq!(
        (status, body),
        (
            StatusCode::OK,
            json!({ "receipts": [accepted(&record_id(2))] })
        )
    );
    assert_eq!(fact_rows(&admin.app).await, kept);
}

#[tokio::test]
async fn a_record_sent_again_with_other_content_is_refused_and_keeps_its_receipt() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let mut wrong = code(9);
    wrong["gtin14"] = json!("04600682000099");
    let mut refused_scan = ok_scan(9, &box_id(1), &instant(9, 0));
    refused_scan["code"] = wrong;
    let original = fact(
        &record_id(1),
        "scan",
        &floor.shift,
        ok_scan(1, &box_id(1), &instant(1, 0)),
    );
    let refused = fact(&record_id(2), "scan", &floor.shift, refused_scan);
    assert_eq!(
        receipts(&admin.app, &floor.key, &[original.clone(), refused.clone()]).await,
        vec![
            accepted(&record_id(1)),
            rejected(Some(&record_id(2)), "gtin_mismatch", None)
        ]
    );
    let kept = fact_rows(&admin.app).await;
    let mut changed = original.clone();
    changed["data"]["scannedAt"] = json!(instant(1, 1));
    assert_eq!(
        receipts(&admin.app, &floor.key, &[changed]).await,
        vec![rejected(Some(&record_id(1)), "payload_mismatch", None)]
    );
    // Nothing changed, the first receipt neither: the original again is
    // still accepted, and the refused record still refused, not applied.
    assert_eq!(fact_rows(&admin.app).await, kept);
    assert_eq!(
        receipts(&admin.app, &floor.key, &[original, refused]).await,
        vec![
            accepted(&record_id(1)),
            rejected(Some(&record_id(2)), "gtin_mismatch", None)
        ]
    );
    assert_eq!(fact_rows(&admin.app).await, kept);
    // The same id from another device is another record.
    let theirs = fact(
        &record_id(1),
        "scan",
        &colleague.shift,
        ok_scan(5, &box_id(2), &instant(5, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &colleague.key, &[theirs]).await,
        vec![accepted(&record_id(1))]
    );
    let mut expected = vec![
        json!([
            colleague.station,
            record_id(1),
            "scan",
            colleague.shift,
            "accepted",
            null,
            null
        ]),
        json!([
            floor.station,
            record_id(1),
            "scan",
            floor.shift,
            "accepted",
            null,
            null
        ]),
        json!([
            floor.station,
            record_id(2),
            "scan",
            floor.shift,
            "rejected",
            "gtin_mismatch",
            null
        ]),
    ];
    expected.sort_by_key(|row| (row[1].to_string(), row[0].to_string()));
    assert_eq!(kept_receipts(&admin).await, expected);
    assert_eq!(
        owners(&admin).await,
        vec![
            json!([
                code_hash(1),
                record_id(1),
                floor.shift,
                floor.station,
                box_id(1),
                instant(1, 0)
            ]),
            json!([
                code_hash(5),
                record_id(1),
                colleague.shift,
                colleague.station,
                box_id(2),
                instant(5, 0)
            ]),
        ]
    );
}

#[tokio::test]
async fn a_record_the_host_cannot_read_is_refused_and_the_others_are_applied() {
    let (admin, floor) = floor().await;
    let shift = floor.shift.as_str();
    let good = |n: u32| {
        fact(
            &record_id(n),
            "scan",
            shift,
            ok_scan(n, &box_id(1), &instant(n, 0)),
        )
    };
    let mut no_length = good(4);
    no_length["data"]
        .as_object_mut()
        .unwrap()
        .remove("rawLength");
    let mut extra = good(5);
    extra["data"]["note"] = json!("a field no scan has");
    let mut teleport = good(6);
    teleport["kind"] = json!("teleport");
    let mut upper_id = good(7);
    upper_id["id"] = json!(record_id(7).replace("4000", "4ABC"));
    let mut no_shift = good(8);
    no_shift.as_object_mut().unwrap().remove("shiftId");
    let batch = vec![
        good(1),
        json!(42),
        json!("a scan"),
        json!({}),
        no_length,
        extra,
        teleport,
        upper_id,
        no_shift,
        good(2),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            accepted(&record_id(1)),
            rejected(None, "invalid_record", None),
            rejected(None, "invalid_record", None),
            rejected(None, "invalid_record", None),
            rejected(Some(&record_id(4)), "invalid_record", Some("data")),
            rejected(Some(&record_id(5)), "invalid_record", Some("data")),
            rejected(Some(&record_id(6)), "invalid_record", None),
            rejected(None, "invalid_record", Some("id")),
            rejected(Some(&record_id(8)), "invalid_record", None),
            accepted(&record_id(2)),
        ]
    );
    // A record with a readable id keeps its receipt (its kind once readable,
    // its shift once the entry was found); one without keeps nothing.
    let s = &floor.shift;
    let d = &floor.station;
    assert_eq!(
        kept_receipts(&admin).await,
        vec![
            json!([d, record_id(1), "scan", s, "accepted", null, null]),
            json!([d, record_id(2), "scan", s, "accepted", null, null]),
            json!([d, record_id(4), "scan", s, "rejected", "invalid_record", { "field": "data" }]),
            json!([d, record_id(5), "scan", s, "rejected", "invalid_record", { "field": "data" }]),
            json!([
                d,
                record_id(6),
                null,
                null,
                "rejected",
                "invalid_record",
                null
            ]),
            json!([
                d,
                record_id(8),
                null,
                null,
                "rejected",
                "invalid_record",
                null
            ]),
        ]
    );
    assert_eq!(scan_rows(&admin).await.len(), 2);
    // Sent again, every record gets its answer again, the kept ones from
    // their receipts with their details.
    let again = receipts(&admin.app, &floor.key, &batch).await;
    assert_eq!(
        again[4],
        rejected(Some(&record_id(4)), "invalid_record", Some("data"))
    );
    assert_eq!(again[7], rejected(None, "invalid_record", Some("id")));
    assert_eq!(scan_rows(&admin).await.len(), 2);
    assert_eq!(kept_receipts(&admin).await.len(), 6);
}

#[tokio::test]
async fn every_field_of_a_scan_is_checked_before_anything_is_written() {
    let (admin, floor) = floor().await;
    let shift = floor.shift.clone();
    let with = |n: u32, path: &[&str], value: Value| {
        let mut data = ok_scan(n, &box_id(1), &instant(n, 0));
        match path {
            [key] => data[*key] = value,
            [outer, key] => data[*outer][*key] = value,
            _ => unreachable!(),
        }
        data
    };
    let invalid = |n: u32, raw_kind: &str| {
        other_scan(
            "invalid",
            raw_kind,
            Value::Null,
            Value::Null,
            &instant(n, 0),
        )
    };
    let duplicate = |n: u32| other_scan("duplicate", "km", code(n), json!("host"), &instant(n, 0));
    let with_code = {
        let mut data = invalid(9, "unknown");
        data["code"] = code(9);
        data
    };
    let no_code = {
        let mut data = duplicate(10);
        data["code"] = Value::Null;
        data
    };
    let no_source = {
        let mut data = duplicate(11);
        data["duplicateSource"] = Value::Null;
        data
    };
    let boxed = {
        let mut data = duplicate(12);
        data["boxId"] = json!(box_id(1));
        data
    };
    let multibyte = format!("{}é", "0".repeat(1022));
    assert_eq!(multibyte.len(), 1024);
    // Each case breaks one rule (the field it names) or none.
    let cases: Vec<(Value, Option<&str>)> = vec![
        (
            with(1, &["scannedAt"], json!("2026-10-08T06:00:01Z")),
            Some("data.scannedAt"),
        ),
        (with(2, &["rawKind"], json!("gtin")), Some("data.rawKind")),
        (
            with(3, &["duplicateSource"], json!("local")),
            Some("data.duplicateSource"),
        ),
        (with(4, &["boxId"], Value::Null), Some("data.boxId")),
        (with(5, &["boxId"], json!("box-1")), Some("data.boxId")),
        (
            with(
                6,
                &["code", "codeHash"],
                json!(code_hash(6).replace('0', "A")),
            ),
            Some("data.code.codeHash"),
        ),
        (
            with(7, &["code", "gtin14"], json!("4600682000013")),
            Some("data.code.gtin14"),
        ),
        (
            with(8, &["code", "serial"], json!("")),
            Some("data.code.serial"),
        ),
        (with_code, Some("data.code")),
        (no_code, Some("data.code")),
        (no_source, Some("data.duplicateSource")),
        (boxed, Some("data.boxId")),
        (
            with(13, &["code", "serial"], json!("S".repeat(65))),
            Some("data.code.serial"),
        ),
        (
            with(14, &["code", "serial"], json!("S\n1")),
            Some("data.code.serial"),
        ),
        (
            with(
                15,
                &["code", "canonical"],
                json!("0104600682000013\u{0}21S"),
            ),
            Some("data.code.canonical"),
        ),
        (
            with(16, &["code", "canonical"], json!("0".repeat(1025))),
            Some("data.code.canonical"),
        ),
        (
            with(17, &["code", "canonical"], json!("")),
            Some("data.code.canonical"),
        ),
        (invalid(18, "km"), Some("data.rawKind")),
        (
            with(
                25,
                &["code", "canonical"],
                json!(format!("{}é", "0".repeat(1023))),
            ),
            Some("data.code.canonical"),
        ),
        (
            with(26, &["code", "serial"], json!("Ё".repeat(33))),
            Some("data.code.serial"),
        ),
        // The longest serial and canonical text pass; so does a duplicate the
        // host found and an `invalid` scan of each kind but a code.
        (with(19, &["code", "serial"], json!("S".repeat(64))), None),
        (with(20, &["code", "canonical"], json!(multibyte)), None),
        (duplicate(21), None),
        (invalid(22, "sscc"), None),
        (invalid(23, "gtin"), None),
        (invalid(24, "unknown"), None),
    ];
    let mut records = Vec::new();
    let mut expected = Vec::new();
    for (n, (data, field)) in (1..).zip(cases) {
        records.push(fact(&record_id(n), "scan", &shift, data));
        expected.push(match field {
            Some(field) => rejected(Some(&record_id(n)), "invalid_record", Some(field)),
            None => accepted(&record_id(n)),
        });
    }
    // The envelope's ids too.
    let mut operator = fact(
        &record_id(30),
        "scan",
        &shift,
        ok_scan(30, &box_id(1), &instant(30, 0)),
    );
    operator["operatorId"] = json!("anna");
    records.push(operator);
    records.push(fact(
        &record_id(31),
        "scan",
        "OCT26-001",
        ok_scan(31, &box_id(1), &instant(31, 0)),
    ));
    expected.push(rejected(
        Some(&record_id(30)),
        "invalid_record",
        Some("operatorId"),
    ));
    expected.push(rejected(
        Some(&record_id(31)),
        "invalid_record",
        Some("shiftId"),
    ));
    assert_eq!(receipts(&admin.app, &floor.key, &records).await, expected);
    // Only the scans that broke no rule wrote anything but their receipts.
    assert_eq!(
        fact_rows(&admin.app).await,
        json!({
            "fact_receipts": 28, "scans": 6, "boxes": 1, "box_items": 2, "code_owners": 2,
            "code_conflicts": 0, "box_exceptions": 0, "shift_close_events": 0
        })
    );
}

#[tokio::test]
async fn a_record_names_a_shift_the_device_entered_and_a_batch_holds_1_to_100() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let planned = plan_shift(&admin, shift_body(&setup)).await;
    let (_, office_pc) = pair_device(&admin.app, "office").await;
    let scan = |n: u32, shift: &str| {
        fact(
            &record_id(n),
            "scan",
            shift,
            ok_scan(n, &box_id(n), &instant(n, 0)),
        )
    };
    // No such shift; a shift nobody entered; another station's shift.
    let batch = vec![
        scan(1, "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b"),
        scan(2, planned["id"].as_str().unwrap()),
        scan(3, &colleague.shift),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            rejected(Some(&record_id(1)), "unknown_shift", None),
            rejected(Some(&record_id(2)), "not_entered", None),
            rejected(Some(&record_id(3)), "not_entered", None),
        ]
    );
    // A device of another kind enters no shift at all.
    assert_eq!(
        receipts(&admin.app, &office_pc, &[scan(4, &floor.shift)]).await,
        vec![rejected(Some(&record_id(4)), "not_entered", None)]
    );
    assert_eq!(scan_rows(&admin).await, Vec::<Value>::new());

    // A batch holds 1 to 100 records; anything else is no batch.
    let hundred: Vec<Value> = (100..200).map(|n| scan(n, &floor.shift)).collect();
    let answered = receipts(&admin.app, &floor.key, &hundred).await;
    assert_eq!(answered.len(), 100);
    assert!(answered
        .iter()
        .all(|receipt| receipt["outcome"] == "accepted"));
    let kept = fact_rows(&admin.app).await;
    let too_many: Vec<Value> = (200..301).map(|n| scan(n, &floor.shift)).collect();
    for records in [Vec::new(), too_many] {
        let (status, refused) = send_facts(&admin.app, &floor.key, &records).await;
        assert_eq!(
            (
                status,
                refused["error"]["code"].clone(),
                refused["error"]["details"].clone()
            ),
            (
                StatusCode::BAD_REQUEST,
                json!("validation_failed"),
                json!({ "field": "records" })
            ),
            "{}",
            records.len()
        );
    }
    for body in [
        json!({}),
        json!({ "records": {} }),
        json!({ "records": [], "more": 1 }),
    ] {
        let (status, refused) = admin
            .app
            .send(support::app::json(
                with_device(request("POST", "/v1/device/facts"), &floor.key),
                body.clone(),
            ))
            .await;
        assert_eq!(
            (status, refused["error"]["code"].clone()),
            (StatusCode::BAD_REQUEST, json!("validation_failed")),
            "{body}"
        );
    }
    let (status, refused) = admin
        .app
        .send(support::app::json(
            request("POST", "/v1/device/facts"),
            json!({ "records": [scan(400, &floor.shift)] }),
        ))
        .await;
    assert_eq!(
        (status, refused["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("device"))
    );
    assert_eq!(fact_rows(&admin.app).await, kept);
}

/// A closed box straight in its table, with an SSCC of a block the station
/// got.
async fn close_box_directly(admin: &Admin, floor: &Floor, id: &str) {
    let (status, block) = admin
        .app
        .send(support::app::json(
            with_device(request("POST", "/v1/device/sscc/blocks"), &floor.key),
            json!({
                "requestId": "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a",
                "issuerPrefix": "460068200", "extension": 0
            }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{block}");
    sqlx::query(
        "UPDATE boxes SET closed_at = ?, sscc = '046006820000015008', block_id = ?, \
         serial = 1500, digest_matches = 1 WHERE id = ?",
    )
    .bind(instant(30, 0))
    .bind(block["id"].as_str().unwrap())
    .bind(id)
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn an_accepted_scan_goes_into_an_open_box_of_its_own_with_the_shifts_gtin() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let opened = vec![
        fact(
            &record_id(1),
            "scan",
            &floor.shift,
            ok_scan(1, &box_id(1), &instant(1, 0)),
        ),
        fact(
            &record_id(2),
            "scan",
            &colleague.shift,
            ok_scan(2, &box_id(2), &instant(2, 0)),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &opened[..1]).await,
        vec![accepted(&record_id(1))]
    );
    assert_eq!(
        receipts(&admin.app, &colleague.key, &opened[1..]).await,
        vec![accepted(&record_id(2))]
    );
    close_box_directly(&admin, &floor, &box_id(1)).await;
    let kept = fact_rows(&admin.app).await;
    let mut other_product = ok_scan(3, &box_id(3), &instant(3, 0));
    other_product["code"]["gtin14"] = json!("04600682000099");
    let batch = vec![
        // Another product than the snapshot's.
        fact(&record_id(3), "scan", &floor.shift, other_product),
        // The colleague's box.
        fact(
            &record_id(4),
            "scan",
            &floor.shift,
            ok_scan(4, &box_id(2), &instant(4, 0)),
        ),
        // A closed box.
        fact(
            &record_id(5),
            "scan",
            &floor.shift,
            ok_scan(5, &box_id(1), &instant(5, 0)),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            rejected(Some(&record_id(3)), "gtin_mismatch", None),
            rejected(Some(&record_id(4)), "box_unknown", None),
            rejected(Some(&record_id(5)), "box_closed", None),
        ]
    );
    let mut grown = kept.clone();
    grown["fact_receipts"] = json!(kept["fact_receipts"].as_i64().unwrap() + 3);
    assert_eq!(fact_rows(&admin.app).await, grown);
    // A box of another device in this very shift is unknown too (a second
    // device on a shift comes with plan 2b, so the row is put in directly).
    sqlx::query(
        "INSERT INTO boxes (id, shift_id, device_id, opened_at, received_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(box_id(9))
    .bind(&floor.shift)
    .bind(&colleague.station)
    .bind(instant(9, 0))
    .bind(admin.app.state.timestamp())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(7),
                "scan",
                &floor.shift,
                ok_scan(7, &box_id(9), &instant(7, 0))
            )]
        )
        .await,
        vec![rejected(Some(&record_id(7)), "box_unknown", None)]
    );
    // A box id of this station in another shift is unknown in this one too.
    let second = open_floor(&admin, &setup, &floor.key, &setup.line).await;
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(6),
                "scan",
                &second.shift,
                ok_scan(6, &box_id(1), &instant(6, 0))
            )]
        )
        .await,
        vec![rejected(Some(&record_id(6)), "box_unknown", None)]
    );
}

#[tokio::test]
async fn the_earliest_scan_owns_a_code_whatever_order_the_scans_arrive_in() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let b = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let send = |floor: &Floor, n: u32, box_n: u32, second: u32, milli: u32| {
        let record = fact(
            &record_id(n),
            "scan",
            &floor.shift,
            ok_scan(7, &box_id(box_n), &instant(second, milli)),
        );
        let app = &admin.app;
        let key = floor.key.clone();
        async move { receipts(app, &key, &[record]).await.remove(0) }
    };
    // A scans the code first; B's scan, which arrives later, was earlier.
    let first_seen = admin.app.state.timestamp();
    assert_eq!(send(&a, 1, 1, 100, 0).await, accepted(&record_id(1)));
    admin.app.clock.advance(time::Duration::minutes(1));
    let displaced_at = admin.app.state.timestamp();
    assert_ne!(displaced_at, first_seen);
    assert_eq!(send(&b, 2, 2, 50, 0).await, accepted(&record_id(2)));
    // B owns it now; A's item left its box when B's scan took the code.
    assert_eq!(
        owners(&admin).await,
        vec![json!([
            code_hash(7),
            record_id(2),
            b.shift,
            b.station,
            box_id(2),
            instant(50, 0)
        ])]
    );
    assert_eq!(
        items(&admin, &box_id(1)).await,
        vec![json!([
            record_id(1),
            code_hash(7),
            instant(100, 0),
            null,
            displaced_at
        ])]
    );
    assert_eq!(
        items(&admin, &box_id(2)).await,
        vec![json!([
            record_id(2),
            code_hash(7),
            instant(50, 0),
            null,
            null
        ])]
    );
    // Later scans lose to B's, A's own included; a scan at the same instant
    // too; the winner is named, and whether it is the sender's own.
    let winner = |same_device: bool| {
        json!({
            "shiftId": b.shift, "shiftNumber": b.number, "deviceId": b.station,
            "scannedAt": instant(50, 0), "sameDevice": same_device
        })
    };
    let conflict = |n: u32, same_device: bool| json!({ "id": record_id(n), "outcome": "conflict", "details": { "winner": winner(same_device) } });
    assert_eq!(send(&a, 3, 1, 200, 0).await, conflict(3, false));
    assert_eq!(send(&b, 4, 2, 300, 0).await, conflict(4, true));
    assert_eq!(send(&a, 5, 1, 50, 0).await, conflict(5, false));
    // One millisecond earlier than the owner takes the code back.
    assert_eq!(send(&a, 6, 1, 49, 999).await, accepted(&record_id(6)));
    assert_eq!(
        owners(&admin).await,
        vec![json!([
            code_hash(7),
            record_id(6),
            a.shift,
            a.station,
            box_id(1),
            instant(49, 999)
        ])]
    );
    assert_eq!(
        items(&admin, &box_id(2)).await,
        vec![json!([
            record_id(2),
            code_hash(7),
            instant(50, 0),
            null,
            displaced_at
        ])]
    );
    // A conflict sent again keeps its receipt, the winner of that moment,
    // and writes nothing.
    assert_eq!(send(&a, 3, 1, 200, 0).await, conflict(3, false));
    // Every pair of scans of the code is a conflict row: winner, loser.
    let mut expected = vec![
        json!([code_hash(7), record_id(2), record_id(1), displaced_at]),
        json!([code_hash(7), record_id(2), record_id(3), displaced_at]),
        json!([code_hash(7), record_id(2), record_id(4), displaced_at]),
        json!([code_hash(7), record_id(2), record_id(5), displaced_at]),
        json!([code_hash(7), record_id(6), record_id(2), displaced_at]),
    ];
    expected.sort_by_key(|row| (row[1].to_string(), row[2].to_string()));
    assert_eq!(conflicts(&admin).await, expected);
    // The scans that lost are in the journal, with no item.
    assert_eq!(scan_rows(&admin).await.len(), 6);
    let live: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM box_items WHERE removed_at IS NULL AND displaced_at IS NULL",
    )
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(live, 1);
}

/// A database error is no receipt: the whole batch fails, nothing of it
/// stays, and the device sends it again.
#[tokio::test]
async fn a_database_error_fails_the_whole_batch() {
    let (admin, floor) = floor().await;
    sqlx::query(
        "CREATE TRIGGER break_the_scan BEFORE INSERT ON scans WHEN NEW.raw_length = 999 \
         BEGIN SELECT RAISE(ABORT, 'broken'); END",
    )
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    let mut broken = ok_scan(2, &box_id(1), &instant(2, 0));
    broken["rawLength"] = json!(999);
    let batch = vec![
        fact(
            &record_id(1),
            "scan",
            &floor.shift,
            ok_scan(1, &box_id(1), &instant(1, 0)),
        ),
        fact(&record_id(2), "scan", &floor.shift, broken),
    ];
    let empty = fact_rows(&admin.app).await;
    let (status, failed) = send_facts(&admin.app, &floor.key, &batch).await;
    assert_eq!(
        (status, failed["error"]["code"].clone()),
        (StatusCode::INTERNAL_SERVER_ERROR, json!("internal"))
    );
    assert_eq!(fact_rows(&admin.app).await, empty);
    sqlx::query("DROP TRIGGER break_the_scan")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![accepted(&record_id(1)), accepted(&record_id(2))]
    );
}

/// The handler called directly as device `id` with `records`, bypassing the
/// device authentication in front of it (which has read the key before the
/// handler's transaction starts, and may write `last_seen_at` once a minute).
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

/// The batch reads the receipts only after it holds the write lock: a record
/// another batch is still writing when this one arrives is seen, and kept
/// once. With a deferred transaction the stale receipts would be read first
/// and the write would fail with a database error.
#[tokio::test]
async fn a_batch_waiting_for_the_write_lock_sees_the_record_that_held_it() {
    let (admin, floor) = floor().await;
    let record = fact(
        &record_id(1),
        "scan",
        &floor.shift,
        ok_scan(1, &box_id(1), &instant(1, 0)),
    );
    // The same record, sent again while the first send is still being
    // written.
    let mut holder = begin_write(&admin.app.state.pool).await.unwrap();
    let first = markiro_host::facts::receive(
        &mut holder,
        &floor.station,
        &record,
        &admin.app.state.timestamp(),
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::to_value(first).unwrap(),
        accepted(&record_id(1))
    );
    let again = [record];
    let mut waiting = Box::pin(receive_as(&admin, &floor.station, &again));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(200), &mut waiting)
            .await
            .is_err(),
        "the batch answered while another writer held the lock"
    );
    holder.commit().await.unwrap();
    let (status, body) = waiting.await;
    assert_eq!(
        (status, body),
        (
            StatusCode::OK,
            json!({ "receipts": [accepted(&record_id(1))] })
        )
    );
    assert_eq!(scan_rows(&admin).await.len(), 1);
    assert_eq!(kept_receipts(&admin).await.len(), 1);
}

/// The transaction reads the device again: a station revoked after the
/// device authentication read its key (the batch waited for the write lock)
/// keeps nothing, not even a record it sent before.
#[tokio::test]
async fn a_device_revoked_meanwhile_keeps_nothing() {
    let (admin, floor) = floor().await;
    let sent = fact(
        &record_id(1),
        "scan",
        &floor.shift,
        ok_scan(1, &box_id(1), &instant(1, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[sent.clone()]).await,
        vec![accepted(&record_id(1))]
    );
    sqlx::query("UPDATE devices SET revoked_at = ? WHERE id = ?")
        .bind(admin.app.state.timestamp())
        .bind(&floor.station)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let kept = fact_rows(&admin.app).await;
    let next = fact(
        &record_id(2),
        "scan",
        &floor.shift,
        ok_scan(2, &box_id(1), &instant(2, 0)),
    );
    for records in [vec![sent], vec![next]] {
        let (status, refused) = receive_as(&admin, &floor.station, &records).await;
        assert_eq!(
            (status, refused["error"]["details"]["credential"].clone()),
            (StatusCode::UNAUTHORIZED, json!("device"))
        );
    }
    assert_eq!(fact_rows(&admin.app).await, kept);
}

/// A box as the host keeps it: `(opened, closed, SSCC, block, serial, count
/// reported, digest reported, digest matches, operator)`.
async fn box_row(admin: &Admin, id: &str) -> Value {
    type BoxRow = (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<String>,
        Option<bool>,
        Option<String>,
    );
    let row: BoxRow = sqlx::query_as(
        "SELECT opened_at, closed_at, sscc, block_id, serial, item_count_reported, \
         membership_digest, digest_matches, operator_id FROM boxes WHERE id = ?",
    )
    .bind(id)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    json!([row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8])
}

/// How far the station used its block, as the host knows it.
async fn consumed_through(admin: &Admin, block: &Value) -> Option<i64> {
    sqlx::query_scalar("SELECT consumed_through FROM sscc_blocks WHERE id = ?")
        .bind(block["id"].as_str().unwrap())
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const OPERATOR: &str = "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d";

#[tokio::test]
async fn a_box_closes_with_an_sscc_of_its_devices_block_and_its_members_are_compared() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let shift = floor.shift.as_str();
    // Box 1 holds codes 1 and 2, box 2 code 3, box 3 codes 5 and 6.
    let scans: Vec<Value> = [(1, 1), (2, 1), (3, 2), (5, 3), (6, 3)]
        .into_iter()
        .map(|(n, box_n)| {
            fact(
                &record_id(n),
                "scan",
                shift,
                ok_scan(n, &box_id(box_n), &instant(n, 0)),
            )
        })
        .collect();
    receipts(&admin.app, &floor.key, &scans).await;
    // The colleague scanned code 6 earlier: it leaves box 3.
    assert_eq!(
        receipts(
            &admin.app,
            &colleague.key,
            &[fact(
                &record_id(9),
                "scan",
                &colleague.shift,
                ok_scan(6, &box_id(9), &instant(0, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(9))]
    );
    let mut first = fact(
        &record_id(11),
        "box_closed",
        shift,
        box_closed(
            &box_id(1),
            &block,
            1500,
            &[1, 2],
            &instant(0, 500),
            &instant(20, 0),
        ),
    );
    first["operatorId"] = json!(OPERATOR);
    let batch = vec![
        first,
        // Closed later, but with the next serial but one.
        fact(
            &record_id(12),
            "box_closed",
            shift,
            box_closed(
                &box_id(2),
                &block,
                1502,
                &[3],
                &instant(3, 0),
                &instant(21, 0),
            ),
        ),
        // The station still counts code 6 in box 3: the digests differ.
        fact(
            &record_id(13),
            "box_closed",
            shift,
            box_closed(
                &box_id(3),
                &block,
                1501,
                &[5, 6],
                &instant(5, 0),
                &instant(22, 0),
            ),
        ),
    ];
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            accepted(&record_id(11)),
            accepted(&record_id(12)),
            accepted(&record_id(13))
        ]
    );
    let block_id = block["id"].clone();
    assert_eq!(
        box_row(&admin, &box_id(1)).await,
        json!([
            instant(0, 500),
            instant(20, 0),
            sscc(1500),
            block_id,
            1500,
            2,
            members_digest(&[1, 2]),
            true,
            OPERATOR
        ])
    );
    assert_eq!(
        box_row(&admin, &box_id(2)).await,
        json!([
            instant(3, 0),
            instant(21, 0),
            sscc(1502),
            block_id,
            1502,
            1,
            members_digest(&[3]),
            true,
            null
        ])
    );
    assert_eq!(
        box_row(&admin, &box_id(3)).await,
        json!([
            instant(5, 0),
            instant(22, 0),
            sscc(1501),
            block_id,
            1501,
            2,
            members_digest(&[5, 6]),
            false,
            null
        ])
    );
    // The block is used as far as its highest closed serial, whatever order
    // the boxes closed in.
    assert_eq!(consumed_through(&admin, &block).await, Some(1502));
    // A close takes no revision and writes no audit row.
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);

    // The same close under another id changes nothing; another SSCC for a
    // closed box is refused.
    let kept = fact_rows(&admin.app).await;
    let again = fact(
        &record_id(14),
        "box_closed",
        shift,
        box_closed(
            &box_id(1),
            &block,
            1500,
            &[1, 2],
            &instant(0, 500),
            &instant(20, 0),
        ),
    );
    let other = fact(
        &record_id(15),
        "box_closed",
        shift,
        box_closed(
            &box_id(1),
            &block,
            1503,
            &[1, 2],
            &instant(0, 500),
            &instant(23, 0),
        ),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[again, other]).await,
        vec![
            accepted(&record_id(14)),
            rejected(Some(&record_id(15)), "box_already_closed", None)
        ]
    );
    let mut grown = kept.clone();
    grown["fact_receipts"] = json!(kept["fact_receipts"].as_i64().unwrap() + 2);
    assert_eq!(fact_rows(&admin.app).await, grown);
    assert_eq!(box_row(&admin, &box_id(1)).await[1], json!(instant(20, 0)));
    assert_eq!(consumed_through(&admin, &block).await, Some(1502));
}

#[tokio::test]
async fn a_box_closes_only_with_an_sscc_issued_to_its_device_for_its_shift() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let theirs = issue_block(&admin.app, &colleague.key, BLOCK_REQUEST).await;
    let revoked = issue_block(
        &admin.app,
        &floor.key,
        "8d7c6b5a-4e3f-4a2b-9c1d-0e9f8a7b6c5d",
    )
    .await;
    sqlx::query("UPDATE sscc_blocks SET revoked_at = ? WHERE id = ?")
        .bind(admin.app.state.timestamp())
        .bind(revoked["id"].as_str().unwrap())
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let shift = floor.shift.as_str();
    receipts(
        &admin.app,
        &floor.key,
        &[
            fact(
                &record_id(1),
                "scan",
                shift,
                ok_scan(1, &box_id(1), &instant(1, 0)),
            ),
            fact(
                &record_id(2),
                "scan",
                shift,
                ok_scan(2, &box_id(2), &instant(2, 0)),
            ),
        ],
    )
    .await;
    let close = |n: u32, data: Value| fact(&record_id(n), "box_closed", shift, data);
    let data = |serial: u64| {
        box_closed(
            &box_id(1),
            &block,
            serial,
            &[1],
            &instant(1, 0),
            &instant(30, 0),
        )
    };
    let with = |field: &str, value: Value| {
        let mut data = data(1500);
        data[field] = value;
        data
    };
    let mut other_prefix = data(1500);
    other_prefix["sscc"] = json!("046012340000015004");
    let mut pallet = data(1500);
    pallet["sscc"] = json!("146006820000015007");
    let mut wrong_serial = data(1500);
    wrong_serial["serial"] = json!(1501);
    // A serial of the colleague's block (3500–5499) and of the revoked one
    // (5500–7499).
    let mut colleagues_block = data(3500);
    colleagues_block["blockId"] = theirs["id"].clone();
    let mut unknown_block = data(1500);
    unknown_block["blockId"] = json!("6f5e4d3c-2b1a-4098-8765-43210fedcba9");
    let mut revoked_block = data(5500);
    revoked_block["blockId"] = revoked["id"].clone();
    let batch = vec![
        close(
            10,
            box_closed(
                &box_id(7),
                &block,
                1500,
                &[1],
                &instant(1, 0),
                &instant(30, 0),
            ),
        ),
        close(11, with("sscc", json!("04600682000001500"))),
        close(12, with("sscc", json!("04600682000001500A"))),
        close(13, with("blockId", json!("block"))),
        close(14, with("openedAt", json!("2026-10-08T06:00:01Z"))),
        close(15, with("closedAt", json!("today"))),
        close(16, with("itemCount", json!(0))),
        close(17, with("membershipDigest", json!("digest"))),
        close(18, with("serial", json!(-1))),
        close(19, other_prefix),
        close(20, pallet),
        close(21, wrong_serial),
        close(22, data(1499)),
        close(23, data(3500)),
        close(24, colleagues_block),
        close(25, unknown_block),
        close(26, revoked_block),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            rejected(Some(&record_id(10)), "box_unknown", None),
            rejected(Some(&record_id(11)), "invalid_record", Some("data.sscc")),
            rejected(Some(&record_id(12)), "invalid_record", Some("data.sscc")),
            rejected(Some(&record_id(13)), "invalid_record", Some("data.blockId")),
            rejected(
                Some(&record_id(14)),
                "invalid_record",
                Some("data.openedAt")
            ),
            rejected(
                Some(&record_id(15)),
                "invalid_record",
                Some("data.closedAt")
            ),
            rejected(
                Some(&record_id(16)),
                "invalid_record",
                Some("data.itemCount")
            ),
            rejected(
                Some(&record_id(17)),
                "invalid_record",
                Some("data.membershipDigest")
            ),
            rejected(Some(&record_id(18)), "invalid_record", Some("data")),
            rejected(Some(&record_id(19)), "sscc_not_issued", None),
            rejected(Some(&record_id(20)), "sscc_not_issued", None),
            rejected(Some(&record_id(21)), "sscc_not_issued", None),
            rejected(Some(&record_id(22)), "sscc_not_issued", None),
            rejected(Some(&record_id(23)), "sscc_not_issued", None),
            rejected(Some(&record_id(24)), "sscc_not_issued", None),
            rejected(Some(&record_id(25)), "sscc_not_issued", None),
            rejected(Some(&record_id(26)), "sscc_not_issued", None),
        ]
    );
    // Nothing was closed and no block moved.
    assert_eq!(box_row(&admin, &box_id(1)).await[1], Value::Null);
    assert_eq!(consumed_through(&admin, &block).await, None);
    assert_eq!(consumed_through(&admin, &revoked).await, None);
    // The block's first and last serials close boxes; a serial another box
    // carries is taken.
    let last = box_closed(
        &box_id(2),
        &block,
        3499,
        &[2],
        &instant(2, 0),
        &instant(31, 0),
    );
    let mut taken = last.clone();
    taken["boxId"] = json!(box_id(1));
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[close(30, data(1500)), close(31, last), close(32, taken)]
        )
        .await,
        vec![
            accepted(&record_id(30)),
            accepted(&record_id(31)),
            rejected(Some(&record_id(32)), "box_already_closed", None),
        ]
    );
    receipts(
        &admin.app,
        &floor.key,
        &[fact(
            &record_id(3),
            "scan",
            shift,
            ok_scan(3, &box_id(3), &instant(3, 0)),
        )],
    )
    .await;
    let mut taken = box_closed(
        &box_id(3),
        &block,
        3499,
        &[3],
        &instant(3, 0),
        &instant(32, 0),
    );
    taken["sscc"] = json!(sscc(3499));
    assert_eq!(
        receipts(&admin.app, &floor.key, &[close(33, taken)]).await,
        vec![rejected(Some(&record_id(33)), "sscc_taken", None)]
    );
    assert_eq!(consumed_through(&admin, &block).await, Some(3499));
    assert_eq!(box_row(&admin, &box_id(3)).await[1], Value::Null);
}

// Tests added beyond the plan's: each pins what a one-line mutant of the
// plan's code got away with.

/// The same record twice in one batch is applied once; the same id with other
/// content in the same batch is `payload_mismatch`; and a record sees what
/// the records before it in its own batch wrote, in either scan-time order.
#[tokio::test]
async fn records_of_one_batch_see_what_the_records_before_them_wrote() {
    let (admin, floor) = floor().await;
    let shift = floor.shift.as_str();
    let scan = |n: u32, code_n: u32, second: u32| {
        fact(
            &record_id(n),
            "scan",
            shift,
            ok_scan(code_n, &box_id(1), &instant(second, 0)),
        )
    };
    let first = scan(1, 1, 1);
    let mut changed = first.clone();
    changed["data"]["scannedAt"] = json!(instant(1, 1));
    let batch = vec![
        first.clone(),
        first,
        changed,
        // One code, the earlier scan first: the later one is a conflict.
        scan(2, 5, 10),
        scan(3, 5, 20),
        // One code, the later scan first: the earlier one takes the code.
        scan(4, 6, 40),
        scan(5, 6, 30),
    ];
    let conflict = json!({
        "id": record_id(3), "outcome": "conflict",
        "details": { "winner": {
            "shiftId": floor.shift, "shiftNumber": floor.number, "deviceId": floor.station,
            "scannedAt": instant(10, 0), "sameDevice": true
        } }
    });
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            accepted(&record_id(1)),
            accepted(&record_id(1)),
            rejected(Some(&record_id(1)), "payload_mismatch", None),
            accepted(&record_id(2)),
            conflict,
            accepted(&record_id(4)),
            accepted(&record_id(5)),
        ]
    );
    assert_eq!(scan_rows(&admin).await.len(), 5);
    assert_eq!(kept_receipts(&admin).await.len(), 5);
    assert_eq!(
        owners(&admin).await,
        vec![
            json!([
                code_hash(1),
                record_id(1),
                floor.shift,
                floor.station,
                box_id(1),
                instant(1, 0)
            ]),
            json!([
                code_hash(5),
                record_id(2),
                floor.shift,
                floor.station,
                box_id(1),
                instant(10, 0)
            ]),
            json!([
                code_hash(6),
                record_id(5),
                floor.shift,
                floor.station,
                box_id(1),
                instant(30, 0)
            ]),
        ]
    );
}

/// The digest is of the whole record: another operator, shift, kind or key
/// under the same id is another record, whatever its `data` says.
#[tokio::test]
async fn the_whole_record_not_only_its_data_keys_its_receipt() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let second = open_floor(&admin, &setup, &floor.key, &setup.line).await;
    let original = fact(
        &record_id(1),
        "scan",
        &floor.shift,
        ok_scan(1, &box_id(1), &instant(1, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[original.clone()]).await,
        vec![accepted(&record_id(1))]
    );
    let kept = fact_rows(&admin.app).await;
    let mut operator = original.clone();
    operator["operatorId"] = json!("c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d");
    let mut shift = original.clone();
    shift["shiftId"] = json!(second.shift);
    let mut kind = original.clone();
    kind["kind"] = json!("teleport");
    let mut extra = original.clone();
    extra["deviceId"] = json!("anything");
    let mut other_shift_data = original.clone();
    other_shift_data["data"]["boxId"] = json!(box_id(2));
    for variant in [operator, shift, kind, extra, other_shift_data] {
        assert_eq!(
            receipts(&admin.app, &floor.key, &[variant.clone()]).await,
            vec![rejected(Some(&record_id(1)), "payload_mismatch", None)],
            "{variant}"
        );
    }
    assert_eq!(fact_rows(&admin.app).await, kept);
    assert_eq!(
        receipts(&admin.app, &floor.key, &[original]).await,
        vec![accepted(&record_id(1))]
    );
}

/// The envelope is read strictly, except that an absent `operatorId` is
/// `null`.
#[tokio::test]
async fn the_envelope_is_read_strictly_and_an_absent_operator_is_none() {
    let (admin, floor) = floor().await;
    let good = |n: u32| {
        fact(
            &record_id(n),
            "scan",
            &floor.shift,
            ok_scan(n, &box_id(1), &instant(n, 0)),
        )
    };
    let mut no_operator = good(1);
    no_operator.as_object_mut().unwrap().remove("operatorId");
    let mut extra_key = good(2);
    extra_key["deviceId"] = json!("anything");
    let mut no_kind = good(3);
    no_kind.as_object_mut().unwrap().remove("kind");
    let mut no_data = good(4);
    no_data.as_object_mut().unwrap().remove("data");
    let mut null_data = good(5);
    null_data["data"] = Value::Null;
    let mut list_data = good(6);
    list_data["data"] = json!([]);
    let mut number_kind = good(7);
    number_kind["kind"] = json!(1);
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[
                no_operator,
                extra_key,
                no_kind,
                no_data,
                null_data,
                list_data,
                number_kind
            ]
        )
        .await,
        vec![
            accepted(&record_id(1)),
            rejected(Some(&record_id(2)), "invalid_record", None),
            rejected(Some(&record_id(3)), "invalid_record", None),
            rejected(Some(&record_id(4)), "invalid_record", None),
            rejected(Some(&record_id(5)), "invalid_record", Some("data")),
            rejected(Some(&record_id(6)), "invalid_record", Some("data")),
            rejected(Some(&record_id(7)), "invalid_record", None),
        ]
    );
    let (s, d) = (&floor.shift, &floor.station);
    let unread = |n: u32| {
        json!([
            d,
            record_id(n),
            null,
            null,
            "rejected",
            "invalid_record",
            null
        ])
    };
    let bad_data = |n: u32| json!([d, record_id(n), "scan", s, "rejected", "invalid_record", { "field": "data" }]);
    assert_eq!(
        kept_receipts(&admin).await,
        vec![
            json!([d, record_id(1), "scan", s, "accepted", null, null]),
            unread(2),
            unread(3),
            unread(4),
            bad_data(5),
            bad_data(6),
            unread(7),
        ]
    );
    assert_eq!(scan_rows(&admin).await.len(), 1);
    assert_eq!(scan_rows(&admin).await[0][12], Value::Null);
}

/// Every column of the journal and of the receipts, for the verdicts and
/// kinds the plan's first test does not reach, with the host's instant of
/// the batch (not the first test's, which never moved the clock).
#[tokio::test]
async fn a_journal_row_and_a_receipt_keep_what_was_sent_and_when() {
    let (admin, floor) = floor().await;
    admin.app.clock.advance(time::Duration::minutes(5));
    let at = admin.app.state.timestamp();
    let mut sscc = other_scan("invalid", "sscc", Value::Null, Value::Null, &instant(3, 0));
    sscc["rawLength"] = json!(18);
    let mut unknown = other_scan(
        "invalid",
        "unknown",
        Value::Null,
        Value::Null,
        &instant(4, 0),
    );
    unknown["rawLength"] = json!(0);
    let batch = vec![
        fact(
            &record_id(1),
            "scan",
            &floor.shift,
            ok_scan(1, &box_id(1), &instant(1, 0)),
        ),
        fact(
            &record_id(2),
            "scan",
            &floor.shift,
            other_scan("duplicate", "km", code(1), json!("host"), &instant(2, 0)),
        ),
        fact(&record_id(3), "scan", &floor.shift, sscc),
        fact(&record_id(4), "scan", &floor.shift, unknown),
    ];
    assert_eq!(receipts(&admin.app, &floor.key, &batch).await.len(), 4);
    let rows = scan_rows(&admin).await;
    let columns =
        |row: &Value| json!([row[0], row[3], row[4], row[5], row[6], row[11], row[13], row[14]]);
    let seen: Vec<Value> = rows.iter().map(columns).collect();
    assert_eq!(
        seen,
        vec![
            json!([
                record_id(1),
                "ok",
                null,
                "km",
                38,
                box_id(1),
                instant(1, 0),
                at
            ]),
            json!([
                record_id(2),
                "duplicate",
                "host",
                "km",
                14,
                null,
                instant(2, 0),
                at
            ]),
            json!([
                record_id(3),
                "invalid",
                null,
                "sscc",
                18,
                null,
                instant(3, 0),
                at
            ]),
            json!([
                record_id(4),
                "invalid",
                null,
                "unknown",
                0,
                null,
                instant(4, 0),
                at
            ]),
        ]
    );
    let stored: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT record_id, digest, received_at FROM fact_receipts ORDER BY record_id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    let expected: Vec<(String, String, String)> = batch
        .iter()
        .map(|record| {
            (
                record["id"].as_str().unwrap().to_owned(),
                record_digest(record),
                at.clone(),
            )
        })
        .collect();
    assert_eq!(stored, expected);
    let opened: (String, String) =
        sqlx::query_as("SELECT received_at, shift_id FROM boxes WHERE id = ?")
            .bind(box_id(1))
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(opened, (at.clone(), floor.shift.clone()));
    // A second scan into the open box leaves the box as it was.
    admin.app.clock.advance(time::Duration::minutes(1));
    receipts(
        &admin.app,
        &floor.key,
        &[fact(
            &record_id(5),
            "scan",
            &floor.shift,
            ok_scan(5, &box_id(1), &instant(5, 0)),
        )],
    )
    .await;
    let again: (String, String, Option<String>) =
        sqlx::query_as("SELECT received_at, opened_at, closed_at FROM boxes WHERE id = ?")
            .bind(box_id(1))
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(again, (at, instant(1, 0), None));
}

/// An earlier scan of a code in the very box of the later owner takes the
/// code without the unique index of live items refusing it: the owner's item
/// leaves the box first.
#[tokio::test]
async fn an_earlier_scan_of_a_code_in_the_same_box_replaces_the_later_item() {
    let (admin, floor) = floor().await;
    let scan = |n: u32, second: u32| {
        fact(
            &record_id(n),
            "scan",
            &floor.shift,
            ok_scan(7, &box_id(1), &instant(second, 0)),
        )
    };
    let displaced_at = admin.app.state.timestamp();
    assert_eq!(
        receipts(&admin.app, &floor.key, &[scan(1, 100)]).await,
        vec![accepted(&record_id(1))]
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[scan(2, 50)]).await,
        vec![accepted(&record_id(2))]
    );
    assert_eq!(
        items(&admin, &box_id(1)).await,
        vec![
            json!([record_id(2), code_hash(7), instant(50, 0), null, null]),
            json!([
                record_id(1),
                code_hash(7),
                instant(100, 0),
                null,
                displaced_at
            ]),
        ]
    );
    assert_eq!(
        owners(&admin).await,
        vec![json!([
            code_hash(7),
            record_id(2),
            floor.shift,
            floor.station,
            box_id(1),
            instant(50, 0)
        ])]
    );
}

/// A scan that loses its code is still an accepted scan: its box is opened,
/// the code stays with the owner and the box gets no item for it.
#[tokio::test]
async fn a_scan_that_loses_its_code_still_opens_its_new_box() {
    let (admin, floor) = floor().await;
    let scan = |n: u32, box_n: u32, second: u32| {
        fact(
            &record_id(n),
            "scan",
            &floor.shift,
            ok_scan(7, &box_id(box_n), &instant(second, 0)),
        )
    };
    assert_eq!(
        receipts(&admin.app, &floor.key, &[scan(1, 1, 100)]).await,
        vec![accepted(&record_id(1))]
    );
    let answered = receipts(&admin.app, &floor.key, &[scan(2, 2, 200)]).await;
    assert_eq!(answered[0]["outcome"], "conflict");
    let opened: (String, String, String, Option<String>) =
        sqlx::query_as("SELECT shift_id, device_id, opened_at, closed_at FROM boxes WHERE id = ?")
            .bind(box_id(2))
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(
        opened,
        (
            floor.shift.clone(),
            floor.station.clone(),
            instant(200, 0),
            None
        )
    );
    assert_eq!(items(&admin, &box_id(2)).await, Vec::<Value>::new());
    assert_eq!(
        owners(&admin).await,
        vec![json!([
            code_hash(7),
            record_id(1),
            floor.shift,
            floor.station,
            box_id(1),
            instant(100, 0)
        ])]
    );
    assert_eq!(fact_rows(&admin.app).await["boxes"], json!(2));
}

/// An SQL literal of an optional text.
fn lit(text: Option<&str>) -> String {
    text.map_or_else(|| "NULL".to_owned(), |text| format!("'{text}'"))
}

/// The statement is refused, by the constraint `fragment` names.
async fn refused_by(admin: &Admin, what: &str, sql: &str, fragment: &str) {
    let error = sqlx::query(sql)
        .execute(&admin.app.state.pool)
        .await
        .expect_err(what);
    let message = error.to_string();
    assert!(message.contains(fragment), "{what}: {message}");
}

/// The statement is accepted (a control: the refused ones differ from it in
/// one thing).
async fn accepted_by_schema(admin: &Admin, what: &str, sql: &str) {
    sqlx::query(sql)
        .execute(&admin.app.state.pool)
        .await
        .unwrap_or_else(|error| panic!("{what}: {error}"));
}

/// What no row may break, whatever writes it: the checks of migration 0010.
/// Every refusal is paired with a control that differs in one thing.
#[tokio::test]
async fn the_schema_refuses_the_rows_no_fact_may_leave() {
    let (admin, floor) = floor().await;
    let (d, s) = (floor.station.as_str(), floor.shift.as_str());
    let (b1, b2) = (box_id(1), box_id(2));
    for (n, box_id) in [(1, &b1), (2, &b2)] {
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(n),
                "scan",
                s,
                ok_scan(n, box_id, &instant(n, 0)),
            )],
        )
        .await;
    }
    let at = admin.app.state.timestamp();
    let digest = "d".repeat(64);
    let scan_id: String = sqlx::query_scalar("SELECT id FROM scans WHERE record_id = ?")
        .bind(record_id(1))
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();

    // fact_receipts
    let receipt =
        |record: &str, digest: &str, outcome: &str, code: Option<&str>, details: Option<&str>| {
            format!(
            "INSERT INTO fact_receipts (device_id, record_id, kind, shift_id, digest, outcome, \
             code, details, received_at) VALUES ('{d}', '{record}', NULL, NULL, '{digest}', \
             '{outcome}', {}, {}, '{at}')",
            lit(code),
            lit(details)
        )
        };
    accepted_by_schema(
        &admin,
        "a receipt",
        &receipt(
            "r-1",
            &digest,
            "rejected",
            Some("box_closed"),
            Some("{\"field\":\"x\"}"),
        ),
    )
    .await;
    accepted_by_schema(
        &admin,
        "an accepted receipt",
        &receipt("r-2", &digest, "accepted", None, None),
    )
    .await;
    for (what, sql, fragment) in [
        (
            "a short digest",
            receipt("r-3", &"d".repeat(63), "accepted", None, None),
            "length(digest) = 64",
        ),
        (
            "an unknown outcome",
            receipt("r-4", &digest, "maybe", None, None),
            "outcome IN",
        ),
        (
            "a rejection without a code",
            receipt("r-5", &digest, "rejected", None, None),
            "(outcome = 'rejected') = (code IS NOT NULL)",
        ),
        (
            "an acceptance with a code",
            receipt("r-6", &digest, "accepted", Some("box_closed"), None),
            "(outcome = 'rejected') = (code IS NOT NULL)",
        ),
        (
            "details that are not JSON",
            receipt("r-7", &digest, "accepted", None, Some("oops")),
            "json_valid(details)",
        ),
        (
            "details that are no object",
            receipt("r-8", &digest, "accepted", None, Some("[]")),
            "json_valid(details)",
        ),
        (
            "a receipt twice",
            receipt("r-2", &digest, "accepted", None, None),
            "UNIQUE constraint failed: fact_receipts.device_id, fact_receipts.record_id",
        ),
        (
            "a receipt of nobody",
            receipt("r-9", &digest, "accepted", None, None).replace(d, "nobody"),
            "FOREIGN KEY constraint failed",
        ),
    ] {
        refused_by(&admin, what, &sql, fragment).await;
    }

    // scans
    #[allow(clippy::too_many_arguments)]
    let scan = |record: &str,
                verdict: &str,
                source: Option<&str>,
                raw_kind: &str,
                raw_length: i64,
                hash: Option<&str>,
                serial: Option<&str>,
                box_id: Option<&str>| {
        let gtin = hash.map(|_| "04600682000013");
        let canonical = hash.map(|_| "0104600682000013215x");
        format!(
            "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, duplicate_source, \
             raw_kind, raw_length, code_hash, gtin14, serial, canonical, box_id, operator_id, \
             scanned_at, received_at) VALUES ('{record}', '{record}', '{d}', '{s}', '{verdict}', \
             {}, '{raw_kind}', {raw_length}, {}, {}, {}, {}, {}, NULL, '{at}', '{at}')",
            lit(source),
            lit(hash),
            lit(gtin),
            lit(serial),
            lit(canonical),
            lit(box_id)
        )
    };
    let hash = "a".repeat(64);
    let b1_ref = b1.as_str();
    for (what, sql) in [
        (
            "an invalid scan",
            scan("s-1", "invalid", None, "unknown", 5, None, None, None),
        ),
        (
            "a duplicate",
            scan(
                "s-2",
                "duplicate",
                Some("host"),
                "km",
                38,
                Some(&hash),
                Some("x"),
                None,
            ),
        ),
        (
            "a wrong GTIN",
            scan(
                "s-3",
                "wrong_gtin",
                None,
                "km",
                38,
                Some(&hash),
                Some("x"),
                None,
            ),
        ),
        (
            "an accepted scan",
            scan(
                "s-4",
                "ok",
                None,
                "km",
                38,
                Some(&hash),
                Some("x"),
                Some(b1_ref),
            ),
        ),
    ] {
        accepted_by_schema(&admin, what, &sql).await;
    }
    for (what, sql, fragment) in [
        (
            "an unknown verdict",
            scan("s-5", "maybe", None, "km", 1, Some(&hash), Some("x"), None),
            "verdict IN",
        ),
        (
            "an unknown duplicate source",
            scan(
                "s-6",
                "duplicate",
                Some("cloud"),
                "km",
                1,
                Some(&hash),
                Some("x"),
                None,
            ),
            "duplicate_source IN",
        ),
        (
            "an unknown raw kind",
            scan("s-7", "invalid", None, "qr", 1, None, None, None),
            "raw_kind IN",
        ),
        (
            "a negative length",
            scan("s-8", "invalid", None, "unknown", -1, None, None, None),
            "raw_length >= 0",
        ),
        (
            "an invalid scan with a code",
            scan(
                "s-9",
                "invalid",
                None,
                "unknown",
                1,
                Some(&hash),
                Some("x"),
                None,
            ),
            "(verdict = 'invalid') = (code_hash IS NULL)",
        ),
        (
            "a wrong GTIN with no code",
            scan("s-10", "wrong_gtin", None, "km", 1, None, None, None),
            "(verdict = 'invalid') = (code_hash IS NULL)",
        ),
        (
            "an accepted scan with no box",
            scan("s-11", "ok", None, "km", 1, Some(&hash), Some("x"), None),
            "(verdict = 'ok') = (box_id IS NOT NULL)",
        ),
        (
            "a duplicate in a box",
            scan(
                "s-12",
                "duplicate",
                Some("host"),
                "km",
                1,
                Some(&hash),
                Some("x"),
                Some(b1_ref),
            ),
            "(verdict = 'ok') = (box_id IS NOT NULL)",
        ),
        (
            "a duplicate with no finder",
            scan(
                "s-13",
                "duplicate",
                None,
                "km",
                1,
                Some(&hash),
                Some("x"),
                None,
            ),
            "(verdict = 'duplicate') = (duplicate_source IS NOT NULL)",
        ),
        (
            "a finder of something else than a duplicate",
            scan(
                "s-14",
                "wrong_gtin",
                Some("local"),
                "km",
                1,
                Some(&hash),
                Some("x"),
                None,
            ),
            "(verdict = 'duplicate') = (duplicate_source IS NOT NULL)",
        ),
        (
            "an invalid scan that looked like a code",
            scan("s-15", "invalid", None, "km", 1, None, None, None),
            "(verdict = 'invalid') = (raw_kind <> 'km')",
        ),
        (
            "a code that looked like something else",
            scan(
                "s-16",
                "wrong_gtin",
                None,
                "gtin",
                1,
                Some(&hash),
                Some("x"),
                None,
            ),
            "(verdict = 'invalid') = (raw_kind <> 'km')",
        ),
        (
            "a code with no serial",
            scan("s-17", "wrong_gtin", None, "km", 1, Some(&hash), None, None),
            "(code_hash IS NULL) = (gtin14 IS NULL)",
        ),
        (
            "a code with no canonical text",
            scan(
                "s-17b",
                "wrong_gtin",
                None,
                "km",
                1,
                Some(&hash),
                Some("x"),
                None,
            )
            .replace("'0104600682000013215x'", "NULL"),
            "(code_hash IS NULL) = (gtin14 IS NULL)",
        ),
        (
            "a code with no GTIN",
            scan(
                "s-17c",
                "wrong_gtin",
                None,
                "km",
                1,
                Some(&hash),
                Some("x"),
                None,
            )
            .replace("'04600682000013'", "NULL"),
            "(code_hash IS NULL) = (gtin14 IS NULL)",
        ),
        (
            "a short code hash",
            scan(
                "s-18",
                "wrong_gtin",
                None,
                "km",
                1,
                Some(&"a".repeat(63)),
                Some("x"),
                None,
            ),
            "length(code_hash) = 64",
        ),
        (
            "a box that is not there",
            scan(
                "s-19",
                "ok",
                None,
                "km",
                1,
                Some(&hash),
                Some("x"),
                Some("ghost"),
            ),
            "FOREIGN KEY constraint failed",
        ),
        (
            "a record twice",
            scan("s-1", "invalid", None, "unknown", 5, None, None, None)
                .replace("VALUES ('s-1'", "VALUES ('s-20'"),
            "UNIQUE constraint failed: scans.device_id, scans.record_id",
        ),
    ] {
        refused_by(&admin, what, &sql, fragment).await;
    }

    // box_items: a code is live in a box once.
    let item = |scan: &str,
                box_id: &str,
                code_hash: &str,
                removed: Option<&str>,
                displaced: Option<&str>| {
        format!(
            "INSERT INTO box_items (scan_id, box_id, code_hash, added_at, removed_at, displaced_at) \
             VALUES ('{scan}', '{box_id}', '{code_hash}', '{at}', {}, {})",
            lit(removed),
            lit(displaced)
        )
    };
    let first_hash = code_hash(1);
    refused_by(
        &admin,
        "a code live in a box twice",
        &item("s-4", &b1, &first_hash, None, None),
        "UNIQUE constraint failed: box_items.box_id, box_items.code_hash",
    )
    .await;
    accepted_by_schema(
        &admin,
        "a removed item of the same code",
        &item("s-4", &b1, &first_hash, Some(&at), None),
    )
    .await;
    accepted_by_schema(
        &admin,
        "a displaced item of the same code",
        &item("s-3", &b1, &first_hash, None, Some(&at)),
    )
    .await;

    // code_owners: a code, and a scan, owns once.
    let owner = |hash: &str, scan: &str, box_id: &str| {
        format!(
            "INSERT INTO code_owners (code_hash, scan_id, shift_id, device_id, box_id, scanned_at) \
             VALUES ('{hash}', '{scan}', '{s}', '{d}', '{box_id}', '{at}')"
        )
    };
    for (what, sql, fragment) in [
        (
            "a code owned twice",
            owner(&first_hash, "s-4", &b1),
            "UNIQUE constraint failed: code_owners.code_hash",
        ),
        (
            "a scan that owns two codes",
            owner(&"e".repeat(64), &scan_id, &b1),
            "UNIQUE constraint failed: code_owners.scan_id",
        ),
        (
            "a code in a box that is not there",
            owner(&"e".repeat(64), "s-4", "ghost"),
            "FOREIGN KEY constraint failed",
        ),
    ] {
        refused_by(&admin, what, &sql, fragment).await;
    }

    // code_conflicts: two scans.
    refused_by(
        &admin,
        "a scan in conflict with itself",
        &format!(
            "INSERT INTO code_conflicts (id, code_hash, winner_scan_id, loser_scan_id, detected_at) \
             VALUES ('c-1', '{first_hash}', 's-4', 's-4', '{at}')"
        ),
        "winner_scan_id <> loser_scan_id",
    )
    .await;

    // boxes: a closed box is closed whole; an open one has nothing of it.
    let (status, block) = admin
        .app
        .send(support::app::json(
            with_device(request("POST", "/v1/device/sscc/blocks"), &floor.key),
            json!({
                "requestId": "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a",
                "issuerPrefix": "460068200", "extension": 0
            }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{block}");
    let block = block["id"].as_str().unwrap();
    let close = |box_id: &str,
                 sscc: Option<&str>,
                 block: Option<&str>,
                 serial: Option<i64>,
                 matches: Option<i64>,
                 disassembled: Option<&str>,
                 closed: bool| {
        format!(
            "UPDATE boxes SET closed_at = {}, sscc = {}, block_id = {}, serial = {}, \
             digest_matches = {}, disassembled_at = {} WHERE id = '{box_id}'",
            lit(closed.then_some(at.as_str())),
            lit(sscc),
            lit(block),
            serial.map_or_else(|| "NULL".to_owned(), |n| n.to_string()),
            matches.map_or_else(|| "NULL".to_owned(), |n| n.to_string()),
            lit(disassembled)
        )
    };
    let sscc = Some("046006820000015008");
    for (what, sql, fragment) in [
        (
            "a closed box with no SSCC",
            close(&b1, None, Some(block), Some(1500), Some(1), None, true),
            "(closed_at IS NULL) = (sscc IS NULL)",
        ),
        (
            "a closed box with no block",
            close(&b1, sscc, None, Some(1500), Some(1), None, true),
            "(closed_at IS NULL) = (block_id IS NULL)",
        ),
        (
            "a closed box with no serial",
            close(&b1, sscc, Some(block), None, Some(1), None, true),
            "(closed_at IS NULL) = (serial IS NULL)",
        ),
        (
            "a closed box that does not say whether its digest matched",
            close(&b1, sscc, Some(block), Some(1500), None, None, true),
            "(closed_at IS NULL) = (digest_matches IS NULL)",
        ),
        (
            "a digest that matched 2",
            close(&b1, sscc, Some(block), Some(1500), Some(2), None, true),
            "digest_matches IN (0, 1)",
        ),
        (
            "an open box with an SSCC",
            close(&b1, sscc, None, None, None, None, false),
            "(closed_at IS NULL) = (sscc IS NULL)",
        ),
        (
            "an open box taken apart",
            close(&b1, None, None, None, None, Some(&at), false),
            "disassembled_at IS NULL OR closed_at IS NOT NULL",
        ),
        (
            "a block that is not there",
            close(&b1, sscc, Some("ghost"), Some(1500), Some(1), None, true),
            "FOREIGN KEY constraint failed",
        ),
    ] {
        refused_by(&admin, what, &sql, fragment).await;
    }
    accepted_by_schema(
        &admin,
        "a closed box",
        &close(&b1, sscc, Some(block), Some(1500), Some(1), None, true),
    )
    .await;
    refused_by(
        &admin,
        "an SSCC twice",
        &close(&b2, sscc, Some(block), Some(1501), Some(0), None, true),
        "UNIQUE constraint failed: boxes.sscc",
    )
    .await;
    accepted_by_schema(
        &admin,
        "a closed box taken apart",
        &close(&b1, sscc, Some(block), Some(1500), Some(1), Some(&at), true),
    )
    .await;

    // box_exceptions: the fields of each kind, as the cloud's check.
    let exception = |id: &str,
                     kind: &str,
                     hash: Option<&str>,
                     target: Option<&str>,
                     reason: Option<&str>,
                     text: Option<&str>| {
        format!(
            "INSERT INTO box_exceptions (id, record_id, kind, box_id, code_hash, \
             target_scanned_at, reason_code, reason_text, shift_id, device_id, operator_id, \
             occurred_at, received_at) VALUES ('{id}', '{id}', '{kind}', '{b1}', {}, {}, {}, {}, \
             '{s}', '{d}', NULL, '{at}', '{at}')",
            lit(hash),
            lit(target),
            lit(reason),
            lit(text)
        )
    };
    let hash_text = Some(first_hash.as_str());
    let target = Some("2026-10-08T06:00:01.000Z");
    for (what, sql) in [
        (
            "an undo",
            exception("e-1", "undo", hash_text, target, None, None),
        ),
        ("a clear", exception("e-2", "clear", None, None, None, None)),
        (
            "a reprint",
            exception("e-3", "reprint", None, None, Some("wrong_label"), None),
        ),
        (
            "a reprint for another reason",
            exception(
                "e-4",
                "reprint",
                None,
                None,
                Some("other"),
                Some("a smudge"),
            ),
        ),
        (
            "a disassembly",
            exception(
                "e-5",
                "disassemble",
                None,
                None,
                Some("wrong_product"),
                None,
            ),
        ),
    ] {
        accepted_by_schema(&admin, what, &sql).await;
    }
    for (what, sql, fragment) in [
        (
            "an unknown kind",
            exception("e-6", "teleport", None, None, None, None),
            "kind IN ('undo', 'clear', 'reprint', 'disassemble')",
        ),
        (
            "an undo without a code",
            exception("e-7", "undo", None, target, None, None),
            "kind = 'undo' AND code_hash IS NOT NULL",
        ),
        (
            "an undo without its scan",
            exception("e-8", "undo", hash_text, None, None, None),
            "kind = 'undo' AND code_hash IS NOT NULL",
        ),
        (
            "an undo with a reason",
            exception("e-9", "undo", hash_text, target, Some("other"), None),
            "kind = 'undo' AND code_hash IS NOT NULL",
        ),
        (
            "a clear with a code",
            exception("e-10", "clear", hash_text, None, None, None),
            "kind = 'undo' AND code_hash IS NOT NULL",
        ),
        (
            "a clear with a scan",
            exception("e-10b", "clear", None, target, None, None),
            "kind = 'undo' AND code_hash IS NOT NULL",
        ),
        (
            "a clear with a reason",
            exception("e-11", "clear", None, None, Some("other"), None),
            "kind = 'undo' AND code_hash IS NOT NULL",
        ),
        (
            "a reprint without a reason",
            exception("e-12", "reprint", None, None, None, None),
            "kind = 'undo' AND code_hash IS NOT NULL",
        ),
        (
            "a reprint with a code",
            exception("e-13", "reprint", hash_text, None, Some("other"), None),
            "kind = 'undo' AND code_hash IS NOT NULL",
        ),
        (
            "a disassembly with a scan",
            exception("e-14", "disassemble", None, target, Some("other"), None),
            "kind = 'undo' AND code_hash IS NOT NULL",
        ),
        (
            "a text for a reason that needs none",
            exception(
                "e-15",
                "reprint",
                None,
                None,
                Some("wrong_label"),
                Some("text"),
            ),
            "reason_text IS NULL OR reason_code IS 'other'",
        ),
        (
            "an exception twice",
            exception("e-3", "reprint", None, None, Some("wrong_label"), None)
                .replace("VALUES ('e-3'", "VALUES ('e-16'"),
            "UNIQUE constraint failed: box_exceptions.device_id, box_exceptions.record_id",
        ),
        (
            "an exception of a box that is not there",
            exception("e-17", "clear", None, None, None, None)
                .replace(&format!("'{b1}'"), "'ghost'"),
            "FOREIGN KEY constraint failed",
        ),
    ] {
        refused_by(&admin, what, &sql, fragment).await;
    }

    // shift_close_events: a close and how it was taken.
    let close_event = |id: &str, actual: i64, boxes: i64, outcome: &str| {
        format!(
            "INSERT INTO shift_close_events (id, record_id, shift_id, device_id, operator_id, \
             planned_qty_snapshot, actual_qty, closed_box_count, reason_code, closed_at, outcome, \
             received_at) VALUES ('{id}', '{id}', '{s}', '{d}', NULL, NULL, {actual}, {boxes}, \
             NULL, '{at}', '{outcome}', '{at}')"
        )
    };
    accepted_by_schema(&admin, "a close", &close_event("x-1", 0, 0, "accepted")).await;
    accepted_by_schema(
        &admin,
        "a close of a closed shift",
        &close_event("x-2", 5, 1, "already_closed"),
    )
    .await;
    for (what, sql, fragment) in [
        (
            "an unknown outcome",
            close_event("x-3", 1, 1, "maybe"),
            "outcome IN",
        ),
        (
            "a negative quantity",
            close_event("x-4", -1, 1, "accepted"),
            "actual_qty >= 0",
        ),
        (
            "a negative count of boxes",
            close_event("x-5", 1, -1, "accepted"),
            "closed_box_count >= 0",
        ),
        (
            "a close twice",
            close_event("x-1", 1, 1, "accepted").replace("VALUES ('x-1'", "VALUES ('x-6'"),
            "UNIQUE constraint failed: shift_close_events.device_id, shift_close_events.record_id",
        ),
    ] {
        refused_by(&admin, what, &sql, fragment).await;
    }
}

/// Scans of codes into boxes: `(code, box)` pairs, each its own record
/// (`record_id(code)`) one second apart.
async fn scan_into(admin: &Admin, floor: &Floor, pairs: &[(u32, u32)]) {
    let scans: Vec<Value> = pairs
        .iter()
        .map(|(n, box_n)| {
            fact(
                &record_id(*n),
                "scan",
                &floor.shift,
                ok_scan(*n, &box_id(*box_n), &instant(*n, 0)),
            )
        })
        .collect();
    let answered = receipts(&admin.app, &floor.key, &scans).await;
    assert!(
        answered
            .iter()
            .all(|receipt| receipt["outcome"] == "accepted"),
        "{answered:?}"
    );
}

/// A `box_closed` record `n` of `data` in the floor's shift.
fn close_in(floor: &Floor, n: u32, data: Value) -> Value {
    fact(&record_id(n), "box_closed", &floor.shift, data)
}

const SECOND_REQUEST: &str = "8d7c6b5a-4e3f-4a2b-9c1d-0e9f8a7b6c5d";

#[tokio::test]
async fn a_serial_must_lie_in_the_block_the_record_names_and_in_a_box_block_of_the_shifts_prefix() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    // Two live blocks of one station: 1500–3499 and 3500–5499.
    let first = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let second = issue_block(&admin.app, &floor.key, SECOND_REQUEST).await;
    assert_eq!(
        (first["fromSerial"].clone(), second["fromSerial"].clone()),
        (json!(1500), json!(3500))
    );
    // A pallet block of the same station (the host does not issue them yet)
    // that covers 5500–5999: no box takes its serials.
    sqlx::query(
        "INSERT INTO sscc_blocks (id, issuer_prefix, extension, device_id, request_id, \
         from_serial, to_serial, issued_at) VALUES (?, '460068200', 1, ?, ?, 5500, 5999, ?)",
    )
    .bind("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")
    .bind(&floor.station)
    .bind("1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e")
    .bind(admin.app.state.timestamp())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    let pallets = json!({ "id": "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" });
    scan_into(&admin, &floor, &[(1, 1), (2, 2), (3, 3)]).await;
    let on = |box_n: u32, block: &Value, serial: u64| {
        box_closed(
            &box_id(box_n),
            block,
            serial,
            &[box_n],
            &instant(box_n, 0),
            &instant(40, 0),
        )
    };
    // A serial of the other live block, the block's own one, and a pallet
    // block's serial are all refused.
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[
                close_in(&floor, 10, on(1, &second, 1500)),
                close_in(&floor, 11, on(1, &first, 3500)),
                close_in(&floor, 12, on(1, &pallets, 5500)),
            ]
        )
        .await,
        vec![
            rejected(Some(&record_id(10)), "sscc_not_issued", None),
            rejected(Some(&record_id(11)), "sscc_not_issued", None),
            rejected(Some(&record_id(12)), "sscc_not_issued", None),
        ]
    );
    assert_eq!(box_row(&admin, &box_id(1)).await[1], Value::Null);
    // Each block is used up to its own highest serial, and only by the
    // close that named it.
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[
                close_in(&floor, 13, on(1, &second, 3500)),
                close_in(&floor, 14, on(2, &first, 3499)),
            ]
        )
        .await,
        vec![accepted(&record_id(13)), accepted(&record_id(14))]
    );
    assert_eq!(consumed_through(&admin, &first).await, Some(3499));
    assert_eq!(consumed_through(&admin, &second).await, Some(3500));
    assert_eq!(consumed_through(&admin, &pallets).await, None);
    // The shift's snapshot froze another prefix than the block was issued
    // for: an SSCC of that prefix does not fall in the block.
    sqlx::query("UPDATE shifts SET snapshot = json_set(snapshot, '$.issuerPrefix', '460123400')")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let mut elsewhere = on(3, &first, 1501);
    elsewhere["sscc"] = json!(sscc_under("460123400", 1501));
    assert_eq!(
        receipts(&admin.app, &floor.key, &[close_in(&floor, 15, elsewhere)]).await,
        vec![rejected(Some(&record_id(15)), "sscc_not_issued", None)]
    );
    assert_eq!(box_row(&admin, &box_id(3)).await[1], Value::Null);
    assert_eq!(consumed_through(&admin, &first).await, Some(3499));
}

#[tokio::test]
async fn every_field_of_a_close_is_checked_before_anything_is_written() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    scan_into(&admin, &floor, &[(1, 1)]).await;
    let data = |change: &dyn Fn(&mut Value)| {
        let mut data = box_closed(
            &box_id(1),
            &block,
            1500,
            &[1],
            &instant(1, 0),
            &instant(30, 0),
        );
        change(&mut data);
        data
    };
    let cases: Vec<(&str, Value)> = vec![
        ("data.boxId", data(&|d| d["boxId"] = json!("box"))),
        (
            "data.sscc",
            data(&|d| d["sscc"] = json!(format!("{}0", sscc(1500)))),
        ),
        (
            "data.openedAt",
            data(&|d| d["openedAt"] = json!("2026-10-08T06:00:01.000+00:00")),
        ),
        (
            "data.closedAt",
            data(&|d| d["closedAt"] = json!("2026-10-08T06:00:30Z")),
        ),
        (
            "data.membershipDigest",
            data(&|d| d["membershipDigest"] = json!(members_digest(&[1]).to_uppercase())),
        ),
        // Too large for the database's integer: never read as a serial.
        (
            "data.serial",
            data(&|d| d["serial"] = json!(9_223_372_036_854_775_808_u64)),
        ),
        // Not the shape of the fact at all.
        ("data", data(&|d| d["extra"] = json!(1))),
        ("data", data(&|d| d["itemCount"] = json!(4_294_967_296_u64))),
        ("data", data(&|d| d["itemCount"] = json!(-1))),
        ("data", data(&|d| d["serial"] = json!(1500.5))),
        (
            "data",
            data(&|d| {
                d.as_object_mut()
                    .unwrap()
                    .remove("serial")
                    .map(drop)
                    .unwrap()
            }),
        ),
        ("data", data(&|d| d["blockId"] = Value::Null)),
    ];
    let batch: Vec<Value> = cases
        .iter()
        .enumerate()
        .map(|(n, (_, data))| close_in(&floor, 10 + n as u32, data.clone()))
        .collect();
    let expected: Vec<Value> = cases
        .iter()
        .enumerate()
        .map(|(n, (field, _))| {
            rejected(
                Some(&record_id(10 + n as u32)),
                "invalid_record",
                Some(field),
            )
        })
        .collect();
    assert_eq!(receipts(&admin.app, &floor.key, &batch).await, expected);
    assert_eq!(box_row(&admin, &box_id(1)).await[1], Value::Null);
    assert_eq!(consumed_through(&admin, &block).await, None);
}

#[tokio::test]
async fn the_host_never_counts_the_check_digit_of_an_sscc() {
    // Plan 2a2 decision 13: the check digit is a marking rule, the domain's
    // `buildSscc` writes it; the host checks the form, the prefix and the
    // serial. A change of that decision must be deliberate, so it is pinned.
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    scan_into(&admin, &floor, &[(1, 1)]).await;
    let right = sscc(1500);
    let last = right.as_bytes()[17] - b'0';
    let wrong = format!("{}{}", &right[..17], (last + 1) % 10);
    let mut data = box_closed(
        &box_id(1),
        &block,
        1500,
        &[1],
        &instant(1, 0),
        &instant(30, 0),
    );
    data["sscc"] = json!(wrong);
    assert_eq!(
        receipts(&admin.app, &floor.key, &[close_in(&floor, 10, data)]).await,
        vec![accepted(&record_id(10))]
    );
    assert_eq!(box_row(&admin, &box_id(1)).await[2], json!(wrong));
}

#[tokio::test]
async fn one_sscc_closes_one_box_whichever_arrives_first_and_the_same_close_again_changes_nothing()
{
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    scan_into(&admin, &floor, &[(1, 1), (2, 2), (3, 3), (4, 4)]).await;
    let on = |box_n: u32, serial: u64| {
        box_closed(
            &box_id(box_n),
            &block,
            serial,
            &[box_n],
            &instant(box_n, 0),
            &instant(40, 0),
        )
    };
    // One SSCC for two boxes in one batch: the first one in the batch has
    // it, in either order.
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[
                close_in(&floor, 10, on(1, 1500)),
                close_in(&floor, 11, on(2, 1500)),
                close_in(&floor, 12, on(4, 1502)),
                close_in(&floor, 13, on(3, 1502)),
            ]
        )
        .await,
        vec![
            accepted(&record_id(10)),
            rejected(Some(&record_id(11)), "sscc_taken", None),
            accepted(&record_id(12)),
            rejected(Some(&record_id(13)), "sscc_taken", None),
        ]
    );
    // A receipt keeps the kind of the record, a refused one's too.
    for n in [10, 11] {
        let kind: Option<String> =
            sqlx::query_scalar("SELECT kind FROM fact_receipts WHERE record_id = ?")
                .bind(record_id(n))
                .fetch_one(&admin.app.state.pool)
                .await
                .unwrap();
        assert_eq!(kind.as_deref(), Some("box_closed"), "record {n}");
    }
    for (box_n, closes) in [(1, true), (2, false), (4, true), (3, false)] {
        let closed_at = box_row(&admin, &box_id(box_n)).await[1].clone();
        assert_eq!(closed_at != Value::Null, closes, "box {box_n}");
    }
    assert_eq!(consumed_through(&admin, &block).await, Some(1502));
    // A lower serial closing later does not take `consumed_through` back.
    assert_eq!(
        receipts(&admin.app, &floor.key, &[close_in(&floor, 14, on(2, 1501))]).await,
        vec![accepted(&record_id(14))]
    );
    assert_eq!(consumed_through(&admin, &block).await, Some(1502));
    // The same record again: its receipt, no second write.
    let kept = fact_rows(&admin.app).await;
    let before = box_row(&admin, &box_id(1)).await;
    assert_eq!(
        receipts(&admin.app, &floor.key, &[close_in(&floor, 10, on(1, 1500))]).await,
        vec![accepted(&record_id(10))]
    );
    assert_eq!(fact_rows(&admin.app).await, kept);
    // The same close under a new id, with other times, count and digest
    // (what a station that lost the receipt would send): accepted, and the
    // box keeps what it was closed with.
    let mut again = on(1, 1500);
    again["openedAt"] = json!(instant(0, 1));
    again["closedAt"] = json!(instant(50, 0));
    again["itemCount"] = json!(7);
    again["membershipDigest"] = json!(members_digest(&[1, 2]));
    assert_eq!(
        receipts(&admin.app, &floor.key, &[close_in(&floor, 15, again)]).await,
        vec![accepted(&record_id(15))]
    );
    assert_eq!(box_row(&admin, &box_id(1)).await, before);
    assert_eq!(consumed_through(&admin, &block).await, Some(1502));
}

#[tokio::test]
async fn a_close_of_a_box_of_another_device_or_another_shift_is_a_box_unknown() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    // Box 9 is the colleague's; box 8 is the floor's own device's but in the
    // colleague's shift.
    receipts(
        &admin.app,
        &colleague.key,
        &[fact(
            &record_id(9),
            "scan",
            &colleague.shift,
            ok_scan(9, &box_id(9), &instant(9, 0)),
        )],
    )
    .await;
    sqlx::query(
        "INSERT INTO boxes (id, shift_id, device_id, opened_at, received_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(box_id(8))
    .bind(&colleague.shift)
    .bind(&floor.station)
    .bind(instant(8, 0))
    .bind(admin.app.state.timestamp())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    let data = |box_n: u32| {
        box_closed(
            &box_id(box_n),
            &block,
            1500,
            &[box_n],
            &instant(box_n, 0),
            &instant(40, 0),
        )
    };
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[close_in(&floor, 10, data(9)), close_in(&floor, 11, data(8))]
        )
        .await,
        vec![
            rejected(Some(&record_id(10)), "box_unknown", None),
            rejected(Some(&record_id(11)), "box_unknown", None),
        ]
    );
    for box_n in [8, 9] {
        assert_eq!(box_row(&admin, &box_id(box_n)).await[1], Value::Null);
    }
    assert_eq!(consumed_through(&admin, &block).await, None);
}

#[tokio::test]
async fn a_close_compares_the_boxs_live_items_and_keeps_what_the_station_reported() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    scan_into(
        &admin,
        &floor,
        &[(1, 1), (2, 1), (3, 1), (4, 2), (5, 2), (7, 3)],
    )
    .await;
    // An exception took code 3 out of box 1, code 5 out of box 2 and code 7
    // out of box 3.
    for n in [3, 5, 7] {
        sqlx::query("UPDATE box_items SET removed_at = ? WHERE code_hash = ?")
            .bind(admin.app.state.timestamp())
            .bind(code_hash(n))
            .execute(&admin.app.state.pool)
            .await
            .unwrap();
    }
    // The members are given in any order; the digest does not depend on it.
    let mut reordered = box_closed(
        &box_id(1),
        &block,
        1500,
        &[2, 1],
        &instant(1, 0),
        &instant(40, 0),
    );
    // The count is the station's, whatever the digest says.
    reordered["itemCount"] = json!(9);
    let stale = box_closed(
        &box_id(2),
        &block,
        1501,
        &[4, 5],
        &instant(4, 0),
        &instant(41, 0),
    );
    let emptied = box_closed(
        &box_id(3),
        &block,
        1502,
        &[7],
        &instant(7, 0),
        &instant(42, 0),
    );
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[
                close_in(&floor, 10, reordered),
                close_in(&floor, 11, stale),
                close_in(&floor, 12, emptied)
            ]
        )
        .await,
        vec![
            accepted(&record_id(10)),
            accepted(&record_id(11)),
            accepted(&record_id(12))
        ]
    );
    let block_id = block["id"].clone();
    assert_eq!(
        box_row(&admin, &box_id(1)).await,
        json!([
            instant(1, 0),
            instant(40, 0),
            sscc(1500),
            block_id,
            1500,
            9,
            members_digest(&[1, 2]),
            true,
            null
        ])
    );
    assert_eq!(box_row(&admin, &box_id(2)).await[7], json!(false));
    assert_eq!(box_row(&admin, &box_id(2)).await[5], json!(2));
    assert_eq!(box_row(&admin, &box_id(3)).await[7], json!(false));
}

#[tokio::test]
async fn a_close_is_written_with_its_batch_or_not_at_all() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    scan_into(&admin, &floor, &[(1, 1), (2, 2)]).await;
    let on = |box_n: u32, serial: u64| {
        close_in(
            &floor,
            10 + box_n,
            box_closed(
                &box_id(box_n),
                &block,
                serial,
                &[box_n],
                &instant(box_n, 0),
                &instant(40, 0),
            ),
        )
    };
    // The block row refuses its update after the box row has been written.
    sqlx::query(
        "CREATE TRIGGER break_the_block BEFORE UPDATE ON sscc_blocks WHEN NEW.consumed_through = 1501 \
         BEGIN SELECT RAISE(ABORT, 'broken'); END",
    )
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    let batch = vec![on(1, 1500), on(2, 1501)];
    let empty = fact_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let (status, failed) = send_facts(&admin.app, &floor.key, &batch).await;
    assert_eq!(
        (status, failed["error"]["code"].clone()),
        (StatusCode::INTERNAL_SERVER_ERROR, json!("internal"))
    );
    assert_eq!(fact_rows(&admin.app).await, empty);
    assert_eq!(host_revision(&admin.app).await, revision);
    for box_n in [1, 2] {
        assert_eq!(box_row(&admin, &box_id(box_n)).await[1], Value::Null);
    }
    assert_eq!(consumed_through(&admin, &block).await, None);
    sqlx::query("DROP TRIGGER break_the_block")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![accepted(&record_id(11)), accepted(&record_id(12))]
    );
    assert_eq!(consumed_through(&admin, &block).await, Some(1501));
}
