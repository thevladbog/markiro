# Station work screen on the smallest terminal, and a shift-wide total — design

**Status:** accepted by the owner 2026-09-25 (pen.dev mock: variant A «лента
смены»; canvas frames `11A`, `11B`, `11C`, the notes frame `11 Заметки к
вариантам экрана смены` and `11 Общее для всех вариантов` in
`pencil-new.pen`). Owner decisions on the way: the shift counter is the total
across **all terminals** of the shift, not this terminal's; layout variant A.

## Problem

A photo from the line (1024×768 monitor, station in a maximized window: title
bar and a 40 px Windows 10 taskbar leave about **1024×697** for the app) shows
an aggregation shift with pallets:

- **The box fill is gone.** The primary column stacks the identity hero
  (~152 px: a 96 px wide 3:4 photo plus padding), the box instrument and the
  pallet strip (~156 px: its two 64 px buttons stack vertically). The box grid
  row is `minmax(0, 1fr)`; after the heading, the `2 / 20` readout and the
  64 px action row nothing is left, and 20 cells collapse into a row of dots.
- **The counters lie.** «Принято / Ошибки / Дубли» are `useState(0)` in
  `WorkScreen` and restart on every mount (pause, restart, re-entry), while
  «Последние операции» read the durable journal. The photo shows three «ДУБЛЬ»
  rows next to «Дубли 0», and «Принято 2» with fifteen closed boxes on the
  pallet.
- **The team asked for a shift total**: how many bottles the shift has
  scanned. Nothing on the station shows it. The station does not even know it:
  the server count exists but no route gives it cheaply (see "Shift total").
- **The «Ещё» footer button is invisible.** In pallet mode `WorkFooter` renders
  a fourth button into a three-column grid; it wraps into a second row that the
  work screen clips. Its only action, early pallet close, duplicates «Закрыть
  паллету» on the pallet strip.
- **One word, two numbers.** The header pill for synchronization conflicts is
  «Дубли» in Russian (English already says «Conflicts») and showed «1» next to
  the work screen's «Дубли 0», which counts rejected duplicate scans.

## Outcome

- One layout from 1024×690 up to 1920×1080: a **shift band** (product + shift
  total) across the full width, the work column on the left, the shift journal
  on the right, the footer unchanged apart from «Ещё».
- The box grid is always visible: at 1024×697 it gets ~157 px — two rows of
  large cells for a 20-place box — instead of 0.
- «В смене · все терминалы 1 302 / 9 580» with a plan bar: the shift's
  accepted units across all terminals and handhelds, live for this terminal's
  own scans, as of the last server answer for the others.
- «Ошибки» and «Дубли» are this terminal's counts for the whole shift, from
  the journal, and survive pause, operator switch and restart.
- No behaviour of scanning, printing, box or pallet closing, shift closing or
  synchronization changes. All touch targets stay 64 px.

## Layout

```
┌ header 72 ─ «Цех № 1 · SEP26-021» · pills · Развернуть ─────────────────────┐
├ SHIFT BAND ~104 ─ photo │ name (2 lines) + GTIN, «для:» │ В смене · все терминалы ┤
│                                                        │ 1 302 / 9 580 ▬▬▬       │
│                                                        │ 14 % плана · этот терминал 302 │
├ left 3fr — work ─────────────────────┬ right 2fr — journal ──────────────────┤
│ aggregation: box → pallet            │ Журнал смены      Ошибки 0  Дубли 3   │
│ validation: the verdict, full height │ ПРИНЯТО  …5A)5>JE           12:00:11  │
│ duplicate DM: processing + print job │ ДУБЛЬ    …5oKEls5           11:17:10  │
└ footer 72 ─ Исключения · Пауза · Закрыть смену ─────────────────────────────┘
```

Budget at 1024×697: header 72, footer 72, content padding 2×12, band 104 +
12 gap, leaving 413 px for the columns. Aggregation left column: box ~303
(grid ~157) + 12 + pallet ~98. Right column: the journal, 413 px, six rows.
The smallest supported viewport is **1024×690** (48 px Windows 11 taskbar);
the fixed parts of the left column then need 104 + 12 + 242 (box minimum) +
12 + 98 = 468 px of the 522 available.

The columns keep today's `minmax(0, 3fr) minmax(340px, 2fr)`. Wide screens
use the same structure; the band's photo and type scale with the viewport as
the hero does today.

## Decisions

### Shift band (new `ShiftBand`)

- Replaces the identity half of `ScanResultInstrument` and spans both
  columns. It keeps everything the hero already does: the photo (3:4 portrait,
  contained) or the product monogram, the product-tinted gradient from
  `useProductAccentHue` with the neutral fallback, white text with the clamped
  lightness. Photo height follows the band (~80 px at 1024 wide).
- Name: `productName` as today, two lines, clamped. Chips: GTIN (mono) and the
  counterparty «для: …» when the shift is tolling. The «План: N» chip goes: the
  plan now lives in the total.
- The right part is the **shift total** block, separated by a hairline: label
  «В смене · все терминалы» (or «В смене · этот терминал», see the states
  below), the number in mono, «/ plan» when a plan exists, a plan bar, and one
  meta line. Without a plan there is no bar and no percentage.
- `ScanResultInstrument` keeps only the verdict half and is rendered in the
  left column in plain validation mode, taking its full height; its identity
  half (and `productMonogram`) moves to `ShiftBand`. Aggregation keeps the
  accepted-serial readout inside the box instrument, exactly as now;
  duplicate-DM validation keeps `ValidationProcessingStatus` and
  `ProductLabelInstrument` in the left column.

### Box instrument (`BoxFillInstrument`)

- One head row: «Короб № 416», the readout `2 / 20` with «позиций», and the
  «✓ serial» chip on the right. The separate readout row disappears.
- Grid rows: `auto minmax(96px, 1fr) minmax(64px, auto)` (grouped boxes add
  their caption row). The grid can no longer collapse to zero; the layout
  budget above gives it ~157 px at 1024×697.
- The three cell modes stay: ≤10 places — one row of large numbered segments;
  11–100 — rows of ten; >100 — grouped cells with the caption.
- The action row is unchanged: «Закрыть короб», «Отменить последний скан»
  (when available), «Очистить короб», 64 px, labels may wrap to two lines.

### Pallet strip (`PalletStrip`)

- One card row: text on the left, «Состав паллеты» and «Закрыть паллету»
  side by side on the right (64 px high, ~116 px wide, two-line labels).
- Text: «Паллета **15 / 66** коробов · 23 %» (count in mono), the progress bar,
  and «Осталось 51 · последний …619998». The «нет серий для паллеты» warning
  keeps its own row below when present.
- Height ~98 px instead of ~156. Behaviour, disabling rules and the count
  highlight are unchanged.

### Shift journal (`RecentOperations`)

- The counters card (`WorkCounters`) is removed. Its parts go to where they
  belong: the accepted count becomes the band total; «Ошибки» and «Дубли» move
  into the journal head; «Синхронизировано / N в очереди» is dropped because
  the header pill «Синх.» already shows the queue and turns amber when it is
  stuck.
- Title «Журнал смены», counters «Ошибки N» and «Дубли N» on the right of the
  head (duplicates painted in the warning tone when non-zero).
- Rows show the verdict, the **serial** (mono) and the time. The GTIN is shown
  only on a «Чужой GTIN» row: on every other row it is the shift's own GTIN
  and repeats the band. Rows without a parsed identity keep the code suffix.
- The list keeps its six-row bound and shows as many rows as fit.

### Footer and header

- `WorkFooter` loses `onMore` / «Ещё» and the pallet menu overlay it opened
  (`palletMenuOpen` and its scan-blocking checks go with it). Early pallet
  close stays reachable through the pallet strip, with the same confirmation.
- The header's shift label (`App.tsx`, shared by the collapsed and expanded
  header) is the shift **number** when there is one (`SEP26-021`); the product
  name is used only when the shift has no number. The band already names the
  product, and the freed width stops the line name truncating to «Цех …».
- Russian `shell.conflicts` / `shell.conflictsShort` become «Конфликты кодов» /
  «Конфликты», matching English and the rest of the station («Разобрать
  конфликты»). The pill's meaning does not change.

## Shift total across terminals

### What the server already has

- `code_registry` holds the current owner of every accepted code: `shift_id`,
  `terminal_id` (the authenticated device id; the ingest overwrites the value
  the client sends), `scanned_at`. Undo, clear and box disassembly delete the
  row (`releaseCode`); a cross-terminal duplicate moves it to the earliest
  scan's shift and terminal. So the count of a shift's rows already excludes
  removed and lost codes, and includes open-box codes.
- `getShiftSummary` counts exactly this for validation (plus
  `validation_code_reprocessings` when `allowPreviouslyAcceptedCodes` is on).
  For aggregation it reports `containedUnits`, which counts only closed boxes.
- There is no `(tenant_id, shift_id)` index on `code_registry`; today's summary
  and the shift list count it through the tenant prefix of the primary key.
- No route returns a per-device count, and no existing station poll is a good
  carrier (each is conditional, strict, replayed, tenant-wide or heavy).

### Server contract

- `GET /station/shifts/:id/progress`, device authentication (station or
  handheld) through the station-only guard set, subscription policy
  `@AllowSubscriptionRecovery("station")` like the other station routes.
- The shift must exist in the caller's tenant, otherwise **404** (no existence
  leak). Access is otherwise the bundle's: a device that can download a
  shift's bundle can read its progress.
- Response (`additionalProperties: false` in OpenAPI; the station parses it
  tolerantly):

  ```json
  {
    "shiftId": "…",
    "acceptedUnits": 1302,
    "deviceAcceptedUnits": 302,
    "asOf": "2026-09-25T09:00:11.000Z"
  }
  ```

  - `acceptedUnits`: `code_registry` rows of the shift, plus
    `validation_code_reprocessings` rows when the shift allows previously
    accepted codes — the same definition as the validation «факт», applied to
    both modes.
  - `deviceAcceptedUnits`: the same two counts restricted to the requesting
    device (`terminal_id = deviceId`).
  - `asOf`: the transaction timestamp; both counts come from one read-only
    repeatable-read snapshot.

- Index `code_registry (tenant_id, shift_id, terminal_id)`, declared in the
  Drizzle schema, built **online** (`CREATE INDEX CONCURRENTLY`) through the
  established `runtime-migrate` prepare stage (exact-definition check, rebuild
  of an invalid leftover), with the journaled migration recording it.
- Route inventory, subscription inventory, OpenAPI coverage and
  `docs/device-key-surface.md` are updated with the route.
- The station webview is cross-origin, so the route joins the Station CORS
  surface: `apps/api/src/cors.ts`, its authoritative test
  `apps/api/test/cors-station-surface.test.ts`, and the release tooling's
  `STATION_PREFLIGHTS` (`tools/station-release/verify-api-cors.mjs` and its
  two ordered test lists). Station releases verify production CORS against
  that list, which fixes the rollout order (see "Delivery").

### Station

- The sync engine gains a **watched shift**: `WorkScreen` sets it on mount and
  clears it on unmount (through `App`, which owns `useSyncEngine`). After a
  drain — in the same single-flight loop as the existing post-drain steps,
  under the same pause, seal and credential-lease rules — the engine fetches
  the watched shift's progress at most once per 15 s.
- The last answer is persisted in `station_meta` (one key, the watched shift
  only) as `{ shiftId, acceptedUnits, deviceAcceptedUnits, asOf, fetchedAt }`
  and published with the sync state; watching a shift publishes its persisted
  answer at once, without waiting for a drain — except before the engine's
  first state publication, when there is nothing yet to merge the answer into
  (see the publish-path comment on `publishWatchedProgress` in `sync.ts`).
  After a restart, the saved answer therefore appears only once that first
  state publishes, which follows the first drain attempt (up to the 30 s
  request timeout on a hanging link); from then on, a restart without network
  still knows the other terminals' last contribution. An answer for another
  shift is ignored.
- Failures of this step never schedule a sync retry and never mark sync as
  stuck; any failure keeps the last answer and the next attempt waits for the
  normal 15 s interval. A 404 (a server without the route whose CORS still
  answers) suspends the step for 10 minutes. A server whose CORS predates the
  route rejects the preflight instead, so the request fails without any
  response; the progress GET is display-only
  (`StationClient.get(path, { displayOnly: true })`): it never reports a
  failure, and it reports the server reachable only when no newer request has
  started since it began, leaving the header's server pill to the requests
  that carry sync otherwise. A credential rejection takes the engine's
  existing rejection path.
- **Local contribution** is `SELECT COUNT(*) FROM station_processed_codes
WHERE shift_id = ?` — the count the shift close and the plan prompt already
  use. `WorkScreen` refreshes it off the scan's critical path (as it already
  refreshes the journal) after a scan outcome, undo, clear, box disassembly and
  each published sync state that brings a new progress answer or moves
  `SyncState.lastSuccessAt`, which advances only when a drain's batch is
  acknowledged (`sync.ts`, where `lastSuccessAt` is set). `reconcileReleasedCodes`
  applies a server release that deletes local codes on every drain, whether or
  not a batch was acknowledged, so on an idle line a release reaches the band
  with the next progress answer (within 15 s on a current server) or, on an
  older server, only with the next own scan, undo, clear or disassembly.
- **Display**: `total = acceptedUnits − deviceAcceptedUnits + local`.
  Own scans, undo, clear and disassembly move the number immediately; other
  terminals' progress arrives with the next answer. While this terminal's
  counts agree with the server, the display equals the server count.
- **States** (pure function `shiftTotalView` in `src/lib/shift-progress.ts`):
  - no answer yet (entered offline, older server): label «В смене · этот
    терминал», number = local;
  - an answer, no other terminal counted (`acceptedUnits ===
deviceAcceptedUnits`): «В смене · все терминалы», meta «14 % плана»;
  - an answer with other terminals: meta adds «· этот терминал 302» (without a
    plan the meta is only «этот терминал 302»);
  - the answer is older than 2 minutes and other terminals are counted: the
    stale note replaces the terminal share and the plan percentage stays —
    «14 % плана · другие терминалы — на 11:58» with a plan, only «другие
    терминалы — на 11:58» without one (local time of `fetchedAt`).
- The plan prompt («план выполнен») and the close summary stay local: a
  station closes only single-device shifts.

### Known limitations

- When an already acknowledged scan of this terminal is displaced by an earlier
  scan from another terminal, the server never tells the station (existing
  gap, `conflict-resolution.ts`). That code stays in the local count and is
  also counted for the winner, so the total is one too high per such code until
  the shift ends.
- If the local database is lost while the device id stays the same, this
  terminal's own contribution is under-counted.
- The station and the cabinet can differ on aggregation shifts by the content
  of open boxes: the cabinet «факт» counts closed boxes only.

## Journal counters

- `readShiftJournalCounts(exec, shiftId)` in `src/lib/journal.ts` returns
  `{ accepted, errors, duplicates }`; the verdict counts come from
  `scan_events_mirror`: «Дубли» = verdict `duplicate`; «Ошибки» = every other
  rejected scan (`invalid`, `wrong_gtin`, …). The undo correction row
  (`undone`, written by `undoLastScan`) is not an error. A failed journal write
  keeps its «ОШИБКА ЗАПИСИ» signal and is not counted: it has no verdict.
- The counts are this terminal's (the journal is local) for the whole shift.
- Duplicate-DM refusals are journaled too: when the acceptance trigger aborts,
  `product-labels/acceptance.ts` records the scan as `duplicate`, so the
  journal alone counts them, once, and across remounts. (Revised 2026-09-25
  during implementation; the first draft assumed they left no journal row.)
- Station SQLite migrations add `scan_events_mirror (shift_id, verdict)` and
  `codes_mirror (shift_id)` indexes, in `packages/db/src/sqlite/` with the
  authoritative DDL. Today the plan check scans `codes_mirror` in full on every
  accepted scan.
- `WorkScreen` drops its `accepted` / `rejected` / `duplicates` session state;
  the signal overlay logic that reads verdicts is unchanged.

## Tests

- **DB**: schema and migration tests for the `code_registry` index (exact
  definition, invalid-index rebuild in the prepare stage) and the two SQLite
  indexes; `pnpm --filter @markiro/db build` before consumers.
- **API** (`apps/api`, e2e against the test database):
  - validation counts with and without reprocessing; aggregation counts
    including an open box; undo, clear and disassembly excluded; a displaced
    duplicate counted for the winner only; `deviceAcceptedUnits` per device;
  - 404 for another tenant's shift and an unknown id; denial for cabinet,
    kiosk and platform credentials; restricted-subscription behaviour;
  - route inventory, subscription inventory and OpenAPI contract tests;
  - the Station CORS surface test and the release tooling's preflight lists
    (`pnpm test:station-release:contract`).
- **Station**:
  - `shiftTotalView`: no answer, fresh, stale, no other terminals, others;
  - sync engine (`test/sync.test.ts`, `test/use-sync-engine.test.tsx`): watched
    shift, 15 s throttle, persisted answer, ignored foreign answer, 404
    suspension without stuck state, credential rejection path;
  - `readShiftJournalCounts` and the counters surviving a `WorkScreen` remount
    (`test/work-screen.test.tsx`, `test/product-label-work-screen.test.tsx`);
  - components (`test/work-instruments.test.tsx`,
    `test/recent-operations.test.tsx`, new `test/shift-band.test.tsx`): band
    total states and plan bar; box head row; compact pallet; journal rows with
    the serial and the GTIN only on «Чужой GTIN»;
  - `test/pallet-ui.test.tsx`: early close through the pallet strip, the footer
    has three actions;
  - `test/fixed-viewport-source.test.tsx`: rewrite the work-screen assertions
    for the band, the box grid rows, the compact pallet and the removed
    counters card;
  - `test/status-bar.test.tsx` / `test/App.test.tsx`: shift label with and
    without a number; `test/i18n.test.tsx` for the new keys.
- **Gallery**: new states `work-pallet-20` (20-place box with two items, pallet
  15/66, total 1 302 / 9 580 with this terminal 302) and
  `work-pallet-20-stale` (the same with «другие терминалы — на 11:58»);
  `work-validation`, `work-aggregation`, `work-pallet-66`, `work-ok`,
  `box-empty`, `box-full` and the duplicate-DM states re-shot.

## Verification

- **Automated**: the gates above plus the Station, API and DB package gates
  (`test`, `typecheck`, `lint`, `build`) and `pnpm format:check`.
- **Browser** (station dev server gallery): 1024×697, 1024×768, 1280×800 and
  1920×1080, Russian and English — the box grid shows at least two rows,
  nothing interactive is clipped or occluded, and every interactive element is
  at least 64 px (the production browser contract's measure).
- **Not verifiable here**, reported separately: the Windows terminal in a
  maximized window, multi-terminal totals on production data, and the online
  index build on the production database volume.

## Delivery

One PR, commits split by layer (DB → API → station). Functionally either
order works: an older station never calls the new route, and a new station on
an older server shows «В смене · этот терминал». The release pipeline does
fix the order: **deploy the API first**, then publish the station build, because
the station release verifies production CORS against `STATION_PREFLIGHTS`,
which now includes the new route.

## Not in scope

- The handheld keeps its `/shifts/:id/summary` counter; moving it to the new
  route is a separate change.
- Errors and duplicates across terminals.
- Two findings spun off as their own tasks: desktop «Присоединиться» never
  records shift participation on the server (so a shared shift can be closed by
  one station), and the 60 s heartbeat downloads the line's whole shift history.
- Variants B «по уровням» and C «точечная правка» stay on the canvas as notes.
