//! The warehouse pallet channel (plan ТСД-Х, task Х3, spec 6.4): a handheld opens a pallet outside
//! any shift, scans closed boxes onto it, takes one off and closes it with an SSCC of its pallet
//! block; every record gets a receipt, a record sent again gets the same one, and a record whose
//! content changed is a `payload_mismatch` that stores nothing.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{admin, host_revision, instant, pair_handheld, shift_setup};
use support::handheld::{
    accepted, added, box_sscc, closed_boxes, event, events, opened, pallet_block, pallet_sscc,
    product_of, receipts_of, rejected, PALLET_A, PALLET_B,
};
use support::license::{file, load_ok};

#[tokio::test]
async fn a_warehouse_pallet_is_opened_filled_and_closed() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 2).await;
    let key = pair_handheld(&admin).await;
    let block = pallet_block(&admin, &key, "8f7e6d5c-4b3a-4f2e-8d1c-9b8a7f6e5d4c").await;
    let batch = [
        opened(1, PALLET_A, product_of(&setup), &instant(100, 0)),
        added(2, PALLET_A, &box_sscc(1500), &instant(101, 0)),
        added(3, PALLET_A, &box_sscc(1501), &instant(102, 0)),
        event(
            4,
            "warehouse_pallet_closed",
            json!({
                "palletId": PALLET_A, "sscc": pallet_sscc(40), "blockId": block["id"], "serial": 40,
                "openedAt": instant(100, 0), "closedAt": instant(110, 0), "boxCount": 2
            }),
        ),
    ];
    let rev = host_revision(&admin.app).await;
    assert_eq!(
        receipts_of(&admin, &key, &batch).await,
        vec![accepted(1), accepted(2), accepted(3), accepted(4)]
    );
    let (sscc, count, closed_at): (String, i64, String) = sqlx::query_as(
        "SELECT sscc, box_count_reported, closed_at FROM warehouse_pallets WHERE id = ?",
    )
    .bind(PALLET_A)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        (sscc, count, closed_at),
        (pallet_sscc(40), 2, instant(110, 0))
    );
    let consumed: Option<i64> =
        sqlx::query_scalar("SELECT consumed_through FROM sscc_blocks WHERE id = ?")
            .bind(block["id"].as_str().unwrap())
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(consumed, Some(40));
    // The close is an event for the office: one revision for the batch.
    assert_eq!(host_revision(&admin.app).await, rev + 1);
    // Sent again, the batch gets the same receipts and writes nothing.
    assert_eq!(
        receipts_of(&admin, &key, &batch).await,
        vec![accepted(1), accepted(2), accepted(3), accepted(4)]
    );
    assert_eq!(host_revision(&admin.app).await, rev + 1);
}

#[tokio::test]
async fn a_record_sent_again_with_other_content_is_a_payload_mismatch_and_stores_nothing() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 2).await;
    let key = pair_handheld(&admin).await;
    let first = [
        opened(1, PALLET_A, product_of(&setup), &instant(100, 0)),
        added(2, PALLET_A, &box_sscc(1500), &instant(101, 0)),
    ];
    assert_eq!(
        receipts_of(&admin, &key, &first).await,
        vec![accepted(1), accepted(2)]
    );
    let changed = added(2, PALLET_A, &box_sscc(1501), &instant(101, 0));
    assert_eq!(
        receipts_of(&admin, &key, &[changed]).await,
        vec![rejected(2, "payload_mismatch", None)]
    );
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM warehouse_pallet_boxes")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let kept: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM device_event_receipts")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!((rows, kept), (1, 2), "the mismatch is kept nowhere");
}

#[tokio::test]
async fn a_box_on_another_pallet_is_rejected_with_that_pallet_and_a_removal_frees_it() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 2).await;
    let first = pair_handheld(&admin).await;
    let second = pair_handheld(&admin).await;
    let block = pallet_block(&admin, &first, "8f7e6d5c-4b3a-4f2e-8d1c-9b8a7f6e5d4c").await;
    assert_eq!(
        receipts_of(
            &admin,
            &first,
            &[
                opened(1, PALLET_A, product_of(&setup), &instant(100, 0)),
                added(2, PALLET_A, &box_sscc(1500), &instant(101, 0))
            ]
        )
        .await,
        vec![accepted(1), accepted(2)]
    );
    // The other handheld wants the same box while the first pallet is open: no SSCC yet.
    assert_eq!(
        receipts_of(
            &admin,
            &second,
            &[
                opened(10, PALLET_B, product_of(&setup), &instant(120, 0)),
                added(11, PALLET_B, &box_sscc(1500), &instant(121, 0))
            ]
        )
        .await,
        vec![
            accepted(10),
            rejected(
                11,
                "box_on_pallet",
                Some(json!({ "palletSscc": null, "palletId": PALLET_A }))
            )
        ]
    );
    // The first closes; the same box now names the closed pallet's SSCC.
    let close = event(
        3,
        "warehouse_pallet_closed",
        json!({
            "palletId": PALLET_A, "sscc": pallet_sscc(40), "blockId": block["id"], "serial": 40,
            "openedAt": instant(100, 0), "closedAt": instant(110, 0), "boxCount": 1
        }),
    );
    assert_eq!(
        receipts_of(&admin, &first, &[close]).await,
        vec![accepted(3)]
    );
    assert_eq!(
        receipts_of(
            &admin,
            &second,
            &[added(12, PALLET_B, &box_sscc(1500), &instant(122, 0))]
        )
        .await,
        vec![rejected(
            12,
            "box_on_pallet",
            Some(json!({ "palletSscc": pallet_sscc(40), "palletId": PALLET_A }))
        )]
    );
    // The second pallet's own box can leave and come back.
    assert_eq!(
        receipts_of(&admin, &second, &[
            added(13, PALLET_B, &box_sscc(1501), &instant(123, 0)),
            event(14, "pallet_box_removed", json!({ "palletId": PALLET_B, "boxSscc": box_sscc(1501), "removedAt": instant(124, 0) })),
            added(15, PALLET_B, &box_sscc(1501), &instant(125, 0)),
        ]).await,
        vec![accepted(13), accepted(14), accepted(15)]
    );
}

#[tokio::test]
async fn each_refusal_names_its_reason() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 2).await;
    let key = pair_handheld(&admin).await;
    let other = pair_handheld(&admin).await;
    let block = pallet_block(&admin, &key, "8f7e6d5c-4b3a-4f2e-8d1c-9b8a7f6e5d4c").await;
    // A second product the first pallet is of: the boxes belong to the setup's product.
    let (status, other_product) = admin
        .call("POST", "/v1/office/products", Some(json!({
            "gtin14": "04600682000020", "name": "Кефир", "printName": null, "chzProductGroupCode": 8,
            "boxCapacity": 12, "palletBoxCapacity": 40, "shelfLifeDays": 10,
            "defaultBoxTemplateId": null, "defaultPalletTemplateId": null,
            "defaultPalletSheetId": null, "egaisCode": null, "defaultCounterpartyId": null
        })))
        .await;
    assert_eq!(status, StatusCode::OK, "{other_product}");
    let batch = [
        opened(
            1,
            PALLET_A,
            other_product["id"].as_str().unwrap(),
            &instant(100, 0),
        ),
        added(2, PALLET_A, &box_sscc(1500), &instant(101, 0)), // product_mismatch
        added(3, PALLET_A, "046006820099999990", &instant(102, 0)), // box_not_found
        added(
            4,
            "a1000000-0000-4000-8000-0000000000ff",
            &box_sscc(1500),
            &instant(103, 0),
        ), // pallet_unknown
        event(
            5,
            "warehouse_pallet_closed",
            json!({
                "palletId": PALLET_A, "sscc": pallet_sscc(40), "blockId": block["id"], "serial": 40,
                "openedAt": instant(100, 0), "closedAt": instant(110, 0), "boxCount": 3
            }),
        ), // pallet_count_mismatch
    ];
    let got = receipts_of(&admin, &key, &batch).await;
    assert_eq!(got[0], accepted(1));
    assert_eq!(got[1], rejected(2, "product_mismatch", None));
    assert_eq!(got[2], rejected(3, "box_not_found", None));
    assert_eq!(got[3], rejected(4, "pallet_unknown", None));
    assert_eq!(
        got[4],
        rejected(5, "pallet_count_mismatch", Some(json!({ "counted": 0 })))
    );
    // A block of another device is not this device's: `sscc_not_issued`; the consumed mark stays.
    let foreign = events(&admin, &other, &[
        opened(20, PALLET_B, product_of(&setup), &instant(130, 0)),
        added(21, PALLET_B, &box_sscc(1500), &instant(131, 0)),
        event(22, "warehouse_pallet_closed", json!({
            "palletId": PALLET_B, "sscc": pallet_sscc(40), "blockId": block["id"], "serial": 40,
            "openedAt": instant(130, 0), "closedAt": instant(140, 0), "boxCount": 1
        })),
    ]).await;
    assert_eq!(foreign.0, StatusCode::OK);
    assert_eq!(
        foreign.1["receipts"][2],
        rejected(22, "sscc_not_issued", None)
    );
    // A pallet whose time is no device instant is `invalid_record` on that field, the rest go on.
    let bad = receipts_of(
        &admin,
        &key,
        &[
            event(
                30,
                "pallet_box_added",
                json!({ "palletId": PALLET_A, "boxSscc": box_sscc(1500), "addedAt": "yesterday" }),
            ),
            json!("not an object"),
            accepted_probe(),
        ],
    )
    .await;
    assert_eq!(
        bad[0],
        rejected(
            30,
            "invalid_record",
            Some(json!({ "field": "data.addedAt" }))
        )
    );
    assert_eq!(
        bad[1],
        json!({ "id": null, "outcome": "rejected", "code": "invalid_record" })
    );
    // The label of a pallet that was never closed.
    assert_eq!(bad[2], rejected(31, "pallet_state", None));
}

/// A well-formed label event of a pallet that exists: the record after the unreadable one.
fn accepted_probe() -> Value {
    event(
        31,
        "warehouse_pallet_label",
        json!({ "palletId": PALLET_A, "outcome": "verified", "at": instant(150, 0) }),
    )
}

#[tokio::test]
async fn a_license_without_pallets_refuses_a_new_pallet_and_never_an_open_one() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 2).await;
    let key = pair_handheld(&admin).await;
    assert_eq!(
        receipts_of(
            &admin,
            &key,
            &[opened(1, PALLET_A, product_of(&setup), &instant(100, 0))]
        )
        .await,
        vec![accepted(1)]
    );
    load_ok(
        &admin,
        &file(&admin.app.state.host_id, |terms| {
            terms["features"]["pallets"] = json!(false)
        }),
    )
    .await;
    // The open pallet keeps taking boxes; a new pallet is refused with no row.
    assert_eq!(
        receipts_of(
            &admin,
            &key,
            &[
                added(2, PALLET_A, &box_sscc(1500), &instant(101, 0)),
                opened(3, PALLET_B, product_of(&setup), &instant(102, 0)),
            ]
        )
        .await,
        vec![accepted(2), rejected(3, "feature_disabled", None)]
    );
    let pallets: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM warehouse_pallets")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(pallets, 1);
}

#[tokio::test]
async fn only_a_handheld_sends_pallet_events_and_a_database_error_is_no_receipt() {
    let admin = admin().await;
    let (status, refused) = events(
        &admin,
        &admin.key,
        &[opened(1, PALLET_A, "x", &instant(1, 0))],
    )
    .await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
    let key = pair_handheld(&admin).await;
    // 1-100 records.
    let (status, body) = events(&admin, &key, &[]).await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed"))
    );
    // A database error fails the batch (500) and keeps no receipt: the handheld sends it again.
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 1).await;
    sqlx::query("DROP TABLE warehouse_pallet_boxes")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, _) = events(
        &admin,
        &key,
        &[
            opened(1, PALLET_A, product_of(&setup), &instant(1, 0)),
            added(2, PALLET_A, &box_sscc(1500), &instant(2, 0)),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    let kept: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM device_event_receipts")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(kept, 0);
}

#[tokio::test]
async fn one_device_never_touches_another_devices_pallet_or_receipts() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 2).await;
    let first = pair_handheld(&admin).await;
    let second = pair_handheld(&admin).await;
    assert_eq!(
        receipts_of(
            &admin,
            &first,
            &[opened(1, PALLET_A, product_of(&setup), &instant(100, 0))]
        )
        .await,
        vec![accepted(1)]
    );
    // The second device cannot fill, empty, close or label the first one's pallet, nor open a
    // pallet of the same id: another device's pallet is as unknown as none.
    let got = receipts_of(
        &admin,
        &second,
        &[
            added(2, PALLET_A, &box_sscc(1500), &instant(101, 0)),
            event(
                3,
                "pallet_box_removed",
                json!({ "palletId": PALLET_A, "boxSscc": box_sscc(1500), "removedAt": instant(102, 0) }),
            ),
            event(
                4,
                "warehouse_pallet_label",
                json!({ "palletId": PALLET_A, "outcome": "verified", "at": instant(103, 0) }),
            ),
            opened(5, PALLET_A, product_of(&setup), &instant(104, 0)),
        ],
    )
    .await;
    assert_eq!(got[0], rejected(2, "pallet_unknown", None));
    assert_eq!(got[1], rejected(3, "pallet_unknown", None));
    assert_eq!(got[2], rejected(4, "pallet_unknown", None));
    assert_eq!(
        got[3],
        rejected(
            5,
            "invalid_record",
            Some(json!({ "field": "data.palletId" }))
        )
    );
    let boxes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM warehouse_pallet_boxes")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(boxes, 0);
    // A record id is the device's own: the second device sending the id the first one used gets
    // its record applied, not the first one's receipt, and both receipts are kept.
    assert_eq!(
        receipts_of(
            &admin,
            &second,
            &[opened(1, PALLET_B, product_of(&setup), &instant(110, 0))]
        )
        .await,
        vec![accepted(1)]
    );
    let kept: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM device_event_receipts WHERE record_id = ?")
            .bind(support::app::record_id(1))
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(kept, 2);
    let owner: String = sqlx::query_scalar("SELECT device_id FROM warehouse_pallets WHERE id = ?")
        .bind(PALLET_B)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let first_device: String =
        sqlx::query_scalar("SELECT device_id FROM warehouse_pallets WHERE id = ?")
            .bind(PALLET_A)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_ne!(owner, first_device);
}

#[tokio::test]
async fn a_box_block_does_not_close_a_pallet() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 1).await;
    let key = pair_handheld(&admin).await;
    // Extension 0 (a box block): the SSCC of a pallet has extension 1.
    let box_block =
        support::app::issue_block(&admin.app, &key, "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d").await;
    // A serial inside that block, so only the block's extension can refuse it.
    let serial = u32::try_from(box_block["fromSerial"].as_u64().unwrap()).unwrap();
    assert_eq!(
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
                        "palletId": PALLET_A, "sscc": pallet_sscc(serial), "blockId": box_block["id"],
                        "serial": serial, "openedAt": instant(100, 0), "closedAt": instant(110, 0),
                        "boxCount": 1
                    })
                ),
            ]
        )
        .await,
        vec![
            accepted(1),
            accepted(2),
            rejected(3, "sscc_not_issued", None)
        ]
    );
}

#[tokio::test]
async fn a_record_whose_id_is_not_a_uuid_is_rejected_before_it_is_applied() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 1).await;
    let key = pair_handheld(&admin).await;
    assert_eq!(
        receipts_of(
            &admin,
            &key,
            &[opened(1, PALLET_A, product_of(&setup), &instant(100, 0))]
        )
        .await,
        vec![accepted(1)]
    );
    let mut spoiled = added(2, PALLET_A, &box_sscc(1500), &instant(101, 0));
    spoiled["id"] = json!("not-a-uuid");
    let receipts = receipts_of(&admin, &key, &[spoiled]).await;
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0]["outcome"], json!("rejected"), "{receipts:?}");
    assert_eq!(receipts[0]["code"], json!("invalid_record"), "{receipts:?}");
    assert!(receipts[0].get("id").map_or(true, Value::is_null));
    // Nothing was applied and no receipt was stored for it.
    let boxes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM warehouse_pallet_boxes")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(boxes, 0);
    let stored: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM device_event_receipts")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(stored, 1);
}

#[tokio::test]
async fn a_box_taken_apart_after_it_was_scanned_is_not_counted_at_the_close() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    closed_boxes(&admin, &setup, 2).await;
    let key = pair_handheld(&admin).await;
    let block = pallet_block(&admin, &key, "8f7e6d5c-4b3a-4f2e-8d1c-9b8a7f6e5d4c").await;
    assert_eq!(
        receipts_of(
            &admin,
            &key,
            &[
                opened(1, PALLET_A, product_of(&setup), &instant(100, 0)),
                added(2, PALLET_A, &box_sscc(1500), &instant(101, 0)),
                added(3, PALLET_A, &box_sscc(1501), &instant(102, 0)),
            ]
        )
        .await,
        vec![accepted(1), accepted(2), accepted(3)]
    );
    // The production side takes the box apart; its row on the pallet stays live in the table.
    sqlx::query("UPDATE boxes SET disassembled_at = ? WHERE sscc = ?")
        .bind(instant(105, 0))
        .bind(box_sscc(1500))
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let close = |n: u32, count: u32| {
        event(
            n,
            "warehouse_pallet_closed",
            json!({
                "palletId": PALLET_A, "sscc": pallet_sscc(40), "blockId": block["id"], "serial": 40,
                "openedAt": instant(100, 0), "closedAt": instant(110, 0), "boxCount": count
            }),
        )
    };
    // The count that includes the taken-apart box is a mismatch naming the real one.
    assert_eq!(
        receipts_of(&admin, &key, &[close(4, 2)]).await,
        vec![rejected(
            4,
            "pallet_count_mismatch",
            Some(json!({ "counted": 1 }))
        )]
    );
    // The handheld's count of what remains closes the pallet.
    assert_eq!(
        receipts_of(&admin, &key, &[close(5, 1)]).await,
        vec![accepted(5)]
    );
}
