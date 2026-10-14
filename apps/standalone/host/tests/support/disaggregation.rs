//! What the disaggregation suites share (plan ДЗГ): a station's day with
//! closed and open boxes, and the office calls of a document.

use axum::http::StatusCode;
use serde_json::{json, Value};

use super::app::{
    box_closed, box_id, close_from_office, fact, instant, issue_block, ok_scan, open_floor,
    pair_device, receipts, record_id, shift_setup, Admin, Floor,
};

pub const BLOCK_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";

/// «Повреждена упаковка», one of the migration's default reasons.
pub const REASON: &str = "d15a0000-0000-4000-8000-000000000003";
/// «Другое».
pub const OTHER_REASON: &str = "d15a0000-0000-4000-8000-000000000005";

/// A station's shift with box 1 (codes 1-3, SSCC serial 1500) and box 2
/// (code 4, serial 1501) closed, box 3 open with code 5; `close` closes the
/// shift from the office. The station is a new one, not the administrator's.
pub async fn day(admin: &Admin, close: bool) -> Floor {
    let setup = shift_setup(admin).await;
    let (_, key) = pair_device(&admin.app, "station").await;
    let floor = open_floor(admin, &setup, &key, &setup.line).await;
    let block = issue_block(&admin.app, &key, BLOCK_REQUEST).await;
    let mut records = Vec::new();
    for (n, code, b) in [(1, 1, 1), (2, 2, 1), (3, 3, 1), (4, 4, 2), (5, 5, 3)] {
        records.push(fact(
            &record_id(n),
            "scan",
            &floor.shift,
            ok_scan(code, &box_id(b), &instant(n, 0)),
        ));
    }
    records.push(fact(
        &record_id(6),
        "box_closed",
        &floor.shift,
        box_closed(
            &box_id(1),
            &block,
            1500,
            &[1, 2, 3],
            &instant(1, 0),
            &instant(10, 0),
        ),
    ));
    records.push(fact(
        &record_id(7),
        "box_closed",
        &floor.shift,
        box_closed(
            &box_id(2),
            &block,
            1501,
            &[4],
            &instant(4, 0),
            &instant(11, 0),
        ),
    ));
    let answered = receipts(&admin.app, &key, &records).await;
    assert!(
        answered.iter().all(|r| r["outcome"] == "accepted"),
        "{answered:?}"
    );
    if close {
        close_from_office(admin, &floor.shift, "Конец смены").await;
    }
    floor
}

/// A new document of `body` as the administrator; the card.
pub async fn create(admin: &Admin, body: Value) -> Value {
    let (status, detail) = admin
        .call("POST", "/v1/office/disaggregation", Some(body))
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    detail
}

/// `POST …/{id}/lines` of `lines`, typed.
pub async fn add(admin: &Admin, id: &str, lines: Value) -> (StatusCode, Value) {
    admin
        .call(
            "POST",
            &format!("/v1/office/disaggregation/{id}/lines"),
            Some(json!({ "lines": lines, "import": false })),
        )
        .await
}

/// A line as the webview sends it: the typed text and the SSCC read from it.
pub fn line(input: &str, sscc: Option<&str>) -> Value {
    json!({ "input": input, "sscc": sscc })
}

/// `POST …/{id}/apply` over the card's revision.
pub async fn apply(admin: &Admin, detail: &Value) -> (StatusCode, Value) {
    let id = detail["document"]["id"].as_str().unwrap();
    admin
        .call(
            "POST",
            &format!("/v1/office/disaggregation/{id}/apply"),
            Some(json!({ "expectedRev": detail["document"]["rev"] })),
        )
        .await
}

/// A document of `ssccs` (serials of box SSCCs) applied at once; the card.
pub async fn applied(admin: &Admin, ssccs: &[String]) -> Value {
    let doc = create(admin, json!({ "reasonId": REASON })).await;
    let id = doc["document"]["id"].as_str().unwrap().to_owned();
    let lines: Vec<Value> = ssccs.iter().map(|s| line(s, Some(s))).collect();
    let (status, detail) = add(admin, &id, Value::Array(lines)).await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    let (status, done) = apply(admin, &detail).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    done
}
