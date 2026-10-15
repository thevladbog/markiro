//! «Выбрать папку…»: the system's folder dialog for the office (the second
//! folder of backups, the folder of exports). Windows only, through
//! `SHBrowseForFolderW` with the `windows-sys` features the shell already
//! builds on (no new crate); elsewhere the command answers `unsupported` and
//! the office keeps its manual entry. A cancelled dialog is no error: `None`.

/// Why the dialog could not run; the webview reads the bare code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FolderDialogError {
    /// Not Windows.
    Unsupported,
    /// The dialog failed to start.
    Failed,
}

impl FolderDialogError {
    pub fn code(self) -> &'static str {
        match self {
            FolderDialogError::Unsupported => "unsupported",
            FolderDialogError::Failed => "dialog_failed",
        }
    }
}

/// The title the dialog shows is plain text of a bounded length.
const MAX_TITLE_CHARS: usize = 120;

fn clean_title(title: &str) -> String {
    title
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_TITLE_CHARS)
        .collect()
}

#[cfg(windows)]
fn pick(title: &str) -> Result<Option<String>, FolderDialogError> {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::System::Com::{
        CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED,
    };
    use windows_sys::Win32::UI::Shell::{
        SHBrowseForFolderW, SHGetPathFromIDListW, BIF_EDITBOX, BIF_NEWDIALOGSTYLE,
        BIF_RETURNONLYFSDIRS, BROWSEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    let wide_title: Vec<u16> = std::ffi::OsStr::new(&clean_title(title))
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: plain Win32 calls on this thread; every pointer outlives its call, the item list the
    // dialog returns is freed with `CoTaskMemFree`, and COM is left as it was found.
    unsafe {
        // S_OK and S_FALSE (already initialised) both need the matching uninitialise.
        let init = CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
        let initialised = init >= 0;
        let mut display = [0u16; 260];
        let info = BROWSEINFOW {
            hwndOwner: GetForegroundWindow(),
            pidlRoot: std::ptr::null_mut(),
            pszDisplayName: display.as_mut_ptr(),
            lpszTitle: wide_title.as_ptr(),
            ulFlags: BIF_NEWDIALOGSTYLE | BIF_RETURNONLYFSDIRS | BIF_EDITBOX,
            lpfn: None,
            lParam: 0,
            iImage: 0,
        };
        let item = SHBrowseForFolderW(&info);
        let result = if item.is_null() {
            Ok(None)
        } else {
            let mut path = [0u16; 32_768 / 4];
            let found = SHGetPathFromIDListW(item, path.as_mut_ptr()) != 0;
            CoTaskMemFree(item as *const core::ffi::c_void);
            if found {
                let length = path
                    .iter()
                    .position(|unit| *unit == 0)
                    .unwrap_or(path.len());
                Ok(Some(
                    OsString::from_wide(&path[..length])
                        .to_string_lossy()
                        .into_owned(),
                ))
            } else {
                // A virtual folder (This PC, Network) has no path: nothing is chosen.
                Ok(None)
            }
        };
        if initialised {
            CoUninitialize();
        }
        result
    }
}

#[cfg(not(windows))]
fn pick(_title: &str) -> Result<Option<String>, FolderDialogError> {
    Err(FolderDialogError::Unsupported)
}

/// Opens the system's folder dialog and answers the folder chosen, or `None`
/// when the person cancelled; off the IPC thread, since the dialog waits for a person.
#[tauri::command]
pub async fn pick_folder(title: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || pick(&title))
        .await
        .map_err(|_| FolderDialogError::Failed.code().to_owned())?
        .map_err(|error| error.code().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_title_is_plain_and_bounded() {
        assert_eq!(clean_title("Вторая\nпапка\u{7}"), "Втораяпапка");
        assert_eq!(
            clean_title(&"я".repeat(500)).chars().count(),
            MAX_TITLE_CHARS
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn off_windows_the_dialog_is_unsupported() {
        assert_eq!(pick("x"), Err(FolderDialogError::Unsupported));
        assert_eq!(FolderDialogError::Unsupported.code(), "unsupported");
    }
}
