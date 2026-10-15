# 2a7 FINAL whole-part review: the floor's printing

Branch `claude/floor-2a7`, worktree `/tmp/claude/wt/flr`. HEAD `f9f51c7d0`, base `370ec784c` (`claude/integration`), 12 commits, 45 files, +10 797 / −106.

## Verdict

**WITH FIXES.** Critical 0, Important 1, Minor 7 (2 of them DROP).

The print machine holds as one piece:

- No path re-sends a label by itself.
- No box closes without its job.
- Every waiting state has a way out.
- Recovery never runs beside a send.

The single Important is in the new setup screen. Its text fields feed the keyboard wedge, so the first scan of a test label after the operator types anything reads as «не тот код». I reproduced it with a scratch test.

The open question from Task 3 is **resolved, no code fix needed**. The host refuses any edit of an active shift's production date, and the shift number never changes. The job also stores its fields, so a reprint replays them. Only the two documents still call it "open" (m1, DOC).

---

## (a) Findings, most severe first

### Important

**I1. The setup's text fields feed the keyboard wedge: the first test-label scan after typing reads as a mismatch**

- **Where:**
  - `src/floor/setup/WorkstationSetup.tsx`: every `Input` (printer name, host, TCP port, COM port, speed, scanner port/speed). None calls `source.setManualTextEntryActive`, and nothing calls `source.clearPendingInput()`. The listener is at `:189-203`; `testPrint` is at `:335-353`.
  - `src/floor/scan-source.ts:49-69`: `createKeyboardWedgeSource` appends every printable `keydown` on `window` to its buffer unless `manualTextEntry` is set. Only `OperatorSignIn.tsx:203,385-386` sets it; plan 2a8's words field does too (its mutant M5).
- **Scenario:** the operator adds a printer (types its name, `192.168.1.50`, `9100`) or types a COM port. They press «Пробная печать» and scan the printed `MKR-…` code.
  - The wedge emits `"Zebra у линии192.168.1.509100MKR-7Q4F2N"`.
  - `scannedTestCode(raw) !== code`, so the screen says «Это не код пробной этикетки».
  - Only the second scan matches. The first reading of the setup's main check is false, which points the operator at a good printer or scanner.
  - An Enter typed in a field is also emitted as a "scan". It is harmless here, but against the project's own pattern.
- **Proof:** a scratch test (deleted; tree clean) rendered `WorkstationSetup` with the real `createKeyboardWedgeSource()`. It dispatched `keyDown` «COM3» on the «COM-порт сканера» field and cleared it, pressed «Пробная печать на «Zebra у линии»», then keyed the label's code plus Enter on `window`. The result was `{ match: false, mismatch: true }` (log `/tmp/claude/rev-2a7-final/wedge.txt`, 1 passed). The suite misses it because `floor-setup.test.tsx` uses a `fakeSource()` that delivers whole scans.
- **Fix:**
  1. Give every `Input` of the setup `onFocus={() => source.setManualTextEntryActive(true)}` and `onBlur={() => source.setManualTextEntryActive(false)}`, plus an effect cleanup that sets `false` on unmount (as `OperatorSignIn`).
  2. Call `source.clearPendingInput()` when a test label goes out (just before `setTest({ kind: "sent", … })`), so type-ahead in a `Select` cannot pollute it either.
  3. Add a test with the real wedge, as in the probe, expecting «Код совпал», plus a mutant per handler.

### Minor

**m1. The documents still call two final-review questions "open"; both are now answered (DOC)**

- **Where:**
  - `apps/standalone/AGENTS.md`, «Floor printing», the bullet «Open for the final review…» and the sentence «The shift's number and production date come from the shift copy (the host's last list)…».
  - Spec §21, the bullet «вопрос итогового ревью…».
- **Production date and number:**
  - `host/src/routes/office_shifts.rs:398-432` refuses `productionDate`, `boxCapacity`, line, template, counterparty and pallets on an `Active` shift (`ShiftStatus::Active if !fixed_changed`, otherwise `status_conflict`). This is pinned by `host/tests/office_shifts.rs:980-1026` (`an_active_shift_takes_only_its_plan_and_a_closed_one_nothing`, case `{"productionDate": "2026-10-09"}` → 409).
  - The number is assigned at creation and never updated.
  - The entry replaces the copy with the entry answer (`keepEnteredShift`).
  - The label reads the work screen's `shift` prop (the entered state), not a later list.
  - Every job stores its `fields` (`date`, `expiry`), and `printAgain` and 2a8's reprint replay them.
  - So a printed fact is never recalculated, and the SSCC/date pairing of a box is fixed at its close.
- **Stock label size**, measured now: a synthetic worst case (every text bitmap at its full `maxWidthPx × maxLines`, random bits), stock dated templates through `renderLabel`:

| Template          | ZPL 203 | ZPL 300  | TSPL 203 | TSPL 300 |
| ----------------- | ------- | -------- | -------- | -------- |
| 58×40             | 20.7 KB | 45.2 KB  | 10.6 KB  | 22.9 KB  |
| 75×120            | 34.5 KB | 73.4 KB  |          |          |
| 100×100 / 100×150 | 59.9 KB | 128.6 KB | 30.2 KB  | 64.5 KB  |

Real Cyrillic is smaller. Log: `/tmp/claude/rev-2a7-final/measure-out.txt`.

- **Fix:** rewrite both places to state the resolution with the numbers above, and say "the copy as entered (stable: the host refuses date edits of an active shift)" instead of "the host's last list".

**m2. A job's bytes outlive their use; the disk budget waits for plan 2a8 (CARRY 2a8 / owner, DOC numbers)**

- **Where:** `0007_floor_printing.sql`, `CHECK (state NOT IN ('sending','sent','unknown','verified') OR bytes_base64 IS NOT NULL)`; `prepareLabelJob`.
- **Scenario:**
  - About 20–45 KB per 58×40 label (up to 129 KB on a 100×150 at 300 dpi). At 500 boxes per shift, 2 shifts a day and 30 days of retention (plan 2a8), that is 30 000 jobs, roughly 0.6–1.3 GB at the 58×40 sizes above (worst case, ZPL 203/300).
  - A settled job's bytes are dead weight. 2a8's reprint renders afresh from `fields` and the template, and `printAgain` renders again whenever the bytes are null.
  - Only reads of one open job carry bytes over the IPC (`shiftLabelsSettled` counts), so speed is fine.
- **Decision needed before `0007` is merged anywhere:** the CHECK forbids clearing the bytes of `sent` and `verified`, and loosening it later is a table rebuild (the thing `purpose`/`subject_id` were chosen to avoid).
- **Recommendation:**
  - Keep it now (decision 19: «байты сохраняются»).
  - Record the numbers.
  - Let 2a8's retention delete settled jobs with the shift's facts (already planned, `RETAINED_TABLES` lists `floor_print_jobs`).
  - If the owner wants earlier clearing, relax the CHECK to `('sending','unknown')` in this wave, while `0007` is still unapplied.

**m3. A forget keeps a waiting job under the old pairing; the new pairing never shows it, and the forget does not count it (DOC + CARRY 2b)**

- **Where:**
  - `local_db.rs` `count_unsent` counts `outbox` only.
  - `floor_print_jobs` is `DeviceData` (kept by a forget).
  - Every read (`readOpenJob`, `shiftLabelsSettled`, `recoverInterruptedJobs`) is pairing-scoped, which is correct.
- **Scenario:** a box closed, its `box_closed` was acked, and its label is `failed`/`unknown`. The device is forgotten and paired again.
  - The job stays in the database, but no screen of the new pairing shows it.
  - The box has no `box_label` record on the host, and nobody is told.
  - Nothing is sent twice and no row is lost. The data-loss story is "a recovery nobody can reach", not lost data.
- **Fix:** one sentence in «Floor printing» (accepted list). For plan 2b, count the open jobs of the pairing in the forget's warning beside the unsent facts.

**m4. A `sending` job still in flight after a timeout shows the pending view, which no event re-renders (DOC)**

- **Where:**
  - `WorkScreen.tsx`, `onRecover` is computed at render from `props.printing.isInFlight(stop.job.id)`.
  - `LabelPanel.tsx:1581-1594` is the pending view (no buttons).
- **Scenario:** only when a send times out (`timeout`) and the final write of `unknown` then fails with a non-stale error.
  - The job stays `sending` while the stuck shell call still holds it.
  - The dismissal shows «Этикетка отправляется…» with no action.
  - When the call ends, nothing re-renders the panel, so the stalled check never appears until some other render, or a leave and a return (recovery then sees it out of flight).
  - «Выйти из смены» stays open, and nothing is sent.
- **Fix:** document it in the accepted list. If wanted later, `PrintRuntime` could expose a settle notification.

**m5. Two texts overclaim (FIX, text and tests)**

- `floor.print.pending.body`: «при возвращении программа скажет, вышла ли этикетка». The program cannot know; it asks («Печать прервалась. Посмотрите…»). Proposed: «…при возвращении программа предложит решить, вышла ли этикетка. Сама она ничего не отправит.»
- `floor.print.target.replaced`, «…; этикетка, возможно, лежит у прежнего»:
  - It is shown by `targetText` on the main view of a `failed` job too, where nothing left the computer.
  - Use the "may lie there" clause only when the label may exist (`unknown`, a waiting check).
  - For `failed`, add e.g. `target.replacedFailed`: «Принтер «{{former}}» удалён из настройки. Печать пойдёт на принтер: …».
  - Add a test on a failed job with a deleted printer.

**m6. The check's mismatch note echoes the scanned SSCC (DROP)**

- **Where:** `LabelPanel.tsx:1325`.
- **Scenario:** an 18-digit badge with a valid GS1 check digit would be shown in HRI.
- **Why DROP:** this needs a numeric badge of exactly SSCC shape. Naming the other box's SSCC is what lets the operator see which label was scanned, and the process log sees nothing.

**m7. A hostname and its IP are two queue keys (DROP)**

- **Where:** `printerTargetKey`.
- **Scenario:** the operator configures one printer twice, once by name and once by IP. Two sends could then overlap on it.
- **Why DROP:** the settings refuse duplicate keys only, and AGENTS.md already says to prefer an IP. Resolving DNS for a key is not worth it.

---

## Seams checked (what I did)

### (1) The print state machine end to end

Migration `0007` ↔ `print-jobs.ts` ↔ `print-resolution.ts` ↔ `WorkScreen`/`LabelPanel` ↔ the setup.

- **Every sender.** A grep of `src` finds exactly:
  - `settleLabel` (`WorkScreen.tsx:686`, `prepared` only).
  - `printAgain` (`print-resolution.ts:291`, the operator's).
  - The setup's test print (`WorkstationSetup.tsx:347`, `send(null, …)`, no job, no SSCC; my M5 is killed).
  - `printBytes` is called only by the runtime (`print-runtime.ts:92`).
  - So an `unknown` job is re-sent only by `printAgain`, which demands a reason (test «never prints a label that may exist without the operator's reason»).
  - The panel builds the reason from its buttons only, behind the 400 ms view guard (my M11/M12 are killed).
- **A box left without a decision:**
  - The job is a statement of the close's own transaction (`[label, ...closeSteps]`).
  - A lost answer is read back on `empty` (`readClosedBox`) and on a throw (`unsure`). Its job is settled in the same turn, or found by `readOpenJob` on the next entry.
  - A crash between the close and the job is impossible (one commit).
- **Pending labels at shift close:** `shiftLabelsSettled` counts rows with the same `OPEN` predicate as the index and `isOpenJob`. My M10 (cross-pairing count) is killed.
- **Operator way out:** «Выйти из смены» is outside the panel in every state.
  - Failed and unknown jobs offer skip with confirmation; a check offers «Пропустить проверку».
  - The stalled view has its check button; the pending view has the leave.
  - A leave waits for at most one send (20 s) plus two writes.
- **Restart with many jobs:**
  - Recovery at entry turns every `sending` of the pairing that is not in flight into `unknown/interrupted`.
  - A `prepared` job of another shift prints once, when that shift is entered (a first send).
  - At most one open job per shift can arise today. The ПЛ-Ц carry (m5 of Task 6) still stands.
- **Forget:** see m3.
- **Recovery concurrency:**
  - Entry runs refresh → recover → settle → close inside one queued, tracked job.
  - `recoverStalled` runs only through `decide` (`queue.run`).
  - Setup and work screen never coexist, and one runtime serves the app.
  - The window named in Task 4 m1 is closed by serialisation. My M13 (stalled button offered for an in-flight job) is killed.

### (2) The shell contract

- **`settleOutcome`** maps every `PrintFailureCode`:
  - `sent` only on `{ sent: true }`;
  - `outcome_unknown`, `timeout` → `unknown`;
  - `not_sent`, `invalid_*`, `unsupported`, `printer_busy` → `failed`.
  - TypeScript checks the mapping exhaustively, and the `ru.json` `floor.print.codes` keys match all 10 codes exactly (node check).
- **20 s limit:** one `createPrintRuntime` per `App`. The limit includes the queue wait (documented), the queue waits for the real settle (Task 4 fix), and `busy` bytes never reach the shell.
- **Targets:** queue key `printerTargetKey`: TCP (host lower-cased, trailing dot), serial (canonical COM), USB (lower-cased queue).
- **Keep-awake:** `createSystemAwake` holds with a generation counter. `App` calls `reset()` at start, the work screen holds while mounted, and the setup and lock screens are outside it (decision 34). A refused request is swallowed (manual list item).
- **Scanners:** `list_serial_ports` runs on request only, with an ask counter. `watchScanners` is stopped on unmount and on a late answer. `configure_scanners` is called at start (`applySavedScanners`) and after save.

### (3) Label correctness

- **Fields and bytes:**
  - Fields: domain `boxLabelFields` from the snapshot, with `shelfLifeExpiryDate` inclusive (`box-label.ts:96-97`).
  - Bytes: `generateZpl`/`generateTspl` at `withPrinterDpi(spec, printer.dpi)`, then `latin1ToBytes`.
  - The golden test pins `^BCN…^FD>;>800046006820000035007` (GS1-128 with FNC1) and `(00)…` HRI for ZPL, and `"!1000…"` for TSPL.
- **Mutants:** M1 (expiry +1 day) and M2 (dpi ignored) are killed.
- **Open question:** resolved (m1).
- **Test print:** a marked ASCII sample; M5 (barcode bound to `sscc`) is killed by «holds no SSCC, GTIN or code of a product, only its own test code».

### (4) Consumer contract (2a8, ПЛ-Ц)

- **Signatures:** `prepareLabelJob(label, settings, pairing, render?)` with `purpose: "box" | "pallet"`; `sendLabelJob(context, job, { rebind?, extra? })`; `readOpenJob` (oldest first, any purpose); `shiftLabelsSettled`; `recoverInterruptedJobs`. One open job per `(host, device, purpose, subject)`.
- **Close steps:** the screen's label step runs first, then `closeSteps`.
- **Retention:** 2a8's `RETAINED_TABLES` lists `floor_print_jobs`.
- **Plan fragment anchors.** A script (`/tmp/claude/rev-2a7-final/anchors.py`, output `anchors.txt`) checked every «Фрагмент» of those plans that names a file 2a7 changed:
  - **2a8:** 7 of 22 `WorkScreen.tsx` fragments, 8 of 15 `FloorApp.tsx`, 8 of 11 `ShiftList.tsx` and 4 of 5 `AGENTS.md` fragments still match. The rest must be applied by meaning. Some of the misses anchor on code 2a8's own earlier tasks add.
  - **ПЛ-Ц:** 3 of 43 `WorkScreen.tsx` fragments match, as do 1 of 6 `LabelPanel.tsx`, 1 of 2 `print-jobs.ts` and 0 of 4 `AGENTS.md`.
  - **Mismatches tied to 2a7's executed deviations:**
    - `Stop.close_failed` has a `cause`.
    - `settleLabel` uses `live.current` and `printContextOf(live)`, not `local`/`where`/`printContext`.
    - Recovery is NOT inside `settleLabel`; ПЛ-Ц fragment 8 re-adds `await recoverInterruptedJobs(printContext)` there.
    - The `LabelPanel` `Alert`s carry `role="presentation"`.
    - `Mode`/`press`/`show` changed with the view guard.
    - `OPEN` is not yet `OPEN_JOB_SQL`; 2a8 Task 3 renames and exports it.
    - The `sending` paragraph is `<p className="work-screen__waiting">`, not `aria-live`.
  - The full list is in (e).

### (5) Identity and data

- Every job read and write is pairing-scoped: `readPrintJob`, `readOpenJob`, `shiftLabelsSettled`, both `sendLabelJob` updates, `move`, `recoverInterruptedJobs`, the reprint insert, and `outboxStatement`. M10 is killed.
- No `console.` call in `print/`, `setup/` or `awake.ts`. The diff adds none.
- Secrets: none. The SSCC is in clear in the job, as it already is in `floor_boxes`. Bytes: see m2.

### (6) Tests as a suite

- **Hygiene** over the 10 new and changed print files (342 `it`): no sleep, no real `setTimeout`, no `.only`/`.skip`/`.todo`.
- **Ledger count chain:**
  - Vitest 3024 at base, then 3029 (T1) → 3048 → 3061 → 3104 → 3116 (T4 fix) → 3152 → 3201 → 3211 → 3253 → 3287 (T8).
  - Files go from 101 to 110 = 9 new test files, which matches the stat.
  - This is arithmetic consistency only. I did not re-run the suite.
- **Task 8 harness incident:** `git status --short` is empty. In the committed `workstation-settings.ts`, every S1–S6 guard is intact:
  - C0/C1 ranges;
  - `> MAX_PORT_NAME_CHARS`;
  - `>= MAX_SCANNERS` break;
  - the `sharedSerialPort` refusal in save, with `canonicalPort`.
  - My M7 on the same file is killed.
- **My mutants** (copies under `/tmp/claude/rev-2a7-final/*.orig`; sha256 and `cmp` checked after each; all restored; harness `mut.py`, logs `M*.log`). Each is killed by a named assertion, not a crash:

| #   | Task  | Mutant                                | Killing test                                                                        |
| --- | ----- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| M1  | 3     | expiry +1 day                         | «come from the shift's snapshot…», 3 date cases                                     |
| M2  | 3     | dpi ignored (always 203)              | «are the domain's document for the printer's language and resolution…»              |
| M3  | 5     | check without `parseScannedSscc`      | «verifies the scan of the job's SSCC…», «is the SSCC however the scanner wraps it…» |
| M4  | 5     | template revision not checked         | «refuses the layout of another template, by id as well as by revision»              |
| M5  | 7     | test barcode bound to `sscc`          | «holds no SSCC, GTIN or code of a product…»                                         |
| M6  | 2/8   | settings saved key by key             | «write all four keys or none…»                                                      |
| M7  | 8     | scanner port twice allowed            | «read a key with the wrong shape as its default only, and a port stored twice once» |
| M8  | 6     | `failed` re-sent automatically        | 4 tests, e.g. «keeps the next full box open while it waits»                         |
| M9  | 4     | newest open job first                 | «is the oldest one waiting… of this pairing only»                                   |
| M10 | 4     | `shiftLabelsSettled` across pairings  | «is not read, not waited for and not recovered by this pairing»                     |
| M11 | 6 fix | view guard removed                    | 4 tests, e.g. «does not take the second press of a double activation…»              |
| M12 | 6 fix | focus to the first button             | «moves the focus… onto a control that sends nothing»                                |
| M13 | 6 fix | stalled check offered while in flight | «offers no check for a send this app still holds…»                                  |

### (7) Documents

- **AGENTS.md:**
  - «Local database» counts: 21 tables, of which 11 are Disposable, 9 DeviceData and 1 Workstation. This matches `TABLE_CLASSES` (counted).
  - «Hardware», «Floor work» (the `closeSteps` order and the lost-answer story) and «Floor printing» are true to the code. I checked the 400 ms guard, the stalled button, recovery placement, settings atomicity, the shared-port rule, the test label and keep-awake. No overclaim found, except the two «open» items (m1).
  - The Verification bullet honestly lists what was not run.
- **Spec §21:** the same claims, the same two stale «open» items.
- **Numbering:** §21 is the next free section on this branch. `claude/office-chz` and `claude/infra-rk` add no section to this spec.

### (8) Scope and process

- `git diff --stat 370ec784c..HEAD` covers 45 files under `apps/standalone/{AGENTS.md, src, src-tauri/{migrations/0007, src/local_db.rs, tests/*}, test}` and the spec. Host, proto, `apps/station`, `packages`, manifests, lockfile and Cargo files are not touched (empty stat).
- 12 of 12 commits carry exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line and no other co-author.
- `git diff --check` is clean.
- `\u04` matches only `src/host/pairing-code.ts:66`.
- **Prettier gate, proved live:**
  - A mis-formatted probe file gave exit 1 with `[warn]`; the probe was deleted.
  - Then `pnpm --dir /tmp/claude/wt/flr exec prettier --ignore-path .prettierignore --check` over all 41 changed ts/tsx/json/css/md paths (repo-relative) printed "Checking formatting..." and "All matched files use Prettier code style!" (exit 0).
  - None of the paths is in `.prettierignore`. The 4 files not checked are SQL and Rust.

### (9) Merge readiness

- **`claude/integration`** is still `370ec784c`, the base, so the merge is a fast-forward.
- **`claude/infra-rk` (`529eb7427`):** `git merge-tree` against `claude/floor-2a7` is clean.
- **`claude/office-chz` (`dbaacb885`, cut from the older `91bfdbbba`):**
  - It conflicts with `claude/integration` already, before 2a7, in `AGENTS.md`, `src/host/api.ts`, `test/protocol.test.ts` and `test/support/office.tsx`.
  - 2a7 adds only an `AGENTS.md` adjacency: office-chz adds «## Shift exports» where this branch has «## Floor work» (2a6) then «## Floor printing» (2a7). The resolution keeps all three.
  - `ru.json`, `protocol.ts`, `shell.css` and `ipc.rs` auto-merge.
- **Shell migrations:** only this branch adds `0007`; ПЛ-Ц plans `0008_floor_pallets`. No other stream adds a local table, so `TABLE_CLASSES` has no competitor.

---

## (b) TRIAGE

| Item                                                                     | Source | Decision                       | Reason                                                                                                                                                                                                   |
| ------------------------------------------------------------------------ | ------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| productionDate/number from the copy (minors 1–2)                         | T3     | **DOC** (m1)                   | The host refuses date edits of an active shift (`office_shifts.rs:398-432`, test `:980-1026`), the number is fixed and the job stores its fields. Rewrite the «open» bullets.                            |
| closedAt "equivalent mutant" (minors 1)                                  | T3     | DROP                           | `effectiveProductionIsoDate` uses `closedAt` only without a production date, which a shift always has: equivalent by construction.                                                                       |
| ceiling and bytes only on fake canvases (minors 1)                       | T3     | CARRY (Windows manual list)    | Already in AGENTS «Verification».                                                                                                                                                                        |
| T4 addenda to T5/T6 (minors 3)                                           | T4     | DROP (done)                    | Each one verified: reason demanded, former printer named (`target.replaced`), snapshot revision (M4), queue-only decisions and recovery, rejection re-reads, N12 `empty` read-back, `printer_busy` text. |
| 20 s limit includes the queue (minors 3, T4 m5)                          | T4     | CARRY ПЛ-Ц                     | Documented in the runtime JSDoc and AGENTS.                                                                                                                                                              |
| stock label size (minors 3, T4 m6)                                       | T4     | **DOC** (m1/m2)                | Measured above.                                                                                                                                                                                          |
| `sendLabelJob` accepts `sent`/`unknown` with no reason (minors 3, T4 m2) | T4     | CARRY 2a8                      | Contract JSDoc; 2a8's reprint goes through a new job.                                                                                                                                                    |
| rebind loses the former printer (minors 4, T4 m3)                        | T5     | CARRY owner / 2b               | Accepted; documented.                                                                                                                                                                                    |
| `UnreadableJobError` blocks its shift (minors 5, T6 m3)                  | T6     | CARRY owner / 2b               | Accepted; proposal in JSDoc and AGENTS.                                                                                                                                                                  |
| skip text without «Исключения» (minors 6, T6 m4)                         | T6     | CARRY 2a8                      | Restore with a reachability test.                                                                                                                                                                        |
| decide → `settleLabel` for the next job (minors 7, T6 m5)                | T6     | CARRY ПЛ-Ц                     | Exact while one job per shift.                                                                                                                                                                           |
| stalled check button (minors 8, T6 m2)                                   | T6     | DROP (done)                    | Tested; my M13 is killed.                                                                                                                                                                                |
| one `verifyPrintedLabel` for all purposes (minors 9)                     | T8     | CARRY ПЛ-Ц                     | A model change.                                                                                                                                                                                          |
| shell snapshot states, baud 1..u32 (minors 9)                            | T8     | DROP                           | Mirrors the shell.                                                                                                                                                                                       |
| FloorApp reads the level once (minors 9)                                 | T8     | DROP                           | Theoretical; documented.                                                                                                                                                                                 |
| spooler queue on a COM port unknown (minors 9)                           | T8     | DROP                           | Documented.                                                                                                                                                                                              |
| volume buttons `aria-disabled` (minors 9)                                | T8     | DROP                           | Intended (focus kept).                                                                                                                                                                                   |
| T4 m1 recovery window                                                    | T4     | DROP (done)                    | Serialised through the queue (T6); JSDoc hard rule.                                                                                                                                                      |
| T4 m4 stuck call holds the address                                       | T4     | DROP (done)                    | `printer_busy` text says another printer or a restart.                                                                                                                                                   |
| T6 I1 double activation                                                  | T6     | DROP (done)                    | 400 ms guard plus focus; my M11/M12 are killed.                                                                                                                                                          |
| T6 m1 printer line on the failed view                                    | T6     | DROP (done)                    | Test `floor-work-print.test.tsx:964`.                                                                                                                                                                    |
| **I1 setup fields feed the wedge**                                       | final  | **FIX**                        | Proven by the probe.                                                                                                                                                                                     |
| m2 bytes and retention                                                   | final  | CARRY 2a8 / owner, DOC numbers | Unless the owner wants the CHECK relaxed now, before `0007` merges.                                                                                                                                      |
| m3 forget orphans a waiting job                                          | final  | DOC + CARRY 2b                 | Forget warning should count open jobs.                                                                                                                                                                   |
| m4 in-flight `sending` panel not re-rendered                             | final  | DOC                            | Rare (timeout plus a failed write).                                                                                                                                                                      |
| m5 two overclaiming texts                                                | final  | **FIX**                        | Text plus a test.                                                                                                                                                                                        |
| m6 mismatch echoes SSCC                                                  | final  | DROP                           | See above.                                                                                                                                                                                               |
| m7 hostname vs IP key                                                    | final  | DROP                           | See above.                                                                                                                                                                                               |

### Proposed fix wave (ONE fixer, separate commits)

1. **`test(standalone)`: the setup's fields through the real keyboard wedge, and the label panel's words for a failed job.**
   - A new test in `test/floor-setup.test.tsx`, built with `createKeyboardWedgeSource()`. Typing into the host or port field and then scanning the test code gives «Код совпал». An Enter typed in a field is not a scan.
   - A test in `test/floor-work-print.test.tsx`: a failed job whose printer was deleted gets no «возможно, лежит у прежнего».
   - Pending-view text assertions.
   - These fail before commit 2.
2. **`fix(standalone)`: the setup's text fields take input from the scan source; a test label clears what was typed before it; the panel promises nothing it cannot know.**
   - `WorkstationSetup.tsx`: `onFocus`/`onBlur` → `setManualTextEntryActive`, the unmount cleanup, and `clearPendingInput()` at the test send.
   - `ru.json`: `pending.body` and `target.replacedFailed`.
   - `LabelPanel.tsx` `targetText`: pick the variant by `mayExist`.
   - Mutants for each handler and the variant.
3. **`docs(standalone)`: the final review's answers.**
   - `apps/standalone/AGENTS.md` «Floor printing»:
     - the production date and number are stable (with the host rule cited);
     - the stock byte sizes and the m2 retention note;
     - m3 (forget) and m4 in the accepted list;
     - drop the «Open for the final review» bullet.
   - Spec §21: the same.
   - The plan's «Отклонения при исполнении» (the plan file lives on `claude/autonomous-desktop-station-9e6f13`, not in `/tmp/claude/wt/flr`; the controller writes it there, draft in (c)).

Gates for the wave:

- the focused files: `floor-setup`, `floor-work-print`, `floor-app`;
- the delayed-`setImmediate` stand on the two React files;
- typecheck and lint;
- the prettier gate run live;
- `git diff --check`;
- the `\u04` grep.

---

## (c) DEVIATIONS TO RECORD (draft for «Отклонения при исполнении», in Russian)

- **Задача 1.**
  - Однополевые ключи объявлены `NOT NULL PRIMARY KEY` (как в `0006`; в плане — `TEXT PRIMARY KEY`, что в SQLite принимает NULL).
  - `run_raw` в `tests/local_db.rs` оставлен (на настоящем дереве его использует тест неотправленного).
  - Пробная таблица `kept_workstation_settings` заменена настоящей вставкой в `workstation_settings`.
  - `ipc.rs` сверяет последнюю из одноразовых таблиц, а не последнюю в списке.
  - `floor-schema.test.ts` получил колонки и индексы `floor_print_jobs` (на настоящем дереве есть проверки формы, которых не было на копии).
- **Задача 4.**
  - К тестам плана добавлено 20 своих.
  - Волна исправлений добавила подсчёт отправок оболочки после каждого исхода и проверку, что очередь держит адрес до настоящего конца зависшего вызова (мутанты повторной отправки после `outcome_unknown` и освобождения адреса по пределу выживали).
- **Задача 5.** Прежний принтер при перепечатке на другой не называется: в `floor_exceptions` и в `box_exception` нет поля принтера. Принято для пилота, вопрос владельцу / плану 2b.
- **Задача 6.**
  - Восстановление прерванных вынесено из `settleLabel` в работу входа (один раз, до любой отправки) и в кнопку оператора «Проверить, вышла ли этикетка» (для `sending` без отправки этого приложения).
  - При `empty` закрытый короб перечитывается (`readClosedBox`), а его этикетка решается.
  - Отказ чтения или записи этикетки — своя остановка `system_error`/`label`, её снятие перечитывает задание.
  - Панель называет принтер перед перепечаткой, а текст `printer_busy` советует другой принтер или перезапуск.
  - Волна исправлений:
    - нажатия игнорируются 400 мс после смены вида (`VIEW_GUARD_MS`, часы `labelClock`);
    - фокус после смены вида — на «Назад» или на саму панель;
    - нейтральный текст `interrupted`;
    - текст пропуска без ссылки на «Исключения» плана 2a8.
  - Рабочий экран получил свойство `labelClock`.
- **Задача 7.**
  - Уровень звука хранится в `FloorApp` (ref, читается при открытии и из `onSaved`), вместо свойства `playTone` плана.
  - Возврат из настройки перечитывает смену (`readStoredWork`) и входит через `entered`, который не пускает в закрытую.
  - Исправлены дефекты кода плана (двойное сохранение, устаревший объект смены).
- **Задача 8.** Исправлено 10 дефектов кода плана:
  - набор, который оболочка отвергла бы целиком, не сохраняется;
  - сканер и последовательный принтер на одном COM-порту запрещены;
  - после отказа оболочки «Сохранить» снова отдаёт набор;
  - честный текст связи сканера («Проверяем связь…»);
  - напечатанный, но не добавленный порт не теряется молча;
  - устаревшие ответы отбрасываются;
  - кнопки громкости `aria-disabled`.
  - `verifyPrintedLabel` — одна настройка для всех назначений.
- **Задача 9.**
  - Раздел спецификации — §21 (§15–§20 заняты).
  - Пункт «Verification» стоит после пункта 2a6.
  - Обоснование `~HS` смягчено (не проверялось).
- **Счёт тестов на настоящем дереве:** 110 файлов, 3287 тестов после задачи 8 (на копии плана — 106/2530).
- **Итоговое ревью:**
  - вопрос «дата производства из копии смены» закрыт без кода: хост не даёт править дату, вместимость, шаблон, линию и контрагента активной смены (`update_shift`, тест `an_active_shift_takes_only_its_plan_and_a_closed_one_nothing`), номер смены не меняется, а задание хранит поля этикетки;
  - размер байтов стандартных этикеток измерен (оценка сверху: 58×40 — 21–45 КБ base64 в ZPL, 11–23 КБ в TSPL; 100×150 при 300 dpi — до 129 КБ);
  - поля ввода настройки сообщают источнику сканов о ручном вводе (I1);
  - [плюс то, что сделает волна исправлений].

---

## (d) What could not be verified

- Windows, WebView2 (canvas, audio, touch double tap), real printers, COM, the spooler, `powercfg`, and a screen reader.
- The byte sizes are a synthetic upper bound from a fake rasterizer, not IBM Plex on a WebView2 canvas.
- **Not re-run:**
  - the full Vitest suite and the delayed-`setImmediate` stand (the ledger's numbers; per the rules);
  - cargo `local_db`/`ipc` (the only Rust change is two `TABLE_CLASSES` lines and tests; Task 1 reported lib 134, local_db 27, ipc 26).
- I did not build a merged tree of office-chz plus integration plus floor (only pairwise `merge-tree`).
- Per-task claims for Tasks 1, 2, 3, 5, 7, 8 and 9 (no separate review): spot-checked through my mutants and the ledger arithmetic, not mutant by mutant.

---

## (e) What plans 2a8 and ПЛ-Ц must know

1. **Recovery is not in `settleLabel`.**
   - It runs once in the entry job and by the stalled check (`recoverStalled` via `decide`).
   - ПЛ-Ц fragment 8 (`await recoverInterruptedJobs(printContext)` inside `settleLabel`) must not be applied. Re-adding it reopens Task 4's m1 window and kills the Task 6 test «recovers the sends a stop of the station cut once, on entering, and never beside a send».
2. **Names in the executed `WorkScreen`:**
   - `live.current.local`, `pairingOf(live.current)`, `printContextOf(live)`, `now.shift`, not `local`/`where`/`printContext`/`shift`.
   - `Stop.close_failed` has `cause: "serial" | "write"`.
   - `system_error` has `cause: "label"`.
   - The `sending` line is `<p className="work-screen__waiting">`.
   - The panel props include `onRecover?` and `clock?`.
   - Every panel `Alert` has `role="presentation"`.
   - `press()`/`show()` carry the 400 ms guard: a new button in the panel must go through `press`, and a new view through `show`.
   - Anchor counts from the script: 2a8 has 15 of 22 `WorkScreen.tsx` fragments that no longer match, ПЛ-Ц 40 of 43. Apply them by meaning.
3. **`OPEN` in `print-jobs.ts`** is still private and named `OPEN`. 2a8 Task 3 exports it as `OPEN_JOB_SQL`, and ПЛ-Ц's `readOpenJob` fragment expects that name.
4. **2a8:**
   - The skip text must regain the «Исключения» reference, with a reachability test, and the test «promises nothing…» must change.
   - `reprintBox` must run its `sendLabelJob` inside the work queue (it does, through `exception`).
   - The spec section is §22, not §20 (§20 is 2a5 here, §21 is 2a7).
   - Retention deletes `floor_print_jobs` (bytes: m2).
   - Decide what happens to an open job of a shift the office closed while the station is away (the screen is never entered again: the label waits forever).
5. **ПЛ-Ц:**
   - After a decision, call `settleLabel()` instead of `showLabel(job)`, and add the two-open-jobs test.
   - Add the `pallet` branches in `labelRecord`/`reprintStatements`.
   - `readOpenJob` should order `created_at, purpose, id`.
   - The 20 s limit includes the queue wait.
   - `verifyPrintedLabel` is one boolean.
   - The local migration is `0008`.
   - Update the `LabelPanel` fragments for the fix round's shape.

---

## (f) Merge checklist (into `claude/integration`)

1. Fix wave committed (3 commits as above). Then focused Vitest, the delayed stand on the two React files, typecheck, lint, the live prettier gate, `git diff --check`, the `\u04` grep, and one trailer per commit.
2. `git -C … merge-base --is-ancestor claude/integration claude/floor-2a7`: true today (fast-forward). If the office or infra streams land first, re-run `merge-tree`:
   - infra: expected clean;
   - office: resolve `AGENTS.md` by keeping «Shift exports», «Floor work» and «Floor printing».
3. After the merge:
   - `pnpm --filter @markiro/standalone` typecheck, lint and build;
   - focused print suites;
   - cargo `--test local_db` (classes) and `--test ipc` (unsandboxed loopback);
   - the full Vitest only if the machine allows (record old-suite timeouts as such).
4. Plan file: add «Отклонения при исполнении» (draft (c)) on the plans branch.
5. Ledger: record the owner items:
   - m2 (CHECK decision before `0007` ships);
   - rebind printer;
   - `UnreadableJobError` bypass;
   - forget warning (m3);
   - `~HS`;
   - the reason on skip.
6. Worktree `git status --short` empty. No push or PR (not authorised).
