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

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TokenFormat {
    #[default]
    Jwt,
    Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrueApiAuthPayload {
    pub true_api_base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inn: Option<String>,
    #[serde(default)]
    pub token_format: TokenFormat,
}

/// The `type` discriminant of a task. Mirrors `z.literal("true_api_auth")` on
/// the TS side; the spec reserves a future `sign_detached` variant. Modelling
/// this as an enum rather than a bare `String` means an agent that does not
/// yet know about a future task type fails to *deserialize* the task at all
/// (serde rejects the unrecognised string) instead of accepting it and
/// possibly signing a challenge for a task it does not understand.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskType {
    TrueApiAuth,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignerTask {
    pub id: String,
    #[serde(rename = "type")]
    pub task_type: TaskType,
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

/// Trims and caps `s` at `max` **characters**, not bytes — the server's caps
/// (`message` at 2000, `certSubject` at 1000) are `z.string().max(n)`, which
/// zod counts in characters, and a Russian X.500 subject is mostly non-ASCII.
fn cap_chars(s: &str, max: usize) -> String {
    let trimmed = s.trim();
    if trimmed.chars().count() > max {
        trimmed.chars().take(max).collect()
    } else {
        trimmed.to_string()
    }
}

impl TaskFail {
    /// Builds a fail body with the message already trimmed to the server's cap.
    pub fn new(error_code: SignerErrorCode, message: impl Into<String>) -> Self {
        let mut message: String = cap_chars(&message.into(), 2000);
        if message.is_empty() {
            message = "unspecified failure".to_string();
        }
        Self { error_code, message }
    }
}

/// Trims and caps a certificate subject at the server's 1000-char limit
/// (`certSubject: z.string().trim().max(1000)`). A Russian X.500 subject with
/// CN/SN/G/T/OU/O/STREET/L/S/ИНН/ОГРН/СНИЛС/E can exceed that; without this,
/// the cloud answers 400, the client maps it to a terminal `Protocol` error,
/// and a token that was just successfully minted is discarded every refresh
/// cycle for as long as that certificate stays selected.
pub fn cap_cert_subject(subject: &str) -> String {
    cap_chars(subject, 1000)
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
        assert_eq!(task.task_type, TaskType::TrueApiAuth);
        assert_eq!(task.payload.inn.as_deref(), Some("7712345678"));
        assert_eq!(task.payload.token_format, TokenFormat::Jwt);
        let done: TaskComplete = serde_json::from_str(&fixture("task-complete.json")).unwrap();
        assert_eq!(done.cert_inn.as_deref(), Some("7712345678"));
        let failed: TaskFail = serde_json::from_str(&fixture("task-fail.json")).unwrap();
        assert_eq!(failed.error_code, SignerErrorCode::CryptoContainerUnavailable);
    }

    #[test]
    fn accepts_uuid_token_tasks_but_defaults_legacy_tasks_to_jwt() {
        let uuid_task: SignerTask = serde_json::from_str(
            r#"{"id":"3f0e0f5e-8d1c-4d7a-9b1a-222222222222","type":"true_api_auth",
                "payload":{"trueApiBaseUrl":"https://example.test","tokenFormat":"uuid"}}"#,
        )
        .unwrap();
        assert_eq!(uuid_task.payload.token_format, TokenFormat::Uuid);

        let legacy_task: SignerTask = serde_json::from_str(
            r#"{"id":"3f0e0f5e-8d1c-4d7a-9b1a-222222222222","type":"true_api_auth",
                "payload":{"trueApiBaseUrl":"https://example.test"}}"#,
        )
        .unwrap();
        assert_eq!(legacy_task.payload.token_format, TokenFormat::Jwt);
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

    #[test]
    fn rejects_a_task_type_the_agent_does_not_understand() {
        // A future `sign_detached` task type whose payload happens to
        // deserialize as `TrueApiAuthPayload` must not be silently accepted
        // and signed by an agent that only knows `true_api_auth`.
        let err = serde_json::from_str::<SignerTask>(
            r#"{"id":"3f0e0f5e-8d1c-4d7a-9b1a-222222222222","type":"sign_detached",
                "payload":{"trueApiBaseUrl":"https://example.test"}}"#,
        );
        assert!(err.is_err(), "an unrecognised task type must not deserialize");
    }

    #[test]
    fn caps_the_fail_message_at_2000_chars() {
        let long = "д".repeat(2500);
        let body = TaskFail::new(SignerErrorCode::TrueApi, long);
        assert_eq!(body.message.chars().count(), 2000);
    }

    #[test]
    fn caps_an_overlong_cert_subject_at_1000_chars_counting_characters_not_bytes() {
        // Cyrillic is 2 bytes per char in UTF-8; a naive byte-slice would
        // either panic on a non-char-boundary or under-count the cap.
        let long_subject = "И".repeat(1500);
        let capped = cap_cert_subject(&long_subject);
        assert_eq!(capped.chars().count(), 1000);
        assert_eq!(capped, "И".repeat(1000));
    }

    #[test]
    fn trims_and_leaves_a_short_cert_subject_untouched() {
        assert_eq!(cap_cert_subject("  CN=ООО Ромашка, ИНН=7712345678  "), "CN=ООО Ромашка, ИНН=7712345678");
    }
}
