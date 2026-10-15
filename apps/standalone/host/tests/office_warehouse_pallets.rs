//! The office's list of warehouse pallets (plan ТСД-Х, task Х5, decision В-6): a list, newest first,
//! open ones before closed; no card, no export.

mod support;

use axum::http::StatusCode;
use serde_json::json;
use support::app::{admin, empty, instant, pair_handheld, request, shift_setup, with_device};
use support::handheld::{
    added, box_sscc, closed_boxes, event, opened, pallet_block, pallet_sscc, product_of,
    receipts_of, PALLET_A, PALLET_B,
};

#[tokio::test]
async fn the_list_shows_open_pallets_first_and_counts_the_boxes_on_them() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 2).await;
    let key = pair_handheld(&admin).await;
    let block = pallet_block(&admin, &key, "8f7e6d5c-4b3a-4f2e-8d1c-9b8a7f6e5d4c").await;
    receipts_of(
        &admin,
        &key,
        &[
            opened(1, PALLET_A, product_of(&setup), &instant(100, 0)),
            added(2, PALLET_A, &box_sscc(1500), &instant(101, 0)),
            event(
                3,
                "warehouse_pallet_closed",
                json!({
                    "palletId": PALLET_A, "sscc": pallet_sscc(40), "blockId": block["id"], "serial": 40,
                    "openedAt": instant(100, 0), "closedAt": instant(110, 0), "boxCount": 1
                }),
            ),
            opened(4, PALLET_B, product_of(&setup), &instant(120, 0)),
            added(5, PALLET_B, &box_sscc(1501), &instant(121, 0)),
        ],
    )
    .await;
    let (status, list) = admin
        .call("GET", "/v1/office/warehouse-pallets", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let pallets = list["pallets"].as_array().unwrap();
    assert_eq!(pallets.len(), 2);
    assert_eq!(pallets[0]["id"], json!(PALLET_B));
    assert_eq!(
        (
            pallets[0]["sscc"].clone(),
            pallets[0]["closedAt"].clone(),
            pallets[0]["boxes"].clone()
        ),
        (json!(null), json!(null), json!(1))
    );
    assert_eq!(pallets[1]["sscc"], json!(pallet_sscc(40)));
    assert_eq!(pallets[1]["boxCountReported"], json!(1));
    assert_eq!(pallets[1]["productName"], json!("Молоко 3,2% 0,9 л"));
    assert_eq!(pallets[1]["deviceName"], json!("ТСД 1"));
    // A handheld's key opens no office route.
    let (status, refused) = admin
        .app
        .send(empty(with_device(
            request("GET", "/v1/office/warehouse-pallets"),
            &key,
        )))
        .await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
}

#[tokio::test]
async fn a_box_taken_apart_is_not_counted_on_the_pallet() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 2).await;
    let key = pair_handheld(&admin).await;
    receipts_of(
        &admin,
        &key,
        &[
            opened(1, PALLET_A, product_of(&setup), &instant(100, 0)),
            added(2, PALLET_A, &box_sscc(1500), &instant(101, 0)),
            added(3, PALLET_A, &box_sscc(1501), &instant(102, 0)),
        ],
    )
    .await;
    sqlx::query("UPDATE boxes SET disassembled_at = ? WHERE sscc = ?")
        .bind(instant(105, 0))
        .bind(box_sscc(1500))
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, list) = admin
        .call("GET", "/v1/office/warehouse-pallets", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["pallets"][0]["boxes"], json!(1), "{list}");
}
