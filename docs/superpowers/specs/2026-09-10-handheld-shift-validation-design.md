# Handheld (TSD) shift validation — design spec

**Date:** 2026-09-10

**Status:** Approved in brainstorming on 2026-09-10; implementation plan pending

**Scope:** Second implementation slice of design brief 10
(`docs/design-briefs/10-tsd-handheld.md`), on top of the foundation slice
(`2026-09-10-handheld-foundation-design.md`, merged in #473): the handheld
lists and enters shifts, validates product codes offline with the station's
rules, keeps a local journal and outbox, syncs scan batches with the same
protocol as the line station, shows the team and sync conflicts, and closes a
shift from the device. Both UI languages ship with every screen. Aggregation,
printing, exceptions, ad-hoc shift creation, inventory and code check are
later slices.

## Outcome

An operator on a handheld picks a shift of their line (or continues the one
this handheld already works in), scans units one by one and sees, hears and
feels the verdict — accepted, wrong code, wrong GTIN, duplicate — within the
same second, online or not. Scans queue on the device and reach the server
in the station's batch format, so the cabinet counts, conflicts and shift
history look exactly as they do for a desktop station. The operator can leave
the shift (pause this terminal) or close it, with a close reason when the
plan was not met; the cabinet can still close any shift. The app is fully
usable in Russian and English.

## Decisions

| Decision            | Choice                                                                                                                                                                                          | Why                                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Protocol            | Port the station's shift protocol 1:1: `POST /shifts/:id/enter`, `GET /shifts/:id/bundle`, `POST /station/scans` batches with pinned ceilings and an install id, `POST /station/shift-closures` | The server already has the semantics (earliest-scan-wins, batch idempotency, close authority); a second protocol would double the server surface and the cabinet's cases |
| Code identity       | Kotlin port of `canonicalizeKm` / `kmHash`: SHA-256 of `01<gtin14>21<serial>`, crypto tail (91/92/93) excluded; verified against fixtures exported from `packages/domain`                       | The server recomputes hash, GTIN and serial from `raw` and rejects the whole batch on a mismatch; the two implementations must agree byte for byte                       |
| Duplicate scope     | Device-wide `codes_mirror` keyed by `code_hash`, not per shift                                                                                                                                  | Same rule as the station: a marking code identifies one physical item whatever shift it is scanned under                                                                 |
| Ad-hoc shifts       | Not in this slice; the handheld only enters shifts created in the cabinet                                                                                                                       | Box capacity and pallets belong to the aggregation slice, which is where «Новая смена» lands                                                                             |
| Shift close         | Both the device and the cabinet can close a shift; the device closes through `POST /station/shift-closures` with the station's reason rules                                                     | Product rule confirmed on 2026-09-10: shifts are closed by the device or the cabinet, inventories only by the cabinet                                                    |
| Duplicate-DM shifts | The app does not send `validation-dm-duplicate-v1`; a `409 STATION_UPDATE_REQUIRED` on enter or bundle is shown as «печать дубликата Data Matrix на ТСД пока недоступна»                        | Printing is a later slice; silently entering a shift whose policy requires a printed and verified duplicate would break the shift's own rules                            |
| Signals             | Synthesised tones with the station's frequencies and durations, plus vibration; mutable in settings                                                                                             | The operator watches the line, not the screen; the station's three distinct pitches are already what the floor knows                                                     |
| Team chip           | `GET /shifts/:id/summary` opens to station credentials for shifts the device participates in                                                                                                    | The data exists only there; a new endpoint would duplicate the participants query                                                                                        |
| Languages           | Every string in `values/strings.xml` (ru) and `values-en/strings.xml`; the foundation screens migrate in this slice                                                                             | Requested at the start of the slice; the cabinet and station already ship ru + en                                                                                        |
| Sync engine         | One process-wide coroutine loop, no WorkManager                                                                                                                                                 | The app is foreground-only on a rugged device; the station's loop with nudges, a heartbeat and exponential backoff is enough and testable                                |

## Server

### `GET /shifts/:id/summary` for station credentials

- Replace `@RequirePermissions(OPERATIONS_READ)` + `@ApiCabinetAuth()` with
  `@AllowStationOrPermissions(OPERATIONS_READ)` and the station-or-cabinet
  OpenAPI auth used by `GET /shifts/:id/bundle`.
- When `req.authKind === "station"`, the service checks that
  `shift_device_participants` has a row for `(tenantId, shiftId, deviceId)`;
  otherwise `403` («Device is not a participant of this shift»). Cabinet
  callers keep today's behaviour.
- The response shape does not change. E2E: a participating handheld reads
  the summary; a non-participating device gets 403; a cabinet user still
  reads it.

### Shared KM fixtures

- `packages/domain/scripts/export-km-fixtures.ts` writes
  `apps/handheld/app/src/test/resources/km-fixtures.json`: an array of
  `{ name, raw, expected }` where `expected` is either
  `{ canonicalRaw, gtin14, serial, ais: {ai: value}, key, hash }` or
  `{ error: "<KM_* | GTIN_INVALID code>" }`. About forty cases: plain
  `01…21…`, crypto tail 91/92/93, `]d2` prefix, leading/trailing space and
  tab, embedded newline (rejected), GS-only tail, empty AI, duplicate AI,
  bad check digit, 8/12/13-digit GTINs, 1024-byte boundary, surrogates,
  U+FFFD, verdict cases (wrong GTIN, duplicate) with an `expectedGtin14`
  context.
- `packages/domain/test/km-fixtures.test.ts` regenerates the fixtures in
  memory and asserts deep equality with the committed file, so a change to
  the parser fails CI until the fixtures (and therefore the Kotlin tests) are
  refreshed.

Nothing else changes on the server. No migration.

## Android app

### Storage (Room, database version 2)

New entities, all wiped by `DeviceWipe`:

- `shift_mirror`: `id` PK, `number`, `status` (`planned|active|closed`),
  `mode`, `product_id`, `product_name`, `product_print_name`,
  `product_gtin14`, `line_id`, `line_name`, `counterparty_name`,
  `planned_qty`, `planned_date`, `production_date`, `box_capacity`,
  `pallet_capacity`, `pallets_enabled`, `validation_print_mode`,
  `close_policy_kind`, `close_owner_device_id`, `opened_at`,
  `bundle_fetched_at`, `entered_at`, `left_at`, `list_fetched_at`.
  Rows come from `GET /shifts` (list cache) and are enriched by the bundle;
  `bundle_fetched_at IS NOT NULL` marks a shift that can be entered offline.
- `codes_mirror`: `code_hash` PK, `shift_id`, `gtin14`, `serial`,
  `scanned_at`. No shift index for duplicate lookup.
- `scan_events`: `id` autoincrement PK, `shift_id`, `raw`, `verdict`
  (`ok|duplicate|wrong_gtin|invalid`), `scanned_at`, `operator_id`,
  `code_hash` nullable. Feeds the recent-scans list and the counters.
- `outbox`: `id` autoincrement PK, `shift_id`, `raw`, `verdict`,
  `scanned_at`, `operator_id`, `code_hash`, `gtin14`, `serial` (the last
  three non-null only for `ok`). The `id` order is the batch order; Room's
  autoincrement must not reuse ids (`AUTOINCREMENT` in SQLite).
- `conflicts_mirror`: `code_hash` PK, `winning_terminal_id`,
  `winning_scanned_at`, `detected_at`.
- `shift_close_outbox`: `event_id` PK, `shift_id` unique, `operator_id`,
  `planned_qty_snapshot`, `actual_qty`, `closed_box_count` (0 in this
  slice), `reason_code`, `closed_at`, `state` (`pending|conflict`),
  `conflict_code`, `last_checked_at`.
- `meta`: `key` PK, `value`. Keys: `install_id` (random UUID created with
  the database, regenerated only when the database is recreated),
  `sync_pending_batch_id`, `sync_pending_ceiling`, `sync_last_success_at`,
  `sound_muted`, `sound_volume`, `vibration_enabled`,
  `conflict_reconcile_cursor`.

`DeviceConfigEntity` gains `activeShiftId` (nullable) so the hub can pin
«Продолжить».

### Shift list and entry (`feature/shift`)

- `ShiftListViewModel` loads `GET /shifts` without `lineId` (the server scopes
  a station credential to its line plus unassigned shifts), stores the items
  into `shift_mirror` with `list_fetched_at`, and shows:
  1. the pinned card of the shift whose `id == activeShiftId` and status is
     not `closed`, with «Продолжить»;
  2. the device line's shifts (planned, active) as 96 dp cards per brief §4:
     product, plan, mode chip («валидация» / «+ агрегация»), line, tolling
     badge from `counterpartyName`;
  3. «Другие линии»: a second request per other line from the line list
     (`GET /shifts?lineId=`), shown collapsed; entering asks for confirmation.
- Aggregation-mode shifts are listed but not enterable in this slice: the
  card shows «агрегация: в следующем срезе» and is disabled.
- Enter: `POST /shifts/:id/enter` then `GET /shifts/:id/bundle`; the mirror is
  upserted with product GTIN, plan, dates, close policy and
  `bundle_fetched_at`; the roster from the bundle replaces the operator
  mirror (same `RosterStore.replace`); `activeShiftId` and `entered_at` are
  set; navigation goes to the work screen.
- Errors: `409 STATION_UPDATE_REQUIRED` → blocking sheet about duplicate-DM
  printing; `409` closed shift → «Смена уже закрыта» and the list refreshes;
  network failure → if the mirror has the bundle, enter offline (no `/enter`
  call, retried on the next sync tick), else «Сервер недоступен».
- Offline list: cached rows with «данные на HH:MM»; cards without a bundle are
  disabled with «нужна сеть для первого входа».
- Rejoin («Продолжить») calls `/enter` again when online so participation is
  recorded; offline it opens the work screen directly.

### Scan pipeline (`core/km`, `feature/work`)

- `KmCodec` (pure Kotlin, no Android types): `canonicalize(raw)` returning
  `ParsedKm(canonicalRaw, gtin14, serial, ais)` or throwing `KmException(code)`
  with the domain's codes (`KM_EMPTY`, `KM_NO_GTIN`, `KM_BAD_GTIN`,
  `KM_NO_SERIAL`, `KM_BAD_AI`, `KM_EMPTY_AI`, `KM_DUPLICATE_AI`,
  `KM_BAD_ENCODING`, `KM_BAD_CONTROL`, `KM_TOO_LONG`, `GTIN_INVALID`);
  `key(km) = "01" + gtin14 + "21" + serial`; `hash(km)` = lowercase hex
  SHA-256 of the UTF-8 key. Rules mirror `packages/domain/src/gs1/km.ts`:
  trim space and tab only, strip a leading `]d2`, reject U+FFFD and unpaired
  surrogates, reject control characters except GS, cap 1024 UTF-8 bytes,
  grammar `01<14 digits>21<serial>[GS<2-digit AI><value>]*`, GTIN of 8, 12,
  13 or 14 digits with a valid mod-10 check digit normalised to 14.
- `ShiftValidator.verdict(raw, expectedGtin14, isDuplicate)` in the domain
  order: not a KM → `invalid`; GTIN differs → `wrong_gtin`; hash present →
  `duplicate`; else `ok`.
- `ScanRecorder.record(shift, raw, operatorId)` runs under a `Mutex` (one scan
  at a time) inside one Room transaction: for `ok` insert `codes_mirror`
  (an `SQLiteConstraintException` on the primary key turns the verdict into
  `duplicate` and continues), then `scan_events`, then `outbox` (only
  `ok|duplicate|wrong_gtin|invalid` rows; every scan is sent, as the station
  does). Returns `ScanOutcome(verdict, km?, firstSeenAt?)` where
  `firstSeenAt` comes from `codes_mirror` for duplicates.
- `WorkViewModel` subscribes to `ScanEvents`, calls the recorder, publishes
  `WorkUi`: last scan (status word, code tail `…<last 8 of serial>`,
  `firstSeenAt` for duplicates), counters (`total` = accepted for the shift
  across terminals as `bundle`-time `plannedQty` denominator, `thisTerminal`
  = accepted rows in `codes_mirror` for the shift, `errors`, `duplicates`),
  the last four `scan_events`, queue size, team count, conflicts count.
  «Всего» shows `thisTerminal` until the summary provides the shift total
  (see Team), then the larger of the summary's `acceptedUnits` and
  `thisTerminal` (the summary is up to a minute old).
- `Signaller`: tones synthesised with `AudioTrack` (PCM 16-bit, 44.1 kHz):
  `ok` 880 Hz sine 120 ms, `duplicate` 440 Hz triangle 300 ms, `error`
  (`wrong_gtin`, `invalid`) 220 Hz square 450 ms, exponential fade; vibration
  via `Vibrator`: `ok` 40 ms, `duplicate` 2 × 80 ms, `error` 2 × 150 ms.
  Volume, mute and vibration come from `meta`; every failure is swallowed.
- Screen per brief §5: status strip → shift header (product, number, tolling
  badge, «+N» chip, overflow) → last-scan zone (~40 % height, tone colour
  background flash for non-ok) → counters row → feed. Overflow: «Конфликты
  (N)», «Выйти из смены», «Закрыть смену». Hardware trigger is the scanner;
  the debug scan source keeps working.

### Outbox and sync (`core/sync`)

- `SyncEngine` is a `@Singleton` started by `HandheldApp`; it owns one
  coroutine loop on `Dispatchers.IO` and a `nudge()` entry point called after
  every recorded scan, on connectivity regained (`ConnectivityManager`
  callback) and by a 15 s heartbeat. A `Mutex` guarantees a single drain at
  a time.
- Drain step: if `sync_pending_batch_id` is set, re-read exactly the rows
  with `id <= sync_pending_ceiling` (limit 100); otherwise read the first
  100 rows by `id`, then persist `sync_pending_ceiling = maxId` and
  `sync_pending_batch_id = "<deviceId>:<installId>:<maxId>"` before the
  request. An empty outbox with no pending batch ends the step.
- Request: `POST /station/scans` with `{ batchId, items }`, each item
  `{ shiftId, terminalId: deviceId, raw, verdict, scannedAt (ISO-8601 UTC),
code: {codeHash, gtin14, serial} | null, boxId: null, operatorId }`;
  `code` present iff `verdict == "ok"`. Header
  `x-station-capabilities: handheld-v1,subscription-state-v1,station-recovery-v1`
  (the existing `CapabilitiesInterceptor` value extended).
- Response guard: JSON object with `applied: Int` and
  `alreadyApplied: Boolean`, otherwise the attempt fails (nothing acked).
- Commit order: record `conflicts[]` rows (each with a string
  `winningScannedAt` that parses) into `conflicts_mirror` (ignore on
  conflict) → delete `outbox` rows `id <= ceiling` → clear
  `sync_pending_batch_id` then `sync_pending_ceiling` → set
  `sync_last_success_at` → reset backoff. `alreadyApplied` is success.
  `denied[]` is stored under `meta.sync_last_denied` and logged.
- Failure: any exception, non-2xx or malformed response schedules a retry
  with backoff `2 s, 4 s, … 60 s`; the pending batch id and ceiling survive
  process restarts. A 401 with `code == "STATION_CREDENTIAL_REVOKED"` is not
  retried: the existing `RevocationInterceptor` raises the bus and the shell
  wipes the device.
- After a drain that leaves the outbox empty, `drainShiftCloses()` (see
  Close) and then conflict reconciliation: page `conflicts_mirror` by
  `code_hash` ascending, 200 per `POST /station/conflicts/status`, delete
  the returned `reviewedCodeHashes`, stop when a page is short.
- `SyncState` (StateFlow): `pending`, `lastSuccessAt`, `stuck` (pending > 0
  and no success for 15 min), `conflicts`. The hub's status strip shows
  «Очередь N»; the work screen and hub show the offline banner as
  «Работаем офлайн · N сканов в очереди» and, when stuck,
  «Синхронизация застряла · проверьте сеть». `ReachabilityTracker` keeps
  driving the «Сеть / Офлайн» indicator.

### Leave and close (`feature/shift`)

- «Выйти из смены»: sets `shift_mirror.left_at`, keeps `activeShiftId` (so
  the hub pins «Продолжить»), returns to the hub. Nothing is sent.
- «Закрыть смену»: confirmation sheet with accepted count, errors and
  duplicates; when `plannedQty != null && plannedQty != accepted`, a reason
  step with the six `SHIFT_CLOSE_REASON_CODES` as radio rows. Then
  `ShiftCloser.close()` in one transaction: insert `shift_close_outbox`
  (`eventId` random UUID, `plannedQtySnapshot` from the mirror, `actualQty`
  = accepted rows in `codes_mirror` for the shift, `closedBoxCount` 0,
  `closedAt` now), set the mirror `status = closed`, clear `activeShiftId`.
  A unique violation on `shift_id` means the close already exists and its
  row is reused.
- Drain screen: «Отправляем сканы… N осталось» bound to `SyncState.pending`
  with the engine nudged; `drainShiftCloses()` posts each pending row to
  `POST /station/shift-closures` with `{ eventId, shiftId, operatorId,
plannedQtySnapshot, actualQty, closedBoxCount, reasonCode, closedAt }`;
  `accepted` and `already_resolved` delete the row, `conflict` marks it
  `state = conflict` with `conflictCode`. Network failures leave it pending
  and the summary still opens.
- Summary: accepted, errors, duplicates, conflicts, per-terminal rows from
  the last summary response when available, plus one of: «Смена закрыта»,
  «Смену закроет кабинет: работало несколько устройств» (conflict) or
  «Закрытие отправится, когда появится сеть» (still pending). «В хаб».

### Team and conflicts (`feature/work`)

- `TeamRefresher` calls `GET /shifts/:id/summary` on entering the work
  screen and every 60 s while it is visible and the device is reachable;
  the response is cached in memory with its `generatedAt`. The «+N» chip
  shows `participants.size - 1` (never negative) and opens a bottom sheet:
  one row per participant with name, accepted scans and last activity;
  «данные на HH:MM» when older than the last minute. A 403 (device not yet
  a participant, e.g. entered offline) hides the chip until the next success.
- Conflicts screen: `conflicts_mirror` rows as cards «<code tail> · терминал
  <id tail> · <time>», sorted by `detected_at` desc, with the caption that
  the cabinet resolves them. Reachable from the work screen overflow and
  from the offline banner when `conflicts > 0`.

### Two languages

- Every user-visible string of the app lives in
  `app/src/main/res/values/strings.xml` (Russian, default) and
  `values-en/strings.xml`; Composables call `stringResource`. The foundation
  screens (pairing, sign-in, hub, settings, scanner, coming-soon) are migrated
  in this slice, including `VendorProfiles` labels and setup hints.
- Counts use `<plurals>` (shifts, tasks, scans, participants, boxes).
- Scan status words reuse the station's wording: ПРИНЯТО / НЕВЕРНЫЙ КОД /
  ЧУЖОЙ ГТИН / ДУБЛЬ and ACCEPTED / WRONG CODE / WRONG GTIN / DUPLICATE.
- Times and numbers go through `java.text.NumberFormat` and
  `DateTimeFormatter.ofPattern("HH:mm", locale)`; dates «10.09» stay
  numeric in both languages.
- A Robolectric test renders the hub and work screen under `en` and asserts
  no Cyrillic remains; a lint check (`MissingTranslation` as error) guards
  the two files.

### Settings additions

- «Сигналы»: mute toggle, volume slider, vibration toggle, «Проверить»
  buttons for the three tones.
- «Об устройстве» gains «Очередь синхронизации: N · последняя отправка
  HH:MM» and the install id tail for support.

## Testing

- `packages/domain`: fixture export script and drift test; API e2e for the
  summary access change (participant device 200, foreign device 403,
  cabinet 200).
- Kotlin unit: `KmCodecTest` over `km-fixtures.json`; `ShiftValidatorTest`
  (order of verdicts); `SyncEngineTest` with MockWebServer: batch shape,
  pinned ceiling reused after a failure while new scans arrive, replay
  answered by `alreadyApplied`, malformed 200 not acked, backoff sequence,
  revoked 401 raises the bus, conflicts recorded before ack, reconciliation
  paging; `ShiftCloserTest`: reason required, unique close, outcomes.
- Robolectric: `ScanRecorderTest` (PK duplicate turns into `duplicate`,
  outbox ids strictly increasing, transaction atomicity), Room migration
  1 → 2, `SignallerTest` (no throw without audio), screen tests for the
  shift list, work screen (verdict rendering, counters, feed), close flow,
  conflicts, English rendering.
- Full gate stays `./gradlew testDebugUnitTest lintDebug assembleDebug`.

## Manual verification (emulator, local API)

1. Cabinet: product with GTIN, line, planned validation shift with
   `plannedQty`, two operators, a second handheld device.
2. Handheld: list shows the shift; enter; scan an accepted code, the same
   code again (duplicate with first-seen time), a code with another GTIN,
   garbage; tones and vibration per verdict; counters and feed update.
3. Network off: ten scans queue, banner shows the count; network on: queue
   drains, cabinet shows the scans with the handheld as terminal.
4. Second device enters the same shift: chip «+1», sheet shows both; close
   from the first device → `conflict` summary; cabinet closes the shift.
5. Fresh shift: close with a reason (plan not met) → `accepted`, cabinet
   shows the close reason and the terminal.
6. Kill and restart the app mid-drain: the pinned batch is resent unchanged
   and the server answers `alreadyApplied`.
7. Switch the language to English and walk pairing → hub → work screen.

## Out of scope

Aggregation (boxes, pallets, SSCC pool), printing and the label channel,
exceptions (undo, replace, disassemble, reprint), `POST /station/codes/releases`,
`validation-dm-duplicate-v1`, ad-hoc shift creation, inventory (closed only by
the cabinet), code check, camera scanning, per-line operator scoping,
background sync while the app is not running.

## Risks and open points

- The summary endpoint change touches a cabinet route; the participant check
  must not weaken cabinet permissions.
- Synthesised audio on rugged devices: some models route `AudioTrack` to a
  muted stream; the vibration path covers that, and the settings screen lets
  the operator test all three tones.
- `codes_mirror` grows without bound on the device; the station purges shifts
  N days after sync. A purge policy is deferred to the aggregation slice.
