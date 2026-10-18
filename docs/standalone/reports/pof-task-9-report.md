# Plan О-Ф, Task 9 report: process-log walk for the form-data routes, AGENTS/pilot-spec sections, full check of the OFFICE stream

Worktree `/tmp/claude/wt/chz`, branch `claude/office-chz`, base `7ab1c89cd`. Commit: **`docs(standalone): the shift card and printed forms in AGENTS and the pilot spec, the forms' routes in the log walk`** (hash: `git -C /tmp/claude/wt/chz log -1`; one trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). `git status --short` is empty after it. Artefacts (logs, mutation harness, gate script) are in `/tmp/claude/impl-pof-t9/`.

Status: **DONE_WITH_CONCERNS**. The concern is the full Vitest run: three plain full runs at `--testTimeout=60000 --hookTimeout=60000` each had load-induced failures in `print-form-dialog.test.tsx` (and once `export-dialog.test.tsx`); a fourth run with Testing Library's `asyncUtilTimeout` raised to 15 s (scratch config, deleted) was fully green (105 files, 3217 tests). Details below.

## What was done

1. `apps/standalone/host/tests/no_secrets_in_logs.rs`: header comment (anchor adaptation, see below) and, after the recorded export, the walk reads `GET /v1/office/boxes/{box1}/report-data` and `GET /v1/office/shifts/{shift_id}/pallet-report-data`. Beyond the brief the reads are **non-vacuous**: status 200, JSON parsed, and the box answer must carry the box's SSCC (`sscc_one`) and an item whose `canonical` equals the walk's `km_a.canonical` (GS in it, which the raw JSON text escapes as `\u001d`, so the brief's `text().contains(..)` could not have matched), with its `serial` and `tail`; the pallet answer must carry `pallet_sscc` and, on its first box, `sscc_one`. The walk's own existing needles (`km_a` canonical/key/serial/tail/hash, `sscc_one`, `pallet_sscc` with and without the check digit) then prove the routes log none of them.
2. `apps/standalone/AGENTS.md`: the five edits of the brief, by meaning (see adaptations): number opens the card, «С паллетами» in the planning form, new section "Shift card and printed forms", "Logs", "Verification". The section also records the accepted limitations the dispatch listed (see below).
3. `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`: new `## 21. Уточнения плана О-Ф` at the end of the file (after §20 ЧЗ), the brief's bullets plus «Принятые ограничения» and «Не проверено».
4. Full check of the whole office stream (below).

## Anchor adaptations (all mechanical, by meaning)

1. `no_secrets_in_logs.rs` header: the wrapped lines differ from the brief's (`…routes of a shift's exports, which answer with codes and SSCCs (plan ЧЗ). / Its own binary…`); I replaced those two lines with the brief's new wording (`(plan ЧЗ) and of its printed forms (plan О-Ф)…`).
2. `no_secrets_in_logs.rs` insertion: the brief's `box_id`, `sscc`, `crypto-tail-marker-1` do not exist in this file; used `box1`, `sscc_one`, `km_a.tail` (see 1 above).
3. `AGENTS.md` edit 1 and 2: matched exactly once. Edit 3 («Формы is the second root, for plan О-Ф. / ## Marking rules»): the line is wrapped differently (a name allowlist follows on the same line), so I inserted the new section before `## Marking rules` and changed the stale sentence to say plan О-Ф uses the root. Edit 4 («Logs»): the paragraph continues with later plans' text (`…and the export dialog logs nothing.`); I changed the opening sentence only. Edit 5 («Verification»): the file ends at the 2a3 sentence the brief names; the О-Ф bullet is appended after it.
4. Pilot spec: the brief's anchor (the «поздние данные» bullet) is in a different section here; §21 is appended at the end of the file (last section on this branch is §20 ЧЗ), as the dispatch directs.

## RED/GREEN and mutants (log walk)

The walk is a guard that passes at once on the correct code (`cargo test … -p markiro-host --test no_secrets_in_logs`: `2 passed` — the brief says 1; the second test pins that the library prints nothing and the facts path has three logging calls). There is no RED for a guard; the proof is the mutants (harness `/tmp/claude/impl-pof-t9/mut.py`: backup, replace exactly once, run, restore, `touch`, shasum + cmp):

| Mutant (file `host/src/routes/office_reports.rs`)                  | Result                                                                                                                                                                                                                              | Key line                                          | Restore         |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------- |
| L1 `tracing::info!("box report {rows:?}")` after `read_box`        | KILLED `secrets_never_reach_the_process_log`                                                                                                                                                                                        | needles loop (`no_secrets_in_logs.rs:1826` panic) | sha equal + cmp |
| L2 `tracing::info!("pallet report {rows:?}")` after `read_pallets` | KILLED                                                                                                                                                                                                                              | same                                              | sha equal + cmp |
| L3 `tracing::info!("sscc {:?}", r.sscc)` (box SSCC alone)          | KILLED                                                                                                                                                                                                                              | same                                              | sha equal + cmp |
| L4 `tracing::warn!("pallet {:?}", p.sscc)` per pallet              | KILLED                                                                                                                                                                                                                              | same                                              | sha equal + cmp |
| L3-debug the same line at `debug!`                                 | SURVIVES (equivalent: the host's subscriber is `LevelFilter::INFO`, `src/logging.rs:25`; documented in AGENTS "Logs" already: `debug!`/`trace!` escape the walk, the second test pins the source for `println!`/`eprintln!`/`dbg!`) |                                                   |                 |
| V1 box route clears `items`                                        | KILLED (my new non-vacuity assertion, `:1487`)                                                                                                                                                                                      | the `items.iter().any(..)` assertion              | sha equal + cmp |
| V2 pallet route clears `pallets`                                   | KILLED (`:1500`)                                                                                                                                                                                                                    | `pallets[0].sscc` assertion                       | sha equal + cmp |

(`office_reports.rs` is not in the diff after the runs.)

## Full check (the whole office stream, at HEAD with the commit's content)

- `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`: clean. `cargo check --workspace --all-targets --offline --locked`: 0 warnings, exit 0.
- **ONE full `cargo test --offline --locked --workspace --no-fail-fast` (unsandboxed): exit 0; 53 suites by `Running` lines, 895 tests, 0 failed/ignored.** Host 37 suites / 546 tests, `proto` 2 / 57, shell 14 / 292. (Plan: 53 suites / 789 tests; the base here has more tests from the merged plans: ЧЗ, 2a stream; the suite count equals the plan's. Doc-tests: 3 binaries, 0 tests.) No `warning` in the log.
- **Vitest, full, `--testTimeout=60000 --hookTimeout=60000`:**
  - run 1 (default workers): 103 files passed, 2 failed; **12 tests failed** (11 in `print-form-dialog.test.tsx`, 1 in `export-dialog.test.tsx`); 3205 passed / 3217.
  - run 2 (`--maxWorkers=4`): 7 failed (all `print-form-dialog`), 3210 passed.
  - run 3 (`--maxWorkers=2`): 5 failed (all `print-form-dialog`), 3212 passed.
  - Every failure is `TestingLibraryElementError: Unable to find role="link" and name "Карточка смены OCT26-00N"` in the shared `openCard` helper (or `radiogroup` once in `export-dialog`) — Testing Library's `findBy*` default `asyncUtilTimeout` of **1000 ms**, which `--testTimeout`/`--hookTimeout` do not raise. Machine: 12 cores, load average 50-75 during the runs (4-6x oversubscribed); a single such test takes 1.8-7 s there. The files pass when run on their own (`export-dialog` + `print-form-dialog` together: 68 passed; `print-form-dialog` alone run twice: once all pass, once 4 failed the same way; three late tests run alone with `-t` pass in 1.8-3.5 s, no accumulation across tests).
  - run 4 (scratch `vitest.scratch.config.ts` + `test/scratch-async-timeout.ts` setting `configure({ asyncUtilTimeout: 15000 })`, same 60 s limits; both files deleted, tree clean): **`Test Files 105 passed (105)`, `Tests 3217 passed (3217)`**, no stderr/unhandled/act output. Plan: 91 files / 2581 tests; the base here has more (the merged plans); the О-Ф additions are the ones listed in the plan (T1 +4+3, T2 …) and tests added by tasks beyond the brief.
  - This is not a weakened assertion in the repository; nothing was changed in tests. It is a recurring load fragility of `print-form-dialog.test.tsx` (T7 and T8 reported it too); a durable fix (e.g. `configure({ asyncUtilTimeout })` in `test/setup.ts`, or making `openCard` wait longer) is a decision for the final review, not done here.
- `pnpm … @markiro/standalone run typecheck`, `lint`, `build`: exit 0 each (build only the chunk-size warning).
- API parity: `@markiro/api exec vitest run --reporter=verbose test/standalone-forms-parity.test.ts test/standalone-export-parity.test.ts`: `Test Files 2 passed (2), Tests 2 passed (2)` (both ✓, none skipped; `DATABASE_URL` unset, check mode). `@markiro/api` `typecheck`, `lint`, `build`, and `eslint` of both parity tests: exit 0.
- Domain: `@markiro/domain` `typecheck`, `lint`, `build` exit 0; full domain Vitest `71 files, 1016 tests passed` (includes the fixture tests).
- `printf 'packages/domain/test/fixtures/print-forms-parity/golden.json\n' | node tools/ci/affected.mjs` (and the same for `cases.json`): both give `verify_api_tests:true`, `verify_app_tests:true`, `standalone_rust:true`, `production_bundle:true`, `station_rust:true`, `station_windows_build:true`, `standalone_windows_build:true`, `verify_static:true`.
- `git diff --check`: clean. `grep -rnF '\u04' apps/standalone/src apps/standalone/test`: only `src/host/pairing-code.ts:66`. `\u0` in the 27 Rust/JSON/SQL files of the range: nothing except the GS `\u001d` in fixtures (loop proven live: it lists `\u001d` files).
- **Prettier gate over the whole range `git diff --name-only -z 91bfdbbba..HEAD`** (86 files; 71 are md/ts/tsx/json/css): `node_modules/.bin/prettier --ignore-path .prettierignore --check …` from the worktree root: `All matched files use Prettier code style!`. Because the `rtk` wrapper can lie about `prettier --check`, I also ran a script using the Prettier API (`getFileInfo` + `check`, `/tmp/claude/impl-pof-t9/gate.mjs`): `{"total":71,"checked":71,"ignored":[],"bad":[]}`. Liveness proved once: a deliberately mis-formatted `apps/standalone/scratch-gate.ts` made the CLI exit 1 (`Code style issues found`); the file was deleted.
- `graphify update .`: not run (the graph is git-ignored and not present in this worktree; earlier tasks report the sandbox blocking it).

## Documented accepted limitations (AGENTS.md "Shift card and printed forms"/"Verification", pilot spec §21)

The blank's «Сформирован» is always Moscow time by parity; the domain draws synchronously (huge forms freeze the window, jsdom numbers 8 ms/code, 1.3 s/500-box pallet, 5 s/2000 boxes); once inside `openInBrowser` closing the dialog cannot stop it; the card's «Ярлыки паллет смены» button uses the cached pallet list while the dialog reads fresh; the saved HTML has no CSP (byte parity), relies on the domain's escaping; WebView2 print dialog, `@page`, `afterprint` unverified; an unclosed box on a pallet is unreachable on the host; the box-report query reads the shift's scans (0.14 s at 100 000 scans, no migration); Task 3 golden = 12 runs (sha `58d40eb3…`); the R14 test (`test/form-data.test.ts`, unknown zone) is TZ-dependent (survives on a UTC machine) — documented, not changed; card does not auto-refresh, pallet list not paged; the order of box codes is byte order vs the cloud's database collation (Ф6).

## Vacuous-clean discoveries

1. The brief's log-walk addition would have been vacuous as written (a `contains(canonical)` on raw JSON misses the escaped GS, and names that do not exist in the file); replaced by parsed, status-checked assertions with mutants V1/V2 proving they fail on empty answers.
2. A `debug!` leak in the form routes would not be seen by the walk (INFO-only subscriber): equivalent mutant, already pinned in AGENTS for other facts.
3. The `rtk` wrapper makes `prettier --check` an unreliable gate; the API-based script checked all 71 files directly and none was ignored.
4. `--testTimeout=60000` does not govern Testing Library's 1 s `findBy*` default, so "60 s limits" do not make the heavy UI suites load-proof (above).

## Merge-clash notes (section numbers)

On this branch the pilot spec ends at §20 (ЧЗ; §18 ПЛ-Х, §19 absent), so О-Ф took **§21 of the pilot spec**. Expect clashes when the streams are merged: ПЛ-Ц §19 (pilot spec; free here, no clash with 21), РК §19 (the number is claimed twice), 2a8 §20/§22 (§20 collides with ЧЗ's §20 if it targets the pilot spec; §22 is free), 2a7 §21 in the **2a spec** (a different file from the pilot spec, so no textual clash, but two plans own "§21"). `apps/standalone/AGENTS.md` will also conflict textually in "Logs", "Verification" (appended bullets from several plans) and "Office pages" (the «Смены» paragraph); resolve by keeping both sides. Task 9 added no 2a-spec section.

## Files changed

`apps/standalone/AGENTS.md`, `apps/standalone/host/tests/no_secrets_in_logs.rs`, `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`.

## Concerns

1. Full Vitest is not green at the plain 60 s limits on this loaded machine (above); it is green with `asyncUtilTimeout` 15 s. Recommend a final-review decision on raising the async util timeout for `print-form-dialog.test.tsx`/`openCard`.
2. Counts differ from the plan only because the base has more tests (cargo 895 vs 789; Vitest 3217 vs 2581).
3. Nothing in Windows/WebView2 printing, real printers, the default browser, Cyrillic/DataMatrix on paper, Postgres cloud loaders or a shift of thousands of boxes has been exercised.
