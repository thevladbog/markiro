# Timeweb Platform Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Publish the exact tested platform images through a protected manual workflow, making them available for the next Timeweb deployment stage.

**Architecture:** Validate exact main CI provenance, build and test once in a read-only job, then transfer an immutable artifact to a protected publishing job. Keep the version-1 platform manifest and legacy delivery unchanged.

**Tech Stack:** Node 24, native Node tests, Docker, GitHub Actions, existing pnpm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-18-timeweb-platform-release-design.md`.

## Global Constraints

- No server, DNS, provisioning, database restore or live release dispatch in implementation.
- Only `workflow_dispatch` on main; sourceSha and toolingSha both equal the immutable dispatch SHA.
- Exact green main-push CI with successful `production-bundle` and `ci-required` jobs for its successful attempt; reject missing or incomplete provenance.
- Build once, verify exact image IDs, transfer by artifact ID, then publish the same IDs without rebuilding.
- Publishing job uses the existing protected `production-deploy` environment; legacy workflows and version-1 manifest shape remain unchanged.
- Unique `platform-<sha>-<runId>-<attempt>` tags, digest-pinned runtime references, no `latest`.
- No secrets in logs/artifacts, no production access, no dependency or lockfile changes. Node 24 and Corepack pnpm.

## Review Focus

- A successful aggregate run contains skipped bundle work: reject it explicitly.
- A rerun's jobs are mixed with an earlier attempt: bind job attempt and complete job inventory.
- Evidence is valid JSON but swapped between release attempts or image profiles: reject the mismatch before Docker load/push.
- An archive or loaded tag changes after verification: hash and ID validation must precede the corresponding irreversible operation.
- An extra registry digest or wrong repository is accepted as the release image: reject ambiguity and preserve exact repository binding.

## Task 1: Provenance and verified image evidence contracts

**Files:**

- Create `deploy/platform/release-evidence.mjs`.
- Create `deploy/platform/test/release-evidence.test.mjs`.
- Reuse `deploy/platform/release-manifest.mjs` without changing its schema.

**Interfaces:**

- `validatePlatformCiEvidence(run, jobsResponse, expected)` returns `{ ciRunId, ciRunAttempt }`; expected is `{ repository, sourceSha, runId }`. The workflow run object and complete paginated job response come from the GitHub API; reject incomplete counts and any relevant job from another run/attempt. Require the exact `.github/workflows/ci.yml` path (allow GitHub's documented main suffix), `CI`, push/main, exact repository and SHA, completed/success, positive safe-integer IDs/attempt, unique successful required jobs.
- `parseVerifiedImagesEvidence(text, expected)` validates and returns the strict record. Expected is `{ sourceSha, toolingSha, workflowRunId, workflowRunAttempt, ciRunId, ciRunAttempt }` with canonical decimal ID/attempt strings. All identities must match.
- `createVerifiedImagesEvidence(input)` produces the same strict record after validation. Record fields: `version: 1`, `serverProfile`, `uiProfile`, the six identity fields above, `archiveSha256`, `images: { api: { tag, id }, edge: { tag, id } }`. Profiles are `platform-only`. Repositories are exactly the API and platform-edge repositories from the existing manifest; unique tags as specified above; Docker IDs are lowercase sha256.
- `resolvePublishedDigest(repositoryDigests, repository)` returns the one valid exact-repository sha256 digest; rejects duplicates, malformed or absent matches and unexpected repository inputs.
- `sha256RegularFile(path)` streams and hashes a regular non-symlink single-link file, rejects unsuitable files and changes during read; never loads a multi-GB archive into memory.

- [x] Write failing tests for wrong repo/workflow/event/branch/SHA/run status, skipped/duplicate/missing required jobs, mixed attempts/incomplete job listing and unsafe IDs.
- [x] Write failing evidence tests for roundtrip, exact keys, every identity/profile/tag/ID/hash mismatch, archive file/symlink tampering and digest ambiguity.
- [x] Run `node --test deploy/platform/test/release-evidence.test.mjs` and record the expected failure.
- [x] Implement the interfaces with generic errors that never include untrusted payloads or paths containing secrets. Reuse existing immutable manifest validation where appropriate.
- [x] Re-run focused tests and all platform tests. Run changed-file Prettier and `git diff --check`; commit explicit files after self-review.

## Task 2: Protected build, verify and publish workflow

**Files:**

- Create `.github/workflows/release-platform-images.yml`.
- Create `deploy/platform/release-images.mjs` (thin CLI / orchestration; split GitHub read transport into `release-ci.mjs` if needed for focused responsibility).
- Create `deploy/platform/test/release-images.test.mjs` and `deploy/platform/test/release-workflow.test.mjs`.
- Modify `tools/ci/test/workflow-triggers.test.mjs` and affected CI routing/tests only if required.
- Modify `docs/runbooks/timeweb-platform-preparation.md` and create `docs/runbooks/timeweb-migration.md`.

**Interfaces:** Consume Task 1's evidence validation. The CLI provides workflow operations to validate downloaded CI run/attempt-job JSON, export Docker archive and evidence after the harness, verify/load the exact artifact, and publish/write platform manifest plus release evidence. The implementer chooses the precise CLI verbs, documents them and tests actual operation ordering using injected command/file adapters; secrets come only from masked process environment or protected files. Docker is called with argument arrays, never interpolated shell code.

- [x] Write failing orchestration tests proving no load on invalid/hash-mismatched archive, no push on ID changes, no rebuild, correct manifest digest/source/run binding, and failure if either push/digest resolution fails.
- [x] Write failing workflow contracts: manual main only; input `ci_run_id`; exact successful run attempt fetched with complete pagination; no publishing permissions in build; protected dependent publish job; artifact-ID handoff; no SSH/deployment/provider operations; exact image IDs rechecked; safe evidence-only uploads. Add the workflow to reviewed trigger inventory.
- [x] Implement build job: resolve exact main CI via authenticated HTTPS, checkout `github.sha` with credentials disabled, install Node/pnpm and Chromium using existing pinned Actions, run platform/CI/production contracts, build API and platform edge for Linux amd64 using existing Dockerfiles/public landing variables, run `ci-stack.mjs --local-ci`, export exact IDs with unique tags and evidence, upload immutable artifact with one-day retention. Upload only sanitized harness screenshots/verification separately, including on failures.
- [x] Implement protected publish job using `production-deploy`, `contents: read`, `packages: write`; download the exact artifact ID from its build job, revalidate evidence/hash, load and check IDs, login to GHCR, push exact tags, resolve exact repo digests, create existing platform manifest, upload uniquely run/attempt-named manifest/evidence for 90 days. No mutation credentials before protection. Retain failed partial publication evidence without advertising a complete release.
- [x] Update runbook with exact dispatch inputs, protected approval boundary, artifact retrieval/verification, source/tooling identity and publication-vs-deployment distinction. Record today's merge and inventory as dated observations. Migration checklist covers host-executor prerequisite, fresh restore with app off, roles/ACL, encryption/license identities, staged S3, isolated egress, separate exact-image compact test, external backup, one writer and MX-preserving final cutover. Old resource deletion waits for acceptance.
- [x] Run all platform tests, `corepack pnpm test:production-bundle:contract`, `corepack pnpm test:ci-policy`, `corepack pnpm format:check` and `git diff --check`. Do not claim GitHub/registry/target proof from local contracts. Commit explicit paths after self-review.

## Delivery gates

- [ ] Independent per-task and whole-branch review; fix valid findings with focused tests.
- [ ] Inspect complete three-dot diff against freshly fetched main, then push branch and open/attach PR; no merge or dispatch by implementation agents.
- [ ] Wait CI/review and address failures. User merge/protected approval precedes actual publication; no idle paid server before delivery and restore prerequisites exist.
