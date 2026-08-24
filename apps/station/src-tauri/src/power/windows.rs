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

pub struct WindowsPowerRequest {
    handle: OwnedHandle,
}

impl Drop for WindowsPowerRequest {
    fn drop(&mut self) {
        let handle = self.handle.as_raw_handle();
        // These calls balance the two successful PowerSetRequest calls in
        // `acquire`. Closing the owned handle immediately afterwards is the
        // final kernel-side cleanup even if Windows reports a clear failure.
        unsafe {
            let _ = PowerClearRequest(handle, PowerRequestDisplayRequired);
            let _ = PowerClearRequest(handle, PowerRequestSystemRequired);
        }
    }
}

pub fn acquire() -> Result<WindowsPowerRequest, String> {
    let mut reason: Vec<u16> = "Markiro Station: active production shift"
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
    let handle = unsafe { PowerCreateRequest(&context) };
    if handle == INVALID_HANDLE_VALUE {
        return Err(format!(
            "could not create the Windows power request: {}",
            std::io::Error::last_os_error()
        ));
    }
    let request = WindowsPowerRequest {
        // SAFETY: PowerCreateRequest returned a valid owned kernel handle.
        // OwnedHandle closes it exactly once after the request flags clear.
        handle: unsafe { OwnedHandle::from_raw_handle(handle) },
    };
    if unsafe { PowerSetRequest(handle, PowerRequestDisplayRequired) } == 0 {
        return Err(format!(
            "could not keep the Windows display active: {}",
            std::io::Error::last_os_error()
        ));
    }
    if unsafe { PowerSetRequest(handle, PowerRequestSystemRequired) } == 0 {
        return Err(format!(
            "could not keep Windows awake: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(request)
}
