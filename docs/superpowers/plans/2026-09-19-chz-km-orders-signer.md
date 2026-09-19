# Chestny ZNAK KM Orders — Signer Agent Implementation Plan (phase 1, part B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the Windows signer agent two new cloud tasks: `oms_auth` (obtain a СУЗ client token through `POST /auth/simpleSignIn/{omsConnection}`) and `sign_detached` (a detached CAdES-BES signature over exact bytes), so the cloud can place КМ orders in СУЗ.

**Architecture:** `signer-core` keeps every OS- and network-touching capability behind a trait. The task contract becomes an adjacently tagged enum that mirrors the shared JSON fixtures; the `Signer` trait gains `sign_detached`; the True API module gains `obtain_oms_token`; the runtime dispatches on the task kind and reports either a token body or a signature body. Both Windows backends (CryptoAPI, CAdESCOM) get the detached flag. Host Cargo tests prove the loop with fake signers; Windows behaviour is proven only by the sandbox run in the runbook.

**Tech Stack:** Rust 2021, `serde`/`serde_json`, `reqwest`, `tokio`, `wiremock` (tests), `windows-sys`/`windows` crates behind `#[cfg(windows)]`, Tauri 2 shell unchanged.

**Spec:** `docs/superpowers/specs/2026-09-18-chz-km-orders-design.md`. **Companion:** `docs/superpowers/plans/2026-09-19-chz-km-orders-cloud.md` (part A, Task 4 ships the fixtures this plan parses).

## Global Constraints

- The private key never leaves the customer machine; the agent sends only signatures and tokens (spec «Background»).
- `X-Signature` for СУЗ is a **detached** CMS signature; an attached one is rejected with HTTP 413 (spec «СУЗ facts»). The signed bytes must be exactly the decoded `dataBase64` payload, never re-serialised.
- The СУЗ token lives 10 hours and the response carries no expiry; `expiresAt` is computed as `now + 10 h` in RFC 3339 with offset (spec «Signer agent»).
- Task JSON must parse the shared fixtures in `packages/platform-contracts/fixtures/chz-signer/` byte-for-byte; `deny_unknown_fields` stays on every contract struct. **Retracted in Task 1:** serde does not support `#[serde(flatten)]` under `deny_unknown_fields`, so the outer `SignerTask` envelope drops it. Every payload struct keeps it, which is where unknown keys actually have to be refused.
- Journal entries never include token values or signature bytes (existing redaction rules in `journal.rs`).
- Host Cargo tests (`cargo test --manifest-path apps/signer/Cargo.toml --workspace`) prove the runtime loop and nothing about CryptoAPI, CAdESCOM or a real certificate; say so in the PR (repo AGENTS.md).
- Commit after every task.

## File structure

- `apps/signer/signer-core/src/contracts.rs` — `TaskType`, `TaskKind` (adjacently tagged), `OmsAuthPayload`, `SignDetachedPayload`, `TaskCompleteSignature`.
- `apps/signer/signer-core/src/signer.rs` — `Signer::sign_detached`.
- `apps/signer/signer-core/src/signer_capi.rs` — `sign_with_context(context, payload, detached)`.
- `apps/signer/signer-core/src/signer_cades.rs` — `sign_via_cadescom(…, detached)`.
- `apps/signer/signer-core/src/trueapi.rs` — `obtain_oms_token`.
- `apps/signer/signer-core/src/cloud.rs` — `complete` generic over the body type.
- `apps/signer/signer-core/src/runtime.rs` — dispatch per task kind.
- `apps/signer/src-tauri` — no changes except the version bump in the release task.
- `docs/runbooks/signer-agent-manual-e2e.md` — sandbox steps for the two new tasks.

---

### Task 1: Task contract as an adjacently tagged enum

**Files:**

- Modify: `apps/signer/signer-core/src/contracts.rs:65-92`
- Test: `apps/signer/signer-core/src/contracts.rs` (`mod tests`)

**Interfaces:**

- Produces:

  ```rust
  pub struct OmsAuthPayload { pub true_api_base_url: String, pub oms_connection: String, pub inn: Option<String> }
  pub struct SignDetachedPayload { pub purpose: String, pub order_id: String, pub data_base64: String }
  #[serde(tag = "type", content = "payload", rename_all = "snake_case")]
  pub enum TaskKind { TrueApiAuth(TrueApiAuthPayload), OmsAuth(OmsAuthPayload), SignDetached(SignDetachedPayload) }
  pub struct SignerTask { pub id: String, #[serde(flatten)] pub kind: TaskKind }
  pub struct TaskCompleteSignature { pub signature_base64: String, pub cert_thumbprint: String }
  ```

  `TaskType` is removed; `SignerTask::task_type()` returns `TaskType`-like `&'static str` (`"true_api_auth"` …) for journal text.

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `contracts.rs`:

```rust
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
```

(The existing test that asserts `task.task_type == TaskType::TrueApiAuth` is replaced by `still_parses_the_true_api_auth_fixture`; the existing "future sign_detached" fixture test that expects a deserialisation _error_ is deleted — that future is now.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path apps/signer/Cargo.toml -p signer-core contracts`
Expected: compile error — `TaskKind`, `OmsAuthPayload`, `TaskCompleteSignature` undefined.

- [ ] **Step 3: Implement**

Replace lines 65–92 of `contracts.rs` with:

```rust
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
#[serde(deny_unknown_fields)]
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
```

`#[serde(flatten)]` with `deny_unknown_fields` on the outer struct is not supported by serde; drop `deny_unknown_fields` from `SignerTask` only and keep it on every payload (the payload structs still refuse unknown keys). Fix every `task.payload` / `task.task_type` use in `runtime.rs` to compile (temporary `match` that only handles `TrueApiAuth`; Task 5 completes the dispatch).

- [ ] **Step 4: Run tests**

Run: `cargo test --manifest-path apps/signer/Cargo.toml -p signer-core contracts`
Expected: PASS (all contract tests, including the three fixtures).

- [ ] **Step 5: Commit**

```bash
git add apps/signer/signer-core/src/contracts.rs apps/signer/signer-core/src/runtime.rs
git commit -m "feat(signer): task contract as an adjacently tagged enum with oms_auth and sign_detached"
```

---

### Task 2: `Signer::sign_detached` on the trait and the fakes

**Files:**

- Modify: `apps/signer/signer-core/src/signer.rs:21-29`
- Modify: fake signers in `runtime.rs` (`NoSigner`, `PayloadSigner`) and `trueapi.rs` (`FakeSigner`, `FailingSigner`, `PayloadSigner`)
- Test: `apps/signer/signer-core/src/signer.rs` (`mod tests`)

**Interfaces:**

- Produces: `fn sign_detached(&self, thumbprint: &str, payload: &[u8]) -> Result<String, SignerError>` on `Signer` (base64 of a detached CMS).

- [ ] **Step 1: Write the failing test**

```rust
    struct RecordingSigner(std::sync::Mutex<Vec<(bool, Vec<u8>)>>);
    impl Signer for RecordingSigner {
        fn list_certificates(&self) -> Result<Vec<CertificateSummary>, SignerError> { Ok(vec![]) }
        fn sign_attached(&self, _t: &str, payload: &[u8]) -> Result<String, SignerError> {
            self.0.lock().unwrap().push((false, payload.to_vec()));
            Ok("attached".into())
        }
        fn sign_detached(&self, _t: &str, payload: &[u8]) -> Result<String, SignerError> {
            self.0.lock().unwrap().push((true, payload.to_vec()));
            Ok("detached".into())
        }
    }

    #[test]
    fn the_trait_distinguishes_detached_from_attached() {
        let signer = RecordingSigner(std::sync::Mutex::new(vec![]));
        assert_eq!(signer.sign_detached("AB", b"body").unwrap(), "detached");
        assert_eq!(signer.sign_attached("AB", b"challenge").unwrap(), "attached");
        assert_eq!(*signer.0.lock().unwrap(), vec![(true, b"body".to_vec()), (false, b"challenge".to_vec())]);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path apps/signer/Cargo.toml -p signer-core signer::tests`
Expected: compile error — `sign_detached` is not a member of trait `Signer`.

- [ ] **Step 3: Implement**

Add to the trait:

```rust
    /// Detached (CMS without content) signature over `payload`, base64 — the
    /// form СУЗ expects in `X-Signature`. The bytes are signed exactly as given.
    fn sign_detached(&self, thumbprint: &str, payload: &[u8]) -> Result<String, SignerError>;
```

Give every fake in `runtime.rs` and `trueapi.rs` tests a `sign_detached` that mirrors its `sign_attached` (e.g. `PayloadSigner` returns `format!("detached-{}", String::from_utf8_lossy(payload))`, `NoSigner`/`FailingSigner` return the same error as their attached path).

- [ ] **Step 4: Run tests**

Run: `cargo test --manifest-path apps/signer/Cargo.toml -p signer-core`
Expected: PASS on the host (Windows backends do not compile here; Task 3 keeps them consistent).

- [ ] **Step 5: Commit**

```bash
git add apps/signer/signer-core/src/signer.rs apps/signer/signer-core/src/runtime.rs apps/signer/signer-core/src/trueapi.rs
git commit -m "feat(signer): sign_detached on the Signer trait and test fakes"
```

---

### Task 3: Detached mode in the CryptoAPI and CAdESCOM backends

**Files:**

- Modify: `apps/signer/signer-core/src/signer_capi.rs:58-95, 236-300`
- Modify: `apps/signer/signer-core/src/signer_cades.rs:20-60, 120-160`

**Interfaces:**

- Consumes: `CryptSignMessage(pSignPara, fDetachedSignature, …)` (second argument), CAdESCOM `SignedData.SignCades(Signer, CADES_BES, bDetached)` (the boolean already passed as `false`).
- Produces: `CapiSigner::sign_detached`, `CadesSigner::sign_detached`.

- [ ] **Step 1: Write the host-checkable test**

No host test can exercise Win32; instead add a unit test in `signer_backend.rs` (host-built) that pins the contract both backends must satisfy through a shared helper: in `strip_base64_line_breaks` tests, an assertion that a CAdESCOM-style wrapped signature normalises to one line (already present — keep). The real verification is the Windows sandbox run (runbook, Task 6).

**Retracted after review:** this step also asked for a
`pub const DETACHED_SIGNATURE_IS_SINGLE_LINE_BASE64: bool = true;` as documentation of that contract. It was written, referenced by nothing, and removed again: a constant cannot enforce the guarantee its doc comment asserted. `strip_base64_line_breaks` and its test are the whole of the host-side contract.

- [ ] **Step 2: Implement CryptoAPI**

In `signer_capi.rs` change `unsafe fn sign_with_context(context, payload)` to `unsafe fn sign_with_context(context: *mut CERT_CONTEXT, payload: &[u8], detached: bool)` and pass `detached as i32` (`BOOL`) as `CryptSignMessage`'s second argument in **both** calls (size query and fill). Replace the comment «fDetachedSignature = FALSE: True API wants the challenge embedded» with «attached for the True API challenge, detached for СУЗ's `X-Signature`». Implement:

```rust
    fn sign_attached(&self, thumbprint: &str, payload: &[u8]) -> Result<String, SignerError> {
        self.sign(thumbprint, payload, false)
    }

    fn sign_detached(&self, thumbprint: &str, payload: &[u8]) -> Result<String, SignerError> {
        self.sign(thumbprint, payload, true)
    }
```

with the previous body of `sign_attached` moved into `fn sign(&self, thumbprint: &str, payload: &[u8], detached: bool)` and the `sign_with_context(context, payload, detached)` call.

- [ ] **Step 3: Implement CAdESCOM**

In `signer_cades.rs` thread a `detached: bool` through `sign_via_cadescom(store, signer, signed_data, thumbprint, payload, detached)` and pass `VARIANT::from(detached)` instead of `VARIANT::from(false)` in the `SignCades` argument list (arguments are right-to-left: `[bDetached, CadesType, Signer]`). `sign_attached` calls it with `false`, `sign_detached` with `true`; keep `strip_base64_line_breaks` on both.

- [ ] **Step 4: Cross-compile check (best effort on the host)**

Run: `cargo check --manifest-path apps/signer/Cargo.toml -p signer-core --target x86_64-pc-windows-msvc` (if the target is installed; otherwise rely on the `signer-windows-build` CI job and say so). Then `cargo test --manifest-path apps/signer/Cargo.toml --workspace`.
Expected: host tests PASS; Windows build green in CI.

- [ ] **Step 5: Commit**

```bash
git add apps/signer/signer-core/src/signer_capi.rs apps/signer/signer-core/src/signer_cades.rs apps/signer/signer-core/src/signer_backend.rs
git commit -m "feat(signer): detached CAdES-BES in the CryptoAPI and CAdESCOM backends"
```

---

### Task 4: `obtain_oms_token` in the True API module

**Files:**

- Modify: `apps/signer/signer-core/src/trueapi.rs`
- Test: `apps/signer/signer-core/src/trueapi.rs` (`mod tests`)

**Interfaces:**

- Produces: `pub async fn obtain_oms_token(http, base_url, oms_connection: &str, inn: Option<&str>, thumbprint, signer) -> Result<TrueApiToken, SignerError>`; the token's `expires_at` = now + 10 h via `format_rfc3339`.

- [ ] **Step 1: Write the failing test**

```rust
    #[tokio::test]
    async fn obtains_a_suz_client_token_through_the_oms_connection_route() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/auth/key"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"uuid":"u1","data":"challenge"}"#))
            .mount(&server).await;
        Mock::given(method("POST")).and(path("/auth/simpleSignIn/11b1abc1-f1ee-11db-1a11-f11ac11111e1"))
            .and(body_json(serde_json::json!({"uuid":"u1","data":"signed-challenge"})))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"token":"2f2222c2-cbc2-22ff-bc2c-2222222fbef2"}"#))
            .mount(&server).await;
        let http = reqwest::Client::new();
        let token = obtain_oms_token(&http, &server.uri(), "11b1abc1-f1ee-11db-1a11-f11ac11111e1", None, "AB", &PayloadSigner).await.unwrap();
        assert_eq!(token.token, "2f2222c2-cbc2-22ff-bc2c-2222222fbef2");
        let expires = token.expires_at.clone();
        assert!(expires.ends_with("+00:00") || expires.ends_with('Z'));
        let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs();
        assert_eq!(&expires[..13], &format_rfc3339_public(now + 10 * 3600)[..13]);
    }

    #[tokio::test]
    async fn passes_the_mchd_inn_to_the_oms_route() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/auth/key"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"uuid":"u1","data":"c"}"#)).mount(&server).await;
        Mock::given(method("POST")).and(path("/auth/simpleSignIn/11b1abc1-f1ee-11db-1a11-f11ac11111e1"))
            .and(body_json(serde_json::json!({"uuid":"u1","data":"signed-c","inn":"7712345678"})))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"token":"t"}"#)).mount(&server).await;
        let token = obtain_oms_token(&reqwest::Client::new(), &server.uri(), "11b1abc1-f1ee-11db-1a11-f11ac11111e1", Some("7712345678"), "AB", &PayloadSigner).await.unwrap();
        assert_eq!(token.token, "t");
    }
```

(`PayloadSigner` in this module signs as `signed-{payload}`; `body_json` requires the `SignInRequest` to omit `unitedToken` for this route.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path apps/signer/Cargo.toml -p signer-core trueapi::tests::obtains_a_suz`
Expected: compile error — `obtain_oms_token` undefined.

- [ ] **Step 3: Implement**

```rust
/// СУЗ client token: same challenge as True API, posted to the per-installation
/// route. The response is `{"token": "<uuid>"}` with no expiry; СУЗ documents a
/// 10-hour lifetime, so the expiry is computed here.
pub async fn obtain_oms_token(
    http: &reqwest::Client,
    base_url: &str,
    oms_connection: &str,
    inn: Option<&str>,
    thumbprint: &str,
    signer: &dyn Signer,
) -> Result<TrueApiToken, SignerError> {
    let mut attempt = 1u32;
    loop {
        let outcome = obtain_oms_token_once(http, base_url, oms_connection, inn, thumbprint, signer).await;
        match outcome {
            Err(SignerError::Network(_)) if attempt < AUTH_ATTEMPTS => {
                tokio::time::sleep(Duration::from_secs(2u64.saturating_pow(attempt))).await;
                attempt += 1;
            }
            outcome => return outcome,
        }
    }
}

const OMS_TOKEN_TTL_SECS: u64 = 10 * 3600;

async fn obtain_oms_token_once(
    http: &reqwest::Client,
    base_url: &str,
    oms_connection: &str,
    inn: Option<&str>,
    thumbprint: &str,
    signer: &dyn Signer,
) -> Result<TrueApiToken, SignerError> {
    let base = base_url.trim_end_matches('/');
    let key_response = http.get(format!("{base}/auth/key")).timeout(AUTH_TIMEOUT).send().await
        .map_err(|e| SignerError::Network(e.to_string()))?;
    if !key_response.status().is_success() {
        return Err(classify_response(key_response).await);
    }
    let challenge: AuthKeyResponse = key_response.json().await.map_err(classify_json_error)?;
    let signature = signer.sign_attached(thumbprint, challenge.data.as_bytes())?;
    let sign_in_response = http
        .post(format!("{base}/auth/simpleSignIn/{oms_connection}"))
        .timeout(AUTH_TIMEOUT)
        .json(&SignInRequest { uuid: &challenge.uuid, data: &signature, inn, united_token: None })
        .send().await
        .map_err(|e| SignerError::Network(e.to_string()))?;
    if !sign_in_response.status().is_success() {
        return Err(classify_response(sign_in_response).await);
    }
    let issued: SignInResponse = sign_in_response.json().await.map_err(classify_json_error)?;
    let token = required_field(issued.token, "token")?;
    let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs();
    Ok(TrueApiToken { token, expires_at: format_rfc3339(now + OMS_TOKEN_TTL_SECS) })
}
```

- [ ] **Step 4: Run tests**

Run: `cargo test --manifest-path apps/signer/Cargo.toml -p signer-core trueapi`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/signer/signer-core/src/trueapi.rs
git commit -m "feat(signer): obtain a СУЗ client token through simpleSignIn/{omsConnection}"
```

---

### Task 5: Runtime dispatch per task kind and generic completion

**Files:**

- Modify: `apps/signer/signer-core/src/cloud.rs:115-131`
- Modify: `apps/signer/signer-core/src/runtime.rs:453-580`
- Test: `apps/signer/signer-core/src/runtime.rs` (`mod tests`)

**Interfaces:**

- Produces: `CloudClient::complete<B: Serialize + ?Sized>(&self, secret, task_id, body: &B)`; runtime `execute` handling `TaskKind::TrueApiAuth` (unchanged), `TaskKind::OmsAuth` (calls `obtain_oms_token`, reports `TaskComplete`), `TaskKind::SignDetached` (decodes base64, `signer.sign_detached`, reports `TaskCompleteSignature`); journal lines «СУЗ token delivered», «Detached signature delivered», «Signing failed».

- [ ] **Step 1: Write the failing tests**

Add to `runtime.rs` tests (the module already has wiremock helpers and `test_runtime()`; build a runtime with `PayloadSigner` and a config file holding `cert_thumbprint = "AB"`, server URL = mock, secret protected by `PlainStore`):

```rust
    #[tokio::test]
    async fn a_sign_detached_task_reports_the_detached_signature_over_the_exact_bytes() {
        let server = MockServer::start().await;
        Mock::given(method("POST")).and(path("/signer-agent/tasks/3f0e0f5e-8d1c-4d7a-9b1a-222222222222/complete"))
            .and(body_json(serde_json::json!({
                // `Signer::sign_detached` already returns base64; the runtime forwards
                // that string verbatim and must never re-encode it. The fake returns
                // `format!("detached-{payload}")`, so this is the literal expected.
                "signatureBase64": "detached-{\"productGroup\":\"beer\"}",
                "certThumbprint": "AB"
            })))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server).await;
        let (_dir, runtime) = test_runtime_with(PayloadSigner, &server.uri(), "AB");
        let task: SignerTask = serde_json::from_str(&fixture("task-sign-detached.json")).unwrap();
        let client = CloudClient::new(&server.uri(), "0.1.0").unwrap();
        runtime.execute(&client, "secret", &task, &|_| {}).await;
        assert!(runtime.status().journal.iter().any(|e| e.message == "Detached signature delivered"));
    }

    #[tokio::test]
    async fn an_oms_auth_task_reports_a_ten_hour_token() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/auth/key"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"uuid":"u1","data":"c"}"#)).mount(&server).await;
        Mock::given(method("POST")).and(path("/auth/simpleSignIn/11b1abc1-f1ee-11db-1a11-f11ac11111e1"))
            .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"token":"tok"}"#)).mount(&server).await;
        Mock::given(method("POST")).and(path("/signer-agent/tasks/6d2a1b7e-4c1f-4b7e-9c3a-1a2b3c4d5e6f/complete"))
            .respond_with(ResponseTemplate::new(204)).expect(1).mount(&server).await;
        let (_dir, runtime) = test_runtime_with(PayloadSigner, &server.uri(), "AB");
        let mut task: SignerTask = serde_json::from_str(&fixture("task-oms-auth.json")).unwrap();
        if let TaskKind::OmsAuth(payload) = &mut task.kind { payload.true_api_base_url = server.uri(); }
        let client = CloudClient::new(&server.uri(), "0.1.0").unwrap();
        runtime.execute(&client, "secret", &task, &|_| {}).await;
        let received = server.received_requests().await.unwrap();
        let complete = received.iter().find(|r| r.url.path().ends_with("/complete")).unwrap();
        let body: serde_json::Value = serde_json::from_slice(&complete.body).unwrap();
        assert_eq!(body["token"], "tok");
        assert_eq!(body["certThumbprint"], "AB");
        assert!(body["expiresAt"].as_str().unwrap().len() >= 20);
    }

    #[tokio::test]
    async fn a_sign_detached_task_with_bad_base64_is_failed_not_signed() {
        let server = MockServer::start().await;
        Mock::given(method("POST")).and(path("/signer-agent/tasks/t1/fail"))
            .and(body_json_string(r#"{"errorCode":"TRUE_API","message":"sign_detached payload is not valid base64"}"#))
            .respond_with(ResponseTemplate::new(204)).expect(1).mount(&server).await;
        let (_dir, runtime) = test_runtime_with(PayloadSigner, &server.uri(), "AB");
        let task = SignerTask { id: "t1".into(), kind: TaskKind::SignDetached(SignDetachedPayload { purpose: "oms_order".into(), order_id: "o".into(), data_base64: "***".into() }) };
        let client = CloudClient::new(&server.uri(), "0.1.0").unwrap();
        runtime.execute(&client, "secret", &task, &|_| {}).await;
    }
```

`test_runtime_with(signer, server_url, thumbprint)` writes `AgentConfig { server_url: Some(url), cert_thumbprint: Some(thumbprint), .. }` with `storage::write_config` before constructing the runtime; `fixture` reads from the shared contracts folder like `contracts.rs` does. Make `execute` `pub(crate)` for the tests.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path apps/signer/Cargo.toml -p signer-core runtime::tests::a_sign_detached`
Expected: compile error (`complete` takes `&TaskComplete`) or the temporary `match` panics on non-`TrueApiAuth` kinds.

- [ ] **Step 3: Implement**

`cloud.rs`:

```rust
    pub async fn complete<B: serde::Serialize + ?Sized>(&self, secret: &str, task_id: &str, body: &B) -> Result<(), SignerError> {
        self.report(secret, &format!("/signer-agent/tasks/{task_id}/complete"), body).await
    }
```

(`report` is already generic or takes `&impl Serialize`; make it `B: Serialize + ?Sized` too.)

`runtime.rs` — restructure `execute` around the task kind after the certificate lookup:

```rust
        let outcome: Result<CompletionBody, SignerError> = match &task.kind {
            TaskKind::TrueApiAuth(payload) => obtain_token(&self.http, &payload.true_api_base_url, payload.inn.as_deref(), payload.token_format, &thumbprint, self.signer.as_ref())
                .await
                .map(|token| CompletionBody::Token(token_body(token, &thumbprint, certificate.as_ref()))),
            TaskKind::OmsAuth(payload) => obtain_oms_token(&self.http, &payload.true_api_base_url, &payload.oms_connection, payload.inn.as_deref(), &thumbprint, self.signer.as_ref())
                .await
                .map(|token| CompletionBody::Token(token_body(token, &thumbprint, certificate.as_ref()))),
            TaskKind::SignDetached(payload) => {
                base64::engine::general_purpose::STANDARD
                    .decode(&payload.data_base64)
                    .map_err(|_| SignerError::TrueApi("sign_detached payload is not valid base64".into()))
                    .and_then(|bytes| self.signer.sign_detached(&thumbprint, &bytes))
                    .map(|signature_base64| CompletionBody::Signature(TaskCompleteSignature { signature_base64, cert_thumbprint: thumbprint.clone() }))
            }
        };
```

with

```rust
enum CompletionBody { Token(TaskComplete), Signature(TaskCompleteSignature) }

fn token_body(token: TrueApiToken, thumbprint: &str, certificate: Option<&CertificateSummary>) -> TaskComplete {
    TaskComplete {
        token: token.token,
        expires_at: token.expires_at,
        cert_thumbprint: thumbprint.to_string(),
        cert_subject: certificate.map(|c| cap_cert_subject(&c.subject)),
        cert_inn: certificate.and_then(|c| c.inn.clone()),
        cert_not_after: certificate.map(|c| c.not_after.clone()),
    }
}
```

The bounded retry loop around `client.complete` stays; call it as `client.complete(secret, &task.id, &body_json)` where `body_json` is `serde_json::Value` built from either variant (or match once and call the generic `complete` with `&TaskComplete` / `&TaskCompleteSignature`). On success journal per kind: «True API token delivered» (and `set_last_token_expires_at`), «СУЗ token delivered», «Detached signature delivered» (no expiry update). On error the existing `classify` → `fail_with_retry` path applies to all kinds (`SignerError::TrueApi` maps to `TRUE_API`, which is what the base64 test expects).

- [ ] **Step 4: Run the workspace tests**

Run: `cargo test --manifest-path apps/signer/Cargo.toml --workspace`
Expected: PASS. Also `cargo clippy --manifest-path apps/signer/Cargo.toml --workspace -- -D warnings` if the repo runs clippy in CI (check `.github/workflows/ci.yml` for the signer job).

- [ ] **Step 5: Commit**

```bash
git add apps/signer/signer-core/src/cloud.rs apps/signer/signer-core/src/runtime.rs
git commit -m "feat(signer): execute oms_auth and sign_detached tasks"
```

---

### Task 6: Runbook for the СУЗ sandbox run

**Files:**

- Modify: `docs/runbooks/signer-agent-manual-e2e.md`

**No version bump.** `docs/runbooks/signer-release.md` is explicit that the release
workflow computes the version from the selected `bump` at dispatch time and injects it
into the build "without committing a version-only PR", and that `tauri.conf.json`'s
version is a development value rather than the stable one. There is therefore nothing to
bump here; the earlier draft of this plan said otherwise and was wrong.

- [ ] **Step 1: Write the runbook section**

Add a section «СУЗ: token and detached signature (sandbox)» to
`docs/runbooks/signer-agent-manual-e2e.md`, after the existing True API sandbox steps and
in the same voice. It must let an operator who has never seen this feature carry out the
run and come back with answers. Cover, in order:

1. Pair the agent with a sandbox tenant (point at the existing steps rather than
   repeating them).
2. Register an installation for Markiro. Either register it in the СУЗ sandbox cabinet,
   or call `POST https://suz-integrator.sandbox.crptech.ru/api/v3/integration/connection?omsId={omsId}`
   with the header `X-RegistrationKey: 4344d884-7f21-456c-981e-cd68e92391e8` (the public
   sandbox registration key) and a detached signature of the body in `X-Signature`. Record
   the returned `omsConnection`.
3. Enter `omsId` and `omsConnection` in the cabinet's Chestny ZNAK channel settings.
4. Wait for the scheduler's `oms_auth` task. Confirm «СУЗ token delivered» in the agent's
   journal and the СУЗ token row in the cabinet's signer panel.
5. Place a two-code order. Confirm «Detached signature delivered» in the journal, then
   that the order reaches «Буфер активен» and the codes arrive.
6. Repeat step 5 with `MARKIRO_SIGNER_BACKEND=cades` to exercise the CAdESCOM backend.

Then a «What to record» list, because this run is the only evidence that exists for code
no test can reach:

- the exact response body of `POST /auth/simpleSignIn/{omsConnection}` — whether it is
  only `{"token": …}` as documented, and whether any expiry field accompanies it;
- whether СУЗ accepted the CryptoAPI detached signature, and separately the CAdESCOM one;
- any HTTP 413, which means an attached signature reached `X-Signature`;
- the real shapes of `POST /order`, `GET /order/status` and `GET /codes`, including
  whether a rejected order's `rejectionReason` matches what the cabinet displays;
- whether `GET /codes` honours a 10 000-code block size.

Close with the standing caveat that a green host-only `cargo test` proves the runtime loop
and nothing about CryptoAPI, DPAPI, CAdESCOM or a real certificate.

- [ ] **Step 2: Verify**

Run: `pnpm exec prettier --check docs/runbooks/signer-agent-manual-e2e.md`
Expected: passes. There is no code to test.

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/signer-agent-manual-e2e.md
git commit -m "docs(signer): sandbox runbook for the СУЗ token and detached signature"
```

## Self-review

**Spec coverage.** `oms_auth` (Tasks 1, 4, 5), `sign_detached` with detached CryptoAPI/CAdESCOM (Tasks 2, 3, 5), fixtures parity with the TS contracts (Task 1 reads the files part A Task 4 adds), journal wording without secrets (Task 5), release path (Task 6). The spec's "host tests assert the detached flag" is met by the trait-level recording test (Task 2) and the runtime test asserting the reported signature is over the exact decoded bytes (Task 5); the Win32 flag itself is only verifiable on Windows (Task 6 runbook).

**Placeholder scan.** None.

**Type consistency.** `TaskKind::SignDetached(SignDetachedPayload)` (Task 1) is matched in Task 5; `Signer::sign_detached` (Task 2) is called in Task 5 and implemented in Task 3; `TaskCompleteSignature` field names match the TS `chzSignerSignatureCompleteSchema` (`signatureBase64`, `certThumbprint`) via `rename_all = "camelCase"`; `obtain_oms_token`'s signature (Task 4) is what Task 5 calls.
