//! Updates from a file (plan ОБН-2) through `UpdateState`'s own methods: the
//! version rules on the host's own PC, a package that does not hold, a
//! removable drive, and the check of the host a station answers to. The
//! last two tests start a real `markiro-host` on 127.0.0.1 or dial a closed
//! port there, so the sandbox must allow a local socket.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use markiro_host::config::HostPaths;
use markiro_host::{start, RunningHost, StartOptions};
use markiro_proto::DeviceKind;
use markiro_standalone_lib::device::DeviceState;
use markiro_standalone_lib::device_config::{self, DeviceConfig};
use markiro_standalone_lib::installation::InstallRole;
use markiro_standalone_lib::lockdown::LockdownState;
use markiro_standalone_lib::secret_store;
use markiro_standalone_lib::update::launch::{LaunchError, Launcher};
use markiro_standalone_lib::update::package::{FixedDrives, PlaceKind};
use markiro_standalone_lib::update::rules::Confirmation;
use markiro_standalone_lib::update::{UpdateConfig, UpdateError, UpdateState};
use serde_json::json;
use tauri::async_runtime::block_on;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/update");

fn test_installer(version: &str) -> Vec<u8> {
    format!("markiro test installer {version}\n").into_bytes()
}

fn installer_path(dir: &Path, version: &str) -> PathBuf {
    dir.join(format!(
        "markiro-standalone-{version}-windows-x86_64-setup.exe"
    ))
}

fn put_package(dir: &Path, version: &str) -> String {
    let name = format!("markiro-standalone-{version}.update.jws");
    std::fs::copy(Path::new(FIXTURES).join(&name), dir.join(&name)).unwrap();
    std::fs::write(installer_path(dir, version), test_installer(version)).unwrap();
    dir.join(name).to_string_lossy().into_owned()
}

/// Nothing is ever started in these tests.
struct NoLauncher;

impl Launcher for NoLauncher {
    fn launch(&self, _: &Path, _: &str, _: usize) -> Result<(), LaunchError> {
        panic!("these tests start nothing")
    }
}

struct Site {
    state: UpdateState,
    updates: PathBuf,
    _dirs: [tempfile::TempDir; 2],
}

fn site(installed: &str, drives: Vec<PathBuf>) -> Site {
    let data = tempfile::tempdir().unwrap();
    let documents = tempfile::tempdir().unwrap();
    let updates = documents.path().join("Markiro").join("Обновления");
    std::fs::create_dir_all(&updates).unwrap();
    let state = UpdateState::load(UpdateConfig {
        installed: installed.to_owned(),
        data_dir: data.path().to_path_buf(),
        documents: Some(documents.path().to_path_buf()),
        drives: Arc::new(FixedDrives(drives)),
        launcher: Arc::new(NoLauncher),
        keyset: markiro_proto::trust::update_keyset(),
        exit: Arc::new(|_: i32| panic!("these tests never exit")),
    });
    Site {
        state,
        updates,
        _dirs: [data, documents],
    }
}

fn host_pc(dir: &Path) -> DeviceState {
    DeviceState::load(dir.to_path_buf()).with_install_role(Some(InstallRole::Host))
}

#[test]
fn on_the_hosts_pc_an_older_package_is_refused_and_the_same_one_asks_first() {
    let device_dir = tempfile::tempdir().unwrap();
    let device = host_pc(device_dir.path());
    let lockdown = LockdownState::default();

    let older = site("0.3.0", vec![]);
    let path = put_package(&older.updates, "0.2.0");
    block_on(older.state.scan()).unwrap();
    let report = block_on(older.state.verify(&device, &path)).unwrap();
    assert_eq!(
        serde_json::to_value(&report.refusal).unwrap(),
        json!({ "code": "older", "installed": "0.3.0" })
    );
    assert_eq!(
        block_on(older.state.install(&device, &lockdown, &path, &[], 0)).err(),
        Some(UpdateError::UpdateRefused)
    );

    let same = site("0.2.0", vec![]);
    let path = put_package(&same.updates, "0.2.0");
    block_on(same.state.scan()).unwrap();
    let report = block_on(same.state.verify(&device, &path)).unwrap();
    assert_eq!(report.confirmations, vec![Confirmation::Reinstall]);
    assert_eq!(
        block_on(same.state.install(&device, &lockdown, &path, &[], 0)).err(),
        Some(UpdateError::ConfirmationRequired)
    );

    let skipping = site("0.1.0", vec![]);
    let path = put_package(&skipping.updates, "0.3.0");
    block_on(skipping.state.scan()).unwrap();
    assert_eq!(
        serde_json::to_value(
            &block_on(skipping.state.verify(&device, &path))
                .unwrap()
                .refusal
        )
        .unwrap(),
        json!({ "code": "min_upgrade", "minUpgradeFrom": "0.2.0" })
    );
}

#[test]
fn a_package_that_does_not_hold_is_refused_with_its_reason() {
    let device_dir = tempfile::tempdir().unwrap();
    let device = host_pc(device_dir.path());
    let site = site("0.1.0", vec![]);
    let path = put_package(&site.updates, "0.2.0");
    block_on(site.state.scan()).unwrap();
    std::fs::write(installer_path(&site.updates, "0.2.0"), b"another installer").unwrap();
    assert_eq!(
        block_on(site.state.verify(&device, &path)).err(),
        Some(UpdateError::InstallerMismatch)
    );
    std::fs::remove_file(installer_path(&site.updates, "0.2.0")).unwrap();
    assert_eq!(
        block_on(site.state.verify(&device, &path)).err(),
        Some(UpdateError::InstallerMissing)
    );
    std::fs::copy(
        Path::new(FIXTURES).join("tampered/markiro-standalone-0.2.0.update.jws"),
        &path,
    )
    .unwrap();
    assert_eq!(
        block_on(site.state.verify(&device, &path)).err(),
        Some(UpdateError::ManifestSignature)
    );
    // A path the last scan did not find is no package of this shell.
    let elsewhere = tempfile::tempdir().unwrap();
    let other = put_package(elsewhere.path(), "0.2.0");
    assert_eq!(
        block_on(site.state.verify(&device, &other)).err(),
        Some(UpdateError::InvalidRequest)
    );
}

#[test]
fn a_removable_drive_is_searched_in_its_root_and_markiro_folder() {
    let drive = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(drive.path().join("Markiro")).unwrap();
    put_package(&drive.path().join("Markiro"), "0.2.0");
    let site = site("0.1.0", vec![drive.path().to_path_buf()]);
    let found = block_on(site.state.scan()).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].place, PlaceKind::Removable);
}

/// A real host on its own runtime (as `tests/ipc.rs` starts one).
struct Host {
    runtime: tokio::runtime::Runtime,
    running: RunningHost,
    _dir: tempfile::TempDir,
}

impl Host {
    fn start() -> Self {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let running = runtime
            .block_on(start(
                &HostPaths::new(dir.path()),
                StartOptions {
                    port_override: None,
                    bind: Some("127.0.0.1:0".parse().unwrap()),
                },
            ))
            .unwrap();
        Self {
            runtime,
            running,
            _dir: dir,
        }
    }

    fn address(&self) -> String {
        format!("https://{}", self.running.addr)
    }

    fn stop(self) {
        self.runtime.block_on(self.running.stop()).unwrap();
    }
}

/// A station paired with the host at `address` (no host issued the key).
fn station_paired_at(dir: &Path, address: &str) -> DeviceState {
    device_config::save(
        dir,
        &DeviceConfig {
            host_address: address.into(),
            fingerprint: "ab".repeat(32),
            host_id: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f".into(),
            device_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7".into(),
            kind: DeviceKind::Station,
            line_id: None,
            device_name: Some("Станция на линии 1".into()),
            device_key: secret_store::protect("device-key-value").unwrap(),
        },
    )
    .unwrap();
    DeviceState::load(dir.to_path_buf()).with_install_role(Some(InstallRole::Station))
}

#[test]
fn a_station_does_not_get_ahead_of_its_hosts_protocol() {
    let host = Host::start();
    let device_dir = tempfile::tempdir().unwrap();
    let device = station_paired_at(device_dir.path(), &host.address());
    let site = site("0.2.0", vec![]);
    let newer = put_package(&site.updates, "0.3.0");
    block_on(site.state.scan()).unwrap();
    let report = block_on(site.state.verify(&device, &newer)).unwrap();
    assert_eq!(
        serde_json::to_value(&report.refusal).unwrap(),
        json!({ "code": "host_first", "hostProtocol": markiro_proto::PROTOCOL_VERSION, "protocol": 9 })
    );
    let seen = report.host.unwrap();
    assert_eq!(seen.protocol, markiro_proto::PROTOCOL_VERSION);
    assert!(seen.version.is_some());
    host.stop();
}

#[test]
fn a_station_whose_host_is_silent_needs_a_confirmation() {
    // A port that was free a moment ago: the connection is refused at once.
    let closed = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        format!("https://{}", listener.local_addr().unwrap())
    };
    let device_dir = tempfile::tempdir().unwrap();
    let device = station_paired_at(device_dir.path(), &closed);
    let lockdown = LockdownState::default();
    let site = site("0.1.0", vec![]);
    let path = put_package(&site.updates, "0.2.0");
    block_on(site.state.scan()).unwrap();
    let report = block_on(site.state.verify(&device, &path)).unwrap();
    assert_eq!(report.confirmations, vec![Confirmation::HostUnreachable]);
    assert_eq!(report.refusal, None);
    assert_eq!(report.host, None);
    assert_eq!(
        block_on(site.state.install(&device, &lockdown, &path, &[], 0)).err(),
        Some(UpdateError::ConfirmationRequired)
    );
    // Every warning must be confirmed: one of two is not enough.
    let same = self::site("0.2.0", vec![]);
    let again = put_package(&same.updates, "0.2.0");
    block_on(same.state.scan()).unwrap();
    assert_eq!(
        block_on(same.state.verify(&device, &again))
            .unwrap()
            .confirmations,
        vec![Confirmation::Reinstall, Confirmation::HostUnreachable]
    );
    for confirmed in [
        &[Confirmation::Reinstall][..],
        &[Confirmation::HostUnreachable][..],
    ] {
        assert_eq!(
            block_on(same.state.install(&device, &lockdown, &again, confirmed, 0)).err(),
            Some(UpdateError::ConfirmationRequired)
        );
    }
}
