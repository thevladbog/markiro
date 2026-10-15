# Plan ПЛ-Х: final whole-part review (host: pallets-lite)

Worktree `/tmp/claude/wt/plh`, branch `claude/plh-pallets`, HEAD `b8cef1e25`, base `1095d4af4`, 8 commits (Tasks 1–7). Reviewed against the plan (`docs/superpowers/plans/2026-10-10-standalone-pl-h-pallets-host.md`), `plh-constraints.md`, `plh-minors.md` 1–8, the per-task reviews T1–T4, the reports T5–T7, and the consumer plans ПЛ-Ц, ЧЗ, О-Ф, РК, IMP and УСТ.

## Verdict

**WITH FIXES.** Critical 0, Important 0, Minor 8.

The part works as one machine. The data model serves every consumer plan without a change to `0012`. The pallet lifecycle refuses where it should and is idempotent across all four fact kinds. SSCC integrity holds on both the box and the pallet paths. No secret or layout reaches the log. The protocol-3 change is consistent across `proto`, the fixtures, the Zod mirror and the shell probe. The merge into `claude/integration` is textually clean.

The final wave has three things to fix:

- the snapshot-size 500 (minors item 5);
- the foreign-key setting of the back-compat migration test (minors item 3);
- documents: ragged lines that remain, and stale "one layout" sentences (minors item 6, plus lines Task 7 reported as fixed but left).

## (a) Findings, most severe first

**m1 (minors item 5): FIX. Two layouts that together exceed `0009`'s snapshot CHECK make every entry a 500.**

- Where: `host/src/routes/device_shifts.rs:353-365`. The `UPDATE … snapshot = ?` binds `serde_json::to_string(&snapshot)` against `0009_shifts_sscc_blocks.sql:44-45` (`length(CAST(snapshot AS BLOB)) <= 327680`), while `validate::MAX_SPEC_BYTES` = 256 KB applies per template (`validate.rs:449`).
- Scenario: a box layout and a pallet layout that together exceed about 320 KB fail the CHECK. Every entry then answers `500 internal`. The transaction is dropped, so the shift stays planned and nothing is written, but neither the station nor the office learns why.
- Fix: exact specification under «Fix wave», commit 2/3.

**m2 (minors item 3): FIX (test only). The back-compat migration test runs `MIGRATOR` with foreign keys off; production runs it with them on.**

- Where: `host/tests/facts.rs:7203` opens the connection with `.foreign_keys(false)` and `:7297` runs `MIGRATOR.run(&mut old)`. Production opens with foreign keys on (`db.rs`).
- Fix: insert `sqlx::query("PRAGMA foreign_keys = ON").execute(&mut old).await.unwrap();` between `DETACH DATABASE source` (`:7257-7260`) and `MIGRATOR.run` (`:7297`). Keep the later `foreign_key_check` (`:7316-7328`), which then repeats the pragma harmlessly.
- `ALTER TABLE boxes ADD COLUMN pallet_id … REFERENCES … CHECK` with a NULL default is legal with enforcement on; the T2 reviewer probed this with sqlite3 3.44.
- Mutant to show it matters: none is needed. This aligns the test with production.

**m3 (minors item 6 plus new evidence): FIX (docs). Ragged lines remain, and Task 7's report overstates the rewrap.**

- Task 7 says the pallet paragraph was "re-wrapped to <= 78 columns". Measured over the plan's changed lines of `apps/standalone/AGENTS.md`, two lines are still long:
  - `:2423` (85 chars, "pallets never meet on one). It keeps the station's `openedAt`…");
  - `:2553` (91 chars, "`pallet_already_closed`), a resend, a mismatched resend, a station's close of a shift and a").
- The ragged wraps T3 m2 flagged also remain:
  - `host/src/routes/device_shifts.rs:161-163` ("…its number / ends in `/S`. The / same `requestId`…");
  - `AGENTS.md:2140-2142` ("…an / open one carries a / layout of up to 256 KB").
- Prettier is `proseWrap: preserve`, so it will not fix these. Rewrap by hand in the docs commit.

**m4: DOC now, CARRY to О-Х. An open pallet's `opened_at` is the `closedAt` of the first box that arrived, not of the earliest box.**

- Where: `facts/box_closed.rs:97-115` with `facts/pallets.rs:70-89`. `pallet_closed` later replaces `opened_at` with the station's own value (`pallet_closed.rs:85`).
- So the field is approximate only for a pallet that never closed and whose boxes arrived out of order, for example a box resent under a new id after a refusal.
- ЧЗ and О-Ф order pallets `BY opened_at, id`, and both suppress open pallets from documents, so only the display order of open pallets can differ from the station's.
- Fix: a sentence in AGENTS «Pallets» ("for a pallet that never closed, `opened_at` is the first box the host received"). О-Х should use `MIN(boxes.closed_at)` if it needs the exact value. No host change.

**m5: merge note, CARRY to the merge order. Between the ПЛ-Х merge and the ПЛ-Ц merge, the integration webview announces protocol 3 without knowing pallets.**

- After the merge, `src/host/protocol.ts` says 3. But the 2a5 station's `deviceShiftSchema` and `shiftSnapshotSchema` (non-strict `z.object`) strip `palletBoxCapacity`, `palletTemplateId` and `palletTemplate`. So a merged station would enter a pallet shift and close boxes with no `palletId`. That is the minors item 4 gap, now inside the "protocol 3" label.
- Today nothing can plan such a shift from the UI: `requests.ts` `shiftCreate`/`shiftUpdate` and the 2a5 `new-shift.ts` send no pallet fields. So the gap is latent.
- Rule for the controller: do not cut a pilot build from `claude/integration` after ПЛ-Х and before ПЛ-Ц and О-Ф are merged. No code change.

**m6 (minors item 8): CARRY to ЧЗ, О-Ф and О-Х. A late box on a closed pallet joins silently.**

- It is documented truthfully in AGENTS (`:2444-2452`) and spec §18 «Известное свойство».
- ЧЗ's dialog warnings (its plan, line 7109) do not include it, and neither do О-Ф's forms. Both dispatches must add "flag a member whose `closed_at` is after its pallet's `closed_at`".

**m7 (minors item 4): DOC done, CARRY to УСТ.**

- Done: the operational rule "every station of the pilot runs protocol 3, installed together with the host" is in AGENTS `:944-954` and spec §18 (last bullet). Both are true to the code: `ClientProtocol` is read only in `routes/pairing.rs:30,131`.
- Not done: the УСТ plan (`2026-10-09-standalone-ust-installer.md`) has no step or manual-list item for it (grep: none).
- Carry: add to УСТ Task 7's manual list "after a host update, reinstall every station and office PC of the site with the same installer; check the version on each".
- A protocol-2 reader does not crash. Rust `DeviceShift`/`ShiftSnapshot` have no `deny_unknown_fields`, and the 2a5 Zod objects strip unknown keys (checked in the merged tree).

**m8 (minors item 2): DROP.** The `+0` in Vitest titles (`test/fact-rules.test.ts`) is cosmetic and misleads nobody.

**Closed, verified in the code:**

- **Minors item 1:** `pallet_closed.rs:34` checks the 18-digit shape before `names_serial` at `:62`, with the test `a_pallet_sscc_that_is_not_eighteen_digits_is_refused_whatever_its_first_seventeen_say` and the T4 review's mutants X11/X12.
- **Minors item 7:** `no_secrets_in_logs.rs:1823` asserts `facts_files == 17`. That is 14 `facts/*` files plus 3 route files, and the walk is dynamic over `src/`.

### What I checked, by seam

**1. Data model (`0012`) against its consumers.** ЧЗ (`export-source` and `office_boxes` SQL), О-Ф (`PALLETS_SQL`, `PALLET_BOXES_SQL`) and ПЛ-Ц need these `pallets` columns: `id`, `device_id`, `sscc`, `opened_at`, `closed_at`, `disassembled_at`, `box_count_reported`, `print_verified_at` and `print_skipped_at`. All are present.

- The closing operator is `operator_id`, and the disassembly operator is `pallet_exceptions.operator_id`.
- Label evidence works as for boxes (`print_*`). A reprint is a `pallet_exceptions` row.
- `pallets_shift` and `boxes_pallet` serve the totals (EXPLAIN pinned by the lib test). `pallet_exceptions` has no `shift_id` index. That matches `box_exceptions` in `0010`, and О-Х can add one in its own migration, so `0012` does not need to change.
- РК backs up the whole database. Its `known_blocks` is generic by extension, and it already raises the `(prefix, 1)` counter (РК plan, lines 5846-5858).
- IMP migrates no pallets, only the counter window П6.
- Migration numbers: `0011_backups` (РК) and `0012_pallets` (ПЛ-Х). No plan claims `0013`.
- sqlx applies a lower unapplied version after a higher one. `0011` and `0012` touch disjoint objects, and the back-compat test copies `< "0012"`, so it picks up `0011` once РК merges.

**2. Lifecycle walked end to end:**

- plan and edit (office; triggers; `template_in_use` for both slots);
- create and enter (station; the box template check, then `pallet_template_not_fit`; audit `palletTemplateId`/`Rev`);
- pallet block issue (extension 1, `pallet_block_size`, repeat with another extension refused, `sscc_exhausted`);
- `box_closed` with `palletId`: `no_pallets`, `pallet_unknown` across device and shift, the first box opens the pallet, the pallet's state never refuses a box, replay on another pallet or with no pallet is `box_already_closed`;
- `pallet_closed`: same SSCC accepted with no write even after its block is revoked, another SSCC `pallet_already_closed`, opens closed when no box arrived;
- `pallet_label`: open pallet `pallet_state`, unknown pallet `pallet_unknown`, a disassembled pallet accepted;
- `pallet_exception`: open or disassembled pallet `pallet_state`; a disassembly sets only `disassembled_at`, so boxes keep `pallet_id`, the registry is untouched and the SSCC can never be reused (`sscc_taken`, test at `pallet_facts.rs:2326ff`);
- totals;
- a shift closed with an open pallet: nothing is refused. A late `pallet_closed` marks `late_data_at` through the generic `mark_late` (test `:1753`).

Every refusal precedes the first write in all four handlers. A batch is written whole or not at all, and the tests pin the rollback.

**3. SSCC integrity:**

- separate `(prefix, extension)` counters;
- `names_serial` with an extension, built from the domain's `buildSscc` through `sscc-serials.json`, which both `host/tests/fact_rules.rs:76` and `test/fact-rules.test.ts:57,74` read;
- an 18-digit shape check on both paths;
- duplicate checks global within each kind, backed by unique indexes;
- the box and pallet namespaces are disjoint (extension `0` versus `1`, plus `CHECK (sscc GLOB '1*')`);
- `blocks::issued` checks the device, prefix, extension, range and `revoked_at`;
- `consume` only grows.

**4. Trust domains.** No new route was added.

- Block issue: station only, with `require_station_in` inside the write transaction.
- Facts need a shift the device entered, and only stations enter, so a handheld cannot send pallet facts.
- Office planning: `require_shift_planning` plus `_in`.
- The audit rows are asserted exactly (for example `office_shifts.rs:2637-2650`).
- `tracing` appears in none of `routes/{sscc_blocks,device_shifts,office_shifts}.rs` or `shifts.rs`.
- Task 7's log pass includes a pallet close, a label check, a reprint with words and a refused second close. Its mutants are M1–M6 in the T7 report.

**5. Protocol 3.**

- `MIN_PROTOCOL_VERSION` is still 1.
- `hello`, `hello-future` (4/3), `error-with-details` and `server.rs` tests all agree, and `host_probe` classifies a protocol-2 host as `HostTooOld`.
- `closedPallets`/`openPallets` are required in both Rust and Zod. That is safe because a protocol-3 office refuses a protocol-2 host at the probe, and an old office strips the unknown fields.
- The counts match what ЧЗ expects (`closedAt !== null && disassembledAt === null`, ЧЗ plan line 7473).

**6. Snapshot size:** see m1 and the fix specification below.

**7. Tests:**

- `cargo test --workspace -- --list` gives 807 tests, which confirms the ledger.
- Per-suite counts measured: `pallet_facts` 29, `office_shifts` 34, `device_shifts` 23, `sscc_blocks` 19, `fact_rules` 13, `facts` 57, `proto` fixtures 47.
- No sleep is used as synchronisation. The 200 ms `timeout` at `pallet_facts.rs:702` is a negative "still waiting" check followed by the real assertion, the 2a2 pattern, and it cannot flake.
- The titles I sampled match their bodies.
- Vitest 2280 was not re-run.

**My mutants:** 8 one-line mutants, all killed. Each file was copied to `/tmp/claude/rev-plh-final/N*.bak`, then restored, `cmp`-checked, sha256-checked and touched. Logs are in `/tmp/claude/rev-plh-final/N*.log`.

| id  | mutant                                                             | killed by                                                                                                                       |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| N1  | `office_shifts.rs` open pallets: `b.disassembled_at IS NULL` → `1` | `pallet_facts::the_office_reads_a_shifts_pallets_from_its_facts`                                                                |
| N2  | `pallet_exception.rs` drops the `disassembled_at.is_some()` guard  | 3 tests (`a_reprint_changes_nothing_…`, `a_pallet_reprint_or_disassembly_needs_…`, `a_pallet_label_or_exception_comes_again_…`) |
| N3  | `box_closed.rs` replay ignores `pallet_id`                         | `a_box_closed_again_on_another_pallet_is_refused`                                                                               |
| N4  | `templates.rs` delete ignores `pallet_template_id`                 | `office_shifts::a_pallet_template_a_planned_shift_names_is_not_deleted`                                                         |
| N5  | `shifts.rs` snapshot drops the pallet fit refusal                  | 3 `device_shifts` tests (`…no_longer_fits_keeps_the_shift_planned` etc.)                                                        |
| N6  | `sscc_blocks.rs` repeat ignores the extension                      | `sscc_blocks::a_repeated_request_id_with_another_extension_is_refused`                                                          |
| N7  | `office_shifts.rs` `fixed_changed` ignores the pallet template     | `office_shifts::an_active_shift_keeps_its_pallets`                                                                              |
| N8  | `0012` update trigger drops the template half                      | `office_shifts::the_schema_keeps_a_shifts_pallet_fields_together`                                                               |

**8. Documents.** I checked every new AGENTS sentence and every bullet of spec §18 against the code. They are true, with three exceptions:

- the snapshot sentences (m1): `device_shifts.rs:6-7`, AGENTS `:2140-2142` "a layout of up to 256 KB", and AGENTS `:2175-2176` "at most 320 KB";
- the ragged lines (m3);
- one point that is incomplete rather than wrong: §18 «Снимок» says nothing about size.

Spec §18 is the only "Уточнения" section in the pilot spec, and §18 is free on integration.

**9. Scope and process:**

- Only `apps/standalone/**` and the pilot spec changed. Manifests, `Cargo.lock`, `package.json`, the lockfile, `apps/station` and `packages/*` are untouched.
- Each commit has exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `git diff --check` is clean, there is no `\u04`, and `cargo fmt --check` is clean.
- **Prettier gate:** run from the worktree root with repo-relative paths on all 16 changed md/ts/json files. Result: "Checking formatting… All matched files use Prettier code style!". A deliberately mis-formatted probe file failed the same command, so the gate is live, and the probe was removed afterwards.
- Task 7's own run used absolute paths, so its "clean" was not evidence. The real result is clean.

## (b) Triage of `plh-minors.md`

| #      | item                                              | decision                             | reason                                                                                              |
| ------ | ------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 1      | `names_serial` reads 17 bytes; pallet shape check | DROP (closed)                        | Done in Task 4: shape check before `names_serial`, test and mutants verified                        |
| 2      | `+0` in Vitest titles                             | DROP                                 | Cosmetic                                                                                            |
| 3      | back-compat test FK off                           | **FIX**                              | One line, test-only; aligns the proof with production                                               |
| 4      | protocol-2 station on a pallet shift              | DOC (done) + CARRY УСТ               | Documented truthfully in AGENTS and spec §18; УСТ has no manual check yet                           |
| 5      | snapshot > 320 KB → 500 at entry                  | **FIX**                              | Clean 409 at entry, spec below                                                                      |
| 6      | AGENTS ragged line                                | **FIX**                              | Still 2 long lines (2423, 2553) plus the T3 m2 wraps (`device_shifts.rs:161-163`, AGENTS 2140-2142) |
| 7      | `facts_files` 17                                  | DROP (closed)                        | Done in Task 5, verified                                                                            |
| 8      | late box on a closed pallet                       | CARRY ЧЗ, О-Ф, О-Х                   | Documented; consumers must flag it                                                                  |
| new m4 | open pallet `opened_at` = first arrived box       | DOC (in the docs commit) + CARRY О-Х | Display order only                                                                                  |
| new m5 | interim protocol 3 without pallets on integration | merge note                           | No code; release ordering                                                                           |

### Fix wave: one fixer, four commits (tests and production code separate)

1. **`test(standalone): the old database migrates with foreign keys on, as the host opens it`**: `host/tests/facts.rs`, item 3 above.

2. **`test(standalone): two layouts too large together keep the shift planned` (RED).** Files: `host/tests/device_shifts.rs`, `proto/fixtures/error-snapshot-too-large.json`, `proto/tests/fixtures.rs`, `test/protocol.test.ts`.
   - New test `two_layouts_too_large_together_keep_the_shift_planned`:
     - set up a box template and a pallet template, each with a layout of about 170 KB (≤ `MAX_SPEC_BYTES`; one long text element), so the compact snapshot exceeds 327 680;
     - plan a pallet shift; the station enters;
     - expect 409 `conflict` with `details.constraint = "snapshot_too_large"`;
     - expect the shift still `planned`, `snapshot` NULL, no owner, no `shift_participants` row, host revision unchanged, no `shift.open` audit row;
     - then the office points the shift at a small pallet template (`PUT … palletTemplateId`), and the entry answers 200 with `snapshot.palletTemplate` set.
   - Optional ordering case: an unfit pallet template that is also oversized answers `pallet_template_not_fit` first.
   - Fixture `error-snapshot-too-large.json`: `{ "error": { "code": "conflict", "message": "the shift's label layouts together are too large to open it", "details": { "constraint": "snapshot_too_large" } } }`.
   - Round-trip it in `proto/tests/fixtures.rs` like `error-shift-busy.json` (`:867-873`, asserting `codes::CONFLICT` and the constraint).
   - Add a row `["error-snapshot-too-large.json", errorBodySchema]` to the fixture table in `test/protocol.test.ts` (next to `:254`).
   - **`error-codes.json` does not change.** It lists top-level codes only. A constraint is `details.constraint`, as with `shift_busy`, `template_not_fit` and `pallet_template_not_fit`.
   - The shell needs no mirror: `device.rs` maps top-level codes only.

3. **`fix(standalone): an entry whose snapshot would exceed 320 KB is a clean conflict`.** Files: `host/src/shifts.rs`, `host/src/routes/device_shifts.rs`.
   - In `shifts.rs`:
     - `pub const MAX_SNAPSHOT_BYTES: usize = 327_680;`, with a doc comment naming `0009`'s CHECK;
     - `pub fn snapshot_too_large() -> ApiError` returning `ApiError::conflict("snapshot_too_large", …)`;
     - `pub fn snapshot_text(snapshot: &ShiftSnapshot) -> Result<String, ApiError>`, which serializes the snapshot and refuses when `text.len() > MAX_SNAPSHOT_BYTES`. The byte length of a Rust `String` equals SQLite's `length(CAST(… AS BLOB))` for the bound text.
   - In `enter_shift`, call `let text = shifts::snapshot_text(&snapshot)?;` after the `None => shifts::snapshot(…)` branch and before `next_revision`, then `.bind(text)` in the `UPDATE`.
     - This runs after the product, box template and pallet template checks.
     - It runs at entry time, not at plan time, because templates change after planning and planned shifts already exist.
   - Lib unit tests in `shifts.rs`:
     - the boundary of a helper `check_snapshot_len(len)` at 327 680 (OK) and 327 681 (refused);
     - a tie test: `include_str!("../migrations/0009_shifts_sscc_blocks.sql")` contains `<= 327680` and equals `MAX_SNAPSHOT_BYTES`.
   - Mutants:
     - drop the check: commit 2's test gets 500;
     - `>` → `>=`: the boundary unit test fails;
     - bind the old `to_string` and skip the helper: commit 2's test fails.
   - Also rewrap the doc comment at `device_shifts.rs:161-163` and change the module doc `:6-7` to "an open one carries up to two layouts, the snapshot at most 320 KB".

4. **`docs(standalone): …`.** Files: `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`.
   - AGENTS `:2140-2142`: "an open one carries up to two layouts (a box's and, with pallets, a pallet's)", rewrapped.
   - AGENTS `:2175-2176`: "The snapshot is at most 320 KB (a `CHECK` of `0009`, `shifts::MAX_SNAPSHOT_BYTES`): a box and a pallet layout that together exceed it keep the shift planned (`conflict` on `snapshot_too_large`, checked at the entry after the templates)".
   - Rewrap `:2423` and `:2553`.
   - The m4 sentence in «Pallets».
   - Spec §18 «Снимок»: «Снимок, который с двумя макетами превысил бы 320 КБ (CHECK `0009`), не открывает смену: `conflict` с `constraint: snapshot_too_large`, проверка при входе после шаблонов».
   - Gates: the prettier gate as above, `git diff --check`, `cargo fmt --check`, the focused `--test device_shifts`, `--test facts`, `-p markiro-proto` and `--lib shifts`, `vitest run test/protocol.test.ts`.

## (c) ОТКЛОНЕНИЯ ПРИ ИСПОЛНЕНИИ (черновик для «Отклонения при исполнении»)

- **Счёт тестов.** План: cargo 47 наборов и 616 тестов, Vitest 78 файлов и 2123 теста. Измерено на `b8cef1e25` (база — `claude/integration` `1095d4af4`, где 2a2 и 2a3 влиты с финальными волнами): cargo 807 тестов (`--list`), 53 строки результата (из них 3 пустых doc-набора); Vitest 81 файл и 2280 тестов. По наборам: `pallet_facts` 29, `office_shifts` 34, `device_shifts` 23, `sscc_blocks` 19, `fact_rules` 13, `facts` 57, фикстуры `proto` 47. Приращения больше плановых: исполнители добавили тесты сверх брифов.
- **Итоги — восемь полей, а не семь.** На базе `ShiftTotals` уже несёт `unitsInClosedBoxes` (финальная волна 2a2), поэтому литералы итогов в тестах шестипольные плюс два поля паллет. `closedPallets` и `openPallets` получили в Zod `.nonnegative()` сверх `.int()` брифа: это зеркало `u32` и соседних счётчиков, закреплено тестами с `-1`.
- **`facts_files` = 17 поднят в задаче 5, а не в задаче 7** (дополнение к брифу задачи 5, minors 7). Задаче 7 осталось подтвердить это число.
- **Проход журнала (задача 7) применён по смыслу.** Фрагменты брифа на дереве не нашлись (проход — 2a2-шный). SSCC паллет берутся из настоящего `fromSerial` блока (`pallet_sscc`). Добавлена запись `pallet_exception` (reprint со словами), чтобы проход действительно посылал каждый вид. Неизвестный вид `pallet_closed` переименован в `pallet_dispatched`: `pallet_closed` теперь настоящий вид.
- **Спецификация §18 исправлена против текста брифа.** Фраза «прежние фикстуры не менялись» уточнена: изменены `hello`, `hello-future`, `error-with-details`, `fact-receipt-codes`, `office-shift`, добавлена `sscc-serials`. Фраза «облако тоже сверяет паллеты только по коробам» не включена: её не проверили по `apps/api`. Добавлены «что хранится как сказано», «поздний короб закрытой паллеты», «повтор закрытия и отозванный блок» и правило установки протокола 3 (minors 4).
- **Проверка формы SSCC паллеты (18 цифр) стоит до `names_serial`** (minors 1). `names_serial` читает только первые 17 символов.
- **Финальная волна** (впишет исполнитель): чистый `409 conflict` `snapshot_too_large` при входе (minors 5, `shifts::MAX_SNAPSHOT_BYTES`, фикстура `error-snapshot-too-large.json`; `error-codes.json` не меняется, потому что это `details.constraint`); `PRAGMA foreign_keys = ON` перед миграцией в тесте обратной совместимости (minors 3); перенос строк в `AGENTS.md` и `device_shifts.rs` (minors 6).

## (d) Not verified

- CI.
- Windows.
- A live station or printer.
- Any webview rendering.
- The full Vitest count (2280) and the full workspace run. I did not re-run them because of load. The test list (807) was compiled and listed, and only the four focused binaries were run under mutants.
- The unsandboxed `no_secrets_in_logs` run (I relied on the T7 evidence).
- The behaviour of a real protocol-2 station against a pallet shift.
- The real-volume performance of the totals beyond the EXPLAIN test.

## (e) What the next plans must know

- **ПЛ-Ц:**
  - add `snapshot_too_large` to `EntryRefusal` with its own words in `ru.json`, next to `pallet_template_not_fit`;
  - the test helpers `open_pallet_floor` and `issue_pallet_block` exist (`host/tests/support/app.rs:561,759`), and the first pallet block is 40–239;
  - after 2a6 is merged, append the four pallet codes to `FACT_RECEIPT_CODES` (Task 1);
  - pilot spec §19 is free (ПЛ-Х took §18).
- **ЧЗ:**
  - its plan also claims pilot §19, so it must take §20 if ПЛ-Ц lands first, and О-Ф already plans §21;
  - flag late boxes (minors 8);
  - Ч1 (a disassembled pallet stays a pallet in exports) contradicts the ПЛ-Х plan contract, though no sentence in the tree states the contrary; ЧЗ records it.
- **О-Ф:**
  - flag late boxes (minors 8);
  - `boxCountReported` is evidence only;
  - an open pallet's `opened_at` is approximate (m4);
  - optionally, the shift list's `openBlocker` can warn about `snapshot_too_large` and `pallet_template_not_fit`.
- **О-Х:**
  - derive composition from `boxes.pallet_id` (closed, not disassembled), compare with `box_count_reported`, flag late boxes;
  - add an index on `pallet_exceptions(shift_id)` in its own migration if it reads by shift.
- **РК:** `known_blocks` must receive pallet blocks (extension 1) from stations too. The plan is generic, so the station side (ОЧ/ПЛ-Ц) must send them. Numbering `0011` before `0012` is fine.
- **IMP:** nothing beyond the П6 pallet counter window.
- **УСТ:** add the manual check "every station and office PC of a site runs the same installer version (protocol 3) after a host update" (minors 4).

## (f) Merge checklist into `claude/integration` (`84c056f80`)

1. Land the fix wave on `claude/plh-pallets` first.
2. `git merge-tree --write-tree HEAD 84c056f80` is clean (tree `538a684ce`; it touches no file 2a5 changed except `AGENTS.md`, `protocol.ts` and `protocol.test.ts`, which auto-merge). Re-run it after the fix wave.
3. Semantic checks on the merged tree:
   - no 2a5 totals literal lacks the pallet fields (`shift-totals.test.tsx` and `shifts-page.test.tsx` spread `ACTIVE.totals`; `api.test.ts` uses `toMatchObject`);
   - the 2a5 station schemas are non-strict, so they tolerate the pallet fields;
   - no `protocol 2` literal remains outside the deliberate `host_probe` test and the AGENTS rule sentence.
4. Spec numbering: no conflict. The pilot spec has no §18 on integration. The 2a spec's §18 (2a6) is another file.
5. After the merge:
   - build the dependencies (`turbo run build --filter='@markiro/standalone^...'`) and the webview;
   - run unsandboxed `cargo test --workspace --offline --locked`;
   - run the full Vitest, typecheck, lint, the prettier gate (from the root, relative paths), `cargo fmt --check` and `git diff --check`;
   - expect the 2a5 suites plus this part's 807/2280 baselines to add up.
6. Do not cut a pilot build from integration between ПЛ-Х and ПЛ-Ц plus О-Ф (m5).
7. When 2a6 merges: append the four pallet codes to `FACT_RECEIPT_CODES` (or let ПЛ-Ц Task 1 do it).
8. Run `graphify update .` where a graph exists.
