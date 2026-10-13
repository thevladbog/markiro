# US-11 Plan draft transaction seam implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Let the later dataset Plan stage create a service-owned draft and its
receipt atomically, without changing public Plan behavior.

**Architecture:** A shared native draft body and authorization/tenant-lock helper
serve the existing public command and a caller-owned transaction method. The
public command retains its existing transaction/error-audit wrapper.

**Tech Stack:** Node24, existing TypeScript/NestJS/Drizzle service, owned PostgreSQL
fixtures and Vitest.

**Spec:** `docs/superpowers/specs/2026-10-13-us-11-plan-draft-transaction-seam-design.md`.

## Constraints and execution order

- Trace/Readiness source implementation and independent review are accepted.
  This independent Plan service seam may proceed while its full native CI gate
  runs; dataset integration and complete-demo acceptance still require that gate
  to pass without weakened assertions or increased timeouts.
- Existing US worktree only; separate implementer and independent review.
- No receipt, approval, PDF, schema, recipe, HTTP/UI, dependency, CI or release edits.
- Preserve exact public success/conflict/rejection semantics and all old tests.
- Internal caller owns rollback/retry; no nested transaction or outside rejection
  audit while its transaction remains active.
- Owned US test child only; DATABASE_URL unset, normal disposal/absence proof,
  no shared-base or environment edits and no increased budgets.

### Task 1: Shared service seam and native transaction regression

**Files:**

- Modify `apps/api/src/modules/traceability/plans/us-plan-store.ts` minimally.
- Create `apps/api/test/us-plan-draft-transaction.e2e.test.ts`.
- Append measured evidence to the two US progress documents after review.

**Interface:**

```typescript
createDraftCommandInTransaction(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  input: unknown,
  requestId: string,
): Promise<UsPlanDraftView>;
```

- [ ] Inspect existing service, native Receiving transaction precedent and Plan
      tests. Write the real missing-seam transaction test and record meaningful
      RED, not an environment/setup failure.
- [ ] Extract the existing authorization/organization-lock helper and native
      create body. Expose the new method using those helpers. Public create uses
      its existing command wrapper and shared body without duplicate gates.
- [ ] Native tests prove exact committed result/audit, forced rollback of both,
      authorization/profile/input denials, concurrent native winner and mixed
      public/native race. Preserve public losing-request audit behavior.
- [ ] Run unchanged Plan draft suite, relevant consumers, API typecheck/lint/build,
      formatting and diff checks. No timeout/assertion or environment weakening.
- [ ] Self-review and report actual RED/GREEN, counts, skips and owned fixture
      cleanup. Separate independent review is mandatory before the Plan stage.
      No implementer commit/push or nested agents.
