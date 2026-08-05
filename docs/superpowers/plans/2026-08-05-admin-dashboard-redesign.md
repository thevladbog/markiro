# Admin Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the empty admin overview with a real-data operational dashboard and make the expanded cabinet navigation easier to scan.

**Architecture:** `DashboardPage` composes the existing product, shift, line, and conflict query hooks and renders explicit loading, error, first-run, and operational states. `@markiro/ui` extends its existing router-agnostic `SidebarItem` contract with an optional translated section label, while `AppShell` continues to own authorization filtering and i18n.

**Tech Stack:** React 19, React Router, TanStack Query, react-i18next, Vitest, Testing Library, `@markiro/ui` CSS variables.

## Global Constraints

- Preserve all route paths and capability checks.
- Use existing tenant-scoped endpoints only; do not invent production metrics.
- Preserve light/dark and RU/EN behavior.
- Write focused failing tests before production changes.
- Keep dashboard styles local and responsive at 1024px and 768px.
- Do not overlap the separate admin custom-controls implementation.

---

### Task 1: Dashboard state contract and first-run experience

**Files:**

- Create: `apps/admin/test/dashboard.test.tsx`
- Create: `apps/admin/src/pages/dashboard/dashboard.css`
- Modify: `apps/admin/src/pages/dashboard/index.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Modify: `apps/admin/test/shell-layout.test.tsx`

**Interfaces:**

- Consumes: `useProducts()`, `useShifts()`, `useLines()`, `useConflicts({ reviewed: false })`, `useCan(CABINET_CAPABILITY.OPERATIONS_WRITE)`.
- Produces: a `DashboardPage` with loading, error, onboarding, and operational states; no new exported application API.

- [ ] **Step 1: Write the failing onboarding test**

  Stub all four list endpoints with empty `items`, render `DashboardPage`, and assert that
  "Подготовьте первую смену" and the `/catalog` primary link are present while the old "Пока нет
  данных" copy is absent.

- [ ] **Step 2: Run the focused test and verify RED**

  Run: `pnpm --filter @markiro/admin exec vitest run test/dashboard.test.tsx`

  Expected: FAIL because the current dashboard only renders the legacy empty state.

- [ ] **Step 3: Implement the minimal query composition and onboarding state**

  Call the four existing hooks unconditionally, derive the first incomplete setup step from their
  returned arrays, and render semantic setup steps plus the correct translated link.

- [ ] **Step 4: Add failing loading and error tests**

  Keep one request unresolved to assert the skeleton's accessible loading label. Return a failed
  response to assert the error title and retry button.

- [ ] **Step 5: Implement matching loading and error states**

  Add a layout-shaped static skeleton and a contextual alert with one action that refetches all
  dashboard queries.

- [ ] **Step 6: Add the failing operational overview test**

  Return one active product, one draft product, one active shift, one planned shift, one line, and
  one unreviewed conflict. Assert exact summary counts, the attention links, the active shift's
  product/line, and the planned shift entry.

- [ ] **Step 7: Implement the operational overview**

  Render the divided summary strip, conditional attention rows, active-shifts table, and upcoming
  shift list. Sort planned shifts by date and then `createdAt`; limit each operational list to five
  rows and link to the full destination.

- [ ] **Step 8: Add responsive dashboard styling and RU/EN copy**

  Use CSS grid breakpoints at 1024px and 768px, token-only colors/spacing, mono numeric values, and
  a single semantic accent. Add every visible string to both locale files.

- [ ] **Step 9: Run dashboard and shell tests and verify GREEN**

  Run: `pnpm --filter @markiro/admin exec vitest run test/dashboard.test.tsx test/shell-layout.test.tsx`

  Expected: PASS with no warnings.

### Task 2: Capability-aware navigation groups

**Files:**

- Modify: `packages/ui/src/components/Sidebar.tsx`
- Modify: `packages/ui/test/feedback.test.tsx`
- Modify: `apps/admin/src/layout/AppShell.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Modify: `apps/admin/test/shell-layout.test.tsx`

**Interfaces:**

- Consumes: current `SidebarItem { to, labelKey, badge? }` and `renderLink` contract.
- Produces: optional `section?: string` on `SidebarItem`; consecutive items with the same section
  render one non-interactive section label.

- [ ] **Step 1: Write the failing Sidebar group test**

  Give two items the same `section` and a third item a different section. Assert each section label
  renders once and all links still render through `renderLink`.

- [ ] **Step 2: Run the UI test and verify RED**

  Run: `pnpm --filter @markiro/ui exec vitest run test/feedback.test.tsx`

  Expected: FAIL because `SidebarItem` does not accept or render `section`.

- [ ] **Step 3: Implement section rendering and constrained-height behavior**

  Extend the interface, render a section label only when it changes from the previous visible item,
  make the list independently scrollable, and keep footer/profile outside that scroll area.

- [ ] **Step 4: Add the failing AppShell grouping test**

  Assert the operational manager sees translated "Производство" and "Справочники" headings, does
  not see empty privileged groups, and sees the clarified employee label.

- [ ] **Step 5: Attach translated sections after capability filtering**

  Add a section key to each `NAV_ITEMS` entry, translate it in `AppShell`, and keep filtering before
  rendering so hidden capabilities cannot leave empty headings.

- [ ] **Step 6: Add tokenized focus and dark muted-text contrast**

  Define a `:focus-visible` ring for sidebar links, suppress the browser's non-keyboard default
  outline, and adjust dark `--fg-3` from `#8a877f` to `#8e8b83` so 12px text on
  `--surface-panel` exceeds 4.5:1.

- [ ] **Step 7: Run focused UI and admin tests and verify GREEN**

  Run: `pnpm --filter @markiro/ui exec vitest run test/feedback.test.tsx`

  Run: `pnpm --filter @markiro/admin exec vitest run test/dashboard.test.tsx test/shell-layout.test.tsx`

  Expected: PASS with no warnings.

### Task 3: Package gates and visual audit

**Files:**

- Review only: all files changed by Tasks 1 and 2.

**Interfaces:**

- Consumes: completed dashboard and grouped sidebar.
- Produces: verified build artifacts locally only; no tracked generated output.

- [ ] **Step 1: Rebuild the UI package before consumer checks**

  Run: `pnpm --filter @markiro/ui build`

- [ ] **Step 2: Run UI package gates**

  Run: `pnpm --filter @markiro/ui test`

  Run: `pnpm --filter @markiro/ui typecheck`

  Run: `pnpm --filter @markiro/ui lint`

- [ ] **Step 3: Run admin package gates**

  Run: `pnpm --filter @markiro/admin test`

  Run: `pnpm --filter @markiro/admin typecheck`

  Run: `pnpm --filter @markiro/admin lint`

  Run: `pnpm --filter @markiro/admin build`

- [ ] **Step 4: Run repository hygiene checks**

  Run: `git diff --check`

  Run: `rg -n "—|–" apps/admin/src/pages/dashboard apps/admin/src/i18n packages/ui/src/components/Sidebar.tsx`

  Expected: no visible dash characters introduced by this change.

- [ ] **Step 5: Inspect light, dark, and narrow layouts in a browser if infrastructure permits**

  Verify first-run and operational data at desktop width, dark theme contrast, keyboard focus, and
  the 1024px/768px grid collapse. Report browser verification separately from automated checks.
