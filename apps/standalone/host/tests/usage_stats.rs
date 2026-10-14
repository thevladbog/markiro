//! `GET /v1/office/usage-stats` (beta 3 feedback): counts by month for the
//! support bundle. Administrators only; exact on seeded rows; nothing but
//! counts and month keys leaves; every query is driven by an index.

mod support;

use axum::http::StatusCode;
use markiro_host::routes::usage_stats::{window, DATE_QUERIES, INSTANT_QUERIES};
use serde_json::{json, Value};
use sqlx::SqliteConnection;
use support::app::{
    admin, device_shift_body, empty, office_template, pair_device, plan_shift, request, shift_body,
    shift_setup, with_device, Admin, ShiftSetup,
};

const PATH: &str = "/v1/office/usage-stats";

async fn device_call(admin: &Admin, method: &str, path: &str, body: Option<Value>) -> Value {
    let builder = with_device(request(method, path), &admin.key);
    let (status, body) = match body {
        Some(body) => admin.app.send(support::app::json(builder, body)).await,
        None => admin.app.send(empty(builder)).await,
    };
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

async fn exec(conn: &mut SqliteConnection, sql: &str) {
    sqlx::query(sql)
        .execute(&mut *conn)
        .await
        .unwrap_or_else(|error| panic!("{sql}: {error}"));
}

/// The month of `stats` named `month`.
fn month<'a>(stats: &'a Value, month: &str) -> &'a Value {
    stats["months"]
        .as_array()
        .unwrap()
        .iter()
        .find(|each| each["month"] == month)
        .unwrap_or_else(|| panic!("no month {month}"))
}

/// A scan row of `verdict` in `shift`, `n` of them, numbered from `base`.
async fn scans(
    conn: &mut SqliteConnection,
    device: &str,
    shift: &str,
    verdict: &str,
    base: u32,
    n: u32,
) {
    for at in base..base + n {
        let id = format!("{shift}-{verdict}-{at}");
        let sql = match verdict {
            "ok" => format!(
                "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, raw_kind, \
                 raw_length, code_hash, gtin14, serial, canonical, box_id, scanned_at, received_at) \
                 VALUES ('{id}', 'r-{id}', '{device}', '{shift}', 'ok', 'km', 38, \
                 printf('%064x', {at}), '04600682000013', 'S{at}', 'secret-code-{at}', \
                 (SELECT id FROM boxes WHERE shift_id = '{shift}' LIMIT 1), \
                 '2026-08-10T10:00:00.000Z', '2026-08-10T10:00:01Z')"
            ),
            "duplicate" => format!(
                "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, duplicate_source, \
                 raw_kind, raw_length, code_hash, gtin14, serial, canonical, scanned_at, received_at) \
                 VALUES ('{id}', 'r-{id}', '{device}', '{shift}', 'duplicate', 'local', 'km', 38, \
                 printf('%064x', {at}), '04600682000013', 'S{at}', 'secret-code-{at}', \
                 '2026-08-10T10:00:00.000Z', '2026-08-10T10:00:01Z')"
            ),
            "wrong_gtin" => format!(
                "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, raw_kind, \
                 raw_length, code_hash, gtin14, serial, canonical, scanned_at, received_at) \
                 VALUES ('{id}', 'r-{id}', '{device}', '{shift}', 'wrong_gtin', 'km', 38, \
                 printf('%064x', {at}), '04600682000099', 'S{at}', 'secret-code-{at}', \
                 '2026-08-10T10:00:00.000Z', '2026-08-10T10:00:01Z')"
            ),
            _ => format!(
                "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, raw_kind, \
                 raw_length, scanned_at, received_at) \
                 VALUES ('{id}', 'r-{id}', '{device}', '{shift}', 'invalid', 'unknown', 5, \
                 '2026-08-10T10:00:00.000Z', '2026-08-10T10:00:01Z')"
            ),
        };
        exec(conn, &sql).await;
    }
}

async fn closed_box(
    conn: &mut SqliteConnection,
    device: &str,
    shift: &str,
    id: &str,
    codes: u32,
    disassembled: bool,
) {
    exec(
        conn,
        &format!(
            "INSERT INTO boxes (id, shift_id, device_id, opened_at, closed_at, sscc, block_id, \
             serial, item_count_reported, digest_matches, disassembled_at, received_at) \
             VALUES ('{id}', '{shift}', '{device}', '2026-08-10T09:00:00.000Z', \
             '2026-08-10T10:00:00.000Z', '0460068200000{id:0>5}', 'block', {id}, {codes}, 1, {}, \
             '2026-08-10T10:00:01Z')",
            if disassembled {
                "'2026-08-11T10:00:00.000Z'"
            } else {
                "NULL"
            }
        ),
    )
    .await;
}

/// The seeded host: shifts in and out of the window with rows of every kind.
struct Seeded {
    admin: Admin,
}

async fn seeded() -> Seeded {
    let admin = admin().await;
    let setup: ShiftSetup = shift_setup(&admin).await;
    let pallet_template = office_template(&admin, "pallet", true, Value::Null).await;
    let duplicate_template = office_template(&admin, "product_duplicate", true, Value::Null).await;
    let station_id = {
        let device = device_call(&admin, "GET", "/v1/device", None).await;
        device["id"].as_str().unwrap().to_owned()
    };
    device_call(
        &admin,
        "PUT",
        "/v1/device/line",
        Some(json!({ "lineId": setup.line })),
    )
    .await;

    // Office shifts: August (aggregation), September (validation with a
    // duplicate print; aggregation with pallets), a year back and next month.
    let planned = |production: &str, planned: &str, extra: Value| {
        let mut body = shift_body(&setup);
        body["productionDate"] = json!(production);
        body["plannedDate"] = json!(planned);
        for (key, value) in extra.as_object().unwrap() {
            body[key] = value.clone();
        }
        body
    };
    let august = plan_shift(&admin, planned("2026-08-31", "2026-08-30", json!({}))).await;
    // The production date is August's, the shift date September's: it counts in September.
    let validation = plan_shift(
        &admin,
        planned(
            "2026-08-31",
            "2026-09-01",
            json!({
                "mode": "validation",
                "validationPrint": {
                    "mode": "duplicate_dm", "verification": "none", "templateId": duplicate_template
                }
            }),
        ),
    )
    .await;
    let pallets = plan_shift(
        &admin,
        planned(
            "2026-09-05",
            "2026-09-05",
            json!({ "palletsEnabled": true, "palletTemplateId": pallet_template }),
        ),
    )
    .await;
    let old = plan_shift(&admin, planned("2025-09-30", "2025-09-30", json!({}))).await;
    let next = plan_shift(&admin, planned("2026-10-01", "2026-10-01", json!({}))).await;
    // A station's shift of August.
    let mut station_body = device_shift_body(&setup, "6b0b6c4c-6b52-4a2c-9f3e-1d2a3b4c5d6e");
    station_body["productionDate"] = json!("2026-08-12");
    station_body["plannedDate"] = json!("2026-08-12");
    let station = device_call(&admin, "POST", "/v1/device/shifts", Some(station_body)).await;

    let id = |shift: &Value| shift["id"].as_str().unwrap().to_owned();
    let (august, validation, pallets, old, next, station) = (
        id(&august),
        id(&validation),
        id(&pallets),
        id(&old),
        id(&next),
        id(&station),
    );
    let pool = admin.app.state.pool.clone();
    let mut held = pool.acquire().await.unwrap();
    // The rows of the facts have keys to blocks and counters the test does not
    // make: the connection that inserts them checks none.
    exec(&mut held, "PRAGMA foreign_keys = OFF").await;
    let conn = &mut *held;
    // August: two closed boxes (one taken apart) and an open one in the office
    // shift, one closed box in the station's.
    for shift in [&august, &station] {
        exec(
            conn,
            &format!(
                "INSERT INTO boxes (id, shift_id, device_id, opened_at, received_at) VALUES \
                 ('open-{shift}', '{shift}', '{station_id}', '2026-08-10T09:00:00.000Z', \
                 '2026-08-10T09:00:01Z')"
            ),
        )
        .await;
    }
    closed_box(conn, &station_id, &august, "1", 5, false).await;
    closed_box(conn, &station_id, &august, "2", 3, true).await;
    closed_box(conn, &station_id, &station, "3", 2, false).await;
    // Boxes of the shift a year back and the one next month do not count.
    closed_box(conn, &station_id, &old, "4", 99, false).await;
    closed_box(conn, &station_id, &next, "5", 99, false).await;
    scans(conn, &station_id, &august, "ok", 1, 5).await;
    scans(conn, &station_id, &august, "duplicate", 100, 2).await;
    scans(conn, &station_id, &august, "wrong_gtin", 200, 1).await;
    scans(conn, &station_id, &august, "invalid", 300, 2).await;
    scans(conn, &station_id, &station, "ok", 400, 3).await;
    scans(conn, &station_id, &old, "ok", 500, 7).await;
    scans(conn, &station_id, &next, "ok", 600, 7).await;
    // September: the validation shift takes four codes without a box.
    for at in 700..704 {
        exec(
            conn,
            &format!(
                "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, raw_kind, \
                 raw_length, code_hash, gtin14, serial, canonical, scanned_at, received_at) \
                 VALUES ('v{at}', 'r-v{at}', '{station_id}', '{validation}', 'ok', 'km', 38, \
                 printf('%064x', {at}), '04600682000013', 'S{at}', 'secret-code-{at}', \
                 '2026-09-02T10:00:00.000Z', '2026-09-02T10:00:01Z')"
            ),
        )
        .await;
    }
    // Pallets: one closed and taken apart, one open, in August's office shift;
    // one closed in September's; one closed in the year-old shift.
    for (pid, shift, closed, disassembled) in [
        ("p1", &august, true, true),
        ("p2", &august, false, false),
        ("p3", &pallets, true, false),
        ("p4", &old, true, false),
    ] {
        exec(
            conn,
            &format!(
                "INSERT INTO pallets (id, shift_id, device_id, opened_at, closed_at, sscc, \
                 block_id, serial, box_count_reported, disassembled_at, received_at) VALUES \
                 ('{pid}', '{shift}', '{station_id}', '2026-08-10T09:00:00.000Z', {}, {}, {}, {}, \
                 {}, {}, '2026-08-10T09:00:01Z')",
                if closed {
                    "'2026-08-10T11:00:00.000Z'"
                } else {
                    "NULL"
                },
                if closed {
                    format!("'1460068200000{pid:0>5}'")
                } else {
                    "NULL".to_owned()
                },
                if closed { "'block'" } else { "NULL" },
                if closed { &pid[1..] } else { "NULL" },
                if closed { "4" } else { "NULL" },
                if disassembled {
                    "'2026-08-12T10:00:00.000Z'"
                } else {
                    "NULL"
                },
            ),
        )
        .await;
    }
    // Exceptions of August's office shift, by kind.
    let mut n = 0;
    for (kind, count) in [
        ("undo", 2),
        ("clear", 1),
        ("reprint", 3),
        ("disassemble", 1),
    ] {
        for _ in 0..count {
            n += 1;
            let (code, target, reason) = match kind {
                "undo" => ("printf('%064x', 1)", "'2026-08-10T10:00:00.000Z'", "NULL"),
                "clear" => ("NULL", "NULL", "NULL"),
                _ => ("NULL", "NULL", "'damaged'"),
            };
            exec(
                conn,
                &format!(
                    "INSERT INTO box_exceptions (id, record_id, kind, box_id, code_hash, \
                     target_scanned_at, reason_code, shift_id, device_id, occurred_at, received_at) \
                     VALUES ('e{n}', 'x{n}', '{kind}', '1', {code}, {target}, {reason}, '{august}', \
                     '{station_id}', '2026-08-10T12:00:00.000Z', '2026-08-10T12:00:01Z')"
                ),
            )
            .await;
        }
    }
    for (kind, count) in [("reprint", 2), ("disassemble", 1)] {
        for _ in 0..count {
            n += 1;
            exec(
                conn,
                &format!(
                    "INSERT INTO pallet_exceptions (id, record_id, kind, pallet_id, reason_code, \
                     shift_id, device_id, occurred_at, received_at) VALUES ('e{n}', 'x{n}', \
                     '{kind}', 'p1', 'damaged', '{august}', '{station_id}', \
                     '2026-08-10T12:00:00.000Z', '2026-08-10T12:00:01Z')"
                ),
            )
            .await;
        }
    }
    // Refused records of August's shift: two, beside an accepted one and a conflict.
    for (rid, outcome) in [
        ("a", "accepted"),
        ("b", "rejected"),
        ("c", "rejected"),
        ("d", "conflict"),
    ] {
        let code = if outcome == "rejected" {
            "'invalid_record'"
        } else {
            "NULL"
        };
        exec(
            conn,
            &format!(
                "INSERT INTO fact_receipts (device_id, record_id, kind, shift_id, digest, outcome, \
                 code, received_at) VALUES ('{station_id}', '{rid}', 'scan', '{august}', \
                 printf('%064x', 9), '{outcome}', {code}, '2026-08-10T10:00:01Z')"
            ),
        )
        .await;
    }
    // Duplicate labels of September's validation shift: four first prints, two reprints.
    for (at, attempt) in [(1, 1), (2, 1), (3, 1), (4, 1), (5, 2), (6, 3)] {
        let reason = if attempt > 1 { "'damaged'" } else { "NULL" };
        exec(
            conn,
            &format!(
                "INSERT INTO unit_label_events (id, record_id, device_id, shift_id, job_id, \
                 code_hash, attempt_no, event, reason, payload_digest, bytes_digest, at, received_at) \
                 VALUES ('u{at}', 'ur{at}', '{station_id}', '{validation}', 'job{at}', \
                 printf('%064x', {at}), {attempt}, 'prepared', {reason}, printf('%064x', 1), \
                 printf('%064x', 2), '2026-09-02T10:00:00.000Z', '2026-09-02T10:00:01Z')"
            ),
        )
        .await;
    }
    // Conflicts by the host's instant: August late (reviewed), August displaced,
    // September displaced, and one before the window.
    for (cid, at, kind, reviewed) in [
        ("c1", "2026-08-10T10:05:00Z", "late", true),
        ("c2", "2026-08-11T10:05:00Z", "displaced", false),
        ("c3", "2026-09-02T10:05:00Z", "displaced", false),
        ("c4", "2025-09-30T23:59:59Z", "late", false),
    ] {
        let at_row = format!("{cid}x");
        exec(
            conn,
            &format!(
                "INSERT INTO code_conflicts (id, code_hash, winner_scan_id, loser_scan_id, \
                 detected_at, reviewed_at, reviewed_by, kind) VALUES ('{cid}', printf('%064x', 1), '{at_row}1', \
                 '{at_row}2', '{at}', {}, '{kind}')",
                if reviewed {
                    "'2026-08-12T10:00:00Z', (SELECT id FROM office_users LIMIT 1)"
                } else {
                    "NULL, NULL"
                }
            ),
        )
        .await;
    }
    // Disaggregation documents: two applied in August, one in September, one
    // before the window, one draft.
    let user: String = sqlx::query_scalar("SELECT id FROM office_users LIMIT 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    for (seq, status, applied) in [
        (1, "applied", Some("2026-08-03T10:00:00Z")),
        (2, "applied", Some("2026-08-04T10:00:00Z")),
        (3, "applied", Some("2026-09-05T10:00:00Z")),
        (4, "applied", Some("2025-09-05T10:00:00Z")),
        (5, "draft", None),
    ] {
        exec(
            conn,
            &format!(
                "INSERT INTO disaggregation_documents (id, seq, doc_no, status, reason_id, source, \
                 created_by, created_at, applied_at, applied_by, updated_at, rev) VALUES \
                 ('d{seq}', {seq}, 'DSG-26-000{seq}', '{status}', {}, 'manual', '{user}', \
                 '2026-08-01T10:00:00Z', {}, {}, '2026-08-01T10:00:00Z', 1)",
                if status == "draft" { "NULL" } else { "'d15a0000-0000-4000-8000-000000000001'" },
                applied.map_or("NULL".to_owned(), |at| format!("'{at}'")),
                applied.map_or("NULL".to_owned(), |_| format!("'{user}'")),
            ),
        )
        .await;
    }
    // Warehouse reprints: three in September, one in July, one before the window.
    for (rid, at) in [
        ("w1", "2026-09-03T10:00:00Z"),
        ("w2", "2026-09-04T10:00:00Z"),
        ("w3", "2026-09-05T10:00:00Z"),
        ("w4", "2026-07-05T10:00:00Z"),
        ("w5", "2025-09-05T10:00:00Z"),
    ] {
        exec(
            conn,
            &format!(
                "INSERT INTO warehouse_reprints (device_id, record_id, digest, session_id, job_id, \
                 attempt, subject_kind, subject_id, identity, reason_code, template_id, \
                 template_rev, outcome, occurred_at, received_at) VALUES ('{station_id}', '{rid}', \
                 printf('%064x', 3), 's', 'j{rid}', 0, 'box', 'b', 'SECRET-SSCC', 'lost', 't', 1, \
                 'sent', '{at}', '{at}')"
            ),
        )
        .await;
    }
    // Devices: this station, a revoked second one, an office PC and a handheld.
    let (second, _) = pair_device(&admin.app, "station").await;
    exec(
        conn,
        &format!("UPDATE devices SET revoked_at = '2026-09-01T00:00:00Z' WHERE id = '{second}'"),
    )
    .await;
    pair_device(&admin.app, "office").await;
    exec(
        conn,
        "INSERT INTO devices (id, kind, name, key_hash, app_version, protocol, paired_at) \
         VALUES ('h1', 'handheld', 'ТСД Иванова', printf('%064x', 77), '1.0.0', 5, \
         '2026-09-01T00:00:00Z')",
    )
    .await;
    exec(conn, "PRAGMA foreign_keys = ON").await;
    drop(held);
    Seeded { admin }
}

#[tokio::test]
async fn it_counts_the_months_of_a_seeded_host_exactly() {
    let seeded = seeded().await;
    let (status, stats) = seeded.admin.call("GET", PATH, None).await;
    assert_eq!(status, StatusCode::OK, "{stats}");

    // Twelve months ending with the host's clock (21 September 2026), empty ones too.
    let keys: Vec<&str> = stats["months"]
        .as_array()
        .unwrap()
        .iter()
        .map(|each| each["month"].as_str().unwrap())
        .collect();
    assert_eq!(
        keys,
        [
            "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05",
            "2026-06", "2026-07", "2026-08", "2026-09"
        ]
    );
    let empty_month = |key: &str| {
        json!({
            "month": key,
            "shifts": { "aggregation": 0, "validation": 0, "validationPrint": 0, "fromOffice": 0,
                "fromStation": 0, "withPallets": 0 },
            "scans": { "accepted": 0, "duplicates": 0, "rejected": 0 },
            "boxes": { "closed": 0, "disassembled": 0, "codes": 0 },
            "pallets": { "closed": 0, "disassembled": 0 },
            "exceptions": { "boxUndo": 0, "boxClear": 0, "boxReprint": 0, "boxDisassemble": 0,
                "palletReprint": 0, "palletDisassemble": 0 },
            "conflicts": { "late": 0, "displaced": 0, "reviewed": 0 },
            "reprints": { "warehouse": 0, "unitLabel": 0 },
            "disaggregationApplied": 0, "syncRejected": 0
        })
    };
    for key in ["2025-10", "2026-06"] {
        assert_eq!(month(&stats, key), &empty_month(key), "{key}");
    }

    // July holds only a warehouse reprint.
    let mut july = empty_month("2026-07");
    july["reprints"]["warehouse"] = json!(1);
    assert_eq!(month(&stats, "2026-07"), &july);

    // August: the office shift and the station's, by the shift date.
    let mut august = empty_month("2026-08");
    august["shifts"] = json!({ "aggregation": 2, "validation": 0, "validationPrint": 0,
        "fromOffice": 1, "fromStation": 1, "withPallets": 0 });
    august["scans"] = json!({ "accepted": 8, "duplicates": 2, "rejected": 3 });
    august["boxes"] = json!({ "closed": 3, "disassembled": 1, "codes": 10 });
    august["pallets"] = json!({ "closed": 1, "disassembled": 1 });
    august["exceptions"] = json!({ "boxUndo": 2, "boxClear": 1, "boxReprint": 3,
        "boxDisassemble": 1, "palletReprint": 2, "palletDisassemble": 1 });
    august["conflicts"] = json!({ "late": 1, "displaced": 1, "reviewed": 1 });
    august["disaggregationApplied"] = json!(2);
    august["syncRejected"] = json!(2);
    assert_eq!(month(&stats, "2026-08"), &august);

    // September: the validation shift with a duplicate print (its shift date
    // is September's although its production date is August's) and the shift
    // with pallets.
    let mut september = empty_month("2026-09");
    september["shifts"] = json!({ "aggregation": 1, "validation": 1, "validationPrint": 1,
        "fromOffice": 2, "fromStation": 0, "withPallets": 1 });
    september["scans"] = json!({ "accepted": 4, "duplicates": 0, "rejected": 0 });
    september["pallets"] = json!({ "closed": 1, "disassembled": 0 });
    september["conflicts"] = json!({ "late": 0, "displaced": 1, "reviewed": 0 });
    september["reprints"] = json!({ "warehouse": 3, "unitLabel": 2 });
    september["disaggregationApplied"] = json!(1);
    assert_eq!(month(&stats, "2026-09"), &september);

    // Devices that are not revoked, by kind: the station, the office PC, the handheld.
    assert_eq!(
        stats["devices"],
        json!({ "station": 1, "office": 1, "handheld": 1 })
    );
}

#[tokio::test]
async fn nothing_but_counts_and_month_keys_leaves() {
    let seeded = seeded().await;
    let (status, stats) = seeded.admin.call("GET", PATH, None).await;
    assert_eq!(status, StatusCode::OK, "{stats}");
    // Every leaf is an unsigned count but the month keys.
    fn walk(value: &Value, path: &str, texts: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                for (key, inner) in map {
                    walk(inner, &format!("{path}.{key}"), texts);
                }
            }
            Value::Array(items) => items
                .iter()
                .for_each(|item| walk(item, &format!("{path}[]"), texts)),
            Value::Number(number) => assert!(number.is_u64(), "{path}"),
            Value::String(text) => texts.push(format!("{path}={text}")),
            other => panic!("{path}: {other}"),
        }
    }
    let mut texts = Vec::new();
    walk(&stats, "", &mut texts);
    assert!(
        texts
            .iter()
            .all(|text| text.starts_with(".months[].month=20")),
        "{texts:?}"
    );
    assert_eq!(texts.len(), 12);
    // The allowlist of the keys, whole.
    let mut keys = std::collections::BTreeSet::new();
    fn collect(value: &Value, path: &str, keys: &mut std::collections::BTreeSet<String>) {
        if let Value::Object(map) = value {
            for (key, inner) in map {
                let here = format!("{path}.{key}");
                keys.insert(here.clone());
                collect(inner, &here, keys);
            }
        } else if let Value::Array(items) = value {
            items
                .iter()
                .for_each(|item| collect(item, &format!("{path}[]"), keys));
        }
    }
    collect(&stats, "", &mut keys);
    let allowed: std::collections::BTreeSet<String> = [
        ".devices",
        ".devices.handheld",
        ".devices.office",
        ".devices.station",
        ".months",
        ".months[].boxes",
        ".months[].boxes.closed",
        ".months[].boxes.codes",
        ".months[].boxes.disassembled",
        ".months[].conflicts",
        ".months[].conflicts.displaced",
        ".months[].conflicts.late",
        ".months[].conflicts.reviewed",
        ".months[].disaggregationApplied",
        ".months[].exceptions",
        ".months[].exceptions.boxClear",
        ".months[].exceptions.boxDisassemble",
        ".months[].exceptions.boxReprint",
        ".months[].exceptions.boxUndo",
        ".months[].exceptions.palletDisassemble",
        ".months[].exceptions.palletReprint",
        ".months[].month",
        ".months[].pallets",
        ".months[].pallets.closed",
        ".months[].pallets.disassembled",
        ".months[].reprints",
        ".months[].reprints.unitLabel",
        ".months[].reprints.warehouse",
        ".months[].scans",
        ".months[].scans.accepted",
        ".months[].scans.duplicates",
        ".months[].scans.rejected",
        ".months[].shifts",
        ".months[].shifts.aggregation",
        ".months[].shifts.fromOffice",
        ".months[].shifts.fromStation",
        ".months[].shifts.validation",
        ".months[].shifts.validationPrint",
        ".months[].shifts.withPallets",
        ".months[].syncRejected",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    assert_eq!(keys, allowed);
    // None of the seeded secrets, names or codes is in the text of the answer.
    let text = stats.to_string();
    for secret in [
        "secret-code",
        "SECRET-SSCC",
        "Иванова",
        "Молоко",
        "04600682000013",
        "ТСД",
        "admin",
    ] {
        assert!(!text.contains(secret), "{secret}");
    }
}

#[tokio::test]
async fn only_an_administrator_session_reads_it() {
    let admin = admin().await;
    let (technologist, _) = admin.technologist_session().await;
    let (status, body) = admin.call_as(&technologist, "GET", PATH, None).await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
    // A device key opens no office route.
    let (status, body) = admin
        .app
        .send(empty(with_device(request("GET", PATH), &admin.key)))
        .await;
    assert_eq!(
        (status, body["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("session"))
    );
    // Nor does a request with nothing, or an operator's work: no credential at all.
    let (status, _) = admin.app.send(empty(request("GET", PATH))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // The administrator reads it, and it writes no audit row and takes no revision.
    let before = support::app::host_revision(&admin.app).await;
    let (status, stats) = admin.call("GET", PATH, None).await;
    assert_eq!(status, StatusCode::OK, "{stats}");
    assert_eq!(stats["months"].as_array().unwrap().len(), 12);
    assert_eq!(support::app::host_revision(&admin.app).await, before);
    let rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM audit_log WHERE action LIKE '%usage%'")
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(rows, 0);
}

#[tokio::test]
async fn the_window_is_twelve_calendar_months_ending_with_the_current_one() {
    let at = |text: &str| {
        time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339).unwrap()
    };
    let keys = window(at("2026-01-15T10:00:00Z"));
    assert_eq!(keys.first().map(String::as_str), Some("2025-02"));
    assert_eq!(keys.last().map(String::as_str), Some("2026-01"));
    assert_eq!(keys.len(), 12);
    let keys = window(at("2026-12-31T23:59:59Z"));
    assert_eq!(keys.first().map(String::as_str), Some("2026-01"));
    assert_eq!(keys.last().map(String::as_str), Some("2026-12"));
}

/// Every query reads by an index: no big table is scanned whole.
#[tokio::test]
async fn no_query_scans_a_table_of_facts() {
    let admin = admin().await;
    let pool = &admin.app.state.pool;
    // Tables with no index on time that hold a handful of rows beside the facts.
    let small = ["warehouse_reprints", "disaggregation_documents", "devices"];
    let mut plans = Vec::new();
    for sql in DATE_QUERIES.iter().chain(INSTANT_QUERIES) {
        let explain = format!("EXPLAIN QUERY PLAN {sql}");
        let mut query = sqlx::query_as::<_, (i64, i64, i64, String)>(&explain).bind("2025-10-01");
        if sql.contains("?2") {
            query = query.bind("2026-09-31");
        }
        for (_, _, _, detail) in query.fetch_all(pool).await.unwrap() {
            plans.push((*sql, detail));
        }
    }
    assert!(!plans.is_empty());
    for (sql, detail) in &plans {
        if let Some(table) = detail.strip_prefix("SCAN ") {
            let table = table.split_whitespace().next().unwrap_or_default();
            assert!(
                small.contains(&table) || table.starts_with("sqlite_"),
                "{sql}: {detail}"
            );
        }
    }
    // The fact tables are reached through their per-shift indexes.
    let used = |index: &str| plans.iter().any(|(_, detail)| detail.contains(index));
    for index in [
        "shifts_planned_date",
        "scans_shift",
        "boxes_shift",
        "pallets_shift",
        "box_exceptions_shift",
        "pallet_exceptions_shift",
        "unit_label_events_shift",
        "fact_receipts_rejected",
        "code_conflicts_detected",
    ] {
        assert!(used(index), "{index} is not used: {plans:#?}");
    }
}
