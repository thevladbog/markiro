//! Kiosk mode of the station window (stage 1 spec §5.1, plan 1f2), ported
//! from the cloud station's `enter_lockdown` and `exit_lockdown`
//! (`apps/station/src-tauri/src/commands.rs`). While it is on, the main
//! window has no frame and no taskbar button, stays above every other
//! window, fills its monitor and refuses to close (`refuse_close_while_locked`).
//! The webview decides when (`src/app/lockdown.ts`); only the office
//! administrator turns it off. Refusals are bare codes, as everywhere in the
//! shell: `no_window` when there is no main window, `window_failed` when the
//! window refused a property; the window system's own text is never sent.

use std::sync::Mutex;

use tauri::{AppHandle, LogicalSize, Manager, Runtime, State, WebviewWindow, Window, WindowEvent};

/// The label of the app's only window (`tauri.conf.json` names none, so it is `main`).
pub const MAIN_WINDOW: &str = "main";

/// The size of an ordinary (not kiosk) window, in logical pixels: what the
/// office is for, a mouse-and-keyboard app that opens as a normal, resizable
/// window and never fills the screen by itself (`tauri.conf.json` has the same
/// numbers for the window's first appearance).
pub const ORDINARY_SIZE: (f64, f64) = (1280.0, 800.0);

/// The least an ordinary window shrinks to, in logical pixels.
pub const ORDINARY_MIN: (f64, f64) = (960.0, 600.0);

/// What the title bar and the window frame take beyond the page, so that an
/// ordinary window fits a work area with its frame (logical pixels).
const FRAME_ALLOWANCE: f64 = 48.0;

/// The size an ordinary window gets on a monitor whose work area (the screen
/// without the taskbar) is `work_area` logical pixels: `ORDINARY_SIZE`, kept
/// inside the work area with room for the frame, and never below
/// `ORDINARY_MIN` (a window that small is the user's to resize). `None` — the
/// monitor is unknown — gives `ORDINARY_SIZE`.
pub fn ordinary_window_size(work_area: Option<(f64, f64)>) -> (f64, f64) {
    let Some((width, height)) = work_area else {
        return ORDINARY_SIZE;
    };
    (
        ORDINARY_SIZE.0.min(width).max(ORDINARY_MIN.0.min(width)),
        ORDINARY_SIZE
            .1
            .min(height - FRAME_ALLOWANCE)
            .max(ORDINARY_MIN.1.min(height - FRAME_ALLOWANCE)),
    )
}

/// The work area of the monitor the window is on, in logical pixels.
fn work_area_of<R: Runtime>(window: &WebviewWindow<R>) -> Option<(f64, f64)> {
    let monitor = window.current_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    if scale <= 0.0 {
        return None;
    }
    let size = monitor.work_area().size;
    Some((
        f64::from(size.width) / scale,
        f64::from(size.height) / scale,
    ))
}

/// Gives the window the shape of an ordinary one: not maximized, not
/// fullscreen, `ordinary_window_size` for its monitor, centred. Every step is
/// tried whatever the others did; `true` when all held.
pub fn settle_ordinary_window<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    let (width, height) = ordinary_window_size(work_area_of(window));
    let results = [
        window.unmaximize(),
        window.set_size(LogicalSize::new(width, height)),
        window.center(),
    ];
    results.iter().all(Result::is_ok)
}

/// Whether the main window is in kiosk mode; off when the app starts.
#[derive(Debug, Default)]
pub struct LockdownState(Mutex<bool>);

impl LockdownState {
    /// Whether kiosk mode is on. A poisoned lock reads as off: the flag must
    /// never keep a window from closing because a thread panicked holding it.
    pub fn is_locked(&self) -> bool {
        self.0.lock().map(|locked| *locked).unwrap_or(false)
    }

    fn set(&self, locked: bool) {
        match self.0.lock() {
            Ok(mut flag) => *flag = locked,
            Err(poisoned) => *poisoned.into_inner() = locked,
        }
    }
}

/// Why a kiosk command failed, as the bare code the webview reads.
#[derive(Debug, PartialEq, Eq)]
pub enum LockdownError {
    /// There is no main window to lock or unlock.
    NoWindow,
    /// The window refused a property (or, on Windows, covering its monitor).
    WindowFailed,
}

impl LockdownError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoWindow => "no_window",
            Self::WindowFailed => "window_failed",
        }
    }
}

/// Places the window over its whole monitor, above the taskbar. Fullscreen
/// alone leaves the taskbar on top on some Windows setups; `SetWindowPos`
/// with `HWND_TOPMOST` over `rcMonitor` does not.
#[cfg(windows)]
fn cover_current_monitor<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), LockdownError> {
    use std::mem::size_of;
    use windows_sys::Win32::{
        Foundation::HWND,
        Graphics::Gdi::{
            GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
        },
        UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_FRAMECHANGED, SWP_SHOWWINDOW},
    };

    let native = window.hwnd().map_err(|_| LockdownError::WindowFailed)?;
    let hwnd = native.0 as HWND;
    // SAFETY: `hwnd` is this process's live main window, as Tauri reports it.
    let monitor_handle = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    if monitor_handle.is_null() {
        return Err(LockdownError::WindowFailed);
    }
    let mut monitor = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    // SAFETY: `monitor` is a properly sized MONITORINFO the call fills in.
    if unsafe { GetMonitorInfoW(monitor_handle, &mut monitor) } == 0 {
        return Err(LockdownError::WindowFailed);
    }
    let bounds = monitor.rcMonitor;
    // SAFETY: plain values; `hwnd` as above.
    let placed = unsafe {
        SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            bounds.left,
            bounds.top,
            bounds.right - bounds.left,
            bounds.bottom - bounds.top,
            SWP_FRAMECHANGED | SWP_SHOWWINDOW,
        )
    };
    if placed == 0 {
        return Err(LockdownError::WindowFailed);
    }
    window.set_focus().map_err(|_| LockdownError::WindowFailed)
}

/// Elsewhere fullscreen is enough; kiosk mode is a Windows product feature.
#[cfg(not(windows))]
fn cover_current_monitor<R: Runtime>(_window: &WebviewWindow<R>) -> Result<(), LockdownError> {
    Ok(())
}

/// Every property back to an ordinary window, each tried whatever the others
/// did (a `?` chain would leave the window half-locked); `true` when all held.
/// The size comes back too: kiosk mode covered the whole monitor, and leaving
/// fullscreen alone would keep that size, a window that only looks maximized.
fn restore_window<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    let results = [
        window.set_fullscreen(false),
        window.set_always_on_top(false),
        window.set_skip_taskbar(false),
        window.set_decorations(true),
    ];
    let held = results.iter().all(Result::is_ok);
    // After the decorations: the size is the page's, the frame is added.
    settle_ordinary_window(window) && held
}

fn main_window<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>, LockdownError> {
    app.get_webview_window(MAIN_WINDOW)
        .ok_or(LockdownError::NoWindow)
}

/// Turns kiosk mode on: no frame, no taskbar button, above every window,
/// fullscreen over its monitor. The flag is set only once every property
/// held; a failure rolls every property back and leaves the flag off, so a
/// window that is not fully locked can still be closed.
pub fn lock<R: Runtime>(app: &AppHandle<R>, state: &LockdownState) -> Result<(), LockdownError> {
    let window = main_window(app)?;
    let applied = window
        .set_decorations(false)
        .and_then(|()| window.set_skip_taskbar(true))
        .and_then(|()| window.set_always_on_top(true))
        .and_then(|()| window.set_fullscreen(true))
        .map_err(|_| LockdownError::WindowFailed)
        .and_then(|()| cover_current_monitor(&window));
    if let Err(error) = applied {
        restore_window(&window);
        state.set(false);
        return Err(error);
    }
    state.set(true);
    Ok(())
}

/// Turns kiosk mode off. The flag goes off first and always, so the window
/// can be closed even when a property did not come back: an operator is
/// never trapped in a window that refuses to close.
pub fn unlock<R: Runtime>(app: &AppHandle<R>, state: &LockdownState) -> Result<(), LockdownError> {
    state.set(false);
    let window = main_window(app)?;
    if restore_window(&window) {
        Ok(())
    } else {
        Err(LockdownError::WindowFailed)
    }
}

#[tauri::command]
pub fn enter_lockdown<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LockdownState>,
) -> Result<(), String> {
    lock(&app, &state).map_err(|error| error.code().to_owned())
}

#[tauri::command]
pub fn exit_lockdown<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, LockdownState>,
) -> Result<(), String> {
    unlock(&app, &state).map_err(|error| error.code().to_owned())
}

/// The window-event guard `run` installs: a close request (the frame's
/// button, Alt+F4, the taskbar) is refused while kiosk mode is on. Checked
/// at the event, not through `set_closable`, which Linux does not honour.
pub fn refuse_close_while_locked<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if window.state::<LockdownState>().is_locked() {
            api.prevent_close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kiosk_mode_is_off_when_the_app_starts() {
        assert!(!LockdownState::default().is_locked());
    }

    #[test]
    fn the_flag_follows_set() {
        let state = LockdownState::default();
        state.set(true);
        assert!(state.is_locked());
        state.set(false);
        assert!(!state.is_locked());
    }

    #[test]
    fn leaving_kiosk_mode_clears_the_flag_even_without_a_window() {
        let app = tauri::test::mock_app();
        let state = LockdownState::default();
        state.set(true);
        assert_eq!(unlock(app.handle(), &state), Err(LockdownError::NoWindow));
        assert!(!state.is_locked());
    }

    #[test]
    fn an_ordinary_window_is_1280_by_800_on_a_big_enough_screen() {
        assert_eq!(ordinary_window_size(None), (1280.0, 800.0));
        assert_eq!(
            ordinary_window_size(Some((1920.0, 1040.0))),
            (1280.0, 800.0)
        );
        assert_eq!(
            ordinary_window_size(Some((2560.0, 1400.0))),
            (1280.0, 800.0)
        );
    }

    #[test]
    fn an_ordinary_window_fits_a_small_screen_with_room_for_its_frame() {
        // 1366x768 with the taskbar: 728 logical pixels of work area.
        assert_eq!(ordinary_window_size(Some((1366.0, 728.0))), (1280.0, 680.0));
        assert_eq!(ordinary_window_size(Some((1024.0, 728.0))), (1024.0, 680.0));
    }

    #[test]
    fn an_ordinary_window_follows_a_screen_smaller_than_its_minimum() {
        assert_eq!(ordinary_window_size(Some((1000.0, 700.0))), (1000.0, 652.0));
        // Below the minimum the screen wins: the window must stay reachable.
        assert_eq!(ordinary_window_size(Some((800.0, 500.0))), (800.0, 452.0));
    }

    #[test]
    fn refusals_are_bare_codes() {
        assert_eq!(LockdownError::NoWindow.code(), "no_window");
        assert_eq!(LockdownError::WindowFailed.code(), "window_failed");
    }
}
