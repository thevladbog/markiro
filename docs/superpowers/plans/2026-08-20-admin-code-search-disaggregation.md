# Admin Code Search & Disaggregation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two new admin screens — exact KM/SSCC lookup with movement history and a code registry, plus draft→applied Disaggregation documents that dissolve whole boxes so their codes become free for re-aggregation.

**Architecture:** Derive-don't-materialize (spec Approach 1). No code-status column; status/history are computed over existing tables (`code_registry`, `codes`, `box_items`, `box_exceptions`, `pickup_order_items`). New tables only for disaggregation documents. Apply reuses station disassemble mechanics: `boxes.disassembledAt` + `box_items.removedAt` + a `box_exceptions` row (kind=`disassemble`) + `box_registry_versions` bump under `lockTenantBoxRegistry`.

**Tech Stack:** NestJS + zod DTOs + Drizzle (Postgres), React 19 + Vite + react-router data router + TanStack Query 5 + `@markiro/ui`, vitest everywhere.

**Spec:** `docs/superpowers/specs/2026-08-20-admin-code-search-disaggregation-design.md`

## Global Constraints

- Repo rule: after ANY edit under `packages/db/src`, run `pnpm --filter @markiro/db build` — the package ships compiled `dist` and the API imports it from there.
- Every new admin i18n key MUST be added to BOTH `apps/admin/src/i18n/ru.json` and `apps/admin/src/i18n/en.json` — missing keys throw in test mode (`apps/admin/test/i18n.test.tsx`).
- Cabinet endpoints use exactly this guard stack: `@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)` + `@AllowSubscriptionReadOnly("read")` on the controller; reads `@RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)`, mutations `@RequireSubscriptionWrite()` + `@RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)`.
- API e2e tests are guarded by `describe.skipIf(!ready)` where `ready = Boolean(process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL)` — copy the harness from `apps/api/test/box-exceptions.e2e.test.ts`.
- SSCC stored bare (18 digits, `char(18)`); API DTOs return `formatSsccWithAi(sscc)` (20-digit `00…`); admin renders `formatSsccHri(...)`. All three helpers come from `@markiro/domain`.
- Line validation statuses (fixed vocabulary, everywhere): `ok | not_found | not_closed | shift_open | already_disassembled | written_off | duplicate`.
- Document statuses: `draft | applied | cancelled`. Apply is all-or-nothing and irreversible; only drafts mutate; only drafts cancel.
- Migrations: `cd packages/db && pnpm db:generate` (drizzle-kit); new schema files must be added to `packages/db/drizzle.config.ts`'s `schema` array AND re-exported from `packages/db/src/schema.ts`.
- Commit after every task with a conventional-commit message.

---

### Task 1: DB schema — disaggregation tables + `box_exceptions.disaggregation_document_id`

**Files:**
- Create: `packages/db/src/schema/disaggregation.ts`
- Modify: `packages/db/src/schema/platform.ts` (add one column to `boxExceptions`)
- Modify: `packages/db/src/schema.ts` (re-export)
- Modify: `packages/db/drizzle.config.ts` (schema list)
- Create (generated): `packages/db/migrations/00NN_*.sql`

**Interfaces:**
- Produces: `schema.disaggregationReasons`, `schema.disaggregationDocCounters`, `schema.disaggregationDocuments`, `schema.disaggregationDocumentLines`, enums `disaggregationDocumentStatus`, `disaggregationSource`, `disaggregationLineStatus`, and `schema.boxExceptions.disaggregationDocumentId` (uuid, nullable). All later API tasks consume these via `schema.*` from `@markiro/db`.

- [ ] **Step 1: Create `packages/db/src/schema/disaggregation.ts`**

```ts
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organization } from "./auth.js";
import { boxes, products } from "./platform.js";

export const disaggregationDocumentStatus = pgEnum("disaggregation_document_status", [
  "draft",
  "applied",
  "cancelled",
]);
export const disaggregationSource = pgEnum("disaggregation_source", ["manual", "import"]);
export const disaggregationLineStatus = pgEnum("disaggregation_line_status", [
  "ok",
  "not_found",
  "not_closed",
  "shift_open",
  "already_disassembled",
  "written_off",
  "duplicate",
]);

const tenantId = () =>
  text("tenant_id")
    .notNull()
    .references(() => organization.id);

/** Managed dictionary of disaggregation reasons — clone of pickup_order_reasons. */
export const disaggregationReasons = pgTable(
  "disaggregation_reasons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("disaggregation_reasons_tenant_id_uq").on(t.tenantId, t.id)],
);

/** Per-tenant monotonic counter for DSG-YY-NNNN — same pattern as pickup_order_counters. */
export const disaggregationDocCounters = pgTable("disaggregation_doc_counters", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => organization.id),
  seq: integer("seq").notNull().default(0),
});

export const disaggregationDocuments = pgTable(
  "disaggregation_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    docNo: text("doc_no").notNull(),
    status: disaggregationDocumentStatus("status").notNull().default("draft"),
    /** Nullable while draft; the apply endpoint refuses a document without one. */
    reasonId: uuid("reason_id"),
    comment: text("comment"),
    source: disaggregationSource("source").notNull().default("manual"),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    appliedByUserId: text("applied_by_user_id"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("disaggregation_documents_tenant_id_uq").on(t.tenantId, t.id),
    unique("disaggregation_documents_tenant_doc_no_uq").on(t.tenantId, t.docNo),
    index("disaggregation_documents_tenant_created_idx").on(t.tenantId, t.createdAt),
    foreignKey({
      name: "disaggregation_documents_tenant_reason_fk",
      columns: [t.tenantId, t.reasonId],
      foreignColumns: [disaggregationReasons.tenantId, disaggregationReasons.id],
    }),
    check(
      "disaggregation_documents_applied_fields_check",
      sql`(${t.status} = 'applied') = (${t.appliedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * One SSCC per line. `ssccInput` preserves what the user typed/imported;
 * `sscc` is the normalized bare 18 digits (null when unparseable); `boxId`
 * resolves at validation time. Snapshot columns (`productId`, `codeCount`)
 * exist only so the UI can render without re-joining on every render — the
 * apply transaction re-derives everything from live tables.
 */
export const disaggregationDocumentLines = pgTable(
  "disaggregation_document_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    documentId: uuid("document_id").notNull(),
    ssccInput: text("sscc_input").notNull(),
    sscc: char("sscc", { length: 18 }),
    boxId: uuid("box_id"),
    status: disaggregationLineStatus("status").notNull(),
    productId: uuid("product_id"),
    codeCount: integer("code_count").notNull().default(0),
    validatedAt: timestamp("validated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("disaggregation_document_lines_tenant_doc_idx").on(t.tenantId, t.documentId),
    // One line per parseable SSCC per document. Partial: unparseable input
    // (sscc NULL) may repeat — each bad import line stays visible as its own row.
    unique("disaggregation_document_lines_doc_sscc_uq").on(t.tenantId, t.documentId, t.sscc),
    foreignKey({
      name: "disaggregation_document_lines_tenant_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [disaggregationDocuments.tenantId, disaggregationDocuments.id],
    }),
    foreignKey({
      name: "disaggregation_document_lines_tenant_box_fk",
      columns: [t.tenantId, t.boxId],
      foreignColumns: [boxes.tenantId, boxes.id],
    }),
    foreignKey({
      name: "disaggregation_document_lines_tenant_product_fk",
      columns: [t.tenantId, t.productId],
      foreignColumns: [products.tenantId, products.id],
    }),
  ],
);
```

Note: Postgres `unique` treats NULLs as distinct by default, so the partial-unique comment above holds with a plain `unique(...)` — duplicate NULL `sscc` rows are allowed, duplicate real SSCCs are not.

- [ ] **Step 2: Add `disaggregationDocumentId` to `boxExceptions` in `packages/db/src/schema/platform.ts`**

Insert after the `reason` column (`platform.ts:313`):

```ts
    /**
     * Set when this disassemble was performed by an admin Disaggregation
     * document rather than a station operator. Deliberately no FK: the
     * documents table lives in disaggregation.ts, which imports boxes FROM
     * this file — a composite FK here would create a hard import cycle.
     * Same precedent as shifts.stationCloseOwnerDeviceId above; the
     * disaggregation service is the only writer and always supplies its own
     * document id inside the same transaction.
     */
    disaggregationDocumentId: uuid("disaggregation_document_id"),
```

The existing `box_exceptions_kind_payload_check` needs NO change: admin rows use `kind='disassemble'` with `codeHash NULL`, `targetScannedAt NULL`, `reason NOT NULL` — exactly what the constraint already requires.

- [ ] **Step 3: Register the new schema file**

In `packages/db/src/schema.ts` add:

```ts
export * from "./schema/disaggregation.js";
```

In `packages/db/drizzle.config.ts` add to the `schema` array (after `"./src/schema/shift-exports.ts"`):

```ts
    "./src/schema/disaggregation.ts",
```

- [ ] **Step 4: Generate the migration**

```bash
cd packages/db && pnpm db:generate
```

Expected: one new file `packages/db/migrations/00NN_<name>.sql` containing `CREATE TYPE disaggregation_document_status`, `CREATE TABLE disaggregation_reasons/…_doc_counters/…_documents/…_document_lines`, and `ALTER TABLE "box_exceptions" ADD COLUMN "disaggregation_document_id" uuid`. Read the generated SQL and verify it contains ONLY these statements (drizzle-kit must not try to touch `codes`/`scan_events`, which are excluded from the config).

- [ ] **Step 5: Build the db package and typecheck**

```bash
pnpm --filter @markiro/db build && pnpm --filter @markiro/db typecheck
```

Expected: both succeed.

- [ ] **Step 6: Apply the migration to the dev database and commit**

```bash
cd packages/db && pnpm db:migrate
git add packages/db && git commit -m "feat(db): disaggregation documents schema + box_exceptions document link"
```

---

### Task 2: API — `disaggregation-reasons` module (dictionary CRUD)

**Files:**
- Create: `apps/api/src/modules/disaggregation-reasons/dto.ts`
- Create: `apps/api/src/modules/disaggregation-reasons/disaggregation-reasons.service.ts`
- Create: `apps/api/src/modules/disaggregation-reasons/disaggregation-reasons.controller.ts`
- Create: `apps/api/src/modules/disaggregation-reasons/disaggregation-reasons.module.ts`
- Modify: `apps/api/src/app.module.ts` (import + register module)
- Test: `apps/api/test/disaggregation-reasons.e2e.test.ts`

**Interfaces:**
- Produces: REST `GET/POST /disaggregation-reasons`, `PATCH/DELETE /disaggregation-reasons/:id`; `ReasonDto { id: string; name: string; sortOrder: number }`, `ListReasonsResponseDto { items: ReasonDto[] }`. Task 6 (apply) reads `schema.disaggregationReasons.name` directly; Tasks 8–9 (admin) consume these endpoints.

This module is a mechanical clone of `apps/api/src/modules/pickup-reasons/` (all four files, ~210 lines total) with these substitutions: `PickupReasons` → `DisaggregationReasons`, `pickup-reasons` → `disaggregation-reasons`, `schema.pickupOrderReasons` → `schema.disaggregationReasons`, `@ApiTags("pickup-reasons")` → `@ApiTags("disaggregation-reasons")`, `@Controller("pickup-reasons")` → `@Controller("disaggregation-reasons")`. DTO zod schemas are identical (`name: z.string().trim().min(1).max(120)`, `sortOrder: z.number().int()`); `DELETE` soft-archives (`archived: true`) because documents reference reasons by FK.

- [ ] **Step 1: Write the failing e2e test**

`apps/api/test/disaggregation-reasons.e2e.test.ts` — harness copied verbatim from `apps/api/test/box-exceptions.e2e.test.ts` (`beforeAll` boots `AppModule.forRoot`, `mountAuth`, `signUpAndActivate(agent)`); the station-device fixture is not needed here:

```ts
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);

describe.skipIf(!ready)("disaggregation-reasons e2e", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
    agent = request.agent(app!.getHttpServer());
    await signUpAndActivate(agent);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("creates, lists, updates, archives", async () => {
    const created = await agent
      .post("/disaggregation-reasons")
      .send({ name: "Пересорт", sortOrder: 1 })
      .expect(201);
    const id = (created.body as { id: string }).id;

    const list = await agent.get("/disaggregation-reasons").expect(200);
    expect((list.body as { items: { id: string }[] }).items.map((r) => r.id)).toContain(id);

    const updated = await agent
      .patch(`/disaggregation-reasons/${id}`)
      .send({ name: "Пересорт продукции" })
      .expect(200);
    expect((updated.body as { name: string }).name).toBe("Пересорт продукции");

    await agent.delete(`/disaggregation-reasons/${id}`).expect(204);
    const after = await agent.get("/disaggregation-reasons").expect(200);
    expect((after.body as { items: { id: string }[] }).items.map((r) => r.id)).not.toContain(id);
  });

  it("rejects an empty name", async () => {
    await agent.post("/disaggregation-reasons").send({ name: "  " }).expect(400);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @markiro/api test -- disaggregation-reasons
```

Expected: FAIL (404 on `/disaggregation-reasons` — module not registered).

- [ ] **Step 3: Create the four module files as the clone described above, register `DisaggregationReasonsModule` in `apps/api/src/app.module.ts`** (import at top, add to the `imports` array next to `PickupReasonsModule`).

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @markiro/api test -- disaggregation-reasons
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "feat(api): disaggregation reasons dictionary CRUD"
```

---

### Task 3: API — disaggregation documents: create / list / get / patch / cancel

**Files:**
- Create: `apps/api/src/modules/disaggregation/doc-number.ts`
- Create: `apps/api/src/modules/disaggregation/dto.ts`
- Create: `apps/api/src/modules/disaggregation/disaggregation.service.ts`
- Create: `apps/api/src/modules/disaggregation/disaggregation.controller.ts`
- Create: `apps/api/src/modules/disaggregation/disaggregation.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/doc-number.test.ts`, `apps/api/test/disaggregation.e2e.test.ts`

**Interfaces:**
- Consumes: Task 1 schema; Task 2's reasons (FK).
- Produces:
  - `POST /disaggregation` body `{ reasonId?: string; comment?: string }` → `DocumentDto` (201)
  - `GET /disaggregation?status=&reasonId=&from=&to=&page=` → `{ items: DocumentListItemDto[]; page: number; pageCount: number; total: number }`
  - `GET /disaggregation/:id` → `DocumentDetailDto { ...DocumentDto; lines: LineDto[] }`
  - `PATCH /disaggregation/:id` body `{ reasonId?: string | null; comment?: string | null }` → `DocumentDto` (draft only, else 409)
  - `POST /disaggregation/:id/cancel` → `DocumentDto` (draft only, else 409)
  - Types:
    ```ts
    export type LineStatus =
      | "ok" | "not_found" | "not_closed" | "shift_open"
      | "already_disassembled" | "written_off" | "duplicate";
    export interface LineDto {
      id: string; ssccInput: string; sscc: string | null; // 20-digit AI form or null
      boxId: string | null; status: LineStatus;
      productId: string | null; productName: string | null;
      codeCount: number; validatedAt: Date;
    }
    export interface DocumentDto {
      id: string; docNo: string; status: "draft" | "applied" | "cancelled";
      reasonId: string | null; reasonName: string | null; comment: string | null;
      source: "manual" | "import";
      lineCount: number; codeCount: number;
      createdByUserId: string; createdAt: Date;
      appliedAt: Date | null; appliedByUserId: string | null; cancelledAt: Date | null;
    }
    export interface DocumentListItemDto extends DocumentDto {}
    export interface DocumentDetailDto extends DocumentDto { lines: LineDto[] }
    ```
  - Service methods Tasks 4–6 extend: `DisaggregationService.getDocument(tenantId, id)`, `.assertDraft(row)` (throws `ConflictException` with `{ code: "not_draft" }` when status ≠ draft).

- [ ] **Step 1: Write the failing unit test for doc numbering**

`apps/api/test/doc-number.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatDocNo } from "../src/modules/disaggregation/doc-number";

describe("formatDocNo", () => {
  it("formats DSG-YY-NNNN", () => {
    expect(formatDocNo(7, new Date("2026-08-20T00:00:00Z"))).toBe("DSG-26-0007");
  });
  it("does not truncate large seqs", () => {
    expect(formatDocNo(12345, new Date("2026-08-20T00:00:00Z"))).toBe("DSG-26-12345");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @markiro/api test -- doc-number
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement `doc-number.ts`** — direct adaptation of `apps/api/src/pickup/order-number.ts`:

```ts
import { sql } from "drizzle-orm";
import { schema } from "@markiro/db";

/** Formats a document sequence + creation date as `DSG-YY-NNNN`. */
export function formatDocNo(seq: number, when: Date): string {
  const yy = String(when.getUTCFullYear() % 100).padStart(2, "0");
  return `DSG-${yy}-${String(seq).padStart(4, "0")}`;
}

/** Atomic per-tenant increment; works inside a transaction handle. */
export async function nextDocNo(
  tx: { execute: (q: unknown) => Promise<{ rows: Array<{ seq: number }> }> },
  tenantId: string,
  when: Date,
): Promise<string> {
  const result = await tx.execute(sql`
    insert into ${schema.disaggregationDocCounters} (tenant_id, seq) values (${tenantId}, 1)
    on conflict (tenant_id) do update set seq = ${schema.disaggregationDocCounters.seq} + 1
    returning seq`);
  return formatDocNo(result.rows[0]!.seq, when);
}
```

- [ ] **Step 4: Run the unit test — expected PASS.**

- [ ] **Step 5: Write the failing e2e test** — `apps/api/test/disaggregation.e2e.test.ts`, same harness boilerplate as Task 2's test (copy the `beforeAll`/`afterAll` block verbatim). Test body:

```ts
  it("creates a draft with a DSG number, patches, lists, gets, cancels", async () => {
    const reason = await agent
      .post("/disaggregation-reasons")
      .send({ name: "Брак упаковки" })
      .expect(201);
    const reasonId = (reason.body as { id: string }).id;

    const created = await agent.post("/disaggregation").send({}).expect(201);
    const doc = created.body as { id: string; docNo: string; status: string };
    expect(doc.status).toBe("draft");
    expect(doc.docNo).toMatch(/^DSG-\d{2}-\d{4,}$/);

    const patched = await agent
      .patch(`/disaggregation/${doc.id}`)
      .send({ reasonId, comment: "тест" })
      .expect(200);
    expect((patched.body as { reasonId: string }).reasonId).toBe(reasonId);
    expect((patched.body as { reasonName: string }).reasonName).toBe("Брак упаковки");

    const list = await agent.get("/disaggregation").expect(200);
    expect((list.body as { items: { id: string }[] }).items.map((d) => d.id)).toContain(doc.id);

    const detail = await agent.get(`/disaggregation/${doc.id}`).expect(200);
    expect((detail.body as { lines: unknown[] }).lines).toEqual([]);

    const cancelled = await agent.post(`/disaggregation/${doc.id}/cancel`).expect(200);
    expect((cancelled.body as { status: string }).status).toBe("cancelled");

    // A cancelled document refuses further mutation.
    await agent.patch(`/disaggregation/${doc.id}`).send({ comment: "x" }).expect(409);
    await agent.post(`/disaggregation/${doc.id}/cancel`).expect(409);
  });

  it("404s on a foreign/unknown id", async () => {
    await agent.get(`/disaggregation/00000000-0000-0000-0000-000000000000`).expect(404);
  });
```

- [ ] **Step 6: Run to verify it fails** (`pnpm --filter @markiro/api test -- disaggregation.e2e`). Expected: FAIL (404, module not registered).

- [ ] **Step 7: Implement dto.ts** (zod schemas + the DTO interfaces from this task's Interfaces block):

```ts
import { z } from "zod";

export const createDocumentSchema = z.object({
  reasonId: z.string().uuid().optional(),
  comment: z.string().trim().max(500).optional(),
});
export type CreateDocumentDto = z.infer<typeof createDocumentSchema>;

export const updateDocumentSchema = z.object({
  reasonId: z.string().uuid().nullable().optional(),
  comment: z.string().trim().max(500).nullable().optional(),
});
export type UpdateDocumentDto = z.infer<typeof updateDocumentSchema>;

export const listDocumentsQuerySchema = z.object({
  status: z.enum(["draft", "applied", "cancelled"]).optional(),
  reasonId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
});
export type ListDocumentsQueryDto = z.infer<typeof listDocumentsQuerySchema>;
```

(plus the `LineStatus`/`LineDto`/`DocumentDto`/`DocumentListItemDto`/`DocumentDetailDto` interfaces exactly as written in Interfaces above).

- [ ] **Step 8: Implement the service.** `disaggregation.service.ts` skeleton for this task (Tasks 4–6 add methods):

```ts
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, gte, lte, sql, sum } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { formatSsccWithAi } from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import { nextDocNo } from "./doc-number";
import type {
  CreateDocumentDto, DocumentDetailDto, DocumentDto, LineDto,
  ListDocumentsQueryDto, UpdateDocumentDto,
} from "./dto";

const PAGE_SIZE = 50;

@Injectable()
export class DisaggregationService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async createDocument(
    tenantId: string, userId: string, data: CreateDocumentDto,
  ): Promise<DocumentDto> {
    return this.db.transaction(async (tx) => {
      const docNo = await nextDocNo(
        { execute: (q) => tx.execute<{ seq: number }>(q as Parameters<typeof tx.execute>[0]) },
        tenantId,
        new Date(),
      );
      const [row] = await tx
        .insert(schema.disaggregationDocuments)
        .values({
          tenantId, docNo,
          reasonId: data.reasonId ?? null,
          comment: data.comment ?? null,
          createdByUserId: userId,
        })
        .returning();
      return this.toDocumentDto(tenantId, row!);
    });
  }

  async listDocuments(tenantId: string, query: ListDocumentsQueryDto) {
    const where = and(
      eq(schema.disaggregationDocuments.tenantId, tenantId),
      query.status ? eq(schema.disaggregationDocuments.status, query.status) : undefined,
      query.reasonId ? eq(schema.disaggregationDocuments.reasonId, query.reasonId) : undefined,
      query.from ? gte(schema.disaggregationDocuments.createdAt, query.from) : undefined,
      query.to ? lte(schema.disaggregationDocuments.createdAt, query.to) : undefined,
    );
    const [{ total }] = await this.db
      .select({ total: count() })
      .from(schema.disaggregationDocuments)
      .where(where);
    const rows = await this.db
      .select()
      .from(schema.disaggregationDocuments)
      .where(where)
      .orderBy(desc(schema.disaggregationDocuments.createdAt))
      .limit(PAGE_SIZE)
      .offset((query.page - 1) * PAGE_SIZE);
    const items = await Promise.all(rows.map((r) => this.toDocumentDto(tenantId, r)));
    return { items, page: query.page, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)), total };
  }

  async getDocument(tenantId: string, id: string): Promise<DocumentDetailDto> {
    const row = await this.findDocument(tenantId, id);
    const lines = await this.listLines(tenantId, id);
    return { ...(await this.toDocumentDto(tenantId, row)), lines };
  }

  async updateDocument(
    tenantId: string, id: string, data: UpdateDocumentDto,
  ): Promise<DocumentDto> {
    const row = await this.findDocument(tenantId, id);
    this.assertDraft(row);
    const set: Record<string, unknown> = { updatedAt: sql`now()` };
    if (data.reasonId !== undefined) set.reasonId = data.reasonId;
    if (data.comment !== undefined) set.comment = data.comment;
    const [updated] = await this.db
      .update(schema.disaggregationDocuments)
      .set(set)
      .where(and(
        eq(schema.disaggregationDocuments.tenantId, tenantId),
        eq(schema.disaggregationDocuments.id, id),
      ))
      .returning();
    return this.toDocumentDto(tenantId, updated!);
  }

  async cancelDocument(tenantId: string, id: string): Promise<DocumentDto> {
    const row = await this.findDocument(tenantId, id);
    this.assertDraft(row);
    const [updated] = await this.db
      .update(schema.disaggregationDocuments)
      .set({ status: "cancelled", cancelledAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(
        eq(schema.disaggregationDocuments.tenantId, tenantId),
        eq(schema.disaggregationDocuments.id, id),
      ))
      .returning();
    return this.toDocumentDto(tenantId, updated!);
  }

  // ---- shared helpers (Tasks 4–6 reuse these) ----

  async findDocument(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(schema.disaggregationDocuments)
      .where(and(
        eq(schema.disaggregationDocuments.tenantId, tenantId),
        eq(schema.disaggregationDocuments.id, id),
      ));
    if (!row) throw new NotFoundException();
    return row;
  }

  assertDraft(row: { status: string }): void {
    if (row.status !== "draft") {
      throw new ConflictException({ code: "not_draft", message: "Document is not a draft" });
    }
  }

  async listLines(tenantId: string, documentId: string): Promise<LineDto[]> {
    const rows = await this.db
      .select({
        id: schema.disaggregationDocumentLines.id,
        ssccInput: schema.disaggregationDocumentLines.ssccInput,
        sscc: schema.disaggregationDocumentLines.sscc,
        boxId: schema.disaggregationDocumentLines.boxId,
        status: schema.disaggregationDocumentLines.status,
        productId: schema.disaggregationDocumentLines.productId,
        productName: schema.products.name,
        codeCount: schema.disaggregationDocumentLines.codeCount,
        validatedAt: schema.disaggregationDocumentLines.validatedAt,
      })
      .from(schema.disaggregationDocumentLines)
      .leftJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.disaggregationDocumentLines.tenantId),
          eq(schema.products.id, schema.disaggregationDocumentLines.productId),
        ),
      )
      .where(and(
        eq(schema.disaggregationDocumentLines.tenantId, tenantId),
        eq(schema.disaggregationDocumentLines.documentId, documentId),
      ))
      .orderBy(schema.disaggregationDocumentLines.createdAt);
    return rows.map((r) => ({ ...r, sscc: r.sscc === null ? null : formatSsccWithAi(r.sscc) }));
  }

  private async toDocumentDto(
    tenantId: string,
    row: typeof schema.disaggregationDocuments.$inferSelect,
  ): Promise<DocumentDto> {
    const [agg] = await this.db
      .select({
        lineCount: count(),
        codeCount: sum(schema.disaggregationDocumentLines.codeCount).mapWith(Number),
      })
      .from(schema.disaggregationDocumentLines)
      .where(and(
        eq(schema.disaggregationDocumentLines.tenantId, tenantId),
        eq(schema.disaggregationDocumentLines.documentId, row.id),
      ));
    let reasonName: string | null = null;
    if (row.reasonId) {
      const [reason] = await this.db
        .select({ name: schema.disaggregationReasons.name })
        .from(schema.disaggregationReasons)
        .where(and(
          eq(schema.disaggregationReasons.tenantId, tenantId),
          eq(schema.disaggregationReasons.id, row.reasonId),
        ));
      reasonName = reason?.name ?? null;
    }
    return {
      id: row.id, docNo: row.docNo, status: row.status,
      reasonId: row.reasonId, reasonName, comment: row.comment, source: row.source,
      lineCount: agg?.lineCount ?? 0, codeCount: agg?.codeCount ?? 0,
      createdByUserId: row.createdByUserId, createdAt: row.createdAt,
      appliedAt: row.appliedAt, appliedByUserId: row.appliedByUserId,
      cancelledAt: row.cancelledAt,
    };
  }
}
```

- [ ] **Step 9: Implement the controller + module, register in app.module.ts.** Controller follows the Task 2 clone pattern (same decorators/guards; reads `OPERATIONS_READ`, mutations `OPERATIONS_WRITE` + `@RequireSubscriptionWrite()`):

```ts
@ApiTags("disaggregation")
@Controller("disaggregation")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class DisaggregationController {
  constructor(private readonly service: DisaggregationService) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  list(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listDocumentsQuerySchema)) query: ListDocumentsQueryDto,
  ) {
    return this.service.listDocuments(req.tenantId!, query);
  }

  @Post()
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  create(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createDocumentSchema)) body: CreateDocumentDto,
  ) {
    return this.service.createDocument(req.tenantId!, req.userId!, body);
  }

  @Get(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  get(@Req() req: RequestWithTenant, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.service.getDocument(req.tenantId!, id);
  }

  @Patch(":id")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  update(
    @Req() req: RequestWithTenant,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateDocumentSchema)) body: UpdateDocumentDto,
  ) {
    return this.service.updateDocument(req.tenantId!, id, body);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  cancel(@Req() req: RequestWithTenant, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.service.cancelDocument(req.tenantId!, id);
  }
}
```

- [ ] **Step 10: Run e2e — expected PASS** (`pnpm --filter @markiro/api test -- disaggregation.e2e`).

- [ ] **Step 11: Commit** — `git add apps/api && git commit -m "feat(api): disaggregation documents draft lifecycle"`.

---

### Task 4: API — line validation + add/remove lines

**Files:**
- Create: `apps/api/src/modules/disaggregation/line-validation.ts`
- Modify: `apps/api/src/modules/disaggregation/disaggregation.service.ts`
- Modify: `apps/api/src/modules/disaggregation/disaggregation.controller.ts`
- Modify: `apps/api/src/modules/disaggregation/dto.ts`
- Test: `apps/api/test/disaggregation-lines.e2e.test.ts`

**Interfaces:**
- Consumes: Task 3's `findDocument`/`assertDraft`/`listLines`; `parseScannedSscc` from `@markiro/domain`.
- Produces:
  - `POST /disaggregation/:id/lines` body `{ ssccs: string[] }` (1–500 entries, each `min(1).max(64)`) → `{ lines: LineDto[] }` (the document's full refreshed line list; draft only)
  - `DELETE /disaggregation/:id/lines/:lineId` → 204 (draft only)
  - `validateBoxCandidates(db, tenantId, ssccs: string[]): Promise<Map<string, BoxCandidate>>` in `line-validation.ts`, where
    ```ts
    export interface BoxCandidate {
      boxId: string;
      status: Exclude<LineStatus, "duplicate" | "not_found">; // ok | not_closed | shift_open | already_disassembled | written_off
      productId: string | null;
      codeCount: number;
    }
    ```
    keyed by bare-18 SSCC; an SSCC absent from the map means `not_found`. Task 6 (apply) re-runs this same function inside its transaction.

- [ ] **Step 1: Implement `line-validation.ts`** (written first — it is shared with Task 6; the e2e in Step 2 covers it):

```ts
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import type { LineStatus } from "./dto";

export interface BoxCandidate {
  boxId: string;
  status: Exclude<LineStatus, "duplicate" | "not_found">;
  productId: string | null;
  codeCount: number;
}

/**
 * Resolves each bare-18 SSCC to a box and classifies it, first failure wins:
 * not_closed → shift_open → already_disassembled → written_off → ok.
 * (Spec §2 "Line validation rules"; not_found = absent from the result map,
 * duplicate is a per-document concern the caller owns.)
 * Works on any executor — the caller passes either `db` or a `tx`.
 */
export async function validateBoxCandidates(
  db: Pick<Db, "select">,
  tenantId: string,
  ssccs: string[],
): Promise<Map<string, BoxCandidate>> {
  const result = new Map<string, BoxCandidate>();
  if (ssccs.length === 0) return result;

  const rows = await db
    .select({
      boxId: schema.boxes.id,
      sscc: schema.boxes.sscc,
      closedAt: schema.boxes.closedAt,
      closureReceivedAt: schema.boxes.closureReceivedAt,
      disassembledAt: schema.boxes.disassembledAt,
      shiftStatus: schema.shifts.status,
      productId: schema.shifts.productId,
      codeCount: sql<number>`count(${schema.boxItems.codeHash}) filter (where ${schema.boxItems.displacedAt} is null and ${schema.boxItems.removedAt} is null)`.mapWith(Number),
      // Box referenced by any non-cancelled kiosk order?
      inActiveOrder: sql<boolean>`coalesce(bool_or(${schema.pickupOrders.status} is not null and ${schema.pickupOrders.status} <> 'cancelled'), false)`.mapWith(Boolean),
    })
    .from(schema.boxes)
    .innerJoin(
      schema.shifts,
      and(eq(schema.shifts.tenantId, schema.boxes.tenantId), eq(schema.shifts.id, schema.boxes.shiftId)),
    )
    .leftJoin(
      schema.boxItems,
      and(eq(schema.boxItems.tenantId, schema.boxes.tenantId), eq(schema.boxItems.boxId, schema.boxes.id)),
    )
    .leftJoin(
      schema.pickupOrderBoxes,
      and(
        eq(schema.pickupOrderBoxes.tenantId, schema.boxes.tenantId),
        eq(schema.pickupOrderBoxes.boxId, schema.boxes.id),
      ),
    )
    .leftJoin(
      schema.pickupOrders,
      and(
        eq(schema.pickupOrders.tenantId, schema.pickupOrderBoxes.tenantId),
        eq(schema.pickupOrders.id, schema.pickupOrderBoxes.orderId),
      ),
    )
    .where(and(eq(schema.boxes.tenantId, tenantId), inArray(schema.boxes.sscc, ssccs)))
    .groupBy(schema.boxes.id, schema.shifts.status, schema.shifts.productId);

  // Codes of these boxes locked by item-level pickup orders (kiosk scanned
  // individual bottles, not the box): box_items → codes (for gtin/serial) →
  // pickup_order_items on the reconstructed km_key, voided = false.
  const boxIds = rows.map((r) => r.boxId);
  const lockedBoxIds = new Set<string>();
  if (boxIds.length > 0) {
    const locked = await db
      .selectDistinct({ boxId: schema.boxItems.boxId })
      .from(schema.boxItems)
      .innerJoin(
        schema.codes,
        and(
          eq(schema.codes.tenantId, schema.boxItems.tenantId),
          eq(schema.codes.codeHash, schema.boxItems.codeHash),
        ),
      )
      .innerJoin(
        schema.pickupOrderItems,
        and(
          eq(schema.pickupOrderItems.tenantId, schema.boxItems.tenantId),
          eq(schema.pickupOrderItems.voided, false),
          sql`${schema.pickupOrderItems.kmKey} = '01' || ${schema.codes.gtin14} || '21' || ${schema.codes.serial}`,
        ),
      )
      .where(
        and(
          eq(schema.boxItems.tenantId, tenantId),
          inArray(schema.boxItems.boxId, boxIds),
          isNull(schema.boxItems.displacedAt),
          isNull(schema.boxItems.removedAt),
        ),
      );
    for (const row of locked) lockedBoxIds.add(row.boxId);
  }

  for (const row of rows) {
    if (row.sscc === null) continue;
    let status: BoxCandidate["status"];
    if (row.closedAt === null || row.closureReceivedAt === null) status = "not_closed";
    else if (row.shiftStatus !== "closed") status = "shift_open";
    else if (row.disassembledAt !== null) status = "already_disassembled";
    else if (row.inActiveOrder || lockedBoxIds.has(row.boxId)) status = "written_off";
    else status = "ok";
    result.set(row.sscc, {
      boxId: row.boxId,
      status,
      productId: row.productId,
      codeCount: row.codeCount,
    });
  }
  return result;
}
```

- [ ] **Step 2: Write the failing e2e test.** `apps/api/test/disaggregation-lines.e2e.test.ts` reuses the station fixture helpers from `apps/api/test/boxes.e2e.test.ts` (copy `createTestStationDevice`, `createActiveProduct`, `openShiftForProduct`, `scan`, `postBatch` — post scans with a `boxes: [...]` closure so the box gets a real SSCC via the batch's closure payload; see `station-scans.e2e.test.ts` for the closure shape). Cases:

```ts
  it("adds SSCCs with per-line validation statuses", async () => {
    // fixture: shift opened, 2 codes scanned into device box "b1",
    // closure posted with a valid SSCC, shift still OPEN.
    const doc = await createDraft(); // POST /disaggregation
    const res = await agent
      .post(`/disaggregation/${doc.id}/lines`)
      .send({ ssccs: [`(00)${SSCC1}`, "not-an-sscc", `(00)${SSCC1}`] })
      .expect(201);
    const lines = (res.body as { lines: LineDtoWire[] }).lines;
    expect(lines).toHaveLength(3);
    expect(lines[0]!.status).toBe("shift_open"); // box closed, but shift not
    expect(lines[1]!.status).toBe("not_found");  // unparseable input preserved
    expect(lines[1]!.ssccInput).toBe("not-an-sscc");
    expect(lines[2]!.status).toBe("duplicate");
  });

  it("flips shift_open → ok once the shift closes", async () => {
    await agent.post(`/shifts/${shiftId}/close`).expect(200);
    const doc = await createDraft();
    const res = await agent
      .post(`/disaggregation/${doc.id}/lines`)
      .send({ ssccs: [SSCC1] })
      .expect(201);
    expect((res.body as { lines: LineDtoWire[] }).lines[0]!.status).toBe("ok");
    expect((res.body as { lines: LineDtoWire[] }).lines[0]!.codeCount).toBe(2);
  });

  it("removes a line; refuses line mutations on non-drafts", async () => {
    const doc = await createDraft();
    const added = await agent
      .post(`/disaggregation/${doc.id}/lines`).send({ ssccs: [SSCC1] }).expect(201);
    const lineId = (added.body as { lines: { id: string }[] }).lines[0]!.id;
    await agent.delete(`/disaggregation/${doc.id}/lines/${lineId}`).expect(204);
    await agent.post(`/disaggregation/${doc.id}/cancel`).expect(200);
    await agent.post(`/disaggregation/${doc.id}/lines`).send({ ssccs: [SSCC1] }).expect(409);
  });
```

(Check the exact shift-close route in `apps/api/src/modules/shifts/` before writing the fixture — reuse whatever `boxes.e2e.test.ts`/`station-shift-close` tests use to move a shift to `closed`.)

- [ ] **Step 3: Run to verify it fails** (`pnpm --filter @markiro/api test -- disaggregation-lines`). Expected: FAIL 404.

- [ ] **Step 4: Implement.** dto.ts additions:

```ts
export const addLinesSchema = z.object({
  ssccs: z.array(z.string().trim().min(1).max(64)).min(1).max(500),
});
export type AddLinesDto = z.infer<typeof addLinesSchema>;
```

Service additions:

```ts
  async addLines(tenantId: string, documentId: string, ssccs: string[]) {
    const doc = await this.findDocument(tenantId, documentId);
    this.assertDraft(doc);

    // Parse first: normalize every input to bare-18 or null.
    const parsed = ssccs.map((input) => ({
      input,
      sscc: parseScannedSscc(input.trim()),
    }));
    const candidates = await validateBoxCandidates(
      this.db, tenantId, [...new Set(parsed.map((p) => p.sscc).filter((s): s is string => s !== null))],
    );

    const existing = new Set(
      (await this.db
        .select({ sscc: schema.disaggregationDocumentLines.sscc })
        .from(schema.disaggregationDocumentLines)
        .where(and(
          eq(schema.disaggregationDocumentLines.tenantId, tenantId),
          eq(schema.disaggregationDocumentLines.documentId, documentId),
        )))
        .map((r) => r.sscc)
        .filter((s): s is string => s !== null),
    );

    const values = [];
    for (const { input, sscc } of parsed) {
      if (sscc === null) {
        values.push({ tenantId, documentId, ssccInput: input, sscc: null, status: "not_found" as const });
        continue;
      }
      if (existing.has(sscc)) {
        // Store nothing for a repeat of an already-present line — repeats in
        // the SAME request get one real row + duplicate marker rows would
        // violate the unique index, so mark duplicates with sscc NULL kept
        // as the raw input for visibility.
        values.push({ tenantId, documentId, ssccInput: input, sscc: null, status: "duplicate" as const });
        continue;
      }
      existing.add(sscc);
      const candidate = candidates.get(sscc);
      values.push({
        tenantId, documentId, ssccInput: input, sscc,
        status: candidate?.status ?? ("not_found" as const),
        boxId: candidate?.boxId ?? null,
        productId: candidate?.productId ?? null,
        codeCount: candidate?.codeCount ?? 0,
      });
    }
    if (values.length > 0) {
      await this.db.insert(schema.disaggregationDocumentLines).values(values);
      await this.touch(tenantId, documentId);
    }
    return { lines: await this.listLines(tenantId, documentId) };
  }

  async removeLine(tenantId: string, documentId: string, lineId: string): Promise<void> {
    const doc = await this.findDocument(tenantId, documentId);
    this.assertDraft(doc);
    const removed = await this.db
      .delete(schema.disaggregationDocumentLines)
      .where(and(
        eq(schema.disaggregationDocumentLines.tenantId, tenantId),
        eq(schema.disaggregationDocumentLines.documentId, documentId),
        eq(schema.disaggregationDocumentLines.id, lineId),
      ))
      .returning({ id: schema.disaggregationDocumentLines.id });
    if (removed.length === 0) throw new NotFoundException();
    await this.touch(tenantId, documentId);
  }

  private async touch(tenantId: string, documentId: string): Promise<void> {
    await this.db
      .update(schema.disaggregationDocuments)
      .set({ updatedAt: sql`now()` })
      .where(and(
        eq(schema.disaggregationDocuments.tenantId, tenantId),
        eq(schema.disaggregationDocuments.id, documentId),
      ));
  }
```

Controller additions:

```ts
  @Post(":id/lines")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  addLines(
    @Req() req: RequestWithTenant,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(addLinesSchema)) body: AddLinesDto,
  ) {
    return this.service.addLines(req.tenantId!, id, body.ssccs);
  }

  @Delete(":id/lines/:lineId")
  @HttpCode(204)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  removeLine(
    @Req() req: RequestWithTenant,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("lineId", new ParseUUIDPipe()) lineId: string,
  ) {
    return this.service.removeLine(req.tenantId!, id, lineId);
  }
```

- [ ] **Step 5: Run to verify it passes** (`pnpm --filter @markiro/api test -- disaggregation-lines`).

- [ ] **Step 6: Commit** — `git commit -am "feat(api): disaggregation lines with validation"`.

---

### Task 5: API — file import

**Files:**
- Create: `apps/api/src/modules/disaggregation/import-parser.ts`
- Modify: `apps/api/src/modules/disaggregation/disaggregation.controller.ts`
- Modify: `apps/api/src/modules/disaggregation/disaggregation.service.ts` (one-line `source` update)
- Test: `apps/api/test/disaggregation-import.test.ts` (unit), extend `apps/api/test/disaggregation-lines.e2e.test.ts`

**Interfaces:**
- Consumes: Task 4's `addLines`.
- Produces: `POST /disaggregation/:id/import` — multipart field `file` (`.txt`/`.csv`, ≤1 MB), → `{ lines: LineDto[] }`; sets document `source = "import"`. `parseSsccImport(text: string): string[]` — raw tokens split on newlines/`;`/`,`, trimmed, empties dropped, capped at 10 000 (throws `BadRequestException` with `{ code: "too_many_lines" }` above the cap).

- [ ] **Step 1: Write the failing unit test** — `apps/api/test/disaggregation-import.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseSsccImport } from "../src/modules/disaggregation/import-parser";

describe("parseSsccImport", () => {
  it("splits on newlines, semicolons and commas; trims; drops empties", () => {
    expect(parseSsccImport("123;456\n789,abc\r\n\n  042  \n")).toEqual([
      "123", "456", "789", "abc", "042",
    ]);
  });
  it("keeps duplicates (dedup is the document's job, visible as duplicate lines)", () => {
    expect(parseSsccImport("1\n1")).toEqual(["1", "1"]);
  });
  it("throws over 10000 tokens", () => {
    expect(() => parseSsccImport(Array(10001).fill("1").join("\n"))).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails** (`pnpm --filter @markiro/api test -- disaggregation-import`).

- [ ] **Step 3: Implement `import-parser.ts`:**

```ts
import { BadRequestException } from "@nestjs/common";

export const MAX_IMPORT_LINES = 10_000;

/** Digits-and-separators text → raw tokens. Encoding-agnostic on purpose. */
export function parseSsccImport(text: string): string[] {
  const tokens = text
    .split(/[\r\n;,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length > MAX_IMPORT_LINES) {
    throw new BadRequestException({ code: "too_many_lines", max: MAX_IMPORT_LINES });
  }
  return tokens;
}
```

- [ ] **Step 4: Run unit test — PASS.**

- [ ] **Step 5: Add the endpoint.** Controller (multipart pattern from `apps/api/src/modules/products/products.controller.ts:112-141`):

```ts
  @Post(":id/import")
  @HttpCode(201)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @UseInterceptors(
    FileInterceptor("file", { storage: memoryStorage(), limits: { fileSize: 1024 * 1024, files: 1 } }),
  )
  @ApiConsumes("multipart/form-data")
  async importLines(
    @Req() req: RequestWithTenant,
    @Param("id", new ParseUUIDPipe()) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new BadRequestException({ code: "file_required" });
    const tokens = parseSsccImport(file.buffer.toString("utf8"));
    if (tokens.length === 0) throw new BadRequestException({ code: "file_empty" });
    return this.service.importLines(req.tenantId!, id, tokens);
  }
```

Service — `importLines` delegates to `addLines` in ≤500-token chunks (the `addLinesSchema` cap is a request-body concern; import bypasses zod, so chunk purely to bound each insert), then stamps the source:

```ts
  async importLines(tenantId: string, documentId: string, tokens: string[]) {
    for (let i = 0; i < tokens.length; i += 500) {
      await this.addLines(tenantId, documentId, tokens.slice(i, i + 500));
    }
    await this.db
      .update(schema.disaggregationDocuments)
      .set({ source: "import", updatedAt: sql`now()` })
      .where(and(
        eq(schema.disaggregationDocuments.tenantId, tenantId),
        eq(schema.disaggregationDocuments.id, documentId),
      ));
    return { lines: await this.listLines(tenantId, documentId) };
  }
```

- [ ] **Step 6: Extend the e2e** (`disaggregation-lines.e2e.test.ts`):

```ts
  it("imports a text file of SSCCs", async () => {
    const doc = await createDraft();
    const res = await agent
      .post(`/disaggregation/${doc.id}/import`)
      .attach("file", Buffer.from(`${SSCC1}\ngarbage;${SSCC1}`), "codes.txt")
      .expect(201);
    const lines = (res.body as { lines: LineDtoWire[] }).lines;
    expect(lines.map((l) => l.status).sort()).toEqual(["duplicate", "not_found", "ok"].sort());
    const detail = await agent.get(`/disaggregation/${doc.id}`).expect(200);
    expect((detail.body as { source: string }).source).toBe("import");
  });
```

- [ ] **Step 7: Run e2e — PASS. Commit** — `git commit -am "feat(api): disaggregation file import"`.

---

### Task 6: API — apply (провести)

**Files:**
- Modify: `apps/api/src/modules/disaggregation/disaggregation.service.ts`
- Modify: `apps/api/src/modules/disaggregation/disaggregation.controller.ts`
- Test: `apps/api/test/disaggregation-apply.e2e.test.ts`

**Interfaces:**
- Consumes: `validateBoxCandidates` (Task 4), `lockTenantBoxRegistry` from `apps/api/src/modules/boxes/box-registry-lock.ts`, `advanceBoxRegistryVersion` from `apps/api/src/modules/boxes/box-registry-version.ts`, `schema.tenantAuditEvents`.
- Produces: `POST /disaggregation/:id/apply` → 200 `DocumentDetailDto` on success; 409 `{ code: "invalid_lines", lines: LineDto[] }` when any line is non-`ok` (line statuses persisted, document stays draft); 409 `{ code: "reason_required" }` / `{ code: "no_lines" }` / `{ code: "not_draft" }`.

- [ ] **Step 1: Write the failing e2e test.** `apps/api/test/disaggregation-apply.e2e.test.ts`, fixture as Task 4 (scan 2 codes into a box, close the box via the batch closure, close the shift):

```ts
  it("applies: boxes disassembled, items removed, exception + registry bump, doc applied", async () => {
    const doc = await draftWithReasonAndLine(SSCC1); // helper: create reason, draft, PATCH reason, add line (status ok)
    const applied = await agent.post(`/disaggregation/${doc.id}/apply`).expect(200);
    expect((applied.body as { status: string }).status).toBe("applied");
    expect((applied.body as { appliedAt: string }).appliedAt).toBeTruthy();

    // The box surfaces as disassembled on the existing per-shift endpoint.
    const boxes = await agent.get(`/boxes?shiftId=${shiftId}`).expect(200);
    const box = (boxes.body as { items: { sscc: string | null; itemCount: number; disassembledAt: string | null }[] })
      .items.find((b) => b.sscc?.endsWith(SSCC1));
    expect(box?.disassembledAt).toBeTruthy();
    expect(box?.itemCount).toBe(0); // active items removed

    // Audit continuity: a disassemble exception exists for the shift.
    const exceptions = await agent.get(`/box-exceptions?shiftId=${shiftId}`).expect(200);
    const kinds = (exceptions.body as { items: { kind: string }[] }).items.map((e) => e.kind);
    expect(kinds).toContain("disassemble");
  });

  it("apply is all-or-nothing: a written_off line blocks and re-marks", async () => {
    // Fixture: two boxes; lock box 2's code via a kiosk pickup order
    // (POST /kiosk/orders with the kiosk device fixture — copy the order
    // fixture from apps/api/test/box-order-resolver-adjacent e2e, i.e. the
    // pickup-orders e2e's kiosk setup) AFTER the draft validated it as ok.
    const doc = await draftWithReasonAndLines([SSCC1, SSCC2]);
    await lockBoxViaKioskOrder(SSCC2);
    const res = await agent.post(`/disaggregation/${doc.id}/apply`).expect(409);
    expect((res.body as { code: string }).code).toBe("invalid_lines");
    const detail = await agent.get(`/disaggregation/${doc.id}`).expect(200);
    const body = detail.body as { status: string; lines: { sscc: string; status: string }[] };
    expect(body.status).toBe("draft"); // nothing applied
    expect(body.lines.find((l) => l.sscc.endsWith(SSCC2))?.status).toBe("written_off");
    // Box 1 untouched:
    const boxes = await agent.get(`/boxes?shiftId=${shiftId}`).expect(200);
    expect(
      (boxes.body as { items: { sscc: string | null; disassembledAt: string | null }[] })
        .items.find((b) => b.sscc?.endsWith(SSCC1))?.disassembledAt,
    ).toBeNull();
  });

  it("refuses apply without a reason / without lines / twice", async () => {
    const noReason = await createDraftWithLine(SSCC1);
    expect(((await agent.post(`/disaggregation/${noReason.id}/apply`).expect(409)).body as { code: string }).code).toBe("reason_required");
    const empty = await createDraftWithReason();
    expect(((await agent.post(`/disaggregation/${empty.id}/apply`).expect(409)).body as { code: string }).code).toBe("no_lines");
    const doc = await draftWithReasonAndLine(SSCC1);
    await agent.post(`/disaggregation/${doc.id}/apply`).expect(200);
    await agent.post(`/disaggregation/${doc.id}/apply`).expect(409); // not_draft
  });
```

If building the kiosk-order fixture proves disproportionate, an acceptable substitute for the race test is: disassemble the box via a second document between draft and apply, and assert the line re-marks `already_disassembled` — same code path (`revalidate inside apply`), simpler fixture. Prefer the kiosk fixture if the pickup-orders e2e helpers copy over cleanly.

- [ ] **Step 2: Run to verify it fails** (`pnpm --filter @markiro/api test -- disaggregation-apply`).

- [ ] **Step 3: Implement `applyDocument` in the service:**

```ts
  async applyDocument(tenantId: string, documentId: string, userId: string): Promise<DocumentDetailDto> {
    await this.db.transaction(async (tx) => {
      // Same lock root every station batch / kiosk mutation takes first.
      await lockTenantBoxRegistry(tx, tenantId);

      const [doc] = await tx
        .select()
        .from(schema.disaggregationDocuments)
        .where(and(
          eq(schema.disaggregationDocuments.tenantId, tenantId),
          eq(schema.disaggregationDocuments.id, documentId),
        ))
        .for("update");
      if (!doc) throw new NotFoundException();
      this.assertDraft(doc);
      if (!doc.reasonId) throw new ConflictException({ code: "reason_required" });

      const lines = await tx
        .select()
        .from(schema.disaggregationDocumentLines)
        .where(and(
          eq(schema.disaggregationDocumentLines.tenantId, tenantId),
          eq(schema.disaggregationDocumentLines.documentId, documentId),
        ));
      if (lines.length === 0) throw new ConflictException({ code: "no_lines" });

      // Re-validate everything under the lock.
      const ssccs = lines.map((l) => l.sscc).filter((s): s is string => s !== null);
      const candidates = await validateBoxCandidates(tx, tenantId, ssccs);
      let allOk = true;
      for (const line of lines) {
        const fresh = line.sscc === null
          ? line.status // not_found / duplicate rows keep their status
          : (candidates.get(line.sscc)?.status ?? "not_found");
        if (fresh !== line.status || line.sscc !== null) {
          await tx
            .update(schema.disaggregationDocumentLines)
            .set({
              status: fresh,
              validatedAt: sql`now()`,
              boxId: line.sscc !== null ? (candidates.get(line.sscc)?.boxId ?? null) : line.boxId,
              codeCount: line.sscc !== null ? (candidates.get(line.sscc)?.codeCount ?? 0) : line.codeCount,
            })
            .where(and(
              eq(schema.disaggregationDocumentLines.tenantId, tenantId),
              eq(schema.disaggregationDocumentLines.id, line.id),
            ));
        }
        if (fresh !== "ok") allOk = false;
      }
      if (!allOk) throw new ConflictException({ code: "invalid_lines" });

      const [reason] = await tx
        .select({ name: schema.disaggregationReasons.name })
        .from(schema.disaggregationReasons)
        .where(and(
          eq(schema.disaggregationReasons.tenantId, tenantId),
          eq(schema.disaggregationReasons.id, doc.reasonId),
        ));
      const reasonText = doc.comment ? `${reason!.name}: ${doc.comment}` : reason!.name;

      const boxIds = ssccs.map((s) => candidates.get(s)!.boxId);
      const boxRows = await tx
        .select({
          id: schema.boxes.id,
          shiftId: schema.boxes.shiftId,
          terminalId: schema.boxes.terminalId,
        })
        .from(schema.boxes)
        .where(and(eq(schema.boxes.tenantId, tenantId), inArray(schema.boxes.id, boxIds)));

      // Same mechanics as the station's "disassemble" branch
      // (station-scans.service.ts): retire the box, release its live items.
      await tx
        .update(schema.boxes)
        .set({ disassembledAt: sql`now()` })
        .where(and(eq(schema.boxes.tenantId, tenantId), inArray(schema.boxes.id, boxIds)));
      await tx
        .update(schema.boxItems)
        .set({ removedAt: sql`now()` })
        .where(and(
          eq(schema.boxItems.tenantId, tenantId),
          inArray(schema.boxItems.boxId, boxIds),
          isNull(schema.boxItems.displacedAt),
          isNull(schema.boxItems.removedAt),
        ));
      await tx.insert(schema.boxExceptions).values(
        boxRows.map((box) => ({
          tenantId,
          kind: "disassemble" as const,
          boxId: box.id,
          shiftId: box.shiftId,
          terminalId: box.terminalId,
          operatorId: null, // admin action; the actor is on the document + audit event
          reason: reasonText.slice(0, 500),
          occurredAt: new Date(),
          disaggregationDocumentId: documentId,
        })),
      );
      await advanceBoxRegistryVersion(tx, tenantId, boxIds);

      await tx
        .update(schema.disaggregationDocuments)
        .set({
          status: "applied",
          appliedAt: sql`now()`,
          appliedByUserId: userId,
          updatedAt: sql`now()`,
        })
        .where(and(
          eq(schema.disaggregationDocuments.tenantId, tenantId),
          eq(schema.disaggregationDocuments.id, documentId),
        ));
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId: userId,
        action: "disaggregation.document.applied",
        outcome: "success",
        targetType: "disaggregation_document",
        targetId: documentId,
        after: { boxIds },
      });
    });
    return this.getDocument(tenantId, documentId);
  }
```

Important: the `ConflictException({ code: "invalid_lines" })` throw ROLLS BACK the line-status updates made in the same transaction — the fresh statuses must survive. Restructure: run the re-validation + line updates in a FIRST transaction (still under `lockTenantBoxRegistry`), and only when `allOk` continue in that same transaction with the mutations. Concretely: do NOT throw inside `tx` for `invalid_lines`; instead set a flag, let the transaction COMMIT (persisting fresh statuses), and throw the `ConflictException` after commit. Only `reason_required`/`no_lines`/`not_draft`/`NotFound` may throw inside (nothing to persist). Check the invalid-lines e2e asserts the persisted `written_off` status — that test is what proves this ordering is right.

Controller:

```ts
  @Post(":id/apply")
  @HttpCode(200)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  apply(@Req() req: RequestWithTenant, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.service.applyDocument(req.tenantId!, id, req.userId!);
  }
```

Also update the 409 payload for `invalid_lines` to include the refreshed lines: `throw new ConflictException({ code: "invalid_lines", lines: await this.listLines(tenantId, documentId) })` (after commit).

- [ ] **Step 4: Run e2e — PASS** (`pnpm --filter @markiro/api test -- disaggregation-apply`).

- [ ] **Step 5: Run the full API suite to catch regressions** — `pnpm --filter @markiro/api test`. Expected: PASS.

- [ ] **Step 6: Commit** — `git commit -am "feat(api): disaggregation apply with revalidation under registry lock"`.

---

### Task 7: API — `code-search` module (classify, registry listing)

**Files:**
- Create: `apps/api/src/modules/code-search/dto.ts`
- Create: `apps/api/src/modules/code-search/input-classifier.ts`
- Create: `apps/api/src/modules/code-search/code-search.service.ts`
- Create: `apps/api/src/modules/code-search/code-search.controller.ts`
- Create: `apps/api/src/modules/code-search/code-search.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/code-search-classifier.test.ts`, `apps/api/test/code-search.e2e.test.ts`

**Interfaces:**
- Consumes: `parseScannedSscc`, `canonicalizeKm`, `kmHash` from `@markiro/domain`; schema tables.
- Produces (read-only, `OPERATIONS_READ`):
  - `GET /code-search?q=` → 200 `{ type: "box", boxId: string } | { type: "code", codeHash: string }`; 404 `{ code: "unrecognized" | "not_found" }`
  - `GET /code-search/codes?page=&from=&to=&productId=&status=&shiftId=` → `{ items: CodeListItemDto[]; page; pageCount; total }`
    ```ts
    export type CodeStatus = "free" | "aggregated" | "written_off";
    export interface CodeListItemDto {
      codeHash: string; gtin14: string; serial: string;
      productId: string | null; productName: string | null;
      status: CodeStatus; scannedAt: Date;
      boxId: string | null; boxSscc: string | null; // AI form
    }
    ```
  - `classifySearchInput(q: string): { kind: "sscc"; sscc: string } | { kind: "km"; codeHash: string } | { kind: "unrecognized" }` (pure, in `input-classifier.ts`)
  - Task 7b (next task) adds the card endpoints to this same module.

- [ ] **Step 1: Write the failing classifier unit test** — `apps/api/test/code-search-classifier.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canonicalizeKm, kmHash } from "@markiro/domain";
import { classifySearchInput } from "../src/modules/code-search/input-classifier";

const SSCC = "046038488400000015"; // any 18-digit with a valid check digit — reuse a fixture SSCC from station tests
const KM = "0104006381333931" + "21S-abc";

describe("classifySearchInput", () => {
  it("classifies bare 18-digit SSCC", () => {
    expect(classifySearchInput(SSCC)).toEqual({ kind: "sscc", sscc: SSCC });
  });
  it("classifies 20-digit 00-prefixed and (00) HRI forms", () => {
    expect(classifySearchInput(`00${SSCC}`)).toEqual({ kind: "sscc", sscc: SSCC });
    expect(classifySearchInput(`(00)${SSCC}`)).toEqual({ kind: "sscc", sscc: SSCC });
    expect(classifySearchInput(` (00) ${SSCC} `)).toEqual({ kind: "sscc", sscc: SSCC });
  });
  it("classifies a KM to its hash", () => {
    expect(classifySearchInput(KM)).toEqual({ kind: "km", codeHash: kmHash(canonicalizeKm(KM)) });
  });
  it("rejects garbage", () => {
    expect(classifySearchInput("hello")).toEqual({ kind: "unrecognized" });
    expect(classifySearchInput("")).toEqual({ kind: "unrecognized" });
  });
});
```

(Pick the SSCC constant by copying a known-valid one from an existing e2e fixture; verify with `isValidSscc` in the test if unsure.)

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @markiro/api test -- code-search-classifier`

- [ ] **Step 3: Implement `input-classifier.ts`:**

```ts
import { canonicalizeKm, kmHash, parseScannedSscc } from "@markiro/domain";

export type SearchClassification =
  | { kind: "sscc"; sscc: string }
  | { kind: "km"; codeHash: string }
  | { kind: "unrecognized" };

/** SSCC first (cheap, unambiguous), then KM canonicalization; garbage → unrecognized. */
export function classifySearchInput(q: string): SearchClassification {
  const trimmed = q.trim().replace(/^\(00\)\s*/, "(00)");
  const sscc = parseScannedSscc(trimmed.replace(/\s+/g, ""));
  if (sscc !== null) return { kind: "sscc", sscc };
  try {
    return { kind: "km", codeHash: kmHash(canonicalizeKm(q)) };
  } catch {
    return { kind: "unrecognized" };
  }
}
```

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Write the failing e2e** — `apps/api/test/code-search.e2e.test.ts` (station fixture as Task 4: product, shift, 2 codes in a closed box, shift closed):

```ts
  it("classifies and finds a box by SSCC and a code by KM", async () => {
    const byBox = await agent.get(`/code-search?q=(00)${SSCC1}`).expect(200);
    expect((byBox.body as { type: string }).type).toBe("box");
    const byCode = await agent.get(`/code-search?q=${encodeURIComponent(KM1)}`).expect(200);
    expect(byCode.body as object).toEqual({ type: "code", codeHash: codeHashFor("aa") });
  });

  it("404s with reason codes", async () => {
    expect(((await agent.get(`/code-search?q=zzz`).expect(404)).body as { code: string }).code).toBe("unrecognized");
    const missing = "0104006381333931" + "21S-nope";
    expect(((await agent.get(`/code-search?q=${encodeURIComponent(missing)}`).expect(404)).body as { code: string }).code).toBe("not_found");
  });

  it("lists the code registry with derived statuses and filters", async () => {
    const all = await agent.get(`/code-search/codes`).expect(200);
    const items = (all.body as { items: { codeHash: string; status: string }[] }).items;
    expect(items.find((i) => i.codeHash === codeHashFor("aa"))?.status).toBe("aggregated");
    const filtered = await agent.get(`/code-search/codes?status=free`).expect(200);
    expect((filtered.body as { items: { codeHash: string }[] }).items.map((i) => i.codeHash)).not.toContain(codeHashFor("aa"));
  });
```

- [ ] **Step 6: Run to verify it fails, then implement.** Service core:

```ts
  async classify(tenantId: string, q: string) {
    const classified = classifySearchInput(q);
    if (classified.kind === "unrecognized") {
      throw new NotFoundException({ code: "unrecognized" });
    }
    if (classified.kind === "sscc") {
      const [box] = await this.db
        .select({ id: schema.boxes.id })
        .from(schema.boxes)
        .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.sscc, classified.sscc)));
      if (!box) throw new NotFoundException({ code: "not_found" });
      return { type: "box" as const, boxId: box.id };
    }
    const [code] = await this.db
      .select({ codeHash: schema.codeRegistry.codeHash })
      .from(schema.codeRegistry)
      .where(and(
        eq(schema.codeRegistry.tenantId, tenantId),
        eq(schema.codeRegistry.codeHash, classified.codeHash),
      ));
    if (!code) throw new NotFoundException({ code: "not_found" });
    return { type: "code" as const, codeHash: code.codeHash };
  }
```

Registry listing — one query over `code_registry` ⋈ `codes` with derived status; `activeBoxItems`/`writtenOff` as SQL fragments:

```ts
  private readonly aggregatedSql = sql<boolean>`exists (
    select 1 from ${schema.boxItems} bi
    join ${schema.boxes} b on b.tenant_id = bi.tenant_id and b.id = bi.box_id
    where bi.tenant_id = ${schema.codeRegistry.tenantId}
      and bi.code_hash = ${schema.codeRegistry.codeHash}
      and bi.displaced_at is null and bi.removed_at is null
      and b.disassembled_at is null)`;

  private readonly writtenOffSql = sql<boolean>`exists (
    select 1 from ${schema.pickupOrderItems} poi
    where poi.tenant_id = ${schema.codes.tenantId}
      and poi.voided = false
      and poi.km_key = '01' || ${schema.codes.gtin14} || '21' || ${schema.codes.serial})`;

  async listCodes(tenantId: string, query: ListCodesQueryDto) {
    const statusSql = sql<string>`case
      when ${this.writtenOffSql} then 'written_off'
      when ${this.aggregatedSql} then 'aggregated'
      else 'free' end`;
    const where = and(
      eq(schema.codeRegistry.tenantId, tenantId),
      query.shiftId ? eq(schema.codeRegistry.shiftId, query.shiftId) : undefined,
      query.from ? gte(schema.codeRegistry.scannedAt, query.from) : undefined,
      query.to ? lte(schema.codeRegistry.scannedAt, query.to) : undefined,
      query.productId ? eq(schema.products.id, query.productId) : undefined,
      query.status ? sql`(${statusSql}) = ${query.status}` : undefined,
    );
    // FROM code_registry
    //   JOIN codes ON (tenant_id, code_hash, scanned_at)  -- owner scan row
    //   LEFT JOIN products ON (tenant_id, gtin14)
    //   LEFT JOIN LATERAL current box (active box_items row, non-disassembled box)
    // ORDER BY code_registry.scanned_at DESC, code_hash LIMIT 50 OFFSET ...
    // plus a COUNT(*) twin query for total. Implementation mirrors
    // BoxesService.listBoxes's join style; box sscc via formatSsccWithAi.
  }
```

Write the listing exactly as sketched (the `codes` join uses all three PK columns so Postgres prunes partitions: `eq(schema.codes.tenantId, schema.codeRegistry.tenantId)`, `eq(schema.codes.codeHash, schema.codeRegistry.codeHash)`, `eq(schema.codes.scannedAt, schema.codeRegistry.scannedAt)`). Query DTO:

```ts
export const listCodesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  productId: z.string().uuid().optional(),
  shiftId: z.string().uuid().optional(),
  status: z.enum(["free", "aggregated", "written_off"]).optional(),
});
```

Controller: `@Controller("code-search")`, read-only, all routes `@RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)`; `GET /` (classify, query param `q` validated `z.object({ q: z.string().trim().min(1).max(1024) })`), `GET /codes`. Register `CodeSearchModule` in `app.module.ts`.

- [ ] **Step 7: Run e2e — PASS** (`pnpm --filter @markiro/api test -- code-search`).

- [ ] **Step 8: Commit** — `git add apps/api && git commit -m "feat(api): code search classify + code registry listing"`.

---

### Task 8: API — code card & box card endpoints

**Files:**
- Modify: `apps/api/src/modules/code-search/dto.ts`, `code-search.service.ts`, `code-search.controller.ts`
- Test: extend `apps/api/test/code-search.e2e.test.ts`

**Interfaces:**
- Consumes: Task 7 module.
- Produces:
  - `GET /code-search/codes/:codeHash` → `CodeCardDto`; 404 when the hash is unknown to `code_registry`.
  - `GET /code-search/boxes/:boxId` → `BoxCardDto`; 404 unknown.
    ```ts
    export type CodeHistoryEvent =
      | { type: "scanned"; at: Date; verdict: string; shiftId: string; terminalId: string | null; operatorId: string | null }
      | { type: "box_added"; at: Date; boxId: string; boxSscc: string | null }
      | { type: "box_displaced"; at: Date; boxId: string; boxSscc: string | null }
      | { type: "box_removed"; at: Date; boxId: string; boxSscc: string | null }
      | { type: "box_disassembled"; at: Date; boxId: string; boxSscc: string | null; reason: string | null; disaggregationDocumentId: string | null; disaggregationDocNo: string | null }
      | { type: "pickup_locked"; at: Date; orderId: string; orderNo: string }
      | { type: "pickup_resolved"; at: Date; orderId: string; orderNo: string; orderStatus: "punched" | "writtenoff" | "cancelled" };
    export interface CodeCardDto {
      codeHash: string; gtin14: string; serial: string;
      productId: string | null; productName: string | null;
      status: CodeStatus;
      currentBox: { id: string; sscc: string | null } | null;
      history: CodeHistoryEvent[]; // ascending by `at`
    }
    export interface BoxCardItemDto {
      codeHash: string; gtin14: string | null; serial: string | null;
      addedAt: Date; displacedAt: Date | null; removedAt: Date | null;
    }
    export interface BoxCardDto {
      id: string; sscc: string | null; status: "open" | "closed" | "disassembled";
      shiftId: string; productId: string | null; productName: string | null;
      terminalId: string | null; operatorId: string | null;
      openedAt: Date; closedAt: Date | null; disassembledAt: Date | null;
      items: BoxCardItemDto[];
      exceptions: { kind: string; reason: string | null; occurredAt: Date; operatorId: string | null; disaggregationDocumentId: string | null; disaggregationDocNo: string | null }[];
      pickupOrders: { orderId: string; orderNo: string; status: string }[];
    }
    ```

- [ ] **Step 1: Extend the failing e2e:**

```ts
  it("code card: derived status, current box, ordered history", async () => {
    const res = await agent.get(`/code-search/codes/${codeHashFor("aa")}`).expect(200);
    const card = res.body as { status: string; currentBox: { sscc: string } | null; history: { type: string }[] };
    expect(card.status).toBe("aggregated");
    expect(card.currentBox?.sscc).toContain(SSCC1);
    expect(card.history[0]!.type).toBe("scanned");
    expect(card.history.map((h) => h.type)).toContain("box_added");
  });

  it("box card: composition with dimmed removed rows + exceptions", async () => {
    const box = (await agent.get(`/code-search?q=${SSCC1}`).expect(200)).body as { boxId: string };
    const res = await agent.get(`/code-search/boxes/${box.boxId}`).expect(200);
    const card = res.body as { status: string; items: { codeHash: string }[] };
    expect(card.status).toBe("closed");
    expect(card.items).toHaveLength(2);
  });

  it("history shows disaggregation after a document applies", async () => {
    // apply a document over SSCC1 (reuse Task 6's helper), then:
    const res = await agent.get(`/code-search/codes/${codeHashFor("aa")}`).expect(200);
    const card = res.body as { status: string; history: { type: string; disaggregationDocNo?: string }[] };
    expect(card.status).toBe("free");
    const dis = card.history.find((h) => h.type === "box_disassembled");
    expect(dis?.disaggregationDocNo).toMatch(/^DSG-/);
  });
```

- [ ] **Step 2: Run to verify it fails, then implement.** History assembly is several small queries merged and sorted in TS (readable beats one SQL union at card scale):

1. `scan_events` where `raw`'s hash matches — `scan_events` stores raw text, not hashes, so instead select events via `codes`: fetch the code's `(gtin14, serial, canonicalRaw)` rows from `codes` by `(tenantId, codeHash)`, then `scan_events` where `eq(scanEvents.tenantId) AND eq(scanEvents.raw, canonicalRaw)` per distinct raw (bounded: a handful of rows). Map verdict/shift/terminal/operator → `scanned` events.
2. `box_items` rows for the hash (all boxes, including displaced/removed) joined to `boxes` for sscc → `box_added` (at=addedAt) + `box_displaced` (at=displacedAt, when set) + `box_removed` (at=removedAt, when set).
3. `box_exceptions` for those boxIds with `kind = 'disassemble'` joined (left) to `disaggregationDocuments` for docNo → `box_disassembled`.
4. `pickup_order_items` on the reconstructed kmKey (`'01' || gtin14 || '21' || serial` for each distinct gtin/serial of the code) joined to `pickup_orders` → `pickup_locked` (at=item.scannedAt) and, when `resolvedAt` set or status=cancelled, `pickup_resolved` (at=resolvedAt ?? createdAt).

Sort ascending by `at`. `status` and `currentBox` reuse Task 7's `aggregatedSql`/`writtenOffSql` fragments via a single-row variant. Box card: one query for the box (+shift join for productId, products for name), one for items (LEFT JOIN codes for gtin/serial), one for exceptions (LEFT JOIN disaggregationDocuments), one for `pickup_order_boxes` ⋈ `pickup_orders`. `status` derived: `disassembledAt ? "disassembled" : closedAt ? "closed" : "open"`.

Controller additions: `@Get("codes/:codeHash")` (validate `codeHash` with `z.string().regex(/^[0-9a-f]{64}$/)` via a pipe or manual check → 404 on mismatch) and `@Get("boxes/:boxId", ParseUUIDPipe)`.

Route-ordering note: NestJS matches in declaration order — declare `@Get("codes")` (listing) BEFORE `@Get("codes/:codeHash")` is not required (different path depth), but `@Get()` (classify) must not swallow `/codes`; with distinct literal segments this is safe as written.

- [ ] **Step 3: Run e2e — PASS. Run full API suite** (`pnpm --filter @markiro/api test`). Expected: PASS.

- [ ] **Step 4: Commit** — `git commit -am "feat(api): code and box cards with movement history"`.

---

### Task 9: Admin — Disaggregation list page + reasons page + nav/routes

**Files:**
- Create: `apps/admin/src/pages/disaggregation/api.ts`
- Create: `apps/admin/src/pages/disaggregation/index.tsx`
- Create: `apps/admin/src/pages/disaggregation/ReasonsPage.tsx`
- Modify: `apps/admin/src/app.tsx` (routes), `apps/admin/src/layout/AppShell.tsx` (NAV_ITEMS)
- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json`
- Test: `apps/admin/test/disaggregation.test.tsx`

**Interfaces:**
- Consumes: Tasks 3–6 endpoints; `apiFetch` from `apps/admin/src/api/client.ts`.
- Produces: routes `/disaggregation`, `/disaggregation/reasons`; hooks in `api.ts` that Task 10 reuses:
  ```ts
  export interface LineDto { id: string; ssccInput: string; sscc: string | null; boxId: string | null; status: string; productId: string | null; productName: string | null; codeCount: number; validatedAt: string }
  export interface DocumentDto { id: string; docNo: string; status: "draft" | "applied" | "cancelled"; reasonId: string | null; reasonName: string | null; comment: string | null; source: "manual" | "import"; lineCount: number; codeCount: number; createdByUserId: string; createdAt: string; appliedAt: string | null; appliedByUserId: string | null; cancelledAt: string | null }
  export interface DocumentDetailDto extends DocumentDto { lines: LineDto[] }
  export const DISAGGREGATION_QUERY_KEY = ["disaggregation"] as const;
  export function useDocuments(filters: { status?: string; reasonId?: string; page: number }): UseQueryResult<{ items: DocumentDto[]; page: number; pageCount: number; total: number }>
  export function useDocument(id: string | undefined): UseQueryResult<DocumentDetailDto>
  export function useCreateDocument(): UseMutationResult<DocumentDto, Error, void>
  export function useUpdateDocument(id: string): UseMutationResult<DocumentDto, Error, { reasonId?: string | null; comment?: string | null }>
  export function useAddLines(id: string): UseMutationResult<{ lines: LineDto[] }, Error, string[]>
  export function useImportLines(id: string): UseMutationResult<{ lines: LineDto[] }, Error, File>
  export function useRemoveLine(id: string): UseMutationResult<void, Error, string>
  export function useApplyDocument(id: string): UseMutationResult<DocumentDetailDto, Error, void>
  export function useCancelDocument(id: string): UseMutationResult<DocumentDto, Error, void>
  export function useDisaggregationReasons(): UseQueryResult<{ id: string; name: string; sortOrder: number }[]>
  ```
  All mutations invalidate `DISAGGREGATION_QUERY_KEY` via `useQueryClient` (pattern: `apps/admin/src/pages/catalog/api.ts`). `useImportLines` builds `FormData` (`form.append("file", file)`) and calls `apiFetch` with `{ method: "POST", body: form }`.

- [ ] **Step 1: Write the failing test** — `apps/admin/test/disaggregation.test.tsx` (harness: copy `jsonResponse` + QueryClient wrapper from `apps/admin/test/boxes.test.tsx`; render `<DisaggregationPage />` inside a `createMemoryRouter` since the page navigates):

```tsx
it("renders the document list with status chips", async () => {
  stubFetch({
    "/api/disaggregation": {
      items: [
        { id: "d1", docNo: "DSG-26-0001", status: "draft", reasonId: null, reasonName: null,
          comment: null, source: "manual", lineCount: 2, codeCount: 24,
          createdByUserId: "u1", createdAt: "2026-08-20T08:00:00.000Z",
          appliedAt: null, appliedByUserId: null, cancelledAt: null },
        { id: "d2", docNo: "DSG-26-0002", status: "applied", reasonId: "r1", reasonName: "Брак",
          comment: null, source: "import", lineCount: 1, codeCount: 12,
          createdByUserId: "u1", createdAt: "2026-08-19T08:00:00.000Z",
          appliedAt: "2026-08-19T09:00:00.000Z", appliedByUserId: "u1", cancelledAt: null },
      ],
      page: 1, pageCount: 1, total: 2,
    },
    "/api/disaggregation-reasons": { items: [] },
  });
  renderPage();
  expect(await screen.findByText("DSG-26-0001")).toBeTruthy();
  expect(screen.getByText("DSG-26-0002")).toBeTruthy();
});

it("create button posts a draft and navigates to it", async () => { /* stub POST → {id:"d9",...}, assert router location becomes /disaggregation/d9 */ });
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @markiro/admin test -- disaggregation`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `api.ts`** per the Interfaces block (thin `apiFetch` wrappers; `useDocuments` builds the query string with `URLSearchParams`, dropping empty filters — pattern `apps/admin/src/pages/catalog/api.ts`'s `buildListPath`).

- [ ] **Step 4: Implement `index.tsx`.** Structure (pattern: `apps/admin/src/pages/pickup/index.tsx` list + `apps/admin/src/pages/boxes/index.tsx` layout):

- `PageHeader` title `t("pages.disaggregation.title")` with two header actions: link to `/disaggregation/reasons` (`t("pages.disaggregation.reasonsLink")`) and a primary "create" button (`t("pages.disaggregation.create")`, hidden without `useCan(C.OPERATIONS_WRITE)`) that calls `useCreateDocument().mutate` and on success `navigate(`/disaggregation/${doc.id}`)`.
- Filters row: status `Select` (all/draft/applied/cancelled), reason `Select` from `useDisaggregationReasons()`.
- `Table` columns: `docNo` (mono), `createdAt` (`formatCreatedAt(row.createdAt, i18n.language)`), status → `<StatusChip>` with tone mapping draft→neutral, applied→success, cancelled→muted (match StatusChip's actual tone prop values — read `packages/ui/src/components/StatusChip.tsx` first), `reasonName ?? "—"`, `lineCount`, `codeCount`. `onRowClick={(row) => navigate(`/disaggregation/${row.id}`)}`; `page/pageCount/onPage` wired to the query. Loading/error/empty states exactly as `boxes/index.tsx`.

- [ ] **Step 5: Implement `ReasonsPage.tsx`** as a clone of `apps/admin/src/pages/kiosks/ReasonsPage.tsx` pointed at `/disaggregation-reasons` (same list + add/edit/archive interactions, keys under `pages.disaggregation.reasons.*`).

- [ ] **Step 6: Wire routes + nav + i18n.**

`app.tsx` (inside the ShellPage route, after the `pickup/:id` route):

```tsx
<Route path="disaggregation" element={
  <RequireCapability capability={C.OPERATIONS_READ}><DisaggregationPage /></RequireCapability>
} />
<Route path="disaggregation/reasons" element={
  <RequireCapability capability={C.OPERATIONS_READ}><DisaggregationReasonsPage /></RequireCapability>
} />
<Route path="disaggregation/:id" element={
  <RequireCapability capability={C.OPERATIONS_READ}><DisaggregationDocumentPage /></RequireCapability>
} />
```

(`DisaggregationDocumentPage` lands in Task 10; create a stub component in `apps/admin/src/pages/disaggregation/DocumentDetail.tsx` now — `export function DisaggregationDocumentPage() { return null; }` — so the route compiles, and note Task 10 replaces it.)

`AppShell.tsx` NAV_ITEMS — insert after the `/pickup` entry:

```ts
  { to: "/disaggregation", key: "nav.disaggregation", sectionKey: "shell.sections.production", capability: C.OPERATIONS_READ },
```

i18n — add to BOTH `ru.json` and `en.json`: `nav.disaggregation` (ru: "Дезагрегация", en: "Disaggregation") and the full `pages.disaggregation.*` block used by the pages/tests (title, create, reasonsLink, table.{docNo,createdAt,status,reason,lineCount,codeCount}, status.{draft,applied,cancelled}, filters.*, empty, reasons.* …). Grep the two new pages for every `t("` call and ensure key parity.

- [ ] **Step 7: Run tests — PASS** (`pnpm --filter @markiro/admin test -- disaggregation`), plus the i18n test (`pnpm --filter @markiro/admin test -- i18n`).

- [ ] **Step 8: Commit** — `git add apps/admin && git commit -m "feat(admin): disaggregation document list and reasons pages"`.

---

### Task 10: Admin — Disaggregation document detail page

**Files:**
- Replace stub: `apps/admin/src/pages/disaggregation/DocumentDetail.tsx`
- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json`
- Test: `apps/admin/test/disaggregation-detail.test.tsx`

**Interfaces:**
- Consumes: Task 9's hooks (`useDocument`, `useUpdateDocument`, `useAddLines`, `useImportLines`, `useRemoveLine`, `useApplyDocument`, `useCancelDocument`, `useDisaggregationReasons`).
- Produces: `DisaggregationDocumentPage` at `/disaggregation/:id`.

Page structure (pattern: `apps/admin/src/pages/pickup/OrderDetail.tsx` — `PageHeader` + `DetailField` grid + `Table` + `ConfirmDialog`):

- Header: `PageHeader` title = docNo, `StatusChip` for status. Draft-only editable header block: reason `Select` (options from `useDisaggregationReasons`, onValueChange → `useUpdateDocument`), comment `Textarea` (save on blur via the same mutation). Non-draft: `DetailField`s (reason, comment, createdAt, appliedAt/by or cancelledAt).
- Draft-only add panel: `Textarea` for pasting/scanning SSCCs (split on whitespace/`;`/`,` client-side, button `t("pages.disaggregation.detail.addLines")` → `useAddLines`), plus a file `<input type="file" accept=".txt,.csv">` behind an "Import from file" button → `useImportLines`.
- Lines `Table`: sscc (mono, `formatSsccHri` when parseable, else `ssccInput` verbatim), productName, codeCount, status `StatusChip` (tone: ok→success, everything else→warn/error) with label `t(`pages.disaggregation.lineStatus.${row.status}`)`, delete `RowActions`/button per row (draft only, `useRemoveLine`). Line SSCCs on applied documents link to `/codes/box/${row.boxId}` (Task 12's route — plain `<Link>`, fine to land before the target route exists in this task's tests).
- Footer (draft only): primary "Провести" button — disabled unless `lines.length > 0 && lines.every(l => l.status === "ok") && reasonId`, opens `ConfirmDialog` with `t("pages.disaggregation.detail.applyConfirm", { boxes: lineCount, codes: codeCount })` → `useApplyDocument`. On a 409 `invalid_lines` `ApiRequestError`, show `Alert tone="error"` `t("pages.disaggregation.detail.applyBlocked")` (fresh line statuses arrive via query invalidation). Secondary "Отменить документ" → `ConfirmDialog` → `useCancelDocument`.
- All mutation controls additionally hidden without `useCan(C.OPERATIONS_WRITE)`.

- [ ] **Step 1: Write the failing test** — `apps/admin/test/disaggregation-detail.test.tsx` covering: (a) draft renders lines with per-status chips and an enabled Apply when all-ok+reason; (b) Apply disabled when a line is `written_off` or reason missing; (c) delete line calls `DELETE /api/disaggregation/d1/lines/l1`; (d) applied document renders read-only (no add panel, no Apply). Use the memory-router + fetch-stub harness from Task 9's test.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement the page as specified above.** Add every new i18n key to both dictionaries — including the seven `pages.disaggregation.lineStatus.*` keys (ok: "Готов к проведению"/"Ready", not_found: "Короб не найден"/"Box not found", not_closed: "Короб не закрыт"/"Box not closed", shift_open: "Смена ещё открыта — доступно после закрытия смены"/"Shift still open — available after shift close", already_disassembled: "Уже расформирован"/"Already disassembled", written_off: "Списан/выдан через киоск"/"Written off via kiosk", duplicate: "Дубль в документе"/"Duplicate in document").
- [ ] **Step 4: Run tests — PASS** (`pnpm --filter @markiro/admin test -- disaggregation-detail`, then `-- i18n`).
- [ ] **Step 5: Commit** — `git commit -am "feat(admin): disaggregation document detail with apply flow"`.

---

### Task 11: Admin — Code Search page (exact lookup + code registry)

**Files:**
- Create: `apps/admin/src/pages/code-search/api.ts`
- Create: `apps/admin/src/pages/code-search/index.tsx`
- Modify: `apps/admin/src/app.tsx`, `apps/admin/src/layout/AppShell.tsx`, both i18n dictionaries
- Test: `apps/admin/test/code-search.test.tsx`

**Interfaces:**
- Consumes: Task 7 endpoints.
- Produces: route `/codes`; `api.ts` exports Task 12 reuses:
  ```ts
  export interface CodeListItemDto { codeHash: string; gtin14: string; serial: string; productId: string | null; productName: string | null; status: "free" | "aggregated" | "written_off"; scannedAt: string; boxId: string | null; boxSscc: string | null }
  export const CODE_SEARCH_QUERY_KEY = ["code-search"] as const;
  export async function classifySearch(q: string): Promise<{ type: "box"; boxId: string } | { type: "code"; codeHash: string }> // throws ApiRequestError with .code "unrecognized"|"not_found" on 404
  export function useCodes(filters: { page: number; from?: string; to?: string; productId?: string; status?: string }): UseQueryResult<{ items: CodeListItemDto[]; page: number; pageCount: number; total: number }>
  export function useCodeCard(codeHash: string | undefined): UseQueryResult<CodeCardDto>
  export function useBoxCard(boxId: string | undefined): UseQueryResult<BoxCardDto>
  ```
  (`CodeCardDto`/`BoxCardDto` mirror Task 8's wire shapes with `Date` → `string`.)

Page structure:

- `PageHeader` `t("pages.codeSearch.title")`.
- Search block: one large `Input` (mono) + button. Submit → `classifySearch(q)`; on `{type:"code"}` navigate `/codes/km/${codeHash}`, on `{type:"box"}` navigate `/codes/box/${boxId}`; on `ApiRequestError` show inline `Alert tone="error"` with `t("pages.codeSearch.errors.unrecognized")` or `t("pages.codeSearch.errors.notFound")` keyed off `error.code`.
- Registry section: filter row — two `DatePicker`s (from/to), product `Combobox` (options from the existing `useProducts`/catalog list hook — check `apps/admin/src/pages/catalog/api.ts` for the list hook to reuse), status `Select` (all/free/aggregated/written_off with `t("pages.codeSearch.status.*")` labels). `Table` columns: code (mono `01${gtin14}21${serial}` — render gtin+serial), productName, status `StatusChip` (free→success, aggregated→info/neutral, written_off→muted), box (SSCC via `formatSsccHri`, rendered as `<Link to={`/codes/box/${row.boxId}`}>`), scannedAt. `onRowClick` → `/codes/km/${row.codeHash}`; pagination wired.

- [ ] **Step 1: Write the failing test** — `apps/admin/test/code-search.test.tsx`: (a) registry renders rows from stubbed `/api/code-search/codes` with status chips; (b) submitting an SSCC navigates to `/codes/box/b1` (stub `/api/code-search?q=…` → `{type:"box",boxId:"b1"}`); (c) 404 unrecognized shows the inline alert.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement `api.ts` + `index.tsx`; add route + nav + i18n.** Route in `app.tsx` (before the dynamic siblings):

```tsx
<Route path="codes" element={
  <RequireCapability capability={C.OPERATIONS_READ}><CodeSearchPage /></RequireCapability>
} />
```

NAV_ITEMS — insert after `/boxes`:

```ts
  { to: "/codes", key: "nav.codes", sectionKey: "shell.sections.production", capability: C.OPERATIONS_READ },
```

i18n: `nav.codes` (ru: "Поиск кодов", en: "Code search") + `pages.codeSearch.*` block (title, searchPlaceholder, searchButton, errors.{unrecognized,notFound}, status.{free,aggregated,written_off}, table.*, filters.*, empty).

- [ ] **Step 4: Run tests — PASS** (incl. `-- i18n`).
- [ ] **Step 5: Commit** — `git commit -am "feat(admin): code search page with code registry"`.

---

### Task 12: Admin — code card & box card pages

**Files:**
- Create: `apps/admin/src/pages/code-search/CodeCard.tsx`
- Create: `apps/admin/src/pages/code-search/BoxCard.tsx`
- Modify: `apps/admin/src/app.tsx`, both i18n dictionaries
- Test: `apps/admin/test/code-card.test.tsx`, `apps/admin/test/box-card.test.tsx`

**Interfaces:**
- Consumes: Task 11's `useCodeCard`/`useBoxCard`.
- Produces: routes `/codes/km/:codeHash`, `/codes/box/:boxId`.

**CodeCard** (`useParams().codeHash` → `useCodeCard`):
- `PageHeader` title `t("pages.codeSearch.codeCard.title")`, subtitle mono `01{gtin}21{serial}`.
- `DetailField` grid: product, GTIN, serial, status (`StatusChip`), current box (link `/codes/box/:id`, SSCC in HRI) or "—".
- History timeline: vertical list (styled `div`s with a left border, matching the app's inline-style idiom — no new UI component needed), one row per event: time (`formatCreatedAt`), label `t(`pages.codeSearch.history.${event.type}`)`, contextual link — box events link to the box card, `pickup_*` events link to `/pickup/${orderId}`, `box_disassembled` with `disaggregationDocumentId` links to `/disaggregation/${id}` showing `disaggregationDocNo`.

**BoxCard** (`useParams().boxId` → `useBoxCard`):
- `PageHeader` title = SSCC in HRI (or `t("pages.codeSearch.boxCard.noSscc")`), `StatusChip` open/closed/disassembled.
- `DetailField`s: product, shift (plain id text is acceptable; link if a shift page exists — it doesn't, so text), opened/closed/disassembled timestamps.
- Composition `Table`: code (mono, links `/codes/km/${row.codeHash}`), addedAt, state column — active rows plain; displaced/removed rows rendered with `opacity: 0.5` and a `Badge` `t("pages.codeSearch.boxCard.displaced")` / `…removed")`.
- Events block: exceptions list (kind label, reason, occurredAt, document link when `disaggregationDocumentId`), pickup orders list (orderNo → `/pickup/${orderId}`, status).

- [ ] **Step 1: Write the failing tests** — code card renders status + history rows incl. a `box_disassembled` event linking to `/disaggregation/d1`; box card renders 2 items with one removed row badged, and the disassemble exception with its DSG number.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement both pages; add routes:**

```tsx
<Route path="codes/km/:codeHash" element={
  <RequireCapability capability={C.OPERATIONS_READ}><CodeCardPage /></RequireCapability>
} />
<Route path="codes/box/:boxId" element={
  <RequireCapability capability={C.OPERATIONS_READ}><BoxCardPage /></RequireCapability>
} />
```

i18n: `pages.codeSearch.codeCard.*`, `pages.codeSearch.boxCard.*`, `pages.codeSearch.history.{scanned,box_added,box_displaced,box_removed,box_disassembled,pickup_locked,pickup_resolved}` — both languages.

- [ ] **Step 4: Run tests — PASS** (both new files + `-- i18n`).
- [ ] **Step 5: Commit** — `git commit -am "feat(admin): code and box cards with movement history"`.

---

### Task 13: Full verification sweep

**Files:** none new.

- [ ] **Step 1: Full builds and typechecks**

```bash
pnpm --filter @markiro/db build && pnpm turbo typecheck lint --filter=@markiro/api --filter=@markiro/admin --filter=@markiro/db
```

Expected: PASS. (If `turbo` filters differ in this repo, fall back to `pnpm --filter <pkg> typecheck && pnpm --filter <pkg> lint` per package.)

- [ ] **Step 2: Full test suites**

```bash
pnpm --filter @markiro/api test && pnpm --filter @markiro/admin test && pnpm --filter @markiro/db test
```

Expected: PASS, including `apps/admin/test/i18n.test.tsx`.

- [ ] **Step 3: Manual smoke via dev preview** — start the admin dev server, verify: nav shows "Поиск кодов" and "Дезагрегация"; create a draft → add a bad SSCC → see `not_found`; reasons page CRUD works; `/codes` renders the registry.

- [ ] **Step 4: Commit anything outstanding** — `git status` must be clean; if not, review and commit with an accurate message.

---

## Self-review notes (already applied)

- Spec coverage: schema §1 → Task 1; reasons CRUD → Task 2; document lifecycle → Task 3; lines+validation (7 statuses incl. `shift_open`) → Task 4; import → Task 5; apply all-or-nothing under `box-registry-lock` + `box_exceptions` + registry bump + audit → Task 6; classify + registry listing → Task 7; code/box cards + history → Task 8; admin list/reasons → Task 9; document detail → Task 10; search screen → Task 11; cards → Task 12; edge cases exercised in Tasks 4/6/7 tests.
- The apply 409 persistence subtlety (line statuses must survive the rollback) is called out explicitly in Task 6 Step 3.
- `box_exceptions` FK deliberately omitted (import cycle) — documented in Task 1 Step 2 with in-repo precedent.
