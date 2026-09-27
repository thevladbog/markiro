//! Line selection and the webview's route list against a real `markiro-host`
//! on 127.0.0.1 (stage 1 spec §5.1–5.2).

use std::path::Path;

use markiro_host::config::HostPaths;
use markiro_host::{start, RunningHost, StartOptions};
use markiro_proto::DeviceKind;
use markiro_standalone_lib::device::{DeviceError, DeviceState};
use markiro_standalone_lib::device_config::{self, DeviceConfig};
use markiro_standalone_lib::host_client::RequestError;
use markiro_standalone_lib::secret_store;
use serde_json::{json, Value};

const BOOTSTRAP: &str = include_str!("../../proto/fixtures/bootstrap-request.json");
const UNKNOWN_LINE: &str = "9b2e4a6c-0000-4000-8000-000000000000";

async fn start_host(dir: &Path) -> RunningHost {
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

/// A station paired over loopback with the wizard done (one line).
async fn paired_station(host: &RunningHost, dir: &Path) -> DeviceState {
    let station = DeviceState::load(dir.to_path_buf());
    station
        .local_pair(&address(host), "Рабочее место хоста", "0.1.0")
        .await
        .unwrap();
    let wizard: Value = serde_json::from_str(BOOTSTRAP).unwrap();
    let created = station
        .request("POST", "/v1/bootstrap", Some(&wizard), None)
        .await
        .unwrap();
    assert_eq!(created.status, 200, "{:?}", created.body);
    station
}

/// The ids of the host's lines, read from the change feed as the webview does.
async fn line_ids(station: &DeviceState) -> Vec<String> {
    let feed = station
        .request("GET", "/v1/changes?since=0", None, None)
        .await
        .unwrap();
    assert_eq!(feed.status, 200, "{:?}", feed.body);
    feed.body.unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["entity"] == "lines")
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn a_station_chooses_its_line_and_keeps_it_across_restarts() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let station = paired_station(&host, station_dir.path()).await;
    let lines = line_ids(&station).await;
    assert_eq!(lines.len(), 1);

    let status = station.select_line(&lines[0]).await.unwrap();
    assert_eq!(status.line_id.as_deref(), Some(lines[0].as_str()));
    let reloaded = DeviceState::load(station_dir.path().to_path_buf());
    assert_eq!(reloaded.status(), Ok(Some(status)));
    let device = reloaded
        .request("GET", "/v1/device", None, None)
        .await
        .unwrap();
    assert_eq!(device.body.unwrap()["lineId"], lines[0]);
    host.stop().await.unwrap();
}

#[tokio::test]
async fn an_unknown_line_is_rejected_and_nothing_is_saved() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let station = paired_station(&host, station_dir.path()).await;

    assert_eq!(
        station.select_line(UNKNOWN_LINE).await,
        Err(DeviceError::LineRejected)
    );
    assert_eq!(station.status().unwrap().unwrap().line_id, None);
    let reloaded = DeviceState::load(station_dir.path().to_path_buf());
    assert_eq!(reloaded.status().unwrap().unwrap().line_id, None);
    host.stop().await.unwrap();
}

/// A `device.json` whose key the host never issued (as after a revocation).
#[tokio::test]
async fn a_key_the_host_does_not_know_is_rejected() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let config = DeviceConfig {
        host_address: address(&host),
        fingerprint: host.fingerprint.clone(),
        host_id: host.host_id.clone(),
        device_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7".into(),
        kind: DeviceKind::Station,
        line_id: None,
        device_key: secret_store::protect("not-a-key-the-host-issued").unwrap(),
    };
    device_config::save(station_dir.path(), &config).unwrap();
    let station = DeviceState::load(station_dir.path().to_path_buf());

    assert_eq!(
        station.select_line(UNKNOWN_LINE).await,
        Err(DeviceError::KeyRejected)
    );
    host.stop().await.unwrap();
}

#[tokio::test]
async fn line_selection_needs_a_pairing() {
    let station_dir = tempfile::tempdir().unwrap();
    let station = DeviceState::load(station_dir.path().to_path_buf());
    assert_eq!(
        station.select_line(UNKNOWN_LINE).await,
        Err(DeviceError::NotPaired)
    );
}

#[tokio::test]
async fn the_webview_reaches_the_feed_but_not_the_stream_or_the_line_route() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let station = paired_station(&host, station_dir.path()).await;

    let feed = station
        .request("GET", "/v1/changes?since=0&limit=10", None, None)
        .await
        .unwrap();
    assert_eq!(feed.status, 200);
    assert_eq!(feed.body.unwrap()["hostId"], host.host_id);
    for (method, path) in [("GET", "/v1/changes/stream"), ("PUT", "/v1/device/line")] {
        assert_eq!(
            station
                .request(method, path, Some(&json!({ "lineId": UNKNOWN_LINE })), None)
                .await,
            Err(DeviceError::Request(RequestError::InvalidRequest)),
            "{method} {path}"
        );
    }
    host.stop().await.unwrap();
}
