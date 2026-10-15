# Plan 1f2, Task 6 report: the floor's status bar

BASE: 89eedf435576886c92d417dbb09aea491d369f99
Commit: 396079316 `feat(standalone): the floor's status bar above the sign-in screen and the stub` (one trailer: Claude Opus 5.5, verified with `git log -1 --format=%B`). `git status --short` is empty afterwards.

## What was done

Steps 1-7 were applied in the brief's order.

- Created `src/floor/floor-status.ts` (`FloorPlace`, `readFloorPlace`) and `src/floor/FloorStatusBar.tsx` verbatim from the brief.
- `ru.json` gained `floor.status`, and `shell.css` gained `.floor-frame` and `.floor-status*`.
- `App.tsx` now draws one `.floor-frame` for `floor` and `floor_operator`. It holds `FloorStatusBar` plus either `OperatorSignIn` or `FloorOperatorScreen`. The `link` prop is gone from both screens, and so is their own `HostStatusLine`.
- `OperatorSignIn.tsx` is exactly the brief's 4 fragments. It was not touched elsewhere, so Task 5's fix (manual-text-entry cleanup, `toStage` calling `source.clearPendingInput()`) is intact.
- Tests: new `floor-status-bar.test.tsx` (7 tests) and the new `app.test.tsx` test. `operator-sign-in.test.tsx` lost `link` and the "shows the link to the host" test, which moved into the status-bar test file. `floor-operator.test.tsx` lost `link`.

### Deviation: one extra anchor

`test/operator-sign-in.test.tsx` has a fifth `link={null}` at about line 1217. It sits at 12-space indentation in the "re-render with another sync state" test, in `<OperatorSignIn lineId={null} link={null} sync={sync} ...>`. The brief lists 4 fragments, and none of them matches this site: the 8- and 10-space anchors need a different indentation after the newline. TypeScript rejects an excess prop, so I removed that `link={null}` line as well. The diff is a pure 1-line deletion. The four listed fragments each matched exactly once.

## RED / GREEN evidence

RED (`vitest run test/floor-status-bar.test.tsx test/app.test.tsx -t "status bar"`, exit 1):

- `test/floor-status-bar.test.tsx`: `Failed to resolve import "../src/floor/floor-status.js"`.
- `app.test.tsx > shows the status bar above the sign-in and the stub...`: `Unable to find role="region" and name "Строка состояния цеха"`.

GREEN:

- `typecheck`: exit 0. `lint`: exit 0.
- Package `test`: exit 0, 66 files, 1712 tests, 0 `stderr |` lines.
- The 4 touched files with `--reporter=verbose`: 4 files, 184 tests, 0 `stderr |` lines.
- The same 4 files under the delayed-`setImmediate` stand: 4 files, 184 tests, exit 0, 0 `stderr |` lines. The stand's two files were deleted afterwards.
- `prettier --check apps/standalone/src apps/standalone/test`: clean.
- `git diff --check`: clean.
- `grep -rnF '\u04'`: only `src/host/pairing-code.ts:66`.

I ran no cargo checks and no `build`: the task touches no Rust and not the shell crate, and the test suite does not need the embedded `dist`.

## Test totals

| Item         | Plan, as brief states | Brief with +9 shift | Measured |
| ------------ | --------------------- | ------------------- | -------- |
| Vitest files | 66                    | 66                  | 66       |
| Vitest tests | 1703                  | 1712                | **1712** |

The measured count equals the shifted number exactly. The brief's own count is therefore 1703 before the +9 for the earlier tasks, and the new total matches it. The new tests are 7 in `floor-status-bar.test.tsx` plus 1 in `app.test.tsx`, minus 1 removed from `operator-sign-in.test.tsx`.

## Mutants (all restored byte-identically: `cmp` silent, `shasum -a 256` equal before and after)

| #   | Mutant (one line)                                                                  | Test that failed                                                                    | Key line                                                                                                            |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | `floor-status.ts`: delete the `copiesReady` guard line (the brief's mutation)      | `names nothing from copies that are not this pairing's`                             | `AssertionError: expected { organization: 'ООО «Атолл»', …(1) } to deeply equal { organization: null, line: null }` |
| 2   | `floor-status.ts`: `WHERE id = ? AND archived = 0`                                 | `names the organization and the line ..., an archived line too`                     | `AssertionError: expected { organization: 'ООО «Атолл»', …(1) } to deeply equal …`                                  |
| 3   | `FloorStatusBar.tsx`: drop `sync.synced` from the effect deps                      | `reads the names again after every sync`                                            | `Unable to find an element with the text: ООО «Атолл»`                                                              |
| 4   | `FloorStatusBar.tsx`: drop the rejection handler of `readFloorPlace().then`        | `leaves the names out when the copies cannot be read`                               | `Unhandled Rejection Error: disk`. The 7 tests pass, but vitest exits 1 on the unhandled rejection.                 |
| 5   | `FloorStatusBar.tsx`: `<HostStatusLine status={null} …>`                           | `shows the link to the host`                                                        | `Unable to find an element with the text: Нет связи с хостом`                                                       |
| 6   | `App.tsx`: `operator={null}` always                                                | `app.test.tsx > shows the status bar above the sign-in and the stub...`             | `Unable to find an element with the text: Анна Кузнецова, табельный номер 0042`                                     |
| 7   | `FloorStatusBar.tsx`: `{false && (` instead of `{place.organization !== null && (` | `shows the organization, the line ...` and `reads the names again after every sync` | `Unable to find an element with the text: ООО «Атолл»`                                                              |

## Self-review and concerns

- No behavioural concern.
- Mutant 4 shows up as an unhandled rejection, not as a failed assertion. The test fails the run (exit 1), but a stricter assertion that the page stays alive would be a plan-level improvement.
- Not covered by a mutant or test:
  - the `cancelled` flag in the effect cleanup (a late read after unmount or re-render);
  - the `orgs.length === 1` defence. It differs only if `ref_org` held more than one row. I kept it verbatim from the plan.
- `.floor-frame` and `.floor-status` CSS, the status bar's look on the monitor, and the 64 px rule are not visually verified. The status bar has no interactive elements, so the 64 px rule does not apply to it.
- The Windows kiosk window, the Tauri shell and Task 1 (the owner's `Cargo.toml` step) were not touched or verified here.
