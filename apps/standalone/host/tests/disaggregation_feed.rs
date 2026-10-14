//! The station feed's `code_releases` (plan ДЗГ, task 6): one item per box an
//! applied document took apart, at the apply's one revision, nothing for
//! anything else.

mod support;

use axum::http::StatusCode;
use markiro_proto::disaggregation::CodeReleaseRecord;
use serde_json::{json, Value};
use support::app::{
    admin, box_id, empty, host_revision, pallet_sscc, request, sscc, with_device, Admin,
};
use support::disaggregation::{add, applied, create, day, line, pallet_day, REASON};

async fn feed(admin: &Admin, query: &str) -> Value {
    let (status, body) = admin
        .app
        .send(empty(with_device(
            request("GET", &format!("/v1/changes{query}")),
            &admin.key,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

/// The `code_releases` items of an answer: `(id, rev, record)`.
fn releases(body: &Value) -> Vec<(String, i64, CodeReleaseRecord)> {
    body["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["entity"] == "code_releases")
        .map(|item| {
            assert_eq!(item["deleted"], false);
            (
                item["id"].as_str().unwrap().to_owned(),
                item["rev"].as_i64().unwrap(),
                serde_json::from_value(item["data"].clone()).unwrap(),
            )
        })
        .collect()
}

#[tokio::test]
async fn an_apply_gives_the_feed_one_item_per_box_at_the_applys_revision() {
    let admin = admin().await;
    let floor = day(&admin, true).await;
    let before = host_revision(&admin.app).await;
    let done = applied(&admin, &[sscc(1500), sscc(1501)]).await;
    let rev = done["document"]["rev"].as_i64().unwrap();
    assert!(rev > before);
    let body = feed(&admin, &format!("?since={before}")).await;
    let found = releases(&body);
    assert_eq!(found.len(), 2, "{body}");
    let document = done["document"]["id"].as_str().unwrap();
    for (n, count) in [(1, 3), (2, 1)] {
        let (id, item_rev, record) = found
            .iter()
            .find(|(id, _, _)| *id == box_id(n))
            .unwrap_or_else(|| panic!("box {n} in {body}"));
        assert_eq!(*item_rev, rev, "{id}");
        assert_eq!(record.shift_id, floor.shift);
        assert_eq!(record.document_id, document);
        assert_eq!(record.code_count, count);
        assert_eq!(record.released_at.len(), 24, "a device-form instant");
    }
    // The wire is exactly the four fields.
    let item = body["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["entity"] == "code_releases")
        .unwrap();
    let mut keys: Vec<&String> = item["data"].as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["codeCount", "documentId", "releasedAt", "shiftId"]);
}

#[tokio::test]
async fn the_feed_from_zero_keeps_every_release_with_its_own_revision() {
    let admin = admin().await;
    day(&admin, true).await;
    let first = applied(&admin, &[sscc(1500)]).await;
    let second = applied(&admin, &[sscc(1501)]).await;
    let found = releases(&feed(&admin, "").await);
    assert_eq!(found.len(), 2);
    let rev_of = |n: u32| found.iter().find(|(id, _, _)| *id == box_id(n)).unwrap().1;
    assert_eq!(rev_of(1), first["document"]["rev"].as_i64().unwrap());
    assert_eq!(rev_of(2), second["document"]["rev"].as_i64().unwrap());
    assert_ne!(rev_of(1), rev_of(2));
}

#[tokio::test]
async fn a_draft_lines_and_a_pallet_give_no_release_but_do_move_the_revision() {
    let admin = admin().await;
    pallet_day(&admin, true).await;
    let before = host_revision(&admin.app).await;
    let doc = create(&admin, json!({ "reasonId": REASON })).await;
    let id = doc["document"]["id"].as_str().unwrap().to_owned();
    let (_, detail) = add(
        &admin,
        &id,
        json!([line(&pallet_sscc(40), Some(&pallet_sscc(40)))]),
    )
    .await;
    let body = feed(&admin, &format!("?since={before}")).await;
    assert_eq!(releases(&body), vec![]);
    assert!(body["rev"].as_i64().unwrap() > before);
    // The pallet's apply releases no code either.
    let (status, done) = support::disaggregation::apply(&admin, &detail).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    let body = feed(&admin, &format!("?since={before}")).await;
    assert_eq!(releases(&body), vec![]);
    assert_eq!(body["rev"], done["document"]["rev"]);
}

#[tokio::test]
async fn a_big_apply_comes_whole_in_one_page() {
    let admin = admin().await;
    let floor = day(&admin, true).await;
    // 600 more closed boxes of the shift, straight into the tables.
    let block: String = sqlx::query_scalar("SELECT id FROM sscc_blocks LIMIT 1")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let mut ssccs = Vec::new();
    for n in 0..600u64 {
        let serial = 10_000 + n;
        sqlx::query(
            "INSERT INTO boxes (id, shift_id, device_id, opened_at, closed_at, sscc, block_id, \
             serial, digest_matches, received_at) \
             VALUES (?, ?, ?, '2026-10-08T06:00:00.000Z', '2026-10-08T06:01:00.000Z', ?, ?, ?, 1, \
             '2026-10-08T06:01:00Z')",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&floor.shift)
        .bind(&floor.station)
        .bind(sscc(serial))
        .bind(&block)
        .bind(i64::try_from(serial).unwrap())
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
        ssccs.push(sscc(serial));
    }
    let before = host_revision(&admin.app).await;
    let doc = create(&admin, json!({ "reasonId": REASON })).await;
    let id = doc["document"]["id"].as_str().unwrap().to_owned();
    let mut last = Value::Null;
    for chunk in ssccs.chunks(500) {
        let lines: Vec<Value> = chunk.iter().map(|s| line(s, Some(s))).collect();
        let (status, detail) = add(&admin, &id, Value::Array(lines)).await;
        assert_eq!(status, StatusCode::OK, "{detail}");
        last = detail;
    }
    let (status, done) = support::disaggregation::apply(&admin, &last).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    let body = feed(&admin, &format!("?since={before}&limit=500")).await;
    let found = releases(&body);
    assert_eq!(found.len(), 600, "one revision comes whole");
    assert_eq!(body["hasMore"], false);
    assert!(found
        .iter()
        .all(|(_, rev, _)| *rev == done["document"]["rev"].as_i64().unwrap()));
    assert!(
        serde_json::to_vec(&body).unwrap().len() < 1024 * 1024,
        "within the page budget"
    );
}
