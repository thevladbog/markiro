# Yandex Cloud SaaS Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision and operate the first Markiro SaaS environment in Yandex Cloud behind ALB and Smart Web Security, with private application hosts, managed data services, protected secrets, and digest-evidenced deployment.

**Architecture:** The existing `migrate`/`api`/`edge` bundle gains a tested ALB mode, then Terraform creates a private single-VM MVP behind Yandex ALB/SWS with Managed PostgreSQL, Object Storage, Lockbox, logging, and monitoring. A normally stopped private JIT GitHub runner deploys approved GHCR digests through OS Login; public DNS remains a separately approved final gate.

**Tech Stack:** Terraform 1.15.8, Yandex Cloud provider 0.215.0, Node.js 24.19.0, Corepack pnpm 11.10.0, Docker Compose, Caddy 2.11.4, GitHub Actions, Yandex ALB/SWS/Managed PostgreSQL/Object Storage/Lockbox/Monitoring/Audit Trails, Node test runner

## Global Constraints

- Pin Terraform to exactly `1.15.8` and `yandex-cloud/yandex` to exactly `0.215.0`; commit provider locks for `linux_amd64` and `darwin_arm64`.
- Keep `node:24.19.0-bookworm-slim`, `caddy:2.11.4-alpine`, Node.js 24, and Corepack pnpm 11.10.0 exact.
- ALB is the only public application endpoint. App VM, runner VM, PostgreSQL, API, state bucket, media bucket, audit bucket, and Lockbox remain private.
- Use one app VM and one PostgreSQL 17 host for the MVP. Do not describe the result as highly available or zero-downtime.
- Preserve the exact public route, CSP, cache, health, migration, immutable-digest, and rollback contracts from the production-bundle spec.
- Direct edge mode remains supported. Yandex uses `behind-alb`, listens on host port 8080 only, performs no ACME operation, and trusts exactly the controlled `ALB -> Caddy -> API` chain.
- Keep all production image selection on `ghcr.io/thevladbog/markiro-{api,edge}@sha256:...`; no `latest`, SHA-tag fallback, or Yandex Container Registry migration.
- Terraform creates Lockbox containers and IAM bindings, never application secret payloads. Database, SMTP, S3, Better Auth, mail-encryption, pairing, GHCR, state-HMAC, and runner-registration values are populated out of band.
- Treat Terraform state as confidential. Use a private versioned state bucket, state-only service account, protected CI writer, non-cancelling concurrency group, and no rendered state or full plan JSON in logs.
- Set `prevent_destroy` on state, media, audit, PostgreSQL, and Lockbox resources.
- Default `public_dns_enabled` to `false`; certificate validation may precede cutover, but the application `A` record requires a separate approved plan/apply.
- Use an existing public Yandex Cloud DNS zone ID. Domain purchase and registrar delegation are operator prerequisites.
- PostgreSQL uses daily backups, PITR, and exactly 14 days of automatic retention. Media non-current versions expire after 30 days; incomplete multipart uploads after 7 days.
- Runtime and deployment helpers fail closed, use bounded timeouts, atomically write protected files, and never log credentials, provider payloads, full environment files, or unredacted Terraform output.
- Real cloud apply, certificate issuance, restore drill, SMTP delivery, alert delivery, and DNS cutover are live operator gates; repository CI must never claim they passed.

---

## File map

### Existing production bundle

- `deploy/production/Caddyfile` — existing direct-TLS configuration, retained unchanged in behavior.
- `deploy/production/Caddyfile.alb` — new private HTTP configuration for ALB termination.
- `deploy/production/edge-entrypoint.sh` — exact direct/behind-ALB mode selector.
- `deploy/production/edge.Dockerfile` — packages both configurations and the selector.
- `deploy/production/compose.yandex.yml` — cloud overlay: port 8080 only and two trusted proxy hops.
- `compose.production.yml` — mode-aware edge environment and direct-mode defaults.
- `deploy/production/preflight.mjs` — mode-aware ACME and port validation.
- `deploy/production/release-manifest.mjs` — shared release-manifest creation and validation.
- `deploy/production/test/*.test.mjs` — edge, Compose, preflight, release, workflow, and failure contracts.
- `.github/workflows/release-images.yml` — durable post-push manifest artifact.

### Terraform

- `infra/yandex/bootstrap/` — state bucket, service accounts, workload identity, empty Lockbox containers, and initial state migration boundary.
- `infra/yandex/production/` — production composition, backend example, environment variables, outputs, and durable-resource protections.
- `infra/yandex/modules/iam/` — reusable narrow IAM memberships only.
- `infra/yandex/modules/network/` — VPC, subnets, NAT, routes, and security groups.
- `infra/yandex/modules/compute/` — app and stopped runner VMs, disks, OS Login, and cloud-init rendering.
- `infra/yandex/modules/postgres/` — private single-host PostgreSQL 17 and backup policy.
- `infra/yandex/modules/object-storage/` — media and audit buckets with versioning/lifecycle.
- `infra/yandex/modules/ingress/` — address, certificate, ALB, target/backend/router/listeners, SWS/ARL, and gated DNS.
- `infra/yandex/modules/observability/` — log groups, Audit Trails, dashboards, and alerts.
- `infra/yandex/test/infra-contract.test.mjs` — repository-wide HCL/workflow invariants.
- `infra/yandex/scripts/check-toolchain.mjs` — exact Terraform/provider/platform lock check.
- `infra/yandex/README.md` — repository interface, not the operator runbook.

### VM and deployment control

- `deploy/yandex/runtime-env.mjs` — Lockbox payload validation and atomic environment materialization.
- `deploy/yandex/readiness-observer.mjs` — sanitized local health state for monitoring.
- `deploy/yandex/runner-control.mjs` — bounded runner start/online/stop orchestration.
- `deploy/yandex/remote-deploy.mjs` — release evidence, bundle transfer, OS Login execution, health, and cleanup boundary.
- `deploy/yandex/test/*.test.mjs` — injectable unit/contract tests for all controller failure paths.
- `deploy/yandex/systemd/*.service` and `*.timer` — exact app and runner units installed by cloud-init.
- `.github/workflows/yandex-infrastructure.yml` — validate/plan/apply with protected state access.
- `.github/workflows/deploy-production.yml` — approved release deployment and independent runner cleanup.

### Operations documentation

- `docs/runbooks/yandex-bootstrap.md`
- `docs/runbooks/yandex-secrets.md`
- `docs/runbooks/yandex-infrastructure-apply.md`
- `docs/runbooks/yandex-recovery.md`
- `docs/runbooks/yandex-first-go-live.md`
- `docs/runbooks/saas-production-deploy.md`
- `docs/architecture.md`
- `docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md`

## Phase A — Production bundle cloud boundary

### Task 1: ALB edge mode and proxy-chain contract

**Files:**

- Create: `deploy/production/Caddyfile.alb`
- Create: `deploy/production/edge-entrypoint.sh`
- Create: `deploy/production/compose.yandex.yml`
- Modify: `deploy/production/edge.Dockerfile`
- Modify: `.dockerignore`
- Modify: `compose.production.yml`
- Modify: `deploy/production/preflight.mjs`
- Modify: `deploy/production/test/edge-contract.test.mjs`
- Modify: `deploy/production/test/compose-contract.test.mjs`
- Modify: `deploy/production/test/preflight.test.mjs`
- Modify: `deploy/production/test/smoke-route-table.test.mjs`

**Interfaces:**

- Consumes: existing Caddy route table; `MARKIRO_DOMAIN`; direct-mode `ACME_EMAIL`; digest-pinned edge image.
- Produces: `MARKIRO_EDGE_MODE: "direct" | "behind-alb"`; cloud overlay command `docker compose -f compose.production.yml -f deploy/production/compose.yandex.yml`; private edge port 8080; API `TRUST_PROXY_HOPS=2` in cloud mode.

- [ ] **Step 1: Write failing edge-mode tests**

Extend `edge-contract.test.mjs` and `compose-contract.test.mjs` with these exact assertions:

```js
function renderCompose(files) {
  return JSON.parse(
    execFileSync(
      "docker",
      ["compose", ...files.flatMap((file) => ["-f", file]), "config", "--format", "json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          MARKIRO_DOMAIN: "localhost",
          MARKIRO_ENV_FILE: ".env.production.example",
          MARKIRO_IMAGE_TAG: "a".repeat(40),
          MARKIRO_API_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
          MARKIRO_EDGE_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
        },
      },
    ),
  );
}

test("ALB mode keeps route parity but owns no certificate", async () => {
  const direct = await readFile("deploy/production/Caddyfile", "utf8");
  const alb = await readFile("deploy/production/Caddyfile.alb", "utf8");
  for (const marker of [
    "@apiAuth path /api/auth/*",
    "handle_path /api/*",
    "@commerceMl path /1c_exchange",
    "@device path /station/* /kiosk/* /health /health/* /openapi.json /docs /docs/*",
    "@assets path /assets/*",
    "@spa method GET HEAD",
  ]) {
    assert.ok(direct.includes(marker));
    assert.ok(alb.includes(marker));
  }
  assert.match(alb, /http:\/\/\{\$MARKIRO_DOMAIN\}:8080/);
  assert.doesNotMatch(alb, /https:\/\/|ACME_EMAIL|redir https/);
  assert.match(alb, /header_up X-Forwarded-Proto https/);
});

test("Yandex overlay exposes only backend HTTP and two proxy hops", () => {
  const model = renderCompose(["compose.production.yml", "deploy/production/compose.yandex.yml"]);
  assert.deepEqual(model.services.edge.ports, [{ target: 8080, published: "8080" }]);
  assert.equal(model.services.edge.environment.MARKIRO_EDGE_MODE, "behind-alb");
  assert.equal(model.services.api.environment.TRUST_PROXY_HOPS, "2");
  assert.equal(model.services.migrate.environment.TRUST_PROXY_HOPS, "1");
});
```

Add preflight cases proving `ACME_EMAIL` is required in `direct`, ignored in
`behind-alb`, unknown modes fail without echoing the value, and the Yandex
overlay cannot publish 8443.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test \
  deploy/production/test/edge-contract.test.mjs \
  deploy/production/test/compose-contract.test.mjs \
  deploy/production/test/preflight.test.mjs
```

Expected: FAIL because `Caddyfile.alb`, `edge-entrypoint.sh`, and the cloud
overlay do not exist and preflight still requires ACME unconditionally.

- [ ] **Step 3: Implement the exact edge selector**

Create `edge-entrypoint.sh` with no dynamic command evaluation:

```sh
#!/bin/sh
set -eu

case "${MARKIRO_EDGE_MODE:-direct}" in
  direct)
    test -n "${ACME_EMAIL:-}" || { echo "edge configuration invalid" >&2; exit 64; }
    config=/etc/caddy/Caddyfile.direct
    ;;
  behind-alb)
    config=/etc/caddy/Caddyfile.alb
    ;;
  *)
    echo "edge configuration invalid" >&2
    exit 64
    ;;
esac

exec caddy run --config "$config" --adapter caddyfile
```

Copy the existing file to `/etc/caddy/Caddyfile.direct`, add the reviewed ALB
configuration at `/etc/caddy/Caddyfile.alb`, copy the entrypoint, and set
`ENTRYPOINT ["/usr/bin/edge-entrypoint"]`. Keep UID/GID 10001, dropped file
capabilities, `/srv`, and the exact image bases.

- [ ] **Step 4: Implement the cloud Compose and preflight boundary**

Use Compose `!override` so cloud mode has exactly one host binding:

```yaml
services:
  api:
    environment:
      TRUST_PROXY_HOPS: "2"
  edge:
    environment:
      MARKIRO_EDGE_MODE: behind-alb
      ACME_EMAIL: ""
    ports: !override
      - target: 8080
        published: "8080"
        protocol: tcp
        mode: host
```

Make direct mode explicit in the base Compose. Keep ACME validation for direct
mode and validate only domain/mode/file/digests for ALB mode. Do not weaken any
secret-file or digest check.

- [ ] **Step 5: Adapt and smoke both configurations**

Run Caddy adapt for both files, the focused tests, and the full production
contracts:

```bash
docker run --rm -v "$PWD/deploy/production/Caddyfile.alb:/etc/caddy/Caddyfile:ro" \
  -e MARKIRO_DOMAIN=localhost caddy:2.11.4-alpine \
  caddy adapt --config /etc/caddy/Caddyfile
corepack pnpm test:production-bundle:contract
```

Expected: both commands exit 0; production contracts report 0 failures.

- [ ] **Step 6: Commit the edge boundary**

```bash
git add .dockerignore compose.production.yml deploy/production
git commit -m "feat(deploy): support Yandex ALB edge mode"
```

### Task 2: Durable trusted release manifest

**Files:**

- Create: `deploy/production/release-manifest.mjs`
- Create: `deploy/production/test/release-manifest.test.mjs`
- Modify: `.github/workflows/release-images.yml`
- Modify: `deploy/production/test/workflow-contract.test.mjs`

**Interfaces:**

- Consumes: `releaseSha`, `apiDigest`, `edgeDigest`, `workflowRunId`, `createdAt`.
- Produces: `createReleaseManifest(input): ReleaseManifest`; `parseReleaseManifest(text, expectedRunId): ReleaseManifest`; artifact `markiro-release-manifest-${github.sha}` retained 90 days.

- [ ] **Step 1: Write failing manifest tests**

```js
test("accepts only the trusted release schema", () => {
  const manifest = createReleaseManifest({
    releaseSha: "a".repeat(40),
    apiDigest: `sha256:${"b".repeat(64)}`,
    edgeDigest: `sha256:${"c".repeat(64)}`,
    workflowRunId: "123456789",
    createdAt: "2026-08-05T09:00:00.000Z",
  });
  assert.deepEqual(manifest, {
    commit: "a".repeat(40),
    api: `ghcr.io/thevladbog/markiro-api@sha256:${"b".repeat(64)}`,
    edge: `ghcr.io/thevladbog/markiro-edge@sha256:${"c".repeat(64)}`,
    workflowRunId: "123456789",
    createdAt: "2026-08-05T09:00:00.000Z",
  });
  assert.deepEqual(parseReleaseManifest(JSON.stringify(manifest), "123456789"), manifest);
});
```

Add rejection cases for extra keys, wrong repositories, tag selectors,
uppercase/short SHA, swapped digests, non-UTC time, wrong workflow run ID, and
secret-shaped extra content.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test deploy/production/test/release-manifest.test.mjs`

Expected: FAIL with module-not-found for `release-manifest.mjs`.

- [ ] **Step 3: Implement the dependency-free parser and CLI**

Export both functions and support exact CLI commands:

```text
node deploy/production/release-manifest.mjs create OUTPUT_PATH
node deploy/production/release-manifest.mjs validate INPUT_PATH EXPECTED_RUN_ID
```

`create` reads only `RELEASE_SHA`, `API_DIGEST`, `EDGE_DIGEST`,
`GITHUB_RUN_ID`, and `CREATED_AT`; creates a new mode-0600 file atomically; and
prints only `release manifest created`. `validate` prints the SHA and repository
digests only after full validation.

- [ ] **Step 4: Publish the durable manifest after both image pushes**

Extend the `publish` job after digest extraction:

```yaml
- name: Create trusted release manifest
  env:
    RELEASE_SHA: ${{ github.sha }}
    API_DIGEST: ${{ steps.published-images.outputs.api_digest }}
    EDGE_DIGEST: ${{ steps.published-images.outputs.edge_digest }}
    CREATED_AT: ${{ steps.release-time.outputs.created_at }}
  run: node deploy/production/release-manifest.mjs create "$RUNNER_TEMP/release-manifest.json"
- name: Upload trusted release manifest
  uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
  with:
    name: markiro-release-manifest-${{ github.sha }}
    path: ${{ runner.temp }}/release-manifest.json
    retention-days: 90
    if-no-files-found: error
```

Generate `CREATED_AT` once in a named step. Do not reuse the one-day image tar
artifact as deployment evidence.

- [ ] **Step 5: Verify workflow mutations fail and the suite passes**

Run:

```bash
node --test deploy/production/test/release-manifest.test.mjs deploy/production/test/workflow-contract.test.mjs
corepack pnpm test:production-bundle:contract
```

Expected: PASS, including mutations that move manifest creation before either
push or replace a digest with a tag.

- [ ] **Step 6: Commit release evidence**

```bash
git add .github/workflows/release-images.yml deploy/production
git commit -m "feat(release): publish trusted deployment manifest"
```

## Phase B — Terraform foundation

### Task 3: Pinned Terraform roots and executable contract harness

**Files:**

- Create: `infra/yandex/bootstrap/versions.tf`
- Create: `infra/yandex/bootstrap/providers.tf`
- Create: `infra/yandex/bootstrap/variables.tf`
- Create: `infra/yandex/production/versions.tf`
- Create: `infra/yandex/production/providers.tf`
- Create: `infra/yandex/production/variables.tf`
- Create: `infra/yandex/production/backend.hcl.example`
- Create: `infra/yandex/test/infra-contract.test.mjs`
- Create: `infra/yandex/scripts/check-toolchain.mjs`
- Create: `infra/yandex/README.md`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**

- Consumes: `YC_CLOUD_ID`, `YC_FOLDER_ID`, `YC_TOKEN`, backend `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` supplied only at runtime.
- Produces: `pnpm test:yandex-infra:contract`; two Terraform roots pinned to Terraform 1.15.8/provider 0.215.0; partial S3 backend configuration.

- [ ] **Step 1: Write failing root/toolchain contracts**

Create a Node test that reads both roots and asserts:

```js
for (const root of ["bootstrap", "production"]) {
  const versions = await readFile(`infra/yandex/${root}/versions.tf`, "utf8");
  assert.match(versions, /required_version\s*=\s*"= 1\.15\.8"/);
  assert.match(versions, /source\s*=\s*"yandex-cloud\/yandex"/);
  assert.match(versions, /version\s*=\s*"= 0\.215\.0"/);
  assert.doesNotMatch(versions, /latest|>=|~>/);
}
```

Also reject committed `.tfstate`, `.tfplan`, backend credentials, nonblank
secret variables, and backend blocks containing literal access keys.

- [ ] **Step 2: Run the contract and verify RED**

Run: `node --test infra/yandex/test/infra-contract.test.mjs`

Expected: FAIL because the Terraform roots do not exist.

- [ ] **Step 3: Create the exact provider contract**

Both roots use:

```hcl
terraform {
  required_version = "= 1.15.8"
  required_providers {
    yandex = {
      source  = "yandex-cloud/yandex"
      version = "= 0.215.0"
    }
  }
}
```

Provider configuration reads cloud/folder IDs from variables and the temporary
IAM token from `YC_TOKEN`. Production declares a partial `backend "s3" {}`;
`backend.hcl.example` contains only endpoint, bucket-name example, region,
state key, and Yandex compatibility flags—never credentials.

- [ ] **Step 4: Add validation commands and ignore rules**

Add:

```json
"test:yandex-infra:contract": "node --test infra/yandex/test/*.test.mjs"
```

Ignore `.terraform/`, `*.tfstate*`, `*.tfplan`, generated backend files, and
local `.auto.tfvars`, while retaining `*.example` and `.terraform.lock.hcl`.
`check-toolchain.mjs` parses `terraform version -json` and both lock files,
requiring exactly Terraform 1.15.8, provider 0.215.0, `linux_amd64`, and
`darwin_arm64` hashes.

- [ ] **Step 5: Initialize without a backend and lock providers**

Run:

```bash
terraform -chdir=infra/yandex/bootstrap init -backend=false
terraform -chdir=infra/yandex/production init -backend=false
terraform -chdir=infra/yandex/bootstrap providers lock -platform=linux_amd64 -platform=darwin_arm64 yandex-cloud/yandex
terraform -chdir=infra/yandex/production providers lock -platform=linux_amd64 -platform=darwin_arm64 yandex-cloud/yandex
terraform fmt -recursive -check infra/yandex
terraform -chdir=infra/yandex/bootstrap validate
terraform -chdir=infra/yandex/production validate
corepack pnpm test:yandex-infra:contract
```

Expected: all commands exit 0. If the Yandex mirror differs from the public
registry, regenerate both locks with the documented mirror and both platforms;
never delete the lock to silence the check.

- [ ] **Step 6: Commit Terraform foundations**

```bash
git add .gitignore package.json infra/yandex
git commit -m "build(infra): pin Yandex Terraform toolchain"
```

### Task 4: Bootstrap state, workload identity, and secret containers

**Files:**

- Create: `infra/yandex/bootstrap/main.tf`
- Create: `infra/yandex/bootstrap/outputs.tf`
- Create: `infra/yandex/bootstrap/terraform.tfvars.example`
- Create: `infra/yandex/modules/iam/main.tf`
- Create: `infra/yandex/modules/iam/variables.tf`
- Create: `infra/yandex/modules/iam/outputs.tf`
- Modify: `infra/yandex/test/infra-contract.test.mjs`
- Modify: `infra/yandex/README.md`

**Interfaces:**

- Consumes: cloud/folder/organization IDs, GitHub repository `thevladbog/q`, production environment name, globally unique state bucket name.
- Produces: service-account IDs, workload federation ID, state bucket name, runtime/state/runner Lockbox secret IDs; no secret payload output.

- [ ] **Step 1: Write failing bootstrap invariants**

Assert exact resource classes and forbidden resources:

```js
for (const name of ["terraform", "state", "app", "runner", "audit"]) {
  assert.match(bootstrap, new RegExp(`yandex_iam_service_account" "${name}`));
}
assert.match(bootstrap, /yandex_iam_workload_identity_federation/);
assert.match(bootstrap, /yandex_iam_workload_identity_federated_credential/);
assert.match(bootstrap, /versioning[\s\S]*enabled\s*=\s*true/);
assert.doesNotMatch(bootstrap, /yandex_iam_service_account_(static_)?access_key/);
assert.doesNotMatch(bootstrap, /yandex_lockbox_secret_version/);
```

Also require `prevent_destroy` on the state bucket and every Lockbox secret,
repository/environment-restricted federation claims, and outputs marked
`sensitive = true` where an ID reveals a protected resource relationship.

- [ ] **Step 2: Run focused contracts and verify RED**

Run: `corepack pnpm test:yandex-infra:contract`

Expected: FAIL on missing bootstrap resources.

- [ ] **Step 3: Implement bootstrap resources with narrow IAM**

Create the five service accounts, state bucket, workload federation/federated
credential, and three empty secret containers:

```hcl
locals {
  github_subject = "repo:${var.github_repository}:environment:${var.github_environment}"
  labels         = { app = "markiro", environment = "production", managed_by = "terraform" }
}

resource "yandex_lockbox_secret" "runtime" {
  name      = "markiro-production-runtime"
  folder_id = var.folder_id
  labels    = local.labels
  lifecycle { prevent_destroy = true }
}
```

Use resource-level IAM membership where supported. The app account reads only
runtime; runner reads only runner-registration; Terraform reads state-backend
and manages the production folder; audit writes only its destinations. Do not
grant primitive `admin` or `editor` to runtime accounts.

- [ ] **Step 4: Document the one-time state migration boundary**

`README.md` must give this exact safe order: local bootstrap plan, approved
apply, out-of-band state HMAC creation, direct Lockbox upload, backend init with
environment credentials, `terraform init -migrate-state`, remote object/version
verification, and secure deletion of the local authoritative state. Commands
must never place secret values in arguments or print state.

- [ ] **Step 5: Validate and run mutation contracts**

Run:

```bash
terraform fmt -recursive -check infra/yandex
terraform -chdir=infra/yandex/bootstrap validate
corepack pnpm test:yandex-infra:contract
```

Expected: PASS. Mutations adding a static key resource, secret version, broad
runtime role, disabled versioning, or removing `prevent_destroy` must fail.

- [ ] **Step 6: Commit bootstrap**

```bash
git add infra/yandex
git commit -m "feat(infra): define protected Yandex bootstrap"
```

### Task 5: Private network and replaceable compute

**Files:**

- Create: `infra/yandex/modules/network/main.tf`
- Create: `infra/yandex/modules/network/variables.tf`
- Create: `infra/yandex/modules/network/outputs.tf`
- Create: `infra/yandex/modules/compute/main.tf`
- Create: `infra/yandex/modules/compute/variables.tf`
- Create: `infra/yandex/modules/compute/outputs.tf`
- Create: `infra/yandex/modules/compute/cloud-init-app.yaml.tftpl`
- Create: `infra/yandex/modules/compute/cloud-init-runner.yaml.tftpl`
- Create: `infra/yandex/production/main.tf`
- Create: `infra/yandex/production/outputs.tf`
- Create: `infra/yandex/production/terraform.tfvars.example`
- Modify: `infra/yandex/test/infra-contract.test.mjs`

**Interfaces:**

- Consumes: folder/zone/CIDRs, app and runner service-account IDs, pinned Ubuntu LTS image family, SSH access via OS Login.
- Produces: network/subnet/SG IDs, private app IP, app target group, stopped runner VM ID; no public VM IP output.

- [ ] **Step 1: Write failing network and compute contracts**

Require app, runner, ALB, and data security groups; NAT routes; OS Login; no VM
`nat = true`; TCP 22 only runner-SG to app-SG; app port 8080 only ALB-SG to
app-SG; PostgreSQL port 6432 only app-SG to data-SG.

```js
assert.doesNotMatch(compute, /nat\s*=\s*true/);
assert.match(compute, /enable-oslogin\s*=\s*true/);
assert.match(
  network,
  /from_port\s*=\s*8080[\s\S]*security_group_id\s*=\s*yandex_vpc_security_group\.alb\.id/,
);
assert.match(
  network,
  /from_port\s*=\s*22[\s\S]*security_group_id\s*=\s*yandex_vpc_security_group\.runner\.id/,
);
```

- [ ] **Step 2: Run contracts and verify RED**

Run: `corepack pnpm test:yandex-infra:contract`

Expected: FAIL on missing network/compute modules.

- [ ] **Step 3: Implement network isolation**

Create one VPC, explicit ALB/application/data/management subnets, NAT gateway,
route table, and four SGs. Allow public ingress only on the ALB SG ports 80/443.
Use SG references for every east-west rule; do not use the whole VPC CIDR when a
source SG is available.

- [ ] **Step 4: Implement app and normally stopped runner VMs**

Both VMs use the pinned Ubuntu LTS family, serial console disabled, OS Login
enabled, no `nat`, encrypted/managed boot disks where supported, and rendered
cloud-init. App metadata contains no runtime payload. Runner metadata contains
no GitHub registration credential. Runner cloud-init installs and enables the
JIT unit, writes a non-secret ready marker, then uses its `power_state` block to
power off after first-boot provisioning. Terraform exposes only its VM ID; the
controller and overrun alert enforce the normally stopped operational state.

- [ ] **Step 5: Validate topology and negative mutations**

Run:

```bash
terraform fmt -recursive -check infra/yandex
terraform -chdir=infra/yandex/production validate
corepack pnpm test:yandex-infra:contract
```

Expected: PASS; mutations enabling VM NAT, opening port 22 to a CIDR, opening
8080 publicly, or embedding a secret in cloud-init fail.

- [ ] **Step 6: Commit private compute**

```bash
git add infra/yandex
git commit -m "feat(infra): add private Yandex compute network"
```

### Task 6: Managed PostgreSQL, media storage, and durable protections

**Files:**

- Create: `infra/yandex/modules/postgres/main.tf`
- Create: `infra/yandex/modules/postgres/variables.tf`
- Create: `infra/yandex/modules/postgres/outputs.tf`
- Create: `infra/yandex/modules/object-storage/main.tf`
- Create: `infra/yandex/modules/object-storage/variables.tf`
- Create: `infra/yandex/modules/object-storage/outputs.tf`
- Modify: `infra/yandex/production/main.tf`
- Modify: `infra/yandex/production/variables.tf`
- Modify: `infra/yandex/production/outputs.tf`
- Modify: `infra/yandex/test/infra-contract.test.mjs`

**Interfaces:**

- Consumes: network/data SG, database name, private bucket names, app/audit service-account IDs.
- Produces: PostgreSQL cluster/database identifiers and FQDN, media bucket name, audit bucket name; no password or access-secret output.

- [ ] **Step 1: Write failing data-resource contracts**

Require PostgreSQL 17, one private host, 14-day retention, maintenance window,
PITR-compatible backup config, and `prevent_destroy`. Require media/audit bucket
privacy, versioning, media 30/7 lifecycle, and no Terraform-managed database
password, S3 static key, or secret payload.

```js
assert.match(postgres, /version\s*=\s*"17"/);
assert.match(postgres, /backup_retain_period_days\s*=\s*14/);
assert.doesNotMatch(postgres, /assign_public_ip\s*=\s*true/);
assert.doesNotMatch(postgres, /password\s*=/);
assert.match(storage, /noncurrent_version_expiration[\s\S]*days\s*=\s*30/);
assert.match(storage, /abort_incomplete_multipart_upload_days\s*=\s*7/);
```

- [ ] **Step 2: Run contracts and verify RED**

Run: `corepack pnpm test:yandex-infra:contract`

Expected: FAIL on missing data modules.

- [ ] **Step 3: Implement the private PostgreSQL boundary**

Create the cluster and database only. Do not declare a Terraform database user
whose password would enter state. Set one host in the data subnet, public
access false, exact version 17, backup window, retention 14, maintenance window,
and disk sizing variables with safe minimum validation. Output IDs/FQDN only.

- [ ] **Step 4: Implement private versioned buckets**

Create media and audit buckets with public ACL/policy disabled, versioning
enabled, server-side encryption if the chosen provider resources support the
approved key path, `prevent_destroy`, and exact lifecycle values. Grant app only
media object operations and audit only archive write operations.

- [ ] **Step 5: Validate data boundaries**

Run Terraform format/validate and infra contracts. Expected: PASS, including
negative mutations for public PostgreSQL, 7-day backup retention, public bucket,
missing versioning, broad app access, and any password/static-key resource.

- [ ] **Step 6: Commit managed data**

```bash
git add infra/yandex
git commit -m "feat(infra): add protected PostgreSQL and storage"
```

### Task 7: ALB, certificate, Smart Web Security, and gated DNS

**Files:**

- Create: `infra/yandex/modules/ingress/main.tf`
- Create: `infra/yandex/modules/ingress/variables.tf`
- Create: `infra/yandex/modules/ingress/outputs.tf`
- Modify: `infra/yandex/production/main.tf`
- Modify: `infra/yandex/production/variables.tf`
- Modify: `infra/yandex/production/outputs.tf`
- Modify: `infra/yandex/test/infra-contract.test.mjs`

**Interfaces:**

- Consumes: ALB subnets/SG, app target group, domain, Cloud DNS zone ID, `public_dns_enabled`, log group ID.
- Produces: reserved public IPv4 address, certificate ID/status output, ALB ID/address, backend group ID, SWS profile ID, conditional DNS record.

- [ ] **Step 1: Write failing ingress contracts**

Require HTTP redirect listener, HTTPS listener with Certificate Manager,
backend port 8080, `/health/ready` with authority, SWS profile attachment,
ARL rules, and DNS `count = var.public_dns_enabled ? 1 : 0` with default false.

```js
assert.match(ingress, /path\s*=\s*"\/health\/ready"/);
assert.match(ingress, /port\s*=\s*8080/);
assert.match(ingress, /security_profile_id\s*=\s*yandex_sws_security_profile\.markiro\.id/);
assert.match(ingress, /count\s*=\s*var\.public_dns_enabled\s*\?\s*1\s*:\s*0/);
assert.match(variables, /variable "public_dns_enabled"[\s\S]*default\s*=\s*false/);
```

- [ ] **Step 2: Run contracts and verify RED**

Run: `corepack pnpm test:yandex-infra:contract`

Expected: FAIL on missing ingress resources.

- [ ] **Step 3: Implement certificate and ALB routing**

Create reserved external IPv4, managed certificate, target/backend group, HTTP
router/virtual host, HTTP redirect listener, HTTPS TLS listener, and health
check. The backend target is app private IP:8080. The health authority and
virtual-host authority are the exact domain.

- [ ] **Step 4: Attach SWS and conservative ARL**

Create the security and ARL profiles with explicit default action and named
rules for global and per-IP request rates. Attach the security profile through
the ALB virtual-host route options. Expose rate values as validated numeric
variables; defaults must be conservative but high enough for CommerceML upload
requests, which are not constrained by a generic body limit.

- [ ] **Step 5: Implement the separate DNS gate**

Create only Certificate Manager validation records before go-live. Put the
application `A` record behind `public_dns_enabled`. No `AAAA` record is emitted
until an IPv6 address is explicitly designed and approved. Output the exact
approved A set for the existing DNS verifier.

- [ ] **Step 6: Validate ingress and mutations**

Run format, production validate, and contracts. Expected: PASS; mutations that
detach SWS, route HTTPS directly to API, use backend 443, probe liveness instead
of readiness, or default DNS to true fail.

- [ ] **Step 7: Commit protected ingress**

```bash
git add infra/yandex
git commit -m "feat(infra): add protected Yandex ingress"
```

### Task 8: Logging, metrics, audit, and alert contracts

**Files:**

- Create: `infra/yandex/modules/observability/main.tf`
- Create: `infra/yandex/modules/observability/variables.tf`
- Create: `infra/yandex/modules/observability/outputs.tf`
- Modify: `infra/yandex/production/main.tf`
- Modify: `infra/yandex/production/variables.tf`
- Modify: `infra/yandex/test/infra-contract.test.mjs`

**Interfaces:**

- Consumes: ALB/SWS/VM/PostgreSQL/certificate/runner identifiers, audit bucket, notification channel ID.
- Produces: application/security/audit log group IDs, Audit Trail ID, dashboard ID, alert IDs.

- [ ] **Step 1: Write failing observability contracts**

Assert 14-day operational log retention, separate audit destination, 90-day
audit lifecycle, management events plus selected Lockbox/Object Storage data
events, and alerts for every spec category. Reject audit recursion and an empty
notification channel.

- [ ] **Step 2: Run contracts and verify RED**

Run: `corepack pnpm test:yandex-infra:contract`

Expected: FAIL on missing observability module.

- [ ] **Step 3: Implement log and audit destinations**

Create separate application/security and audit log groups. Configure ALB/SWS
logging. Create two distinct Audit Trails because one trail has one destination:
the first sends production-folder management events and selected Lockbox/media
data events to Cloud Logging for near-real-time use; the second archives the
same approved event scope to the dedicated audit bucket. Do not select that
destination bucket as its own data-event source.

- [ ] **Step 4: Implement dashboard and minimum alerts**

Create dashboard widgets and alerts for ALB healthy backend/5xx/latency, SWS
deny/ARL spikes, VM CPU/memory/disk, PostgreSQL availability/storage/connections/
backup age, certificate risk, readiness optional-dependency degradation,
deployment failure, and runner-overrun. Every alert uses the required
`notification_channel_id` input.

- [ ] **Step 5: Validate monitoring mutations**

Run format, validate, and contracts. Expected: PASS; removing any critical
alert, setting logs to unlimited retention, reusing media/state as audit
destination, or omitting the channel fails.

- [ ] **Step 6: Commit observability**

```bash
git add infra/yandex
git commit -m "feat(infra): add SaaS observability and audit"
```

## Phase C — Private runtime and delivery

### Task 9: Lockbox environment materialization and local readiness observer

**Files:**

- Create: `deploy/yandex/runtime-env.mjs`
- Create: `deploy/yandex/readiness-observer.mjs`
- Create: `deploy/yandex/test/runtime-env.test.mjs`
- Create: `deploy/yandex/test/readiness-observer.test.mjs`
- Create: `deploy/yandex/systemd/markiro-runtime-env.service`
- Create: `deploy/yandex/systemd/markiro-readiness-observer.service`
- Create: `deploy/yandex/systemd/markiro-readiness-observer.timer`
- Modify: `infra/yandex/modules/compute/cloud-init-app.yaml.tftpl`
- Modify: `package.json`

**Interfaces:**

- Consumes: instance metadata IAM token, runtime Lockbox secret ID, exact `.env.production.example` key inventory, `http://127.0.0.1:3000/health/ready`.
- Produces: `materializeRuntimeEnv(deps): Promise<void>` writing `/etc/markiro/production.env` mode 0600; `observeReadiness(deps): Promise<SanitizedObservation>`.

- [ ] **Step 1: Write failing runtime environment tests**

Use injected fetch/filesystem dependencies and assert: complete payload writes
to a sibling temporary file then fsync/chmod/rename; missing/duplicate/unknown
keys fail; failed refresh preserves the previous valid file; errors contain no
secret value, URL userinfo, endpoint, or raw Lockbox response.

```js
await materializeRuntimeEnv({
  secretId: "runtime-secret-id",
  destination: "/etc/markiro/production.env",
  fetchIamToken,
  fetchSecretPayload,
  fs: fakeFs,
});
assert.equal(fakeFs.files.get("/etc/markiro/production.env").mode, 0o600);
assert.match(fakeFs.files.get("/etc/markiro/production.env").text, /^DATABASE_URL=/m);
```

- [ ] **Step 2: Write failing readiness observer tests**

Assert exact output categories `ok`, `smtp_degraded`, `storage_degraded`, and
`required_unavailable`; 2-second timeout; no raw body logging; and non-zero
exit on malformed JSON.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `node --test deploy/yandex/test/runtime-env.test.mjs deploy/yandex/test/readiness-observer.test.mjs`

Expected: FAIL with module-not-found.

- [ ] **Step 4: Implement bounded metadata and Lockbox clients**

Use Node built-in `fetch`, `AbortSignal.timeout(2_000)`, the metadata IAM-token
endpoint, and Lockbox payload API. Accept only the exact key inventory, sort
keys before rendering, encode newline-containing values safely or reject them,
and perform atomic replace with mode 0600. Export pure functions and keep CLI
entrypoints behind the repository's portable main-module detector.

- [ ] **Step 5: Install exact systemd units through cloud-init**

`markiro-runtime-env.service` runs before Compose and before each deploy.
Readiness timer runs every minute as the unprivileged monitoring user and emits
one sanitized category line consumable by Unified Agent. Cloud-init installs
files with explicit owners/modes and contains only secret IDs, never payloads.

- [ ] **Step 6: Verify runtime helpers and production contracts**

Run:

```bash
node --test deploy/yandex/test/*.test.mjs
corepack pnpm test:production-bundle:contract
corepack pnpm test:yandex-infra:contract
```

Expected: PASS with 0 failures.

- [ ] **Step 7: Commit runtime materialization**

```bash
git add package.json deploy/yandex infra/yandex/modules/compute
git commit -m "feat(deploy): materialize Yandex runtime secrets"
```

### Task 10: Serialized infrastructure CI and protected apply

**Files:**

- Create: `.github/workflows/yandex-infrastructure.yml`
- Create: `infra/yandex/scripts/validate-plan-summary.mjs`
- Modify: `infra/yandex/test/infra-contract.test.mjs`
- Modify: `infra/yandex/README.md`

**Interfaces:**

- Consumes: GitHub OIDC token; protected variables `YC_CLOUD_ID`, `YC_FOLDER_ID`, federation/audience IDs, state secret ID; protected `production-infrastructure` environment.
- Produces: untrusted PR validate job; trusted read-only plan; manual approved saved-plan apply; separate `enable_public_dns` boolean input.

- [ ] **Step 1: Write failing workflow contracts**

Parse workflow YAML and require exact permissions, triggers, concurrency, job
separation, environment, immutable action SHAs, Terraform version, no
`pull_request_target`, no `-auto-approve`, no `terraform output`, no full
`terraform show -json`, and cleanup of backend environment variables.

```js
assert.deepEqual(workflow.permissions, { contents: "read" });
assert.equal(workflow.concurrency.group, "markiro-yandex-production-state");
assert.equal(workflow.concurrency["cancel-in-progress"], false);
assert.equal(workflow.jobs.apply.environment, "production-infrastructure");
assert.equal(workflow.jobs.apply.permissions["id-token"], "write");
```

- [ ] **Step 2: Run contracts and verify RED**

Run: `corepack pnpm test:yandex-infra:contract`

Expected: FAIL because the workflow does not exist.

- [ ] **Step 3: Implement untrusted validation and trusted planning**

PRs always run format, lock, `init -backend=false`, validate, and contract tests
without credentials. A protected job may exchange GitHub OIDC for Yandex IAM,
read only the state-backend HMAC secret, run `init`, and create a binary plan.
`validate-plan-summary.mjs` emits resource counts and action classes only; it
rejects sensitive values and never serializes complete changes.

- [ ] **Step 4: Implement same-commit approved apply**

On `workflow_dispatch`, regenerate the plan from the selected `main` SHA inside
the non-cancelling concurrency group, upload it with SHA256 evidence, enter the
protected environment, recheck artifact SHA/commit, and run
`terraform apply saved.tfplan`. Set `public_dns_enabled=false` unless the exact
boolean input is true and the separate DNS environment approval is present.

- [ ] **Step 5: Test security mutations**

Add mutations for PR credentials, cancellable concurrency, applying PR plans,
missing environment approval, stale commit, unmasked backend HMAC, public DNS
default true, broad permissions, mutable action tags, and absent cleanup.

- [ ] **Step 6: Run workflow and infrastructure suites**

Run:

```bash
corepack pnpm test:yandex-infra:contract
corepack pnpm test:production-bundle:contract
```

Expected: PASS with 0 failures.

- [ ] **Step 7: Commit infrastructure CI**

```bash
git add .github/workflows/yandex-infrastructure.yml infra/yandex
git commit -m "ci(infra): add protected Yandex plan and apply"
```

### Task 11: JIT runner control and digest-evidenced production deployment

**Files:**

- Create: `deploy/yandex/runner-control.mjs`
- Create: `deploy/yandex/remote-deploy.mjs`
- Create: `deploy/yandex/test/runner-control.test.mjs`
- Create: `deploy/yandex/test/remote-deploy.test.mjs`
- Create: `deploy/yandex/systemd/markiro-runner.service`
- Create: `.github/workflows/deploy-production.yml`
- Modify: `infra/yandex/modules/compute/cloud-init-runner.yaml.tftpl`
- Modify: `infra/yandex/test/infra-contract.test.mjs`
- Modify: `deploy/production/test/workflow-contract.test.mjs`
- Modify: `docs/runbooks/saas-production-deploy.md`

**Interfaces:**

- Consumes: trusted `ReleaseManifest`, app/runner VM IDs, OS Login service-account profile, runner-only registration secret, protected `production` environment.
- Produces: `startRunner(deps)`, `waitForRunner(deps)`, `stopRunner(deps)`, `deployRelease(deps, manifest)`; one-use runner job; protected healthy/failed release record.

- [ ] **Step 1: Write failing runner lifecycle tests**

Use fake Yandex/GitHub clients and a fake clock. Assert start from `STOPPED`,
bounded wait for `RUNNING` and online JIT label, rejection if already running
without this deployment ID, one job only, deregistration, and stop in every
failure path.

```js
await assert.rejects(
  withRunner(fakeDeps, async () => {
    throw new Error("deploy failed");
  }),
  /deploy failed/,
);
assert.deepEqual(fakeDeps.calls.slice(-2), ["deregister", "stop"]);
```

- [ ] **Step 2: Write failing remote deployment tests**

Assert order: validate manifest → verify infrastructure/backup → start runner →
transfer exact bundle → refresh runtime env → production preflight → pull
digests → migrate → API ready → edge ready → ALB healthy → external smoke →
healthy record. Assert migration failure switches nothing; readiness/smoke
failure redeploys the previous digest pair; cleanup failure is reported without
masking the deployment error.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `node --test deploy/yandex/test/runner-control.test.mjs deploy/yandex/test/remote-deploy.test.mjs`

Expected: FAIL with module-not-found.

- [ ] **Step 4: Implement injectable controller modules**

Keep child-process/Yandex/GitHub/clock/filesystem functions behind injected
interfaces. Validate the release manifest with Task 2's parser. Transfer only
`compose.production.yml`, `deploy/production`, and required immutable metadata
to `/opt/markiro/releases/${manifest.commit}` through OS Login internal-address
access.
Invoke the existing production deployment script remotely with digest inputs
in environment, never shell-interpolated arguments.

- [ ] **Step 5: Implement JIT runner boot and independent cleanup**

The runner systemd unit fetches its runner-only Lockbox payload, requests an
exactly one-use JIT configuration scoped to the deployment label, starts the
pinned GitHub runner binary, deletes temporary registration material, and
shuts itself down after the job. A GitHub-hosted `cleanup` job with `if: always()`
uses Yandex OIDC to deregister any stale runner and stop the VM even when the
self-hosted job never starts.

- [ ] **Step 6: Implement the protected deployment workflow**

Trigger only by `workflow_dispatch` and trusted successful release workflow.
Require the `production` environment, exact release workflow run ID/SHA,
`id-token: write`, contents read, no package write, and a unique deployment ID.
Do not use PR events. The self-hosted job uses the JIT label containing that ID.

- [ ] **Step 7: Verify failure and workflow mutations**

Run:

```bash
node --test deploy/yandex/test/*.test.mjs
corepack pnpm test:production-bundle:contract
corepack pnpm test:yandex-infra:contract
```

Expected: PASS. Mutations removing `always()`, allowing PR triggers, using a
static runner label, accepting tag manifests, skipping backup/ALB checks,
printing SSH/provider stderr, or reversing migrations fail.

- [ ] **Step 8: Commit private deployment**

```bash
git add .github/workflows/deploy-production.yml deploy/yandex infra/yandex docs/runbooks/saas-production-deploy.md
git commit -m "feat(deploy): add private Yandex production delivery"
```

## Phase D — Operations and release gate

### Task 12: Bootstrap, secrets, recovery, and first go-live runbooks

**Files:**

- Create: `docs/runbooks/yandex-bootstrap.md`
- Create: `docs/runbooks/yandex-secrets.md`
- Create: `docs/runbooks/yandex-infrastructure-apply.md`
- Create: `docs/runbooks/yandex-recovery.md`
- Create: `docs/runbooks/yandex-first-go-live.md`
- Create: `infra/yandex/test/runbook-contract.test.mjs`
- Modify: `docs/runbooks/saas-production-deploy.md`
- Modify: `docs/architecture.md`
- Modify: `docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md`
- Modify: `package.json`

**Interfaces:**

- Consumes: outputs and workflows from Tasks 1–11.
- Produces: executable operator sequence and evidence checklist; no live apply or DNS mutation by CI tests.

- [ ] **Step 1: Write failing runbook contracts**

Require each document and exact ordered markers for bootstrap state migration,
out-of-band database/S3/SMTP/GHCR/runner secrets, rotation without logging,
approved plan/apply, PostgreSQL/media/state/VM restore drills, alert delivery,
rollback rehearsal, and `public_dns_enabled=true` only after all eleven gates.

Reject commands containing:

```text
terraform output -json
terraform show -json
docker compose config
set -x
--password=
public_dns_enabled=true -auto-approve
```

Allow `docker compose config --quiet` only.

- [ ] **Step 2: Run the runbook contract and verify RED**

Run: `node --test infra/yandex/test/runbook-contract.test.mjs`

Expected: FAIL because the runbooks do not exist.

- [ ] **Step 3: Write bootstrap and secret runbooks**

Document prerequisites, organization OS Login, service-account OS Login
profile, state bootstrap/migration, state-HMAC creation directly into Lockbox,
database-user creation outside Terraform, runtime payload inventory, S3/GHCR/
SMTP credentials, mode checks, rotation order, health verification, and audit
evidence. Every secret prompt uses stdin or a protected file descriptor and
disables shell tracing.

- [ ] **Step 4: Write infrastructure and recovery runbooks**

Document exact format/validate/plan/apply commands, protected workflow inputs,
drift handling, and why local apply is prohibited. Recovery covers temporary
PostgreSQL PITR restore, migration/smoke, previous media version restore,
isolated state-version validation, app VM recreation, evidence IDs, observed
RTO/RPO, and separately confirmed cleanup.

- [ ] **Step 5: Write the first go-live checklist**

Encode the eleven spec gates in exact order. Keep DNS false through certificate,
WAF/ARL, backup/restore, SMTP/S3, release manifest, deploy/smoke/rollback,
multi-user tenant RBAC, and notification delivery checks. Then run a separate
DNS plan/apply and reuse the existing authoritative/public convergence verifier
before opening normal SWS traffic.

- [ ] **Step 6: Update architecture and roadmap truthfully**

Mark repository implementation separately from live Yandex deployment. Record
the single-VM/single-PostgreSQL-host downtime limitation, the deferred HA path,
GHCR retention, private shared media bucket, and remaining requirements for
real cloud IDs/domain/secrets/restore evidence.

- [ ] **Step 7: Run documentation and complete repository verification**

Run:

```bash
node --test infra/yandex/test/runbook-contract.test.mjs
corepack pnpm test:yandex-infra:contract
corepack pnpm test:production-bundle:contract
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
git diff --check
git status --short
```

Expected: every command exits 0; only intended tracked changes are present.
Report live Yandex apply, restore, SMTP, alert, and DNS checks as not run until
the required production inputs and explicit apply approval exist.

- [ ] **Step 8: Commit documentation and request code review**

```bash
git add package.json docs infra/yandex
git commit -m "docs(infra): add Yandex SaaS operations"
```

Invoke `superpowers:requesting-code-review`. Address findings using
`superpowers:receiving-code-review`, rerun the full verification commands, push
`codex/yandex-saas-infrastructure-design`, and create a ready PR only when all
repository gates are green. Do not apply Terraform or enable public DNS as part
of PR creation.

## Live rollout follow-up

After the implementation PR is merged and the user supplies the required
Yandex organization/cloud/folder IDs, public DNS zone/domain control,
notification destination, and production secret payloads, execute the live
runbooks as a separately approved operation. Record actual resource IDs and
evidence in the protected operational system, never in Git or chat. A live
rollout is complete only after restore, delivery, rollback, alert, and DNS gates
pass; repository CI alone is not completion evidence.
