# Station Touch Workplace & Device Pairing Redesign

**Date:** 2026-08-06  
**Status:** Design approved; implementation pending  
**Supersedes for the station surface:** the interim manual station enrollment in `2026-07-23-05a-station-foundation.md` and the station-specific parts of `2026-07-24-device-commissioning-design.md` where this document is more precise  
**Related:** `docs/design-briefs/04-line-station.md`, `docs/design-briefs/07-device-commissioning.md`, `docs/superpowers/specs/2026-07-28-station-sync-design.md`, `docs/superpowers/specs/2026-07-30-station-exceptions-design.md`

## Problem

The station has the correct offline-first production foundation, but its present UI is still an implementation scaffold rather than a reliable touch workplace:

- several screens size themselves to `100vh` inside another `100vh` shell, so the document can grow beyond the display;
- the status row, task row, screen body, alerts, and unbounded collections can compete for height;
- the shared office controls are 32–40 px high while a gloved floor target must be at least 64 px;
- shift cards, closed boxes, conflicts, and setup sections grow vertically instead of staying within a fixed viewport;
- the work screen gives similar visual weight to every fact instead of making the latest scan and current box state dominant;
- full-screen scan signals use white text on semantic solids whose current values do not provide sufficient contrast;
- the Tauri shell already has lockdown commands, but the web application does not engage them;
- first-run enrollment still asks for a server URL and plaintext API key instead of the accepted short pairing code;
- revocation currently deletes the station row after deleting its key, conflicting with durable history and existing `sscc_blocks` foreign keys.

The redesign must improve the workplace without changing the offline journal, scan ownership, box, exception, printing, or synchronization semantics that already protect factory continuity.

## Goals

1. Make every station state usable at 1280×800 and 1024×768 with no document, screen, or nested-region scrolling.
2. Make the latest scan, current aggregation container, and recovery action understandable at a glance and operable with a finger or glove.
3. Replace normal station enrollment with the approved 8-digit pairing flow while preserving a hidden service recovery path.
4. Reuse the hardened kiosk pairing security mechanics without coupling station and kiosk records through a polymorphic table that cannot enforce real foreign keys.
5. Keep station identity, SSCC allocation history, audits, and unsynchronized local work recoverable across revoke and re-pair operations.
6. Provide one cabinet Devices surface for stations and kiosks without breaking the existing kiosk runtime contract.
7. Separate automated verification from browser, Windows, scanner, printer, sound, and real-network acceptance.

## Non-goals

- Rewriting scan, sync, box, exception, or print business rules.
- Replacing `@markiro/ui` or introducing a second design-token system.
- Marketing layout, scroll storytelling, GSAP, remote fonts, or runtime CDN assets.
- Changing operator-login API validation, which remains 3–12 digits.
- General leading-zero normalization. Only device entry shorter than three digits is padded; broader normalization is a separate backend task.
- Implementing subscription billing or device-plan enforcement. No subscription-limit source exists today. The Devices header leaves room for a future quota but displays no fabricated limit.
- Enforcing a production line as an authorization boundary. The assigned line is the station's default shift filter and displayed place; tenant authorization remains the security boundary.
- Reworking the kiosk pickup flow. Kiosk pairing receives regression coverage because its security core is shared.

## Approved design decisions

### Target displays

- Required: 1280×800 and 1024×768.
- Secondary verification: 1280×1024.
- Production Tauri runs in lockdown/fullscreen mode; development stays windowed and resizable.
- `html`, `body`, `#root`, and the station root are exactly `100dvh` with `overflow: hidden`.
- No transform-based whole-app scaling.
- A compact layout activates at or below 1100 px, while floor text stays at least 18 px and active controls at least 64×64 px.

### Layout direction

The approved work-screen composition is **Instrument Split**:

- left: dominant latest-scan result and current box fill;
- right: essential counters and four to six recent operations;
- fixed bottom actions: Exceptions and Pause / Finish shift.

The approved exceptions flow is **Action First**:

- choose a large action first;
- scan or select the target second;
- choose one of four to six preset reasons where required;
- use a full-screen input for “Other reason”.

The approved setup flow is **Guided Tabs**:

- Scanner, Printer, and Sound tabs;
- direct tab access plus a sequential Next action;
- fixed action footer;
- setup remains reachable before pairing.

The visual language stays dark, mechanical, restrained, and based on bundled IBM Plex Sans / Mono. Motion is limited to pressed-state feedback, short state changes, and the existing timed scan verdict. No interface depends on hover.

## Station application shell

The root is a fixed-height flex column:

1. `StatusBar`, 52–56 px.
2. Active screen slot, `flex: 1; min-height: 0; overflow: hidden`.
3. Contextual action footer, 72 px when required.

The current empty task-navigation row is removed. Screens fill the active slot. Collections render a fixed page size for the target viewport and use large Previous / Next controls; no station region scrolls. Long values truncate inside bounded areas with an accessible full label rather than expanding the shell.

The shared stylesheet receives only generic document reset and font inheritance. Station-only viewport locking, compact breakpoints, touch feedback, and grids live in `apps/station/src/station.css`, so office applications retain normal scrolling.

## Floor component contract

`@markiro/ui` remains the source of tokens and semantics. It gains explicit floor sizes where controls currently expose only office sizing:

- floor Button: 64 px minimum height, 18 px minimum label;
- floor Input / Select: 64 px control height, 18 px minimum value and label;
- PinPad: fixed 3-column keypad with 80–96 px keys depending on viewport height;
- floor pager: large Previous / Next buttons plus textual page state;
- full-screen dialog: replaces small modal-shaped station interactions;
- semantic solid foreground tokens (`--fg-on-ok-solid`, `--fg-on-err-solid`, `--fg-on-warn-solid`, `--fg-on-info-solid`) verified against their backgrounds.

Station code consumes these variants instead of recreating office controls with inline overrides.

## Commissioning architecture

### Chosen approach

Use one shared pairing-security core with device-specific storage and provisioning adapters:

- keep `kiosk_pairing_codes` and its real kiosk foreign key;
- add `station_pairing_codes` with a real composite tenant/station foreign key;
- reuse one implementation for code format, HMAC hashing, TTL, attempt budgets, collision retry, and source normalization;
- keep device-specific conditional claim and provisioning behavior in narrow kiosk and station adapters;
- retain the historically named `kiosk_pair_attempts` table initially, documenting that it protects every unauthenticated device-pairing route.

A copied station-only service was rejected because security fixes would drift. A universal polymorphic devices/code table was rejected because it would remove enforceable foreign keys and require a risky migration of established history.

### Cabinet flow

The cabinet gains `/devices` and replaces the Kiosks navigation item with Devices. `/kiosks` remains a compatibility route redirecting to `/devices?type=kiosk`.

The page contains:

- a bounded, server-paginated combined list;
- type and lifecycle filters;
- name, type, place, state, and last activity;
- an Add device right-side drawer;
- a reserved quota area that renders only authoritative future data;
- actions to issue/regenerate a code, print instructions, change place, re-pair, and revoke.

Creating a station collects name and an existing `lineId`. Creating a kiosk retains the current kiosk fields and uses its location as the displayed place. The combined list is a read model; type-specific storage and mutation services remain authoritative.

The code state reveals an 8-digit code once, renders the same value as a barcode, shows a 15-minute countdown, and offers Copy, Regenerate, and Print instructions. Regeneration retires every previous live code for that device.

The printable instruction sheet is a high-contrast browser-print document, not a label-printer payload. It names the organization, device type, device, place, issue/expiry time, code, barcode, and numbered pairing steps.

### Device flow

The normal first-run station screen offers:

- an 8-digit numeric field and large keypad;
- direct scanner capture of the same code;
- Scanner / Printer / Sound setup before pairing;
- a collapsed on-prem server field;
- a hidden service-mode entry for the legacy server URL + API key flow.

The SaaS build pins the server origin and shows no editable address. On-prem accepts only HTTPS without embedded credentials and relies on platform TLS verification; an insecure or unreachable endpoint has a distinct error.

Visible states are waiting, redeeming, invalid, expired, locked/rate-limited, no network/server unreachable, success, and credential-invalid/re-pair required. Success names the assigned line, stores the bundle, then opens operator login.

### Provisioning response

Station redemption returns:

- device ID and name;
- tenant/organization identity required for local display;
- assigned line ID and name;
- per-device station API key;
- canonical server URL;
- current org-wide operator roster.

The station persists `deviceId`, `tenantId`, `apiKey`, and `serverUrl` through the existing Tauri config boundary, whose Unix file mode is already owner-only. It publishes the roster through the existing double-buffered SQLite mirror. A roster-publish failure must not present the device as ready; a config-write failure must not erase the previous local journal.

### API-key creation and atomicity

Better Auth API-key creation is outside the Drizzle transaction used to claim the pairing row. The station adapter uses a compensating pattern:

1. read the live station-code candidate;
2. build the roster before consuming the code;
3. mint a candidate per-device API key using the cabinet user recorded when the code was issued;
4. transactionally claim the code and attach the key ID to the same station row;
5. return the plaintext key only after commit;
6. delete the candidate key if the claim loses a race or fails.

The conditional claim prevents two concurrent winners. Compensating deletion prevents a failed redemption from leaving an untracked live credential.

## Station device model and lifecycle

`station_devices` becomes a durable record:

- `api_key_id` becomes nullable;
- `line_id` is a nullable composite tenant foreign key for backwards compatibility;
- `paired_at` and `revoked_at` are nullable;
- existing `enrolled_at` values are retained as the creation timestamp to avoid a destructive rename-only migration;
- ordinary revoke and re-pair never delete the row.

`station_pairing_codes` contains tenant/station identity, HMAC code hash, expiry, used/retired time, attempts, issuer user ID, and creation time. Only one unspent code per station and one live code hash globally are database-enforced.

| State              | Derived from                              | Cabinet presentation | Device behavior                  |
| ------------------ | ----------------------------------------- | -------------------- | -------------------------------- |
| `awaiting_pairing` | no key and `revokedAt` null               | Awaiting pairing     | pairing screen                   |
| `online`           | active key and recent `lastSeenAt`        | Online               | normal working mode              |
| `offline`          | active key and stale/missing `lastSeenAt` | Offline, last seen…  | normal offline mode              |
| `revoked`          | `revokedAt` set and no active key         | Revoked              | recovery/pairing on next contact |

Station `lastSeenAt` updates only after a key verifies and resolves to a device. Online/offline is a presentation threshold, not a stored enum.

Re-pair rotates the credential for the same `deviceId`, clears `revokedAt`, and keeps line assignment and history. Changing the line does not rotate the credential. The assigned line filters shift selection by default but is not a cross-line authorization rule in this slice.

Revoke first invalidates the key, then marks the device revoked and retires pairing codes. Credential invalidation remains security-critical even if the lifecycle update later fails; reconciliation tests and diagnostics cover that bookkeeping debt.

For lifecycle consistency in the combined Devices surface, kiosk revoke/unbind also clears its device token and live codes while retaining the kiosk record and pickup history. The migration scrubs token hashes already retained on archived kiosks; reactivation can therefore never resurrect an old credential.

## Local revoke and recovery semantics

A network failure never clears station authorization. An authenticated server `401` from a previously enrolled station means its credential is no longer accepted and moves the UI into credential recovery.

The device clears the rejected key, reproducible tenant/line/operator caches, and transient UI state. It does **not** delete:

- unsent scan outbox rows;
- unsent box closures;
- unsent exception facts;
- current local journal and conflict evidence;
- stable machine/install identifiers.

Those records become a sealed recovery queue. Pairing displays its count without exposing codes. Re-pairing the same device restores the same `deviceId` and lets the existing retry-safe sync protocol continue.

“Reset station” is a separate service action. It requires a destructive full-screen confirmation, displays unsynchronized counts, and is disabled by default while unsynchronized facts exist. Ordinary revoke never performs a factory reset.

## Operator sign-in

Sign-in tiers are:

1. badge scan, primary;
2. numeric login plus PIN, secondary;
3. name search, fallback, showing at most five matches and never the whole roster.

The login API and stored value stay exactly 3–12 digits. Device entry applies only this convenience rule:

```text
"1"   -> "001"
"12"  -> "012"
"123" -> "123"
```

An entry already three or more digits is unchanged. Therefore `123` does not match stored `000123`. No normalized column or credential migration belongs to this work.

PIN remains 4–6 digits. Wrong login and wrong PIN use one generic error and retain the existing dummy-hash timing equalization. Name search runs against the local roster; selecting a result identifies the login but never bypasses PIN verification.

## Working mode

### Status bar

The bar shows only station, line, operator, shift, connectivity, synchronization, and actionable hardware state. At compact width, related values collapse into labelled status groups instead of wrapping. Conflict and pending counts remain text-plus-number, never color alone.

### Work screen

The dominant left instrument contains:

- latest verdict and product identity;
- the relevant code suffix, never unnecessary full sensitive payload;
- open-box count/capacity and fill visualization;
- immediate recovery for the last scan when eligible.

The right rail contains:

- accepted / duplicate / rejected / pending counters appropriate to shift mode;
- four to six recent operations;
- explicit local/server state when synchronization is degraded.

The footer contains Exceptions and Pause / Finish shift. Critical handling remains on the existing sequential scan queue. UI extraction must not introduce effects or callbacks that reorder scan, undo, close, or print operations.

### Scan signals

Success, warning/duplicate, and error remain full-screen, sound-assisted signals. Each uses text and icon in addition to color. Success times out; a critical recovery state stays until acknowledged. Foreground/background pairs meet WCAG AA for large text, with AAA preferred for the main title.

### Exceptions

The first screen presents large action cards for Undo last scan, Clear open box, Reprint label, and Disassemble box. The chosen action then receives its target. Reprint and Disassemble use four to six presets plus Other reason; Other opens a full-screen input. Existing rules remain authoritative: Undo is immediate, Clear confirms, Reprint requires reason, Disassemble requires reason plus irreversible confirmation.

Closed boxes render in fixed-size pages. No box-history scroll is allowed.

### Conflicts

Conflicts remain reviewable and never interrupt scanning. The dedicated screen uses fixed-height cards, bounded pagination, a local/server explanation, and Back. A read failure stays distinct from an empty state.

### Equipment setup

Scanner, Printer, and Sound are three bounded tab panels. Each has current state, one primary test action, inline result, and required fields. The bottom bar contains Back and Save / Next. Native range/checkbox controls are replaced or wrapped with touch-sized labelled controls while retaining keyboard and screen-reader operation.

## Error handling

- Pairing errors use stable machine-readable codes so the station distinguishes invalid, expired, locked, rate-limited, and unavailable without parsing translated text.
- An invalid code never reveals tenant or device information to an unauthenticated caller.
- Code issuance and credential mutations write exact security-audit actor, tenant, action, resource, and outcome fields.
- A provisioning failure before commit leaves the code redeemable unless the attempt legitimately consumes its failure budget.
- A lost response after commit spends the code; the cabinet can issue a new one for the same device.
- A failed roster refresh after pairing leaves the last complete double-buffered roster active.
- Offline work is not a generic error: the UI names what is local, pending, or requires intervention.
- Long text, large counts, translations, and supported OS text scaling must not create scrolling. Tests use worst-case copy.

## Accessibility and touch requirements

- 64×64 px minimum floor target; 80–96 px keypad digits.
- 18 px minimum floor text.
- Visible `:focus-visible` and logical keyboard order remain mandatory.
- `touch-action: manipulation`; pressed feedback is a one-pixel translation with no disabled transform.
- No hover-only affordance, drag-only control, or small close icon as the sole exit.
- State is never communicated by color alone.
- Full-screen dialogs trap and restore focus.
- RU and EN are both exercised with long strings.

## Verification strategy

### Automated

- DB schema/migration tests, composite tenant foreign keys, and preservation of existing station rows.
- Pairing tests for format, HMAC, TTL, single use, collisions, five-attempt lock, source/global limits, concurrency, tenant isolation, key rollback, and kiosk regression.
- API e2e for create, list, issue, re-pair, reassign, revoke, audit, and device-key denial.
- Station tests for pairing states, config persistence, roster publish, `401` recovery, sealed queues, and restart.
- Login tests for `1 -> 001`, `12 -> 012`, exact matching from three digits, PIN bounds, badge flow, and bounded name search.
- Component tests for shell regions, page boundaries, action flows, focus, and translated names.
- Package test/typecheck/lint/build gates; rebuild `@markiro/db` before API consumers.

### Browser

Exercise meaningful states at 1280×800, 1024×768, and 1280×1024. Every state must satisfy:

```text
document.documentElement.scrollWidth  === window.innerWidth
document.documentElement.scrollHeight === window.innerHeight
document.querySelectorAll('[data-scroll-region]').length === 0
```

Review pairing, login, shift selection, work verdicts, full/recovering box, exceptions, reasons, conflicts, setup tabs, offline, sync-stuck, credential recovery, and long RU/EN content.

### External acceptance

Physical scanner, printer, sound, Windows/Tauri fullscreen and close blocking, certificate validation in the deployed on-prem topology, sudden network loss, and power-cycle recovery require separate checks. DOM or host-only Rust tests do not prove them.

## Delivery decomposition

Implementation is split into two plans:

1. `2026-08-06-station-device-pairing-lifecycle.md` — database, pairing security, API, unified cabinet Devices, provisioning, revoke/re-pair recovery.
2. `2026-08-06-station-fullscreen-touch-ui.md` — floor variants, viewport shell, login, work instrument, exceptions, setup, pagination, signals, and Tauri lockdown.

The pairing plan lands first because it establishes the real first-run state and durable identity. Visual components may be developed independently but integrate against the pairing state machine only after its contracts are stable.
