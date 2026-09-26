mod support;

use axum::http::StatusCode;
use markiro_host::clock::{format_timestamp, parse_timestamp, Clock, ManualClock};
use markiro_host::config::HostPaths;
use markiro_host::{db, start, StartOptions};
use support::app::{empty, request, TestApp, START};

#[tokio::test]
async fn hello_needs_no_protocol_header() {
    let app = TestApp::new().await;
    let request = axum::http::Request::get("/v1/hello")
        .body(axum::body::Body::empty())
        .unwrap();
    let (status, body) = app.send(request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["protocol"], 1);
    assert_eq!(body["time"], format_timestamp(app.clock.now()));
}

#[tokio::test]
async fn a_wrong_method_gets_the_protocol_error_body() {
    let app = TestApp::new().await;
    let (status, body) = app.send(empty(request("POST", "/v1/hello"))).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(body["error"]["code"], "method_not_allowed");
    assert_eq!(body["error"]["message"], "POST is not allowed on /v1/hello");
}

/// The protocol guard's `route_layer` wraps only the protected routes; a
/// wrong method on one of them must still reach the router's own
/// `method_not_allowed_fallback`, not fall through to `not_found` or bypass
/// the guard's error body.
#[tokio::test]
async fn a_wrong_method_on_a_protected_route_is_also_method_not_allowed() {
    let app = TestApp::new().await;
    let (status, body) = app.send(empty(request("DELETE", "/v1/device"))).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(body["error"]["code"], "method_not_allowed");
}

#[tokio::test]
async fn unknown_routes_stay_not_found_without_a_protocol_header() {
    let app = TestApp::new().await;
    let request = axum::http::Request::get("/v1/nothing")
        .body(axum::body::Body::empty())
        .unwrap();
    let (status, body) = app.send(request).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"]["code"], "not_found");
}

#[tokio::test]
async fn revisions_increase_by_one_per_call() {
    let app = TestApp::new().await;
    let mut tx = db::begin_write(&app.state.pool).await.unwrap();
    assert_eq!(db::next_revision(&mut tx).await.unwrap(), 1);
    assert_eq!(db::next_revision(&mut tx).await.unwrap(), 2);
    tx.commit().await.unwrap();
    let mut tx = db::begin_write(&app.state.pool).await.unwrap();
    assert_eq!(db::next_revision(&mut tx).await.unwrap(), 3);
    tx.rollback().await.unwrap();
    let rev: i64 = sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(rev, 2);
}

#[test]
fn timestamps_are_utc_whole_seconds_and_round_trip() {
    let clock = ManualClock::new(time::OffsetDateTime::from_unix_timestamp(START).unwrap());
    clock.advance(time::Duration::milliseconds(1_500));
    let text = format_timestamp(clock.now());
    assert_eq!(text, "2026-09-21T14:13:21Z");
    assert_eq!(parse_timestamp(&text).unwrap().unix_timestamp(), START + 1);
}

#[tokio::test]
async fn a_second_host_on_the_same_data_directory_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let paths = HostPaths::new(dir.path());
    let options = StartOptions {
        port_override: None,
        bind: Some("127.0.0.1:0".parse().unwrap()),
    };
    let first = start(&paths, options).await.unwrap();
    let error = start(&paths, options)
        .await
        .err()
        .expect("second start must fail");
    assert!(error.to_string().contains("host.lock"), "{error}");
    first.stop().await.unwrap();
    let again = start(&paths, options).await.unwrap();
    again.stop().await.unwrap();
}
