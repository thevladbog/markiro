# Receiving lifecycle transaction implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compose genuine Receiving amendment/save/void in the caller's transaction without changing public behavior.
**Architecture:** One extracted native body per current command family; unchanged retry wrappers, direct store seams, real PostgreSQL rollback/replay coverage.
**Tech Stack:** Node24/Corepack pnpm, TypeScript/Drizzle/Vitest, executable YAML Node tests.
**Spec:** `docs/superpowers/specs/2026-10-08-us-11-receiving-lifecycle-transaction-design.md`.

## Global Constraints

- Only existing `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, `codex/us-mvp`, HEADf06aaef2b923a7ae902c0fabacfd0c4712c127c3; preserve dirty state/index.
- No commit/push/PR/merge/release/cleanup, deps/env/schema/shared-base population or archive/design changes. No special dataset seed, runtime/HTTP/CLI registration.
- Node24/Corepack installed deps; no shared source changes/builds needed. Never build during DB workers. DB only invocation-owned children of `US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev`, DATABASE_URL unset, maxWorkers1.
- Existing recipe/migrations/256KiB bounds, public QA/tenant/parser/replay/lock/error and repeatable-read three-attempt retry policy unchanged. No transaction-to-Db casts, mock services or fabricated success rows.
- Owner waives approval questions; separate implementer/review per task, final most-capable whole review. Capture original dirty bytes rather than commit/cleanup; retain own evidence.
- Controller runs fresh configured gate, static/build after DB drainage, fullAPI once with both DBvars unset, safe Node/checker/format/diff/inventory. Report all failures/skips separately.

## Review Focus

1. Native command escaping supplied transaction: composed abort/real audit or operation failure leaves every table unchanged (Task1).
2. Retryable native SQL error swallowed/retried: exact original SQL cause, one nontransactional sequence attempt; unchanged public three attempts (Task1).
3. Replay bypasses current QA: revoked/foreign actor with hostile input and saved receipt denied before parser/replay, no writes (Task1).
4. Corrected/void history confused with current origin: retained immutable lot identities/history and separately verified current basis after genuine finalization/void (Task1).
5. CI command exists but does not execute, or old range pins drift: fresh parsed-YAML mutation rejection and full actual predecessor preservation; unique explicit selections not aggregate exclusivity (Task2).

## Task 1: Native lifecycle/save seams and real composition

**Files:** Modify only `apps/api/src/modules/traceability/receiving/us-receiving-lifecycle.ts`, `us-receiving-amendment-save.ts`, `us-receiving-store.ts`; create `apps/api/test/us-receiving-lifecycle-transaction.e2e.test.ts`. Existing fixture/policy/operation/reader/finalizer sources frozen.
**Consumes:** `UsMasterDataTransaction`, actual current command bodies, `receivingTransaction`, existing v2 receipt schema, native create/readiness/finalize/live/basis/lot readers.
**Produces:**

```ts
executeReceivingLifecycleInTransaction(tx: UsMasterDataTransaction, tenantId: string,
  actorUserId: string, command: "receiving.amend" | "receiving.void", id: unknown,
  input: unknown, requestId: string): Promise<ReceivingOperationReceiptV2>;
saveReceivingAmendmentInTransaction(tx: UsMasterDataTransaction, tenantId: string,
  actorUserId: string, id: unknown, input: unknown,
  requestId: string): Promise<ReceivingOperationReceiptV2>;
// UsReceivingStore methods have identical arguments after supplied tx:
amendInTransaction(tx, tenantId, actorUserId, id, input, requestId);
voidInTransaction(tx, tenantId, actorUserId, id, input, requestId);
saveAmendmentInTransaction(tx, tenantId, actorUserId, id, input, requestId);
```

- [x] Read source, adjacent tests and scoped guides; write real native composition test before extracting implementation. Minimal nonfunctional callable seam scaffold can make imports resolve for genuine RED; missing-import/collection failures are not RED. Use actual fixture/services, literal expected quantities and IDs from trusted created original, not SQL lifecycle rows.

```ts
const corrected = await f.db.transaction(
  async (tx) => {
    const started = await receiving.amendInTransaction(
      tx,
      tenant,
      actor,
      original.id,
      {
        commandVersion: 2,
        operationKey: amendKey,
        expectedLifecycleVersion: live.lifecycle.lifecycleVersion,
        reason: "Synthetic recount",
      },
      amendKey,
    );
    if (started.record.content.kind !== "draft") throw new Error("Expected amendment draft");
    const draft = receivingAmendmentDraftSchema.parse(started.record.content.draft);
    const first = draft.items[0];
    if (!first) throw new Error("Expected first retained line");
    first.quantity = "300";
    const saved = await receiving.saveAmendmentInTransaction(
      tx,
      tenant,
      actor,
      started.eventId,
      {
        commandVersion: 2,
        operationKey: saveKey,
        expectedLifecycleVersion: started.record.lifecycle.lifecycleVersion,
        expectedDraftVersion: started.record.draftVersion,
        draft,
      },
      saveKey,
    );
    const ready = await receiving.checkRevisionReadinessInTransaction(
      tx,
      tenant,
      actor,
      saved.eventId,
      { expectedDraftVersion: saved.record.draftVersion },
    );
    return receiving.finalizeCommandInTransaction(
      tx,
      tenant,
      actor,
      saved.eventId,
      {
        commandVersion: 2,
        operationKey: finalizeKey,
        expectedDraftVersion: ready.draftVersion,
        expectedLifecycleVersion: ready.expectedLifecycleVersion,
        previousRevisionId: ready.previousRevisionId,
        expectedInputDigest: ready.inputDigest,
        reviewedExemptLines: [],
      },
      finalizeKey,
    );
  },
  { isolationLevel: "repeatable read" },
);
// Assert corrected frozen quantities ["300", literal original second quantity],
// exact retained lot identities, predecessor amended/current revision2 and audits.
```

- [x] Run genuine RED with exact fixture/serial worker, record expected behavior failure and exact child disposition.
- [x] Extract current callback bodies without rewriting logic or duplicating SQL. Public wrapper remains:

```ts
return receivingTransaction(db, (tx) =>
  executeReceivingLifecycleInTransaction(tx, tenantId, actorUserId, command, id, input, requestId),
);
// Save public wrapper analogously delegates to its native body.
// Store native methods delegate to module natives, never this.db.transaction.
```

- [x] Add real native amend/save/void caller-abort coverage and trigger failures at each command's native audit and operation insertion; all198-table snapshot hashes before/after equal. Test-only owned trigger/function/sequence supplies40001 and increments nontransactional attempts. Native must attemptonce and preserve cause; remove owned failpoint then externally retry whole transaction. Public wrapper same failpoint attempts3 with existing exhausted error. All cleanup independent/reverse order, barriers release before actual work drainage. Setup acquisition outcome independently registered; no disposal while timed-out work lives. New phase budget30s, setup60s; existing timers unchanged.
- [x] Test genuine void after finalization (retained two lots/status/TLC/source/locks, null current basis, exact void audit); void after native amendment draft preserves current original. Replay stored amendment/save/void after later lifecycle changes remains exact historical bytes while current live/basis state differs. Same-key replay no writes; changed reason/draft conflict; unchanged save only operation receipt no business/audit timestamp/version mutation. Current QA/tenant denial before malicious getter and on historical replay, stale lifecycle/draft versions, retained product/TLC/source identity rejection and real finalized downstream blocker leave all rows unchanged. Equal public/native operations use allSettled/drain actual workers and preserve one operation/audit; do not claim arbitrary isolation from fresh-read-committed visibility.
- [x] GREEN new suite and existing configured regressions: `us-receiving-lifecycle.e2e.test.ts`, `us-receiving-lifecycle-concurrency.e2e.test.ts`, `us-receiving-lifecycle-compatibility.e2e.test.ts`, `us-receiving-amendment-save.e2e.test.ts`, `us-receiving-amendment-save-concurrency.e2e.test.ts`, `us-receiving-revision-finalization.e2e.test.ts`, `us-receiving-revision-finalization-concurrency.e2e.test.ts`, `us-current-consumers.e2e.test.ts`, `us-receiving-transaction-seams.e2e.test.ts`. Zero configured skips; actual fixture child absent/backends drained. Scoped lint/format/typecheck after DB drain, report original RED/errors + all final results, freeze four paths for independent Spec+Quality review. No commit/fullAPI by worker.

## Task 2: Dedicated CI ownership and factual docs

**Files:** Modify `.github/workflows/us-development.yml`, `tools/us-development/test/isolation.test.mjs`, `tools/us-development/test/dataset-regular-ownership.test.mjs`, `docs/us/development-isolation.md`, `docs/us/implementation-plan.md`; create `tools/us-development/test/receiving-lifecycle-ownership.test.mjs`.
**Consumes:** Accepted frozen Task1 suite; **produces:** one dedicated owner:

```yaml
- name: Verify Receiving lifecycle transaction foundation on disposable databases
  env:
    US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
  run: corepack pnpm --filter @markiro/api exec vitest run test/us-receiving-lifecycle-transaction.e2e.test.ts --maxWorkers=1
```

- [x] Capture actual complete predecessor bytes and steps/workflow AST/hash before editing. Add executable absent-owner RED in new Node file, then exact owner after domain/API builds. Old isolation file ONLY adds this owner's exclusions to existing preservation filters; preceding regular ownership file ONLY adds this owner's exclusion in its prior-steps preservation. Never change existing hash literals or old owner commands. New test owns all new assertions/mutations.
- [x] Require one dedicated owner/exact globally unique explicit selection, unconditional/direct executable command, fixture-only env and no DATABASE_URL at any US scope, serialworker, ordered unconditional success-propagating builds. Reject aliases/quotedduplicates/split/echo/comments/condition/exit suppression/redirect/background/shell override, wrong/missing/inherited fixture, missing/reordered/conditional/ignored builds and predecessor settings/budget/permissions/services drift through freshparsedYAML mutations and intended AssertionError/messages. Remove only newowner and assert fullpredecessor bytes/AST; preserve all prior pins/30min/releases. Aggregate API collection remains permitted, not total-execution exclusivity.
- [x] Append truthful native composition/public-parity/rollback/replay evidence and open specialseed/fullvolume/artifact/runtime/hosting gates to two docs. Preserve older chronology; no private motive or invented green union. FullAPI and finalreview owned by controller, still pending until observed.
- [x] Once final safe `node --test tools/us-development/test/*.test.mjs`, checker, scoped Node lint/six-file format/diff allpass, report actualmutations/preservation/hashes then freeze sixpaths for independent Spec+Quality review. No DB/API/build/commit by Task2.

## Controller finish

- [x] Fresh exact configured native gate after final source; static/typecheck/lint/build after DB drain; fullAPI once both DBvarsunset with loopback permission, retain all failures/skips; safeNode/checker/repositoryformat/diff/source inventory and one most-capable whole review.
- [x] No publication/cleanup. Exhaustively report controller rulings/costs and next special-example seed scope; no full-demo completion claim.
