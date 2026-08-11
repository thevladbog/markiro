# Yandex Direct-VM MVP Implementation Plan

> **For implementation:** execute in this worktree with test-driven development.
> Do not add another runner, controller, OIDC exchange, serial-console parser,
> load balancer or evidence workflow.

**Goal:** Ship the one-customer MVP through one public VM and ordinary protected
GitHub-hosted SSH delivery, then remove the unused managed ingress,
observability, audit and controller resources without touching production data.

**Architecture:** Cloud DNS points the admin and kiosk names at the existing
reserved app address. Caddy on the existing VM owns ports 80/443 and ACME. A
single GitHub-hosted deploy job validates the immutable release, uses pinned SSH
credentials, passes the job-scoped GitHub token to the existing bounded remote
registry-auth envelope, runs Compose and performs public smoke. Terraform keeps
the VM, Managed PostgreSQL, media/state storage, KMS and the minimum app/data
network; every other production and bootstrap resource is removed only through
reviewed plans.

**Tech stack:** GitHub Actions, Node.js 24 ESM and `node:test`, Terraform 1.15.8
with Yandex provider 0.215.0, OpenSSH, Docker Compose, Caddy ACME, Yandex Compute,
Managed PostgreSQL, Object Storage, Lockbox, Cloud DNS and KMS.

## Global safety constraints

- Work only in `codex/simplify-yandex-mvp`.
- Write each focused contract first and capture its expected RED before editing
  production files.
- Never print or commit SSH keys, GitHub tokens, runtime/SMTP secrets, bucket
  credentials, database credentials or live environment values.
- Reject any Terraform plan that replaces or destroys the app VM, PostgreSQL
  cluster/database, media bucket, state bucket or KMS key.
- Keep the audit bucket until both trails are stopped and its object/version
  inventory is reviewed; delete its data only as the final explicit cleanup.
- Keep image references digest-pinned and preserve remote rollback to the
  previously active digest when prepare, migration, start or smoke fails.
- If this path needs more than one ordinary SSH deploy correction, stop and run
  the same bounded deploy command manually from the operator workstation.

## Task 1: Define the minimal Terraform resource graph

**Files:**

- Modify: `infra/yandex/test/infra-contract.test.mjs`
- Modify: `infra/yandex/production/main.tf`
- Modify: `infra/yandex/production/variables.tf`
- Modify: `infra/yandex/production/outputs.tf`
- Modify: `infra/yandex/modules/network/main.tf`
- Modify: `infra/yandex/modules/network/variables.tf`
- Modify: `infra/yandex/modules/network/outputs.tf`
- Modify: `infra/yandex/modules/compute/main.tf`
- Modify: `infra/yandex/modules/compute/variables.tf`
- Modify: `infra/yandex/modules/compute/outputs.tf`
- Modify: `infra/yandex/modules/object-storage/main.tf`
- Modify: `infra/yandex/modules/object-storage/variables.tf`
- Modify: `infra/yandex/modules/object-storage/outputs.tf`
- Delete: active `infra/yandex/modules/ingress/*` wiring
- Delete: active `infra/yandex/modules/observability/*` wiring

- [ ] Add focused contracts requiring exactly one retained VM/public address,
      app/data subnets and SGs, public 22/80/443, direct DNS records to the app
      address, and no ALB/SWS/ARL/certificate/logging/dashboard/audit-trail target
      resources. Require the PostgreSQL, media bucket and KMS references unchanged.
- [ ] Add mutations that reintroduce an ALB resource, target group, SWS profile,
      managed certificate, audit trail, cloud log group, monitoring dashboard or an
      app replacement trigger; each must fail the contract.
- [ ] Run `node --test infra/yandex/test/infra-contract.test.mjs` and capture RED.
- [ ] Remove the ingress/observability production modules and target group;
      retain `yandex_vpc_address.app` and the existing app VM identity without a
      replacement trigger. Point two gated DNS A records directly at that address.
- [ ] Reduce networking to app/data boundaries. Remove ALB subnet/SG and the
      ALB-only port 8080 rule; add public 80/443 while retaining public key-only 22
      and app-SG-to-data-SG 6432.
- [ ] Stop creating audit writers/policies. Keep the versioned audit bucket as
      a temporary protected legacy resource or remove it from management with a
      non-destroying Terraform `removed` block until final cleanup.
- [ ] Run the focused infra contract GREEN and
      `terraform fmt -recursive -check infra/yandex`.

## Task 2: Make the runtime direct-Caddy only

**Files:**

- Modify: `compose.production.yml`
- Modify: `deploy/production/Caddyfile`
- Delete: `deploy/production/Caddyfile.alb`
- Modify: `deploy/production/test/edge-contract.test.mjs`
- Modify: `deploy/production/test/compose-contract.test.mjs`
- Modify: `infra/yandex/modules/compute/cloud-init-app.yaml.tftpl`
- Modify: `infra/yandex/test/infra-contract.test.mjs`

- [ ] Add contracts requiring host ports 80/443, `MARKIRO_EDGE_MODE=direct`,
      persistent Caddy ACME data and both exact authorities. Reject the behind-ALB
      mode and cloud logging/monitoring units in app cloud-init.
- [ ] Run the focused Compose/edge/infra tests and capture RED.
- [ ] Make direct mode the only production mode, remove the ALB Caddy variant,
      preserve admin/kiosk route isolation and remove Unified Agent plus custom
      monitoring/readiness timers from app bootstrap.
- [ ] Run the focused suites GREEN and build the edge image locally.

## Task 3: Replace Yandex control-plane deploy with ordinary SSH

**Files:**

- Modify: `deploy/yandex/test/remote-deploy.test.mjs`
- Modify: `deploy/yandex/remote-deploy.mjs`
- Delete: `deploy/yandex/hosted-deploy-context.mjs`
- Delete: `deploy/yandex/test/hosted-deploy-context.test.mjs`

- [ ] Add tests requiring only `YC_APP_PUBLIC_ADDRESS`, dedicated deploy login,
      owner-only private-key path, pinned host keys, release manifest, two domains
      and job-scoped `GHCR_USERNAME`/`GHCR_TOKEN`. Reject all Yandex IAM, Compute,
      Lockbox, ALB and serial-console inputs/calls.
- [ ] Require deploy order: transfer, runtime refresh, prepare/migrate/start,
      local readiness, public two-authority smoke, finalize; preserve one bounded
      remote rollback after any post-prepare failure.
- [ ] Run `node --test deploy/yandex/test/remote-deploy.test.mjs` and capture RED.
- [ ] Remove provider lookups and ALB gates. Validate the configured public IP,
      SSH identity and host keys locally. Feed registry credentials through the
      existing stdin envelope without logging them.
- [ ] Run remote-deploy and registry-auth tests GREEN.

## Task 4: Collapse the GitHub deploy workflow

**Files:**

- Modify: `.github/workflows/deploy-production.yml`
- Modify: `deploy/yandex/test/hosted-deploy-workflow.test.mjs`
- Modify: `deploy/production/test/workflow-contract.test.mjs`

- [ ] Add a parsed workflow contract requiring one manual `ubuntu-latest` job,
      one `production-deploy` environment, `contents/actions/packages: read`, no
      `id-token`, and no deployment phase, rehearsal inputs/artifacts, OIDC, serial
      lookup, Yandex token, controller/cleanup job or runner lifecycle.
- [ ] Require protected values for app address, deploy private key and base64
      host keys; require temporary mode `0600` files and unconditional cleanup.
- [ ] Run the focused workflow tests and capture RED.
- [ ] Retain exact release-run/SHA/manifest validation, then invoke the direct
      remote deploy with `${{ github.token }}` as the job-scoped GHCR credential.
      Upload no deployment evidence beyond ordinary Actions logs/status.
- [ ] Run workflow and production bundle contracts GREEN.

## Task 5: Remove obsolete IAM and bootstrap resources

**Files:**

- Modify: `infra/yandex/bootstrap/main.tf`
- Modify: `infra/yandex/bootstrap/variables.tf`
- Modify: `infra/yandex/bootstrap/outputs.tf`
- Modify: `infra/yandex/modules/iam/main.tf`
- Modify: `infra/yandex/modules/iam/variables.tf`
- Modify: `infra/yandex/modules/iam/outputs.tf`
- Modify: `infra/yandex/test/infra-contract.test.mjs`
- Modify: `infra/yandex/test/workload-identities.test.mjs`
- Modify: `infra/yandex/test/service-account-provenance.test.mjs`

- [ ] Add contracts retaining only Terraform/state/app identities and
      the infrastructure OIDC credential. Reject deployment-controller, audit and
      runner service accounts/roles/credentials and runner-registration secret.
- [ ] Run the focused IAM/bootstrap tests and capture RED.
- [ ] Remove obsolete accounts, grants, variables and outputs without changing
      retained runtime/state/SMTP secret payloads or the app identity.
- [ ] Run focused tests GREEN and produce a separate bootstrap plan; do not
      apply it before the production plan has removed all references.

## Task 6: Replace the go-live runbooks with one path

**Files:**

- Modify: `docs/runbooks/saas-production-deploy.md`
- Modify: `docs/runbooks/yandex-first-go-live.md`
- Modify: `docs/runbooks/yandex-infrastructure-apply.md`
- Modify: `docs/runbooks/yandex-bootstrap.md`
- Modify: `docs/runbooks/yandex-recovery.md`
- Modify: `docs/runbooks/yandex-secrets.md`
- Modify: `infra/yandex/README.md`
- Modify: `infra/yandex/test/runbook-contract.test.mjs`

- [ ] Add contracts requiring exactly: protected plan, protected apply,
      ordinary SSH deploy, DNS/TLS/public smoke, rollback by previous digest and
      final cloud inventory. Reject ALB/SWS/ARL/managed certificate, sixteen-alert,
      audit-trail, rehearsal, convergence-receipt and controller instructions.
- [ ] Run the runbook contract and capture RED.
- [ ] Rewrite only the active MVP procedures; keep a short historical pointer
      to the superseded design instead of preserving parallel instructions.
- [ ] Run the runbook contract GREEN.

## Task 7: Verify and produce exact live plans

- [ ] Run `node --test deploy/yandex/test/*.test.mjs`.
- [ ] Run `node --test infra/yandex/test/*.test.mjs` with the pinned Terraform
      binary on `PATH`.
- [ ] Run `node --test deploy/production/test/*.test.mjs`.
- [ ] Run `pnpm format:check`, `terraform fmt -recursive -check infra/yandex`
      and `git diff --check`.
- [ ] Initialize production and bootstrap backends without printing credentials
      and create saved plans from the exact current remote state.
- [ ] Parse both plans to report resource addresses/actions only. Reject any
      app VM, PostgreSQL, media/state bucket or KMS replacement/deletion.
- [ ] Commit, push and open one PR with the exact plan summaries and validation
      limits. Do not apply before review/merge.

## Task 8: Apply, deploy and clean the cloud

- [ ] After merge, run the protected production apply for the exact saved plan.
- [ ] Run the single deploy workflow for the latest successful image release.
- [ ] Verify local readiness, public DNS, valid ACME TLS and admin/kiosk smoke.
- [ ] Apply the bootstrap cleanup only after production references are gone.
- [ ] Stop both Audit Trails, inventory every audit object/version, then delete
      those versions and the audit bucket. Record that this deletion is not
      recoverable.
- [ ] Run a final read-only Yandex inventory and confirm that only the retained
      architecture remains.
