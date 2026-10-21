//! A participant's leave (plan 2b, spec §4.2 «Выход»): it frees its slot and may come back while a
//! slot is free; a leave repeated changes nothing; a device that never entered cannot leave.

mod support;

use axum::http::StatusCode;
use serde_json::json;
use support::app::{admin, audit_rows, audit_trail, host_revision, shift_body, shift_setup};
use support::multi::{
    admin_station_on, constraint, enter, joined_rev, leave, leave_with, open_shared, participant,
    station_on, MULTI,
};

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

#[tokio::test]
async fn a_stale_leave_does_not_undo_a_re_entry_and_a_current_one_works() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    let (shift, _) = open_shared(&admin, shift_body(&setup), &a).await;
    let (_, first) = enter(&admin, &a, &shift, &[MULTI]).await;
    let first_rev = joined_rev(&first, &a.id);
    assert!(first_rev.is_u64(), "{first}");
    // Leave, come back: a new token.
    let (status, _) = leave_with(&admin, &a, &shift, json!({ "joinedRev": first_rev })).await;
    assert_eq!(status, StatusCode::OK);
    admin.app.clock.advance(time::Duration::minutes(1));
    let (status, back) = enter(&admin, &a, &shift, &[MULTI]).await;
    assert_eq!(status, StatusCode::OK, "{back}");
    let second_rev = joined_rev(&back, &a.id);
    assert_ne!(second_rev, first_rev);
    // The leave of the first stay arrives late: it answers the shift as it is and writes nothing.
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let (status, stale) = leave_with(&admin, &a, &shift, json!({ "joinedRev": first_rev })).await;
    assert_eq!(status, StatusCode::OK, "{stale}");
    assert_eq!(stale["myState"], json!("active"));
    assert_eq!(joined_rev(&stale, &a.id), second_rev);
    assert_eq!(participant(&admin, &shift, &a.id).await.0, "active");
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
    // The current token leaves.
    let (status, left) = leave_with(&admin, &a, &shift, json!({ "joinedRev": second_rev })).await;
    assert_eq!(status, StatusCode::OK, "{left}");
    assert_eq!(left["myState"], json!("left"));
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert_eq!(audit_trail(&admin.app, "shift.leave").await.len(), 2);
}

#[tokio::test]
async fn a_leave_body_with_an_unknown_field_or_a_wrong_type_is_a_validation_error() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    let (shift, _) = open_shared(&admin, shift_body(&setup), &a).await;
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    for body in [
        json!({ "joinedRev": 1, "extra": true }),
        json!({ "joinedRev": "1" }),
        json!({}),
    ] {
        let (status, refused) = leave_with(&admin, &a, &shift, body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        assert_eq!(refused["error"]["code"], json!("validation_failed"));
    }
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
}
