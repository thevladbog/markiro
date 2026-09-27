# US-04 Unified Events and Transformation Office UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let U.S. office users work with Receiving and Transformation in one Events workspace, including version-safe Transformation editing, QA lifecycle, revision history, genealogy and manual Cases.

**Architecture:** Consume the separately reviewed [Transformation HTTP and Events API plan](2026-09-27-us-04-transformation-http-events-api.md); do not reproduce server rules in the browser. Add a strict client/proxy boundary, then a mixed Events list that opens the existing Receiving record components or new Transformation components by type. Use the existing `@markiro/ui` tokens/components and bilingual US copy; retain the old Receiving editor behavior and lot cross-links.

**Tech Stack:** Node 24, Corepack/pnpm, React, Vite, TypeScript, `@markiro/ui`, i18next, Zod, Vitest/Testing Library, local US browser checks.

**Spec:** [2026-09-26-us-04-transformation-http-events-ui-design.md](../specs/2026-09-26-us-04-transformation-http-events-ui-design.md). Read the approved spec, root `AGENTS.md`, and the completed API plan/results before execution.

## Global Constraints

- Begin only after the API plan's HTTP/list contracts and independent whole-increment review pass. Consume the actual exported schemas; do not invent a second browser-only event shape.
- U.S.-only `en-US` and `es-US`, with `en-US` default; locale switching never changes TLC, quantity/UOM, civil date, timezone or frozen bytes. Preserve the existing logo and `@markiro/ui` token/font authority.
- Events has Receiving and Transformation only; no Shipping placeholder, Station, shift selector, scanner, print, seed creation, RU route or release action.
- Keep Receiving's draft, amendment, finalized detail, CSV, unsaved-change and access-recovery behavior. Lot→Receiving navigation must remain functional.
- Only current `traceability.transformation.write` may create/save original Transformation drafts or link/unlink eligible cases; amendment draft saves and lifecycle actions are QA-only; auditors read without mutation.
- The client treats operation receipts as historical, reloads current records after success/uncertain retry, retains the exact payload/key while uncertainty persists, and never claims local edits survived a tab close.
- Finalized detail uses frozen values, not current master descriptions. `100 case` event quantity and `100` active case links are separate facts; a void origin keeps links visible but forbids new link.
- At 1024 px and in Spanish, identifiers remain legible, keyboard focus visible, status text not color-only; genealogy has a text equivalent.
- Preserve unrelated dirty work. No commit, push, PR, merge, deployment or release without separate authorization; the skill's default commit step is intentionally omitted.

## Review Focus

1. A newly selected event has the same number as an earlier row but a different type: dispatch by `type` and ID, never by number prefix alone (Task 2 test).
2. A save request times out after reaching the server: retain its key/payload, offer same-intent retry and perform a fresh GET before showing current state (Tasks 1 and 3 tests).
3. QA access disappears while an amendment dialog is open: disable write, keep local input, and never issue a save/finalize request (Task 3 test).
4. A voided Transformation's linked cases remain visible with `originState=gap`; new link is absent/blocked, reasoned unlink remains available to a writer (Task 5 test).
5. Spanish strings and 1024 px layout make a TLC or SSCC long: keep the full identifier accessible, focusable and non-truncated beyond recognition (Tasks 2 and 5 tests/browser check).

---

## File and interface map

- `apps/admin/src/us/client.ts`: add strict methods for Events, Transformation and Cases, plus safe typed conflict parsing. Keep one same-origin `request()` transport, no RU client import or persistent secret/command cache.
- `apps/admin/vite.us.config.ts`: explicitly allow only the new Events, Transformation, genealogy, revisions and Cases paths; preserve reject-unknown behavior.
- `apps/admin/src/us/events/events-view.tsx`: mixed list, filters, pagination, typed dispatch and an independently useful read-only Transformation summary in Task 2; it owns navigation, not event rules. `events.css` owns only US layout.
- Existing `apps/admin/src/us/receiving/view.tsx`: allow a caller-supplied draft/frozen record or new-entry intent and return to Events, without changing record logic; existing standalone list remains internally testable.
- `apps/admin/src/us/transformation/editor.tsx`, `readiness-panel.tsx`, `lifecycle-actions.tsx`, `detail.tsx`, `revision-history.tsx`, `genealogy.tsx`, `cases.tsx`: one responsibility each. Shared `transformation.css` uses existing UI tokens.
- `apps/admin/src/us/events/copy.ts` and `apps/admin/src/us/transformation/copy.ts`: complete English and Spanish keys; compose through `master-data/copy.ts`.
- `apps/admin/src/us/master-data/workspace.tsx`: one Events sidebar item, preserving lot/Receiving cross-links and mutation/dirty/access gates.

The Tasks 1–5 handoff uses the actual API-plan exports: `UsEventList`, `UsEventSummary`, `TransformationHttpRecord`, `TransformationRevisionList`, `TransformationReadiness`, `TransformationGenealogyResult`, and the case bridge's `CaseListResult`/`CaseLinkResult`/`CaseUnlinkResult`. Add client methods with these names and signatures, using `unknown` at untrusted input boundaries and parsed return types:

```ts
listEvents(query?: unknown): Promise<UsEventList>;
getTransformation(id: unknown): Promise<TransformationHttpRecord>;
createTransformation(input: unknown): Promise<TransformationDraftRecord>;
saveTransformation(id: unknown, input: unknown): Promise<TransformationDraftRecord>;
checkTransformationReadiness(id: unknown, expectedDraftVersion: unknown): Promise<TransformationReadiness>;
finalizeTransformation(id: unknown, input: unknown): Promise<TransformationFinalizedRecord>;
amendTransformation(id: unknown, input: unknown): Promise<TransformationLifecycleReceipt>;
voidTransformation(id: unknown, input: unknown): Promise<TransformationLifecycleReceipt>;
listTransformationRevisions(id: unknown, query?: unknown): Promise<TransformationRevisionList>;
queryTransformationGenealogy(input: unknown): Promise<TransformationGenealogyResult>;
listLotCases(id: unknown, query?: unknown): Promise<CaseListResult>;
linkLotCases(id: unknown, input: unknown): Promise<CaseLinkResult>;
unlinkLotCase(id: unknown, linkId: unknown, input: unknown): Promise<CaseUnlinkResult>;
```

If an API-plan reviewer changes an exported name, update this map and its corresponding test before UI implementation. No UI task silently falls back to `any` or a duplicate shape.

## Task 1: Strict browser client and local proxy

**Files:** Modify `apps/admin/src/us/client.ts`, `apps/admin/vite.us.config.ts`, `tools/us-development/test/browser-entry.test.mjs`; create `apps/admin/test/us-events-client.test.ts`, `apps/admin/test/us-transformation-client.test.ts`, `apps/admin/test/us-cases-client.test.ts`.

**Interfaces:** Methods and return types in the map above. Parse every input and response through shared schemas. `UsTransformationConflictError` extends `UsClientError` with only parsed `issues` or bounded `blockers`; never retain raw response, body, stack, token or unknown server text. The proxy accepts bounded query fields and exact UUID paths, strips only `/api/us`, and denies unknown `/api/*` paths.

- [ ] **Step 1: Write RED client tests.** Assert exact URL/method/body/credentials/no-store, invalid response refusal, typed 409 issue/blocker parsing, safe rejection of unknown error shapes, and no automatic retry/new operation key after a transport failure. Test a historical finalize/void receipt followed by the caller's explicit `GET`, not automatic current-state replacement inside `request()`.

```ts
const send = vi.fn<typeof fetch>().mockResolvedValue(
  Response.json(
    {
      code: "event_incomplete",
      issues: [
        {
          severity: "error",
          group: "event",
          line: null,
          field: "eventDate",
          code: "required",
          detail: null,
        },
      ],
    },
    { status: 409 },
  ),
);
await expect(createUsBrowserClient(send).finalizeTransformation(id, command)).rejects.toMatchObject(
  { code: "event_incomplete" },
);
expect(send).toHaveBeenCalledTimes(1);
expect(send.mock.calls[0]?.[1]).toMatchObject({
  method: "POST",
  credentials: "same-origin",
  cache: "no-store",
});
```

- [ ] **Step 2: Write RED proxy tests.** Accept `GET /api/us/traceability/events?type=transformation&limit=50&offset=0`, typed `:uuid/revisions`, genealogy query, bounded Cases list and exact unlink path. Reject `type=shipping`, duplicate query keys, `limit=101`, malformed UUID, trailing `/extra`, tenant query override and every RU `/api/boxes` path.
- [ ] **Step 3: Run RED.** `corepack pnpm --filter @markiro/admin exec vitest run test/us-events-client.test.ts test/us-transformation-client.test.ts test/us-cases-client.test.ts`; `node --test tools/us-development/test/browser-entry.test.mjs`. Require missing-method/proxy failures.
- [ ] **Step 4: Implement the client and anchored proxy additions.** Define `eventsPath = "/api/us/traceability/events"` and analogous fixed Transformation/Cases path constants. Follow the current `checked(schema,value,"invalid_response")` path and existing `request()` transport. Build query strings only from parsed fields, with one key each. Extend `UsClientErrorCode` with the API-plan's safe Transformation/case codes; parse `event_incomplete` issues and downstream blockers, including `hasMore`, only through shared strict schemas. In Vite, add anchored regexes for exact new paths and bounded query permutations, and preserve the final `rejectUnknownApi` middleware.

```ts
async listEvents(input: unknown = {}) {
  const query = checked(usEventListQuerySchema, input, "invalid_input");
  const params = new URLSearchParams({ type: query.type, history: query.history,
    limit: String(query.limit), offset: String(query.offset) });
  if (query.status) params.set("status", query.status);
  if (query.search) params.set("search", query.search);
  return request(`${eventsPath}?${params}`, usEventListSchema);
}
```

- [ ] **Step 5: Run GREEN and review.** Focused tests plus existing `test/us-receiving-client.test.ts` and `tools/us-development/test/browser-entry.test.mjs`, admin `typecheck`, `lint`, `build:us` with explicit US edition. Reviewer checks URL allowlist, strict response parsing, failure redaction and no hidden retry.

## Task 2: One Events list with preserved Receiving paths

**Files:** Create `apps/admin/src/us/events/events-view.tsx`, `events.css`, `copy.ts`, `apps/admin/test/us-events-ui.test.tsx`; modify `apps/admin/src/us/master-data/workspace.tsx`, `master-data/copy.ts`, `apps/admin/src/us/receiving/view.tsx`, `apps/admin/test/us-receiving-ui.test.tsx`, `apps/admin/test/us-lots-ui.test.tsx`.

**Interfaces:** `EventsView` receives `MasterDataViewProps`, `timeZone`, `canReceive`, `canTransform`, `canManageQa`, `canExport`, `initialReceiving?: ReceivingLiveRecord`, `onOpenLot`, and `onEntryBack` as applicable. It owns `{type,status,history,search,offset}` and selected `{type,id}`. `ReceivingView` gains optional `startNew?: boolean` and an `initialRecord?: ReceivingLiveRecord` (wider than its current frozen-only input), with `onEntryBack` returning to Events on close; its current record components and save logic stay unchanged.

- [ ] **Step 1: Write RED UI tests.** Render `MasterDataWorkspace` with a mixed `listEvents` fixture. Assert one Events nav button, two row types, filters and globally ordered page; click a Receiving row and verify the existing draft/finalized editor, CSV/export capability and back-to-Events behavior. Click New Receiving and verify a blank existing editor. Trigger Lot→Receiving and Receiving→Lot, preserving the prior return path. As auditor, assert no create buttons; in Spanish assert event type/status strings and full TLC/number labels are accessible.

```tsx
expect(await screen.findByRole("button", { name: "Events" })).toBeTruthy();
expect(screen.queryByRole("button", { name: "Receiving" })).toBeNull();
await user.click(screen.getByRole("button", { name: "REC-26-0001" }));
expect(await screen.findByRole("heading", { name: "REC-26-0001" })).toBeTruthy();
await user.click(screen.getByRole("button", { name: "Back to events" }));
expect(screen.getByRole("button", { name: "TRN-26-0001" })).toBeTruthy();
```

- [ ] **Step 2: Run RED.** `corepack pnpm --filter @markiro/admin exec vitest run test/us-events-ui.test.tsx test/us-receiving-ui.test.tsx test/us-lots-ui.test.tsx`; expect missing Events shell/entry behavior.
- [ ] **Step 3: Implement the shell.** Use `@markiro/ui` `Button`, `Input`, `Select`, `StatusChip`, `Table`, `Pager`, request-run guards and focus restoration patterns already used in `ReceivingView`. Dispatch rows by their discriminant `row.type`, never number prefix. After selecting a Receiving row, fetch it through `client.getReceivingRecord(selected.id)` and pass the parsed `receivingRecord` state to `ReceivingView` with `onEntryBack`; New Receiving passes `startNew`. The first Transformation row view is a genuine read-only summary with type, event number, status, civil date/timezone and location plus back navigation; it claims no editing until Task 3. Preserve `MasterDataWorkspace`'s `mutationPending`, `editorDirty`, access refresh and lot cross-link state when changing its sidebar view from `receiving` to `events`.

```tsx
if (selected?.type === "receiving")
  return (
    <ReceivingView
      {...receivingProps}
      initialRecord={receivingRecord}
      onEntryBack={() => setSelected(null)}
      backLabel={t("events.back")}
    />
  );
if (selected?.type === "transformation")
  return <TransformationSummaryView summary={selected.summary} onClose={() => setSelected(null)} />;
```

Define and test `TransformationSummaryView` in `events-view.tsx` in this task. Task 3 replaces the selected-Transformation branch with `TransformationRecordView` while retaining the summary as the loading/error fallback. The Task 2 reviewer must reject any claim that Transformation editing already works.

- [ ] **Step 4: Run GREEN and review.** Focused tests plus existing Receiving UI/client, Lots UI and US app tests; admin `typecheck`, `lint`, `build:us`. Reviewer confirms Receiving behavior and cross-navigation are intact, mixed list filters/paging work, and typed dispatch is not string-prefix inference.

## Task 3: Transformation draft, readiness and QA finalization

**Files:** Create `apps/admin/src/us/transformation/editor.tsx`, `readiness-panel.tsx`, `lifecycle-actions.tsx`, `copy.ts`, `transformation.css`, `apps/admin/test/us-transformation-editor.test.tsx`, `apps/admin/test/us-transformation-readiness.test.tsx`, `apps/admin/test/us-transformation-finalization.test.tsx`; modify `apps/admin/src/us/events/events-view.tsx`, `apps/admin/src/us/master-data/copy.ts`.

**Interfaces:** `TransformationRecordView` receives `client`, `eventId: string | null` (`null` means new), current capabilities, mutation/dirty hooks and callbacks. `TransformationEditor` keeps `{savedRecord, editableDraft, pendingCommand}` separately; `pendingCommand` is `{kind, operationKey, payload}` and never changes until a known outcome or explicit abandonment. `readiness-panel.tsx` accepts only a saved draft/version and exposes the server `inputDigest` only when current and complete.

- [ ] **Step 1: Write RED form/readiness tests.** A new draft can be incomplete and saved; inputs distinguish existing FTL lot from documented non-FTL source, outputs require product/TLC/quantity/UOM, processor location is read-only output source. A local edit invalidates old readiness digest. QA sees finalization; production does not. Test two FTL inputs→one output and zero FTL inputs with one non-FTL line. Assert no shift, scanner or print controls.

```tsx
await user.click(screen.getByRole("button", { name: "New transformation" }));
expect(screen.getByLabelText("Completion date")).toBeTruthy();
expect(screen.getByText("Output TLC source: transformation location")).toBeTruthy();
expect(screen.queryByLabelText("Closed shift")).toBeNull();
expect(screen.queryByRole("button", { name: "Print" })).toBeNull();
```

- [ ] **Step 2: Write RED uncertainty/conflict tests.** On a timed-out save, keep the exact operation key and payload and offer retry; after a known acknowledgement or same-intent retry, `GET` current record. On `409 event_incomplete`, show typed issues in the correct group; on stale draft/readiness version, preserve editable input and require reload. If access refresh removes QA, disable save of revision 2/finalize and retain local edits. No invalid server response overwrites a displayed record.
- [ ] **Step 3: Run RED.** `corepack pnpm --filter @markiro/admin exec vitest run test/us-transformation-editor.test.tsx test/us-transformation-readiness.test.tsx test/us-transformation-finalization.test.tsx`.
- [ ] **Step 4: Implement the grouped editor.** Reuse existing tenant-scoped `client.listLots`, `listProducts`, `getProductProfile`, `listLocations`, `listReferenceDocuments` pickers and `@markiro/ui` controls. Store decimal strings and UOM unchanged. Save the entire strict `TransformationDraft` with `expectedDraftVersion`; never send output lot IDs, synthetic flags or client-chosen source identity. Server readiness runs only against the last saved version; a changed edit clears its digest. Finalization confirmation restates grouped quantities, line/document counts and output lot creation, but never says Cases are linked. Use the same mutation/dirty/focus hooks as Receiving.

```ts
const command = {
  operationKey: crypto.randomUUID(),
  expectedDraftVersion: saved.draftVersion,
  expectedInputDigest: readiness.inputDigest,
};
setPendingCommand({ kind: "finalize", operationKey: command.operationKey, payload: command });
const receipt = await client.finalizeTransformation(saved.id, command);
const current = await client.getTransformation(receipt.id);
setSavedRecord(current);
setPendingCommand(null);
```

- [ ] **Step 5: Implement QA lifecycle entry.** `lifecycle-actions.tsx` starts a reasoned amendment or void with captured `expectedLifecycleVersion`; original-draft void also sends `expectedDraftVersion` and explains no lots were created. A revision-2 draft is QA-editable only; on void of a finalized record, explain output lots and existing case links remain but have no current origin. Do not present void as delete or auto-archive.
- [ ] **Step 6: Run GREEN and review.** Focused tests, existing Receiving UI regressions, admin `typecheck`, `lint`, `build:us`. Reviewer checks role loss during dialogs, immutable output identity on amendments, exact retry identity, readiness invalidation and no case/shift/print promises.

## Task 4: Frozen detail and revision navigation

**Files:** Create `apps/admin/src/us/transformation/detail.tsx`, `revision-history.tsx`, `apps/admin/test/us-transformation-detail.test.tsx`, `apps/admin/test/us-transformation-history.test.tsx`; modify `apps/admin/src/us/events/events-view.tsx` and `apps/admin/src/us/transformation/copy.ts`.

**Interfaces:** `TransformationDetail` accepts a parsed `TransformationHttpRecord`, typed QA actions and `onOpenLot(id)`. `TransformationRevisionHistory` accepts `TransformationRevisionList`, selected event ID and a bounded page callback. Neither recalculates a frozen product/location/source/document label from live master data.

- [ ] **Step 1: Write RED detail/history tests.** Finalized rev 1 shows frozen processor, inputs, outputs, exact quantity/UOM and documents; changed master data does not alter it. Amendment rev 2 shows predecessor, reason and stable output lot IDs; rev 1 becomes Amended with an explicit superseded link. Void detail shows actor/time/reason and exclusion without archival claim. Original-draft void shows saved draft but no frozen snapshot. A failed revision read leaves the current detail visible.

```tsx
expect(screen.getByText("NRF-260915-APL01")).toBeTruthy();
expect(screen.getByText("100.000 case")).toBeTruthy();
expect(screen.getByText("Amended · revision 1")).toBeTruthy();
expect(screen.queryByText("Automatically archived")).toBeNull();
```

- [ ] **Step 2: Run RED.** `corepack pnpm --filter @markiro/admin exec vitest run test/us-transformation-detail.test.tsx test/us-transformation-history.test.tsx`.
- [ ] **Step 3: Implement frozen detail and bounded history.** Parse with the shared record/list schemas on the client; render snapshot-only business values when `snapshot` exists and saved draft values only for a draft/void-without-snapshot. Use a status chip with text/icon, revision strip, exact source/quantity rows and `@markiro/ui` controls. The history component pages 1–100 results, validates all rows share root/number/timezone/current pointers and never swaps displayed content on failed fetch. Show the event's saved IANA timezone next to its civil date.
- [ ] **Step 4: Run GREEN and review.** Focused tests, admin `typecheck`, `lint`, `build:us`; reviewer checks immutable snapshots, revision/current distinction, no accidental edit affordance on history and EN/ES detail copy.

## Task 5: Cases and genealogy evidence panels

**Files:** Create `apps/admin/src/us/transformation/cases.tsx`, `genealogy.tsx`, `apps/admin/test/us-transformation-cases.test.tsx`, `apps/admin/test/us-transformation-genealogy.test.tsx`; modify `apps/admin/src/us/transformation/detail.tsx`, `apps/admin/src/us/lots/lots-view.tsx`, `apps/admin/src/us/master-data/workspace.tsx`, `apps/admin/src/us/transformation/copy.ts`.

**Interfaces:** Cases panel consumes the existing `CaseListResult`, `CaseLinkResult`, `CaseUnlinkResult` and `originState`; genealogy consumes `TransformationGenealogyResult` with `complete`, diagnostics and `balance.state`. Lot detail can open its current Transformation origin and Cases without assuming every lot has a Transformation origin.

- [ ] **Step 1: Write RED Cases tests.** A zero-link finalized output is valid; show active count 0 separately from `100 case` quantity. Link an eligible SSCC, show `synthetic_demo` or `existing_record`, link source, actor/time and history. A void origin keeps active/history rows with a visible provenance gap, hides new link but retains reasoned exact-link unlink for a writer. Auditor sees read-only rows. Wrong/stale link 409 keeps the prior state and offers reload.

```tsx
expect(screen.getByText("100.000 case")).toBeTruthy();
expect(screen.getByText("0 linked cases")).toBeTruthy();
expect(screen.queryByText("100 linked cases")).toBeNull();
expect(screen.getByText("No current Transformation origin")).toBeTruthy();
expect(screen.queryByRole("button", { name: "Link cases" })).toBeNull();
```

- [ ] **Step 2: Write RED genealogy tests.** Current upstream/pinned revision views retain server-selected event IDs and diagnostics; depth/cycle/origin-gap results say incomplete, include returned counts and an accessible text list. Mixed UOM balance renders “not comparable”, never a computed yield. No case link changes the frozen graph or snapshot.
- [ ] **Step 3: Run RED.** `corepack pnpm --filter @markiro/admin exec vitest run test/us-transformation-cases.test.tsx test/us-transformation-genealogy.test.tsx`.
- [ ] **Step 4: Implement evidence-only panels.** Cases use the bridge's bounded pages and exact active link ID for unlink, preserve `operationKey` during uncertainty and reload after confirmed mutation. Genealogy requests use existing `mode=current|pinned`, direction and limits; display `complete`/diagnostic state from the server and one textual node/edge list alongside a compact visual preview. Do not infer physical closure, scan, print or regulatory readiness from a case row. In Lot detail, show an output-origin link only when corroborated; keep manual/imported/void-origin lots explicit.
- [ ] **Step 5: Run GREEN and review.** Focused tests plus `test/us-lots-ui.test.tsx`, admin `typecheck`, `lint`, `build:us`. Reviewer checks origin-gap and audited unlink semantics, tenant-safe exact SSCC display, no quantity/count conflation and genealogy accessibility.

## Task 6: Brief reconciliation, CI and browser handoff

**Files:** Modify `docs/design-briefs/us/03-cte-events.md`, `04-trace-and-readiness.md`, `08-design-baseline.md`, `docs/us/implementation-plan.md`, `docs/us/requirements-traceability.md`, `.github/workflows/us-development.yml`, `tools/us-development/test/browser-entry.test.mjs`, and the existing `tools/us-development/test/receiving-*-flow.mjs`/`receiving-csv-flow.smoke.mjs` entry flows affected by the sidebar rename; create `tools/us-development/test/transformation-flow.smoke.mjs` using `browser-fixture.mjs`. Do not open or edit `.pen` except via Pencil MCP in a separately authorized visual reconciliation task.

**Interfaces:** CI owns all new admin tests, strict proxy tests and the isolated `build:us`. Docs mark only actually verified UI/API behavior implemented; US-11 seed, Shipping, visual `.pen` acceptance, hosted CI and deployment stay pending. The browser walkthrough exercises one mixed list and a Transformation path against disposable U.S. data, not a live production tenant.

- [ ] **Step 1: Write RED CI ownership tests.** Require each new admin test filename in the US browser step, the new proxy tests in the local entry step, and no added release permission/dispatch. Assert the US build remains local-only and `rejectUnknownApi` still denies RU routes.
- [ ] **Step 2: Run RED.** `node --test tools/us-development/test/browser-entry.test.mjs tools/us-development/test/isolation.test.mjs`; expect missing new coverage.
- [ ] **Step 3: Update workflow, briefs and browser flows.** Remove or qualify the historical P0 closed-shift selector, automatic “100 cases linked at finalization,” fabricated consumption status and output-lot archival on void in brief 03. In brief 04 replace `/boxes` references with exact `/cases` bridge routes and provenance terms. Keep design baseline 08 explicit that affected `.pen` frames have not been revalidated via Pencil MCP. Update traceability/docs only for checks actually run; leave US-11 and US-05 open. Update each existing Receiving browser flow's sidebar entry to Events→Receiving without weakening its assertions. Add a new disposable-DB, real-MFA browser flow for mixed global list, complete Transformation draft→readiness→QA finalization, EN/ES and 1024 px identifier access; capture only safe states, never credentials, MFA material or cookies.

```md
P0 finalization creates the output lot and freezes event quantity; it does not link cases.
The separate Cases panel reports active server links and synthetic/existing-record provenance.
After void, output lots and existing links remain with an explicit current-origin gap.
```

- [ ] **Step 4: Run final local checks.** Targeted admin tests, full affected admin package test/typecheck/lint/build, `VITE_DEPLOYMENT_EDITION=US corepack pnpm --filter @markiro/admin build:us`, US isolation and proxy Node tests, `corepack pnpm format:check`, `git diff --check`. Run `node --test tools/us-development/test/transformation-flow.smoke.mjs` and affected existing Receiving browser flows using the already-present `startUsBrowserFixture`; if the pinned Playwright browser runtime is unavailable, report that check as environment-blocked, not passed. Report browser/hardware/Spanish-fluent/hosted CI/deployment separately. Independent whole-increment reviewer checks all five Review Focus items and the complete diff, not just the last task.

## Execution boundary

Use one fresh implementer and one independent reviewer for each task, sequentially, followed by a whole-increment review. Keep the U.S. work isolated from main and all release workflows. This plan does not authorize a commit, push, PR, merge or deployment.
