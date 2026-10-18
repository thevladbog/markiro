# Published Platform Release Admission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Verify an actual published platform release before future host delivery.

**Architecture:** Read-only GitHub provenance and bounded artifact verification,
strict existing evidence contracts, then immutable registry identity verification.
A fresh exclusive admission record is produced only after every check succeeds.

**Tech Stack:** Node 24, native Node tests, Python 3 standard-library zipfile,
existing Docker CLI; no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-18-platform-release-admission-design.md`.

## Global Constraints

- No SSH, provisioning, DNS, database, publication or registry login/pull/tag/load/push.
- Fixed repository `thevladbog/markiro`, exact manual main publisher run/attempt,
  exact successful main CI and immutable artifact ID/digest.
- Maximum artifact ZIP 1 MiB, exactly two regular root JSON files, each <=256 KiB.
- Existing manifest and verified-images schemas remain unchanged.
- Secrets stay environment-only and errors are sanitized; no new dependencies.
- Admission is evidence only, not deployment authorization or a signed receipt.

## Review Focus

- GitHub rerun begins between selected run and attempt reads: fail closed.
- ZIP metadata lies about size or path/type: reject before writing extracted paths.
- Manifest and published evidence agree with each other but not selected run: reject.
- Registry tag/manifest list hides a different architecture or config ID: reject.
- Failure or retry leaves a prior output that appears freshly verified: exclusive output.

## Task 1: Complete read-only release admission

**Files:**

- Create `deploy/platform/release-admission.mjs`: strict pure provenance/evidence validators.
- Create `deploy/platform/admit-release.mjs`: thin CLI and orchestration; split GitHub,
  ZIP and registry adapters into focused sibling files if needed.
- Create `deploy/platform/test/release-admission.test.mjs` and
  `deploy/platform/test/admit-release.test.mjs`.
- Modify `docs/runbooks/timeweb-platform-preparation.md`: exact admission command,
  prerequisites, output limitations and failure recovery.

**Interfaces:**

- `validatePublishedPlatformRelease({ manifestText, evidenceText, expected })`
  returns `{ manifest, verified }`; expected is
  `{ sourceSha, workflowRunId, workflowRunAttempt }` with canonical strings.
  It must validate exact complete publication shape, timestamp, profiles, both
  published tags/IDs/digests and all selected identity bindings. CI identities
  are obtained from validated `verified` and checked remotely by orchestration.
- `admitPlatformRelease({ sourceSha, workflowRunId, workflowRunAttempt, artifactId, outputFile }, adapters)`
  performs the entire ordered read-only verification and exclusively writes the
  admission record. Export injectable HTTP/process/filesystem boundaries where
  useful for focused tests. Default implementation uses real transports; tests
  must cover the default ZIP parser and CLI failure boundary, not only fakes.
- Reuse `fetchPlatformCi`, `parseVerifiedImagesEvidence`, `parsePlatformManifest`
  and `sha256RegularFile`; do not relax their current assertions.
- The implementer chooses focused adapter signatures and final exact admission
  record field structure, documents them and tests that record exhaustively.

- [x] Write focused failing tests for strict complete evidence and binding, including
      null/wrong-type/extra-key/newline identity values and mismatched timestamps.
- [x] Run the focused tests and save the expected RED result.
- [x] Implement strict validators using existing schemas, not duplicate image parsing.
- [x] Add failing orchestration/real-ZIP tests for the five review focus cases,
      incomplete/mixed attempt pages, redirected token leakage, size limits,
      CRC/truncation, registry mismatch and pre-existing output.
- [x] Implement bounded authenticated GitHub resolution and archive extraction into
      private temporary resources. Resolve real Docker manifest output shape from
      installed CLI help/current official documentation before choosing assertions.
- [x] Implement registry config/architecture/digest checks and exclusive mode-0600
      success record; no success record or raw diagnostics on any failure.
- [x] Add CLI documentation and a real subprocess failure test with sentinel secrets.
- [x] Run `node --test deploy/platform/test/*.test.mjs`, production bundle contracts,
      CI-policy tests, repository formatting and `git diff --check`. Record live
      publisher acceptance as unrun until an actual protected release exists.
- [x] Self-review and commit explicit paths; do not push or open PR from the worker.

## Delivery gates

- [x] Independent task and whole-branch review, covering all source in this slice.
- [ ] Refresh main, inspect complete three-dot diff, push and open/attach PR.
- [ ] Main CI for PR #732 completes, dispatch the protected publisher and respect
      its required environment approval; do not substitute prior-SHA CI.
- [ ] Run read-only admission against the actual completed release. Record exact
      artifact/run/attempt/image IDs and state clearly whether this gate ran.
