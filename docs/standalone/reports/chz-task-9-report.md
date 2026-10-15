# plan ЧЗ, task 9 — report (process log walk, documents, full check)

Status: DONE_WITH_CONCERNS (concerns at the end; they are owner decisions and unverified-on-Windows items, not defects).

Worktree `/tmp/claude/wt/chz`, branch `claude/office-chz`, base `90d22dee3`.
Commit: `66d9d6e4b docs(standalone): shift exports in AGENTS and the pilot spec, the export routes in the log walk` (one trailer; no push; tree clean afterwards). Changed: `apps/standalone/host/tests/no_secrets_in_logs.rs`, `apps/standalone/AGENTS.md`, `docs/superpowers/specs/2026-10-09-standalone-pilot-mvp-design.md`. No source, manifest or lockfile change.

## What was done

1. `no_secrets_in_logs.rs`: header comment extended; after the walk reads closed shift two, the office reads `GET /v1/office/shifts/{shift_id}/export-source` (asserted to carry the pallet's SSCC and the first box's SSCC, so the check is not vacuous), `GET …/boxes`, `GET …/pallets`, and `POST …/exports` (204). `shift_id` is the first shift: closed by the office, with a pallet and boxes; every existing needle (codes with crypto tail, box and pallet SSCCs, hashes, receipt digests) therefore now also covers the new routes.
2. `AGENTS.md`: new section "Shift exports" (before "Marking rules"); "Audit" (the `shift.export` row, and that the host cannot check its counts against files); "Office pages" shifts bullet («Выгрузка» for active and closed shifts); "Logs" (export routes, shell logs by code and I/O kind, dialog logs nothing). Beyond the brief the section records the EXTRAS items: Ч1 as an OWNER DECISION still open (cloud and port change together, `toPalletsSource` / `palletsSource`), `GENERATION_FAILED` `reason` shown and never logged, the late-box property of ПЛ-Х and `late_boxes` next to `disassembled_pallets`, a taken-apart pallet still lists its boxes on the host (О-Ф must show `disassembledAt`), names/paths over 240 UTF-16 units → `invalid_request`, COM0/LPT0 accepted, no temp-then-rename, the Windows-unverified list, the dialog's per-step yielding and 0.5–2 s blocking steps at 200 000 codes (worker is the real fix, IPC size unmeasured), and that the office dialog does not use 64 px targets.
3. Pilot spec: appended **§20 «Уточнения плана ЧЗ»** (not 19). §19 is planned by ПЛ-Ц on its own branch, so this branch has a numbering gap 18 → 20; the section says so in its first paragraph. The section carries the brief's bullets plus: Ч1 owner decision, 240-unit bound, the shift.export journal row being the session's report, responsiveness, and a "not verified" bullet (Windows, ЧЗ portal acceptance, client samples, П3).

## Anchor adaptations (tree differs from the brief's base)

`check_fragments.py`: 5 of 7 fragments not exactly once.

- `no_secrets_in_logs.rs` header: the tree's sentence reads «… hash, a box's SSCC or the words of a reason (stage 2a spec §4.11): a rejected record is logged by its id and its receipt code alone» — appended the export clause by meaning.
- `no_secrets_in_logs.rs` insertion: the file is now ~1750 lines (pallets, shift two). Inserted the export reads after the `shift_two_read` assertions, before «A wrong device key…» (the original fragment had no match). Variables: `pallet_sscc`, `sscc_one` (the tree has no `sscc`), passed by reference.
- `AGENTS.md` "Marking rules" fragment: the totals paragraph of the tree is different; the section "Shift exports" and the "Logs" paragraph were inserted at the unique `## Marking rules … ## Logs` boundary instead.
- `AGENTS.md` "Office pages": the tree's shifts bullet already had «Итоги» (so "A closed shift has no action" was stale); wrote «a closed shift has no other action than «Итоги» and «Выгрузка»».
- Spec: the brief's end-of-file fragment is the §18 text of an older version; appended §20 at the end of the file (it ends with §18's last bullet).
- Mutant L1: the brief's anchor `let rows = read(&mut tx, &id).await;` is `let rows = read(&mut tx, id, after_query).await;` in `read_rows` (line 131).

## Step 2 (guard passes immediately)

`cargo test … -p markiro-host --test no_secrets_in_logs` (unsandboxed): `test result: ok. 2 passed` (plan: 1 passed; the tree has a second test that pins the source). Output `/tmp/claude/impl-chz-t9/nsl1.txt`.

## Mutants (harness `/tmp/claude/impl-chz-t9/mut.py`: anchor exactly once, copy to `/tmp/claude/impl-chz-t9/before-*`, edit, test, restore, `cmp` + sha256, `os.utime`; every row restored)

| Mutant                                                                         | Result                                        | Killing line                                                          | Restore |
| ------------------------------------------------------------------------------ | --------------------------------------------- | --------------------------------------------------------------------- | ------- |
| L1 `office_exports.rs` `read_rows`: `tracing::info!("export source {rows:?}")` | KILLED, `secrets_never_reach_the_process_log` | `the process log contains "0104600682000020215Kp9sQxLm2w7R"` (a code) | True    |
| L2 `office_boxes.rs` `list_boxes`: log `row.sscc`                              | KILLED                                        | `the process log contains "046006820000000013"` (a box SSCC)          | True    |
| L3 `office_boxes.rs` `list_pallets`: log `row.sscc`                            | KILLED                                        | `the process log contains "146006820000000003"` (a pallet SSCC)       | True    |

Not mutated: the audit/record route logging a `document_id` (a random UUID, no needle covers it; not a secret). Without the new reads in the walk L1–L3 would pass, since the routes were never called.

## Full check

| Check                                                                                             | Plan                                                           | Measured                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo test --workspace --offline --locked`, unsandboxed, ONE run (after `build` of the webview)  | 52 suites, 779 tests (host 36/462, proto 2/53, shell 14/264)   | **52 suites (`Running`), 869 tests, 0 failed, 0 ignored** (host 36/531, proto 2/55, shell 14/283; plus 3 doc-test targets with 0 tests). The difference is the other merged streams, not this plan; the plan's increments are covered by the base shift of +21 the dispatch named plus floor/pallet tests. |
| Vitest `@markiro/standalone`, ONE full run, `--testTimeout=60000 --hookTimeout=60000`             | 85 files, 2504 tests                                           | **98 files, 3060 tests, all passed**, exit 0, no `stderr` blocks in the output (190 s on load ~50–90)                                                                                                                                                                                                      |
| `@markiro/api` `standalone-export-parity` + `shift-export-source` + `shift-export-runner` (no DB) | 52 tests                                                       | 3 files, **52 passed**; `git status` clean afterwards (the golden was not regenerated)                                                                                                                                                                                                                     |
| `@markiro/domain` `test` (fixture and export tests included)                                      | –                                                              | 71 files, **1016 passed**                                                                                                                                                                                                                                                                                  |
| `tools/ci/affected.mjs` for `…/shift-export-parity/golden.json`                                   | `verify_api_tests`, `verify_app_tests`, `standalone_rust` true | all three **true**                                                                                                                                                                                                                                                                                         |
| standalone `typecheck` / `lint` / `build`                                                         | 0                                                              | 0 / 0 / 0 (build: chunk-size warning only)                                                                                                                                                                                                                                                                 |
| api `typecheck`; `eslint test/standalone-export-parity.test.ts`                                   | 0                                                              | 0 / 0                                                                                                                                                                                                                                                                                                      |
| `cargo fmt --all -- --check`; `git diff --check`                                                  | clean                                                          | clean / clean                                                                                                                                                                                                                                                                                              |
| `grep -rnF '\u04' apps/standalone/src apps/standalone/test`                                       | only `pairing-code.ts:66`                                      | only `pairing-code.ts:66`; no `\u0` in the walk file                                                                                                                                                                                                                                                       |

Not run: `graphify update .` (no `graphify-out/` in this worktree), `cargo clippy` (not requested), a build of `@markiro/domain`/`@markiro/api` (the api tests ran on the existing dist).

### Prettier gate over the whole ЧЗ range

`git diff --name-only 91bfdbbba..HEAD` plus the working tree: 51 paths; the 38 `md/ts/tsx/json` files (the list is `/tmp/claude/impl-chz-t9/files.txt`; the other 13 are `.rs`, covered by `cargo fmt`). Run as `node_modules/.bin/prettier --ignore-path .prettierignore --check $(cat files.txt)` from inside the worktree root with repo-relative paths.

- Proved live first: a deliberately mis-formatted `apps/standalone/scratch-gate.ts` printed `Checking formatting…` / `[warn] apps/standalone/scratch-gate.ts` and exited 1; deleted.
- Proved non-vacuous: `prettier --file-info` on each of the 38 files reports `"ignored": false` (38 of 38), including `golden.json`, `cases.json`, the proto fixtures and `ru.json`.
- Result: `All matched files use Prettier code style!`, exit 0 (output `prettier.txt`). No prior vacuous-clean discovery: nothing in the range was hidden by the ignore file; I found no file that earlier reports had called clean while it was ignored. (The earlier reports' own gates were the live-proved form; I did not re-derive their historical runs.)

## Manual Windows / external check list (owner)

1. Save an export whose shift number or product name has Cyrillic (and a «/S» station shift number): the folder `Документы\Markiro\Выгрузки\<номер>\<дата_время>_<формат>` appears with the right names; byte-compare the files to the cloud's export of the same shift.
2. A PC whose «Документы» is redirected by OneDrive: `document_dir()` resolves and the files land there.
3. «Открыть папку» starts `%SystemRoot%\explorer.exe` with a Cyrillic and a spaced path (quoting); a junction/symlink on the way is refused.
4. A long product name under a long Documents path: the 240-unit refusal shows the plain-words text; a path near MAX_PATH.
5. The client's largest shift (200k+ codes): time to open the dialog (Zod parse of the host answer, IPC size), each step's blocking, memory, that cancel works, and whether a worker is needed.
6. Upload the standalone's XML (boxes, pallet aggregation, one pallet) to the client's Честный знак account with internet and record the processing result.
7. Samples of files the client uploaded in recent shifts (XML, TXT/CSV) and the list of formats they use (П3): run the same shifts in the cloud and in the standalone and byte-compare.
8. The dialog in WebView2 and in the kiosk window (only jsdom so far); COM0/LPT0 names; Explorer on a locked-down profile.

## Concerns

1. OWNER DECISION Ч1 (listed in AGENTS and the spec): a taken-apart pallet is still a pallet in the shift's pallet formats (as the cloud), contradicting ПЛ-Х's «boxes without a pallet». The dialog warns with a count. If the owner decides otherwise, cloud and port change together (one line each) and the golden is regenerated.
2. The host cannot verify `shift.export` counts against files (documented in Audit).
3. The office dialog uses `md`/`compact` controls, not 64 px; the owner may want 64 px for touch panels (cross-cutting).
4. At 200k codes single steps block 0.5–2 s (jsdom, loaded machine) and the host answer is tens of MB; a worker is the real fix; WebView2 IPC size is unmeasured.
5. Spec numbering: this branch jumps 18 → 20 (ПЛ-Ц will add 19); the intro of §20 says so. Merging the branches in either order keeps the numbering unique.
6. Cargo and Vitest totals are well above the plan's because the branch contains other merged streams (floor/pallets) and tasks 5–8 added tests beyond their briefs; the ЧЗ-specific increments were reported per task.
7. Everything Windows, ЧЗ-portal and client-data related is unverified (list above).
