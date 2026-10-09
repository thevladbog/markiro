//! `host_request`'s `timeoutMs` (stage 2a spec §5.2) against hosts that
//! never answer: a request past its own limit fails with `timeout`, one
//! without a limit still ends at the client's own limits as `unreachable`,
//! and a limit outside 100–10 000 ms is refused before any I/O. Every
//! listener here is on 127.0.0.1, so the suite runs outside the agents'
//! sandbox.

use std::path::Path;
use std::time::{Duration, Instant};

use markiro_host::config::HostPaths;
use markiro_host::{start, StartOptions};
use markiro_standalone_lib::device::{DeviceError, DeviceState};
use markiro_standalone_lib::device_config;
use markiro_standalone_lib::host_client::{Credentials, PinnedClient, RequestError};
use markiro_standalone_lib::secret_store;
use serde_json::json;

/// A local address that accepts connections and then never says a word, not
/// even its half of the TLS handshake: a host that hangs. The thread holds
/// every connection it accepts until the test binary exits.
fn silent_address() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let _held: Vec<_> = listener.incoming().collect();
    });
    format!("https://127.0.0.1:{port}")
}

/// A local address where nothing listens.
fn closed_address() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    format!("https://127.0.0.1:{port}")
}

/// A pairing on disk with the host at `address`, written as JSON so the
/// test does not depend on every field of `DeviceConfig`; no host issued
/// its key, and none needs to: the requests here never get an answer.
fn paired_with(dir: &Path, address: &str) -> DeviceState {
    let config = json!({
        "hostAddress": address,
        "fingerprint": "ab".repeat(32),
        "hostId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
        "deviceId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        "kind": "station",
        "lineId": null,
        "deviceKey": secret_store::protect("device-key-value").unwrap(),
    });
    std::fs::write(
        device_config::path(dir),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    DeviceState::load(dir.to_path_buf())
}

#[tokio::test]
async fn a_request_past_its_own_limit_fails_with_timeout() {
    let app_dir = tempfile::tempdir().unwrap();
    let station = paired_with(app_dir.path(), &silent_address());

    let started = Instant::now();
    let answer = tokio::time::timeout(
        Duration::from_secs(5),
        station.request_within("GET", "/v1/device/shifts", None, None, Some(300)),
    )
    .await
    .expect("the request ends at its own limit, long before the test's");
    let elapsed = started.elapsed();

    assert_eq!(answer, Err(DeviceError::Request(RequestError::Timeout)));
    // Well before the client's own 2 s to connect (the silent host never
    // finishes the TLS handshake), so it was this request's limit that ended it.
    assert!(
        elapsed >= Duration::from_millis(300) && elapsed < Duration::from_millis(1500),
        "{elapsed:?}"
    );
}

/// A limit above the client's own 2 s to connect does not turn that 2 s into
/// `timeout`: the host that never finishes connecting is `unreachable`, and
/// it is the client's limit that ended the request, not the caller's.
#[tokio::test]
async fn a_host_that_never_accepts_the_connection_is_unreachable_not_a_timeout() {
    let app_dir = tempfile::tempdir().unwrap();
    let station = paired_with(app_dir.path(), &silent_address());

    let started = Instant::now();
    let answer = tokio::time::timeout(
        Duration::from_secs(8),
        station.request_within("GET", "/v1/device/shifts", None, None, Some(5_000)),
    )
    .await
    .expect("the client's own limit ends the request before the test's");
    let elapsed = started.elapsed();

    assert_eq!(answer, Err(DeviceError::Request(RequestError::Unreachable)));
    // Ended by the client's 2 s to connect, well before the caller's 5 s.
    assert!(elapsed < Duration::from_millis(4_000), "{elapsed:?}");
}

/// Without `timeoutMs` nothing changes: the client's own limits still end a
/// hung request (here its 2 s to connect, which covers the TLS handshake the
/// silent host never finishes), and it still reads as `unreachable`, as
/// every screen of stage 1 expects.
#[tokio::test]
async fn a_request_without_a_limit_still_ends_as_unreachable() {
    let app_dir = tempfile::tempdir().unwrap();
    let station = paired_with(app_dir.path(), &silent_address());

    let answer = tokio::time::timeout(
        Duration::from_secs(20),
        station.request_within("GET", "/v1/device", None, None, None),
    )
    .await
    .expect("the client's own limits end the request");

    assert_eq!(answer, Err(DeviceError::Request(RequestError::Unreachable)));
}

#[tokio::test]
async fn a_limit_outside_its_bounds_is_refused_before_any_io() {
    let app_dir = tempfile::tempdir().unwrap();
    let station = paired_with(app_dir.path(), &closed_address());

    for ms in [0, 99, 10_001] {
        assert_eq!(
            station
                .request_within("GET", "/v1/device", None, None, Some(ms))
                .await,
            Err(DeviceError::Request(RequestError::InvalidRequest)),
            "{ms}"
        );
    }
    // Inside the bounds the request does go out, and finds the port closed:
    // the refusals above came before any connection.
    assert_eq!(
        station
            .request_within("GET", "/v1/device", None, None, Some(100))
            .await,
        Err(DeviceError::Request(RequestError::Unreachable))
    );
}

/// The limit covers reading the body too, not only waiting for the answer's
/// start: the host's change stream answers at once and then never ends, so
/// the request is past its limit with the headers already in. That is still
/// `timeout`, while the same read without a limit is the client's own
/// `unreachable` (10 s, not waited for here).
#[tokio::test]
async fn a_body_that_never_ends_is_a_timeout_too() {
    let host_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let host = start(
        &HostPaths::new(host_dir.path()),
        StartOptions {
            port_override: None,
            bind: Some("127.0.0.1:0".parse().unwrap()),
        },
    )
    .await
    .unwrap();
    let station = DeviceState::load(app_dir.path().to_path_buf());
    station
        .local_pair(&format!("https://{}", host.addr), "Станция", "0.1.0")
        .await
        .unwrap();
    let link = station
        .watch_link()
        .borrow()
        .clone()
        .expect("a paired device has a link");
    let client = PinnedClient::new(&link.address, &link.fingerprint).unwrap();

    let started = Instant::now();
    let answer = tokio::time::timeout(
        Duration::from_secs(5),
        client.send_within(
            "GET",
            "/v1/changes/stream",
            None,
            Credentials {
                device_key: Some(link.key()),
                office_token: None,
            },
            Some(Duration::from_millis(300)),
        ),
    )
    .await
    .expect("the request ends at its own limit, long before the test's");
    let elapsed = started.elapsed();

    assert_eq!(answer, Err(RequestError::Timeout));
    assert!(elapsed >= Duration::from_millis(300), "{elapsed:?}");
    host.stop().await.unwrap();
}
