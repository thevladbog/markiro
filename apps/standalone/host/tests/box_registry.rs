//! The registry of closed boxes for a handheld (plan ТСД-Х, task Х4, spec 6.5): pages by
//! `(changed_at, sscc)`, a window `since..until`, no codes, and a change time that moves with every
//! write that changes a box or what it stands on.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, box_id, code_hash, empty, fact, instant, json as json_request, pair_handheld, record_id,
    request, shift_setup, with_device, Admin,
};
use support::handheld::{
    added, box_sscc, closed_boxes, event, opened, pallet_block, pallet_sscc, product_of,
    receipts_of, PALLET_A,
};
use time::Duration;

async fn registry(admin: &Admin, key: &str, query: &str) -> (StatusCode, Value) {
    admin
        .app
        .send(empty(with_device(
            request("GET", &format!("/v1/device/box-registry{query}")),
            key,
        )))
        .await
}

/// A whole walk: every page of one window; returns the window's `until` and the items.
async fn walk(admin: &Admin, key: &str, since: Option<&str>, limit: u32) -> (String, Vec<Value>) {
    let since = since
        .map(|since| format!("&since={since}"))
        .unwrap_or_default();
    let (status, first) = registry(admin, key, &format!("?limit={limit}{since}")).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let until = first["until"].as_str().unwrap().to_owned();
    let mut items = first["items"].as_array().unwrap().clone();
    let mut cursor = first["nextCursor"].as_str().map(str::to_owned);
    while let Some(next) = cursor {
        let (status, page) = registry(
            admin,
            key,
            &format!("?limit={limit}&until={until}&cursor={next}{since}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        assert_eq!(page["until"], json!(until));
        items.extend(page["items"].as_array().unwrap().clone());
        cursor = page["nextCursor"].as_str().map(str::to_owned);
    }
    (until, items)
}

#[tokio::test]
async fn a_walk_lists_closed_boxes_in_pages_without_a_code_of_theirs() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 3).await;
    let key = pair_handheld(&admin).await;
    // The window closes a margin below now, so the boxes closed just now are inside it after a while.
    admin.app.clock.advance(Duration::seconds(10));
    let (until, items) = walk(&admin, &key, None, 2).await;
    assert_eq!(items.len(), 3);
    let sscc: Vec<&str> = items
        .iter()
        .map(|item| item["sscc"].as_str().unwrap())
        .collect();
    let mut sorted = sscc.clone();
    sorted.sort_unstable();
    assert_eq!(
        sscc, sorted,
        "one change time here: the order falls back to the SSCC"
    );
    let first = &items[0];
    assert_eq!(first["kind"], json!("upsert"));
    assert_eq!(first["productId"], json!(setup.product));
    assert_eq!(first["bottleCount"], json!(1));
    assert_eq!(first["palletActive"], json!(false));
    assert_eq!(first["productionDate"], json!("2026-10-08"));
    assert!(first.get("palletSscc").is_none() && first.get("contentKeys").is_none());
    assert_eq!(first["closedAt"], json!(instant(1, 500)));
    // No code, no hash and no canonical text of a code leaves the host.
    let text = Value::Array(items.clone()).to_string();
    assert!(!text.contains(&code_hash(1)) && !text.contains("canonical"));
    // The first page names its window; asking for one on the first page is the device's mistake.
    let (status, refused) = registry(&admin, &key, &format!("?until={until}")).await;
    assert_eq!(
        (status, refused["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("until"))
    );
    let (status, refused) = registry(
        &admin,
        &key,
        "?cursor=2026-10-08T06:00:00Z%7C046006820000015000",
    )
    .await;
    assert_eq!(
        (status, refused["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("until"))
    );
}

#[tokio::test]
async fn a_change_moves_a_box_into_the_next_window_with_its_pallet() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 2).await;
    let key = pair_handheld(&admin).await;
    // The window is closed at both ends: a change in the very second of `until` is delivered again
    // by the next walk (harmless), so the test lets time pass first (the window closes a margin below now).
    admin.app.clock.advance(Duration::seconds(10));
    let (until, _) = walk(&admin, &key, None, 100).await;
    admin.app.clock.advance(Duration::seconds(30));
    let block = pallet_block(&admin, &key, "8f7e6d5c-4b3a-4f2e-8d1c-9b8a7f6e5d4c").await;
    receipts_of(
        &admin,
        &key,
        &[
            opened(1, PALLET_A, product_of(&setup), &instant(100, 0)),
            added(2, PALLET_A, &box_sscc(1500), &instant(101, 0)),
        ],
    )
    .await;
    // Time passes (the window closes a margin below now), so the next window reaches the add.
    admin.app.clock.advance(Duration::seconds(10));
    // Only the box that was put on the pallet is in the next window, standing on an open pallet.
    let (next, items) = walk(&admin, &key, Some(&until), 100).await;
    let on_pallet: Vec<&Value> = items
        .iter()
        .filter(|item| item["sscc"] == json!(box_sscc(1500)))
        .collect();
    assert_eq!(on_pallet.len(), 1);
    assert_eq!(on_pallet[0]["palletId"], json!(PALLET_A));
    assert_eq!(on_pallet[0]["palletActive"], json!(true));
    assert!(on_pallet[0].get("palletSscc").is_none());
    assert!(items
        .iter()
        .all(|item| item["sscc"] != json!(box_sscc(1501))));
    // The pallet closes: its boxes carry the SSCC now.
    admin.app.clock.advance(Duration::seconds(30));
    receipts_of(
        &admin,
        &key,
        &[event(
            3,
            "warehouse_pallet_closed",
            json!({
                "palletId": PALLET_A, "sscc": pallet_sscc(40), "blockId": block["id"], "serial": 40,
                "openedAt": instant(100, 0), "closedAt": instant(110, 0), "boxCount": 1
            }),
        )],
    )
    .await;
    admin.app.clock.advance(Duration::seconds(10));
    let (_, items) = walk(&admin, &key, Some(&next), 100).await;
    assert_eq!(items[0]["palletSscc"], json!(pallet_sscc(40)));
}

#[tokio::test]
async fn a_taken_apart_box_is_a_removal_and_the_restore_epoch_rides_every_page() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = closed_boxes(&admin, &setup, 2).await;
    let key = pair_handheld(&admin).await;
    admin.app.clock.advance(Duration::seconds(10));
    let (until, _) = walk(&admin, &key, None, 100).await;
    admin.app.clock.advance(Duration::seconds(30));
    let exception = fact(
        &record_id(900),
        "box_exception",
        &floor.shift,
        json!({
            "exception": "disassemble", "boxId": box_id(1), "codeHash": null,
            "targetScannedAt": null, "reasonCode": "other", "reasonText": "Короб рассыпался",
            "occurredAt": instant(300, 0)
        }),
    );
    let (status, sent) = admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/facts"), &floor.key),
            json!({ "records": [exception] }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    assert_eq!(sent["receipts"][0]["outcome"], json!("accepted"), "{sent}");
    admin.app.clock.advance(Duration::seconds(10));
    let (_, items) = walk(&admin, &key, Some(&until), 100).await;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["kind"], json!("remove"));
    assert_eq!(items[0]["sscc"], json!(box_sscc(1500)));
    assert!(items[0].get("boxId").is_none());
    // A whole walk does not list it.
    let (_, whole) = walk(&admin, &key, None, 100).await;
    assert_eq!(whole.len(), 1);
    // After a restore from a copy the epoch is on the page.
    let epoch = "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e";
    sqlx::query("UPDATE site SET restore_epoch = ?")
        .bind(epoch)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (_, page) = registry(&admin, &key, "").await;
    assert_eq!(page["restoreEpoch"], json!(epoch));
}

#[tokio::test]
async fn only_a_handheld_reads_the_registry_and_a_bad_query_is_a_validation_error() {
    let admin = admin().await;
    let (status, refused) = registry(&admin, &admin.key, "").await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
    let key = pair_handheld(&admin).await;
    for query in [
        "?limit=0",
        "?limit=501",
        "?since=yesterday",
        "?cursor=nothing&until=2026-10-08T06:00:00Z",
    ] {
        let (status, body) = registry(&admin, &key, query).await;
        assert_eq!(
            (status, body["error"]["code"].clone()),
            (StatusCode::BAD_REQUEST, json!("validation_failed")),
            "{query}"
        );
    }
}

#[tokio::test]
async fn a_walk_keeps_its_window_while_boxes_change_and_lists_by_change_time() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 3).await;
    let key = pair_handheld(&admin).await;
    admin.app.clock.advance(Duration::seconds(10));
    // Page one of a walk of three boxes; its window closes at `until`.
    let (status, first) = registry(&admin, &key, "?limit=1").await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let until = first["until"].as_str().unwrap().to_owned();
    let cursor = first["nextCursor"].as_str().unwrap().to_owned();
    assert_eq!(first["items"][0]["sscc"], json!(box_sscc(1500)));
    // Two boxes change while the walk is on: neither is in the rest of THIS walk.
    admin.app.clock.advance(Duration::seconds(30));
    pallet_block(&admin, &key, "8f7e6d5c-4b3a-4f2e-8d1c-9b8a7f6e5d4c").await;
    receipts_of(
        &admin,
        &key,
        &[
            opened(1, PALLET_A, product_of(&setup), &instant(100, 0)),
            added(2, PALLET_A, &box_sscc(1502), &instant(101, 0)),
        ],
    )
    .await;
    admin.app.clock.advance(Duration::seconds(30));
    receipts_of(
        &admin,
        &key,
        &[added(3, PALLET_A, &box_sscc(1500), &instant(102, 0))],
    )
    .await;
    let (status, rest) = registry(
        &admin,
        &key,
        &format!("?limit=10&until={until}&cursor={cursor}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{rest}");
    let sscc: Vec<&str> = rest["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["sscc"].as_str().unwrap())
        .collect();
    assert_eq!(sscc, vec![box_sscc(1501)], "{rest}");
    assert_eq!(rest["until"], json!(until));
    assert!(rest.get("nextCursor").is_none());
    admin.app.clock.advance(Duration::seconds(10));
    // The next walk lists the changes by when they happened, not by SSCC: 1502 first, then 1500.
    let (_, next) = walk(&admin, &key, Some(&until), 100).await;
    let order: Vec<&str> = next
        .iter()
        .map(|item| item["sscc"].as_str().unwrap())
        .collect();
    assert_eq!(order, vec![box_sscc(1502), box_sscc(1500)]);
    // A cursor without its window is the device's mistake, as a window without a cursor.
    let (status, refused) = registry(&admin, &key, &format!("?cursor={cursor}")).await;
    assert_eq!(
        (status, refused["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("until"))
    );
}

#[tokio::test]
async fn a_change_stamped_just_before_the_window_closed_is_delivered_by_the_next_walk() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 2).await;
    let key = pair_handheld(&admin).await;
    admin.app.clock.advance(Duration::seconds(60));
    // A writer stamped its change two seconds before this walk and commits after the walk read
    // its snapshot: the window must close below the stamp, or the change is never delivered.
    let stamped = markiro_host::clock::format_timestamp(
        markiro_host::clock::parse_timestamp(&admin.app.state.timestamp()).unwrap()
            - Duration::seconds(2),
    );
    let (until, first) = walk(&admin, &key, None, 100).await;
    assert_eq!(first.len(), 2);
    sqlx::query("UPDATE boxes SET changed_at = ? WHERE sscc = ?")
        .bind(&stamped)
        .bind(box_sscc(1501))
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    admin.app.clock.advance(Duration::seconds(60));
    let (_, next) = walk(&admin, &key, Some(&until), 100).await;
    let sscc: Vec<&str> = next
        .iter()
        .map(|item| item["sscc"].as_str().unwrap())
        .collect();
    assert_eq!(sscc, vec![box_sscc(1501)], "{next:?}");
}
