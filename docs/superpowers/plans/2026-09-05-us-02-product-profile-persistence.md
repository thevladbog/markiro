# US-02 product profile persistence implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline, with focused test-first steps and an independent final review. The user's continuation authorization covers implementation; commits, publication and deployment remain separate.

**Goal:** Persist a tenant-scoped product description and manual FTL review through the isolated US API.

**Architecture:** One additive profile table references the existing shared catalog by tenant/product. A transaction reloads current membership and regulatory context, locks the catalog row, compares a client revision, and writes the profile and exact audit snapshots atomically. No RU route, runtime provider or UI proxy is added.

**Tech Stack:** Existing Node 24, pnpm, NestJS, Drizzle/PostgreSQL, Zod and Vitest; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-03-us-02-product-profiles-and-lots-design.md`, `docs/us/mvp-contract.md`, and the completed product-profile rule/contract foundation.

**Status:** Implemented and independently reviewed locally. The scoped gates pass; the broad primary API suite has environment/setup failures documented below. No integration or release acceptance is implied.

## Global constraints and implementation clarifications

- Work only in `codex/us-mvp`; preserve earlier uncommitted increments. No release, deploy, commit or push in this increment.
- Use only the dedicated US connection; tests create owned disposable databases through `US_TEST_DATABASE_URL`. Never load the primary environment.
- GET `/traceability/products/:productId` returns revision 0 defaults without creating a row; the initial product name comes from the catalog. Saved descriptions are independent of later catalog renames.
- PUT accepts the full editable document plus mandatory `expectedRevision`. Persisted revisions start at 1. A fresh unchanged save is a no-op. An exact retry of the immediately preceding revision is also a no-op; all other stale/future revisions conflict. Divergent concurrent first saves serialize on the catalog row.
- Both descriptions and coverage require `traceability.master_data.write`. Changing any of the five coverage fields additionally requires `traceability.qa.manage`. Review actor/time are server owned; description-only changes preserve them. Resetting coverage to unknown is also a review change.
- The generic US profile accepts only unknown coverage with empty classification metadata. Persisted invalid or wrong-profile rows fail closed.
- Package values use numeric(12,3), normalized by string padding to three decimals after strict validation; never float conversion, rounding or unit conversion. Equivalent decimal spellings are a no-op.
- Review attribution retains the opaque historical user ID without a live user FK, like an immutable audit snapshot. Authorization still requires current membership. This corrects the draft's `ON DELETE SET NULL` proposal, which contradicted required review provenance; no names, email or other identity data are copied.
- Every changed save records `traceability.product_profile.updated`; actual coverage changes also record `traceability.product_profile.coverage_changed`, both with exact before/after, tenant, actor, target and request ID. Failed writes leave neither rows nor audit behind.
- No lots, CTEs, assessment UI, readiness claim, P1 review fields or automatic FTL classification.

## Task 1 — versioned transport and additive storage

Files: `packages/platform-contracts/src/traceability/products.ts`, its existing test; new `packages/db/src/schema/traceability-products.ts`, schema export/config, migration0117 and `packages/db/test/us-product-profile-{schema,migration.e2e}.test.ts`.

Interfaces: `putProductTraceabilityProfileSchema` consumes the existing editable schema plus `expectedRevision`; `productTraceabilityProfileSchema` adds `revision`. `schema.productTraceabilityProfiles` exposes the persisted description, coverage, provenance and revision.

- [x] Add and observe failing contract/schema tests:

  ```ts
  expect(
    putProductTraceabilityProfileSchema.safeParse({ ...editable, expectedRevision: 0 }).success,
  ).toBe(true);
  expect(productTraceabilityProfileSchema.safeParse({ ...persisted, revision: 0 }).success).toBe(
    false,
  );
  ```

- [x] Add transport extension, positive persisted revision constraint, tenant-composite product FK, closed coverage/UOM sets and paired positive package size. Generate a new migration with `pnpm --filter @markiro/db exec drizzle-kit generate --name=us_product_profiles`; inspect SQL and snapshot without rewriting migration0116.
- [x] Run focused contracts and schema tests; rebuild DB. Exercise additive migration over an owned database at migration0116, preserving its catalog rows and rejecting cross-tenant references, duplicate profiles, invalid sizes and revisions.

## Task 2 — authorized transactional profile store

Files: new `apps/api/src/modules/traceability/products/us-product-profile-{store,support}.ts`, `apps/api/test/us-product-profile.e2e.test.ts`.

Interfaces: `new UsProductProfileStore(db)`, `getProfile(tenantId, actorUserId, productId): Promise<ProductTraceabilityProfile>`, `putProfile(tenantId, actorUserId, productId, input, requestId): Promise<ProductTraceabilityProfile>`.

- [x] Write and observe failing tests using a real owned PostgreSQL database:

  ```ts
  const initial = await store.getProfile(tenantId, actorUserId, productId);
  expect(initial).toMatchObject({ revision: 0, reviewedBy: null, createdAt: null });
  const saved = await store.putProfile(
    tenantId,
    actorUserId,
    productId,
    { ...editable, expectedRevision: 0 },
    "save",
  );
  expect(saved).toMatchObject({ revision: 1, packagingSizeValue: "6.000" });
  await expect(
    store.putProfile(
      tenantId,
      actorUserId,
      productId,
      { ...editable, productName: "Conflicting", expectedRevision: 0 },
      "stale",
    ),
  ).rejects.toMatchObject({ status: 409 });
  ```

- [x] Implement defaults/row parsing and exact string normalization, then tenant-scoped transactional read/upsert. Reload capabilities through `authorizeUsMasterData`, validate coverage using its trusted profile code, lock the product before reading/saving the current profile, and insert both audit events in that transaction.
- [x] Prove manager description-only rights, QA review rights, revoked/foreign membership denial, generic/RU/corrupt profile denial, untouched review stamps, concurrent first/edit conflicts, equivalent retry no-ops and complete rollback on audit failure. Rebuild shared packages before consumer tests.

## Task 3 — isolated HTTP route, documentation and gates

Files: new `apps/api/src/deployment/us-product-profile.controller.ts`; US runtime/module; existing `apps/api/test/us-catalog-http.e2e.test.ts` extended for connected profile HTTP; isolated CI workflow and US progress/spec/requirements docs.

Interfaces: session/MFA-protected GET/PUT `/traceability/products/:productId`; strict OpenAPI schemas and 400/401/403/404/409/413/415/503 responses; safe runtime DB failure mapping.

- [x] Before controller implementation, add HTTP assertions for defaults, saved revision, stale conflict, forged review metadata, current role changes and safe storage errors:

  ```ts
  expect((await catalogRequest(`/traceability/products/${productId}`, "PUT", payload)).status).toBe(
    200,
  );
  expect(
    (await catalogRequest(`/traceability/products/${productId}`, "PUT", staleDifferentPayload))
      .status,
  ).toBe(409);
  ```

- [x] Register only the isolated controller and runtime store. Keep destructive/profile-list routes and the browser proxy absent; readiness remains 503.
- [x] Run focused real DB/API suites, full contracts/DB tests with explicit skip counts, relevant API typecheck/lint/build and US composition/isolation gates. Run formatting/diff checks. Request independent scoped review and address verified findings before reporting.
- [x] Record actual evidence and remaining UI/lot work. No browser/hardware/hosted validation is claimed for this server-only increment.

## Local evidence and limits — 2026-09-05

- RED: missing PUT export/revision response and profile table fail focused contracts/schema tests; missing store fails the API test import; five real HTTP assertions fail with absent 404 routes before registration. These are implementation checkpoints, not acceptance results.
- GREEN: 67 focused profile contract tests; one schema and 13 real migration tests; final product-profile store has 24 tests and connected catalog/profile HTTP has 14. The final expanded US API/deployment set passes 257 tests in 15 files with no skips.
- Full contracts: 245 tests in 16 files pass. Full DB: 250 tests in 47 files pass, with 141 explicit non-US infrastructure skips in 27 files because `DATABASE_URL` is unset. US migrations run on disposable databases through the isolated 55432 fixture. Migration0117's snapshot points to0116, adds only the profile table/coverage enum and changes no pre-existing table or enum.
- DB and contracts typechecks (including test types), lint and builds pass. API typecheck, lint and build were rerun after the final correction and pass. Existing US client/catalog/app regression passes 67 tests in four files; the isolated US browser build passes. No UI was changed in this increment.
- Local release-isolation checker and 17 isolation contracts pass. Four compiled executable checks pass: RU rejects US, US rejects production/missing edition, owner command rejects unsafe inputs, and US liveness/readiness/shutdown remain isolated. No remote repository settings or deployment are verified.
- Independent review found a generic-profile provenance gap: an unknown/empty persisted profile with reviewer/time could be returned. A real-DB regression first reproduced the incorrect successful response, then passed after GET and PUT reject such rows with sanitized503 without rewriting/auditing them. The reviewer rechecked the correction and has no remaining findings. Processor review history is unchanged.
- The broad API package run during this increment is **not green**: 1,690 passed and 1,411 skipped; eight files have setup/collection failures (nine suites): billing accounts, exchange credentials/import/orders/protocol, integrations/delete, and subscription route inventory. They require intentionally absent primary auth/database variables; three cleanup errors follow failed setup. The run preceded the final generic-provenance correction; the complete isolated 257-test set and API static/build gates were rerun after it. Do not treat this as RU infrastructure or release acceptance.
- No hosted or manual browser/assistive-technology/hardware/CTE/export validation. No primary environment, base database, `.pen`, main checkout, commit, push, merge or deployment changed. There is no local Graphify graph to update.
- Full-worktree `format:check` and `git diff --check` pass; final documentation updates are formatted separately. The primary checkout still contains only its pre-existing untracked design/export/screenshot artifacts.
