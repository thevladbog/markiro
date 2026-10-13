//! Starting the installer (plan ОБН-2, spec §10.4): the very file whose hash
//! was checked, through the shell's `runas` verb, so Windows asks for an
//! administrator's rights (the installer is per machine) while the app keeps
//! running as the station's ordinary user. Behind [`Launcher`]: tests record
//! the call, only the Windows build calls `ShellExecuteExW`.

use std::path::Path;

/// The Tauri NSIS installer's arguments for an update the app starts:
/// passive (`/P`: a progress window, no questions, and the running app is
/// closed by the installer itself), an update of the installed copy
/// (`/UPDATE`: the previous one is not uninstalled first, so the role and
/// `installation.json` stay), and the app opened again as the signed-in user
/// afterwards (`/R`). Never `/ROLE=`: the hooks take the role from the
/// registry and would refuse another (`installer-hooks.nsh`).
pub const INSTALLER_ARGUMENTS: &str = "/P /UPDATE /R";

/// Why the installer did not start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchError {
    /// Windows' administrator prompt was refused or cancelled (`ERROR_CANCELLED`).
    Cancelled,
    /// Windows did not start it: the error code, for the log only.
    Failed(u32),
    /// Not Windows (a development build).
    Unsupported,
}

impl LaunchError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Cancelled => "uac_cancelled",
            Self::Failed(_) => "launch_failed",
            Self::Unsupported => "unsupported",
        }
    }
}

/// Starts `installer` with `arguments` and returns once Windows started it
/// (or refused); never waits for it to finish.
pub trait Launcher: Send + Sync {
    fn launch(&self, installer: &Path, arguments: &str) -> Result<(), LaunchError>;
}

/// The real launch: `ShellExecuteExW` with `runas` on Windows.
pub struct SystemLauncher;

impl Launcher for SystemLauncher {
    #[cfg(windows)]
    fn launch(&self, installer: &Path, arguments: &str) -> Result<(), LaunchError> {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;

        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_CANCELLED};
        use windows_sys::Win32::UI::Shell::{
            ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS,
            SHELLEXECUTEINFOW,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        fn wide(text: &OsStr) -> Vec<u16> {
            text.encode_wide().chain(std::iter::once(0)).collect()
        }
        let verb = wide(OsStr::new("runas"));
        let file = wide(installer.as_os_str());
        let parameters = wide(OsStr::new(arguments));
        let mut info = SHELLEXECUTEINFOW {
            cbSize: u32::try_from(std::mem::size_of::<SHELLEXECUTEINFOW>()).unwrap_or(u32::MAX),
            // The process handle back (closed at once: nothing waits for the
            // installer), the call finished before it returns, and no error
            // dialog of the shell's own: the office shows the refusal.
            fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
            lpVerb: verb.as_ptr(),
            lpFile: file.as_ptr(),
            lpParameters: parameters.as_ptr(),
            nShow: SW_SHOWNORMAL,
            ..Default::default()
        };
        // SAFETY: `info` is sized and filled as the call expects; the wide
        // strings it points to live until the call returns.
        if unsafe { ShellExecuteExW(&mut info) } == 0 {
            // SAFETY: plain call, right after the failing one.
            let code = unsafe { GetLastError() };
            return Err(if code == ERROR_CANCELLED {
                LaunchError::Cancelled
            } else {
                LaunchError::Failed(code)
            });
        }
        if !info.hProcess.is_null() {
            // SAFETY: the handle `SEE_MASK_NOCLOSEPROCESS` gave back, closed once.
            unsafe { CloseHandle(info.hProcess) };
        }
        Ok(())
    }

    #[cfg(not(windows))]
    fn launch(&self, _installer: &Path, _arguments: &str) -> Result<(), LaunchError> {
        Err(LaunchError::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_installer_updates_passively_keeps_its_role_and_opens_the_app_again() {
        let arguments: Vec<&str> = INSTALLER_ARGUMENTS.split(' ').collect();
        assert_eq!(arguments, ["/P", "/UPDATE", "/R"]);
        // A silent run would hide a hook's refusal; a role would be refused.
        assert!(!INSTALLER_ARGUMENTS.contains("/S"));
        assert!(!INSTALLER_ARGUMENTS.contains("/ROLE"));
    }

    #[test]
    fn refusals_are_the_webviews_codes() {
        assert_eq!(LaunchError::Cancelled.code(), "uac_cancelled");
        assert_eq!(LaunchError::Failed(2).code(), "launch_failed");
        assert_eq!(LaunchError::Unsupported.code(), "unsupported");
    }

    #[cfg(not(windows))]
    #[test]
    fn nothing_is_started_outside_windows() {
        assert_eq!(
            SystemLauncher.launch(Path::new("setup.exe"), INSTALLER_ARGUMENTS),
            Err(LaunchError::Unsupported)
        );
    }
}
