//! A handheld paired again with the same `deviceId` (plan ТСД-Х, task Х6, spec 6.6): the office
//! issues a code for one device; the claim with `recoverDeviceId` gives that device a new key and
//! ends the old one, takes no new seat and writes the audit rows exactly.

mod support;

use axum::http::StatusCode;
use markiro_host::auth::AuthDevice;
use markiro_proto::DeviceKind;
use serde_json::{json, Value};
use support::app::{
    admin, audit_trail, empty, json as json_request, login, pair_device, pair_handheld, request,
    with_device, Admin, LAN,
};

async fn device_id(admin: &Admin, key: &str) -> String {
    let (status, info) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), key)))
        .await;
    assert_eq!(status, StatusCode::OK, "{info}");
    info["id"].as_str().unwrap().to_owned()
}

async fn code_for(admin: &Admin, device: &str) -> (StatusCode, Value) {
    admin
        .call(
            "POST",
            &format!("/v1/office/devices/{device}/pairing-code"),
            None,
        )
        .await
}

async fn claim(
    admin: &Admin,
    code: &Value,
    kind: &str,
    recover: Option<&str>,
) -> (StatusCode, Value) {
    let mut body = json!({
        "code": code, "kind": kind, "name": "Другое имя", "appVersion": "1.3.0",
        "capabilities": ["handheld-host-v1"]
    });
    if let Some(recover) = recover {
        body["recoverDeviceId"] = json!(recover);
    }
    admin
        .app
        .send_from(
            LAN,
            json_request(request("POST", "/v1/pairing/claim"), body),
        )
        .await
}

async fn live_devices(admin: &Admin) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM devices WHERE revoked_at IS NULL")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_code_for_a_device_gives_it_a_new_key_and_ends_the_old_one() {
    let admin = admin().await;
    let old = pair_handheld(&admin).await;
    let id = device_id(&admin, &old).await;
    let devices = live_devices(&admin).await;
    let (status, code) = code_for(&admin, &id).await;
    assert_eq!(status, StatusCode::OK, "{code}");
    assert_eq!(code["code"].as_str().unwrap().len(), 10);
    assert!(code["payload"]
        .as_str()
        .unwrap()
        .starts_with("markiro-host:1?"));

    let (status, paired) = claim(&admin, &code["code"], "handheld", Some(&id)).await;
    assert_eq!(status, StatusCode::OK, "{paired}");
    assert_eq!(paired["deviceId"], json!(id));
    assert_eq!(paired["hostId"], json!(admin.app.state.host_id));
    let new = paired["deviceKey"].as_str().unwrap().to_owned();
    assert_ne!(new, old);
    // The old key is dead at once; the new one is the same device, same name and no new seat.
    let (status, refused) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), &old)))
        .await;
    assert_eq!(
        (status, refused["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("device"))
    );
    let (status, info) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), &new)))
        .await;
    assert_eq!(
        (status, info["id"].clone(), info["name"].clone()),
        (StatusCode::OK, json!(id), json!("ТСД 1"))
    );
    assert_eq!(live_devices(&admin).await, devices);
    // The stored record took the new app's version and capabilities.
    let (version, capabilities): (String, String) =
        sqlx::query_as("SELECT app_version, capabilities FROM devices WHERE id = ?")
            .bind(&id)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(
        (version.as_str(), capabilities.as_str()),
        ("1.3.0", r#"["handheld-host-v1"]"#)
    );
    // The code is spent.
    let (status, again) = claim(&admin, &code["code"], "handheld", Some(&id)).await;
    assert_eq!(
        (status, again["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("pairing_code_invalid"))
    );

    // The trail (design 6.6): the re-keying is the office's act, the administrator who made the
    // code, on the device as its target; the code's creation names the device.
    let rekey = audit_trail(&admin.app, "device.rekey").await;
    assert_eq!(rekey.len(), 1);
    assert_eq!(
        (
            &rekey[0].0[..],
            rekey[0].1.as_deref(),
            rekey[0].3.as_deref(),
            rekey[0].4.as_deref(),
            &rekey[0].5[..]
        ),
        (
            "office_user",
            Some(admin.id.as_str()),
            Some("device"),
            Some(id.as_str()),
            "ok"
        )
    );
    assert_eq!(rekey[0].6["kind"], json!("handheld"));
    assert_eq!(rekey[0].6["address"], json!("192.168.1.20"));
    let created = audit_trail(&admin.app, "pairing_code.create").await;
    assert_eq!(created.last().unwrap().6["deviceId"], json!(id));
}

#[tokio::test]
async fn a_code_works_only_for_its_own_device_and_a_wrong_use_does_not_burn_it() {
    let admin = admin().await;
    let first = pair_handheld(&admin).await;
    let second = pair_handheld(&admin).await;
    let (first_id, second_id) = (
        device_id(&admin, &first).await,
        device_id(&admin, &second).await,
    );
    let (_, code) = code_for(&admin, &first_id).await;
    let invalid = |answer: (StatusCode, Value)| (answer.0, answer.1["error"]["code"].clone());
    let refused = (StatusCode::BAD_REQUEST, json!("pairing_code_invalid"));
    // Another device's id, no id, and a different kind: all refused, the code stays whole.
    assert_eq!(
        invalid(claim(&admin, &code["code"], "handheld", Some(&second_id)).await),
        refused
    );
    assert_eq!(
        invalid(claim(&admin, &code["code"], "handheld", None).await),
        refused
    );
    assert_eq!(
        invalid(claim(&admin, &code["code"], "station", Some(&first_id)).await),
        refused
    );
    let (used, failed): (Option<String>, i64) = sqlx::query_as(
        "SELECT used_at, failed_attempts FROM pairing_codes WHERE device_id IS NOT NULL",
    )
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!((used, failed), (None, 0));
    let denied: Vec<_> = audit_trail(&admin.app, "device.claim")
        .await
        .into_iter()
        .filter(|row| row.5 == "denied")
        .collect();
    assert_eq!(denied.len(), 3);
    assert!(denied
        .iter()
        .all(|row| row.6["reason"] == json!("recovery_mismatch")));
    // A plain code never re-keys a device.
    let (_, plain) = admin.call("POST", "/v1/office/pairing-codes", None).await;
    assert_eq!(
        invalid(claim(&admin, &plain["code"], "handheld", Some(&first_id)).await),
        refused
    );
    // …and the right claim still works.
    let (status, paired) = claim(&admin, &code["code"], "handheld", Some(&first_id)).await;
    assert_eq!(
        (status, paired["deviceId"].clone()),
        (StatusCode::OK, json!(first_id))
    );
}

#[tokio::test]
async fn only_a_live_station_or_handheld_gets_a_code_and_only_an_administrator_asks() {
    let admin = admin().await;
    let key = pair_handheld(&admin).await;
    let id = device_id(&admin, &key).await;
    let (_, office) = pair_device(&admin.app, "office").await;
    let office_id = device_id(&admin, &office).await;
    let (status, refused) = code_for(&admin, &office_id).await;
    assert_eq!(
        (status, refused["error"]["details"]["field"].clone()),
        (StatusCode::BAD_REQUEST, json!("id"))
    );
    let (status, missing) = code_for(&admin, "00000000-0000-4000-8000-0000000000aa").await;
    assert_eq!(
        (status, missing["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    // A device revoked after the code was made is refused at the claim.
    let (_, code) = code_for(&admin, &id).await;
    let (status, revoked) = admin
        .call("POST", &format!("/v1/office/devices/{id}/revoke"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{revoked}");
    let (status, refused) = claim(&admin, &code["code"], "handheld", Some(&id)).await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("pairing_code_invalid"))
    );
    let (status, missing) = code_for(&admin, &id).await;
    assert_eq!(
        (status, missing["error"]["code"].clone()),
        (StatusCode::NOT_FOUND, json!("not_found"))
    );
    // A technologist is not an administrator.
    let technologist = admin.technologist().await;
    let (status, forbidden) = admin
        .call_as(
            &technologist,
            "POST",
            &format!("/v1/office/devices/{id}/pairing-code"),
            None,
        )
        .await;
    assert_eq!(
        (status, forbidden["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
}

#[tokio::test]
async fn a_station_paired_again_loses_its_office_sessions() {
    let admin = admin().await;
    let (station_id, station_key) = pair_device(&admin.app, "station").await;
    let token = login(&admin.app, &station_key, "admin", "correct horse battery").await;
    let (status, _) = admin
        .app
        .send(empty(support::app::with_session(
            request("GET", "/v1/office/me"),
            &station_key,
            &token,
        )))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, code) = code_for(&admin, &station_id).await;
    let (status, paired) = claim(&admin, &code["code"], "station", Some(&station_id)).await;
    assert_eq!(status, StatusCode::OK, "{paired}");
    assert_ne!(paired["deviceKey"].as_str().unwrap(), station_key);
    let sessions: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM office_sessions WHERE device_id = ?")
            .bind(&station_id)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(sessions, 0, "the session ended with the old key");
}

#[tokio::test]
async fn a_full_seat_pool_still_lets_a_device_pair_again_and_an_expired_code_re_keys_nothing() {
    use support::license::{file, load_ok};
    let admin = admin().await;
    let host = admin.app.state.host_id.clone();
    let key = pair_handheld(&admin).await;
    let id = device_id(&admin, &key).await;
    // One station seat in the file, and the handheld already holds it.
    load_ok(
        &admin,
        &file(&host, |terms| terms["quotas"]["stations"] = json!(1)),
    )
    .await;
    let (_, code) = code_for(&admin, &id).await;
    let (status, paired) = claim(&admin, &code["code"], "handheld", Some(&id)).await;
    assert_eq!(
        (status, paired["deviceId"].clone()),
        (StatusCode::OK, json!(id)),
        "{paired}"
    );
    assert_eq!(
        live_devices(&admin).await,
        2,
        "this station and the handheld; no new seat"
    );
    // An expired code re-keys nothing.
    let (_, code) = code_for(&admin, &id).await;
    admin.app.clock.advance(time::Duration::minutes(11));
    let (status, expired) = claim(&admin, &code["code"], "handheld", Some(&id)).await;
    assert_eq!(
        (status, expired["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("pairing_code_expired"))
    );
    assert_eq!(audit_trail(&admin.app, "device.rekey").await.len(), 1);
}

#[tokio::test]
async fn a_recovery_id_that_is_not_a_uuid_is_a_validation_error_and_changes_nothing() {
    let admin = admin().await;
    let key = pair_handheld(&admin).await;
    let id = device_id(&admin, &key).await;
    let (_, code) = code_for(&admin, &id).await;
    let (status, refused) = claim(&admin, &code["code"], "handheld", Some("not-a-uuid")).await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("validation_failed")),
        "{refused}"
    );
    let (status, _) = admin
        .app
        .send(empty(with_device(request("GET", "/v1/device"), &key)))
        .await;
    assert_eq!(status, StatusCode::OK, "the old key still works");
}

#[tokio::test]
async fn a_new_code_for_a_device_ends_the_old_one_and_a_recovery_ends_every_other() {
    let admin = admin().await;
    let old = pair_handheld(&admin).await;
    let id = device_id(&admin, &old).await;
    let (_, first) = code_for(&admin, &id).await;
    let (_, second) = code_for(&admin, &id).await;
    // The first code was replaced by the second one: it is not a second way in.
    let (status, refused) = claim(&admin, &first["code"], "handheld", Some(&id)).await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("pairing_code_expired"))
    );
    // A code that still lives for the device (made some other way) dies with the recovery.
    sqlx::query(
        "INSERT INTO pairing_codes (id, code_hash, created_by, created_at, expires_at, device_id) \
         SELECT '99999999-9999-4999-8999-999999999999', 'x' || substr(code_hash, 2), created_by, \
         created_at, '2999-01-01T00:00:00Z', device_id FROM pairing_codes WHERE device_id = ? LIMIT 1",
    )
    .bind(&id)
    .execute(&admin.app.state.pool)
    .await
    .unwrap();
    let (status, paired) = claim(&admin, &second["code"], "handheld", Some(&id)).await;
    assert_eq!(status, StatusCode::OK, "{paired}");
    let live: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pairing_codes WHERE device_id = ? AND used_at IS NULL AND expires_at > ?",
    )
    .bind(&id)
    .bind(admin.app.state.timestamp())
    .fetch_one(&admin.app.state.pool)
    .await
    .unwrap();
    assert_eq!(live, 0, "no code for the device outlives its recovery");
}

#[tokio::test]
async fn a_request_authenticated_with_the_old_key_stops_when_the_key_was_rotated() {
    let admin = admin().await;
    let old = pair_handheld(&admin).await;
    let id = device_id(&admin, &old).await;
    let (_, code) = code_for(&admin, &id).await;
    let (status, paired) = claim(&admin, &code["code"], "handheld", Some(&id)).await;
    assert_eq!(status, StatusCode::OK, "{paired}");
    let mut conn = admin.app.state.pool.acquire().await.unwrap();
    let stale = AuthDevice {
        dataset_guard: None,
        id: id.clone(),
        kind: DeviceKind::Handheld,
        key_hash: Some(markiro_host::secrets::key_hash(&old)),
    };
    // The extractor read the old key before the rotation committed; the write must not follow.
    let error = stale.require_live_in(&mut conn).await.unwrap_err();
    assert_eq!(error.status(), StatusCode::UNAUTHORIZED);
    let current = AuthDevice {
        dataset_guard: None,
        key_hash: Some(markiro_host::secrets::key_hash(
            paired["deviceKey"].as_str().unwrap(),
        )),
        ..stale
    };
    assert_eq!(
        current.require_live_in(&mut conn).await.unwrap(),
        DeviceKind::Handheld
    );
}
