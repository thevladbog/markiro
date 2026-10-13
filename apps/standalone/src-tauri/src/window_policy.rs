//! Which PCs kiosk mode may lock (owner decision 2026-10-13, after the first
//! Windows test left a station PC with no way to close the app or leave the
//! locked window). The rule:
//!
//! - an office PC (role `office`) and the host's PC (role `host`) never lock:
//!   they are ordinary PCs, with a window that has a frame, a close button and
//!   a size of its own, the host's first-run wizard and floor included;
//! - a station (role `station`, or no readable `installation.json`, which the
//!   floor's safe side counts as a station) is an ordinary window until it is
//!   configured — paired as a station with a line — and locks from then on,
//!   at once and at every later start; an administrator's office session
//!   opens an ordinary window there, a technologist's does not;
//! - `"kiosk": false` in `installation.json` (an administrator's manual edit)
//!   and the launch flag `--windowed` turn kiosk mode off on this PC whatever
//!   else holds: the recovery of an installer who is stuck.
//!
//! The shell owns what it alone knows — the role, the file and the launch
//! flag — as `kiosk_permitted`, enforces it in `lockdown::lock` (a host PC is
//! never locked, even by a webview that asks) and tells the webview through
//! the command `kiosk_permitted` and the event `KIOSK_PERMITTED_EVENT`. The
//! rest of the table is the webview's state (`src/app/lockdown.ts`
//! `kioskDue`); `kiosk_due` here is the same table, and
//! `tests/fixtures/window-policy.json` pins both sides to it.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::installation::{InstallRole, InstallationFile};
use crate::lockdown::{self, LockdownState};

/// The launch flag of the manual recovery: `markiro-standalone.exe --windowed`.
pub const WINDOWED_FLAG: &str = "--windowed";

/// Sent with `false` when a second launch with `--windowed` turned kiosk mode
/// off for the running app.
pub const KIOSK_PERMITTED_EVENT: &str = "standalone://kiosk-permitted";

/// An office session as the window-mode table reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfficeSession {
    None,
    /// An administrator's: the one role that may leave kiosk mode.
    Administrator,
    /// Any other role's (a technologist's): the window stays locked.
    Other,
}

/// Whether kiosk mode may lock this PC at all: only a station (or a PC
/// without a readable role), only while `installation.json` does not say
/// `"kiosk": false`, and never after a `--windowed` launch.
pub fn kiosk_permitted(
    role: Option<InstallRole>,
    kiosk_setting: bool,
    windowed_launch: bool,
) -> bool {
    !windowed_launch && kiosk_setting && matches!(role, None | Some(InstallRole::Station))
}

/// The whole table: whether the window is locked now. `configured` is a
/// station paired as a station with a line (the webview's state).
pub fn kiosk_due(permitted: bool, configured: bool, office: OfficeSession) -> bool {
    permitted && configured && office != OfficeSession::Administrator
}

/// Whether the arguments of a launch ask for the ordinary window. The flag
/// is read case-insensitively and also as `/windowed`, as Windows tools take it.
pub fn windowed_requested<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().skip(1).any(|arg| {
        let arg = arg.as_ref();
        arg.eq_ignore_ascii_case(WINDOWED_FLAG) || arg.eq_ignore_ascii_case("/windowed")
    })
}

/// What the shell knows of kiosk mode on this PC: the installation's answer,
/// fixed at start, and the `--windowed` launch, which a second launch can
/// still turn on.
#[derive(Debug)]
pub struct KioskPolicyState {
    by_installation: bool,
    windowed: AtomicBool,
}

impl Default for KioskPolicyState {
    /// A station's: kiosk mode permitted (the mock apps of the tests).
    fn default() -> Self {
        Self::new(true, false)
    }
}

impl KioskPolicyState {
    /// `by_installation` — the role and the file permit kiosk mode
    /// (`kiosk_permitted` without the launch); `windowed_launch` — this
    /// process was started with `--windowed`.
    pub fn new(by_installation: bool, windowed_launch: bool) -> Self {
        Self {
            by_installation,
            windowed: AtomicBool::new(windowed_launch),
        }
    }

    /// The state `run` builds from the installation file and the launch.
    pub fn from_launch<I, S>(file: Option<InstallationFile>, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let role = file.map(|file| file.role);
        let setting = file.is_none_or(|file| file.kiosk);
        Self::new(
            kiosk_permitted(role, setting, false),
            windowed_requested(args),
        )
    }

    pub fn permitted(&self) -> bool {
        self.by_installation && !self.windowed.load(Ordering::SeqCst)
    }

    fn turn_windowed(&self) {
        self.windowed.store(true, Ordering::SeqCst);
    }
}

/// Whether kiosk mode may lock this PC (the webview's `kioskPermitted`).
#[tauri::command]
pub fn kiosk_permitted_now(state: State<'_, KioskPolicyState>) -> bool {
    state.permitted()
}

/// A second launch of the app (the single-instance callback): the running
/// window is shown, unminimized and focused — a locked window without a
/// taskbar button is not in Alt+Tab, so starting the app again is the way
/// back to it — and a launch with `--windowed` turns kiosk mode off for the
/// running app: the window is unlocked here, and the webview is told so.
pub fn on_second_launch<R: Runtime>(app: &AppHandle<R>, argv: &[String]) {
    if windowed_requested(argv) {
        if let Some(policy) = app.try_state::<KioskPolicyState>() {
            policy.turn_windowed();
        }
        if let Some(lockdown_state) = app.try_state::<LockdownState>() {
            if lockdown::unlock(app, &lockdown_state).is_err() {
                eprintln!("standalone: the --windowed launch could not unlock the window");
            }
        }
        let _ = app.emit(KIOSK_PERMITTED_EVENT, false);
    }
    if let Some(window) = app.get_webview_window(lockdown::MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Row {
        role: Option<InstallRole>,
        kiosk_setting: bool,
        windowed_launch: bool,
        configured: bool,
        office: String,
        permitted: bool,
        kiosk: bool,
    }

    #[derive(Deserialize)]
    struct Table {
        rows: Vec<Row>,
    }

    fn office(name: &str) -> OfficeSession {
        match name {
            "none" => OfficeSession::None,
            "administrator" => OfficeSession::Administrator,
            "other" => OfficeSession::Other,
            other => panic!("unknown office session {other}"),
        }
    }

    /// The table both sides follow (`src/app/lockdown.ts` reads it too).
    #[test]
    fn the_window_mode_follows_the_shared_table() {
        let table: Table =
            serde_json::from_str(include_str!("../tests/fixtures/window-policy.json")).unwrap();
        assert!(
            table.rows.len() >= 24,
            "role x configured x office at least"
        );
        for row in &table.rows {
            let permitted = kiosk_permitted(row.role, row.kiosk_setting, row.windowed_launch);
            assert_eq!(
                permitted, row.permitted,
                "permitted: {:?} {}",
                row.role, row.office
            );
            assert_eq!(
                kiosk_due(permitted, row.configured, office(&row.office)),
                row.kiosk,
                "kiosk: {:?} configured={} office={}",
                row.role,
                row.configured,
                row.office
            );
        }
    }

    #[test]
    fn host_and_office_pcs_never_lock() {
        for role in [InstallRole::Host, InstallRole::Office] {
            assert!(!kiosk_permitted(Some(role), true, false));
            for office_session in [
                OfficeSession::None,
                OfficeSession::Administrator,
                OfficeSession::Other,
            ] {
                assert!(!kiosk_due(
                    kiosk_permitted(Some(role), true, false),
                    true,
                    office_session
                ));
            }
        }
    }

    #[test]
    fn a_station_locks_only_once_configured_and_not_for_an_administrator() {
        let permitted = kiosk_permitted(Some(InstallRole::Station), true, false);
        assert!(!kiosk_due(permitted, false, OfficeSession::None));
        assert!(kiosk_due(permitted, true, OfficeSession::None));
        assert!(kiosk_due(permitted, true, OfficeSession::Other));
        assert!(!kiosk_due(permitted, true, OfficeSession::Administrator));
        // No readable role: the floor's safe side, a station.
        assert!(kiosk_due(
            kiosk_permitted(None, true, false),
            true,
            OfficeSession::None
        ));
    }

    #[test]
    fn the_file_and_the_launch_flag_turn_kiosk_mode_off() {
        assert!(!kiosk_permitted(Some(InstallRole::Station), false, false));
        assert!(!kiosk_permitted(Some(InstallRole::Station), true, true));
        assert!(!kiosk_permitted(None, true, true));
    }

    #[test]
    fn reads_the_windowed_flag_after_the_program_name_only() {
        assert!(windowed_requested(["markiro-standalone.exe", "--windowed"]));
        assert!(windowed_requested(["app", "--WINDOWED"]));
        assert!(windowed_requested(["app", "/windowed"]));
        assert!(!windowed_requested(["app"]));
        assert!(!windowed_requested(["--windowed"]));
        assert!(!windowed_requested(["app", "--windowed=1", "windowed"]));
    }

    #[test]
    fn the_state_combines_the_installation_and_the_launch() {
        let station = Some(InstallationFile {
            role: InstallRole::Station,
            kiosk: true,
        });
        assert!(KioskPolicyState::from_launch(station, ["app"]).permitted());
        assert!(!KioskPolicyState::from_launch(station, ["app", "--windowed"]).permitted());
        let host = Some(InstallationFile {
            role: InstallRole::Host,
            kiosk: true,
        });
        assert!(!KioskPolicyState::from_launch(host, ["app"]).permitted());
        let no_kiosk = Some(InstallationFile {
            role: InstallRole::Station,
            kiosk: false,
        });
        assert!(!KioskPolicyState::from_launch(no_kiosk, ["app"]).permitted());
        // No file: a station.
        assert!(KioskPolicyState::from_launch(None, ["app"]).permitted());

        let state = KioskPolicyState::new(true, false);
        state.turn_windowed();
        assert!(!state.permitted());
    }
}
