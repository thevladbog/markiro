# US-06 Readiness Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an authorized U.S. tenant a complete, scope-labelled, read-only assessment of concrete gaps in current finalized Receiving, Transformation and Shipping evidence, with older origins checked as uncounted dependencies.

**Architecture:** A strict shared HTTP contract and pure rule evaluator sit above a tenant-scoped repeatable-read evidence reader. The reader selects whole current events and relevant lots, validates frozen snapshots and root/child relations, and distinguishes business gaps from storage corruption. The store aggregates one assessment and lists draft work separately; an exact U.S.-only route and local proxy expose it without mounting RU routes.

**Tech Stack:** Node >=24, repository-pinned pnpm through Corepack, TypeScript, Zod, Drizzle, PostgreSQL, NestJS and Vitest. No new dependency or migration is presumed.

**Spec:** [Owner-approved Readiness design](../specs/2026-09-28-us-06-readiness-server-design.md). Also read the [parent US-06 design](../specs/2026-09-27-us-06-current-trace-search-readiness-design.md), [MVP contract](../../us/mvp-contract.md), root `AGENTS.md`, and the API scoped guide if present. This is the third US-06 server phase; preserve the existing current trace and Search/Lot Card work, including its unstaged files.

## Global Constraints

- Work only in the isolated `codex/us-mvp` checkout. Do not merge to `main`, deploy, release, provision hosting or mount RU routes. Commit/push/PR require separate authorization; review checkpoints below are not commit instructions.
- The only endpoint is `GET /api/us/traceability/readiness`; tenant, actor and profile come from the verified U.S. session plus current membership/capability reload inside the transaction. Missing or foreign explicit lot/product IDs have identical 404s. Reads create no business or audit rows.
- Default dates are the first day of the month 23 months before the tenant's current civil month through today, inclusive. Both custom dates are required together, ordered and at most 24 distinct calendar months. Product/lot filters select whole events; out-of-filter lines remain visible and assessed.
- Current means a same-tenant typed root points at a finalized, unsuperseded event. Draft/void/amended/superseded revisions never count as current events. A historical origin can select a retained orphan lot but does not become a checked current event.
- An older or otherwise out-of-scope origin of an in-scope consumer is checked as a dependency only; a gap is anchored to the selected consumer. It does not increase `recordsChecked` or produce an out-of-scope finding. `origin_gap` and unresolved TLC/source mismatch are errors.
- Use frozen event dates, product/location/source descriptions, documents and line values. Do not rerun draft validators against today's mutable masters or recalculate historical quantities/UOM. Processor-only FTL rules do not run for the generic profile; neither profile gets a legal verdict or percentage.
- One successful response is complete and exact. At most 10,000 current roots, 10,000 selected lots and 10,000 findings can be assessed synchronously. Exceeded workload, timeout or contradictory storage returns a sanitized 503, never a 200 partial result or “no findings.” Invalid query syntax/bounds is 400.
- A valid empty scope differs from a nonempty scope with zero findings. Draft work is reported separately, excluded from finalized counts/findings, and links to the existing Events view when its bounded preview has more rows.
- Build shared `dist` before consumers. DB tests must execute in the disposable loopback `US_TEST_DATABASE_URL` harness; skips do not prove behavior. Never load the primary checkout's `.env` or mutate a shared database.

## Review Focus

1. A voided Transformation output with no remaining current origin is still a visible lot with unchanged TLC/source/status/case links, but has an `origin_gap` **error** (Tasks 2–4 tests).
2. A Shipping event inside the date window whose Receiving origin is older checks that origin but counts only the selected event/lot; a broken older origin is attributed to the Shipping line (Tasks 2–4 tests).
3. A product filter selecting one line of a 2→2 Transformation assesses all four lines without claiming per-input/output quantity allocation (Tasks 2–3 tests).
4. A current event with a structurally valid missing required document produces a finding, whereas malformed snapshot JSON or an impossible root/child relationship returns 503 (Tasks 2–4 tests).
5. Generic-profile tenants see no FTL applicability finding; a later mutable product/location rename or archive cannot alter frozen findings (Tasks 2–4 tests).

---

## File map and shared interfaces

- Create `packages/platform-contracts/src/traceability/readiness-sweep.ts`, export it from `packages/platform-contracts/src/index.ts`, and test it in `packages/platform-contracts/test/us-readiness-sweep.test.ts`: strict query/result schemas. `UsReadinessQuery` contains optional raw HTTP date/UUID filters; `UsProfileCode` is the two-value U.S. profile union inferred from `usTraceabilityProfileCodeSchema`. `UsReadinessResult` includes exact scope, assessedAt, state, counts, groups, findings and separate draftWork.
- Create `apps/api/src/modules/traceability/trace/us-readiness-query.ts` and `apps/api/test/us-readiness-query.test.ts`: `parseUsReadinessQuery(raw)` and `resolveUsReadinessScope(query, tenantToday, profileCode)`; no tenant timezone default is resolved in a contract parser.
- Create `packages/domain/src/traceability/readiness-sweep.ts`, export it from `packages/domain/src/index.ts`, and test it in `packages/domain/test/readiness-sweep.test.ts`: `assessFrozenReadiness(input): ReadinessRuleFinding[]`. Inputs are normalized frozen facts, lot identities and current-origin status; no Nest, Drizzle, contracts package or mutable master reads.
- Create `apps/api/src/modules/traceability/trace/us-readiness-evidence.ts` and `apps/api/test/us-readiness-evidence.e2e.test.ts`: `readUsReadinessEvidence(tx, tenantId, scope): Promise<UsReadinessEvidence>`. It selects tenant-owned whole current events/lots/drafts, loads frozen evidence in batches, checks out-of-scope origins and fails on structural corruption. It must not call the graph's 2,000-event frontier as an all-tenant scan.
- Create `apps/api/src/modules/traceability/trace/us-readiness-assessment.ts` and `apps/api/test/us-readiness-assessment.e2e.test.ts`: `assessUsReadiness(tx, tenantId, scope, profileCode): Promise<UsReadinessResult>`. It calls the pure rules, deduplicates findings and derives all counts/groups from that set. Extend `UsTraceStore` with `readiness(tenantId, actorUserId, rawQuery)` inside `transformationTransaction`.
- Create `apps/api/src/deployment/us-readiness.controller.ts` and `apps/api/test/us-readiness-http.e2e.test.ts`. Register only in `apps/api/src/deployment/us-development.module.ts`; `UsRuntime.trace` already exists. Extend the exact GET-only allowlists in `apps/admin/vite.us.config.ts`, `.github/workflows/us-development.yml` and `tools/us-development/test/browser-entry.test.mjs`. Add `tools/us-development/test/readiness-transport.smoke.mjs` only if the existing browser-entry contract cannot exercise real dev/preview transport.

### Task 1: Contract and civil scope normalization

**Files:** Create `packages/platform-contracts/src/traceability/readiness-sweep.ts`, `packages/platform-contracts/test/us-readiness-sweep.test.ts`, `apps/api/src/modules/traceability/trace/us-readiness-query.ts`, `apps/api/test/us-readiness-query.test.ts`; modify `packages/platform-contracts/src/index.ts`.

**Interfaces:** `parseUsReadinessQuery(raw: unknown): UsReadinessQuery` throws `BadRequestException({code:"us_invalid_query"})`; `resolveUsReadinessScope(query: UsReadinessQuery, tenantToday: string, profileCode: UsProfileCode): UsReadinessScope` returns inclusive dates, nullable product/lot IDs and `defaulted`. The result contract defines `state: "empty"|"assessed"`, `recordsChecked: {events:number,lots:number}`, `dependenciesChecked:number`, counts by severity, groups by CTE/product/severity, ordered source-linked findings with stable code/field/line/message parameters, and `draftWork: {total:number,items:DraftRef[],hasMore:boolean,eventsHref:string}`. A finding has nullable `lotId` paired with nullable `links.lotHref`, and requires either lot or event provenance. Event-wide and non-FTL input gaps have no lot; a non-FTL input is identified by event plus `lineSide='inputs'` and one-based `lineNo`. Lot-only gaps have no event/line provenance and `cte` can be null. Public findings contain no persisted line UUID; `lineSide` (`items|inputs|outputs`) and `lineNo` appear together only with event provenance. `origin_gap` accepts only `error`; no legal verdict/score field is accepted. A schema refinement requires `empty` to have zero checked records and `assessed` to have at least one.

- [ ] **Step 1: Write failing tests.** Pin no-query defaults through `resolveUsReadinessScope({}, "2026-09-28", "US_FSMA204_PROCESSOR")` → `2024-10-01..2026-09-28`, leap-month and tenant-day edge cases, paired date requirement, 24-distinct-month maximum, reversed/invalid dates, unknown keys, invalid UUID, empty-state versus assessed-zero semantics, and refusal of a result with `origin_gap` severity `warning` or an extra `score` field.

  ```ts
  expect(
    resolveUsReadinessScope(parseUsReadinessQuery({}), "2026-09-28", "US_FSMA204_PROCESSOR")
      .eventDateFrom,
  ).toBe("2024-10-01");
  expect(() => parseUsReadinessQuery({ eventDateFrom: "2026-01-01" })).toThrow();
  ```

  In the contract test, construct one complete `usReadinessResultSchema` fixture and then assert that adding `score` or changing its `origin_gap` severity to `warning` fails strict parsing.

- [ ] **Step 2: Run red.** `corepack pnpm --filter @markiro/platform-contracts exec vitest run test/us-readiness-sweep.test.ts` and `corepack pnpm --filter @markiro/api exec vitest run test/us-readiness-query.test.ts`; expect missing symbols, not an empty suite.
- [ ] **Step 3: Implement strict schemas and calendar arithmetic.** Use `traceabilityCivilDateSchema`, `platformUuidSchema`, `.strict()` and `superRefine` for paired dates; use UTC calendar fields only for arithmetic on the already known tenant civil day, never a UTC instant as event date. Resolve tenant time zone only in Task 4 after authorization.

  ```ts
  export type UsProfileCode = z.infer<typeof usTraceabilityProfileCodeSchema>;
  export const usReadinessQuerySchema = z
    .object({
      eventDateFrom: traceabilityCivilDateSchema.optional(),
      eventDateTo: traceabilityCivilDateSchema.optional(),
      productId: platformUuidSchema.optional(),
      lotId: platformUuidSchema.optional(),
    })
    .strict()
    .refine((q) => (q.eventDateFrom === undefined) === (q.eventDateTo === undefined));
  ```

- [ ] **Step 4: Run green and review.** Run both focused suites, then platform-contracts `test typecheck lint build` and API query test. Check strict response caps, stable finding-key fields, no Russian UI copy and no score/verdict field. No DB or route work belongs in this task.

### Task 2: Pure frozen-data rules

**Files:** Create `packages/domain/src/traceability/readiness-sweep.ts`, `packages/domain/test/readiness-sweep.test.ts`; modify `packages/domain/src/index.ts`.

**Interfaces:** `assessFrozenReadiness(input: ReadinessRuleInput): ReadinessRuleFinding[]`; input holds `profileCode`, `events: readonly ReadinessEventFact[]`, `lots: readonly ReadinessLotFact[]`, `dependencies: readonly ReadinessDependencyFact[]`. An event fact has exact event/root ID, type, revision, civil date, frozen header/document pieces and `lines: readonly ReadinessLineFact[]`; each one-based line has side, nullable lot/product ID, TLC/source identity, quantity/UOM and FTL coverage/exemption facts. A lot fact has retained identity and `currentOrigin: boolean`. A dependency fact has consuming event/line, lot ID, current-origin status and source identity. Findings hold stable `code`, `severity`, `field`, nullable `lotId`, event/revision/line, nullable related source and CTE/product IDs. The pure finding retains internal `lineId`, used with the event ID for deduplication and dependency matching, and exposes `lineSide` plus one-based `lineNo` for public provenance; the API adapter must not publish the internal ID. The API adapter in Task 3 constructs these facts; the domain function performs no I/O.

- [ ] **Step 1: Write failing pure tests.** Cover Receiving missing processor-profile reference, valid generic Receiving without FTL coverage, Transformation 2→2 all four exact lines, Shipping quantity/UOM and source mismatch, void-output `origin_gap` error, older Shipping origin dependency error on the Shipping line, exemption pending/unknown coverage error for processor, no downgrade merely because `revision=2`, and deterministic one-finding-per-key output. Test that archived mutable master fields cannot be passed into `ReadinessRuleInput`.

  ```ts
  const findings = assessFrozenReadiness({
    profileCode: "US_FSMA204_PROCESSOR",
    events: [shipping],
    lots: [lot],
    dependencies: [olderMissingOrigin],
  });
  expect(findings).toContainEqual(
    expect.objectContaining({
      code: "origin_gap",
      severity: "error",
      eventId: shipping.id,
      lineNo: 1,
    }),
  );
  expect(findings.some((f) => f.eventId === olderOriginId)).toBe(false);
  ```

- [ ] **Step 2: Run red.** `corepack pnpm --filter @markiro/domain exec vitest run test/readiness-sweep.test.ts`; expect missing implementation.
- [ ] **Step 3: Implement deterministic rules.** Reuse `isTraceabilityCivilDate`, `parseTraceabilityQuantity`, `isTraceabilityUom` and coverage/exemption helpers only with frozen inputs. Compare TLC/source to current lot identity without parsing TLC numerically. Emit processor-only FTL coverage rules; keep `origin_gap`, `tlc_source_mismatch`, required KDE, quantity/UOM and required-reference errors explicit. Do not call `assessReceivingReadiness`, `assessTransformationReadiness` or `validateShippingReadiness` with current masters.

  ```ts
  export function assessFrozenReadiness(input: ReadinessRuleInput): ReadinessRuleFinding[] {
    const findings = new Map<string, ReadinessRuleFinding>();
    const add = (
      event: ReadinessEventFact,
      line: ReadinessLineFact,
      code: string,
      field: string,
    ) => {
      const key = `${code}:${event.id}:${line.side}:${line.lineNo}:${field}`;
      findings.set(key, {
        key,
        code,
        severity: "error",
        field,
        lotId: line.lotId,
        eventId: event.id,
        revision: event.revision,
        lineSide: line.side,
        lineNo: line.lineNo,
        cte: event.type,
        productId: line.productId,
        relatedEventId: null,
      });
    };
    for (const event of input.events)
      for (const line of event.lines) {
        if (line.quantity === null) add(event, line, "required_kde", "quantity");
        else {
          try {
            if (parseTraceabilityQuantity(line.quantity) !== line.quantity)
              add(event, line, "invalid_quantity", "quantity");
          } catch {
            add(event, line, "invalid_quantity", "quantity");
          }
        }
        if (line.unitOfMeasure === null) add(event, line, "required_kde", "unitOfMeasure");
        else if (!isTraceabilityUom(line.unitOfMeasure))
          add(event, line, "invalid_uom", "unitOfMeasure");
      }
    return [...findings.values()].sort((a, b) => a.key.localeCompare(b.key, "en"));
  }
  ```

- [ ] **Step 4: Run green and review.** Run focused plus domain `test typecheck lint build`. Review the rule matrix against the approved spec and MVP contract; add a failing test before any newly discovered rule. Processor/generic differences and exact provenance are review gates.

### Task 3: Tenant-scoped frozen evidence selection

**Files:** Create `apps/api/src/modules/traceability/trace/us-readiness-evidence.ts`, `apps/api/test/us-readiness-evidence.e2e.test.ts`; reuse, but do not weaken, `apps/api/src/modules/traceability/trace/us-trace-evidence.ts` and `us-trace-query.ts`.

**Interfaces:** `readUsReadinessEvidence(tx: UsMasterDataTransaction, tenantId: string, scope: UsReadinessScope): Promise<UsReadinessEvidence>` returns `facts: {events: ReadinessEventFact[], lots: ReadinessLotFact[], dependencies: ReadinessDependencyFact[]}`, `selectedEventCount`, `selectedLotCount`, `dependencyCount`, a bounded draft preview and its exact total. It raises the established `unavailable()` on structural inconsistency or the 10,000/10,000 workload sentinel. Current CTEs are selected through typed roots; output-orphan candidates are selected through recorded origin child rows including void revisions, but void rows never enter `facts.events`.

- [ ] **Step 1: Write failing disposable-DB tests.** Seed two tenants, current Receiving → 2→2 Transformation → Shipping, an older Receiving feeding in-period Shipping, an amended predecessor, a voided output with an active case link, a draft and a lot without events. Assert whole-event product/lot filter, distinct counts, dependency checks without in-period count inflation, void-origin lot selection, no cross-tenant evidence, frozen descriptions after master rename, and exact draft count/preview. Inject an empty required document array into an otherwise coherent saved snapshot and assert a rule-capable fact; inject malformed JSON and a mismatched child/root and assert 503. Seed 2,001 valid current events to prove the graph frontier cap is not reused; test 10,001 sentinel separately.

  ```ts
  const selected = await transformationTransaction(db, (tx) =>
    readUsReadinessEvidence(tx, tenantId, scope),
  );
  expect(selected.facts.events.map((e) => e.id)).toEqual([shippingId]);
  expect(selected.dependencyCount).toBe(1);
  expect(selected.facts.lots.some((l) => l.id === voidOutputId && !l.currentOrigin)).toBe(true);
  ```

- [ ] **Step 2: Run red.** With owned `US_TEST_DATABASE_URL`, run `corepack pnpm --filter @markiro/api exec vitest run test/us-readiness-evidence.e2e.test.ts`; require executed assertions, not skips.
- [ ] **Step 3: Implement scoped selection and frozen adapter.** Use tenant predicates on **every** root, event, child and lot join. Apply date and direct line product/lot `EXISTS` before batching; select whole event IDs with a `LIMIT 10001` sentinel. Select orphan candidates from historical origin line/event dates, deduplicate lot IDs, load at most 10,001 lots, and load all selected current children in bounded batches. For valid snapshots reuse `validateCurrentTraceEvent` integrity checks; for business-incomplete snapshots use a readiness-specific versioned shape that retains event/line identity and accepts only business-field gaps, then verify saved IDs/line order/tenant against child rows. Unknown snapshot version or broken structural identity is 503. Query dependent current origins independently of display date/filter and return only normalized facts, not mutable master descriptions. Use a local statement timeout and deadline; no graph traversal or one-query-per-event loop.

  ```sql
  WITH typed_current_roots AS (
    SELECT tenant_id,current_event_id,'receiving' AS type FROM receiving_event_roots
    UNION ALL SELECT tenant_id,current_event_id,'transformation' FROM transformation_event_roots
    UNION ALL SELECT tenant_id,current_event_id,'shipping' FROM shipping_event_roots
  ), typed_lines AS (
    SELECT tenant_id,event_id,lot_id FROM receiving_event_items
    UNION ALL SELECT tenant_id,event_id,lot_id FROM transformation_event_inputs WHERE lot_id IS NOT NULL
    UNION ALL SELECT tenant_id,event_id,lot_id FROM transformation_event_outputs WHERE lot_id IS NOT NULL
    UNION ALL SELECT tenant_id,event_id,lot_id FROM shipping_event_items
  )
  SELECT e.id FROM traceability_events e
  JOIN typed_current_roots r ON r.tenant_id=e.tenant_id AND r.current_event_id=e.id AND r.type=e.type
  WHERE e.tenant_id=:tenant AND e.status='finalized' AND e.superseded_by_event_id IS NULL
    AND e.event_date BETWEEN :from AND :to
    AND (:lot_id IS NULL OR EXISTS (SELECT 1 FROM typed_lines l WHERE l.tenant_id=e.tenant_id AND l.event_id=e.id AND l.lot_id=:lot_id))
  ORDER BY e.event_date,e.id LIMIT 10001;
  ```

  The executed Drizzle SQL also applies `productId` through tenant-scoped lot/product and frozen line predicates **before** `LIMIT`; the excerpt pins the current-root and whole-event selection, not permission to omit product filtering. Match the existing trace/search `SET LOCAL statement_timeout='5s'` plus a five-second application deadline; a timeout fails the whole assessment.

- [ ] **Step 4: Run green and review.** Run new evidence, existing current trace, Search/Lot Card and lifecycle focused DB suites; API typecheck/lint/build. Inspect SQL tenant keys and `EXPLAIN (ANALYZE, BUFFERS)` on a controlled seed. Verify 10,001 is a failure sentinel, not a 10,000-row success truncation; report measured duration rather than claiming production throughput.

### Task 4: One complete assessment and separate draft work

**Files:** Create `apps/api/src/modules/traceability/trace/us-readiness-assessment.ts`, `apps/api/test/us-readiness-assessment.e2e.test.ts`; modify `apps/api/src/modules/traceability/trace/us-trace-store.ts`.

**Interfaces:** `assessUsReadiness(tx, tenantId, scope, profileCode): Promise<UsReadinessResult>` consumes Task 3 evidence and Task 2 pure findings. `UsTraceStore.readiness(tenantId, actorUserId, rawQuery)` enters `transformationTransaction`, calls `authorizeUsMasterData(..., US_CAPABILITY.READ)`, reads the validated tenant `orgProfiles.timeZone`, obtains tenant-local today, resolves Task 1's scope, distinguishes missing/foreign explicit IDs as 404, and calls the assessment. Draft preview is at most 50 entries with exact total, `hasMore`, and a link to the existing Events list; drafts have no effect on finalized counts/findings.

- [ ] **Step 1: Write failing disposable-DB tests.** Assert one-source-of-truth severity/group totals, stable finding order/key/deduplication, `state='empty'` versus assessed zero gaps, processor/generic profile isolation, tenant-local day around UTC midnight, 50+ drafts with exact count/continuation link, explicit foreign/missing lot/product 404, revoked reader 403, and unchanged audit/business rows. Run a concurrent amend/void to prove the response uses one repeatable-read snapshot. A storage timeout/cap exceed must fail 503, not return partial findings.

  ```ts
  const result = await store.readiness(tenantId, readerId, { lotId: voidOutputId });
  expect(result.findings).toContainEqual(
    expect.objectContaining({ code: "origin_gap", severity: "error", lotId: voidOutputId }),
  );
  expect(result.counts.error).toBe(result.findings.filter((f) => f.severity === "error").length);
  expect(result.draftWork.total).toBeGreaterThanOrEqual(result.draftWork.items.length);
  ```

- [ ] **Step 2: Run red.** `corepack pnpm --filter @markiro/api exec vitest run test/us-readiness-assessment.e2e.test.ts` with `US_TEST_DATABASE_URL`; require real DB assertions.
- [ ] **Step 3: Compose in one read transaction.** Derive `assessedAt` once; use a tenant timezone formatter for civil `today`. Build a canonical finding key from rule code and source identity; reject a 10,001st finding as 503 before response parsing. Derive counts and grouped rows from the deduplicated findings only, and parse through `usReadinessResultSchema` before returning. No audit write or cached readiness row is added. Preserve only explicit 400/403/404; map inconsistent or unavailable storage to sanitized 503.

  ```ts
  const evidence = await readUsReadinessEvidence(tx, tenantId, scope);
  const findings = deduplicateAndSort(assessFrozenReadiness({ profileCode, ...evidence.facts }));
  return usReadinessResultSchema.parse({
    scope,
    assessedAt,
    state: evidence.selectedEventCount + evidence.selectedLotCount ? "assessed" : "empty",
    recordsChecked: { events: evidence.selectedEventCount, lots: evidence.selectedLotCount },
    dependenciesChecked: evidence.dependencyCount,
    counts: countSeverities(findings),
    groups: groupFindings(findings),
    findings,
    draftWork: evidence.draftWork,
  });
  ```

  Define `deduplicateAndSort(findings: readonly ReadinessRuleFinding[]): UsReadinessFinding[]`, `countSeverities(findings): {error:number,warning:number,info:number}` and `groupFindings(findings): UsReadinessGroup[]` as local pure functions in `us-readiness-assessment.ts`; `groupFindings` groups the exact final finding array by CTE/product/severity, never a second database query.

- [ ] **Step 4: Run green and review.** Run new assessment plus evidence tests, API test/typecheck/lint/build and platform-contracts/domain build. Review that no out-of-scope source enters counters/findings, no draft enters finalized evidence, no mutable master rename changes saved findings, and no raw TLC/document text reaches logs.

### Task 5: Exact U.S. HTTP and check-only transport

**Files:** Create `apps/api/src/deployment/us-readiness.controller.ts`, `apps/api/test/us-readiness-http.e2e.test.ts`; modify `apps/api/src/deployment/us-development.module.ts`, `apps/admin/vite.us.config.ts`, `.github/workflows/us-development.yml`, `tools/us-development/test/browser-entry.test.mjs`; add `tools/us-development/test/readiness-transport.smoke.mjs` only if real dev/preview transport is not already covered by browser-entry tests.

**Interfaces:** Mount only `GET /api/us/traceability/readiness`. Reuse `UsSessionGuard`, `ApiZodQuery`, `ApiZodResponse`, `runtime.databaseOperation`, raw URL duplicate-key rejection and `Cache-Control: no-store`. The Vite dev/preview proxy accepts only this anchored GET route with zero to four unique approved query keys; RU fallback, writes, extra suffixes and unrecognized/duplicate fields remain denied. CI runs the new domain, contract and API suites against disposable local PostgreSQL and performs no build publication/deployment.

- [ ] **Step 1: Write failing HTTP/proxy tests.** Assert 200 shape/cache header, date/product/lot query pass-through, 400 duplicate/unknown/invalid dates, 401 no session, 403 revoked capability, same 404 for foreign/missing explicit ID, 503 corrupt snapshot/timeout/cap, no business/audit writes, and 404 for RU or unsupported method. Assert proxy accepts only exact route/query and the check-only workflow includes focused readiness suites without release credentials.

  ```ts
  await request(app.getHttpServer())
    .get("/api/us/traceability/readiness?eventDateFrom=2026-01-01")
    .set("Cookie", readerCookie)
    .expect(400);
  await request(app.getHttpServer())
    .get("/api/us/traceability/readiness?lotId=" + foreignLotId)
    .set("Cookie", readerCookie)
    .expect(404);
  ```

- [ ] **Step 2: Run red.** With `US_TEST_DATABASE_URL`, run `corepack pnpm --filter @markiro/api exec vitest run test/us-readiness-http.e2e.test.ts`; separately run `node --test tools/us-development/test/browser-entry.test.mjs`. Expect missing route/proxy failures, not skipped DB infrastructure.
- [ ] **Step 3: Wire the exact read route.** Register `UsReadinessController` only in `UsDevelopmentModule`. Parse `URLSearchParams` once and reject repeated decoded keys before calling `runtime.trace.readiness`; annotate all 200/400/401/403/404/503 schemas. Add an anchored query-key allowlist to the U.S. Vite config and check-only CI with no wildcard or RU import.

  ```ts
  @Get("readiness")
  @Header("Cache-Control", "no-store")
  @ApiZodQuery(usReadinessQuerySchema)
  @ApiZodResponse({ status: 200, schema: usReadinessResultSchema })
  read(@Req() request: UsRequest) {
    const { principal, query } = this.readRequest(request);
    return this.runtime.databaseOperation(() => this.runtime.trace.readiness(principal.tenantId, principal.userId, query));
  }
  ```

- [ ] **Step 4: Run final gates and review.** Build domain, platform-contracts and DB before consumer tests. Run all focused readiness/adjacent trace suites with disposable PostgreSQL, package `test typecheck lint build` for domain/contracts/API, U.S. proxy/transport/isolation checks, `corepack pnpm format:check` and `git diff --check`. Inspect the complete three-dot diff against `origin/main` before any later PR. Report DB skips, browser rendering, hosting and regulatory validation separately; no release or push is part of this plan.

## Handoff to the final US-06 office phase

The later office plan consumes the stable Readiness response together with current trace, Search/Lot Card and excluded history. It renders server-derived counts/findings and separate drafts in EN/ES, preserving source links, empty/no-gaps/error states, 1024 px access, light/dark and keyboard operation. It cannot claim export-ready if `origin_gap` or any other blocking error remains. This server plan adds no UI or release path.
