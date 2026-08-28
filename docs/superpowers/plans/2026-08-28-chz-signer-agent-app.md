# Chestny ZNAK Signer Agent — Windows App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Windows half of the CHZ signer agent — a `signer-core` Rust crate (cloud protocol client, True API auth flow, GOST signing, DPAPI storage, runtime loop) and `apps/signer`, a Tauri 2 tray application that runs it — so a tenant's UKEP machine keeps a fresh True API token in the Markiro cloud without human intervention.

**Architecture:** `signer-core` is a headless, fully testable library: every OS- and network-touching capability sits behind a trait (`Signer`, `SecretStore`, `Clock`), so the runtime loop is exercised with fakes and `wiremock` on any platform. `apps/signer/src-tauri` is a thin Tauri shell that owns the tray icon, a hidden compact window, and a background tokio task driving `signer-core`, bridging state to the React UI through Tauri events. Signing starts on Win32 CryptoAPI (`CryptSignMessage`, no COM); a CAdESCOM COM implementation lands behind the same trait as a fallback once the sandbox verdict is known.

**Tech Stack:** Rust (tokio, reqwest, serde, windows-sys), Tauri 2.11, React 19 + `@markiro/ui`, i18next, vitest, wiremock.

## Global Constraints

- Monorepo: pnpm + turbo. Node 24. Never use `git stash` (shared stash stack). Commit footer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Cloud routes are singular `/signer-agent/…`** — the design spec's `/signer-agents/…` is wrong for agent-facing calls (`/signer-agents/` is the cabinet controller). Verified against `apps/api/src/modules/signer-agents/signer-agent-pair.controller.ts` and `signer-agent-tasks.controller.ts`.
- Auth header: `x-signer-token: <agentSecret>` — the **raw secret, no `Bearer` prefix**. Any 401 on an authenticated call means the agent was revoked: wipe local state and return to pairing.
- `GET /signer-agent/tasks/next?wait=<0..25000>` returns **200 `{"task": null}`** when idle — never 204. `wait` is milliseconds, integer, default 25000; out of range is a 400. Server-side claim polling granularity is 2 s.
- `POST /signer-agent/pair` returns **201**; `complete`/`fail` return **204**.
- **Claim-to-report deadline is 30 minutes** (`CHZ_TASK_STALE_MS`): after that the cloud expires the task and `complete` answers 404.
- All protocol JSON schemas are `.strict()` — never send an unknown field. Timestamps must be RFC3339 **with offset** (`2026-08-28T20:00:00.000Z`). INN is a string of 10 or 12 digits. Pairing code is an 8-digit string that may have a leading zero — never parse it as a number.
- `certSubject`, `certInn`, `certNotAfter` are optional but the server writes them unconditionally: omitting one **nulls a previously stored value**. Always send all four cert fields.
- The True API base URL arrives per task in `payload.trueApiBaseUrl`; `payload.inn` is present only for MChD tenants. Never hardcode either.
- Token values and the agent secret must never appear in the local journal, logs, or any error surfaced to the UI.
- Rust: no `unwrap()`/`expect()` outside tests and `main`. TypeScript: repo base config sets `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; use conditional spreads rather than assigning `undefined`; import local TS modules with `.js` extensions.
- Windows-only for v1. One agent = one tenant = one selected certificate.

---

## File Structure

**`apps/signer/signer-core/`** — the library (no Tauri, no UI):

| File                   | Responsibility                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `src/lib.rs`           | Crate root, re-exports, `SignerError`                                                    |
| `src/contracts.rs`     | serde mirrors of `packages/platform-contracts/src/chz-signer.ts`                         |
| `src/cloud.rs`         | `CloudClient`: pair / poll / complete / fail against the Markiro API                     |
| `src/trueapi.rs`       | `auth/key` → sign → `simpleSignIn`                                                       |
| `src/signer.rs`        | `Signer` + `CertificateSummary` traits and shared parsing (thumbprint, INN from subject) |
| `src/signer_capi.rs`   | `#[cfg(windows)]` CryptoAPI implementation (`CryptSignMessage`, MY-store enumeration)    |
| `src/signer_cades.rs`  | `#[cfg(windows)]` CAdESCOM COM implementation (Task 11)                                  |
| `src/storage.rs`       | `SecretStore` trait, `AgentConfig`, durable JSON write                                   |
| `src/storage_dpapi.rs` | `#[cfg(windows)]` DPAPI-backed `SecretStore`                                             |
| `src/runtime.rs`       | The loop: poll → execute → report, backoff, revocation handling                          |
| `src/journal.rs`       | Rolling local journal, redaction                                                         |

**`apps/signer/src-tauri/`** — the shell: `src/main.rs`, `src/lib.rs` (builder, tray, background task), `src/commands.rs` (IPC), `src/events.rs` (event names + payloads), `tauri.conf.json` + `tauri.stable.conf.json`, `capabilities/default.json`, `windows/installer-hooks.nsh`, `icons/`.

**`apps/signer/src/`** — the UI: `main.tsx`, `App.tsx` (three-state machine), `pages/Pairing.tsx`, `pages/Status.tsx`, `components/CertificatePicker.tsx`, `components/JournalList.tsx`, `lib/bridge.ts` (invoke/listen wrappers), `i18n/{index.ts,ru.json,en.json}`, `signer.css`.

**Repo-level:** `apps/signer/Cargo.toml` (workspace over the two crates), `apps/signer/package.json`, `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, `index.html`, `turbo.json`; `.github/workflows/ci.yml` (two new jobs); `eslint.config.mjs` (glob); `docs/runbooks/signer-agent-manual-e2e.md`.

---

### Task 1: signer-core skeleton and protocol contracts

**Files:**

- Create: `apps/signer/Cargo.toml`, `apps/signer/.gitignore`
- Create: `apps/signer/signer-core/Cargo.toml`, `src/lib.rs`, `src/contracts.rs`
- Test: inline `#[cfg(test)]` in `src/contracts.rs`

**Interfaces:**

- Produces: `PairRequest`, `PairResponse`, `TrueApiAuthPayload`, `SignerTask`, `TaskComplete`, `TaskFail`, `SignerErrorCode`, and `SignerError`. Every later task uses these types.

- [ ] **Step 1: Write the failing test**

Create `apps/signer/signer-core/src/contracts.rs` containing only this test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path apps/signer/Cargo.toml`
Expected: FAIL — no such manifest / types undefined.

- [ ] **Step 3: Write the crates and the types**

`apps/signer/Cargo.toml`:

```toml
[workspace]
resolver = "2"
members = ["signer-core", "src-tauri"]
```

`apps/signer/.gitignore`:

```
/target/
/src-tauri/gen/schemas
```

`apps/signer/signer-core/Cargo.toml`:

```toml
[package]
name = "signer-core"
version = "0.1.0"
edition = "2021"
license = "Apache-2.0 OR MIT"
description = "Chestny ZNAK signer agent core: cloud protocol, True API auth, GOST signing"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "=0.13.4", default-features = false, features = ["json", "rustls-tls"] }
tokio = { version = "=1.53.1", features = ["sync", "time", "rt"] }
base64 = "0.22"
zeroize = "=1.9.0"
thiserror = "2"
tracing = "0.1"

[dev-dependencies]
tokio = { version = "=1.53.1", features = ["macros", "rt-multi-thread"] }
wiremock = "0.6"
tempfile = "3"

[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.61", features = [
  "Win32_Foundation",
  "Win32_Security_Cryptography",
] }
```

`apps/signer/signer-core/src/lib.rs`:

```rust
//! Core of the Chestny ZNAK signer agent: everything that is testable without
//! a desktop shell. OS- and network-touching capabilities sit behind traits so
//! the runtime loop can be exercised on any platform.

pub mod contracts;

use thiserror::Error;

/// One error type for the whole crate. Variants map to the wire error codes the
/// cloud understands (`contracts::SignerErrorCode`) plus internal failures that
/// never reach the cloud.
#[derive(Debug, Error)]
pub enum SignerError {
    #[error("cryptographic provider is unavailable: {0}")]
    CryptoProviderMissing(String),
    #[error("certificate not found: {0}")]
    CertNotFound(String),
    #[error("certificate expired: {0}")]
    CertExpired(String),
    #[error("key container unavailable: {0}")]
    ContainerUnavailable(String),
    #[error("PIN required for the key container")]
    PinRequired,
    #[error("network failure: {0}")]
    Network(String),
    #[error("True API rejected the request: {0}")]
    TrueApi(String),
    /// The cloud answered 401 — this agent was revoked.
    #[error("agent credentials were revoked")]
    Revoked,
    #[error("local storage failure: {0}")]
    Storage(String),
    #[error("protocol violation: {0}")]
    Protocol(String),
}
```

`apps/signer/signer-core/src/contracts.rs` — put this **above** the test module written in Step 1:

```rust
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
```

Also add `pub mod contracts;` to `lib.rs` (already in Step 3's `lib.rs`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path apps/signer/Cargo.toml`
Expected: PASS, 4 tests. `src-tauri` is not created yet, so temporarily set `members = ["signer-core"]` in the workspace and restore the full list in Task 7.

- [ ] **Step 5: Commit**

```bash
git add apps/signer
git commit -m "feat(signer): signer-core crate with protocol contracts mirroring the shared fixtures"
```

---

### Task 2: Cloud protocol client

**Files:**

- Create: `apps/signer/signer-core/src/cloud.rs`
- Modify: `apps/signer/signer-core/src/lib.rs` (add `pub mod cloud;`)
- Test: inline `#[cfg(test)]` in `src/cloud.rs` (wiremock)

**Interfaces:**

- Consumes: `contracts::*`, `SignerError` (Task 1).
- Produces: `CloudClient::new(base_url: &str, app_version: &str) -> Result<CloudClient, SignerError>`; `async fn pair(&self, code: &str, hostname: &str) -> Result<PairResponse, PairError>`; `async fn poll(&self, secret: &str, wait_ms: u32) -> Result<Option<SignerTask>, SignerError>`; `async fn complete(&self, secret: &str, task_id: &str, body: &TaskComplete) -> Result<(), SignerError>`; `async fn fail(&self, secret: &str, task_id: &str, body: &TaskFail) -> Result<(), SignerError>`; `enum PairError { Rejected, Network(String) }`. Task 6 drives all of these.

- [ ] **Step 1: Write the failing test**

Append to `apps/signer/signer-core/src/cloud.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_json_string, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn pairs_and_returns_the_one_time_secret() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/signer-agent/pair"))
            .and(body_json_string(
                r#"{"pairingCode":"01234567","hostname":"BUH-PC","appVersion":"0.1.0"}"#,
            ))
            .respond_with(ResponseTemplate::new(201).set_body_string(
                r#"{"agentId":"3f0e0f5e-8d1c-4d7a-9b1a-111111111111",
                    "agentSecret":"example-agent-secret-not-a-real-credential",
                    "tenantName":"ООО Ромашка"}"#,
            ))
            .mount(&server)
            .await;

        let client = CloudClient::new(&server.uri(), "0.1.0").unwrap();
        let res = client.pair("01234567", "BUH-PC").await.unwrap();
        assert_eq!(res.tenant_name, "ООО Ромашка");
    }

    #[tokio::test]
    async fn maps_a_rejected_pairing_to_rejected_not_network() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/signer-agent/pair"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        let client = CloudClient::new(&server.uri(), "0.1.0").unwrap();
        assert!(matches!(
            client.pair("00000000", "PC").await,
            Err(PairError::Rejected)
        ));
    }

    #[tokio::test]
    async fn poll_sends_the_raw_secret_header_and_decodes_a_task() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/signer-agent/tasks/next"))
            .and(query_param("wait", "25000"))
            .and(header("x-signer-token", "s3cret"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"task":{"id":"3f0e0f5e-8d1c-4d7a-9b1a-222222222222",
                    "type":"true_api_auth",
                    "payload":{"trueApiBaseUrl":"https://markirovka.sandbox.crptech.ru/api/v3/true-api"}}}"#,
            ))
            .mount(&server)
            .await;
        let client = CloudClient::new(&server.uri(), "0.1.0").unwrap();
        let task = client.poll("s3cret", 25_000).await.unwrap().unwrap();
        assert_eq!(task.task_type, "true_api_auth");
    }

    #[tokio::test]
    async fn an_idle_poll_is_none_not_an_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/signer-agent/tasks/next"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"task":null}"#))
            .mount(&server)
            .await;
        let client = CloudClient::new(&server.uri(), "0.1.0").unwrap();
        assert!(client.poll("s3cret", 0).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_401_on_poll_is_revocation() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/signer-agent/tasks/next"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        let client = CloudClient::new(&server.uri(), "0.1.0").unwrap();
        assert!(matches!(client.poll("s3cret", 0).await, Err(SignerError::Revoked)));
    }

    #[tokio::test]
    async fn complete_accepts_204_and_reports_404_as_protocol() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/signer-agent/tasks/t1/complete"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/signer-agent/tasks/t2/complete"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let client = CloudClient::new(&server.uri(), "0.1.0").unwrap();
        let body = TaskComplete {
            token: "t".into(),
            expires_at: "2026-08-28T20:00:00.000Z".into(),
            cert_thumbprint: "AB".into(),
            cert_subject: None,
            cert_inn: None,
            cert_not_after: None,
        };
        assert!(client.complete("s", "t1", &body).await.is_ok());
        assert!(matches!(
            client.complete("s", "t2", &body).await,
            Err(SignerError::Protocol(_))
        ));
    }

    #[tokio::test]
    async fn fail_posts_the_error_envelope() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/signer-agent/tasks/t1/fail"))
            .and(body_json_string(
                r#"{"errorCode":"CRYPTO_PIN_REQUIRED","message":"PIN prompt pending"}"#,
            ))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let client = CloudClient::new(&server.uri(), "0.1.0").unwrap();
        let body = TaskFail::new(SignerErrorCode::CryptoPinRequired, "  PIN prompt pending  ");
        assert!(client.fail("s", "t1", &body).await.is_ok());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path apps/signer/Cargo.toml cloud`
Expected: FAIL — `CloudClient` undefined.

- [ ] **Step 3: Implement the client**

Put this **above** the test module in `apps/signer/signer-core/src/cloud.rs`:

```rust
//! Client for the Markiro cloud half of the signer protocol.
//!
//! Route shapes are taken from the shipped controllers, not the design spec:
//! the agent-facing prefix is singular (`/signer-agent/…`), pairing answers
//! 201, report calls answer 204, and an idle long poll is `200 {"task": null}`.

use std::time::Duration;

use reqwest::{Client, StatusCode};

use crate::contracts::{NextTaskResponse, PairRequest, PairResponse, SignerTask, TaskComplete, TaskFail};
use crate::SignerError;

/// Long polls hold for up to 25 s server-side; allow headroom before the
/// transport gives up so a healthy idle poll is never mistaken for a failure.
const POLL_TIMEOUT_SLACK: Duration = Duration::from_secs(20);
const REPORT_TIMEOUT: Duration = Duration::from_secs(30);

/// Pairing has exactly two outcomes worth distinguishing in the UI: the cloud
/// refused the code (wrong, expired, used, or rate-limited — it deliberately
/// does not say which), or we never reached it.
#[derive(Debug)]
pub enum PairError {
    Rejected,
    Network(String),
}

pub struct CloudClient {
    base_url: String,
    app_version: String,
    http: Client,
}

impl CloudClient {
    pub fn new(base_url: &str, app_version: &str) -> Result<Self, SignerError> {
        let http = Client::builder()
            .user_agent(format!("markiro-signer/{app_version}"))
            .build()
            .map_err(|e| SignerError::Network(e.to_string()))?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            app_version: app_version.to_string(),
            http,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base_url)
    }

    pub async fn pair(&self, code: &str, hostname: &str) -> Result<PairResponse, PairError> {
        let body = PairRequest {
            pairing_code: code.to_string(),
            hostname: hostname.to_string(),
            app_version: self.app_version.clone(),
        };
        let response = self
            .http
            .post(self.url("/signer-agent/pair"))
            .timeout(REPORT_TIMEOUT)
            .json(&body)
            .send()
            .await
            .map_err(|e| PairError::Network(e.to_string()))?;
        if !response.status().is_success() {
            // 400 and 401 are both "this code will not work"; the cloud does not
            // distinguish wrong from expired from rate-limited on purpose.
            return Err(PairError::Rejected);
        }
        response
            .json::<PairResponse>()
            .await
            .map_err(|e| PairError::Network(e.to_string()))
    }

    pub async fn poll(&self, secret: &str, wait_ms: u32) -> Result<Option<SignerTask>, SignerError> {
        let response = self
            .http
            .get(self.url("/signer-agent/tasks/next"))
            .header("x-signer-token", secret)
            .query(&[("wait", wait_ms.min(25_000).to_string())])
            .timeout(Duration::from_millis(u64::from(wait_ms)) + POLL_TIMEOUT_SLACK)
            .send()
            .await
            .map_err(|e| SignerError::Network(e.to_string()))?;
        match response.status() {
            StatusCode::UNAUTHORIZED => Err(SignerError::Revoked),
            status if status.is_success() => response
                .json::<NextTaskResponse>()
                .await
                .map(|body| body.task)
                .map_err(|e| SignerError::Protocol(e.to_string())),
            status => Err(SignerError::Protocol(format!("poll answered {status}"))),
        }
    }

    pub async fn complete(
        &self,
        secret: &str,
        task_id: &str,
        body: &TaskComplete,
    ) -> Result<(), SignerError> {
        self.report(secret, &format!("/signer-agent/tasks/{task_id}/complete"), body)
            .await
    }

    pub async fn fail(
        &self,
        secret: &str,
        task_id: &str,
        body: &TaskFail,
    ) -> Result<(), SignerError> {
        self.report(secret, &format!("/signer-agent/tasks/{task_id}/fail"), body)
            .await
    }

    async fn report<T: serde::Serialize>(
        &self,
        secret: &str,
        path: &str,
        body: &T,
    ) -> Result<(), SignerError> {
        let response = self
            .http
            .post(self.url(path))
            .header("x-signer-token", secret)
            .timeout(REPORT_TIMEOUT)
            .json(body)
            .send()
            .await
            .map_err(|e| SignerError::Network(e.to_string()))?;
        match response.status() {
            StatusCode::UNAUTHORIZED => Err(SignerError::Revoked),
            // 404 means the claim is gone: expired past the 30-minute deadline,
            // already reported, or claimed by another agent. Nothing to retry.
            StatusCode::NOT_FOUND => Err(SignerError::Protocol(
                "the task is no longer claimed by this agent".to_string(),
            )),
            // 503 means the cloud has no encryption key configured; it will also
            // stop enqueueing, so backing off is the only sane response.
            StatusCode::SERVICE_UNAVAILABLE => Err(SignerError::Network(
                "the cloud cannot store tokens right now".to_string(),
            )),
            status if status.is_success() => Ok(()),
            status => Err(SignerError::Protocol(format!("report answered {status}"))),
        }
    }
}
```

Add `pub mod cloud;` to `lib.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path apps/signer/Cargo.toml`
Expected: PASS, 11 tests total.

- [ ] **Step 5: Commit**

```bash
git add apps/signer/signer-core
git commit -m "feat(signer): cloud protocol client with wiremock coverage"
```

---

### Task 3: True API auth flow behind a signing trait

**Files:**

- Create: `apps/signer/signer-core/src/signer.rs`, `apps/signer/signer-core/src/trueapi.rs`
- Modify: `apps/signer/signer-core/src/lib.rs`
- Test: inline `#[cfg(test)]` in both files

**Interfaces:**

- Consumes: `SignerError`.
- Produces: `pub struct CertificateSummary { pub thumbprint: String, pub subject: String, pub inn: Option<String>, pub not_after: String, pub has_private_key: bool }`; `pub trait Signer: Send + Sync { fn list_certificates(&self) -> Result<Vec<CertificateSummary>, SignerError>; fn sign_attached(&self, thumbprint: &str, payload: &[u8]) -> Result<String, SignerError>; }` (returns base64 of the attached CMS/CAdES blob); `pub fn inn_from_subject(subject: &str) -> Option<String>`; `pub async fn obtain_token(http: &reqwest::Client, base_url: &str, inn: Option<&str>, thumbprint: &str, signer: &dyn Signer) -> Result<TrueApiToken, SignerError>`; `pub struct TrueApiToken { pub token: String, pub expires_at: String }`. Task 6 calls `obtain_token`; Tasks 4 and 11 implement `Signer`.

- [ ] **Step 1: Write the failing tests**

`apps/signer/signer-core/src/signer.rs` test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_the_inn_from_a_russian_subject_rdn() {
        assert_eq!(
            inn_from_subject("CN=ООО Ромашка, ИНН=7712345678, O=Ромашка").as_deref(),
            Some("7712345678")
        );
        assert_eq!(
            inn_from_subject("CN=ИП Иванов, ИНН ЮЛ=771234567890").as_deref(),
            Some("771234567890")
        );
        assert_eq!(
            inn_from_subject("CN=Test, INN=7712345678").as_deref(),
            Some("7712345678")
        );
        assert_eq!(inn_from_subject("CN=No inn here"), None);
        // A malformed length is not an INN — better absent than wrong, because
        // the cloud validates 10 or 12 digits and would reject the whole report.
        assert_eq!(inn_from_subject("CN=Test, ИНН=12345"), None);
    }
}
```

`apps/signer/signer-core/src/trueapi.rs` test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::signer::{CertificateSummary, Signer};
    use wiremock::matchers::{body_json_string, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    struct FakeSigner {
        signature: &'static str,
    }

    impl Signer for FakeSigner {
        fn list_certificates(&self) -> Result<Vec<CertificateSummary>, SignerError> {
            Ok(vec![])
        }
        fn sign_attached(&self, _thumbprint: &str, payload: &[u8]) -> Result<String, SignerError> {
            assert_eq!(payload, b"challenge-data");
            Ok(self.signature.to_string())
        }
    }

    struct FailingSigner;
    impl Signer for FailingSigner {
        fn list_certificates(&self) -> Result<Vec<CertificateSummary>, SignerError> {
            Ok(vec![])
        }
        fn sign_attached(&self, _t: &str, _p: &[u8]) -> Result<String, SignerError> {
            Err(SignerError::PinRequired)
        }
    }

    async fn mount_auth(server: &MockServer, expected_body: &str) {
        Mock::given(method("GET"))
            .and(path("/auth/key"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"uuid":"u-1","data":"challenge-data"}"#,
            ))
            .mount(server)
            .await;
        Mock::given(method("POST"))
            .and(path("/auth/simpleSignIn"))
            .and(body_json_string(expected_body.to_string()))
            .respond_with(
                ResponseTemplate::new(200).set_body_string(r#"{"token":"jwt-token"}"#),
            )
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn signs_the_challenge_and_returns_a_ten_hour_token() {
        let server = MockServer::start().await;
        mount_auth(&server, r#"{"uuid":"u-1","data":"signed-blob"}"#).await;
        let http = reqwest::Client::new();
        let signer = FakeSigner { signature: "signed-blob" };
        let token = obtain_token(&http, &server.uri(), None, "AB12", &signer)
            .await
            .unwrap();
        assert_eq!(token.token, "jwt-token");
        // Ten hours minus the safety margin, serialized with an offset because
        // the cloud's zod schema demands one.
        assert!(token.expires_at.ends_with('Z'), "got {}", token.expires_at);
    }

    #[tokio::test]
    async fn includes_the_inn_when_the_tenant_uses_an_mchd() {
        let server = MockServer::start().await;
        mount_auth(
            &server,
            r#"{"uuid":"u-1","data":"signed-blob","inn":"7712345678"}"#,
        )
        .await;
        let http = reqwest::Client::new();
        let signer = FakeSigner { signature: "signed-blob" };
        assert!(obtain_token(&http, &server.uri(), Some("7712345678"), "AB12", &signer)
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn surfaces_true_api_errors_verbatim() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/auth/key"))
            .respond_with(ResponseTemplate::new(403).set_body_string(
                r#"{"error_message":"Отсутствует действующий договор"}"#,
            ))
            .mount(&server)
            .await;
        let http = reqwest::Client::new();
        let signer = FakeSigner { signature: "x" };
        match obtain_token(&http, &server.uri(), None, "AB12", &signer).await {
            Err(SignerError::TrueApi(message)) => {
                assert!(message.contains("договор"), "got {message}");
            }
            other => panic!("expected a TrueApi error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn propagates_signing_failures_without_calling_sign_in() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/auth/key"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"uuid":"u-1","data":"challenge-data"}"#,
            ))
            .mount(&server)
            .await;
        let http = reqwest::Client::new();
        match obtain_token(&http, &server.uri(), None, "AB12", &FailingSigner).await {
            Err(SignerError::PinRequired) => {}
            other => panic!("expected PinRequired, got {other:?}"),
        }
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path apps/signer/Cargo.toml`
Expected: FAIL — `inn_from_subject` / `obtain_token` undefined.

- [ ] **Step 3: Implement**

`apps/signer/signer-core/src/signer.rs` (above its test module):

```rust
//! The signing capability, kept behind a trait so the runtime is testable on
//! any platform and so a second implementation (CAdESCOM over COM) can replace
//! the CryptoAPI one without touching callers.

use crate::SignerError;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateSummary {
    /// SHA-1 hash of the DER certificate, uppercase hex — the same shape
    /// CAdESCOM's `Certificate.Thumbprint` returns, which is what the cloud
    /// stores and the admin UI displays.
    pub thumbprint: String,
    pub subject: String,
    pub inn: Option<String>,
    /// RFC3339 with offset, matching the cloud's `certNotAfter` contract.
    pub not_after: String,
    pub has_private_key: bool,
}

pub trait Signer: Send + Sync {
    /// Certificates in the current user's MY store that can sign a GOST payload.
    fn list_certificates(&self) -> Result<Vec<CertificateSummary>, SignerError>;

    /// Attached (enveloping) signature over `payload`, base64-encoded — the
    /// form True API's `simpleSignIn` expects for the challenge.
    fn sign_attached(&self, thumbprint: &str, payload: &[u8]) -> Result<String, SignerError>;
}

/// Pulls the INN out of a certificate subject.
///
/// Russian CAs spell the attribute several ways (`ИНН`, `ИНН ЮЛ`, `INN`,
/// sometimes OID `1.2.643.3.131.1.1`), so match on any of them and accept only
/// a 10- or 12-digit value: the cloud rejects anything else, and a wrong INN
/// would fail the whole report rather than just this field.
pub fn inn_from_subject(subject: &str) -> Option<String> {
    const KEYS: [&str; 4] = ["ИНН ЮЛ", "ИНН", "INN", "1.2.643.3.131.1.1"];
    for key in KEYS {
        let mut haystack = subject;
        while let Some(index) = haystack.find(key) {
            let rest = &haystack[index + key.len()..];
            let digits: String = rest
                .trim_start_matches(|c: char| c == '=' || c.is_whitespace())
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            if digits.len() == 10 || digits.len() == 12 {
                return Some(digits);
            }
            haystack = rest;
        }
    }
    None
}
```

`apps/signer/signer-core/src/trueapi.rs` (above its test module):

```rust
//! True API GIS MT authentication: the only place UKEP is required for reads.
//!
//! `GET /auth/key` hands out a random challenge, the agent signs it locally
//! with an attached GOST signature, and `POST /auth/simpleSignIn` exchanges it
//! for a JWT that lives at most ten hours. The challenge never leaves this
//! machine, so it cannot expire in transit.

use std::time::{Duration, SystemTime};

use serde::Deserialize;

use crate::signer::Signer;
use crate::SignerError;

/// The cloud refreshes 90 minutes before expiry; reporting a slightly early
/// expiry costs nothing and protects against clock skew between us and ГИС МТ.
const TOKEN_LIFETIME: Duration = Duration::from_secs(10 * 3600);
const TOKEN_SAFETY_MARGIN: Duration = Duration::from_secs(5 * 60);
const AUTH_TIMEOUT: Duration = Duration::from_secs(30);

pub struct TrueApiToken {
    pub token: String,
    pub expires_at: String,
}

#[derive(Deserialize)]
struct AuthKeyResponse {
    uuid: String,
    data: String,
}

#[derive(Deserialize)]
struct SignInResponse {
    token: String,
}

#[derive(serde::Serialize)]
struct SignInRequest<'a> {
    uuid: &'a str,
    data: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    inn: Option<&'a str>,
}

pub async fn obtain_token(
    http: &reqwest::Client,
    base_url: &str,
    inn: Option<&str>,
    thumbprint: &str,
    signer: &dyn Signer,
) -> Result<TrueApiToken, SignerError> {
    let base = base_url.trim_end_matches('/');

    let key_response = http
        .get(format!("{base}/auth/key"))
        .timeout(AUTH_TIMEOUT)
        .send()
        .await
        .map_err(|e| SignerError::Network(e.to_string()))?;
    if !key_response.status().is_success() {
        return Err(SignerError::TrueApi(describe(key_response).await));
    }
    let challenge: AuthKeyResponse = key_response
        .json()
        .await
        .map_err(|e| SignerError::Protocol(e.to_string()))?;

    let signature = signer.sign_attached(thumbprint, challenge.data.as_bytes())?;

    let sign_in_response = http
        .post(format!("{base}/auth/simpleSignIn"))
        .timeout(AUTH_TIMEOUT)
        .json(&SignInRequest {
            uuid: &challenge.uuid,
            data: &signature,
            inn,
        })
        .send()
        .await
        .map_err(|e| SignerError::Network(e.to_string()))?;
    if !sign_in_response.status().is_success() {
        return Err(SignerError::TrueApi(describe(sign_in_response).await));
    }
    let issued: SignInResponse = sign_in_response
        .json()
        .await
        .map_err(|e| SignerError::Protocol(e.to_string()))?;

    Ok(TrueApiToken {
        token: issued.token,
        expires_at: rfc3339_from_now(TOKEN_LIFETIME - TOKEN_SAFETY_MARGIN),
    })
}

/// True API error bodies are passed through verbatim so the admin sees the real
/// cause (for example "нет действующего договора по товарной группе") instead
/// of a generic failure.
async fn describe(response: reqwest::Response) -> String {
    let status = response.status();
    match response.text().await {
        Ok(body) if !body.trim().is_empty() => {
            let trimmed: String = body.chars().take(1000).collect();
            format!("{status}: {trimmed}")
        }
        _ => status.to_string(),
    }
}

/// RFC3339 in UTC with a `Z` offset — the cloud's zod schema requires an
/// offset, and a naive timestamp is a 400. Computed without a date library:
/// the crate has no other need for one.
fn rfc3339_from_now(ahead: Duration) -> String {
    let seconds = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        + ahead.as_secs();
    format_rfc3339(seconds)
}

fn format_rfc3339(unix_seconds: u64) -> String {
    let days = unix_seconds / 86_400;
    let rem = unix_seconds % 86_400;
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (year, month, day) = civil_from_days(days as i64);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.000Z")
}

/// Howard Hinnant's days-from-civil inverse, the standard branch-free
/// conversion used when pulling in chrono is not worth it.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
```

Add `pub mod signer;` and `pub mod trueapi;` to `lib.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path apps/signer/Cargo.toml`
Expected: PASS, 16 tests total.

- [ ] **Step 5: Add a regression test for the date formatter and commit**

Append to `trueapi.rs`'s test module:

```rust
    #[test]
    fn formats_a_known_instant_as_rfc3339_with_offset() {
        // 2026-08-28T12:00:00Z
        assert_eq!(format_rfc3339(1_787_918_400), "2026-08-28T12:00:00.000Z");
    }
```

Run: `cargo test --manifest-path apps/signer/Cargo.toml`
Expected: PASS, 17 tests.

```bash
git add apps/signer/signer-core
git commit -m "feat(signer): True API auth flow behind a signing trait"
```

---

### Task 4: Windows CryptoAPI signer

**Files:**

- Create: `apps/signer/signer-core/src/signer_capi.rs`
- Modify: `apps/signer/signer-core/src/lib.rs` (`#[cfg(windows)] pub mod signer_capi;`)
- Test: inline `#[cfg(test)]` in `signer_capi.rs`

**Interfaces:**

- Consumes: `Signer`, `CertificateSummary`, `inn_from_subject`, `SignerError`.
- Produces: `pub struct CapiSigner;` implementing `Signer`; `pub fn hash_oid_for_public_key(public_key_oid: &str) -> Option<&'static str>`; `pub fn format_thumbprint(bytes: &[u8]) -> String`; `pub fn filetime_to_rfc3339(low: u32, high: u32) -> String`. Task 6 receives a `Box<dyn Signer>` built from this on Windows.

- [ ] **Step 1: Write the failing test**

Test module in `signer_capi.rs` — the pure helpers are what unit tests can reach; the FFI path is covered by the manual runbook in Task 12:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_gost_public_key_oids_to_their_hash_oids() {
        // GOST R 34.10-2012, 256-bit key -> GOST R 34.11-2012, 256-bit hash
        assert_eq!(hash_oid_for_public_key("1.2.643.7.1.1.1.1"), Some("1.2.643.7.1.1.2.2"));
        // GOST R 34.10-2012, 512-bit
        assert_eq!(hash_oid_for_public_key("1.2.643.7.1.1.1.2"), Some("1.2.643.7.1.1.2.3"));
        // Legacy GOST R 34.10-2001, still issued by some CAs
        assert_eq!(hash_oid_for_public_key("1.2.643.2.2.19"), Some("1.2.643.2.2.9"));
        // An RSA certificate is not a GOST certificate: refuse rather than sign
        // with an algorithm ГИС МТ will not accept.
        assert_eq!(hash_oid_for_public_key("1.2.840.113549.1.1.1"), None);
    }

    #[test]
    fn formats_a_thumbprint_as_uppercase_hex() {
        assert_eq!(format_thumbprint(&[0xab, 0x12, 0x0f]), "AB120F");
    }

    #[test]
    fn converts_a_filetime_to_rfc3339_with_offset() {
        // 2026-08-28T12:00:00Z in FILETIME 100-ns ticks since 1601-01-01.
        let ticks: u64 = (1_787_918_400 + 11_644_473_600) * 10_000_000;
        assert_eq!(
            filetime_to_rfc3339(ticks as u32, (ticks >> 32) as u32),
            "2026-08-28T12:00:00.000Z"
        );
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run (on any platform; the module is `cfg(windows)`, so run this on a Windows machine or CI job — on macOS/Linux the test simply is not compiled and the task's verification is the Windows CI job added in Task 10):
`cargo test --manifest-path apps/signer/Cargo.toml`
Expected on Windows: FAIL — helpers undefined.

- [ ] **Step 3: Implement**

`apps/signer/signer-core/src/signer_capi.rs` (above the test module):

```rust
//! GOST signing through Win32 CryptoAPI.
//!
//! `CryptSignMessage` produces an attached PKCS#7/CMS blob using whichever CSP
//! holds the certificate's private key — CryptoPro, in practice — with no COM
//! and no .NET in the picture. If ГИС МТ ever rejects a plain CMS because it
//! wants CAdES-BES attributes, `signer_cades.rs` implements the same trait over
//! CAdESCOM and the runtime swaps one for the other.

use std::ffi::c_void;
use std::ptr;

use base64::Engine as _;
use windows_sys::Win32::Foundation::{FILETIME, HLOCAL};
use windows_sys::Win32::Security::Cryptography::*;

use crate::signer::{inn_from_subject, CertificateSummary, Signer};
use crate::SignerError;

const ENCODING: u32 = X509_ASN_ENCODING | PKCS_7_ASN_ENCODING;

/// GOST public-key OID -> the digest OID that must be used with it. Signing a
/// GOST key with any other digest yields a signature ГИС МТ will not verify.
pub fn hash_oid_for_public_key(public_key_oid: &str) -> Option<&'static str> {
    match public_key_oid {
        "1.2.643.7.1.1.1.1" => Some("1.2.643.7.1.1.2.2"),
        "1.2.643.7.1.1.1.2" => Some("1.2.643.7.1.1.2.3"),
        "1.2.643.2.2.19" => Some("1.2.643.2.2.9"),
        _ => None,
    }
}

pub fn format_thumbprint(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

pub fn filetime_to_rfc3339(low: u32, high: u32) -> String {
    let ticks = (u64::from(high) << 32) | u64::from(low);
    // FILETIME counts 100-ns intervals since 1601-01-01; Unix epoch is
    // 11_644_473_600 seconds later.
    let unix = ticks / 10_000_000;
    crate::trueapi::format_rfc3339_public(unix.saturating_sub(11_644_473_600))
}

pub struct CapiSigner;

impl CapiSigner {
    pub fn new() -> Self {
        Self
    }
}

impl Default for CapiSigner {
    fn default() -> Self {
        Self::new()
    }
}

impl Signer for CapiSigner {
    fn list_certificates(&self) -> Result<Vec<CertificateSummary>, SignerError> {
        let store = open_my_store()?;
        let mut out = Vec::new();
        let mut context: *const CERT_CONTEXT = ptr::null();
        loop {
            context = unsafe { CertEnumCertificatesInStore(store, context) };
            if context.is_null() {
                break;
            }
            if let Some(summary) = unsafe { summarize(context) } {
                out.push(summary);
            }
        }
        unsafe { CertCloseStore(store, 0) };
        Ok(out)
    }

    fn sign_attached(&self, thumbprint: &str, payload: &[u8]) -> Result<String, SignerError> {
        let store = open_my_store()?;
        let context = unsafe { find_by_thumbprint(store, thumbprint) };
        let context = match context {
            Some(context) => context,
            None => {
                unsafe { CertCloseStore(store, 0) };
                return Err(SignerError::CertNotFound(thumbprint.to_string()));
            }
        };

        let result = unsafe { sign_with_context(context, payload) };
        unsafe {
            CertFreeCertificateContext(context);
            CertCloseStore(store, 0);
        }
        result.map(|der| base64::engine::general_purpose::STANDARD.encode(der))
    }
}

fn open_my_store() -> Result<HCERTSTORE, SignerError> {
    let store = unsafe {
        CertOpenStore(
            CERT_STORE_PROV_SYSTEM_W,
            0,
            0,
            CERT_SYSTEM_STORE_CURRENT_USER | CERT_STORE_READONLY_FLAG,
            windows_sys::core::w!("MY") as *const c_void,
        )
    };
    if store.is_null() {
        return Err(SignerError::CryptoProviderMissing(
            "the current user's certificate store could not be opened".to_string(),
        ));
    }
    Ok(store)
}

/// Returns `None` for anything the agent cannot use: no private key, not a
/// GOST key, or an unreadable subject.
unsafe fn summarize(context: *const CERT_CONTEXT) -> Option<CertificateSummary> {
    let info = (*context).pCertInfo;
    if info.is_null() {
        return None;
    }
    let public_key_oid = cstr_to_string((*info).SubjectPublicKeyInfo.Algorithm.pszObjId)?;
    hash_oid_for_public_key(&public_key_oid)?;

    let has_private_key = has_key_prov_info(context);
    let subject = cert_name_string(context)?;
    let not_after: FILETIME = (*info).NotAfter;
    let thumbprint = cert_thumbprint(context)?;

    Some(CertificateSummary {
        inn: inn_from_subject(&subject),
        thumbprint,
        subject,
        not_after: filetime_to_rfc3339(not_after.dwLowDateTime, not_after.dwHighDateTime),
        has_private_key,
    })
}

unsafe fn has_key_prov_info(context: *const CERT_CONTEXT) -> bool {
    let mut size: u32 = 0;
    CertGetCertificateContextProperty(context, CERT_KEY_PROV_INFO_PROP_ID, ptr::null_mut(), &mut size)
        != 0
}

unsafe fn cert_thumbprint(context: *const CERT_CONTEXT) -> Option<String> {
    let mut size: u32 = 0;
    if CertGetCertificateContextProperty(context, CERT_HASH_PROP_ID, ptr::null_mut(), &mut size) == 0 {
        return None;
    }
    let mut buffer = vec![0u8; size as usize];
    if CertGetCertificateContextProperty(
        context,
        CERT_HASH_PROP_ID,
        buffer.as_mut_ptr().cast(),
        &mut size,
    ) == 0
    {
        return None;
    }
    buffer.truncate(size as usize);
    Some(format_thumbprint(&buffer))
}

unsafe fn cert_name_string(context: *const CERT_CONTEXT) -> Option<String> {
    let needed = CertGetNameStringW(
        context,
        CERT_NAME_RDN_TYPE,
        0,
        ptr::null_mut(),
        ptr::null_mut(),
        0,
    );
    if needed <= 1 {
        return None;
    }
    let mut buffer = vec![0u16; needed as usize];
    let written = CertGetNameStringW(
        context,
        CERT_NAME_RDN_TYPE,
        0,
        ptr::null_mut(),
        buffer.as_mut_ptr(),
        needed,
    );
    if written <= 1 {
        return None;
    }
    Some(String::from_utf16_lossy(&buffer[..(written as usize - 1)]))
}

unsafe fn find_by_thumbprint(store: HCERTSTORE, thumbprint: &str) -> Option<*const CERT_CONTEXT> {
    let mut context: *const CERT_CONTEXT = ptr::null();
    loop {
        context = CertEnumCertificatesInStore(store, context);
        if context.is_null() {
            return None;
        }
        if cert_thumbprint(context).as_deref() == Some(thumbprint) {
            // Duplicate so the caller owns a context independent of enumeration.
            return Some(CertDuplicateCertificateContext(context));
        }
    }
}

unsafe fn sign_with_context(
    context: *const CERT_CONTEXT,
    payload: &[u8],
) -> Result<Vec<u8>, SignerError> {
    let info = (*context).pCertInfo;
    if info.is_null() {
        return Err(SignerError::CertNotFound("certificate has no info".into()));
    }
    let public_key_oid = cstr_to_string((*info).SubjectPublicKeyInfo.Algorithm.pszObjId)
        .ok_or_else(|| SignerError::CertNotFound("unreadable public key algorithm".into()))?;
    let hash_oid = hash_oid_for_public_key(&public_key_oid).ok_or_else(|| {
        SignerError::CertNotFound(format!("{public_key_oid} is not a GOST key"))
    })?;
    let hash_oid_c = std::ffi::CString::new(hash_oid)
        .map_err(|e| SignerError::Protocol(e.to_string()))?;

    let mut certs: [*const CERT_CONTEXT; 1] = [context];
    let mut params = CRYPT_SIGN_MESSAGE_PARA {
        cbSize: std::mem::size_of::<CRYPT_SIGN_MESSAGE_PARA>() as u32,
        dwMsgEncodingType: ENCODING,
        pSigningCert: context,
        HashAlgorithm: CRYPT_ALGORITHM_IDENTIFIER {
            pszObjId: hash_oid_c.as_ptr() as *mut u8,
            Parameters: CRYPT_INTEGER_BLOB { cbData: 0, pbData: ptr::null_mut() },
        },
        pvHashAuxInfo: ptr::null_mut(),
        // Ship the signer certificate inside the blob so ГИС МТ can verify
        // without a separate lookup.
        cMsgCert: 1,
        rgpMsgCert: certs.as_mut_ptr(),
        cMsgCrl: 0,
        rgpMsgCrl: ptr::null_mut(),
        cAuthAttr: 0,
        rgAuthAttr: ptr::null_mut(),
        cUnauthAttr: 0,
        rgUnauthAttr: ptr::null_mut(),
        dwFlags: 0,
        dwInnerContentType: 0,
    };

    let to_be_signed: [*const u8; 1] = [payload.as_ptr()];
    let sizes: [u32; 1] = [payload.len() as u32];
    let mut blob_size: u32 = 0;

    // fDetachedSignature = FALSE: True API wants the challenge embedded.
    if CryptSignMessage(
        &mut params,
        0,
        1,
        to_be_signed.as_ptr(),
        sizes.as_ptr(),
        ptr::null_mut(),
        &mut blob_size,
    ) == 0
    {
        return Err(classify_last_error());
    }
    let mut blob = vec![0u8; blob_size as usize];
    if CryptSignMessage(
        &mut params,
        0,
        1,
        to_be_signed.as_ptr(),
        sizes.as_ptr(),
        blob.as_mut_ptr(),
        &mut blob_size,
    ) == 0
    {
        return Err(classify_last_error());
    }
    blob.truncate(blob_size as usize);
    Ok(blob)
}

/// Maps the CryptoAPI failure onto the wire error codes the cloud understands,
/// so the admin journal says "insert the token" rather than a bare hex code.
fn classify_last_error() -> SignerError {
    let code = unsafe { windows_sys::Win32::Foundation::GetLastError() };
    match code {
        // NTE_BAD_KEYSET / NTE_KEYSET_NOT_DEF / SCARD_W_REMOVED_CARD
        0x8009_0016 | 0x8009_0019 | 0x8010_0069 => SignerError::ContainerUnavailable(format!(
            "the key container is unavailable (0x{code:08X})"
        )),
        // NTE_BAD_KEY_STATE / SCARD_W_WRONG_CHV — the container wants a PIN.
        0x8009_000B | 0x8010_006B => SignerError::PinRequired,
        // CRYPT_E_NOT_FOUND
        0x8009_2004 => SignerError::CertNotFound(format!("0x{code:08X}")),
        // NTE_PROVIDER_DLL_FAIL / NTE_PROV_TYPE_NOT_DEF
        0x8009_001F | 0x8009_0017 => SignerError::CryptoProviderMissing(format!(
            "the GOST provider is not installed (0x{code:08X})"
        )),
        _ => SignerError::ContainerUnavailable(format!("signing failed (0x{code:08X})")),
    }
}

unsafe fn cstr_to_string(pointer: *const u8) -> Option<String> {
    if pointer.is_null() {
        return None;
    }
    let mut length = 0usize;
    while *pointer.add(length) != 0 {
        length += 1;
    }
    let slice = std::slice::from_raw_parts(pointer, length);
    std::str::from_utf8(slice).ok().map(str::to_string)
}

// Silences an unused-import warning when the module compiles without the
// HLOCAL-based helpers on some windows-sys versions.
const _: Option<HLOCAL> = None;
```

In `trueapi.rs`, expose the formatter for reuse (add next to `format_rfc3339`):

```rust
/// Shared with the Windows signer, which must render certificate validity in
/// the same RFC3339-with-offset shape the cloud contract requires.
pub fn format_rfc3339_public(unix_seconds: u64) -> String {
    format_rfc3339(unix_seconds)
}
```

Add to `lib.rs`:

```rust
#[cfg(windows)]
pub mod signer_capi;
```

- [ ] **Step 4: Verify on Windows**

Run on a Windows machine (or wait for the CI job from Task 10):
`cargo test --manifest-path apps/signer/Cargo.toml`
Expected: PASS, including the three new helper tests.
Also run `cargo clippy --manifest-path apps/signer/Cargo.toml -- -D warnings` and fix anything it flags in the FFI module.

- [ ] **Step 5: Commit**

```bash
git add apps/signer/signer-core
git commit -m "feat(signer): GOST signing over Win32 CryptoAPI"
```

---

### Task 5: DPAPI secret storage and durable config

**Files:**

- Create: `apps/signer/signer-core/src/storage.rs`, `apps/signer/signer-core/src/storage_dpapi.rs`
- Modify: `apps/signer/signer-core/src/lib.rs`
- Test: inline `#[cfg(test)]` in both

**Interfaces:**

- Consumes: `SignerError`.
- Produces: `pub struct AgentConfig { pub agent_id: Option<String>, pub tenant_name: Option<String>, pub server_url: Option<String>, pub cert_thumbprint: Option<String>, pub agent_secret_protected: Option<String> }`; `pub fn read_config(dir: &Path) -> Result<AgentConfig, SignerError>`; `pub fn write_config(dir: &Path, config: &AgentConfig) -> Result<(), SignerError>`; `pub fn clear_credential(dir: &Path) -> Result<(), SignerError>`; `pub trait SecretStore: Send + Sync { fn protect(&self, plaintext: &str) -> Result<String, SignerError>; fn unprotect(&self, protected: &str) -> Result<String, SignerError>; }`; `#[cfg(windows)] pub struct DpapiStore;`. Tasks 6 and 8 use these.

- [ ] **Step 1: Write the failing tests**

`storage.rs` test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_config_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let config = AgentConfig {
            agent_id: Some("a-1".into()),
            tenant_name: Some("ООО Ромашка".into()),
            server_url: Some("https://admin.markiro.app".into()),
            cert_thumbprint: Some("AB12".into()),
            agent_secret_protected: Some("cGxhaW4=".into()),
        };
        write_config(dir.path(), &config).unwrap();
        assert_eq!(read_config(dir.path()).unwrap(), config);
    }

    #[test]
    fn a_missing_file_reads_as_an_empty_config_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_config(dir.path()).unwrap(), AgentConfig::default());
    }

    #[test]
    fn clearing_the_credential_keeps_the_server_url_and_drops_the_secret() {
        let dir = tempfile::tempdir().unwrap();
        write_config(
            dir.path(),
            &AgentConfig {
                agent_id: Some("a-1".into()),
                tenant_name: Some("T".into()),
                server_url: Some("https://admin.markiro.app".into()),
                cert_thumbprint: Some("AB12".into()),
                agent_secret_protected: Some("secret".into()),
            },
        )
        .unwrap();
        clear_credential(dir.path()).unwrap();
        let after = read_config(dir.path()).unwrap();
        assert_eq!(after.server_url.as_deref(), Some("https://admin.markiro.app"));
        // The chosen certificate survives a re-pairing; the credential does not.
        assert_eq!(after.cert_thumbprint.as_deref(), Some("AB12"));
        assert_eq!(after.agent_secret_protected, None);
        assert_eq!(after.agent_id, None);
        assert_eq!(after.tenant_name, None);
    }

    #[test]
    fn a_partially_written_file_does_not_replace_a_good_one() {
        let dir = tempfile::tempdir().unwrap();
        let good = AgentConfig {
            agent_id: Some("a-1".into()),
            ..AgentConfig::default()
        };
        write_config(dir.path(), &good).unwrap();
        // Simulate a crashed write leaving a stray temp file behind.
        std::fs::write(dir.path().join(".signer-tmp-leftover"), b"{ broken").unwrap();
        assert_eq!(read_config(dir.path()).unwrap(), good);
    }

    #[test]
    fn rejects_a_server_url_carrying_credentials() {
        assert!(validate_http_url("https://user:pass@admin.markiro.app").is_err());
        assert!(validate_http_url("ftp://admin.markiro.app").is_err());
        assert!(validate_http_url("https://admin.markiro.app").is_ok());
    }
}
```

`storage_dpapi.rs` test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::SecretStore;

    #[test]
    fn round_trips_a_secret_through_dpapi() {
        let store = DpapiStore;
        let protected = store.protect("example-agent-secret").unwrap();
        assert_ne!(protected, "example-agent-secret", "must not be plaintext");
        assert_eq!(store.unprotect(&protected).unwrap(), "example-agent-secret");
    }

    #[test]
    fn refuses_a_corrupted_blob() {
        let store = DpapiStore;
        assert!(store.unprotect("not-base64-!!").is_err());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path apps/signer/Cargo.toml`
Expected: FAIL — storage items undefined.

- [ ] **Step 3: Implement `storage.rs`**

```rust
//! On-disk agent state under `%APPDATA%\app.markiro.signer\signer.json`.
//!
//! The agent secret is never stored in the clear: `agent_secret_protected`
//! holds a base64 DPAPI blob (see `storage_dpapi.rs`), which is bound to the
//! Windows user account, so copying the file to another machine or profile
//! yields nothing.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::SignerError;

const CONFIG_FILE: &str = "signer.json";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cert_thumbprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_secret_protected: Option<String>,
}

impl AgentConfig {
    pub fn is_paired(&self) -> bool {
        self.agent_secret_protected.is_some() && self.server_url.is_some()
    }
}

pub trait SecretStore: Send + Sync {
    fn protect(&self, plaintext: &str) -> Result<String, SignerError>;
    fn unprotect(&self, protected: &str) -> Result<String, SignerError>;
}

fn config_path(dir: &Path) -> PathBuf {
    dir.join(CONFIG_FILE)
}

pub fn read_config(dir: &Path) -> Result<AgentConfig, SignerError> {
    match fs::read_to_string(config_path(dir)) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| SignerError::Storage(e.to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(AgentConfig::default()),
        Err(error) => Err(SignerError::Storage(error.to_string())),
    }
}

/// Writes through a temp file and an atomic rename so a crash mid-write leaves
/// the previous config intact rather than a truncated one.
pub fn write_config(dir: &Path, config: &AgentConfig) -> Result<(), SignerError> {
    fs::create_dir_all(dir).map_err(|e| SignerError::Storage(e.to_string()))?;
    let text = serde_json::to_string_pretty(config).map_err(|e| SignerError::Storage(e.to_string()))?;
    let temp = dir.join(format!(".{CONFIG_FILE}.tmp"));
    {
        let mut file = fs::File::create(&temp).map_err(|e| SignerError::Storage(e.to_string()))?;
        file.write_all(text.as_bytes())
            .map_err(|e| SignerError::Storage(e.to_string()))?;
        file.sync_all().map_err(|e| SignerError::Storage(e.to_string()))?;
    }
    fs::rename(&temp, config_path(dir)).map_err(|e| SignerError::Storage(e.to_string()))
}

/// Drops everything tied to the cloud identity but keeps what the operator
/// would otherwise have to re-enter: the server URL and the chosen certificate.
pub fn clear_credential(dir: &Path) -> Result<(), SignerError> {
    let existing = read_config(dir)?;
    write_config(
        dir,
        &AgentConfig {
            agent_id: None,
            tenant_name: None,
            server_url: existing.server_url,
            cert_thumbprint: existing.cert_thumbprint,
            agent_secret_protected: None,
        },
    )
}

/// The server URL reaches us from a human-typed service screen, so reject the
/// shapes that would leak the agent secret: non-HTTP schemes and embedded
/// credentials.
pub fn validate_http_url(value: &str) -> Result<(), SignerError> {
    let value = value.trim();
    let rest = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
        .ok_or_else(|| SignerError::Storage("the server URL must be http or https".into()))?;
    let authority = rest.split('/').next().unwrap_or_default();
    if authority.is_empty() {
        return Err(SignerError::Storage("the server URL has no host".into()));
    }
    if authority.contains('@') {
        return Err(SignerError::Storage(
            "the server URL must not embed credentials".into(),
        ));
    }
    Ok(())
}
```

- [ ] **Step 4: Implement `storage_dpapi.rs`**

```rust
//! DPAPI-backed secret storage (per-user scope).
//!
//! `CryptProtectData` ties the ciphertext to the Windows account, which is
//! exactly the boundary we want: the agent runs as the operator who owns the
//! UKEP, and nobody else — including another account on the same machine —
//! can recover the agent secret from the config file.

use std::ptr;

use base64::Engine as _;
use windows_sys::Win32::Foundation::{LocalFree, HLOCAL};
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
};

use crate::storage::SecretStore;
use crate::SignerError;

pub struct DpapiStore;

impl SecretStore for DpapiStore {
    fn protect(&self, plaintext: &str) -> Result<String, SignerError> {
        let mut input = CRYPT_INTEGER_BLOB {
            cbData: plaintext.len() as u32,
            pbData: plaintext.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: ptr::null_mut() };
        let ok = unsafe {
            CryptProtectData(
                &mut input,
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                0,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(SignerError::Storage("DPAPI could not protect the secret".into()));
        }
        let blob = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
        let encoded = base64::engine::general_purpose::STANDARD.encode(blob);
        unsafe { LocalFree(output.pbData as HLOCAL) };
        Ok(encoded)
    }

    fn unprotect(&self, protected: &str) -> Result<String, SignerError> {
        let mut blob = base64::engine::general_purpose::STANDARD
            .decode(protected)
            .map_err(|e| SignerError::Storage(e.to_string()))?;
        let mut input = CRYPT_INTEGER_BLOB {
            cbData: blob.len() as u32,
            pbData: blob.as_mut_ptr(),
        };
        let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: ptr::null_mut() };
        let ok = unsafe {
            CryptUnprotectData(
                &mut input,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                0,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(SignerError::Storage(
                "DPAPI could not read the stored secret; re-pair this agent".into(),
            ));
        }
        let plaintext =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
        unsafe { LocalFree(output.pbData as HLOCAL) };
        String::from_utf8(plaintext).map_err(|e| SignerError::Storage(e.to_string()))
    }
}
```

Add to `lib.rs`:

```rust
pub mod storage;
#[cfg(windows)]
pub mod storage_dpapi;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --manifest-path apps/signer/Cargo.toml`
Expected: PASS — 22 tests on non-Windows, 24 on Windows.

- [ ] **Step 6: Commit**

```bash
git add apps/signer/signer-core
git commit -m "feat(signer): durable agent config and DPAPI secret storage"
```

---

### Task 6: Runtime loop

**Files:**

- Create: `apps/signer/signer-core/src/runtime.rs`, `apps/signer/signer-core/src/journal.rs`
- Modify: `apps/signer/signer-core/src/lib.rs`
- Test: inline `#[cfg(test)]` in both

**Interfaces:**

- Consumes: `CloudClient`, `Signer`, `SecretStore`, storage functions, `obtain_token`, contracts.
- Produces: `pub enum AgentPhase { Unpaired, Idle, Working, Degraded }`; `pub struct AgentStatus { pub phase: AgentPhase, pub tenant_name: Option<String>, pub cert_thumbprint: Option<String>, pub last_token_expires_at: Option<String>, pub last_error: Option<String> }`; `pub struct Runtime`; `Runtime::new(config_dir: PathBuf, signer: Arc<dyn Signer>, secrets: Arc<dyn SecretStore>, app_version: String) -> Runtime`; `async fn run(self, on_change: impl Fn(AgentStatus) + Send + 'static)`; `pub fn classify(error: &SignerError) -> Option<SignerErrorCode>`; `JournalEntry`/`Journal::append`. Task 7 spawns `run` and forwards `AgentStatus` to the UI.

- [ ] **Step 1: Write the failing tests**

`journal.rs` test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_anything_that_looks_like_a_credential() {
        let entry = JournalEntry::new("token refreshed", Some("Bearer eyJhbGciOiJIUzI1NiJ9.abc.def"));
        assert!(!entry.detail.as_deref().unwrap_or_default().contains("eyJ"));
        assert!(entry.detail.as_deref().unwrap_or_default().contains("[redacted]"));
    }

    #[test]
    fn keeps_only_the_most_recent_entries() {
        let mut journal = Journal::with_capacity(2);
        journal.append(JournalEntry::new("one", None));
        journal.append(JournalEntry::new("two", None));
        journal.append(JournalEntry::new("three", None));
        let entries = journal.entries();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].message, "two");
    }
}
```

`runtime.rs` test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::SignerErrorCode;

    #[test]
    fn maps_crypto_failures_onto_wire_error_codes() {
        assert_eq!(
            classify(&SignerError::PinRequired),
            Some(SignerErrorCode::CryptoPinRequired)
        );
        assert_eq!(
            classify(&SignerError::ContainerUnavailable("x".into())),
            Some(SignerErrorCode::CryptoContainerUnavailable)
        );
        assert_eq!(
            classify(&SignerError::CryptoProviderMissing("x".into())),
            Some(SignerErrorCode::CryptoProviderMissing)
        );
        assert_eq!(
            classify(&SignerError::CertNotFound("x".into())),
            Some(SignerErrorCode::CryptoCertNotFound)
        );
        assert_eq!(
            classify(&SignerError::TrueApi("x".into())),
            Some(SignerErrorCode::TrueApi)
        );
        // A transient network failure must NOT be reported as a task failure:
        // the cloud re-enqueues after its own timeout, and failing the task
        // would waste the whole refresh window on a blip.
        assert_eq!(classify(&SignerError::Network("x".into())), None);
        assert_eq!(classify(&SignerError::Revoked), None);
    }

    #[test]
    fn backoff_grows_and_is_capped() {
        assert_eq!(backoff_for(0).as_secs(), 2);
        assert_eq!(backoff_for(1).as_secs(), 4);
        assert_eq!(backoff_for(2).as_secs(), 8);
        assert_eq!(backoff_for(10).as_secs(), 60, "must be capped so a recovered link is picked up promptly");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path apps/signer/Cargo.toml`
Expected: FAIL — `classify` / `Journal` undefined.

- [ ] **Step 3: Implement `journal.rs`**

```rust
//! A short in-memory journal mirrored into the tray window.
//!
//! Credentials must never land here: the cloud holds the authoritative audit,
//! and this file is readable by anything running as the operator.

use std::collections::VecDeque;

const DEFAULT_CAPACITY: usize = 200;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub message: String,
    pub detail: Option<String>,
}

impl JournalEntry {
    pub fn new(message: impl Into<String>, detail: Option<&str>) -> Self {
        Self {
            message: message.into(),
            detail: detail.map(redact),
        }
    }
}

/// Replaces JWT-shaped and long base64-ish runs, which is what a leaked token
/// or agent secret would look like in an error string.
fn redact(detail: &str) -> String {
    let mut out = String::with_capacity(detail.len());
    for word in detail.split_whitespace() {
        let looks_secret = word.len() >= 24
            && word
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+' | '/' | '='));
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(if looks_secret { "[redacted]" } else { word });
    }
    out
}

#[derive(Debug)]
pub struct Journal {
    capacity: usize,
    entries: VecDeque<JournalEntry>,
}

impl Default for Journal {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_CAPACITY)
    }
}

impl Journal {
    pub fn with_capacity(capacity: usize) -> Self {
        Self { capacity: capacity.max(1), entries: VecDeque::new() }
    }

    pub fn append(&mut self, entry: JournalEntry) {
        if self.entries.len() == self.capacity {
            self.entries.pop_front();
        }
        self.entries.push_back(entry);
    }

    pub fn entries(&self) -> Vec<JournalEntry> {
        self.entries.iter().cloned().collect()
    }
}
```

- [ ] **Step 4: Implement `runtime.rs`**

```rust
//! The agent loop: claim a task, obtain a token, report, repeat.
//!
//! Two rules shape it. A 401 on any authenticated call means the cabinet
//! revoked this agent, so local state is wiped and the UI returns to pairing.
//! A network failure is *not* reported as a task failure: the claim stays with
//! us until the cloud's 30-minute deadline, and reporting `fail` would burn the
//! refresh window over a blip.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::cloud::{CloudClient, PairError};
use crate::contracts::{SignerErrorCode, TaskComplete, TaskFail};
use crate::journal::{Journal, JournalEntry};
use crate::signer::Signer;
use crate::storage::{self, AgentConfig, SecretStore};
use crate::trueapi::obtain_token;
use crate::SignerError;

const POLL_WAIT_MS: u32 = 25_000;
const MAX_BACKOFF: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentPhase {
    Unpaired,
    Idle,
    Working,
    Degraded,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub phase: AgentPhase,
    pub tenant_name: Option<String>,
    pub cert_thumbprint: Option<String>,
    pub last_token_expires_at: Option<String>,
    pub last_error: Option<String>,
    pub journal: Vec<JournalEntry>,
}

/// Which failures are worth telling the cloud about. `None` means "keep the
/// claim and retry locally".
pub fn classify(error: &SignerError) -> Option<SignerErrorCode> {
    match error {
        SignerError::CryptoProviderMissing(_) => Some(SignerErrorCode::CryptoProviderMissing),
        SignerError::CertNotFound(_) => Some(SignerErrorCode::CryptoCertNotFound),
        SignerError::CertExpired(_) => Some(SignerErrorCode::CryptoCertExpired),
        SignerError::ContainerUnavailable(_) => Some(SignerErrorCode::CryptoContainerUnavailable),
        SignerError::PinRequired => Some(SignerErrorCode::CryptoPinRequired),
        SignerError::TrueApi(_) => Some(SignerErrorCode::TrueApi),
        SignerError::Network(_) | SignerError::Revoked | SignerError::Storage(_) | SignerError::Protocol(_) => None,
    }
}

pub fn backoff_for(attempt: u32) -> Duration {
    let seconds = 2u64.saturating_pow(attempt.min(6) + 1);
    Duration::from_secs(seconds).min(MAX_BACKOFF)
}

pub struct Runtime {
    config_dir: PathBuf,
    signer: Arc<dyn Signer>,
    secrets: Arc<dyn SecretStore>,
    app_version: String,
    journal: Mutex<Journal>,
}

impl Runtime {
    pub fn new(
        config_dir: PathBuf,
        signer: Arc<dyn Signer>,
        secrets: Arc<dyn SecretStore>,
        app_version: String,
    ) -> Self {
        Self {
            config_dir,
            signer,
            secrets,
            app_version,
            journal: Mutex::new(Journal::default()),
        }
    }

    pub fn config(&self) -> Result<AgentConfig, SignerError> {
        storage::read_config(&self.config_dir)
    }

    fn note(&self, message: &str, detail: Option<&str>) {
        if let Ok(mut journal) = self.journal.lock() {
            journal.append(JournalEntry::new(message, detail));
        }
    }

    fn journal_entries(&self) -> Vec<JournalEntry> {
        self.journal
            .lock()
            .map(|journal| journal.entries())
            .unwrap_or_default()
    }

    pub fn status(&self) -> AgentStatus {
        let config = self.config().unwrap_or_default();
        AgentStatus {
            phase: if config.is_paired() { AgentPhase::Idle } else { AgentPhase::Unpaired },
            tenant_name: config.tenant_name,
            cert_thumbprint: config.cert_thumbprint,
            last_token_expires_at: None,
            last_error: None,
            journal: self.journal_entries(),
        }
    }

    /// Redeems a pairing code and persists the DPAPI-protected secret.
    pub async fn pair(&self, server_url: &str, code: &str, hostname: &str) -> Result<String, PairError> {
        storage::validate_http_url(server_url)
            .map_err(|e| PairError::Network(e.to_string()))?;
        let client = CloudClient::new(server_url, &self.app_version)
            .map_err(|e| PairError::Network(e.to_string()))?;
        let paired = client.pair(code, hostname).await?;
        let protected = self
            .secrets
            .protect(&paired.agent_secret)
            .map_err(|e| PairError::Network(e.to_string()))?;
        let existing = self.config().unwrap_or_default();
        storage::write_config(
            &self.config_dir,
            &AgentConfig {
                agent_id: Some(paired.agent_id),
                tenant_name: Some(paired.tenant_name.clone()),
                server_url: Some(server_url.trim_end_matches('/').to_string()),
                cert_thumbprint: existing.cert_thumbprint,
                agent_secret_protected: Some(protected),
            },
        )
        .map_err(|e| PairError::Network(e.to_string()))?;
        self.note("Agent paired", Some(&paired.tenant_name));
        Ok(paired.tenant_name)
    }

    /// Wipes the credential locally — used both on revocation and on operator
    /// request.
    pub fn unpair(&self) -> Result<(), SignerError> {
        storage::clear_credential(&self.config_dir)?;
        self.note("Agent unpaired", None);
        Ok(())
    }

    pub async fn run<F>(self: Arc<Self>, on_change: F)
    where
        F: Fn(AgentStatus) + Send + Sync + 'static,
    {
        let mut failures: u32 = 0;
        loop {
            let config = match self.config() {
                Ok(config) => config,
                Err(error) => {
                    self.note("Could not read the local configuration", Some(&error.to_string()));
                    tokio::time::sleep(backoff_for(failures)).await;
                    failures = failures.saturating_add(1);
                    continue;
                }
            };
            if !config.is_paired() {
                on_change(self.status());
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
            let (Some(server_url), Some(protected)) =
                (config.server_url.clone(), config.agent_secret_protected.clone())
            else {
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            };
            let secret = match self.secrets.unprotect(&protected) {
                Ok(secret) => secret,
                Err(error) => {
                    // The blob belongs to another user or profile: pairing again
                    // is the only recovery.
                    self.note("Stored credential is unreadable", Some(&error.to_string()));
                    let _ = self.unpair();
                    on_change(self.status());
                    continue;
                }
            };
            let client = match CloudClient::new(&server_url, &self.app_version) {
                Ok(client) => client,
                Err(error) => {
                    self.note("Could not build the cloud client", Some(&error.to_string()));
                    tokio::time::sleep(backoff_for(failures)).await;
                    failures = failures.saturating_add(1);
                    continue;
                }
            };

            match client.poll(&secret, POLL_WAIT_MS).await {
                Ok(None) => {
                    failures = 0;
                    on_change(self.status());
                }
                Ok(Some(task)) => {
                    failures = 0;
                    self.note("Task received", Some(&task.id));
                    self.execute(&client, &secret, &config, &task, &on_change).await;
                }
                Err(SignerError::Revoked) => {
                    self.note("The cabinet revoked this agent", None);
                    let _ = self.unpair();
                    on_change(self.status());
                }
                Err(error) => {
                    self.note("Poll failed", Some(&error.to_string()));
                    tokio::time::sleep(backoff_for(failures)).await;
                    failures = failures.saturating_add(1);
                    let mut status = self.status();
                    status.phase = AgentPhase::Degraded;
                    status.last_error = Some(error.to_string());
                    on_change(status);
                }
            }
        }
    }

    async fn execute<F>(
        &self,
        client: &CloudClient,
        secret: &str,
        config: &AgentConfig,
        task: &crate::contracts::SignerTask,
        on_change: &F,
    ) where
        F: Fn(AgentStatus) + Send + Sync + 'static,
    {
        let mut status = self.status();
        status.phase = AgentPhase::Working;
        on_change(status);

        let Some(thumbprint) = config.cert_thumbprint.clone() else {
            let body = TaskFail::new(
                SignerErrorCode::CryptoCertNotFound,
                "no certificate has been selected in the agent",
            );
            let _ = client.fail(secret, &task.id, &body).await;
            self.note("No certificate selected", None);
            return;
        };

        let http = reqwest::Client::new();
        let outcome = obtain_token(
            &http,
            &task.payload.true_api_base_url,
            task.payload.inn.as_deref(),
            &thumbprint,
            self.signer.as_ref(),
        )
        .await;

        match outcome {
            Ok(token) => {
                let certificate = self
                    .signer
                    .list_certificates()
                    .ok()
                    .and_then(|certs| certs.into_iter().find(|c| c.thumbprint == thumbprint));
                // Send every cert field on every report: the cloud writes them
                // unconditionally, so omitting one nulls a stored value.
                let body = TaskComplete {
                    token: token.token,
                    expires_at: token.expires_at.clone(),
                    cert_thumbprint: thumbprint,
                    cert_subject: certificate.as_ref().map(|c| c.subject.clone()),
                    cert_inn: certificate.as_ref().and_then(|c| c.inn.clone()),
                    cert_not_after: certificate.as_ref().map(|c| c.not_after.clone()),
                };
                match client.complete(secret, &task.id, &body).await {
                    Ok(()) => {
                        self.note("True API token delivered", None);
                        let mut status = self.status();
                        status.last_token_expires_at = Some(token.expires_at);
                        on_change(status);
                    }
                    Err(error) => self.note("Could not report the token", Some(&error.to_string())),
                }
            }
            Err(error) => {
                self.note("Signing failed", Some(&error.to_string()));
                if let Some(code) = classify(&error) {
                    let body = TaskFail::new(code, error.to_string());
                    let _ = client.fail(secret, &task.id, &body).await;
                }
                let mut status = self.status();
                status.phase = AgentPhase::Degraded;
                status.last_error = Some(error.to_string());
                on_change(status);
            }
        }
    }
}
```

Add `pub mod journal;` and `pub mod runtime;` to `lib.rs`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --manifest-path apps/signer/Cargo.toml`
Expected: PASS — 26 tests on non-Windows.

- [ ] **Step 6: Commit**

```bash
git add apps/signer/signer-core
git commit -m "feat(signer): agent runtime loop with revocation and backoff handling"
```

---

### Task 7: Tauri shell — tray, window, commands

**Files:**

- Create: `apps/signer/src-tauri/Cargo.toml`, `build.rs`, `src/main.rs`, `src/lib.rs`, `src/commands.rs`, `tauri.conf.json`, `tauri.stable.conf.json`, `capabilities/default.json`, `windows/installer-hooks.nsh`
- Create: `apps/signer/src-tauri/icons/` (copy the six icon files from `apps/station/src-tauri/icons/` as placeholders)
- Modify: `apps/signer/Cargo.toml` (restore both workspace members)
- Test: `apps/signer/test/tauri-release-config.test.ts` (added in Task 10)

**Interfaces:**

- Consumes: `signer-core`'s `Runtime`, `AgentStatus`, `CapiSigner`, `DpapiStore`.
- Produces: Tauri commands `signer_status`, `signer_pair`, `signer_unpair`, `signer_list_certificates`, `signer_select_certificate`, `signer_set_server_url`; event `signer://status` carrying `AgentStatus`. Task 8's UI calls exactly these.

- [ ] **Step 1: Write the shell**

`apps/signer/src-tauri/Cargo.toml`:

```toml
[package]
name = "markiro-signer"
version = "0.1.0"
description = "Markiro Chestny ZNAK signer agent"
edition = "2021"
license = "Apache-2.0 OR MIT"

[lib]
name = "markiro_signer_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
signer-core = { path = "../signer-core" }
tauri = { version = "2.11", features = ["tray-icon"] }
tauri-plugin-updater = "=2.10.1"
tauri-plugin-process = "2.3.1"
tauri-plugin-single-instance = "2"
tauri-plugin-autostart = "2"
tauri-plugin-notification = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "=1.53.1", features = ["rt-multi-thread"] }

[features]
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
```

`apps/signer/src-tauri/build.rs`:

```rust
fn main() {
    tauri_build::build();
}
```

`apps/signer/src-tauri/src/main.rs`:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    markiro_signer_lib::run();
}
```

`apps/signer/src-tauri/src/lib.rs`:

```rust
mod commands;

use std::sync::Arc;

use signer_core::runtime::Runtime;
use signer_core::signer::Signer;
use signer_core::storage::SecretStore;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};

pub const STATUS_EVENT: &str = "signer://status";
const SIGNER_ICON: tauri::image::Image<'_> = tauri::include_image!("./icons/128x128.png");

/// The deployment this build talks to. Baked in at compile time so a packaged
/// agent can never infer its API target from the webview origin; the service
/// screen can still override it into the config file for a self-hosted tenant.
pub fn default_server_url() -> &'static str {
    option_env!("SIGNER_API_URL").unwrap_or("https://admin.markiro.app")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let version = app.package_info().version.to_string();

            #[cfg(windows)]
            let signer: Arc<dyn Signer> = Arc::new(signer_core::signer_capi::CapiSigner::new());
            #[cfg(windows)]
            let secrets: Arc<dyn SecretStore> = Arc::new(signer_core::storage_dpapi::DpapiStore);
            #[cfg(not(windows))]
            let (signer, secrets) = commands::unsupported_platform_backends();

            let runtime = Arc::new(Runtime::new(config_dir, signer, secrets, version));
            app.manage(commands::SignerState { runtime: runtime.clone() });

            if let Some(window) = app.get_webview_window("main") {
                window.set_icon(SIGNER_ICON.clone())?;
            }

            let open = MenuItem::with_id(app, "open", "Открыть", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::new()
                .icon(SIGNER_ICON.clone())
                .tooltip("Markiro Подписант")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                runtime
                    .run(move |status| {
                        notify_if_actionable(&handle, &status);
                        let _ = handle.emit(STATUS_EVENT, status);
                    })
                    .await;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window parks the agent in the tray; quitting is an
            // explicit tray action, because a closed window must not stop the
            // token refresh.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::signer_status,
            commands::signer_pair,
            commands::signer_unpair,
            commands::signer_list_certificates,
            commands::signer_select_certificate,
            commands::signer_set_server_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Markiro signer");
}

/// A tray notification is the only way the operator learns about a failure
/// that needs their hands — an absent token, a locked container, a missing
/// provider. Everything else stays in the window's journal so the tray does
/// not cry wolf.
fn notify_if_actionable(app: &tauri::AppHandle, status: &signer_core::runtime::AgentStatus) {
    use signer_core::runtime::AgentPhase;
    use tauri_plugin_notification::NotificationExt as _;

    if status.phase != AgentPhase::Degraded {
        return;
    }
    let Some(detail) = status.last_error.as_deref() else {
        return;
    };
    let _ = app
        .notification()
        .builder()
        .title("Markiro Подписант")
        .body(detail)
        .show();
}
```

`apps/signer/src-tauri/src/commands.rs`:

```rust
use std::sync::Arc;

use signer_core::cloud::PairError;
use signer_core::runtime::{AgentStatus, Runtime};
use signer_core::signer::{CertificateSummary, Signer};
use signer_core::storage::{self, SecretStore};

pub struct SignerState {
    pub runtime: Arc<Runtime>,
}

#[tauri::command]
pub fn signer_status(state: tauri::State<'_, SignerState>) -> AgentStatus {
    state.runtime.status()
}

#[tauri::command]
pub async fn signer_pair(
    state: tauri::State<'_, SignerState>,
    code: String,
    hostname: String,
) -> Result<String, String> {
    let config = state.runtime.config().map_err(|e| e.to_string())?;
    let server_url = config
        .server_url
        .unwrap_or_else(|| crate::default_server_url().to_string());
    state
        .runtime
        .pair(&server_url, &code, &hostname)
        .await
        .map_err(|error| match error {
            // The cloud deliberately does not distinguish wrong from expired
            // from rate-limited, so neither do we.
            PairError::Rejected => "rejected".to_string(),
            PairError::Network(_) => "unavailable".to_string(),
        })
}

#[tauri::command]
pub fn signer_unpair(state: tauri::State<'_, SignerState>) -> Result<(), String> {
    state.runtime.unpair().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn signer_list_certificates(
    state: tauri::State<'_, SignerState>,
) -> Result<Vec<CertificateSummary>, String> {
    state.runtime.certificates().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn signer_select_certificate(
    state: tauri::State<'_, SignerState>,
    thumbprint: String,
) -> Result<(), String> {
    state
        .runtime
        .select_certificate(&thumbprint)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn signer_set_server_url(
    state: tauri::State<'_, SignerState>,
    url: String,
) -> Result<(), String> {
    storage::validate_http_url(&url).map_err(|e| e.to_string())?;
    state.runtime.set_server_url(&url).map_err(|e| e.to_string())
}

/// The agent only ships for Windows; on other platforms the shell still builds
/// (so `cargo test` runs in CI on Linux) but every capability refuses.
#[cfg(not(windows))]
pub fn unsupported_platform_backends() -> (Arc<dyn Signer>, Arc<dyn SecretStore>) {
    use signer_core::SignerError;

    struct Unsupported;
    impl Signer for Unsupported {
        fn list_certificates(&self) -> Result<Vec<CertificateSummary>, SignerError> {
            Err(SignerError::CryptoProviderMissing("Windows only".into()))
        }
        fn sign_attached(&self, _t: &str, _p: &[u8]) -> Result<String, SignerError> {
            Err(SignerError::CryptoProviderMissing("Windows only".into()))
        }
    }
    impl SecretStore for Unsupported {
        fn protect(&self, _plaintext: &str) -> Result<String, SignerError> {
            Err(SignerError::Storage("Windows only".into()))
        }
        fn unprotect(&self, _protected: &str) -> Result<String, SignerError> {
            Err(SignerError::Storage("Windows only".into()))
        }
    }
    (Arc::new(Unsupported), Arc::new(Unsupported))
}
```

- [ ] **Step 2: Add the three runtime methods the commands need**

Append to `impl Runtime` in `apps/signer/signer-core/src/runtime.rs`:

```rust
    pub fn certificates(&self) -> Result<Vec<crate::signer::CertificateSummary>, SignerError> {
        self.signer.list_certificates()
    }

    pub fn select_certificate(&self, thumbprint: &str) -> Result<(), SignerError> {
        let mut config = self.config()?;
        config.cert_thumbprint = Some(thumbprint.to_string());
        storage::write_config(&self.config_dir, &config)?;
        self.note("Certificate selected", Some(thumbprint));
        Ok(())
    }

    pub fn set_server_url(&self, url: &str) -> Result<(), SignerError> {
        storage::validate_http_url(url)?;
        let mut config = self.config()?;
        config.server_url = Some(url.trim_end_matches('/').to_string());
        storage::write_config(&self.config_dir, &config)
    }
```

Add a test for `select_certificate` in `runtime.rs`'s test module:

```rust
    #[test]
    fn selecting_a_certificate_persists_it() {
        use crate::signer::CertificateSummary;
        struct NoSigner;
        impl Signer for NoSigner {
            fn list_certificates(&self) -> Result<Vec<CertificateSummary>, SignerError> {
                Ok(vec![])
            }
            fn sign_attached(&self, _t: &str, _p: &[u8]) -> Result<String, SignerError> {
                Err(SignerError::PinRequired)
            }
        }
        struct PlainStore;
        impl SecretStore for PlainStore {
            fn protect(&self, plaintext: &str) -> Result<String, SignerError> {
                Ok(plaintext.to_string())
            }
            fn unprotect(&self, protected: &str) -> Result<String, SignerError> {
                Ok(protected.to_string())
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let runtime = Runtime::new(
            dir.path().to_path_buf(),
            Arc::new(NoSigner),
            Arc::new(PlainStore),
            "0.1.0".into(),
        );
        runtime.select_certificate("AB12").unwrap();
        assert_eq!(runtime.config().unwrap().cert_thumbprint.as_deref(), Some("AB12"));
    }
```

- [ ] **Step 3: Write the Tauri configuration**

`apps/signer/src-tauri/tauri.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Markiro Signer",
  "version": "0.1.0",
  "identifier": "app.markiro.signer",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:5373",
    "beforeDevCommand": "pnpm --filter @markiro/signer dev",
    "beforeBuildCommand": "pnpm --filter @markiro/signer build"
  },
  "app": {
    "windows": [
      {
        "title": "Markiro Подписант",
        "width": 560,
        "height": 720,
        "resizable": true,
        "visible": false,
        "skipTaskbar": false
      }
    ],
    "security": {
      "csp": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "createUpdaterArtifacts": true,
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "windows": {
      "nsis": {
        "installerIcon": "icons/icon.ico",
        "installerHooks": "windows/installer-hooks.nsh"
      }
    }
  },
  "plugins": {
    "updater": {
      "endpoints": ["https://releases.markiro.app/signer/beta/latest.json"],
      "pubkey": "REPLACE_WITH_SIGNER_MINISIGN_PUBLIC_KEY"
    }
  }
}
```

Note on the CSP: unlike the Station, the signer's webview never talks to the cloud — all HTTP happens in Rust — so `connect-src` deliberately omits `https:`.

`apps/signer/src-tauri/tauri.stable.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "plugins": {
    "updater": {
      "endpoints": ["https://releases.markiro.app/signer/stable/latest.json"]
    }
  }
}
```

`apps/signer/src-tauri/capabilities/default.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Signer webview capabilities",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "process:allow-restart",
    "notification:default",
    "autostart:allow-enable",
    "autostart:allow-disable",
    "autostart:allow-is-enabled"
  ]
}
```

`apps/signer/src-tauri/windows/installer-hooks.nsh`:

```nsis
!macro NSIS_HOOK_POSTINSTALL
  ; The tray agent must come back after a reboot without the operator opening
  ; it, so register autostart for the installing user.
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MarkiroSigner" "$INSTDIR\Markiro Signer.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MarkiroSigner"
!macroend
```

Copy icons: `cp apps/station/src-tauri/icons/* apps/signer/src-tauri/icons/` (placeholder art; branded icons are a separate design task).

Restore `apps/signer/Cargo.toml` to `members = ["signer-core", "src-tauri"]`.

- [ ] **Step 4: Verify it compiles and tests still pass**

The frontend must exist before `tauri::generate_context!` can compile, so this step's verification is deferred to Task 8's Step 5. For now:
Run: `cargo test --manifest-path apps/signer/Cargo.toml -p signer-core`
Expected: PASS, 27 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/signer
git commit -m "feat(signer): Tauri tray shell wiring the agent runtime"
```

---

### Task 8: Frontend — pairing, certificate picker, status

**Files:**

- Create: `apps/signer/package.json`, `index.html`, `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, `turbo.json`, `signer.css`
- Create: `apps/signer/src/main.tsx`, `src/App.tsx`, `src/lib/bridge.ts`, `src/pages/Pairing.tsx`, `src/pages/Status.tsx`, `src/components/CertificatePicker.tsx`, `src/components/JournalList.tsx`, `src/i18n/{index.ts,ru.json,en.json}`
- Create: `apps/signer/test/setup.ts`, `test/app-state.test.ts`, `test/pairing.test.tsx`
- Modify: `eslint.config.mjs` (add `signer` to the react-hooks glob)

**Interfaces:**

- Consumes: Tauri commands and the `signer://status` event from Task 7.
- Produces: `nextSignerView(status: AgentStatus | null): SignerView` where `SignerView = "loading" | "pairing" | "ready"`; the bridge functions `status()`, `pair(code, hostname)`, `unpair()`, `listCertificates()`, `selectCertificate(thumbprint)`, `setServerUrl(url)`, `onStatus(listener)`.

- [ ] **Step 1: Write the failing tests**

`apps/signer/test/app-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { nextSignerView } from "../src/App.js";

describe("nextSignerView", () => {
  it("waits while the status is unknown", () => {
    expect(nextSignerView(null)).toBe("loading");
  });

  it("asks for a pairing code until the agent is paired", () => {
    expect(
      nextSignerView({
        phase: "unpaired",
        tenantName: null,
        certThumbprint: null,
        lastTokenExpiresAt: null,
        lastError: null,
        journal: [],
      }),
    ).toBe("pairing");
  });

  it("shows the status panel once paired, even while degraded", () => {
    for (const phase of ["idle", "working", "degraded"] as const) {
      expect(
        nextSignerView({
          phase,
          tenantName: "ООО Ромашка",
          certThumbprint: "AB12",
          lastTokenExpiresAt: null,
          lastError: null,
          journal: [],
        }),
      ).toBe("ready");
    }
  });
});
```

`apps/signer/test/pairing.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Pairing } from "../src/pages/Pairing.js";

describe("Pairing", () => {
  it("submits an eight digit code and reports success", async () => {
    const onPair = vi.fn().mockResolvedValue({ ok: true, tenantName: "ООО Ромашка" });
    render(<Pairing onPair={onPair} hostname="BUH-PC" />);
    await userEvent.type(screen.getByLabelText(/код привязки|pairing code/i), "01234567");
    await userEvent.click(screen.getByRole("button", { name: /привязать|pair/i }));
    expect(onPair).toHaveBeenCalledWith("01234567");
  });

  it("keeps the button disabled until the code is complete", async () => {
    const onPair = vi.fn();
    render(<Pairing onPair={onPair} hostname="BUH-PC" />);
    await userEvent.type(screen.getByLabelText(/код привязки|pairing code/i), "0123");
    expect(screen.getByRole("button", { name: /привязать|pair/i })).toBeDisabled();
  });

  it("surfaces a rejected code without guessing why", async () => {
    const onPair = vi.fn().mockResolvedValue({ ok: false, error: "rejected" });
    render(<Pairing onPair={onPair} hostname="BUH-PC" />);
    await userEvent.type(screen.getByLabelText(/код привязки|pairing code/i), "00000000");
    await userEvent.click(screen.getByRole("button", { name: /привязать|pair/i }));
    expect(await screen.findByText(/недействителен|not valid/i)).toBeInTheDocument();
  });
});
```

`apps/signer/test/certificate-expiry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { expiryWarning } from "../src/components/CertificatePicker.js";

describe("expiryWarning", () => {
  const now = new Date("2026-08-28T00:00:00.000Z");

  it("warns once a certificate is inside the two week window", () => {
    expect(expiryWarning("2026-09-05T00:00:00.000Z", now)).toBe("expiring");
  });

  it("says nothing while the certificate has plenty of life", () => {
    expect(expiryWarning("2027-03-01T00:00:00.000Z", now)).toBe(null);
  });

  it("reports an already expired certificate distinctly", () => {
    expect(expiryWarning("2026-08-01T00:00:00.000Z", now)).toBe("expired");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @markiro/signer exec vitest run`
Expected: FAIL — package does not exist.

Note: `test/certificate-expiry.test.ts` above belongs to this same step; all three test files are written before any UI code.

- [ ] **Step 3: Scaffold the package**

`apps/signer/package.json`:

```json
{
  "name": "@markiro/signer",
  "version": "0.1.0",
  "private": true,
  "license": "SEE LICENSE IN LICENSE",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "tauri": "tauri",
    "lint": "eslint . --ignore-pattern 'src-tauri/target/**' --ignore-pattern 'src-tauri/gen/**'",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@fontsource/ibm-plex-mono": "5.3.0",
    "@fontsource/ibm-plex-sans": "5.3.0",
    "@markiro/ui": "workspace:*",
    "@tauri-apps/api": "2.11.1",
    "@tauri-apps/plugin-process": "2.3.1",
    "@tauri-apps/plugin-updater": "2.10.1",
    "i18next": "26.3.6",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "react-i18next": "17.0.11"
  },
  "devDependencies": {
    "@tauri-apps/cli": "2.11.4",
    "@testing-library/react": "16.3.2",
    "@testing-library/user-event": "14.6.1",
    "@types/node": "26.2.0",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.4",
    "@vitejs/plugin-react": "6.0.5",
    "jsdom": "29.1.1",
    "typescript": "6.0.3",
    "vite": "8.2.1",
    "vitest": "4.1.11"
  }
}
```

If `@testing-library/user-event` is not already in the lockfile at that version, use whatever version `apps/admin/package.json` pins.

`apps/signer/turbo.json`: `{"extends": ["//"]}`

`apps/signer/index.html`:

```html
<!doctype html>
<html lang="ru" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Markiro Подписант</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/signer/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  envDir: "../..",
  plugins: [react()],
  clearScreen: false,
  server: { port: 5373, strictPort: true },
  build: { target: "es2023", outDir: "dist" },
});
```

`apps/signer/vitest.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["test/setup.ts"],
  },
});
```

`apps/signer/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["vite/client", "vitest/globals"],
    "noEmit": true,
    "resolveJsonModule": true
  },
  "include": ["src", "test", "vite.config.ts", "vitest.config.ts"]
}
```

`apps/signer/test/setup.ts`: `import "../src/i18n/index.js";`

In `eslint.config.mjs`, extend the react-hooks glob from `apps/{admin,kiosk,station}/**` to `apps/{admin,kiosk,station,signer}/**`.

- [ ] **Step 4: Write the UI**

`apps/signer/src/lib/bridge.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type AgentPhase = "unpaired" | "idle" | "working" | "degraded";

/** Mirrors `signer_core::runtime::AgentStatus`. */
export interface AgentStatus {
  phase: AgentPhase;
  tenantName: string | null;
  certThumbprint: string | null;
  lastTokenExpiresAt: string | null;
  lastError: string | null;
  journal: { message: string; detail: string | null }[];
}

/** Mirrors `signer_core::signer::CertificateSummary`. */
export interface CertificateSummary {
  thumbprint: string;
  subject: string;
  inn: string | null;
  notAfter: string;
  hasPrivateKey: boolean;
}

export type PairOutcome =
  { ok: true; tenantName: string } | { ok: false; error: "rejected" | "unavailable" };

export const bridge = {
  status: () => invoke<AgentStatus>("signer_status"),
  async pair(code: string, hostname: string): Promise<PairOutcome> {
    try {
      const tenantName = await invoke<string>("signer_pair", { code, hostname });
      return { ok: true, tenantName };
    } catch (error) {
      return { ok: false, error: error === "rejected" ? "rejected" : "unavailable" };
    }
  },
  unpair: () => invoke<void>("signer_unpair"),
  listCertificates: () => invoke<CertificateSummary[]>("signer_list_certificates"),
  selectCertificate: (thumbprint: string) =>
    invoke<void>("signer_select_certificate", { thumbprint }),
  setServerUrl: (url: string) => invoke<void>("signer_set_server_url", { url }),
  onStatus: (listener: (status: AgentStatus) => void) =>
    listen<AgentStatus>("signer://status", (event) => listener(event.payload)),
};
```

`apps/signer/src/App.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Spinner } from "@markiro/ui";
import { bridge, type AgentStatus } from "./lib/bridge.js";
import { Pairing } from "./pages/Pairing.js";
import { Status } from "./pages/Status.js";

export type SignerView = "loading" | "pairing" | "ready";

/** Three states, no router: the agent is either still reading its config, not
 *  paired yet, or running. Degraded is a badge on the ready screen, not a
 *  separate view — the operator still needs the journal and the unpair button. */
export function nextSignerView(status: AgentStatus | null): SignerView {
  if (!status) return "loading";
  return status.phase === "unpaired" ? "pairing" : "ready";
}

export function App(): JSX.Element {
  const { t } = useTranslation();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [hostname] = useState(() => window.location.hostname || "windows-pc");

  useEffect(() => {
    let disposed = false;
    void bridge.status().then((initial) => {
      if (!disposed) setStatus(initial);
    });
    const unlisten = bridge.onStatus((next) => setStatus(next));
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop());
    };
  }, []);

  const view = nextSignerView(status);
  if (view === "loading") return <Spinner label={t("app.loading")} />;
  if (view === "pairing" || !status) {
    return (
      <Pairing
        hostname={hostname}
        onPair={(code) => bridge.pair(code, hostname)}
        onPaired={() => void bridge.status().then(setStatus)}
      />
    );
  }
  return <Status status={status} onChanged={() => void bridge.status().then(setStatus)} />;
}
```

`apps/signer/src/pages/Pairing.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, Input } from "@markiro/ui";
import type { PairOutcome } from "../lib/bridge.js";

interface PairingProps {
  hostname: string;
  onPair: (code: string) => Promise<PairOutcome>;
  onPaired?: () => void;
}

export function Pairing({ hostname, onPair, onPaired }: PairingProps): JSX.Element {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"rejected" | "unavailable" | null>(null);
  const complete = /^\d{8}$/.test(code);

  async function submit(): Promise<void> {
    if (!complete || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await onPair(code);
      if (outcome.ok) {
        setCode("");
        onPaired?.();
      } else {
        setError(outcome.error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t("pairing.title")}>
      <p>{t("pairing.hint", { hostname })}</p>
      <Input
        label={t("pairing.codeLabel")}
        value={code}
        inputMode="numeric"
        maxLength={8}
        autoComplete="one-time-code"
        onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
      />
      {error ? <Alert tone="error">{t(`pairing.error.${error}`)}</Alert> : null}
      <Button onClick={() => void submit()} disabled={!complete} loading={busy}>
        {t("pairing.submit")}
      </Button>
    </Card>
  );
}
```

`apps/signer/src/pages/Status.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { Button, Card, StatusChip } from "@markiro/ui";
import { bridge, type AgentStatus } from "../lib/bridge.js";
import { CertificatePicker } from "../components/CertificatePicker.js";
import { JournalList } from "../components/JournalList.js";

const PHASE_TONE = {
  unpaired: "neutral",
  idle: "ok",
  working: "info",
  degraded: "error",
} as const;

export function Status({
  status,
  onChanged,
}: {
  status: AgentStatus;
  onChanged: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <Card title={t("status.title")}>
      <p>
        {status.tenantName}{" "}
        <StatusChip status={PHASE_TONE[status.phase]} label={t(`status.phase.${status.phase}`)} />
      </p>
      {status.lastTokenExpiresAt ? (
        <p>
          {t("status.tokenExpires", { at: new Date(status.lastTokenExpiresAt).toLocaleString() })}
        </p>
      ) : (
        <p>{t("status.noToken")}</p>
      )}
      {status.lastError ? <p>{status.lastError}</p> : null}
      <CertificatePicker selected={status.certThumbprint} onSelected={onChanged} />
      <JournalList entries={status.journal} />
      <Button variant="destructive" onClick={() => void bridge.unpair().then(onChanged)}>
        {t("status.unpair")}
      </Button>
    </Card>
  );
}
```

`apps/signer/src/components/CertificatePicker.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Select, Spinner } from "@markiro/ui";
import { bridge, type CertificateSummary } from "../lib/bridge.js";

const EXPIRY_WARNING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** A UKEP that lapses silently stops every refresh, so the window flags it two
 *  weeks ahead — long enough for the customer to reissue the certificate. */
export function expiryWarning(
  notAfter: string,
  now: Date = new Date(),
): "expired" | "expiring" | null {
  const remaining = new Date(notAfter).getTime() - now.getTime();
  if (Number.isNaN(remaining)) return null;
  if (remaining <= 0) return "expired";
  return remaining <= EXPIRY_WARNING_WINDOW_MS ? "expiring" : null;
}

export function CertificatePicker({
  selected,
  onSelected,
}: {
  selected: string | null;
  onSelected: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [certificates, setCertificates] = useState<CertificateSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    bridge
      .listCertificates()
      .then((list) => {
        if (!disposed) setCertificates(list.filter((c) => c.hasPrivateKey));
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(String(cause));
      });
    return () => {
      disposed = true;
    };
  }, []);

  if (error) return <Alert tone="error">{t("certificates.unavailable")}</Alert>;
  if (!certificates) return <Spinner label={t("certificates.loading")} />;
  if (certificates.length === 0) return <Alert tone="warn">{t("certificates.empty")}</Alert>;

  const chosen = certificates.find((certificate) => certificate.thumbprint === selected);
  const warning = chosen ? expiryWarning(chosen.notAfter) : null;

  return (
    <div>
      {warning ? (
        <Alert tone={warning === "expired" ? "error" : "warn"}>
          {t(`certificates.${warning}`, {
            at: new Date(chosen?.notAfter ?? "").toLocaleDateString(),
          })}
        </Alert>
      ) : null}
      <Select
        label={t("certificates.label")}
        value={selected ?? ""}
        onChange={(event) => {
          const thumbprint = event.target.value;
          if (thumbprint) void bridge.selectCertificate(thumbprint).then(onSelected);
        }}
        options={certificates.map((certificate) => ({
          value: certificate.thumbprint,
          label: `${certificate.subject} · ${new Date(certificate.notAfter).toLocaleDateString()}`,
        }))}
      />
      <Button onClick={() => void bridge.listCertificates().then(setCertificates)}>
        {t("certificates.refresh")}
      </Button>
    </div>
  );
}
```

Match `Select`'s and `Input`'s real prop APIs in `packages/ui/src/components/` — adapt if they differ from the shapes above.

`apps/signer/src/components/JournalList.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { EmptyState } from "@markiro/ui";

export function JournalList({
  entries,
}: {
  entries: { message: string; detail: string | null }[];
}): JSX.Element {
  const { t } = useTranslation();
  if (entries.length === 0) return <EmptyState title={t("journal.empty")} />;
  return (
    <ul>
      {entries
        .slice()
        .reverse()
        .map((entry, index) => (
          <li key={`${entry.message}-${index}`}>
            {entry.message}
            {entry.detail ? ` — ${entry.detail}` : ""}
          </li>
        ))}
    </ul>
  );
}
```

`apps/signer/src/main.tsx`:

```tsx
import "@markiro/ui/styles.css";
import "./signer.css";
import "./i18n/index.js";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@markiro/ui";
import { App } from "./App.js";

const container = document.getElementById("root");
if (!container) throw new Error("#root element not found");

createRoot(container).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark">
      <App />
    </ThemeProvider>
  </StrictMode>,
);
```

`apps/signer/src/signer.css`:

```css
body {
  margin: 0;
  font-family: "IBM Plex Sans", system-ui, sans-serif;
}
#root {
  padding: 16px;
}
```

`apps/signer/src/i18n/index.ts` — copy `apps/station/src/i18n/index.ts` verbatim, changing only the imported dictionaries.

`apps/signer/src/i18n/ru.json`:

```json
{
  "app": { "loading": "Загрузка…" },
  "pairing": {
    "title": "Привязка агента",
    "hint": "Создайте код привязки в кабинете Markiro и введите его здесь. Компьютер: {{hostname}}.",
    "codeLabel": "Код привязки",
    "submit": "Привязать",
    "error": {
      "rejected": "Код недействителен, просрочен или уже использован. Создайте новый в кабинете.",
      "unavailable": "Не удалось связаться с сервером. Проверьте соединение и повторите."
    }
  },
  "status": {
    "title": "Агент КЭП",
    "phase": {
      "unpaired": "не привязан",
      "idle": "ожидает задачи",
      "working": "подписывает",
      "degraded": "ошибка"
    },
    "tokenExpires": "Токен действует до {{at}}",
    "noToken": "Токен ещё не получен",
    "unpair": "Отвязать агента"
  },
  "certificates": {
    "label": "Сертификат для подписи",
    "loading": "Читаем хранилище сертификатов…",
    "empty": "Не найдено ни одного ГОСТ-сертификата с закрытым ключом. Проверьте, что КриптоПро установлен и носитель вставлен.",
    "unavailable": "Не удалось прочитать хранилище сертификатов.",
    "refresh": "Обновить список",
    "expiring": "Срок действия сертификата истекает {{at}}. Выпустите новый, иначе обновление токена остановится.",
    "expired": "Срок действия сертификата истёк {{at}}. Подписание невозможно."
  },
  "journal": { "empty": "Событий пока нет" }
}
```

`apps/signer/src/i18n/en.json` — the same keys with English copy.

- [ ] **Step 5: Run tests and compile the shell**

```bash
pnpm install
pnpm --filter @markiro/signer exec vitest run
pnpm --filter @markiro/signer typecheck
pnpm --filter @markiro/signer lint
pnpm turbo build --filter '@markiro/signer...'
cargo test --manifest-path apps/signer/Cargo.toml
```

Expected: 6 frontend tests pass; typecheck/lint clean; `dist/` built; `cargo test` passes (the shell now compiles because `apps/signer/dist` exists).

- [ ] **Step 6: Commit**

```bash
git add apps/signer eslint.config.mjs pnpm-lock.yaml
git commit -m "feat(signer): tray UI for pairing, certificate selection and status"
```

---

### Task 9: Release-config contract test

**Files:**

- Create: `apps/signer/test/tauri-release-config.test.ts`

**Interfaces:**

- Consumes: the config files from Task 7.
- Produces: a regression gate mirroring `apps/station/test/tauri-release-config.test.ts`.

- [ ] **Step 1: Write the test**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(new URL(`../src-tauri/${name}`, import.meta.url), "utf8"));

describe("signer release configuration", () => {
  const base = read("tauri.conf.json");
  const stable = read("tauri.stable.conf.json");
  const capabilities = read("capabilities/default.json");

  it("produces updater artifacts from the NSIS bundle only", () => {
    expect(base.bundle.createUpdaterArtifacts).toBe(true);
    expect(base.bundle.targets).toEqual(["nsis"]);
  });

  it("pins the identifier and the beta endpoint", () => {
    expect(base.identifier).toBe("app.markiro.signer");
    expect(base.plugins.updater.endpoints).toEqual([
      "https://releases.markiro.app/signer/beta/latest.json",
    ]);
  });

  it("keeps one public key, declared only in the base config", () => {
    expect(typeof base.plugins.updater.pubkey).toBe("string");
    expect(stable.plugins.updater).not.toHaveProperty("pubkey");
    expect(stable.plugins.updater.endpoints).toEqual([
      "https://releases.markiro.app/signer/stable/latest.json",
    ]);
  });

  it("starts hidden so the agent lives in the tray", () => {
    expect(base.app.windows[0].visible).toBe(false);
  });

  it("does not let the webview reach the network directly", () => {
    // Every cloud and True API call happens in Rust; a webview that could
    // reach https: would be a way to exfiltrate a token from the UI layer.
    expect(base.app.security.csp).not.toContain("https:");
  });

  it("grants the webview no filesystem or shell capability", () => {
    for (const permission of capabilities.permissions) {
      expect(permission).not.toMatch(/^(fs|shell|http):/);
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @markiro/signer exec vitest run test/tauri-release-config.test.ts`
Expected: PASS, 6 tests. If the pubkey is still the `REPLACE_WITH_…` placeholder the first assertion on its type still passes; generating the real minisign keypair is part of Task 12's runbook.

- [ ] **Step 3: Commit**

```bash
git add apps/signer/test/tauri-release-config.test.ts
git commit -m "test(signer): pin the release configuration contract"
```

---

### Task 10: CI jobs

**Files:**

- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: everything above.
- Produces: jobs `signer-rust` (Linux: build + test the crates) and `signer-windows-build` (Windows: compile the app, run the Windows-only tests).

- [ ] **Step 1: Add the jobs**

Append after the existing `station-windows-build` job, matching its style and pinned action SHAs:

```yaml
signer-rust:
  runs-on: ubuntu-latest
  timeout-minutes: 30
  steps:
    - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      with:
        persist-credentials: false
    - name: Install Linux webkit deps
      env:
        DEBIAN_FRONTEND: noninteractive
      run: |
        sudo apt-get -o Acquire::Retries=3 update
        sudo apt-get -o Acquire::Retries=3 install --no-install-recommends -y \
          libwebkit2gtk-4.1-dev \
          libgtk-3-dev
    - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
    - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
      with:
        node-version: 24
        cache: pnpm
    - uses: dtolnay/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4 # stable
    - run: pnpm install --frozen-lockfile
    # `tauri::generate_context!` needs `apps/signer/dist` at compile time.
    - name: Build signer webview + workspace deps
      run: pnpm turbo build --filter '@markiro/signer...'
    - name: cargo build + test (signer core and shell)
      run: |
        cargo build --manifest-path apps/signer/Cargo.toml
        cargo test  --manifest-path apps/signer/Cargo.toml

signer-windows-build:
  runs-on: windows-latest
  timeout-minutes: 40
  steps:
    - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      with:
        persist-credentials: false
    - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
    - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
      with:
        node-version: 24
        cache: pnpm
    - uses: dtolnay/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4 # stable
    - run: pnpm install --frozen-lockfile
    - name: Build signer webview + workspace deps
      run: pnpm turbo build --filter '@markiro/signer...'
    # The CryptoAPI and DPAPI modules only compile on Windows, so this is the
    # only job that exercises them.
    - name: cargo test (Windows crypto paths)
      run: cargo test --manifest-path apps/signer/Cargo.toml
    - name: Compile the Windows Tauri application
      run: pnpm --filter @markiro/signer tauri build --debug --no-bundle
```

- [ ] **Step 2: Validate the workflow**

Run: `python3 -c "import yaml; d=yaml.safe_load(open('.github/workflows/ci.yml')); print(sorted(k for k in d['jobs'] if 'signer' in k))"`
Expected: `['signer-rust', 'signer-windows-build']`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: build and test the signer agent on Linux and Windows"
```

---

### Task 11: CAdESCOM fallback behind the same trait

**Files:**

- Create: `apps/signer/signer-core/src/signer_cades.rs`
- Modify: `apps/signer/signer-core/src/lib.rs`, `apps/signer/signer-core/Cargo.toml`, `apps/signer/src-tauri/src/lib.rs`
- Test: inline `#[cfg(test)]` in `signer_cades.rs`

**Interfaces:**

- Consumes: `Signer`, `CertificateSummary`, `SignerError`.
- Produces: `pub struct CadesSigner;` implementing `Signer`; `pub fn signer_backend_from_env() -> SignerBackend` where `pub enum SignerBackend { CryptoApi, Cades }`.

**Run this task only if the Task 12 sandbox run shows ГИС МТ rejecting the CryptoAPI signature.** If CryptoAPI is accepted, skip to Task 12's documentation step and record the decision in the runbook.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_cryptoapi_and_honours_an_explicit_override() {
        assert_eq!(backend_from_value(None), SignerBackend::CryptoApi);
        assert_eq!(backend_from_value(Some("cades")), SignerBackend::Cades);
        assert_eq!(backend_from_value(Some("CADES")), SignerBackend::Cades);
        // An unknown value must not silently disable signing.
        assert_eq!(backend_from_value(Some("nonsense")), SignerBackend::CryptoApi);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test --manifest-path apps/signer/Cargo.toml`
Expected: FAIL — `backend_from_value` undefined.

- [ ] **Step 3: Implement**

Add to `apps/signer/signer-core/Cargo.toml` under the Windows target:

```toml
windows = { version = "0.61", features = [
  "Win32_System_Com",
  "Win32_System_Variant",
  "Win32_System_Ole",
] }
```

`apps/signer/signer-core/src/signer_cades.rs`:

```rust
//! CAdES-BES signing through CryptoPro's CAdESCOM automation objects.
//!
//! This exists because ГИС МТ's own examples produce CAdES-BES, and a plain
//! CMS blob from `CryptSignMessage` may be rejected by stricter endpoints. It
//! implements the same `Signer` trait, so switching costs one constructor.
//! Requires the CryptoPro CAdES SDK / browser plug-in in addition to the CSP.

use windows::core::{BSTR, VARIANT};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, IDispatch,
};

use crate::signer::{CertificateSummary, Signer};
use crate::SignerError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignerBackend {
    CryptoApi,
    Cades,
}

/// Chosen at startup from `MARKIRO_SIGNER_BACKEND`. Defaults to CryptoAPI:
/// it needs only the CSP, while CAdESCOM additionally needs the SDK.
pub fn signer_backend_from_env() -> SignerBackend {
    backend_from_value(std::env::var("MARKIRO_SIGNER_BACKEND").ok().as_deref())
}

pub fn backend_from_value(value: Option<&str>) -> SignerBackend {
    match value.map(str::to_ascii_lowercase).as_deref() {
        Some("cades") => SignerBackend::Cades,
        _ => SignerBackend::CryptoApi,
    }
}

pub struct CadesSigner;

impl Signer for CadesSigner {
    fn list_certificates(&self) -> Result<Vec<CertificateSummary>, SignerError> {
        // Enumeration stays on CryptoAPI: it needs no COM and returns exactly
        // the same thumbprints CAdESCOM would.
        crate::signer_capi::CapiSigner::new().list_certificates()
    }

    fn sign_attached(&self, thumbprint: &str, payload: &[u8]) -> Result<String, SignerError> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }
        let store = create_object("CAdESCOM.Store")?;
        let signer = create_object("CAdESCOM.CPSigner")?;
        let signed_data = create_object("CAdESCOM.CadesSignedData")?;
        sign_via_cadescom(&store, &signer, &signed_data, thumbprint, payload)
    }
}

fn create_object(prog_id: &str) -> Result<IDispatch, SignerError> {
    let clsid = unsafe { windows::Win32::System::Com::CLSIDFromProgID(&BSTR::from(prog_id)) }
        .map_err(|e| {
            SignerError::CryptoProviderMissing(format!("{prog_id} is not registered: {e}"))
        })?;
    unsafe { CoCreateInstance(&clsid, None, CLSCTX_INPROC_SERVER) }
        .map_err(|e| SignerError::CryptoProviderMissing(format!("{prog_id}: {e}")))
}

// CAPICOM / CAdESCOM constants, from the CryptoPro SDK headers.
const CAPICOM_CURRENT_USER_STORE: i32 = 2;
const CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED: i32 = 2;
const CAPICOM_CERTIFICATE_FIND_SHA1_HASH: i32 = 0;
/// `Content` is fed base64 text rather than raw bytes.
const CADESCOM_BASE64_TO_BINARY: i32 = 1;
const CADESCOM_CADES_BES: i32 = 1;

/// Drives the CAdESCOM object graph through IDispatch:
/// `Store.Open` → `Store.Certificates.Find(SHA1_HASH, thumbprint)` →
/// `Item(1)` → `Signer.Certificate = cert` → `SignedData.ContentEncoding` +
/// `SignedData.Content = base64(payload)` →
/// `SignedData.SignCades(Signer, CADES_BES, false)`, which returns the
/// attached signature already base64-encoded.
fn sign_via_cadescom(
    store: &IDispatch,
    signer: &IDispatch,
    signed_data: &IDispatch,
    thumbprint: &str,
    payload: &[u8],
) -> Result<String, SignerError> {
    use base64::Engine as _;

    call(
        store,
        "Open",
        &[
            VARIANT::from(CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED),
            VARIANT::from(BSTR::from("My")),
            VARIANT::from(CAPICOM_CURRENT_USER_STORE),
        ],
    )?;
    let certificates = get(store, "Certificates")?.to_dispatch()?;
    let found = call(
        &certificates,
        "Find",
        &[
            VARIANT::from(BSTR::from(thumbprint)),
            VARIANT::from(CAPICOM_CERTIFICATE_FIND_SHA1_HASH),
        ],
    )?
    .to_dispatch()?;
    let count = get(&found, "Count")?.to_i32()?;
    if count < 1 {
        let _ = call(store, "Close", &[]);
        return Err(SignerError::CertNotFound(thumbprint.to_string()));
    }
    // CAPICOM collections are 1-based.
    let certificate = call(&found, "Item", &[VARIANT::from(1i32)])?.to_dispatch()?;

    put(signer, "Certificate", VARIANT::from(certificate))?;
    put(
        signed_data,
        "ContentEncoding",
        VARIANT::from(CADESCOM_BASE64_TO_BINARY),
    )?;
    put(
        signed_data,
        "Content",
        VARIANT::from(BSTR::from(
            base64::engine::general_purpose::STANDARD.encode(payload),
        )),
    )?;

    let signature = call(
        signed_data,
        "SignCades",
        &[
            // Arguments are passed right-to-left by IDispatch convention.
            VARIANT::from(false),
            VARIANT::from(CADESCOM_CADES_BES),
            VARIANT::from(signer.clone()),
        ],
    );
    let _ = call(store, "Close", &[]);
    signature?.to_string_value()
}

/// Minimal late-bound IDispatch helpers. CAdESCOM ships no type library we can
/// bind statically, so every call goes through `GetIDsOfNames` + `Invoke`.
mod dispatch {
    use super::*;
    use windows::Win32::System::Com::{
        DISPATCH_METHOD, DISPATCH_PROPERTYGET, DISPATCH_PROPERTYPUTREF, DISPPARAMS,
    };
    use windows::Win32::System::Variant::VT_DISPATCH;

    fn dispid(target: &IDispatch, name: &str) -> Result<i32, SignerError> {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let mut names = [windows::core::PCWSTR(wide.as_ptr())];
        let mut id = 0i32;
        unsafe {
            target
                .GetIDsOfNames(
                    &windows::core::GUID::zeroed(),
                    names.as_mut_ptr(),
                    1,
                    0,
                    &mut id,
                )
                .map_err(|e| SignerError::CryptoProviderMissing(format!("{name}: {e}")))?;
        }
        Ok(id)
    }

    fn invoke(
        target: &IDispatch,
        name: &str,
        flags: u16,
        args: &[VARIANT],
    ) -> Result<VARIANT, SignerError> {
        let id = dispid(target, name)?;
        let mut arguments: Vec<VARIANT> = args.to_vec();
        let mut params = DISPPARAMS {
            rgvarg: if arguments.is_empty() {
                std::ptr::null_mut()
            } else {
                arguments.as_mut_ptr()
            },
            cArgs: arguments.len() as u32,
            ..Default::default()
        };
        let mut result = VARIANT::default();
        unsafe {
            target
                .Invoke(
                    id,
                    &windows::core::GUID::zeroed(),
                    0,
                    flags,
                    &mut params,
                    Some(&mut result),
                    None,
                    None,
                )
                .map_err(|e| SignerError::ContainerUnavailable(format!("{name}: {e}")))?;
        }
        Ok(result)
    }

    pub fn call(target: &IDispatch, name: &str, args: &[VARIANT]) -> Result<VARIANT, SignerError> {
        invoke(target, name, DISPATCH_METHOD.0 as u16, args)
    }

    pub fn get(target: &IDispatch, name: &str) -> Result<VARIANT, SignerError> {
        invoke(target, name, DISPATCH_PROPERTYGET.0 as u16, &[])
    }

    pub fn put(target: &IDispatch, name: &str, value: VARIANT) -> Result<(), SignerError> {
        let id = dispid(target, name)?;
        let mut arguments = [value];
        let mut named = [windows::Win32::System::Com::DISPID_PROPERTYPUT];
        let mut params = DISPPARAMS {
            rgvarg: arguments.as_mut_ptr(),
            cArgs: 1,
            rgdispidNamedArgs: named.as_mut_ptr(),
            cNamedArgs: 1,
        };
        unsafe {
            target
                .Invoke(
                    id,
                    &windows::core::GUID::zeroed(),
                    0,
                    DISPATCH_PROPERTYPUTREF.0 as u16,
                    &mut params,
                    None,
                    None,
                    None,
                )
                .map_err(|e| SignerError::ContainerUnavailable(format!("{name}: {e}")))?;
        }
        Ok(())
    }

    pub trait VariantExt {
        fn to_dispatch(&self) -> Result<IDispatch, SignerError>;
        fn to_i32(&self) -> Result<i32, SignerError>;
        fn to_string_value(&self) -> Result<String, SignerError>;
    }

    impl VariantExt for VARIANT {
        fn to_dispatch(&self) -> Result<IDispatch, SignerError> {
            IDispatch::try_from(self)
                .map_err(|e| SignerError::CryptoProviderMissing(format!("expected an object: {e}")))
        }
        fn to_i32(&self) -> Result<i32, SignerError> {
            i32::try_from(self)
                .map_err(|e| SignerError::CryptoProviderMissing(format!("expected a number: {e}")))
        }
        fn to_string_value(&self) -> Result<String, SignerError> {
            BSTR::try_from(self)
                .map(|value| value.to_string())
                .map_err(|e| SignerError::CryptoProviderMissing(format!("expected a string: {e}")))
        }
        }

    const _: windows::Win32::System::Variant::VARENUM = VT_DISPATCH;
}

use dispatch::{call, get, put, VariantExt as _};
```

The `VARIANT`/`BSTR` conversion helpers above target the `windows` crate's `VARIANT` API; if the crate version in the lockfile exposes different constructors, adapt the helpers rather than the call sequence — the CAdESCOM object graph and the constant values are what matter.

In `apps/signer/src-tauri/src/lib.rs`, pick the backend:

```rust
#[cfg(windows)]
let signer: Arc<dyn Signer> = match signer_core::signer_cades::signer_backend_from_env() {
    signer_core::signer_cades::SignerBackend::Cades => {
        Arc::new(signer_core::signer_cades::CadesSigner)
    }
    signer_core::signer_cades::SignerBackend::CryptoApi => {
        Arc::new(signer_core::signer_capi::CapiSigner::new())
    }
};
```

Add `#[cfg(windows)] pub mod signer_cades;` to `lib.rs`.

- [ ] **Step 4: Run tests**

Run: `cargo test --manifest-path apps/signer/Cargo.toml`
Expected: PASS including the new backend-selection test.

- [ ] **Step 5: Commit**

```bash
git add apps/signer
git commit -m "feat(signer): CAdESCOM backend selection behind the signing trait"
```

---

### Task 12: Manual sandbox verification and runbook

**Files:**

- Create: `docs/runbooks/signer-agent-manual-e2e.md`
- Modify: `apps/signer/src-tauri/tauri.conf.json` (real minisign public key)

**Interfaces:**

- Consumes: the whole app.
- Produces: a recorded verdict on whether CryptoAPI's CMS signature is accepted by True API, which decides whether Task 11 ships.

- [ ] **Step 1: Write the runbook**

`docs/runbooks/signer-agent-manual-e2e.md`:

```markdown
# Signer agent — manual end-to-end verification

The signing path cannot be exercised in CI: it needs CryptoPro CSP, a GOST
certificate with a private key, and a live True API sandbox account. Run this
once per release candidate on a Windows machine that has all three.

## Prerequisites

- Windows 10/11 with CryptoPro CSP installed and a valid test certificate in
  the current user's **Личное / MY** store.
- A Markiro tenant with the Chestny ZNAK integration enabled and its
  `environment` setting set to `sandbox`.
- `CHZ_TOKEN_ENCRYPTION_KEY` configured on the API instance, otherwise the
  scheduler pauses and no task is ever enqueued.

## Steps

1. Build the agent: `pnpm turbo build --filter '@markiro/signer...'` then
   `pnpm --filter @markiro/signer tauri build`. Install the NSIS package.
2. In the Markiro cabinet open **Интеграции → Честный ЗНАК** and press
   **Получить код привязки**.
3. In the agent's tray window enter the eight-digit code. Expect the tenant
   name to appear within a few seconds.
4. Choose the GOST certificate in the picker. The list only shows certificates
   with a private key and a GOST public key.
5. Force a refresh: in the cabinet, revoke nothing — instead wait for the
   scheduler (runs every 15 minutes) or delete the tenant's `chz_api_tokens`
   row so the next tick enqueues a task immediately.
6. Watch the agent journal. A healthy run reads: _Task received_ → _True API
   token delivered_.
7. Confirm in the cabinet that the token status shows **действует** with an
   expiry roughly ten hours out.

## The signature-format verdict

Step 6 is the decision point for the signing backend:

- **`True API token delivered`** — `CryptSignMessage`'s attached CMS blob is
  accepted. Record that here and skip the CAdESCOM task entirely.
- **`Signing failed` with a `TRUE_API` code mentioning the signature** — ГИС МТ
  wants CAdES-BES attributes. Implement `signer_cades.rs`'s
  `sign_via_cadescom` against the installed SDK, set
  `MARKIRO_SIGNER_BACKEND=cades`, and repeat from step 5.

Record the date, the CryptoPro version, and the verdict below.

| Date | CryptoPro version | Backend | Verdict |
| ---- | ----------------- | ------- | ------- |
|      |                   |         |         |

## Failure cases worth exercising

- Pull the Rutoken mid-run: the journal must show
  `CRYPTO_CONTAINER_UNAVAILABLE` and the cabinet journal must show the same
  code — not a generic error.
- Revoke the agent in the cabinet: the tray window must return to the pairing
  screen on the next poll, and `%APPDATA%\app.markiro.signer\signer.json` must
  no longer contain `agentSecretProtected`.
- Stop the API: the agent must back off and recover on its own once the API
  returns, without failing the claimed task.
```

- [ ] **Step 2: Generate and install the updater keypair**

```bash
pnpm --filter @markiro/signer exec tauri signer generate -w ~/.markiro/signer-updater.key
```

Put the printed public key into `apps/signer/src-tauri/tauri.conf.json` under `plugins.updater.pubkey`, and store the private key and its password as the repository secrets `SIGNER_TAURI_SIGNING_PRIVATE_KEY` / `SIGNER_TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Do not commit the private key.

- [ ] **Step 3: Verify the config test still passes**

Run: `pnpm --filter @markiro/signer exec vitest run test/tauri-release-config.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 4: Commit**

```bash
git add docs/runbooks/signer-agent-manual-e2e.md apps/signer/src-tauri/tauri.conf.json
git commit -m "docs(signer): manual sandbox verification runbook"
```

---

### Task 13: Full verification pass

- [ ] **Step 1: Run everything**

```bash
pnpm --filter @markiro/signer test
pnpm --filter @markiro/signer typecheck
pnpm --filter @markiro/signer lint
pnpm turbo build --filter '@markiro/signer...'
cargo test --manifest-path apps/signer/Cargo.toml
cargo clippy --manifest-path apps/signer/Cargo.toml -- -D warnings
pnpm format:check
pnpm turbo lint typecheck build --concurrency=1 --force
```

Expected: all green. Paste counts into the report.

- [ ] **Step 2: Commit any stragglers**

```bash
git add -A && git commit -m "chore(signer): verification fixes" || echo "nothing to commit"
```

---

## Out of scope

- Consuming the stored token (`cises/info` status refresh, `FILTERED_CIS_REPORT` exports) — a separate design.
- Detached document signing (`sign_detached` task type) — the envelope is reserved in the contracts but no cloud task type emits it.
- macOS and Linux packaging; embedding `signer-core` into the Station.
- A dedicated release workflow for the signer (the Station's two workflows are the template; wiring the equivalent pair is follow-up work once the first build is validated by hand).
- In-app update UI. The updater plugin is registered and `createUpdaterArtifacts` is on, so the release pipeline already produces signed packages; adding a check-and-install screen later needs no change to packaging.
- Multiple certificates or multiple organizations per agent.
