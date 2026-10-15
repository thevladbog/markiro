# Plan 2a5, Task 8 — report (status bar, forget with unsent records, quarantine guard, a11y addenda)

Worktree `/tmp/claude/wt/2a5-floor`, branch `claude/2a5-floor`, base `3bad8e151` (Task 7). Commit: **`41bb37f54`** (one commit; trailer is the single `Co-Authored-By: Claude Opus 5.5` line; `git status --short` empty after it).

Status: **DONE_WITH_CONCERNS** (concerns at the end are small and none blocks the task).

## What was done

Brief (Task 8), applied as written:

- `src/local/outbox.ts` (new): `countUnsentRecords(local, pairing | null)`, per pairing or all pairings, `null` when the DB cannot be read.
- `FloorStatusBar`: `deviceName`, `shiftId` (number read from the copies, only while the id on screen matches), `deviceNotSaved` in its own polite region that is on screen before the warning; `.floor-status__health` CSS.
- `screens.tsx`: `UnsentRecords`, `UnsentNotice`, `unsent`/`onConfirm` on `ConfigErrorScreen`, `DeviceRejectedScreen`, `OtherHostScreen`; `App.tsx`: `forget(keepUnsent)` with the `unsent_facts` branch (count, notice, «Сбросить всё равно» → `forget({ keepUnsent: true })`), `setUnsent(null)` after a forget; `ru.json` `shell.unsent.*`, `floor.status.device|shift|deviceNotSaved`.
- `reference-sync.ts`: `org_profile` and `lines` upserts take `notQuarantinedNewer`.

Mandatory addenda (`2a5-minors.md`):

- **Item 8**: `FloorStatusBar` prop `refusalHeld` (App: `state.pendingRejection !== null`), key `floor.status.refusalHeld` = «Хост отказал этой станции: записи не отправляются. Выйдите из смены и подключите станцию заново.», shown in the same polite region as `deviceNotSaved`. App test triggers the refusal through a CALL (`device.refresh` rejects with `DeviceError("key_rejected")` after a revision event, not `link_status`), sees the marker while the bar still says «На связи с хостом», the link stopped, the work screen still there; leaving gives the rejection screen.
- **Item 12**: `ShiftList` now says the standing message (refusal, else office-close notice) AND the link state (offline, else «list not updated») together in the one polite region (new modifier class `floor-sign-in__message--stack` for the spacing). Offline still subsumes «list not updated» (redundant text), documented in a test.
- **Item 14**: `NewShift` problem `Alert` no longer a `role="alert"` inside `aria-live="polite"`: `role="presentation"` on the Alert (the component spreads `...rest` after its own role), so the polite region announces it once. Same done for the new status-bar alerts and the shift list's four alerts (they sit in polite regions as well).
- **Item 17**: JSDoc of `WorkScreenProps` carries the 2a6 obligations (track before start, no scan while `leaving`, bounded tracked work ~35 s / 5 s / 300 ms, focus rule). Focus rule implemented: leave button uses `aria-disabled` (not `disabled`), dimmed via `style`, ignores the press (`onClick` undefined while `leaving`); stays focused. The existing Task 7 stub test that asserted `disabled === true` was updated to the new behaviour.
- **Item 19**: `ShiftList` takes focus on mount (`useLayoutEffect`, the «Вошёл: …» paragraph with `tabIndex={-1}`); tests: ShiftList mount, FloorApp leave from work (with held work, after release), FloorApp «Назад» from a new shift; plus a test that a re-read of the copies does not steal focus from a button.
- Items 15, 16, 18, 20 not touched.

## Anchor adaptations

All brief fragments matched exactly once; none needed adaptation. Applied by meaning (same text): the `FloorStatusBar` doc comment, `App.tsx` fragment 3 (`repair` → `forget`/`repair`/`confirmRepair`) as the brief shows. Deviations from the brief's text, all additive: the extra tests below; `refusalHeld` prop; `role="presentation"` on Alerts; the brief's single «warns while a change … was not saved here» test replaced by a stronger version of the same (same text assertions plus live-region identity and no-alert checks); the brief's `floor-status-bar` helper `bar()` has the extra default `refusalHeld={false}`.

## Evidence

RED (before any source change; `test/outbox.test.ts` could not resolve `../src/local/outbox.js`): `Tests  23 failed | 367 passed (390)` over 8 files (the brief's five plus the addenda and my extra tests); log `/tmp/claude/impl-2a5-t8/red.err`/`red.out`.

GREEN (`--testTimeout=60000`, then also the default 5 s): the 7 files `floor-status-bar, outbox, app, reference-sync, floor-shift-list, floor-new-shift, floor-app`: `Test Files 7 passed`, `Tests 389 passed (389)`, **stderr 0 bytes** both with `--reporter=verbose` and in the default run. The brief's four files: **197** tests (plan states 181; the difference is my extra tests, listed below).
Delayed-`setImmediate` stand (the plan's two temp files, deleted right after, `git status` clean): the same 7 files, 389 passed, stderr 0 bytes.
Full package (`--testTimeout=60000`): `Test Files 87 passed (87)`, `Tests 2518 passed (2518)`, stderr 0 (Task 7 review measured 2486/2487 before; the plan's 82/2050 is a scratch-copy count on another base; no known-slow file timed out this time).
`typecheck` exit 0, `lint` exit 0, `build` exit 0 (chunk-size warning only), `prettier --check apps/standalone/src apps/standalone/test` clean, `git diff --check` clean, `grep -rnF '\u04'` only `src/host/pairing-code.ts:66`, `cargo fmt --check` clean. No Rust touched; cargo tests not run (the brief names none).

### Extra tests I added (beyond the brief)

`outbox.test.ts`: other host with the same device id; empty outbox with `null` pairing; unreadable DB for both modes. `app.test.tsx`: other-host screen with unsent records; unknown count wording («есть записи смен…» without a number); a failed confirmed reset keeps the notice and button with the reason; a confirmation does not carry over to the reconnected device's next refusal; the refusal-from-a-call marker; device name + shift number in the bar and the shift dropped after leaving; `deviceNotSaved` warning in the bar from `device.refresh` `storage` failure and cleared by the next saved read; the config-unreadable test also checks `forget` call args. `floor-status-bar.test.tsx`: shift number not kept after the next shift cannot be read / is missing; no shift of another pairing; live-region identity (region exists before the text); no `role="alert"` inside; refusal marker alone, with `deviceNotSaved`, and removed. `floor-shift-list.test.tsx` (6 region tests + 2 focus tests, see items 12/19). `floor-new-shift.test.tsx`: refusal said once in a pre-existing polite region, progress shares the region. `floor-app.test.tsx`: focus after leave (held work) and after «Назад»; stub-test update for `aria-disabled`.

## Mutants (one line each; all restored byte-identically — `cmp` and `shasum -a 256` before/after, pre-mutation copies in `/tmp/claude/impl-2a5-t8/pre/`, logs `/tmp/claude/impl-2a5-t8/mut/*.txt`, `muts1.log`, `muts2.log`, every record has `"restored": true`; 43 killed, 1 equivalent)

| #                          | file: mutant                                                                           | killed by (first failing test)                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| B1                         | App: `forget(undefined)` instead of `keepUnsent`                                       | «asks before it forgets a rejected device…» (+2)                                                                    |
| B2                         | StatusBar: drop `shift.id === shiftId`                                                 | «names the device, and the shift…»                                                                                  |
| B3                         | outbox: pairing query `? IS NOT NULL AND ? IS NOT NULL`                                | outbox «are counted for the pairing…», app «asks before…»                                                           |
| B4                         | reference-sync: `lines` guard → `WHERE true`                                           | «keeps an older organization or line out…»                                                                          |
| B5                         | reference-sync: `org_profile` guard → `WHERE true`                                     | same test                                                                                                           |
| M1                         | outbox: drop `acked_at IS NULL` (pairing)                                              | outbox «are counted for the pairing, or for every…»                                                                 |
| M2                         | outbox: drop `WHERE acked_at IS NULL` (all)                                            | same                                                                                                                |
| M3                         | outbox: drop `host_id` filter                                                          | «are counted for the host of the pairing only»                                                                      |
| M4                         | outbox: `catch` returns 0                                                              | «are unknown when the database cannot be read»                                                                      |
| M5                         | App: `refusalHeld={false}`                                                             | «says in the status bar that the host refused the station…» (item 8 mutant)                                         |
| M6                         | App: `shiftId={null}`                                                                  | «names the device and the shift in the status bar…»                                                                 |
| M7                         | App: `deviceName={null}`                                                               | same                                                                                                                |
| M8                         | App: `deviceNotSaved={false}`                                                          | «warns in the status bar…»                                                                                          |
| M9                         | App: drop `setUnsent(null)`                                                            | «does not carry a confirmation over…»                                                                               |
| M10                        | App: pairing → always `null` (count all)                                               | «asks before…» (2 vs 3)                                                                                             |
| M11                        | App: `confirmRepair` → `forget(false)`                                                 | 3 forget tests                                                                                                      |
| M12                        | App: `unsent_facts` code check broken                                                  | 4 tests                                                                                                             |
| M13–M15                    | screens: drop `UnsentNotice` in ConfigError / DeviceRejected / OtherHost               | «counts the records of every pairing…» / «asks before…» / «asks the same of a device paired to another host…»       |
| M16                        | screens: unknown-count branch off                                                      | «says there are records not yet sent, without a number…»                                                            |
| M17                        | screens: confirm button does nothing                                                   | 4 tests                                                                                                             |
| M18                        | StatusBar: `false && refusalHeld`                                                      | «says in the same polite region that the host refused…»                                                             |
| M19                        | StatusBar: polite region only while a warning shows                                    | refusal test and «warns while a change…»                                                                            |
| M20 / M21                  | StatusBar: drop `role="presentation"` (warn / error alert)                             | «warns while…» / refusal test                                                                                       |
| M22                        | StatusBar: device row always                                                           | «names no device for a pairing file that has no name»                                                               |
| M23                        | StatusBar: `deviceNotSaved` never                                                      | two tests                                                                                                           |
| M25                        | StatusBar: failed re-read keeps the old shift                                          | «keeps the number of the shift read before out…»                                                                    |
| M26 / M27                  | ShiftList: one message hides the other (either order)                                  | 3–4 region tests                                                                                                    |
| M28–M31                    | ShiftList: drop `role="presentation"` on refusal / notice / offline / readFailed alert | one region test each                                                                                                |
| M32                        | ShiftList: offline no longer subsumes «not updated»                                    | «keeps the lost link as the one thing said of the link…»                                                            |
| M33                        | ShiftList: no focus on mount                                                           | ShiftList focus test + 2 FloorApp focus tests                                                                       |
| M34                        | ShiftList: no `tabIndex={-1}`                                                          | focus test                                                                                                          |
| M35                        | ShiftList: focus on every render                                                       | «does not take the focus back from a button…»                                                                       |
| M36                        | NewShift: drop `role="presentation"`                                                   | «says a refusal once…»                                                                                              |
| M37                        | WorkScreen: `disabled={leaving}` instead of `aria-disabled`                            | stub test                                                                                                           |
| M38                        | WorkScreen: `onClick={onLeave}` while leaving                                          | stub test                                                                                                           |
| M39                        | WorkScreen: `aria-disabled={leaving}` (renders `false`)                                | stub test                                                                                                           |
| M24 (survives, equivalent) | StatusBar: `setShift(copy === null ? shift : …)`                                       | none: the `shift.id === shiftId` guard hides a stale copy, so resetting to `null` is redundant; behaviour identical |

## Concerns / notes

- `OperatorSignIn`'s polite regions still hold `role="alert"` Alerts (same double announcement); outside Task 8's list, left unchanged. The `role="presentation"` workaround exists because `@markiro/ui` `Alert` hard-codes `role="alert"` (not mine to change).
- `App`'s `unsent` state is cleared only after a successful forget; if the rejection screen goes away another way (not via forget) the next rejection screen would still show the old count. Not reachable in the tested flows; a one-line reset when the view changes could be added later.
- Visual/browser checks not done (no real WebView, no screen reader): the new CSS (`.floor-status__health`, `.floor-status__alerts`, `.floor-sign-in__message--stack`), the visible focus ring on the list's prompt paragraph, and real assistive-technology behaviour of `role="presentation"` inside a live region are verified only structurally in jsdom.
- Anchors/counts: plan says 181 tests in the four files and 2050 total on its scratch tree; measured 197 and 2518 on this tree (more tests from my extras and other plans).
