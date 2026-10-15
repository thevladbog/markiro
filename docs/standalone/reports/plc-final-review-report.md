# ПЛ-Ц FINAL whole-part review: pallets on the floor

Branch `claude/floor-2a7`, worktree `/tmp/claude/wt/flr`. HEAD `7009153c7`, base `33231f9eb` (end of 2a8). 13 commits (Tasks 1–10 plus fixes `d7a91fb56`, `789986485`, `22d65cb09`), 50 files, +9 664 / −505. The tree was clean before and after the review (`git status --short` empty).

## Verdict

**WITH FIXES (one small wave).** Critical 0, Important 0, Minor 12. Of the 12, 8 are FIX, 2 are CARRY and 2 are DROP.

The part holds together as one piece:

- **Pallet integrity.** A box is on at most one pallet:
  - `floor_boxes.pallet_id` is a single column.
  - `BOX_ONTO_PALLET_SQL` requires `pallet_id IS NULL AND closed_at IS NOT NULL`.
  - The `0008` CHECK allows a pallet only on a closed box.
  - Box, join and fill-close commit in ONE transaction, or none of them does.
- **Closed pallets.** The pallet's close compares `closed_at IS NULL` and the live box count. Its label job is written only inside that transaction, so each close makes exactly one job. `readOpenJob` orders box before pallet. `settleLabel` sends only `prepared` jobs, so nothing is sent again by itself.
- **Pallet SSCC.** Serials are compare-and-set on an extension-1 block. `freePalletSscc` loses a serial that is out of range or already held, as the box close does. `settlePallet` makes at most 3 tries and never stops the line.
- **The shift's close.** `openPalletGuard` is in `finishClose` on every path. The in-memory `pendingClose` is now tied to the pallet label's job id. I re-verified `22d65cb09` adversarially: crash, restart, re-shown label, another label, stale or unresolvable check, system error, leave and changed numbers. I found no way for a stale intention to close the shift. A crash drops the intention, as ВЦ3 says.
- **Retention.** `RETAINED_TABLES` has both pallet tables. `DUE_SHIFTS_SQL` is byte-identical to 2a8, and its open-job guard covers pallet jobs. SSCC blocks stay.
- **Migration `0008`** is additive. It is tested over a `0007` database on both SQLite engines.
- **The new-shift form** (Task 8, never reviewed before) mirrors `host/src/shifts.rs`: capacity 1..10 000 and a pallet template that is enabled, of purpose `pallet` and covers the group. It never sends a pallets form as a plain shift. `isShiftOfRequest` refuses a shift that came back with other pallets.
- **The host replay** (Task 9, never reviewed before) is real.
  - Fixture hash: mapping the six exception ids back reproduces the plan's hash `7057d806…` exactly.
  - The T4 survivor is by design.
  - My two host mutants: one is killed by the scenario. The other survives the scenario but is killed by the host's own `pallet_facts` suite.
- **Docs** (Task 10) say what the code does, with five exceptions:
  - the stale table-count sentence;
  - two known-limit bullets that the planned fixes will make obsolete;
  - two wording nits.

What remains is the queued final-wave list from Tasks 4–7 plus the untouched per-task Minors:

- two unpinned guards (the exact-SSCC scan and R11), plus `closePallet`'s own open-job check, which my P5 shows is unpinned but which no screen flow can reach;
- the missing `disassemblePallet` backstop;
- floor words that still say «короб» or are wrong in four pallet states;
- stale comments and docs.

None of them loses or corrupts data, or lets an irreversible action run on a guess. They all fit one fixer in four commits.

---

## (a) Findings, most severe first

### Critical: none. Important: none.

### Minor

**m1. The exact-SSCC match of the exceptions' scan is unpinned, and the test named for it checks something else (FIX, test; Task 7 M1)**

- **Where:** `src/floor/exceptions/ExceptionFlow.tsx:344` (`candidate.sscc === sscc`) and `test/floor-work-pallet-exceptions.test.tsx:238`.
- **Evidence:** my V3 replaces it with `candidate.sscc.endsWith(sscc.slice(-4))`. At HEAD it still survives all six UI files (289/289).
- **The test:** «finds the pallet by its whole SSCC only: a scan that merely ends alike is not found» calls only `boxesByTail`, never a scan. Its title claims what it does not check.
- **Why it matters:** this line is the "never on a guess" guard in front of an irreversible disassembly, and the box and pallet choices share it. It is correct by reading.
- **Fix:**
  - In a flow-level test, scan a valid SSCC that shares the last ≥4 digits of `FIRST_PALLET`, for example the box SSCC with the same serial tail. Expect «НЕ НАЙДЕНО…» and nothing chosen.
  - Retitle the unit test to what it checks (`boxesByTail` matches the end, not a substring).

**m2. R11 of Task 4 still survives (FIX, test; Task 4 m4, Task 7 M4a)**

- **Where:** `print-resolution.ts:95-104`, the pallet branch of `printAgain`'s `reprintStatements` (label panel «Напечатать снова» with a reason).
- **Evidence:** hard-coding `reasonCode: "printer_jam"` survives 9 files and 338 tests at HEAD. Task 7's claim that "R11 can not survive here" is false: Task 7 mutated `reprintPallet`, not this branch.
- **Fix:** one test that prints a pallet label (`unknown`, or `sent` awaiting its check) again with `damaged_label`. Assert the `floor_pallet_exceptions` row and the `pallet_exception` record carry `damaged_label`.

**m3. `disassemblePallet` has no backstop against an open pallet label job (FIX, code + test + docs; Task 4 m2, Task 7 M3, addenda T4)**

- **Where:** `src/floor/exceptions/pallet-exceptions.ts:185-210`.
- **Why the screen is safe today:** `disassembleThePallet` calls `labelWaits()` in the queue turn, and every job writer is queued. Task 7's reviewer verified that, and I re-checked the writers.
- **The module alone accepts a disassembly while the pallet's own label waits.** Two things follow:
  - «Напечатать снова» on that label goes stale for good, because `palletLiveGuard` never holds again.
  - A `failed` job can still be printed for a pallet already taken apart: `printAgain` without a reason has no live guard.
- **Stale text:** the module header (`:43-45`, «nothing at all is recorded of a pallet after it was taken apart») over-claims: a waiting label's `pallet_label` could still be recorded.
- **Fix:**
  - Add a statement to the disassembly transaction that counts a row only while no open `floor_print_jobs` row exists for `purpose = 'pallet' AND subject_id = ?`. Use a no-op `UPDATE floor_pallets … AND NOT EXISTS (… OPEN_JOB_SQL …)` with `expectedChanges: 1`, mapped to `LabelWaitingError`, or `stale` after a re-read.
  - Pin its plan in BOTH `test/floor-schema.test.ts` and `src-tauri/tests/local_db.rs`, plus the text-agreement list.
  - Test it with `holdingWrites`: open a pallet job between the read and the write. Expect nothing written.
  - Then reword the docs:
    - `AGENTS.md` «Floor pallets», Exceptions bullet: drop «That refusal is the screen's: `disassemblePallet` has no such guard of its own (see the known limits)». Say instead that the screen refuses it and `disassemblePallet`'s transaction refuses it too.
    - `AGENTS.md` «Known limits of the pallets»: remove the `disassemblePallet` bullet.
    - Spec §19 «Известные ограничения»: remove «Расформирование паллеты под ожидающей этикеткой отказывает экран, а не сама функция `disassemblePallet`; запрет в её транзакции остался пунктом итогового ревью.». Add to «Исключения паллеты»: «…и функция расформирования сама отказывает, пока ждёт задание этикетки паллеты».
    - The module header: «no `pallet_exception` follows a disassembly, and a pallet is not taken apart while its label waits».

**m4. The pallet choice still says «короб» (FIX, words; Task 7 M2)**

- **Where:** `ru.json:432-433` (`floor.exceptions.signal.taken` «КОРОБ ВЫБРАН», `notFound` «НЕТ ТАКОГО КОРОБА») and `:461` (`result.failed` «…проверьте числа короба…»), used at `WorkScreen.tsx:1316-1318`.
- **Impact:** a pallet scan in pallet mode flashes «КОРОБ ВЫБРАН». A box label scanned in pallet mode flashes «НЕТ ТАКОГО КОРОБА» although the box exists. No destructive step follows: the next view and the error-tone confirmation are the pallet's.
- **Fix:** subject-neutral words, for example «ВЫБРАНО», «НЕ НАЙДЕНО СРЕДИ ЗАКРЫТЫХ» and «…проверьте исключения и числа смены…». Update the box tests that assert the old words. Then remove the `AGENTS.md` known-limit bullet «The scan feedback of the pallet choice … still says «короб»».

**m5. Floor words that are wrong in four pallet states (FIX, `ru.json`; Task 5 m4, Task 6 m2, m3)**

- `floor.work.palletFailed.body` («…вне диапазона префикса и пропущен») is shown for every `pallet_failed`. That stop also comes from:
  - a held SSCC since `d7a91fb56`;
  - a `stale` after the retries, where nothing was lost.

  Fix: «Номер SSCC паллеты не подошёл (вне диапазона префикса или уже занят другой паллетой) и пропущен, или паллета изменилась. Повторите закрытие.»

- `floor.work.palletWaits.body` promises «придут от хоста» even when the top-up answered `exhausted`. Add «…если номера префикса закончились — обратитесь к администратору».
- After «Закрыть паллету и смену» stops on the pallet (`pallet_no_serials` or `pallet_failed`), nothing says the shift is NOT closed (ВЦ3 drops the intention).
  - Fix: one line under those stops when they came from the shift's close, for example «Смена не закрыта: когда паллета закроется, нажмите «Закрыть смену» ещё раз.».
  - This needs a flag on the stop, for example `fromClose: true` set in `confirmPalletClose`.
- `floor.close.blocked.open_pallet` «На открытой паллете {{quantity}} коробов.» is ungrammatical (fallback view only). Use «Коробов на открытой паллете: {{quantity}}. Сначала закройте её.»

**m6. `closePallet`'s own open-job check is unpinned (FIX, test; new)**

- **Where:** `WorkScreen.tsx:1602-1605`.
- **Evidence:** my P5 (`… !== null && false`) survives all 5 pallet UI files (235/235).
- **Today it is defence in depth:** every caller reaches `closePallet` only with no label waiting.
  - The early-close button is off under any stop.
  - The summary names `label` before `open_pallet`, and `sameSummary` re-reads it in the turn.
  - The link-back effect calls it only under `pallet_no_serials`.
- **But it is the line that keeps `pendingClose`'s job id the pallet's own:** after `closePallet`, the label stop must be the pallet's new job.
- **No screen flow can reach the guard.** A job that opens between the summary and «Закрыть паллету и смену» shows up in `CLOSE_SUMMARY_SQL`'s `waiting` count. The blocker then turns to `label`, which comes before `open_pallet`, and `sameSummary` shows the summary as «stale» before `closePallet` runs.
- **Fix (comment, no test):** above the check, say that it is unreachable from the screen today, that every caller arrives with no label waiting, and that it keeps `pendingClose`'s job id the pallet's own. A future caller that skips the summary must keep it.

**m7. Three cheap coverage gaps (FIX, tests; Task 7 M5, M4b, Task 5 m6)**

- **Press guard on the pallet action buttons is unpinned** (V11 of Task 7, harmless: it only opens a choice view). One double-tap test.
- **The poke at `test/floor-work-close-pallets.test.tsx:265`** sets `disassembled_at` and deletes codes by hand. Task 7's reason for keeping it ("no screen flow deletes the codes") is false: `disassembleBox` does both in one transaction (`box-exceptions.ts:340-343`). Use the real flow and expect `["box_closed", "box_exception", "shift_closed"]`.
- **Restart sequencing:** leave a box job `sending` (it becomes `unknown` on entry) and a pallet job `prepared` from the same fill-close. Assert the pallet label is not sent before the box's decision, and is sent right after it. Correct by reading (`readOpenJob` orders by purpose, and `recoverInterruptedJobs` touches only `sending`), but untested.

**m8. Stale documents, comments and titles (FIX, docs and comments; Task 2 m2, m3, Task 3 m6, Task 4 m3, m5, Task 5 m5, Task 6 m4, new)**

- `apps/standalone/AGENTS.md:192-194` still says «Of the 21 tables 11 are `Disposable`, the 8 of migration `0006` and `floor_print_jobs` of `0007` are `DeviceData`», and the DeviceData list omits pallets.
  - There are now 23 tables, 11 of them `DeviceData` (8 + 1 + 2). I counted them in `TABLE_CLASSES`.
  - Task 2's review carried this to Task 10, and Task 10 missed it.
  - Fix: «Of the 23 tables 11 are `Disposable`, the 8 of `0006`, `floor_print_jobs` of `0007` and the two pallet tables of `0008` are `DeviceData`…», and add «pallets» to the parenthesis.
- `src/local/retention.ts:85-93`: the `purgeAcknowledged` JSDoc lists «scans, exceptions, codes, print jobs, boxes and outbox records» but not the pallets and pallet exceptions it now deletes.
- `WorkScreen.tsx:1667-1670` (`confirmClose` JSDoc): «The pallet work of plan ПЛ-Ц, which queues before the close, must pin the order with a held job that is not a scan». ПЛ-Ц runs the pallet's close and the shift's close in ONE queue turn (`confirmPalletClose`). My P17 (that turn moved out of the queue) is killed by «takes no scan queued behind the close: it meets the closed shift». Reword it as done and name that test.
- `LabelWaitingError` (`box-exceptions.ts:357-362`) says «the label of box …» when `reprintPallet` throws it with a pallet id. Make it «the label of {subject} … still waits». The screen maps by class, so this is only a log message.
- No cross-reference comment links `reprintPallet` (`pallet-exceptions.ts:252`) and `reprintBox` (`box-exceptions.ts:453`). Their guard texts must stay twins.
- `WorkScreen.tsx:1731`: `if (closed === "stopped") return;` is equivalent today (Task 6 m4). Add a comment that it is the explicit stop, so nobody deletes it on a green suite.
- Test titles that over-claim:
  - `test/floor-pallets.test.ts:228` «writes nothing when a box joins between its read and its write»: the body takes a box apart.
  - `floor-work-pallets.test.tsx` «…and for no pallet serials in a shift without pallets»: the next test checks that.
- `AGENTS.md` «Known limits of the pallets», ВЦ3 bullet: «After a pallet stop of the early close the shift stays open» should read «After a pallet stop of «Закрыть паллету и смену» the shift stays open».
- Spec §19, «Сборка»: «Сообщение выводится из состояния…, а не хранится». The kind (`no_serials` or `invalid`) is stored; only showing it is derived. Write «показывается, только пока…».
- `pallets.ts:137`: one over-long doc line in `PalletCloseResult`. Prettier does not rewrap comments; cosmetic.

**m9. The `0007 → 0008` upgrade tests seed only a box-only copy (DROP; Task 2 m1)**

- `tests/local_db.rs` and `floor-pallet-schema.test.ts` seed `pallets_enabled = 0`.
- **Reason to drop:**
  - No `0007` station exists in the field: the standalone has not shipped, and the branch is not pushed.
  - The migration adds no CHECK that could fail on `pallets_enabled = 1`.
  - Task 2's probe r7 (such a CHECK) is killed by older tests anyway.

**m10. The shared scenario does not pin the host's pallet-block use (DROP; new)**

- My HM2 drops `blocks::consume` from `host/src/facts/pallet_closed.rs`. It survives `--test floor_scenario` (5/5) but is killed by the host's own `--test pallet_facts` (6 tests, ПЛ-Х).
- The scenario's job is the station's records end to end, and `consumed_through` is a host invariant pinned where it belongs.

**m11. The in-queue host wait for pallet serials (CARRY to ОЧ or the owner; Task 5 m1)**

- `settlePallet` awaits `palletSupply.topUp()` inside the work queue on every box close while a full pallet waits and the link says online. That is up to 2 × 10 s with a hung host.
- It is stated honestly in `AGENTS.md` and spec §19 as a known limit, which is the DOC half.
- The preferred fix is to queue a `settlePallet` turn from `afterClosed`'s background top-up when it answers `stored`, as the link-back effect already does. That is a behaviour change for the owner or ОЧ, not this wave.

**m12. The early close loses one bad serial per «Повторить» (CARRY to the owner; Task 6 m5)**

- `closePallet` maps `invalid_serial` to `pallet_failed` without the `PALLET_SERIAL_TRIES` loop of `closeFullPallet`.
- After a former pairing's run of held SSCCs, «Закрыть паллету досрочно» can take several presses.
- Plan-accepted (ВЦ2). Change it only if the owner wants the early close to self-heal.

---

## Seams checked (what I did)

### (1) Pallet integrity end to end

- **`palletStep`** (`pallets.ts:378-430`) is a `CloseStep` inside `closeOpenBox`'s single transaction:
  - INSERT or JOIN (`closed_at IS NULL`, expected 1);
  - `BOX_ONTO_PALLET` (expected 1);
  - on fill: spend (compare-and-set) → `CLOSE_PALLET` (open and live count `=` read count) → `pallet_closed` → job.
- **The lost-answer path** (`settleUnsure` → `readClosedBox`) never reruns the steps.
- **A rival open pallet** gives a unique-index `statement_failed` → `close_failed` («Повторить»), with nothing written. It is unreachable because the queue serialises closes.
- **The host** has no capacity check on `pallet_closed` (`pallet_closed.rs`), so ВЦ6 «2 из 1» closes with `boxCount` > capacity and is accepted.
- **Box disassembly:**
  - From an open pallet, it lowers the live count, and the close's count comparison catches it.
  - From a closed pallet, it leaves the pallet closed with its reported `boxCount`.
- **A reprint is "unchanged"**, built from the last job's fields. That matches the cloud: `apps/station/src/lib/pallets.ts:399` «Queues an unchanged label reprint».

### (2) `d7a91fb56` (no independent re-review before): held pallet SSCC

- `freePalletSscc` returns `null` for `SSCC_RANGE` or a held SSCC (`PALLET_SSCC_HELD_SQL` on `floor_pallets_sscc`, across pairings, which is right after a forget).
- `closeOpenPallet` spends that serial alone (compare-and-set) → `invalid_serial`.
- `palletStep` leaves the full pallet open and the serial unspent, and the box still closes. The next `settlePallet` loses the serial (up to 3 tries per call).
- Box SSCCs start with `0`, so no box can hold a pallet's SSCC.
- Both plan lists pin the read.
- My P9 (pallet serial pick `ORDER BY from_serial DESC`) is killed. Task 3's F1–F9 cover the rest.

### (3) `789986485` (no re-review): the derived waits message

- `palletWaitsNow` is shown only while the open pallet `refresh` read holds ≥ capacity.
- My P2 (`>=` → `>`) is killed by 6 tests and P10 (`invalid` → `null`) by 1, together with the implementer's W0, W2 and W3.

### (4) `22d65cb09`: the intention to close, adversarially

- **Set:** only in `confirmPalletClose`, after `closePallet` left a label stop. That stop can only be the pallet's new job, because `closePallet` refused when any job was open; see m6 for whether that refusal is pinned.
- **Kept:** across `setStop(null)` (the decision) and a re-show of the same job id. «Напечатать снова» and «Другой принтер» keep the job id (`printAgain` → `sendLabelJob` on the same row).
- **Dropped:**
  - by any other stop: system error, another label, close, exceptions;
  - by the stale or unresolvable branches of `check` and `decide`;
  - by a leave (`afterLabel` checks `leavingNow`);
  - by unmount.
- **Crash or restart:** memory only, so it is gone. The pallet label panel returns on entry, and «Закрыть смену» then shows a summary without the pallet (ВЦ3).
- **Lost answer:** the after-label path re-reads with `sameSummary({ ...shown, blocker: null }, fresh)`. The open pallet is compared only through the blocker, so a closed pallet compares equal. Changed numbers give the «stale» summary. A failed re-read goes to `closeFailed(shown)`. If it shows the old pallet question, pressing it re-reads and goes stale, so it is safe.
- **`settleSafely` throwing after the pallet's close:** a system-error stop drops the intention. `finishClose` still runs, but `closeShift`'s `OPEN_JOB_SQL` refuses while the pallet job is open, and `showSummary` ignores a non-`close` stop. Nothing closes on a label that waits.
- **Mutants:** my P6 (intention never set) is killed by 32 tests and P11 (no label settle after the early close) by 35. Task 6's K0–K5 and R13 stand.

### (5) Queue and tracking duty (N9/N13), offline and idempotency

- **Every pallet write runs in a `queue.run` turn handed to `track`:**
  - `palletStep` in `closeBox`;
  - `closePallet` from `closePalletNow`, `confirmPalletClose` and the link-back effect;
  - `settlePallet` from `closeBox`, `afterLabel`, entry and link-back;
  - `reprintThePallet` and `disassembleThePallet` through `exception()`;
  - `printAgain`, check and skip through `decide`/`scan`.
- Pallet top-ups are tracked background work, like box top-ups.
- **Mutants:**
  - P17 (the pallet-and-shift close outside the queue) is killed.
  - P3 (no `settlePalletSafely` after a box) is killed by 7 tests, P12 (`afterLabel` without it) by 3 and P13 (`settlePallet` without its label settle) by 5.
  - P14 (link-back early close without clearing the stop) is killed.
  - P4 (no pallet top-up after a close) is killed.
  - P1 (`PALLET_SERIAL_TRIES` = 1) is killed by 2 tests.
  - P7 (no `pallets_missing` early return on entry) is killed.
  - P8 (label panel reprint from the box layout for a pallet) is killed by 2 tests.
- **Offline:** `palletStep` needs no host. Pallet blocks follow the half rule with their own waiting request (extension 1). A restart repeats the same `requestId`.

### (6) Retention and migration

- `RETAINED_TABLES` has both pallet tables, and `DUE_SHIFTS_SQL`, `DONE_WITH` and `PURGE_COPY_SQL` are unchanged.
- An empty open pallet never blocks a purge; it goes with the shift.
- `0008` is additive and runs in one sqlx transaction.
- My P16 (`floor_pallets_open` as a full index on `closed_at`) is killed by 6 tests across three files.
- `TABLE_CLASSES` has 23 entries, 11 of them `DeviceData`.

### (7) Plan pins in BOTH engines

- All 14 pallet SQL constants have a plan pin in `test/floor-schema.test.ts` and a twin in `src-tauri/tests/local_db.rs`, with the text-agreement test between them:
  - `OPEN_PALLET`, `CLOSE_PALLET`, `JOIN_PALLET`, `BOX_ONTO_PALLET`, `OPEN_PALLET_GUARD`, `CLOSE_SUMMARY`, `OPEN_JOB_READ`;
  - `PALLET_SSCC_HELD`, `CLOSED_PALLETS`, `PALLET_STATE`, `DISASSEMBLE_PALLET`, `PALLET_LIVE_GUARD`, `LAST_PALLET_JOB`, `NEWEST_PALLET_JOB_GUARD`.
- The pallet serial pick is textually the box close's statement (`box-close.ts:201`), which is already pinned.
- `floor_pallet_exceptions` is scanned on purpose and pinned as a scan in both lists.

### (8) Task 8: the new-shift form vs the host (first review)

- **Host rules:**
  - `pallet_request`: capacity 1..`MAX_PALLET_BOX_CAPACITY` (10 000) or none; a template is required with pallets; neither field without pallets.
  - `pallets`: `check_pallet_template` = enabled, purpose `pallet`, covers the group.
- **The station mirrors them:** `palletCapacityOffered` (1..10 000 and a fitting template, via `templateFitsSlot`, which the 2a3 office already mirrors).
- **`palletsOf`** looks the template up among the fitting ones and recomputes the capacity, so an unavailable form is never sent.
- **`deviceShiftCreate`** sends the three fields only with pallets. That matches proto `DeviceShiftCreate` (`pallets_enabled` defaults to false; the two `Option` fields are skipped when none) and `device-shift-create-pallets.json`.
- **`isShiftOfRequest`** compares `palletsEnabled`, capacity and template. Without pallets, the fields are absent on both sides: proto uses `skip_serializing_if`, and Zod has `.optional()`, not `.nullable()`.
- **Template choice:** `suggestPalletTemplate` goes product → category default of purpose `pallet` → organization. It is pure and exported for О-Ф.
- **UI:** every button is `size="floor"` (scripted check over all five changed TSX files), with `aria-pressed` on both switch buttons and role groups. Its own mutant table (M1–M26) is honest: M4d, M11c and M25 are equivalent, as stated.
- **One guard-order note, DROP:** `submit` checks `palletsOf` before the `form.created` entry path. It is unreachable, because the choices are read once per form (`NewShift.tsx:170-184`).

### (9) Task 9: the scenario and the host replay (first review)

- **Fixture:** `floor-scenario.json` sha256 is `70464d38…2f32`. Mapping ids `…13→…12`, `…16→…15`, `…27→…26`, `…30→…29`, `…34→…33` and `…47→…46` gives exactly the plan's `7057d80658da2f2c7e865098509c593e3275ff472a30874c845515b0dc4ead08`. None of the old ids occurs in the generated file, so the mapping is injective. The cause is the same as at 2a8 Task 8: the executed exception modules take one id before the record's.
- **Host baseline:** `--test floor_scenario` passes 5/5.
- **My host mutants:**
  - HM1 (`pallet_label` Verified writes `print_skipped_at`) is killed by the main replay test (`pallet_state` dump).
  - HM2 (no `blocks::consume` in `pallet_closed`) survives the scenario and is killed by `--test pallet_facts` (6 tests); see m10.
- **T4** (`closeShift` without `openPalletGuard` in the scenario) survives by design: the second pallet is closed and taken apart before the close. Task 6's guard tests pin it.

### (10) Task 10: the docs vs the code

- «Floor pallets» and spec §19 match the code on these points:
  - the join/fill transaction;
  - lost serials and the 3 tries;
  - the derived message;
  - the early-close button guards;
  - label order;
  - the exceptions: scan of the whole SSCC or the digits, reason then confirmation, queue, the two comparisons, the subclass;
  - `finishClose` with `openPalletGuard`;
  - `pendingClose` tied to the job id;
  - the new-shift limits;
  - the scenario and its hash;
  - retention.
- The known limits are honest. Five fixes are listed in m3, m4 and m8: the table count, two bullets that will become obsolete, and two wording nits.

### (11) Hygiene

- Every one of the 13 commits has exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line.
- `git diff --check 33231f9eb 7009153c7` is clean.
- `grep -rnF '\u04'` finds only `pairing-code.ts:66`.
- These are untouched: `apps/station`, `packages/*`, `host/src`, `proto/src`, `package.json`, `pnpm-lock.yaml`, `Cargo.toml` and `Cargo.lock`.
- There is no `console.*` in the pallet modules.

---

## (b) TRIAGE

| #   | Item (source)                                                                                                     | Decision                       | Reason                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------ |
| A1  | T3 addenda: `shiftPallets` null → STOP                                                                            | DROP (done)                    | `pallets_missing` stop from the first render; P7 killed                        |
| A2  | T3: rival open pallet → raw `statement_failed`                                                                    | DROP (done)                    | mapped to `close_failed` «Повторить», tested; unreachable under the queue      |
| A3  | T3: out-of-range serial in `palletStep` leaves the pallet open, no stop                                           | DROP (done)                    | `settlePallet` treats `invalid_serial` as retry (3); P1 killed                 |
| A4  | T3 review: `ShiftClosePanel` `open_pallet` said as «closed»                                                       | DROP (done)                    | exhaustive `switch` with `never` (Task 6 R10)                                  |
| A5  | T3 review: `openPalletGuard` on every close path                                                                  | DROP (done)                    | `finishClose` passes it unconditionally (Task 6 R1)                            |
| A6  | T3 review m6: test title «…a box joins…» with a disassembly body                                                  | FIX (m8)                       | rename                                                                         |
| A7  | T4 report: confirmation and reason before disassembly; queue and tracking; class mapping; template subclass first | DROP (done)                    | Task 7 V7, V6, V2 killed                                                       |
| A8  | T4 review m1: module header over-claims                                                                           | FIX (m3)                       | reword with the backstop                                                       |
| A9  | T4 review m2 / addenda: disassembly while the pallet's label waits                                                | FIX (m3)                       | screen refuses (done); add the transaction backstop                            |
| A10 | T4 review m3: `LabelWaitingError` says «box»                                                                      | FIX (m8)                       | message only                                                                   |
| A11 | T4 review m4: R11                                                                                                 | FIX (m2)                       | still survives at HEAD                                                         |
| A12 | T4 review m5: reprint cross-reference comment                                                                     | FIX (m8)                       | one line each                                                                  |
| A13 | T4 review m6: reprint in a closed shift answers stale; disassembly box count read before its transaction          | DROP                           | not offered in a closed shift; the count is cosmetic and right under the queue |
| A14 | T5 review m1: in-queue pallet host wait                                                                           | CARRY (m11) to ОЧ or the owner | DOC done                                                                       |
| A15 | T5 review m2, m3 (A, B, C, H)                                                                                     | DROP (done)                    | killed by `789986485` tests                                                    |
| A16 | T5 review m4: `palletFailed` / `palletWaits` words                                                                | FIX (m5)                       | operator-facing                                                                |
| A17 | T5 review m5: over-claiming test title                                                                            | FIX (m8)                       | rename                                                                         |
| A18 | T5 review m6: restart sequencing test                                                                             | FIX (m7)                       | cheap, test only                                                               |
| A19 | T5 review m7/m8 → Tasks 6 and 7                                                                                   | DROP (done)                    | Task 6 R1; Task 7 mapping                                                      |
| A20 | T6 review I1 (stale intention)                                                                                    | DROP (done)                    | `22d65cb09`, re-verified (seam 4)                                              |
| A21 | T6 review m1 (R13)                                                                                                | DROP (done)                    | killed in the fix                                                              |
| A22 | T6 review m2: words after a pallet stop of «Закрыть паллету и смену»                                              | FIX (m5)                       | ВЦ3 needs the words to carry it                                                |
| A23 | T6 review m3: `blocked.open_pallet` grammar                                                                       | FIX (m5)                       | one string                                                                     |
| A24 | T6 review m4: `closed === "stopped"` equivalent                                                                   | FIX (m8)                       | comment                                                                        |
| A25 | T6 review m5: early close without the tries loop                                                                  | CARRY (m12) to the owner       | plan-accepted                                                                  |
| A26 | T7 M1: exact-SSCC scan test                                                                                       | FIX (m1)                       | V3 survives at HEAD                                                            |
| A27 | T7 M2: flash words                                                                                                | FIX (m4)                       | plus the AGENTS limit bullet                                                   |
| A28 | T7 M3: `disassemblePallet` backstop                                                                               | FIX (m3)                       | plus AGENTS bullets and spec §19                                               |
| A29 | T7 M4a: R11                                                                                                       | FIX (m2)                       | = A11                                                                          |
| A30 | T7 M4b: `:265` real flow                                                                                          | FIX (m7)                       | test only                                                                      |
| A31 | T7 M5: press guard on the pallet buttons                                                                          | FIX (m7)                       | test only                                                                      |
| A32 | T2 review m1: upgrade tests seed only a box copy                                                                  | DROP (m9)                      | no 0007 station in the field; no CHECK at risk                                 |
| A33 | T2 review m2: `purgeAcknowledged` JSDoc                                                                           | FIX (m8)                       | doc                                                                            |
| A34 | T2 review m3: AGENTS 21-tables sentence                                                                           | FIX (m8)                       | Task 10 missed it                                                              |
| A35 | T2 review m4, m5                                                                                                  | DROP (done)                    | pins added in Tasks 3–4; the null-capacity stop is in Task 5                   |
| A36 | New: `closePallet` open-job check unpinned (P5)                                                                   | FIX (m6)                       | comment: unreachable through the summary re-read                               |
| A37 | New: `confirmClose` comment about ПЛ-Ц pinning                                                                    | FIX (m8)                       | P17 shows it is pinned; reword                                                 |
| A38 | New: scenario does not pin host block use (HM2)                                                                   | DROP (m10)                     | pinned by `pallet_facts.rs`                                                    |
| A39 | New: spec §19 «не хранится», AGENTS «early close» wording, long doc line                                          | FIX (m8)                       | wording                                                                        |
| A40 | New: `submit` checks `palletsOf` before the created-entry path                                                    | DROP                           | choices read once per form; unreachable                                        |

### Proposed fix wave (ONE fixer, four commits, explicit paths, one trailer each)

1. **`fix(standalone): a pallet is never taken apart while its label job is open`** (m3).
   - `pallet-exceptions.ts`: the guard statement plus its exported SQL constant; `LabelWaitingError`, or `stale` after a re-read; the module header reworded.
   - Pins in `test/floor-schema.test.ts` and `src-tauri/tests/local_db.rs`, plus the text-agreement list.
   - A `holdingWrites` test in `test/floor-pallet-exceptions.test.ts`.
   - `AGENTS.md`: the Exceptions bullet and the known-limit bullet. Spec §19: «Исключения паллеты» and «Известные ограничения».
   - Mutant: drop the guard → killed. Gates: Vitest focused, `cargo test --offline --locked -p markiro-standalone --test local_db`, `cargo fmt --check`.
2. **`fix(standalone): the floor's words for a pallet's choice and its stops`** (m4, m5).
   - `ru.json`: `signal.taken`/`notFound` neutral; `result.failed`; `palletFailed.body`; `palletWaits.body`; `blocked.open_pallet`.
   - A `fromClose` flag on `pallet_no_serials`/`pallet_failed` set in `confirmPalletClose`, with the «Смена не закрыта…» line.
   - The `LabelWaitingError` message, made subject-neutral.
   - Box tests asserting the old words updated, plus one test for the shift-not-closed line.
   - `AGENTS.md`: remove the «still says «короб»» bullet.
   - Delayed-`setImmediate` stand on the touched UI files.
3. **`test(standalone): the pallet guards the suite did not pin`** (m1, m2, m7).
   - Flow-level exact-SSCC scan with a same-tail SSCC; the mislabelled unit test retitled.
   - R11 with `damaged_label` on the label panel.
   - The press-guard double tap on a pallet action.
   - Restart sequencing (box `sending`, pallet `prepared`).
   - `:265` through the real «Расформировать короб» flow.
   - Each must kill its mutant: V3, R11, V11. The P5 comment goes in commit 4.
4. **`docs(standalone): what the pallets changed in the old text`** (m8).
   - `AGENTS.md:192-194` (23 tables, 11 `DeviceData`, pallets in the list); the ВЦ3 known-limit wording.
   - `retention.ts` `purgeAcknowledged` JSDoc.
   - `WorkScreen.tsx` `confirmClose` JSDoc (pinned by «takes no scan queued behind the close»); the `closed === "stopped"` comment; the `closePallet` open-job comment (m6).
   - Cross-reference comments in `reprintPallet` and `reprintBox`.
   - Two test titles.
   - Spec §19 «показывается, только пока…».
   - `pallets.ts:137` line wrap.

Gates at the end: focused Vitest of the touched files, plus a full package run with `--testTimeout=60000`; `typecheck`, `lint`, `build`; the prettier gate (live-proved); `git diff --check`; the `\u04` grep. The local_db cargo target is needed for commit 1 only. Do not run the full workspace.

---

## (c) DEVIATIONS TO RECORD (draft for «Отклонения при исполнении», in Russian)

- **Задача 1.**
  - Четыре кода квитанций паллет уже были в `FACT_RECEIPT_CODES`, а тест «know every receipt code of the host» уже проходил. Поэтому фрагмент 5 `protocol.ts` пропущен.
  - Готовыми оказались также `shiftSnapshotTemplateSchema` и поля паллет `officeShiftSchema`.
  - Сверх плана: `keepEnteredShift` тоже передаёт `palletsEnabled` в `checkShiftSnapshot`. Иначе ответ с паллетами без макета паллеты мог сохраниться.
  - Строгость трёх записей паллет и чтение флага в `readStoredWork` и `enterShift` покрыты тестами.
- **Задача 2.**
  - Сверх плана добавлен индекс `floor_pallets_shift (host_id, device_id, shift_id)`: без него удаление паллет при очистке и чтение закрытых паллет смены идут полным просмотром.
  - У `floor_pallet_exceptions` индекса по смене нет намеренно: её просмотр закреплён в обоих списках планов.
  - `id TEXT NOT NULL PRIMARY KEY` у обеих таблиц, как в `0006`/`0007`.
  - По смыслу обновлены закрепления столбцов, индексов и планов в `test/floor-schema.test.ts`, а также `test/floor-new-shift.test.tsx` (`createdCopy`).
  - Фрагмент 3 Rust-теста встретился трижды и применён ко всем трём местам.
  - Добавлены тесты миграции `0008` поверх базы `0007` на SQLite Node и на `Migrator` оболочки.
- **Задача 3.**
  - Подзапрос `pallet_boxes` сводки переписан на коррелированную сумму по `floor_pallets_open` + `floor_boxes_pallet`: соединение из плана обходило все короба подключения. Значение то же.
  - Тексты SQL вынесены в константы ради закреплений.
  - `test/floor-work-close.test.tsx` сравнивает `readOpenJob` с `OPEN_JOB_READ_SQL`.
  - Исправление `d7a91fb56`: номер паллеты, чей SSCC держит другая паллета (бывшее подключение после переустановки хоста), теряется один, как у короба (`freePalletSscc`), а не останавливает навсегда каждое закрытие короба.
- **Задача 4.**
  - `palletExceptionStatements` живёт в `facts.ts` рядом с `exceptionStatements` (иначе цикл импорта).
  - Один `PALLET_STATE_SQL` вместо `isClosedPallet` и отдельного счёта.
  - Перепечатка паллеты несёт в транзакции две проверки: паллета закрыта и не расформирована, а последнее задание — прочитанное. Проверка живой паллеты стоит и перед записью `pallet_exception` в «Напечатать снова».
  - `PalletTemplateChangedError` — подкласс `PalletUnavailableError`.
  - Тест 2a7 «этикетка паллеты здесь не решается» заменён двумя.
- **Задача 5.**
  - Шаг паллеты добавляется в `attemptClose`: в исполненном `WorkScreen` нет мемо `closeSteps`.
  - `blockContextOf(live, extension)`, два снабжения блоками.
  - Дополнительная остановка `pallets_missing`.
  - `settlePallet` пробует до трёх потерянных номеров (`PALLET_SERIAL_TRIES`).
  - `decide` и проверка этикетки зовут `settleLabel`, чтобы этикетка паллеты ушла после решения по коробу.
  - Исправление `789986485`: сообщение «Паллета заполнена, но не закрыта» выводится из прочитанной паллеты (`palletWaitsNow`).
- **Задача 6.**
  - Тесты брифа приведены к исполненным заголовкам и `work.press`.
  - `finishClose` — единый путь, передаёт `openPalletGuard` всегда.
  - Повторное чтение после сбоя идёт через `closeFailed`.
  - `sameSummary` сравнивает короба открытой паллеты.
  - Исправление `22d65cb09`: намерение закрыть смену привязано к номеру задания этикетки паллеты. Любая другая остановка или изменившаяся сводка его снимает.
- **Задача 7.**
  - Принтер перепечатки определяется по назначению (короб или паллета).
  - Пустое «Сейчас исключений нет» учитывает закрытые паллеты.
  - Последняя строка подтверждения выбирается по действию.
  - Тест задачи 5 о снятии короба с ждущей паллеты переведён на настоящий поток «Расформировать короб».
  - Оставшиеся пункты итогового ревью (M1–M5) закрыты волной исправлений итогового ревью.
- **Задача 8.**
  - Сверх плана: `palletCapacityOffered` (вместимость от 1 до 10 000 и подходящий шаблон паллеты, как требует хост) и `palletsOf` (форма с паллетами, которую нельзя создать, не отправляется как смена без паллет).
  - `isShiftOfRequest` сравнивает паллеты; первый тест брифа отвечает `MADE_PALLETS`.
- **Задача 9.**
  - sha256 фикстуры — `70464d38…2f32` вместо `7057d806…ad08` плана. Разница — шесть идентификаторов записей исключений, сдвинутых на один, как в задаче 8 плана 2a8. Обратная замена воспроизводит хеш плана точно (проверено итоговым ревью).
  - Сверх плана добавлены три теста хоста и выгрузка `pallet_state()`.
  - Мутация T4 (закрытие без `openPalletGuard`) в сценарии выживает по замыслу и закреплена тестами задачи 6.
- **Задача 10.**
  - Якоря `AGENTS.md` и спецификации не нашлись; текст вставлен по смыслу, §19 — в конец спецификации.
  - Исправлены устаревшие места о `closeSteps`, об индексах очистки и о сценарии.
  - Предложение о 21 таблице (`AGENTS.md:192-194`) пропущено и исправлено волной итогового ревью.
- **Счёт тестов.** Числа плана — числа его копии. На настоящем дереве: Vitest 122 файла, 3777 тестов (после задачи 9); `cargo test --workspace` — 819.
- **Итоговое ревью.**
  - Критических и важных замечаний нет.
  - Волна из четырёх коммитов:
    - запрет расформирования паллеты в транзакции, пока открыто задание её этикетки;
    - нейтральные слова выбора паллеты и правка слов остановок паллеты;
    - закрепления точного SSCC, причины «Напечатать снова» паллеты, кнопок, порядка после перезапуска;
    - устаревшие тексты.
  - Перенесены владельцу или в ОЧ:
    - ожидание номеров паллет внутри очереди работы;
    - досрочное закрытие без серии попыток.

---

## Evidence

- **Package and diff:** `review-33231f9eb..7009153c7.diff` (689.8 KB) and `git diff --stat`. I read the source files directly where it mattered: `pallets.ts`, `pallet-exceptions.ts`, the pallet regions of `WorkScreen.tsx` (`:560-617`, `:632-1952`), `shift-close.ts`, `ShiftClosePanel.tsx` `sameSummary`, `print-resolution.ts` `printAgain`, `new-shift.ts`/`NewShift.tsx`/`box-template-choice.ts`/`requests.ts`/`protocol.ts`/`shift-snapshot.ts` diffs, `0008_floor_pallets.sql`, `local_db.rs`, `retention.ts`, the host's `pallet_closed.rs`, `pallets.rs`, `pallet_label.rs`, `pallet_exception.rs`, `box_closed.rs`, `blocks.rs`, `shifts.rs` (`pallet_request`, `pallets`, `check_pallet_template`), `validate.rs` (`count`), `templates.rs` (`check_slot`), proto `DeviceShift`/`DeviceShiftCreate`/`ShiftSnapshot`, the `AGENTS.md` «Floor pallets» section and spec §19.
- **Vitest baseline:** 5 pallet files, 187/187 passed (`/tmp/claude/rev-plc-final/baseline.txt`).
- **Station mutants:** `/tmp/claude/rev-plc-final/mut.py`, logs `mut-*.txt`, results `mut-result-batch1.json`, `mut-result-batch2.json`, `mut-result.json`. Every row has `restored: true`: the backup copy, `cmp` silent, sha256 the same before and after.

| #   | Mutant                                                              | Result                     |
| --- | ------------------------------------------------------------------- | -------------------------- |
| P1  | `PALLET_SERIAL_TRIES` 3 → 1                                         | killed (2)                 |
| P2  | `palletWaitsNow` `>=` → `>`                                         | killed (6)                 |
| P3  | `closeBox` skips `settlePalletSafely` after a close                 | killed (7)                 |
| P4  | no pallet top-up after a box closes                                 | killed (1)                 |
| P5  | `closePallet` ignores a waiting label                               | **survived** (m6)          |
| P6  | «Закрыть паллету и смену» never keeps the intention                 | killed (32)                |
| P7  | entry ignores `pallets_missing`                                     | killed (1)                 |
| P8  | label panel reprint of a pallet from the box layout                 | killed (2)                 |
| P9  | pallet serial pick `ORDER BY from_serial DESC` (`pallets.ts`)       | killed (1)                 |
| P10 | `invalid` waits state → `null`                                      | killed (1)                 |
| P11 | early close does not settle the pallet's label                      | killed (35)                |
| P12 | `afterLabel` without `settlePalletSafely`                           | killed (3)                 |
| P13 | `settlePallet` closes without settling the label                    | killed (5)                 |
| P14 | link-back early close keeps the `pallet_no_serials` stop            | killed (1)                 |
| P15 | pallet exception row `operator_id` NULL (`facts.ts`)                | killed (2)                 |
| P16 | `floor_pallets_open` non-partial on `closed_at` (migration `0008`)  | killed (6)                 |
| P17 | «Закрыть паллету и смену» outside the work queue (still tracked)    | killed (1)                 |
| R11 | re-run at HEAD: `printAgain` pallet reason hard-coded `printer_jam` | **survived** (m2), 338/338 |
| V3  | re-run at HEAD: scan matches the last 4 digits                      | **survived** (m1), 289/289 |

- Restored sha256: `WorkScreen.tsx` `42fd6cad…`, `pallets.ts` `82e23a0b…`, `facts.ts` `e3d2f68d…`, `0008_floor_pallets.sql` `0373df1d…`, `print-resolution.ts` `8310738c…`, `ExceptionFlow.tsx` `d1111ad8…`.

- **Host mutants:** `/tmp/claude/rev-plc-final/hostmut.sh` and `hostmut-pf.sh`, logs `host-*.txt` and `hostpf-*.txt`. Each run was focused: `cargo test --offline --locked -p markiro-host --test floor_scenario`, or `--test pallet_facts`. The full workspace was not run. Baseline `floor_scenario` passes 5/5.
  - HM1 (`pallet_label.rs` Verified → `print_skipped_at`): killed by the main replay test.
  - HM2 (`pallet_closed.rs` drops `blocks::consume`): survives `floor_scenario`; killed by `pallet_facts` (6).
  - Both restored: `cmp` silent, sha256 `7e520860…` and `f8ed37ff…` the same before and after, `touch`ed.
- **Fixture:** sha256 `70464d38…2f32`. The id mapping reproduces `7057d80658da2f2c7e865098509c593e3275ff472a30874c845515b0dc4ead08`.
- **Hygiene:** commit trailers (13 × 1); `git diff --check`; the `\u04` grep; no forbidden paths; all buttons `size="floor"` (scripted scan of the five changed TSX files); pin twins (14 constants in both lists); `TABLE_CLASSES` count (23 entries, 11 `DeviceData`).
- **Not run:** the full Vitest package and the full cargo workspace (load; not required for a review), Windows, printers, the touch panel, WebView2, a real host over a LAN, and the delayed-`setImmediate` stand (no React file changed by me).
