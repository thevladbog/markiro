# Catalog Version Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add understandable catalog version cloning, explicit add-on effects, standard/custom units, included VAT editing, and safe visible drawers to SaaS-admin.

**Architecture:** Keep the existing platform catalog API and transactional version allocator authoritative. Extract small controlled form components for units, VAT, and add-on effects; reuse them in create and draft flows. Adapt the existing `@markiro/ui` `SidePanel` and navigation guard instead of building another overlay implementation.

**Tech Stack:** React 19, TypeScript, TanStack Query, React Hook Form, Zod, i18next, `@markiro/ui`, Vitest, Testing Library.

## Global Constraints

- Published and retired catalog versions remain immutable.
- `POST /platform/catalog/items/:code/versions` remains the only version-creation endpoint and allocates the next number under the existing database lock.
- Plans and add-ons remain recurring; services remain one-time.
- Add-ons require one through seven unique effects and may combine quota increments with feature enablement.
- Arbitrary legacy unit strings remain readable and editable through `other`; no migration is added.
- VAT is stored as integer basis points, `null` means without VAT, and new non-null values always set `vatIncluded: true`.
- The drawer must work at desktop and 390 px without page-level horizontal overflow.
- All behavior changes follow RED → GREEN TDD and preserve support-role financial redaction.

---

## File Structure

- Create `apps/saas-admin/src/pages/catalog/CatalogUnitField.tsx`: kind-aware standard/custom unit selector.
- Create `apps/saas-admin/src/pages/catalog/CatalogVatField.tsx`: VAT preset/custom selector and basis-point conversion helpers.
- Create `apps/saas-admin/src/pages/catalog/AddonEffectsEditor.tsx`: controlled effect rows shared by create and draft forms.
- Create `apps/saas-admin/src/pages/catalog/CatalogDrawer.tsx`: thin `SidePanel` adapter that routes dismissals through the navigation guard.
- Modify `apps/saas-admin/src/pages/catalog/CatalogCreatePanel.tsx`: complete visible create form using the shared fields.
- Modify `apps/saas-admin/src/pages/catalog/CatalogVersionPanel.tsx`: shared fields, exact VAT details, dirty-state guard, and clone action.
- Modify `apps/saas-admin/src/pages/catalog/CatalogPage.tsx`: protected panel switching and clone-result selection.
- Modify `apps/saas-admin/src/pages/catalog/api.ts`: exact reusable input type/helper surface only; no endpoint change.
- Modify `apps/saas-admin/src/i18n/ru.json` and `apps/saas-admin/src/i18n/en.json`: all new labels, units, VAT, clone, and discard messages.
- Modify `apps/saas-admin/src/global.css`: catalog form layout only; remove the temporary standalone fixed-panel rules after `SidePanel` migration.
- Modify `apps/saas-admin/test/catalog.test.tsx`: behavioral coverage for every requested flow.
- Modify `apps/saas-admin/test/render.tsx`: request recorder support for multiple versions of one item and exact clone payload inspection.

---

### Task 1: Standard/custom unit and VAT fields

**Files:**
- Create: `apps/saas-admin/src/pages/catalog/CatalogUnitField.tsx`
- Create: `apps/saas-admin/src/pages/catalog/CatalogVatField.tsx`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Test: `apps/saas-admin/test/catalog.test.tsx`

**Interfaces:**
- Produces: `CatalogUnitField({ kind, value, onChange, error? })` where `kind` is `CatalogVersionDto["kind"]` and `onChange(unit: string): void` always receives the actual API value.
- Produces: `CatalogVatField({ value, onChange, error? })` where `value` is `number | null` basis points and `onChange(rate: number | null): void` emits exact basis points.
- Produces: `formatVat(rateBps: number | null, included: boolean, t): string` for read-only details.

- [ ] **Step 1: Add failing unit and VAT tests**

Add tests that open create forms for plans and services, select standard values, select `Другое`, enter an exact custom unit, select `Другая ставка`, enter `12.34`, submit, and inspect the recorded request:

```tsx
await user.click(screen.getByRole("button", { name: "Создать позицию" }));
await user.click(screen.getByLabelText("Единица учёта"));
await user.click(screen.getByRole("option", { name: "Другое" }));
await user.type(screen.getByLabelText("Другая единица"), "license");
await user.click(screen.getByLabelText("НДС"));
await user.click(screen.getByRole("option", { name: "Другая ставка" }));
await user.type(screen.getByLabelText("Ставка НДС, %"), "12.34");
expect(api.createCalls()[0]?.body).toMatchObject({
  unit: "license",
  vatRateBps: 1234,
  vatIncluded: true,
});
```

Also assert `Без НДС` sends `{ vatRateBps: null, vatIncluded: false }`, and that an existing unknown unit opens as `Другое` without changing its value.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm --filter @markiro/saas-admin exec vitest run test/catalog.test.tsx -t "unit|VAT"
```

Expected: failures because the standard/custom selectors and visible VAT fields do not exist.

- [ ] **Step 3: Implement `CatalogUnitField`**

Use `Select` and `Input` from `@markiro/ui`. Keep these exact stored values:

```ts
const RECURRING_UNITS = ["month", "year"] as const;
const SERVICE_UNITS = [
  "unit",
  "hour",
  "person",
  "person_day",
  "day",
  "project",
  "session",
  "package",
] as const;
const OTHER = "__other__";
```

Derive the selected option from the actual value. Selecting a preset immediately emits it; selecting `OTHER` preserves an existing custom value or emits an empty string and reveals the required text input.

- [ ] **Step 4: Implement `CatalogVatField`**

Use preset basis points `[null, 0, 500, 700, 1000, 2000, 2200]`. Store the select value as `none`, the decimal basis-point string, or `custom`. Validate custom input with `/^(?:100(?:\.0{1,2})?|\d{1,2}(?:\.\d{1,2})?)$/` and convert using `Math.round(Number(percent) * 100)`.

Render the persistent hint `НДС включён в указанную цену` for non-null rates and `Без НДС` for `null`.

- [ ] **Step 5: Add RU/EN copy**

Add `catalog.units.*`, `catalog.vat.*`, `catalog.validation.unit`, and `catalog.validation.vat` keys. Labels must include `month`, `year`, `unit`, `hour`, `person`, `person_day`, `day`, `project`, `session`, `package`, `other`, `without`, and `customRate`.

- [ ] **Step 6: Run focused tests and static checks**

```bash
pnpm --filter @markiro/saas-admin exec vitest run test/catalog.test.tsx -t "unit|VAT"
pnpm --filter @markiro/saas-admin typecheck
pnpm --filter @markiro/saas-admin lint
```

Expected: focused tests and both static checks pass.

- [ ] **Step 7: Commit Task 1**

```bash
git add apps/saas-admin/src/pages/catalog/CatalogUnitField.tsx apps/saas-admin/src/pages/catalog/CatalogVatField.tsx apps/saas-admin/src/i18n/ru.json apps/saas-admin/src/i18n/en.json apps/saas-admin/test/catalog.test.tsx
git commit -m "feat(saas-admin): add catalog unit and VAT fields"
```

---

### Task 2: Explicit shared add-on effect editor

**Files:**
- Create: `apps/saas-admin/src/pages/catalog/AddonEffectsEditor.tsx`
- Modify: `apps/saas-admin/src/pages/catalog/CatalogCreatePanel.tsx`
- Modify: `apps/saas-admin/src/pages/catalog/CatalogVersionPanel.tsx`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Test: `apps/saas-admin/test/catalog.test.tsx`

**Interfaces:**
- Consumes: `AddonEffect` from `api.ts` and the existing effect translation keys.
- Produces: `EditableAddonEffect = { rowId: string; key: AddonEffect["key"]; value: string }`.
- Produces: `AddonEffectsEditor({ effects, onChange, errors?, disabled? })` with controlled immutable updates.
- Produces: `toAddonEffects(editable): AddonEffect[]` and `fromAddonEffects(effects): EditableAddonEffect[]` pure helpers.

- [ ] **Step 1: Add failing creation tests**

Open the add-on tab and create form. Assert the first visible row is `Станции` with value `1`, change it to `Киоски` and `3`, add `Публичный API`, and submit:

```tsx
expect(screen.getByRole("group", { name: "Что расширяет дополнение" })).toBeDefined();
await user.selectOptions(screen.getByLabelText("Тип эффекта 1"), "kiosks");
await user.clear(screen.getByLabelText("Прибавка к квоте 1"));
await user.type(screen.getByLabelText("Прибавка к квоте 1"), "3");
await user.click(screen.getByRole("button", { name: "Добавить эффект" }));
await user.selectOptions(screen.getByLabelText("Тип эффекта 2"), "publicApi");
expect(api.createCalls()[0]?.body.addon.effects).toEqual([
  { key: "kiosks", quotaIncrement: 3 },
  { key: "publicApi", featureEnabled: true },
]);
```

Add rejection assertions for zero, duplicate keys, empty effect list, and more than seven rows. Assert no request is recorded for invalid input.

- [ ] **Step 2: Run the effect tests and verify RED**

```bash
pnpm --filter @markiro/saas-admin exec vitest run test/catalog.test.tsx -t "add-on effect|hidden default"
```

Expected: creation-form assertions fail because the current form silently posts `stations +1`.

- [ ] **Step 3: Implement the controlled editor and pure conversion helpers**

Render every effect with the themed `Select`, a numeric `Input` only for quota keys, a visible enabled status for feature keys, and accessible add/remove buttons. Preserve the exact key order. Generate row IDs in the parent, never from array index alone.

- [ ] **Step 4: Replace the hidden create payload**

Initialize creation state with one visible row:

```ts
[{ rowId: crypto.randomUUID(), key: "stations", value: "1" }]
```

Build `addon.effects` only through `toAddonEffects`. Block submission when conversion validation reports a missing, duplicate, zero, negative, fractional, or greater-than-`2147483647` increment.

- [ ] **Step 5: Reuse the editor in draft versions**

Keep React Hook Form authoritative by passing watched values and `setValue("addonEffects", next, { shouldDirty: true, shouldValidate: true })`. Remove the duplicated native-select row markup from `CatalogVersionPanel`.

- [ ] **Step 6: Run focused and existing catalog tests**

```bash
pnpm --filter @markiro/saas-admin exec vitest run test/catalog.test.tsx -t "add-on|effect"
pnpm --filter @markiro/saas-admin exec vitest run test/catalog.test.tsx
```

Expected: all effect tests and the complete catalog file pass.

- [ ] **Step 7: Commit Task 2**

```bash
git add apps/saas-admin/src/pages/catalog/AddonEffectsEditor.tsx apps/saas-admin/src/pages/catalog/CatalogCreatePanel.tsx apps/saas-admin/src/pages/catalog/CatalogVersionPanel.tsx apps/saas-admin/src/i18n/ru.json apps/saas-admin/src/i18n/en.json apps/saas-admin/test/catalog.test.tsx
git commit -m "feat(saas-admin): expose add-on entitlement effects"
```

---

### Task 3: Complete create and draft commercial terms

**Files:**
- Modify: `apps/saas-admin/src/pages/catalog/CatalogCreatePanel.tsx`
- Modify: `apps/saas-admin/src/pages/catalog/CatalogVersionPanel.tsx`
- Modify: `apps/saas-admin/src/pages/catalog/api.ts`
- Modify: `apps/saas-admin/src/global.css`
- Test: `apps/saas-admin/test/catalog.test.tsx`
- Test: `apps/saas-admin/test/render.tsx`

**Interfaces:**
- Consumes: `CatalogUnitField`, `CatalogVatField`, and `AddonEffectsEditor` from Tasks 1–2.
- Produces: complete `CatalogCreateInput` values for plan, add-on, and service creation.
- Produces: exact draft patches containing unit and VAT only when changed.

- [ ] **Step 1: Extend the API recorder and write failing exact-payload tests**

Expose `createCalls(): Array<{ itemCode: string; body: CatalogCreateInput }>` from `installCatalogApi`. Assert plan creation includes all quotas/features, service creation contains `{ service: {} }`, and both contain the selected unit, `vatRateBps`, and `vatIncluded`.

- [ ] **Step 2: Run the create/draft tests and verify RED**

```bash
pnpm --filter @markiro/saas-admin exec vitest run test/catalog.test.tsx -t "commercial terms|complete create"
```

Expected: VAT and several plan/add-on fields are absent from the current UI request path.

- [ ] **Step 3: Replace ad-hoc create state with a complete validated form**

Use React Hook Form plus a Zod schema matching the existing backend discriminated union. Include descriptions, unit, price, VAT, plan quotas, plan features, demo duration, and add-on effects. Set defaults:

```ts
{
  billingMode: kind === "service" ? "one_time" : "recurring",
  billingPeriod: kind === "service" ? null : "month",
  unit: kind === "service" ? "project" : "month",
  unitPrice: "0.00",
  vatRateBps: 2200,
  vatIncluded: true,
}
```

- [ ] **Step 4: Add the same unit/VAT controls to editable drafts and read-only details**

Drafts use the controlled components through `form.watch` and `form.setValue(..., { shouldDirty: true, shouldValidate: true })`. Published/retired financial details show `formatVat(item.vatRateBps ?? null, item.vatIncluded ?? false, t)`. Support users continue to receive and render no financial fields.

- [ ] **Step 5: Run catalog tests and static checks**

```bash
pnpm --filter @markiro/saas-admin exec vitest run test/catalog.test.tsx
pnpm --filter @markiro/saas-admin typecheck
pnpm --filter @markiro/saas-admin lint
```

Expected: the catalog test file, typecheck, and lint pass.

- [ ] **Step 6: Commit Task 3**

```bash
git add apps/saas-admin/src/pages/catalog/CatalogCreatePanel.tsx apps/saas-admin/src/pages/catalog/CatalogVersionPanel.tsx apps/saas-admin/src/pages/catalog/api.ts apps/saas-admin/src/global.css apps/saas-admin/test/catalog.test.tsx apps/saas-admin/test/render.tsx
git commit -m "feat(saas-admin): edit complete catalog terms"
```

---

### Task 4: Clone an immutable version into the next draft

**Files:**
- Modify: `apps/saas-admin/src/pages/catalog/api.ts`
- Modify: `apps/saas-admin/src/pages/catalog/CatalogVersionPanel.tsx`
- Modify: `apps/saas-admin/src/pages/catalog/CatalogPage.tsx`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Test: `apps/saas-admin/test/catalog.test.tsx`
- Test: `apps/saas-admin/test/render.tsx`

**Interfaces:**
- Produces: `catalogVersionToCreateInput(item: CatalogVersionDto): CatalogCreateInput` pure function that copies all writable fields without IDs, status, version number, or publication metadata.
- Produces: `onVersionCreated(created: CatalogVersionDto): void` from the panel to `CatalogPage`.

- [ ] **Step 1: Write failing plan/add-on/service clone tests**

For each kind, open an immutable version, click `Новая версия`, and assert one POST to the same `catalogItemCode`. The add-on expectation must pin the complete effect array; the plan expectation must pin every quota/feature; the service expectation must pin `{ service: {} }`. All expectations pin unit, price, VAT, descriptions, billing mode, and billing period.

Then assert the returned version has `status: "draft"`, appears in the current catalog page, and opens as `Версия 2 · <name>` with editable fields.

- [ ] **Step 2: Add failure and double-click RED tests**

Configure the request recorder to delay or reject the clone call. Use two rapid clicks and assert one request. On rejection, assert the source version remains open, no draft enters the cache, and `Не удалось создать новую версию` appears.

- [ ] **Step 3: Run clone tests and verify RED**

```bash
pnpm --filter @markiro/saas-admin exec vitest run test/catalog.test.tsx -t "Новая версия|clone"
```

Expected: the button and conversion helper do not exist.

- [ ] **Step 4: Implement exact conversion and mutation**

Implement `catalogVersionToCreateInput` with a discriminated switch on `item.kind`. Clone nested plan/add-on/service values using new objects and arrays. Throw a stable local error if the kind-specific payload is missing instead of sending an incomplete request.

In `CatalogVersionPanel`, show `Новая версия` only when `canWrite && item.status !== "draft"`. Use `useMutation`, disable the action while pending, and call:

```ts
createCatalogVersion(item.catalogItemCode, catalogVersionToCreateInput(item))
```

On success, merge by returned `id` into `['platform', 'catalog']` and call `onVersionCreated(created)` so `CatalogPage` selects it.

- [ ] **Step 5: Run focused/full catalog tests and static checks**

```bash
pnpm --filter @markiro/saas-admin exec vitest run test/catalog.test.tsx -t "Новая версия|clone"
pnpm --filter @markiro/saas-admin exec vitest run test/catalog.test.tsx
pnpm --filter @markiro/saas-admin typecheck
pnpm --filter @markiro/saas-admin lint
```

Expected: all commands pass.

- [ ] **Step 6: Commit Task 4**

```bash
git add apps/saas-admin/src/pages/catalog/api.ts apps/saas-admin/src/pages/catalog/CatalogVersionPanel.tsx apps/saas-admin/src/pages/catalog/CatalogPage.tsx apps/saas-admin/src/i18n/ru.json apps/saas-admin/src/i18n/en.json apps/saas-admin/test/catalog.test.tsx apps/saas-admin/test/render.tsx
git commit -m "feat(saas-admin): clone catalog versions into drafts"
```

---

### Task 5: Safe drawer dismissal and unsaved-change protection

**Files:**
- Create: `apps/saas-admin/src/pages/catalog/CatalogDrawer.tsx`
- Modify: `apps/saas-admin/src/pages/catalog/CatalogCreatePanel.tsx`
- Modify: `apps/saas-admin/src/pages/catalog/CatalogVersionPanel.tsx`
- Modify: `apps/saas-admin/src/pages/catalog/CatalogPage.tsx`
- Modify: `apps/saas-admin/src/global.css`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Test: `apps/saas-admin/test/catalog.test.tsx`

**Interfaces:**
- Consumes: `SidePanel` and `OverlayDismissReason` from `@markiro/ui`.
- Consumes: `useNavigationGuard(dirty, busy)` from `layout/NavigationGuard.tsx`.
- Produces: `CatalogDrawer({ title, description?, dirty, busy, onClose, children, footer, status })`.
- Produces: `requestClose(action)` callbacks from create/draft panels for backdrop, Escape, buttons, tab switches, row switches, and route navigation.

- [ ] **Step 1: Write failing drawer behavior tests**

Cover these exact flows:

```tsx
await user.click(screen.getByRole("button", { name: "Создать позицию" }));
expect(screen.getByRole("dialog", { name: "Новая позиция каталога" })).toBeDefined();
await user.click(document.querySelector(".mk-side-panel__scrim")!);
expect(screen.queryByRole("dialog", { name: "Новая позиция каталога" })).toBeNull();
```

Repeat after typing a name and assert the shared discard confirmation opens; cancelling keeps the drawer, confirming closes it. Press Escape for clean and dirty forms. Assert focus enters the first editable field and returns to `Создать позицию`. Assert tab/row navigation uses the same confirmation when dirty.

- [ ] **Step 2: Run drawer tests and verify RED**

```bash
pnpm --filter @markiro/saas-admin exec vitest run test/catalog.test.tsx -t "drawer|unsaved|backdrop|Escape|focus"
```

Expected: failures because catalog panels are plain fixed sections without a scrim or navigation guard registration.

- [ ] **Step 3: Implement `CatalogDrawer` as a thin SidePanel adapter**

Use `SidePanel` with `open`, `size="complex"`, and `busy`. Register `dirty` and `busy` with `useNavigationGuard`. Route every `onClose(reason)` through `requestProtectedAction(onClose)`. Mark the explicit cancel button with `data-overlay-cancel` only when it is the intended initial safe action.

- [ ] **Step 4: Migrate both panels and protect page-level switches**

Expose `dirty` and `busy` from the create/draft form state. Read-only panels pass `dirty={false}`. In `CatalogPage`, tab and row changes call the active panel's protected-close callback before mutating `activeKind`, `selectedId`, or `creating`.

Remove the standalone `.version-panel { position: fixed; ... }` overlay rules. Keep only catalog-specific inner grid/fieldset styles under a catalog drawer class so `SidePanel` owns stacking, scroll lock, backdrop, focus trap, and focus return.

- [ ] **Step 5: Run drawer and navigation regressions**

```bash
pnpm --filter @markiro/saas-admin exec vitest run test/catalog.test.tsx -t "drawer|unsaved|backdrop|Escape|focus"
pnpm --filter @markiro/saas-admin exec vitest run test/navigation-guard.test.tsx test/catalog.test.tsx
```

Expected: all drawer, guard, and catalog tests pass without console warnings.

- [ ] **Step 6: Commit Task 5**

```bash
git add apps/saas-admin/src/pages/catalog/CatalogDrawer.tsx apps/saas-admin/src/pages/catalog/CatalogCreatePanel.tsx apps/saas-admin/src/pages/catalog/CatalogVersionPanel.tsx apps/saas-admin/src/pages/catalog/CatalogPage.tsx apps/saas-admin/src/global.css apps/saas-admin/src/i18n/ru.json apps/saas-admin/src/i18n/en.json apps/saas-admin/test/catalog.test.tsx
git commit -m "fix(saas-admin): protect catalog drawer changes"
```

---

### Task 6: Final regression and live browser acceptance

**Files:**
- Modify if evidence requires a scoped fix: files from Tasks 1–5 only.
- Update: `docs/superpowers/specs/2026-08-11-catalog-version-editor-design.md` status to `Implemented` only after all gates pass.

**Interfaces:**
- Consumes: the completed catalog editor and the already running local API/Vite stack.
- Produces: a clean, committed branch with exact automated and browser evidence.

- [ ] **Step 1: Run full package gates**

```bash
pnpm --filter @markiro/ui build
pnpm --filter @markiro/ui test
pnpm --filter @markiro/ui typecheck
pnpm --filter @markiro/ui lint
pnpm --filter @markiro/saas-admin test
pnpm --filter @markiro/saas-admin typecheck
pnpm --filter @markiro/saas-admin lint
pnpm --filter @markiro/saas-admin build
pnpm format:check
git diff --check
```

Expected: zero failures and no unintended skips in UI/SaaS-admin packages.

- [ ] **Step 2: Verify the real desktop catalog in the in-app browser**

At `http://127.0.0.1:5473/catalog`, use the authenticated local session and verify:

- a published plan clones into the next draft and opens immediately;
- a published add-on clone preserves all effects;
- a service clone preserves its unit and VAT;
- standard and custom unit/VAT controls submit exact values;
- backdrop and Escape close clean drawers;
- dirty drawers require confirmation;
- the document and drawer have no horizontal overflow;
- console contains no errors or warnings caused by the flow.

- [ ] **Step 3: Verify 390 × 844 layout and keyboard behavior**

Resize the same contract-shaped page to 390 × 844. Assert drawer width does not exceed the viewport, all visible targets are at least 44 px high, Tab remains inside the drawer, Escape follows dirty-state rules, and closing restores focus to the trigger.

- [ ] **Step 4: Update the spec status and commit final evidence-only adjustments**

Change the design status from `Approved` to `Implemented` only after Steps 1–3 pass. If browser evidence required a product fix, establish a focused RED before editing and rerun all affected gates.

```bash
git add docs/superpowers/specs/2026-08-11-catalog-version-editor-design.md
git commit -m "docs(saas-admin): mark catalog editor implemented"
```

- [ ] **Step 5: Review and push**

```bash
git status --short
git log --oneline -8
git push origin codex/saas-catalog-subscriptions
```

Expected: tracked worktree clean and the remote branch contains every scoped commit.
