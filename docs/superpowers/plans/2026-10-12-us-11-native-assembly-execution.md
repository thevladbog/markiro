# US-11 full native chain coordinator implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Run and verify all regular and special native chains through one explicit internal coordinator.

**Architecture:** Validate the target, run the existing regular range and special
orchestrators sequentially, bind their actual summaries with the pure assembly
contract. Keep bounded stage transactions and false dataset completion.

**Tech Stack:** Node 24, Corepack pnpm, TypeScript, Vitest, Drizzle/PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-10-12-us-11-native-assembly-execution-design.md`

## Global Constraints

- Work only in `/Users/thevladbog/PRSOME/q/.worktrees/us-docs-audit`, branch `codex/us-mvp`; preserve inherited changes.
- Full range exactly `{ startIndex: 0, count: 260 }`; regular first, then correction/orphan via the existing special store.
- Result state `native_chains_shipping_verified`; `datasetComplete: false`; unchanged upstream errors and no outer transaction/retry.
- Native fixture base only verified `127.0.0.1:55432/markiro_us_dev`, role `markiro_us`; only randomized owned children can be mutated/disposed.
- Native commands unset `DATABASE_URL`; pure/static commands unset both `DATABASE_URL` and `US_TEST_DATABASE_URL`. No `.env` reads.
- No production dependency seams, mock-forwarding tests, new SQL/business writes, underlying-store/codec/schema/env/dependency/CI/runtime edits.
- No commit/push/PR/deployment/cleanup of user work. Only this plan's `.superpowers/sdd` artifacts may be read/written.
- Full-volume phase initial budget 900,000 ms; existing deadlines unchanged; drain work before owned fixture disposal.

## Review Focus

- Verify on fresh or partial state must fail without installing a missing stage.
- Changed current owner/role/provenance, foreign tenant or actual database/user must fail before writes.
- Special-stage failure after regular success must preserve regular facts, not continue into orphan or retry silently.
- Post-install business drift must reject initialize and verify without repairing it.
- Result identity/bounds/freeze/false-completion must reflect actual native summaries, not invented totals or a global snapshot claim.

### Task 1: Implement and prove the full native coordinator

**Files:**

- Create: `apps/api/src/modules/traceability/demo/us-dataset-native-seed.ts`.
- Create: `apps/api/test/us-dataset-native-seed.e2e.test.ts`.
- If necessary create: `apps/api/test/support/us-dataset-native-fixture.ts` for test-owned lifecycle only; prefer existing `specialFixture` and SQL-fault helpers.
- Append: `docs/us/development-isolation.md`, `docs/us/implementation-plan.md`.

**Interfaces:**

- Consumes existing `UsDatasetJournalStore.read(context)`, `UsDatasetRegularSeedStore.initialize/verify(context, range)`, `UsDatasetSpecialChainsSeedStore.initialize/verify(context)`, `makeUsDatasetNativeAssemblyInput(regular, special)`.
- Produces `UsDatasetNativeSeedStore(db: Db)` with `initialize/verify(context: UsDatasetContext): Promise<UsDatasetNativeResult>`; type is `Omit<UsDatasetNativeAssemblyInput, "state"> & Readonly<{ state: "native_chains_shipping_verified" }>`.

- [ ] **Step 1: Write native tests first.**

Use `describe.skipIf(!process.env.US_TEST_DATABASE_URL)` and existing owned fixture
lifecycle. Name the production mutation each test catches. Independent facts:

```ts
expect(counts.rows).toEqual([{ roots: 964, finalized: 963, lots: 785, boxes: 15700 }]);
expect(result).toMatchObject({
  state: "native_chains_shipping_verified",
  datasetComplete: false,
  regular: { range: { startIndex: 0, count: 260 } },
  special: { correction: { shipmentCount: 1 }, orphan: { unitKey: "orphan_0001" } },
});
const before = await fixture.snapshot();
expect(await coordinator.verify(context)).toEqual(result);
expect(await coordinator.initialize(context)).toEqual(result);
expect(await fixture.snapshot()).toEqual(before);
```

Implement SQL counts using actual root/current-event joins, tenant scoping and
synthetic box markers; do not calculate expectations using the recipe under test.
Check indices 0..259 and 440 regular shipments, correction amendment/void history,
100 Scenario A boxes, all root-type totals and no missing receipts in native stages.
Check no trace_readiness/Plan/Request completion is invented.

Fresh/partial verify snapshots must remain identical. For denial use real current
role/owner changes, alternate builtin role, wrong expected DB and random tenant;
assert both modes fail and exact pre/post hashes remain unchanged. Include real
provenance rejection using the existing target fixture patterns.

The full-volume phase uses an owned trigger on dataset stage receipt for
`correction_0001` `receiving`, after regular execution. For example with existing
`specialFault`:

```ts
const remove = await specialFault(
  fixture,
  "traceability_demo_dataset_stages",
  "UPDATE",
  "NEW.unit_key='correction_0001' AND NEW.stage='receiving' AND NEW.receipt IS NOT NULL",
  "40001",
);
try {
  const failed = await outcome(coordinator.initialize(context));
  expect(failed.error).toMatchObject({ cause: { code: "40001" } });
  // Query all 260 committed regular Shipping receipts, null correction receipt,
  // absence of orphan intent/roots and no automatic continuation or repair.
} finally {
  await remove();
}
const result = await coordinator.initialize(context);
```

Capture regular owned stage/business hashes before resume and verify preservation.
Use upstream native read services to compare sample chain 0/259 and correction
digests against returned summary, and lifecycle results for correction/orphan.
After successful replay, introduce a deliberate owned business drift using an
existing fixture pattern; both modes must reject with no table-hash changes.
Record process timing/RSS/database-size numbers without printing evidence/secrets.
Keep expensive full volume in one phase with 900,000 ms deadline and drained
work; cheap denial cases use their existing normal deadlines.

- [ ] **Step 2: Run actual RED before implementation.**

Run native focused file with verified fixture URL and `--maxWorkers=1`. Derive the
known synthetic URL from `us-development.yml`, do not source `.env` or use a shared
production URL. Sandbox EPERM may require a scoped escalation for loopback tests.
If initial missing-module import fails, disclose it; create only a typed throwing
skeleton after tests exist, rerun RED and record actual assertion failure caused
by absent coordinator behavior. Import failure alone is not acceptance evidence.

- [ ] **Step 3: Implement the minimal sequential module.**

```ts
private async execute(context: UsDatasetContext, mode: "initialize" | "verify") {
  await this.journal.read(context);
  const regular = await this.regular[mode](context, { startIndex: 0, count: 260 });
  const special = await this.special[mode](context);
  const assembled = makeUsDatasetNativeAssemblyInput(regular, special);
  return Object.freeze({ ...assembled, state: "native_chains_shipping_verified" as const });
}
```

Constructor uses actual `Db` to instantiate existing pinned journal/regular/special
stores. Public methods delegate to execute with their exact mode. Do not catch
upstream failures or add SQL/retries/annotations or new runtime registration.

- [ ] **Step 4: GREEN and proportionate final gates.**

Build API dependencies before native tests, with no native worker running:

```bash
env -u DATABASE_URL -u US_TEST_DATABASE_URL corepack pnpm turbo build --filter='@markiro/api^...'
```

Run new actual native suite serially using only verified fixture base; then
adjacent regular/special native suites if affected risk warrants, and pure
assembly/regular/special contract tests with both DB variables unset. Record
elapsed generation/resume/verify/replay, `process.resourceUsage().maxRSS` labelled
process peak RSS KiB and `pg_database_size(current_database())` labelled child DB
bytes including migrated schema. No free-tier/artifact/cloud inference.

After native work and clients settle, run:

```bash
env -u DATABASE_URL -u US_TEST_DATABASE_URL corepack pnpm --filter @markiro/api test
env -u DATABASE_URL -u US_TEST_DATABASE_URL corepack pnpm --filter @markiro/api typecheck
env -u DATABASE_URL -u US_TEST_DATABASE_URL corepack pnpm --filter @markiro/api lint
env -u DATABASE_URL -u US_TEST_DATABASE_URL corepack pnpm --filter @markiro/api build
env -u DATABASE_URL -u US_TEST_DATABASE_URL node --test tools/us-development/test/*.test.mjs
env -u DATABASE_URL -u US_TEST_DATABASE_URL node tools/us-development/check-isolation.mjs
corepack pnpm format:check
git diff --check
```

Full API has known environment-dependent setup failures; report exact current
failed files, assertion/setup distinction and skips, not a blanket green claim.
No CI edit in this task; note dedicated native push-CI ownership remains pending.

- [ ] **Step 5: Document measured boundaries and report without committing.**

Append truthful checkpoints. Report new behavior/files, RED/GREEN/complete exit
codes and counts, fixture names/confirmed disposal, measured native data size,
warnings and failures. Separate local native chain evidence from complete demo,
artifact, browser, hosted or regulatory acceptance. Task review and independent
final review follow; retain artifacts and preserve inherited changes.
