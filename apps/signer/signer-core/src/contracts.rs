//! Rust mirror of `packages/platform-contracts/src/chz-signer.ts`.
//!
//! The TypeScript schemas are `.strict()`, so `deny_unknown_fields` here keeps
//! both directions symmetric: a field the cloud adds without telling us fails
//! loudly instead of being silently dropped. The shared JSON fixtures under
//! `packages/platform-contracts/fixtures/chz-signer/` are parsed by the tests
//! on both sides — they are the contract.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairRequest {
    pub pairing_code: String,
    pub hostname: String,
    pub app_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairResponse {
    pub agent_id: String,
    pub agent_secret: String,
    pub tenant_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrueApiAuthPayload {
    pub true_api_base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inn: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignerTask {
    pub id: String,
    #[serde(rename = "type")]
    pub task_type: String,
    pub payload: TrueApiAuthPayload,
}

/// The envelope of `GET /signer-agent/tasks/next`. An idle poll answers
/// `{"task": null}` with status 200 — not 204.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NextTaskResponse {
    pub task: Option<SignerTask>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskComplete {
    pub token: String,
    pub expires_at: String,
    pub cert_thumbprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cert_subject: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cert_inn: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cert_not_after: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SignerErrorCode {
    CryptoProviderMissing,
    CryptoCertNotFound,
    CryptoCertExpired,
    CryptoContainerUnavailable,
    CryptoPinRequired,
    Network,
    TrueApi,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskFail {
    pub error_code: SignerErrorCode,
    /// The cloud trims and caps this at 2000 chars; trim client-side so the
    /// stored value is exactly what we sent.
    pub message: String,
}

impl TaskFail {
    /// Builds a fail body with the message already trimmed to the server's cap.
    pub fn new(error_code: SignerErrorCode, message: impl Into<String>) -> Self {
        let mut message: String = message.into().trim().to_string();
        if message.chars().count() > 2000 {
            message = message.chars().take(2000).collect();
        }
        if message.is_empty() {
            message = "unspecified failure".to_string();
        }
        Self { error_code, message }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use crate::contracts::*;

    fn fixture(name: &str) -> String {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/platform-contracts/fixtures/chz-signer")
            .join(name);
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
    }

    #[test]
    fn parses_the_shared_fixtures() {
        let req: PairRequest = serde_json::from_str(&fixture("pair-request.json")).unwrap();
        assert_eq!(req.pairing_code, "01234567");
        let res: PairResponse = serde_json::from_str(&fixture("pair-response.json")).unwrap();
        assert_eq!(res.tenant_name, "ООО Ромашка");
        let task: SignerTask = serde_json::from_str(&fixture("task.json")).unwrap();
        assert_eq!(task.payload.inn.as_deref(), Some("7712345678"));
        let done: TaskComplete = serde_json::from_str(&fixture("task-complete.json")).unwrap();
        assert_eq!(done.cert_inn.as_deref(), Some("7712345678"));
        let failed: TaskFail = serde_json::from_str(&fixture("task-fail.json")).unwrap();
        assert_eq!(failed.error_code, SignerErrorCode::CryptoContainerUnavailable);
    }

    #[test]
    fn rejects_unknown_fields_from_the_server() {
        let err = serde_json::from_str::<SignerTask>(
            r#"{"id":"3f0e0f5e-8d1c-4d7a-9b1a-222222222222","type":"true_api_auth",
                "payload":{"trueApiBaseUrl":"https://example.test"},"extra":1}"#,
        );
        assert!(err.is_err(), "unknown fields must not be silently ignored");
    }

    #[test]
    fn serializes_camel_case_and_omits_absent_optionals() {
        let body = TaskComplete {
            token: "t".into(),
            expires_at: "2026-08-28T20:00:00.000Z".into(),
            cert_thumbprint: "AB12".into(),
            cert_subject: None,
            cert_inn: None,
            cert_not_after: None,
        };
        let json = serde_json::to_string(&body).unwrap();
        assert!(json.contains("\"certThumbprint\":\"AB12\""));
        assert!(!json.contains("certSubject"), "absent optionals must be omitted, not null");
    }

    #[test]
    fn error_codes_match_the_contract_spelling() {
        assert_eq!(
            serde_json::to_string(&SignerErrorCode::CryptoPinRequired).unwrap(),
            "\"CRYPTO_PIN_REQUIRED\""
        );
    }
}
