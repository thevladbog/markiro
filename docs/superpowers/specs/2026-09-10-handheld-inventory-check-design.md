# Handheld (TSD) inventory check — design spec

**Date:** 2026-09-10

**Status:** Implemented on 2026-09-10 on branch `worktree-tsd-inventory` (pull request pending)

**Scope:** Third implementation slice of design brief 10
(`docs/design-briefs/10-tsd-handheld.md`), on top of the foundation
(`2026-09-10-handheld-foundation-design.md`, #473) and the shift validation
slice (`2026-09-10-handheld-shift-validation-design.md`, #479): the handheld
joins a running inventory in `check` mode as one more terminal, downloads the
snapshot for offline work, verifies codes and whole boxes with the station's
verdicts and its active production date, queues events and syncs them with the
station's inventory protocol, shows other terminals' progress, and leaves the
task. Repack, printing, camera scanning, corrections and closing stay out; an
inventory is closed only in the cabinet.

## Outcome

An operator on a handheld opens «Инвентаризация», sees the running tasks of
their line (and, on request, of the other lines), joins one, waits for the
snapshot to download once, then walks the racks scanning units and box labels.
Every scan answers within the same second, online or not: accepted, already
counted (here or on another terminal), protected from counting, not part of
the task, missing from the snapshot, unreadable. The counters show how much of
the task is verified across all terminals, what this handheld did and how many
discrepancies were found. When the operator is done they leave the task; the
cabinet closes the inventory and sees the handheld's scans exactly as it sees
a station's.

## Decisions

| Decision        | Choice                                                                                                                                                                                                                | Why                                                                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mode            | `check` only; `repack` tasks are listed but cannot be joined                                                                                                                                                          | Repack needs the SSCC pool, box state and printing (brief §8, §10), which are the aggregation and printing slices                                                                                    |
| Protocol        | 1:1 port of the station's inventory protocol: `GET /station/inventory-tasks`, `POST …/resolve-barcode`, `POST /station/inventories/:id/join`, `bundle/manifest`, `bundle/codes`, `event-batches`, `progress`, `leave` | The server already owns the semantics (snapshot digests, earliest-claim-wins, batch idempotency, quarantine after close); one protocol keeps the cabinet's view identical for stations and handhelds |
| Production date | Port the station's terminal-local **active production date** and the date-mismatch hold with its three actions                                                                                                        | The server rejects events without a date in the task's range and reports discrepancies by date; two terminal behaviours would give two kinds of data                                                 |
| Task list       | Own line first; «Показать другие линии» loads every running inventory (`scope=all`); a task barcode scan also resolves a task                                                                                         | The handheld walks; the shift list already uses this pattern; the server keeps the `running`-only rule                                                                                               |
| Other-line join | For `handheld` devices `confirmDifferentLine: true` is enough; the task barcode stays optional                                                                                                                        | The station's barcode requirement guards a stationary terminal from swallowing another line's inventory; a walking handheld shows the confirmation sheet instead. Station behaviour is unchanged     |
| Undo            | No «Отменить последний скан» in this slice                                                                                                                                                                            | The inventory journal is immutable on the station and the server; corrections are cabinet work (`POST /inventories/:id/corrections`)                                                                 |
| Classifier      | Kotlin port of `classifyInventoryScan` and `resolveInventoryScanSourceDate`, verified against fixtures exported from `packages/domain`                                                                                | Same approach as the KM parser: the two implementations must agree, and the fixture test in the domain fails on drift                                                                                |
| Sync engine     | A second engine (`InventorySyncEngine`) sharing `SyncTransport`, `Backoff`, `ConnectivityNudger` and `RevocationBus` with the shift engine                                                                            | The inventory batch has its own digest, outcomes, progress feed and leave rule; one loop per protocol is simpler than a generic engine over shipped code                                             |
| Camera          | Not in this slice                                                                                                                                                                                                     | Camera scanning is the phone variant (brief §13) and lands with code check                                                                                                                           |
| Languages       | Every new string in `values/strings.xml` and `values-en/strings.xml`; lint keeps `MissingTranslation` as an error                                                                                                     | Standing rule since the shift slice                                                                                                                                                                  |

## Server

### `GET /station/inventory-tasks?scope=all`

- Query `scope` is optional: absent or `line` keeps today's behaviour (the
  device's line, empty when the device has no line); `all` returns every
  `running` inventory of the tenant that passes the same recovery-entitlement
  filter, ordered by number.
- `scope=all` is honoured only for `req.deviceKind === "handheld"`; a station
  sending it gets the line list (no error, the parameter is ignored), so the
  station's contract does not change. `TenantGuard` sets `req.deviceKind`
  from the device row next to the existing `req.deviceLineId`.
- Items keep `StationInventoryTaskDto` (`inventoryId`, `inventoryNumber`,
  `productName`, `productPrintName`, `mode`, `lineId`, `lineName`,
  `productionDateFrom`, `productionDateTo`). No GTIN is added: the manifest
  carries it after join, and the card shows the product name.
- E2E: a handheld on line A sees A's tasks by default and A + B with
  `scope=all`; a station with `scope=all` still sees only A; a completed
  inventory never appears.

### `POST /station/inventories/:id/join` for handhelds

- Today: a different line requires both `barcode` and `confirmDifferentLine`.
- New rule in `StationInventoryAccessService.join`: when
  `req.deviceKind === "handheld"` the barcode requirement is skipped;
  `confirmDifferentLine === true` is still required (409
  `INVENTORY_DIFFERENT_LINE_CONFIRMATION_REQUIRED` otherwise). A supplied
  barcode is still validated against the inventory.
- The participant row is written exactly as for a station, so summaries and
  the close preview do not distinguish the device kind.
- E2E: handheld joins line B's task with confirmation only; the same request
  from a station still returns `INVENTORY_TASK_BARCODE_REQUIRED`.

### Shared fixtures (`packages/domain`)

`scripts/export-inventory-fixtures.mjs` and the script `fixtures:inventory`
write `apps/handheld/app/src/test/resources/inventory-fixtures.json` from
`packages/domain/src/inventory/inventory-fixtures.ts`:

- `classify`: cases with a task GTIN, snapshot rows (`InventoryScanSnapshotRow`
  subset), local claims, the raw scan and the expected
  `InventoryScanClassification` (kind, scanKind, codeHash/sscc, origin, the
  winning claim for duplicates, per-child classification for boxes) and the
  expected `InventoryScanSourceDate`. Coverage: KM expected / protected by
  state / protected by flag / ineligible / unknown / duplicate; wrong GTIN;
  bare GTIN (`unsupported`); malformed; SSCC with AIM prefix `]C1`, with
  `(00)`, bare 20 digits; box fully claimed → duplicate with the earliest
  winner by `scannedAt, deviceId, eventId`; box partially claimed; box with
  only protected left; box unknown (`old_box`); mixed dates in a box; single
  date; no date.
- `batchDigest`: event batch payloads (item, known_box, old_box, with and
  without `repack`) and their `inventoryEventBatchDigest`, so the Kotlin
  canonical JSON matches byte for byte.
- `test/inventory-fixtures.test.ts` regenerates in memory and fails when the
  committed JSON differs.

## Device data (Room v3, `MIGRATION_2_3`)

All rows carry `inventoryId` and `snapshotId`; a snapshot change in the
cabinet gives a new snapshot id, and stale rows are dropped on join.

| Table                      | Key                                       | Columns                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inventory_tasks`          | `inventoryId`                             | `inventoryNumber`, `productId`, `productName`, `productPrintName`, `gtin14`, `mode`, `lineId`, `lineName`, `productionDateFrom/To`, `boxCapacity`, `snapshotId`, `snapshotFixedAt`, `contentDigest`, `combinedDigest`, `codeCount`, `expectedCount`, `state` (`staging` / `active` / `closed`), `stagingCursor`, `stagedCount`, `joinedAt`, `leftAt`, `listFetchedAt`, `listLineId`           |
| `inventory_snapshot_codes` | (`snapshotId`, `codeHash`)                | `canonicalRaw`, `gtin14`, `serial`, `sourceStatus`, `sourceState`, `sourceProductionDate`, `parentSscc` (indexed), `expected`, `protected`                                                                                                                                                                                                                                                    |
| `inventory_terminal_state` | (`inventoryId`, `snapshotId`)             | `operatorId`, `activeProductionDate`, `nextDeviceSequence`, `progressCursor`, `progressResultRevision`, `updatedAt`                                                                                                                                                                                                                                                                           |
| `inventory_events`         | `eventId`                                 | `inventoryId`, `snapshotId`, `deviceSequence` (unique per task), `operatorId`, `scannedAt`, `kind` (`item` / `known_box` / `old_box`), `normalizedIdentity`, `codeHash?`, `canonicalRaw?`, `activeProductionDate`, `localVerdict`, `winnerEventId?`, `winnerDeviceId?`, `winnerScannedAt?`, `serverStatus?` (`applied` / `replay` / `duplicate` / `rejected` / `quarantined`), `claimedCount` |
| `inventory_results`        | (`inventoryId`, `snapshotId`, `codeHash`) | `firstAcceptedEventId`, `winningDeviceId`, `winningScannedAt`, `observedProductionDate?`, `classification` (`expected` / `protected` / `known-ineligible` / `unknown` / `voided`), `source` (`local` / `server`), `updatedAt`                                                                                                                                                                 |
| `inventory_outbox`         | `id` autoincrement                        | `inventoryId`, `snapshotId`, `eventId` (unique), `deviceSequence`, `payloadJson`, `createdAt`                                                                                                                                                                                                                                                                                                 |

`meta` keys: `inventory_pending_batch:<inventoryId>` (the pinned request JSON
with the outbox ids), `inventory_active_id` (the task the hub continues).
`DeviceWipe` clears all six tables. `DeviceConfigEntity` gains
`activeInventoryId` for the hub tile, mirroring `activeShiftId`.

## Bundle mirror (`core/inventory/InventoryBundleMirror`)

Port of `apps/station/src/lib/inventory-bundle.ts` without the lease layer:

1. `POST join` (or `GET bundle/manifest` when re-entering) → manifest. Reject
   when `inventoryId` differs, `snapshotRevision != 1`, `mode == "repack"`, or
   the date range is inverted.
2. If `inventory_tasks` already holds this `snapshotId` in state `active`
   with the same `contentDigest`: done (offline re-entry reads nothing).
3. Otherwise upsert the task in state `staging` (dropping snapshot rows of an
   older snapshot id for this inventory), and page `GET bundle/codes?limit=200
[&cursor=]` from `stagingCursor`. Every page is verified: `snapshotId`,
   `contentDigest` and `cursor` match, `pageDigest` recomputes (SHA-256 of the
   canonical JSON as `inventorySnapshotPageDigest`), items are strictly
   ascending by `codeHash` and continue after the cursor. Items are inserted
   and `stagingCursor` / `stagedCount` advanced in one transaction per page.
4. After the last page the whole staged set is re-read in `codeHash` order and
   `inventorySnapshotContentDigest` recomputed; on match the task flips to
   `active` with `expectedCount = count(expected && !protected)` in one
   transaction, otherwise the staging is discarded and the download restarts
   from the first page.
5. A restart mid-download resumes from `stagingCursor`. Any network error
   surfaces to the screen with «Повторить»; the download runs in the
   view-model scope and continues while the screen is visible.

## Scan recording (`core/inventory/InventoryRecorder`)

Port of `recordInventoryScanInternal` for `check`:

- Input: `inventoryId`, raw, `operatorId`, `eventId` (UUID, one per scan
  attempt), `scannedAt`, `acceptMismatch: Boolean`.
- Step 1, parse (`InventoryClassifier.classifyScan`): SSCC first (`]C1`,
  `(00)`, bare 20 digits with `00`, or 18 digits; GS1 check digit), then a
  bare valid GTIN (`invalid/unsupported`), then KM through `KmCodec`, else
  `invalid/malformed`. `invalid` never creates an event: the screen shows
  «НЕВЕРНЫЙ КОД» and the ERROR signal; the feed keeps it for context.
- Step 2, facts: snapshot rows for the code hash (KM) or all children of the
  SSCC (ordered by `codeHash`), plus `inventory_results` rows for those
  hashes. Classification as in the domain: a claim in results (local or
  server) → `duplicate` with its winner; box verdict by **unclaimed** children
  (expected > protected > ineligible), all claimed → `duplicate` with the
  earliest winner; no children in the snapshot → `unknown` / `old_box`.
- Step 3, date guard (only for `expected`): the source date is the snapshot
  date of the item or the single date of the unclaimed expected children of
  the box (`mixed` when they differ, `none` when absent). Equal to the active
  date → continue. Otherwise, if this terminal has no events yet, the active
  date silently becomes the source date. Otherwise return
  `DateMismatch(activeDate, codeDate | null, mixed)` and record nothing;
  `acceptMismatch = true` skips the guard. The date cannot leave the task's
  range: the sheet's picker is bounded, and the source date comes only from
  `expected` rows that the manifest range already covers. An `invalid` scan
  creates no event, so it shows in the verdict zone only, not in the feed.
- Step 4, in one transaction: allocate `deviceSequence` from
  `inventory_terminal_state` (upserting `operatorId`); insert the event with
  `activeProductionDate`; insert result rows (`ON CONFLICT DO NOTHING`) — one
  for an item with a projection origin, one per child for a box; count what
  this event actually claimed; verdict = expected if any expected claimed,
  else protected, else ineligible, else duplicate (item or box) or unknown
  (first observation by `normalizedIdentity`, later observations are
  duplicates of that event); store the winner for duplicates; write the
  outbox payload.
- Outbox payload (exact `inventoryEventSchema`): `eventId`, `deviceSequence`,
  `operatorId`, `scannedAt`, `kind`, `normalizedIdentity`
  (`item:<hash>` / `known_box:<sscc>` / `old_box:<sscc>`), `codeHash` (null
  for boxes), `canonicalRaw` (canonical KM or the SSCC), `activeProductionDate`,
  `localVerdict` (`expected` / `protected` / `known-ineligible` / `unknown` /
  `duplicate`).
- Result for the screen: verdict, `scanKind`, serial tail `…<last 4
alphanumerics>` or SSCC tail `…<last 4 digits>`, `claimedCount`,
  `boxChildCount`, winner (device id and time) for duplicates, the source
  status for protected/ineligible.

## Sync (`core/inventory/InventorySyncEngine`)

- Lifecycle: started by `HandheldApp` like the shift engine; drains only for
  the active task; tick every 15 s (`HEARTBEAT_MS` on the station) plus the
  connectivity nudge and a nudge after every recorded scan; exponential backoff
  2 s → 60 s on failure, shared `Backoff`.
- Batch: up to 100 outbox rows by `deviceSequence`; body
  `{ batchId: <uuid>, payloadDigest, snapshotId, snapshotRevision: 1,
sequenceCeiling: <last deviceSequence>, pendingEventCount: <rows after the
batch>, openBoxCount: 0, events }`; `payloadDigest` = SHA-256 of the canonical
  payload JSON (the domain's key order: `snapshotId`, `snapshotRevision`,
  `sequenceCeiling`, `pendingEventCount`, `openBoxCount`, `events[…]` with
  `eventId`, `deviceSequence`, `operatorId`, `scannedAt`, `kind`,
  `normalizedIdentity`, `codeHash`, `canonicalRaw`, `activeProductionDate`,
  `localVerdict`) with no whitespace and JSON string escaping as
  `JSON.stringify`. The request is pinned in `meta` before sending and re-sent
  unchanged until acknowledged.
- Response guard (port of `parseInventoryEventBatchResponse`): `inventoryId`,
  `snapshotId`, `batchId`, `payloadDigest`, `sequenceCeiling` equal the
  request; one outcome per event, no extras; claim counts consistent. Any
  mismatch or a non-2xx is a failed attempt (nothing acknowledged). A 409 with
  `INVENTORY_EVENT_*` codes is logged and retried with backoff (the cabinet
  fixes the cause); a 401 `STATION_CREDENTIAL_REVOKED` raises `RevocationBus`.
- Outcomes applied in one transaction with the outbox delete:
  `applied` / `replay` → `serverStatus`; `duplicate` (`CLAIM_LOST`) → each
  `claims[].status == "duplicate"` replaces the local result row with the
  server winner (`source = server`), the event gets `serverStatus = duplicate`
  and is no longer counted as this handheld's; `rejected` → `serverStatus =
rejected`, counted in «Отклонено сервером»; `quarantined` → the task moves
  to `closed` and the screen shows the closed state; remaining outbox rows
  stay (they are the cabinet's late events) and the engine stops draining the
  task.
- Progress: after each successful batch and on every tick,
  `GET progress?limit=200[&cursor=]` from `inventory_terminal_state`; the page
  must echo the cursor and carry `resultRevision >= stored`; items must be
  ordered by `(revision, id)`. `claim` / `correction` items upsert
  `inventory_results` (`winner == null` or `classification == voided` deletes
  the row, so the code can be scanned again); `remove_item`, `invalidate_box`,
  `reprint` are ignored (repack). Cursor and revision are stored with the
  page in one transaction; paging continues while `nextCursor != null`.
- Counters (`InventoryProgress`, port of `readInventoryProgress`): verified =
  results with `classification == expected` (all terminals); discrepancies =
  results `known-ineligible` or `unknown` + distinct unknown identities of
  this device's events not yet mirrored as results; protected = results
  `protected`; thisTerminal = results whose
  `winningDeviceId` is this device; rejected = events with
  `serverStatus == rejected`. `expectedCount` from the task is the
  denominator.
- Leave: «Выйти из задания» drains with progress (`CloseStep.Draining`
  pattern), then `POST leave { pendingEventCount: 0, openBoxCount: 0 }`,
  expects `{ outcome: "left" }`, sets `leftAt`, clears `activeInventoryId`,
  returns to the hub. Offline or with a non-empty queue the button is
  disabled with the caption «Выход после отправки N сканов»; back navigation
  keeps the task active (hub tile «продолжить»).

## Screens and strings

Route `INVENTORY` (list) → `INVENTORY_WORK/{inventoryId}`; the hub tile
«Инвентаризация» navigates to the list, or straight to the work screen when
`activeInventoryId` is set and the task is `active`.

- **List** (`InventoryListScreen`): «Моя линия» cards: number, product print
  name or name, «без переупаковки» / «с переупаковкой», dates
  «01.09 – 10.09»; the active task first with «продолжить»; `repack` cards
  disabled with «с переупаковкой: в следующем срезе». «Показать другие линии»
  loads `scope=all` and groups by line name; each card carries a line chip.
  Empty: «Заданий нет · Запустите инвентаризацию в кабинете». A scan on this
  screen calls `resolve-barcode` and opens the task (with the sheet when the
  line differs; a 404 shows «Штрихкод задания не распознан»).
- **Different-line sheet**: «Задание назначено другой линии», rows «Этот
  ТСД · Линия 2» and «Задание · Линия 3», text «После подтверждения сканы
  этого ТСД попадут в эту инвентаризацию и будут отмечены как выполненные
  терминалом другой линии», buttons «Подключиться к INV-0007» / «Отмена».
- **Join errors**: `INVENTORY_NOT_RUNNING` → «Задание уже не выполняется»;
  `INVENTORY_OPERATOR_UNAVAILABLE` → «Оператор не может участвовать: проверьте
  учётную запись в кабинете»; `INVENTORY_DEVICE_LINE_REQUIRED` → «У ТСД нет
  линии: назначьте её в кабинете»; offline without an active snapshot →
  «Нужна сеть, чтобы загрузить снимок».
- **Download**: a dialog state of the list screen, «Загружаем снимок
  INV-0007», «12 400 из 41 160», linear progress; «Повторить» on error;
  «Отмена» returns to the list keeping the staging.
- **Work** (`InventoryWorkScreen`): header «Вода» / «INV-0007», date chip
  «05.09.2026» (tap → date sheet); verdict zone with the same layout as the
  shift screen: `ПРИНЯТО` (+ «короб · принято 18 кодов» for a box),
  `ДУБЛЬ` («на этом ТСД в 10:42» / «на другом терминале в 10:42»),
  `ЗАЩИЩЁН` («уже в отгрузке»), `НЕ УЧАСТВУЕТ` («статус: Выведен из
  оборота» by `sourceStatus`), `РАСХОЖДЕНИЕ` («нет в снимке»), `НЕВЕРНЫЙ КОД`;
  counters «Проверено 1 240 / 4 116», «Этот ТСД 312», «Расхождения 7»,
  second row «Защищено 3 · Отклонено 1» only when non-zero; feed of the last
  four scans (time, tail, verdict). Overflow: «Сменить дату», «Выйти из
  задания». Offline banner and «Очередь N» as on the shift screen (the strip
  sums both queues). Closed state: «Задание закрыто в кабинете» with the
  counters and «В хаб».
- **Date sheet**: title «Сменить дату производства», a date picker bounded
  by the task range, «Применить дату». The date mismatch sheet: «Дата в коде
  отличается от активной», rows «В коде 03.09.2026» / «Активная 05.09.2026»,
  buttons «Установить 03.09 и зачесть», «Зачесть как есть», «Пропустить код»;
  for a mixed box the title is «В коробе несколько дат розлива», the body
  «Подставить одну дату нельзя: зачтите как есть или пропустите короб» and
  only the last two buttons. While the sheet is open further scans are
  dropped with the ERROR signal.
- **Hub**: tile status «продолжить INV-0007» or the existing plural of
  tasks; the count keeps using the line list.
- **Settings**: «Очередь синхронизации» shows scans + inventory events.
- English mirrors every string (`Accepted`, `Already counted`, `Protected`,
  `Not in this task`, `Missing from snapshot`, `Invalid code`, `Verified`,
  `This handheld`, `Discrepancies`, …); `EnglishRenderTest` renders the list,
  the work screen and the mismatch sheet.
- Signals: expected → OK tone, duplicate → DUPLICATE, everything else →
  ERROR; a box uses the same OK tone.

## Testing

- Domain: fixture drift test; classifier and digest cases listed above.
- API: `apps/api/test/handheld-inventory-access.e2e.test.ts` for `scope`
  and the handheld join rule, plus the station's unchanged behaviour.
- Handheld: `MigrationTest` 2→3; `InventoryClassifierTest` over the JSON
  fixtures; `InventoryRecorderTest` (every verdict, box by SSCC with partial
  claims, first-scan date adoption, mismatch hold and accept, unknown
  duplicate by identity, idempotent `eventId`, sequence monotonic across
  restarts); `InventoryBundleMirrorTest` with MockWebServer (page digests,
  resume from cursor, content digest mismatch restarts, repack refused);
  `InventorySyncEngineTest` (digest matches the fixture, pinned batch re-sent
  unchanged, each outcome, quarantine, progress paging and voided claims,
  leave refuses a non-empty queue, 401); view-model tests for list, download
  and work; Compose tests for the list, the work screen, both sheets;
  `EnglishRenderTest` additions.
- Gate: `./gradlew testDebugUnitTest lintDebug assembleDebug`, domain and API
  tests, prettier, CI classifier tests.

## Manual verification (emulator)

Same harness as the shift slice (vitest file on 127.0.0.1:3100, deleted
before commit): tenant with two lines, product, an inventory in `check` mode
with a snapshot imported from a small Chestny ZNAK export (expected,
protected, retired and boxed codes), two handhelds. Walk-through: list with
both lines, join own line, download with a forced restart mid-way, every
verdict, a box by SSCC, the first-scan date adoption and a mismatch sheet,
duplicate from the second handheld through progress, ten scans offline then
online, the cabinet closing the inventory while events are queued, leave,
the English rendering. Report separately from hardware, which is not
exercised.

## Out of scope

Repack and its stepper, box label printing, camera scanning and the phone
layout, undo and corrections, closing an inventory from the device, code
check, late-event handling in the cabinet (unchanged), and the aggregation
slice's purge policy for device mirrors.

## Risks and open points

- Snapshot size: a 100 000-code task is 500 pages of 200; the download is
  resumable and shows progress, but the first join on a slow Wi-Fi takes
  minutes. Raising the page limit is a server change left for later.
- The digest port must match `JSON.stringify` escaping for non-ASCII serials
  and control characters; the fixtures include both.
- `scope=all` widens which tasks a device can see; it is limited to
  `handheld` devices and `running` inventories.
- Progress pages are the only way the handheld learns about other terminals;
  a 15 s tick means a code counted elsewhere can be accepted here for up to
  15 s and then reconciled as `CLAIM_LOST`, exactly as between two stations.
