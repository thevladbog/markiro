# Plan 2a1 — final whole-part review (range 5ea7da950..366e87f06)

**Verdict: WITH FIXES.** Critical 0, Important 1, Minor 4 (new or re-decided findings; the 24 queued minors are triaged in (b)).

The host part works as one machine. The lifecycle (plan → list → create on station → enter with frozen snapshot → edit → close → re-entry refused → delete of planned only) is coherent and serialized. Every write route runs under `BEGIN IMMEDIATE` and re-reads inside it. The number counter and the SSCC counter move inside the same transaction as their rows. Migration `0009` is additive, and `0001`–`0008` are byte-identical to git history. Protocol 2 is consistent across proto, host, shell probe and the webview mirror.

The one Important gap is the recurring defect class: no test notices when four of the six shift writers stop waking the streams. That wake is the only way a station learns of a new, edited or deleted shift. Nothing in `0009` or the protocol has to change for 2a2–2a8.

---

## (a) Findings, most severe first

### Important 1 — the stream wake of four shift writers is unpinned (mutants survive)

- **Where:** `host/src/routes/office_shifts.rs:253` (create), `:398` (update), `:443` (delete) and `host/src/routes/device_shifts.rs:239` (station create), each `commit_with_revision(tx, &state.revisions, rev)`.
- **Mutant (my run):** on all four lines, `rev` → `0`. `send_if_modified` skips any rev ≤ the latest, so no stream wakes. Result: `--test office_shifts` 21/21 and `--test device_shifts` 15/15 green.
- **Scope:**
  - Only the open (`device_shifts.rs:548-581`, after the Task 5 fix) and the office close (`office_shifts.rs:1381-1395`, Task 6) assert a wake.
  - The Task 6 reviewer found the update case and wrote it in the review's notes («Outside this diff…»). It never reached `2a1-minors.md`.
- **Failure scenario:**
  - A station reads its shifts only «after it subscribes to the link and after every revision event» (module doc, AGENTS «Shifts»). It never polls.
  - With a dropped wake, a shift the office deletes stays on the line's stations and can be tapped. The station then gets `not_found` on enter, but only by chance, at its next revision.
  - Likewise, a newly planned shift does not appear, and an edited template, date or capacity shows stale values until some unrelated write. An AGENTS sentence promises this behaviour («the delete takes a revision … so stations drop it from their lists»).
- **Fix (tests only):** follow the pattern of `office_shifts.rs:1381`.
  - Subscribe to `admin.app.state.revisions` before each of the four writes. After the write, assert `has_changed()` and `*borrow_and_update() == <the write's rev>`.
  - For create and update, the rev is in the answer's `rev`. For delete, use `host_revision` before + 1.
  - Show each of the four `rev → 0` mutants failing.

### Minor 1 — repeated SSCC `requestId` with another prefix hands out the old prefix's block (queued 17/20, re-decided: FIX)

- **Where:** `host/src/routes/sscc_blocks.rs:96-99`. The block is looked up by `(device_id, request_id)` before any body check.
- **Why fix rather than carry:**
  - Spec §5.7.4 already stores `issuer_prefix` with the pending request (`floor_block_requests`), so a correct station repeats the same body and never sees a mismatch. A mismatch therefore means a station bug.
  - In that case the host silently answers serials reserved under another prefix. A station that files them under the prefix it asked for prints SSCCs that were never reserved: duplicate physical identifiers.
  - The spec's own idempotency rule for facts refuses the same id with other content (`payload_mismatch`, §4.5/§6). The block route should follow it.
  - Shift create keeps «whatever the body says» (harmless there: the station reads the shift from the answer).
- **Fix:** if the stored block's `issuer_prefix` (or `extension`) differs from the request, return `validation_failed` on `requestId` and write nothing. `extension` is always 0 today, so only the prefix branch is reachable.
  - Test: create a second counter by changing the GLN, or seed one directly. Then:
    - the same `requestId` with the other prefix → 400 `requestId`, with counters, blocks, audit and revision unchanged;
    - the same body → the same block.
  - Update `a_repeated_request_answers_its_own_block_after_others_were_issued` if it pins the old answer. Update the AGENTS «Shifts» SSCC paragraph and record a deviation.

### Minor 2 — no in-transaction device re-check in `create_device_shift` / `enter_shift` (queued 15/21: FIX yes)

- **Where:** `device_shifts.rs:171` and `:274`. Both read the device's line after `begin_write`, but not `revoked_at`. `sscc_blocks.rs:54-75` (`require_station_in`) does.
- **Concrete scenario:**
  1. Station S's enter passes the extractor, whose `last_seen_at` UPDATE autocommits, then waits for the write lock.
  2. Meanwhile the office revokes S. `revoke_device` does not touch shifts.
  3. S's enter proceeds: the shift becomes `active` with `owner_device_id = S` (revoked), and a `shift.open` row is written with a revoked actor.
  4. Every other station of the line now gets `shift_busy` until the office closes the shift with a reason.
  - With the re-check, S gets 401 and the shift stays planned for a colleague.
  - The create case only leaves a stray planned shift, which can be deleted.
- **Severity:** Minor. The window is narrow, and the outcome equals revoking a station right after it entered. But the fix is cheap and keeps factory continuity in the race.
- **Fix:**
  - Move `require_station_in` to one shared place (`auth.rs`, beside `AuthDevice`, with the refusal text as a parameter or a neutral text) and call it first after `begin_write` in all three routes.
  - Tests use a forged `AuthDevice` of a revoked station, as `sscc_blocks.rs:554` does:
    - enter → 401 `credential: device`, with the shift still planned, no participant, no audit row and no revision;
    - create → 401, with no shift and no counter row.
  - Show that dropping each call fails.

### Minor 3 — status CHECKs of `0009` are weaker than the lifecycle (queued 3: FIX, now and only now)

- **Where:** `0009_shifts_sscc_blocks.sql:57-59`. A non-planned row needs only one of `snapshot`, `opened_at`, `owner_device_id`. A closed row may lack `closed_by`. A non-closed row may carry `closed_by`.
- **Evidence that tightening is safe:**
  - The cloud closes only from `active` (`apps/api/src/modules/shifts/shifts.service.ts:1534`).
  - Every writer in the range writes all fields: open `device_shifts.rs:336`, close `office_shifts.rs:474`.
  - The 2a2 station close (`closed_by_kind = device`, `closed_by`, `closed_at`) fits.
  - Every test helper that writes rows directly already writes complete rows: `office_shifts.rs:48-77`, `device_shifts.rs:69-108, 729, 1169`.
  - No test pins migration checksums.
- **Why now:** `0009` is unreleased, and this wave is the last chance to change it. From the next plan on, `0009` is «applied» by the plan rules, and a SQLite CHECK changes only by rebuilding the table.
- **Proposed text:**

  ```sql
  CHECK (CASE WHEN status = 'planned'
    THEN snapshot IS NULL AND opened_at IS NULL AND owner_device_id IS NULL
    ELSE snapshot IS NOT NULL AND opened_at IS NOT NULL AND owner_device_id IS NOT NULL END),
  CHECK (CASE WHEN status = 'closed'
    THEN closed_at IS NOT NULL AND closed_by_kind IS NOT NULL AND closed_by IS NOT NULL
    ELSE closed_at IS NULL AND closed_by_kind IS NULL AND closed_by IS NULL END)
  ```

  Keep `close_reason_*` and `late_data_at` unconstrained: 2a2 decides them.

- **Caveat:**
  - Any local host data directory that already applied the current `0009` will refuse to start (sqlx checksum). Only scratch DBs should exist; say so in the commit.
  - Tell the 2a2/2a3/2a4 planners, who are working now, that the CHECK text changed in case a plan quotes it.
- **Test:** direct UPDATEs that break each arm fail with a CHECK error: active without owner, closed without `closed_by`, active with `closed_by`. Show that the reverted CHECK lets them through.

### Minor 4 — AGENTS «Shifts» does not name four of the six audit actions

- **Where:** `apps/standalone/AGENTS.md`, «Shifts». It names `shift.open` and `shift.close` (`{ reason }`), but not `shift.create` (office user or station, `{ number, productId, lineId, productionDate }`), `shift.update` (`update_details` of the six fields), `shift.delete` (`{ number }`) or `sscc.block.issue` (station, target `sscc_block`, `{ issuerPrefix, extension, fromSerial, toSerial }`).
- **Also missing:** the «Audit» section says nothing about device-actor rows. A station's repeated create or block request writes no row; the «Shifts» section says so for create only.
- **Fix:** add one sentence listing the six actions with their actors and details, as in the plan's audit table. Documentation only.

### Process notes (not findings)

- The controller's triage leaning names «2 (status CHECKs)». In `2a1-minors.md` the status CHECKs are item **3**; item 2 is the zero/negative-sequence note. I triaged by the file's numbering.
- `2a1-minors.md` misses the update-wake observation of the Task 6 review (now Important 1).

### What I checked, by seam

1. **Lifecycle:** I walked every transition and refusal in code and tests.
   - Refusal orders: enter is `not_found` → `shift_status` → `shift_line` → `shift_busy` → `product_inactive` → `template_not_fit`. Close is 400 → 404 → `stale_revision` → `shift_status`.
   - An active shift's fixed fields are frozen: `fixed_changed` covers line, date, template, capacity and counterparty. `plannedQty` stays editable.
   - Delete works on planned shifts only. A planned shift has no participants, so the FK without ON DELETE is safe.
   - Template delete is refused while a planned shift names it. Products, lines, counterparties and devices are never deleted: only templates are, by grep.
   - **What later plans need:** `boxLabelFields` (spec §5.7.5) is fully served.
     - From the snapshot: GTIN, name, printName, shelfLifeDays, counterpartyName, layout and rev, issuerPrefix.
     - From `DeviceShift`, frozen once active: number, productionDate, boxCapacity.
     - From the station: operator, SSCC, closedAt.
   - The shift row already holds `late_data_at`, `close_reason_code`, `closed_by_kind = device` and `shift_participants` (for 2a2's `not_entered`).
   - `sscc_blocks` holds `consumed_through` and `revoked_at`, with an index that serves «block containing serial X of prefix P for device D».
   - Nothing forces a change of `0009` or of protocol 2. Snapshot additions are JSON fields (see TRIAGE 10).
2. **Transactions:**
   - Every write uses `begin_write`, `next_revision` once and `commit_with_revision`.
   - Owner re-entry and repeats commit or roll back with no revision.
   - The counter uses `INSERT … ON CONFLICT DO UPDATE … RETURNING` inside the write transaction.
   - Blocks never overlap: the counter is set to `to + 1` in the same transaction, and the join and lock tests exist.
   - The entry race is deterministic (`device_shifts.rs:1152`).
   - The 200 ms timeouts only assert that a request is still pending, never as synchronisation.
   - Item 15 is decided above.
3. **Authorization:**
   - Device routes are for stations only (office and handheld get `forbidden`, both tested).
   - Office routes use `require_shift_planning` plus `_in` (re-check tested for POST, PUT, DELETE and close).
   - A device key alone gets 401 `session`.
   - Refusal `details` are pinned exactly and leak no snapshot, layout or owner.
   - Audit actors: an office user via `context.actor()`, a station via `Actor::Device`.
   - The process log holds no layout. The Task 9 walk covers plan, enter, re-entry, list, block and close; my reading confirms there is no `tracing` of the snapshot.
4. **SSCC:**
   - Arithmetic: `from = next`, `to = min(next+size-1, cap-1)`, exhausted when `next >= cap`.
   - `site.box_block_size > 0` is a CHECK in `0001`, so `to >= from` always holds.
   - `requestId` scope is per station (`UNIQUE(device_id, request_id)`, tested with a colleague).
   - The counter moves with a new rev in the same transaction, and a stale office counter form meets `stale_revision`.
   - Items 18, 19, 20 and 22 are triaged below.
5. **Protocol:**
   - Versions: `PROTOCOL_VERSION = 2`, `MIN = 1`.
   - Host: accepts 1 and 2 and refuses 3 (`server.rs` tests). Shell: `compatibility_for` marks a protocol-1 host `HostTooOld` (tested). Webview: `protocol.ts` = 2, tied to `hello.json` by `protocol.test.ts`.
   - `error-codes.json` and `API_ERROR_CODES` both gained `sscc_exhausted`, and `ru.json` has its text.
   - Stale samples: `proto/fixtures/error-with-details.json` (`1..=1`, `maxProtocol: 1`; read by `proto/tests/fixtures.rs:64,109` and `test/protocol.test.ts:104-117`), plus the webview's `test/probe.test.ts:8` and `test/support/fixtures.ts:26`.
   - The new shift fixtures round-trip in Rust. No Zod schema exists yet: plans 2a3, 2a5 and 2a6.
6. **Data:**
   - `0001`–`0008`: one commit each in history, sha256 at `5ea7da950` equals HEAD.
   - `0009` is additive.
   - Index use (queued 4): both lists scan. Harmless at one site's volume; carry.
   - ON DELETE: see seam 1.
   - The lists issue one query each and the writes a fixed number of queries: no N+1.
7. **Tests as a suite:**
   - No `sleep` in the new suites.
   - Static count of test attributes: host 307 → 359, proto 39 → 45. This matches the gate (plan expected 334; +25 extra, each tied to a mutant by the task reports).
   - Titles match their assertions in what I sampled.
   - My mutants are in the table below.
8. **Documents:** every AGENTS «Shifts», «Protocol», «Operators», «Logs», «Writes» and «Catalog» addition and every spec §15 bullet is true to the final code. Exceptions:
   - the gaps in Minor 4;
   - «the closed ones produced in the last 31 days» actually spans today plus 31 days back (`>= today − 31`), which is plan-decided and tested at the boundary;
   - the queued doc items 8 and 24.
9. **Scope and process:**
   - Changed paths are only host, proto, `src-tauri/src/host_probe.rs`, `src/host/{errors,protocol}.ts`, `src/i18n/ru.json`, `test/{protocol,shift-numbers}.test.ts`, AGENTS and the spec.
   - Untouched: `Cargo.toml`, `Cargo.lock`, `package.json`, the lockfile, `apps/station`, `packages/*`, migrations `0001`–`0008` and shell migrations.
   - Every one of the 14 commits has exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
   - `git diff --check 5ea7da950..366e87f06` is clean.
   - No commits landed after 366e87f06 while I worked.

### My mutants

Before each run every file was copied to `/tmp/claude/fr/`. Afterwards each was restored, `cmp` was silent and sha256 matched:

- `office_shifts.rs` `4fbe0cb6…89d7`
- `device_shifts.rs` `aaad9757…efcef`
- `shifts.rs` `aefa5def…7828`
- `templates.rs` `3ffbab88…2ab4`
- `sscc_blocks.rs` `32386294…4e03` (not mutated)

All runs were focused cargo targets with `--offline`.

| #     | Mutant                                                                                                      | Result                                                                                                                                                                                 |
| ----- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1–W4 | `commit_with_revision(…, rev)` → `0` in office create, update, delete and station create (applied together) | **survived**: office_shifts 21/21, device_shifts 15/15 → Important 1                                                                                                                   |
| R     | owner re-entry `SET last_entered_at = ?` → `coalesce(last_entered_at, ?)` (the entry is no longer marked)   | killed: `entering_a_planned_shift_opens_it_and_freezes_its_snapshot` (`device_shifts.rs:667`)                                                                                          |
| C     | `check_counterparty`: `archived == Some(false)` → `archived.is_some()`                                      | killed: `a_plan_needs_an_active_product_an_active_line_and_a_fitting_template` (`office_shifts.rs:488`). It survives `device_shifts` alone, which is acceptable: the helper is shared. |
| T     | `template_in_use` `ORDER BY id` → `ORDER BY id DESC`                                                        | killed: `a_template_that_a_planned_shift_names_is_not_deleted` (`office_shifts.rs:1085`)                                                                                               |

`git status --short` was empty at the end. One cargo command started with a no-op `cd` into the worktree root; it changed nothing.

---

## (b) TRIAGE of `2a1-minors.md`

| #   | Item                                                         | Decision                                                                                                                                                                                                                                    | Reason                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | hexdigit mutant in `civil_date`                              | **FIX** (test)                                                                                                                                                                                                                              | Add `"202a-10-08"` to `only_digits_and_dashes_make_a_date`. One line; it kills a real survivor.                                                                                                                                                                                                                                                                                           |
| 2   | zero or negative seq formats unlike the domain               | **DROP**                                                                                                                                                                                                                                    | Unreachable: `CHECK (last_seq > 0)`, `number_seq > 0`. (The controller's «2» meant item 3.)                                                                                                                                                                                                                                                                                               |
| 3   | status CHECKs weaker than the lifecycle                      | **FIX** (migration + test)                                                                                                                                                                                                                  | Minor 3. Safe now, impossible later without a table rebuild.                                                                                                                                                                                                                                                                                                                              |
| 4   | office list: no paging or period bound, no index use         | **CARRY → 2a3**                                                                                                                                                                                                                             | Harmless at one site's volume. 2a3 decides paging or a bounded period; an index-friendly rewrite can follow.                                                                                                                                                                                                                                                                              |
| 5   | report slip                                                  | **DROP**                                                                                                                                                                                                                                    | No code impact.                                                                                                                                                                                                                                                                                                                                                                           |
| 6   | proto test lacks `counterpartyId: null`                      | **FIX** (test)                                                                                                                                                                                                                              | Parse `{ "counterpartyId": null, "expectedRev": 1 }` → `Some(None)`.                                                                                                                                                                                                                                                                                                                      |
| 7   | inline copy of the trigger SQL                               | **FIX** (test, low priority)                                                                                                                                                                                                                | Helper takes a trigger name derived from `user_id`; `office_shifts.rs:1705` uses it. Drop it first if the wave is tight.                                                                                                                                                                                                                                                                  |
| 8   | `update_shift` doc omits the counterparty                    | **FIX** (doc comment)                                                                                                                                                                                                                       | Trivial.                                                                                                                                                                                                                                                                                                                                                                                  |
| 9   | stale protocol-1 samples                                     | **FIX** for `proto/fixtures/error-with-details.json` (`1..=2`, `maxProtocol: 2`) together with `test/protocol.test.ts:104-108` (both inside the plan's scope); **CARRY → 2a3** for `test/probe.test.ts:8` and `test/support/fixtures.ts:26` | The webview tests are outside 2a1's paths.                                                                                                                                                                                                                                                                                                                                                |
| 10  | stored snapshot re-serialized through the typed struct       | **DOC**                                                                                                                                                                                                                                     | Doc comment on `ShiftSnapshot` (and one AGENTS sentence): «rows outlive host versions: a field added later is `Option` with `#[serde(default)]`». Returning the stored JSON as is would need either `RawValue` (a serde_json feature, which means a manifest change) or turning the typed `DeviceShift.snapshot` into a `Value`; neither is worth it. 2a2+ planners must follow the rule. |
| 11  | device auth's `last_seen_at` UPDATE masks router-level races | **DROP** (informational)                                                                                                                                                                                                                    | The deterministic tests call handlers directly; that is already documented in `device_shifts.rs:1192-1195`.                                                                                                                                                                                                                                                                               |
| 12  | end-to-end close as seen by the owner                        | **DROP** (done)                                                                                                                                                                                                                             | Task 9 added `a_shift_the_office_closes_reads_closed_to_its_owner_and_no_station_reenters_it`.                                                                                                                                                                                                                                                                                            |
| 13  | `close_reason` repeats `clean_text`                          | **DROP**                                                                                                                                                                                                                                    | Plan text; reuse only if touched again.                                                                                                                                                                                                                                                                                                                                                   |
| 14  | Zod counts UTF-16 units, the host code points                | **CARRY → 2a3**                                                                                                                                                                                                                             | The close form must count `Array.from(text.trim()).length`.                                                                                                                                                                                                                                                                                                                               |
| 15  | no device re-check in shift create and enter                 | **FIX** (prod + test)                                                                                                                                                                                                                       | Minor 2, with scenario.                                                                                                                                                                                                                                                                                                                                                                   |
| 16  | any station draws any known box counter                      | **CARRY → owner / 2a6**                                                                                                                                                                                                                     | Spec §4.3 enforces nothing more; record in «Перенесено».                                                                                                                                                                                                                                                                                                                                  |
| 17  | repeat `requestId` returns the old block                     | merged with 20 → **FIX**                                                                                                                                                                                                                    | See 20.                                                                                                                                                                                                                                                                                                                                                                                   |
| 18  | final serial 9 999 999 never asked                           | **FIX** (test)                                                                                                                                                                                                                              | Counter at 9 999 999 → block `9 999 999..9 999 999`, counter 10 000 000, then `sscc_exhausted`. Kills `next + 1 >= capacity`.                                                                                                                                                                                                                                                             |
| 19  | no host-side throttle                                        | **CARRY → owner / 2a6** (record in «Перенесено»)                                                                                                                                                                                            | Not in spec. After 2a2 brings `consumed_through`, consider «answer the newest live block while less than half used».                                                                                                                                                                                                                                                                      |
| 20  | repeat with a different prefix answers the old block         | **FIX** (prod + test + doc)                                                                                                                                                                                                                 | Minor 1: defence against duplicate SSCC.                                                                                                                                                                                                                                                                                                                                                  |
| 21  | = 15                                                         | **FIX** (with 15)                                                                                                                                                                                                                           | Shared helper.                                                                                                                                                                                                                                                                                                                                                                            |
| 22  | exhausted counter shows next > max in the office dialog      | **CARRY → 2a3**                                                                                                                                                                                                                             | «Номера закончились», no dialog.                                                                                                                                                                                                                                                                                                                                                          |
| 23  | `similarLogin` shown as «taken»                              | **CARRY → 2a3** (owner wording)                                                                                                                                                                                                             | Webview.                                                                                                                                                                                                                                                                                                                                                                                  |
| 24  | AGENTS: deactivated operators count; tie order               | **FIX** (doc)                                                                                                                                                                                                                               | Half a sentence.                                                                                                                                                                                                                                                                                                                                                                          |

**New items to add to the wave:** Important 1 (wake tests) and Minor 4 (AGENTS audit actions).

I agree with the controller's leaning except for these:

- 20 is FIX (refuse the mismatch), not CARRY. 17 merges into it.
- 10 is DOC, not a code change.
- 12 is already done.
- «2» means 3.
- 7 is optional.

### Proposed fix wave (ONE fixer)

Each commit stays green. For behaviour changes, production comes first and its test commit right after; the fixer shows RED by running each new test against the pre-fix code and reports it.

1. `test(standalone): every shift write wakes the streams with its revision`: Important 1. Four assertions; mutants W1–W4 shown failing.
2. `test(standalone): …last serial, a date with a hex digit, a cleared counterparty, …`: items 1, 6, 18 and (optional) 7, plus item 9's proto fixture with `test/protocol.test.ts`. Tests and fixtures only.
3. `fix(standalone): 0009's status CHECKs hold the whole lifecycle`: item 3. Migration text only.
4. `test(standalone): a shift row that breaks its lifecycle is refused by the schema`: tests for 3.
5. `fix(standalone): a revoked station neither creates nor enters a shift; a block request id keeps its prefix`: items 15/21 (shared `require_station_in`) and 20.
6. `test(standalone): …revoked in the race, a repeated request id with another prefix`: tests for 5, updating the pinned repeat test.
7. `docs(standalone): …`: item 8 (doc comment), item 10 (`ShiftSnapshot` doc + AGENTS), item 24, Minor 4 (audit actions), AGENTS for 3, 15 and 20.

The controller then writes «Отклонения при исполнении» and adds the CARRY items to «Перенесено».

Gate after the wave:

- focused `office_shifts`, `device_shifts`, `sscc_blocks`, `shift_numbers` and `templates` (in the sandbox);
- `no_secrets_in_logs` (outside the sandbox);
- `-p markiro-proto`;
- `vitest run test/protocol.test.ts`;
- fmt, prettier, `git diff --check`;
- one full `cargo test --workspace --offline` by the controller.

---

## (c) DEVIATIONS TO RECORD — draft for «Отклонения при исполнении»

```markdown
## Отклонения при исполнении

Записано по итогам исполнения 2026-10-08 — 2026-10-09. Там, где задачи выше расходятся с кодом в ветке, верен этот раздел. Владелец не ответил на вопросы раздела 11 спецификации 2a: действуют допущения в начале плана (В1 A, В2 A, В3 A, В4 A, В6, В9 A, В13 A).

**Поправки плана по ходу исполнения**

- Счёт тестов. План заканчивается на cargo 46 наборов и 494 теста (хост 334, `proto` 45, оболочка 115) и Vitest 67 файлов и 1744 теста; сборка до итоговой волны — хост 359 (+25), `proto` 45, оболочка 115, Vitest 67 и 1744. Лишние тесты — задачи исполнителей и исправлений по ревью (задача 1 — +1; исправления задач 2–6 и собственные тесты задач 3–9); каждый убивает однострочную мутацию, которую тесты плана пропускали. Ожидаемые числа в задачах 2–9 и в «Итоговой проверке» читать с этой поправкой. Итоговая волна добавляет свои (см. ниже).
- Задача 7: в `issue_block` добавлена проверка устройства внутри транзакции записи (`require_station_in`: не отозвано, вид — станция), которой нет в брифе: отзыв, закоммиченный, пока запрос ждал блокировки, останавливает выдачу (401). Два теста.
- Задача 8: при нескольких номерах «в пути» ответ называет сначала тот же номер, потом наименьший (`ORDER BY login = ? DESC, login LIMIT 1`), и считаются все операторы, выключенные тоже.
- Задача 9: проход журнала процесса входит в смену второй раз (повторный вход владельца отдаёт хранимый снимок), иначе строка журнала в этой ветке прошла бы незамеченной; сквозной тест «станция вошла — офис закрыл — владелец видит закрытую — повторный вход `shift_status`» (замечание 12 очереди).
- Документы шире буквы брифов: «пока смена существует; после удаления офисом повтор планирует новую» (исправление задачи 4), строка журнала `shift.close` и порядок отказов закрытия (исправление задачи 6).

**Итоговая волна правок** (после итогового ревью: Critical 0, Important 1, Minor 4 и очередь из 24 замечаний; коммиты <…>):

- тесты пробуждения потоков у создания, правки и удаления смены офисом и у создания сменой станцией (до них однострочная мутация без пробуждения проходила все тесты);
- `0009` до выпуска: проверки статусов держат весь жизненный цикл (не запланированная — со снимком, открытием и владельцем; закрытая — с `closed_at`, `closed_by_kind` и `closed_by`, иная — без них); локальная база с прежней `0009` хоста не запустится (контрольная сумма sqlx) — таких баз вне тестов нет;
- создание и вход в смену проверяют устройство внутри транзакции записи, как выдача блоков (общий `require_station_in`); станция, отозванная, пока запрос ждал блокировки, получает 401;
- повтор `requestId` блока SSCC с другим префиксом — `validation_failed` на `requestId` (было: прежний блок другого префикса); повтор с тем же телом — тот же блок; правило записано в `AGENTS.md`;
- тесты последнего номера префикса (9 999 999), даты с шестнадцатеричной цифрой, `counterpartyId: null` в `ShiftUpdate`; `error-with-details.json` говорит о протоколе `1..=2`;
- документы: шесть действий журнала смен и блоков, правило «поле снимка, добавленное позже, — `Option` с `#[serde(default)]`», выключенные операторы в правиле ведущих нулей, комментарий `update_shift`.

**Перенесено дополнительно**

- План 2a3: подпись `similarLogin`; счёт причины закрытия в кодовых точках; «Номера закончились» у исчерпанного счётчика; пейджинг или граница периода списка смен; тестовые приветствия протокола 1 в `test/probe.test.ts` и `test/support/fixtures.ts`.
- План 2a6 / владелец: блоки любого известного префикса без проверки активной смены; ограничение выдачи блоков на стороне хоста (сейчас станция с новыми `requestId` может исчерпать префикс).
```

---

## (d) What could not be verified

- **CI:** `standalone-rust` and `standalone-windows-build` need a push, which is not authorized. Windows (host service, WebView2) is out of scope.
- **Live pair:** no live host and station pair was run. The new routes have no caller until 2a3 and 2a5. The snapshot was frozen only with tiny or synthetic layouts; there was no real domain layout through `labelTemplateSpecSchema`.
- **Protocol 1↔2 between installed builds:** stage-1 host with 2a station, and 2a host with stage-1 station. The evidence is only probe unit tests plus `protocol_guard`.
- **Real catalog sizes:** list query cost with thousands of shifts, and SSE wake fan-out with several stations.
- **Full suites:** I did not re-run the full host suite or Vitest. I rely on the controller's gate at HEAD, and I re-ran only focused targets for mutants.
- **The race in Minor 2:** shown by reading, not by a test.

## (e) What plans 2a2 / 2a3 / 2a5 / 2a6 must know

- **All plans:** `0009` changes once more in the final wave (status CHECKs). After that it is applied: new columns or tables go in `0010`+.
- **Snapshot rule:** a field added to `ShiftSnapshot` later must be `Option` + `#[serde(default)]`. Rows frozen by 2a1 lack it, and owner re-entry parses the stored JSON through the struct.
- **2a2:**
  - A station close must write `closed_at`, `closed_by_kind = 'device'` and `closed_by` (the tightened CHECK).
  - `closed_at` must use the host's `format_timestamp` format: the station list compares `closed_at >= cutoff` as text.
  - If fact batches take host revisions, every station re-reads `GET /v1/device/shifts` (a table scan) on every batch from any station. Decide deliberately.
  - Use `shift_participants` for `not_entered`.
  - Facts must use `consumed_through` and the `(issuer_prefix, extension, device_id)` index.
- **2a3:**
  - Schemas: Zod for the office fixtures; `similarLogin` text; the close reason counted in code points; exhausted counter UI; list paging or period.
  - Error texts: `template_in_use` (with `shiftIds`) and `shift_status` (with `details.status`).
  - Recovery path: a shift whose owner was revoked or moved to another line stays busy until the office closes it.
  - Fixtures: the webview probe fixtures still say protocol 1.
- **2a5:**
  - Station reads: read shifts after subscribe and after every revision event (no polling). A foreign `ownerDeviceId` means busy.
  - Snapshot: frozen at open; re-entry returns it. Validate the layout with `labelTemplateSpecSchema`.
  - Protocol: a stage-1 host is `host_too_old` at the probe. Release order: host before stations.
- **2a6:**
  - `floor_block_requests`: store the requested prefix and repeat the stored request whole. After the wave, a repeat with another prefix is a 400 on `requestId`.
  - Filing: keep the block under the answer's `issuerPrefix`.
  - Owner decisions pending: the host does not check that the prefix belongs to an active shift and has no throttle (items 16 and 19).
