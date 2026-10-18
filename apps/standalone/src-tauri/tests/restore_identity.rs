//! A host restored on a NEW computer (plan I1) against real `markiro-host`s
//! on 127.0.0.1. With the copy's identity the station keeps its pairing —
//! the same key, the same pinned certificate, the same device — and only
//! learns the new address; its blocks of SSCC serials are registered again
//! (plan РК-С) and its records flow once an administrator resumes them.
//! Without the identity the new computer is another host: the station's
//! pinned client refuses it before its key goes anywhere.
//!
//! A new computer has a new address, so every host here listens on its own
//! port of 127.0.0.1. The certificate is the same at any address: devices pin
//! the SHA-256 of its DER, not its names.

use std::path::{Path, PathBuf};
use std::time::Duration;

use markiro_host::backup::identity::{identity_path, sha256_hex};
use markiro_host::config::HostPaths;
use markiro_host::restore::{restore_now, IdentityChoice, IdentityOutcome, RestoreOptions};
use markiro_host::{start, RunningHost, StartOptions};
use markiro_standalone_lib::device::{DeviceError, DeviceState};
use markiro_standalone_lib::device_config::{self, DeviceConfig};
use markiro_standalone_lib::host_client::RequestError;
use markiro_standalone_lib::installation::InstallRole;
use serde_json::{json, Value};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, SqliteConnection};

const BOOTSTRAP: &str = include_str!("../../proto/fixtures/bootstrap-request.json");

const PREFIX: &str = "460068200";
const FIRST_REQUEST: &str = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const SECOND_REQUEST: &str = "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const THIRD_REQUEST: &str = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";

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

/// The host PC's own pairing after the wizard, and the administrator's token.
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

/// A station paired by a code from the office.
async fn station(host: &RunningHost, office: &DeviceState, token: &str, dir: &Path) -> DeviceState {
    let created = office
        .request("POST", "/v1/office/pairing-codes", None, Some(token))
        .await
        .unwrap();
    let code = created.body.unwrap()["code"].as_str().unwrap().to_owned();
    let station =
        DeviceState::load(dir.to_path_buf()).with_install_role(Some(InstallRole::Station));
    station
        .claim(
            &address(host),
            &host.fingerprint,
            &code,
            "Станция линии 1",
            "0.1.0",
        )
        .await
        .unwrap();
    station
}

/// One request that must answer 200; returns its body.
async fn ok(
    device: &DeviceState,
    method: &str,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> Value {
    let answer = device
        .request(method, path, body.as_ref(), token)
        .await
        .unwrap();
    assert_eq!(answer.status, 200, "{method} {path}: {:?}", answer.body);
    answer.body.unwrap_or(Value::Null)
}

/// The host's current revision as a device reads it: a page past the end of
/// the feed still names it.
async fn revision(device: &DeviceState) -> i64 {
    ok(
        device,
        "GET",
        "/v1/changes?since=999999999&limit=1",
        None,
        None,
    )
    .await["rev"]
        .as_i64()
        .unwrap()
}

/// The shift a station works in: a template, a product and a shift on the
/// wizard's line, entered by the station.
async fn open_shift(office: &DeviceState, token: &str, station: &DeviceState) -> String {
    let template = ok(
        office,
        "POST",
        "/v1/office/templates",
        Some(json!({
            "name": "Короб 58×40",
            "purpose": "box",
            "enabled": true,
            "spec": { "widthMm": 58, "heightMm": 40, "dpi": 203, "language": "zpl", "elements": [] }
        })),
        Some(token),
    )
    .await;
    let product = ok(
        office,
        "POST",
        "/v1/office/products",
        Some(json!({
            "gtin14": "04600682000013",
            "name": "Молоко 3,2% 0,9 л",
            "printName": "Молоко 3,2%",
            "chzProductGroupCode": 8,
            "boxCapacity": 12,
            "palletBoxCapacity": 40,
            "shelfLifeDays": 10
        })),
        Some(token),
    )
    .await;
    let lines = ok(office, "GET", "/v1/office/lines", None, Some(token)).await;
    let line = lines[0]["id"].as_str().unwrap().to_owned();
    station.select_line(&line).await.unwrap();
    let shift = ok(
        office,
        "POST",
        "/v1/office/shifts",
        Some(json!({
            "productId": product["id"],
            "lineId": line,
            "productionDate": "2026-10-08",
            "boxTemplateId": template["id"]
        })),
        Some(token),
    )
    .await;
    let id = shift["id"].as_str().unwrap().to_owned();
    ok(
        station,
        "POST",
        &format!("/v1/device/shifts/{id}/enter"),
        None,
        None,
    )
    .await;
    id
}

/// The station asks for a block of box serials under `request`; returns it
/// as the station holds it.
async fn block(station: &DeviceState, request: &str) -> Value {
    let issued = ok(
        station,
        "POST",
        "/v1/device/sscc/blocks",
        Some(json!({ "requestId": request, "issuerPrefix": PREFIX, "extension": 0 })),
        None,
    )
    .await;
    json!({
        "id": issued["id"],
        "issuerPrefix": PREFIX,
        "extension": 0,
        "fromSerial": issued["fromSerial"],
        "toSerial": issued["toSerial"],
    })
}

/// «Сделать копию сейчас», and the copy it made once the worker is done: the
/// database file in the host's local folder and whether the host identity
/// lies beside it.
async fn copy_now(host_dir: &Path, office: &DeviceState, token: &str) -> (PathBuf, bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    // The worker may be making a copy of its own just now: ask again when
    // it is done.
    loop {
        let asked = office
            .request("POST", "/v1/office/backups", None, Some(token))
            .await
            .unwrap();
        if asked.status == 202 {
            break;
        }
        assert!(
            asked.status == 409 && tokio::time::Instant::now() < deadline,
            "{:?}",
            asked.body
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    loop {
        let state = ok(office, "GET", "/v1/office/backups", None, Some(token)).await;
        let manual = state["local"]["copies"]
            .as_array()
            .unwrap()
            .iter()
            .find(|copy| copy["trigger"] == "manual")
            .cloned();
        if let (true, Some(copy)) = (state["running"].is_null(), manual) {
            let file = copy["file"].as_str().unwrap();
            return (
                host_dir.join("backups").join(file),
                copy["hostIdentity"].as_bool().unwrap(),
            );
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "no manual copy: {state}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// The revision a copy was made at.
async fn copy_revision(copy: &Path) -> i64 {
    let mut connection: SqliteConnection = SqliteConnectOptions::new()
        .filename(copy)
        .read_only(true)
        .connect()
        .await
        .unwrap();
    sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
        .fetch_one(&mut connection)
        .await
        .unwrap()
}

/// The new computer's installer started the host once: a fresh identity and
/// a database without a wizard. Returns that identity's fingerprint.
async fn installed(dir: &Path) -> String {
    let host = start_host(dir).await;
    let fingerprint = host.fingerprint.clone();
    host.stop().await.unwrap();
    fingerprint
}

fn saved(dir: &Path) -> DeviceConfig {
    device_config::load(dir).unwrap().unwrap()
}

/// The old host with a paired station, an open shift, the station's first
/// block and a copy made after both; then the station gets a second block
/// the copy never saw, and the old host is stopped (its computer died).
struct Before {
    office: DeviceState,
    station: DeviceState,
    copy: PathBuf,
    with_identity: bool,
    /// The revision the copy was made at.
    copy_revision: i64,
    /// The newest revision the station saw on the old host.
    seen_revision: i64,
    config: DeviceConfig,
    fingerprint: String,
    host_id: String,
    address: String,
    shift: String,
    /// In the copy.
    first: Value,
    /// Issued after the copy: the restored host has lost it.
    second: Value,
}

async fn old_host_died(old_dir: &Path, office_dir: &Path, station_dir: &Path) -> Before {
    let old = start_host(old_dir).await;
    let (office, token) = office(&old, office_dir).await;
    let station = station(&old, &office, &token, station_dir).await;
    let shift = open_shift(&office, &token, &station).await;
    let first = block(&station, FIRST_REQUEST).await;
    let (copy, with_identity) = copy_now(old_dir, &office, &token).await;
    let second = block(&station, SECOND_REQUEST).await;
    let before = Before {
        office,
        copy_revision: copy_revision(&copy).await,
        seen_revision: revision(&station).await,
        station,
        copy,
        with_identity,
        config: saved(station_dir),
        fingerprint: old.fingerprint.clone(),
        host_id: old.host_id.clone(),
        address: address(&old),
        shift,
        first,
        second,
    };
    old.stop().await.unwrap();
    before
}

fn restore_options(identity: IdentityChoice) -> RestoreOptions {
    RestoreOptions {
        without_manifest: false,
        identity,
    }
}

// --- the facts a station sends after the restore ---

fn record_id(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

fn box_id(n: u32) -> String {
    format!("b0000000-0000-4000-8000-{n:012}")
}

fn instant(second: u32) -> String {
    format!("2026-10-08T06:{:02}:{:02}.000Z", second / 60, second % 60)
}

fn code_hash(n: u32) -> String {
    format!("{n:064x}")
}

/// The SSCC of a box of `serial` under `PREFIX`, with its GS1 check digit.
fn sscc(serial: u64) -> String {
    let width = 16 - PREFIX.len();
    let body = format!("0{PREFIX}{serial:0width$}");
    let sum: u32 = body
        .bytes()
        .rev()
        .enumerate()
        .map(|(place, digit)| u32::from(digit - b'0') * if place % 2 == 0 { 3 } else { 1 })
        .sum();
    format!("{body}{}", (10 - sum % 10) % 10)
}

/// Two scans into box `n` and its closing under the serial `serial` of
/// `block`: what the station sends for a box it closed.
fn closed_box(shift: &str, block: &Value, serial: u64, n: u32) -> Vec<Value> {
    let scan = |code: u32, at: u32| {
        json!({
            "id": record_id(n * 10 + code), "kind": "scan", "shiftId": shift, "operatorId": null,
            "data": {
                "scannedAt": instant(at), "verdict": "ok", "duplicateSource": null,
                "rawKind": "km", "rawLength": 38, "boxId": box_id(n),
                "code": {
                    "codeHash": code_hash(n * 10 + code),
                    "gtin14": "04600682000013",
                    "serial": format!("S{:06}", n * 10 + code),
                    "canonical": format!("010460068200001321S{:06}\u{1d}93Tail", n * 10 + code)
                }
            }
        })
    };
    let hashes = vec![code_hash(n * 10 + 1), code_hash(n * 10 + 2)];
    vec![
        scan(1, 1),
        scan(2, 2),
        json!({
            "id": record_id(n * 10 + 3), "kind": "box_closed", "shiftId": shift, "operatorId": null,
            "data": {
                "boxId": box_id(n), "sscc": sscc(serial), "blockId": block["id"],
                "serial": serial, "openedAt": instant(1), "closedAt": instant(30),
                "itemCount": 2,
                "membershipDigest": markiro_host::facts::rules::box_membership_digest(&hashes)
            }
        }),
    ]
}

fn accepted(records: &[Value]) -> Vec<Value> {
    records
        .iter()
        .map(|record| json!({ "id": record["id"], "outcome": "accepted" }))
        .collect()
}

#[tokio::test]
async fn a_station_keeps_its_pairing_with_its_host_restored_on_a_new_computer() {
    let old_dir = tempfile::tempdir().unwrap();
    let new_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let before = old_host_died(old_dir.path(), office_dir.path(), station_dir.path()).await;
    assert!(before.with_identity, "the copy carries the host identity");
    let device_before = before.station.status().unwrap().unwrap();

    let fresh = installed(new_dir.path()).await;
    assert_ne!(fresh, before.fingerprint);
    let report = restore_now(
        &HostPaths::new(new_dir.path()),
        &before.copy,
        restore_options(IdentityChoice::Auto),
    )
    .await
    .unwrap();
    assert!(
        matches!(report.identity, IdentityOutcome::Restored { .. }),
        "{:?}",
        report.identity
    );
    assert_eq!(
        report.revision,
        before.copy_revision + 1,
        "the copy's next revision"
    );
    let new = start_host(new_dir.path()).await;
    assert_eq!(
        (new.fingerprint.as_str(), new.host_id.as_str()),
        (before.fingerprint.as_str(), before.host_id.as_str()),
        "the same host to the station"
    );
    assert_ne!(address(&new), before.address, "another address");

    // The station finds nothing at the old address, and the new address is
    // the same host: the pinned certificate is accepted, the key is known.
    assert_eq!(
        before
            .station
            .request("GET", "/v1/device", None, None)
            .await,
        Err(DeviceError::Request(RequestError::Unreachable)),
        "nothing answers at the old address"
    );
    let status = before.station.change_address(&address(&new)).await.unwrap();
    assert_eq!(status.host_address, address(&new));
    assert_eq!(
        (&status.device_id, &status.host_id, &status.fingerprint),
        (
            &device_before.device_id,
            &device_before.host_id,
            &device_before.fingerprint
        ),
        "the same device of the same host"
    );
    assert_eq!(
        saved(station_dir.path()),
        DeviceConfig {
            host_address: address(&new),
            ..before.config
        },
        "only the address changes: the key, the fingerprint and the device stay"
    );
    let device = ok(&before.station, "GET", "/v1/device", None, None).await;
    assert_eq!(
        device["id"],
        json!(device_before.device_id),
        "the restored host knows the station's key"
    );
    assert_eq!(
        revision(&before.station).await,
        before.copy_revision + 1,
        "the revision goes on from the copy, never back"
    );

    // The restore holds the stations' facts until an administrator resumes
    // them.
    let held = before
        .station
        .request(
            "POST",
            "/v1/device/facts",
            Some(&json!({ "records": [] })),
            None,
        )
        .await
        .unwrap();
    assert_eq!(held.status, 503, "{:?}", held.body);
    assert_eq!(held.body.unwrap()["error"]["code"], "restore_pending");

    // The station gives its blocks back: the one in the copy is known, the one
    // issued after it is registered again, and nothing is refused.
    let answered = ok(
        &before.station,
        "POST",
        "/v1/device/sscc/blocks/known",
        Some(json!({ "blocks": [before.first, before.second] })),
        None,
    )
    .await;
    assert_eq!(
        answered,
        json!({ "results": [
            { "id": before.first["id"], "outcome": "known", "code": null },
            { "id": before.second["id"], "outcome": "registered", "code": null },
        ] })
    );
    let after_blocks = revision(&before.station).await;
    assert!(
        after_blocks > before.seen_revision,
        "the revision the station saw on the old host is behind the new one: {after_blocks} vs {}",
        before.seen_revision
    );

    // The office PC, paired with the same host, signs in again (a restore
    // ends every session) and lets the facts through.
    before.office.change_address(&address(&new)).await.unwrap();
    let wizard: Value = serde_json::from_str(BOOTSTRAP).unwrap();
    let signed_in = ok(
        &before.office,
        "POST",
        "/v1/office/login",
        Some(json!({
            "login": wizard["admin"]["login"],
            "password": wizard["admin"]["password"]
        })),
        None,
    )
    .await;
    let token = signed_in["token"].as_str().unwrap().to_owned();
    ok(
        &before.office,
        "POST",
        "/v1/office/backups/resume",
        None,
        Some(&token),
    )
    .await;

    // The box closed with the lost block's serials is accepted: the host
    // issued them, by the station's own word.
    let from = before.second["fromSerial"].as_u64().unwrap();
    let records = closed_box(&before.shift, &before.second, from, 1);
    let flowed = ok(
        &before.station,
        "POST",
        "/v1/device/facts",
        Some(json!({ "records": records })),
        None,
    )
    .await;
    assert_eq!(flowed["receipts"], json!(accepted(&records)), "{flowed}");

    // The next block comes above everything either host issued.
    let third = block(&before.station, THIRD_REQUEST).await;
    assert!(
        third["fromSerial"].as_u64().unwrap() > before.second["toSerial"].as_u64().unwrap(),
        "{third}"
    );
    new.stop().await.unwrap();
}

#[tokio::test]
async fn with_keep_identity_the_new_computer_is_another_host() {
    let old_dir = tempfile::tempdir().unwrap();
    let new_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let before = old_host_died(old_dir.path(), office_dir.path(), station_dir.path()).await;

    installed(new_dir.path()).await;
    let report = restore_now(
        &HostPaths::new(new_dir.path()),
        &before.copy,
        restore_options(IdentityChoice::Keep),
    )
    .await
    .unwrap();
    assert!(report.other_host);
    assert!(
        matches!(
            report.identity,
            IdentityOutcome::Kept { copy_had_one: true }
        ),
        "{:?}",
        report.identity
    );
    let new = start_host(new_dir.path()).await;
    assert_ne!(new.fingerprint, before.fingerprint);

    assert_eq!(
        before.station.change_address(&address(&new)).await,
        Err(DeviceError::AddressOtherHost)
    );
    assert_eq!(saved(station_dir.path()), before.config, "nothing changed");
    new.stop().await.unwrap();
}

/// A copy of an older build: no identity file beside it and none named in
/// its manifest.
fn strip_identity(copy: &Path) {
    std::fs::remove_file(identity_path(copy)).unwrap();
    let manifest_file = copy.with_extension("json");
    let mut manifest: Value =
        serde_json::from_slice(&std::fs::read(&manifest_file).unwrap()).unwrap();
    assert!(manifest
        .as_object_mut()
        .unwrap()
        .remove("identity")
        .is_some());
    std::fs::write(
        &manifest_file,
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
}

#[tokio::test]
async fn a_copy_without_the_identity_leaves_the_pairing_lost_as_before() {
    let old_dir = tempfile::tempdir().unwrap();
    let new_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let before = old_host_died(old_dir.path(), office_dir.path(), station_dir.path()).await;
    strip_identity(&before.copy);

    let fresh = installed(new_dir.path()).await;
    let report = restore_now(
        &HostPaths::new(new_dir.path()),
        &before.copy,
        restore_options(IdentityChoice::Auto),
    )
    .await
    .unwrap();
    assert!(report.other_host, "a new computer");
    assert!(
        matches!(
            report.identity,
            IdentityOutcome::Kept {
                copy_had_one: false
            }
        ),
        "{:?}",
        report.identity
    );
    let new = start_host(new_dir.path()).await;
    assert_eq!(new.fingerprint, fresh, "the installer's own identity stays");
    assert_ne!(new.host_id, before.host_id);
    assert_ne!(new.fingerprint, before.fingerprint);

    assert_eq!(
        before.station.change_address(&address(&new)).await,
        Err(DeviceError::AddressOtherHost),
        "the station has to pair again"
    );
    assert_eq!(saved(station_dir.path()), before.config, "nothing changed");
    new.stop().await.unwrap();
    // `--take-identity` has nothing to take from such a copy.
    let refused = restore_now(
        &HostPaths::new(new_dir.path()),
        &before.copy,
        restore_options(IdentityChoice::Take),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(refused.contains("carries no host identity"), "{refused}");
}

#[tokio::test]
async fn a_copy_of_another_host_does_not_replace_a_working_host_unless_told() {
    let old_dir = tempfile::tempdir().unwrap();
    let office_dir = tempfile::tempdir().unwrap();
    let station_dir = tempfile::tempdir().unwrap();
    let working_dir = tempfile::tempdir().unwrap();
    let working_office_dir = tempfile::tempdir().unwrap();
    let working_station_dir = tempfile::tempdir().unwrap();
    // The copy is of host A; this computer is host B, with a wizard done and
    // a station paired.
    let before = old_host_died(old_dir.path(), office_dir.path(), station_dir.path()).await;
    let working = start_host(working_dir.path()).await;
    let working_fingerprint = working.fingerprint.clone();
    let working_id = working.host_id.clone();
    let (working_office, working_token) = office(&working, working_office_dir.path()).await;
    let working_station = station(
        &working,
        &working_office,
        &working_token,
        working_station_dir.path(),
    )
    .await;
    working.stop().await.unwrap();
    assert_ne!(working_id, before.host_id);

    let refused = restore_now(
        &HostPaths::new(working_dir.path()),
        &before.copy,
        restore_options(IdentityChoice::Auto),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(
        refused.contains("--take-identity") && refused.contains("--keep-identity"),
        "{refused}"
    );
    let unchanged = start_host(working_dir.path()).await;
    assert_eq!(
        (unchanged.fingerprint.as_str(), unchanged.host_id.as_str()),
        (working_fingerprint.as_str(), working_id.as_str()),
        "the refusal changed nothing"
    );
    working_station
        .change_address(&address(&unchanged))
        .await
        .unwrap();
    unchanged.stop().await.unwrap();

    // Told to, this computer becomes host A: A's station keeps its pairing and
    // B's station, which was paired with the host it replaced, does not.
    restore_now(
        &HostPaths::new(working_dir.path()),
        &before.copy,
        restore_options(IdentityChoice::Take),
    )
    .await
    .unwrap();
    let taken = start_host(working_dir.path()).await;
    assert_eq!(taken.fingerprint, before.fingerprint);
    before
        .station
        .change_address(&address(&taken))
        .await
        .unwrap();
    assert_eq!(
        working_station.change_address(&address(&taken)).await,
        Err(DeviceError::AddressOtherHost)
    );
    taken.stop().await.unwrap();
}

/// Rewrite the identity file beside `copy` and, with `named`, the manifest's
/// size and SHA-256 of it, so only what the file says is left to check.
fn rewrite_identity(copy: &Path, edit: impl FnOnce(Vec<u8>) -> Vec<u8>, named: bool) {
    let file = identity_path(copy);
    let bytes = edit(std::fs::read(&file).unwrap());
    std::fs::write(&file, &bytes).unwrap();
    if named {
        let manifest_file = copy.with_extension("json");
        let mut manifest: Value =
            serde_json::from_slice(&std::fs::read(&manifest_file).unwrap()).unwrap();
        manifest["identity"]["sizeBytes"] = json!(bytes.len());
        manifest["identity"]["sha256"] = json!(sha256_hex(&bytes));
        std::fs::write(
            &manifest_file,
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
    }
}

fn private_key(copy: &Path) -> String {
    let file: Value = serde_json::from_slice(&std::fs::read(identity_path(copy)).unwrap()).unwrap();
    file["privateKey"].as_str().unwrap().to_owned()
}

/// A damaged identity is refused with and without `--take-identity` and
/// changes nothing; `--keep-identity` puts the data back without it. No
/// message holds a piece of the key.
async fn damaged_identity_is_refused(before: &Before, new_dir: &Path, fresh: &str, secret: &str) {
    for choice in [IdentityChoice::Auto, IdentityChoice::Take] {
        let refused = restore_now(
            &HostPaths::new(new_dir),
            &before.copy,
            restore_options(choice),
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(refused.contains("damaged"), "{choice:?}: {refused}");
        assert!(refused.contains("--keep-identity"), "{choice:?}: {refused}");
        assert!(
            !refused.contains(&secret[..24]),
            "{choice:?}: the message holds the key"
        );
    }
    let unchanged = start_host(new_dir).await;
    assert_eq!(unchanged.fingerprint, fresh, "the refusals changed nothing");
    unchanged.stop().await.unwrap();

    let report = restore_now(
        &HostPaths::new(new_dir),
        &before.copy,
        restore_options(IdentityChoice::Keep),
    )
    .await
    .unwrap();
    assert!(
        matches!(
            report.identity,
            IdentityOutcome::Kept { copy_had_one: true }
        ),
        "{:?}",
        report.identity
    );
    let new = start_host(new_dir).await;
    assert_eq!(new.fingerprint, fresh);
    assert_eq!(
        before.station.change_address(&address(&new)).await,
        Err(DeviceError::AddressOtherHost)
    );
    new.stop().await.unwrap();
}

#[tokio::test]
async fn an_identity_changed_beside_its_copy_is_refused_and_the_station_is_not_given_to_it() {
    let (old_dir, new_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (office_dir, station_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let before = old_host_died(old_dir.path(), office_dir.path(), station_dir.path()).await;
    let secret = private_key(&before.copy);
    // The same identity and the same size: one space of the indentation is a
    // tab. Only the manifest's SHA-256 of the file tells.
    rewrite_identity(
        &before.copy,
        |bytes| {
            let text = String::from_utf8(bytes).unwrap();
            assert!(text.contains("\n  \""));
            text.replacen("\n  \"", "\n\t \"", 1).into_bytes()
        },
        false,
    );
    let fresh = installed(new_dir.path()).await;
    damaged_identity_is_refused(&before, new_dir.path(), &fresh, &secret).await;
}

#[tokio::test]
async fn a_key_that_does_not_belong_to_the_certificate_is_refused() {
    let (old_dir, other_dir, new_dir) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let (office_dir, station_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (other_office_dir, other_station_dir) =
        (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let before = old_host_died(old_dir.path(), office_dir.path(), station_dir.path()).await;
    let other = old_host_died(
        other_dir.path(),
        other_office_dir.path(),
        other_station_dir.path(),
    )
    .await;
    // Another host's key under this copy's certificate, with the manifest
    // made to agree: only the check of the key against the certificate is
    // left.
    let foreign_key = private_key(&other.copy);
    let secret = private_key(&before.copy);
    assert_ne!(foreign_key, secret);
    rewrite_identity(
        &before.copy,
        |bytes| {
            let mut value: Value = serde_json::from_slice(&bytes).unwrap();
            value["privateKey"] = json!(foreign_key);
            serde_json::to_vec_pretty(&value).unwrap()
        },
        true,
    );
    let fresh = installed(new_dir.path()).await;
    damaged_identity_is_refused(&before, new_dir.path(), &fresh, &secret).await;
}

#[tokio::test]
async fn an_identity_file_lost_from_its_copy_is_refused_the_same_way() {
    let (old_dir, new_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (office_dir, station_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let before = old_host_died(old_dir.path(), office_dir.path(), station_dir.path()).await;
    let secret = private_key(&before.copy);
    std::fs::remove_file(identity_path(&before.copy)).unwrap();
    let fresh = installed(new_dir.path()).await;
    damaged_identity_is_refused(&before, new_dir.path(), &fresh, &secret).await;
}
