//! The license's seats (plan ЛЦ-2, spec §4.7): stations and handhelds share
//! the `stations` pool, office users and lines have their own; an addition
//! beyond the file is refused without a row, and nothing that runs is ever
//! disconnected, not even over the limit.

mod support;

use axum::http::StatusCode;
use serde_json::{json, Value};
use support::app::{
    admin, audit_rows, cloud_import_request, empty, host_revision, json as json_request,
    pair_device, request, with_device, Admin, IMPORT_ID,
};
use support::license::{claim_device, expired_file, file, load_ok, office_license, pairing_code};

fn quota(host: &str, key: &str, limit: u32) -> String {
    file(host, |terms| terms["quotas"][key] = json!(limit))
}

fn seat_limit(quota: &str, used: u32, limit: u32) -> Value {
    json!({ "constraint": "seat_limit", "quota": quota, "used": used, "limit": limit })
}

async fn local_pair(admin: &Admin, kind: &str) -> (StatusCode, Value) {
    admin
        .app
        .send(json_request(
            request("POST", "/v1/local-pair"),
            json!({ "kind": kind, "name": "Ещё устройство", "appVersion": "0.1.0" }),
        ))
        .await
}

fn refused_with(answer: &(StatusCode, Value)) -> (StatusCode, Value) {
    (answer.0, answer.1["error"]["details"].clone())
}

async fn devices(admin: &Admin) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM devices")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

/// The code's use and its failed attempts.
async fn code_row(admin: &Admin, code: &Value) -> (Option<String>, i64) {
    sqlx::query_as("SELECT used_at, failed_attempts FROM pairing_codes WHERE id = ?")
        .bind(code["id"].as_str().unwrap())
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn stations_and_handhelds_share_the_stations_pool_and_a_refused_device_keeps_its_code() {
    let admin = admin().await;
    let host = admin.app.state.host_id.clone();
    load_ok(&admin, &quota(&host, "stations", 3)).await;
    assert_eq!(local_pair(&admin, "station").await.0, StatusCode::OK);
    let code = pairing_code(&admin).await;
    let (status, handheld) = claim_device(&admin, &code, "handheld").await;
    assert_eq!(status, StatusCode::OK, "{handheld}");
    let rows = audit_rows(&admin.app).await;
    let paired = devices(&admin).await;
    assert_eq!(
        refused_with(&local_pair(&admin, "station").await),
        (StatusCode::CONFLICT, seat_limit("stations", 3, 3))
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    // An office PC takes no seat: its seats are its users.
    assert_eq!(local_pair(&admin, "office").await.0, StatusCode::OK);
    let code = pairing_code(&admin).await;
    let rows = audit_rows(&admin.app).await;
    let paired = paired + 1;
    for kind in ["station", "handheld"] {
        assert_eq!(
            refused_with(&claim_device(&admin, &code, kind).await),
            (StatusCode::CONFLICT, seat_limit("stations", 3, 3)),
            "{kind}"
        );
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
    assert_eq!(devices(&admin).await, paired);
    // The refused claims did not use the code up (plan Д9).
    assert_eq!(code_row(&admin, &code).await, (None, 0));
    // Revoking a device frees its seat at once; the refused claim kept the code.
    let revoke = format!(
        "/v1/office/devices/{}/revoke",
        handheld["deviceId"].as_str().unwrap()
    );
    assert_eq!(admin.call("POST", &revoke, None).await.0, StatusCode::OK);
    let (status, body) = claim_device(&admin, &code, "station").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // Full again: an office PC still claims a code.
    let code = pairing_code(&admin).await;
    let (status, body) = claim_device(&admin, &code, "office").await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

/// The code is checked before the seat (plan Д9): a wrong code is refused
/// as such, with its `denied` row and its attempt counted, seats or not.
#[tokio::test]
async fn a_wrong_code_is_refused_as_wrong_when_the_seats_are_full() {
    let admin = admin().await;
    load_ok(&admin, &quota(&admin.app.state.host_id, "stations", 1)).await;
    let code = pairing_code(&admin).await;
    let rows = audit_rows(&admin.app).await;
    let (status, body) = claim_device(&admin, &json!({ "code": "0000-0000" }), "station").await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("pairing_code_invalid")),
        "{body}"
    );
    assert_eq!(audit_rows(&admin.app).await, rows + 1);
    assert_eq!(code_row(&admin, &code).await, (None, 1));
}

#[tokio::test]
async fn the_trial_and_a_quota_of_null_limit_nothing() {
    let admin = admin().await;
    for _ in 0..4 {
        assert_eq!(local_pair(&admin, "station").await.0, StatusCode::OK);
    }
    load_ok(&admin, &file(&admin.app.state.host_id, |_| {})).await;
    assert_eq!(local_pair(&admin, "station").await.0, StatusCode::OK);
    assert_eq!(
        office_license(&admin).await["quotas"]["stations"],
        json!({ "limit": null, "used": 6, "over": false })
    );
}

/// Pairing is closed by the quotas only, never by the state (spec §3.3):
/// a license that ran out still pairs a device.
#[tokio::test]
async fn a_license_that_ran_out_still_pairs_within_its_seats() {
    let admin = admin().await;
    load_ok(&admin, &expired_file(&admin.app.state.host_id)).await;
    assert_eq!(office_license(&admin).await["state"], "restricted");
    assert_eq!(local_pair(&admin, "station").await.0, StatusCode::OK);
    let code = pairing_code(&admin).await;
    let (status, body) = claim_device(&admin, &code, "handheld").await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn a_smaller_file_flags_the_quota_and_disconnects_nothing() {
    let admin = admin().await;
    let (_, second) = pair_device(&admin.app, "station").await;
    let (_, third) = pair_device(&admin.app, "station").await;
    let body = load_ok(&admin, &quota(&admin.app.state.host_id, "stations", 1)).await;
    assert_eq!(body["warnings"], json!(["over_limit"]));
    assert_eq!(
        body["quotas"]["stations"],
        json!({ "limit": 1, "used": 3, "over": true })
    );
    for key in [admin.key.as_str(), second.as_str(), third.as_str()] {
        for path in ["/v1/device", "/v1/changes?since=0"] {
            let (status, answer) = admin
                .app
                .send(empty(with_device(request("GET", path), key)))
                .await;
            assert_eq!(status, StatusCode::OK, "{path}: {answer}");
        }
    }
    assert_eq!(
        refused_with(&local_pair(&admin, "station").await),
        (StatusCode::CONFLICT, seat_limit("stations", 3, 1))
    );
}

#[tokio::test]
async fn office_users_and_their_return_take_cabinet_seats() {
    let admin = admin().await;
    load_ok(&admin, &quota(&admin.app.state.host_id, "cabinetUsers", 2)).await;
    let create = |login: &str| {
        json!({
            "login": login, "name": "Павел Орлов", "role": "technologist",
            "password": "technologist password"
        })
    };
    let (status, first) = admin
        .call("POST", "/v1/office/users", Some(create("first")))
        .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let rows = audit_rows(&admin.app).await;
    let rev = host_revision(&admin.app).await;
    assert_eq!(
        refused_with(
            &admin
                .call("POST", "/v1/office/users", Some(create("second")))
                .await
        ),
        (StatusCode::CONFLICT, seat_limit("cabinetUsers", 2, 2))
    );
    assert_eq!(
        (
            audit_rows(&admin.app).await,
            host_revision(&admin.app).await
        ),
        (rows, rev)
    );
    let path = format!("/v1/office/users/{}", first["id"].as_str().unwrap());
    let update = |user: &Value, active: bool, name: &str| json!({ "name": name, "role": "technologist", "active": active, "expectedRev": user["rev"] });
    // A rename of a user who stays on takes none, even when every seat is taken.
    let (status, first) = admin
        .call("PUT", &path, Some(update(&first, true, "Павел Орлов")))
        .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let (status, first) = admin
        .call(
            "PUT",
            &path,
            Some(update(&first, true, "Павел Орлов-Смирнов")),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    // Turning one off frees its seat; turning it on again takes one.
    let (status, first) = admin
        .call("PUT", &path, Some(update(&first, false, "Павел Орлов")))
        .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let (status, second) = admin
        .call("POST", "/v1/office/users", Some(create("second")))
        .await;
    assert_eq!(status, StatusCode::OK, "{second}");
    let rows = audit_rows(&admin.app).await;
    assert_eq!(
        refused_with(
            &admin
                .call("PUT", &path, Some(update(&first, true, "Павел Орлов")))
                .await
        ),
        (StatusCode::CONFLICT, seat_limit("cabinetUsers", 2, 2))
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    // A rename of a user who stays off takes none.
    let (status, renamed) = admin
        .call(
            "PUT",
            &path,
            Some(update(&first, false, "Павел Орлов-Смирнов")),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
}

#[tokio::test]
async fn lines_and_their_return_from_the_archive_take_line_seats() {
    let admin = admin().await;
    load_ok(&admin, &quota(&admin.app.state.host_id, "lines", 2)).await;
    let create = json!({ "name": "Линия 3" });
    let rows = audit_rows(&admin.app).await;
    let rev = host_revision(&admin.app).await;
    assert_eq!(
        refused_with(
            &admin
                .call("POST", "/v1/office/lines", Some(create.clone()))
                .await
        ),
        (StatusCode::CONFLICT, seat_limit("lines", 2, 2))
    );
    assert_eq!(
        (
            audit_rows(&admin.app).await,
            host_revision(&admin.app).await
        ),
        (rows, rev)
    );
    let (_, lines) = admin.call("GET", "/v1/office/lines", None).await;
    let line = |name: &str| {
        lines
            .as_array()
            .unwrap()
            .iter()
            .find(|line| line["name"] == name)
            .unwrap()
            .clone()
    };
    // A rename of a line that stays in use takes none, every seat taken.
    let first = line("Линия 1");
    let (status, renamed) = admin
        .call(
            "PUT",
            &format!("/v1/office/lines/{}", first["id"].as_str().unwrap()),
            Some(json!({ "name": "Линия 1 (главная)", "expectedRev": first["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
    let second = line("Линия 2");
    let path = format!("/v1/office/lines/{}", second["id"].as_str().unwrap());
    let (status, archived) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "archived": true, "expectedRev": second["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    let (status, third) = admin.call("POST", "/v1/office/lines", Some(create)).await;
    assert_eq!(status, StatusCode::OK, "{third}");
    let rows = audit_rows(&admin.app).await;
    assert_eq!(
        refused_with(
            &admin
                .call(
                    "PUT",
                    &path,
                    Some(json!({ "archived": false, "expectedRev": archived["rev"] })),
                )
                .await
        ),
        (StatusCode::CONFLICT, seat_limit("lines", 2, 2))
    );
    assert_eq!(audit_rows(&admin.app).await, rows);
    let (status, renamed) = admin
        .call(
            "PUT",
            &path,
            Some(json!({ "name": "Линия 2 (старая)", "expectedRev": archived["rev"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{renamed}");
}

/// The cloud's import adds lines too (two of the golden file's three are
/// new to the wizard's two): beyond the file it is refused whole, the dry
/// run as well, without a row; within it, it goes.
#[tokio::test]
async fn an_import_that_would_add_lines_beyond_the_file_is_refused() {
    let admin = admin().await;
    load_ok(&admin, &quota(&admin.app.state.host_id, "lines", 3)).await;
    let rows = audit_rows(&admin.app).await;
    for dry_run in [true, false] {
        assert_eq!(
            refused_with(
                &admin
                    .call(
                        "POST",
                        "/v1/office/import",
                        Some(cloud_import_request(IMPORT_ID, dry_run)),
                    )
                    .await
            ),
            (StatusCode::CONFLICT, seat_limit("lines", 2, 3)),
            "dry run: {dry_run}"
        );
    }
    assert_eq!(audit_rows(&admin.app).await, rows);
    let (_, lines) = admin.call("GET", "/v1/office/lines", None).await;
    assert_eq!(lines.as_array().unwrap().len(), 2);
    let wider = file(&admin.app.state.host_id, |terms| {
        terms["licenseId"] = json!(support::license::license_id(2));
        terms["sequence"] = json!(2);
        terms["quotas"]["lines"] = json!(4);
    });
    load_ok(&admin, &wider).await;
    let (status, summary) = admin
        .call(
            "POST",
            "/v1/office/import",
            Some(cloud_import_request(IMPORT_ID, false)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    assert_eq!(summary["linesCreated"], 2);
}
