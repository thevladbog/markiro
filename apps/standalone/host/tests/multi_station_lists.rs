//! A device's shift answers (plan 2b, spec §4.2 «Итоги станциям»): an open shift names the line's
//! limit, its participants, the asking device's state, the whole shift's totals as of the read and
//! each device's part; a planned shift names none of them.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    accepted, admin, box_id, empty, fact, instant, json as json_request, ok_scan, open_floor,
    plan_shift, receipts, record_id, request, shift_body, shift_setup, with_device,
};

#[tokio::test]
async fn an_open_shift_lists_its_participants_and_totals_and_a_planned_one_none() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key, &setup.line).await;
    let planned = plan_shift(&admin, shift_body(&setup)).await;
    let at = admin.app.state.timestamp();
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(1),
                "scan",
                &floor.shift,
                ok_scan(1, &box_id(1), &instant(1, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(1))]
    );
    let (status, list) = admin
        .app
        .send(empty(with_device(
            request("GET", "/v1/device/shifts"),
            &floor.key,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let shifts = list["shifts"].as_array().unwrap();
    let open = shifts
        .iter()
        .find(|shift| shift["id"] == json!(floor.shift))
        .unwrap();
    assert_eq!(open["maxStations"], json!(1));
    assert_eq!(open["myState"], json!("active"));
    assert_eq!(
        open["totals"],
        json!({ "accepted": 1, "boxesClosed": 0, "pallets": 0, "asOf": at })
    );
    assert_eq!(
        open["byDevice"],
        json!([{ "deviceId": floor.station, "accepted": 1, "boxesClosed": 0, "pallets": 0 }])
    );
    let participants = open["participants"].as_array().unwrap();
    assert_eq!(participants.len(), 1);
    let me = &participants[0];
    assert_eq!(
        [
            "deviceId",
            "deviceKind",
            "deviceName",
            "state",
            "firstEnteredAt",
            "joinedAt",
            "leftAt",
            "closedAt",
            "closedBy",
            "closedActualQty",
            "closedReasonCode",
            "lateDataAt",
            "lastSeenAt"
        ]
        .map(|key| me[key].clone()),
        [
            json!(floor.station),
            json!("station"),
            json!("Тестовое устройство"),
            json!("active"),
            json!(at),
            json!(at),
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Null,
            json!(at)
        ]
    );
    let plan = shifts
        .iter()
        .find(|shift| shift["id"] == planned["id"])
        .unwrap();
    for key in [
        "maxStations",
        "participants",
        "myState",
        "totals",
        "byDevice",
    ] {
        assert!(plan.get(key).is_none(), "{key}: {plan}");
    }
    // The owner's entry again answers the same participation, with the snapshot.
    let (status, entered) = admin
        .app
        .send(json_request(
            with_device(
                request("POST", &format!("/v1/device/shifts/{}/enter", floor.shift)),
                &floor.key,
            ),
            json!({}),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    assert!(entered["snapshot"].is_object());
    for key in [
        "maxStations",
        "participants",
        "myState",
        "totals",
        "byDevice",
    ] {
        assert_eq!(entered[key], open[key], "{key}");
    }
}
