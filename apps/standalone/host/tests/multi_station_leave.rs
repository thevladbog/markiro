//! A participant's leave (plan 2b, spec §4.2 «Выход»): it frees its slot and may come back while a
//! slot is free; a leave repeated changes nothing; a device that never entered cannot leave.

mod support;

use axum::http::StatusCode;
use serde_json::json;
use support::app::{admin, audit_rows, audit_trail, host_revision, shift_body, shift_setup};
use support::multi::{admin_station_on, constraint, enter, leave, open_shared, station_on, MULTI};

#[tokio::test]
async fn a_station_that_leaves_frees_its_slot_and_comes_back_when_one_is_free() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    let b = station_on(&admin, &setup.line).await;
    let (shift, number) = open_shared(&admin, shift_body(&setup), &a).await;
    let revision = host_revision(&admin.app).await;
    let (status, left) = leave(&admin, &a, &shift).await;
    assert_eq!(status, StatusCode::OK, "{left}");
    assert_eq!(
        (left["myState"].clone(), left.get("snapshot").is_none()),
        (json!("left"), true)
    );
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    let leave_row = |device: &str| {
        (
            "device".to_owned(),
            Some(device.to_owned()),
            "shift.leave".to_owned(),
            Some("shift".to_owned()),
            Some(shift.clone()),
            "ok".to_owned(),
            json!({ "number": number }),
        )
    };
    assert_eq!(
        audit_trail(&admin.app, "shift.leave").await,
        vec![leave_row(&a.id)]
    );
    // A leave repeated changes nothing.
    let rows = audit_rows(&admin.app).await;
    let (status, again) = leave(&admin, &a, &shift).await;
    assert_eq!(
        (status, again["myState"].clone()),
        (StatusCode::OK, json!("left"))
    );
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert_eq!(audit_rows(&admin.app).await, rows);
    // The slot is free: B joins, and A's return finds the line full.
    admin.app.clock.advance(time::Duration::minutes(1));
    let (status, joined) = enter(&admin, &b, &shift, &[MULTI]).await;
    assert_eq!(status, StatusCode::OK, "{joined}");
    let (status, refused) = enter(&admin, &a, &shift, &[MULTI]).await;
    assert_eq!(
        (status, refused["error"]["details"].clone()),
        (
            StatusCode::CONFLICT,
            json!({ "constraint": "shift_line_full", "maxStations": 1, "active": 1 })
        )
    );
    // B leaves, A comes back.
    let (status, _) = leave(&admin, &b, &shift).await;
    assert_eq!(status, StatusCode::OK);
    let (status, back) = enter(&admin, &a, &shift, &[MULTI]).await;
    assert_eq!(
        (status, back["myState"].clone()),
        (StatusCode::OK, json!("active"))
    );
    let join_row = |device: &str, rejoined: bool| {
        (
            "device".to_owned(),
            Some(device.to_owned()),
            "shift.join".to_owned(),
            Some("shift".to_owned()),
            Some(shift.clone()),
            "ok".to_owned(),
            json!({ "number": number, "rejoined": rejoined }),
        )
    };
    assert_eq!(
        audit_trail(&admin.app, "shift.join").await,
        vec![join_row(&b.id, false), join_row(&a.id, true)]
    );
    assert_eq!(
        audit_trail(&admin.app, "shift.leave").await,
        vec![leave_row(&a.id), leave_row(&b.id)]
    );
}

#[tokio::test]
async fn a_device_that_never_entered_cannot_leave() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    let b = station_on(&admin, &setup.line).await;
    let (shift, _) = open_shared(&admin, shift_body(&setup), &a).await;
    let rows = audit_rows(&admin.app).await;
    let (status, refused) = leave(&admin, &b, &shift).await;
    assert_eq!(
        (status, constraint(&refused)),
        (StatusCode::CONFLICT, json!("shift_not_entered"))
    );
    let (status, missing) = leave(&admin, &b, "00000000-0000-4000-8000-000000000099").await;
    assert_eq!(
        (status, missing["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
}
