//! Native input only. The value is never an IPC argument or result.
use markiro_backup_cloud::{model::Secret, Error, Result};
#[cfg(any(windows, test))]
fn read_client_secret(password: &[u16]) -> Result<Secret> {
    let end = password
        .iter()
        .position(|c| *c == 0)
        .ok_or(Error::Provider("secret_prompt_failed"))?;
    if end == 0 {
        return Err(Error::Provider("client_secret_required"));
    }
    let value = String::from_utf16(&password[..end])
        .map_err(|_| Error::Provider("secret_prompt_failed"))?;
    Secret::client_secret(value).map_err(|_| Error::Provider("client_credentials_invalid"))
}
#[cfg(windows)]
pub fn client_secret(client_id: &str) -> Result<Option<Secret>> {
    use windows_sys::Win32::{
        Foundation::ERROR_CANCELLED, Security::Credentials::*,
        UI::WindowsAndMessaging::GetForegroundWindow,
    };
    use zeroize::Zeroizing;
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let caption = wide("Автоном — Яндекс Диск / Yandex Disk");
    let message = wide("ClientSecret приложения / Application ClientSecret");
    let target = wide("Autonom.YandexBackup");
    let mut user = Zeroizing::new([0u16; 513]);
    for (to, from) in user.iter_mut().zip(client_id.encode_utf16()) {
        *to = from;
    }
    let mut password = Zeroizing::new([0u16; 513]);
    let mut save = 0;
    let info = CREDUI_INFOW {
        cbSize: std::mem::size_of::<CREDUI_INFOW>() as u32,
        hwndParent: unsafe { GetForegroundWindow() },
        pszMessageText: message.as_ptr(),
        pszCaptionText: caption.as_ptr(),
        hbmBanner: std::ptr::null_mut(),
    };
    let result = unsafe {
        CredUIPromptForCredentialsW(
            &info,
            target.as_ptr(),
            std::ptr::null(),
            0,
            user.as_mut_ptr(),
            513,
            password.as_mut_ptr(),
            513,
            &mut save,
            CREDUI_FLAGS_GENERIC_CREDENTIALS
                | CREDUI_FLAGS_DO_NOT_PERSIST
                | CREDUI_FLAGS_ALWAYS_SHOW_UI
                | CREDUI_FLAGS_KEEP_USERNAME,
        )
    };
    if result == ERROR_CANCELLED {
        return Ok(None);
    }
    if result != 0 {
        return Err(Error::Provider("secret_prompt_failed"));
    }
    Ok(Some(read_client_secret(&password[..])?))
}
#[cfg(not(windows))]
pub fn client_secret(_client_id: &str) -> Result<Option<Secret>> {
    Err(Error::Provider("windows_required"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_native_secret_buffers_report_prompt_failure() {
        for buffer in [&[0xd800, 0][..], &[65, 66][..]] {
            assert!(matches!(
                read_client_secret(buffer),
                Err(Error::Provider("secret_prompt_failed"))
            ));
        }
    }
    #[test]
    fn missing_or_invalid_secret_reports_safe_credential_reason() {
        assert!(matches!(
            read_client_secret(&[0]),
            Err(Error::Provider("client_secret_required"))
        ));
        assert!(matches!(
            read_client_secret(&[32, 0]),
            Err(Error::Provider("client_credentials_invalid"))
        ));
        assert!(matches!(read_client_secret(&[65, 0]), Ok(_)));
    }
    #[cfg(not(windows))]
    #[test]
    fn unsupported_secret_prompt_reports_windows_required() {
        assert!(matches!(
            client_secret("client-id"),
            Err(Error::Provider("windows_required"))
        ));
    }
}
