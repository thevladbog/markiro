# forms-golden-fix report

Commit: 26572c386 on claude/integration (parent 2c726efba).

## Cause (established)

Main's #706 (b2fc1c84a) changed in the OLD api location only: `pallet-placard.ts` title «ПАЛЛЕТА» -> «ПАЛЕТА» (one line), plus
test expectations in `apps/api/test/pallet-placard.test.ts`, `code-search-pallets.e2e.test.ts` (and admin/station files unrelated to moved code).
#707 (a83850543) touched no moved print-form file. Git carried the source change into `packages/domain/src/print-forms/pallet-placard.ts`
and the renamed `packages/domain/test/pallet-placard.test.ts` (already ПАЛЕТА), but NOT the byte fixtures, which are not in main:
`packages/domain/test/fixtures/print-forms/{pallet-placard-a4,pallet-placard-a5,shift-placards-a5}.html` and
`packages/domain/test/fixtures/print-forms-parity/golden.json` (3 cases). Standalone `forms-parity` reads that golden.

## Behavioural changes main made to the moved code

Only the word (ПАЛЛЕТА -> ПАЛЕТА, one line, pallet-placard.ts:278). Nothing else.

## Verification that the merge dropped nothing

Compared `git show origin/main:apps/api/src/modules/...` for pallet-placard, pallet-report, box-report, contents-report,
shift-task-form, task-form-chrome against `packages/domain/src/print-forms/*`: differences are only the import specifiers (`@markiro/domain` ->
relative `.js` paths) and one comment path in task-form-chrome. Same for the moved tests (differences: imports/comment paths, and the box-report
timezone-schema tests that our branch deliberately moved to `apps/api/test/box-report-query.test.ts`). No hand port needed.

## Changes

- print-forms HTML fixtures regenerated with `vitest -u test/print-forms-snapshot.test.ts`: 4 lines, each ПАЛЛЕТА -> ПАЛЕТА.
- golden.json regenerated with the cloud's write mode `FORMS_PARITY_WRITE=1 pnpm --filter @markiro/api exec vitest run test/standalone-forms-parity.test.ts`
  (after `pnpm --filter @markiro/domain build`: the first write attempt ran against stale domain dist and was a no-op; the API consumes dist).
- Proof script (python): for all 12 cases `new.html == old.html.replace('ПАЛЛЕТА','ПАЛЕТА')`, `bytes == len(utf8(html))`,
  `sha256 == sha256(utf8(html))`; the 9 cases without the word are byte-identical; 3 cases changed (placard-a4, placard-a5-disassembled,
  shift-placards-a5); 0 remaining «ПАЛЛЕТА». golden.json sha256: old 58d40eb3f5f77bf7e7feb54a53c4eda26ea02640cbe4ebac9cd7b83b3533520f ->
  new 443b0eacfcc6cc84a6bb725f7c007430f07f58def98cac1b47877cfa9526222f.
- Other pins: no «ПАЛЛЕТА» in apps/standalone; landing ui.ts and `labels/pallet-defaults.ts:52` left untouched (cloud copy, not changed by main).

## Gates

- domain: test 88 files / 1206 tests pass, typecheck, lint, build clean.
- API: standalone-export-parity + standalone-forms-parity: 2 files / 2 tests pass.
- standalone full Vitest (--testTimeout=60000 --hookTimeout=60000): 148 files / 4607 tests, 0 failures.
- cargo untouched (no Rust file changed, not run).
- Prettier: live gate proven with a scratch mis-formatted file (flagged, deleted); changed files pass. `git diff --check` clean; tree clean after commit.
