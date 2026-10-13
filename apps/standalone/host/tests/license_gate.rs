//! What a license that ran out closes and what it never does (plan ЛЦ-2,
//! spec §3.3, §3.5): the first entry into a planned shift and a station's
//! new shift are refused without a row or a revision; everything that runs
//! goes on; the emergency extension opens new shifts for 72 hours once per
//! file and once for the trial.

mod support;

use axum::http::StatusCode;
use markiro_host::audit::actions;
use serde_json::{json, Value};
use support::app::{
    accepted, admin, audit_rows, audit_trail, box_id, close_from_office, device_shift_body, empty,
    fact, host_revision, instant, issue_block, json as json_request, login, ok_scan, open_floor,
    pair_device, plan_shift, receipts, record_id, request, shift_body, shift_closed, shift_setup,
    with_device, Admin, AuditRow, Floor, ShiftSetup,
};
use support::license::{
    expire, expired_file, file, license_id, load_ok, office_license, set_org_inn, text, DAY_MS,
    OTHER_INN, START_MS,
};

const REQUEST: &str = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const HOURS_72_MS: i64 = 72 * 60 * 60 * 1000;

async fn device_call(
    admin: &Admin,
    key: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let builder = with_device(request(method, path), key);
    match body {
        Some(body) => admin.app.send(json_request(builder, body)).await,
        None => admin.app.send(empty(builder)).await,
    }
}

async fn put_on_line(admin: &Admin, key: &str, line: &str) {
    let (status, body) = device_call(
        admin,
        key,
        "PUT",
        "/v1/device/line",
        Some(json!({ "lineId": line })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

async fn enter(admin: &Admin, key: &str, shift: &Value) -> (StatusCode, Value) {
    let path = format!("/v1/device/shifts/{}/enter", shift["id"].as_str().unwrap());
    device_call(admin, key, "POST", &path, None).await
}

async fn create(admin: &Admin, key: &str, body: Value) -> (StatusCode, Value) {
    device_call(admin, key, "POST", "/v1/device/shifts", Some(body)).await
}

fn restricted(state: &str, since: i64) -> Value {
    json!({ "constraint": "license_restricted", "state": state, "since": text(since) })
}

fn refusal(body: &Value) -> (Value, Value) {
    (
        body["error"]["code"].clone(),
        body["error"]["details"].clone(),
    )
}

/// The status and owner of the shift `id`, and how many shifts there are.
async fn shifts_state(admin: &Admin, id: &str) -> (String, Option<String>, i64) {
    let (status, owner): (String, Option<String>) =
        sqlx::query_as("SELECT status, owner_device_id FROM shifts WHERE id = ?")
            .bind(id)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shifts")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    (status, owner, count)
}

/// An office session ends after 30 idle minutes: sign the administrator in
/// again after the clock moved hours or days.
async fn sign_in_again(admin: &mut Admin) {
    admin.token = login(&admin.app, &admin.key, "admin", "correct horse battery").await;
}

/// A second station inside an open shift on `setup`'s other line, opened
/// while new shifts still open.
async fn floor_on_other_line(admin: &Admin, setup: &ShiftSetup) -> Floor {
    let (_, key) = pair_device(&admin.app, "station").await;
    open_floor(admin, setup, &key, &setup.other_line).await
}

/// While new shifts are closed in `state` (refused with `expected`): the
/// station's new shift is refused too and none is made; the device reads
/// its record with the state; the owner of `floor`'s open shift enters it
/// again and closes it with a fact.
async fn only_new_shifts_close(
    admin: &Admin,
    setup: &ShiftSetup,
    floor: &Floor,
    state: &str,
    expected: (Value, Value),
) {
    let shifts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shifts")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, body) = create(admin, &admin.key, device_shift_body(setup, REQUEST)).await;
    assert_eq!((status, refusal(&body)), (StatusCode::CONFLICT, expected));
    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shifts")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(after, shifts);
    let (status, device) = device_call(admin, &floor.key, "GET", "/v1/device", None).await;
    assert_eq!(
        (status, device["license"]["state"].clone()),
        (StatusCode::OK, json!(state)),
        "{device}"
    );
    let open = json!({ "id": floor.shift });
    let (status, body) = enter(admin, &floor.key, &open).await;
    assert_eq!(
        (status, body["id"].clone(), body["status"].clone()),
        (StatusCode::OK, json!(floor.shift), json!("active")),
        "{body}"
    );
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[
                fact(
                    &record_id(1),
                    "scan",
                    &floor.shift,
                    ok_scan(1, &box_id(1), &instant(1, 0))
                ),
                fact(
                    &record_id(2),
                    "shift_closed",
                    &floor.shift,
                    shift_closed(None, 1, 0, None, &instant(60, 0))
                ),
            ]
        )
        .await,
        vec![accepted(&record_id(1)), accepted(&record_id(2))]
    );
    let status: String = sqlx::query_scalar("SELECT status FROM shifts WHERE id = ?")
        .bind(&floor.shift)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    assert_eq!(status, "closed");
}

#[tokio::test]
async fn a_planned_shift_does_not_open_and_a_station_creates_none_while_restricted() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    put_on_line(&admin, &admin.key, &setup.line).await;
    load_ok(&admin, &expired_file(&admin.app.state.host_id)).await;
    // Planning is never closed: the plan opens once a file is loaded.
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let id = shift["id"].as_str().unwrap();
    let before = shifts_state(&admin, id).await;
    let rows = audit_rows(&admin.app).await;
    let rev = host_revision(&admin.app).await;
    let expected = (
        json!("conflict"),
        restricted("restricted", START_MS - DAY_MS),
    );
    let (status, body) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(
        (status, refusal(&body)),
        (StatusCode::CONFLICT, expected.clone())
    );
    let (status, body) = create(&admin, &admin.key, device_shift_body(&setup, REQUEST)).await;
    assert_eq!((status, refusal(&body)), (StatusCode::CONFLICT, expected));
    // Nothing written: the shift stays planned without an owner, no shift
    // is made, no row, no revision.
    assert_eq!(before, ("planned".to_owned(), None, before.2));
    assert_eq!(
        (
            shifts_state(&admin, id).await,
            audit_rows(&admin.app).await,
            host_revision(&admin.app).await
        ),
        (before, rows, rev)
    );
    // The device keeps its record and reads why.
    let (status, device) = device_call(&admin, &admin.key, "GET", "/v1/device", None).await;
    assert_eq!(
        (status, device["license"]["state"].clone()),
        (StatusCode::OK, json!("restricted")),
        "{device}"
    );
}

#[tokio::test]
async fn what_runs_goes_on_while_restricted() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key, &setup.line).await;
    let (status, created) = create(&admin, &admin.key, device_shift_body(&setup, REQUEST)).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    load_ok(&admin, &expired_file(&admin.app.state.host_id)).await;
    assert_eq!(office_license(&admin).await["state"], "restricted");
    // The owner enters its open shift again (a station that lost its
    // database): the snapshot comes back, no revision is taken.
    let rev = host_revision(&admin.app).await;
    let open = json!({ "id": floor.shift });
    let (status, body) = enter(&admin, &floor.key, &open).await;
    assert_eq!(
        (status, body["id"].clone(), body["status"].clone()),
        (StatusCode::OK, json!(floor.shift), json!("active")),
        "{body}"
    );
    assert!(body["snapshot"].is_object(), "{body}");
    assert_eq!(host_revision(&admin.app).await, rev);
    // A create retried after a lost answer answers the shift it made.
    let (status, again) = create(&admin, &admin.key, device_shift_body(&setup, REQUEST)).await;
    assert_eq!(
        (status, again["id"].clone()),
        (StatusCode::OK, created["id"].clone())
    );
    // Numbers, facts, the office's plans, close and export, the feed.
    issue_block(
        &admin.app,
        &floor.key,
        "7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2910",
    )
    .await;
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
    plan_shift(&admin, shift_body(&setup)).await;
    close_from_office(&admin, &floor.shift, "Станция не отвечает").await;
    let (status, _) = admin
        .call(
            "GET",
            &format!("/v1/office/shifts/{}/export-source", floor.shift),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = device_call(&admin, &floor.key, "GET", "/v1/changes?since=0", None).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn the_trial_ends_after_fourteen_days_and_closes_the_opening() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = floor_on_other_line(&admin, &setup).await;
    put_on_line(&admin, &admin.key, &setup.line).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    admin.app.clock.advance(time::Duration::days(14));
    let expected = (
        json!("conflict"),
        restricted("trial_expired", START_MS + 14 * DAY_MS),
    );
    let (status, body) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(
        (status, refusal(&body)),
        (StatusCode::CONFLICT, expected.clone())
    );
    only_new_shifts_close(&admin, &setup, &floor, "trial_expired", expected).await;
}

#[tokio::test]
async fn an_inn_that_no_longer_matches_closes_the_opening() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    put_on_line(&admin, &admin.key, &setup.line).await;
    load_ok(&admin, &file(&admin.app.state.host_id, |_| {})).await;
    let floor = floor_on_other_line(&admin, &setup).await;
    set_org_inn(&admin, json!(OTHER_INN)).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    let expected = (json!("conflict"), restricted("inn_mismatch", START_MS));
    let (status, body) = enter(&admin, &admin.key, &shift).await;
    assert_eq!(
        (status, refusal(&body)),
        (StatusCode::CONFLICT, expected.clone())
    );
    only_new_shifts_close(&admin, &setup, &floor, "inn_mismatch", expected).await;
}

#[tokio::test]
async fn the_emergency_opens_new_shifts_for_72_hours_once_per_file() {
    let mut admin = admin().await;
    let host = admin.app.state.host_id.clone();
    let setup = shift_setup(&admin).await;
    put_on_line(&admin, &admin.key, &setup.line).await;
    let rows = audit_rows(&admin.app).await;
    let (status, body) = admin
        .call("POST", "/v1/office/license/emergency", None)
        .await;
    assert_eq!(
        (status, refusal(&body)),
        (
            StatusCode::CONFLICT,
            (
                json!("conflict"),
                json!({ "constraint": "emergency_not_needed" })
            )
        )
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    load_ok(&admin, &expired_file(&host)).await;
    let tech = admin.technologist().await;
    let (status, _) = admin
        .call_as(&tech, "POST", "/v1/office/license/emergency", None)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(audit_trail(&admin.app, actions::LICENSE_EMERGENCY)
        .await
        .is_empty());
    let rev = host_revision(&admin.app).await;
    let mut wake = admin.app.state.revisions.subscribe();
    let (status, body) = admin
        .call("POST", "/v1/office/license/emergency", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let until = text(START_MS + HOURS_72_MS);
    assert_eq!(
        (
            body["state"].clone(),
            body["opensNewShifts"].clone(),
            body["emergency"].clone()
        ),
        (
            json!("restricted"),
            json!(true),
            json!({ "available": false, "until": until })
        )
    );
    assert_eq!(host_revision(&admin.app).await, rev + 1);
    // The revision wakes the streams, so stations read `GET /v1/device`.
    assert_eq!(*wake.borrow_and_update(), rev + 1);
    assert_eq!(
        audit_trail(&admin.app, actions::LICENSE_EMERGENCY).await,
        [admin.row(
            actions::LICENSE_EMERGENCY,
            "license",
            &license_id(1),
            json!({ "until": until, "licenseId": license_id(1) })
        )]
    );
    // The station sees it before it asks, and opens.
    let (_, device) = device_call(&admin, &admin.key, "GET", "/v1/device", None).await;
    assert_eq!(
        (
            device["license"]["state"].clone(),
            device["license"]["emergencyUntil"].clone()
        ),
        (json!("restricted"), json!(until))
    );
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    assert_eq!(enter(&admin, &admin.key, &shift).await.0, StatusCode::OK);
    // Once per file: `emergency_used` comes first, even while it runs and
    // new shifts open.
    let rows = audit_rows(&admin.app).await;
    let (status, body) = admin
        .call("POST", "/v1/office/license/emergency", None)
        .await;
    assert_eq!(
        (status, refusal(&body)),
        (
            StatusCode::CONFLICT,
            (json!("conflict"), json!({ "constraint": "emergency_used" }))
        )
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    // After 72 hours new shifts close again.
    admin.app.clock.advance(time::Duration::hours(72));
    sign_in_again(&mut admin).await;
    let (_, other_key) = pair_device(&admin.app, "station").await;
    put_on_line(&admin, &other_key, &setup.other_line).await;
    let mut body = shift_body(&setup);
    body["lineId"] = json!(setup.other_line);
    let other = plan_shift(&admin, body).await;
    assert_eq!(
        enter(&admin, &other_key, &other).await.0,
        StatusCode::CONFLICT
    );
    let (status, body) = admin
        .call("POST", "/v1/office/license/emergency", None)
        .await;
    assert_eq!(
        (status, body["error"]["details"]["constraint"].clone()),
        (StatusCode::CONFLICT, json!("emergency_used"))
    );
    // A newer file, expired too, has an emergency of its own.
    load_ok(
        &admin,
        &file(&host, |terms| {
            expire(terms);
            terms["licenseId"] = json!(license_id(2));
            terms["sequence"] = json!(2);
        }),
    )
    .await;
    let (status, body) = admin
        .call("POST", "/v1/office/license/emergency", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["emergency"]["until"], text(START_MS + 2 * HOURS_72_MS));
    assert_eq!(enter(&admin, &other_key, &other).await.0, StatusCode::OK);
}

#[tokio::test]
async fn the_trials_emergency_is_its_own() {
    let mut admin = admin().await;
    let setup = shift_setup(&admin).await;
    put_on_line(&admin, &admin.key, &setup.line).await;
    let shift = plan_shift(&admin, shift_body(&setup)).await;
    admin.app.clock.advance(time::Duration::days(14));
    sign_in_again(&mut admin).await;
    let (status, body) = admin
        .call("POST", "/v1/office/license/emergency", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let until = text(START_MS + 14 * DAY_MS + HOURS_72_MS);
    assert_eq!(
        (
            body["state"].clone(),
            body["opensNewShifts"].clone(),
            body["emergency"].clone()
        ),
        (
            json!("trial_expired"),
            json!(true),
            json!({ "available": false, "until": until })
        )
    );
    let row: AuditRow = (
        "office_user".to_owned(),
        Some(admin.id.clone()),
        actions::LICENSE_EMERGENCY.to_owned(),
        Some("license".to_owned()),
        None,
        "ok".to_owned(),
        json!({ "until": until, "licenseId": "trial" }),
    );
    assert_eq!(
        audit_trail(&admin.app, actions::LICENSE_EMERGENCY).await,
        [row]
    );
    assert_eq!(enter(&admin, &admin.key, &shift).await.0, StatusCode::OK);
}

/// The extension's columns as stored.
async fn emergency_columns(admin: &Admin) -> (Option<String>, Option<i64>) {
    sqlx::query_as("SELECT emergency_used_for, emergency_until FROM license_clock WHERE id = 1")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn an_extension_without_the_clock_row_stores_nothing() {
    let admin = admin().await;
    sqlx::query("DELETE FROM license_clock")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let mut conn = admin.app.state.pool.acquire().await.unwrap();
    assert!(
        markiro_host::license::store::set_emergency(&mut conn, "trial", START_MS)
            .await
            .is_err(),
        "an update of no row is no extension"
    );
}

#[tokio::test]
async fn an_extension_that_stored_nothing_answers_500_without_a_row_or_a_revision() {
    let admin = admin().await;
    load_ok(&admin, &expired_file(&admin.app.state.host_id)).await;
    // The update of the clock's row changes no row.
    sqlx::query(
        "CREATE TRIGGER keep_the_clock BEFORE UPDATE ON license_clock \
         WHEN NEW.emergency_used_for IS NOT NULL BEGIN SELECT RAISE(IGNORE); END",
    )
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    let rows = audit_rows(&admin.app).await;
    let rev = host_revision(&admin.app).await;
    let (status, body) = admin
        .call("POST", "/v1/office/license/emergency", None)
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::INTERNAL_SERVER_ERROR, json!("internal")),
        "{body}"
    );
    assert_eq!(
        (
            audit_rows(&admin.app).await,
            host_revision(&admin.app).await,
            emergency_columns(&admin).await
        ),
        (rows, rev, (None, None))
    );
}

#[tokio::test]
async fn an_extension_kept_answers_from_what_it_knew_when_the_read_after_fails() {
    let admin = admin().await;
    load_ok(&admin, &expired_file(&admin.app.state.host_id)).await;
    // The read after the commit fails: the clock's row is gone with the
    // extension's write.
    sqlx::query(
        "CREATE TRIGGER lose_the_clock AFTER UPDATE ON license_clock \
         WHEN NEW.emergency_used_for IS NOT NULL BEGIN DELETE FROM license_clock; END",
    )
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    let rev = host_revision(&admin.app).await;
    let (status, body) = admin
        .call("POST", "/v1/office/license/emergency", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let until = text(START_MS + HOURS_72_MS);
    assert_eq!(
        (
            body["state"].clone(),
            body["opensNewShifts"].clone(),
            body["emergency"].clone(),
            body["license"]["licenseId"].clone()
        ),
        (
            json!("restricted"),
            json!(true),
            json!({ "available": false, "until": until }),
            json!(license_id(1))
        )
    );
    // The extension was committed with its row and its revision.
    assert_eq!(host_revision(&admin.app).await, rev + 1);
    assert_eq!(
        audit_trail(&admin.app, actions::LICENSE_EMERGENCY).await,
        [admin.row(
            actions::LICENSE_EMERGENCY,
            "license",
            &license_id(1),
            json!({ "until": until, "licenseId": license_id(1) })
        )]
    );
}
