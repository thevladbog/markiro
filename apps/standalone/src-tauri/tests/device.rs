//! The paired-device layer against a real `markiro-host` on 127.0.0.1.

use markiro_host::config::HostPaths;
use markiro_host::{start, RunningHost, StartOptions};
use markiro_standalone_lib::device::{DeviceError, DeviceState};
use markiro_standalone_lib::host_client::{Credentials, PinnedClient, RequestError};
use markiro_standalone_lib::host_probe::ProbeError;
use serde_json::json;

const NAME: &str = "Рабочее место хоста";

async fn start_host(dir: &std::path::Path) -> RunningHost {
    start(
        &HostPaths::new(dir),
        StartOptions {
            port_override: None,
            bind: Some("127.0.0.1:0".parse().unwrap()),
        },
    )
    .await
    .unwrap()
}

fn address(host: &RunningHost) -> String {
    format!("https://{}", host.addr)
}

/// A local address where nothing listens.
fn closed_address() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    format!("https://127.0.0.1:{port}")
}

#[tokio::test]
async fn pairs_locally_and_remembers_the_pinned_host() {
    let host_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let state = DeviceState::load(app_dir.path().to_path_buf());
    assert_eq!(state.status(), Ok(None));

    let status = state
        .local_pair(&address(&host), NAME, "0.1.0")
        .await
        .unwrap();
    assert_eq!(status.host_address, address(&host));
    assert_eq!(status.fingerprint, host.fingerprint);
    assert_eq!(status.host_id, host.host_id);
    assert_eq!(status.line_id, None);

    let reloaded = DeviceState::load(app_dir.path().to_path_buf());
    assert_eq!(reloaded.status(), Ok(Some(status.clone())));
    let response = reloaded
        .request("GET", "/v1/device", None, None)
        .await
        .unwrap();
    assert_eq!(response.status, 200);
    let body = response.body.unwrap();
    assert_eq!(body["id"], status.device_id);
    assert_eq!(body["kind"], "station");
    assert_eq!(body["name"], NAME);

    assert_eq!(
        state.local_pair(&address(&host), NAME, "0.1.0").await,
        Err(DeviceError::AlreadyPaired)
    );
    host.stop().await.unwrap();
}

#[tokio::test]
async fn concurrent_local_pairing_pairs_once() {
    let host_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let state = DeviceState::load(app_dir.path().to_path_buf());
    let address = address(&host);
    let (first, second) = tokio::join!(
        state.local_pair(&address, NAME, "0.1.0"),
        state.local_pair(&address, NAME, "0.1.0")
    );
    let results = [first, second];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert!(results
        .iter()
        .any(|result| result == &Err(DeviceError::AlreadyPaired)));
    host.stop().await.unwrap();
}

#[tokio::test]
async fn requests_carry_the_device_key_and_the_office_token() {
    let host_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let state = DeviceState::load(app_dir.path().to_path_buf());
    state
        .local_pair(&address(&host), NAME, "0.1.0")
        .await
        .unwrap();

    let refused = state
        .request("GET", "/v1/office/me", None, None)
        .await
        .unwrap();
    assert_eq!(refused.status, 401);
    let body = refused.body.unwrap();
    assert_eq!(body["error"]["code"], "unauthorized");
    assert_eq!(body["error"]["details"]["credential"], "session");

    let wizard = json!({
        "admin": { "login": "admin", "name": "Ирина Смирнова", "password": "correct horse battery" },
        "org": { "name": "ООО «Атолл»", "gln": "4600682000013", "gs1Prefixes": [], "timeZone": "Europe/Moscow" },
        "sscc": { "boxNextSerial": 1, "palletNextSerial": 0 },
        "lines": ["Линия 1"]
    });
    let created = state
        .request("POST", "/v1/bootstrap", Some(&wizard), None)
        .await
        .unwrap();
    assert_eq!(created.status, 200, "{:?}", created.body);
    let token = created.body.unwrap()["session"]["token"]
        .as_str()
        .unwrap()
        .to_owned();

    let me = state
        .request("GET", "/v1/office/me", None, Some(&token))
        .await
        .unwrap();
    assert_eq!(me.status, 200);
    assert_eq!(me.body.unwrap()["login"], "admin");

    let logout = state
        .request("POST", "/v1/office/logout", None, Some(&token))
        .await
        .unwrap();
    assert_eq!((logout.status, logout.body), (204, None));
    host.stop().await.unwrap();
}

#[tokio::test]
async fn a_different_certificate_is_refused() {
    let host_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let client = PinnedClient::new(&address(&host), &"00".repeat(32)).unwrap();
    assert_eq!(
        client
            .send("GET", "/v1/hello", None, Credentials::default())
            .await,
        Err(RequestError::CertificateMismatch)
    );
    host.stop().await.unwrap();
}

#[tokio::test]
async fn a_closed_port_is_unreachable() {
    let client = PinnedClient::new(&closed_address(), &"00".repeat(32)).unwrap();
    assert_eq!(
        client
            .send("GET", "/v1/hello", None, Credentials::default())
            .await,
        Err(RequestError::Unreachable)
    );
}

#[tokio::test]
async fn pairing_without_a_host_reports_the_probe_error() {
    let app_dir = tempfile::tempdir().unwrap();
    let state = DeviceState::load(app_dir.path().to_path_buf());
    assert_eq!(
        state.local_pair(&closed_address(), NAME, "0.1.0").await,
        Err(DeviceError::Probe(ProbeError::Unreachable))
    );
    assert_eq!(state.status(), Ok(None));
}

#[tokio::test]
async fn an_unpaired_device_sends_nothing() {
    let app_dir = tempfile::tempdir().unwrap();
    let state = DeviceState::load(app_dir.path().to_path_buf());
    assert_eq!(
        state.request("GET", "/v1/device", None, None).await,
        Err(DeviceError::NotPaired)
    );
}

#[tokio::test]
async fn forgetting_allows_pairing_again() {
    let host_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let state = DeviceState::load(app_dir.path().to_path_buf());
    let first = state
        .local_pair(&address(&host), NAME, "0.1.0")
        .await
        .unwrap();
    state.forget().await.unwrap();
    assert_eq!(state.status(), Ok(None));
    assert!(!app_dir.path().join("device.json").exists());
    let second = state
        .local_pair(&address(&host), NAME, "0.1.0")
        .await
        .unwrap();
    assert_ne!(first.device_id, second.device_id);
    host.stop().await.unwrap();
}

#[tokio::test]
async fn an_unreadable_config_is_reported_until_forgotten() {
    let app_dir = tempfile::tempdir().unwrap();
    std::fs::write(app_dir.path().join("device.json"), "{").unwrap();
    let state = DeviceState::load(app_dir.path().to_path_buf());
    assert_eq!(state.status(), Err(DeviceError::ConfigUnreadable));
    assert_eq!(
        state.request("GET", "/v1/device", None, None).await,
        Err(DeviceError::ConfigUnreadable)
    );
    state.forget().await.unwrap();
    assert_eq!(state.status(), Ok(None));
    assert!(!app_dir.path().join("device.json").exists());
}

/// F1: pairing answers carry a new device key, so `host_request` must never
/// forward them, even from a device that is already paired.
#[tokio::test]
async fn pairing_routes_are_not_reachable_through_host_request() {
    let host_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let state = DeviceState::load(app_dir.path().to_path_buf());
    state
        .local_pair(&address(&host), NAME, "0.1.0")
        .await
        .unwrap();

    let pair_again = json!({
        "kind": "office",
        "name": "Пробуем перевыпустить ключ",
        "appVersion": "0.1.0",
        "capabilities": []
    });
    assert_eq!(
        state
            .request("POST", "/v1/local-pair", Some(&pair_again), None)
            .await,
        Err(DeviceError::Request(RequestError::InvalidRequest))
    );
    assert_eq!(
        state
            .request("POST", "/v1/pairing/claim", Some(&pair_again), None)
            .await,
        Err(DeviceError::Request(RequestError::InvalidRequest))
    );
    assert_eq!(
        state.request("GET", "/v1/hello", None, None).await,
        Err(DeviceError::Request(RequestError::InvalidRequest))
    );
    host.stop().await.unwrap();
}

/// F6: an invalid header value must fail on the `RequestBuilder` before the
/// client ever tries to connect; a closed port proves no I/O was attempted.
#[tokio::test]
async fn a_malformed_office_token_is_invalid_before_any_io() {
    let client = PinnedClient::new(&closed_address(), &"00".repeat(32)).unwrap();
    assert_eq!(
        client
            .send(
                "GET",
                "/v1/device",
                None,
                Credentials {
                    device_key: None,
                    office_token: Some("bad\ntoken"),
                },
            )
            .await,
        Err(RequestError::InvalidRequest)
    );
}

/// F8: the host's own validation (name 1-100 characters) surfaces as
/// `PairRejected`, and the failed attempt leaves nothing paired.
#[tokio::test]
async fn a_name_longer_than_the_hosts_limit_is_rejected() {
    let host_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let state = DeviceState::load(app_dir.path().to_path_buf());
    let too_long = "И".repeat(101);
    assert_eq!(
        state.local_pair(&address(&host), &too_long, "0.1.0").await,
        Err(DeviceError::PairRejected)
    );
    assert_eq!(state.status(), Ok(None));
    host.stop().await.unwrap();
}

/// F8: `local_pair` also refuses to run while `device.json` is unreadable.
#[tokio::test]
async fn local_pair_on_an_unreadable_config_is_reported() {
    let host_dir = tempfile::tempdir().unwrap();
    let app_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    std::fs::write(app_dir.path().join("device.json"), "{").unwrap();
    let state = DeviceState::load(app_dir.path().to_path_buf());
    assert_eq!(
        state.local_pair(&address(&host), NAME, "0.1.0").await,
        Err(DeviceError::ConfigUnreadable)
    );
    host.stop().await.unwrap();
}
