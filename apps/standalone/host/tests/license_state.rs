//! The license state over time (plan ЛЦ-2, spec §3.2, §7, §8.2): one
//! `license.state` row of the host and one revision per change, the first
//! look and a quiet hour writing none, the device's line, the start of a site
//! that predates the license, the INN after the profile and the import, a
//! file of another host first seen once, and the PC's clock set back or far
//! ahead.

mod support;

use std::sync::Arc;

use axum::http::StatusCode;
use markiro_host::audit::actions;
use markiro_host::license::trial_mark::NoMark;
use markiro_host::license::{spawn_ticker_every, LicenseService};
use serde_json::{json, Value};
use support::app::{
    admin, audit_trail, cloud_import_request, empty, host_revision, json as json_request, login,
    request, with_device, Admin, AuditRow, TestApp, IMPORT_ID,
};
use support::license::{
    expire, expired_file, file, license_id, load_ok, office_license, refresh, seed, set_org_inn,
    terms, text, DAY_MS, INN, OTHER_INN, START_MS,
};

const OTHER_HOST: &str = "9b2e4f60-1a3c-4d5e-8f70-1a2b3c4d5e6f";

/// A `license.state` row of the host.
fn state_row(license_id: Option<&str>, from: &str, to: &str, at_ms: i64) -> AuditRow {
    (
        "system".to_owned(),
        None,
        actions::LICENSE_STATE.to_owned(),
        Some("license".to_owned()),
        license_id.map(str::to_owned),
        "ok".to_owned(),
        json!({
            "from": from, "to": to, "licenseId": license_id, "effectiveAt": text(at_ms),
            "clockBehindDays": null, "clockAhead": false
        }),
    )
}

/// `GET /v1/office/license` as the host answers it, without a session (an
/// office session ends after 30 idle minutes; these tests move days).
async fn license_now(app: &TestApp) -> Value {
    let license = app
        .state
        .license
        .office_license_now(&app.state)
        .await
        .expect("the license now");
    serde_json::to_value(license).unwrap()
}

async fn device_record(admin: &Admin) -> Value {
    let (status, body) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), &admin.key)))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

/// `license_clock`'s state, its time, the mark and a wrong host's sighting.
async fn clock(app: &TestApp) -> (Option<String>, Option<i64>, Option<i64>, Option<i64>) {
    sqlx::query_as(
        "SELECT last_state, last_state_at, max_seen_at, wrong_host_since \
         FROM license_clock WHERE id = 1",
    )
    .fetch_one(&app.state.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn time_moves_the_state_and_each_change_writes_one_row_and_one_revision() {
    let admin = admin().await;
    let host = admin.app.state.host_id.clone();
    let id = license_id(1);
    load_ok(
        &admin,
        &file(&host, |terms| {
            terms["validUntil"] = json!(START_MS + 90 * DAY_MS);
            terms["graceDays"] = json!(7);
        }),
    )
    .await;
    let mut expected = vec![state_row(Some(&id), "trial", "active", START_MS)];
    let mut at = START_MS;
    let mut from = "active";
    // A 90-day term warns 30 days ahead; 7 days of grace.
    for (days, to) in [(60, "expiring"), (30, "grace"), (7, "restricted")] {
        admin.app.clock.advance(time::Duration::days(days));
        at += days * DAY_MS;
        let rev = host_revision(&admin.app).await;
        refresh(&admin.app).await;
        // The next look finds nothing new.
        refresh(&admin.app).await;
        assert_eq!(host_revision(&admin.app).await, rev + 1, "{to}");
        assert_eq!(license_now(&admin.app).await["state"], to);
        // The change is written with the mark at once.
        assert_eq!(
            clock(&admin.app).await,
            (Some(to.to_owned()), Some(at), Some(at), None)
        );
        expected.push(state_row(Some(&id), from, to, at));
        from = to;
    }
    assert_eq!(
        audit_trail(&admin.app, actions::LICENSE_STATE).await,
        expected
    );
}

#[tokio::test]
async fn the_first_look_and_a_quiet_hour_write_no_row_and_the_mark_moves_hourly() {
    let admin = admin().await;
    // The wizard's look set the state to compare with.
    assert_eq!(
        clock(&admin.app).await,
        (
            Some("trial".to_owned()),
            Some(START_MS),
            Some(START_MS),
            None
        )
    );
    let rev = host_revision(&admin.app).await;
    admin.app.clock.advance(time::Duration::minutes(30));
    refresh(&admin.app).await;
    assert_eq!(clock(&admin.app).await.2, Some(START_MS));
    admin.app.clock.advance(time::Duration::minutes(29));
    refresh(&admin.app).await;
    assert_eq!(clock(&admin.app).await.2, Some(START_MS));
    // An hour exactly since the mark: it moves.
    admin.app.clock.advance(time::Duration::minutes(1));
    refresh(&admin.app).await;
    assert_eq!(clock(&admin.app).await.2, Some(START_MS + 60 * 60_000));
    assert_eq!(host_revision(&admin.app).await, rev);
    assert!(audit_trail(&admin.app, actions::LICENSE_STATE)
        .await
        .is_empty());
}

/// Before the wizard the trial counts from now, so its `since` moves with
/// every look: only the state's word is compared, never its time.
#[tokio::test]
async fn a_since_that_moves_with_the_time_is_no_change() {
    let app = TestApp::new().await;
    refresh(&app).await;
    let first = (Some("trial".to_owned()), Some(START_MS));
    let (state, at, ..) = clock(&app).await;
    assert_eq!((state, at), first);
    let rev = host_revision(&app).await;
    for _ in 0..3 {
        app.clock.advance(time::Duration::hours(2));
        refresh(&app).await;
    }
    assert_eq!(host_revision(&app).await, rev);
    assert!(audit_trail(&app, actions::LICENSE_STATE).await.is_empty());
    // The state and its time stay the first look's; only the mark moved.
    assert_eq!(
        clock(&app).await,
        (first.0, first.1, Some(START_MS + 6 * 60 * 60_000), None)
    );
}

#[tokio::test]
async fn a_device_reads_the_license_with_its_record_and_not_with_its_line() {
    let admin = admin().await;
    assert_eq!(
        device_record(&admin).await["license"],
        json!({
            "state": "trial", "since": text(START_MS),
            "phaseEndsAt": text(START_MS + 14 * DAY_MS), "emergencyUntil": null
        })
    );
    load_ok(&admin, &expired_file(&admin.app.state.host_id)).await;
    // New shifts are closed, the device works on.
    assert_eq!(
        device_record(&admin).await["license"],
        json!({
            "state": "restricted", "since": text(START_MS - DAY_MS),
            "phaseEndsAt": null, "emergencyUntil": null
        })
    );
    let (_, lines) = admin.call("GET", "/v1/office/lines", None).await;
    let (status, moved) = admin
        .app
        .send(json_request(
            with_device(request("PUT", "/v1/device/line"), &admin.key),
            json!({ "lineId": lines[0]["id"] }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert!(moved.get("license").is_none(), "{moved}");
}

/// A stored row the host cannot decode is not used (review of Task 8): the
/// device reads its record with the license of the files before it.
#[tokio::test]
async fn a_device_reads_the_license_without_a_row_it_cannot_decode() {
    let admin = admin().await;
    let mut payload = terms(&admin.app.state.host_id);
    payload["quotas"] = json!("broken");
    seed(&admin.app, &payload).await;
    let record = device_record(&admin).await;
    assert_eq!(
        (record["kind"].clone(), record["license"]["state"].clone()),
        (json!("station"), json!("trial")),
        "{record}"
    );
}

/// A license the host cannot read at all (its clock row is gone) never
/// costs a device its record: it is read without the license line.
#[tokio::test]
async fn a_device_reads_its_record_when_the_license_cannot_be_read() {
    let admin = admin().await;
    sqlx::query("DELETE FROM license_clock")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let record = device_record(&admin).await;
    assert_eq!(
        (record["kind"].clone(), record.get("license")),
        (json!("station"), None),
        "{record}"
    );
}

/// The minute's look (review of Task 8): a phase that ends by time is
/// written without a request, and the look ends when the host stops. The
/// real `start` wires it (`no_secrets_in_logs`, plan Task 14); here it runs
/// every 10 ms, because the host's tokio has no paused time (`test-util`).
#[tokio::test]
async fn the_minute_look_writes_a_change_of_time_and_stops_with_the_host() {
    let admin = admin().await;
    admin.app.clock.advance(time::Duration::days(15));
    let ticker = spawn_ticker_every(
        admin.app.state.clone(),
        admin.app.state.stopping.subscribe(),
        std::time::Duration::from_millis(10),
    );
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while audit_trail(&admin.app, actions::LICENSE_STATE)
        .await
        .is_empty()
    {
        assert!(tokio::time::Instant::now() < deadline, "no look in 10 s");
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(!ticker.is_finished());
    admin.app.state.stopping.send_replace(true);
    tokio::time::timeout(std::time::Duration::from_secs(10), ticker)
        .await
        .expect("the look stops with the host")
        .unwrap();
    assert_eq!(
        audit_trail(&admin.app, actions::LICENSE_STATE).await,
        [state_row(
            None,
            "trial",
            "trial_expired",
            START_MS + 15 * DAY_MS
        )]
    );
}

/// The look that only clears a wrong host's sighting, while the state's
/// word stays the same, still writes it (review of Task 8).
#[tokio::test]
async fn a_sighting_that_ends_while_the_state_stays_is_cleared() {
    let admin = admin().await;
    seed(&admin.app, &terms(OTHER_HOST)).await;
    refresh(&admin.app).await;
    admin.app.clock.advance(time::Duration::days(31));
    refresh(&admin.app).await;
    assert_eq!(
        clock(&admin.app).await,
        (
            Some("restricted".to_owned()),
            Some(START_MS + 31 * DAY_MS),
            Some(START_MS + 31 * DAY_MS),
            Some(START_MS)
        )
    );
    // An own file, ended before the clock's start: still `restricted`, and
    // no file of another host is in force any more.
    let mut own = terms(&admin.app.state.host_id);
    own["licenseId"] = json!(license_id(2));
    own["sequence"] = json!(2);
    expire(&mut own);
    seed(&admin.app, &own).await;
    let rev = host_revision(&admin.app).await;
    refresh(&admin.app).await;
    assert_eq!(
        clock(&admin.app).await,
        (
            Some("restricted".to_owned()),
            Some(START_MS + 31 * DAY_MS),
            Some(START_MS + 31 * DAY_MS),
            None
        )
    );
    assert_eq!(host_revision(&admin.app).await, rev);
    assert_eq!(
        audit_trail(&admin.app, actions::LICENSE_STATE).await.len(),
        2
    );
}

/// A change under a clock set back or far ahead says so in its row
/// (review of Task 8).
#[tokio::test]
async fn a_change_under_a_clock_set_back_names_the_days_behind() {
    let admin = admin().await;
    let app = &admin.app;
    app.clock.advance(time::Duration::days(-2));
    seed(app, &terms(&app.state.host_id)).await;
    refresh(app).await;
    let mut row = state_row(Some(&license_id(1)), "trial", "active", START_MS);
    row.6["clockBehindDays"] = json!(2);
    assert_eq!(audit_trail(app, actions::LICENSE_STATE).await, [row]);
}

#[tokio::test]
async fn a_change_under_a_clock_far_ahead_says_it_is_ahead() {
    let admin = admin().await;
    let app = &admin.app;
    app.clock.move_wall(time::Duration::days(500));
    seed(app, &terms(&app.state.host_id)).await;
    refresh(app).await;
    let mut row = state_row(
        Some(&license_id(1)),
        "trial",
        "active",
        START_MS + 5 * 60_000,
    );
    row.6["clockAhead"] = json!(true);
    assert_eq!(audit_trail(app, actions::LICENSE_STATE).await, [row]);
}

#[tokio::test]
async fn a_site_whose_wizard_ran_before_the_license_starts_its_trial_at_its_first_start() {
    let admin = admin().await;
    sqlx::query(
        "UPDATE license_clock SET trial_started_at = NULL, trial_inn = NULL, last_state = NULL",
    )
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    admin.app.clock.advance(time::Duration::days(100));
    admin.app.state.license.startup(&admin.app.state).await;
    let started = || async {
        sqlx::query_as::<_, (Option<i64>, Option<String>)>(
            "SELECT trial_started_at, trial_inn FROM license_clock WHERE id = 1",
        )
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
    };
    assert_eq!(
        started().await,
        (Some(START_MS + 100 * DAY_MS), Some(INN.to_owned()))
    );
    let license = license_now(&admin.app).await;
    assert_eq!(
        (license["state"].clone(), license["daysLeft"].clone()),
        (json!("trial"), json!(14))
    );
    // A second start moves nothing.
    admin.app.clock.advance(time::Duration::days(1));
    admin.app.state.license.startup(&admin.app.state).await;
    assert_eq!(started().await.0, Some(START_MS + 100 * DAY_MS));
    assert!(audit_trail(&admin.app, actions::LICENSE_STATE)
        .await
        .is_empty());
}

/// A trial start ahead of the trusted time (a PC's clock set ahead at the
/// wizard, then back) is put back to that time once and for all (review of
/// Task 10): days later the trial has counted them, it did not slide.
#[tokio::test]
async fn a_trial_start_ahead_of_the_time_is_put_back_and_stays() {
    let admin = admin().await;
    let trial_start = || async {
        sqlx::query_scalar::<_, Option<i64>>(
            "SELECT trial_started_at FROM license_clock WHERE id = 1",
        )
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
    };
    sqlx::query("UPDATE license_clock SET trial_started_at = ? WHERE id = 1")
        .bind(START_MS + 10 * DAY_MS)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    refresh(&admin.app).await;
    assert_eq!(trial_start().await, Some(START_MS));
    admin.app.clock.advance(time::Duration::days(5));
    refresh(&admin.app).await;
    assert_eq!(trial_start().await, Some(START_MS));
    let license = license_now(&admin.app).await;
    assert_eq!(
        (license["state"].clone(), license["daysLeft"].clone()),
        (json!("trial"), json!(9))
    );
    // A start out of range reads as a trial that is over: never put back
    // to now, which would start a new trial.
    sqlx::query("UPDATE license_clock SET trial_started_at = ? WHERE id = 1")
        .bind(9_007_199_254_740_992_i64)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    refresh(&admin.app).await;
    assert_eq!(trial_start().await, Some(9_007_199_254_740_992));
    assert_eq!(license_now(&admin.app).await["state"], "trial_expired");
}

/// A site before its wizard has no trial to start: the wizard starts it.
#[tokio::test]
async fn a_start_before_the_wizard_starts_no_trial() {
    let app = TestApp::new().await;
    app.state.license.startup(&app.state).await;
    let started: Option<i64> =
        sqlx::query_scalar("SELECT trial_started_at FROM license_clock WHERE id = 1")
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(started, None);
}

#[tokio::test]
async fn an_inn_changed_in_the_profile_closes_new_shifts_until_it_is_put_back() {
    let admin = admin().await;
    let id = license_id(1);
    load_ok(&admin, &file(&admin.app.state.host_id, |_| {})).await;
    set_org_inn(&admin, json!(OTHER_INN)).await;
    let license = office_license(&admin).await;
    assert_eq!(
        (
            license["state"].clone(),
            license["opensNewShifts"].clone(),
            license["binding"]["innMatches"].clone()
        ),
        (json!("inn_mismatch"), json!(false), json!(false))
    );
    set_org_inn(&admin, json!(INN)).await;
    assert_eq!(office_license(&admin).await["state"], "active");
    assert_eq!(
        audit_trail(&admin.app, actions::LICENSE_STATE).await,
        [
            state_row(Some(&id), "trial", "active", START_MS),
            state_row(Some(&id), "active", "inn_mismatch", START_MS),
            state_row(Some(&id), "inn_mismatch", "active", START_MS),
        ]
    );
}

#[tokio::test]
async fn the_trial_keeps_its_start_and_its_inn_when_the_inn_changes() {
    let admin = admin().await;
    set_org_inn(&admin, json!(OTHER_INN)).await;
    let license = office_license(&admin).await;
    assert_eq!(
        (
            license["state"].clone(),
            license["trial"]["startedAt"].clone(),
            license["trial"]["inn"].clone()
        ),
        (json!("trial"), json!(text(START_MS)), json!(INN))
    );
    assert!(audit_trail(&admin.app, actions::LICENSE_STATE)
        .await
        .is_empty());
}

#[tokio::test]
async fn the_cloud_import_keeps_the_inn_and_the_state_and_looks_again() {
    let mut admin = admin().await;
    load_ok(&admin, &file(&admin.app.state.host_id, |_| {})).await;
    admin.app.clock.advance(time::Duration::hours(2));
    admin.token = login(&admin.app, &admin.key, "admin", "correct horse battery").await;
    let (status, summary) = admin
        .call(
            "POST",
            "/v1/office/import",
            Some(cloud_import_request(IMPORT_ID, false)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    let license = office_license(&admin).await;
    assert_eq!(
        (
            license["state"].clone(),
            license["binding"]["orgInn"].clone()
        ),
        (json!("active"), json!(INN))
    );
    assert_eq!(
        audit_trail(&admin.app, actions::LICENSE_STATE).await.len(),
        1
    );
    // The import's look wrote the mark, due after two hours.
    assert_eq!(clock(&admin.app).await.2, Some(START_MS + 2 * 60 * 60_000));
}

/// A file of another host (spec §4.6): its first sighting is written once,
/// so the 30 days count from it across a restart.
#[tokio::test]
async fn a_file_of_another_host_is_first_seen_once_and_its_window_survives_a_restart() {
    let admin = admin().await;
    seed(&admin.app, &terms(OTHER_HOST)).await;
    admin.app.clock.advance(time::Duration::days(1));
    refresh(&admin.app).await;
    let seen = START_MS + DAY_MS;
    assert_eq!(clock(&admin.app).await.3, Some(seen));
    admin.app.clock.advance(time::Duration::days(10));
    refresh(&admin.app).await;
    assert_eq!(clock(&admin.app).await.3, Some(seen));
    assert_eq!(license_now(&admin.app).await["state"], "wrong_host");
    // A start 30 days after the sighting: the window is over.
    admin.app.clock.advance(time::Duration::days(20));
    let started = admin
        .app
        .state
        .clone()
        .with_license(Arc::new(LicenseService::new(
            markiro_proto::trust::license_keyset(),
            Arc::new(NoMark),
        )));
    started.license.startup(&started).await;
    let license = started
        .license
        .office_license_now(&started)
        .await
        .expect("the license now");
    assert_eq!(
        (license.state, license.since),
        ("restricted".to_owned(), text(seen + 30 * DAY_MS))
    );
    assert_eq!(
        audit_trail(&admin.app, actions::LICENSE_STATE).await,
        [
            state_row(
                Some(&license_id(1)),
                "trial",
                "wrong_host",
                START_MS + DAY_MS
            ),
            state_row(
                Some(&license_id(1)),
                "wrong_host",
                "restricted",
                seen + 30 * DAY_MS
            ),
        ]
    );
}

#[tokio::test]
async fn a_clock_set_back_two_days_is_flagged_and_moves_no_time_back() {
    let admin = admin().await;
    admin.app.clock.advance(time::Duration::days(-2));
    let license = office_license(&admin).await;
    assert_eq!(
        (license["flags"].clone(), license["effectiveAt"].clone()),
        (
            json!({ "clockBehindDays": 2, "clockAhead": false }),
            json!(text(START_MS))
        )
    );
}

#[tokio::test]
async fn a_clock_set_far_ahead_while_running_is_flagged_and_not_believed() {
    let admin = admin().await;
    admin.app.clock.move_wall(time::Duration::days(500));
    let license = license_now(&admin.app).await;
    assert_eq!(
        (
            license["flags"].clone(),
            license["effectiveAt"].clone(),
            license["state"].clone()
        ),
        (
            json!({ "clockBehindDays": null, "clockAhead": true }),
            json!(text(START_MS + 5 * 60_000)),
            json!("trial")
        )
    );
}
