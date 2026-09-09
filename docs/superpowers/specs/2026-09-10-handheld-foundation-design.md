# Handheld (TSD) foundation — design spec

**Date:** 2026-09-10

**Status:** Approved in brainstorming on 2026-09-10; implementation plan pending

**Scope:** First implementation slice of design brief 10
(`docs/design-briefs/10-tsd-handheld.md`): the `handheld` device kind on the
server and in the cabinet, and a native Android app that pairs, signs an
operator in offline, shows the hub, and receives scans from an industrial
handheld's built-in scanner. Shifts, scans, sync, printing, inventory and
code check are later slices.

## Outcome

A handheld runs the Markiro Android app, is added in the cabinet as «ТСД»
bound to a line, pairs with the same 8-digit code flow the station uses,
downloads the operator roster, signs an operator in by badge or login + PIN
without a network, and shows the hub with live shift and inventory counts.
The cabinet's Devices list shows it with type `handheld`; it consumes one
`stations` slot of the subscription. On the wire the handheld is a station
device: every station-only endpoint keeps working unchanged.

## Decisions

| Decision              | Choice                                                                                                                                                             | Why                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Server identity       | A `kind` column on `station_devices` (`station` \| `handheld`), same Better Auth API key, same `POST /station/pair`, same `StationOnlyGuard` endpoints             | Everything the handheld needs is already station-scoped; a separate table would duplicate seven controllers or widen every guard            |
| Quota                 | Both kinds are counted in the `stations` entitlement; no `handhelds` key yet                                                                                       | Brief 07 allows a later per-type split; a new key would drag the plan catalog, SaaS admin and billing into this slice                       |
| Kind ↔ client match   | The app sends `x-station-capabilities: handheld-v1`; pairing rejects a mismatch with `401 PAIR_KIND_MISMATCH`                                                      | A station code redeemed by the handheld app (or the reverse) would leave a device whose kind and behaviour disagree                         |
| App stack             | Kotlin, Jetpack Compose + Material 3 themed from the `hh/*` tokens, Hilt, Room, OkHttp + Retrofit + kotlinx.serialization, Navigation Compose                      | Native Kotlin was decided in brief 10; these are the mainstream, offline-friendly defaults                                                  |
| Targets               | `minSdk 28`, `targetSdk 35`, `compileSdk 35`, portrait only                                                                                                        | Rugged Datalogic and Honeywell devices from 2019 on run Android 9+; SDK 35 is installed on the dev machine                                  |
| Scan input            | A `ScanSource` abstraction with keyboard-wedge, vendor-intent (Datalogic, Honeywell, Zebra) and debug sources                                                      | The first devices are Datalogic and Honeywell, not Zebra, so DataWedge cannot be the only path                                              |
| Offline operator auth | Port of the station's PHC verifier (`pbkdf2$sha256$<iter>$<saltB64>$<hashB64>`, 256-bit, ≥ 10 000 iterations, constant-time compare, dummy PHC for unknown logins) | The roster mirror delivered at pairing already carries these hashes; the handheld must verify them byte-for-byte the same way               |
| Repository placement  | `apps/handheld/` as a Gradle project with a committed wrapper, outside the pnpm workspace, with its own CI job                                                     | Gradle and pnpm do not share a toolchain; the repo already keeps Rust shells (station, signer) beside the TypeScript workspace the same way |

## Server

### Database

- New migration (next number after `0122`): `ALTER TABLE station_devices ADD
COLUMN kind text NOT NULL DEFAULT 'station'` with a check constraint
  `station_devices_kind_check CHECK (kind IN ('station', 'handheld'))`.
- Drizzle schema in `packages/db/src/schema/platform.ts` gains
  `kind: text("kind").notNull().default("station")` and the check.
- The station SQLite mirror is not changed: the device stores its own kind in
  its local config, not in the mirror schema.
- Migration and schema tests: the column exists with the default, the check
  rejects other values, existing rows read back as `station`.

### API

- `apps/api/src/modules/devices/dto.ts`: `deviceTypes` becomes
  `["station", "kiosk", "handheld"]`. `DevicesService.stationDto` maps
  `kind === "handheld"` to `type: "handheld"`; the `type` filter of
  `GET /devices` accepts it. The OpenAPI `place` description mentions the
  handheld's line.
- `apps/api/src/modules/station-devices/dto.ts`: create and update schemas
  accept `kind: z.enum(["station", "handheld"]).default("station")`;
  `StationDeviceDto` returns `kind`. `StationDevicesService.create` stores it
  and keeps consuming the `stations` entitlement through the existing
  `EntitlementsService` path. `update` may change `kind` only while the
  device is `awaiting_pairing` (unpaired); afterwards the kind is fixed
  (`409`).
- `apps/api/src/modules/station-pairing`: `PairStationResultDto.device` and
  `StationIdentityResultDto.device` gain `kind`. `redeem` receives the parsed
  capability set; when the device's kind is `handheld` and the client lacks
  `handheld-v1`, or the kind is `station` and the client sends
  `handheld-v1`, it answers `401 { code: "PAIR_KIND_MISMATCH" }` without
  consuming the code. `StationPairErrorCode` and the OpenAPI enum list the
  new code.
- `x-station-capabilities` parsing stays where it is (`hasCapability`);
  `PAIR_KIND_MISMATCH` is documented next to the other pairing errors.
- Audit action names (`station_device.*`, `station_pairing_code.issue`)
  are unchanged; the audit metadata of `create` includes `kind`.

### Cabinet (`apps/admin`)

- `pages/devices/DeviceDrawer.tsx`: the type options become station, kiosk
  and `handheld` («ТСД» / "Handheld"), gated like station
  (`allowStation`), with the same line picker. Create posts to
  `/station-devices` with `kind: "handheld"`; pairing-code, reassign and
  revoke reuse the station paths.
- Devices list and filter render the third type; the printable pairing
  instruction sheet names the device type «ТСД».
- i18n: `pages.devices.type.handheld` in `ru.json` and `en.json`.
- Tests: the drawer offers the option and posts `kind`, the list renders the
  type, the filter passes `type=handheld`.

## Android app (`apps/handheld`)

### Project

- Gradle Kotlin DSL, version catalog `gradle/libs.versions.toml`, committed
  `gradlew`. Application id `app.markiro.handheld`. Build types `debug`
  (debug scan source, editable server address) and `release` (SaaS origin
  pinned through `BuildConfig`, server-address field hidden as brief 07
  requires for the SaaS build).
- `.prettierignore`, `.gitignore` (Gradle build outputs, `local.properties`)
  and `.graphifyignore` updated for the new directory.
- One module `app` with packages
  `core/design`, `core/scan`, `core/network`, `core/storage`, `core/auth`,
  `feature/pairing`, `feature/signin`, `feature/hub`, `feature/settings`.
  Splitting into Gradle modules is deferred until a second app or shared
  library needs it.

### Design system (`core/design`)

- `MarkiroTheme` with dark and light color schemes taken from
  `packages/ui/src/tokens.css` (the same values the Pencil canvas uses),
  IBM Plex Sans and Plex Mono bundled as font resources, the handheld type
  ramp (`hh-body` 16, `hh-strong` 18, `hh-title` 22, `hh-code` mono 20,
  `hh-counter` mono 40, `hh-counter-lg` mono 56, tabular numerals), spacing
  and radius scales, control heights 64 / 56 / 48 and keypad 72.
- Composables mirroring the `hh/*` components needed by this slice:
  `StatusStrip`, `AppBar`, `PrimaryButton`, `SecondaryButton`, `TextButton`,
  `Keypad`, `PinDots`, `Tile`, `Chip`, `Banner`, `FullScreenState`.

### Scan input (`core/scan`)

- `interface ScanSource { val events: Flow<ScanEvent>; fun start(); fun stop() }`
  where `ScanEvent(raw: String, symbology: String?, source: String,
at: Instant)`. `raw` preserves the GS1 group separator (`\u001d`);
  sources normalise vendor substitutes (for example a configured `]d2`
  prefix or a literal `<GS>` token) back to `\u001d` before emitting.
- `KeyboardWedgeScanSource`: captures key events at the activity level into a
  buffer terminated by Enter (or a configurable suffix), with a short
  inter-key timeout, and never lets wedge characters reach focused text
  fields.
- `IntentScanSource` driven by a `VendorProfile(action, dataExtra,
symbologyExtra, setupHint)`: profiles for Datalogic, Honeywell and Zebra
  DataWedge, default chosen from `Build.MANUFACTURER`, overridable in
  Settings. The exact action and extra names are taken from the vendor
  documentation during implementation and recorded in the profile with a
  source link; they are not verified on hardware in this slice.
- `DebugScanSource` (debug builds only): a broadcast
  `app.markiro.handheld.DEBUG_SCAN` with a string extra, plus a hidden text
  field on the test-scan screen, so the emulator can exercise every flow.
- `ScanRouter` delivers events to the screen that currently owns the scanner
  (pairing, sign-in, hub, test scan); no screen registers a receiver itself.

### Network and storage

- `core/network`: Retrofit client with `x-api-key`, `x-station-capabilities:
handheld-v1,subscription-state-v1`, 30 s timeouts, an unauthenticated
  path for `POST /station/pair`, and a `401 STATION_CREDENTIAL_REVOKED`
  interceptor that raises a revocation event.
- `core/storage`: Room database with `device_config` (device id, name,
  tenant, organisation, line, kind, server URL, paired at), `operators`
  (the roster mirror: operator id, name, login, role, pin hash, badge hash,
  active) and `roster_meta` (generation, fetched at). The API key is stored
  in `EncryptedSharedPreferences` backed by the Android Keystore, never in
  Room or logs.
- Roster refresh: `GET /station/operators` on app start and after sign-in
  when online; a failed refresh keeps the previous roster.

### Offline operator auth (`core/auth`)

- `PhcVerifier.verify(secret, phc)`: parses the five `$`-separated parts,
  requires `pbkdf2` and `sha256`, rejects iterations below 10 000, derives
  256 bits with `PBKDF2WithHmacSHA256`, compares in constant time.
- `OperatorAuth.byLogin(login, pin)`: PIN must be 4–6 digits, login 1–12
  digits padded to at least three (`padStart(3, "0")`); looks up the active
  operator by login and verifies the PIN, running the verifier against a
  dummy PHC when no operator matches so timing does not reveal valid
  logins.
- `OperatorAuth.byBadge(code)`: verifies the scanned string against every
  active operator with a badge hash.
- `OperatorAuth.search(prefix)`: case-insensitive prefix match on name,
  returns at most five.
- Session: signed-in operator held in memory and in `device_config`; idle
  lock after five minutes (constant for now), unlock by PIN of the same
  operator or by badge.

### Screens (feature packages)

All copy comes from the brief and the Pencil canvas; RU is the default
locale, EN mirrors it through resource qualifiers.

- `feature/pairing`: enter (keypad, scan hint, collapsed server address in
  debug builds), binding progress, `PAIR_INVALID` / `PAIR_EXPIRED`,
  `PAIR_LOCKED` / `PAIR_RATE_LIMITED`, network error, `PAIR_KIND_MISMATCH`
  («Этот код выпущен для станции» with the instruction to add a ТСД in the
  cabinet), success naming the line. A scan on this screen is treated as
  the code when it is eight digits.
- `feature/signin`: badge-or-login (upper block listens for a badge scan,
  keypad enters the login), PIN, name search, lock. Errors: wrong PIN
  (inline), operator not found, roster unavailable.
- `feature/hub`: header (organisation, operator, line, sign-out), tiles
  «Смена» (count of open shifts for the device's line from `GET /shifts`),
  «Инвентаризация» (count from `GET /station/inventory-tasks`), «Проверка
  кода», «Настройки»; counts are cached and shown with «данные на HH:MM»
  when offline. Shift, inventory and code check tiles open a full-screen
  state «В следующем срезе». The trigger on the hub opens the same
  placeholder for now.
- `feature/settings`: list, «Сканер» (source picker and test scan showing
  the raw string with GS chips), «Язык», «Тема», «Об устройстве» (name,
  line, server, version, roster fetched at). No printer or sound screens in
  this slice.
- `StatusStrip` shows network reachability (last successful request),
  «Очередь 0», «Принтер не настроен», scanner source status.
- Revocation: on `STATION_CREDENTIAL_REVOKED` the app wipes the credential,
  roster and config and returns to pairing, matching brief 07.

## Testing

- `packages/db`: migration and schema tests for `kind`.
- `apps/api` (vitest, real Postgres): create a handheld and a station,
  `GET /devices` lists and filters both, entitlement usage counts both under
  `stations`, `kind` is immutable after pairing, pairing with and without
  `handheld-v1` returns the expected result or `PAIR_KIND_MISMATCH` without
  burning the code, `identity` returns `kind`.
- `apps/admin` (vitest): drawer options and payload, list rendering, filter.
- `apps/handheld` JVM unit tests: `PhcVerifier` against vectors generated by
  the station's `hashSecret` (a small Node script in `apps/handheld/tools`
  writes the fixture), login padding and PIN rules, dummy-PHC path, wedge
  buffer and GS normalisation, intent extraction per vendor profile, pairing
  state machine, revocation handling.
- Compose UI tests with Robolectric for pairing, sign-in and hub states.
- Gate: `./gradlew testDebugUnitTest lintDebug assembleDebug`.

## CI

- New job `handheld` in `.github/workflows/ci.yml` behind
  `classify-changes` (path filter `apps/handheld/**` plus the workflow
  itself), using JDK 17, the Android SDK action and Gradle caching; it runs
  the gate above. `ci-required` treats it like the other selective jobs.
- `pnpm` workspaces, turbo and prettier ignore `apps/handheld`.

## Manual verification (reported separately from automated checks)

- Emulator API 34 against the local API (`docker-compose.dev.yml`): add a ТСД
  in the cabinet, pair with the code, sign in with a seeded operator by PIN
  and by a debug badge scan, see hub counts, lock and unlock, revoke from
  the cabinet and watch the app return to pairing.
- Datalogic and Honeywell hardware, vendor intent profiles and the hardware
  trigger are not exercised in this slice and are reported as unverified.

## Out of scope

Shifts, scan journal, outbox and sync; signals and sounds; printing;
inventory; code check; camera scanning; Bluetooth scanners; reverse
aggregation; a `handhelds` entitlement; multi-module Gradle layout;
Play Store or MDM distribution (the debug APK is installed by `adb`).

## Risks and open points

- Vendor intent action names are taken from documentation, not devices; a
  wrong name only affects the intent source, the keyboard wedge remains as
  the fallback.
- `EncryptedSharedPreferences` is deprecated upstream but still functional
  on API 28–35; the storage class is isolated so it can be swapped for a
  Keystore-wrapped file later.
- The hub's shift count depends on `GET /shifts` semantics for a device's
  line; the plan checks the existing filter before wiring it.
