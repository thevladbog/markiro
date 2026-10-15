# Task 2 report: move print-form generators into `packages/domain/src/print-forms/`

Status: DONE_WITH_CONCERNS (one concern, fully diagnosed, fix verified but deliberately left
uncommitted — see "Concerns" below).

## What changed

Steps 1–11 of `.superpowers/sdd/task-2-brief.md` were executed in order, verbatim, with one
addition outside the brief's file list (see Concerns).

- Moved six generator modules from `apps/api` into `packages/domain/src/print-forms/`:
  `contents-report.ts`, `box-report.ts`, `pallet-report.ts`, `pallet-placard.ts`,
  `task-form-chrome.ts` (from `apps/api/src/modules/print/`), `shift-task-form.ts`.
- Rewrote their imports to domain-relative `.js`-suffixed paths (`../barcodes/svg.js`,
  `../barcodes/task-tokens.js`, `../labels/shelf-life.js`, `./contents-report.js`,
  `./task-form-chrome.js`).
- Added the public export block to `packages/domain/src/index.ts` (functions, types, and the
  `taskFormChrome` namespace export), exactly as specified.
- Updated five API consumers (`code-search.controller.ts`, `code-search.service.ts`,
  `shifts.controller.ts`, `shifts.service.ts`, `inventory-task-form.ts`) to import from
  `@markiro/domain` instead of the old relative paths.
- Moved the four render test files and the snapshot test (+ its 8 HTML fixtures) into
  `packages/domain/test/`, rewriting their imports to the new source paths.
- Split `box-report.test.ts`: the DTO-only tests (`boxReportQuerySchema`) now live in a new
  `apps/api/test/box-report-query.test.ts`; the renderer test keeps only the render-focused case.
- Repointed `apps/admin/test/browser/box-report-render.mjs` at the domain source
  (`packages/domain/src/print-forms/box-report.ts`) and generalized its `.js`→`.ts` resolver hook
  to strip a `.js` suffix before appending `.ts` (previously it only appended `.ts` to an
  extensionless specifier).
- Updated `.prettierignore`: the print-forms fixture path and its comment now point at
  `packages/domain/test/fixtures/print-forms/`.
- Removed the now-empty `apps/api/src/modules/print/` directory (git had already stopped
  tracking it after the `git mv`; the empty directory entry itself was `rmdir`'d for cleanliness).

## Commands run (Steps 4, 8–11) with output

### Step 4 — domain builds after the move

```
$ CI=true pnpm --filter @markiro/domain typecheck
$ tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json
(no errors)

$ CI=true pnpm --filter @markiro/domain build
$ tsc -p tsconfig.json
(no errors)

$ ls packages/domain/dist/print-forms
box-report.d.ts  box-report.js  box-report.js.map
contents-report.d.ts  contents-report.js  contents-report.js.map
pallet-placard.d.ts  pallet-placard.js  pallet-placard.js.map
pallet-report.d.ts  pallet-report.js  pallet-report.js.map
shift-task-form.d.ts  shift-task-form.js  shift-task-form.js.map
task-form-chrome.d.ts  task-form-chrome.js  task-form-chrome.js.map
```

(Note: the very first `pnpm --filter @markiro/domain typecheck` invocation in this session
triggered pnpm's "deps status" auto-install check, which aborted without a TTY
(`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`). Re-running with `CI=true` (as pnpm's own error
message suggests) let it install silently and proceed; all commands below were run with
`CI=true` for consistency, matching what the brief already requires for the snapshot runs.)

### Step 8 — domain: snapshots (no rewrite) + render tests, typecheck, lint, build

```
$ CI=true pnpm --filter @markiro/domain exec vitest run test/print-forms-snapshot.test.ts test/box-report.test.ts test/pallet-report.test.ts test/pallet-placard.test.ts test/shift-task-form.test.ts
 Test Files  5 passed (5)
      Tests  68 passed (68)
```

All 8 snapshot assertions in `print-forms-snapshot.test.ts` compared byte-for-byte against the
fixtures moved in Task 1, under `CI=true` (no rewrite).

```
$ CI=true pnpm --filter @markiro/domain typecheck   → clean
$ CI=true pnpm --filter @markiro/domain lint        → clean
$ CI=true pnpm --filter @markiro/domain build       → clean
```

No lint/typecheck issues were flagged in the moved code, so no non-behavioural fixes were needed
there.

### Step 9 — API

```
$ CI=true pnpm --filter @markiro/api exec vitest run test/box-report-query.test.ts test/inventory-task-form.test.ts test/inventory-task-form-snapshot.test.ts test/shifts-openapi.test.ts
 Test Files  4 passed (4)
      Tests  25 passed (25)
```

`inventory-task-form-snapshot.test.ts` passed, confirming the inventory form's HTML is unchanged
after switching to `taskFormChrome` destructuring. No tests were skipped (none of the four files
requires `DATABASE_URL`).

```
$ CI=true pnpm --filter @markiro/api typecheck   → clean
$ CI=true pnpm --filter @markiro/api lint        → clean
$ CI=true pnpm --filter @markiro/api build       → clean ($ nest build)
```

### Step 10 — browser-contract renderer, direct node smoke check

Verbatim command:

```
$ printf '%s' '{"timeZone":"Europe/Moscow","data":{"sscc":"00146007034967000010","status":"closed","productName":"Молоко 1л","org":null,"openedAt":"2026-09-09T21:58:00.000Z","closedAt":"2026-09-09T22:08:00.000Z","disassembledAt":null,"codes":[]}}' | node apps/admin/test/browser/box-report-render.mjs | grep -o "открыт 10.09.2026 00:58"
открыт 10.09.2026 00:58
```

This passed **after** the `packages/domain/src/errors.ts` fix described in Concerns. Before that
fix, the identical command failed with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` — see below. The
full Playwright browser contract (`pnpm --dir tools/production-browser --ignore-workspace
test:product-labels`) was **not** run locally, per instructions; it needs a running production
bundle and runs in CI's `production-bundle` job.

### Step 11 — other checks and commit

```
$ grep -rn --include='*.ts' --include='*.tsx' --include='*.mjs' -E "modules/(code-search/(contents-report|box-report|pallet-report|pallet-placard)|print/task-form-chrome|shifts/shift-task-form)" apps packages tools | grep -v -E "node_modules|/dist/"
no stale imports
```

```
$ node_modules/.bin/prettier --check .prettierignore packages/domain/src/index.ts packages/domain/src/print-forms packages/domain/test apps/api/src/modules/code-search apps/api/src/modules/shifts apps/api/src/modules/inventories/inventory-task-form.ts apps/api/test/box-report-query.test.ts apps/admin/test/browser/box-report-render.mjs
```

First run flagged two files: `packages/domain/test/pallet-report.test.ts` and
`packages/domain/test/print-forms-snapshot.test.ts`. Cause: the brief's replacement import text
kept the old (longer-path) multi-line wrapping, but the new, shorter `../src/print-forms/...`
paths let those particular `import { A, B } from "...";` lines fit inside the repo's
`printWidth: 100`, so Prettier collapses them to one line. This is exactly the contingency the
brief anticipates ("при замечаниях — `prettier --write` по тем же путям … и повторить"). Ran:

```
$ node_modules/.bin/prettier --write packages/domain/src/index.ts packages/domain/src/print-forms packages/domain/test apps/api/src/modules/code-search apps/api/src/modules/shifts apps/api/src/modules/inventories/inventory-task-form.ts apps/api/test/box-report-query.test.ts apps/admin/test/browser/box-report-render.mjs
```

which reformatted exactly those two files (all others "unchanged"). Re-ran `--check` on the same
list minus `.prettierignore`: clean. Re-ran the five domain print-forms/snapshot tests again after
the reformat: still 5 files / 68 tests passed (whitespace-only change).

`.prettierignore` itself cannot be checked by this command: `prettier --check .prettierignore`
always fails with `[error] No parser could be inferred for file ".prettierignore"` regardless of
content — verified this is pre-existing and unrelated to this task by running the same check
against the file's pre-task content (`git show HEAD~1:.prettierignore`) copied to a temp path:
identical error. This is a quirk of invoking Prettier on that literal filename with this Prettier
version (3.9.6), not a regression.

```
$ git diff --check
(no output, exit 0)
```

Commit created with only the brief's listed paths staged (`git status --short` confirmed before
committing: only those paths showed as staged; `packages/domain/src/errors.ts`, see Concerns,
showed as unstaged and was left out of `git add`):

```
1c2ef8f75 refactor(domain): печатные формы переезжают в @markiro/domain
```

28 files changed (six moves, five test moves + 8 fixture moves, one new file
`apps/api/test/box-report-query.test.ts`, and the modified consumers/index/`.prettierignore`).

## Self-review checklist

- No remaining imports of the old paths: confirmed (`grep` → "no stale imports").
- `apps/api/src/modules/print/` no longer exists: confirmed. `git mv` had already emptied it (git
  never tracked the empty directory), but the empty directory entry was still physically present
  on disk; removed it with `rmdir` (verified empty first) for full cleanliness. This has no git
  effect (untracked either way).
- `packages/domain/src/print-forms/` holds exactly the six modules: confirmed
  (`box-report.ts`, `contents-report.ts`, `pallet-placard.ts`, `pallet-report.ts`,
  `shift-task-form.ts`, `task-form-chrome.ts`).
- All tests listed in Steps 8–9 pass: confirmed (68 + 25 = 93 tests across 9 files).
- `.prettierignore` points at the new fixture directory: confirmed
  (`packages/domain/test/fixtures/print-forms/`).

## Concerns

**One out-of-brief fix was necessary and is currently uncommitted.** `packages/domain/src/errors.ts`
had:

```ts
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DomainError";
  }
}
```

Step 2's required rewrite of `contents-report.ts`'s barcode import from `"@markiro/domain"`
(package boundary → compiled `dist`) to `"../barcodes/svg.js"` (relative, same-package) is
correct and necessary — `contents-report.ts` is now itself part of `@markiro/domain`, so
importing its own package name would be a self-referential anti-pattern regardless of any Node
quirk. But it has a side effect for exactly one consumer: `apps/admin/test/browser/box-report-render.mjs`
(Step 7) now loads **raw domain TypeScript source** directly under Node's native type-stripping
(via the file's own `registerHooks` `.js`→`.ts` fallback), instead of previously only ever hitting
the compiled `dist` for anything domain-related. That raw-source chain is
`box-report.ts → contents-report.ts → ../barcodes/svg.js → ../errors.js`, and Node's default
"strip-only" TypeScript mode cannot erase a **parameter-property constructor** — it requires full
transform. Running the verbatim Step 10 command before any fix failed with:

```
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode
    at .../packages/domain/src/errors.ts:4
```

This is not just a local-smoke-check inconvenience: `tools/production-browser/product-labels-tests/box-report.spec.ts`
(the CI `production-bundle` job's Playwright spec) invokes the **same script** via
`execFileSync(process.execPath, [renderer], ...)` — plain `node`, no flags — so that CI job would
hit the identical failure.

I confirmed the fix is behaviourally invisible before applying it: `packages/domain/dist/errors.js`
already compiles the parameter property down to an explicit field + assignment (I captured it via
`pnpm --filter @markiro/domain build` before touching the source). I rewrote `errors.ts` to that
exact equivalent form:

```ts
export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = "DomainError";
  }
}
```

Verification performed:

- Rebuilt domain and `diff`'d `dist/errors.js` before/after the source change: **byte-for-byte
  identical** compiled output.
- Ran the full domain suite: `CI=true pnpm --filter @markiro/domain test` → **71 files / 1016
  tests passed** (not just the print-forms subset).
- `CI=true pnpm --filter @markiro/domain typecheck` and `lint`: clean.
- Re-ran the exact verbatim Step 10 command with no flags: now prints
  `открыт 10.09.2026 00:58` as expected.
- Also confirmed in isolation with `NODE_OPTIONS=--experimental-transform-types` (diagnostic only,
  not applied anywhere) that, absent the strip-only limitation, the full rendered HTML and the
  timezone-adjusted text were already correct — i.e. the move itself introduced no logic bug; the
  only problem was this Node/tooling gap in unrelated shared code.

**This fix is intentionally NOT part of the Task 2 commit.** `packages/domain/src/errors.ts` is not
in the brief's file list, `DomainError` is imported by ~20 other domain files, and deciding
whether/how to land this belongs to the plan owner, not to an unscoped edit bundled into an
already-precise refactor commit. `git status --short` after the commit shows exactly one line:

```
 M packages/domain/src/errors.ts
```

It is left as a verified, working-tree-only change. Options for the follow-up, in my order of
preference:

1. Land this same one-file, behaviour-identical fix as its own small commit (recommended — it is
   the general-purpose fix, unblocks the local smoke check, and unblocks the CI `production-bundle`
   Playwright spec, which currently would fail the same way on this branch as soon as it exercises
   `box-report.spec.ts`).
2. Alternatively, patch only `box-report.spec.ts`/`box-report-render.mjs`'s invocation to run
   `node --experimental-transform-types` — narrower, but leaves the underlying incompatibility in
   place for any future script that loads raw domain source this way.

No other concerns. Everything else in Steps 1–11 completed exactly as specified with no
deviations, and no skipped tests were required to report (Step 9's four test files all ran; none
needs `DATABASE_URL`).

## Files changed (this task's commit, `1c2ef8f75`)

- `packages/domain/src/print-forms/{contents-report,box-report,pallet-report,pallet-placard,task-form-chrome,shift-task-form}.ts` (moved + import rewrites)
- `packages/domain/src/index.ts` (new export block)
- `packages/domain/test/{box-report,pallet-report,pallet-placard,shift-task-form,print-forms-snapshot}.test.ts` (moved + import rewrites + box-report.test.ts split)
- `packages/domain/test/fixtures/print-forms/*.html` (8 files, moved)
- `apps/api/src/modules/code-search/{code-search.controller,code-search.service}.ts` (consumer imports)
- `apps/api/src/modules/shifts/{shifts.controller,shifts.service}.ts` (consumer imports)
- `apps/api/src/modules/inventories/inventory-task-form.ts` (consumer imports, `taskFormChrome` destructure)
- `apps/api/test/box-report-query.test.ts` (new, DTO-only tests split out)
- `apps/admin/test/browser/box-report-render.mjs` (repointed at domain source)
- `.prettierignore` (fixture path + comment updated)

## Files changed (uncommitted, flagged for follow-up)

- `packages/domain/src/errors.ts` (parameter-property constructor → equivalent explicit
  field/assignment; behaviourally identical, verified via compiled-output diff and full domain
  test suite; see Concerns)

## Fix: contract reads the built domain

**Decision:** Revert the `packages/domain/src/errors.ts` parameter-property rewrite and make
`apps/admin/test/browser/box-report-render.mjs` import the built domain package (`@markiro/domain`
dist) instead of raw TypeScript source. The contract already depended on domain dist before the
move (the API source it loaded imported `@markiro/domain`), and the production-bundle job builds
admin dependencies before this contract runs.

### Step 3 verification commands and outputs

```
$ CI=true pnpm --filter @markiro/domain build
$ tsc -p tsconfig.json
(no errors)

$ set -o pipefail; printf '%s' '{"timeZone":"Europe/Moscow","data":{"sscc":"00146007034967000010","status":"closed","productName":"Молоко 1л","org":null,"openedAt":"2026-09-09T21:58:00.000Z","closedAt":"2026-09-09T22:08:00.000Z","disassembledAt":null,"codes":[]}}' | node apps/admin/test/browser/box-report-render.mjs | grep -o "открыт 10.09.2026 00:58"
открыт 10.09.2026 00:58

$ set -o pipefail; printf '%s' '{"timeZone":"UTC","data":{"sscc":null,"status":"disassembled","productName":null,"org":null,"openedAt":"2026-09-09T21:58:00.000Z","closedAt":null,"disassembledAt":"2026-09-09T23:08:00.000Z","codes":[]}}' | node apps/admin/test/browser/box-report-render.mjs | grep -o "Без SSCC" | head -1
Без SSCC

$ node_modules/.bin/prettier --check apps/admin/test/browser/box-report-render.mjs
Checking formatting...
All matched files use Prettier code style!

$ git diff --check
(no output, exit 0)
```

Final status after commit:

```
$ git status --short
(no output)
```

All verifications passed. Commit `b14b62b` created with `apps/admin/test/browser/box-report-render.mjs`.

No concerns.
