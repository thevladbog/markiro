//! Secrets, callback codes and access tokens never cross the webview boundary.
pub mod prompt;
pub mod recovery;
use crate::{
    device::{DeviceError, DeviceState},
    host_client::HostResponse,
};
use markiro_backup_cloud::{
    callback::CallbackListener,
    model::{ClientProfile, Secret, REDIRECT_URI, SCOPES},
    Error, Result,
};
use markiro_proto::yandex_backups::{AuthBeginReply, ErrorCode, YandexBackupStatus};
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
            return Err(Error::Provider("operation_busy"));
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
            return Err(Error::Provider("browser_open_failed"));
        }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg(url)
            .spawn()
            .map_err(|_| Error::Provider("browser_open_failed"))?;
        Ok(())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = url;
        Err(Error::Provider("windows_required"))
    }
}
fn host_reason(body: &Value) -> Option<&'static str> {
    let error = body.get("error")?;
    let details = error.get("details")?;
    if error.get("code")?.as_str()? != "conflict"
        || details.get("constraint")?.as_str()? != "yandex_backup"
    {
        return None;
    }
    let reason = details.get("reason")?.as_str()?;
    if reason == "connection_changed" {
        return Some("connection_changed");
    }
    let code: ErrorCode = serde_json::from_value(Value::String(reason.to_owned())).ok()?;
    Some(match code {
        ErrorCode::Network => "network",
        ErrorCode::RateLimited => "rate_limited",
        ErrorCode::QuotaExceeded => "quota_exceeded",
        ErrorCode::AccessDenied => "access_denied",
        ErrorCode::ReauthRequired => "reauth_required",
        ErrorCode::IdentityMissing => "identity_missing",
        ErrorCode::IntegrityFailed => "integrity_failed",
        ErrorCode::UnsupportedFormat => "unsupported_format",
        ErrorCode::IncompatibleVersion => "incompatible_version",
        ErrorCode::LocalSpace => "local_space",
        ErrorCode::RemoteConflict => "remote_conflict",
        ErrorCode::Cancelled => "cancelled",
        ErrorCode::ClientCredentialsInvalid => "client_credentials_invalid",
        ErrorCode::SecretUnavailable => "secret_unavailable",
        ErrorCode::ClientSecretRequired => "client_secret_required",
    })
}

fn host_request_error(error: DeviceError) -> Error {
    Error::Provider(match error.code() {
        "certificate_mismatch" | "host_changed" | "address_other_host" => {
            "host_certificate_mismatch"
        }
        "not_paired" | "key_rejected" | "config_unreadable" => "device_not_authorized",
        "host_too_old" | "app_too_old" => "host_version_mismatch",
        "unreachable" | "timeout" => "host_unreachable",
        "storage" => "local_storage_unavailable",
        _ => "host_operation_failed",
    })
}

fn answer<T: serde::de::DeserializeOwned>(response: HostResponse) -> Result<T> {
    if !(200..300).contains(&response.status) {
        let credential = response
            .body
            .as_ref()
            .and_then(|body| body.get("error"))
            .and_then(|body| body.get("details"))
            .and_then(|details| details.get("credential"))
            .and_then(Value::as_str);
        return Err(Error::Provider(match response.status {
            401 if credential == Some("device") => "device_not_authorized",
            401 => "office_session_expired",
            403 => "office_forbidden",
            409 => response
                .body
                .as_ref()
                .and_then(host_reason)
                .unwrap_or("host_operation_failed"),
            _ => "host_operation_failed",
        }));
    }
    serde_json::from_value(response.body.ok_or(Error::InvalidFormat)?)
        .map_err(|_| Error::InvalidFormat)
}
pub fn safe_error(error: Error) -> String {
    match error {
        Error::RetryAfter { status: 429, .. } => "rate_limited".into(),
        Error::Provider("quota") => "quota_exceeded".into(),
        Error::Provider("reauth") => "reauth_required".into(),
        Error::Provider("integrity") => "integrity_failed".into(),
        Error::Provider(code) => code.to_owned(),
        Error::InvalidAttempt => "attempt_expired".into(),
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
        let host=device.yandex_context().map_err(host_request_error)?;
        let me:Value=answer(host.request(&device,"GET","/v1/office/me",None,&office_token).await.map_err(host_request_error)?)?;
        if me.get("role").and_then(Value::as_str)!=Some("admin"){return Err(Error::Provider("office_forbidden"));}
        let old:YandexBackupStatus=answer(host.request(&device,"GET","/v1/office/backups/yandex",None,&office_token).await.map_err(host_request_error)?)?;
        let id=client_id.clone();let secret=tokio::task::spawn_blocking(move||prompt::client_secret(&id)).await.map_err(|_|Error::Provider("secret_prompt_failed"))??.ok_or(Error::Provider("cancelled"))?;
        if *cancelled.borrow(){return Err(Error::Provider("cancelled"));}
        let listener=CallbackListener::bind().await?;
        let request=json!({"clientId":client_id,"clientSecret":secret.expose(),"expectedGeneration":old.connection_generation});
        let attempt:AuthBeginReply=answer(host.request(&device,"POST","/v1/office/backups/yandex/auth/begin",Some(&request),&office_token).await.map_err(host_request_error)?)?;
        let finish=async {
            let expected=validate_authorize(&attempt.authorization_url,&client_id)?;
            open_browser(&attempt.authorization_url)?;
            let code=tokio::select! {value=listener.receive(&expected)=>value?,_=cancelled.wait_for(|v|*v)=>return Err(Error::Provider("cancelled"))};
            let body=json!({"attemptId":attempt.attempt_id,"state":code.state.expose(),"code":code.code.expose()});
            tokio::select! {reply=host.request(&device,"POST","/v1/office/backups/yandex/auth/complete",Some(&body),&office_token)=>answer(reply.map_err(host_request_error)?),_=cancelled.wait_for(|v|*v)=>Err(Error::Provider("cancelled"))}
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

    fn failure(status: u16, body: Value) -> String {
        safe_error(
            answer::<Value>(HostResponse {
                status,
                body: Some(json!({"error": body})),
            })
            .unwrap_err(),
        )
    }

    #[test]
    fn host_failure_preserves_each_allowed_yandex_reason() {
        for code in [
            "network",
            "rate_limited",
            "quota_exceeded",
            "access_denied",
            "reauth_required",
            "identity_missing",
            "integrity_failed",
            "unsupported_format",
            "incompatible_version",
            "local_space",
            "remote_conflict",
            "cancelled",
            "client_credentials_invalid",
            "secret_unavailable",
            "client_secret_required",
            "connection_changed",
        ] {
            assert_eq!(
                failure(
                    409,
                    json!({
                        "code": "conflict", "message": "private fixture message",
                        "details": {"constraint": "yandex_backup", "reason": code}
                    })
                ),
                code
            );
        }
    }

    #[test]
    fn host_failure_refuses_unknown_or_misplaced_reasons() {
        for body in [
            json!({"code":"conflict", "details":{"constraint":"yandex_backup", "reason":"untrusted fixture value"}}),
            json!({"code":"conflict", "details":{"constraint":"other", "reason":"remote_conflict"}}),
            json!({"code":"conflict", "details":{"reason":"secret_unavailable"}}),
            json!({"code":"conflict", "details":{"constraint":"yandex_backup", "reason":42}}),
            json!({"code":"conflict", "details":{"constraint":"yandex_backup", "reason":{"remote_conflict":null}}}),
            json!({"message":"private fixture message"}),
        ] {
            assert_eq!(failure(409, body), "host_operation_failed");
        }
    }

    #[test]
    fn host_authorization_failures_name_the_office_boundary() {
        assert_eq!(
            failure(401, json!({"details":{"credential":"session"}})),
            "office_session_expired"
        );
        assert_eq!(
            failure(401, json!({"details":{"credential":"device"}})),
            "device_not_authorized"
        );
        assert_eq!(
            failure(403, json!({"code":"forbidden"})),
            "office_forbidden"
        );
    }

    #[test]
    fn native_provider_aliases_use_public_error_names() {
        for (input, expected) in [
            ("quota", "quota_exceeded"),
            ("reauth", "reauth_required"),
            ("integrity", "integrity_failed"),
        ] {
            assert_eq!(safe_error(Error::Provider(input)), expected);
        }
    }

    #[test]
    fn expired_attempts_are_not_user_cancellations() {
        assert_eq!(safe_error(Error::InvalidAttempt), "attempt_expired");
        assert_eq!(safe_error(Error::Provider("cancelled")), "cancelled");
    }

    #[test]
    fn yandex_rate_limit_is_not_a_network_outage() {
        assert_eq!(
            safe_error(Error::RetryAfter {
                seconds: 90,
                status: 429
            }),
            "rate_limited"
        );
        assert_eq!(
            safe_error(Error::RetryAfter {
                seconds: 90,
                status: 503
            }),
            "network"
        );
    }

    #[test]
    fn malformed_host_responses_are_not_connection_failures() {
        assert_eq!(
            safe_error(host_request_error(DeviceError::Request(
                crate::host_client::RequestError::InvalidResponse
            ))),
            "host_operation_failed"
        );
        assert_eq!(
            safe_error(host_request_error(DeviceError::Request(
                crate::host_client::RequestError::Unreachable
            ))),
            "host_unreachable"
        );
    }

    #[tokio::test]
    async fn an_active_operation_has_its_own_failure_code() {
        let state = YandexNativeState::default();
        let _first = state.begin().await.unwrap();
        assert!(matches!(
            state.begin().await,
            Err(Error::Provider("operation_busy"))
        ));
    }

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
