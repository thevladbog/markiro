//! Secrets, callback codes and access tokens never cross the webview boundary.
pub mod prompt;
pub mod recovery;
use crate::{device::DeviceState, host_client::HostResponse};
use markiro_backup_cloud::{
    callback::CallbackListener,
    model::{ClientProfile, Secret, REDIRECT_URI, SCOPES},
    Error, Result,
};
use markiro_proto::yandex_backups::{AuthBeginReply, YandexBackupStatus};
use serde_json::{json, Value};
use tokio::sync::{watch, Mutex};

#[derive(Default)]
pub struct YandexNativeState {
    active: Mutex<Option<watch::Sender<bool>>>,
    pub recovery: Mutex<Option<recovery::Session>>,
}
impl YandexNativeState {
    pub async fn begin(&self) -> Result<watch::Receiver<bool>> {
        let mut active = self.active.lock().await;
        if active.is_some() {
            return Err(Error::InvalidAttempt);
        }
        let (tx, rx) = watch::channel(false);
        *active = Some(tx);
        Ok(rx)
    }
    pub async fn end(&self) {
        *self.active.lock().await = None;
    }
}
pub fn validate_authorize(value: &str, client_id: &str) -> Result<Secret> {
    let url = reqwest::Url::parse(value).map_err(|_| Error::OriginDenied)?;
    if url.scheme() != "https"
        || url.host_str() != Some("oauth.yandex.ru")
        || url.path() != "/authorize"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::OriginDenied);
    }
    let mut fields = std::collections::BTreeMap::new();
    for (k, v) in url.query_pairs() {
        if fields.insert(k.to_string(), v.to_string()).is_some() {
            return Err(Error::InvalidAttempt);
        }
    }
    if fields.len() != 7
        || fields.get("client_id").map(String::as_str) != Some(client_id)
        || fields.get("redirect_uri").map(String::as_str) != Some(REDIRECT_URI)
        || fields.get("scope") != Some(&SCOPES.join(" "))
        || fields.get("response_type").map(String::as_str) != Some("code")
        || fields.get("code_challenge_method").map(String::as_str) != Some("S256")
    {
        return Err(Error::InvalidAttempt);
    }
    for key in ["state", "code_challenge"] {
        if !fields.get(key).is_some_and(|v| {
            v.len() == 43
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        }) {
            return Err(Error::InvalidAttempt);
        }
    }
    Secret::new(fields.remove("state").ok_or(Error::InvalidAttempt)?)
}
pub fn open_browser(url: &str) -> Result<()> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        let verb: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        let url: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                url.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        };
        if result as isize <= 32 {
            return Err(Error::Network);
        }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg(url)
            .spawn()
            .map_err(|_| Error::Network)?;
        Ok(())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = url;
        Err(Error::SecretUnavailable)
    }
}
fn answer<T: serde::de::DeserializeOwned>(response: HostResponse) -> Result<T> {
    if !(200..300).contains(&response.status) {
        return Err(Error::Provider(match response.status {
            401 => "reauth",
            403 => "access_denied",
            409 => "remote_conflict",
            _ => "network",
        }));
    }
    serde_json::from_value(response.body.ok_or(Error::InvalidFormat)?)
        .map_err(|_| Error::InvalidFormat)
}
pub fn safe_error(error: Error) -> String {
    match error {
        Error::Provider(code) => code.to_owned(),
        Error::InvalidAttempt => "cancelled".into(),
        Error::SecretUnavailable => "secret_unavailable".into(),
        Error::OriginDenied => "access_denied".into(),
        Error::Io(e) if e.kind() == std::io::ErrorKind::AddrInUse => "callback_busy".into(),
        Error::Integrity | Error::Crypto => "integrity_failed".into(),
        Error::InvalidFormat | Error::SizeLimit => "unsupported_format".into(),
        _ => "network".into(),
    }
}

#[tauri::command]
pub async fn yandex_connect(
    device: tauri::State<'_, DeviceState>,
    state: tauri::State<'_, YandexNativeState>,
    client_id: String,
    office_token: String,
) -> std::result::Result<YandexBackupStatus, String> {
    let mut cancelled = state.begin().await.map_err(safe_error)?;
    let result=async {
        ClientProfile::new(&client_id)?;
        let host=device.yandex_context().map_err(|_|Error::InvalidAttempt)?;
        let me:Value=answer(host.request(&device,"GET","/v1/office/me",None,&office_token).await.map_err(|_|Error::Network)?)?;
        if me.get("role").and_then(Value::as_str)!=Some("admin"){return Err(Error::Provider("access_denied"));}
        let old:YandexBackupStatus=answer(host.request(&device,"GET","/v1/office/backups/yandex",None,&office_token).await.map_err(|_|Error::Network)?)?;
        let id=client_id.clone();let secret=tokio::task::spawn_blocking(move||prompt::client_secret(&id)).await.map_err(|_|Error::SecretUnavailable)??.ok_or(Error::Provider("cancelled"))?;
        if *cancelled.borrow(){return Err(Error::Provider("cancelled"));}
        let listener=CallbackListener::bind().await?;
        let request=json!({"clientId":client_id,"clientSecret":secret.expose(),"expectedGeneration":old.connection_generation});
        let attempt:AuthBeginReply=answer(host.request(&device,"POST","/v1/office/backups/yandex/auth/begin",Some(&request),&office_token).await.map_err(|_|Error::Network)?)?;
        let finish=async {
            let expected=validate_authorize(&attempt.authorization_url,&client_id)?;
            open_browser(&attempt.authorization_url)?;
            let code=tokio::select! {value=listener.receive(&expected)=>value?,_=cancelled.wait_for(|v|*v)=>return Err(Error::Provider("cancelled"))};
            let body=json!({"attemptId":attempt.attempt_id,"state":code.state.expose(),"code":code.code.expose()});
            tokio::select! {reply=host.request(&device,"POST","/v1/office/backups/yandex/auth/complete",Some(&body),&office_token)=>answer(reply.map_err(|_|Error::Network)?),_=cancelled.wait_for(|v|*v)=>Err(Error::Provider("cancelled"))}
        }.await;
        if finish.is_err(){let _=host.request(&device,"DELETE",&format!("/v1/office/backups/yandex/auth/attempt/{}",attempt.attempt_id),None,&office_token).await;}
        finish
    }.await;
    state.end().await;
    result.map_err(safe_error)
}
#[tauri::command]
pub async fn yandex_cancel(
    state: tauri::State<'_, YandexNativeState>,
) -> std::result::Result<(), String> {
    if let Some(active) = state.active.lock().await.as_ref() {
        active.send_replace(true);
    }
    Ok(())
}
#[tauri::command]
pub fn yandex_registration() -> std::result::Result<(), String> {
    open_browser("https://oauth.yandex.ru/").map_err(safe_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authorize_rejects_redirects_duplicates_and_wrong_app() {
        let attempt = markiro_backup_cloud::oauth::OAuthAttempt::new("client", 0).unwrap();
        let url = attempt.authorization_url().unwrap().to_string();
        assert!(validate_authorize(&url, "client").is_ok());
        assert!(validate_authorize(&url, "other").is_err());
        assert!(validate_authorize(&(url.clone() + "&state=other"), "client").is_err());
        assert!(
            validate_authorize(&url.replace("oauth.yandex.ru", "markiro.app"), "client").is_err()
        );
    }
}
