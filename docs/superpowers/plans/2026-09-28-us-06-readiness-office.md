# US-06 Readiness Office Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only, source-linked Readiness view to the isolated U.S. office workspace.

**Implementation status (2026-09-28):** Completed in the isolated worktree without commit, push, PR, merge or release. The ignored `.superpowers/sdd/2026-09-28-us-06-readiness-office/progress.md` records task reviews and verification. The three Readiness API suites subsequently passed against the isolated local US development PostgreSQL (62/62 tests); this is not live deployment validation.

**Architecture:** The existing strict US browser client reads one complete server assessment; the view keeps the returned scope, counts, findings and draft work distinct. Findings use typed provenance for in-workspace navigation to the exact lot or event revision, with the line position carried into the editor. No browser router, new write operation, RU surface or release path is introduced.

**Tech Stack:** React, TypeScript, i18next, `@markiro/ui`, Zod contracts from `@markiro/platform-contracts`, Vitest/Testing Library, existing US browser-entry contract check.

**Spec:** [US-06 current design](../specs/2026-09-27-us-06-current-trace-search-readiness-design.md), [Readiness server design](../specs/2026-09-28-us-06-readiness-server-design.md), [design brief 04](../../design-briefs/us/04-trace-and-readiness.md). The owner chose in-workspace navigation for this P0 step on 2026-09-28.

## Global Constraints

- US-only, separate instance and branch; no merge to `main`, production deploy, Station, printing or scanner work.
- English `en-US` and Spanish `es-US`; no Russian UI or implied legal/compliance conclusion.
- `US_FSMA204_PROCESSOR` may show FTL-specific findings; `US_GENERIC_LOT_TRACEABILITY` must say “General lot traceability only; FTR applicability is not assessed in this profile.”
- A successful response is complete, never truncated. No percentage/score. Empty scope differs from no findings in a nonempty scope; draft work is not counted as finalized evidence. Older dependencies are separately counted, not folded into records checked.
- Preserve exact event revision ID, event number, revision and line side/number. A relative server `links.*Href` is provenance, not an SPA route or an arbitrary navigation destination.
- Existing `EventsView`/`LotsView` editing and dirty-state protections remain intact. Use the current `@markiro/ui` tokens/components; verify light/dark, keyboard, and 1024 px.
- Test first per repository `AGENTS.md`. Do not commit, push or deploy as part of this plan without separate authorization. Existing dirty Search/Lot Card work belongs to its owner and must remain untouched.

## Review Focus

1. A late response for an old filter must not replace the currently displayed scope; Task 3 tests request generation and stale-state handling.
2. A server 503 `us_readiness_scope_too_large` must ask for a narrower scope, not present a partial or empty result; Tasks 1 and 3 test this.
3. Event-wide, non-FTL line, and lot-only findings must never invent a missing lot/event link; Tasks 2 and 4 test all three shapes.
4. A finding for a superseded/void historical revision must open its own ID and show its line context, not silently open the current root; Task 4 tests this.
5. Ten thousand findings or a high draft total must not freeze the office UI or imply drafts were checked; Task 2 tests bounded visible rows and a separate draft section.

---

## File map and interfaces

- `apps/admin/src/us/client.ts`: add `readReadiness(input: unknown = {}): Promise<UsReadinessResult>` using the existing `request` helper, strict input/result schema and fixed route. Recognize the one documented 503 scope-limit code.
- `apps/admin/src/us/readiness/copy.ts`: paired EN/ES dashboard, rule-code, field-context and error strings. Do not feed an unrecognized server key directly to i18next.
- `apps/admin/src/us/readiness/view.tsx` and `readiness.css`: read-only dashboard, scope controls, counts, grouping, findings, drafts, retry and accessible states. Props include `client`, `profileCode`, `initialQuery`, `onQueryChange`, `onForbidden`, `onSessionLost`, `onOpenLot(id)`, `onOpenEvent(target)` and `onOpenEvents()`.
- `apps/admin/src/us/readiness/source.ts`: pure `ReadinessEventTarget` and provenance-to-navigation conversion; no use of server href as a browser URL.
- `apps/admin/src/us/master-data/workspace.tsx`: add `readiness` view, retain the applied `UsReadinessQuery` across source navigation, and manage internal entry/back state; keep existing discard and mutation guards.
- `apps/admin/src/us/events/events-view.tsx` and the three event record views: accept exact event entry and display/focus a line-context notice after the selected revision is loaded. `LotsView` already accepts `entryLotId`.
- `apps/admin/test/us-readiness-client.test.ts`, `us-readiness-view.test.tsx`, `us-readiness-navigation.test.tsx`: boundary, presentation and exact navigation tests.
- `.github/workflows/us-development.yml`: add a dedicated U.S. admin Vitest step for the view, client, navigation and picker tests. `tools/us-development/test/browser-entry.test.mjs` already exercises the readiness proxy route; rerun it, and change it only if the new client route reveals a real gap. Check `tools/ci/affected.mjs` for ownership without widening RU CI or deployment.

### Task 1: Strict read-only client boundary

**Files:** Modify `apps/admin/src/us/client.ts`; create `apps/admin/test/us-readiness-client.test.ts`.

**Interfaces:** Consumes `usReadinessQuerySchema`, `usReadinessResultSchema`, `UsReadinessResult` from `@markiro/platform-contracts`. Produces `readReadiness(input: unknown = {}): Promise<UsReadinessResult>`, `UsClientError("readiness_scope_too_large")` for the documented 503 response, and fixed-route `readiness_scope_not_found` / `readiness_invalid_scope` for 404 / 400.

- [ ] **Step 1: Write the failing client test.** Use a schema-valid response fixture with `scope`, `assessedAt`, `state`, `recordsChecked`, `dependenciesChecked`, `counts`, `groups`, `findings` and `draftWork` (an empty result is valid with zero counts). Assert `readReadiness({})` sends only `GET /api/us/traceability/readiness` with the existing same-origin/no-store request options; assert a complete explicit date/product/lot query is URL-encoded in fixed key order. Assert half-date, reversed date, over-24-month and malformed UUID inputs reject before `fetch`; malformed response rejects as `invalid_response`; exact `{code:"us_readiness_scope_too_large"}` on 503 maps to `readiness_scope_too_large`, while a generic 503 remains `unavailable`. Fixed-route 400 and 404 map to `readiness_invalid_scope` and `readiness_scope_not_found`; do not change error treatment of other US routes.

  ```ts
  const valid = usReadinessResultSchema.parse({
    scope: {
      eventDateFrom: "2024-10-01",
      eventDateTo: "2026-09-28",
      productId: null,
      lotId: null,
      profileCode: "US_FSMA204_PROCESSOR",
      defaulted: true,
    },
    assessedAt: "2026-09-28T12:00:00.000Z",
    state: "empty",
    recordsChecked: { events: 0, lots: 0 },
    dependenciesChecked: 0,
    counts: { error: 0, warning: 0, info: 0 },
    groups: { byCte: [], byProduct: [], bySeverity: [] },
    findings: [],
    draftWork: { total: 0, items: [], hasMore: false, eventsHref: "/traceability/events" },
  });
  const send = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(valid),
  );
  expect(await createUsBrowserClient(send).readReadiness()).toEqual(valid);
  expect(send.mock.calls[0]?.[0]).toBe("/api/us/traceability/readiness");
  expect(send.mock.calls[0]?.[1]).toMatchObject({
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  });
  await expect(
    createUsBrowserClient(send).readReadiness({ eventDateFrom: "2026-09-01" }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  ```

- [ ] **Step 2: Run `corepack pnpm --filter @markiro/admin exec vitest run test/us-readiness-client.test.ts`; expect missing-method failure.** Build affected compiled dependencies first if the test cannot resolve a new contract export: `corepack pnpm turbo run build --filter='@markiro/admin^...'`.
- [ ] **Step 3: Implement the fixed route and validated query.** Extend `UsClientErrorCode` with the three readiness-specific codes; match the documented 503 code only on the fixed readiness route, using a strict Zod object. Match fixed-route 400/404 by HTTP status, irrespective of the server's sanitized body. Never map other 503s to an empty response.

  ```ts
  const readinessPath = "/api/us/traceability/readiness";
  async readReadiness(input: unknown = {}) {
    const query = checked(usReadinessQuerySchema, input, "invalid_input");
    const params = new URLSearchParams();
    for (const key of ["eventDateFrom", "eventDateTo", "productId", "lotId"] as const) {
      const value = query[key];
      if (value !== undefined) params.set(key, value);
    }
    return request(`${readinessPath}${params.size ? `?${params}` : ""}`, usReadinessResultSchema);
  }
  ```

- [ ] **Step 4: Run the focused test again; require all cases green.** Run `corepack pnpm --filter @markiro/admin typecheck` after the shared contract build. Review `git diff -- apps/admin/src/us/client.ts apps/admin/test/us-readiness-client.test.ts`.

### Task 2: Localized findings and bounded dashboard

**Files:** Create `apps/admin/src/us/readiness/{copy.ts,source.ts,view.tsx,readiness.css}` and `apps/admin/test/us-readiness-view.test.tsx`; modify `apps/admin/src/us/master-data/copy.ts` to register copy. No workspace navigation yet: render `ReadinessView` directly in tests.

**Interfaces:** `ReadinessEventTarget = { type: "receiving" | "transformation" | "shipping"; eventId: string; revision: number; lineSide: "items" | "inputs" | "outputs" | null; lineNo: number | null }`. `sourceTarget(finding: UsReadinessFinding): ReadinessEventTarget | null` returns `null` only when event provenance is absent. `ReadinessView` receives `client`, `profileCode`, `initialQuery: UsReadinessQuery`, `onQueryChange: (query: UsReadinessQuery) => void`, `onForbidden`, `onSessionLost`, `onOpenLot`, `onOpenEvent`, `onOpenEvents`.

- [ ] **Step 1: Write failing component tests for `empty`, assessed-with-zero-findings, and findings.** Fixtures must cover event-wide (`lotId:null`, `lineNo:null`), Transformation non-FTL input (`lotId:null`, `lineSide:"inputs"`, `lineNo:2`), and lot-only (`eventId:null`) rows. Assert metric values and `dependenciesChecked` caption; CTE/Product/Severity groups; accessible severity text and event/lot buttons only when provenance exists; generic-profile banner; English and Spanish; separate `draftWork` with shown/total and link to Events; unknown rule key fallback as localized “Review source record” plus stable code and field, never an untranslated i18n key or `undefined`. Assert a bounded visible slice (e.g. first 100 findings with explicit “100 of N shown” and Next/Previous controls) even for a 10,000-finding valid response; grouping remains over server counts, not just the visible slice.

  ```tsx
  render(
    <ReadinessView
      client={client}
      profileCode="US_GENERIC_LOT_TRACEABILITY"
      initialQuery={{}}
      onQueryChange={vi.fn()}
      onForbidden={vi.fn()}
      onSessionLost={vi.fn()}
      onOpenLot={vi.fn()}
      onOpenEvent={vi.fn()}
      onOpenEvents={vi.fn()}
    />,
  );
  expect(
    await screen.findByText(
      "General lot traceability only; FTR applicability is not assessed in this profile.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/compliant|score|%/i)).toBeNull();
  ```

- [ ] **Step 2: Run `corepack pnpm --filter @markiro/admin exec vitest run test/us-readiness-view.test.tsx`; expect missing-view failure.**
- [ ] **Step 3: Implement the view with semantic headings, labelled controls, a table (not color-only chips), an `aria-live` loading/status region, focusable error/retry, and source buttons.** Use `@markiro/ui` `Button`, `Input`, `Select`, `StatusChip`, `Table` where their current API fits. Keep the server response intact; derive group rows and 100-row pages in render/memo only. Use a finite dictionary for the current `readiness.*` rule codes (`required_kde`, `invalid_kde`, `invalid_date`, `required_reference`, `source_unresolved`, `invalid_quantity`, `invalid_uom`, `event_lot_mismatch`, `tlc_source_mismatch`, `origin_gap`, `coverage_unresolved`, `exemption_review_required`); the fallback includes code/field, not raw message-key output. The event button label includes event number, revision and line side/number when present. Keep drafts outside the findings table and counts.

  ```ts
  export function sourceTarget(finding: UsReadinessFinding): ReadinessEventTarget | null {
    if (finding.eventId === null || finding.cte === null || finding.revision === null) return null;
    return {
      type: finding.cte,
      eventId: finding.eventId,
      revision: finding.revision,
      lineSide: finding.lineSide,
      lineNo: finding.lineNo,
    };
  }
  ```

- [ ] **Step 4: Run focused view and client tests, typecheck and lint; inspect the EN/ES rendered text.** No browser/visual claim from jsdom tests.

### Task 3: Scope controls, stale-response safety and errors

**Files:** Modify `apps/admin/src/us/readiness/{view.tsx,copy.ts,readiness.css}` and `apps/admin/test/us-readiness-view.test.tsx`.

**Interfaces:** Keep `ReadinessView` props from Task 2. The applied query remains `UsReadinessQuery`, separate from editable form values. `readReadiness(appliedQuery)` is the only assessment fetch. A new filter result updates the display only when its request generation is current.

- [ ] **Step 1: Add failing tests for initial server-default scope, paired `type=date` inputs, product/lot lookup, Apply/Reset, and a late old request.** The UI displays the returned effective dates and `defaulted` state, not browser-computed “today”. Lookup should use bounded, search-driven existing `client.listProducts` / `client.listLots` APIs and select by ID plus human-readable label; neither a first-page-only select nor an unvalidated raw UUID input is acceptable. Product and lot filters are independent whole-event selectors: allow both IDs even when the chosen lot belongs to another product; render the server's resulting scope and counts, including a legitimate empty result, without a fabricated client error. A missing/foreign explicit ID is a separate server 404 with a clear error. Assert both dates are required together, date order and 24-month rule use `usReadinessQuerySchema`; when filter B resolves before A, A cannot overwrite B or clear B's loading/error state. Assert `onQueryChange` receives only a valid applied query and Reset sends `{}`.

  ```ts
  const first = deferred<UsReadinessResult>();
  const second = deferred<UsReadinessResult>();
  client.readReadiness.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  // Apply a new date scope, resolve second, then first: only the second scope remains visible.
  ```

- [ ] **Step 2: Run the focused view test and confirm the new cases fail.**
- [ ] **Step 3: Implement filters and state transitions.** Use a monotonic request token in `useRef`, increment on new request and unmount, retain the last successful response only with a visibly labelled “Refreshing…” state, and never show it as the newly requested scope. Map `readiness_scope_too_large` to “Narrow the selected scope and try again” / Spanish equivalent; map invalid input, missing selected record, session loss, forbidden access and retryable unavailable/timeout separately. Do not persist search or assessment data to local storage.

  ```ts
  const run = useRef(0);
  async function load(query: UsReadinessQuery) {
    const token = ++run.current;
    setPending(true);
    try {
      const next = await client.readReadiness(query);
      if (token === run.current) setResult(next);
    } catch (error) {
      if (token === run.current) handleReadinessError(error);
    } finally {
      if (token === run.current) setPending(false);
    }
  }
  useEffect(
    () => () => {
      run.current += 1;
    },
    [],
  );
  ```

- [ ] **Step 4: Re-run the focused tests plus `typecheck` and `lint`.** Inspect that Reset returns to server default with no query string and that no stale result is labelled as the new scope.

### Task 4: Workspace integration and exact source navigation

**Files:** Modify `apps/admin/src/us/readiness/{view.tsx,copy.ts}`, `apps/admin/src/us/master-data/workspace.tsx`, `apps/admin/src/us/events/events-view.tsx`, the smallest necessary pieces of `apps/admin/src/us/receiving/{view,editor,finalized-detail}.tsx`, `apps/admin/src/us/transformation/{editor,detail}.tsx`, `apps/admin/src/us/shipping/{editor,detail}.tsx`, `apps/admin/src/us/master-data/master-data.css`, `.github/workflows/us-development.yml`; create `apps/admin/test/us-readiness-navigation.test.tsx`. Frozen detail rows may take optional exact-line focus props/data attributes; absent props must preserve existing behavior.

**Interfaces:** `ReadinessView.onOpenEvent(target: ReadinessEventTarget)` passes the exact revision ID and optional line context; `EventsView.initialEvent?: ReadinessEventTarget`; `EventsView` fetches Receiving by that ID as it already does from a list, and passes Transformation/Shipping that ID to their existing readers. `LotsView.entryLotId` handles lot-only source. The workspace retains `UsReadinessQuery`, passes it as `initialQuery` on return, and the remounted Readiness view runs a fresh assessment with that query.

- [ ] **Step 1: Add failing workspace tests.** Navigate from Readiness to a historical Receiving, Transformation and Shipping finding and assert the exact event ID is requested and the displayed record revision/line context matches the finding. Test the non-FTL line has no lot action; lot-only opens its ID; event-wide shows no invented line; draft opens its exact event ID; “All drafts” opens Events list. Back returns to Readiness. Test dirty editor navigation cancel/confirm and read-capability loss; no finding navigation bypasses existing authorization.

  ```tsx
  await user.click(screen.getByRole("button", { name: /REC-26-0001.*revision 2.*line 3/i }));
  expect(send).toHaveBeenCalledWith(
    `/api/us/traceability/receiving/${historicalRevisionId}`,
    expect.objectContaining({ method: "GET" }),
  );
  expect(await screen.findByText(/items.*line 3/i)).toBeTruthy();
  ```

- [ ] **Step 2: Run `corepack pnpm --filter @markiro/admin exec vitest run test/us-readiness-navigation.test.tsx`; expect navigation failure.**
- [ ] **Step 3: Add `readiness` to the workspace nav and guarded state transition.** Source navigation must consume typed IDs, never `window.location` or the relative API `links.*Href`. Keep the selected source target and applied `UsReadinessQuery` in workspace state, pass `initialEvent` to `EventsView`, and pass `entryLotId` to `LotsView`. Turn each draft preview row into a button that calls `onOpenEvent` with its exact `cte`, `eventId`, `revision` and null line context; keep “View events” for the full list. On opening a historical Receiving, fetch and display that exact revision, not a root/current fallback. On editor load, verify the returned revision equals the requested revision; on mismatch or missing line show a source-context error and retry/back, not a different record. Add a concise line-context notice and focus/scroll to the matching line when present; do not auto-edit it. Reuse the dirty/mutation guard for entering and leaving the view.

  ```ts
  function openReadinessEvent(target: ReadinessEventTarget) {
    if (mutationPending || (editorDirty && !window.confirm(t("md.discardConfirm")))) return;
    setReadinessEventEntry(target);
    setView("events");
    setViewGeneration((n) => n + 1);
  }
  ```

- [ ] **Step 4: Re-run navigation, dashboard and existing Events/Lots focused tests.** Add a dedicated step in `.github/workflows/us-development.yml` running `pnpm --filter @markiro/admin exec vitest run test/us-readiness-client.test.ts test/us-readiness-view.test.tsx test/us-readiness-navigation.test.tsx`. Run `node --test tools/us-development/test/browser-entry.test.mjs` and check `tools/ci/affected.mjs`. Then run `corepack pnpm --filter @markiro/admin test`, `typecheck`, `lint`, `build`; `corepack pnpm format:check`; `git diff --check`. Review the complete worktree diff without staging unrelated changes. If a local Graphify graph exists, run `graphify update .` after code edits.
- [ ] **Step 5: Inspect the rendered UI in a browser at 1440 and 1024 px, light/dark, EN/ES and keyboard-only navigation.** Verify focus restoration, table overflow and each empty/loading/error state. This is a separate manual check; report it honestly if no browser runtime is available. No push, PR or release in this plan.

## Completion report

Report changed behavior and paths; focused/full automated results; browser checks actually performed; database/API/hardware/hosting checks not run and why. Distinguish this read-only office view from server Readiness, real regulatory acceptance, and release readiness.
