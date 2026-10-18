# Plan 1d3, Task 1 report: FormDialog, writeFailure, useCan

Status: DONE (no blocking concerns; two low-severity observations below).
Commit: `79071d81e` feat(standalone): общая основа записи офиса — FormDialog, writeFailure с конфликтами, useCan
Branch: `claude/autonomous-desktop-station-9e6f13`, worktree `ecstatic-swirles-7f0ae8`. Not pushed.

## What was implemented

New, verbatim from the brief:

- `apps/standalone/src/office/FormDialog.tsx`: the shared office dialog. It owns submission itself: the flag is a
  `useRef` set synchronously in the submit handler (plus `useState` only to re-render the buttons), so a second submit,
  Escape, the overlay, the x and "Отмена" are all refused from the moment of submit until the `onSubmit` promise settles.
  Supports `submitDisabled`, `submitVariant` (`primary` | `destructive`), `open` (for a dialog that stays mounted) and
  an `alert` slot above the fields.
- `apps/standalone/src/office/access.ts`: `CAPABILITIES` table of spec 4.8 (`editReference: admin`,
  `editCatalog: admin + technologist`), `can(role, capability)`, `useCan(capability)`.
- `apps/standalone/test/form-dialog.test.tsx`: 11 tests (FormDialog 6, WriteFailureAlert 3, capabilities 2).

Replaced whole, verbatim:

- `src/office/form-errors.ts`: `writeFailure(error, fields, conflicts = {})` now also sorts `conflict` by
  `details.constraint`; a fields-map value may be a field name or `{ field, message }`; keys are looked up with
  `Object.hasOwn` only (a host field named `constructor` no longer becomes `Object`); new `alertFailure`, `AlertFailure`,
  `FieldMessage`, `useFieldError`. `failureMessage` kept (now typed with `AlertFailure`).
- Five dialogs moved onto `FormDialog` + `WriteFailureAlert` + `useFieldError`: `CreateUserDialog` (now maps
  `conflict/login` through `CREATE_CONFLICTS` instead of hand-rolled code), `EditUserDialog`, `SetPasswordDialog`,
  `ChangePasswordDialog` (own text `rules.password` for `newPassword` via a `FieldMessage`; the
  `credential === "password"` branch stays explicit), `CounterDialog` (`sscc_below_floor` branch stays explicit).
- `apps/standalone/test/form-errors.test.ts`: 10 tests (the 5 original tests are byte-for-byte the same; only the import
  line changed, and 5 new cases were added).

Edited by fragment:

- `src/office/page-state.tsx`: added `WriteFailureAlert` (stale + `onReload` shows `StaleAlert`; stale without it, and any
  other failure, shows the error text; `null` shows nothing).
- `src/office/sscc/BlockSizesForm.tsx`: uses `WriteFailureAlert` and `useFieldError`; the request body is now built field
  by field (`boxBlockSize`, `palletBlockSize`, `expectedRev`) instead of `{ ...sizes }`.
- `src/office/sscc/SsccPage.tsx`, `src/office/org/OrgProfilePage.tsx`: "form or read-only" decided by
  `useCan("editReference")`; `OrgProfileForm` uses `WriteFailureAlert` and `useFieldError`.
- `apps/standalone/AGENTS.md` ("Office pages"): documents `FormDialog`, `writeFailure`/`WriteFailureAlert`, `useCan`, and
  the field-by-field request-body rule.

## TDD evidence

RED (after writing the two test files, before any implementation):

```
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/form-errors.test.ts test/form-dialog.test.tsx test/users-page.test.tsx test/sscc-page.test.tsx test/office.test.tsx test/org-page.test.tsx
```

```
 ❯ test/form-dialog.test.tsx (0 test)
 ❯ test/form-errors.test.ts (10 tests | 4 failed) 8ms
     × puts a conflict the form knows under its field, with the form's own text
     × gives a field its own text when the form names one
     × never takes an inherited object key for a field or a constraint
     × explains a write that has no field to go under
 FAIL  test/form-dialog.test.tsx
 Error: Failed to resolve import "../src/office/access.js" from "test/form-dialog.test.tsx". Does the file exist?
 AssertionError: expected { kind: 'alert', …(1) } to deeply equal { kind: 'field', field: 'name', …(1) }
 (gives a field its own text) the whole { field, message } object landed in `field`
 (inherited key) `"field": [Function Object]`
 TypeError: alertFailure is not a function
 Test Files  2 failed | 4 passed (6)
      Tests  4 failed | 61 passed (65)
```

This is exactly the RED the brief predicted (file counts, test counts and each of the four failure reasons).

GREEN (same command, after implementing):

```
 Test Files  6 passed (6)
      Tests  76 passed (76)
```

76 = 10 (form-errors) + 11 (form-dialog) + 14 (users-page) + 10 (sscc-page) + 23 (office) + 8 (org-page), as the brief states.

## Verification commands and results

| Command                                                                                                                         | Result                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| baseline (before any change) `vitest run` on form-errors, users-page, sscc-page, office, org-page                               | 5 files, 60 tests passed                                                                                                                                                          |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test` (full suite; run before AND after commit)           | 30 files, 547 tests passed, exit 0 (both times)                                                                                                                                   |
| `... typecheck` (`tsc -p tsconfig.json --noEmit`; tsconfig includes `src` and `test`)                                           | exit 0 (before and after commit)                                                                                                                                                  |
| `... lint` (eslint)                                                                                                             | exit 0 (before and after commit)                                                                                                                                                  |
| `node_modules/.bin/prettier --check` on all 15 changed files                                                                    | "All matched files use Prettier code style!"                                                                                                                                      |
| `git diff --check` (tracked) and `git diff --cached --check` (staged, includes the 3 new files)                                 | both clean, exit 0                                                                                                                                                                |
| `vitest run --reporter=verbose test/form-dialog.test.tsx` (stdout and stderr captured separately)                               | 11 passed; stderr 0 bytes; no console output in stdout                                                                                                                            |
| `vitest run --reporter=verbose test/form-errors.test.ts`                                                                        | 10 passed; stderr 0 bytes; no console output                                                                                                                                      |
| verbose run of the four page suites the converted dialogs feed (users-page, sscc-page, office, org-page)                        | 55 passed; stderr 0 bytes; grep for `act(`, Warning, stdout/stderr blocks, console., "not wrapped", Unhandled, Error found nothing                                                |
| `grep -nE '\\u[0-9a-fA-F]{4}'` over the 15 files                                                                                | no literal `\uXXXX` anywhere; real Cyrillic present in FormDialog.tsx, AGENTS.md and form-dialog.test.tsx                                                                         |
| Effect-race stress: temporary setup delaying `setImmediate` by 3 ms plus temporary config (recipe from the project memory note) | six files: 76/76; full suite: 30 files / 547 tests passed. A probe confirmed the harness was live (`setImmediate` waited 3.9 ms vs 0.1 ms normally). Both temporary files deleted |
| 8 repetitions of the six files under the normal config and 8 under the slow-setImmediate config                                 | 0 failures out of 16                                                                                                                                                              |
| commit message check: `git log -1 --format=%B`                                                                                  | subject plus exactly one trailer line, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (grep -c = 1, exact-line match OK); working tree clean after the commit          |

Fragment application: each of the 19 code fragments (page-state 2, BlockSizesForm 4, SsccPage 6, OrgProfilePage 7) and the
AGENTS.md fragment was applied by a script that asserts the old text occurs exactly once; all 20 matched, so the brief's
fragments do match the baseline byte for byte (no NEEDS_CONTEXT case).

Not run and why: this task is webview-only (jsdom via Vitest). No browser or visual check, no Tauri shell, no Windows and no
hardware run; no Rust or Cargo (not touched, as the brief says). `graphify update .` was not run because this worktree has
no `graphify-out/` (the repo rule applies only when a local graph exists).

## Files changed (15: 3 new, 12 modified)

New: `apps/standalone/src/office/FormDialog.tsx`, `apps/standalone/src/office/access.ts`,
`apps/standalone/test/form-dialog.test.tsx`.

Modified: `apps/standalone/AGENTS.md`, `apps/standalone/src/office/ChangePasswordDialog.tsx`,
`apps/standalone/src/office/form-errors.ts`, `apps/standalone/src/office/org/OrgProfilePage.tsx`,
`apps/standalone/src/office/page-state.tsx`, `apps/standalone/src/office/sscc/BlockSizesForm.tsx`,
`apps/standalone/src/office/sscc/CounterDialog.tsx`, `apps/standalone/src/office/sscc/SsccPage.tsx`,
`apps/standalone/src/office/users/CreateUserDialog.tsx`, `apps/standalone/src/office/users/EditUserDialog.tsx`,
`apps/standalone/src/office/users/SetPasswordDialog.tsx`, `apps/standalone/test/form-errors.test.ts`.

680 insertions, 363 deletions. Only these 15 paths were staged (explicit paths).

## Deviations

None. Every dialog the brief names was converted; nothing was left unconverted. The existing page suites (`users-page`,
`sscc-page`, `office`, `org-page`) and `test/support/*` were not touched: `git diff` on them is empty. The only edited test
is `form-errors.test.ts`, which the brief replaces whole (`git diff --numstat`: 92 added, 1 removed, the import line).

Trailer note: the environment's generic attribution guidance suggests a different model name in the trailer. I used the
project-pinned `Claude Opus 5.5` as instructed, and confirmed all 40 most recent commits on the branch carry exactly it.

## Self-review

- Completeness against the brief: all 27 numbered edits in Step 3, the tests of Step 1, the AGENTS.md text of Step 5, and
  the Step 6 checks are done. Names and signatures match the brief's "Produces" list (`FormDialogProps`, `AlertFailure`,
  `FieldMessage`, `writeFailure`, `alertFailure`, `failureMessage`, `useFieldError`, `WriteFailureAlert`,
  `OfficeCapability`, `can`, `useCan`).
- No overbuilding: nothing added beyond the brief. `errorProp` is untouched and still used by `NetworkPairing`,
  `OfficeLogin` and `BootstrapWizard` (so the `errorProp` reference in the `useFieldError` doc comment stays valid);
  `StaleAlert` is still used, now by `WriteFailureAlert`; `useOfficeSession` is gone from `SsccPage` and `OrgProfilePage`.
- Behaviour parity of the converted dialogs (read against the old code): a stale write in a dialog without `onReload`
  reads as the same `errors.api.stale_revision` text; `ChangePasswordDialog` keeps the `credential === "password"`
  branch ahead of `writeFailure`; close-while-sending is now guarded in one place for all five dialogs.
- Check of the brief's central claim ("the flag is set at once, in the handler"): the brief's own test 3
  ("waits while the form is being sent") clicks a submit button that is already disabled, so it would also pass with a
  plain state flag. I therefore ran throwaway probes (deleted, not committed) that deliver two `submit` events, or a
  submit plus Escape, inside a single `act` batch, i.e. before any re-render. The real component passes both. Broken
  copies fail as expected: no submit guard fails the double-submit probe; unguarded close fails the Escape probe; a
  state-flag-instead-of-ref copy fails both. So the `useRef` guard is doing the work the brief describes.

## Concerns (low severity, none blocking)

1. Test gap, by the brief's design: the committed tests cannot tell the immediate `inFlight` ref from a state flag (see
   the self-review). I did not add the two probes to `form-dialog.test.tsx` because the brief fixes the file at 11
   tests and the suite total at 547. They are about 30 lines; the controller may want them as permanent tests, for
   example in Task 2 when a real dialog next touches `FormDialog`.
2. `FormDialog.send` runs `void onSubmit(event).finally(...)`, so an `onSubmit` that rejects becomes an unhandled
   rejection (and the `.finally` clean-up still runs). All five current callers pass a react-hook-form `handleSubmit`
   whose callback catches everything, and the old `void submit(event)` had the same property, so this is not a
   regression. The new dialogs in the next tasks (counterparties, lines, devices) must keep their `onSubmit` from
   rejecting, or `FormDialog` should get a `.catch` later.
3. Naming nuance for readers: `OrgProfileForm` still spreads `{ ...toOrgInput(values), expectedRev }`. That spreads a
   purpose-built body from a builder function, not raw form values, so it is consistent with the AGENTS.md rule
   added here ("built field by field, never spread from form values"), but it looks like an exception at a glance.

---

# Fix round 1

Commit: `1f3caab1f` (`1f3caab1fd04fa89f7bfbb0de6b895cd84f9769d`) fix(standalone): ревью задачи 1 плана 1d3 — тест защиты от второй отправки, синхронное исключение отпускает диалог
A new commit on top of `79071d81e` (not an amend; `HEAD~1` is `79071d81e`). Not pushed.
Only two files changed: `apps/standalone/src/office/FormDialog.tsx` and `apps/standalone/test/form-dialog.test.tsx`
(58 insertions, 5 deletions). `useFieldError` and every other file are untouched.
Counts: `form-dialog.test.tsx` 11 -> 12 tests, full suite 547 -> 548 tests (30 files).

## Item 1: the "no second send" assertion now tests FormDialog's guard

`test/form-dialog.test.tsx`, the existing test "waits while the form is being sent: no second send, no way to close"
(extended in place; no test added for it). The events now run inside ONE outer `act(() => { ... })`, so React renders
nothing between them and the buttons are still enabled when each event arrives:

```
click(submit); click(submit); keyDown(dialog, Escape); click(overlay); click(×); click(Отмена)
expect(onSubmit).toHaveBeenCalledTimes(1);  expect(onClose).not.toHaveBeenCalled();
```

The overlay is found with `screen.getByRole("dialog").closest(".mk-modal-overlay")` (with a null check, no `!`).
The pre-existing assertions (disabled buttons after the render, post-render Escape and ×, the release, the second send) are
kept unchanged after it.

One small extension over the snippet in the fix request: the act also contains the × click and the "Отмена" click,
so that every way to close is exercised before the render. The reason is mutant `R` below: Cancel wired straight to
`onClose` (leaving only `disabled` to stop it) is caught only by a Cancel click made before the render; the snippet's
Escape and overlay clicks share Modal's `onClose` and cannot see it.

### Mutation checks (both required ones, plus finer variants), with outputs

Method: `FormDialog.tsx` was backed up (sha256 `235ab5e6838300422de3203b6b6b0a027a1eae9ee6601bba8215d70cde311076`),
each mutant was written from the backup, the WHOLE `test/form-dialog.test.tsx` file was run
(`pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/form-dialog.test.tsx --reporter=verbose`),
and the file was restored from the backup after every mutant. In every mutant run only the targeted test failed
(`Tests  1 failed | 11 passed (12)`). Control (unmutated): `Tests  12 passed (12)`.

The old-test column is the test as committed in `79071d81e`, run against the same mutants from a throwaway copy (deleted).

| Mutant                       | What it changes                                                                               | Old test (79071d81e)                                                                                                             | New test                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `A_delete_guards` (required) | deletes the immediate `inFlight` guard at both sites (`send` and `close`)                     | fails, only through the post-render Escape and ×: `expected "vi.fn()" to not be called at all, but actually been called 2 times` | fails: `expected "vi.fn()" to be called 1 times, but got 2 times`                                |
| `B_state_flag` (required)    | replaces the ref with a plain state flag (`if (sending) return;`, `if (!sending) onClose();`) | PASSES: 11/11 (blind)                                                                                                            | fails: `expected "vi.fn()" to be called 1 times, but got 2 times`                                |
| `A1_delete_send_guard`       | deletes only `if (inFlight.current) return;`                                                  | PASSES: 11/11 (blind; this is the assertion the review flagged)                                                                  | fails: `called 1 times, but got 2 times`                                                         |
| `A2_delete_close_guard`      | closes unguarded: `onClose();`                                                                | fails (`onClose` called 2 times)                                                                                                 | fails: `not to be called at all, but actually been called 4 times` (all four routes got through) |
| `A3_never_set_flag`          | removes `inFlight.current = true;`                                                            | fails (`onClose` called 2 times)                                                                                                 | fails: `called 1 times, but got 2 times`                                                         |
| `B1_state_flag_send_only`    | state flag in `send` only                                                                     | PASSES: 11/11 (blind)                                                                                                            | fails: `called 1 times, but got 2 times`                                                         |
| `B2_state_flag_close_only`   | state flag in `close` only                                                                    | PASSES: 11/11 (blind)                                                                                                            | fails: `not to be called at all, but actually been called 4 times`                               |
| `R_cancel_bypasses_close`    | Cancel `onClick={onClose}` instead of `close`                                                 | PASSES: 11/11 (blind)                                                                                                            | fails: `not to be called at all, but actually been called 1 times`                               |

So the review's diagnosis holds for the send guard and for the state-flag substitution, and the old test was also blind to
Cancel bypassing `close`. It was not blind to a fully unguarded `close`, which its post-render Escape and × still catch.

After every run, and at the end, `shasum -a 256 src/office/FormDialog.tsx` was `235ab5e6...11076` and
`cmp src/office/FormDialog.tsx <backup>` exited 0: restored byte-identical.

## Item 2: a synchronous throw no longer locks the dialog

Fix (`FormDialog.tsx`): `void new Promise<void>((resolve) => resolve(onSubmit(event))).finally(...)`, with a two-line
comment saying why. `onSubmit` is still called synchronously inside the submit handler.

New test (the only one added): "releases the dialog when onSubmit throws before it returns a promise, and lets the
failure surface". It clicks submit on an `onSubmit` that throws synchronously, inside `await act(async ...)`, and asserts:
the submit button is enabled again, Cancel closes the dialog (`onClose` called once), and the failure was not swallowed
(an `unhandledRejection` listener installed with `process.on` inside the test, removed in `finally`, records exactly one
reason, the very error thrown). It must not fail the run: Vitest's own handler returns early when another
`unhandledRejection` listener exists (`vitest/dist/chunks/init.k9zZ9sLh.js`, `catchError`: "if there is another listener,
assume that it's handled by user code"), so the test's listener is enough and Vitest's is left alone. `waitFor` was added
to the RTL import for the last assertion. The release assertions come first, so a failure on the old code points at the
locked dialog.

RED, on the unfixed `FormDialog.tsx` (test file already changed), same command with `--reporter=verbose`:

```
 ✓ ... > waits while the form is being sent: no second send, no way to close 28ms
 × ... > releases the dialog when onSubmit throws before it returns a promise, and lets the failure surface 15ms
   → expected <button type="submit" …(4)>…(2)</button> to have property "disabled" with value false
 Test Files  1 failed (1)
      Tests  1 failed | 11 passed (12)
     Errors  1 error
 ⎯⎯⎯⎯⎯ Uncaught Exception ⎯⎯⎯⎯⎯
 Error: thrown before a promise
```

(Item 1's rewritten test passes on the unmutated code, as it should; the uncaught exception is the throw escaping into
React's event handler on the old code, never reaching `.finally`.)

GREEN, after the fix, `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/form-dialog.test.tsx test/form-errors.test.ts --reporter=verbose`:
`Test Files  2 passed (2)`, `Tests  22 passed (22)`, stderr 0 bytes, no `Errors` line, no console output.

Two more mutants keep the new test honest (same method as above):

| Mutant                                                               | Result                                                                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `S_no_promise_wrapper` (back to `void onSubmit(event).finally(...)`) | the new test fails: `expected <button ...> to have property "disabled" with value false`, plus `Errors  1 error` (the uncaught throw) |
| `L_swallow_rejection` (`.catch(() => undefined)` after `.finally`)   | the new test fails: `expected [] to have a length of 1 but got +0` (the failure must stay loud)                                       |

## Item 3: the contract in the prop doc

`FormDialogProps.onSubmit` now reads: sends the form; the dialog waits until the promise settles; it sorts its own
failures into a field error or the `alert` and must not reject; a rejection, or a throw before the promise, still
releases the dialog but surfaces as an unhandled rejection; that is intended, since a `.catch` there would hide a bug in
the caller. (I wrote "a field error or the `alert`" rather than only "`alert`", because the dialogs put field errors under
their fields.)

## Item 4: nothing else

No other file, no `useFieldError`, no `AGENTS.md`, no changes to any other test.

## Commands and results (all run before the commit on the identical content; the last group again after it)

| Command                                                                                                                                                                               | Result                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RED: `... exec vitest run test/form-dialog.test.tsx --reporter=verbose` (unfixed component)                                                                                           | 1 failed, 11 passed; 1 unhandled error (see above)                                                                                                                                            |
| GREEN focused: `... exec vitest run test/form-dialog.test.tsx test/form-errors.test.ts --reporter=verbose` (stdout and stderr captured separately; run again right before the commit) | 22 passed, exit 0; stderr 0 bytes; grep for `stdout`/`stderr` blocks, `act(`, warning, `console.`, "not wrapped", unhandled, uncaught found nothing                                           |
| four page suites verbose: `users-page`, `sscc-page`, `office`, `org-page`                                                                                                             | 55 passed; stderr 0 bytes; the same grep found nothing                                                                                                                                        |
| `... --filter @markiro/standalone test` (full suite)                                                                                                                                  | 30 files, 548 tests passed, exit 0, no `Errors` line (before and after the commit)                                                                                                            |
| `... typecheck`                                                                                                                                                                       | exit 0 (before and after the commit)                                                                                                                                                          |
| `... lint`                                                                                                                                                                            | exit 0 (before and after the commit)                                                                                                                                                          |
| `node_modules/.bin/prettier --check` on the two changed files                                                                                                                         | "All matched files use Prettier code style!" (before and after the commit)                                                                                                                    |
| `git diff --check` and `git diff --cached --check`                                                                                                                                    | both clean, exit 0                                                                                                                                                                            |
| `grep -nF '\u04'` on the two files, and a `\uXXXX` search over the added diff lines                                                                                                   | nothing; the added Cyrillic (button names in the test) is real characters                                                                                                                     |
| stress: temporary 3 ms delayed-`setImmediate` config (created and deleted again)                                                                                                      | six affected files 10 runs each config and `form-dialog.test.tsx` alone 25 runs each config: 0 failures out of 70 (10 x 2 + 25 x 2); full suite under the harness: 30 files, 548 tests passed |
| `git log -1 --format=%B`                                                                                                                                                              | the requested subject plus exactly one trailer line, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (count 1, exact-line match, subject exact match); tree clean after the commit  |

Not run: anything outside jsdom (no browser, Tauri, Windows or hardware), no Rust; `git stash` and `pnpm install` were not used.

## Concerns (low severity, none blocking)

1. The new test leans on Vitest's rule that an `unhandledRejection` with a second listener present is left to user
   code. That is in the runner's source (v4.1.11), not a documented API. If a future Vitest changed it, the test would
   fail loudly (the run would report an unhandled error), not pass silently.
2. `AGENTS.md` ("Office pages") describes `FormDialog` in words but does not yet state that `onSubmit` must not reject;
   only the prop doc does. Left alone because the fix request said not to touch any other file; a one-line addition there
   may be worth making when the next dialogs (Tasks 2 to 6) are documented.
