//! The office's shift (plan 2b, spec §7 «Смена»): the participants, each device's part of the
//! totals and the mark of a reason its devices did not give; a planned shift names none of them.

mod support;

use axum::http::StatusCode;
use serde_json::json;
use support::app::{
    accepted, admin, box_id, fact, instant, ok_scan, plan_shift, receipts, record_id, shift_body,
    shift_setup,
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
