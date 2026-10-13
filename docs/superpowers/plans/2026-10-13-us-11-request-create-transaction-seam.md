# US-11 Request creation transaction seam implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Capture service-created Request and original receipt/deadline atomically
with later guarded dataset preparation.

**Spec:** `docs/superpowers/specs/2026-10-13-us-11-request-create-transaction-seam-design.md`.

## Constraints

- Await accepted owned Plan review; one implementer and independent review.
- Existing isolated US checkout; no release/schema/recipe/HTTP/UI/dependency edits.
- Preserve public retries/isolation/mappings/audits, old assertions and budgets.
- Caller owns native transaction/retry; no nested transaction/outside audit.
- Actual owned US child only, DATABASE_URL unset, normal disposal/absence.
- No implementer commit/push/nested agents or premature public progress claim.

### Task 1: Shared native creation and regression proof

**Files:** modify `apps/api/src/modules/traceability/requests/us-request-store.ts`;
create `apps/api/test/us-request-create-transaction.e2e.test.ts`; append the two
US progress docs only after independent review.

Expose `createCommandInTransaction(tx, tenantId, actorUserId, input,
httpRequestId = null): Promise<UsRequestRow>` with the existing native tx type.

- [ ] Current CRUD/authorization/deadline/audit inspection and meaningful native
      absent-method RED before production changes.
- [ ] Shared authorization/create body preserving the public wrapper exactly.
- [ ] Native exact commit/deadline/audit, forced rollback, tenant/role/profile/
      forged-state denials, duplicate/SQLSTATE one-attempt propagation,
      concurrency and exact public losing-request audit.
- [ ] Unchanged Request consumers, API types/full lint/build, formatting/diff;
      no broad no-DB run as substitute for native coverage.
- [ ] Exact RED/GREEN/counts/skips/owned cleanup/self-review report, independent
      review and final source review before downstream integration.
