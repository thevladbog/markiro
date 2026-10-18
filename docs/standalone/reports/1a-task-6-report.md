# Task 6: CI, руководство приложения и документация

## Summary

Gave `apps/standalone` its own CI routing (`standalone_rust`,
`standalone_windows_build` classifier outputs; `standalone-rust`,
`standalone-windows-build` jobs), updated the three CI contract test files
that enumerate jobs, and added `apps/standalone/AGENTS.md` +
`apps/standalone/README.md` plus the four named spots in the root
`AGENTS.md`. Also applied the controller's two additions: rustfmt component

- `cargo fmt --check` step in `standalone-rust`, and the fmt-check bullet as
  the first item in the new AGENTS.md's Verification list.

## Step 1–2: failing tests before the classifier/workflow edits

Added the test cases from the brief to `tools/ci/test/affected.test.mjs`
(jobNames, signerOnly.jobs, the `packages/ui` fan-out case, the CLI-output
case, and the new "Standalone native and web changes select their jobs"
test), `tools/ci/test/workflow.test.mjs` (`heavyJobs`), and
`tools/ci/test/required-results.test.mjs` (`jobPairs`) — before touching
`affected.mjs` or `ci.yml`.

Command: `node --test tools/ci/test/affected.test.mjs tools/ci/test/workflow.test.mjs tools/ci/test/required-results.test.mjs`

Result: FAIL as expected — `tests 43`, `pass 18`, `fail 25`. Representative
failures: `enabledJobs` in `affected.test.mjs` asserts
`Object.keys(result.jobs)` equals the (now 12-entry) `jobNames`, so every
test using that helper failed against the old 10-entry classifier output;
`workflow.test.mjs` failed on `workflow must retain standalone-rust` and the
`ci-required` needs-array comparison. `required-results.test.mjs` stayed
green throughout (its `jobPairs` only feeds an internal fixture builder, not
`affected.mjs`/`ci.yml`), so the file-level fail count came entirely from
`affected.test.mjs` and `workflow.test.mjs`.

## Step 3–4: classifier and workflow

`tools/ci/affected.mjs`: added `standalone_rust`/`standalone_windows_build`
to `HEAVY_JOBS`, added `const standaloneJobs = [...]`, added
`...standaloneJobs` to `sharedJobs.ui`, and added the
`apps/standalone/` routing block (Rust-only for `host/`, `src-tauri/`,
`Cargo.{toml,lock}`; JS gates + Rust jobs for everything else in the app)
immediately before the handheld comment, exactly as specified.

`.github/workflows/ci.yml`: added the two new `classify-changes.outputs`
lines; inserted `standalone-rust` and `standalone-windows-build` jobs before
`handheld-android:`; added both job ids to `ci-required.needs`.

Controller additions applied on top of the brief's job bodies:

- `standalone-rust`'s `dtolnay/rust-toolchain` step now has
  `with: components: rustfmt`, and a
  `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check`
  step was inserted right after `pnpm install --frozen-lockfile`, before the
  webview build step.
- `standalone-windows-build` was left exactly as in the brief (no fmt step,
  plain toolchain line).

## Step 5: tests pass after the classifier/workflow edits

Command: `node --test tools/ci/test/affected.test.mjs tools/ci/test/workflow.test.mjs tools/ci/test/required-results.test.mjs`

First run inside the default Bash sandbox: `tests 43`, `pass 41`, `fail 2`.
The two failures were **pre-existing and unrelated to this task**:
`classifier falls back to a full run when pull-request diff generation
fails` and `classifier applies the changed-file policy to an existing main
push`, both failing with `mktemp: mkstemp failed on
/var/folders/.../T/tmp.XXXX: Operation not permitted`. That `classify-changes`
step's `run:` script (untouched by this task) shells out to bare `mktemp`,
which resolves to the OS default temp directory rather than the sandbox's
writable `$TMPDIR`. I confirmed this is a sandbox artifact, not a regression,
two ways: (a) running `mktemp` directly in the same shell fails identically
outside of any test; (b) the identical two failures were already present in
the Step 2 "before" run, before any classifier/workflow code existed for
`standalone_*`. Re-running the same command with the sandbox disabled
(`dangerouslyDisableSandbox: true`) gave a clean `tests 43`, `pass 43`,
`fail 0`.

## Step 6: AGENTS.md, README.md, root AGENTS.md

Created `apps/standalone/AGENTS.md` and `apps/standalone/README.md` verbatim
from the brief, with the controller's extra first Verification bullet
(`cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` —
the workspace is rustfmt-clean and CI enforces it). Confirmed both spec files
the AGENTS.md links to exist:
`docs/superpowers/specs/2026-09-26-standalone-station-design.md` and
`2026-09-26-standalone-01-foundation-design.md`.

Root `AGENTS.md`: added the Standalone bullet to "Scoped instructions"; added
the `apps/standalone` repository-map entry (one deviation, see below); added
the `apps/standalone` row to "Minimum checks by change area"; updated the
Rust-changes paragraph and command block to include the `apps/standalone`
Cargo workspace.

**Deviation (self-caught and corrected):** the brief's repository-map
instruction says "после пункта `apps/signer` добавить" (after the
`apps/signer` entry). I first inserted the new bullet after `apps/handheld`
instead (before `apps/saas-admin`). Caught it on review of `git diff --
AGENTS.md`, removed that insertion, and re-added it in the correct place —
directly after `apps/signer`, before `apps/handheld` — matching the brief.
The final diff (below) reflects only the corrected position.

## Step 7: verification and commit

1. `node --test tools/ci/test/affected.test.mjs tools/ci/test/required-results.test.mjs`
   → `tests 31`, `pass 31`, `fail 0` (clean inside the default sandbox — this
   pair doesn't shell out to `mktemp`).
2. `pnpm --config.verifyDepsBeforeRun=false exec node --test tools/ci/test/workflow.test.mjs`
   → inside the default sandbox: `tests 12`, `pass 10`, `fail 2` (the same
   two pre-existing `mktemp` sandbox artifacts described above). With
   `dangerouslyDisableSandbox: true`: `tests 12`, `pass 12`, `fail 0`.
3. `cargo fmt --manifest-path apps/standalone/Cargo.toml --all -- --check` →
   exit 0, no output — the workspace is rustfmt-clean, confirming the new
   `standalone-rust` fmt-check step will pass today.
4. `node_modules/.bin/prettier --write AGENTS.md apps/standalone/AGENTS.md apps/standalone/README.md`
   → reformatted `AGENTS.md` (repadded the "Minimum checks" table columns
   for the new, wider `apps/standalone` row, and rewrapped the Rust-changes
   paragraph); `apps/standalone/AGENTS.md` and `README.md` were already
   clean (unchanged).
5. `node_modules/.bin/prettier --check AGENTS.md apps/standalone/AGENTS.md apps/standalone/README.md tools/ci .github/workflows/ci.yml`
   → `All matched files use Prettier code style!` (exit 0). Note:
   `tools/ci/affected.mjs` and the three test files were hand-edited to
   already match Prettier's own line-wrapping (verified with a `--check`
   pass before ever running `--write` on them), since the brief's Step 7
   only runs `--write` on the AGENTS.md/README.md files.
6. `git diff --check` → clean (exit 0, no output).

Reviewed the full diffs of `tools/ci/affected.mjs`, `.github/workflows/ci.yml`,
the three test files, and `AGENTS.md` line by line against the brief and the
controller additions before staging; all match.

### Commit

```
git add tools/ci/affected.mjs tools/ci/test/affected.test.mjs tools/ci/test/workflow.test.mjs tools/ci/test/required-results.test.mjs .github/workflows/ci.yml AGENTS.md apps/standalone/AGENTS.md apps/standalone/README.md
git commit -m "ci(standalone): задания Rust и Windows, руководство приложения" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

`git log -1 --format=%B`:

```
ci(standalone): задания Rust и Windows, руководство приложения

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

SHA: `54051f52afcd3e56d918319f2c3ce1beafd99a09` (short: `54051f52`)

`git status --short`: clean (no output).

## Files changed

- Modified: `tools/ci/affected.mjs`
- Modified: `tools/ci/test/affected.test.mjs`
- Modified: `tools/ci/test/workflow.test.mjs`
- Modified: `tools/ci/test/required-results.test.mjs`
- Modified: `.github/workflows/ci.yml`
- Modified: `AGENTS.md`
- Created: `apps/standalone/AGENTS.md`
- Created: `apps/standalone/README.md`

## Concerns / not verified

- `standalone-windows-build` (the Windows service and the Windows Tauri
  `--debug --no-bundle` build) was not run anywhere in this task — it only
  exists as a new, not-yet-exercised GitHub Actions job definition. No
  Windows or manual window verification was performed, per the plan's final
  checklist item.
- The two `mktemp`/sandbox-caused failures in `workflow.test.mjs` are
  environment artifacts of this Bash tool's sandbox (confirmed pre-existing
  and reproducible with a bare `mktemp` call, unrelated to any code in this
  task). They do not reflect a real CI or code problem; final verification
  used `dangerouslyDisableSandbox: true` for those two specific runs to
  confirm a true 43/43 and 12/12 pass.
- This task did not touch or verify `apps/standalone`'s Rust/TypeScript
  application code itself (webview build, `cargo build --workspace`,
  `pnpm --filter @markiro/standalone test/typecheck/lint/build`) — only
  `cargo fmt --check` was run, per the environment rules' explicit ask.
  Those broader checks are out of this task's scope (CI wiring + docs).
