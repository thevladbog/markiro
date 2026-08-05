# Yandex Final Infrastructure Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every finding in the final infrastructure fixes re-review with an executable clean-provisioning sequence, bounded alert-spec handoff, authenticated service-account provenance, passing Terraform format, and exact OIDC documentation.

**Architecture:** Keep GitHub Actions as the sole production writer. Add two small fail-closed Node CLIs: one authenticates and canonicalizes the five Yandex service accounts through `ServiceAccount.Get`; the other consumes Terraform's bounded NDJSON apply UI and emits only a strict first-phase alert-spec envelope. Hash the identity document into saved-plan evidence, upload it with the saved plan, re-fetch and compare it before apply, and derive the post-apply alert envelope only from already-verified evidence.

**Tech Stack:** Node.js 24 ESM, `node:test`, GitHub Actions YAML, Terraform 1.15.8, Yandex provider 0.215.0, Yandex IAM REST API.

## Global Constraints

- Do not print tokens, Lockbox values, Terraform state, full output maps, or unfiltered apply JSON.
- Production Terraform remains saved-plan-only and protected by the exact existing GitHub environments.
- Every new parser is byte-bounded, exact-schema, deterministic, and emits generic diagnostics.
- Every behavior change follows RED, GREEN, refactor; no push is performed.

---

### Task 1: Authenticated service-account provenance

**Files:**

- Create: `infra/yandex/scripts/verify-service-account-provenance.mjs`
- Create: `infra/yandex/test/service-account-provenance.test.mjs`
- Modify: `.github/workflows/yandex-infrastructure.yml`
- Modify: `infra/yandex/test/infra-contract.test.mjs`

**Interfaces:**

- Consumes: `YC_TOKEN`, `YC_FOLDER_ID`, and the five existing service-account ID environment variables.
- Produces: canonical JSON with exact `app`, `audit`, `controller`, `runner`, and `terraform` keys; each record contains exact `id`, bootstrap `name`, `folderId`, and `status: ACTIVE`.

- [ ] Write tests that accept the exact five records and reject swapped IDs, wrong names, wrong folders, suspended status, missing/extra keys, malformed responses, API failure, and oversized input.
- [ ] Run `node --test infra/yandex/test/service-account-provenance.test.mjs` and confirm RED because the verifier does not exist.
- [ ] Implement bounded authenticated `ServiceAccount.Get` calls and strict canonical validation with generic errors.
- [ ] Run the focused test and confirm GREEN.
- [ ] Extend workflow contracts first so they fail when provenance is not fetched after OIDC, hashed into evidence, uploaded, schema/hash checked, freshly re-fetched, and byte-compared before apply; add tampered-evidence mutations.
- [ ] Update the workflow minimally and rerun the focused workflow/provenance tests.

### Task 2: Bounded first-phase alert-spec artifact

**Files:**

- Create: `infra/yandex/scripts/extract-alert-specs.mjs`
- Create: `infra/yandex/test/alert-specs-artifact.test.mjs`
- Modify: `.github/workflows/yandex-infrastructure.yml`
- Modify: `infra/yandex/test/infra-contract.test.mjs`

**Interfaces:**

- Consumes: Terraform `apply -json` NDJSON on stdin and verified evidence bindings through environment variables.
- Produces: one canonical JSON object with exact `alert_specs`, `commit_sha`, `evidence_sha256`, `github_run_id`, `github_run_attempt`, `observability_phase: first`, and `plan_sha256` keys.

- [ ] Write tests for a valid 16-spec output event and rejection of missing/duplicate output events, unsupported UI version, sensitive alert output, malformed spec/category/field, non-null first-phase channel, extra artifact keys, bad bindings, and oversized input; verify unrelated root outputs are discarded.
- [ ] Run the new test and confirm RED because the extractor does not exist.
- [ ] Implement the bounded NDJSON extractor and exact artifact validator; run the focused test to GREEN.
- [ ] Extend workflow contracts first to require `terraform apply -json`, no raw output, evidence-derived bindings, a first-only immutable artifact upload, exact cleanup, and mutations for extra-output/evidence bypasses; verify RED.
- [ ] Update the workflow minimally, upload only the exact JSON file, and rerun focused tests to GREEN.

### Task 3: Executable runbook order and OIDC wording

**Files:**

- Modify: `docs/runbooks/yandex-infrastructure-apply.md`
- Modify: `docs/runbooks/yandex-bootstrap.md`
- Modify: `infra/yandex/test/runbook-contract.test.mjs`

**Interfaces:**

- Produces: exact clean cluster and database dispatch blocks that both select `observability_phase=first`, followed by full-root first apply, alert artifact consumption, and protected apply.

- [ ] Add runbook contract assertions/mutations for the two explicit first-phase PostgreSQL dispatches and ordered artifact handoff; verify RED.
- [ ] Update both runbooks, including the controller/cleanup versus Terraform OIDC wording; rerun runbook tests to GREEN.

### Task 4: Formatting and final gates

**Files:**

- Modify: `infra/yandex/production/main.tf`
- Verify all files above.

**Interfaces:**

- Produces: a branch that passes the exact checked-in PR format/contract gates.

- [ ] Run pinned `terraform fmt` on the changed HCL and confirm `terraform fmt -check -recursive infra/yandex` passes.
- [ ] Run focused new tests, `pnpm test:yandex-infra:contract`, `node --test deploy/yandex/test/*.test.mjs`, YAML parse, `git diff --check`, and available Terraform validate gates.
- [ ] Inspect `git status --short`, final diff, and staged diff for unrelated or generated files.
- [ ] Commit explicit paths once with a scoped message and report the SHA; do not push.
