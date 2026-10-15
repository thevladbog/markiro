# Merge report: origin/main (e5ca750fd) into claude/integration (b02dac3f2)

Status: DONE_WITH_CONCERNS. Merge commit: `9ac6f7495` (parents b02dac3f2, e5ca750fd), worktree /tmp/claude/wt/integ, tree clean, no push/fetch.

## Conflict resolutions (2, both unions)

- `apps/api/src/modules/shifts/shifts.controller.ts`: kept main's pallet-sheet helpers (`sheetCaller`, `includesSheets`, `projectShift`, the `PalletSheetNodeDocument` import). The shift task form comes from `@markiro/domain` (integration deleted `shift-task-form.ts`, moving it to domain; main did not touch that file since the merge-base), so main's `./shift-task-form` import was dropped and ours kept.
- `packages/domain/src/index.ts`: both blocks kept (our print-forms exports, then main's label render-plan, mono-raster, pallet-sheet, thermal-compat, label-logo exports). No duplicate-name error: domain tsc/tests pass.

## Lockfile

`pnpm-lock.yaml` auto-merged, not touched by hand. `pnpm install --frozen-lockfile --lockfile-only` passes (lockfile consistent with all manifests; supply-chain policy check ran against the registry). The plain offline install first failed on a missing store tarball (js-yaml 5.4.1; main bumped many deps) so I ran `pnpm fetch` with registry.npmjs.org allowed, then `CI=true pnpm install --frozen-lockfile --offline --config.confirmModulesPurge=false` succeeded (the first offline try had also stopped at a no-TTY purge prompt). Lockfile unchanged by the install. `apps/api/node_modules` now exists, so `@markiro/api` could be typechecked.

## Gates

- Rebuilt via turbo (`@markiro/standalone^...` and `@markiro/api^...`): 6 tasks OK.
- Golden files unchanged (sha256 `17b06c6b…` ЧЗ export, `58d40eb3…` forms), no test or golden edited.
- `@markiro/domain`: typecheck OK, 88 files / 1193 tests pass. `@markiro/platform-contracts`: typecheck OK, 37 / 381 pass. `@markiro/ui`: typecheck OK, 14 / 240 pass.
- `@markiro/api`: typecheck OK, eslint on `shifts.controller.ts` OK (API test suite not run).
- Standalone: typecheck, lint, build all exit 0.
- `cargo fmt --check --all`: clean. `cargo test --workspace --offline --locked` (unsandboxed): 70 result lines, 1111 passed, 0 failed, 0 ignored (same as before the merge: Rust unchanged; but see concern 2).
- Prettier gate (cwd = worktree root, repo-relative, `.prettierignore`, proven live with a scratch file: exit 1, deleted): 1023 files changed by the merge vs first parent excluding the lockfile: clean. `git diff --check b02dac3f2 HEAD`: clean. `git status --short`: empty.
- forms-parity: passes (print-forms golden unaffected by #702/#703).

## Failing standalone Vitest: 6 files, 33 tests (3973 passed of 4006; full run `--testTimeout=60000 --hookTimeout=60000`)

No flake; all are deterministic consequences of two cloud changes. Nothing was edited.

### A. #681 new export format `shift_txt_boxes_reversed@1` (32 tests)

`SHIFT_EXPORT_FORMATS` in `@markiro/domain` now has an 11th shift format (codes before the box SSCC). The standalone reads the format list from the domain, so it now renders it, but:

- `test/export-parity.test.ts` (22 failed): the shared `packages/domain/test/fixtures/shift-export-parity/golden.json` has 218 keys and lacks the 21 `*/shift_txt_boxes_reversed@1/*` keys (plus the "runs exactly the golden's exports" key-list test). Main never regenerated this golden, because it exists only on our side. The cloud's own `apps/api/test/standalone-export-parity.test.ts` fails identically (same single key-list assertion), so it is a stale golden, not a standalone/cloud divergence.
  Diagnostic (golden restored byte-identically afterwards: sha1 2b854aad…, cmp OK, `git status` clean): `EXPORT_PARITY_WRITE=1` run of the API test regenerated the golden to 239 keys = the 218 old keys UNCHANGED + 21 new reversed keys only; with that regenerated golden the standalone `export-parity.test.ts` passes 240/240, i.e. the standalone's port already produces the cloud's exact bytes for the new format (and the existing 218 outcomes are untouched by #681). The fix is to regenerate: `EXPORT_PARITY_WRITE=1 pnpm --filter @markiro/api exec vitest run test/standalone-export-parity.test.ts`, commit golden.json, update the attestation/golden shas if any are pinned.
- `test/protocol.test.ts` "the host takes exactly the formats the domain advertises (export-formats.json)" (1): the Rust-side fixture `apps/standalone/proto/fixtures/export-formats.json` lists 10 shift formats; the domain now advertises 11. This one is a REAL standalone follow-up: the host's wire format list (proto fixture, Rust format ids / `codes`, host validation) does not yet accept `shift_txt_boxes_reversed`; the cargo tests are green only because they compare to the stale fixture.
- `test/export-plan.test.ts` (5), `test/export-checks.test.ts` (2), `test/export-dialog.test.tsx` (2): hard-coded counts of formats (10 vs 11 shift formats with pallets; 5 vs 6 without pallets; "12" vs "13" checks; `done/total` 12 vs 13 in progress turns). Mechanical counts that depend on the new format.

### B. #692 TSPL SSCC as native EAN128 (1 test)

`test/floor-label-render.test.ts` "...exactly these bytes: the SSCC as GS1-128 and its digits": the expected TSPL line `BARCODE 76,256,"128",38,0,0,2,2,"!100046006820000035007"` is now produced as `BARCODE ...,"EAN128",...,"00046006820000035007"` (domain `tspl.ts`: native `EAN128` type with only AI `00`, instead of `"128"` with the literal `!1` which corrupted the scanned SSCC). ZPL half of the test is unaffected. The test's expected bytes (and any docs/acceptance wording about `!1`) need updating deliberately; also note that the standalone's thermal printing path therefore changes on real TSC printers, which needs a hardware check.

## Concerns

1. The merge is NOT green on standalone until the golden is regenerated (A) and the standalone tests/protocol fixture are updated by their owners; I stopped at the merge as instructed. Suggested follow-up task: ЧЗ-reversed (host `export-formats.json` + Rust ids, dialog counts, golden regen, plan counts) and a one-line TSPL expectation fix.
2. Because the Rust host/proto does not know `shift_txt_boxes_reversed`, a standalone office running with the merged domain would offer the new format in the dialog while the host's format list does not carry it. Not exercised end to end.
3. #702/#703 (A4 pallet templates, thermal labels with logo/pallet) did not break forms-parity; the standalone does not use the new pallet-sheet/thermal-branding exports yet (union export only).
4. No Windows, printer, browser, DB-backed API e2e run. `@markiro/api` only typechecked/linted for the conflicted file.
5. Intermediate artifacts: logs and the original/regenerated goldens are in /tmp/claude/impl-merge-main/ (not in the repo).
