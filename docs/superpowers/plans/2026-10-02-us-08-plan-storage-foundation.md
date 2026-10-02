# US-08 Plan Storage Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tenant-safe, versioned US Traceability Plan storage without making a plan approvable, downloadable or visible through HTTP yet.

**Architecture:** A new `traceability_plan_versions` table stores drafts and reserves complete frozen columns for later atomic approval. PostgreSQL owns cardinality, same-tenant lineage and approved-row immutability; the future US-only service owns authorization, snapshot validation, per-fact provenance, PDF publication, concurrency and audit. No RU, Station or public route is changed.

**Tech Stack:** PostgreSQL, Drizzle ORM/Kit, TypeScript, Vitest, the existing isolated `US_TEST_DATABASE_URL` fixture.

**Spec:** `docs/superpowers/specs/2026-10-02-us-08-traceability-plan-current-design.md`; follow the reviewed rules/contracts increment in `docs/superpowers/plans/2026-10-02-us-08-plan-rules-contracts.md`.

## Global Constraints

- Work only in `.worktrees/us-docs-audit` on `codex/us-mvp`. Preserve the current dirty US-06/07 and US-08 files. No commit, stage, push, release, deployment, real-data import or shared-database mutation is authorized by this plan.
- This stage creates no plan row from application code and no route. A schema test is not evidence of tenant authorization or a working approval workflow.
- Use the next unused migration number after the current journal tail `0135`; inspect the journal again immediately before generation. Add a migration; never rewrite an applied migration. Read `packages/db/drizzle.config.ts` before generating.
- Run database integration only through `createUsProfileTestDatabase` with its exact loopback `US_TEST_DATABASE_URL` guard. If that environment is unavailable, report the explicit skip and do not use `DATABASE_URL` or a shared database as a substitute.
- Draft sections remain typed plain text at the later service boundary. The DB checks only that `sections` is a JSON object; it does not treat an arbitrary JSON object as an approval-ready plan.
- A real approved snapshot will require an exhaustive per-fact source mapping (`configured`, `operator_confirmed`, `synthetic_fixture`), with code-owned workflow facts distinguished from fictional tenant facts. Actor/time confirmations and trusted demo identity belong to the following server capture/approval stages, not to a user-editable column or a client body. An approved row must never be published merely because its JSON fields are non-null.
- `US_FSMA204_PROCESSOR` is the only profile eligible for this plan; a future server command reloads the tenant profile and current membership. No schema trigger infers that eligibility from a name or tenant ID.

## Review Focus

1. Two concurrent drafts or two effective rows for one tenant: the second insert/update must fail at the partial unique index, while another tenant remains independent (Task 1).
2. A supersession pointer to a row of another tenant: the composite foreign key must reject it (Task 1).
3. A raw update/delete of an effective or superseded row, including its PDF hash, snapshot or actor: the migration guard must reject it; the sole effective→superseded transition may change only status, lineage, retention and update time (Task 1).
4. A draft marked effective without approver, frozen snapshot, digest and PDF metadata, or a superseded row without a civil `retain_through`: constraints must reject it (Task 1).
5. Applying the new migration to a pre-existing US schema: old profile/event rows must remain byte-equivalent and the new table must initially be empty (Task 1).

---

### Task 1: Tenant-safe version storage and migration

**Files:**

- Create: `packages/db/src/schema/traceability-plans.ts` — version row, tenant-safe constraints and indexes.
- Modify: `packages/db/src/schema.ts` and `packages/db/drizzle.config.ts` — exports/generation input only.
- Create: the next generated `packages/db/migrations/0136_*.sql` and its Drizzle metadata (`meta/_journal.json`, `meta/0136_snapshot.json`), provided `0136` remains unused at execution time. Add the approved-row guard to this new migration before it is committed or applied outside a disposable test database.
- Create: `packages/db/test/us-plan-schema.test.ts` — structural contract.
- Create: `packages/db/test/us-plan-migration.e2e.test.ts` — isolated migration and raw-SQL invariant tests.

**Interfaces:**

- Produces `schema.traceabilityPlanVersions` for the later US-only plan store; no API or domain import is added in this task.
- `id` UUID primary key; `tenantId` text with non-cascading organization FK; unique `(tenantId,id)` for same-tenant self-reference; unique `(tenantId,versionNumber)`.
- `status` is `draft | effective | superseded`. One partial unique index each for `(tenantId) WHERE status='draft'` and `WHERE status='effective'`.
- Draft fields: positive `versionNumber`, positive `draftRevision`, positive `schemaVersion`, `sections` JSON object, `changeSummary`, opaque `createdBy`, `createdAt`, `updatedAt`.
- Frozen approval columns: opaque `approvedBy`, `approvedAt`, `configSnapshot` JSON object, 64-hex `configDigest`, private `pdfObjectKey`, 64-hex `pdfSha256`, positive `pdfByteSize`, nonempty `rendererVersion`. These are all null for a draft and all present for effective/superseded. No public URL or credentials are stored.
- Supersession columns: `supersededById` same-tenant composite FK, `supersededAt`, civil-date `retainThrough`; all null for draft/effective, all present for superseded. An approved version above v1 requires a nonblank `changeSummary`.
- No cascade delete. A trigger blocks update/delete of superseded rows, blocks delete of effective rows, and permits effective→superseded only when all frozen column values and identity remain unchanged and only status/supersession/retention/`updatedAt` change. Draft identity `(id, tenantId, versionNumber, createdBy, createdAt)` is immutable.

- [ ] **Step 1: Write the failing structural and isolated migration tests.** In `us-plan-schema.test.ts`, assert `schema.traceabilityPlanVersions` exists, has the named columns, unique tenant/version and tenant/id keys, two partial unique status indexes, a same-tenant `superseded_by_id` FK, JSON columns and a civil-date `retain_through`. Assert no FK uses cascading delete. Use `getTableConfig`, as in `packages/db/test/us-case-bridge-schema.test.ts`. In `us-plan-migration.e2e.test.ts`, use `createUsProfileTestDatabase(url, 135)` then migrate through the new journal entry in the same owned disposable database. Seed a pre-existing organization/profile/event before migration and compare its `to_jsonb` bytes after. Test draft/effective uniqueness per tenant, cross-tenant lineage rejection, incomplete approved/superseded row rejection, approved hash/snapshot/actor update rejection, approved delete rejection, permitted effective→superseded transition with frozen bytes unchanged, and draft-only deletion.

`us-plan-schema.test.ts`:

```ts
import { getTableConfig } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { schema } from "../src/index.js";

it("models tenant-safe plan lineage", () => {
  const table = getTableConfig(schema.traceabilityPlanVersions);
  expect(table.indexes.filter((index) => index.config.unique && index.config.where)).toHaveLength(
    2,
  );
  expect(
    table.foreignKeys.some((key) => {
      const ref = key.reference();
      return (
        ref.foreignTable === schema.traceabilityPlanVersions &&
        ref.columns.map((column) => column.name).join() === "tenant_id,superseded_by_id" &&
        ref.foreignColumns.map((column) => column.name).join() === "tenant_id,id"
      );
    }),
  ).toBe(true);
});
```

`us-plan-migration.e2e.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("US plan storage migration", () => {
  it("allows only one draft per tenant", async () => {
    if (!url) throw new Error("Missing isolated US database URL");
    const fixture = await createUsProfileTestDatabase(url, 135);
    try {
      const tenant = randomUUID();
      await fixture.pool.query(
        "INSERT INTO organization(id,name,slug,created_at) VALUES($1,'Synthetic',$1,now())",
        [tenant],
      );
      await migrate(fixture.db, { migrationsFolder: resolve("migrations") });
      const insert = (version: number) =>
        fixture.pool.query(
          "INSERT INTO traceability_plan_versions(tenant_id,version_number,status,draft_revision,schema_version,sections,change_summary,created_by) VALUES($1,$2,'draft',1,1,'{}'::jsonb,'','qa')",
          [tenant, version],
        );
      await insert(1);
      await expect(insert(2)).rejects.toMatchObject({
        code: "23505",
        constraint: "traceability_plan_one_draft_uq",
      });
    } finally {
      await fixture.close();
    }
  });
});
```

- [ ] **Step 2: Confirm red.** Run `corepack pnpm --filter @markiro/db exec vitest run test/us-plan-schema.test.ts test/us-plan-migration.e2e.test.ts`; expect the structural test to fail on the missing export. If `US_TEST_DATABASE_URL` is set, the isolated migration test must also fail on the absent table; otherwise report its explicit skip without substituting another database.
- [ ] **Step 3: Add the schema and generate the complete migration.** Use Drizzle `pgTable`, `unique`, `uniqueIndex`, `foreignKey`, `check`, `jsonb`, `date(...,{ mode:"string" })`, and `timestamp(...,{withTimezone:true})`. Keep `status` as a table-local text check; do not introduce a shared global enum. Required check predicates: `draft` has every frozen/supersession column null; `effective` has every frozen column present and every supersession column null; `superseded` has every frozen/supersession column present; non-drafts above v1 have nonblank `change_summary`. Run `corepack pnpm --filter @markiro/db db:generate`, inspect generated SQL/metadata and add the guard trigger to the new migration **before any migration test applies it**. The guard checks `to_jsonb(NEW)` against `to_jsonb(OLD)` excluding only `status`, `superseded_by_id`, `superseded_at`, `retain_through`, `updated_at` for the one effective→superseded transition; all other approved updates/deletes raise SQLSTATE `23514`. Draft updates cannot alter the identity tuple. Do not modify an already-applied migration.
- [ ] **Step 4: Confirm green without weakening assertions.** Build `@markiro/db` before consumers, then run the focused schema/migration tests in a fresh owned disposable database. Check the migration journal number and the old-row equality result. If `US_TEST_DATABASE_URL` is absent, the migration test remains explicitly skipped and the storage behavior cannot be accepted as verified.
- [ ] **Step 5: Verify package and migration health.** Run `corepack pnpm --filter @markiro/db test`, `typecheck`, `lint`, `build`, then `git diff --check` and scoped Prettier. Inspect the migration journal/index and `packages/db/src/schema.ts` export. Report passed versus skipped database tests explicitly. Run `graphify update .` only if this worktree has a local graph.
- [ ] **Step 6: Independent review gate.** A fresh reviewer checks tenant FK/indexes, no-cascade retention, status-shape constraints, the narrow approved-row transition, pre-existing row equivalence, journal consistency and absence of any RU/HTTP path. No next implementation stage starts before findings are resolved.

## Handoff

This plan establishes storage guarantees only. The next server plan must: resolve profile/membership in a tenant transaction; read current configured facts consistently; build and validate exhaustive per-fact provenance with trusted demo identity or actor/time confirmations; save/list/discard drafts with revision and exact audit; then separately coordinate deterministic PDF/artifact publication and atomic approval. Its tests must cover stale revisions/configuration, cross-tenant IDs, duplicate approval and audit output. This storage plan does not authorize applying a migration to the shared development database, exposing a route, publishing an artifact or marking PLN-001–010 complete.

Execute with one separate implementer and one independent reviewer for this task, followed by primary acceptance. No commit/push/release is included; retain the existing isolated worktree and release locks.
