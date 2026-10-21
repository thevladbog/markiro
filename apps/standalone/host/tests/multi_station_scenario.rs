//! Several devices in one shift end to end on the host (plan 2b, spec §9.1, §11): two stations
//! scanning the same code meet the registry's conflict and share one total; a validation shift
//! counts its units per device; a handheld is a full participant and closes the shift last; an
//! offline last closer closes it without a reason the office then gives; a full line and an older
//! build are refused as each expects.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    accepted, admin, box_id, code, fact, instant, ok_scan, plan_shift, receipts, record_id,
    shift_body, shift_closed, shift_setup, Admin,
};
use support::multi::{
    admin_station_on, allow, call, constraint, enter, handheld_on, open_shared, shared, station_on,
    status_of, Device, HANDHELD, MULTI,
};

async fn device_view(admin: &Admin, device: &Device, shift: &str) -> Value {
    let (status, list) = call(admin, &device.key, "GET", "/v1/device/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    list["shifts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == json!(shift))
        .cloned()
        .unwrap()
}

fn parts(view: &Value) -> Vec<(Value, Value)> {
    view["byDevice"]
        .as_array()
        .unwrap()
        .iter()
        .map(|part| (part["deviceId"].clone(), part["accepted"].clone()))
        .collect()
}

#[tokio::test]
async fn two_stations_scanning_one_code_meet_the_conflict_and_share_one_total() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, b, shift, number) = shared(&admin, &setup, Some(3)).await;
    assert_eq!(
        receipts(
            &admin.app,
            &a.key,
            &[fact(
                &record_id(1),
                "scan",
                &shift,
                ok_scan(1, &box_id(1), &instant(10, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(1))]
    );
    // B scanned the same code later: the earliest scan keeps it.
    let late = receipts(
        &admin.app,
        &b.key,
        &[fact(
            &record_id(1),
            "scan",
            &shift,
            ok_scan(1, &box_id(2), &instant(20, 0)),
        )],
    )
    .await;
    assert_eq!(
        (
            late[0]["outcome"].clone(),
            late[0]["details"]["winner"]["deviceId"].clone(),
            late[0]["details"]["winner"]["shiftNumber"].clone(),
            late[0]["details"]["winner"]["sameDevice"].clone()
        ),
        (json!("conflict"), json!(a.id), json!(number), json!(false))
    );
    assert_eq!(
        receipts(
            &admin.app,
            &b.key,
            &[fact(
                &record_id(2),
                "scan",
                &shift,
                ok_scan(2, &box_id(2), &instant(21, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(2))]
    );
    for device in [&a, &b] {
        let view = device_view(&admin, device, &shift).await;
        assert_eq!(view["totals"]["accepted"], json!(2));
        assert_eq!(
            parts(&view),
            vec![(json!(a.id), json!(1)), (json!(b.id), json!(1))]
        );
    }
    let conflicts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM code_conflicts")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(conflicts, 1);
    // A closes first, B last: the shift-wide 2 misses the plan of 3, B gives the reason.
    let close = |planned: u32, actual: u32, reason: Option<&str>, at: u32| {
        fact(
            &record_id(9),
            "shift_closed",
            &shift,
            shift_closed(Some(planned), actual, 0, reason, &instant(at, 0)),
        )
    };
    assert_eq!(
        receipts(&admin.app, &a.key, &[close(3, 1, None, 100)]).await,
        vec![
            json!({ "id": record_id(9), "outcome": "accepted", "details": { "partClosed": true } })
        ]
    );
    assert_eq!(
        receipts(
            &admin.app,
            &b.key,
            &[close(3, 1, Some("material_shortage"), 110)]
        )
        .await,
        vec![accepted(&record_id(9))]
    );
    let row: (String, String, Option<String>, bool) = sqlx::query_as(
        "SELECT status, closed_by, close_reason_code, close_reason_missing FROM shifts WHERE id = ?",
    )
    .bind(&shift)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        row,
        (
            "closed".to_owned(),
            b.id.clone(),
            Some("material_shortage".to_owned()),
            false
        )
    );
    let view = device_view(&admin, &a, &shift).await;
    assert_eq!(
        (view["myState"].clone(), view["status"].clone()),
        (json!("closed"), json!("closed"))
    );
}

#[tokio::test]
async fn a_validation_shift_counts_each_devices_units_from_the_registry() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    let b = station_on(&admin, &setup.line).await;
    allow(&admin, &setup.line, 2).await;
    let mut body = shift_body(&setup);
    body["mode"] = json!("validation");
    let shift = plan_shift(&admin, body).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    for device in [&a, &b] {
        let (status, entered) = enter(&admin, device, &id, &["validation-v1", MULTI]).await;
        assert_eq!(status, StatusCode::OK, "{entered}");
        // Participants list by first entry, then device id: a minute apart keeps the order fixed.
        admin.app.clock.advance(time::Duration::minutes(1));
    }
    let unit = |n: u32, at: u32| {
        json!({
            "scannedAt": instant(at, 0), "verdict": "ok", "duplicateSource": null,
            "rawKind": "km", "rawLength": 38, "code": code(n), "boxId": null
        })
    };
    assert_eq!(
        receipts(
            &admin.app,
            &a.key,
            &[fact(&record_id(1), "scan", &id, unit(1, 1))]
        )
        .await,
        vec![accepted(&record_id(1))]
    );
    assert_eq!(
        receipts(
            &admin.app,
            &b.key,
            &[fact(&record_id(1), "scan", &id, unit(2, 2))]
        )
        .await,
        vec![accepted(&record_id(1))]
    );
    let view = device_view(&admin, &b, &id).await;
    assert_eq!(
        (
            view["totals"]["accepted"].clone(),
            view["totals"]["boxesClosed"].clone()
        ),
        (json!(2), json!(0))
    );
    assert_eq!(
        parts(&view),
        vec![(json!(a.id), json!(1)), (json!(b.id), json!(1))]
    );
}

#[tokio::test]
async fn a_handheld_works_the_shift_as_a_full_participant_and_closes_it_last() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    let h = handheld_on(&admin, &setup.line).await;
    allow(&admin, &setup.line, 2).await;
    let (shift, _) = open_shared(&admin, shift_body(&setup), &a).await;
    admin.app.clock.advance(time::Duration::minutes(1));
    // A handheld without the capability finds it busy, as every handheld build before plan 2b.
    let (status, busy) = enter(&admin, &h, &shift, &[HANDHELD]).await;
    assert_eq!(
        (status, constraint(&busy)),
        (StatusCode::CONFLICT, json!("shift_busy"))
    );
    let (status, joined) = enter(&admin, &h, &shift, &[HANDHELD, MULTI]).await;
    assert_eq!(status, StatusCode::OK, "{joined}");
    assert_eq!(joined["participants"][1]["deviceKind"], json!("handheld"));
    assert_eq!(
        receipts(
            &admin.app,
            &h.key,
            &[fact(
                &record_id(1),
                "scan",
                &shift,
                ok_scan(7, &box_id(7), &instant(30, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(1))]
    );
    let close = |at: u32| {
        fact(
            &record_id(5),
            "shift_closed",
            &shift,
            shift_closed(None, 0, 0, None, &instant(at, 0)),
        )
    };
    assert_eq!(
        receipts(&admin.app, &a.key, &[close(100)]).await,
        vec![
            json!({ "id": record_id(5), "outcome": "accepted", "details": { "partClosed": true } })
        ]
    );
    assert_eq!(
        receipts(&admin.app, &h.key, &[close(110)]).await,
        vec![accepted(&record_id(5))]
    );
    let closer: String = sqlx::query_scalar("SELECT closed_by FROM shifts WHERE id = ?")
        .bind(&shift)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(
        (status_of(&admin, &shift).await, closer),
        ("closed".to_owned(), h.id.clone())
    );
}

#[tokio::test]
async fn an_offline_last_closer_closes_without_a_reason_and_the_office_gives_it() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, b, shift, _) = shared(&admin, &setup, Some(10)).await;
    assert_eq!(
        receipts(
            &admin.app,
            &a.key,
            &[fact(
                &record_id(1),
                "shift_closed",
                &shift,
                shift_closed(Some(10), 0, 0, None, &instant(50, 0))
            )]
        )
        .await,
        vec![
            json!({ "id": record_id(1), "outcome": "accepted", "details": { "partClosed": true } })
        ]
    );
    // B worked without the link and sends its queue at once: two scans and its close.
    let queue = [
        fact(
            &record_id(1),
            "scan",
            &shift,
            ok_scan(1, &box_id(1), &instant(10, 0)),
        ),
        fact(
            &record_id(2),
            "scan",
            &shift,
            ok_scan(2, &box_id(1), &instant(11, 0)),
        ),
        fact(
            &record_id(3),
            "shift_closed",
            &shift,
            shift_closed(Some(10), 2, 0, None, &instant(60, 0)),
        ),
    ];
    assert_eq!(
        receipts(&admin.app, &b.key, &queue).await,
        vec![
            accepted(&record_id(1)),
            accepted(&record_id(2)),
            json!({ "id": record_id(3), "outcome": "accepted", "details": { "reasonMissing": true } })
        ]
    );
    let path = format!("/v1/office/shifts/{shift}");
    let (_, office) = admin.call("GET", &path, None).await;
    assert_eq!(
        (
            office["status"].clone(),
            office["closeReasonMissing"].clone(),
            office["totals"]["acceptedUnits"].clone()
        ),
        (json!("closed"), json!(true), json!(2))
    );
    let (status, set) = admin
        .call(
            "PUT",
            &format!("{path}/close-reason"),
            Some(json!({ "reasonCode": "production_order_changed", "expectedRev": office["rev"] })),
        )
        .await;
    assert_eq!(
        (status, set["closeReasonCode"].clone()),
        (StatusCode::OK, json!("production_order_changed"))
    );
}

#[tokio::test]
async fn the_line_limit_and_older_builds_are_refused_as_each_expects() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    let b = station_on(&admin, &setup.line).await;
    let (shift, _) = open_shared(&admin, shift_body(&setup), &a).await;
    // Limit 1: a new build sees the line full, an older build sees the shift busy.
    let (status, full) = enter(&admin, &b, &shift, &[MULTI]).await;
    assert_eq!(
        (status, constraint(&full)),
        (StatusCode::CONFLICT, json!("shift_line_full"))
    );
    let (status, busy) = call(
        &admin,
        &b.key,
        "POST",
        &format!("/v1/device/shifts/{shift}/enter"),
        None,
    )
    .await;
    assert_eq!(
        (status, constraint(&busy)),
        (StatusCode::CONFLICT, json!("shift_busy"))
    );
}
