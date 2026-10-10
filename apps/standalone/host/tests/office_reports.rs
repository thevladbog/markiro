mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, box_closed, box_exception, box_id, code, empty, fact, instant, issue_block, ok_scan,
    open_floor, pair_device, receipts, record_id, request, shift_setup, sscc, with_device, Admin,
    Floor,
};

const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const COLLEAGUE_BLOCK_REQUEST: &str = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";

/// Send `records` from `floor`'s station; every one must be accepted.
async fn accept(admin: &Admin, floor: &Floor, records: &[Value]) {
    let answered = receipts(&admin.app, &floor.key, records).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
}

/// `GET /v1/office/boxes/{id}/report-data` as the administrator.
async fn box_report(admin: &Admin, id: &str) -> (StatusCode, Value) {
    admin
        .call("GET", &format!("/v1/office/boxes/{id}/report-data"), None)
        .await
}

/// Code `n` as «Состав короба» prints it.
fn printed(n: u32) -> Value {
    let code = code(n);
    json!({
        "gtin14": code["gtin14"],
        "serial": code["serial"],
        "canonical": code["canonical"],
    })
}

/// A day of a shift: box 1 takes codes 3, 1, 2 and 4, gives back 4 and
/// closes; box 2 takes 5 and 6, closes and is taken apart; box 3 stays open
/// with code 7. A colleague's earlier scan then takes code 1 from box 1.
/// «Состав короба» prints of box 1 the codes still in it, by serial; of
/// box 2, taken apart, the codes its disassembly took out (as the cloud's
/// form prints a box taken apart); of the open box its live code; and of the
/// colleague's box the code it won.
#[tokio::test]
async fn the_box_form_prints_the_live_codes_and_a_disassembled_box_its_last_contents() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let shift = floor.shift.clone();
    let scan = |record: u32, n: u32, box_n: u32, second: u32| {
        fact(
            &record_id(record),
            "scan",
            &shift,
            ok_scan(n, &box_id(box_n), &instant(second, 0)),
        )
    };
    let mut undo = box_exception("undo", &box_id(1), &instant(14, 0));
    undo["codeHash"] = json!(support::app::code_hash(4));
    undo["targetScannedAt"] = json!(instant(13, 0));
    let mut disassemble = box_exception("disassemble", &box_id(2), &instant(45, 0));
    disassemble["reasonCode"] = json!("wrong_quantity");
    accept(
        &admin,
        &floor,
        &[
            scan(1, 3, 1, 10),
            scan(2, 1, 1, 11),
            scan(3, 2, 1, 12),
            scan(4, 4, 1, 13),
            fact(&record_id(5), "box_exception", &shift, undo),
            fact(
                &record_id(6),
                "box_closed",
                &shift,
                box_closed(
                    &box_id(1),
                    &block,
                    1500,
                    &[3, 1, 2],
                    &instant(10, 0),
                    &instant(20, 0),
                ),
            ),
            scan(7, 5, 2, 30),
            scan(8, 6, 2, 31),
            fact(
                &record_id(9),
                "box_closed",
                &shift,
                box_closed(
                    &box_id(2),
                    &block,
                    1501,
                    &[5, 6],
                    &instant(30, 0),
                    &instant(40, 0),
                ),
            ),
            fact(&record_id(10), "box_exception", &shift, disassemble),
            scan(11, 7, 3, 50),
        ],
    )
    .await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    issue_block(&admin.app, &colleague.key, COLLEAGUE_BLOCK_REQUEST).await;
    accept(
        &admin,
        &colleague,
        &[fact(
            &record_id(1),
            "scan",
            &colleague.shift,
            ok_scan(1, &box_id(11), &instant(5, 0)),
        )],
    )
    .await;

    let organization = json!({ "name": "ООО «Атолл»", "inn": "7701234567" });
    let (status, first) = box_report(&admin, &box_id(1)).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(
        first,
        json!({
            "id": box_id(1), "shiftId": shift, "sscc": sscc(1500),
            "openedAt": instant(10, 0), "closedAt": instant(20, 0), "disassembledAt": null,
            "productName": "Молоко 3,2% 0,9 л", "organization": organization,
            "items": [printed(2), printed(3)],
        })
    );
    let (_, second) = box_report(&admin, &box_id(2)).await;
    assert_eq!(
        second,
        json!({
            "id": box_id(2), "shiftId": shift, "sscc": sscc(1501),
            "openedAt": instant(30, 0), "closedAt": instant(40, 0),
            "disassembledAt": instant(45, 0),
            "productName": "Молоко 3,2% 0,9 л", "organization": organization,
            "items": [printed(5), printed(6)],
        })
    );
    let (_, open) = box_report(&admin, &box_id(3)).await;
    assert_eq!(
        open,
        json!({
            "id": box_id(3), "shiftId": shift, "sscc": null,
            "openedAt": instant(50, 0), "closedAt": null, "disassembledAt": null,
            "productName": "Молоко 3,2% 0,9 л", "organization": organization,
            "items": [printed(7)],
        })
    );
    let (_, theirs) = box_report(&admin, &box_id(11)).await;
    assert_eq!(theirs["shiftId"], json!(colleague.shift));
    assert_eq!(theirs["items"], json!([printed(1)]));
}

/// Every office role reads a box's form; an unknown box is `not_found`;
/// the device key alone is no office session.
#[tokio::test]
async fn every_office_role_reads_a_box_form_and_an_unknown_box_is_not_found() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    accept(
        &admin,
        &floor,
        &[fact(
            &record_id(1),
            "scan",
            &floor.shift,
            ok_scan(1, &box_id(1), &instant(10, 0)),
        )],
    )
    .await;
    let path = format!("/v1/office/boxes/{}/report-data", box_id(1));
    let technologist = admin.technologist().await;
    let (status, body) = admin.call_as(&technologist, "GET", &path, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["items"], json!([printed(1)]));
    let (status, body) = box_report(&admin, &box_id(9)).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "not_found");
    let (status, body) = admin
        .app
        .send(empty(with_device(request("GET", &path), &admin.key)))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["details"]["credential"], "session");
}

/// Each query of a box's form searches by an index: none reads through
/// every box, scan or item of the host.
#[tokio::test]
async fn every_query_of_a_box_form_searches_by_an_index() {
    let admin = admin().await;
    for (name, sql) in [
        ("box", markiro_host::routes::office_reports::BOX_SQL),
        ("items", markiro_host::routes::office_reports::BOX_ITEMS_SQL),
    ] {
        let plan: Vec<(i64, i64, i64, String)> =
            sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
                .bind("b0000000-0000-4000-8000-000000000001")
                .fetch_all(&admin.app.state.pool)
                .await
                .unwrap();
        let steps: Vec<&str> = plan.iter().map(|(_, _, _, step)| step.as_str()).collect();
        assert!(
            steps.iter().all(|step| !step.starts_with("SCAN")),
            "{name}: {steps:?}"
        );
        assert!(
            steps.iter().any(|step| step.starts_with("SEARCH")),
            "{name}: {steps:?}"
        );
    }
}

/// A box taken apart prints only the codes its disassembly took out: a code
/// undone before the close, and the codes a clear took out before the box
/// was filled again, are not in it, and a code scanned back into the box
/// after a clear is printed once. (The cloud takes out "by the
/// disassembly" by the instant it released the items at.)
#[tokio::test]
async fn a_box_taken_apart_prints_what_its_disassembly_took_out_and_not_what_left_before() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let shift = floor.shift.clone();
    let scan = |record: u32, n: u32, box_n: u32, second: u32| {
        fact(
            &record_id(record),
            "scan",
            &shift,
            ok_scan(n, &box_id(box_n), &instant(second, 0)),
        )
    };
    let mut undo = box_exception("undo", &box_id(1), &instant(13, 0));
    undo["codeHash"] = json!(support::app::code_hash(3));
    undo["targetScannedAt"] = json!(instant(12, 0));
    let mut disassemble_first = box_exception("disassemble", &box_id(1), &instant(30, 0));
    disassemble_first["reasonCode"] = json!("wrong_quantity");
    let mut disassemble_second = box_exception("disassemble", &box_id(2), &instant(60, 0));
    disassemble_second["reasonCode"] = json!("wrong_quantity");
    accept(
        &admin,
        &floor,
        &[
            scan(1, 1, 1, 10),
            scan(2, 2, 1, 11),
            scan(3, 3, 1, 12),
            fact(&record_id(4), "box_exception", &shift, undo),
            fact(
                &record_id(5),
                "box_closed",
                &shift,
                box_closed(
                    &box_id(1),
                    &block,
                    1500,
                    &[1, 2],
                    &instant(10, 0),
                    &instant(20, 0),
                ),
            ),
            fact(&record_id(6), "box_exception", &shift, disassemble_first),
            scan(7, 4, 2, 40),
            scan(8, 5, 2, 41),
            fact(
                &record_id(9),
                "box_exception",
                &shift,
                box_exception("clear", &box_id(2), &instant(42, 0)),
            ),
            scan(10, 4, 2, 43),
            scan(11, 6, 2, 44),
            fact(
                &record_id(12),
                "box_closed",
                &shift,
                box_closed(
                    &box_id(2),
                    &block,
                    1501,
                    &[4, 6],
                    &instant(40, 0),
                    &instant(50, 0),
                ),
            ),
            fact(&record_id(13), "box_exception", &shift, disassemble_second),
        ],
    )
    .await;

    let (_, first) = box_report(&admin, &box_id(1)).await;
    assert_eq!(first["disassembledAt"], json!(instant(30, 0)));
    assert_eq!(first["items"], json!([printed(1), printed(2)]));
    let (_, second) = box_report(&admin, &box_id(2)).await;
    assert_eq!(second["disassembledAt"], json!(instant(60, 0)));
    assert_eq!(second["items"], json!([printed(4), printed(6)]));
}

/// The three reads are one snapshot: whatever commits between them, on
/// another connection, is in no part of the answer. After the box a write
/// lands that the organization's read would show, after the organization one
/// that the items' read would show; the answer is the one read before any of
/// them, and a plain read afterwards shows both. An unknown box stops after
/// its own query.
#[tokio::test]
async fn the_three_reads_of_a_box_form_are_one_snapshot_whatever_commits_between_them() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    accept(
        &admin,
        &floor,
        &[
            fact(
                &record_id(1),
                "scan",
                &floor.shift,
                ok_scan(1, &box_id(1), &instant(10, 0)),
            ),
            fact(
                &record_id(2),
                "scan",
                &floor.shift,
                ok_scan(2, &box_id(1), &instant(11, 0)),
            ),
        ],
    )
    .await;
    let (status, before) = box_report(&admin, &box_id(1)).await;
    assert_eq!(status, StatusCode::OK, "{before}");
    assert_eq!(before["items"], json!([printed(1), printed(2)]));

    let pool = admin.app.state.pool.clone();
    let writer = pool.clone();
    let steps = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = steps.clone();
    let rows =
        markiro_host::routes::office_reports::read_box_rows(&pool, &box_id(1), move |step| {
            let pool = writer.clone();
            seen.lock().unwrap().push(step);
            async move {
                let write = match step {
                    "box" => "UPDATE org_profile SET name = 'Переименована'",
                    "organization" => {
                        "UPDATE box_items SET removed_at = '2026-10-08T09:00:00.000Z'"
                    }
                    // Nothing is left to read after the last query.
                    "items" => return,
                    other => panic!("no write after {other}"),
                };
                let done = sqlx::query(write).execute(&pool).await.unwrap();
                assert!(done.rows_affected() >= 1, "{write}");
            }
        })
        .await
        .unwrap()
        .unwrap();
    // The hook ran after each query: the equality below holds only if the
    // writes really landed between the reads.
    assert_eq!(*steps.lock().unwrap(), ["box", "organization", "items"]);
    assert_eq!(serde_json::to_value(&rows).unwrap(), before);

    let (_, after) = box_report(&admin, &box_id(1)).await;
    assert_eq!(after["organization"]["name"], "Переименована");
    assert_eq!(after["items"], json!([]));

    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let log = seen.clone();
    let none =
        markiro_host::routes::office_reports::read_box_rows(&pool, &box_id(9), move |step| {
            log.lock().unwrap().push(step);
            async {}
        })
        .await
        .unwrap();
    assert!(none.is_none());
    assert_eq!(*seen.lock().unwrap(), ["box"]);
}

/// Insert `serial` of `gtin14` as an item of `box_id` of `floor`'s shift,
/// straight into the tables, in scan `n` of a record id range of its own.
async fn put(admin: &Admin, floor: &Floor, box_id: &str, n: u32, gtin14: &str, serial: &str) {
    let pool = &admin.app.state.pool;
    let id = format!("eeeeee00-0000-4000-8000-{n:012}");
    let hash = format!("{:064x}", 0x3000_0000 + u64::from(n));
    sqlx::query(
        "INSERT INTO scans (id, record_id, device_id, shift_id, verdict, raw_kind, raw_length, \
           code_hash, gtin14, serial, canonical, box_id, scanned_at, received_at) \
         VALUES (?1, ?1, ?2, ?3, 'ok', 'km', 38, ?4, ?5, ?6, '01' || ?5 || '21' || ?6 || char(29) || '93Zz', \
           ?7, '2026-10-08T06:00:20.000Z', '2026-10-08T12:00:00Z')",
    )
    .bind(&id)
    .bind(&floor.station)
    .bind(&floor.shift)
    .bind(&hash)
    .bind(gtin14)
    .bind(serial)
    .bind(box_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO box_items (scan_id, box_id, code_hash, added_at) \
         VALUES (?, ?, ?, '2026-10-08T06:00:20.000Z')",
    )
    .bind(&id)
    .bind(box_id)
    .bind(&hash)
    .execute(pool)
    .await
    .unwrap();
}

/// The codes come by GTIN, then serial, byte for byte: a serial of digits
/// before capitals before small letters (not the order of a locale or of a
/// case-blind comparison), whatever the order they were scanned in, and the
/// code's GS and crypto tail stay in the printed text.
#[tokio::test]
async fn the_codes_come_by_gtin_then_serial_byte_for_byte() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    accept(
        &admin,
        &floor,
        &[fact(
            &record_id(1),
            "scan",
            &floor.shift,
            ok_scan(1, &box_id(1), &instant(10, 0)),
        )],
    )
    .await;
    for (n, gtin14, serial) in [
        (1, "04600682000020", "A1"),
        (2, "04600682000013", "b2"),
        (3, "04600682000013", "B3"),
        (4, "04600682000013", "a1"),
        (5, "04600682000013", "Z9"),
        (6, "04600682000013", "10"),
    ] {
        put(&admin, &floor, &box_id(1), n, gtin14, serial).await;
    }
    let (_, report) = box_report(&admin, &box_id(1)).await;
    let printed: Vec<(&str, &str)> = report["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| (i["gtin14"].as_str().unwrap(), i["serial"].as_str().unwrap()))
        .collect();
    assert_eq!(
        printed,
        [
            ("04600682000013", "10"),
            ("04600682000013", "B3"),
            ("04600682000013", "S000001"),
            ("04600682000013", "Z9"),
            ("04600682000013", "a1"),
            ("04600682000013", "b2"),
            ("04600682000020", "A1"),
        ]
    );
    assert_eq!(
        report["items"][3]["canonical"],
        json!("010460068200001321Z9\u{1d}93Zz")
    );
}

/// `count` items `B0000001..` of `box_id` of `floor`'s shift, written
/// straight into the tables (a shift's day of output is far more than facts
/// can send in a test).
async fn fill(admin: &Admin, floor: &Floor, box_id: &str, base: u64, count: u64, prefix: &str) {
    let pool = &admin.app.state.pool;
    sqlx::query(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1) \
         INSERT INTO scans (id, record_id, device_id, shift_id, verdict, raw_kind, raw_length, \
           code_hash, gtin14, serial, canonical, box_id, scanned_at, received_at) \
         SELECT printf('%s-0000-4000-8000-%012d', ?2, i), printf('%s-0000-4000-8000-%012d', ?2, i), \
           ?3, ?4, 'ok', 'km', 38, printf('%064x', ?5 + i), '04600682000013', \
           printf('B%07d', i), printf('0104600682000013' || '21B%07d' || char(29) || '93Zz', i), \
           ?6, printf('2026-10-09T%02d:%02d:%02d.000Z', i / 3600, i / 60 % 60, i % 60), \
           '2026-10-09T12:00:00Z' FROM n",
    )
    .bind(i64::try_from(count).unwrap())
    .bind(prefix)
    .bind(&floor.station)
    .bind(&floor.shift)
    .bind(i64::try_from(base).unwrap())
    .bind(box_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO box_items (scan_id, box_id, code_hash, added_at) \
         SELECT id, box_id, code_hash, scanned_at FROM scans WHERE id LIKE ?1 || '%'",
    )
    .bind(prefix)
    .execute(pool)
    .await
    .unwrap();
}

/// A box of thousands of codes comes whole and in order, the other box of
/// its shift and a colleague's shift of as many are none of it, and with that
/// many rows in the tables the queries still search by their named indexes
/// (the host gathers no statistics, so the plan is the one it has in
/// production).
#[tokio::test]
async fn a_box_of_thousands_of_codes_comes_whole_in_order_and_still_by_the_indexes() {
    const COUNT: u64 = 3000;
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    accept(
        &admin,
        &floor,
        &[
            fact(
                &record_id(1),
                "scan",
                &floor.shift,
                ok_scan(1, &box_id(1), &instant(10, 0)),
            ),
            fact(
                &record_id(2),
                "scan",
                &floor.shift,
                ok_scan(2, &box_id(2), &instant(11, 0)),
            ),
        ],
    )
    .await;
    accept(
        &admin,
        &colleague,
        &[fact(
            &record_id(1),
            "scan",
            &colleague.shift,
            ok_scan(3, &box_id(11), &instant(10, 0)),
        )],
    )
    .await;
    fill(&admin, &floor, &box_id(2), 0x1000_0000, COUNT, "ffffff01").await;
    fill(
        &admin,
        &colleague,
        &box_id(11),
        0x2000_0000,
        COUNT,
        "ffffff02",
    )
    .await;

    let (status, report) = box_report(&admin, &box_id(2)).await;
    assert_eq!(status, StatusCode::OK);
    let items = report["items"].as_array().unwrap();
    assert_eq!(items.len() as u64, COUNT + 1);
    assert_eq!(items[0]["serial"], "B0000001");
    assert_eq!(
        items[1000],
        json!({
            "gtin14": "04600682000013", "serial": "B0001001",
            "canonical": "010460068200001321B0001001\u{1d}93Zz",
        })
    );
    // The real scan's serial (`S000002`) sorts after every `B…` one.
    assert_eq!(items[COUNT as usize], printed(2));
    let serials: Vec<&str> = items
        .iter()
        .map(|i| i["serial"].as_str().unwrap())
        .collect();
    assert!(serials.windows(2).all(|pair| pair[0] < pair[1]));
    let (_, first) = box_report(&admin, &box_id(1)).await;
    assert_eq!(first["items"], json!([printed(1)]));
    let (_, theirs) = box_report(&admin, &box_id(11)).await;
    assert_eq!(theirs["items"].as_array().unwrap().len() as u64, COUNT + 1);
    assert_eq!(theirs["shiftId"], json!(colleague.shift));

    use markiro_host::routes::office_reports::{BOX_ITEMS_SQL, BOX_SQL};
    for (sql, indexes) in [
        (
            BOX_SQL,
            &[
                "sqlite_autoindex_boxes_1",
                "sqlite_autoindex_shifts_1",
                "sqlite_autoindex_products_1",
            ][..],
        ),
        (
            BOX_ITEMS_SQL,
            &[
                "sqlite_autoindex_boxes_1",
                "scans_shift",
                "sqlite_autoindex_box_items_1",
            ][..],
        ),
    ] {
        let plan: Vec<(i64, i64, i64, String)> =
            sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
                .bind(box_id(2))
                .fetch_all(&admin.app.state.pool)
                .await
                .unwrap();
        let steps: Vec<&str> = plan.iter().map(|(_, _, _, step)| step.as_str()).collect();
        assert!(
            steps.iter().all(|step| !step.starts_with("SCAN")),
            "{steps:?}"
        );
        for index in indexes {
            assert!(
                steps
                    .iter()
                    .any(|step| step.starts_with("SEARCH") && step.contains(index)),
                "without {index}: {steps:?}"
            );
        }
    }
}

/// A box id of no form a box has is `not_found`, not a failure of the host,
/// and a session the host does not know is refused like none.
#[tokio::test]
async fn an_id_of_no_box_is_not_found_and_an_unknown_session_is_refused() {
    let admin = admin().await;
    let (status, body) = box_report(&admin, "not-a-box").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "not_found");
    let path = format!("/v1/office/boxes/{}/report-data", box_id(1));
    let (status, body) = admin
        .app
        .send(empty(support::app::with_session(
            request("GET", &path),
            &admin.key,
            "not-a-session-token",
        )))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["details"]["credential"], "session");
}
