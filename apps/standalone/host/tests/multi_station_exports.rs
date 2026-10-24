//! The ЧЗ document of a shared shift (plan 2b, spec §7 «Экспорты»): its operation instant is the
//! latest close among its devices (not the last-received one); an office-closed shift has
//! none.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, close_from_office, fact, instant, receipts, record_id, shift_body, shift_closed,
    shift_setup, Admin,
};
use support::multi::{admin_station_on, open_shared, shared};

async fn station_closed_at(admin: &Admin, shift: &str) -> Value {
    let (status, source) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{shift}/export-source"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{source}");
    source["shift"]["stationClosedAt"].clone()
}

#[tokio::test]
async fn a_shared_shifts_document_takes_the_latest_close_instant_when_closes_arrive_in_order() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, b, shift, _) = shared(&admin, &setup, None).await;
    let close = |at: String| {
        fact(
            &record_id(1),
            "shift_closed",
            &shift,
            shift_closed(None, 0, 0, None, &at),
        )
    };
    receipts(&admin.app, &a.key, &[close(instant(60, 0))]).await;
    receipts(&admin.app, &b.key, &[close(instant(120, 250))]).await;
    assert_eq!(
        station_closed_at(&admin, &shift).await,
        json!(instant(120, 250))
    );
}

#[tokio::test]
async fn an_offline_stations_earlier_close_arriving_last_does_not_move_the_instant_back() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, b, shift, _) = shared(&admin, &setup, None).await;
    let close = |at: String| {
        fact(
            &record_id(1),
            "shift_closed",
            &shift,
            shift_closed(None, 0, 0, None, &at),
        )
    };
    // B closed later by its own clock but its close arrives first; A's earlier close arrives last
    // and closes the shift: the document still names the latest instant, with B's milliseconds.
    receipts(&admin.app, &b.key, &[close(instant(120, 250))]).await;
    receipts(&admin.app, &a.key, &[close(instant(60, 900))]).await;
    assert_eq!(
        station_closed_at(&admin, &shift).await,
        json!(instant(120, 250))
    );
}

#[tokio::test]
async fn a_shift_the_office_closed_after_a_part_takes_no_station_instant() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, _b, shift, _) = shared(&admin, &setup, None).await;
    receipts(
        &admin.app,
        &a.key,
        &[fact(
            &record_id(1),
            "shift_closed",
            &shift,
            shift_closed(None, 0, 0, None, &instant(60, 0)),
        )],
    )
    .await;
    close_from_office(&admin, &shift, "Сбой станции").await;
    assert_eq!(station_closed_at(&admin, &shift).await, Value::Null);
}

#[tokio::test]
async fn a_one_device_shift_exports_its_single_close_as_before() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    let (shift, _) = open_shared(&admin, shift_body(&setup), &a).await;
    receipts(
        &admin.app,
        &a.key,
        &[fact(
            &record_id(1),
            "shift_closed",
            &shift,
            shift_closed(None, 0, 0, None, &instant(70, 412)),
        )],
    )
    .await;
    assert_eq!(
        station_closed_at(&admin, &shift).await,
        json!(instant(70, 412))
    );
}
