# Default Box-Label Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every aggregation shift snapshot an effective box-label template
before it can start, using an organisation default with an optional cabinet
override, while retiring unused item-label bindings from current product and
shift contracts.

**Architecture:** Add a tenant-safe default reference to `org_profiles`, resolve
it exactly once when a shift is created or deliberately updated, and keep
`shifts.box_label_template_id` as the offline-print authority. Preserve obsolete
Postgres and SQLite item-label columns through the beta compatibility horizon,
but expose them only as explicit `null` values inside the station bundle. Keep
the station floor flow selector-free and localize one stable API error code.

**Tech Stack:** PostgreSQL + Drizzle, NestJS + Zod, React/Vite + TanStack Query +
React Hook Form, Tauri station React UI + SQLite mirror, Vitest, Testing Library,
pnpm 11 / Node 24.

**Spec:**
`docs/superpowers/specs/2026-08-14-default-box-label-template-design.md`

## Global constraints

- Keep `products.default_label_template_id`, `shifts.label_template_id`, and the
  matching station SQLite columns physically present. This release retires their
  use; it does not drop compatibility storage.
- Never infer a box template from a product item-template field or from the first
  template at runtime.
- Resolve defaults only inside the authenticated tenant boundary. Every new
  reference uses a composite `(tenant_id, id)` foreign key.
- A shift stores a snapshot. Opening, bundling, or changing the organisation
  default must not silently re-resolve an existing shift.
- Station credentials must not receive access to the label-template library or
  organisation profile.
- The migration may auto-select only when a tenant owns exactly one template.
  It must not guess when there are zero or multiple templates.
- Use focused RED/GREEN tests before changing implementation. Do not weaken or
  delete existing assertions merely because the old item-label feature is being
  retired; replace them with assertions for the new public contract and explicit
  bundle compatibility.
- Do not log response bodies, label specs, tenant IDs, credentials, or scanner
  input while handling the new error.

---

## Task 1: Add the organisation default and deterministic data migration

**Files:**

- Modify: `packages/db/src/schema/org-profile.ts`
- Modify: `packages/db/test/schema.test.ts`
- Create: `packages/db/test/default-box-label-template-migration.test.ts`
- Create through Drizzle: `packages/db/migrations/0042_default_box_label_template.sql`
- Create through Drizzle: `packages/db/migrations/meta/0042_snapshot.json`
- Modify through Drizzle: `packages/db/migrations/meta/_journal.json`

**Interface produced for later tasks:**

```ts
orgProfiles.defaultBoxLabelTemplateId: string | null;
```

with the constraint:

```text
org_profiles_box_label_template_tenant_fk
  (tenant_id, default_box_label_template_id)
  -> label_templates(tenant_id, id)
```

- [ ] **Write the schema RED test.** Extend `packages/db/test/schema.test.ts` to
      assert that `orgProfiles` exposes `defaultBoxLabelTemplateId`, that it is
      nullable, and that `getTableConfig(orgProfiles)` contains the named composite
      FK with local columns `tenant_id`, `default_box_label_template_id` and foreign
      columns `tenant_id`, `id`.

- [ ] **Write the migration RED test.** In
      `packages/db/test/default-box-label-template-migration.test.ts`, follow the
      disposable-database pattern from `saas-migration.test.ts`: create a random
      database from `DATABASE_URL`, apply migrations through `0041`, seed independent
      tenants, then apply the full migration folder. Cover these fixtures in one
      deterministic table-driven test:

  | Tenant  | Templates | Shifts before migration                                                                    | Expected result                                                             |
  | ------- | --------: | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
  | sole    |         1 | planned + active aggregation with null; validation null; closed null; aggregation explicit | profile default set; only planned/active null aggregation shifts backfilled |
  | none    |         0 | planned aggregation null                                                                   | profile/default/shift remain null                                           |
  | many    |         2 | active aggregation null                                                                    | profile/default/shift remain null                                           |
  | foreign |         1 | independent aggregation null                                                               | receives only its own sole template                                         |

  Also seed an existing profile with GLN, INN, GS1 prefixes, logo and a stable
  `updated_at`; assert all values survive. Run `migrate()` a second time and
  assert the complete result set is unchanged.

- [ ] **Run the RED tests and confirm the intended failures.**

  ```bash
  pnpm --filter @markiro/db exec vitest run test/schema.test.ts
  DATABASE_URL="$DATABASE_URL" pnpm --filter @markiro/db exec vitest run test/default-box-label-template-migration.test.ts
  ```

  Expected: the schema test cannot find the new column/FK; the migration test
  cannot find migration `0042` or its column. If `DATABASE_URL` is unavailable,
  record the migration test as infrastructure-blocked and do not call its
  behavior verified.

- [ ] **Implement the Drizzle schema.** Import `labelTemplates` into
      `org-profile.ts`, add the nullable UUID column, and add the named composite FK
      beside the logo FK. Keep the existing profile primary key and logo tenant FK
      unchanged.

- [ ] **Generate, inspect, and complete migration `0042`.** Run:

  ```bash
  pnpm --filter @markiro/db db:generate
  ```

  Review the generated ALTER/FK SQL, then append tenant-scoped data statements
  equivalent to:

  ```sql
  WITH sole_templates AS (
    SELECT tenant_id, min(id::text)::uuid AS template_id
    FROM label_templates
    GROUP BY tenant_id
    HAVING count(*) = 1
  )
  INSERT INTO org_profiles (tenant_id, default_box_label_template_id)
  SELECT tenant_id, template_id FROM sole_templates
  ON CONFLICT (tenant_id) DO UPDATE
    SET default_box_label_template_id = EXCLUDED.default_box_label_template_id
  WHERE org_profiles.default_box_label_template_id IS NULL;

  UPDATE shifts AS s
  SET box_label_template_id = p.default_box_label_template_id
  FROM org_profiles AS p
  WHERE s.tenant_id = p.tenant_id
    AND s.mode = 'aggregation'
    AND s.status IN ('planned', 'active')
    AND s.box_label_template_id IS NULL
    AND p.default_box_label_template_id IS NOT NULL;
  ```

  Preserve an already configured organisation default: the conflict update must
  fill only a null default, never overwrite a deliberate selection. Ensure the
  generated snapshot and journal entry are committed with the SQL.

- [ ] **Run GREEN checks.**

  ```bash
  pnpm --filter @markiro/db exec vitest run test/schema.test.ts test/default-box-label-template-migration.test.ts
  pnpm --filter @markiro/db typecheck
  pnpm --filter @markiro/db lint
  pnpm --filter @markiro/db build
  ```

- [ ] **Commit Task 1.**

  ```bash
  git add packages/db/src/schema/org-profile.ts packages/db/test/schema.test.ts packages/db/test/default-box-label-template-migration.test.ts packages/db/migrations/0042_default_box_label_template.sql packages/db/migrations/meta/0042_snapshot.json packages/db/migrations/meta/_journal.json
  git commit -m "feat(db): add default box label template"
  ```

---

## Task 2: Expose and protect the organisation default in the cabinet API

**Files:**

- Modify: `apps/api/src/modules/org-profile/dto.ts`
- Modify: `apps/api/src/modules/org-profile/org-profile.service.ts`
- Modify: `apps/api/src/modules/label-templates/label-templates.service.ts`
- Modify: `apps/api/test/org-profile.controller.test.ts`
- Modify: `apps/api/test/org-profile.service.test.ts`
- Modify: `apps/api/test/org-profile.e2e.test.ts`
- Modify: `apps/api/test/label-templates.e2e.test.ts`

**Interface produced for later tasks:**

```ts
interface OrgProfileDto {
  defaultBoxLabelTemplateId: string | null;
}

const putOrgProfileSchema = z.object({
  defaultBoxLabelTemplateId: z.string().uuid().nullable().optional(),
  // existing fields unchanged
});
```

- [ ] **Write DTO/controller RED coverage.** Assert the PUT pipe accepts a UUID,
      accepts explicit `null`, preserves omission, and rejects malformed identifiers.
      Update controller mocks and response fixtures to require
      `defaultBoxLabelTemplateId`.

- [ ] **Write service RED coverage.** Add tests proving `getProfile()` returns
      null when no profile/default exists; `upsertProfile()` writes a supplied UUID,
      clears on explicit null, and leaves the current value untouched when omitted.
      Add a rejected cross-tenant UUID case and assert no partial profile mutation.

- [ ] **Write database-backed API RED coverage.** In `org-profile.e2e.test.ts`,
      seed two tenants and templates, then prove same-tenant set/get/clear works and
      a foreign template returns a bounded 400 without exposing either tenant ID or
      the FK constraint name.

- [ ] **Write deletion RED coverage.** In `label-templates.e2e.test.ts`, set the
      organisation default to a template and assert DELETE returns 409 with an
      actionable generic reference message. Retain existing product/shift reference
      cases during the compatibility horizon.

- [ ] **Run RED tests.**

  ```bash
  pnpm --filter @markiro/api exec vitest run test/org-profile.controller.test.ts test/org-profile.service.test.ts test/org-profile.e2e.test.ts test/label-templates.e2e.test.ts
  ```

  Expected: new response field and FK/delete behavior are absent.

- [ ] **Implement DTO and service behavior.** Select the new field in
      `getProfile()`. Include it in insert/update only when present in the patch.
      Let the composite FK be the final tenant guard, but translate its `23503`
      result into `BadRequestException("Unknown box label template for this organization")`
      without returning the constraint. Do not turn the upsert into an unprotected
      read-then-write merge.

- [ ] **Update template deletion conflict handling.** Keep 409 for any referenced
      template, but change the sanitized text so organisation defaults, product
      compatibility references, and shift references are all accurately covered.
      Do not blanket-convert unrelated database errors to conflicts.

- [ ] **Run GREEN checks.**

  ```bash
  pnpm --filter @markiro/api exec vitest run test/org-profile.controller.test.ts test/org-profile.service.test.ts test/org-profile.e2e.test.ts test/label-templates.e2e.test.ts
  pnpm --filter @markiro/api typecheck
  pnpm --filter @markiro/api lint
  pnpm --filter @markiro/api build
  ```

- [ ] **Commit Task 2.**

  ```bash
  git add apps/api/src/modules/org-profile/dto.ts apps/api/src/modules/org-profile/org-profile.service.ts apps/api/src/modules/label-templates/label-templates.service.ts apps/api/test/org-profile.controller.test.ts apps/api/test/org-profile.service.test.ts apps/api/test/org-profile.e2e.test.ts apps/api/test/label-templates.e2e.test.ts
  git commit -m "feat(api): manage default box labels"
  ```

---

## Task 3: Enforce snapshot resolution for aggregation shifts

**Files:**

- Modify: `apps/api/src/modules/shifts/dto.ts`
- Modify: `apps/api/src/modules/shifts/shifts.service.ts`
- Modify: `apps/api/test/shifts.service.test.ts`
- Modify: `apps/api/test/shifts.e2e.test.ts`
- Modify: `apps/api/test/shifts-bundle.e2e.test.ts`

**Behavioral boundary:**

```ts
type BoxTemplateResolution =
  | { ok: true; boxLabelTemplateId: string | null }
  | { ok: false; code: "BOX_LABEL_TEMPLATE_REQUIRED" };
```

The HTTP failure must be a 422 response whose JSON has stable scalar code
`BOX_LABEL_TEMPLATE_REQUIRED`. The exact Nest exception shape may include the
existing `statusCode` and message fields, but clients must match only `code`.

- [ ] **Write create RED tests.** Cover explicit override winning over the
      default, omitted value snapshotting the default, explicit null rejecting
      aggregation, absent default rejecting aggregation, and validation accepting
      null. For both rejection cases, assert no shift row was inserted.

- [ ] **Write update RED tests.** Cover planned validation → aggregation using an
      already snapshotted box template; reject the same transition when the merged
      state is null; accept an explicit override; and preserve the existing rule
      that active shifts cannot be edited. Changing the organisation default after
      shift creation must not change a shift on GET/open/bundle.

- [ ] **Write tenant-boundary RED tests.** Retain explicit cross-tenant override
      rejection. Add a malformed/foreign organisation default fixture at the
      service boundary and prove the shift is not created. The database FK remains
      defense in depth; tests must not rely only on a pre-query.

- [ ] **Write bundle RED tests.** Prove `boxLabelTemplate` is resolved solely from
      the shift snapshot even after the organisation default changes. A validation
      shift with null snapshot returns `boxLabelTemplate: null`.

- [ ] **Run RED tests.**

  ```bash
  pnpm --filter @markiro/api exec vitest run test/shifts.service.test.ts test/shifts.e2e.test.ts test/shifts-bundle.e2e.test.ts
  ```

- [ ] **Implement one resolver in `ShiftsService`.** For create, distinguish
      omitted from explicit null:

  ```ts
  const boxLabelTemplateId =
    data.boxLabelTemplateId !== undefined
      ? data.boxLabelTemplateId
      : await this.findDefaultBoxLabelTemplateId(tenantId);

  this.assertBoxTemplateRule(data.mode, boxLabelTemplateId);
  ```

  `findDefaultBoxLabelTemplateId` must select by `tenantId`; it must not load the
  entire profile or template spec. For update, apply the rule to the merged
  `mode` and `boxLabelTemplateId` and do not re-resolve the current organisation
  default unless the caller explicitly adopts it by sending that UUID.

- [ ] **Add the stable 422 exception boundary.** Construct a sanitized Nest
      exception response such as:

  ```ts
  throw new UnprocessableEntityException({
    code: "BOX_LABEL_TEMPLATE_REQUIRED",
    message: "Aggregation shifts require a box label template",
  });
  ```

  Do not place product, template, shift, or tenant identifiers in this error.

- [ ] **Run GREEN checks.**

  ```bash
  pnpm --filter @markiro/api exec vitest run test/shifts.service.test.ts test/shifts.e2e.test.ts test/shifts-bundle.e2e.test.ts
  pnpm --filter @markiro/api typecheck
  pnpm --filter @markiro/api lint
  pnpm --filter @markiro/api build
  ```

- [ ] **Commit Task 3.**

  ```bash
  git add apps/api/src/modules/shifts/dto.ts apps/api/src/modules/shifts/shifts.service.ts apps/api/test/shifts.service.test.ts apps/api/test/shifts.e2e.test.ts apps/api/test/shifts-bundle.e2e.test.ts
  git commit -m "feat(api): require box labels for aggregation"
  ```

---

## Task 4: Retire item-label bindings from current public contracts

**Files:**

- Modify: `apps/api/src/modules/products/dto.ts`
- Modify: `apps/api/src/modules/products/products.service.ts`
- Modify: `apps/api/src/modules/shifts/dto.ts`
- Modify: `apps/api/src/modules/shifts/shifts.service.ts`
- Modify: `apps/api/test/products.e2e.test.ts`
- Modify: `apps/api/test/shifts.e2e.test.ts`
- Modify: `apps/api/test/shifts-bundle.e2e.test.ts`
- Modify: `apps/station/src/lib/mirror.ts`
- Modify: `apps/station/test/mirror.test.ts`
- Modify: `apps/station/test/shift-bundle.test.ts`
- Modify: `packages/db/test/sqlite-schema.test.ts`

**Compatibility DTO boundary:**

```ts
type StationBundleProductDto = ProductDto & {
  defaultLabelTemplateId: null;
};

type StationBundleShiftDto = ShiftDto & {
  labelTemplateId: null;
  labelTemplateName: null;
};

interface ShiftBundleDto {
  shift: StationBundleShiftDto;
  product: StationBundleProductDto;
  labelTemplate: null;
  boxLabelTemplate: { id: string; name: string; spec: LabelTemplateSpec } | null;
  // other existing fields unchanged
}
```

- [ ] **Write product contract RED tests.** Replace tests that expect product
      create/update/default behavior with tests asserting the existing Zod object
      boundary strips `defaultLabelTemplateId`, the service neither writes nor
      returns it, and the existing database column remains untouched for a seeded
      legacy row.

- [ ] **Write shift contract RED tests.** Assert create/update DTOs no longer
      accept `labelTemplateId`; normal list/get responses omit `labelTemplateId` and
      `labelTemplateName`; shift creation does not read or copy
      `product.default_label_template_id`.

- [ ] **Write rolling-bundle RED tests.** Seed non-null legacy item bindings and
      assert the station bundle still contains exactly:

  ```json
  {
    "shift": { "labelTemplateId": null, "labelTemplateName": null },
    "product": { "defaultLabelTemplateId": null },
    "labelTemplate": null
  }
  ```

  while `boxLabelTemplate` retains the shift's real box spec. Add a station
  mirror test proving these explicit nulls clear a previously mirrored legacy
  item spec without altering `box_label_template_spec`.

- [ ] **Write physical-storage RED assertions.** Extend
      `sqlite-schema.test.ts` to assert the deprecated item-label columns still
      exist after all migrations. Keep the Postgres schema fields and FKs unchanged
      in `platform.ts`; no new migration belongs to this task.

- [ ] **Run RED tests.**

  ```bash
  pnpm --filter @markiro/api exec vitest run test/products.e2e.test.ts test/shifts.e2e.test.ts test/shifts-bundle.e2e.test.ts
  pnpm --filter @markiro/station exec vitest run test/mirror.test.ts test/shift-bundle.test.ts
  pnpm --filter @markiro/db exec vitest run test/sqlite-schema.test.ts
  ```

- [ ] **Remove item-label fields from current DTOs and service projections.** Do
      not read or write the legacy product/shift columns in create/update/list/get.
      Build the station bundle compatibility objects explicitly; do not cast a
      normal DTO or leak a seeded legacy value through object spread.

- [ ] **Keep the station mirror tolerant.** Retain TypeScript/SQLite fields
      needed by older bundles and write the explicit nulls. `WorkScreen` must remain
      bound only to `boxLabelTemplateSpec`; do not add a fallback.

- [ ] **Run GREEN checks.**

  ```bash
  pnpm --filter @markiro/db exec vitest run test/sqlite-schema.test.ts
  pnpm --filter @markiro/db typecheck
  pnpm --filter @markiro/db lint
  pnpm --filter @markiro/db build
  pnpm --filter @markiro/api exec vitest run test/products.e2e.test.ts test/shifts.e2e.test.ts test/shifts-bundle.e2e.test.ts
  pnpm --filter @markiro/api typecheck
  pnpm --filter @markiro/api lint
  pnpm --filter @markiro/api build
  pnpm --filter @markiro/station exec vitest run test/mirror.test.ts test/shift-bundle.test.ts test/work-screen.test.tsx
  pnpm --filter @markiro/station typecheck
  ```

- [ ] **Commit Task 4.**

  ```bash
  git add packages/db/test/sqlite-schema.test.ts apps/api/src/modules/products/dto.ts apps/api/src/modules/products/products.service.ts apps/api/src/modules/shifts/dto.ts apps/api/src/modules/shifts/shifts.service.ts apps/api/test/products.e2e.test.ts apps/api/test/shifts.e2e.test.ts apps/api/test/shifts-bundle.e2e.test.ts apps/station/src/lib/mirror.ts apps/station/test/mirror.test.ts apps/station/test/shift-bundle.test.ts
  git commit -m "refactor: retire item label bindings"
  ```

---

## Task 5: Add the organisation default control to Admin settings

**Files:**

- Modify: `apps/admin/src/pages/settings/api.ts`
- Modify: `apps/admin/src/pages/settings/OrgProfilePage.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Modify: `apps/admin/test/org-profile.test.tsx`

- [ ] **Write Admin API/form RED tests.** Update profile fixtures to require
      `defaultBoxLabelTemplateId`. Mock `GET /label-templates` and verify the settings
      page shows `Шаблон этикетки короба по умолчанию`, the unset option, every
      tenant template, and a link to `/labels`. Cover load, save UUID, clear to null,
      and a stale saved ID missing from the library.

- [ ] **Define stale-selection behavior in the test.** The stale ID must remain
      visibly selected as unavailable and saving must be blocked until the operator
      reloads or chooses a valid option. Show localized actionable copy; never
      silently turn it into null.

- [ ] **Run RED.**

  ```bash
  pnpm --filter @markiro/admin exec vitest run test/org-profile.test.tsx
  ```

- [ ] **Extend the typed settings API.** Add the field to `OrgProfileDto` and
      `PutOrgProfileInput`. Reuse `useLabelTemplates()` from
      `pages/labels/api.ts`; do not duplicate a fetcher or query key.

- [ ] **Add controlled form state.** Extend `ProfileFormValues` with
      `defaultBoxLabelTemplateId`, populate it from the profile, serialize `""` as
      explicit null only after a deliberate valid selection, and reset from the
      successful mutation response. Preserve the existing dirty-form protection so
      background refetches do not overwrite edits.

- [ ] **Add localized copy.** Include RU/EN labels for the field, unset state,
      stale selection, reload action, template-library link, and save errors. Use
      existing `Select`, `Alert`, `Button`/link, spacing, and focus patterns from the
      Admin design system.

- [ ] **Run GREEN checks.**

  ```bash
  pnpm --filter @markiro/admin exec vitest run test/org-profile.test.tsx
  pnpm --filter @markiro/admin typecheck
  pnpm --filter @markiro/admin lint
  pnpm --filter @markiro/admin build
  ```

- [ ] **Commit Task 5.**

  ```bash
  git add apps/admin/src/pages/settings/api.ts apps/admin/src/pages/settings/OrgProfilePage.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/org-profile.test.tsx
  git commit -m "feat(admin): configure default box labels"
  ```

---

## Task 6: Simplify Product and Shift forms around box-template inheritance

**Files:**

- Modify: `apps/admin/src/pages/catalog/api.ts`
- Modify: `apps/admin/src/pages/catalog/ProductForm.tsx`
- Modify: `apps/admin/src/pages/catalog/ProductPanelRoute.tsx`
- Modify: `apps/admin/src/pages/catalog/index.tsx`
- Modify: `apps/admin/src/pages/shifts/api.ts`
- Modify: `apps/admin/src/pages/shifts/ShiftForm.tsx`
- Modify: `apps/admin/src/pages/shifts/ShiftPanelRoute.tsx`
- Modify: `apps/admin/src/pages/shifts/index.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Modify: `apps/admin/test/catalog.test.tsx`
- Modify: `apps/admin/test/catalog-routing.test.tsx`
- Modify: `apps/admin/test/shifts.test.tsx`
- Modify: `apps/admin/test/shifts-routing.test.tsx`

**Form contract:**

```ts
interface ShiftFormContext {
  defaultBoxLabelTemplateId: string | null;
  labelTemplates: LabelTemplateSummaryDto[];
}
```

An untouched create form serializes the resolved default UUID for aggregation,
not `null` and not a magic sentinel. An edit form always serializes the selected
snapshot or the current organisation default UUID when the administrator chooses
“use organisation setting”.

- [ ] **Write Product RED tests.** Prove create and edit render no unit-template
      control and submit no `defaultLabelTemplateId`, while all unrelated product
      fields and label-library navigation remain intact. Update routing fixtures and
      typed payload assertions rather than leaving optional dead properties.

- [ ] **Write Shift create RED tests.** Mock profile plus label templates. Cover:
      inherited display `Использовать настройку организации — Короб 100×100`; aggregation
      submit using the inherited UUID; explicit override; validation with no default;
      aggregation blocked with an inline error when neither default nor override
      exists; and no `labelTemplateId` control/payload.

- [ ] **Write Shift edit RED tests.** A planned shift displays its snapshotted
      box template even when the organisation default has changed. Choosing the
      organisation option writes the current default UUID. An active shift remains
      read-only under existing rules.

- [ ] **Run RED.**

  ```bash
  pnpm --filter @markiro/admin exec vitest run test/catalog.test.tsx test/catalog-routing.test.tsx test/shifts.test.tsx test/shifts-routing.test.tsx
  ```

- [ ] **Remove product item-template plumbing.** Delete it from Admin DTOs,
      Zod/form values, defaults, payload builders, route context, props, and copy.
      Stop loading label templates in catalog solely for the removed field; retain
      any independent label-library routes.

- [ ] **Refactor Shift form to one template control.** Remove
      `labelTemplateId` and its touched-state logic. Load `useOrgProfile()` in the
      shift page context alongside `useLabelTemplates()`. Represent inheritance in
      UI state explicitly, then translate it to a real UUID or missing value before
      API submission. Do not send a sentinel string to the API.

- [ ] **Implement mode-aware validation.** The form must reject aggregation when
      its effective box template is null and allow validation. Keep the server 422
      as authoritative; the client check is guidance, not a security boundary.

- [ ] **Run GREEN checks.**

  ```bash
  pnpm --filter @markiro/admin exec vitest run test/catalog.test.tsx test/catalog-routing.test.tsx test/shifts.test.tsx test/shifts-routing.test.tsx
  pnpm --filter @markiro/admin test
  pnpm --filter @markiro/admin typecheck
  pnpm --filter @markiro/admin lint
  pnpm --filter @markiro/admin build
  ```

- [ ] **Commit Task 6.**

  ```bash
  git add apps/admin/src/pages/catalog/api.ts apps/admin/src/pages/catalog/ProductForm.tsx apps/admin/src/pages/catalog/ProductPanelRoute.tsx apps/admin/src/pages/catalog/index.tsx apps/admin/src/pages/shifts/api.ts apps/admin/src/pages/shifts/ShiftForm.tsx apps/admin/src/pages/shifts/ShiftPanelRoute.tsx apps/admin/src/pages/shifts/index.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/catalog.test.tsx apps/admin/test/catalog-routing.test.tsx apps/admin/test/shifts.test.tsx apps/admin/test/shifts-routing.test.tsx
  git commit -m "feat(admin): inherit box labels in shifts"
  ```

---

## Task 7: Localize missing configuration in the Station creation flow

**Files:**

- Modify: `apps/station/src/lib/api-client.ts`
- Modify: `apps/station/src/pages/NewShift.tsx`
- Modify: `apps/station/src/i18n/ru.json`
- Modify: `apps/station/src/i18n/en.json`
- Modify: `apps/station/test/api-client.test.tsx`
- Modify: `apps/station/test/new-shift.test.tsx`

**Client interface:**

```ts
export class StationApiError extends Error {
  readonly status: number;
  readonly code?: string;
}
```

- [ ] **Write API-client RED tests.** Feed bounded JSON error responses with
      string `message` and string `code`; assert both are captured. Cover missing,
      non-string, oversized, and malformed code/message values and prove the client
      falls back to sanitized existing behavior without throwing a JSON parser error.
      Assert no full response object is logged.

- [ ] **Write NewShift RED tests.** For aggregation, make POST `/shifts` reject
      with status 422 and code `BOX_LABEL_TEMPLATE_REQUIRED`; assert localized RU and
      EN guidance, no `/open` request, no `onStarted`, and the Start button re-enabled
      for retry. Then make the next POST succeed and prove the normal open flow
      resumes. Assert the request body remains exactly `{ productId, mode }` and no
      template selector appears.

- [ ] **Preserve validation and generic errors.** Add/retain tests that validation
      can start without configuration and unknown error codes use the existing
      generic action failure rather than raw server prose.

- [ ] **Run RED.**

  ```bash
  pnpm --filter @markiro/station exec vitest run test/api-client.test.tsx test/new-shift.test.tsx
  ```

- [ ] **Implement bounded error parsing.** Parse only documented scalar fields,
      cap their accepted length, and pass `code` into `StationApiError`. Keep
      credential rejection and reachability ordering unchanged.

- [ ] **Map the stable code in `NewShift`.** Prefer the localized key only for
      `BOX_LABEL_TEMPLATE_REQUIRED`; do not match English message text. Clear busy in
      `finally` so the same operator can retry after the cabinet is configured.

- [ ] **Run GREEN checks.**

  ```bash
  pnpm --filter @markiro/station exec vitest run test/api-client.test.tsx test/new-shift.test.tsx
  pnpm --filter @markiro/station typecheck
  pnpm --filter @markiro/station lint
  pnpm --filter @markiro/station build
  ```

- [ ] **Commit Task 7.**

  ```bash
  git add apps/station/src/lib/api-client.ts apps/station/src/pages/NewShift.tsx apps/station/src/i18n/ru.json apps/station/src/i18n/en.json apps/station/test/api-client.test.tsx apps/station/test/new-shift.test.tsx
  git commit -m "fix(station): explain missing box labels"
  ```

---

## Task 8: Prove active-shift recovery preserves the same production state

**Files:**

- Modify: `apps/station/test/credential-recovery.test.ts`
- Modify: `apps/station/test/App.test.tsx`
- Modify: `apps/station/test/work-screen.test.tsx`
- Modify if a production defect is exposed: `apps/station/src/lib/credential-recovery.ts`
- Modify if a production defect is exposed: `apps/station/src/lib/shift-bundle.ts`
- Modify if a production defect is exposed: `apps/station/src/App.tsx`

- [ ] **Write an integration RED test matching the reported beta failure.** Seed
      an active aggregation shift locally with an unresolved closed box, fixed box ID
      and SSCC, `box_label_template_spec = null`, and pending print recovery. Mock the
      refreshed bundle with the same shift and a valid `boxLabelTemplate` supplied by
      migration/backfill.

- [ ] **Exercise the real recovery action.** Click `Повторить восстановление` and
      assert the bundle is downloaded/mirrored, the recovery screen advances to the
      existing print retry flow, and the exact box ID/SSCC, scan journal, outbox, and
      unresolved print record remain unchanged. Assert no second box close, SSCC
      allocation, scan admission, or `/shifts/:id/open` occurs.

- [ ] **Cover offline retry.** Make refresh unavailable and assert the screen stays
      blocked with honest connectivity guidance and the retry remains available.
      Then restore the response and prove the same component/session recovers.

- [ ] **Run RED.**

  ```bash
  pnpm --filter @markiro/station exec vitest run test/credential-recovery.test.ts test/App.test.tsx test/work-screen.test.tsx
  ```

  If the established PR #138 behavior already passes, record that result and do
  not change production recovery code. The new regression test is still required
  because it binds recovery to the new backfilled bundle shape.

- [ ] **Apply only evidence-driven fixes.** If RED exposes a defect, keep changes
      inside the listed recovery/bundle/App boundary. Do not change print transport,
      SSCC allocation, or persistent recovery semantics.

- [ ] **Run GREEN checks.**

  ```bash
  pnpm --filter @markiro/station exec vitest run test/credential-recovery.test.ts test/App.test.tsx test/work-screen.test.tsx
  pnpm --filter @markiro/station test
  pnpm --filter @markiro/station typecheck
  pnpm --filter @markiro/station lint
  pnpm --filter @markiro/station build
  ```

- [ ] **Commit Task 8.** Stage the three tests plus only production files that a
      failing regression required.

  ```bash
  git add apps/station/test/credential-recovery.test.ts apps/station/test/App.test.tsx apps/station/test/work-screen.test.tsx
  git commit -m "test(station): preserve box recovery after backfill"
  ```

  If production files changed, include them explicitly in the same focused commit
  and use message `fix(station): recover backfilled box labels`.

---

## Task 9: Update acceptance docs and run release-proportionate gates

**Files:**

- Modify: `docs/hardware-acceptance-checklist.md`
- Modify: `docs/runbooks/station-beta-release.md`
- Modify if current status is tracked there:
  `docs/superpowers/specs/2026-08-14-default-box-label-template-design.md`

- [ ] **Add packaged-Windows acceptance steps.** Keep them unchecked until a real
      beta is installed. Cover both paths:

  1. Configure an organisation default, create an aggregation shift on Station,
     close a box, and print the expected template with the allocated SSCC.
  2. Upgrade an installation containing the previously affected active shift,
     run `Повторить восстановление`, and print the same unresolved box/SSCC after
     backfill without a second close or allocation.

  Also verify an explicit per-shift override, validation without a template,
  offline recovery remaining blocked, and the cabinet conflict when deleting the
  configured default.

- [ ] **Document rollout order.** The runbook must require database migration and
      API rollout before Admin/Station use the new contract. Rollback must not drop
      the new column or deprecated compatibility columns while any beta can still
      send/read the transitional bundle.

- [ ] **Run package gates.** Load the test environment without overwriting `.env`.
      Build DB before API consumers.

  ```bash
  pnpm --filter @markiro/db test
  pnpm --filter @markiro/db typecheck
  pnpm --filter @markiro/db lint
  pnpm --filter @markiro/db build

  pnpm --filter @markiro/api test
  pnpm --filter @markiro/api typecheck
  pnpm --filter @markiro/api lint
  pnpm --filter @markiro/api build

  pnpm --filter @markiro/admin test
  pnpm --filter @markiro/admin typecheck
  pnpm --filter @markiro/admin lint
  pnpm --filter @markiro/admin build

  pnpm --filter @markiro/station test
  pnpm --filter @markiro/station typecheck
  pnpm --filter @markiro/station lint
  pnpm --filter @markiro/station build

  pnpm --filter @markiro/ui test
  pnpm --filter @markiro/ui typecheck
  pnpm --filter @markiro/ui lint
  pnpm --filter @markiro/ui build

  cargo test --manifest-path apps/station/src-tauri/Cargo.toml
  pnpm test:station-release:contract
  pnpm test:production-bundle:contract
  pnpm format:check
  git diff --check
  ```

  Report database/API skips explicitly. A suite that skips its migration or E2E
  cases because `DATABASE_URL` is absent does not verify those cases.

- [ ] **Perform a final contract search.** The only current-source occurrences of
      retired names should be database compatibility declarations, station mirror
      compatibility, explicit bundle-null serialization, tests, and historical docs:

  ```bash
  rg -n "defaultLabelTemplateId|labelTemplateId|labelTemplateName|labelTemplateSpec" \
    apps packages docs
  rg -n "BOX_LABEL_TEMPLATE_REQUIRED|defaultBoxLabelTemplateId" \
    apps packages docs
  ```

  Review every hit; do not suppress the search with an ignore pattern.

- [ ] **Perform external acceptance without overstating it.** Automated Linux/macOS
      checks do not prove Windows/Tauri updater, real scanner, or printer behavior.
      Leave corresponding checklist items unchecked until the packaged beta is run
      on the production station and a physical box label is inspected.

- [ ] **Update status only when evidence supports it.** Mark the design spec
      implemented only after all required automated gates are green. Keep Windows
      and hardware acceptance explicitly pending if not executed.

- [ ] **Commit Task 9.**

  ```bash
  git add docs/hardware-acceptance-checklist.md docs/runbooks/station-beta-release.md docs/superpowers/specs/2026-08-14-default-box-label-template-design.md
  git commit -m "docs(station): add default label acceptance"
  ```

## Completion criteria

- An aggregation shift cannot be inserted or changed into aggregation without
  an effective tenant-owned box template.
- Omitted create-time override snapshots the organisation default; later default
  changes do not mutate existing shifts.
- Validation shifts remain valid without a box template.
- Admin has one organisation default and one per-shift box override; product and
  shift item-label controls/contracts are gone.
- Station exposes no template selector, localizes
  `BOX_LABEL_TEMPLATE_REQUIRED`, does not open a failed shift, and can retry.
- Tenants with exactly one template receive deterministic migration/backfill;
  tenants with zero or multiple templates are left for explicit administration.
- Backfilled active-shift recovery preserves the same box, SSCC, journal, outbox,
  and print state.
- Legacy bundle item fields are explicit nulls and deprecated physical columns
  remain intact for the beta horizon.
- DB, API, Admin, Station, UI, Rust, release-contract, production-bundle, format,
  and diff gates are reported honestly, with Windows/printer/scanner acceptance
  separate.
