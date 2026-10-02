# US-06 Search and Lot Card Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authorized U.S. tenant find source-qualified lots through current CTE evidence and current or historical SSCC links, then read one lot's current identity, provenance, balance and paginated frozen evidence without confusing history with the current chain.

**Architecture:** Strict shared contracts define bounded search, a lot-card summary and a separate evidence page. U.S.-only stores use tenant-scoped repeatable-read transactions and the current-root predicate from the completed trace server; the existing Cases, trace/history and genealogy endpoints remain the drill-downs. Search and card routes join only the U.S. controller/proxy allowlists. Readiness and office UI have their own later plans.

**Tech Stack:** Node >=24, repository-pinned pnpm via Corepack, TypeScript, Zod, Drizzle, PostgreSQL, NestJS, Vitest. No new dependency or migration is presumed.

**Spec:** [Owner-approved US-06 design](../specs/2026-09-27-us-06-current-trace-search-readiness-design.md), especially “Search and lot card”; also read [U.S. MVP contract](../../us/mvp-contract.md), root `AGENTS.md`, and `apps/api/AGENTS.md` if present. This is phase 2 of four; the [current trace server plan](2026-09-27-us-06-current-trace-server.md) and its code are the implemented baseline, not a request to redo it.

## Global Constraints

- Work only in the isolated `codex/us-mvp` checkout. Do not merge to `main`, deploy, release, provision hosting, mount RU routes, or add Station/scanner/printing work. Commit/push require the owner's separate authorization.
- Search and card use the verified session's tenant and current `US_CAPABILITY.READ`; never accept tenant or actor from a request. Missing and foreign lot IDs are indistinguishable 404s. Reads write neither business state nor audit rows.
- A current CTE requires a same-tenant typed root pointing at a finalized, unsuperseded event. Pending amendments do not withdraw the predecessor. Historical SSCC links are searchable but are **not** current case links; excluded CTE revisions remain in the existing `/trace/history` endpoint.
- TLC is an opaque, case-sensitive string. Exact/list search does not parse it numerically; range comparison is PostgreSQL `COLLATE "C"` text order and must be labelled lexical. Equal TLCs with different source identities remain separate lot rows.
- Document type/number and origin product description come from frozen finalization snapshots, never today's mutable reference-document/product name. Current master product name, if shown, is labelled separately. All event dates are civil `YYYY-MM-DD`; timestamp cursors are UTC instants.
- `GET /api/us/traceability/search` defaults to 50 lots, caps at 100 and uses a stable `(lot.created_at, lot.id)` keyset cursor. Its `tlcList` parameter is a JSON array string of 1–50 distinct TLCs, capped at 8 KiB; no comma splitting. Each response page and each SSCC evidence sample is bounded and indicates more data rather than silently truncating.
- `GET /api/us/traceability/lots/:id/card` is a current summary; `.../card/evidence` is a separate keyset page (default 20, cap 50 current events). The existing case-list, trace and trace/history endpoints supply full paginated drill-down. Balance is current operational information, not historical before/after inventory.
- Malformed/duplicate query keys or exceeded caps return 400; unavailable or contradictory storage returns retryable 503, never a successful partial result. Search with no matches returns an empty 200 page. No raw TLC list or full document body is logged.
- Build shared `dist` before consumers. Database tests must actually run against the owned disposable `US_TEST_DATABASE_URL` harness; a skip does not prove behavior. Do not load the primary checkout's `.env` or mutate shared databases. EN/ES office presentation and regulatory conclusions are outside this server plan.

## Review Focus

1. A numeric 18-character value can be a TLC, document number and SSCC: one lot result retains every applicable `matchedBy` value; an unlinked historical SSCC result is labelled historical (Task 2 tests).
2. Two lots sharing a TLC but having different source identities remain two rows, each with its own source; no first-match redirect or cross-tenant leakage (Task 2 tests).
3. Changing a mutable document number or product name after finalization cannot change a frozen-document hit or the origin snapshot shown on a card (Tasks 2 and 3 tests).
4. A voided Transformation origin keeps lot identity and active case links but exposes `origin_gap`; no void event enters the current timeline and balance stays explicitly current/unknown (Task 3 tests).
5. A lot with many current events or repeated SSCC link/unlink cycles cannot create an unbounded response or hide history as current; cursor pages have no duplicate/skip for pre-existing rows (Tasks 2 and 3 tests).

---

## File responsibilities and task interfaces

- Create `packages/platform-contracts/src/traceability/search-lot-card.ts` and export it from `packages/platform-contracts/src/index.ts`: strict query/result schemas and inferred types. `UsTraceSearchQuery` is normalized by `parseUsTraceSearchQuery(raw: unknown)`; cursors are canonical base64url JSON. `UsTraceSearchPage` has `items`, `nextCursor`, `appliedFilters` and explicit lexical-range labelling. Each hit has lot ID, TLC, source-qualified identity, status, `matchedBy`, current CTE count/first/last dates and at most 20 SSCC link evidence rows with `moreCaseHistory`.
- Create `apps/api/src/modules/traceability/trace/us-trace-search-query.ts`: parse/validate bounded search and evidence cursors; produce normalized filter predicates. The controller rejects duplicate raw URL keys before this parser.
- Create `apps/api/src/modules/traceability/trace/us-trace-search.ts`: `searchUsTraceability(tx, tenantId, query): Promise<UsTraceSearchPage>`. Candidate lot selection, current CTE aggregation, frozen-document matching and bridge-link evidence live here. Do not reuse the operational lot list's offset pagination.
- Create `apps/api/src/modules/traceability/trace/us-lot-card.ts`: `readUsLotCard(tx, tenantId, lotId): Promise<UsLotCard>` and `readUsLotCardEvidence(tx, tenantId, lotId, query): Promise<UsLotCardEvidencePage>`. This module selects direct current CTEs, parses each supported frozen snapshot version, and returns exact event/revision/line/document references. It composes case counts and the existing current shipping-balance calculation in the same read snapshot; full case rows and genealogy remain separate existing reads.
- Extend `apps/api/src/modules/traceability/trace/us-trace-store.ts`: `search`, `card`, `cardEvidence` methods each authorize within a repeatable-read transaction and map storage inconsistency to 503. Create `apps/api/src/deployment/us-search-lot-card.controller.ts` with the class path `traceability`; register it in `apps/api/src/deployment/us-development.module.ts` only. Extend `apps/api/src/deployment/us-runtime.ts`, `apps/admin/vite.us.config.ts`, `.github/workflows/us-development.yml` and `tools/us-development/test/browser-entry.test.mjs` for exact U.S. GET routes. Do not add an RU module import.
- Tests: create `packages/platform-contracts/test/us-search-lot-card.test.ts`, `apps/api/test/us-trace-search.e2e.test.ts`, `apps/api/test/us-lot-card.e2e.test.ts`, `apps/api/test/us-search-lot-card-http.e2e.test.ts`. Reuse `apps/api/test/support/us-profile-database.ts` and existing Receiving, Transformation, Shipping and case-bridge fixture builders; keep created databases disposable.

### Task 1: Strict contracts and normalization

**Files:** Create `packages/platform-contracts/src/traceability/search-lot-card.ts`, `packages/platform-contracts/test/us-search-lot-card.test.ts`, `apps/api/src/modules/traceability/trace/us-trace-search-query.ts`; modify `packages/platform-contracts/src/index.ts`.

**Interfaces:** `parseUsTraceSearchQuery(raw: unknown): UsTraceSearchQuery` returns normalized `tlcList: string[] | null`, exact `q`, optional structured filters (`tlc`, `tlcFrom`, `tlcTo`, `lotId`, `productId`, `productText`, `sourceLocationId`, `sourceReferenceValue`, `eventType`, `eventDateFrom`, `eventDateTo`, `locationId`, `documentType`, `documentNumber`, `sscc`, `status`), `limit` and decoded `usTraceSearchCursorSchema` value. Source fields match the lot's qualified identity; `locationId` matches a participant in a **current frozen CTE**, not today's location description. `parseUsLotCardEvidenceQuery(raw: unknown)` returns `limit` and decoded `(eventDate,eventId)` cursor. Both throw the established 400 error shape.

- [ ] **Step 1: Write failing contract tests.** Assert defaults (search 50/card evidence 20), max values (100/50), strict unknown keys, canonical bounded cursor, civil-date ordering, invalid UUID/SSCC, `tlcList` JSON with a TLC containing a comma, duplicate/empty/51-item lists, reversed lexical range, and response refusal when `matchedBy` or SSCC evidence claims a historical link is current.

  ```ts
  expect(usTraceSearchQuerySchema.parse({ tlcList: '["A,B","007"]' }).tlcList).toEqual([
    "A,B",
    "007",
  ]);
  expect(() => usTraceSearchQuerySchema.parse({ tlcList: "A,B" })).toThrow();
  expect(() => usTraceSearchQuerySchema.parse({ limit: "101" })).toThrow();
  ```

- [ ] **Step 2: Run red.** `corepack pnpm --filter @markiro/platform-contracts exec vitest run test/us-search-lot-card.test.ts`; expect missing exports, not a passing empty suite.
- [ ] **Step 3: Add the exact schemas and cursor parser.** Use `platformUuidSchema`, existing civil-date, lot-status, document-type and UOM schemas; `.strict()` every object. Use a bounded JSON parser for `tlcList` and canonical base64url round-trip for cursors before SQL. Keep query values as HTTP strings until normalization; use `COLLATE "C"` only in the DB predicate, not a JavaScript locale comparison.

  ```ts
  const decoded = Buffer.from(rawCursor, "base64url");
  if (decoded.toString("base64url") !== rawCursor || decoded.length > 384)
    throw new BadRequestException({ code: "us_invalid_query" });
  return usTraceSearchCursorSchema.parse(JSON.parse(decoded.toString("utf8")));
  ```

- [ ] **Step 4: Run green.** Run the new contract test plus `corepack pnpm --filter @markiro/platform-contracts test`, `typecheck`, `lint`, `build`. Inspect inferred query/result types to ensure search/card producers can satisfy them without broad casts.
- [ ] **Step 5: Review checkpoint.** Confirm opaque TLC preservation, normalized filter echo, distinct source identity, `matchedBy` uniqueness and bounded response arrays. Do not add persistence or routes in this task.

### Task 2: Tenant-scoped current-evidence search and SSCC history

**Files:** Create `apps/api/src/modules/traceability/trace/us-trace-search.ts`, `apps/api/test/us-trace-search.e2e.test.ts`; extend `apps/api/src/modules/traceability/trace/us-trace-store.ts` with `search`.

**Interfaces:** `searchUsTraceability(tx, tenantId, query)` consumes Task 1's normalized query. `UsTraceStore.search(tenantId, actorUserId, rawQuery)` authorizes `US_CAPABILITY.READ` and owns the repeatable-read transaction. Each hit is keyed by lot ID, not TLC. Current CTE count/dates use distinct current event IDs; `matchedBy` is the sorted set of actual matching predicates, including multiple free-text kinds. SSCC evidence uses `trace_lot_boxes.sscc_at_link`, with active/historical state and provenance from `traceability_synthetic_case_origins`.

- [ ] **Step 1: Write failing disposable-DB tests.** Seed two tenants; two same-TLC/different-source lots; Receiving → 2→2 Transformation → Shipping; finalized and superseded documents with colliding numbers; a changed current document/product name; and an SSCC linked, unlinked with reason, then linked again. Assert source disambiguation, all true `matchedBy` values for numeric `q`, exact/list/lexical range, every structured filter, current-only CTE count/dates, frozen doc number, active versus historical SSCC evidence, synthetic/existing provenance, cross-tenant silence, default/maximum page and stable cursor order. Seed >20 repeated case links and assert `moreCaseHistory` and the existing case-list drill-down can retrieve the rest. Assert no business/audit writes and timeout → 503.

  ```ts
  const page = await store.search(tenant, reader, { q: "000000000000000123", limit: "1" });
  expect(page.items[0]?.matchedBy).toEqual(
    expect.arrayContaining(["tlc", "document_number", "sscc_historical"]),
  );
  expect(page.items[0]?.ssccLinks.some((link) => link.state === "historical")).toBe(true);
  ```

- [ ] **Step 2: Run red.** With `US_TEST_DATABASE_URL` exported for the owned loopback harness, run `corepack pnpm --filter @markiro/api exec vitest run test/us-trace-search.e2e.test.ts`; require executed DB assertions, not skips.
- [ ] **Step 3: Implement search in one read snapshot.** Select tenant lots by exact/structured filters and `EXISTS` subqueries against current-root CTEs, frozen snapshot documents and bridge history. Use `LIMIT limit+1` after lot qualification, ordered by `(created_at,id)`; then hydrate only selected IDs with distinct current event counts/dates and bounded case-link evidence. For Receiving extract `finalization_snapshot.documents[].document.number`; for Transformation and Shipping extract `documents[].number`; validate supported snapshot versions before returning a match. `q` is evaluated against every permitted exact kind, not classified into only one kind; `productText` explicitly searches the current product name and is labelled as current-master search.

  ```sql
  SELECT l.id
  FROM traceability_lots l
  WHERE l.tenant_id = :tenant_id
    AND (:after_created_at IS NULL OR (l.created_at,l.id) > (:after_created_at,:after_id))
    AND (:tlc_from IS NULL OR l.tlc COLLATE "C" >= :tlc_from COLLATE "C")
    AND (:tlc_to IS NULL OR l.tlc COLLATE "C" <= :tlc_to COLLATE "C")
  ORDER BY l.created_at,l.id
  LIMIT :limit_plus_one;
  ```

  The actual query must include every supplied filter **before** `LIMIT`; the excerpt pins the keyset and lexical comparator, not permission to filter an already truncated page. Use parameterized Drizzle SQL. Validate root/row/snapshot relationships using the current-trace evidence helpers; inconsistent evidence is 503, not an omitted match.

- [ ] **Step 4: Run green and inspect plans.** Run the new suite plus existing `us-trace-*` and `us-case-*` focused suites. On a synthetic bounded seed, run `EXPLAIN (ANALYZE, BUFFERS)` for TLC, SSCC and frozen-document queries and record timings separately from pass/fail; propose an additive index/migration only if evidence warrants a separately reviewed change.
- [ ] **Step 5: Review checkpoint.** Verify the SQL's tenant predicates at each joined table and `EXISTS`, `sscc_at_link` history semantics, exact frozen-number extraction, no N+1 full-table scans per hit, no CTE-history leakage, and source-qualified same-TLC rows.

### Task 3: Current lot card and paginated frozen evidence

**Files:** Create `apps/api/src/modules/traceability/trace/us-lot-card.ts`, `apps/api/test/us-lot-card.e2e.test.ts`; extend `apps/api/src/modules/traceability/trace/us-trace-store.ts` with `card` and `cardEvidence`.

**Interfaces:** `readUsLotCard` returns current lot identity/status/source, current-master product labelled separately, frozen current-origin product description or `null`, `originState: current|gap`, case active/history counts, current shipping balance, direct-current-CTE count/date span, and links to existing case, trace and history views. `readUsLotCardEvidence` returns a `(event_date,event_id)` keyset page of direct current event/revision/line references with frozen documents and `nextCursor`. Define `selectDirectCurrentEvents(tx, tenantId, lotId, after, limitPlusOne)` as the tenant-scoped current-root reader, `frozenCardEvidence(event, lotId)` as the saved-snapshot projector and `encodeEvidenceCursor(event)` as canonical base64url encoding in this module. Neither method reconstructs an inventory balance at an earlier timestamp.

- [ ] **Step 1: Write failing disposable-DB tests.** Seed one Receiving origin, a Transformation output, Shipping, later amendments and frozen documents; assert exact event/revision/line/document IDs, civil dates, per-event order, case counts and known/unknown balance. Change product/document masters afterward and assert frozen values remain unchanged. Void an otherwise unconsumed Transformation, assert the output lot's ID/TLC/source/status and active case count remain, `originState='gap'`, void event absent from current evidence, and balance unknown when no current origin. Test foreign/missing same 404, revoked membership 403, no writes, 51-event pagination with no duplicate and a failing snapshot → 503.

  ```ts
  const card = await store.card(tenant, reader, outputLotId);
  expect(card.originState).toBe("gap");
  expect(card.lot.id).toBe(outputLotId);
  expect(card.caseSummary.activeCount).toBe(1);
  expect(card.currentOriginProduct).toBeNull();
  ```

- [ ] **Step 2: Run red.** With the owned `US_TEST_DATABASE_URL`, run `corepack pnpm --filter @markiro/api exec vitest run test/us-lot-card.e2e.test.ts`; expect missing methods, with DB tests actually executed.
- [ ] **Step 3: Implement summary and evidence page.** Reuse the lot response mapper, current-root/evidence validation, case-bridge and `readCurrentShippingBalanceProjection` arithmetic, all inside the same repeatable-read read snapshot. Do not acquire a production finalization lock merely to display balance; if the helper's lock precondition cannot safely be separated, extract a read-only projection helper with identical tests. Origin product comes from the saved Receiving line or Transformation output, not `products.name`. Read direct current CTEs for the lot; do not call a full genealogy traversal just to produce its timeline. Keyset page before hydrating snapshots; include every frozen document for each included event, with the event/revision ID on each row. Use the already bounded snapshot schemas (max 100 documents/event) and preserve history as a separate link.

  ```ts
  const events = await selectDirectCurrentEvents(tx, tenantId, lotId, after, limit + 1);
  const visible = events.slice(0, limit);
  return usLotCardEvidencePageSchema.parse({
    items: visible.map((event) => frozenCardEvidence(event, lotId)),
    nextCursor: events.length > limit ? encodeEvidenceCursor(visible.at(-1)!) : null,
  });
  ```

- [ ] **Step 4: Run green.** Run new card, trace, Shipping balance, case and lifecycle focused suites against disposable PostgreSQL; run API typecheck/lint/build. Compare card counts/first/last dates with search for the same lot in a stable fixture.
- [ ] **Step 5: Review checkpoint.** Confirm origin gap is not a lot deletion or archive, current-master versus frozen labels are distinct, balance uses current UOM/unknown state, exact revision links survive amendments, and card pages are bounded.

### Task 4: U.S.-only HTTP, proxy and check-only CI

**Files:** Create `apps/api/src/deployment/us-search-lot-card.controller.ts`, `apps/api/test/us-search-lot-card-http.e2e.test.ts`; modify `apps/api/src/deployment/us-development.module.ts`, `apps/api/src/deployment/us-runtime.ts`, `apps/admin/vite.us.config.ts`, `.github/workflows/us-development.yml`, `tools/us-development/test/browser-entry.test.mjs`.

**Interfaces:** Mount only `GET /api/us/traceability/search`, `GET /api/us/traceability/lots/:id/card`, and `GET /api/us/traceability/lots/:id/card/evidence`. Reuse `UsSessionGuard`, `ApiZodQuery`, `ApiZodResponse`, `runtime.databaseOperation`, `Cache-Control: no-store` and safe 400/401/403/404/503 schemas. The existing trace controller has the incompatible class path `traceability/lots/:id/trace`; leave it unchanged and use the new U.S.-only controller with explicit method paths.

- [ ] **Step 1: Write failing HTTP/proxy tests.** Assert 200/empty page, no-store, 400 malformed/duplicate/untrusted query, 401 no session, 403 revoked membership, identical 404 for foreign/missing card, 503 timeout/corrupt snapshot, and unchanged audit/business table counts. Verify exact proxy path/method/query allowlist including JSON `tlcList`, cursor and UUID path; reject writes, extra suffix, `tenantId`, duplicate keys and RU fallback. Assert the check-only workflow runs all new contract/API suites on its disposable local PostgreSQL without secrets, deploy credentials or a release job.

  ```ts
  await request(app.getHttpServer())
    .get(`/api/us/traceability/lots/${foreignLotId}/card`)
    .set("Cookie", readerCookie)
    .expect(404);
  await request(app.getHttpServer())
    .get("/api/us/traceability/search?limit=1&limit=2")
    .set("Cookie", readerCookie)
    .expect(400);
  ```

- [ ] **Step 2: Run red.** `corepack pnpm --filter @markiro/api exec vitest run test/us-search-lot-card-http.e2e.test.ts` with `US_TEST_DATABASE_URL`; separately `node --test tools/us-development/test/browser-entry.test.mjs`. Expect missing routes/proxy ownership failures, not skipped infrastructure.
- [ ] **Step 3: Wire exact routes.** Use controller-side raw `URLSearchParams` duplicate detection as `UsTraceController` already does; parse once before store invocation. Add success/error OpenAPI schemas, runtime store property, new controller registration in the U.S. module, anchored GET-only proxy patterns and check-only workflow commands. Preserve the U.S. module allowlist and deny RU routes. Do not add a default wildcard handler.

  ```ts
  return this.runtime.databaseOperation(() =>
    this.runtime.trace.search(principal.tenantId, principal.userId, query),
  );
  ```

- [ ] **Step 4: Run final gates.** Run new and adjacent focused suites with real disposable PostgreSQL, platform-contracts and API `test`, `typecheck`, `lint`, `build`, `node --test tools/us-development/test/browser-entry.test.mjs tools/us-development/test/isolation.test.mjs`, `corepack pnpm format:check`, `git diff --check` and the US isolation checker. Inspect the full three-dot diff against `origin/main` before any later PR. Report skips and external gates separately; browser rendering, live hosting, hardware and regulatory acceptance are not demonstrated by this server slice.
- [ ] **Step 5: Review checkpoint.** Check exact endpoint/proxy/CI ownership and no release capability. Request owner review of the verified server result before planning readiness or office UI implementation. No commit, push, PR or deployment without the authorization applicable at that time.

## Handoff to remaining US-06 phases

The readiness plan consumes current trace findings and the card/search contracts but adds concrete cross-record rules and counts, not a score or verdict. The office plan consumes these server endpoints for EN/ES Search, Lot Card, Graph/Table, Excluded/history and Readiness, with accessible 1024 px/light/dark states. Neither phase changes current versus historical evidence semantics or enables publication.
