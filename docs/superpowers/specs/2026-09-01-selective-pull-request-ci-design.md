# Selective Pull Request CI — Design Spec

**Date:** 2026-09-01

**Status:** Draft; awaiting written-spec review

**Scope:** Reduce pull-request wait time by running only the CI jobs affected by
the changed files, while retaining a complete CI run after every push to `main`.

## Problem

The `CI` workflow currently starts every verification job for every pull
request. A one-line Signer version bump therefore runs API and database tests,
tenant infrastructure, the production bundle, and both Station builds. The
slowest unrelated job determines when the pull request can merge.

Branch protection currently requires seven job names from this workflow. A
workflow-level `paths` filter is unsafe here: when the workflow does not start,
GitHub may leave its required checks missing instead of recording a successful
skip.

## Decision

The workflow remains subscribed to every pull request. A small first job,
`classify-changes`, calculates which existing jobs are relevant. Heavy jobs use
job-level conditions and keep their current names, so current branch protection
continues to see a result for each required check during the migration.

A new always-running `ci-required` job evaluates the results of the classifier
and all heavy jobs. It accepts only successful required work and intentional
skips. Once this workflow has merged and completed successfully on `main`,
branch protection can be changed in a separate operational step to require
`ci-required` instead of the seven implementation-detail job names.

Selective execution applies only to `pull_request`. `push` to `main` and manual
workflow dispatch set every area flag and run the complete workflow.

## Classifier

The classification policy lives in a dependency-free Node module under
`tools/ci/`, not inline YAML and not in an unpinned third-party action. The same
module provides a CLI that writes boolean job flags to `$GITHUB_OUTPUT`.

For a pull request, the workflow checks out full history and classifies the file
names from the exact base-SHA-to-head-SHA diff. Renames are represented by their
old and new paths so moving code cannot evade either side's checks.

The classifier is fail-closed:

- root build or dependency configuration, lockfiles, workflows, and unknown
  source paths run the complete workflow;
- an empty or unreadable diff runs the complete workflow;
- paths explicitly classified as documentation may run only the classifier and
  final gate;
- additions to a known application, package, deployment, infrastructure, or
  release-tool area must be represented by a test before they can narrow CI.

The outputs correspond to the current heavy jobs:

- `verify-static`
- `verify-api-tests`
- `verify-app-tests`
- `tenant-team-infrastructure`
- `production-bundle`
- `station-rust`
- `station-windows-build`
- `signer-rust`
- `signer-windows-build`

## Path policy

Direct application changes select their own JavaScript verification and any
platform-specific build. API, deployable web applications, and production
browser surfaces also select the production bundle where that bundle exercises
them.

Shared packages fan out according to their current workspace consumers:

| Changed area                  | Required downstream areas                                     |
| ----------------------------- | ------------------------------------------------------------- |
| `packages/ui`                 | all web apps, Station, Signer, production bundle              |
| `packages/domain`             | API, Admin, Kiosk, Landing, Station, production bundle        |
| `packages/db`                 | API, Admin, Station, tenant infrastructure, production bundle |
| `packages/email`              | API, tenant infrastructure, production bundle                 |
| `packages/legal-documents`    | API, Landing, production bundle                               |
| `packages/platform-contracts` | API, Admin/SaaS Admin, Signer, production bundle              |

Deployment and release tooling selects the contract or build that consumes it.
Files that change the repository-wide toolchain select all jobs.

Signer-only release metadata is a deliberately narrow case. A change limited to
`apps/signer/src-tauri/tauri.conf.json`, its stable overlay, or
`tools/signer-release/` selects the Signer Linux and Windows jobs without API,
Station, tenant-infrastructure, or production-bundle work. The Signer Windows
job also runs `test:signer-release:contract`, so a version-only pull request
still validates the release contract that consumes the version.

## Final gate

`ci-required` has `if: always()` and depends on `classify-changes` plus every
heavy job. Its tested result evaluator enforces these rules:

1. The classifier must succeed.
2. A job selected by the classifier must finish with `success`.
3. A job not selected by the classifier may finish with `skipped` or `success`.
4. `failure`, `cancelled`, or a missing result always fails the gate.
5. On a full run, no heavy job may be skipped.

This makes the policy reviewable and prevents a malformed condition from turning
a required failure into a green aggregate result.

## Testing

Node tests cover the classifier and final evaluator before workflow YAML is
changed. At minimum they prove:

- a Signer version-only diff selects only both Signer jobs;
- Signer source changes also select the relevant JavaScript verification;
- Station, API, application, shared-package, deploy, and root-config changes fan
  out to the documented jobs;
- documentation-only changes remain lightweight;
- unknown paths and empty input fall back to all jobs;
- selected skipped jobs and failed/cancelled jobs fail `ci-required`;
- intentional skips pass, and a full run rejects every skip;
- workflow-shape tests pin the always-running classifier and final gate, exact
  SHA diff, existing job names, and each job's condition.

Final validation includes the focused Node tests, YAML parsing, formatting,
`git diff --check`, and the repository's existing Signer release contract. The
updated PR run is the external proof that GitHub reports skipped current
required jobs correctly and runs both selected Signer jobs.

## Rollout and recovery

This change ships in the existing Signer 0.1.3 pull request. Because that pull
request changes `.github/workflows/ci.yml` itself, its next CI run deliberately
runs the complete workflow; CI-policy changes are repository-wide changes and
must not use their own new filters as the first proof. Existing branch protection
remains unchanged while that pull request is open.

After merge:

1. confirm the push-to-`main` run executed every heavy job and `ci-required`
   succeeded;
2. let the next narrow pull request prove that intentionally skipped existing
   required jobs do not block merge and that `ci-required` succeeds;
3. change branch protection to require only `ci-required`, retaining strict
   branch freshness;
4. confirm one application pull request selects its documented downstream jobs
   before treating the migration as complete.

Recovery is a one-file workflow rollback: removing the job conditions returns
the workflow to full execution. The classifier itself never suppresses the full
`main` run.

## Out of scope

- Selective stable-release publication. Release workflows remain explicitly
  dispatched and unchanged.
- Rewriting all Turbo commands around Git history. Package-level Turbo affected
  execution may be a later optimization after job-level selection has production
  evidence.
- Changing branch protection before the new aggregate result exists on `main`.
- Reducing hardware, Windows, production, or external acceptance requirements
  for changes that actually touch those areas.
