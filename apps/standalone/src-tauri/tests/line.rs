//! Line selection, the station adopting the line the office assigns, and the
//! webview's route list against a real `markiro-host` on 127.0.0.1 (stage 1
//! spec §5.1–5.2).

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

/// A station paired over loopback with the wizard done (one line), and the
/// office session of the administrator the wizard created on it.
async fn office_station(host: &RunningHost, dir: &Path) -> (DeviceState, String) {
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
    let token = created.body.unwrap()["session"]["token"]
        .as_str()
        .unwrap()
        .to_owned();
    (station, token)
}

/// A station paired over loopback with the wizard done (one line).
async fn paired_station(host: &RunningHost, dir: &Path) -> DeviceState {
    office_station(host, dir).await.0
}

/// Another line, added in the office.
async fn office_line(station: &DeviceState, token: &str, name: &str) -> String {
    let created = station
        .request(
            "POST",
            "/v1/office/lines",
            Some(&json!({ "name": name })),
            Some(token),
        )
        .await
        .unwrap();
    assert_eq!(created.status, 200, "{:?}", created.body);
    created.body.unwrap()["id"].as_str().unwrap().to_owned()
}

/// The office sets this station's line, or clears it with `None`.
async fn assign_line(station: &DeviceState, token: &str, line_id: Option<&str>) {
    let device_id = station.status().unwrap().unwrap().device_id;
    let updated = station
        .request(
            "PUT",
            &format!("/v1/office/devices/{device_id}"),
            Some(&json!({ "lineId": line_id })),
            Some(token),
        )
        .await
        .unwrap();
    assert_eq!(updated.status, 200, "{:?}", updated.body);
}

/// The line the host has for this station (`GET /v1/device`).
async fn host_line(station: &DeviceState) -> Value {
    let device = station
        .request("GET", "/v1/device", None, None)
        .await
        .unwrap();
    device.body.unwrap()["lineId"].clone()
}

/// The line `device.json` holds, read as the app does at start.
fn saved_line(dir: &Path) -> Option<String> {
    DeviceState::load(dir.to_path_buf())
        .status()
        .unwrap()
        .unwrap()
        .line_id
}

/// The name `device.json` holds, read as the app does at start.
fn saved_name(dir: &Path) -> Option<String> {
    DeviceState::load(dir.to_path_buf())
        .status()
        .unwrap()
        .unwrap()
        .device_name
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
        device_name: None,
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
async fn a_station_adopts_the_line_the_office_assigns_and_keeps_it_across_restarts() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (station, token) = office_station(&host, station_dir.path()).await;
    let first = line_ids(&station).await.remove(0);
    station.select_line(&first).await.unwrap();
    let second = office_line(&station, &token, "Линия 2").await;

    assign_line(&station, &token, Some(&second)).await;
    let status = station.refresh().await.unwrap();
    assert_eq!(status.line_id.as_deref(), Some(second.as_str()));
    assert_eq!(station.status(), Ok(Some(status)));
    assert_eq!(saved_line(station_dir.path()), Some(second));
    host.stop().await.unwrap();
}

/// A rename in the office reaches the station with its next refresh (plan
/// 2a4): the floor's status bar names the station, and the name survives a
/// restart without the host.
#[tokio::test]
async fn a_station_takes_the_name_the_office_gives_it() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (station, token) = office_station(&host, station_dir.path()).await;
    let line = line_ids(&station).await.remove(0);
    let chosen = station.select_line(&line).await.unwrap();
    assert_eq!(chosen.device_name.as_deref(), Some("Рабочее место хоста"));
    let device_id = chosen.device_id.clone();
    let renamed = station
        .request(
            "PUT",
            &format!("/v1/office/devices/{device_id}"),
            Some(&json!({ "name": "  Станция упаковки " })),
            Some(&token),
        )
        .await
        .unwrap();
    assert_eq!(renamed.status, 200, "{:?}", renamed.body);

    let refreshed = station.refresh().await.unwrap();
    assert_eq!(refreshed.device_name.as_deref(), Some("Станция упаковки"));
    assert_eq!(refreshed.line_id, chosen.line_id);
    assert_eq!(station.status(), Ok(Some(refreshed.clone())));
    let reloaded = DeviceState::load(station_dir.path().to_path_buf());
    assert_eq!(reloaded.status(), Ok(Some(refreshed)));
    host.stop().await.unwrap();
}

/// Choosing a line reads the host's record of the device too, so a rename
/// that the station has not fetched yet arrives with it, even when the line
/// chosen is the one already kept.
#[tokio::test]
async fn choosing_a_line_brings_a_rename_with_it() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (station, token) = office_station(&host, station_dir.path()).await;
    let line = line_ids(&station).await.remove(0);
    let chosen = station.select_line(&line).await.unwrap();
    let renamed = station
        .request(
            "PUT",
            &format!("/v1/office/devices/{}", chosen.device_id),
            Some(&json!({ "name": "Станция сортировки" })),
            Some(&token),
        )
        .await
        .unwrap();
    assert_eq!(renamed.status, 200, "{:?}", renamed.body);
    assert_eq!(station.status(), Ok(Some(chosen.clone())));

    let again = station.select_line(&line).await.unwrap();
    assert_eq!(again.device_name.as_deref(), Some("Станция сортировки"));
    assert_eq!(again.line_id, chosen.line_id);
    let reloaded = DeviceState::load(station_dir.path().to_path_buf());
    assert_eq!(reloaded.status(), Ok(Some(again)));
    host.stop().await.unwrap();
}

#[tokio::test]
async fn a_refresh_that_finds_the_same_line_and_name_writes_nothing() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (station, _token) = office_station(&host, station_dir.path()).await;
    let line = line_ids(&station).await.remove(0);
    let chosen = station.select_line(&line).await.unwrap();
    let config = device_config::path(station_dir.path());
    let before = std::fs::read(&config).unwrap();
    #[cfg(unix)]
    let inode = std::os::unix::fs::MetadataExt::ino(&std::fs::metadata(&config).unwrap());

    assert_eq!(station.refresh().await, Ok(chosen));
    assert_eq!(std::fs::read(&config).unwrap(), before);
    // `device_config::save` writes a new file and renames it into place, so
    // an untouched inode shows that nothing was written at all.
    #[cfg(unix)]
    assert_eq!(
        std::os::unix::fs::MetadataExt::ino(&std::fs::metadata(&config).unwrap()),
        inode
    );
    host.stop().await.unwrap();
}

#[tokio::test]
async fn a_line_the_office_clears_is_cleared_on_the_station() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (station, token) = office_station(&host, station_dir.path()).await;
    let line = line_ids(&station).await.remove(0);
    station.select_line(&line).await.unwrap();

    assign_line(&station, &token, None).await;
    assert_eq!(station.refresh().await.unwrap().line_id, None);
    assert_eq!(station.status().unwrap().unwrap().line_id, None);
    assert_eq!(saved_line(station_dir.path()), None);
    host.stop().await.unwrap();
}

/// Offline first: with the host away the station keeps working on its line.
#[tokio::test]
async fn an_unreachable_host_leaves_the_line_alone() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (station, token) = office_station(&host, station_dir.path()).await;
    let first = line_ids(&station).await.remove(0);
    station.select_line(&first).await.unwrap();
    let second = office_line(&station, &token, "Линия 2").await;
    assign_line(&station, &token, Some(&second)).await;
    let name = station.status().unwrap().unwrap().device_name;
    assert_eq!(name.as_deref(), Some("Рабочее место хоста"));
    host.stop().await.unwrap();

    assert_eq!(
        station.refresh().await,
        Err(DeviceError::Request(RequestError::Unreachable))
    );
    assert_eq!(
        station.status().unwrap().unwrap().line_id.as_deref(),
        Some(first.as_str())
    );
    // The name is kept as well, in memory and on disk: a host that cannot be
    // asked does not clear what it last said.
    assert_eq!(station.status().unwrap().unwrap().device_name, name);
    assert_eq!(saved_line(station_dir.path()), Some(first));
    assert_eq!(saved_name(station_dir.path()), name);
}

/// A `device.json` whose key the host never issued (as after a revocation).
#[tokio::test]
async fn a_refresh_with_a_key_the_host_does_not_know_is_rejected() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let config = DeviceConfig {
        host_address: address(&host),
        fingerprint: host.fingerprint.clone(),
        host_id: host.host_id.clone(),
        device_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7".into(),
        kind: DeviceKind::Station,
        line_id: Some(UNKNOWN_LINE.into()),
        device_name: Some("Станция упаковки".into()),
        device_key: secret_store::protect("not-a-key-the-host-issued").unwrap(),
    };
    device_config::save(station_dir.path(), &config).unwrap();
    let station = DeviceState::load(station_dir.path().to_path_buf());

    assert_eq!(station.refresh().await, Err(DeviceError::KeyRejected));
    assert_eq!(
        station.status().unwrap().unwrap().line_id.as_deref(),
        Some(UNKNOWN_LINE)
    );
    // A refused key keeps the name too, in memory and on disk.
    assert_eq!(
        station.status().unwrap().unwrap().device_name.as_deref(),
        Some("Станция упаковки")
    );
    assert_eq!(
        saved_name(station_dir.path()).as_deref(),
        Some("Станция упаковки")
    );
    host.stop().await.unwrap();
}

#[tokio::test]
async fn a_refresh_needs_a_pairing() {
    let station_dir = tempfile::tempdir().unwrap();
    let station = DeviceState::load(station_dir.path().to_path_buf());
    assert_eq!(station.refresh().await, Err(DeviceError::NotPaired));
}

/// A refresh holds the pairing lock like `select_line`: a forget that starts
/// while the host is still answering waits for it, so the answer cannot
/// write `device.json` back after the forget removed it.
#[tokio::test]
async fn a_refresh_does_not_bring_back_a_forgotten_pairing() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (station, token) = office_station(&host, station_dir.path()).await;
    let line = line_ids(&station).await.remove(0);
    // The station has no line yet; the office's line makes the refresh write.
    assign_line(&station, &token, Some(&line)).await;

    let (refreshed, forgotten) = tokio::join!(station.refresh(), station.forget());
    assert_eq!(refreshed.unwrap().line_id.as_deref(), Some(line.as_str()));
    forgotten.unwrap();
    assert_eq!(station.status(), Ok(None));
    assert!(!device_config::path(station_dir.path()).exists());
    host.stop().await.unwrap();
}

/// A refresh reads the pairing only once it holds the lock: one queued behind
/// a forget finds no pairing and writes nothing. The test above always lets
/// `refresh` take the lock first, so it cannot tell `refresh` from one that
/// read the pairing before waiting for the lock; this one queues it. The first
/// poll of `join!` goes through its futures in the order given, and tokio's
/// mutex hands the lock out first come, first served (`sync/mutex.rs`), so
/// `select_line` holds the lock across its `PUT`, and the forget and then the
/// refresh wait behind it. A refresh that had read the pairing earlier would
/// still hold the one the forget removed: it would ask the host with that key
/// and write the line the choice just made back into `device.json`.
#[tokio::test]
async fn a_refresh_queued_behind_a_forget_finds_no_pairing() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let station = paired_station(&host, station_dir.path()).await;
    let line = line_ids(&station).await.remove(0);

    let (selected, forgotten, refreshed) = tokio::join!(
        station.select_line(&line),
        station.forget(),
        station.refresh()
    );
    assert_eq!(selected.unwrap().line_id.as_deref(), Some(line.as_str()));
    forgotten.unwrap();
    assert_eq!(refreshed, Err(DeviceError::NotPaired));
    assert_eq!(station.status(), Ok(None));
    assert!(!device_config::path(station_dir.path()).exists());
    host.stop().await.unwrap();
}

/// A refresh and a line choice at the same moment end on the line the host
/// took last, on the host, in memory and in `device.json` alike. Every round
/// the office puts the station on `second` while the station chooses
/// `first`: after round 0 the station's own line is `first`, so the office's
/// line is a real change for the refresh to adopt. Were the answer to that
/// read taken after the choice, it would write `second` over it — which the
/// assertions below see. (Assigning the station's current line instead
/// would leave the refresh nothing to write, and the race nothing to show.)
#[tokio::test]
async fn a_refresh_and_a_line_choice_never_undo_each_other() {
    let host_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (station, token) = office_station(&host, station_dir.path()).await;
    let first = line_ids(&station).await.remove(0);
    let second = office_line(&station, &token, "Линия 2").await;
    let (assigned, chosen) = (&second, &first);
    for round in 0..6 {
        assign_line(&station, &token, Some(assigned)).await;
        let (refreshed, selected) = tokio::join!(station.refresh(), station.select_line(chosen));
        refreshed.unwrap();
        assert_eq!(selected.unwrap().line_id.as_deref(), Some(chosen.as_str()));
        assert_eq!(host_line(&station).await, json!(chosen), "round {round}");
        assert_eq!(
            station.status().unwrap().unwrap().line_id.as_deref(),
            Some(chosen.as_str()),
            "round {round}"
        );
        assert_eq!(
            saved_line(station_dir.path()).as_deref(),
            Some(chosen.as_str()),
            "round {round}"
        );
    }
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
    for (method, path) in [
        ("GET", "/v1/changes/stream"),
        ("PUT", "/v1/device/line"),
        // A `.` segment the `url` crate would collapse to `/v1/device/line`,
        // bypassing `webview_may_reach`'s `LINE_ROUTE` exclusion were
        // `validate_path` not also refusing it.
        ("PUT", "/v1/device/./line"),
        // A trailing slash: `webview_may_reach`'s string-level `LINE_ROUTE`
        // exclusion does not match it either, so `validate_path` is what
        // stops it from ever reaching the host.
        ("PUT", "/v1/device/line/"),
    ] {
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
