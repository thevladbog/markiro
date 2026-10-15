# Plan ОЧ — final whole-part review

Range `fdb8ee569..96209f28b` on `claude/m1` (tasks 1–8; the merge `1a3bb1874` ignored). Scratch worktree `/tmp/claude/wt/rv-och` (detached at `96209f28b`, left clean).

## Verdict

**Needs a small fix wave before the owner's beta.** No Critical findings. The data-integrity core holds:

- «Отправить снова» is one `BEGIN IMMEDIATE` transaction per part on the single writer connection, with `expectedChanges` on the MARK. It is idempotent under a double press, a crash between parts, and a concurrent `REOPEN`.
- «Снять с очереди» is irreversible and always writes `resolution`, `resolved_at` and `resolved_by` together. `outbox-recovery.ts` is the only writer of those columns: grep over `src`, `src-tauri/src` and `host/src` finds no other writer, and the shell never writes `outbox`.
- The sender never sends a resolved record. It reads `acked_at IS NULL`, a resolved record always has an outcome and therefore `acked_at`, and `REOPEN_SQL` skips resolved records.
- The retention never purges an unresolved refusal. The check is in both the reading and the guarded delete.
- The protocol field `more` works with older stations, survives a lost last answer and keeps `.max(64)`.

Two Important items:

- **I-1** is an operability gap that the new runbook text makes visible.
- **I-2** is a merge gate with the СКЛ stream.

## (a) Findings, most severe first

### Important

**I-1 — After a restore, a mass of refusals cannot practically be resolved, and the new runbook bullet asks for something impossible.**

The scenario is the runbook's own (check 4, «Смены»): shifts that were created, opened or closed after the copy get `unknown_shift` / `not_entered` on every record. That is thousands of scans per shift.

ОЧ now:

- (a) lists every unresolved refusal of the pairing with no bound. `QUEUE_SETTLED_SQL` takes 68 ms for 10 000 rows and 285 ms for 50 000 on node:sqlite. On top of that come IPC and rendering one floor `Button` per record, and the screen reads and renders everything again on every `outboxVersion` bump, i.e. every receipt batch during the post-restore resend.
- (b) offers only a per-record «Снять с очереди». Each needs its own confirmation behind the 400 ms guard.
- (c) never lets the refused close be taken off (О3). For an unknown shift the office cannot close it either, because the host has no such shift.

The runbook bullet added in task 8 (`docs/runbooks/standalone-backup-restore.md`, check 5: «записи смен, которых копия не знает (`unknown_shift`, `not_entered`) … снимите их с очереди после сверки с офисом») cannot be done at that volume and is impossible for the close. AGENTS «Outbox recovery» repeats «the office closes the shift», which is false for an unknown shift.

Before ОЧ these records were only a count. They never held the shift, because a refused close is never purged anyway, so this is not a regression of data. It is a recovery path that ОЧ documents as available when it is not.

Proposed fix:

- One «Снять с очереди все отказы смены» per shift group: one confirmation, one `UPDATE … WHERE host_id/device_id/shift_id AND outcome='rejected' AND kind<>'shift_closed' AND resolved_at IS NULL`, `expectedChanges` equal to the count shown, mismatch → `StaleQueueError`.
- Bound the per-shift list to its first 20 records, then «и ещё N».
- Correct the runbook: the close stays named, a count of 1 per such shift remains, and the work is entered by hand.
- Whether a close refused `unknown_shift` / `not_entered` may be taken off is an owner decision (CARRY).

**I-2 — Merge gate with СКЛ: a failing warehouse route would delay production facts under ОЧ's guard.**

ОЧ adds `factsNow`: `if (factRetry !== null) return;` (`src/app/host-link.ts:487-490`). On `claude/wh` (`f96697d4f`, `host-link.ts` ~438-456), a non-shell failure of `/v1/device/warehouse/reprints` arms the same `factRetry`, with up to 60 s of back-off. Merged as they are, every new scan, box close or shift close waits for the warehouse pause, while the bar says `facts_sent`.

This is the СКЛ final review's I2(b), and its planned fix 2 (`warehouseRetry` timer of its own; `factsHeld` only for `restore_pending`) removes it. `.superpowers/sdd/skl-final-fix-report.md` does not exist yet: the СКЛ fix wave has landed only `f96697d4f`.

Gate: the integration merge of ОЧ + СКЛ must contain СКЛ fix 2, plus a test that a failing warehouse batch followed by `requestFacts()` sends the fact at once, under ОЧ's guard.

### Minor

- **m-1 — The receipt's 5th operator (unfix `needs_fix`) walks the box's whole shift per marked box.** `NOT EXISTS … c` plans as `floor_scans_shift (host_id, device_id, shift_id)`; there is no index with `box_id` or `conflict`.
  - Measured on node:sqlite: 0.4 ms when no box is marked. 995 ms for a batch of 100 accepted scans whose 100 boxes carry `needs_fix = 1` in a shift of 100 000 scans, about 10 ms per marked box, inside the single-writer receipt transaction.
  - Realistic only after a restore re-sends scans that conflicted earlier, so few boxes.
  - CARRY: if a shell migration is ever taken (0014+), add `floor_scans (box_id) WHERE conflict = 1`.
- **m-2 — Hourly cost of the retention clause `r` (measured; the docs say «not measured at 600 000»).** node:sqlite 3.53, no ANALYZE, `DUE_SHIFTS_SQL`:

  | Outbox (records) | Held shifts           | Without `r` | With `r` | With partial index |
  | ---------------- | --------------------- | ----------- | -------- | ------------------ |
  | 600 000          | 12 × 50 000, all held | 131 ms      | 289 ms   | 160 ms             |
  | 600 000          | 300 × 2 000, 10 held  | 132 ms      | 200 ms   | —                  |
  | 300 000          | 6 × 50 000, none held | 57 ms       | 117 ms   | —                  |
  | 300 000          | 6 × 50 000, all held  | 53 ms       | 125 ms   | —                  |

  The partial index tested is `outbox (shift_id, host_id, device_id) WHERE outcome IN ('rejected','conflict') AND resolved_at IS NULL`.

  - `r` costs about 0.2–0.25 µs per record of a candidate shift. It runs on a WAL reader connection (two-connection pool), at most once an hour and at start, and never blocks the writer.
  - The base cost of about 130 ms is ХП's existing `outbox_settled` walk over every accepted record and dominates either way.
  - Decision: the partial index can wait. No shell migration before the beta. If 0014 is taken later, add it together with m-1's index.
  - DOC: put the numbers in AGENTS «Known limits of the retention» and in §27.

- **m-3 — Docs: the queue screen is a fact writer that is neither gated nor stopped, which matters for the forget window.**
  - AGENTS («Two windows stay by design») says the forget screens come «with the fact writer stopped». A device refusal arriving while the queue screen is open ends the session at once (`reject`: `floorWork` is null), and the screen unmounts while the resend keeps writing.
  - The forget's count and clear are one `BEGIN IMMEDIATE` transaction, so the only window is a part committed between the clear and the removal of `device.json`. Those copies are stranded under the old pairing; their originals are marked `resent` and the device was refused anyway.
  - Harmless. DOC one sentence in «Outbox recovery» → «Known limits».
- **m-4 — Docs: «attempts count retries» does not hold in `watchFailed` mode.** In that mode `online` stays false, so no `factRetry` is armed and every request sends at once (pre-existing degraded mode). DOC.
- **m-5 — The stock texts say «меньше четверти / десятой части» for inclusive thresholds.** It is off by one serial and documented, but cheap to make honest: «четверть блока или меньше» / «десятая часть блока или меньше» (4 strings, regexes in 2 tests). FIX.
- **m-6 — Test gap: a conflict landing between the reading and the guarded delete.** My mutant M18 (`DONE_WITH`'s `r` with only `'rejected'`) survives `retention.test.ts`: the race test seeds only a `rejected`. FIX with a one-case test.
- **m-7 — A newer station against an older host.** `KnownBlocksRequest` is `deny_unknown_fields`, so an older host refuses `more: true` (sent only by stations with more than 64 blocks). The task 7 report's «an older host still reads what a new station sends» is true only for the last part. Versions ship together. DOC (one clause in §27).
- **m-8 — `floor_block_drops` makes a permanent red alert.** There is no acknowledgement, and it lasts until the pairing is reset. The text explains it and the plan intends it (О8). CARRY as an owner UX question.
- **m-9 — The `RESEND_CHUNK` comment («under a megabyte of bound JSON») is imprecise.** The list is bound twice (INSERT and MARK), and re-escaping the payload grows it. No limit exists on bound values (`MAX_SQL_BYTES` bounds SQL text only), so nothing breaks. DROP or reword.
- **m-10 — The resend confirmation counts what the screen read.** `resendRefused` re-reads, so a refusal that arrived since goes too. The data is correct. DROP.
- **m-11 — Accessibility: many buttons share the name «Снять с очереди» / «Разобрано».** There is no `aria-describedby` to the record line. CARRY, or fold into fix 1.
- **m-12 — Status bar: the previous pairing's `drops` / `stranded` stay until the new read lands.** The window is milliseconds and stale answers are dropped. DROP.
- **m-13 — Equivalent survivor M5** (unmark also on a `rejected` receipt). The marks are never read in `src`. DROP.

### Checked and fine

- **«Отправить снова»**
  - The read happens outside the transaction; INSERT and MARK carry the same guards (`+outcome='rejected'`, `resolved_at IS NULL`, pairing), with `expectedChanges` on the MARK.
  - Double press: one write wins, the other is Stale.
  - A crash between parts resumes with the remainder and keeps the order.
  - REOPEN between the read and the write: the INSERT finds fewer rows and everything rolls back.
  - The copies get new UUIDs with payload byte for byte (checked with `JSON.stringify(data)` equality), `created_at` now, `seq` after everything, in order within and across parts.
- **Receipts and the resend never touch the same rows**: receipts apply only to `acked_at IS NULL`, the MARK only to `rejected` records. Writes serialize on one writer connection.
- **РК-С**: `REOPEN_SQL` skips `resolved_at`. A resent original is never sent twice. The copy is reopened and sent under its own id, and the restored host takes it once. A dismissed record is never sent.
- **Retention**: `r` is in both `DUE_SHIFTS_SQL` and `PURGE_COPY_SQL`. A resent copy that is still unsent holds the shift through `u`.
- **Protocol**: an absent `more` means last (older stations as before). A lost last answer: the station stays owing and re-sends every part; the host answers `known`, marks idempotently (`IS NOT`) and commits nothing new. Empty only in the last part. Zod is `more: z.boolean().optional()` with `.max(64)` kept, strict. Proto uses `serde(default, skip_serializing_if Not::not)`. The fixture is parsed by both.
- **Migration numbering**: `local_db.rs` journal assertions use the `MIGRATOR` versions on both branches (ОЧ `any(==13)`, СКЛ `any(==12)`), so they are compatible. Expect only textual conflicts (and the `reads: [_; N]` length). `floor-outbox-recovery-migration.test.ts` selects 0001–0010 and 0013 explicitly, so it survives 0011/0012. AGENTS' «25 tables» needs updating at the merge (СКЛ adds `wh_*`).
- **Work gate / N9–N13**: the queue screen opens only from the list (`floorWork` null). Its writes are disjoint from the work queue's in effect (guards, single writer). The idle-sign-out unmount completes the write and tells the bar. Accepted, apart from m-3's doc gap.
- **Delayed-`setImmediate` stand**: two runs over queue screen, status bar, floor app, shift list and host-link-facts, 261 passed each, 0 `stderr |`.

## (b) TRIAGE

| Item (source)                                                                   | Decision                 | Reason                                                                                                                         |
| ------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| addendum: measure `r`, covering partial index? (T2 / ХП)                        | DOC + CARRY              | measured (m-2): about 0.2 µs per held record per hour, on a reader connection; no shell migration before the beta; doc numbers |
| addendum: keep `.max(64)` (ХП)                                                  | DROP (done)              | kept; Z4 mutant killed                                                                                                         |
| addendum: merge care for `local_db.rs` migration assertion                      | CARRY (merge check)      | compatible on both branches (MIGRATOR-version based)                                                                           |
| T1: `VersionMissing` across stream databases                                    | DROP                     | documented as a developer hazard; disappears at the merge                                                                      |
| T1/T2/T6: `floor_block_drops` never purged                                      | CARRY                    | bounded by dropped blocks (tiny); DeviceData by design                                                                         |
| T1: drops pin text test-local                                                   | DROP                     | T5 reuses the real export                                                                                                      |
| T1–T8: Windows / WebView2 / touch / real host not run                           | CARRY                    | «Не проверено»                                                                                                                 |
| T2: resolution columns not tied by CHECK                                        | DROP                     | single writer verified; SQLite cannot add a table CHECK by ALTER                                                               |
| T2: disk growth by held shifts                                                  | DROP                     | by design (О4), documented                                                                                                     |
| T3: `RESEND_READ` / `QUEUE_SETTLED` walk resolved refusals via `outbox_settled` | CARRY                    | resolved records go with their shift (30 days after an accepted close); human-scale                                            |
| T3: `INDEXED BY outbox_unsent` breaks if the index is renamed                   | DROP                     | pinned in both plan lists                                                                                                      |
| T3: equivalent survivors I1b, C2, C9, Q2b                                       | DROP                     | equivalent                                                                                                                     |
| T4: writes outside the work gate; idle sign-out                                 | DOC (m-3)                | accepted; add the forget-window sentence                                                                                       |
| T4: roles not checked                                                           | DROP                     | О2 (role is free text)                                                                                                         |
| T5: inclusive threshold wording                                                 | FIX (m-5)                | 4 strings                                                                                                                      |
| T5: stale stranded/drops at a pairing switch                                    | DROP (m-12)              | milliseconds; stale answers dropped                                                                                            |
| T5/T8: `graphify update` exit 1                                                 | DROP                     | untracked graph                                                                                                                |
| T6: offline scans count no attempts                                             | DROP                     | correct, documented                                                                                                            |
| T6: second block with the same id keeps the first reason                        | DROP                     | documented                                                                                                                     |
| T7: mixed fleets (old station marked after its first part)                      | DROP                     | documented in runbook and §27                                                                                                  |
| T8: §27 after §25 (no §26 in this line)                                         | CARRY (merge)            | order §26 → §27 at the I1 merge                                                                                                |
| new I-1                                                                         | FIX                      | fix 1                                                                                                                          |
| new I-2                                                                         | GATE                     | СКЛ fix 2 at the merge, plus a test under ОЧ's guard                                                                           |
| new m-1                                                                         | CARRY                    | index with the next shell migration                                                                                            |
| new m-4, m-7, m-9                                                               | DOC                      | fix 3                                                                                                                          |
| new m-6                                                                         | FIX                      | fix 2                                                                                                                          |
| new m-8                                                                         | CARRY                    | owner UX                                                                                                                       |
| new m-10, m-12, m-13                                                            | DROP                     | —                                                                                                                              |
| new m-11                                                                        | CARRY or fold into fix 1 | —                                                                                                                              |

### Fix wave (3 ОЧ commits plus one merge gate)

1. `feat(standalone): the queue screen takes off a shift's refusals at once and bounds its list` — fixes I-1.
   - `dismissShiftRefusals(context, shiftId, expected)`: one `UPDATE` with the DISMISS guards, `shift_id`, `kind <> 'shift_closed'` and `expectedChanges = expected`. Pin its plan in both query-plan lists, plus the text-agreement test.
   - A per-group button with a confirmation that names the count and says the close stays.
   - The list bounded to 20 records per shift, with «и ещё N».
   - Tests: double press, stale, the close untouched, the tie of the three columns.
   - Runbook check 5 bullet and AGENTS «Outbox recovery» corrected: the close stays named, and the office cannot close a shift the host does not know.
   - Optional: `aria-describedby` on the per-record buttons (m-11).
2. `fix(standalone): the stock warnings say «или меньше», and the retention keeps a shift for a conflict that lands before the delete` — fixes m-5 and m-6.
3. `docs(standalone): ОЧ limits measured` — fixes m-2, m-3, m-4, m-7, m-9.
   - AGENTS «Known limits of the retention» and §27: the measured `r` numbers and the decision.
   - The forget window of the queue screen's writes.
   - `watchFailed` attempts.
   - An older host refuses `more`.
   - The `RESEND_CHUNK` comment.
4. (Merge gate, not an ОЧ commit — I-2.)
   - The integration merge takes СКЛ fix 2 (`warehouseRetry`) before or together with ОЧ.
   - Add `host-link-facts` test: «a failing warehouse batch does not hold a new fact».
   - Re-run `local_db.rs`, `floor-schema.test.ts` and the AGENTS table count after the merge.

## (c) Отклонения при исполнении (for the plan)

- Задача 1: проверка журнала в `migration_0009_…` сверяет версии самого `MIGRATOR` (номера с пропусками 0011/0012). Список таблиц `test/local-executor.test.ts` и списки таблиц и данных устройства в `tests/local_db.rs` дополнены `floor_block_drops`. Добавлены тесты: обновления с базы 0010 (`test/floor-outbox-recovery-migration.test.ts`) и применения младшей миграции после старшей. `expecting(sql, values, n)` — три аргумента.
- Задача 2 (база `1a3bb1874`, слияние с integration): сравнение планов «до и после 0013» в тесте миграции оставлено только для операторов без `resolved_at`. Тест `app.test.tsx` «deletes at its start…» засевает отказ разобранным (`dismissed`), а наблюдение сменено на перечитывание строки состояния после очистки. Причина закрытия в тесте — `production_order_changed`.
- Задача 3: `STRANDED_COUNT_SQL` — `FROM outbox INDEXED BY outbox_unsent`. После 0010 (ХП) планировщик шёл по `outbox_shift`: 11 мс против 0,08 мс на 300 000 записей. План закреплён точным утверждением вне общего цикла теста оболочки. План `RESEND_READ` закреплён точно (`outbox_settled`). Модуль прогнан через prettier.
- Задача 4: в `QueueScreenProps` добавлены `outboxVersion` и `clock`. Вложенный `Card` заменён на `<section className="shift-card">`. Тексты подтверждений и причин переписаны (вид записи, время, SSCC, причина словами; необратимость). Добавлены защита нажатия 400 мс и ссылка-обёртка для возврата фокуса. Ожидание «2 ч 5 мин» в тесте после повторной отправки заменено на «меньше минуты». `onChanged` вызывается и после ухода с экрана.
- Задача 5: разделитель тысяч — неразрывный пробел, как в соседних тестах. Длина `reads` не менялась (запись запаса заменена на месте). `NEWEST_BLOCK_SQL` закреплён как поиск по индексу без `SCAN`: временное B-дерево сортировки осталось от правила половины. Счёт непринятых блоков использует текст, закреплённый задачей 1.
- Задача 6: тест «says whether a failed send…» переведён на поддельные таймеры, ждёт конца паузы.
- Задача 7: ХП уже научил хост принимать 0–64 блока, а станцию — слать пустой запрос, поэтому добавлено только `more`. `do…while` заменён списком частей. `.max(64)` в `knownBlocksRequestSchema` сохранён вопреки фрагменту плана. Ключа `confirmNoBlocks` нет (ХП переименовал его в `confirmNotReturned`), поэтому заменён только `blocksNote`.
- Задача 8: раздел 27 дописан после раздела 25 (раздела 26 / I1 в этой линии нет). Фрагменты памятки уже изменил ХП, поэтому они применены по смыслу. Пункт ХП об индексе не тронут. Добавлены честная цена условия `r` и памятка разработчику о `VersionMissing`.

## Evidence

- **Worktree**: `/tmp/claude/wt/rv-och`, detached at `96209f28b`. Build state was cloned from `integ`, and `cargo build --workspace --tests` exited 0. `git status --short` is empty at the end.
- **Focused Vitest**: 14 files (outbox-recovery, floor-queue-screen, retention, restore-reconcile, facts-sender, host-link-facts, floor-block-supply, floor-status-bar, floor-outbox-status, floor-schema, backups, floor-shift-list, floor-app, floor-outbox-recovery-migration). 518 passed.
- **Delayed-`setImmediate` stand** (config and setup outside the tree, `/tmp/claude/rv-och-stand`): 5 React/link files, twice, 261 passed each, 0 `stderr |`.
- **Cargo (sandboxed)**: `markiro-proto --test backup` 6 passed, `markiro-host --test known_blocks` 17 passed, `markiro-standalone --test local_db` 32 passed. The full workspace was not run, as instructed.
- **Benchmarks** (node:sqlite 3.53, migrations 0001–0013, `:memory:`): scripts in `/tmp/claude/rv-och-bench/` — `bench.mjs` (DUE ± `r`, ± partial index), `unfix.mjs` (receipt operator 5), `settled.mjs` (`QUEUE_SETTLED_SQL` at 10k/50k). Numbers are in m-1, m-2 and I-1.
- **Mutants** (`/tmp/claude/rv-och-mut/run.py`, logs `M*.log`; every file restored with sha256 equality):

  | Mutant    | Change                               | Result                                 |
  | --------- | ------------------------------------ | -------------------------------------- |
  | M1        | DISMISS without the close guard      | killed                                 |
  | M2        | MARK without `resolved_at`           | killed                                 |
  | M3        | REOPEN also reopens `resent`         | killed                                 |
  | M4        | DUE `r` drops the shift term         | killed                                 |
  | M5        | unmark also on `rejected`            | **survived** (equivalent, m-13)        |
  | M6        | `factsNow` guard removed             | killed                                 |
  | M7        | drop reason always `overlap`         | killed                                 |
  | M8        | inverted range not a mismatch        | killed                                 |
  | M9        | dismiss offered for a close          | killed                                 |
  | M10       | `last` at ≤ 2                        | killed                                 |
  | M11       | no empty part                        | killed                                 |
  | M12       | drops alert at > 1                   | killed                                 |
  | M13       | `onChanged` only while mounted       | killed                                 |
  | M14       | unfix `NOT EXISTS` on `conflict = 0` | killed                                 |
  | M16       | conflict notice always «dismissed»   | killed                                 |
  | M17       | MARK without `expectedChanges`       | killed                                 |
  | M18       | `DONE_WITH` `r` only `rejected`      | **survived** (m-6)                     |
  | H1 (Rust) | host marks even with `more`          | killed (2 tests; restored and touched) |

- **By reading**:
  - The only writers of the resolution columns: grep over `src`, `src-tauri/src`, `host/src`.
  - `local_db.rs`: single writer, `BEGIN IMMEDIATE`, WAL, two readers.
  - The forget path: count and clear in one transaction.
  - `shell.ts` `reject()`: immediate when `floorWork` is null.
  - `claude/wh` `host-link.ts` (`f96697d4f`): shared `factRetry`.
  - Runbook check 4, «Смены»: the mass `unknown_shift` scenario.
