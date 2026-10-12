# Corrected Cases execution implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development; separate
> implementer and independent review per task. Standing user waiver removes
> routine approval pauses. No commit, push, deployment or cleanup.

**Goal:** create and verify the corrected recipe's 60 synthetic Cases atomically.

**Architecture:** distinct corrected codecs/executor, shared structural evidence
and persistence helpers, existing CaseLink business core. Regular strict inputs
and public command behavior remain unchanged.

**Tech Stack:** TypeScript, Zod, Drizzle/PostgreSQL, Vitest, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-09-us-11-corrected-cases-execution-design.md`.

## Global constraints

- Work only in existing `codex/us-mvp` checkout; preserve inherited dirty work.
- Exactly 60 corrected boxes, SSCC serials 15641–15700, support sequence 261.
- No regular alias, primary DB fallback, env/schema/dependency/runtime changes.
- Operations before origin roots/revisions/lots before sorted support boxes.
- Same supplied transaction, mandatory verification, no adoption/repair.
- No push/deploy/cleanup; fixture databases are owned disposable children only.

## Review focus

- Completed receipt with changed current origin must reject without mutation.
- Failed native write or verification must leave only captured intent.
- Manual/pending operation identity may not be adopted by the seed.
- Public operation/lifecycle lock contention must not invert operation/root/lot order.
- Downstream use may alter technical tokens, not frozen business evidence.

### Task 1: Shared Cases evidence and corrected result contract

**Files:** create `us-dataset-cases-content.ts` and
`us-dataset-corrected-cases-result.ts` under API traceability/demo; modify
`us-dataset-cases-contract.ts`, `us-dataset-cases-support.ts`,
`us-dataset-cases-locks.ts`; create
`apps/api/test/us-dataset-corrected-cases-contract.test.ts`.

**Interfaces:** export structural `UsDatasetCasesContentInput`,
`UsDatasetCasesEvidence`, `usDatasetCasesEvidenceFields` and
`checkUsDatasetCasesEvidence(result: UsDatasetCasesEvidence): void`,
corrected result type/parser,
`usDatasetCorrectedCasesRecordIds`, `correctedCaseDemoAuditIdentity`,
`correctedCaseDemoCommandDigest`. Keep existing regular exports/signatures/validation
behavior; support/locks consume the structural projection rather than a fake alias.
Both paths use the same semantic checker. No upstream-result fabrication in native
tests; pure fixtures may hand-build coherent evidence.

- [ ] Write a corrected result test against an importable empty stub; assert real
      exact links/support binding, not export existence. Example behavior:
      `expect(parseUsDatasetCorrectedCasesResult(raw).linked.created).toHaveLength(60)`.
- [ ] Record assertion RED, implement strict guarded codec, then extract shared
      regular result semantic checks unchanged. Reject normalization/accessors,
      count/source/actor/marker/link/owned-ID contradictions; return owned frozen copy.
- [ ] Widen only internal persistence/locking projection, retain existing failure
      codes for regular callers and preserve SQL/defaults/collision behavior.
- [ ] Run pure corrected Cases, regular Cases, corrected Transformation contracts
      with `env -u DATABASE_URL -u US_TEST_DATABASE_URL ... --maxWorkers=1`; run existing
      configured Cases support regressions before claiming parity. Report exact evidence.

### Task 2: Guarded corrected Cases executor and current verification

**Files:** create demo `us-dataset-corrected-cases-prepare.ts`,
`us-dataset-corrected-cases-verify.ts`, `us-dataset-corrected-cases-seed.ts`,
shared `us-dataset-cases-verify-content.ts`; extract shared prepared-command core
from `cases/us-case-demo-command.ts` into `cases/us-case-demo-content.ts`.
Modify regular Cases verifier to delegate content; create
`apps/api/test/us-dataset-corrected-cases-seed.e2e.test.ts` and optional focused
test-support `us-dataset-corrected-cases-fixture.ts`. No public/store signature change.
The Task1 `datasetCorrectedCasesError` helper in the corrected result module may
add prerequisite-incomplete/dependency-conflict codes for the executor; no change
to the accepted input parser's semantics.
Restore the inherited single native gate in
`apps/api/test/us-dataset-corrected-transformation-contract.test.ts`: one outer
module-level `describe.skipIf(!base)` contains the two existing plain-described
native groups, preserving their separate fixture scopes, bodies, titles and cleanup.
The existing ownership assertion stays unchanged. Pin its observed RED→GREEN
and rerun both native witnesses; no API behavior or timeout change.

**Interfaces:** `UsDatasetCorrectedCasesSeedStore(db).initialize(context)` and
`.verify(context): Promise<UsDatasetCorrectedCasesResult>`; guarded prepare in
supplied tx supports application/fresh-verification/replay phases; verifier uses
accepted Task1 codecs/digest/record helpers and corrected Transformation verifier.
Shared content helpers receive validated structural evidence and explicit seed
identity/digest; they do not select arbitrary caller codecs or authorize a write.

The integration must preserve this order (after journal/current capability checks):

```ts
await lockCaseOperation(tx, context.tenantId, "case.link", intent.operationKey);
await verifyUsDatasetCorrectedTransformation(
  tx,
  context,
  transformation.intent,
  transformation.receipt,
  stores,
  "replay",
);
```

The completed stage parser is never replaced with generated regular evidence:

```ts
const input = makeUsDatasetCorrectedCasesInput(
  makeUsDatasetReferenceIdentity(datasetId, references),
  amendment,
  transformation,
  captured.support,
);
expect(result.linked.created).toHaveLength(60);
expect(await fixture.snapshot()).toEqual(beforeReplay);
```

- [ ] Start native assertion RED using real references/special Receiving/corrected
      Transformation and importable executor stub. Assert actual 60 links/rows and
      journal completion, not a mocked method call.
- [ ] Implement authorization-first capture/re-read winner, Cases operation-first
      preparation, exact prerequisite reconstruction and corrected current proof.
- [ ] Apply fresh support and shared guarded CaseLink core, compose result/receipt,
      mandatory exact-content verification then journal publish in same tx. Preserve
      original error and separately captured intent on rollback. Verify never captures.
- [ ] Test exact audit/provenance/IDs, no-write replay, real post-write failpoints,
      pending/manual collision, foreign owner/tenant, support/link/origin mutations,
      downstream consumption and concurrent capture. Include PID-observed operation
      holder and lifecycle/root holder contention with owned cleanup/barriers/drain.
- [ ] Run new configured suites plus regular Cases seed/verify/locks and corrected
      Transformation regressions serially in owned fixture DBs. No static/build overlap
      with DB tests. Controller owns full package/static gates.

### Task 3: Check-only CI ownership and truthful checkpoint

**Files:** modify `.github/workflows/us-development.yml`; create
`tools/us-development/test/dataset-corrected-cases-ownership.test.mjs`; append-only
`docs/us/development-isolation.md` and `docs/us/implementation-plan.md`.
Modify predecessor projections in `dataset-special-ownership.test.mjs`,
`dataset-regular-ownership.test.mjs`, `receiving-lifecycle-ownership.test.mjs`
only to remove this exact newly owned step/block before their historical checks;
retain every existing hash, mutation family, expected message and native fixture gate.
The same exact-step exclusion applies to the seven historical predecessor-step
projections in `tools/us-development/test/isolation.test.mjs`; their hash constants,
mutation families, assertions and expected messages also remain unchanged.

- [ ] Add one owner named `Verify corrected dataset Cases on disposable databases`
      after successful shared/API builds. Exact run:
      `corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-corrected-cases-contract.test.ts test/us-dataset-corrected-cases-seed.e2e.test.ts --maxWorkers=1`.
      Exact step-only fixture URL is the existing loopback US fixture; no primary env.

```yaml
- name: Verify corrected dataset Cases on disposable databases
  env:
    US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
  run: corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-corrected-cases-contract.test.ts test/us-dataset-corrected-cases-seed.e2e.test.ts --maxWorkers=1
```

- [ ] Pin old workflow bytes/hash before edit. Behaviorally inspect fresh parsed
      workflow mutations for missing/duplicate selection, skipped owner/build, ignored
      errors, shell override, wrong fixture/fallback, token/release drift. Removing
      only new owner must reproduce all predecessor workflow bytes and AST.
- [ ] Existing historical predecessor projections omit only the exact new owner;
      their historical hash constants stay unchanged. New ownership tests separately
      enforce that step and pin the complete current predecessor. Run all old mutation
      families to prove this is additive, not acceptance of historical workflow drift.
- [ ] Run Node ownership/isolation checks and checker. Append actual task evidence
      and remaining boundaries, no full-population/browser/hosting acceptance claims.
      Controller then runs full API test command, typecheck/lint/build, formatting,
      configured focused selection, source-byte scope and final independent review.
