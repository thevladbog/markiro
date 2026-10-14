//! The office's list of every pallet of the site (plan КРТ, parity spec
//! §5.3): `GET /v1/office/pallets`, narrowed by product, line, station, a
//! period of closing and an SSCC, open pallets first, then closed newest
//! first, 100 a page by a cursor. Every office role reads it.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    add_operator, admin, audit_rows, box_closed, box_exception, box_id, code_hash, empty, fact,
    fact_rows, instant, issue_block, issue_pallet_block, login, ok_scan, open_pallet_floor,
    pair_device, pallet_closed, pallet_id, pallet_sscc, receipts, record_id, request, shift_setup,
    with_device, with_session, Admin, Floor,
};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const PALLET_REQUEST: &str = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";
const COLLEAGUE_BLOCK_REQUEST: &str = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";
const COLLEAGUE_PALLET_REQUEST: &str = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

/// A day of two stations on two lines, both shifts with pallets.
/// The station: codes 1-3 into box 1 (2 by Анна), 3 undone; box 1 closed
/// (serial 1500) on pallet 1; codes 4, 5 into box 2, closed (1501) on
/// pallet 1; pallet 1 closed (serial 40, two boxes counted); box 2 then
/// taken apart (`wrong_quantity`); pallet 1's label printed again.
/// The colleague, a day later by the host's clock: an earlier scan of
/// code 2 into box 11 takes it from box 1; box 11 closed (3500) on
/// pallet 2, closed (240) before pallet 1; code 6 into box 12, closed
/// (3501) on pallet 3, which stays open.
struct Yard {
    admin: Admin,
    floor: Floor,
    colleague: Floor,
    pallet_block: Value,
    other_line: String,
    product: String,
    tech: String,
    admin_token: String,
}

async fn accept(admin: &Admin, floor: &Floor, records: &[Value]) {
    let answered = receipts(&admin.app, &floor.key, records).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
}

async fn yard() -> Yard {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let (operator, _) = add_operator(&admin, "1001").await;
    let shift = floor.shift.clone();
    let scan = |record: u32, code: u32, n: u32, second: u32| {
        fact(
            &record_id(record),
            "scan",
            &shift,
            ok_scan(code, &box_id(n), &instant(second, 0)),
        )
    };
    let mut by_anna = scan(2, 2, 1, 11);
    by_anna["operatorId"] = json!(operator);
    let mut undo = box_exception("undo", &box_id(1), &instant(13, 0));
    undo["codeHash"] = json!(code_hash(3));
    undo["targetScannedAt"] = json!(instant(12, 0));
    let mut closed1 = box_closed(
        &box_id(1),
        &block,
        1500,
        &[1, 2],
        &instant(10, 0),
        &instant(20, 0),
    );
    closed1["palletId"] = json!(pallet_id(1));
    let mut closed2 = box_closed(
        &box_id(2),
        &block,
        1501,
        &[4, 5],
        &instant(30, 0),
        &instant(40, 0),
    );
    closed2["palletId"] = json!(pallet_id(1));
    let mut taken_apart = box_exception("disassemble", &box_id(2), &instant(50, 0));
    taken_apart["reasonCode"] = json!("wrong_quantity");
    let reprint = json!({
        "exception": "reprint", "palletId": pallet_id(1), "reasonCode": "damaged_label",
        "reasonText": null, "occurredAt": instant(55, 0)
    });
    let mut closed1_fact = fact(&record_id(5), "box_closed", &shift, closed1);
    closed1_fact["operatorId"] = json!(operator);
    accept(
        &admin,
        &floor,
        &[
            scan(1, 1, 1, 10),
            by_anna,
            scan(3, 3, 1, 12),
            fact(&record_id(4), "box_exception", &shift, undo),
            closed1_fact,
            scan(6, 4, 2, 30),
            scan(7, 5, 2, 31),
            fact(&record_id(8), "box_closed", &shift, closed2),
            fact(
                &record_id(9),
                "pallet_closed",
                &shift,
                pallet_closed(
                    &pallet_id(1),
                    &pallets,
                    40,
                    2,
                    &instant(20, 0),
                    &instant(41, 0),
                ),
            ),
            fact(&record_id(10), "box_exception", &shift, taken_apart),
            fact(&record_id(11), "pallet_exception", &shift, reprint),
        ],
    )
    .await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_pallet_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    let colleague_block = issue_block(&admin.app, &colleague.key, COLLEAGUE_BLOCK_REQUEST).await;
    let colleague_pallets =
        issue_pallet_block(&admin.app, &colleague.key, COLLEAGUE_PALLET_REQUEST).await;
    // The host's clock moves past the station's day: the colleague's take of
    // code 2 is the last thing that happened to it.
    admin.app.clock.advance(time::Duration::days(17));
    let other = colleague.shift.clone();
    let mut closed11 = box_closed(
        &box_id(11),
        &colleague_block,
        3500,
        &[2],
        &instant(5, 0),
        &instant(6, 0),
    );
    closed11["palletId"] = json!(pallet_id(2));
    let mut closed12 = box_closed(
        &box_id(12),
        &colleague_block,
        3501,
        &[6],
        &instant(7, 0),
        &instant(8, 0),
    );
    closed12["palletId"] = json!(pallet_id(3));
    accept(
        &admin,
        &colleague,
        &[
            fact(
                &record_id(1),
                "scan",
                &other,
                ok_scan(2, &box_id(11), &instant(5, 0)),
            ),
            fact(&record_id(2), "box_closed", &other, closed11),
            fact(
                &record_id(3),
                "pallet_closed",
                &other,
                pallet_closed(
                    &pallet_id(2),
                    &colleague_pallets,
                    240,
                    1,
                    &instant(6, 0),
                    &instant(9, 0),
                ),
            ),
            fact(
                &record_id(4),
                "scan",
                &other,
                ok_scan(6, &box_id(12), &instant(7, 0)),
            ),
            fact(&record_id(5), "box_closed", &other, closed12),
        ],
    )
    .await;
    let tech = admin.technologist().await;
    let admin_token = login(&admin.app, &admin.key, "admin", "correct horse battery").await;
    Yard {
        admin,
        floor,
        colleague,
        pallet_block: pallets,
        other_line: setup.other_line.clone(),
        product: setup.product.clone(),
        tech,
        admin_token,
    }
}

/// The instant `instant(second, 0)` as milliseconds since the epoch, as the
/// office sends a period's ends.
fn millis(second: u32) -> i128 {
    OffsetDateTime::parse(&instant(second, 0), &Rfc3339)
        .unwrap()
        .unix_timestamp_nanos()
        / 1_000_000
}

async fn page(yard: &Yard, query: &str) -> Value {
    let path = if query.is_empty() {
        "/v1/office/pallets".to_owned()
    } else {
        format!("/v1/office/pallets?{query}")
    };
    let (status, page) = yard.admin.call_as(&yard.tech, "GET", &path, None).await;
    assert_eq!(status, StatusCode::OK, "{query}: {page}");
    page
}

fn ids(page: &Value) -> Vec<String> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_owned())
        .collect()
}

/// Open pallets first, then closed newest first, across shifts, lines and
/// stations.
#[tokio::test]
async fn the_list_runs_across_shifts_open_first_then_closed_newest_first() {
    let yard = yard().await;
    let first = page(&yard, "").await;
    assert_eq!(ids(&first), [pallet_id(3), pallet_id(1), pallet_id(2)]);
    assert_eq!(first["nextCursor"], Value::Null);
    let row = &first["items"][1];
    assert_eq!(row["shiftNumber"], yard.floor.number);
    assert_eq!(row["productionDate"], "2026-10-08");
    assert_eq!(row["productName"], "Молоко 3,2% 0,9 л");
    assert_eq!(row["lineName"], "Линия 1");
    assert_eq!(row["sscc"], pallet_sscc(40));
    assert_eq!(
        (row["boxes"].clone(), row["boxCountReported"].clone()),
        (json!(1), json!(2))
    );
    assert_eq!(row["units"], 1);
    assert_eq!(first["items"][0]["sscc"], Value::Null);
    assert_eq!(first["items"][0]["lineName"], "Линия 2");
    let stations: Vec<&str> = first["stations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap())
        .collect();
    assert!(stations.contains(&yard.floor.station.as_str()));
    assert!(stations.contains(&yard.colleague.station.as_str()));
    assert_eq!(first["stations"][0]["revoked"], false);
}

#[tokio::test]
async fn each_filter_narrows_the_list() {
    let yard = yard().await;
    // The colleague's shift is on «Линия 2» (`setup.other_line`, kept in `Yard`).
    let line = yard.other_line.clone();
    assert_eq!(
        ids(&page(&yard, &format!("line={line}")).await),
        [pallet_id(3), pallet_id(2)]
    );
    assert_eq!(
        ids(&page(&yard, &format!("device={}", yard.floor.station)).await),
        [pallet_id(1)]
    );
    assert_eq!(
        ids(&page(&yard, &format!("sscc={}", pallet_sscc(40))).await),
        [pallet_id(1)]
    );
    assert_eq!(
        ids(&page(&yard, "sscc=146006820000009999").await),
        Vec::<String>::new()
    );
    // A period of closing: [from, to) in ms; an open pallet is never in one.
    let (from, to) = (millis(9), millis(41));
    assert_eq!(
        ids(&page(&yard, &format!("fromMs={from}&toMs={to}")).await),
        [pallet_id(2)]
    );
    assert_eq!(
        ids(&page(&yard, &format!("fromMs={to}")).await),
        [pallet_id(1)],
        "from alone: closed at or after it; an open pallet is not in a period"
    );
    // The product: both shifts are of the same one, so all three; a made-up one none.
    assert_eq!(
        ids(&page(&yard, &format!("product={}", yard.product)).await).len(),
        3
    );
    assert_eq!(
        ids(&page(&yard, "product=6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f").await),
        Vec::<String>::new()
    );
    // Filters combine.
    assert_eq!(
        ids(&page(&yard, &format!("line={line}&fromMs={to}")).await),
        Vec::<String>::new()
    );
}

/// A page of 100 continues below its last row, ties of the closing instant
/// broken by id, with nothing lost or repeated.
#[tokio::test]
async fn the_list_pages_by_a_cursor_through_ties() {
    let yard = yard().await;
    // 101 more pallets closed at one instant, none with a box (a pallet whose
    // boxes never reached the host is closed all the same).
    let records: Vec<Value> = (0..101u32)
        .map(|n| {
            fact(
                &record_id(100 + n),
                "pallet_closed",
                &yard.floor.shift,
                pallet_closed(
                    &pallet_id(100 + n),
                    &yard.pallet_block,
                    41 + u64::from(n),
                    1,
                    &instant(60, 0),
                    &instant(61, 0),
                ),
            )
        })
        .collect();
    for chunk in records.chunks(50) {
        accept(&yard.admin, &yard.floor, chunk).await;
    }
    let first = page(&yard, "").await;
    assert_eq!(first["items"].as_array().unwrap().len(), 100);
    assert_eq!(first["items"][0]["id"], pallet_id(3), "open pallets first");
    let cursor = first["nextCursor"].as_str().unwrap().to_owned();
    assert!(cursor.contains('~') && !cursor.contains(':'), "{cursor}");
    let second = page(&yard, &format!("cursor={cursor}")).await;
    assert_eq!(second["nextCursor"], Value::Null);
    let mut all = ids(&first);
    all.extend(ids(&second));
    assert_eq!(all.len(), 104);
    let unique: std::collections::BTreeSet<&String> = all.iter().collect();
    assert_eq!(unique.len(), 104, "nothing repeated");
    // Ties by id, the largest first; then pallet 1 and pallet 2 by closing.
    assert_eq!(
        all[100..].to_vec(),
        vec![pallet_id(101), pallet_id(100), pallet_id(1), pallet_id(2)]
    );
}

/// A pallet that closes between two pages neither skips nor repeats a row.
#[tokio::test]
async fn a_pallet_closing_between_two_pages_loses_and_repeats_nothing() {
    let yard = yard().await;
    let records: Vec<Value> = (0..100u32)
        .map(|n| {
            fact(
                &record_id(100 + n),
                "pallet_closed",
                &yard.floor.shift,
                pallet_closed(
                    &pallet_id(100 + n),
                    &yard.pallet_block,
                    41 + u64::from(n),
                    1,
                    &instant(60, 0),
                    &instant(61, 0),
                ),
            )
        })
        .collect();
    accept(&yard.admin, &yard.floor, &records[..50]).await;
    accept(&yard.admin, &yard.floor, &records[50..]).await;
    let first = page(&yard, "").await;
    let cursor = first["nextCursor"].as_str().unwrap().to_owned();
    // The colleague's open pallet 3 closes now; it was on the first page as
    // an open one, so it is not met again below the cursor.
    let colleague_pallets = issue_pallet_block(
        &yard.admin.app,
        &yard.colleague.key,
        COLLEAGUE_PALLET_REQUEST,
    )
    .await;
    accept(
        &yard.admin,
        &yard.colleague,
        &[fact(
            &record_id(50),
            "pallet_closed",
            &yard.colleague.shift,
            pallet_closed(
                &pallet_id(3),
                &colleague_pallets,
                242,
                1,
                &instant(7, 0),
                &instant(70, 0),
            ),
        )],
    )
    .await;
    let second = page(&yard, &format!("cursor={cursor}")).await;
    let mut all = ids(&first);
    all.extend(ids(&second));
    let unique: std::collections::BTreeSet<&String> = all.iter().collect();
    assert_eq!(unique.len(), all.len(), "nothing repeated");
    assert!(
        !ids(&second).contains(&pallet_id(3)),
        "pallet 3 stood above the cursor"
    );
}

#[tokio::test]
async fn a_malformed_parameter_is_refused_with_its_field() {
    let yard = yard().await;
    for (query, field) in [
        ("product=not-a-uuid", "product"),
        ("line=A0000000-0000-4000-8000-000000000001", "line"),
        ("device=1", "device"),
        ("sscc=12345", "sscc"),
        ("fromMs=x", "fromMs"),
        ("fromMs=2000&toMs=1000", "toMs"),
        (
            "cursor=2026-10-08~a0000000-0000-4000-8000-000000000001",
            "cursor",
        ),
        ("cursor=o~nope", "cursor"),
        ("cursor=nothing", "cursor"),
    ] {
        let (status, body) = yard
            .admin
            .call_as(
                &yard.tech,
                "GET",
                &format!("/v1/office/pallets?{query}"),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {body}");
        assert_eq!(body["error"]["details"]["field"], field, "{query}: {body}");
    }
    let (status, _) = yard
        .admin
        .call_as(&yard.tech, "GET", "/v1/office/pallets?kind=warehouse", None)
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "an unknown parameter");
}

#[tokio::test]
async fn only_an_office_session_reads_the_list_and_a_read_writes_nothing() {
    let yard = yard().await;
    let app = &yard.admin.app;
    let (_, other) = pair_device(app, "station").await;
    let facts_before = fact_rows(app).await;
    let audit_before = audit_rows(app).await;
    let path = "/v1/office/pallets";
    for (who, builder) in [
        (
            "the station's key",
            with_device(request("GET", path), &yard.floor.key),
        ),
        (
            "another device with the admin's session",
            with_session(request("GET", path), &other, &yard.admin_token),
        ),
        (
            "a made-up session",
            with_session(request("GET", path), &yard.floor.key, "operator-pin-4821"),
        ),
        ("nothing", request("GET", path)),
    ] {
        let (status, body) = app.send(empty(builder)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{who}: {body}");
        let text = body.to_string();
        for secret in [pallet_sscc(40).as_str(), "Станция на", "Кузнецова"] {
            assert!(!text.contains(secret), "{who} leaked {secret}: {text}");
        }
    }
    let (status, _) = yard
        .admin
        .call_as(&yard.admin_token, "GET", path, None)
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = yard.admin.call_as(&yard.tech, "GET", path, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(fact_rows(app).await, facts_before);
    assert_eq!(audit_rows(app).await, audit_before);
}

/// The list is read through `pallets_list_order` without sorting, the SSCC
/// through `pallets_sscc`; the stations are a scan of a table of a handful.
#[tokio::test]
async fn the_list_is_read_in_its_order_through_an_index() {
    let admin = admin().await;
    for (name, sql, index) in [
        (
            "list",
            markiro_host::routes::office_pallets::LIST_SQL,
            "pallets_list_order",
        ),
        (
            "by sscc",
            markiro_host::routes::office_pallets::BY_SSCC_SQL,
            "pallets_sscc",
        ),
    ] {
        let plan: Vec<(i64, i64, i64, String)> =
            sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
                .fetch_all(&admin.app.state.pool)
                .await
                .unwrap();
        let steps: Vec<&str> = plan.iter().map(|(_, _, _, s)| s.as_str()).collect();
        assert!(
            steps.iter().any(|s| s.contains(&format!("INDEX {index}"))),
            "{name}: {steps:?}"
        );
        assert!(
            steps.iter().all(|s| !s.contains("TEMP B-TREE")),
            "{name} sorts: {steps:?}"
        );
        assert!(
            steps
                .iter()
                .all(|s| !s.starts_with("SCAN") || s.contains("USING")),
            "{name}: {steps:?}"
        );
    }
}

/// Migration 0025: the list's index exists, and `scans_ok_box` survives
/// whatever rebuilt `scans` before it.
#[tokio::test]
async fn migration_0025_makes_the_lists_index_and_keeps_the_box_items_index() {
    let admin = admin().await;
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'index' \
         AND name IN ('pallets_list_order', 'scans_ok_box') ORDER BY name",
    )
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(names, ["pallets_list_order", "scans_ok_box"]);
}
