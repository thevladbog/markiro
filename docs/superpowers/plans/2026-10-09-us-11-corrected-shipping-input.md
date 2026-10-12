# Corrected Shipping input foundation implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development; independent
> task review plus final increment review. User waived routine approval pauses.
> Do not commit, push, deploy, install or clean up.

**Goal:** bind corrected Shipping intent to actual completed corrected Cases evidence.

**Architecture:** dedicated nested corrected codec/factory and deterministic recipe
plan; reuse accepted validators, leave regular Shipping unchanged. Pure consistency
is explicitly separate from the forthcoming native executor/current proof.

**Tech Stack:** TypeScript, Zod, Vitest and owned disposable PostgreSQL witnesses.

**Spec:** `docs/superpowers/specs/2026-10-09-us-11-corrected-shipping-input-design.md`.

## Global constraints

- Existing isolated codex/us-mvp; preserve all inherited dirty files.
- Exact unchanged recipe: 60-case output, one 50-case shipment, forecast 10 remaining.
- No allocation to specific SSCC boxes; no business writes by the new module.
- Guard the entire combined envelope before any caller-property read; 256 KiB bound.
- Regular codecs/executors, descriptor, workflow, fixture gates/timers remain unchanged.
- No Git publication, install, environment/schema/runtime/CLI change or base seeding.

## Review focus

- Forged completed receipt with recomputed digest still fails exact input/key/ID binding.
- Contradictory revision/null receipt is conflict, not valid pending evidence.
- Inherited array iterator/getter must not execute before rejection.
- Upstream pending is incomplete only after safe coherent validation.
- Recipe forecast is not an assertion of mutable database stock or SSCC allocation.

### Task 1: Corrected Shipping codec, factory, plan and genuine witness

**Files:** create
`apps/api/src/modules/traceability/demo/us-dataset-corrected-shipping-contract.ts`
and `apps/api/test/us-dataset-corrected-shipping-contract.test.ts`; modify only
`apps/api/test/us-dataset-corrected-cases-seed.e2e.test.ts` by adding the witness
inside its existing harness/gate. Append truthful checkpoints to
`docs/us/development-isolation.md` and `docs/us/implementation-plan.md`.

**Interfaces:** exact exported input/parser/factory/plan signatures and field shapes
are in the spec. Reuse `UsDatasetShippingPlanRow` as a type only. Factory consumes
unknown references/amendment/Transformation/Cases envelopes, never a fake regular
alias. No shared upstream code changes or native Shipping result codec.

- [ ] Write focused test against importable empty stub; observe assertion RED:

```ts
const plan = makeUsDatasetCorrectedShippingPlan(coherentInput);
expect(plan).toHaveLength(1);
expect(plan[0]).toMatchObject({
  eventDate: "2026-06-12",
  quantity: "50",
  unitOfMeasure: "case",
  plannedAvailableBefore: "60",
  plannedRemainingAfter: "10",
});
```

- [ ] Implement strict guarded parsing, exact casesInput digest/dataset binding,
      immutable recipe comparison and owned deep freeze. Add pure data-hazard,
      schema/dataset/key/digest/recipe/UUID/normalization mutations and isolation tests.
- [ ] Implement factory with guard before any input reads, reusing
      `makeUsDatasetCorrectedCasesInput` plus existing intent/receipt/result/record-ID
      validators. Require exact requestId and all 121 ordered IDs; classify coherent
      pending versus contradictory evidence as specified, preserving causes/context.
- [ ] Implement one-row plan with source output IDs and literal forecast 60→50→10.
      Test exact date/recipient/BOL/invoice order, no fake current-stock data.
- [ ] Add native test named `binds corrected Shipping input to actual completed corrected Cases evidence without writes` inside the existing one-gate suite:

```ts
const c = await completed();
const before = await h.f.snapshot();
const input = makeUsDatasetCorrectedShippingInput(
  makeUsDatasetReferenceIdentity(c.header.id, c.referenceStage),
  c.amendmentStage,
  c.transformation,
  c.stage,
);
expect(input.cases.operationKey).toBe(c.stage.intent.operationKey);
expect(input.casesInput.outputLotId).toBe(c.result.input.outputLotId);
expect(makeUsDatasetCorrectedShippingPlan(input)[0]).toMatchObject({
  quantity: "50",
  unitOfMeasure: "case",
  plannedRemainingAfter: "10",
});
expect(await h.f.snapshot()).toEqual(before);
```

      Observe real native assertion RED before factory implementation, then GREEN.
      Within the witness test exact pending row/forged key, ID ordering, digest and
      upstream mismatches; all calls preserve the complete DB snapshot. Do not
      fabricate completed upstream business results or weaken prior assertions.

- [ ] Run pure new/regular Shipping/corrected Cases contracts with both DB vars unset;
      configured touched native suite with DATABASE_URL unset and only exact loopback
      US fixture. Native writes must target owned random children only; no static/build
      overlap. No migration/install or user .env read/copy.
- [ ] Verify aggregate API glob/affected ownership and unchanged exact native owner
      before relying on CI; no workflow edit required. Append actual checkpoint and
      unrun boundaries only, not package success. Produce TDD/command/count/scope report.

Controller owns full API package, typecheck/lint/build, formatting, Node ownership,
source-byte preservation and final independent review. All task steps complete
before handoff; native Shipping execution stays a separate next increment.
