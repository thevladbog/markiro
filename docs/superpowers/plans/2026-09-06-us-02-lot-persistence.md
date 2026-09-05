# US-02 lot persistence and API implementation plan

> **For agentic workers:** Use superpowers:executing-plans for this inline continuation. Steps use checkbox syntax for tracking.

**Goal:** Persist imported lots and expose tenant-scoped list/read/create and QA status actions in the isolated US API.

**Architecture:** Add a tenant-composite lot table and strict contracts; reuse the current US session, membership/profile authorization, transaction and audit boundaries. Source identity is either a location, a typed web reference resolving to a tenant location, or missing on an incomplete record. Lot identity is not editable through this increment; no CTE, genealogy storage, balance, export-ready verdict or UI is introduced.

**Tech Stack:** Node 24, repository-pinned pnpm, TypeScript, Zod, Drizzle/PostgreSQL, NestJS, Vitest. No dependency changes.

**Spec:** `docs/us/mvp-contract.md` sections 3–6 and `docs/superpowers/specs/2026-09-03-us-02-product-profiles-and-lots-design.md`.

## Global constraints

- Existing `codex/us-mvp` worktree only. Preserve prior dirty changes; no commit/push/merge/release, production credentials or primary database access.
- Source reference type in this increment is `web_url`: absolute HTTP(S), no credentials/control/whitespace, at most 1024 UTF-8 bytes (bounded indexed identity), preserved exactly. It must explicitly resolve to a same-tenant location. No URL fetch, canonicalization or free-text fallback. GLN/FFRN remain P1. A selected location can still have an incomplete description: future finalization must freeze and validate it and require the actual processor location for transformation.
- Create permits a missing source for an incomplete record, not a finalized event. It accepts only imported assignment in the service; reserved bases and other operation bases return precise 422 errors. Client tenant, actor, status and event IDs are rejected.
- Identity uniqueness excludes product: same tenant/source/TLC conflicts even for a different product; a different source or tenant may reuse the TLC. Archive never releases identity. Source-less records have their own partial unique index. No global TLC lookup or duplicate disclosure across tenants.
- QA status writes require `expectedRevision`, reason and a valid manual transition. Lock the lot and increment revision atomically with audit. An identical immediate retry by the same actor returns the existing row without another audit; divergent stale writes return 409. No system recalculation override or DELETE/PATCH identity route.
- Created/updated actors are historical opaque values, not mutable identity FKs. Audit snapshots additionally retain actor IDs when the common audit actor FK is cleared. Rollback on audit failure.

## Task 1: contracts and storage

**Files:** add `packages/domain/src/traceability/lots/source.ts`, `packages/platform-contracts/src/traceability/lot-records.ts`, package exports and focused tests; add `packages/db/src/schema/traceability-lots.ts`, schema/config exports, next generated migration and its snapshot/journal. Add `packages/db/test/us-lot-schema.test.ts` and `us-lot-migration.e2e.test.ts`.

**Interfaces:** `isTlcSourceReferenceUrl(value: string): boolean`; `traceabilityLotSourceSchema` is null or `{kind:'location',locationId}` or `{kind:'reference',referenceKind:'web_url',referenceValue,resolvedLocationId}`. `createTraceabilityLotSchema` accepts productId, tlc, source and assignmentBasis (default imported). `traceabilityLotSchema` contains id/productId/tlc/source/assignmentBasis/status/revision, historical createdBy/updatedBy, createdAt/updatedAt; no live product/source description is called a snapshot. `postLotStatusSchema` extends the existing strict reason/status fields with expectedRevision. List filters: productId, exact tlc, sourceLocationId (including resolved reference locations), assignmentBasis, status, literal substring search, limit/offset (existing bounded master-data pagination).

- [x] Write RED tests for typed sources, strict record/body schemas, revision bounds, canonical TLC, URL identity and invalid references. Test missing source without claiming finalizability.

```ts
expect(createTraceabilityLotSchema.parse({ productId, tlc: " =APPLE-01 ", source: null })).toEqual({
  productId,
  tlc: "=APPLE-01",
  source: null,
  assignmentBasis: "imported",
});
expect(postLotStatusSchema.safeParse({ status: "recalled", reason: "QA review" }).success).toBe(
  false,
);
```

- [x] Implement schemas, rebuild domain/contracts and rerun GREEN. Write schema/real migration RED tests, add table and generate the next additive migration. Inspect SQL; do not edit applied migrations or use the primary environment.
- [x] Verify migration from 0117 preserves products/profiles; tenant/product/source composite FKs; null/typed source shape; source-aware uniqueness, Unicode TLC limits, positive revision and historical actor retention. API fixture applies the whole chain in a separately owned random US database.

## Task 2: transactional lot store

**Files:** add `apps/api/src/modules/traceability/lots/us-lot-store.ts` and `us-lot-support.ts`, `apps/api/test/us-lot.e2e.test.ts`.

**Interfaces:** `UsLotStore(db)` with listLots(tenant,actor,query), getLot(tenant,actor,id), createLot(tenant,actor,input,requestId), changeStatus(tenant,actor,id,input,requestId). Inputs are unknown at the boundary; tenant/actor come from trusted current session. Responses validate persisted values and fail with sanitized 503 if corrupt. Create locks referenced product/location/party rows to prevent archive races; status locks the lot. Every read/write includes tenant predicates.

- [x] Write focused RED tests using a real disposable US database for generic/processor profiles, all role boundaries, foreign/malformed IDs, archived reference denial, null GTIN, missing source, exact audit, literal search, duplicate/conflicting parallel creates and status writes, immediate retry, stale conflict, membership revocation, corrupt profile and audit rollback.

```ts
const lot = await store.createLot(tenant, actor, { productId, tlc: "A-1", source: null }, "create");
await expect(
  store.createLot(tenant, actor, { productId, tlc: "A-1", source: null }, "duplicate"),
).rejects.toMatchObject({ status: 409, response: { code: "LOT_DUPLICATE", existingId: lot.id } });
```

- [x] Implement minimal store/support. `INSERT ... ON CONFLICT DO NOTHING` retains the transaction for a tenant-scoped exact duplicate lookup; unexpected storage errors propagate to the runtime's sanitized boundary. Status audit stores before/after plus reason. Re-run focused GREEN and existing US regression.

## Task 3: isolated HTTP and verification

**Files:** add `apps/api/src/deployment/us-lot.controller.ts`; update US module/runtime and API HTTP tests; update check-only US workflow and dated implementation/spec/requirements documentation.

- [x] Write real authenticated HTTP RED coverage in the existing catalog HTTP fixture: list/create/read/status, current membership, anonymous denial, strict forged fields, safe errors, no-store/request ID, unavailable DELETE/PATCH/event routes and generated OpenAPI. Reuse real MFA, not a mocked principal.
- [x] Register only US `/traceability/lots` GET/POST, `/:id` GET and `/:id/status` POST (200). No browser proxy change; no RU import, external client, startup migration or readiness enablement. Re-run GREEN.
- [x] Build dependencies before consumers. Run full domain/contracts/DB gates, API package gates and US-focused disposable-DB regression, isolation checks, format/diff checks. Report unrelated missing-primary-environment skips/failures separately, never populate that environment to obtain green.
- [x] Request independent read-only review and fix actionable findings with tests. Record actual coverage; no browser/hardware/hosted verification is implied.

## Completion record

Implemented locally on 2026-09-06. Reviewed migration0118 adds only the lot table, enums, constraints and indexes. Existing product/profile rows are preserved; no rows are inferred or seeded. The store and real MFA HTTP tests exercise tenant/role denial, source identity, concurrent duplicates/status changes, exact atomic audit and rollback, corrupt record rejection and account-deletion provenance.

Review's current-revision self-transition and case-sensitive URL scheme findings were reproduced by failing tests, then corrected without changing stored reference identity or relaxing status rules. The immediate previous-revision identical retry remains idempotent. Re-review reports no actionable findings.

Final verification:

- Domain: 814 tests / 45 files; contracts: 315 tests / 18 files; no skips. Both typecheck, lint and build pass.
- DB: 261 tests pass, 141 primary-environment tests skip; typecheck, lint and build pass. The final focused schema/migration run passes all 11 tests, including existing product/profile preservation. No base/primary database was migrated.
- Lot store and catalog/profile/lot HTTP: 47 tests pass; complete US API plus deployment/environment/health regression: 290 tests / 16 files, no skips. API typecheck, lint and build pass; admin consumer typecheck passes.
- Broad API: 1,724 tests pass, 1,411 skip; eight failing files / nine failed suites due to absent primary DB/auth environment, including three cascading teardown errors. This gate is not green. No credentials or primary environment were loaded to bypass the boundary.
- Isolation: 17 contracts pass; compiled runtime: three smoke tests pass, proving production refusal, closed readiness/RU routes and graceful shutdown. Repository formatting and diff checks pass. No local Graphify graph exists to update.

No browser UI, hosted service, printer/scanner or external integration was exercised by this backend increment. LOT requirements remain partial until event-source completeness, snapshot capture, identity/source corrections, current-revision genealogy and UI are implemented. A missing-source record cannot yet be completed through this API. Changes stay uncommitted in `codex/us-mvp`; no main-checkout edit, push, merge, cleanup, release or deployment is included.
