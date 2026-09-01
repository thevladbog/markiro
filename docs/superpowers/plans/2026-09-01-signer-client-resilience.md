# Signer Client Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give operators an explicit update check, suppress polling outage alerts for five minutes, and expose quiet, readable runtime state through a badged Windows tray icon.

**Architecture:** `signer-core` owns a monotonic polling-incident state machine and emits durable phases. React owns update-check presentation but shares one in-flight updater request between background and manual triggers. A focused Tauri tray controller maps phases to tooltips and dynamically composites a small colored badge over the existing icon; only bounded work uses animation, and notification delivery is transition-gated.

**Tech Stack:** Rust, Tokio, reqwest, Tauri 2 tray and notification APIs, React 19, Vitest, i18next, `@markiro/ui`.

**Spec:** `docs/superpowers/specs/2026-09-01-signer-release-resilience-design.md`

## Global Constraints

- Update installation and relaunch require an explicit operator button press.
- Background checks remain quiet on failure; manual checks show current, available, and failed results.
- Only one updater check may run at a time.
- The five-minute grace applies only to polling network and server-availability failures.
- Revocation, local credential, protocol, certificate, signing, True API, and report errors remain immediate.
- Poll retry backoff remains two seconds through a sixty-second cap.
- A polling incident uses monotonic time and ends only after a successful poll response.
- Notifications are emitted once per incident and reset after recovery.
- The base tray icon remains recognizable; color is a small lower-right badge and status is repeated in the tooltip.
- Persistent states do not animate; only signing and update installation pulse gently.
- Windows tray rendering, DPAPI, CryptoAPI, updater installation, and relaunch require separate Windows acceptance.

---

### Task 1: Classify transient poll failures

**Files:**

- Modify: `apps/signer/signer-core/src/cloud.rs`

**Interfaces:**

- Produces: `CloudClient::poll` maps network failures and HTTP 5xx responses to `SignerError::Network`, 401 to `Revoked`, malformed success bodies to `Protocol`, and other non-success responses to `Protocol`.

- [ ] **Step 1: Add focused tests for poll 503 and malformed 200 behavior.**

```rust
#[tokio::test]
async fn poll_treats_server_unavailability_as_network() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/signer-agent/tasks/next"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;
    let client = CloudClient::new(&server.uri(), "0.1.5").unwrap();
    assert!(matches!(client.poll("secret", 0).await, Err(SignerError::Network(_))));
}

#[tokio::test]
async fn poll_keeps_a_malformed_success_as_protocol() {
    // A server contract break requires immediate attention and is not a
    // connectivity incident.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/signer-agent/tasks/next"))
        .respond_with(ResponseTemplate::new(200).set_body_string("not-json"))
        .mount(&server)
        .await;
    let client = CloudClient::new(&server.uri(), "0.1.5").unwrap();
    assert!(matches!(client.poll("secret", 0).await, Err(SignerError::Protocol(_))));
}
```

- [ ] **Step 2: Run the focused Cargo test and confirm the 503 assertion fails.**

Run: `cargo test --manifest-path apps/signer/Cargo.toml --workspace cloud::tests::poll_`

Expected: the 503 test fails because it is currently `Protocol`.

- [ ] **Step 3: Add the 5xx branch before the generic non-success branch.**

```rust
status if status.is_server_error() => {
    Err(SignerError::Network(format!("poll answered {status}")))
}
```

- [ ] **Step 4: Re-run the focused Cargo test.**

Run: `cargo test --manifest-path apps/signer/Cargo.toml --workspace cloud::tests::poll_`

Expected: PASS.

- [ ] **Step 5: Commit transient poll classification.**

```bash
git add apps/signer/signer-core/src/cloud.rs
git commit -m "fix(signer): classify poll outages as transient"
```

---

### Task 2: Five-minute monotonic polling incident state machine

**Files:**

- Modify: `apps/signer/signer-core/src/runtime.rs`

**Interfaces:**

- Extends `AgentPhase` with `Reconnecting` and `Unavailable`.
- Adds `app_version: String` to `AgentStatus`.
- Produces private `PollIncident::failure(now: Instant) -> PollTransition` and `PollIncident::recover(now: Instant) -> Option<PollRecovery>`.
- `PollTransition` is `Started`, `Retrying`, or `BecameUnavailable`.

- [ ] **Step 1: Add pure state-machine tests using synthetic `Instant` values.**

```rust
#[test]
fn poll_incident_crosses_the_threshold_once_and_recovers() {
    let start = Instant::now();
    let mut incident = PollIncident::default();
    assert_eq!(incident.failure(start), PollTransition::Started);
    assert_eq!(
        incident.failure(start + Duration::from_secs(299)),
        PollTransition::Retrying
    );
    assert_eq!(
        incident.failure(start + Duration::from_secs(300)),
        PollTransition::BecameUnavailable
    );
    assert_eq!(
        incident.failure(start + Duration::from_secs(360)),
        PollTransition::Retrying
    );
    let recovery = incident.recover(start + Duration::from_secs(361)).unwrap();
    assert_eq!(recovery.attempts, 4);
    assert_eq!(recovery.duration, Duration::from_secs(361));
}
```

Add a test proving `status()` returns a stored reconnecting phase and the runtime version rather than reconstructing idle.

- [ ] **Step 2: Run focused runtime tests and confirm the new types and phases are absent.**

Run: `cargo test --manifest-path apps/signer/Cargo.toml --workspace runtime::tests::poll_incident`

Expected: FAIL to compile.

- [ ] **Step 3: Implement the state machine and durable runtime phase.**

```rust
const POLL_OUTAGE_GRACE: Duration = Duration::from_secs(5 * 60);

#[derive(Default)]
struct PollIncident {
    started_at: Option<Instant>,
    attempts: u32,
    unavailable_emitted: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum PollTransition { Started, Retrying, BecameUnavailable }
```

Add `phase: Mutex<AgentPhase>` to `Runtime`, make `status()` read it, and centralize phase changes through a setter. Pairing and unpairing set the expected phase explicitly.

- [ ] **Step 4: Replace immediate polling degradation with transition behavior.**

```rust
match incident.failure(Instant::now()) {
    PollTransition::Started => {
        self.note("Connection interrupted; reconnecting", None);
        self.set_last_error(None);
        self.set_phase(AgentPhase::Reconnecting);
        on_change(self.status());
    }
    PollTransition::BecameUnavailable => {
        self.note("Connection unavailable for five minutes", Some(&error.to_string()));
        self.set_last_error(Some(error.to_string()));
        self.set_phase(AgentPhase::Unavailable);
        on_change(self.status());
    }
    PollTransition::Retrying => {}
}
```

On both `Ok(None)` and `Ok(Some(task))`, recover the incident before normal handling. Journal one recovery entry containing rounded duration and attempt count, clear the transport error, and emit the healthy/working status. Non-network poll errors still enter `Degraded` immediately.

- [ ] **Step 5: Run all `signer-core` tests.**

Run: `cargo test --manifest-path apps/signer/Cargo.toml --workspace`

Expected: PASS on the host; this does not prove Windows CryptoAPI or DPAPI behavior.

- [ ] **Step 6: Commit the incident model.**

```bash
git add apps/signer/signer-core/src/runtime.rs
git commit -m "feat(signer): grace transient polling outages"
```

---

### Task 3: Explicit and coalesced update checks

**Files:**

- Modify: `apps/signer/src/lib/updates.ts`
- Create: `apps/signer/src/components/UpdateControl.tsx`
- Modify: `apps/signer/src/components/UpdateBanner.tsx`
- Modify: `apps/signer/src/App.tsx`
- Modify: `apps/signer/src/pages/Status.tsx`
- Modify: `apps/signer/src/lib/bridge.ts`
- Modify: `apps/signer/src/i18n/ru.json`
- Modify: `apps/signer/src/i18n/en.json`
- Modify: `apps/signer/src/signer.css`
- Modify: `apps/signer/test/updates.test.tsx`
- Modify: `apps/signer/test/status-journal.test.tsx`

**Interfaces:**

- `UpdateCheckResult = { kind: "current" } | { kind: "available"; update: SignerUpdate } | { kind: "failed" }`.
- `checkForUpdate(): Promise<UpdateCheckResult>` shares one in-flight promise.
- `UpdateControl` consumes installed version, manual check state, and an `onCheck` callback.
- `Status` receives `updateCheck` and `onCheckForUpdate` props.

- [ ] **Step 1: Replace nullable update tests with the discriminated result and add coalescing coverage.**

```ts
it("coalesces concurrent checks", async () => {
  let resolve!: (value: null) => void;
  checkMock.mockReturnValue(new Promise((done) => (resolve = done)));
  const first = checkForUpdate();
  const second = checkForUpdate();
  expect(checkMock).toHaveBeenCalledTimes(1);
  resolve(null);
  await expect(Promise.all([first, second])).resolves.toEqual([
    { kind: "current" },
    { kind: "current" },
  ]);
});
```

Add component tests for `Проверяем…`, current, failed/retry, available, and no installation before the separate install press.

- [ ] **Step 2: Run the focused frontend test.**

Run: `pnpm --filter @markiro/signer exec vitest run test/updates.test.tsx test/status-journal.test.tsx`

Expected: FAIL on the old nullable API and missing manual control.

- [ ] **Step 3: Implement one in-flight updater request.**

```ts
let activeCheck: Promise<UpdateCheckResult> | null = null;

export function checkForUpdate(): Promise<UpdateCheckResult> {
  if (activeCheck) return activeCheck;
  activeCheck = runCheck().finally(() => {
    activeCheck = null;
  });
  return activeCheck;
}
```

`runCheck` maps updater `null` to `current`, a found update to `available`, and a caught exception to `failed` after logging a warning.

- [ ] **Step 4: Wire background and manual presentation separately.**

Background checks in `App` react only to `available`; they do not render `failed`. Manual checks set `checking`, then retain `current`, `failed`, or `available` until the next press. Both paths use the same `checkForUpdate()` function.

`UpdateControl` renders the installed `status.appVersion`, button, and compact result text. `UpdateBanner` retains the separate install confirmation and retryable failure behavior.

- [ ] **Step 5: Add Russian and English strings and compact styles.**

Required Russian labels:

```json
{
  "currentVersion": "Версия {{version}}",
  "check": "Проверить обновления",
  "checking": "Проверяем…",
  "current": "Установлена актуальная версия",
  "failed": "Не удалось проверить обновления",
  "retry": "Повторить"
}
```

Add equivalent English strings under the same keys.

- [ ] **Step 6: Run Signer frontend tests, typecheck, lint, and build.**

Run: `pnpm --filter @markiro/signer test`

Run: `pnpm --filter @markiro/signer typecheck`

Run: `pnpm --filter @markiro/signer lint`

Run: `pnpm --filter @markiro/signer build`

Expected: PASS.

- [ ] **Step 7: Commit manual update checking.**

```bash
git add apps/signer/src apps/signer/test
git commit -m "feat(signer): add explicit update checks"
```

---

### Task 4: Tray badge composition and state mapping

**Files:**

- Create: `apps/signer/src-tauri/src/tray.rs`
- Modify: `apps/signer/src-tauri/src/lib.rs`

**Interfaces:**

- Produces `TrayVisualState`: `Unpaired`, `Healthy`, `Working`, `Reconnecting`, `Unavailable`, `Updating`.
- Produces `visual_state(phase: AgentPhase, updating: bool) -> TrayVisualState`.
- Produces `tooltip(state) -> &'static str`.
- Produces `badge_icon(base: &Image, state, pulse_frame) -> Image<'static>` by copying RGBA bytes and drawing a lower-right outlined circle.
- Produces `TrayController::apply_status(status)` and `TrayController::set_updating(bool)`.

- [ ] **Step 1: Add pure mapping, tooltip, and pixel-bound tests in `tray.rs`.**

```rust
#[test]
fn maps_runtime_phases_without_color_only_meaning() {
    assert_eq!(visual_state(AgentPhase::Idle, false), TrayVisualState::Healthy);
    assert_eq!(visual_state(AgentPhase::Reconnecting, false), TrayVisualState::Reconnecting);
    assert_eq!(visual_state(AgentPhase::Unavailable, false), TrayVisualState::Unavailable);
    assert_eq!(tooltip(TrayVisualState::Unavailable), "Markiro Подписант — нет связи");
}

#[test]
fn updating_overrides_the_idle_visual() {
    assert_eq!(visual_state(AgentPhase::Idle, true), TrayVisualState::Updating);
}
```

The pixel test uses a synthetic 32×32 opaque base and asserts that only the bounded lower-right badge rectangle changes.

- [ ] **Step 2: Run the focused Rust tests and confirm the module is absent.**

Run: `cargo test --manifest-path apps/signer/Cargo.toml --workspace tray::tests`

Expected: FAIL until `mod tray` and its implementation exist.

- [ ] **Step 3: Implement badge composition without a new image dependency.**

Copy `Image::rgba()` into an owned buffer and draw:

- a one-pixel dark outline circle;
- gray, green, blue, yellow, or red fill;
- two blue radii for pulse frames, toggled every 800 ms only in `Working` or `Updating`.

Use `Image::new_owned(rgba, width, height)` for the generated icon. Keep badge geometry proportional so 16/20/24/32-pixel taskbar rendering remains legible after Windows scaling.

- [ ] **Step 4: Retain the built tray handle and drive state changes.**

Build the tray with a stable ID, store `TrayController` in Tauri managed state, and call `apply_status` before emitting `signer://status`. Spawn one 800 ms Tokio interval that toggles frames only when the current visual state is animated; static states do not call `set_icon` repeatedly.

- [ ] **Step 5: Run Cargo tests and formatting.**

Run: `cargo fmt --manifest-path apps/signer/Cargo.toml --all -- --check`

Run: `cargo test --manifest-path apps/signer/Cargo.toml --workspace`

Expected: PASS on the host; Windows tray rendering remains an external gate.

- [ ] **Step 6: Commit the tray state controller.**

```bash
git add apps/signer/src-tauri/src/tray.rs apps/signer/src-tauri/src/lib.rs
git commit -m "feat(signer): show runtime state in tray badge"
```

---

### Task 5: Transition-gated notifications and update activity

**Files:**

- Modify: `apps/signer/src-tauri/src/tray.rs`
- Modify: `apps/signer/src-tauri/src/lib.rs`
- Modify: `apps/signer/src-tauri/src/commands.rs`
- Modify: `apps/signer/src/lib/bridge.ts`
- Modify: `apps/signer/src/components/UpdateBanner.tsx`
- Modify: `apps/signer/test/updates.test.tsx`

**Interfaces:**

- Adds `AlertKey`: `Unavailable` or `Actionable(String)`.
- Produces `NotificationGate::observe(status) -> Option<String>`.
- Adds Tauri command `signer_set_update_activity(active: bool)`.
- Adds bridge method `setUpdateActivity(active: boolean): Promise<void>`.

- [ ] **Step 1: Add notification-gate tests.**

```rust
#[test]
fn unavailable_notifies_once_until_recovery() {
    let mut gate = NotificationGate::default();
    assert!(gate.observe(&status(AgentPhase::Unavailable, "offline")).is_some());
    assert!(gate.observe(&status(AgentPhase::Unavailable, "offline")).is_none());
    assert!(gate.observe(&status(AgentPhase::Idle, "")).is_none());
    assert!(gate.observe(&status(AgentPhase::Unavailable, "offline again")).is_some());
}
```

Add an actionable degraded-error test proving a changed error can notify after recovery but identical repeated callbacks do not.

- [ ] **Step 2: Run the focused Rust tests.**

Run: `cargo test --manifest-path apps/signer/Cargo.toml --workspace tray::tests::unavailable_notifies_once_until_recovery`

Expected: FAIL until `NotificationGate` exists.

- [ ] **Step 3: Move native notifications behind `TrayController::apply_status`.**

Remove the stateless `notify_if_actionable` function from `lib.rs`. `Reconnecting` never returns notification text. `Unavailable` returns the five-minute message once. `Degraded` returns its redacted `last_error` once for the current incident. Idle, working, and unpaired reset the gate.

- [ ] **Step 4: Wire update installation activity with guaranteed cleanup.**

```ts
await bridge.setUpdateActivity(true);
try {
  await update.install();
  onInstalled();
} catch {
  setFailed(true);
  await bridge.setUpdateActivity(false);
} finally {
  setPending(false);
}
```

Successful installation relaunches the process; if `relaunch()` itself rejects, the catch path clears the animation. The command changes only tray presentation and never starts an update.

- [ ] **Step 5: Run Rust and frontend tests.**

Run: `cargo test --manifest-path apps/signer/Cargo.toml --workspace`

Run: `pnpm --filter @markiro/signer test`

Expected: PASS.

- [ ] **Step 6: Commit notification deduplication and update activity.**

```bash
git add apps/signer/src-tauri/src apps/signer/src/lib/bridge.ts apps/signer/src/components/UpdateBanner.tsx apps/signer/test/updates.test.tsx
git commit -m "fix(signer): notify once per connectivity incident"
```

---

### Task 6: Final verification and Windows acceptance checklist

**Files:**

- Modify: `docs/runbooks/signer-release.md`
- Create: `docs/runbooks/signer-windows-acceptance.md`

**Interfaces:**

- Consumes: completed runtime, UI, updater, and tray behavior.
- Produces: a repeatable manual acceptance record for the Windows-only boundaries.

- [ ] **Step 1: Document the Windows acceptance sequence.**

Include exact checks for:

```text
1. Green, yellow, red, gray, and blue badge rendering on light and dark taskbars.
2. No persistent-state animation; 800 ms pulse only during signing/installing.
3. No notification during a network interruption shorter than five minutes.
4. Exactly one notification after five continuous minutes offline.
5. Green recovery state and one journal recovery record after reconnecting.
6. Manual update check: current, available, failed, retry.
7. No download before “Установить и перезапустить”.
8. Successful relaunch retains pairing, certificate selection, and DPAPI credential.
```

- [ ] **Step 2: Run the complete automated gate.**

Run: `cargo fmt --manifest-path apps/signer/Cargo.toml --all -- --check`

Run: `cargo test --manifest-path apps/signer/Cargo.toml --workspace`

Run: `pnpm --filter @markiro/signer test`

Run: `pnpm --filter @markiro/signer typecheck`

Run: `pnpm --filter @markiro/signer lint`

Run: `pnpm --filter @markiro/signer build`

Run: `git diff --check`

Expected: all available automated checks PASS. Report the current pnpm lockfile/tooling blocker separately if it still prevents JavaScript checks; do not convert it into a product-code change in this scope.

- [ ] **Step 3: Commit the acceptance documentation.**

```bash
git add docs/runbooks/signer-release.md docs/runbooks/signer-windows-acceptance.md
git commit -m "docs(signer): add resilient client acceptance checks"
```
