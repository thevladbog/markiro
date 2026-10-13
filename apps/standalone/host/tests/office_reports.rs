mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, box_closed, box_exception, box_id, code, empty, fact, instant, issue_block,
    issue_pallet_block, ok_scan, open_floor, open_pallet_floor, pair_device, pallet_closed,
    pallet_id, pallet_sscc, plan_shift, receipts, record_id, request, shift_body, shift_setup,
    sscc, with_device, Admin, Floor,
};

const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const PALLET_REQUEST: &str = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";
const COLLEAGUE_BLOCK_REQUEST: &str = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";
const COLLEAGUE_PALLET_REQUEST: &str = "9b8a7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";

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

    let organization = json!({ "name": "ООО «Атолл»", "inn": "7707083893" });
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

/// `GET /v1/office/shifts/{id}/pallet-report-data` as the administrator.
async fn pallet_report(admin: &Admin, shift: &str) -> (StatusCode, Value) {
    admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{shift}/pallet-report-data"),
            None,
        )
        .await
}

/// The `data` of box `n` closed with `serial` over `members` on `pallet`.
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

/// A day of a shift with pallets: boxes 1 (codes 1 and 2), 3 (code 4) and
/// 2 (code 3) close in that order on pallet 1, which closes; box 3 is then
/// taken apart and a colleague's earlier scan takes code 2 from box 1. Box
/// 4 (code 5) stands on pallet 2, still open; box 5 (code 6) on pallet 3,
/// closed and then taken apart; box 6 (code 7) on no pallet. The forms read
/// every pallet of the shift opened first first, each with every box that
/// stood on it closed first first, the box taken apart too, and the live
/// units of each box now; the product's GTIN and shelf life and the shift's
/// number and date are the shift's own, never the colleague's.
#[tokio::test]
async fn the_pallet_forms_read_every_pallet_with_every_box_that_stood_on_it() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let shift = floor.shift.clone();
    let scan = |record: u32, n: u32, box_n: u32, second: u32| {
        fact(
            &record_id(record),
            "scan",
            &shift,
            ok_scan(n, &box_id(box_n), &instant(second, 0)),
        )
    };
    let (p1, p2, p3) = (pallet_id(1), pallet_id(2), pallet_id(3));
    let mut take_box_apart = box_exception("disassemble", &box_id(3), &instant(45, 0));
    take_box_apart["reasonCode"] = json!("wrong_quantity");
    let take_pallet_apart = json!({
        "exception": "disassemble", "palletId": p3, "reasonCode": "wrong_quantity",
        "reasonText": null, "occurredAt": instant(80, 0)
    });
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
            scan(4, 4, 3, 25),
            fact(
                &record_id(5),
                "box_closed",
                &shift,
                closed_on(&block, 3, 1501, &[4], 25, 28, Some(&p1)),
            ),
            scan(6, 3, 2, 29),
            fact(
                &record_id(7),
                "box_closed",
                &shift,
                closed_on(&block, 2, 1502, &[3], 29, 35, Some(&p1)),
            ),
            fact(
                &record_id(8),
                "pallet_closed",
                &shift,
                pallet_closed(&p1, &pallets, 40, 3, &instant(20, 0), &instant(40, 0)),
            ),
            fact(&record_id(9), "box_exception", &shift, take_box_apart),
            scan(10, 5, 4, 50),
            fact(
                &record_id(11),
                "box_closed",
                &shift,
                closed_on(&block, 4, 1503, &[5], 50, 60, Some(&p2)),
            ),
            scan(12, 6, 5, 61),
            fact(
                &record_id(13),
                "box_closed",
                &shift,
                closed_on(&block, 5, 1504, &[6], 61, 70, Some(&p3)),
            ),
            fact(
                &record_id(14),
                "pallet_closed",
                &shift,
                pallet_closed(&p3, &pallets, 41, 1, &instant(70, 0), &instant(75, 0)),
            ),
            fact(
                &record_id(15),
                "pallet_exception",
                &shift,
                take_pallet_apart,
            ),
            scan(16, 7, 6, 81),
            fact(
                &record_id(17),
                "box_closed",
                &shift,
                closed_on(&block, 6, 1505, &[7], 81, 85, None),
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

    let (status, report) = pallet_report(&admin, &shift).await;
    assert_eq!(status, StatusCode::OK, "{report}");
    let on = |n: u32, serial: u64, closed: u32, gone: Option<u32>, units: u32| {
        json!({
            "id": box_id(n), "sscc": sscc(serial), "closedAt": instant(closed, 0),
            "disassembledAt": gone.map(|second| instant(second, 0)), "units": units,
        })
    };
    assert_eq!(
        report,
        json!({
            "shift": {
                "id": shift, "number": floor.number, "productionDate": "2026-10-08",
                "productName": "Молоко 3,2% 0,9 л", "gtin14": "04600682000013",
                "shelfLifeDays": 10,
            },
            "organization": { "name": "ООО «Атолл»", "inn": "7707083893" },
            "pallets": [
                {
                    "id": p1, "sscc": pallet_sscc(40), "openedAt": instant(20, 0),
                    "closedAt": instant(40, 0), "disassembledAt": null,
                    "boxes": [
                        on(1, 1500, 20, None, 1),
                        on(3, 1501, 28, Some(45), 0),
                        on(2, 1502, 35, None, 1),
                    ],
                },
                {
                    "id": p2, "sscc": null, "openedAt": instant(60, 0), "closedAt": null,
                    "disassembledAt": null, "boxes": [on(4, 1503, 60, None, 1)],
                },
                {
                    "id": p3, "sscc": pallet_sscc(41), "openedAt": instant(70, 0),
                    "closedAt": instant(75, 0), "disassembledAt": instant(80, 0),
                    "boxes": [on(5, 1504, 70, None, 1)],
                },
            ],
        })
    );
    let (_, theirs) = pallet_report(&admin, &colleague.shift).await;
    assert_eq!(theirs["shift"]["number"], json!(colleague.number));
    assert_eq!(
        theirs["pallets"],
        json!([{
            "id": p11, "sscc": pallet_sscc(240), "openedAt": instant(6, 0),
            "closedAt": instant(7, 0), "disassembledAt": null,
            "boxes": [{
                "id": box_id(11), "sscc": support::app::sscc_under("460068200", 3500),
                "closedAt": instant(6, 0), "disassembledAt": null, "units": 1,
            }],
        }])
    );
}

/// Every office role reads a shift's pallet forms; a shift without pallets
/// has none; an unknown shift is `not_found`; the device key alone is no
/// office session.
#[tokio::test]
async fn every_office_role_reads_the_pallet_forms_and_an_unknown_shift_is_not_found() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let planned = plan_shift(&admin, shift_body(&setup)).await;
    let id = planned["id"].as_str().unwrap();
    let path = format!("/v1/office/shifts/{id}/pallet-report-data");
    let technologist = admin.technologist().await;
    let (status, body) = admin.call_as(&technologist, "GET", &path, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["shift"]["number"], planned["number"]);
    assert_eq!(body["pallets"], json!([]));
    let (status, body) = pallet_report(&admin, "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "not_found");
    let (status, body) = admin
        .app
        .send(empty(with_device(request("GET", &path), &admin.key)))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["details"]["credential"], "session");
}

/// Each query of the pallet forms searches by an index.
#[tokio::test]
async fn every_query_of_the_pallet_forms_searches_by_an_index() {
    let admin = admin().await;
    for (name, sql) in [
        (
            "shift",
            markiro_host::routes::office_reports::PALLET_SHIFT_SQL,
        ),
        ("pallets", markiro_host::routes::office_reports::PALLETS_SQL),
        (
            "boxes",
            markiro_host::routes::office_reports::PALLET_BOXES_SQL,
        ),
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
        assert!(
            steps.iter().any(|step| step.starts_with("SEARCH")),
            "{name}: {steps:?}"
        );
    }
}

/// Ties are settled by id, and nothing leaves the lists: two pallets opened
/// at the same instant come by id (pallet 2 reached the host first), two
/// boxes closed at the same instant on one pallet come by id (box 5 reached
/// the host first), and a box that closed after its pallet did (it joined
/// silently) stays in the pallet's list, last, with its own later close, so
/// the office can tell it from the boxes the pallet was closed over.
#[tokio::test]
async fn ties_come_by_id_and_a_box_closed_after_its_pallet_stays_in_its_list() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let shift = floor.shift.clone();
    let scan = |record: u32, n: u32, box_n: u32, second: u32| {
        fact(
            &record_id(record),
            "scan",
            &shift,
            ok_scan(n, &box_id(box_n), &instant(second, 0)),
        )
    };
    let (p1, p2) = (pallet_id(1), pallet_id(2));
    accept(
        &admin,
        &floor,
        &[
            // Pallet 2 and box 5 are the first the host hears of.
            scan(1, 1, 5, 10),
            fact(
                &record_id(2),
                "box_closed",
                &shift,
                closed_on(&block, 5, 1500, &[1], 10, 12, Some(&p2)),
            ),
            scan(3, 2, 4, 10),
            fact(
                &record_id(4),
                "box_closed",
                &shift,
                closed_on(&block, 4, 1501, &[2], 10, 12, Some(&p2)),
            ),
            scan(5, 3, 6, 13),
            fact(
                &record_id(6),
                "box_closed",
                &shift,
                closed_on(&block, 6, 1502, &[3], 13, 14, Some(&p1)),
            ),
            fact(
                &record_id(7),
                "pallet_closed",
                &shift,
                pallet_closed(&p2, &pallets, 40, 2, &instant(30, 0), &instant(40, 0)),
            ),
            fact(
                &record_id(8),
                "pallet_closed",
                &shift,
                pallet_closed(&p1, &pallets, 41, 1, &instant(30, 0), &instant(41, 0)),
            ),
            // After pallet 1 closed, box 7 joins it.
            scan(9, 4, 7, 50),
            fact(
                &record_id(10),
                "box_closed",
                &shift,
                closed_on(&block, 7, 1503, &[4], 50, 55, Some(&p1)),
            ),
        ],
    )
    .await;
    let (status, report) = pallet_report(&admin, &shift).await;
    assert_eq!(status, StatusCode::OK, "{report}");
    let order: Vec<(&str, Vec<&str>)> = report["pallets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|pallet| {
            (
                pallet["id"].as_str().unwrap(),
                pallet["boxes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|b| b["id"].as_str().unwrap())
                    .collect(),
            )
        })
        .collect();
    let (b4, b5, b6, b7) = (box_id(4), box_id(5), box_id(6), box_id(7));
    assert_eq!(
        order,
        vec![
            (p1.as_str(), vec![b6.as_str(), b7.as_str()]),
            (p2.as_str(), vec![b4.as_str(), b5.as_str()]),
        ]
    );
    let late = &report["pallets"][0]["boxes"][1];
    assert_eq!(late["closedAt"], json!(instant(55, 0)));
    assert_eq!(late["units"], json!(1));
    assert_eq!(report["pallets"][0]["closedAt"], json!(instant(41, 0)));
}

/// The four reads are one snapshot: whatever commits between them, on
/// another connection, is in no part of the answer. After the shift a write
/// lands that the organization's read would show, after the organization one
/// that the pallets' read would show, after the pallets one that the boxes'
/// read would show; the answer is the one read before any of them, and a
/// plain read afterwards shows all three. An unknown shift stops after its
/// own query.
#[tokio::test]
async fn the_four_reads_of_the_pallet_forms_are_one_snapshot_whatever_commits_between_them() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let p1 = pallet_id(1);
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
                "box_closed",
                &floor.shift,
                closed_on(&block, 1, 1500, &[1], 10, 20, Some(&p1)),
            ),
            fact(
                &record_id(3),
                "pallet_closed",
                &floor.shift,
                pallet_closed(&p1, &pallets, 40, 1, &instant(20, 0), &instant(30, 0)),
            ),
        ],
    )
    .await;
    let (status, before) = pallet_report(&admin, &floor.shift).await;
    assert_eq!(status, StatusCode::OK, "{before}");
    assert_eq!(before["pallets"][0]["boxes"][0]["units"], json!(1));
    assert_eq!(before["pallets"][0]["disassembledAt"], Value::Null);

    let pool = admin.app.state.pool.clone();
    let writer = pool.clone();
    let steps = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = steps.clone();
    let rows =
        markiro_host::routes::office_reports::read_pallet_rows(&pool, &floor.shift, move |step| {
            let pool = writer.clone();
            seen.lock().unwrap().push(step);
            async move {
                let write = match step {
                    "shift" => "UPDATE org_profile SET name = 'Переименована'",
                    "organization" => {
                        "UPDATE pallets SET disassembled_at = '2026-10-08T09:00:00.000Z'"
                    }
                    "pallets" => "UPDATE box_items SET removed_at = '2026-10-08T09:00:00.000Z'",
                    // Nothing is left to read after the last query.
                    "boxes" => return,
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
    assert_eq!(
        *steps.lock().unwrap(),
        ["shift", "organization", "pallets", "boxes"]
    );
    assert_eq!(serde_json::to_value(&rows).unwrap(), before);

    let (_, after) = pallet_report(&admin, &floor.shift).await;
    assert_eq!(after["organization"]["name"], "Переименована");
    assert_eq!(
        after["pallets"][0]["disassembledAt"],
        json!("2026-10-08T09:00:00.000Z")
    );
    assert_eq!(after["pallets"][0]["boxes"][0]["units"], json!(0));

    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let log = seen.clone();
    let none = markiro_host::routes::office_reports::read_pallet_rows(
        &pool,
        "0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b",
        move |step| {
            log.lock().unwrap().push(step);
            async {}
        },
    )
    .await
    .unwrap();
    assert!(none.is_none());
    assert_eq!(*seen.lock().unwrap(), ["shift"]);
}

/// 300 pallets of five boxes each, written straight into the tables for
/// `floor`'s shift (a day of output is far more than facts can send in a
/// test): pallet `i` opened `300 - i` seconds into the hour (so the later
/// the id, the earlier it opened), box `k` of a pallet closed `4 - k`
/// seconds into the hour (so the later the id, the earlier it closed), one
/// live code in each box. `prefix` makes every id, SSCC, serial and scan of
/// one shift its own.
async fn stack_pallets(admin: &Admin, floor: &Floor, block: &Value, prefix: u32) {
    let pool = &admin.app.state.pool;
    let base = i64::from(prefix) * 100_000;
    sqlx::query(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300) \
         INSERT INTO pallets (id, shift_id, device_id, opened_at, received_at) \
         SELECT printf('a%07d-0000-4000-8000-%012d', ?1, i), ?2, ?3, \
           printf('2026-10-09T05:%02d:%02d.000Z', (300 - i) / 60, (300 - i) % 60), \
           '2026-10-09T12:00:00Z' FROM n",
    )
    .bind(prefix)
    .bind(&floor.shift)
    .bind(&floor.station)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300), \
         k(k) AS (SELECT 0 UNION ALL SELECT k + 1 FROM k WHERE k < 4) \
         INSERT INTO boxes (id, shift_id, device_id, opened_at, closed_at, sscc, block_id, \
           serial, item_count_reported, membership_digest, digest_matches, received_at, \
           pallet_id) \
         SELECT printf('b%07d-0000-4000-8000-%012d', ?1, i * 10 + k), ?2, ?3, \
           '2026-10-09T04:00:00.000Z', printf('2026-10-09T06:00:%02d.000Z', 4 - k), \
           printf('04600682%010d', ?4 + i * 10 + k), ?5, ?4 + i * 10 + k, 1, 'd', 1, \
           '2026-10-09T12:00:00Z', printf('a%07d-0000-4000-8000-%012d', ?1, i) \
         FROM n, k",
    )
    .bind(prefix)
    .bind(&floor.shift)
    .bind(&floor.station)
    .bind(base)
    .bind(block["id"].as_str().unwrap())
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300), \
         k(k) AS (SELECT 0 UNION ALL SELECT k + 1 FROM k WHERE k < 4) \
         INSERT INTO scans (id, record_id, device_id, shift_id, verdict, raw_kind, raw_length, \
           code_hash, gtin14, serial, canonical, box_id, scanned_at, received_at) \
         SELECT printf('c%07d-0000-4000-8000-%012d', ?1, i * 10 + k), \
           printf('c%07d-0000-4000-8000-%012d', ?1, i * 10 + k), ?2, ?3, 'ok', 'km', 38, \
           printf('%064x', ?4 + i * 10 + k), '04600682000013', printf('P%07d', i * 10 + k), \
           printf('0104600682000013' || '21P%07d' || char(29) || '93Zz', i * 10 + k), \
           printf('b%07d-0000-4000-8000-%012d', ?1, i * 10 + k), \
           '2026-10-09T05:00:00.000Z', '2026-10-09T12:00:00Z' FROM n, k",
    )
    .bind(prefix)
    .bind(&floor.station)
    .bind(&floor.shift)
    .bind(base)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO box_items (scan_id, box_id, code_hash, added_at) \
         SELECT id, box_id, code_hash, scanned_at FROM scans WHERE shift_id = ?1",
    )
    .bind(&floor.shift)
    .execute(pool)
    .await
    .unwrap();
}

/// A shift of 300 pallets and 1500 boxes, beside a colleague's of as many,
/// comes whole: every pallet opened first first (the later the id the
/// earlier it opened), its five boxes closed first first (the later the id
/// the earlier it closed), one live unit each, none of the colleague's; and
/// with that many rows in the tables the queries still search by their named
/// indexes (the host gathers no statistics, so the plan is the one it has
/// in production).
#[tokio::test]
async fn a_shift_of_hundreds_of_pallets_comes_whole_in_order_and_still_by_the_indexes() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_pallet_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let colleague_block = issue_block(&admin.app, &colleague.key, COLLEAGUE_BLOCK_REQUEST).await;
    stack_pallets(&admin, &floor, &block, 1).await;
    stack_pallets(&admin, &colleague, &colleague_block, 2).await;

    let started = std::time::Instant::now();
    let (status, report) = pallet_report(&admin, &floor.shift).await;
    let elapsed = started.elapsed();
    assert_eq!(status, StatusCode::OK);
    assert!(elapsed < std::time::Duration::from_secs(10), "{elapsed:?}");
    let pallets = report["pallets"].as_array().unwrap();
    assert_eq!(pallets.len(), 300);
    for (position, pallet) in pallets.iter().enumerate() {
        let i = 300 - position;
        assert_eq!(
            pallet["id"],
            json!(format!("a0000001-0000-4000-8000-{i:012}"))
        );
        assert_eq!(pallet["sscc"], Value::Null);
        let boxes: Vec<(&str, &str, u64)> = pallet["boxes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| {
                (
                    b["id"].as_str().unwrap(),
                    b["closedAt"].as_str().unwrap(),
                    b["units"].as_u64().unwrap(),
                )
            })
            .collect();
        let expected: Vec<(String, String, u64)> = (0..5)
            .rev()
            .map(|k| {
                (
                    format!("b0000001-0000-4000-8000-{:012}", i * 10 + k),
                    format!("2026-10-09T06:00:{:02}.000Z", 4 - k),
                    1,
                )
            })
            .collect();
        assert_eq!(
            boxes,
            expected
                .iter()
                .map(|(id, at, units)| (id.as_str(), at.as_str(), *units))
                .collect::<Vec<_>>(),
            "pallet {i}"
        );
    }
    let (_, theirs) = pallet_report(&admin, &colleague.shift).await;
    assert_eq!(theirs["shift"]["number"], json!(colleague.number));
    assert_eq!(theirs["pallets"].as_array().unwrap().len(), 300);
    assert!(theirs["pallets"]
        .as_array()
        .unwrap()
        .iter()
        .all(
            |pallet| pallet["id"].as_str().unwrap().starts_with("a0000002-")
                && pallet["boxes"].as_array().unwrap().len() == 5
        ));

    use markiro_host::routes::office_reports::{PALLETS_SQL, PALLET_BOXES_SQL, PALLET_SHIFT_SQL};
    for (sql, indexes) in [
        (
            PALLET_SHIFT_SQL,
            &["sqlite_autoindex_shifts_1", "sqlite_autoindex_products_1"][..],
        ),
        (PALLETS_SQL, &["pallets_shift"][..]),
        (PALLET_BOXES_SQL, &["boxes_shift", "box_items_live"][..]),
    ] {
        let plan: Vec<(i64, i64, i64, String)> =
            sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
                .bind(&floor.shift)
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

/// A shift id of no form a shift has is `not_found`, not a failure of the
/// host, and a session the host does not know is refused like none.
#[tokio::test]
async fn an_id_of_no_shift_is_not_found_for_the_pallet_forms_and_an_unknown_session_is_refused() {
    let admin = admin().await;
    let (status, body) = pallet_report(&admin, "not-a-shift").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "not_found");
    let path = "/v1/office/shifts/0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b/pallet-report-data";
    let (status, body) = admin
        .app
        .send(empty(support::app::with_session(
            request("GET", path),
            &admin.key,
            "not-a-session-token",
        )))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["details"]["credential"], "session");
}
