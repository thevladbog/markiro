//! Edge cases the reviews of plan 2b's host tasks found (tasks 5–11), pinned through the real
//! routes and facts: the device answers of closed and mixed shifts, simultaneous entries for the
//! last slot, the close reason rules of a shared shift, the office's close reason and a line's
//! limit. The test clock is frozen (`TestApp.clock`): it moves only when a test advances it, so
//! a participant's instants are exact; ordering of participants is made unambiguous by advancing
//! it a minute between entries.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    accepted, admin, audit_row, audit_rows, audit_trail, box_closed, box_id, close_from_office,
    fact, host_revision, instant, issue_block, issue_pallet_block, ok_scan, open_floor,
    pallet_closed, pallet_id, pallet_shift_body, pallet_template, receipts, record_id, shift_body,
    shift_closed, shift_setup, Admin,
};
use support::multi::{
    admin_station_on, allow, call, constraint, enter, leave, open_shared, participant, shared,
    station_on, status_of, Device, MULTI,
};

const OPERATOR: &str = "c4a1e2b3-5d6f-4a7b-8c9d-0e1f2a3b4c5d";
const MINUTE: time::Duration = time::Duration::minutes(1);

async fn shift_in_list(admin: &Admin, device: &Device, shift: &str) -> Option<Value> {
    let (status, list) = call(admin, &device.key, "GET", "/v1/device/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    list["shifts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == json!(shift))
        .cloned()
}

fn device_ids(items: &Value) -> Vec<Value> {
    items
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["deviceId"].clone())
        .collect()
}

async fn office_shift(admin: &Admin, shift: &str) -> Value {
    let (status, detail) = admin
        .call("GET", &format!("/v1/office/shifts/{shift}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    detail
}

async fn revoke(admin: &Admin, device: &Device) {
    let (status, revoked) = admin
        .call(
            "POST",
            &format!("/v1/office/devices/{}/revoke", device.id),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{revoked}");
}

// ---------------------------------------------------------------------------------- (a) answers

#[tokio::test]
async fn the_device_answers_name_every_participant_a_stranger_has_no_state_and_a_closed_shift_keeps_them(
) {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    let b = station_on(&admin, &setup.line).await;
    let c = station_on(&admin, &setup.line).await;
    let stranger = station_on(&admin, &setup.line).await;
    allow(&admin, &setup.line, 4).await;
    let mut planned_body = shift_body(&setup);
    planned_body["plannedQty"] = json!(9);
    let (shift, _) = open_shared(&admin, planned_body, &a).await;
    for device in [&b, &c] {
        admin.app.clock.advance(MINUTE);
        let (status, entered) = enter(&admin, device, &shift, &[MULTI]).await;
        assert_eq!(status, StatusCode::OK, "{entered}");
    }
    let (status, left) = leave(&admin, &b, &shift).await;
    assert_eq!(status, StatusCode::OK, "{left}");
    revoke(&admin, &c).await;

    // A second participant, one that left and a revoked one are all named, in entry order.
    let view = shift_in_list(&admin, &a, &shift).await.unwrap();
    assert_eq!(
        device_ids(&view["participants"]),
        vec![json!(a.id), json!(b.id), json!(c.id)]
    );
    assert_eq!(
        view["participants"]
            .as_array()
            .unwrap()
            .iter()
            .map(|part| part["state"].clone())
            .collect::<Vec<_>>(),
        vec![json!("active"), json!("left"), json!("active")]
    );
    assert_eq!(
        device_ids(&view["byDevice"]),
        device_ids(&view["participants"])
    );
    assert_eq!(view["maxStations"], json!(4));
    assert_eq!(view["myState"], json!("active"));
    // The one that left sees itself as left.
    let left_view = shift_in_list(&admin, &b, &shift).await.unwrap();
    assert_eq!(left_view["myState"], json!("left"));

    // A station of the line that never entered sees the open shift whole, but no state of its own.
    let seen = shift_in_list(&admin, &stranger, &shift).await.unwrap();
    assert!(seen["myState"].is_null(), "{seen}");
    assert_eq!(seen["participants"], view["participants"]);
    assert_eq!(seen["byDevice"], view["byDevice"]);
    assert_eq!(seen["maxStations"], json!(4));

    // The office closes the shift: it stays in its participants' lists, closed, with the same
    // fields but the totals; the stranger no longer sees a closed shift of the line.
    close_from_office(&admin, &shift, "Конец смены").await;
    for device in [&a, &b] {
        let closed = shift_in_list(&admin, device, &shift).await.unwrap();
        assert_eq!(
            (closed["status"].clone(), closed["myState"].clone()),
            (json!("closed"), json!("closed"))
        );
        assert_eq!(closed["maxStations"], json!(4));
        assert_eq!(
            device_ids(&closed["participants"]),
            vec![json!(a.id), json!(b.id), json!(c.id)]
        );
        // The list reads totals for an active shift only (final review, finding 1).
        assert!(
            closed.get("byDevice").is_none() && closed.get("totals").is_none(),
            "{closed}"
        );
    }
    assert!(shift_in_list(&admin, &stranger, &shift).await.is_none());
}

#[tokio::test]
async fn the_device_list_carries_totals_for_active_shifts_only_a_closed_one_keeps_its_participation(
) {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    allow(&admin, &setup.line, 2).await;
    let (closed, _) = open_shared(&admin, shift_body(&setup), &a).await;
    close_from_office(&admin, &closed, "Конец смены").await;
    admin.app.clock.advance(MINUTE);
    let (active, _) = open_shared(&admin, shift_body(&setup), &a).await;

    let (status, list) = call(&admin, &a.key, "GET", "/v1/device/shifts", None).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let find = |id: &str| {
        list["shifts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == json!(id))
            .cloned()
            .unwrap()
    };
    let (closed_view, active_view) = (find(&closed), find(&active));
    assert_eq!(closed_view["status"], json!("closed"));
    assert_eq!(closed_view["myState"], json!("closed"));
    assert_eq!(closed_view["maxStations"], json!(2));
    assert_eq!(closed_view["participants"].as_array().unwrap().len(), 1);
    for key in ["totals", "byDevice"] {
        assert!(closed_view.get(key).is_none(), "{key}: {closed_view}");
        assert!(active_view[key].is_object() || active_view[key].is_array());
    }
    assert_eq!(active_view["status"], json!("active"));
    assert_eq!(active_view["myState"], json!("active"));
    assert_eq!(active_view["maxStations"], json!(2));
    assert_eq!(active_view["participants"].as_array().unwrap().len(), 1);
}

// ---------------------------------------------------------------------------------- (b) entry

#[tokio::test]
async fn two_entries_for_the_last_free_slot_let_one_in_and_refuse_the_other() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    let b = station_on(&admin, &setup.line).await;
    let c = station_on(&admin, &setup.line).await;
    allow(&admin, &setup.line, 2).await;
    let (shift, _) = open_shared(&admin, shift_body(&setup), &a).await;
    admin.app.clock.advance(MINUTE);
    let revision = host_revision(&admin.app).await;
    let ((status_b, body_b), (status_c, body_c)) = tokio::join!(
        enter(&admin, &b, &shift, &[MULTI]),
        enter(&admin, &c, &shift, &[MULTI])
    );
    let mut outcomes = vec![(status_b, body_b.clone()), (status_c, body_c.clone())];
    outcomes.sort_by_key(|(status, _)| status.as_u16());
    assert_eq!(outcomes[0].0, StatusCode::OK, "{:?}", outcomes[0].1);
    assert_eq!(outcomes[1].0, StatusCode::CONFLICT, "{:?}", outcomes[1].1);
    assert_eq!(constraint(&outcomes[1].1), json!("shift_line_full"));
    let winner = if status_b == StatusCode::OK { &b } else { &c };
    let joins = audit_trail(&admin.app, "shift.join").await;
    assert_eq!(joins.len(), 1, "{joins:?}");
    assert_eq!(joins[0].1.as_deref(), Some(winner.id.as_str()));
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM shift_participants WHERE shift_id = ?")
            .bind(&shift)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(count, 2);
}

#[tokio::test]
async fn the_legacy_refusal_carries_exactly_the_stage_2a_details() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    let b = station_on(&admin, &setup.line).await;
    allow(&admin, &setup.line, 3).await;
    let (shift, _) = open_shared(&admin, shift_body(&setup), &a).await;
    let (status, refused) = enter(&admin, &b, &shift, &[]).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(
        (
            refused["error"]["code"].clone(),
            refused["error"]["details"].clone()
        ),
        (json!("conflict"), json!({ "constraint": "shift_busy" }))
    );
}

#[tokio::test]
async fn the_opener_is_an_active_participant_from_the_moment_it_opened() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    let opened_at = admin.app.state.timestamp();
    let (shift, _) = open_shared(&admin, shift_body(&setup), &a).await;
    let row: (String, String, Option<String>, String, Option<String>) = sqlx::query_as(
        "SELECT state, first_entered_at, joined_at, device_id, left_at \
         FROM shift_participants WHERE shift_id = ?",
    )
    .bind(&shift)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        row,
        (
            "active".to_owned(),
            opened_at.clone(),
            Some(opened_at),
            a.id.clone(),
            None
        )
    );
}

#[tokio::test]
async fn a_closed_participant_entering_again_reads_the_shift_back_and_writes_nothing() {
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
            shift_closed(None, 0, 0, None, &instant(30, 0)),
        )],
    )
    .await;
    admin.app.clock.advance(MINUTE);
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let before = participant(&admin, &shift, &a.id).await;
    let (status, back) = enter(&admin, &a, &shift, &[MULTI]).await;
    assert_eq!(status, StatusCode::OK, "{back}");
    assert_eq!(back["myState"], json!("closed"));
    assert!(back["snapshot"].is_object());
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(participant(&admin, &shift, &a.id).await, before);
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM shift_participants WHERE shift_id = ?")
            .bind(&shift)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(count, 2);
}

// ---------------------------------------------------------------------------------- (c) close

#[tokio::test]
async fn the_last_closer_gives_the_reason_when_the_whole_shift_misses_the_plan() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, b, shift, _) = shared(&admin, &setup, Some(10)).await;
    receipts(
        &admin.app,
        &a.key,
        &[fact(
            &record_id(1),
            "shift_closed",
            &shift,
            shift_closed(Some(10), 0, 0, None, &instant(50, 0)),
        )],
    )
    .await;
    // B closes last with a reason; the shift-wide 0 misses the plan of 10.
    assert_eq!(
        receipts(
            &admin.app,
            &b.key,
            &[fact(
                &record_id(1),
                "shift_closed",
                &shift,
                shift_closed(Some(10), 0, 0, Some("equipment_stop"), &instant(60, 0)),
            )]
        )
        .await,
        vec![accepted(&record_id(1))]
    );
    let row: (String, Option<String>, bool) = sqlx::query_as(
        "SELECT status, close_reason_code, close_reason_missing FROM shifts WHERE id = ?",
    )
    .bind(&shift)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(
        row,
        (
            "closed".to_owned(),
            Some("equipment_stop".to_owned()),
            false
        )
    );
    let part_reason: Option<String> = sqlx::query_scalar(
        "SELECT closed_reason FROM shift_participants WHERE shift_id = ? AND device_id = ?",
    )
    .bind(&shift)
    .bind(&b.id)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(part_reason.as_deref(), Some("equipment_stop"));
    let detail = office_shift(&admin, &shift).await;
    assert_eq!(detail["closeReasonCode"], json!("equipment_stop"));
    assert!(detail.get("closeReasonMissing").is_none(), "{detail}");
}

#[tokio::test]
async fn a_device_close_after_the_office_closed_a_shared_shift_is_already_closed_not_refused() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, _b, shift, _) = shared(&admin, &setup, Some(5)).await;
    close_from_office(&admin, &shift, "Остановка линии").await;
    let revision = host_revision(&admin.app).await;
    // No reason although its own count (1) differs from the plan (5): the shift is closed already.
    assert_eq!(
        receipts(
            &admin.app,
            &a.key,
            &[fact(
                &record_id(1),
                "shift_closed",
                &shift,
                shift_closed(Some(5), 1, 0, None, &instant(60, 0)),
            )]
        )
        .await,
        vec![json!({
            "id": record_id(1), "outcome": "accepted", "details": { "alreadyClosed": true }
        })]
    );
    assert_eq!(host_revision(&admin.app).await, revision);
    assert_eq!(status_of(&admin, &shift).await, "closed");
}

#[tokio::test]
async fn a_late_fact_stamps_the_only_devices_part_and_the_shift_in_one_revision() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let floor = open_floor(&admin, &setup, &admin.key.clone(), &setup.line).await;
    receipts(
        &admin.app,
        &floor.key,
        &[fact(
            &record_id(1),
            "shift_closed",
            &floor.shift,
            shift_closed(None, 0, 0, None, &instant(30, 0)),
        )],
    )
    .await;
    admin.app.clock.advance(MINUTE * 3);
    let late_at = admin.app.state.timestamp();
    let revision = host_revision(&admin.app).await;
    assert_eq!(
        receipts(
            &admin.app,
            &floor.key,
            &[fact(
                &record_id(2),
                "scan",
                &floor.shift,
                ok_scan(5, &box_id(5), &instant(40, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(2))]
    );
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    let part = participant(&admin, &floor.shift, &floor.station).await;
    assert_eq!(part.4, Some(late_at.clone()));
    let shift_late: Option<String> =
        sqlx::query_scalar("SELECT late_data_at FROM shifts WHERE id = ?")
            .bind(&floor.shift)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(shift_late, Some(late_at));
}

// ---------------------------------------------------------------------------------- (d) office

/// A shared shift of plan 5 both devices closed without a reason: the office owes one.
async fn shift_owing_a_reason(
    admin: &Admin,
    setup: &support::app::ShiftSetup,
) -> (Device, String, String) {
    let (a, b, shift, _) = shared(admin, setup, Some(5)).await;
    let close = fact(
        &record_id(1),
        "shift_closed",
        &shift,
        shift_closed(Some(5), 0, 0, None, &instant(30, 0)),
    );
    receipts(&admin.app, &a.key, &[close.clone()]).await;
    receipts(&admin.app, &b.key, &[close]).await;
    let detail = office_shift(admin, &shift).await;
    assert_eq!(detail["closeReasonMissing"], json!(true));
    let path = format!("/v1/office/shifts/{shift}/close-reason");
    (a, shift, path)
}

#[tokio::test]
async fn only_the_office_gives_a_close_reason_and_only_to_a_shift_that_lacks_one() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (a, shift, path) = shift_owing_a_reason(&admin, &setup).await;
    let detail = office_shift(&admin, &shift).await;
    let body = json!({ "reasonCode": "equipment_stop", "expectedRev": detail["rev"] });
    // A device credential is no office session.
    let (status, refused) = call(&admin, &admin.key, "PUT", &path, Some(body.clone())).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{refused}");
    assert_eq!(refused["error"]["details"]["credential"], "session");
    // An office session the host does not know is refused the same way.
    let (status, unknown_session) = admin
        .call_as("no-such-office-session", "PUT", &path, Some(body.clone()))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{unknown_session}");
    assert_eq!(unknown_session["error"]["details"]["credential"], "session");
    // An unknown shift.
    let missing = "00000000-0000-4000-8000-0000000000aa";
    let (status, unknown) = admin
        .call(
            "PUT",
            &format!("/v1/office/shifts/{missing}/close-reason"),
            Some(body.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{unknown}");
    // A shift still active lacks no reason.
    let (active, _) = open_shared(&admin, shift_body(&setup), &a).await;
    let active_detail = office_shift(&admin, &active).await;
    let (status, refused) = admin
        .call(
            "PUT",
            &format!("/v1/office/shifts/{active}/close-reason"),
            Some(json!({ "reasonCode": "equipment_stop", "expectedRev": active_detail["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(constraint(&refused), json!("close_reason_not_missing"));
    // None of the refusals wrote anything.
    assert!(audit_trail(&admin.app, "shift.close_reason")
        .await
        .is_empty());
    assert_eq!(office_shift(&admin, &shift).await["rev"], detail["rev"]);
    // A technologist plans shifts and may give the reason.
    let (tech_token, tech_id) = admin.technologist_session().await;
    let (status, set) = admin
        .call_as(&tech_token, "PUT", &path, Some(body.clone()))
        .await;
    assert_eq!(status, StatusCode::OK, "{set}");
    assert_eq!(set["closeReasonCode"], json!("equipment_stop"));
    assert_eq!(
        audit_trail(&admin.app, "shift.close_reason").await,
        vec![audit_row(
            &tech_id,
            "shift.close_reason",
            "shift",
            &shift,
            json!({ "reasonCode": "equipment_stop" })
        )]
    );
    // The repeat is refused and changes neither the audit trail nor the host revision.
    let revision = host_revision(&admin.app).await;
    let rows = audit_rows(&admin.app).await;
    let (status, again) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "reasonCode": "equipment_stop", "expectedRev": set["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{again}");
    assert_eq!(constraint(&again), json!("close_reason_not_missing"));
    assert_eq!(audit_trail(&admin.app, "shift.close_reason").await.len(), 1);
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(host_revision(&admin.app).await, revision);
}

#[tokio::test]
async fn a_real_pallet_is_counted_by_its_device_and_a_forced_close_stamps_every_part() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let template = pallet_template(&admin).await;
    let a = admin_station_on(&admin, &setup.line).await;
    let b = station_on(&admin, &setup.line).await;
    allow(&admin, &setup.line, 2).await;
    let (shift, _) = open_shared(&admin, pallet_shift_body(&setup, &template), &a).await;
    admin.app.clock.advance(MINUTE);
    let (status, joined) = enter(&admin, &b, &shift, &[MULTI]).await;
    assert_eq!(status, StatusCode::OK, "{joined}");
    let block = issue_block(&admin.app, &a.key, "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a").await;
    let pallets =
        issue_pallet_block(&admin.app, &a.key, "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c").await;
    let pallet = pallet_id(1);
    let record = |n: u32, kind: &str, data: Value| {
        let mut record = fact(&record_id(n), kind, &shift, data);
        record["operatorId"] = json!(OPERATOR);
        record
    };
    let mut closed_box = box_closed(
        &box_id(1),
        &block,
        1500,
        &[1],
        &instant(1, 0),
        &instant(101, 0),
    );
    closed_box["palletId"] = json!(pallet);
    let batch = [
        record(1, "scan", ok_scan(1, &box_id(1), &instant(1, 0))),
        record(101, "box_closed", closed_box),
        record(
            201,
            "pallet_closed",
            pallet_closed(&pallet, &pallets, 40, 1, &instant(101, 0), &instant(150, 0)),
        ),
    ];
    for answer in receipts(&admin.app, &a.key, &batch).await {
        assert_eq!(answer["outcome"], json!("accepted"), "{answer}");
    }
    // B scans a unit of its own.
    assert_eq!(
        receipts(
            &admin.app,
            &b.key,
            &[fact(
                &record_id(1),
                "scan",
                &shift,
                ok_scan(2, &box_id(2), &instant(5, 0))
            )]
        )
        .await,
        vec![accepted(&record_id(1))]
    );
    let detail = office_shift(&admin, &shift).await;
    let by_device = detail["byDevice"].as_array().unwrap();
    let pallets_of = |device: &str| {
        by_device
            .iter()
            .find(|part| part["deviceId"] == json!(device))
            .unwrap()["pallets"]
            .clone()
    };
    assert_eq!((pallets_of(&a.id), pallets_of(&b.id)), (json!(1), json!(0)));
    let sum: u64 = by_device
        .iter()
        .map(|part| part["pallets"].as_u64().unwrap())
        .sum();
    assert_eq!(
        (sum, detail["totals"]["closedPallets"].clone()),
        (1, json!(1))
    );
    // The devices see the same.
    let view = shift_in_list(&admin, &b, &shift).await.unwrap();
    assert_eq!(view["totals"]["pallets"], json!(1));
    // A forced close closes every part at the shift's own instant.
    admin.app.clock.advance(MINUTE);
    let closed = close_from_office(&admin, &shift, "Конец смены").await;
    let shift_closed_at = closed["closedAt"].clone();
    assert!(shift_closed_at.is_string(), "{closed}");
    let parts = closed["participants"].as_array().unwrap();
    assert_eq!(parts.len(), 2);
    for part in parts {
        assert_eq!(part["closedAt"], shift_closed_at, "{part}");
    }
}

// ---------------------------------------------------------------------------------- (e) lines

async fn line_of(admin: &Admin, id: &str) -> Value {
    let (status, lines) = admin.call("GET", "/v1/office/lines", None).await;
    assert_eq!(status, StatusCode::OK, "{lines}");
    lines
        .as_array()
        .unwrap()
        .iter()
        .find(|line| line["id"] == json!(id))
        .cloned()
        .unwrap()
}

async fn put_line(admin: &Admin, id: &str, mut body: Value) -> (StatusCode, Value) {
    body["expectedRev"] = line_of(admin, id).await["rev"].clone();
    admin
        .call("PUT", &format!("/v1/office/lines/{id}"), Some(body))
        .await
}

#[tokio::test]
async fn a_rename_with_a_limit_change_writes_both_rows_in_one_revision_and_keeps_the_limit() {
    let admin = admin().await;
    let (status, created) = admin
        .call(
            "POST",
            "/v1/office/lines",
            Some(json!({ "name": "Линия 3" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    let revision = host_revision(&admin.app).await;
    let (status, both) =
        put_line(&admin, &id, json!({ "name": "Упаковка", "maxStations": 3 })).await;
    assert_eq!(status, StatusCode::OK, "{both}");
    assert_eq!(
        (
            both["name"].clone(),
            both["maxStations"].clone(),
            both["rev"].clone()
        ),
        (json!("Упаковка"), json!(3), json!(revision + 1))
    );
    assert_eq!(host_revision(&admin.app).await, revision + 1);
    assert_eq!(
        audit_trail(&admin.app, "line.update").await,
        vec![admin.row(
            "line.update",
            "line",
            &id,
            json!({ "changed": ["name"], "name": { "from": "Линия 3", "to": "Упаковка" } })
        )]
    );
    assert_eq!(
        audit_trail(&admin.app, "line.max_stations_changed").await,
        vec![admin.row(
            "line.max_stations_changed",
            "line",
            &id,
            json!({ "from": 1, "to": 3 })
        )]
    );
    // Renaming and archiving leave the limit alone.
    let (status, renamed) = put_line(&admin, &id, json!({ "name": "Розлив" })).await;
    assert_eq!(
        (status, renamed["maxStations"].clone()),
        (StatusCode::OK, json!(3))
    );
    let (status, archived) = put_line(&admin, &id, json!({ "archived": true })).await;
    assert_eq!(
        (
            status,
            archived["maxStations"].clone(),
            archived["archived"].clone()
        ),
        (StatusCode::OK, json!(3), json!(true))
    );
    assert_eq!(line_of(&admin, &id).await["maxStations"], json!(3));
    assert_eq!(
        audit_trail(&admin.app, "line.max_stations_changed")
            .await
            .len(),
        1
    );
}

#[tokio::test]
async fn the_limit_may_drop_to_the_busiest_count_and_ignores_left_and_revoked_participants() {
    let admin = admin().await;
    let setup = shift_setup(&admin).await;
    let (_a, b, shift, _) = shared(&admin, &setup, None).await;
    let (status, raised) = put_line(&admin, &setup.line, json!({ "maxStations": 4 })).await;
    assert_eq!(status, StatusCode::OK, "{raised}");
    let c = station_on(&admin, &setup.line).await;
    admin.app.clock.advance(MINUTE);
    let (status, joined) = enter(&admin, &c, &shift, &[MULTI]).await;
    assert_eq!(status, StatusCode::OK, "{joined}");
    // Three live devices: 3 is still enough, 2 is not.
    let (status, refused) = put_line(&admin, &setup.line, json!({ "maxStations": 2 })).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(
        refused["error"]["details"],
        json!({ "constraint": "line_stations_in_use", "active": 3 })
    );
    let (status, lowered) = put_line(&admin, &setup.line, json!({ "maxStations": 3 })).await;
    assert_eq!(
        (status, lowered["maxStations"].clone()),
        (StatusCode::OK, json!(3))
    );
    // B leaves and C is revoked: only A holds a slot, so the limit may drop to 1.
    let (status, _) = leave(&admin, &b, &shift).await;
    assert_eq!(status, StatusCode::OK);
    revoke(&admin, &c).await;
    let (status, one) = put_line(&admin, &setup.line, json!({ "maxStations": 1 })).await;
    assert_eq!(
        (status, one["maxStations"].clone()),
        (StatusCode::OK, json!(1))
    );
    assert_eq!(
        audit_trail(&admin.app, "line.max_stations_changed").await,
        vec![
            admin.row(
                "line.max_stations_changed",
                "line",
                &setup.line,
                json!({ "from": 2, "to": 4 })
            ),
            admin.row(
                "line.max_stations_changed",
                "line",
                &setup.line,
                json!({ "from": 4, "to": 3 })
            ),
            admin.row(
                "line.max_stations_changed",
                "line",
                &setup.line,
                json!({ "from": 3, "to": 1 })
            ),
        ]
    );
}
