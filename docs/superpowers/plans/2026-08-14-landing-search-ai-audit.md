# Markiro Landing Search and AI Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SEO, accessibility, performance, crawler parity, publication readiness and post-index AI visibility measurable with reproducible repository artifacts.

**Architecture:** Add a bounded local audit that builds/serves the Astro output and records machine-readable results, then provide a versioned external query pack and report template for live webmaster and AI-search checks. Keep lab scores separate from field and indexing evidence.

**Tech Stack:** Astro, Playwright/Chromium already used by production-browser tooling, Lighthouse CLI with an exact version, Node 24.

**Spec:** `docs/superpowers/specs/2026-08-14-landing-seo-ai-discoverability-design.md`

## Global Constraints

- Never report local Lighthouse as field Core Web Vitals.
- Never report day-zero absence from AI answers as a product defect.
- Crawler parity must compare content, not bypass robots restrictions.
- Audit artifacts contain no secrets, form values, cookies, session identifiers, or webmaster tokens.

---

### Task 1: Add deterministic built-site SEO audit

**Files:**

- Create: `apps/landing/test/site-audit.test.ts`
- Create: `apps/landing/src/lib/audit.ts`
- Create: `apps/landing/src/lib/audit.test.ts`
- Modify: `apps/landing/package.json`

**Interfaces:**

- Produces: `auditBuiltSite(root): AuditFinding[]` with codes for broken internal links, missing images, duplicate metadata, invalid canonical routes, absent headings, invalid JSON-LD and sitemap/route disagreement.

- [x] **Step 1: Write RED unit fixtures**

  Cover one valid miniature site and explicit malformed fixtures for each finding code.

- [x] **Step 2: Run RED**

  Run: `pnpm --filter @markiro/landing exec vitest run src/lib/audit.test.ts test/site-audit.test.ts`
  Expected: FAIL because the audit module does not exist.

- [x] **Step 3: Implement bounded filesystem audit**

  Resolve only files under the supplied build root, normalize trailing-slash routes, ignore external URLs, and parse HTML with jsdom. The real-build test expects zero error findings.

- [x] **Step 4: Run GREEN and commit**

  ```bash
  git add apps/landing/src/lib/audit.ts apps/landing/src/lib/audit.test.ts apps/landing/test/site-audit.test.ts apps/landing/package.json
  git commit -m "test(landing): add deterministic SEO audit"
  ```

### Task 2: Add browser and Lighthouse release gates

**Files:**

- Create: `tools/production-browser/landing.playwright.config.ts`
- Create: `tools/production-browser/tests/landing-seo.spec.ts`
- Create: `tools/production-browser/scripts/lighthouse-landing.mjs`
- Create: `tools/production-browser/test/lighthouse-landing.test.mjs`
- Modify: `tools/production-browser/package.json`
- Modify: `tools/production-browser/pnpm-lock.yaml`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Produces: `test:landing:browser` and `test:landing:lighthouse` scripts; Lighthouse exits non-zero below SEO 1.00, accessibility 1.00, best-practices 0.95, or performance 0.90.

- [x] **Step 1: Write RED threshold/parser tests**

  Feed synthetic Lighthouse JSON and assert boundary scores, missing categories and non-finite scores fail with precise messages.

- [x] **Step 2: Add Playwright route and crawler-parity tests**

  Start the built site, visit all routes at mobile/desktop sizes, check keyboard focus, no horizontal overflow, no console/page errors, real 404s, policy endpoints and representative crawler User-Agents.

- [x] **Step 3: Pin Lighthouse and update the isolated lockfile**

  Use an exact version and preserve the production-browser workspace isolation. Do not broaden dependency ranges.

- [x] **Step 4: Run GREEN and commit**

  Run parser tests, landing browser suite and both Lighthouse profiles.

  ```bash
  git add tools/production-browser package.json .github/workflows/ci.yml
  git commit -m "test(landing): gate browser SEO and Lighthouse"
  ```

### Task 3: Add publication and AI-search audit artifacts

**Files:**

- Create: `docs/runbooks/landing-publication.md`
- Create: `docs/seo/ai-search-query-pack.md`
- Create: `docs/seo/ai-search-audit-template.md`
- Create: `docs/seo/search-console-baseline-template.md`
- Modify: `deploy/production/test/runbook-contract.test.mjs`

**Interfaces:**

- Produces: a versioned branded/non-branded query set, source/citation accuracy rubric, D0/D7/D30 cadence and exact webmaster/public-smoke checklist.

- [x] **Step 1: Write runbook RED contract**

  Assert the publication runbook includes DNS, TLS, external 404, robots/sitemap, Google, Yandex, Bing, IndexNow, structured-data validators, CRM/legal/consent gates, query-pack path and the rule that D0 is reachability only.

- [x] **Step 2: Run RED**

  Run the runbook contract. Expected: FAIL because the publication runbook is absent.

- [x] **Step 3: Write the exact query pack and templates**

  Include branded, category, workflow, offline/recovery, SSCC, kiosk and 1C queries. Each result row records engine/model, locale/date, prompt, mention, citation URL, factual score, competing sources and follow-up action.

- [x] **Step 4: Run GREEN and commit**

  Run runbook contract, Prettier, writing-guidelines review for the new public-facing copy, and `git diff --check`.

  ```bash
  git add docs/runbooks/landing-publication.md docs/seo deploy/production/test/runbook-contract.test.mjs
  git commit -m "docs(landing): add search and AI audit protocol"
  ```

### Task 4: Final integrated verification

**Files:**

- Modify: `docs/superpowers/plans/2026-08-14-landing-search-ai-audit.md`

- [x] **Step 1: Run landing gates**

  Run landing test/typecheck/lint/build, deterministic audit, browser suite and Lighthouse mobile/desktop.

- [x] **Step 2: Run production gates**

  Run production bundle contracts, Yandex infra contracts, runbook contracts, Terraform formatting, root format check and `git diff --check`.

- [x] **Step 3: Review evidence boundaries**

  Report browser/lab results separately from CRM, legal consent, analytics, DNS/TLS, webmaster ownership, indexing, field Core Web Vitals and AI citations.
