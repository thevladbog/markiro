# Task 5 — remove native selects across SaaS-admin

## Result

SaaS-admin no longer contains author-created native `<select>` elements or `native` usages. Short enumerations use the shared Radix-backed `Select`; published catalog-version assignment uses the shared searchable `Combobox`. Labels, disabled states, current values, and role/subscription mutation payloads remain intact.

## Changed paths

- `apps/saas-admin/src/pages/team/TeamPage.tsx` — replaced both direct team role `<select>` controls with shared `Select` while preserving the invite role and exact `changePlatformRole(id, role)` value.
- `apps/saas-admin/src/pages/catalog/CatalogVatField.tsx` — moved VAT presets/custom choice to the Radix default.
- `apps/saas-admin/src/pages/catalog/CatalogUnitField.tsx` — moved unit/custom choice to the Radix default.
- `apps/saas-admin/src/pages/catalog/AddonEffectsEditor.tsx` — moved effect keys to the Radix default.
- `apps/saas-admin/src/pages/tenants/TenantsPage.tsx` — moved the lifecycle filter to the Radix default.
- `apps/saas-admin/src/pages/tenants/SubscriptionPanel.tsx` — moved operation kind and activation policy to the Radix default; replaced the potentially long published-version list with searchable `Combobox` options carrying localized labels, codes, and bilingual keywords.
- `apps/saas-admin/src/global.css` — removed obsolete `.native-field select` rules while retaining `.native-field` textarea/error styling.
- `apps/saas-admin/test/custom-controls.test.tsx` — added route-level keyboard/custom-control and exact mutation coverage.
- `apps/saas-admin/test/team.test.tsx` — added read-only team permission/disabled-control coverage.
- `apps/saas-admin/test/catalog.test.tsx` — replaced native `selectOptions` assumptions with visible Radix option interaction.
- `apps/saas-admin/test/tenants.test.tsx` — replaced native status-option assumptions with visible Radix option interaction.
- `apps/saas-admin/test/tenant-detail.test.tsx` — replaced native assignment-option assumptions with Radix/Combobox interaction and `aria-disabled` assertions.

## RED

Command:

```bash
CI=true pnpm --filter @markiro/saas-admin exec vitest run test/custom-controls.test.tsx
```

Result: exit 1; 4/4 tests failed for the intended missing behavior. Team rendered two native selects, catalog rendered two, tenant list rendered one, and subscription assignment did not expose the required searchable catalog-version combobox.

## GREEN and verification

Focused integration test:

```bash
CI=true pnpm --filter @markiro/saas-admin exec vitest run test/custom-controls.test.tsx
```

Result: exit 0; 1 file and 4 tests passed.

Required affected suites:

```bash
CI=true pnpm --filter @markiro/saas-admin exec vitest run test/team.test.tsx test/catalog.test.tsx test/tenants.test.tsx test/tenant-detail.test.tsx test/custom-controls.test.tsx
```

Result: exit 0; 5 files and 55 tests passed.

Compilation and static checks:

```bash
pnpm --filter @markiro/saas-admin typecheck
pnpm --filter @markiro/saas-admin lint
pnpm --filter @markiro/saas-admin build
git diff --check
rg -n '<select|<Select[^>]*native|native\s*$|native=' apps/saas-admin/src -g '*.tsx'
rg -n 'native-field select' apps/saas-admin/src/global.css
```

Results: all package commands and `git diff --check` exited 0. Both inventories returned no matches. Vite built 468 modules successfully.

## Self-review

- Confirmed every original value remains unchanged: `PlatformRole`, VAT basis-point sentinel values, unit/effect keys, lifecycle status strings, assignment kinds/policies, and catalog-version UUIDs.
- Confirmed team role mutation sends `{ role: "accountant" }` and assignment sends the exact catalog UUID and `activationPolicy: "immediate"` in route-level integration tests.
- Confirmed the support team control remains disabled and invite form remains hidden without `platformTeam.write`.
- Confirmed the disabled after-current policy is exposed through `aria-disabled="true"` in the Radix option.
- Confirmed no backend, API, database, schema, or generated source was changed.
- Reviewed the final diff for task-boundary violations and unrelated work; only the brief-listed SaaS-admin production/tests plus this report are included.

## Concern / external coverage

Radix Select intentionally mounts an `aria-hidden`, non-focusable native form proxy for browser form semantics when the control is inside a `<form>`. The integration assertion rejects all visible/author-facing native selects (`select:not([aria-hidden="true"])`), while the exact source inventory proves SaaS-admin authors render no `<select>` and pass no `native` prop. Removing Radix's internal proxy would require an out-of-scope shared-component fork and would conflict with using committed Radix Select defaults.

No manual browser visual check was run. Automated jsdom keyboard behavior, exact mutations, permissions/disabled states, typecheck, lint, and production compilation are covered.

## Commit

`refactor(saas-admin): replace native selects` (this report is included in the same commit; the final hash is reported in the task handoff).
