# Regular-chain range implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute or verify an explicit regular-chain range sequentially with durable per-stage resume and honest partial completion.
**Architecture:** Thin internal coordinator over actual guarded stores; bounded pure range contract; no new persistence or public entry.
**Tech Stack:** Node24/Corepack pnpm, TypeScript/Zod, PostgreSQL/Vitest, YAML Node tests.
**Spec:** `docs/superpowers/specs/2026-10-08-us-11-regular-range-design.md`

## Global Constraints

- Only `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, `codex/us-mvp`, HEADf06aaef2b923a7ae902c0fabacfd0c4712c127c3; preserve inherited dirty state/index.
- No commit/push/PR/merge/release/cleanup, schema, dependency/environment changes, shared-base population or external artifacts. No runtime/module/HTTP/CLI registration.
- Node24/Corepack installed dependencies; no build during DB workers. DB only invocation-owned disposable children of `US_TEST_DATABASE_URL=postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev`, DATABASE_URL unset, maxWorkers1.
- Original native store contracts/journal transactions/recipe and 256KiB guard stay unchanged. No mock seed adapters, hidden retry, production test hook or whole-range atomicity claim.
- Owner waives approval questions; separate implementer and independent spec+quality review each task, final whole-increment review. Use captured byte originals rather than committing dirty baseline; retain evidence.
- Controller owns one final fullAPI command with both DBvarsunset, static/build/format/source inventory and final configured gates. Report inherited failures/skips and external limits separately.

## Review Focus

1. Accessor range from an unauthorized target: guard wins and accessor never executes (Task1 DB).
2. Chain1 fails after chain0 commits: no chain2 starts, prior evidence intact, explicit rerun resumes (Task1 DB).
3. Verify missing/pending state: no journal or business install/repair (Task1 DB).
4. A range including259 or260 chains: honest selected-regular scope, never datasetComplete true (Task1 pure/DB).
5. CI owner exists but doesn't execute: executable mutations, unchanged old pins and whole predecessor (Task2 Node).

## Task 1: Bounded range and actual sequential coordinator

**Files:** Create `apps/api/src/modules/traceability/demo/us-dataset-regular-contract.ts`, `us-dataset-regular-seed.ts`; create `apps/api/test/us-dataset-regular-contract.test.ts`, `us-dataset-regular-seed.e2e.test.ts`. Existing stores/fixtures frozen; no edits without controller-scoped ruling.
**Consumes:** Existing actual stores `initialize(context,index)`/`verify(context,index)`, References mode without index, journal read, bounded JSON guard, actual Shipping result.
**Produces:**

```ts
type UsDatasetRegularRange = Readonly<{startIndex:number;count:number}>;
parseUsDatasetRegularRange(raw:unknown):UsDatasetRegularRange;
makeUsDatasetRegularIndices(range:UsDatasetRegularRange):readonly number[];
type UsDatasetRegularResult = Readonly<{
  datasetId:string;version:"us-processor-six-month-v1";definitionDigest:string;
  range:UsDatasetRegularRange;state:"selected_regular_shipping_verified";
  datasetComplete:false;
  chains:readonly Readonly<{index:number;unitKey:string;shipmentCount:number;shippingResultDigest:string}>[];
}>;
class UsDatasetRegularSeedStore {
  constructor(db:Db);
  initialize(context:UsDatasetContext,range:UsDatasetRegularRange):Promise<UsDatasetRegularResult>;
  verify(context:UsDatasetContext,range:UsDatasetRegularRange):Promise<UsDatasetRegularResult>;
}
```

- [ ] Pure RED: `expect(makeUsDatasetRegularIndices(parseUsDatasetRegularRange({startIndex:258,count:2}))).toEqual([258,259])`; separately reject0count/overflow/fractions/strings/extra/symbol/nonenumerable/accessor/customprototype/cycles/oversize and ensure no getter execution; copies frozen/no alias; full-range literal260 and first/last0/259.
- [ ] Run focused pure suite; missing import isn't RED. Minimal nonfunctional callable scaffold may collect the genuine behavior assertion before implementation. Implement descriptor guard then strict Zod, no coercion, normalize neither inputs nor negative0 silently. Error `us_dataset_regular_range_invalid`; indexed list owned frozen ascending.
- [ ] Real DB RED: fresh target and `{startIndex:0,count:2}` produces two checked chains,4 finalized Shipping roots,6 lots,120 boxes, stable stage receipts; actual0/1 outcomes. Fixture created/migrated in beforeAll60000ms; independently registered provision setup/body drainage; new multi-stage batch assertions explicitly30000ms, no inherited timers edited.
- [ ] Implement only actual sequential mode calls:

```ts
await journal.read(context); // target before range descriptors
const selected = parseUsDatasetRegularRange(range);
await references[mode](context);
for (const index of makeUsDatasetRegularIndices(selected)) {
  await receiving[mode](context, index);
  await transformation[mode](context, index);
  await cases[mode](context, index);
  const checked = await shipping[mode](context, index);
  // retain only index/key/actual shipment count/canonical digest, not full results
}
```

Read actual header again after References and reject missing. Freeze/copy final result, apply256KiB guard. Catch solely to annotate extensible Error with actual stage/unit, then throw exact original. Mode private fixed union; no caller-supplied dependency/service injection or arbitrary stage selector.

- [ ] DB tests: true fresh0/1; ScenarioA259 exact100cases/one100shipment; repeat initialize and verify whole198-table hash unchanged; verify absent target and partial stages no writes; invalidrange no writes before References; foreign/current-owner/actualDB mismatch beats malicious getter. SQL failpoint chain1Shipping transaction stops range0count3, chain0's receipts/native/audit facts preserved and chain2 absent; trigger removed under ownership then explicit resume completes3; no innerretry and original SQL cause code/message preserved. Canonical chain1 current drift after prepared Receiving stops before Transformation/chain2 with all-table hash unchanged. Concurrent equal range0count1 via allSettled/drain both native calls; one installed result. No fabricated service writes.
- [ ] Green both new suites serial with approved fixture; bounded old Shipping/Receiving replay regression if interface risk arises; APItypecheck/scopedlint/format after drainage. FullAPI delegated to controller, not skipped silently.
- [ ] Self-review/report exact RED/GREEN/results/owned child disposition/errors/hashes at own Task1 report, freeze fourfiles for independent review. No commits.

## Task 2: Check-only CI ownership and truthful docs

**Files:** Modify only `.github/workflows/us-development.yml`, `tools/us-development/test/isolation.test.mjs`, `docs/us/development-isolation.md`, `docs/us/implementation-plan.md`; create `tools/us-development/test/dataset-regular-ownership.test.mjs`.
**Consumes:** Reviewed frozen Task1 APIs/suites.
**Produces:** One unconditional owner `Verify regular dataset range orchestration on disposable databases` after actual shared/domain/API builds:

```yaml
- name: Verify regular dataset range orchestration on disposable databases
  env:
    US_TEST_DATABASE_URL: postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev
  run: corepack pnpm --filter @markiro/api exec vitest run test/us-dataset-regular-contract.test.ts test/us-dataset-regular-seed.e2e.test.ts --maxWorkers=1
```

- [ ] Capture actual parsed predecessor/steps AST hashes before edit; add executable missing-owner RED, then new exact owner. New Node file owns assertions/mutations; existing isolation file ONLY adds new-owner exclusions in existing preservation filters. Never repin any old SHA literal or refactor ownership logic.
- [ ] Exact globally unique explicit selection of each suite and one dedicated executable owner command, only fixtureenv/serialworker, unconditional job/workflow/step, failure propagation and build order. Aggregate API CI also collects the pure suite; prove and document this allowance, never claim globally exclusive execution or edit generic CI/configuration. Deny aliases/quotes/split owners/duplicate/missing explicit selections, suppression/redirect/background/shell override, inheritedenv/DBfallback/wrong fixture, conditions/ignoredbuild failures. Fresh parsed-YAML mutation each must fail intended AssertionError/message. Remove only newowner and assert fullpredecessor AST/steps hashes; preserve30min permissions/services/release locks.
- [ ] Docs append actual selected-range/resume/no-write/stop-on-first-failure behavior and test evidence; distinguish separate transactions from snapshot/atomicbatch and recipe scope from full demo completion. Explicitly keep corrections/trace_readiness/Plan/Requests/full260volume/CLI/runtime/hosting open. No private motive text.
- [ ] Final once safe `node --test tools/us-development/test/*.test.mjs`, checker, scopedlint/format/diff; ownreport frozen fivepaths and results for independent review. No DB/API/build by Task2.

## Controller finish

- [ ] Fresh Task1 exactconfigured gate and Task2 safeNode/checker; APItypecheck/lint/build after DBdrain, fullAPIonce bothDBvarsunset (loopback permission if required), repository format/diff/sourcebaseline and exact whole-increment review. No remoteCI/hosting/fullvolume claim.
- [ ] No publication or cleanup; retain branch/worktree/evidence. Exhaustively report ledger rulings and costs. Next special examples/artifacts and measured fullvolume need their own implementation scope.
