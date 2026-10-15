# US-11 Closed Terminal Readers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Each task has a separate implementer and independent reviewer. Steps use checkbox syntax. The user has already selected this execution method and authorized implementation without routine approval questions.

**Goal:** Remove redundant, provably stable raw point observations from regular Shipping terminal verification while preserving fresh authority, relations, native semantics and every original acceptance budget.

**Architecture:** First factor native getter/history algorithms into mandatory-dependency internal cores and unchanged fresh facades. Then route the recursive demo verification graph through narrow internal dependencies. Finally the fixed Shipping owner constructs a runtime-private, no-write interval containing only the raw slots selected by the specification. No public owner accepts a reader, proof or transaction.

**Tech Stack:** TypeScript, Drizzle/PostgreSQL READ COMMITTED, existing Vitest native fixtures, Node 24 and repository-pinned Corepack pnpm. No new dependency or migration.

**Spec:** `docs/superpowers/specs/2026-10-14-us-11-closed-terminal-readers-design.md` (read completely, including its eligibility matrix). This prerequisite does not complete `2026-10-13-us-11-unit-trace-composition.md` or its remaining coverage/coordinator tasks.

## Global Constraints

- Work only in the existing isolated `codex/us-mvp` checkout. Preserve the existing owner-procedure/unit-composition changes and all unrelated files.
- All original 5000/900000/60000 budgets, assertions, fixtures and whole performance-test files remain unchanged. No filter/retry/setup relocation to pass a timing gate.
- No release, deployment, PR, main/RU/Station change, cloud resource, user `.env` change or shared/live database write. No push or commit until the separate reviewed acceptance boundary permits it.
- No exported runtime scope factory, accepts-callback wrapper, token constructor, branded capability, transaction property, WeakMap or query proxy in product code.
- Keep every membership LIMIT 1 selection, JS capability policy, owner cardinality, journal/header/stage/receipt digest, collection, absence, audit, operation, balance, origin, consumer and private-xmin observation fresh.
- Keep all existing locking and range SQL, its order and comparisons. No stronger/earlier/new locks. Raw values may be retained only after real protecting locks and the original complete observation; no error/absence/DTO/derived-result cache.
- Public native transaction-accepting methods remain fresh after caller writes. Closed readers are created only inside the Shipping owner's final verify callback, after application writes, and destroyed before receipt persistence/COMMIT.
- One mutable/native/build executor at a time. Read-only reviewers may overlap. Use invocation-owned random native DBs, ordinary migrations, normal drain/DROP/absence; no FORCE or unknown cleanup.
- Record actual argv/cwd/exit/signal and full sanitized raw output. Existing RED45 Shipping timings, composition RED2, original full262 and same-SHA CI remain open; a carried baseline is not a green result.

## Review Focus

1. A matching extra membership or relation can appear despite a row lock: Task 3 must exercise fresh member/owner selection and relation cardinality after an actual concurrent insert.
2. A native DTO can contain derived/current data or mutable JSON/Date references: Tasks 1 and 3 must test raw-to-response ownership and rerun current basis/history computations.
3. A partial/ID-only lock result is not a full row and a requested key is not necessarily a returned key: Tasks 2 and 3 must test failed/partial document locks and conservative miss behavior.
4. Guard/parse order differs between getters: Task 1 must pin authorization-before-ID for ordinary getters and ID-before-authorization for product profiles, including wrong-tenant and empty-list behavior.
5. Application triggers, receipt failures and ambiguous COMMIT cannot certify stale or uncommitted output: Task 3 must exercise real own writes before first observation, rollback/receipt/COMMIT failure, and post-COMMIT freshness.

## Evidence and execution ledger

The source-only v2 proposal and its independent ACCEPT review are retained under `.superpowers/sdd/2026-10-14-us-11-owner-provenance-procedural/`; the canonical spec above is the implementation authority. No speedup is inferred from 2520 driver calls or the CPU profile. Do not repeat the profiler. The ordinary API full run uses a separate sanitized environment and does not enable opt-in US native suites.

Create a new ignored SDD workspace for this plan's briefs, saved exact baselines, scoped review packets, raw logs and actual command manifests. Do not overwrite the owner-procedure evidence. Before editing, capture `git status --short`, exact scoped files and hashes of the original composition/full-test/fixture/counter. The original composition test SHA is `4a10ddcc3ddb1c382b540d0f0f41aaa0c28d8597ca5d11f573dacc8a76566c0d` and the full seed test SHA is `90cd28681b0ee5a4c07fbd50fd8e75068dae38bcaae898c4e8fd5251bf483e1f`.

### Exact command inventory

Run commands through a durable capture wrapper with a fresh tag, actual exit/signal and complete sanitized logs. Native commands require the existing canonical local `preparedServicesFixture` configuration, ambient `DATABASE_URL`/PG settings removed and explicit `US_TEST_DATABASE_URL` set in memory; never print that value or source user `.env`. A skipped native file is not PASS. Missing loopback permission requires scoped escalation, not an altered test or remote target.

```sh
# Task 1 RED/GREEN, original per-test limits:
corepack pnpm --filter @markiro/api exec vitest run test/us-terminal-native-readers.e2e.test.ts test/us-master-data-authorization-read.e2e.test.ts --maxWorkers=1 --reporter=verbose
# Task 2 RED/GREEN:
corepack pnpm --filter @markiro/api exec vitest run test/us-terminal-verification-routing.e2e.test.ts test/us-dataset-shipping-locks.e2e.test.ts test/us-dataset-shipping-projection.e2e.test.ts --maxWorkers=1 --reporter=verbose
# Task 3 correctness:
corepack pnpm --filter @markiro/api exec vitest run test/us-terminal-closed-reader.e2e.test.ts --maxWorkers=1 --reporter=verbose
node --test tools/us-development/test/terminal-reader-ownership.test.mjs tools/us-development/test/dataset-prepared-services-ownership.test.mjs
# Static gates after each source task; do not use native env for these:
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
git diff --check
# Only after the Task 3 correctness/review gate; original complete two-test file:
corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-unit-composition.e2e.test.ts --maxWorkers=1 --reporter=verbose
# Ordinary full API gate after source changes, owned sanitized environment:
node tools/us-development/run-api-validation.mjs full
```

Focused formatting checks must name the actual changed files from the scoped task packet. The eventual unchanged Shipping221 command is the eight files already captured in `task-2-report.md` under the owner-procedure evidence workspace; use that exact argv, not a filtered subset labelled as aggregate.

### Task 1: Native reader cores with unchanged fresh facades

**Deliverable:** Shared native algorithms can use operation-specific raw readers; every existing public/native entry still binds fresh SQL. No retained state or optimization yet.

**Files:**

- Modify: `apps/api/src/modules/traceability/master-data/us-master-data-support.ts`, `master-data/us-master-data-store.ts`.
- Modify: `apps/api/src/modules/traceability/catalog/us-catalog-store.ts`, `products/us-product-profile-store.ts`, `documents/us-reference-document-store.ts`, `lots/us-lot-store.ts`.
- Modify: `apps/api/src/modules/traceability/receiving/us-receiving-history.ts`, `receiving/us-receiving-basis.ts`, `receiving/us-receiving-store.ts`.
- Modify: `apps/api/src/modules/traceability/transformation/us-transformation-persistence.ts`, `transformation/us-transformation-store.ts`.
- Modify: `apps/api/src/modules/traceability/shipping/us-shipping-history.ts`, `shipping/us-shipping-finalization.ts`, `shipping/us-shipping-draft.ts`.
- Create: `apps/api/src/modules/traceability/demo/us-dataset-terminal-read-contract.ts` (type-only contracts).
- Create: `apps/api/src/modules/traceability/master-data/us-master-data-read.ts`, `catalog/us-catalog-read.ts`, `products/us-product-profile-read.ts`, `documents/us-reference-document-read.ts`, `lots/us-lot-read.ts` (native read algorithms, mandatory read/authorize dependencies and stateless fresh bindings). Paths after the first prefix are relative to `apps/api/src/modules/traceability/`.
- Test: `apps/api/test/us-terminal-native-readers.e2e.test.ts`; affected existing authorization/getter/history suites.

**Interfaces:**

Consumes the current native stores, schemas, row types, pure response builders and exact transaction signatures. Produces mandatory internal native reader cores plus stateless fresh bindings and the type-only raw point-reader contracts from spec section 2. Full recursive `UsDatasetTerminalReadStores` and `UsDatasetTerminalDependencies` are added in Task 2 when their fixed lock operations are defined; no unresolved future-function import is permitted in Task 1. Do not broaden these contracts to a generic query API. Existing public methods retain their arguments/results.

- [ ] **Step 1: Pin the concrete extraction cut and write failing native characterization tests.** Read each touched getter/reader and its adjacent tests in full. Save its original query/guard/error sequence. Use the existing owned fixture and compare exact known fixture responses, role/capability errors, lifecycle identities, current basis/history and full-table no-write snapshots. Exercise the new mandatory core entry before it exists so failure is a missing implementation, not a DB/env error. Representative test structure:

```ts
const before = await fixture.snapshot();
const actual = await readReceivingLiveRecordCore(tx, tenantId, eventId, freshReaders);
expect(actual).toEqual(expectedNativeRecord);
expect(await fixture.snapshot()).toEqual(before);
```

`expectedNativeRecord` must be constructed from the fixture's known IDs and explicit expected persisted fields, not obtained by calling that same core/facade. Add real same-transaction role/profile/time-zone/lot/document writes between two ordinary facade calls and assert the second observes the change. Include malformed IDs paired with denied membership, combined/unknown/Unicode-trimmed roles, empty capability alternatives, missing profile and foreign existing tenant.

- [ ] **Step 2: Run RED once with the canonical native fixture.** Capture actual argv/exit/raw logs. Keep fixture preparation conventional for the new focused suite; do not move work out of any existing acceptance test. Missing core/export is a meaningful RED only if the native fixture was actually enabled and acquired.
- [ ] **Step 3: Extract algorithms and stateless bindings.** Separate membership+JS policy from raw profile loading and pure profile validation, without changing the original facade order:

```ts
const membership = await readOriginalMembership(tx, tenantId, actorUserId);
assertOriginalCapabilities(membership, required);
const profile = await readOriginalProfileAndOrg(tx, tenantId);
return validateOriginalProfile(profile);
```

These names denote the exact shared operations to implement, not new public owner methods. `readOriginalMembership` retains `LIMIT 1 FOR SHARE`; `readOriginalProfileAndOrg` retains the current dependent profile/org CTE. Reuse the same validation code from the original facade; no SQL role-policy copy. Native core raw-reader arguments are mandatory; ordinary wrappers always supply the original fresh queries. Keep typed-event SQL on a miss, root locking/ranges, `assertReceivingRootsReadable`, basis algorithms and every lifecycle/schema gate in one shared implementation. Do not introduce optional scope/proof parameters.

- [ ] **Step 4: Run focused native characterization plus existing master authorization tests.** Capture the actual statement sequence/count of the stateless fresh path and compare it to the saved pre-extraction sequence, as well as exact result/error/cause and no-write output. Both paths must still see own writes; no new retained state is permitted in Task 1.
- [ ] **Step 5: Run API typecheck, lint, build and focused formatting/diff checks after shared dependencies are current.** Use `corepack pnpm turbo run build --filter='@markiro/api^...'` when a dependency output needs rebuilding; do not link mutable output from another worktree. Record skips and any pre-existing timing failures separately.
- [ ] **Step 6: Independent review and repair loop.** Review only the task baseline-to-final diff, characterization/native/static evidence and public-facade freshness. No next task until Critical/Important findings are resolved. Stage/push is not part of this task.

### Task 2: Explicit recursive verification routing and lock operations

**Deliverable:** One common recursive proof algorithm can use ordinary fresh dependencies or the future privately owned readers. The production owner still uses only fresh adapters in this task.

**Files:**

- Modify: `demo/us-dataset-terminal-read-contract.ts`.
- Modify: `demo/us-dataset-reference-verify.ts`, `us-dataset-receiving-verify.ts`, `us-dataset-transformation-verify.ts`, `us-dataset-transformation-verify-content.ts`.
- Modify: `demo/us-dataset-cases-prepare.ts`, `us-dataset-cases-verify.ts`, `us-dataset-shipping-prepare.ts`, `us-dataset-shipping-verify.ts`, `us-dataset-shipping-verify-content.ts`, `us-dataset-shipping-origin-status.ts`.
- Modify: `demo/us-dataset-shipping-locks.ts`, `us-dataset-transformation-locks.ts` only if extracting a fixed operation requires it; retain current exported facade semantics and SQL.
- Create: `demo/us-dataset-terminal-read-fresh.ts` (stateless fresh adapter, no retained scope).
- Create: `demo/us-dataset-terminal-lock-operations.ts` for the exact existing inline reference/profile/document blocks, if needed to keep implementations focused.
- Test: `apps/api/test/us-terminal-verification-routing.e2e.test.ts`; existing native Shipping/lock/origin/projection and Cases regressions.

Paths without an `apps/api/src/modules/traceability/` prefix in Tasks 2–3 are relative to that directory.

**Interfaces:**

Consume Task 1's native cores and type-only dependencies. Produce `verifyUsDatasetShippingProjectionCore`, `prepareUsDatasetShippingCore`, `prepareUsDatasetCasesCore`, `verifyUsDatasetCasesOriginCore`, `verifyUsDatasetTransformationOriginCore`, `verifyUsDatasetReceivingResultCore`, `verifyUsDatasetReferencesCore` and the content/origin-status cores named in spec section 2. Preserve each existing facade signature; only cores take mandatory internal dependencies. Preserve Cases' actual phase/options object and prepared-result type, not an invented Shipping-shaped phase.

- [ ] **Step 1: Write failing routing tests before changing proof code.** Under the native fixture, invoke the new core through stateless fresh adapters and assert exact reference→Receiving→Transformation→Cases→Shipping logical/error order, output digests, receipt identities and full-table snapshots. Test earlier ancestor drift with later missing/pending stage, actual native cause identity and a foreign tenant. The initial RED must establish the missing core/routing contract.
- [ ] **Step 2: Narrow dependency types and wire core-to-core calls.** Current full application bundles remain unchanged and satisfy narrower read subsets structurally. Existing facades construct stateless fresh bindings and invoke the shared algorithm. The future private owner must be able to enter the core directly without falling back to a fresh facade halfway through recursion:

```ts
return verifyUsDatasetShippingProjectionCore(
  tx,
  context,
  rawIntent,
  rawReceipt,
  freshDependencies,
  mode,
);
```

The exact core signature/order is from the specification. Route direct preparation WRITE-capability guards at their original location. Journal methods always delegate to the real journal, without retained profile/header/stage values. Known internal callbacks, such as Transformation's current-origin checker, remain constructed by trusted code and keep their original order; no caller-selected callback enters the owner.

Task 2 routing clarification: Shipping content's native revision read also uses
mandatory internal `shippingRevisions: typeof readShippingRevisions`. The fresh
adapter binds the original native function; the content core calls this supplied
operation, not a direct fresh facade. Task 3 can bind the existing native
`readShippingRevisionsCore` to private readers without touching its original root
share, revision range or lifecycle checks. No public store method or raw-reader
factory is added. Include this operation in deep routing tests and independent
review; identical SQL from a direct fresh fallback is not proof of full routing.

- [ ] **Step 3: Extract finite lock operations without changing SQL or comparisons.** Preserve the exact separate blocks at Shipping preparation reference/profile/document shares, References parent shares, Receiving document shares and Transformation document shares. Return only the actual selected fields. Keep Shipping's document-absence comparison after Cases verification. Do not expose generic `remember/markLocked` methods. The Shipping/Transformation lock wrappers may later qualify only keys proved by their existing cardinality/type/identity checks; a `void` return never qualifies arbitrary receipt descendants.
- [ ] **Step 4: Run routing/native regression tests.** Verify the fresh adapter's statement sequence/count stays unchanged; all lock and range statements still execute. Exercise missing/partial document results and the real lock-order/barrier cases. Reassert exact native namespaces, annotations, causes, audits and no-write snapshots. Do not modify any existing count assertion to accommodate accidental extra work.
- [ ] **Step 5: Run API static/build/format/diff gates and independent review.** The reviewer checks the complete recursive call graph, facade signatures, direct SQL routing and no duplicate lifecycle implementation. Retention is still absent, so no speedup claim or performance-baseline reclassification follows.

### Task 3: Private terminal row retention, native falsification and measurement

**Deliverable:** Only the regular Shipping owner's closed final verifier can reuse selected stable raw rows; all other paths remain fresh. Prove correctness before measuring the unchanged original unit file.

**Files:**

- Modify: `demo/us-dataset-shipping-seed.ts`.
- Modify only Task 1–2 core/contract/lock files needed for the matrix's fixed row observations. Public native store signatures remain unchanged.
- Test: `apps/api/test/us-terminal-closed-reader.e2e.test.ts`.
- Test: `tools/us-development/test/terminal-reader-ownership.test.mjs` (source boundary/mutation defenses).
- Modify: `.github/workflows/us-development.yml` and the existing prepared-services ownership tests/support only for exact additive native selectors and their independent denial/pin checks. Preserve existing owner/unit selector defenses.

**Interfaces:**

Consume Tasks 1–2 shared algorithms and operation contracts. Implement only the runtime-private method from spec section 1:

```ts
#verifyTerminalProjection(
  tx: UsDemoTransaction,
  checked: UsDatasetContext,
  intent: UsDatasetIntent,
  receipt: UsDatasetReceipt,
  mode: "fresh" | "replay",
): Promise<UsDatasetShippingProjection>
```

Its lexical readers bind the exact tx/tenant/actor/database context. They cannot escape and have no public factory or proof-taking entry. Existing `work.verify` calls this method; application and correction/orphan dependencies remain ordinary fresh implementations.

- [ ] **Step 1: Add failing focused native tests and ownership mutants.** Prepare representative persisted states in new focused fixtures, never relocating the original composition/full-seed workload. Assert fresh/verify/replay, regular 0/1/181/259 and partial/pending-stage parity, exact digests/audits/no-write snapshots. Add a strict actual-dispatch expectation for a repeatedly used eligible raw point/profile that fails on the fresh-only implementation, without changing existing performance limits. Use real native statements and retain complete evidence; no new profiler.
- [ ] **Step 2: Implement the complete matrix, not a generic cache.** Lexical state contains one validated raw tenant-profile value, typed maps for parties/lots/documents/roots/event headers, and finite protected-key sets. Actual successful lock operations establish keys; original full reads establish values. Every member/owner/journal/range/current-state read remains real. Fill individual Receiving/Transformation event slots only after the always-fresh range and its original checks. Reuse a finite party set only when every distinct parsed key is present, fully observed and protected; otherwise issue the original entire batch query. All other business rows remain fresh as the matrix specifies. Fresh Shipping root/event rows are ineligible.
- [ ] **Step 3: Enforce lifetime and raw ownership.** Validate active/bound arguments before using a slot. Run the exact native parsers/mappers/schema/capability checks at their original logical point; derived DTOs and digests are not slots. Clear all maps/protected keys/profile and set inactive in `finally` before journal receipt persistence. Do not mutate raw Date/JSON fields or leak their references through returned responses. A failed observation/lock never installs an absent/partial/error slot.
- [ ] **Step 4: Run falsification in the spec's order.** Establish real own-write/trigger visibility before first terminal observation, standalone same-tx facade freshness, profile-before-org/denied-member ordering, concurrent duplicate membership and owner cardinality, each raw row's blocking/update order, missing/unlocked/partial-row fallback, mutated returned DTO ownership, fresh child/revision/support/operation/audit/absence checks, current basis and joined Shipping status linearization. Cover READ COMMITTED/RR where supported, native driver/deadlock/serialization errors, receipt/rollback/COMMIT failures and real post-COMMIT native-to-Trace writer/authority barriers. Test-only query/barrier interception may drive real SQL scheduling; no such hooks ship in product code. The closed interval is not required to tolerate a malicious replacement driver injecting hidden writes after a slot is filled; it must structurally expose no own-write/caller-callback route.
- [ ] **Step 5: Review correctness and confinement before performance measurement.** Independent reviewer checks actual eligible-row provenance and exact core/facade/public boundary. An unproved row stays fresh and its lost saving is reported; no stronger locks or invalidation heuristic. Require focused native tests, static ownership mutants, API typecheck/lint/build, formatting/diff and unchanged original test/fixture/counter hashes.
- [ ] **Step 6: One reviewed changed-path measurement.** Run the whole original `test/us-dataset-unit-composition.e2e.test.ts` with the canonical native fixture, original two 5000-ms tests, original setup/drain and unchanged query counter. If family attribution is necessary, review only bounded test instrumentation beforehand and restore byte-exactly after actual work drains. Do not rerun unchanged failures. Collect actual dispatch counts, durations, result checks and disposal. Include a populated small range plus correction/orphan regressions; do not infer savings from source counts or from a different profiled run.
- [ ] **Step 7: Reconcile integration gates without overclaiming.** Run affected focused native Shipping and unchanged Shipping221 once a changed source/correctness gate justifies it; report all failure names and original limits. Re-run ordinary isolated API only after relevant source changes, using `node tools/us-development/run-api-validation.mjs full`; US opt-in skips are separate. Complete the original unit-composition plan's missing semantic coverage and coordinator before forecasting the full gate. Run unchanged full262 only when measured changed-path costs support its entire `G + 2V + 3R + H` budget with margin, not merely because one prefix passed. Any unresolved timing/functional failure remains RED.
- [ ] **Step 8: Whole-plan independent review and scoped handoff.** List behavior/files, automated results/skips, manual/external checks and unrun gates. Same-SHA GitHub CI remains a later separately authorized push/check outcome, not local proof. No release/deployment/PR. Preserve the evidence workspace while acceptance remains open.

## Self-review and execution handoff

The three tasks separate native semantic extraction, recursive DI and closed-row optimization; each can be independently rejected and has its own test/review gate. Spec sections 1–3 map to Tasks 1–3 lifetime/contracts/lock routing; section 4 maps to Task 3's exhaustive matrix; section 5 maps to all fresh facades and Task 3 falsification; section 6 maps to Task 3 measurement and global gates. The five review-focus classes have explicit owning tests above. Read both the spec and this plan before implementation; task briefs must preserve the exact file responsibilities above, not grant open-ended refactoring.

Standing user preapproval replaces routine confirmation questions, not written design, independent review or evidence. Obtain independent plan review, resolve Critical/Important findings, then start Task 1 with its own implementer and reviewer after the active ordinary API run has fully exited/disposed its owned database. Do not overlap native runners or mutate source during that baseline run.

## Execution status — 2026-10-14

Task 1 is accepted after independent review of its scoped 21-file baseline-to-final
packet: affected native suites 207/207 and the exact two-file inventory 31/31,
without skips; final API typecheck, lint, build and focused formatting passed.
The Shipping initialization failure found during extraction was repaired with
call-time stateless bindings and verified by the original failing revisions suite
and the combined run. No retained rows or recursive routing were added in Task 1.

Task 2 source is frozen: its exact routing/lock/projection inventory passed
54/54, and final typecheck, lint, build and focused formatting passed. Independent
review found no substantial source defect, but Task 2 remains on HOLD: the
eight-file affected inventory has 226 passes and 36 original-limit timeouts.
The timing cause is unclassified; this result is not the full dataset seed gate.
A single independently reviewed source-reference diagnostic completed with
timeouts in both modes; its limited observations do not waive those failures.
The execution-gate correction below passed independent preflight; the coordinator
authorized only Task 3 correctness/implementation steps 1–5 as bounded repair.
Task 2/I1 and Task 3 acceptance remain open.
Full API validation passed before Task 1 source changes (4761 passed, 3707
explicitly skipped), not after them. Original composition, Shipping timing,
full 260+2, post-change API and same-SHA CI acceptance remain open. No release,
deployment, new commit or push follows from Task 1 acceptance. Detailed actual
command evidence and independent reviews remain in the ignored plan-specific
SDD workspace.

## Accepted execution-gate correction — bounded repair only

The single reviewed current/reference diagnostic completed on 2026-10-14.
Both unchanged two-file inventories were RED: current 37 passed/73 timed out,
reference 28 passed/82 timed out, always at 5000 ms. Both had valid source and
normal owned-database disposal evidence. Per-name outcomes changed in both
directions; these observations neither attribute regressions nor waive RED014.
The original 36 affected failures remain open, including two outside that pair.

The authorized next action is a repair continuation of the existing joint
Task 2/Task 3 performance gate, not acceptance of Task 2 or a new architecture:

- [x] Independently review this gate correction before product edits. Task 2's
      source review found no substantial implementation defect; its exact routing
      suite passed 54/54. The open issue is performance, whose intended repair is
      already specified in Task 3. Requiring performance GREEN before implementing
      that repair is circular. This is not evidence that all timed-out assertions
      passed or that current-only failures are harmless.
- [ ] Keep Task 2 and Important I1 explicitly unaccepted. Execute only the
      already-specified Task 3 correctness/implementation steps 1–5 as repair work,
      with a fresh implementer and independent reviewer. Preserve all specified
      facade freshness, raw-slot eligibility, SQL locks, authority and lifecycle
      boundaries. No additional cache, shared snapshot, scope factory, stronger
      locks, public context or new performance hypothesis is authorized.
- [ ] Before edits, freeze the current scoped source and original benchmark,
      fixture and counter hashes again. The implementer receives the full original
      Task 3 brief, this correction, and the open failure inventory. Add focused
      correctness coverage for regular 0/1/181/259 and the exact current-only chain
      0/product-drift cases; original timed-out tests stay byte-identical and RED.
      Do not relocate work from those original tests into setup.
- [ ] Stop for a concrete correctness dependency defect rather than assuming
      a timeout conceals a passing assertion. A row without demonstrated protecting
      lock/full observation stays fresh. Review confinement and native correctness
      before any original performance measurement. If the reviewer identifies an
      unproved prerequisite, resolve that specific gap before dependent code.
- [ ] After changed-source correctness approval, run the original affected
      inventory once under its unchanged budgets and reconcile every original and
      new failure. Neither Task 2 nor Task 3 is accepted until the combined gates
      pass; timing failures in standalone Cases may need a separately reviewed
      repair and are not promised to disappear from Shipping-only retention.
- [ ] Preserve Task 3 steps 6–8: unchanged whole composition measurement only
      after the correctness gate, full 260+2 only when measured complete-work costs
      support the original budget with margin, post-change isolated API and eventual
      same-SHA CI as separate gates. No repeat of the diagnostic pair, no profiler,
      timeout increase, assertion weakening, commit/push/release/deployment follows.

This proposal changes execution dependency order only. It deliberately retains
the original acceptance bar and permits rejecting or reworking the optimization.
Its cost if the dependency judgment is wrong is isolated code rework, never a
released or accepted incomplete proof. Independent preflight accepted this
dependency correction and the coordinator recorded a bounded implementation GO
in the SDD ledger. It does not accept either task or open performance measurement.
