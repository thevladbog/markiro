# Markiro Landing Production Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `markiro.app` as an isolated third Caddy authority in the existing production edge, deployment workflow and Yandex DNS model without changing the admin or kiosk boundaries.

**Architecture:** Build the Astro site into `/srv/landing`, add `MARKIRO_LANDING_DOMAIN` across validated deployment contracts, and serve only static landing routes plus an intentionally disabled exact CRM proxy boundary. Keep public DNS disabled until a separately approved go-live.

**Tech Stack:** Docker BuildKit, Caddy 2.11, Node 24 contract tests, Docker Compose, Terraform/Yandex Cloud, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-14-landing-seo-ai-discoverability-design.md`

## Global Constraints

- `MARKIRO_DOMAIN` remains admin; `MARKIRO_KIOSK_DOMAIN` remains kiosk.
- All three authorities are valid, lowercase, fully qualified and distinct.
- Landing unknown paths return 404; admin/kiosk/API routes cannot bleed into the apex.
- CRM proxy remains absent until its exact HTTPS origin and response contract are approved.
- Do not publish DNS or deploy production in this plan execution.

---

### Task 1: Build and isolate the landing edge surface

**Files:**

- Modify: `.dockerignore`
- Modify: `deploy/production/edge.Dockerfile`
- Modify: `deploy/production/Caddyfile`
- Modify: `deploy/production/test/edge-contract.test.mjs`

**Interfaces:**

- Produces: `/srv/landing` and Caddy snippets `landing_routes` plus HTTP/HTTPS authorities for `MARKIRO_LANDING_DOMAIN`.

- [ ] **Step 1: Write edge contract RED assertions**

  Assert the Dockerfile copies/builds `@markiro/landing`, runtime copies only `dist`, Caddy uses a third authority, landing assets are immutable, HTML is `no-cache`, policy files are served, unknown paths are 404, and reserved API/admin/kiosk paths are 404.

- [ ] **Step 2: Run RED**

  Run: `node --test deploy/production/test/edge-contract.test.mjs`
  Expected: FAIL on missing landing build/route assertions.

- [ ] **Step 3: Implement the edge build and route**

  Add landing package sources and output. Use file serving without `/index.html` SPA fallback. Do not add a CRM reverse proxy.

- [ ] **Step 4: Run GREEN and commit**

  Run focused edge contract and `pnpm test:production-bundle:contract`.

  ```bash
  git add .dockerignore deploy/production/edge.Dockerfile deploy/production/Caddyfile deploy/production/test/edge-contract.test.mjs
  git commit -m "feat(deploy): add isolated landing edge authority"
  ```

### Task 2: Carry the third domain through deployment contracts

**Files:**

- Modify: `deploy/production/production-domain.mjs`
- Modify: `deploy/production/preflight.mjs`
- Modify: `deploy/production/deploy.mjs`
- Modify: `deploy/production/smoke.mjs`
- Modify: `deploy/production/verify-dns.mjs`
- Modify: `deploy/production/compose.ci.yml`
- Modify: `deploy/production/test/compose-contract.test.mjs`
- Modify: `deploy/production/test/preflight.test.mjs`
- Modify: `deploy/production/test/deploy.test.mjs`
- Modify: `deploy/production/test/staged-deploy.test.mjs`
- Modify: `deploy/production/test/dns-verification.test.mjs`
- Modify: `deploy/production/test/smoke-route-table.test.mjs`

**Interfaces:**

- Produces: `validateProductionDomains(domain, kioskDomain, landingDomain)` returning all three names and smoke/DNS tables containing the landing authority.

- [ ] **Step 1: Add three-domain RED cases**

  Assert missing/invalid landing domain rejection, all pairwise duplicate rejection, environment forwarding, DNS verification, root/robots/sitemap smoke and landing route-isolation probes.

- [ ] **Step 2: Run focused RED tests**

  Run the seven named Node test files. Expected: FAIL on missing `MARKIRO_LANDING_DOMAIN`.

- [ ] **Step 3: Implement the validated environment flow**

  Thread the variable explicitly through child environments and command inputs; never infer the apex from the admin hostname.

- [ ] **Step 4: Run GREEN and commit**

  Run the focused tests and full production bundle contract.

  ```bash
  git add deploy/production
  git commit -m "feat(deploy): validate and smoke landing domain"
  ```

### Task 3: Extend workflow, Terraform DNS and runbooks

**Files:**

- Modify: `.github/workflows/release-images.yml`
- Modify: `.github/workflows/deploy-production.yml`
- Modify: `.github/workflows/yandex-infrastructure.yml`
- Modify: `infra/yandex/production/main.tf`
- Modify: `infra/yandex/production/variables.tf`
- Modify: `infra/yandex/production/outputs.tf`
- Modify: `infra/yandex/production/terraform.tfvars.example`
- Modify: `infra/yandex/test/infra-contract.test.mjs`
- Modify: `deploy/production/test/workflow-contract.test.mjs`
- Modify: `deploy/production/test/runbook-contract.test.mjs`
- Modify: `docs/runbooks/saas-production-deploy.md`
- Modify: `docs/runbooks/yandex-first-go-live.md`
- Modify: `docs/runbooks/yandex-infrastructure-apply.md`

**Interfaces:**

- Produces: Terraform `landing_domain`, conditional apex A record, workflow variable forwarding and a publication checklist that preserves `public_dns_enabled=false` by default.

- [ ] **Step 1: Write workflow/infra/runbook RED assertions**

  Assert the variable exists, pairwise validation is present, DNS record is gated by `public_dns_enabled`, workflow forwards it, and runbooks require local readiness before explicit DNS approval.

- [ ] **Step 2: Run RED**

  Run workflow, runbook, and Yandex infra contract tests. Expected: FAIL on missing landing references.

- [ ] **Step 3: Implement configuration and documentation**

  Add the apex record without applying Terraform. Document the exact DNS -> ACME -> public smoke sequence and the CRM/legal/indexing gates.

- [ ] **Step 4: Run GREEN and commit**

  Run `pnpm test:production-bundle:contract`, `pnpm test:yandex-infra:contract`, `pnpm test:yandex-runbooks:contract`, `terraform fmt -check -recursive infra/yandex`, and `git diff --check`.

  ```bash
  git add .github/workflows deploy/production infra/yandex docs/runbooks
  git commit -m "feat(infra): prepare apex landing publication"
  ```

### Task 4: Build the real edge image locally

**Files:**

- Modify: `docs/superpowers/plans/2026-08-14-landing-production-domain.md`

- [ ] **Step 1: Run the production image contract**

  Build the edge target through the repository's established contract command and verify `/srv/landing` exists while source files and Node dependencies do not exist in runtime.

- [ ] **Step 2: Run local authority probes**

  With synthetic local domains, verify landing root/routes/policy files, reserved-path 404s, admin/kiosk regression routes, cache headers and release SHA.

- [ ] **Step 3: Record external gates**

  Record that production DNS, certificate issuance, Terraform apply, SSH deploy, CRM upstream and external smoke were not exercised.
