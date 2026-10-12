# US-11 dataset atomic stage implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Commit one bounded dataset stage's native business changes, canonical verification and journal receipt in one guarded PostgreSQL transaction; replay verifies without applying again.

**Architecture:** Extend the existing dataset journal, not the compact journal or database schema. A trusted internal callback receives the journal-owned transaction. Dataset stage revision is the CAS boundary; exact committed replay ignores a stale positive revision only after rechecking target, immutable intent and canonical business state. This is a prerequisite seam, not the six-month business generator.

**Tech Stack:** Existing Node24/Corepack pnpm11.22, TypeScript, Drizzle/PostgreSQL, Zod and Vitest; no new dependency.

**Spec:** `docs/superpowers/specs/2026-10-06-us-11-six-month-demo-design.md`, section4 bounded durable progress and section6 verification boundaries; existing single-tenant specification's trusted-target rules remain binding.

**Status:** Written for owner review, not approved for implementation. Preserve the previously chosen separate implementer and independent reviewer per task, then final whole-increment review. No commit/push is included.

## Global Constraints

- Work stays in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`; preserve all accepted and unrelated dirty work.
- No shared-base database writes, environment/dependency edits, archive/design-file edits, staging, commit, push, PR or deployment.
- Keep recipe `us-processor-six-month-v1`, dates `2026-04-01` through `2026-09-30`, timezone `America/Los_Angeles`, and the reviewed definition digest unchanged.
- Do not modify compact Scenario A, its journal/reference seed, either migration0141/0142, schemas, public HTTP contracts or runtime registration.
- Retain existing256KiB intent/result discipline, bounded paging and per-unit stage ordering. No whole-dataset expansion/read is required by this method.
- Reload actual database identity, reserved tenant, original owner, synthetic provenance and US profile before every apply or replay verification.
- Only trusted internal callbacks use the seam. No public command/CLI/startup initializer or automatic dataset population is introduced.
- The receipt is bookkeeping, not proof of current business facts. Canonical verification is mandatory on first apply and every completed replay.
- Do not claim a PostgreSQL transaction spans PDF/object storage/publication. Plan/Request artifact protocols remain unchanged and outside this plan.
- Civil dates never override creation/audit/auth/approval/request times. No real contacts, allocated GS1-prefix or physical/regulatory claims.
- Test only fixture-owned disposable US PostgreSQL children; ambient DATABASE_URL unset. Fixture teardown must verify its exact child absent.
- Full API is currently nongreen: eight failed files and3528 skipped/pending tests in the preceding run. Preserve this limitation; no suppression or unrelated repairs are authorized here.

## Review Focus

1. Lost committed reply/concurrent same-intent retry must create one business record and exact audit, not reapply: Task1 real-service replay/concurrency tests.
2. Any apply, canonical verification or receipt-update failure must roll back business/audit/receipt changes while leaving the earlier captured intent pending: Task1 full-row snapshot/failpoint tests.
3. A completed receipt must not bypass changed current owner/target/provenance or business drift: Task1 guarded replay and actual-party drift tests.
4. Missing/different intent, foreign dataset, corrupt evidence, invalid revision or incomplete predecessor must fail before callbacks: Task1 exact denial/zero-write tests.
5. Work must remain bounded and backward-compatible: Task1 multi-unit/page/compact regressions and Task2 exact check-only CI ownership; neither a stage receipt nor passing local checks means the full demo is generated.

## Current source and prerequisite evidence

Read root AGENTS, API scoped guide (primary checkout read-only fallback if absent), the spec, and these current implementations before edits:

- `apps/api/src/modules/traceability/demo/us-dataset-journal.ts`: guarded transaction, header validation, exact intent capture, within-unit predecessor and stage revision1→2. It currently lacks `runAtomicStage`.
- `us-dataset-contract.ts`: actual bounded immutable definition/intent parser and exact per-kind stage sequences.
- `us-demo-journal.ts:260`: compact atomic apply→verify→receipt pattern; unchanged, not copied wholesale or used as the large dataset journal.
- `us-demo-target.ts`: current database/owner/provenance/profile trust boundary and genuine row locks.
- `us-demo-journal-contract.ts`: exact bounded receipt parser/digest; reuse unchanged.
- `us-six-month-definition.ts`: accepted267 units and recipe identity; unchanged.
- Existing dataset/compact journal and atomic tests, real master-data native transaction methods, and owned dataset fixture.

No mutable build output or node_modules sharing. Build affected dependencies before consumer checks when necessary. Do not run builds while disposable fixtures are live.

## File structure and interfaces

| Path                                                                               | Responsibility                                                                                         |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `apps/api/src/modules/traceability/demo/us-dataset-atomic-stage-contract.ts` (new) | Internal callback types using existing dataset and transaction contracts                               |
| `apps/api/src/modules/traceability/demo/us-dataset-journal.ts`                     | Guarded atomic stage and shared pending-receipt persistence, preserving existing public behavior       |
| `apps/api/test/us-dataset-atomic-stage.e2e.test.ts` (new)                          | Genuine service/audit atomicity, replay, denial, corruption, concurrency and failpoints on owned child |
| `.github/workflows/us-development.yml`                                             | Exact unconditional serial CI ownership of the new configured suite                                    |
| `tools/us-development/test/isolation.test.mjs`                                     | Assert the new suite's check-only owner, order and isolated environment                                |
| `docs/us/development-isolation.md`, `docs/us/implementation-plan.md`               | Factual seam-complete/generator-incomplete status                                                      |

New contract:

```ts
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type { UsDatasetContext, UsDatasetIntent, UsDatasetReceipt } from "./us-dataset-contract.js";

export type UsDatasetAtomicStageWork = Readonly<{
  apply(tx: UsDemoTransaction, context: UsDatasetContext, intent: UsDatasetIntent): Promise<UsDatasetReceipt>;
  verify(tx: UsDemoTransaction, context: UsDatasetContext, intent: UsDatasetIntent, receipt: UsDatasetReceipt): Promise<void>;
}>;
// Additional UsDatasetJournalStore method:
runAtomicStage(context: UsDatasetContext, datasetId: string, expectedRevision: number,
  intent: UsDatasetIntent, work: UsDatasetAtomicStageWork): Promise<UsDatasetStageRow>;
```

There is no automatic intent capture, transaction retry, target provisioning or adoption. Capture remains a separate durable operation. Callbacks never call pool-backed public command methods: use actual services' supplied-transaction methods. The journal checks presence of a prior same-unit receipt; each business orchestrator must verify its real dependency facts itself. Cross-unit references cannot be certified by generic stage ordering.

## Task 1: Guarded atomic stage and real transaction evidence

**Files:** Create contract/new e2e test and modify only `us-dataset-journal.ts` from the map. Existing fixture policy, compact code, schemas, pure recipe and service implementations remain unchanged.

**Consumes:** Existing guarded `transaction`, `required`, `unit`, `stage`, `parseRow`, receipt/intent parsers and real `UsMasterDataStore` supplied-transaction methods.

**Produces:** The exact `UsDatasetAtomicStageWork` and method above. Pending receipt writes share one private helper with `recordReceipt`; public validation/error/replay semantics remain unchanged.

- [ ] **Step1 — write genuine failing service tests.** Use `createUsDatasetJournalFixture(base)`, provision owner/profile, initialize journal with actual `usSixMonthDefinition`, capture `references/references` intent. Callback creates one real synthetic party with `UsMasterDataStore.createPartyInTransaction`, not direct SQL final-state fabrication. Construct receipt from the actual service response and canonical digest; verifier uses `getPartyInTransaction` and compares exact response plus intended name. Exact audit must assert tenant, actor, action `traceability.party.created`, outcome, target type/id, operationKey requestId and before/after. Callback counters supplement, never replace persisted-state assertions.

```ts
const input = { name: "Synthetic dataset atomic party" };
const intent = parseUsDatasetIntent({
  unitKey: "references",
  stage: "references",
  operationKey: randomUUID(),
  input,
  inputDigest: canonicalExportDigest(input),
});
const header = await journal.initialize(context);
const captured = await journal.captureIntent(context, header.id, intent);
const first = await journal.runAtomicStage(context, header.id, captured.revision, intent, work);
expect(first.revision).toBe(2);
const saved = await f.snapshot();
expect(await journal.runAtomicStage(context, header.id, 1, intent, work)).toEqual(first);
expect(await f.snapshot()).toEqual(saved);
```

Define `work.apply` by the actual party create with intent.input/operationKey and return `{ recordIds:[party.id], result:{party}, resultDigest:canonicalExportDigest({party}) }`. Define `work.verify` by requiring exactly one ID, reading via actual master store, and `isDeepStrictEqual(receipt.result,{party})` plus intended name; throw `synthetic_dataset_canonical_mismatch` on drift. This is an atomic-seam fixture, not implementation of all reference/catalogue business records.

- [ ] **Step2 — extend RED coverage before implementation.** Add discarded committed reply (new journal/store instance; persisted receipt is the authority), two identical simultaneous calls (one party/audit/receipt), changed-intent concurrent loser, exact stale replay after unrelated unit capture, and absent/pending predecessor. Add failures after real party/audit writes, invalid/digest-mismatched/oversized returned receipt, verifier mismatch and fixture-local trigger raising on dataset receipt update. Snapshot every persisted table before/after each failed atomic unit: earlier captured intent revision1/null receipt remains, no party/audit leak. Remove only each fixture-owned trigger then retry once successfully. SQL/driver errors propagate, never converted to a successful receipt.

Test target database/user mismatch, original owner role revocation after completion, changed profile/provenance, foreign dataset/operation/unit/stage, unknown/missing captured intent, same key with changed canonical input, malformed raw intent, corrupt saved intent/digest/revision/receipt, missing actual party and actual party business drift. Denial must occur before callbacks where journal/target fails; semantic drift runs verifier but not apply, with no repair. Invalid revisions0/-1/fraction/NaN/Infinity/overflow fail even for completed replay; any valid stale positive revision may replay only exact committed intent. Pending stage accepts only its actual revision1. Use owned fixture SQL only for explicit tampering/failpoints, never as the business apply callback.

- [ ] **Step3 — run actual RED.** With ambient DATABASE_URL unset and approved local US_TEST_DATABASE_URL, run `corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-atomic-stage.e2e.test.ts --maxWorkers=1`. Missing method/export is expected; connection EPERM is not RED. Request exact localhost permission if needed, record actual failure before source edits. No primary secrets or shared data fallback.

- [ ] **Step4 — implement one transaction-owned method.** Inside existing mutation transaction: validate revision as safe positive integer≤2147483647; parse owned immutable intent; require matching dataset/header definition/owner; validate unit/stage; lock the selected stage row and require exact full intent equality. Reject missing row as `us_dataset_intent_conflict`. If there is a predecessor, lock/read it and require a schema-valid receipt, otherwise `us_dataset_predecessor_incomplete`. This checks bookkeeping presence, not canonical dependency state. If current receipt exists, call mandatory verify and return the current stage row without apply/update. Otherwise require exact expectedRevision, call apply, parse bounded receipt, call verify, persist receipt with CAS on tenant/dataset/unit/stage/revision/operationKey and return parsed updated row. Any error aborts the whole transaction.

Keep existing shared tenant advisory lock namespace (`tenantId + ":us-processor-demo-v1"`) so compact/dataset mutation locks remain compatible. Add optional private locking arguments defaultfalse to header/stage reads if needed; only atomic execution uses row locks, preserving existing ordinary read isolation. No second pool/transaction from inside callbacks, savepoint retry or callback execution outside guarded tx. Reuse current `us_dataset_*` denial namespaces and throw driver failures unchanged.

```ts
// Required algorithm inside the existing guarded transaction:
if (existing.receipt !== null) {
  await work.verify(tx, checked, existing.intent, existing.receipt);
  return existing;
}
if (existing.revision !== expectedRevision) throw new Error("us_dataset_revision_conflict");
const receipt = parseUsDemoReceipt(await work.apply(tx, checked, existing.intent));
await work.verify(tx, checked, existing.intent, receipt);
return this.persistPendingReceipt(tx, checked, datasetId, existing, expectedRevision, receipt);
```

`persistPendingReceipt` takes the existing typed `Transaction`, context, dataset ID, parsed stage row, expected revision and parsed receipt; returns `Promise<UsDatasetStageRow>`. It performs the current update/returning/row-count check and parse once. `recordReceipt` retains its existing checks and committed receipt equality before using this helper for pending writes. No new receipt wire shape or immutability promise for nested returned business responses.

- [ ] **Step5 — GREEN and compatibility.** Configured serial run of `us-dataset-atomic-stage.e2e.test.ts`, `us-dataset-journal.e2e.test.ts`, `us-demo-atomic-stage.e2e.test.ts`, `us-demo-journal.e2e.test.ts`, `us-demo-reference-seed.e2e.test.ts`, `us-reference-transaction-seams.e2e.test.ts`. No configured skips; verify exact child disposal. Pure dataset/compact codecs and all three six-month recipe files stay green. APItypecheck/lint/scopedformat/diffcheck; no build during fixture lifetime. Record real RED/GREEN, full-row snapshots, exact audit assertions, hashes and current public wrapper compatibility for independent review before Task2.

## Task 2: Check-only ownership, factual status and final gates

**Files:** Modify only workflow, isolation test and two docs from the map. Task1 code unchanged unless a separately reviewed defect requires a fix round.

**Consumes:** Task1 method/tests and current dataset CI step immediately after shared/API builds.

**Produces:** Exact unconditional serial ownership of the new database suite beside the existing dataset journal suite, no new token/environment/job or operational entrypoint.

- [ ] **Step1 — add failing ownership contract.** Add an isolation test locating the named dataset CI step, verifying `test/us-dataset-atomic-stage.e2e.test.ts` and `test/us-dataset-journal.e2e.test.ts` appear exactly once in its `run`, `--maxWorkers=1`, explicit US_TEST_DATABASE_URL and no primary DATABASE_URL. Assert it remains in the check-only job after API builds and has no step-level conditional/continue-on-error or new privileged capability. Use existing workflow parser/helpers; assert actual changed step rather than brittle whole-file substring count.
- [ ] **Step2 — RED, minimal CI update, GREEN.** Run `node --test tools/us-development/test/isolation.test.mjs` before modifying workflow; actual missing ownership failure. Add only the exact new file to existing dataset-progress command. Rerun same test and full `node --test tools/us-development/test/*.test.mjs`; record actual test totals, not assume52 after adding a case.
- [ ] **Step3 — append factual docs.** Explain that dataset stage apply/verify/receipt is atomic and replay canonical only through actual callbacks; references/Receiving/Transformation/cases/Shipping/corrections/artifact orchestration remains unimplemented. No whole-volume, viewer/browser, Request limits, hosted or remoteCI claim. Keep previous recipe/foundation history and fullAPI nongreen limitation visible.
- [ ] **Step4 — final execution evidence.** Controller runs one frozen configured six-file transaction regression above plus codec/three-recipe regressions; child fixtures close before final APIbuild. Run API package typecheck/lint/build, rootformat/checker/all isolation tests/gitdiffcheck. Run fullAPI once with both DB variables unset and permitted localhost HTTP fixtures, save machineJSON, classify failed files/skips precisely; prior matching failure paths do not establish harmlessness. Do not expand scope to repair those failures or suppress config warnings.
- [ ] **Step5 — independent task and whole-increment review.** Byte checkpoints distinguish these seven source paths from the historical dirty baseline; explicit fixture-only evidence is retained. Review lock ordering, single SQL implementation, intent/receipt bounds, no-op rollback/audit and unchanged compact/recipe contracts. Final reviewer sees all deferred findings and failed full-package gate. No staging/commit/push/cleanup.

## Self-review and acceptance boundaries

Task1 implements only section4's database-local stage transaction seam, trusted target/original owner and mandatory current-state callback verification. Task2 owns section6's check-only execution evidence. All five Review Focus failures have concrete Task1/2 tests. Cross-unit canonical prerequisites stay the later service orchestrator's responsibility, not a generic receipt-presence claim.

Catalogue/Receiving native services and six-month stage orchestration, special actions, Plan/Request artifacts, explicit initializer/CLI, measured full-volume generation, visitor access/browser, hosting outside RF and backup/deployment are named subsequent increments requiring their written plans. Neither synthetic fixture parties nor the new method certify those outcomes. No schema migration, pure recipe change, new public API or infrastructure setup is required here.

The approved design already specifies atomic per-stage persistence; this plan details that prerequisite without executing the obsolete compact-only Receiving plan. Owner review of this written plan is still required before any implementation action. Existing separate-implementer/reviewer method is preserved; do not ask for continuation between its two accepted tasks.
