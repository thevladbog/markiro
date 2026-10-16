//! `update_stage` against a real `markiro-host` on 127.0.0.1 (plan ОБН-3,
//! spec §10.11.2): a package found on this computer goes to the host with
//! the office session and waits there as `staged\`; a wrong file stops
//! before the network, a package not newer than the host is refused by the
//! host. Outside the sandbox.

use std::path::{Path, PathBuf};

use markiro_host::config::HostPaths;
use markiro_host::{start, RunningHost, StartOptions, HOST_VERSION};
use markiro_proto::update::distribution::testing::sign_update_manifest;
use markiro_proto::update::AppVersion;
use markiro_standalone_lib::device::DeviceState;
use markiro_standalone_lib::update::stage::{stage, StageError};
use serde_json::{json, Value};

const BOOTSTRAP: &str = include_str!("../../proto/fixtures/bootstrap-request.json");

fn installer_name(version: &str) -> String {
    format!("markiro-standalone-{version}-windows-x86_64-setup.exe")
}

/// A package folder as `sign-update.mjs` leaves it; the manifest's path.
fn package(dir: &Path, version: &str) -> PathBuf {
    let bytes = format!("MZ staged installer {version}\n")
        .repeat(10_000)
        .into_bytes();
    let size = bytes.len() as u64;
    let sha256 = markiro_proto::update::hash_exact(&bytes[..], size).unwrap();
    let manifest = sign_update_manifest(&json!({
        "v": 1, "product": "markiro-standalone", "version": version, "channel": "stable",
        "releasedAt": "2026-11-02T10:00:00Z",
        "sourceSha": "0123456789abcdef0123456789abcdef01234567",
        "installer": { "name": installer_name(version), "sha256": sha256, "sizeBytes": size },
        "protocol": markiro_proto::PROTOCOL_VERSION,
        "minProtocol": markiro_proto::MIN_PROTOCOL_VERSION,
        "minUpgradeFrom": "0.0.1", "notes": ["Тест"]
    }));
    std::fs::create_dir_all(dir).unwrap();
    let path = dir.join(format!("markiro-standalone-{version}.update.jws"));
    std::fs::write(&path, format!("{manifest}\n")).unwrap();
    std::fs::write(dir.join(installer_name(version)), bytes).unwrap();
    path
}

fn newer() -> String {
    let host: AppVersion = HOST_VERSION.parse().unwrap();
    AppVersion {
        minor: host.minor + 1,
        patch: 0,
        ..host
    }
    .to_string()
}

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

/// The host's PC after the wizard, with the administrator's session.
async fn office(host: &RunningHost, dir: &Path) -> (DeviceState, String) {
    let station = DeviceState::load(dir.to_path_buf());
    station
        .local_pair(
            &format!("https://{}", host.addr),
            "Рабочее место хоста",
            "0.0.1",
        )
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

#[tokio::test]
async fn a_found_package_goes_to_the_host_and_waits_there_as_staged() {
    let host_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let app_dir = tempfile::tempdir().unwrap();
    let (station, token) = office(&host, app_dir.path()).await;
    let link = station.watch_link().borrow().clone().unwrap();
    let files = tempfile::tempdir().unwrap();
    let version = newer();
    let manifest = package(files.path(), &version);
    let staged = stage(&link, &token, &manifest).await.unwrap();
    assert_eq!(staged.version, version);
    host.stop().await.unwrap();
    let staged_dir = HostPaths::new(host_dir.path()).updates_dir().join("staged");
    assert_eq!(
        std::fs::read(staged_dir.join(installer_name(&version))).unwrap(),
        std::fs::read(files.path().join(installer_name(&version))).unwrap()
    );
}

#[tokio::test]
async fn a_wrong_file_stops_here_and_an_old_package_at_the_host() {
    let host_dir = tempfile::tempdir().unwrap();
    let files = tempfile::tempdir().unwrap();
    // A sound current package of the host's version: the same version is no
    // news (without one, it repairs: see the next test).
    let current = package(&files.path().join("current"), HOST_VERSION);
    let folder = HostPaths::new(host_dir.path())
        .updates_dir()
        .join("current");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::copy(&current, folder.join("manifest.update.jws")).unwrap();
    std::fs::copy(
        files
            .path()
            .join("current")
            .join(installer_name(HOST_VERSION)),
        folder.join(installer_name(HOST_VERSION)),
    )
    .unwrap();
    let host = start_host(host_dir.path()).await;
    let app_dir = tempfile::tempdir().unwrap();
    let (station, token) = office(&host, app_dir.path()).await;
    let link = station.watch_link().borrow().clone().unwrap();
    // The start checks the package in the background.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let same = package(&files.path().join("same"), HOST_VERSION);
    assert_eq!(
        stage(&link, &token, &same).await.unwrap_err(),
        StageError::NotNewer
    );

    let version = newer();
    let tampered = package(&files.path().join("tampered"), &version);
    let mut text = std::fs::read_to_string(&tampered)
        .unwrap()
        .trim()
        .to_owned();
    let last = text.pop().unwrap();
    text.push(if last == 'A' { 'B' } else { 'A' });
    std::fs::write(&tampered, text).unwrap();
    assert_eq!(
        stage(&link, &token, &tampered).await.unwrap_err(),
        StageError::ManifestRefused
    );

    let short = package(&files.path().join("short"), &version);
    std::fs::write(
        files.path().join("short").join(installer_name(&version)),
        b"MZ",
    )
    .unwrap();
    assert_eq!(
        stage(&link, &token, &short).await.unwrap_err(),
        StageError::InstallerRefused
    );

    let lost = package(&files.path().join("lost"), &version);
    std::fs::remove_file(files.path().join("lost").join(installer_name(&version))).unwrap();
    assert_eq!(
        stage(&link, &token, &lost).await.unwrap_err(),
        StageError::NotFound
    );

    assert_eq!(
        stage(
            &link,
            "not-a-session",
            &package(&files.path().join("ok"), &version)
        )
        .await
        .unwrap_err(),
        StageError::SessionEnded
    );
    host.stop().await.unwrap();
    assert!(!HostPaths::new(host_dir.path())
        .updates_dir()
        .join("staged")
        .exists());
}

/// A manifest file over the limit is refused after at most one byte more than
/// the limit is read: not only a big file, a file that never ends (a device).
#[tokio::test]
async fn an_oversized_manifest_is_refused_without_reading_it_whole() {
    let host_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let app_dir = tempfile::tempdir().unwrap();
    let (station, token) = office(&host, app_dir.path()).await;
    let link = station.watch_link().borrow().clone().unwrap();
    let files = tempfile::tempdir().unwrap();
    let big = files.path().join("big.update.jws");
    std::fs::write(&big, "x".repeat(64 * 1024 + 10)).unwrap();
    assert_eq!(
        stage(&link, &token, &big).await.unwrap_err(),
        StageError::ManifestRefused
    );
    #[cfg(unix)]
    assert_eq!(
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            stage(&link, &token, Path::new("/dev/zero"))
        )
        .await
        .expect("the read is capped")
        .unwrap_err(),
        StageError::ManifestRefused
    );
    host.stop().await.unwrap();
}

#[tokio::test]
async fn the_package_of_the_hosts_version_repairs_a_host_without_a_current_one() {
    let host_dir = tempfile::tempdir().unwrap();
    let host = start_host(host_dir.path()).await;
    let app_dir = tempfile::tempdir().unwrap();
    let (station, token) = office(&host, app_dir.path()).await;
    let link = station.watch_link().borrow().clone().unwrap();
    let files = tempfile::tempdir().unwrap();
    let manifest = package(files.path(), HOST_VERSION);
    stage(&link, &token, &manifest).await.unwrap();
    host.stop().await.unwrap();
    let updates = HostPaths::new(host_dir.path()).updates_dir();
    assert!(updates
        .join("current")
        .join(installer_name(HOST_VERSION))
        .exists());
    assert!(!updates.join("staged").exists());
}
