# 1b3 Task 6 report: SSCC office page

## What changed

Added the office page "SSCC" (`/sscc`) to `apps/standalone`, following the brief
verbatim (no deviations — see below):

- **Created** `apps/standalone/src/office/sscc/counter-kind.ts` —
  `counterKindKey(counter)`, the i18n key naming what a counter numbers
  (extension 0 → box, 1 → pallet, else → generic "extension N").
- **Created** `apps/standalone/src/office/sscc/CounterDialog.tsx` — the
  administrator-only dialog that moves one SSCC counter forward. Validates
  `nextSerial` with a zod schema bounded by `[counter.nextSerial, counter.maxSerial]`;
  on a `sscc_below_floor` response it raises the floor from
  `error.details.minSerial` and re-shows the "must be at least N" message: the
  host's counter moved meanwhile (printed elsewhere), and the dialog reflects
  the new floor instead of silently retrying. Other write failures go through
  the shared `writeFailure` triage (`stale` → `StaleAlert`, else a field/alert
  message).
- **Created** `apps/standalone/src/office/sscc/BlockSizesForm.tsx` — the
  administrator-only form for `boxBlockSize` (1–100 000) and `palletBlockSize`
  (1–10 000), sent with `expectedRev: state.blockSizesRev`. Same
  stale/field/alert triage as the counter dialog.
- **Created** `apps/standalone/src/office/sscc/SsccPage.tsx` — the page:
  loads `SsccState` via `useOfficeQuery(officeKeys.sscc, …)`, shows the
  counters table (current-GLN-prefix counters first, marked "текущий" with a
  `Badge`), and the block sizes (form for admins, `DefinitionGrid` + read-only
  note for technologists). An admin-only "Действия" column opens
  `CounterDialog`; a successful save patches the query cache in place
  (`replaceCounter`) rather than refetching, matching the pattern
  `OrgProfilePage` already uses for its own record.
- **Modified** `apps/standalone/src/office/nav.ts` — added the `/sscc` entry
  (both roles, "Organization" section) after the profile entry.
- **Modified** `apps/standalone/src/office/routes.tsx` — added the
  `SsccPage` import and the `{ path: "sscc", element: <SsccPage /> }` child
  route.
- **Modified** `apps/standalone/src/i18n/ru.json` — added `office.nav.sscc`
  and the `office.sscc.*` subtree (title, table headers, kind names, dialog
  copy, block-size labels/hints, error messages), all copied verbatim from the
  brief.
- **Modified** `apps/standalone/test/support/office.tsx` — added `SsccState`
  to the type import and appended the `SSCC_STATE` fixture (two prefixes: the
  current GLN's `460709100` and the earlier `460068200`, each with a box and a
  pallet counter).
- **Created** `apps/standalone/test/sscc-page.test.tsx` — the seven
  acceptance tests from the brief, copied verbatim.

No changes were needed to `@markiro/ui`, to `HostApi`, or to the wire
protocol: `getSscc`, `updateSsccCounter`, `updateBlockSizes`, `SsccState` and
`SsccCounter` already existed from task 3.

## TDD evidence

**Red** — `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/sscc-page.test.tsx`
run against `test/support/office.tsx` + `test/sscc-page.test.tsx` alone (before
any `src/office/sscc/*` file, `nav.ts`, `routes.tsx` or `ru.json` change):

```
 FAIL  test/sscc-page.test.tsx > SSCC page > shows a technologist the counters, current prefix first, and the blocks read-only
TestingLibraryElementError: Unable to find role="link" and name "SSCC"
 FAIL  test/sscc-page.test.tsx > SSCC page > moves a counter forward with its revision
TestingLibraryElementError: Unable to find role="link" and name "SSCC"
 FAIL  test/sscc-page.test.tsx > SSCC page > does not let a counter go back
TestingLibraryElementError: Unable to find role="link" and name "SSCC"
 FAIL  test/sscc-page.test.tsx > SSCC page > shows the host's floor when the counter moved meanwhile
TestingLibraryElementError: Unable to find role="link" and name "SSCC"
 FAIL  test/sscc-page.test.tsx > SSCC page > offers to load the counters again after a stale change
TestingLibraryElementError: Unable to find role="link" and name "SSCC"
 FAIL  test/sscc-page.test.tsx > SSCC page > saves the block sizes with their revision
TestingLibraryElementError: Unable to find role="link" and name "SSCC"
 FAIL  test/sscc-page.test.tsx > SSCC page > checks the block sizes against the host's limits
TestingLibraryElementError: Unable to find role="link" and name "SSCC"

 Test Files  1 failed (1)
      Tests  7 failed (7)
```

Matches the brief's expected outcome exactly ("FAIL — ссылки «SSCC» нет").

**Green** — same command, after all steps:

```
 RUN  v4.1.11 apps/standalone

 Test Files  1 passed (1)
      Tests  7 passed (7)
   Start at  00:24:01
   Duration  1.92s
```

No test adaptation was needed: `Table`'s literal `<table>/<tbody>/<tr>` markup
gives rows the implicit ARIA `row` role that `within(table).getAllByRole("row")`
picks up directly, and `Badge`/`DefinitionGrid`/`Modal` render exactly the
text/roles the tests query for. The brief's own caveat about possibly needing
to adapt `counterRows()` did not apply here — recorded for the reviewer per the
task's instructions even though no change was necessary.

## Verification commands and results

| Command                                                                                                                      | Result                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/sscc-page.test.tsx` (before code) | FAIL, 7/7 failing (red, expected)                                                                      |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/sscc-page.test.tsx` (after code)  | PASS, 7/7 (green)                                                                                      |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`                                                  | PASS — 18 test files, 212 tests                                                                        |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                                             | PASS (`tsc -p tsconfig.json --noEmit`, no output)                                                      |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`                                                  | PASS (`eslint .`, no output)                                                                           |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone build`                                                 | PASS — `vite build` succeeded (pre-existing >500 kB chunk-size warning only, unrelated to this change) |
| `node_modules/.bin/prettier --write <9 changed files>`                                                                       | all reported "unchanged"                                                                               |
| `node_modules/.bin/prettier --check <9 changed files>`                                                                       | "All matched files use Prettier code style!"                                                           |
| `git diff --check`                                                                                                           | no output (clean)                                                                                      |

`packages/ui/dist` and `packages/domain/dist` were already built in this
worktree (carried over from earlier tasks), so no dependency rebuild was
required before these consumer checks.

## Deviations from the brief

None. Every file was created/edited with the brief's exact code, i18n text and
test content. `nav.ts`, `routes.tsx` and `ru.json` were edited exactly as
instructed (new entry after the profile entry/route, new `sscc` key alongside
`org`).

## Concerns

- **Not verified**: real Tauri/host round-trip, and any visual/browser
  check — this task's verification surface is Vitest + typecheck + lint +
  build only, per the brief and `apps/standalone/AGENTS.md`; no dev server or
  browser session was exercised for this webview-only, mock-backed page.
- The pre-existing Vite "chunk larger than 500 kB after minification" build
  warning is unchanged by this task (it already applied to the bundle before
  this page existed) and was not addressed, since the brief scopes this task
  to the SSCC page only.
- `SsccPage`'s "Действия" column and `CounterDialog`'s save button both gate
  on `isDirty`, matching `OrgProfilePage`'s existing pattern; this means an
  administrator who opens the dialog and immediately clicks "Сохранить"
  without changing the value cannot submit (the button stays disabled). This
  mirrors the brief's own code exactly and the tests as given do not exercise
  that path, so it is left as specified rather than second-guessed.

## Fix round 1

Addressed one Important and two Minor findings from the reviewer.

### 1. Important — stale client-side floor in `CounterDialog.tsx`

**Bug.** The zod schema was memoized on `[counter]` and its `.min(...)` read
`counter.nextSerial`. After a `sscc_below_floor` answer, `setFloor(minSerial)`
updated only the input's `min`/hint, not the resolver: the `counter` prop
identity never changes while the dialog stays open, so the memo never
recomputed, and a retry with a value between the old and new floor passed
client-side validation and reached the host a second time.

**Fix.** `apps/standalone/src/office/sscc/CounterDialog.tsx`: the schema now
builds `.min(floor, "office.sscc.errors.belowFloor")` with memo deps
`[floor, counter.maxSerial]`, so a `setFloor` update produces a new schema
instance on the next render.

**react-hook-form resolver check (asked for explicitly).** Confirmed react-hook-form
_does_ pick up a new `resolver` on every re-render, so no workaround was
needed. Evidence, read directly from
`node_modules/.pnpm/react-hook-form@7.85.0_react@19.2.8/node_modules/react-hook-form/dist/index.cjs.js`:

- `exports.useForm` runs `o._options = t` unconditionally on every call (every
  render), where `t` is the full options object passed to `useForm(...)`
  (including the fresh `resolver: zodResolver(schema)`).
- Inside `createFormControl`, `_options` is not a plain field but an
  accessor: `get _options(){return n}, set _options(e){n={...n,...e}, ...}`.
  All internal validation code reads the resolver via this same closure
  variable `n` (e.g. `n.resolver`, `s._options.resolver`).
- So `o._options = t` on a render where `schema` (and therefore
  `zodResolver(schema)`) changed merges the new `resolver` into `n`, and the
  _next_ validation run (the next `handleSubmit`) reads the updated resolver.
  No stale closure is captured anywhere in this path.

This matches the observed test behavior exactly (see red/green below).

**Test.** Extended `"shows the host's floor when the counter moved
meanwhile"` in `apps/standalone/test/sscc-page.test.tsx`: after the first
"Номер должен быть не меньше 60" appears, the test now types `55` (between
the stale floor 40 and the new floor 60), clicks "Сохранить" again, asserts
the same message still shows, and asserts `updateSsccCounter` was called
exactly once (never a second time). Also added
`"checks a counter's value against its upper bound"` (Minor 3b, see below) in
the same pass since both needed the same fixture data.

**Red** — `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/sscc-page.test.tsx`,
run against the extended test with the schema still keyed off `counter`:

```
 ❯ test/sscc-page.test.tsx (9 tests | 1 failed) 794ms
     × shows the host's floor when the counter moved meanwhile 81ms

 FAIL  test/sscc-page.test.tsx > SSCC page > shows the host's floor when the counter moved meanwhile
AssertionError: expected "vi.fn()" to be called 1 times, but got 2 times
 ❯ test/sscc-page.test.tsx:121:43
    119|     fireEvent.click(within(screen.getByRole("dialog")).getByRole("butt…
    120|     expect(await screen.findByText("Номер должен быть не меньше 60")).…
    121|     expect(session.api.updateSsccCounter).toHaveBeenCalledTimes(1);

 Test Files  1 failed (1)
      Tests  1 failed | 8 passed (9)
```

The other 8 tests already passed at this point, including the two new Minor
3 tests below — expected, since those exercise pre-existing behavior
(`BlockSizesForm`'s stale handling, and `CounterDialog`'s untouched
`.max(...)` check), not the bug being fixed.

**Green** — same command, after keying the schema off `floor`:

```
 RUN  v4.1.11 apps/standalone

 Test Files  1 passed (1)
      Tests  9 passed (9)
```

### 2. Minor — English default text for an empty counters table

`apps/standalone/src/office/sscc/SsccPage.tsx`: added `empty={t("office.sscc.noCounters")}`
to the counters `Table`. `apps/standalone/src/i18n/ru.json`: added
`"noCounters": "Счётчиков пока нет."` under `office.sscc`, next to `"current"`.
No dedicated test was requested or added for this (the fixture always has
rows); verified only that the existing 9 `sscc-page` tests and the full
package suite stayed green.

### 3. Minor — two more tests in `test/sscc-page.test.tsx`

- **3a — block-sizes stale reload.** `updateBlockSizes` rejects once with
  `stale_revision`; `getSscc` answers `SSCC_STATE` then
  `{ ...SSCC_STATE, boxBlockSize: 5000, blockSizesRev: 9 }`. The test changes
  the box size, saves, clicks "Загрузить заново", and asserts the field shows
  `5000` and `getSscc` was called twice. This exercises `BlockSizesForm`'s
  existing stale-reload wiring (`StaleAlert` → `onReload` → `sscc.refetch()`
  → the `key={state.blockSizesRev}` remount picking up the host's newer
  values) — unchanged by this round, so it passed on first write.
- **3b — counter upper bound.** Opens the current prefix's box counter
  dialog, types `10000000` (one above `maxSerial` 9999999), saves, and
  expects "Укажите целое число от 1 до 9999999" (floor 1, the counter's own
  `nextSerial`) with `updateSsccCounter` never called. Exercises the
  untouched `.max(counter.maxSerial, ...)` branch, so it also passed on first
  write.

Both were added alongside the Important fix's test edit; the single red/green
pair above covers all three new tests in this file (the two Minor-3 tests
were part of the 8-passing set in the red run and stayed green afterward).

## Fix round 1 verification commands and results

| Command                                                                                                                                          | Result                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/sscc-page.test.tsx` (red, schema keyed off `counter`) | FAIL — 1/9 failing (`toHaveBeenCalledTimes(1)`, got 2)                                                                                             |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/sscc-page.test.tsx` (green, schema keyed off `floor`) | PASS — 9/9                                                                                                                                         |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/sscc-page.test.tsx` (after the `empty` prop change)   | PASS — 9/9                                                                                                                                         |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`                                                                      | PASS — 18 test files, 214 tests                                                                                                                    |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                                                                 | PASS, no output                                                                                                                                    |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`                                                                      | PASS, no output                                                                                                                                    |
| `node_modules/.bin/prettier --write <4 changed files>`                                                                                           | 3 unchanged; `test/sscc-page.test.tsx` reformatted (collapsed a multi-line `toHaveProperty` call — confirmed via `git diff` to be whitespace-only) |
| `node_modules/.bin/prettier --check <4 changed files>`                                                                                           | "All matched files use Prettier code style!"                                                                                                       |
| `git diff --check`                                                                                                                               | no output (clean)                                                                                                                                  |

Package `build` was not re-run in this round: no build-relevant behavior
changed (only a resolver's validation bound, an `empty` string prop, i18n
text and tests), and it was already verified green for this page in the
initial pass; typecheck (which would catch any compile break) is clean.

## Fix round 1 deviations from the instructions

None. The `.min(floor, ...)` / `[floor, counter.maxSerial]` change matches
the reviewer's exact instruction; the react-hook-form behavior was verified
rather than assumed, and it works, so no workaround was written; the `empty`
prop and i18n key match the reviewer's exact strings; both new tests match
the reviewer's scenarios (values, expected messages and call counts).

## Fix round 1 concerns

- Same "not verified" scope as before: no live Tauri/host or browser check.
- The block-sizes stale test (3a) and the counter upper-bound test (3b)
  already passed against the pre-fix code, since neither exercises the
  Important bug. Flagging this explicitly in case the reviewer expected all
  three new tests to be red first — only the extended floor-retry assertion
  was, and that is the one tied to the actual code change.
