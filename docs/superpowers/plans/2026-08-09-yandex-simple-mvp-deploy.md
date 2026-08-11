# Yandex Simple MVP Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the failing private JIT runner and OS Login delivery path with one manually approved GitHub-hosted SSH deployment while preserving the existing digest-pinned Compose runtime and managed Yandex data and ingress services.

**Architecture:** A single `ubuntu-latest` job exchanges GitHub OIDC for the existing deployment service account, validates the app VM and its authenticated serial host keys, then connects to a Terraform-managed static public address with an operator-managed Ed25519 key. Terraform removes only runner-specific compute, IAM and monitoring resources, creates the dedicated key-only `markiro-deploy` account, and leaves PostgreSQL, Object Storage, ALB, TLS, SWS, ARL, audit and public-DNS gating intact.

**Tech Stack:** GitHub Actions, Node.js 24 ESM and `node:test`, Terraform 1.15.8 with `yandex-cloud/yandex` 0.215.0, Yandex Compute/Lockbox/ALB APIs, OpenSSH, cloud-init, Docker Compose.

## Global Constraints

- Work only in the isolated `codex/simplify-mvp-deploy` worktree; preserve the user's main checkout and its `.pnpm-store/` directory.
- Use test-driven development: add a focused failing contract before each production change and keep mutation coverage for every security boundary changed.
- Keep `public_dns_enabled = false` throughout implementation and the infrastructure transition.
- Preserve immutable GHCR digests, exact release-run/SHA validation, rollback rehearsal, first/repeat smoke, finalized-release evidence and deployment-failure telemetry.
- Preserve Managed PostgreSQL, Object Storage, KMS, ALB, certificates, DNS zone, SWS, ARL, audit trails, backups and application runtime secrets.
- Never write the private SSH key to Git, Terraform input/state/output, artifacts or logs; materialize it only under `$RUNNER_TEMP` with mode `0600` and remove it under `if: always()`.
- Allow TCP/22 from `0.0.0.0/0` only as the documented one-customer MVP exception; keep app port 8080 reachable only from the ALB security group.
- Use only the dedicated `markiro-deploy` user with public-key authentication, `PermitRootLogin no`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `ChallengeResponseAuthentication no`, and explicit administrator-equivalent sudo.
- Do not use `ssh-keyscan`, `StrictHostKeyChecking=accept-new`, OS Login, a self-hosted runner, automatic `workflow_run` deployment, raw SSH stderr or mutable image tags.
- The retained runner-registration Lockbox resource is an empty `prevent_destroy` tombstone with no payload and no IAM reader; removing it from bootstrap state is a separate change.

---

## File and Interface Map

- `deploy/yandex/hosted-deploy-context.mjs`: owns app/backup/ALB preflight, authenticated serial host-key parsing, hosted public/private address resolution and the bounded JSON context file.
- `deploy/yandex/remote-deploy.mjs`: owns immutable archive transfer, registry credential use, remote prepare/finalize/rollback, ALB verification and smoke; it consumes explicit hosted credentials and addresses.
- `.github/workflows/deploy-production.yml`: owns release and rehearsal evidence verification, OIDC exchange, temporary credential materialization, hosted deployment invocation, evidence upload and unconditional cleanup.
- `infra/yandex/modules/compute/*`: owns the app VM, its reserved public address, dedicated SSH account and ALB target; it no longer owns a runner VM.
- `infra/yandex/modules/network/*`: owns ALB-only app traffic, public key-only SSH and private data traffic; it no longer owns runner-only network resources.
- `infra/yandex/modules/iam/*` and `infra/yandex/bootstrap/*`: own four active service accounts, exact `production-deploy` and `production-infrastructure` OIDC subjects and least-privilege Lockbox/API access.
- `infra/yandex/production/*` and `.github/workflows/yandex-infrastructure.yml`: wire the public-key Terraform input and active resource graph without runner inputs.
- `infra/yandex/modules/observability/*` and `infra/yandex/scripts/extract-alert-specs.mjs`: define the remaining 15 alerts and app-only VM selectors.
- `docs/runbooks/*`: define key creation/rotation, protected plan review, hosted deploy, recovery and the removal of the obsolete runner alert.

### Task 1: Extract Hosted Deployment Context and Authenticated Host Keys

**Files:**

- Create: `deploy/yandex/hosted-deploy-context.mjs`
- Create: `deploy/yandex/test/hosted-deploy-context.test.mjs`
- Modify: `deploy/yandex/test/runner-control.test.mjs`

**Interfaces:**

- Consumes: Yandex IAM token and `YC_APP_INSTANCE_ID`, `YC_POSTGRES_CLUSTER_ID`, `YC_LOAD_BALANCER_ID`, `YC_BACKEND_GROUP_ID`, `YC_TARGET_GROUP_ID`, `MARKIRO_DEPLOYMENT_PHASE`.
- Produces: `parseSerialHostKeys(serialOutput: string): string`, `parseAuthenticatedHostKeys(encodedKeys: string): string[]`, `authenticatedKnownHosts(encodedKeys: string, address: string): string`, and `resolveHostedDeployContext(token: string, options): Promise<{ appPrivateAddress: string; appPublicAddress: string; appHostKeysB64: string }>`.
- CLI: `node deploy/yandex/hosted-deploy-context.mjs resolve` writes the exact three-key JSON object to `HOSTED_DEPLOY_CONTEXT_PATH` with mode `0600`; it writes no context or provider body to stdout/stderr.

- [ ] **Step 1: Write the focused failing hosted-context tests**

Add provider fixtures that return one running app interface with private `10.64.1.11`, `oneToOneNat.address` `203.0.113.44`, a recent PostgreSQL backup, the exact ALB target and two serial markers. Assert the canonical result:

```js
assert.deepEqual(await resolveHostedDeployContext("iam-token", fixture.options), {
  appPrivateAddress: "10.64.1.11",
  appPublicAddress: "203.0.113.44",
  appHostKeysB64: Buffer.from(`${ED25519_KEY}\n${RSA_KEY}`, "utf8").toString("base64"),
});
```

Add table-driven rejections for a stopped app, missing/duplicate interfaces, absent or private `oneToOneNat.address`, a public primary address, a stale/missing backup, foreign/duplicate ALB targets, repeat-phase unhealthy target state, malformed serial output, duplicate host-key algorithms and an output path that already exists. Assert every failure is a fixed safe category and does not include provider payload data or the IAM token.

- [ ] **Step 2: Run the focused test and capture RED**

Run:

```bash
node --test deploy/yandex/test/hosted-deploy-context.test.mjs
```

Expected: FAIL because `deploy/yandex/hosted-deploy-context.mjs` does not exist.

- [ ] **Step 3: Implement the minimal hosted context module**

Move the existing canonical SSH public-key validation and the app/backup/ALB gate from `runner-control.mjs` without weakening bounds. Resolve both addresses only from this exact shape:

```js
const primary = instance.networkInterfaces?.[0]?.primaryV4Address;
const context = {
  appPrivateAddress: requirePrivateIpv4(primary?.address),
  appPublicAddress: requirePublicIpv4(primary?.oneToOneNat?.address),
  appHostKeysB64: parseSerialHostKeys(serial.contents),
};
```

Keep the first-phase exception limited to the exact app target in a transitional/unhealthy state; repeat phase still requires exactly one healthy target. Write context with `flag: "wx"`, `mode: 0o600`, a 64 KiB provider-response limit and five-second request timeouts.

- [ ] **Step 4: Run hosted-context and retained runner tests GREEN**

Run:

```bash
node --test deploy/yandex/test/hosted-deploy-context.test.mjs deploy/yandex/test/runner-control.test.mjs
```

Expected: PASS, with runner tests still importing their old controller functions until Task 5 removes that subsystem.

- [ ] **Step 5: Commit the isolated context extraction**

```bash
git add deploy/yandex/hosted-deploy-context.mjs deploy/yandex/test/hosted-deploy-context.test.mjs deploy/yandex/test/runner-control.test.mjs
git commit -m "refactor(deploy): extract hosted deployment context"
```

### Task 2: Convert the Remote Adapter from OS Login to Explicit Hosted SSH

**Files:**

- Modify: `deploy/yandex/remote-deploy.mjs`
- Modify: `deploy/yandex/test/remote-deploy.test.mjs`
- Modify: `deploy/yandex/hosted-deploy-context.mjs`
- Test: `deploy/yandex/test/hosted-deploy-context.test.mjs`

**Interfaces:**

- Consumes: `YC_IAM_TOKEN`, `YC_APP_INSTANCE_ID`, `YC_APP_PRIVATE_ADDRESS`, `YC_APP_PUBLIC_ADDRESS`, `YC_APP_DEPLOY_LOGIN=markiro-deploy`, `YC_APP_DEPLOY_SSH_PRIVATE_KEY_PATH`, `APP_SSH_HOST_KEYS_B64`, release and ALB variables.
- Produces: unchanged `runRemoteDeployment(environment, supplied)` and `runRemoteDeploymentWithReporting(environment, supplied, reporting)` results and evidence shapes.
- Reuses: `authenticatedKnownHosts(encodedKeys, publicAddress)` from Task 1.

- [ ] **Step 1: Rewrite the CLI fixture first and add hosted-SSH mutations**

Change the fixture environment to explicit hosted inputs:

```js
YC_IAM_TOKEN: "hosted-iam-token",
YC_APP_PRIVATE_ADDRESS: "10.20.0.7",
YC_APP_PUBLIC_ADDRESS: "203.0.113.44",
YC_APP_DEPLOY_LOGIN: "markiro-deploy",
YC_APP_DEPLOY_SSH_PRIVATE_KEY_PATH: "/runner-temp/markiro-deploy-key",
```

Make the app API fixture return both `address: "10.20.0.7"` and `oneToOneNat: { address: "203.0.113.44" }`. Assert SSH targets `markiro-deploy@203.0.113.44`, `-i /runner-temp/markiro-deploy-key`, exact strict-host-key options, and known-host entries bound to `203.0.113.44`, while ALB verification still expects `10.20.0.7`.

Add mutations rejecting missing/private/foreign public addresses, a foreign private address, login other than `markiro-deploy`, missing/non-regular/group-readable/empty/non-OpenSSH private key, `accept-new`, `ssh-keyscan`, a certificate file, metadata-token access and `yc compute ssh certificate export`.

- [ ] **Step 2: Run the remote adapter test and capture RED**

Run:

```bash
node --test deploy/yandex/test/remote-deploy.test.mjs
```

Expected: FAIL because the current adapter requests metadata IAM, requires `YC_OS_LOGIN`, rejects `oneToOneNat`, invokes `yc`, and connects to the private address.

- [ ] **Step 3: Implement explicit token, address and key validation**

Replace metadata and certificate export with the hosted inputs. Require the current Compute response to match both supplied addresses before creating `known_hosts`:

```js
if (
  privateAddress !== requiredEnvironment("YC_APP_PRIVATE_ADDRESS", environment) ||
  publicAddress !== requiredEnvironment("YC_APP_PUBLIC_ADDRESS", environment)
)
  throw new Error("application instance network identity is invalid");
```

Validate the private-key file as a regular owner-only `0600` file with bounded nonempty OpenSSH private-key content, but never include its content or path in an error. Build SSH arguments without `CertificateFile` and keep `StrictHostKeyChecking=yes`, `BatchMode=yes`, connection timeout and keepalive options. Use the private address for `waitForAlbTarget` and the public address only for SSH/known-host binding.

- [ ] **Step 4: Make deployment telemetry use the same explicit token**

Replace `reporting.metadataIamToken` with `reporting.iamToken ?? (() => requiredEnvironment("YC_IAM_TOKEN", environment))`. Preserve the rule that a metric-emission failure never masks the primary deploy failure.

- [ ] **Step 5: Run the focused adapter/context tests GREEN**

Run:

```bash
node --test deploy/yandex/test/remote-deploy.test.mjs deploy/yandex/test/hosted-deploy-context.test.mjs
```

Expected: PASS; no test command or source match contains the metadata endpoint, `YC_OS_LOGIN`, `CertificateFile=` or `yc compute ssh certificate export`.

- [ ] **Step 6: Commit the hosted adapter**

```bash
git add deploy/yandex/remote-deploy.mjs deploy/yandex/hosted-deploy-context.mjs deploy/yandex/test/remote-deploy.test.mjs deploy/yandex/test/hosted-deploy-context.test.mjs
git commit -m "fix(deploy): use explicit hosted SSH credentials"
```

### Task 3: Collapse Deploy Production to One Manual GitHub-Hosted Job

**Files:**

- Modify: `.github/workflows/deploy-production.yml`
- Create: `deploy/yandex/test/hosted-deploy-workflow.test.mjs`
- Modify: `deploy/production/test/runbook-contract.test.mjs`

**Interfaces:**

- Consumes: protected environment variables `YC_OIDC_AUDIENCE`, `YC_DEPLOYMENT_CONTROLLER_SERVICE_ACCOUNT_ID`, existing app/PostgreSQL/ALB/registry/domain IDs, and secret `YC_APP_DEPLOY_SSH_PRIVATE_KEY`.
- Produces: unchanged `markiro-rollback-rehearsal-<sha>-attempt-<attempt>` and `markiro-finalized-release-<sha>` artifacts; no cleanup receipt.
- Calls: `hosted-deploy-context.mjs resolve` and `remote-deploy.mjs run` with Task 1/2 inputs.

- [ ] **Step 1: Add static and mutation workflow contracts**

Assert the parsed workflow has only `workflow_dispatch`, exactly one `deploy` job with `runs-on: ubuntu-latest`, `environment: production-deploy`, `id-token: write`, `actions: read`, `contents: read`, and no `workflow_run`, `self-hosted`, `controller`, `cleanup`, runner ID/secret/label or cleanup artifact.

Assert finalized first deploy still validates the exact rehearsal run ID/attempt and artifact, but its prerequisite keys are only the rehearsal evidence keys. Assert both OIDC curl and token-exchange curl pipe directly into `jq -er` inside their existing fail-closed assignment branch. Assert the key is written under `$RUNNER_TEMP`, checked at `0600`, and removed by a named `if: always()` step.

Mutation cases must reject `id-token: read`, unpinned actions, checkout of a non-release SHA, private-key upload paths, `echo` of the key/token, automatic triggers, a second protected environment and missing cleanup.

- [ ] **Step 2: Run the workflow contract and capture RED**

Run:

```bash
node --test deploy/yandex/test/hosted-deploy-workflow.test.mjs
```

Expected: FAIL because the workflow still contains automatic delivery, controller/self-hosted/cleanup jobs and three environments.

- [ ] **Step 3: Rewrite the workflow as one protected hosted job**

Retain the existing release-run lookup, SHA validation, manifest download and rehearsal validation. Remove the cleanup receipt download and validation. In the deployment step, create deterministic temporary paths and cleanup them even on failure:

```bash
set -euo pipefail
umask 077
key_path="$RUNNER_TEMP/markiro-deploy-key"
context_path="$RUNNER_TEMP/markiro-hosted-deploy-context.json"
trap 'rm -f -- "$key_path" "$context_path"' EXIT
printf '%s\n' "$YC_APP_DEPLOY_SSH_PRIVATE_KEY" > "$key_path"
chmod 600 "$key_path"
```

Exchange OIDC for `YC_DEPLOYMENT_CONTROLLER_SERVICE_ACCOUNT_ID`, mask both tokens, export the short-lived IAM token only within this step, invoke context resolution into the bounded context file, extract all three fields with `jq -er`, then invoke `remote-deploy.mjs run`. Keep fixed diagnostics and avoid printing raw provider/SSH errors.

- [ ] **Step 4: Keep evidence upload and add unconditional credential cleanup**

Preserve rehearsal/finalized JSON schemas and artifact names. Add an `if: always()` shell step that removes the deterministic key, context, manifest and result paths without globbing outside `$RUNNER_TEMP`. Do not upload or checksum any credential-bearing file.

- [ ] **Step 5: Run workflow, remote and production contracts GREEN**

Run:

```bash
node --test deploy/yandex/test/hosted-deploy-workflow.test.mjs deploy/yandex/test/remote-deploy.test.mjs deploy/production/test/runbook-contract.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit the single-job workflow**

```bash
git add .github/workflows/deploy-production.yml deploy/yandex/test/hosted-deploy-workflow.test.mjs deploy/production/test/runbook-contract.test.mjs
git commit -m "ci(deploy): use one protected hosted job"
```

### Task 4: Replace Runner Compute with a Key-Only Public App SSH Boundary

**Files:**

- Modify: `infra/yandex/modules/compute/main.tf`
- Modify: `infra/yandex/modules/compute/variables.tf`
- Modify: `infra/yandex/modules/compute/outputs.tf`
- Modify: `infra/yandex/modules/compute/cloud-init-app.yaml.tftpl`
- Delete: `infra/yandex/modules/compute/cloud-init-runner.yaml.tftpl`
- Modify: `infra/yandex/modules/network/main.tf`
- Modify: `infra/yandex/modules/network/variables.tf`
- Modify: `infra/yandex/modules/network/outputs.tf`
- Delete: `deploy/yandex/systemd/markiro-runner.service`
- Delete: `deploy/yandex/systemd/markiro-runner-monitoring.service`
- Delete: `deploy/yandex/systemd/markiro-runner-monitoring.timer`
- Modify: `infra/yandex/test/infra-contract.test.mjs`

**Interfaces:**

- Consumes: `app_deploy_ssh_public_key`, exact single-line `ssh-ed25519` public key.
- Produces: `app_private_ip`, `app_public_ip`, `app_instance_id`, `app_target_group_id`; no runner instance/security-group output.

- [ ] **Step 1: Replace private-runner assertions with the approved hosted topology contract**

Assert one `yandex_vpc_address.app` with `deletion_protection = true`, app `nat = true`, `nat_ip_address` wired to that address, ALB target using only the private interface address, TCP/8080 from the ALB security group and TCP/22 from exactly `0.0.0.0/0`. Assert no runner instance, runner security group, management subnet or runner assets remain.

Render app cloud-init with a test Ed25519 key and assert the exact `markiro-deploy` user, locked password, public key, sudo grant, fail-closed sshd drop-in, `sshd -t`, service reload and completion marker ordering. Mutation probes must reject RSA/options/multiline public-key inputs, password/root/keyboard-interactive auth, a second SSH user, a CIDR broader than the exact single approved rule shape, public port 8080 and missing address deletion protection.

- [ ] **Step 2: Run the focused infrastructure contracts and capture RED**

Run:

```bash
PATH=/Users/thevladbog/terraform:$PATH node --test --test-name-pattern='hosted app SSH|application bootstrap|production network and compute' infra/yandex/test/infra-contract.test.mjs
```

Expected: FAIL because the app is private/OS Login-enabled and the runner resources still exist.

- [ ] **Step 3: Add the reserved address and remove runner-only network resources**

Add:

```hcl
resource "yandex_vpc_address" "app" {
  name                = "markiro-production-app"
  folder_id           = var.folder_id
  deletion_protection = true
  labels              = var.labels

  external_ipv4_address {
    zone_id = var.zone
  }
}
```

Set the app interface `nat = true` and `nat_ip_address = yandex_vpc_address.app.external_ipv4_address[0].address`. Replace runner-SG SSH with the exact public TCP/22 rule. Delete the unused management subnet, runner SG and their inputs/outputs while keeping NAT egress for app/data dependencies.

- [ ] **Step 4: Add the dedicated account and harden sshd in app cloud-init**

Validate `app_deploy_ssh_public_key` with an anchored Terraform regex accepting one canonical `ssh-ed25519 <base64>` line only. Configure:

```yaml
- name: markiro-deploy
  groups: [docker, sudo]
  lock_passwd: true
  shell: /bin/bash
  sudo: ALL=(ALL) NOPASSWD:ALL
  ssh_authorized_keys:
    - ${app_deploy_ssh_public_key}
```

Write `/etc/ssh/sshd_config.d/60-markiro-deploy.conf` with the exact global directives from Global Constraints. In the existing fail-fast bootstrap script, run `/usr/sbin/sshd -t`, reload `ssh.service`, verify the account is locked and key file permissions are correct before touching `markiro-app-bootstrap-complete`. Set `enable-oslogin = false`; retain the cloud-init host-key markers and authenticated serial-output retrieval without enabling interactive serial access.

- [ ] **Step 5: Delete runner compute/bootstrap assets and expose only app addresses**

Delete the runner instance and its IAM bindings from compute. Add `app_public_ip` output, preserve `app_private_ip` for ALB targeting, and delete `runner_instance_id`. Remove the three runner systemd assets and runner cloud-init template.

- [ ] **Step 6: Run focused contracts and Terraform formatting GREEN**

Run:

```bash
PATH=/Users/thevladbog/terraform:$PATH node --test --test-name-pattern='hosted app SSH|application bootstrap|production network and compute' infra/yandex/test/infra-contract.test.mjs
PATH=/Users/thevladbog/terraform:$PATH terraform fmt -recursive -check infra/yandex
```

Expected: all selected tests and formatting pass.

- [ ] **Step 7: Commit the compute/network transition**

```bash
git add infra/yandex/modules/compute infra/yandex/modules/network deploy/yandex/systemd infra/yandex/test/infra-contract.test.mjs
git commit -m "feat(infra): expose key-only MVP deploy SSH"
```

### Task 5: Narrow IAM, Bootstrap, Production Wiring and Infrastructure Workflow

**Files:**

- Modify: `infra/yandex/modules/iam/main.tf`
- Modify: `infra/yandex/modules/iam/variables.tf`
- Modify: `infra/yandex/modules/iam/outputs.tf`
- Modify: `infra/yandex/bootstrap/main.tf`
- Modify: `infra/yandex/bootstrap/variables.tf`
- Modify: `infra/yandex/bootstrap/outputs.tf`
- Modify: `infra/yandex/bootstrap/terraform.tfvars.example`
- Modify: `infra/yandex/production/main.tf`
- Modify: `infra/yandex/production/variables.tf`
- Modify: `infra/yandex/production/outputs.tf`
- Modify: `infra/yandex/production/terraform.tfvars.example`
- Modify: `.github/workflows/yandex-infrastructure.yml`
- Modify: `infra/yandex/scripts/validate-workload-identities.mjs`
- Modify: `infra/yandex/scripts/verify-service-account-provenance.mjs`
- Modify: `infra/yandex/test/workload-identities.test.mjs`
- Modify: `infra/yandex/test/service-account-provenance.test.mjs`
- Modify: `infra/yandex/test/integration-contract.test.mjs`
- Modify: `infra/yandex/test/infra-contract.test.mjs`
- Delete: `deploy/yandex/runner-control.mjs`
- Delete: `deploy/yandex/test/runner-control.test.mjs`

**Interfaces:**

- Active identities: exact four-key map `{ app, audit, controller, terraform }` with distinct nonblank IDs and expected names.
- OIDC subjects: exact `production-deploy` for the deployment controller and `production-infrastructure` for Terraform.
- Terraform input: `TF_VAR_app_deploy_ssh_public_key=${{ vars.YC_APP_DEPLOY_SSH_PUBLIC_KEY }}` in both protected plan and apply jobs.
- Tombstone: `yandex_lockbox_secret.runner_registration` remains `prevent_destroy`, but is absent from active production inputs, outputs used by automation, audit scope and IAM readers.

- [ ] **Step 1: Rewrite identity/provenance and integration tests first**

Change canonical role fixtures to:

```js
const identities = Object.freeze({
  app: "sa-app",
  audit: "sa-audit",
  controller: "sa-controller",
  terraform: "sa-terraform",
});
```

Assert no runner service account, runner registration payload reader, controller/cleanup federated credential or runner compute grant exists. Assert one exact deploy credential, controller registry `lockbox.payloadViewer`, controller app `compute.viewer`, ALB/PostgreSQL read access and four-way provenance. Assert the infrastructure workflow passes the public key in plan and apply and no runner variables.

Add mutations for a reintroduced runner identity, `production-controller`, `production-cleanup`, an extra OIDC subject, controller access to runtime/state secrets, Terraform receipt of the private key, and active use of the tombstone secret.

- [ ] **Step 2: Run identity and integration tests and capture RED**

Run:

```bash
node --test infra/yandex/test/workload-identities.test.mjs infra/yandex/test/service-account-provenance.test.mjs infra/yandex/test/integration-contract.test.mjs
```

Expected: FAIL against the current five-identity, three-environment runner graph.

- [ ] **Step 3: Reduce IAM to four identities and two OIDC subjects**

Delete `yandex_iam_service_account.runner`, runner roles and both old deployment credentials. Rename the environment variable to `github_deploy_environment` and create one federated credential with external subject `repo:<immutable-owner/repo>:environment:production-deploy`. Keep the deployment-controller service account and grant it the registry payload only; retain app discovery/serial, ALB and PostgreSQL read permissions needed by Tasks 1-3.

Change Terraform service-account user/viewer maps and provenance validation to the exact four identities. Keep primitive `editor`/`admin` absent from deployment identities.

- [ ] **Step 4: Retain the empty bootstrap tombstone without active access**

Leave `yandex_lockbox_secret.runner_registration` and its `prevent_destroy = true` lifecycle in bootstrap. Remove its IAM module input, payload viewer, active audit-scope input and GitHub/runbook variable. Keep a clearly named sensitive bootstrap output only for operator tombstone inventory, with text stating that it must remain empty and unused.

- [ ] **Step 5: Rewire production and infrastructure workflow**

Remove production runner service-account/registration variables, compute arguments, output and five-way distinctness check. Add validated `app_deploy_ssh_public_key` and pass it to compute. Update the infrastructure workflow plan/apply environments to pass `YC_APP_DEPLOY_SSH_PUBLIC_KEY`, and ensure no command echoes it or includes the private-key secret.

- [ ] **Step 6: Remove the old runner controller implementation**

Delete `runner-control.mjs` and its tests after Tasks 1-3 have absorbed app gating, host-key parsing and hosted deployment coverage. Search all tracked production/runtime files and require zero references to `runner-control`, JIT config, self-hosted labels or runner registration.

- [ ] **Step 7: Run identity, integration and full infrastructure contracts GREEN**

Run:

```bash
PATH=/Users/thevladbog/terraform:$PATH node --test infra/yandex/test/workload-identities.test.mjs infra/yandex/test/service-account-provenance.test.mjs infra/yandex/test/integration-contract.test.mjs infra/yandex/test/infra-contract.test.mjs
```

Expected: PASS except only an explicitly reported disposable-S3 sandbox skip, if the local loopback sandbox blocks it.

- [ ] **Step 8: Commit IAM and production wiring**

```bash
git add infra/yandex .github/workflows/yandex-infrastructure.yml deploy/yandex/runner-control.mjs deploy/yandex/test/runner-control.test.mjs
git commit -m "refactor(infra): remove active deployment runner graph"
```

### Task 6: Remove Runner Monitoring and Keep Fifteen Exact Alerts

**Files:**

- Modify: `infra/yandex/modules/observability/main.tf`
- Modify: `infra/yandex/modules/observability/variables.tf`
- Modify: `infra/yandex/modules/observability/outputs.tf`
- Modify: `infra/yandex/scripts/extract-alert-specs.mjs`
- Modify: `infra/yandex/test/alert-specs-artifact.test.mjs`
- Modify: `infra/yandex/test/infra-contract.test.mjs`
- Modify: `infra/yandex/production/variables.tf`
- Modify: `infra/yandex/production/terraform.tfvars.example`

**Interfaces:**

- Alert categories: exact 15-category set containing the existing categories except `runner_overrun`.
- VM selectors: `vm_cpu`, `vm_memory` and `vm_disk` target only `var.app_instance_id`.
- Deployment failure producer: `github-hosted:remote-deploy.mjs` with the existing app resource ID and missing-data behavior.

- [ ] **Step 1: Change alert artifact fixtures and mutations first**

Remove `runner_overrun` from the complete artifact fixture and assert an extra runner category is rejected. Change exact category count assertions from 16 to 15. Add mutations that reintroduce `runner_instance_id`, `app|runner` selectors or a runner telemetry producer.

- [ ] **Step 2: Run alert and observability contracts and capture RED**

Run:

```bash
node --test infra/yandex/test/alert-specs-artifact.test.mjs --test-name-pattern='alert|Terraform'
PATH=/Users/thevladbog/terraform:$PATH node --test --test-name-pattern='observability|runtime foundation' infra/yandex/test/infra-contract.test.mjs
```

Expected: FAIL because current Terraform and extraction require 16 categories and a runner instance.

- [ ] **Step 3: Remove the runner category and app-plus-runner selectors**

Delete the `runner_instance_id` variable and `runner_overrun` object. Change VM queries to one exact app resource ID and producer labels to app-only Unified Agent. Change deployment-failure producer text to `github-hosted:remote-deploy.mjs` without altering thresholds or notification wiring.

- [ ] **Step 4: Update exact 15-category validation everywhere**

Remove `runner_overrun` from production `alert_ids`, `terraform.tfvars.example`, extractor `CATEGORIES` and all completeness/uniqueness counts. Preserve strict rejection of missing, extra, duplicate, blank, sensitive or unscoped alert data.

- [ ] **Step 5: Run alert, observability and extractor tests GREEN**

Run:

```bash
node --test infra/yandex/test/alert-specs-artifact.test.mjs
PATH=/Users/thevladbog/terraform:$PATH node --test --test-name-pattern='observability|runtime foundation' infra/yandex/test/infra-contract.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit monitoring simplification**

```bash
git add infra/yandex/modules/observability infra/yandex/scripts/extract-alert-specs.mjs infra/yandex/test/alert-specs-artifact.test.mjs infra/yandex/test/infra-contract.test.mjs infra/yandex/production/variables.tf infra/yandex/production/terraform.tfvars.example
git commit -m "refactor(observability): remove runner-only monitoring"
```

### Task 7: Rewrite Operator Runbooks for the Simple MVP Path

**Files:**

- Modify: `docs/runbooks/saas-production-deploy.md`
- Modify: `docs/runbooks/yandex-bootstrap.md`
- Modify: `docs/runbooks/yandex-first-go-live.md`
- Modify: `docs/runbooks/yandex-infrastructure-apply.md`
- Modify: `docs/runbooks/yandex-recovery.md`
- Modify: `docs/runbooks/yandex-secrets.md`
- Modify: `infra/yandex/README.md`
- Modify: `infra/yandex/test/runbook-contract.test.mjs`
- Modify: `deploy/production/test/runbook-contract.test.mjs`

**Interfaces:**

- Operator secrets/variables: public key in `production-infrastructure`, private key in `production-deploy`, exact fingerprint checked locally without printing private material.
- Rollout: protected plan/apply with DNS false, hosted first rehearsal, hosted finalized first deploy, pre-DNS smoke, then existing DNS convergence/post-DNS smoke.
- Recovery: same offline key copy and pinned authenticated host keys; no OS Login/JIT fallback.

- [ ] **Step 1: Replace stale runbook assertions with hosted rollout assertions**

Require exact key-generation commands under a subshell so `set -euo pipefail` cannot close the user's interactive shell:

```bash
zsh -f
umask 077
ssh-keygen -t ed25519 -a 100 -f ./markiro-production-deploy -C markiro-production-deploy
```

Require `ssh-keygen -lf` fingerprint comparison, environment names, key rotation order, expected Terraform transition, manual deploy inputs, rehearsal/finalized evidence relationship, runner-alert retirement and DNS-false ordering. Add mutations rejecting plaintext key output, `set -euo pipefail` in the parent interactive shell, `ssh-keyscan`, OS Login, automatic deployment and DNS-before-smoke.

- [ ] **Step 2: Run both runbook suites and capture RED**

Run:

```bash
node --test infra/yandex/test/runbook-contract.test.mjs deploy/production/test/runbook-contract.test.mjs
```

Expected: FAIL because current docs require controller/cleanup environments, self-hosted runner and cleanup receipts.

- [ ] **Step 3: Rewrite bootstrap, secret and infrastructure instructions**

Document the exact protected values, fingerprint check, offline recovery copy and rotation. State that the runner-registration Lockbox secret must have no current version/payload and no reader. Document expected plan actions: create app address, replace app VM, update app SG/IAM, delete runner VM/SG/SA/grants and update 15-alert wiring. Explicitly block any PostgreSQL, Object Storage, KMS, ALB, certificate, DNS zone or audit storage replacement/deletion.

- [ ] **Step 4: Rewrite deploy, first-go-live and recovery instructions**

Describe one manual `production-deploy` approval and the exact two first-release dispatches. Remove automatic `workflow_run`, controller/cleanup, runner registration and cleanup receipt language. Keep public DNS false until finalized first deployment and pre-DNS smoke succeed, then continue the existing DNS apply/convergence/post-DNS smoke. Document direct recovery with the offline key and authenticated host-key context only.

- [ ] **Step 5: Run runbook suites and formatting GREEN**

Run:

```bash
node --test infra/yandex/test/runbook-contract.test.mjs deploy/production/test/runbook-contract.test.mjs
pnpm exec prettier --check docs/runbooks infra/yandex/README.md
```

Expected: PASS.

- [ ] **Step 6: Commit the operator contract**

```bash
git add docs/runbooks infra/yandex/README.md infra/yandex/test/runbook-contract.test.mjs deploy/production/test/runbook-contract.test.mjs
git commit -m "docs(deploy): document simple MVP rollout"
```

### Task 8: Run Full Acceptance and Prepare the Protected Rollout

**Files:**

- Modify if required by verified regressions only: files already listed in Tasks 1-7
- Create: `.superpowers/sdd/2026-08-09-yandex-simple-mvp-deploy/task-8-report.md` (ignored verification report)

**Interfaces:**

- Produces: one reviewable PR with no cloud mutation, plus an exact post-merge operator checklist.
- External gates after merge: protected key configuration, Terraform plan/apply, app bootstrap/SSH verification, release publication, first rehearsal, first finalization and DNS convergence.

- [ ] **Step 1: Run all focused Node contract suites from a clean working tree**

```bash
node --test deploy/yandex/test/hosted-deploy-context.test.mjs deploy/yandex/test/hosted-deploy-workflow.test.mjs deploy/yandex/test/remote-deploy.test.mjs
PATH=/Users/thevladbog/terraform:$PATH node --test infra/yandex/test/alert-specs-artifact.test.mjs infra/yandex/test/workload-identities.test.mjs infra/yandex/test/service-account-provenance.test.mjs infra/yandex/test/integration-contract.test.mjs infra/yandex/test/infra-contract.test.mjs infra/yandex/test/runbook-contract.test.mjs
node --test deploy/production/test/runbook-contract.test.mjs
```

Expected: all available tests pass; report a disposable-S3/loopback skip separately rather than treating it as cloud validation.

- [ ] **Step 2: Run repository deployment gates**

```bash
pnpm test:yandex-runtime
PATH=/Users/thevladbog/terraform:$PATH pnpm test:yandex-infra:contract
pnpm test:yandex-runbooks:contract
pnpm test:production-bundle:contract
pnpm format:check
PATH=/Users/thevladbog/terraform:$PATH terraform fmt -recursive -check infra/yandex
git diff --check origin/main...HEAD
```

Expected: all available suites pass. If the known production dependency-graph baseline or a sandbox-only Docker/loopback check fails, record the exact unchanged baseline separately and do not weaken the contract.

- [ ] **Step 3: Attempt pinned-provider validation without substitution**

```bash
markiro_tf_data_dir="$(mktemp -d)"
TF_DATA_DIR="$markiro_tf_data_dir" terraform -chdir=infra/yandex/production init -backend=false -lockfile=readonly
TF_DATA_DIR="$markiro_tf_data_dir" terraform -chdir=infra/yandex/production validate
rm -rf -- "$markiro_tf_data_dir"
```

Expected: PASS when provider 0.215.0 is available. If the reviewed provider mirror/registry is unavailable, record an environment skip and do not change provider version or lockfile.

- [ ] **Step 4: Audit the final diff for scope and secrets**

Run repository leak scanning plus explicit tracked-file searches:

```bash
node infra/yandex/scripts/scan-repository-leaks.mjs
git grep -n 'BEGIN OPENSSH PRIVATE KEY'
git grep -n 'YC_APP_DEPLOY_SSH_PRIVATE_KEY' -- .github docs/runbooks infra/yandex
git grep -n -E 'self-hosted|runner-control|YC_OS_LOGIN|production-controller|production-cleanup|workflow_run' -- .github deploy/yandex infra/yandex docs/runbooks
```

Expected: leak scan and private-key-header search pass with no match; the private-key variable appears only in the protected deploy workflow and secret inventory; obsolete-path search has no active runtime/workflow/runbook match except explicit historical migration notes that are reviewed line by line.

- [ ] **Step 5: Write the ignored acceptance report**

Record exact commit SHA, commands, pass/fail/skip counts, Terraform validation status, deleted/created Terraform addresses, retained-resource invariants, absence of cloud mutations and the post-merge sequence. Do not include tokens, keys, fingerprints, public IPs, secret IDs or raw provider/SSH responses.

- [ ] **Step 6: Commit any final verified corrections and create the PR**

```bash
git status --short
git diff --check
git push -u origin codex/simplify-mvp-deploy
gh pr create --base main --head codex/simplify-mvp-deploy --title "Simplify Yandex MVP deployment" --body-file "$RUNNER_TEMP/markiro-simple-mvp-pr.md"
```

The PR body must list behavior, exact automated checks, provider/environment skips and the explicit statement that no Terraform apply, DNS change or deployment was performed.

- [ ] **Step 7: After merge, execute only the protected rollout gates in order**

1. Generate the Ed25519 pair under `umask 077`, compare fingerprints and store the public/private halves in their exact protected environments without printing them.
2. Dispatch Yandex infrastructure with the merged SHA, `enable_public_dns=false`, PostgreSQL phase `none`, observability `protected`.
3. Review the saved plan and approve only the expected app address/create, app VM/replace, runner-only deletes and scoped IAM/alert updates; reject any retained data/ingress/audit destruction.
4. Apply and verify app bootstrap marker, SSH hardening, exact public/private instance identity and ALB target inventory.
5. Publish images from merged `main`, then manually run `deployment_phase=first`, `rollback_rehearsal=true`.
6. After successful rehearsal, manually run the same release with `deployment_phase=first`, `rollback_rehearsal=false` and the exact rehearsal run ID/attempt.
7. Verify pre-DNS admin and kiosk smoke, then run the existing protected DNS apply, convergence and post-DNS smoke.

Expected: no public DNS is enabled before the finalized first deployment and both authority checks pass.
