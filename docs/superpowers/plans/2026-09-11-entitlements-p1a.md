# Entitlements P1A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved P1A foundation: explainable server entitlements, explicit prepared sources, safe commercial V3, and observable shadow checks without changing current production admission.

**Architecture:** Extend the existing EntitlementsService with one coherent current/candidate projection. Operation admission consumes that resolver; it does not duplicate subscription calculation or replace existing authorization, locks, jobs, recovery, or idempotency. Prepared sources and new module denials remain shadow-only.

**Tech Stack:** TypeScript, Zod, NestJS, Drizzle/Postgres, React, Vitest, existing Markiro UI and i18n, Corepack pnpm 11.22.0 and Node 24+.

**Spec:** [Approved P1A design](../specs/2026-09-11-entitlements-p1-foundation-design.md).

## Global Constraints

- `chzIntegration` includes CHZ and National Catalog; Start illustrates a paid add-on, not a production publication.
- New features: `chzIntegration`, `inventory`, `commerceMl`, `handheld`; retain `labelEditor`, `publicApi`, `pallets`.
- Preserve `maxStations` and shared `stations` quota for Station/handheld; kiosks remain separate.
- Commercial `X-Markiro-Commercial-Version: 3` has separate strict schemas. Legacy and V2 shapes and saved documents remain unchanged.
- Prepared P1 sources affect candidate/shadow only. Existing security, subscription, quota and `SUBSCRIPTION_ENFORCEMENT_MODE=all` decisions remain authoritative.
- No negative grants; temporary grants have a finite end and do not extend the base subscription. Compatibility grants describe only explicit new-module operation versions, never quota increases or inferred rights from usage/token readiness.
- New V3 publication requires explicit feature values and an approved lifecycle policy reference; there is no approved production lifecycle policy in this task.
- Rights mutation requires `tenants.write` and `billing.write`; catalog mutation requires `catalog.write`. Tenant principals cannot grant rights.
- Read facts in a coherent DB snapshot. Revision changes and mutations commit together; time and usage changes invalidate previews too.
- No native protocol, offline queue, hardware behavior, production deployment, real-customer assignment, commit, push, PR or cleanup in this authorized implementation scope.
- Test first, preserve dirty work, additive migrations only, own node_modules/dist, never read production credentials or use a production DB.

## File and interface map

New shared modules: `packages/platform-contracts/src/entitlements.ts` (registry, projection and source command schemas) and `catalog-v3.ts` / `tenants-v3.ts` (explicit V3 extensions). Existing legacy/V2 schema objects are not widened.

New persistence module: `packages/db/src/schema/entitlements.ts` owns prepared source records, preview confirmations, lifecycle policy references and shadow observations. Register it in schema exports and Drizzle config. Extend existing plan/add-on storage without rewriting old versions.

New API modules under `apps/api/src/subscriptions/`: `entitlement-projection.ts` for deterministic composition, `entitlement-sources.service.ts` for preview/confirmation/revoke/report, `entitlement-admission.service.ts` for operation evaluation/observation. `EntitlementsService.resolveSnapshot` remains the orchestration entry and delegates only focused deterministic work. New platform controller remains behind platform guards; tenant projection lives at `/access/entitlements`.

UI uses a focused entitlement view in each app, fetching server facts. SaaS source preparation form uses preview then confirmation; customer view contains no internal grant reasons, actor IDs, or financial references.

## Task 1: Registry and strict P1 contracts

**Files:** Create `packages/platform-contracts/src/entitlements.ts`, `catalog-v3.ts`, `tenants-v3.ts`; modify `src/index.ts`; add `test/entitlements.test.ts`, `test/catalog-v3.test.ts` and extend existing nested commercial fixture tests where necessary.

**Interfaces:** Produces `P1_FEATURE_KEYS`, `ENTITLEMENT_FEATURE_KEYS`, `ENTITLEMENT_QUOTA_KEYS`, `ENTITLEMENT_OPERATIONS`, `EntitlementOperationId`, `entitlementSnapshotV1Schema`, `EntitlementSnapshotV1`, `entitlementSourceCommandSchema`, `entitlementSourcePreviewSchema`, `platformCatalogV3Contracts`, `platformTenantV3Contracts`. Expose inferred schema types. Operation definitions contain required modules, class, release/capability identity and version; callers select a registry ID, never supply arbitrary recovery or feature flags.

- [x] Write registry and compatibility assertions before implementing exports:

```ts
expect(ENTITLEMENT_FEATURE_KEYS).toEqual([
  "labelEditor",
  "publicApi",
  "pallets",
  "chzIntegration",
  "inventory",
  "commerceMl",
  "handheld",
]);
expect(ENTITLEMENT_OPERATIONS["nk.lookup.v1"].features).toEqual(["chzIntegration"]);
expect(ENTITLEMENT_OPERATIONS["chz.export.create.v1"].features).toEqual([
  "inventory",
  "chzIntegration",
]);
expect(addonPayloadV3Schema.safeParse({ effects: allElevenUniqueEffects }).success).toBe(true);
expect(addonPayloadV3Schema.safeParse({ effects: duplicateEffects }).success).toBe(false);
expect(planEntitlementsSchema.safeParse(explicitV3Plan).success).toBe(false);
```

- [x] Run `corepack pnpm --filter @markiro/platform-contracts exec vitest run test/entitlements.test.ts test/catalog-v3.test.ts`; record the missing behavior failure.
- [x] Implement constants and schemas. Use stable operation IDs `nk.lookup.v1`, `nk.proposal.v1`, `nk.apply.v1`, `nk.refresh.v1`, `nk.worker.v1`, `chz.export.create.v1`, `chz.export.poll.v1`, `chz.export.receipt.v1`, `inventory.file.create.v1`, `commerceMl.exchange.v1`, `handheld.work.start.v1`, `publicApi.request.v1`. Mark only the first adapter families as covered in P1A; stored reads and continuations have explicit classes. Future regulator submission is absent. Schema bounds derive from the registry, with duplicate effect and operation rejection.

```ts
export const ENTITLEMENT_QUOTA_KEYS = ["lines", "stations", "kiosks", "cabinetUsers"] as const;
// Snapshot: version:1; tenantId; asOf; countedAt; revision; nextChangeAt;
// current:{access, subscription, quotas, features}; candidate:{quotas, features};
// features in candidate are boolean|null (null = mapping required);
// sources:[{id,kind,versionId,startsAt,endsAt,prepared,effects,operationIds}];
// readiness:{mode:'shadow',reasons:string[]}; historical:{available:false};
// connectivity is a separately timed safe observation, never inferred from a license.
```

- [x] Source command schema: kind `temporary|compatibility`, bounded effect list, explicit operation allowlist, start/end, reason, decision reference and request UUID. Compatibility admits only P1 feature effects; temporary end is mandatory and finite. Separate `prepare|revoke` preview intent; confirmation consumes server preview ID and request ID, not mutable effects. Client-safe source shape omits internal metadata; platform shape contains it.
- [x] Add V3 catalog create/patch/read/selector and tenant nested subscription/add-on shapes. V3 reads allow legacy nulls on old versions; new plan create requires four booleans. Include nullable lifecycle policy reference for draft and explicit publication requirements. Old schemas stay frozen; offers/invoices continue their existing historical document shapes unless an explicit V3 extension is necessary for nested new effects.
- [x] Run full contracts test/typecheck/lint/build once and report red/green evidence. Leave changes uncommitted.

## Task 2: Additive persistence and revision invariants

**Files:** Modify `packages/db/src/schema/saas.ts`, schema exports, `drizzle.config.ts`; create `src/schema/entitlements.ts`; generate next SQL/snapshot/journal entries after current 0129; add focused schema/migration/runtime tests under `packages/db/test/`.

**Interfaces:** Produces schema exports `entitlementSources`, `entitlementSourcePreviews`, `entitlementRevisions`, `entitlementLifecyclePolicies`, `entitlementShadowObservations`. Sources have immutable payload and revocation metadata, source version, tenant/subscription scope, creator/reason/decision/request IDs, dates and prepared status. Previews retain payload hash, coherent revision/usage fingerprint, expiry and result ID for exact replay. Revision is a monotonic integer per tenant represented safely on the wire.

- [x] Add failing schema and live migration tests for legacy null preservation, effect enum extension, tenant composite foreign keys, valid date intervals, uniqueness of tenant/request and monotonic revisions across subscription/add-on/source changes.

```ts
expect(legacyPlan.chzIntegrationEnabled).toBeNull();
expect(afterMutation.revision).toBeGreaterThan(beforeMutation.revision);
await expect(insertSource({ tenantId: tenantB, subscriptionId: subscriptionA })).rejects.toThrow();
expect(await countSourceRows(tenantA, requestId)).toBe(1);
```

- [x] Implement nullable new plan feature columns and nullable lifecycle policy ID on catalog versions. Add new enum values and shape checks for four effects. Preserve old plan values and old document snapshots.
- [x] Implement tenant-scoped tables with bounded JSON payload validated at service boundary and DB interval/version checks. Compatibility payload cannot modify old quota/features; service repeats this validation. Store no raw credentials, provider payloads or tokens. Policy rows contain approved status and decision reference; do not seed an approved production policy.
- [x] Keep revision updates in the same transaction using DB triggers on all subscription/add-on/source writers (including billing/provisioning). Maintain a separate usage revision component for lines, station devices, kiosks, membership and invitations, so a transaction that waited for a lock cannot validate an old capacity snapshot. Implement one tenant revision lock order and review its interaction with existing quota/timeline locks. Add explicit trigger migration tests; deletes capture OLD tenant, updates capture affected tenants safely. Policy/release revision is separately bound by the registry/policy identity.
- [x] Generate and review the additive migration; ensure Postgres enum additions are usable before new enum-dependent checks in the migration transaction. Run db build/test/typecheck/lint and apply migrations to an isolated local test database. No shared database rewrite.
- [x] Report migration details, tests and actual schema inspection; leave changes uncommitted.

## Task 3: One coherent resolver, prepared sources and previews

**Files:** Modify `apps/api/src/subscriptions/entitlements.service.ts`, module; create `entitlement-projection.ts`, `entitlement-snapshot-reader.ts` (coherent fact collection and fingerprints), `entitlement-sources.service.ts`; tests `entitlement-projection.test.ts`, `entitlement-sources.e2e.test.ts`, expand subscription resolver tests.

**Interfaces:** Consumes Task 1/2 types. Produces `EntitlementsService.resolveSnapshot(tenantId: string): Promise<EntitlementSnapshotV1>` (current only, server time), internal transaction-aware snapshot method for operation owners, `EntitlementSourcesService.preview(principal, tenantId, command)`, `confirm(principal, tenantId, confirmation)`, `list(principal, tenantId)` and `impact(principal, tenantId)`. Keep all old `resolve/assertWriteAccess/withQuotaSlot` signatures and behavior. Internal V1 integration refinements: explicit `current.writeAllowed`, safe-integer add-on projection contributions while per-unit mutation bounds stay unchanged, deferred actual label-template and pallet-shift operation IDs, and immutable confirmation result `{previewId,requestId,sourceId,confirmedAt,after}`. Stale preview refresh is a new request generation; preserve the editable intent and old proof.

- [x] Test managed/expired/unmanaged and both enforcement modes, overlapping sources, finite/unlimited/zero quotas, quantity, exact time boundaries, operation allowlists, legacy unknowns, prepared/current separation and customer metadata filtering.

```ts
expect(snapshot.current.features).toEqual(before.current.features);
expect(snapshot.candidate.features.chzIntegration).toBe(true);
expect(snapshot.sources.find((s) => s.id === preparedId)?.prepared).toBe(true);
expect(expired.candidate.features.chzIntegration).toBe(false);
expect(legacy.candidate.features.chzIntegration).toBeNull();
```

- [x] Record failing focused tests, then extend the existing resolver using a repeatable-read transaction for current projection. Read subscription, catalog, add-ons, source rows, revision and usage coherently; avoid recursive transactions when handed an owner transaction. Preserve three-feature old responses by explicit projection, not by widening old strict schemas. Historical reads are unavailable rather than current usage with an old timestamp.
- [x] Compose prepared rights only inside the selected effective base interval; source operation scope must be retained in evaluation rather than flattened into a broad module boolean. Return earliest future boundary from subscription/add-on/source transitions. Retain provenance of each contributing source and distinguish prepared source intent from actual current admission.
- [x] Test exact preview→confirmation behavior against local Postgres: changed revision, changed occupied capacity, elapsed effective interval or expired preview fails; exact same confirmation replays result; changed request content conflicts; wrong tenant/platform capability denied; exact actor/tenant/action/target/result audit verified.

```ts
await expect(confirm(stalePreview)).rejects.toMatchObject({
  response: { code: "entitlement_preview_stale" },
});
expect(await confirm(sameRequest)).toEqual(firstConfirmation);
expect(await sourceCount()).toBe(1);
expect(audit).toMatchObject({ tenantId, actorId, action: expectedAction, targetId: sourceId });
```

- [x] Implement preview/confirm/revoke with existing platform capability checks, safe validated IDs, canonical payload digest and transaction ownership. Revoke creates retained revocation fact; immutable source payload is not overwritten. Confirmation must lock using a consistent order before comparing fresh bound facts. Use existing TTL conventions where applicable and document bounded preview expiry as technical validity, not commercial offline policy.
- [x] Read-only impact report returns unmanaged/mapping/policy/client-representation/denial reasons with observation timestamp and explicit scope; never assigns rights. Keep report bounded per tenant in this first API; production multi-tenant inventory execution stays P1D.
- [x] Run focused tests and API typecheck. Record DB evidence and leave changes uncommitted.

## Task 4: Commercial V3 and protected entitlement API

**Files:** Modify `apps/api/src/platform-http/commercial-version.ts`; add `platform-http/commercial-catalog-compatibility.ts` for shared transaction-scoped catalog reference checks; modify commercial controllers, `modules/platform-catalog/*`, `modules/platform-tenants/*`, `authorization/access.controller.ts`; create focused platform entitlement controller/module wiring; update `test/platform-route-contracts.ts`, `test/platform-contract-openapi.test.ts`, `test/subscription-route-inventory.test.ts`, V3 controller/service tests and public OpenAPI generation.

**Interfaces:** Explicit `commercialVersion(request): 1|2|3`; response selection uses distinct schemas and compatibility projection. Tenant `GET /access/entitlements` returns safe V1 snapshot. Platform `GET /platform/tenants/:id/entitlements`, `/entitlements/impact`, `/entitlements/sources`; POST `/entitlements/preview`, `/entitlements/confirm` use Task 3 services and strict Task 1 contracts.

- [x] Test absence, `2`, `3`, invalid and repeated headers. Test old parsers on legacy/V2 payloads and 409 `client_update_required` for nonrepresentable new effects/unsafe old writes, including selectors, tenant/add-on, offers and invoices.

```ts
expect(commercialVersion({ headers: {} })).toBe(1);
expect(commercialVersion({ headers: { "x-markiro-commercial-version": "3" } })).toBe(3);
expect(() => projectCommercialResponse(2, newEffectVersion)).toThrow(
  expect.objectContaining({ response: { code: "client_update_required" } }),
);
```

- [x] Record red tests and replace boolean version branching. V3 equals P0 fields plus explicit P1 conditions, while legacy and V2 still receive their exact compatible shape. Unknown P1 fields cannot be silently stripped from a bought representation. Historical saved document downloads retain bytes and access behavior.
- [x] Extend catalog read/write serialization for nullable legacy new flags and explicit V3 drafts; clone preserves legacy unknowns unless V3 supplies values. Publication under V3 validates all four booleans plus an actually approved policy row, with publication review bound to that identity. V1/V2 cannot mutate/publish unrepresentable V3 terms. No policy approval endpoint or production seed is added.
- [x] Expose source preparation/confirmation/revoke and projections with platform capabilities revalidated at the service boundary. Tenant read requires current cabinet membership, explicit read-only subscription policy and returns only its own safe projection. Platform actor metadata is never returned to tenant caller. Register routes in inventories/OpenAPI with exact response versions.
- [x] Test wrong trust domains/tenants, restricted subscription read, exact audit and nested legacy compatibility. Build dependencies then run focused API/contract tests. Leave changes uncommitted.

## Task 5: Shadow admission at actual CHZ/NK boundaries

**Files:** Create `apps/api/src/subscriptions/entitlement-admission.service.ts`; modify NK lookup/proposal/import/apply/worker services and `modules/chz-exports/chz-export-runner.service.ts`; add `test/entitlement-admission.test.ts`, `test/entitlement-operation-inventory.test.ts` and focused affected service tests.

**Interfaces:** `EntitlementAdmissionService.observe(input)` accepts server-verified tenant/actor, registry operation ID, canonical scope digest and optional owner transaction/fenced attempt. It uses fresh resolver facts, returns `mode:'shadow'`, candidate `allow|deny|unknown`, reason and persisted observation identity. `withAdmission` runs the existing protected action after observation; it does not own business state machines or override the current decision.

- [x] Test module and API-key composition, version-limited NK compatibility not enabling CHZ, saved receipt/known continuation classification, missing mapping, expiry and unknown/error handling.

```ts
expect(evaluate(nkOnlySource, "chz.export.create.v1").decision).toBe("deny");
expect(evaluate(nkOnlySource, "nk.lookup.v1").decision).toBe("allow");
expect(await observe(failingShadowRead)).toMatchObject({ mode: "shadow", decision: "unknown" });
await expect(existingDeniedAction()).rejects.toThrow(existingSecurityError);
```

- [x] Implement registry-based evaluation and persist bounded shadow evidence with tenant/actor/operation/version/revision/asOf/scope hash/attempt/result. Use separately timed release/configuration observation; missing readiness is unknown, never a made-up allow. Unexpected calculation/persistence errors have explicit operational logging without secrets and cannot weaken current checks.
- [x] Add adapters immediately before new NK requests/proposals/apply and worker new side effects, and before fresh CHZ export creation. Preserve actual current guard/service checks, same-intent replay, known provider receipt polling and ambiguous create adoption. No provider HTTP inside a DB transaction. Do not create broad locks or treat unknown provider ID as a retry permit.
- [x] Operation coverage inventory names each concrete callsite plus later P1B/P1C families. Tests inspect the actual registry and callable adapters, not comments alone. Record lock order for modified callers and assert stale fenced worker cannot write a winning observation/result.
- [x] Run affected service tests, admission inventory and DB observation tests. Leave changes uncommitted.

## Task 6: Server-backed admin and customer entitlement views

**Files:** Modify SaaS `src/api/client.ts`, `src/pages/tenants/SubscriptionPanel.tsx`, catalog editor and `src/i18n/{ru,en}.json`; add focused source preparation/projection components beside the panel. Modify customer `src/pages/billing/BillingSubscriptionPage.tsx`, existing API client/i18n and adjacent component tests. Reuse `@markiro/ui` tokens/components.

**Interfaces:** Fetch Task 4 V1 projection separately from old subscription details; use V3 catalog editor/selector schemas only where new terms must be expressed. Prepared source form sends command→preview→confirm and displays server-calculated before/after facts.

- [x] Write component/client tests with a server snapshot deliberately differing from locally summed tariff fields; displayed current quota must equal the server value. Test stale preview retains editable intent and refetches before re-confirm, current/prepared labeling, null mapping state, sources and safe customer payload.

```ts
expect(screen.getByText("17 / 20")).toBeVisible(); // supplied server quota/usage
expect(screen.getByText(t("entitlements.prepared"))).toBeVisible();
expect(screen.queryByText(internalDecisionReference)).not.toBeInTheDocument();
```

- [x] Remove current local entitlement arithmetic from SubscriptionPanel. Show current plan/period, quota usage, seven module states, source intervals, prepared transition status and separately observed connection/release readiness. P1 shadow must never read as an active block.
- [x] Add explicit four feature inputs and lifecycle readiness message to V3 catalog drafts. Show publication unavailable until server-approved policy exists, not a fabricated approval checkbox. Keep Start paid-addon example in fixture/doc only.
- [x] Source preparation UI available only to both required capabilities; read-only viewers have no enabled mutation action. Preview confirms concrete effects/scope/period and marks prepared status. Customer shows only its safe sources, finite remaining quota and translated unavailability reasons.
- [x] Run app package tests/typecheck/lint/build with rebuilt contracts/UI. Inspect actual rendered normal/narrow screens in RU/EN through an isolated local fixture or local browser app, capture artifacts, and document what was exercised. No production login needed.

## Task 7: Integrated acceptance, evidence and final review

**Files:** Update `docs/architecture.md`, scoped entitlement operation inventory/runbook, approved spec status and this plan checkboxes; change CI ownership only if inspection proves a new surface would otherwise be skipped.

**Interfaces:** No new production API. Consumes all previous test evidence and complete worktree diff.

- [x] Reconcile every numbered acceptance criterion in the approved spec to actual code/test/browser evidence and operation inventory. Do not call P1B–P1D implemented. Document migration/recovery order and read-only readiness use; source preparation is not rollout activation.
- [x] Use the isolated test DB and required local test environment; rebuild shared dependencies, then run `corepack pnpm turbo lint typecheck test build --concurrency=1 --force` plus `corepack pnpm format:check`. Record counts and all conditional skips. If a broad unrelated failure occurs, diagnose it and preserve evidence rather than broadening scope or weakening assertions.
- [x] Run `git diff --check` and affected production bundle/OpenAPI contracts. Preserve generated legal artifact bytes. Check final changed-file list excludes credentials, stores and unrelated root work.
- [x] Produce a whole-diff independent review package including untracked new files (no commit required), task ledger and evidence; fix substantive findings and re-run only affected checks before final scoped re-review.
- [x] Final report: behavior/areas changed, automated results, browser evidence, unrun hardware/provider/production checks and reason. Keep branch/worktree and uncommitted changes available for review; await a separate publication request.

Completed 2026-09-11. The single whole-change review found two Important issues; its one
bundled correction and scoped re-review closed both without new findings. The
[acceptance record](../../operations/entitlements-p1a.md#acceptance-evidence) preserves
the original full-run failures, final affected checks, remaining unchanged customer timeout
and external/native limits. Completion of this development plan does not establish a green
whole-workspace run or authorize publication, activation or P1B–P1D.
