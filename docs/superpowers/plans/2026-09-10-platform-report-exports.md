# Platform Report Exports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Generate and download five safe operational reports from SaaS admin.

**Architecture:** Separate platform report records and capability boundary; existing pg-boss and private object storage. Read-only consistent source projections feed CSV/ZIP rendering before publication.

**Tech Stack:** TypeScript, NestJS, Drizzle/Postgres, pg-boss, Zod, React, existing fflate.

**Spec:** docs/superpowers/specs/2026-09-10-platform-report-exports.md

## Global Constraints

- Five templates: shifts, shift_operators, inventories, summary, commerceml.
- Explicit tenant scope; no badges, PINs, raw codes or integration credentials.
- Isolated worktree; no production mutations, deployment, push, or unrelated file changes.
- Node 24+, repository-declared pnpm through Corepack; no new dependencies.
- Strict contracts, private artifacts, 7-day retention, maximum 300-second download links.
- Tests first; preserve existing lifecycle semantics and distinguish unavailable facts from zero.

### Task 1: Contracts and durable report records

Files: packages/platform-contracts/src/platform-reports.ts and index.ts, platform-auth.ts; packages/db/src/schema/platform-reports.ts, schema/index.ts, drizzle.config.ts, a new migration and metadata; focused contract/schema tests.

Produces: PlatformReportInput, PlatformReport, platformReportContracts; schema.platformReports and schema.platformReportTenants. Input keys are reportType, tenantIds, fromDate, toDate, timezone, periodBasis, privacy, lineId?, productId?, gtin14?, operatorId?, status?, outcome?. Request adds idempotencyKey UUID. Report DTO includes id, parameters, status, createdAt, snapshotAt nullable, completedAt nullable, expiresAt, errorCode nullable, rowCount nullable, byteSize nullable, filename nullable; never objectKey. List returns items and nextOffset; download returns url/filename/expiresInSeconds. API paths /platform/reports, /:id/download. Filter options endpoint can be defined by Task 3/4 after source needs are known.

- [x] Write tests rejecting empty tenants, duplicate tenants, invalid dates/zones, >366 days, reversed dates, irrelevant filters, aggregate+operatorId, and unknown request keys.

```ts
expect(platformReportContracts.create.body.safeParse({ ...valid, tenantIds: [] }).success).toBe(
  false,
);
expect(
  platformReportContracts.create.body.safeParse({
    ...valid,
    privacy: "aggregate",
    operatorId: uuid,
  }).success,
).toBe(false);
```

- [x] Run the focused tests and record RED evidence.
- [x] Implement strict contracts and capabilities (admin only). Add durable records: creator platform FK, parameters JSON, idempotency unique per creator, statuses queued/processing/ready/failed/expired, attempts and lease expiry, private artifact key/checksum/bytes/name, snapshot/completion/expiry timestamps and safe error code. Tenant link table has report FK + tenant FK, composite primary key. No tenant-user FK.
- [x] Generate/review only the new migration; no changes to old migrations. Run contracts/db focused tests, build, typecheck, lint and report exact results. Leave changes uncommitted for the controller's final handoff.

### Task 2: Consistent report sources and safe artifacts

Files: apps/api/src/platform-reports/report-source.service.ts (snapshot orchestration), shift-report-source.ts (shifts/operators), inventory-report-source.ts, commerceml-report-source.ts, report-query.ts (shared parameterized scope/window helpers), report-renderer.ts, report-definitions.ts, focused source/render tests and test fixture support. Summary combines shift and inventory operational projections without re-querying outside the snapshot; CommerceML remains its own report because it has no line/product scope.

Consumes PlatformReportInput and Db; produces `PlatformReportSourceService.load(input): Promise<{snapshotAt: Date; columns: string[]; rows: Record<string, string | number | null>[]; definitions: Record<string,string>}>` and `renderPlatformReport(input, source): {body: Buffer; filename: string; rowCount: number}` (ZIP). Renderer imports input type from contracts. Source never returns badge/PIN/raw-code credentials. Declare and export bounded report error class with safe error codes if needed.

- [x] Write hand-calculated fixtures for all five reports, tenant contamination, mixed operator/null, overlapping scans/boxes without multiplication, source interval boundaries, unavailable values, all privacy modes and malicious CSV formula/name/message fields. Run RED.

```ts
expect(rows[0]?.accepted_scans).toBe(2);
expect(rows[0]?.boxes).toBe(1);
expect(artifactText).not.toContain("operator-real-id");
expect(artifactText).not.toContain("badge-secret");
```

- [x] Implement projections with explicit columns and tenant-scoped SQL predicates. Use one repeatable-read read-only transaction, a 60-second statement timeout, deterministic ordering and fail on limits. Acquire a shared-across-processes transaction advisory lock before source reads; if busy, throw an exported PlatformReportSourceBusyError so Task 3 defers without consuming a retry. Aggregate scans/boxes separately. Bound rows at 100000 and uncompressed artifact at 32 MiB; fail rather than truncate.
- [x] Implement privacy before serialization, safe CSV formula handling, BOM UTF-8/CRLF, preserve GTIN/SSCC values as text without truncation, ZIP using existing fflate with data.csv and metadata.json containing snapshot, definitions and privacy-safe parameters. Do not retain operatorId parameters in pseudonymous artifacts. Aggregate mode must not contain per-person rows or timestamps.
- [x] Run focused tests, API typecheck/lint and source DB tests when local DB available; record skipped infrastructure honestly. Leave uncommitted.

### Task 3: Platform API, workers, recovery and downloads

Files: apps/api/src/platform-reports/{platform-reports.service,platform-reports.controller,platform-reports.module,platform-report-runner.service}.ts; jobs/jobs.module.ts; app.module.ts; modules/storage/object-storage.service.ts safe-key validation; platform HTTP/OpenAPI integration and tests.

Consumes Task 1 schemas/contracts and Task 2 source/renderer. Produces POST/GET /platform/reports, POST /platform/reports/:id/download and GET /platform/reports/options (tenant-scoped options). UI repeats a job by POSTing saved parameters with a fresh idempotencyKey. Paginated history is creator-scoped.

- [x] Write failure-first tests for separate platform trust domain, exact audit output, forged tenant filter IDs, unauthorized identified access, idempotency replay/mismatch, expired download and creator denial.
- [x] Implement creation transaction (validate active creator and selected organizations, insert report/links/audit), queue wake after commit, no false creation failure after committed intent. List never exposes object key or operatorId in lower-privilege modes. Options return selected tenants' lines/products/operators, only necessary id/name/tenantId fields.
- [x] Write worker failure-first tests for reclaim/fencing, enqueue failure repaired by schedule, stale upload not published, exact checksum, expiry cleanup and bounded retries.

```ts
await runner.run(id);
expect(report.status).toBe("ready");
expect(report.sha256).toMatch(/^[a-f0-9]{64}$/);
await expect(service.download(otherPrincipal, id)).rejects.toThrow();
```

- [x] Implement pg-boss worker plus periodic repair and cleanup. Use attempt-specific object keys, durable lease/fencing, max 3 attempts; recover queued and expired leases without requiring an API restart. Protect data reads with a global concurrent source limit (database advisory lock or equivalent) and a 60-second statement timeout. Ensure stale attempts cannot publish or delete another attempt's object.
- [x] Extend storage key validation only for canonical `platform-reports/<report UUID>/attempt-<1..3>/report.zip` paths, with rejection tests; share deterministic key generation between runner and cleanup.
- [x] Revalidate creator status/permissions before generation and download; object download URL expires at min(300 seconds, remaining retention). Audit exact actor/action/target/tenant selection/outcome. Persist safe failure codes, not raw stack/SQL/errors. Clean expired files with retry-safe confirmed deletion and no secret logs.
- [x] Run API focused integration tests using local-only Postgres and storage boundary test doubles, relevant job/auth/OpenAPI tests, typecheck/lint/build. Leave uncommitted.

### Task 4: SaaS admin report workflow and documentation

Files: apps/saas-admin/src/pages/reports/{ReportsPage,api}.tsx/.ts, app.tsx, layout/AppShell.tsx, i18n/{ru,en}.json, scoped styles/tests; docs/architecture.md and operational docs.

Consumes platformReportContracts and /platform/reports/options contract from Task 3. Reuse platformApiFetch, platform principal and shared UI controls; no tenant impersonation.

- [x] Write UI tests for generating selected report with explicit tenant/date/privacy, incompatible filters cleared on type change, durable status polling after navigation, failed/expired states, retry with fresh key, permission-hidden identified mode and successful download action. Run RED.
- [x] Add capability-gated navigation and page. Offer five templates, multi-tenant selection, inclusive dates/timezone/basis, compatible source filters, privacy descriptions. Default pseudonymous; warn it is not complete anonymity. Persist history on server; poll only pending visible records. Show generation failures, expiry, empty results, and named actions. Do not mark expired objects downloadable.
- [x] Add clear metric semantics/help and report metadata download explanations; document operational queue/retention/schema setup and unavailable CommerceML archive limitations.
- [x] Run saas-admin tests/typecheck/lint/build, API contract consumer gates, final diff/format checks and a local browser walkthrough when available. No deployment or production data access. Leave uncommitted.
