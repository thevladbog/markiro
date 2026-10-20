//! Several devices in one shift (plan 2b): stations and a handheld on one line, entering with
//! `multi-station-v1`; the line's limit is set straight in its table (its office route is task 11).

use axum::http::StatusCode;
use serde_json::{json, Value};

use super::app::{
    empty, json as json_request, pair_device, pair_handheld, plan_shift, request, shift_body,
    with_device, Admin, ShiftSetup,
};

pub const MULTI: &str = "multi-station-v1";
pub const HANDHELD: &str = "handheld-host-v1";

/// A device of the line: its id and key.
pub struct Device {
    pub id: String,
    pub key: String,
}

pub async fn call(
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

async fn on_line(admin: &Admin, key: &str, line: &str) {
    let (status, body) = call(
        admin,
        key,
        "PUT",
        "/v1/device/line",
        Some(json!({ "lineId": line })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

/// A new station put on `line`.
pub async fn station_on(admin: &Admin, line: &str) -> Device {
    let (id, key) = pair_device(&admin.app, "station").await;
    on_line(admin, &key, line).await;
    Device { id, key }
}

/// The administrator's own station put on `line`.
pub async fn admin_station_on(admin: &Admin, line: &str) -> Device {
    let (status, info) = call(admin, &admin.key, "GET", "/v1/device", None).await;
    assert_eq!(status, StatusCode::OK, "{info}");
    on_line(admin, &admin.key, line).await;
    Device {
        id: info["id"].as_str().unwrap().to_owned(),
        key: admin.key.clone(),
    }
}

/// A handheld the office put on `line`.
pub async fn handheld_on(admin: &Admin, line: &str) -> Device {
    let key = pair_handheld(admin).await;
    let (status, info) = call(admin, &key, "GET", "/v1/device", None).await;
    assert_eq!(status, StatusCode::OK, "{info}");
    let id = info["id"].as_str().unwrap().to_owned();
    let (status, updated) = admin
        .call(
            "PUT",
            &format!("/v1/office/devices/{id}"),
            Some(json!({ "name": "ТСД 1", "lineId": line })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    Device { id, key }
}

/// Set the line's limit straight in its table.
pub async fn allow(admin: &Admin, line: &str, max_stations: u32) {
    sqlx::query("UPDATE lines SET max_stations = ? WHERE id = ?")
        .bind(max_stations)
        .bind(line)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
}

/// `POST /v1/device/shifts/{shift}/enter` naming `supports`.
pub async fn enter(
    admin: &Admin,
    device: &Device,
    shift: &str,
    supports: &[&str],
) -> (StatusCode, Value) {
    call(
        admin,
        &device.key,
        "POST",
        &format!("/v1/device/shifts/{shift}/enter"),
        Some(json!({ "supports": supports })),
    )
    .await
}

/// `POST /v1/device/shifts/{shift}/leave` (task 7).
pub async fn leave(admin: &Admin, device: &Device, shift: &str) -> (StatusCode, Value) {
    call(
        admin,
        &device.key,
        "POST",
        &format!("/v1/device/shifts/{shift}/leave"),
        None,
    )
    .await
}

/// `POST /v1/device/shifts/{shift}/leave` with a body (the participant token `joinedRev`).
pub async fn leave_with(
    admin: &Admin,
    device: &Device,
    shift: &str,
    body: Value,
) -> (StatusCode, Value) {
    call(
        admin,
        &device.key,
        "POST",
        &format!("/v1/device/shifts/{shift}/leave"),
        Some(body),
    )
    .await
}

/// The `joinedRev` the shift answer names for `device`'s participant row.
pub fn joined_rev(answer: &Value, device: &str) -> Value {
    answer["participants"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["deviceId"] == json!(device)))
        .map(|row| row["joinedRev"].clone())
        .unwrap_or(Value::Null)
}

/// Plan a shift of `body` and open it from `opener` naming `multi-station-v1`; its id and number.
pub async fn open_shared(admin: &Admin, body: Value, opener: &Device) -> (String, String) {
    let shift = plan_shift(admin, body).await;
    let id = shift["id"].as_str().unwrap().to_owned();
    let (status, entered) = enter(admin, opener, &id, &[MULTI]).await;
    assert_eq!(status, StatusCode::OK, "{entered}");
    (id, shift["number"].as_str().unwrap().to_owned())
}

/// Two stations in one shift of `setup`'s first line (limit 2): the administrator's station opens
/// it with the plan `planned`, a minute later a new station joins. The two, the shift and its number.
pub async fn shared(
    admin: &Admin,
    setup: &ShiftSetup,
    planned: Option<u32>,
) -> (Device, Device, String, String) {
    let a = admin_station_on(admin, &setup.line).await;
    let b = station_on(admin, &setup.line).await;
    allow(admin, &setup.line, 2).await;
    let mut body = shift_body(setup);
    if let Some(planned) = planned {
        body["plannedQty"] = json!(planned);
    }
    let (shift, number) = open_shared(admin, body, &a).await;
    admin.app.clock.advance(time::Duration::minutes(1));
    let (status, joined) = enter(admin, &b, &shift, &[MULTI]).await;
    assert_eq!(status, StatusCode::OK, "{joined}");
    (a, b, shift, number)
}

pub fn constraint(body: &Value) -> Value {
    body["error"]["details"]["constraint"].clone()
}

/// A participant's row: state, left_at, closed_by_kind, closed_actual_qty, late_data_at.
pub type ParticipantRow = (
    String,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<String>,
);

pub async fn participant(admin: &Admin, shift: &str, device: &str) -> ParticipantRow {
    sqlx::query_as(
        "SELECT state, left_at, closed_by_kind, closed_actual_qty, late_data_at \
         FROM shift_participants WHERE shift_id = ? AND device_id = ?",
    )
    .bind(shift)
    .bind(device)
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap()
}

pub async fn status_of(admin: &Admin, shift: &str) -> String {
    sqlx::query_scalar("SELECT status FROM shifts WHERE id = ?")
        .bind(shift)
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}
