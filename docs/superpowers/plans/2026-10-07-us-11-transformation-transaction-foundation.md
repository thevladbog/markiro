# US-11 Transformation Transaction Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compose native Transformation creation, readiness, finalization and reads in a caller-owned transaction without changing public behavior.

**Architecture:** Extract existing command bodies, preserving their validators, authorization, operations, snapshot and audit writers. Public wrappers retain repeatable-read isolation and bounded retries; native methods neither open nor retry transactions. This is a prerequisite, not the dataset Transformation generator.

**Tech Stack:** Node 24+, repository-declared Corepack pnpm, strict TypeScript, Drizzle/PostgreSQL and Vitest.

**Spec:** `docs/superpowers/specs/2026-10-07-us-11-transformation-transaction-foundation-design.md`

Status: owner approved and the scoped increment independently accepted on 2026-10-07. All three tasks and whole-increment review are complete; the step checklists below retain the original execution instructions. Evidence and exact gate outcomes are in `.superpowers/sdd/2026-10-07-us-11-transformation-transaction-foundation/final-report.md`. Full API remains nongreen; no integration, push or release is authorized or claimed.

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`; preserve accepted/unrelated dirty work and an empty index.
- No stage, commit, push, PR, release, deployment, runtime/CLI registration, environment/dependency changes, migrations, Station, scanning, printing, archive or design-file edits.
- Keep `us-processor-six-month-v1`, April through September 2026, `America/Los_Angeles`, Scenario A, migrations0141/0142 and 256 KiB journal bounds unchanged.
- No dataset codec/orchestrator/verifier, Cases, Shipping, correction/orphan stages, Plan/Requests artifacts, full-volume seed or viewer provisioning in this plan.
- Use only fixture-owned random US PostgreSQL children. Keep `DATABASE_URL` unset; never load primary env or populate/reset the shared base.
- Native commands reauthorize before input parsing/replay, retain commandVersion1 digests and propagate driver failures without inner retry. Public wrappers retain their existing three-attempt repeatable-read behavior and errors.
- Caller-owned repeatable read or an explicit sufficient lock protocol is required for multi-query consistency. Do not certify arbitrary read-committed callers or invent an upstream-root lock after lot locks.
- Run DB suites serially and finish/drain fixtures before rebuilding shared/API output. Preserve test timeouts/assertions and the unresolved full API gate.
- Save baseline/source-byte checkpoints and scoped evidence instead of commits. Report local, remote CI, browser/provider and hosted acceptance separately.

## Review Focus

1. Revoked actor retrying an old operation: current authorization must reject before historical replay (Task1/2).
2. A changed replay input or forged operation result: retain conflict/fail-closed behavior without writes (Task1/2).
3. Cancellation/failure before a worker readiness barrier: cleanup must release and drain owned transactions before fixture disposal/reset (Task2).
4. Unique collision vs unrelated database error: only three named lot constraints map to `transformation_lot_conflict`; other driver errors propagate natively (Task2).
5. Input origin changed while locks are awaited: finalization must revalidate or fail, not publish a stale origin; no deadlock-prone upstream-root acquisition (Task2).

## File map and execution environment

Modify only these production files:

- `apps/api/src/modules/traceability/transformation/us-transformation-draft.ts`: extract creation body; leave save semantics intact.
- `apps/api/src/modules/traceability/transformation/us-transformation-finalization.ts`: extract native finalization; preserve public error mapper.
- `apps/api/src/modules/traceability/transformation/us-transformation-store.ts`: native facade and authorized readers; public delegation.

Create:

- `apps/api/test/us-transformation-transaction-seams.e2e.test.ts`: composition, rollback, authorization/replay and driver behavior.
- `apps/api/test/us-transformation-transaction-locks.e2e.test.ts`: actual public-writer contention and cancellation cleanup.

Modify in Task3 only:

- `.github/workflows/us-development.yml`
- `tools/us-development/test/isolation.test.mjs`
- `docs/us/development-isolation.md`
- `docs/us/implementation-plan.md`

Reuse `createUsDatasetJournalFixture`, `seedFinalizableTransformation`, `transformationEffects`, document/Receiving native methods and current PostgreSQL contention patterns. Do not edit shared fixture helpers merely for convenience. Read root AGENTS, API scoped guide and isolation documentation before task work.

All commands run at the US worktree root. Set the task process PATH to:

```sh
export PATH=/opt/homebrew/opt/node@24/lib/node_modules/corepack/shims:/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin
unset DATABASE_URL
export US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
```

The URL permits only child fixture creation/disposal, not base mutation. Sandbox loopback denial is an infrastructure failure, not an expected feature RED.

---

### Task 1: Native creation and authorized readers

**Files:** Modify draft/store files; create the seams test file.

**Interfaces:**

- Consume `UsMasterDataTransaction`, existing create schema/digest/operation writer, `readTransformationDraft`, `readTransformationRecord` and `readTransformationReadiness`.
- Export `createTransformationDraftInTransaction(tx, tenantId, actorUserId, input, requestId): Promise<TransformationDraftRecord>` from the draft module.
- Add `UsTransformationStore.createDraftInTransaction` with the same arguments/return type.
- Add `checkReadinessInTransaction(tx, tenantId, actorUserId, eventId: unknown, input: unknown): Promise<TransformationReadiness>`.
- Add `getRecordInTransaction(tx, tenantId, actorUserId, eventId: unknown): Promise<Awaited<ReturnType<typeof readTransformationRecord>>>`.
- Retain existing public signatures and export types from the existing contracts; no new shared contract is needed.

- [ ] Create an owned fixture with `createUsDatasetJournalFixture(base)` and seed input origins through `seedFinalizableTransformation(f)`. Capture `f.snapshot()` before each tested native transaction. That existing helper creates a separate public draft; it is baseline data, not evidence that the new native creation ran.
- [ ] Write the first failing composition test, using existing fixture data and a different operation key:

```ts
const c = await seedFinalizableTransformation(f);
const before = await f.snapshot();
await expect(
  f.db.transaction(
    async (tx) => {
      const created = await c.store.createDraftInTransaction(
        tx,
        c.tenant,
        c.actor,
        { operationKey: randomUUID(), draft: c.saved.draft },
        "native-create",
      );
      expect(await c.store.getRecordInTransaction(tx, c.tenant, c.actor, created.id)).toEqual(
        created,
      );
      const ready = await c.store.checkReadinessInTransaction(tx, c.tenant, c.actor, created.id, {
        expectedDraftVersion: 1,
      });
      expect(ready.state).toBe("complete");
      throw new Error("caller_abort");
    },
    { isolationLevel: "repeatable read" },
  ),
).rejects.toThrow("caller_abort");
expect(await f.snapshot()).toEqual(before);
```

- [ ] Run `corepack pnpm --filter @markiro/api exec vitest run test/us-transformation-transaction-seams.e2e.test.ts --maxWorkers=1`; record RED due to the missing native method, not fixture/setup failure.
- [ ] Move the existing create callback body unchanged into the exported native function. Keep public creation as:

```ts
return transformationTransaction(db, (tx) =>
  createTransformationDraftInTransaction(tx, tenantId, actorUserId, input, requestId),
);
```

- [ ] Extract the store's existing authorized record/readiness callbacks into native facade methods. Preserve READ authorization, UUID/query validation, version conflict and existing reader calls; public methods delegate through `transformationTransaction`.
- [ ] Add native successful commit, identical creation replay, changed-key-content conflict, corrupt saved response, capability revocation before malformed input/replay and foreign tenant/event/reference tests. Compare exact full snapshots for denied/no-write paths, and exact original operation digest/result/audit fields for commit/replay.
- [ ] Run the seams file and existing draft/readiness/HTTP files serially. Run API typecheck/scoped lint/format/diff checks with fixtures closed. Save source-byte delta and results, then obtain independent task review. No commit.

### Task 2: Native finalization, rollback and lock evidence

**Files:** Modify finalization/store; extend seams; create locks suite. No changes to reference context, lifecycle or retry classification are authorized by default.

**Interfaces:**

- Consume Task1 native creation/readiness/read methods and existing `prepareTransformationRevision`, locked finalization context, snapshot builder and operation writer.
- Export `finalizeTransformationInTransaction(tx, tenantId, actorUserId, id: unknown, input: unknown, requestId): Promise<TransformationFinalizedRecord>`.
- Add `UsTransformationStore.finalizeInTransaction` with that signature.
- Native finalization propagates driver/constraint failures; public `finalizeTransformation` retains its outer three-constraint mapper around `transformationTransaction`.

- [ ] Write a native finalization RED test using the existing finalizable fixture:

```ts
const c = await seedFinalizableTransformation(f);
const before = await f.snapshot();
await expect(
  f.db.transaction(
    async (tx) => {
      const finalized = await c.store.finalizeInTransaction(
        tx,
        c.tenant,
        c.actor,
        c.saved.id,
        c.command,
        "native-finalize",
      );
      expect(finalized.status).toBe("finalized");
      expect(finalized.snapshot.outputs).toHaveLength(1);
      expect(finalized.snapshot.inputs).toHaveLength(2);
      throw new Error("caller_abort_after_finalize");
    },
    { isolationLevel: "repeatable read" },
  ),
).rejects.toThrow("caller_abort_after_finalize");
expect(await f.snapshot()).toEqual(before);
```

- [ ] Run seams serially and record the missing-method RED. Extract the existing transaction callback into the native function, without changing authorization, digest/replay, root/lot lock order, snapshot, dependencies, genealogy, source locks, counters or audits. Keep the public call and error mapper as:

```ts
return await transformationTransaction(db, (tx) =>
  finalizeTransformationInTransaction(tx, tenantId, actorUserId, id, input, requestId),
);
```

- [ ] Add an end-to-end native transaction: create Transformation documents through `UsReferenceDocumentStore.createDocumentInTransaction`, clone the fixture's saved draft with those real document IDs and a distinct output TLC, create it natively, read readiness, finalize with its actual digest, then read the record. Resolve the document issuer from the same tenant's existing processor location/party; do not guess a party ID. Assert 500 lb + 500 lb → 100 case frozen lines, one output lot/source lock, two exact edges, operation responses and exact service audits. Throw after success and compare the full pre-transaction snapshot.
- [ ] Add database-local failure triggers on exact invocation-owned rows at output-lot insert, genealogy insert, finalized audit insert and operation insert. Always remove triggers in `finally`, preserving the original failure. Each failure must leave all prior state unchanged, including input dependency/source-lock fields; a fresh external retry with unchanged command succeeds. No production hooks or global triggers.
- [ ] Inject `RAISE EXCEPTION USING ERRCODE = '40001'` and `'40P01'` in owned triggers and assert native driver codes through their actual cause chains. Record callback attempt count of one; test public retries/exhaustion separately through existing wrapper behavior. Do not label these injected cases naturally occurring deadlocks.
- [ ] Test exact historical replay after lifecycle changes, changed input digest, forged stored result, current capability revocation and cross-tenant finalization denial. For all three named lot uniqueness constraints preserve public `transformation_lot_conflict`; unrelated failures are not mapped to that code.
- [ ] Before writing locks tests, document the actual writer map in task evidence: Transformation root/header → affected lots → product/profile → party/location/document; Receiving and upstream Transformation lifecycle → lots/dependency writes. Inspect `us-receiving-lifecycle.ts`, `us-receiving-revision-finalization.ts`, `us-current-consumers.ts`, Transformation lifecycle/revision effects and existing concurrency tests. Native create also locks existing references; do not certify combined read-committed execution from finalizer ordering alone.
- [ ] Write real two-connection tests: hold a native finalization transaction after it acquires locks; start a public origin void/amend or lot/reference mutation; assert the actual blocker/backend PIDs through `pg_blocking_pids`, release the holder, and assert the eventual public result and canonical state. Also run the inverse schedule: public origin writer holds locks first, native finalizer waits, then revalidates the committed change or fails without output. Cover valid finalized origins and absence of current origin. Unexpected upstream-root/lot inversion or stale publication is a stop condition, not permission for an isolation change.
- [ ] Register worker cleanup synchronously via `onTestFinished`; combine actual `TestContext.signal` with injected cancellation via `AbortSignal.any`. Race readiness against worker outcome/cancellation. Cleanup aborts observation, releases gates and drains all actual transactions before fixture reset/disposal. Add failure and cancellation before readiness regressions. Never terminate a PID unless verified as belonging to this test's child database and held connection.
- [ ] Run seams/locks configured serially with zero skips; then run existing draft/readiness/finalization/concurrency/lifecycle/amendment/void/genealogy/HTTP suites listed in Task3. Run static gates after fixture drain, save exact source/evidence and obtain independent review. No commit.

### Task 3: Check-only ownership, docs and final acceptance

**Files:** Workflow, isolation tests and the two US development documents only.

**Interfaces:** Consume the two completed native suites. Produce unconditional serial fixture-backed CI ownership while retaining all previous jobs/commands/order and operational locks.

- [ ] Write parsed ownership RED cases using the existing `workflows()`/Receiving ownership patterns. Require exactly one command owning both new suites, the exact synthetic fixture URL, `--maxWorkers=1`, unconditional job/step and successful shared/API build predecessors.
- [ ] Add fresh workflow mutation cases for omitted/duplicate suites, conditional owner/job/build, ignored job/step/build errors, `|| true`, missing/reordered builds, parallel workers, wrong/missing fixture URL and `DATABASE_URL` fallback. Each mutation must fail its invariant, not just YAML parsing.
- [ ] Run `node --test tools/us-development/test/isolation.test.mjs` and record RED from missing ownership. Add one named check-only step after existing builds, preserving all old selections:

```yaml
- name: Check US Transformation native transaction foundation
  env:
    US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
  run: pnpm --filter @markiro/api exec vitest run test/us-transformation-transaction-seams.e2e.test.ts test/us-transformation-transaction-locks.e2e.test.ts --maxWorkers=1
```

- [ ] Rerun all isolation contracts and fresh mutations. Keep permissions read-only, budget30 minutes, no service/secrets/upload/dispatch/release capability changes. If the existing budget cannot be supported, report measured evidence; do not silently increase it.
- [ ] Append scoped documentation: native methods exist, public semantics retained, caller consistency obligation, configured evidence and unrun gates. Do not mark US-11 complete or claim the generator/base installation is implemented. Update plan checkboxes only after each accepted gate.
- [ ] With all fixtures closed, run API build/typecheck/lint:

```sh
corepack pnpm --filter @markiro/api build
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
```

- [ ] Freeze source bytes and run the configured final regression selection once:

```sh
corepack pnpm --filter @markiro/api exec vitest run test/us-transformation-transaction-seams.e2e.test.ts test/us-transformation-transaction-locks.e2e.test.ts test/us-transformation-draft.e2e.test.ts test/us-transformation-readiness.e2e.test.ts test/us-transformation-finalization.e2e.test.ts test/us-transformation-finalization-concurrency.e2e.test.ts test/us-current-consumers.e2e.test.ts test/us-transformation-lifecycle.e2e.test.ts test/us-transformation-amendment-finalization.e2e.test.ts test/us-transformation-void.e2e.test.ts test/us-transformation-revision-concurrency.e2e.test.ts test/us-transformation-genealogy-fixture.e2e.test.ts test/us-transformation-genealogy.e2e.test.ts test/us-transformation-original-draft-void.e2e.test.ts test/us-transformation-revisions.e2e.test.ts test/us-transformation-http.e2e.test.ts test/us-events-registry.e2e.test.ts test/us-events-http.e2e.test.ts test/us-receiving-transaction-seams.e2e.test.ts --maxWorkers=1
```

- [ ] Run the full API once with both DB variables unset, recording failed suite names, passed/failed/skipped counts and diagnostics. Do not load primary env to erase failures or claim zero failed assertions means green when setup suites fail.
- [ ] Run scoped Prettier check for all changed/new files and `git diff --check`; verify empty index, unchanged branch/HEAD and a source-byte delta containing only approved paths. Run independent Task3 review and whole-increment review. Any fixes rerun affected gates on frozen corrected bytes; no invented union of separate test totals.
- [ ] Report behavior/files, RED/GREEN evidence, exact configured skips, full API status, reviewer findings/deferred items and external checks not run. Keep worktree/source/evidence; no push/cleanup. Next work remains a separately reviewed dataset Transformation orchestrator.
