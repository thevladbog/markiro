//! The hold of the stations' facts after a restore (plan РК): a held host
//! answers facts and code checks `restore_pending` and nothing else, and an
//! administrator resumes them.

mod support;

use std::sync::Arc;

use axum::extract::connect_info::MockConnectInfo;
use axum::http::StatusCode;
use markiro_host::backup::Backups;
use markiro_host::server::router;
use serde_json::{json, Value};
use tower::ServiceExt;

use support::app::{
    admin, audit_rows, audit_trail, empty, host_revision, json as json_request, login, request,
    seed_office_user, turn_the_user_off_at_the_next_activity, with_device, Admin,
};

const EPOCH: &str = "5d2c8e1a-7b3f-4c9d-a0e1-2f3a4b5c6d7e";
const SINCE: &str = "2026-10-09T15:00:00Z";

/// A host restored at `SINCE`, with its copies in `<data dir>/backups`.
async fn held() -> (Admin, Arc<Backups>) {
    let mut admin = admin().await;
    let local = admin.app.dir().join("backups");
    std::fs::create_dir_all(&local).unwrap();
    let backups = Backups::new(
        admin.app.dir().to_path_buf(),
        local,
        admin.app.dir().join("host.db"),
        admin.app.state.host_id.clone(),
    );
    admin.app.state = admin.app.state.clone().with_backups(backups.clone());
    sqlx::query("UPDATE site SET restore_epoch = ?, facts_held_since = ?")
        .bind(EPOCH)
        .bind(SINCE)
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    (admin, backups)
}

async fn facts(admin: &Admin) -> (StatusCode, Value) {
    admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/facts"), &admin.key),
            json!({ "records": [] }),
        ))
        .await
}

fn restore_pending() -> (StatusCode, Value, Value) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        json!("restore_pending"),
        json!({ "since": SINCE }),
    )
}

fn refusal(status: StatusCode, body: &Value) -> (StatusCode, Value, Value) {
    (
        status,
        body["error"]["code"].clone(),
        body["error"]["details"].clone(),
    )
}

async fn held_since(admin: &Admin) -> Option<String> {
    sqlx::query_scalar("SELECT facts_held_since FROM site WHERE id = 1")
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_held_host_answers_facts_and_code_checks_restore_pending_and_nothing_else() {
    let (admin, _) = held().await;
    let (status, body) = facts(&admin).await;
    assert_eq!(refusal(status, &body), restore_pending(), "{body}");
    let (status, body) = admin
        .app
        .send(empty(with_device(
            request("GET", &format!("/v1/device/codes/{}", "ab".repeat(32))),
            &admin.key,
        )))
        .await;
    assert_eq!(refusal(status, &body), restore_pending(), "{body}");
    // The hold is the same for any caller; it tells nothing but the time.
    let (status, body) = admin
        .app
        .send(json_request(request("POST", "/v1/device/facts"), json!({})))
        .await;
    assert_eq!(refusal(status, &body), restore_pending(), "{body}");
    let (status, block) = admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/sscc/blocks"), &admin.key),
            json!({
                "requestId": "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a",
                "issuerPrefix": "460068200",
                "extension": 0
            }),
        ))
        .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "a station still gets blocks: {block}"
    );
    let (status, me) = admin.call("GET", "/v1/office/me", None).await;
    assert_eq!(status, StatusCode::OK, "{me}");
    let (status, hello) = admin.app.send(empty(request("GET", "/v1/hello"))).await;
    assert_eq!(
        (status, hello["restoreEpoch"].clone()),
        (StatusCode::OK, json!(EPOCH))
    );
}

/// The hold is read before the route: a database that cannot tell whether
/// the facts are held answers `internal`, never the route's own answer.
#[tokio::test]
async fn a_hold_that_cannot_be_read_holds_the_facts_and_the_code_checks() {
    let admin = admin().await;
    sqlx::query("ALTER TABLE site RENAME COLUMN facts_held_since TO facts_held_since_gone")
        .execute(&admin.app.state.pool)
        .await
        .unwrap();
    let (status, body) = facts(&admin).await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::INTERNAL_SERVER_ERROR, json!("internal")),
        "{body}"
    );
    let (status, body) = admin
        .app
        .send(empty(with_device(
            request("GET", &format!("/v1/device/codes/{}", "ab".repeat(32))),
            &admin.key,
        )))
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::INTERNAL_SERVER_ERROR, json!("internal")),
        "{body}"
    );
}

#[tokio::test]
async fn a_host_that_holds_nothing_lets_the_facts_through() {
    let admin = admin().await;
    let (status, body) = facts(&admin).await;
    assert_ne!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_ne!(body["error"]["code"], "restore_pending", "{body}");
}

#[tokio::test]
async fn an_administrator_resumes_the_facts_once() {
    let (admin, _) = held().await;
    let tech = admin.technologist().await;
    let rev = host_revision(&admin.app).await;
    let (status, body) = admin
        .call_as(&tech, "POST", "/v1/office/backups/resume", None)
        .await;
    assert_eq!(
        (status, body["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
    assert_eq!(held_since(&admin).await.as_deref(), Some(SINCE));

    let (status, body) = admin.call("POST", "/v1/office/backups/resume", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["restoreHold"], Value::Null);
    assert_eq!(held_since(&admin).await, None);
    assert_eq!(host_revision(&admin.app).await, rev, "no feed data changed");
    assert_eq!(
        audit_trail(&admin.app, "host.restore.resume").await,
        [admin.row(
            "host.restore.resume",
            "site",
            "1",
            json!({ "since": SINCE, "epoch": EPOCH, "stations": 1, "reconciled": 0 }),
        )]
    );
    let (status, body) = facts(&admin).await;
    assert_ne!(body["error"]["code"], "restore_pending", "{status} {body}");

    let rows = audit_rows(&admin.app).await;
    let (status, again) = admin.call("POST", "/v1/office/backups/resume", None).await;
    assert_eq!(
        (status, again["restoreHold"].clone()),
        (StatusCode::OK, Value::Null)
    );
    assert_eq!(audit_rows(&admin.app).await, rows, "nothing to resume");
}

#[tokio::test]
async fn an_administrator_turned_off_after_the_extractor_resumes_nothing() {
    let (admin, _) = held().await;
    let other = seed_office_user(&admin.app, "admin2", "admin", "second admin password").await;
    let token = login(&admin.app, &admin.key, "admin2", "second admin password").await;
    turn_the_user_off_at_the_next_activity(&admin.app, &other).await;
    admin.app.clock.advance(time::Duration::minutes(2));
    let (status, body) = admin
        .call_as(&token, "POST", "/v1/office/backups/resume", None)
        .await;
    assert_eq!(
        (status, body["error"]["details"]["credential"].clone()),
        (StatusCode::UNAUTHORIZED, json!("session")),
        "{body}"
    );
    assert_eq!(held_since(&admin).await.as_deref(), Some(SINCE));
}

#[tokio::test]
async fn a_held_answer_tells_the_station_when_to_ask_again() {
    let (admin, _) = held().await;
    let response = router(admin.app.state.clone())
        .layer(MockConnectInfo(([127, 0, 0, 1], 50_000)))
        .oneshot(json_request(
            with_device(request("POST", "/v1/device/facts"), &admin.key),
            json!({ "records": [] }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok()),
        Some("60")
    );
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("application/json")
    );
}

#[tokio::test]
async fn only_the_held_paths_are_held_whatever_the_method() {
    let (admin, _) = held().await;
    // The hold is a matter of the path: a method the route lacks is held too,
    // so a future route on a held path cannot slip through.
    let (status, body) = admin
        .app
        .send(empty(with_device(
            request("GET", "/v1/device/facts"),
            &admin.key,
        )))
        .await;
    assert_eq!(refusal(status, &body), restore_pending(), "{body}");
    for path in ["/v1/device/factsx", "/v1/device/codes", "/v1/device/line"] {
        let (status, body) = admin
            .app
            .send(empty(with_device(request("GET", path), &admin.key)))
            .await;
        assert_ne!(body["error"]["code"], "restore_pending", "{path}: {status}");
    }
    // The feed and the office read on: the hold is for facts only.
    let (status, feed) = admin
        .app
        .send(empty(with_device(
            request("GET", "/v1/changes?since=0"),
            &admin.key,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{feed}");
}

#[tokio::test]
async fn a_station_that_gave_its_blocks_back_does_not_end_the_hold_by_it() {
    let (admin, _) = held().await;
    let (status, state) = admin.call("GET", "/v1/office/backups", None).await;
    assert_eq!(status, StatusCode::OK, "{state}");
    assert_eq!(state["restoreHold"]["stations"][0]["reconciled"], false);
    let (status, body) = admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/device/sscc/blocks/known"), &admin.key),
            json!({ "blocks": [{
                "id": "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
                "issuerPrefix": "460068200", "extension": 0,
                "fromSerial": 1, "toSerial": 10
            }] }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(held_since(&admin).await.as_deref(), Some(SINCE));
    let (status, state) = admin.call("GET", "/v1/office/backups", None).await;
    assert_eq!(status, StatusCode::OK, "{state}");
    assert_eq!(state["restoreHold"]["since"], SINCE);
    assert_eq!(state["restoreHold"]["stations"][0]["reconciled"], true);
    let (status, body) = facts(&admin).await;
    assert_eq!(refusal(status, &body), restore_pending(), "{body}");

    // The administrator's decision counts the stations that came back.
    let (status, body) = admin.call("POST", "/v1/office/backups/resume", None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        audit_trail(&admin.app, "host.restore.resume").await[0].6,
        json!({ "since": SINCE, "epoch": EPOCH, "stations": 1, "reconciled": 1 })
    );
}

#[tokio::test]
async fn the_hold_is_in_the_database_not_in_the_process() {
    let (admin, _) = held().await;
    // A new process reads the same file: a router over a fresh state and the
    // pool of the same database is held at once.
    let fresh = markiro_host::server::AppState::new(
        admin.app.state.pool.clone(),
        admin.app.state.host_id.clone(),
        admin.app.clock.clone(),
    );
    let response = router(fresh)
        .layer(MockConnectInfo(([127, 0, 0, 1], 50_000)))
        .oneshot(json_request(
            request("POST", "/v1/device/facts"),
            json!({ "records": [] }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
}
