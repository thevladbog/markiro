# plan СКЛ — final whole-part review (branch claude/wh, 2c726efba..74362fe17)

Scratch worktree: `/tmp/claude/wt/rv-skl` (detached at 74362fe17, build state cloned from integ; `apps/standalone/dist` cloned too, git-ignored). Tree left clean.

## Verdict

**Needs fixes (small wave) before the owner's beta.** No Critical. Identity correctness holds: a reprint never makes a new code, box, pallet or SSCC; the printed code is provably the looked-up one (host identity echo + `kmHash(km) === identity` + `sscc === identity`); lookups read one deferred-transaction snapshot; codes have one owner (`code_owners` PK) and box/pallet SSCCs are disjoint by extension digit (box_closed `names_serial(…, 0, …)`, pallets `GLOB '1*'`); disassembled → `disassembled`, released code → `released`, open box/pallet (no SSCC) → `not_found`, closed shift → found. Host record shapes are strict and match Zod key presence; idempotency by `(device_id, record_id)` + digest; migration 0015 additive and gap-tolerant; no raw code in logs. Station queue discipline is enforced by the screen (every action through `run` → `createWorkQueue` + `track`; mutant A killed). Two Important seams: the restore path does not give the host back the reprint trail, and the delivery shares the facts' retry slot.

## (a) Findings, most severe first

### Important

**I1 — A host restored from a copy loses the reprint trail for good.** `reconcileRestore` (`src/local/restore-reconcile.ts:150-155`, `REOPEN_SQL`) puts the facts acknowledged in the last 30 days back in `outbox` so the restored host gets every record it lost; `wh_outbox` is not reopened (no `wh_outbox` anywhere in `restore-reconcile.ts`). Scenario: host backed up at 10:00; reprints at 11:00 accepted (`acked_at` set); host dies, restored from the 10:00 copy; facts of 10:00–restore come back via the 30-day resend, the warehouse records never do, and `warehouse_reprints` permanently lacks them (the station purges them 30 days after the session finishes). This is the one place where «audit accuracy» of the reprint actually breaks, and AGENTS «Backups and restore» says nothing about it. Fix: in the same ONE reconcile transaction add `UPDATE wh_outbox SET outcome = NULL, outcome_code = NULL, acked_at = NULL WHERE host_id = ? AND device_id = ? AND outcome IS NOT NULL AND acked_at >= ?` (node 3.53 plan today: `SCAN wh_outbox` — a once-per-restore statement over ≤ ~30 days of small rows; pin it as a deliberate, commented exception in BOTH lists, or pin it via a `+`-free index if the integrator prefers); warehouse records already go only after facts, so the restored boxes/scans exist when they arrive (`subject_exists`). Test in `restore-reconcile`/`floor-schema` + AGENTS «Backups and restore» line + §30.

**I2 — The warehouse delivery shares the facts' retry slot (`factRetry`/`factsHeld`) — a merge seam with plan ОЧ.** `host-link.ts:438-456`: a non-shell failure of `/v1/device/warehouse/reprints` arms `factRetry` with `nextSyncRetryMs(warehouseFailures)` (2 s … 60 s). (a) Now: every local write (`requestFacts` → `factSender.trigger()` → `cancelFactRetry()`) re-runs the facts batch and then the failing warehouse batch at once, so the warehouse back-off is bypassed at the scan rate and `wh_outbox.attempts` inflates (same shape as the facts' pre-ОЧ m8). (b) After ОЧ merges its `factsNow` guard (`if (factRetry !== null) return;`, ОЧ plan line ~2807), a failing warehouse route's pause suppresses the immediate send of every new FACT for up to 60 s while the status bar says `facts_sent` — the reprint side channel delays production data, contradicting Р17 («ошибка отправки записей не трогает состояние фактов»). Fix: a timer of its own (`warehouseRetry`, cleared in `stopAll` and on link-down), the facts run skips the warehouse part while that timer runs, its end triggers `factSender`; keep `factsHeld` only for `restore_pending` (the host holds both routes). Tests: a failing warehouse route + `requestFacts()` sends the fact at once and does not resend the warehouse batch before its pause; and the same under ОЧ's guard when merged.

### Minor

- **m1 — Rejected records are never shown** (`outcome = 'rejected'`: invalid_record / payload_mismatch / subject_unknown). They keep their session forever and are never resent; the screen counts only unsent ones. Decision: **Minor, CARRY to ОЧ** («Очередь отправки»): rare (needs a station bug or a restore), nothing is lost on the station, documented honestly in AGENTS «Not done» and §30. Note I1's fix can add `subject_unknown` refusals after a restore, so ОЧ should include `wh_outbox`.
- **m2 — Station-only lookup gate is not tested for a handheld.** Mutant R2 (`!= Station` → `== Office`) SURVIVED `--test warehouse`: `only_a_station_looks_up…` pairs only an office device. A handheld key would get full KM codes. Add a handheld case (one line).
- **m3 — The historical dates are not pinned.** Mutant P (`productionDate` from the record's instant instead of the shift's) SURVIVED the work tests: every fixture has `productionDate` equal to `at`'s date; `expiry` is asserted nowhere for a reprint. Add a night-shift record (instant on the next UTC day) asserting `date` and `expiry` (`shelfLifeExpiryDate`).
- **m4 — Typed-code work is not proven queued/tracked.** Mutant X (`run(() => reprint(...))` → `void reprint(...)`) SURVIVED the three screen files. The code is right (the form can open only when nothing runs), but a test should hold a leave on a typed lookup.
- **m5 — Two new statements unpinned:** `countUnsentRecords` in `src/local/outbox.ts` (now sums `wh_outbox`) and the shell's `count_unsent` over `wh_outbox` (`local_db.rs`). Measured on node 3.53: both use `wh_outbox_unsent` (pairing form SEARCH, any-pairing form covering SCAN of the partial index) — correct, just not pinned in both lists.
- **m6 — `lookUp` does not check the answer's kind against the scan** (code → `unit`; SSCC → `box|pallet`). `sourceFields`' identity checks catch every realistic mismatch; a one-line kind check closes it fully.
- **m7 — Attribution of the automatic `unknown`/`interrupted` record:** `recoverWarehouseJob` writes it with the operator who opened the screen (or whose work failed), not the one who sent; `wh_jobs` keeps no per-attempt operator. DOC.
- **m8 — Pallet label counts mix eras:** `boxCount` is historical (`box_count_reported`), `itemCount` is the sum of the boxes not taken apart now (Р15, plan-mandated). DOC in AGENTS.
- **m9 — A session that is never finished (or one left under an old pairing) is never purged**, its jobs/records grow; retention only takes finished sessions. DOC/CARRY.
- **m10 — Doc imprecision:** AGENTS «Warehouse reprint» says the lookup takes «any live device» — it is station-only (`forbidden` otherwise; both routes); it says the full code «comes only in the answer's body» while the station keeps it in `wh_jobs.fields` (`km.code`) for verify/re-render (as the floor journal keeps `canonical`); §30 says sections «нумеруются заново при слиянии» — the allocation is fixed (§25–29 arrive from other streams).
- **m11 — «Reprint is no shift»:** a refused key, another host or a line change takes the floor at once; the promise of a send in flight still writes its outcome (a re-entered screen reads it via `isInFlight`/CAS), so nothing is resent or lost; only the UI is cut. Documented. CARRY (owner).
- **m12 — The `unsent_facts` texts say «записей смен»** also when only reprint records stop a forget. CARRY (text).

Checked and fine (no finding): host `receive` strictness (attempt ≤ 10000 u32, text 1–64 trimmed/no controls, `errorCode` `[a-z_]{1,64}` iff failed/unknown, `occurredAt` exact `toISOString`, keys `repair/errorCode/operatorId` present — parity test reads the Vitest table), one immediate write tx after the station re-check, refusals not stored, no audit row/revision; migration 0015 additive, `a_database_without_0013_and_0014…`; shell 0012 index order deviation (`session_id` first) is correct (the host-first order attracted the unsent count away from the partial index); gaps 0010/0011/0013 applied late by sqlx (shell test with 0009 removed); journal assertion follows `MIGRATOR` versions (`any(version == 12)`, compatible with ХП/ОЧ `any(… == 10/13)`); `TABLE_CLASSES` DeviceData; forget guard counts `wh_outbox` in open and unopened DBs; retention due-read cheap (`wh_sessions_finished` + `wh_outbox_session` per session) and keeps unsent/rejected; job row before send, `sending` → `unknown`, never auto-resent, 20 s limit by `PrintRuntime`; 400 ms guard on every screen/picker button, `setManualTextEntryActive` on the typed-code form and the picker search with real-wedge tests; offline notice persistent; client default 10 s request limit bounds a hung lookup; no `console.*`/`tracing` with values.

Audit-row question (asked): the cloud writes a `tenant_audit_events` row per reprint event. In the standalone `audit_log` has no reader (only restore bookkeeping reads `max(id)`), while `warehouse_reprints` is an append-only per-device trail with actor, device, subject, reason, outcome and both instants. Recommendation: **keep Р5 (no audit row)**; the audit hole that matters is I1 (trail lost on restore); the office history page stays «Перенесено».

## (b) TRIAGE

| Item (source)                                  | Decision | Reason                                                                  |
| ---------------------------------------------- | -------- | ----------------------------------------------------------------------- |
| T1: lookup `null` read as absent               | DROP     | station Zod is stricter; host pinned it                                 |
| T1/T2: record key presence                     | DROP     | done in T3 (`has_nullable_keys`, parity test)                           |
| T2: station-only stricter than brief           | DOC      | keep; fix AGENTS wording (m10), test handheld (m2)                      |
| T3: no audit row                               | DROP     | see recommendation above; I1 is the real gap                            |
| T3: host stricter shapes                       | DROP     | station records checked against them in T5 tests                        |
| T4: forget guard ignores wh_outbox             | DROP     | done in T6                                                              |
| T4: purge not wired                            | DROP     | done in T6 (hourly pass, both purges independent)                       |
| T4: index order deviation                      | DOC      | correct; record in «Отклонения»                                         |
| T5: operator vetted only at prepare            | DROP     | sign-out of a host-removed operator waits for work and leaves (T8 test) |
| T5: queue discipline documented only           | DROP     | enforced by `run`/queue (mutant A killed)                               |
| T5/T7/T8: ДРВ path absent                      | CARRY    | merge-time adaptation of `renderLabel` options                          |
| T6: rejected not visible                       | CARRY    | to ОЧ (m1)                                                              |
| T6: `unsent_facts` texts                       | CARRY    | m12                                                                     |
| T6: shared `factRetry`/`factsHeld`             | FIX      | I2                                                                      |
| T6: stale domain dist                          | DROP     | environment                                                             |
| T7: clock prop stability                       | DROP     | FloorApp passes none                                                    |
| T7: `write_failed` text if recovery also fails | DROP     | next opening reads `unknown`                                            |
| T8: no shift → no work gate for shell          | CARRY    | m11, owner                                                              |
| T8: `leaving` field unused (F3)                | DROP     | harmless, brief interface                                               |
| T8: restore.rs timing failure under load       | DROP     | not this plan; green alone                                              |
| addenda (T4 duties)                            | DROP     | all done                                                                |
| m3, m4, m5, m6                                 | FIX      | tests/pins/one-line check                                               |
| m7, m8, m9, m10                                | DOC      |                                                                         |

**Fix wave (4 commits):**

1. `fix(standalone): a host restored from a copy gets the warehouse reprint records back` — reopen `wh_outbox` in `reconcileRestore`'s one transaction; pins in `test/floor-schema.test.ts` and `src-tauri/tests/local_db.rs`; test; AGENTS «Backups and restore» + §30 (I1).
2. `fix(standalone): the warehouse delivery waits on a retry of its own` — `warehouseRetry` separate from `factRetry`; skip the warehouse part while it runs; `factsHeld` only for `restore_pending`; cleared in `stopAll`/link-down; tests incl. a local write during the pause (I2).
3. `test(standalone): warehouse reprint gaps` — handheld lookup refused (m2), night-shift dates/expiry (m3), typed code tracked by a leave (m4), pins for the two forget counts (m5), lookup kind vs scan check + test (m6).
4. `docs(standalone): warehouse reprint limits` — m7–m10 in AGENTS and §30; plan «Отклонения при исполнении».

Must-fix before the owner's beta: 1, 2 (at the latest together with ОЧ's merge), and the m10 wording; 3 recommended.

## (c) Отклонения при исполнении (для плана)

- Задача 2: маршрут поиска пускает только станцию (`403 forbidden` для офиса и ТСД), строже «любого устройства» плана: в ответе полный код единицы. Явный `null` в теле поиска хост читает как отсутствие поля.
- Задача 2: `SHIFT_SQL` сделан `pub` ради закрепления плана запроса; форма транзакции поиска (одна `begin`, один `rollback`) закреплена тестом по тексту исходника.
- Задача 3: запись тоже только от станции (`require_station_in` внутри пишущей транзакции вместо `require_live_in`); хост требует присутствия ключей `repair`, `errorCode`, `operatorId` (как Zod), проверяя JSON до чтения в тип; SQL проверок вынесены в `pub`-константы.
- Задача 4: индекс `wh_outbox_session` — `(session_id, host_id, device_id)` вместо `(host_id, device_id, session_id)`: при порядке плана планировщик брал его для счёта неотправленных вместо частичного `wh_outbox_unsent`; ожидания `PURGE_RECORDS_SQL` и `DUE_SESSIONS_SQL` в обоих списках уточнены.
- Задача 4: тест журнала оболочки сверяет версии самого `MIGRATOR`; добавлен тест применения пропущенной младшей миграции после `0012`.
- Задача 5: печать дополнительно отказывает (`incomplete_km`), если сохранённый код не даёт хеш найденной записи или SSCC не равен искомому; испорченный список категорий шаблона делает шаблон нечитаемым (не «все категории»); гонка за `wh_jobs_open` — отказ `busy`; предел попыток 10000 (как у хоста).
- Задача 6: при ошибке маршрута записей — свой счётчик и отсрочка (2 с … 60 с; `restore_pending` — время хоста), строка фактов не трогается; страж забывания считает и `wh_outbox`; почасовой проход запускает обе очистки независимо.
- Задача 7: защита 400 мс на каждой кнопке экрана и выбора шаблонов (`view-guard.ts`, необязательный `clock`); работа держит кнопки через `aria-disabled`; постоянное предупреждение «нет связи»; состояние задания словами; после сбоя записи экран перечитывает задание (`unknown`, без повтора).
- Задача 8: в тестах добавлено ожидание 450 мс после открытия экрана (защита 400 мс); список ручных проверок вставлен в «Verification» перед пунктом паллет ПЛ-Ц; в этой ветке спецификация кончается разделом 24, раздел 30 написан по распределению.
- Не сделано (перенесено в ОЧ): показ записей, отказанных хостом.
- Найдено итоговым ревью (волна правок): записи перепечатки не возвращаются на хост, восстановленный из копии; доставка записей делила с фактами слот повтора.

## Evidence

- Vitest (6 files: warehouse-work, -work-guards, -sender, -store, -store-guards, floor-schema): 162 passed (`/tmp/claude/rv-skl-vt1.log`).
- `cargo test -p markiro-host --test warehouse`: 34 passed (`/tmp/claude/rv-skl/cargo-wh.log`); `cargo test -p markiro-standalone --test local_db`: 35 passed (`/tmp/claude/rv-skl/cargo-ldb.log`).
- Own mutants (harness `/tmp/claude/rv-skl/mut.py`, `rmut.py`; every restore sha256-asserted, Rust file touched; logs `mut-*.log`, `rmut-*.log`): A screen work outside the queue KILLED; B session load outside the queue SURVIVED (equivalent: nothing else can run at mount); C retention keeps only unsent (purges rejected) KILLED; D receipt SQL without pairing filter SURVIVED (equivalent: global UUID ids; text pin kills); G pallet boxCount ← itemCount KILLED; H closedAt epoch SURVIVED (equivalent: `effectiveProductionIsoDate` prefers productionDate); X typed code outside run SURVIVED (m4); S `!1` stripped before the domain rule KILLED; P productionDate from instant SURVIVED (m3); V repair dropped KILLED; R1 digest of id only KILLED; R2 lookup gate lets handheld SURVIVED (m2); R3 operator uuid rule off KILLED; R6 key presence only `repair` KILLED.
- Query plans measured (node 3.53, scratch test deleted): forget counts use `wh_outbox_unsent`; the proposed reopen statement plans `SCAN wh_outbox`.
- I1 by reading: `restore-reconcile.ts` `REOPEN_SQL` touches `outbox` only; AGENTS «Backups and restore» lines ~4031-4034. I2 by reading `host-link.ts:413-456` and ОЧ plan's `factsNow` guard.
