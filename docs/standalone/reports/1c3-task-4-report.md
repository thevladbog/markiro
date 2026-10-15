# Plan 1c3, Task 4 — Report: line choice and the host-link line

## Status: DONE

## What was implemented

A paired station without a line now chooses one before the floor (spec §5.1),
and a link status line shows the connection to the host on the floor, on the
line screen and in the office header.

New files:

- `apps/standalone/src/app/HostStatusLine.tsx` — `HostStatusLine({ status })`:
  a phase tag (`StatusChip`) with words — "На связи с хостом" / "Подключение к
  хосту…" / "Нет связи с хостом[ с ЧЧ:ММ]" — plus the failure reason
  (`errors.link.<code>`) when not online. `role="status"`, `aria-live="polite"`.
  Renders nothing before the shell's first status (`status === null`).
- `apps/standalone/src/app/LineSelect.tsx` — `LineSelect(props)`: reads the
  active lines (`ref_lines WHERE archived = 0`, sorted with
  `Intl.Collator("ru", { numeric: true })`) only once `sync.synced > 0`, and
  again after every later sync (effect keyed on `sync.synced`). Handles the
  first-sync wait, a failed sync (retry button), an empty host, choosing a
  line (`onSelect`), a `line_rejected` refusal (re-syncs and re-reads), and
  any other refusal (shown, no re-sync). Shows the host link and an "Офис"
  escape hatch.
- `apps/standalone/src/office/office-link.tsx` — `OfficeLinkProvider` /
  `useOfficeLink()`: a plain context carrying the shell's `HostStatus | null`
  into the office router subtree, so `OfficeShell`'s header can show it
  without threading it through every route.

Modified files:

- `apps/standalone/src/app/shell.ts` — new `ShellView` member
  `{ kind: "line_select" }`; new `ShellAction`
  `{ type: "line_selected"; status: DeviceStatus }`. `nextShellView`'s
  `office.kind === "closed"` branch now returns `line_select` for a station
  (`status.kind === "station"`) whose `status.lineId === null`, ahead of
  `floor`, but only reached once the office isn't open/opening (that check
  already came first) — this exactly matches the plan's fixed order (line
  choice before the floor, after office/office-login). `shellReducer` gets a
  `line_selected` case that swaps in the host's confirmed `DeviceStatus`.
- `apps/standalone/src/app/host-link.ts` — `useHostLink` now returns
  `() => void` (a "sync now" trigger) instead of `void`, via a `useRef` that
  is set to `scheduler.trigger` once the effect has a live scheduler and reset
  to a no-op on cleanup/when unpaired. Both of task 3's post-review
  `scheduler.stop()` calls (before `sync_finished` with `other_host`, and
  before the dispatch a sync error maps to) are unchanged.
- `apps/standalone/src/app/screens.tsx` — `FloorScreen` gains a `link` prop
  and now renders `HostStatusLine` plus an actions row (mirrors `LineSelect`'s
  layout: `standalone-form` / `standalone-form__actions`).
- `apps/standalone/src/app/App.tsx` — wires it together: `useHostLink`'s
  return value is kept as `requestSync`; a new `selectLine` callback calls
  `deviceApi.selectLine`, dispatches `line_selected` on success, and routes a
  `key_rejected` failure to `device_rejected` (any other error rethrows, same
  pattern as `bootstrap`/`login`); `Office` gets `link={state.link}`;
  `FloorScreen` gets `link={state.link}`; a new `view.kind === "line_select"`
  branch renders `LineSelect` with `local`, `sync`, `link`, `onSelect`,
  `onSync={requestSync}`, `onOffice`.
- `apps/standalone/src/app/shell.css` — `.line-select` (stacked line buttons),
  `.host-status` (flex row, wraps), `.host-status__reason` (`--fg-2`).
- `apps/standalone/src/office/Office.tsx` — `OfficeProps.link?: HostStatus |
null`; `Office` takes `link = null` and wraps `RouterProvider` in
  `OfficeLinkProvider value={link}`.
- `apps/standalone/src/office/OfficeShell.tsx` — reads `useOfficeLink()` and
  renders `HostStatusLine` between the user block and the actions block in the
  header.
- `apps/standalone/src/i18n/ru.json` — `shell.lineSelect.*` (title, body,
  loading, syncFailed, retry, empty), `link.*` (online, connecting, offline,
  offlineSince), `errors.link.*` (unreachable, certificate_mismatch,
  key_rejected, stream_refused, stream_ended). `errors.device.line_rejected`
  and `errors.device.request_failed` already existed from plan 1c2 task 5 and
  needed no change.
- `apps/standalone/test/support/fixtures.ts` — `DEVICE_STATUS.lineId` is now
  `LINE_ID` (a station that already chose its line); new `NEW_STATION =
{ ...DEVICE_STATUS, lineId: null }` (freshly paired).
- `apps/standalone/test/app.test.tsx`, `test/shell.test.ts` — see Tests below.
- `apps/standalone/AGENTS.md` — one paragraph appended to "App shell"
  documenting `LineSelect`'s read timing and `device_select_line`, and
  `HostStatusLine`'s three call sites and the "no blocking overlay" decision.
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`,
  §5.1 — replaced "офис показывает состояние «нет связи с хостом» и блокирует
  действия; цех работает" with the header link-line description (time of last
  contact, per-screen retry, no blocking layer, floor has the line too).

## Tests

New/changed test files:

- `apps/standalone/test/host-status-line.test.tsx` (new, 6 tests): online
  wording + `role="status"`/`aria-live="polite"`; offline-with-last-contact
  wording and reason; connecting wording and reason; offline-never-contacted
  wording and reason; every `hostStatusSchema.lastError` option has an
  `errors.link.*` key (via `i18n.exists`); renders nothing for `status: null`.
- `apps/standalone/test/line-select.test.tsx` (new, 8 tests): waits for
  `sync.synced > 0` before reading; lists active lines sorted by name and
  excludes archived; failed-sync alert + retry dispatches `onSync`; empty-host
  message; choosing a line calls `onSelect(lineId)`; `line_rejected` shows the
  text, calls `onSync`, and the list follows a later sync's archive flag;
  any other refusal shows its text without calling `onSync`; shows the host
  link and the "Офис" button calls `onOffice`.
- `apps/standalone/test/shell.test.ts`: added "has a station without a line
  choose it, unless the office is open or opening" (`nextShellView`) and
  "keeps the line the host confirmed" (`shellReducer`'s `line_selected`).
- `apps/standalone/test/app.test.tsx`: `fakeDevice.selectLine` now actually
  selects (was a stub throwing "not part of the app yet"); added "has a
  freshly paired station choose its line before the floor", "sends a station
  whose key the host refuses while choosing a line to pairing again", "shows
  the link on the floor and in the office header".

### TDD evidence

**RED** — `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-status-line.test.tsx test/line-select.test.tsx test/shell.test.ts test/app.test.tsx` (run before any `src/` change, only the test files and the fixture edited):

```
 FAIL  test/host-status-line.test.tsx [ test/host-status-line.test.tsx ]
Error: Failed to resolve import "../src/app/HostStatusLine.js" from "test/host-status-line.test.tsx". Does the file exist?

 FAIL  test/line-select.test.tsx [ test/line-select.test.tsx ]
Error: Failed to resolve import "../src/app/LineSelect.js" from "test/line-select.test.tsx". Does the file exist?

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 5 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/app.test.tsx > App > has a freshly paired station choose its line before the floor
 FAIL  test/app.test.tsx > App > sends a station whose key the host refuses while choosing a line to pairing again
 FAIL  test/app.test.tsx > App > shows the link on the floor and in the office header
 FAIL  test/shell.test.ts > nextShellView > has a station without a line choose it, unless the office is open or opening
AssertionError: expected { kind: 'floor' } to deeply equal { kind: 'line_select' }
 FAIL  test/shell.test.ts > shellReducer > keeps the line the host confirmed
TypeError: Cannot read properties of undefined (reading 'device')

 Test Files  4 failed (4)
      Tests  5 failed | 62 passed (67)
```

Exactly as Step 2 predicted: the two new suites fail to load (missing modules),
`shell.test.ts` fails its 2 new tests, `app.test.tsx` fails its 3 new tests,
and the 62 pre-existing tests across the four files still pass (the fixture
change to `DEVICE_STATUS.lineId` did not disturb them, since `paired()`'s
default still reaches `floor`/`office_login`/`office` before any `line_select`
branch existed).

**GREEN** — same command, after implementing Step 3:

```
 Test Files  4 passed (4)
      Tests  81 passed (81)
```

Per-file breakdown (verbose reporter): 6 in `host-status-line.test.tsx`, 8 in
`line-select.test.tsx`, 33 in `shell.test.ts`, 34 in `app.test.tsx` — matching
the brief's Step 4 expectation exactly (33 and 34, i.e. task 3's post-review 2
and 3 extra tests already accounted for).

No `act(...)` warnings or other console noise in either run (checked with a
grep for `warn|act(|console.error|not wrapped` over the full output: none).

## Verification commands and results

| Command                                                                                                                                                                                    | Result                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/standalone^...'`                                                                                               | 3 successful, 3 total (`@markiro/domain`, `@markiro/platform-contracts`, `@markiro/ui`) |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/host-status-line.test.tsx test/line-select.test.tsx test/shell.test.ts test/app.test.tsx` (RED) | 4 failed, 5 tests failed / 62 passed                                                    |
| same command (GREEN)                                                                                                                                                                       | 4 passed, 81/81 passed                                                                  |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` (full suite)                                                                                                   | 25 files passed, 393/393 passed                                                         |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                                                                                                           | clean, no output                                                                        |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`                                                                                                                | clean, no output                                                                        |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`                                                                                                               | built (pre-existing >500kB chunk-size notice only, unrelated to this change)            |
| `node_modules/.bin/prettier --write <18 files>`                                                                                                                                            | all "(unchanged)"                                                                       |
| `node_modules/.bin/prettier --check <18 files>`                                                                                                                                            | "All matched files use Prettier code style!"                                            |
| `git diff --check`                                                                                                                                                                         | clean (exit 0)                                                                          |
| `grep -n '\\u04' <every edited/created file>`                                                                                                                                              | clean in all files (no literal `\uXXXX` escapes)                                        |

Not run: Cargo/Rust checks. This task touches no Rust file (`git status`
confirms only TS/TSX/CSS/JSON/MD changed), and the constraints doc scopes Rust
changes to task 2 only. `apps/station` and the Rust crates were not touched.

## Files changed

Created:

- `apps/standalone/src/app/HostStatusLine.tsx`
- `apps/standalone/src/app/LineSelect.tsx`
- `apps/standalone/src/office/office-link.tsx`
- `apps/standalone/test/host-status-line.test.tsx`
- `apps/standalone/test/line-select.test.tsx`

Modified:

- `apps/standalone/src/app/shell.ts`
- `apps/standalone/src/app/host-link.ts`
- `apps/standalone/src/app/App.tsx`
- `apps/standalone/src/app/screens.tsx`
- `apps/standalone/src/app/shell.css`
- `apps/standalone/src/office/Office.tsx`
- `apps/standalone/src/office/OfficeShell.tsx`
- `apps/standalone/src/i18n/ru.json`
- `apps/standalone/test/support/fixtures.ts`
- `apps/standalone/test/app.test.tsx`
- `apps/standalone/test/shell.test.ts`
- `apps/standalone/AGENTS.md`
- `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md`

Commit: `f1d4c96c1` — "feat(standalone): выбор линии станцией и строка связи с
хостом", trailer verified with `git log -1 --format=%B` to be exactly:

```
feat(standalone): выбор линии станцией и строка связи с хостом

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

(single trailer, no other `Co-Authored-By` line).

## Deviations

None of the brief's fragments needed adjustment — every "Фрагмент … заменить
на …" in Step 3 and Step 5 matched the current files byte for byte (verified
by reading each target file before editing and diffing the result after).

One transcription slip on my part during Step 5: my first attempt at the
`AGENTS.md` edit used a wrong anchor line (I mistyped "device (`other_host`"
instead of the file's actual "to another host (`other_host`"), which is not a
brief mismatch — I mis-copied it. The `Edit` tool correctly refused the
non-matching string; I re-read the file, corrected the anchor, and the edit
applied cleanly on retry. No file was left in a partial state.

## Self-review findings

- Completeness: every interface the brief's "Produces" list names exists with
  the exact signature — `{ kind: "line_select" }`, `{ type: "line_selected";
status: DeviceStatus }`, `useHostLink(options): () => void`,
  `HostStatusLine({ status }: { status: HostStatus | null })`,
  `LineSelectProps`/`LineSelect(props)`, `FloorScreen({ link, onOffice })`,
  `OfficeProps.link?`, `OfficeLinkProvider`, `useOfficeLink()`,
  `DEVICE_STATUS.lineId = LINE_ID`, `NEW_STATION`.
- Names: kept exactly as specified (`HostStatusLine`, `LineSelect`,
  `office-link.tsx`, `requestSync`, `selectLine`, `syncNow`).
- No overbuilding: implemented only what the brief's fragments specify; no
  extra abstraction, no speculative props, no extra i18n keys beyond what the
  tests exercise.
- Tests verify behaviour: `LineSelect`'s tests drive a real in-memory SQLite
  (`openLocalDb`) and real DOM events, not mocked reads; `HostStatusLine`'s
  tests render the real component against real `i18n`; `app.test.tsx`'s new
  tests exercise the full `App` tree (real reducer, real `useHostLink`
  scheduling) with only the host/device/connection boundary faked.
- Output cleanliness: no `act(...)` warnings, no unexpected console output in
  either the focused or the full-suite run.
- Checked `@markiro/ui`'s actual `Button`, `Card`, `Alert`, `Spinner`,
  `StatusChip`/`TagPhase` prop shapes and the `ref_lines` table schema before
  trusting the brief's code fragments; all matched exactly (`size="floor"`
  exists, `TagPhase` includes `active`/`running`/`attention`, `Alert`'s
  `action` prop exists, `ref_lines(id, name, archived, rev)` matches the test
  fixture's `insertLine`).

## Concerns

None. All tests pass (393/393 full suite), typecheck and lint are clean, the
build succeeds, formatting is verified, and the diff matches the brief's file
list exactly with no unrelated changes staged.

## Fix round 1

On top of `f1d4c96c1` (HEAD had moved to `531e9e12c`, a docs-only plan commit
in between). The reviewer approved the production code from the first round
and found three gaps, all in tests plus one small `App.tsx` completeness fix.
New commit: **`931362d2d`**.

### Item 1 — the "waits for a sync" test could never fail

**Problem.** `test/line-select.test.tsx`'s "waits for a sync in this session
before it reads the lines" had a synchronous body, but `LocalExecutor.query`
(even the in-memory `node:sqlite` one in `test/support/local-db.ts`) is
declared `async`, so its `.then()` callback (`setLines`) only runs on a later
microtask. The test's assertions ran before that microtask had a chance to
fire, so the test would pass whether or not `LineSelect`'s
`if (sync.synced === 0) return;` guard existed. The reviewer confirmed this by
deleting the guard and observing both `line-select.test.tsx` and
`app.test.tsx` stay green.

**Fix.** Made the test `async` and added `await act(async () => {})` right
after `view.rerender(...)`, before the assertions, so any pending query
microtask is flushed first. Added `act` to the `@testing-library/react`
import in `test/line-select.test.tsx`.

**RED run** — command:
`pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/line-select.test.tsx`,
with the guard temporarily deleted from `src/app/LineSelect.tsx` (`if
(sync.synced === 0) return;` replaced by a comment marker, restored
immediately after this run — confirmed via `git diff` showing no change to
that file post-restore):

```
 ❯ test/line-select.test.tsx (8 tests | 1 failed) 199ms
     × waits for a sync in this session before it reads the lines 42ms

 FAIL  test/line-select.test.tsx > LineSelect > waits for a sync in this session before it reads the lines
TestingLibraryElementError: Unable to find an element with the text: Получаем справочники с хоста….
...
            <p>
              На хосте нет активных линий.
            </p>
...
 Test Files  1 failed (1)
      Tests  1 failed | 7 passed (8)
```

The failure mode is not quite "the inserted line shows up" (my first guess)
but an even sharper demonstration of why the guard matters: without it, the
effect fires once at mount — before `insertLine` even runs and before any
sync has populated anything — reads zero rows, and renders "На хосте нет
активных линий."; since the effect's dependency array is `[local,
sync.synced]` and `sync.synced` stays `0` across the test's `rerender`, the
effect never re-runs, so the empty-state text is stuck instead of the
loading text the test expects. Either way, the now-`async` test correctly
fails on the guard's removal, proving it exercises real behavior.

**GREEN run** — same command, guard restored:

```
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

### Item 2 — no test exercised the "Повторить" retry path

**Problem.** `useHostLink`'s returned trigger (`requestSync` in `App.tsx`,
wired to `LineSelect`'s `onSync`, fired by its "Повторить" button) is backed
by `syncNow.current = scheduler.trigger;` inside the effect. No existing test
called it through the UI, so deleting that assignment left every test green:
`requestSync()` would silently call a permanent no-op instead of
`scheduler.trigger`.

**Fix.** Added `test/app.test.tsx` > "retries a failed reference sync from the
line-select screen": a freshly paired station (`NEW_STATION`) whose first
`getChanges` call rejects with a non-actionable `HostError({ kind:
"transport", code: "unreachable", ... })` (so `shellActionFor` returns `null`
and the run only reaches `sync_failed`, matching the pattern the existing
"returns to the floor even when the host cannot be told about leaving" test
uses). This surfaces `LineSelect`'s failed-sync alert with "Повторить".
Clicking it must produce a second `getChanges` call, mocked to answer with a
page holding a line; the test asserts the "Линия 1" button appears and
`getChanges` was called exactly twice.

**Mutation check** — command:
`pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/app.test.tsx -t "retries a failed reference sync from the line-select screen"`,
with `syncNow.current = scheduler.trigger;` temporarily replaced by a comment
marker in `src/app/host-link.ts` (restored immediately after — `git diff`
confirmed no change to that file post-restore, since this fix round makes no
production change to `host-link.ts` itself):

```
 FAIL  test/app.test.tsx > App > retries a failed reference sync from the line-select screen
TestingLibraryElementError: Unable to find role="button" and name "Линия 1"
...
              Не удалось получить справочники с хоста.
...
              Повторить
...
 Test Files  1 failed (1)
      Tests  1 failed | 35 skipped (36)
```

Clicking "Повторить" did nothing (the alert and its retry button are still
the only thing on screen), confirming the test catches the mutation.

**GREEN run** — same command, assignment restored: passes (see the combined
run below).

### Item 3 — `selectLine` didn't route a changed certificate to the rejection screen

**Problem.** `App.tsx`'s `selectLine` callback only special-cased
`DeviceError` with code `key_rejected`; a `certificate_mismatch` error (the
host reinstalled/restored while a station was mid-line-choice) fell through
to `throw error`, which `LineSelect.choose` catches internally and displays
as `errors.device.certificate_mismatch` ("Сертификат хоста изменился во время
подключения.") on the same screen with the line buttons re-enabled — never
reaching `DeviceRejectedScreen`, unlike every other place a changed
certificate is handled (`shellActionFor`, the link-status path in
`shell.ts`'s `linkRejection`).

**Fix** (`src/app/App.tsx`, `selectLine`):

```tsx
if (error instanceof DeviceError && error.code === "certificate_mismatch") {
  dispatch({ type: "device_rejected", reason: "host_changed" });
  return;
}
```

added right after the existing `key_rejected` branch, before the final
`throw error;`.

**Test added** (`test/app.test.tsx`) — "sends a station whose certificate
changed while choosing a line to pairing again": `NEW_STATION`'s
`selectLine` rejects with `DeviceError("certificate_mismatch", ...)`; asserts
both the title `"Хост не принимает это устройство"` (`shell.deviceRejected.title`)
and the exact body `"Хост на этом компьютере сменился: его сертификат не
совпадает с сохранённым при подключении."` (`shell.deviceRejected.hostChanged`
— `remoteAddress` is `null` here since the fixture's `hostAddress` matches the
app's local `address`), both copied verbatim from `ru.json` and from the
existing `key_rejected` sibling test's style.

Not explicitly requested, but performed for parity with items 1–2: reverted
the fix in `App.tsx` (comment-marked, restored immediately after — `git diff`
confirmed clean) and re-ran the new test alone:

```
 FAIL  test/app.test.tsx > App > sends a station whose certificate changed while choosing a line to pairing again
TestingLibraryElementError: Unable to find an element with the text: Хост не принимает это устройство.
...
 Test Files  1 failed (1)
      Tests  1 failed | 35 skipped (36)
```

(without the fix, `certificate_mismatch` rethrows and `LineSelect` displays
its own inline error text instead of switching screens) — then restored the
fix and confirmed the combined run below passes.

### Verification commands and results (fix round 1)

| Command                                                                                                                                                 | Result                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `... exec vitest run test/line-select.test.tsx` (guard removed, RED)                                                                                    | 1 failed / 7 passed (8)                      |
| `... exec vitest run test/line-select.test.tsx` (guard restored, GREEN)                                                                                 | 8/8 passed                                   |
| `... exec vitest run test/app.test.tsx -t "retries a failed reference sync..."` (assignment removed, mutation check)                                    | 1 failed                                     |
| `... exec vitest run test/app.test.tsx -t "sends a station whose certificate changed..."` (App.tsx fix reverted, informal check)                        | 1 failed                                     |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/line-select.test.tsx test/app.test.tsx` (all fixes in place) | 2 files passed, 44/44 passed                 |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` (full suite)                                                                | 25 files passed, 395/395 passed              |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                                                                        | clean                                        |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`                                                                             | clean                                        |
| `node_modules/.bin/prettier --check` on the 3 changed files                                                                                             | "All matched files use Prettier code style!" |
| `git diff --check`                                                                                                                                      | clean (exit 0)                               |
| `grep -n '\\u04' <changed files>`                                                                                                                       | clean (no literal `\uXXXX` escapes)          |
| `grep -iE "warn\|act(\|console.error\|not wrapped"` over full test output                                                                               | no matches                                   |

Every temporary mutation (`LineSelect.tsx`'s guard, `host-link.ts`'s
assignment, `App.tsx`'s new branch) was restored in the same edit/verify
cycle before moving on; `git status --short` was empty before staging, and
`git diff` against HEAD showed zero changes to `LineSelect.tsx` and
`host-link.ts` at the end — only the three intended files changed.

### Files changed (fix round 1)

- `apps/standalone/src/app/App.tsx` — `selectLine`'s `certificate_mismatch`
  branch (item 3).
- `apps/standalone/test/app.test.tsx` — two new tests (items 2 and 3).
- `apps/standalone/test/line-select.test.tsx` — `act` import and the fixed
  "waits for a sync" test (item 1).

No changes to `src/app/LineSelect.tsx` or `src/app/host-link.ts`: both were
only used for temporary, fully-reverted mutation checks.

### Commit

**`931362d2d`** — "fix(standalone): ревью задачи 4 плана 1c3 — тест ожидания
синхронизации, повтор, смена сертификата", on top of `531e9e12c`. Trailer
verified with `git log -1 --format=%B` to be exactly:

```
fix(standalone): ревью задачи 4 плана 1c3 — тест ожидания синхронизации, повтор, смена сертификата

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

(single trailer, no other `Co-Authored-By` line, not an amend — a new commit
on the branch).

### Concerns (fix round 1)

None. All three items addressed with red/mutation evidence recorded, the full
suite is green (395/395), typecheck/lint/build-relevant checks are clean, and
the diff is scoped to exactly the three files the fix required.
