//! Which kind of device calls which route (plan ТСД-Х, task Х1, spec 6.2): every `/v1/device/*`
//! and `/v1/changes*` route has a row of `device_kinds::ROUTE_KINDS`, a route refuses a kind its
//! row does not list before it reads the body, and a handheld's key opens no office route.

mod support;

use std::collections::BTreeSet;

use axum::http::StatusCode;
use markiro_host::device_kinds::ROUTE_KINDS;
use markiro_host::secrets::key_hash;
use markiro_proto::DeviceKind;
use serde_json::json;
use support::app::{
    admin, audit_rows, empty, json as json_request, pair_device, pair_handheld, request,
    with_device, Admin,
};
use support::routes::routed;

fn in_scope(path: &str) -> bool {
    path.starts_with("/v1/device") || path.starts_with("/v1/changes")
}

fn concrete(path: &str) -> String {
    path.split('/')
        .map(|segment| match segment {
            "{code_hash}" => "a".repeat(64),
            s if s.starts_with('{') => "00000000-0000-4000-8000-000000000001".to_owned(),
            s => s.to_owned(),
        })
        .collect::<Vec<_>>()
        .join("/")
}

async fn keys(admin: &Admin) -> Vec<(DeviceKind, String)> {
    let (_, station) = pair_device(&admin.app, "station").await;
    let (_, office) = pair_device(&admin.app, "office").await;
    let handheld = pair_handheld(admin).await;
    vec![
        (DeviceKind::Station, station),
        (DeviceKind::Office, office),
        (DeviceKind::Handheld, handheld),
    ]
}

#[test]
fn every_device_and_changes_route_has_a_row_and_every_row_a_route() {
    let routed: BTreeSet<(String, String)> = routed()
        .into_iter()
        .filter(|(_, path)| in_scope(path))
        .collect();
    assert!(routed.len() >= 15, "the router was not read: {routed:?}");
    let rows: BTreeSet<(String, String)> = ROUTE_KINDS
        .iter()
        .map(|(method, path, _)| ((*method).to_owned(), (*path).to_owned()))
        .collect();
    assert_eq!(rows.len(), ROUTE_KINDS.len(), "a route has two rows");
    let unlisted: Vec<_> = routed.difference(&rows).collect();
    assert!(unlisted.is_empty(), "routes without a row: {unlisted:?}");
    let gone: Vec<_> = rows.difference(&routed).collect();
    assert!(gone.is_empty(), "rows of no route: {gone:?}");
}

#[tokio::test]
async fn a_route_refuses_a_kind_its_row_does_not_list_before_it_reads_the_body() {
    let admin = admin().await;
    let keys = keys(&admin).await;
    let before = audit_rows(&admin.app).await;
    for (kind, key) in keys {
        for (method, path, allowed) in ROUTE_KINDS {
            // An event stream of an allowed kind would never end.
            if allowed.contains(&kind) && path.ends_with("/stream") {
                continue;
            }
            let builder = with_device(request(method, &concrete(path)), &key);
            // A body no route reads: the refusal by kind must come first.
            let (status, body) = admin
                .app
                .send(json_request(builder, json!({ "garbage": true })))
                .await;
            if allowed.contains(&kind) {
                assert_ne!(
                    status,
                    StatusCode::FORBIDDEN,
                    "{kind:?} {method} {path}: {body}"
                );
            } else {
                assert_eq!(
                    (status, body["error"]["code"].clone()),
                    (StatusCode::FORBIDDEN, json!("forbidden")),
                    "{kind:?} {method} {path}"
                );
            }
        }
    }
    // No call with a body no route reads writes an audit row.
    assert_eq!(audit_rows(&admin.app).await, before);
}

#[tokio::test]
async fn a_handheld_key_opens_no_office_route_whatever_the_password() {
    let admin = admin().await;
    let handheld = pair_handheld(&admin).await;
    let (status, refused) = admin
        .app
        .send(json_request(
            with_device(request("POST", "/v1/office/login"), &handheld),
            json!({ "login": "admin", "password": "correct horse battery" }),
        ))
        .await;
    assert_eq!(
        (status, refused["error"]["code"].clone()),
        (StatusCode::FORBIDDEN, json!("forbidden"))
    );
    let station: String = sqlx::query_scalar("SELECT id FROM devices WHERE key_hash = ?")
        .bind(key_hash(&admin.key))
        .fetch_one(&admin.app.state.pool)
        .await
        .unwrap();
    let foreign: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM office_sessions WHERE device_id != ?")
            .bind(&station)
            .fetch_one(&admin.app.state.pool)
            .await
            .unwrap();
    assert_eq!(foreign, 0, "a handheld got an office session");
    for (method, path) in [
        ("GET", "/v1/office/me"),
        ("GET", "/v1/office/devices"),
        ("POST", "/v1/bootstrap"),
        ("GET", "/v1/office/license"),
    ] {
        let (status, refused) = admin
            .app
            .send(empty(with_device(request(method, path), &handheld)))
            .await;
        assert_eq!(
            (status, refused["error"]["code"].clone()),
            (StatusCode::FORBIDDEN, json!("forbidden")),
            "{method} {path}"
        );
    }
    // The station that runs the office keeps working.
    let (status, _) = admin.call("GET", "/v1/office/me", None).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn a_handheld_key_is_refused_on_every_office_route_of_the_router() {
    let admin = admin().await;
    let handheld = pair_handheld(&admin).await;
    let office: Vec<_> = routed()
        .into_iter()
        .filter(|(_, path)| path.starts_with("/v1/office/") || path == "/v1/bootstrap")
        .collect();
    assert!(office.len() >= 40, "the router was not read: {office:?}");
    for (method, path) in office {
        let (status, refused) = admin
            .app
            .send(json_request(
                with_device(request(&method, &concrete(&path)), &handheld),
                json!({ "garbage": true }),
            ))
            .await;
        assert_eq!(
            (status, refused["error"]["code"].clone()),
            (StatusCode::FORBIDDEN, json!("forbidden")),
            "{method} {path}"
        );
    }
}
