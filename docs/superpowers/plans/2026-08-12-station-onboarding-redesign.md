# Markiro Station Onboarding Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a branded, touch-friendly Station onboarding and sign-in experience with working Windows pairing, real Markiro icons, and an operator-controlled fullscreen lockdown toggle.

**Architecture:** Keep pairing and provisioning in the existing `Enrollment`/`pairing.ts` boundary, reuse `@markiro/ui` `PinPad`, and add focused Station-only brand and window-mode components. Extend the existing serialized lockdown lifecycle with an observable confirmed snapshot, while `App` remains the owner of active-shift confirmation and Tauri commands. Correct the deployed Windows CORS origin and prove it with API, workflow, and live preflight contracts.

**Tech Stack:** React 19, TypeScript 6, Vite 8, i18next, `@markiro/ui`, Vitest/Testing Library, Tauri 2.11/Rust, NestJS CORS, Node test runner, GitHub Actions.

## Global Constraints

- Preserve the eight-digit, single-use, 15-minute pairing-code protocol and strict provisioning decoder.
- Preserve same-device recovery, sealed local work, tenant isolation, and device identity checks.
- Use existing IBM Plex fonts, `@markiro/ui` tokens/components, and repository i18n; add no dependency.
- Bundle every logo/icon asset locally; add no CDN or runtime network dependency.
- Keep the Station document and primary regions scroll-free at 1280×800; retain 64×64 px floor actions and 80–96 px keypad keys where the viewport permits.
- Use the exact existing Markiro pixel geometry and green cell, not a generated approximation.
- Keep service credentials masked and out of logs, tests, screenshots, and error text.
- The shipped Windows Tauri origin is exactly `http://tauri.localhost`; never allow opaque `null`.
- The fullscreen toggle changes window mode only; it must not close the app, sign out, end a shift, clear queues, change configuration, or interrupt sync.
- Automated browser/Rust checks do not count as Windows, WebView2, installer-icon, scanner, printer, touch, or glove acceptance.

---

## File map

### New files

- `apps/station/src/assets/markiro-logo-on-dark.svg` — full Station wordmark copied from the approved admin asset geometry.
- `apps/station/src/assets/markiro-app-icon.svg` — square compact Markiro mark used as the deterministic Tauri icon source.
- `apps/station/src/ui/StationBrand.tsx` — reusable product identity for onboarding and sign-in.
- `apps/station/src/ui/WindowModeControl.tsx` — fullscreen exit/re-entry action, active-shift confirmation, pending, and failure UI.
- `apps/station/test/station-brand-assets.test.ts` — asset geometry and generated-icon contract.
- `apps/station/test/window-mode-control.test.tsx` — component behavior and accessibility.
- `tools/station-release/verify-api-cors.mjs` — exact live preflight verifier for the packaged Windows origin.
- `tools/station-release/test/verify-api-cors.test.mjs` — deterministic verifier tests using injected fetch.

### Modified files

- `apps/station/src/pages/Enrollment.tsx` — launch-console layout, PinPad, separated service screen, specific retry states, and success context.
- `apps/station/src/pages/OperatorLogin.tsx` — shared Station brand framing and stable action layout.
- `apps/station/src/lib/lockdown.ts` — observable confirmed lockdown snapshot and serialized state notifications.
- `apps/station/src/App.tsx` — global window-mode control, active-shift confirmation input, and setup integration.
- `apps/station/src/ui/FloorShell.tsx` — reserve top-right chrome space where needed without coupling floor content to Tauri.
- `apps/station/src/station.css` — launch console, brand, sign-in spacing, window control, confirmation, and viewport rules.
- `apps/station/src/i18n/ru.json` and `apps/station/src/i18n/en.json` — product, pairing-state, service-warning, and window-mode copy.
- `apps/station/test/enrollment.test.tsx` — keypad, keyboard, scanner, states, retry, service separation, and recovery tests.
- `apps/station/test/operator-login.test.tsx` — brand and non-touching action layout assertions.
- `apps/station/test/lockdown.test.ts` — confirmed snapshot, subscription, pending, failures, and serialization.
- `apps/station/test/App.test.tsx` — global control and active-shift confirmation integration.
- `apps/station/test/fixed-viewport-source.test.tsx` — onboarding/window-control no-scroll source contract.
- `apps/station/src-tauri/icons/*` — Tauri-generated branded icon set.
- `apps/station/src-tauri/tauri.conf.json` — explicit complete desktop icon list.
- `apps/api/test/allowed-origins.test.ts` and `apps/api/test/cors.e2e.test.ts` — exact Windows origin and preflight coverage.
- `.env.production.example`, `apps/station/README.md`, `docs/device-key-surface.md` — Windows origin documentation.
- `.github/workflows/station-beta-release.yml` — fail-closed live CORS verification before the Windows build.
- `tools/station-release/test/workflow.test.mjs` — source contract for the live verifier step.
- `package.json` — focused live preflight command.
- `docs/runbooks/station-beta-release.md` and `docs/hardware-acceptance-checklist.md` — deployment order and Windows acceptance.

---

### Task 1: Brand assets and deterministic Tauri icons

**Files:**
- Create: `apps/station/src/assets/markiro-logo-on-dark.svg`
- Create: `apps/station/src/assets/markiro-app-icon.svg`
- Create: `apps/station/src/ui/StationBrand.tsx`
- Create: `apps/station/test/station-brand-assets.test.ts`
- Modify: `apps/station/src-tauri/icons/*`
- Modify: `apps/station/src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: approved geometry from `apps/admin/src/assets/markiro-logo-on-dark.svg`.
- Produces: `StationBrand({ descriptor, compact?, className? }): JSX.Element`; deterministic source `markiro-app-icon.svg`; complete Tauri desktop icon set.

- [ ] **Step 1: Install the unchanged workspace dependencies in the isolated worktree**

Run:

```bash
pnpm install --frozen-lockfile
```

Expected: install succeeds without modifying `pnpm-lock.yaml`. If pnpm reports a pre-existing minimum-release-age or lockfile-config mismatch, record that exact setup failure and use the repository-approved bounded setup procedure; do not disable the policy globally.

- [ ] **Step 2: Write failing asset and component tests**

Add assertions that:

```ts
expect(fullLogo).toContain('fill="#3DDC7A"');
expect(fullLogo).toContain(">маркиро</text>");
expect(appIcon).toContain('viewBox="0 0 512 512"');
expect(appIcon).not.toContain("<circle");
expect(tauriConfig.bundle.icon).toEqual([
  "icons/32x32.png",
  "icons/128x128.png",
  "icons/128x128@2x.png",
  "icons/icon.icns",
  "icons/icon.ico",
]);
```

Render `StationBrand` and assert the image has the accessible name `Markiro Station` and the product descriptor remains real text.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @markiro/station exec vitest run test/station-brand-assets.test.ts
```

Expected: FAIL because Station brand sources and `StationBrand` do not exist and the Tauri icon list is incomplete.

- [ ] **Step 4: Add exact local vectors and `StationBrand`**

Copy the approved wordmark geometry exactly into the Station asset. Create a 512×512 opaque off-black square source with the same seven off-white grid cells and one green cell, preserving integral pixel edges and platform-safe padding.

Implement:

```tsx
import logo from "../assets/markiro-logo-on-dark.svg";

export interface StationBrandProps {
  descriptor: string;
  compact?: boolean;
  className?: string;
}

export function StationBrand({ descriptor, compact = false, className }: StationBrandProps) {
  return (
    <div className={["station-brand", compact && "station-brand--compact", className]
      .filter(Boolean)
      .join(" ")}>
      <img src={logo} alt="Markiro Station" />
      {compact ? null : <span>{descriptor}</span>}
    </div>
  );
}
```

The caller always supplies the localized descriptor; `StationBrand` never hard-codes Russian.

- [ ] **Step 5: Generate and inspect the Tauri icon set**

Run the official Tauri SVG icon generator:

```bash
pnpm --filter @markiro/station tauri icon apps/station/src/assets/markiro-app-icon.svg --output apps/station/src-tauri/icons
```

Update `bundle.icon` to the five desktop paths asserted above. Visually inspect `32x32.png`, `128x128.png`, and `icon.png`; the green cell and pixel mark must remain legible and the old white circle must be gone.

- [ ] **Step 6: Run focused tests and Station build**

Run:

```bash
pnpm --filter @markiro/station exec vitest run test/station-brand-assets.test.ts test/tauri-release-config.test.ts
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station build
```

Expected: all commands PASS.

- [ ] **Step 7: Commit the branded asset slice**

```bash
git add apps/station/src/assets apps/station/src/ui/StationBrand.tsx apps/station/test/station-brand-assets.test.ts apps/station/src-tauri/icons apps/station/src-tauri/tauri.conf.json
git commit -m "feat(station): add branded application identity"
```

---

### Task 2: Launch-console pairing experience

**Files:**
- Modify: `apps/station/src/pages/Enrollment.tsx`
- Modify: `apps/station/src/station.css`
- Modify: `apps/station/src/i18n/ru.json`
- Modify: `apps/station/src/i18n/en.json`
- Modify: `apps/station/test/enrollment.test.tsx`
- Modify: `apps/station/test/fixed-viewport-source.test.tsx`

**Interfaces:**
- Consumes: `StationBrand`, existing `PinPad`, `redeemStationPairing`, `ScanSource`, and existing `EnrollmentProps`.
- Produces: unchanged external `Enrollment(props): JSX.Element`; internal pure `normalizePairingKeyboardInput(current, event): string` only if extracting it improves direct tests.

- [ ] **Step 1: Write failing layout and input tests**

Add tests that assert:

```ts
expect(screen.getByText("Code verification, aggregation, and label printing on the production line.")).toBeDefined();
expect(screen.getByText("admin.markiro.app")).toBeDefined();
expect(screen.getByRole("group", { name: "Pairing code keypad" })).toBeDefined();
```

Exercise digit `1`, zero, Backspace, and Clear buttons against the controlled input. Dispatch physical digit, `Backspace`, `Delete`, and `Enter` events and assert submission happens once only at eight digits. Keep the existing exact scanner test.

Add source assertions for `.station-enrollment`, a two-column grid at the base viewport, explicit gaps, `overflow: hidden`, and the absence of inline `style={{` in `Enrollment.tsx`.

- [ ] **Step 2: Run the enrollment tests and verify RED**

```bash
pnpm --filter @markiro/station exec vitest run test/enrollment.test.tsx test/fixed-viewport-source.test.tsx
```

Expected: FAIL because no keypad, launch-console copy, or dedicated CSS exists.

- [ ] **Step 3: Replace the generic Card with semantic launch-console regions**

Use this structure:

```tsx
<main className="station-enrollment" aria-labelledby="station-enrollment-title">
  <aside className="station-enrollment__context">
    <StationBrand descriptor={t("app.stationDescriptor")} />
    <div className="station-enrollment__intro">...</div>
    <ol className="station-enrollment__steps">...</ol>
  </aside>
  <section className="station-enrollment__entry">
    {serviceMode ? servicePanel : pairingPanel}
  </section>
</main>
```

Keep service setup in the same route/state machine but render it as a complete separate panel with warning and Back action. Do not mix server/key fields with the keypad.

- [ ] **Step 4: Reuse `PinPad` and preserve all input paths**

Render:

```tsx
<PinPad
  value={code}
  onChange={setCode}
  maxLength={8}
  size="floor"
  disabled={busy}
  ariaLabel={t("enroll.keypad")}
  backspaceLabel={t("enroll.backspace")}
  clearLabel={t("enroll.clear")}
/>
```

Keep a real labeled input/readout for physical keyboard accessibility. Format grouping with CSS or a derived display value only; submit `code` unchanged. Prevent scanner and ordinary keyboard handlers from producing duplicate digits.

- [ ] **Step 5: Implement specific state actions and copy**

Add a retry action for `unavailable` that calls `redeem()` without clearing `code`. During `redeeming`, disable keypad, input, setup, service, and submit actions and expose `role="status"` text `Проверяем код и загружаем настройки…` / its English equivalent.

Map recovery instructions by error:

```ts
const requiresNewCode = error === "invalid" || error === "expired" || error === "locked";
const canRetry = error === "unavailable";
```

Do not alter `pairing.ts` error classification or expose response bodies. On success, retain durable persistence before any success UI, store only `organizationName` and optional `lineName` in a local success summary, render it for 900 ms, then call `onEnrolled`. Keep the timeout handle in a ref and clear it on unmount or lifecycle-identity change so a stale pairing result cannot navigate a replacement screen.

- [ ] **Step 6: Add RU/EN dictionaries and fixed-viewport CSS**

Add exact paired keys under `app` and `enroll` for descriptor, purpose, three steps, keypad, correction labels, redeeming detail, cabinet recovery, retry, and service warning. Use CSS Grid with a bounded right column and a compact 1024×768 media rule; never reduce targets below 64 px.

- [ ] **Step 7: Run focused and package checks**

```bash
pnpm --filter @markiro/station exec vitest run test/enrollment.test.tsx test/fixed-viewport-source.test.tsx test/screen-gallery-bootstrap.test.tsx
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
pnpm --filter @markiro/station build
```

Expected: PASS. Record jsdom/browser limitations separately.

- [ ] **Step 8: Commit the pairing slice**

```bash
git add apps/station/src/pages/Enrollment.tsx apps/station/src/station.css apps/station/src/i18n/ru.json apps/station/src/i18n/en.json apps/station/test/enrollment.test.tsx apps/station/test/fixed-viewport-source.test.tsx
git commit -m "feat(station): redesign pairing console"
```

---

### Task 3: Branded operator sign-in and stable action spacing

**Files:**
- Modify: `apps/station/src/pages/OperatorLogin.tsx`
- Modify: `apps/station/src/station.css`
- Modify: `apps/station/test/operator-login.test.tsx`

**Interfaces:**
- Consumes: `StationBrand`, unchanged badge/login/PIN/search state machine.
- Produces: unchanged `OperatorLogin(props): JSX.Element` with shared product framing.

- [ ] **Step 1: Write failing sign-in framing tests**

Render badge, login, PIN, and search stages. Assert `Markiro Station` remains visible, action containers have the `operator-login__actions` class, and the CSS rule uses a non-zero gap plus bounded grid columns rather than touching flex children.

```ts
expect(screen.getByRole("img", { name: "Markiro Station" })).toBeDefined();
expect(operatorLoginCss).toMatch(/\.operator-login__actions\s*\{[^}]*gap:\s*var\(--sp-3\)/s);
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
pnpm --filter @markiro/station exec vitest run test/operator-login.test.tsx
```

Expected: FAIL because the brand is absent and the new layout contract is unmet.

- [ ] **Step 3: Add shared framing without changing authentication behavior**

Place `StationBrand` in a stable header region and keep the existing stage prompt as the page heading. Convert action rows to a grid whose column count follows the current stage and whose gap remains visible with wrapped Russian labels. Do not change badge verification, mirror reads, PIN bounds, name search, or offline behavior.

- [ ] **Step 4: Run focused and regression tests**

```bash
pnpm --filter @markiro/station exec vitest run test/operator-login.test.tsx test/auth.test.ts test/operator-search.test.ts
pnpm --filter @markiro/station typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the sign-in slice**

```bash
git add apps/station/src/pages/OperatorLogin.tsx apps/station/src/station.css apps/station/test/operator-login.test.tsx
git commit -m "feat(station): brand operator sign-in"
```

---

### Task 4: Observable lockdown lifecycle and global window-mode control

**Files:**
- Create: `apps/station/src/ui/WindowModeControl.tsx`
- Create: `apps/station/test/window-mode-control.test.tsx`
- Modify: `apps/station/src/lib/lockdown.ts`
- Modify: `apps/station/src/App.tsx`
- Modify: `apps/station/src/ui/FloorShell.tsx`
- Modify: `apps/station/src/station.css`
- Modify: `apps/station/src/i18n/ru.json`
- Modify: `apps/station/src/i18n/en.json`
- Modify: `apps/station/test/lockdown.test.ts`
- Modify: `apps/station/test/App.test.tsx`

**Interfaces:**
- Consumes: Tauri commands `enter_lockdown` and `exit_lockdown`, active shift truth `shift !== null`, `FullScreenDialog`, and `Button`.
- Produces:

```ts
export interface LockdownSnapshot {
  mode: "locked" | "windowed";
  pending: boolean;
  error: "enter" | "exit" | null;
}

export interface LockdownLifecycle {
  start(): () => void;
  enter(): Promise<void>;
  exit(): Promise<void>;
  subscribe(listener: () => void): () => void;
  getSnapshot(): LockdownSnapshot;
  clearError(): void;
  whenSettled(): Promise<void>;
}
```

`WindowModeControl` consumes `snapshot`, `activeShift`, `onEnter`, `onExit`, and `onDismissError`; `App` passes `lockdown.clearError` as `onDismissError`.

- [ ] **Step 1: Write failing lifecycle snapshot tests**

Assert the production lifecycle starts with `{ mode: "windowed", pending: false, error: null }`, publishes pending before each command, changes mode only after success, leaves mode unchanged on failure, records the safe error enum, and serializes exit after an in-flight enter. Assert thrown text containing a fake secret is never included in snapshot or logs.

- [ ] **Step 2: Run lifecycle tests and verify RED**

```bash
pnpm --filter @markiro/station exec vitest run test/lockdown.test.ts
```

Expected: FAIL because snapshot/subscription APIs do not exist.

- [ ] **Step 3: Implement observable confirmed state inside the existing serializer**

Maintain one immutable snapshot and listener set:

```ts
let snapshot: LockdownSnapshot = { mode: "windowed", pending: false, error: null };
const listeners = new Set<() => void>();
const publish = (next: LockdownSnapshot) => {
  snapshot = next;
  listeners.forEach((listener) => listener());
};
```

Before invocation publish `pending: true`; on success publish the confirmed mode; on failure retain the prior mode, set `pending: false`, and set `error` to the attempted direction. Preserve current de-duplication and partial-failure retry semantics.

- [ ] **Step 4: Write failing `WindowModeControl` tests**

Assert:

- locked/no-shift click calls `onExit` immediately;
- locked/active-shift click opens a dialog and does not exit before confirmation;
- confirmation calls `onExit` once;
- windowed click calls `onEnter`;
- pending disables repeat actions;
- failed exit renders localized safe copy;
- the top-level control remains at least 64×64 px and has an accessible name.

- [ ] **Step 5: Implement the global control and confirmation**

Use text plus a small CSS window glyph. Render a `FullScreenDialog` only for active-shift exit confirmation. The confirmation copy must say that production continues and only window mode changes. Do not attach `Escape` as an unconfirmed active-shift exit shortcut.

- [ ] **Step 6: Integrate the control in every `App` branch**

Use `useSyncExternalStore(lockdown.subscribe, lockdown.getSnapshot, lockdown.getSnapshot)` and a small `withWindowChrome(content)` render helper or a single wrapper component so loading, pairing, recovery, login, setup, and floor branches all render the control.

Pass `activeShift={shift !== null}`. Keep the existing setup exit/re-entry contract, but key its UI labels from the confirmed snapshot; if setup automatically exited from locked mode, return to the prior locked mode on Done/Back. A user-selected windowed mode before setup must remain windowed afterward.

- [ ] **Step 7: Update App integration tests**

Replace the old assertion that no exit button exists. Prove the control appears before enrollment and on the floor, no-shift exit is immediate, active-shift exit is confirmed, state survives the mode change, and re-entry calls `lockdown.enter` without changing operator/shift state.

- [ ] **Step 8: Run TypeScript, UI, and Rust lockdown checks**

```bash
pnpm --filter @markiro/station exec vitest run test/lockdown.test.ts test/window-mode-control.test.tsx test/App.test.tsx
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
```

Expected: PASS. Rust host tests prove command logic only, not Windows window behavior.

- [ ] **Step 9: Commit the window-mode slice**

```bash
git add apps/station/src/lib/lockdown.ts apps/station/src/ui/WindowModeControl.tsx apps/station/src/ui/FloorShell.tsx apps/station/src/App.tsx apps/station/src/station.css apps/station/src/i18n/ru.json apps/station/src/i18n/en.json apps/station/test/lockdown.test.ts apps/station/test/window-mode-control.test.tsx apps/station/test/App.test.tsx
git commit -m "feat(station): add operator window mode control"
```

---

### Task 5: Correct and continuously verify the Windows pairing origin

**Files:**
- Create: `tools/station-release/verify-api-cors.mjs`
- Create: `tools/station-release/test/verify-api-cors.test.mjs`
- Modify: `apps/api/test/allowed-origins.test.ts`
- Modify: `apps/api/test/cors.e2e.test.ts`
- Modify: `.env.production.example`
- Modify: `apps/station/README.md`
- Modify: `docs/device-key-surface.md`
- Modify: `.github/workflows/station-beta-release.yml`
- Modify: `tools/station-release/test/workflow.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `VITE_STATION_API_URL=https://admin.markiro.app`; API CORS delegate; GitHub release workflow.
- Produces:

```ts
export async function verifyStationCors({
  apiUrl,
  fetchImpl = fetch,
}: {
  apiUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<void>;
```

The function sends the exact Windows preflight and throws a secret-free error on non-204 or mismatched ACAO.

- [ ] **Step 1: Add failing API origin tests**

Set the Station test origin to `http://tauri.localhost` and assert environment parsing returns that exact origin. Keep explicit denial cases for `null`, `file:`, `tauri://other-host`, and userinfo. In CORS e2e, assert the pairing preflight echoes `http://tauri.localhost` and the origin remains absent from cabinet, auth, platform, and kiosk surfaces.

- [ ] **Step 2: Run API tests and establish current behavior**

```bash
pnpm --filter @markiro/api exec vitest run test/allowed-origins.test.ts test/cors-station-surface.test.ts test/cors.e2e.test.ts
```

Expected: parsing tests may already PASS because HTTP origins are supported; the changed e2e fixture proves the Windows value through the full CORS delegate. Do not manufacture an application-code change if tests show the parser/delegate already work—the production value, workflow, and docs remain the required fix.

- [ ] **Step 3: Write failing live verifier tests**

Use injected `fetchImpl` fixtures to assert exact request details:

```js
assert.equal(url, "https://admin.markiro.app/station/pair");
assert.equal(init.method, "OPTIONS");
assert.equal(init.headers.Origin, "http://tauri.localhost");
assert.equal(init.headers["Access-Control-Request-Method"], "POST");
assert.equal(
  init.headers["Access-Control-Request-Headers"],
  "content-type,x-station-capabilities",
);
```

Cover success, wrong ACAO, missing ACAO, non-204, unsafe/non-canonical API URL, and response bodies that contain a fake secret; thrown messages must not include the body.

- [ ] **Step 4: Run verifier tests and verify RED**

```bash
node --test tools/station-release/test/verify-api-cors.test.mjs
```

Expected: FAIL because the verifier does not exist.

- [ ] **Step 5: Implement the fail-closed verifier and package script**

Canonicalize `apiUrl` as an HTTPS origin with no path, query, fragment, or userinfo. Send OPTIONS to `/station/pair`, require status 204 and exact ACAO, and throw only `Station pairing CORS verification failed` on failure.

Add:

```json
"verify:station-production-cors": "node tools/station-release/verify-api-cors.mjs https://admin.markiro.app"
```

- [ ] **Step 6: Gate the beta workflow before the Windows build**

After checkout/install/tests and before `tauri build`, add:

```yaml
- name: Verify production station pairing CORS
  run: pnpm verify:station-production-cors
```

Extend `workflow.test.mjs` so removal, reordering after the Tauri build, or changing the production URL/origin causes the contract test to fail.

- [ ] **Step 7: Correct docs and the production runtime value**

Update docs to state that this Windows Tauri 2 build uses `http://tauri.localhost`; retain `tauri://localhost` only as a non-Windows platform note, not the deployed value.

Using the established Yandex Lockbox secret-version rotation procedure from `docs/runbooks/yandex-secrets.md`, publish a new runtime secret version with every existing key preserved and only `STATION_ORIGIN` changed to `http://tauri.localhost`. Never print or transfer the other secret values through captured command output. Restart/materialize runtime environment through the existing deployment workflow, then verify the live preflight before starting a Station release.

- [ ] **Step 8: Run all CORS and workflow contracts**

```bash
pnpm --filter @markiro/api exec vitest run test/allowed-origins.test.ts test/cors-station-surface.test.ts test/cors.e2e.test.ts
node --test tools/station-release/test/verify-api-cors.test.mjs tools/station-release/test/workflow.test.mjs
pnpm verify:station-production-cors
```

Expected: all local tests PASS; the final live command returns zero only after production echoes `http://tauri.localhost`.

- [ ] **Step 9: Commit the CORS slice**

```bash
git add apps/api/test/allowed-origins.test.ts apps/api/test/cors.e2e.test.ts .env.production.example apps/station/README.md docs/device-key-surface.md tools/station-release/verify-api-cors.mjs tools/station-release/test/verify-api-cors.test.mjs .github/workflows/station-beta-release.yml tools/station-release/test/workflow.test.mjs package.json
git commit -m "fix(station): verify Windows pairing origin"
```

---

### Task 6: Integrated regression, runbooks, and beta acceptance handoff

**Files:**
- Modify: `docs/runbooks/station-beta-release.md`
- Modify: `docs/hardware-acceptance-checklist.md`
- Modify: `docs/acceptance/station-touch-workplace.md` only if recording a new executed browser matrix; do not mark Windows checks complete from CI.

**Interfaces:**
- Consumes: completed Tasks 1–5 and the existing manual Station beta release workflow.
- Produces: review-ready branch and an explicit manual Windows acceptance record.

- [ ] **Step 1: Update the release and hardware runbooks**

Add the mandatory order:

1. production runtime secret contains `STATION_ORIGIN=http://tauri.localhost`;
2. live preflight verifier passes;
3. beta workflow builds the installer;
4. immutable installer/hash/signature are verified;
5. manual install checks branded icons, pairing, input methods, viewport, and fullscreen behavior.

Add checklist rows for active-shift exit confirmation, state preservation, re-entry, installer/taskbar/window icons, touch keypad, physical keyboard, scanner, and a real code from `admin.markiro.app`.

- [ ] **Step 2: Run the complete Station automated gate**

```bash
pnpm --filter @markiro/station test
pnpm --filter @markiro/station typecheck
pnpm --filter @markiro/station lint
pnpm --filter @markiro/station build
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
```

Expected: PASS with exact test counts recorded in the handoff.

- [ ] **Step 3: Run cross-cutting release and production contracts**

```bash
pnpm test:station-release:contract
pnpm test:production-bundle:contract
pnpm format:check
git diff --check
```

Expected: PASS. If database-dependent or browser suites skip/fail for missing infrastructure, report that exact limitation; do not call the gate complete.

- [ ] **Step 4: Perform the browser viewport matrix**

Use the Station development gallery or test harness at 1280×800, 1024×768, and 1280×1024. Capture pairing waiting/redeeming/all errors/service/success-recovery, login badge/login/PIN/search, window confirmation, and window failure states in RU and EN. Record any clipped control, nested scroll, or target below 64 px as a failure and fix before proceeding.

- [ ] **Step 5: Commit runbook and acceptance changes**

```bash
git add docs/runbooks/station-beta-release.md docs/hardware-acceptance-checklist.md docs/acceptance/station-touch-workplace.md
git commit -m "docs(station): add onboarding beta acceptance"
```

Stage only files actually changed; omit `docs/acceptance/station-touch-workplace.md` if no new executed evidence was recorded.

- [ ] **Step 6: Review the final diff and request code review**

```bash
git status --short
git diff main...HEAD --check
git diff main...HEAD --stat
git log --oneline main..HEAD
```

Verify no `.env`, secret payload, pairing code, signing key, generated cache, `.superpowers/`, Tauri `target`, or unrelated user file is present. Request review with the design spec and this plan linked.

- [ ] **Step 7: After merge, publish and manually accept the beta on Windows**

Run the existing manual Station beta release workflow only after production CORS is verified. Install the immutable beta on the target Windows station and record each hardware checklist result. A green workflow is not release acceptance until real pairing, window-mode transitions, icons, touch/keyboard/scanner entry, and 1280×800 fit have been observed.

---

## Final completion criteria

- The old white-circle icon is absent from every shipped Station icon surface.
- Pairing succeeds from the Windows Tauri WebView against production and is guarded by an exact live preflight check.
- The launch console explains Markiro Station, accepts touch/keyboard/scanner input, separates ordinary/equipment/service actions, and fits without scroll.
- Sign-in carries the same product identity and no action buttons touch or clip in RU/EN.
- Every screen exposes truthful fullscreen exit/re-entry controls; active shifts require confirmation; state and queues are preserved.
- Station package tests/typecheck/lint/build, Cargo host tests, release contracts, production contracts, format, and diff checks pass.
- Windows installer, WebView2, icon, fullscreen, touchscreen, scanner, and real pairing acceptance are recorded separately and are not inferred from CI.
