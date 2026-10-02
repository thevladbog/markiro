# US-08 Server Configuration and Drafts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute each task with a separate implementer and independent reviewer. Do not start the next task until primary acceptance of the review.

**Goal:** Make US Traceability Plan configuration readable and drafts editable through a tenant-safe internal API service, without approval, PDF publication, HTTP routes or UI.

**Architecture:** `UsPlanStore` is a US-only store, constructed only by the US deployment in a later HTTP stage. Every operation obtains tenant and actor from its server caller, reloads membership and the processor profile inside a transaction, and scopes every row by tenant. A configuration reader captures current persisted facts in one consistent transaction; draft commands store typed sections and revisioned changes, never a client-provided snapshot or demo flag. An explicit, deterministic fact-source manifest is prepared for the later approval snapshot, while human confirmation actor/time and trusted synthetic identity are frozen only by the approval stage.

**Tech Stack:** NestJS service conventions, Drizzle/PostgreSQL, `@markiro/domain`, `@markiro/platform-contracts`, Vitest, isolated `US_TEST_DATABASE_URL` database fixture.

**Spec:** `docs/superpowers/specs/2026-10-02-us-08-traceability-plan-current-design.md`. Follows `docs/superpowers/plans/2026-10-02-us-08-plan-rules-contracts.md` and `docs/superpowers/plans/2026-10-02-us-08-plan-storage-foundation.md`.

## Global Constraints

- Work in the existing isolated `codex/us-mvp` worktree. Keep RU modules/routes, Station, production workflows and shared databases untouched. This plan does not authorize a release, deployment, PR or merge.
- Read `apps/api/AGENTS.md` before API edits. Follow `authorizeUsMasterData` for current membership/capability checks; the service must still explicitly require `US_FSMA204_PROCESSOR`. Use `traceability.qa.manage` for mutations and `traceability.read` for reads. A caller-provided tenant, actor or synthetic marker is never a fact.
- Use only an exact loopback `US_TEST_DATABASE_URL` and `createUsProfileTestDatabase` for integration tests. Report absent infrastructure as a skip; never fall back to `DATABASE_URL` or a shared database.
- Drafts may be incomplete, but `sections` must pass the strict structural schema. Draft save does not invoke approval validation or claim regulatory readiness. All strings remain plain text and retain their original bytes.
- This stage writes no `config_snapshot`, digest, approver, PDF metadata, confirmation or artifact. The approval stage must capture server time and actor, re-read configuration, validate, render, publish and atomically commit a frozen version.
- No tenant-visible classification as synthetic is made from a slug, metadata field or client claim alone. The approval stage must verify exact trusted seed identity in the server runtime before applying demo provenance; all other tenants are operational.
- Audit successful create/save/discard and relevant rejected mutations with exact tenant, actor, target, action, outcome, revision and request ID. Do not put contact/procedure text or secrets in diagnostic logs.

## Review Focus

1. The configuration reader includes only this tenant's organization/profile, active TLC-source locations and persisted product coverage rows; records are sorted deterministically, and changing an individual description/revision changes the digest.
2. A nonmember, revoked/insufficient role, generic/RU profile or wrong-tenant version ID cannot read or mutate a plan. Wrong-tenant IDs return the same 404 shape as missing IDs.
3. Two concurrent draft creates cannot create duplicate drafts or version numbers. A stale `expectedRevision` cannot overwrite a newer save; unchanged retries cannot invent an audit event.
4. Discard removes only a draft. Effective/superseded rows, their snapshots, PDF references and audit evidence remain untouched.
5. Draft creation, save and discard have exact audit metadata. A transaction rollback cannot leave a success audit row. A rejected request has no successful mutation audit.
6. The fact-source manifest covers each captured scalar/list item and each plan section field. The supported FTL-review descriptor is separately labelled as versioned application policy, not evidence of an operational tenant procedure.

---

### Task 1: Consistent current-configuration reader

**Files:**

- Create `apps/api/src/modules/traceability/plans/us-plan-configuration.ts`.
- Create `apps/api/test/us-plan-configuration.e2e.test.ts`.
- Modify `packages/domain/src/traceability/plan/snapshot.ts` and its test: replace the earlier opaque location-description string with typed structured persisted description fields. This preserves incomplete draft master data and avoids a premature PDF text format.
- Add the focused DB test to the guarded US-only job in `.github/workflows/us-development.yml`; do not introduce a release capability.

**Interface:** An internal `readUsPlanConfiguration(tx, tenantId)` returns `UsPlanConfiguredFacts` plus a stable digest. The caller has already authorized membership and profile inside a `REPEATABLE READ` transaction, so the several configuration queries observe one database snapshot. It reads `organization.name`, `traceabilityProfiles` and `orgProfiles`, active `traceabilityLocations` with `tlc_source` role, and current `productTraceabilityProfiles` for that tenant. Each location fact retains its ID and typed persisted description fields, including nullable fields permitted by master data; an incomplete active location remains visible in a draft but will fail approval validation later. Include actual profile `productId`, `revision` and `coverageStatus`, not an aggregate count. Sort by stable IDs and use the existing `canonicalExportDigest` on those normalized values. Do not infer backup practice or a product-review cadence from settings.

- [ ] **Red:** Write an isolated database test with two tenants, distinct locations and product profiles. Assert exact fields, current tenant only, deterministic order/digest, archived location exclusion, incomplete active location visibility, and digest changes after a single address/phone or profile-revision update. Confirm the test fails for a missing reader.
- [ ] **Green:** Implement one consistent read transaction, explicit tenant predicates for every query, and the smallest typed mapper. Avoid joins that duplicate rows or weaken tenant scope. Keep no cached mutable configuration.
- [ ] **Verify:** Run the focused test with the disposable database, `@markiro/api` typecheck/lint, and `@markiro/domain` tests if its helper contract changes. Review the query plan only if this small read becomes unbounded; do not add speculative indexes.
- [ ] **Independent review:** Check tenant predicates, role filtering, source-description fidelity, digest ordering and absence of operational claims.

### Task 2: Fact-source manifest and draft view model

**Files:**

- Modify `packages/domain/src/traceability/plan/snapshot.ts` and `packages/domain/src/index.ts` only if a pure helper/type is needed.
- Create or extend `packages/domain/test/us-plan-snapshot.test.ts`.
- Create `apps/api/src/modules/traceability/plans/us-plan-model.ts` for DB-row parsing and internal responses; create `apps/api/test/us-plan-model.test.ts` if parsing has behavior.

**Interface:** Define an explicit path-indexed provenance manifest for the future frozen snapshot. Paths must cover configured scalar facts, every TLC-source location and product-profile item by stable ID, and each operator-owned section field (including ordered list items by frozen index). Configured fields receive `configured`; real plan statements receive `operator_confirmed` only when approval later records actor and time; synthetic plan statements receive `synthetic_fixture` only after trusted-seed verification. The versioned `ftlReviewWorkflow` remains an application-policy descriptor with its own origin label, not a fictional tenant fact. The manifest is deterministic and rejects missing or duplicate paths. A draft view labels statement ownership as pending, never as confirmed.

- [ ] **Red:** Test that reordering configured arrays leaves the manifest/digest unchanged; removing a required path, duplicating an ID, or pretending the code-owned workflow is an operator confirmation fails. Confirm red before the helper exists. Test that draft DB JSON is parsed through `usPlanSectionsSchema`, and malformed stored JSON is not returned as a valid plan.
- [ ] **Green:** Add the narrow pure manifest builder and typed row parser. Keep the existing `UsPlanSnapshot` v1 compatible until the approval-stage schema version is decided; do not silently stamp unconfirmed draft text as approved provenance.
- [ ] **Verify:** Run focused and full `@markiro/domain` tests/typecheck/lint/build, then rebuild `@markiro/platform-contracts` and run affected contract tests. Run focused API model tests.
- [ ] **Independent review:** Check exhaustive paths, no ambiguous array-index provenance, no unearned actor/time, and no code-owned workflow misclassification.

### Task 3: Draft create, list/read, save and discard commands

**Files:**

- Create `apps/api/src/modules/traceability/plans/us-plan-store.ts` and, if needed to keep it focused, `us-plan-draft-commands.ts`.
- Create `apps/api/test/us-plan-store.e2e.test.ts`.
- Extend `packages/platform-contracts/src/traceability/plans.ts` and its focused test with strict create (`sections`, `changeSummary`) and discard (`expectedRevision`) bodies; keep tenant, actor and synthetic fields prohibited.
- Add the new plan-store e2e test to the guarded check-only US CI step; preserve the existing release lock.

**Interface:** Internal methods `listVersions`, `getVersion`, `createDraft`, `saveDraft`, `discardDraft` accept server-resolved `(tenantId, actorUserId, requestId)` plus strict plan input/ID. No controller is registered yet. For mutations, authorize `US_CAPABILITY.QA_MANAGE` in the transaction; reads require `READ`. Read results expose validated full draft content only for `draft`; effective/superseded rows are metadata-only until the approval/detail stage can validate their frozen snapshots and artifact evidence. Serialize version allocation and first-draft creation on the tenant's organization row, then rely on existing `(tenant_id, version_number)` and one-draft indexes as final guards. `createDraft` accepts typed sections and change summary, allocates `max(version_number)+1`, initially revision 1; an existing draft conflicts rather than being overwritten. `saveDraft` checks `expectedRevision`, updates only `sections`, `changeSummary`, revision and `updatedAt`, with an explicit no-op path. `discardDraft` takes a revision precondition and deletes only that draft. Every lookup uses `(tenantId,id)`; malformed IDs are rejected before Drizzle.

- [ ] **Red:** Add integration cases for v1 and v2 allocation, one-draft enforcement under two concurrent transactions, stale and concurrent saves, no-op save, cross-tenant IDs, forbidden roles, unsupported profile, malformed JSON and malformed UUID, draft-only discard, exact success audit, exact conflict audit for known business rejections, and absence of committed success audit after rollback. Watch focused tests fail against the missing store.
- [ ] **Green:** Implement the smallest store using strict create/save/discard schemas, existing `parseMasterDataInput`, tenant-scoped row locks and explicit audit actions (`traceability.plan.draft_created`, `traceability.plan.draft_updated`, `traceability.plan.draft_discarded`). Known rejected commands are audited in a separate bounded transaction after the failed mutation transaction rolls back, with outcome and code but no section text. Infrastructure errors propagate for retry rather than being relabelled as user conflicts. Use stable conflict/not-found codes. Do not add approval, preview, download, cleanup of artifact objects or HTTP wiring.
- [ ] **Verify:** Build `@markiro/db`, `@markiro/domain` and `@markiro/platform-contracts` before API tests. Run focused e2e with `US_TEST_DATABASE_URL`, then `@markiro/api` test/typecheck/lint/build, `git diff --check`, scoped Prettier and `node tools/us-development/check-isolation.mjs`. Record intentional database skips separately. Run `graphify update .` only if this worktree has a local graph.
- [ ] **Independent review:** Inspect tenant and actor trust boundaries, lock order, version/revision behavior, audit contents, exception mapping and exact absence of approval/PDF/route code. Resolve findings before primary acceptance.

## Handoff

Only after all three tasks and reviews are accepted, plan the next US-08 slice separately: deterministic English draft preview and PDF renderer, private non-RF US artifact adapter, trusted synthetic identity verification, actor/time-stamped real confirmations, exhaustive frozen provenance, idempotent atomic approval and supersession retention. That slice must recheck configuration digest and draft revision after rendering/upload; this draft stage does not make a plan effective. HTTP/UI and real storage/backup verification remain later independent gates.
