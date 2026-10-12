# US-11 native assembly contract CI implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Ensure US branch push CI explicitly executes the pure assembly contract.

**Architecture:** Add one pure suite owner after dependency builds. A focused
parsed-YAML contract protects executable ownership; exact predecessor evidence
and narrow historical normalization preserve every earlier check.

**Tech Stack:** Node 24, Corepack pnpm, node:test, js-yaml, existing Vitest.

**Spec:** `docs/superpowers/specs/2026-10-12-us-11-native-assembly-ci-design.md`

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`; preserve inherited changes.
- Owner name: `Verify pure native dataset assembly input`.
- Command: `corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-native-assembly-contract.test.ts --maxWorkers=1`.
- Owner keys are only `name` and `run`; no DB, conditions or ignored failures.
- Retain all predecessor bytes, hashes, assertions, read-only permissions and 30-minute budget.
- No production API/test, dependencies, env, migration, runtime or release changes; no commit/push/PR/deployment/cleanup.
- Pure local commands unset both `DATABASE_URL` and `US_TEST_DATABASE_URL`; do not source `.env`.
- Read/write only this plan's `.superpowers/sdd` workspace, never sibling artifacts.

## Review Focus

- A printed or guarded command must fail executable ownership, not pass via suite-name mention.
- Duplicate explicit selection in another workflow must fail, while aggregate collection remains allowed.
- Historical normalization must not erase changes to existing owners or silently accept a malformed new owner.
- Removing the new owner must reconstruct the full predecessor including comments and order.
- Workflow/job inherited environment, ignored failure or defaults must not weaken the pure owner.

### Task 1: Wire and protect pure assembly CI ownership

**Files:**

- Modify: `.github/workflows/us-development.yml` (one exact owner block).
- Create: `tools/us-development/test/dataset-native-assembly-ownership.test.mjs`.
- Modify: the four existing `*ownership.test.mjs` files only for this exact owner's predecessor normalization.
- Modify: `tools/us-development/test/isolation.test.mjs` only for the same normalization in seven historical predecessor checkers, preserving all pins/assertions.
- If useful create one focused test-support normalizer under `tools/us-development/test/support/`; no generic workflow framework.
- Append checkpoint: `docs/us/development-isolation.md`, `docs/us/implementation-plan.md`.

**Interfaces:** Consumes the existing workflow and pure suite, exports no runtime
API. Produces a dedicated push-CI selection protected by parsed workflow tests.

- [ ] **Step 1: Pin current predecessor before editing and write RED ownership tests.**

Use real parsed workflow input and independently pinned current byte/AST hashes.
The owner assertion starts with this observable missing selection:

```js
const owners = workflow.jobs.isolation.steps.filter(
  (step) => step.name === "Verify pure native dataset assembly input",
);
assert.equal(owners.length, 1, "native assembly has exactly one owner");
```

Use `structuredClone` fresh workflow objects for named mutations and assert
`AssertionError` and the intended diagnostic, not just any exception. Cover every
Review Focus line, missing/duplicate owner, exact command guards/echo/suppression,
extra selector, wrong build order, permissions, budget, condition and env at owner,
job and workflow scopes. Allow existing aggregate API execution.

- [ ] **Step 2: Run RED.**

```bash
env -u DATABASE_URL -u US_TEST_DATABASE_URL node --test tools/us-development/test/dataset-native-assembly-ownership.test.mjs
```

Expected: missing dedicated owner assertion; distinguish this from import errors.

- [ ] **Step 3: Add the minimal owner and narrow historical normalization.**

```yaml
- name: Verify pure native dataset assembly input
  run: corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-native-assembly-contract.test.ts --maxWorkers=1
```

Place immediately after `Build isolated API dependencies and entry points`.
Historical predecessor checkers strip only this exact block/parsed equivalent;
keep their pinned hashes untouched. Never duplicate a historical checker wholesale.

- [ ] **Step 4: Verify current owner and historical contracts.**

```bash
env -u DATABASE_URL -u US_TEST_DATABASE_URL node --test tools/us-development/test/*ownership.test.mjs
env -u DATABASE_URL -u US_TEST_DATABASE_URL corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-native-assembly-contract.test.ts --maxWorkers=1
env -u DATABASE_URL -u US_TEST_DATABASE_URL node --test tools/us-development/test/*.test.mjs
env -u DATABASE_URL -u US_TEST_DATABASE_URL node tools/us-development/check-isolation.mjs
corepack pnpm format:check
git diff --check
```

Record full exit codes/counts and warnings. These are local checks, not GitHub run
evidence. No bare API suite is required because API implementation/tests are not
changed. If a check fails, diagnose and report it rather than repinning history.

- [ ] **Step 5: Document, self-review and report without committing.**

Append factual checkpoints distinguishing pure contract/CI wiring from native
assembly and installed demo data. Report files, RED/GREEN commands, local results,
manual/external checks not run and concerns. Separate task and final review follow.
