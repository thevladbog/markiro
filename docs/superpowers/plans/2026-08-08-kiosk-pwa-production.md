# Kiosk PWA Production Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the existing `@markiro/kiosk` PWA at `https://kiosk.markiro.app` through the current Yandex production edge while preserving the one-VM MVP topology, the admin site at `https://admin.markiro.app`, the existing 16-alert contract, and the public-DNS go-live gate.

**Architecture:** Build admin and kiosk into one immutable edge image, serve them from separate static roots selected by exact Host in Caddy, and expose only `/api/kiosk/*` on the kiosk authority. Add a second managed certificate and gated A record to the existing ALB/SWS/ARL ingress. Thread one validated `MARKIRO_KIOSK_DOMAIN` value through Compose, deployment, smoke, DNS evidence, and Terraform; compare it to the runtime `KIOSK_ORIGIN` without logging either value.

**Tech Stack:** Node.js 24, pnpm 11, Turbo, Vite/PWA, Caddy 2.11.4, Docker Compose, Terraform 1.15.8, Yandex provider 0.215.0, GitHub Actions, `node:test`.

## Global constraints

- Keep the existing application VM, runner VM, ALB, backend group, target group, public IPv4 address, Cloud DNS zone, SWS profile, global/per-IP ARL profile, PostgreSQL cluster, Lockbox secrets, and 16 Monitoring alert IDs.
- Do not add or change a Tauri shell. This plan covers only the browser-installable `apps/kiosk` PWA.
- Keep `yandex_cm_certificate.markiro` at its existing Terraform address. Add a separate kiosk certificate instead of replacing the admin certificate.
- Keep both application A records behind the same `public_dns_enabled` gate; certificate validation records remain independently available.
- Preserve the admin route table. The kiosk authority may proxy only `/api/kiosk/*` after stripping `/api`.
- Do not print `KIOSK_ORIGIN`, runtime environment contents, tokens, or Lockbox payloads in tests, errors, workflow logs, receipts, or summaries.
- Production domains must be distinct lowercase FQDNs. The direct local bundle may use the explicit test-only values `localhost` and `kiosk.localhost`.
- Write a focused failing contract before every behavior change and commit each coherent layer separately.
- Automated checks do not prove live certificate issuance, DNS convergence, physical PWA installation, scanner behavior, offline recovery, Windows, or Tauri signing.

---

### Task 1: Add a fail-closed dual-domain and runtime-origin boundary

**Files:**

- Modify: `deploy/production/production-domain.mjs`
- Modify: `deploy/production/preflight.mjs`
- Modify: `deploy/production/test/preflight.test.mjs`
- Modify: `deploy/production/test/cli-main.test.mjs`
- Modify: `deploy/production/test/compose-contract.test.mjs`
- Modify: `compose.production.yml`

**Interfaces:**

- Input: `MARKIRO_DOMAIN`, `MARKIRO_KIOSK_DOMAIN`, optional direct-mode `MARKIRO_HTTPS_PORT`, and the mode-`0600` runtime env file.
- Output: `{ domain, kioskDomain, ... }` from `runPreflight()` and both domain variables in the quiet Compose child environment.
- Failure messages: stable variable names only; no rejected value or env-file content.

- [ ] **Step 1: Add failing dual-domain validator tests**

Extend `deploy/production/test/preflight.test.mjs` so the valid fixture contains:

```js
const release = {
  MARKIRO_IMAGE_TAG: "0123456789abcdef0123456789abcdef01234567",
  MARKIRO_API_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
  MARKIRO_EDGE_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
  MARKIRO_DOMAIN: "app.markiro.example",
  MARKIRO_KIOSK_DOMAIN: "kiosk.markiro.example",
  ACME_EMAIL: "ops@example.test",
};
```

Update the injected dependencies to provide both file mode and sanitized text:

```js
function dependencies({
  mode = 0o600,
  envText = "KIOSK_ORIGIN=https://kiosk.markiro.example\n",
  composeError,
} = {}) {
  return {
    mode: async () => mode,
    readText: async () => envText,
    composeQuiet: async () => {
      if (composeError) throw composeError;
    },
  };
}
```

Assert that preflight:

- returns `kioskDomain`;
- passes `MARKIRO_KIOSK_DOMAIN` to Compose;
- rejects a missing kiosk domain, a scheme, path, port, uppercase label, or single-label production name with `MARKIRO_KIOSK_DOMAIN is invalid`;
- rejects equal admin and kiosk domains with `production domains must be distinct`;
- accepts only the explicit local pair `localhost` and `kiosk.localhost` in direct test mode;
- rejects missing, duplicate, empty, mismatched, path-bearing, or production port-bearing `KIOSK_ORIGIN` with `KIOSK_ORIGIN does not match MARKIRO_KIOSK_DOMAIN`;
- accepts `KIOSK_ORIGIN=https://kiosk.localhost:18443` only when direct mode declares `MARKIRO_HTTPS_PORT=18443`;
- never includes any supplied origin or domain in an error.

Update the JSDoc interface assertion to require `MARKIRO_KIOSK_DOMAIN` and `kioskDomain`.

- [ ] **Step 2: Run the focused tests and observe the missing boundary**

Run:

```bash
node --test deploy/production/test/preflight.test.mjs deploy/production/test/cli-main.test.mjs
```

Expected: FAIL because `runPreflight()` neither validates the kiosk domain nor reads and compares `KIOSK_ORIGIN`.

- [ ] **Step 3: Implement named domain validation and sanitized origin parsing**

In `deploy/production/production-domain.mjs`:

- require at least one dot for production FQDNs;
- retain only the exact `localhost` test exception;
- change `validateProductionDomain(value, variable = "MARKIRO_DOMAIN")` to produce `${variable} is invalid`;
- add `validateProductionDomains(domain, kioskDomain)` that validates both names and rejects equality.

In `deploy/production/preflight.mjs`:

- import `readFile` with `stat`;
- add `MARKIRO_KIOSK_DOMAIN` to `PreflightEnvironment`, `kioskDomain` to `PreflightResult`, and the child Compose environment;
- inject `readText(path)` beside `mode(path)` for deterministic tests;
- parse only exact, non-comment lines beginning with `KIOSK_ORIGIN=` and reject zero or multiple entries;
- calculate the expected origin as `https://${kioskDomain}` in ALB mode and `https://${kioskDomain}:${MARKIRO_HTTPS_PORT}` only for a non-443 direct test port;
- compare with strict string equality and throw only `KIOSK_ORIGIN does not match MARKIRO_KIOSK_DOMAIN`;
- read the env file only after its `0600` mode passes and before Compose validation.

Do not reuse the runtime Lockbox renderer: preflight reads the already materialized env file and must not fetch or render secrets.

- [ ] **Step 4: Require the kiosk domain in Compose**

Add this exact edge environment entry to `compose.production.yml`:

```yaml
MARKIRO_KIOSK_DOMAIN: ${MARKIRO_KIOSK_DOMAIN:?MARKIRO_KIOSK_DOMAIN is required}
```

Update `deploy/production/test/compose-contract.test.mjs` to pass `MARKIRO_KIOSK_DOMAIN: "kiosk.localhost"` in every render fixture and assert the exact required interpolation in the edge service.

- [ ] **Step 5: Re-run the focused boundary contracts**

Run:

```bash
node --test deploy/production/test/preflight.test.mjs deploy/production/test/cli-main.test.mjs deploy/production/test/compose-contract.test.mjs
```

Expected: PASS, with origin mismatch errors containing variable names only.

- [ ] **Step 6: Commit the configuration boundary**

```bash
git add deploy/production/production-domain.mjs deploy/production/preflight.mjs deploy/production/test/preflight.test.mjs deploy/production/test/cli-main.test.mjs deploy/production/test/compose-contract.test.mjs compose.production.yml
git diff --cached --check
git commit -m "feat(deploy): validate kiosk production origin"
```

---

### Task 2: Build both frontends and isolate them by exact Host

**Files:**

- Modify: `.dockerignore`
- Modify: `deploy/production/edge.Dockerfile`
- Modify: `deploy/production/Caddyfile`
- Modify: `deploy/production/Caddyfile.alb`
- Modify: `deploy/production/test/edge-contract.test.mjs`
- Modify: `deploy/production/test/compose-contract.test.mjs`

**Interfaces:**

- Image paths: `/srv/admin` and `/srv/kiosk`.
- Admin authority: full existing admin/API route table.
- Kiosk authority: kiosk PWA plus only `/api/kiosk/* -> /kiosk/*`.

- [ ] **Step 1: Add failing immutable-image assertions**

In `deploy/production/test/edge-contract.test.mjs`, require the Dockerfile to:

- copy `apps/kiosk/package.json` before install;
- copy `apps/kiosk` source after install;
- run `pnpm turbo build --filter @markiro/admin... --filter @markiro/kiosk...`;
- copy admin output to `/srv/admin` and kiosk output to `/srv/kiosk`;
- retain the Caddy-only non-root runtime and contain no Node/pnpm/source tree;
- fail if either build output is absent;
- include kiosk sources in `.dockerignore` allowlists where the file uses negated inclusions.

Add mutation tests that reject a missing kiosk build, a shared `/srv` root, or an image that copies only one frontend.

- [ ] **Step 2: Add failing exact-host Caddy contracts**

For both Caddy variants, parse adapted JSON as the existing tests already do and assert:

- exactly two approved Host matchers: admin and kiosk;
- `/srv/admin` is reachable only from `MARKIRO_DOMAIN`;
- `/srv/kiosk` is reachable only from `MARKIRO_KIOSK_DOMAIN`;
- both authorities emit the release SHA and the existing security/cache headers;
- kiosk has one proxy matcher, `/api/kiosk/*`, with a rewrite that strips exactly `/api`;
- kiosk has no matcher for `/api/auth/*`, `/1c_exchange`, `/station/*`, `/health/*`, `/openapi.json`, or `/docs*`;
- unknown mutation paths and unsupported methods end at a plain `404`;
- direct and ALB admin route tables remain equivalent except for TLS/upstream forwarded-proto details.

Add negative mutations for swapped roots, wildcard hosts, a generic `/api/*` kiosk proxy, missing prefix rewrite, and kiosk fallback on POST.

- [ ] **Step 3: Run the edge contracts and observe the single-site failure**

Run:

```bash
node --test deploy/production/test/edge-contract.test.mjs deploy/production/test/compose-contract.test.mjs
```

Expected: FAIL because the edge image and both Caddy files currently contain only the admin site.

- [ ] **Step 4: Build admin and kiosk into separate runtime roots**

Change the build stage in `deploy/production/edge.Dockerfile` to include the kiosk workspace manifest and source, then use one Turbo command for both dependency graphs:

```dockerfile
COPY apps/admin/package.json ./apps/admin/package.json
COPY apps/kiosk/package.json ./apps/kiosk/package.json
# existing package manifests
RUN pnpm install --frozen-lockfile
COPY apps/admin ./apps/admin
COPY apps/kiosk ./apps/kiosk
# existing package sources
RUN pnpm turbo build --filter @markiro/admin... --filter @markiro/kiosk...
```

Copy immutable outputs explicitly:

```dockerfile
COPY --from=build /workspace/apps/admin/dist /srv/admin
COPY --from=build /workspace/apps/kiosk/dist /srv/kiosk
```

Keep the current runtime user, removed Caddy capability, read-only container, and ownership of `/srv`, `/data`, and `/config`.

- [ ] **Step 5: Implement exact admin and kiosk site handlers**

Refactor each Caddy file around reusable imports for common headers, admin routing, and kiosk routing. The effective kiosk route must be equivalent to:

```caddyfile
@kioskApi path /api/kiosk/*
handle @kioskApi {
  uri strip_prefix /api
  reverse_proxy api:3000 {
    import standard_api_transport
  }
}

@kioskAssets path /assets/*
handle @kioskAssets {
  root * /srv/kiosk
  header Cache-Control "public, max-age=31536000, immutable"
  file_server
}

@kioskSpa method GET HEAD
handle @kioskSpa {
  root * /srv/kiosk
  header Cache-Control "no-cache"
  try_files {path} /index.html
  file_server
}

respond 404
```

In the ALB variant, add the existing `X-Forwarded-Proto https` upstream header to the kiosk proxy. Keep admin handlers semantically unchanged and point their static root to `/srv/admin`.

- [ ] **Step 6: Verify both production builds and edge contracts**

Run:

```bash
pnpm --filter @markiro/admin build
pnpm --filter @markiro/kiosk build
node --test deploy/production/test/edge-contract.test.mjs deploy/production/test/compose-contract.test.mjs
```

Expected: both Vite builds PASS; both Caddy modes adapt; all host and route mutations are rejected.

- [ ] **Step 7: Commit the dual-site edge**

```bash
git add .dockerignore deploy/production/edge.Dockerfile deploy/production/Caddyfile deploy/production/Caddyfile.alb deploy/production/test/edge-contract.test.mjs deploy/production/test/compose-contract.test.mjs
git diff --cached --check
git commit -m "feat(deploy): serve admin and kiosk from one edge"
```

---

### Task 3: Smoke both authorities before and after deployment

**Files:**

- Modify: `deploy/production/smoke.mjs`
- Modify: `deploy/production/test/smoke-route-table.test.mjs`
- Modify: `deploy/production/deploy.mjs`
- Modify: `deploy/production/test/deploy.test.mjs`
- Modify: `deploy/production/test/staged-deploy.test.mjs`
- Modify: `deploy/yandex/remote-deploy.mjs`
- Modify: `deploy/yandex/test/remote-deploy.test.mjs`

**Interfaces:**

- `productionBaseUrls(environment) -> { admin, kiosk }`.
- `runPublicSmoke({ adminBaseUrl, kioskBaseUrl, expectedReleaseSha })` verifies one atomic release across both authorities.
- First deployment uses the reserved ALB IP and both Host/SNI names without public DNS.

- [ ] **Step 1: Add a failing kiosk smoke route table**

In `deploy/production/test/smoke-route-table.test.mjs`, introduce an immutable `KIOSK_ROUTE_CHECKS` contract containing:

```js
[
  ["GET", "/", "kiosk-shell"],
  ["GET", "/assets/${assetName}", "asset"],
  ["GET", "/manifest.webmanifest", "manifest"],
  ["GET", "/sw.js", "service-worker"],
  ["GET", "/api/kiosk/bootstrap", "kiosk-proxy"],
  ["GET", "/api/auth/get-session", "not-found"],
  ["GET", "/station/bootstrap", "not-found"],
  ["GET", "/docs", "not-found"],
  ["POST", "/unknown", "not-found"],
];
```

Derive the actual service-worker filename from `manifest.webmanifest` or the generated registration asset instead of assuming a Vite-PWA filename when the build proves a different stable name. Assert that the kiosk shell differs from the admin shell, contains no external runtime origins, and carries the same expected release SHA.

Test direct local URLs as `https://localhost:18443` and `https://kiosk.localhost:18443`, and ALB URLs without a port.

- [ ] **Step 2: Add failing two-authority deployment tests**

Extend `deploy/yandex/test/remote-deploy.test.mjs` so:

- the sanitized remote environment contains `MARKIRO_KIOSK_DOMAIN=kiosk.markiro.example`;
- first-deploy probes issue `curl --resolve` for both admin and kiosk authorities against the same reserved ALB IPv4 address;
- both probes require the exact `X-Markiro-Release-Sha`;
- the kiosk probe checks `/`, `/manifest.webmanifest`, the service worker, and `/api/kiosk/*` while rejecting admin-only paths;
- regular external smoke calls both public authorities before finalize;
- failure of either authority causes rollback and never finalizes the candidate.

- [ ] **Step 3: Run the focused smoke and remote-deploy tests**

Run:

```bash
node --test deploy/production/test/smoke-route-table.test.mjs deploy/production/test/deploy.test.mjs deploy/production/test/staged-deploy.test.mjs deploy/yandex/test/remote-deploy.test.mjs
```

Expected: FAIL because URL construction, route checks, and remote probes are admin-only.

- [ ] **Step 4: Implement dual-host public smoke**

In `deploy/production/smoke.mjs`:

- replace the one-domain CLI construction with `productionBaseUrls(process.env)`;
- keep the current admin assertions unchanged;
- add a kiosk-specific shell signature that proves the kiosk build rather than merely accepting HTML;
- validate the manifest as same-origin, root-scoped, and installable;
- fetch the generated service worker and assert that API paths are absent from navigation fallback/runtime-cache behavior using the build's existing PWA contract;
- run both authority checks before any runtime shutdown/isolation checks;
- require the same `expectedReleaseSha` header on both roots.

Keep network requests bounded by the existing request timeouts.

- [ ] **Step 5: Thread the kiosk domain through staged and Yandex deployment**

In `deploy/yandex/remote-deploy.mjs`:

- validate both domains with the shared validator;
- include `MARKIRO_KIOSK_DOMAIN` in the exact remote environment;
- pass it to preflight and Compose;
- generate first-deployment ALB probes for both SNI names with the same resolved address;
- call dual-host external smoke for regular deployment;
- retain the exact phase order: transfer, runtime refresh, prepare, ALB health, both-authority smoke, finalize.

Update the local staged deployment tests and implementation anywhere an exact environment object is asserted.

- [ ] **Step 6: Re-run the focused checks**

Run the Step 3 command again.

Expected: PASS; a mutation that breaks either authority blocks finalize.

- [ ] **Step 7: Commit dual-host deployment smoke**

```bash
git add deploy/production/smoke.mjs deploy/production/test/smoke-route-table.test.mjs deploy/production/deploy.mjs deploy/production/test/deploy.test.mjs deploy/production/test/staged-deploy.test.mjs deploy/yandex/remote-deploy.mjs deploy/yandex/test/remote-deploy.test.mjs
git diff --cached --check
git commit -m "feat(deploy): smoke admin and kiosk authorities"
```

---

### Task 4: Add the kiosk certificate and gated DNS record to the existing ingress

**Files:**

- Modify: `infra/yandex/test/infra-contract.test.mjs`
- Modify: `infra/yandex/modules/ingress/variables.tf`
- Modify: `infra/yandex/modules/ingress/main.tf`
- Modify: `infra/yandex/modules/ingress/outputs.tf`
- Modify: `infra/yandex/production/variables.tf`
- Modify: `infra/yandex/production/main.tf`
- Modify: `infra/yandex/production/outputs.tf`
- Modify: `infra/yandex/production/terraform.tfvars.example`

**Interfaces:**

- New Terraform input: `kiosk_domain`.
- New outputs: `kiosk_certificate_id`, `kiosk_certificate_status`, `admin_domain`, `kiosk_domain`.
- Existing outputs and resource addresses remain stable.

- [ ] **Step 1: Add failing ingress topology assertions**

Extend `assertProtectedIngress()` in `infra/yandex/test/infra-contract.test.mjs` to require:

- `var.kiosk_domain` has the same lowercase-FQDN validation as `var.domain` and a cross-variable precondition that they differ;
- existing `yandex_cm_certificate.markiro` still owns only `var.domain`;
- new `yandex_cm_certificate.kiosk` owns only `var.kiosk_domain`;
- each certificate has its own `count = 1` DNS challenge record and issued data source with `wait_validation = true`;
- the existing HTTPS default handler contains the admin issued certificate and
  its kiosk SNI handler contains the kiosk issued certificate with the same HTTP
  router;
- the existing virtual host authority is exactly `[var.domain, var.kiosk_domain]`;
- the existing backend group, SWS profile, ARL profile, ALB, address, target group, and health check remain singular;
- `yandex_dns_recordset.application` and `yandex_dns_recordset.kiosk_application` each use the same `var.public_dns_enabled ? 1 : 0` gate and the same reserved address;
- approved A-record output remains a one-address set, while both hostname outputs are exact.

Add rejection mutations for equal domains, a combined replacement certificate, an ungated kiosk A record, a second ALB/backend/address, a wildcard authority, or omission of either issued certificate.

- [ ] **Step 2: Run the focused ingress contract**

Run:

```bash
node --test --test-name-pattern='protected ingress|ingress mutations|production root wires' infra/yandex/test/infra-contract.test.mjs
```

Expected: FAIL because the current ingress accepts one domain and one certificate.

- [ ] **Step 3: Add the root and module variables**

Add `kiosk_domain` beside `domain` in both variable files. Use the same regex and add a validation/precondition that fails when `var.kiosk_domain == var.domain`. Wire it through `module "ingress"` and add this non-secret example value:

```hcl
domain       = "admin.markiro.example.ru"
kiosk_domain = "kiosk.markiro.example.ru"
```

- [ ] **Step 4: Add a separate certificate without moving the admin resource**

Keep these existing addresses unchanged:

```hcl
yandex_cm_certificate.markiro
yandex_dns_recordset.certificate_validation
data.yandex_cm_certificate.issued
```

Add parallel `.kiosk`, `.kiosk_certificate_validation`, and `.kiosk_issued` blocks. Configure the HTTPS listener TLS block as:

```hcl
default_handler {
  certificate_ids = [data.yandex_cm_certificate.issued.id]

  http_handler {
    http_router_id = yandex_alb_http_router.markiro.id
  }
}

sni_handler {
  name         = "kiosk"
  server_names = [var.kiosk_domain]

  handler {
    certificate_ids = [data.yandex_cm_certificate.kiosk_issued.id]

    http_handler {
      http_router_id = yandex_alb_http_router.markiro.id
    }
  }
}
```

Change only the existing virtual host authority and add the second gated application record. Do not duplicate the virtual host or security chain.

- [ ] **Step 5: Expose both identities and statuses**

Add module and root outputs for:

```text
certificate_id
certificate_status
kiosk_certificate_id
kiosk_certificate_status
admin_domain
kiosk_domain
```

Preserve existing output names so automation consuming the admin certificate does not break.

- [ ] **Step 6: Format and verify Terraform contracts**

Run:

```bash
terraform -chdir=infra/yandex/production fmt -recursive -check
node --test --test-name-pattern='protected ingress|ingress mutations|production root wires' infra/yandex/test/infra-contract.test.mjs
```

Then, when provider access is available:

```bash
terraform -chdir=infra/yandex/production init -backend=false -lockfile=readonly
terraform -chdir=infra/yandex/production validate
```

Expected: formatting/contracts PASS; provider validation PASS when the pinned provider is locally available. Report a provider-access skip separately.

- [ ] **Step 7: Commit the ingress extension**

```bash
git add infra/yandex/test/infra-contract.test.mjs infra/yandex/modules/ingress/variables.tf infra/yandex/modules/ingress/main.tf infra/yandex/modules/ingress/outputs.tf infra/yandex/production/variables.tf infra/yandex/production/main.tf infra/yandex/production/outputs.tf infra/yandex/production/terraform.tfvars.example
git diff --cached --check
git commit -m "feat(infra): add kiosk hostname to protected ingress"
```

---

### Task 5: Monitor the earliest-expiring certificate without adding an alert

**Files:**

- Modify: `infra/yandex/modules/observability/variables.tf`
- Modify: `infra/yandex/modules/observability/main.tf`
- Modify: `infra/yandex/production/main.tf`
- Modify: `infra/yandex/test/infra-contract.test.mjs`
- Modify: `infra/yandex/test/alert-specs-artifact.test.mjs`

**Interfaces:**

- Replace scalar `certificate_id` with an exact two-ID input or two named inputs.
- Keep alert category `certificate_risk`, the existing alert ID map, thresholds, window, and total category count.

- [ ] **Step 1: Add failing two-certificate observability contracts**

Require the `certificate_risk` query and dashboard widget to use the equivalent of:

```hcl
series_min("certificate.days_until_expiration"{folderId="${var.folder_id}", service="certificate-manager", certificate="${var.certificate_ids[0]}|${var.certificate_ids[1]}"})
```

Prefer a typed `set(string)` input only if the emitted selector order is made deterministic with `sort(tolist(var.certificate_ids))`; otherwise use `list(string)` with validation for exactly two distinct, nonblank IDs. Assert:

- exact `series_min(...)` wrapping;
- exact two-certificate selector;
- 16 alert categories, not 17;
- unchanged `certificate_risk` thresholds `30`/`14`, comparison, window, and notification channel;
- dashboard query equals alert-spec query;
- the protected artifact exposes the reviewed exact query.

Add rejection mutations for one ID, duplicate IDs, `series_max`, an unwrapped selector, and a new kiosk-only alert.

- [ ] **Step 2: Run the focused observability contracts**

Run:

```bash
node --test --test-name-pattern='observability|alert spec|certificate' infra/yandex/test/infra-contract.test.mjs infra/yandex/test/alert-specs-artifact.test.mjs
```

Expected: FAIL because observability currently accepts one certificate ID.

- [ ] **Step 3: Wire both certificate IDs into one query**

Pass both ingress outputs from `infra/yandex/production/main.tf`, validate exactly two unique IDs in `infra/yandex/modules/observability/variables.tf`, and use the same local query string for both `local.alert_specs.certificate_risk.query` and the dashboard widget. Do not change the `alert_ids` validation or category list.

- [ ] **Step 4: Re-run the focused checks and inspect the artifact**

Run the Step 2 command again.

Expected: PASS and an alert-spec artifact whose `certificate_risk` entry selects both certificate IDs with `series_min`.

- [ ] **Step 5: Commit the monitoring change**

```bash
git add infra/yandex/modules/observability/variables.tf infra/yandex/modules/observability/main.tf infra/yandex/production/main.tf infra/yandex/test/infra-contract.test.mjs infra/yandex/test/alert-specs-artifact.test.mjs
git diff --cached --check
git commit -m "feat(infra): monitor both production certificates"
```

---

### Task 6: Carry both hostnames through workflows and DNS evidence

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release-images.yml`
- Modify: `.github/workflows/deploy-production.yml`
- Modify: `.github/workflows/yandex-infrastructure.yml`
- Modify: `.github/workflows/yandex-dns-convergence.yml`
- Modify: `.github/workflows/yandex-post-dns-smoke.yml`
- Modify: `deploy/production/verify-dns.mjs`
- Modify: `deploy/production/test/dns-verification.test.mjs`
- Modify: `deploy/yandex/dns-convergence.mjs`
- Modify: `deploy/yandex/test/dns-convergence.test.mjs`
- Modify: `deploy/yandex/post-dns-smoke.mjs`
- Modify: `deploy/yandex/test/post-dns-smoke.test.mjs`
- Modify: `deploy/production/test/workflow-contract.test.mjs`
- Modify: `infra/yandex/test/infra-contract.test.mjs`
- Modify: `infra/yandex/test/runbook-contract.test.mjs`
- Modify: `docs/runbooks/yandex-first-go-live.md`

**Interfaces:**

- GitHub variable: `MARKIRO_KIOSK_DOMAIN` in every environment/job that already consumes `MARKIRO_DOMAIN`.
- Terraform workflow environment: `TF_VAR_kiosk_domain`.
- DNS apply, convergence, and post-DNS receipts record exact `adminDomain` and `kioskDomain` plus independently verified answer sets.

- [ ] **Step 1: Add failing exact workflow-environment contracts**

Update the exact workflow fixtures in `deploy/production/test/workflow-contract.test.mjs` and `infra/yandex/test/infra-contract.test.mjs` to require:

- CI/release local values `MARKIRO_DOMAIN=localhost`, `MARKIRO_KIOSK_DOMAIN=kiosk.localhost`;
- generated local runtime `KIOSK_ORIGIN=https://kiosk.localhost:18443`;
- production deploy, DNS convergence, and post-DNS smoke jobs consume `${{ vars.MARKIRO_KIOSK_DOMAIN }}`;
- infrastructure plan/apply jobs expose `TF_VAR_kiosk_domain: ${{ vars.MARKIRO_KIOSK_DOMAIN }}`;
- the exact step order, permissions, cleanup, OIDC, artifact provenance, and protected environments remain unchanged.

Add mutation tests that omit the kiosk variable from any one workflow, substitute the admin domain, or change protected-environment names.

- [ ] **Step 2: Add failing dual-domain DNS receipt tests**

Change DNS test fixtures to this canonical receipt shape while retaining current provenance fields:

```json
{
  "adminDomain": "admin.markiro.example",
  "kioskDomain": "kiosk.markiro.example",
  "answers": {
    "admin.markiro.example": ["203.0.113.10"],
    "kiosk.markiro.example": ["203.0.113.10"]
  }
}
```

Require exact, sorted, nonempty answer sets for both domains, the same approved ALB address, distinct domain names, authenticated apply/convergence provenance, monotonic timestamps, and exact release SHA. Reject a receipt with one domain, an extra domain, split addresses, duplicate domains, stale provenance, or a kiosk/admin swap.

- [ ] **Step 3: Run the focused workflow and DNS tests**

Run:

```bash
node --test deploy/production/test/workflow-contract.test.mjs deploy/production/test/dns-verification.test.mjs deploy/yandex/test/dns-convergence.test.mjs deploy/yandex/test/post-dns-smoke.test.mjs
```

Expected: FAIL because workflow inputs and evidence schemas currently carry only `MARKIRO_DOMAIN`.

- [ ] **Step 4: Implement two-domain DNS verification and post-DNS smoke**

In `deploy/production/verify-dns.mjs`, validate both names with the shared validator and run the complete authoritative/public convergence loop for each name inside the same bounded overall attempt. A successful attempt requires both exact answer sets.

In `deploy/yandex/dns-convergence.mjs` and `deploy/yandex/post-dns-smoke.mjs`:

- parse the exact two-domain receipt shape;
- compare both names and answer sets before any public request;
- retain current authenticated artifact-digest and workflow-run provenance;
- run dual-host public smoke and write evidence only after both authorities pass;
- keep all failure output sanitized.

- [ ] **Step 5: Update workflows without weakening existing guards**

Add `MARKIRO_KIOSK_DOMAIN` beside `MARKIRO_DOMAIN` in every relevant workflow environment. Add `TF_VAR_kiosk_domain` to both infrastructure jobs. Update only the expected evidence fields and generated local kiosk origin; preserve pinned actions, minimal permissions, `set -euo pipefail`, OIDC/token extraction guards, cleanup conditions, environment protection, and artifact retention.

- [ ] **Step 6: Update the first-go-live runbook contract and instructions**

In `docs/runbooks/yandex-first-go-live.md`, update the existing markers and prose to require:

1. `MARKIRO_KIOSK_DOMAIN=kiosk.markiro.app` in each protected environment that carries `MARKIRO_DOMAIN`;
2. sanitized verification that Lockbox `KIOSK_ORIGIN` equals `https://kiosk.markiro.app`;
3. a DNS-disabled plan with one additional kiosk certificate/validation record and no replacement/deletion of existing ingress or durable resources;
4. issued status for both certificates;
5. private `curl --resolve` smoke for both authorities;
6. update of the existing `certificate_risk` console alert from the two-certificate artifact while retaining its current alert ID;
7. one approved `public_dns_enabled=true` apply that publishes both A records;
8. two-domain convergence and post-DNS smoke evidence.

Keep the desktop Tauri kiosk explicitly outside this web/TLS gate.

- [ ] **Step 7: Re-run workflow, DNS, and runbook contracts**

Run:

```bash
node --test deploy/production/test/workflow-contract.test.mjs deploy/production/test/dns-verification.test.mjs deploy/yandex/test/dns-convergence.test.mjs deploy/yandex/test/post-dns-smoke.test.mjs infra/yandex/test/runbook-contract.test.mjs
```

Expected: PASS with exact two-domain evidence and unchanged protection/cleanup contracts.

- [ ] **Step 8: Commit workflow and evidence changes**

```bash
git add .github/workflows/ci.yml .github/workflows/release-images.yml .github/workflows/deploy-production.yml .github/workflows/yandex-infrastructure.yml .github/workflows/yandex-dns-convergence.yml .github/workflows/yandex-post-dns-smoke.yml deploy/production/verify-dns.mjs deploy/production/test/dns-verification.test.mjs deploy/yandex/dns-convergence.mjs deploy/yandex/test/dns-convergence.test.mjs deploy/yandex/post-dns-smoke.mjs deploy/yandex/test/post-dns-smoke.test.mjs deploy/production/test/workflow-contract.test.mjs infra/yandex/test/infra-contract.test.mjs infra/yandex/test/runbook-contract.test.mjs docs/runbooks/yandex-first-go-live.md
git diff --cached --check
git commit -m "feat(deploy): gate dual-host production go-live"
```

---

### Task 7: Run complete acceptance without changing live cloud state

**Files:**

- Verify only; fix only failures caused by Tasks 1-6.

- [ ] **Step 1: Run formatting and repository diff checks**

```bash
git diff --check main...HEAD
pnpm format:check
terraform -chdir=infra/yandex/production fmt -recursive -check
```

Expected: PASS.

- [ ] **Step 2: Run all production and Yandex Node contracts**

```bash
pnpm test:production-bundle:contract
pnpm test:yandex-runtime
pnpm test:yandex-infra:contract
pnpm test:yandex-runbooks:contract
```

Expected: every executed suite PASS. Skips are permitted only when Terraform provider/code access is unavailable and must be reported separately.

- [ ] **Step 3: Build both web applications**

```bash
pnpm --filter @markiro/admin build
pnpm --filter @markiro/kiosk build
```

Expected: PASS; kiosk output contains `index.html`, `manifest.webmanifest`, generated service-worker assets, icons/fonts, and hashed bundles.

- [ ] **Step 4: Validate Terraform when the pinned provider is available**

```bash
terraform -chdir=infra/yandex/production init -backend=false -lockfile=readonly
terraform -chdir=infra/yandex/production validate
```

Expected: PASS. Do not run `terraform plan` or `apply` from this implementation task; those are protected external operations performed after merge.

- [ ] **Step 5: Run the container/browser production bundle gate when Docker is available**

Use the same test-only domains and generated `0600` runtime environment as CI, then run:

```bash
pnpm test:production-docs:browser
```

Also build/start/smoke the production Compose bundle through the existing CI-equivalent commands, proving both `localhost` and `kiosk.localhost` against the same edge container. Do not reuse production secrets.

- [ ] **Step 6: Review the final Terraform and workflow diff for destructive drift**

Confirm from source and contracts:

- no existing admin certificate, ALB, address, backend, VM, PostgreSQL, bucket, Lockbox, SWS, ARL, or alert identifier was renamed or removed;
- only one kiosk certificate, its validation record, one gated A record, and new outputs are added;
- both hostnames remain on one edge image and one protected route chain;
- public DNS defaults to false;
- no secret value is present in tracked files or captured output.

- [ ] **Step 7: Record external checks as pending**

The handoff must list these separately as not yet run:

- protected infrastructure plan/apply;
- live kiosk certificate issuance;
- update and verification of the existing console certificate alert;
- pre-DNS ALB smoke using the reserved address;
- public DNS convergence and post-DNS smoke;
- physical PWA install/fullscreen/scanner/offline recovery;
- desktop Tauri installer, signing, updater, Windows, and hardware acceptance.

- [ ] **Step 8: Commit any verification-only corrections**

If Tasks 1-7 reveal scoped failures, fix only those failures, rerun the affected and complete gates, then stage every corrected path explicitly (never use `git add .`), check the staged diff, and commit:

```bash
git diff --cached --check
git commit -m "test(deploy): complete kiosk production contracts"
```

If no correction is needed, do not create an empty commit.
