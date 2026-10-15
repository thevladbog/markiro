# US-11 Shipping Prerequisite Journal Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Execute one task, then independent spec/quality review. Steps use checkbox syntax.

**Goal:** Remove repeated Shipping preflight journal reads while retaining every authorization, native proof, lock and acceptance gate.

**Architecture:** Add a top-level independently guarded repeatable-read `readStages` wrapper around the existing transaction-owned batch reader. Shipping uses it for exactly four prerequisites; its later Shipping read, intent capture, atomic application, fresh verification and post-COMMIT projection stay independent.

**Tech Stack:** TypeScript, Drizzle/PostgreSQL, Vitest native fixtures, existing strict Node CI-ownership contracts.

**Spec:** `docs/superpowers/specs/2026-10-13-us-11-shipping-prerequisite-batch-design.md` and its approved independent review in `.superpowers/sdd/2026-10-13-us-11-shipping-prerequisite-batch/design-review.md`.

## Global Constraints

- Only `.worktrees/us-docs-audit`, `codex/us-mvp`; root selects a serial source/native slot after current Cases acceptance. No implementation while that acceptance gate is active.
- One ordinary reader wrapper and four-read replacement only. No context/authority cache, caller proof, content batching, new retry, lock/policy change or native verifier removal.
- Preserve strict existing maximum 256 addresses, allowed pairs, ordered nullable results and duplicate behavior. Empty inputs still authorize and check the header.
- Preserve header-before-selector, all-prerequisite-parse-before-presence, input/identity-before-Shipping and capture-before-atomic ordering.
- Preflight now observes one coherent snapshot, not four snapshots. It supplies no authority to capture or atomic work; existing retained guard shares and later independent guards remain.
- Preserve committed pending-intent semantics after capture followed by atomic rejection; no stale accepted receipt/projection or atomic business writes.
- Original full262 test/fixtures and 900000/60000 deadlines remain byte-identical. Existing focused test/setup deadlines and assertions are not weakened.
- No schema, dependencies, environment policy, public routes, RU/main/Station, Requests, PR, release or hosting changes. Root owns scoped commits/push; implementer does not spawn agents.
- Native tests use a disposable validated US database, DATABASE_URL unset, explicit US_TEST_DATABASE_URL; capture exact owned child identity, drain/drop/absence and preserve unknown resources. No concurrent build/native work.

## Review Focus

- Denied target or absent header wins before hostile address/selector inspection, including empty/oversized requests.
- An earlier missing prerequisite does not suppress a later malformed selected prerequisite; pending prerequisite suppresses the later Shipping read.
- A successful transaction callback cannot release rows after COMMIT fails; retained guard locks release only when the transaction ends.
- Writer or membership/profile changes after preflight remain visible to independent capture/atomic guards, including completed verify.
- Atomic rejection after successful capture leaves exactly the durable pending intent/key, not a receipt or partially applied Shipping business record.

---

### Task 1: Implement and prove the standalone reader and Shipping integration

**Files:**

- Modify `apps/api/src/modules/traceability/demo/us-dataset-journal.ts`: standalone wrapper only; reuse `readStagesInTransaction` unchanged.
- Modify `apps/api/src/modules/traceability/demo/us-dataset-shipping-seed.ts`: replace exactly four prerequisite calls in private `execute`.
- Create `apps/api/test/us-dataset-journal-reader.e2e.test.ts`: actual standalone wrapper boundary/transaction/authorization coverage.
- Create `apps/api/test/us-dataset-shipping-prerequisites.e2e.test.ts`: ordering, drift, durable intent and actual differential measurements.
- Modify `.github/workflows/us-development.yml`, `tools/us-development/test/support/prepared-services-owner.mjs` and `tools/us-development/test/dataset-prepared-services-ownership.test.mjs` only to add exact native selectors and independent ownership pins, preserving older selectors, hashes, budgets and denial cases.
- Existing unchanged regression suites: journal batch, Shipping seed/prepare/verify/locks/projection, and Trace native consumers.

**Interfaces:**

```ts
async readStages(
  raw: UsDatasetContext,
  datasetId: string,
  requests: readonly { unitKey: string; stage: UsDatasetStage }[],
): Promise<(UsDatasetStageRow | null)[]> {
  const value = context(raw);
  return this.db.transaction(
    (tx) => this.readStagesInTransaction(tx, value, datasetId, requests),
    { isolationLevel: "repeatable read" },
  );
}
```

This is a normal public independently guarded entry, not an authorized-context API. Do not use the private `transaction` helper here: it would repeat the guard already inside the existing batch reader.

Shipping consumes the ordinary output locally:

```ts
const [references, receiving, transformation, cases] = await journal.readStages(
  context,
  header.id,
  [
    { unitKey: "references", stage: "references" },
    { unitKey, stage: "receiving" },
    { unitKey, stage: "transformation" },
    { unitKey, stage: "cases" },
  ],
);
```

Keep existing optional receipt checks to narrow the four results, all input construction and the separate later `readStage(..., "shipping")`. Do not add Shipping to this batch.

- [ ] Read root/API instructions, complete approved design/review, current reader, Shipping seed/prepare/verify, target/owner/profile guards, native fixtures and query counter. Confirm CI helper/pin paths in the current tree before editing. Record unchanged full Trace test/fixture hashes and current source SHA.
- [ ] Build API shared dependencies with declared Corepack pnpm before native consumer tests. Use fresh isolated Linux dependencies if the Cases environment establishes that path; never reuse another checkout's mutable node_modules/dist or alter install policy.
- [ ] Add a real failing standalone-wrapper test using an actual journal header and captured pending row, not a mocked checked result:

```ts
const requests = [
  { unitKey: "chain_0000", stage: "transformation" as const },
  { unitKey: "chain_0000", stage: "receiving" as const },
  { unitKey: "chain_0000", stage: "receiving" as const },
];
const before = await f.snapshot();
expect(await journal.readStages(context, header.id, requests)).toEqual([null, captured, captured]);
expect(await f.snapshot()).toEqual(before);
```

Use the existing special-fixture phase/drain contract and explicit isolated base. Run just this case; missing method is the intended RED, setup failure is not RED. Preserve actual output/evidence.

- [ ] Implement the wrapper above and the four-read replacement. No other production behavior changes. Run the failing case to GREEN.
- [ ] Add reader cases for reordered/duplicate/absent/pending/completed results, unchanged input ownership, zero/256/257 requests, malformed shape/extra keys/unknown pairs, header absent/foreign ID/corrupt definition/digest/owner/manifest, corrupt selected intent/receipt/revision, and unselected corrupt row not parsed. Match exact existing error namespaces and full snapshot equality, not merely rejection.
- [ ] Add the native target matrix: actual/expected database or user mismatch, wrong tenant/actor/provenance, revoked membership/capability, changed profile/timezone. Hostile getter addresses prove denial before inspection; empty/oversized requests cannot bypass target/header checks. Use only disposable owned resources.
- [ ] Instrument actual forwarding calls, proving one BEGIN/COMMIT and one native target/header proof, with original driver error identity on query/deferred-COMMIT failure. A second call after committed drift rechecks current state. Native barriers prove retained guard shares through COMMIT, release afterward and a coherent established snapshot despite a later separate writer. Keep caller-owned batch own-write tests unchanged; no memoization.
- [ ] Add Shipping missing and pending matrices for References/Receiving/Transformation/Cases. Assert exact error/annotations and no later Shipping read/capture/atomic work. Paired faults: missing earlier plus malformed later prerequisite yields journal corruption first; pending prerequisite plus malformed Shipping yields prerequisite failure without Shipping read; invalid prerequisite identity/input plus malformed Shipping yields earlier identity/input failure. Exercise target plus hostile selector, absent header plus invalid selector and valid header plus invalid selector.
- [ ] Place real committed writer/profile/membership drift after preflight COMMIT and before capture or atomic work for initialize and completed verify. Compare no-write paths with complete public snapshots. If capture succeeds first, snapshot after capture or explicitly assert its sole pending revision-1/key delta, then atomic business rollback and no receipt/projection. Do not change capture semantics. Keep driver/serialization causes, same-key initializer convergence and original native lock order/barriers intact.
- [ ] Measure the scalar predecessor using actual sequential `readStage` calls and the candidate `readStages` on equivalent owned native rows at indices 0/1/181/259 and a small populated range. Compare exact outputs/full snapshots; include transaction/guard/reference costs, prerequisites separately from whole Shipping initialize/verify/replay and early-failure paths. Do not print raw parameters/credentials. The source hypothesis is 48→12 calls, not a promised measurement or a 900-second forecast.
- [ ] Add exact new CI selectors and independent literal ownership checks plus missing/duplicate/filter denial. Do not modify budgets or existing historical selector/hash assertions. Run focused source gates serially:

```sh
corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-journal-reader.e2e.test.ts test/us-dataset-shipping-prerequisites.e2e.test.ts test/us-dataset-journal-batch.e2e.test.ts test/us-dataset-shipping-seed.e2e.test.ts test/us-dataset-shipping-verify.e2e.test.ts test/us-dataset-shipping-locks.e2e.test.ts test/us-dataset-shipping-projection.e2e.test.ts test/us-dataset-shipping-origin-status.e2e.test.ts --maxWorkers=1 --reporter=verbose
node --test tools/us-development/test/*.test.mjs
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
git diff --check
```

Verify exact regression filenames against the current tree before execution; do not silently omit or replace a missing gate. Full Trace is not included in this task's bounded run.

- [ ] Run focused Prettier; compare pinned original full test/fixture bytes; self-review against every spec/review obligation. Report all actual failures/RED/GREEN, per-phase counts/times, exact child drain/drop/absence and unrun gates. Return unstaged source to root for checkpoint and independent task review; no push or full rerun.

## Acceptance and sequencing

- [ ] Root reads the complete task report, records scoped checkpoint/diff and obtains an independent task review, then most-capable final review of this selected plan. Resolve valid findings without weaker tests or deadlines.
- [ ] Combine only accepted source with the separately planned unit composition change. Update measured `G + 2V + 3R + H` whole-budget assessment; 36 fewer preflight calls alone cannot establish margin.
- [ ] Only a source-reviewed complete-budget candidate receives one unchanged full262 run and same-SHA GitHub CI. Failed/queued/unrun gates remain explicitly open; no deployment/release acceptance follows from source or focused tests.

## Root plan self-review

Spec and approved review coverage maps to the single task's reader, Shipping ordering/drift, measurements and CI steps. All five Review Focus entries have explicit native tests. Signature/types reuse current journal exports; no caller authority is introduced. Durable pending-intent semantics are explicit. No placeholders, weakened gates, source-count performance promises or undeclared production changes are selected.
