mod support;

use std::io::Write;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use http_body_util::BodyExt;
use markiro_host::auth::AuthDevice;
use markiro_host::config::HostPaths;
use markiro_host::server::router;
use markiro_host::{start, StartOptions};
use markiro_proto::DeviceKind;
use serde_json::{json, Value};
use support::app::{
    audit_trail, bootstrap, empty, host_revision, json as json_request, pair_device, request,
    with_device, with_session, TestApp, LOOPBACK,
};
use tower::ServiceExt;

/// Open the stream in-process; returns the status, the content type and the body.
async fn open_stream(app: &TestApp, key: &str) -> (StatusCode, String, Body) {
    let response = router(app.state.clone())
        .layer(MockConnectInfo(SocketAddr::from(LOOPBACK)))
        .oneshot(empty(with_device(
            request("GET", "/v1/changes/stream"),
            key,
        )))
        .await
        .unwrap();
    let status = response.status();
    let content_type = response
        .headers()
        .get("content-type")
        .map(|value| value.to_str().unwrap().to_owned())
        .unwrap_or_default();
    (status, content_type, response.into_body())
}

/// The next chunk of the stream as text, within 5 seconds.
async fn next_text(body: &mut Body) -> String {
    let frame = tokio::time::timeout(Duration::from_secs(5), body.frame())
        .await
        .expect("an event within 5 s")
        .expect("the stream is open")
        .expect("a frame");
    String::from_utf8(frame.into_data().expect("a data frame").to_vec()).unwrap()
}

fn rev_event(rev: i64) -> String {
    format!("event: rev\ndata: {{\"rev\":{rev}}}\n\n")
}

fn org_update(expected_rev: i64) -> Value {
    json!({
        "name": "ООО «Атолл-Юг»",
        "inn": null,
        "gln": "4600682000010",
        "gs1Prefixes": ["4600682"],
        "timeZone": "Europe/Moscow",
        "expectedRev": expected_rev
    })
}

#[tokio::test]
async fn the_stream_sends_the_current_revision_then_every_new_one() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;

    let (status, content_type, mut body) = open_stream(&app, &key).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(content_type, "text/event-stream");
    assert_eq!(next_text(&mut body).await, rev_event(1));

    let (status, org) = app
        .send(json_request(
            with_session(request("PUT", "/v1/office/org"), &key, &token),
            org_update(1),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{org}");
    assert_eq!(
        next_text(&mut body).await,
        rev_event(org["rev"].as_i64().unwrap())
    );
}

/// A watch value at or below the last one sent (here, a test forcing the
/// channel back to 0) must never produce a second, non-increasing event: the
/// stream keeps waiting until a real commit moves the revision forward.
///
/// Reads the next chunk concurrently with the real commit (`tokio::join!`),
/// the way a live connection is actually driven. A sequential await here
/// would let the real commit's `send_if_modified` overwrite the `0` before
/// the stream ever polls the channel, silently passing even a stream that
/// forwards every change unfiltered.
#[tokio::test]
async fn a_lower_watch_value_never_produces_a_non_increasing_event() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;

    let (status, _, mut body) = open_stream(&app, &key).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(next_text(&mut body).await, rev_event(1));

    app.state.revisions.send_replace(0);

    let (next, (put_status, org)) = tokio::join!(
        next_text(&mut body),
        app.send(json_request(
            with_session(request("PUT", "/v1/office/org"), &key, &token),
            org_update(1),
        )),
    );
    assert_eq!(put_status, StatusCode::OK, "{org}");
    assert_eq!(
        next,
        rev_event(org["rev"].as_i64().unwrap()),
        "the next chunk is the new revision, not the lower value written in between"
    );
}

#[tokio::test]
async fn the_stream_sends_a_heartbeat_comment() {
    let mut app = TestApp::new().await;
    app.state = app
        .state
        .clone()
        .with_stream_heartbeat(Duration::from_millis(50));
    let (_, key) = pair_device(&app, "station").await;

    let (_, _, mut body) = open_stream(&app, &key).await;
    assert_eq!(next_text(&mut body).await, rev_event(0));
    assert!(
        next_text(&mut body).await.starts_with(':'),
        "a comment line keeps the connection alive"
    );
}

#[tokio::test]
async fn the_stream_needs_a_device_key() {
    let app = TestApp::new().await;
    let (status, body) = app.send(empty(request("GET", "/v1/changes/stream"))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"]["details"]["credential"], "device");
}

#[tokio::test]
async fn every_revision_bump_wakes_subscribers_after_its_commit() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;
    let latest = || *app.state.revisions.borrow();
    assert_eq!(latest(), 1, "the wizard");

    let (_, org) = app
        .send(json_request(
            with_session(request("PUT", "/v1/office/org"), &key, &token),
            org_update(1),
        ))
        .await;
    assert_eq!(latest(), org["rev"].as_i64().unwrap(), "organization");

    let (_, sscc) = app
        .send(empty(with_session(
            request("GET", "/v1/office/sscc"),
            &key,
            &token,
        )))
        .await;
    let (_, sizes) = app
        .send(json_request(
            with_session(request("PUT", "/v1/office/sscc/block-sizes"), &key, &token),
            json!({ "boxBlockSize": 1000, "palletBlockSize": 100, "expectedRev": sscc["blockSizesRev"] }),
        ))
        .await;
    assert_eq!(
        latest(),
        sizes["blockSizesRev"].as_i64().unwrap(),
        "block sizes"
    );

    let (_, counter) = app
        .send(json_request(
            with_session(
                request("PUT", "/v1/office/sscc/counters/460068200/0"),
                &key,
                &token,
            ),
            json!({ "nextSerial": 2000, "expectedRev": 1 }),
        ))
        .await;
    assert_eq!(latest(), counter["rev"].as_i64().unwrap(), "counter");

    let (_, user) = app
        .send(json_request(
            with_session(request("POST", "/v1/office/users"), &key, &token),
            json!({ "login": "tech", "name": "Павел Орлов", "role": "technologist", "password": "technologist password" }),
        ))
        .await;
    assert_eq!(latest(), user["rev"].as_i64().unwrap(), "new user");
    let user_path = format!("/v1/office/users/{}", user["id"].as_str().unwrap());

    let (_, updated) = app
        .send(json_request(
            with_session(request("PUT", &user_path), &key, &token),
            json!({ "name": "Павел Орлов-Старший", "role": "technologist", "active": true, "expectedRev": user["rev"] }),
        ))
        .await;
    assert_eq!(latest(), updated["rev"].as_i64().unwrap(), "user update");

    let (status, _) = app
        .send(json_request(
            with_session(
                request("PUT", &format!("{user_path}/password")),
                &key,
                &token,
            ),
            json!({ "password": "another long password" }),
        ))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        latest(),
        host_revision(&app).await,
        "password set by the administrator"
    );

    let (status, _) = app
        .send(json_request(
            with_session(request("PUT", "/v1/office/me/password"), &key, &token),
            json!({ "currentPassword": "correct horse battery", "newPassword": "a brand new admin password" }),
        ))
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(latest(), host_revision(&app).await, "own password change");
}

/// In-process counterpart of `open_streams_end_when_the_host_stops`, without
/// binding a real socket: flips the same `stopping` watch the host's `stop`
/// uses, and checks the body frame the SSE stream itself produces.
#[tokio::test]
async fn a_stream_ends_when_the_host_starts_stopping() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;

    let (status, _, mut body) = open_stream(&app, &key).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(next_text(&mut body).await, rev_event(0));

    app.state.stopping.send_replace(true);

    let frame = tokio::time::timeout(Duration::from_secs(5), body.frame())
        .await
        .expect("the stream ends within 5 s of the host starting to stop");
    assert!(
        frame.is_none(),
        "the stream ended cleanly when the host started stopping"
    );
}

#[tokio::test]
async fn open_streams_end_when_the_host_stops() {
    let dir = tempfile::tempdir().unwrap();
    let host = start(
        &HostPaths::new(dir.path()),
        StartOptions {
            port_override: None,
            bind: Some("127.0.0.1:0".parse().unwrap()),
        },
    )
    .await
    .unwrap();
    let client = support::pinned_client(&host.fingerprint);
    let base = format!("https://{}", host.addr);
    let paired: Value = client
        .post(format!("{base}/v1/local-pair"))
        .header(markiro_proto::PROTOCOL_HEADER, "1")
        .json(&json!({ "kind": "station", "name": "Станция", "appVersion": "0.1.0" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let key = paired["deviceKey"].as_str().unwrap().to_owned();
    let mut stream = client
        .get(format!("{base}/v1/changes/stream"))
        .header(markiro_proto::PROTOCOL_HEADER, "1")
        .bearer_auth(&key)
        .send()
        .await
        .unwrap();
    assert_eq!(stream.status(), 200);
    let first = stream.chunk().await.unwrap().expect("the first event");
    assert_eq!(String::from_utf8(first.to_vec()).unwrap(), rev_event(0));

    tokio::time::timeout(Duration::from_secs(5), host.stop())
        .await
        .expect("the host stops without waiting for the stream")
        .unwrap();
    assert!(
        matches!(stream.chunk().await, Ok(None)),
        "the stream ended cleanly with the host"
    );
}

/// An office line assignment takes a host revision without a feed item, so
/// the station's open stream gets an event and the station can read its
/// device again.
#[tokio::test]
async fn an_office_line_assignment_wakes_the_stations_stream() {
    let app = TestApp::new().await;
    let (station, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;
    let line: String = sqlx::query_scalar("SELECT id FROM lines ORDER BY name LIMIT 1")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();

    let (status, _, mut body) = open_stream(&app, &key).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(next_text(&mut body).await, rev_event(1));

    let (status, device) = app
        .send(json_request(
            with_session(
                request("PUT", &format!("/v1/office/devices/{station}")),
                &key,
                &token,
            ),
            json!({ "lineId": line }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{device}");
    assert_eq!(next_text(&mut body).await, rev_event(2));
    assert_eq!(host_revision(&app).await, 2);
}

/// A revocation ends the revoked device's open stream at once, not at its
/// next heartbeat (15 s here), and leaves other devices' streams open.
#[tokio::test]
async fn revoking_a_device_ends_its_open_stream_and_no_other() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;
    let (other, other_key) = pair_device(&app, "station").await;

    let (status, _, mut revoked) = open_stream(&app, &other_key).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(next_text(&mut revoked).await, rev_event(1));
    let (_, _, mut kept) = open_stream(&app, &key).await;
    assert_eq!(next_text(&mut kept).await, rev_event(1));

    let (status, body) = app
        .send(empty(with_session(
            request("POST", &format!("/v1/office/devices/{other}/revoke")),
            &key,
            &token,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let frame = tokio::time::timeout(Duration::from_secs(5), revoked.frame())
        .await
        .expect("the revoked device's stream ends within 5 s");
    assert!(frame.is_none(), "the stream ended cleanly");

    // The other stream is still open and gets the next revision.
    let (status, org) = app
        .send(json_request(
            with_session(request("PUT", "/v1/office/org"), &key, &token),
            org_update(1),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{org}");
    assert_eq!(
        next_text(&mut kept).await,
        rev_event(org["rev"].as_i64().unwrap())
    );
}

/// `stream` looks its device up itself when it opens, since a revocation can
/// land after `AuthDevice` read the key. A request through the router never
/// gets that far with a key revoked beforehand (`AuthDevice` refuses it
/// first), so the handler is called directly with the extractor's value.
#[tokio::test]
async fn opening_a_stream_for_a_device_revoked_meanwhile_is_refused() {
    let app = TestApp::new().await;
    let (id, _) = pair_device(&app, "station").await;
    sqlx::query("UPDATE devices SET revoked_at = ? WHERE id = ?")
        .bind(app.state.timestamp())
        .bind(&id)
        .execute(&app.state.pool)
        .await
        .unwrap();

    let refused = markiro_host::routes::changes::stream(
        State(app.state.clone()),
        AuthDevice {
            id,
            kind: DeviceKind::Station,
            key_hash: None,
        },
    )
    .await
    .err()
    .expect("a revoked device is not given a stream")
    .into_response();
    assert_eq!(refused.status(), StatusCode::UNAUTHORIZED);
    let bytes = refused.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        (
            body["error"]["code"].clone(),
            body["error"]["details"]["credential"].clone()
        ),
        (json!("unauthorized"), json!("device"))
    );
}

/// A revocation whose wake-up was lost (here the row is revoked by SQL, so
/// nothing announced it) leaves the device's stream open. The administrator's
/// retry finds the device already revoked and writes nothing, yet wakes the
/// streams once more, and the stream ends.
#[tokio::test]
async fn retrying_a_revocation_whose_wake_up_was_lost_ends_the_stream() {
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let token = bootstrap(&app, &key).await;
    let (other, other_key) = pair_device(&app, "station").await;
    let (status, _, mut stream) = open_stream(&app, &other_key).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(next_text(&mut stream).await, rev_event(1));

    sqlx::query("UPDATE devices SET revoked_at = ? WHERE id = ?")
        .bind(app.state.timestamp())
        .bind(&other)
        .execute(&app.state.pool)
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(300), stream.frame())
            .await
            .is_err(),
        "nothing announced the revocation, so the stream is still open"
    );

    let (status, body) = app
        .send(empty(with_session(
            request("POST", &format!("/v1/office/devices/{other}/revoke")),
            &key,
            &token,
        )))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let frame = tokio::time::timeout(Duration::from_secs(5), stream.frame())
        .await
        .expect("the retry wakes the stream, which ends within 5 s");
    assert!(frame.is_none(), "the stream ended cleanly");
    assert!(
        audit_trail(&app, "device.revoke").await.is_empty(),
        "the retry changed nothing and wrote no row"
    );
}

/// What the test's own `tracing` calls printed.
#[derive(Clone, Default)]
struct Log(Arc<Mutex<Vec<u8>>>);

impl Write for Log {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// A stream whose device re-read fails ends (fail closed, as before) and says
/// why in the log, instead of throwing the cause away; the line names no key.
/// The current-thread test runtime polls the stream on this thread, so this
/// thread's subscriber sees its warning.
#[tokio::test]
async fn a_failed_device_check_ends_the_stream_and_is_logged() {
    let log = Log::default();
    let writer = log.clone();
    let _scope = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .with_writer(move || writer.clone())
            .with_ansi(false)
            .with_max_level(tracing::Level::INFO)
            .finish(),
    );
    let app = TestApp::new().await;
    let (_, key) = pair_device(&app, "station").await;
    let (status, _, mut stream) = open_stream(&app, &key).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(next_text(&mut stream).await, rev_event(0));

    // The database is gone when a revocation (of any device) wakes the stream.
    app.state.pool.close().await;
    app.state.revocations.send_modify(|count| *count += 1);
    let frame = tokio::time::timeout(Duration::from_secs(5), stream.frame())
        .await
        .expect("a stream that cannot check its device ends within 5 s");
    assert!(frame.is_none(), "the stream ended cleanly");

    let printed = String::from_utf8(log.0.lock().unwrap().clone()).unwrap();
    assert!(
        printed.contains("change stream: device check failed"),
        "{printed}"
    );
    assert!(!printed.contains(&key), "the log holds no device key");
}
