//! The Windows power request behind `set_system_awake`, ported from the
//! cloud station (`apps/station/src-tauri/src/power/windows.rs`). This file
//! uses `std` and `windows-sys` only, so a probe crate can type-check it for
//! Windows on any computer (plan 2a4, task 8).

use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

use windows_sys::Win32::{
    Foundation::INVALID_HANDLE_VALUE,
    System::{
        Power::{
            PowerClearRequest, PowerCreateRequest, PowerRequestDisplayRequired,
            PowerRequestSystemRequired, PowerSetRequest,
        },
        Threading::{POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0},
    },
};

/// A held power request: the display and the system stay on until it drops.
pub struct WindowsPowerRequest {
    handle: OwnedHandle,
}

impl Drop for WindowsPowerRequest {
    fn drop(&mut self) {
        let handle = self.handle.as_raw_handle();
        // SAFETY: `handle` is the live request `acquire` created. These calls
        // balance its two `PowerSetRequest` calls; closing the owned handle
        // right after is the final cleanup even if Windows reports a failure.
        unsafe {
            let _ = PowerClearRequest(handle, PowerRequestDisplayRequired);
            let _ = PowerClearRequest(handle, PowerRequestSystemRequired);
        }
    }
}

/// Creates the request and asks for the display and the system; the reason
/// shows in `powercfg /requests`. Errors carry the system's words for the
/// process log.
pub fn acquire() -> Result<WindowsPowerRequest, String> {
    let mut reason: Vec<u16> = "Markiro standalone: a production shift is open"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let context = REASON_CONTEXT {
        Version: 0,
        Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
        Reason: REASON_CONTEXT_0 {
            SimpleReasonString: reason.as_mut_ptr(),
        },
    };
    // SAFETY: `context` points at `reason`, alive for the call.
    let handle = unsafe { PowerCreateRequest(&context) };
    if handle == INVALID_HANDLE_VALUE {
        return Err(format!(
            "PowerCreateRequest: {}",
            std::io::Error::last_os_error()
        ));
    }
    let request = WindowsPowerRequest {
        // SAFETY: `PowerCreateRequest` returned a valid handle this process
        // owns; `OwnedHandle` closes it exactly once.
        handle: unsafe { OwnedHandle::from_raw_handle(handle) },
    };
    // SAFETY: `handle` is the live request above.
    if unsafe { PowerSetRequest(handle, PowerRequestDisplayRequired) } == 0 {
        return Err(format!(
            "PowerSetRequest(display): {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: as above.
    if unsafe { PowerSetRequest(handle, PowerRequestSystemRequired) } == 0 {
        return Err(format!(
            "PowerSetRequest(system): {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(request)
}
