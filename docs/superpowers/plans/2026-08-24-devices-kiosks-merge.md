# Devices + Kiosks Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the admin «Киоски» section into «Устройства» (single hardware registry hosting kiosk settings panels) and move «Причины» into the «Выбытие» section, removing the «Киоски» sidebar item.

**Architecture:** Frontend-only refactor of `apps/admin`. Kiosk panel routes (`new`/`:id/edit`/`:id/pair`) become children of the `devices` route; `DevicesPage` takes over `KiosksPage`'s role of Outlet host supplying `KiosksPanelContext`. `ReasonsPage` moves to `pages/pickup/` and the pickup pages gain a shared `PickupViewNav` tab strip (Заявки | Отклонённые сканы | Причины). Old `/kiosks*` URLs get redirects. Admin API, DB, kiosk app are untouched.

**Tech Stack:** React 19, react-router 7 (data-less `<Route>` tree in `apps/admin/src/app.tsx`), TanStack Query, Vitest + Testing Library, i18next.

## Global Constraints

- Capability gates unchanged: view `OPERATIONS_READ`; kiosk create/edit/archive `OPERATIONS_WRITE`; pairing `CREDENTIALS_MANAGE` (spec §4).
- Old URLs must redirect: `/kiosks` → `/devices?type=kiosk`, `/kiosks/reasons` → `/pickup/reasons`, `/kiosks/new` → `/devices/kiosks/new`, `/kiosks/:kioskId/edit` → `/devices/kiosks/:kioskId/edit`, `/kiosks/:kioskId/pair` → `/devices/kiosks/:kioskId/pair` (spec §3).
- No admin-API changes; `pages/kiosks/api.ts` continues to serve the panels.
- Static `pickup/rejections` and `pickup/reasons` routes must be declared before dynamic `pickup/:id`.
- Verification per task: `pnpm --filter @markiro/admin test`; final: also `lint` and `typecheck`.

---

### Task 1: DevicesPage hosts kiosk panels

**Files:**

- Modify: `apps/admin/src/app.tsx` (routes 257–305)
- Modify: `apps/admin/src/pages/devices/index.tsx`
- Modify: `apps/admin/src/pages/kiosks/KioskPanelRoute.tsx` (`closeKioskPanel`, create-panel pair link)
- Modify: `apps/admin/src/pages/kiosks/KioskPairingPanelRoute.tsx` (any `/kiosks` nav targets)
- Modify: `apps/admin/src/pages/devices/DeviceActions.tsx` (settings link)
- Test: `apps/admin/test/devices.test.tsx` (add panel-hosting cases), `apps/admin/test/kiosks-routing.test.tsx` (retarget paths)

**Interfaces:**

- Consumes: `KiosksPanelContext`, `KiosksPanelLocationState`, `useKiosks` from `pages/kiosks/`.
- Produces: `devices` route is a layout route with children `kiosks/new`, `kiosks/:kioskId/edit`, `kiosks/:kioskId/pair`; `DevicesPage` renders `<Outlet context={… satisfies KiosksPanelContext}>`; `closeKioskPanel` falls back to `/devices` (not `/kiosks`).

- [ ] **Step 1: Failing test** — in `devices.test.tsx` add a case: render router at `/devices/kiosks/<id>/edit` (same harness style the file already uses) and assert the kiosk edit panel title (`pages.kiosks.form.editTitle` → «Настройки киоска» string from ru.json) appears above the devices table. Run: `pnpm --filter @markiro/admin test -- devices` — expect FAIL (route not found).
- [ ] **Step 2: Restructure routes.** In `app.tsx` replace the flat `devices` route and the `kiosks` subtree:

```tsx
<Route
  path="devices"
  element={
    <RequireCapability capability={C.OPERATIONS_READ}>
      <DevicesPage />
    </RequireCapability>
  }
>
  <Route
    path="kiosks/new"
    element={
      <RequireCapability capability={C.OPERATIONS_WRITE}>
        <KioskCreatePanelRoute />
      </RequireCapability>
    }
  />
  <Route
    path="kiosks/:kioskId/edit"
    element={
      <RequireCapability capability={C.OPERATIONS_WRITE}>
        <KioskEditPanelRoute />
      </RequireCapability>
    }
  />
  <Route
    path="kiosks/:kioskId/pair"
    element={
      <RequireCapability capability={C.CREDENTIALS_MANAGE}>
        <KioskPairingPanelRoute />
      </RequireCapability>
    }
  />
</Route>
```

Keep the old `/kiosks` subtree for now (Task 3 removes it) so existing tests stay green mid-refactor.

- [ ] **Step 3: Host the Outlet in DevicesPage.** In `pages/devices/index.tsx` import `Outlet` from react-router, `useKiosks` and `KiosksPanelContext` type from `../kiosks/`; inside the component add `const kiosksResult = useKiosks();` and before the closing `</div>` render:

```tsx
<Outlet
  context={
    {
      kiosks: kiosksResult.data ?? [],
      kiosksPending: kiosksResult.isPending,
      kiosksError: kiosksResult.isError,
      kiosksResolved: kiosksResult.data !== undefined,
      retryPanelData: async () => {
        await kiosksResult.refetch();
      },
    } satisfies KiosksPanelContext
  }
/>
```

Note: `useKiosks` mounts an extra query on the devices page; acceptable (same data the panels need, cached by TanStack Query).

- [ ] **Step 4: Retarget panel navigation.** In `KioskPanelRoute.tsx`: `closeKioskPanel` fallback `navigate("/kiosks", …)` → `navigate("/devices", …)`; create-success pair button `/kiosks/${created.id}/pair` → `/devices/kiosks/${created.id}/pair`. In `KioskPairingPanelRoute.tsx` update any `/kiosks` navigation targets the same way. In `DeviceActions.tsx` change the settings link to `to={`/devices/kiosks/${device.id}/edit`}` and pass `state={{ kiosksBackground: true }}` so closing returns to the devices list in-place.
- [ ] **Step 5: Run tests, fix retargeted expectations** in `kiosks-routing.test.tsx` / `device-pairing` tests that assert old link hrefs. Run: `pnpm --filter @markiro/admin test` — expect PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(admin): host kiosk settings panels under /devices"`.

### Task 2: Reasons move into «Выбытие» with tab navigation

**Files:**

- Create: `apps/admin/src/pages/pickup/PickupViewNav.tsx`
- Move: `apps/admin/src/pages/kiosks/ReasonsPage.tsx` → `apps/admin/src/pages/pickup/ReasonsPage.tsx` (imports become `../kiosks/…` for api/css helpers)
- Modify: `apps/admin/src/pages/pickup/index.tsx`, `apps/admin/src/pages/pickup/Rejections.tsx` (render the nav)
- Modify: `apps/admin/src/app.tsx` (route `pickup/reasons` before `pickup/:id`; drop `kiosks/reasons` in Task 3)
- Modify: `apps/admin/src/i18n/ru.json`, `en.json` (`pages.pickup.views.*`)
- Test: `apps/admin/test/kiosk-reasons.test.tsx` (retarget to `/pickup/reasons`), `apps/admin/test/pickup.test.tsx` (nav presence)

**Interfaces:**

- Produces: `PickupViewNav` — `(props: { active: "orders" | "rejections" | "reasons" }) => ReactElement`, renders `<nav aria-label={t("pages.pickup.views.label")}>` with three `NavLink`s to `/pickup`, `/pickup/rejections`, `/pickup/reasons`. `ReasonsPage` no longer wraps itself in `KiosksLayout`; it wraps content in `AdminPage` + own `PageHeader` (`pages.kiosks.reasons.title`) + `PickupViewNav`.

- [ ] **Step 1: Failing test** — in `pickup.test.tsx` assert the orders page renders links «Заявки», «Отклонённые сканы», «Причины» pointing to `/pickup`, `/pickup/rejections`, `/pickup/reasons`. Expect FAIL.
- [ ] **Step 2: Implement `PickupViewNav`:**

```tsx
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router";

export type PickupViewId = "orders" | "rejections" | "reasons";

/** Tab strip shared by the «Выбытие» views (orders, rejected scans, reasons). */
export function PickupViewNav(): ReactElement {
  const { t } = useTranslation();
  return (
    <nav className="mk-kiosks-view-nav" aria-label={t("pages.pickup.views.label")}>
      <NavLink end to="/pickup">
        {t("pages.pickup.views.orders")}
      </NavLink>
      <NavLink to="/pickup/rejections">{t("pages.pickup.views.rejections")}</NavLink>
      <NavLink to="/pickup/reasons">{t("pages.pickup.views.reasons")}</NavLink>
    </nav>
  );
}
```

(reuses the existing `mk-kiosks-view-nav` styles from `kiosks.css`; import that css or move the block into a pickup css file — follow whichever the move in Step 3 makes cleaner). i18n:

```json
"views": { "label": "Разделы выбытия", "orders": "Заявки", "rejections": "Отклонённые сканы", "reasons": "Причины" }
```

en: `{ "label": "Disposal views", "orders": "Orders", "rejections": "Rejected scans", "reasons": "Reasons" }`. Render `<PickupViewNav />` right under the `PageHeader` in `pickup/index.tsx` and `Rejections.tsx`.

- [ ] **Step 3: Move `ReasonsPage`** to `pages/pickup/ReasonsPage.tsx`; replace every `KiosksLayout` wrapper with `<AdminPage className="mk-kiosks-page"><PageHeader title={t("pages.kiosks.reasons.title")} /><PickupViewNav />…</AdminPage>`; drop the `onNavigate`/`navigate` plumbing that switched between `/kiosks` views (the editor's `{ kind: "navigate" }` state entries now target `/pickup` | `/pickup/reasons` or are removed if only used for the old tabs). Update `app.tsx`: add `pickup/reasons` route (element `ReasonsPage`, `OPERATIONS_READ`) **above** `pickup/:id`; point the old `kiosks/reasons` route at a `<Navigate to="/pickup/reasons" replace />` for now.
- [ ] **Step 4: Retarget `kiosk-reasons.test.tsx`** to mount `/pickup/reasons`. Run: `pnpm --filter @markiro/admin test` — expect PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(admin): move disposal reasons under /pickup with view tabs"`.

### Task 3: Retire the «Киоски» section

**Files:**

- Modify: `apps/admin/src/app.tsx` (replace `/kiosks` subtree with redirects)
- Modify: `apps/admin/src/layout/AppShell.tsx` (drop `nav.kiosks` entry)
- Modify: `apps/admin/src/pages/kiosks/KioskPanelRoute.tsx` (add archive action to edit panel)
- Delete: `apps/admin/src/pages/kiosks/index.tsx`, `apps/admin/src/pages/kiosks/KiosksLayout.tsx`
- Modify: `apps/admin/src/i18n/ru.json`, `en.json` (drop `nav.kiosks`, list-only strings: `pages.kiosks.filters.*`, `resultCount`, `filteredEmpty*`, `emptyTitle`, `emptyHint`, `views.*`, `table.*`; **keep** `states.*`, `form.*`, `products.*`, `reasons.*`, `pairing.*`, `archive*`, `toasts.*`)
- Test: `apps/admin/test/shell-layout.test.tsx`, delete `apps/admin/test/kiosks.test.tsx` list cases (fold archive coverage into a panel test), retarget `kiosks-routing.test.tsx` redirect cases

**Interfaces:**

- Consumes: `useArchiveKiosk` from `pages/kiosks/api.ts`.
- Produces: edit panel footer gains a destructive «Архивировать» button (visible when `kiosk.status === "active"`; panel already renders only for `OPERATIONS_WRITE`) opening the existing archive `ConfirmDialog` flow (moved from the deleted list's `AuthorizedKioskRowActions`); on success: toast `pages.kiosks.toasts.archiveSuccess`, close panel.

- [ ] **Step 1: Failing tests** — shell-layout: «Киоски» absent from sidebar; routing: `/kiosks` redirects to `/devices?type=kiosk`, `/kiosks/reasons` → `/pickup/reasons`, `/kiosks/:id/edit` → `/devices/kiosks/:id/edit`; panel test: archive button archives from the edit panel. Expect FAIL.
- [ ] **Step 2: Redirect routes** replacing the `/kiosks` subtree in `app.tsx`:

```tsx
<Route path="kiosks">
  <Route index element={<Navigate to="/devices?type=kiosk" replace />} />
  <Route path="reasons" element={<Navigate to="/pickup/reasons" replace />} />
  <Route path="new" element={<Navigate to="/devices/kiosks/new" replace />} />
  <Route path=":kioskId/edit" element={<KioskPathRedirect suffix="edit" />} />
  <Route path=":kioskId/pair" element={<KioskPathRedirect suffix="pair" />} />
</Route>
```

with a tiny local helper in `app.tsx`:

```tsx
function KioskPathRedirect({ suffix }: { suffix: "edit" | "pair" }) {
  const { kioskId } = useParams();
  return <Navigate to={`/devices/kiosks/${kioskId}/${suffix}`} replace />;
}
```

- [ ] **Step 3: Archive in the edit panel.** Port the `ConfirmDialog` + `useArchiveKiosk` flow from the deleted `AuthorizedKioskRowActions` into `KioskEditPanelContent`: a `variant="destructive"` footer button before «Отмена», state `archiving`/`archiveError`, on success `toast(...archiveSuccess)` then `guard.finish()`.
- [ ] **Step 4: Delete** `pages/kiosks/index.tsx`, `KiosksLayout.tsx`; remove the `nav.kiosks` AppShell entry and pruned i18n keys; fix straggler imports (`kiosks.css` import moves into `KioskPanelRoute.tsx` if it was only loaded by the list).
- [ ] **Step 5: Update/trim tests**, run full suite: `pnpm --filter @markiro/admin test` — expect PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(admin): retire Kiosks section in favor of Devices and Disposal"`.

### Task 4: Final verification and docs

**Files:**

- Modify: `docs/working-map.md` (if it names the «Киоски» admin section), `docs/architecture.md` (only if it lists admin sidebar sections)

- [ ] **Step 1:** `pnpm --filter @markiro/admin lint && pnpm --filter @markiro/admin typecheck && pnpm --filter @markiro/admin test` — expect all PASS.
- [ ] **Step 2:** grep docs for the retired section (`rg "Киоски" docs/working-map.md docs/architecture.md`) and update mentions of the admin nav layout.
- [ ] **Step 3: Commit** — `git commit -m "docs: reflect devices/kiosks merge"`.
