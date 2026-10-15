# US Narrow Candidate Lookups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this accepted plan task-by-task, with an independent review of each SQL selector. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove proven quadratic narrow Trace/readiness candidate joins without changing protected semantics or gates.

**Architecture:** Materialize scoped DISTINCT child event IDs once, then drive fenced event/root PK lookups within existing candidate statements. Keep every separate authority/integrity reader in place. Only two SQL builders and their two existing test files change; no index/schema/migration work.

**Tech Stack:** TypeScript, Drizzle node-postgres, PostgreSQL 17, Vitest, existing disposable US fixtures.

**Spec:** `docs/superpowers/specs/2026-10-15-us-narrow-candidate-lookups-design.md` (accepted after independent review).

## Global constraints

- Controller approved SQL-only implementation and focused TDD. The user's existing
  scoped US-branch commit/push authorization remains valid after verification;
  release, deployment and main/RU changes remain prohibited.
- Preserve every existing deadline, fixture, counter, oracle, native callback boundary and transaction isolation/lock sequence.
- No caches, native procedures, caller proofs, validation skips, SQL statement merging or JIT/planner GUC tuning. Rejected NOT MATERIALIZED hints remain excluded; only the new scoped-ID CTE is explicitly MATERIALIZED.
- Keep no-lot readiness SQL unchanged and ordinary native 270-query/hash golden pinned.
- Only isolated disposable `US_TEST_DATABASE_URL` fixtures; build DB before API consumers.
- During RED/GREEN, select only the newly added regression cases with `-t` in
  the two evidence files. These selection skips are diagnostic, not suite acceptance.
  Run each affected whole file once after the final source is frozen; do not run
  whole-file RED, whole-file GREEN and then the same whole-file integration again.

## Review focus

- Duplicate child lines must not duplicate event IDs or consume the limit sentinel.
- Null, wrong-type or foreign roots must preserve selector results and public fail-closed guards.
- Lot+product can match different event lines or frozen-only product data.
- Historical/excluded relations must still trigger original integrity errors before candidate loading.
- Stale statistics must not reintroduce whole-tenant nested-loop replay.

## Task 1: Trace candidate lookup, regression first

**Files:** modify `apps/api/src/modules/traceability/trace/us-trace-query.ts`; extend
`apps/api/test/us-trace-evidence.e2e.test.ts` (already owned by Trace CI).
**Interface:** `traceCandidateQuery(tenantId, lotIds, direction, limit)` stays unchanged;
`readCurrentTraceFrontier` and `assertTraceRelations` remain unchanged.

- [x] Add a test-local frozen legacy selector copied from the current builder (not a
      production compatibility branch). Compare actual ordered ID rows old/new for
      `backward`, `forward`, `both`, limits 1 and 20, duplicated lot IDs/child references,
      missing/draft/amended/current roots and foreign-tenant children. Keep existing public
      guard tests; add an assertion that wrong child type still fails before frozen loading.
- [x] Add populated, distinct-lot stale-statistics selector work coverage using existing
      disposable clone patterns. At 260 unrelated Receiving groups require total node work
      `< 260 * 64`, including removed rows times loops, on the ACTUAL candidate SQL; compare
      exact ID rows to the legacy query first. This bound rejects the observed 263x520
      replay without demanding a particular scan/join algorithm. Keep all original tests.
- [x] Run only the new test names and record RED on plan work, not setup/schema failures:

```bash
corepack pnpm --filter @markiro/api exec vitest run test/us-trace-evidence.e2e.test.ts --maxWorkers=1 -t 'bounds narrow candidate work|keeps legacy candidate'
```

- [x] Implement only candidate SQL. Relational skeleton (retain exact predicates from spec):

```sql
WITH children AS (...existing four tenant/lot branches...),
candidate_ids AS MATERIALIZED (SELECT DISTINCT event_id FROM children WHERE ...existing direction...)
SELECT e.id FROM candidate_ids c
JOIN LATERAL (SELECT ... FROM traceability_events WHERE id=c.event_id LIMIT 1) e ON true
JOIN LATERAL (...three root PK/type branches... LIMIT 1) r ON ...tenant/id/type/current...
WHERE ...unchanged tenant/status/supersession...
ORDER BY e.event_date,e.id LIMIT ...limit + 1...
```

- [x] Do not add child-type filtering, early limits or root validation to the selector.
      Run the full Trace evidence/store/history/http files and inspect exact differential
      results + plan work. Independent reviewer checks the untouched preceding guard.

## Task 2: Narrow readiness selector, regression first

**Files:** modify `apps/api/src/modules/traceability/trace/us-readiness-evidence.ts`;
extend `apps/api/test/us-readiness-evidence.e2e.test.ts` (existing Readiness CI owner).
**Interface:** `readinessEventSelectionQuery(tenantId, scope)` unchanged.

- [x] Add test-local legacy query differential checks for lot-only, lot+product on a
      different line, frozen-only product fallback, date boundaries, missing/current/null/
      foreign roots, draft/amended revisions, duplicate child rows, and ordered sentinel.
      Run existing no-lot/product-only tests unchanged. Use genuine fixtures for semantic
      cases; disclose selector-only shapes only in the populated plan test.
- [x] Add the same populated narrow-lot `< 260 * 64` total-work regression for the
      actual readiness selector. Keep the existing 2001/10001 test and its two bounds
      byte-for-byte; no broad-scope test substitution. Run focused RED with the
      exact new readiness test names selected (not the old broad cases):

```bash
corepack pnpm --filter @markiro/api exec vitest run test/us-readiness-evidence.e2e.test.ts --maxWorkers=1 -t 'narrow readiness'
```

- [x] Add only `scope.lotId !== null` branch: `scoped_event_ids AS MATERIALIZED
(SELECT DISTINCT event_id FROM lines WHERE tenant_id=tenantId AND lot_id=scope.lotId)`,
      fenced event lookup, and the ENTIRE existing WHERE including current-root tuple
      membership, current/date/status predicates and FULL `eventFilter(scope)`.
      Preserve unchanged order and 10,001 sentinel. Preserve
      the old no-lot return expression. Private local SQL helpers only if they avoid exact
      lookup duplication; no new exported authority surface.
- [x] Run readiness evidence/assessment/http files; reviewer checks that selectedLots,
      invalid/integrity/origin/draft queries and snapshot parsers are unchanged.

## Task 3: Integration and decision gate

- [x] Independent review of the four-file SQL/test change before wider gates. Run one
      short controller-approved actual whole-owner materiality comparison; fixed 25%
      improvement in both paired orders remains the acceptance target. No index, no new
      population sweep or substitute of selector microseconds for whole-owner evidence.
- [x] Run the existing original 12 measurements and 17 coordinator cases from the controller's accepted
      ledger, without editing selections, cases, budgets or fixture preparation. Verify
      ordinary native 270/hash unchanged and completed owner543 unchanged. No repinning.
- [x] Run API package checks/typecheck/lint/build.
- [ ] Controller performs already-authorized scoped push only after these gates and verifies exact-SHA CI, including unchanged
      full262 and all existing suites. No new local full262/whole12/whole17 duplication is
      required by this plan. Report skips separately; use serialized runtime slots.
      Any 900s/5000ms failure remains a failure, not permission to increase budgets.
- [x] Review all SQL predicates and new plan tests independently. Confirm same-statement
      RR reads, no changed lock/first-error boundaries, no filtered malformed history,
      and exact CI ownership unchanged.
- [ ] Controller decides material whole-owner/full262 headroom from original gates;
      no additional microdiagnostic beyond the short approved owner check is authorized. If gain is inadequate,
      report and stop. Record files, automated gates, external limitations and remaining
      failures. Do not ask again for already-authorized scoped US push; release and
      deployment are outside this work.

## Local verification checkpoint

- Focused regressions: four pass; observed plan work Trace 409250 → 540,
  readiness 137027 → 1838, against the fixed 16640 work budget.
- Seven affected suites: 112 pass, zero skips; original broad 2001/10001 checks pass.
- Same-state whole-owner comparison: 543 driver calls in each arm, exact results
  and full-table hashes preserved; 40.42% / 45.60% faster in both paired orders.
  The 520-group selector-shape fixture is not the full 260-chain acceptance run.
- Original 12 measurements and 17 coordinator cases pass; two additional ordinary
  unit-composition smoke cases also pass. No original tests or deadlines changed.
- API typecheck, lint and build pass. Full isolated API: 331 files / 4783 tests pass;
  189 files / 3956 US opt-in tests intentionally skip and require separate US gates.
  The owned database was normally dropped and verified absent; zero new databases
  remained after cleanup. External SMTP/storage were deliberately refused.
- Exact-SHA CI, including the original full 262-unit acceptance, remains pending.
