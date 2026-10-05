# US-09 Request Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A fresh reviewer checks each task before the next starts.

**Goal:** Add tested US-only request/deadline contracts and tenant-safe persistence for future immutable trace response runs, without exposing package generation or changing RU behavior.

**Architecture:** Pure domain rules calculate the elapsed-time deadline. Strict platform contracts validate requester/scope/command input while excluding client-owned identity. Three additive tables reserve the request, immutable run and artifact relationships; no HTTP route, queue, storage adapter or workbook call is enabled by this plan. US-09 selection/freeze, package publication and cabinet integration each get a later separately reviewed plan.

**Tech Stack:** TypeScript 6, Zod 4, Drizzle/PostgreSQL, Vitest, Corepack pnpm; owned disposable US PostgreSQL for migration tests.

**Spec:** [Owner-approved current US-09 design](../specs/2026-10-04-us-09-trace-request-current-design.md). Also read [MVP contract](../../us/mvp-contract.md), [CLAR-03](../../us/development-clarifications.md), [current US-07 core](../specs/2026-10-02-us-07-export-core-design.md), and [US-08 Plan](../specs/2026-10-02-us-08-traceability-plan-current-design.md).

## Global Constraints

- Owner final-review precision ruling: domain parsing and strict create/update request contracts reject nonzero fractional precision beyond milliseconds for both receipt and due instants; exactly representable trailing-zero forms such as `.123000Z` are accepted. Add focused regression tests for truncation, default + 1 microsecond and preserved trailing-zero input. True microsecond support is separately scoped; no database schema/migration change belongs to this fix.

- Work only in the isolated `codex/us-mvp` checkout. The US runtime remains release-disabled; no RU route, shared RU job, shared RU bucket, deployment, provisioning or real-data operation is in scope.
- P0 processor profile only. UI eventually EN/ES; P0 workbook/PDF English. Station, FDA submission, QA sign-off, CSV ZIP and canonical JSON are deferred.
- The default due instant is `received_at + 24` elapsed hours; a different due instant needs a reason. Do not equate a server interval to active human time.
- A draft request may have no scope; validation/preparation later require at least one selector. Scope matching zero records is distinct from malformed input or an infrastructure failure.
- Every business row carries tenant identity. Run→request, run→Plan and artifact→run references use composite tenant keys; no cascade deletion of runs or artifacts.
- Do not edit applied migrations or the lockfile by hand. Read `packages/db/drizzle.config.ts` before generation; choose the next free migration at execution time. Never migrate or drop the shared/base development database.
- A run records both `scoped_content_digest` and optional full US-07 `input_digest`; an explicit empty selection has no `ExportInputV1`/`input_digest`. The run owns the command digest separately for idempotency.
- No code path in this plan creates or publishes a run, artifact or package. The new schema must reject malformed cross-tenant/test writes and keep future publication fail-closed.
- Use focused failing tests first; run dependency builds before consumer tests. Preserve existing work. Stage exact paths; commit/push only under separate owner authorization.

## Review Focus

These are the five likely user-facing input/failure classes; the named tests below must pin them:

1. A daylight-saving transition still gives exactly 86,400 seconds, not the same wall-clock hour tomorrow (Task 1).
2. A saved step-1 shell accepts null scope, but an empty selector object or only empty arrays cannot pass scope validation (Task 2).
3. Duplicate TLCs, reversed UTF-8 TLC/date ranges, control characters and unknown keys fail rather than silently changing the requested scope (Task 2).
4. A run cannot attach another tenant's request or Plan, and an artifact cannot attach another tenant's run (Task 3).
5. An empty-selection run has null full-input digest; a nonempty run requires it, and failed/ready lifecycle timestamps cannot be contradictory (Task 3).

---

## File map and sequence

| Unit                 | Files                                                                                                                                                                                                                                                                                           | Responsibility                                                                                                                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deadline policy      | `packages/domain/src/traceability/requests/deadline.ts`, `packages/domain/test/us-request-deadline.test.ts`, `packages/domain/src/index.ts`                                                                                                                                                     | UTC-instant arithmetic and alternate-deadline rule only; no HTTP or database.                                                                                                                                            |
| Strict request input | `packages/platform-contracts/src/traceability/requests.ts`, `packages/platform-contracts/test/us-requests.test.ts`, `packages/platform-contracts/src/index.ts`, `packages/platform-contracts/src/traceability/search-lot-card.ts`                                                               | Reuse search's UTF-8 TLC ordering, define scope/create/update/close/prepare schemas; reject client tenant/actor/provenance.                                                                                              |
| Additive storage     | `packages/db/src/schema/traceability-requests.ts`, `packages/db/src/schema.ts`, `packages/db/drizzle.config.ts`, `packages/db/migrations/0139_us_trace_requests.sql` plus generated metadata, `packages/db/test/us-request-schema.test.ts`, `packages/db/test/us-request-migration.e2e.test.ts` | Three tenant-keyed tables and constraints; fresh and upgrade migration proof. Migration 0139 is free in the inspected journal; recheck immediately before generation and revise this plan if another migration takes it. |

This is the first of four dependent US-09 plans. The next plans cover (2) complete selection and atomic freeze, (3) package/worker/private storage, and (4) US HTTP/cabinet/browser journey. Do not implement those from this plan.

### Task 1: Deadline policy

**Files:**

- Create: `packages/domain/src/traceability/requests/deadline.ts`
- Create: `packages/domain/test/us-request-deadline.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**

- Consumes: ISO offset instants already validated by the command contract.
- Produces: `resolveUsRequestDeadline(receivedAt: string, dueAt?: string, reason?: string | null): { dueAt: string; alternateDeadlineReason: string | null }`. Every returned instant is canonical UTC. Invalid input throws `RangeError`, never silently coerces.

- [ ] **Step 1: Write focused failing tests.** Add the following cases; use the same direct-import test style as `packages/domain/test/us-export-registry.test.ts`.

```ts
import { describe, expect, it } from "vitest";
import { resolveUsRequestDeadline } from "../src/traceability/requests/deadline.js";

describe("US request deadline", () => {
  it("adds exactly 24 elapsed hours across a spring DST change", () => {
    const received = "2026-03-08T01:30:00-08:00";
    const result = resolveUsRequestDeadline(received);
    expect(result).toEqual({
      dueAt: "2026-03-09T09:30:00.000Z",
      alternateDeadlineReason: null,
    });
    expect(Date.parse(result.dueAt) - Date.parse(received)).toBe(86_400_000);
  });
  it("requires a reason only for a genuinely different UTC due instant", () => {
    const received = "2026-09-17T09:00:00-07:00";
    expect(resolveUsRequestDeadline(received, "2026-09-18T16:00:00Z")).toMatchObject({
      alternateDeadlineReason: null,
    });
    expect(() => resolveUsRequestDeadline(received, "2026-09-19T16:00:00Z")).toThrow(RangeError);
    expect(
      resolveUsRequestDeadline(received, "2026-09-19T16:00:00Z", "Agreed extension"),
    ).toMatchObject({ alternateDeadlineReason: "Agreed extension" });
    expect(() => resolveUsRequestDeadline(received, "2026-09-17T16:00:00Z")).toThrow(RangeError);
  });
  it("rejects invalid or overflowing instants and blank alternate reasons", () => {
    expect(() => resolveUsRequestDeadline("not-a-date")).toThrow(RangeError);
    expect(() => resolveUsRequestDeadline("9999-12-31T23:59:59Z")).toThrow(RangeError);
    expect(() =>
      resolveUsRequestDeadline("2026-01-01T00:00:00Z", "2026-01-03T00:00:00Z", "  "),
    ).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Verify RED.** Run `corepack pnpm --filter @markiro/domain exec vitest run test/us-request-deadline.test.ts`; expect the missing module/export, not an unrelated dependency error.
- [ ] **Step 3: Implement the policy and index export.** Validate finite ISO offset instants, canonicalize to UTC, reject non-positive due intervals and out-of-range dates; use fixed milliseconds, not calendar `setDate`. An explicit default-equivalent due instant does not need a reason. Add this interface and branch structure:

```ts
export function resolveUsRequestDeadline(
  receivedAt: string,
  dueAt?: string,
  reason?: string | null,
): { dueAt: string; alternateDeadlineReason: string | null } {
  const received = parseOffsetInstant(receivedAt);
  const normal = received.getTime() + 86_400_000;
  if (!Number.isFinite(normal) || normal > Date.parse("9999-12-31T23:59:59.999Z"))
    throw new RangeError("us_request_deadline_out_of_range");
  const due = dueAt === undefined ? new Date(normal) : parseOffsetInstant(dueAt);
  if (due.getTime() <= received.getTime()) throw new RangeError("us_request_deadline_order");
  const alternate = due.getTime() !== normal;
  const trimmed = reason?.trim() ?? "";
  if (alternate && (trimmed.length < 3 || trimmed.length > 2000))
    throw new RangeError("us_request_alternate_reason_required");
  return { dueAt: due.toISOString(), alternateDeadlineReason: alternate ? trimmed : null };
}
```

Define `parseOffsetInstant` in the same file. Use a regex to extract ISO civil date, hour, minute, second, optional fraction and explicit `Z`/`±HH:MM` offset; reject missing components and out-of-range hour/minute/second or offset. Call existing `isTraceabilityCivilDate` on the date. Parse with `Date`, add the signed offset back to the resulting epoch, and compare the reconstructed local `YYYY-MM-DDTHH:mm:ss` with the input to reject normalized invalid instants. Reject years outside 0001–9999 and non-finite epochs. Export only `resolveUsRequestDeadline` via `packages/domain/src/index.ts`. Do not parse a tenant-local wall time without an offset.

- [ ] **Step 4: Verify GREEN and package gates.** Run the focused test, then domain `test`, `typecheck`, `lint` and `build` with Corepack. Inspect the final diff; reviewer checks the exact DST and overflow cases before Task 2.

### Task 2: Strict request contracts

**Files:**

- Create: `packages/platform-contracts/src/traceability/requests.ts`
- Create: `packages/platform-contracts/test/us-requests.test.ts`
- Modify: `packages/platform-contracts/src/traceability/search-lot-card.ts` (export existing `cTextOrder`; do not change its comparison)
- Modify: `packages/platform-contracts/src/index.ts`

**Interfaces:**

- Consumes: `resolveUsRequestDeadline` from Task 1 only at the server command boundary, not in Zod's pure scope parse; `preservedTlcSchema`, `traceabilityCivilDateSchema`, `platformUuidSchema` and existing search's exact UTF-8 byte comparison.
- Produces: `usTraceRequestScopeV1Schema`, `usTraceRequestCreateBodySchema`, `usTraceRequestUpdateBodySchema`, `usTraceRequestCloseBodySchema`, `usTraceRequestPrepareBodySchema` and inferred types. The scope has no cursor, page limit or client-supplied event pins.

- [ ] **Step 1: Write failing contract tests.** Use strict parsing and assert exact issue paths/cases, not just a failure count:

```ts
import { describe, expect, it } from "vitest";
import {
  usTraceRequestScopeV1Schema,
  usTraceRequestCreateBodySchema,
  usTraceRequestUpdateBodySchema,
  usTraceRequestPrepareBodySchema,
} from "../src/index.js";

const base = {
  requestNumber: "REQ-2026-APPLE-001",
  requesterName: "Synthetic requester",
  requesterOrganization: null,
  requesterContact: null,
  receivedAt: "2026-09-17T16:00:00Z",
  scope: null,
};
describe("US trace request commands", () => {
  it("permits a saved shell but requires a real selector in a scope", () => {
    expect(usTraceRequestCreateBodySchema.safeParse(base).success).toBe(true);
    expect(usTraceRequestScopeV1Schema.safeParse({}).success).toBe(false);
    expect(usTraceRequestScopeV1Schema.safeParse({ tlcs: [] }).success).toBe(false);
    expect(usTraceRequestScopeV1Schema.safeParse({ productId: "not-a-uuid" }).success).toBe(false);
  });
  it("rejects changed/duplicate TLCs, reversed ranges and unknown fields", () => {
    expect(usTraceRequestScopeV1Schema.safeParse({ tlcs: ["LOT-A", "LOT-A"] }).success).toBe(false);
    expect(usTraceRequestScopeV1Schema.safeParse({ tlcFrom: "Z", tlcTo: "A" }).success).toBe(false);
    expect(
      usTraceRequestScopeV1Schema.safeParse({
        eventDateFrom: "2026-10-02",
        eventDateTo: "2026-10-01",
      }).success,
    ).toBe(false);
    expect(usTraceRequestScopeV1Schema.safeParse({ productText: "Apple\nLot" }).success).toBe(
      false,
    );
    expect(usTraceRequestScopeV1Schema.safeParse({ tlc: "LOT-A", limit: 100 }).success).toBe(false);
  });
  it("never accepts client-owned tenant, actor, provenance or an event pin", () => {
    expect(usTraceRequestCreateBodySchema.safeParse({ ...base, tenantId: "other" }).success).toBe(
      false,
    );
    expect(
      usTraceRequestPrepareBodySchema.safeParse({
        mode: "available_records_incomplete",
        idempotencyKey: "ffb61437-c01b-4cc9-b287-5667d03c7844",
        eventPins: [],
      }).success,
    ).toBe(false);
  });
  it("rejects an update with no changed field", () => {
    expect(usTraceRequestUpdateBodySchema.safeParse({ expectedRevision: 2 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Verify RED.** Run `corepack pnpm --filter @markiro/platform-contracts exec vitest run test/us-requests.test.ts`; expect missing request exports.
- [ ] **Step 3: Implement strict versioned schemas.** Export the existing `cTextOrder` from `search-lot-card.ts` without changing its comparison. Import `isTlcSourceReferenceUrl` from `@markiro/domain`, `platformUuidSchema`, `preservedTlcSchema` and `traceabilityCivilDateSchema` from their existing contract modules. Define the shared primitives and scope as follows; `superRefine` also rejects duplicate arrays. A date-range-only scope is a selector, but an object with no field is not. Never fetch a source URL.

```ts
const boundedText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value === value.trim() && !/[\p{Cc}\p{Cs}]/u.test(value));
const requestNumber = boundedText(80);
const distinct = (items: readonly string[]) => new Set(items).size === items.length;

export const usTraceRequestScopeV1Schema = z
  .object({
    productId: platformUuidSchema.optional(),
    productText: boundedText(200).optional(),
    tlc: preservedTlcSchema.optional(),
    tlcs: z.array(preservedTlcSchema).min(1).max(50).optional(),
    tlcFrom: preservedTlcSchema.optional(),
    tlcTo: preservedTlcSchema.optional(),
    lotId: platformUuidSchema.optional(),
    locationIds: z.array(platformUuidSchema).min(1).max(50).optional(),
    sourceReferenceValue: boundedText(1024).refine(isTlcSourceReferenceUrl).optional(),
    documentNumber: boundedText(128).optional(),
    eventDateFrom: traceabilityCivilDateSchema.optional(),
    eventDateTo: traceabilityCivilDateSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.values(value).every((field) => field === undefined))
      context.addIssue({ code: "custom", path: [], message: "At least one selector required" });
    if (value.tlcs && !distinct(value.tlcs))
      context.addIssue({ code: "custom", path: ["tlcs"], message: "Duplicate TLC" });
    if (value.locationIds && !distinct(value.locationIds))
      context.addIssue({ code: "custom", path: ["locationIds"], message: "Duplicate location" });
    if (value.tlcFrom && value.tlcTo && cTextOrder(value.tlcFrom, value.tlcTo) > 0)
      context.addIssue({ code: "custom", path: ["tlcTo"], message: "Reversed TLC range" });
    if (value.eventDateFrom && value.eventDateTo && value.eventDateFrom > value.eventDateTo)
      context.addIssue({ code: "custom", path: ["eventDateTo"], message: "Reversed date range" });
  });
```

Implement create/update/close/prepare bodies as strict objects with these field names:

```ts
export const usTraceRequestCreateBodySchema = z
  .object({
    requestNumber: requestNumber,
    requesterName: boundedText(200),
    requesterOrganization: boundedText(200).nullable(),
    requesterContact: boundedText(500).nullable(),
    receivedAt: requestInstantSchema,
    dueAt: requestInstantSchema.optional(),
    alternateDeadlineReason: boundedText(2000).nullable().optional(),
    scope: usTraceRequestScopeV1Schema.nullable(),
  })
  .strict();
export const usTraceRequestUpdateBodySchema = usTraceRequestCreateBodySchema
  .partial()
  .extend({ expectedRevision: z.number().int().positive() })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== "expectedRevision"));
export const usTraceRequestCloseBodySchema = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();
export const usTraceRequestPrepareBodySchema = z
  .object({
    mode: z.enum(["export_ready", "available_records_incomplete"]),
    idempotencyKey: platformUuidSchema,
  })
  .strict();
```

Define `requestInstantSchema` as `z.iso.datetime({ offset: true })` refined to reject any nonzero fractional digit beyond the third, without transforming accepted text. Apply the same precision rule in Task 1's parser before constructing `Date`; an exactly representable trailing-zero fraction is valid.

`requestNumber` is 1–80 printable, already-trimmed characters; `boundedText` rejects controls and blank/overlength content rather than silently changing the saved request. At the server boundary, call Task 1 for the due/reason relationship; the contract checks shapes and precision and never infers a tenant/actor. Export the schemas and types from `src/index.ts`.

- [ ] **Step 4: Verify GREEN and package gates.** Build `@markiro/domain` first, then run focused and full contract tests, `typecheck`, `lint` and `build`. Re-run the affected US search contract test to prove exporting `cTextOrder` did not change ordering. Review exact strict-key and UTF-8 range behavior before Task 3.

### Task 3: Additive request/run/artifact storage

**Files:**

- Create: `packages/db/src/schema/traceability-requests.ts`
- Modify: `packages/db/src/schema.ts` and `packages/db/drizzle.config.ts`
- Create: `packages/db/migrations/0139_us_trace_requests.sql` and generated metadata (reconfirm that 0139 is free before generation)
- Create: `packages/db/test/us-request-schema.test.ts`
- Create: `packages/db/test/us-request-migration.e2e.test.ts`

**Interfaces:**

- Consumes: request scope JSON from Task 2; Plan table `traceabilityPlanVersions` already present.
- Produces: `schema.traceRequests`, `schema.traceExportRuns` and `schema.traceExportArtifacts`. Later server plans own all mutations; this task creates no run or artifact service.

- [ ] **Step 1: Write failing schema tests.** Assert table/column names, tenant-composite references, unique indexes, non-cascading FKs and constrained statuses with `getTableConfig`. Also add an owned-disposable-PostgreSQL migration test using `createUsProfileTestDatabase(process.env.US_TEST_DATABASE_URL)`. Its test seed creates two organizations and two effective synthetic Plan rows, inserts a request in A, then attempts a run in B referencing A's request, a run in A referencing B's Plan, and an artifact in B referencing A's run; each must fail with PostgreSQL `23503`. Insert a valid A→A→A chain and assert exact tenant IDs and retained rows. Test null scope shell; reject JSON array scope, duplicate request number, reversed/default deadline without reason, bad digest, empty-vs-nonempty snapshot/digest mismatch, and contradictory run terminal timestamps. The opt-in test must skip explicitly without `US_TEST_DATABASE_URL` and must never consume `DATABASE_URL`.

```ts
const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("US request migration in owned disposable PostgreSQL", () => {
  it("rejects cross-tenant run and artifact references", async () => {
    if (!url) throw new Error("US_TEST_DATABASE_URL is required");
    const fixture = await createUsProfileTestDatabase(url);
    try {
      const tenantA = randomUUID();
      const tenantB = randomUUID();
      const requestA = randomUUID();
      const operationKey = randomUUID();
      for (const id of [tenantA, tenantB])
        await fixture.pool.query(
          "INSERT INTO organization(id,name,slug,created_at) VALUES($1,'Synthetic',$1,now())",
          [id],
        );
      await fixture.pool.query(
        "INSERT INTO trace_requests(id,tenant_id,request_number,requester_name,received_at,due_at,created_by) VALUES($1,$2,'REQ-A','Synthetic','2026-09-17T16:00:00Z','2026-09-18T16:00:00Z','qa')",
        [requestA, tenantA],
      );
      await expect(
        fixture.pool.query(
          "INSERT INTO trace_export_runs(tenant_id,request_id,revision,mode,status,created_by,idempotency_key,command_digest,scoped_content_digest,input_snapshot,started_at) VALUES($1,$2,1,'available_records_incomplete','queued','qa',$3,$4,$4,$5,now())",
          [
            tenantB,
            requestA,
            operationKey,
            "a".repeat(64),
            JSON.stringify({ selectionKind: "empty" }),
          ],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    } finally {
      await fixture.close();
    }
  });
});
```

Import `randomUUID` from `node:crypto` and `createUsProfileTestDatabase` from `./support/us-profile-database.js`. Extend the same test fixture with the other cross-tenant Plan/artifact and constraint cases named above; never connect to a non-loopback database.

- [ ] **Step 2: Verify RED.** Run `corepack pnpm --filter @markiro/db exec vitest run test/us-request-schema.test.ts test/us-request-migration.e2e.test.ts`. The schema test must fail for missing exports. With `US_TEST_DATABASE_URL` set to the documented isolated loopback database, the migration test must fail for missing tables; report an intentional skip if that opt-in DB is unavailable.
- [ ] **Step 3: Implement the Drizzle schema and generate one additive migration.** Use text `status` with explicit CHECK constraints rather than new global PostgreSQL enums. Mirror these exact columns and relationships:

```sql
trace_requests(
  id uuid PRIMARY KEY, tenant_id text NOT NULL, request_number text NOT NULL,
  requester_name text NOT NULL, requester_organization text, requester_contact text,
  received_at timestamptz NOT NULL, due_at timestamptz NOT NULL,
  alternate_deadline_reason text, scope jsonb, revision integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'open', last_validation jsonb,
  last_validation_digest text, last_validated_at timestamptz,
  warning_ack_digest text, warning_ack_reason text, warning_ack_at timestamptz,
  warning_ack_by text, created_by text NOT NULL, closed_at timestamptz,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,request_number)
);
trace_export_runs(
  id uuid PRIMARY KEY, tenant_id text NOT NULL, request_id uuid NOT NULL,
  revision integer NOT NULL, mode text NOT NULL, status text NOT NULL,
  created_by text NOT NULL, idempotency_key uuid NOT NULL,
  command_digest text NOT NULL, scoped_content_digest text NOT NULL,
  input_snapshot jsonb NOT NULL, input_digest text, plan_version_id uuid,
  plan_pdf_sha256 text, registry_version integer, registry_hash text,
  export_ready boolean NOT NULL DEFAULT false, failure_code text,
  started_at timestamptz NOT NULL, generation_started_at timestamptz,
  report_rendered_at timestamptz, completed_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,request_id,revision),
  UNIQUE(tenant_id,created_by,idempotency_key),
  FOREIGN KEY(tenant_id,request_id) REFERENCES trace_requests(tenant_id,id),
  FOREIGN KEY(tenant_id,plan_version_id) REFERENCES traceability_plan_versions(tenant_id,id)
);
trace_export_artifacts(
  id uuid PRIMARY KEY, tenant_id text NOT NULL, run_id uuid NOT NULL,
  kind text NOT NULL, filename text NOT NULL, media_type text NOT NULL,
  byte_size bigint NOT NULL, sha256 text NOT NULL, object_key text NOT NULL,
  published_at timestamptz NOT NULL,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,run_id,kind),
  UNIQUE(tenant_id,run_id,filename),
  FOREIGN KEY(tenant_id,run_id) REFERENCES trace_export_runs(tenant_id,id)
);
```

Add organization FKs and indexes on request due time, run queue state and artifacts by run. CHECK rules: `due_at > received_at`; a changed 24-hour due value requires a nonblank 3–2000-character alternate reason, and default-equivalent due has no such reason; scope, validation and snapshot JSON are objects; request revision positive; status `open` requires null `closed_at` and `closed` requires nonnull `closed_at`; optional validation and acknowledgement fields are all-or-none; mode `export_ready|available_records_incomplete`; run status `queued|processing` requires null `completed_at`/`failure_code`, `ready` requires nonnull `completed_at` and null `failure_code`, `failed` requires both nonnull; `export_ready = true` only when mode is `export_ready` and status is `ready`; lowercase 64-hex digests; `input_digest IS NULL` iff `input_snapshot->>'selectionKind' = 'empty'`; Plan ID/hash all-or-none; positive bytes and constrained artifact kind `xlsx|plan_pdf|validation_report|request_report|manifest|package_zip`. Keep no cascade delete and no mutable legacy-table changes.

Run `corepack pnpm --filter @markiro/db exec drizzle-kit generate --name us_trace_requests` only after inspecting the journal and `drizzle.config.ts`, review its SQL/metadata and ensure it contains only these additive US tables/indexes/constraints. The inspected next index is 0139; if another task takes it before execution, update the plan and use the next free index instead. If unrelated generated changes appear, stop and isolate them without rewriting applied migrations. Export tables from `schema.ts` and include the new module in the Drizzle schema list.

- [ ] **Step 4: Verify GREEN and migration safety.** Build `@markiro/db` before consumers. Run focused schema and migration tests, then DB `test`, `typecheck`, `lint`, `build`. With an owned US disposable database, test both a fresh full migrate and an upgrade from the preceding journal through the new migration; compare pre-existing organization/profile/event/Plan rows byte-for-byte before/after, as in `us-plan-migration.e2e.test.ts`. Do not run migration against the base DB. Review generated SQL for every composite FK, index, nullability, default, check and no-cascade behavior.

## Stage completion gate

After each task, a separate reviewer inspects exact changed files and the RED→GREEN evidence before the next executor starts. At the end, run `git diff --check`, `corepack pnpm format:check` and the affected domain/contracts/DB package gates. Review the complete branch diff against the spec and preserve unrelated changes. Record opt-in DB skips honestly. No browser, artifact store, worker, PDF, Excel, hosted, backup/restore, deployment or regulatory acceptance is proven by this foundation. Do not mark US-09 or RQ-001–007 Done. No commit, push, PR, merge or release is authorized by this plan alone.
