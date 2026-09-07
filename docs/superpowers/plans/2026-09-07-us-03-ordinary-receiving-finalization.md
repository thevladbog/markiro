# Ordinary Receiving Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finalize saved ordinary Receiving drafts atomically and expose their frozen history in the isolated US workspace.

**Architecture:** Shared strict contracts distinguish drafts from frozen events. A repeatable-read transaction reloads QA authorization, locks the saved draft and references, rechecks its digest, creates/links lots and commits frozen data, source latches, audit and durable replay together. The existing browser gains confirmation and read-only history.

**Tech Stack:** TypeScript, Zod, NestJS, Drizzle/PostgreSQL, React/Vite, Vitest, local Chromium.

**Spec:** [Approved detailed design](../specs/2026-09-07-us-03-ordinary-receiving-finalization-design.md).

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`. Preserve dirty baseline. No commit, staging, push, PR, merge, release, cloud operation or base-database migration.
- Exempt-supplier receiving remains the next P0 increment. Any exempt-supplier line blocks this transition; no automatic exemption decision or TLC assignment is introduced here.
- Require current `traceability.qa.manage`, including on successful-result replay.
- TLCs, quantities, dates and document numbers are not translated, regenerated or silently repaired.
- Warnings remain non-blocking and need no acknowledgement.
- Already locked lots are unchanged. Never clear or replace a source latch, including in later lifecycle work.
- Add a new migration; do not rewrite migration 0121 or prior source-lock migrations.
- The primary API/admin, deployment entry gates and operational workflow locks remain unchanged. Any CI extension is check-only.
- Use existing Markiro tokens/components, EN/ES only. Never read or edit `.pen` files through the filesystem.
- Node 24 and pnpm 11.22.0 already exist. Use `env -u DATABASE_URL PATH=/opt/homebrew/opt/node@24/bin:$PATH node /Users/thevladbog/.cache/node/corepack/v1/pnpm/11.22.0/bin/pnpm.cjs` in place of `pnpm` below. Do not load primary environment files.
- Database tests use only `US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev` and the existing disposable fixture. Request sandbox loopback permission when necessary; never fall back to shared/production data.
- Test first. Store red/green evidence in the task report; inspect final diffs. Keep reports and task baselines in this plan's ignored SDD workspace, because no commits are authorized.
- Owner-approved URL boundary (2026-09-07): server validators and locked snapshot construction own full URL/IDNA semantics; SQL owns text shape/presence/length, exact reference matching and other structural/relational invariants. Remove the approximate SQL URL parser. Strict frozen readers remain unchanged; privileged direct-SQL corruption can still fail closed at read. No new SQL runtime or narrower set of valid international URLs.

## File boundaries and sequencing

Task 1 owns frozen contracts and readiness parity; Task 2 owns database/API transaction and reads; Task 3 owns browser/proxy and end-to-end evidence. Run implementations sequentially. Review each completed task before its dependent task. Controller work during implementation is read-only verification preparation and documentation, not overlapping code edits.

### Task 1: Frozen contracts and readiness parity

**Files:**

- Create `packages/platform-contracts/src/traceability/receiving-finalization.ts` and `packages/platform-contracts/test/us-receiving-finalization.test.ts`.
- Modify `packages/platform-contracts/src/index.ts`; reuse `receiving-records.ts`, `products.ts`, `documents.ts`, `event-values.ts`, `lots.ts` primitives without weakening draft contracts.
- Modify `packages/domain/src/traceability/receiving-readiness.ts`, `packages/domain/test/us-receiving-readiness.test.ts`, `apps/api/src/modules/traceability/receiving/us-receiving-readiness.ts`, and readiness fixtures/copy where the version/detail vocabulary is consumed.

**Interfaces:**

- Consume `ReceivingDraftRecord`, existing snapshot builders and strict reference-document/product snapshot schemas.
- Produce `finalizeReceivingSchema` / `FinalizeReceivingInput` with `operationKey`, `expectedDraftVersion`, `expectedInputDigest`.
- Produce `receivingFinalizationSnapshotSchema` / `ReceivingFinalizationSnapshot`, `receivingFinalizedRecordSchema` / `ReceivingFinalizedRecord`, `receivingRecordSchema` / `ReceivingRecord`, `listReceivingRecordsQuerySchema`, `receivingRecordSummarySchema`, `receivingRecordListSchema` and inferred corresponding types.
- Snapshot version 1: saved header fields (dateReceived, locationId, previousSourceLocationId, receivedAtNote, notes), profileCode, baselineVersion, locationDescription, previousSourceDescription, ordered `items`, ordered `documents`, `confirmation` containing ruleVersion/inputDigest/warnings. Each item contains lineNo/productId/lotId/lotLinkMode/tlc/source/quantity/unitOfMeasure/supplierLotReference/notes, productDescription, coverage and sourceDescription. Document entry is `{ document: ReferenceDocumentSnapshot, issuer: { id, name, legalName } | null }`. All descriptions are frozen, not live references.
- Final record shares draft metadata except `draft`; status is finalized and adds finalizedAt/finalizedBy/snapshot. Keep revision 1 and the saved draftVersion. Record union preserves the exact draft shape. List summaries use existing summary fields plus draft/finalized status; optional status filter defaults to both by absence.
- Coverage stores coverageStatus/coverageRationale/ftlCategory/ftlSourceUrl/ftlSourceVersion/reviewedBy/reviewedAt. Location snapshot matches `buildLocationDescriptionSnapshot` exactly. Reuse existing validators, but override transforming UUID primitives with lossless UUID reads in frozen schemas.

- [x] Write real contract tests first: strict command bounds and unknown fields, complete frozen specimen with exact `500.000`/TLC/document strings, corrupt source/product/lot/header/document relationships, unknown keys, preserved draft reads, bounded mixed-status summaries and status filter.

```ts
expect(
  finalizeReceivingSchema.safeParse({
    operationKey: "abcdefab-0000-4000-8000-000000000001",
    expectedDraftVersion: 1,
    expectedInputDigest: "a".repeat(64),
    actor: "forged",
  }).success,
).toBe(false);
expect(receivingRecordSchema.parse(savedDraft)).toEqual(savedDraft);
expect(receivingFinalizedRecordSchema.parse(frozen)).toEqual(frozen);
expect(frozen.snapshot.items[0]?.quantity).toBe("500.000");
```

- [x] Run the new test and record the expected missing-export failure, then implement the schemas with strict, lossless parsing and cross-field refinements. Finalized fields are required and non-null where readiness requires them; 1–100 ordered lines, at most 100 unique ordered documents, only ordinary supplier lines, warnings only in confirmation. Validate product description, location description, source identity and coverage against the pinned profile, not merely field types.
- [x] Add a failing readiness test for an invalid supplied GTIN and a passing null GTIN case. Add required `gtin14: string | null` to readiness products, validate through `buildProductSnapshot` or the same GTIN rule, map a typed `gtin` detail, bump to `receiving-readiness-v2`, and update API mapping plus EN/ES detail copy and version fixtures together. Do not introduce a second completeness algorithm.

```ts
const value = input();
value.products[0] = { ...at(value.products, 0), gtin14: "00000000000001" };
expect(assessReceivingReadiness(value).issues).toContainEqual({
  severity: "error",
  group: "lines",
  line: 1,
  field: "product",
  code: "format",
  detail: "gtin",
});
```

- [x] Run focused domain/contracts readiness and finalization tests; full domain/contracts tests, typecheck/lint/build; relevant API readiness and admin copy/type checks. Fix actual regressions and preserve strict old draft schemas.
- [x] Self-review and write the report with red/green commands/output and exact files. No commit. Request task review through the controller.

### Task 2: Additive storage and atomic server command

**Files:**

- Modify `packages/db/src/schema/traceability-receiving.ts`; generate new migration `0122_us_receiving_finalization.sql` and matching metadata through Drizzle, then append reviewed hand-maintained triggers.
- Create `packages/db/test/us-receiving-finalization-migration.e2e.test.ts`; update `packages/db/test/us-receiving-schema.test.ts` and applicable schema/journal assertions.
- Create focused receiving modules `us-receiving-finalization.ts`, `us-receiving-snapshots.ts`, `us-receiving-reference-context.ts` under `apps/api/src/modules/traceability/receiving/`.
- Modify `us-receiving-store.ts`, `us-receiving-persistence.ts`, `us-receiving-readiness.ts`, `apps/api/src/deployment/us-receiving.controller.ts` and only necessary US runtime/OpenAPI wiring.
- Create `apps/api/test/us-receiving-finalization.e2e.test.ts`, extend HTTP tests and the scoped synthetic fixture. Split concurrency tests into `us-receiving-finalization-concurrency.e2e.test.ts` if needed to keep tests focused.

**Interfaces:**

- Consume Task 1 strict contracts. Expose `UsReceivingStore.finalize(tenantId, actorUserId, id, input, requestId): Promise<ReceivingFinalizedRecord>`, `getRecord(...): Promise<ReceivingRecord>` and `listRecords(...): Promise<ReceivingRecordList>` for controller reads. Keep existing draft-only methods for existing tests/internal callers, with explicit finalized lifecycle conflicts.
- Finalize returns HTTP 200 with the finalized record for both first success and exact replay (`@HttpCode(200)`); create-draft retains HTTP 201.
- Shared context loader supplies one sorted raw reference set and mapped domain input for readiness, digest and snapshots. Finalization requests locks; read-only readiness retains repeatable-read behavior and no writes.
- Finalization header columns: finalizedAt/finalizedBy/finalizationSnapshot. PostgreSQL snake_case names. Snapshot is unknown JSON at persistence boundary and parsed with Task 1 schema.

- [x] Add a failing migration test that migrates only through 121, seeds an incomplete draft/children/receipt, applies 122 and compares the original rows exactly. Add raw-write tests for lifecycle metadata, finalized insert denial, immutable header/children/deletion, move between draft/finalized parents, complete links/latches and tenant FK denial. Generate additive schema SQL; do not alter 121. Use `pnpm --filter @markiro/db exec drizzle-kit generate --name us_receiving_finalization`, inspect generated SQL and journal, then add guarded PL/pgSQL triggers implementing the approved parent-lock invariants.

```ts
const afterMigration = await fixture.pool.query(
  "SELECT to_jsonb(e) - ARRAY['finalized_at','finalized_by','finalization_snapshot'] AS event, (SELECT json_agg(r) FROM receiving_operations r WHERE r.event_id=e.id) AS receipts FROM traceability_events e WHERE e.id=$1",
  [draftId],
);
expect(afterMigration.rows).toEqual(beforeMigration.rows);
await expect(
  fixture.pool.query("UPDATE traceability_events SET notes='changed' WHERE id=$1", [finalizedId]),
).rejects.toMatchObject({ code: "23514" });
```

- [x] Add failing store tests for mixed create/link, exact identifiers, source latch/revision behavior, current QA/tenant/MFA denial, stale version/digest, exempt/coverage blockers, audit rollback and replay. Test through real stores and disposable PostgreSQL, not mocked transaction methods.

```ts
const saved = await store.createDraft(tenant, actor, { operationKey: randomUUID(), draft }, "save");
const check = await store.checkReadiness(tenant, actor, saved.id, { expectedDraftVersion: 1 });
const command = {
  operationKey: randomUUID(),
  expectedDraftVersion: 1,
  expectedInputDigest: check.inputDigest,
};
const result = await store.finalize(tenant, actor, saved.id, command, "confirm");
expect(result.status).toBe("finalized");
expect(await store.finalize(tenant, actor, saved.id, command, "retry")).toEqual(result);
const auditCount = await fixture.pool.query(
  "SELECT count(*)::int AS count FROM tenant_audit_events WHERE target_id=$1 AND action='traceability.receiving.finalized'",
  [saved.id],
);
expect(auditCount.rows).toEqual([{ count: 1 }]);
expect(await store.getRecord(tenant, actor, saved.id)).toEqual(result);
```

- [x] Implement the approved transaction order, fresh authorization on each attempt/replay, command digest including event ID, sorted row locks, complete reference/snapshot validation, deterministic lot insertion, permanent source latches and exact audits. Existing newly latched lots increment revision and clear only retry hints; new lots revision 1. No inventory/status side effects. Retry serialization/deadlocks at most three whole transactions; map only known uniqueness conflicts to `receiving_lot_conflict`.
- [x] Add concurrency tests with explicit transaction barriers: simultaneous same/different-key finalization; save versus finalize; create/source correction versus finalization; profile/archive/status change; direct child mutation versus finalization. Test rollback on injected audit failure, matching original replay after live-reference changes, and denied replay after membership revocation. Check exact audit fields and stable lot count/IDs, not only success counts. The first-profile-insert race was reproduced on 2026-09-07: include the new migration's tenant-scoped parent tuple-version pulse for profile insertion/deletion, proving unchanged product values and fresh whole-transaction reassessment.
- [x] Cover the review-reproduced child membership race with field-preserving parent tuple-version pulses for INSERT/UPDATE/DELETE and sorted old/new parents on moves. Add real barrier tests proving the finalizer retries and reassesses, not a stale frozen child set. Enforce SQL frozen-v1 structural/relational acceptance for strict shapes, complete addresses, warning entries and profile-specific document/coverage completeness. Under the owner-approved URL boundary, move malformed URL semantic assertions to authoritative server validation, retain explicit direct-SQL corruption/fail-closed-read evidence and valid international URL controls; do not claim complete SQL URL parity.
- [x] Implement strict frozen reads and mixed-status lists. Preserve old create/save receipt parsing. Route POST finalize (16 KiB) only in isolated controller, update response schemas/OpenAPI and typed 409 findings. Check historical draft replay plus new-save/readiness lifecycle conflicts explicitly. Keep primary composition and proxy closed until Task 3.
- [x] Rebuild DB before API tests. Run full DB test/static/build gates, isolated API receiving/readiness/finalization/HTTP/concurrency tests, API static/build gates and check-only isolation contracts. Any unrelated DB skips must be named; no base migration or host runtime starts.
- [x] Self-review and report red/green evidence/files/limits, with no commit. Controller review is required before browser integration.

### Task 3: Browser confirmation, frozen history and end-to-end proof

**Files:**

- Modify `apps/admin/src/us/client.ts`, `apps/admin/src/us/receiving/view.tsx`, `editor.tsx`, `copy.ts`, `readiness-panel.tsx`, `receiving.css`; create focused `finalization-dialog.tsx` and `finalized-detail.tsx`.
- Modify `apps/admin/src/us/master-data/workspace.tsx` only to pass fresh QA capability and explicit lot navigation into Receiving, preserving the existing access-error/pending deny state and navigation recovery.
- Update only the existing profile-summary EN/ES scope copy in `apps/admin/src/us/app.tsx` to reflect ordinary receiving finalization while keeping exempt and downstream workflows clearly unfinished.
- Modify `apps/admin/vite.us.config.ts`, `tools/us-development/test/browser-entry.test.mjs`, `browser-proxy.smoke.mjs`, `receiving-flow.mjs`.
- Create `apps/admin/test/us-receiving-finalization-client.test.ts` and `us-receiving-finalization.test.tsx`; update existing receiving tests for mixed-status reads.
- Update `docs/us/receiving-browser.md`, `browser-entry.md`, `development-isolation.md`, `requirements-traceability.md`, `implementation-plan.md` with actual evidence. Extend `.github/workflows/us-development.yml` only with check-only new test filenames.

**Interfaces:**

- Client `finalizeReceiving(id, input): Promise<ReceivingFinalizedRecord>` validates request and response event/version; list/get receiving use Task 1 record union. Create/save remain draft contracts.
- Confirm enabled only for current QA + saved complete readiness. Use explicit Save/Check before confirming, not automatic saving. Read-only detail renders `ReceivingFinalizedRecord.snapshot` without fetching current labels.

- [x] Write failing client/UI tests for strict correlation, QA-only action, dialog cancellation, per-unit exact totals, mixed create/link counts, invalidation after edit/recheck, pending-state double-click guard, same-key network retry, reload-before-new-attempt, 401/403/409 behavior and read-only final detail/back navigation.

```ts
await user.click(screen.getByRole("button", { name: "Finalize" }));
expect(screen.getByRole("dialog")).toBeVisible();
await user.click(screen.getByRole("button", { name: "Cancel" }));
expect(api.finalizeReceiving).not.toHaveBeenCalled();
expect(screen.getByLabelText("Quantity")).toHaveValue("500.000");
```

- [x] Implement with existing shared components/tokens and EN/ES copy. No logo/font redesign. Keep confirmation and retry payload in active memory only; no new browser persistence. Clear confirmation after data changes. Final details show actor/time and frozen product/location/document/source labels; lot navigation is explicit and does not replace frozen content with live values. No Amend/Void/Export placeholders.
- [x] Add exact finalize proxy allowlist with no query and strict status-list queries; test extra query/nested path denials. Preserve existing unrelated routes and request limits.
- [x] Extend real local synthetic browser journey: finalize mixed create/link receipt, assert resulting lot IDs/audits/latches, reopen frozen history after reference mutation, check QA/operator differences and retry/conflict flows. Exercise EN/ES light/dark at 1440/1024/390 widths, keyboard focus, horizontal overflow and finding/total visibility; capture representative screenshots and inspect them.
- [x] Run focused then full admin tests/typecheck/lint/build, separate US build, actual proxy smoke and receiving browser journey. Run affected DB/API finalization tests once more after integration, isolation/release-lock contracts, whole-worktree format check and `git diff --check`.
- [x] Update docs with actual results and open P0 scope. Perform independent final scoped review. Leave all code uncommitted/unreleased; report automated and real-browser proof separately from hosted/hardware checks not performed.
