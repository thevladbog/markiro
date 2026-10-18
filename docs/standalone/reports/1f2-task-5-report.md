# Plan 1f2, Task 5 report — operator name search on the sign-in screen

Status: DONE. BASE 4071c12e2; commit `7cb9ddb11 feat(standalone): find an operator by name on the sign-in screen` (trailer: one Opus 5.5 line, verified).

## What was done

Plan steps 1-7 applied verbatim, in order. All anchors matched once (my first scripted attempt for the `sign-in.ts` doc-comment anchor failed on a trailing newline I added myself; nothing was written, anchor re-run without it). Created `src/floor/operator-search.ts`, `test/operator-search.test.ts`; changed `scan-source.ts` (`setManualTextEntryActive`), `sign-in.ts` (`readOperatorRoster`, `ROSTER`, `rosterRow`), `OperatorSignIn.tsx` (step `search`, 64 px «Офис» and «Повторить»), `ru.json`, `shell.css`, `operator-sign-in.test.tsx`, `app.test.tsx`. No manifest, host, proto, shell, or plan file touched; nothing else changed.

## RED (before implementation)

`vitest run test/operator-search.test.ts test/operator-sign-in.test.tsx` exit 1: `test/operator-search.test.ts` — `Failed to resolve import "../src/floor/operator-search.js"`; `operator-sign-in.test.tsx` — 10 failed | 53 passed (63), exactly the plan's 10 (6 name-search tests, 2 source tests, 2 size tests).

## GREEN

- 4 files (`operator-search`, `operator-sign-in`, `app`, `floor-sign-in`): 4 passed, 216 tests (plan 215; see counts).
- `typecheck` and `lint`: exit 0, no output beyond the command line.
- Full `test`: 65 files, 1699 tests passed (plan 65 / 1696; +3 = the 2 own tests of Task 3 and 1 of Task 4, as announced).
- `--reporter=verbose` on operator-search, operator-sign-in, app: 3 files, 159 tests, `stderr |` count 0.
- Same three files under the delayed-`setImmediate` stand: 3 files, 159 tests passed; stand files removed (`git status` clean after the commit).
- prettier --check, `git diff --check`: clean; `grep -rnF '\u04'` finds only `src/host/pairing-code.ts:66`.
- `cargo`/`build` not run: Task 5 touches no shell or dist-embedded Rust.

## Mutants (each reverted byte-identically: `cmp` silent, same `shasum -a 256`)

| #   | Mutant                                                                                                                 | Test that failed                                                                                        | Key line                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| M1  | drop `if (manualTextEntry) return;`                                                                                    | 3: hands nothing over...; leaves the field's own Enter alone; does not take a name typed into the field | `expected [ 'Анна', 'MRK-1' ] to deeply equal [ 'MRK-1' ]`; `expected true to be false` |
| M2  | drop the unmount `setManualTextEntryActive(false)` effect                                                              | gives the scanner back when the screen goes...                                                          | `expected [] to deeply equal [ 'MRK-000742' ]`                                          |
| M3  | `ROSTER` without `NOT_QUARANTINED_OPERATOR`                                                                            | lists this pairing's operators... none waiting in quarantine                                            | `expected [ {3}, {3} ] to deeply equal [ {3} ]`                                         |
| M4  | drop `copiesReady` in `readOperatorRoster`                                                                             | reads nothing from copies that are not this pairing's                                                   | `expected [ {3} ] to be null`                                                           |
| M5  | drop the `LOGIN.test` filter                                                                                           | matches the words in order and skips a number the keypad could not type                                 | deep-equal of 3 vs 2 entries                                                            |
| M6  | `slice(0, LIMIT + 1)`                                                                                                  | offers at most five names                                                                               | 6 ids vs 5                                                                              |
| M7  | drop the two-letter minimum                                                                                            | folds case and runs of spaces, and waits for two letters                                                | `expected [ {...} ] to deeply equal []`                                                 |
| M8  | «Назад» on the PIN always to `login`                                                                                   | goes back from the PIN to the search as it was...                                                       | 1 failed                                                                                |
| M9  | drop `setChosenName(null)` on the keypad route                                                                         | same test (the «Табельный номер 0077» assertion)                                                        | 1 failed                                                                                |
| M10 | «Офис» `size="compact"`                                                                                                | both size tests                                                                                         | `expected 'mk-btn mk-btn--secondary mk-btn--comp…' to contain 'mk-btn--floor'`          |
| M11 | drop `onBlur` of the field                                                                                             | does not take a name typed... (scanner stays deaf after blur)                                           | `expected vi.fn() to be called with arguments: [ {4}, null ]`                           |
| M12 | `toStage` no longer calls `setManualTextEntryActive(false)` (keys typed before a step change would join the next scan) | drops the keys typed before a step changes...                                                           | same                                                                                    |
| M13 | `onFocus` no-op                                                                                                        | does not take a name typed into the field for a badge scan                                              | `expected <div> to be null`                                                             |
| M14 | comparator always 0                                                                                                    | offers at most five names; matches the words in order...                                                | order mismatch                                                                          |

No mutant survived; no test strengthened.

## Counts, plan vs measured

|                        | plan                  | measured              |
| ---------------------- | --------------------- | --------------------- |
| RED `operator-sign-in` | 10 failed / 53 passed | 10 failed / 53 passed |
| 4-file run             | 4 files, 215          | 4 files, 216          |
| full Vitest            | 65 files, 1696        | 65 files, 1699        |

The 4-file run is +1, the full run +3: the announced +3 from Tasks 3 and 4 lands partly outside those four files (the brief's totals were measured before them); I did not edit the plan.

## Self-review

- Secrets: the roster query selects only `id, login, name`; test asserts no `pbkdf2` and an identity-only key set; no PIN/badge/hash in DOM, logs, or errors added. The typed name is the field's, never a scan.
- Scan source: `setManualTextEntryActive` clears the buffers on both transitions, and the screen restores it on unmount/step change (no blur fires when the field unmounts).
- Stale answers: the roster effect uses a `cancelled` flag and re-reads after every sync; the result/results block is `aria-live="polite"`.
- Visual check of `.floor-sign-in` gap `16px` and the results grid not done (no browser run; the plan marks it unverified).

## Concerns

None blocking. Unverified by this task: real browser focus/blur behaviour with the physical keyboard wedge and WebView2, and the visual layout of the search step.

## Fix section (review: Important 1, Minor 1, Minor 2)

BASE 7cb9ddb11; commit `fix(standalone): the scanner is not left deaf when the name field disappears`. Files: `src/floor/OperatorSignIn.tsx`, `test/operator-sign-in.test.tsx`.

### Change

- Important 1: the unmount-only effect is replaced by a layout effect keyed on `nameFieldShown` (stage `search` and readiness `ready` with operators > 0, i.e. exactly when the `Input` is rendered) and `source`; its cleanup is `setManualTextEntryActive(false)`. It runs in the commit that removes the field (alert, notice, step change, screen unmount), so a scan right after is not dropped. Blur/focus handlers unchanged.
- Minor 1: with the cleanup, `toStage`'s flag reset became redundant (every stage change out of `search` removes the field), so a test for «only that reset» cannot exist. `toStage` now calls `source.clearPendingInput()` (buffer only; flag reset is the field's job). The new step-change test (focus, choose a result without blur, scan on the PIN step) is the guard for the transition; it fails on the reviewer's C2 mutant against the old code (shown below) and on dropping the cleanup after the fix (F1, F3).
- Minor 2: new test types into the reopened search and requires «Читаем справочник операторов…» with no stale name before the re-read lands.

### RED (current code, new tests only)

`vitest run test/operator-sign-in.test.tsx`: 3 failed | 66 passed (69): `hears a badge again after a failed read`, `… after copies that are not ready`, `… after no operators`; key line `expected "vi.fn()" to be called with arguments: [ { …(4) }, null ]  Number of calls: 0`. The step-change test, the control and the Minor 2 test pass on old code, as expected (old code already reset in `toStage`; they are guarded by the mutants below). Reviewer's C2 against old code (`toStage`: `clearPendingInput()` instead of the flag reset): the step-change test and the 3 above fail (4 failed | 65 passed), then old code restored (cmp, sha identical).

### GREEN

3 files (operator-sign-in, operator-search, app): 165 passed (was 159, +6 new tests). Full package `test`: 65 files, 1705 tests (was 1699). `typecheck`, `lint`: exit 0. `--reporter=verbose` x3: `stderr |` count 0 (an act warning found on the way, from awaiting `synced()` after render, was fixed in the test). Delayed-`setImmediate` stand: 3 files, 165 passed, no stderr; stand files removed. prettier, `git diff --check`: clean; `\u04` grep: only `pairing-code.ts:66`.

### Mutants (OperatorSignIn.tsx; copy in /tmp/claude, `cmp` silent, sha256 `2fd8bb1ba0f1…` before = after each)

| #   | Mutant                                                 | Failed tests                                                       | Key line                                                                                           |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| F1  | cleanup body `return () => …` → `return;`              | 5: unmount-gives-back, choosing-a-name, 3 x «hears a badge again»  | `expected [] to deeply equal [ 'MRK-000742' ]`; `expected "vi.fn()" to be called with arguments …` |
| F2  | `readiness.operators > 0` → `>= 0` in `nameFieldShown` | `… after no operators`                                             | `expected "vi.fn()" to be called …`                                                                |
| F3  | `stage === "search" &&` → `true &&`                    | `gives the scanner back when choosing a name takes the field away` | `expected "vi.fn()" to be called …`                                                                |
| F4  | `toStage` drops `source.clearPendingInput()`           | `drops the keys typed before a step changes…`                      | buffer joins next scan                                                                             |
| F5  | drop `if (next === "search") setRoster(null);`         | `shows no name from the previous reading…`                         | `Unable to find an element with the text: Читаем справочник операторов…`                           |

No mutant survived.

### Concerns

None blocking. Real focus/blur with a physical wedge in WebView2 still not verified. The control test passes on old code by design.
