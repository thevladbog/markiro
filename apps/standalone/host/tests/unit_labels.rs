//! `unit_label` facts on the host (plan РЕЖ, task B3): one event of the job
//! that prints the Data Matrix duplicate of a code a validation shift
//! accepted. Taken only in a validation shift that prints, for a code this
//! station accepted in this shift (`subject_unknown` otherwise); every rule a
//! row keeps is `invalid_record`, never a database error; idempotent by the
//! record's id and content; late after a close; no audit row.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    accepted, admin, audit_rows, box_id, close_from_office, code_hash, fact, host_revision,
    instant, json as json_request, office_template, ok_scan, pair_device, plan_shift, receipts,
    record_id, rejected, request, shift_body, shift_setup, with_device, Admin, ShiftSetup,
};

const JOB: &str = "2e7f4a9c-6b1d-4c3e-9a5f-8d0b1c2e3f4a";
const OPERATOR: &str = "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d";

/// A station inside an open shift.
struct Floor {
    shift: String,
    station: String,
    key: String,
}

/// Put the station of `key` on `line`, plan a shift of `body` there and
/// enter it naming both capabilities of a validation shift that prints.
async fn open(admin: &Admin, key: &str, line: &str, mut body: Value) -> Floor {
    let (status, device) = admin
        .app
        .send(support::app::empty(with_device(
            request("GET", "/v1/device"),
            key,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{device}");
    let (status, moved) = admin
        .app
        .send(json_request(
            with_device(request("PUT", "/v1/device/line"), key),
            json!({ "lineId": line }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    body["lineId"] = json!(line);
    let shift = plan_shift(admin, body).await;
    let path = format!("/v1/device/shifts/{}/enter", shift["id"].as_str().unwrap());
    let (status, entered) = admin
        .app
        .send(json_request(
            with_device(request("POST", &path), key),
            json!({ "supports": ["validation-v1", "validation-dm-duplicate-v1"] }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    Floor {
        shift: shift["id"].as_str().unwrap().to_owned(),
        station: device["id"].as_str().unwrap().to_owned(),
        key: key.to_owned(),
    }
}

/// A validation shift of `setup`'s product that prints with a new duplicate
/// template, the check of the label `verification`.
async fn printing_body(admin: &Admin, setup: &ShiftSetup, verification: &str) -> Value {
    let template = office_template(admin, "product_duplicate", true, Value::Null).await;
    let mut body = shift_body(setup);
    body["mode"] = json!("validation");
    body["validationPrint"] =
        json!({ "mode": "duplicate_dm", "verification": verification, "templateId": template });
    body
}

/// An administrator's host with its station inside an open validation shift
/// that prints.
async fn printing_floor(verification: &str) -> (Admin, ShiftSetup, Floor) {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let body = printing_body(&admin, &setup, verification).await;
    let key = admin.key.clone();
    let floor = open(&admin, &key, &setup.line, body).await;
    (admin, setup, floor)
}

/// The `data` of an accepted scan of a validation shift of code `n`.
fn checked_scan(n: u32, at: &str) -> Value {
    let mut scan = ok_scan(n, &box_id(0), at);
    scan["boxId"] = Value::Null;
    scan
}

/// The `data` of an event of the job of code `n`.
fn label(n: u32, attempt: u32, event: &str, at: &str) -> Value {
    json!({
        "jobId": JOB, "codeHash": code_hash(n), "attemptNo": attempt, "event": event,
        "reason": null, "errorCode": null, "payloadDigest": code_hash(700 + n),
        "bytesDigest": code_hash(800 + n), "at": at
    })
}

/// Every event the host keeps, by record.
async fn events(admin: &Admin) -> Vec<Value> {
    type EventRow = (
        String,
        String,
        String,
        Option<String>,
        String,
        String,
        i64,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
        String,
        String,
    );
    let rows: Vec<EventRow> = sqlx::query_as(
        "SELECT record_id, device_id, shift_id, operator_id, job_id, code_hash, attempt_no, \
         event, reason, error_code, payload_digest, bytes_digest, at, received_at \
         FROM unit_label_events ORDER BY record_id",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|row| {
            json!([
                row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8, row.9, row.10,
                row.11, row.12, row.13
            ])
        })
        .collect()
}

async fn event_count(admin: &Admin) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM unit_label_events")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

/// The events of an accepted unit are kept as the station sent them, with
/// the record, the station, the shift, the operator and the host's clock; the
/// receipt is kept with its kind and shift. They write no audit row and take
/// no revision. The same batch again gets the same receipts and writes
/// nothing; the same id with other content is `payload_mismatch`.
#[tokio::test]
async fn the_events_of_an_accepted_unit_are_kept_as_sent() {
    let (admin, _, floor) = printing_floor("required").await;
    let scan = fact(
        &record_id(1),
        "scan",
        &floor.shift,
        checked_scan(1, &instant(1, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[scan]).await,
        [accepted(&record_id(1))]
    );
    let rows = audit_rows(&admin.app).await;
    let revision = host_revision(&admin.app).await;
    let mut prepared = fact(
        &record_id(2),
        "unit_label",
        &floor.shift,
        label(1, 1, "prepared", &instant(1, 0)),
    );
    prepared["operatorId"] = json!(OPERATOR);
    let mut rejected_label = label(1, 1, "verification_rejected", &instant(4, 0));
    rejected_label["errorCode"] = json!("mismatch");
    let mut reprint = label(1, 2, "prepared", &instant(5, 0));
    reprint["reason"] = json!("damaged");
    let batch = [
        prepared,
        fact(
            &record_id(3),
            "unit_label",
            &floor.shift,
            label(1, 1, "sending", &instant(2, 0)),
        ),
        fact(
            &record_id(4),
            "unit_label",
            &floor.shift,
            label(1, 1, "sent", &instant(3, 0)),
        ),
        fact(&record_id(5), "unit_label", &floor.shift, rejected_label),
        fact(&record_id(6), "unit_label", &floor.shift, reprint),
    ];
    let answered = receipts(&admin.app, &floor.key, &batch).await;
    assert_eq!(
        answered,
        (2..=6).map(|n| accepted(&record_id(n))).collect::<Vec<_>>()
    );
    let received = admin.app.state.timestamp();
    let row = |n: u32,
               operator: Value,
               attempt: i64,
               event: &str,
               reason: Value,
               error: Value,
               at: &str| {
        json!([
            record_id(n),
            floor.station,
            floor.shift,
            operator,
            JOB,
            code_hash(1),
            attempt,
            event,
            reason,
            error,
            code_hash(701),
            code_hash(801),
            at,
            received
        ])
    };
    assert_eq!(
        events(&admin).await,
        vec![
            row(
                2,
                json!(OPERATOR),
                1,
                "prepared",
                Value::Null,
                Value::Null,
                &instant(1, 0)
            ),
            row(
                3,
                Value::Null,
                1,
                "sending",
                Value::Null,
                Value::Null,
                &instant(2, 0)
            ),
            row(
                4,
                Value::Null,
                1,
                "sent",
                Value::Null,
                Value::Null,
                &instant(3, 0)
            ),
            row(
                5,
                Value::Null,
                1,
                "verification_rejected",
                Value::Null,
                json!("mismatch"),
                &instant(4, 0)
            ),
            row(
                6,
                Value::Null,
                2,
                "prepared",
                json!("damaged"),
                Value::Null,
                &instant(5, 0)
            ),
        ]
    );
    let kept: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT record_id, kind, shift_id FROM fact_receipts WHERE record_id <> ? \
         ORDER BY record_id",
    )
    .bind(record_id(1))
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        kept,
        (2..=6)
            .map(|n| (
                record_id(n),
                Some("unit_label".to_owned()),
                Some(floor.shift.clone())
            ))
            .collect::<Vec<_>>()
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
    // Again: the same receipts, nothing more.
    assert_eq!(receipts(&admin.app, &floor.key, &batch).await, answered);
    assert_eq!(event_count(&admin).await, 5);
    // The same id with other content.
    let mut other = batch[2].clone();
    other["data"]["at"] = json!(instant(9, 0));
    assert_eq!(
        receipts(&admin.app, &floor.key, &[other]).await,
        [rejected(Some(&record_id(4)), "payload_mismatch", None)]
    );
    assert_eq!(event_count(&admin).await, 5);
}

/// An event names a code this station accepted in this shift: no scan of
/// it, a scan another station accepted in its own shift, a scan of it that
/// was not accepted, or this station's scan of it in another shift is
/// `subject_unknown`, and nothing is kept but the receipt. The other station's own event of its code is taken.
#[tokio::test]
async fn an_event_needs_an_accepted_scan_of_its_code_by_this_station_in_this_shift() {
    let (admin, setup, floor) = printing_floor("none").await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let body = printing_body(&admin, &setup, "none").await;
    let colleague = open(&admin, &colleague_key, &setup.other_line, body).await;
    let mut duplicate_scan = checked_scan(3, &instant(2, 0));
    duplicate_scan["verdict"] = json!("duplicate");
    duplicate_scan["duplicateSource"] = json!("local");
    assert_eq!(
        receipts(
            &admin.app,
            &colleague.key,
            &[fact(
                &record_id(1),
                "scan",
                &colleague.shift,
                checked_scan(2, &instant(1, 0))
            )]
        )
        .await,
        [accepted(&record_id(1))]
    );
    let scans = [
        fact(
            &record_id(2),
            "scan",
            &floor.shift,
            checked_scan(3, &instant(1, 0)),
        ),
        fact(&record_id(3), "scan", &floor.shift, duplicate_scan),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &scans).await,
        [accepted(&record_id(2)), accepted(&record_id(3))]
    );
    // Code 3's accepted scan is record 2; a duplicate of code 4 accepts
    // nothing.
    let mut duplicate_of_4 = checked_scan(4, &instant(3, 0));
    duplicate_of_4["verdict"] = json!("duplicate");
    duplicate_of_4["duplicateSource"] = json!("host");
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(&record_id(4), "scan", &floor.shift, duplicate_of_4)]
        )
        .await,
        [accepted(&record_id(4))]
    );
    let batch = [
        fact(
            &record_id(10),
            "unit_label",
            &floor.shift,
            label(1, 1, "prepared", &instant(5, 0)),
        ),
        fact(
            &record_id(11),
            "unit_label",
            &floor.shift,
            label(2, 1, "prepared", &instant(5, 0)),
        ),
        fact(
            &record_id(12),
            "unit_label",
            &floor.shift,
            label(4, 1, "prepared", &instant(5, 0)),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &floor.key, &batch).await,
        (10..=12)
            .map(|n| rejected(Some(&record_id(n)), "subject_unknown", None))
            .collect::<Vec<_>>()
    );
    assert_eq!(event_count(&admin).await, 0);
    let taken = [fact(
        &record_id(20),
        "unit_label",
        &floor.shift,
        label(3, 1, "prepared", &instant(5, 0)),
    )];
    assert_eq!(
        receipts(&admin.app, &floor.key, &taken).await,
        [accepted(&record_id(20))]
    );
    let theirs = [fact(
        &record_id(21),
        "unit_label",
        &colleague.shift,
        label(2, 1, "prepared", &instant(5, 0)),
    )];
    assert_eq!(
        receipts(&admin.app, &colleague.key, &theirs).await,
        [accepted(&record_id(21))]
    );
    // A shift the station never entered is the envelope's refusal.
    let elsewhere = [fact(
        &record_id(22),
        "unit_label",
        &colleague.shift,
        label(3, 1, "prepared", &instant(5, 0)),
    )];
    assert_eq!(
        receipts(&admin.app, &floor.key, &elsewhere).await,
        [rejected(Some(&record_id(22)), "not_entered", None)]
    );
    // The same station in a second shift: its scan of code 3 is the first
    // shift's.
    let body = printing_body(&admin, &setup, "none").await;
    let second = open(&admin, &floor.key, &setup.line, body).await;
    let other_shift = [fact(
        &record_id(23),
        "unit_label",
        &second.shift,
        label(3, 1, "prepared", &instant(6, 0)),
    )];
    assert_eq!(
        receipts(&admin.app, &floor.key, &other_shift).await,
        [rejected(Some(&record_id(23)), "subject_unknown", None)]
    );
    assert_eq!(event_count(&admin).await, 2);
}

/// An event is taken only in a validation shift that prints: in an
/// aggregation shift it is `invalid_record` on `shift_mode` (`facts::admits`,
/// as every fact a mode does not have), in a validation shift that prints
/// nothing on `validationPrint`.
#[tokio::test]
async fn an_event_is_taken_only_in_a_validation_shift_that_prints() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let key = admin.key.clone();
    let mut plain = shift_body(&setup);
    plain["mode"] = json!("validation");
    let validation = open(&admin, &key, &setup.line, plain).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let aggregation = open(
        &admin,
        &colleague_key,
        &setup.other_line,
        shift_body(&setup),
    )
    .await;
    let scan = fact(
        &record_id(1),
        "scan",
        &validation.shift,
        checked_scan(1, &instant(1, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &validation.key, &[scan]).await,
        [accepted(&record_id(1))]
    );
    let boxed = fact(
        &record_id(2),
        "scan",
        &aggregation.shift,
        ok_scan(2, &box_id(1), &instant(1, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &aggregation.key, &[boxed]).await,
        [accepted(&record_id(2))]
    );
    assert_eq!(
        receipts(
            &admin.app,
            &validation.key,
            &[fact(
                &record_id(3),
                "unit_label",
                &validation.shift,
                label(1, 1, "prepared", &instant(2, 0))
            )]
        )
        .await,
        [rejected(
            Some(&record_id(3)),
            "invalid_record",
            Some("validationPrint")
        )]
    );
    assert_eq!(
        receipts(
            &admin.app,
            &aggregation.key,
            &[fact(
                &record_id(4),
                "unit_label",
                &aggregation.shift,
                label(2, 1, "prepared", &instant(2, 0))
            )]
        )
        .await,
        [rejected(
            Some(&record_id(4)),
            "invalid_record",
            Some("shift_mode")
        )]
    );
    assert_eq!(event_count(&admin).await, 0);
}

/// Every rule a row of `unit_label_events` keeps is checked before the
/// write, so a record that breaks one is `invalid_record` on its field (the
/// batch answers 200), never a database error that the station would send
/// again forever: each case of `proto/fixtures/unit-label-rules.json` (which
/// the webview's schema is held to as well) is taken or refused exactly as
/// the fixture says, and so are a job id, an instant, an event and a field
/// this host does not know.
#[tokio::test]
async fn every_rule_of_a_row_is_a_refused_field_never_a_database_error() {
    let (admin, _, floor) = printing_floor("required").await;
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../proto/fixtures/unit-label-rules.json"
    );
    let rules: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let base = rules["base"].clone();
    // The accepted scan of the fixture's code.
    let mut scan = checked_scan(1, &instant(1, 0));
    scan["code"]["codeHash"] = base["codeHash"].clone();
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(&record_id(1), "scan", &floor.shift, scan)]
        )
        .await,
        [accepted(&record_id(1))]
    );
    let mut cases: Vec<(Value, Value)> = rules["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| {
            let mut data = base.clone();
            for (key, value) in case["change"].as_object().unwrap() {
                data[key] = value.clone();
            }
            let field = case["field"]
                .as_str()
                .map_or(Value::Null, |field| json!(format!("data.{field}")));
            (data, field)
        })
        .collect();
    let with = |key: &str, value: Value| {
        let mut data = base.clone();
        data[key] = value;
        data
    };
    for (data, field) in [
        (
            with("jobId", json!(JOB.to_uppercase())),
            json!("data.jobId"),
        ),
        (with("jobId", json!("job-1")), json!("data.jobId")),
        (with("at", json!("2026-10-08T06:15:03Z")), json!("data.at")),
        (with("at", json!("вчера")), json!("data.at")),
        (with("event", json!("printed")), json!("data")),
        (with("reason", json!("smudged")), json!("data")),
        (with("attemptNo", json!(-1)), json!("data")),
        (
            with("code", json!("0104600682000013215Yq'Ct;\u{1d}93dGVz")),
            json!("data"),
        ),
    ] {
        cases.push((data, field));
    }
    let mut taken = 0;
    for (n, (data, field)) in (100..).zip(cases) {
        let record = fact(&record_id(n), "unit_label", &floor.shift, data.clone());
        let (status, body) = support::app::send_facts(&admin.app, &floor.key, &[record]).await;
        assert_eq!(status, StatusCode::OK, "{data}: {body}");
        let expected = match field.as_str() {
            None => {
                taken += 1;
                accepted(&record_id(n))
            }
            Some(field) => rejected(Some(&record_id(n)), "invalid_record", Some(field)),
        };
        assert_eq!(body["receipts"], json!([expected]), "{data}");
        assert_eq!(event_count(&admin).await, taken, "{data}");
    }
    assert!(taken > 5, "{taken}");
}

/// An event sent after the shift closed is taken and marks the shift late,
/// as every fact.
#[tokio::test]
async fn an_event_after_the_close_marks_the_shift_late() {
    let (admin, _, floor) = printing_floor("none").await;
    let scan = fact(
        &record_id(1),
        "scan",
        &floor.shift,
        checked_scan(1, &instant(1, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[scan]).await,
        [accepted(&record_id(1))]
    );
    let closed = close_from_office(&admin, &floor.shift, "Конец смены").await;
    assert_eq!(closed["lateDataAt"], Value::Null);
    let sent = fact(
        &record_id(2),
        "unit_label",
        &floor.shift,
        label(1, 1, "sent", &instant(2, 0)),
    );
    assert_eq!(
        receipts(&admin.app, &floor.key, &[sent]).await,
        [accepted(&record_id(2))]
    );
    let (status, late) = admin
        .call("GET", &format!("/v1/office/shifts/{}", floor.shift), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(late["lateDataAt"], json!(admin.app.state.timestamp()));
    assert_eq!(event_count(&admin).await, 1);
}
