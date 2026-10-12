# US-11 special chains orchestration implementation plan

Spec: `docs/superpowers/specs/2026-10-09-us-11-special-chains-orchestration-design.md`.
Status: execution approved through the user's standing approval; no Git writes.

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit` on
  `codex/us-mvp`. Preserve inherited dirty/untracked work. Use absolute paths for
  every apply_patch operation; the default shell directory is another checkout.
- Compose existing stores in sequence, with each native stage's transaction and
  proof unchanged. Verify must not install missing state; initializer failures
  leave earlier committed stages available for retry.
- Return state `special_chains_shipping_verified` and literal
  `datasetComplete: false`. No trace_readiness or full-dataset completeness claim.
- No new receipt, native schema, runtime/CLI/HTTP/UI registration, dependencies,
  environment files, Git commit/push/PR, shared DB reset/seed or deployment.
- Native tests use only the fixture-owned random child of the validated loopback
  `markiro_us_dev` database on port 55432 as `markiro_us`; DATABASE_URL unset.
  No native suite overlaps API static/build/full-package gates. All other gates
  unset both DATABASE_URL and US_TEST_DATABASE_URL. No other plan's SDD directory
  may be read or written.
- Do not weaken existing assertions, alter existing test bodies, or increase
  inherited timers. Tests exercise real native stores, derive expectations
  independently, own/drain all asynchronous work and verify scratch disposal.

### Task 1: Compose and verify both special native chains

Files:

- Add `apps/api/src/modules/traceability/demo/us-dataset-special-chains-seed.ts`.
- Extend `apps/api/test/us-dataset-corrected-cases-seed.e2e.test.ts` inside its
  existing `specialFixture` harness, retaining all 79 existing tests unchanged.
- Append checkpoints to `docs/us/development-isolation.md` and
  `docs/us/implementation-plan.md` only after actual verification.

1. Write focused real PostgreSQL tests first. Establish assertion RED for fresh
   assembly before production implementation (missing-module errors alone do not
   count; a minimal unimplemented exported boundary may return/throw to reach an
   assertion). Record command/output and why the missing behavior caused failure.
2. Export `UsDatasetSpecialChainsSeedStore` constructed with `Db`, public
   `initialize(context)` and `verify(context)` only, with a readonly summary type.
   No injection seam or new generic execution framework.
3. Execute journal.read(context) before any stage; then references[mode], then
   read actual header. Execute special.initialize/verify(context, 'correction'),
   corrected Transformation[mode], corrected Cases[mode], corrected Shipping[mode],
   then special.initialize/verify(context, 'orphan'). Existing special initialize
   already creates/verifies Receiving before its lifecycle stage. For errors
   without annotations the fallback stage for those calls is amend_receiving or
   void_receiving; existing exact native annotations take precedence.
4. Produce the owned frozen summary:
   datasetId, version, definitionDigest,
   state: 'special_chains_shipping_verified', datasetComplete: false;
   correction {unitKey: 'correction_0001', lifecycleResultDigest,
   transformationResultDigest, casesResultDigest, shippingResultDigest,
   shipmentCount}; orphan {unitKey: 'orphan_0001', lifecycleResultDigest}.
   Use canonicalExportDigest on actual returned results and the existing bounded
   synthetic JSON guard on the final summary. Do not include full evidence,
   personal data or operation keys in the summary. Freeze both nested summaries
   and their parent; no externally retained mutable objects.
5. Preserve thrown object identity and existing annotation values; only add
   missing unitKey/stage where extensible. Never swallow/replace original error
   if annotation cannot be added. No whole-run transaction, new receipt or claim
   of a globally atomic snapshot.
6. Native cases: fresh entire special assembly with literal counts (5 lots,
   60 boxes, one current Shipping, amended correction Receiving, void orphan);
   verify real current 60 supply/50 used/10 remaining active output; exact
   summary keys/digests and frozen copies; completed replay+verify leave all
   public table hashes unchanged; verify absent/references-only/partial stages
   never writes; resume after amended Receiving and corrected Cases; refused
   pending Shipping verify leaves pending intent untouched; invalid actual
   database target and non-owner actor do not install anything; shipping receipt
   or native document drift fails without adding orphan work; original native
   error unit/stage remains accurate. Use current owned fixture helpers. Avoid
   gratuitous repetitions of existing lower-level race/lock probes.
7. Run only newly added focused tests while iterating, then the complete existing
   corrected Cases/Shipping file serially once. Report skips/filtering distinctly,
   warnings and all failures. Controller runs API package/static/build/format
   gates after native work ends, not concurrently. No commit.
8. Self-review; full report in this task's report file (TDD, exact commands,
   results, changed paths, fixture drain/disposal, concerns). Return short status.
