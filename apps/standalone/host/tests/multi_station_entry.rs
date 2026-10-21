//! Entry by the line's capacity (plan 2b, spec §4.2 «Вход»): a device that names
//! `multi-station-v1` joins an open shift while the line has a free slot; a full line is
//! `shift_line_full`; a device that names nothing still finds the shift `shift_busy`; a revoked
//! device's slot is free.

mod support;

use axum::http::StatusCode;
use serde_json::json;
use support::app::{admin, audit_rows, audit_trail, host_revision, shift_body, shift_setup};
use support::multi::{admin_station_on, allow, constraint, enter, open_shared, station_on, MULTI};

#[tokio::test]
async fn a_second_station_joins_while_the_line_has_a_free_slot() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    let b = station_on(&admin, &setup.line).await;
    allow(&admin, &setup.line, 2).await;
    let (shift, number) = open_shared(&admin, shift_body(&setup), &a).await;
    admin.app.clock.advance(time::Duration::minutes(1));
    let revision = host_revision(&admin.app).await;
    let (status, joined) = enter(&admin, &b, &shift, &[MULTI]).await;
    assert_eq!(status, StatusCode::OK, "{joined}");
    assert_eq!(
        (
            joined["myState"].clone(),
            joined["ownerDeviceId"].clone(),
            joined["snapshot"].is_object()
        ),
        (json!("active"), json!(a.id), true)
    );
    assert_eq!(
        joined["participants"]
            .as_array()
            .unwrap()
            .iter()
            .map(|participant| participant["deviceId"].clone())
            .collect::<Vec<_>>(),
        vec![json!(a.id), json!(b.id)]
    );
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert_eq!(
        audit_trail(&admin.app, "shift.join").await,
        vec![(
            "device".to_owned(),
            Some(b.id.clone()),
            "shift.join".to_owned(),
            Some("shift".to_owned()),
            Some(shift.clone()),
            "ok".to_owned(),
            json!({ "number": number, "rejoined": false })
        )]
    );
    // The joined station enters again: no revision, no row.
    let rows = audit_rows(&admin.app).await;
    let (status, again) = enter(&admin, &b, &shift, &[MULTI]).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert_eq!(audit_rows(&admin.app).await, rows);
}

#[tokio::test]
async fn a_full_line_is_shift_line_full_and_writes_nothing() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    let b = station_on(&admin, &setup.line).await;
    let (shift, _) = open_shared(&admin, shift_body(&setup), &a).await;
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let (status, refused) = enter(&admin, &b, &shift, &[MULTI]).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(
        (
            refused["error"]["code"].clone(),
            refused["error"]["details"].clone()
        ),
        (
            json!("conflict"),
            json!({ "constraint": "shift_line_full", "maxStations": 1, "active": 1 })
        )
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
    let participants: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM shift_participants WHERE shift_id = ?")
            .bind(&shift)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(participants, 1);
}

#[tokio::test]
async fn a_device_that_names_no_multi_station_still_finds_the_shift_busy() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    let b = station_on(&admin, &setup.line).await;
    allow(&admin, &setup.line, 2).await;
    let (shift, _) = open_shared(&admin, shift_body(&setup), &a).await;
    for supports in [&[][..], &["validation-v1"][..]] {
        let (status, refused) = enter(&admin, &b, &shift, supports).await;
        assert_eq!(status, StatusCode::CONFLICT, "{refused}");
        assert_eq!(constraint(&refused), json!("shift_busy"), "{supports:?}");
    }
}

#[tokio::test]
async fn a_revoked_device_leaves_its_slot_free() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let b = station_on(&admin, &setup.line).await;
    let c = station_on(&admin, &setup.line).await;
    let (shift, _) = open_shared(&admin, shift_body(&setup), &b).await;
    let (status, refused) = enter(&admin, &c, &shift, &[MULTI]).await;
    assert_eq!(
        (status, constraint(&refused)),
        (StatusCode::CONFLICT, json!("shift_line_full"))
    );
    let (status, revoked) = admin
        .call("POST", &format!("/v1/office/devices/{}/revoke", b.id), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{revoked}");
    let (status, joined) = enter(&admin, &c, &shift, &[MULTI]).await;
    assert_eq!(status, StatusCode::OK, "{joined}");
    assert_eq!(joined["myState"], json!("active"));
}
