//! `update_fetch` against a real `markiro-host` on 127.0.0.1 (plan ОБН-3,
//! spec §10.11.4): the package of the host's version into
//! `<local data>/updates/<version>/`, resumed after a break with one
//! `update.download` row in all, started again when the host's package
//! changed, refused before a byte for a downgrade. Outside the sandbox.

use std::path::Path;
use std::sync::{Arc, Mutex};

use markiro_host::config::HostPaths;
use markiro_host::{start, RunningHost, StartOptions, HOST_VERSION};
use markiro_proto::update::distribution::testing::sign_update_manifest;
use markiro_standalone_lib::device::{DeviceState, HostLink};
use markiro_standalone_lib::host_client::TransferClient;
use markiro_standalone_lib::update::fetch::{fetch, FetchError, FetchOptions, INSTALLER_PATH};
use serde_json::json;
use sqlx::ConnectOptions;

fn installer(version: &str, tag: &str) -> Vec<u8> {
    format!("MZ {tag} installer {version}\n")
        .repeat(10_000)
        .into_bytes()
}

fn installer_name(version: &str) -> String {
    format!("markiro-standalone-{version}-windows-x86_64-setup.exe")
}

/// A current package of `version` with `bytes` in the host's data folder.
fn seed(dir: &Path, version: &str, bytes: &[u8]) {
    let current = HostPaths::new(dir).updates_dir().join("current");
    std::fs::create_dir_all(&current).unwrap();
    let size = bytes.len() as u64;
    let sha256 = markiro_proto::update::hash_exact(bytes, size).unwrap();
    let manifest = sign_update_manifest(&json!({
        "v": 1, "product": "markiro-standalone", "version": version, "channel": "stable",
        "releasedAt": "2026-11-02T10:00:00Z",
        "sourceSha": "0123456789abcdef0123456789abcdef01234567",
        "installer": { "name": installer_name(version), "sha256": sha256, "sizeBytes": size },
        "protocol": markiro_proto::PROTOCOL_VERSION,
        "minProtocol": markiro_proto::MIN_PROTOCOL_VERSION,
        "minUpgradeFrom": "0.0.1", "notes": ["Тест"]
    }));
    std::fs::write(current.join("manifest.update.jws"), manifest).unwrap();
    std::fs::write(current.join(installer_name(version)), bytes).unwrap();
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

/// A station paired over loopback; a download needs no wizard.
async fn station(host: &RunningHost, dir: &Path) -> Arc<HostLink> {
    let station = DeviceState::load(dir.to_path_buf());
    station
        .local_pair(&format!("https://{}", host.addr), "Станция", "0.0.1")
        .await
        .unwrap();
    let link = station.watch_link().borrow().clone();
    link.unwrap()
}

fn options<'a>(downloads: &'a Path, own: &'a str, stop_after: Option<u64>) -> FetchOptions<'a> {
    FetchOptions {
        own_version: own,
        downloads,
        stop_after,
    }
}

fn quiet(_: u64, _: u64) {}

/// The `update.download` rows of a stopped host.
async fn download_rows(dir: &Path) -> i64 {
    let mut conn = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(dir.join("host.db"))
        .connect()
        .await
        .unwrap();
    sqlx::query_scalar("SELECT COUNT(*) FROM audit_log WHERE action = 'update.download'")
        .fetch_one(&mut conn)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_station_downloads_the_hosts_package_and_names_its_manifest() {
    let host_dir = tempfile::tempdir().unwrap();
    let bytes = installer(HOST_VERSION, "first");
    seed(host_dir.path(), HOST_VERSION, &bytes);
    let host = start_host(host_dir.path()).await;
    let app_dir = tempfile::tempdir().unwrap();
    let link = station(&host, app_dir.path()).await;
    let downloads = app_dir.path().join("updates");
    std::fs::create_dir_all(downloads.join("0.0.5")).unwrap();
    let seen = Mutex::new(Vec::new());
    let fetched = fetch(
        &link,
        options(&downloads, "0.0.1", None),
        &|received, total| seen.lock().unwrap().push((received, total)),
    )
    .await
    .unwrap();
    let dir = downloads.join(HOST_VERSION);
    assert_eq!(fetched.version, HOST_VERSION);
    assert_eq!(
        fetched.manifest_path,
        dir.join(format!("markiro-standalone-{HOST_VERSION}.update.jws"))
            .display()
            .to_string()
    );
    assert_eq!(
        std::fs::read(dir.join(installer_name(HOST_VERSION))).unwrap(),
        bytes
    );
    assert!(
        !downloads.join("0.0.5").exists(),
        "another version's download went"
    );
    let total = bytes.len() as u64;
    assert_eq!(seen.lock().unwrap().last(), Some(&(total, total)));
    host.stop().await.unwrap();
    assert_eq!(download_rows(host_dir.path()).await, 1);
}

#[tokio::test]
async fn a_broken_download_resumes_where_it_stopped_with_one_audit_row() {
    let host_dir = tempfile::tempdir().unwrap();
    let bytes = installer(HOST_VERSION, "resume");
    seed(host_dir.path(), HOST_VERSION, &bytes);
    let host = start_host(host_dir.path()).await;
    let app_dir = tempfile::tempdir().unwrap();
    let link = station(&host, app_dir.path()).await;
    let downloads = app_dir.path().join("updates");
    let first = fetch(&link, options(&downloads, "0.0.1", Some(70_000)), &quiet).await;
    assert_eq!(first.unwrap_err(), FetchError::Interrupted);
    let partial = downloads
        .join(HOST_VERSION)
        .join(format!("{}.partial", installer_name(HOST_VERSION)));
    let kept = std::fs::metadata(&partial).unwrap().len();
    assert!(kept >= 70_000 && kept < bytes.len() as u64, "{kept}");
    fetch(&link, options(&downloads, "0.0.1", None), &quiet)
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(
            downloads
                .join(HOST_VERSION)
                .join(installer_name(HOST_VERSION))
        )
        .unwrap(),
        bytes
    );
    assert!(!partial.exists());
    host.stop().await.unwrap();
    assert_eq!(
        download_rows(host_dir.path()).await,
        1,
        "a resumed download writes no row"
    );
}

#[tokio::test]
async fn a_package_that_changed_between_attempts_is_downloaded_again_whole() {
    let host_dir = tempfile::tempdir().unwrap();
    seed(
        host_dir.path(),
        HOST_VERSION,
        &installer(HOST_VERSION, "old"),
    );
    let host = start_host(host_dir.path()).await;
    let app_dir = tempfile::tempdir().unwrap();
    let link = station(&host, app_dir.path()).await;
    let downloads = app_dir.path().join("updates");
    let first = fetch(&link, options(&downloads, "0.0.1", Some(70_000)), &quiet).await;
    assert_eq!(first.unwrap_err(), FetchError::Interrupted);
    let fresh = installer(HOST_VERSION, "new");
    seed(host_dir.path(), HOST_VERSION, &fresh);
    let mut result = fetch(&link, options(&downloads, "0.0.1", None), &quiet).await;
    for _ in 0..50 {
        if result != Err(FetchError::Verifying) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        result = fetch(&link, options(&downloads, "0.0.1", None), &quiet).await;
    }
    result.unwrap();
    assert_eq!(
        std::fs::read(
            downloads
                .join(HOST_VERSION)
                .join(installer_name(HOST_VERSION))
        )
        .unwrap(),
        fresh
    );
    // The host itself answers an old ETag with the whole file.
    let client = TransferClient::new(&link.address, &link.fingerprint).unwrap();
    let answer = client
        .download(INSTALLER_PATH, link.key(), Some((100, "\"another\"")))
        .await
        .unwrap();
    assert_eq!(answer.status(), 200);
    host.stop().await.unwrap();
}

#[tokio::test]
async fn a_whole_file_that_is_not_the_manifests_is_removed_and_fetched_again() {
    let host_dir = tempfile::tempdir().unwrap();
    let bytes = installer(HOST_VERSION, "hash");
    seed(host_dir.path(), HOST_VERSION, &bytes);
    let host = start_host(host_dir.path()).await;
    let app_dir = tempfile::tempdir().unwrap();
    let link = station(&host, app_dir.path()).await;
    let downloads = app_dir.path().join("updates");
    fetch(&link, options(&downloads, "0.0.1", None), &quiet)
        .await
        .unwrap();
    // A whole partial file one byte off (a disk error, a hand): never installed.
    let dir = downloads.join(HOST_VERSION);
    let target = dir.join(installer_name(HOST_VERSION));
    let partial = dir.join(format!("{}.partial", installer_name(HOST_VERSION)));
    let mut broken = std::fs::read(&target).unwrap();
    broken[10] ^= 0x01;
    std::fs::remove_file(&target).unwrap();
    std::fs::write(&partial, &broken).unwrap();
    assert_eq!(
        fetch(&link, options(&downloads, "0.0.1", None), &quiet)
            .await
            .unwrap_err(),
        FetchError::HashMismatch
    );
    assert!(!partial.exists() && !target.exists());
    fetch(&link, options(&downloads, "0.0.1", None), &quiet)
        .await
        .unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), bytes);
    host.stop().await.unwrap();
}

#[tokio::test]
async fn no_downgrade_and_no_package_download_nothing() {
    let host_dir = tempfile::tempdir().unwrap();
    seed(
        host_dir.path(),
        HOST_VERSION,
        &installer(HOST_VERSION, "same"),
    );
    let host = start_host(host_dir.path()).await;
    let app_dir = tempfile::tempdir().unwrap();
    let link = station(&host, app_dir.path()).await;
    let downloads = app_dir.path().join("updates");
    assert_eq!(
        fetch(&link, options(&downloads, HOST_VERSION, None), &quiet)
            .await
            .unwrap_err(),
        FetchError::NotNewer
    );
    assert!(!downloads.exists(), "nothing was written");
    host.stop().await.unwrap();
    assert_eq!(download_rows(host_dir.path()).await, 0);

    let empty_dir = tempfile::tempdir().unwrap();
    let host = start_host(empty_dir.path()).await;
    let app_dir = tempfile::tempdir().unwrap();
    let link = station(&host, app_dir.path()).await;
    assert_eq!(
        fetch(
            &link,
            options(&app_dir.path().join("updates"), "0.0.1", None),
            &quiet
        )
        .await
        .unwrap_err(),
        FetchError::Unavailable
    );
    host.stop().await.unwrap();
}
