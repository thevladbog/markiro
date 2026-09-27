# US-06 Current Trace Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an authorized U.S. tenant one consistent, bounded, read-only Receiving → Transformation → Shipping trace with identical graph/table evidence and separate excluded-revision history.

**Architecture:** Strict shared contracts describe the trace and history. A U.S.-only store reads frozen, current event evidence in repeatable read, validates root/row/line relationships, and feeds a deterministic breadth-first projection; a separate paginated history reader never alters the current graph. The HTTP controller is mounted only by `UsDevelopmentModule` and uses the existing U.S. session, capability and safe-error boundaries. Search, lot card, readiness and office UI are separate US-06 plans.

**Tech Stack:** Node >=24, repository-pinned pnpm through Corepack, TypeScript, Zod, Drizzle, PostgreSQL, NestJS, Vitest. No new dependency or migration in this plan.

**Spec:** [Approved US-06 design](../specs/2026-09-27-us-06-current-trace-search-readiness-design.md). Read it with [U.S. MVP contract](../../us/mvp-contract.md), root `AGENTS.md` and `apps/api/AGENTS.md` if present before implementation. The spec's P0 delivery order makes this the first of four separately reviewed plans.

## Global Constraints

- Work only on `codex/us-mvp` in its isolated checkout. Do not mount routes in the RU app, merge to `main`, deploy, release, provision hosting or enable a public endpoint.
- Read capability and tenant/actor come from the verified current U.S. session. Missing and foreign lot IDs have the same 404. No client tenant parameter, business write or read-side audit write.
- The current event predicate is root `current_event_id = event.id`, `status='finalized'`, `superseded_by_event_id IS NULL`, same tenant and correct type. A pending amendment leaves its predecessor current.
- Read only frozen finalization evidence: Receiving v1/v2/v3, Transformation v1 and Shipping v1. Preserve civil `event_date`, saved timezone, exact decimal text/UOM and line identity. Never hydrate an historical description from mutable master rows.
- Default `direction=both`, `maxDepth=16`; hard caps: depth 20, all node kinds 500, all evidence edges 2,000. Limits must be explicit and event expansion atomic. Storage inconsistency or timeout is a safe retryable 503, not an HTTP 200 incomplete graph.
- Use the owned disposable `US_TEST_DATABASE_URL` harness only; do not load or mutate the primary checkout's `.env` or a shared database. A skipped DB test is not evidence. Build shared package `dist` before consumers.
- P0 excludes Station, scanners, labels, physical case proof, P1 percentages/partner expectations and any regulatory verdict. EN/ES UI work is outside this server plan.
- Each task gets a focused failing test first and a scoped diff/review checkpoint. Do not commit or push during execution without the user's separate authorization; the code snippets below are implementation guides, not permission to publish.

## Review Focus

- Repeated source/recipient identity: two distinct saved lines pointing at the same location must remain two evidence edges with distinct line positions (Task 2 DB fixture and Task 3 projection test).
- `maxDepth=0`: show only root-lot evidence that needs no second lot; do not leak half a Transformation event or claim a complete chain (Task 3 test).
- A valid pending amendment alongside a finalized predecessor: predecessor remains current while the draft appears only in history (Tasks 2 and 4 tests).
- A 2→2 Transformation at the node/edge boundary: include both inputs and both outputs or none of that event, with a named limit and correct returned counts (Task 3 test).
- Corrupt current-root pointer, missing frozen child or statement timeout: return 503 and no successful partial graph; a permitted voided origin is instead an explicit `origin_gap` (Tasks 2, 3 and 5 tests).

---

## File responsibilities and contract between tasks

- `packages/platform-contracts/src/traceability/current-trace.ts`: strict query/result/history schemas and exported types; `packages/platform-contracts/src/index.ts` exports them. No tenant ID in input.
- `apps/api/src/modules/traceability/trace/us-trace-evidence.ts`: discriminated internal frozen evidence and pure validation/projection of one event; it may reuse existing snapshot Zod schemas, not duplicate their rules.
- `apps/api/src/modules/traceability/trace/us-trace-query.ts`: tenant-scoped current-frontier and frozen-event reads plus integrity checks; accepts the transaction type used by `authorizeUsMasterData`.
- `apps/api/src/modules/traceability/trace/us-trace-project.ts`: pure, deterministic BFS assembly and atomic limits; the graph and table consume the same `edges` array.
- `apps/api/src/modules/traceability/trace/us-trace-store.ts`: repeatable-read orchestration, lot existence/capability check, bounded query loop and result validation.
- `apps/api/src/modules/traceability/trace/us-trace-history.ts`: stable cursor history and excluded count for the visible scope; no history row enters current projection.
- `apps/api/src/deployment/us-trace.controller.ts`, `us-development.module.ts`, `us-runtime.ts`: U.S.-only HTTP route, OpenAPI and runtime wiring.
- `apps/admin/vite.us.config.ts` and `tools/us-development/test/browser-entry.test.mjs`: exact local-only proxy paths; no UI route or page in this plan.
- `.github/workflows/us-development.yml`: include focused suites in the check-only U.S. job; do not touch release/deploy jobs.

The internal types below are fixed for this plan. `TraceEventEvidence` is normalized from a parsed, immutable `snapshot` union and carries saved line projections. `TraceFrontierPage` detects one sentinel when more candidates exist. The store throws an unavailable error on missing/contradictory evidence; the pure projector only produces a `limited` response for honest traversal limits.

```ts
type TraceDirection = "backward" | "forward" | "both";
type TraceLine = {
  side: "receiving" | "input" | "output" | "shipping";
  lineNo: number;
  lotId: string | null;
  nodeId: string;
  quantity: string | null;
  unitOfMeasure: string | null;
};
type TraceEventEvidence = {
  id: string;
  rootId: string;
  type: "receiving" | "transformation" | "shipping";
  eventNumber: string;
  revision: number;
  eventDate: string;
  timeZone: string;
  lines: readonly TraceLine[];
};
type TraceFrontierPage = { events: readonly TraceEventEvidence[]; hasMore: boolean };
```

The executor may make `TraceLine` a discriminated union to encode per-CTE labels and snapshots more precisely, but its public response and test semantics must remain as specified. Stable node IDs use typed namespaces (`lot:<uuid>`, `location:<uuid>`, `transformation:<event-uuid>`, `material:<event-uuid>:<lineNo>`); edge IDs use `<event-uuid>:<side>:<lineNo>`, so repeat lines never collapse. The public result schema must include frozen display labels/snapshot provenance for each non-lot node; `nodeId` is never a substitute for the human-visible saved source/recipient/product text.

## Test environment

Use `createUsProfileTestDatabase` and the fixture patterns in `apps/api/test/support/us-transformation-genealogy-fixture.ts` and `apps/api/test/us-events-http.e2e.test.ts`. Check the actual helper filename before coding. A database URL must point to a disposable local synthetic PostgreSQL parent; CI uses `US_TEST_DATABASE_URL` in `.github/workflows/us-development.yml`. Run `corepack pnpm --filter @markiro/platform-contracts build` and `corepack pnpm --filter @markiro/db build` before API tests. If `graphify-out/graph.json` exists, query it before code work and run `graphify update .` after modifications. This plan does not modify DB schema; an index proposal requires separate query-plan evidence and migration review.

### Task 1: Strict current-trace and history contracts

**Files:** Create `packages/platform-contracts/src/traceability/current-trace.ts`; modify `packages/platform-contracts/src/index.ts`; create `packages/platform-contracts/test/us-current-trace.test.ts`.

**Interfaces:** Produces `usCurrentTraceQuerySchema`, `usCurrentTraceResultSchema`, `usTraceHistoryQuerySchema`, `usTraceHistoryCursorSchema`, `usTraceHistoryPageSchema` and inferred `UsCurrentTraceResult`/`UsTraceHistoryPage` types. HTTP query schemas parse strings strictly into `{direction,maxDepth,maxNodes}` and `{limit,cursor?}`; unknown keys, repeated keys, noncanonical integers, over-cap values and tenant IDs fail. Result has `rootLotId`, direction, ordered `nodes`, `edges`, `currentEvents`, `excludedSummary`, and `completion: {state:"complete"|"limited"; limit?:"depth"|"nodes"|"edges"; returnedNodes; returnedEdges}`. History page has bounded `items`, `nextCursor` and exact excluded status/reason/revision links.

- [ ] **Step 1: Add failing contract tests.** Exercise defaults, caps and strict extra keys; pin the edge provenance and no fake 2→2 quantity allocation. The test shape is:

  ```ts
  expect(usCurrentTraceQuerySchema.parse({})).toEqual({
    direction: "both",
    maxDepth: 16,
    maxNodes: 500,
  });
  expect(usCurrentTraceQuerySchema.safeParse({ maxDepth: "21" }).success).toBe(false);
  expect(usCurrentTraceQuerySchema.safeParse({ tenantId: "other" }).success).toBe(false);
  expect(usTraceHistoryQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
  ```

- [ ] **Step 2: Run red.** `corepack pnpm --filter @markiro/platform-contracts exec vitest run test/us-current-trace.test.ts`; expected failure is a missing export, not a package build/connection error.
- [ ] **Step 3: Add the strict schemas and exports.** Reuse `platformUuidSchema`, saved UOM/quantity rules and `.strict()` conventions. Model typed nodes (`lot`, `location`, `transformation`, `material`), typed evidence edges (`receiving`, `transformation_input`, `transformation_output`, `shipping`), and optional line quantity only where frozen evidence contains it. Reject a `complete` result with a limit and any edge whose endpoint is absent. Parse query values with a single canonical decimal-string helper:

  ```ts
  const boundedInt = (max: number) =>
    z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .transform(Number)
      .pipe(z.number().int().min(0).max(max));
  const direction = z.enum(["backward", "forward", "both"]);
  ```

  For history, use a base64url cursor of a strict JSON object `{createdAt:string,eventId:string}` (UTC instant and UUID); drafts and original-draft voids may lack an event date. Parse/decode inside the reader with `BadRequestException` for invalid cursors. `limit` defaults to 50, maximum 100. Return only opaque cursor text over HTTP.

- [ ] **Step 4: Run green and package gates.** Focused test, then `corepack pnpm --filter @markiro/platform-contracts test`, `typecheck`, `lint`, `build`. Verify malformed/duplicate query keys also fail at the HTTP boundary in Task 5, because a Zod object alone cannot see duplicate URL keys.
- [ ] **Step 5: Review checkpoint.** Confirm no tenant or actor in request, no history edge in result, no quantity on direct lot→lot navigation, and `git diff --check`.

### Task 2: Current frozen evidence reader and integrity boundary

**Files:** Create `apps/api/src/modules/traceability/trace/us-trace-evidence.ts` and `us-trace-query.ts`; create `apps/api/test/us-trace-evidence.e2e.test.ts`. Reuse (do not change without a test) `receiving/us-receiving-chain.ts`, `transformation/us-transformation-genealogy-query.ts`, `shipping/us-shipping-history.ts` or their corresponding reader helpers.

**Interfaces:** Consumes Task 1 schemas and the `TraceEventEvidence` shape above. Produces `readCurrentTraceFrontier(tx,tenantId,lotIds,direction,limit): Promise<TraceFrontierPage>` and `assertCurrentTraceOrigin(tx,tenantId,lotIds): Promise<Set<string>>` (`Set` contains IDs with current origin). Both are strictly read-only. `readCurrentTraceFrontier` fetches at most `limit+1` candidate event IDs ordered by `event_date,event_id`, then loads full saved evidence for the selected IDs; the `+1` is a sentinel, not a silently omitted event. It validates every selected event's typed root, current pointer, status, supersession, saved event date/timezone and frozen line identities. `assertCurrentTraceOrigin` distinguishes a valid no-current-origin lot after void from a corrupt root relation.

- [ ] **Step 1: Write failing disposable-DB tests.** Seed one current Receiving, 2→1 and 2→2 Transformation, one Shipping, and a pending amendment. Assert only root-current finalized revisions appear, quantities and one-based line positions equal saved snapshots, and mutable product/location description edits do not change output. Test the pure evidence validator with a mismatched root pointer or saved line; use a rolled-back SQL corruption fixture only if the schema permits it without disabling constraints. Expect `unavailable()` for contradictions; void an origin through its supported command and expect an empty current-origin set instead. Include cross-tenant reads and a two-line specimen with the same saved location where line positions must not collapse.

  ```ts
  const page = await readCurrentTraceFrontier(tx, tenantId, [lotId], "both", 20);
  expect(page.events.map((event) => event.type)).toEqual([
    "receiving",
    "transformation",
    "shipping",
  ]);
  expect(
    page.events.flatMap((event) => event.lines).filter((line) => line.lotId === lotId),
  ).toEqual(expect.arrayContaining([expect.objectContaining({ lineNo: 1 })]));
  ```

- [ ] **Step 2: Run red.** With `US_TEST_DATABASE_URL` already exported for the owned disposable database, run `corepack pnpm --filter @markiro/api exec vitest run test/us-trace-evidence.e2e.test.ts`; expected failure is missing reader, not skipped infrastructure. Do not put credentials from a private `.env` into logs.
- [ ] **Step 3: Implement the bounded reader.** Join roots by `(tenant_id,root_event_id)` and typed root table, check `current_event_id=id`, `status='finalized'`, `superseded_by_event_id IS NULL`; fetch and parse `finalization_snapshot` through existing Receiving v1/v2/v3, Transformation v1 and Shipping v1 schemas. Receiving may use `snapshot.items[].lineNo`, Transformation `inputs/outputs[].lineNo`, Shipping `items[].lineNo`. Confirm each frozen lot/line matches its saved child row or retained Receiving binding, event identity, date and revision. Normalize only after validation:

  ```ts
  const selected = candidateIds.slice(0, limit);
  const events = await loadAndValidateFrozenEvents(tx, tenantId, selected);
  return { events, hasMore: candidateIds.length > limit };
  ```

  `loadAndValidateFrozenEvents` is private in `us-trace-evidence.ts`; it must issue bounded tenant-scoped queries and throw `unavailable()` on missing or contradictory rows. Never use `lot_genealogy_edges` as quantity evidence. A corrupt reachable child without a valid parent must not disappear behind a parent-first join; use the established child-first integrity pattern. Keep reads inside the caller's transaction.

- [ ] **Step 4: Run green and adjacent regressions.** Run the new suite plus `us-transformation-genealogy.e2e.test.ts`, `us-events-registry.e2e.test.ts`, `us-shipping-revisions.e2e.test.ts` and Receiving history tests. Check returned snapshot descriptions after master-data mutation. Build `@markiro/db` first if its source changed (not expected).
- [ ] **Step 5: Review checkpoint.** Inspect query bounds, indexes and `EXPLAIN` on the owned test DB. Record measured behavior; do not add an index or migration speculatively. Check tenant composite joins and read-only SQL.

### Task 3: Deterministic atomic graph/table projection

**Files:** Create `apps/api/src/modules/traceability/trace/us-trace-project.ts`, `us-trace-store.ts`; create `apps/api/test/us-trace-project.test.ts` and `us-trace-store.e2e.test.ts`.

**Interfaces:** Consumes `readCurrentTraceFrontier`, `assertCurrentTraceOrigin` and Task 1 result schema. Produces `UsTraceStore.read(tenantId:string,actorUserId:string,lotId:string,query:unknown): Promise<UsCurrentTraceResult>`. The pure projector takes a frontier, currently included nodes/edges and one complete `TraceEventEvidence`; it returns either a fully added event or a named limit without modifying its input. `UsTraceStore.read` wraps the entire read (including current capability reload, roots, all BFS rounds and excluded count) in repeatable read, as `readTransformationGenealogy` does.

- [ ] **Step 1: Write failing pure and DB tests.** In pure tests construct 2→2 with two input and two output line quantities, plus a non-FTL-only input event. Assert the four event–lot lines are four evidence edges (not four quantity-bearing lot→lot transfers), and the non-FTL material has no TLC. Assert graph/table use the exact `edges` array, deterministic order independent of candidate DB order, cycle termination, `maxDepth=0`, and atomic node/edge caps. DB test asserts two tenants reading the same UUID cannot see each other's lot, and a concurrent finalization does not mix pre/post revisions within a response.

  ```ts
  const next = addCompleteEvent(current, twoByTwoEvent, { maxNodes: 4, maxEdges: 2000 });
  expect(next.kind).toBe("limited");
  expect(next.graph).toEqual(current);
  expect(next.limit).toBe("nodes");
  ```

- [ ] **Step 2: Run red.** `corepack pnpm --filter @markiro/api exec vitest run test/us-trace-project.test.ts test/us-trace-store.e2e.test.ts`; expected missing implementation failure, with DB suite actually executed.
- [ ] **Step 3: Implement pure projection and orchestration.** Start with `lot:<id>`, sort each frontier by lot ID and candidates by `eventDate,eventId`, and use stable line order. A Transformation is an atomic star: all saved inputs plus outputs and its event node must fit before any are inserted. For backward BFS enqueue only input FTL lots; for forward only output lots; `both` traverses each direction with a shared visited `(lotId,direction)` key. Receiving yields source-location→lot; Shipping yields lot→recipient-location. Count all four node kinds and every evidence edge. Treat depth as lot hops; a candidate that would add another lot beyond `maxDepth` is withheld, setting `limit:"depth"`. Inspect one extra frontier to distinguish truly complete from limited. `origin_gap` is an independent finding on the returned lot nodes and does not set `completion.state='limited'` by itself.

  ```ts
  if (candidateNodes.size + graph.nodes.length > maxNodes)
    return { kind: "limited", limit: "nodes", graph } as const;
  if (candidateEdges.length + graph.edges.length > 2000)
    return { kind: "limited", limit: "edges", graph } as const;
  return { kind: "added", graph: addWholeEvent(graph, event) } as const;
  ```

  Ensure a previously included event is not counted or expanded twice, but its direction-specific reachable lots may still be enqueued once. Never treat a `hasMore` sentinel as normal completion. Validate the final result with `usCurrentTraceResultSchema`; parse failure is 503, not a partial 200.

- [ ] **Step 4: Run green and boundary tests.** Re-run pure/store suites and targeted existing genealogy tests. Force a statement timeout in the disposable DB test and assert `ServiceUnavailableException`, not `completion.state='limited'`. Verify exact event/line provenance and returned node/edge counts.
- [ ] **Step 5: Review checkpoint.** Inspect `maxDepth=0`, cycle, 2→2, 0-FTL-input and 500/2,000 boundaries against the spec. Confirm no graph/table second calculation or persisted writes.

### Task 4: Separate excluded history and visible-scope count

**Files:** Create `apps/api/src/modules/traceability/trace/us-trace-history.ts`; extend `us-trace-store.ts`; create `apps/api/test/us-trace-history.e2e.test.ts`.

**Interfaces:** Produces `UsTraceStore.history(tenantId:string,actorUserId:string,lotId:string,query:unknown): Promise<UsTraceHistoryPage>` and `countExcludedTraceRevisions(tx,tenantId,visibleLotIds): Promise<number>`. Cursor order is `(created_at,id)` ascending with a strict `>` keyset predicate and `limit+1` sentinel; UUID ensures a stable tie break even when event date is null. The history endpoint reloads capability and checks lot existence in its own repeatable-read transaction. Current graph uses only the count, never history rows.

- [ ] **Step 1: Write failing history tests.** Seed Receiving, Transformation and Shipping revisions touching visible lot IDs: draft, amended/superseded, void and current. Assert only excluded statuses are paginated; reason, previous/successor revision IDs, event number, date and status match saved rows. Page twice across equal dates and assert no duplicate/skip; malformed cursor 400; foreign lot 404; pending amendment predecessor remains current and draft is history. Assert `excludedSummary.count` is scoped to lots actually returned by a limited trace, not all tenant history.

  ```ts
  const first = await store.history(tenantId, readerId, lotId, { limit: "1" });
  const second = await store.history(tenantId, readerId, lotId, {
    limit: "1",
    cursor: first.nextCursor,
  });
  expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(2);
  ```

- [ ] **Step 2: Run red.** With the owned disposable `US_TEST_DATABASE_URL` exported, run `corepack pnpm --filter @markiro/api exec vitest run test/us-trace-history.e2e.test.ts`; expected missing method, not a skip.
- [ ] **Step 3: Implement tenant-scoped keyset history.** Find related revision IDs by frozen event lot child rows and typed roots, then select excluded rows with `(created_at,id) > (:createdAt,:id)` and `LIMIT limit+1`. Parse cursor before SQL; base64url decode is capped in length and validated against the Task 1 cursor schema. For void rows without a frozen snapshot, use saved lifecycle metadata and explicit status, not fabricated event evidence. Count excluded revisions by distinct event ID over visible lot IDs, including the root lot in a limited result. Check orphaned/mismatched relationships and fail 503 instead of returning a misleading smaller count.

  ```ts
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? encodeCursor(items.at(-1)!) : null };
  ```

- [ ] **Step 4: Run green.** New history suite, current store suite and existing lifecycle/history suites. Add a concurrent-write pagination test documenting keyset behavior (no duplicates for rows existing at page 1; newly created history may appear on a later page if its key is later). No pinned-revision reconstruction is implemented.
- [ ] **Step 5: Review checkpoint.** Confirm history is separate from current `nodes`/`edges`, count scope is visible, cursor is opaque and bounded, and no `offset`-based instability or business writes were added.

### Task 5: U.S.-only HTTP, local proxy and CI ownership

**Files:** Create `apps/api/src/deployment/us-trace.controller.ts`; modify `apps/api/src/deployment/us-development.module.ts`, `us-runtime.ts`, `apps/admin/vite.us.config.ts`, `.github/workflows/us-development.yml`, `tools/us-development/test/browser-entry.test.mjs`; create `apps/api/test/us-trace-http.e2e.test.ts`.

**Interfaces:** Mounts `GET /api/us/traceability/lots/:id/trace` and `/history` only in the U.S. module. Both call Task 3/4 store methods through `runtime.databaseOperation`; `UsSessionGuard`, `ApiZodQuery`, `ApiZodResponse` and the existing `usMasterData*` OpenAPI errors are reused. The proxy admits only canonical UUID paths and the exact allowed query keys; no wildcard route or RU fallback.

- [ ] **Step 1: Add failing HTTP/proxy tests.** Assert authorized 200, unauthenticated 401, missing current read capability 403, absent and cross-tenant lot identical 404, malformed UUID/query/duplicate key/over-cap/cursor 400, and corrupted storage/timeout 503. Capture audit/business-table counts before and after reads and assert unchanged. Assert the U.S. proxy admits both exact paths and rejects `tenantId`, duplicate keys, invalid UUID, extra suffix and writes. The HTTP test starts from `us-events-http.e2e.test.ts` harness; add no deployment call.

  ```ts
  await request(app.getHttpServer())
    .get(`/api/us/traceability/lots/${foreignLotId}/trace`)
    .set("Cookie", readerCookie)
    .expect(404);
  await request(app.getHttpServer())
    .get(`/api/us/traceability/lots/${lotId}/trace?maxDepth=1&maxDepth=2`)
    .set("Cookie", readerCookie)
    .expect(400);
  ```

- [ ] **Step 2: Run red.** With the owned disposable `US_TEST_DATABASE_URL` exported, run `corepack pnpm --filter @markiro/api exec vitest run test/us-trace-http.e2e.test.ts`; run `node --test tools/us-development/test/browser-entry.test.mjs` separately. Expected 404/missing route or proxy test failure, not an infra skip.
- [ ] **Step 3: Wire the route and exact proxy.** Follow `UsEventsController` and `UsRuntime.events` patterns. Register only `UsTraceController` in `UsDevelopmentModule`. Parse query once, explicitly reject array-valued duplicate keys before Zod; validate `:id` as UUID and use the same 404 for foreign/missing IDs. Add Swagger success/400/401/403/404/503 schemas. Extend the local proxy's anchored regexes with only `trace` and `trace/history` GET and strict parameter order/keys; a malformed request may be rejected at proxy or API but never forwarded to an RU endpoint. Add the new contract/API suites to `.github/workflows/us-development.yml` check-only jobs.

  ```ts
  return this.runtime.databaseOperation(() =>
    this.runtime.trace.read(principal.tenantId, principal.userId, id, query),
  );
  ```

- [ ] **Step 4: Run green and proportionate gates.** Run contract, pure, DB and HTTP suites under a real disposable local DB; `node --test tools/us-development/test/browser-entry.test.mjs tools/us-development/test/isolation.test.mjs`; platform-contracts and API package `test`, `typecheck`, `lint`, `build`; `corepack pnpm format:check`; `git diff --check`. Verify the workflow YAML check-only ownership and no release/deploy job/path change. Record tests that require services and were not run; never report a skip as green coverage.
- [ ] **Step 5: Review checkpoint.** Compare the complete three-dot diff with `origin/main` separately from this plan's scoped diff; check both allowlists, `Cache-Control: no-store`, exact audit/business non-write assertion, and no accidental RU or public route. Report automated evidence separately from live hosting, browser rendering, hardware and regulatory acceptance. Do not dispatch a production workflow.

## Handoff to the remaining US-06 plans

After owner review and this server slice's verified execution, separately plan (1) tenant-scoped search and lot card, including source-qualified TLC and historical SSCC, (2) concrete readiness findings/counts without a percentage, and (3) EN/ES office Graph/Table, Excluded/history, search/card/readiness presentation. Later views consume this server's `edges` and completion contract; they do not reinterpret excluded revisions as current evidence. US-09 pinned requests remain a later project.
