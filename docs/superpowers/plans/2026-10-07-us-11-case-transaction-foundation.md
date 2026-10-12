# US-11 Case native transaction foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Preserve the owner's separate implementer and independent reviewer method; final controller gates and whole-increment review follow all three tasks.

**Goal:** Make existing manual case linking composable in a supplied transaction without changing public behavior.

**Architecture:** Extract one native link body and delegate the public wrapper to it through the unchanged `caseTransaction`. Prove genuine support-row visibility, rollback, error propagation and public-writer coordination on owned disposable PostgreSQL. No dataset executor or demo-source mode is added.

**Tech Stack:** Node 24+, repository Corepack pnpm, TypeScript, Drizzle, PostgreSQL, Vitest, parsed YAML isolation tests.

**Spec:** `docs/superpowers/specs/2026-10-07-us-11-case-transaction-foundation-design.md` (owner-approved 2026-10-07).

Status: owner-approved 2026-10-07; execution in progress with independent task reviews.

## Global Constraints

- Only `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`. Preserve accepted dirty work, HEAD and empty index; no stage/commit/push/PR/merge/release/cleanup.
- Read root/API instructions and `docs/us/development-isolation.md`; inspect current implementation/history before edits. No Graphify graph exists: no tooling installation or graph generation.
- No environment/dependency edit, migration, shared-base mutation, runtime/CLI/HTTP registration, archive/design edit, Station, scan or print path.
- Preserve `us-processor-six-month-v1`, April–September 2026, `America/Los_Angeles`, Scenario A and 256 KiB journal bounds. No historical technical timestamps or recipe changes.
- Keep `manual` linkSource, existing synthetic marker projection and exact public commandVersion 1 digest/replay bytes. `demo_seed` and dataset Cases are subsequent scoped work.
- Native entry authorizes before parsing/replay, opens/retries/commits no transaction and uses only supplied transaction queries. Caller owns rollback and fresh whole-transaction retry.
- Public wrapper retains repeatable read, three attempts, named retry classification and sanitized exhaustion. No new native unlink/list/lookup or production helper abstraction.
- Use only invocation-owned children of `US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev`; leave `DATABASE_URL` unset. Never migrate/reset/seed that shared base itself.
- Run database suites serially with `--maxWorkers=1`. Drain workers before shared builds. Register cleanup synchronously and preserve primary errors across independent cleanup failures.
- Report full API failures/skips separately. Eight preceding preparation-failed files are not automatically harmless; only billing's missing configuration is established. Retain existing Vite warning and unknown historical timeout/database provenance.
- Independent task reviews, final source-byte scope inventory and full-increment review are required. Use baseline file copies/packages rather than commits, as commits are not authorized.

## Review Focus

1. Native replay after access revocation must deny before trusting a saved operation (Task 1).
2. Same-transaction boxes/markers must be visible without a pool read or partial independent commit (Task 1).
3. Operation/audit failure after links must roll back the lot dependency change and every new support row; native retry must not hide an aborted transaction (Task 2).
4. Public operation arbitration must precede lot locks; native/public contenders must not create two active links or invert operation/lot ordering (Task 2).
5. Void between old receipt and new command must preserve old historical replay but deny new link and still allow audited unlink (Tasks 1/2).

## Interfaces and file ownership

Task 1 modifies only:

- `apps/api/src/modules/traceability/cases/us-case-commands.ts`: native link extraction/public delegation.
- `apps/api/src/modules/traceability/cases/us-case-store.ts`: internal native method.

Task 1 creates:

- `apps/api/test/support/us-case-transaction-fixture.ts`: native finalized target and minimal support rows; no lifecycle/cleanup duplicate.
- `apps/api/test/us-case-transaction-seams.e2e.test.ts`: composition, public compatibility and authorization tests.

Task 2 extends only that seams test and creates:

- `apps/api/test/us-case-transaction-locks.e2e.test.ts`: real PID-observed schedules and cancellation cleanup. Existing shared lock helpers are read-only dependencies.

Task 3 modifies only `.github/workflows/us-development.yml`, `tools/us-development/test/isolation.test.mjs`, `docs/us/development-isolation.md`, `docs/us/implementation-plan.md`. Plan/spec status and ignored review evidence are controller bookkeeping, not unrelated product work.

Native exports/method are identical in signature:

```ts
export async function linkCasesInTransaction(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  id: unknown,
  input: unknown,
  requestId: string,
): Promise<CaseLinkResult>;
```

`UsCaseStore.linkInTransaction` receives the same arguments and returns `Promise<CaseLinkResult>`. It delegates directly to the exported function, never to public `link`.

Fixture interfaces:

```ts
export type CaseTransactionFixture = Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
export type CaseTransactionTarget = Readonly<{
  tenant: string;
  actor: string;
  product: string;
  lotId: string;
  finalized: TransformationFinalizedRecord;
  transformationStore: UsTransformationStore;
  caseStore: UsCaseStore;
}>;
export function seedCaseTransactionTarget(
  f: CaseTransactionFixture,
): Promise<CaseTransactionTarget>;
export function insertCaseTransactionSupport(
  tx: UsMasterDataTransaction,
  target: CaseTransactionTarget,
  ssccs: readonly string[],
  shiftSequence: number,
): Promise<readonly Readonly<{ id: string; sscc: string }>[]>;
```

All referenced types/imports exist in current native stores/contracts/support. These helper exports are test-only. The target uses `seedFinalizableTransformation` then actual `store.finalize`, verifies exactly one non-null output lot and returns no boxes. Support inserts one random-ID shift with target product, `aggregation`, `SEP26`, caller's unique positive sequence; boxes have random IDs, exact supplied SSCCs and unique deviceBoxIds, null terminal/operator and no closure/print/scan/retirement fields. Insert one marker per box, seedId `us-case-transaction-fixture`, seedVersion 1. Use source defaults for real clocks. Never write links, audits or operations in helper SQL.

## Task 1: Native manual link and compatibility

**Consumes:** Existing `caseTransaction`, `authorizeUsMasterData`, strict case contracts, operation locks/digest/replay, lot/box helpers and native origin read; existing disposable dataset fixture and Transformation finalization fixture.

**Produces:** Native function/store method and the exact fixture interfaces above; testable genuine manual composition, public behavior unchanged.

- [ ] Record source-byte baseline and original copies of the two production paths; confirm intended branch, current HEAD and empty index. Review current `linkCases` callback from authorization through `return result`, plus unchanged unlink/read/digest/retry implementations.
- [ ] Create fixture helper and focused RED tests calling the missing native method. Use fresh target per test and `createUsDatasetJournalFixture` only against the explicit fixture base. Register owned fixture close immediately after acquisition; no database reset between tests.
- [ ] Establish the seams suite's setup and composition test with this core assertion:

```ts
const target = await seedCaseTransactionTarget(f);
const ssccs = Array.from({ length: 100 }, (_, i) => buildSscc(9, "9999999", i + 1));
const operationKey = randomUUID();
const result = await f.db.transaction(
  async (tx) => {
    const boxes = await insertCaseTransactionSupport(tx, target, ssccs, 1);
    const linked = await target.caseStore.linkInTransaction(
      tx,
      target.tenant,
      target.actor,
      target.lotId,
      { operationKey, ssccs },
      "case-native-compose",
    );
    expect(linked.created).toHaveLength(100);
    expect(linked.unchanged).toEqual([]);
    expect(new Set(linked.created.map((row) => row.boxId))).toEqual(
      new Set(boxes.map((row) => row.id)),
    );
    for (const row of linked.created) {
      expect(row).toMatchObject({
        lotId: target.lotId,
        linkSource: "manual",
        provenance: "synthetic_demo",
        linkedBy: target.actor,
        originState: "current",
        ssccState: "consistent",
        unlinkedAt: null,
        unlinkedBy: null,
        unlinkReason: null,
      });
    }
    return linked;
  },
  { isolationLevel: "repeatable read" },
);
const page = await target.caseStore.list(target.tenant, target.actor, target.lotId, { limit: 100 });
expect(page.activeCount).toBe(100);
expect(new Set(page.rows.map((row) => row.linkId))).toEqual(
  new Set(result.created.map((row) => row.linkId)),
);
```

- [ ] Run RED `corepack pnpm --filter @markiro/api exec vitest run test/us-case-transaction-seams.e2e.test.ts --maxWorkers=1` with only the fixture variable. Missing native method/export is RED; missing infrastructure is not.
- [ ] Move the existing callback body unchanged into typed `linkCasesInTransaction`; add type-only `CaseLinkResult` import. Retain the public signature and replace only its wrapper body:

```ts
return caseTransaction(db, (tx) =>
  linkCasesInTransaction(tx, tenantId, actorUserId, id, input, requestId),
);
```

Add the typed store method/import, delegating directly. Do not move shared helpers, change native lock order, alter replay/digests, touch unlink or add source arguments.

- [ ] Verify exact operation result and independent command digest using SHA256 of `{ commandVersion: 1, command: "case.link", lotId, input: { ssccs: [...ssccs].sort() } }`. Assert exact single audit tenant/actor/action `case.link`/outcome/target lot/request ID; before `{ links: [] }`; after `{ tenantId, operationKey, lotId, source: "manual", result }`. Public lookup must report synthetic provenance/manual source; support closure/print fields remain null, event snapshots/genealogy unchanged.
- [ ] Add exact replay through native→public and public→native, including permuted normalized SSCC wrappers, same-lot new-key no-op, changed payload conflict, and historical receipt after unlink. Compare saved response bytes, operation count and audit count before/after exact replay.
- [ ] Add capability denial before malformed ID/input; revoke current membership/role after successful link and deny native replay. Restore only test-owned membership after assertions. Assert foreign tenant/lot/box denial, malformed/check-digit/duplicate/101-entry batches, missing box, disassembled box and cross-lot conflict with full snapshot unchanged. Public payload containing `linkSource` or a synthetic flag stays rejected by strict schemas.
- [ ] GREEN new seams plus existing case commands/reads/HTTP serial configured suites. After workers drain run API typecheck/scoped ESLint/Prettier/diff. Independent reviewer checks extraction bytes, original wrapper/replay/auth/lock compatibility and source scope. No commit.

## Task 2: Atomic failures, driver behavior and contention

**Files:** Extend `apps/api/test/us-case-transaction-seams.e2e.test.ts`; create `apps/api/test/us-case-transaction-locks.e2e.test.ts`. No production edits; report any demonstrated implementation gap before expanding scope.

**Consumes:** All Task 1 interfaces, existing `createUsDatasetJournalFixture.snapshot/close`, `barrier`, `outcome`, `startObservation`, `waitBlocked`, `withOwnedWork`, `ownClient`, `connectClient`, `driverCode` from `test/support/us-transformation-lock-fixture.ts`; actual public case and Transformation stores.

**Produces:** Failure/rollback and live lock evidence; no new product interface or helper abstraction.

- [ ] Add caller-abort test after support creation/native link; capture `before=await f.snapshot()` after finalized target but before support. Compare every persisted table digest after rejection:

```ts
const abort = new Error("owned_case_caller_abort");
await expect(
  f.db.transaction(
    async (tx) => {
      await insertCaseTransactionSupport(tx, target, ssccs, 1);
      await target.caseStore.linkInTransaction(
        tx,
        target.tenant,
        target.actor,
        target.lotId,
        { operationKey, ssccs },
        "case-native-rollback",
      );
      throw abort;
    },
    { isolationLevel: "repeatable read" },
  ),
).rejects.toBe(abort);
expect(await f.snapshot()).toEqual(before);
```

- [ ] Create owned unique-named failure triggers at `trace_lot_boxes` INSERT, target-lot dependency UPDATE, `tenant_audit_events` INSERT restricted to target/action, and `trace_lot_box_operations` INSERT restricted to target/command/key. Use a nontransactional sequence to observe attempts. Register independent trigger/function/sequence cleanup immediately after each acquisition; never log raw SQL or snapshot bodies.
- [ ] Run each boundary with injected 40001/40P01 and a nonretryable error. Assert driver code through cause chain, original object/error preservation where directly observable, one sequence attempt, full support/business snapshot rollback. Do not make assertions against guessed `.code` only on Drizzle wrappers. A fresh external caller retry after trigger removal reuses the same operationKey. Label injected errors honestly.
- [ ] Public compatibility test: inject one retryable failure then success to prove public fresh transaction retry; always-fail case proves exactly three public attempts and `us_database_unavailable`. Pin the two existing retryable23505 constraint names and nonmatching constraint propagation without changing classification. Native call under the same failure has one attempt and raw driver failure. Observe attempts independently of rolled-back rows.
- [ ] Write lock suite using fresh owned databases/targets and synchronously registered cleanup. Obtain both backend PIDs from actual worker transactions and observe `pg_blocking_pids`, not sleeps. For each winner ordering, use a held owned lot/operation barrier and release before draining workers:

```ts
const countActiveOwnedLinks = async () => {
  const counted = await f.pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM trace_lot_boxes WHERE tenant_id=$1 AND box_id=$2 AND unlinked_at IS NULL",
    [target.tenant, ownedBoxId],
  );
  return counted.rows[0]?.n;
};
await waitBlocked(observer, leaderPid, followerPid, test.signal);
releaseGate();
const [leaderResult, followerResult] = await Promise.all([leaderOutcome, followerOutcome]);
expect(await countActiveOwnedLinks()).toBe(1);
```

`observer`, worker outcomes, owned gate release and `ownedBoxId` are local test variables implemented with the imported helpers and actual scoped connections. Register both outcome observers before awaiting readiness so early failures cannot become unhandled rejections. A native repeatable-read waiter can legitimately receive40001/40P01 after a winner commits. Assert that driver result and the single native attempt, then perform an explicit fresh caller transaction with the same operationKey where convergence is required; never interpret convergence as an inner native retry. Observe and drain the failed first transaction before retrying.

- [ ] Native/public link-link schedules: same-key receipt convergence and distinct-key created/unchanged results, plus same box across two native-finalized target lots where only one wins. Assert exact operations/audits, not only active count. For sorted-box ordering, pass reverse SSCC order and independently observe the first contended box selected by the native path.
- [ ] Inversion-sensitive schedule: hold target lot, start public operation with known key, observe it blocked on lot, then start native same-key command and observe it blocked on the public operation holder. Release lot; both finish with one receipt/link. Native operation arbitration must occur before it can acquire lot locks; no caller prelock protocol is certified here.
- [ ] Native/public link-unlink both orders: after an original link exists, native distinct-key link returns unchanged if it wins first; unlink-first permits a new native link row. Original history is retained and a stale unlink cannot remove the later row. Check exact actors/request IDs/reasons and matching before/after audits.
- [ ] Native link/public Transformation void both orders: link-first leaves one active link after void with `originState: gap`; void-first rejects a new native link with `case_origin_not_current`. Historical operation replay stays byte-identical; a fresh key requesting a new eligible unlinked box fails. A new key over already-active same-lot links may return unchanged with gap, preserving existing behavior. Public audited unlink remains available. Also cover public amendment/finalization against the same stable output identity without changing case links or historical snapshot bytes.
- [ ] Cancellation/early setup failure: fail before announced readiness and abort while a real native lock waiter is observed. Use actual `TestContext.signal` and registered whole-body drain. Release barriers, await actual worker outcomes, remove triggers, destroy owned clients/end pools and prove exact owned database absence even if one cleanup phase fails. Preserve the primary error; never delete unidentified databases.
- [ ] GREEN both native files plus existing case concurrency and affected Transformation lifecycle/void/revision-finalization/current-consumer regressions, serial configured and zero skips. After workers drain run scoped static/format/diff gates. Reviewer checks each actual writer/order and no promise of arbitrary read-committed composition. No commit.

## Task 3: CI ownership, documentation and controller acceptance

**Files:** `.github/workflows/us-development.yml`, `tools/us-development/test/isolation.test.mjs`, `docs/us/development-isolation.md`, `docs/us/implementation-plan.md` only.

**Consumes:** Exact two new suite names and approved Tasks 1/2 evidence. **Produces:** One check-only owner, executable mutation contracts and accurate partial-stage documentation.

- [ ] RED parsed ownership tests for exact owner `Check US Case native transaction foundation`, the two suites exactly once across all workflows, exact serial command, unconditional workflow/job/step, no ignored failure or fallback database, successful shared-domain/API build predecessors. No tautological constant-array-length substitute.
- [ ] Add the single owner after shared/API builds:

```yaml
- name: Check US Case native transaction foundation
  env:
    US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
  run: corepack pnpm --filter @markiro/api exec vitest run test/us-case-transaction-seams.e2e.test.ts test/us-case-transaction-locks.e2e.test.ts --maxWorkers=1
```

- [ ] Preserve every prior command/order/workflow setting. Add only this owner's exclusion to prior historical hash filters; do not repin their historical hashes. Verify removing the new owner yields the actual preincrement workflow. Current planning baseline steps SHA256 is `4294d7b8f1d349dfdddfb3d1ec6411a281914cec6740cabd3c251162d85b551f`; whole parsed workflow SHA256 is `0bd97357ce9a271ff37dc3f088803e8b6e73d21e4b08f22d12d24ad507e06892`. Recheck them at execution baseline; unexpected drift requires controller review.
- [ ] Mutation tests reread fresh YAML each time: omit/duplicate/split a suite, remove/duplicate owner, skip workflow/job/step, suppress failure, remove/change serial flag, reorder/remove/conditionally skip/fail-ignore a build, change fixture/remove it/add DATABASE_URL at all scopes, change permissions/budget or prior step. Each must throw intended AssertionError with intended invariant message. Preserve all inherited release locks/read permissions/30-minute budget; no remote budget claim.
- [ ] Run RED then GREEN isolation tests, all US tooling and checker. Update both docs append-only: native manual seam now implemented; synthetic provenance/manual linkSource are distinct; no demo-source mode or Cases executor yet. Attribute actual rollback/error/PID/cleanup evidence, skips, full API status and all external unrun boundaries.
- [ ] After all workers drain, controller fresh API typecheck/lint/build; record exit codes. Then run configured serial selection:

```sh
corepack pnpm --filter @markiro/api exec vitest run test/us-case-transaction-seams.e2e.test.ts test/us-case-transaction-locks.e2e.test.ts test/us-case-commands.e2e.test.ts test/us-case-concurrency.e2e.test.ts test/us-case-reads.e2e.test.ts test/us-case-http.e2e.test.ts test/us-transformation-lifecycle.e2e.test.ts test/us-transformation-void.e2e.test.ts test/us-transformation-revisions.e2e.test.ts test/us-transformation-amendment-finalization.e2e.test.ts test/us-transformation-revision-concurrency.e2e.test.ts test/us-current-consumers.e2e.test.ts test/us-transformation-http.e2e.test.ts test/us-dataset-transformation-seed.e2e.test.ts --maxWorkers=1
```

Verify all14 filenames exist before launching. Record exact file/assertion/skip counts; configured skips are not database acceptance. No builds overlap these workers.

- [ ] After configured workers exit, run full `corepack pnpm --filter @markiro/api test` separately with both database variables unset and necessary local listeners permitted. Report actual failures/skips and causes established in this run; identical baseline set does not prove harmlessness. No unrelated RU fixes or real credentials.
- [ ] Controller full repository `corepack pnpm format:check`, `git diff --check`, final source-byte inventory, unchanged HEAD/index and only allowed task paths. Independent final reviewer inspects all three task packages/current source/interfaces, retained minors and evidence boundaries. No push, release, shared-base seeding or cleanup.

## Execution handoff

Preserve the selected separate-implementer/independent-review method, fresh reviewer
for each task, final controller verification and whole-increment review. Written
plan approval is required before Task 1. Cases dataset/provenance orchestration
is the next separately approved design; it is not a hidden fourth task here.
