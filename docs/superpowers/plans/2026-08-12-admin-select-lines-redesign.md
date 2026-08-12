# Admin Select and Production Lines Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Give the main Admin consistent custom dropdowns, discoverable production-line management, aligned conflict filters, and high-contrast pairing barcodes.

**Architecture:** Keep the existing Radix-backed @markiro/ui Select and remove native mode only from Admin call sites. Extend the shared lines query with mutations, add a route-backed CRUD page, and make the device drawer link to that page. Layout and barcode fixes remain presentation-only.

**Tech Stack:** React 19, React Router, TanStack Query, Radix Select, Vitest, Testing Library, TypeScript, CSS, i18next.

## Global Constraints

- Scope production changes to apps/admin and shared Select presentation required by that cabinet.
- Do not change apps/saas-admin, apps/station, or apps/kiosk call sites.
- Preserve the Select native compatibility mode.
- Add no dependency, API, database, migration, or identity changes.
- Preserve OPERATIONS_READ, OPERATIONS_WRITE, and server-enforced quotas.
- Add matching Russian and English text for every visible string.
- Use test-first RED/GREEN cycles and stage only explicit files.
- Do not claim physical scanner acceptance without a real scanner.

---

### Task 1: Bound and polish the shared custom Select

**Files:**

- Modify: packages/ui/src/components/Select.tsx
- Modify: packages/ui/src/components.css
- Modify: packages/ui/test/components.test.tsx
- Modify: packages/ui/test/overlays.test.tsx

**Interfaces:**

- Consumes: SelectProps and useOverlayPortalContainer.
- Produces: unchanged Select API with bounded Radix popper presentation.

- [ ] **Step 1: Add failing geometry and overlay tests**

Extend the custom-overlay test:

```tsx
await user.click(screen.getByRole("combobox", { name: "Группа" }));
const content = screen.getByRole("listbox").closest<HTMLElement>("[data-mk-nested-overlay]")!;
expect(content.getAttribute("data-position")).toBe("popper");
expect(content.classList.contains("mk-select__content")).toBe(true);
expect(screen.getByRole("listbox").classList.contains("mk-select__viewport")).toBe(true);
```

Keep the existing proof that a Select inside SidePanel portals into the active panel layer.

- [ ] **Step 2: Run RED**

```bash
corepack pnpm --filter @markiro/ui exec vitest run test/components.test.tsx test/overlays.test.tsx
```

Expected: FAIL because the classes and popper marker do not exist.

- [ ] **Step 3: Implement bounded popper presentation**

Set position="popper", sideOffset={4}, collision padding, and content/viewport classes. Add:

```css
.mk-select__content {
  min-width: var(--radix-select-trigger-width);
  max-width: min(28rem, var(--radix-select-content-available-width));
  max-height: var(--radix-select-content-available-height);
  overflow: hidden;
}
.mk-select__viewport {
  max-height: min(20rem, var(--radix-select-content-available-height));
  padding: 4px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
```

Keep empty-value mapping, portal container, colors, selection, disabled, focus, and keyboard behavior unchanged.

- [ ] **Step 4: Run GREEN**

Run Step 2. Expected: both files PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/Select.tsx packages/ui/src/components.css packages/ui/test/components.test.tsx packages/ui/test/overlays.test.tsx
git commit -m "fix(ui): bound custom select menus"
```

### Task 2: Replace Admin native selects and fix presentation defects

**Files:**

- Modify: apps/admin/src/pages/devices/index.tsx
- Modify: apps/admin/src/pages/devices/DeviceDrawer.tsx
- Modify: apps/admin/src/pages/conflicts/index.tsx
- Create: apps/admin/src/pages/conflicts/conflicts.css
- Modify: apps/admin/src/pages/kiosks/pairingBarcodeBox.ts
- Modify: apps/admin/src/pages/devices/PairingBarcode.tsx
- Modify: apps/admin/src/pages/kiosks/PairingBarcode.tsx
- Modify: apps/admin/test/devices.test.tsx
- Modify: apps/admin/test/device-pairing.test.tsx
- Modify: apps/admin/test/conflicts.test.tsx
- Modify: apps/admin/test/kiosk-pairing-panel.test.tsx

**Interfaces:**

- Consumes: Select, pairingBarcodeBoxStyle, and existing query state.
- Produces: conflict-filter CSS hooks and an opaque shared barcode box.

- [ ] **Step 1: Add failing custom-control tests**

```tsx
expect(document.querySelectorAll("select")).toHaveLength(0);
expect(screen.getByRole("combobox", { name: "Тип устройства" }).tagName).toBe("BUTTON");
await user.click(screen.getByRole("combobox", { name: "Тип устройства" }));
await user.click(screen.getByRole("option", { name: "Станция" }));
```

Retain URL-filter and request-body assertions.

- [ ] **Step 2: Add failing layout and barcode tests**

Require a .mk-conflicts-filters region containing both comboboxes and a separate hint. Require both barcode components and their lazy placeholders to use the same white box style.

- [ ] **Step 3: Run RED**

```bash
corepack pnpm --filter @markiro/admin exec vitest run test/devices.test.tsx test/device-pairing.test.tsx test/conflicts.test.tsx test/kiosk-pairing-panel.test.tsx
```

Expected: FAIL on native elements, missing layout hooks, and transparent barcode background.

- [ ] **Step 4: Remove Admin-only native mode**

Remove native from two DevicesPage filters and the type/line selects in DeviceDrawer. Preserve controlled values and do not touch non-Admin call sites.

- [ ] **Step 5: Implement the Conflicts grid**

Import conflicts.css, render a labelled section, and move shift help below the controls. Use two columns on desktop, one under 42rem, min-width: 0 fields, and keep the hint in the shift column.

- [ ] **Step 6: Implement the scan surface**

Extend pairingBarcodeBoxStyle with background "#fff", quiet-zone padding, content-box sizing, and a neutral border. Keep black SVG bars, placeholder geometry, and encoded data unchanged.

- [ ] **Step 7: Run GREEN**

Run Step 3. Expected: all selected suites PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/admin/src/pages/devices apps/admin/src/pages/conflicts apps/admin/src/pages/kiosks/pairingBarcodeBox.ts apps/admin/src/pages/kiosks/PairingBarcode.tsx apps/admin/test/devices.test.tsx apps/admin/test/device-pairing.test.tsx apps/admin/test/conflicts.test.tsx apps/admin/test/kiosk-pairing-panel.test.tsx
git commit -m "fix(admin): polish selects conflicts and pairing barcode"
```

### Task 3: Extend the shared lines client

**Files:**

- Modify: apps/admin/src/pages/shifts/api.ts
- Create: apps/admin/test/lines-api.test.tsx

**Interfaces:**

- Consumes: apiFetch, LINES_QUERY_KEY, and LineDto.
- Produces: CreateLineInput, UpdateLineVariables, useCreateLine, useUpdateLine, and useDeleteLine.

- [ ] **Step 1: Write failing mutation-hook tests**

Use hook harnesses and assert POST, PATCH, DELETE paths and bodies:

```ts
expect(fetchMock).toHaveBeenCalledWith(
  "/api/lines/line-1",
  expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Розлив" }) }),
);
```

Require LINES_QUERY_KEY invalidation after every success.

- [ ] **Step 2: Run RED**

```bash
corepack pnpm --filter @markiro/admin exec vitest run test/lines-api.test.tsx
```

Expected: FAIL because mutation hooks are not exported.

- [ ] **Step 3: Implement typed mutations**

Add these exact public shapes:

```ts
export interface CreateLineInput {
  name: string;
}
export interface UpdateLineVariables {
  id: string;
  input: CreateLineInput;
}
export function useCreateLine(): UseMutationResult<LineDto, Error, CreateLineInput>;
export function useUpdateLine(): UseMutationResult<LineDto, Error, UpdateLineVariables>;
export function useDeleteLine(): UseMutationResult<void, Error, string>;
```

Implement POST/PATCH/DELETE with apiFetch; invalidate LINES_QUERY_KEY on success; remove the stale read-only comment.

- [ ] **Step 4: Run GREEN**

Run Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/pages/shifts/api.ts apps/admin/test/lines-api.test.tsx
git commit -m "feat(admin): add production line mutations"
```

### Task 4: Add route-backed production-line management

**Files:**

- Create: apps/admin/src/pages/lines/index.tsx
- Create: apps/admin/src/pages/lines/LinePanelRoute.tsx
- Create: apps/admin/src/pages/lines/LineForm.tsx
- Create: apps/admin/src/pages/lines/lines.css
- Modify: apps/admin/src/app.tsx
- Modify: apps/admin/src/layout/AppShell.tsx
- Modify: apps/admin/src/i18n/ru.json
- Modify: apps/admin/src/i18n/en.json
- Create: apps/admin/test/lines.test.tsx
- Modify: apps/admin/test/access-routing.test.tsx
- Modify: apps/admin/test/shell-layout.test.tsx

**Interfaces:**

- Consumes: Task 3 hooks, AdminPage, Table, SidePanel, Input, ConfirmDialog, useRoutePanelGuard, and capabilities.
- Produces: LinesPage, LinePanelRoute, /lines, /lines/new, and /lines/:lineId/edit.

- [ ] **Step 1: Write failing state and permission tests**

Cover loading, error, empty, populated, read-only, and write-authorized states. Require line name, creation date, explanation, and authorized create action.

- [ ] **Step 2: Write failing CRUD tests**

Require trimmed payloads, blocked empty/duplicate submit, success close/refetch, exact DELETE ID, and HTTP 409 leaving confirmation open with "Линия используется в сменах и не может быть удалена."

- [ ] **Step 3: Write failing routing tests**

Require /lines under Production with read capability, write guards for children, and a not-found panel for an unknown tenant line ID.

- [ ] **Step 4: Run RED**

```bash
corepack pnpm --filter @markiro/admin exec vitest run test/lines.test.tsx test/access-routing.test.tsx test/shell-layout.test.tsx
```

Expected: FAIL because page, routes, navigation, and translations do not exist.

- [ ] **Step 5: Implement list and delete flow**

Build LinesPage with explanatory copy, count, explicit query states, table, authorized row actions, confirmation dialog, and Outlet context. Map ApiRequestError status 409 to translated copy and keep the dialog open.

- [ ] **Step 6: Implement create/edit panels**

LineForm owns one name, trims submit, disables Save when empty/pending, and reports dirty state. LinePanelRoute uses Outlet context and useRoutePanelGuard, shows loading/error/not-found states, and keeps errors inline.

- [ ] **Step 7: Add routes, navigation, and RU/EN copy**

Guard parent with OPERATIONS_READ and children with OPERATIONS_WRITE. Add Production navigation after Shifts. Add matching keys for explanation, count, table, CRUD, validation, discard, referenced delete, generic errors, and success toasts.

- [ ] **Step 8: Run GREEN**

Run Step 4. Expected: all selected suites PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/admin/src/pages/lines apps/admin/src/app.tsx apps/admin/src/layout/AppShell.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/lines.test.tsx apps/admin/test/access-routing.test.tsx apps/admin/test/shell-layout.test.tsx
git commit -m "feat(admin): manage production lines"
```

### Task 5: Explain line assignment in the device drawer

**Files:**

- Modify: apps/admin/src/pages/devices/DeviceDrawer.tsx
- Modify: apps/admin/src/i18n/ru.json
- Modify: apps/admin/src/i18n/en.json
- Modify: apps/admin/test/devices.test.tsx
- Modify: apps/admin/test/device-pairing.test.tsx

**Interfaces:**

- Consumes: /lines, useLines, and React Router Link.
- Produces: translated line meaning and management recovery link.

- [ ] **Step 1: Write failing guidance tests**

With lines, require the default-workplace/grouped-shifts hint and an "Управлять линиями" link with href="/lines". With no lines, require "Производство -> Линии" recovery copy and retained "Без линии".

- [ ] **Step 2: Run RED**

```bash
corepack pnpm --filter @markiro/admin exec vitest run test/devices.test.tsx test/device-pairing.test.tsx
```

Expected: FAIL because guidance does not exist.

- [ ] **Step 3: Implement contextual guidance**

Pass populated/empty translated hints to the station Select and render a Router Link below it. Do not add nested panels, inline creation, or mutate place.

- [ ] **Step 4: Run GREEN**

Run Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/pages/devices/DeviceDrawer.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/devices.test.tsx apps/admin/test/device-pairing.test.tsx
git commit -m "fix(admin): explain station line assignment"
```

### Task 6: Final verification

**Files:**

- Verify all Task 1-5 files; modify only scoped files if a gate exposes a regression.

**Interfaces:**

- Consumes: all prior deliverables.
- Produces: fresh final evidence.

- [ ] **Step 1: Run package gates**

```bash
corepack pnpm --filter @markiro/ui test
corepack pnpm --filter @markiro/ui typecheck
corepack pnpm --filter @markiro/ui lint
corepack pnpm --filter @markiro/ui build
corepack pnpm --filter @markiro/admin test
corepack pnpm --filter @markiro/admin typecheck
corepack pnpm --filter @markiro/admin lint
corepack pnpm --filter @markiro/admin build
```

Expected: every command exits 0. Record warnings and skips separately.

- [ ] **Step 2: Run formatting and diff gates**

```bash
corepack pnpm format:check
git diff --check main...HEAD
git status --short
git diff --stat main...HEAD
```

Expected: formatting and whitespace pass, status has no unintended files, and diff is scoped.

- [ ] **Step 3: Run rendered acceptance when authenticated Admin is available**

Inspect /lines, /devices, /conflicts, and pairing reveal in both themes at desktop and narrow widths. Open affected dropdowns; verify bounded menus, keyboard focus, no clipping, filter alignment, barcode quiet zone, CRUD states, and recovery link.

- [ ] **Step 4: Record external limits**

Report browser acceptance as NOT RUN if no authenticated Admin was exercised. Report physical scanner acceptance as NOT RUN unless a real scanner read the code.

- [ ] **Step 5: Review final history**

```bash
git log --oneline main..HEAD
git status --short
```

List behavior, file areas, command results, rendered checks, unrun physical checks, and warnings. Do not merge or push without explicit request.
