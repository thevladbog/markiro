# US-11 Unit-Owned Native / Trace Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Produce native and Trace evidence per unit through one fresh terminal observation, without an all-native prepass or weaker acceptance.

**Architecture:** A closed unit composition owner produces its own native facts, immediately evaluates real Trace/readiness/history and checks/persists progress. Existing standalone APIs stay independently guarded; final coordinator assembles unchanged all262 output from checked unit outputs.

**Tech Stack:** TypeScript/NestJS, Drizzle/PostgreSQL, Vitest, immutable domain codecs, existing native/read-model services and Node CI ownership tests.

**Spec:** `docs/superpowers/specs/2026-10-13-us-11-unit-trace-composition-design.md`

## Global Constraints

- Only `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, `codex/us-mvp`; start after Cases-owned application source/relevant native review acceptance.
- No cached caller proof, transaction input, skip flags, caller callback, exported receipt-only recording API or new native retries.
- Each public unit invocation: actual target/owner/profile -> strict selector -> ReferenceSeed[mode] -> current header -> ordered selected-unit native path -> post-COMMIT Trace/readiness/history -> progress.
- Incomplete regular chain uses original four-header revision2/receipt discriminator and ordered Receiving/Transformation/Cases/Shipping[mode], proving completed ancestors; completed chain uses one terminal projection.
- Preserve exact existing native error whitelist/cause identity and regular/special annotation behavior. Unit order0..259/correction/orphan intentionally supersedes old global native-suffix error precedence.
- Original complete full-seed test body, all262 ranges, every assertion/snapshot,900000ms body/60000ms drain remain byte-identical; no unchanged full rerun on fusion alone.
- No schema/migrations/public routes/dependency/env policy/RU/main/Station/Requests/PR/release/hosting; root owns commits/push, implementer no agents/commit/push.
- Native runs only explicit isolated US_TEST_DATABASE_URL localhost55432 with DATABASE_URL unset; owned children tracked/drained/normally dropped/absent, unknown resources preserved. No simultaneous local native workers or mutable build overlap.

## Review Focus

- Missing/pending Reference fails with its exact namespace/annotations, not a later generic Shipping/Trace error.
- Earlier completed ancestor drift precedes a later missing stage within an incomplete chain.
- Native COMMIT failure cannot release a composition result or install a Trace receipt.
- Changed current lifecycle or membership between native and Trace observations cannot be hidden by a carried projection/authority.
- Correction processing must not create/verify orphan before correction Trace; exact special digests/history remain live.

---

### Task 1: Complete closed unit owner, producer/evaluator/progress interfaces

**Files:**

- Create `apps/api/src/modules/traceability/demo/us-dataset-unit-composition.ts` (context+unit-only owner, typed output).
- Modify `us-dataset-shipping-seed.ts` only to expose its existing post-COMMIT initializer projection as an independently guarded producer output.
- Modify `us-dataset-trace-readiness.ts` and `us-dataset-trace-readiness-stage.ts` for private sharing of native production/evaluation/progress, retaining all existing entry behavior. No public method accepts expected/verified facts.
- Optional create `us-dataset-native-failure.ts` by exact extraction of existing semantic error mapping if the new owner needs sharing; existing whitelist/identity unchanged.
- Create `apps/api/test/us-dataset-unit-composition.e2e.test.ts` and add its exact CI selector to reviewed prepared-services job/helper/independent pin.

**Interfaces:**

```ts
class UsDatasetUnitCompositionStore {
  constructor(db: Db);
  initialize(
    context: UsDatasetContext,
    unit: UsDatasetTraceReadinessUnit,
  ): Promise<UsDatasetUnitCompositionResult>;
  verify(
    context: UsDatasetContext,
    unit: UsDatasetTraceReadinessUnit,
  ): Promise<UsDatasetUnitCompositionResult>;
}
```

`UsDatasetUnitCompositionResult` is an owned deeply frozen output discriminated by top-level `kind: "regular" | "correction" | "orphan"`, with `trace: UsDatasetTraceReadinessResult` and a native entry. Current dataset identity is provided by its checked Trace result. Regular native entry uses existing `UsDatasetRegularResult["chains"][number]`; correction/orphan use existing special result entries. This output is consumed only for assembly, never fed back as authority. It contains no private keys/credentials/provider data.

- [ ] Read full spec and scoped approved design review, actual native/progress/evidence/assembly modules and tests. Independently pin original full-seed test bytes before editing anything.
- [ ] Build affected API dependencies with the declared Corepack pnpm version. If ordinary nested pnpm differs, use an ignored task-local executable shim for command PATH only; no policy/version/dependency change.
- [ ] Write actual owned-fixture missing-method RED before implementation:

```ts
const actual = await owner.initialize(context, { kind: "regular", index: 0 });
expect(actual.trace.unitKey).toBe("chain_0000");
if (actual.kind !== "regular") throw new Error("Expected regular composition");
expect(actual.native.shippingResultDigest).toBe(expectedCheckedShippingDigest);
```

Use real saved prerequisites and existing fixture guards/drain; setup failure is not RED. Native body/setup deadlines unchanged.

- [ ] Implement strict selector/context and independent Reference ownership/order. Exact fresh/pending/drift reference errors and annotations must match the spec. No caller preverified-reference flag.
- [ ] Implement original four-header discriminator, ordered incomplete native methods and one terminal output on completed paths. Initializer projection releases only after awaited atomic COMMIT. Preserve standalone Shipping/Trace/progress APIs and prerequisite-only standalone stage initialize.
- [ ] Share evaluator/progress only privately: same actual per-lot graph/readiness/history, comparisons/digests, predecessor/intent/receipt/key/revision/competitor checks. Never export a method that records supplied verified facts. Discard producer observation after this unit invocation.
- [ ] Implement special per-kind native sequence, current checked output summaries and exact amended/void history, with existing repeated special proof retained for this slice. Do not call combined special coordinator or use an earlier cached orphan result.
- [ ] Add every exact Review Focus case and reference/incomplete-stage matrices from the spec. Test indices0/1/181/259 plus correction/orphan, partially prepared/complete/replay, actual40001/COMMIT failure, concurrent same-key winners, post-COMMIT writer barrier and authority changes, full-state no-write equality and output ownership/freezing/bounds. Keep old assertions; any needed old hook adaptation must be explicitly reviewed before changing it.
- [ ] Measure actual forwarding SQL/service phases and equal outputs versus previous standalone path, separating references, creation, terminal, read models and progress; include a small populated range. No SQL parameters logged, no source-count guesses or full budget claim.
- [ ] Add exact native CI selector/literal pin and missing/duplicate/filter denial, preserving complete older ownership/historical tests and budgets. Run new suite and unchanged Trace proof/stage, terminal projection and bounded native-coordinator regressions (not original full gate):

```sh
corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-unit-composition.e2e.test.ts test/us-dataset-trace-readiness.e2e.test.ts test/us-dataset-trace-readiness-stage.e2e.test.ts test/us-dataset-shipping-projection.e2e.test.ts --maxWorkers=1
node --test tools/us-development/test/*.test.mjs
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
git diff --check
```

- [ ] Focused Prettier, pin unchanged full-seed bytes again, self-review and complete report with raw failures/RED/measurements/counts/cleanup/evidence limits. Return unstaged source for root checkpoint and independent spec/quality review. Do not proceed to Task2 before root accepts that review.

### Task 2: Exact all262 coordinator assembly from owned unit outputs

**Files:**

- Modify `apps/api/src/modules/traceability/demo/us-dataset-trace-readiness-seed.ts` to consume the accepted Task1 owner.
- Add pure strict assembly coverage to existing `us-dataset-native-assembly-contract.test.ts` only if its existing assertions need new adapter proof; no helper semantics relaxed.
- Create `apps/api/test/us-dataset-unit-coordinator.e2e.test.ts` for bounded prefix/error/progress and output assembly behavior; exact CI selection/pin/denial alongside Task1.
- Do not modify `us-dataset-trace-readiness-seed.e2e.test.ts` or its fixture.

**Interfaces:**

- Consume `UsDatasetUnitCompositionStore.initialize/verify` and exact typed outputs accepted in Task1.
- Produce unchanged `UsDatasetTraceReadinessSeedResult`, invoking unchanged `makeUsDatasetNativeAssemblyInput` over exactly260 regular and both special checked entries.

- [ ] Read Task1 accepted report/interfaces and current coordinator/assembly. Record the current original full test byte hash and compare to pre-Task1 pin.
- [ ] Add a failing bounded coordinator test: actual receipt fault at chain1 must surface before later native work, with chain0 trace complete/chain1 intent pending/original key retained and untouched suffix. No caller proof or fake Ready rows.
- [ ] Replace preliminary nativeall pass with exact sequential unit calls. Assemble full regular identity/range/state/false flag and special identity/state/false flag only after all entries return; feed unchanged strict native assembly factory. Preserve exact final object shape, fresh deep ownership/freezing, all ordered digests and JSON size bound.
- [ ] Test changed global precedence explicitly: early Trace fault versus later native fault; preserve local namespace/cause and strict native mismatch translation only around native work. Add exact pending resume on bounded prefix, cross-tenant/original-owner denial and no-write verify/replay. Pure assembly tests still require all260 entries and bothspecial entries; bounded native tests are not full acceptance.
- [ ] Measure complete bounded-prefix/range coordinator creation/verify/replay and table snapshots with real SQL counters, including all Reference costs; compare output parity and error contracts. Update the complete `G + 2V + 3R + H` sensitivity model with actual changed-path observations and uncertainty, not a green forecast based on one proof.
- [ ] Run new bounded coordinator suite, existing pure assembly/native contract regressions, all Node tools/API types/lint/build/focused format/diff; verify original full test/fixture bytes unchanged. Report complete source scope, actual native cleanup and remaining full runtime gate.
- [ ] Root checkpoints only scoped files, obtains independent Task2 review, then most-capable complete selected-plan source review including rulings and all Task1/2 diff.

## Full acceptance sequencing

- [ ] Judge measured whole-test margin after Cases and fusion; if insufficient, specify and review a separate closed terminal-verification/read-context optimization. No generic transaction cache or removal of content checks.
- [ ] Only after a source-reviewed complete-budget candidate and focused changed-path evidence, authorize one actual original full gate/CI at exact changed SHA with no body/assertion/deadline edits. Read exact failure phase before any further change; no unchanged retries.
- [ ] Native fixture-enabled same-SHA CI, full census/fault/resume/verify/replay and cleanup must actually pass before integration acceptance. Request packages/viewer/browser/hosting remain separate later work.

## Accepted bounded Task 2 execution continuation — 2026-10-15

Independent preflight accepted the finite continuation in the plan's ignored SDD
workspace (`task-2-continuation-proposal.md`, SHA256
`067195d94fa02412de85d16a8522272f73197ea31cc84576d11181c00df20bde`;
`task-2-continuation-preflight.md`). Root accepts the following execution-only
exception, not completion of every Task 1 requirement:

Permit source implementation and separately approved bounded correctness
execution of existing composition Task 2 against the independently accepted
130-case selected-owner semantics and reviewed original two-test revalidation.
This permits consumption of the current owner interface, not acceptance of all
Task 1 work. Keep Task 1 comparative/populated-range evidence, terminal joint
performance gates, complete `G + 2V + 3R + H` margin, unchanged full260+2 and
full API/same-SHA CI open until their own evidence is accepted. Historical
043/044 results stay immutable; any new affected-regression acceptance is limited
to its independently reviewed actual inventory. No deadline, assertion, proof,
source boundary or release permission changes. Only coordinator-dependent budget
evidence is circular; the earlier owner comparative/range obligations remain owed.

The first RED recipe is amended because a lone Trace1 receipt fault on the old
coordinator would create all native units before reaching it. Prepare real native
units 0 and 1 in the new test's stated precondition (eight native chain stage rows
plus the completed references row). Install real Trace1 receipt UPDATE40001 and
Receiving2 intent INSERT23514 faults. Old source must reject the later native
23514 before any Trace progress; the fused owner order must reject the earlier
Trace40001 with Trace0 complete, Trace1 pending and the suffix untouched. That
actual wrong-error assertion, not a timeout/setup failure, is the required RED.
Use test-local preowned partial-install cleanup; do not edit the shared fixture.

The finite continuation retains exactly six implementation paths, seventeen new
native cases, eight additive pure all262 adapter cases, unchanged assembly helper,
all original tests/fixtures/counters/budgets and separate source/runtime reviews.
For pending progress the only permitted existing-row changes are `receipt` and
`revision: 2`; all timestamps and other columns stay exact. No full run, further
native inventory, source change or publication follows automatically. Root grants
each concrete code/RED/GREEN/runtime dispatch after the previous gate completes.
User authorization permits a later US-only push and CI verification after local
acceptance, never release/deployment or changes to main/RU/Station.

### Task 3: Finite same-state comparative measurements

The accepted 2026-10-15 specification amendment replaces exclusive internal phase attribution with observable inclusive public-call segments. It does not waive semantic assertions, deadlines, complete-budget review or actual full/API/CI gates. Historical causal Cases-only/fusion savings remain unproven. The independently reviewed finite design is retained in the plan workspace as `measurement-continuation-proposal.md` and `measurement-continuation-preflight.md`.

**Scope:** create `apps/api/test/us-dataset-composition-measurements.e2e.test.ts`; append its exact selector once to the existing prepared-services workflow command, helper list/job literal, and independent ownership pins. These are exactly four implementation paths. No product, shared helper, original test, fixture, counter, schema, dependency or environment change.

**Preconditions:** corrected coordinator seventeen cases and original adjacent four-file regressions actually pass with ordinary owned cleanup. Consume their C02–C06/C17 measurements first. They do not provide the following same-state differential or fresh181/259/special observations; all twelve cases below are therefore selected, without runtime filtering.

| ID  | Exact case name                |
| --- | ------------------------------ |
| M01 | same-state-regular0-verify     |
| M02 | same-state-regular0-replay     |
| M03 | populated-four-regular0-verify |
| M04 | populated-four-regular0-replay |
| M05 | same-state-correction-verify   |
| M06 | same-state-correction-replay   |
| M07 | same-state-orphan-verify       |
| M08 | same-state-orphan-replay       |
| M09 | fresh-regular181               |
| M10 | fresh-regular259               |
| M11 | fresh-correction               |
| M12 | fresh-orphan                   |

- [ ] Read the complete selected design and preflight. Capture fresh actual dirty baseline after the explicit controller spec/plan amendment; preserve every unlisted byte and immutable prior artifact. Existing prototype/transaction/public APIs receive no new proof or observer parameter.
- [ ] Use unchanged `specialFixture(base)`, tracked `h.phase`, default5000 bodies and existing60000 preparation/drain. Only completed-state cases prepare their actual state in hooks; fresh cases start without header/References/native state and create it inside their body. All measurement/parity/census/snapshot assertions remain in bodies.
- [ ] For M01–M08, compare the current standalone per-kind native sequence plus standalone Trace stage against the closed owner on the SAME completed tenant/header/IDs/operation keys. Both modes must return matching independently checked native and complete Trace results. Use full public snapshots before, between and after and require all equal; preserve original receipt/key and owned/frozen/bounded output. Regular0 alone versus real completed0..3 population is distinct from whole-prefix measurements. Require exact twenty native/Trace stages PLUS the Reference row, twelve lots,240 boxes and eight Shipping roots for populated cases.
- [ ] Regular baseline is current regular range0/count1 followed by standalone stage. Correction baseline is the actual journal/References/header/per-kind lifecycle/corrected Transformation/Cases/Shipping sequence plus stage; orphan uses the corresponding per-kind void lifecycle plus stage. Never call combined special coordination or mislabel both units as one. Retain all prefix work in measurements.
- [ ] M09–M12 create their selected real unit in the body, then independently verify the exact Shipping/corrected/special/Trace facts, native digests, receipts, global lot/event/case census, amended/void history and absence of other units. Saved values compared only to themselves are insufficient. Setup must not preinstall fresh prerequisites.
- [ ] Use only unchanged forwarding `countActualQueries`, sequential nonnested segments with real outcomes, no SQL parameters. Record complete owner/standalone segments, snapshots/census/oracle reads and whole-body wall time; every body DB dispatch is charged once. A failed segment remains failure, never a successful sample. Inclusive stage/owner costs cannot be subtracted to invent exclusive internal phases. No elapsed-time speedup/causality claim from one ordered pair.
- [ ] Preserve all previous CI selectors, failure/skip/filter/missing/duplicate/foreign denials, predecessor pins and30-minute jobs. Run focused format, all Node tooling and API typecheck/lint/build serially with DB fixture variables absent. Freeze exact four-path diff and actual logs; independent source/spec/quality review before any native dispatch. New test-only evidence requires no artificial product RED.
- [ ] Controller separately authorizes one whole twelve-case native attempt through the approved clean loopback owned runner, no filter/retry/timeout override. On failure preserve exact phase/error/cleanup and stop for review. Fresh/paired correction5000 fit is unproven; do not move work into setup or enlarge limits.
- [ ] Independently review actual observations and ordinary owned cleanup. Then produce direct/proxy/unmeasured low/central/conservative complete-body scenarios using exact branch counts60/120/39/40/1/1/1 and all real overhead, with uncertainty and explicit residual900000-body/1800000-job margin. Small samples do not prove full262 scaling; a missing dominant assumption requires a separately finite evidence decision, not an automatic full run.
- [ ] Complete selected-plan source review, one separately authorized unchanged whole full260+2 gate, ordinary isolated full API, scoped commit/push and same-SHA CI remain required. No release, deployment, PR, main/RU/Station changes or hidden weakening follows from this measurement task.

### Task 4: Bounded corrected Shipping terminal readers after M11 RED

The first actual Task 3 invocation recorded eleven passes and one unchanged5000ms body timeout in fresh-correction, before its final parity/census assertions. Preserve that failed evidence. This task is a new production candidate, not acceptance of the failed measurement or a promised timing improvement. Implementation requires independent finite-design preflight; runtime requires a separate source-review decision.

**Execution requirements:** the plan workspace's `task-3-m11-diagnosis-proposal.md`, `task-3-m11-diagnosis-proposal-r1.md` and `task-3-m11-diagnosis-proposal-r2.md`, in that precedence order, define the complete finite implementation/test schedules. Read all three completely, together with their final independent preflight. R1 replaces the original tentative choices; R2 replaces only counter observation schedules. Their original frozen hashes and review decisions are retained in `progress.md`. No implicit scope expansion follows from a compiler error or failed test.

**Production allowlist:** exactly these ten existing files under `apps/api/src/modules/traceability/demo/`:

- `us-dataset-corrected-shipping-seed.ts`
- `us-dataset-corrected-shipping-verify.ts`
- `us-dataset-corrected-shipping-prepare.ts`
- `us-dataset-corrected-cases-verify.ts`
- `us-dataset-corrected-cases-prepare.ts`
- `us-dataset-corrected-transformation-verify.ts`
- `us-dataset-corrected-transformation-prepare.ts`
- `us-dataset-special-verify.ts`
- `us-dataset-special-evidence.ts`
- `us-dataset-terminal-read-contract.ts`

**Test/CI allowlist:** create `apps/api/test/us-dataset-corrected-terminal-reader.e2e.test.ts`; append only its whole-file selector and literal ownership/denial pins in `.github/workflows/us-development.yml`, `tools/us-development/test/support/prepared-services-owner.mjs`, and `tools/us-development/test/dataset-prepared-services-ownership.test.mjs`. All original tests, measurement cases, fixtures, counters, budgets and earlier evidence stay exact. Controller owns canonical documentation, commits and remote actions; implementer does not edit other paths or spawn agents.

- [ ] Capture a fresh source/artifact baseline after the controller's two canonical-document amendments. Preserve every unrelated dirty/untracked path and original protected hash. The frozen M11 performance failure is the meaningful RED; do not rerun unchanged source or substitute a missing-export/setup failure.
- [ ] Give only corrected Shipping's final atomic verifier a lexical raw-reader owner, allocated after application/immediate triggers and disabled/cleared before receipt persistence. Await native COMMIT before returning the original public result. Keep every special/corrected proof, SQL lock/order, comparator, error/cause/annotation and facade signature unchanged.
- [ ] Route fixed dependencies through existing native/Core implementations, with fresh wrappers for ordinary callers and orphan. Reuse only present raw rows after exact successful lock protection; clone all retained Date/JSON values. Leave the amended-current event fresh. Include existing locked, validated authorization-profile reuse, but always reread membership and capabilities sequentially first. All absence, partial batches, ranges, locations, products/product profiles, journal, operations/audits, bases/origins/consumers/balances/history remain fresh.
- [ ] Bind every adapter to the exact transaction, tenant, actor and expected database identity; invalidate on success, verification failure and later COMMIT failure. No public allocator, injected proof, skip flag, generic callback/cache framework, application-time reuse, cross-call/stage/transaction state or broader stage optimizer.
- [ ] Necessary-only local adapter duplication is explicitly accepted to avoid rewriting the accepted regular owner. Reuse native/Core/lock logic, not a wholesale regular-owner copy. Report a paired security-mechanics/difference inventory: corrected lock keys, fresh amendment event, special propagation, void rather than projection result, binding/clones and cleanup. Maintenance divergence is an explicit cost, not a waived quality gate.
- [ ] Implement exactly eighteen cases: CT01 completed differential plus binding pair; CT02 replay clone/absence/partial/live-forward checks; CT03 fresh Shipping; CT04 real deferred-COMMIT rollback pair; CT05 same-transaction membership-denial rollback pair; CT06 between-call profile change; CT07/08 original/current revision drift; CT09 root lifecycle drift; CT10/11 input/output lot drift; CT12 document drift; CT13 party drift; CT14 synthetic marker drift; CT15 Shipping child drift; CT16 audit drift; CT17 protected-lot real writer; CT18 post-COMMIT Shipping void before actual Trace. Pin exact mutations, rowCount/before-after snapshots, original error descriptors and fresh-wrapper control equality as specified in R1. Keep all assertions/mutations inside default5000 bodies and existing tracked60000 setup/drain, with no new setup prerequisites for fresh boundaries.
- [ ] Cover all36 bound adapters directly through the real forwarded corrected Core: binding dimensions, clone isolation, no retention of missing/partial/range observations, and revocation after successful return, actual authorization rejection and deferred-COMMIT rejection. Forward real functions/results; never fabricate proof.
- [ ] Use unchanged counters only before transaction acquisition. CT01 has four public calls: two same-state whole-facade differential calls, then identical binding control/negative schedules including identical auxiliary transactions. CT04/05 have two identical real-error schedules each; only the negative adds revoked calls. Keep each outer window through post-exit calls; equal complete totals prove zero additional dispatches, not absolute zero SQL. CT02 uses actual stateless/native forwarding witnesses, no held-client counters. No nested counters, query-text tracing, new profiler/helper or guessed query/time threshold.
- [ ] Preregister every release, owned-work drain, fault acquisition/cleanup and spy restoration before launch/CREATE. Settle/drain before restoring spies, removing faults or closing clients; preserve primary plus cleanup failures and test-finish fallback. External writers never wait for COMMIT while blocking the owner that must perform it.
- [ ] Before any native dispatch, freeze implementation/self-review plus a task-scoped diff, paired adapter inventory, source/artifact integrity and actual static results: API typecheck/lint/build, affected dependency builds if needed, focused formatting, `git diff --check`, and complete US-development Node ownership/denial checks. Obtain independent spec/quality review. No runtime is implicit in this code-only task.
- [ ] After separate controller GO, run the new whole eighteen-case file, then unchanged `test/us-dataset-special-seed.e2e.test.ts`, `test/us-dataset-special-locks.e2e.test.ts`, `test/us-dataset-corrected-transformation-seed.e2e.test.ts`, `test/us-dataset-corrected-transformation-locks.e2e.test.ts`, and `test/us-dataset-corrected-cases-seed.e2e.test.ts`; the latter includes corrected Shipping coverage. Original four-file composition regressions and130 owner semantics remain required. All local runtime/build mutations stay serial, using the approved isolated owned runner and original budgets. Preserve any actual failure and stop for review, not an unchanged retry.
- [ ] Only after source/regression acceptance, authorize one new whole twelve-case measurement invocation with its original exact bytes. Require all twelve, including M11 final parity/history/post-census, and assess actual margin. If still RED, preserve evidence and obtain a new bounded decision; no automatic expansion, oracle omission/parallelization/setup move or timeout increase.
- [ ] Complete-budget sensitivity and positive-margin dispatch review, original unchanged full260+2, ordinary isolated full API, scoped US-only push and same-SHA CI remain distinct mandatory gates. No PR, release, deployment, main/RU/Station or hosting change is authorized by this task.
