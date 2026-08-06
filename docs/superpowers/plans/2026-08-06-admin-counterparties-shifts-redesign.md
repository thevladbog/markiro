# Counterparties and Shifts Admin Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Counterparties and Shifts from local centered modals to route-backed side panels and semantic confirmations while aligning both list pages with the completed Dashboard and Catalog interaction language.

**Architecture:** Keep each list route mounted while a nested create/edit route renders a `SidePanel` through `<Outlet>`. Reuse the Catalog overlay contracts, extract only the layout and route-guard behavior now proven by multiple consumers, and keep feature mutations, capability checks, dirty state, independent SSCC saving, and exact Shift payload semantics inside their owning features. `ConfirmDialog` handles delete and close decisions; no backend, DTO, query-key, or dependency changes are allowed.

**Tech Stack:** React 19, React Router data router, TanStack Query, react-hook-form, Zod, i18next, Vitest, Testing Library, vanilla CSS, `@markiro/ui`.

**Source specification:** `docs/superpowers/specs/2026-08-05-admin-interaction-redesign-design.md`, staged-delivery item 3.

## Global Constraints

- Preserve every current API path, request body, null-versus-omitted field rule, query invalidation, tenant boundary, capability check, and toast side effect.
- Create/edit routes require `operations.write`; direct read-only URLs must render the established forbidden page and must not mount write hooks.
- Keep the base list mounted behind every panel so filters, list scroll, and in-memory state survive Back and explicit close.
- Dirty close button, Escape, backdrop, and Back navigation require an explicit discard confirmation; pending mutations block every dismissal and duplicate submission.
- Failed mutations keep the current surface open, preserve entered values, and render a persistent inline error. Toast-only failure reporting is insufficient.
- Counterparty profile and SSCC counter remain separate resources with separate forms, validation, loading, error, and save actions.
- Shift create/edit must preserve touched-field omission semantics for `counterpartyId`, `labelTemplateId`, `ssccIssuerCounterpartyId`, and `boxLabelTemplateId` exactly.
- Use matching RU and EN keys, existing design tokens, visible keyboard focus, semantic headings, and no color-only status.
- Do not add a dependency, alter `pnpm-lock.yaml`, change the backend, or migrate later admin pages in this stage.
- Automated DOM tests do not count as browser confirmation; report browser, screen-reader, and mobile-keyboard coverage separately.

## File and Responsibility Map

- `packages/ui/src/components/AdminPage.tsx`: bounded admin-page layout wrapper.
- `packages/ui/src/components/FilterBar.tsx`: labelled, wrapping filter group with optional result summary and reset action.
- `packages/ui/src/components/RowActions.tsx`: consistent visible table-row action order and spacing.
- `packages/ui/src/components.css`, `packages/ui/src/components/index.ts`: shared styles and exports.
- `apps/admin/src/lib/useRoutePanelGuard.ts`: shared route-backed dirty/busy dismissal state machine extracted from Catalog.
- `apps/admin/src/pages/catalog/*`: behavior-preserving adoption of the shared wrappers and guard; no Catalog feature changes.
- `apps/admin/src/pages/counterparties/CounterpartyPanelRoute.tsx`: route-owned create/edit mutations, entity lookup, load states, close fallback, and dirty guard.
- `apps/admin/src/pages/counterparties/CounterpartyForm.tsx`: standard panel presentation plus independent profile and SSCC sections.
- `apps/admin/src/pages/counterparties/counterparties.css`: feature-only section and skeleton layout.
- `apps/admin/src/pages/shifts/ShiftPanelRoute.tsx`: route-owned create/edit mutations, dependency load states, stable edit seeding, and dirty guard.
- `apps/admin/src/pages/shifts/ShiftForm.tsx`: complex panel presentation with conditional named sections.
- `apps/admin/src/pages/shifts/shifts.css`: feature-only panel, filter, skeleton, and responsive layout.
- `apps/admin/src/pages/{counterparties,shifts}/index.tsx`: list data/context, route navigation, confirmations, and shared page primitives.
- `apps/admin/src/app.tsx`: nested write-capability routes.
- `apps/admin/src/i18n/{ru,en}.json`: lockstep copy for sections, states, results, reset, and confirmations.
- `apps/admin/test/{route-panel-guard,counterparties-routing,shifts-routing}.test.tsx`: shared and route-level interaction contracts.
- Existing `counterparties.test.tsx`, `shifts.test.tsx`, `access-routing.test.tsx`: payload, page, confirmation, and authorization regressions.

---

### Task 1: Shared Admin page primitives

**Files:**

- Create: `packages/ui/src/components/AdminPage.tsx`
- Create: `packages/ui/src/components/FilterBar.tsx`
- Create: `packages/ui/src/components/RowActions.tsx`
- Modify: `packages/ui/src/components/index.ts`
- Modify: `packages/ui/src/components.css`
- Modify: `packages/ui/test/components.test.tsx`
- Modify: `apps/admin/src/pages/catalog/index.tsx`
- Modify: `apps/admin/src/pages/catalog/catalog.css`
- Test: `apps/admin/test/catalog.test.tsx`

**Interfaces:**

- Produces: `AdminPageProps`, `FilterBarProps`, and `RowActionsProps` as small presentational APIs.
- Consumers: Catalog in this task; Counterparties and Shifts in later tasks.

- [x] **Step 1: Write failing shared-component tests**

Add tests that render the exact public contracts:

```tsx
render(
  <AdminPage data-testid="page">
    <h1>Title</h1>
  </AdminPage>,
);
expect(screen.getByTestId("page").classList).toContain("mk-admin-page");

render(
  <FilterBar label="Shift filters" resultSummary="3 shifts" onReset={() => resetSpy()}>
    <input aria-label="Status" />
  </FilterBar>,
);
expect(screen.getByRole("group", { name: "Shift filters" })).toBeDefined();
expect(screen.getByText("3 shifts").getAttribute("aria-live")).toBe("polite");

render(
  <RowActions>
    <button>Edit</button>
    <button>Delete</button>
  </RowActions>,
);
expect(screen.getByText("Edit").parentElement?.classList).toContain("mk-row-actions");
```

Define `FilterBarProps` so reset is rendered only when both `resetLabel` and `onReset` are supplied; `resultSummary` remains mounted and may be an empty string during loading/error.

- [x] **Step 2: Run the shared test and verify RED**

Run: `pnpm --filter @markiro/ui exec vitest run test/components.test.tsx`

Expected: FAIL because the three exports do not exist.

- [x] **Step 3: Implement the minimal components and token-only CSS**

Use these interfaces:

```tsx
export interface AdminPageProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export interface FilterBarProps {
  label: string;
  children: ReactNode;
  resultSummary?: ReactNode;
  resetLabel?: string;
  onReset?: () => void;
}

export interface RowActionsProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}
```

`AdminPage` merges `mk-admin-page`; `FilterBar` renders one `role="group"`, a `.mk-filter-bar__controls`, an always-mounted polite `.mk-filter-bar__result`, and an optional secondary compact reset `Button`; `RowActions` renders a visible flex action region. Add responsive wrapping below 768 px and preserve the Catalog maximum width and padding already encoded in `catalog.css`.

- [x] **Step 4: Adopt the components in Catalog without behavior changes**

Replace only the Catalog page wrapper, labelled filter wrapper/result paragraph, and `.mk-catalog-row-actions`. Keep all labels, queries, routes, buttons, debounce, and result-count behavior unchanged. Remove only CSS made redundant by the shared classes.

- [x] **Step 5: Run UI and Catalog tests and verify GREEN**

Run: `pnpm --filter @markiro/ui exec vitest run test/components.test.tsx`

Run: `pnpm --filter @markiro/ui build`

Run: `pnpm --filter @markiro/admin exec vitest run test/catalog.test.tsx test/catalog-routing.test.tsx`

Expected: PASS; Catalog still exposes `data-testid="catalog-page"`, the labelled filter group, result pluralization, and visible Edit/Delete actions.

- [x] **Step 6: Commit the shared page primitives**

```bash
git add packages/ui/src/components/AdminPage.tsx packages/ui/src/components/FilterBar.tsx packages/ui/src/components/RowActions.tsx packages/ui/src/components/index.ts packages/ui/src/components.css packages/ui/test/components.test.tsx apps/admin/src/pages/catalog/index.tsx apps/admin/src/pages/catalog/catalog.css apps/admin/test/catalog.test.tsx
git commit -m "feat(ui): add reusable admin page primitives"
```

---

### Task 2: Shared route-panel dismissal guard

**Files:**

- Create: `apps/admin/src/lib/useRoutePanelGuard.ts`
- Create: `apps/admin/test/route-panel-guard.test.tsx`
- Modify: `apps/admin/src/pages/catalog/ProductPanelRoute.tsx`
- Test: `apps/admin/test/catalog-routing.test.tsx`

**Interfaces:**

- Produces:

```ts
export interface RoutePanelGuard {
  setDirty: Dispatch<SetStateAction<boolean>>;
  requestClose: () => void;
  confirmOpen: boolean;
  cancelDiscard: () => void;
  confirmDiscard: () => void;
  finish: () => void;
}

export function useRoutePanelGuard(close: () => void, busy: boolean): RoutePanelGuard;
```

- Consumers: Product, Counterparty, and Shift panel controllers.

- [x] **Step 1: Write a failing harness test for the state machine**

Create a memory-router harness with `/list` and nested `/list/new`. Assert four paths:

1. Clean explicit close calls `close()` immediately.
2. Dirty explicit close exposes `confirmOpen`; cancel preserves route and input; discard closes.
3. Dirty `navigate(-1)` is blocked until discard proceeds.
4. Busy Back is reset, explicit dismissal is ignored, and `finish()` permits the successful navigation.

The test must use `createMemoryRouter`, not mock `useBlocker`.

- [x] **Step 2: Run the guard test and verify RED**

Run: `pnpm --filter @markiro/admin exec vitest run test/route-panel-guard.test.tsx`

Expected: FAIL because the hook does not exist.

- [x] **Step 3: Extract the proven Catalog state machine**

Move the current `useDirtyGuard` behavior without semantic changes. Preserve the `allowNavigationRef`, reset a blocked transition when `busy || !dirty`, and expose the renamed methods above. The hook owns only dirty/busy navigation state; feature copy and `ConfirmDialog` rendering stay in each panel route.

- [x] **Step 4: Migrate ProductPanelRoute to the shared hook**

Replace the local hook and rename only call sites:

```ts
const guard = useRoutePanelGuard(close, mutation.isPending);
// onClose={guard.requestClose}
// onCancel={guard.cancelDiscard}
// onConfirm={guard.confirmDiscard}
```

Do not change Product loading, stable edit values, mutations, copy, or route fallback.

- [x] **Step 5: Run guard and complete Catalog routing tests**

Run: `pnpm --filter @markiro/admin exec vitest run test/route-panel-guard.test.tsx test/catalog-routing.test.tsx test/catalog.test.tsx`

Expected: PASS for close button, Escape, backdrop, Back, pending submit, direct entry, load failure, and not-found behavior.

- [x] **Step 6: Commit the route guard**

```bash
git add apps/admin/src/lib/useRoutePanelGuard.ts apps/admin/src/pages/catalog/ProductPanelRoute.tsx apps/admin/test/route-panel-guard.test.tsx apps/admin/test/catalog-routing.test.tsx
git commit -m "refactor(admin): share route panel dismissal guard"
```

---

### Task 3: Counterparty nested routes and independent-section panel

**Files:**

- Create: `apps/admin/src/pages/counterparties/CounterpartyPanelRoute.tsx`
- Create: `apps/admin/src/pages/counterparties/counterparties.css`
- Modify: `apps/admin/src/pages/counterparties/CounterpartyForm.tsx`
- Modify: `apps/admin/src/pages/counterparties/index.tsx`
- Modify: `apps/admin/src/app.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Create: `apps/admin/test/counterparties-routing.test.tsx`
- Modify: `apps/admin/test/counterparties.test.tsx`
- Modify: `apps/admin/test/access-routing.test.tsx`

**Interfaces:**

- Produces `CounterpartyPanelRoute({ mode }: { mode: "create" | "edit" })` and `CounterpartiesPanelContext` supplied by the list page.
- Consumes `SidePanel size="standard"`, `useRoutePanelGuard`, existing counterparty/SSCC hooks, and nested React Router context.

- [x] **Step 1: Add failing nested-route and authorization tests**

Cover `/counterparties/new` and `/counterparties/:counterpartyId/edit` through the real route tree:

```tsx
expect(await screen.findByRole("dialog", { name: "Новый контрагент" })).toBeDefined();
expect(router.state.location.pathname).toBe("/counterparties/new");
```

Assert list state remains mounted behind the panel, direct close replaces to `/counterparties`, Back closes an opened-from-list panel, an unknown ID shows a translated not-found state, and read-only direct URLs render `forbidden-page` without mounting create/update/SSCC write hooks. Change every modified test `jsonResponse` helper to a native `Response`.

- [x] **Step 2: Add failing dirty, pending, load, and independent-section tests**

Assert:

- profile edits trigger discard confirmation for close button, Escape, backdrop, and Back;
- a changed unsaved SSCC serial triggers the same guard;
- saving SSCC does not validate or submit blank profile fields and clears SSCC dirty state after success;
- profile POST/PATCH pending blocks close and duplicate submit;
- SSCC PUT pending blocks panel dismissal but not profile field rendering;
- profile failure preserves values and renders its API message inline;
- SSCC load/PUT failure stays inside the SSCC section with Retry or persistent error;
- a list refetch changing another counterparty does not reset dirty edit values.

Run: `pnpm --filter @markiro/admin exec vitest run test/counterparties-routing.test.tsx test/counterparties.test.tsx test/access-routing.test.tsx`

Expected: FAIL because Counterparties still owns local modal state and the form does not publish dirty/section state.

- [x] **Step 3: Implement route-owned list context and close fallback**

The list page owns `items`, `isPending`, `isError`, and `refetch`. It renders `<Outlet context={... satisfies CounterpartiesPanelContext} />`. Navigation from the header/empty state uses `new`; row Edit uses `${id}/edit`; both pass `{ counterpartiesBackground: true }`.

Close behavior mirrors Catalog:

```ts
if ((location.state as CounterpartiesPanelLocationState | null)?.counterpartiesBackground) {
  void navigate(-1);
} else {
  void navigate("/counterparties", { replace: true });
}
```

Split create/edit route controllers so create mounts only `useCreateCounterparty` and edit mounts only `useUpdateCounterparty`. Required list data pending/error renders a shape-matched panel skeleton or Retry/Close state; missing edit entity never mounts a blank form.

- [x] **Step 4: Convert CounterpartyForm to a standard SidePanel**

Remove `open`; add:

```ts
submissionError?: string | null;
onDirtyChange: (dirty: boolean) => void;
onBusyChange: (busy: boolean) => void;
onClose: () => void;
```

Render two semantic sections: `Identity and GS1` for profile fields and `SSCC sequence` for the independent edit-only resource. Use a stable `initialValues` memo keyed by editable primitives and do not reset while the profile form is dirty. Aggregate `profileIsDirty || ssccIsDirty` into `onDirtyChange`; aggregate profile mutation pending from props with SSCC PUT pending through `onBusyChange` so the route guard blocks navigation for either resource.

Inside `CounterpartySsccSection`, expose `onDirtyChange` and `onBusyChange`, use `formState.isDirty`, and after a successful PUT call `reset({ nextSerial: savedSerial })`. Keep SSCC query loading/error isolated; Retry invokes `ssccQuery.refetch()`. If GLN cannot derive a prefix, render the existing unavailable state and keep Save disabled rather than treating it as a query failure.

- [x] **Step 5: Add bilingual panel/state copy and feature CSS**

Add matched keys for:

- `sections.identity`, `sections.sscc`;
- `form.loadError`, `form.notFound`, `form.retry`;
- shared counterparty discard title/body/continue/discard labels;
- SSCC retry and persistent save-error copy;
- result count singular/plural forms.

Use `.mk-counterparty-panel-section` headings, a profile grid that collapses below 560 px, an SSCC subsection boundary, and a skeleton matching both sections. Use tokens only.

- [x] **Step 6: Implement route-owned create/update success and failure**

Clear the persistent error before mutation. On success, keep the existing toast and call `guard.finish()`. On failure, prefer `ApiRequestError.message`, otherwise the existing translated generic error; keep panel and input mounted. Preserve the exact normalized POST/PATCH body already asserted in `counterparties.test.tsx`.

- [x] **Step 7: Run focused tests and verify GREEN**

Run: `pnpm --filter @markiro/ui build`

Run: `pnpm --filter @markiro/admin exec vitest run test/route-panel-guard.test.tsx test/counterparties-routing.test.tsx test/counterparties.test.tsx test/access-routing.test.tsx`

Expected: PASS with independent SSCC saving, exact payloads, direct-route authorization, dirty/pending safety, and no missing-translation warnings.

- [x] **Step 8: Commit the Counterparty panel**

```bash
git add apps/admin/src/pages/counterparties apps/admin/src/app.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/counterparties-routing.test.tsx apps/admin/test/counterparties.test.tsx apps/admin/test/access-routing.test.tsx
git commit -m "feat(admin): move counterparties to side panels"
```

---

### Task 4: Counterparty confirmation and page alignment

**Files:**

- Modify: `apps/admin/src/pages/counterparties/index.tsx`
- Modify: `apps/admin/src/pages/counterparties/counterparties.css`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Modify: `apps/admin/test/counterparties.test.tsx`

**Interfaces:**

- Consumes `AdminPage`, `RowActions`, and `ConfirmDialog`.
- Produces the completed Counterparties list surface; no new package API.

- [x] **Step 1: Add failing confirmation and layout tests**

Assert `AdminPage` class/data-testid, a polite localized result count, and visible Edit/Delete action order. For deletion, assert `role="alertdialog"`, exact counterparty name plus GLN entity, Cancel initial focus, Escape cancellation, exactly one DELETE while pending, disabled dismissal while pending, persistent 409 error inside the still-open dialog, and closure/refetch after success. Repeat the heading/result/action assertions in English.

- [x] **Step 2: Run Counterparty tests and verify RED**

Run: `pnpm --filter @markiro/admin exec vitest run test/counterparties.test.tsx`

Expected: FAIL because deletion still uses `Modal`, failures are toast-only, and page layout is inline.

- [x] **Step 3: Replace delete Modal and apply shared layout**

Use `ConfirmDialog` with `tone="destructive"`, `busy={deleteMutation.isPending}`, GLN as `entity`, and a description fragment containing consequence copy plus `Alert` when `deleteError` exists. Clear the error on open and before retry. Wrap the page in `AdminPage data-testid="counterparties-page"`, actions in `RowActions`, and keep the result live region mounted but blank during loading/error.

- [x] **Step 4: Run focused Counterparty tests**

Run: `pnpm --filter @markiro/admin exec vitest run test/counterparties.test.tsx test/counterparties-routing.test.tsx test/access-routing.test.tsx`

Expected: PASS with unchanged DELETE endpoint/query invalidation and no legacy Counterparty `Modal` import.

- [x] **Step 5: Commit Counterparty confirmation and layout**

```bash
git add apps/admin/src/pages/counterparties/index.tsx apps/admin/src/pages/counterparties/counterparties.css apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/counterparties.test.tsx
git commit -m "style(admin): align counterparties with catalog"
```

---

### Task 5: Shift nested routes and complex conditional panel

**Files:**

- Create: `apps/admin/src/pages/shifts/ShiftPanelRoute.tsx`
- Create: `apps/admin/src/pages/shifts/shifts.css`
- Modify: `apps/admin/src/pages/shifts/ShiftForm.tsx`
- Modify: `apps/admin/src/pages/shifts/index.tsx`
- Modify: `apps/admin/src/app.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Create: `apps/admin/test/shifts-routing.test.tsx`
- Modify: `apps/admin/test/shifts.test.tsx`
- Modify: `apps/admin/test/access-routing.test.tsx`

**Interfaces:**

- Produces `ShiftPanelRoute({ mode }: { mode: "create" | "edit" })` and `ShiftsPanelContext` with shifts plus all form dependencies and retry functions.
- Consumes `SidePanel size="complex"`, `useRoutePanelGuard`, and existing Shift hooks/payload types.

- [x] **Step 1: Add failing nested-route and authorization tests**

Cover `/shifts/new` and `/shifts/:shiftId/edit`. Assert list/filter state survives opening and Back; direct close falls back to `/shifts`; unknown shift shows not-found; read-only direct routes render forbidden without mounting create/update hooks; write-capable routes open translated dialogs. Use native `Response` helpers.

- [x] **Step 2: Add failing dirty, pending, and dependency-state tests**

Parameterize close button, Escape, backdrop, and Back after changing Product, mode, date, a Select, or aggregation capacity. Assert cancel preserves all conditional values and discard closes. Controlled POST/PATCH promises must block all dismissal and duplicate submits. Test each dependency family (`shifts`, products, lines, counterparties, templates): pending produces skeleton; failure produces Retry/Close; Retry makes exactly one additional request per required path. A background refetch changing a different shift must not reset the dirty edit form.

- [x] **Step 3: Preserve exact Shift payload regression matrix**

Retain all existing tests for:

- product defaults and switching Product A to Product B after fields were touched;
- omission of untouched optional selects;
- explicit `null` after selecting then clearing each optional select;
- create-only `productId` and disabled product editing;
- validation versus aggregation mode;
- `palletsEnabled` controlling whether `palletCapacity` is omitted or sent;
- independent displayed values for the two counterparty and two template selects.

Move only harness/navigation setup required by nested routes. Do not weaken exact `JSON.stringify` body assertions.

- [x] **Step 4: Implement Shifts list context and nested routes**

The list owns status/date filters and all five query states. It supplies stable arrays, pending/error flags, and `retryPanelData()` through `<Outlet>`. Add write-gated child routes in `app.tsx`. Header/empty action navigates to `new`; planned-row Edit navigates to `${id}/edit`; both mark `{ shiftsBackground: true }`. Route controllers own create/update mutations and the same background/direct close fallback used by Catalog and Counterparties.

- [x] **Step 5: Convert ShiftForm to a complex SidePanel**

Remove `open`; add `submissionError` and `onDirtyChange`. Render semantic sections:

1. Product and mode.
2. Planning (`plannedQty`, `plannedDate`).
3. Production assignment (`lineId`, counterparty, SSCC issuer).
4. Templates (product and box label templates).
5. Aggregation, rendered only for aggregation mode; pallet capacity remains conditional on `palletsEnabled`.

Publish `formState.isDirty`. Keep all four touched refs and every `setValue(..., { shouldDirty: true })` contract. Seed only when panel identity changes; hold an `isDirtyRef` so dependency/query refetches cannot reset unsaved values. Compute edit `initialValues` with `useMemo` from editable primitive fields, not the whole Shift object.

- [x] **Step 6: Implement route mutation/load behavior and bilingual copy**

Use route-owned persistent errors, existing success toasts, `guard.finish()` only after success, and Retry/Close/not-found states. Add matched RU/EN section, load, retry, not-found, discard, result-count, filter-label, and reset-filter keys. Add a complex-panel grid that collapses below 640 px and a five-section skeleton. Use tokens only.

- [x] **Step 7: Run focused Shift tests and verify GREEN**

Run: `pnpm --filter @markiro/ui build`

Run: `pnpm --filter @markiro/admin exec vitest run test/route-panel-guard.test.tsx test/shifts-routing.test.tsx test/shifts.test.tsx test/access-routing.test.tsx`

Expected: PASS with all existing exact payload assertions plus route, dirty, pending, dependency, retry, and authorization coverage.

- [x] **Step 8: Commit Shift panel routing and form**

```bash
git add apps/admin/src/pages/shifts/ShiftPanelRoute.tsx apps/admin/src/pages/shifts/ShiftForm.tsx apps/admin/src/pages/shifts/index.tsx apps/admin/src/pages/shifts/shifts.css apps/admin/src/app.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/shifts-routing.test.tsx apps/admin/test/shifts.test.tsx apps/admin/test/access-routing.test.tsx
git commit -m "feat(admin): move shift editing to side panels"
```

---

### Task 6: Shift decisions, filters, and page alignment

**Files:**

- Modify: `apps/admin/src/pages/shifts/index.tsx`
- Modify: `apps/admin/src/pages/shifts/shifts.css`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Modify: `apps/admin/test/shifts.test.tsx`

**Interfaces:**

- Consumes `AdminPage`, `FilterBar`, `RowActions`, `ConfirmDialog`, existing `useDeleteShift`, and `useCloseShift`.
- Produces completed Shift list decisions and filters; no shared API changes.

- [x] **Step 1: Add failing delete and close confirmation tests**

Delete tests mirror Counterparties: exact shift/product identity, Cancel initial focus, Escape/backdrop cancellation, one request while pending, disabled dismissal, persistent failure, and success closure.

For active-shift close, keep the required reason as the only input inside `ConfirmDialog.description` (the existing `ReactNode` contract; do not add a generic form slot). Assert reason shorter than three trimmed characters disables Close shift, pending blocks all dismissal/duplicates, failure keeps the reason and inline error, and success sends exactly:

```ts
{ id: shift.id, reason: "Переналадка линии" }
```

Reset reason/error only after success or an idle Cancel.

- [x] **Step 2: Add failing filter/page tests**

Assert `AdminPage`, a `FilterBar` named in RU/EN, always-mounted localized result count, and a Reset button visible only when status/from/to differs from defaults. Clicking Reset must clear all three controls and issue an unfiltered `/api/shifts` request. Preserve the existing date locale and exact query-parameter tests.

- [x] **Step 3: Run Shift tests and verify RED**

Run: `pnpm --filter @markiro/admin exec vitest run test/shifts.test.tsx`

Expected: FAIL because delete/close use legacy `Modal`, failure is toast-only, and filters/page layout are inline.

- [x] **Step 4: Implement semantic confirmations and shared layout**

Replace both Modals with `ConfirmDialog`. Use `tone="destructive"` for delete and the state-ending close action. Render the close-reason `Input` and optional `Alert` in a fragment passed to `description`; keep the confirm disabled for invalid reason by preventing invocation and, if needed, extend `ConfirmDialog` with an optional `confirmDisabled?: boolean` covered by a focused UI test. Do not use `busy` to represent invalid input.

Wrap the page in `AdminPage data-testid="shifts-page"`, filters/result/reset in `FilterBar`, and row controls in `RowActions`. Preserve visible Edit/Delete/Close text buttons.

- [x] **Step 5: Run focused UI and Shift tests**

Run: `pnpm --filter @markiro/ui exec vitest run test/components.test.tsx test/overlays.test.tsx`

Run: `pnpm --filter @markiro/ui build`

Run: `pnpm --filter @markiro/admin exec vitest run test/shifts.test.tsx test/shifts-routing.test.tsx test/access-routing.test.tsx`

Expected: PASS with exact filter queries, exact close payload, retained conditional-form payloads, and no legacy Shift `Modal` import.

- [x] **Step 6: Commit Shift confirmation and page alignment**

```bash
git add packages/ui/src/components/ConfirmDialog.tsx packages/ui/test/overlays.test.tsx apps/admin/src/pages/shifts/index.tsx apps/admin/src/pages/shifts/shifts.css apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/shifts.test.tsx
git commit -m "style(admin): align shifts with catalog"
```

If `ConfirmDialog` already supports disabling the confirm action when this task executes, omit unchanged UI files from the commit.

---

### Task 7: Complete verification and documentation

**Files:**

- Modify: `docs/superpowers/plans/2026-08-06-admin-counterparties-shifts-redesign.md` (checkbox results only)
- Review: all files changed by Tasks 1-6

**Interfaces:**

- Produces a review-ready Counterparties and Shifts stage with explicit automated/manual evidence.

- [x] **Step 1: Audit scope and legacy Modal use**

Run: `rg -n "\bModal\b" apps/admin/src/pages/counterparties apps/admin/src/pages/shifts`

Expected: no matches.

Run: `git diff --name-only origin/main...HEAD`

Expected: only shared UI/admin primitives, Catalog adoption, Counterparties, Shifts, routing, i18n, tests, and this plan. No backend, DTO, dependency, lockfile, Dashboard, or later-wave page changes.

- [x] **Step 2: Run focused tests**

Run: `pnpm --filter @markiro/ui exec vitest run test/components.test.tsx test/overlays.test.tsx test/feedback.test.tsx`

Run: `pnpm --filter @markiro/ui build`

Run: `pnpm --filter @markiro/admin exec vitest run test/route-panel-guard.test.tsx test/catalog.test.tsx test/catalog-routing.test.tsx test/counterparties.test.tsx test/counterparties-routing.test.tsx test/shifts.test.tsx test/shifts-routing.test.tsx test/access-routing.test.tsx`

Expected: PASS with no act, duplicate-key, missing-translation, or focus-restoration warnings caused by this stage.

- [x] **Step 3: Run full UI and Admin package gates**

Run each command separately:

```bash
pnpm --filter @markiro/ui test
pnpm --filter @markiro/ui typecheck
pnpm --filter @markiro/ui lint
pnpm --filter @markiro/ui build
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/admin build
```

Expected: every command exits 0. Record existing warnings separately; do not call them new regressions without diff evidence.

- [x] **Step 4: Run repository hygiene checks**

Run: `git diff --check origin/main...HEAD`

Run: `pnpm format:check`

Run: `git diff --unified=0 origin/main...HEAD -- packages/ui apps/admin docs/superpowers | rg -n '^\+[^+]' | rg -n $'\u2014|\u2013'`

Expected: no whitespace errors, formatting passes, and the added-line dash audit returns no matches.

- [ ] **Step 5: Perform browser and accessibility review if infrastructure permits**

Not run in this worktree: no authenticated Admin API/session was available for exercising the
real route tree in a browser. Automated DOM coverage verifies route authorization, focus trapping,
Escape/backdrop handling, inert background behavior, and responsive class contracts; live theme,
viewport, screen-reader, and mobile-keyboard checks remain external.

Run Admin with its normal authenticated API and verify Counterparties and Shifts at 1440, 1024, 768, and one viewport below 768 px in light and dark themes. Exercise:

- create, edit, direct link, not found, read-only denial, load failure, mutation failure, and pending mutation;
- panel width/full-screen behavior, body-only scrolling, sticky header/footer, button wrapping, and no horizontal overflow;
- long RU/EN titles, errors, section copy, result counts, and filters;
- exact focus restoration, visible focus, Tab/Shift+Tab containment, topmost Escape, background inertness, Back blocking, and reduced motion;
- independent Counterparty SSCC save/error and every Shift conditional aggregation state.

Report untested screen reader, mobile virtual keyboard, browser, or infrastructure behavior explicitly.

- [x] **Step 6: Review and commit verification evidence**

Update only completed checkboxes/evidence in this plan. Inspect `git diff --stat origin/main...HEAD` and the complete Admin/UI diff. Then commit:

```bash
git add docs/superpowers/plans/2026-08-06-admin-counterparties-shifts-redesign.md
git commit -m "docs: record admin stage verification"
```

## Completion Report Contract

The final handoff must list separately:

1. Behavior changed: shared page primitives/guard, Counterparty panels and independent SSCC section, Shift panels and conditional sections, confirmations, filters, and routes.
2. Files or areas changed: `packages/ui`, shared Admin route guard, Catalog adoption, Counterparties, Shifts, route tree, translations, and tests.
3. Automated checks: exact focused/full commands with pass/fail/skip counts.
4. Manual checks: exact themes, viewport sizes, keyboard paths, and direct URLs exercised.
5. Checks not run: browser, assistive technology, mobile keyboard, or infrastructure limits with reasons.

Do not claim Employees, Kiosks, operational pages, Team, Settings, Labels, Auth, or removal of the legacy `Modal` is complete; those remain later stages of the umbrella specification.
