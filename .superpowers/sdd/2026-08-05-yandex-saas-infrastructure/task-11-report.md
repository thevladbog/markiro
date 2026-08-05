# Task 11 report: Private Yandex production delivery

Status: complete

Commit: `feat(deploy): add private Yandex production delivery`

## Behavior changed

- Added an injectable one-use deployment-runner controller. It starts only a
  stopped VM with no stale deployment runner, waits for one idle online runner
  carrying the unique JIT label, enforces bounded discovery, and deregisters and
  stops independently on success or failure. Cleanup can safely discover the sole
  deployment runner even when controller outputs were never written.
- Added a protected production workflow triggered only by manual dispatch or a
  successful trusted image-publication run on `main`. It binds checkout and the
  manifest artifact to the exact run ID and 40-character SHA, uses the protected
  `production` environment, gives only `actions: read`, `contents: read`, and
  `id-token: write`, and never runs for pull requests.
- Added a second exact `production` federated credential for the runner service
  account while preserving the existing production Terraform credential and the
  distinct `production-infrastructure` credential. The runner service account has
  VM-scoped `compute.operator` on its own VM, VM-scoped OS Login on the app VM,
  and read-only ALB visibility.
- Replaced the runner placeholder with a one-use systemd service. Boot reads the
  runner-only Lockbox payload, requires the sole key
  `GITHUB_RUNNER_ADMIN_TOKEN`, requests GitHub JIT configuration for a UUID label,
  deletes temporary registration material, runs exactly one job, and powers off.
  GitHub Actions Runner `v2.336.0` is pinned to SHA256
  `04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d`.
- Added digest-evidenced private deployment orchestration. It validates Task 2's
  release manifest and exact workflow identity before cloud gates, transfers only
  `compose.production.yml`, `deploy/production`, and `release-manifest.json` to
  the commit release directory through internal-address OS Login, then preserves
  runtime refresh, preflight, digest pull, migration, API, edge, ALB, smoke, and
  release-record ordering. Migration failure switches nothing; post-switch
  failures request the exact previous API/edge digest pair.
- The GitHub-hosted cleanup job always exchanges the runner service account's
  exact-subject OIDC credential, rereads the runner-only Lockbox value, removes an
  exact or safely discovered stale runner, and stops the VM even if deployment
  never started. Provider and SSH stderr remain suppressed behind fixed errors.
- Expanded the production runbook with protected-environment variables, token
  ownership/rotation, one-use runner recovery, OS Login delivery, failure
  semantics, and the Yandex provider's current ALB IAM scoping limitation.

## TDD evidence

- RED: `node --test deploy/yandex/test/runner-control.test.mjs deploy/yandex/test/remote-deploy.test.mjs`
  failed with module-not-found before the controller modules existed.
- GREEN: focused tests cover STOPPED-only startup, stale/duplicate/busy runners,
  bounded wait, single-job execution, independent cleanup, exact private transfer
  inputs, exact phase order, migration no-switch, and rollback of the exact prior
  digest pair after API, edge, ALB, and smoke failures.
- Workflow mutations reject pull-request triggers, static runner labels,
  success-only cleanup, tag-shaped manifest artifacts, and omitted backup or ALB
  gates. Existing deployment tests continue to reject reversed migration/service
  ordering and raw diagnostic leakage.

## Automated checks

- `node --test deploy/yandex/test/*.test.mjs`
  - PASS: 32 tests, 0 failures.
- `PATH=/private/tmp/markiro-terraform-1.15.8.HkkrjU:$PATH TF_CLI_CONFIG_FILE=/private/tmp/markiro-terraform-1.15.8.HkkrjU/terraform.rc corepack pnpm test:yandex-infra:contract`
  - PASS: 41 tests, 0 failures.
- `corepack pnpm test:production-bundle:contract` with approved local Podman and
  listener access
  - PASS: 223 tests, 0 failures.
- Terraform 1.15.8 backend-disabled init and validate for `bootstrap` and
  `production`, using the configured Yandex provider mirror
  - PASS for both roots.
- Relevant-file Prettier check, `terraform fmt -check -recursive infra/yandex`,
  workflow/cloud-init shell `bash -n`, and `git diff --check`
  - PASS.
- Repository-wide `corepack pnpm format:check`
  - FAILS only on unchanged pre-existing
    `deploy/production/test/edge-contract.test.mjs`; all Task 11 files pass the
    relevant formatter checks and the unrelated file was not modified.

## Official-current evidence

- GitHub's REST documentation confirms the repository JIT endpoint, one-use
  encoded configuration, and fine-grained repository Administration write
  permission. GitHub's runner release confirms `v2.336.0` and the pinned Linux
  x64 checksum.
- Yandex documentation confirms Lockbox's payload endpoint, VM start/stop APIs,
  internal-address OS Login certificate export, and VM-level
  `compute.operator`. Provider `0.215.0` exposes VM IAM bindings but no
  load-balancer-level IAM binding; folder-level read-only `alb.viewer` is the
  narrowest provider-supported ALB target-state scope and is documented as such.

## External/manual checks

- No workflow dispatch, GitHub runner registration/deletion, Yandex VM mutation,
  Lockbox read, OS Login session, production migration, ALB switch, smoke, remote
  Terraform plan/apply, or DNS change was performed.
- The contract suites exercised local process, Docker/Podman, loopback, Terraform
  schema, YAML, and failure/mutation behavior only. Live Yandex and GitHub
  permissions still require the protected first-run procedure below.

## Required repository and cloud setup

- Protect the `production` environment with required reviewers and main-branch
  restrictions. Populate the documented `YC_*` and `MARKIRO_DOMAIN` variables.
- Populate and rotate the existing runner-registration Lockbox container out of
  band with exactly one text entry named `GITHUB_RUNNER_ADMIN_TOKEN`. Prefer a
  GitHub App installation/user token; the fallback fine-grained PAT must be
  limited to `thevladbog/q` with repository Administration write only. Do not
  duplicate it into GitHub secrets.
- Apply the reviewed Terraform change through the protected infrastructure
  workflow before enabling deployment. Confirm the runner VM is stopped, the app
  has no public NAT, a recent restorable PostgreSQL backup exists, and the ALB
  target is healthy before the first dispatch.
