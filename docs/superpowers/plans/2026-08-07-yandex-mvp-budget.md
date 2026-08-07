# Yandex Cloud MVP Budget Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the production Terraform configuration fit the approved one-customer MVP profile while retaining private networking, managed data protection, ALB, SWS, and global/per-IP ARL controls.

**Architecture:** Keep the existing production topology and change only two vertical resource sizes plus the WAF layer. Contract tests remain the source of truth: they must require the exact app/PostgreSQL sizes, reject any WAF resource or WAF rule, and continue to prove the ALB-to-SWS-to-ARL chain. Runbooks then describe the same reduced security and capacity profile without changing live cloud state.

**Tech Stack:** Terraform 1.15.8, Yandex Cloud provider 0.215.0, Node.js 24 `node:test`, Markdown, Prettier, pnpm 11.

## Global Constraints

- Application VM: exactly 2 vCPU, 4 GiB RAM, and 100% core fraction.
- Managed PostgreSQL: exactly `s3-c2-m8` with the existing 50 GiB minimum disk and 14-day backup retention.
- Keep the application VM, PostgreSQL host, and deployment runner private.
- Keep ALB, Certificate Manager, DNS, SWS security profile, global/per-IP ARL, NAT, KMS, Lockbox, Audit Trails, private object storage, and existing backup controls.
- Remove only the WAF profile, WAF rule, and WAF outputs; do not add a second Terraform mode.
- Do not change application behavior, Caddy configuration, API throttles, deployment receipts, database schema, or live cloud state.
- Write or update a focused failing contract before each Terraform or runbook behavior change.
- Automated checks do not prove a live `terraform plan`, apply, DNS/TLS, billing, or load result.

---

### Task 1: Lock and apply the reduced compute and PostgreSQL sizes

**Files:**

- Modify: `infra/yandex/test/infra-contract.test.mjs`
- Modify: `infra/yandex/modules/compute/main.tf`
- Modify: `infra/yandex/modules/postgres/main.tf`

**Interfaces:**

- Consumes: existing `terraformResourceBlock()` and `terraformNestedBlocks()` test helpers.
- Produces: exact contract values `app.resources = { cores = 2, memory = 4, core_fraction = 100 }` and `production.config.resources.resource_preset_id = "s3-c2-m8"`.

- [ ] **Step 1: Add exact failing assertions for the MVP resource profile**

In `assertPrivateNetworkAndCompute()`, after the existing private-instance loop, add:

```js
const app = terraformResourceBlock(compute, "yandex_compute_instance", "app");
const appResources = terraformNestedBlocks(app, "resources");
assert.equal(appResources.length, 1, "app VM must define one exact resource profile");
assert.match(
  appResources[0],
  /cores\s*=\s*2[\s\S]*?memory\s*=\s*4[\s\S]*?core_fraction\s*=\s*100/,
  "app VM must use the approved 2 vCPU / 4 GiB MVP profile",
);

const runner = terraformResourceBlock(compute, "yandex_compute_instance", "runner");
const runnerResources = terraformNestedBlocks(runner, "resources");
assert.equal(runnerResources.length, 1, "runner VM must define one exact resource profile");
assert.match(
  runnerResources[0],
  /cores\s*=\s*2[\s\S]*?memory\s*=\s*4[\s\S]*?core_fraction\s*=\s*100/,
  "deployment runner must retain its approved 2 vCPU / 4 GiB profile",
);
```

In `assertProtectedManagedData()`, after the PostgreSQL version assertion, add:

```js
assert.match(
  cluster,
  /resource_preset_id\s*=\s*"s3-c2-m8"/,
  "PostgreSQL must use the approved 2 vCPU / 8 GiB MVP preset",
);
```

Add one mutation to each existing rejection test so later drift is also rejected:

```js
const oversizedApp = await privateNetworkAndComputeSources();
oversizedApp.compute = replaceTerraformResource(
  oversizedApp.compute,
  "yandex_compute_instance",
  "app",
  (block) => block.replace(/cores\s*=\s*2/, "cores = 4"),
);
assert.throws(
  () => assertPrivateNetworkAndCompute(oversizedApp),
  /approved 2 vCPU \/ 4 GiB MVP profile/,
);
```

```js
const oversizedPostgres = await managedDataSources();
oversizedPostgres.postgres = replaceTerraformResource(
  oversizedPostgres.postgres,
  "yandex_mdb_postgresql_cluster",
  "production",
  (block) => block.replace('resource_preset_id = "s3-c2-m8"', 'resource_preset_id = "s2.medium"'),
);
assert.throws(
  () => assertProtectedManagedData(oversizedPostgres),
  /approved 2 vCPU \/ 8 GiB MVP preset/,
);
```

- [ ] **Step 2: Run the focused contracts and verify the old sizing fails**

Run:

```bash
node --test --test-name-pattern='network and compute|managed PostgreSQL|private-compute|managed-data' infra/yandex/test/infra-contract.test.mjs
```

Expected: FAIL because the app still has `cores = 4`, `memory = 8`, and PostgreSQL still uses `s2.medium`.

- [ ] **Step 3: Apply the minimal Terraform sizing change**

Change only the application `resources` block in `infra/yandex/modules/compute/main.tf`:

```hcl
resources {
  cores         = 2
  memory        = 4
  core_fraction = 100
}
```

Change only the PostgreSQL preset in `infra/yandex/modules/postgres/main.tf`:

```hcl
resources {
  resource_preset_id = "s3-c2-m8"
  disk_type_id       = "network-ssd"
  disk_size          = var.database_disk_size_gb
}
```

- [ ] **Step 4: Run the focused contracts and verify they pass**

Run the Step 2 command again.

Expected: PASS for the positive profile assertions and both drift mutations.

- [ ] **Step 5: Commit the capacity profile**

```bash
git add infra/yandex/test/infra-contract.test.mjs infra/yandex/modules/compute/main.tf infra/yandex/modules/postgres/main.tf
git diff --cached --check
git commit -m "fix(infra): right-size Yandex MVP capacity"
```

### Task 2: Remove WAF while preserving SWS and ARL

**Files:**

- Modify: `infra/yandex/test/infra-contract.test.mjs`
- Modify: `infra/yandex/modules/ingress/main.tf`
- Modify: `infra/yandex/modules/ingress/outputs.tf`
- Modify: `infra/yandex/production/outputs.tf`

**Interfaces:**

- Consumes: the existing `yandex_sws_security_profile.markiro`, `yandex_sws_advanced_rate_limiter_profile.markiro`, and ALB `route_options.security_profile_id` chain.
- Produces: no `yandex_sws_waf_profile`, no SWS `security_rule`, and no `waf_profile_id`; `security_profile_id` and `rate_limiter_profile_id` remain unchanged.

- [ ] **Step 1: Rewrite ingress contracts to require the WAF-free boundary**

Remove `yandex_sws_waf_profile` from `productionResourceActionRoles` because it will no longer be a production resource.

Replace the WAF-specific assertions inside `assertProtectedIngress()` with:

```js
assert.doesNotMatch(
  allIngress,
  /resource\s+"yandex_sws_waf_profile"/,
  "the one-customer MVP must not provision a WAF profile",
);
const rules = terraformNestedBlocks(securityProfile, "security_rule");
assert.equal(rules.length, 0, "the MVP SWS profile must delegate only to ARL");
assert.doesNotMatch(securityProfile, /\bwaf\s*\{/);
assert.doesNotMatch(securityProfile, /smart_protection\s*\{/);
assert.doesNotMatch(securityProfile, /analyze_request_body|size_limit/i);
```

Replace `"waf_profile_id"` in the required output list with
`"rate_limiter_profile_id"`, so the list ends with:

```js
"backend_group_id",
"security_profile_id",
"rate_limiter_profile_id",
"approved_a_records",
```

Then add:

```js
for (const outputs of [ingressOutputs, productionOutputs]) {
  assert.doesNotMatch(outputs, /output\s+"waf_profile_id"\s*\{/);
}
```

Replace the obsolete `shadowedWaf` and `noWaf` mutations in the ingress rejection test with:

```js
const reintroducedWafProfile = await protectedIngressSources();
reintroducedWafProfile.ingress +=
  '\nresource "yandex_sws_waf_profile" "markiro" { folder_id = var.folder_id }\n';
assert.throws(
  () => assertProtectedIngress(reintroducedWafProfile),
  /must not provision a WAF profile/,
);

const reintroducedWafRule = await protectedIngressSources();
reintroducedWafRule.ingress = replaceTerraformResource(
  reintroducedWafRule.ingress,
  "yandex_sws_security_profile",
  "markiro",
  (block) =>
    block.replace(
      "\n}",
      '\n  security_rule {\n    name = "waf-api"\n    priority = 100\n    waf { mode = "API" }\n  }\n}',
    ),
);
assert.throws(() => assertProtectedIngress(reintroducedWafRule), /must delegate only to ARL/);
```

- [ ] **Step 2: Run the focused contracts and verify WAF presence fails**

Run:

```bash
node --test --test-name-pattern='least privilege|production ingress' infra/yandex/test/infra-contract.test.mjs
```

Expected: FAIL because the WAF resource, WAF rule, WAF outputs, and resource-action map mismatch still exist.

- [ ] **Step 3: Remove only the WAF Terraform surface**

Delete this complete resource from `infra/yandex/modules/ingress/main.tf`:

```hcl
resource "yandex_sws_waf_profile" "markiro" {
  name      = "markiro-production-waf"
  folder_id = var.folder_id
  labels    = var.labels

  rule_set {
    action     = "DENY"
    is_enabled = true
    priority   = 1

    core_rule_set {
      inbound_anomaly_score = 5
      paranoia_level        = 1

      rule_set {
        name    = "OWASP Core Ruleset"
        type    = "CORE"
        version = "4.0.0"
      }
    }
  }
}
```

Delete the complete `security_rule` named `waf-api` from `yandex_sws_security_profile.markiro`. Keep this core unchanged:

```hcl
resource "yandex_sws_security_profile" "markiro" {
  name                             = "markiro-production"
  folder_id                        = var.folder_id
  default_action                   = "ALLOW"
  advanced_rate_limiter_profile_id = yandex_sws_advanced_rate_limiter_profile.markiro.id
  labels                           = var.labels

  log_options {
    enable       = true
    log_group_id = var.security_log_group_id
  }
}
```

Delete the complete `waf_profile_id` output block from both output files. Do not change the `security_profile_id` or `rate_limiter_profile_id` outputs.

- [ ] **Step 4: Run the focused contracts and verify they pass**

Run the Step 2 command again.

Expected: PASS, including the ALB SWS attachment, both ARL rules, least-privilege resource inventory, and WAF reintroduction mutations.

- [ ] **Step 5: Commit the WAF removal**

```bash
git add infra/yandex/test/infra-contract.test.mjs infra/yandex/modules/ingress/main.tf infra/yandex/modules/ingress/outputs.tf infra/yandex/production/outputs.tf
git diff --cached --check
git commit -m "fix(infra): defer WAF for Yandex MVP"
```

### Task 3: Align operational contracts and documentation

**Files:**

- Modify: `infra/yandex/test/runbook-contract.test.mjs`
- Modify: `deploy/production/test/runbook-contract.test.mjs`
- Modify: `docs/runbooks/yandex-first-go-live.md`
- Modify: `docs/runbooks/saas-production-deploy.md`
- Modify: `infra/yandex/README.md`
- Modify: `docs/architecture.md`

**Interfaces:**

- Consumes: the WAF-free SWS/ARL Terraform contract from Task 2.
- Produces: go-live gate `go-live-gate-04-alb-sws-arl`, accepted rate-limit evidence value `provider-arl`, and an explicit one-customer MVP risk boundary.

- [ ] **Step 1: Change the runbook tests to require provider ARL instead of provider WAF**

In `infra/yandex/test/runbook-contract.test.mjs`, replace the gate name with:

```js
"go-live-gate-04-alb-sws-arl",
```

In `deploy/production/test/runbook-contract.test.mjs`, replace the provider/WAF invariant with:

```js
invariant(
  /provider ARL/i.test(goLive) &&
    /per-source/i.test(goLive) &&
    /global\s+anonymous-route/i.test(goLive),
  "provider ARL rate-limit gate is incomplete",
);
```

- [ ] **Step 2: Run both runbook contract suites and verify the old wording fails**

Run:

```bash
pnpm test:yandex-runbooks:contract
pnpm test:production-bundle:contract
```

Expected: FAIL because the old marker and provider/WAF text remain in the runbooks.

- [ ] **Step 3: Update the first-go-live ingress gate**

Use this marker and requirement in `docs/runbooks/yandex-first-go-live.md`:

```markdown
<!-- runbook-contract:go-live-gate-04-alb-sws-arl -->

4. **Ingress protection before the first application release.** Verify the
   reserved ALB address, HTTPS listener, active Certificate Manager certificate,
   Smart Web Security (SWS) profile, and attached Advanced Rate Limiter (ARL)
   profile use the reviewed hostname and private back-end configuration. Confirm
   both the global and per-IP ARL rules. The one-customer MVP intentionally has
   no WAF profile; any WAF resource in the plan is unexpected. Do **not** require
   a `HEALTHY` back end yet: the first app release has not started the edge
   listener. Keep the app VM private.
```

- [ ] **Step 4: Update the generic production rate-limit gate**

In `docs/runbooks/saas-production-deploy.md`, consistently replace the provider/WAF option with provider ARL. The public DNS choice and shell evidence must become:

```markdown
1. a provider ARL policy with both per-source limits and a global
   anonymous-route limit; or
2. a separately reviewed reproducible custom Caddy image with an exact source
   revision, SBOM, vulnerability scan, and the same per-source/global policy.
```

```bash
read -r -p 'Rate-limit control (provider-arl/reviewed-custom-caddy): ' RATE_LIMIT_CONTROL
case "$RATE_LIMIT_CONTROL" in
  provider-arl|reviewed-custom-caddy) ;;
  *) echo 'STOP: no approved public edge rate-limit control' >&2; exit 1 ;;
esac
```

Also change routine-deploy prose to “approved provider ARL or reviewed custom-Caddy rate limits” and remove the inaccurate claim that this repository requires a provider WAF command.

- [ ] **Step 5: Record the active MVP capacity and WAF deferral**

Add a short `## MVP capacity and edge profile` section to `infra/yandex/README.md` stating:

```markdown
## MVP capacity and edge profile

The initial one-customer production profile uses one private 2 vCPU / 4 GiB
application VM and one private Managed PostgreSQL `s3-c2-m8` host. PostgreSQL
keeps its 50 GiB minimum disk, 14-day backups, KMS encryption, and
`prevent_destroy` boundary.

The public ALB virtual host remains attached to Smart Web Security and its
global/per-IP Advanced Rate Limiter profile. The MVP deliberately omits WAF;
reintroduce it before a second external customer, public self-registration, a
contractual WAF requirement, or observed exploit traffic that ARL does not
contain. See the approved budget specification and first-go-live runbook.

The 15,000–18,000 RUB monthly amount is a planning target, not a Terraform
guarantee. Configure a billing alert and validate the first complete billing
period because traffic, logs, storage, NAT egress, public IP use, and provider
pricing remain variable.

Resize the application VM when CPU stays above 70% or memory stays above 80%
for 15 minutes, or when readiness, restart, or latency alerts identify host
saturation. Resize PostgreSQL through the provider-supported maintenance path
when sustained CPU, memory, connection, query-latency, or storage pressure is
the cause; keep backups and durable-resource protection intact.
```

In the Yandex SaaS status section of `docs/architecture.md`, start the capacity paragraph with:

```markdown
The one-customer MVP has one private 2 vCPU / 4 GiB application VM and one
private Managed PostgreSQL `s3-c2-m8` host. The public ALB remains attached to
SWS and global/per-IP ARL; WAF is deferred only for this one-customer phase. A
host failure or deployment can interrupt service; the design does not claim
high availability or zero downtime.
```

Keep the existing deferred-HA and private-media sentences that follow it unchanged.

- [ ] **Step 6: Run the runbook and formatting checks**

Run:

```bash
pnpm test:yandex-runbooks:contract
pnpm test:production-bundle:contract
corepack pnpm exec prettier --check infra/yandex/test/runbook-contract.test.mjs deploy/production/test/runbook-contract.test.mjs docs/runbooks/yandex-first-go-live.md docs/runbooks/saas-production-deploy.md infra/yandex/README.md docs/architecture.md
```

Expected: all commands PASS.

- [ ] **Step 7: Commit the operational documentation**

```bash
git add infra/yandex/test/runbook-contract.test.mjs deploy/production/test/runbook-contract.test.mjs docs/runbooks/yandex-first-go-live.md docs/runbooks/saas-production-deploy.md infra/yandex/README.md docs/architecture.md
git diff --cached --check
git commit -m "docs(infra): document Yandex MVP edge profile"
```

### Task 4: Run the complete relevant verification and review the final diff

**Files:**

- Verify only; no new implementation file is expected.

**Interfaces:**

- Consumes: Tasks 1–3.
- Produces: reviewable evidence for all repository-level automated gates and explicit external-validation limits.

- [ ] **Step 1: Format and validate Terraform where the pinned CLI/provider are available**

Run:

```bash
terraform fmt -check -recursive infra/yandex
terraform -chdir=infra/yandex/production init -backend=false -input=false
terraform -chdir=infra/yandex/production validate
```

Expected: PASS with Terraform 1.15.8 and provider 0.215.0. If the pinned CLI or provider download is unavailable, do not substitute another version; record this check as not run and rely only on the contract evidence.

- [ ] **Step 2: Run all affected repository contracts**

Run:

```bash
pnpm test:yandex-infra:contract
pnpm test:yandex-runtime
pnpm test:yandex-runbooks:contract
pnpm test:production-bundle:contract
```

Expected: all suites PASS with no skipped tests.

- [ ] **Step 3: Run repository hygiene checks**

Run:

```bash
pnpm format:check
git diff --check origin/main...HEAD
git status --short
```

Expected: formatting and whitespace checks PASS; status contains only the tracked implementation-plan file if it has not yet been committed.

- [ ] **Step 4: Review exact scope and commit the implementation plan if still uncommitted**

Run:

```bash
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- infra/yandex deploy/production/test docs/architecture.md docs/runbooks docs/superpowers
```

Confirm there are no changes to application code, Caddy, database schema, deployment workflows, secrets, live state, or generated Terraform artifacts. Then commit this plan separately if it is still uncommitted:

```bash
git add docs/superpowers/plans/2026-08-07-yandex-mvp-budget.md
git diff --cached --check
git commit -m "docs(infra): add Yandex MVP budget implementation plan"
```

- [ ] **Step 5: Report external checks separately**

The handoff must explicitly list live `terraform plan`, apply, DNS/TLS, provider billing, production metrics, and load validation as not performed unless independent evidence was actually collected. No repository test may be reported as proof of those surfaces.
