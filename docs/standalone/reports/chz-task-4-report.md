# plan ЧЗ, Task 4 report — byte reference from the cloud code

Status: DONE_WITH_CONCERNS (concerns = case-set gaps found by extra mutants; nothing blocks the task).
Worktree `/tmp/claude/wt/chz`, branch `claude/office-chz`, base `fb0a96394`. Commit: `72d38a505 test(api): the cloud's own export renders the parity cases of the standalone office` (one trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, verified with `git log -1 --format=%B`).

## What was done

Added exactly three files, nothing else (`git diff --name-only HEAD~1 HEAD`; nothing under `apps/api/src`):

- `apps/api/test/standalone-export-parity.test.ts`
- `packages/domain/test/fixtures/shift-export-parity/cases.json` (12 cases)
- `packages/domain/test/fixtures/shift-export-parity/golden.json` (written by the cloud test)

The test file and `cases.json` were extracted mechanically from the brief's code blocks (lines 22–456 and 463–1434) and are byte-identical to them (`cmp`). Anchor adaptations: none (the task only creates files). Hand-typed code: none. `\u04` grep over all three files: nothing; the only `\uXXXX` in the JSON is `\u001d` (53 in cases, 563 in golden).

## Evidence

- RED (`/tmp/claude/impl-chz-t4/red.txt`): `Error: ENOENT … shift-export-parity/golden.json`, `Tests  1 failed (1)`, as the plan states.
- Golden written with `EXPORT_PARITY_WRITE=1`: `Tests  1 passed (1)`; 197 runs (115 `{error}` outcomes, 82 with parts).
- **Golden SHA-256 = `95bede8a0af46ff7d026693ee13c0cb9e120e156b0d3843f2654a078d3a87220`, equal to the plan's pin.** No drift between cloud code/base and the plan's copy.
- GREEN without write (`green.txt`, verbose): `✓ …render exactly the golden bytes, names, counts and refusals`, `Tests  1 passed (1)`; golden unchanged afterwards (`cmp`). Re-run after the commit: also 1 passed; one run takes ~0.25 s test time (~3.5 s with transform). No timeouts occurred under the machine load, so nothing to re-run.
- No database: `DATABASE_URL` unset (`echo` shows `unset`), no Docker; the test reaches the cloud code only through hand-built fake `db` objects, and an unexpected table read throws. Not skipped: verbose output shows `✓`, `Tests 1 passed (1)` and no "skipped". `apps/api/vitest.config.ts` has no DB gate.
- typecheck + lint exit 0 for `@markiro/api` (its tsconfig includes `test`), `@markiro/domain`, `@markiro/standalone`.
- PRETTIER GATE (live): run from inside the worktree root with repo-relative paths and `--ignore-path /tmp/claude/wt/chz/.prettierignore`: `Checking formatting...`, `All matched files use Prettier code style!` for the three files. Liveness proof: appending `const   x  =  1` to the test made it print `[warn] apps/api/test/standalone-export-parity.test.ts`, exit 1; restored byte-identically (`cmp`). (My first call quoted the file list as one word and matched nothing — it said "No files matching", not a clean pass; redone correctly.)
- `git diff --cached --check` clean; `git status --short` empty after the commit; scratch files all removed (`ls apps/api/test | grep -c zz-scratch` = 0).
- Counts: plan says `apps/api` +1 file, 1 test, 197 runs; measured the same. Cargo/Vitest of standalone untouched by this task.

## CI wiring (read-only inspection, `tools/ci/affected.mjs` run via `classifyChangedFiles`)

| Changed path                                                                                                                   | Jobs enabled                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain/test/fixtures/shift-export-parity/{cases,golden}.json` (falls under `packages/domain/` → `sharedJobs.domain`) | verify_static, **verify_api_tests**, **verify_app_tests**, production_bundle, station_rust, station_windows_build, **standalone_rust**, **standalone_windows_build** |
| `apps/api/test/standalone-export-parity.test.ts`                                                                               | verify_static, verify_api_tests, tenant_team_infrastructure, production_bundle                                                                                       |
| `apps/api/src/modules/shift-exports/shift-export-source.service.ts`                                                            | the same four as the line above                                                                                                                                      |

So a fixture change runs the cloud test (`verify-api-tests`: `turbo test --filter=@markiro/db --filter=@markiro/api`, DATABASE_URL set there, which the test ignores) and the standalone Vitest (`verify-app-tests`: `turbo test --filter=!db --filter=!api` includes `@markiro/standalone`). A change of the cloud export source alone runs only the api job: the parity test fails there, which is the intended alarm; the golden regeneration then touches the fixtures and brings in the standalone jobs. No gap needing an edit; I did not touch `affected.mjs` or `ci.yml`.

## Guard / mutant table

Plan mutants C1–C6 mutate the cloud source. The task text forbids changing `apps/api/src`, so I did not edit it in place: each cloud mutant ran on a scratch COPY of `shift-export-source.service.ts` and `shift-export-runner.service.ts` (the runner is copied too because it does `instanceof ShiftExportSourceError` of the source module) under `apps/api/test/zz-scratch-src/`, with relative imports rewritten and a scratch copy of the test pointing at it; all of it deleted afterwards. Control run on that harness with an identity "mutation": passes (so failures are real). Scripts: `/tmp/claude/impl-chz-t4/{cloudmut,drive,drive2,filemut}.py`; outputs `mut-*.txt`. The mutants of my own files (golden, cases, test) were applied in place and restored from copies under `/tmp/claude/impl-chz-t4/bak-*` with `cmp` + sha256 equality (every row below printed `restored`).

All killed rows fail the single test `render exactly the golden bytes, names, counts and refusals` (the only test).

| Guard                                                        | One-line mutant                                                                                                                                                      | Result / key line                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| cloud: pallets with equal closedAt ordered by SSCC (plan C1) | drop `compareCodeUnits(left.sscc, right.sscc)` tie-break                                                                                                             | KILLED, `pallets/shift_txt_pallets@1/-`                                                 |
| cloud: codes by time then hash (C2)                          | drop the time compare                                                                                                                                                | KILLED, `boxes/shift_txt_flat@1/-`                                                      |
| cloud: suppressed open-pallet boxes counted (C3)             | `+= 1` → `+= 0`                                                                                                                                                      | KILLED, `pallets/shift_txt_pallets@1/-`                                                 |
| cloud: boxes by SSCC (C4)                                    | drop the `.sort(...)` of boxes                                                                                                                                       | KILLED, `boxes/shift_txt_boxes@2/-`                                                     |
| cloud: codes by time only (C5)                               | drop the hash tie-break                                                                                                                                              | KILLED, `boxes/shift_txt_flat@1/-`                                                      |
| cloud: disassembled pallet in groups (C6)                    | filter out pallet `…0004`                                                                                                                                            | KILLED, `pallets/shift_txt_pallets@1/-`                                                 |
| cloud: displaced items excluded                              | drop `row.displacedAt === null`                                                                                                                                      | KILLED, `boxes/shift_txt_boxes@2/-` (BOX_COVERAGE_INCOMPLETE)                           |
| cloud: disassembled boxes excluded                           | drop `row.disassembledAt === null`                                                                                                                                   | KILLED, `disassembled-live/shift_txt_boxes@2/-`                                         |
| cloud: removed items excluded                                | drop `row.removedAt === null`                                                                                                                                        | **SURVIVED** (see concern 1)                                                            |
| cloud: only closed boxes eligible                            | drop `row.closedAt !== null`                                                                                                                                         | **SURVIVED** (see concern 1)                                                            |
| golden check mode: byte                                      | `bytes` of one part +1 in golden.json                                                                                                                                | KILLED, `boxes/shift_txt_flat@1/-`                                                      |
| golden check mode: text                                      | one char of a КМ in golden text                                                                                                                                      | KILLED, same key                                                                        |
| golden key set                                               | delete key `coverage/shift_txt_flat@1/-`                                                                                                                             | KILLED, `Object.keys` 197 vs 196                                                        |
| golden key order                                             | swap two adjacent keys                                                                                                                                               | KILLED, `Object.keys` order                                                             |
| case → golden binding: order                                 | tie-break code's `scannedAt` +1 ms (changes order)                                                                                                                   | KILLED (a +1 ms on the LAST code, K1, survives: equivalent, order and output unchanged) |
| binding: КМ text                                             | one char in a canonical КМ                                                                                                                                           | KILLED                                                                                  |
| binding: shift closedAt                                      | `…00.412Z` → `…00.413Z`                                                                                                                                              | KILLED, `boxes/shift_xml_gismt_aggregation@1/-`                                         |
| binding: INN / org name                                      | one digit / one char                                                                                                                                                 | KILLED, same XML key                                                                    |
| binding: case name                                           | rename `bad-cis`                                                                                                                                                     | KILLED (key set)                                                                        |
| case coverage: line limit                                    | remove `20` from `boxes.maxLines`                                                                                                                                    | KILLED (key count 187 vs 197)                                                           |
| case coverage: pallet run                                    | remove pallet `…0009` run                                                                                                                                            | KILLED (196 vs 197)                                                                     |
| case coverage per format                                     | test: `SHIFT_EXPORT_FORMATS.slice(0,-1)`                                                                                                                             | KILLED (178 vs 197)                                                                     |
| case coverage per format                                     | test: `palletRuns.slice(1)`                                                                                                                                          | KILLED (195 vs 197)                                                                     |
| hash pin                                                     | n/a in code — the pin `95bede8a…` is in the plan only; any golden or case change is caught by content equality (rows above); the in-repo "pin" is golden.json itself | reproduced equal                                                                        |
| fake SQL replica: box ordering of a pallet                   | flip `left.id < right.id` order                                                                                                                                      | KILLED, pallet `…0002`                                                                  |
| fake: box filter `disassembledAt === null`                   | drop it                                                                                                                                                              | KILLED, pallet `…0001`                                                                  |
| fake: displaced flag honoured                                | `displacedAt` always null                                                                                                                                            | KILLED                                                                                  |
| fake: pallet closedAt                                        | `closedAt: null`                                                                                                                                                     | KILLED (PALLET_NOT_CLOSED)                                                              |
| fake: frozen clock for the pallet loader                     | drop `vi.setSystemTime`                                                                                                                                              | KILLED, pallet `…0001`                                                                  |
| fake: box filter `closedAt !== null`                         | drop it                                                                                                                                                              | **SURVIVED** (concern 1)                                                                |
| fake: removed flag honoured                                  | `removedAt` always null                                                                                                                                              | **SURVIVED** (concern 1)                                                                |
| no-DB run / no silent skip                                   | n/a mutant; run with DATABASE_URL unset, ✓ shown, unexpected-table throw in the fake                                                                                 | verified by run                                                                         |
| write mode not silently on                                   | the non-write run leaves golden byte-identical (`cmp`), and the C1–C6/golden kills above are impossible if check mode wrote                                          | verified                                                                                |

## Concerns

1. **The 12 cases do not isolate two exclusion rules of the cloud source.** `removed: true` items occur only in boxes that are already excluded for another reason (disassembled box `…5031`, an unclosed box without SSCC, a disassembled pallet-box), and no box on a pallet is unclosed. Hence the cloud mutants "drop `row.removedAt === null`" and "drop `row.closedAt !== null`" and the matching fake-replica mutants survive; the golden is blind to those two rules, and so would be the standalone port's equivalents. A cheap fix: one more case (a closed, SSCC-bearing, non-disassembled box with a `removed:true` item whose code is not in the registry, plus an unclosed box with SSCC and an item) — it would make coverage fail under either mutant. I did NOT add it: it changes `cases.json`, the pinned golden hash `95bede8a…` and the run/test counts that Tasks 5–9 assume (197/198/206). Your call.
2. The `EXPORT_PARITY_WRITE=1` mode rewrites the golden and then compares it with itself, so it can never fail; only the default mode is a check (by design, as the plan has it). If a CI job ever exported that variable, the guard would vanish silently. Not changed.
3. Cloud mutants were run on scratch copies rather than in place (the rule against editing `apps/api/src`); plan procedure otherwise followed (copy, hash, run, restore, `cmp`), and the in-tree files were never touched.

## Fix round (concern 1 and 2)

Commit `e7b52dd1d test(api): the export parity cases bind the removed-item and unclosed-box rules, the write mode refuses CI` (one Co-Authored-By trailer; 3 files: the test, `cases.json`, `golden.json`; nothing under `apps/api/src`). `git status --short` empty afterwards.

### Cases added (appended at the end of `cases.json`, so the 197 old golden keys are unchanged)

Expectations were read off the real cloud output through the test's own write mode, not guessed.

- `removed-item-moved` (closed shift, no pallets): box 1 (closed, SSCC) holds code K1 live and code K2 REMOVED; box 2 (closed, SSCC) holds K2 live. Cloud: `shift_txt_boxes@2` etc. export box 1 = [K1] and box 2 = [K2] (checked in the golden text: box 1 carries only K1); the pallets formats give `SHIFT_HAS_NO_PALLETS`. Dropping `removedAt === null` counts K2 twice, so the cloud answers `BOX_COVERAGE_INCOMPLETE`.
- `open-box-on-pallet` (closed shift, pallets on): box 1 closed on closed pallet P1, box 2 WITH an SSCC, never closed, also on P1 and holding K2 live; `palletRuns` = [P1]. Cloud: flat formats succeed (2 codes); boxes/pallets/XML shift formats give `BOX_COVERAGE_INCOMPLETE` (K2 is only in an unclosed box); the per-pallet XML for P1 lists ONE box (the closed one). Dropping `closedAt !== null` makes box 2 eligible and the boxes formats succeed; dropping the per-pallet SQL filter lists box 2's SSCC.

### Golden

Regenerated with `EXPORT_PARITY_WRITE=1`, then the plain check mode passes (1 test, not skipped, `DATABASE_URL` unset).

- NEW golden.json SHA-256: `17b06c6be128baa2cfe09f9178b24d26f3e2ea9563bc0f7e12fffc2405b5d8c9` (old `95bede8a…`).
- NEW counts: 218 runs (was 197): 128 `{error}` outcomes (was 115), 90 with parts (was 82). +21 runs = 10 + 11. cases.json SHA-256 (not pinned anywhere): `ff9c379a7d0f943c79291526afc76d71d10901f2890e09cbee14d627facc24a0`.
- The plan's 197/198/206 style counts for Tasks 5-9 (a Vitest test per run key, if any) move by +21; the test of Task 4 itself is still 1 test.

### Mutants (scratch copies as in the first round, `apps/api/src` untouched; control with an identity mutation passes)

| Mutant                                                             | Result / key line                                                                                                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| cloud: drop `row.removedAt === null`                               | KILLED: `removed-item-moved/shift_txt_boxes@2/-: expected { error: 'BOX_COVERAGE_INCOMPLETE' } to deeply equal …` (was SURVIVED)                                                                       |
| cloud: drop `row.closedAt !== null`                                | KILLED: `open-box-on-pallet/shift_txt_boxes@2/-: expected {…} to deeply equal { error: 'BOX_COVERAGE_INCOMPLETE' }` (was SURVIVED)                                                                     |
| fake db: per-pallet box filter without `box.closedAt !== null`     | KILLED: `open-box-on-pallet/pallet_xml_gismt_aggregation@1/a0000000-…0001` (was SURVIVED)                                                                                                              |
| fake db: `removedAt: null` always                                  | KILLED: `removed-item-moved/shift_txt_boxes@2/-` (was SURVIVED)                                                                                                                                        |
| write-mode guard: `if (process.env.CI)` -> `if (false as boolean)` | with `CI=true EXPORT_PARITY_WRITE=1`: guarded code FAILS with `EXPORT_PARITY_WRITE=1 is refused when CI is set…` and golden.json untouched (sha equal); the mutant PASSES (so only the guard stops it) |

Restores: test file restored from `/tmp/claude/fix-chz-t4/pre-fake.ts` / `pre-ci.ts` with `cmp` + `shasum -c` OK after every row; scratch dir `apps/api/test/zz-scratch-*` empty (0), outputs in `/tmp/claude/fix-chz-t4/`.

### Gates

- Parity test passes without `DATABASE_URL` (verbose shows the check, `Tests 1 passed (1)`, no skip); about 0.1-0.2 s test time.
- typecheck + lint exit 0 for `@markiro/api` (re-run after an overlapping first attempt), `@markiro/domain`, `@markiro/standalone`.
- Prettier gate, run from the worktree root with repo-relative paths and `--ignore-path`: "Checking formatting... All matched files use Prettier code style!" for the three files; live proof: appending `const   x  =  1` made it warn (exit 1), restored byte-identically. `cases.json` additions were formatted with prettier itself (the old part is unchanged in the diff: 146 insertions, 0 deletions).
- `git diff --check` clean; `grep -nF '\u04'` over the three files: nothing; `\u00` escapes added: only `\u001d`.
- CI wiring unchanged (`tools/ci/affected.mjs`, `ci.yml` not touched).

### Concerns

- `open-box-on-pallet` has an unclosed box that carries an SSCC and a `palletId`; the host/standalone rows must be able to express that (the cloud schema allows it, and the case is needed to bind the rule on the pallet path). If the standalone host forbids it, Task 5 must report it rather than edit the case.
- The two guard checks `CI` by truthiness (`process.env.CI`); a CI that sets `CI=0` or `CI=false` would also refuse, which is the safe side.
