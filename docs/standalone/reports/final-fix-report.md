# Final whole-branch review fixes — stage 0 (printable forms → @markiro/domain)

Worktree: `/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8`
Branch: `claude/autonomous-desktop-station-9e6f13`
Base HEAD before this work: `7fedd4d979`

Scope: hygiene, comment and documentation fixes only (F1–F8). No behavior change.

## Fixes applied

- **F1** `.gitattributes` — appended `-whitespace -text` attribute for
  `packages/domain/test/fixtures/print-forms/*.html` so git's whitespace check
  never flags the renderer-emitted trailing spaces in the characterisation
  fixtures.
- **F2** `packages/domain/src/index.ts` — replaced the inaccurate comment above
  `export * as taskFormChrome` (it referred to "the box-report module" instead
  of naming `contents-report.ts`, and didn't mention `formatInteger`).
- **F3** `packages/domain/src/print-forms/task-form-chrome.ts` — doc comment on
  `TASK_FORM_BASE_CSS` now references `apps/api/test/inventory-task-form-snapshot.test.ts`
  with its full path instead of a bare filename.
- **F4** `packages/domain/test/box-report.test.ts` — comments on lines 5 and 12
  now reference `apps/api/test/kiosk-orders.e2e.test.ts` and
  `apps/api/test/slip.test.ts` with full paths; the first comment block was
  rewrapped to stay under 100 chars per line.
- **F5** `packages/domain/test/print-forms-snapshot.test.ts` — header comment
  rewritten to present the byte-level lock as an ongoing contract (not a
  one-off move step), and documents the `vitest run -u` procedure for
  intentional fixture changes.
- **F6** `docs/architecture.md` — moved the em dash from the start of a
  continuation line to the end of the previous line (lines 46–48 region).
- **F7** `docs/superpowers/specs/2026-09-26-standalone-station-design.md` —
  seven sub-edits: (a) status line now records stage 0 as implemented and
  points to the plan file; (b) SSCC block reserve language corrected from
  "usually ~1.5 blocks" to "1 to 1.5 blocks, 1 guaranteed"; (c) section 8.2
  table row updated to ~1.4k lines and "moved to
  `packages/domain/src/print-forms/`"; (d) section 11 failure-mode table
  updated with the same corrected SSCC reserve wording; (e) section 13 stage
  table: stage name, destination path, and line count corrected; (f) section
  14 risk bullet updated to fold "printable forms" into the `packages/domain`
  parenthetical instead of a separate "common package"; (g) section 15
  open-question table row marked resolved at stage 0 with the concrete path.
  Section 8.2's unrelated "station modules are copied, not extracted" note
  (lines ~356–358) was left untouched as instructed.
- **F8** `docs/superpowers/plans/2026-09-26-standalone-00-print-forms-to-domain.md`
  — removed the unparseable `.prettierignore` argument from the two
  `prettier --check` commands (line ~289 and ~719 in the original).

## Verification

### Prettier — write pass on docs (realigns markdown tables touched by F7)

```
$ node_modules/.bin/prettier --write docs/superpowers/specs/2026-09-26-standalone-station-design.md docs/superpowers/plans/2026-09-26-standalone-00-print-forms-to-domain.md docs/architecture.md
docs/superpowers/specs/2026-09-26-standalone-station-design.md 114ms
docs/superpowers/plans/2026-09-26-standalone-00-print-forms-to-domain.md 103ms (unchanged)
docs/architecture.md 68ms (unchanged)
```

Only the spec file needed reformatting (markdown table column realignment
after the F7 cell-content edits); content of the edits was verified afterward
by direct inspection — all intended wording present, unrelated cells
unchanged.

### Prettier — check pass (`.gitattributes` expected to fail: no parser)

```
$ node_modules/.bin/prettier --check .gitattributes
Checking formatting...
[error] No parser could be inferred for file ".../.gitattributes".
Error occurred when checking code style in the above file.
exit=2   (expected)

$ node_modules/.bin/prettier --check packages/domain/src/index.ts packages/domain/src/print-forms packages/domain/test/box-report.test.ts packages/domain/test/print-forms-snapshot.test.ts docs/superpowers/specs/2026-09-26-standalone-station-design.md docs/superpowers/plans/2026-09-26-standalone-00-print-forms-to-domain.md docs/architecture.md
Checking formatting...
All matched files use Prettier code style!
exit=0
```

(Fixture directory `packages/domain/test/fixtures/print-forms` was
deliberately not run through Prettier, per instructions.)

### Domain vitest — targeted snapshot/characterisation tests

```
$ CI=true pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain exec vitest run test/print-forms-snapshot.test.ts test/box-report.test.ts test/shift-task-form.test.ts
 Test Files  3 passed (3)
      Tests  41 passed (41)
   Duration  476ms
```

All 41 tests pass; the byte-level HTML fixtures are unchanged (comment-only
edits do not touch emitted output).

### Domain typecheck / lint / build

```
$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain typecheck
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json
(clean, no output)

$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain lint
$ eslint .
(clean, no output)

$ pnpm --config.verifyDepsBeforeRun=false --filter @markiro/domain build
$ tsc -p tsconfig.json
(clean, no output)
```

### API — inventory task form snapshot test (consumer of F3's referenced path)

```
$ CI=true pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/inventory-task-form-snapshot.test.ts
 Test Files  1 passed (1)
      Tests  1 passed (1)
   Duration  469ms
```

(Pre-existing, unrelated warning: `vitest.config.ts` ESM/CJS `configLoader`
notice — not caused by this change.)

## Commits

1. `10aa94756c06a0d77fec3737abcfe762a7228473` —
   `chore(domain): слепки печатных форм вне проверки пробелов git, точные комментарии`
   Files: `.gitattributes`, `packages/domain/src/index.ts`,
   `packages/domain/src/print-forms/task-form-chrome.ts`,
   `packages/domain/test/box-report.test.ts`,
   `packages/domain/test/print-forms-snapshot.test.ts`

2. `0f00a8c97e1133ac8e679845bc27e99109e5b5d4` (short `0f00a8c97`) —
   `docs(standalone): спецификация и план после этапа 0`
   Files: `docs/architecture.md`,
   `docs/superpowers/specs/2026-09-26-standalone-station-design.md`,
   `docs/superpowers/plans/2026-09-26-standalone-00-print-forms-to-domain.md`

Both commit messages end with the required trailer:
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Final checks

```
$ git diff --check f9748bac1 HEAD; echo "exit=$?"
exit=0

$ git status --short
(clean)
```

## Notes / concerns

- None. All fixes applied exactly as specified; no other lines were touched.
  `git diff --stat` before committing showed exactly the 8 files named in the
  task (`.gitattributes`, `docs/architecture.md`,
  `docs/superpowers/plans/2026-09-26-standalone-00-print-forms-to-domain.md`,
  `docs/superpowers/specs/2026-09-26-standalone-station-design.md`,
  `packages/domain/src/index.ts`,
  `packages/domain/src/print-forms/task-form-chrome.ts`,
  `packages/domain/test/box-report.test.ts`,
  `packages/domain/test/print-forms-snapshot.test.ts`).
- Prettier's `--write` pass reformatted markdown table column widths in the
  spec file beyond the specific cells named in F7, because Prettier realigns
  every `|` column in a table it touches. This is pure whitespace realignment
  with no wording change outside the specified edits; verified by grepping
  each intended phrase and reading the surrounding table rows after
  formatting.
