mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, box_closed, box_id, code, code_hash, empty, fact, instant, issue_block,
    issue_pallet_block, ok_scan, open_pallet_floor, pallet_closed, pallet_id, receipts, record_id,
    request, shift_setup, with_device, Admin,
};

const BLOCK: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const PALLETS: &str = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";

/// An instant of `instant(m, s)` in milliseconds since 1970, as the list asks them.
fn ms(at: &str) -> i128 {
    time::OffsetDateTime::parse(at, &time::format_description::well_known::Rfc3339)
        .unwrap()
        .unix_timestamp_nanos()
        / 1_000_000
}

fn other_scan(verdict: &str, raw_kind: &str, code: Value, source: Value, at: &str) -> Value {
    json!({
        "scannedAt": at, "verdict": verdict, "duplicateSource": source, "rawKind": raw_kind,
        "rawLength": 14, "code": code, "boxId": null
    })
}

/// A pallet shift with six scans: codes 1 and 2 in box 1 (closed, on pallet 1,
/// closed), code 3 in the open box 3, then a duplicate of code 1, a scan of
/// another product's code and an unreadable one.
async fn busy_shift() -> (Admin, support::app::Floor) {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    sqlx::query("UPDATE devices SET name = 'Станция А' WHERE id = ?")
        .bind(&floor.station)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
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
    let mut other = code(7);
    other["gtin14"] = json!("04600682000099");
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
                other_scan("duplicate", "km", code(1), json!("host"), &instant(41, 0)),
            ),
            fact(
                &record_id(6),
                "scan",
                &shift,
                other_scan("wrong_gtin", "km", other, Value::Null, &instant(42, 0)),
            ),
            fact(
                &record_id(7),
                "scan",
                &shift,
                other_scan(
                    "invalid",
                    "unknown",
                    Value::Null,
                    Value::Null,
                    &instant(43, 0),
                ),
            ),
            fact(
                &record_id(8),
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
        ],
    )
    .await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
    (admin, floor)
}

async fn scans(admin: &Admin, shift: &str, query: &str) -> (StatusCode, Value) {
    admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{shift}/scans{query}"),
            None,
        )
        .await
}

/// Newest first, each row its journal row's: the verdict and its source, the
/// station and the box and pallet with their SSCC; the code goes as its GTIN
/// and the last four characters of its serial, never whole.
#[tokio::test]
async fn a_shifts_scans_come_newest_first_with_a_masked_code_and_their_box_and_pallet() {
    let (admin, floor) = busy_shift().await;
    let (status, body) = scans(&admin, &floor.shift, "").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let items = body["items"].as_array().unwrap();
    assert_eq!(body["nextCursor"], Value::Null);
    let at: Vec<&str> = items
        .iter()
        .map(|i| i["scannedAt"].as_str().unwrap())
        .collect();
    assert_eq!(
        at,
        vec![
            instant(43, 0),
            instant(42, 0),
            instant(41, 0),
            instant(40, 0),
            instant(11, 0),
            instant(10, 0)
        ]
    );
    let verdicts: Vec<&str> = items
        .iter()
        .map(|i| i["verdict"].as_str().unwrap())
        .collect();
    assert_eq!(
        verdicts,
        ["invalid", "wrong_gtin", "duplicate", "ok", "ok", "ok"]
    );
    // The unreadable one has no code at all.
    assert_eq!(
        (items[0]["gtin14"].clone(), items[0]["serialTail"].clone()),
        (Value::Null, Value::Null)
    );
    assert_eq!(items[2]["duplicateSource"], "host");
    assert_eq!(items[1]["gtin14"], "04600682000099");
    // S000007: the last four characters only.
    assert_eq!(items[1]["serialTail"], "0007");
    assert_eq!(items[5]["serialTail"], "0001");
    assert_eq!(items[5]["gtin14"], "04600682000013");
    // The box and the pallet of an accepted scan, with their SSCC; an open box has none.
    assert_eq!(items[5]["boxId"], box_id(1));
    assert_eq!(items[5]["palletId"], pallet_id(1));
    let box_sscc: String = sqlx::query_scalar("SELECT sscc FROM boxes WHERE id = ?")
        .bind(box_id(1))
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let pallet_sscc: String = sqlx::query_scalar("SELECT sscc FROM pallets WHERE id = ?")
        .bind(pallet_id(1))
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(items[5]["boxSscc"], box_sscc);
    assert_eq!(items[5]["palletSscc"], pallet_sscc);
    assert_eq!(items[3]["boxId"], box_id(3));
    assert_eq!(
        (items[3]["boxSscc"].clone(), items[3]["palletId"].clone()),
        (Value::Null, Value::Null)
    );
    assert_eq!(
        (items[0]["boxId"].clone(), items[0]["operatorName"].clone()),
        (Value::Null, Value::Null)
    );
    let device: String = sqlx::query_scalar("SELECT name FROM devices WHERE id = ?")
        .bind(&floor.station)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(items[0]["deviceName"], device);
    assert_eq!(items[0]["deviceId"], floor.station);
    // Neither the serial whole nor the canonical text nor the hash goes out.
    let text = body.to_string();
    assert!(
        !text.contains("S000001") && !text.contains("canonical") && !text.contains(&code_hash(1))
    );
    assert!(!text.contains('\u{1d}'));
}

/// A page of two, then the next by the cursor, until none is left; no scan is
/// repeated or skipped, and a scan that arrives between two pages (an older
/// instant) leaves the cursor's place alone.
#[tokio::test]
async fn the_cursor_pages_the_scans_without_a_repeat_or_a_gap() {
    let (admin, floor) = busy_shift().await;
    let mut seen: Vec<String> = Vec::new();
    let mut cursor = String::new();
    let mut pages = 0;
    loop {
        let (status, body) = scans(&admin, &floor.shift, &format!("?limit=2{cursor}")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        pages += 1;
        let items = body["items"].as_array().unwrap();
        assert!(items.len() <= 2);
        seen.extend(items.iter().map(|i| i["id"].as_str().unwrap().to_owned()));
        match body["nextCursor"].as_str() {
            Some(next) => {
                assert_eq!(items.len(), 2);
                cursor = format!("&cursor={next}");
            }
            None => break,
        }
    }
    assert_eq!(pages, 3);
    let (_, all) = scans(&admin, &floor.shift, "").await;
    let expected: Vec<String> = all["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(seen, expected);
}

#[tokio::test]
async fn the_filters_narrow_by_result_station_box_time_and_serial_tail() {
    let (admin, floor) = busy_shift().await;
    let ids = |body: &Value| -> Vec<String> {
        body["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["scannedAt"].as_str().unwrap().to_owned())
            .collect()
    };
    let (_, body) = scans(&admin, &floor.shift, "?result=ok").await;
    assert_eq!(ids(&body), [instant(40, 0), instant(11, 0), instant(10, 0)]);
    let (_, body) = scans(&admin, &floor.shift, "?result=wrong_gtin").await;
    assert_eq!(ids(&body), [instant(42, 0)]);
    let (_, body) = scans(&admin, &floor.shift, &format!("?device={}", floor.station)).await;
    assert_eq!(ids(&body).len(), 6);
    let (_, body) = scans(&admin, &floor.shift, &format!("?device={}", box_id(9))).await;
    assert!(ids(&body).is_empty());
    let (_, body) = scans(&admin, &floor.shift, &format!("?box={}", box_id(1))).await;
    assert_eq!(ids(&body), [instant(11, 0), instant(10, 0)]);
    // From is inclusive, to is exclusive.
    let query = format!(
        "?fromMs={}&toMs={}",
        ms(&instant(11, 0)),
        ms(&instant(41, 0))
    );
    let (_, body) = scans(&admin, &floor.shift, &query).await;
    assert_eq!(ids(&body), [instant(40, 0), instant(11, 0)]);
    // The tail of a serial; a tail longer than four characters still matches
    // the whole serial, and a wrong one nothing.
    let (_, body) = scans(&admin, &floor.shift, "?q=0002").await;
    assert_eq!(ids(&body), [instant(11, 0)]);
    let (_, body) = scans(&admin, &floor.shift, "?q=S000002").await;
    assert_eq!(ids(&body), [instant(11, 0)]);
    let (_, body) = scans(&admin, &floor.shift, "?q=002").await;
    assert_eq!(ids(&body), [instant(11, 0)]);
    let (_, body) = scans(&admin, &floor.shift, "?q=9999").await;
    assert!(ids(&body).is_empty());
    // Together: ok scans of the box in the range with a tail.
    let query = format!("?result=ok&box={}&q=1", box_id(1));
    let (_, body) = scans(&admin, &floor.shift, &query).await;
    assert_eq!(ids(&body), [instant(10, 0)]);
}

/// An unknown shift is not_found; a malformed parameter names itself.
#[tokio::test]
async fn an_unknown_shift_is_not_found_and_a_malformed_parameter_is_named() {
    let (admin, floor) = busy_shift().await;
    let (status, body) = scans(&admin, &box_id(5), "").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    for (query, field) in [
        ("?result=bad", "result"),
        ("?device=x", "device"),
        ("?box=x", "box"),
        ("?fromMs=yesterday", "fromMs"),
        ("?toMs=2026-10-08", "toMs"),
        ("?fromMs=2000&toMs=1000", "toMs"),
        ("?cursor=2026-10-08T06%3A41%3A10Z%7Cx", "cursor"),
        ("?cursor=1000~not-a-uuid", "cursor"),
        ("?q=", "q"),
        ("?cursor=nope", "cursor"),
        ("?limit=0", "limit"),
        ("?limit=101", "limit"),
    ] {
        let (status, body) = scans(&admin, &floor.shift, query).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {body}");
        assert_eq!(body["error"]["details"]["field"], field, "{query}: {body}");
    }
    let (status, _) = scans(&admin, &floor.shift, "?other=1").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// Office only: a device key alone, an unknown session, no session read no
/// scans; a technologist reads them.
#[tokio::test]
async fn the_scan_history_needs_an_office_session() {
    let (admin, floor) = busy_shift().await;
    let (tech, _) = admin.technologist_session().await;
    let path = format!("/v1/office/shifts/{}/scans", floor.shift);
    let (status, body) = admin
        .app
        .send(empty(with_device(request("GET", &path), &floor.key)))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    let (status, body) = admin.call_as("not-a-session", "GET", &path, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    let (status, _) = admin.call_as(&tech, "GET", &path, None).await;
    assert_eq!(status, StatusCode::OK);
}

/// The query reads the shift's scans through `scans_shift_time` (migration
/// `0033`), in the page's order, and never walks
/// the whole journal.
#[tokio::test]
async fn the_scans_query_searches_by_the_shift_index() {
    let admin = admin().await;
    let plan: Vec<(i64, i64, i64, String)> = sqlx::query_as(&format!(
        "EXPLAIN QUERY PLAN {}",
        markiro_host::routes::office_scan_history::SCANS_SQL
    ))
    .bind("0b8f4e2a-6c1d-4f3e-9a7b-2d5c8e1f4a6b")
    .bind(Option::<String>::None)
    .bind(Option::<String>::None)
    .bind(Option::<String>::None)
    .bind(Option::<String>::None)
    .bind(Option::<String>::None)
    .bind(Option::<String>::None)
    .bind(Option::<String>::None)
    .bind(Option::<String>::None)
    .bind(51_i64)
    .fetch_all(&admin.app.state.pool)
    .await
    .unwrap();
    let steps: Vec<&str> = plan.iter().map(|(_, _, _, step)| step.as_str()).collect();
    assert!(
        steps.iter().all(|step| !step.starts_with("SCAN")),
        "{steps:?}"
    );
    assert!(
        steps
            .iter()
            .any(|step| step.starts_with("SEARCH s USING INDEX scans_shift")
                || step.starts_with("SEARCH s USING COVERING INDEX scans_shift")),
        "{steps:?}"
    );
    // The pages come in the order of the index: no sort of the shift's scans.
    assert!(
        steps.iter().all(|step| !step.contains("TEMP B-TREE")),
        "{steps:?}"
    );
}
