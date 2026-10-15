# Plan 1c2 follow-up: CI routing gap + rule-mirror docs/test gaps

Scope: three items from the whole-plan review of `apps/standalone` plan 1c2.
No changes to `apps/station`, no `git stash`, no `pnpm install`, no changes to
`.github/workflows/ci.yml` (not needed — see item 1).

## What changed

1. `tools/ci/affected.mjs` (routing fix) + `tools/ci/test/affected.test.mjs` (new test coverage)
   - Added a special case inside the `apps/standalone/` branch of `jobsForPath`
     so that `apps/standalone/src-tauri/migrations/` and
     `apps/standalone/src-tauri/tests/fixtures/` route to
     `["verify_static", "verify_app_tests", ...standaloneJobs]` (both the
     webview's TypeScript/Vitest gates and the standalone Rust jobs), instead
     of falling into the generic `src-tauri/` branch, which only routes to
     `standaloneJobs` (Rust-only).
   - Extended the comment above the `apps/standalone/` block to explain why:
     `test/support/local-db.ts` applies the migrations to node:sqlite, and
     `local-sql.json` under `tests/fixtures/` is asserted by both a Rust unit
     test and `test/local-executor.test.ts`.
   - Added both paths to the existing "web changes" loop in the "Standalone
     native and web changes select their jobs" test in
     `tools/ci/test/affected.test.mjs`, asserting they select
     `verify_static`, `verify_app_tests`, `standalone_rust`,
     `standalone_windows_build` — the same set as `apps/standalone/src/**`.
   - Confirmed `.github/workflows/ci.yml` needs no changes: it only reads
     `steps.affected.outputs.*` produced by `affected.mjs`; there is no
     separate path-filter list in the workflow file to update.

2. Rule-mirror documented on both sides
   - `apps/standalone/src-tauri/src/local_db.rs`: added a doc comment above
     `MAX_STATEMENTS`/`MAX_SQL_BYTES`/`MAX_VALUES` stating that these and
     `FORBIDDEN_WORDS` (below) are mirrored for tests in
     `apps/standalone/test/support/local-db.ts`, and that a rule change here
     also updates that file and adds a case to
     `src-tauri/tests/fixtures/local-sql.json`.
   - `apps/standalone/AGENTS.md`, "Local database" section: added one sentence
     after the existing note about Vitest running the same migrations,
     stating that `test/support/local-db.ts` also mirrors `local_db.rs`'s
     statement rules and limits, and that a rule change there means updating
     that file and the `local-sql.json` fixture.

3. New boundary tests in `apps/standalone/test/local-executor.test.ts`
   - Added two tests to the `describe("SQL rules match the shell (shared
fixture)", ...)` block (next to the existing `MAX_STATEMENTS` boundary
     test "refuses a batch of 33 statements"), both run through
     `openLocalDb()`'s real node:sqlite executor so a passing case really
     executes:
     - `"accepts a statement of exactly MAX_SQL_BYTES bytes and refuses one
byte more"`: builds `SELECT '<padding>' AS x` where `<padding>`
       contains one "я" (2 bytes, 1 UTF-16 code unit) plus ASCII filler, sized
       via `Buffer.byteLength` (not `.length`) to hit exactly 65,536 bytes
       (passes, row returned) and 65,537 bytes (refused with
       `invalid_statement`).
     - `"accepts 256 bound values and refuses 257"`: builds
       `SELECT json_array(?, ?, …) AS list` with 256 bound values (passes,
       `list` round-trips as the same JSON array via `JSON.stringify`) and
       257 bound values (refused with `invalid_statement`).
   - Mutation check (not part of the permanent diff): temporarily changed
     `test/support/local-db.ts`'s size check from `Buffer.byteLength(sql,
"utf8") > MAX_SQL_BYTES` to `sql.length > MAX_SQL_BYTES` and reran the
     new test with `vitest run test/local-executor.test.ts -t
"MAX_SQL_BYTES"`; it failed as expected ("expected the call to fail"),
     confirming the test actually catches a bytes-vs-UTF-16-units regression
     rather than passing vacuously. Reverted immediately; `git status --short
apps/standalone/test/support/local-db.ts` showed no diff afterward.

## Red/green for item 1 (CI routing)

Red (before the `affected.mjs` fix, with the new test cases already added to
`affected.test.mjs`):

```
$ node --test tools/ci/test/affected.test.mjs
✖ Standalone native and web changes select their jobs (1.233625ms)
  AssertionError [ERR_ASSERTION]: apps/standalone/src-tauri/migrations/0001_reference_data.sql
  + actual - expected
    [
  -   'verify_static',
  -   'verify_app_tests',
      'standalone_rust',
      'standalone_windows_build'
    ]
ℹ tests 20
ℹ pass 19
ℹ fail 1
```

Green (after the `affected.mjs` fix):

```
$ node --test tools/ci/test/affected.test.mjs
✔ Standalone native and web changes select their jobs (0.18725ms)
ℹ tests 20
ℹ pass 20
ℹ fail 0
```

## Every command run, with result

All commands were run from
`/Users/thevladbog/PRSOME/q/.claude/worktrees/ecstatic-swirles-7f0ae8`.

| Command                                                                                                                                                                        | Result                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --test tools/ci/test/affected.test.mjs` (before fix)                                                                                                                     | 19 pass, 1 fail (red, expected)                                                                                                                                                                                                                                                                                                                                                                                                    |
| `node --test tools/ci/test/affected.test.mjs` (after fix)                                                                                                                      | 20 pass, 0 fail (green)                                                                                                                                                                                                                                                                                                                                                                                                            |
| `node --test tools/ci/test/workflow.test.mjs tools/ci/test/required-results.test.mjs tools/ci/test/workflow-triggers.test.mjs` (sandboxed)                                     | 2 failures in `workflow.test.mjs` — both `mktemp: mkstemp failed on /var/folders/.../T/tmp.*: Operation not permitted`. Reproduced the same failure with a bare `mktemp` call directly in the sandbox (unrelated to any file I touched — bare macOS `mktemp` ignores `$TMPDIR` and targets `/var/folders/...`, outside the sandbox's writable paths). Treated as sandbox-only per the environment's own guidance and re-run below. |
| same three files, `dangerouslyDisableSandbox: true`                                                                                                                            | 27 pass, 0 fail                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `node --test tools/ci/test/*.test.mjs` (`dangerouslyDisableSandbox: true`)                                                                                                     | 47 pass, 0 fail (full `tools/ci` suite, i.e. `pnpm test:ci-policy`'s test set)                                                                                                                                                                                                                                                                                                                                                     |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone exec vitest run test/local-executor.test.ts`                                                             | 54 pass (52 pre-existing + 2 new), including both new boundary tests by name in verbose output                                                                                                                                                                                                                                                                                                                                     |
| Mutation check: patched `test/support/local-db.ts` size check to `.length`, reran the same file filtered to `-t "MAX_SQL_BYTES"`                                               | 1 fail as expected ("expected the call to fail"), confirming the test is not vacuous                                                                                                                                                                                                                                                                                                                                               |
| Restored `test/support/local-db.ts` from backup; `git status --short` on it                                                                                                    | clean, no diff                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone test`                                                                                                    | 21 test files, 309 tests, all pass                                                                                                                                                                                                                                                                                                                                                                                                 |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone typecheck`                                                                                               | clean (no output, exit 0)                                                                                                                                                                                                                                                                                                                                                                                                          |
| `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/standalone lint`                                                                                                    | clean (no output, exit 0)                                                                                                                                                                                                                                                                                                                                                                                                          |
| `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`                                                                                                        | exit 0, no diff                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `cargo check --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline`                                                                                       | `Finished \`dev\` profile [unoptimized + debuginfo] target(s)`, exit 0 (ran through the local `rtk` wrapper; output was the real cargo status line, not an error)                                                                                                                                                                                                                                                                  |
| `cargo test --manifest-path apps/standalone/Cargo.toml -p markiro-standalone --offline local_db::` (extra sanity check, not explicitly required)                               | `7 passed, 82 filtered out`                                                                                                                                                                                                                                                                                                                                                                                                        |
| `node_modules/.bin/prettier --check` on `tools/ci/affected.mjs`, `tools/ci/test/affected.test.mjs`, `apps/standalone/AGENTS.md`, `apps/standalone/test/local-executor.test.ts` | all pass Prettier style                                                                                                                                                                                                                                                                                                                                                                                                            |
| `git diff --check`                                                                                                                                                             | exit 0, no whitespace errors                                                                                                                                                                                                                                                                                                                                                                                                       |
| `git status --short` / `git diff --stat` (final)                                                                                                                               | exactly the 5 intended files: `apps/standalone/AGENTS.md`, `apps/standalone/src-tauri/src/local_db.rs`, `apps/standalone/test/local-executor.test.ts`, `tools/ci/affected.mjs`, `tools/ci/test/affected.test.mjs`; 67 insertions, 1 deletion                                                                                                                                                                                       |

## Deviations

- `tools/ci/test/workflow.test.mjs`'s two `mktemp`-based tests fail inside
  this session's default sandbox because bare macOS `mktemp` writes under
  `/var/folders/.../T`, which is outside the sandbox's writable-path
  allowlist (only `$TMPDIR` = `/tmp/claude-501` is allowed). This is an
  environment artifact, not caused by this change — `.github/workflows/ci.yml`
  and the `mktemp` call inside its embedded script were not touched, and a
  bare `mktemp` fails identically with no code changes at all. Verified green
  (27/27) with `dangerouslyDisableSandbox: true`. Flagging this per the
  "report skips/deviations" instruction rather than silently relying on the
  disabled-sandbox run.
- Did not run `pnpm turbo lint typecheck test build` repo-wide or
  `pnpm format:check` repo-wide, since the task's own "Checks" section scoped
  verification to the standalone package plus the `tools/ci` tests; the diff
  touches no other package.
- Did not modify `apps/standalone/test/support/local-db.ts` to export
  `MAX_SQL_BYTES`/`MAX_VALUES` for reuse by the new test; kept them as local
  hardcoded constants in the test (mirroring the file's own existing
  hardcoded-mirror style) to keep the diff minimal and scoped to what the
  task named.
