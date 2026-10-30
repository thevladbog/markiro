# Forward CI Filesystem Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce generated-file preparation overhead in forward CI without changing checks, command order or timeouts.

**Architecture:** Reuse the existing bounded Unix Engine request protocol, add a scoped filesystem exec reader, and select it only in forward rehearsals. Unsupported commands retain CLI; selected failures propagate without replay.

**Tech Stack:** Node 24 builtins, Docker Engine API v1.41, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-30-forward-ci-filesystem-transport-design.md`

## Global Constraints

- Separate PR; preserve all isolation/recovery checks, freshness and ordering.
- No timeout increase. Complete filesystem exec budget is 120000 ms.
- Do not cancel, rerun or modify the existing PR #835 run.
- No production access, secrets, host socket mounts, TCP endpoint, result caching or batching.
- Only supported fixed filesystem commands under the owned root use the new path; never fallback/retry after selection.

## Review Focus

- Caller mutates args during await: execute only the validated copy.
- Timeout after exec creation: report uncertain termination, poison reader and drain request; namespace owner retains cleanup duty.
- Exit 0 with stderr versus nonzero: preserve both streams and exact numeric exit status.
- Canonical-looking paths with traversal/control/option injection: reject selection before any Engine request.
- Other rehearsal modes and unsupported commands: preserve existing CLI dispatch and diagnostic behavior.

### Task 1: Shared bounded request and filesystem reader

**Files:** create `deploy/platform/rehearsal-engine-request.mjs`, `deploy/platform/rehearsal-filesystem.mjs`, `deploy/platform/test/rehearsal-filesystem.test.mjs`; modify `deploy/platform/rehearsal-isolation-readers.mjs` only to share the unchanged wire implementation.

**Interfaces:** preserve `createRehearsalMetadataReader`, `rehearsalEngineReadFailure` and `rehearsalEngineReadReason`; add `createRehearsalFilesystemReader({endpoint,containerId,root})` with `supports(args): boolean` and `run(args): Promise<{stdout:string,stderr:string}>`; `createRehearsalShell({forward,runCli,...settings})` preserves ordinary/unsupported CLI dispatch and latches selected failures.

- [x] Write tests for the spec's exact accepted/rejected forms, fresh execution, exact Cmd and stream/exit behavior; run and record RED.
- [x] Extract the current HTTP implementation without changing its deadlines, byte bounds, closure or error behavior; run existing metadata/route tests.
- [x] Implement fixed filesystem selection and exec create/start/inspect with copied arguments, one total deadline, strict framing and poisoned failures.
- [x] Add protocol fault tests covering Review Focus and rerun filesystem/metadata/route tests to GREEN.

### Task 2: Forward-only integration and evidence

**Files:** modify `deploy/platform/upgrade-ci.mjs`; extend `deploy/platform/test/rehearsal-source-checks.test.mjs` or add a focused dispatch test beside it.

**Interfaces:** existing `shell(args)` returns the same stdout/stderr strings and preserves `docker exec` error metadata. It chooses the reader only for supported args when `forwardScenario` exists.

- [x] Add RED integration assertions: ordinary mode/unsupported args use CLI, supported forward command uses Engine once, failure never falls back, command order and pre/post isolation/source tests remain intact.
- [x] Implement selection with the same private invocation root and exact owned daemon ID, leaving all guard call sites unchanged.
- [x] Run focused tests plus actual CLI/candidate equivalence and repeated timing in a task-owned network-none container; verify exact cleanup.
- [x] Run applicable platform contracts, lint, format and diff gates. Review the complete branch and secret scope.
- [ ] Commit scoped source/tests/spec/plan, push separate branch and create/attach PR. Report local proof separately from native CI; leave PR #835 run untouched.
