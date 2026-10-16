//! Regressions found by the independent review of the handheld support on the host (plan ТСД-Х):
//! the SSCC of a pallet is one label across production and warehouse pallets, a warehouse close
//! judges the block it was printed from and not today's GLN, and a taken-apart box does not keep a
//! warehouse pallet "occupied".

mod support;

use axum::http::StatusCode;
use markiro_host::facts::rules::box_membership_digest;
use serde_json::{json, Value};
use support::app::{
    admin, box_id, code_hash, fact, instant, issue_block, issue_pallet_block, ok_scan,
    pallet_closed, pallet_id, receipts, record_id, rejected, send_facts, shift_setup, Admin, Floor,
};
use support::handheld::{
    accepted, added, box_sscc, event, open_handheld_pallet_floor, opened, pallet_sscc, product_of,
    receipts_of, rejected as event_rejected, PALLET_A, PALLET_B,
};

const OPERATOR: &str = "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d";

/// A handheld on a shift with pallets, with a box block (1500-3499) and a pallet block (40-239),
/// and `boxes` closed boxes of its own shift standing free.
async fn handheld_floor(boxes: u32) -> (Admin, Floor, Value, support::app::ShiftSetup) {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_handheld_pallet_floor(&admin, &setup).await;
    let block = issue_block(
        &admin.app,
        &floor.key,
        "7e6d5c4b-3a2f-4e1d-9c8b-7a6f5e4d3c2b",
    )
    .await;
    let pallets = issue_pallet_block(
        &admin.app,
        &floor.key,
        "8f7e6d5c-4b3a-4f2e-8d1c-9b8a7f6e5d4c",
    )
    .await;
    for n in 1..=boxes {
        let digest = box_membership_digest(&[code_hash(n)]);
        let mut scan = fact(
            &record_id(100 + n),
            "scan",
            &floor.shift,
            ok_scan(n, &box_id(n), &instant(n, 0)),
        );
        scan["operatorId"] = json!(OPERATOR);
        let mut closed = fact(
            &record_id(200 + n),
            "box_closed",
            &floor.shift,
            json!({
                "boxId": box_id(n), "sscc": box_sscc(1499 + n), "blockId": block["id"],
                "serial": 1499 + n, "openedAt": instant(n, 0), "closedAt": instant(n, 500),
                "itemCount": 1, "membershipDigest": digest
            }),
        );
        closed["operatorId"] = json!(OPERATOR);
        assert_eq!(
            receipts(&admin.app, &floor.key, &[scan, closed])
                .await
                .len(),
            2
        );
    }
    (admin, floor, pallets, setup)
}

fn warehouse_close(
    n: u32,
    pallet: &str,
    block: &Value,
    serial: u64,
    sscc: &str,
    boxes: u32,
) -> Value {
    event(
        n,
        "warehouse_pallet_closed",
        json!({
            "palletId": pallet, "sscc": sscc, "blockId": block["id"], "serial": serial,
            "openedAt": instant(100, 0), "closedAt": instant(110, 0), "boxCount": boxes
        }),
    )
}

fn production_close(
    floor: &Floor,
    n: u32,
    pallet: &str,
    block: &Value,
    serial: u64,
    sscc: &str,
) -> Value {
    let mut data = pallet_closed(pallet, block, serial, 1, &instant(100, 0), &instant(110, 0));
    data["sscc"] = json!(sscc);
    let mut record = fact(&record_id(n), "pallet_closed", &floor.shift, data);
    record["operatorId"] = json!(OPERATOR);
    record
}

/// Finding 1: one serial of a pallet block is one label whichever kind of pallet it is printed on.
/// The warehouse close already looked at both tables; the production close looked at its own.
#[tokio::test]
async fn a_production_pallet_cannot_take_the_sscc_of_a_warehouse_pallet() {
    let (admin, floor, pallets, setup) = handheld_floor(2).await;
    let got = receipts_of(
        &admin,
        &floor.key,
        &[
            opened(1, PALLET_A, product_of(&setup), &instant(100, 0)),
            added(2, PALLET_A, &box_sscc(1500), &instant(101, 0)),
            warehouse_close(3, PALLET_A, &pallets, 40, &pallet_sscc(40), 1),
        ],
    )
    .await;
    assert_eq!(got, vec![accepted(1), accepted(2), accepted(3)]);
    // The same SSCC, and the same serial under another check digit: both are taken.
    let same = production_close(&floor, 301, &pallet_id(1), &pallets, 40, &pallet_sscc(40));
    let digit = production_close(
        &floor,
        302,
        &pallet_id(2),
        &pallets,
        40,
        &support::app::pallet_sscc(40),
    );
    let (status, body) = send_facts(&admin.app, &floor.key, &[same, digit]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["receipts"],
        json!([
            rejected(Some(&record_id(301)), "sscc_taken", None),
            rejected(Some(&record_id(302)), "sscc_taken", None)
        ])
    );
    let stored: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pallets WHERE sscc IS NOT NULL")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(stored, 0, "the production pallet was not written");
}

/// Finding 5: the pallet was printed offline from a block issued under the GLN of the day; the
/// office changed the issuer prefix before the close reached the host. The block is still live and
/// still names its own prefix, so the close is judged against that.
#[tokio::test]
async fn a_warehouse_close_is_judged_by_its_block_and_not_by_the_gln_changed_since() {
    let (admin, floor, pallets, setup) = handheld_floor(1).await;
    receipts_of(
        &admin,
        &floor.key,
        &[
            opened(1, PALLET_A, product_of(&setup), &instant(100, 0)),
            added(2, PALLET_A, &box_sscc(1500), &instant(101, 0)),
        ],
    )
    .await;
    sqlx::query("UPDATE org_profile SET gln = '4600999000012' WHERE id = 1")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let got = receipts_of(
        &admin,
        &floor.key,
        &[warehouse_close(
            3,
            PALLET_A,
            &pallets,
            40,
            &pallet_sscc(40),
            1,
        )],
    )
    .await;
    assert_eq!(got, vec![accepted(3)]);
    // A serial outside the block, or another prefix than the block's, is still not issued.
    let wrong = event(
        4,
        "warehouse_pallet_closed",
        json!({
            "palletId": PALLET_B, "sscc": "146009990000000419", "blockId": pallets["id"],
            "serial": 41, "openedAt": instant(100, 0), "closedAt": instant(110, 0), "boxCount": 1
        }),
    );
    let got = receipts_of(
        &admin,
        &floor.key,
        &[
            opened(5, PALLET_B, product_of(&setup), &instant(100, 0)),
            wrong,
        ],
    )
    .await;
    assert_eq!(got[1], event_rejected(4, "sscc_not_issued", None));
}

/// Finding 6: the only box of a warehouse pallet was taken apart by the production side. The close
/// refuses an empty pallet (count 0); the next pallet must not be refused as well.
#[tokio::test]
async fn a_pallet_whose_only_box_was_taken_apart_does_not_block_the_next_pallet() {
    let (admin, floor, _pallets, setup) = handheld_floor(1).await;
    receipts_of(
        &admin,
        &floor.key,
        &[
            opened(1, PALLET_A, product_of(&setup), &instant(100, 0)),
            added(2, PALLET_A, &box_sscc(1500), &instant(101, 0)),
        ],
    )
    .await;
    let mut exception = fact(
        &record_id(900),
        "box_exception",
        &floor.shift,
        json!({
            "exception": "disassemble", "boxId": box_id(1), "codeHash": null,
            "targetScannedAt": null, "reasonCode": "other", "reasonText": "Короб рассыпался",
            "occurredAt": instant(300, 0)
        }),
    );
    exception["operatorId"] = json!(OPERATOR);
    let (status, sent) = send_facts(&admin.app, &floor.key, &[exception]).await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    assert_eq!(sent["receipts"][0]["outcome"], json!("accepted"), "{sent}");
    let got = receipts_of(
        &admin,
        &floor.key,
        &[opened(3, PALLET_B, product_of(&setup), &instant(310, 0))],
    )
    .await;
    assert_eq!(got, vec![accepted(3)], "the empty draft is replaced");
}
