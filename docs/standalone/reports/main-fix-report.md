# Main-fix report: apps/standalone green after origin/main (#681, #692)

Status: DONE_WITH_CONCERNS. Worktree /tmp/claude/wt/integ, branch claude/integration, BASE 9ac6f7495. Commits:

- 8b177ccd7 test(standalone): regenerate the shift-export golden for shift_txt_boxes_reversed (#681) (golden + export-plan/checks/dialog counts + new dialog e2e test)
- 58d7d8a4c feat(standalone): the host takes the reversed boxes export format (#681) (SHIFT_FORMATS, export-formats.json, host tests)
- 01e6eb7d0 test(standalone): the TSPL box label writes the SSCC as native EAN128 (#692)
- 0a7811526 docs(standalone): eleven shift export formats and the TSPL EAN128 SSCC
  Each message ends with exactly one Co-Authored-By: Claude Opus 5.5 trailer. Tree clean; nothing pushed.

## A1. Golden

Regenerated with the cloud's writer: `EXPORT_PARITY_WRITE=1 pnpm --filter @markiro/api exec vitest run test/standalone-export-parity.test.ts` (no DB needed, 1 test passed; also passes without the write flag).
Comparison (script, output in /tmp/claude/impl-main-fix/golden-compare.txt): old 218 keys, new 239; old keys missing or changed: [] (JSON-equal); added 21, all `*/shift_txt_boxes_reversed@1/*`; old key order preserved; `git diff` shows 269 insertions, 0 deletions.
New golden sha256 `dcff4c37a4f667014f0ddb3b30a4ee7f2257a4fa00f75934a197e1179afcfdda` (old `17b06c6be128baa2cfe09f9178b24d26f3e2ea9563bc0f7e12fffc2405b5d8c9`, 118083 bytes).
Pins of the old hash / entry count: none in standalone tests, tools/ci, AGENTS.md or the pilot spec (grep for the hash, 218, 239). The Rust `office_files.rs` test reads the golden by include_str and passes on the new one (32 office_files tests).

## A2. Host

Rust: `host/src/routes/office_exports.rs` `SHIFT_FORMATS` 10 -> 11 with `("shift_txt_boxes_reversed", 1)` in the domain's order (third); this is the only place the host validates formats (`record_export`: unknown format => 400 field formatId). `proto/fixtures/export-formats.json` extended identically; `test/protocol.test.ts` (compares with `SHIFT_EXPORT_FORMATS`, order included) and host `the_formats_the_host_takes_are_the_fixtures` pass; `proto/tests/fixtures.rs` needed no change (52 passed). No other Rust/Zod enum lists formats (grep).
Host tests (`host/tests/office_exports.rs`): `every_format_is_recorded...` total 11 -> 12; new `the_reversed_boxes_format_is_recorded_at_version_one_and_no_look_alike_is` (refuses v0, v2, look-alike ids, trailing space, csv/other siblings, empty id => formatId; refuses a pallet named => palletId; no audit row; accepts v1 with maxLines/partCount and checks the exact audit row).
Mutants (orig copy and sha256 in /tmp/claude/impl-main-fix/, `sha256sum -c` OK and `cmp` identical after restore, file touched):

| id  | one-line mutant                                                      | killed by                                                                |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| M1  | reversed entry replaced by `("shift_txt_boxes", 2)`                  | the_formats_the_host_takes_are_the_fixtures, new test                    |
| M2  | reversed version 1 -> 2                                              | fixtures test, new test                                                  |
| M3  | guard widened: `&& !record.format_id.starts_with("shift_txt_boxes")` | every_format_is_recorded..., a_refused_record_writes_no_row..., new test |
| M4  | pallet guard `(None, false)` -> `(_, false)`                         | a_refused_record..., new test                                            |

## A3. Counts and end to end

export-plan: 10 -> 11 formats in the no-pallets list (5 -> 6), turns 12 -> 13 (8 without pallets), titles/comments updated. export-checks: the reversed id inserted in both lists and the refusal list (BOX_COVERAGE_INCOMPLETE), title five -> six. export-dialog: progress text `из 13`, the refused radio list gains the reversed row. Literal counts kept (not derived) so a format change stays a deliberate edit.
New dialog test `offers the reversed boxes format...`: a shift with pallets (11 radios) and one without (6 radios) both offer the enabled "[TXT][С коробами][Обратная] Отчет смены"; selecting it saves to folder `..._shift_txt_boxes_reversed`, file `Молоко_3_2_0_9_л_3pcs_2box_2026-10-08.txt` (same shape as the cloud's `_Npcs_Nbox_`, extension txt), UTF-8 (fatal decoder) text asserted literally: each box = its codes, then `00`+SSCC, blank line, boxes in SSCC order; and records formatId/version 1, counts 3/2/0 pallets. The port is descriptor-driven (`boxMode`/`extension` in export-source.ts) and bytes equal the cloud's, proven by export-parity.test.ts 240/240 on the regenerated golden.

## B. TSPL

Received `BARCODE 76,256,"EAN128",38,0,0,2,2,"00046006820000035007"`; verified against `git show 42d83f736` (#692: `EAN128` type, payload `00`+bare SSCC, no `!1`; plain Code 128 stays `128`). Only the TSPL expectation in `test/floor-label-render.test.ts` changed; its ZPL half passed untouched. No other standalone fixture/test/doc pins TSPL SSCC bytes (grep for `BARCODE`, `"128"`, `!100`, `EAN128`). Real TSC printer output (scan reads `00`+SSCC, no `!1`) needs a hardware check by the owner; recorded in AGENTS.md's Windows/hardware list (and docs/acceptance/tspl-sscc.md from #692 describes the procedure).

## C. Docs

Pilot spec: "все 10/10 форматов" -> 11 in three places (items 13, plan ЧЗ row, question П3) and a table row for the new format (prettier-aligned). AGENTS.md: shift-export section notes a new cloud format is a host change too (list, fixture, tests, 11 formats, golden 218 unchanged + 21), and the hardware list notes the EAN128 SSCC. Plans untouched.

## Gates (all in /tmp/claude/wt/integ)

- standalone typecheck, lint, build: exit 0.
- Previously failing six files (verbose, 60 s timeouts): export-parity, protocol, export-plan, export-checks, export-dialog, floor-label-render all pass.
- Full standalone Vitest `--testTimeout=60000 --hookTimeout=60000`: 133 files, 4007 passed, 0 failed (4006 + 1 new); export-dialog re-run alone after the last prettier write: 33 passed.
- Parity tests: standalone export-parity and forms-parity (in the full run) green; API `standalone-export-parity` green (1/1, no DB needed). domain 88 files/1193, platform-contracts 37/381, ui 14/240: same as before, green.
- Cargo: `cargo fmt --check --all` clean; focused host office_exports 21 passed; proto 5+6+52; src-tauri office_files 32; ONE final full `cargo test --workspace --offline --locked` unsandboxed: 70 result lines, 1112 passed, 0 failed, 0 ignored (1111 before + the new host test).
- Prettier (cwd = worktree root, repo-relative, .prettierignore): proven live with a scratch file (exit 1, deleted); changed files clean (export-dialog had needed one --write). `.rs` has no prettier parser (cargo fmt covers it). `git diff --check` clean; `grep -rnF '\u04'` only pairing-code.ts:66; `git status --short` empty.

## Concerns

1. Real TSC printer output for the EAN128 SSCC is unverified (no hardware); the standalone thermal path changes on TSC printers.
2. The first commit alone leaves protocol.test.ts red until the host commit (fixture); the four commits are green together.
3. Not run: Windows, printers, browser (production-browser), DB-backed API e2e (the parity test is DB-free).
4. The new format in the office dialog was exercised under jsdom with a fake file shell only; WebView2 saving of the file was not.
