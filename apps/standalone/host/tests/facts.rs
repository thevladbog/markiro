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
    accepted, admin, audit_rows, audit_trail, box_closed, box_exception, box_id, close_from_office,
    code, code_hash, fact, fact_rows, host_revision, instant, issue_block, members_digest, ok_scan,
    open_floor, pair_device, plan_shift, receipts, record_id, rejected, request, send_facts,
    shift_body, shift_closed, shift_setup, sscc, sscc_under, with_device, Admin, Floor,
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

/// The registry's `(code hash, owner's record)` pairs, sorted.
async fn owned(admin: &Admin) -> Vec<(String, String)> {
    sorted(
        owners(admin)
            .await
            .iter()
            .map(|row| {
                (
                    row[0].as_str().unwrap().to_owned(),
                    row[1].as_str().unwrap().to_owned(),
                )
            })
            .collect(),
    )
}

fn sorted(mut pairs: Vec<(String, String)>) -> Vec<(String, String)> {
    pairs.sort();
    pairs
}

/// What `GET /v1/device/codes/{hash}` says about code `n`.
async fn code_status(admin: &Admin, key: &str, n: u32) -> Value {
    admin
        .app
        .send(support::app::empty(with_device(
            request("GET", &format!("/v1/device/codes/{}", code_hash(n))),
            key,
        )))
        .await
        .1["status"]
        .clone()
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
    // An office PC sends no facts at all: refused by its kind (plan ТСД-Х, task Х1) before the
    // batch is read, so no receipt is kept.
    let (status, refused) = send_facts(&admin.app, &office_pc, &[scan(4, &floor.shift)]).await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
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
    // Plan КНФ: each row says how its loser lost — taken from its box by an
    // earlier scan, or later than the owner.
    let kinds: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT l.record_id, w.record_id, c.kind FROM code_conflicts c \
         JOIN scans l ON l.id = c.loser_scan_id JOIN scans w ON w.id = c.winner_scan_id \
         ORDER BY l.record_id, w.record_id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        kinds,
        vec![
            (record_id(1), record_id(2), "displaced".into()),
            (record_id(2), record_id(6), "displaced".into()),
            (record_id(3), record_id(2), "late".into()),
            (record_id(4), record_id(2), "late".into()),
            (record_id(5), record_id(2), "late".into()),
        ]
    );
}

/// The registry compares the scans' instants to the millisecond, not to the
/// second: two scans of one code within one second still have an earlier.
#[tokio::test]
async fn the_registry_orders_scans_within_one_second_by_the_millisecond() {
    let (admin, floor) = floor().await;
    let scan = |n: u32, box_n: u32, milli: u32| {
        fact(
            &record_id(n),
            "scan",
            &floor.shift,
            ok_scan(7, &box_id(box_n), &instant(60, milli)),
        )
    };
    let owner_at = |n: u32, box_n: u32, milli: u32| {
        json!([
            code_hash(7),
            record_id(n),
            floor.shift,
            floor.station,
            box_id(box_n),
            instant(60, milli)
        ])
    };
    assert_eq!(
        receipts(&admin.app, &floor.key, &[scan(1, 1, 500)]).await,
        vec![accepted(&record_id(1))]
    );
    // One millisecond earlier, in the same second, takes the code.
    assert_eq!(
        receipts(&admin.app, &floor.key, &[scan(2, 2, 499)]).await,
        vec![accepted(&record_id(2))]
    );
    assert_eq!(owners(&admin).await, vec![owner_at(2, 2, 499)]);
    let first = items(&admin, &box_id(1)).await;
    assert_eq!(first.len(), 1);
    assert_eq!(first[0][0], json!(record_id(1)));
    assert_ne!(first[0][4], Value::Null, "the first item left its box");
    // The scan that was first is later now, and so are one at the owner's
    // instant (a tie keeps the owner) and one a millisecond after it.
    let loses = json!({
        "winner": {
            "shiftId": floor.shift, "shiftNumber": floor.number, "deviceId": floor.station,
            "scannedAt": instant(60, 499), "sameDevice": true
        }
    });
    let conflict = |n: u32| json!({ "id": record_id(n), "outcome": "conflict", "details": loses });
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[scan(3, 1, 500), scan(4, 1, 499), scan(5, 1, 999)]
        )
        .await,
        vec![conflict(3), conflict(4), conflict(5)]
    );
    assert_eq!(owners(&admin).await, vec![owner_at(2, 2, 499)]);
    assert_eq!(items(&admin, &box_id(2)).await[0][4], Value::Null);
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
        &mut None,
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

/// A box's label checks: `(verified at, skipped at)`.
async fn label_checks(admin: &Admin, id: &str) -> (Option<String>, Option<String>) {
    sqlx::query_as("SELECT print_verified_at, print_skipped_at FROM boxes WHERE id = ?")
        .bind(id)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_label_check_marks_a_closed_box_of_its_own() {
    let (admin, floor) = floor().await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
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
            fact(
                &record_id(3),
                "box_closed",
                shift,
                box_closed(
                    &box_id(1),
                    &block,
                    1500,
                    &[1],
                    &instant(1, 0),
                    &instant(10, 0),
                ),
            ),
        ],
    )
    .await;
    let label = |n: u32, box_n: u32, outcome: &str, at: &str| {
        fact(
            &record_id(n),
            "box_label",
            shift,
            json!({ "boxId": box_id(box_n), "outcome": outcome, "at": at }),
        )
    };
    let kept = fact_rows(&admin.app).await;
    let refused = vec![
        label(10, 2, "verified", &instant(11, 0)),
        label(11, 9, "verified", &instant(11, 0)),
        label(12, 1, "printed", &instant(11, 0)),
        label(13, 1, "verified", "2026-10-08T06:00:11Z"),
        fact(
            &record_id(14),
            "box_label",
            shift,
            json!({ "boxId": "box", "outcome": "verified", "at": instant(11, 0) }),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &refused).await,
        vec![
            rejected(Some(&record_id(10)), "box_state", None),
            rejected(Some(&record_id(11)), "box_unknown", None),
            rejected(Some(&record_id(12)), "invalid_record", Some("data")),
            rejected(Some(&record_id(13)), "invalid_record", Some("data.at")),
            rejected(Some(&record_id(14)), "invalid_record", Some("data.boxId")),
        ]
    );
    assert_eq!(label_checks(&admin, &box_id(1)).await, (None, None));
    assert_eq!(label_checks(&admin, &box_id(2)).await, (None, None));
    // A skip, then (after a reprint) a check that matched.
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[
                label(20, 1, "skipped", &instant(12, 0)),
                label(21, 1, "verified", &instant(13, 0))
            ]
        )
        .await,
        vec![accepted(&record_id(20)), accepted(&record_id(21))]
    );
    assert_eq!(
        label_checks(&admin, &box_id(1)).await,
        (Some(instant(13, 0)), Some(instant(12, 0)))
    );
    let mut grown = kept.clone();
    grown["fact_receipts"] = json!(kept["fact_receipts"].as_i64().unwrap() + 7);
    assert_eq!(fact_rows(&admin.app).await, grown);
}

/// The exceptions as the host keeps them: `(record, kind, box, code, scan
/// instant, reason, words, operator, occurred)`.
async fn exception_rows(admin: &Admin) -> Vec<Value> {
    type ExceptionRow = (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
    );
    let rows: Vec<ExceptionRow> = sqlx::query_as(
        "SELECT record_id, kind, box_id, code_hash, target_scanned_at, reason_code, \
         reason_text, operator_id, occurred_at FROM box_exceptions ORDER BY record_id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|row| json!([row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8]))
        .collect()
}

#[tokio::test]
async fn an_undo_or_a_clear_takes_codes_out_of_an_open_box_and_frees_them() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let shift = floor.shift.as_str();
    let scan = |n: u32, code: u32, box_n: u32, second: u32| {
        fact(
            &record_id(n),
            "scan",
            shift,
            ok_scan(code, &box_id(box_n), &instant(second, 0)),
        )
    };
    // Codes 1–3 in box 1; code 4 there too, but the colleague scanned it
    // earlier.
    receipts(
        &admin.app,
        &colleague.key,
        &[fact(
            &record_id(90),
            "scan",
            &colleague.shift,
            ok_scan(4, &box_id(9), &instant(0, 0)),
        )],
    )
    .await;
    receipts(
        &admin.app,
        &floor.key,
        &[
            scan(1, 1, 1, 1),
            scan(2, 2, 1, 2),
            scan(3, 3, 1, 3),
            scan(4, 4, 1, 4),
        ],
    )
    .await;
    let undo = |n: u32, code: u32, second: u32| {
        let mut data = box_exception("undo", &box_id(1), &instant(second, 0));
        data["codeHash"] = json!(code_hash(code));
        data["targetScannedAt"] = json!(instant(code, 0));
        fact(&record_id(n), "box_exception", shift, data)
    };
    let mut undo_three = undo(10, 3, 20);
    undo_three["operatorId"] = json!(OPERATOR);
    assert_eq!(
        receipts(&admin.app, &floor.key, &[undo_three, undo(11, 4, 21)]).await,
        vec![accepted(&record_id(10)), accepted(&record_id(11))]
    );
    // Code 3 left the box and is free; the undo of code 4, whose scan lost
    // the code, took nothing out, but is kept.
    let check = |hash: String| {
        let app = &admin.app;
        let key = floor.key.clone();
        async move {
            app.send(support::app::empty(with_device(
                request("GET", &format!("/v1/device/codes/{hash}")),
                &key,
            )))
            .await
            .1["status"]
                .clone()
        }
    };
    assert_eq!(check(code_hash(3)).await, json!("free"));
    assert_eq!(check(code_hash(4)).await, json!("taken"));
    // The undo freed code 3 only: codes 1 and 2 keep their scans, and
    // code 4 its colleague's.
    assert_eq!(
        owned(&admin).await,
        sorted(vec![
            (code_hash(1), record_id(1)),
            (code_hash(2), record_id(2)),
            (code_hash(4), record_id(90)),
        ])
    );
    assert_eq!(
        items(&admin, &box_id(1)).await,
        vec![
            json!([record_id(1), code_hash(1), instant(1, 0), null, null]),
            json!([record_id(2), code_hash(2), instant(2, 0), null, null]),
            json!([
                record_id(3),
                code_hash(3),
                instant(3, 0),
                instant(20, 0),
                null
            ]),
        ]
    );
    // Code 3 scanned again goes back in; the box closes with its live codes.
    assert_eq!(
        receipts(&admin.app, &floor.key, &[scan(12, 3, 1, 22)]).await,
        vec![accepted(&record_id(12))]
    );
    assert_eq!(check(code_hash(3)).await, json!("taken"));
    // A clear takes every live code out of box 2 and frees them.
    receipts(
        &admin.app,
        &floor.key,
        &[scan(13, 5, 2, 23), scan(14, 6, 2, 24)],
    )
    .await;
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(15),
                "box_exception",
                shift,
                box_exception("clear", &box_id(2), &instant(25, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(15))]
    );
    assert_eq!(check(code_hash(5)).await, json!("free"));
    assert_eq!(check(code_hash(6)).await, json!("free"));
    assert_eq!(
        items(&admin, &box_id(2)).await,
        vec![
            json!([
                record_id(13),
                code_hash(5),
                instant(23, 0),
                instant(25, 0),
                null
            ]),
            json!([
                record_id(14),
                code_hash(6),
                instant(24, 0),
                instant(25, 0),
                null
            ]),
        ]
    );
    // The cleared box stays open for the next code.
    assert_eq!(
        receipts(&admin.app, &floor.key, &[scan(16, 7, 2, 26)]).await,
        vec![accepted(&record_id(16))]
    );
    assert_eq!(
        exception_rows(&admin).await,
        vec![
            json!([
                record_id(10),
                "undo",
                box_id(1),
                code_hash(3),
                instant(3, 0),
                null,
                null,
                OPERATOR,
                instant(20, 0)
            ]),
            json!([
                record_id(11),
                "undo",
                box_id(1),
                code_hash(4),
                instant(4, 0),
                null,
                null,
                null,
                instant(21, 0)
            ]),
            json!([
                record_id(15),
                "clear",
                box_id(2),
                null,
                null,
                null,
                null,
                null,
                instant(25, 0)
            ]),
        ]
    );
    // Box 1 closes with the codes it holds now: the digest of 1, 2 and 3.
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(17),
                "box_closed",
                shift,
                box_closed(
                    &box_id(1),
                    &block,
                    1500,
                    &[1, 2, 3],
                    &instant(1, 0),
                    &instant(30, 0)
                )
            )]
        )
        .await,
        vec![accepted(&record_id(17))]
    );
    assert_eq!(box_row(&admin, &box_id(1)).await[7], json!(true));
    // A closed box takes neither.
    let kept = fact_rows(&admin.app).await;
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[
                undo(18, 1, 31),
                fact(
                    &record_id(19),
                    "box_exception",
                    shift,
                    box_exception("clear", &box_id(1), &instant(32, 0))
                )
            ]
        )
        .await,
        vec![
            rejected(Some(&record_id(18)), "box_state", None),
            rejected(Some(&record_id(19)), "box_state", None)
        ]
    );
    let mut grown = kept.clone();
    grown["fact_receipts"] = json!(kept["fact_receipts"].as_i64().unwrap() + 2);
    assert_eq!(fact_rows(&admin.app).await, grown);
}

#[tokio::test]
async fn a_reprint_or_a_disassembly_needs_a_closed_box_and_a_reason_code() {
    let (admin, floor) = floor().await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
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
                ok_scan(2, &box_id(1), &instant(2, 0)),
            ),
            fact(
                &record_id(3),
                "scan",
                shift,
                ok_scan(3, &box_id(2), &instant(3, 0)),
            ),
            fact(
                &record_id(4),
                "box_closed",
                shift,
                box_closed(
                    &box_id(1),
                    &block,
                    1500,
                    &[1, 2],
                    &instant(1, 0),
                    &instant(10, 0),
                ),
            ),
        ],
    )
    .await;
    let exception = |n: u32, kind: &str, box_n: u32, fields: Value| {
        let mut data = box_exception(kind, &box_id(box_n), &instant(20 + n, 0));
        for (key, value) in fields.as_object().unwrap() {
            data[key] = value.clone();
        }
        fact(&record_id(n), "box_exception", shift, data)
    };
    let kept = fact_rows(&admin.app).await;
    let refused = vec![
        // The fields of each kind.
        exception(10, "undo", 2, json!({ "targetScannedAt": instant(3, 0) })),
        exception(11, "undo", 2, json!({ "codeHash": code_hash(3) })),
        exception(
            12,
            "undo",
            2,
            json!({
                "codeHash": code_hash(3), "targetScannedAt": instant(3, 0),
                "reasonCode": "other"
            }),
        ),
        exception(13, "clear", 2, json!({ "codeHash": code_hash(3) })),
        exception(14, "clear", 2, json!({ "targetScannedAt": instant(3, 0) })),
        exception(15, "clear", 2, json!({ "reasonText": "Неверный короб" })),
        exception(16, "reprint", 1, json!({})),
        exception(17, "reprint", 1, json!({ "reasonCode": "wrong_product" })),
        exception(18, "disassemble", 1, json!({ "reasonCode": "printer_jam" })),
        exception(
            19,
            "reprint",
            1,
            json!({ "reasonCode": "damaged_label", "reasonText": "Смята" }),
        ),
        exception(
            20,
            "reprint",
            1,
            json!({ "reasonCode": "other", "reasonText": "   " }),
        ),
        exception(
            21,
            "reprint",
            1,
            json!({ "reasonCode": "other", "reasonText": "Я".repeat(201) }),
        ),
        exception(
            22,
            "reprint",
            1,
            json!({ "reasonCode": "other", "reasonText": "Смята\tнаполовину" }),
        ),
        exception(
            23,
            "reprint",
            1,
            json!({ "reasonCode": "other", "codeHash": code_hash(1) }),
        ),
        exception(24, "teleport", 1, json!({})),
        exception(
            25,
            "reprint",
            1,
            json!({ "reasonCode": "damaged_label", "occurredAt": "now" }),
        ),
        exception(
            26,
            "undo",
            2,
            json!({ "codeHash": "C0DE", "targetScannedAt": instant(3, 0) }),
        ),
        // An open box is reprinted or taken apart by no one.
        exception(27, "reprint", 2, json!({ "reasonCode": "damaged_label" })),
        exception(
            28,
            "disassemble",
            2,
            json!({ "reasonCode": "wrong_quantity" }),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &refused).await,
        vec![
            rejected(
                Some(&record_id(10)),
                "invalid_record",
                Some("data.codeHash")
            ),
            rejected(
                Some(&record_id(11)),
                "invalid_record",
                Some("data.targetScannedAt")
            ),
            rejected(
                Some(&record_id(12)),
                "invalid_record",
                Some("data.reasonCode")
            ),
            rejected(
                Some(&record_id(13)),
                "invalid_record",
                Some("data.codeHash")
            ),
            rejected(
                Some(&record_id(14)),
                "invalid_record",
                Some("data.targetScannedAt")
            ),
            rejected(
                Some(&record_id(15)),
                "invalid_record",
                Some("data.reasonText")
            ),
            rejected(
                Some(&record_id(16)),
                "invalid_record",
                Some("data.reasonCode")
            ),
            rejected(
                Some(&record_id(17)),
                "invalid_record",
                Some("data.reasonCode")
            ),
            rejected(
                Some(&record_id(18)),
                "invalid_record",
                Some("data.reasonCode")
            ),
            rejected(
                Some(&record_id(19)),
                "invalid_record",
                Some("data.reasonText")
            ),
            rejected(
                Some(&record_id(20)),
                "invalid_record",
                Some("data.reasonText")
            ),
            rejected(
                Some(&record_id(21)),
                "invalid_record",
                Some("data.reasonText")
            ),
            rejected(
                Some(&record_id(22)),
                "invalid_record",
                Some("data.reasonText")
            ),
            rejected(
                Some(&record_id(23)),
                "invalid_record",
                Some("data.codeHash")
            ),
            rejected(Some(&record_id(24)), "invalid_record", Some("data")),
            rejected(
                Some(&record_id(25)),
                "invalid_record",
                Some("data.occurredAt")
            ),
            rejected(
                Some(&record_id(26)),
                "invalid_record",
                Some("data.codeHash")
            ),
            rejected(Some(&record_id(27)), "box_state", None),
            rejected(Some(&record_id(28)), "box_state", None),
        ]
    );
    let mut grown = kept.clone();
    grown["fact_receipts"] = json!(kept["fact_receipts"].as_i64().unwrap() + 19);
    assert_eq!(fact_rows(&admin.app).await, grown);

    // A reprint with words for `other` (trimmed, 200 characters at most),
    // then the box taken apart: its codes are free, its SSCC stays.
    let words = format!("  {}  ", "Я".repeat(200));
    let accepted_ones = vec![
        exception(30, "reprint", 1, json!({ "reasonCode": "damaged_label" })),
        exception(
            31,
            "reprint",
            1,
            json!({ "reasonCode": "other", "reasonText": words }),
        ),
        exception(
            32,
            "disassemble",
            1,
            json!({ "reasonCode": "wrong_quantity" }),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &accepted_ones).await,
        vec![
            accepted(&record_id(30)),
            accepted(&record_id(31)),
            accepted(&record_id(32))
        ]
    );
    let taken_apart: (Option<String>, Option<String>) =
        sqlx::query_as("SELECT disassembled_at, sscc FROM boxes WHERE id = ?")
            .bind(box_id(1))
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(taken_apart, (Some(instant(52, 0)), Some(sscc(1500))));
    assert_eq!(
        items(&admin, &box_id(1)).await,
        vec![
            json!([
                record_id(1),
                code_hash(1),
                instant(1, 0),
                instant(52, 0),
                null
            ]),
            json!([
                record_id(2),
                code_hash(2),
                instant(2, 0),
                instant(52, 0),
                null
            ]),
        ]
    );
    assert_eq!(
        owners(&admin).await,
        vec![json!([
            code_hash(3),
            record_id(3),
            floor.shift,
            floor.station,
            box_id(2),
            instant(3, 0)
        ])]
    );
    let rows = exception_rows(&admin).await;
    assert_eq!(
        rows[1],
        json!([
            record_id(31),
            "reprint",
            box_id(1),
            null,
            null,
            "other",
            "Я".repeat(200),
            null,
            instant(51, 0)
        ])
    );
    assert_eq!(rows.len(), 3);
    // A box taken apart is reprinted and taken apart no more; its codes go
    // into another box; its SSCC closes no other box.
    let mut reuse = box_closed(
        &box_id(2),
        &block,
        1500,
        &[3],
        &instant(3, 0),
        &instant(60, 0),
    );
    reuse["sscc"] = json!(sscc(1500));
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[
                exception(40, "reprint", 1, json!({ "reasonCode": "damaged_label" })),
                exception(
                    41,
                    "disassemble",
                    1,
                    json!({ "reasonCode": "wrong_quantity" })
                ),
                fact(
                    &record_id(42),
                    "scan",
                    shift,
                    ok_scan(1, &box_id(2), &instant(42, 0))
                ),
                fact(&record_id(43), "box_closed", shift, reuse),
            ]
        )
        .await,
        vec![
            rejected(Some(&record_id(40)), "box_state", None),
            rejected(Some(&record_id(41)), "box_state", None),
            accepted(&record_id(42)),
            rejected(Some(&record_id(43)), "sscc_taken", None),
        ]
    );
}

/// A shift's close as the host keeps it: `(status, closed at, closed by
/// kind, closed by, reason code, late data at, rev)`.
async fn shift_state(admin: &Admin, shift: &str) -> Value {
    type ShiftRow = (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        i64,
    );
    let row: ShiftRow = sqlx::query_as(
        "SELECT status, closed_at, closed_by_kind, closed_by, close_reason_code, late_data_at, \
         rev FROM shifts WHERE id = ?",
    )
    .bind(shift)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    json!([row.0, row.1, row.2, row.3, row.4, row.5, row.6])
}

/// The station closes kept: `(record, device, operator, plan, fact, boxes,
/// reason, closed at, outcome, received at)`.
async fn close_events(admin: &Admin) -> Vec<Value> {
    type CloseRow = (
        String,
        String,
        Option<String>,
        Option<i64>,
        i64,
        i64,
        Option<String>,
        String,
        String,
        String,
    );
    let rows: Vec<CloseRow> = sqlx::query_as(
        "SELECT record_id, device_id, operator_id, planned_qty_snapshot, actual_qty, \
         closed_box_count, reason_code, closed_at, outcome, received_at \
         FROM shift_close_events ORDER BY record_id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|row| json!([row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8, row.9]))
        .collect()
}

#[tokio::test]
async fn a_station_closes_its_shift_once_and_the_office_sees_it_closed() {
    let (admin, floor) = floor().await;
    let shift = floor.shift.as_str();
    receipts(
        &admin.app,
        &floor.key,
        &[fact(
            &record_id(1),
            "scan",
            shift,
            ok_scan(1, &box_id(1), &instant(1, 0)),
        )],
    )
    .await;
    admin.app.clock.advance(time::Duration::minutes(10));
    let received = admin.app.state.timestamp();
    let revision = host_revision(&admin.app).await;
    let mut wake = admin.app.state.revisions.subscribe();
    wake.borrow_and_update();
    let mut close = fact(
        &record_id(2),
        "shift_closed",
        shift,
        shift_closed(None, 1, 0, None, &instant(1800, 250)),
    );
    close["operatorId"] = json!(OPERATOR);
    assert_eq!(
        receipts(&admin.app, &floor.key, &[close]).await,
        vec![accepted(&record_id(2))]
    );
    // The shift closed at the station's instant, in whole seconds, with the
    // batch's revision; the streams woke with it.
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert!(wake.has_changed().unwrap());
    assert_eq!(*wake.borrow_and_update(), revision + 1);
    assert_eq!(
        shift_state(&admin, shift).await,
        json!([
            "closed",
            "2026-10-08T06:30:00Z",
            "device",
            floor.station,
            null,
            null,
            revision + 1
        ])
    );
    assert_eq!(
        audit_trail(&admin.app, "shift.close").await,
        vec![(
            "device".to_owned(),
            Some(floor.station.clone()),
            "shift.close".to_owned(),
            Some("shift".to_owned()),
            Some(floor.shift.clone()),
            "ok".to_owned(),
            json!({ "actualQty": 1, "plannedQty": null, "closedBoxCount": 0, "reasonCode": null })
        )]
    );
    assert_eq!(
        close_events(&admin).await,
        vec![json!([
            record_id(2),
            floor.station,
            OPERATOR,
            null,
            1,
            0,
            null,
            instant(1800, 250),
            "accepted",
            received
        ])]
    );
    let (status, office) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}"), None)
        .await;
    assert_eq!(
        (
            status,
            office["status"].clone(),
            office["closedAt"].clone(),
            office["rev"].clone()
        ),
        (
            StatusCode::OK,
            json!("closed"),
            json!("2026-10-08T06:30:00Z"),
            json!(revision + 1)
        )
    );
    // A second close (another record) finds the shift closed: accepted with
    // `alreadyClosed`, kept, and nothing else changes; the station's own
    // close is no late data.
    admin.app.clock.advance(time::Duration::minutes(1));
    let rows = audit_rows(&admin.app).await;
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(3),
                "shift_closed",
                shift,
                shift_closed(None, 1, 0, None, &instant(1900, 0))
            )]
        )
        .await,
        vec![
            json!({ "id": record_id(3), "outcome": "accepted", "details": { "alreadyClosed": true } })
        ]
    );
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(
        shift_state(&admin, shift).await,
        json!([
            "closed",
            "2026-10-08T06:30:00Z",
            "device",
            floor.station,
            null,
            null,
            revision + 1
        ])
    );
    assert_eq!(close_events(&admin).await[1][8], json!("already_closed"));
    // The station's list shows it closed; it opens no more.
    let (status, listed) = admin
        .app
        .send(support::app::empty(with_device(
            request("GET", "/v1/device/shifts"),
            &floor.key,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(listed["shifts"][0]["status"], json!("closed"));
}

#[tokio::test]
async fn a_close_names_a_reason_when_the_fact_differs_from_the_plan() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let other = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let shift = floor.shift.as_str();
    let close = |n: u32, data: Value| fact(&record_id(n), "shift_closed", shift, data);
    let at = instant(3600, 0);
    let kept = fact_rows(&admin.app).await;
    let before = shift_state(&admin, shift).await;
    let refused = vec![
        close(1, shift_closed(Some(250), 249, 20, None, &at)),
        close(2, shift_closed(Some(250), 251, 21, Some("broken"), &at)),
        close(3, shift_closed(Some(0), 0, 0, None, &at)),
        close(
            4,
            shift_closed(Some(10_000_001), 1, 0, Some("equipment_stop"), &at),
        ),
        close(
            5,
            shift_closed(
                Some(250),
                249,
                20,
                Some("equipment_stop"),
                "2026-10-08T07:00:00Z",
            ),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &refused).await,
        vec![
            rejected(
                Some(&record_id(1)),
                "invalid_record",
                Some("data.reasonCode")
            ),
            rejected(
                Some(&record_id(2)),
                "invalid_record",
                Some("data.reasonCode")
            ),
            rejected(
                Some(&record_id(3)),
                "invalid_record",
                Some("data.plannedQtySnapshot")
            ),
            rejected(
                Some(&record_id(4)),
                "invalid_record",
                Some("data.plannedQtySnapshot")
            ),
            rejected(Some(&record_id(5)), "invalid_record", Some("data.closedAt")),
        ]
    );
    assert_eq!(shift_state(&admin, shift).await, before);
    let mut grown = kept.clone();
    grown["fact_receipts"] = json!(kept["fact_receipts"].as_i64().unwrap() + 5);
    assert_eq!(fact_rows(&admin.app).await, grown);
    // A fact that matches the plan needs no reason, and the largest plan is
    // a plan; a fact that differs takes one of the six codes.
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[close(
                6,
                shift_closed(Some(10_000_000), 10_000_000, 1, None, &at)
            )]
        )
        .await,
        vec![accepted(&record_id(6))]
    );
    // A reason the plan did not call for is kept, as in the cloud.
    assert_eq!(
        receipts(
            &admin.app,
            &other.key,
            &[fact(
                &record_id(7),
                "shift_closed",
                &other.shift,
                shift_closed(None, 5, 1, Some("material_shortage"), &at)
            )]
        )
        .await,
        vec![accepted(&record_id(7))]
    );
    assert_eq!(
        shift_state(&admin, &other.shift).await[4],
        json!("material_shortage")
    );
    let third = open_floor(&admin, &setup, &floor.key, &setup.line).await;
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(8),
                "shift_closed",
                &third.shift,
                shift_closed(Some(250), 249, 20, Some("equipment_stop"), &at)
            )]
        )
        .await,
        vec![accepted(&record_id(8))]
    );
    assert_eq!(
        shift_state(&admin, &third.shift).await[4],
        json!("equipment_stop")
    );
}

#[tokio::test]
async fn facts_of_a_closed_shift_are_taken_and_mark_it_late_once() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let shift = floor.shift.as_str();
    receipts(
        &admin.app,
        &floor.key,
        &[fact(
            &record_id(1),
            "scan",
            shift,
            ok_scan(1, &box_id(1), &instant(1, 0)),
        )],
    )
    .await;
    // The office closes the shift while the station is still away.
    let closed = close_from_office(&admin, shift, "Станция не отвечает").await;
    admin.app.clock.advance(time::Duration::minutes(30));
    let late_at = admin.app.state.timestamp();
    let revision = host_revision(&admin.app).await;
    // A refused record of the closed shift marks nothing.
    let mut wrong = ok_scan(9, &box_id(1), &instant(9, 0));
    wrong["code"]["gtin14"] = json!("04600682000099");
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(&record_id(2), "scan", shift, wrong)]
        )
        .await,
        vec![rejected(Some(&record_id(2)), "gtin_mismatch", None)]
    );
    assert_eq!(shift_state(&admin, shift).await[5], Value::Null);
    assert_eq!(host_revision(&admin.app).await, revision);
    // The station sends what it did meanwhile: it is taken, and marks the
    // shift late once, with one revision for the batch.
    let mut wake = admin.app.state.revisions.subscribe();
    wake.borrow_and_update();
    let late = vec![
        fact(
            &record_id(3),
            "scan",
            shift,
            ok_scan(2, &box_id(1), &instant(2, 0)),
        ),
        fact(
            &record_id(4),
            "box_closed",
            shift,
            box_closed(
                &box_id(1),
                &block,
                1500,
                &[1, 2],
                &instant(1, 0),
                &instant(20, 0),
            ),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &late).await,
        vec![accepted(&record_id(3)), accepted(&record_id(4))]
    );
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert_eq!(*wake.borrow_and_update(), revision + 1);
    let after = shift_state(&admin, shift).await;
    assert_eq!(
        after,
        json!([
            "closed",
            closed["closedAt"],
            "office_user",
            admin.id,
            null,
            late_at,
            revision + 1
        ])
    );
    // Later facts and the station's own close mark nothing more.
    admin.app.clock.advance(time::Duration::minutes(5));
    let more = vec![
        fact(
            &record_id(5),
            "box_label",
            shift,
            json!({ "boxId": box_id(1), "outcome": "skipped", "at": instant(21, 0) }),
        ),
        fact(
            &record_id(6),
            "shift_closed",
            shift,
            shift_closed(None, 2, 1, None, &instant(30, 0)),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &more).await,
        vec![
            accepted(&record_id(5)),
            json!({ "id": record_id(6), "outcome": "accepted", "details": { "alreadyClosed": true } })
        ]
    );
    assert_eq!(shift_state(&admin, shift).await, after);
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert!(audit_trail(&admin.app, "shift.close")
        .await
        .iter()
        .all(|row| row.0 == "office_user"));
}

/// A station's close and a fact after it in one batch: the fact is late, and
/// the batch takes one revision for both changes of the shift.
#[tokio::test]
async fn a_batch_that_closes_its_shift_takes_one_revision() {
    let (admin, floor) = floor().await;
    let shift = floor.shift.as_str();
    let revision = host_revision(&admin.app).await;
    let batch = vec![
        fact(
            &record_id(1),
            "scan",
            shift,
            ok_scan(1, &box_id(1), &instant(1, 0)),
        ),
        fact(
            &record_id(2),
            "shift_closed",
            shift,
            shift_closed(None, 1, 0, None, &instant(60, 0)),
        ),
        fact(
            &record_id(3),
            "scan",
            shift,
            other_scan(
                "invalid",
                "unknown",
                Value::Null,
                Value::Null,
                &instant(61, 0),
            ),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            accepted(&record_id(1)),
            accepted(&record_id(2)),
            accepted(&record_id(3))
        ]
    );
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert_eq!(
        shift_state(&admin, shift).await,
        json!([
            "closed",
            "2026-10-08T06:01:00Z",
            "device",
            floor.station,
            null,
            admin.app.state.timestamp(),
            revision + 1
        ])
    );
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

/// What no row may break, whatever writes it: the checks of migration 0010
/// (an accepted scan's box: the CHECK and trigger of 0020, plan РЕЖ). Every
/// refusal is paired with a control that differs in one thing.
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
            // 0020: the trigger of an aggregation shift, no longer a CHECK.
            "scan_needs_box",
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
            "box_id IS NULL OR verdict = 'ok'",
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

/// `sscc(serial)` with its last digit moved on: the same 17 digits.
fn sscc_off_by_a_digit(serial: u64) -> String {
    let right = sscc(serial);
    let last = right.as_bytes()[17] - b'0';
    format!("{}{}", &right[..17], (last + 1) % 10)
}

#[tokio::test]
async fn one_serial_of_a_block_closes_one_box_whatever_the_check_digits_say() {
    // The host does not count the check digit (decision 13), but one serial
    // is one physical label: two SSCCs of the same 17 digits are the same
    // serial, and the second box is refused `sscc_taken` as for one SSCC.
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    scan_into(&admin, &floor, &[(1, 1), (2, 2), (3, 3), (4, 4)]).await;
    let on = |box_n: u32, serial: u64, sscc: String| {
        let mut data = box_closed(
            &box_id(box_n),
            &block,
            serial,
            &[box_n],
            &instant(box_n, 0),
            &instant(40, 0),
        );
        data["sscc"] = json!(sscc);
        data
    };
    // The right digit first, the wrong one second, and the other way round
    // on the next serial.
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[
                close_in(&floor, 10, on(1, 1500, sscc(1500))),
                close_in(&floor, 11, on(2, 1500, sscc_off_by_a_digit(1500))),
                close_in(&floor, 12, on(4, 1501, sscc_off_by_a_digit(1501))),
                close_in(&floor, 13, on(3, 1501, sscc(1501))),
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
    for (box_n, closes) in [(1, true), (2, false), (4, true), (3, false)] {
        let row = box_row(&admin, &box_id(box_n)).await;
        assert_eq!(row[1] != Value::Null, closes, "box {box_n}");
        if !closes {
            assert_eq!(
                (&row[2], &row[3], &row[4]),
                (&Value::Null, &Value::Null, &Value::Null)
            );
        }
    }
    assert_eq!(box_row(&admin, &box_id(1)).await[2], json!(sscc(1500)));
    assert_eq!(
        box_row(&admin, &box_id(4)).await[2],
        json!(sscc_off_by_a_digit(1501))
    );
    assert_eq!(consumed_through(&admin, &block).await, Some(1501));
    // The refusal is no business of the box that holds the serial: the same
    // close again is its receipt, and the same box closed with the other
    // digit is a closed box.
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[close_in(&floor, 14, on(1, 1500, sscc_off_by_a_digit(1500)))]
        )
        .await,
        vec![rejected(Some(&record_id(14)), "box_already_closed", None)]
    );
    assert_eq!(box_row(&admin, &box_id(1)).await[2], json!(sscc(1500)));
}

#[tokio::test]
async fn one_sscc_closes_one_box_whichever_block_and_prefix_it_comes_from() {
    // The same 18 digits can come from two different `(block, serial)` pairs:
    // when the issuer prefix changes from 9 to 8 digits the serial widths
    // differ by one, and serial 1500 of either renders the same string. The
    // pair does not see it; the string must, or the unique SSCC would raise a
    // database error and the station's outbox would wedge on a 500.
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    scan_into(&admin, &floor, &[(1, 1), (2, 2)]).await;
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[close_in(
                &floor,
                10,
                box_closed(
                    &box_id(1),
                    &block,
                    1500,
                    &[1],
                    &instant(1, 0),
                    &instant(40, 0)
                )
            )]
        )
        .await,
        vec![accepted(&record_id(10))]
    );
    // The shift froze the 8-digit prefix, and the station holds a block of
    // it that covers serial 1500.
    let other_block = "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f";
    sqlx::query(
        "INSERT INTO sscc_counters (issuer_prefix, extension, next_serial, rev) \
         VALUES ('46006820', 0, 2000, 1)",
    )
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE shifts SET snapshot = json_set(snapshot, '$.issuerPrefix', '46006820')")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO sscc_blocks (id, issuer_prefix, extension, device_id, request_id, \
         from_serial, to_serial, issued_at) VALUES (?, '46006820', 0, ?, ?, 1000, 1999, ?)",
    )
    .bind(other_block)
    .bind(&floor.station)
    .bind("3d4e5f6a-7b8c-4d9e-8f10-2b3c4d5e6f70")
    .bind(admin.app.state.timestamp())
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    let colliding = sscc_under("46006820", 1500);
    assert_eq!(colliding, sscc(1500));
    let mut data = box_closed(
        &box_id(2),
        &json!({ "id": other_block }),
        1500,
        &[2],
        &instant(2, 0),
        &instant(41, 0),
    );
    data["sscc"] = json!(colliding);
    let (status, body) = send_facts(&admin.app, &floor.key, &[close_in(&floor, 11, data)]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["receipts"],
        json!([rejected(Some(&record_id(11)), "sscc_taken", None)])
    );
    // The box stays open and the other block is not touched.
    let row = box_row(&admin, &box_id(2)).await;
    assert_eq!((&row[1], &row[2]), (&Value::Null, &Value::Null));
    assert_eq!(consumed_through(&admin, &block).await, Some(1500));
    assert_eq!(
        consumed_through(&admin, &json!({ "id": other_block })).await,
        None
    );
}

#[tokio::test]
async fn a_serial_of_a_block_is_unique_among_closed_boxes_in_the_database_itself() {
    // Defence in depth under the handler's refusal: no code path may leave
    // two closed boxes on one serial of a block.
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    scan_into(&admin, &floor, &[(1, 1), (2, 2)]).await;
    let close = |box_n: u32, sscc: String| {
        let id = box_id(box_n);
        let block_id = block["id"].as_str().unwrap().to_string();
        let pool = admin.app.state.pool.clone();
        async move {
            sqlx::query(
                "UPDATE boxes SET closed_at = ?, sscc = ?, block_id = ?, serial = 1500, \
                 item_count_reported = 1, membership_digest = ?, digest_matches = 1 WHERE id = ?",
            )
            .bind(instant(40, 0))
            .bind(sscc)
            .bind(block_id)
            .bind(members_digest(&[box_n]))
            .bind(id)
            .execute(&pool)
            .await
        }
    };
    close(1, sscc(1500)).await.unwrap();
    let refused = close(2, sscc_off_by_a_digit(1500)).await.unwrap_err();
    assert!(
        refused.to_string().contains("UNIQUE"),
        "expected a unique violation, got {refused}"
    );
    assert_eq!(box_row(&admin, &box_id(2)).await[1], Value::Null);
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

/// A closed box 1 (code 1) and an open box 2 (code 2) of the station on its
/// first line, the way the exception tests below start.
async fn closed_and_open_box(admin: &Admin, floor: &Floor, block: &Value) {
    let shift = floor.shift.as_str();
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[
                fact(
                    &record_id(1),
                    "scan",
                    shift,
                    ok_scan(1, &box_id(1), &instant(1, 0))
                ),
                fact(
                    &record_id(2),
                    "scan",
                    shift,
                    ok_scan(2, &box_id(2), &instant(2, 0))
                ),
                fact(
                    &record_id(3),
                    "box_closed",
                    shift,
                    box_closed(
                        &box_id(1),
                        block,
                        1500,
                        &[1],
                        &instant(1, 0),
                        &instant(10, 0)
                    )
                ),
            ]
        )
        .await,
        vec![
            accepted(&record_id(1)),
            accepted(&record_id(2)),
            accepted(&record_id(3))
        ]
    );
}

#[tokio::test]
async fn an_exceptions_fields_are_checked_whole_before_the_box_and_every_listed_reason_is_taken() {
    let (admin, floor) = floor().await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let shift = floor.shift.as_str();
    closed_and_open_box(&admin, &floor, &block).await;
    let exception = |n: u32, kind: &str, box_id: &str, fields: Value| {
        let mut data = box_exception(kind, box_id, &instant(20 + n, 0));
        for (key, value) in fields.as_object().unwrap() {
            data[key] = value.clone();
        }
        fact(&record_id(n), "box_exception", shift, data)
    };
    let undo_fields =
        |hash: String, target: &str| json!({ "codeHash": hash, "targetScannedAt": target });
    let kept = fact_rows(&admin.app).await;
    let refused = vec![
        // The box id has the shape of a UUID (before the box is looked up).
        exception(
            10,
            "reprint",
            "box",
            json!({ "reasonCode": "damaged_label" }),
        ),
        exception(
            11,
            "reprint",
            &box_id(1).to_uppercase(),
            json!({ "reasonCode": "damaged_label" }),
        ),
        // Instants as `toISOString` writes them, nothing else.
        exception(
            12,
            "reprint",
            &box_id(1),
            json!({ "reasonCode": "damaged_label", "occurredAt": "2026-10-08T06:00:20Z" }),
        ),
        exception(
            13,
            "reprint",
            &box_id(1),
            json!({
                "reasonCode": "damaged_label", "occurredAt": "2026-10-08T06:00:20.000+00:00"
            }),
        ),
        exception(
            14,
            "undo",
            &box_id(2),
            undo_fields(code_hash(2), "2026-10-08T06:00:02Z"),
        ),
        exception(
            15,
            "undo",
            &box_id(2),
            undo_fields(code_hash(2), "2026-10-08T06:00:02.000+00:00"),
        ),
        // A code hash is 64 lower-case hex digits.
        exception(
            16,
            "undo",
            &box_id(2),
            undo_fields(code_hash(0xabc).to_uppercase(), &instant(2, 0)),
        ),
        exception(
            17,
            "undo",
            &box_id(2),
            undo_fields(code_hash(2)[1..].to_owned(), &instant(2, 0)),
        ),
        // A reason is one of the kind's codes, spelled exactly.
        exception(
            18,
            "reprint",
            &box_id(1),
            json!({ "reasonCode": "Damaged_label" }),
        ),
        exception(19, "reprint", &box_id(1), json!({ "reasonCode": "" })),
        exception(
            20,
            "reprint",
            &box_id(1),
            json!({ "reasonCode": "wrong_product" }),
        ),
        exception(
            21,
            "disassemble",
            &box_id(1),
            json!({ "reasonCode": "damaged_label" }),
        ),
        // Words are text, and plain text.
        exception(
            22,
            "reprint",
            &box_id(1),
            json!({ "reasonCode": "other", "reasonText": 5 }),
        ),
        exception(
            23,
            "reprint",
            &box_id(1),
            json!({ "reasonCode": "other", "reasonText": "в две\nстроки" }),
        ),
        exception(
            24,
            "reprint",
            &box_id(1),
            json!({ "reasonCode": "other", "reasonText": "" }),
        ),
        // A field the host does not know.
        exception(
            25,
            "reprint",
            &box_id(1),
            json!({ "reasonCode": "other", "extra": 1 }),
        ),
        // The fields come before the box: a bad reason on an open box, a code
        // on a clear of a closed one.
        exception(26, "reprint", &box_id(2), json!({ "reasonCode": "bogus" })),
        exception(27, "clear", &box_id(1), json!({ "codeHash": code_hash(1) })),
        exception(
            28,
            "undo",
            &box_id(9),
            undo_fields("C0DE".to_owned(), &instant(1, 0)),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &refused).await,
        vec![
            rejected(Some(&record_id(10)), "invalid_record", Some("data.boxId")),
            rejected(Some(&record_id(11)), "invalid_record", Some("data.boxId")),
            rejected(
                Some(&record_id(12)),
                "invalid_record",
                Some("data.occurredAt")
            ),
            rejected(
                Some(&record_id(13)),
                "invalid_record",
                Some("data.occurredAt")
            ),
            rejected(
                Some(&record_id(14)),
                "invalid_record",
                Some("data.targetScannedAt")
            ),
            rejected(
                Some(&record_id(15)),
                "invalid_record",
                Some("data.targetScannedAt")
            ),
            rejected(
                Some(&record_id(16)),
                "invalid_record",
                Some("data.codeHash")
            ),
            rejected(
                Some(&record_id(17)),
                "invalid_record",
                Some("data.codeHash")
            ),
            rejected(
                Some(&record_id(18)),
                "invalid_record",
                Some("data.reasonCode")
            ),
            rejected(
                Some(&record_id(19)),
                "invalid_record",
                Some("data.reasonCode")
            ),
            rejected(
                Some(&record_id(20)),
                "invalid_record",
                Some("data.reasonCode")
            ),
            rejected(
                Some(&record_id(21)),
                "invalid_record",
                Some("data.reasonCode")
            ),
            rejected(Some(&record_id(22)), "invalid_record", Some("data")),
            rejected(
                Some(&record_id(23)),
                "invalid_record",
                Some("data.reasonText")
            ),
            rejected(
                Some(&record_id(24)),
                "invalid_record",
                Some("data.reasonText")
            ),
            rejected(Some(&record_id(25)), "invalid_record", Some("data")),
            rejected(
                Some(&record_id(26)),
                "invalid_record",
                Some("data.reasonCode")
            ),
            rejected(
                Some(&record_id(27)),
                "invalid_record",
                Some("data.codeHash")
            ),
            rejected(
                Some(&record_id(28)),
                "invalid_record",
                Some("data.codeHash")
            ),
        ]
    );
    let mut grown = kept.clone();
    grown["fact_receipts"] = json!(kept["fact_receipts"].as_i64().unwrap() + 19);
    assert_eq!(fact_rows(&admin.app).await, grown);

    // Each code of each list is taken, `other` also without words.
    let reprints = [
        "damaged_label",
        "unreadable_label",
        "printer_jam",
        "quality_request",
        "other",
    ];
    let disassemblies = [
        "wrong_product",
        "wrong_quantity",
        "damaged_package",
        "quality_rejected",
        "other",
    ];
    // Boxes 3-7 close on their own code each, to be taken apart.
    let mut setup_facts = Vec::new();
    for (index, box_n) in (3u32..=7).enumerate() {
        let n = u32::try_from(index).unwrap();
        setup_facts.push(fact(
            &record_id(100 + n),
            "scan",
            shift,
            ok_scan(box_n, &box_id(box_n), &instant(30 + n, 0)),
        ));
        setup_facts.push(fact(
            &record_id(110 + n),
            "box_closed",
            shift,
            box_closed(
                &box_id(box_n),
                &block,
                1501 + u64::from(n),
                &[box_n],
                &instant(30 + n, 0),
                &instant(40 + n, 0),
            ),
        ));
    }
    assert!(receipts(&admin.app, &floor.key, &setup_facts)
        .await
        .iter()
        .all(|receipt| receipt["outcome"] == "accepted"));
    let mut taken = Vec::new();
    for (index, reason) in reprints.iter().enumerate() {
        let n = u32::try_from(index).unwrap();
        taken.push(exception(
            30 + n,
            "reprint",
            &box_id(1),
            json!({ "reasonCode": reason }),
        ));
    }
    for (index, reason) in disassemblies.iter().enumerate() {
        let n = u32::try_from(index).unwrap();
        let mut fields = json!({ "reasonCode": reason });
        if *reason == "other" {
            fields["reasonText"] = json!(" брак  ");
        }
        taken.push(exception(40 + n, "disassemble", &box_id(3 + n), fields));
    }
    let answered = receipts(&admin.app, &floor.key, &taken).await;
    assert_eq!(
        answered,
        taken
            .iter()
            .map(|record| accepted(record["id"].as_str().unwrap()))
            .collect::<Vec<_>>()
    );
    let reasons: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT record_id, kind, reason_code, reason_text FROM box_exceptions ORDER BY record_id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    let wanted: Vec<(String, String, Option<String>, Option<String>)> = reprints
        .iter()
        .enumerate()
        .map(|(index, reason)| (30 + u32::try_from(index).unwrap(), "reprint", reason, None))
        .chain(disassemblies.iter().enumerate().map(|(index, reason)| {
            let words = (*reason == "other").then(|| "брак".to_owned());
            (
                40 + u32::try_from(index).unwrap(),
                "disassemble",
                reason,
                words,
            )
        }))
        .map(|(n, kind, reason, words)| {
            (
                record_id(n),
                kind.to_owned(),
                Some((*reason).to_owned()),
                words,
            )
        })
        .collect();
    assert_eq!(reasons, wanted);
}

#[tokio::test]
async fn an_exception_is_one_row_per_record_of_its_shift_and_device_whoever_sends_it_again() {
    let (admin, floor) = floor().await;
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
                ok_scan(2, &box_id(1), &instant(2, 0)),
            ),
        ],
    )
    .await;
    let clear = |n: u32, second: u32| {
        fact(
            &record_id(n),
            "box_exception",
            shift,
            box_exception("clear", &box_id(1), &instant(second, 0)),
        )
    };
    let mut other_clear = clear(10, 21);
    other_clear["data"]["occurredAt"] = json!(instant(22, 0));
    // The same record twice in a batch and again in the next, then the same
    // id with other content, then a new record that clears the empty box.
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[clear(10, 20), clear(10, 20), other_clear]
        )
        .await,
        vec![
            accepted(&record_id(10)),
            accepted(&record_id(10)),
            rejected(Some(&record_id(10)), "payload_mismatch", None)
        ]
    );
    let rows_after_first = exception_rows(&admin).await;
    assert_eq!(rows_after_first.len(), 1);
    assert_eq!(
        receipts(&admin.app, &floor.key, &[clear(10, 20)]).await,
        vec![accepted(&record_id(10))]
    );
    assert_eq!(exception_rows(&admin).await, rows_after_first);
    // A second clear of the emptied (still open) box is a record of its own:
    // accepted and kept, taking nothing and keeping the first instants.
    assert_eq!(
        receipts(&admin.app, &floor.key, &[clear(11, 30)]).await,
        vec![accepted(&record_id(11))]
    );
    let undo_one = {
        let mut data = box_exception("undo", &box_id(1), &instant(31, 0));
        data["codeHash"] = json!(code_hash(1));
        data["targetScannedAt"] = json!(instant(1, 0));
        fact(&record_id(12), "box_exception", shift, data)
    };
    assert_eq!(
        receipts(&admin.app, &floor.key, &[undo_one]).await,
        vec![accepted(&record_id(12))]
    );
    assert_eq!(exception_rows(&admin).await.len(), 3);
    assert_eq!(
        items(&admin, &box_id(1)).await,
        vec![
            json!([
                record_id(1),
                code_hash(1),
                instant(1, 0),
                instant(20, 0),
                null
            ]),
            json!([
                record_id(2),
                code_hash(2),
                instant(2, 0),
                instant(20, 0),
                null
            ]),
        ]
    );
    let kept: Vec<(String, String, String, i64)> = sqlx::query_as(
        "SELECT record_id, shift_id, device_id, length(received_at) FROM box_exceptions \
         ORDER BY record_id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        kept,
        [10, 11, 12]
            .map(|n| (record_id(n), floor.shift.clone(), floor.station.clone(), 20))
            .to_vec()
    );
    // The receipts are kept for the three records, the refused id not twice.
    assert_eq!(fact_rows(&admin.app).await["fact_receipts"], json!(2 + 3));
}

#[tokio::test]
async fn a_box_of_another_device_or_shift_is_unknown_to_a_label_check_and_to_every_exception() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    closed_and_open_box(&admin, &floor, &block).await;
    // The colleague's open box 3 with code 3; a box of the colleague in
    // this very shift (a second device on a shift comes with plan 2b).
    receipts(
        &admin.app,
        &colleague.key,
        &[fact(
            &record_id(90),
            "scan",
            &colleague.shift,
            ok_scan(3, &box_id(3), &instant(3, 0)),
        )],
    )
    .await;
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
    let second = open_floor(&admin, &setup, &floor.key, &setup.line).await;
    let aimed = |n: u32, shift: &str, kind: &str, box_n: u32, fields: Value| {
        let mut data = box_exception(kind, &box_id(box_n), &instant(50 + n, 0));
        for (key, value) in fields.as_object().unwrap() {
            data[key] = value.clone();
        }
        fact(&record_id(n), "box_exception", shift, data)
    };
    let reason = json!({ "reasonCode": "damaged_label" });
    let undo_three = json!({ "codeHash": code_hash(3), "targetScannedAt": instant(3, 0) });
    let label = |n: u32, shift: &str, box_n: u32| {
        fact(
            &record_id(n),
            "box_label",
            shift,
            json!({ "boxId": box_id(box_n), "outcome": "verified", "at": instant(60, 0) }),
        )
    };
    let kept = fact_rows(&admin.app).await;
    let batch = vec![
        // The colleague's open box 3 from the station's own shift.
        aimed(10, &floor.shift, "undo", 3, undo_three.clone()),
        aimed(11, &floor.shift, "clear", 3, json!({})),
        aimed(12, &floor.shift, "reprint", 3, reason.clone()),
        aimed(
            13,
            &floor.shift,
            "disassemble",
            3,
            json!({ "reasonCode": "wrong_product" }),
        ),
        label(14, &floor.shift, 3),
        // The station's box 1 (closed) and box 2 (open) from another shift.
        aimed(15, &second.shift, "reprint", 1, reason.clone()),
        aimed(
            16,
            &second.shift,
            "disassemble",
            1,
            json!({ "reasonCode": "wrong_product" }),
        ),
        aimed(17, &second.shift, "clear", 2, json!({})),
        aimed(
            18,
            &second.shift,
            "undo",
            2,
            json!({ "codeHash": code_hash(2), "targetScannedAt": instant(2, 0) }),
        ),
        label(19, &second.shift, 1),
        // The colleague's box in this very shift.
        aimed(20, &floor.shift, "clear", 9, json!({})),
        aimed(21, &floor.shift, "reprint", 9, reason.clone()),
        label(22, &floor.shift, 9),
    ];
    let expected: Vec<Value> = (10..=22)
        .map(|n| rejected(Some(&record_id(n)), "box_unknown", None))
        .collect();
    assert_eq!(receipts(&admin.app, &floor.key, &batch).await, expected);
    let mut grown = kept.clone();
    grown["fact_receipts"] = json!(kept["fact_receipts"].as_i64().unwrap() + 13);
    assert_eq!(fact_rows(&admin.app).await, grown);
    assert_eq!(items(&admin, &box_id(3)).await.len(), 1);
    assert_eq!(items(&admin, &box_id(3)).await[0][3], Value::Null);
    assert_eq!(items(&admin, &box_id(2)).await[0][3], Value::Null);
    assert_eq!(label_checks(&admin, &box_id(1)).await, (None, None));
    assert_eq!(owners(&admin).await.len(), 3);
}

#[tokio::test]
async fn a_code_freed_by_an_exception_is_claimed_again_by_the_earliest_scan_in_either_order() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let shift = floor.shift.as_str();
    // Codes 1 and 2 in open box 1, code 3 in box 2, which closes.
    receipts(
        &admin.app,
        &floor.key,
        &[
            fact(
                &record_id(1),
                "scan",
                shift,
                ok_scan(1, &box_id(1), &instant(10, 0)),
            ),
            fact(
                &record_id(2),
                "scan",
                shift,
                ok_scan(2, &box_id(1), &instant(11, 0)),
            ),
            fact(
                &record_id(3),
                "scan",
                shift,
                ok_scan(3, &box_id(2), &instant(12, 0)),
            ),
            fact(
                &record_id(4),
                "box_closed",
                shift,
                box_closed(
                    &box_id(2),
                    &block,
                    1500,
                    &[3],
                    &instant(12, 0),
                    &instant(13, 0),
                ),
            ),
        ],
    )
    .await;
    // A clear frees 1 and 2; the disassembly of box 2 frees 3.
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[
                fact(
                    &record_id(5),
                    "box_exception",
                    shift,
                    box_exception("clear", &box_id(1), &instant(14, 0))
                ),
                fact(&record_id(6), "box_exception", shift, {
                    let mut data = box_exception("disassemble", &box_id(2), &instant(15, 0));
                    data["reasonCode"] = json!("wrong_product");
                    data
                }),
            ]
        )
        .await,
        vec![accepted(&record_id(5)), accepted(&record_id(6))]
    );
    assert_eq!(owners(&admin).await, Vec::<Value>::new());
    let scan = |floor: &Floor, n: u32, code: u32, box_n: u32, second: u32| {
        fact(
            &record_id(n),
            "scan",
            &floor.shift,
            ok_scan(code, &box_id(box_n), &instant(second, 0)),
        )
    };
    // Code 1: the colleague scans it late, then the station scans it at an
    // earlier instant than that (and than the freed scan): the earliest wins.
    assert_eq!(
        receipts(
            &admin.app,
            &colleague.key,
            &[scan(&colleague, 20, 1, 7, 50)]
        )
        .await,
        vec![accepted(&record_id(20))]
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[scan(&floor, 21, 1, 3, 5)]).await,
        vec![accepted(&record_id(21))]
    );
    // Code 2: the station scans it again, then the colleague's later scan
    // loses.
    assert_eq!(
        receipts(&admin.app, &floor.key, &[scan(&floor, 22, 2, 3, 6)]).await,
        vec![accepted(&record_id(22))]
    );
    assert_eq!(
        receipts(
            &admin.app,
            &colleague.key,
            &[scan(&colleague, 23, 2, 7, 51)]
        )
        .await,
        vec![json!({
            "id": record_id(23), "outcome": "conflict",
            "details": { "winner": {
                "shiftId": floor.shift, "shiftNumber": floor.number,
                "deviceId": floor.station, "scannedAt": instant(6, 0), "sameDevice": false
            } }
        })]
    );
    // Code 3, freed by a disassembly, goes to whoever scans it.
    assert_eq!(
        receipts(
            &admin.app,
            &colleague.key,
            &[scan(&colleague, 24, 3, 7, 52)]
        )
        .await,
        vec![accepted(&record_id(24))]
    );
    assert_eq!(
        owners(&admin).await,
        vec![
            json!([
                code_hash(1),
                record_id(21),
                floor.shift,
                floor.station,
                box_id(3),
                instant(5, 0)
            ]),
            json!([
                code_hash(2),
                record_id(22),
                floor.shift,
                floor.station,
                box_id(3),
                instant(6, 0)
            ]),
            json!([
                code_hash(3),
                record_id(24),
                colleague.shift,
                colleague.station,
                box_id(7),
                instant(52, 0)
            ]),
        ]
    );
    // The colleague's scan of code 1 left its box when the earlier one took
    // the code; the freed items of the exceptions stay removed.
    let displaced = items(&admin, &box_id(7)).await;
    assert_eq!(displaced.len(), 2);
    assert_eq!(displaced[0][0], json!(record_id(20)));
    assert!(displaced[0][4].is_string() && displaced[0][3].is_null());
    assert_eq!(displaced[1][4], Value::Null);
    assert_eq!(
        items(&admin, &box_id(1))
            .await
            .iter()
            .map(|item| item[3].clone())
            .collect::<Vec<_>>(),
        vec![json!(instant(14, 0)), json!(instant(14, 0))]
    );
}

#[tokio::test]
async fn an_exception_takes_out_only_live_items_of_its_own_box() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let shift = floor.shift.as_str();
    let scan = |n: u32, code: u32, box_n: u32, second: u32| {
        fact(
            &record_id(n),
            "scan",
            shift,
            ok_scan(code, &box_id(box_n), &instant(second, 0)),
        )
    };
    let undo = |n: u32, code: u32, box_n: u32, second: u32| {
        let mut data = box_exception("undo", &box_id(box_n), &instant(second, 0));
        data["codeHash"] = json!(code_hash(code));
        data["targetScannedAt"] = json!(instant(code, 0));
        fact(&record_id(n), "box_exception", shift, data)
    };
    // Box 1 holds codes 1-3, box 2 code 4, box 3 code 5; the colleague then
    // scans code 5 at an earlier instant, which displaces the station's item.
    receipts(
        &admin.app,
        &floor.key,
        &[
            scan(1, 1, 1, 1),
            scan(2, 2, 1, 2),
            scan(3, 3, 1, 3),
            scan(4, 4, 2, 4),
            scan(5, 5, 3, 105),
        ],
    )
    .await;
    receipts(
        &admin.app,
        &colleague.key,
        &[fact(
            &record_id(90),
            "scan",
            &colleague.shift,
            ok_scan(5, &box_id(9), &instant(5, 0)),
        )],
    )
    .await;
    let displaced = items(&admin, &box_id(3)).await;
    assert!(displaced[0][4].is_string());
    let owners_before = owners(&admin).await;
    // An undo names a code of another open box of the station: kept, and
    // nothing is taken out of either box.
    assert_eq!(
        receipts(&admin.app, &floor.key, &[undo(10, 4, 1, 20)]).await,
        vec![accepted(&record_id(10))]
    );
    assert_eq!(items(&admin, &box_id(2)).await[0][3], Value::Null);
    assert_eq!(owners(&admin).await, owners_before);
    assert_eq!(exception_rows(&admin).await.len(), 1);
    // Code 1 leaves box 1 at 21; the clear at 30 takes the rest and not it
    // again.
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[
                undo(11, 1, 1, 21),
                fact(
                    &record_id(12),
                    "box_exception",
                    shift,
                    box_exception("clear", &box_id(1), &instant(30, 0))
                )
            ]
        )
        .await,
        vec![accepted(&record_id(11)), accepted(&record_id(12))]
    );
    let removed: Vec<Value> = items(&admin, &box_id(1))
        .await
        .iter()
        .map(|item| item[3].clone())
        .collect();
    assert_eq!(
        removed,
        vec![
            json!(instant(21, 0)),
            json!(instant(30, 0)),
            json!(instant(30, 0))
        ]
    );
    // A clear of box 3 does not touch the item the colleague's earlier scan
    // displaced, and the colleague keeps the code.
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(13),
                "box_exception",
                shift,
                box_exception("clear", &box_id(3), &instant(31, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(13))]
    );
    assert_eq!(items(&admin, &box_id(3)).await, displaced);
    // Box 2's item and the owners of codes 4 and 5 are as they were.
    assert_eq!(items(&admin, &box_id(2)).await[0][3], Value::Null);
    assert_eq!(
        owners(&admin).await,
        vec![
            json!([
                code_hash(4),
                record_id(4),
                floor.shift,
                floor.station,
                box_id(2),
                instant(4, 0)
            ]),
            json!([
                code_hash(5),
                record_id(90),
                colleague.shift,
                colleague.station,
                box_id(9),
                instant(5, 0)
            ]),
        ]
    );
}

#[tokio::test]
async fn a_reprint_changes_nothing_and_a_box_taken_apart_keeps_its_label_and_serial() {
    let (admin, floor) = floor().await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let shift = floor.shift.as_str();
    closed_and_open_box(&admin, &floor, &block).await;
    let before = box_row(&admin, &box_id(1)).await;
    let items_before = items(&admin, &box_id(1)).await;
    let owners_before = owners(&admin).await;
    let reprint = |n: u32| {
        let mut data = box_exception("reprint", &box_id(1), &instant(20 + n, 0));
        data["reasonCode"] = json!("printer_jam");
        fact(&record_id(n), "box_exception", shift, data)
    };
    assert_eq!(
        receipts(&admin.app, &floor.key, &[reprint(10), reprint(11)]).await,
        vec![accepted(&record_id(10)), accepted(&record_id(11))]
    );
    let taken_apart = || async {
        sqlx::query_scalar::<_, Option<String>>("SELECT disassembled_at FROM boxes WHERE id = ?")
            .bind(box_id(1))
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap()
    };
    assert_eq!(taken_apart().await, None);
    assert_eq!(box_row(&admin, &box_id(1)).await, before);
    assert_eq!(items(&admin, &box_id(1)).await, items_before);
    assert_eq!(owners(&admin).await, owners_before);
    // The disassembly leaves the close as it was; the label of the box
    // taken apart can still be checked (the box is closed), and its serial
    // closes no other box whatever the check digit.
    let mut disassemble = box_exception("disassemble", &box_id(1), &instant(30, 0));
    disassemble["reasonCode"] = json!("damaged_package");
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[
                fact(&record_id(12), "box_exception", shift, disassemble),
                fact(
                    &record_id(13),
                    "box_label",
                    shift,
                    json!({ "boxId": box_id(1), "outcome": "skipped", "at": instant(31, 0) })
                )
            ]
        )
        .await,
        vec![accepted(&record_id(12)), accepted(&record_id(13))]
    );
    assert_eq!(taken_apart().await, Some(instant(30, 0)));
    assert_eq!(box_row(&admin, &box_id(1)).await, before);
    assert_eq!(
        label_checks(&admin, &box_id(1)).await,
        (None, Some(instant(31, 0)))
    );
    // The check marked that box and no other.
    assert_eq!(label_checks(&admin, &box_id(2)).await, (None, None));
    let mut off_by_a_digit = box_closed(
        &box_id(2),
        &block,
        1500,
        &[2],
        &instant(2, 0),
        &instant(40, 0),
    );
    off_by_a_digit["sscc"] = json!(sscc_off_by_a_digit(1500));
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(&record_id(14), "box_closed", shift, off_by_a_digit)]
        )
        .await,
        vec![rejected(Some(&record_id(14)), "sscc_taken", None)]
    );
    assert_eq!(consumed_through(&admin, &block).await, Some(1500));
    assert_eq!(box_row(&admin, &box_id(2)).await[1], Value::Null);
}

#[tokio::test]
async fn an_exception_is_written_with_the_batch_or_not_at_all() {
    let (admin, floor) = floor().await;
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
    sqlx::query(&format!(
        "CREATE TRIGGER break_the_exception BEFORE INSERT ON box_exceptions \
         WHEN NEW.record_id = '{}' BEGIN SELECT RAISE(ABORT, 'broken'); END",
        record_id(11)
    ))
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    let clear = |n: u32, box_n: u32| {
        fact(
            &record_id(n),
            "box_exception",
            shift,
            box_exception("clear", &box_id(box_n), &instant(20 + n, 0)),
        )
    };
    // The second clear takes its items out and frees their codes before its
    // exception row breaks: the first clear goes with it.
    let batch = vec![clear(10, 1), clear(11, 2)];
    let before_items = (
        items(&admin, &box_id(1)).await,
        items(&admin, &box_id(2)).await,
    );
    let before_owners = owners(&admin).await;
    let empty = fact_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let (status, failed) = send_facts(&admin.app, &floor.key, &batch).await;
    assert_eq!(
        (status, failed["error"]["code"].clone()),
        (StatusCode::INTERNAL_SERVER_ERROR, json!("internal"))
    );
    assert_eq!(fact_rows(&admin.app).await, empty);
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(
        (
            items(&admin, &box_id(1)).await,
            items(&admin, &box_id(2)).await
        ),
        before_items
    );
    assert_eq!(owners(&admin).await, before_owners);
    sqlx::query("DROP TRIGGER break_the_exception")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![accepted(&record_id(10)), accepted(&record_id(11))]
    );
    assert_eq!(owners(&admin).await, Vec::<Value>::new());
}

/// An undo of code `n` aimed at the scan of `target`, as the station would
/// write it again under a new id.
fn undo_of(record: u32, shift: &str, box_n: u32, n: u32, target: u32, at: u32) -> Value {
    let mut data = box_exception("undo", &box_id(box_n), &instant(at, 0));
    data["codeHash"] = json!(code_hash(n));
    data["targetScannedAt"] = json!(instant(target, 0));
    fact(&record_id(record), "box_exception", shift, data)
}

fn clear_of(record: u32, shift: &str, box_n: u32, at: u32) -> Value {
    fact(
        &record_id(record),
        "box_exception",
        shift,
        box_exception("clear", &box_id(box_n), &instant(at, 0)),
    )
}

fn scan_of(record: u32, shift: &str, n: u32, box_n: u32, at: u32) -> Value {
    fact(
        &record_id(record),
        "scan",
        shift,
        ok_scan(n, &box_id(box_n), &instant(at, 0)),
    )
}

#[tokio::test]
async fn a_late_undo_never_takes_out_a_code_scanned_again_after_it() {
    let (admin, floor) = floor().await;
    let shift = floor.shift.as_str();
    let key = &floor.key;
    // Code 1 is scanned at 1 and 2 is scanned at 2; a clear at 3 frees
    // both; code 1 is scanned again at 5, code 2 not.
    assert_eq!(
        receipts(
            &admin.app,
            key,
            &[
                scan_of(1, shift, 1, 1, 1),
                scan_of(2, shift, 2, 1, 2),
                clear_of(3, shift, 1, 3),
                scan_of(4, shift, 1, 1, 5),
            ]
        )
        .await,
        (1..=4).map(|n| accepted(&record_id(n))).collect::<Vec<_>>()
    );
    // The undo of the first scan of code 1, sent again under a new id long
    // after the re-scan: accepted, kept, and it takes nothing out.
    assert_eq!(
        receipts(&admin.app, key, &[undo_of(10, shift, 1, 1, 1, 7)]).await,
        vec![accepted(&record_id(10))]
    );
    assert_eq!(
        items(&admin, &box_id(1)).await,
        vec![
            json!([
                record_id(1),
                code_hash(1),
                instant(1, 0),
                instant(3, 0),
                null
            ]),
            json!([
                record_id(2),
                code_hash(2),
                instant(2, 0),
                instant(3, 0),
                null
            ]),
            json!([record_id(4), code_hash(1), instant(5, 0), null, null]),
        ]
    );
    // The re-scan still owns the code: it is taken, and its scan is the owner.
    assert_eq!(owned(&admin).await, vec![(code_hash(1), record_id(4))]);
    assert_eq!(code_status(&admin, key, 1).await, json!("taken"));
    assert_eq!(code_status(&admin, key, 2).await, json!("free"));
    // An undo whose target names no live item of the code takes nothing
    // either, and the exception is kept all the same.
    assert_eq!(
        receipts(&admin.app, key, &[undo_of(11, shift, 1, 1, 4, 8)]).await,
        vec![accepted(&record_id(11))]
    );
    assert_eq!(owned(&admin).await, vec![(code_hash(1), record_id(4))]);
    assert_eq!(items(&admin, &box_id(1)).await.len(), 3);
    assert_eq!(exception_rows(&admin).await.len(), 3);
    // The undo that names the live scan's own instant takes it out.
    assert_eq!(
        receipts(&admin.app, key, &[undo_of(12, shift, 1, 1, 5, 9)]).await,
        vec![accepted(&record_id(12))]
    );
    assert_eq!(owned(&admin).await, Vec::<(String, String)>::new());
    assert_eq!(code_status(&admin, key, 1).await, json!("free"));
    // The other arrival order, in one batch: the stale undo comes first
    // and the re-scan after it.
    assert_eq!(
        receipts(
            &admin.app,
            key,
            &[
                scan_of(20, shift, 3, 2, 11),
                clear_of(21, shift, 2, 13),
                undo_of(22, shift, 2, 3, 11, 14),
                scan_of(23, shift, 3, 2, 15),
            ]
        )
        .await,
        (20..=23)
            .map(|n| accepted(&record_id(n)))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        items(&admin, &box_id(2)).await,
        vec![
            json!([
                record_id(20),
                code_hash(3),
                instant(11, 0),
                instant(13, 0),
                null
            ]),
            json!([record_id(23), code_hash(3), instant(15, 0), null, null]),
        ]
    );
    assert_eq!(owned(&admin).await, vec![(code_hash(3), record_id(23))]);
    assert_eq!(code_status(&admin, key, 3).await, json!("taken"));
    // Two codes scanned at one instant: an undo names its own code, not the
    // instant alone.
    assert_eq!(
        receipts(
            &admin.app,
            key,
            &[
                scan_of(30, shift, 5, 3, 20),
                scan_of(31, shift, 6, 3, 20),
                undo_of(32, shift, 3, 5, 20, 21),
            ]
        )
        .await,
        (30..=32)
            .map(|n| accepted(&record_id(n)))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        items(&admin, &box_id(3)).await,
        vec![
            json!([
                record_id(30),
                code_hash(5),
                instant(20, 0),
                instant(21, 0),
                null
            ]),
            json!([record_id(31), code_hash(6), instant(20, 0), null, null]),
        ]
    );
    assert_eq!(code_status(&admin, key, 6).await, json!("taken"));
}

#[tokio::test]
async fn a_late_clear_never_takes_out_a_code_scanned_after_it() {
    let (admin, floor) = floor().await;
    let shift = floor.shift.as_str();
    let key = &floor.key;
    // Code 1 at 1 is cleared at 3; code 2 is scanned at 6; the clear is sent
    // again (a new id) with its own instant 4: it takes nothing.
    assert_eq!(
        receipts(
            &admin.app,
            key,
            &[
                scan_of(1, shift, 1, 1, 1),
                clear_of(2, shift, 1, 3),
                scan_of(3, shift, 2, 1, 6),
                clear_of(4, shift, 1, 4),
            ]
        )
        .await,
        (1..=4).map(|n| accepted(&record_id(n))).collect::<Vec<_>>()
    );
    assert_eq!(
        items(&admin, &box_id(1)).await,
        vec![
            json!([
                record_id(1),
                code_hash(1),
                instant(1, 0),
                instant(3, 0),
                null
            ]),
            json!([record_id(3), code_hash(2), instant(6, 0), null, null]),
        ]
    );
    assert_eq!(owned(&admin).await, vec![(code_hash(2), record_id(3))]);
    assert_eq!(code_status(&admin, key, 2).await, json!("taken"));
    // The other arrival order, in one batch: the late clear first, then the
    // scan it must not touch (and one scanned before it, which it takes).
    assert_eq!(
        receipts(
            &admin.app,
            key,
            &[
                scan_of(10, shift, 3, 1, 8),
                clear_of(11, shift, 1, 9),
                scan_of(12, shift, 4, 1, 12),
                clear_of(13, shift, 1, 10),
            ]
        )
        .await,
        (10..=13)
            .map(|n| accepted(&record_id(n)))
            .collect::<Vec<_>>()
    );
    // The first of them cleared 2 and 3 (scanned at 6 and 8 <= 9); the
    // second one, instant 10, left code 4 (12) alone.
    assert_eq!(
        items(&admin, &box_id(1)).await[1..],
        [
            json!([
                record_id(3),
                code_hash(2),
                instant(6, 0),
                instant(9, 0),
                null
            ]),
            json!([
                record_id(10),
                code_hash(3),
                instant(8, 0),
                instant(9, 0),
                null
            ]),
            json!([record_id(12), code_hash(4), instant(12, 0), null, null]),
        ]
    );
    assert_eq!(owned(&admin).await, vec![(code_hash(4), record_id(12))]);
    // A clear exactly at an item's instant takes it out (the cutoff is
    // inclusive); one after takes the rest.
    assert_eq!(
        receipts(&admin.app, key, &[clear_of(14, shift, 1, 12)]).await,
        vec![accepted(&record_id(14))]
    );
    assert_eq!(owned(&admin).await, Vec::<(String, String)>::new());
    assert_eq!(code_status(&admin, key, 4).await, json!("free"));
}

/// The audit row `shift.close` of a station: the device as actor, the shift
/// as target.
fn station_close_row(floor: &Floor, details: Value) -> support::app::AuditRow {
    (
        "device".to_owned(),
        Some(floor.station.clone()),
        "shift.close".to_owned(),
        Some("shift".to_owned()),
        Some(floor.shift.clone()),
        "ok".to_owned(),
        details,
    )
}

/// The words of a closed shift (`close_reason_text`): the office's, never a
/// station's.
async fn reason_text(admin: &Admin, shift: &str) -> Option<String> {
    sqlx::query_scalar("SELECT close_reason_text FROM shifts WHERE id = ?")
        .bind(shift)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_close_is_kept_as_the_station_sent_it_whatever_its_reason_and_instant() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let shift = floor.shift.as_str();
    let revision = host_revision(&admin.app).await;
    admin.app.clock.advance(time::Duration::minutes(3));
    let received = admin.app.state.timestamp();
    let mut close = fact(
        &record_id(1),
        "shift_closed",
        shift,
        // 999 ms: the host keeps whole seconds, cut and not rounded.
        shift_closed(
            Some(250),
            249,
            20,
            Some("equipment_stop"),
            &instant(5400, 999),
        ),
    );
    close["operatorId"] = json!(OPERATOR);
    assert_eq!(
        receipts(&admin.app, &floor.key, std::slice::from_ref(&close)).await,
        vec![accepted(&record_id(1))]
    );
    assert_eq!(
        shift_state(&admin, shift).await,
        json!([
            "closed",
            "2026-10-08T07:30:00Z",
            "device",
            floor.station,
            "equipment_stop",
            null,
            revision + 1
        ])
    );
    // The station's close names no words: they are the office's.
    assert_eq!(reason_text(&admin, shift).await, None);
    assert_eq!(
        audit_trail(&admin.app, "shift.close").await,
        vec![station_close_row(
            &floor,
            json!({
                "actualQty": 249, "plannedQty": 250, "closedBoxCount": 20,
                "reasonCode": "equipment_stop"
            })
        )]
    );
    assert_eq!(
        close_events(&admin).await,
        vec![json!([
            record_id(1),
            floor.station,
            OPERATOR,
            250,
            249,
            20,
            "equipment_stop",
            instant(5400, 999),
            "accepted",
            received
        ])]
    );
    let (status, office) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{office}");
    assert_eq!(
        [
            &office["status"],
            &office["closedAt"],
            &office["closeReasonCode"],
            &office["closeReasonText"],
            &office["lateDataAt"],
        ],
        [
            &json!("closed"),
            &json!("2026-10-08T07:30:00Z"),
            &json!("equipment_stop"),
            &Value::Null,
            &Value::Null
        ]
    );
    // The same record again, later: the same receipt, nothing written; the
    // same id with other content is `payload_mismatch`, kept nowhere.
    admin.app.clock.advance(time::Duration::minutes(1));
    let (rows, audit, revision) = (
        fact_rows(&admin.app).await,
        audit_rows(&admin.app).await,
        host_revision(&admin.app).await,
    );
    let mut wake = admin.app.state.revisions.subscribe();
    wake.borrow_and_update();
    let mut other = close.clone();
    other["data"]["actualQty"] = json!(250);
    other["data"]["reasonCode"] = json!(null);
    assert_eq!(
        receipts(&admin.app, &floor.key, &[close.clone(), other]).await,
        vec![
            accepted(&record_id(1)),
            rejected(Some(&record_id(1)), "payload_mismatch", None)
        ]
    );
    assert_eq!(fact_rows(&admin.app).await, rows);
    assert_eq!(audit_rows(&admin.app).await, audit);
    assert_eq!(host_revision(&admin.app).await, revision);
    assert!(!wake.has_changed().unwrap());
    // Each of the six reason codes closes a shift whose fact differs.
    for (n, code) in [
        "production_defect",
        "material_shortage",
        "equipment_stop",
        "production_order_changed",
        "planned_quantity_error",
        "other_production_deviation",
    ]
    .into_iter()
    .enumerate()
    {
        let next = open_floor(&admin, &setup, &floor.key, &setup.line).await;
        let n = u32::try_from(n).unwrap() + 10;
        assert_eq!(
            receipts(
                &admin.app,
                &floor.key,
                &[fact(
                    &record_id(n),
                    "shift_closed",
                    &next.shift,
                    shift_closed(Some(250), 249, 20, Some(code), &instant(7200, 0))
                )]
            )
            .await,
            vec![accepted(&record_id(n))]
        );
        assert_eq!(
            shift_state(&admin, &next.shift).await[4],
            json!(code),
            "{code}"
        );
    }
}

#[tokio::test]
async fn only_the_station_that_entered_an_open_shift_closes_it() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let planned = plan_shift(&admin, shift_body(&setup)).await;
    let planned = planned["id"].as_str().unwrap();
    let shift = floor.shift.as_str();
    let close = |n: u32, shift: &str| {
        fact(
            &record_id(n),
            "shift_closed",
            shift,
            shift_closed(None, 1, 0, None, &instant(60, 0)),
        )
    };
    let (open, waiting) = (
        shift_state(&admin, shift).await,
        shift_state(&admin, planned).await,
    );
    let (audit, revision) = (
        audit_rows(&admin.app).await,
        host_revision(&admin.app).await,
    );
    let kept = fact_rows(&admin.app).await;
    // A colleague that never entered the shift, a shift only planned, a
    // shift nobody made and a shift that is no id: none of them closes
    // anything, and the refusals are kept as receipts only.
    assert_eq!(
        receipts(&admin.app, &colleague_key, &[close(1, shift)]).await,
        vec![rejected(Some(&record_id(1)), "not_entered", None)]
    );
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[
                close(2, planned),
                close(3, "00000000-0000-4000-8000-0000000000ff"),
                close(4, "nope")
            ]
        )
        .await,
        vec![
            rejected(Some(&record_id(2)), "not_entered", None),
            rejected(Some(&record_id(3)), "unknown_shift", None),
            rejected(Some(&record_id(4)), "invalid_record", Some("shiftId")),
        ]
    );
    assert_eq!(shift_state(&admin, shift).await, open);
    assert_eq!(shift_state(&admin, planned).await, waiting);
    assert_eq!(audit_rows(&admin.app).await, audit);
    assert_eq!(host_revision(&admin.app).await, revision);
    let mut grown = kept.clone();
    grown["fact_receipts"] = json!(kept["fact_receipts"].as_i64().unwrap() + 4);
    assert_eq!(fact_rows(&admin.app).await, grown);
    // The office closes it; the colleague's facts for it are still refused
    // and mark nothing, where the owner's would mark it late.
    close_from_office(&admin, shift, "Станция не отвечает").await;
    let closed = shift_state(&admin, shift).await;
    assert_eq!(
        receipts(
            &admin.app,
            &colleague_key,
            &[
                close(5, shift),
                fact(
                    &record_id(6),
                    "scan",
                    shift,
                    ok_scan(1, &box_id(1), &instant(1, 0))
                )
            ]
        )
        .await,
        vec![
            rejected(Some(&record_id(5)), "not_entered", None),
            rejected(Some(&record_id(6)), "not_entered", None)
        ]
    );
    assert_eq!(shift_state(&admin, shift).await, closed);
    assert_eq!(closed[5], Value::Null);
    assert_eq!(close_events(&admin).await, Vec::<Value>::new());
}

#[tokio::test]
async fn the_office_closing_after_the_station_finds_the_shift_changed_and_closed() {
    let (admin, floor) = floor().await;
    let shift = floor.shift.as_str();
    let path = format!("/v1/office/shifts/{shift}");
    let (_, before) = admin.call("GET", &path, None).await;
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(1),
                "shift_closed",
                shift,
                shift_closed(None, 1, 0, None, &instant(60, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(1))]
    );
    let closed = shift_state(&admin, shift).await;
    let revision = host_revision(&admin.app).await;
    // An office form opened before the station's close is stale ...
    let (status, refused) = admin
        .call(
            "POST",
            &format!("{path}/close"),
            Some(json!({ "reason": "Станция не отвечает", "expectedRev": before["rev"] })),
        )
        .await;
    assert_eq!(
        (
            status,
            refused["error"]["code"].clone(),
            refused["error"]["details"].clone()
        ),
        (
            StatusCode::CONFLICT,
            json!("stale_revision"),
            json!({ "currentRev": revision })
        )
    );
    // ... and a fresh one finds the shift closed.
    let (status, refused) = admin
        .call(
            "POST",
            &format!("{path}/close"),
            Some(json!({ "reason": "Станция не отвечает", "expectedRev": revision })),
        )
        .await;
    assert_eq!(
        (
            status,
            refused["error"]["code"].clone(),
            refused["error"]["details"].clone()
        ),
        (
            StatusCode::CONFLICT,
            json!("conflict"),
            json!({ "constraint": "shift_status", "status": "closed" })
        )
    );
    assert_eq!(shift_state(&admin, shift).await, closed);
    assert_eq!(reason_text(&admin, shift).await, None);
    assert_eq!(audit_trail(&admin.app, "shift.close").await.len(), 1);
    assert_eq!(host_revision(&admin.app).await, revision);
}

/// The office closes the shift while a station's batch waits for the write
/// lock: the batch reads the shift once it holds the lock, so it finds the
/// shift closed (the batch's close is `alreadyClosed` and nothing of the
/// office's is overwritten; the batch's late scan takes the batch's one
/// revision). The batch is called directly and proved to wait at the lock
/// before the office writes, so no sleep decides which of them comes first.
#[tokio::test]
async fn a_batch_waiting_for_the_lock_finds_the_shift_the_office_closed_meanwhile() {
    let (admin, floor) = floor().await;
    let shift = floor.shift.as_str();
    let revision = host_revision(&admin.app).await;
    let audit = audit_rows(&admin.app).await;
    let mut holder = begin_write(&admin.app.state.pool).await.unwrap();
    let records = [
        fact(
            &record_id(1),
            "shift_closed",
            shift,
            shift_closed(None, 1, 0, None, &instant(60, 0)),
        ),
        fact(
            &record_id(2),
            "scan",
            shift,
            ok_scan(1, &box_id(1), &instant(61, 0)),
        ),
    ];
    let mut batch = Box::pin(receive_as(&admin, &floor.station, &records));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(200), &mut batch)
            .await
            .is_err(),
        "the batch answered while the office held the lock"
    );
    let rev = markiro_host::db::next_revision(&mut holder).await.unwrap();
    sqlx::query(
        "UPDATE shifts SET status = 'closed', closed_at = ?, closed_by_kind = 'office_user', \
         closed_by = ?, close_reason_text = 'Станция не отвечает', rev = ? WHERE id = ?",
    )
    .bind("2026-10-08T06:05:00Z")
    .bind(&admin.id)
    .bind(rev)
    .bind(shift)
    .execute(&mut *holder)
    .await
    .unwrap();
    holder.commit().await.unwrap();
    let (status, body) = batch.await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["receipts"],
        json!([
            { "id": record_id(1), "outcome": "accepted", "details": { "alreadyClosed": true } },
            accepted(&record_id(2))
        ])
    );
    // The scan is late, in the revision of the batch.
    let state = shift_state(&admin, shift).await;
    assert_eq!(
        state,
        json!([
            "closed",
            "2026-10-08T06:05:00Z",
            "office_user",
            admin.id,
            null,
            admin.app.state.timestamp(),
            revision + 2
        ])
    );
    assert_eq!(host_revision(&admin.app).await, revision + 2);
    assert_eq!(
        reason_text(&admin, shift).await.as_deref(),
        Some("Станция не отвечает")
    );
    assert_eq!(close_events(&admin).await[0][8], json!("already_closed"));
    assert_eq!(audit_rows(&admin.app).await, audit);
}

/// What a batch writes carries the moment it held the lock, not the moment
/// it arrived: a batch that waited behind the office's close is stamped
/// after that close, so its late mark never precedes the close it follows.
#[tokio::test]
async fn a_batch_is_stamped_when_it_holds_the_lock_not_when_it_arrived() {
    let (admin, floor) = floor().await;
    let shift = floor.shift.as_str();
    let mut holder = begin_write(&admin.app.state.pool).await.unwrap();
    let closed_at = admin.app.state.timestamp();
    let rev = markiro_host::db::next_revision(&mut holder).await.unwrap();
    sqlx::query(
        "UPDATE shifts SET status = 'closed', closed_at = ?, closed_by_kind = 'office_user', \
         closed_by = ?, close_reason_text = 'Станция не отвечает', rev = ? WHERE id = ?",
    )
    .bind(&closed_at)
    .bind(&admin.id)
    .bind(rev)
    .bind(shift)
    .execute(&mut *holder)
    .await
    .unwrap();
    let records = [fact(
        &record_id(1),
        "scan",
        shift,
        ok_scan(1, &box_id(1), &instant(61, 0)),
    )];
    let mut batch = Box::pin(receive_as(&admin, &floor.station, &records));
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(200), &mut batch)
            .await
            .is_err(),
        "the batch answered while the office held the lock"
    );
    // The batch has arrived and waits; a minute passes before it gets in.
    admin.app.clock.advance(time::Duration::minutes(1));
    let held_at = admin.app.state.timestamp();
    assert_ne!(held_at, closed_at);
    holder.commit().await.unwrap();
    let (status, body) = batch.await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["receipts"], json!([accepted(&record_id(1))]));
    let stamped: Vec<(String, String)> = sqlx::query_as(
        "SELECT 'receipt', received_at FROM fact_receipts UNION ALL \
         SELECT 'scan', received_at FROM scans",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        stamped,
        vec![
            ("receipt".to_owned(), held_at.clone()),
            ("scan".to_owned(), held_at.clone())
        ]
    );
    let state = shift_state(&admin, shift).await;
    assert_eq!(state[1], json!(closed_at));
    assert_eq!(state[5], json!(held_at));
    assert!(held_at > closed_at, "the late mark precedes the close");
}

#[tokio::test]
async fn late_data_marks_a_shift_once_in_the_batch_that_brings_it_and_only_that_shift() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let other = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let shift = floor.shift.as_str();
    // The colleague scanned code 7 first.
    receipts(
        &admin.app,
        &colleague_key,
        &[fact(
            &record_id(50),
            "scan",
            &other.shift,
            ok_scan(7, &box_id(50), &instant(1, 0)),
        )],
    )
    .await;
    receipts(
        &admin.app,
        &floor.key,
        &[fact(
            &record_id(1),
            "scan",
            shift,
            ok_scan(1, &box_id(1), &instant(2, 0)),
        )],
    )
    .await;
    close_from_office(&admin, shift, "Станция не отвечает").await;
    let (open_one, closed) = (
        shift_state(&admin, &other.shift).await,
        shift_state(&admin, shift).await,
    );
    let revision = host_revision(&admin.app).await;
    let mut wake = admin.app.state.revisions.subscribe();
    wake.borrow_and_update();
    // A record already received comes again after the close: its stored
    // receipt, no new fact, so no mark.
    admin.app.clock.advance(time::Duration::minutes(2));
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(1),
                "scan",
                shift,
                ok_scan(1, &box_id(1), &instant(2, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(1))]
    );
    assert_eq!(shift_state(&admin, shift).await, closed);
    assert_eq!(host_revision(&admin.app).await, revision);
    assert!(!wake.has_changed().unwrap());
    // A scan that loses its code to the colleague is a `conflict` and a
    // fact of the closed shift all the same: it marks the shift late, and
    // only this shift.
    let lost = receipts(
        &admin.app,
        &floor.key,
        &[fact(
            &record_id(2),
            "scan",
            shift,
            ok_scan(7, &box_id(1), &instant(3, 0)),
        )],
    )
    .await;
    assert_eq!(lost[0]["outcome"], json!("conflict"));
    let marked = admin.app.state.timestamp();
    assert_eq!(
        shift_state(&admin, shift).await,
        json!([
            "closed",
            closed[1],
            "office_user",
            admin.id,
            null,
            marked,
            revision + 1
        ])
    );
    assert_eq!(shift_state(&admin, &other.shift).await, open_one);
    assert_eq!(*wake.borrow_and_update(), revision + 1);
    // Another batch, another minute: the first mark stays and the shift's
    // revision does not move.
    admin.app.clock.advance(time::Duration::minutes(1));
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(3),
                "scan",
                shift,
                ok_scan(2, &box_id(1), &instant(4, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(3))]
    );
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert_eq!(shift_state(&admin, shift).await[5], json!(marked));
    // The data is in the office's reading, too.
    let (_, office) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}"), None)
        .await;
    assert_eq!(office["lateDataAt"], json!(marked));
    assert_eq!(office["rev"], json!(revision + 1));
}

#[tokio::test]
async fn facts_after_the_stations_own_close_come_late_in_a_batch_of_their_own() {
    let (admin, floor) = floor().await;
    let shift = floor.shift.as_str();
    let revision = host_revision(&admin.app).await;
    receipts(
        &admin.app,
        &floor.key,
        &[fact(
            &record_id(1),
            "shift_closed",
            shift,
            shift_closed(None, 1, 0, None, &instant(60, 0)),
        )],
    )
    .await;
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert_eq!(shift_state(&admin, shift).await[5], Value::Null);
    admin.app.clock.advance(time::Duration::minutes(9));
    let late_at = admin.app.state.timestamp();
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(2),
                "scan",
                shift,
                ok_scan(1, &box_id(1), &instant(50, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(2))]
    );
    // The close and the late mark are two batches, two revisions.
    assert_eq!(
        shift_state(&admin, shift).await,
        json!([
            "closed",
            "2026-10-08T06:01:00Z",
            "device",
            floor.station,
            null,
            late_at,
            revision + 2
        ])
    );
    assert_eq!(host_revision(&admin.app).await, revision + 2);
}

#[tokio::test]
async fn a_batch_that_closes_a_shift_is_written_whole_or_not_at_all() {
    let (admin, floor) = floor().await;
    let shift = floor.shift.as_str();
    sqlx::query(&format!(
        "CREATE TRIGGER break_the_receipt BEFORE INSERT ON fact_receipts \
         WHEN NEW.record_id = '{}' BEGIN SELECT RAISE(ABORT, 'broken'); END",
        record_id(2)
    ))
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    // The close is written, then the fact after it marks the shift late,
    // then its receipt breaks.
    let batch = vec![
        fact(
            &record_id(1),
            "shift_closed",
            shift,
            shift_closed(None, 1, 0, None, &instant(60, 0)),
        ),
        fact(
            &record_id(2),
            "scan",
            shift,
            ok_scan(1, &box_id(1), &instant(61, 0)),
        ),
    ];
    let (state, rows, audit, revision) = (
        shift_state(&admin, shift).await,
        fact_rows(&admin.app).await,
        audit_rows(&admin.app).await,
        host_revision(&admin.app).await,
    );
    let mut wake = admin.app.state.revisions.subscribe();
    wake.borrow_and_update();
    let (status, failed) = send_facts(&admin.app, &floor.key, &batch).await;
    assert_eq!(
        (status, failed["error"]["code"].clone()),
        (StatusCode::INTERNAL_SERVER_ERROR, json!("internal"))
    );
    assert_eq!(shift_state(&admin, shift).await, state);
    assert_eq!(fact_rows(&admin.app).await, rows);
    assert_eq!(audit_rows(&admin.app).await, audit);
    assert_eq!(host_revision(&admin.app).await, revision);
    assert!(!wake.has_changed().unwrap());
    sqlx::query("DROP TRIGGER break_the_receipt")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![accepted(&record_id(1)), accepted(&record_id(2))]
    );
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert_eq!(audit_trail(&admin.app, "shift.close").await.len(), 1);
}

#[tokio::test]
async fn a_close_is_checked_whole_and_a_refusal_leaves_the_shift_open() {
    let (admin, floor) = floor().await;
    let shift = floor.shift.as_str();
    let close = |n: u32, data: Value| fact(&record_id(n), "shift_closed", shift, data);
    let good = || shift_closed(Some(250), 249, 20, Some("equipment_stop"), &instant(60, 0));
    let with = |key: &str, value: Value| {
        let mut data = good();
        data[key] = value;
        data
    };
    let mut extra = good();
    extra["operatorNote"] = json!("x");
    let mut no_instant = good();
    no_instant.as_object_mut().unwrap().remove("closedAt");
    let mut bad_operator = close(14, good());
    bad_operator["operatorId"] = json!("nope");
    let batch = vec![
        close(1, extra),
        close(2, with("actualQty", json!(-1))),
        close(3, with("actualQty", json!(1.5))),
        close(4, with("actualQty", json!("249"))),
        close(5, with("closedBoxCount", json!(-1))),
        close(6, no_instant),
        close(7, with("closedAt", json!("2026-10-08T06:01:00Z"))),
        close(8, with("closedAt", json!("2026-10-08T06:01:00.000+00:00"))),
        close(9, with("closedAt", json!("2026-10-08T06:01:00.000z"))),
        close(10, with("reasonCode", json!(" equipment_stop"))),
        close(11, with("reasonCode", json!("EQUIPMENT_STOP"))),
        close(12, with("reasonCode", json!(""))),
        close(13, with("reasonCode", json!(null))),
        bad_operator,
    ];
    let before = (
        shift_state(&admin, shift).await,
        audit_rows(&admin.app).await,
        host_revision(&admin.app).await,
    );
    let kept = fact_rows(&admin.app).await;
    let field = |n: u32, field: &str| rejected(Some(&record_id(n)), "invalid_record", Some(field));
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        vec![
            field(1, "data"),
            field(2, "data"),
            field(3, "data"),
            field(4, "data"),
            field(5, "data"),
            field(6, "data"),
            field(7, "data.closedAt"),
            field(8, "data.closedAt"),
            field(9, "data.closedAt"),
            field(10, "data.reasonCode"),
            field(11, "data.reasonCode"),
            field(12, "data.reasonCode"),
            field(13, "data.reasonCode"),
            field(14, "operatorId"),
        ]
    );
    assert_eq!(
        (
            shift_state(&admin, shift).await,
            audit_rows(&admin.app).await,
            host_revision(&admin.app).await
        ),
        before
    );
    let mut grown = kept.clone();
    grown["fact_receipts"] = json!(kept["fact_receipts"].as_i64().unwrap() + 14);
    assert_eq!(fact_rows(&admin.app).await, grown);
}

/// The office's totals of `shift`: by `GET …/{id}`, and the same in the list.
async fn totals(admin: &Admin, shift: &str) -> Value {
    let (status, read) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{read}");
    let (status, list) = admin.call("GET", "/v1/office/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let listed = list
        .as_array()
        .unwrap()
        .iter()
        .find(|listed| listed["id"] == json!(shift))
        .expect("the list holds the shift");
    assert_eq!(listed["totals"], read["totals"]);
    read["totals"].clone()
}

#[tokio::test]
async fn the_office_reads_a_shifts_totals_from_its_facts() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let planned = plan_shift(&admin, shift_body(&setup)).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let none = json!({
        "acceptedUnits": 0, "unitsInClosedBoxes": 0, "closedBoxes": 0, "openBoxes": 0,
        "lastFactAt": null, "deviceIds": [], "closedPallets": 0, "openPallets": 0
    });
    assert_eq!(totals(&admin, planned["id"].as_str().unwrap()).await, none);
    let mut entered = none.clone();
    entered["deviceIds"] = json!([floor.station]);
    assert_eq!(totals(&admin, &floor.shift).await, entered);
    let shift = floor.shift.as_str();
    let scan = |n: u32, box_n: u32| {
        fact(
            &record_id(n),
            "scan",
            shift,
            ok_scan(n, &box_id(box_n), &instant(n, 0)),
        )
    };
    let undo = |n: u32, code: u32, box_n: u32| {
        let mut data = box_exception("undo", &box_id(box_n), &instant(100 + n, 0));
        data["codeHash"] = json!(code_hash(code));
        data["targetScannedAt"] = json!(instant(code, 0));
        fact(&record_id(n), "box_exception", shift, data)
    };
    // Box 1 holds 1–3 and closes; box 2 holds 4 and 5, and 5 is undone; box
    // 3 holds 6, undone, so it is open but empty; box 4 holds 7, closes and
    // is taken apart; box 5 holds 9, which the colleague's earlier scan takes
    // below; a scan that is no code counts nothing. The units are the shift's
    // live items (5: boxes 1, 2 and 5), and those among them in a closed box
    // that was not taken apart (3: box 1) are what the office's card calls
    // the codes in closed boxes.
    let batch = vec![
        scan(1, 1),
        scan(2, 1),
        scan(3, 1),
        fact(
            &record_id(20),
            "box_closed",
            shift,
            box_closed(
                &box_id(1),
                &block,
                1500,
                &[1, 2, 3],
                &instant(1, 0),
                &instant(10, 0),
            ),
        ),
        scan(4, 2),
        scan(5, 2),
        undo(21, 5, 2),
        scan(6, 3),
        undo(22, 6, 3),
        scan(7, 4),
        scan(9, 5),
        fact(
            &record_id(23),
            "box_closed",
            shift,
            box_closed(
                &box_id(4),
                &block,
                1501,
                &[7],
                &instant(7, 0),
                &instant(11, 0),
            ),
        ),
        fact(&record_id(24), "box_exception", shift, {
            let mut data = box_exception("disassemble", &box_id(4), &instant(12, 0));
            data["reasonCode"] = json!("wrong_quantity");
            data
        }),
        fact(
            &record_id(25),
            "scan",
            shift,
            other_scan(
                "invalid",
                "unknown",
                Value::Null,
                Value::Null,
                &instant(13, 0),
            ),
        ),
    ];
    admin.app.clock.advance(time::Duration::minutes(5));
    let first_batch = admin.app.state.timestamp();
    let answered = receipts(&admin.app, &floor.key, &batch).await;
    assert!(
        answered
            .iter()
            .all(|receipt| receipt["outcome"] == "accepted"),
        "{answered:?}"
    );
    assert_eq!(
        totals(&admin, shift).await,
        json!({
            "acceptedUnits": 5, "unitsInClosedBoxes": 3, "closedBoxes": 1, "openBoxes": 2,
            "lastFactAt": first_batch, "deviceIds": [floor.station],
            "closedPallets": 0, "openPallets": 0
        })
    );
    // The number is a definition, not a side effect of the exceptions: an
    // item still live in a box taken apart (no fact leaves one) would be a
    // unit but never a code in a closed box.
    let removed: String = sqlx::query_scalar("SELECT removed_at FROM box_items WHERE box_id = ?")
        .bind(box_id(4))
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE box_items SET removed_at = NULL WHERE box_id = ?")
        .bind(box_id(4))
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let revived = totals(&admin, shift).await;
    assert_eq!(
        (
            &revived["acceptedUnits"],
            &revived["unitsInClosedBoxes"],
            &revived["closedBoxes"]
        ),
        (&json!(6), &json!(3), &json!(1))
    );
    sqlx::query("UPDATE box_items SET removed_at = ? WHERE box_id = ?")
        .bind(removed)
        .bind(box_id(4))
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    // The colleague's earlier scans of codes 2 and 9 take them out of boxes 1
    // (closed, 2 codes left) and 5, which is open and empty then; a record
    // the host refuses still tells when the station last sent one.
    admin.app.clock.advance(time::Duration::minutes(5));
    let second_batch = admin.app.state.timestamp();
    let taken = receipts(
        &admin.app,
        &colleague.key,
        &[
            fact(
                &record_id(30),
                "scan",
                &colleague.shift,
                ok_scan(2, &box_id(9), &instant(0, 0)),
            ),
            fact(
                &record_id(32),
                "scan",
                &colleague.shift,
                ok_scan(9, &box_id(9), &instant(0, 0)),
            ),
        ],
    )
    .await;
    assert!(
        taken.iter().all(|receipt| receipt["outcome"] == "accepted"),
        "{taken:?}"
    );
    let mut wrong = ok_scan(8, &box_id(2), &instant(8, 0));
    wrong["code"]["gtin14"] = json!("04600682000099");
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(&record_id(31), "scan", shift, wrong)]
        )
        .await,
        vec![rejected(Some(&record_id(31)), "gtin_mismatch", None)]
    );
    assert_eq!(
        totals(&admin, shift).await,
        json!({
            "acceptedUnits": 3, "unitsInClosedBoxes": 2, "closedBoxes": 1, "openBoxes": 1,
            "lastFactAt": second_batch, "deviceIds": [floor.station],
            "closedPallets": 0, "openPallets": 0
        })
    );
    assert_eq!(
        totals(&admin, &colleague.shift).await,
        json!({
            "acceptedUnits": 2, "unitsInClosedBoxes": 0, "closedBoxes": 0, "openBoxes": 1,
            "lastFactAt": second_batch, "deviceIds": [colleague.station],
            "closedPallets": 0, "openPallets": 0
        })
    );
    // The devices come first entry first. A second device on a shift comes
    // with plan 2b, so its entry is put in directly: a device whose id sorts
    // after the station's, entered before it, so that first entry first is
    // neither the order of the ids nor the order of the rows. The id is built
    // (the largest a v4 UUID can be), not drawn: a random one sorts after the
    // station's only by chance.
    let other = "ffffffff-ffff-4fff-bfff-ffffffffffff".to_owned();
    assert!(other > floor.station);
    sqlx::query(
        "INSERT INTO devices (id, kind, name, key_hash, app_version, protocol, paired_at) \
         VALUES (?, 'station', 'Тестовое устройство', 'late-id-station', '0.1.0', 1, \
                 '2026-09-21T13:00:00Z')",
    )
    .bind(&other)
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO shift_participants (shift_id, device_id, first_entered_at, last_entered_at) \
         VALUES (?, ?, '2026-09-21T14:00:00Z', '2026-09-21T14:00:00Z')",
    )
    .bind(shift)
    .bind(&other)
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        totals(&admin, shift).await["deviceIds"],
        json!([other, floor.station])
    );
    // A record without a readable shift belongs to no shift's totals.
    admin.app.clock.advance(time::Duration::minutes(5));
    let mut unknown = scan(40, 2);
    unknown["shiftId"] = json!("5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b");
    receipts(&admin.app, &floor.key, &[unknown]).await;
    assert_eq!(
        totals(&admin, shift).await["lastFactAt"],
        json!(second_batch)
    );
    // The colleague's later facts, a box closed among them, change nothing in
    // this shift's totals but the numbers they are about: the colleague's own.
    let theirs = issue_block(&admin.app, &colleague.key, BLOCK_REQUEST).await;
    admin.app.clock.advance(time::Duration::minutes(5));
    let third_batch = admin.app.state.timestamp();
    let answered = receipts(
        &admin.app,
        &colleague.key,
        &[
            fact(
                &record_id(50),
                "scan",
                &colleague.shift,
                ok_scan(50, &box_id(10), &instant(50, 0)),
            ),
            fact(
                &record_id(51),
                "box_closed",
                &colleague.shift,
                box_closed(
                    &box_id(10),
                    &theirs,
                    theirs["fromSerial"].as_u64().unwrap(),
                    &[50],
                    &instant(50, 0),
                    &instant(51, 0),
                ),
            ),
        ],
    )
    .await;
    assert!(
        answered
            .iter()
            .all(|receipt| receipt["outcome"] == "accepted"),
        "{answered:?}"
    );
    let colleagues = json!({
        "acceptedUnits": 3, "unitsInClosedBoxes": 1, "closedBoxes": 1, "openBoxes": 1,
        "lastFactAt": third_batch, "deviceIds": [colleague.station],
        "closedPallets": 0, "openPallets": 0
    });
    assert_eq!(totals(&admin, &colleague.shift).await, colleagues);
    let floors = json!({
        "acceptedUnits": 3, "unitsInClosedBoxes": 2, "closedBoxes": 1, "openBoxes": 1,
        "lastFactAt": second_batch, "deviceIds": [other, floor.station],
        "closedPallets": 0, "openPallets": 0
    });
    assert_eq!(totals(&admin, shift).await, floors);
    // Every write of the office answers with the totals the list gives.
    let closed = close_from_office(&admin, shift, "Станция не отвечает").await;
    assert_eq!(closed["totals"], floors);
    assert_eq!(totals(&admin, shift).await, floors);
}

/// Migration `0012` applies to a host that already holds shifts, boxes and
/// scans: the database as it stood before `0012` takes the rows of a planned
/// and an open shift with a closed and an open box, and after the migration
/// every row is as it was, `boxes.pallet_id` is empty, no reference is
/// broken, and the new rules govern the old rows.
#[tokio::test]
async fn migration_0012_applies_to_a_host_that_already_holds_shifts_and_boxes() {
    use sqlx::sqlite::SqliteConnectOptions;
    use sqlx::{ConnectOptions, Connection};
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    plan_shift(&admin, shift_body(&setup)).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let shift = floor.shift.as_str();
    // Box 1 (codes 1 and 2) is closed, box 2 (code 3) stays open.
    let scans: Vec<Value> = [(1, 1), (2, 1), (3, 2)]
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
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(11),
                "box_closed",
                shift,
                box_closed(
                    &box_id(1),
                    &block,
                    1500,
                    &[1, 2],
                    &instant(0, 500),
                    &instant(20, 0)
                )
            )]
        )
        .await,
        vec![accepted(&record_id(11))]
    );
    // The host's database as it is now, and an empty one at the schema
    // before `0012`: the migrations of the directory, but the last.
    let dir = tempfile::tempdir().unwrap();
    let snapshot = dir.path().join("snapshot.db");
    sqlx::query("VACUUM INTO ?")
        .bind(snapshot.to_str().unwrap())
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let before_0012 = dir.path().join("migrations");
    std::fs::create_dir(&before_0012).unwrap();
    let applied = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    for entry in std::fs::read_dir(&applied).unwrap() {
        let entry = entry.unwrap();
        if entry.file_name().to_str().unwrap() < "0012" {
            std::fs::copy(entry.path(), before_0012.join(entry.file_name())).unwrap();
        }
    }
    let mut old = SqliteConnectOptions::new()
        .filename(dir.path().join("old.db"))
        .create_if_missing(true)
        .foreign_keys(false)
        .connect()
        .await
        .unwrap();
    sqlx::migrate::Migrator::new(before_0012.as_path())
        .await
        .unwrap()
        .run(&mut old)
        .await
        .unwrap();
    let new_objects: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('pallets', 'pallet_exceptions', \
         'shifts_pallets_insert', 'shifts_pallets_update', 'shifts_planned_pallet_template')",
    )
    .fetch_one(&mut old)
    .await
    .unwrap();
    let pallet_columns: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('boxes') WHERE name = 'pallet_id'",
    )
    .fetch_one(&mut old)
    .await
    .unwrap();
    assert_eq!((new_objects, pallet_columns), (0, 0));
    // Every row of the host goes into it, table by table, column by column
    // of the old schema (the reference rows the migrations insert are the
    // same on both sides).
    sqlx::query("ATTACH DATABASE ? AS source")
        .bind(snapshot.to_str().unwrap())
        .execute(&mut old)
        .await
        .unwrap();
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' \
         AND name <> '_sqlx_migrations' ORDER BY name",
    )
    .fetch_all(&mut old)
    .await
    .unwrap();
    for table in &tables {
        let columns: Vec<String> =
            sqlx::query_scalar("SELECT name FROM pragma_table_info(?) ORDER BY cid")
                .bind(table)
                .fetch_all(&mut old)
                .await
                .unwrap();
        let columns = columns.join(", ");
        sqlx::query(&format!(
            "INSERT OR REPLACE INTO main.{table} ({columns}) SELECT {columns} FROM source.{table}"
        ))
        .execute(&mut old)
        .await
        .unwrap();
    }
    sqlx::query("DETACH DATABASE source")
        .execute(&mut old)
        .await
        .unwrap();
    // The rows are loaded with enforcement off, but the host opens its database
    // with it on, so the migration itself runs with it on.
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut old)
        .await
        .unwrap();
    async fn rows_of(old: &mut sqlx::SqliteConnection, tables: &[String]) -> Vec<(String, i64)> {
        let mut counts = Vec::new();
        for table in tables {
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                .fetch_one(&mut *old)
                .await
                .unwrap();
            counts.push((table.clone(), count));
        }
        counts
    }
    async fn digest_of(old: &mut sqlx::SqliteConnection) -> (String, String) {
        let shifts: String = sqlx::query_scalar(
            "SELECT group_concat(id || '|' || number_seq || '|' || status || '|' || \
             pallets_enabled || '|' || ifnull(pallet_box_capacity, '-') || '|' || \
             ifnull(pallet_template_id, '-') || '|' || box_capacity || '|' || rev, ';') \
             FROM (SELECT * FROM shifts ORDER BY id)",
        )
        .fetch_one(&mut *old)
        .await
        .unwrap();
        let boxes: String = sqlx::query_scalar(
            "SELECT group_concat(id || '|' || ifnull(sscc, '-') || '|' || ifnull(closed_at, '-') \
             || '|' || ifnull(serial, '-') || '|' || ifnull(membership_digest, '-'), ';') \
             FROM (SELECT * FROM boxes ORDER BY id)",
        )
        .fetch_one(&mut *old)
        .await
        .unwrap();
        (shifts, boxes)
    }
    let counts = rows_of(&mut old, &tables).await;
    let digest = digest_of(&mut old).await;
    let count = |table: &str| counts.iter().find(|(name, _)| name == table).unwrap().1;
    assert_eq!((count("shifts"), count("boxes"), count("scans")), (2, 2, 3));
    // Now the migration.
    markiro_host::db::MIGRATOR.run(&mut old).await.unwrap();
    let migrated: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE success")
        .fetch_one(&mut old)
        .await
        .unwrap();
    assert_eq!(
        migrated,
        i64::try_from(markiro_host::db::MIGRATOR.iter().count()).unwrap()
    );
    assert_eq!(rows_of(&mut old, &tables).await, counts);
    assert_eq!(digest_of(&mut old).await, digest);
    let (pallets, exceptions, linked): (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM pallets), (SELECT COUNT(*) FROM pallet_exceptions), \
         (SELECT COUNT(*) FROM boxes WHERE pallet_id IS NOT NULL)",
    )
    .fetch_one(&mut old)
    .await
    .unwrap();
    assert_eq!((pallets, exceptions, linked), (0, 0, 0));
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut old)
        .await
        .unwrap();
    let broken = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut old)
        .await
        .unwrap();
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut old)
        .await
        .unwrap();
    assert_eq!((broken.len(), integrity.as_str()), (0, "ok"));
    // The old rows live under the new rules: a closed box joins a pallet, an
    // open one does not, and a planned shift cannot switch pallets on bare.
    let (owner,): (String,) =
        sqlx::query_as("SELECT owner_device_id FROM shifts WHERE status = 'active'")
            .fetch_one(&mut old)
            .await
            .unwrap();
    sqlx::query(
        "INSERT INTO pallets (id, shift_id, device_id, opened_at, received_at) \
         VALUES ('pallet-1', ?, ?, 'x', 'x')",
    )
    .bind(shift)
    .bind(&owner)
    .execute(&mut old)
    .await
    .unwrap();
    let joined = sqlx::query("UPDATE boxes SET pallet_id = 'pallet-1' WHERE closed_at IS NOT NULL")
        .execute(&mut old)
        .await
        .unwrap();
    assert_eq!(joined.rows_affected(), 1);
    let open_box = sqlx::query("UPDATE boxes SET pallet_id = 'pallet-1' WHERE closed_at IS NULL")
        .execute(&mut old)
        .await
        .unwrap_err()
        .to_string();
    assert!(open_box.contains("CHECK constraint failed"), "{open_box}");
    let bare = sqlx::query("UPDATE shifts SET pallets_enabled = 1 WHERE status = 'planned'")
        .execute(&mut old)
        .await
        .unwrap_err()
        .to_string();
    assert!(
        bare.contains("shift pallets: capacity and template exactly when enabled"),
        "{bare}"
    );
    old.close().await.unwrap();
}

/// A station takes a box apart and packs its codes again, clears an open box and fills it
/// again, undoes a scan and takes it again — and the records reach the host in one batch (the
/// cloud's #650 lost such codes: it applied a batch's exceptions after its scans). The host
/// applies a batch record by record in the station's order, so each exception frees its codes
/// before the scan that takes them again: every record is accepted, the new scans hold the
/// codes, and no conflict is written.
#[tokio::test]
async fn codes_freed_and_scanned_again_in_one_batch_go_to_the_new_scan() {
    let (admin, floor) = floor().await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let shift = floor.shift.as_str();
    let scan = |n: u32, code: u32, box_n: u32, second: u32| {
        fact(
            &record_id(n),
            "scan",
            shift,
            ok_scan(code, &box_id(box_n), &instant(second, 0)),
        )
    };
    let mut disassemble = box_exception("disassemble", &box_id(1), &instant(11, 0));
    disassemble["reasonCode"] = json!("wrong_quantity");
    let mut undo = box_exception("undo", &box_id(3), &instant(31, 0));
    undo["codeHash"] = json!(code_hash(5));
    undo["targetScannedAt"] = json!(instant(30, 0));
    let batch = vec![
        // A closed box taken apart, its codes packed into another box.
        scan(1, 1, 1, 1),
        scan(2, 2, 1, 2),
        fact(
            &record_id(3),
            "box_closed",
            shift,
            box_closed(
                &box_id(1),
                &block,
                1500,
                &[1, 2],
                &instant(1, 0),
                &instant(10, 0),
            ),
        ),
        fact(&record_id(4), "box_exception", shift, disassemble),
        scan(5, 1, 2, 12),
        scan(6, 2, 2, 13),
        fact(
            &record_id(7),
            "box_closed",
            shift,
            box_closed(
                &box_id(2),
                &block,
                1501,
                &[1, 2],
                &instant(12, 0),
                &instant(20, 0),
            ),
        ),
        // An open box cleared and filled again.
        scan(8, 3, 4, 21),
        fact(
            &record_id(9),
            "box_exception",
            shift,
            box_exception("clear", &box_id(4), &instant(22, 0)),
        ),
        scan(10, 3, 4, 23),
        // A scan undone and taken again.
        scan(11, 5, 3, 30),
        fact(&record_id(12), "box_exception", shift, undo),
        scan(13, 5, 3, 32),
    ];
    let all: Vec<Value> = (1..=13).map(|n| accepted(&record_id(n))).collect();
    assert_eq!(receipts(&admin.app, &floor.key, &batch).await, all);
    assert_eq!(conflicts(&admin).await, Vec::<Value>::new());
    assert_eq!(
        owned(&admin).await,
        sorted(vec![
            (code_hash(1), record_id(5)),
            (code_hash(2), record_id(6)),
            (code_hash(3), record_id(10)),
            (code_hash(5), record_id(13)),
        ])
    );
    assert_eq!(
        items(&admin, &box_id(1)).await,
        vec![
            json!([
                record_id(1),
                code_hash(1),
                instant(1, 0),
                instant(11, 0),
                null
            ]),
            json!([
                record_id(2),
                code_hash(2),
                instant(2, 0),
                instant(11, 0),
                null
            ]),
        ]
    );
    assert_eq!(
        items(&admin, &box_id(2)).await,
        vec![
            json!([record_id(5), code_hash(1), instant(12, 0), null, null]),
            json!([record_id(6), code_hash(2), instant(13, 0), null, null]),
        ]
    );
    assert_eq!(
        items(&admin, &box_id(4)).await,
        vec![
            json!([
                record_id(8),
                code_hash(3),
                instant(21, 0),
                instant(22, 0),
                null
            ]),
            json!([record_id(10), code_hash(3), instant(23, 0), null, null]),
        ]
    );
    // The batch once more: the same receipts, nothing written again.
    let kept = fact_rows(&admin.app).await;
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        (1..=13)
            .map(|n| accepted(&record_id(n)))
            .collect::<Vec<_>>()
    );
    assert_eq!(fact_rows(&admin.app).await, kept);
}
