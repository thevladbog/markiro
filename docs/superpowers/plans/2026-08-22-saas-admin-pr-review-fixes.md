# SaaS Admin PR Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify the review feedback on PR #248, fix every issue that is still present with minimal changes, and publish the validated fixes to the existing branch.

**Architecture:** Keep authorization narrowing at the controller boundary, database normalization inside repository schemas, and queue composition inside the platform operations service. Preserve shared UI component ownership in `@markiro/ui`; keep application-specific localization and design-token usage in `apps/saas-admin`. Do not alter migration 0064 unless current schema cardinality or locking evidence supports the reviewer assumption.

**Tech Stack:** NestJS, Zod 4, Drizzle/PostgreSQL, React 19, React Router, react-i18next, Vitest, Testing Library, CSS design tokens.

**Spec:** External inline review pasted in the active Codex task; original product reference is `docs/design-briefs/06-saas-admin.md`.

## Global Constraints

- Preserve tenant isolation, platform capability boundaries, strict TypeScript, RU/EN behavior, and keyboard accessibility.
- Reuse `@markiro/ui` tokens and components; do not create a parallel token system.
- Write a focused failing test before each behavior change and run the narrowest relevant check after every fix.
- Preserve the overall `DECISION_QUEUE_LIMIT` of 25 and critical-before-warning-before-attention ordering.
- Keep migration history immutable once applied; migration 0064 is still confined to the open PR branch.

---

### Task 1: Harden platform operations boundaries

**Files:**

- Modify: `apps/api/src/modules/platform-operations/platform-operations.controller.ts`
- Modify: `apps/api/src/modules/platform-operations/platform-operations.service.ts`
- Modify: `apps/api/src/modules/billing-profiles/billing-profiles.service.ts`
- Test: `apps/api/test/platform-operations.e2e.test.ts`
- Test: `apps/api/test/platform-operations.service.test.ts`

**Interfaces:**

- Consumes: `RequestWithPlatformPrincipal`, `platformTimestampSchema`, and the three decision categories.
- Produces: explicit fail-closed principal narrowing, Date-normalized repository facts, typed Zod contact parsing, and a bounded representative decision queue.

- [ ] **Step 1: Write failing tests for a missing principal, Date-valued database rows, and queue category starvation**

```ts
await request(appWithoutPrincipal.getHttpServer())
  .get("/api/platform/operations/overview")
  .expect(401);

expect(await repository.subscriptionsEnding(now, end, 25)).toEqual([
  expect.objectContaining({ endsAt: "2026-08-26T08:00:00.000Z" }),
]);

expect(result.decisionQueue.map((item) => item.kind)).toContain("subscription_ending");
expect(result.decisionQueue.map((item) => item.kind)).toContain("billing_readiness");
expect(result.decisionQueue).toHaveLength(25);
```

- [ ] **Step 2: Run the focused API tests and confirm each assertion fails for the reviewed behavior**

Run: `pnpm --filter @markiro/api exec vitest run test/platform-operations.e2e.test.ts test/platform-operations.service.test.ts`

Expected: the missing-principal route does not return the explicit 401, Date rows fail schema parsing, and the 25 overdue rows starve later categories.

- [ ] **Step 3: Implement minimal boundary and queue fixes**

```ts
const principal = request.platformPrincipal;
if (!principal) throw new UnauthorizedException();

const databaseTimestampSchema = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  platformTimestampSchema,
);

function parseContactField<Output>(schema: ZodType<Output>, value: unknown): Output | null {
  const candidate = typeof value === "string" ? value.trim() : null;
  const parsed = schema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
```

Compose the queue by reserving one slot for every later non-empty category, then fill remaining capacity in critical, warning, attention order.

- [ ] **Step 4: Re-run focused tests, API typecheck, and lint**

Run: `pnpm --filter @markiro/api exec vitest run test/platform-operations.e2e.test.ts test/platform-operations.service.test.ts && pnpm --filter @markiro/api typecheck && pnpm --filter @markiro/api lint`

Expected: all commands pass.

### Task 2: Preserve shared UI semantics and tab ID types

**Files:**

- Modify: `packages/ui/src/components/DataTabs.tsx`
- Modify: `packages/ui/src/components/MetricStrip.tsx`
- Modify: `packages/ui/src/components.css`
- Modify: `apps/saas-admin/src/pages/catalog/CatalogPage.tsx`
- Test: `packages/ui/test/operational-components.test.tsx`

**Interfaces:**

- Produces: `DataTabs<Id extends string>` with `onChange(id: Id)` and valid `dl > div > dt + dd` metric markup.

- [ ] **Step 1: Add a runtime semantic test for MetricStrip and a compile-time catalog consumer expectation**

```ts
const metrics = container.querySelector(".mk-metric-strip__item");
expect(metrics?.children[0]?.tagName).toBe("DT");
expect(metrics?.children[1]?.tagName).toBe("DD");
expect(metrics?.querySelector("dd .mk-metric-strip__hint")).not.toBeNull();
```

The existing SaaS-admin typecheck must fail if `DataTabs` widens `CatalogKind` to arbitrary `string` after removing the cast.

- [ ] **Step 2: Run UI tests and SaaS-admin typecheck to observe the semantic failure and widened ID type**

Run: `pnpm --filter @markiro/ui exec vitest run test/operational-components.test.tsx && pnpm --filter @markiro/saas-admin typecheck`

- [ ] **Step 3: Make DataTabs generic and move the metric hint into the definition value**

```ts
export interface DataTabItem<Id extends string = string> {
  id: Id; /* existing fields */
}
export interface DataTabsProps<Id extends string = string> {
  items: readonly DataTabItem<Id>[];
  activeId: Id;
  onChange: (id: Id) => void;
}
```

Render the value and optional `mk-metric-strip__hint` inside one `dd`, and stack them with the existing spacing tokens.

- [ ] **Step 4: Re-run UI tests, UI gates, and SaaS-admin typecheck**

Run: `pnpm --filter @markiro/ui test && pnpm --filter @markiro/ui typecheck && pnpm --filter @markiro/ui lint && pnpm --filter @markiro/saas-admin typecheck`

Expected: all commands pass without `as CatalogKind`.

### Task 3: Complete localization and defined-token usage

**Files:**

- Modify: `apps/saas-admin/src/app.tsx`
- Modify: `apps/saas-admin/src/global.css`
- Modify: `apps/saas-admin/src/i18n/en.json`
- Modify: `apps/saas-admin/src/i18n/ru.json`
- Modify: `apps/saas-admin/src/pages/audit/AuditPage.tsx`
- Modify: `apps/saas-admin/src/pages/offers/OffersPage.tsx`
- Modify: `apps/saas-admin/src/pages/tenants/TenantsPage.tsx`
- Modify: `apps/saas-admin/src/pages/overview/OverviewPage.tsx`
- Test: `apps/saas-admin/test/audit-page.test.tsx`
- Test: `apps/saas-admin/test/overview.test.tsx`
- Test: `apps/saas-admin/test/shell.test.tsx`
- Test: `apps/saas-admin/test/tenants.test.tsx`

**Interfaces:**

- Consumes: `i18n.resolvedLanguage`, existing `--mk-motion-fast`, `--z-overlay-panel`, and `--z-overlay-dialog` tokens.
- Produces: translated operational labels, locale-specific activity time, and a rail/backdrop stack using only defined tokens.

- [ ] **Step 1: Add failing RU/EN rendering tests for labels and activity time**

```ts
await i18n.changeLanguage("ru");
expect(screen.getByText("Неизменяемый журнал событий")).toBeDefined();

await i18n.changeLanguage("en");
expect(screen.getByText("Immutable event log")).toBeDefined();
```

Stub `Date.prototype.toLocaleString` and assert OverviewPage passes `ru-RU` and `en-GB` as the first argument.

- [ ] **Step 2: Run the focused SaaS-admin tests and confirm they fail on hard-coded labels and implicit locale**

Run: `pnpm --filter @markiro/saas-admin exec vitest run test/audit-page.test.tsx test/overview.test.tsx test/shell.test.tsx test/tenants.test.tsx`

- [ ] **Step 3: Implement localized labels, explicit locale, direct Navigate state, and defined tokens**

```tsx
const { t, i18n } = useTranslation();
const locale = i18n.resolvedLanguage?.startsWith("en") ? "en-GB" : "ru-RU";
new Date(event.createdAt).toLocaleString(locale);

<Navigate to={{ pathname, search: location.search }} replace state={location.state} />;
```

Use `--z-overlay-panel` for the desktop rail, `--z-overlay-dialog` for the mobile rail, a lower calculated backdrop value, and `--mk-motion-fast` for the transition.

- [ ] **Step 4: Re-run the focused and full SaaS-admin gates**

Run: `pnpm --filter @markiro/saas-admin test && pnpm --filter @markiro/saas-admin typecheck && pnpm --filter @markiro/saas-admin lint && pnpm --filter @markiro/saas-admin build`

Expected: all commands pass.

### Task 4: Resolve the migration review and publish the PR update

**Files:**

- Inspect: `packages/db/migrations/0064_normalize_operator_billing_profile_kind.sql`
- Inspect: `packages/db/src/schema/billing.ts`
- Modify only if supported by evidence: migration 0064 and its migration tests.

**Interfaces:**

- Produces: a documented accept-or-fix decision based on actual operator-profile cardinality and PostgreSQL locking behavior.

- [ ] **Step 1: Verify table semantics and migration status**

Confirm that `operator_billing_profiles` is the revision history for Markiro's single operator legal entity, while tenant legal profiles live in `tenant_billing_profiles`. Confirm migration 0064 exists only on the open PR branch.

- [ ] **Step 2: Keep the migration unchanged unless evidence shows large-table exposure**

If the table is global operator revision history as designed, record that the review's large-active-table premise does not apply. If evidence contradicts this, add the check as `NOT VALID` and schedule validation separately without rewriting any applied migration.

- [ ] **Step 3: Run final package and repository checks**

Run: `pnpm --filter @markiro/platform-contracts test && pnpm --filter @markiro/api test && pnpm --filter @markiro/saas-admin test && pnpm --filter @markiro/ui test && pnpm format:check && git diff --check`

- [ ] **Step 4: Commit and update PR #248**

Stage only the reviewed files and this plan, commit with `fix(saas-admin): address PR review`, push `codex/saas-admin-redesign`, and report any CI checks still pending.
