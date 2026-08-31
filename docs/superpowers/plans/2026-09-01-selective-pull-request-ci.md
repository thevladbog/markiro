# Selective Pull Request CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pull-request CI run only the jobs selected by a tested, fail-closed changed-file policy while every `main` push still runs the full workflow.

**Architecture:** A dependency-free Node classifier converts exact base-to-head changed paths into boolean outputs for the existing CI jobs. Every heavy job keeps its current GitHub job id and gains a job-level condition; an always-running Node evaluator aggregates selected-job results into the stable `ci-required` check.

**Tech Stack:** GitHub Actions YAML, Node.js 24 ESM, built-in `node:test`, `js-yaml`, Git.

**Spec:** `docs/superpowers/specs/2026-09-01-selective-pull-request-ci-design.md`

## Global Constraints

- Selective execution applies only to `pull_request`; `push` to `main` and `workflow_dispatch` run every heavy job.
- Keep all existing heavy GitHub job ids unchanged during the branch-protection migration.
- Unknown paths, empty diffs, root toolchain files, and workflow changes select every job.
- Do not add an unpinned third-party changed-files action or a runtime dependency.
- A selected job must succeed; skipped selected work, failures, cancellations, and missing results fail `ci-required`.
- Keep existing branch protection unchanged in this pull request.

---

### Task 1: Fail-closed changed-file classifier

**Files:**

- Create: `tools/ci/affected.mjs`
- Create: `tools/ci/test/affected.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Produces: `HEAVY_JOBS`, a frozen array of snake-case output names.
- Produces: `classifyChangedFiles(files: string[]): { full: boolean; jobs: Record<string, boolean> }`.
- Produces: CLI options `--full`, `--stdin-zero`, and `--github-output <path>`; the CLI writes `full=<boolean>` and one boolean line per `HEAVY_JOBS` entry.

- [ ] **Step 1: Add the failing classifier tests and package script**

Add `"test:ci-policy": "node --test tools/ci/test/*.test.mjs"` to the root scripts. Create table-driven tests with hand-written expected flags. The first fixtures must include:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { classifyChangedFiles } from "../affected.mjs";

const signerOnly = {
  full: false,
  jobs: {
    verify_static: false,
    verify_api_tests: false,
    verify_app_tests: false,
    tenant_team_infrastructure: false,
    production_bundle: false,
    station_rust: false,
    station_windows_build: false,
    signer_rust: true,
    signer_windows_build: true,
  },
};

test("a Signer version bump does not select unrelated product jobs", () => {
  assert.deepEqual(classifyChangedFiles(["apps/signer/src-tauri/tauri.conf.json"]), signerOnly);
});

test("an empty diff fails closed to every job", () => {
  const result = classifyChangedFiles([]);
  assert.equal(result.full, true);
  assert.equal(Object.values(result.jobs).every(Boolean), true);
});

test("an unknown source area fails closed to every job", () => {
  const result = classifyChangedFiles(["services/new-worker/src/index.ts"]);
  assert.equal(result.full, true);
  assert.equal(Object.values(result.jobs).every(Boolean), true);
});
```

Add independent cases for Signer UI, Station Rust and UI, every application, each shared package row from the spec, `deploy/`, `infra/`, production-browser tooling, Station release tooling, Signer release tooling, documentation, root toolchain files, and `.github/workflows/ci.yml`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tools/ci/test/affected.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `tools/ci/affected.mjs`.

- [ ] **Step 3: Implement the minimal pure classifier and CLI**

Define the job names once:

```js
export const HEAVY_JOBS = Object.freeze([
  "verify_static",
  "verify_api_tests",
  "verify_app_tests",
  "tenant_team_infrastructure",
  "production_bundle",
  "station_rust",
  "station_windows_build",
  "signer_rust",
  "signer_windows_build",
]);
```

Use an explicit ordered path policy. Start with all flags false, union the matching rule's flags for every path, and immediately return all flags true for an empty input, a root/toolchain path, a workflow path, or a path that matches no documented rule. Normalize backslashes to `/`, reject absolute paths and `..` segments as unknown, and treat only `docs/**`, root `*.md`, and `.github/*.md` as documentation-only.

The rule groups are:

```js
const appJobs = {
  api: ["verify_static", "verify_api_tests", "tenant_team_infrastructure", "production_bundle"],
  admin: ["verify_static", "verify_app_tests", "production_bundle"],
  kiosk: ["verify_static", "verify_app_tests", "production_bundle"],
  landing: ["verify_static", "verify_app_tests", "production_bundle"],
  "saas-admin": ["verify_static", "verify_app_tests", "production_bundle"],
};

const sharedJobs = {
  ui: [
    "verify_static",
    "verify_app_tests",
    "production_bundle",
    "station_rust",
    "station_windows_build",
    "signer_rust",
    "signer_windows_build",
  ],
  domain: [
    "verify_static",
    "verify_api_tests",
    "verify_app_tests",
    "production_bundle",
    "station_rust",
    "station_windows_build",
  ],
  db: [
    "verify_static",
    "verify_api_tests",
    "verify_app_tests",
    "tenant_team_infrastructure",
    "production_bundle",
    "station_rust",
    "station_windows_build",
  ],
  email: ["verify_static", "verify_api_tests", "tenant_team_infrastructure", "production_bundle"],
  "legal-documents": ["verify_static", "verify_api_tests", "verify_app_tests", "production_bundle"],
  "platform-contracts": [
    "verify_static",
    "verify_api_tests",
    "verify_app_tests",
    "production_bundle",
    "signer_rust",
    "signer_windows_build",
  ],
};
```

Treat `apps/signer/src-tauri/**`, `apps/signer/signer-core/**`, and Signer Cargo files as both Signer jobs; other `apps/signer/**` paths additionally select static and app tests. Apply the equivalent split to Station and also select production-bundle for Station web UI changes. `tools/signer-release/**` selects both Signer jobs; `tools/station-release/**` selects both Station jobs; `tools/production-browser/**`, `deploy/**`, `infra/**`, and `compose.production.yml` select production-bundle. Repository-wide configuration includes `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, `.npmrc`, `patches/**`, root TypeScript/ESLint/Prettier configs, and `.github/workflows/**`.

For CLI mode, parse NUL-delimited stdin when `--stdin-zero` is present. Use `appendFileSync` only for the explicit `--github-output` path and print JSON to stdout when no output file is supplied. Do not evaluate any path as code or interpolate it into a shell command.

- [ ] **Step 4: Run classifier tests and verify GREEN**

Run: `node --test tools/ci/test/affected.test.mjs`

Expected: all classifier tests PASS with zero failures.

- [ ] **Step 5: Add real CLI boundary tests**

Spawn the CLI with a temporary GitHub-output file and a NUL-delimited input containing the Signer config plus a documentation path. Assert the exact output lines are booleans and that only `signer_rust` and `signer_windows_build` are true. Add a `--full` invocation asserting all outputs and `full` are true.

- [ ] **Step 6: Run the complete CI policy test script**

Run: `node --test tools/ci/test/*.test.mjs`

Expected: all tests PASS.

- [ ] **Step 7: Commit the classifier slice**

```bash
git add package.json tools/ci/affected.mjs tools/ci/test/affected.test.mjs
git commit -m "feat(ci): classify affected pull request jobs"
```

### Task 2: Required-result evaluator

**Files:**

- Create: `tools/ci/required-results.mjs`
- Create: `tools/ci/test/required-results.test.mjs`

**Interfaces:**

- Consumes: `HEAVY_JOBS` from `tools/ci/affected.mjs`.
- Produces: `assertRequiredResults(needs: object): void`, throwing a descriptive `Error` for invalid classifier output or unacceptable job results.
- Produces: CLI option `--needs-env <name>`, which parses the named JSON environment variable and exits non-zero on rejection.

- [ ] **Step 1: Write failing evaluator tests**

Build literal `needs` fixtures with GitHub job ids and results. Include these behaviors:

```js
test("accepts successful selected jobs and intentional skips", () => {
  assert.doesNotThrow(() =>
    assertRequiredResults(
      needsFixture({ signer_rust: "success", signer_windows_build: "success" }),
    ),
  );
});

test("rejects a selected job that GitHub skipped", () => {
  assert.throws(
    () =>
      assertRequiredResults(
        needsFixture({ signer_rust: "skipped", signer_windows_build: "success" }),
      ),
    /selected job signer-rust finished with skipped/,
  );
});

test("rejects every skipped job during a full run", () => {
  assert.throws(
    () => assertRequiredResults(fullNeedsFixture({ "verify-static": "skipped" })),
    /full run requires verify-static to succeed/,
  );
});
```

Also cover failed/cancelled jobs, missing job results, missing or failed classifier, missing selection flags, and non-boolean output strings.

- [ ] **Step 2: Run evaluator tests and verify RED**

Run: `node --test tools/ci/test/required-results.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `tools/ci/required-results.mjs`.

- [ ] **Step 3: Implement result validation**

Map output names to GitHub job ids by replacing `_` with `-`. Require `needs["classify-changes"].result === "success"`. Read `full` and each selection output as the exact strings `"true"` or `"false"`; reject every other value. For each heavy job, accept only:

```js
if (full || selected) {
  if (result !== "success") throw new Error(/* job-specific message */);
} else if (result !== "success" && result !== "skipped") {
  throw new Error(/* unexpected unselected result */);
}
```

The CLI reads only the explicitly named environment variable, parses JSON, calls the pure function, and lets validation errors produce a non-zero exit.

- [ ] **Step 4: Run evaluator tests and verify GREEN**

Run: `node --test tools/ci/test/required-results.test.mjs`

Expected: all evaluator tests PASS.

- [ ] **Step 5: Run the complete policy suite**

Run: `node --test tools/ci/test/*.test.mjs`

Expected: classifier, CLI, and evaluator tests all PASS.

- [ ] **Step 6: Commit the evaluator slice**

```bash
git add tools/ci/required-results.mjs tools/ci/test/required-results.test.mjs
git commit -m "feat(ci): enforce selected job results"
```

### Task 3: Wire selective execution into GitHub Actions

**Files:**

- Modify: `.github/workflows/ci.yml`
- Create: `tools/ci/test/workflow.test.mjs`

**Interfaces:**

- Consumes: `node tools/ci/affected.mjs --full --github-output <path>`.
- Consumes: a successfully generated temporary file containing the NUL-delimited `git diff --name-only --no-renames -z <base> <head>` output; a failed diff invokes `affected.mjs --full`.
- Consumes: `node tools/ci/required-results.mjs --needs-env CI_NEEDS_JSON`.
- Produces: GitHub jobs `classify-changes` and `ci-required`; all existing heavy job ids remain unchanged.

- [ ] **Step 1: Write the failing workflow behavior test**

Parse `.github/workflows/ci.yml` with `js-yaml`. Assert:

- `classify-changes` checks out with `fetch-depth: 0` and exposes every classifier output;
- the pull-request path uses `github.event.pull_request.base.sha`, `github.event.pull_request.head.sha`, `git diff --name-only --no-renames -z`, a temporary diff file, and `--stdin-zero`;
- a failed pull-request diff invokes `--full` and completes successfully;
- non-pull-request events invoke `--full`;
- every heavy job needs `classify-changes` and uses its matching boolean output in a job-level `if`;
- `signer-windows-build` runs `pnpm test:signer-release:contract`;
- `ci-required` has `if: always()`, needs the classifier and every heavy job, and executes `required-results.mjs` with `toJSON(needs)` supplied through `CI_NEEDS_JSON`.

The expected job ids must be a literal list in the test, independent of `HEAVY_JOBS`, so accidentally removing a job from both production structures still fails.

- [ ] **Step 2: Run the workflow test and verify RED**

Run: `node --test tools/ci/test/workflow.test.mjs`

Expected: FAIL because `classify-changes` does not exist.

- [ ] **Step 3: Add `classify-changes` to the workflow**

Add checkout with `fetch-depth: 0`, then a Bash step with `set -euo pipefail`. Put `github.event_name`, base SHA, and head SHA in environment variables. For pull requests, capture the exact no-renames NUL diff in a temporary file and pass that file to the classifier only when diff generation succeeds; if it fails, invoke `--full`. Keep the non-pull-request `--full` path. Expose all ten outputs (`full` plus nine job flags) from the step.

- [ ] **Step 4: Gate every heavy job without renaming it**

Add `needs: classify-changes` and the corresponding condition, for example:

```yaml
verify-static:
  needs: classify-changes
  if: needs.classify-changes.outputs.verify_static == 'true'
```

Apply the same form to all nine jobs. Add `pnpm test:signer-release:contract` to `signer-windows-build` after dependency installation and before the webview build.

- [ ] **Step 5: Add the always-running aggregate gate**

Add `ci-required` with all ten upstream job ids in `needs`, `if: always()`, a pinned checkout, pinned Node 24 setup, and:

```yaml
- name: Verify required CI results
  env:
    CI_NEEDS_JSON: ${{ toJSON(needs) }}
  run: node tools/ci/required-results.mjs --needs-env CI_NEEDS_JSON
```

- [ ] **Step 6: Run workflow and policy tests and verify GREEN**

Run: `node --test tools/ci/test/*.test.mjs`

Expected: all tests PASS.

- [ ] **Step 7: Parse the workflow independently**

Run:

```bash
node --input-type=module -e 'import fs from "node:fs"; import { load } from "js-yaml"; load(fs.readFileSync(".github/workflows/ci.yml", "utf8"));'
```

Expected: exit 0 with no YAML parse error.

- [ ] **Step 8: Commit workflow wiring**

```bash
git add .github/workflows/ci.yml tools/ci/test/workflow.test.mjs
git commit -m "feat(ci): run affected pull request checks"
```

### Task 4: Final verification and PR update

**Files:**

- Modify if required by formatting only: files changed in Tasks 1–3

**Interfaces:**

- Consumes: all implementation and test files from Tasks 1–3.
- Produces: a clean, pushed branch for PR #403 with fresh local verification evidence.

- [ ] **Step 1: Run the focused policy suite**

Run: `node --test tools/ci/test/*.test.mjs`

Expected: all tests PASS with zero failures.

- [ ] **Step 2: Run the Signer release contract**

Run: `node --test tools/signer-release/test/*.test.mjs`

Expected: all Signer release contract tests PASS.

- [ ] **Step 3: Run formatting and diff gates**

Run:

```bash
./node_modules/.bin/prettier --check .github/workflows/ci.yml package.json tools/ci docs/superpowers/specs/2026-09-01-selective-pull-request-ci-design.md docs/superpowers/plans/2026-09-01-selective-pull-request-ci.md
git diff --check origin/main...HEAD
```

Expected: Prettier reports every listed path formatted and `git diff --check` exits 0.

- [ ] **Step 4: Review scope and branch state**

Run:

```bash
git status --short --branch
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: only the Signer 0.1.3 bump, approved CI design/plan, classifier, evaluator, workflow, and their tests are present.

- [ ] **Step 5: Push the existing PR branch**

Run: `git push origin codex/signer-v0.1.3`

Expected: the remote branch advances and PR #403 starts a complete CI run because the diff contains `.github/workflows/ci.yml`.

- [ ] **Step 6: Inspect the PR checks**

Run: `gh pr checks 403 --watch`

Expected: `classify-changes`, every heavy job, and `ci-required` complete successfully. Do not change branch protection during this pull request.
