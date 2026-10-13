# US-11 Trace/Readiness CI ownership implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Exercise all three new native suites, including actual260+2 full
composition, in a separate isolated CI job without weakening existing gates.

**Architecture:** One additive job waits for the unchanged six-segment isolation
matrix. Exact complete-job normalization preserves historical workflow pins.

**Tech Stack:** Existing GitHub Actions, PostgreSQL17, Node24/pnpm, native Vitest
fixtures and Node ownership contracts.

**Spec:** `docs/superpowers/specs/2026-10-13-us-11-trace-readiness-ci-design.md`.

## Constraints

- Existing US branch only; no main/RU/release/deployment/PR changes.
- All old82 steps, six segments, max-parallel3 and30-minute limits unchanged.
- New job needs isolation, timeout30; existing full-test900000ms unchanged.
- No product/test behavior, schema, recipe, native guard or assertion edits.
- No historical hash refresh, generic normalization allowlist or bypass/retry.
- Separate implementation and independent review; root owns commit/push/CI wait.

### Task 1: Add exact native owner and preservation tests

**Files:**

- Modify only `.github/workflows/us-development.yml` to append the reviewed job.
- Create `tools/us-development/test/support/trace-readiness-owner.mjs`.
- Create `tools/us-development/test/dataset-trace-readiness-ownership.test.mjs`.
- Minimally update the existing parallel normalization helper and affected Node
  ownership test consumers to recognize only the exact additive job.
- Append measured US evidence after actual review/CI, not premature full success.

- [ ] Inspect all affected ownership contracts. Write new missing-job/selection
      assertions and record meaningful RED against the current workflow.
- [ ] Implement one strictly specified job with frozen setup, reserved service,
      contracts-before-Node checks, API build and exact serial native suites.
- [ ] Add complete AST/byte job checks and narrow normalization; keep old pins.
      Mutation tests reject omission, altered target/command/action/order/needs,
      changed budget, skip/bypass/retry, duplicate/foreign owner and old-step edits.
- [ ] Run focused and full Node tooling, formatting/diff and isolation checks.
      No native/full API job concurrently; no automatic dependency reinstall.
- [ ] Self-review and report actual RED/GREEN/counts/limits to this plan's SDD
      workspace. No nested agents, implementer commit/push or release dispatch.

Root then independently reviews, commits/pushes explicit task paths only, and
observes the exact SHA's existing checks plus new native job. Until actual complete
success, full runtime acceptance remains open and the next Plan seam stays pending.
