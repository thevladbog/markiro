# Tenant Admin Production Dashboard — Design Specification

**Date:** 2026-08-27

**Status:** Proposed for implementation planning

**Scope:** Replace the tenant Admin overview with a production-control dashboard backed by one
tenant-scoped server summary. This slice covers trustworthy current output, separate validation
and aggregation trends, attention reasons, and active-shift drill-down. It does not implement the
full analytics ledger, employee scorecards, impact evidence, or cross-tenant benchmarking.

## Outcome

The tenant administrator can answer, from the first screen, whether production is under control,
what output has been recorded today, whether the recent rate is improving or declining, and which
active shift needs attention.

The dashboard never adds validation units to aggregation boxes. Products in `validation` mode are
reported as accepted individual units. Products in `aggregation` mode are reported as closed boxes
plus the accepted units currently contained in those boxes. Every comparison uses the same mode,
unit, bucket grain, timezone, and duration rule.

## Confirmed product decisions

- The primary question is: “Is production under control today?”
- “Today” includes every active shift regardless of open date, plus shifts closed during the
  tenant's current local calendar day.
- The verdict is transparent: `under_control`, `needs_attention`, or `critical`, with concrete
  reasons. There is no opaque score.
- Plan lag is `needs_attention`; `critical` is reserved for a production stop, data-integrity risk,
  or mandatory blocker.
- Validation output uses units. Aggregation output uses closed boxes and separately reports their
  contained units. These values are never combined into one total.
- The default dynamics view is rate. Output is the second view. A quality view is deferred until
  the full first-pass-yield and exception formulas have authoritative inputs.
- The current system does not capture eligible active time or a normative shift duration. V1
  therefore labels rate as “per shift hour,” never “per active hour,” and does not draw an
  expected-plan curve.
- Data shown while a shift is active is provisional. Late data is visible and never silently
  presented as a final historical result.

## Architecture

### One coherent read model

Add a cabinet-only `DashboardModule` with:

```text
GET /dashboard/overview?period=today|7d|30d|12w
```

The endpoint requires `OPERATIONS_READ`, derives the tenant from `TenantGuard`, permits
subscription read-only access, and never accepts a tenant id from the client. It returns one
`generatedAt` and one metric version for the complete response. Its related queries run in one
read-only repeatable-read transaction so the verdict, totals, comparison, and rows cannot describe
different committed states.

The Admin page replaces its independent products/shifts/lines/conflicts requests with this
endpoint. Setup counts are part of the same response, so the new-tenant path remains useful without
keeping a second client-side aggregation path.

### Tenant operational timezone

Add `org_profiles.time_zone` as a non-null IANA timezone with default `Europe/Moscow`. The field is
returned and editable through the existing organization-profile API and settings screen. Existing
tenants receive the default explicitly in the migration; the dashboard response always returns the
timezone used.

The API validates timezone identifiers before persistence. Bucket boundaries are computed on the
server from this stored setting. Browser timezone and server process timezone never change a
dashboard result.

### Authoritative source facts

- Accepted units: current tenant-owned rows in `code_registry`, joined to their tenant-scoped
  shift. This is the authoritative current unique-code projection.
- Closed boxes: `boxes.closed_at is not null` and `boxes.disassembled_at is null`, joined to an
  aggregation shift in the same tenant.
- Units in closed boxes: `box_items` for eligible closed boxes where `displaced_at` and
  `removed_at` are both null.
- Unreviewed conflicts: tenant-scoped `code_conflicts.reviewed_at is null`.
- Late-data signal: shifts whose `late_data_at` intersects the selected/current result.
- Shift elapsed time: overlap between `[opened_at, closed_at ?? generatedAt]` and each bucket.

All database predicates carry the tenant condition directly. Composite joins include tenant id,
not only object id.

## Response contract

The response is shaped around UI questions rather than returning database rows:

```ts
interface DashboardOverviewDto {
  generatedAt: string;
  timeZone: string;
  metricVersion: "operations-dashboard-v1";
  setup: {
    productCount: number;
    shiftCount: number;
    hasRunShift: boolean;
  };
  verdict: {
    status: "under_control" | "needs_attention" | "critical";
    reasons: DashboardReasonDto[];
  };
  today: {
    validationAcceptedUnits: number;
    aggregationClosedBoxes: number;
    aggregationContainedUnits: number;
    activeShiftCount: number;
    includedClosedShiftCount: number;
  };
  dynamics: {
    period: "today" | "7d" | "30d" | "12w";
    grain: "hour" | "day" | "week";
    currentWindow: DashboardWindowDto;
    comparisonWindow: DashboardWindowDto;
    buckets: DashboardBucketDto[];
    quality: DashboardDataQualityDto;
  };
  activeShifts: DashboardActiveShiftDto[];
}
```

Each bucket contains separate validation and aggregation series:

```ts
interface DashboardBucketDto {
  start: string;
  end: string;
  label: string;
  validation: {
    acceptedUnits: number;
    shiftHours: number;
    unitsPerShiftHour: number | null;
  };
  aggregation: {
    closedBoxes: number;
    containedUnits: number;
    shiftHours: number;
    boxesPerShiftHour: number | null;
    containedUnitsPerShiftHour: number | null;
  };
}
```

A rate is `null`, not zero, when its eligible duration is zero. Durations and rates are calculated
from unrounded values; the API returns rates rounded to one decimal place for a stable contract.

### Period and comparison rules

| Period  | Current window                                | Grain | Comparison                                    |
| ------- | --------------------------------------------- | ----- | --------------------------------------------- |
| `today` | tenant-local day start to `generatedAt`       | hour  | same elapsed local-day interval yesterday     |
| `7d`    | current local day plus prior 6 calendar days  | day   | same local-day shape shifted back 7 days      |
| `30d`   | current local day plus prior 29 calendar days | day   | same local-day shape shifted back 30 days     |
| `12w`   | current local week plus prior 11 local weeks  | week  | same weekday/time shape shifted back 12 weeks |

Weeks start on Monday. Comparison windows mirror the current window's elapsed local-clock shape;
they do not compare a partial current day or week with a complete prior one. Bucket timestamps are
serialized as UTC instants; `label` is formatted from the civil hour/day/week in the returned
timezone. DST boundaries use actual elapsed seconds rather than assuming every local day is 24
hours.

### Today inclusion rule

The headline totals select shifts, then count their current authoritative output:

1. every shift with `status = active`; and
2. every shift with `status = closed` whose `closed_at` falls within the tenant-local current day.

An active shift opened on an earlier day contributes its complete current shift output to the
headline. The trend chart remains bucketed by fact occurrence time, so the two surfaces answer
different questions and are labelled accordingly.

### Verdict rules in V1

The API returns ordered reasons with a stable code, severity, count, and optional route:

- `critical`: one or more unreviewed code conflicts affecting an active or today-closed shift;
- `needs_attention`: late data affected an included shift;
- `needs_attention`: a selected mode has recorded output but no eligible duration for a rate;
- `under_control`: no critical or attention reason exists.

Draft products and future planned shifts remain useful context but do not lower today's production
verdict unless they block an included shift. Offline-station and plan-pace verdicts are deferred
until the summary has an authoritative stop signal and normative schedule respectively.

## Data quality and provenance

`DashboardDataQualityDto` contains:

- `status`: `complete`, `provisional`, or `insufficient`;
- `reasons`: stable machine codes translated by Admin;
- `activeShiftCount` and `lateDataShiftCount`;
- source labels `code_registry`, `boxes`, and `box_items`;
- `generatedAt` and `metricVersion` inherited from the response.

Any active shift makes the current window provisional. A mode with no production in the selected
window is an ordinary empty series, not an attention condition. A mode with recorded output but no
eligible duration makes only that rate insufficient without hiding raw output. Late data produces a
visible marker. V1 is a live rebuildable projection, not an immutable signed metric snapshot;
conflict resolution, disassembly, or other authoritative corrections can therefore revise earlier
buckets and the comparison.

## Admin experience

The approved A2 layout is implemented with the existing “Прибор” tokens, IBM Plex Sans/Mono,
compact office spacing, semantic status colors, visible focus, and reduced-motion-safe utility
transitions.

Order of information:

1. page heading, local date/timezone, and freshness;
2. verdict with explicit reasons;
3. today's separate validation, aggregation, contained-unit, and active-shift facts;
4. dynamics panel with `Rate`/`Output` and `Today`/`7 days`/`30 days`/`12 weeks` controls;
5. control signals;
6. active shifts with contextual output units and direct shift navigation.

The chart uses accessible HTML bars, not canvas. Every bar has a textual value, the chart has a
table-equivalent accessible description, keyboard controls are native buttons, and color is never
the only status cue. On narrow screens, validation and aggregation charts stack and the table keeps
horizontal scrolling.

If the endpoint fails, the page shows one retry action and does not retain a stale verdict without
an explicit stale-data label. If a single mode has no eligible facts, its panel explains why while
the other mode remains visible.

## Testing

### Database and API

- migration/schema tests for `org_profiles.time_zone`, including existing-row default;
- timezone validation tests, including non-Moscow and DST boundaries;
- formula fixtures for validation units, closed/non-disassembled boxes, active box items, shift-hour
  overlap, zero-duration nulls, and equal-period comparison;
- active-old-shift plus today-closed-shift headline inclusion;
- mode isolation proving units and boxes are never summed or cross-counted;
- late-data/provisional/insufficient states;
- exact verdict ordering and conflict scoping;
- cross-tenant denial and same-id/adversarial join fixtures;
- OpenAPI response and query-enum contract tests.

### Admin

- loading, failure, retry, setup, and no-data states;
- separate validation and aggregation values/units;
- period and metric controls issue the correct request and preserve accessible selection state;
- rate/output charts render null-rate and one-mode-empty states;
- verdict reasons link to the correct tenant-admin route;
- active shift rows render contextual output;
- Russian and English copy plus responsive DOM coverage.

Final gates are focused API/Admin tests, package tests, typecheck, lint, build, formatting, and
`git diff --check`. Automated DOM tests do not constitute visual browser verification; the finished
page receives a separate browser screenshot pass at desktop and narrow widths.

## Non-goals

- employee performance or ranking;
- first-pass yield, exception-rate, or quality scoring;
- expected plan curve or plan-lag verdict;
- immutable metric snapshots, evidence dossiers, or the general analytics ledger;
- cross-tenant benchmarks;
- historical reconstruction of facts removed before this projection existed.

## Completion criteria

1. The dashboard's headline and chart never combine validation units with aggregation boxes.
2. Every response and database query is tenant-scoped and timezone-stable.
3. Today, 7-day, 30-day, and 12-week periods compare equal windows with documented grains.
4. Rates use shift elapsed time and are labelled accordingly.
5. Active and late data are visibly provisional; insufficient rates remain null.
6. The page matches the approved A2 information hierarchy using production tokens and real data.
7. API/Admin automated gates pass, and browser screenshots show no clipped or collapsed layout.
