# Analytics P0: Production Date and First-Customer Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before the first customer scan, preserve the declared production date from shift creation through offline Station storage, box labels, and exports, and provide a reproducible evidence package for the founder-led warehouse inventory.

**Architecture:** Add one nullable `date` to the authoritative shift in Postgres and mirror it into Station SQLite. The API remains authoritative for mutation and rejects production-date changes after any box has closed. Admin and Station submit the same ISO calendar-date contract; Station refuses to open a newly created shift if an older API fails to echo a requested date. Label and export code use one explicit fallback chain. The first inventory's operation identity, raw baseline, photos, manifests, hashes, reconciliation, consent, and sign-off remain a file-based P0 evidence package; server-side analytical event storage starts in P1.

**Tech Stack:** Drizzle ORM (Postgres and SQLite), NestJS 11.2.1, Zod 4.4.3, React 19.2.8/Vite 8.2.1, Tauri Station, `@markiro/ui`, Vitest 4.1.11/Testing Library, Node.js 24 built-ins, pnpm 11.22.0/Turbo 2.10.11.

**Spec:** `docs/superpowers/specs/2026-08-21-analytics-and-impact-evidence-foundation-design.md`

## Global Constraints

- `productionDate` is either `null` or a real Gregorian calendar date serialized as `YYYY-MM-DD`; it is not a timestamp and not a complete lot identifier.
- No backfill: existing shifts remain `productionDate = null` and retain old behavior.
- Effective box-label date is `productionDate ?? localIsoDate(box.closedAt)`. Expiry uses that same effective date plus shelf-life calendar days.
- Effective export date is `productionDate ?? plannedDate`; `SHIFT_DATE_MISSING` remains when both are null.
- A production date may be set, changed, or cleared on a planned or active shift only before the first box closure. Any historical box row with non-null `closed_at` locks it, even after disassembly.
- Successful and rejected cabinet mutations record exact tenant, cabinet actor, shift, before/after values, outcome, and reason in `tenant_audit_events`.
- Station bundle omission means “old server/unknown” and must preserve an already mirrored value; explicit `null` means clear.
- A server cannot observe a box closure that is still only in an offline device queue. For the first-customer operation, the protocol therefore freezes the date once the shift is opened; Station also refuses to overwrite its mirrored date after a local closed box exists. The API's normal active-until-first-recorded-box rule remains available outside this stricter operation protocol.
- A Station that requested a non-null date must not open the created shift unless the API response echoes the same date.
- Analytics/evidence helpers only read raw evidence; they never rewrite, reorder, normalize, or “repair” `baseline/old-sscc.raw.txt`.
- The first-day operation is founder-led on one device and is explicitly ineligible for employee scorecards.
- Existing unrelated files (`apps/landing/public/robots.txt`, `apps/landing/public/sitemap.xml`, `docs/brand/`) belong to the user and must not be staged.
- Use repository-pinned tooling through `corepack pnpm`. Build `@markiro/db` before API consumer tests.
- Preserve the dependency baseline merged in `074bce403`: this feature adds no dependencies and the final gate runs both `corepack pnpm check:deps` and `corepack pnpm test:dependency-guard`.
- Physical Windows, scanner, printer, label-stock, restart, offline/reconnect, customer signature, and two-copy verification remain separate external gates.
- Commit after each task, staging only the files named in that task.

## File and responsibility map

| Area               | Files                                                                                                                                                                                                                                                            | Responsibility                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Postgres           | `packages/db/src/schema/platform.ts`, `packages/db/migrations/0054_shift_production_date.sql`, `packages/db/migrations/meta/0054_snapshot.json`, `packages/db/migrations/meta/_journal.json`, `packages/db/test/schema.test.ts`                                  | Nullable authoritative date, additive migration, schema proof                            |
| API contract       | `apps/api/src/modules/shifts/dto.ts`, `apps/api/src/modules/shifts/shifts.controller.ts`, `apps/api/src/modules/shifts/shifts.service.ts`, `apps/api/test/shifts.controller.test.ts`, `apps/api/test/shifts.e2e.test.ts`, `apps/api/test/shifts-openapi.test.ts` | Validation, create/read/bundle propagation, OpenAPI, mutation lock and audit             |
| Export             | `apps/api/src/modules/shift-exports/shift-export-source.service.ts`, `apps/api/test/shift-export-source.test.ts`                                                                                                                                                 | Explicit-date-first export fallback                                                      |
| Admin              | `apps/admin/src/pages/shifts/api.ts`, `ShiftForm.tsx`, `ShiftPanelRoute.tsx`, `apps/admin/src/i18n/{ru,en}.json`, `apps/admin/test/shifts.test.tsx`                                                                                                              | Optional create/edit/clear field and active-shift payload semantics                      |
| Station SQLite     | `packages/db/src/sqlite/schema.ts`, `packages/db/src/sqlite/migrations.ts`, `packages/db/test/sqlite-schema.test.ts`, `apps/station/src/lib/mirror.ts`, `apps/station/test/mirror.test.ts`                                                                       | Restart-safe mirror and omission-versus-null rolling compatibility                       |
| Station creation   | `apps/station/src/pages/NewShift.tsx`, `apps/station/src/i18n/{ru,en}.json`, `apps/station/test/new-shift.test.tsx`                                                                                                                                              | Touch date input, submission, old-API fail-closed response check                         |
| Label              | `apps/station/src/lib/box-label.ts`, `apps/station/src/pages/WorkScreen.tsx`, `apps/station/src/App.tsx`, `apps/station/test/box-label.test.ts`, `apps/station/test/close-box.test.ts`                                                                           | One effective production date for label and expiry; stable reprints                      |
| Evidence tool      | `tools/evidence-package/evidence-package.mjs`, `tools/evidence-package/{init,seal,verify}.mjs`, `tools/evidence-package/test/evidence-package.test.mjs`, root `package.json`                                                                                     | Deterministic scaffold, manifest, SHA-256 sealing and independent verification           |
| First-day protocol | `docs/operations/first-customer-inventory/README.md`, `protocol-v1.md`, `templates/*`                                                                                                                                                                            | Operator checklist, raw/index schemas, reconciliation, act, consent and backup procedure |

---

### Task 1: Add the nullable Postgres production date

**Files:**

- Modify: `packages/db/src/schema/platform.ts`
- Modify: `packages/db/test/schema.test.ts`
- Create via Drizzle: `packages/db/migrations/0054_shift_production_date.sql`
- Create via Drizzle: `packages/db/migrations/meta/0054_snapshot.json`
- Modify via Drizzle: `packages/db/migrations/meta/_journal.json`

- [ ] **Step 1: Write the failing schema test**

Add to `packages/db/test/schema.test.ts` inside `describe("platform schema", ...)`:

```ts
it("stores an optional production date on a shift without a default", () => {
  expect(shifts.productionDate).toBeDefined();
  expect(shifts.productionDate.notNull).toBe(false);
  expect(shifts.productionDate.default).toBeUndefined();
  expect(shifts.productionDate.dataType).toBe("string");
});
```

- [ ] **Step 2: Prove the test fails**

Run: `corepack pnpm --filter @markiro/db exec vitest run test/schema.test.ts`

Expected: FAIL because `shifts.productionDate` is absent.

- [ ] **Step 3: Add the Drizzle field**

In `packages/db/src/schema/platform.ts`, immediately after `plannedDate`:

```ts
    /** Declared civil production day; null keeps the close/planned-date fallback behavior. */
    productionDate: date("production_date"),
```

- [ ] **Step 4: Generate and inspect the additive migration**

Run: `corepack pnpm --filter @markiro/db db:generate --name shift_production_date`

The generated SQL must contain exactly the additive data change below, with no backfill, no default, and no rewrite of prior migrations:

```sql
ALTER TABLE "shifts" ADD COLUMN "production_date" date;
```

Review the generated snapshot and `_journal.json`. Do not rename the generated migration because its journal tag is generated with it.

- [ ] **Step 5: Prove schema and migration health**

Run:

```bash
corepack pnpm --filter @markiro/db exec vitest run test/schema.test.ts test/runtime-migrate.test.ts
corepack pnpm --filter @markiro/db typecheck
corepack pnpm --filter @markiro/db build
```

Expected: PASS. If `DATABASE_URL` is available, also run `corepack pnpm --filter @markiro/db db:migrate` against the development database and inspect `information_schema.columns` for nullable `date` with no default.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/platform.ts packages/db/test/schema.test.ts packages/db/migrations/0054_* packages/db/migrations/meta/_journal.json
git commit -m "feat(db): add shift production date"
```

---

### Task 2: Extend the API create/read/bundle and OpenAPI contracts

**Files:**

- Modify: `apps/api/src/modules/shifts/dto.ts`
- Modify: `apps/api/src/modules/shifts/shifts.service.ts`
- Modify: `apps/api/src/modules/shifts/shifts.controller.ts`
- Modify: `apps/api/test/shifts.controller.test.ts`
- Modify: `apps/api/test/shifts.e2e.test.ts`
- Create: `apps/api/test/shifts-openapi.test.ts`

**Interface:**

```ts
productionDate?: string | null; // create/update input
productionDate: string | null; // ShiftDto and every current bundle response
```

- [ ] **Step 1: Add failing DTO/controller tests**

Cover these cases before changing production code:

```ts
expect(
  createShiftSchema.parse({ productId, mode: "aggregation", productionDate: "2026-08-21" }),
).toMatchObject({ productionDate: "2026-08-21" });
expect(
  createShiftSchema.parse({ productId, mode: "aggregation", productionDate: null }),
).toMatchObject({ productionDate: null });
expect(() =>
  createShiftSchema.parse({ productId, mode: "aggregation", productionDate: "2026-02-30" }),
).toThrow();
expect(createShiftSchema.parse({ productId, mode: "aggregation" })).not.toHaveProperty(
  "productionDate",
);
```

In controller tests, assert a Station request containing `productionDate` reaches `createShift` unchanged except for the server-derived `lineId`.

- [ ] **Step 2: Prove the focused tests fail**

Run:

```bash
corepack pnpm --filter @markiro/api exec vitest run test/shifts.controller.test.ts
```

Expected: FAIL because the Zod schema strips the new field.

- [ ] **Step 3: Add a real ISO calendar-date schema and DTO fields**

In `dto.ts`, do not reuse the regex-only planned-date validator. Add:

```ts
const productionDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "productionDate must be YYYY-MM-DD")
  .refine((value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(0);
    parsed.setUTCFullYear(year, month - 1, day);
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    );
  }, "productionDate must be a real calendar date");
```

Add `productionDate: productionDateSchema.nullable().optional()` to create/update schemas and `productionDate: string | null` to `ShiftDto`. Because Station bundles extend/contain `ShiftDto`, confirm their public types now require the current server field.

- [ ] **Step 4: Thread the field through every service selection and mapper**

Add `productionDate` to:

- `CURRENT_SHIFT_STORAGE_SELECTION`;
- create insert values;
- planned and active update selections (the mutation restriction is Task 3);
- `joinedSelection()` and `mapShiftRow()`;
- `getReferenceBundle()`'s `bundleShift` (and therefore the normal bundle path that shares the DTO).

The create insert is exact:

```ts
productionDate: data.productionDate ?? null,
```

- [ ] **Step 5: Document the request and response field in OpenAPI**

In `dto.ts`, export request/response schema constants following the existing `shift-exports/dto.ts` pattern. The `productionDate` property must be:

```ts
productionDate: {
  type: "string",
  format: "date",
  nullable: true,
  description: "Declared production date; null keeps legacy date fallback behavior",
},
```

Add `@ApiBody` to `POST /shifts` and `PATCH /shifts/:id`; add `@ApiCreatedResponse` to `POST /shifts`; add `@ApiOkResponse` to `GET /shifts`, `GET /shifts/:id`, `PATCH /shifts/:id`, `POST /shifts/:id/open`, `GET /shifts/:id/bundle`, and `GET /shifts/:id/reference-bundle`. In `shifts-openapi.test.ts`, build a Nest test module and assert both create/PATCH request schemas and shift/bundle response schemas expose `productionDate` with `{ type: "string", format: "date", nullable: true }`.

- [ ] **Step 6: Add database-backed propagation tests**

In `shifts.e2e.test.ts`, prove:

- create with explicit date returns and persists it;
- create with explicit `null` returns null;
- omitted field returns null for a legacy caller;
- GET/list/open/bundle/reference-bundle preserve the explicit date;
- malformed and impossible dates return 400;
- a different tenant cannot read it.

- [ ] **Step 7: Run focused and package checks**

```bash
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/api exec vitest run test/shifts.controller.test.ts test/shifts-openapi.test.ts test/shifts.e2e.test.ts
corepack pnpm --filter @markiro/api typecheck
```

Report any database-backed skips explicitly; a skipped e2e suite does not prove persistence.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/shifts/dto.ts apps/api/src/modules/shifts/shifts.controller.ts apps/api/src/modules/shifts/shifts.service.ts apps/api/test/shifts.controller.test.ts apps/api/test/shifts.e2e.test.ts apps/api/test/shifts-openapi.test.ts
git commit -m "feat(api): propagate shift production date"
```

---

### Task 3: Enforce the first-box mutation lock and exact audit trail

**Files:**

- Modify: `apps/api/src/modules/shifts/shifts.controller.ts`
- Modify: `apps/api/src/modules/shifts/shifts.service.ts`
- Modify: `apps/api/test/shifts.service.test.ts`
- Modify: `apps/api/test/shifts.e2e.test.ts`

**Audit contract:**

```ts
{
  action: "shift.production_date.changed",
  outcome: "success" | "failure",
  targetType: "shift",
  targetId: shiftId,
  before: { productionDate: string | null },
  after: {
    productionDate: string | null;
    reason: "changed" | "box_already_closed" | "shift_closed" | "status_changed";
  }
}
```

- [ ] **Step 1: Write failing service/e2e tests**

Prove all of the following:

- planned and active shifts can set/change/clear the value before a box closes;
- resending the identical value is a no-op and creates no production-date audit row;
- one tenant's box does not lock another tenant's shift;
- any same-tenant box with non-null `closedAt` causes a 409, including a later-disassembled box;
- rejection leaves the shift unchanged and creates one failure audit with exact actor/before/attempt/reason;
- success creates one success audit in the same transaction as the update;
- a production-date mutation on a closed shift retains the existing 409 response and records `shift_closed`;
- a planned/active status race that prevents the guarded update records `status_changed`.

- [ ] **Step 2: Prove the tests fail**

Run:

```bash
corepack pnpm --filter @markiro/api exec vitest run test/shifts.service.test.ts test/shifts.e2e.test.ts
```

- [ ] **Step 3: Pass the cabinet actor into the service**

Change the controller call to:

```ts
return this.shiftsService.updateShift(req.tenantId!, req.userId!, id, body);
```

Change the service signature and all direct test calls to `(tenantId, actorUserId, id, data)`. Detect a requested production-date change before the existing closed-shift branch; when the shift is closed, write the failure audit with `shift_closed` before throwing the existing conflict response.

- [ ] **Step 4: Detect a meaningful production-date change and lock after closure**

Import `isNotNull`. After loading the tenant-scoped current shift:

```ts
const requestedProductionDate = data.productionDate;
const productionDateChanged =
  requestedProductionDate !== undefined && requestedProductionDate !== current.productionDate;

if (productionDateChanged) {
  const [closedBox] = await this.db
    .select({ id: schema.boxes.id })
    .from(schema.boxes)
    .where(
      and(
        eq(schema.boxes.tenantId, tenantId),
        eq(schema.boxes.shiftId, id),
        isNotNull(schema.boxes.closedAt),
      ),
    )
    .limit(1);
  if (closedBox) {
    await this.writeProductionDateAudit(this.db, {
      tenantId,
      actorUserId,
      shiftId: id,
      before: current.productionDate,
      after: requestedProductionDate,
      outcome: "failure",
      reason: "box_already_closed",
    });
    throw new ConflictException({
      code: "PRODUCTION_DATE_LOCKED",
      message: "Production date cannot change after the first box closure",
    });
  }
}
```

The query is tenant-scoped and checks historical closure, not current box state alone.

- [ ] **Step 5: Make successful update plus audit atomic**

Wrap each planned/active update branch in `this.db.transaction`. Insert the success audit through the same transaction only when `productionDateChanged` is true. If the guarded status predicate returns no row, roll back, write one failure audit through `this.db` with `status_changed`, then throw the existing 409. The helper accepts `Pick<Db, "insert">` so rejection paths can use `this.db` and the success path can use `tx`:

```ts
private writeProductionDateAudit(
  writer: Pick<Db, "insert">,
  input: {
    tenantId: string;
    actorUserId: string;
    shiftId: string;
    before: string | null;
    after: string | null;
    outcome: "success" | "failure";
    reason: "changed" | "box_already_closed" | "shift_closed" | "status_changed";
  },
): Promise<unknown> {
  return writer.insert(schema.tenantAuditEvents).values({
    organizationId: input.tenantId,
    actorUserId: input.actorUserId,
    action: "shift.production_date.changed",
    outcome: input.outcome,
    targetType: "shift",
    targetId: input.shiftId,
    before: { productionDate: input.before },
    after: { productionDate: input.after, reason: input.reason },
  });
}
```

- [ ] **Step 6: Run focused checks**

```bash
corepack pnpm --filter @markiro/api exec vitest run test/shifts.service.test.ts test/shifts.e2e.test.ts
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/shifts/shifts.controller.ts apps/api/src/modules/shifts/shifts.service.ts apps/api/test/shifts.service.test.ts apps/api/test/shifts.e2e.test.ts
git commit -m "feat(api): lock and audit production date changes"
```

---

### Task 4: Use the declared production date in shift exports

**Files:**

- Modify: `apps/api/src/modules/shift-exports/shift-export-source.service.ts`
- Modify: `apps/api/test/shift-export-source.test.ts`

- [ ] **Step 1: Add failing fallback tests**

First add `productionDate: string | null` to the local `ShiftRow` fixture interface and default it to null in `closedShift()`. Then add three cases using the existing `fakeDb`, `registryRow`, `codeRow`, and `expectSourceError` helpers:

- `closedShift({ productionDate: "2026-08-20", plannedDate: "2026-08-21" })` resolves with `shiftDate: "2026-08-20"`;
- `closedShift({ productionDate: null, plannedDate: "2026-08-21" })` resolves with `shiftDate: "2026-08-21"`;
- `closedShift({ productionDate: null, plannedDate: null })` rejects with `SHIFT_DATE_MISSING`.

The first two fixtures must include one matching registry/history code so date selection is reached before `SHIFT_HAS_NO_CODES`.

- [ ] **Step 2: Prove they fail**

Run: `corepack pnpm --filter @markiro/api exec vitest run test/shift-export-source.test.ts`

- [ ] **Step 3: Implement one fallback variable**

Select `productionDate`, then replace the existing planned-date check/return with:

```ts
const shiftDate = shift.productionDate ?? shift.plannedDate;
if (shiftDate === null) throw new ShiftExportSourceError("SHIFT_DATE_MISSING");
```

Use `shiftDate` in the existing return object instead of `shift.plannedDate`; do not change any other returned field.

- [ ] **Step 4: Run and commit**

```bash
corepack pnpm --filter @markiro/api exec vitest run test/shift-export-source.test.ts
corepack pnpm --filter @markiro/api typecheck
git add apps/api/src/modules/shift-exports/shift-export-source.service.ts apps/api/test/shift-export-source.test.ts
git commit -m "feat(api): export declared production date"
```

---

### Task 5: Add the optional Admin field without stale overwrites

**Files:**

- Modify: `apps/admin/src/pages/shifts/api.ts`
- Modify: `apps/admin/src/pages/shifts/ShiftForm.tsx`
- Modify: `apps/admin/src/pages/shifts/ShiftPanelRoute.tsx`
- Modify: `apps/admin/src/i18n/en.json`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/test/shifts.test.tsx`

- [ ] **Step 1: Add failing UI/payload tests**

Prove create sends an explicit chosen date, edit can clear it, active edit sends it only when dirty, and null initializes as an empty field (never from `openedAt`). Also prove a server 409 with `PRODUCTION_DATE_LOCKED` is shown and the panel stays open.

- [ ] **Step 2: Prove the tests fail**

Run: `corepack pnpm --filter @markiro/admin exec vitest run test/shifts.test.tsx`

- [ ] **Step 3: Extend Admin types and form state**

Add `productionDate: string | null` to `ShiftDto` and `productionDate?: string | null` to `CreateShiftInput`. Add this field to the Zod form, `EMPTY_VALUES`, initial edit values, primitive dependency list, dirty-field input, and payload builder.

The active-patch rule must be exact:

```ts
if (changed.productionDate) {
  activePayload.productionDate = productionDate ? productionDate : null;
}
```

The edit initializer must be:

```ts
productionDate: shift.productionDate ?? "",
```

Do not fall back to planned/opened date in the form: blank means the stored value is genuinely null.

- [ ] **Step 4: Render the date picker and copy**

Place a second `Controller` in the planning grid, next to shift date:

```tsx
<Controller
  control={control}
  name="productionDate"
  render={({ field }) => (
    <DatePicker
      label={t("pages.shifts.form.productionDateLabel")}
      placeholder={t("common.datePicker.placeholder")}
      clearLabel={t("common.datePicker.clear")}
      calendarLabel={t("common.datePicker.calendar")}
      previousMonthLabel={t("common.datePicker.previousMonth")}
      nextMonthLabel={t("common.datePicker.nextMonth")}
      locale={i18n.language}
      {...(field.value ? { value: field.value } : {})}
      onValueChange={(value) => field.onChange(value ?? "")}
    />
  )}
/>
```

Copy:

- RU label: `Дата производства (для отчётов)`
- RU hint: `Если не указана, этикетки и отчёты используют прежнее правило.`
- EN label: `Production date (for reports)`
- EN hint: `If omitted, labels and reports keep the previous date rule.`

- [ ] **Step 5: Run checks and commit**

```bash
corepack pnpm --filter @markiro/admin exec vitest run test/shifts.test.tsx
corepack pnpm --filter @markiro/admin typecheck
corepack pnpm --filter @markiro/admin lint
git add apps/admin/src/pages/shifts/api.ts apps/admin/src/pages/shifts/ShiftForm.tsx apps/admin/src/pages/shifts/ShiftPanelRoute.tsx apps/admin/src/i18n/en.json apps/admin/src/i18n/ru.json apps/admin/test/shifts.test.tsx
git commit -m "feat(admin): edit shift production date"
```

---

### Task 6: Mirror the field safely in Station SQLite

**Files:**

- Modify: `packages/db/src/sqlite/schema.ts`
- Modify: `packages/db/src/sqlite/migrations.ts`
- Modify: `packages/db/test/sqlite-schema.test.ts`
- Modify: `apps/station/src/lib/mirror.ts`
- Modify: `apps/station/test/mirror.test.ts`

- [ ] **Step 1: Add failing SQLite migration and mirror tests**

Prove:

- a legacy database created before the new trailing ALTER gains nullable `production_date`;
- migrations can run twice;
- explicit date round-trips through `readShiftContext`;
- a later bundle with `productionDate: null` clears it;
- a later legacy bundle omitting `productionDate` preserves the previously mirrored date;
- after a local box has closed, even an explicit changed bundle value preserves the date used on that box's label;
- restart/read after reopening the SQLite database retains it.

- [ ] **Step 2: Prove focused tests fail**

```bash
corepack pnpm --filter @markiro/db exec vitest run test/sqlite-schema.test.ts
corepack pnpm --filter @markiro/station exec vitest run test/mirror.test.ts
```

- [ ] **Step 3: Add authoritative SQLite DDL and schema mirror**

Do not alter only the initial `CREATE TABLE`; deployed devices already have the table. Add to `shiftMirror`:

```ts
productionDate: text("production_date"),
```

Append to the end of `STATION_MIGRATIONS`:

```ts
`ALTER TABLE shift_mirror ADD COLUMN production_date TEXT;`,
```

- [ ] **Step 4: Preserve omission but apply explicit null**

In `StationBundle.shift`, declare:

```ts
/** Current API sends date or null; pre-upgrade API omits the field. */
productionDate?: string | null;
```

In `upsertBundleBody`:

```ts
const productionDateUpdate =
  s.productionDate === undefined
    ? ""
    : `, production_date=CASE
         WHEN EXISTS (
           SELECT 1 FROM boxes_mirror
           WHERE shift_id=excluded.id AND closed_at IS NOT NULL
         ) THEN shift_mirror.production_date
         ELSE excluded.production_date
       END`;
```

Add the insert column/value unconditionally (`s.productionDate ?? null`), but append `${productionDateUpdate}` only to the conflict-update clause. Extend `ShiftContextRow`, the SELECT, and result mapper with `productionDate: string | null`.

- [ ] **Step 5: Run package checks and commit**

```bash
corepack pnpm --filter @markiro/db exec vitest run test/sqlite-schema.test.ts
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/station exec vitest run test/mirror.test.ts test/shift-bundle.test.ts
corepack pnpm --filter @markiro/db typecheck
corepack pnpm --filter @markiro/station typecheck
git add packages/db/src/sqlite/schema.ts packages/db/src/sqlite/migrations.ts packages/db/test/sqlite-schema.test.ts apps/station/src/lib/mirror.ts apps/station/test/mirror.test.ts
git commit -m "feat(station): mirror production date offline"
```

---

### Task 7: Capture the date when Station creates a shift and fail closed against an old API

**Files:**

- Modify: `apps/station/src/pages/NewShift.tsx`
- Modify: `apps/station/src/i18n/en.json`
- Modify: `apps/station/src/i18n/ru.json`
- Modify: `apps/station/test/new-shift.test.tsx`

- [ ] **Step 1: Add failing interaction and compatibility tests**

Prove:

- the resolved-product screen shows an optional date input;
- chosen `2026-08-21` is sent alongside `plannedDate`;
- blank sends `productionDate: null` and keeps legacy behavior;
- matching API echo allows `/open` and `onStarted`;
- missing or different echo for a requested non-null date blocks `/open`, keeps the screen visible, and shows the compatibility message;
- the compatibility check does not block a blank date against an old response.

- [ ] **Step 2: Prove they fail**

Run: `corepack pnpm --filter @markiro/station exec vitest run test/new-shift.test.tsx`

- [ ] **Step 3: Add touch-friendly state and control**

Import `DatePicker`, add `const [productionDate, setProductionDate] = useState("")`, and render it under the mode buttons on the found-product screen. Use Station's existing floor spacing and keep it usable without a hardware keyboard.

Copy:

- RU: `Дата производства`, `Необязательно. Берите с продукции.`
- EN: `Production date`, `Optional. Use the date printed on the product.`

- [ ] **Step 4: Submit and verify the server echo before opening**

Replace the create response type/guard with:

```ts
const requestedProductionDate = productionDate || null;
const created = await client.post<{
  id: string;
  productionDate?: string | null;
}>("/shifts", {
  productId: product.id,
  mode,
  plannedDate: currentLocalDate(),
  productionDate: requestedProductionDate,
  ...(mode === "aggregation" ? { boxLabelTemplateId: selectedTemplateId } : {}),
});

if (requestedProductionDate !== null && created.productionDate !== requestedProductionDate) {
  setError(t("shifts.productionDateNotConfirmed"));
  return;
}
```

Only after this guard may Station call `/shifts/${created.id}/open`. The error copy must explicitly say the shift was not opened and an administrator should remove the incomplete planned shift before retrying after the server update.

- [ ] **Step 5: Run checks and commit**

```bash
corepack pnpm --filter @markiro/station exec vitest run test/new-shift.test.tsx
corepack pnpm --filter @markiro/station typecheck
corepack pnpm --filter @markiro/station lint
git add apps/station/src/pages/NewShift.tsx apps/station/src/i18n/en.json apps/station/src/i18n/ru.json apps/station/test/new-shift.test.tsx
git commit -m "feat(station): capture production date on new shift"
```

---

### Task 8: Make labels and expiry use one effective production date

**Files:**

- Modify: `apps/station/src/lib/box-label.ts`
- Modify: `apps/station/src/pages/WorkScreen.tsx`
- Modify: `apps/station/src/App.tsx`
- Modify: `apps/station/test/box-label.test.ts`
- Modify: `apps/station/test/close-box.test.ts`

- [ ] **Step 1: Add failing pure label tests**

Add `productionDate: string | null` to every `BoxLabelInput` fixture and prove:

- explicit date wins even if close instant is on a different local day;
- null falls back to the current timezone-aware local close date;
- expiry is computed from the same winning date;
- leap-day and year rollover are calendar-correct;
- reprinting the same closed box produces identical date/expiry;
- malformed explicit dates never print a malformed value (API is primary validation; local rendering fails safe).

- [ ] **Step 2: Prove the tests fail**

Run:

```bash
corepack pnpm --filter @markiro/station exec vitest run test/box-label.test.ts test/close-box.test.ts
```

- [ ] **Step 3: Add one effective-date helper without breaking old expiry callers**

Extend `BoxLabelInput` and implement:

```ts
export function effectiveProductionIsoDate(
  closedAt: string,
  productionDate: string | null,
): string {
  if (productionDate !== null) {
    return addCalendarDays(productionDate, 0);
  }
  return localIsoDate(closedAt);
}

export function expiryIsoDate(
  closedAt: string,
  shelfLifeDays: number | null,
  productionDate: string | null = null,
): string {
  if (shelfLifeDays === null || !Number.isInteger(shelfLifeDays) || shelfLifeDays <= 0) return "";
  return addCalendarDays(effectiveProductionIsoDate(closedAt, productionDate), shelfLifeDays);
}
```

Compute the same effective date and guarded expiry once before the existing return object:

```ts
const effectiveDate = effectiveProductionIsoDate(input.closedAt, input.productionDate);
const effectiveExpiry =
  input.shelfLifeDays !== null && Number.isInteger(input.shelfLifeDays) && input.shelfLifeDays > 0
    ? addCalendarDays(effectiveDate, input.shelfLifeDays)
    : "";
```

Replace only the existing return object's `date` and `expiry` expressions with `formatLabelDate(effectiveDate)` and `formatLabelDate(effectiveExpiry)`. Keep every other field unchanged.

- [ ] **Step 4: Thread the mirrored date into every fresh print and reprint**

Add `productionDate?: string | null` to `WorkScreenProps`, pass `shiftContext.productionDate` from `App.tsx`, and include it in `fieldsForClosedBox`. Every print path already funnels through this function using persisted `closedAt`; preserve that invariant.

- [ ] **Step 5: Run checks and commit**

```bash
corepack pnpm --filter @markiro/station exec vitest run test/box-label.test.ts test/close-box.test.ts test/App.test.tsx
corepack pnpm --filter @markiro/station typecheck
corepack pnpm --filter @markiro/station lint
git add apps/station/src/lib/box-label.ts apps/station/src/pages/WorkScreen.tsx apps/station/src/App.tsx apps/station/test/box-label.test.ts apps/station/test/close-box.test.ts
git commit -m "feat(station): print declared production date"
```

---

### Task 9: Build deterministic evidence-package tooling

**Files:**

- Create: `tools/evidence-package/evidence-package.mjs`
- Create: `tools/evidence-package/init.mjs`
- Create: `tools/evidence-package/seal.mjs`
- Create: `tools/evidence-package/verify.mjs`
- Create: `tools/evidence-package/test/evidence-package.test.mjs`
- Modify: `package.json`
- Modify: `.gitignore`

**CLI contract:**

```text
corepack pnpm evidence:init -- <absolute-or-repo-relative-root> <operation-id>
corepack pnpm evidence:seal -- <root>
corepack pnpm evidence:verify -- <root>
```

- [ ] **Step 1: Write failing Node tests in temporary directories**

Use `node:test`, `mkdtemp`, and real bytes. Test deterministic path ordering, SHA-256 values, spaces/Cyrillic in filenames, manifest artifact metadata, successful verification, modified-file failure, missing-file failure, rejection of symlinks, rejection of paths outside the operation root, and refusal to overwrite an already populated raw baseline during `init`.

- [ ] **Step 2: Prove the tests fail**

Run: `node --test tools/evidence-package/test/evidence-package.test.mjs`

- [ ] **Step 3: Implement bounded file enumeration and hashing**

The shared module exports these exact functions:

| Function                      | Return value                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `listEvidenceFiles(root)`     | `Promise<string[]>` of sorted POSIX-relative artifact paths                              |
| `sha256File(path)`            | `Promise<string>` containing 64 lowercase hex characters                                 |
| `buildManifest(root, draft)`  | normalized manifest object preserving operation metadata and replacing the artifact list |
| `sealEvidencePackage(root)`   | `Promise<{ artifactCount: number; checksumCount: number }>`                              |
| `verifyEvidencePackage(root)` | `Promise<{ checkedCount: number }>` or a thrown verification error                       |

Enumeration rules are exact:

- include regular artifact files below root;
- exclude `manifest.json` from the artifact list to avoid a self-referential manifest;
- exclude `SHA256SUMS` while generating it;
- exclude transient `*.tmp` files;
- never follow symlinks;
- normalize relative separators to `/`;
- sort with direct code-point comparison: `(a, b) => (a < b ? -1 : a > b ? 1 : 0)`;
- reject any normalized relative path beginning with `../` or `/`;
- cap file count and manifest byte size with named constants.

Manifest artifact entries are:

```js
{
  path,
  category: path.split("/", 1)[0],
  byteSize,
  sha256,
  capturedAt: prior?.capturedAt ?? draft.updatedAt,
  actor: prior?.actor ?? draft.operator,
  physicalBoxRefs: prior?.physicalBoxRefs ?? [],
  evidenceRefs: prior?.evidenceRefs ?? [],
}
```

Use write-to-sibling-temp plus `rename` for both generated files. `SHA256SUMS` includes the newly written `manifest.json` and every artifact except itself.

- [ ] **Step 4: Implement initializer and verifier**

`init` creates only missing directories/files and refuses an invalid operation id. Accepted id format:

```js
/^INV-\d{8}-[a-z0-9-]{2,40}-\d{2}$/;
```

It creates `baseline/old-sscc.raw.txt` as a zero-byte file, a draft `manifest.json`, and the P0 directories. It never truncates an existing file.

`verify` parses every `SHA256SUMS` line as `<64 lowercase hex><two spaces><relative path>`, rejects duplicates/traversal/symlinks, recomputes hashes, and exits non-zero on any mismatch or missing/unlisted regular file.

- [ ] **Step 5: Add root scripts**

```json
"evidence:init": "node tools/evidence-package/init.mjs",
"evidence:seal": "node tools/evidence-package/seal.mjs",
"evidence:verify": "node tools/evidence-package/verify.mjs",
"test:evidence-package": "node --test tools/evidence-package/test/*.test.mjs"
```

Append `evidence/` to `.gitignore` so a real customer package cannot be staged accidentally. The tooling must still accept an explicitly supplied root outside the repository.

- [ ] **Step 6: Run and commit**

```bash
corepack pnpm test:evidence-package
corepack pnpm exec prettier --check tools/evidence-package package.json .gitignore
git add tools/evidence-package package.json .gitignore
git commit -m "feat(tools): seal first-customer evidence packages"
```

---

### Task 10: Publish the Russian first-day protocol and reusable templates

**Files:**

- Create: `docs/operations/first-customer-inventory/README.md`
- Create: `docs/operations/first-customer-inventory/protocol-v1.md`
- Create: `docs/operations/first-customer-inventory/templates/manifest.draft.json`
- Create: `docs/operations/first-customer-inventory/templates/old-box-index.csv`
- Create: `docs/operations/first-customer-inventory/templates/reconciliation.csv`
- Create: `docs/operations/first-customer-inventory/templates/customer-act.md`
- Create: `docs/operations/first-customer-inventory/templates/consent.json`
- Create: `docs/operations/first-customer-inventory/templates/backup-locations.txt`
- Modify: `docs/superpowers/specs/2026-08-21-analytics-and-impact-evidence-foundation-design.md`

- [ ] **Step 1: Write the protocol as a field checklist**

The Russian protocol must have checkbox gates in this order:

1. authorize scope and identify customer/site;
2. choose one `operationId` and `inventory-recovery-v1`;
3. record founder/operator, one device, timezone, Station/API build, start time;
4. record and independently confirm new SSCC threshold/range;
5. initialize the package and verify device clocks;
6. run a complete real-box rehearsal: scan → close → print → restart → sync → export;
7. scan every old SSCC as exactly one untouched raw line;
8. number physical boxes and fill the sidecar index;
9. photograph every duplicate group with visible physical box numbers;
10. open each box, scan each unit, verify product/date, route exceptions, reform one product + one date, close/print/visually verify;
11. reconcile all required counters and explain every non-zero delta;
12. seal, verify, sign, record consent, make two private copies, and verify each copy.

State plainly that raw SSCC text is used only for legacy accounting/disaggregation, not imported as new Markiro SSCC ownership.
For this operation, prohibit Admin/Station production-date edits after the shift is opened. This closes the unavoidable visibility gap while an offline box closure has not yet reached the API.

- [ ] **Step 2: Define machine-readable templates**

`manifest.draft.json` includes:

```json
{
  "manifestVersion": 1,
  "operationId": "INV-20260824-pilot-01",
  "protocolVersion": "inventory-recovery-v1",
  "customer": { "legalName": "", "site": "" },
  "operator": { "name": "", "role": "founder" },
  "device": { "id": "", "stationVersion": "", "apiVersion": "" },
  "timezone": "Europe/Moscow",
  "newSscc": { "threshold": "", "range": "" },
  "scorecardEligibility": { "eligible": false, "reason": "founder_led_inventory_recovery" },
  "startedAt": null,
  "completedAt": null,
  "artifacts": []
}
```

`consent.json` keeps `customerNaming` and `anonymizedBenchmark` as separate nullable decisions with signer/time/scope. Templates contain no real customer personal data.

- [ ] **Step 3: Review the runbook against the approved design**

Read sections 12, 13, 15, and 17.5 of the approved spec line by line and check the runbook/templates manually against them. Human operational prose is not source-tested: a test that greps required phrases would detect wording changes, not prove the procedure works. Confirm the spec status still links to this P0 plan and the plan still links to the approved spec.

- [ ] **Step 4: Format and commit**

```bash
corepack pnpm exec prettier --check docs/operations/first-customer-inventory docs/superpowers/specs/2026-08-21-analytics-and-impact-evidence-foundation-design.md
git add docs/operations/first-customer-inventory docs/superpowers/specs/2026-08-21-analytics-and-impact-evidence-foundation-design.md
git commit -m "docs(operations): first-customer evidence protocol"
```

---

### Task 11: Run the software release gates and the physical start gate

**Files:**

- No new implementation files expected.
- Populate an untracked/private operation directory outside Git; the examples below use `evidence/INV-20260824-pilot-01/`.

- [ ] **Step 1: Run focused regression suites**

```bash
corepack pnpm --filter @markiro/db build
corepack pnpm --filter @markiro/db test
corepack pnpm --filter @markiro/api exec vitest run test/shifts.controller.test.ts test/shifts.service.test.ts test/shifts.e2e.test.ts test/shifts-openapi.test.ts test/shift-export-source.test.ts
corepack pnpm --filter @markiro/admin exec vitest run test/shifts.test.tsx
corepack pnpm --filter @markiro/station exec vitest run test/mirror.test.ts test/shift-bundle.test.ts test/new-shift.test.tsx test/box-label.test.ts test/close-box.test.ts test/App.test.tsx
corepack pnpm test:evidence-package
```

- [ ] **Step 2: Run package gates**

```bash
corepack pnpm --filter @markiro/db typecheck
corepack pnpm --filter @markiro/db lint
corepack pnpm --filter @markiro/api typecheck
corepack pnpm --filter @markiro/api lint
corepack pnpm --filter @markiro/api build
corepack pnpm --filter @markiro/admin typecheck
corepack pnpm --filter @markiro/admin lint
corepack pnpm --filter @markiro/admin build
corepack pnpm --filter @markiro/station typecheck
corepack pnpm --filter @markiro/station lint
corepack pnpm --filter @markiro/station build
corepack pnpm check:deps
corepack pnpm test:dependency-guard
corepack pnpm format:check
git diff --check
```

Record skipped DB tests and any environment limitation. Do not translate host-only green tests into Windows/hardware acceptance.

- [ ] **Step 3: Enforce rollout order**

1. deploy/apply Postgres migration and API;
2. smoke create/read/bundle/export with a disposable tenant shift;
3. deploy Admin;
4. publish/install Station build;
5. on the actual customer device, create a dated rehearsal shift and confirm the response/mirror;
6. print and inspect a real label;
7. export the closed rehearsal shift and confirm label date equals export date.

Do not install the new Station before the new API is confirmed. The response-echo guard is a failure shield, not a substitute for rollout discipline.

- [ ] **Step 4: Run the physical rehearsal gate**

On the exact Windows device/scanner/printer/label stock:

- check OS, Station, camera, and server clocks/timezone;
- scan a real unit, close a rehearsal box, print, restart Station, reopen/recover, reconnect/sync, and export;
- inspect production date and expiry on the label and in the report;
- verify the new SSCC is at/above the recorded threshold and unique;
- confirm the raw baseline file receives one scanner payload per line;
- photograph a staged duplicate example with physical box numbers;
- seal and verify the rehearsal evidence package.

- [ ] **Step 5: Initialize the real operation only after the rehearsal passes**

```bash
corepack pnpm evidence:init -- evidence/INV-20260824-pilot-01 INV-20260824-pilot-01
```

Fill the draft manifest before the first production scan. Keep the operation directory untracked and private. At checkpoints and close, follow the protocol; after sign-off:

```bash
corepack pnpm evidence:seal -- evidence/INV-20260824-pilot-01
corepack pnpm evidence:verify -- evidence/INV-20260824-pilot-01
```

Copy to two controlled private locations, record non-secret location labels in `backup-locations.txt`, and independently run verification against both copies.

- [ ] **Step 6: Final completion report**

Report separately:

- behavior/files changed;
- automated tests and DB skips;
- browser/manual UI checks;
- Windows/scanner/printer/offline/restart/export evidence;
- manifest/hash verification counts;
- customer reconciliation and signed-act status;
- any unrun gate and why.

P0 is complete only when the real rehearsal and two-copy verification pass. P1 analytics ledgers/projectors, P2 dashboards, and P3 employee scorecards remain separate implementation plans and are not implied complete by this release.
