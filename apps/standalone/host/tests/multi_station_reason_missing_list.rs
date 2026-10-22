//! A shift closed without its reason stays on the office's list (plan 2b, spec §12.9 «видимый
//! запрос в офисе»): `GET /v1/office/shifts` adds every shift marked `closeReasonMissing` to the
//! rows of its period or of its default window, in the list's own order and once, up to
//! `REASON_MISSING_CAP` of them, newest production date first. Once the office gives the reason
//! the mark clears and the shift is a closed shift like any other again. The host has no status,
//! line or search filter: those are the office's own, over the rows it reads.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, fact, instant, plan_shift, receipts, record_id, shift_body, shift_closed, shift_setup,
    Admin, ShiftSetup,
};
use support::multi::{shared, Device};

/// The host's frozen clock reads 2026-09-21: its default list keeps the closed shifts produced
/// from 2026-08-21. A shared shift of plan 5 (production date 2026-10-08) that both its devices
/// closed without a reason: the office owes one.
async fn shift_owing_a_reason(admin: &Admin, setup: &ShiftSetup) -> (Device, String) {
    let (a, b, shift, _) = shared(admin, setup, Some(5)).await;
    let close = fact(
        &record_id(1),
        "shift_closed",
        &shift,
        shift_closed(Some(5), 0, 0, None, &instant(30, 0)),
    );
    receipts(&admin.app, &a.key, &[close.clone()]).await;
    receipts(&admin.app, &b.key, &[close]).await;
    let (status, detail) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["closeReasonMissing"], json!(true));
    (a, shift)
}

/// Moves a shift's production date and shift date to `date`, as if it had been made then.
async fn made_on(admin: &Admin, shift: &str, date: &str) {
    sqlx::query("UPDATE shifts SET production_date = ?1, planned_date = ?1 WHERE id = ?2")
        .bind(date)
        .bind(shift)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
}

/// A planned shift of `setup` on `date`; its id.
async fn planned_on(admin: &Admin, setup: &ShiftSetup, date: &str) -> String {
    let mut body = shift_body(setup);
    body["productionDate"] = json!(date);
    plan_shift(admin, body).await["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// Closes a planned shift as `device`'s, with its reason given (no mark).
async fn closed_directly(admin: &Admin, shift: &str, device: &str) {
    sqlx::query(
        "UPDATE shifts SET status = 'closed', snapshot = '{}', opened_at = ?1, \
         owner_device_id = ?2, closed_at = ?1, closed_by_kind = 'device', closed_by = ?2 \
         WHERE id = ?3",
    )
    .bind(admin.app.state.timestamp())
    .bind(device)
    .bind(shift)
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
}

async fn ids(admin: &Admin, path: &str) -> Vec<String> {
    let (status, list) = admin.call("GET", path, None).await;
    assert_eq!(status, StatusCode::OK, "{path}: {list}");
    list.as_array()
        .unwrap()
        .iter()
        .map(|row: &Value| row["id"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn a_shift_owing_a_reason_is_listed_whatever_its_date_in_the_lists_order() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, owing) = shift_owing_a_reason(&admin, &setup).await;
    made_on(&admin, &owing, "2026-01-10").await;
    let recent = planned_on(&admin, &setup, "2026-10-08").await;
    // A planned shift stays on the default list whatever its date.
    let old_plan = planned_on(&admin, &setup, "2025-12-01").await;
    // A closed shift out of the window, with nothing owed: not listed.
    let old_closed = planned_on(&admin, &setup, "2026-01-11").await;
    closed_directly(&admin, &old_closed, &a.id).await;

    // The default window: the shift owing a reason takes its place by production date.
    assert_eq!(
        ids(&admin, "/v1/office/shifts").await,
        vec![recent.clone(), owing.clone(), old_plan]
    );
    // A period far from it: only the shift owing a reason.
    assert_eq!(
        ids(
            &admin,
            "/v1/office/shifts?plannedFrom=2020-01-01&plannedTo=2020-01-31"
        )
        .await,
        vec![owing.clone()]
    );
    assert_eq!(
        ids(&admin, "/v1/office/shifts?from=2026-10-01&to=2026-10-31").await,
        vec![recent, owing.clone()]
    );
    // The period that holds the closed shift lists it and the shift owing a reason.
    assert_eq!(
        ids(&admin, "/v1/office/shifts?from=2026-01-11&to=2026-01-11").await,
        vec![old_closed, owing]
    );
    // The host filters by period only: a status or a line is the office's own filter.
    for query in ["status=closed", "lineId=x", "search=x"] {
        let (status, refused) = admin
            .call("GET", &format!("/v1/office/shifts?{query}"), None)
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {refused}");
    }
}

#[tokio::test]
async fn a_shift_owing_a_reason_inside_the_period_is_listed_once() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (_, owing) = shift_owing_a_reason(&admin, &setup).await;
    let later = planned_on(&admin, &setup, "2026-10-09").await;
    let earlier = planned_on(&admin, &setup, "2026-10-07").await;
    for path in [
        "/v1/office/shifts",
        "/v1/office/shifts?from=2026-10-07&to=2026-10-09",
        "/v1/office/shifts?plannedFrom=2026-10-08&plannedTo=2026-10-08&from=2026-10-01",
    ] {
        let listed = ids(&admin, path).await;
        assert_eq!(
            listed.iter().filter(|id| **id == owing).count(),
            1,
            "{path}"
        );
    }
    assert_eq!(
        ids(&admin, "/v1/office/shifts").await,
        vec![later, owing, earlier]
    );
}

#[tokio::test]
async fn once_the_office_gives_the_reason_an_old_shift_leaves_the_list() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (_, owing) = shift_owing_a_reason(&admin, &setup).await;
    made_on(&admin, &owing, "2026-01-10").await;
    let stale = "/v1/office/shifts?plannedFrom=2020-01-01&plannedTo=2020-01-31";
    assert_eq!(ids(&admin, stale).await, vec![owing.clone()]);
    let path = format!("/v1/office/shifts/{owing}");
    let (_, current) = admin.call("GET", &path, None).await;
    let (status, set) = admin
        .call(
            "PUT",
            &format!("{path}/close-reason"),
            Some(json!({ "reasonCode": "equipment_stop", "expectedRev": current["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{set}");
    assert!(ids(&admin, stale).await.is_empty());
    assert!(!ids(&admin, "/v1/office/shifts").await.contains(&owing));
    // Its own period still lists it, as any closed shift.
    assert_eq!(
        ids(&admin, "/v1/office/shifts?from=2026-01-10&to=2026-01-10").await,
        vec![owing]
    );
}

#[tokio::test]
async fn the_shifts_owing_a_reason_added_stop_at_the_cap_newest_first() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, owing) = shift_owing_a_reason(&admin, &setup).await;
    // 100 more shifts owing a reason, one a day from 2025-01-01, the first the oldest.
    let mut extra = Vec::new();
    for day in 0..100_i64 {
        let date = time::Date::from_calendar_date(2025, time::Month::January, 1).unwrap()
            + time::Duration::days(day);
        let date = date.to_string();
        let shift = planned_on(&admin, &setup, &date).await;
        closed_directly(&admin, &shift, &a.id).await;
        sqlx::query("UPDATE shifts SET close_reason_missing = 1 WHERE id = ?")
            .bind(&shift)
            .execute(&admin.app.state.pool)
            .await
            .unwrap();
        extra.push(shift);
    }
    let listed = ids(
        &admin,
        "/v1/office/shifts?plannedFrom=2020-01-01&plannedTo=2020-01-31",
    )
    .await;
    // 101 owe a reason: the newest 100 are listed, the one of 2025-01-01 is left out.
    assert_eq!(listed.len(), 100);
    assert_eq!(listed.first(), Some(&owing));
    assert!(!listed.contains(&extra[0]));
    assert_eq!(listed.last(), Some(&extra[1]));
}
