# plan О-Ф, Task 3 report — HTML reference from the cloud code

Status: DONE_WITH_CONCERNS (concerns = case-set gaps, listed below; none blocks the task).
Worktree `/tmp/claude/wt/chz`, branch `claude/office-chz`, base `4cb02ad42`. Commit `84ca43203 test(api): the cloud's own form routes draw the parity cases of the standalone office` (one trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; 3 files, nothing under `apps/api/src`; `git status --short` empty).

## What was done

Created exactly three files:

- `apps/api/test/standalone-forms-parity.test.ts`
- `packages/domain/test/fixtures/print-forms-parity/cases.json` (10 cases)
- `packages/domain/test/fixtures/print-forms-parity/golden.json` (written by the test's own write mode)

Test and `cases.json` were extracted mechanically from the brief's code blocks (brief lines 22-318 and 325-1528). One addition to the brief's code, per the ЧЗ Task 4 fix round: the write branch (`FORMS_PARITY_WRITE === "1"`) throws `FORMS_PARITY_WRITE=1 is refused when CI is set: …` when `process.env.CI` is set (copy of the ЧЗ pattern). Anchor adaptations: none (only file creation).

The test needs no database: the cloud services are `vi.fn` fakes returning the hand-built loader input of each case, run through the REAL `CodeSearchController` (`boxReport`, `palletReport`, `palletPlacard`, `shiftPlacards`), `ShiftsController.taskForm`, their Zod query schemas and the `@markiro/domain` renderers. Not skipped: verbose output shows `✓`, `Tests 1 passed (1)`.

## Evidence

- RED (`/tmp/claude/impl-pof-t3/red.txt`): `Error: ENOENT … print-forms-parity/golden.json`, `Tests 1 failed (1)`.
- Write run (`FORMS_PARITY_WRITE=1`): `Tests 1 passed (1)`. With `CI=true FORMS_PARITY_WRITE=1`: FAILS with the refusal message and golden.json is byte-unchanged (sha equal).
- **Golden SHA-256 = `8a7814ce39355a79c2dc694aa32a4a0e4089c8b993fda00d312648909b837b7c`, equal to the plan's pin.** Counts: 10 cases/runs; per-case bytes and sha256 prefixes equal the plan's table exactly (18524/71867b5e83b8d1d4, 15769/61e8795e801c8342, 8585/b4d1d2c4ab67b00b, 13321/1ce81877bb35ae32, 9531/a43391ebe3ee81fc, 6318/42f7aae8b11c3ad8, 6269/e913954dfcc64af0, 11977/b1fdca6a9522cd50, 16047/8dad8c3905db7131, 15627/635403ecc1b164be). No drift between cloud code/base and the plan's copy. cases.json sha256 (unpinned): `9986a19bcc2860a5bc171be2df917b0a9769db8a2ae5c3f356604e0b411cb71c`; test file `568e9c0321300e39aa70c7ccac30ac84588283ef37f95104eee7b1f38ab71ef2`.
- GREEN without write (`green.txt`, `green2.txt` after all mutants): `Tests 1 passed (1)`, golden unchanged. `DATABASE_URL`, `CI` unset on this machine.
- typecheck + lint exit 0 for `@markiro/api`, `@markiro/domain`, `@markiro/standalone`.
- PRETTIER GATE live: run from inside the worktree root with repo-relative paths and `--ignore-path`: "Checking formatting… All matched files use Prettier code style!" for the 3 files; liveness proof: appending `const   x  =  1` made it warn (exit 1), file restored byte-identically (sha equal). `git diff --check` clean. `grep -rnF '\u04'` over the 3 files: nothing; `\u001d` appears 10 times in cases.json (as the plan states Russian text is literal).
- Test counts: plan says `apps/api` +1 file, 1 test; measured the same. Standalone Vitest/cargo untouched by this task (not run). No React, so the delayed-`setImmediate` stand is not applicable.

## CI wiring (read-only, `tools/ci/affected.mjs` `classifyChangedFiles`)

| Changed path                                                           | Jobs selected                                                                                                                                                                             |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain/test/fixtures/print-forms-parity/{cases,golden}.json` | verify_static, **verify_api_tests**, **verify_app_tests**, production_bundle, station_rust, station_windows_build, **standalone_rust**, **standalone_windows_build** (domain shared jobs) |
| `apps/api/test/standalone-forms-parity.test.ts`                        | verify_static, verify_api_tests, tenant_team_infrastructure, production_bundle                                                                                                            |
| `apps/api/src/modules/code-search/code-search.controller.ts` (control) | the same four as the line above                                                                                                                                                           |

So a fixture change runs the cloud test (verify_api_tests) and the standalone Vitest (verify_app_tests); a cloud-source-only change runs only the api job, where the parity test fails: the intended alarm. No gap; `affected.mjs` and `ci.yml` untouched.

## Mutants (all restored; `restore=ok` = sha256 equal AND `cmp` against a pre-mutation copy under `/tmp/claude/impl-pof-t3/bak-*`)

Method. The cloud controllers live in `apps/api/src`, which must not change, so the controller mutants ran on a SCRATCH COPY (`apps/api/test/zz-scratch/{code-search,shifts}.controller.ts` with rewritten relative imports plus a scratch copy of the test; deleted afterwards, `ls … | grep -c zz-scratch` = 0; a control run with no mutation passes). The domain renderers are consumed through `packages/domain/dist` (build output, ignored by git), so the renderer mutants edited the built `.js` in place and restored it. Case/golden/test mutants edited the committed files in place. Driver: `/tmp/claude/impl-pof-t3/{mut.py,run-test-mutants.py}`, outputs `mut-*.txt`. Every killed row fails the single test `the cloud's controllers answer the golden HTML for every shared case`, with the case name in the assertion message.

There is NO fake db in this test (the brief runs the cloud loaders' SQL nowhere: the loader input is hand-built in `cloud`), so there are no db-replica mutants; the loaders' rules (live vs removed items, which boxes stood on a pallet, their order and ties, the late box, the unclosed box) are bound by the host tests of Tasks 1-2 (`office_reports.rs`: `ties_come_by_id_and_a_box_closed_after_its_pallet_stays_in_its_list`, `the_codes_come_by_gtin_then_serial_byte_for_byte`, `a_box_taken_apart_prints_what_its_disassembly_took_out…`, `the_pallet_forms_read_every_pallet_with_every_box_that_stood_on_it`). Here a rule is bound if either a renderer/controller rule or the loader's RESULT in the case input reaches the bytes.

### Cloud controllers (scratch copy)

| Rule                                | Case that binds it                                                          | One-line mutant                            | Result                                                       |
| ----------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------ |
| box form time zone                  | box-closed (Moscow), box-disassembled (Yekaterinburg), box-open-empty (UTC) | C1 `renderBoxReportHtml(data)`             | KILLED box-closed                                            |
| pallet form time zone               | pallet-report-closed (Vladivostok), -open (Moscow)                          | C1b `renderPalletReportHtml(data)`         | KILLED pallet-report-closed                                  |
| shift number on the shift placards  | shift-placards-a5 (`OCT26-004/S`)                                           | C2 `…, null)`                              | KILLED shift-placards-a5                                     |
| placard paper format A5             | placard-a5-disassembled                                                     | C3 `renderPalletPlacardHtml(data, "a4")`   | KILLED                                                       |
| shift placards format               | shift-placards-a5                                                           | C3b `"a4"`                                 | KILLED                                                       |
| shift placards in closing order     | shift-placards-a5 (…41, …40, …43 is not SSCC order)                         | C4 `[...data.pallets].reverse()`           | KILLED                                                       |
| Content-Type header                 | every case                                                                  | C5 drop `res.setHeader("Content-Type", …)` | KILLED `expected undefined to be 'text/html; charset=utf-8'` |
| task form data reaches the renderer | task-form-planned                                                           | C6 `{ ...data, plannedDate: null }`        | KILLED task-form-planned                                     |

### Domain renderers (dist, in place)

| Rule                                                     | Case                                               | Mutant                                | Result                       |
| -------------------------------------------------------- | -------------------------------------------------- | ------------------------------------- | ---------------------------- |
| retired box not counted on the pallet (totals)           | pallet-report-closed (retired box, cloud count 12) | D1 `liveBoxes` returns all boxes      | KILLED                       |
| retired box shows «—»                                    | pallet-report-closed                               | D2 print `box.codeCount`              | KILLED                       |
| retired-box «снят» time in the zone                      | pallet-report-closed                               | D3 zone `"UTC"`                       | KILLED                       |
| pallet title time in the zone                            | pallet-report-closed                               | D3b `"UTC"`                           | KILLED                       |
| organization without INN                                 | box-open-empty                                     | D4 empty instead of «ИНН не указан»   | KILLED                       |
| empty box note                                           | box-open-empty                                     | D5 «Пусто»                            | KILLED                       |
| placard summary skips a retired box                      | placard-a4                                         | D6 drop the `continue`                | KILLED                       |
| placard box/unit counts skip a retired box               | placard-a4                                         | D11 `live = data.boxes`               | KILLED                       |
| inclusive expiry (10 days → 17.10.2026)                  | placard-a4                                         | D7 `shelfLifeDays` instead of `- 1`   | KILLED                       |
| watermark of a disassembled pallet                       | placard-a5-disassembled                            | D8 `false`                            | KILLED                       |
| shift placards come in the caller's order                | shift-placards-a5                                  | D9 sort by SSCC                       | KILLED                       |
| open pallet «Без SSCC»                                   | pallet-report-open                                 | D10 empty                             | KILLED                       |
| КМ text escaped (`&<>"'`)                                | box-closed                                         | D12 unescaped                         | KILLED                       |
| counterparty row only when present                       | task-form-planned vs -active                       | D14 always                            | KILLED task-form-active      |
| «Агрегация с паллетами»                                  | task-form-planned                                  | D15                                   | KILLED                       |
| shift date / production date / plan fallbacks            | task-form-planned                                  | D16, D17, D18                         | KILLED                       |
| pallets text needs `palletsEnabled`, not only a capacity | none                                               | D13 `data.palletBoxCapacity === null` | **SURVIVED** (see concern 1) |

### Cases and golden (committed files, in place)

| Rule                                                                                                              | Mutant                                       | Result                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| order of a pallet's boxes (closing order)                                                                         | X1 swap two cloud boxes                      | KILLED                                                                                                                                                      |
| order of the placards                                                                                             | X2 swap two pallets                          | KILLED                                                                                                                                                      |
| time zone per case                                                                                                | X4 Yekaterinburg → Moscow (box-disassembled) | KILLED                                                                                                                                                      |
| INN present/absent                                                                                                | X5                                           | KILLED                                                                                                                                                      |
| disassembled status / retired box in the placard                                                                  | X7, X8                                       | KILLED                                                                                                                                                      |
| shelf life absent                                                                                                 | X10                                          | KILLED                                                                                                                                                      |
| counterparty, print name, pallets flag                                                                            | X9, X11, X12                                 | KILLED                                                                                                                                                      |
| order of a box's codes                                                                                            | X13 swap two codes                           | KILLED                                                                                                                                                      |
| clock `generatedAt`                                                                                               | X15 +1 min                                   | KILLED                                                                                                                                                      |
| retired pallet box is un-retired                                                                                  | X16                                          | KILLED                                                                                                                                                      |
| cloud count of a retired box (12 vs 0)                                                                            | X3 12 → 0                                    | **SURVIVED, equivalent**: the form prints «—» and leaves it out of the totals, so host 0 and cloud 12 give the same bytes (this is why the host may send 0) |
| second-precision of the retired-box time                                                                          | X14 `+1 ms`                                  | **SURVIVED, equivalent**: the form prints minutes                                                                                                           |
| golden: html char / bytes / sha / deleted key / swapped keys / extra key                                          | G1-G6                                        | all KILLED                                                                                                                                                  |
| test: `disassembledAt` lost in `placardData` / `palletData`                                                       | T1, T2                                       | KILLED                                                                                                                                                      |
| test: shift number null in the fake service                                                                       | T3                                           | KILLED                                                                                                                                                      |
| test: time zone not routed to the box / pallet controller; format not routed to the placard / placards controller | T4-T7                                        | KILLED                                                                                                                                                      |
| test: `openedAt` / `generatedAt` instants lost                                                                    | T8, T9                                       | KILLED                                                                                                                                                      |
| test: Content-Type assertion deleted                                                                              | T10                                          | SURVIVED by construction (an assertion's own deletion); the assertion itself is bound by C5                                                                 |
| write guard `if (process.env.CI)` → `if (false as boolean)`                                                       | W1 with `CI=true FORMS_PARITY_WRITE=1`       | the mutant PASSES (writes the golden), the guarded code FAILS with the refusal: only the guard stops it                                                     |

## Concerns

1. **No case separates `palletsEnabled=false` from "capacity set"** (D13 survived). `task-form-active` has `palletsEnabled:false` AND `palletBoxCapacity:null`. The shift in the host data can legitimately be `palletsEnabled:false` with a stale capacity (`shifts.pallet_box_capacity` stays when a shift is edited off pallets): the form prints «Не собираются» in the cloud, and the Task 4 `form-data.ts` mapper must keep passing `palletsEnabled` and the capacity as they are. I did not add a case: it would change `cases.json`, the pinned golden hash and the counts that Tasks 4+ assume. Suggest (owner's call) one more `task-form-*` case appended at the end (pallets off, capacity 40) when Task 4 is written.
2. **No case has a box closed AFTER its pallet closed (the late box), an unclosed box on a pallet, or an org that is `null`** (the cloud's «Профиль организации не заполнен»; the host's `organization` is not nullable, so it could not be a parity case anyway). The late-box ordering and the unclosed-box listing are loader rules (cloud `orderBy(closedAt, id)`, no closed filter); they are bound by the host tests named above, not by this test. Appending such cases would also change the pinned hash.
3. The cloud half cannot catch a drift in a cloud LOADER (SQL), as the plan states in «Контракт для облака»; only the controller/renderer half is guarded.
4. The cloud mutants ran on scratch copies and the domain mutants edited `dist` (build output) in place and restored it (cmp + sha equal each time); `apps/api/src` and `packages/domain/src` were never touched. I accidentally used `cd` in three Bash calls; no stray `.claude/.cc-writes` appeared in the tree (`git status` empty).
5. The `taskForm` controller also sets `Cache-Control: private, no-store`; the brief's test checks only `Content-Type`. Not changed.

## Fix round (concern 1)

Commit `a041000fe test(api): the print-form parity cases separate pallets switched off with a stale capacity from pallets on without one` (one trailer; 2 files: `cases.json` +194 lines, `golden.json` +10 lines; nothing under `apps/api/src`; `git status --short` empty).

### Cases appended at the end of `cases.json` (copies of `task-form-active`, only shift number, `palletsEnabled`, `palletBoxCapacity` changed in both `host.shift` and `cloud`)

- `task-form-pallets-off-stale-capacity` (`OCT26-006`): `palletsEnabled:false`, capacity 40. Observed cloud output: «Агрегация», «Не собираются», no «Паллета закрывается автоматически» rule.
- `task-form-pallets-on-no-capacity` (`OCT26-007`): `palletsEnabled:true`, capacity null. Observed cloud output: «Агрегация с паллетами», «Не собираются», no pallet rule.
- Expectations come from the real cloud controller through the test's write mode (`FORMS_PARITY_WRITE=1`, CI and DATABASE_URL unset), not guessed. A zero capacity was not added: the host never holds it.

### Golden / counts

- Old 10 keys byte-equal to the pre-round golden (checked key by key); `cases.json` diff is insertions only (0 deletions); formatted with prettier.
- NEW runs: 12 (was 10). NEW golden.json SHA-256 `58d40eb3f5f77bf7e7feb54a53c4eda26ea02640cbe4ebac9cd7b83b3533520f` (old `8a7814ce…`). NEW cases.json SHA-256 `2a971a11a27c2b17c8e532ec4e6bbb134fe5b1a07a76ba7ad3d5735a0b0a2974` (old `9986a19b…`).
- Check mode: `Tests 1 passed (1)` verbose, not skipped, without DATABASE_URL.

### Mutants on the built domain renderer `packages/domain/dist/print-forms/shift-task-form.js` (restored: shasum -c OK + cmp OK against `/tmp/claude/fix-pof-t3/dist-bak.js`; `dist` otherwise untouched, git-ignored)

| Mutant                                                                                               | Before               | Now                                           |
| ---------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------- |
| D13 `!data.palletsEnabled \|\| data.palletBoxCapacity === null` -> `data.palletBoxCapacity === null` | SURVIVED             | KILLED `task-form-pallets-off-stale-capacity` |
| D13b -> `!data.palletsEnabled` (sibling: pallets on, no capacity)                                    | SURVIVED (not tried) | KILLED `task-form-pallets-on-no-capacity`     |
| D19 rule line: drop `data.palletsEnabled`                                                            | n/a                  | KILLED `task-form-pallets-off-stale-capacity` |
| D20 rule line: drop `palletBoxCapacity !== null`                                                     | n/a                  | KILLED                                        |
| control (no mutation, after restore)                                                                 |                      | `Tests 1 passed (1)`                          |

### Gates

typecheck + lint exit 0 for `@markiro/api`, `@markiro/domain`; prettier check on both JSON files passes (liveness proof by appending invalid JSON gave exit 2, a parse failure, not a style warning; the file was restored, sha equal); `git diff --check` clean; no `\u04` in the fixtures.
