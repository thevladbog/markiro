# Tenant Admin Production Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the tenant Admin overview with an A2 production-control dashboard whose current totals and period trends are derived from tenant-scoped authoritative facts without combining validation units and aggregation boxes.

**Architecture:** Add an explicit organization operational timezone, then expose one cabinet-only `GET /dashboard/overview` read model built in a read-only repeatable-read transaction. The Admin consumes that response through a focused query hook and renders the approved compact “Прибор” hierarchy with accessible HTML bar charts and contextual units.

**Tech Stack:** Node.js 24+, TypeScript 6, NestJS 11, Drizzle ORM/PostgreSQL 17, Zod 4, React 19, TanStack Query 5, React Router 8, React Testing Library/Vitest, CSS using `@markiro/ui` tokens.

**Spec:** `docs/superpowers/specs/2026-08-27-tenant-admin-dashboard-design.md`

## Global Constraints

- Never add validation units to aggregation boxes or present them on one numeric scale.
- Validation output is accepted individual units; aggregation output is closed non-disassembled boxes plus their current accepted contained units.
- Rate is labelled “per shift hour”; do not claim active-time, downtime-adjusted, quality, or expected-plan metrics.
- “Today” includes all active shifts plus shifts closed in the organization’s stored local calendar day.
- All source queries and joins are tenant-scoped; the client never supplies a tenant id.
- One response is read at one `generatedAt` inside a read-only repeatable-read transaction.
- Empty production in a mode is not an alert. Recorded output with no eligible shift duration is an insufficient-rate alert.
- Active results are provisional and late data is visible.
- Reuse the production “Прибор” tokens and IBM Plex Sans/Mono; do not add a chart or timezone dependency.
- Preserve unrelated work. Stage explicit paths and keep every task in a reviewable commit.
- Write the focused failing test before each behavior change and run it once in the failing state.

---

## File Structure

### Persistence and organization settings

- `packages/db/src/schema/org-profile.ts`: authoritative `org_profiles.time_zone` column.
- `packages/db/migrations/0085_tenant_operational_timezone.sql`: existing-tenant backfill and non-null default.
- `packages/db/migrations/meta/0085_snapshot.json`: generated Drizzle schema snapshot.
- `packages/db/migrations/meta/_journal.json`: generated migration journal entry.
- `packages/db/test/tenant-operational-timezone-migration.test.ts`: migration contract.
- `packages/db/test/schema.test.ts`: Drizzle column/default contract.
- `apps/api/src/lib/time-zone.ts`: bounded reusable IANA validation.
- `apps/api/src/modules/org-profile/{dto.ts,org-profile.service.ts}`: read/write timezone in the existing profile boundary.
- `apps/admin/src/pages/settings/time-zones.ts`: stable operational-timezone choices.
- `apps/admin/src/pages/settings/{api.ts,OrgProfilePage.tsx}`: editable setting.

### Dashboard server read model

- `apps/api/src/modules/dashboard/dto.ts`: query enum, response types, and OpenAPI schemas.
- `apps/api/src/modules/dashboard/dashboard.repository.ts`: repeatable-read aggregation over existing authoritative tables.
- `apps/api/src/modules/dashboard/dashboard.service.ts`: verdict ordering and response composition.
- `apps/api/src/modules/dashboard/dashboard.controller.ts`: guarded cabinet endpoint.
- `apps/api/src/modules/dashboard/dashboard.module.ts`: Nest module wiring.
- `apps/api/src/app.module.ts`: module registration.
- `apps/api/test/dashboard-{dto,repository,service,controller,openapi}.test.ts`: formula, isolation, semantics, access, and contract coverage.
- `apps/api/test/authorization-metadata.test.ts`: route policy inventory.

### Dashboard Admin surface

- `apps/admin/src/pages/dashboard/api.ts`: typed overview hook and period key.
- `apps/admin/src/pages/dashboard/index.tsx`: page orchestration, setup, verdict, headline facts, signals, and active shifts.
- `apps/admin/src/pages/dashboard/ProductionDynamics.tsx`: rate/output controls and separate accessible mode charts.
- `apps/admin/src/pages/dashboard/dashboard.css`: responsive A2 layout and bars.
- `apps/admin/src/i18n/{ru,en}.json`: production copy.
- `apps/admin/test/dashboard.test.tsx`: page states, units, verdict, controls, and accessibility.

---

### Task 1: Persist the Organization Operational Timezone

**Files:**

- Modify: `packages/db/src/schema/org-profile.ts`
- Create: `packages/db/migrations/0085_tenant_operational_timezone.sql`
- Create: `packages/db/migrations/meta/0085_snapshot.json`
- Modify: `packages/db/migrations/meta/_journal.json`
- Create: `packages/db/test/tenant-operational-timezone-migration.test.ts`
- Modify: `packages/db/test/schema.test.ts`

**Interfaces:**

- Produces: `schema.orgProfiles.timeZone: string`, stored in `time_zone`, non-null, default `Europe/Moscow`.
- Consumes: existing `org_profiles` primary key and migration journal.

- [x] **Step 1: Add failing schema and migration assertions**

Add to `packages/db/test/schema.test.ts`:

```ts
it("stores one non-null operational timezone per organization", () => {
  expect(orgProfiles.timeZone.notNull).toBe(true);
  expect(orgProfiles.timeZone.hasDefault).toBe(true);
  expect(orgProfiles.timeZone.default).toBe("Europe/Moscow");
});
```

Create `packages/db/test/tenant-operational-timezone-migration.test.ts` using the repository’s migration-file test pattern and assert that migration `0085` contains exactly one addition equivalent to:

```sql
ALTER TABLE "org_profiles"
ADD COLUMN "time_zone" text DEFAULT 'Europe/Moscow' NOT NULL;
```

The test must also assert that the statement does not update or delete any existing profile row.

- [x] **Step 2: Run the focused tests and confirm the missing column/migration failure**

Run:

```bash
pnpm --filter @markiro/db exec vitest run test/schema.test.ts test/tenant-operational-timezone-migration.test.ts
```

Expected: FAIL because `orgProfiles.timeZone` and migration `0085` do not exist.

- [x] **Step 3: Add the Drizzle column and generate the migration**

Add to `orgProfiles`:

```ts
timeZone: text("time_zone").notNull().default("Europe/Moscow"),
```

Generate, rather than hand-editing Drizzle metadata:

```bash
pnpm --filter @markiro/db db:generate --name tenant_operational_timezone
```

Inspect `0085_tenant_operational_timezone.sql`, the snapshot, and journal. The SQL must use the non-null default in the same statement so existing tenants receive an explicit value without a nullable intermediate state.

- [x] **Step 4: Run DB verification**

Run:

```bash
pnpm --filter @markiro/db exec vitest run test/schema.test.ts test/tenant-operational-timezone-migration.test.ts
pnpm --filter @markiro/db typecheck
pnpm --filter @markiro/db build
```

Expected: all commands PASS.

- [x] **Step 5: Commit the persistence slice**

```bash
git add packages/db/src/schema/org-profile.ts packages/db/migrations/0085_tenant_operational_timezone.sql packages/db/migrations/meta/0085_snapshot.json packages/db/migrations/meta/_journal.json packages/db/test/schema.test.ts packages/db/test/tenant-operational-timezone-migration.test.ts
git commit -m "feat(db): store tenant operational timezone"
```

---

### Task 2: Expose and Edit the Operational Timezone

**Files:**

- Create: `apps/api/src/lib/time-zone.ts`
- Modify: `apps/api/src/modules/org-profile/dto.ts`
- Modify: `apps/api/src/modules/org-profile/org-profile.service.ts`
- Modify: `apps/api/test/org-profile.controller.test.ts`
- Modify: `apps/api/test/org-profile.service.test.ts`
- Create: `apps/admin/src/pages/settings/time-zones.ts`
- Modify: `apps/admin/src/pages/settings/api.ts`
- Modify: `apps/admin/src/pages/settings/OrgProfilePage.tsx`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Modify: `apps/admin/test/org-profile.test.tsx`

**Interfaces:**

- Produces: `isIanaTimeZone(value: string): boolean`, `OrgProfileDto.timeZone`, and `PutOrgProfileDto.timeZone?: string`.
- Consumes: `schema.orgProfiles.timeZone` from Task 1 and the existing profile query cache.

- [x] **Step 1: Add failing API validation and service tests**

Extend the controller schema tests:

```ts
expect(putOrgProfileSchema.safeParse({ timeZone: "Asia/Yekaterinburg" }).success).toBe(true);
expect(putOrgProfileSchema.safeParse({ timeZone: "Mars/Olympus" }).success).toBe(false);
expect(putOrgProfileSchema.safeParse({ timeZone: "" }).success).toBe(false);
```

Extend the service fixtures so the empty/default profile includes:

```ts
timeZone: "Europe/Moscow",
```

Add an upsert test that expects both insert and conflict-update clauses to carry `Asia/Irkutsk` when supplied and to omit `timeZone` from the update set when the field is absent.

- [x] **Step 2: Run the focused API tests and confirm contract failures**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/org-profile.controller.test.ts test/org-profile.service.test.ts
```

Expected: FAIL because the DTO and service do not expose `timeZone`.

- [x] **Step 3: Implement bounded IANA validation and profile persistence**

Create `apps/api/src/lib/time-zone.ts`:

```ts
export function isIanaTimeZone(value: string): boolean {
  if (value.length < 1 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}
```

In the profile DTO, add:

```ts
const timeZoneSchema = z.string().refine(isIanaTimeZone, "timeZone must be an IANA timezone");
// putOrgProfileSchema
timeZone: timeZoneSchema.optional(),
// OrgProfileDto
timeZone: string;
```

Return `row?.timeZone ?? "Europe/Moscow"` from `getProfile`. In `upsertProfile`, add `timeZone` to the insert defaults and to `setClause` only when supplied. Do not infer timezone from the request or process environment.

- [x] **Step 4: Add failing Admin form coverage**

Update `apps/admin/test/org-profile.test.tsx` with a profile fixture containing `timeZone: "Europe/Moscow"`. Assert that the select labelled `Часовой пояс производства` initially selects `Europe/Moscow`, changing it to `Asia/Yekaterinburg` and saving sends:

```json
{ "timeZone": "Asia/Yekaterinburg" }
```

alongside the form’s existing submitted profile fields.

- [x] **Step 5: Run the Admin test and confirm the missing-control failure**

Run:

```bash
pnpm --filter @markiro/admin exec vitest run test/org-profile.test.tsx
```

Expected: FAIL because the profile does not render the timezone control.

- [x] **Step 6: Implement the Admin timezone control**

Create `time-zones.ts` exporting a readonly list of IANA values used by Russian production sites:

```ts
export const OPERATIONAL_TIME_ZONES = [
  "Europe/Kaliningrad",
  "Europe/Moscow",
  "Europe/Samara",
  "Asia/Yekaterinburg",
  "Asia/Omsk",
  "Asia/Novosibirsk",
  "Asia/Krasnoyarsk",
  "Asia/Irkutsk",
  "Asia/Yakutsk",
  "Asia/Vladivostok",
  "Asia/Magadan",
  "Asia/Sakhalin",
  "Asia/Kamchatka",
  "Asia/Anadyr",
] as const;
```

Add `timeZone` to `OrgProfileDto`, `PutOrgProfileInput`, `ProfileFormValues`, defaults, reset mapping, and submit mapping. Render a native `Select` after INN with translated label and a hint that this controls calendar-day dashboard boundaries.

If a stored valid timezone is not in `OPERATIONAL_TIME_ZONES`, append that exact value to the
options so an imported tenant never renders an invalid empty selection.

- [x] **Step 7: Run focused and package-level profile checks**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/org-profile.controller.test.ts test/org-profile.service.test.ts
pnpm --filter @markiro/admin exec vitest run test/org-profile.test.tsx
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/admin typecheck
```

Expected: all commands PASS.

- [x] **Step 8: Commit the profile slice**

```bash
git add apps/api/src/lib/time-zone.ts apps/api/src/modules/org-profile/dto.ts apps/api/src/modules/org-profile/org-profile.service.ts apps/api/test/org-profile.controller.test.ts apps/api/test/org-profile.service.test.ts apps/admin/src/pages/settings/time-zones.ts apps/admin/src/pages/settings/api.ts apps/admin/src/pages/settings/OrgProfilePage.tsx apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/org-profile.test.tsx
git commit -m "feat: configure tenant operational timezone"
```

---

### Task 3: Define the Dashboard Contract

**Files:**

- Create: `apps/api/src/modules/dashboard/dto.ts`
- Create: `apps/api/test/dashboard-dto.test.ts`

**Interfaces:**

- Produces: `DashboardPeriod`, `DashboardOverviewDto`, `DashboardWindowDto`, `DashboardBucketDto`, `DashboardActiveShiftDto`, `DashboardReasonDto`, `DashboardDataQualityDto`, `dashboardOverviewQuerySchema`, and `dashboardOverviewOpenApiSchema`.
- Consumes: the spec’s exact period, unit, verdict, and null-rate semantics.

- [x] **Step 1: Write failing contract tests**

Create `dashboard-dto.test.ts` asserting:

```ts
expect(dashboardOverviewQuerySchema.parse({})).toEqual({ period: "7d" });
expect(dashboardOverviewQuerySchema.parse({ period: "today" })).toEqual({ period: "today" });
expect(dashboardOverviewQuerySchema.safeParse({ period: "year" }).success).toBe(false);
```

Assert the OpenAPI response requires exactly `generatedAt`, `timeZone`, `metricVersion`, `setup`, `verdict`, `today`, `dynamics`, and `activeShifts`; bucket mode objects must expose separate unit fields and nullable rate fields.

- [x] **Step 2: Run the DTO test and confirm the missing-module failure**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/dashboard-dto.test.ts
```

Expected: FAIL because `modules/dashboard/dto.ts` does not exist.

- [x] **Step 3: Implement the query and response types**

Use these discriminants and stable reason codes:

```ts
export const dashboardPeriods = ["today", "7d", "30d", "12w"] as const;
export type DashboardPeriod = (typeof dashboardPeriods)[number];
export type DashboardVerdict = "under_control" | "needs_attention" | "critical";
export type DashboardReasonCode = "unreviewed_conflicts" | "late_data" | "missing_shift_duration";
export type DashboardQualityStatus = "complete" | "provisional" | "insufficient";
export type DashboardQualityReasonCode = "active_shifts" | "late_data" | "missing_shift_duration";
export type DashboardGrain = "hour" | "day" | "week";
```

Define `DashboardWindowDto` with `start`, `end`, and the same `validation`/`aggregation` metric objects used by buckets. Define `DashboardActiveShiftDto.output` as a discriminated union:

```ts
type DashboardShiftOutputDto =
  | { mode: "validation"; acceptedUnits: number }
  | { mode: "aggregation"; closedBoxes: number; containedUnits: number };
```

Set the query default with:

```ts
export const dashboardOverviewQuerySchema = z.object({
  period: z.enum(dashboardPeriods).default("7d"),
});
```

Build explicit Swagger object schemas; do not use broad `additionalProperties` for metric objects.

- [x] **Step 4: Run DTO tests and typecheck**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/dashboard-dto.test.ts
pnpm --filter @markiro/api typecheck
```

Expected: PASS.

- [x] **Step 5: Commit the contract**

```bash
git add apps/api/src/modules/dashboard/dto.ts apps/api/test/dashboard-dto.test.ts
git commit -m "feat(api): define tenant dashboard contract"
```

---

### Task 4: Build the Tenant-Scoped Dashboard Repository

**Files:**

- Create: `apps/api/src/modules/dashboard/dashboard.repository.ts`
- Create: `apps/api/test/dashboard-repository.test.ts`

**Interfaces:**

- Consumes: `DashboardPeriod` and response metric shapes from Task 3; `orgProfiles.timeZone` from Task 1.
- Produces: `DashboardRepository.load(tenantId: string, period: DashboardPeriod, now: Date): Promise<DashboardOverviewFacts>` and injectable `DrizzleDashboardRepository`.

- [x] **Step 1: Create a database-backed failing fixture**

Use the repository’s migrated-test-DB pattern. Seed `tenant-a` and `tenant-b`, then seed for `tenant-a`:

- one validation shift opened yesterday and still active;
- one aggregation shift closed today;
- one aggregation shift closed before today;
- authoritative `code_registry` rows in both tenants;
- one closed eligible box, one open box, and one disassembled box;
- active, displaced, and removed `box_items`;
- one unreviewed conflict affecting the included validation shift;
- one included shift with `late_data_at`.

Fix `now` to `2026-08-27T12:00:00.000Z` and store `Asia/Yekaterinburg`. Assert:

```ts
expect(facts.timeZone).toBe("Asia/Yekaterinburg");
expect(facts.today.validationAcceptedUnits).toBe(2);
expect(facts.today.aggregationClosedBoxes).toBe(1);
expect(facts.today.aggregationContainedUnits).toBe(2);
expect(facts.setup.activeShiftCount).toBe(1);
expect(facts.unreviewedConflictCount).toBe(1);
expect(facts.lateDataShiftCount).toBe(1);
expect(facts.activeShifts[0]?.output).toEqual({ mode: "validation", acceptedUnits: 2 });
```

Assert every `tenant-b` fact is absent. Assert the current `7d` window and comparison window have equal local-clock shape and each bucket carries only its own mode’s facts.

- [x] **Step 2: Run the repository test and confirm the missing repository failure**

Run:

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/api exec vitest run test/dashboard-repository.test.ts
```

Expected: FAIL because `DashboardRepository` does not exist. If `DATABASE_URL` is absent, the test must report an explicit skip; run it again with the development test database before accepting this task.

- [x] **Step 3: Implement the repeatable-read repository boundary**

Define:

```ts
export interface DashboardOverviewFacts {
  generatedAt: Date;
  timeZone: string;
  setup: {
    productCount: number;
    shiftCount: number;
    hasRunShift: boolean;
    activeShiftCount: number;
  };
  today: {
    validationAcceptedUnits: number;
    aggregationClosedBoxes: number;
    aggregationContainedUnits: number;
    activeShiftCount: number;
    includedClosedShiftCount: number;
  };
  currentWindow: DashboardWindowDto;
  comparisonWindow: DashboardWindowDto;
  buckets: DashboardBucketDto[];
  activeShifts: DashboardActiveShiftDto[];
  unreviewedConflictCount: number;
  lateDataShiftCount: number;
  missingDurationModes: Array<"validation" | "aggregation">;
}
```

`load` must call:

```ts
return this.db.transaction((tx) => this.loadFromTransaction(tx, tenantId, period, now), {
  isolationLevel: "repeatable read",
  accessMode: "read only",
});
```

Use the `now` argument as `generatedAt` and bind that same instant into every query in the
transaction. `DashboardService` captures it once immediately before calling the repository; tests
inject the fixed instant. Reject an invalid stored timezone even though the write boundary validates
it.

- [x] **Step 4: Implement timezone-safe SQL windows and buckets**

Build a `window_config` CTE from `generatedAt AT TIME ZONE timeZone`. Use these local starts:

```sql
CASE period
  WHEN 'today' THEN date_trunc('day', local_now)
  WHEN '7d' THEN date_trunc('day', local_now) - interval '6 days'
  WHEN '30d' THEN date_trunc('day', local_now) - interval '29 days'
  WHEN '12w' THEN date_trunc('week', local_now) - interval '11 weeks'
END
```

Convert local boundaries back with `local_boundary AT TIME ZONE time_zone`. Shift the current local window by exactly `1 day`, `7 days`, `30 days`, or `12 weeks` for its comparison. Generate hourly/daily/weekly buckets with `generate_series`. Convert every bucket edge through the stored timezone so DST days use actual elapsed seconds.

- [x] **Step 5: Implement authoritative metric queries**

For every count and join, include `tenant_id = tenantId` and join on both tenant and object id.

- Validation accepted units: count `code_registry` rows joined to `shifts.mode = 'validation'` by `code_registry.scanned_at` for trend buckets.
- Aggregation boxes: count boxes with `closed_at is not null` and `disassembled_at is null` joined to `shifts.mode = 'aggregation'`, bucketed by `closed_at`.
- Contained units: count `box_items` for eligible closed boxes where `displaced_at is null` and `removed_at is null`, attributed to the box’s close bucket.
- Shift hours: sum the positive overlap in seconds between each shift interval and bucket interval, divide by 3600, and keep the unrounded value until response mapping.
- Headline today: first select included shift ids using active-or-closed-in-local-day semantics, then count the current output belonging to those ids without a second occurrence-time filter.
- Active shifts: group contextual output by shift and return at most five rows ordered by `opened_at`, then shift id.
- Conflicts: count distinct unreviewed conflict ids where either losing or winning shift is included.

Map PostgreSQL count/numeric strings explicitly; rates are `null` when shift hours are zero and otherwise rounded to one decimal place.

- [x] **Step 6: Add DST and cross-tenant regression cases**

Seed a `Europe/Berlin` profile around `2026-03-29`. Assert the local-day bucket spans 23 elapsed hours while labels and comparison remain civil-day aligned. Seed identical shift UUID-shaped facts in the other tenant where constraints permit and assert no count or join crosses the tenant boundary.

- [x] **Step 7: Run repository, type, lint, and build checks**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/dashboard-repository.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
```

Expected: PASS, with no database skip in the accepted run.

- [x] **Step 8: Commit the repository**

```bash
git add apps/api/src/modules/dashboard/dashboard.repository.ts apps/api/test/dashboard-repository.test.ts
git commit -m "feat(api): aggregate tenant dashboard facts"
```

---

### Task 5: Compose and Protect the Dashboard Endpoint

**Files:**

- Create: `apps/api/src/modules/dashboard/dashboard.service.ts`
- Create: `apps/api/src/modules/dashboard/dashboard.controller.ts`
- Create: `apps/api/src/modules/dashboard/dashboard.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: `apps/api/test/dashboard-service.test.ts`
- Create: `apps/api/test/dashboard-controller.test.ts`
- Create: `apps/api/test/dashboard-openapi.test.ts`
- Modify: `apps/api/test/authorization-metadata.test.ts`

**Interfaces:**

- Consumes: `DashboardRepository.load` from Task 4 and response types from Task 3.
- Produces: `DashboardService.overview(tenantId, period): Promise<DashboardOverviewDto>` and `GET /dashboard/overview`.

- [x] **Step 1: Write failing service verdict tests**

Use a fake repository and fixed clock. Cover these exact precedence rules:

```ts
// conflict wins over all attention reasons
expect(result.verdict.status).toBe("critical");
expect(result.verdict.reasons.map((reason) => reason.code)).toEqual([
  "unreviewed_conflicts",
  "late_data",
  "missing_shift_duration",
]);
```

Also assert:

- active data with no problem yields `under_control` plus `quality.status = provisional`;
- no active data and no reasons yields `quality.status = complete`;
- raw output plus missing duration yields `needs_attention` and `quality.status = insufficient`;
- an empty unused mode does not create a reason;
- `metricVersion` is exactly `operations-dashboard-v1`.

- [x] **Step 2: Run service tests and confirm the missing-service failure**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/dashboard-service.test.ts
```

Expected: FAIL because the service does not exist.

- [x] **Step 3: Implement deterministic verdict composition**

Inject a clock function defaulting to `() => new Date()`. Order reasons by severity then code, with these routes:

```ts
const reasonRoutes = {
  unreviewed_conflicts: "/conflicts",
  late_data: "/shifts",
  missing_shift_duration: "/shifts",
} as const;
```

Return reason counts and affected modes from facts. Determine quality independently from verdict: missing duration is `insufficient`; otherwise active or late facts are `provisional`; otherwise `complete`.

- [x] **Step 4: Write failing controller, guard, and OpenAPI tests**

Assert the controller:

- parses an absent period as `7d`;
- passes `req.tenantId`, never a body/query tenant id;
- carries `TenantGuard`, `AuthorizationGuard`, and `SubscriptionAccessGuard`;
- requires `CABINET_CAPABILITY.OPERATIONS_READ`;
- permits subscription read-only access;
- documents the period enum and exact 200 response schema.

- [x] **Step 5: Implement the controller and module**

Use:

```ts
@Controller("dashboard")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
@RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
export class DashboardController {
  @Get("overview")
  @ApiOkResponse({ schema: dashboardOverviewOpenApiSchema })
  overview(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(dashboardOverviewQuerySchema)) query: DashboardOverviewQueryDto,
  ): Promise<DashboardOverviewDto> {
    return this.dashboard.overview(req.tenantId!, query.period);
  }
}
```

Register the repository token, Drizzle implementation, service, and controller in `DashboardModule`, then import it in `AppModule.forRoot()`.

- [x] **Step 6: Run focused API checks**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/dashboard-service.test.ts test/dashboard-controller.test.ts test/dashboard-openapi.test.ts test/authorization-metadata.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
```

Expected: PASS.

- [x] **Step 7: Commit the endpoint**

```bash
git add apps/api/src/modules/dashboard apps/api/src/app.module.ts apps/api/test/dashboard-service.test.ts apps/api/test/dashboard-controller.test.ts apps/api/test/dashboard-openapi.test.ts apps/api/test/authorization-metadata.test.ts
git commit -m "feat(api): expose tenant production overview"
```

---

### Task 6: Replace Client-Side Aggregation with the Dashboard Query

**Files:**

- Create: `apps/admin/src/pages/dashboard/api.ts`
- Modify: `apps/admin/src/pages/dashboard/index.tsx`
- Modify: `apps/admin/test/dashboard.test.tsx`

**Interfaces:**

- Consumes: `GET /dashboard/overview` from Task 5.
- Produces: `useDashboardOverview(period: DashboardPeriod): UseQueryResult<DashboardOverviewDto>` and one server-owned page state.

- [x] **Step 1: Rewrite failing page-state tests around the new endpoint**

Replace the four-list default fetch stub with:

```ts
if (url.endsWith("/api/dashboard/overview?period=7d")) {
  return jsonResponse(200, dashboardFixture());
}
```

The fixture must include all contract fields and use different values for validation units, boxes, and contained units. Preserve tests for loading, one retry action, and first-shift setup. Assert that the initial render makes only one dashboard overview request.

- [x] **Step 2: Run the dashboard test and confirm old requests fail**

Run:

```bash
pnpm --filter @markiro/admin exec vitest run test/dashboard.test.tsx
```

Expected: FAIL because the page still requests products, shifts, lines, and conflicts.

- [x] **Step 3: Implement the typed query hook**

In `api.ts`, mirror the server DTO without `any` and define:

```ts
export const DASHBOARD_QUERY_KEY = ["dashboard", "overview"] as const;

export function useDashboardOverview(period: DashboardPeriod) {
  return useQuery({
    queryKey: [...DASHBOARD_QUERY_KEY, period],
    queryFn: () =>
      apiFetch<DashboardOverviewDto>(`/dashboard/overview?period=${encodeURIComponent(period)}`),
  });
}
```

- [x] **Step 4: Move loading, failure, and setup states to the new response**

Remove `useProducts`, `useShifts`, `useLines`, and `useConflicts` from the dashboard page. Drive the setup action from `overview.setup.productCount`, `shiftCount`, and `hasRunShift`. Retry only the overview query. Keep the existing access-capability behavior for setup actions.

- [x] **Step 5: Run focused Admin checks**

Run:

```bash
pnpm --filter @markiro/admin exec vitest run test/dashboard.test.tsx
pnpm --filter @markiro/admin typecheck
```

Expected: PASS for loading, failure, retry, setup, and single-request behavior.

- [x] **Step 6: Commit the client data boundary**

```bash
git add apps/admin/src/pages/dashboard/api.ts apps/admin/src/pages/dashboard/index.tsx apps/admin/test/dashboard.test.tsx
git commit -m "refactor(admin): read dashboard server summary"
```

---

### Task 7: Implement the A2 Production-Control Screen

**Files:**

- Create: `apps/admin/src/pages/dashboard/ProductionDynamics.tsx`
- Modify: `apps/admin/src/pages/dashboard/index.tsx`
- Modify: `apps/admin/src/pages/dashboard/dashboard.css`
- Modify: `apps/admin/src/i18n/ru.json`
- Modify: `apps/admin/src/i18n/en.json`
- Modify: `apps/admin/test/dashboard.test.tsx`

**Interfaces:**

- Consumes: `DashboardOverviewDto`, `DashboardPeriod`, and `useDashboardOverview` from Task 6.
- Produces: A2 verdict, headline facts, rate/output dynamics, attention signals, and contextual active-shift table.

- [x] **Step 1: Add failing semantic and interaction tests**

With `i18n` set to Russian, assert:

```ts
expect(screen.getByRole("heading", { name: "Производство сегодня" })).toBeDefined();
expect(screen.getByText("Проверено поштучно")).toBeDefined();
expect(screen.getByLabelText(/128[\s\u00a0]?489 проверенных единиц/)).toBeDefined();
expect(screen.getByLabelText(/412 закрытых коробов/)).toBeDefined();
expect(screen.getByLabelText(/10[\s\u00a0]?712 единиц в коробах/)).toBeDefined();
expect(screen.queryByText(/138[\s\u00a0]?789/)).toBeNull();
```

Assert `Темп` is initially selected, `Выпуск` switches the bar labels without changing period, and selecting `30 дней` requests `/api/dashboard/overview?period=30d` while exposing `aria-pressed="true"`. Assert validation and aggregation charts have distinct region labels and units. Assert a critical conflict reason links to `/conflicts`.

- [x] **Step 2: Run the test and confirm the A2 elements are absent**

Run:

```bash
pnpm --filter @markiro/admin exec vitest run test/dashboard.test.tsx
```

Expected: FAIL on the new heading, controls, and separate chart regions.

- [x] **Step 3: Build the page hierarchy**

In `index.tsx`, render in this order:

1. `PageHeader` with title, tenant-local date/timezone, and `<time dateTime={generatedAt}>` freshness;
2. verdict section with status text and ordered linked reasons;
3. four-cell headline strip for validation units, aggregation boxes, contained units, and active shifts;
4. two-column operational row containing `ProductionDynamics` and control signals;
5. active-shift table capped by the server response.

For active-shift output, branch on the discriminated union. Render validation as `N шт.` and aggregation as `N кор. · M шт.`. Link read-only users to `/shifts`; link writable users to `/shifts/{id}/edit`.

Label the headline strip as “active shifts plus shifts completed today” so its complete active-shift
totals are not mistaken for the occurrence-time buckets below.

- [x] **Step 4: Implement accessible separate-mode charts**

`ProductionDynamics` owns UI-only state `metric: "rate" | "output"`; the parent owns `period`. Compute each chart’s maximum only from its own series. Render zero as a labelled zero bar; render null rate as an em dash with the translated insufficient-data explanation.

Use native buttons:

```tsx
<button type="button" aria-pressed={metric === "rate"} onClick={() => setMetric("rate")}>
  {t("pages.dashboard.dynamics.rate")}
</button>
```

Render bars as ordinary elements with `aria-label` containing bucket label, exact value, and unit. Provide an adjacent visually-hidden list with the same values so assistive technology receives a table-equivalent sequence. Do not use canvas, SVG paths, or a chart dependency.

- [x] **Step 5: Implement the compact “Прибор” CSS**

Use only existing variables such as `--surface-card`, `--surface-panel`, `--line`, `--fg-1`, `--fg-3`, `--ok-solid`, `--warn-solid`, `--err-solid`, `--font-ui`, and `--font-mono`.

Required responsive behavior:

- desktop: dynamics takes roughly two thirds and signals one third;
- below 1024px: operational row becomes one column;
- below 768px: headline facts and charts stack; controls wrap; page padding uses existing compact mobile spacing;
- tables retain horizontal scrolling;
- focus-visible uses the system focus ring;
- transitions use the repository’s short utility timing and are disabled under `prefers-reduced-motion`.

- [x] **Step 6: Add exact Russian and English copy**

Add keys for verdict states/reasons, headline labels, data-quality states, metric/period controls, per-shift-hour units, no-data explanations, comparison labels, and contextual active-shift output. Russian must use `Проверка`, `Агрегация`, `шт./час смены`, and `коробов/час смены`; English must use `Validation`, `Aggregation`, `units/shift hour`, and `boxes/shift hour`.

- [x] **Step 7: Run Admin tests and static gates**

Run:

```bash
pnpm --filter @markiro/admin exec vitest run test/dashboard.test.tsx
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck
pnpm --filter @markiro/admin lint
pnpm --filter @markiro/admin build
```

Expected: PASS.

- [x] **Step 8: Commit the production screen**

```bash
git add apps/admin/src/pages/dashboard/ProductionDynamics.tsx apps/admin/src/pages/dashboard/index.tsx apps/admin/src/pages/dashboard/dashboard.css apps/admin/src/i18n/ru.json apps/admin/src/i18n/en.json apps/admin/test/dashboard.test.tsx
git commit -m "feat(admin): add production control dashboard"
```

---

### Task 8: Verify the Complete Slice and Visual Result

**Files:**

- Modify: `docs/superpowers/specs/2026-08-27-tenant-admin-dashboard-design.md`
- Modify: `docs/superpowers/plans/2026-08-27-tenant-admin-dashboard.md`
- Update generated local graph: `graphify-out/` (ignored, do not stage)

**Interfaces:**

- Consumes: all completed tasks.
- Produces: verified branch, browser evidence, completed spec/plan status, and updated local graph.

- [x] **Step 1: Run focused cross-package regression checks**

Run with the development test database loaded:

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/db test
pnpm --filter @markiro/api exec vitest run test/dashboard-dto.test.ts test/dashboard-repository.test.ts test/dashboard-service.test.ts test/dashboard-controller.test.ts test/dashboard-openapi.test.ts test/authorization-metadata.test.ts test/org-profile.controller.test.ts test/org-profile.service.test.ts
pnpm --filter @markiro/admin exec vitest run test/dashboard.test.tsx test/org-profile.test.tsx
```

Expected: PASS with no dashboard repository database skip.

- [x] **Step 2: Run package gates**

```bash
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
pnpm format:check
git diff --check
```

Expected: PASS. Report any infrastructure-driven skips separately rather than treating them as coverage.

- [x] **Step 3: Run desktop and narrow browser validation**

Start the repository’s development services and Admin. Seed one validation shift, one aggregation shift, separate outputs, an attention reason, and a previous comparison window. Capture and inspect:

- desktop at 1440×1024;
- narrow layout at 390×844;
- keyboard traversal through metric controls, periods, reasons, and shift links;
- reduced-motion mode;
- empty validation series and empty aggregation series separately;
- dark theme contrast.

The browser pass fails if units share a scale, text clips, controls overflow, a chart relies only on color, or a provisional result lacks its marker.

- [x] **Step 4: Update documentation status and local graph**

Change the spec status to `Implemented and verified` only after Steps 1–3 pass. Mark every completed plan checkbox. Run:

```bash
graphify update .
```

Do not stage `graphify-out/`.

- [x] **Step 5: Review and commit the final evidence state**

```bash
git status --short
git diff --stat ffd3d4497..HEAD
git diff --check
git add docs/superpowers/specs/2026-08-27-tenant-admin-dashboard-design.md docs/superpowers/plans/2026-08-27-tenant-admin-dashboard.md
git commit -m "docs: record dashboard verification"
```

Review the staged paths before committing. The completion report must distinguish automated API/Admin proof from the manual browser pass and state that no Windows, scanner, printer, or live-production environment was exercised.
