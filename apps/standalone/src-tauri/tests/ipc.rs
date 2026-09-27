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
use markiro_standalone_lib::connection::ConnectionState;
use markiro_standalone_lib::device::DeviceState;
use markiro_standalone_lib::local_db::LocalDbState;
use serde_json::{json, Value};
use tauri::test::{
    get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY,
};
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow};

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
            "fingerprint",
            "hostAddress",
            "hostId",
            "kind",
            "lineId"
        ]
    );
    assert_eq!(device["deviceId"], status.device_id);
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
