# Plan 1d4, Task 8 — report

Status: DONE. Commit `ae9c15e4d` `feat(standalone): «Этот ПК» в «Устройствах», одно объявление сбоя справочников`
(12 files, +191/-22, on `claude/autonomous-desktop-station-9e6f13`, on top of `5764d98bb`). Nothing pushed, no new branch, no stash.

## What I implemented

1. **This PC.** New `src/office/this-device.tsx` (`ThisDeviceProvider`, `useThisDeviceId`). `Office` takes `deviceId?: string | null`
   (default `null`) and wraps the router in `ThisDeviceProvider`; `App` passes `pairedStatus?.deviceId ?? null`. In `DevicesPage`
   the name cell gets a `Badge tone="info"` «Этот ПК» for the row whose id equals `useThisDeviceId()` (same pattern as the «Вы» chip in
   `OfficeUsersPage`), and `RevokeDeviceDialog` takes `own: boolean` and shows `office.devices.revokeOwnTitle` / `revokeOwnBody`
   for this PC. Nothing blocks the revoke. New i18n keys: `office.devices.thisDevice`, `revokeOwnTitle`, `revokeOwnBody`
   (all three used; text exactly as in the brief).
2. **One announcement of a sync failure.** `LineSelect`: `syncFailed = sync.kind === "failed" || sync.failure !== null`; the alert
   (`role="alert"`) stays mounted through the automatic retries, the retry button gets `loading={sync.kind === "running"}`, the
   read-failure branch is unchanged (`readFailed && sync.kind !== "running"`). Comment rewritten as in the brief.
3. **Documents.** `apps/standalone/AGENTS.md` (App shell: the alert stays through retries; Office pages «Устройства»: the row of this PC,
   the stricter revoke, the rejected-device screen) and spec §5.5 (one bullet). Re-read of the required sections, see below.

No Rust, `apps/station`, `proto`, `host` or `src-tauri` file touched; no dependency added; queued minors not acted on.

## What I tested and the results

All commands from the repo root, `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone …`.

| Check                                                                                       | Result                                                                                                |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| RED, 3 files (Step 2)                                                                       | 4 failed / 112 passed (116), the four expected tests                                                  |
| GREEN, 3 files (Step 4)                                                                     | 116 passed: `devices-page` 29, `line-select` 21, `app` 66                                             |
| `--reporter=verbose`, stdout and stderr to different files                                  | 116 passed, **stderr 0 bytes**, no `act(...)` / React warnings                                        |
| Delayed-`setImmediate` stand (two temp files created exactly as in the notes, run, deleted) | 116 passed, stderr 0 bytes; both temp files removed before lint                                       |
| Full `test`                                                                                 | **37 files, 772 tests passed**; stderr only pnpm's `$ vitest run`                                     |
| `typecheck` / `lint`                                                                        | exit 0, no output besides the script echo                                                             |
| `build`                                                                                     | exit 0; the `chunks larger than 500 kB` warning is pre-existing (already in the Task 1, 6, 7 reports) |
| `prettier --check` on the 12 changed files                                                  | clean                                                                                                 |
| `grep -rnF '\u04' apps/standalone/src apps/standalone/test`                                 | only `src/host/pairing-code.ts:66`                                                                    |
| `git diff --check`                                                                          | clean                                                                                                 |
| Cargo                                                                                       | not run: this task changes no Rust and the brief's last step does not ask for it                      |
| `graphify update .`                                                                         | not applicable: no `graphify-out/` in this worktree                                                   |

**Why the totals differ from the brief (36 files / 722 tests).** The brief's absolute numbers predate the fix rounds of Tasks 4-7. At HEAD
`5764d98bb` the suite already had 37 files / 769 tests (the three files of this task: 113 tests, measured before any edit). The task's own
delta is +3, as in the brief (722 - 719): `devices-page` +1, `line-select` +1 (one test replaced, one added), `app` +1; measured 113 -> 116
in the three files and 769 -> 772 in the suite. The three per-file counts (29 / 21 / 66) and the 4-of-116 RED match the brief exactly.

## TDD Evidence

**RED** — `pnpm … exec vitest run test/devices-page.test.tsx test/line-select.test.tsx test/app.test.tsx` after Step 1 only:
`Test Files 3 failed (3)`, `Tests 4 failed | 112 passed (116)`, exit 1. Failures, each for the expected reason (behaviour not built yet):

- `app.test.tsx > the office on this device > tells the office which device it runs on…` —
  `TestingLibraryElementError: Unable to find an element with the text: Этот ПК.`
- `devices-page.test.tsx > office devices > marks this PC's row in words and asks more before this PC revokes itself` — same message.
- `line-select.test.tsx > LineSelect > keeps the failure's own alert, and no second failure line, while a retry runs…` —
  `Unable to find an element with the text: Не удалось получить справочники с хоста.` (the alert was swapped for the spinner).
- `line-select.test.tsx > LineSelect > announces a failed sync once: its alert stays mounted through the automatic retries` —
  `Unable to find an accessible element with the role "alert"` (the DOM dump at the failure shows the spinner: the first `getByRole("alert")`
  passes, the one after the `running` rerender fails).

**GREEN** — same command after Step 3: `Test Files 3 passed (3)`, `Tests 116 passed (116)`, exit 0, stderr empty (also verbose and under the stand).

## Mutation evidence

Method for each: `shasum -a 256`, copy of the file, scratch edit with an exact-once replace helper (`$TMPDIR/t8/replace-once.mjs`), the brief's command,
reverse edit, `shasum -a 256` again and `cmp` against the pre-mutation copy. (One `diff <(…)` I first used for the comparison is blocked by the
sandbox — process substitution; I compared the hashes with plain shell tests instead.)

| #   | File and edit                                                               | Command (filtered)                                                       | Result                                                                                    | Revert proof                                             |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | `App.tsx`: `deviceId={pairedStatus?.deviceId ?? null}` -> `deviceId={null}` | `vitest run test/app.test.tsx -t "which device it runs on"`              | FAIL, 1 failed / 65 skipped: `Unable to find an element with the text: Этот ПК.`          | sha256 `c6ad5a95…18b19d` before = after, `cmp` identical |
| 2   | `RevokeDeviceDialog.tsx`: title always `office.devices.revokeTitle`         | `vitest run test/devices-page.test.tsx -t "this PC revokes itself"`      | FAIL, 1 failed / 28 skipped: `Unable to find an element with the text: Отозвать этот ПК?` | sha256 `d1b8b2f8…4de70f` before = after, `cmp` identical |
| 3   | `LineSelect.tsx`: `syncFailed = sync.kind === "failed"`                     | `vitest run test/line-select.test.tsx -t "announces a failed sync once"` | FAIL, 1 failed / 20 skipped: `Unable to find an accessible element with the role "alert"` | sha256 `b03114e5…c7d74` before = after, `cmp` identical  |

Extra probes (not in the brief, evidence only, all reverted, nothing committed):

| Probe                                                      | Result                                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `LineSelect.tsx`: drop `loading={sync.kind === "running"}` | FAIL (`announces a failed sync once`): `expected <button …> to have property "disabled" with value true` |
| `DevicesPage.tsx`: `own={false}`                           | FAIL: `Unable to find an element with the text: Отозвать этот ПК?`                                       |
| `RevokeDeviceDialog.tsx`: body always `revokeBody`         | FAIL: `Unable to find an element with the text: «Рабочее место хоста» — этот ПК, на нём открыт офис. …`  |
| `DevicesPage.tsx`: badge condition `!==`                   | FAIL: `Unable to find an element with the text: Этот ПК`                                                 |

Revert incident, disclosed: for the first extra probe my helper refused the reverse edit (it rejects an empty "old" fragment because the mutation deleted a line),
so `LineSelect.tsx` stayed mutated in the working tree until I noticed and restored it with `cp` from the copy taken right before that probe. The three later extra probes
ran in the same command before the restore; they run only `test/devices-page.test.tsx`, which does not import `LineSelect`, so their results are unaffected.
Proof after the restore: sha256 `b03114e5…c7d74` = the known-good hash recorded before mutation 3, `cmp` identical against both pre-mutation copies,
`loading={sync.kind === "running"}` present. The full suite, typecheck, lint, build and the commit all ran after the restore. At the end, HEAD's blobs of `LineSelect.tsx`,
`App.tsx`, `RevokeDeviceDialog.tsx`, `DevicesPage.tsx` hash-equal the pre-mutation worktree hashes.

## Documents re-read

Read as wholes (after the edits): `apps/standalone/AGENTS.md` «Local database», «Writes», «Change feed», «Operators and badges», «Reference sync», «App shell»,
«Office pages»; spec §4.6, §5.2, §5.3, §5.4, §5.5, plus §5.1 (it describes the line screen's retry and the status line, and my change touches that behaviour).
I also read the plan's whole diff of AGENTS.md (`d36668e08..HEAD`) to see which sentences the plan changed, and checked each against the code:
`local_db.rs` (`clear_copies`, `remove_unopened`, `secure_delete`, checkpoint), `lib.rs` (`device_forget` -> `storage`), `reference-sync.ts` (3E+6, `ENTITY_SET` with `;v3`,
`notQuarantinedNewer`, `hostGuard`), the worst-case-page test (`[1, 21]`), migration `0003`, `form-errors.ts`, the `submitVariant` uses, the try/catch of the three hashing dialogs,
`shell.ts` (`sync_started` keeps `failure`, `sync_finished` clears it), `DeviceRejectedScreen`.

The three explicit checks of the brief:

- «Office pages»: `writeFailure` names `line_name`, `login`, `badge` (also in `form-errors.ts`'s doc); in the `try` sit the write and the hashing of its body
  (`CreateOperatorDialog`, `OperatorPinDialog`, `AddBadgeDialog`), the callback is after `try/catch`, `catch` ends with `return`; `destructive` is used by the line archive,
  device revoke, badge revoke and operator turn-off (`turningOff ? "destructive" : "primary"`). True.
- «Reference sync»: budget 21 at E = 5 (E = 8 -> 30), `ENTITY_SET` with `;v3`, and the paragraph on `notQuarantinedNewer` and on what `hostGuard` does not catch (a same-host
  re-pair after the new stamp) agree with the `hostGuard` paragraph below (which is about the wrong host and the window between `clear_copies` and the new stamp) and with the
  «Operators and badges» precondition. No contradiction.
- «Local database»: no sentence says a reset clears nothing when the database did not open (grep over AGENTS.md, both specs, README, and the Rust and TS sources); the section says it is removed with its `-wal`, `-shm`, `-journal`.

Changes beyond the brief's exact edits: **none**. My new AGENTS.md sentences match the code in this commit (alert stays while `sync.failure !== null`, button `loading` while `running`,
`App` passes `deviceId` into `Office`, `useThisDeviceId`, badge and stricter dialog). One nit of the brief's own text, applied verbatim: in the «Устройства» bullet the short line
`rejected-device screen. A claim raises` was not re-wrapped (prettier accepts it).

Problems I met that are ALREADY in `1d4-minors.md` (left untouched): Task 7 #1 («fails as a whole» in «Local database»), Task 7 #3 (the limits of the no-hash guarantee are not stated),
Task 3 #3 (`operatorId` presented as always there in «Operators and badges» and §4.6), Task 1 #1 (the pairing screen's device name is not named as an exception in «Writes»),
Task 1 #6 («Their fields follow the host … a PIN»), Task 5 #6/#8/#9 (the in-flight residual of the badge code field is not recorded in «Office pages»), Task 5 #10 (the «a message under it stays» and
spec §5.5 «не удалось отправить» wording). No new contradiction found.

## Files changed (commit `ae9c15e4d`)

- new: `apps/standalone/src/office/this-device.tsx`
- `apps/standalone/src/office/Office.tsx`, `apps/standalone/src/app/App.tsx`, `apps/standalone/src/office/devices/DevicesPage.tsx`,
  `apps/standalone/src/office/devices/RevokeDeviceDialog.tsx`, `apps/standalone/src/app/LineSelect.tsx`, `apps/standalone/src/i18n/ru.json`
- tests: `apps/standalone/test/devices-page.test.tsx`, `apps/standalone/test/line-select.test.tsx`, `apps/standalone/test/app.test.tsx`
- docs: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-09-26-standalone-01-foundation-design.md` (§5.5)

Commit message is the brief's, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` appears exactly once (`git log -1 --format=%B`), no other `Co-Authored-By` line.
(The session's generic attribution reminder names another model; I followed the project's pin, as the brief and the constraints say.)

## Self-review findings

- Completeness: every step of the brief in order; all 5 test edits, 16 implementation edits and 3 doc fragments matched their anchors on the first try (helper checks "exactly once");
  all 3 mutations shown failing with the named messages; all 3 i18n keys used; no `\u04XX` escapes (only the allowed hit).
- Quality: the code is the brief's verbatim; `this-device.tsx` mirrors the existing context modules (`office-link.tsx`); the «Этот ПК» chip mirrors the «Вы» chip of `OfficeUsersPage`.
- Discipline: nothing beyond the brief; queued minors untouched; scratch files (helper, fragments, logs, the delay stand) live in `$TMPDIR` or were deleted.
- Testing: the new tests assert behaviour (the same DOM node stays mounted across `running`/`failed` reruns; the button is disabled while running; the own-PC dialog has its own title and body;
  the other device keeps the usual one; the revoke call goes to the right id). Output is pristine.

## Issues and concerns

- Not verified (environment could not): the chip's look in the real table (WebView2, light and dark themes); NVDA announcing one failure once (jsdom proves the node stays mounted,
  not what a screen reader says); revoking this PC end to end (host refuses the key -> `key_rejected` or `unauthorized` -> `DeviceRejectedScreen`): the tests stub `revokeDevice`,
  the AGENTS sentence rests on reading `shell.ts` and `App.tsx`, and the plan's final list already carries this as a manual two-PC check.
- Observation, no action: with `loading` the retry button becomes `disabled` while it may hold focus, so a keyboard user's focus falls to `body` during the run and after it
  (before this change the whole alert was unmounted, so no regression); worth a look in the browser pass.
- Observation, no action: a new failure class arriving while the alert is mounted (host -> local, say) changes its text in place, which a screen reader will announce — intended, it is new information.
