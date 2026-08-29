# Chestny ZNAK Code Status Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a tenant-wide record of what Chestny ZNAK currently says about every marking code the system knows, refreshed in the background through True API's `cises/info`, so the next inventory starts from a query instead of a bulk import.

**Architecture:** One table `chz_code_statuses`, keyed by `(tenant_id, code_hash)` — one row per code, not per scan — holding the ЧЗ facts and a `next_refresh_at`. A single pg-boss cron advances a tenant in two phases per pass: an **ingest** phase that walks `codes` forward from a per-tenant watermark and inserts status rows for codes it has not seen, and a **refresh** phase that takes the most overdue rows, batches them by product group into groups of 1000, joins `codes` for the raw values, and writes back what ЧЗ answers. The raw code is deliberately never copied into the status table.

**Tech Stack:** NestJS 11, Drizzle ORM (Postgres), pg-boss v12, zod 4, React 19 + `@markiro/ui`, vitest.

## Global Constraints

- Monorepo: pnpm + turbo. API tests: `set -a; source .env; set +a` then `pnpm --filter @markiro/api exec vitest run test/<file>`. **Never use `git stash`** — the stash stack is shared across sessions and worktrees.
- Migration flow (AGENTS.md): `set -a; source .env; set +a` → `db:generate` → rename the generated file **and** its `meta/_journal.json` tag → `build` → `test` → `db:migrate`. Never edit an applied migration. **Next migration number: 0101** (last applied: `0100_chz_export_runs`) — verify with `ls packages/db/migrations/*.sql | tail -1` before generating, because `main` moves.
- **`packages/db/src/schema/codes.ts` is query-only.** Its DDL lives in `migrations/0002_partitioned_codes.sql` and the file is excluded from `drizzle.config.ts`'s schema list. Do not alter `codes`, and do not let drizzle-kit try to.
- **The Station is not touched.** `apps/station/**` and `packages/db/src/sqlite/**` must have zero diff.
- **Token values must never reach a log, the integrations journal, or any UI error message.** Journal entries use `channelType: "chestny_znak"` via `JournalService.append`, each wrapped in its own try/catch that logs and continues.
- Every customer route carries OpenAPI decorators (`apps/api/test/openapi-coverage.test.ts` is a hard gate) and is registered in `apps/api/test/subscription-route-inventory.test.ts`, which pins guards and subscription policy.
- i18n keys go in BOTH `apps/admin/src/i18n/ru.json` and `en.json`; the admin test-mode i18n throws on a missing key.
- The repo does not use `@testing-library/jest-dom`; assert against raw DOM properties.
- Repo TS is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; conditional spreads rather than assigning `undefined`. Local imports carry `.js` extensions in `packages/db` and **no** extension in `apps/api/src` / `apps/admin/src`.
- True API limits: `cises/info` takes **1000 codes per request**; the global limit is **50 requests/second per participant**.
- If `tsc` reports errors in unrelated packages, the worktree's `packages/*/dist` is stale: run `pnpm turbo build --filter='./packages/*' --concurrency=1 --force` and re-check.
- Commit footer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

## Status→interval rule (used by Tasks 1, 4 and 6 — keep them in step)

- **in circulation** — `EMITTED`, `APPLIED`, `INTRODUCED`, `DISAGGREGATION` — refresh in 24 hours;
- **withdrawn** — `RETIRED`, `WITHDRAWN`, `WRITTEN_OFF` — refresh in 30 days;
- any other status ЧЗ returns is treated as in-circulation, because asking too often is cheap and quietly losing track of a code is not;
- withdrawn is **not** terminal: ЧЗ permits returning a code to circulation, so these rows keep a due date rather than being retired from the queue.

---

## File Structure

| File                                                                        | Responsibility                                             |
| --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `packages/db/src/schema/chz.ts`                                             | `chzCodeStatuses` and `chzCodeStatusCursors` tables        |
| `packages/db/migrations/0101_chz_code_statuses.sql`                         | Create both tables                                         |
| `apps/api/src/modules/chz-exports/true-api.types.ts`                        | `CisInfo` and the `cisesInfo` result type                  |
| `apps/api/src/modules/chz-exports/true-api.client.ts`                       | `cisesInfo` method                                         |
| `apps/api/src/modules/chz-code-statuses/chz-code-status-ingest.service.ts`  | Watermark walk over `codes`, inserting missing status rows |
| `apps/api/src/modules/chz-code-statuses/chz-code-status-refresh.service.ts` | Due selection, batching, write-back, interval rule         |
| `apps/api/src/modules/chz-code-statuses/chz-code-status-read.service.ts`    | The counts behind the admin line                           |
| `apps/api/src/modules/chz-code-statuses/dto.ts`                             | DTO and OpenAPI schema                                     |
| `apps/api/src/modules/chz-code-statuses/chz-code-statuses.module.ts`        | Wiring                                                     |
| `apps/api/src/modules/integrations/integrations.controller.ts`              | `GET /integrations/:type/code-statuses`                    |
| `apps/api/src/jobs/jobs.module.ts`                                          | Queue, cron, boot pass, `checkReady` count                 |
| `apps/admin/src/pages/integrations/SignerAgentsPanel.tsx`                   | The freshness line                                         |
| `apps/admin/src/pages/integrations/api.ts`                                  | Query hook                                                 |

---

### Task 1: The status store and its cursor

**Files:**

- Modify: `packages/db/src/schema/chz.ts`
- Create (generated, then renamed): `packages/db/migrations/0101_chz_code_statuses.sql`
- Modify: `packages/db/migrations/meta/_journal.json`
- Test: `packages/db/test/chz-code-statuses.test.ts`

**Interfaces:**

- Produces:
  - `chzCodeStatuses` — `tenantId`, `codeHash` (char 64), `chzProductGroupCode` (integer, nullable, FK → `chzProductGroups.code`), `status` (text, nullable), `statusEx` (text, nullable), `ownerInn` (text, nullable), `withdrawReason` (text, nullable), `unknownAttempts` (integer, default 0), `firstSeenAt`, `checkedAt` (nullable), `nextRefreshAt`, `updatedAt`. Primary key `(tenantId, codeHash)`.
  - `chzCodeStatusCursors` — `tenantId` (text, primary key), `lastScannedAt` (timestamptz, nullable), `lastFullSweepAt` (timestamptz, nullable), `updatedAt`.

Tasks 3–6 all read these.

**Addendum, added during Task 3's review:** `lastFullSweepAt` was not part of the
original design below — it was added by a follow-up migration,
`packages/db/migrations/0102_chz_code_status_full_sweep_cursor.sql`, once Task 3's
review found the cursor-only design insufficient (see Task 3's addendum for why).
The column is a single nullable `timestamp with time zone`, added with a plain
`ALTER TABLE ... ADD COLUMN`; nothing about `chzCodeStatuses` or the existing
`lastScannedAt` cursor changed.

- [ ] **Step 1: Write the failing test**

Create `packages/db/test/chz-code-statuses.test.ts`, following the metadata style of its siblings:

```ts
import { describe, expect, it } from "vitest";

import { chzCodeStatuses, chzCodeStatusCursors } from "../src/schema/chz.js";

describe("chz code status schema", () => {
  it("stores the ChZ facts and the refresh bookkeeping, but never the raw code", () => {
    const columns = Object.keys(chzCodeStatuses);
    expect(columns).toEqual(
      expect.arrayContaining([
        "tenantId",
        "codeHash",
        "chzProductGroupCode",
        "status",
        "statusEx",
        "ownerInn",
        "withdrawReason",
        "unknownAttempts",
        "firstSeenAt",
        "checkedAt",
        "nextRefreshAt",
      ]),
    );
    // codes.canonical_raw already holds it; duplicating ~100 bytes per code
    // would enlarge the very thing this store exists to avoid re-reading, and
    // it is what makes a detached `codes` partition stop being polled for free.
    expect(columns).not.toContain("canonicalRaw");
  });

  it("tracks how far the ingest walk has read", () => {
    expect(Object.keys(chzCodeStatusCursors)).toEqual(
      expect.arrayContaining(["tenantId", "lastScannedAt"]),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @markiro/db exec vitest run test/chz-code-statuses.test.ts`
Expected: FAIL — neither table is exported.

- [ ] **Step 3: Add the tables**

In `packages/db/src/schema/chz.ts`. Check the file's existing imports and add only what is missing.

```ts
/**
 * One row per code, not per scan: `codes` is keyed by
 * `(tenant_id, code_hash, scanned_at)` and a code scanned twice has two rows
 * there, while ЧЗ has exactly one opinion about it.
 *
 * The raw code is deliberately absent — the refresh job joins `codes` for the
 * batch it is about to send. `codes` is partitioned monthly, so when an old
 * partition is eventually detached the raw goes with it and the row simply
 * stops being refreshable. Archived codes fall out of the queue by
 * construction rather than by a rule someone has to remember to write.
 */
export const chzCodeStatuses = pgTable(
  "chz_code_statuses",
  {
    tenantId: tenantId(),
    codeHash: char("code_hash", { length: 64 }).notNull(),
    chzProductGroupCode: integer("chz_product_group_code").references(() => chzProductGroups.code),
    status: text("status"),
    statusEx: text("status_ex"),
    ownerInn: text("owner_inn"),
    withdrawReason: text("withdraw_reason"),
    unknownAttempts: integer("unknown_attempts").notNull().default(0),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    nextRefreshAt: timestamp("next_refresh_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.codeHash] }),
    // The refresh query's shape: due rows for one tenant, oldest first, and
    // only those that can actually be asked about.
    index("chz_code_statuses_due_idx")
      .on(t.tenantId, t.nextRefreshAt)
      .where(sql`${t.chzProductGroupCode} is not null`),
    check("chz_code_statuses_hash_check", sql`${t.codeHash} ~ '^[0-9a-f]{64}$'`),
    check("chz_code_statuses_unknown_attempts_check", sql`${t.unknownAttempts} >= 0`),
  ],
);

/**
 * How far the ingest walk has read `codes` for this tenant.
 *
 * Without it, finding codes with no status row is an anti-join across every
 * monthly partition on every pass. With it the walk is a forward range scan on
 * `scanned_at`, which prunes to the partitions that can actually contain new
 * rows — usually just the current month.
 */
export const chzCodeStatusCursors = pgTable("chz_code_status_cursors", {
  tenantId: tenantId().primaryKey(),
  lastScannedAt: timestamp("last_scanned_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

(`lastFullSweepAt` is not shown here — see the addendum above and Task 3's addendum for
why it was added afterward, by a separate migration, rather than folded into this one.)

If `tenantId()` cannot be both a helper and `.primaryKey()` in this codebase's helper shape, declare the cursor's `tenantId` explicitly as `text("tenant_id").primaryKey().references(() => organization.id)` and match how other tenant-keyed singleton tables in this repo do it (`chzApiTokens` is one — read it first).

- [ ] **Step 4: Generate, rename and apply the migration**

```bash
set -a; source .env; set +a
ls packages/db/migrations/*.sql | tail -1   # confirm the next free number
pnpm --filter @markiro/db db:generate
```

Rename the generated SQL to `packages/db/migrations/0101_chz_code_statuses.sql` and its `meta/_journal.json` tag to `0101_chz_code_statuses` (both must match, `"version": "7"`, `"breakpoints": true`, and `"idx"` matching the number you used). Then:

```bash
pnpm --filter @markiro/db build
pnpm --filter @markiro/db test
pnpm --filter @markiro/db db:migrate
```

Expected: build and tests pass, migration applies cleanly.

If `db:generate` stops with `Error: Interactive prompts require a TTY terminal`, it is asking whether a column is a rename; that should not happen for two new tables. Stop and report rather than answering blind.

- [ ] **Step 5: Add runtime migration coverage**

Extend the test file following `packages/db/test/chz-export-runs.test.ts`'s runtime pattern (scratch database, skip when `DATABASE_URL` is absent, same timeouts). Assert:

```ts
it("keeps one status row per code however many times it was scanned", async () => {
  await db.insert(schema.chzCodeStatuses).values({ tenantId, codeHash: HASH_A });
  await expect(
    db.insert(schema.chzCodeStatuses).values({ tenantId, codeHash: HASH_A }),
  ).rejects.toMatchObject({
    cause: expect.objectContaining({ message: expect.stringMatching(/chz_code_statuses_pkey/) }),
  });
});

it("rejects a code hash that is not 64 hex characters", async () => {
  await expect(
    db.insert(schema.chzCodeStatuses).values({ tenantId, codeHash: "not-a-hash" }),
  ).rejects.toMatchObject({
    cause: expect.objectContaining({
      message: expect.stringMatching(/chz_code_statuses_hash_check/),
    }),
  });
});

it("refuses a product group that is not in the dictionary", async () => {
  await expect(
    db
      .insert(schema.chzCodeStatuses)
      .values({ tenantId, codeHash: HASH_B, chzProductGroupCode: 9999 }),
  ).rejects.toMatchObject({ cause: expect.objectContaining({ message: /foreign key/i }) });
});
```

Seed the organization row the tenant foreign keys need, using whatever helper the sibling test uses.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @markiro/db test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db
git commit -m "feat(db): Chestny ZNAK code status store"
```

---

### Task 2: `cisesInfo` on the True API client

**Files:**

- Modify: `apps/api/src/modules/chz-exports/true-api.types.ts`
- Modify: `apps/api/src/modules/chz-exports/true-api.client.ts`
- Test: `apps/api/test/chz-true-api-client.test.ts`

**Interfaces:**

- Consumes: `TrueApiAuth`, `TrueApiResult<T>` (already in `true-api.types.ts`; `TrueApiResult` has four variants — `ok`, `unauthorized`, `rejected`, `unavailable` — and 429 already maps to `unavailable`).
- Produces:
  - `interface CisInfo { cis: string; status: string; statusEx: string | null; ownerInn: string | null; withdrawReason: string | null }`
  - `TrueApiClient.cisesInfo(auth: TrueApiAuth, productGroupCode: number, cises: string[]): Promise<TrueApiResult<CisInfo[]>>`

Task 4 consumes both.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/chz-true-api-client.test.ts`, following the file's existing injected-`fetch` style:

```ts
it("posts the codes as a body and the product group as a query parameter", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = new TrueApiClient(
    deps(async (url, init) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return new Response(
        JSON.stringify([
          {
            cis: "01046000000000172150",
            status: "INTRODUCED",
            statusEx: "MOVING_BY_UD",
            ownerInn: "7700000000",
          },
        ]),
        { status: 200 },
      );
    }),
  );

  const result = await client.cisesInfo(auth, 8, ["01046000000000172150"]);

  expect(calls[0]!.url).toBe(`${auth.baseUrl}/cises/info?pg=8`);
  expect(calls[0]!.init.method).toBe("POST");
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual(["01046000000000172150"]);
  expect(result).toEqual({
    status: "ok",
    value: [
      {
        cis: "01046000000000172150",
        status: "INTRODUCED",
        statusEx: "MOVING_BY_UD",
        ownerInn: "7700000000",
        withdrawReason: null,
      },
    ],
  });
});

it("drops a row with no usable cis rather than inventing one", async () => {
  const client = new TrueApiClient(
    deps(async () => new Response(JSON.stringify([{ status: "INTRODUCED" }]), { status: 200 })),
  );
  // A row we cannot attribute to a code we asked about is worse than absent:
  // the caller matches on `cis`, and an empty string would match nothing
  // while looking like an answer.
  await expect(client.cisesInfo(auth, 8, ["01046000000000172150"])).resolves.toEqual({
    status: "ok",
    value: [],
  });
});

it("refuses to send more than the documented batch size", async () => {
  const client = new TrueApiClient(deps(async () => new Response("[]", { status: 200 })));
  await expect(
    client.cisesInfo(
      auth,
      8,
      Array.from({ length: 1001 }, (_, index) => `cis-${index}`),
    ),
  ).rejects.toThrow(RangeError);
});

it("does not put the token anywhere but the Authorization header", async () => {
  const seen: string[] = [];
  const client = new TrueApiClient(
    deps(async (url, init) => {
      seen.push(String(url), String((init as RequestInit).body ?? ""));
      return new Response("[]", { status: 200 });
    }),
  );
  await client.cisesInfo(auth, 8, ["01046000000000172150"]);
  expect(seen.join("|")).not.toContain("t0ken");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-true-api-client.test.ts`
Expected: FAIL — `cisesInfo` is not a function.

- [ ] **Step 3: Add the type**

In `true-api.types.ts`:

```ts
export interface CisInfo {
  cis: string;
  status: string;
  statusEx: string | null;
  ownerInn: string | null;
  withdrawReason: string | null;
}
```

- [ ] **Step 4: Implement the method**

In `true-api.client.ts`, beside the dispenser methods. Reuse the file's existing private `request` helper and its `stringOrEmpty`-style parsing conventions rather than adding new ones — read the neighbouring methods first and match them.

```ts
/** True API's documented ceiling for one `cises/info` call. */
export const CISES_INFO_BATCH_LIMIT = 1000;
```

```ts
  async cisesInfo(
    auth: TrueApiAuth,
    productGroupCode: number,
    cises: string[],
  ): Promise<TrueApiResult<CisInfo[]>> {
    // A RangeError rather than a silent slice: the caller batches, and a
    // truncated request would look like ЧЗ having no opinion about the codes
    // that were dropped.
    if (cises.length > CISES_INFO_BATCH_LIMIT) {
      throw new RangeError(`cises/info accepts at most ${CISES_INFO_BATCH_LIMIT} codes`);
    }
    const query = new URLSearchParams({ pg: String(productGroupCode) });
    return this.request(
      auth,
      `/cises/info?${query.toString()}`,
      REQUEST_TIMEOUT_MS,
      { method: "POST", body: JSON.stringify(cises) },
      async (response) => {
        const payload: unknown = await response.json();
        // A non-array response is a parse failure. Treating it as an empty
        // answer would mark every code in the batch unknown, potentially
        // backing off a whole product group on a single malformed response.
        if (!Array.isArray(payload)) {
          return null;
        }
        return payload.flatMap((row) => {
          const record = row as Record<string, unknown>;
          const cis = typeof record.cis === "string" ? record.cis : "";
          if (cis.length === 0) return [];
          return [
            {
              cis,
              status: stringOrEmpty(record.status),
              statusEx: typeof record.statusEx === "string" ? record.statusEx : null,
              ownerInn: typeof record.ownerInn === "string" ? record.ownerInn : null,
              withdrawReason:
                typeof record.withdrawReason === "string" ? record.withdrawReason : null,
            },
          ];
        });
      },
    );
  }
```

- [ ] **Step 5: Run the tests**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-true-api-client.test.ts`
Expected: PASS, including the pre-existing dispenser cases.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/chz-exports apps/api/test/chz-true-api-client.test.ts
git commit -m "feat(api): cises/info on the True API client"
```

---

### Task 3: The ingest walk

**Files:**

- Create: `apps/api/src/modules/chz-code-statuses/chz-code-status-ingest.service.ts`
- Test: `apps/api/test/chz-code-status-ingest.service.test.ts`

**Interfaces:**

- Consumes: `chzCodeStatuses`, `chzCodeStatusCursors` (Task 1), `schema.codes`, `schema.products`.
- Consumes additionally: `schema.inventorySnapshotCodes` (`codeHash`, `gtin14`, `canonicalRaw`), the second source of codes.
- Produces: `class ChzCodeStatusIngestService` with
  `run(tenantId: string): Promise<{ inserted: number; watermark: Date | null; caughtUp: boolean }>`.
  Task 5 calls it once per pass before the refresh phase.

**Addendum, added during this task's review — see below the commit step for the
full account:** the design described in this task's steps turned out to have two
defects, both fixed before the task was considered done. `run()` now also
consumes `chzCodeStatusCursors.lastFullSweepAt` (Task 1's addendum) and produces
`CHZ_CODE_STATUS_FULL_SWEEP_INTERVAL_MS` alongside `CHZ_CODE_STATUS_INGEST_LIMIT`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/chz-code-status-ingest.service.test.ts` against a real scratch database, following `apps/api/test/chz-exports.service.test.ts`'s setup:

```ts
it("creates one status row per code and resolves its product group", async () => {
  await seedCode({ codeHash: HASH_A, gtin14: PRODUCT_GTIN, scannedAt: t(1) });

  const result = await service.run(tenantId);

  expect(result.inserted).toBe(1);
  const [row] = await rowsFor(tenantId);
  expect(row).toMatchObject({ codeHash: HASH_A, chzProductGroupCode: 8 });
  // Due immediately: a code nobody has asked ЧЗ about is maximally stale.
  expect(row!.nextRefreshAt.getTime()).toBeLessThanOrEqual(Date.now());
});

it("yields one row for a code scanned twice", async () => {
  await seedCode({ codeHash: HASH_A, gtin14: PRODUCT_GTIN, scannedAt: t(1) });
  await seedCode({ codeHash: HASH_A, gtin14: PRODUCT_GTIN, scannedAt: t(2) });

  await service.run(tenantId);

  expect(await rowsFor(tenantId)).toHaveLength(1);
});

it("stores a code whose product has no ChZ group, and leaves it unaskable", async () => {
  await clearProductGroup(PRODUCT_GTIN);
  await seedCode({ codeHash: HASH_B, gtin14: PRODUCT_GTIN, scannedAt: t(1) });

  await service.run(tenantId);

  const [row] = await rowsFor(tenantId);
  // Stored so the operator can be told it exists and why it is stuck;
  // null group so the refresh query's partial index excludes it.
  expect(row).toMatchObject({ codeHash: HASH_B, chzProductGroupCode: null });
});

it("advances the watermark and does not re-read what it already walked", async () => {
  await seedCode({ codeHash: HASH_A, gtin14: PRODUCT_GTIN, scannedAt: t(1) });
  const first = await service.run(tenantId);
  expect(first.inserted).toBe(1);

  const second = await service.run(tenantId);
  expect(second.inserted).toBe(0);
  expect(second.watermark?.getTime()).toBe(first.watermark?.getTime());
});

it("picks up a code scanned after the last walk", async () => {
  await seedCode({ codeHash: HASH_A, gtin14: PRODUCT_GTIN, scannedAt: t(1) });
  await service.run(tenantId);
  await seedCode({ codeHash: HASH_B, gtin14: PRODUCT_GTIN, scannedAt: t(2) });

  const result = await service.run(tenantId);

  expect(result.inserted).toBe(1);
  expect((await rowsFor(tenantId)).map((row) => row.codeHash).sort()).toEqual(
    [HASH_A, HASH_B].sort(),
  );
});

it("reports that it is not caught up when it hits the per-pass limit", async () => {
  for (let index = 0; index < CHZ_CODE_STATUS_INGEST_LIMIT + 1; index += 1) {
    await seedCode({ codeHash: hash(index), gtin14: PRODUCT_GTIN, scannedAt: t(index) });
  }

  const result = await service.run(tenantId);

  expect(result.inserted).toBe(CHZ_CODE_STATUS_INGEST_LIMIT);
  expect(result.caughtUp).toBe(false);
});

it("also picks up codes that arrived through an inventory export, not a scan", async () => {
  // A tenant whose history predates Markiro is bootstrapped from an ordered
  // export, and those codes land in `inventory_snapshot_codes` — never in
  // `codes`. Walking only the scan table would leave exactly the population
  // this feature exists to stop re-importing invisible to it.
  await seedSnapshotCode({ codeHash: HASH_C, gtin14: PRODUCT_GTIN });

  await service.run(tenantId);

  expect((await rowsFor(tenantId)).map((row) => row.codeHash)).toContain(HASH_C);
});

it("yields one row for a code that was both scanned and exported", async () => {
  await seedCode({ codeHash: HASH_A, gtin14: PRODUCT_GTIN, scannedAt: t(1) });
  await seedSnapshotCode({ codeHash: HASH_A, gtin14: PRODUCT_GTIN });

  await service.run(tenantId);

  expect(await rowsFor(tenantId)).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-code-status-ingest.service.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

```ts
/**
 * How many `codes` rows one pass walks. Bounded so the first pass for a tenant
 * with existing history cannot hold a worker for the length of its entire
 * history; it simply takes several passes, oldest first.
 */
export const CHZ_CODE_STATUS_INGEST_LIMIT = 50_000;
```

The pass spends one shared per-pass row budget across three phases, in this order:

1. **The full sweep, if due.** Skip to step 2 if the budget is exhausted or the sweep is not due yet.
2. **The cursor walk on `codes`.** Skip to step 3 if the budget is exhausted.
3. **The snapshot anti-join on `inventory_snapshot_codes`.** Skip if the budget is exhausted.

**Step 1 — The full sweep (if due):** Full anti-join over `codes` for this tenant, every hash with no status row, regardless of `scanned_at`. Run at most once per `CHZ_CODE_STATUS_FULL_SWEEP_INTERVAL_MS` (24 hours). The sweep catches codes committed with a `scanned_at` behind the cursor — normal for a Station syncing after an outage (see `WINDOW_PAST_MS` in `station-scans.service.ts`). A tenant backfilling from deep history can fill the cursor walk's entire budget on consecutive passes, starving the sweep during exactly the backfill it is meant to protect. Giving the sweep first claim on the budget costs the steady state almost nothing, while the cursor walk absorbs what is left.

**Step 2 — The cursor walk:** Select from `codes` where `tenantId` matches and `scannedAt > lastScannedAt` (or no lower bound on the first pass), ordered by `scannedAt` ascending, selecting `codeHash`, `gtin14`, `scannedAt`. **Order by `scannedAt` and bound on it**, not on `codeHash` — that is what lets Postgres prune the monthly partitions. This is the cheap, steady-state path. Resolve product groups for the distinct GTINs in one query joining `products` on `(tenantId, gtin14)`. Insert the rows with `onConflictDoNothing` on `(tenantId, codeHash)`, `nextRefreshAt` = now, `chzProductGroupCode` from the map or null. Upsert the cursor to the largest `scannedAt` in the batch. Do **not** advance it when the batch was empty.

**Step 3 — The snapshot anti-join:** Codes that reached the tenant through an ordered export live in `inventory_snapshot_codes`, not in `codes`, and that is precisely the population a tenant with history predating Markiro is bootstrapped from. Run an anti-join pass over `inventory_snapshot_codes` for this tenant, inserting any hash with no status row — same `onConflictDoNothing`, same product-group resolution. That table is not partitioned and does not grow per scan, so an anti-join over it is affordable and needs no cursor of its own. Both sources insert on the same `(tenantId, codeHash)` key, so a code that was scanned _and_ exported yields exactly one row.

**One subtlety to handle explicitly:** Several `codes` rows can share the same `scannedAt`. Advancing the cursor to that exact timestamp with a strict `>` on the next pass would skip any sibling rows that fell outside the limit. Take the largest `scannedAt` **only when the batch was smaller than the limit**; when the batch filled the limit, advance to the largest `scannedAt` that is strictly less than the last row's, so no timestamp is ever half-walked. If that leaves no progress (every row in the batch shares one timestamp), raise the limit for that pass rather than looping forever — forward progress on the cursor takes priority over the pass's nominal budget when the two conflict, because a cursor that never advances is a worse failure than one pass running a little long.

Return `{ inserted, watermark, caughtUp: all three phases fit within the budget }`.

**A second source, walked the same way.** Codes that reached the tenant through an ordered export live in `inventory_snapshot_codes`, not in `codes`, and that is precisely the population a tenant with history predating Markiro is bootstrapped from. After the `codes` walk, run a second anti-join pass over `inventory_snapshot_codes` for this tenant, inserting any hash with no status row — same `onConflictDoNothing`, same product-group resolution, same per-pass limit shared with the first phase.

That table is not partitioned and does not grow per scan, so an anti-join over it is affordable and needs no cursor of its own. Both sources insert on the same `(tenantId, codeHash)` key, so a code that was scanned _and_ exported yields exactly one row.

One subtlety to handle explicitly rather than discover: several `codes` rows can share the same `scannedAt`. Advancing the cursor to that exact timestamp with a strict `>` on the next pass would skip any sibling rows that fell outside the limit. Take the largest `scannedAt` **only when the batch was smaller than the limit**; when the batch filled the limit, advance to the largest `scannedAt` that is strictly less than the last row's, so no timestamp is ever half-walked. If that leaves no progress (every row in the batch shares one timestamp), raise the limit for that pass rather than looping forever — and say in your report how you handled it.

- [ ] **Step 4: Run the tests**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-code-status-ingest.service.test.ts`
Expected: PASS, all six cases.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/chz-code-statuses apps/api/test/chz-code-status-ingest.service.test.ts
git commit -m "feat(api): ingest walk for Chestny ZNAK code statuses"
```

**Addendum, added during this task's review:** two defects in the design above
were found and fixed in a follow-up commit, before Task 4 began.

1. **The cursor can permanently miss codes, and it is not an edge case.**
   `codes.scanned_at` is the Station's own clock, not a commit timestamp, and
   the station-scans ingest endpoint accepts a `scannedAt` up to three years in
   the past (`WINDOW_PAST_MS` in `station-scans.service.ts`) because a device's
   queue can legitimately carry weeks-to-months of backlog after an outage, a
   warehoused spare being redeployed, or repeated dead-RTC reboots. A code can
   therefore be committed with a `scanned_at` the cursor has already passed,
   and the cursor's strict `>` skips it forever — offline-then-sync is the
   Station's normal operating mode, not a corner case.

   Fix: the cursor walk stays as designed above for the steady state, and a
   **full anti-join sweep** over `codes` was added alongside it — the same
   shape as the existing `inventory_snapshot_codes` anti-join, but against
   `codes`, ignoring `scanned_at` entirely. It runs at most once per tenant
   per `CHZ_CODE_STATUS_FULL_SWEEP_INTERVAL_MS` (24 hours — the same cadence a
   code already in the store refreshes at, so a late arrival joins the store
   within the period it would have been refreshed in anyway). How recently it
   last ran is tracked in `chzCodeStatusCursors.lastFullSweepAt` (Task 1's
   addendum).

2. **The two (now three) sources did not share one per-pass limit.** As
   designed above, `run()` bounded the `codes` walk and the snapshot anti-join
   by `CHZ_CODE_STATUS_INGEST_LIMIT` independently, so one pass could insert up
   to twice the intended bound — more once the escalation loop enlarges the
   first phase's own limit. Fixed by giving the pass one shared budget, spent
   in order (cursor walk, then the sweep if due, then the snapshot anti-join),
   each phase receiving whatever the previous phases left of it and being
   skipped once it hits zero. A phase skipped this way is counted as "not
   caught up", since with no budget left there is no way to check whether it
   had more rows waiting without spending more than the pass is allowed.

The degenerate-cursor escalation loop (this task's Step 3, "One subtlety to
handle explicitly") also gained a dedicated test: `CHZ_CODE_STATUS_INGEST_LIMIT

- 1`rows sharing one`scanned_at`, asserting the pass terminates and that a
  later-timestamped row added afterward is not skipped.

```bash
git add apps/api/src/modules/chz-code-statuses apps/api/test/chz-code-status-ingest.service.test.ts packages/db
git commit -m "fix(chz): add a full sweep and a shared ingest budget"
```

---

### Task 4: The refresh pass

**Files:**

- Create: `apps/api/src/modules/chz-code-statuses/chz-code-status-refresh.service.ts`
- Test: `apps/api/test/chz-code-status-refresh.service.test.ts`

**Interfaces:**

- Consumes: `chzCodeStatuses` (Task 1), `TrueApiClient.cisesInfo` and `CisInfo` (Task 2), `ChzTokenService.getActiveToken` (returns `{status:"ok",auth}` | `unconfigured` | `missing` | `expired` | `undecryptable` — branch on `status !== "ok"`), `JournalService.append`.
- Produces: `class ChzCodeStatusRefreshService` with
  `run(tenantId: string): Promise<{ batches: number; updated: number; caughtUp: boolean }>`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/chz-code-status-refresh.service.test.ts`, driving a fake `TrueApiClient` against a real scratch database:

```ts
it("asks only about due rows that have a product group, oldest first", async () => {
  await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(2) });
  await seedStatus({ codeHash: HASH_B, group: 8, nextRefreshAt: past(1) });
  await seedStatus({ codeHash: HASH_C, group: null, nextRefreshAt: past(3) });
  await seedStatus({ codeHash: HASH_D, group: 8, nextRefreshAt: future(1) });

  await service.run(tenantId);

  expect(client.calls).toHaveLength(1);
  expect(client.calls[0]!.cises).toEqual([RAW_A, RAW_B]);
});

it("splits a batch per product group, because pg is a query parameter", async () => {
  await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(1) });
  await seedStatus({ codeHash: HASH_B, group: 15, nextRefreshAt: past(1) });

  await service.run(tenantId);

  expect(client.calls.map((call) => call.productGroupCode).sort()).toEqual([8, 15]);
});

it("writes back the facts and sets the daily interval for a code in circulation", async () => {
  await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(1) });
  client.answer([
    {
      cis: RAW_A,
      status: "INTRODUCED",
      statusEx: "MOVING_BY_UD",
      ownerInn: "7700000000",
      withdrawReason: null,
    },
  ]);

  await service.run(tenantId);

  const [row] = await rowsFor(tenantId);
  expect(row).toMatchObject({
    status: "INTRODUCED",
    statusEx: "MOVING_BY_UD",
    ownerInn: "7700000000",
    unknownAttempts: 0,
  });
  expect(hoursUntil(row!.nextRefreshAt)).toBeCloseTo(24, 0);
});

it("gives a withdrawn code the monthly interval without retiring it", async () => {
  await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(1) });
  client.answer([
    { cis: RAW_A, status: "RETIRED", statusEx: null, ownerInn: null, withdrawReason: "SOLD" },
  ]);

  await service.run(tenantId);

  const [row] = await rowsFor(tenantId);
  expect(row!.status).toBe("RETIRED");
  // Not null: ChZ permits returning a code to circulation, so a withdrawn
  // code must stay in the queue, just far out.
  expect(row!.nextRefreshAt).not.toBeNull();
  expect(daysUntil(row!.nextRefreshAt)).toBeCloseTo(30, 0);
});

it("returns a revived code to the daily interval", async () => {
  await seedStatus({ codeHash: HASH_A, group: 8, status: "RETIRED", nextRefreshAt: past(1) });
  client.answer([
    { cis: RAW_A, status: "INTRODUCED", statusEx: null, ownerInn: null, withdrawReason: null },
  ]);

  await service.run(tenantId);

  expect(hoursUntil((await rowsFor(tenantId))[0]!.nextRefreshAt)).toBeCloseTo(24, 0);
});

it("treats an unrecognised status as in circulation", async () => {
  await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(1) });
  client.answer([
    { cis: RAW_A, status: "SOMETHING_NEW", statusEx: null, ownerInn: null, withdrawReason: null },
  ]);

  await service.run(tenantId);

  const [row] = await rowsFor(tenantId);
  expect(row!.status).toBe("SOMETHING_NEW");
  expect(hoursUntil(row!.nextRefreshAt)).toBeCloseTo(24, 0);
});

it("counts a code ChZ did not answer for, and backs it off after the retry limit", async () => {
  await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(1) });
  client.answer([]);

  for (let attempt = 1; attempt <= CHZ_STATUS_UNKNOWN_RETRY_LIMIT; attempt += 1) {
    await makeDue(HASH_A);
    await service.run(tenantId);
    expect((await rowsFor(tenantId))[0]!.unknownAttempts).toBe(attempt);
  }

  // Never dropped: an unknown code means it belongs to someone else or is
  // malformed, and that is a fact the operator needs.
  const [row] = await rowsFor(tenantId);
  expect(row!.status).toBeNull();
  expect(daysUntil(row!.nextRefreshAt)).toBeCloseTo(30, 0);
});

it("leaves rows due and untouched when the call fails transiently", async () => {
  await seedStatus({ codeHash: HASH_A, group: 8, status: "INTRODUCED", nextRefreshAt: past(1) });
  client.fail({ status: "unavailable" });

  const result = await service.run(tenantId);

  const [row] = await rowsFor(tenantId);
  // A failed batch must never advance checkedAt: staleness has to stay
  // visible rather than be papered over by a timestamp that records an
  // attempt instead of an answer.
  expect(row).toMatchObject({ status: "INTRODUCED", checkedAt: null });
  expect(row!.nextRefreshAt.getTime()).toBeLessThanOrEqual(Date.now());
  expect(result.caughtUp).toBe(false);
});

it("backs a rejected product group off instead of retrying the refusal forever", async () => {
  await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(1) });
  client.fail({ status: "rejected", code: "400", message: "no active contract" });

  await service.run(tenantId);

  expect(daysUntil((await rowsFor(tenantId))[0]!.nextRefreshAt)).toBeCloseTo(30, 0);
});

it("does nothing and reports not caught up when no token is available", async () => {
  await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(1) });
  tokens.getActiveToken.mockResolvedValue({ status: "expired" });

  const result = await service.run(tenantId);

  expect(client.calls).toHaveLength(0);
  expect(result).toMatchObject({ batches: 0, caughtUp: false });
});

it("never writes the token into the journal", async () => {
  await seedStatus({ codeHash: HASH_A, group: 8, nextRefreshAt: past(1) });
  await service.run(tenantId);
  expect(JSON.stringify(journal.append.mock.calls)).not.toContain(TEST_TOKEN);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-code-status-refresh.service.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

```ts
export const CHZ_STATUS_BATCH_SIZE = 1000;
/** Batches per pass, so one tenant cannot monopolise the worker. */
export const CHZ_STATUS_MAX_BATCHES_PER_PASS = 20;
export const CHZ_STATUS_UNKNOWN_RETRY_LIMIT = 3;

const IN_CIRCULATION_STATUSES = new Set(["EMITTED", "APPLIED", "INTRODUCED", "DISAGGREGATION"]);
const WITHDRAWN_STATUSES = new Set(["RETIRED", "WITHDRAWN", "WRITTEN_OFF"]);

export const CHZ_STATUS_IN_CIRCULATION_INTERVAL_MS = 24 * 60 * 60_000;
export const CHZ_STATUS_WITHDRAWN_INTERVAL_MS = 30 * 24 * 60 * 60_000;

/**
 * Withdrawn is not terminal — ЧЗ permits returning a code to circulation —
 * so this returns a long interval rather than null. An unrecognised status
 * gets the short one: asking too often is cheap, and quietly losing track of
 * a code is not.
 */
function intervalFor(status: string): number {
  if (WITHDRAWN_STATUSES.has(status)) return CHZ_STATUS_WITHDRAWN_INTERVAL_MS;
  return CHZ_STATUS_IN_CIRCULATION_INTERVAL_MS;
}
```

The pass:

1. `getActiveToken`. On anything but `ok`, journal a warning and return `{ batches: 0, updated: 0, caughtUp: false }` — nothing else in this pass can proceed without it.
2. Loop up to `CHZ_STATUS_MAX_BATCHES_PER_PASS`. Each iteration: select up to `CHZ_STATUS_BATCH_SIZE` rows for this tenant where `nextRefreshAt <= now` and `chzProductGroupCode is not null`, ordered by `nextRefreshAt` ascending, **all sharing the batch's first product group** (`cises/info` takes one `pg` per call).

   Resolve each hash to its raw code from **either** source, preferring `codes` and falling back to `inventory_snapshot_codes` — the ingest walks both, so a bootstrapped code has a status row but no scan. Take any one row per hash from whichever source answers.

3. Call `cisesInfo(auth, productGroupCode, raws)`.
   - `ok`: build a `Map<cis, CisInfo>` from the answer. For each row in the batch, look up its raw. Found → write the facts, `checkedAt = now`, `unknownAttempts = 0`, `nextRefreshAt = now + intervalFor(status)`. Not found → increment `unknownAttempts`; under the limit, leave the facts alone and set a short interval so it is retried; at or past the limit, set the long interval and leave `status` null. A `cis` ЧЗ returned that we did not ask about is ignored and journalled once per batch.
   - `unavailable`: leave every row in the batch untouched — no `checkedAt`, no new `nextRefreshAt` — and stop the pass, returning `caughtUp: false`.
   - `rejected`: push the batch's rows to the long interval, journal the ЧЗ message, and continue with the next product group. Retrying a refusal is what this branch exists to avoid.
   - `unauthorized`: treat as the token case in step 1 and stop.
4. A row whose hash resolves to no raw in either source — its `codes` partition was detached and it never came from an export — is pushed to the long interval and skipped, not failed. It is unrefreshable by design, and that is the mechanism by which archived codes leave the queue.
5. Journal each pass once: batches, rows updated, rows unknown. Wrap the append in its own try/catch that logs and continues, as `signer-scheduler.service.ts` does — a failed audit write is not a reason to abandon a pass.
6. Return `{ batches, updated, caughtUp: no due rows remained }`.

- [ ] **Step 4: Run the tests**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-code-status-refresh.service.test.ts`
Expected: PASS, all eleven cases.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/chz-code-statuses apps/api/test/chz-code-status-refresh.service.test.ts
git commit -m "feat(api): refresh Chestny ZNAK code statuses through cises/info"
```

---

### Task 5: Job wiring

**Files:**

- Create: `apps/api/src/modules/chz-code-statuses/chz-code-statuses.module.ts`
- Modify: `apps/api/src/jobs/jobs.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/chz-code-status-job.test.ts`

**Interfaces:**

- Consumes: `ChzCodeStatusIngestService.run` (Task 3), `ChzCodeStatusRefreshService.run` (Task 4).
- Produces: `REFRESH_CHZ_CODE_STATUSES_QUEUE = "refresh-chz-code-statuses"` exported from `jobs.module.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/chz-code-status-job.test.ts`, following `apps/api/test/chz-export-job.test.ts`'s mocked-pg-boss style:

```ts
it("ingests before refreshing, so codes scanned since the last pass are asked about", async () => {
  await handler();
  expect(ingest.run.mock.invocationCallOrder[0]).toBeLessThan(
    refresh.run.mock.invocationCallOrder[0]!,
  );
});

it("runs once per tenant with the ChZ channel enabled", async () => {
  await seedTenantsWithChzChannel(["tenant-a", "tenant-b"]);
  await seedTenantWithoutChzChannel("tenant-c");

  await handler();

  expect(refresh.run.mock.calls.map(([id]) => id).sort()).toEqual(["tenant-a", "tenant-b"]);
});

it("keeps going when one tenant throws", async () => {
  await seedTenantsWithChzChannel(["tenant-a", "tenant-b"]);
  refresh.run.mockRejectedValueOnce(new Error("boom"));

  await expect(handler()).resolves.not.toThrow();
  expect(refresh.run).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-code-status-job.test.ts`
Expected: FAIL — `REFRESH_CHZ_CODE_STATUSES_QUEUE` is not exported.

- [ ] **Step 3: Wire the queue**

In `jobs.module.ts`, beside the other cron queues:

```ts
export const REFRESH_CHZ_CODE_STATUSES_QUEUE = "refresh-chz-code-statuses";
/**
 * Ten minutes, not one: `cises/info` answers about 1000 codes per request, so
 * even a large population is minutes of traffic, and the data it reports
 * changes on the order of hours. The pass is bounded per tenant, so a backlog
 * drains over several ticks rather than in one long hold on the worker.
 */
const REFRESH_CHZ_CODE_STATUSES_CRON = "*/10 * * * *";
```

Register it exactly as `CHZ_SIGNER_SCHEDULER_QUEUE_NAME` is (`createQueue` → `schedule` → `work`), calling a service method that, for each tenant with the `chestny_znak` channel enabled, runs the ingest then the refresh, each tenant wrapped in its own try/catch that logs and continues. Take the tenant selection from `signer-scheduler.service.ts` rather than inventing one.

**One pass per tick, not a loop to exhaustion.** Both phases already bound themselves, and a queue that drains fully on one tick would hold the worker for as long as the backlog takes.

- [ ] **Step 4: Raise the worker count**

`checkReady()` hardcodes the expected worker count. It is currently `14`; this queue makes `15`. `apps/api/test/health.e2e.test.ts` and `apps/api/test/jobs-readiness.test.ts` are what catch a mistake — update the latter's `WORKER_IDS` fixture to match.

- [ ] **Step 5: Create the module and register it**

`chz-code-statuses.module.ts` providing `ChzCodeStatusIngestService`, `ChzCodeStatusRefreshService`, `ChzTokenService` and `TrueApiClient`, and exporting the two runner services.

`TrueApiClient`'s constructor parameter is an interface, which Nest cannot auto-wire from `design:paramtypes` — it needs a factory provider. `jobs.module.ts` and `chz-exports.module.ts` both already have one; copy it rather than registering the class directly, or the whole app fails to bootstrap.

Register the module in `app.module.ts`.

- [ ] **Step 6: Run the tests**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/chz-code-status-job.test.ts test/jobs-readiness.test.ts test/health.e2e.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/jobs apps/api/src/modules/chz-code-statuses apps/api/src/app.module.ts apps/api/test/chz-code-status-job.test.ts apps/api/test/jobs-readiness.test.ts
git commit -m "feat(api): schedule Chestny ZNAK code status refresh"
```

---

### Task 6: The freshness line

**Files:**

- Create: `apps/api/src/modules/chz-code-statuses/chz-code-status-read.service.ts`
- Create: `apps/api/src/modules/chz-code-statuses/dto.ts`
- Modify: `apps/api/src/modules/integrations/integrations.controller.ts`
- Modify: `apps/api/test/subscription-route-inventory.test.ts`
- Modify: `apps/admin/src/pages/integrations/api.ts`
- Modify: `apps/admin/src/pages/integrations/SignerAgentsPanel.tsx`
- Modify: `apps/admin/src/i18n/{ru,en}.json`
- Test: `apps/api/test/chz-code-statuses.e2e.test.ts`, `apps/admin/test/integrations-chz-code-statuses.test.tsx`

**Interfaces:**

- Consumes: `chzCodeStatuses` (Task 1).
- Produces: `GET /integrations/:type/code-statuses` returning
  `{ total: number; refreshedLastDay: number; withoutProductGroup: number; lastCheckedAt: string | null }`,
  and `useChzCodeStatusSummary()` in the admin integrations `api.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/chz-code-statuses.e2e.test.ts`, bootstrapped like `apps/api/test/chz-exports.e2e.test.ts` and importing `signUpAndActivate` from `./support/auth` — do **not** paste a local copy, because the inline password literal it carries is what GitGuardian flags on new files.

```ts
it("counts the store and reports how fresh it is", async () => {
  await seedStatus({ codeHash: HASH_A, group: 8, checkedAt: hoursAgo(1) });
  await seedStatus({ codeHash: HASH_B, group: 8, checkedAt: hoursAgo(30) });
  await seedStatus({ codeHash: HASH_C, group: null, checkedAt: null });

  const res = await agent.get("/integrations/chestny_znak/code-statuses").expect(200);

  expect(res.body).toMatchObject({
    total: 3,
    refreshedLastDay: 1,
    withoutProductGroup: 1,
  });
  expect(Date.parse(res.body.lastCheckedAt)).toBe(hoursAgo(1).getTime());
});

it("answers with zeroes for a tenant that has never run a pass", async () => {
  const res = await agent.get("/integrations/chestny_znak/code-statuses").expect(200);
  expect(res.body).toEqual({
    total: 0,
    refreshedLastDay: 0,
    withoutProductGroup: 0,
    lastCheckedAt: null,
  });
});

it("requires a cabinet session", async () => {
  await request(app!.getHttpServer()).get("/integrations/chestny_znak/code-statuses").expect(401);
});
```

Match the behaviour of the existing `:type/candidates` route for a non-`chestny_znak` type, and assert it — read that handler before writing yours rather than guessing whether it 404s or returns empty.

- [ ] **Step 2: Run test to verify it fails**

Run: `set -a; source .env; set +a; pnpm --filter @markiro/api exec vitest run test/chz-code-statuses.e2e.test.ts`
Expected: FAIL with 404 — the route does not exist.

- [ ] **Step 3: Implement the read service and the route**

The service runs one aggregate query: `count(*)`, `count(*) filter (where checked_at > now() - interval '1 day')`, `count(*) filter (where chz_product_group_code is null)`, `max(checked_at)`.

Add the route to `IntegrationsController` beside `:type/journal` and `:type/candidates`, copying their guard and decorator set exactly. Then run `apps/api/test/subscription-route-inventory.test.ts`, read the diff it prints, and add the entry with its real guards and policy. Do not weaken that assertion — a route missing from it fails CI.

- [ ] **Step 4: Add the admin line**

In `SignerAgentsPanel.tsx` — the `chestny_znak` channel's own panel — render one line under the existing content: how many codes are known, how many were refreshed in the last day, and how long ago the last pass ran. When `withoutProductGroup` is above zero, add a second line naming it, because that is the one number the operator can act on: those codes are stuck until their product gets a ЧЗ group.

Add the keys to both `apps/admin/src/i18n/ru.json` and `en.json`.

The admin test asserts the counts render and that the stuck-codes line appears only when the count is non-zero. Stub the fetch the way `apps/admin/test/integrations.test.tsx` does.

- [ ] **Step 5: Run the tests**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/api exec vitest run test/chz-code-statuses.e2e.test.ts test/openapi-coverage.test.ts test/subscription-route-inventory.test.ts
pnpm --filter @markiro/admin test
pnpm --filter @markiro/admin typecheck && pnpm --filter @markiro/admin lint
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/chz-code-statuses apps/api/src/modules/integrations apps/api/test apps/admin
git commit -m "feat(admin): show Chestny ZNAK code status freshness"
```

---

### Task 7: Runbook and full verification

**Files:**

- Modify: `docs/runbooks/signer-agent-manual-e2e.md`

- [ ] **Step 1: Record the sandbox question**

Append a section covering what only a real tenant can settle: the response shape of `cises/info`. State that the parsing lives in one place — `TrueApiClient.cisesInfo` — so settling it changes one function.

Give the pass and fail criteria the way the existing export sections do: **pass** is a refresh pass moving rows from `status = null` to a real status, visible in the integration panel's freshness line; **fail** is every code coming back unknown, which means the response is shaped differently than assumed and `cisesInfo`'s parser needs the real field names. Note that a wrong `pg` shows up instead as a `rejected` refusal, which the panel reports separately.

- [ ] **Step 2: Run everything**

```bash
set -a; source .env; set +a
pnpm --filter @markiro/db test
pnpm --filter @markiro/api test
pnpm --filter @markiro/admin test
pnpm --filter @markiro/station test
pnpm --filter @markiro/saas-admin test
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
git add -A && git commit -m "docs(runbook): sandbox check for cises/info" || echo "nothing to commit"
```

---

## Out of scope

- Fixing an inventory snapshot from this store instead of from six imports. That is the payoff and the next slice; the invariant it touches is guarded in four layers plus a composite foreign key.
- Retention, archival and purging. `codes` and `scan_events` are already partitioned monthly, so the eventual answer is detaching and archiving an old partition rather than deleting rows by status.
- Refreshing on events — shift close, before a shipment.
- Alerting on an unfavourable status change.
- Per-code lookup in the UI.
