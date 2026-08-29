# Chestny ZNAK Inventory Exports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator press «Заказать из Честного Знака» on an inventory and have the six code-status exports ordered, polled, downloaded and imported automatically, instead of downloading six files from the ЧЗ cabinet and uploading them by hand.

**Architecture:** A new `chz-exports` module orders six `FILTERED_CIS_REPORT` dispenser tasks per inventory over True API, using the Bearer token the signer agent already keeps in `chz_api_tokens`. One pg-boss job advances a whole order — creating missing tasks, polling all six through the batch results endpoint, downloading whatever is ready — and hands each downloaded ZIP to the **existing** `InventoriesService.importEvidence`, so the parser, S3 layout, sha256 idempotency and the six-status snapshot invariant are untouched. Per-status progress lives in one `chz_export_runs` row per (inventory, status).

**Tech Stack:** NestJS 11, Drizzle ORM (Postgres), pg-boss v12, zod 4, React 19 + `@markiro/ui`, vitest.

## Global Constraints

- Monorepo: pnpm + turbo. API tests: `set -a; source .env; set +a` then `pnpm --filter @markiro/api exec vitest run test/<file>`. Never use `git stash` (the stash stack is shared across sessions and worktrees).
- Migration flow (AGENTS.md): `set -a; source .env; set +a` → `db:generate` → rename file **and** its `meta/_journal.json` tag → `build` → `test` → `db:migrate`. Never edit an applied migration. **Next migration number: 0100** (last applied: `0099_chz_product_groups`).
- **The Station is not touched.** `apps/station/**` and `packages/db/src/sqlite/**` must have zero diff.
- Every API surface carries OpenAPI decorators — `apps/api/test/openapi-coverage.test.ts` is a hard gate. Every new customer route must also be registered in `apps/api/test/subscription-route-inventory.test.ts`, which pins guards and subscription policy — a route missing there fails CI.
- i18n keys go in BOTH `apps/admin/src/i18n/ru.json` and `en.json`; the admin test-mode i18n throws on a missing key.
- Repo TS is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; use conditional spreads rather than assigning `undefined`. Local imports in `apps/api/src` and `apps/admin/src` carry **no** `.js` extension; `packages/db` does.
- The repo does not use `@testing-library/jest-dom`; assert against raw DOM properties.
- **Token values, and any header or body containing one, must never reach a log, the integrations journal, or a UI error message.** The journal is the audit trail for this feature and is written under `channelType: "chestny_znak"` via `JournalService.append`.
- True API limits that shape the design: `POST dispenser/tasks` 15 req/min, `GET dispenser/tasks/{id}` **5 req/min**, `GET dispenser/results` 12 req/min, `GET dispenser/results/{id}/file` 12 req/min; ~1000 tasks/day per product group; global 50 rps per participant; `periodicity` accepts only `SINGLE`.
- Commit footer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

---

## Two findings from exploration that change the spec

Both were established by reading the code, and every task below assumes them.

**1. The ZIP does not need unpacking.** The spec's Components section describes the runner as "order → poll → download → unzip → normalise → hand to `importEvidence`". The unzip and normalise steps do not exist: `apps/api/src/modules/inventories/chz-tabular-reader.ts` already supports a `zip` container natively (`ChzContainerKind = "csv" | "zip" | "xlsx"`), and `parseZipCsv` requires the archive to hold **exactly one** `.csv` member — which is precisely the dispenser's output shape. `InventoriesService.importEvidence` picks the container from the file name alone (`private containerKind(filename)`, `inventories.service.ts:808`). So the adapter is one line: name the synthesised file `*.zip` and pass the downloaded bytes through untouched. Anything else would re-implement a parser that already exists.

**2. The durable claim and the bounded-attempt behaviour both have a precedent to copy, not invent.** `apps/api/src/modules/inventories/inventory-document-runner.service.ts` is the same shape of thing: a pg-boss-driven state machine over a `*_runs` table with `claim()`, `refreshLease()`, `publishReady()`, `requeue()`, `publishFailed()`, and an `AttemptContext { retryCount, retryLimit }` threaded from `job.retryCount`/`job.retryLimit` so the runner can tell a retryable failure from a terminal one (`if (attempt.retryCount < attempt.retryLimit)`, line 313). The spec's "task-creation attempt cap" **is** pg-boss's `retryLimit`; do not add a second counter for it. `chz_export_runs.attempts` remains, but only as the operator-visible record of how much quota a status has cost.

---

## File Structure

| File                                                            | Responsibility                                    |
| --------------------------------------------------------------- | ------------------------------------------------- |
| `packages/db/src/schema/chz.ts`                                 | `chzExportRuns` table and its state enum          |
| `packages/db/migrations/0100_chz_export_runs.sql`               | Create the table                                  |
| `apps/api/src/modules/chz-exports/true-api.types.ts`            | Client dependency and result types                |
| `apps/api/src/modules/chz-exports/true-api.client.ts`           | The four dispenser operations                     |
| `apps/api/src/modules/chz-exports/chz-token.service.ts`         | Decrypted token + base URL, or a typed refusal    |
| `apps/api/src/modules/chz-exports/chz-exports.service.ts`       | Pre-flight checks, ordering, progress, retry      |
| `apps/api/src/modules/chz-exports/chz-export-runner.service.ts` | The order state machine driven by the job         |
| `apps/api/src/modules/chz-exports/dto.ts`                       | zod schemas, DTOs, OpenAPI schemas                |
| `apps/api/src/modules/chz-exports/chz-exports.controller.ts`    | Cabinet endpoints                                 |
| `apps/api/src/modules/chz-exports/chz-exports.module.ts`        | Wiring                                            |
| `apps/api/src/jobs/jobs.module.ts`                              | Queue, worker, boot reconcile, `checkReady` count |
| `apps/admin/src/pages/inventory/api.ts`                         | Types, query and mutation hooks                   |
| `apps/admin/src/pages/inventory/InventoryDetailPage.tsx`        | The button and per-status run state               |
| `apps/admin/src/i18n/{ru,en}.json`                              | Copy                                              |

---

### Task 1: The `chz_export_runs` table

**Files:**

- Modify: `packages/db/src/schema/chz.ts`
- Create (generated, then renamed): `packages/db/migrations/0100_chz_export_runs.sql`
- Modify: `packages/db/migrations/meta/_journal.json`
- Test: `packages/db/test/chz-export-runs.test.ts`

**Interfaces:**

- Produces: `chzExportRuns` table and `chzExportRunStateEnum` with values `queued`, `ordered`, `ready`, `imported`, `failed`. Columns: `id` (uuid PK), `tenantId`, `inventoryId` (uuid), `status` (`inventoryChzStatusEnum`), `state`, `dispenserTaskId` (text, null), `resultId` (text, null), `orderedByUserId` (text, FK → `user.id`), `importId` (uuid, null), `errorCode` (text, null), `errorMessage` (text, null), `attempts` (integer, default 0), `claimedAt`, `orderedAt`, `completedAt`, `createdAt`, `updatedAt`. Tasks 4–8 all read these.

- [ ] **Step 1: Write the failing test**

Create `packages/db/test/chz-export-runs.test.ts`, following the metadata-assertion style of the sibling schema tests:

```ts
import { describe, expect, it } from "vitest";

import { chzExportRuns } from "../src/schema/chz.js";

describe("chz export runs schema", () => {
  it("carries the ChZ identifiers, the actor and the failure detail", () => {
    const columns = Object.keys(chzExportRuns);
    expect(columns).toEqual(
      expect.arrayContaining([
        "tenantId",
        "inventoryId",
        "status",
        "state",
        "dispenserTaskId",
        "resultId",
        "orderedByUserId",
        "importId",
        "errorCode",
        "attempts",
        "claimedAt",
      ]),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/db exec vitest run test/chz-export-runs.test.ts`
Expected: FAIL — `chzExportRuns` is not exported.

- [ ] **Step 3: Add the table**

In `packages/db/src/schema/chz.ts`, add the enum and table. Import `inventories` and the inventory status enum from `./inventory.js` and `user` from `./auth.js` if they are not already imported; check the file's existing imports first rather than assuming.

```ts
export const chzExportRunStateEnum = pgEnum("chz_export_run_state", [
  "queued",
  "ordered",
  "ready",
  "imported",
  "failed",
]);

/**
 * One row per (inventory, ChZ status) — six per order. A retry reuses the row
 * rather than accumulating history, so the table stays one row per thing the
 * operator can see; `attempts` is what records how much quota a status has
 * already cost.
 */
export const chzExportRuns = pgTable(
  "chz_export_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    inventoryId: uuid("inventory_id").notNull(),
    status: inventoryChzStatusEnum("status").notNull(),
    state: chzExportRunStateEnum("state").notNull().default("queued"),
    dispenserTaskId: text("dispenser_task_id"),
    resultId: text("result_id"),
    orderedByUserId: text("ordered_by_user_id")
      .notNull()
      .references(() => user.id),
    importId: uuid("import_id"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    attempts: integer("attempts").notNull().default(0),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    orderedAt: timestamp("ordered_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("chz_export_runs_tenant_inventory_status_uq").on(
      table.tenantId,
      table.inventoryId,
      table.status,
    ),
    foreignKey({
      name: "chz_export_runs_tenant_inventory_fk",
      columns: [table.tenantId, table.inventoryId],
      foreignColumns: [inventories.tenantId, inventories.id],
    }),
    foreignKey({
      name: "chz_export_runs_tenant_import_fk",
      columns: [table.tenantId, table.importId],
      foreignColumns: [inventoryImports.tenantId, inventoryImports.id],
    }),
    index("chz_export_runs_unfinished_idx")
      .on(table.tenantId, table.inventoryId)
      .where(sql`${table.state} in ('queued', 'ordered', 'ready')`),
    check("chz_export_runs_attempts_nonnegative_check", sql`${table.attempts} >= 0`),
    // Every state, not just the terminal ones: a row must never sit in
    // `ordered` with no task to poll, which is the state that would strand a
    // run silently. Modelled on `inventory_document_runs_status_consistency_check`.
    check(
      "chz_export_runs_state_consistency_check",
      sql`(${table.state} = 'queued' and ${table.dispenserTaskId} is null and ${table.resultId} is null and ${table.importId} is null and ${table.errorCode} is null)
        or (${table.state} = 'ordered' and ${table.dispenserTaskId} is not null and ${table.resultId} is null and ${table.importId} is null and ${table.errorCode} is null)
        or (${table.state} = 'ready' and ${table.dispenserTaskId} is not null and ${table.resultId} is not null and ${table.importId} is null and ${table.errorCode} is null)
        or (${table.state} = 'imported' and ${table.importId} is not null and ${table.errorCode} is null and ${table.completedAt} is not null)
        or (${table.state} = 'failed' and ${table.errorCode} is not null and ${table.completedAt} is not null)`,
    ),
  ],
);
```

If `inventoryImports` lives in a different schema file than `chz.ts`, import it from there; if importing it would create a cycle, move the composite foreign key into the file that already declares `inventoryImports` following whatever pattern that file uses for cross-file keys, and say so in your report.

- [ ] **Step 4: Generate, rename and apply the migration**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/db db:generate
```

Rename the generated SQL to `packages/db/migrations/0100_chz_export_runs.sql` and its `meta/_journal.json` tag to `0100_chz_export_runs` (both must match, `"idx": 100`, `"version": "7"`, `"breakpoints": true`). Then:

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/db test
pnpm --filter @markiro/db db:migrate
```

Expected: build and tests pass, migration applies cleanly.

If `db:generate` stops with `Error: Interactive prompts require a TTY terminal`, it is asking whether a column is a rename or a new column. That should not happen for a pure table addition; if it does, stop and report rather than guessing at an answer.

- [ ] **Step 5: Add runtime migration coverage**

Extend `packages/db/test/chz-export-runs.test.ts` with a runtime test following the structure of `packages/db/test/chz-product-groups-migration.test.ts` (scratch database, skip when `DATABASE_URL` is absent, same timeouts). Assert the check constraint actually rejects the states it must:

```ts
it("rejects a run that claims to be ordered with no dispenser task", async () => {
  await expect(
    db.insert(schema.chzExportRuns).values({
      tenantId,
      inventoryId,
      status: "EMITTED",
      state: "ordered",
      orderedByUserId: userId,
    }),
  ).rejects.toThrow(/chz_export_runs_state_consistency_check/);
});

it("accepts a queued run and the imported terminal state", async () => {
  await db.insert(schema.chzExportRuns).values({
    tenantId,
    inventoryId,
    status: "EMITTED",
    state: "queued",
    orderedByUserId: userId,
  });
  await db
    .update(schema.chzExportRuns)
    .set({ state: "imported", importId, completedAt: new Date() })
    .where(eq(schema.chzExportRuns.tenantId, tenantId));
});
```

Seed the tenant, user, inventory and import rows the foreign keys require, using whatever helpers the sibling migration test already uses.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @markiro/db test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db
git commit -m "feat(db): chz export runs table"
```

---

### Task 2: The True API dispenser client

**Files:**

- Create: `apps/api/src/modules/chz-exports/true-api.types.ts`
- Create: `apps/api/src/modules/chz-exports/true-api.client.ts`
- Test: `apps/api/test/chz-true-api-client.test.ts`

**Interfaces:**

- Produces:
  - `TrueApiClientDependencies { fetch: typeof fetch; scheduleAbort: (c: AbortController, ms: number) => () => void }` and `productionTrueApiClientDependencies`.
  - `class TrueApiClient` with constructor `(deps: TrueApiClientDependencies = productionTrueApiClientDependencies)` and four methods, each taking `auth: TrueApiAuth { baseUrl: string; token: string }`:
    - `createDispenserTask(auth, input: CreateDispenserTaskInput): Promise<TrueApiResult<{ taskId: string }>>`
    - `listDispenserTasks(auth, productGroupCode: number): Promise<TrueApiResult<DispenserTaskSummary[]>>`
    - `listDispenserResults(auth, taskIds: string[]): Promise<TrueApiResult<DispenserResult[]>>`
    - `downloadDispenserResult(auth, resultId: string): Promise<TrueApiResult<Uint8Array>>`
  - `type TrueApiResult<T> = { status: "ok"; value: T } | { status: "unauthorized" } | { status: "rejected"; code: string; message: string } | { status: "unavailable" }`
  - `interface CreateDispenserTaskInput { participantInn: string; productGroupCode: number; chzStatus: string; gtins: string[] }`
  - `interface DispenserTaskSummary { taskId: string; status: string; createdAt: string | null }`
  - `interface DispenserResult { taskId: string; resultId: string | null; status: string }`

Tasks 5 and 6 consume all of these.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/chz-true-api-client.test.ts`. There is no nock/msw/undici mock agent in this repository — the established way to test an outbound client is to inject `fetch`, exactly as `apps/api/src/integrations/dadata/dadata.client.ts` does.

```ts
import { describe, expect, it, vi } from "vitest";

import {
  TrueApiClient,
  type TrueApiClientDependencies,
} from "../src/modules/chz-exports/true-api.client";

const auth = { baseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api", token: "t0ken" };

function deps(fetchImpl: TrueApiClientDependencies["fetch"]): TrueApiClientDependencies {
  return { fetch: fetchImpl, scheduleAbort: () => () => {} };
}

describe("TrueApiClient", () => {
  it("orders a filtered CIS report with the params object encoded as a string", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new TrueApiClient(
      deps(async (url, init) => {
        calls.push({ url: String(url), init: init as RequestInit });
        return new Response(JSON.stringify({ taskId: "task-1" }), { status: 200 });
      }),
    );

    const result = await client.createDispenserTask(auth, {
      participantInn: "7700000000",
      productGroupCode: 8,
      chzStatus: "EMITTED",
      gtins: ["04600000000017"],
    });

    expect(result).toEqual({ status: "ok", value: { taskId: "task-1" } });
    expect(calls[0]!.url).toBe(`${auth.baseUrl}/dispenser/tasks`);
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Authorization")).toBe("Bearer t0ken");

    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body.productGroupCode).toBe(8);
    expect(body.periodicity).toBe("SINGLE");
    // `params` travels as a STRING, not a nested object -- this is the part of
    // the dispenser contract that is easy to get wrong and silent when wrong.
    expect(typeof body.params).toBe("string");
    expect(JSON.parse(body.params as string)).toMatchObject({
      participantInn: "7700000000",
      status: "EMITTED",
      includeGtin: ["04600000000017"],
    });
  });

  it("maps 401 to unauthorized so the caller can refuse instead of retrying", async () => {
    const client = new TrueApiClient(deps(async () => new Response("", { status: 401 })));
    await expect(client.listDispenserResults(auth, ["task-1"])).resolves.toEqual({
      status: "unauthorized",
    });
  });

  it("maps a 4xx rejection to a terminal result carrying the ChZ message", async () => {
    const client = new TrueApiClient(
      deps(
        async () =>
          new Response(JSON.stringify({ error_message: "no active contract" }), { status: 400 }),
      ),
    );
    const result = await client.createDispenserTask(auth, {
      participantInn: "7700000000",
      productGroupCode: 8,
      chzStatus: "EMITTED",
      gtins: [],
    });
    expect(result).toEqual({
      status: "rejected",
      code: "400",
      message: "no active contract",
    });
  });

  it("maps a 5xx and a thrown fetch to unavailable so the job retries", async () => {
    const server = new TrueApiClient(deps(async () => new Response("", { status: 503 })));
    await expect(server.listDispenserResults(auth, ["t"])).resolves.toEqual({
      status: "unavailable",
    });
    const offline = new TrueApiClient(
      deps(async () => {
        throw new Error("ECONNRESET");
      }),
    );
    await expect(offline.listDispenserResults(auth, ["t"])).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("passes task ids as a repeated query parameter and returns the archive bytes", async () => {
    const urls: string[] = [];
    const client = new TrueApiClient(
      deps(async (url) => {
        urls.push(String(url));
        return String(url).endsWith("/file")
          ? new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { status: 200 })
          : new Response(JSON.stringify([{ taskId: "a", resultId: "r1", status: "COMPLETED" }]), {
              status: 200,
            });
      }),
    );

    await client.listDispenserResults(auth, ["a", "b"]);
    expect(urls[0]).toContain("task_ids=a");
    expect(urls[0]).toContain("task_ids=b");

    const file = await client.downloadDispenserResult(auth, "r1");
    expect(file).toMatchObject({ status: "ok" });
    // ZIP magic -- the bytes must arrive unmodified, because they go straight
    // into the existing importer.
    expect(Array.from((file as { value: Uint8Array }).value.slice(0, 4))).toEqual([
      0x50, 0x4b, 0x03, 0x04,
    ]);
  });

  it("does not put the token anywhere but the Authorization header", async () => {
    const seen: string[] = [];
    const client = new TrueApiClient(
      deps(async (url, init) => {
        seen.push(String(url), String((init as RequestInit).body ?? ""));
        return new Response("[]", { status: 200 });
      }),
    );
    await client.listDispenserTasks(auth, 8);
    expect(seen.join("|")).not.toContain("t0ken");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-true-api-client.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the types**

`apps/api/src/modules/chz-exports/true-api.types.ts`:

```ts
export interface TrueApiClientDependencies {
  fetch: typeof fetch;
  scheduleAbort: (controller: AbortController, timeoutMs: number) => () => void;
}

export const productionTrueApiClientDependencies: TrueApiClientDependencies = {
  fetch: globalThis.fetch.bind(globalThis),
  scheduleAbort: (controller, timeoutMs) => {
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    return () => clearTimeout(timeout);
  },
};

export interface TrueApiAuth {
  baseUrl: string;
  token: string;
}

/**
 * Four outcomes rather than exceptions, following the DaData client: the job
 * layer owns retry policy, and it needs to tell "ЧЗ said no" (terminal) from
 * "ЧЗ was unreachable" (retryable) without unwrapping error subclasses.
 */
export type TrueApiResult<T> =
  | { status: "ok"; value: T }
  | { status: "unauthorized" }
  | { status: "rejected"; code: string; message: string }
  | { status: "unavailable" };

export interface CreateDispenserTaskInput {
  participantInn: string;
  productGroupCode: number;
  chzStatus: string;
  gtins: string[];
}

export interface DispenserTaskSummary {
  taskId: string;
  status: string;
  createdAt: string | null;
}

export interface DispenserResult {
  taskId: string;
  resultId: string | null;
  status: string;
}
```

- [ ] **Step 4: Write the client**

`apps/api/src/modules/chz-exports/true-api.client.ts`:

```ts
import { Injectable } from "@nestjs/common";

import {
  productionTrueApiClientDependencies,
  type CreateDispenserTaskInput,
  type DispenserResult,
  type DispenserTaskSummary,
  type TrueApiAuth,
  type TrueApiClientDependencies,
  type TrueApiResult,
} from "./true-api.types";

const REQUEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * `packageType` is required by `FILTERED_CIS_REPORT` and selects the packaging
 * level the report covers. The cabinet export the operators use today is the
 * unit-level one, which is what an inventory counts.
 *
 * KNOWN UNKNOWN: the exact enum spelling is not verifiable from here. It is
 * settled against the sandbox by the runbook step this plan's Task 9 adds; if
 * the sandbox rejects it, only this constant changes.
 */
const PACKAGE_TYPE = "UNIT";

@Injectable()
export class TrueApiClient {
  constructor(
    private readonly dependencies: TrueApiClientDependencies = productionTrueApiClientDependencies,
  ) {}

  async createDispenserTask(
    auth: TrueApiAuth,
    input: CreateDispenserTaskInput,
  ): Promise<TrueApiResult<{ taskId: string }>> {
    // `params` is a STRING-encoded object, not a nested one. This is the
    // dispenser's contract, and getting it wrong is silent: ЧЗ accepts the task
    // and returns an unfiltered report.
    const params = JSON.stringify({
      participantInn: input.participantInn,
      packageType: PACKAGE_TYPE,
      status: input.chzStatus,
      ...(input.gtins.length > 0 ? { includeGtin: input.gtins } : {}),
    });
    return this.request(
      auth,
      "/dispenser/tasks",
      REQUEST_TIMEOUT_MS,
      {
        method: "POST",
        body: JSON.stringify({
          reportId: "FILTERED_CIS_REPORT",
          productGroupCode: input.productGroupCode,
          periodicity: "SINGLE",
          params,
        }),
      },
      async (response) => {
        const payload = (await response.json()) as { taskId?: unknown; id?: unknown };
        const taskId = payload.taskId ?? payload.id;
        return typeof taskId === "string" && taskId.length > 0 ? { taskId } : null;
      },
    );
  }

  async listDispenserTasks(
    auth: TrueApiAuth,
    productGroupCode: number,
  ): Promise<TrueApiResult<DispenserTaskSummary[]>> {
    const query = new URLSearchParams({ productGroupCode: String(productGroupCode) });
    return this.request(
      auth,
      `/dispenser/tasks?${query.toString()}`,
      REQUEST_TIMEOUT_MS,
      {},
      async (response) => {
        const payload = await response.json();
        const rows = Array.isArray(payload) ? payload : [];
        return rows.map((row) => {
          const record = row as Record<string, unknown>;
          return {
            taskId: String(record.taskId ?? record.id ?? ""),
            status: String(record.status ?? ""),
            createdAt: typeof record.createdAt === "string" ? record.createdAt : null,
          };
        });
      },
    );
  }

  async listDispenserResults(
    auth: TrueApiAuth,
    taskIds: string[],
  ): Promise<TrueApiResult<DispenserResult[]>> {
    const query = new URLSearchParams();
    for (const taskId of taskIds) query.append("task_ids", taskId);
    return this.request(
      auth,
      `/dispenser/results?${query.toString()}`,
      REQUEST_TIMEOUT_MS,
      {},
      async (response) => {
        const payload = await response.json();
        const rows = Array.isArray(payload) ? payload : [];
        return rows.map((row) => {
          const record = row as Record<string, unknown>;
          return {
            taskId: String(record.taskId ?? ""),
            resultId: typeof record.resultId === "string" ? record.resultId : null,
            status: String(record.status ?? ""),
          };
        });
      },
    );
  }

  async downloadDispenserResult(
    auth: TrueApiAuth,
    resultId: string,
  ): Promise<TrueApiResult<Uint8Array>> {
    return this.request(
      auth,
      `/dispenser/results/${encodeURIComponent(resultId)}/file`,
      DOWNLOAD_TIMEOUT_MS,
      {},
      async (response) => new Uint8Array(await response.arrayBuffer()),
    );
  }

  private async request<T>(
    auth: TrueApiAuth,
    path: string,
    timeoutMs: number,
    init: RequestInit,
    parse: (response: Response) => Promise<T | null>,
  ): Promise<TrueApiResult<T>> {
    const controller = new AbortController();
    const cancelAbort = this.dependencies.scheduleAbort(controller, timeoutMs);
    try {
      const response = await this.dependencies.fetch(`${auth.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          Authorization: `Bearer ${auth.token}`,
        },
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) return { status: "unauthorized" };
      if (response.status >= 400 && response.status < 500) {
        return {
          status: "rejected",
          code: String(response.status),
          message: await this.rejectionMessage(response),
        };
      }
      if (!response.ok) return { status: "unavailable" };
      const value = await parse(response);
      return value === null ? { status: "unavailable" } : { status: "ok", value };
    } catch {
      return { status: "unavailable" };
    } finally {
      cancelAbort();
    }
  }

  private async rejectionMessage(response: Response): Promise<string> {
    try {
      const payload = (await response.json()) as Record<string, unknown>;
      const message = payload.error_message ?? payload.errorMessage ?? payload.message;
      return typeof message === "string" && message.length > 0 ? message.slice(0, 500) : "";
    } catch {
      return "";
    }
  }
}
```

Note that 403 maps to `unauthorized` alongside 401: True API answers 403 for "no active contract for the product group", and retrying that is pointless — the caller surfaces it verbatim rather than looping.

- [ ] **Step 5: Run the tests**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-true-api-client.test.ts`
Expected: PASS, all six cases.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/chz-exports apps/api/test/chz-true-api-client.test.ts
git commit -m "feat(api): True API dispenser client"
```

---

### Task 3: The token service

**Files:**

- Create: `apps/api/src/modules/chz-exports/chz-token.service.ts`
- Test: `apps/api/test/chz-token.service.test.ts`

**Interfaces:**

- Consumes: `ChzCryptoService` from `apps/api/src/modules/signer-agents/chz-crypto.service` (has `configured: boolean` and `decrypt(tenantId, { encryptedToken, tokenNonce, tokenTag }): string`), `CHZ_TRUE_API_BASE_URLS` and `CHZ_CHANNEL_TYPE` from `apps/api/src/modules/signer-agents/chz-constants`, `chzSignerSettingsSchema` from `apps/api/src/modules/integrations/channel-registry`.
- Produces: `class ChzTokenService` with `getActiveToken(tenantId: string): Promise<ChzTokenResult>` where
  `type ChzTokenResult = { status: "ok"; auth: { baseUrl: string; token: string } } | { status: "unconfigured" } | { status: "missing" } | { status: "expired" }`.
  Task 4 uses it for a pre-flight check; Task 5 uses it per pass.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/chz-token.service.test.ts`, following the scratch-database style of `apps/api/test/chz-crypto.test.ts` and the signer-agent service tests:

```ts
it("returns the decrypted token and the environment's base URL", async () => {
  const crypto = new ChzCryptoService(key);
  const encrypted = crypto.encrypt(tenantId, "the-bearer-token");
  await db.insert(schema.chzApiTokens).values({
    tenantId,
    ...encrypted,
    obtainedAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  await db
    .insert(schema.integrationChannels)
    .values({ tenantId, type: "chestny_znak", settings: { environment: "sandbox" } });

  await expect(service.getActiveToken(tenantId)).resolves.toEqual({
    status: "ok",
    auth: {
      baseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api",
      token: "the-bearer-token",
    },
  });
});

it("defaults to the production base URL when the channel has no settings row", async () => {
  // ... seed only the token ...
  const result = await service.getActiveToken(tenantId);
  expect(result).toMatchObject({
    status: "ok",
    auth: { baseUrl: "https://markirovka.crpt.ru/api/v3/true-api" },
  });
});

it("refuses when no token row exists", async () => {
  await expect(service.getActiveToken(tenantId)).resolves.toEqual({ status: "missing" });
});

it("refuses an expired token rather than letting True API answer 401", async () => {
  // ... seed a token with expiresAt in the past ...
  await expect(service.getActiveToken(tenantId)).resolves.toEqual({ status: "expired" });
});

it("refuses when the encryption key is unconfigured", async () => {
  const service = new ChzTokenService(db, new ChzCryptoService(undefined));
  await expect(service.getActiveToken(tenantId)).resolves.toEqual({ status: "unconfigured" });
});
```

Adapt the seeding and the scratch-database setup to whatever the sibling tests do; the assertions above are the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-token.service.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

```ts
import { Inject, Injectable } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, eq } from "drizzle-orm";

import { DB } from "../../auth/auth.module";
import { chzSignerSettingsSchema } from "../integrations/channel-registry";
import { CHZ_CHANNEL_TYPE, CHZ_TRUE_API_BASE_URLS } from "../signer-agents/chz-constants";
import { ChzCryptoService } from "../signer-agents/chz-crypto.service";
import type { TrueApiAuth } from "./true-api.types";

export type ChzTokenResult =
  | { status: "ok"; auth: TrueApiAuth }
  | { status: "unconfigured" }
  | { status: "missing" }
  | { status: "expired" };

@Injectable()
export class ChzTokenService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly crypto: ChzCryptoService,
  ) {}

  /**
   * The expiry is checked here rather than left to True API's 401 because a
   * refusal we can explain ("the agent has not refreshed the token") is worth
   * more to the operator than a 401 we have to guess about — and it costs no
   * request.
   */
  async getActiveToken(tenantId: string): Promise<ChzTokenResult> {
    if (!this.crypto.configured) return { status: "unconfigured" };

    const [row] = await this.db
      .select({
        encryptedToken: schema.chzApiTokens.encryptedToken,
        tokenNonce: schema.chzApiTokens.tokenNonce,
        tokenTag: schema.chzApiTokens.tokenTag,
        expiresAt: schema.chzApiTokens.expiresAt,
      })
      .from(schema.chzApiTokens)
      .where(eq(schema.chzApiTokens.tenantId, tenantId));
    if (!row) return { status: "missing" };
    if (row.expiresAt.getTime() <= Date.now()) return { status: "expired" };

    const [channel] = await this.db
      .select({ settings: schema.integrationChannels.settings })
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.tenantId, tenantId),
          eq(schema.integrationChannels.type, CHZ_CHANNEL_TYPE),
        ),
      );
    const parsed = chzSignerSettingsSchema.safeParse(channel?.settings ?? {});
    const environment = parsed.success ? parsed.data.environment : "production";

    return {
      status: "ok",
      auth: {
        baseUrl: CHZ_TRUE_API_BASE_URLS[environment],
        token: this.crypto.decrypt(tenantId, {
          encryptedToken: row.encryptedToken,
          tokenNonce: row.tokenNonce,
          tokenTag: row.tokenTag,
        }),
      },
    };
  }
}
```

Check the real column names on `integrationChannels` before writing this — if the settings column or the channel-type column is named differently, match the code, not this snippet.

- [ ] **Step 4: Run the tests**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-token.service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/chz-exports/chz-token.service.ts apps/api/test/chz-token.service.test.ts
git commit -m "feat(api): resolve the active Chestny ZNAK token per tenant"
```

---

### Task 4: Pre-flight checks, ordering, progress and retry

**Files:**

- Create: `apps/api/src/modules/chz-exports/dto.ts`
- Create: `apps/api/src/modules/chz-exports/chz-exports.service.ts`
- Test: `apps/api/test/chz-exports.service.test.ts`

**Interfaces:**

- Consumes: `chzExportRuns` (Task 1), `ChzTokenService.getActiveToken` (Task 3).
- Produces:
  - `type ChzExportPreflightCode = "INN_MISSING" | "PRODUCT_GROUP_MISSING" | "AGENT_NOT_PAIRED" | "TOKEN_UNAVAILABLE"`
  - `interface ChzExportRunDto { status: InventoryChzStatus; state: "queued" | "ordered" | "ready" | "imported" | "failed"; attempts: number; errorCode: string | null; errorMessage: string | null; importId: string | null; orderedAt: string | null; completedAt: string | null }`
  - `interface ChzExportStateDto { available: boolean; blockedBy: ChzExportPreflightCode[]; runs: ChzExportRunDto[] }`
  - `class ChzExportsService` with `getState(tenantId, inventoryId): Promise<ChzExportStateDto>`, `order(tenantId, actorUserId, inventoryId): Promise<ChzExportStateDto>`, `retry(tenantId, actorUserId, inventoryId, status: InventoryChzStatus): Promise<ChzExportStateDto>`.
  - `chzExportStateOpenApiSchema` and `retryChzExportSchema` in `dto.ts`.

Task 6 calls `order`'s enqueue path; Task 7 exposes all three; Task 8 renders `ChzExportStateDto`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/chz-exports.service.test.ts`:

```ts
it("reports every unmet pre-flight condition at once, not the first one", async () => {
  // Tenant with no INN, product with no group code, no agent, no token.
  const state = await service.getState(tenantId, inventoryId);
  expect(state.available).toBe(false);
  expect([...state.blockedBy].sort()).toEqual([
    "AGENT_NOT_PAIRED",
    "INN_MISSING",
    "PRODUCT_GROUP_MISSING",
    "TOKEN_UNAVAILABLE",
  ]);
});

it("refuses to order while a pre-flight condition is unmet", async () => {
  await expect(service.order(tenantId, actorUserId, inventoryId)).rejects.toMatchObject({
    status: 422,
  });
});

it("creates exactly six queued runs attributed to the operator", async () => {
  await satisfyPreflight();
  const state = await service.order(tenantId, actorUserId, inventoryId);
  expect(state.runs).toHaveLength(6);
  expect(state.runs.every((run) => run.state === "queued")).toBe(true);
  const rows = await db
    .select()
    .from(schema.chzExportRuns)
    .where(eq(schema.chzExportRuns.inventoryId, inventoryId));
  expect(rows.every((row) => row.orderedByUserId === actorUserId)).toBe(true);
});

it("does not re-order statuses that are already in flight or imported", async () => {
  await satisfyPreflight();
  await service.order(tenantId, actorUserId, inventoryId);
  await db
    .update(schema.chzExportRuns)
    .set({ state: "imported", importId, completedAt: new Date() })
    .where(eq(schema.chzExportRuns.status, "EMITTED"));

  await service.order(tenantId, actorUserId, inventoryId);
  const [emitted] = await db
    .select()
    .from(schema.chzExportRuns)
    .where(eq(schema.chzExportRuns.status, "EMITTED"));
  // Re-ordering an arrived export would burn the daily quota for nothing.
  expect(emitted!.state).toBe("imported");
});

it("resets a failed run subtractively, keeping attempts and the actor", async () => {
  await satisfyPreflight();
  await service.order(tenantId, actorUserId, inventoryId);
  await db
    .update(schema.chzExportRuns)
    .set({
      state: "failed",
      dispenserTaskId: "task-9",
      resultId: "result-9",
      errorCode: "CHZ_TASK_FAILED",
      errorMessage: "boom",
      attempts: 3,
      completedAt: new Date(),
    })
    .where(eq(schema.chzExportRuns.status, "RETIRED"));

  await service.retry(tenantId, actorUserId, inventoryId, "RETIRED");

  const [row] = await db
    .select()
    .from(schema.chzExportRuns)
    .where(eq(schema.chzExportRuns.status, "RETIRED"));
  expect(row).toMatchObject({
    state: "queued",
    dispenserTaskId: null,
    resultId: null,
    errorCode: null,
    errorMessage: null,
    completedAt: null,
    // Kept: it is the record of how much quota this status has already cost.
    attempts: 3,
  });
});

it("refuses to retry a run that has not failed", async () => {
  await satisfyPreflight();
  await service.order(tenantId, actorUserId, inventoryId);
  await expect(service.retry(tenantId, actorUserId, inventoryId, "RETIRED")).rejects.toMatchObject({
    status: 409,
  });
});
```

Write `satisfyPreflight()` as a local helper that sets `org_profiles.inn`, gives the inventory's product a `chzProductGroupCode`, inserts an active `chz_signer_agents` row, and inserts a non-expired `chz_api_tokens` row.

- [ ] **Step 2: Run test to verify it fails**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-exports.service.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the DTOs**

`apps/api/src/modules/chz-exports/dto.ts`:

```ts
import { z } from "zod";
import type { SchemaObject } from "@nestjs/swagger";
import { INVENTORY_CHZ_STATUSES, type InventoryChzStatus } from "@markiro/domain";

export const CHZ_EXPORT_PREFLIGHT_CODES = [
  "INN_MISSING",
  "PRODUCT_GROUP_MISSING",
  "AGENT_NOT_PAIRED",
  "TOKEN_UNAVAILABLE",
] as const;
export type ChzExportPreflightCode = (typeof CHZ_EXPORT_PREFLIGHT_CODES)[number];

export const CHZ_EXPORT_RUN_STATES = ["queued", "ordered", "ready", "imported", "failed"] as const;
export type ChzExportRunState = (typeof CHZ_EXPORT_RUN_STATES)[number];

export interface ChzExportRunDto {
  status: InventoryChzStatus;
  state: ChzExportRunState;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  importId: string | null;
  orderedAt: string | null;
  completedAt: string | null;
}

export interface ChzExportStateDto {
  available: boolean;
  blockedBy: ChzExportPreflightCode[];
  runs: ChzExportRunDto[];
}

export const retryChzExportSchema = z.object({
  status: z.enum(INVENTORY_CHZ_STATUSES),
});
export type RetryChzExportDto = z.infer<typeof retryChzExportSchema>;

export const retryChzExportOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: { status: { type: "string", enum: [...INVENTORY_CHZ_STATUSES] } },
};

export const chzExportStateOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["available", "blockedBy", "runs"],
  properties: {
    available: { type: "boolean" },
    blockedBy: {
      type: "array",
      items: { type: "string", enum: [...CHZ_EXPORT_PREFLIGHT_CODES] },
    },
    runs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "status",
          "state",
          "attempts",
          "errorCode",
          "errorMessage",
          "importId",
          "orderedAt",
          "completedAt",
        ],
        properties: {
          status: { type: "string", enum: [...INVENTORY_CHZ_STATUSES] },
          state: { type: "string", enum: [...CHZ_EXPORT_RUN_STATES] },
          attempts: { type: "integer" },
          errorCode: { type: "string", nullable: true },
          errorMessage: { type: "string", nullable: true },
          importId: { type: "string", format: "uuid", nullable: true },
          orderedAt: { type: "string", format: "date-time", nullable: true },
          completedAt: { type: "string", format: "date-time", nullable: true },
        },
      },
    },
  },
};
```

- [ ] **Step 4: Write the service**

`apps/api/src/modules/chz-exports/chz-exports.service.ts`. The shape below is the contract; fill in the query details against the real schema.

```ts
@Injectable()
export class ChzExportsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tokens: ChzTokenService,
    private readonly jobs: PgBossService,
  ) {}

  async getState(tenantId: string, inventoryId: string): Promise<ChzExportStateDto> {
    const blockedBy = await this.preflight(tenantId, inventoryId);
    return {
      available: blockedBy.length === 0,
      blockedBy,
      runs: await this.runs(tenantId, inventoryId),
    };
  }

  /**
   * All four conditions are reported together rather than one at a time so the
   * operator fixes everything in one pass instead of discovering the next
   * problem after each fix.
   */
  private async preflight(
    tenantId: string,
    inventoryId: string,
  ): Promise<ChzExportPreflightCode[]> {
    const blocked: ChzExportPreflightCode[] = [];

    const [profile] = await this.db
      .select({ inn: schema.orgProfiles.inn })
      .from(schema.orgProfiles)
      .where(eq(schema.orgProfiles.tenantId, tenantId));
    if (!profile?.inn || !/^\d{10}(\d{2})?$/.test(profile.inn)) blocked.push("INN_MISSING");

    const [product] = await this.db
      .select({ code: schema.products.chzProductGroupCode })
      .from(schema.inventories)
      .innerJoin(
        schema.products,
        and(
          eq(schema.products.tenantId, schema.inventories.tenantId),
          eq(schema.products.id, schema.inventories.productId),
        ),
      )
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    if (!product) throw new NotFoundException();
    if (product.code === null) blocked.push("PRODUCT_GROUP_MISSING");

    const [agent] = await this.db
      .select({ id: schema.chzSignerAgents.id })
      .from(schema.chzSignerAgents)
      .where(
        and(
          eq(schema.chzSignerAgents.tenantId, tenantId),
          eq(schema.chzSignerAgents.status, "active"),
        ),
      )
      .limit(1);
    if (!agent) blocked.push("AGENT_NOT_PAIRED");

    const token = await this.tokens.getActiveToken(tenantId);
    if (token.status !== "ok") blocked.push("TOKEN_UNAVAILABLE");

    return blocked;
  }

  async order(
    tenantId: string,
    actorUserId: string,
    inventoryId: string,
  ): Promise<ChzExportStateDto> {
    const blockedBy = await this.preflight(tenantId, inventoryId);
    if (blockedBy.length > 0) {
      throw new UnprocessableEntityException({ code: "CHZ_EXPORT_PREFLIGHT_FAILED", blockedBy });
    }
    await this.db.transaction(async (tx) => {
      for (const status of INVENTORY_CHZ_STATUSES) {
        // Insert a queued run, or reset a failed one; never touch a run that is
        // queued, ordered, ready or imported -- re-ordering an export that has
        // already arrived burns the finite daily quota for nothing.
        await tx
          .insert(schema.chzExportRuns)
          .values({ tenantId, inventoryId, status, state: "queued", orderedByUserId: actorUserId })
          .onConflictDoUpdate({
            target: [
              schema.chzExportRuns.tenantId,
              schema.chzExportRuns.inventoryId,
              schema.chzExportRuns.status,
            ],
            set: this.resetToQueued(actorUserId),
            setWhere: eq(schema.chzExportRuns.state, "failed"),
          });
      }
    });
    await this.jobs.enqueueChzExportOrder(tenantId, inventoryId);
    return this.getState(tenantId, inventoryId);
  }

  async retry(
    tenantId: string,
    actorUserId: string,
    inventoryId: string,
    status: InventoryChzStatus,
  ): Promise<ChzExportStateDto> {
    const updated = await this.db
      .update(schema.chzExportRuns)
      .set(this.resetToQueued(actorUserId))
      .where(
        and(
          eq(schema.chzExportRuns.tenantId, tenantId),
          eq(schema.chzExportRuns.inventoryId, inventoryId),
          eq(schema.chzExportRuns.status, status),
          eq(schema.chzExportRuns.state, "failed"),
        ),
      )
      .returning({ id: schema.chzExportRuns.id });
    if (updated.length === 0) throw new ConflictException({ code: "CHZ_EXPORT_NOT_FAILED" });
    await this.jobs.enqueueChzExportOrder(tenantId, inventoryId);
    return this.getState(tenantId, inventoryId);
  }

  /**
   * One subtractive transition: everything the previous attempt left behind is
   * cleared in the same statement that flips `state`, so a crash cannot leave a
   * half-cleared row that the check constraint would reject or that would
   * resume against a stale ЧЗ task. `attempts` survives on purpose.
   */
  private resetToQueued(actorUserId: string) {
    return {
      state: "queued" as const,
      dispenserTaskId: null,
      resultId: null,
      importId: null,
      errorCode: null,
      errorMessage: null,
      claimedAt: null,
      orderedAt: null,
      completedAt: null,
      orderedByUserId: actorUserId,
      updatedAt: new Date(),
    };
  }
}
```

If Drizzle's `onConflictDoUpdate` in this version has no `setWhere`, express the same thing as an explicit `select` of the existing row followed by a conditional `insert`/`update` inside the same transaction, and say which you used in your report. The invariant that matters is: **a status that is queued, ordered, ready or imported is never reset by `order`.**

- [ ] **Step 5: Run the tests**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-exports.service.test.ts`
Expected: PASS, all six cases.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/chz-exports apps/api/test/chz-exports.service.test.ts
git commit -m "feat(api): order, track and retry Chestny ZNAK export runs"
```

---

### Task 5: The order runner

**Files:**

- Create: `apps/api/src/modules/chz-exports/chz-export-runner.service.ts`
- Test: `apps/api/test/chz-export-runner.service.test.ts`

**Interfaces:**

- Consumes: `TrueApiClient` (Task 2), `ChzTokenService` (Task 3), `chzExportRuns` (Task 1), `InventoriesService.importEvidence(tenantId, actorUserId, inventoryId, declaredStatus, { originalName, mimeType, bytes })`, `JournalService.append`.
- Produces: `class ChzExportRunnerService` with
  `run(tenantId: string, inventoryId: string, attempt: { retryCount: number; retryLimit: number }): Promise<{ finished: boolean }>`.
  `finished` is `false` when at least one run is still non-terminal, which is how Task 6 decides whether to re-enqueue with `startAfter`.

**Read before you start:** `apps/api/src/modules/inventories/inventory-document-runner.service.ts`. It is the same shape of service and you should follow its structure — `claim`, attempt-aware failure (`if (attempt.retryCount < attempt.retryLimit)`), and its separation of a safe error code from the raw error.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/chz-export-runner.service.test.ts`. Drive it with a fake `TrueApiClient` — the real one is already covered by Task 2, and what needs testing here is the state machine.

```ts
it("creates a task per queued run and moves it to ordered", async () => {
  const client = fakeClient({ createTaskId: (status) => `task-${status}` });
  await runner.run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });
  const rows = await runsFor(inventoryId);
  expect(rows.every((row) => row.state === "ordered")).toBe(true);
  expect(rows.map((row) => row.dispenserTaskId).sort()).toEqual(
    INVENTORY_CHZ_STATUSES.map((status) => `task-${status}`).sort(),
  );
  // Exactly one batch poll for the whole order. Polling each task separately
  // would be 6 requests per pass against `GET dispenser/tasks/{id}`'s limit of
  // 5 per minute -- the design would fail on its own traffic.
  expect(client.calls.filter((call) => call.op === "listDispenserResults")).toHaveLength(1);
});

it("polls all six tasks in one batch request", async () => {
  await seedRuns({ state: "ordered", taskIdFor: (status) => `task-${status}` });
  const client = fakeClient({ results: [] });
  await runner.run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });
  const poll = client.calls.find((call) => call.op === "listDispenserResults")!;
  expect((poll.taskIds as string[]).sort()).toEqual(
    INVENTORY_CHZ_STATUSES.map((status) => `task-${status}`).sort(),
  );
});

it("hands the downloaded archive to importEvidence untouched and as a .zip", async () => {
  await seedRuns({ state: "ordered", taskIdFor: (status) => `task-${status}` });
  const archive = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x99]);
  const client = fakeClient({
    results: [{ taskId: "task-EMITTED", resultId: "r1", status: "COMPLETED" }],
    file: archive,
  });
  await runner.run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });

  expect(importEvidence).toHaveBeenCalledTimes(1);
  const [, actorUserId, , declaredStatus, file] = importEvidence.mock.calls[0]!;
  expect(actorUserId).toBe(orderedByUserId);
  expect(declaredStatus).toBe("EMITTED");
  expect(file.originalName.endsWith(".zip")).toBe(true);
  expect(file.mimeType).toBe("application/zip");
  // The parser already handles a one-CSV zip; re-packing or unpacking here
  // would be a second code path to the same invariant.
  expect(Array.from(file.bytes as Buffer)).toEqual(Array.from(archive));

  const [row] = await runsFor(inventoryId, "EMITTED");
  expect(row).toMatchObject({ state: "imported", completedAt: expect.any(Date) });
});

it("fails one status terminally without disturbing the other five", async () => {
  await seedRuns({ state: "queued" });
  const client = fakeClient({
    rejectStatus: "RETIRED",
    rejection: { code: "400", message: "no active contract" },
  });
  await runner.run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });

  const [retired] = await runsFor(inventoryId, "RETIRED");
  expect(retired).toMatchObject({
    state: "failed",
    errorCode: "CHZ_TASK_REJECTED",
    errorMessage: "no active contract",
  });
  const others = (await runsFor(inventoryId)).filter((row) => row.status !== "RETIRED");
  expect(others.every((row) => row.state === "ordered")).toBe(true);
});

it("resumes an in-flight order instead of paying for a second task", async () => {
  await seedRuns({ state: "ordered", taskIdFor: () => "task-existing" });
  const client = fakeClient({ results: [] });
  await runner.run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });
  expect(client.calls.filter((call) => call.op === "createDispenserTask")).toHaveLength(0);
});

it("reconciles a lost create response against the task list rather than re-creating", async () => {
  // A run claimed long enough ago to be stale, still queued, no task id.
  await seedRuns({ state: "queued", claimedAt: new Date(Date.now() - 600_000) });
  const client = fakeClient({
    existingTasks: [{ taskId: "task-orphan", status: "PREPARATION", createdAt: null }],
    matchesRun: "EMITTED",
  });
  await runner.run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });

  const [row] = await runsFor(inventoryId, "EMITTED");
  expect(row).toMatchObject({ state: "ordered", dispenserTaskId: "task-orphan" });
  expect(
    client.calls.filter(
      (call) => call.op === "createDispenserTask" && call.chzStatus === "EMITTED",
    ),
  ).toHaveLength(0);
});

it("keeps runs non-terminal and reports unfinished when a token is unavailable", async () => {
  await seedRuns({ state: "queued" });
  tokens.getActiveToken.mockResolvedValue({ status: "expired" });
  const outcome = await runner.run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });
  expect(outcome).toEqual({ finished: false });
  expect((await runsFor(inventoryId)).every((row) => row.state === "queued")).toBe(true);
});

it("fails the remaining runs when the attempt budget is exhausted", async () => {
  await seedRuns({ state: "queued" });
  tokens.getActiveToken.mockResolvedValue({ status: "expired" });
  await runner.run(tenantId, inventoryId, { retryCount: 5, retryLimit: 5 });
  const rows = await runsFor(inventoryId);
  expect(rows.every((row) => row.state === "failed")).toBe(true);
  expect(rows.every((row) => row.errorCode === "CHZ_TOKEN_UNAVAILABLE")).toBe(true);
});

it("never writes the token into the journal", async () => {
  await seedRuns({ state: "queued" });
  await runner.run(tenantId, inventoryId, { retryCount: 0, retryLimit: 5 });
  const journalled = JSON.stringify(journal.append.mock.calls);
  expect(journalled).not.toContain(TEST_TOKEN);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-export-runner.service.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the runner**

One pass over one order, in this order:

1. Load the order's runs. If every run is terminal (`imported` or `failed`), return `{ finished: true }` without spending a request.
2. `getActiveToken`. On anything but `ok`: if `attempt.retryCount < attempt.retryLimit`, journal a warning and return `{ finished: false }` so the job retries; otherwise mark every non-terminal run `failed` with `CHZ_TOKEN_UNAVAILABLE` and return `{ finished: true }`.
3. Read the inventory's `participantInn` (`org_profiles.inn`), the product's `chzProductGroupCode` and its `gtin14` once, for all six.
4. For each `queued` run, claim it before the request goes out. The claim is what serialises two workers and what makes a lost create response recoverable, so it is one conditional statement:

```ts
const [claimed] = await this.db
  .update(schema.chzExportRuns)
  .set({
    claimedAt: new Date(),
    attempts: sql`${schema.chzExportRuns.attempts} + 1`,
    updatedAt: new Date(),
  })
  .where(
    and(
      eq(schema.chzExportRuns.id, run.id),
      eq(schema.chzExportRuns.state, "queued"),
      or(
        isNull(schema.chzExportRuns.claimedAt),
        lt(schema.chzExportRuns.claimedAt, new Date(Date.now() - STALE_CLAIM_MS)),
      ),
    ),
  )
  .returning({ id: schema.chzExportRuns.id, priorClaimAt: schema.chzExportRuns.claimedAt });
if (!claimed) continue; // another worker holds a fresh claim on this run
```

The state stays `queued` here — it becomes `ordered` only once a `dispenserTaskId` exists, which is what keeps the check constraint true at every instant. `const STALE_CLAIM_MS = 5 * 60_000;` sits beside the class.

If the row already had a claim (`run.claimedAt !== null`) and still has no `dispenserTaskId`, its previous create may have succeeded with the response lost. Do **not** create a second task: call `listDispenserTasks` **once for the whole pass**, cache the result, and adopt a task whose filter matches this run (same product group, same status, not already adopted by another run in this order). Only when no match is found do you `createDispenserTask`.

On `ok`, transition to `ordered` with the id; on `rejected`, `failed` with `CHZ_TASK_REJECTED` and the ЧЗ message; on `unauthorized`, treat as the token case in step 2; on `unavailable`, leave it `queued` for the next pass. 5. Collect every `ordered` run's `dispenserTaskId` and call `listDispenserResults` **once**. For each result reporting completion with a `resultId`, transition to `ready`. A result in a failed/cancelled ЧЗ state becomes `failed` with `CHZ_TASK_FAILED`. 6. For each `ready` run: `downloadDispenserResult`, then

```ts
const imported = await this.inventories.importEvidence(
  tenantId,
  run.orderedByUserId,
  inventoryId,
  run.status,
  {
    // The parser already handles a zip holding exactly one CSV, which is the
    // dispenser's shape -- see chz-tabular-reader.ts `parseZipCsv`. Naming the
    // synthesised file is the entire adapter.
    originalName: `chz-${run.status.toLowerCase()}-${run.dispenserTaskId}.zip`,
    mimeType: "application/zip",
    bytes: Buffer.from(archive),
  },
);
```

On success transition to `imported` with `importId` and `completedAt`. If `importEvidence` throws, map it to `failed` with the parser's own error code where the exception carries one, and a generic `CHZ_IMPORT_FAILED` otherwise — never put the raw exception message in `errorMessage` without checking it for a token, and prefer the structured code. 7. Journal each ordering, completion and failure via `JournalService.append` with `channelType: CHZ_CHANNEL_TYPE`, `grain: "item"`, and `details` limited to `{ inventoryId, status, dispenserTaskId }`. Wrap each append in its own `try/catch` that logs and continues — a failed journal write is audit noise, not a reason to abandon an order mid-pass, exactly as `signer-scheduler.service.ts:59-75` does. 8. Return `{ finished: <every run is imported or failed> }`.

- [ ] **Step 4: Run the tests**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-export-runner.service.test.ts`
Expected: PASS, all nine cases.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/chz-exports apps/api/test/chz-export-runner.service.test.ts
git commit -m "feat(api): the Chestny ZNAK export order state machine"
```

---

### Task 6: Job wiring

**Files:**

- Modify: `apps/api/src/jobs/jobs.module.ts`
- Create: `apps/api/src/modules/chz-exports/chz-exports.module.ts`
- Test: `apps/api/test/chz-export-job.test.ts`

**Interfaces:**

- Consumes: `ChzExportRunnerService.run` (Task 5), `chzExportRuns` (Task 1).
- Produces: `RUN_CHZ_EXPORT_QUEUE = "run-chz-export"` exported from `jobs.module.ts`, and `PgBossService.enqueueChzExportOrder(tenantId: string, inventoryId: string): Promise<string>` used by Task 4.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/chz-export-job.test.ts`:

```ts
it("re-enqueues the same order with a delay while any run is unfinished", async () => {
  runner.run.mockResolvedValue({ finished: false });
  await handler([{ data: { tenantId, inventoryId }, retryCount: 0, retryLimit: 5 }]);
  expect(boss.send).toHaveBeenCalledWith(
    RUN_CHZ_EXPORT_QUEUE,
    { tenantId, inventoryId },
    expect.objectContaining({ startAfter: expect.any(Number) }),
  );
});

it("stops re-enqueueing once the order is finished", async () => {
  runner.run.mockResolvedValue({ finished: true });
  await handler([{ data: { tenantId, inventoryId }, retryCount: 0, retryLimit: 5 }]);
  expect(boss.send).not.toHaveBeenCalled();
});

it("re-enqueues every order left with a non-terminal run at boot", async () => {
  // Two inventories with unfinished runs, one fully imported.
  await reconcileUnfinishedChzExports(boss);
  expect(boss.send.mock.calls.map((call) => call[1])).toEqual([
    { tenantId, inventoryId: unfinishedA },
    { tenantId, inventoryId: unfinishedB },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-export-job.test.ts`
Expected: FAIL — `RUN_CHZ_EXPORT_QUEUE` is not exported.

- [ ] **Step 3: Wire the queue**

In `apps/api/src/jobs/jobs.module.ts`, beside the existing `BUILD_INVENTORY_DOCUMENT_QUEUE` block:

```ts
export const RUN_CHZ_EXPORT_QUEUE = "run-chz-export";
/**
 * One pass per invocation, then re-enqueue: a dispenser task can take minutes,
 * and holding a pg-boss worker that long would starve the queue and lose
 * progress across a restart. 30 seconds keeps the batch results endpoint at two
 * requests per minute against its limit of twelve.
 */
const CHZ_EXPORT_POLL_INTERVAL_SECONDS = 30;
```

```ts
await boss.createQueue(RUN_CHZ_EXPORT_QUEUE, {
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 900,
  expireInSeconds: 900,
});
this.workerIds.push(
  await boss.work(
    RUN_CHZ_EXPORT_QUEUE,
    { includeMetadata: true },
    async (jobs: JobWithMetadata<{ tenantId: string; inventoryId: string }>[]) => {
      for (const job of jobs) {
        const { finished } = await this.chzExportRunner.run(
          job.data.tenantId,
          job.data.inventoryId,
          { retryCount: job.retryCount, retryLimit: job.retryLimit },
        );
        if (!finished) {
          await boss.send(RUN_CHZ_EXPORT_QUEUE, job.data, {
            startAfter: CHZ_EXPORT_POLL_INTERVAL_SECONDS,
          });
        }
      }
    },
  ),
);
await this.reconcileUnfinishedChzExports(boss);
```

`startAfter` has no precedent in this repository — every existing deferral is cron-driven — so it is introduced here deliberately, and the comment above says why.

Add `enqueueChzExportOrder` beside `enqueueInventoryDocumentRun`:

```ts
  async enqueueChzExportOrder(tenantId: string, inventoryId: string): Promise<string> {
    if (!this.boss || !this.started) throw new Error("pg-boss is not started");
    const jobId = await this.boss.send(RUN_CHZ_EXPORT_QUEUE, { tenantId, inventoryId });
    if (!jobId) throw new Error("chz export enqueue failed");
    return jobId;
  }
```

Add `reconcileUnfinishedChzExports` modelled exactly on `reconcileQueuedInventoryDocumentRuns`, selecting **distinct** `(tenantId, inventoryId)` pairs where `state` is one of `queued`, `ordered`, `ready` — one job per order, not per run — ordered by `createdAt`, limited the same way, with the same per-row try/catch that logs and continues.

- [ ] **Step 4: Raise the worker count**

In `checkReady()`, change `this.workerIds.length !== 13` to `!== 14`. This is a hardcoded count and it will fail the readiness probe if you forget.

- [ ] **Step 5: Create the module and register it**

`apps/api/src/modules/chz-exports/chz-exports.module.ts` providing `TrueApiClient`, `ChzTokenService`, `ChzExportsService`, `ChzExportRunnerService` and the controller from Task 7, and exporting `ChzExportRunnerService` and `ChzExportsService`. Provide `ChzCryptoService` with its own factory, as `jobs.module.ts:568` and `signer-agents.module.ts:26` both do:

```ts
    {
      provide: ChzCryptoService,
      useFactory: () => new ChzCryptoService(env.CHZ_TOKEN_ENCRYPTION_KEY),
    },
```

Import the module wherever `jobs.module.ts` gets its other runners from, and register it in `apps/api/src/app.module.ts`.

- [ ] **Step 6: Run the tests**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/chz-export-job.test.ts test/health.e2e.test.ts
```

Expected: PASS. The health test is what catches a wrong worker count.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/jobs apps/api/src/modules/chz-exports apps/api/src/app.module.ts apps/api/test/chz-export-job.test.ts
git commit -m "feat(api): run-chz-export queue with boot reconciliation"
```

---

### Task 7: Cabinet endpoints

**Files:**

- Create: `apps/api/src/modules/chz-exports/chz-exports.controller.ts`
- Modify: `apps/api/test/subscription-route-inventory.test.ts`
- Test: `apps/api/test/chz-exports.e2e.test.ts`

**Interfaces:**

- Consumes: `ChzExportsService` (Task 4), `chzExportStateOpenApiSchema`, `retryChzExportSchema` (Task 4).
- Produces: `GET /inventories/:id/chz-exports`, `POST /inventories/:id/chz-exports`, `POST /inventories/:id/chz-exports/retry`, all returning `ChzExportStateDto`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/chz-exports.e2e.test.ts`, bootstrapped like `apps/api/test/inventories.e2e.test.ts` and importing `signUpAndActivate` from `./support/auth` (do **not** paste a local copy — the shared helper exists precisely so new specs stop reintroducing an inline password literal that GitGuardian flags).

```ts
it("reports the pre-flight blockers instead of ordering", async () => {
  const res = await agent.get(`/inventories/${inventoryId}/chz-exports`).expect(200);
  expect(res.body.available).toBe(false);
  expect(res.body.blockedBy).toContain("TOKEN_UNAVAILABLE");
  expect(res.body.runs).toEqual([]);
});

it("refuses to order while blocked", async () => {
  await agent.post(`/inventories/${inventoryId}/chz-exports`).send({}).expect(422);
});

it("orders six runs once every pre-flight condition holds", async () => {
  await satisfyPreflight();
  const res = await agent.post(`/inventories/${inventoryId}/chz-exports`).send({}).expect(201);
  expect(res.body.runs).toHaveLength(6);
});

it("retries only the named status", async () => {
  await satisfyPreflight();
  await agent.post(`/inventories/${inventoryId}/chz-exports`).send({}).expect(201);
  await failRun("RETIRED");
  const res = await agent
    .post(`/inventories/${inventoryId}/chz-exports/retry`)
    .send({ status: "RETIRED" })
    .expect(200);
  const retired = res.body.runs.find((run: { status: string }) => run.status === "RETIRED");
  expect(retired).toMatchObject({ state: "queued" });
});

it("rejects an unknown status", async () => {
  await agent
    .post(`/inventories/${inventoryId}/chz-exports/retry`)
    .send({ status: "NOPE" })
    .expect(400);
});

it("requires a cabinet session", async () => {
  await request(app!.getHttpServer()).get(`/inventories/${inventoryId}/chz-exports`).expect(401);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-exports.e2e.test.ts`
Expected: FAIL with 404 — the routes do not exist.

- [ ] **Step 3: Implement the controller**

Copy the class-level decorator set from `InventoriesController` (`@Controller("inventories")`, `@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)`, `@AllowSubscriptionReadOnly("read")`), and per-route decorators from its `document-runs` pair — `@RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)` for the GET, `@RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)` plus `@RequireSubscriptionWrite()` for both POSTs, and `@ApiOperation` / `@ApiParam` / `@ApiOkResponse` / `@ApiZodValidationError` / `@ApiHttpErrors(401, 403)` throughout. Give the ordering route a description naming the cost:

```ts
    description:
      "Orders one dispenser export per Chestny ZNAK status. Ordering consumes the tenant's daily task quota, so statuses that are already in flight or imported are left alone.",
```

If you add a second `@Controller("inventories")` class, register it in the same module as the existing one.

- [ ] **Step 4: Register the routes in the pinned inventory**

`apps/api/test/subscription-route-inventory.test.ts` pins every customer route with its guards and subscription policy, and a route missing there fails CI. Run it, read the diff it prints, and add the three entries with their real guards and policy. Do not weaken the assertion.

- [ ] **Step 5: Run the tests**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/chz-exports.e2e.test.ts test/openapi-coverage.test.ts test/subscription-route-inventory.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/chz-exports apps/api/test
git commit -m "feat(api): cabinet endpoints for Chestny ZNAK exports"
```

---

### Task 8: The admin button and per-status state

**Files:**

- Modify: `apps/admin/src/pages/inventory/api.ts`
- Modify: `apps/admin/src/pages/inventory/schemas.ts`
- Modify: `apps/admin/src/pages/inventory/InventoryDetailPage.tsx:236-295`
- Modify: `apps/admin/src/i18n/ru.json`, `apps/admin/src/i18n/en.json`
- Test: `apps/admin/test/inventory-chz-exports.test.tsx`

**Interfaces:**

- Consumes: `GET/POST /inventories/:id/chz-exports`, `POST /inventories/:id/chz-exports/retry` (Task 7).
- Produces: `useChzExportState(inventoryId)`, `useOrderChzExports()`, `useRetryChzExport()` in `apps/admin/src/pages/inventory/api.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/admin/test/inventory-chz-exports.test.tsx`, following the fetch-stubbing style of `apps/admin/test/inventory-preparation.test.tsx`:

```ts
it("disables ordering and names every blocker", async () => {
  stubChzExports({ available: false, blockedBy: ["INN_MISSING", "TOKEN_UNAVAILABLE"], runs: [] });
  renderPreparation();
  const button = await screen.findByRole("button", { name: "Заказать из Честного Знака" });
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(screen.getByText(/ИНН организации/)).toBeDefined();
  expect(screen.getByText(/токен/i)).toBeDefined();
});

it("orders once and shows per-status progress", async () => {
  const user = userEvent.setup();
  stubChzExports({ available: true, blockedBy: [], runs: [] });
  renderPreparation();
  await user.click(await screen.findByRole("button", { name: "Заказать из Честного Знака" }));
  await waitFor(() => expect(orderCalls).toHaveLength(1));
  expect(await screen.findByText("Заказано")).toBeDefined();
});

it("retries only the failed status", async () => {
  const user = userEvent.setup();
  stubChzExports({
    available: true,
    blockedBy: [],
    runs: [
      run("EMITTED", "imported"),
      run("RETIRED", "failed", { errorMessage: "нет действующего договора" }),
    ],
  });
  renderPreparation();
  expect(await screen.findByText("нет действующего договора")).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Повторить" }));
  await waitFor(() => expect(retryCalls).toEqual([{ status: "RETIRED" }]));
});

it("leaves manual upload available regardless of the export state", async () => {
  stubChzExports({ available: false, blockedBy: ["AGENT_NOT_PAIRED"], runs: [] });
  renderPreparation();
  // Manual upload is the fallback and the path for tenants with no agent.
  expect((await screen.findAllByTestId("inventory-upload-slot")).length).toBe(6);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/admin exec vitest run test/inventory-chz-exports.test.tsx`
Expected: FAIL — no such button.

- [ ] **Step 3: Add the schemas and hooks**

In `apps/admin/src/pages/inventory/schemas.ts` add `chzExportStateSchema` mirroring `chzExportStateOpenApiSchema`, and in `api.ts` add the query hook plus the two mutations, invalidating both the export-state key and the inventory key on success so a finished run's import appears in the upload slot without a reload. Follow the file's existing hook style.

- [ ] **Step 4: Render it**

In the exports card in `InventoryDetailPage.tsx` (the component holding the `mk-inventory-upload-grid`), add above the grid: the «Заказать из Честного Знака» button, disabled with the blocker reasons listed when `available` is false; and inside each status slot, the run's state badge, its `errorMessage` when failed, and a «Повторить» button that calls the retry mutation for that status. Poll the state query while any run is non-terminal — a `refetchInterval` that returns `false` once every run is `imported` or `failed`.

Keep the existing `FileDropZone` in every slot unconditionally: manual upload is the documented fallback and the only path for tenants without a signer agent.

- [ ] **Step 5: Add i18n**

Add to both `apps/admin/src/i18n/ru.json` and `en.json` under `pages.inventory.chzExports`: `order`, `ordering`, `retry`, `state.queued`, `state.ordered`, `state.ready`, `state.imported`, `state.failed`, and one key per blocker code (`blocked.INN_MISSING`, `blocked.PRODUCT_GROUP_MISSING`, `blocked.AGENT_NOT_PAIRED`, `blocked.TOKEN_UNAVAILABLE`), each naming what the operator must do rather than what failed. Russian for `INN_MISSING`: «Укажите ИНН организации в реквизитах». The admin test-mode i18n throws on a missing key, so both files must gain every key.

- [ ] **Step 6: Run the tests**

```bash
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck && pnpm --filter @markiro/admin lint
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add apps/admin
git commit -m "feat(admin): order Chestny ZNAK exports from the inventory screen"
```

---

### Task 9: Runbook step and full verification

**Files:**

- Modify: `docs/runbooks/signer-agent-manual-e2e.md`

- [ ] **Step 1: Record the two sandbox questions**

Append a section to `docs/runbooks/signer-agent-manual-e2e.md` covering what only a real tenant against the sandbox can settle:

- whether `PACKAGE_TYPE = "UNIT"` in `apps/api/src/modules/chz-exports/true-api.client.ts` is the value `FILTERED_CIS_REPORT` expects — if ЧЗ rejects the task, the message names the field, and only that constant changes;
- whether the dispenser's CSV is byte-identical to the cabinet export the parser was written against — the parser compares the 35-column header character by character, so a difference surfaces as a parse failure naming the header, and the fix belongs in the one adapter in `chz-export-runner.service.ts`.

State the expected outcome for each so whoever runs it knows what "passed" looks like.

- [ ] **Step 2: Run everything**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/db test
pnpm --filter @markiro/api test
pnpm --filter @markiro/admin test
pnpm --filter @markiro/station test
pnpm format:check
pnpm turbo lint typecheck build --concurrency=1 --force
```

Expected: all green. Paste the counts into the report.

- [ ] **Step 3: Prove the Station diff is empty**

```bash
git diff --stat origin/main -- apps/station packages/db/src/sqlite
```

Expected: no output. If anything appears it is a defect against this plan's constraint — report it rather than accepting it.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs(runbook): sandbox checks for Chestny ZNAK exports" || echo "nothing to commit"
```

---

## Out of scope

- Periodic `cises/info` status refresh for codes already in the system, and the tenant-wide "current status" table it would need.
- Warehouse balances (`/warehouse/balance`, `participant_remains-gismt-*`).
- Ordering exports outside an inventory (a standalone "export codes" screen).
- Automatic ordering on inventory creation — ordering costs quota, and the operator chooses when the data should be current.
- Raising the 8 MiB export ceiling.
