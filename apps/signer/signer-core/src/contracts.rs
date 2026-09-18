//! Rust mirror of `packages/platform-contracts/src/chz-signer.ts`.
//!
//! The TypeScript schemas are `.strict()`, so `deny_unknown_fields` here keeps
//! both directions symmetric: a field the cloud adds without telling us fails
//! loudly instead of being silently dropped. The shared JSON fixtures under
//! `packages/platform-contracts/fixtures/chz-signer/` are parsed by the tests
//! on both sides — they are the contract.

use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairRequest {
    pub pairing_code: String,
    pub hostname: String,
    pub app_version: String,
}

impl std::fmt::Debug for PairRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairRequest")
            .field("pairing_code", &"[REDACTED]")
            .field("hostname", &self.hostname)
            .field("app_version", &self.app_version)
            .finish()
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairResponse {
    pub agent_id: String,
    pub agent_secret: String,
    pub tenant_name: String,
}

impl std::fmt::Debug for PairResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairResponse")
            .field("agent_id", &self.agent_id)
            .field("agent_secret", &"[REDACTED]")
            .field("tenant_name", &self.tenant_name)
            .finish()
    }
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OmsAuthPayload {
    pub true_api_base_url: String,
    pub oms_connection: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inn: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignDetachedPayload {
    pub purpose: String,
    pub order_id: String,
    /// The exact bytes to sign, base64. Decoded once, signed as-is.
    pub data_base64: String,
}

impl std::fmt::Debug for SignDetachedPayload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignDetachedPayload")
            .field("purpose", &self.purpose)
            .field("order_id", &self.order_id)
            .field("data_base64", &format!("[{} chars]", self.data_base64.len()))
            .finish()
    }
}

/// The task discriminant plus its payload, mirroring the TS discriminated
/// union on `type`. An agent that does not know a type fails to deserialize
/// the task rather than signing something it does not understand.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum TaskKind {
    TrueApiAuth(TrueApiAuthPayload),
    OmsAuth(OmsAuthPayload),
    SignDetached(SignDetachedPayload),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SignerTask {
    pub id: String,
    #[serde(flatten)]
    pub kind: TaskKind,
}

impl SignerTask {
    pub fn task_type(&self) -> &'static str {
        match self.kind {
            TaskKind::TrueApiAuth(_) => "true_api_auth",
            TaskKind::OmsAuth(_) => "oms_auth",
            TaskKind::SignDetached(_) => "sign_detached",
        }
    }
}

/// Completion body for `sign_detached`: the cloud stores it on the task.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskCompleteSignature {
    pub signature_base64: String,
    pub cert_thumbprint: String,
}

impl std::fmt::Debug for TaskCompleteSignature {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TaskCompleteSignature")
            .field("signature_base64", &"[REDACTED]")
            .field("cert_thumbprint", &self.cert_thumbprint)
            .finish()
    }
}

/// The envelope of `GET /signer-agent/tasks/next`. An idle poll answers
/// `{"task": null}` with status 200 — not 204.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NextTaskResponse {
    pub task: Option<SignerTask>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
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

impl std::fmt::Debug for TaskComplete {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TaskComplete")
            .field("token", &"[REDACTED]")
            .field("expires_at", &self.expires_at)
            .field("cert_thumbprint", &self.cert_thumbprint)
            .field("cert_subject", &self.cert_subject)
            .field("cert_inn", &self.cert_inn)
            .field("cert_not_after", &self.cert_not_after)
            .finish()
    }
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
    use base64::Engine as _;
    use crate::contracts::*;

    #[test]
    fn credential_contracts_redact_debug_without_changing_wire_values() {
        let request = PairRequest {
            pairing_code: "synthetic-pairing-marker".into(),
            hostname: "test-host".into(),
            app_version: "0.1.0".into(),
        };
        let response = PairResponse {
            agent_id: "test-agent".into(),
            agent_secret: "synthetic-agent-marker".into(),
            tenant_name: "Test tenant".into(),
        };
        let complete = TaskComplete {
            token: "synthetic-token-marker".into(),
            expires_at: "2026-10-10T12:00:00Z".into(),
            cert_thumbprint: "test-thumbprint".into(),
            cert_subject: None,
            cert_inn: None,
            cert_not_after: None,
        };
        for (debug, secret) in [
            (format!("{request:?}"), &request.pairing_code),
            (format!("{request:#?}"), &request.pairing_code),
            (format!("{response:?}"), &response.agent_secret),
            (format!("{response:#?}"), &response.agent_secret),
            (format!("{complete:?}"), &complete.token),
            (format!("{complete:#?}"), &complete.token),
        ] {
            assert!(!debug.contains(secret));
            assert!(debug.contains("[REDACTED]"));
        }
        assert_eq!(serde_json::to_value(&request).unwrap()["pairingCode"], request.pairing_code);
        assert_eq!(serde_json::to_value(&response).unwrap()["agentSecret"], response.agent_secret);
        assert_eq!(serde_json::to_value(&complete).unwrap()["token"], complete.token);
    }

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
        match &task.kind {
            TaskKind::TrueApiAuth(payload) => {
                assert_eq!(payload.inn.as_deref(), Some("7712345678"));
                assert_eq!(payload.token_format, TokenFormat::Jwt);
            }
            other => panic!("expected true_api_auth, got {other:?}"),
        }
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
        match uuid_task.kind {
            TaskKind::TrueApiAuth(payload) => assert_eq!(payload.token_format, TokenFormat::Uuid),
            other => panic!("expected true_api_auth, got {other:?}"),
        }

        let legacy_task: SignerTask = serde_json::from_str(
            r#"{"id":"3f0e0f5e-8d1c-4d7a-9b1a-222222222222","type":"true_api_auth",
                "payload":{"trueApiBaseUrl":"https://example.test"}}"#,
        )
        .unwrap();
        match legacy_task.kind {
            TaskKind::TrueApiAuth(payload) => assert_eq!(payload.token_format, TokenFormat::Jwt),
            other => panic!("expected true_api_auth, got {other:?}"),
        }
    }

    #[test]
    fn rejects_unknown_fields_from_the_server() {
        // `#[serde(flatten)]` on `SignerTask::kind` is not compatible with
        // `deny_unknown_fields` on the outer struct (serde does not support
        // combining them), so an unknown field *sibling to* `id`/`type`/
        // `payload` can no longer be rejected at the envelope level. Unknown
        // fields inside the payload -- where it actually matters, since that
        // is the part the cloud extends per task kind -- are still denied.
        let err = serde_json::from_str::<SignerTask>(
            r#"{"id":"3f0e0f5e-8d1c-4d7a-9b1a-222222222222","type":"true_api_auth",
                "payload":{"trueApiBaseUrl":"https://example.test","extra":1}}"#,
        );
        assert!(err.is_err(), "unknown payload fields must not be silently ignored");
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
    fn parses_the_oms_auth_fixture() {
        let task: SignerTask = serde_json::from_str(&fixture("task-oms-auth.json")).unwrap();
        match task.kind {
            TaskKind::OmsAuth(payload) => {
                assert_eq!(payload.oms_connection, "11b1abc1-f1ee-11db-1a11-f11ac11111e1");
                assert!(payload.inn.is_none());
            }
            other => panic!("expected oms_auth, got {other:?}"),
        }
    }

    #[test]
    fn parses_the_sign_detached_fixture_and_decodes_its_bytes() {
        let task: SignerTask = serde_json::from_str(&fixture("task-sign-detached.json")).unwrap();
        match task.kind {
            TaskKind::SignDetached(payload) => {
                assert_eq!(payload.purpose, "oms_order");
                let bytes = base64::engine::general_purpose::STANDARD.decode(payload.data_base64).unwrap();
                assert_eq!(bytes, br#"{"productGroup":"beer"}"#);
            }
            other => panic!("expected sign_detached, got {other:?}"),
        }
    }

    #[test]
    fn still_parses_the_true_api_auth_fixture() {
        let task: SignerTask = serde_json::from_str(&fixture("task.json")).unwrap();
        assert!(matches!(task.kind, TaskKind::TrueApiAuth(_)));
        assert_eq!(task.task_type(), "true_api_auth");
    }

    #[test]
    fn rejects_an_unknown_task_type() {
        let json = r#"{"id":"3f0e0f5e-8d1c-4d7a-9b1a-222222222222","type":"nope","payload":{}}"#;
        assert!(serde_json::from_str::<SignerTask>(json).is_err());
    }

    #[test]
    fn signature_completion_serialises_to_the_shared_fixture_shape() {
        let body = TaskCompleteSignature {
            signature_base64: "MIIE5QYJKoZIhvcNAQcCoIIE1jCCBNICAQExDjAMBggqhQMHAQECAgUAMAsGCSqGSIb3DQEHAQ==".into(),
            cert_thumbprint: "AB120F0000000000000000000000000000000000".into(),
        };
        let expected: serde_json::Value =
            serde_json::from_str(&fixture("task-complete-signature.json")).unwrap();
        assert_eq!(serde_json::to_value(&body).unwrap(), expected);
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
