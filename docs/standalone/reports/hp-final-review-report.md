# Plan ХП — final whole-part review

Range reviewed: `2c726efba..fdb8ee569` on `claude/m1` (7 commits: 32146bb07, 093297a7f, a457f1a35, 4a6856785, a8558af61, 60d7aac07, fdb8ee569). Scratch worktree: `/tmp/claude/wt/rv-hp` (detached at fdb8ee569, `git status --short` empty). Evidence logs: `/tmp/claude/wt/rv-hp-scratch/`.

## Verdict

**APPROVED for the beta. No change is required before the owner tests it locally.** Critical 0, Important 0, Minor 8. The fix wave below is optional: three cheap test pins, one stale comment and one rare-path index regression. It can go before the beta or be carried.

Each seam the controller named holds:

- Task 1. An empty list does not weaken the checks on a non-empty one: the length and per-block checks are unchanged and the epoch check comes first. On the station side, a pairing settles only after every chunk is answered, or after `no_restore`.
- Task 1, interim state. The host still marks a station after its first answered chunk (РК-С M2). An empty list adds no new way to be marked without returning blocks: any first chunk already did that. The interim state at fdb8ee569 is coherent, and `more` (ОЧ Task 7) is the right owner of the "last part" semantics.
- Task 2. `DUE_SHIFTS_SQL` keeps its cheap shape on both engines. Every delete in `RETAINED_TABLES` now searches an index. The upgrade from `0009` with data is tested on both engines. sqlx applies missing lower versions, so number gaps are safe.
- Task 3. Each retry spends exactly one bad serial: a compare-and-set `spendSerial` advances `next_serial` by one. `pendingClose` is untouched. The new chain is tracked before it starts and holds the gate across the queued turn. No queue job waits on the gate, so it cannot deadlock.
- Task 4. Every input accepted before is read the same way: `128` and `EAN13` paths are byte-for-byte the same, and `EAN128` was refused before. The writer→reader round trip holds.
- Task 5. Every mutant of the implementer and of this review is in host code.
- Task 6. The fix builds a deterministic id, and the test still checks the ordering rule.

## (a) Findings, most severe first

No Critical or Important findings.

**M1 (Minor, Task 2 side effect, not pinned).** Migration `0010` changes the plan of the any-pairing unsent count, `SELECT count(*) FROM outbox WHERE acked_at IS NULL`.

- Callers:
  - `src/local/outbox.ts:21` (`countUnsentRecords(local, null)`);
  - `src-tauri/src/local_db.rs:462` (`UnsentGuard::AnyPairing`, inside the forget transaction).
- Plan change, the same on SQLite 3.53 and 3.44, so most likely on 3.46 too:

  ```
  0009: SCAN outbox USING INDEX outbox_unsent
  0010: SCAN outbox USING COVERING INDEX outbox_shift
  ```

  It now walks every record instead of the partial index of unsent ones. Measured with 600 000 records of which 10 are unsent: about 25 ms per call, against under 0.1 ms with `INDEXED BY outbox_unsent`.

- Impact: low. This runs only when a station forgets its pairing and its pairing file cannot be read. It is not a repeated read, and no plan pin covers it.
- Plan claims: the plan says the sender's reads and the status bar's do not change, and that is true. All other outbox reads have the same plan before and after: `UNSENT_SQL`, `HEAD_RECORD_SQL`, the three status counts, `REOPEN_SQL`, `REFUSED_CLOSES_SQL`, the attempt statement and the four receipt statements (diff in `plans.log`).
- Fix (optional): `INDEXED BY outbox_unsent` in both statements, plus a pin in both lists. Or document it as a known cost.

**M2 (Minor, test gap, Task 3).** The `palletArrived` turn's write failure is not pinned.

- Mutant K9: `settlePalletSafely` → `settlePallet` inside the turn. It **survives** all 131 tests of `floor-work-pallets`, `floor-work-close-pallets` and `floor-work-pallet-exceptions`.
- Consequence if anyone makes that change later: a failed pallet-close write would be swallowed by `.catch(() => undefined)` in the `afterClosed` chain, and the line would never get the `system_error` stop.
- The current code is correct. Fix: one test in which the arrived turn's close throws and the work stops with «запись».

**M3 (Minor, test gap, Task 3).** The early close's retry after a pallet top-up is not pinned to `closeLosingBadSerials`.

- Mutant K8: after the `stored` top-up, `result = await closeSettled(() => closeOpenPallet(...))`. It **survives**.
- Fix: one test with no pallet serials, a block that comes, and a held first serial of that block; the early close then takes the next serial.

**M4 (Minor, test gap, Task 4, shared domain).** `ean128Data` is not pinned to exactly 18 digits after the AI.

- Mutant K12: `isValidSscc(payload.slice(2))` → `isValidSscc(payload.slice(-18))`. It **survives** all 29 tests. With it, `00` + extra digits + a valid SSCC would be read as the SSCC field.
- The current code is correct. Fix: one refusal case, for example `"001" + validSscc` or `"0002" + validSscc`.

**M5 (Minor, stale comment, Task 1).** `apps/standalone/src/host/api.ts:258` still says "blocks this station holds, 1-64 a request". It should say 0–64, with the empty list for a station without blocks.

**M6 (Minor, cross-plan carry to ОЧ Task 7).** ОЧ's Task 7 fragment rewrites `knownBlocksRequestSchema` as `z.array(knownBlockSchema)` **without `.max(64)`**.

- Applied verbatim, it would drop ХП's bound (ХП's M3 mutant shows the test would catch it).
- ОЧ's Step 0 does say "what ХП already did — keep it". The ОЧ reviewer should check that `.max(64)` survives. On `claude/m1` it is still present (ОЧ Task 7 not executed yet).

**M7 (Minor, merge seam, not ХП's defect).**

- `src-tauri/tests/local_db.rs:367` asserts the migration journal holds versions `1..=MIGRATOR.iter().count()` with no gaps. It passes at ХП's end state (`0001`–`0010`).
- It fails once a stream lands `0013` (ОЧ) without `0011`/`0012`, or `0012` (СКЛ) without `0011`.
- Plan СКЛ Task 4 already moves this assertion to `MIGRATOR` versions. Whichever stream merges first with a gap must carry that change. Note for the integration merge.

**M8 (Minor, protocol, DROP).** Accepting an empty list did not raise `PROTOCOL_VERSION`.

- A ХП station paired with a pre-ХП host would get 400 `validation_failed` forever on its empty request, and its outbox would wait (`restoreDue`).
- No pre-ХП host with the `known` route was ever released: РК-С and ХП ship in the same first beta. So this is acceptable and is not repeated here as a finding to fix. ОЧ's `more` field has the same property.

### Pre-existing items checked against the plan's end state

- **template-editor timeouts (5 s) under load.** Old suites, not this plan; `template-editor` is untouched in this range.
  - Alone at the default timeout: 97/97 twice (88 s and 100 s); slowest test 2.7 s. It reaches 5 s only under parallel load.
  - Same pattern in the admin suite: `labels-editor` had 3 timeouts under parallel load and 53/53 with `--testTimeout=60000`.
  - Standalone `template-code-downloads`: 1 timeout under parallel load, 14/14 alone.
- **Task 1's 91 office timeouts.** The same class, while the cargo workspace ran in parallel. Not reproduced in focused runs.
- **Host flake `the_office_reads_a_shifts_totals_from_its_facts`.** Fixed by fdb8ee569: 15 of 15 runs green.
  - Mutant K15 (`ORDER BY p.rowid`, i.e. row order) fails the test deterministically.
  - The implementer's mutant (`ORDER BY p.device_id, …`, id first) fails too.
  - So the test still separates entry order from id order and from row order.
- **`ПАЛЕТА`/`ПАЛЛЕТА` placard failures** (3 in domain `print-forms-snapshot`, 3 in standalone `forms-parity`). Present at the base and unrelated: `packages/domain/src/print-forms/pallet-placard.ts` says `ПАЛЕТА`, the fixtures said `ПАЛЛЕТА`. Already fixed on `claude/m1` and `claude/integration` by 26572c386; not a beta blocker.

## (b) TRIAGE

| #   | Source            | Item                                                                                                       | Decision              | Reason                                                                                                                     |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | T1 concern        | 11 old office suites time out at 5 s under load                                                            | CARRY                 | Pre-existing; they pass alone or with a long timeout. Fix in its own task (split heavy tests); do not just raise timeouts. |
| 2   | T1 concern        | Real restore on Windows / LAN not exercised                                                                | DOC                   | Already in §25 «Не проверено» and the plan's «Не проверено».                                                               |
| 3   | T1 deviation      | `test/floor-status-bar.test.tsx` fixed by meaning (expects one empty request)                              | DOC                   | Correct; goes into «Отклонения».                                                                                           |
| 4   | T2 concern        | Write cost of `outbox_shift`                                                                               | DOC                   | Stated in Д1 and §25.                                                                                                      |
| 5   | T2 concern        | template-editor timeouts                                                                                   | CARRY                 | Same as 1.                                                                                                                 |
| 6   | T2 concern        | Upgrade of a real Windows station DB not exercised                                                         | DOC                   | §25 «Не проверено».                                                                                                        |
| 7   | T3 deviation 1    | Brief said a close-pallets test passes before the change; it failed before                                 | DOC                   | Implementer's analysis is correct; final behaviour as intended.                                                            |
| 8   | T3 deviation 2    | `async () => undefined` → `() => Promise.resolve()` (lint `require-await`)                                 | DOC                   | Equivalent.                                                                                                                |
| 9   | T3 deviation 3    | Stop-standing test uses `act` + `turnsUntil` (`work.scan` would wait on the held request)                  | DOC                   | Test-harness constraint, not production.                                                                                   |
| 10  | T3 extra          | Test "closes no pallet in the turn a pallet block queues while a stop stands"                              | DOC                   | Kills M6/M12; keep.                                                                                                        |
| 11  | T3 M13            | `const pallet = true` survives                                                                             | DROP                  | Equivalent: an extra queue turn that finds nothing to close.                                                               |
| 12  | T3 concern        | A box turn during a hung pallet request leaves a tracked piece                                             | DROP                  | Unchanged: the top-up was already tracked; bounded at 2 × 10 s.                                                            |
| 13  | T4 concern 1      | `ПАЛЕТА`/`ПАЛЛЕТА` failures                                                                                | DROP                  | Pre-existing; fixed on m1 by 26572c386.                                                                                    |
| 14  | T4 concern 2      | Pre-#692 TSPL (`"128"`, `"!100<sscc>"`) imports as a literal                                               | CARRY                 | Old behaviour, pinned by a test. Decide together with the plan's carried ZPL `>;>800` import (same class).                 |
| 15  | T4 concern 3      | Test counts not in the plan                                                                                | DROP                  | Informational.                                                                                                             |
| 16  | T5 concern 1      | Known placard failures                                                                                     | DROP                  | See 13.                                                                                                                    |
| 17  | T5 concern 2      | Probabilistic host flake                                                                                   | DROP (fixed)          | fdb8ee569; verified 15/15, ordering mutant K15 killed.                                                                     |
| 18  | T5 concern 3      | S4 not killed by the scenario                                                                              | DROP                  | Killed by two existing `--test facts` tests.                                                                               |
| 19  | T5 gap            | Replay check "nothing written again" not killable alone                                                    | DROP                  | Belt-and-braces; the replay mutants die on earlier assertions.                                                             |
| 20  | T6 deviation      | §25 index bullet reworded (a code span across lines broke prettier)                                        | DOC                   | Same facts.                                                                                                                |
| 21  | T6 concern        | Ordering mutant only on the secondary key                                                                  | DROP                  | K15 (row order) killed as well.                                                                                            |
| 22  | Review M1         | Any-pairing unsent count walks `outbox_shift`                                                              | FIX (optional) or DOC | One-off path, about 25 ms at 600k records. Cheap fix with `INDEXED BY` plus a pin.                                         |
| 23  | Review M2         | `palletArrived` write failure not pinned                                                                   | FIX                   | One test.                                                                                                                  |
| 24  | Review M3         | Early-close retry after a top-up not pinned to the loop                                                    | FIX                   | One test.                                                                                                                  |
| 25  | Review M4         | `EAN128` 18-digit bound not pinned                                                                         | FIX                   | One refusal case in the shared domain test.                                                                                |
| 26  | Review M5         | Stale `api.ts:258` "1-64"                                                                                  | FIX                   | One line.                                                                                                                  |
| 27  | Review M6         | ОЧ Task 7 fragment drops `.max(64)`                                                                        | CARRY (ОЧ)            | Reviewer of ОЧ T7 checks it.                                                                                               |
| 28  | Review M7         | `local_db.rs:367` contiguous-version assertion vs. stream gaps                                             | CARRY (merge)         | СКЛ T4 already changes it; whoever merges with a gap first carries it.                                                     |
| 29  | Review M8         | No protocol bump for the empty list                                                                        | DROP                  | No pre-ХП host released.                                                                                                   |
| 30  | Plan «Перенесено» | ZPL `>;>800`, TSPL bar widths, mark on the last part, refused records, `secure_delete`, T4 scenario mutant | CARRY as written      | ОЧ owns the last part; the rest stays with its named owners.                                                               |

### Fix wave (optional, at most 4 commits, none blocking the beta)

1. `test(standalone)`: two `WorkScreen` pins.
   - The pallet-block turn's failed close stops the line with `system_error`/`write` (kills K9).
   - The early close after a pallet top-up loses a held first serial of the new block (kills K8).
   - Run them verbose and under the delayed-`setImmediate` stand.
2. `test(domain)`: an `EAN128` refusal for `00` + extra digits + a valid SSCC (kills K12). Also run the admin `labels-import-analysis` and `label-samples` tests.
3. `docs(standalone)`: `src/host/api.ts:258` "1-64" → "0-64 (an empty list from a station that never took a block)".
4. Optional, `fix(standalone)`: the any-pairing unsent count reads `outbox_unsent`.
   - Use `INDEXED BY outbox_unsent`, or a `host_id`-free predicate the partial index serves, in both `src/local/outbox.ts` and `src-tauri/src/local_db.rs`.
   - Add a pin in `test/floor-schema.test.ts` and in `tests/local_db.rs`.
   - Otherwise, one line in AGENTS «Known limits of the retention».

## (c) Отклонения при исполнении (для раздела плана)

- **Задача 1:** `test/floor-status-bar.test.tsx` (нет в списке файлов) исправлен по смыслу: подключение без блоков теперь делает один запрос `{ blocks: [] }`. Добавлены тесты сверх плана:
  - хост: 64 блока принимаются, 65 — нет;
  - станция: ровно 64 блока — один запрос; хост без восстановления на пустой запрос; упавший пустой запрос оставляет долг.
- **Задача 2:** без отклонений. Строки планов SQLite 3.46 совпали с планом; мутации M4–M13 добавлены сверх плана.
- **Задача 3:**
  - Тест закрытия смены «says the pallet did not close when its serial was lost…» падал до реализации, а не проходил, как ждал план: с тремя занятыми номерами без цикла «Повторить» тратит второй номер.
  - Начальное значение `palletArrived` записано как `() => Promise.resolve()` (правило линтера `require-await`).
  - Тест с удержанным запросом хоста использует `act` и `turnsUntil`, а не `work.scan`: стенд ждёт ворота, а значит и удержанный запрос.
  - Добавлен тест «closes no pallet in the turn a pallet block queues while a stop stands on the line».
  - `topUpTracked` удалён (единственный потребитель — `afterClosed`).
- **Задача 4:** без отклонений во фрагментах. Добавлены тесты сверх плана: обратное чтение 45 SSCC, регистр типа, прежние формы `128` и `EAN13`, прежний экспорт `"!100<sscc>"` читается литералом, как раньше.
- **Задача 5:** без отклонений; исходники хоста не менялись (Д6). Мутации A2–A9 и S2–S5 добавлены сверх плана.
- **Задача 6:**
  - Пункт об индексах в §25 переписан без кода через перенос строки (иначе не проходит prettier).
  - Отдельным коммитом fdb8ee569 устранён вероятностный сбой теста хоста `the_office_reads_a_shifts_totals_from_its_facts`: второе устройство получает построенный id `ffffffff-ffff-4fff-bfff-ffffffffffff`, а не случайный.
- **Итоговое ревью:**
  - Найдено: счёт неотправленных записей всех подключений (`countUnsentRecords(null)` и `UnsentGuard::AnyPairing`, только при сбросе подключения с нечитаемым файлом) после `0010` обходит весь `outbox_shift` вместо частичного `outbox_unsent`: около 25 мс на 600 000 записей.
  - Остались незакреплены: ошибка записи в ходе `palletArrived`, цикл досрочного закрытия после пополнения и граница 18 цифр у `EAN128`.
  - Устаревшая строка `src/host/api.ts:258` («1-64»).

## Evidence

Focused runs, all at fdb8ee569 in `/tmp/claude/wt/rv-hp`:

| Area       | Run                                                                                                                                                                                                                                                   | Result                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Cargo      | `markiro-host --test known_blocks`                                                                                                                                                                                                                    | 13 passed                                                              |
| Cargo      | `markiro-host --test facts`                                                                                                                                                                                                                           | 58 passed                                                              |
| Cargo      | `markiro-host --test floor_scenario`                                                                                                                                                                                                                  | 5 passed                                                               |
| Cargo      | `markiro-proto --test backup`                                                                                                                                                                                                                         | 6 passed                                                               |
| Cargo      | `markiro-standalone --test local_db`                                                                                                                                                                                                                  | 30 passed                                                              |
| Cargo      | workspace build                                                                                                                                                                                                                                       | 0 warnings                                                             |
| Cargo      | `cargo fmt --check`                                                                                                                                                                                                                                   | 0                                                                      |
| Vitest     | 13 files: backups, restore-reconcile, backups-page, host-link-restore, floor-status-bar, floor-shift-indexes, floor-schema, floor-pallet-schema, retention, floor-work-pallets, floor-work-close-pallets, floor-work-pallet-exceptions, floor-pallets | 395 passed                                                             |
| Vitest     | verbose run of floor-work-pallets, floor-work-close-pallets, backups-page                                                                                                                                                                             | 119 passed, 0 `stderr \|`                                              |
| Vitest     | delayed-`setImmediate` stand (3 ms) on the same three plus floor-status-bar                                                                                                                                                                           | 166 passed, 0 `stderr \|`; stand files deleted                         |
| Domain     | full Vitest                                                                                                                                                                                                                                           | 1210 passed; 3 failed, all the pre-existing `ПАЛЕТА` placard snapshots |
| Domain     | `labels-import`                                                                                                                                                                                                                                       | 29 passed                                                              |
| Domain     | typecheck                                                                                                                                                                                                                                             | 0                                                                      |
| Domain     | dist                                                                                                                                                                                                                                                  | rebuilt                                                                |
| Admin      | `labels-import-analysis`, `label-samples`                                                                                                                                                                                                             | 40 passed                                                              |
| Admin      | `labels-editor`                                                                                                                                                                                                                                       | 53 passed with `--testTimeout=60000`; 3 timeouts under parallel load   |
| Standalone | import-analysis, import-code-dialog, template-code-downloads, domain-internal-errors                                                                                                                                                                  | 52 passed; one 5 s timeout under load, 14/14 alone                     |
| Standalone | typecheck, lint                                                                                                                                                                                                                                       | 0                                                                      |
| Repo       | `git diff --check`                                                                                                                                                                                                                                    | clean                                                                  |
| Repo       | prettier on every changed TS/TSX/JSON/MD (from the worktree root)                                                                                                                                                                                     | clean                                                                  |
| Repo       | `Co-Authored-By` trailer                                                                                                                                                                                                                              | exactly one in each of the 7 commits                                   |

Query plans before and after `0010` on Node SQLite 3.53 (scratch test, deleted): output in `plans.log`. Changed:

- `DUE_SHIFTS_SQL` and `PURGE_COPY_SQL` (as pinned);
- the three purge deletes (`SCAN` → `SEARCH` on the shift index);
- the any-pairing unsent count (M1; also confirmed on `sqlite3` 3.44).

Unchanged: everything else.

Mutants of this review (every file restored, `cmp` identical and the same sha256, Rust files touched; `git status` empty afterwards):

| #   | Mutant                                                          | Result                                                                                                     |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| K1b | host: an empty list does not set `known_blocks_epoch`           | killed: `a_station_without_blocks_is_marked…`                                                              |
| K1  | host: mark only a device with an `sscc_blocks` row              | survived; not a faithful mutant, because the test's station already holds an issued block; replaced by K1b |
| K4v | `floor_exceptions_shift (shift_id, host_id)`                    | killed: floor-schema «serve the reads», floor-shift-indexes                                                |
| K4c | the same, on the shell                                          | killed: `the_floors_repeating_reads_search_an_index` (SQLite 3.46)                                         |
| K6  | `const pallet = blocks === supply` (flag swapped)               | killed: 2 tests                                                                                            |
| K8  | early-close retry after a top-up without the loop               | **survived** (M3)                                                                                          |
| K9  | the arrived turn calls `settlePallet`, not `settlePalletSafely` | **survived** (M2)                                                                                          |
| K11 | `ean128Data` accepts any payload ending in `{{sscc}}`           | killed: «refuses an EAN128…»                                                                               |
| K12 | `slice(-18)`                                                    | **survived** (M4)                                                                                          |
| K13 | `EAN128` with a placeholder takes the generic path              | killed: 2 tests                                                                                            |
| K14 | host undo ignores `added_at`                                    | killed by the existing `a_late_undo_never_takes_out_a_code_scanned_again_after_it`                         |
| K15 | host participants `ORDER BY p.rowid`                            | killed: `the_office_reads_a_shifts_totals_from_its_facts`                                                  |
| K16 | station skips the results-count check for an empty chunk        | killed: «keeps owing when the host answers the empty request with a result»                                |

Not run here (why):

- The full cargo workspace (controller's instruction).
- The full standalone Vitest package (heavy; the implementers ran it, with timeouts only).
- Windows, WebView2, printers, a real restore, a hung host on a real LAN: no environment.
