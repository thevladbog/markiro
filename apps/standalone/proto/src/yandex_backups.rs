//! Public Yandex backup status only. OAuth secrets and callback requests are
//! native host/shell types and deliberately cannot be represented here.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    #[default]
    Disconnected,
    Connecting,
    Connected,
    ReauthRequired,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryState {
    #[default]
    Idle,
    Queued,
    Staging,
    Uploading,
    Verifying,
    Publishing,
    Confirmed,
    Failed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Network,
    RateLimited,
    QuotaExceeded,
    AccessDenied,
    ReauthRequired,
    IdentityMissing,
    IntegrityFailed,
    UnsupportedFormat,
    IncompatibleVersion,
    LocalSpace,
    RemoteConflict,
    Cancelled,
    ClientCredentialsInvalid,
    SecretUnavailable,
    ClientSecretRequired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct YandexBackupStatus {
    pub connection_generation: Option<String>,
    pub state: ConnectionState,
    pub client_id: Option<String>,
    pub account_id: Option<String>,
    pub account_label: Option<String>,
    pub delivery_state: DeliveryState,
    pub pending_since: Option<String>,
    pub last_attempt_at: Option<String>,
    pub last_confirmed_snapshot_id: Option<String>,
    pub last_confirmed_at: Option<String>,
    pub last_confirmed_copy_created_at: Option<String>,
    pub error_code: Option<ErrorCode>,
    pub progress_bytes: u64,
    pub next_attempt_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthBeginReply {
    pub attempt_id: String,
    pub authorization_url: String,
    pub expires_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disconnected_fixture_is_exactly_public_status() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/yandex-backup-disconnected.json"))
                .unwrap();
        let status: YandexBackupStatus = serde_json::from_value(fixture.clone()).unwrap();
        assert_eq!(status, YandexBackupStatus::default());
        assert_eq!(serde_json::to_value(status).unwrap(), fixture);
    }
}
