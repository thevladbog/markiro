# Merge report: claude/integration (32f062614) into claude/floor-2a7 (4e7ff10bb)

Status: DONE. Merge commit `f5b1707f1` (parents 4e7ff10bb, 32f062614), worktree /tmp/claude/wt/flr, tree clean, no push/fetch/stash/branch.

## Conflicts (4 textual, all unions) plus 1 semantic duplicate

- `apps/standalone/AGENTS.md`: HEAD block (Floor exceptions and close, Floor pallets) then integration block (Shift exports, Shift card and printed forms, Backups and restore); no duplicate `##` heading; order checked. One wording fix: the retention known limit said "plan РК or the owner decides" about the missing outbox/floor_exceptions shift indexes; РК is merged and added no station migration, so it now says that and "the owner decides". The pallets known limits (no shift index on floor_pallet_exceptions, no kept close intent, 2x10 s serial wait, 2b) are still true.
- `test/box-template-choice.test.ts`: both pallet-template suites kept (ПЛ-Ц and О-Ф describes, distinct scopes).
- `test/protocol.test.ts`: both tests kept (device-shift-create with pallets, ПЛ-Ц; export record, ЧЗ).
- Pilot spec: §18 ПЛ-Х, §19 ПЛ-Ц, §20 ЧЗ, §21 О-Ф, §22 РК, §23 УСТ; blank line added before §20; "reserved for ПЛ-Ц"/"not yet merged" wording in §20, §22 and §23 intros updated.
- Semantic (auto-merged, no marker): `src/lib/box-template-choice.ts` had `suggestPalletTemplate`, `PalletTemplateProduct`, `PalletTemplateDefaults` declared twice (ПЛ-Ц and О-Ф). Kept О-Ф's (shared `firstFitting`/`categoryDefault`, `defaults` nullable, a superset of ПЛ-Ц's signature), removed the ПЛ-Ц copy, doc comment names both plans. Callers (NewShift.tsx, new-shift.ts, ShiftDialog.tsx) unchanged and typecheck.

## Semantic checks

- Shell migrations: src-tauri/migrations 0001-0008 (0008_floor_pallets from floor; integration added none); host migrations 0011_backups (integration) and 0012_pallets (floor) coexist (AGENTS already documents 0011-after-0012); floor-schema/floor-pallet-schema tests and cargo green.
- export-formats.json lists 11 shift formats + pallet; protocol.test parity passes. error-codes.json = Rust `codes::ALL` = `API_ERROR_CODES` (18 each, identical sets). hello, hello-future, hello-restored fixtures present. `no_secrets_in_logs` facts_files == 17 passes. lib.rs `generate_handler!` = union of both sides (25 handlers, no duplicates). All JSON under src/i18n and proto/fixtures free of duplicate keys (script). nav/routes/access entries compile and tests pass.
- Rasterizer (integration #703) with floor print code (`floor/print/label-render.ts`) and pallet label rendering: `floor-label-render`, `label-raster`, `stock-templates-render`, `template-preview` all pass in the full run.

## Gates

- turbo build of `@markiro/standalone^...` (domain, platform-contracts, ui): OK. Standalone typecheck, lint, build: exit 0.
- Vitest full (--testTimeout=60000 --hookTimeout=60000): 146 files, 4521 tests passed, 0 failed, 0 errors (includes export-parity and forms-parity).
- domain 1193, platform-contracts 381, ui 240 tests passed.
- `cargo fmt --check --all`: clean. `cargo test --workspace --offline --locked` (unsandboxed): 71 result lines, 1118 passed, 0 failed, 0 ignored, 0 warnings.
- Prettier gate: proven live (scratch file exit 1, deleted); 900 prettier-parsable files changed vs first parent (cwd worktree root, repo-relative, --ignore-path .prettierignore): clean. `git diff --check 4e7ff10bb HEAD`: clean. `git status --short`: empty.

## Not exercised

Windows, printers (TSPL EAN128 change from main reaches the floor print path: needs a hardware check), WebView2, API DB-backed tests, production-browser/release contracts.
