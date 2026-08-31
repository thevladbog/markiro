# Category Attributes Admin Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explainable product readiness, confirmed category binding, schema-driven pilot fields, safe category changes, and National Catalog import review to the tenant product card.

**Architecture:** Regulatory UI is isolated in focused catalog subcomponents rather than expanding `ProductForm.tsx`. The edit route loads the profile/readiness alongside the product; dynamic controls render only supported domain value types; every mutation carries the profile revision and refreshes product/profile/readiness queries.

**Tech Stack:** React 19, React Hook Form, Zod 4, TanStack Query 5, `@markiro/ui`, i18next, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-31-category-product-attributes-national-catalog-design.md`

## Global Constraints

- Requires completed foundation and National Catalog read-only plans.
- Regulatory editing is available after a product exists; create mode remains the compact base-product form and routes the user to edit after creation.
- Remove universal EGAIS input from the base form; retain shelf life as a production field until its compatibility migration is complete.
- Show source as Markiro, 1C, National Catalog, or migration; never show raw attribute IDs in the primary form.
- Readiness uses text/reasons as well as color and exposes production, code ordering, circulation, and EGAIS separately.
- Conditional fields are present in the accessibility tree only when applicable; hidden values are not silently deleted.
- Import and category changes always show a review step; no confirm-on-open or automatic apply.
- Add all copy to both Russian and English locale files.

---

## File Structure

| File                                                                      | Responsibility                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `apps/admin/src/pages/catalog/regulatory/api.ts`                          | Profile, readiness, schema, proposal, and National Catalog hooks |
| `apps/admin/src/pages/catalog/regulatory/ProductReadinessPanel.tsx`       | Four readiness cards and reason drill-downs                      |
| `apps/admin/src/pages/catalog/regulatory/CategoryBindingSection.tsx`      | Category/TN VED/OKPD2/source/freshness summary and actions       |
| `apps/admin/src/pages/catalog/regulatory/CategoryAttributesForm.tsx`      | Supported schema-driven fields and manual save                   |
| `apps/admin/src/pages/catalog/regulatory/EgaisCodesEditor.tsx`            | Multiple 19-digit codes and primary selection                    |
| `apps/admin/src/pages/catalog/regulatory/CategoryChangeDialog.tsx`        | Transfer/conflict/inapplicable preview and confirmation          |
| `apps/admin/src/pages/catalog/regulatory/NationalCatalogImportDialog.tsx` | Lookup/card selection/diff/per-field confirmation                |
| `apps/admin/src/pages/catalog/regulatory/ProductRegulatorySections.tsx`   | Data/error/loading orchestration for edit mode                   |

### Task 1: Typed API hooks and cache boundaries

**Files:**

- Create: `apps/admin/src/pages/catalog/regulatory/api.ts`
- Test: `apps/admin/test/catalog-regulatory-api.test.tsx`

**Interfaces:**

- Produces `useProductRegulatoryProfile`, `useRegulatoryCategoryOptions`, `useProductReadiness`, `useUpdateRegulatoryAttributes`, `useUpdateEgaisCodes`, `useCategoryChangePreview`, `useApplyRegulatoryProposal`, `useNationalCatalogLookup`, and `useNationalCatalogImportPreview`.

- [ ] **Step 1: Write failing request/cache tests**

Assert exact route/body for a manual attribute mutation and that success invalidates:

```ts
export const regulatoryProfileKey = (productId: string) =>
  ["products", productId, "regulatory-profile"] as const;
export const productReadinessKey = (productId: string) =>
  ["products", productId, "readiness"] as const;
```

Mutation body must preserve the discriminated value and `baseRevision`; it must not send UI labels or source.

- [ ] **Step 2: Run and confirm missing module**

Run: `pnpm --filter @markiro/admin exec vitest run test/catalog-regulatory-api.test.tsx`

Expected: FAIL because the hooks do not exist.

- [ ] **Step 3: Implement DTOs and hooks**

Mirror the strict API response unions. Use `apiFetch`; on successful profile/EGAIS/proposal mutation invalidate profile, readiness, and `PRODUCTS_QUERY_KEY`. National Catalog lookup/preview mutations do not invalidate until apply.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @markiro/admin exec vitest run test/catalog-regulatory-api.test.tsx
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
git add apps/admin/src/pages/catalog/regulatory/api.ts apps/admin/test/catalog-regulatory-api.test.tsx
git commit -m "feat(admin): add regulatory product API hooks"
```

### Task 2: Readiness and category summary in the product panel

**Files:**

- Create: `apps/admin/src/pages/catalog/regulatory/ProductReadinessPanel.tsx`
- Create: `apps/admin/src/pages/catalog/regulatory/CategoryBindingSection.tsx`
- Create: `apps/admin/src/pages/catalog/regulatory/ProductRegulatorySections.tsx`
- Modify: `apps/admin/src/pages/catalog/ProductPanelRoute.tsx`
- Modify: `apps/admin/src/pages/catalog/ProductForm.tsx`
- Modify: `apps/admin/src/pages/catalog/catalog.css`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Test: `apps/admin/test/catalog-regulatory.test.tsx`

**Interfaces:**

- Produces the four approved product-card blocks in edit mode and action callbacks for Tasks 4–5.

- [ ] **Step 1: Write failing loading/error/readiness tests**

Render edit mode with mocked profile/readiness. Assert four named states, concrete missing-field reason, last successful National Catalog check, source label, retry on one failed regulatory request, and unchanged base product form availability.

- [ ] **Step 2: Run and confirm missing components**

Run: `pnpm --filter @markiro/admin exec vitest run test/catalog-regulatory.test.tsx`

Expected: FAIL on missing sections.

- [ ] **Step 3: Implement accessible readiness and summary**

Render a `<section aria-labelledby>` with one semantic list item per dimension. Map states to existing `@markiro/ui` badges/alerts, but always render localized state text. Reasons render as a list with localized stable-code mapping and attribute label from profile schema metadata.

Category summary shows category name, TN VED, OKPD2, source, confirmed time, last successful check, and pending update indicator. Buttons are ordinary semantic buttons: `Найти в НК`, `Проверить обновления`, and `Сменить категорию`.

- [ ] **Step 4: Integrate edit mode without making create wait**

Add an optional `supplementaryContent: ReactNode` prop to `ProductForm` and render it inside the `SidePanel` after the base product `</form>`, never nested inside that form. `EditProductPanel` passes `ProductRegulatorySections productId={product.id}`; create mode omits the prop and makes no regulatory requests. Regulatory request failure is isolated to its own alert/retry and does not replace the whole product side panel.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @markiro/admin exec vitest run test/catalog-regulatory.test.tsx test/catalog.test.tsx
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
git add apps/admin/src/pages/catalog apps/admin/src/i18n apps/admin/test/catalog-regulatory.test.tsx apps/admin/test/catalog.test.tsx
git commit -m "feat(admin): show product regulatory readiness"
```

### Task 3: Dynamic pilot fields and multi-code EGAIS editor

**Files:**

- Create: `apps/admin/src/pages/catalog/regulatory/CategoryAttributesForm.tsx`
- Create: `apps/admin/src/pages/catalog/regulatory/EgaisCodesEditor.tsx`
- Modify: `apps/admin/src/pages/catalog/regulatory/ProductRegulatorySections.tsx`
- Modify: `apps/admin/src/pages/catalog/ProductForm.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Test: `apps/admin/test/catalog-regulatory-fields.test.tsx`
- Modify: `apps/admin/test/catalog.test.tsx`

**Interfaces:**

- Produces controls for `string`, `string_list`, `decimal`, `boolean`, `date`, `enum`, and `enum_list`; EGAIS collection remains a dedicated typed editor.

- [ ] **Step 1: Write failing field/condition/source tests**

Assert required/recommended grouping, enum presets, decimal unit label, string-list add/remove, source badge, inline server error, and these triggers: sweetener name appears after `hasSweetener=true`; keg lifetime appears after keg package; veterinary branch appears after veterinary control; underground-water licence branch follows OKPD2/schema conditions. Toggle a trigger off and assert the hidden stored value is not included in the save mutation unless the user explicitly clears it.

- [ ] **Step 2: Write failing EGAIS tests**

Assert add/remove codes, 19-digit client validation, radio-style primary selection, no universal EGAIS field for non-beer/create base form, and a readiness refresh after save.

- [ ] **Step 3: Implement value-specific components**

Use a `switch (definition.valueType)` with exhaustive `never` checking. React Hook Form stores the same discriminated API values; no generic uncontrolled JSON editor exists. Use `isAttributeRequired` from `@markiro/domain` for visibility/required display, while the server remains authoritative.

Sort first by layer (`code_ordering`, `circulation`, optional), then schema order. Show source beside accepted current value, not beside an unsaved draft.

- [ ] **Step 4: Move EGAIS out of the universal product form**

Remove the `egaisCode` input and its submitted value from `ProductForm` while leaving API response compatibility in `api.ts`. Keep `shelfLifeDays` under production/aggregation. Existing edit of a beer product happens through `EgaisCodesEditor`.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/admin exec vitest run test/catalog-regulatory-fields.test.tsx test/catalog.test.tsx
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
git add apps/admin/src/pages/catalog apps/admin/src/i18n apps/admin/test/catalog-regulatory-fields.test.tsx apps/admin/test/catalog.test.tsx
git commit -m "feat(admin): render category-specific product fields"
```

### Task 4: Category-change review dialog

**Files:**

- Create: `apps/admin/src/pages/catalog/regulatory/CategoryChangeDialog.tsx`
- Modify: `apps/admin/src/pages/catalog/regulatory/ProductRegulatorySections.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Test: `apps/admin/test/catalog-category-change.test.tsx`

**Interfaces:**

- Consumes foundation category preview/apply hooks and produces no local merge logic.

- [ ] **Step 1: Write failing review/guard tests**

Assert searchable compatible category selection, ambiguity confirmation, grouped transferable/convertible/conflict/inapplicable rows, readiness-effect summary, disabled confirm for incompatible category, stale-preview recovery, cancel without mutation, and explicit final apply.

- [ ] **Step 2: Implement the dialog state machine**

Use states `selecting -> loading_preview -> reviewing -> applying -> done`, plus recoverable error. Confirm is enabled only in `reviewing`, after required ambiguity acknowledgement, and sends the persisted proposal ID. Closing at any earlier state never applies.

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @markiro/admin exec vitest run test/catalog-category-change.test.tsx
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
git add apps/admin/src/pages/catalog/regulatory apps/admin/src/i18n apps/admin/test/catalog-category-change.test.tsx
git commit -m "feat(admin): review product category changes"
```

### Task 5: National Catalog lookup and field-level import review

**Files:**

- Create: `apps/admin/src/pages/catalog/regulatory/NationalCatalogImportDialog.tsx`
- Modify: `apps/admin/src/pages/catalog/regulatory/ProductRegulatorySections.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Test: `apps/admin/test/catalog-national-catalog-import.test.tsx`

**Interfaces:**

- Consumes lookup/import-preview/generic-apply hooks; applies only user-selected diff entry IDs.

- [ ] **Step 1: Write failing outcome and diff tests**

Cover no card/manual fallback, multiple-card choice, role/token/rate-limit/unavailable messages, category mismatch, additions vs conflicts, conversion warning, per-field checkbox, accept-all-nonconflicting, stale apply, and successful refresh of profile/readiness.

- [ ] **Step 2: Implement explicit lookup/review/apply states**

Use `lookup -> choose_card -> loading_preview -> review -> applying -> result`. Default-select additions and exact mappings; leave conflicts unselected. Display `current -> proposed`, source `Национальный каталог`, card freshness, and mapping warning. Never render raw card JSON.

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @markiro/admin exec vitest run test/catalog-national-catalog-import.test.tsx
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
git add apps/admin/src/pages/catalog/regulatory apps/admin/src/i18n apps/admin/test/catalog-national-catalog-import.test.tsx
git commit -m "feat(admin): review National Catalog imports"
```

### Task 6: Admin completion gate

**Files:**

- Modify only scoped files required by failures caused by Tasks 1–5.

**Interfaces:**

- Produces the complete tenant-admin pilot experience.

- [ ] **Step 1: Run the complete admin gate**

```bash
pnpm --filter @markiro/domain build
pnpm --filter @markiro/ui build
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/admin build
pnpm format:check
git diff --check
```

Expected: all pass.

- [ ] **Step 2: Perform browser review**

With pilot fixtures, verify keyboard-only operation, focus return after dialogs, narrow/desktop side-panel layout, long Russian labels, conditional fields, error recovery, and no regulatory request in create mode. Record browser review separately from automated DOM tests.

- [ ] **Step 3: Commit scoped corrections only when needed**

Stage the exact corrected files by name and commit `fix(admin): close regulatory product UX gates`. If no correction was required, do not create an empty commit.
