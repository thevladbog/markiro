//! Kiosk mode through Tauri's mock runtime (plan 1f2): the command names the
//! webview invokes (`src/app/lockdown.ts`), their bare refusals and the flag
//! the close guard reads. The mock window accepts every property; on Windows
//! covering the monitor needs a real window handle, which the mock's is not,
//! so there the tests that need a locked window do not run. What Windows
//! really does with the window is checked by hand, never here.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use markiro_standalone_lib::connection::ConnectionState;
use markiro_standalone_lib::device::DeviceState;
use markiro_standalone_lib::local_db::LocalDbState;
use markiro_standalone_lib::lockdown::{self, LockdownState, MAIN_WINDOW};
use markiro_standalone_lib::window_policy::{self, KioskPolicyState};
use serde_json::{json, Value};
use tauri::test::{
    get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY,
};
use tauri::webview::InvokeRequest;
use tauri::{App, Manager, RunEvent, WebviewWindow, WindowEvent};

/// The app's command list on the mock runtime, with one
/// window labelled `label`. The `App` must outlive the window.
fn mock_app(label: &str) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    mock_app_with(label, KioskPolicyState::default())
}

/// `mock_app` with what the installation and the launch permit of kiosk mode.
fn mock_app_with(
    label: &str,
    policy: KioskPolicyState,
) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let dir = tempfile::tempdir().unwrap();
    let app = mock_builder()
        .manage(DeviceState::load(dir.path().to_path_buf()))
        .manage(LocalDbState::unavailable())
        .manage(ConnectionState::default())
        .manage(LockdownState::default())
        .manage(policy)
        .invoke_handler(markiro_standalone_lib::invoke_handler())
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, label, Default::default())
        .build()
        .unwrap();
    (app, webview)
}

/// Invokes `command` as the webview's `invoke` does; a rejection comes back
/// as the JSON value the command rejected with.
fn invoke(webview: &WebviewWindow<MockRuntime>, command: &str) -> Result<Value, Value> {
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
            body: json!({}).into(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|body| body.deserialize::<Value>().unwrap())
}

fn locked(app: &App<MockRuntime>) -> bool {
    app.state::<LockdownState>().is_locked()
}

#[cfg(not(windows))]
#[test]
fn the_kiosk_commands_turn_the_flag_on_and_off() {
    let (app, webview) = mock_app(MAIN_WINDOW);
    assert!(!locked(&app));

    assert_eq!(invoke(&webview, "enter_lockdown"), Ok(Value::Null));
    assert!(locked(&app));
    // Again: nothing changes, nothing fails.
    assert_eq!(invoke(&webview, "enter_lockdown"), Ok(Value::Null));
    assert!(locked(&app));

    assert_eq!(invoke(&webview, "exit_lockdown"), Ok(Value::Null));
    assert!(!locked(&app));
    assert_eq!(invoke(&webview, "exit_lockdown"), Ok(Value::Null));
    assert!(!locked(&app));
}

/// Leaving kiosk mode (the office's «Оконный режим», and every office
/// session of an administrator) answers `Ok` with the size step included: the
/// mock window has no monitor and does not keep a size, so what the step sets
/// is pinned by `lockdown::ordinary_window_size`'s unit tests, and what the
/// real window does by the manual check on Windows.
#[cfg(not(windows))]
#[test]
fn leaving_kiosk_mode_restores_an_ordinary_window() {
    let (_app, webview) = mock_app(MAIN_WINDOW);
    assert_eq!(invoke(&webview, "enter_lockdown"), Ok(Value::Null));
    assert_eq!(invoke(&webview, "exit_lockdown"), Ok(Value::Null));
    assert!(!webview.is_maximized().unwrap());
    assert!(!webview.is_fullscreen().unwrap());
}

/// `SetWindowPos` refuses the mock window's handle (or Windows finds no
/// monitor for it): the enter is refused and rolled back, the flag stays off.
/// Should a Windows version accept it, the flag must be on instead.
#[cfg(windows)]
#[test]
fn on_windows_a_refused_enter_leaves_the_flag_off() {
    let (app, webview) = mock_app(MAIN_WINDOW);
    match invoke(&webview, "enter_lockdown") {
        Ok(Value::Null) => assert!(locked(&app)),
        refused => {
            assert_eq!(refused, Err(json!("window_failed")));
            assert!(!locked(&app));
        }
    }
    assert_eq!(invoke(&webview, "exit_lockdown"), Ok(Value::Null));
    assert!(!locked(&app));
}

/// Owner decision 2026-10-13: a PC kiosk mode may not lock (a host or office
/// PC, `"kiosk": false`, a `--windowed` launch) refuses the enter before any
/// window property changes, whatever the webview asks; leaving still works.
#[test]
fn a_pc_kiosk_mode_may_not_lock_refuses_the_enter() {
    let (app, webview) = mock_app_with(MAIN_WINDOW, KioskPolicyState::new(false, false));
    assert_eq!(invoke(&webview, "kiosk_permitted_now"), Ok(json!(false)));
    assert_eq!(invoke(&webview, "enter_lockdown"), Err(json!("kiosk_off")));
    assert!(!locked(&app));
    assert!(!webview.is_fullscreen().unwrap());
    assert!(!webview.is_always_on_top().unwrap());
    assert_eq!(invoke(&webview, "exit_lockdown"), Ok(Value::Null));

    let (app, webview) = mock_app_with(MAIN_WINDOW, KioskPolicyState::new(true, true));
    assert_eq!(invoke(&webview, "kiosk_permitted_now"), Ok(json!(false)));
    assert_eq!(invoke(&webview, "enter_lockdown"), Err(json!("kiosk_off")));
    assert!(!locked(&app));
}

/// A second launch with `--windowed` (the single-instance callback) unlocks
/// the running window and forbids kiosk mode from then on; one without it
/// changes nothing.
#[cfg(not(windows))]
#[test]
fn a_second_launch_with_windowed_unlocks_the_running_window() {
    let (app, webview) = mock_app(MAIN_WINDOW);
    assert_eq!(invoke(&webview, "kiosk_permitted_now"), Ok(json!(true)));
    assert_eq!(invoke(&webview, "enter_lockdown"), Ok(Value::Null));
    assert!(locked(&app));

    window_policy::on_second_launch(app.handle(), &["markiro-standalone.exe".to_owned()]);
    assert!(locked(&app));

    window_policy::on_second_launch(
        app.handle(),
        &["markiro-standalone.exe".to_owned(), "--windowed".to_owned()],
    );
    assert!(!locked(&app));
    assert!(!webview.is_fullscreen().unwrap());
    assert_eq!(invoke(&webview, "kiosk_permitted_now"), Ok(json!(false)));
    assert_eq!(invoke(&webview, "enter_lockdown"), Err(json!("kiosk_off")));
}

#[test]
fn without_a_main_window_both_commands_refuse_with_a_bare_code() {
    let (app, webview) = mock_app("other");

    assert_eq!(invoke(&webview, "enter_lockdown"), Err(json!("no_window")));
    assert!(!locked(&app));
    assert_eq!(invoke(&webview, "exit_lockdown"), Err(json!("no_window")));
}

/// Runs the mock event loop, asks the main window to close once it runs (a
/// close asked for before that drops the window without an event), and
/// counts the close requests the loop sees. The mock runtime never calls a
/// builder's window-event handler, so the loop's callback hands each request
/// to the guard itself; that `run` installs the guard is checked on Windows.
/// The guard's answer to the first request decides: refused, the test
/// unlocks and asks again, so the window closes on the second request; let
/// through, the window closes on the first and the loop ends there.
fn close_requests(lock_first: bool) -> usize {
    let (app, webview) = mock_app(MAIN_WINDOW);
    if lock_first {
        assert_eq!(invoke(&webview, "enter_lockdown"), Ok(Value::Null));
    }
    let seen = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&seen);
    app.run_return(move |handle, event| match event {
        RunEvent::Ready => webview.close().unwrap(),
        RunEvent::WindowEvent { label, event, .. } => {
            if !matches!(event, WindowEvent::CloseRequested { .. }) {
                return;
            }
            let window = handle.get_webview_window(&label).unwrap();
            lockdown::refuse_close_while_locked(&window.as_ref().window(), &event);
            let count = counter.fetch_add(1, Ordering::SeqCst) + 1;
            if count == 1 {
                lockdown::unlock(handle, &handle.state::<LockdownState>()).unwrap();
            }
            if count < 3 {
                window.close().unwrap();
            } else {
                // A refused close queues no new request of its own, so the
                // loop keeps asking until this bound and then destroys the
                // window: a guard that never lets go ends the run with a
                // count of 3 and fails the assertion instead of hanging.
                window.destroy().unwrap();
            }
        }
        _ => {}
    });
    seen.load(Ordering::SeqCst)
}

#[cfg(not(windows))]
#[test]
fn a_close_request_is_refused_while_kiosk_mode_is_on() {
    assert_eq!(close_requests(true), 2);
}

#[test]
fn a_close_request_goes_through_while_kiosk_mode_is_off() {
    assert_eq!(close_requests(false), 1);
}
