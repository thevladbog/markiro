//! The office's shift (plan 2b, spec §7 «Смена»): the participants, each device's part of the
//! totals and the mark of a reason its devices did not give; a planned shift names none of them.

mod support;

use axum::http::StatusCode;
use serde_json::json;
use support::app::{
    accepted, admin, box_closed, box_id, fact, instant, issue_block, ok_scan, plan_shift, receipts,
    record_id, shift_body, shift_closed, shift_setup,
};
use support::multi::shared;

#[tokio::test]
async fn the_office_reads_a_shared_shifts_participants_and_each_devices_part() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, b, shift, _) = shared(&admin, &setup, None).await;
    let planned = plan_shift(&admin, shift_body(&setup)).await;
    assert_eq!(
        receipts(
            &admin.app,
            &a.key,
            &[fact(
                &record_id(1),
                "scan",
                &shift,
                ok_scan(1, &box_id(1), &instant(1, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(1))]
    );
    let (status, detail) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(
        detail["participants"]
            .as_array()
            .unwrap()
            .iter()
            .map(|participant| (
                participant["deviceId"].clone(),
                participant["state"].clone()
            ))
            .collect::<Vec<_>>(),
        vec![
            (json!(a.id), json!("active")),
            (json!(b.id), json!("active"))
        ]
    );
    assert_eq!(
        detail["byDevice"],
        json!([
            { "deviceId": a.id, "accepted": 1, "boxesClosed": 0, "pallets": 0 },
            { "deviceId": b.id, "accepted": 0, "boxesClosed": 0, "pallets": 0 }
        ])
    );
    assert!(detail.get("closeReasonMissing").is_none());
    let (status, list) = admin.call("GET", "/v1/office/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let listed = list
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == json!(shift))
        .unwrap();
    assert_eq!(
        (listed["participants"].clone(), listed["byDevice"].clone()),
        (detail["participants"].clone(), detail["byDevice"].clone())
    );
    let plan = list
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == planned["id"])
        .unwrap();
    assert!(plan.get("participants").is_none() && plan.get("byDevice").is_none());
}

const BLOCK: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";

async fn office_shift(admin: &support::app::Admin, shift: &str) -> serde_json::Value {
    let (status, detail) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    detail
}

#[tokio::test]
async fn a_close_reason_the_devices_did_not_give_shows_on_the_detail_and_the_list() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, b, shift, _) = shared(&admin, &setup, Some(5)).await;
    let close = fact(
        &record_id(1),
        "shift_closed",
        &shift,
        shift_closed(Some(5), 0, 0, None, &instant(30, 0)),
    );
    receipts(&admin.app, &a.key, &[close.clone()]).await;
    receipts(&admin.app, &b.key, &[close]).await;
    let detail = office_shift(&admin, &shift).await;
    assert_eq!(detail["status"], json!("closed"));
    assert_eq!(detail["closeReasonMissing"], json!(true));
    let (status, list) = admin.call("GET", "/v1/office/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let listed = list
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == json!(shift))
        .unwrap();
    assert_eq!(listed["closeReasonMissing"], json!(true));
}

#[tokio::test]
async fn a_closed_part_shows_when_it_closed_its_quantity_and_its_reason() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, b, shift, _) = shared(&admin, &setup, Some(10)).await;
    receipts(
        &admin.app,
        &a.key,
        &[fact(
            &record_id(1),
            "scan",
            &shift,
            ok_scan(1, &box_id(1), &instant(1, 0)),
        )],
    )
    .await;
    // The part keeps the instant the device wrote, to the second.
    let closed_at = "2026-10-08T06:01:00Z";
    let close = fact(
        &record_id(2),
        "shift_closed",
        &shift,
        shift_closed(Some(10), 1, 0, Some("equipment_stop"), &instant(60, 0)),
    );
    receipts(&admin.app, &a.key, &[close]).await;
    let detail = office_shift(&admin, &shift).await;
    let parts = detail["participants"].as_array().unwrap();
    let part = |device: &str| {
        parts
            .iter()
            .find(|part| part["deviceId"] == json!(device))
            .unwrap()
    };
    let closed = part(&a.id);
    assert_eq!(
        (
            closed["state"].clone(),
            closed["closedAt"].clone(),
            closed["closedBy"].clone(),
            closed["closedActualQty"].clone(),
            closed["closedReasonCode"].clone()
        ),
        (
            json!("closed"),
            json!(closed_at),
            json!("device"),
            json!(1),
            json!("equipment_stop")
        )
    );
    let open = part(&b.id);
    assert_eq!(open["state"], json!("active"));
    for field in [
        "closedAt",
        "closedBy",
        "closedActualQty",
        "closedReasonCode",
    ] {
        assert!(open[field].is_null(), "{field}: {open}");
    }
}

#[tokio::test]
async fn the_devices_parts_add_up_to_the_shifts_totals() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, b, shift, _) = shared(&admin, &setup, None).await;
    let block_a = issue_block(&admin.app, &a.key, BLOCK).await;
    let block_b = issue_block(&admin.app, &b.key, "4d3c2b1a-9a8f-4e7d-8c6b-5a4f3e2d1c0b").await;
    let from = |n: u32| instant(n, 0);
    let answered_a = receipts(
        &admin.app,
        &a.key,
        &[
            fact(
                &record_id(1),
                "scan",
                &shift,
                ok_scan(1, &box_id(1), &from(1)),
            ),
            fact(
                &record_id(2),
                "scan",
                &shift,
                ok_scan(2, &box_id(1), &from(2)),
            ),
            fact(
                &record_id(3),
                "box_closed",
                &shift,
                box_closed(&box_id(1), &block_a, 1500, &[1, 2], &from(1), &from(3)),
            ),
        ],
    )
    .await;
    let answered_b = receipts(
        &admin.app,
        &b.key,
        &[
            fact(
                &record_id(11),
                "scan",
                &shift,
                ok_scan(3, &box_id(2), &from(4)),
            ),
            fact(
                &record_id(12),
                "box_closed",
                &shift,
                box_closed(&box_id(2), &block_b, 3500, &[3], &from(4), &from(5)),
            ),
            fact(
                &record_id(13),
                "scan",
                &shift,
                ok_scan(4, &box_id(3), &from(6)),
            ),
        ],
    )
    .await;
    for receipt in answered_a.iter().chain(&answered_b) {
        assert_eq!(receipt["outcome"], json!("accepted"), "{receipt}");
    }
    let detail = office_shift(&admin, &shift).await;
    let by_device = detail["byDevice"].as_array().unwrap();
    assert_eq!(by_device.len(), 2);
    let sum = |field: &str| -> u64 {
        by_device
            .iter()
            .map(|part| part[field].as_u64().unwrap())
            .sum()
    };
    let totals = &detail["totals"];
    assert_eq!(
        (sum("accepted"), sum("boxesClosed"), sum("pallets")),
        (
            totals["acceptedUnits"].as_u64().unwrap(),
            totals["closedBoxes"].as_u64().unwrap(),
            totals["closedPallets"].as_u64().unwrap()
        )
    );
    assert_eq!(
        (sum("accepted"), sum("boxesClosed")),
        (4, 2),
        "{by_device:?}"
    );
}

#[tokio::test]
async fn a_revoked_device_stays_among_the_participants_and_the_parts() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, b, shift, _) = shared(&admin, &setup, None).await;
    receipts(
        &admin.app,
        &b.key,
        &[fact(
            &record_id(1),
            "scan",
            &shift,
            ok_scan(1, &box_id(1), &instant(1, 0)),
        )],
    )
    .await;
    let (status, revoked) = admin
        .call("POST", &format!("/v1/office/devices/{}/revoke", b.id), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{revoked}");
    let detail = office_shift(&admin, &shift).await;
    assert_eq!(
        detail["participants"]
            .as_array()
            .unwrap()
            .iter()
            .map(|part| part["deviceId"].clone())
            .collect::<Vec<_>>(),
        vec![json!(a.id), json!(b.id)]
    );
    assert_eq!(
        detail["byDevice"],
        json!([
            { "deviceId": a.id, "accepted": 0, "boxesClosed": 0, "pallets": 0 },
            { "deviceId": b.id, "accepted": 1, "boxesClosed": 0, "pallets": 0 }
        ])
    );
}
