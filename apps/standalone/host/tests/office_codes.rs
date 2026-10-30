//! The office's code search (owner's beta feedback «Поиск кодов»): `GET
//! /v1/office/codes` lists the placements of codes in boxes by a code's
//! hash, a GTIN, a box's or a pallet's SSCC, a shift's number and a period
//! of scan instants; `GET /v1/office/codes/{codeHash}` is one code's card
//! with its history. Every office role reads them; nothing else does.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    add_operator, admin, audit_rows, box_closed, box_exception, box_id, code, code_hash, empty,
    fact, fact_rows, instant, issue_block, issue_pallet_block, login, ok_scan, open_pallet_floor,
    pair_device, pallet_closed, pallet_id, pallet_sscc, receipts, record_id, request, shift_setup,
    sscc, with_device, with_session, Admin, Floor,
};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const PALLET_REQUEST: &str = "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c";
const COLLEAGUE_BLOCK_REQUEST: &str = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";
const GTIN: &str = "04600682000013";

async fn accept(admin: &Admin, floor: &Floor, records: &[Value]) {
    let answered = receipts(&admin.app, &floor.key, records).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
}

/// The instant `instant(second, 0)` as milliseconds since the epoch, as the
/// office sends a period's ends.
fn millis(second: u32) -> i128 {
    OffsetDateTime::parse(&instant(second, 0), &Rfc3339)
        .unwrap()
        .unix_timestamp_nanos()
        / 1_000_000
}

/// A day on two lines. The station's shift (with pallets): codes 1 and 2
/// into box 1 (2 by the operator Анна), box 1 closed with SSCC 1500 on
/// pallet 1, which closes with pallet SSCC 40; code 3 into box 2 and taken
/// out again (`undo`); code 4 into box 2, still open; a duplicate of code 2
/// answered by the host. Then, a day later by the host's clock, a
/// colleague's earlier scan of code 2 takes it from box 1 into box 11.
struct Day {
    admin: Admin,
    floor: Floor,
    colleague: Floor,
    /// A technologist's session and the administrator's, opened after the
    /// host's clock moved on (the wizard's session ended meanwhile).
    tech: String,
    admin_token: String,
    operator: String,
}

async fn day() -> Day {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_pallet_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    let block = issue_block(&admin.app, &floor.key, BLOCK_REQUEST).await;
    let pallets = issue_pallet_block(&admin.app, &floor.key, PALLET_REQUEST).await;
    let (operator, _) = add_operator(&admin, "1001").await;
    let (_, colleague_key) = pair_device(&admin.app, "station").await;
    let colleague = open_pallet_floor(&admin, &setup, &colleague_key, &setup.other_line).await;
    issue_block(&admin.app, &colleague.key, COLLEAGUE_BLOCK_REQUEST).await;
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
    let mut closed = box_closed(
        &box_id(1),
        &block,
        1500,
        &[1, 2],
        &instant(10, 0),
        &instant(20, 0),
    );
    closed["palletId"] = json!(pallet_id(1));
    let mut undo = box_exception("undo", &box_id(2), &instant(35, 0));
    undo["codeHash"] = json!(code_hash(3));
    undo["targetScannedAt"] = json!(instant(30, 0));
    let mut duplicate = ok_scan(2, &box_id(2), &instant(36, 0));
    duplicate["verdict"] = json!("duplicate");
    duplicate["duplicateSource"] = json!("host");
    duplicate["boxId"] = Value::Null;
    accept(
        &admin,
        &floor,
        &[
            scan(1, 1, 1, 10),
            by_anna,
            fact(&record_id(3), "box_closed", &shift, closed),
            fact(
                &record_id(4),
                "pallet_closed",
                &shift,
                pallet_closed(
                    &pallet_id(1),
                    &pallets,
                    40,
                    1,
                    &instant(10, 0),
                    &instant(21, 0),
                ),
            ),
            scan(5, 3, 2, 30),
            fact(&record_id(6), "box_exception", &shift, undo),
            scan(7, 4, 2, 40),
            fact(&record_id(8), "scan", &shift, duplicate),
        ],
    )
    .await;
    // The host's clock moves past the station's day, so the colleague's
    // take of code 2 is the last thing that happened to it.
    admin.app.clock.advance(time::Duration::days(17));
    accept(
        &admin,
        &colleague,
        &[fact(
            &record_id(1),
            "scan",
            &colleague.shift,
            ok_scan(2, &box_id(11), &instant(5, 0)),
        )],
    )
    .await;
    let tech = admin.technologist().await;
    let admin_token = login(&admin.app, &admin.key, "admin", "correct horse battery").await;
    Day {
        admin_token,
        admin,
        floor,
        colleague,
        tech,
        operator,
    }
}

impl Day {
    async fn get(&self, path: &str) -> (StatusCode, Value) {
        self.admin.call_as(&self.tech, "GET", path, None).await
    }

    async fn search(&self, query: &str) -> Value {
        let (status, page) = self.get(&format!("/v1/office/codes?{query}")).await;
        assert_eq!(status, StatusCode::OK, "{query}: {page}");
        page
    }

    /// The scan instants of a page's rows, as `instant` seconds name them.
    async fn found(&self, query: &str) -> Vec<(String, String)> {
        let page = self.search(query).await;
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| {
                (
                    item["codeHash"].as_str().unwrap().to_owned(),
                    item["scannedAt"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    }
}

fn row(n: u32, second: u32) -> (String, String) {
    (code_hash(n), instant(second, 0))
}

/// Every criterion finds exactly its placements, newest scan first, and
/// the criteria narrow each other.
#[tokio::test]
async fn every_criterion_finds_its_placements_newest_first() {
    let day = day().await;
    let number = day.floor.number.clone();
    let code2 = code_hash(2);
    assert_eq!(
        day.found(&format!("codeHash={code2}")).await,
        [row(2, 11), row(2, 5)]
    );
    let box_rows = [row(2, 11), row(1, 10)];
    assert_eq!(day.found(&format!("sscc={}", sscc(1500))).await, box_rows);
    assert_eq!(
        day.found(&format!("sscc={}", pallet_sscc(40))).await,
        box_rows
    );
    assert_eq!(
        day.found(&format!("shift={number}")).await,
        [row(4, 40), row(3, 30), row(2, 11), row(1, 10)]
    );
    assert_eq!(
        day.found(&format!("gtin={GTIN}")).await,
        [row(4, 40), row(3, 30), row(2, 11), row(1, 10), row(2, 5)]
    );
    // A period is [from, to): the scan at 30 s is left out.
    assert_eq!(
        day.found(&format!("fromMs={}&toMs={}", millis(10), millis(30)))
            .await,
        [row(2, 11), row(1, 10)]
    );
    assert_eq!(
        day.found(&format!(
            "gtin={GTIN}&shift={}&fromMs={}",
            day.colleague.number,
            millis(0)
        ))
        .await,
        [row(2, 5)]
    );
    assert_eq!(
        day.found(&format!("codeHash={code2}&sscc={}", sscc(1500)))
            .await,
        [row(2, 11)]
    );
    // A number without the station's `/S` names the same shift; nothing
    // known is an empty page, not an error.
    for query in [
        format!("sscc={}", sscc(1999)),
        "shift=OCT26-999".to_owned(),
        format!("codeHash={}", code_hash(77)),
        "gtin=04600682000020".to_owned(),
    ] {
        let page = day.search(&query).await;
        assert_eq!(
            page,
            json!({ "items": [], "page": 1, "pageCount": 1, "total": 0, "capped": false }),
            "{query}"
        );
    }
}

/// A row names the placement whole: the code, where it stands now, its
/// box and pallet, the shift with its product and line, the station and
/// the operator by name — and nothing else (no canonical text, no PIN, no
/// badge).
#[tokio::test]
async fn a_row_names_the_placement_and_nothing_else() {
    let day = day().await;
    let page = day.search(&format!("sscc={}", sscc(1500))).await;
    let station = day.floor.station.clone();
    let common = json!({
        "gtin14": GTIN, "boxId": box_id(1), "boxSscc": sscc(1500),
        "boxClosedAt": instant(20, 0), "boxDisassembledAt": null,
        "palletId": pallet_id(1), "palletSscc": pallet_sscc(40), "palletDisassembledAt": null,
        "shiftId": day.floor.shift, "shiftNumber": day.floor.number, "shiftStatus": "active",
        "productionDate": "2026-10-08", "productName": "Молоко 3,2% 0,9 л",
        "lineName": "Линия 1", "deviceId": station,
    });
    let device_name = page["items"][0]["deviceName"].clone();
    assert!(device_name.as_str().is_some_and(|name| !name.is_empty()));
    let with = |extra: Value| {
        let mut row = common.clone();
        for (key, value) in extra.as_object().unwrap() {
            row[key] = value.clone();
        }
        row["deviceName"] = device_name.clone();
        row
    };
    let scan_ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM scans WHERE device_id = ? AND verdict = 'ok' AND box_id = ? \
         ORDER BY scanned_at DESC",
    )
    .bind(&station)
    .bind(box_id(1))
    .fetch_all(&day.admin.app.state.pool)
    .await
    .unwrap();
    let displaced_at: String =
        sqlx::query_scalar("SELECT displaced_at FROM box_items WHERE scan_id = ?")
            .bind(&scan_ids[0])
            .fetch_one(&day.admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(
        page,
        json!({
            "items": [
                with(json!({
                    "scanId": scan_ids[0], "codeHash": code_hash(2), "serial": "S000002",
                    "scannedAt": instant(11, 0), "state": "displaced", "leftAt": displaced_at,
                    "operatorName": "Анна Кузнецова",
                })),
                with(json!({
                    "scanId": scan_ids[1], "codeHash": code_hash(1), "serial": "S000001",
                    "scannedAt": instant(10, 0), "state": "packed", "leftAt": null,
                    "operatorName": null,
                })),
            ],
            "page": 1, "pageCount": 1, "total": 2, "capped": false,
        })
    );
    // An open box and an undone code, as the shift lists them.
    let shift = day.search(&format!("shift={}", day.floor.number)).await;
    let states: Vec<(&str, &Value)> = shift["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| (item["state"].as_str().unwrap(), &item["leftAt"]))
        .collect();
    assert_eq!(
        states,
        [
            ("open_box", &Value::Null),
            ("removed", &json!(instant(35, 0))),
            ("displaced", &json!(displaced_at)),
            ("packed", &Value::Null),
        ]
    );
    assert!(
        !page.to_string().contains("Tail"),
        "no canonical text in a row"
    );
    let _ = &day.operator;
}

/// A code's card: its identity and full text (the group separator kept),
/// the scan that owns it now, every placement and its history in order —
/// the scans whatever their verdict, a take by an earlier scan, an undo and
/// a warehouse reprint.
#[tokio::test]
async fn the_card_tells_the_history_of_a_code() {
    let day = day().await;
    let pool = &day.admin.app.state.pool;
    sqlx::query(
        "INSERT INTO warehouse_reprints (device_id, record_id, digest, session_id, job_id, \
         attempt, subject_kind, subject_id, identity, reason_code, template_id, template_rev, \
         outcome, operator_id, occurred_at, received_at) \
         VALUES (?, ?, ?, ?, ?, 0, 'unit', ?, ?, 'damaged', ?, 1, 'verified', ?, ?, ?)",
    )
    .bind(&day.floor.station)
    .bind(record_id(90))
    .bind("0".repeat(64))
    .bind(record_id(91))
    .bind(record_id(92))
    .bind(record_id(93))
    .bind(code_hash(2))
    .bind(record_id(94))
    .bind(&day.operator)
    .bind(instant(3600, 0))
    .bind("2026-10-08T07:00:00Z")
    .execute(pool)
    .await
    .unwrap();
    let (status, card) = day.get(&format!("/v1/office/codes/{}", code_hash(2))).await;
    assert_eq!(status, StatusCode::OK, "{card}");
    let owner: String = sqlx::query_scalar("SELECT scan_id FROM code_owners WHERE code_hash = ?")
        .bind(code_hash(2))
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(card["codeHash"], json!(code_hash(2)));
    assert_eq!(card["gtin14"], json!(GTIN));
    assert_eq!(card["serial"], json!("S000002"));
    assert_eq!(card["canonical"], code(2)["canonical"]);
    assert!(card["canonical"].as_str().unwrap().contains('\u{1d}'));
    assert_eq!(card["ownerScanId"], json!(owner));
    let placements: Vec<(&str, &str)> = card["placements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["state"].as_str().unwrap(), p["boxId"].as_str().unwrap()))
        .collect();
    let b1 = box_id(1);
    let b11 = box_id(11);
    assert_eq!(
        placements,
        [("displaced", b1.as_str()), ("open_box", b11.as_str())]
    );
    let events = card["events"].as_array().unwrap();
    let kinds: Vec<(&str, &Value)> = events
        .iter()
        .map(|e| (e["type"].as_str().unwrap(), &e["at"]))
        .collect();
    let displaced_at = card["placements"][0]["leftAt"].clone();
    assert_eq!(
        kinds,
        [
            ("scan", &json!(instant(5, 0))),
            ("scan", &json!(instant(11, 0))),
            ("scan", &json!(instant(36, 0))),
            ("reprint", &json!(instant(3600, 0))),
            ("displaced", &displaced_at),
        ]
    );
    assert_eq!(events[0]["shiftNumber"], json!(day.colleague.number));
    assert_eq!(events[0]["placed"], json!(true));
    assert_eq!(events[1]["operatorName"], json!("Анна Кузнецова"));
    assert_eq!(events[1]["boxId"], json!(b1));
    assert_eq!(
        (
            &events[2]["verdict"],
            &events[2]["duplicateSource"],
            &events[2]["placed"]
        ),
        (&json!("duplicate"), &json!("host"), &json!(false))
    );
    assert_eq!(
        events[3],
        json!({
            "type": "reprint", "at": instant(3600, 0), "outcome": "verified",
            "reasonCode": "damaged", "deviceName": events[1]["deviceName"],
            "operatorName": "Анна Кузнецова",
        })
    );
    assert_eq!(
        events[4],
        json!({ "type": "displaced", "at": displaced_at, "boxId": b1, "boxSscc": sscc(1500) })
    );

    // An undone code is free: no owner, its placement removed, the undo in
    // its history.
    let (status, undone) = day.get(&format!("/v1/office/codes/{}", code_hash(3))).await;
    assert_eq!(status, StatusCode::OK, "{undone}");
    assert_eq!(undone["ownerScanId"], Value::Null);
    assert_eq!(undone["placements"][0]["state"], json!("removed"));
    assert_eq!(
        undone["events"][1],
        json!({
            "type": "removed", "at": instant(35, 0), "boxId": box_id(2), "boxSscc": null,
            "exception": "undo", "reasonCode": null, "reasonText": null, "operatorName": null,
            "documentId": null, "documentNo": null, "officeUserName": null,
        })
    );
    // A code the host never saw is not found.
    let (status, body) = day
        .get(&format!("/v1/office/codes/{}", code_hash(77)))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "not_found");
}

/// Every criterion is checked before anything is read: a malformed one is
/// `validation_failed` naming its field, an unknown parameter is refused,
/// and a search needs at least one criterion.
#[tokio::test]
async fn a_malformed_criterion_is_refused_with_its_field() {
    let admin = admin().await;
    for (query, field) in [
        ("codeHash=ABC", Some("codeHash")),
        (
            &format!("codeHash={}", "A".repeat(64)) as &str,
            Some("codeHash"),
        ),
        ("gtin=4600682000013", Some("gtin")),
        ("gtin=0460068200001x", Some("gtin")),
        ("sscc=46006820000015000", Some("sscc")),
        ("sscc=00046006820000015000", Some("sscc")),
        ("shift=oct26-003", Some("shift")),
        ("shift=OCT26-", Some("shift")),
        ("shift=XYZ26-003", Some("shift")),
        ("shift=OCT26-003/X", Some("shift")),
        ("shift=OCT26-0000000001", Some("shift")),
        ("fromMs=abc", Some("fromMs")),
        ("fromMs=-1", Some("fromMs")),
        ("toMs=99999999999999999", Some("toMs")),
        ("fromMs=1791000000000&toMs=1791000000000", Some("toMs")),
        ("gtin=04600682000013&page=0", Some("page")),
        ("gtin=04600682000013&page=201", Some("page")),
        ("gtin=04600682000013&page=x", Some("page")),
        ("", Some("query")),
        ("page=2", Some("query")),
        ("gtin=04600682000013&raw=x", None),
    ] {
        let (status, body) = admin
            .call("GET", &format!("/v1/office/codes?{query}"), None)
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {body}");
        assert_eq!(body["error"]["code"], "validation_failed", "{query}");
        if let Some(field) = field {
            assert_eq!(body["error"]["details"]["field"], field, "{query}");
        }
    }
    let (status, body) = admin.call("GET", "/v1/office/codes/ABC", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["details"]["field"], "codeHash");
}

/// Only an office session reads codes: the station's key alone, the key of
/// another device with the administrator's session, a made-up session and
/// no credential at all are refused, and the refusal carries no data of a
/// code. A search writes nothing.
#[tokio::test]
async fn only_an_office_session_reads_codes_and_a_refusal_leaks_nothing() {
    let day = day().await;
    let app = &day.admin.app;
    let (_, other) = pair_device(app, "station").await;
    let facts_before = fact_rows(app).await;
    let audit_before = audit_rows(app).await;
    let code2 = code_hash(2);
    for path in [
        format!("/v1/office/codes?codeHash={code2}"),
        format!("/v1/office/codes?sscc={}", sscc(1500)),
        format!("/v1/office/codes/{code2}"),
    ] {
        for (who, builder) in [
            (
                "the station's key",
                with_device(request("GET", &path), &day.floor.key),
            ),
            (
                "a colleague's key",
                with_device(request("GET", &path), &day.colleague.key),
            ),
            (
                "another device with the admin's session",
                with_session(request("GET", &path), &other, &day.admin_token),
            ),
            (
                "a made-up session",
                with_session(request("GET", &path), &day.floor.key, "operator-pin-4821"),
            ),
            ("nothing", request("GET", &path)),
        ] {
            let (status, body) = app.send(empty(builder)).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{who} {path}: {body}");
            let text = body.to_string();
            for secret in [code2.as_str(), "S000002", "Tail", "Анна"] {
                assert!(
                    !text.contains(secret),
                    "{who} {path} leaked {secret}: {text}"
                );
            }
        }
    }
    // Both roles read; the reads leave the facts and the audit trail as
    // they were.
    let (status, _) = day
        .admin
        .call_as(
            &day.admin_token,
            "GET",
            &format!("/v1/office/codes?codeHash={code2}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = day.get(&format!("/v1/office/codes/{code2}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(fact_rows(app).await, facts_before);
    assert_eq!(audit_rows(app).await, audit_before);
}

/// A search counts at most 10 000 matches and pages them 50 a page.
#[tokio::test]
async fn a_search_pages_its_matches() {
    let day = day().await;
    // 120 more scans of new codes into box 2 of the station's shift.
    let records: Vec<Value> = (0..120)
        .map(|i| {
            fact(
                &record_id(100 + i),
                "scan",
                &day.floor.shift,
                ok_scan(1000 + i, &box_id(2), &instant(100 + i, 0)),
            )
        })
        .collect();
    for batch in records.chunks(60) {
        accept(&day.admin, &day.floor, batch).await;
    }
    let first = day.search(&format!("shift={}", day.floor.number)).await;
    assert_eq!(
        (
            &first["page"],
            &first["pageCount"],
            &first["total"],
            &first["capped"]
        ),
        (&json!(1), &json!(3), &json!(124), &json!(false))
    );
    assert_eq!(first["items"].as_array().unwrap().len(), 50);
    assert_eq!(first["items"][0]["scannedAt"], json!(instant(219, 0)));
    let last = day
        .search(&format!("shift={}&page=3", day.floor.number))
        .await;
    let items = last["items"].as_array().unwrap();
    assert_eq!(items.len(), 24);
    assert_eq!(items[23]["scannedAt"], json!(instant(10, 0)));
    // A page past the last is empty, with the same count.
    let past = day
        .search(&format!("shift={}&page=9", day.floor.number))
        .await;
    assert_eq!(
        (past["items"].as_array().unwrap().len(), &past["total"]),
        (0, &json!(124))
    );
}

/// Every query of the search and of the card searches by an index: none
/// reads through the facts' tables.
#[tokio::test]
async fn every_query_searches_by_an_index() {
    let admin = admin().await;
    for (name, sql) in markiro_host::routes::office_codes::QUERIES {
        let plan: Vec<(i64, i64, i64, String)> =
            sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
                .fetch_all(&admin.app.state.pool)
                .await
                .unwrap();
        let steps: Vec<&str> = plan.iter().map(|(_, _, _, step)| step.as_str()).collect();
        // Each search query is driven by the index of its criterion.
        let driving = match name {
            "code" | "card scans" | "card exceptions" => Some("scans_code_hash"),
            "box" | "pallet" | "warehouse pallet" => Some("scans_ok_box"),
            // `scans_shift_time` (migration 0033) is `scans_shift` with the instant after the shift:
            // the planner takes it when a period narrows the shift, and either drives the query.
            "shift" => Some("scans_shift"),
            "gtin" => Some("scans_ok_gtin"),
            "period" => Some("scans_ok_scanned"),
            _ => None,
        };
        if let Some(index) = driving {
            let accepted: Vec<String> = if index == "scans_shift" {
                vec!["scans_shift".to_owned(), "scans_shift_time".to_owned()]
            } else {
                vec![index.to_owned()]
            };
            assert!(
                steps.iter().any(|step| accepted
                    .iter()
                    .any(|index| step.contains(&format!("INDEX {index} ")))),
                "{name} is not driven by {index}: {steps:?}"
            );
        }
        // The count reads its own rows back (`SCAN (subquery-1)`); no
        // table is read through.
        assert!(
            steps
                .iter()
                .all(|step| !step.starts_with("SCAN") || step.starts_with("SCAN (subquery")),
            "{name}: {steps:?}"
        );
    }
}
