//! A new address for the paired host (plan УСТ, pilot spec §9.4) against a
//! real `markiro-host` on 127.0.0.1: the host PC got another IP address, and
//! the device keeps its pairing when the new address presents the pinned
//! certificate and still knows the device's key. The old address is played
//! by a port where nothing listens.

use std::path::Path;

use markiro_host::config::HostPaths;
use markiro_host::{start, RunningHost, StartOptions};
use markiro_proto::DeviceKind;
use markiro_standalone_lib::device::{DeviceError, DeviceState};
use markiro_standalone_lib::device_config::{self, DeviceConfig};
use markiro_standalone_lib::host_client::RequestError;
use markiro_standalone_lib::installation::InstallRole;
use serde_json::Value;

const BOOTSTRAP: &str = include_str!("../../proto/fixtures/bootstrap-request.json");

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

/// A local address where nothing listens: the host's old address.
fn closed_address() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    format!("https://127.0.0.1:{port}")
}

/// The host PC's installation after the wizard, and the administrator's token.
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

/// An office PC paired by code, then moved to `old` in its `device.json`, as
/// if the host had answered there when it paired; loaded again from disk.
async fn office_pc_at(
    host: &RunningHost,
    office: &DeviceState,
    token: &str,
    dir: &Path,
    old: &str,
) -> DeviceState {
    let created = office
        .request("POST", "/v1/office/pairing-codes", None, Some(token))
        .await
        .unwrap();
    let code = created.body.unwrap()["code"].as_str().unwrap().to_owned();
    let pc = DeviceState::load(dir.to_path_buf()).with_install_role(Some(InstallRole::Office));
    pc.claim(
        &address(host),
        &host.fingerprint,
        &code,
        "ПК администратора",
        "0.1.0",
    )
    .await
    .unwrap();
    let config = device_config::load(dir).unwrap().unwrap();
    device_config::save(
        dir,
        &DeviceConfig {
            host_address: old.to_owned(),
            ..config
        },
    )
    .unwrap();
    DeviceState::load(dir.to_path_buf()).with_install_role(Some(InstallRole::Office))
}

fn saved(dir: &Path) -> DeviceConfig {
    device_config::load(dir).unwrap().unwrap()
}

#[tokio::test]
async fn the_same_host_at_a_new_address_keeps_the_pairing() {
    let host_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let pc_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (office, token) = office(&host, office_dir.path()).await;
    let old = closed_address();
    let pc = office_pc_at(&host, &office, &token, pc_dir.path(), &old).await;
    let before = saved(pc_dir.path());
    assert_eq!(
        pc.request("GET", "/v1/device", None, None).await,
        Err(DeviceError::Request(RequestError::Unreachable))
    );
    let mut link = pc.watch_link();
    assert_eq!(link.borrow_and_update().as_ref().unwrap().address, old);

    let status = pc
        .change_address(&format!("{}/", address(&host)))
        .await
        .unwrap();
    assert_eq!(status.host_address, address(&host));
    assert_eq!(status.kind, DeviceKind::Office);
    assert_eq!(
        saved(pc_dir.path()),
        DeviceConfig {
            host_address: address(&host),
            ..before
        },
        "only the address changes: the key, the fingerprint and the device stay"
    );
    assert!(
        link.has_changed().unwrap(),
        "the connection task follows the new address"
    );
    assert_eq!(
        link.borrow_and_update().as_ref().unwrap().address,
        address(&host)
    );
    let device = pc.request("GET", "/v1/device", None, None).await.unwrap();
    assert_eq!(device.status, 200);
    assert_eq!(device.body.unwrap()["kind"], "office");
    host.stop().await.unwrap();
}

#[tokio::test]
async fn another_host_at_the_new_address_changes_nothing() {
    let host_dir = tempfile::tempdir().unwrap();
    let other_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let pc_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let other = start_host(other_dir.path()).await;
    let (office, token) = office(&host, office_dir.path()).await;
    let old = closed_address();
    let pc = office_pc_at(&host, &office, &token, pc_dir.path(), &old).await;
    let before = saved(pc_dir.path());

    assert_eq!(
        pc.change_address(&address(&other)).await,
        Err(DeviceError::AddressOtherHost)
    );
    assert_eq!(saved(pc_dir.path()), before);
    assert_eq!(pc.status().unwrap().unwrap().host_address, old);
    other.stop().await.unwrap();
    host.stop().await.unwrap();
}

#[tokio::test]
async fn nothing_at_the_new_address_changes_nothing() {
    let host_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let pc_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (office, token) = office(&host, office_dir.path()).await;
    let old = closed_address();
    let pc = office_pc_at(&host, &office, &token, pc_dir.path(), &old).await;
    let before = saved(pc_dir.path());

    assert_eq!(
        pc.change_address(&closed_address()).await,
        Err(DeviceError::Request(RequestError::Unreachable))
    );
    assert_eq!(
        pc.change_address("http://127.0.0.1:45710").await,
        Err(DeviceError::Request(RequestError::InvalidRequest))
    );
    assert_eq!(saved(pc_dir.path()), before);
    host.stop().await.unwrap();
}

#[tokio::test]
async fn a_revoked_device_is_refused_at_the_new_address_and_keeps_the_old_one() {
    let host_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let pc_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (office, token) = office(&host, office_dir.path()).await;
    let old = closed_address();
    let pc = office_pc_at(&host, &office, &token, pc_dir.path(), &old).await;
    let before = saved(pc_dir.path());
    let revoked = office
        .request(
            "POST",
            &format!("/v1/office/devices/{}/revoke", before.device_id),
            None,
            Some(&token),
        )
        .await
        .unwrap();
    assert_eq!(revoked.status, 200, "{:?}", revoked.body);

    assert_eq!(
        pc.change_address(&address(&host)).await,
        Err(DeviceError::KeyRejected)
    );
    assert_eq!(saved(pc_dir.path()), before);
    host.stop().await.unwrap();
}

#[tokio::test]
async fn an_unpaired_device_has_no_address_to_change() {
    let host_dir = tempfile::tempdir().unwrap();
    let pc_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let pc = DeviceState::load(pc_dir.path().to_path_buf());
    assert_eq!(
        pc.change_address(&address(&host)).await,
        Err(DeviceError::NotPaired)
    );
    assert!(!pc_dir.path().join(device_config::FILE_NAME).exists());
    host.stop().await.unwrap();
}

// --- beyond the brief: what a typed address may carry, and the trust domains ---

/// An address is a scheme, a host and a port and nothing else: the real host
/// answers at each of these spellings, so only the shell's own check refuses
/// them, before the key is sent anywhere and before `device.json` is touched.
#[tokio::test]
async fn an_address_with_credentials_a_path_or_a_query_is_refused_before_any_request() {
    let host_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let pc_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let (office, token) = office(&host, office_dir.path()).await;
    let old = closed_address();
    let pc = office_pc_at(&host, &office, &token, pc_dir.path(), &old).await;
    let before = saved(pc_dir.path());
    let good = address(&host);
    let authority = good.trim_start_matches("https://");

    for bad in [
        format!("https://admin:secret@{authority}"),
        format!("https://admin@{authority}"),
        format!("{good}/v1/hello"),
        format!("{good}//"),
        format!("{good}?x=1"),
        format!("{good}#top"),
        format!("{good} "),
        format!(" {good}"),
        format!("{good}\n"),
        format!("{good}\u{0}"),
        "https://".to_owned(),
        authority.to_owned(),
        format!("ftp://{authority}"),
        format!("HTTP://{authority}"),
        String::new(),
    ] {
        assert_eq!(
            pc.change_address(&bad).await,
            Err(DeviceError::Request(RequestError::InvalidRequest)),
            "{bad:?}"
        );
    }
    assert_eq!(saved(pc_dir.path()), before, "nothing was written");
    assert_eq!(pc.status().unwrap().unwrap().host_address, old);

    // The same host, spelled the way a person types it, is accepted and kept
    // in its plain form.
    let status = pc
        .change_address(&format!("HTTPS://{authority}/"))
        .await
        .unwrap();
    assert_eq!(status.host_address, good);
    host.stop().await.unwrap();
}

/// The office role is a different trust domain from the station's: an office
/// PC is paired by a code, as a device of kind `office`, and never by the
/// loopback pairing, which grants a station on the host's own computer.
#[tokio::test]
async fn an_office_pc_never_pairs_as_a_station_on_this_computer() {
    let pc_dir = tempfile::tempdir().unwrap();
    let pc =
        DeviceState::load(pc_dir.path().to_path_buf()).with_install_role(Some(InstallRole::Office));
    assert_eq!(
        pc.local_pair(&closed_address(), "ПК администратора", "0.1.0")
            .await,
        Err(DeviceError::Request(RequestError::InvalidRequest))
    );
    assert!(!pc_dir.path().join(device_config::FILE_NAME).exists());
    assert_eq!(pc.status().unwrap(), None);
}
