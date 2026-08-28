//! Resolves the machine name shown on the pairing screen and sent to the
//! cloud at pairing time.
//!
//! This must be resolved here, in Rust, and not read from the webview: in a
//! Tauri 2 webview `window.location.hostname` is the custom-protocol origin
//! (`tauri.localhost`), never the PC name, so every agent that trusted it
//! registered in the cabinet under the literal string `"tauri.localhost"`.

/// Windows: `GetComputerNameExW`, falling back to the `COMPUTERNAME`
/// environment variable, and finally to a fixed placeholder if neither is
/// available (a locked-down or scripted environment). Non-Windows builds
/// only exist so `cargo test` runs in CI; they skip the Win32 call and fall
/// straight to the environment variable / placeholder chain.
pub fn resolve_hostname() -> String {
    resolve_from(win32_computer_name(), std::env::var("COMPUTERNAME").ok())
}

/// The fallback chain as pure data-in, string-out logic, so it can be
/// exercised in a unit test without mutating process-wide environment state
/// (which is inherently racy across parallel tests) or a real machine name.
fn resolve_from(win32: Option<String>, env_var: Option<String>) -> String {
    for name in [win32, env_var].into_iter().flatten() {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    "windows-pc".to_string()
}

#[cfg(windows)]
fn win32_computer_name() -> Option<String> {
    use windows_sys::Win32::System::SystemInformation::{
        ComputerNamePhysicalNetBIOS, GetComputerNameExW,
    };

    // MAX_COMPUTERNAME_LENGTH is 15 for a NetBIOS name, but the physical
    // variant can run longer; 256 is comfortably over any real machine name.
    let mut buf = [0u16; 256];
    let mut len: u32 = buf.len() as u32;
    // SAFETY: `buf` is a valid, writable buffer of `buf.len()` `u16`s and
    // `len` starts at that same capacity, matching `GetComputerNameExW`'s
    // in/out contract for `lpBuffer`/`lpnSize`.
    let ok = unsafe { GetComputerNameExW(ComputerNamePhysicalNetBIOS, buf.as_mut_ptr(), &mut len) };
    if ok == 0 {
        return None;
    }
    let name = String::from_utf16_lossy(&buf[..len as usize]);
    let trimmed = name.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(not(windows))]
fn win32_computer_name() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_the_win32_name_when_present() {
        assert_eq!(
            resolve_from(Some("BUH-PC".to_string()), Some("OTHER-PC".to_string())),
            "BUH-PC"
        );
    }

    #[test]
    fn falls_back_to_the_environment_variable_when_win32_has_nothing() {
        assert_eq!(
            resolve_from(None, Some("ACCOUNTANT-PC".to_string())),
            "ACCOUNTANT-PC"
        );
    }

    #[test]
    fn falls_back_to_a_placeholder_when_nothing_is_available() {
        assert_eq!(resolve_from(None, None), "windows-pc");
    }

    #[test]
    fn treats_a_blank_win32_name_as_absent() {
        assert_eq!(
            resolve_from(Some("   ".to_string()), Some("ACCOUNTANT-PC".to_string())),
            "ACCOUNTANT-PC"
        );
    }

    #[test]
    fn treats_a_blank_environment_variable_as_absent_too() {
        assert_eq!(resolve_from(None, Some("  ".to_string())), "windows-pc");
    }
}
