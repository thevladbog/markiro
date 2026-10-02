# US-06 Search, Lot Card and Trace Office Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Complete the read-only US-06 office journey from source-qualified lot search through the current lot card to a bounded current trace and separate excluded history.

**Architecture:** The existing US server and strict platform contracts remain authoritative. Five fixed GET methods extend the US browser client; focused Search, Lot Card and Trace components consume those methods, while MasterDataWorkspace owns typed navigation and return state. One validated trace result supplies both SVG and table so neither invents evidence.

**Tech Stack:** React, TypeScript, Vitest/Testing Library, i18next en-US/es-US, @markiro/ui, @markiro/platform-contracts, Vite US entry.

**Spec:** docs/superpowers/specs/2026-09-28-us-06-search-trace-office-design.md

## Global Constraints

- Work only in the isolated codex/us-mvp US instance; preserve dirty unrelated files and do not change RU routes.
- Search and Trace are read-only. No Station, scanner, printer, export package, hosting or release.
- Only en-US and es-US interface copy; saved TLC, SSCC, IDs, document numbers and frozen snapshots are not translated.
- Validate strict request queries and responses; fixed same-origin routes, 15-second request boundary, no arbitrary server href navigation.
- Search defaults to a 50-item page; evidence defaults to 20, history to 50; current trace defaults to depth 16 and at most 500 nodes.
- Keep current finalized evidence separate from draft/amended/void history, and do not claim an unknown balance or an origin gap is complete.
- Keep existing editor and Case guards. No commit, push, PR, merge or release is authorized by this plan approval; inspect each task diff and request separate Git authorization.

## Review Focus

1. Equal TLCs with different source identities: Task 2 tests both selectable rows and exact lot IDs.
2. Old request resolves after a new filter or lot: Tasks 2, 3 and 6 test that the stale result cannot replace the new scope.
3. Historical SSCC match: Task 2 tests historical status, unlink reason and synthetic/existing provenance without an active-link claim.
4. Transformation with two inputs and two outputs: Task 5 tests exactly four line edges and no invented pairwise quantity allocation.
5. Current access disappears while a detail or dirty Case editor is open: Task 7 tests denial and navigation cancellation without discarding edits.

---

## File map and interfaces

- Modify apps/admin/src/us/client.ts: five fixed GET methods, query serialization and trace-read error mapping.
- Create apps/admin/src/us/search/view.tsx, filters.ts, copy.ts and search.css: search form, cursor navigation, source-qualified results and paired copy. filters.ts owns the serializable SearchState type and SSCC normalization.
- Modify apps/admin/src/us/lots/reference-picker.tsx: opt-in archived-inclusive bounded product/location search, leaving create-form behavior unchanged.
- Create apps/admin/src/us/lots/card-panels.tsx, card-evidence.tsx, card-findings.tsx and card-history.tsx: separately loaded read-only card sections.
- Modify apps/admin/src/us/lots/lots-view.tsx, copy.ts and lots.css: mount panels in the existing detail and expose Trace actions.
- Create apps/admin/src/us/trace/types.ts, projection.ts, graph.tsx, table.tsx, view.tsx, history.tsx, copy.ts and trace.css: typed entry, deterministic graph/table projection, selector, current-chain states and excluded history.
- Modify apps/admin/src/us/master-data/workspace.tsx, copy.ts and master-data.css: Search/Trace nav and typed return stack.
- Create apps/admin/test/us-search-trace-client.test.ts, us-search-view.test.tsx, us-lot-card-panel.test.tsx, us-trace-projection.test.tsx, us-trace-view.test.tsx and us-search-trace-navigation.test.tsx: task-local red/green and integration checks.
- Inspect tools/ci/affected.mjs and .github/workflows/us-development.yml for US admin-test ownership; modify only if new files are not picked up.

The tasks below use these interfaces:

```ts
// apps/admin/src/us/search/filters.ts
export type SearchFilters = Omit<z.input<typeof usTraceSearchQuerySchema>, "cursor" | "limit">;
export type SearchState = {
  draft: SearchFilters;
  applied: SearchFilters | null;
  cursors: readonly (string | null)[];
  pageIndex: number;
  focusLotId: string | null;
};
export const emptySearchState: SearchState;
export function normalizeExactLookup(value: string): string;

// apps/admin/src/us/trace/projection.ts
export type TraceEventTarget = ReadinessEventTarget;
export function edgeTarget(edge: UsCurrentTraceResult["edges"][number]): TraceEventTarget;
export function historyTarget(item: UsTraceHistoryPage["items"][number]): TraceEventTarget;
export function traceRows(result: UsCurrentTraceResult): UsCurrentTraceResult["edges"];

// apps/admin/src/us/trace/types.ts
export type TraceEntry = {
  lotId: string;
  direction: "backward" | "forward" | "both";
};
```

### Task 1: Strict US Search, Card and Trace browser reads

**Files:** Modify apps/admin/src/us/client.ts; create apps/admin/test/us-search-trace-client.test.ts.

**Interfaces:** Produces client.searchTraceLots(input), getLotCard(id), listLotCardEvidence(id,input), readCurrentTrace(id,input), listTraceHistory(id,input). Each input is unknown at the trust boundary; each result is the corresponding parsed contract type.

- [ ] **Step 1: Write failing transport tests.** Use a fake fetch and schema-valid fixtures. Assert the exact path and encoded query for q, JSON tlcList, dates and opaque cursor; assert every call uses GET, same-origin credentials and no-store. Also test invalid UUID/query rejects before fetch, malformed response rejects, 400 becomes invalid_input, 404 on lot reads becomes trace_lot_not_found, 401/403/503 remain distinct, and a card/trace response with a different lot ID is rejected.

```ts
const validPage = usTraceSearchPageSchema.parse({
  items: [],
  nextCursor: null,
  appliedFilters: { q: "BOL-0916-H", tlcList: null, limit: 50 },
  rangeOrder: "lexical_c",
});
const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json(validPage));
const client = createUsBrowserClient(send);
await client.searchTraceLots({ q: "BOL-0916-H", limit: "50" });
expect(String(send.mock.calls[0]?.[0])).toContain("/api/us/traceability/search?");
expect(send.mock.calls[0]?.[1]).toMatchObject({
  method: "GET",
  credentials: "same-origin",
  cache: "no-store",
});
await expect(client.getLotCard("not-a-uuid")).rejects.toMatchObject({
  code: "invalid_input",
});
```

- [ ] **Step 2: Run the red test.** Run: corepack pnpm --filter @markiro/admin exec vitest run test/us-search-trace-client.test.ts. Expected: FAIL because searchTraceLots and the other four readers do not exist.
- [ ] **Step 3: Implement the five methods.** Import the five response/query schemas and types from @markiro/platform-contracts. Serialize only the schema's named fields via URLSearchParams; convert tlcList to JSON exactly once, use the server defaults, and never interpolate unvalidated IDs. Add a route-scoped 400/404 mapping before generic errors. Validate returned card.lot.id and trace.rootLotId against the requested ID.

```ts
const searchPath = "/api/us/traceability/search";
async searchTraceLots(input: unknown = {}): Promise<UsTraceSearchPage> {
  const query = checked(usTraceSearchQuerySchema, input, "invalid_input");
  const params = new URLSearchParams({ limit: String(query.limit) });
  for (const key of [
    "q", "tlc", "tlcFrom", "tlcTo", "lotId", "productId", "productText",
    "sourceLocationId", "sourceReferenceValue", "eventType", "eventDateFrom",
    "eventDateTo", "locationId", "documentType", "documentNumber", "sscc",
    "status", "cursor",
  ] as const) {
    const value = query[key];
    if (value !== undefined) params.set(key, value);
  }
  if (query.tlcList !== null) params.set("tlcList", JSON.stringify(query.tlcList));
  return request(searchPath + "?" + params, usTraceSearchPageSchema);
}
async getLotCard(id: unknown): Promise<UsLotCard> {
  const lotId = checked(platformUuidSchema, id, "invalid_input");
  const result = await request(
    lotsPath + "/" + lotId + "/card",
    usLotCardSchema,
  );
  if (result.lot.id !== lotId) throw new UsClientError("invalid_response");
  return result;
}
async listLotCardEvidence(id: unknown, input: unknown = {}) {
  const lotId = checked(platformUuidSchema, id, "invalid_input");
  const query = checked(usLotCardEvidenceQuerySchema, input, "invalid_input");
  const params = new URLSearchParams({ limit: String(query.limit) });
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  return request(lotsPath + "/" + lotId + "/card/evidence?" + params,
    usLotCardEvidencePageSchema);
}
async readCurrentTrace(id: unknown, input: unknown = {}) {
  const lotId = checked(platformUuidSchema, id, "invalid_input");
  const query = checked(usCurrentTraceQuerySchema, input, "invalid_input");
  const params = new URLSearchParams({
    direction: query.direction,
    maxDepth: String(query.maxDepth),
    maxNodes: String(query.maxNodes),
  });
  const result = await request(lotsPath + "/" + lotId + "/trace?" + params,
    usCurrentTraceResultSchema);
  if (result.rootLotId !== lotId) throw new UsClientError("invalid_response");
  return result;
}
async listTraceHistory(id: unknown, input: unknown = {}) {
  const lotId = checked(platformUuidSchema, id, "invalid_input");
  const query = checked(usTraceHistoryQuerySchema, input, "invalid_input");
  const params = new URLSearchParams({ limit: String(query.limit) });
  if (query.cursor !== undefined) params.set("cursor", query.cursor);
  return request(lotsPath + "/" + lotId + "/trace/history?" + params,
    usTraceHistoryPageSchema);
}
// In request(), before the generic error map:
const pathname = new URL(path, "http://localhost").pathname;
const traceLotReadPath = method === "GET" && new RegExp(
  "^" + lotsPath + "/" + uuidPath + "/(?:card(?:/evidence)?|trace(?:/history)?)$",
).test(pathname);
const traceReadPath = traceLotReadPath || (method === "GET" && pathname === searchPath);
if (response.status === 400 && traceReadPath)
  throw new UsClientError("invalid_input");
if (response.status === 404 && traceLotReadPath)
  throw new UsClientError("trace_lot_not_found");
```

- [ ] **Step 4: Verify green and scope.** Re-run the focused file, then corepack pnpm --filter @markiro/admin typecheck and git diff --check. Inspect client.ts diff for arbitrary URL usage and accidental mutation retry. Do not commit.

### Task 2: Search form, disambiguation and cursor pages

**Files:** Create apps/admin/src/us/search/{filters.ts,view.tsx,copy.ts,search.css}; modify apps/admin/src/us/lots/reference-picker.tsx and apps/admin/src/us/master-data/copy.ts; create apps/admin/test/us-search-view.test.tsx.

**Interfaces:** SearchView takes client, state: SearchState, onStateChange(next), onOpenLot(lotId), onForbidden and onSessionLost. It does not own workspace navigation. filters.ts exports the exact types above.

- [ ] **Step 1: Write failing tests.** Mount SearchView with a state-owner harness and fake client. Assert no initial tenant-wide request; submitting BOL-0916-H shows two equal-TLC rows with distinct source and ID; one historical SSCC row shows unlink reason and provenance; applying new filters clears cursor stack; Previous sends the saved cursor for that page; late old response is ignored; malformed date/range never calls the client. Test the product/location picker past first page and the opt-in archived-inclusive query while the existing lot-create picker still sends archived=false.

```tsx
render(<SearchHarness client={client} />);
expect(client.searchTraceLots).not.toHaveBeenCalled();
await user.type(screen.getByLabelText("Exact lookup"), "BOL-0916-H");
await user.click(screen.getByRole("button", { name: "Search" }));
expect(await screen.findAllByText("NRF-260915-APL01")).toHaveLength(2);
await user.click(screen.getByRole("button", { name: /North River.*lot 2/i }));
expect(openLot).toHaveBeenCalledWith(secondLotId);
```

- [ ] **Step 2: Run the red test.** Run: corepack pnpm --filter @markiro/admin exec vitest run test/us-search-view.test.tsx. Expected: FAIL because SearchView is absent.
- [ ] **Step 3: Implement bounded search.** Normalize only a valid scanned SSCC wrapper with parseScannedSscc; otherwise preserve the exact lookup text. Keep draft/applied filters distinct, validate through usTraceSearchQuerySchema before fetch, and use an incrementing request token. Render all P0 fields including distinct 1–50 TLC JSON list, lexical range explanation, source/reference, CTE/date, frozen document, SSCC/status, product and location bounded pickers. Show server appliedFilters, current CTE total, matching reasons and Case provenance. For each page, resolve at most 50 distinct product IDs through the existing getProduct reader; label successful names as current catalog data and keep the product ID visible if lookup fails. Disable Next without nextCursor; show no-hit, loading, invalid, stale and retry states.

```ts
export function normalizeExactLookup(value: string): string {
  const input = value.trim();
  return parseScannedSscc(input) ?? input;
}
// A filter apply always starts page one; response pages are tagged by request token.
const next: SearchState = {
  draft,
  applied: draft,
  cursors: [null],
  pageIndex: 0,
  focusLotId: null,
};
```

- [ ] **Step 4: Verify green.** Re-run the focused test, apps/admin/test/us-lots-ui.test.tsx and apps/admin/test/us-readiness-picker.test.tsx. Run admin typecheck and lint. Check en-US/es-US keys have identical structure. Do not commit.

### Task 3: Current lot card summary and frozen evidence

**Files:** Create apps/admin/src/us/lots/{card-panels.tsx,card-evidence.tsx}; modify apps/admin/src/us/lots/{lots-view.tsx,copy.ts,lots.css}; create apps/admin/test/us-lot-card-panel.test.tsx.

**Interfaces:** LotCardPanels takes client, lotId, onOpenEvent(TraceEventTarget), onOpenTrace(direction), onForbidden and onSessionLost. Existing LotsView still owns identity, Cases, genealogy and mutations.

- [ ] **Step 1: Write failing tests.** A card with current frozen origin and a renamed current master must show both labels; known balance includes original UOM, unknown balance never implies zero; origin gap preserves TLC, source and Cases. Test evidence cursor Next, exact event/revision/line target, a document's owning event, independent card/evidence failure, moreCurrentOriginProducts count, and an old lot response arriving after selection changes.

```tsx
const openEvent = vi.fn();
render(
  <LotCardPanels
    client={client}
    lotId={lotId}
    onOpenEvent={openEvent}
    onOpenTrace={vi.fn()}
    onForbidden={vi.fn()}
    onSessionLost={vi.fn()}
  />,
);
expect(await screen.findByText("Frozen origin description")).toBeVisible();
expect(screen.getByText("Current catalog name")).toBeVisible();
await user.click(screen.getByRole("button", { name: /REC-26-0001.*line 2/i }));
expect(openEvent).toHaveBeenCalledWith({
  type: "receiving",
  eventId,
  revision: 2,
  lineSide: "items",
  lineNo: 2,
});
```

- [ ] **Step 2: Run the red test.** Run: corepack pnpm --filter @markiro/admin exec vitest run test/us-lot-card-panel.test.tsx. Expected: FAIL because LotCardPanels is absent.
- [ ] **Step 3: Implement separate live readers.** Mount panels under LotsView detail without replacing existing controls. Use separate request tokens for card and evidence, reset evidence cursor on lot change, and label live card versus frozen event facts. Map receiving lines to items, transformation input/output to inputs/outputs, shipping lines to items; a document action has null lineSide/lineNo. Do not follow links supplied by the server.

```ts
const side =
  line.kind === "transformation_input"
    ? "inputs"
    : line.kind === "transformation_output"
      ? "outputs"
      : "items";
onOpenEvent({
  type: item.type,
  eventId: item.eventId,
  revision: item.revision,
  lineSide: side,
  lineNo: line.lineNo,
});
```

- [ ] **Step 4: Verify green.** Re-run focused test plus apps/admin/test/us-lots-ui.test.tsx; run admin typecheck and lint. Check old Case/status/source operations still render and remain guarded. Do not commit.

### Task 4: Lot Findings and excluded history panels

**Files:** Create apps/admin/src/us/lots/{card-findings.tsx,card-history.tsx}; modify apps/admin/src/us/lots/{card-panels.tsx,card-evidence.tsx,copy.ts,lots.css}; extend apps/admin/test/us-lot-card-panel.test.tsx.

**Interfaces:** CardFindings takes lotId and reads readReadiness({ lotId }); CardHistory takes lotId and reads listTraceHistory(lotId, { limit: "50" }) on page one, adding cursor only when nextCursor exists. Both receive the existing event-navigation callbacks.

- [ ] **Step 1: Write failing tests.** Assert Readiness's effective server period is displayed, zero findings says only “in this period,” error does not become zero, a lot-only finding navigates to its lot, a historical revision stays outside the current evidence timeline, and history Next is disabled without nextCursor. Test missing/foreign 404 as a visible detail error, not an empty history. Add a regression for the prior review's deferred minor: a Transformation evidence quantity visibly identifies input versus output in both locales, while preserving the exact target side.

```tsx
expect(await screen.findByText(/No findings in this period/i)).toBeVisible();
expect(screen.getByText(/2024-10-01.*2026-09-28/)).toBeVisible();
expect(screen.queryByText(/compliant/i)).not.toBeInTheDocument();
```

- [ ] **Step 2: Run the red test.** Run: corepack pnpm --filter @markiro/admin exec vitest run test/us-lot-card-panel.test.tsx. Expected: FAIL on missing Findings/history panels.
- [ ] **Step 3: Implement the two independent reads.** Reuse the Readiness source target helpers and render only findings belonging to the selected lot. Show status/reason/previous/next revision of excluded items; use exact event IDs, not root/current aliases. Cancel or ignore previous lot's requests and keep failures separate from identity/current evidence. Label Transformation evidence input/output lines with paired locale copy without changing the saved quantity or navigation target.

```ts
const query: UsReadinessQuery = { lotId };
const result = await client.readReadiness(query);
const history = await client.listTraceHistory(lotId, { limit: "50" });
```

- [ ] **Step 4: Verify green.** Re-run focused card and existing Readiness navigation tests, then admin typecheck/lint. Do not commit.

### Task 5: One trace projection for Graph and Table

**Files:** Create apps/admin/src/us/trace/{projection.ts,graph.tsx,table.tsx,trace.css}; create apps/admin/test/us-trace-projection.test.tsx.

**Interfaces:** traceRows(result) returns result.edges in server order; edgeTarget and historyTarget return the exact ReadinessEventTarget shape. TraceGraph and TraceTable each take the same validated UsCurrentTraceResult and callbacks onOpenLot/onOpenEvent.

- [ ] **Step 1: Write failing projection/render tests.** Fixtures cover Receiving → lot, two Transformation inputs → event → two outputs, non-FTL material, Shipping → location, zero edges and 51-node table-first policy. Assert Graph edge IDs equal Table edge IDs, four Transformation line edges stay four, quantities appear only on their own edges, no direct input→output edge is invented, every event button opens exact event/revision/line, and a material/location action never calls onOpenLot. An isolated root lot with zero edges still has a keyboard-operable lot action.

```ts
expect(traceRows(twoByTwo).map((edge) => edge.id)).toEqual(twoByTwo.edges.map((edge) => edge.id));
expect(twoByTwo.edges.filter((edge) => edge.kind.startsWith("transformation_"))).toHaveLength(4);
expect(edgeTarget(inputEdge)).toEqual({
  type: "transformation",
  eventId,
  revision: 2,
  lineSide: "inputs",
  lineNo: 1,
});
```

- [ ] **Step 2: Run the red test.** Run: corepack pnpm --filter @markiro/admin exec vitest run test/us-trace-projection.test.tsx. Expected: FAIL because projection/graph/table are absent.
- [ ] **Step 3: Implement deterministic display.** Use result.nodes/edges directly, with stable layers for location/material, lot and Transformation event; do not pair input/output lots or calculate quantities. Render a count-labelled SVG role=img and a keyboard-operable @markiro/ui Table with one row per edge. Add a compact lot-node action list sourced from result.nodes so the root remains navigable even with no edges; no material/location node is passed as a lot ID. Graph shows shapes/text by node kind; table and lot-node list are the accessible action surfaces. Civil dates use locale formatting without UTC instant conversion.

```ts
export function traceRows(result: UsCurrentTraceResult) {
  return result.edges;
}
export function edgeTarget(edge: UsCurrentTraceResult["edges"][number]): TraceEventTarget {
  return {
    type:
      edge.kind === "receiving"
        ? "receiving"
        : edge.kind === "shipping"
          ? "shipping"
          : "transformation",
    eventId: edge.eventId,
    revision: edge.revision,
    lineSide:
      edge.kind === "transformation_input"
        ? "inputs"
        : edge.kind === "transformation_output"
          ? "outputs"
          : "items",
    lineNo: edge.lineNo,
  };
}
export function historyTarget(item: UsTraceHistoryPage["items"][number]): TraceEventTarget {
  return {
    type: item.type,
    eventId: item.eventId,
    revision: item.revision,
    lineSide: null,
    lineNo: null,
  };
}
```

- [ ] **Step 4: Verify green.** Run focused test, admin typecheck/lint and inspect the SVG at 1440/1024 px after integration. Do not commit.

### Task 6: Trace selector, current states and separate history

**Files:** Create apps/admin/src/us/trace/{view.tsx,history.tsx,copy.ts}; extend apps/admin/src/us/trace/trace.css; create apps/admin/test/us-trace-view.test.tsx.

**Interfaces:** TraceView takes client, entry: TraceEntry | null, onEntryChange(next), onOpenLot(id), onOpenEvent(TraceEventTarget), onForbidden, onSessionLost. Sidebar entry=null shows a bounded lot selector; card entry supplies the exact lot and direction.

- [ ] **Step 1: Write failing tests.** Assert sidebar Trace makes no unscoped graph request, selected lot loads exactly once, direction/depth changes invalidate old responses, Graph/Table switching does not refetch, >50 nodes starts on Table, limited traversal warns on both tabs, origin_gap is separate, zero edges is not error, 503 is retryable failure, and excluded history stays outside Graph/Table counts with cursor paging.

```tsx
render(
  <TraceView
    client={client}
    entry={null}
    onEntryChange={vi.fn()}
    onOpenLot={vi.fn()}
    onOpenEvent={vi.fn()}
    onForbidden={vi.fn()}
    onSessionLost={vi.fn()}
  />,
);
expect(client.readCurrentTrace).not.toHaveBeenCalled();
await user.type(screen.getByLabelText("Search lots"), "NRF-260915");
await user.click(screen.getByRole("button", { name: "Search lots" }));
await user.selectOptions(screen.getByLabelText("Lot"), lotId);
expect(client.readCurrentTrace).toHaveBeenCalledWith(lotId, {
  direction: "both",
  maxDepth: "16",
});
```

- [ ] **Step 2: Run the red test.** Run: corepack pnpm --filter @markiro/admin exec vitest run test/us-trace-view.test.tsx. Expected: FAIL because TraceView is absent.
- [ ] **Step 3: Implement TraceView and TraceHistory.** Reuse bounded search-driven lot selection. Keep one UsCurrentTraceResult in state for both tabs and token each request by lot/direction/depth. Display returned counts and a persistent limited warning; do not reinterpret unavailable as partial success. Use a separate listTraceHistory call and page stack; its rows show status, reason, predecessor/successor and exact revision. Keep excludedSummary.count scoped to the current trace.

```ts
const response = await client.readCurrentTrace(entry.lotId, {
  direction: entry.direction,
  maxDepth: String(depth),
});
if (run.current !== token) return;
setResult(response);
setTab(response.nodes.length > 50 ? "table" : "graph");
```

- [ ] **Step 4: Verify green.** Re-run focused Trace and projection tests, then admin typecheck/lint. Do not commit.

### Task 7: Typed Search → Lot → Trace navigation and US UI gates

**Files:** Modify apps/admin/src/us/master-data/{workspace.tsx,copy.ts,master-data.css}, apps/admin/src/us/lots/lots-view.tsx and apps/admin/src/us/events/events-view.tsx only where exact-entry return/focus needs an existing callback; create apps/admin/test/us-search-trace-navigation.test.tsx; inspect tools/ci/affected.mjs and .github/workflows/us-development.yml.

**Interfaces:** MasterDataWorkspace owns SearchState, TraceEntry and a typed return stack. Search opens LotsView with entryLotId; card opens TraceView with exact lot/direction; Trace opens LotsView or EventsView using exact IDs and the existing ReadinessEventTarget contract. No new browser router.

- [ ] **Step 1: Write failing workspace tests.** Assert separate Search/Trace sidebar entries; Search → lot → Trace → event → Back returns to Trace, then lot, then filtered Search page and focus; sidebar Trace starts blank; a dirty Case/editor cancellation stays put; mutation pending blocks navigation; lost read capability closes source navigation; event mismatch preserves retry/back rather than silently opening current revision.

```tsx
const nav = screen.getByRole("navigation", { name: "Reference data" });
await user.click(within(nav).getByRole("button", { name: "Search" }));
expect(within(nav).getByRole("button", { name: "Search", current: "page" })).toBeVisible();
await user.click(screen.getByRole("button", { name: /NRF-260915-APL01.*source A/i }));
expect(await screen.findByRole("heading", { name: "NRF-260915-APL01" })).toBeVisible();
await user.click(screen.getByRole("button", { name: "Trace backward" }));
expect(await screen.findByRole("heading", { name: "Trace" })).toBeVisible();
```

- [ ] **Step 2: Run the red test.** Run: corepack pnpm --filter @markiro/admin exec vitest run test/us-search-trace-navigation.test.tsx. Expected: FAIL because Search/Trace nav and return context are absent.
- [ ] **Step 3: Implement a typed return stack.** Push the current view before each Search → lot → Trace → event transition, and pop only after its guarded Back succeeds; this preserves all three return hops. Preserve existing Readiness and Receiving return behavior without new booleans per source. Route every transition through existing navigate/dirty/mutation guards or the protected editor's approved Back callback. Keep SearchState in workspace across child navigation; set TraceEntry=null on a direct sidebar click and preserve it for detail round trips. Restore focus to the initiating row/action or heading after a confirmed return.

```ts
type ReturnFrame =
  | { kind: "search"; lotId: string }
  | { kind: "lot"; lotId: string }
  | { kind: "trace"; entry: TraceEntry; edgeId: string | null }
  | { kind: "readiness" }
  | { kind: "events"; eventId: string };
const [returnStack, setReturnStack] = useState<ReturnFrame[]>([]);
// Direct sidebar Trace starts fresh; a detail return retains its validated entry.
function openSidebarTrace() {
  if (!navigate("trace")) return;
  setReturnStack([]);
  setTraceEntry(null);
}
```

- [ ] **Step 4: Run proportional automated gates.** Run all six new test files, existing us-readiness-navigation and us-lots-ui tests, corepack pnpm --filter @markiro/admin test, typecheck, lint, build; then corepack pnpm format:check and git diff --check. Build affected workspace dependencies first when compiled dist is stale. Check the US-only CI workflow actually executes the new admin tests. Do not commit.
- [ ] **Step 5: Render and inspect.** Open the local US browser entry without publishing it. Check keyboard, focus, 1440/1024 layout, light/dark, en-US/es-US, empty/error/limited states and current versus excluded history. Record browser evidence separately from automated tests; no hardware, hosted infrastructure or release claim.

## Final review gate

Compare each section of the approved spec to the changed UI and tests. Inspect the complete worktree diff without staging unrelated existing changes. Report exact passing checks, skips, browser evidence and remaining gaps; implementation completion does not authorize commit, push or deployment.
