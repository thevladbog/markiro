//! Pairing by code against a real `markiro-host` on 127.0.0.1: an office
//! installation creates a one-time code, a second installation claims it
//! with the host's fingerprint (stage 1 spec §4.7).

use std::path::Path;

use markiro_host::config::HostPaths;
use markiro_host::{start, RunningHost, StartOptions};
use markiro_proto::DeviceKind;
use markiro_standalone_lib::device::{DeviceError, DeviceState};
use markiro_standalone_lib::host_client::RequestError;
use markiro_standalone_lib::host_probe::ProbeError;
use serde_json::Value;

const BOOTSTRAP: &str = include_str!("../../proto/fixtures/bootstrap-request.json");
const STATION: &str = "Станция на линии 2";
const WRONG_CODE: &str = "0000000000";

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

/// A local address where nothing listens.
fn closed_address() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    format!("https://127.0.0.1:{port}")
}

/// The host PC's own installation, paired over loopback with the wizard
/// done; returns it and the administrator's session token.
async fn office(host: &RunningHost, dir: &Path) -> (DeviceState, String) {
    let office = DeviceState::load(dir.to_path_buf());
    office
        .local_pair(&address(host), "Рабочее место хоста", "0.1.0")
        .await
        .unwrap();
    let wizard: Value = serde_json::from_str(BOOTSTRAP).unwrap();
    let created = office
        .request("POST", "/v1/bootstrap", Some(&wizard), None)
        .await
        .unwrap();
    assert_eq!(created.status, 200, "{:?}", created.body);
    let token = created.body.unwrap()["session"]["token"]
        .as_str()
        .unwrap()
        .to_owned();
    (office, token)
}

/// A fresh one-time code from the office.
async fn new_code(office: &DeviceState, token: &str) -> String {
    let created = office
        .request("POST", "/v1/office/pairing-codes", None, Some(token))
        .await
        .unwrap();
    assert_eq!(created.status, 200, "{:?}", created.body);
    created.body.unwrap()["code"].as_str().unwrap().to_owned()
}

/// Plan 2a4: a station that paired by code keeps the name the host stores
/// for it, without the spaces it was typed with.
#[tokio::test]
async fn a_station_paired_by_code_keeps_the_trimmed_name() {
    let host_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (office, token) = office(&host, office_dir.path()).await;
    let code = new_code(&office, &token).await;

    let station = DeviceState::load(station_dir.path().to_path_buf());
    let status = station
        .claim(
            &address(&host),
            &host.fingerprint,
            &code,
            &format!("  {STATION} "),
            "0.1.0",
        )
        .await
        .unwrap();
    assert_eq!(status.device_name.as_deref(), Some(STATION));
    let reloaded = DeviceState::load(station_dir.path().to_path_buf());
    assert_eq!(reloaded.status(), Ok(Some(status)));
    host.stop().await.unwrap();
}

#[tokio::test]
async fn a_second_device_pairs_with_a_code_and_the_confirmed_fingerprint() {
    let host_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (office, token) = office(&host, office_dir.path()).await;
    let code = new_code(&office, &token).await;

    // Typed the way a person copies it from the office screen: lower case,
    // split in two. The typed form pairs.
    let typed = format!("{}-{}", &code[..5], &code[5..]).to_lowercase();
    let station = DeviceState::load(station_dir.path().to_path_buf());
    let status = station
        .claim(&address(&host), &host.fingerprint, &typed, STATION, "0.1.0")
        .await
        .unwrap();
    assert_eq!(status.host_address, address(&host));
    assert_eq!(status.fingerprint, host.fingerprint);
    assert_eq!(status.host_id, host.host_id);
    assert_eq!(status.kind, DeviceKind::Station);
    assert_eq!(status.line_id, None);

    let reloaded = DeviceState::load(station_dir.path().to_path_buf());
    assert_eq!(reloaded.status(), Ok(Some(status.clone())));
    let device = reloaded
        .request("GET", "/v1/device", None, None)
        .await
        .unwrap();
    assert_eq!(device.status, 200);
    let body = device.body.unwrap();
    assert_eq!(body["id"], status.device_id);
    assert_eq!(body["kind"], "station");
    assert_eq!(body["name"], STATION);

    assert_eq!(
        station
            .claim(&address(&host), &host.fingerprint, &code, STATION, "0.1.0")
            .await,
        Err(DeviceError::AlreadyPaired)
    );
    host.stop().await.unwrap();
}

/// With another fingerprint the code never leaves the device: had it reached
/// the host, the host would have paired it, and the same code would not pair
/// afterwards.
#[tokio::test]
async fn another_fingerprint_keeps_the_code_on_the_device() {
    let host_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (office, token) = office(&host, office_dir.path()).await;
    let code = new_code(&office, &token).await;

    let station = DeviceState::load(station_dir.path().to_path_buf());
    assert_eq!(
        station
            .claim(&address(&host), &"0".repeat(64), &code, STATION, "0.1.0")
            .await,
        Err(DeviceError::Request(RequestError::CertificateMismatch))
    );
    assert_eq!(station.status(), Ok(None));
    assert!(station
        .claim(&address(&host), &host.fingerprint, &code, STATION, "0.1.0")
        .await
        .is_ok());
    host.stop().await.unwrap();
}

#[tokio::test]
async fn refused_codes_come_back_as_their_own_errors() {
    let host_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let other_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (office, token) = office(&host, office_dir.path()).await;
    let code = new_code(&office, &token).await;
    let station = DeviceState::load(station_dir.path().to_path_buf());
    let claim = |code: String| {
        let station = &station;
        let host = &host;
        async move {
            station
                .claim(&address(host), &host.fingerprint, &code, STATION, "0.1.0")
                .await
        }
    };

    assert_eq!(
        claim(WRONG_CODE.to_owned()).await,
        Err(DeviceError::CodeInvalid)
    );
    // Another device takes the code first: a used code is refused like an unknown one.
    DeviceState::load(other_dir.path().to_path_buf())
        .claim(
            &address(&host),
            &host.fingerprint,
            &code,
            "Станция 3",
            "0.1.0",
        )
        .await
        .unwrap();
    assert_eq!(claim(code.clone()).await, Err(DeviceError::CodeInvalid));
    assert_eq!(station.status(), Ok(None));

    // The host allows 10 claims a minute from one address: 3 are spent.
    let mut outcomes = Vec::new();
    for _ in 0..8 {
        outcomes.push(claim(WRONG_CODE.to_owned()).await);
    }
    assert!(
        outcomes[..7]
            .iter()
            .all(|outcome| *outcome == Err(DeviceError::CodeInvalid)),
        "{outcomes:?}"
    );
    assert_eq!(outcomes[7], Err(DeviceError::RateLimited));
    assert_eq!(station.status(), Ok(None));
    host.stop().await.unwrap();
}

#[tokio::test]
async fn a_malformed_fingerprint_or_code_is_refused_before_any_io() {
    let station_dir = tempfile::tempdir().unwrap();
    let station = DeviceState::load(station_dir.path().to_path_buf());
    let upper = "AB".repeat(32);
    let short = "ab".repeat(31);
    let not_hex = "zz".repeat(32);
    for fingerprint in ["", upper.as_str(), short.as_str(), not_hex.as_str()] {
        assert_eq!(
            station
                .claim(&closed_address(), fingerprint, WRONG_CODE, STATION, "0.1.0")
                .await,
            Err(DeviceError::Request(RequestError::InvalidRequest)),
            "{fingerprint:?}"
        );
    }
    // A code that cannot be a code never reaches the host, where every wrong
    // code counts against all live codes.
    for code in ["", "hello", "12345", "0000000000X", "UUUUUUUUUU"] {
        assert_eq!(
            station
                .claim(&closed_address(), &"ab".repeat(32), code, STATION, "0.1.0")
                .await,
            Err(DeviceError::CodeInvalid),
            "{code:?}"
        );
    }
    // A well-formed fingerprint and code do reach the network, and find nothing.
    assert_eq!(
        station
            .claim(
                &closed_address(),
                &"ab".repeat(32),
                WRONG_CODE,
                STATION,
                "0.1.0"
            )
            .await,
        Err(DeviceError::Probe(ProbeError::Unreachable))
    );
}

async fn device_count(office: &DeviceState, token: &str) -> usize {
    let devices = office
        .request("GET", "/v1/office/devices", None, Some(token))
        .await
        .unwrap();
    devices.body.unwrap().as_array().unwrap().len()
}

/// A one-time code the office made for one existing device
/// (`POST /v1/office/devices/{id}/pairing-code`).
async fn device_code(office: &DeviceState, token: &str, device_id: &str) -> String {
    let created = office
        .request(
            "POST",
            &format!("/v1/office/devices/{device_id}/pairing-code"),
            None,
            Some(token),
        )
        .await
        .unwrap();
    assert_eq!(created.status, 200, "{:?}", created.body);
    created.body.unwrap()["code"].as_str().unwrap().to_owned()
}

/// «Выпустить новый код привязки» for a station (owner report 2026-10-20): the
/// rejected station forgets its pairing and claims the device's own code. The
/// claim names the device it was (`recoverDeviceId`), so the host gives that
/// same device a new key instead of refusing the code as invalid.
#[tokio::test]
async fn a_station_pairs_again_with_its_devices_own_code_and_stays_the_same_device() {
    let host_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (office, token) = office(&host, office_dir.path()).await;
    let code = new_code(&office, &token).await;
    let station = DeviceState::load(station_dir.path().to_path_buf());
    let first = station
        .claim(&address(&host), &host.fingerprint, &code, STATION, "0.1.0")
        .await
        .unwrap();
    let old_key_holder = DeviceState::load(station_dir.path().to_path_buf());

    let for_device = device_code(&office, &token, &first.device_id).await;
    let before = device_count(&office, &token).await;
    station.forget_for_repair().await.unwrap();
    assert_eq!(station.status(), Ok(None));
    assert_eq!(
        station
            .repair_target()
            .unwrap()
            .map(|target| target.device_id),
        Some(first.device_id.clone())
    );
    let again = station
        .claim(
            &address(&host),
            &host.fingerprint,
            &for_device,
            STATION,
            "0.1.1",
        )
        .await
        .unwrap();
    assert_eq!(again.device_id, first.device_id);
    assert_eq!(again.host_id, first.host_id);
    assert_eq!(again.device_name, first.device_name);
    // The hint is spent with the pairing, also on disk.
    assert_eq!(station.repair_target().unwrap(), None);
    // The new key works after a restart; the old key is dead at once.
    let reloaded = DeviceState::load(station_dir.path().to_path_buf());
    let info = reloaded
        .request("GET", "/v1/device", None, None)
        .await
        .unwrap();
    assert_eq!(info.status, 200, "{:?}", info.body);
    assert_eq!(info.body.unwrap()["id"], first.device_id);
    let old = old_key_holder
        .request("GET", "/v1/device", None, None)
        .await
        .unwrap();
    assert_eq!(old.status, 401);
    // One device, not two: the list of devices did not grow.
    let after = device_count(&office, &token).await;
    assert_eq!(after, before);
    host.stop().await.unwrap();
}

/// A plain forget (the «Отвязать станцию» of the workplace) leaves no hint: the
/// device-bound code stays whole and refused, as the host's rule says; and a
/// station that chose «новое устройство» sends no id either.
#[tokio::test]
async fn only_a_repair_forget_names_the_device_in_the_claim() {
    let host_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (office, token) = office(&host, office_dir.path()).await;
    let code = new_code(&office, &token).await;
    let station = DeviceState::load(station_dir.path().to_path_buf());
    let first = station
        .claim(&address(&host), &host.fingerprint, &code, STATION, "0.1.0")
        .await
        .unwrap();
    let for_device = device_code(&office, &token, &first.device_id).await;

    station.forget().await.unwrap();
    assert_eq!(station.repair_target().unwrap(), None);
    assert_eq!(
        station
            .claim(
                &address(&host),
                &host.fingerprint,
                &for_device,
                STATION,
                "0.1.0"
            )
            .await,
        Err(DeviceError::CodeInvalid)
    );
    assert_eq!(station.status(), Ok(None));
    // A station paired again as a new device under a repair hint sends no id.
    let again_code = new_code(&office, &token).await;
    let second = station
        .claim(
            &address(&host),
            &host.fingerprint,
            &again_code,
            STATION,
            "0.1.0",
        )
        .await
        .unwrap();
    station.forget_for_repair().await.unwrap();
    let ordinary = new_code(&office, &token).await;
    let third = station
        .claim_as_new_device(
            &address(&host),
            &host.fingerprint,
            &ordinary,
            STATION,
            "0.1.0",
        )
        .await
        .unwrap();
    assert_ne!(third.device_id, second.device_id);
    assert_eq!(station.repair_target().unwrap(), None);
    host.stop().await.unwrap();
}

/// A hint from another host is not this host's device: the claim is ordinary.
#[tokio::test]
async fn a_hint_from_another_host_is_ignored() {
    let host_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (office, token) = office(&host, office_dir.path()).await;
    std::fs::write(
        station_dir.path().join("repair.json"),
        r#"{"hostId":"00000000-0000-4000-8000-000000000000","deviceId":"7c9e6679-7425-40de-944b-e07fc1f90ae7"}"#,
    )
    .unwrap();
    let station = DeviceState::load(station_dir.path().to_path_buf());
    let code = new_code(&office, &token).await;
    let paired = station
        .claim(&address(&host), &host.fingerprint, &code, STATION, "0.1.0")
        .await
        .unwrap();
    assert_ne!(paired.device_id, "7c9e6679-7425-40de-944b-e07fc1f90ae7");
    host.stop().await.unwrap();
}
