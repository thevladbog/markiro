# Platform Usage and Evidence Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three SaaS-admin report types (`usage`, `quality`, `commercial`) at tenant × local-day grain to the existing platform-report pipeline.

**Architecture:** The report type lives in the `platform_reports.parameters` jsonb, so there is no migration, queue or capability change. Each type is a SQL source built on the existing `reportRows`, `tenantScope` and `inWindow` helpers that pivots per-family metric rows into one row per tenant and local day. The existing renderer, privacy layer and reports page are extended for tenant labels, per-type definitions, `definitionsVersion` and `dataSha256`.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), NestJS, Drizzle raw SQL on Postgres, Zod, fflate, React, Vitest.

**Spec:** [`docs/superpowers/specs/2026-09-30-platform-usage-evidence-reports-design.md`](../specs/2026-09-30-platform-usage-evidence-reports-design.md)

## Global Constraints

- Three new `reportType` values: `usage`, `quality`, `commercial`. Row grain is one tenant and one local calendar day in the selected IANA timezone.
- Explicit tenant selection (1–10), inclusive local dates, maximum 366 days, `periodBasis=events` only. These contract limits do not change.
- All optional filters (`lineId`, `productId`, `gtin14`, `operatorId`, `status`, `outcome`) are rejected for the new types.
- A row exists only for a tenant-day with at least one recorded fact; a missing row is not a measured zero. Inside an emitted row a metric with no events is `0`.
- Every numeric column is an additive count or sum. Lag is reported as bucket counts, never averages or percentiles.
- All amounts are RUB, integer kopecks, cast to `float8` in SQL. Counts are cast to `int`.
- Time basis: server clock wherever it exists; the device clock only where no server time exists, and each definition names its clock.
- `accepted_units` uses `scan_events` with `verdict='ok'`, not `code_registry`.
- Privacy: `identified` shows `tenant_id` and `tenant_name`; `pseudonymous` replaces both with the same label `tenant-01`, `tenant-02`, … assigned in ascending tenant-id order; `aggregate` removes both columns and sums days across the selected tenants. Outside `identified`, `metadata.json` parameters omit `tenantIds` and record `tenantCount`.
- `metadata.json` gains `definitionsVersion` and `dataSha256` (SHA-256 of the exact `data.csv` bytes). The five existing artifacts keep their current definitions content.
- No database migration, no new capability, no new queue. Artifact retention stays seven days.
- Badge, PIN, raw scan code, authentication material and integration credentials are never exported.
- `inventory-report-source.ts` and the `inventories` artifact do not change.
- Node 24+, repository-declared pnpm through Corepack; no new dependencies; no production connection for development or tests.

## Test database

DB-backed tests skip unless `DATABASE_URL` points at `localhost` or `127.0.0.1`. Shared development Postgres can drift from this branch's migrations, so use a disposable database:

```bash
docker run -d --rm --name markiro-evidence-reports-pg \
  -e POSTGRES_USER=markiro -e POSTGRES_PASSWORD=markiro -e POSTGRES_DB=markiro \
  -p 55433:5432 postgres:17-alpine
export DATABASE_URL=postgres://markiro:markiro@localhost:55433/markiro
pnpm --filter @markiro/db build
pnpm --filter @markiro/db db:migrate
```

If Docker is unavailable, every DB-backed step below skips. Report that explicitly instead of claiming the SQL is verified.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `docs/superpowers/specs/2026-09-30-platform-usage-evidence-reports-design.md` | modify | correct facts found during planning |
| `packages/platform-contracts/src/platform-reports.ts` | modify | new type values, guard, filter rejection |
| `packages/platform-contracts/src/index.ts` | modify | export the guard and type list |
| `packages/platform-contracts/test/platform-reports.test.ts` | modify | contract tests |
| `apps/api/src/platform-reports/report-definitions.ts` | modify | `REPORT_DEFINITIONS_VERSION`, common evidence definitions, tenant privacy |
| `apps/api/src/platform-reports/report-renderer.ts` | modify | `definitionsVersion`, `dataSha256`, tenant-id stripping |
| `apps/api/src/platform-reports/report-query.ts` | modify | `localDay`, `pivotMetrics` |
| `apps/api/src/platform-reports/usage-report-source.ts` | create | `usage` columns, definitions, SQL |
| `apps/api/src/platform-reports/quality-report-source.ts` | create | `quality` columns, definitions, SQL, inventory merge |
| `apps/api/src/platform-reports/commercial-report-source.ts` | create | `commercial` columns, definitions, SQL |
| `apps/api/src/platform-reports/report-source.service.ts` | modify | dispatch and per-type definitions |
| `apps/api/test/support/platform-report-evidence-base.ts` | create | shared tenant fixture and cleanup |
| `apps/api/test/platform-report-evidence-privacy.test.ts` | create | pure privacy, renderer and metadata tests |
| `apps/api/test/platform-report-evidence-definitions.test.ts` | create | every column has a definition |
| `apps/api/test/platform-report-usage-source.test.ts` | create | DB test for `usage` |
| `apps/api/test/platform-report-quality-source.test.ts` | create | DB test for `quality` and the pure merge |
| `apps/api/test/platform-report-commercial-source.test.ts` | create | DB test for `commercial` |
| `apps/saas-admin/src/pages/reports/ReportsPage.tsx` | modify | selector, hidden filters, privacy help |
| `apps/saas-admin/src/i18n/en.json`, `ru.json` | modify | labels and help text |
| `apps/saas-admin/test/reports-page.test.tsx` | modify | UI tests |
| `docs/operations/platform-report-exports.md` | modify | operations guide |

---

### Task 1: Correct the spec with facts found while planning

**Files:**
- Modify: `docs/superpowers/specs/2026-09-30-platform-usage-evidence-reports-design.md`

**Interfaces:**
- Produces: a spec that matches the plan. No code depends on it.

Facts verified in code while writing this plan: `payments` (legacy, offer payments) has a RUB check constraint, and offer payments write only `payments` while invoice payments write only `billing_payments`, so the flows are disjoint; `print_verified_at` is the station's device clock carried in the closure record; `quality` can read the inventory projection without changing `inventory-report-source.ts`.

- [ ] **Step 1: Apply the corrections with a checked script**

```bash
node --input-type=module <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
const path = "docs/superpowers/specs/2026-09-30-platform-usage-evidence-reports-design.md";
let text = readFileSync(path, "utf8");
const replace = (from, to) => {
  if (!text.includes(from)) throw new Error("missing: " + from.slice(0, 60));
  text = text.replace(from, to);
};
replace(
  "RUB is enforced by check constraints on `invoices` and `billing_payments`; the legacy `payments` table has no currency column and is treated as RUB (see §7).",
  "RUB is enforced by check constraints on `invoices`, `billing_payments` and the legacy `payments` table.",
);
replace(
  "| the union of `billing_payments` and legacy `payments` at `paid_at`; partial payments are counted when received |",
  "| the union of `billing_payments` (invoice payments) and legacy `payments` (offer payments) at `paid_at`. The flows are disjoint: an offer payment writes only `payments` and an invoice payment writes only `billing_payments`, so they are summed without deduplication. Partial payments are counted when received |",
);
replace(
  "| boxes with `print_verified_at` on the day | as recorded on the box row |",
  "| boxes with `print_verified_at` on the day | device time: the station's clock carried in the closure record |",
);
replace(
  "3. `inventory-report-source.ts`: expose the inventory completion time additively so `quality` can derive the inventory columns from the existing projection instead of re-implementing it.",
  "3. `quality-report-source.ts` reads the existing inventory projection through `loadInventoryRows` (unchanged) and joins it in code to a small completion query on `inventories.completed_at`. `inventory-report-source.ts` and the `inventories` artifact do not change.",
);
replace(
  "5. `report-renderer.ts` and `report-source.service.ts`: metadata additions (§5).",
  "5. `report-renderer.ts`: metadata additions and tenant-id stripping (§4, §5). `report-source.service.ts`: dispatch and per-type definitions, so the three new artifacts carry only their own definitions and the five existing artifacts keep their current definitions content.",
);
replace(
  "`applyReportPrivacy` today knows only the operator fields",
  "Outside `identified`, `metadata.json` parameters omit `tenantIds` and record `tenantCount`, and the definitions carry the anonymization warning. `applyReportPrivacy` today knows only the operator fields",
);
replace(
  "- Privacy: no tenant name in the bytes of pseudonymous or aggregate artifacts;",
  "- Privacy: no tenant name or tenant id in the bytes of pseudonymous or aggregate artifacts, including `metadata.json` parameters;",
);
const start = text.indexOf("## 7. Implementation checks");
const end = text.indexOf("## 8. Testing and acceptance");
if (start < 0 || end < 0) throw new Error("section 7 or 8 not found");
const section = [
  "## 7. Implementation checks",
  "",
  "These must be confirmed against a local database before the corresponding column ships. If a check fails, the stated action applies.",
  "",
  "1. **Scan-event query cost.** `scan_events` is partitioned monthly with a `(shift_id, scanned_at)` index. Reach it through the tenant's shifts and the window, as the shift source does, and confirm with `EXPLAIN` on a local database that a 366-day, 10-tenant run stays inside the 60-second statement timeout. If it does not, narrow the shift preselection before considering an index.",
  "2. **Cast rules.** Cast counts to `::int` and kopecks to `::float8` in SQL. `reportRows` rejects booleans, jsonb and arrays, returns bigint and numeric as strings, and the aggregate privacy mode sums only JavaScript numbers.",
  "3. **Timezone.** Local day is `(ts AT TIME ZONE tz)::date`, matching `inWindow`. Check a DST-observing zone as well as Europe/Moscow.",
  "4. **Grouping by a local-day expression.** The timezone is a bind parameter, so Postgres treats the same expression written in `SELECT` and in `GROUP BY` as two different expressions. Group by ordinal position or by an aliased CTE column, never by the repeated expression.",
  "",
  "",
].join("\n");
text = text.slice(0, start) + section + text.slice(end);
writeFileSync(path, text);
EOF
```

- [ ] **Step 2: Check the result is formatted and only the intended lines changed**

Run: `pnpm exec prettier --check docs/superpowers/specs/2026-09-30-platform-usage-evidence-reports-design.md && git diff --stat`
Expected: `All matched files use Prettier code style!` and one changed file.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-30-platform-usage-evidence-reports-design.md
git commit -m "docs(specs): correct payment flows, print clock and inventory join in the usage report spec" \
  -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Contract — three new report types

**Files:**
- Modify: `packages/platform-contracts/src/platform-reports.ts` (the `platformReportTypeSchema` enum at line 9, and the `superRefine` block after the `commerceml` branch)
- Modify: `packages/platform-contracts/src/index.ts` (the `platform-reports.js` export block)
- Test: `packages/platform-contracts/test/platform-reports.test.ts`

**Interfaces:**
- Produces: `platformEvidenceReportTypes` (`readonly ["usage","quality","commercial"]`), `type PlatformEvidenceReportType`, `isPlatformEvidenceReportType(reportType): reportType is PlatformEvidenceReportType`, and the widened `PlatformReportInput["reportType"]` union. Every later task consumes these.

- [ ] **Step 1: Write the failing tests**

Append this block inside the top-level `describe("platform operational report contracts", ...)` in `packages/platform-contracts/test/platform-reports.test.ts`, before its closing `});`:

```ts
  describe("usage, quality and commercial report types", () => {
    const evidenceTypes = ["usage", "quality", "commercial"] as const;

    it.each(evidenceTypes)("accepts %s with tenants, dates, timezone and privacy only", (reportType) => {
      expect(
        platformReportContracts.create.body.safeParse({ ...valid, reportType }).success,
      ).toBe(true);
    });

    it.each(evidenceTypes)("rejects every optional filter and production_date for %s", (reportType) => {
      const overrides = [
        { lineId: uuid },
        { productId: uuid },
        { gtin14: "04601234567890" },
        { operatorId: uuid },
        { status: "closed" },
        { outcome: "ok" },
        { periodBasis: "production_date" },
      ];
      for (const override of overrides) {
        expect(
          platformReportContracts.create.body.safeParse({ ...valid, reportType, ...override })
            .success,
        ).toBe(false);
      }
    });

    it("reports the unsupported filter at its own path", () => {
      const result = platformReportContracts.create.body.safeParse({
        ...valid,
        reportType: "usage",
        lineId: uuid,
      });
      expect(result.error?.issues).toEqual([
        { code: "custom", path: ["lineId"], message: "Filter is not supported" },
      ]);
    });

    it("keeps the existing types unchanged", () => {
      expect(
        platformReportContracts.create.body.safeParse({ ...valid, reportType: "shifts", lineId: uuid })
          .success,
      ).toBe(true);
    });

    it("exposes the evidence type list and its guard", () => {
      expect(platformEvidenceReportTypes).toEqual(["usage", "quality", "commercial"]);
      for (const reportType of platformEvidenceReportTypes)
        expect(isPlatformEvidenceReportType(reportType)).toBe(true);
      for (const reportType of ["shifts", "shift_operators", "inventories", "summary", "commerceml"] as const)
        expect(isPlatformEvidenceReportType(reportType)).toBe(false);
    });

    it("parses stored parameters of the new types into the report DTO", () => {
      const parameters = (({ idempotencyKey: _, ...rest }) => rest)({
        ...valid,
        reportType: "commercial" as const,
      });
      const report = platformReportContracts.create.response.parse({
        id: uuid,
        parameters,
        status: "queued",
        createdAt: "2026-09-30T08:00:00Z",
        snapshotAt: null,
        completedAt: null,
        expiresAt: "2026-10-07T08:00:00Z",
        errorCode: null,
        rowCount: null,
        byteSize: null,
        filename: null,
      });
      expect(report.parameters.reportType).toBe("commercial");
    });
  });
```

Change the import at the top of the same file to:

```ts
import {
  isPlatformEvidenceReportType,
  platformCapabilitiesForRole,
  platformEvidenceReportTypes,
  platformReportContracts,
} from "../src/index.js";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/platform-contracts exec vitest run test/platform-reports.test.ts`
Expected: FAIL — `platformEvidenceReportTypes` and `isPlatformEvidenceReportType` are not exported and `usage` is not a valid `reportType`.

- [ ] **Step 3: Implement the contract change**

In `packages/platform-contracts/src/platform-reports.ts` replace the type enum:

```ts
export const platformReportTypeSchema = z.enum([
  "shifts",
  "shift_operators",
  "inventories",
  "summary",
  "commerceml",
  "usage",
  "quality",
  "commercial",
]);
export const platformEvidenceReportTypes = ["usage", "quality", "commercial"] as const;
export type PlatformEvidenceReportType = (typeof platformEvidenceReportTypes)[number];
export function isPlatformEvidenceReportType(
  reportType: z.infer<typeof platformReportTypeSchema>,
): reportType is PlatformEvidenceReportType {
  return (platformEvidenceReportTypes as readonly string[]).includes(reportType);
}
```

In the same file, inside `superRefine`, immediately after the block that ends with

```ts
    } else if (value.outcome !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "Outcome is CommerceML-only",
      });
    }
```

insert:

```ts
    if (isPlatformEvidenceReportType(value.reportType)) {
      for (const filter of ["lineId", "productId", "gtin14", "status"] as const) {
        if (value[filter] !== undefined) {
          context.addIssue({ code: "custom", path: [filter], message: "Filter is not supported" });
        }
      }
    }
```

`operatorId`, `periodBasis=production_date` and `outcome` are already rejected for every type outside their own scope, so no further branches are needed.

In `packages/platform-contracts/src/index.ts` extend the export list:

```ts
export {
  isPlatformEvidenceReportType,
  platformEvidenceReportTypes,
  platformReportContracts,
  platformReportErrorCodeSchema,
  platformReportInputSchema,
  platformReportPeriodBasisSchema,
  platformReportPrivacySchema,
  platformReportSchema,
  platformReportStatusSchema,
  platformReportTypeSchema,
} from "./platform-reports.js";
export type {
  PlatformEvidenceReportType,
  PlatformReport,
  PlatformReportInput,
} from "./platform-reports.js";
```

- [ ] **Step 4: Run tests, typecheck, lint and build**

Run:

```bash
pnpm --filter @markiro/platform-contracts exec vitest run test/platform-reports.test.ts
pnpm --filter @markiro/platform-contracts test
pnpm --filter @markiro/platform-contracts typecheck
pnpm --filter @markiro/platform-contracts lint
pnpm --filter @markiro/platform-contracts build
```

Expected: all PASS. The build is required because the API and saas-admin consume the compiled `dist`.

- [ ] **Step 5: Commit**

```bash
git add packages/platform-contracts/src/platform-reports.ts packages/platform-contracts/src/index.ts packages/platform-contracts/test/platform-reports.test.ts
git commit -m "feat(contracts): usage, quality and commercial platform report types" \
  -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Privacy, definitions version and renderer metadata

**Files:**
- Modify: `apps/api/src/platform-reports/report-definitions.ts`
- Modify: `apps/api/src/platform-reports/report-renderer.ts`
- Test: `apps/api/test/platform-report-evidence-privacy.test.ts` (create)

**Interfaces:**
- Consumes: `isPlatformEvidenceReportType`, `PlatformReportInput` from Task 2.
- Produces:
  - `REPORT_DEFINITIONS_VERSION: Record<PlatformReportInput["reportType"], string>`
  - `EVIDENCE_TENANT_FIELDS: readonly ["tenant_id", "tenant_name"]`
  - `EVIDENCE_COMMON_DEFINITIONS: Record<string, string>` (keys `grain`, `day`, `tenant_id`, `tenant_name`, `selection`, `restatement`, `privacy`)
  - `applyReportPrivacy` that labels or removes tenant columns for the three new types and is idempotent
  - `renderPlatformReport` that writes `definitionsVersion`, `dataSha256` and, for the new types outside `identified`, `tenantCount` instead of `tenantIds`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/platform-report-evidence-privacy.test.ts`:

```ts
import { createHash } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { platformReportTypeSchema, type PlatformReportInput } from "@markiro/platform-contracts";
import {
  applyReportPrivacy,
  REPORT_DEFINITIONS_VERSION,
  type PlatformReportSource,
} from "../src/platform-reports/report-definitions";
import { renderPlatformReport } from "../src/platform-reports/report-renderer";

const identified: PlatformReportInput = {
  reportType: "usage",
  tenantIds: ["tenant-b-real", "tenant-a-real"],
  fromDate: "2026-09-01",
  toDate: "2026-09-02",
  timezone: "Europe/Moscow",
  periodBasis: "events",
  privacy: "identified",
};
const source: PlatformReportSource = {
  snapshotAt: new Date("2026-09-03T00:00:00Z"),
  columns: ["tenant_id", "tenant_name", "day", "accepted_units", "active_lines"],
  rows: [
    {
      tenant_id: "tenant-b-real",
      tenant_name: "Beta Factory",
      day: "2026-09-01",
      accepted_units: 5,
      active_lines: 1,
    },
    {
      tenant_id: "tenant-a-real",
      tenant_name: "Alpha Factory",
      day: "2026-09-01",
      accepted_units: 7,
      active_lines: 2,
    },
  ],
  definitions: {
    tenant_id: "tenant identifier",
    tenant_name: "tenant name",
    accepted_units: "accepted units",
  },
};

function artifact(input: PlatformReportInput, raw: PlatformReportSource) {
  const files = unzipSync(renderPlatformReport(input, raw).body);
  const text = Object.values(files)
    .map((bytes) => strFromU8(bytes))
    .join("\n");
  return { files, text, metadata: JSON.parse(strFromU8(files["metadata.json"]!)) };
}

describe("evidence report privacy", () => {
  it("labels tenants in ascending id order and leaves no real tenant text in any file", () => {
    const input = { ...identified, privacy: "pseudonymous" as const };
    const safe = applyReportPrivacy(input, source);
    expect(safe.rows.map((row) => [row.tenant_id, row.tenant_name])).toEqual([
      ["tenant-02", "tenant-02"],
      ["tenant-01", "tenant-01"],
    ]);
    const { text, metadata } = artifact(input, source);
    for (const secret of ["tenant-a-real", "tenant-b-real", "Alpha Factory", "Beta Factory"])
      expect(text).not.toContain(secret);
    expect(metadata.parameters).not.toHaveProperty("tenantIds");
    expect(metadata.parameters.tenantCount).toBe(2);
  });

  it("aggregate removes tenant columns, sums days and drops their definitions", () => {
    const input = { ...identified, privacy: "aggregate" as const };
    const safe = applyReportPrivacy(input, source);
    expect(safe.columns).toEqual(["day", "accepted_units", "active_lines"]);
    expect(safe.rows).toEqual([{ day: "2026-09-01", accepted_units: 12, active_lines: 3 }]);
    expect(safe.definitions).toEqual({ accepted_units: "accepted units" });
    const { text, metadata } = artifact(input, source);
    for (const secret of ["tenant-a-real", "tenant-b-real", "Alpha Factory", "Beta Factory"])
      expect(text).not.toContain(secret);
    expect(metadata.parameters).not.toHaveProperty("tenantIds");
  });

  it("identified keeps names and tenant ids", () => {
    const { text, metadata } = artifact(identified, source);
    expect(text).toContain("Alpha Factory");
    expect(metadata.parameters.tenantIds).toEqual(identified.tenantIds);
  });

  it.each(["pseudonymous", "aggregate"] as const)(
    "is idempotent in %s mode because the renderer applies privacy a second time",
    (privacy) => {
      const input = { ...identified, privacy };
      const once = applyReportPrivacy(input, source);
      expect(applyReportPrivacy(input, once)).toEqual(once);
    },
  );

  it("leaves the tenant columns of the existing report types untouched", () => {
    const input: PlatformReportInput = {
      ...identified,
      reportType: "shifts",
      privacy: "pseudonymous",
    };
    const safe = applyReportPrivacy(input, source);
    expect(safe.rows.map((row) => row.tenant_id)).toEqual(["tenant-b-real", "tenant-a-real"]);
    expect(artifact(input, source).metadata.parameters.tenantIds).toEqual(identified.tenantIds);
  });

  it("writes definitionsVersion and the SHA-256 of the exact data.csv bytes", () => {
    const { files, metadata } = artifact(identified, source);
    expect(metadata.definitionsVersion).toBe(REPORT_DEFINITIONS_VERSION.usage);
    expect(metadata.dataSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(metadata.dataSha256).toBe(createHash("sha256").update(files["data.csv"]!).digest("hex"));
  });

  it("versions every report type", () => {
    expect(Object.keys(REPORT_DEFINITIONS_VERSION).sort()).toEqual(
      [...platformReportTypeSchema.options].sort(),
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/api exec vitest run test/platform-report-evidence-privacy.test.ts`
Expected: FAIL — `REPORT_DEFINITIONS_VERSION` is undefined and the artifacts contain real tenant text.

- [ ] **Step 3: Extend `report-definitions.ts`**

Replace the import at the top of `apps/api/src/platform-reports/report-definitions.ts`:

```ts
import {
  isPlatformEvidenceReportType,
  type PlatformReportInput,
  type platformReportErrorCodeSchema,
} from "@markiro/platform-contracts";
import type { z } from "zod";
```

Insert after the `REPORT_DEFINITIONS` constant (before `applyReportPrivacy`):

```ts
/** Bumped whenever a formula or clock basis of that report type changes. */
export const REPORT_DEFINITIONS_VERSION: Record<PlatformReportInput["reportType"], string> = {
  shifts: "1",
  shift_operators: "1",
  inventories: "1",
  summary: "1",
  commerceml: "1",
  usage: "1",
  quality: "1",
  commercial: "1",
};

export const EVIDENCE_TENANT_FIELDS = ["tenant_id", "tenant_name"] as const;

export const EVIDENCE_COMMON_DEFINITIONS: Record<string, string> = {
  grain:
    "One row per tenant and local calendar day in the selected IANA timezone. A day appears only if at least one fact of this report was recorded for that tenant on that day; a missing row means no recorded fact, not a measured zero. Every numeric column is an additive count or sum, so rows can be summed across days.",
  day: "Local calendar date (YYYY-MM-DD) of the fact's own timestamp in the selected timezone. Each metric names its clock in its own definition.",
  tenant_id:
    "Tenant identifier. Replaced by an export-local label in pseudonymous mode and removed in aggregate mode.",
  tenant_name:
    "Current organization name at the snapshot, not an asserted historical name. Replaced or removed like tenant_id.",
  selection:
    "Inclusive local calendar dates, implemented as [local midnight fromDate, local midnight after toDate) in the selected timezone. No optional filters are supported.",
  restatement:
    "Late device synchronisation can add facts to past days, so the same parameters run later can return different numbers. Compare exports by snapshotAt and definitionsVersion.",
  privacy:
    "Pseudonymous and aggregate output is not legal anonymization: a distinctive volume or a small tenant selection can still identify a tenant. Aggregate removes the tenant columns and sums days across the selected tenants.",
};

function labelTenants(rows: ReportRow[]): Map<string, string> {
  const ids = [
    ...new Set(
      rows.map((row) => row.tenant_id).filter((id): id is string => typeof id === "string"),
    ),
  ].sort();
  return new Map(ids.map((id, index) => [id, `tenant-${String(index + 1).padStart(2, "0")}`]));
}
```

Replace the whole `applyReportPrivacy` function with:

```ts
export function applyReportPrivacy(
  input: PlatformReportInput,
  source: PlatformReportSource,
): PlatformReportSource {
  if (input.privacy === "identified") return source;
  const tenantLabelled = isPlatformEvidenceReportType(input.reportType);
  const labels = new Map<string, string>();
  const tenantLabels = tenantLabelled ? labelTenants(source.rows) : new Map<string, string>();
  const personFields = new Set(["operator_id", "operator_name"]);
  const removed = new Set(
    input.privacy === "aggregate"
      ? [
          ...personFields,
          "first_event_at",
          "last_event_at",
          ...(tenantLabelled ? EVIDENCE_TENANT_FIELDS : []),
        ]
      : [],
  );
  const columns = source.columns.filter((column) => !removed.has(column));
  const rows = source.rows.map((row) => {
    const result: ReportRow = {};
    for (const column of columns) result[column] = row[column] ?? null;
    if (input.privacy === "pseudonymous" && columns.includes("operator_id")) {
      const id = row.operator_id;
      const key = `${row.tenant_id}:${id}`;
      if (typeof id === "string" && !labels.has(key))
        labels.set(key, `operator-${String(labels.size + 1).padStart(3, "0")}`);
      result.operator_id = id === null ? null : (labels.get(key) ?? null);
      result.operator_name = id === null ? "unknown" : (labels.get(key) ?? null);
    }
    if (input.privacy === "pseudonymous" && tenantLabelled && columns.includes("tenant_id")) {
      const label = tenantLabels.get(String(row.tenant_id)) ?? null;
      result.tenant_id = label;
      if (columns.includes("tenant_name")) result.tenant_name = label;
    }
    return result;
  });
  const definitions = Object.fromEntries(
    Object.entries(source.definitions).filter(([key]) => !removed.has(key)),
  );
  // A source should aggregate in SQL. Also collapse person rows defensively for callers of the renderer.
  if (input.privacy === "aggregate") {
    const grouped = new Map<string, ReportRow>();
    for (const row of rows) {
      const key = JSON.stringify(
        columns
          .filter((column) => typeof row[column] !== "number")
          .map((column) => [column, row[column]]),
      );
      const previous = grouped.get(key);
      if (!previous) grouped.set(key, { ...row });
      else
        for (const column of columns)
          if (typeof row[column] === "number" && typeof previous[column] === "number")
            previous[column] += row[column];
    }
    return { ...source, columns, rows: [...grouped.values()], definitions };
  }
  return { ...source, columns, rows, definitions };
}
```

Tenant labels are assigned from the ascending sort of the distinct ids. After the first pass the values are the labels themselves, whose ascending order is the same, so the renderer's second pass reproduces the same mapping.

- [ ] **Step 4: Replace `report-renderer.ts`**

Replace the full contents of `apps/api/src/platform-reports/report-renderer.ts` with:

```ts
import { createHash } from "node:crypto";
import {
  isPlatformEvidenceReportType,
  type PlatformReportInput,
} from "@markiro/platform-contracts";
import { zipSync } from "fflate";
import {
  applyReportPrivacy,
  PlatformReportSourceError,
  REPORT_DEFINITIONS_VERSION,
  REPORT_MAX_BYTES,
  REPORT_MAX_ROWS,
  type PlatformReportSource,
} from "./report-definitions";

function csvCell(value: string | number | null, column: string): string {
  let text = value === null ? "" : String(value);
  let formulaCandidate = text.trimStart();
  while (formulaCandidate.length > 0 && formulaCandidate.charCodeAt(0) < 32) {
    formulaCandidate = formulaCandidate.slice(1).trimStart();
  }
  if (
    typeof value === "string" &&
    (/^[=+@-]/u.test(formulaCandidate) || /(?:gtin|sscc)/i.test(column))
  )
    text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** Outside identified mode the evidence types record how many tenants, never which. */
function artifactParameters(
  input: PlatformReportInput,
  parameters: Omit<PlatformReportInput, "operatorId">,
): Record<string, unknown> {
  if (input.privacy === "identified") return input;
  if (!isPlatformEvidenceReportType(input.reportType)) return parameters;
  const { tenantIds, ...withoutTenants } = parameters;
  return { ...withoutTenants, tenantCount: tenantIds.length };
}

export function renderPlatformReport(
  input: PlatformReportInput,
  rawSource: PlatformReportSource,
): { body: Buffer; filename: string; rowCount: number } {
  if (rawSource.rows.length > REPORT_MAX_ROWS)
    throw new PlatformReportSourceError("REPORT_LIMIT_EXCEEDED");
  const source = applyReportPrivacy(input, rawSource);
  const { operatorId, ...parameters } = input;
  const metadataFor = (dataSha256: string) =>
    Buffer.from(
      JSON.stringify(
        {
          formatVersion: 1,
          snapshotAt: source.snapshotAt.toISOString(),
          parameters: artifactParameters(input, parameters),
          operatorFilterApplied: operatorId !== undefined,
          rowCount: source.rows.length,
          columns: source.columns,
          definitionsVersion: REPORT_DEFINITIONS_VERSION[input.reportType],
          dataSha256,
          definitions: source.definitions,
          csv: {
            encoding: "UTF-8 BOM",
            lineEnding: "CRLF",
            delimiter: ",",
            nullValue: "empty cell",
            identifierTextPrefix: "apostrophe",
            formulaProtection: "leading apostrophe",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
  // A SHA-256 hex digest has a fixed length, so a placeholder gives the final metadata size.
  let size = metadataFor("0".repeat(64)).byteLength + 3;
  const chunks: string[] = ["\ufeff"];
  const append = (line: string) => {
    size += Buffer.byteLength(line);
    if (size > REPORT_MAX_BYTES) throw new PlatformReportSourceError("REPORT_LIMIT_EXCEEDED");
    chunks.push(line);
  };
  append(`${source.columns.map((column) => csvCell(column, "")).join(",")}\r\n`);
  for (const row of source.rows)
    append(`${source.columns.map((column) => csvCell(row[column] ?? null, column)).join(",")}\r\n`);
  const data = Buffer.from(chunks.join(""), "utf8");
  const metadata = metadataFor(createHash("sha256").update(data).digest("hex"));
  const body = Buffer.from(zipSync({ "data.csv": data, "metadata.json": metadata }, { level: 6 }));
  return {
    body,
    filename: `${input.reportType}-${input.fromDate}-${input.toDate}.zip`,
    rowCount: source.rows.length,
  };
}
```

- [ ] **Step 5: Run the tests, the existing renderer and lifecycle tests, typecheck and lint**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/platform-report-evidence-privacy.test.ts test/platform-report-renderer.test.ts test/platform-report-lifecycle.test.ts test/platform-report-module.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
```

Expected: PASS. The lifecycle test skips without a local database; note that in the final report.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/platform-reports/report-definitions.ts apps/api/src/platform-reports/report-renderer.ts apps/api/test/platform-report-evidence-privacy.test.ts
git commit -m "feat(reports): tenant labels, definitionsVersion and dataSha256 for evidence reports" \
  -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `usage` report source

**Files:**
- Modify: `apps/api/src/platform-reports/report-query.ts`
- Create: `apps/api/src/platform-reports/usage-report-source.ts`
- Modify: `apps/api/src/platform-reports/report-source.service.ts`
- Create: `apps/api/test/support/platform-report-evidence-base.ts`
- Create: `apps/api/test/platform-report-evidence-definitions.test.ts`
- Test: `apps/api/test/platform-report-usage-source.test.ts` (create)

**Interfaces:**
- Consumes: Task 3 exports; `reportRows`, `tenantScope`, `inWindow` from `report-query.ts`.
- Produces:
  - `localDay(column: SQL, input: PlatformReportInput): SQL` — the local calendar date of a timestamptz column.
  - `pivotMetrics(metrics: readonly string[], floatMetrics?: ReadonlySet<string>): SQL` — the select list that turns `metrics(tenant_id, local_day, metric, n)` rows into one column per metric.
  - `USAGE_COLUMNS: readonly string[]`, `USAGE_DEFINITIONS: Record<string, string>`, `loadUsageRows(tx, input): Promise<ReportRow[]>`.
  - `seedEvidenceBase(db): Promise<EvidenceBase>` and `cleanupEvidence(db, tenants, options?)` for the DB tests of Tasks 4–6.

- [ ] **Step 1: Add the shared query helpers**

Append to `apps/api/src/platform-reports/report-query.ts`:

```ts
/**
 * Local calendar date of a timestamptz column in the report timezone.
 * The timezone is a bind parameter, so never repeat this expression in a GROUP BY: Postgres treats
 * two occurrences as different expressions. Compute it in a CTE column and group by that column.
 */
export function localDay(column: SQL, input: PlatformReportInput): SQL {
  return sql`((${column} AT TIME ZONE ${input.timezone})::date)`;
}

/**
 * Select list that pivots `metrics(tenant_id, local_day, metric, n)` rows, aliased `m`, into one
 * column per metric. Counts become int, metrics named in `floatMetrics` become float8.
 */
export function pivotMetrics(
  metrics: readonly string[],
  floatMetrics: ReadonlySet<string> = new Set(),
): SQL {
  return sql.join(
    metrics.map(
      (metric) =>
        sql`coalesce(sum(m.n) FILTER (WHERE m.metric = ${metric}), 0)::${sql.raw(floatMetrics.has(metric) ? "float8" : "int")} AS ${sql.identifier(metric)}`,
    ),
    sql`, `,
  );
}
```

- [ ] **Step 2: Create the shared DB fixture**

Create `apps/api/test/support/platform-report-evidence-base.ts`:

```ts
import { randomUUID } from "node:crypto";
import { ensurePartitions, schema, type Db } from "@markiro/db";
import { sql } from "drizzle-orm";

export interface EvidenceBase {
  tenant: string;
  other: string;
  user: string;
  product: string;
  otherProduct: string;
  lineOne: string;
  lineTwo: string;
  otherLine: string;
  operatorOne: string;
  operatorTwo: string;
  shiftOne: string;
  shiftTwo: string;
  otherShift: string;
  stationDevice: string;
  handheldDevice: string;
  kiosk: string;
}

/** One organisation with two lines, two operators, two shifts and devices, plus a foreign tenant. */
export async function seedEvidenceBase(db: Db): Promise<EvidenceBase> {
  const base: EvidenceBase = {
    tenant: `evidence-a-${randomUUID()}`,
    other: `evidence-b-${randomUUID()}`,
    user: randomUUID(),
    product: randomUUID(),
    otherProduct: randomUUID(),
    lineOne: randomUUID(),
    lineTwo: randomUUID(),
    otherLine: randomUUID(),
    operatorOne: randomUUID(),
    operatorTwo: randomUUID(),
    shiftOne: randomUUID(),
    shiftTwo: randomUUID(),
    otherShift: randomUUID(),
    stationDevice: randomUUID(),
    handheldDevice: randomUUID(),
    kiosk: randomUUID(),
  };
  await ensurePartitions(db, [
    new Date("2026-08-01"),
    new Date("2026-09-01"),
    new Date("2026-10-01"),
    new Date("2026-11-01"),
  ]);
  await db.insert(schema.organization).values([
    { id: base.tenant, name: "Evidence fixture A", slug: base.tenant, createdAt: new Date() },
    { id: base.other, name: "Evidence fixture B", slug: base.other, createdAt: new Date() },
  ]);
  await db.insert(schema.user).values({
    id: base.user,
    name: "Evidence fixture",
    email: `${base.user}@example.invalid`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(schema.products).values([
    {
      id: base.product,
      tenantId: base.tenant,
      name: "Evidence product",
      gtin14: "00012345678901",
      createdAt: new Date("2026-08-01T00:00:00Z"),
    },
    {
      id: base.otherProduct,
      tenantId: base.other,
      name: "Foreign product",
      gtin14: "00012345678901",
      createdAt: new Date("2026-08-01T00:00:00Z"),
    },
  ]);
  await db.insert(schema.lines).values([
    { id: base.lineOne, tenantId: base.tenant, name: "Line one" },
    { id: base.lineTwo, tenantId: base.tenant, name: "Line two" },
    { id: base.otherLine, tenantId: base.other, name: "Foreign line" },
  ]);
  await db.insert(schema.employees).values([
    { id: base.operatorOne, tenantId: base.tenant, fullName: "Operator One" },
    { id: base.operatorTwo, tenantId: base.tenant, fullName: "Operator Two" },
  ]);
  await db.insert(schema.shifts).values([
    {
      id: base.shiftOne,
      tenantId: base.tenant,
      productId: base.product,
      lineId: base.lineOne,
      mode: "validation",
      numberMonthKey: "SEP26",
      numberSeq: 1,
      createdFrom: "station",
      productionDate: "2026-09-01",
      createdAt: new Date("2026-08-01T00:00:00Z"),
    },
    {
      id: base.shiftTwo,
      tenantId: base.tenant,
      productId: base.product,
      lineId: base.lineTwo,
      mode: "validation",
      numberMonthKey: "SEP26",
      numberSeq: 2,
      createdFrom: "station",
      productionDate: "2026-09-01",
      createdAt: new Date("2026-08-01T00:00:00Z"),
    },
    {
      id: base.otherShift,
      tenantId: base.other,
      productId: base.otherProduct,
      lineId: base.otherLine,
      mode: "validation",
      numberMonthKey: "SEP26",
      numberSeq: 1,
      createdFrom: "station",
      productionDate: "2026-09-01",
      createdAt: new Date("2026-08-01T00:00:00Z"),
    },
  ]);
  await db.insert(schema.stationDevices).values([
    { id: base.stationDevice, tenantId: base.tenant, name: "Evidence station" },
    { id: base.handheldDevice, tenantId: base.tenant, name: "Evidence handheld", kind: "handheld" },
  ]);
  await db
    .insert(schema.kiosks)
    .values({ id: base.kiosk, tenantId: base.tenant, name: "Evidence kiosk" });
  return base;
}

// Child tables before their parents. Every table here is tenant-scoped through `tenant_id`.
const EVIDENCE_TABLES = [
  "invoice_payment_completions",
  "billing_payments",
  "billing_acts",
  "invoices",
  "payments",
  "tenant_subscriptions",
  "commercial_offer_lines",
  "commercial_offers",
  "pickup_orders",
  "kiosks",
  "pallet_exceptions",
  "box_exceptions",
  "boxes",
  "pallets",
  "code_conflicts",
  "station_sync_quarantine",
  "sync_batches",
  "inventory_repack_print_attempts",
  "inventory_repack_boxes",
  "inventory_event_claim_outcomes",
  "inventory_code_results",
  "inventory_scan_events",
  "inventory_scan_batches",
  "inventory_snapshot_codes",
  "inventory_snapshots",
  "inventories",
  "station_devices",
  "scan_events",
  "shifts",
  "employees",
  "products",
  "lines",
] as const;

export async function cleanupEvidence(
  db: Db,
  tenants: string[],
  options: { users?: string[]; platformUsers?: string[] } = {},
): Promise<void> {
  const list = sql.join(
    tenants.map((tenant) => sql`${tenant}`),
    sql`, `,
  );
  const platformUsers = options.platformUsers ?? [];
  for (const platformUser of platformUsers) {
    // Agreements may be unlinked (tenant_id null), so remove them by creator.
    await db.execute(
      sql`DELETE FROM platform_agreements WHERE created_by_platform_user_id = ${platformUser}`,
    );
  }
  await db.execute(
    sql`UPDATE inventories SET status='ready', station_manifest=NULL, completed_at=NULL, completed_by_user_id=NULL, completion_acknowledged_at=NULL, completion_acknowledged_by_user_id=NULL WHERE tenant_id IN (${list}) AND active_snapshot_id IS NOT NULL`,
  );
  await db.execute(
    sql`UPDATE inventories SET status='draft', active_snapshot_id=NULL WHERE tenant_id IN (${list})`,
  );
  for (const table of EVIDENCE_TABLES) {
    await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE tenant_id IN (${list})`);
  }
  await db.execute(sql`DELETE FROM organization WHERE id IN (${list})`);
  for (const user of options.users ?? [])
    await db.execute(sql`DELETE FROM "user" WHERE id = ${user}`);
  for (const platformUser of platformUsers)
    await db.execute(sql`DELETE FROM platform_users WHERE id = ${platformUser}`);
}
```

- [ ] **Step 3: Write the failing tests**

Create `apps/api/test/platform-report-evidence-definitions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EVIDENCE_COMMON_DEFINITIONS } from "../src/platform-reports/report-definitions";
import { USAGE_COLUMNS, USAGE_DEFINITIONS } from "../src/platform-reports/usage-report-source";

function undefinedColumns(columns: readonly string[], specific: Record<string, string>) {
  return columns.filter((column) => !EVIDENCE_COMMON_DEFINITIONS[column] && !specific[column]);
}

describe("evidence report definitions", () => {
  it("defines every usage column", () => {
    expect(undefinedColumns(USAGE_COLUMNS, USAGE_DEFINITIONS)).toEqual([]);
  });
});
```

Create `apps/api/test/platform-report-usage-source.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { createDb, schema } from "@markiro/db";
import type { PlatformReportInput } from "@markiro/platform-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlatformReportSourceService } from "../src/platform-reports/report-source.service";
import { USAGE_COLUMNS } from "../src/platform-reports/usage-report-source";
import {
  cleanupEvidence,
  seedEvidenceBase,
  type EvidenceBase,
} from "./support/platform-report-evidence-base";
import { seedReportInventory } from "./support/platform-report-inventory-fixture";

const url = process.env.DATABASE_URL;
const local = url ? ["localhost", "127.0.0.1"].includes(new URL(url).hostname) : false;

describe.skipIf(!local)("usage report projection on real Postgres", () => {
  const { db, pool } = createDb(url ?? "postgres://localhost:55439/unavailable");
  const service = new PlatformReportSourceService(db);
  let base: EvidenceBase;
  let input: PlatformReportInput;

  beforeAll(async () => {
    base = await seedEvidenceBase(db);
    input = {
      reportType: "usage",
      tenantIds: [base.tenant],
      fromDate: "2026-09-01",
      toDate: "2026-09-02",
      timezone: "Europe/Moscow",
      periodBasis: "events",
      privacy: "identified",
    };
    const scan = (
      shiftId: string,
      at: string,
      options: {
        verdict?: string;
        terminal?: string;
        operator?: string;
        tenant?: string;
      } = {},
    ) => ({
      tenantId: options.tenant ?? base.tenant,
      shiftId,
      terminalId: options.terminal ?? null,
      operatorId: options.operator ?? null,
      raw: "raw-scan-secret",
      verdict: options.verdict ?? "ok",
      scannedAt: new Date(at),
    });
    // Moscow day 2026-09-01 is [2026-08-31T21:00Z, 2026-09-01T21:00Z).
    await db.insert(schema.scanEvents).values([
      scan(base.shiftOne, "2026-09-01T09:00:00Z", { terminal: "t-1", operator: base.operatorOne }),
      scan(base.shiftOne, "2026-09-01T09:05:00Z", { terminal: "t-1", operator: base.operatorOne }),
      scan(base.shiftOne, "2026-09-01T10:00:00Z", {
        verdict: "duplicate",
        terminal: "t-9",
        operator: base.operatorOne,
      }),
      scan(base.shiftTwo, "2026-09-01T12:00:00Z", { terminal: "t-2", operator: base.operatorTwo }),
      // One second before the window opens: local day 2026-08-31, not selected.
      scan(base.shiftOne, "2026-08-31T20:59:59Z", { terminal: "t-1", operator: base.operatorOne }),
      // Exactly local midnight of 2026-09-02.
      scan(base.shiftOne, "2026-09-01T21:00:00Z", { terminal: "t-1", operator: base.operatorOne }),
      scan(base.otherShift, "2026-09-01T10:00:00Z", { tenant: base.other, terminal: "b-1" }),
    ]);
    let boxNumber = 0;
    const box = (
      values: Partial<typeof schema.boxes.$inferInsert> & { shiftId: string },
    ): typeof schema.boxes.$inferInsert => ({
      tenantId: base.tenant,
      deviceBoxId: `box-${++boxNumber}`,
      openedAt: new Date("2026-08-20T00:00:00Z"),
      ...values,
    });
    await db.insert(schema.boxes).values([
      box({
        shiftId: base.shiftOne,
        terminalId: "t-1",
        operatorId: base.operatorOne,
        closedAt: new Date("2026-09-01T08:00:00Z"),
        closureReceivedAt: new Date("2026-09-01T08:30:00Z"),
        sscc: "000000000000000001",
        printVerifiedAt: new Date("2026-09-01T09:00:00Z"),
      }),
      box({
        shiftId: base.shiftOne,
        terminalId: "t-3",
        operatorId: null,
        closedAt: new Date("2026-09-01T10:30:00Z"),
        closureReceivedAt: new Date("2026-09-01T11:00:00Z"),
      }),
      // Closed on the device on day one, received by the server on day two: counts on day two.
      box({
        shiftId: base.shiftTwo,
        terminalId: "t-2",
        operatorId: base.operatorTwo,
        closedAt: new Date("2026-09-01T20:00:00Z"),
        closureReceivedAt: new Date("2026-09-02T05:00:00Z"),
        printVerifiedAt: new Date("2026-09-02T22:00:00Z"),
      }),
    ]);
    await db.insert(schema.pallets).values([
      {
        tenantId: base.tenant,
        shiftId: base.shiftOne,
        kind: "production",
        devicePalletId: "pp-1",
        terminalId: "t-1",
        closedAt: new Date("2026-09-01T12:50:00Z"),
        closureReceivedAt: new Date("2026-09-01T13:00:00Z"),
      },
      // Still open: no closure yet.
      {
        tenantId: base.tenant,
        shiftId: base.shiftOne,
        kind: "production",
        devicePalletId: "pp-2",
        terminalId: "t-1",
      },
      {
        tenantId: base.tenant,
        shiftId: null,
        kind: "warehouse",
        productId: base.product,
        deviceId: base.stationDevice,
        terminalId: base.stationDevice,
        devicePalletId: "wp-1",
        closedAt: new Date("2026-09-02T09:50:00Z"),
        closureReceivedAt: new Date("2026-09-02T10:00:00Z"),
      },
    ]);
    await db.insert(schema.pickupOrders).values([
      {
        tenantId: base.tenant,
        orderNo: "ord-1",
        sourceKind: "kiosk",
        kioskId: base.kiosk,
        employeeId: base.operatorOne,
        reason: "buy",
        status: "pending",
        itemCount: 2,
        createdAt: new Date("2026-09-01T12:00:00Z"),
      },
      {
        tenantId: base.tenant,
        orderNo: "ord-2",
        sourceKind: "kiosk",
        kioskId: base.kiosk,
        employeeId: base.operatorOne,
        reason: "buy",
        status: "punched",
        itemCount: 3,
        createdAt: new Date("2026-09-01T13:00:00Z"),
      },
      {
        tenantId: base.tenant,
        orderNo: "ord-3",
        sourceKind: "handheld",
        stationDeviceId: base.handheldDevice,
        employeeId: base.operatorOne,
        reason: "writeoff",
        status: "writtenoff",
        itemCount: 4,
        createdAt: new Date("2026-09-01T14:00:00Z"),
      },
      {
        tenantId: base.tenant,
        orderNo: "ord-4",
        sourceKind: "kiosk",
        kioskId: base.kiosk,
        employeeId: base.operatorOne,
        reason: "buy",
        status: "cancelled",
        itemCount: 9,
        createdAt: new Date("2026-09-01T15:00:00Z"),
      },
      {
        tenantId: base.tenant,
        orderNo: "ord-5",
        sourceKind: "handheld",
        stationDeviceId: base.handheldDevice,
        employeeId: base.operatorOne,
        reason: "writeoff",
        status: "pending",
        itemCount: 1,
        createdAt: new Date("2026-09-02T10:00:00Z"),
      },
    ]);
    await db.insert(schema.products).values({
      id: randomUUID(),
      tenantId: base.tenant,
      name: "Added product",
      gtin14: "00012345678902",
      createdAt: new Date("2026-09-01T07:00:00Z"),
    });
    // Completed on 2026-09-01T10:00Z.
    await seedReportInventory(db, {
      tenant: base.tenant,
      product: base.product,
      line: base.lineOne,
      operator: base.operatorOne,
      user: base.user,
    });
  });

  afterAll(async () => {
    await cleanupEvidence(db, [base.tenant, base.other], { users: [base.user] });
    await pool.end();
  });

  it("aggregates each tenant-day from independent fact families without multiplication", async () => {
    const result = await service.load(input);
    expect(result.columns).toEqual([...USAGE_COLUMNS]);
    expect(result.rows).toEqual([
      {
        tenant_id: base.tenant,
        tenant_name: "Evidence fixture A",
        day: "2026-09-01",
        shifts_active: 2,
        active_lines: 2,
        active_devices: 3,
        active_operators: 2,
        accepted_units: 3,
        boxes_closed: 2,
        sscc_boxes: 1,
        print_confirmed_boxes: 1,
        production_pallets_closed: 1,
        warehouse_pallets_closed: 0,
        pickup_orders_buy: 2,
        pickup_orders_writeoff: 1,
        pickup_orders_kiosk: 2,
        pickup_orders_handheld: 1,
        pickup_items_buy: 5,
        pickup_items_writeoff: 4,
        inventories_completed: 1,
        gtins_added: 1,
      },
      {
        tenant_id: base.tenant,
        tenant_name: "Evidence fixture A",
        day: "2026-09-02",
        shifts_active: 2,
        active_lines: 2,
        active_devices: 2,
        active_operators: 2,
        accepted_units: 1,
        boxes_closed: 1,
        sscc_boxes: 0,
        print_confirmed_boxes: 0,
        production_pallets_closed: 0,
        warehouse_pallets_closed: 1,
        pickup_orders_buy: 0,
        pickup_orders_writeoff: 1,
        pickup_orders_kiosk: 0,
        pickup_orders_handheld: 1,
        pickup_items_buy: 0,
        pickup_items_writeoff: 1,
        inventories_completed: 0,
        gtins_added: 0,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("raw-scan-secret");
  });

  it("never mixes tenants and reports a selected foreign tenant by its own name", async () => {
    const both = await service.load({ ...input, tenantIds: [base.tenant, base.other] });
    expect(both.rows.filter((row) => row.tenant_id === base.tenant)).toHaveLength(2);
    expect(both.rows.filter((row) => row.tenant_id === base.other)).toEqual([
      expect.objectContaining({
        tenant_name: "Evidence fixture B",
        day: "2026-09-01",
        shifts_active: 1,
        active_lines: 1,
        active_devices: 1,
        active_operators: 0,
        accepted_units: 1,
        boxes_closed: 0,
      }),
    ]);
    const only = await service.load(input);
    expect(only.rows.every((row) => row.tenant_id === base.tenant)).toBe(true);
  });

  it("follows the local day of a DST-observing timezone", async () => {
    // America/New_York leaves DST on 2026-11-01, so that local day lasts 25 hours:
    // [2026-11-01T04:00Z, 2026-11-02T05:00Z).
    const scan = (at: string) => ({
      tenantId: base.tenant,
      shiftId: base.shiftOne,
      terminalId: "ny-1",
      operatorId: null,
      raw: "raw-scan-secret",
      verdict: "ok",
      scannedAt: new Date(at),
    });
    await db
      .insert(schema.scanEvents)
      .values([
        scan("2026-11-01T03:59:00Z"),
        scan("2026-11-01T04:00:00Z"),
        scan("2026-11-02T04:59:00Z"),
        scan("2026-11-02T05:00:00Z"),
      ]);
    const result = await service.load({
      ...input,
      fromDate: "2026-11-01",
      toDate: "2026-11-01",
      timezone: "America/New_York",
    });
    expect(result.rows).toEqual([
      expect.objectContaining({ day: "2026-11-01", accepted_units: 2, active_devices: 1 }),
    ]);
  });

  it("pseudonymous output carries labels and aggregate output is the manual sum over tenants", async () => {
    const both = { ...input, tenantIds: [base.tenant, base.other] };
    const pseudonymous = await service.load({ ...both, privacy: "pseudonymous" });
    expect(new Set(pseudonymous.rows.map((row) => row.tenant_id))).toEqual(
      new Set(["tenant-01", "tenant-02"]),
    );
    expect(JSON.stringify(pseudonymous)).not.toContain(base.tenant);
    expect(JSON.stringify(pseudonymous)).not.toContain("Evidence fixture");

    const aggregate = await service.load({ ...both, privacy: "aggregate" });
    expect(aggregate.columns).not.toContain("tenant_id");
    expect(aggregate.columns).not.toContain("tenant_name");
    expect(aggregate.rows[0]).toMatchObject({
      day: "2026-09-01",
      accepted_units: 4,
      shifts_active: 3,
      active_lines: 3,
      active_devices: 4,
      active_operators: 2,
      boxes_closed: 2,
    });
    expect(JSON.stringify(aggregate)).not.toContain(base.other);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/platform-report-evidence-definitions.test.ts test/platform-report-usage-source.test.ts
```

Expected: FAIL — `usage-report-source` cannot be resolved.

- [ ] **Step 5: Implement `usage-report-source.ts`**

Create `apps/api/src/platform-reports/usage-report-source.ts`:

```ts
import type { PlatformReportInput } from "@markiro/platform-contracts";
import { sql } from "drizzle-orm";
import { REPORT_MAX_ROWS } from "./report-definitions";
import {
  inWindow,
  localDay,
  pivotMetrics,
  reportRows,
  tenantScope,
  type ReportTransaction,
} from "./report-query";

export const USAGE_COLUMNS = [
  "tenant_id",
  "tenant_name",
  "day",
  "shifts_active",
  "active_lines",
  "active_devices",
  "active_operators",
  "accepted_units",
  "boxes_closed",
  "sscc_boxes",
  "print_confirmed_boxes",
  "production_pallets_closed",
  "warehouse_pallets_closed",
  "pickup_orders_buy",
  "pickup_orders_writeoff",
  "pickup_orders_kiosk",
  "pickup_orders_handheld",
  "pickup_items_buy",
  "pickup_items_writeoff",
  "inventories_completed",
  "gtins_added",
] as const;
const USAGE_METRICS = USAGE_COLUMNS.slice(3);

export const USAGE_DEFINITIONS: Record<string, string> = {
  shifts_active:
    "Distinct shifts that have at least one accepted scan (scanned_at) or one box closure (closure_received_at) on the day.",
  active_lines:
    "Distinct non-null shift line ids among the facts counted in shifts_active; a shift without a line contributes none.",
  active_devices:
    "Distinct non-null terminal ids on accepted scans and closed boxes of the day. Terminal ids are device-reported text and may be legacy non-UUID values; they are counted as text.",
  active_operators:
    "Distinct non-null operator ids on accepted scans and closed boxes of the day. A count only; no person is identified.",
  accepted_units:
    "scan_events with verdict=ok at scanned_at (device clock; scan_events has no server receipt time). This is not the current registry ownership count used by the tenant dashboard, which shrinks when codes are released, cleared or disassembled.",
  boxes_closed:
    "Boxes with closure_received_at on the day (server clock at receipt of the closure), including boxes disassembled later.",
  sscc_boxes: "Of boxes_closed, boxes with a non-null SSCC.",
  print_confirmed_boxes:
    "Boxes with print_verified_at on the day. The timestamp is the station's device clock carried in the closure record. It is print confirmation, not a reprint request.",
  production_pallets_closed:
    "Production pallets with closure_received_at on the day (server clock).",
  warehouse_pallets_closed: "Warehouse pallets with closure_received_at on the day (server clock).",
  pickup_orders_buy:
    "Non-cancelled pickup orders with reason=buy, dated by created_at. created_at is the device time when it lies within the accepted skew of the server clock, otherwise the server time.",
  pickup_orders_writeoff:
    "Non-cancelled pickup orders with reason=writeoff, dated like pickup_orders_buy.",
  pickup_orders_kiosk: "Non-cancelled pickup orders filed by a kiosk, both reasons.",
  pickup_orders_handheld: "Non-cancelled pickup orders filed by a handheld, both reasons.",
  pickup_items_buy:
    "Sum of item_count of the pickup_orders_buy orders. Order items are never joined.",
  pickup_items_writeoff: "Sum of item_count of the pickup_orders_writeoff orders.",
  inventories_completed: "Inventories with completed_at on the day (server clock), any mode.",
  gtins_added:
    "Products created on the day (server clock). Products deleted while unreferenced are absent, so a historical count can fall.",
};

export async function loadUsageRows(tx: ReportTransaction, input: PlatformReportInput) {
  return reportRows(
    tx,
    sql`
    WITH scans AS MATERIALIZED (
      -- Reach scan_events through the tenant's shifts so the (shift_id, scanned_at) index is used.
      SELECT v.tenant_id, v.shift_id, s.line_id, v.terminal_id, v.operator_id,
        ${localDay(sql`v.scanned_at`, input)} AS local_day
      FROM shifts s
      JOIN scan_events v ON v.shift_id = s.id AND v.tenant_id = s.tenant_id
      WHERE ${tenantScope(sql`s.tenant_id`, input)}
        AND v.verdict = 'ok'
        AND ${inWindow(sql`v.scanned_at`, input)}
    ), closed_boxes AS MATERIALIZED (
      SELECT b.tenant_id, b.shift_id, s.line_id, b.terminal_id, b.operator_id, b.sscc,
        ${localDay(sql`b.closure_received_at`, input)} AS local_day
      FROM boxes b
      JOIN shifts s ON s.id = b.shift_id AND s.tenant_id = b.tenant_id
      WHERE ${tenantScope(sql`b.tenant_id`, input)}
        AND ${inWindow(sql`b.closure_received_at`, input)}
    ), activity AS (
      SELECT tenant_id, local_day, shift_id, line_id, terminal_id, operator_id FROM scans
      UNION ALL
      SELECT tenant_id, local_day, shift_id, line_id, terminal_id, operator_id FROM closed_boxes
    ), pickup AS MATERIALIZED (
      SELECT o.tenant_id, ${localDay(sql`o.created_at`, input)} AS local_day,
        o.reason::text AS reason, o.source_kind, o.item_count
      FROM pickup_orders o
      WHERE ${tenantScope(sql`o.tenant_id`, input)}
        AND o.status::text <> 'cancelled'
        AND ${inWindow(sql`o.created_at`, input)}
    ), metrics AS (
      SELECT tenant_id, local_day, 'accepted_units' AS metric, count(*)::numeric AS n
        FROM scans GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'shifts_active', count(DISTINCT shift_id)::numeric
        FROM activity GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'active_lines', count(DISTINCT line_id)::numeric
        FROM activity GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'active_devices', count(DISTINCT terminal_id)::numeric
        FROM activity GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'active_operators', count(DISTINCT operator_id)::numeric
        FROM activity GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'boxes_closed', count(*)::numeric
        FROM closed_boxes GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'sscc_boxes', count(sscc)::numeric
        FROM closed_boxes GROUP BY tenant_id, local_day
      UNION ALL SELECT b.tenant_id, ${localDay(sql`b.print_verified_at`, input)}, 'print_confirmed_boxes', count(*)::numeric
        FROM boxes b
        WHERE ${tenantScope(sql`b.tenant_id`, input)} AND ${inWindow(sql`b.print_verified_at`, input)}
        GROUP BY 1, 2
      UNION ALL SELECT p.tenant_id, ${localDay(sql`p.closure_received_at`, input)}, 'production_pallets_closed', count(*)::numeric
        FROM pallets p
        WHERE ${tenantScope(sql`p.tenant_id`, input)} AND p.kind = 'production'
          AND ${inWindow(sql`p.closure_received_at`, input)}
        GROUP BY 1, 2
      UNION ALL SELECT p.tenant_id, ${localDay(sql`p.closure_received_at`, input)}, 'warehouse_pallets_closed', count(*)::numeric
        FROM pallets p
        WHERE ${tenantScope(sql`p.tenant_id`, input)} AND p.kind = 'warehouse'
          AND ${inWindow(sql`p.closure_received_at`, input)}
        GROUP BY 1, 2
      UNION ALL SELECT tenant_id, local_day, 'pickup_orders_buy', count(*) FILTER (WHERE reason = 'buy')::numeric
        FROM pickup GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'pickup_orders_writeoff', count(*) FILTER (WHERE reason = 'writeoff')::numeric
        FROM pickup GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'pickup_orders_kiosk', count(*) FILTER (WHERE source_kind = 'kiosk')::numeric
        FROM pickup GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'pickup_orders_handheld', count(*) FILTER (WHERE source_kind = 'handheld')::numeric
        FROM pickup GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'pickup_items_buy', coalesce(sum(item_count) FILTER (WHERE reason = 'buy'), 0)::numeric
        FROM pickup GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'pickup_items_writeoff', coalesce(sum(item_count) FILTER (WHERE reason = 'writeoff'), 0)::numeric
        FROM pickup GROUP BY tenant_id, local_day
      UNION ALL SELECT i.tenant_id, ${localDay(sql`i.completed_at`, input)}, 'inventories_completed', count(*)::numeric
        FROM inventories i
        WHERE ${tenantScope(sql`i.tenant_id`, input)} AND ${inWindow(sql`i.completed_at`, input)}
        GROUP BY 1, 2
      UNION ALL SELECT p.tenant_id, ${localDay(sql`p.created_at`, input)}, 'gtins_added', count(*)::numeric
        FROM products p
        WHERE ${tenantScope(sql`p.tenant_id`, input)} AND ${inWindow(sql`p.created_at`, input)}
        GROUP BY 1, 2
    )
    SELECT m.tenant_id, o.name AS tenant_name, m.local_day::text AS day,
      ${pivotMetrics(USAGE_METRICS)}
    FROM metrics m
    JOIN organization o ON o.id = m.tenant_id
    GROUP BY m.tenant_id, o.name, m.local_day
    ORDER BY m.tenant_id, m.local_day
    LIMIT ${REPORT_MAX_ROWS + 1}
  `,
  );
}
```

- [ ] **Step 6: Dispatch `usage` and select definitions per type**

In `apps/api/src/platform-reports/report-source.service.ts` change the imports:

```ts
import {
  applyReportPrivacy,
  EVIDENCE_COMMON_DEFINITIONS,
  PlatformReportSourceError,
  REPORT_DEFINITIONS,
  REPORT_MAX_ROWS,
  type PlatformReportSource,
  type ReportRow,
} from "./report-definitions";
import { USAGE_COLUMNS, USAGE_DEFINITIONS, loadUsageRows } from "./usage-report-source";
```

Add above the `@Injectable()` class:

```ts
/** The three evidence types carry only their own definitions; the older types keep the shared map. */
function definitionsFor(reportType: PlatformReportInput["reportType"]): Record<string, string> {
  switch (reportType) {
    case "usage":
      return { ...EVIDENCE_COMMON_DEFINITIONS, ...USAGE_DEFINITIONS };
    default:
      return { ...REPORT_DEFINITIONS };
  }
}
```

Add a branch before the `commerceml` one inside the transaction:

```ts
          if (input.reportType === "usage") {
            columns = [...USAGE_COLUMNS];
            rows = await loadUsageRows(tx, input);
          } else if (input.reportType === "commerceml") {
```

(the existing `if (input.reportType === "commerceml") {` becomes `} else if (...)` as shown) and replace `definitions: { ...REPORT_DEFINITIONS },` with `definitions: definitionsFor(input.reportType),`.

- [ ] **Step 7: Run the tests, typecheck and lint**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/platform-report-evidence-definitions.test.ts test/platform-report-usage-source.test.ts test/platform-report-source.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
```

Expected: PASS with a local database. Without one the two DB files skip; the definitions test still passes and the skip must be reported.

- [ ] **Step 8: Record the query cost**

With the disposable database from the "Test database" section running, execute the report through `EXPLAIN` to confirm the `scans` CTE uses the `scan_events` `(shift_id, scanned_at)` index and prunes partitions by the window:

```bash
docker exec markiro-evidence-reports-pg psql -U markiro -d markiro -c "EXPLAIN SELECT count(*) FROM shifts s JOIN scan_events v ON v.shift_id = s.id AND v.tenant_id = s.tenant_id WHERE s.tenant_id = 'x' AND v.verdict = 'ok' AND v.scanned_at >= '2026-09-01' AND v.scanned_at < '2026-09-03'"
```

Expected: the plan touches only the September partition and does not sequentially scan other tenants' rows. A fixture database is small, so this only checks plan shape, not run time. State plainly in the final report that the 366-day, 10-tenant time budget is unmeasured without production-sized data.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/platform-reports apps/api/test/support/platform-report-evidence-base.ts apps/api/test/platform-report-evidence-definitions.test.ts apps/api/test/platform-report-usage-source.test.ts
git commit -m "feat(reports): usage report source" \
  -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `quality` report source

**Files:**
- Create: `apps/api/src/platform-reports/quality-report-source.ts`
- Modify: `apps/api/src/platform-reports/report-source.service.ts`
- Modify: `apps/api/test/platform-report-evidence-definitions.test.ts`
- Test: `apps/api/test/platform-report-quality-source.test.ts` (create)

**Interfaces:**
- Consumes: `localDay`, `pivotMetrics`, `reportRows`, `tenantScope`, `inWindow` (Task 4); `loadInventoryRows` from `inventory-report-source.ts` (unchanged); `seedEvidenceBase`, `cleanupEvidence` (Task 4); `seedReportInventory` (existing).
- Produces: `QUALITY_COLUMNS`, `QUALITY_DEFINITIONS`, `loadQualityRows(tx, input)`, and the pure `mergeInventoryCompletions(rows, completions, projections): ReportRow[]`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/test/platform-report-evidence-definitions.test.ts` (extend the imports and the `describe`):

```ts
import { QUALITY_COLUMNS, QUALITY_DEFINITIONS } from "../src/platform-reports/quality-report-source";
```

```ts
  it("defines every quality column", () => {
    expect(undefinedColumns(QUALITY_COLUMNS, QUALITY_DEFINITIONS)).toEqual([]);
  });
```

Create `apps/api/test/platform-report-quality-source.test.ts`:

```ts
import { createDb, schema } from "@markiro/db";
import type { PlatformReportInput } from "@markiro/platform-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mergeInventoryCompletions,
  QUALITY_COLUMNS,
} from "../src/platform-reports/quality-report-source";
import { PlatformReportSourceService } from "../src/platform-reports/report-source.service";
import {
  cleanupEvidence,
  seedEvidenceBase,
  type EvidenceBase,
} from "./support/platform-report-evidence-base";
import { seedReportInventory } from "./support/platform-report-inventory-fixture";

describe("mergeInventoryCompletions", () => {
  const empty = {
    tenant_id: "t",
    tenant_name: "T",
    day: "2026-09-01",
    accepted_scans: 4,
  };
  it("adds completed inventories to an existing tenant-day and creates a missing one", () => {
    const rows = mergeInventoryCompletions(
      [empty],
      [
        { tenant_id: "t", tenant_name: "T", inventory_id: "i-1", day: "2026-09-01", has_snapshot: 1 },
        { tenant_id: "t", tenant_name: "T", inventory_id: "i-2", day: "2026-09-03", has_snapshot: 0 },
      ],
      [{ tenant_id: "t", inventory_id: "i-1", current_expected: 3, current_missing_expected: 2 }],
    );
    expect(rows).toEqual([
      expect.objectContaining({
        day: "2026-09-01",
        accepted_scans: 4,
        inventories_completed_with_snapshot: 1,
        inventory_expected_current: 3,
        inventory_missing_expected_current: 2,
      }),
      expect.objectContaining({
        tenant_name: "T",
        day: "2026-09-03",
        accepted_scans: 0,
        inventories_completed_with_snapshot: 0,
        inventory_expected_current: 0,
        inventory_missing_expected_current: 0,
      }),
    ]);
  });
  it("skips null projection values instead of inferring zero-valued facts", () => {
    const [row] = mergeInventoryCompletions(
      [],
      [{ tenant_id: "t", tenant_name: "T", inventory_id: "i-1", day: "2026-09-01", has_snapshot: 1 }],
      [{ tenant_id: "t", inventory_id: "i-1", current_expected: null, current_missing_expected: null }],
    );
    expect(row).toMatchObject({ inventory_expected_current: 0, inventory_missing_expected_current: 0 });
  });
});

const url = process.env.DATABASE_URL;
const local = url ? ["localhost", "127.0.0.1"].includes(new URL(url).hostname) : false;

describe.skipIf(!local)("quality report projection on real Postgres", () => {
  const { db, pool } = createDb(url ?? "postgres://localhost:55439/unavailable");
  const service = new PlatformReportSourceService(db);
  let base: EvidenceBase;
  let input: PlatformReportInput;

  beforeAll(async () => {
    base = await seedEvidenceBase(db);
    input = {
      reportType: "quality",
      tenantIds: [base.tenant],
      fromDate: "2026-09-01",
      toDate: "2026-09-02",
      timezone: "Europe/Moscow",
      periodBasis: "events",
      privacy: "identified",
    };
    const scan = (verdict: string, at: string) => ({
      tenantId: base.tenant,
      shiftId: base.shiftOne,
      terminalId: "t-1",
      operatorId: base.operatorOne,
      raw: "raw-scan-secret",
      verdict,
      scannedAt: new Date(at),
    });
    await db.insert(schema.scanEvents).values([
      scan("ok", "2026-09-01T09:00:00Z"),
      scan("ok", "2026-09-01T09:05:00Z"),
      scan("duplicate", "2026-09-01T10:00:00Z"),
      scan("wrong_gtin", "2026-09-01T10:05:00Z"),
      scan("invalid", "2026-09-01T10:10:00Z"),
      // 2026-09-01T22:00Z is local 2026-09-02 01:00 in Moscow.
      scan("duplicate", "2026-09-01T22:00:00Z"),
      scan("duplicate", "2026-09-01T22:05:00Z"),
      scan("ok", "2026-09-02T05:00:00Z"),
    ]);
    await db.insert(schema.codeConflicts).values([
      {
        tenantId: base.tenant,
        codeHash: "a".repeat(64),
        losingShiftId: base.shiftOne,
        winningShiftId: base.shiftOne,
        losingScannedAt: new Date("2026-08-20T00:00:00Z"),
        winningScannedAt: new Date("2026-08-19T00:00:00Z"),
        detectedAt: new Date("2026-09-01T17:00:00Z"),
        reviewedAt: new Date("2026-09-02T09:00:00Z"),
      },
      {
        tenantId: base.tenant,
        codeHash: "b".repeat(64),
        losingShiftId: base.shiftOne,
        winningShiftId: base.shiftOne,
        losingScannedAt: new Date("2026-08-20T00:00:00Z"),
        winningScannedAt: new Date("2026-08-19T00:00:00Z"),
        detectedAt: new Date("2026-09-01T18:00:00Z"),
      },
    ]);
    let boxNumber = 0;
    const box = (
      values: Partial<typeof schema.boxes.$inferInsert>,
    ): typeof schema.boxes.$inferInsert => ({
      tenantId: base.tenant,
      shiftId: base.shiftOne,
      terminalId: "t-1",
      operatorId: base.operatorOne,
      deviceBoxId: `q-box-${++boxNumber}`,
      openedAt: new Date("2026-08-20T00:00:00Z"),
      ...values,
    });
    // Closure lag = closure_received_at - closed_at. Bucket edges are half-open.
    await db.insert(schema.boxes).values([
      // lag 0 -> lt_1h
      box({
        closedAt: new Date("2026-09-01T08:00:00Z"),
        closureReceivedAt: new Date("2026-09-01T08:00:00Z"),
      }),
      // lag exactly 1 h -> lt_24h
      box({
        closedAt: new Date("2026-09-01T07:00:00Z"),
        closureReceivedAt: new Date("2026-09-01T08:00:00Z"),
      }),
      // lag exactly 24 h -> lt_7d
      box({
        closedAt: new Date("2026-08-31T08:00:00Z"),
        closureReceivedAt: new Date("2026-09-01T08:00:00Z"),
      }),
      // lag exactly 7 d -> ge_7d
      box({
        closedAt: new Date("2026-08-25T08:00:00Z"),
        closureReceivedAt: new Date("2026-09-01T08:00:00Z"),
      }),
      // device clock ahead of the server -> clock_ahead
      box({
        closedAt: new Date("2026-09-01T09:00:00Z"),
        closureReceivedAt: new Date("2026-09-01T08:00:00Z"),
      }),
      // no device closure time -> unknown
      box({ closedAt: null, closureReceivedAt: new Date("2026-09-01T08:00:00Z") }),
      // lag 15 min -> lt_1h, and disassembled on day one (server clock)
      box({
        closedAt: new Date("2026-09-01T07:45:00Z"),
        closureReceivedAt: new Date("2026-09-01T08:00:00Z"),
        disassembledAt: new Date("2026-09-01T14:00:00Z"),
        disassemblyReceivedAt: new Date("2026-09-01T15:00:00Z"),
      }),
      // lag 2 h, received on local day two -> lt_24h on 2026-09-02
      box({
        closedAt: new Date("2026-09-01T23:00:00Z"),
        closureReceivedAt: new Date("2026-09-02T01:00:00Z"),
      }),
    ]);
    const [pallet] = await db
      .insert(schema.pallets)
      .values({
        tenantId: base.tenant,
        shiftId: base.shiftOne,
        kind: "production",
        devicePalletId: "q-pp-1",
        terminalId: "t-1",
      })
      .returning({ id: schema.pallets.id });
    await db.insert(schema.palletExceptions).values([
      {
        tenantId: base.tenant,
        kind: "disassemble",
        palletId: pallet!.id,
        shiftId: base.shiftOne,
        terminalId: "t-1",
        operatorId: base.operatorOne,
        reason: "operator request",
        occurredAt: new Date("2026-09-02T09:50:00Z"),
        recordedAt: new Date("2026-09-02T10:00:00Z"),
      },
      {
        tenantId: base.tenant,
        kind: "reprint",
        palletId: pallet!.id,
        shiftId: base.shiftOne,
        terminalId: "t-1",
        operatorId: base.operatorOne,
        reason: "damaged",
        occurredAt: new Date("2026-09-01T10:50:00Z"),
        recordedAt: new Date("2026-09-01T11:00:00Z"),
      },
    ]);
    await db.insert(schema.syncBatches).values({
      tenantId: base.tenant,
      batchId: "q-batch",
      terminalId: base.stationDevice,
      payloadDigest: "a".repeat(64),
      result: {},
    });
    await db.insert(schema.stationSyncQuarantine).values(
      [
        [0, "2026-09-01T12:00:00Z"],
        [1, "2026-09-02T12:00:00Z"],
      ].map(([index, at]) => ({
        tenantId: base.tenant,
        batchId: "q-batch",
        terminalId: base.stationDevice,
        payloadDigest: "a".repeat(64),
        recordKind: "box",
        recordIndex: index as number,
        reason: "subscription_read_only",
        payload: { secret: "quarantine-secret" },
        quarantinedAt: new Date(at as string),
      })),
    );
    // Completed 2026-09-01T10:00Z with expected_count 3 and 2 missing expected codes.
    await seedReportInventory(db, {
      tenant: base.tenant,
      product: base.product,
      line: base.lineOne,
      operator: base.operatorOne,
      user: base.user,
    });
  });

  afterAll(async () => {
    await cleanupEvidence(db, [base.tenant, base.other], { users: [base.user] });
    await pool.end();
  });

  it("counts verdicts, conflicts, disassemblies, lag buckets, quarantine and inventories per tenant-day", async () => {
    const result = await service.load(input);
    expect(result.columns).toEqual([...QUALITY_COLUMNS]);
    expect(result.rows).toEqual([
      {
        tenant_id: base.tenant,
        tenant_name: "Evidence fixture A",
        day: "2026-09-01",
        accepted_scans: 2,
        duplicate_scans: 1,
        wrong_gtin_scans: 1,
        invalid_scans: 1,
        code_conflicts_detected: 2,
        code_conflicts_reviewed: 0,
        box_disassemblies: 1,
        pallet_disassemblies: 0,
        box_closure_lag_clock_ahead: 1,
        box_closure_lag_lt_1h: 2,
        box_closure_lag_lt_24h: 1,
        box_closure_lag_lt_7d: 1,
        box_closure_lag_ge_7d: 1,
        box_closure_lag_unknown: 1,
        sync_quarantined_records: 1,
        inventories_completed_with_snapshot: 1,
        inventory_expected_current: 3,
        inventory_missing_expected_current: 2,
      },
      {
        tenant_id: base.tenant,
        tenant_name: "Evidence fixture A",
        day: "2026-09-02",
        accepted_scans: 1,
        duplicate_scans: 2,
        wrong_gtin_scans: 0,
        invalid_scans: 0,
        code_conflicts_detected: 0,
        code_conflicts_reviewed: 1,
        box_disassemblies: 0,
        pallet_disassemblies: 1,
        box_closure_lag_clock_ahead: 0,
        box_closure_lag_lt_1h: 0,
        box_closure_lag_lt_24h: 1,
        box_closure_lag_lt_7d: 0,
        box_closure_lag_ge_7d: 0,
        box_closure_lag_unknown: 0,
        sync_quarantined_records: 1,
        inventories_completed_with_snapshot: 0,
        inventory_expected_current: 0,
        inventory_missing_expected_current: 0,
      },
    ]);
    const text = JSON.stringify(result);
    expect(text).not.toContain("raw-scan-secret");
    expect(text).not.toContain("quarantine-secret");
  });

  it("keeps a foreign tenant out of the selection", async () => {
    const result = await service.load(input);
    expect(result.rows.every((row) => row.tenant_id === base.tenant)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/api exec vitest run test/platform-report-evidence-definitions.test.ts test/platform-report-quality-source.test.ts`
Expected: FAIL — `quality-report-source` cannot be resolved.

- [ ] **Step 3: Implement `quality-report-source.ts`**

Create `apps/api/src/platform-reports/quality-report-source.ts`:

```ts
import type { PlatformReportInput } from "@markiro/platform-contracts";
import { sql } from "drizzle-orm";
import { loadInventoryRows } from "./inventory-report-source";
import { REPORT_MAX_ROWS, type ReportRow } from "./report-definitions";
import {
  inWindow,
  localDay,
  pivotMetrics,
  reportRows,
  tenantScope,
  type ReportTransaction,
} from "./report-query";

export const QUALITY_COLUMNS = [
  "tenant_id",
  "tenant_name",
  "day",
  "accepted_scans",
  "duplicate_scans",
  "wrong_gtin_scans",
  "invalid_scans",
  "code_conflicts_detected",
  "code_conflicts_reviewed",
  "box_disassemblies",
  "pallet_disassemblies",
  "box_closure_lag_clock_ahead",
  "box_closure_lag_lt_1h",
  "box_closure_lag_lt_24h",
  "box_closure_lag_lt_7d",
  "box_closure_lag_ge_7d",
  "box_closure_lag_unknown",
  "sync_quarantined_records",
  "inventories_completed_with_snapshot",
  "inventory_expected_current",
  "inventory_missing_expected_current",
] as const;
const INVENTORY_COLUMNS_MERGED = [
  "inventories_completed_with_snapshot",
  "inventory_expected_current",
  "inventory_missing_expected_current",
] as const;
const SQL_METRICS = QUALITY_COLUMNS.slice(3).filter(
  (column) => !(INVENTORY_COLUMNS_MERGED as readonly string[]).includes(column),
);

export const QUALITY_DEFINITIONS: Record<string, string> = {
  accepted_scans:
    "scan_events with verdict=ok at scanned_at (device clock). Accepted unit scan evidence, not current registry ownership.",
  duplicate_scans: "scan_events with verdict=duplicate at scanned_at (device clock).",
  wrong_gtin_scans: "scan_events with verdict=wrong_gtin at scanned_at (device clock).",
  invalid_scans: "scan_events with verdict=invalid at scanned_at (device clock).",
  code_conflicts_detected:
    "code_conflicts at detected_at (server clock), counted for the losing shift's tenant. The shift report counts conflicts per losing shift; the two are not reconciled.",
  code_conflicts_reviewed: "code_conflicts at reviewed_at (server clock).",
  box_disassemblies:
    "Boxes with disassembly_received_at on the day (server clock at receipt). boxes.disassembled_at is the operator's device clock and is not used here, so this differs from the shift report's disassembled_boxes.",
  pallet_disassemblies:
    "pallet_exceptions with kind=disassemble at recorded_at (server clock). pallets.disassembled_at is a device clock and is not used.",
  box_closure_lag_clock_ahead:
    "Boxes received on the day whose device closed_at is later than the server closure_received_at (negative lag, the device clock ran ahead).",
  box_closure_lag_lt_1h:
    "Boxes received on the day with 0 <= closure_received_at - closed_at < 1 hour.",
  box_closure_lag_lt_24h:
    "Boxes received on the day with 1 hour <= lag < 24 hours. Bucket bounds are half-open.",
  box_closure_lag_lt_7d: "Boxes received on the day with 24 hours <= lag < 7 days.",
  box_closure_lag_ge_7d: "Boxes received on the day with lag of 7 days or more.",
  box_closure_lag_unknown: "Boxes received on the day whose device closed_at is null.",
  sync_quarantined_records:
    "station_sync_quarantine rows at quarantined_at (server clock). Quarantine rows have no resolved flag, so this counts records quarantined, not records still unresolved.",
  inventories_completed_with_snapshot:
    "Inventories with completed_at on the day (server clock) that have an active snapshot.",
  inventory_expected_current:
    "Sum of the active snapshot expected_count of those inventories. A current projection at generation time, not an event-time reconstruction.",
  inventory_missing_expected_current:
    "Sum of the current missing-expected count of those inventories (expected minus current expected-classified results of the snapshot, floored at zero). A current projection at generation time, not an event-time reconstruction.",
};

function add(row: ReportRow, column: string, amount: number): void {
  const current = row[column];
  row[column] = (typeof current === "number" ? current : 0) + amount;
}

function byTenantDay(a: ReportRow, b: ReportRow): number {
  const left = `${String(a.tenant_id)}|${String(a.day)}`;
  const right = `${String(b.tenant_id)}|${String(b.day)}`;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Joins the SQL fact rows to completed inventories. `completions` has one row per completed
 * inventory (tenant_id, tenant_name, inventory_id, day, has_snapshot); `projections` are the rows
 * of the existing inventory report, whose current_* values are read as they are.
 */
export function mergeInventoryCompletions(
  factRows: ReportRow[],
  completions: ReportRow[],
  projections: ReportRow[],
): ReportRow[] {
  const rows = new Map<string, ReportRow>();
  const key = (tenantId: unknown, day: unknown) => `${String(tenantId)}|${String(day)}`;
  for (const row of factRows) {
    rows.set(key(row.tenant_id, row.day), {
      ...row,
      inventories_completed_with_snapshot: 0,
      inventory_expected_current: 0,
      inventory_missing_expected_current: 0,
    });
  }
  const projection = new Map(
    projections.map((row) => [key(row.tenant_id, row.inventory_id), row]),
  );
  for (const done of completions) {
    const rowKey = key(done.tenant_id, done.day);
    let row = rows.get(rowKey);
    if (!row) {
      row = { tenant_id: done.tenant_id ?? null, tenant_name: done.tenant_name ?? null, day: done.day ?? null };
      for (const column of QUALITY_COLUMNS.slice(3)) row[column] = 0;
      rows.set(rowKey, row);
    }
    if (done.has_snapshot === 1) add(row, "inventories_completed_with_snapshot", 1);
    const current = projection.get(key(done.tenant_id, done.inventory_id));
    if (typeof current?.current_expected === "number")
      add(row, "inventory_expected_current", current.current_expected);
    if (typeof current?.current_missing_expected === "number")
      add(row, "inventory_missing_expected_current", current.current_missing_expected);
  }
  return [...rows.values()].sort(byTenantDay);
}

export async function loadQualityRows(tx: ReportTransaction, input: PlatformReportInput) {
  const factRows = await reportRows(
    tx,
    sql`
    WITH scans AS MATERIALIZED (
      -- Reach scan_events through the tenant's shifts so the (shift_id, scanned_at) index is used.
      SELECT v.tenant_id, v.verdict, ${localDay(sql`v.scanned_at`, input)} AS local_day
      FROM shifts s
      JOIN scan_events v ON v.shift_id = s.id AND v.tenant_id = s.tenant_id
      WHERE ${tenantScope(sql`s.tenant_id`, input)}
        AND v.verdict IN ('ok', 'duplicate', 'wrong_gtin', 'invalid')
        AND ${inWindow(sql`v.scanned_at`, input)}
    ), closures AS MATERIALIZED (
      SELECT b.tenant_id, ${localDay(sql`b.closure_received_at`, input)} AS local_day,
        CASE
          WHEN b.closed_at IS NULL THEN 'unknown'
          WHEN extract(epoch FROM (b.closure_received_at - b.closed_at)) < 0 THEN 'clock_ahead'
          WHEN extract(epoch FROM (b.closure_received_at - b.closed_at)) < 3600 THEN 'lt_1h'
          WHEN extract(epoch FROM (b.closure_received_at - b.closed_at)) < 86400 THEN 'lt_24h'
          WHEN extract(epoch FROM (b.closure_received_at - b.closed_at)) < 604800 THEN 'lt_7d'
          ELSE 'ge_7d'
        END AS bucket
      FROM boxes b
      WHERE ${tenantScope(sql`b.tenant_id`, input)}
        AND ${inWindow(sql`b.closure_received_at`, input)}
    ), metrics AS (
      SELECT tenant_id, local_day, 'accepted_scans' AS metric, count(*)::numeric AS n
        FROM scans WHERE verdict = 'ok' GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'duplicate_scans', count(*)::numeric
        FROM scans WHERE verdict = 'duplicate' GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'wrong_gtin_scans', count(*)::numeric
        FROM scans WHERE verdict = 'wrong_gtin' GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'invalid_scans', count(*)::numeric
        FROM scans WHERE verdict = 'invalid' GROUP BY tenant_id, local_day
      UNION ALL SELECT c.tenant_id, ${localDay(sql`c.detected_at`, input)}, 'code_conflicts_detected', count(*)::numeric
        FROM code_conflicts c
        WHERE ${tenantScope(sql`c.tenant_id`, input)} AND ${inWindow(sql`c.detected_at`, input)}
        GROUP BY 1, 2
      UNION ALL SELECT c.tenant_id, ${localDay(sql`c.reviewed_at`, input)}, 'code_conflicts_reviewed', count(*)::numeric
        FROM code_conflicts c
        WHERE ${tenantScope(sql`c.tenant_id`, input)} AND ${inWindow(sql`c.reviewed_at`, input)}
        GROUP BY 1, 2
      UNION ALL SELECT b.tenant_id, ${localDay(sql`b.disassembly_received_at`, input)}, 'box_disassemblies', count(*)::numeric
        FROM boxes b
        WHERE ${tenantScope(sql`b.tenant_id`, input)} AND ${inWindow(sql`b.disassembly_received_at`, input)}
        GROUP BY 1, 2
      UNION ALL SELECT x.tenant_id, ${localDay(sql`x.recorded_at`, input)}, 'pallet_disassemblies', count(*)::numeric
        FROM pallet_exceptions x
        WHERE ${tenantScope(sql`x.tenant_id`, input)} AND x.kind = 'disassemble'
          AND ${inWindow(sql`x.recorded_at`, input)}
        GROUP BY 1, 2
      UNION ALL SELECT tenant_id, local_day, 'box_closure_lag_' || bucket, count(*)::numeric
        FROM closures GROUP BY tenant_id, local_day, bucket
      UNION ALL SELECT q.tenant_id, ${localDay(sql`q.quarantined_at`, input)}, 'sync_quarantined_records', count(*)::numeric
        FROM station_sync_quarantine q
        WHERE ${tenantScope(sql`q.tenant_id`, input)} AND ${inWindow(sql`q.quarantined_at`, input)}
        GROUP BY 1, 2
    )
    SELECT m.tenant_id, o.name AS tenant_name, m.local_day::text AS day,
      ${pivotMetrics(SQL_METRICS)}
    FROM metrics m
    JOIN organization o ON o.id = m.tenant_id
    GROUP BY m.tenant_id, o.name, m.local_day
    ORDER BY m.tenant_id, m.local_day
    LIMIT ${REPORT_MAX_ROWS + 1}
  `,
  );
  const completions = await reportRows(
    tx,
    sql`
    SELECT i.tenant_id, o.name AS tenant_name, i.id::text AS inventory_id,
      ${localDay(sql`i.completed_at`, input)}::text AS day,
      (i.active_snapshot_id IS NOT NULL)::int AS has_snapshot
    FROM inventories i
    JOIN organization o ON o.id = i.tenant_id
    WHERE ${tenantScope(sql`i.tenant_id`, input)} AND ${inWindow(sql`i.completed_at`, input)}
    ORDER BY i.tenant_id, i.id
    LIMIT ${REPORT_MAX_ROWS + 1}
  `,
  );
  // The projection is the existing inventory report's own; it is only read when something completed.
  const projections = completions.length > 0 ? await loadInventoryRows(tx, input) : [];
  return mergeInventoryCompletions(factRows, completions, projections);
}
```

- [ ] **Step 4: Dispatch `quality`**

In `apps/api/src/platform-reports/report-source.service.ts` add the import:

```ts
import { QUALITY_COLUMNS, QUALITY_DEFINITIONS, loadQualityRows } from "./quality-report-source";
```

Add the case to `definitionsFor`:

```ts
    case "quality":
      return { ...EVIDENCE_COMMON_DEFINITIONS, ...QUALITY_DEFINITIONS };
```

Insert this branch immediately before the line `} else if (input.reportType === "commerceml") {`, so it follows the `usage` branch body:

```ts
          } else if (input.reportType === "quality") {
            columns = [...QUALITY_COLUMNS];
            rows = await loadQualityRows(tx, input);
```

- [ ] **Step 5: Run the tests, typecheck and lint**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/platform-report-evidence-definitions.test.ts test/platform-report-quality-source.test.ts test/platform-report-source.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
```

Expected: PASS. The two `mergeInventoryCompletions` tests are pure and always run; the DB block needs a local database.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/platform-reports apps/api/test
git commit -m "feat(reports): quality report source" \
  -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `commercial` report source

**Files:**
- Create: `apps/api/src/platform-reports/commercial-report-source.ts`
- Modify: `apps/api/src/platform-reports/report-source.service.ts`
- Modify: `apps/api/test/platform-report-evidence-definitions.test.ts`
- Test: `apps/api/test/platform-report-commercial-source.test.ts` (create)

**Interfaces:**
- Consumes: `pivotMetrics`, `localDay`, `reportRows`, `tenantScope`, `inWindow`; `seedEvidenceBase`, `cleanupEvidence`; `createOrganization`, `createPublishedPlan`, `createManagedSubscription` from `apps/api/test/support/subscription-fixtures.ts`.
- Produces: `COMMERCIAL_COLUMNS`, `COMMERCIAL_DEFINITIONS`, `loadCommercialRows(tx, input)`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/test/platform-report-evidence-definitions.test.ts`:

```ts
import {
  COMMERCIAL_COLUMNS,
  COMMERCIAL_DEFINITIONS,
} from "../src/platform-reports/commercial-report-source";
```

```ts
  it("defines every commercial column", () => {
    expect(undefinedColumns(COMMERCIAL_COLUMNS, COMMERCIAL_DEFINITIONS)).toEqual([]);
  });
```

Create `apps/api/test/platform-report-commercial-source.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { createDb, schema } from "@markiro/db";
import type { PlatformReportInput } from "@markiro/platform-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMMERCIAL_COLUMNS } from "../src/platform-reports/commercial-report-source";
import { PlatformReportSourceService } from "../src/platform-reports/report-source.service";
import {
  cleanupEvidence,
  seedEvidenceBase,
  type EvidenceBase,
} from "./support/platform-report-evidence-base";
import { createOrganization, createPublishedPlan } from "./support/subscription-fixtures";

const url = process.env.DATABASE_URL;
const local = url ? ["localhost", "127.0.0.1"].includes(new URL(url).hostname) : false;

describe.skipIf(!local)("commercial report projection on real Postgres", () => {
  const { db, pool } = createDb(url ?? "postgres://localhost:55439/unavailable");
  const service = new PlatformReportSourceService(db);
  const actor = randomUUID();
  let base: EvidenceBase;
  let tenantC: string;
  let tenantD: string;
  let planVersionId: string;
  let input: PlatformReportInput;

  async function paidOfferSubscription(
    tenantId: string,
    values: { status: "active" | "pending_activation"; startsAt: Date | null; createdAt: Date },
  ) {
    const offerId = randomUUID();
    const offerLineId = randomUUID();
    await db
      .insert(schema.commercialOffers)
      .values({ id: offerId, tenantId, revision: 1, status: "draft", total: "120.00" });
    await db.insert(schema.commercialOfferLines).values({
      id: offerLineId,
      tenantId,
      offerId,
      position: 1,
      kind: "plan",
      catalogVersionId: planVersionId,
      nameRu: "Evidence plan",
      nameEn: "Evidence plan",
      quantity: 1,
      unit: "месяц",
      agreedUnitPrice: "100.00",
      vatRate: "20.00",
      vatIncluded: false,
      lineTotal: "100.00",
      activationPolicy: "immediately",
    });
    await db.insert(schema.tenantSubscriptions).values({
      tenantId,
      planVersionId,
      status: values.status,
      source: "paid_offer_line",
      sourceOfferLineId: offerLineId,
      startsAt: values.startsAt,
      endsAt: null,
      createdAt: values.createdAt,
    });
    return offerId;
  }

  beforeAll(async () => {
    base = await seedEvidenceBase(db);
    tenantC = await createOrganization(db);
    tenantD = await createOrganization(db);
    planVersionId = await createPublishedPlan(db, {
      maxLines: 1,
      maxStations: 1,
      maxKiosks: 1,
      maxCabinetUsers: 1,
    });
    input = {
      reportType: "commercial",
      tenantIds: [base.tenant],
      fromDate: "2026-09-01",
      toDate: "2026-09-02",
      timezone: "Europe/Moscow",
      periodBasis: "events",
      privacy: "identified",
    };
    await db.insert(schema.platformUsers).values({
      id: actor,
      name: "Evidence actor",
      email: `${actor}@example.invalid`,
      role: "platform_admin",
      status: "active",
    });
    const invoice = (
      values: Partial<typeof schema.invoices.$inferInsert> & { subtotal: string; vatTotal: string; total: string },
    ): typeof schema.invoices.$inferInsert => ({
      tenantId: base.tenant,
      number: `EV-${randomUUID()}`,
      status: "issued",
      issueDate: new Date("2026-09-01T00:00:00Z"),
      sellerSnapshot: {},
      buyerSnapshot: {},
      createdByPlatformUserId: actor,
      ...values,
    });
    const invoiceIds = { issued: randomUUID(), paid: randomUUID(), cancelled: randomUUID() };
    await db.insert(schema.invoices).values([
      invoice({
        id: invoiceIds.issued,
        subtotal: "1000.00",
        vatTotal: "200.00",
        total: "1200.00",
        issuedAt: new Date("2026-09-01T09:00:00Z"),
      }),
      invoice({
        id: invoiceIds.paid,
        status: "paid",
        subtotal: "500.00",
        vatTotal: "100.00",
        total: "600.00",
        issuedAt: new Date("2026-09-01T10:00:00Z"),
        paidAt: new Date("2026-09-02T11:00:00Z"),
      }),
      // Issued on local 2026-08-31 23:00, cancelled on 2026-09-01: counts only as cancelled.
      invoice({
        id: invoiceIds.cancelled,
        status: "cancelled",
        subtotal: "300.50",
        vatTotal: "60.10",
        total: "360.60",
        issuedAt: new Date("2026-08-31T20:00:00Z"),
        cancelledAt: new Date("2026-09-01T12:00:00Z"),
      }),
      // A draft is never issued.
      invoice({ status: "draft", issueDate: null, sellerSnapshot: null, buyerSnapshot: null, subtotal: "0", vatTotal: "0", total: "0" }),
      // Foreign tenant, issued in the window.
      invoice({
        tenantId: base.other,
        subtotal: "77.00",
        vatTotal: "0.00",
        total: "77.00",
        issuedAt: new Date("2026-09-01T09:00:00Z"),
      }),
    ]);
    await db.insert(schema.billingPayments).values([
      {
        tenantId: base.tenant,
        invoiceId: invoiceIds.issued,
        source: "manual",
        paidAt: new Date("2026-09-01T13:00:00Z"),
        amount: "400.00",
        bankReference: `EV-${randomUUID()}`,
        platformUserId: actor,
        idempotencyKey: `ev-${randomUUID()}`,
      },
      {
        tenantId: base.tenant,
        invoiceId: invoiceIds.paid,
        source: "manual",
        paidAt: new Date("2026-09-02T11:00:00Z"),
        amount: "600.00",
        bankReference: `EV-${randomUUID()}`,
        platformUserId: actor,
        idempotencyKey: `ev-${randomUUID()}`,
      },
    ]);
    // Legacy offer payment: a separate flow from invoice payments, summed with them.
    const legacyOfferId = randomUUID();
    await db
      .insert(schema.commercialOffers)
      .values({ id: legacyOfferId, tenantId: base.tenant, revision: 1, status: "draft", total: "250.00" });
    await db.insert(schema.payments).values({
      tenantId: base.tenant,
      offerId: legacyOfferId,
      paidAt: new Date("2026-09-01T14:00:00Z"),
      amount: "250.00",
      bankReference: `EV-${randomUUID()}`,
      platformUserId: actor,
      idempotencyKey: `ev-${randomUUID()}`,
    });
    await db.insert(schema.billingActs).values([
      {
        tenantId: base.tenant,
        number: `EV-ACT-${randomUUID()}`,
        status: "issued",
        periodStart: "2026-08-01",
        periodEnd: "2026-08-31",
        createdByPlatformUserId: actor,
        issuedByPlatformUserId: actor,
        issuedAt: new Date("2026-09-01T15:00:00Z"),
      },
      {
        tenantId: base.tenant,
        number: `EV-ACT-${randomUUID()}`,
        status: "draft",
        periodStart: "2026-08-01",
        periodEnd: "2026-08-31",
        createdByPlatformUserId: actor,
      },
    ]);
    await paidOfferSubscription(base.tenant, {
      status: "active",
      startsAt: new Date("2026-09-01T06:00:00Z"),
      createdAt: new Date("2026-08-01T00:00:00Z"),
    });
    const agreement = (
      values: Partial<typeof schema.platformAgreements.$inferInsert>,
    ): typeof schema.platformAgreements.$inferInsert => ({
      number: `EV-AGR-${randomUUID()}`,
      counterparty: {},
      contractor: {},
      terms: {},
      createdByPlatformUserId: actor,
      ...values,
    });
    await db.insert(schema.platformAgreements).values([
      agreement({
        status: "signed",
        tenantId: base.tenant,
        signedAt: new Date("2026-09-01T16:00:00Z"),
        signedSnapshot: {},
      }),
      // Signed but not linked to a tenant: never reported.
      agreement({ status: "signed", signedAt: new Date("2026-09-01T16:30:00Z"), signedSnapshot: {} }),
      agreement({ status: "draft", tenantId: base.tenant }),
    ]);
    // Tenant C: a paid subscription with no start date falls back to its creation time.
    await paidOfferSubscription(tenantC, {
      status: "pending_activation",
      startsAt: null,
      createdAt: new Date("2026-09-02T06:00:00Z"),
    });
    // Tenant D: a manual subscription is not a paid one.
    await db.insert(schema.tenantSubscriptions).values({
      tenantId: tenantD,
      planVersionId,
      status: "active",
      source: "manual",
      startsAt: new Date("2026-09-01T06:00:00Z"),
      endsAt: new Date("2026-10-01T06:00:00Z"),
    });
  });

  afterAll(async () => {
    await cleanupEvidence(db, [base.tenant, base.other, tenantC, tenantD], {
      users: [base.user],
      platformUsers: [actor],
    });
    await pool.end();
  });

  it("counts invoices, payments from both flows, acts, paid subscriptions and agreements in kopecks", async () => {
    const result = await service.load(input);
    expect(result.columns).toEqual([...COMMERCIAL_COLUMNS]);
    expect(result.rows).toEqual([
      {
        tenant_id: base.tenant,
        tenant_name: "Evidence fixture A",
        day: "2026-09-01",
        invoices_issued: 2,
        invoices_issued_net_minor: 150000,
        invoices_issued_vat_minor: 30000,
        invoices_issued_total_minor: 180000,
        invoices_cancelled: 1,
        invoices_paid: 0,
        payments_received: 2,
        payments_received_minor: 65000,
        acts_issued: 1,
        paid_subscriptions_started: 1,
        agreements_signed: 1,
      },
      {
        tenant_id: base.tenant,
        tenant_name: "Evidence fixture A",
        day: "2026-09-02",
        invoices_issued: 0,
        invoices_issued_net_minor: 0,
        invoices_issued_vat_minor: 0,
        invoices_issued_total_minor: 0,
        invoices_cancelled: 0,
        invoices_paid: 1,
        payments_received: 1,
        payments_received_minor: 60000,
        acts_issued: 0,
        paid_subscriptions_started: 0,
        agreements_signed: 0,
      },
    ]);
  });

  it("excludes the foreign tenant, drafts and unlinked agreements", async () => {
    const both = await service.load({ ...input, tenantIds: [base.tenant, base.other] });
    expect(both.rows.filter((row) => row.tenant_id === base.other)).toEqual([
      expect.objectContaining({ tenant_name: "Evidence fixture B", invoices_issued: 1, invoices_issued_total_minor: 7700, agreements_signed: 0 }),
    ]);
    const only = await service.load(input);
    expect(only.rows.every((row) => row.tenant_id === base.tenant)).toBe(true);
  });

  it("dates a paid subscription without a start date by its creation time and ignores manual ones", async () => {
    const result = await service.load({ ...input, tenantIds: [tenantC, tenantD] });
    expect(result.rows).toEqual([
      expect.objectContaining({ tenant_id: tenantC, day: "2026-09-02", paid_subscriptions_started: 1 }),
    ]);
  });

  it("does not expose financial documents or bank details", async () => {
    const text = JSON.stringify(await service.load(input));
    expect(text).not.toContain("EV-");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/api exec vitest run test/platform-report-evidence-definitions.test.ts test/platform-report-commercial-source.test.ts`
Expected: FAIL — `commercial-report-source` cannot be resolved.

- [ ] **Step 3: Implement `commercial-report-source.ts`**

Create `apps/api/src/platform-reports/commercial-report-source.ts`:

```ts
import type { PlatformReportInput } from "@markiro/platform-contracts";
import { sql } from "drizzle-orm";
import { REPORT_MAX_ROWS } from "./report-definitions";
import {
  inWindow,
  localDay,
  pivotMetrics,
  reportRows,
  tenantScope,
  type ReportTransaction,
} from "./report-query";

export const COMMERCIAL_COLUMNS = [
  "tenant_id",
  "tenant_name",
  "day",
  "invoices_issued",
  "invoices_issued_net_minor",
  "invoices_issued_vat_minor",
  "invoices_issued_total_minor",
  "invoices_cancelled",
  "invoices_paid",
  "payments_received",
  "payments_received_minor",
  "acts_issued",
  "paid_subscriptions_started",
  "agreements_signed",
] as const;
const COMMERCIAL_METRICS = COMMERCIAL_COLUMNS.slice(3);
const MONEY_METRICS = new Set([
  "invoices_issued_net_minor",
  "invoices_issued_vat_minor",
  "invoices_issued_total_minor",
  "payments_received_minor",
]);

export const COMMERCIAL_DEFINITIONS: Record<string, string> = {
  invoices_issued:
    "Invoices with issued_at on the day (server clock). A later cancellation does not remove them; it is counted separately in invoices_cancelled. Drafts have no issued_at and are never counted.",
  invoices_issued_net_minor:
    "Sum of invoices.subtotal of invoices_issued, in RUB kopecks (integer).",
  invoices_issued_vat_minor:
    "Sum of invoices.vat_total of invoices_issued, in RUB kopecks (integer).",
  invoices_issued_total_minor: "Sum of invoices.total of invoices_issued, in RUB kopecks (integer).",
  invoices_cancelled: "Invoices with cancelled_at on the day (server clock).",
  invoices_paid:
    "Invoices with paid_at on the day. paid_at is set only when the invoice is fully paid, so a partially paid invoice is not counted here.",
  payments_received:
    "Payments at paid_at: billing_payments (invoice payments) plus legacy payments (offer payments). The two flows are disjoint: an offer payment writes only payments and an invoice payment writes only billing_payments, so they are summed without deduplication. A partial payment is counted when received.",
  payments_received_minor:
    "Sum of the amounts of payments_received, in RUB kopecks (integer).",
  acts_issued: "billing_acts with issued_at on the day (server clock).",
  paid_subscriptions_started:
    "Subscriptions whose source is paid_offer_line or paid_invoice_line, dated by starts_at, or by created_at when starts_at is null. Demo, manual and other sources are not counted.",
  agreements_signed:
    "platform_agreements with signed_at on the day (server clock) whose tenant_id is a selected tenant. Agreements not linked to a tenant are never reported.",
};

export async function loadCommercialRows(tx: ReportTransaction, input: PlatformReportInput) {
  return reportRows(
    tx,
    sql`
    WITH received AS MATERIALIZED (
      SELECT p.tenant_id, ${localDay(sql`p.paid_at`, input)} AS local_day, p.amount
      FROM billing_payments p
      WHERE ${tenantScope(sql`p.tenant_id`, input)} AND ${inWindow(sql`p.paid_at`, input)}
      UNION ALL
      SELECT p.tenant_id, ${localDay(sql`p.paid_at`, input)}, p.amount
      FROM payments p
      WHERE ${tenantScope(sql`p.tenant_id`, input)} AND ${inWindow(sql`p.paid_at`, input)}
    ), issued AS MATERIALIZED (
      SELECT i.tenant_id, ${localDay(sql`i.issued_at`, input)} AS local_day,
        i.subtotal, i.vat_total, i.total
      FROM invoices i
      WHERE ${tenantScope(sql`i.tenant_id`, input)} AND ${inWindow(sql`i.issued_at`, input)}
    ), metrics AS (
      SELECT tenant_id, local_day, 'invoices_issued' AS metric, count(*)::numeric AS n
        FROM issued GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'invoices_issued_net_minor', coalesce(sum(round(subtotal * 100)), 0)::numeric
        FROM issued GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'invoices_issued_vat_minor', coalesce(sum(round(vat_total * 100)), 0)::numeric
        FROM issued GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'invoices_issued_total_minor', coalesce(sum(round(total * 100)), 0)::numeric
        FROM issued GROUP BY tenant_id, local_day
      UNION ALL SELECT i.tenant_id, ${localDay(sql`i.cancelled_at`, input)}, 'invoices_cancelled', count(*)::numeric
        FROM invoices i
        WHERE ${tenantScope(sql`i.tenant_id`, input)} AND ${inWindow(sql`i.cancelled_at`, input)}
        GROUP BY 1, 2
      UNION ALL SELECT i.tenant_id, ${localDay(sql`i.paid_at`, input)}, 'invoices_paid', count(*)::numeric
        FROM invoices i
        WHERE ${tenantScope(sql`i.tenant_id`, input)} AND ${inWindow(sql`i.paid_at`, input)}
        GROUP BY 1, 2
      UNION ALL SELECT tenant_id, local_day, 'payments_received', count(*)::numeric
        FROM received GROUP BY tenant_id, local_day
      UNION ALL SELECT tenant_id, local_day, 'payments_received_minor', coalesce(sum(round(amount * 100)), 0)::numeric
        FROM received GROUP BY tenant_id, local_day
      UNION ALL SELECT a.tenant_id, ${localDay(sql`a.issued_at`, input)}, 'acts_issued', count(*)::numeric
        FROM billing_acts a
        WHERE ${tenantScope(sql`a.tenant_id`, input)} AND ${inWindow(sql`a.issued_at`, input)}
        GROUP BY 1, 2
      UNION ALL SELECT s.tenant_id, ${localDay(sql`coalesce(s.starts_at, s.created_at)`, input)}, 'paid_subscriptions_started', count(*)::numeric
        FROM tenant_subscriptions s
        WHERE ${tenantScope(sql`s.tenant_id`, input)}
          AND s.source::text IN ('paid_offer_line', 'paid_invoice_line')
          AND ${inWindow(sql`coalesce(s.starts_at, s.created_at)`, input)}
        GROUP BY 1, 2
      UNION ALL SELECT g.tenant_id, ${localDay(sql`g.signed_at`, input)}, 'agreements_signed', count(*)::numeric
        FROM platform_agreements g
        WHERE ${tenantScope(sql`g.tenant_id`, input)} AND ${inWindow(sql`g.signed_at`, input)}
        GROUP BY 1, 2
    )
    SELECT m.tenant_id, o.name AS tenant_name, m.local_day::text AS day,
      ${pivotMetrics(COMMERCIAL_METRICS, MONEY_METRICS)}
    FROM metrics m
    JOIN organization o ON o.id = m.tenant_id
    GROUP BY m.tenant_id, o.name, m.local_day
    ORDER BY m.tenant_id, m.local_day
    LIMIT ${REPORT_MAX_ROWS + 1}
  `,
  );
}
```

- [ ] **Step 4: Dispatch `commercial`**

In `apps/api/src/platform-reports/report-source.service.ts` add the import:

```ts
import {
  COMMERCIAL_COLUMNS,
  COMMERCIAL_DEFINITIONS,
  loadCommercialRows,
} from "./commercial-report-source";
```

Add the case to `definitionsFor`:

```ts
    case "commercial":
      return { ...EVIDENCE_COMMON_DEFINITIONS, ...COMMERCIAL_DEFINITIONS };
```

Insert this branch immediately before the line `} else if (input.reportType === "commerceml") {`, so it follows the `quality` branch body:

```ts
          } else if (input.reportType === "commercial") {
            columns = [...COMMERCIAL_COLUMNS];
            rows = await loadCommercialRows(tx, input);
```

- [ ] **Step 5: Run the tests, typecheck and lint**

Run:

```bash
pnpm --filter @markiro/api exec vitest run test/platform-report-evidence-definitions.test.ts test/platform-report-commercial-source.test.ts test/platform-report-source.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
```

Expected: PASS with a local database; without one the DB file skips and must be reported.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/platform-reports apps/api/test
git commit -m "feat(reports): commercial report source" \
  -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: SaaS admin — templates, hidden filters, privacy help

**Files:**
- Modify: `apps/saas-admin/src/pages/reports/ReportsPage.tsx`
- Modify: `apps/saas-admin/src/i18n/en.json`, `apps/saas-admin/src/i18n/ru.json`
- Test: `apps/saas-admin/test/reports-page.test.tsx`

**Interfaces:**
- Consumes: `isPlatformEvidenceReportType` (Task 2, built into `dist`).
- Produces: nothing consumed later.

- [ ] **Step 1: Write the failing tests**

Append these two tests inside `describe("platform reports", ...)` in `apps/saas-admin/test/reports-page.test.tsx`, after the test `omits filters cleared by a template change`:

```ts
  it("offers the usage template without source filters and explains tenant privacy", async () => {
    installReportsApi();
    const user = userEvent.setup();
    const view = renderSaasApp({ initialEntry: "/reports" });
    await user.click(await within(view.container).findByRole("checkbox", { name: /завод/i }));
    const form = view.container.querySelector("form")!;
    await selectOption(user, form, /шаблон/i, "Использование платформы");
    expect(within(form).queryByLabelText(/статус/i)).toBeNull();
    expect(within(form).queryByLabelText(/gtin-14/i)).toBeNull();
    expect(within(form).queryByRole("combobox", { name: /^линия$/i })).toBeNull();
    expect(within(form).getByText("Для этого шаблона дополнительных фильтров нет.")).toBeTruthy();
    expect(within(form).getByText(/tenant-01/)).toBeTruthy();
  });

  it.each([
    ["Использование платформы", "usage"],
    ["Качество и автономность", "quality"],
    ["Коммерческая активность", "commercial"],
  ])("creates a %s report with the pseudonymous default and no source filters", async (label, reportType) => {
    const calls = installReportsApi();
    const user = userEvent.setup();
    const view = renderSaasApp({ initialEntry: "/reports" });
    await user.click(await within(view.container).findByRole("checkbox", { name: /завод/i }));
    await selectOption(user, view.container, /шаблон/i, label);
    await user.click(within(view.container).getByRole("button", { name: /сформировать/i }));
    await waitFor(() => expect(calls.some((call) => call.body)).toBe(true));
    const body = calls.find((call) => call.body)?.body as Record<string, unknown>;
    expect(body).toMatchObject({ reportType, privacy: "pseudonymous", periodBasis: "events" });
    for (const key of ["lineId", "productId", "gtin14", "status", "operatorId", "outcome"])
      expect(body).not.toHaveProperty(key);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/saas-admin exec vitest run test/reports-page.test.tsx`
Expected: FAIL — the option "Использование платформы" does not exist.

- [ ] **Step 3: Add the i18n keys**

Run this script (it is a quoted heredoc, so the text is passed to Node unchanged); it adds keys to both languages and leaves other keys untouched:

```bash
node --input-type=module <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
const patch = {
  en: {
    types: {
      usage: "Platform usage",
      quality: "Quality and offline behaviour",
      commercial: "Commercial activity",
    },
    privacyHelpTenant: {
      identified: "Includes tenant names and IDs. Requires the identified-data capability.",
      pseudonymous:
        "Tenants are replaced with export-local labels (tenant-01, tenant-02…). Volumes can still identify a tenant.",
      aggregate:
        "Tenant columns are removed and days are summed across the selected tenants. A small selection can still permit inference.",
    },
    evidence:
      "Usage, quality and commercial exports have one row per tenant and local day; a day with no recorded facts has no row. Values are additive counts, and amounts are RUB kopecks. Figures can be restated by late device sync, so compare exports by snapshot time and definitions version.",
    metadata:
      "The ZIP includes data.csv and metadata.json with parameters, snapshot time, definitions version, the SHA-256 of data.csv and definitions. Dates are inclusive in the selected timezone; event timestamps remain UTC.",
  },
  ru: {
    types: {
      usage: "Использование платформы",
      quality: "Качество и автономность",
      commercial: "Коммерческая активность",
    },
    privacyHelpTenant: {
      identified:
        "Содержит названия и идентификаторы тенантов. Требует права на идентифицированные данные.",
      pseudonymous:
        "Тенанты заменяются метками выгрузки (tenant-01, tenant-02…). Объёмы всё равно могут выдать тенанта.",
      aggregate:
        "Колонки тенантов удалены, дни суммируются по выбранным тенантам. Малая выборка всё равно допускает вывод.",
    },
    evidence:
      "Выгрузки использования, качества и коммерции содержат одну строку на тенанта и локальный день; у дня без зафиксированных фактов строки нет. Значения — аддитивные счётчики, суммы — в копейках (RUB). Цифры могут уточняться из-за поздней синхронизации устройств, поэтому сравнивайте выгрузки по времени среза и версии определений.",
    metadata:
      "ZIP содержит data.csv и metadata.json с параметрами, временем снимка, версией определений, SHA-256 файла data.csv и определениями. Даты включительны в выбранном часовом поясе; события сохраняют UTC-время.",
  },
};
for (const language of ["en", "ru"]) {
  const path = `apps/saas-admin/src/i18n/${language}.json`;
  const json = JSON.parse(readFileSync(path, "utf8"));
  const reports = json.reports;
  Object.assign(reports.types, patch[language].types);
  reports.privacyHelpTenant = patch[language].privacyHelpTenant;
  reports.help.evidence = patch[language].evidence;
  reports.help.metadata = patch[language].metadata;
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
}
EOF
pnpm exec prettier --write apps/saas-admin/src/i18n/en.json apps/saas-admin/src/i18n/ru.json
git diff --stat apps/saas-admin/src/i18n
```

Expected: only `en.json` and `ru.json` changed, with additions and the corrected `help.metadata` file names. If the diff shows unrelated reflowing, the JSON was not prettier-stable: revert with `git checkout apps/saas-admin/src/i18n` and re-apply the same keys by hand.

- [ ] **Step 4: Edit `ReportsPage.tsx`**

Apply these edits.

1. Import the guard:

```tsx
import {
  isPlatformEvidenceReportType,
  platformReportInputSchema,
  type PlatformReport,
  type PlatformReportInput,
} from "@markiro/platform-contracts";
```

2. Do not request line options for the evidence types:

```tsx
    lines: useReportOption(
      "lines",
      canRead &&
        tenantIds.length > 0 &&
        reportType !== "commerceml" &&
        !isPlatformEvidenceReportType(reportType),
    ),
```

3. Add the templates to the selector:

```tsx
            options={(
              [
                "shifts",
                "shift_operators",
                "inventories",
                "summary",
                "commerceml",
                "usage",
                "quality",
                "commercial",
              ] as const
            ).map((value) => ({ value, label: t(`reports.types.${value}`) }))}
```

4. Replace the opening of the filters conditional. The existing text is `{reportType === "commerceml" ? (`; make it:

```tsx
          {isPlatformEvidenceReportType(reportType) ? (
            <p className="report-help">{t("reports.noFilters")}</p>
          ) : reportType === "commerceml" ? (
```

The existing `) : (` branch that follows the CommerceML `Select` stays as the final `else`.

5. Use the tenant privacy text for the new types:

```tsx
          <p className="report-help">
            {t(
              isPlatformEvidenceReportType(reportType)
                ? `reports.privacyHelpTenant.${privacy}`
                : `reports.privacyHelp.${privacy}`,
            )}
          </p>
```

6. Add the help paragraph after `<p>{t("reports.help.commerceml")}</p>`:

```tsx
        <p>{t("reports.help.evidence")}</p>
```

Then run `pnpm exec prettier --write apps/saas-admin/src/pages/reports/ReportsPage.tsx`.

- [ ] **Step 5: Run the tests, typecheck and lint**

Run:

```bash
pnpm --filter @markiro/saas-admin exec vitest run test/reports-page.test.tsx
pnpm --filter @markiro/saas-admin test
pnpm --filter @markiro/saas-admin typecheck
pnpm --filter @markiro/saas-admin lint
pnpm --filter @markiro/saas-admin build
```

Expected: PASS. These are DOM tests, not a browser walkthrough.

- [ ] **Step 6: Commit**

```bash
git add apps/saas-admin/src apps/saas-admin/test/reports-page.test.tsx
git commit -m "feat(saas-admin): usage, quality and commercial report templates" \
  -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Operations guide and final gates

**Files:**
- Modify: `docs/operations/platform-report-exports.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Update the operations guide**

Run this script; it fixes the artifact file names and appends a section for the new types:

```bash
node --input-type=module <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
const path = "docs/operations/platform-report-exports.md";
let text = readFileSync(path, "utf8");
const from = "Each ZIP contains CSV data and a definitions JSON file with the exact parameters, snapshot time and metric definitions.";
if (!text.includes(from)) throw new Error("missing artifact sentence");
text = text.replace(
  from,
  "Each ZIP contains `data.csv` and `metadata.json` with the exact parameters, snapshot time, `definitionsVersion`, the SHA-256 of `data.csv` (`dataSha256`) and metric definitions.",
);
text = text.trimEnd() + `

## Usage, quality and commercial reports

The \`usage\`, \`quality\` and \`commercial\` templates give one row per tenant and local calendar day for platform-usage analytics and supporting evidence. They take the same explicit tenant selection (1–10), inclusive dates (at most 366 days) and IANA timezone as the other templates, and reject every optional filter and the production-date basis.

A row exists only for a tenant-day with at least one recorded fact. A missing row means no recorded fact, not a measured zero. Every numeric column is an additive count or sum, so days can be rolled up to weeks or months; lag is reported as bucket counts, and amounts are RUB kopecks. Server clocks are used wherever they exist and each definition in \`metadata.json\` names its clock. Late device synchronisation can restate past days, so compare exports by \`snapshotAt\` and \`definitionsVersion\`, which is bumped whenever a formula changes.

Privacy modes apply to tenants instead of operators. \`identified\` shows tenant ids and names and needs the identified capability. \`pseudonymous\` replaces both with \`tenant-01\`, \`tenant-02\`, … in ascending tenant-id order and records only \`tenantCount\` in the artifact parameters. \`aggregate\` removes the tenant columns and sums days across the selected tenants. Neither is legal anonymization: a distinctive volume or a small selection can still identify a tenant. Do not name a customer in published material without its consent.

Artifacts keep the seven-day retention. Place downloaded files in an evidence package with \`tools/evidence-package\` (seal, verify) for long-term retention. Facts the platform does not retain, such as the CommerceML item journal older than 14 days, cannot be regenerated: export the \`commerceml\` report regularly and keep it in the evidence package.
`;
writeFileSync(path, text);
EOF
pnpm exec prettier --write docs/operations/platform-report-exports.md
git diff --stat docs/operations/platform-report-exports.md
```

Expected: one changed file with the corrected sentence and an appended section.

- [ ] **Step 2: Run the affected package gates**

Run:

```bash
pnpm --filter @markiro/platform-contracts test
pnpm --filter @markiro/platform-contracts typecheck
pnpm --filter @markiro/platform-contracts lint
pnpm --filter @markiro/platform-contracts build
pnpm --filter @markiro/api exec vitest run test/platform-report-evidence-privacy.test.ts test/platform-report-evidence-definitions.test.ts test/platform-report-usage-source.test.ts test/platform-report-quality-source.test.ts test/platform-report-commercial-source.test.ts test/platform-report-source.test.ts test/platform-report-renderer.test.ts test/platform-report-lifecycle.test.ts test/platform-report-module.test.ts test/platform-contract-openapi.test.ts
pnpm --filter @markiro/api typecheck
pnpm --filter @markiro/api lint
pnpm --filter @markiro/api build
pnpm --filter @markiro/saas-admin test
pnpm --filter @markiro/saas-admin typecheck
pnpm --filter @markiro/saas-admin lint
pnpm --filter @markiro/saas-admin build
```

Expected: all PASS. Count the skipped tests in the API output; every `describe.skipIf(!local)` block skips without a local database.

- [ ] **Step 3: Run the format and diff checks**

Run:

```bash
pnpm format:check
git diff --check
```

Expected: both clean.

- [ ] **Step 4: Run the isolated reports browser regression**

Run: `pnpm --dir tools/production-browser --ignore-workspace test:reports`
Expected: PASS. It uses synthetic API responses; it is the download-navigation check, not proof of the new templates in a real browser.

- [ ] **Step 5: Review the final diff against the spec and commit**

Run `git diff origin/main...HEAD --stat` and read it against the spec sections 2–8. Then:

```bash
git add docs/operations/platform-report-exports.md
git commit -m "docs(operations): usage, quality and commercial report exports" \
  -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Write the final report**

List, separately: behavior changed; files and areas changed; automated checks with results; DB-backed checks run or skipped and why; manual and external checks not performed (a browser walkthrough of the reports page with the three templates, a run against a production-sized multi-tenant dataset for the 60-second budget, and a review of each definition by the owner). Do not claim any of those was verified by the DOM tests or the fixture database.

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| §2 scope, grain, filter rejection | Task 2 (contract), Tasks 4–6 (grain in SQL) |
| §2.1 `usage` columns and clocks | Task 4 |
| §2.2 `quality` columns, buckets, inventory columns | Task 5 |
| §2.3 `commercial` columns, kopecks, both payment flows | Task 6 |
| §3 framework changes 1–7 | Tasks 2–8 (contract, sources, inventory join in code, definitions per type, privacy, renderer, UI, docs) |
| §4 privacy, `tenantCount`, warning in definitions | Task 3 (`EVIDENCE_COMMON_DEFINITIONS.privacy`, `artifactParameters`) |
| §5 `definitionsVersion`, `dataSha256`, seven-day retention | Task 3, Task 8 |
| §6 non-goals | not implemented, stated in Task 8 docs |
| §7 implementation checks | Task 1 rewrites them; check 1 in Task 4 Step 8; checks 2–4 are enforced by the code shapes and tests in Tasks 4–6 |
| §8 tests | Tasks 2–7 |

No spec requirement is without a task. The spec's §3 item 3 (inventory completion time) is deliberately changed by Task 1 to a code-side join, because it leaves `inventory-report-source.ts` untouched.

**Placeholder scan.** No task refers to "similar to Task N" or defers code. Task 1 and Task 7 use scripted edits with assertions instead of prose edits.

**Type consistency.**
- `USAGE_COLUMNS`, `QUALITY_COLUMNS`, `COMMERCIAL_COLUMNS` are `as const` tuples; the service spreads them into `string[]`, and the definition tests take `readonly string[]`.
- `pivotMetrics(metrics, floatMetrics?)` is called with `USAGE_METRICS`, `SQL_METRICS`, and `COMMERCIAL_METRICS` plus `MONEY_METRICS`, all defined in the calling files.
- `mergeInventoryCompletions(factRows, completions, projections)` has the same signature in Task 5's tests and implementation.
- `definitionsFor` gains one `case` per task and keeps its `default`.
- `EVIDENCE_COMMON_DEFINITIONS` and `REPORT_DEFINITIONS_VERSION` are defined in Task 3 and consumed in Tasks 4–6 and the renderer.
- `seedEvidenceBase` and `cleanupEvidence` are defined in Task 4 and reused in Tasks 5 and 6 with the same `EvidenceBase` field names.

**Known limits to state, not hide**
- Fixture columns were read from `packages/db/src/schema` when this plan was written. If a NOT NULL column or check constraint has changed since, a fixture insert will fail with a precise Postgres error; fix the fixture, not the assertion.
- The 366-day, 10-tenant time budget cannot be proven on fixtures. Task 4 Step 8 checks plan shape only.
