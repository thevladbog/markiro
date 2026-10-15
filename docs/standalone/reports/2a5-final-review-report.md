# Plan 2a5 — final whole-part review (claude/2a5-floor @ afe157e28)

## Verdict

**WITH FIXES.** Critical 0, Important 1, Minor 16.

The part is sound as one machine. The pairing scope holds on every floor read and write. The shell's holds are released in exactly one place (`endWork`, refusal first). No path writes or shows work for a closed shift. A forget cannot discard unsent records without the explicit second step, and even that step deletes nothing. The protocol layer (Task 2, which had no review of its own) matches the integration host. It was checked route by route, and five extra mutants were all killed.

The fix wave the controller planned is right: items 11, 15, 16, 18, 21, 22, 23, 24 and 25. It needs four additions:

- one document correction that is Important by the rubric (Finding I-1);
- two more document corrections;
- the `0006` header comment;
- a carry for `host_probed`, which goes with item 26.

The plan's «Отклонения при исполнении» section is still empty, and its «Перенесено» section contradicts item 26.

**Process note (base).** The base given to this review, `ce6511b3b` with 55 commits, is not the 2a5 part. The branch was cut from `claude/integration` at **`16fdf718a`** (the 2a3+2a4 merge). The 2a5 part is **13 commits** (`e7943ab49`…`afe157e28`). `git diff --stat ce6511b3b..HEAD` lists host and proto changes, but those are 2a3's and integration's, not 2a5's. Everything below uses `16fdf718a..HEAD`. The ledger should be corrected.

## What I checked (seams)

1. **Floor tables against the plans that come next** (`0006` and the 2a6/2a7/2a8/ПЛ-Ц/ЧЗ/О-Ф plans in the main worktree). I scripted an extraction of every snake_case identifier inside the SQL strings of those plans. No column or table outside `0006` is used, except the plans' own new tables:
   - 2a7: `0007`, `floor_print_jobs` and `workstation_settings`.
   - ПЛ-Ц: `0008`, which adds `ALTER TABLE floor_shifts ADD pallet_box_capacity` and `pallet_template_id`, `floor_boxes.pallet_id`, `floor_pallets` and `floor_pallet_exceptions`. `pallets_enabled` is already in `0006`.
   - 2a8: no migration. Its retention list, `RETAINED_TABLES`, covers scans, exceptions, codes, print jobs, boxes and the outbox, all keyed by `shift_id`, which `0006` has.

   Nothing forces a change to `0006` or `TABLE_CLASSES`. The `json_type = 'object'` checks are compatible with 2a6's receipt UPDATE (`outcome_details = r.value -> 'details'` gives SQL NULL when the field is absent). One mismatch is cosmetic: the `0006` header says «codes and boxes have no retention at all», which 2a8 makes false (N6).

2. **Shell state machine as a whole.** I traced the combined trap table: L, N, entering, W, Lv, Lv-sign-out and the turn-back G, crossed with idle, removed, line held/undone, refusal held, office close, unmount, double leave, restart and sign-out during an entry. The operator always has a way out. The hold is released exactly at `work_left`. No `work_entered` is sent for a non-active or closing copy. After a restart the held refusal comes back on the first call, with `floorWork` null.

   One more ungated drop besides item 26: `host_probed` (N3).

3. **Identity and trust domains.**
   - Every `floor_shifts` statement is keyed by `host_id = ? AND device_id = ?`: the list, the upsert, the drop, `readShiftCopy`, `readStoredWork` and the status bar.
   - `FloorApp` is keyed by host:device:session. The reducer compares `sessionId` on `work_entered`, `work_left`, `operator_signed_out` and `operator_refreshed`.
   - Only the four identity fields plus `sessionId` reach the state.
   - No owner id, snapshot or hash reaches the DOM.
4. **Shift copies.**
   - Status only moves forward (`BEHIND`).
   - The repair path is restored: a re-entry overwrites the snapshot and `entered_at` keeps its first value through `coalesce`.
   - The offline entry admits an active copy with no `localState` only.
   - `notQuarantinedNewer` now guards `org_profile` and `lines` too.
   - My mutants M1 and M2 (the two Task 3 survivors) are now killed.
5. **Protocol layer.** Checked against the integration host (`/tmp/claude/wt/integ`, `host/src/routes/device_shifts.rs`, `shifts.rs`, `templates.rs`, `devices.rs`, `validate.rs`).
   - Responses are lenient and requests are `.strict()`.
   - The builder `deviceShiftCreate` names all 7 fields, with `counterpartyId: null`.
   - Ids appear only in URL paths.
   - The three device-shift fixtures and `error-shift-busy.json` are parsed. The request fixture is produced exactly by the builder.
   - The host's timestamps use `Z` RFC 3339 and match `z.iso.datetime()`.
   - Refusal mapping:
     - create: `validation_failed` on `productId` → `product_inactive`, on `lineId` → `no_line`, on `boxTemplateId` → `template` (the host's `check_slot` answers `validation`, not a conflict); `product_inactive` and `shift_line` conflicts are mapped too.
     - enter: `shift_busy`, `shift_status`, `shift_line`, `product_inactive`, `template_not_fit` and `not_found`.
     - `forbidden`, `rate_limited`, `protocol_unsupported` and `internal` give `failed` (`protocol_unsupported` is carried).
   - The host requires a lower-case hyphenated UUID for `requestId` (`validate::client_uuid`). The webview mints one with `crypto.randomUUID()` (N7).
6. **Forget and unsent records, end to end.**
   - Rust `count_unsent` counts with `acked_at IS NULL` per pairing, or for every pairing when the pairing file is unreadable, inside the forget's transaction.
   - The 8 `DeviceData` classes are pinned by `every_table_has_a_forget_class`.
   - The webview count uses the same predicate. A count that cannot be read gives `null` («without a number»).
   - Only «Сбросить всё равно» sends `keepUnsent: true`.
   - `cargo test --test local_db`: 27 passed. `--test ipc`, run outside the sandbox: 26 passed.
7. **Tests as a suite.**
   - New sleeps used as synchronization: `floor-status-bar` 274 (item 23) and `floor-new-shift` `settle()` 50 ms at 1077 and 1098 (N5). `app.test.tsx` 2405 predates 2a5.
   - Every count I measured matches the ledger: shift-copies 39, host-link-shifts 16, protocol+api 288. Two numbers mean something other than they seem: the ledger's «floor-schema 80» is floor-schema (26) plus local-executor, and cargo `local_db` is 27 (the plan said 16).
   - 14 one-line mutants of my own; the table is below.
8. **Documents** (`apps/standalone/AGENTS.md` and spec §18). They are true to the code, with three exceptions:
   - I-1, the forget screens during a shift;
   - N1, the examples of a refusal from a call;
   - statements that the fix wave must update with items 15 and 22.
9. **Scope and process.**
   - The 13 commits touch only `apps/standalone/{src,test}`, `src-tauri/migrations/0006`, `src-tauri/src/local_db.rs`, `src-tauri/tests/{local_db,ipc}.rs`, `AGENTS.md` and the stage spec.
   - No host, proto, manifest, lockfile or `packages/*` change.
   - Each commit has exactly one `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
   - `git diff --check 16fdf718a..HEAD` is clean.
   - The `\u04` grep finds only `src/host/pairing-code.ts:66`.
   - `prettier --check` (through `rtk proxy`, exit 0) passes on AGENTS.md and the spec.
10. **Merge readiness.** `git merge-tree --write-tree 1095d4af4 afe157e28`:
    - Conflicts are only in `apps/standalone/AGENTS.md` (2 hunks) and the stage spec (§18 against §19).
    - Auto-merged: `api.ts`, `protocol.ts`, `ru.json`, `test/api.test.ts`, `test/protocol.test.ts`, `test/support/office.tsx`.

## (a) Findings, most severe first

### Important

**I-1. AGENTS.md says the forget screens never replace a shift's work screen; the other-host screen does.** (`apps/standalone/AGENTS.md:146-148`, «Local database»)

- The text: «A refusal that arrives while an operator works in a shift waits for them to leave it…, so these screens never replace a shift's work screen».
- «These screens» are named three lines above as the device-rejected, other-host and config-error screens.
- `sync_finished` with `other_host` drops the operator and the work at once (`shell.ts:467-474`). So the other-host screen, with its forget, does replace a working shift. That is exactly the window item 26 carries to 2a6.
- Scenario: a 2a6 executor reading «Local database» relies on the claim and does not gate `other_host`. Tracked writes are then in flight while the forget is offered, and the shell's premise in `lib.rs:163-167` breaks.
- The same document admits the exception much later («Two things carry to plan 2a6's gate task…»), but this sentence is a false safety statement.
- Fix (doc): «…so the device-rejected screen never replaces a shift's work screen; the other-host screen still does (`sync_finished` with `other_host` drops the work at once, carried to plan 2a6's gate task, see "Shifts")».

### Minor

**m1 (queued item 11). Entry refusal paths that no test pins.** (`src/floor/shifts/shift-entry.ts:96-118`, `ShiftList.tsx:111`)

- My mutant M3 lets a transport `certificate_mismatch` fall back to the stored snapshot. It survives all 128 tests of `floor-shift-list` and `floor-new-shift`.
- The keep failure → `local`, the read-back that is not `ready` → `local`, a non-`HostError` → `failed`, and `setRefusal(null)` are still unpinned. The T5 review showed their mutants surviving.
- Fix: add tests. No production change is needed.

**m2 (item 15). An office close is lost while another leave waits.** (`src/floor/FloorApp.tsx:145-151`)

- Upgrade a waiting `list(null)` or `line_changed` to `list(office_closed)`, with sign-out still the highest.
- The fix must also change AGENTS.md («any other leave that comes meanwhile is ignored, an office close included, which then shows no notice») and spec §18 («закрытие в офисе тоже (уведомления тогда нет)»). Both describe the current behaviour.

**m3 (item 16).** `FloorApp.tsx:109`: write `const [gate] = useState(createWorkGate)`. Keep `lock` as `useMemo`, because it depends on the `idleTimeoutMs` prop and a new lock only restarts the wait. This is a refactor that no test can fail on; W9 already pins the gate's stability. Say so in the commit.

**m4 (item 18).** Add a FloorApp test: `holdingWork`, two `onLeave` calls in one `act`, release, then exactly one `work_left` and one `finish`. Today the guard is only killed indirectly.

**m5 (item 21). `unsent` survives a change of screen kind.** (`App.tsx:151`, `:281`)

- It is reachable in a narrow case: the view `device_rejected` is derived from a probe that found another host at the paired address (`shell.ts:264-268`). That case does not stop the link (`linked` ignores derived rejections), and a later `sync_finished` with `other_host` switches to the other-host screen while the earlier count is still shown.
- Fix without an effect: store `{ records, view: view.kind }` and pass `unsent` to a screen only when the kind matches.
- Test: the App with a probe that answers another `hostId`, a forget refused with `unsent_facts`, then a sync that finds `other_host`. Expect no count and no «Сбросить всё равно» on the other-host screen.

**m6 (item 22). The status bar says «На связи с хостом» next to the held-refusal marker.** (`FloorStatusBar.tsx:142`, `app.test.tsx:2558`)

- Fix: while `refusalHeld && link !== null`, pass `{ ...link, state: "offline" }` to `HostStatusLine`. This shows «Нет связи с хостом с HH:MM» and hides the sync failure, which `HostStatusLine` already does when not online.
- Flip `app.test.tsx:2558`, and add a status-bar test.
- Update AGENTS.md («`HostStatusLine` goes on saying that the host is online… making it say otherwise is open») and spec §18 («…может писать «На связи с хостом»: это не исправлено»).

**m7 (item 23).** `test/floor-status-bar.test.tsx:267-276`: a negative assertion after a fixed 20 ms wait. Wrap the executor and await the `floor_shifts` query's resolution.

**m8 (item 24).** `test/floor-shift-list.test.tsx:479`: count the `floor_shifts` queries and wait for the second one before asserting `activeElement`.

**m9 (item 25).** `src/floor/OperatorSignIn.tsx:469,475`: Alerts with `role="alert"` inside the polite region at `:467`.

- Line **306 is not inside a live region**: it is in `body()`, rendered outside the region. Leave it as an alert.
- Fix: `role="presentation"` on 469 and 475, plus a test that the region contains no `role="alert"`.
- Note: this file is plan 1f's, not on 2a5's file list. It is still inside the allowed `apps/standalone/src`.

**m10 (N1). AGENTS.md gives the wrong examples of a call-borne refusal.** (`AGENTS.md`, «App shell», the new status-bar paragraph)

- The text: «A refusal that comes from a call (an entry, a creation, a read of the shifts)…».
- A refusal is held only while `floorWork` is set, and then only the work screen is mounted, so an entry or a creation cannot be the call.
- Fix: «(a read of the device, the sync or a read of the shifts; with plan 2a6, a call of the work screen)».

**m11 (N3). `host_probed` drops the operator and the work without the gate.** (`shell.ts:333-338`; carry to 2a6 with item 26)

- The start-up probe can land up to `PROBE_TIMEOUT` (3 s, `src-tauri/src/host_probe.rs:19`) after the floor appears. The floor shows while the probe is still running, for a local or a remote host alike.
- A badge scan followed by an offline «Продолжить» inside that window puts the operator in work. The late `host_probed` then sets `NO_FLOOR_SESSION`: no `work_left`, a held refusal dropped, and the session gone.
- Harmless with the 2a5 stub. With 2a6's tracked writes it is the same class as item 26.
- Fix (2a6): do not drop `floorWork` on a probe whose view is still the floor, or hold it like `pendingRejection`.

**m12 (N4). The plan's «Перенесено» contradicts item 26.** It says «Другой хост (`other_host`) посреди смены … план 2b». AGENTS.md, spec §18 and minors item 26 make the forget-in-flight window a mandatory part of 2a6's gate task. Amend «Перенесено» and record it under «Отклонения» (draft in (c)).

**m13 (N5).** `test/floor-new-shift.test.tsx:651-654` and its uses at 1077 and 1098: `settle()` is a fixed 50 ms wait before `not.toHaveBeenCalled` after an unmount. That is item 23's class. Under load ~80–130 the create → `keepCreatedShift` (node:sqlite) chain can exceed 50 ms, and the tests would then pass vacuously if the `alive` guard went. Fix: await the create and keep promises, for example through a wrapped executor's `transaction`. The use at 1252 is redundant but harmless.

**m14 (N6).** The `0006` header comment (`migrations/0006_floor_production.sql:25-28`) says «acknowledged facts stay for 30 days, codes and boxes have no retention at all». Plan 2a8's `RETAINED_TABLES` deletes `floor_codes` and `floor_boxes` per shift 30 days after the host took its close. `0006` is unreleased, so the comment is free to fix now. After release sqlx checksums the file.

**m15 (N7, DROP/note).** `deviceShiftCreateSchema.requestId` is `z.uuid()`, which accepts upper-case. The host's `client_uuid` refuses anything but lower-case hyphenated. The only minter is `crypto.randomUUID()`, which is lower-case, so this cannot happen today. Tighten it only if another minter appears.

**m16 (N8, DOC).** `deviceNotSaved` says the station «работает по-прежнему». In practice the host lists the device's new line, so the next shift read drops the old line's planned copies that were never entered. The list then shows only entered copies of the old line. A new shift is created on the host's new line. This is an edge case (`device.json` unwritable, usually a full disk), but name it in AGENTS.md as a known limitation.

### My mutants

Each file was copied to `/tmp/claude/rev-2a5-final/orig-*` first. After every run, `sha256` and `cmp` matched (restored = True), and `git status --short` was empty.

| #   | Mutant (one line)                                                                        | Result                                                                                                 |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| M1  | `shift-copies.ts` drop: `entered_at IS NULL` → `(entered_at IS NULL OR status='closed')` | killed: «keep an entered shift the host closed after it has left the list…»                            |
| M2  | drop's list filter `json_each(?) LIMIT 1`                                                | killed: «from a stale list of two shifts…»                                                             |
| M3  | `shift-entry.ts` transport `certificate_mismatch` falls back to the snapshot             | **survives** 0/128 (item 11)                                                                           |
| M4  | `FloorApp.tsx:218` copy check ignores `localState`                                       | killed: «does not take the operator out of a shift the office closed while this station is closing it» |
| M5  | `shell.ts:524` same-line refresh keeps `pendingDevice`                                   | killed: «forgets a waiting move when the office moves the station back…»                               |
| M6  | `NewShift.tsx:266` template refusal keeps the fixed template                             | killed: «offers the templates that fit when the host no longer takes the one the rule chose»           |
| M7  | `new-shift.ts:215` `lineId` mapping off                                                  | killed (2 tests)                                                                                       |
| M8  | `host-link.ts:250` `not_paired` guard deleted (item 9)                                   | killed: «say nothing and are not retried…»                                                             |
| M9  | `0006` `payload` without `json_type = 'object'`                                          | killed: «keep a record, a snapshot and receipt details as objects only»                                |
| M10 | `deviceShiftCreateSchema` without `.strict()`                                            | killed (2)                                                                                             |
| M11 | `deviceShiftCreate` without `counterpartyId: null`                                       | killed (5)                                                                                             |
| M12 | `enterShift` path `/enter` → `/open`                                                     | killed (2)                                                                                             |
| M13 | `enteredShiftSchema` snapshot optional                                                   | killed (2)                                                                                             |
| M14 | `App.tsx:281` no `setUnsent(null)` after a forget                                        | killed: «does not carry a confirmation over to the next refusal…»                                      |

## (b) Triage of queued minors 1–27, and the fix wave

| #            | Decision                                       | Reason / evidence                                                                                                                            |
| ------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1            | CARRY 2a6 (mandatory addendum)                 | The 2a6 plan text still has the single `count(*) FILTER` (`2a6 plan l.7128`); the three counts are only in spec §18                          |
| 2            | CARRY 2a6 (mandatory addendum)                 | 2a6 l.6246 and 6431 are unchanged; write `+host_id`/`+device_id` and pin the plan in both lists                                              |
| 3            | CARRY 2a6 (mandatory addendum + contract line) | Spec §18 records it; the 2a6 plan does not                                                                                                   |
| 4            | DONE                                           | Spec §18, bullet 2, lists every deliberate §5.3 difference                                                                                   |
| 5            | DONE (doc) / CARRY as a rule to 2a6            | Stated in AGENTS.md and spec §18; cargo `the_floors_repeating_reads_search_an_index` passes (27/27)                                          |
| 6            | DONE                                           | `shift-entry.ts:69-71` (`storedWork`), plus the `FloorApp` gate                                                                              |
| 7            | DONE                                           | App test «sends nothing to a host that refused the key…» kills M30 (T7 review)                                                               |
| 8            | DONE                                           | `refusalHeld` and an App test through a call; K4 killed (T8 review)                                                                          |
| 9            | DONE                                           | `44bfec4ad`; my M8 is killed                                                                                                                 |
| 10           | DONE                                           | `FloorApp.tsx:240` gate; T7 M4 killed                                                                                                        |
| 11           | **FIX** (tests)                                | My M3 survives                                                                                                                               |
| 12           | DONE                                           | `ShiftList` renders `standing` and `linkState` together in one region                                                                        |
| 13           | DONE                                           | «Назад» unmounts `NewShift`; T7 M5 killed                                                                                                    |
| 14           | DONE                                           | `role="presentation"` in ShiftList, NewShift and the status bar (the OperatorSignIn remainder is item 25)                                    |
| 15           | **FIX** (prod + test + doc)                    | m2                                                                                                                                           |
| 16           | **FIX** (gate only)                            | m3; no test can fail on it                                                                                                                   |
| 17           | DONE                                           | `WorkScreen` JSDoc and `aria-disabled`                                                                                                       |
| 18           | **FIX** (test)                                 | m4                                                                                                                                           |
| 19           | DONE                                           | List prompt `tabIndex=-1`, focused in a layout effect                                                                                        |
| 20           | DONE                                           | AGENTS.md «Shifts» and spec §18 name all three deviations                                                                                    |
| 21           | **FIX** (derived, no effect)                   | m5; reachable through derived `host_changed` → `other_host`. If the App test proves impractical, downgrade to a DOC comment                  |
| 22           | **FIX** (prod + flip test + doc)               | m6                                                                                                                                           |
| 23           | **FIX** (test)                                 | m7                                                                                                                                           |
| 24           | **FIX** (test)                                 | m8                                                                                                                                           |
| 25           | **FIX**, lines 469 and 475 only                | m9; line 306 is outside the region                                                                                                           |
| 26           | CARRY 2a6 (mandatory in the gate task)         | Not in the 2a6 plan text (no `other_host` there); add as an addendum together with m11 (`host_probed`)                                       |
| 27           | CARRY 2a6                                      | The Node list gets the exact `countUnsentRecords` text once 2a6 calls it repeatedly; the shell list already has it (`tests/local_db.rs:857`) |
| new I-1      | **FIX** (doc)                                  | Important: the forget screens during a shift                                                                                                 |
| new N1 (m10) | **FIX** (doc)                                  | Wrong examples of a call-borne refusal                                                                                                       |
| new N3 (m11) | CARRY 2a6                                      | With item 26                                                                                                                                 |
| new N4 (m12) | **DOC** (plan)                                 | Amend «Перенесено» and record it in «Отклонения»                                                                                             |
| new N5 (m13) | **FIX** (test), optional                       | Fixed 50 ms waits                                                                                                                            |
| new N6 (m14) | **FIX** (migration comment)                    | Free while `0006` is unreleased                                                                                                              |
| new N7 (m15) | DROP                                           | The only minter is lower-case                                                                                                                |
| new N8 (m16) | **DOC**                                        | Known limitation of `deviceNotSaved`                                                                                                         |

**The fix wave: ONE fixer, five commits.** Tests and production code are separate. Each commit has the trailer.

1. `test(standalone): pin the entry's certificate exception, its local and plain failures, and a refusal cleared by the next attempt`. Item 11; tests only, and they pass on today's code. RED evidence comes from mutants: M3, the T5 review's R7, R8, R22 and R9.
2. `test(standalone): an office close that meets a waiting leave, one leave for two presses, a held refusal shown as a stopped link, a count kept to its screen, no alert inside the sign-in's region`. Items 15, 18, 22 (flip `app.test.tsx:2558` and add a status-bar case), 21 and 25. These are RED before commit 3.
3. `fix(standalone): …`. The production side:
   - `FloorApp` leave upgrade (15);
   - `useState(createWorkGate)` (16);
   - `FloorStatusBar` offline status while `refusalHeld` (22);
   - `App` `unsent` keyed by view kind (21);
   - `OperatorSignIn` `role="presentation"` at 469 and 475 (25);
   - the `0006` header comment (N6).
4. `test(standalone): wait for the reads and writes a negative assertion is about, not a fixed time`. Items 23, 24 and N5.
5. `docs(standalone): …`. AGENTS.md: I-1, N1, N8, the item-15 sentence and the item-22 sentence. Spec §18: the item-15 and item-22 bullets. Plan 2a5: «Отклонения при исполнении» (the draft in (c), with the final wave added) and the «Перенесено» line on `other_host`.

Gates for the fixer:

- the focused files, run verbose and under the delayed-`setImmediate` stand: `floor-app`, `floor-status-bar`, `app`, `floor-shift-list`, `floor-new-shift`, `operator-sign-in`, `floor-schema`;
- typecheck and lint;
- `prettier --check` through `rtk proxy`;
- `git diff --check` and the `\u04` grep.

## (c) Deviations to record in the plan's «Отклонения при исполнении» (Russian draft)

```markdown
## Отклонения при исполнении

Ветка `claude/2a5-floor` отрезана от `claude/integration` на `16fdf718a` (2a3 + 2a4); часть 2a5 — 13 коммитов
`e7943ab49…afe157e28` (и коммиты итоговой волны). Число тестов настоящего дерева больше плановой копии:
Vitest после задачи 8 — 87 файлов, 2518 тестов (против 82/2050 копии плана); оболочка — `local_db` 27, `ipc` 26
(против 16/18: на дереве после 2a4 тестов больше).

- Задача 1. Однополевые текстовые ключи — `TEXT NOT NULL PRIMARY KEY` (SQLite принимает NULL в простом
  `TEXT PRIMARY KEY`). Фрагмент 2 не применён: отдельный тест внешних ключей уже был. `outbox_exists`
  оставлен для подсчёта в неоткрывшейся базе (старая сборка без `outbox`). По ревью добавлены четыре индекса
  повторяющихся чтений 2a6 (`outbox_settled` — частичный, `floor_codes_box`, `floor_codes_shift`,
  `floor_boxes_shift`), проверки `json_type(...) = 'object'` у `snapshot`, `payload`, `outcome_details` и тест
  оболочки `the_floors_repeating_reads_search_an_index` (планы чтений на SQLite 3.46 оболочки).
- Задача 2 отдельного ревью не имела (решение контроллера); её проверило итоговое ревью части. `requestId`
  создаётся `crypto.randomUUID()`.
- Задача 3. Статус копии только вперёд (`BEHIND`): список или ответ, прочитанный раньше сохранённого, не
  возвращает смену назад; запоздалый ответ входа после закрытия в офисе не берёт поля хоста, но сохраняет
  снимок и время входа; `keepEnteredShift` отказывает непроверенному снимку; `readStoredWork` — одно чтение.
  Неизменяемость снимка, введённая исполнителем, снята ревью: повторный вход перезаписывает снимок (путь
  починки поля, которое сборка отбросила), `entered_at` остаётся первым.
- Задача 5. Офлайн-вход и откат к снимку отказывают копии не `active` или с `localState` (`closed`); тест
  `not_paired` читателя смен — отдельным коммитом `44bfec4ad`.
- Задача 6 (по ревью). Форма новой смены замораживается после ответа хоста; возвращённая смена сверяется с
  запросом (`isShiftOfRequest`), смена других полей не открывается молча («уже была создана раньше», кнопка
  открывает её); `validation_failed` на `productId` — `product_inactive`, на `lineId` — `no_line`; отказ
  шаблона открывает выбор подходящих шаблонов.
- Задача 7. `FloorApp`: ждёт один выход (`standing`), выход из сеанса главнее ждущего; выход «на другую
  линию» кончается списком, если перевод отменён; ворота `entered` — копия не `active` или с `localState`
  возвращает на список (с «Смену N закрыли в офисе.»), без `work_entered`; `ShiftList` перемонтируется после
  возврата (`key`); `touch` у блокировки бездействия; живая область рабочего экрана смонтирована всегда.
- Задача 8. Метка ждущего отказа в строке состояния (`refusalHeld`, пункт 8 очереди), строка связи и
  стоящий отказ списка вместе в одной области (12), `role="presentation"` у предупреждений внутри вежливых
  областей (14), обязательства рабочего экрана в JSDoc и `aria-disabled` у «Выйти из смены» (17), фокус на
  подсказке списка (19).
- Задача 9. Раздел спецификации — §18 (следующий свободный в ветке); в `claude/integration` §18 занят
  планом 2a6 (§19 — 2a2), при слиянии раздел 2a5 перенумерован (см. коммит слияния).
- Итоговая волна: <пункты 11, 15, 16, 18, 21–25, документы I-1, N1, N8, комментарий `0006`>.
- «Перенесено» уточнено: другой хост (`other_host`) и проба хоста при старте (`host_probed`) посреди смены
  снимают цех без ворот; окно «сброс при записи в полёте» закрывает задача ворот плана 2a6 (удержать за
  воротами или ждать `drain`), замена хоста по тому же адресу — план 2b.
```

## (d) What could not be verified

- **CI and the full suite.** The full Vitest suite was not re-run (the ledger's Task 8 run: 87 files and 2518 tests). Typecheck and lint were not re-run at HEAD. The only post-Task 8 change is docs, and the T8 reviewer ran typecheck and lint at `41bb37f54`. I did not re-run the delayed-`setImmediate` stand; the per-task reviews of Tasks 4–8 did.
- **Windows, WebView2 and hardware.** Not verified:
  - WebView2: `crypto.randomUUID` in the app's origin, which must be a secure context; focus behaviour of `aria-disabled`; screen-reader behaviour of `role="presentation"` inside live regions; the 64 px layout on the customer's touch panel.
  - Hardware: the keyboard-wedge scan of a KM with GS under the RU and EN layouts; the on-screen keyboard over the product search in kiosk mode.
- **Live host.** No live 2a1/2a2 host was used: entry, re-entry and the snapshot of a real editor template through `labelTemplateSpecSchema`; offline «Продолжить» over Wi-Fi with the access point switched off; a line move and a revocation mid-shift.
- **SQLite 3.46 query plans.** These ran only through `cargo test --test local_db` on macOS (27 passed). `--test ipc` was run outside the sandbox (26 passed). The Windows build was not run.

## (e) What 2a6, 2a7, 2a8 and ПЛ-Ц must know

**2a6**

- Mandatory addenda, because none of them is in its plan text:
  - minors 1–3, 5 and 27;
  - 26 together with N3 (`host_probed`).
- Receipt `details` must be absent or an object. `0006` checks `json_type = 'object'`, so a JSON `null` in `r.value -> 'details'` would fail the whole receipt transaction. Keep the receipt schema object-only.
- Under a held refusal `FloorApp`'s `online` stays `true`: the link is torn down and keeps its last status. Its planned `rejectionPending` must gate every work-screen host call (`checkCode`, `requestBlock`).
- Its fragments were built on 2a5's plan text. The final code differs in these places:
  - `FloorApp`: `standing`, the `entered` gate, the keyed `ShiftList`, focus;
  - the `FloorStatusBar` prop `refusalHeld`, plus the item-22 override after the fix wave;
  - the `ShiftList` live region;
  - the `WorkScreen` stub's `aria-disabled`;
  - the `NewShift` freeze and `isShiftOfRequest`;
  - `keepEnteredShift` overwrites the snapshot;
  - `countUnsentRecords` exists in `src/local/outbox.ts`.
- Spec section §18 is reserved for 2a6 in `claude/integration`.
- `WorkScreenProps` obligations:
  - `track` before the work starts;
  - no scan while `leaving`;
  - bounded work: about 35 s for a local write, 5 s for the hand-over to the printer, 300 ms for a code check;
  - `touch` on every COM scan;
  - the leave control stays reachable from the keyboard.

**2a7**

- `0007`'s `floor_print_jobs.id TEXT PRIMARY KEY` and `workstation_settings.key TEXT PRIMARY KEY` take NULL in SQLite. Use `TEXT NOT NULL PRIMARY KEY` as in `0006`. Consider `json_type = 'object'` for `fields` and `printer`.
- The first `Workstation` table changes AGENTS.md's «Of the 19 tables 11 are Disposable and the 8 of migration 0006 are DeviceData». Update that sentence.
- Print from `CheckedSnapshot.boxTemplate.spec`, which the domain has already parsed, and `rev`.

**2a8**

- `FloorApp`'s `entered` gate and `storedWork`'s rule both turn a host-closed or closing copy away. Both are 2a5 executor deviations, absent from the plan text 2a8 was built on. 2a8's «Завершить» path (`CardAction finish`, `enterShift` into an office-closed shift by its snapshot) must relax both deliberately, along with `readShiftCopies`' `status <> 'closed'`.
- Its `RETAINED_TABLES` makes the `0006` comment false; fixed by N6 in this wave.

**ПЛ-Ц**

- `0008` assumes 2a7's `0007` exists. If ПЛ-Ц runs first, renumber it.
- `ALTER TABLE floor_shifts` with the pallet columns means `HOST_FIELDS`, and through it `UPSERT` and `KEEP_ENTERED` in `shift-copies.ts`, must name them.
- `floor_pallets.id` and `floor_pallet_exceptions.id` should be `TEXT NOT NULL PRIMARY KEY`.
- `palletTemplate` in the snapshot: an upgraded build recovers it through the re-entry overwrite restored in Task 3, because `shiftSnapshotSchema` strips unknown keys.

## (f) Merge checklist (into `claude/integration` @ 1095d4af4)

1. Run the fix wave on `claude/2a5-floor` first. Re-run its gates there.
2. `git merge claude/2a5-floor` into `claude/integration`. Expect exactly two conflicts:
   - `apps/standalone/AGENTS.md` hunk 1 (merged lines around 2298–2604):
     - keep integration's new `## Facts` section whole;
     - put 2a5's «The station's side (plan 2a5)…» paragraphs (through «…joins both query-plan lists.») at the end of «Shifts», before `## Facts`.
   - `AGENTS.md` hunk 2 (Verification, around 2798): combine the two sides.
     - Take 2a5's wording «(the station's side, plan 2a5, ran only against a fake `HostApi`)… which no real station has shown».
     - Take integration's last sentences about the «Итоги» window and the «Выпуск» column; integration's version is newer.
     - Drop 2a5's stale «totals are not read / «Итоги» is not built».
   - Spec: keep integration's §19 (2a2) and renumber 2a5's section from §18 to the next free number (§20). Update integration's comment at §19 («§18 — планами 2a6») to name 2a5's number. Note that the plans for 2a8 (§20) and О-Ф (§21) then shift at their own merges. Nothing in code, tests or AGENTS.md cites «§18»; grep confirmed.
3. Check the auto-merged files.
   - `src/host/protocol.ts`: 2a2's `totals` in `officeShiftSchema` and 2a5's device-shift schemas.
   - `src/host/api.ts`: both sides add `HostApi` members.
   - `test/support/office.tsx`: every `HostApi` member is in the `unexpected()` fakes.
   - `src/i18n/ru.json`: valid JSON and no duplicate keys. Use a duplicate-key check, because `JSON.parse` keeps the last value silently.
   - `test/api.test.ts` and `test/protocol.test.ts`.
4. Build the dependencies: `pnpm --config.verifyDepsBeforeRun=false exec turbo run build --filter='@markiro/standalone^...'`. Then run:
   - `typecheck` and `lint`;
   - focused Vitest: protocol, api, app, floor-*, shift-copies, host-link-shifts, shell, floor-schema, outbox, reference-sync, plus 2a2's office totals tests;
   - the full Vitest suite. Record any load timeouts; do not cure them by re-running.
   - `cargo test --offline --locked … -p markiro-standalone --test local_db`, and `--test ipc` outside the sandbox. Also `cargo test --workspace` for the host and proto, because 2a2's host is in integration.
5. Run `prettier --check` through `rtk proxy`, `git diff --check`, the `\u04` grep, and confirm the merge commit has one trailer.
6. Fill in plan 2a5's «Отклонения при исполнении» (draft (c)) and fix «Перенесено» (N4), if the fix wave did not.
7. Ledger: correct the base (`16fdf718a`, 13 commits plus the fix wave). Hand items 1–3, 5, 26 + N3 and 27 to the 2a6 dispatch as mandatory addenda. Hand the (e) notes to 2a7, 2a8 and ПЛ-Ц.
8. Run `graphify update .` after the merge.
