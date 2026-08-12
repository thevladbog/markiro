# Markiro Station onboarding redesign

**Date:** 2026-08-12
**Status:** Approved design; implementation pending
**Scope:** Windows Station first-run pairing, shared sign-in framing, application icons, production pairing CORS, and an explicit fullscreen exit/re-entry control.

## 1. Problem

The current first-run screen presents an unbranded generic card. Its three floor-sized actions touch each other, the eight-digit pairing code has no on-screen numeric keypad, and the screen does not explain what Markiro Station does or where the code comes from. The Tauri application icon is a placeholder white circle rather than the compact Markiro mark.

The beta's pairing failure is also functional, not merely visual. A packaged Tauri 2 application on Windows uses `http://tauri.localhost` by default. The live production API currently returns `Access-Control-Allow-Origin` for `tauri://localhost` but not for `http://tauri.localhost`. The WebView therefore blocks `POST /station/pair` at CORS preflight and the Station can only show a generic availability error.

Production startup also enters kiosk lockdown: fullscreen, undecorated, always-on-top, hidden from the taskbar, and protected from ordinary close. The current UI exposes no general operator action to leave that mode.

## 2. Goals

1. Make first run unmistakably Markiro Station and explain its role in plain Russian and English.
2. Make pairing usable by touch, gloves, physical keyboard, and barcode scanner without scrolling at the 1280×800 target.
3. Separate the ordinary operator path from equipment and service workflows.
4. Present specific, recoverable pairing states without exposing credentials or server responses.
5. Restore working Windows pairing by configuring and contract-testing the exact production WebView origin.
6. Ship branded Windows, installer, taskbar, and application icons derived from the existing compact Markiro mark.
7. Let an operator explicitly leave and re-enter fullscreen lockdown without closing the application or changing production state.

## 3. Non-goals

- No change to the eight-digit, single-use, 15-minute pairing-code protocol.
- No server URL field in the ordinary SaaS pairing flow.
- No automatic device discovery, pairing, updater installation, or telemetry.
- No framework, component-library, font, or icon-library migration.
- No redesign of shift selection or the active production workspace except for the shared fullscreen control.
- No weakening of credential recovery, sealed local work, tenant isolation, or device identity checks.

## 4. Chosen visual direction: launch console

The approved direction is an asymmetric two-zone launch console.

### 4.1 Brand and context zone

The left zone contains:

- the full Markiro logo (`маркиро` plus compact pixel mark);
- the product label `Station — рабочее место производственной линии`;
- a short description: code verification, aggregation, and label printing on the production line;
- three concise commissioning steps: create the station in the cabinet, enter or scan the code, then sign in as an operator.

The copy is concrete and production-oriented. It does not use marketing claims or generic SaaS language.

### 4.2 Pairing zone

The right zone contains:

- an instruction that the code comes from `admin.markiro.app`;
- a large eight-digit readout grouped visually as `1234 5678` while preserving the exact ungrouped value for submission;
- the existing `@markiro/ui` `PinPad` in a 3×4 layout with digits, backspace, and clear;
- one visually dominant `Подключить станцию` action;
- a clearly separated secondary `Настроить оборудование` action;
- a low-emphasis text action for `Сервисная настройка`.

The input remains compatible with:

- touch keypad entry;
- a focused physical keyboard, digits and Backspace/Delete included;
- Enter to submit a valid code;
- an exact eight-digit scanner capture through the existing `ScanSource`.

Scanner and keyboard entry update the same controlled value as the on-screen keypad. Non-digits are ignored and input is capped at eight digits.

### 4.3 Layout constraints

- The base target is 1280×800, with secondary acceptance at 1024×768 and 1280×1024.
- The document and internal primary regions must not scroll.
- Floor controls remain at least 64×64 px; keypad keys remain 80–96 px where the viewport permits.
- The two zones use CSS Grid and repository tokens. New inline styles are not introduced.
- Russian is the primary layout stress case; English mirrors the same information hierarchy.
- Focus is visible, status is not communicated by color alone, and all icon-only controls have accessible names.

## 5. Pairing states and recovery

### 5.1 Waiting

The readout, keypad, and ordinary actions are available. The primary action is disabled until exactly eight digits and a trusted pairing API base are available. The screen explains where to obtain the code.

### 5.2 Redeeming

The readout, keypad, and actions are disabled to prevent duplicate attempts. The status reads `Проверяем код и загружаем настройки…`. The current code remains visible. A screen-reader live region announces the state.

### 5.3 Invalid and expired

The screen distinguishes invalid, expired, locked, and rate-limited responses. Invalid or expired states tell the operator to issue a new code in the Station section of `admin.markiro.app`. Locked and rate-limited states do not invite immediate repeated submission.

### 5.4 Network or server unavailable

The screen shows a calm, dedicated error panel with `Повторить` and, when available, `Настроить оборудование`. The entered code is retained. The UI does not claim the code is wrong when the server could not be reached.

### 5.5 Success

After provisioning and durable persistence complete, the screen briefly names the organization and assigned line when those values are available, then proceeds to operator sign-in. It never renders or logs the device key.

### 5.6 Credential recovery

Same-device recovery continues to display the sealed local-work counts for scans, boxes, and exceptions. Re-pairing does not clear the journal or change the expected device ID. Service setup remains unavailable on the path where an existing device identity must be preserved.

### 5.7 Service setup

Service setup is a separate screen rather than fields embedded beside ordinary pairing. It includes a warning that the workflow is for support personnel, explicit Back navigation, server URL and device key fields, and one service-connect action. Entering it does not erase the ordinary pairing code. Credentials remain masked and are never printed or logged.

## 6. Operator sign-in framing

Operator sign-in retains its existing badge-first state machine, login/PIN keypad, and name-search fallback. It adopts the same Markiro product header and visual surface language as onboarding.

Action rows use explicit grid/flex gaps and bounded columns. Russian labels may wrap without controls touching, clipping, or shifting neighboring actions. The login flow retains 64 px minimum targets and its existing offline operator mirror.

## 7. Fullscreen and lockdown control

### 7.1 Visibility

A persistent, accessible window-mode control appears in the top-right area on every application screen, including pairing, sign-in, setup, shift selection, and active production work.

In lockdown it reads `Выйти из полноэкранного режима`. In windowed mode it reads `Вернуться в полноэкранный режим`. The control uses text plus a consistent directional window glyph; the label, not the glyph alone, communicates its action.

### 7.2 Behavior

- Exiting invokes the existing Tauri `exit_lockdown` command, restoring taskbar presence, decorations, ordinary stacking, close behavior, and windowed mode.
- Re-entering invokes `enter_lockdown`, restoring the production lockdown properties.
- Neither action closes the app, signs out the operator, ends a shift, clears queues, changes device configuration, or interrupts sync.
- During an active shift, exiting requires a full-screen confirmation explaining that production continues and only the window mode changes.
- Outside an active shift, exit is immediate.
- While a command is pending, repeated mode changes are disabled.
- A command failure leaves the last confirmed UI mode unchanged and shows a plain-language error. IPC error details are not exposed.

The client needs an observable lockdown state rather than assuming a command succeeded. The lifecycle continues to serialize requests and must expose confirmed mode and pending/failure information to the UI without allowing concurrent contradictory commands.

## 8. Brand assets and application icons

The existing admin logo is the source of truth:

- off-white/dark square compact mark;
- consistent pixel grid;
- one green brand cell;
- IBM Plex Mono wordmark with Cyrillic support.

Station receives local SVG assets for the full dark-surface wordmark and compact mark. No CDN or runtime network asset is added.

The compact mark is rendered with platform-safe padding and an opaque background into the complete Tauri icon set used by development, Windows resources, the installer, taskbar, and release bundle. The generated source and command are documented so future regeneration is deterministic. The placeholder white-circle assets are replaced, not retained as a fallback.

## 9. Production CORS correction

The production API must allow the exact origin emitted by the shipped Windows Tauri configuration. With the current default `useHttpsScheme: false`, that origin is `http://tauri.localhost`.

Required changes:

1. Production configuration sets `STATION_ORIGIN=http://tauri.localhost`.
2. Documentation stops presenting `tauri://localhost` as the Windows choice for this build.
3. Deployment contracts assert the exact configured value.
4. A production preflight check sends:
   - `Origin: http://tauri.localhost`;
   - `Access-Control-Request-Method: POST`;
   - `Access-Control-Request-Headers: content-type,x-station-capabilities`;
   - target `/station/pair`.
5. The check requires `204` and exact `Access-Control-Allow-Origin: http://tauri.localhost`.

The allowlist remains scoped to the documented Station route/method surface. This correction must not add the Station origin to cabinet sessions, Better Auth, platform auth, or kiosk endpoints.

## 10. Components and boundaries

Implementation stays within existing boundaries:

- `Enrollment` owns pairing state and submission.
- The existing `PinPad` owns numeric touch entry.
- A focused Station brand component owns local logo assets and product identification.
- A focused window-mode control owns presentation and confirmation; it calls an observable extension of the existing lockdown lifecycle supplied by `App`.
- `App` remains the owner of Tauri lifecycle and active-shift knowledge.
- `pairing.ts` retains strict response decoding and provisioning persistence.
- Station CSS owns viewport composition; shared tokens and buttons continue to come from `@markiro/ui`.

No pairing API DTO, database schema, credential format, or sync protocol changes are required.

## 11. Testing and acceptance

### 11.1 Automated Station tests

- Pairing screen exposes the Markiro product identity and cabinet instruction.
- PinPad digits, zero, backspace, and clear mutate the exact controlled code.
- Physical digit entry, Backspace/Delete, and Enter work without duplicating scanner input.
- Exact scanner capture fills the same code.
- The primary action is enabled only for a valid eight-digit code and trusted API base.
- Redeeming disables all duplicate-producing controls and exposes a live status.
- Invalid, expired, locked, rate-limited, unavailable, and success states render their specific recovery copy.
- Unavailable retry retains the code.
- Service setup is separate, returns to pairing, and stays absent during pinned same-device recovery.
- Sealed work remains visible in recovery.
- RU and EN keys exist and focused layout assertions cover action spacing.
- The 1280×800 and 1024×768 source/browser acceptance has no scroll and no clipped primary action.
- The window-mode control is present on pairing, sign-in, and floor screens.
- Outside a shift, exit calls `exit_lockdown` immediately.
- During a shift, exit calls it only after confirmation.
- Re-entry calls `enter_lockdown`.
- Pending and failed commands do not produce false mode labels or duplicate commands.

### 11.2 API and deployment contracts

- Environment parsing accepts and canonicalizes `http://tauri.localhost`.
- Station CORS remains limited to its exact methods and paths.
- Production bundle/deployment configuration requires `STATION_ORIGIN=http://tauri.localhost`.
- Production smoke/preflight validates the exact Windows origin and Station capability header.

### 11.3 Asset checks

- Tauri configuration points to a branded Windows `.ico`.
- Required PNG sizes and platform icon containers exist and are non-placeholder.
- A deterministic regeneration test or documented command ties generated icons to the compact source mark.

### 11.4 Manual Windows acceptance

Record Windows/WebView2 version, build commit/version, display resolution, and scaling. Verify:

- fresh install shows the branded installer/application/taskbar/window icon;
- production starts in lockdown;
- exit restores decorations and taskbar presence;
- re-entry restores fullscreen, always-on-top, hidden-taskbar, and close blocking;
- active-shift exit requires confirmation and preserves shift, outbox, sync, and counters;
- a real code issued from `admin.markiro.app` pairs successfully;
- scanner, physical keyboard, and touch keypad all enter the code;
- pairing, sign-in, and all error states fit at 1280×800 without scrolling;
- controls remain usable with the target touchscreen/gloves.

Host browser tests, macOS Tauri runs, and CI Rust tests do not satisfy Windows, WebView2, installer-icon, scanner, printer, or glove acceptance.

## 12. Rollout

1. Land UI, assets, lifecycle state, tests, and production configuration as one beta-focused change so the redesigned screen is not shipped with broken pairing.
2. Deploy the API/configuration with the Windows origin before distributing the new Station beta.
3. Verify the production preflight externally.
4. Publish the beta through the existing manual Station release flow.
5. Install and exercise the beta on the target Windows station using a newly issued code.

Rollback of the Station binary does not require a database rollback. The CORS correction is backward-compatible for the Station route surface and can remain in place. If manual acceptance fails, retain the previous installer and do not promote the beta channel.
