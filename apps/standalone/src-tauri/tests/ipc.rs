//! The IPC contract between the webview and the shell, driven through
//! Tauri's mock runtime: command names, argument names (`officeToken`),
//! JSON shapes and bare-string rejections, exactly as `src/host/client.ts`,
//! `src/host/device.ts`, `src/host/probe.ts`, `src/host/connection.ts` and
//! `src/local/executor.ts` send and read them. A real `markiro-host` answers
//! on 127.0.0.1.
//!
//! `host_local_pair` always targets port 45710 (the host on this computer),
//! so these tests pair through `DeviceState` directly and then load the
//! pairing from disk, as the app does at start.

use markiro_host::config::HostPaths;
use markiro_host::{start, RunningHost, StartOptions};
use markiro_proto::DeviceKind;
use markiro_standalone_lib::connection::ConnectionState;
use markiro_standalone_lib::device::DeviceState;
use markiro_standalone_lib::device_config::{self, DeviceConfig};
use markiro_standalone_lib::local_db::{
    LocalDbState, TableClass, FILE_NAME, MIGRATOR, TABLE_CLASSES,
};
use markiro_standalone_lib::lockdown::LockdownState;
use markiro_standalone_lib::power::SystemAwakeState;
use markiro_standalone_lib::scanner::{self, PortOpener, ScannerManager};
use markiro_standalone_lib::secret_store::{ProtectedSecret, Scheme};
use serde_json::{json, Value};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection};
use tauri::test::{
    get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY,
};
use tauri::webview::InvokeRequest;
use tauri::{App, Manager, WebviewWindow};

const NAME: &str = "Рабочее место хоста";
const BOOTSTRAP: &str = include_str!("../../proto/fixtures/bootstrap-request.json");

/// A host on its own Tokio runtime: the test thread blocks inside each IPC
/// call (`get_ipc_response`) while the host keeps answering on the
/// runtime's workers. Tauri runs async commands on its own runtime.
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

/// The app's own command list on the mock runtime, with the shell's states
/// managed. The `App` is returned too: it must outlive the webview.
fn mock_app_with(
    device: DeviceState,
    local: LocalDbState,
) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let app = mock_builder()
        .manage(device)
        .manage(local)
        .manage(ConnectionState::default())
        .manage(SystemAwakeState::default())
        .invoke_handler(markiro_standalone_lib::invoke_handler())
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    (app, webview)
}

/// The shell without a local database, as when it could not be opened.
fn mock_app(device: DeviceState) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    mock_app_with(device, LocalDbState::unavailable())
}

/// Invokes `command` with `args` as the webview's `invoke` does; a rejection
/// comes back as the JSON value the command rejected with.
fn invoke(
    webview: &WebviewWindow<MockRuntime>,
    command: &str,
    args: Value,
) -> Result<Value, Value> {
    let url = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: url.parse().unwrap(),
            body: args.into(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|body| body.deserialize::<Value>().unwrap())
}

/// The arguments `createTauriHostClient` (src/host/client.ts) sends.
fn request(method: &str, path: &str, body: Value, office_token: Option<&str>) -> Value {
    json!({ "method": method, "path": path, "body": body, "officeToken": office_token })
}

#[test]
fn an_unpaired_device_reports_null_and_refuses_host_requests() {
    let dir = tempfile::tempdir().unwrap();
    let (_app, webview) = mock_app(DeviceState::load(dir.path().to_path_buf()));

    assert_eq!(
        invoke(&webview, "device_status", json!({})),
        Ok(Value::Null)
    );
    assert_eq!(
        invoke(
            &webview,
            "host_request",
            request("GET", "/v1/device", Value::Null, None)
        ),
        Err(json!("not_paired"))
    );
    // The route allow-list is checked before the pairing state: a pairing
    // route is refused even on an unpaired device.
    assert_eq!(
        invoke(
            &webview,
            "host_request",
            request("POST", "/v1/local-pair", Value::Null, None)
        ),
        Err(json!("invalid_request"))
    );
}

#[test]
fn a_paired_device_reaches_the_host_through_the_ipc_shapes() {
    let host = Host::start();
    let app_dir = tempfile::tempdir().unwrap();
    let pairing = DeviceState::load(app_dir.path().to_path_buf());
    let status = host
        .runtime
        .block_on(pairing.local_pair(&host.address(), NAME, "0.1.0"))
        .unwrap();
    drop(pairing);
    let (_app, webview) = mock_app(DeviceState::load(app_dir.path().to_path_buf()));

    let hello = invoke(&webview, "host_hello", json!({ "address": host.address() })).unwrap();
    assert_eq!(hello["hello"]["product"], "markiro-host");
    assert_eq!(hello["hello"]["initialized"], false);
    assert_eq!(hello["fingerprint"], host.running.fingerprint);

    let device = invoke(&webview, "device_status", json!({})).unwrap();
    let mut keys: Vec<&str> = device
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "deviceId",
            "deviceName",
            "fingerprint",
            "hostAddress",
            "hostId",
            "kind",
            "lineId"
        ]
    );
    assert_eq!(device["deviceId"], status.device_id);
    assert_eq!(device["deviceName"], NAME);
    assert_eq!(device["hostAddress"], host.address());

    // A method outside GET/POST/PUT/DELETE is refused by the paired client.
    assert_eq!(
        invoke(
            &webview,
            "host_request",
            request("PATCH", "/v1/device", Value::Null, None)
        ),
        Err(json!("invalid_request"))
    );

    let bootstrap: Value = serde_json::from_str(BOOTSTRAP).unwrap();
    let created = invoke(
        &webview,
        "host_request",
        request("POST", "/v1/bootstrap", bootstrap.clone(), None),
    )
    .unwrap();
    assert_eq!(created["status"], 200);
    let token = created["body"]["session"]["token"]
        .as_str()
        .unwrap()
        .to_owned();

    // `officeToken` reaches the host as the office session header.
    let me = invoke(
        &webview,
        "host_request",
        request("GET", "/v1/office/me", Value::Null, Some(&token)),
    )
    .unwrap();
    assert_eq!(me["status"], 200);
    assert_eq!(me["body"]["login"], bootstrap["admin"]["login"]);

    // An error status is still an answer: `{ status, body }` with the error body.
    let anonymous = invoke(
        &webview,
        "host_request",
        request("GET", "/v1/office/me", Value::Null, None),
    )
    .unwrap();
    assert_eq!(anonymous["status"], 401);
    assert_eq!(anonymous["body"]["error"]["code"], "unauthorized");
    assert_eq!(
        anonymous["body"]["error"]["details"]["credential"],
        "session"
    );

    // A 204 comes back with a null body, which `client.ts` parses as `null`.
    let logout = invoke(
        &webview,
        "host_request",
        request("POST", "/v1/office/logout", Value::Null, Some(&token)),
    )
    .unwrap();
    assert_eq!(logout, json!({ "status": 204, "body": null }));

    // Forgetting the pairing: no arguments, an empty answer, then no pairing.
    assert_eq!(
        invoke(&webview, "device_forget", json!({})),
        Ok(Value::Null)
    );
    assert_eq!(
        invoke(&webview, "device_status", json!({})),
        Ok(Value::Null)
    );

    drop(webview);
    host.stop();
}

/// The arguments `src/local/executor.ts` sends: `params` for a query,
/// `statements` of `{ sql, values, expectedChanges? }` for a batch.
#[test]
fn the_local_database_answers_through_the_ipc_shapes() {
    const LINE: &str = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
    let app_dir = tempfile::tempdir().unwrap();
    let local = tauri::async_runtime::block_on(LocalDbState::open(app_dir.path()));
    let (_app, webview) = mock_app_with(DeviceState::load(app_dir.path().to_path_buf()), local);

    let changes = invoke(
        &webview,
        "local_transaction",
        json!({ "statements": [
            {
                "sql": "INSERT INTO ref_lines (id, name, archived, rev) VALUES (?, ?, ?, ?)",
                "values": [LINE, "Линия 1", 0, 1]
            },
            {
                "sql": "UPDATE ref_lines SET rev = ? WHERE id = ?",
                "values": [2, LINE],
                "expectedChanges": 1
            }
        ] }),
    )
    .unwrap();
    assert_eq!(changes, json!([1, 1]));

    let rows = invoke(
        &webview,
        "local_query",
        json!({ "sql": "SELECT id, name, rev FROM ref_lines WHERE archived = ?", "params": [0] }),
    )
    .unwrap();
    assert_eq!(rows, json!([{ "id": LINE, "name": "Линия 1", "rev": 2 }]));

    assert_eq!(
        invoke(
            &webview,
            "local_query",
            json!({ "sql": "DELETE FROM ref_lines", "params": [] })
        ),
        Err(json!("invalid_statement"))
    );
    assert_eq!(
        invoke(
            &webview,
            "local_transaction",
            json!({ "statements": [{
                "sql": "UPDATE ref_lines SET rev = 3 WHERE id = ?",
                "values": ["no-such-line"],
                "expectedChanges": 1
            }] }),
        ),
        Err(json!("changes_mismatch"))
    );
}

/// Statements a later migration might run, on the app's database behind
/// the webview's back: the webview may not create tables or triggers.
fn run_raw(dir: &std::path::Path, statements: &[&str]) {
    tauri::async_runtime::block_on(async {
        let mut raw = SqliteConnectOptions::new()
            .filename(dir.join(FILE_NAME))
            .connect()
            .await
            .unwrap();
        for sql in statements {
            sqlx::query(sql).execute(&mut raw).await.unwrap();
        }
        raw.close().await.unwrap();
    });
}

/// A trigger that refuses every delete from `sync_state`.
const STUCK_SYNC_STATE: &str = "CREATE TRIGGER sync_state_stays BEFORE DELETE ON sync_state \
    BEGIN SELECT RAISE(ABORT, 'kept'); END";

/// `device_forget` clears the local copies before it removes `device.json`:
/// when clearing fails, the command answers `storage` and the pairing stays,
/// so the user can try again.
#[test]
fn forgetting_the_device_clears_the_local_copies_first() {
    const LINE: &str = "5f0c6a52-6a3e-4b9f-9d3c-2b1a0e8f7d61";
    let app_dir = tempfile::tempdir().unwrap();
    // A pairing the app cannot read: the config-error screen offers exactly
    // this reset, and no host has to answer.
    let config = app_dir.path().join("device.json");
    std::fs::write(&config, "{").unwrap();
    let local = tauri::async_runtime::block_on(LocalDbState::open(app_dir.path()));
    let (_app, webview) = mock_app_with(DeviceState::load(app_dir.path().to_path_buf()), local);
    invoke(
        &webview,
        "local_transaction",
        json!({ "statements": [
            {
                "sql": "INSERT INTO ref_lines (id, name, archived, rev) VALUES (?, ?, ?, ?)",
                "values": [LINE, "Линия 1", 0, 1]
            },
            { "sql": "INSERT INTO sync_state (key, value) VALUES ('last_rev', '1')" }
        ] }),
    )
    .unwrap();
    // Rows of `sync_state` refuse to go. It is the last disposable table
    // `clear_copies` empties, so every other table's delete has already run
    // by the time this one aborts: an implementation that committed each
    // delete on its own, instead of one transaction, would leave
    // `ref_lines` empty here.
    assert_eq!(
        TABLE_CLASSES.last(),
        Some(&("sync_state", TableClass::Disposable))
    );
    run_raw(app_dir.path(), &[STUCK_SYNC_STATE]);
    let copies = || {
        invoke(
            &webview,
            "local_query",
            json!({
                "sql": "SELECT (SELECT count(*) FROM ref_lines) + (SELECT count(*) FROM sync_state) AS n",
                "params": []
            }),
        )
        .unwrap()
    };

    assert_eq!(
        invoke(&webview, "device_forget", json!({})),
        Err(json!("storage"))
    );
    assert!(config.exists(), "the pairing stays for another try");
    assert_eq!(
        copies(),
        json!([{ "n": 2 }]),
        "the clearing rolled back whole"
    );

    run_raw(app_dir.path(), &["DROP TRIGGER sync_state_stays"]);
    assert_eq!(
        invoke(&webview, "device_forget", json!({})),
        Ok(Value::Null)
    );
    assert!(!config.exists());
    assert_eq!(copies(), json!([{ "n": 0 }]));
    assert!(
        app_dir.path().join(FILE_NAME).exists(),
        "an open database is cleared, not removed"
    );
    assert_eq!(
        invoke(&webview, "device_status", json!({})),
        Ok(Value::Null)
    );
}

/// A pairing on disk that the app can read, for tests that need no host.
fn save_pairing(dir: &std::path::Path) {
    save_pairing_at(dir, "https://127.0.0.1:45710");
}

/// A pairing on disk with the host at `address`; no host issued its key.
fn save_pairing_at(dir: &std::path::Path, address: &str) {
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
            device_key: ProtectedSecret {
                scheme: Scheme::Plain,
                value: "device-key-value".into(),
            },
        },
    )
    .unwrap();
}

/// A local address that accepts connections and never answers, not even the
/// TLS handshake; the thread holds them until the test binary exits.
fn silent_address() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let _held: Vec<_> = listener.incoming().collect();
    });
    format!("https://127.0.0.1:{port}")
}

/// `timeoutMs` reaches the shell as milliseconds (`src/host/client.ts`): a
/// host that never answers ends the call with `timeout` once the limit
/// passes, and a limit outside 100–10 000 is `invalid_request` before any
/// connection. Without the limit the same call would end at the client's own
/// 2 s to connect, as `unreachable`.
#[test]
fn host_request_takes_a_limit_in_milliseconds() {
    let app_dir = tempfile::tempdir().unwrap();
    save_pairing_at(app_dir.path(), &silent_address());
    let (_app, webview) = mock_app(DeviceState::load(app_dir.path().to_path_buf()));
    let within = |ms: Value| {
        json!({
            "method": "GET",
            "path": "/v1/device/shifts",
            "body": null,
            "officeToken": null,
            "timeoutMs": ms
        })
    };

    assert_eq!(
        invoke(&webview, "host_request", within(json!(300))),
        Err(json!("timeout"))
    );
    assert_eq!(
        invoke(&webview, "host_request", within(json!(50))),
        Err(json!("invalid_request"))
    );
}

/// A local database that did not open: a file of garbage where the database
/// belongs. The open fails with that file alone in the directory, and only
/// then do the files SQLite keeps beside it appear (`beside`, by suffix), as a
/// crash could leave them. With a garbage `-wal` already there, SQLite maps
/// `-shm` before it reports "not a database", and sqlx closes the handle
/// asynchronously: writing over the files right after the failed open could
/// truncate one that is still mapped, which Windows refuses.
fn unopened_database(dir: &std::path::Path, beside: &[&str]) -> LocalDbState {
    std::fs::write(dir.join(FILE_NAME), "not a database").unwrap();
    let local = tauri::async_runtime::block_on(LocalDbState::open(dir));
    assert!(local.get().is_err(), "a file of garbage does not open");
    for suffix in beside {
        std::fs::write(dir.join(format!("{FILE_NAME}{suffix}")), "not a database").unwrap();
    }
    local
}

/// The files whose name says `device_forget` moved them aside.
fn set_aside(dir: &std::path::Path) -> Vec<String> {
    let prefix = format!("{FILE_NAME}.unreadable-");
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.starts_with(&prefix))
        .collect();
    names.sort_unstable();
    names
}

/// A local database that did not open (here, files of garbage) may hold
/// this device's unsent records: `device_forget` moves it aside with its
/// `-wal`, `-shm` and `-journal` files instead of deleting it, opens a new
/// one, and only then removes `device.json` (stage 2a spec §5.2, question
/// В7). Like the test above, this one needs no host and runs in the sandbox.
#[test]
fn forgetting_the_device_sets_aside_a_local_database_that_did_not_open() {
    let app_dir = tempfile::tempdir().unwrap();
    let config = app_dir.path().join("device.json");
    save_pairing(app_dir.path());
    let local = unopened_database(app_dir.path(), &["-wal", "-shm", "-journal"]);
    let (_app, webview) = mock_app_with(DeviceState::load(app_dir.path().to_path_buf()), local);
    assert_eq!(
        invoke(
            &webview,
            "local_query",
            json!({ "sql": "SELECT 1", "params": [] })
        ),
        Err(json!("local_db_unavailable"))
    );

    assert_eq!(
        invoke(&webview, "device_forget", json!({})),
        Ok(Value::Null)
    );
    assert!(!config.exists());
    let aside = set_aside(app_dir.path());
    assert_eq!(aside.len(), 4, "{aside:?}");
    for name in &aside {
        assert_eq!(
            std::fs::read_to_string(app_dir.path().join(name)).unwrap(),
            "not a database",
            "{name} is kept as it was"
        );
    }
    // A new database stands in its place and answers at once.
    assert_eq!(
        invoke(
            &webview,
            "local_query",
            json!({ "sql": "SELECT count(*) AS n FROM ref_lines", "params": [] })
        ),
        Ok(json!([{ "n": 0 }]))
    );
}

/// A database file that cannot be moved aside fails the forget with
/// `storage`, and `device.json` stays for another try, as when clearing an
/// open database fails. A directory the app may not write stands for a file
/// that is locked or not the app's to move; the same refusal on every system
/// is `a_file_that_cannot_be_set_aside_puts_the_others_back` in
/// `tests/local_db.rs`. A user the permissions do not stop (root) skips it.
#[cfg(unix)]
#[test]
fn forgetting_the_device_keeps_the_pairing_while_an_unopened_database_stays() {
    use std::os::unix::fs::PermissionsExt;
    // The database lives in a directory of its own, so that `device.json`
    // stays removable while the database cannot be moved: a forget that went
    // on after a failed move would then remove the pairing, and the test
    // sees it.
    let app_dir = tempfile::tempdir().unwrap();
    let db_dir = tempfile::tempdir().unwrap();
    let config = app_dir.path().join("device.json");
    save_pairing(app_dir.path());
    let local = unopened_database(db_dir.path(), &["-wal"]);
    let (_app, webview) = mock_app_with(DeviceState::load(app_dir.path().to_path_buf()), local);
    let paired = invoke(&webview, "device_status", json!({}));
    assert!(
        matches!(&paired, Ok(status) if !status.is_null()),
        "the app starts paired"
    );
    let mode = |bits| std::fs::Permissions::from_mode(bits);
    std::fs::set_permissions(db_dir.path(), mode(0o500)).unwrap();
    let probe = db_dir.path().join("probe");
    if std::fs::write(&probe, "").is_ok() {
        std::fs::remove_file(&probe).unwrap();
        std::fs::set_permissions(db_dir.path(), mode(0o700)).unwrap();
        eprintln!("skipped: the permissions do not stop this user");
        return;
    }

    let refused = invoke(&webview, "device_forget", json!({}));
    // Writable again before any assertion, so the directory can be removed.
    std::fs::set_permissions(db_dir.path(), mode(0o700)).unwrap();

    assert_eq!(refused, Err(json!("storage")));
    assert!(config.exists(), "the pairing stays for another try");
    assert_eq!(
        invoke(&webview, "device_status", json!({})),
        paired,
        "the pairing stays"
    );
    assert!(set_aside(db_dir.path()).is_empty(), "nothing was moved");
    for suffix in ["", "-wal"] {
        let file = db_dir.path().join(format!("{FILE_NAME}{suffix}"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "not a database");
    }

    assert_eq!(
        invoke(&webview, "device_forget", json!({})),
        Ok(Value::Null)
    );
    assert!(!config.exists());
    // The database and its WAL, plus the `-shm` index the read-only count of
    // the forget may have created beside them: it moves with them.
    let aside = set_aside(db_dir.path());
    let kept: Vec<_> = aside
        .iter()
        .filter(|name| !name.ends_with("-shm"))
        .collect();
    assert_eq!(kept.len(), 2, "{aside:?}");
}

/// An outbox record without a receipt of the pairing `(host, device)`, in
/// the table of migration `0006`.
fn unsent_record(id: &str, host: &str, device: &str) -> String {
    format!(
        "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) \
         VALUES ('{id}', '{host}', '{device}', 'scan', 'shift-1', '{{}}', \
         '2026-10-09T08:00:00.000Z')"
    )
}

/// The same with an `accepted` receipt.
fn acked_record(id: &str, host: &str, device: &str) -> String {
    format!(
        "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, \
         outcome, acked_at) VALUES ('{id}', '{host}', '{device}', 'scan', 'shift-1', '{{}}', \
         '2026-10-09T08:00:00.000Z', 'accepted', '2026-10-09T08:00:01.000Z')"
    )
}
const PAIRED_HOST: &str = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const PAIRED_DEVICE: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

/// `device_forget` takes `keepUnsent` (`src/host/device.ts`): without it, a
/// record of this pairing without a receipt answers `unsent_facts` and
/// nothing changes; with `true` the forget goes ahead, clears the copies and
/// keeps the record on disk. A record of another pairing does not stop it.
#[test]
fn forgetting_the_device_waits_for_this_pairings_unsent_records() {
    let app_dir = tempfile::tempdir().unwrap();
    let config = app_dir.path().join("device.json");
    save_pairing(app_dir.path());
    let local = tauri::async_runtime::block_on(LocalDbState::open(app_dir.path()));
    let unsent = unsent_record("r1", PAIRED_HOST, PAIRED_DEVICE);
    run_raw(
        app_dir.path(),
        &[
            &unsent,
            "INSERT INTO sync_state (key, value) VALUES ('last_rev', '1')",
        ],
    );
    let (_app, webview) = mock_app_with(DeviceState::load(app_dir.path().to_path_buf()), local);
    let left = || {
        invoke(
            &webview,
            "local_query",
            json!({
                "sql": "SELECT (SELECT count(*) FROM sync_state) AS copies, \
                        (SELECT count(*) FROM outbox) AS records",
                "params": []
            }),
        )
        .unwrap()
    };

    for args in [json!({}), json!({ "keepUnsent": false })] {
        assert_eq!(
            invoke(&webview, "device_forget", args),
            Err(json!("unsent_facts"))
        );
    }
    assert!(config.exists(), "the pairing stays");
    assert_eq!(left(), json!([{ "copies": 1, "records": 1 }]));

    assert_eq!(
        invoke(&webview, "device_forget", json!({ "keepUnsent": true })),
        Ok(Value::Null)
    );
    assert!(!config.exists());
    assert_eq!(left(), json!([{ "copies": 0, "records": 1 }]));
}

/// With `device.json` unreadable the current pairing is unknown, so a record
/// without a receipt of any pairing stops the forget, until the person
/// confirms.
#[test]
fn with_an_unreadable_pairing_any_unsent_record_stops_a_forget() {
    let app_dir = tempfile::tempdir().unwrap();
    let config = app_dir.path().join("device.json");
    std::fs::write(&config, "{").unwrap();
    let local = tauri::async_runtime::block_on(LocalDbState::open(app_dir.path()));
    run_raw(
        app_dir.path(),
        &[&unsent_record("r1", "another-host", "another-device")],
    );
    let (_app, webview) = mock_app_with(DeviceState::load(app_dir.path().to_path_buf()), local);

    assert_eq!(
        invoke(&webview, "device_forget", json!({})),
        Err(json!("unsent_facts"))
    );
    assert!(config.exists());
    assert_eq!(
        invoke(&webview, "device_forget", json!({ "keepUnsent": true })),
        Ok(Value::Null)
    );
    assert!(!config.exists());
}

/// Without any pairing there is no pairing's record to wait for: a forget
/// (the reset of a device that was never paired, or of a pairing already
/// gone) clears the copies at once and leaves the outbox alone.
#[test]
fn without_a_pairing_unsent_records_do_not_stop_a_forget() {
    let app_dir = tempfile::tempdir().unwrap();
    let local = tauri::async_runtime::block_on(LocalDbState::open(app_dir.path()));
    run_raw(
        app_dir.path(),
        &[
            &unsent_record("r1", "another-host", "another-device"),
            "INSERT INTO sync_state (key, value) VALUES ('last_rev', '1')",
        ],
    );
    let (_app, webview) = mock_app_with(DeviceState::load(app_dir.path().to_path_buf()), local);

    assert_eq!(
        invoke(&webview, "device_forget", json!({})),
        Ok(Value::Null)
    );
    assert_eq!(
        invoke(
            &webview,
            "local_query",
            json!({
                "sql": "SELECT (SELECT count(*) FROM sync_state) AS copies, \
                        (SELECT count(*) FROM outbox) AS records",
                "params": []
            }),
        ),
        Ok(json!([{ "copies": 0, "records": 1 }]))
    );
}

/// A migrated database file built on a plain connection (rollback journal, so
/// the file stands alone), with `statements` run on it afterwards.
fn database_file(dir: &std::path::Path, statements: &[&str]) {
    tauri::async_runtime::block_on(async {
        let mut raw = SqliteConnectOptions::new()
            .filename(dir.join(FILE_NAME))
            .create_if_missing(true)
            .connect()
            .await
            .unwrap();
        MIGRATOR.run(&mut raw).await.unwrap();
        for sql in statements {
            sqlx::query(sql).execute(&mut raw).await.unwrap();
        }
        raw.close().await.unwrap();
    });
}

/// Overwrites the page of `_sqlx_migrations` with bytes no b-tree page has:
/// the database still lists its tables and still reads `outbox`, but opening
/// it (the migrations read that table) fails with `SQLITE_CORRUPT`.
fn corrupt_the_migrations_table(dir: &std::path::Path) {
    let path = dir.join(FILE_NAME);
    let (root, size): (i64, i64) = tauri::async_runtime::block_on(async {
        let mut raw = SqliteConnectOptions::new()
            .filename(&path)
            .connect()
            .await
            .unwrap();
        let found = sqlx::query_as(
            "SELECT (SELECT rootpage FROM sqlite_master WHERE name = '_sqlx_migrations'), \
                    (SELECT page_size FROM pragma_page_size)",
        )
        .fetch_one(&mut raw)
        .await
        .unwrap();
        raw.close().await.unwrap();
        found
    });
    let mut bytes = std::fs::read(&path).unwrap();
    let start = usize::try_from((root - 1) * size).unwrap();
    bytes[start..start + usize::try_from(size).unwrap()].fill(0xff);
    std::fs::write(&path, bytes).unwrap();
}

/// A row of a record nobody sent, with a marker to find in the file (its id).
fn unsent_row(host: &str, device: &str) -> String {
    unsent_record("unsent-record-marker", host, device)
}

/// Whether the file at `path` holds `marker` anywhere.
fn file_holds(path: &std::path::Path, marker: &str) -> bool {
    std::fs::read(path).is_ok_and(|bytes| {
        bytes
            .windows(marker.len())
            .any(|window| window == marker.as_bytes())
    })
}

/// Only a corrupt database may be set aside (stage 2a spec §5.2, question В7).
/// A database that fails to open for any other reason is a readable file that
/// may hold this pairing's unsent records: here one that a newer app version
/// migrated, which an older version cannot open (`VersionMissing`). The forget
/// answers `storage` and keeps everything in place — `device.json`, the
/// database and its record — with or without `keepUnsent`.
#[test]
fn a_database_that_fails_to_open_for_another_reason_is_never_set_aside() {
    let app_dir = tempfile::tempdir().unwrap();
    let config = app_dir.path().join("device.json");
    save_pairing(app_dir.path());
    database_file(
        app_dir.path(),
        &[
            &unsent_row(PAIRED_HOST, PAIRED_DEVICE),
            "INSERT INTO _sqlx_migrations (version, description, success, checksum, \
             execution_time) VALUES (9999, 'newer', 1, x'00', 0)",
        ],
    );
    let local = tauri::async_runtime::block_on(LocalDbState::open(app_dir.path()));
    assert!(local.get().is_err(), "a newer migration does not open");
    let (_app, webview) = mock_app_with(DeviceState::load(app_dir.path().to_path_buf()), local);
    let paired = invoke(&webview, "device_status", json!({}));

    for args in [json!({}), json!({ "keepUnsent": true })] {
        assert_eq!(
            invoke(&webview, "device_forget", args),
            Err(json!("storage"))
        );
        assert!(config.exists(), "the pairing stays");
        assert_eq!(invoke(&webview, "device_status", json!({})), paired);
        assert!(set_aside(app_dir.path()).is_empty(), "nothing was moved");
        assert!(
            file_holds(&app_dir.path().join(FILE_NAME), "unsent-record-marker"),
            "the record stays where it was"
        );
    }
}

/// A corrupt database that can still be read is counted before it is moved:
/// this pairing's record without a receipt stops the forget until the person
/// confirms (`unsent_facts`); then the file is moved, record and all.
#[test]
fn a_corrupt_database_with_unsent_records_waits_for_a_confirmation() {
    let app_dir = tempfile::tempdir().unwrap();
    let config = app_dir.path().join("device.json");
    save_pairing(app_dir.path());
    database_file(app_dir.path(), &[&unsent_row(PAIRED_HOST, PAIRED_DEVICE)]);
    corrupt_the_migrations_table(app_dir.path());
    let local = tauri::async_runtime::block_on(LocalDbState::open(app_dir.path()));
    assert!(local.get().is_err(), "a corrupt table does not open");
    let (_app, webview) = mock_app_with(DeviceState::load(app_dir.path().to_path_buf()), local);

    for args in [json!({}), json!({ "keepUnsent": false })] {
        assert_eq!(
            invoke(&webview, "device_forget", args),
            Err(json!("unsent_facts"))
        );
        assert!(config.exists(), "the pairing stays");
        assert!(set_aside(app_dir.path()).is_empty(), "nothing was moved");
    }

    assert_eq!(
        invoke(&webview, "device_forget", json!({ "keepUnsent": true })),
        Ok(Value::Null)
    );
    assert!(!config.exists());
    let aside = set_aside(app_dir.path());
    let main = aside
        .iter()
        .find(|name| !name.ends_with("-wal") && !name.ends_with("-shm"))
        .expect("the database file was moved");
    assert!(
        file_holds(&app_dir.path().join(main), "unsent-record-marker"),
        "the record went with the file"
    );
    assert_eq!(
        invoke(
            &webview,
            "local_query",
            json!({ "sql": "SELECT count(*) AS n FROM ref_lines", "params": [] })
        ),
        Ok(json!([{ "n": 0 }])),
        "a new database stands in its place"
    );
}

/// Records with a receipt, and another pairing's, do not stop a corrupt
/// database from being set aside, as they do not stop clearing an open one.
#[test]
fn a_corrupt_database_without_this_pairings_unsent_records_is_set_aside() {
    let app_dir = tempfile::tempdir().unwrap();
    let config = app_dir.path().join("device.json");
    save_pairing(app_dir.path());
    database_file(
        app_dir.path(),
        &[
            &acked_record("a", PAIRED_HOST, PAIRED_DEVICE),
            &unsent_record("b", "another-host", "another-device"),
        ],
    );
    corrupt_the_migrations_table(app_dir.path());
    let local = tauri::async_runtime::block_on(LocalDbState::open(app_dir.path()));
    assert!(local.get().is_err());
    let (_app, webview) = mock_app_with(DeviceState::load(app_dir.path().to_path_buf()), local);

    assert_eq!(
        invoke(&webview, "device_forget", json!({})),
        Ok(Value::Null)
    );
    assert!(!config.exists());
    assert!(!set_aside(app_dir.path()).is_empty(), "the file was moved");
}

/// With `device.json` unreadable any pairing's record without a receipt stops
/// the forget of a corrupt database too.
#[test]
fn with_an_unreadable_pairing_a_corrupt_database_with_any_unsent_record_waits() {
    let app_dir = tempfile::tempdir().unwrap();
    let config = app_dir.path().join("device.json");
    std::fs::write(&config, "{").unwrap();
    database_file(
        app_dir.path(),
        &[&unsent_row("another-host", "another-device")],
    );
    corrupt_the_migrations_table(app_dir.path());
    let local = tauri::async_runtime::block_on(LocalDbState::open(app_dir.path()));
    assert!(local.get().is_err());
    let (_app, webview) = mock_app_with(DeviceState::load(app_dir.path().to_path_buf()), local);

    assert_eq!(
        invoke(&webview, "device_forget", json!({})),
        Err(json!("unsent_facts"))
    );
    assert!(config.exists());
    assert!(set_aside(app_dir.path()).is_empty());
    assert_eq!(
        invoke(&webview, "device_forget", json!({ "keepUnsent": true })),
        Ok(Value::Null)
    );
    assert!(!config.exists());
    assert!(!set_aside(app_dir.path()).is_empty());
}

/// A corrupt database whose `outbox` cannot be counted (it lacks the columns
/// a forget reads) is not moved without a confirmation either: the count is
/// unknown, so the forget answers `unsent_facts`, and `keepUnsent` confirms.
#[test]
fn a_corrupt_database_whose_outbox_cannot_be_counted_waits_for_a_confirmation() {
    let app_dir = tempfile::tempdir().unwrap();
    let config = app_dir.path().join("device.json");
    save_pairing(app_dir.path());
    // An outbox without the columns a forget reads: a damaged or foreign
    // table (no build of this app ever made one), so it cannot be counted.
    database_file(
        app_dir.path(),
        &[
            "DROP TABLE outbox",
            "CREATE TABLE outbox (id TEXT PRIMARY KEY)",
        ],
    );
    corrupt_the_migrations_table(app_dir.path());
    let local = tauri::async_runtime::block_on(LocalDbState::open(app_dir.path()));
    assert!(local.get().is_err());
    let (_app, webview) = mock_app_with(DeviceState::load(app_dir.path().to_path_buf()), local);

    assert_eq!(
        invoke(&webview, "device_forget", json!({})),
        Err(json!("unsent_facts"))
    );
    assert!(config.exists());
    assert!(set_aside(app_dir.path()).is_empty());
    assert_eq!(
        invoke(&webview, "device_forget", json!({ "keepUnsent": true })),
        Ok(Value::Null)
    );
    assert!(!config.exists());
    assert!(!set_aside(app_dir.path()).is_empty());
}

#[test]
fn without_a_local_database_the_local_commands_say_so() {
    let dir = tempfile::tempdir().unwrap();
    let (_app, webview) = mock_app(DeviceState::load(dir.path().to_path_buf()));
    assert_eq!(
        invoke(
            &webview,
            "local_query",
            json!({ "sql": "SELECT 1", "params": [] })
        ),
        Err(json!("local_db_unavailable"))
    );
    assert_eq!(
        invoke(
            &webview,
            "local_transaction",
            json!({ "statements": [{ "sql": "SELECT 1", "values": [] }] })
        ),
        Err(json!("local_db_unavailable"))
    );
}

/// A second installation pairs by code with the webview's arguments:
/// `address`, `fingerprint`, `code` and `name` (`src/host/device.ts`).
#[test]
fn a_device_claims_a_code_through_the_ipc_shapes() {
    let host = Host::start();
    let office_dir = tempfile::tempdir().unwrap();
    let office = DeviceState::load(office_dir.path().to_path_buf());
    host.runtime
        .block_on(office.local_pair(&host.address(), NAME, "0.1.0"))
        .unwrap();
    let bootstrap: Value = serde_json::from_str(BOOTSTRAP).unwrap();
    let created = host
        .runtime
        .block_on(office.request("POST", "/v1/bootstrap", Some(&bootstrap), None))
        .unwrap();
    let token = created.body.unwrap()["session"]["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let issued = host
        .runtime
        .block_on(office.request("POST", "/v1/office/pairing-codes", None, Some(&token)))
        .unwrap();
    let code = issued.body.unwrap()["code"].as_str().unwrap().to_owned();

    let station_dir = tempfile::tempdir().unwrap();
    let (_app, webview) = mock_app(DeviceState::load(station_dir.path().to_path_buf()));
    let claim = |code: &str| {
        json!({
            "address": host.address(),
            "fingerprint": host.running.fingerprint,
            "code": code,
            "name": "Станция на линии 2"
        })
    };
    assert_eq!(
        invoke(&webview, "host_claim", claim("0000000000")),
        Err(json!("pairing_code_invalid"))
    );
    let status = invoke(&webview, "host_claim", claim(&code)).unwrap();
    assert_eq!(status["hostId"], host.running.host_id);
    assert_eq!(status["fingerprint"], host.running.fingerprint);
    assert_eq!(status["kind"], "station");
    assert_eq!(status["lineId"], Value::Null);
    assert_eq!(status["deviceName"], "Станция на линии 2");
    assert_eq!(invoke(&webview, "device_status", json!({})), Ok(status));

    drop(webview);
    host.stop();
}

/// Line selection with the webview's `lineId`, the feed through
/// `host_request`, and the stream refused there.
#[test]
fn a_station_selects_its_line_through_the_ipc_shapes() {
    let host = Host::start();
    let app_dir = tempfile::tempdir().unwrap();
    let pairing = DeviceState::load(app_dir.path().to_path_buf());
    host.runtime
        .block_on(pairing.local_pair(&host.address(), NAME, "0.1.0"))
        .unwrap();
    let bootstrap: Value = serde_json::from_str(BOOTSTRAP).unwrap();
    let created = host
        .runtime
        .block_on(pairing.request("POST", "/v1/bootstrap", Some(&bootstrap), None))
        .unwrap();
    assert_eq!(created.status, 200);
    drop(pairing);
    let (_app, webview) = mock_app(DeviceState::load(app_dir.path().to_path_buf()));

    let feed = invoke(
        &webview,
        "host_request",
        request("GET", "/v1/changes?since=0", Value::Null, None),
    )
    .unwrap();
    assert_eq!(feed["status"], 200);
    let line = feed["body"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["entity"] == "lines")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();

    assert_eq!(
        invoke(
            &webview,
            "device_select_line",
            json!({ "lineId": "9b2e4a6c-0000-4000-8000-000000000000" })
        ),
        Err(json!("line_rejected"))
    );
    let status = invoke(&webview, "device_select_line", json!({ "lineId": line })).unwrap();
    assert_eq!(status["lineId"], line);
    assert_eq!(
        invoke(&webview, "device_status", json!({})).unwrap()["lineId"],
        line
    );
    assert_eq!(
        invoke(
            &webview,
            "host_request",
            request("GET", "/v1/changes/stream", Value::Null, None)
        ),
        Err(json!("invalid_request"))
    );

    drop(webview);
    host.stop();
}

/// `device_refresh` takes no arguments (`src/host/device.ts`) and answers the
/// pairing's `DeviceStatus` with the line the office assigned.
#[test]
fn a_station_takes_the_office_line_through_the_ipc_shapes() {
    let host = Host::start();
    let app_dir = tempfile::tempdir().unwrap();
    let pairing = DeviceState::load(app_dir.path().to_path_buf());
    let paired = host
        .runtime
        .block_on(pairing.local_pair(&host.address(), NAME, "0.1.0"))
        .unwrap();
    let bootstrap: Value = serde_json::from_str(BOOTSTRAP).unwrap();
    let created = host
        .runtime
        .block_on(pairing.request("POST", "/v1/bootstrap", Some(&bootstrap), None))
        .unwrap();
    let token = created.body.unwrap()["session"]["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let feed = host
        .runtime
        .block_on(pairing.request("GET", "/v1/changes?since=0", None, None))
        .unwrap();
    let line = feed.body.unwrap()["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["entity"] == "lines")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let assigned = host
        .runtime
        .block_on(pairing.request(
            "PUT",
            &format!("/v1/office/devices/{}", paired.device_id),
            Some(&json!({ "lineId": line })),
            Some(&token),
        ))
        .unwrap();
    assert_eq!(assigned.status, 200);
    drop(pairing);
    let (_app, webview) = mock_app(DeviceState::load(app_dir.path().to_path_buf()));

    let refreshed = invoke(&webview, "device_refresh", json!({})).unwrap();
    assert_eq!(refreshed["lineId"], line);
    assert_eq!(refreshed["deviceId"], paired.device_id);
    assert_eq!(invoke(&webview, "device_status", json!({})), Ok(refreshed));

    drop(webview);
    host.stop();
}

/// Without a pairing there is nothing to read again; no host needs to answer.
#[test]
fn an_unpaired_device_has_nothing_to_refresh() {
    let dir = tempfile::tempdir().unwrap();
    let (_app, webview) = mock_app(DeviceState::load(dir.path().to_path_buf()));
    assert_eq!(
        invoke(&webview, "device_refresh", json!({})),
        Err(json!("not_paired"))
    );
}

/// `run` hands the shell's states to the app through `manage_state`, so a
/// state a command reads cannot go missing there unseen: Tauri answers such a
/// command with its own «state not managed» text, which no other test of this
/// file would meet (the mock apps above manage their states themselves). The
/// mock builder does not run `setup`, so the function is called on the built
/// app, directly, as `run`'s `setup` does.
#[test]
fn the_app_manages_every_state_its_commands_read() {
    let dir = tempfile::tempdir().unwrap();
    let app = mock_builder()
        .invoke_handler(markiro_standalone_lib::invoke_handler())
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let link = markiro_standalone_lib::manage_state(app.handle(), dir.path());

    assert!(app.try_state::<DeviceState>().is_some());
    assert!(app.try_state::<LocalDbState>().is_some());
    assert!(app.try_state::<ConnectionState>().is_some());
    assert!(app.try_state::<ScannerManager>().is_some());
    assert!(app.try_state::<LockdownState>().is_some());
    assert!(app.try_state::<SystemAwakeState>().is_some());
    // An unpaired app has no link yet; the receiver is the device's own.
    assert!(link.borrow().is_none());
    // Commands that read the managed states answer, instead of Tauri's refusal.
    assert_eq!(
        invoke(&webview, "device_status", json!({})),
        Ok(Value::Null)
    );
    assert_eq!(
        invoke(&webview, "connection_status", json!({}))
            .unwrap()
            .get("state"),
        Some(&json!("offline"))
    );
    assert_eq!(
        invoke(&webview, "get_scanner_connections", json!({})),
        Ok(json!({ "revision": 0, "scanners": [] }))
    );
    assert_eq!(
        invoke(&webview, "set_system_awake", json!({ "awake": false })),
        Ok(Value::Null)
    );
}

/// `set_system_awake` takes `awake` (`src/hardware/hardware.ts`) and answers
/// `null`, asked twice or not; letting go never fails. Off Windows it holds
/// nothing. On Windows this test asks for a real power request, which a CI
/// runner's session may refuse: then the answer must be the bare
/// `power_request_failed`, and letting go must still succeed.
#[test]
fn keeping_the_computer_awake_answers_through_the_ipc_shape() {
    let dir = tempfile::tempdir().unwrap();
    let (app, webview) = mock_app(DeviceState::load(dir.path().to_path_buf()));
    let awake = |awake: bool| invoke(&webview, "set_system_awake", json!({ "awake": awake }));
    let held = || app.state::<SystemAwakeState>().is_awake();
    assert!(!held());
    for _ in 0..2 {
        let answer = awake(true);
        if cfg!(windows) && answer.is_err() {
            assert_eq!(answer, Err(json!("power_request_failed")));
            assert!(!held(), "a refused request holds nothing");
        } else {
            assert_eq!(answer, Ok(Value::Null));
            assert!(held(), "the argument reached the state: awake is held");
        }
    }
    assert_eq!(awake(false), Ok(Value::Null));
    assert!(!held(), "false lets go");
    assert_eq!(awake(false), Ok(Value::Null));
    assert!(!held());
}

/// `print_bytes` takes `target` and `payloadBase64` (`src/hardware/hardware.ts`)
/// and answers `null` or a bare code; `list_usb_printers` takes nothing. A
/// stub printer on 127.0.0.1 takes the label.
#[test]
fn printing_answers_through_the_ipc_shapes() {
    use std::io::Read;
    let dir = tempfile::tempdir().unwrap();
    let (_app, webview) = mock_app(DeviceState::load(dir.path().to_path_buf()));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (received, printed) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).unwrap();
        received.send(bytes).unwrap();
    });
    let tcp = |port: u16| json!({ "kind": "tcp", "host": "127.0.0.1", "port": port });
    let print = |target: Value, payload: &str| {
        invoke(
            &webview,
            "print_bytes",
            json!({ "target": target, "payloadBase64": payload }),
        )
    };

    assert_eq!(print(tcp(port), "XlhBpB0="), Ok(Value::Null));
    assert_eq!(
        printed
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap(),
        [0x5E, 0x58, 0x41, 0xA4, 0x1D]
    );
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let closed_port = closed.local_addr().unwrap().port();
    drop(closed);
    assert_eq!(print(tcp(closed_port), "XlhB"), Err(json!("not_sent")));
    assert_eq!(
        print(json!({ "kind": "lpt", "port": "LPT1" }), "XlhB"),
        Err(json!("invalid_target"))
    );
    assert_eq!(print(tcp(port), ""), Err(json!("invalid_payload")));
    #[cfg(not(windows))]
    {
        assert_eq!(
            print(json!({ "kind": "usb", "printer": "Zebra ZD421" }), "XlhB"),
            Err(json!("unsupported"))
        );
        assert_eq!(
            invoke(&webview, "list_usb_printers", json!({})),
            Ok(json!([]))
        );
    }
}

/// Every refusal of `print_bytes` is a bare code string, not Tauri's text, and
/// the code says whether a retry could double the label: a printer that takes
/// the connection and hangs up while the label goes out is `outcome_unknown`.
#[test]
fn printing_refusals_are_bare_codes_through_ipc() {
    use base64::Engine;
    let dir = tempfile::tempdir().unwrap();
    let (_app, webview) = mock_app(DeviceState::load(dir.path().to_path_buf()));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        drop(stream);
    });
    let print = |target: Value, payload: &str| {
        invoke(
            &webview,
            "print_bytes",
            json!({ "target": target, "payloadBase64": payload }),
        )
    };
    let tcp = |port: u16| json!({ "kind": "tcp", "host": "127.0.0.1", "port": port });

    // The largest label the command takes, to a printer that hangs up.
    let largest = base64::engine::general_purpose::STANDARD.encode(
        vec![b'^'; markiro_standalone_lib::printer::MAX_PAYLOAD_BYTES],
    );
    assert_eq!(print(tcp(port), &largest), Err(json!("outcome_unknown")));
    drop(largest);

    for payload in ["not base64!!", "XlhB\n", "Xg", "\u{39e}g=="] {
        assert_eq!(
            print(tcp(port), payload),
            Err(json!("invalid_payload")),
            "{payload:?}"
        );
    }
    let too_long = base64::engine::general_purpose::STANDARD.encode(vec![
        b'^';
        markiro_standalone_lib::printer::MAX_PAYLOAD_BYTES
            + 1
    ]);
    assert_eq!(print(tcp(port), &too_long), Err(json!("invalid_payload")));
    for target in [
        json!(null),
        json!({ "kind": "tcp", "host": "127.0.0.1", "port": 0 }),
        json!({ "kind": "tcp", "host": "127.0.0.1 ", "port": 9100 }),
        json!({ "kind": "serial", "port": "COM3", "baud": 0 }),
        json!({ "kind": "usb", "printer": "" }),
    ] {
        assert_eq!(
            print(target.clone(), "XlhB"),
            Err(json!("invalid_target")),
            "{target}"
        );
    }
    // A target that is wrong wins over a payload that is wrong.
    assert_eq!(
        print(json!({ "kind": "lpt" }), ""),
        Err(json!("invalid_target"))
    );
}

/// A fake COM port: the test pushes bytes, the shell's scanner thread reads
/// them. A read waits at most 10 ms, as a real port's timeout does, so a
/// closed configuration stops its thread at once.
struct FakePort(std::sync::mpsc::Receiver<Vec<u8>>);

impl std::io::Read for FakePort {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        use std::sync::mpsc::RecvTimeoutError;
        match self.0.recv_timeout(std::time::Duration::from_millis(10)) {
            Ok(bytes) => {
                buf[..bytes.len()].copy_from_slice(&bytes);
                Ok(bytes.len())
            }
            Err(RecvTimeoutError::Timeout) => Err(std::io::ErrorKind::TimedOut.into()),
            Err(RecvTimeoutError::Disconnected) => Err(std::io::ErrorKind::BrokenPipe.into()),
        }
    }
}

/// Polls `check` until it holds, for at most 3 s.
fn wait_for(what: &str, check: impl Fn() -> bool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !check() {
        assert!(std::time::Instant::now() < deadline, "{what}");
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

/// The scanner commands with the webview's arguments (`scanners` of
/// `{ port, baud }`), and the events `standalone://scan` and
/// `standalone://scanner-status` as the webview hears them, from a fake
/// `COM3` behind the shell's real scanner runtime.
#[test]
fn scanners_answer_through_the_ipc_shapes() {
    use std::sync::{mpsc, Arc, Mutex};
    use tauri::{Listener, Manager};

    let dir = tempfile::tempdir().unwrap();
    let (bytes, port) = mpsc::channel::<Vec<u8>>();
    let port = Arc::new(Mutex::new(Some(port)));
    let opener: PortOpener = Arc::new(move |config| {
        let taken = (config.port == "COM3")
            .then(|| port.lock().unwrap().take())
            .flatten();
        match taken {
            Some(port) => Ok(Box::new(FakePort(port)) as Box<dyn std::io::Read + Send>),
            None => Err(std::io::ErrorKind::NotFound.into()),
        }
    });
    let app = mock_builder()
        .manage(DeviceState::load(dir.path().to_path_buf()))
        .manage(LocalDbState::unavailable())
        .manage(ConnectionState::default())
        .invoke_handler(markiro_standalone_lib::invoke_handler())
        .build(mock_context(noop_assets()))
        .unwrap();
    // The mock builder does not run `setup`, so the manager, which needs the
    // app's handle for its events, is managed once the app exists.
    let sink = scanner::tauri_sink(app.handle().clone());
    app.manage(ScannerManager::new(
        opener,
        sink,
        std::time::Duration::from_millis(20),
    ));
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    // The names `src/hardware/hardware.ts` listens to.
    assert_eq!(scanner::SCAN_EVENT, "standalone://scan");
    assert_eq!(scanner::SCANNER_STATUS_EVENT, "standalone://scanner-status");
    let (scan_tx, scans) = mpsc::channel::<String>();
    app.listen(scanner::SCAN_EVENT, move |event| {
        let _ = scan_tx.send(event.payload().to_owned());
    });
    let (status_tx, statuses) = mpsc::channel::<String>();
    app.listen(scanner::SCANNER_STATUS_EVENT, move |event| {
        let _ = status_tx.send(event.payload().to_owned());
    });
    let connections = || invoke(&webview, "get_scanner_connections", json!({})).unwrap();

    assert_eq!(
        invoke(
            &webview,
            "configure_scanners",
            json!({ "scanners": [{ "port": "com3", "baud": 9600 }] })
        ),
        Ok(Value::Null)
    );
    wait_for("COM3 connects", || {
        connections()["scanners"][0]["status"] == "connected"
    });
    let snapshot = connections();
    assert!(snapshot["revision"].as_u64().unwrap() >= 2, "{snapshot}");
    assert_eq!(
        snapshot["scanners"],
        json!([{ "port": "COM3", "baud": 9600, "status": "connected" }])
    );
    let status: Value = serde_json::from_str(
        &statuses
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(status["revision"], 1);
    assert_eq!(status["scanners"][0]["port"], "COM3");

    bytes
        .send(b"]d2010460000000001521serial\x1d91key\x1d92crypto\r\n".to_vec())
        .unwrap();
    let scan: String = serde_json::from_str(
        &scans
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(scan, "]d2010460000000001521serial\u{1d}91key\u{1d}92crypto");
    // Two scans in one read, a CR-only terminator and one scan cut in two
    // reads: each arrives once, whole and in order.
    bytes.send(b"FIRST\rSEC".to_vec()).unwrap();
    bytes.send(b"OND\n\n".to_vec()).unwrap();
    let mut heard = Vec::new();
    for _ in 0..2 {
        heard.push(
            serde_json::from_str::<String>(
                &scans
                    .recv_timeout(std::time::Duration::from_secs(3))
                    .unwrap(),
            )
            .unwrap(),
        );
    }
    assert_eq!(heard, ["FIRST", "SECOND"]);
    assert!(scans.try_recv().is_err());

    let too_many: Vec<Value> = (1..=33)
        .map(|n| json!({ "port": format!("COM{n}"), "baud": 9600 }))
        .collect();
    assert_eq!(
        invoke(&webview, "configure_scanners", json!({})),
        Err(json!("invalid_scanners"))
    );
    for scanners in [
        Value::Null,
        Value::Array(too_many),
        json!([{ "port": "COM3", "baud": 9600.5 }]),
        json!([{ "port": "COM\u{0}3", "baud": 9600 }]),
        json!([{ "port": "COM3", "baud": 0 }]),
        json!([{ "port": "COM3" }]),
        json!([{ "port": "COM3", "baud": 9600, "parity": "none" }]),
        json!([{ "port": "COM3", "baud": 9600 }, { "port": "com3", "baud": 9600 }]),
        json!("COM3"),
    ] {
        assert_eq!(
            invoke(
                &webview,
                "configure_scanners",
                json!({ "scanners": scanners })
            ),
            Err(json!("invalid_scanners")),
            "{scanners}"
        );
    }
    assert_eq!(connections()["scanners"][0]["status"], "connected");

    assert_eq!(
        invoke(&webview, "close_scanners", json!({})),
        Ok(Value::Null)
    );
    assert_eq!(connections()["scanners"], json!([]));
    // Closing what is closed is no error.
    assert_eq!(
        invoke(&webview, "close_scanners", json!({})),
        Ok(Value::Null)
    );
    // Every status the webview heard, in the order it was emitted: the
    // revisions grow by one, and the last is what `get_scanner_connections`
    // answers.
    let mut revisions = vec![status["revision"].as_u64().unwrap()];
    let mut last = status;
    while let Ok(next) = statuses.recv_timeout(std::time::Duration::from_millis(200)) {
        last = serde_json::from_str(&next).unwrap();
        revisions.push(last["revision"].as_u64().unwrap());
    }
    assert_eq!(revisions, (1..=revisions.len() as u64).collect::<Vec<_>>());
    assert_eq!(last, connections());
    assert_eq!(last["scanners"], json!([]));
    match invoke(&webview, "list_serial_ports", json!({})) {
        Ok(Value::Array(_)) => {}
        Err(code) => assert_eq!(code, json!("serial_unavailable")),
        other => panic!("{other:?}"),
    }
}

/// `src/host/connection.ts` reads this snapshot before the first event.
#[test]
fn the_connection_status_has_the_webview_shape() {
    let dir = tempfile::tempdir().unwrap();
    let (_app, webview) = mock_app(DeviceState::load(dir.path().to_path_buf()));
    assert_eq!(
        invoke(&webview, "connection_status", json!({})),
        Ok(json!({ "state": "offline", "lastContactAt": null, "lastError": null, "seq": 0 }))
    );
}
