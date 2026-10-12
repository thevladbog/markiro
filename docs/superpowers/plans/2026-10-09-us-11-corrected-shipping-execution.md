# Corrected Shipping execution implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development, separate
> task and final independent reviews. Routine approvals waived. No Git publication.

**Goal:** native corrected 50-case Shipping with exact current60/50/10 proof.

**Architecture:** dedicated corrected adapter; share existing result and native
content validation without fabricating regular input. Atomic journal + native stores.

**Tech Stack:** TypeScript, Zod, Drizzle/PostgreSQL, Vitest.

**Spec:** docs/superpowers/specs/2026-10-09-us-11-corrected-shipping-execution-design.md.

## Global Constraints

- Existing isolated codex/us-mvp; preserve inherited dirty work and index/HEAD.
- Ship50 case on2026-06-12 processor→recipient_02; actual60/50/10, unchanged active lot.
- Dedicated accepted nested corrected input; unchanged regular codec/recipe/semantics.
- No specific SSCC allocation or implicit prerequisite installation.
- No commit/push/PR/deployment/install/.env/schema/runtime/CLI changes.
- Native fixture only audited loopback55432 owned random children; no shared-base writes.
- DB work cannot overlap static/build/package checks; unchanged old native gates/timers.

## Review Focus

- Contradictory stored receipts must not certify current provenance or fresh ownership.
- Pending amended/voided origin and extra consumer reject atomically, without repair.
- Known Shipping roots and all operation locks precede union lots and Cases support.
- Failure after native finalization still rolls back all business rows before receipt.
- Shared extraction preserves ordinary partial/full Shipping checks and error context.

### Task 1: Corrected result codec and shared result evidence

**Files:** create `apps/api/src/modules/traceability/demo/us-dataset-shipping-result-content.ts`,
`apps/api/src/modules/traceability/demo/us-dataset-corrected-shipping-result.ts`,
`apps/api/test/us-dataset-corrected-shipping-result.test.ts` and test-local
`apps/api/test/support/us-dataset-corrected-shipping-result-fixture.ts`;
modify only result-validation extraction in `us-dataset-shipping-contract.ts`.

**Interfaces:** export `UsDatasetCorrectedShippingResult`,
`parseUsDatasetCorrectedShippingResult(raw: unknown)`,
`usDatasetCorrectedShippingRecordIds(result)` and
`datasetCorrectedShippingError(code,cause?)` with fixed unit/stage.
Result fields exactly input/originLot/outputLotAfter/shipments; accepted corrected
input and existing `UsDatasetShippingShipmentResult`. Shared helper consumes explicit
chain/output IDs/plan and native content, not either codec. Exact helper signature
can be local structural types; regular parser calls it after its existing parsing.

- [ ] Read current result/schema/lifecycle assertions and unchanged input; write
      importable empty stub and a coherent independent corrected receipt fixture.
      Observe semantic RED for preserved active lot and three ordered IDs:

```ts
const result = parseUsDatasetCorrectedShippingResult(correctedShippingFixture());
expect(result.shipments).toHaveLength(1);
expect(result.shipments[0]?.finalized.snapshot.items[0]?.quantity).toBe("50");
expect(result.outputLotAfter.status).toBe("active");
expect(usDatasetCorrectedShippingRecordIds(result)).toHaveLength(3);
```

- [ ] Extract existing lifecycle/content checks once; preserve regular schema,
      guards, parser errors, owned freeze and operation-key implementation.
      Implement strict descriptor-safe whole256KiB corrected parser, native schema
      equality and shared evidence projection; no fake regular codec or broad casts.
- [ ] Test extra fields, getter/array hazards, wrong codec/recipe/digest/output IDs,
      quantity/UOM/date/document order, derived operation/request/lifecycle/actor,
      mutable/status-changed lot and duplicate IDs, retained cause/fixed context,
      owned freeze without freezing caller. Regular result/contract regressions run:
      `env -u DATABASE_URL -u US_TEST_DATABASE_URL corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-corrected-shipping-result.test.ts test/us-dataset-shipping-result.test.ts test/us-dataset-shipping-contract.test.ts`.
- [ ] Self-review and report exact RED/GREEN commands, outputs, paths and limits;
      controller independently reviews Task1 before Task2. No commit.

### Task 2: Atomic corrected executor, current proof and native regressions

**Files:** create demo `us-dataset-corrected-shipping-prepare.ts`,
`us-dataset-corrected-shipping-locks.ts`, `us-dataset-corrected-shipping-seed.ts`,
`us-dataset-corrected-shipping-verify.ts`, `us-dataset-shipping-verify-content.ts`;
modify `us-dataset-shipping-verify.ts` only to delegate extracted common current
content proof. Add tests/imports inside existing
`apps/api/test/us-dataset-corrected-cases-seed.e2e.test.ts`; create test-local
`apps/api/test/support/us-dataset-corrected-shipping-fixture.ts`. Append evidence
to docs/us/development-isolation.md and docs/us/implementation-plan.md.

**Interfaces:** `UsDatasetCorrectedShippingSeedStore(db).initialize(context)` and
`.verify(context): Promise<UsDatasetCorrectedShippingResult>`; internal prepare and
verify consume `UsDemoTransaction`, current context/intent/receipt, phase and
`UsDatasetShippingStores`. Shared native content helper consumes validated evidence,
bindings, plan, mode, stores and corrected/regular error callback; no pool reads.

- [ ] Write native positive test through real completed corrected Cases fixture
      and importable executor stub; observe semantic RED before implementation:

```ts
await completed();
const result = await new UsDatasetCorrectedShippingSeedStore(h.f.db).initialize(h.context);
expect(result.shipments[0]?.finalized.snapshot.items[0]?.quantity).toBe("50");
expect(result.outputLotAfter).toEqual(result.originLot);
const saved = await h.f.snapshot();
expect(await new UsDatasetCorrectedShippingSeedStore(h.f.db).verify(h.context)).toEqual(result);
expect(await h.f.snapshot()).toEqual(saved);
```

- [ ] Implement auth before capture and transaction reconstruction. Prelock all
      operations/owned roots/revisions/lots/reference/document shares in specified
      order before corrected Cases replay; reject application balance not60/0/60.
      Read existing transaction stores/locks together, preserve native error identity.
- [ ] Extract common native Shipping content proof once (operations/private xmin,
      current record/root/lines/docs/details/audits/balance/consumer/status effects);
      regular adapter retains unchanged native semantics. Corrected adapter binds
      intent/receipt/upstream/current rows then delegates exact50/10 proof.
- [ ] Apply document/draft/readiness/finalize writes in journal atomic stage; fresh
      verification uses private writes and rolls back before receipt on any failure.
      Capture compatible race winner; verify never captures; no auto-prerequisites.
- [ ] Test complete/replay/verify snapshots, pending resume and concurrent initialize;
      denied actor/tenant/database/profile; missing prerequisite with no auto-seed;
      forged persisted operation/receipt and source/line/document/audit/Cases drift;
      real pending amendment/void and unrelated consumption; post-finalization
      verification and receipt fault rollback with resumable pending intent.
      Test blocked origin/Shipping root writers with bounded observation/abort/drain
      helpers; no timer increases and no old assertions weakened. Each test is inside
      existing harness/single gate; all detached work tracked and child disposed.
- [ ] Run touched native suite plus ordinary Shipping seed/verify/locks regressions,
      pure result/input suites. Only configured loopback fixture, primary DBunset.
      Report any wider-run failure by name and do not erase it with a green retry.
- [ ] Append truthful checkpoints and report commands/counts/limits. Controller runs
      full API package with DBvarsunset and final static/isolation/ownership gates;
      independent task then most-capable whole-increment review. No Git publication.
