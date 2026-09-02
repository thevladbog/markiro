# National Catalog Multitenant Diagnostic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the protected National Catalog diagnostic select one configured source tenant and one configured known GTIN without assuming that production has only one tenant or choosing an arbitrary product.

**Architecture:** Keep the existing closed diagnostic evidence at version 3 and change only source acquisition. The API loads `NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID` and `NATIONAL_CATALOG_LIVE_GTIN`, queries the unexpired encrypted token for that tenant, and never reads the product table to choose diagnostic input; production runtime inventory carries the non-secret GTIN without committing its value.

**Tech Stack:** TypeScript, NestJS environment validation with Zod, Drizzle/PostgreSQL, Vitest, Node test runner, Yandex Lockbox runtime inventory, protected GitHub Actions production diagnostics.

**Spec:** `docs/superpowers/specs/2026-09-01-national-catalog-foundation-hardening-design.md`

## Global Constraints

- The integration remains read-only and targets the production National Catalog endpoint.
- Diagnostic output contains no tenant IDs, GTINs, card IDs, tokens, raw provider messages, database error strings, or decrypted values.
- Tenant product imports continue to obtain the token for the authenticated tenant; the configured source tenant is used only for global schema refresh and the protected diagnostic.
- No production credential or concrete tenant/GTIN value is committed; `.env.production.example` remains a blank key inventory.
- Runtime inventory changes are deployed only through the protected production workflow after merge.
- Preserve diagnostic evidence `version: 3`; the host validator and API image continue to accept exactly the same evidence schema.

---

### Task 1: Select the configured tenant and known GTIN

**Files:**

- Modify: `apps/api/test/national-catalog-live-diagnostic.test.ts`
- Modify: `apps/api/test/env.test.ts`
- Modify: `apps/api/src/national-catalog-live-diagnostic.ts`
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/test/national-catalog.live.test.ts`

**Interfaces:**

- Consumes: `NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID?: string`, `NATIONAL_CATALOG_LIVE_GTIN?: string`, encrypted `chz_api_tokens` rows, and `ChzCryptoService.decrypt(tenantId, token)`.
- Produces: `loadNationalCatalogProductionSource(dependencies, { sourceTenantId, productGtin }): Promise<SourceResult>` and `findActiveToken(tenantId): Promise<NationalCatalogProductionTokenCandidate | null>`.

- [ ] **Step 1: Write the failing source-selection tests**

  Replace the single-token/product lookup cases with tests that pass an explicit source tenant and GTIN, make `findActiveToken` assert the requested tenant, return a matching candidate, and verify decryption uses that identity. Add a second case proving unrelated tenant tokens are irrelevant because the dependency is asked only for the configured tenant. Add fail-closed cases for blank tenant, missing or non-14-digit GTIN, query failure, missing selected-tenant token, mismatched returned tenant, and decryption failure; assert serialized evidence excludes all private sentinel values.

- [ ] **Step 2: Run the focused diagnostic test and verify RED**

  Run: `VITE_CONFIG_NATIVE_IGNORE_WARNING=true corepack pnpm --filter @markiro/api exec vitest run test/national-catalog-live-diagnostic.test.ts`

  Expected: FAIL because `loadNationalCatalogProductionSource` still accepts global `listActiveTokens`/`findProductGtin` dependencies and does not accept explicit source configuration.

- [ ] **Step 3: Write the failing environment tests**

  Extend the trimmed National Catalog configuration test with `NATIONAL_CATALOG_LIVE_GTIN: " 04600000000015 "` and expect the normalized 14-digit value. Add table cases rejecting empty-after-normalization only as disabled, and rejecting non-digit or non-14-digit configured values.

- [ ] **Step 4: Run the focused environment test and verify RED**

  Run: `VITE_CONFIG_NATIVE_IGNORE_WARNING=true corepack pnpm --filter @markiro/api exec vitest run test/env.test.ts`

  Expected: FAIL because `loadEnv` does not expose or validate `NATIONAL_CATALOG_LIVE_GTIN`.

- [ ] **Step 5: Implement tenant-bound source acquisition**

  Change the production dependency to:

  ```ts
  interface NationalCatalogProductionSourceDependencies {
    findActiveToken: (tenantId: string) => Promise<NationalCatalogProductionTokenCandidate | null>;
    decryptToken: (tenantId: string, token: NationalCatalogProductionTokenCandidate) => string;
  }
  ```

  Normalize and validate the supplied tenant/GTIN before database or crypto work. Query `chz_api_tokens` with both `tenant_id = configured tenant` and `expires_at > now()`, reject a missing or mismatched row without leaking identifiers, decrypt only with the configured tenant identity, and remove the arbitrary `products` query. Pass both environment values from `collectProductionEvidence`.

- [ ] **Step 6: Implement the environment contract**

  Add optional, trimmed `NATIONAL_CATALOG_LIVE_GTIN` validation with `/^\d{14}$/`, normalize its blank placeholder to absent, and make the local live test read the parsed value from `env` rather than reading `process.env` after parsing.

- [ ] **Step 7: Run focused tests and verify GREEN**

  Run:

  ```bash
  VITE_CONFIG_NATIVE_IGNORE_WARNING=true corepack pnpm --filter @markiro/api exec vitest run test/national-catalog-live-diagnostic.test.ts test/env.test.ts
  ```

  Expected: PASS with no warnings or leaked private sentinel values.

### Task 2: Add the known GTIN to protected runtime inventory and operations docs

**Files:**

- Modify: `.env.production.example`
- Modify: `deploy/production/test/compose-contract.test.mjs`
- Modify: `deploy/yandex/test/runtime-env.test.mjs`
- Modify: `docs/runbooks/national-catalog-live-validation.md`
- Modify: `docs/runbooks/yandex-secrets.md`

**Interfaces:**

- Consumes: blank `KEY=` lines from `.env.production.example` as the exact Lockbox/runtime key inventory.
- Produces: a 43-key production inventory containing blank `NATIONAL_CATALOG_LIVE_GTIN=` and operator instructions that preserve all existing secret entries when publishing its actual value.

- [ ] **Step 1: Write the failing inventory contract expectations**

  Add `NATIONAL_CATALOG_LIVE_GTIN` after the schema source tenant in both exact inventory lists, increase the expected Yandex inventory size from 42 to 43, and add it to the production environment example assertion.

- [ ] **Step 2: Run inventory contract tests and verify RED**

  Run:

  ```bash
  node --test deploy/production/test/compose-contract.test.mjs deploy/yandex/test/runtime-env.test.mjs
  ```

  Expected: FAIL because `.env.production.example` does not yet contain the new key.

- [ ] **Step 3: Add the blank production key and correct the runbooks**

  Add `NATIONAL_CATALOG_LIVE_GTIN=` without a value. Document that protected diagnostics select `NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID`, query only that tenant's active token, and use the configured known GTIN; multiple other tenants and tokens are expected and do not make the source ambiguous. Document adding the known GTIN to a new Lockbox version while preserving the previous version and never printing tenant, GTIN, token, or raw card payload.

- [ ] **Step 4: Run inventory contract tests and verify GREEN**

  Run:

  ```bash
  node --test deploy/production/test/compose-contract.test.mjs deploy/yandex/test/runtime-env.test.mjs
  ```

  Expected: PASS with the exact 43-key inventory.

- [ ] **Step 5: Run package and deployment gates**

  Run:

  ```bash
  corepack pnpm --filter @markiro/api test
  corepack pnpm --filter @markiro/api typecheck
  corepack pnpm --filter @markiro/api lint
  corepack pnpm --filter @markiro/api build
  node --test deploy/yandex/test/national-catalog-diagnostics.test.mjs deploy/yandex/test/runtime-env.test.mjs
  corepack pnpm test:production-bundle:contract
  corepack pnpm format:check
  git diff --check
  ```

  Expected: PASS. Database-backed skips, if any, are reported separately and are not described as production proof.

- [ ] **Step 6: Refresh the local code graph and inspect the final diff**

  Run: `graphify update .`

  Then confirm the diff contains only the API source-selection behavior, environment/runtime inventory, focused tests, runbooks, and this plan; confirm no concrete production tenant, GTIN, bearer, or raw provider response was added.

- [ ] **Step 7: Commit, push, and open one pull request**

  Stage only the files listed in this plan, commit with `fix(api): make National Catalog diagnostic tenant-aware`, push `codex/national-catalog-multitenant-diagnostic`, and open one PR describing the preserved v3 evidence contract and the post-merge protected deployment/diagnostic gate.
