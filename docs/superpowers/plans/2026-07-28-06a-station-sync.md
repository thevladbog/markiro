# Station Sync & Shift Exit (06a) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get every scan off the device and onto the server reliably and idempotently, show the operator whether it worked, and let the operator leave a shift.

**Architecture:** Each scan enqueues a row in a new device-local `outbox` table; a serialized drain sends batches of 200 to `POST /station/scans` and acknowledges with a single `DELETE ... WHERE id <= ?`. The server applies a whole batch and records its idempotency key in one Postgres transaction, so a retry is a no-op. The status bar shows the pending count and warns only when the queue has stopped moving.

**Tech Stack:** TypeScript/React 19 (station webview), `tauri-plugin-sql` (SQLite), NestJS 11 + Drizzle + Postgres (API), vitest + `node:sqlite`, supertest e2e against a real Postgres.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-28-station-sync-design.md`. Every task's requirements implicitly include this section.
- **On the device a single SQL statement is the only atomic unit.** `tauri-plugin-sql` opens SQLite through a connection pool and hands a possibly different connection to each call, so a multi-call `BEGIN`/`COMMIT` is NOT a transaction. Never introduce one on the device. `apps/station/src/lib/journal.ts` documents this at length — read it.
- **On the server, `this.db.transaction(async (tx) => ...)` is a real transaction.** Use it; the established call sites are `station-devices.service.ts` and `pickup-orders.service.ts`.
- **Sync never blocks scanning.** No modal, no full-screen alarm, no gating a scan on the network. Offline is a normal operating mode.
- **Multi-tenancy: every query is tenant-scoped in the SQL statement itself, mutations included.**
- **`POST /station/scans` must stay reachable by a station api-key** — `TenantGuard` only, never `SessionOnlyGuard`. Follow `apps/api/src/modules/operators/station-operators.controller.ts`.
- **i18n RU + EN in lockstep** — the station throws on a missing key in test mode and a parity test exists; add every key to BOTH `apps/station/src/i18n/ru.json` and `en.json`.
- Floor mode: dark default, touch targets ≥64px.
- No new npm dependencies. Do NOT edit `.npmrc` (adding `minimumReleaseAgeExclude` is task failure).
- Conventional commits, English, no co-author lines.
- Station tests: `pnpm --filter @markiro/station test`. DB: `pnpm --filter @markiro/db test`. API e2e need Postgres on localhost:5432 and `DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173` — without them the suites silently skip, so confirm they ran.
- Run `lint` and `typecheck` for every package you touch, and `pnpm exec prettier --check` on every file, before committing.

## File Structure

| File                                                             | Responsibility                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| `packages/db/src/sqlite/{schema,migrations}.ts` (modify)         | `outbox` table on the device                                  |
| `apps/station/src/lib/journal.ts` (modify)                       | Enqueue each scan into the outbox                             |
| `apps/station/src/lib/outbox.ts` (new)                           | Read a batch, acknowledge through an id, report depth and age |
| `packages/db/migrations/0011_*.sql` + `src/schema/` (new/modify) | `sync_batches` table, `shifts.late_data_at`                   |
| `apps/api/src/modules/station-scans/` (new)                      | Ingest DTO, service, controller                               |
| `apps/api/src/modules/shifts/{dto,shifts.service}.ts` (modify)   | Expose `lateDataAt` on every shift response                   |
| `apps/admin/src/pages/shifts/` (modify)                          | Late-data badge in the cabinet                                |
| `apps/station/src/lib/sync.ts` (new)                             | Serialized drain loop, backoff, state reporting               |
| `apps/station/src/ui/{StatusBar,FloorShell}.tsx` (modify)        | Pending count and stuck warning                               |
| `apps/station/src/App.tsx` (modify)                              | Own the sync engine, thread its state                         |
| `apps/station/src/pages/WorkScreen.tsx` (modify)                 | Exit the shift                                                |
| `docs/device-key-surface.md` (modify)                            | Record the new device-reachable route                         |

---

### Task 1: Outbox table and enqueue on every scan

**Files:**

- Modify: `packages/db/src/sqlite/schema.ts`, `packages/db/src/sqlite/migrations.ts`, `apps/station/src/lib/journal.ts`
- Test: `apps/station/test/journal.test.ts`, `packages/db/test/sqlite-schema.test.ts`

**Interfaces:**

- Produces: the `outbox` table; `recordScan` keeps its signature `recordScan(exec, e: ScanEventRow, code: AcceptedCode | null): Promise<RecordScanResult>` and additionally enqueues one outbox row per call.

**Why the enqueue lives inside `recordScan`:** it is the single place every scan passes through, so no call site can forget it, and it is the only place that knows the _corrected_ verdict — `recordScan` rewrites `ok` to `duplicate` when the code insert hits the primary key.

- [ ] **Step 1: Write the failing test**

Append to `apps/station/test/journal.test.ts` (the file already builds an executor with `applyMigrations`; reuse its helpers):

```ts
describe("outbox", () => {
  it("enqueues an accepted scan with its code payload", async () => {
    const exec = await migratedExec();
    await recordScan(
      exec,
      {
        shiftId: "s1",
        terminalId: "t1",
        raw: "RAW1",
        verdict: "ok",
        scannedAt: "2026-07-28T10:00:00.000Z",
      },
      {
        codeHash: "h1",
        shiftId: "s1",
        gtin14: "04600000000017",
        serial: "AB1",
        scannedAt: "2026-07-28T10:00:00.000Z",
      },
    );

    const rows = await exec.all<{
      shift_id: string;
      verdict: string;
      code_hash: string | null;
      gtin14: string | null;
      serial: string | null;
    }>("SELECT shift_id, verdict, code_hash, gtin14, serial FROM outbox ORDER BY id");
    expect(rows).toEqual([
      { shift_id: "s1", verdict: "ok", code_hash: "h1", gtin14: "04600000000017", serial: "AB1" },
    ]);
  });

  it("enqueues a rejected scan with no code payload", async () => {
    const exec = await migratedExec();
    await recordScan(
      exec,
      {
        shiftId: "s1",
        terminalId: null,
        raw: "junk",
        verdict: "invalid",
        scannedAt: "2026-07-28T10:00:01.000Z",
      },
      null,
    );

    const rows = await exec.all<{ verdict: string; code_hash: string | null }>(
      "SELECT verdict, code_hash FROM outbox",
    );
    expect(rows).toEqual([{ verdict: "invalid", code_hash: null }]);
  });

  it("enqueues the CORRECTED verdict and no code when the code was already present", async () => {
    const exec = await migratedExec();
    const code = {
      codeHash: "h1",
      shiftId: "s1",
      gtin14: "04600000000017",
      serial: "AB1",
      scannedAt: "2026-07-28T10:00:00.000Z",
    };
    await recordScan(
      exec,
      { shiftId: "s1", terminalId: null, raw: "RAW1", verdict: "ok", scannedAt: code.scannedAt },
      code,
    );

    // Same code again: the primary key rejects it, so the scan is a duplicate.
    const result = await recordScan(
      exec,
      {
        shiftId: "s1",
        terminalId: null,
        raw: "RAW1",
        verdict: "ok",
        scannedAt: "2026-07-28T10:00:05.000Z",
      },
      { ...code, scannedAt: "2026-07-28T10:00:05.000Z" },
    );
    expect(result.alreadyPresent).toBe(true);

    const rows = await exec.all<{ verdict: string; code_hash: string | null }>(
      "SELECT verdict, code_hash FROM outbox ORDER BY id",
    );
    // The second row must NOT carry a code: this device already queued it once,
    // and sending it again would write a second server row for one physical item.
    expect(rows).toEqual([
      { verdict: "ok", code_hash: "h1" },
      { verdict: "duplicate", code_hash: null },
    ]);
  });

  it("throws when the outbox write fails, rather than losing the scan silently", async () => {
    const exec = await migratedExec();
    const failing: SqlExecutor = {
      run: async (sql, params) => {
        if (/INTO outbox/i.test(sql)) throw new Error("disk full");
        return exec.run(sql, params);
      },
      all: (sql, params) => exec.all(sql, params),
    };
    await expect(
      recordScan(
        failing,
        {
          shiftId: "s1",
          terminalId: null,
          raw: "RAW1",
          verdict: "invalid",
          scannedAt: "2026-07-28T10:00:00.000Z",
        },
        null,
      ),
    ).rejects.toThrow(/disk full/);
  });
});
```

If `journal.test.ts` has no `migratedExec` helper, add one in the file's existing style:

```ts
async function migratedExec(): Promise<SqlExecutor> {
  const db = new DatabaseSync(":memory:");
  const exec: SqlExecutor = {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
  await applyMigrations(exec);
  return exec;
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @markiro/station exec vitest run journal`
Expected: FAIL — `no such table: outbox`.

- [ ] **Step 3: Add the table**

In `packages/db/src/sqlite/migrations.ts`, append to `STATION_MIGRATIONS` (after `scan_events_mirror`, before the trailing `ALTER TABLE` upgrade statements):

```ts
  `CREATE TABLE IF NOT EXISTS outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     shift_id TEXT NOT NULL,
     terminal_id TEXT,
     raw TEXT NOT NULL,
     verdict TEXT NOT NULL,
     scanned_at TEXT NOT NULL,
     code_hash TEXT,
     gtin14 TEXT,
     serial TEXT
   );`,
```

`AUTOINCREMENT` is load-bearing, not decoration: an ordinary SQLite rowid is reused after a delete, so once plan 09 purges rows a new scan could receive an id below one already acknowledged. Say so in a comment above the statement.

In `packages/db/src/sqlite/schema.ts`, add the mirror definition beside the others:

```ts
/**
 * Device-local transport queue: one row per scan, drained to the server and
 * deleted on acknowledgement. Deliberately separate from `codes_mirror` —
 * that table serves duplicate detection and will be purged on a retention
 * schedule, and transport state must not be governed by retention.
 */
export const outbox = sqliteTable("outbox", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shiftId: text("shift_id").notNull(),
  terminalId: text("terminal_id"),
  raw: text("raw").notNull(),
  verdict: text("verdict").notNull(),
  scannedAt: text("scanned_at").notNull(),
  codeHash: text("code_hash"),
  gtin14: text("gtin14"),
  serial: text("serial"),
});
```

- [ ] **Step 4: Enqueue in `recordScan`**

In `apps/station/src/lib/journal.ts`, replace the tail of `recordScan` (from the `appendScanEvent` call to the `return`) with:

```ts
const journalled = alreadyPresent ? { ...e, verdict: "duplicate" } : e;
await appendScanEvent(exec, journalled);

// Enqueued LAST, and deliberately allowed to throw. The verdict is not
// final until the code insert has either succeeded or hit the primary key,
// so an earlier enqueue could queue "ok" for a scan the operator was shown
// as a duplicate. A failure here means the scan is journalled locally but
// never queued for the server, so it must reach the operator through the
// scan queue's error path rather than vanishing quietly.
await exec.run(
  `INSERT INTO outbox (shift_id, terminal_id, raw, verdict, scanned_at, code_hash, gtin14, serial)
     VALUES (?,?,?,?,?,?,?,?)`,
  [
    journalled.shiftId,
    journalled.terminalId,
    journalled.raw,
    journalled.verdict,
    journalled.scannedAt,
    storedCode && code ? code.codeHash : null,
    storedCode && code ? code.gtin14 : null,
    storedCode && code ? code.serial : null,
  ],
);

return { storedCode, alreadyPresent };
```

`storedCode` — not merely `code` — gates the payload: a code that was already present was queued by an earlier scan, and sending it again would write a second server row for one physical item.

- [ ] **Step 5: Update the schema drift test**

`packages/db/test/sqlite-schema.test.ts` asserts the table count. Rename it from seven to eight and add:

```ts
expect(names).toContain("outbox");
```

- [ ] **Step 6: Run it green**

Run: `pnpm --filter @markiro/station test && pnpm --filter @markiro/db test`
Expected: PASS on both — the four new journal cases, the existing journal and mirror tests, and the drift test.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/sqlite/schema.ts packages/db/src/sqlite/migrations.ts packages/db/test/sqlite-schema.test.ts apps/station/src/lib/journal.ts apps/station/test/journal.test.ts
git commit -m "feat(station): queue every scan in a device outbox"
```

---

### Task 2: Outbox read, acknowledge, and depth

**Files:**

- Create: `apps/station/src/lib/outbox.ts`
- Test: `apps/station/test/outbox.test.ts`

**Interfaces:**

- Consumes: `SqlExecutor` from `apps/station/src/lib/mirror.ts`.
- Produces:
  - `interface OutboxItem { id: number; shiftId: string; terminalId: string | null; raw: string; verdict: string; scannedAt: string; code: { codeHash: string; gtin14: string; serial: string } | null }`
  - `readBatch(exec: SqlExecutor, limit: number): Promise<OutboxItem[]>`
  - `ackThrough(exec: SqlExecutor, id: number): Promise<void>`
  - `outboxDepth(exec: SqlExecutor): Promise<number>`
  - `oldestQueuedAt(exec: SqlExecutor): Promise<string | null>`

- [ ] **Step 1: Write the failing test**

```ts
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { ackThrough, oldestQueuedAt, outboxDepth, readBatch } from "../src/lib/outbox.js";

async function migratedExec(): Promise<SqlExecutor> {
  const db = new DatabaseSync(":memory:");
  const exec: SqlExecutor = {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
  await applyMigrations(exec);
  return exec;
}

async function seed(exec: SqlExecutor, n: number, withCode = true): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await exec.run(
      `INSERT INTO outbox (shift_id, terminal_id, raw, verdict, scanned_at, code_hash, gtin14, serial)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        "s1",
        "t1",
        `RAW${i}`,
        "ok",
        `2026-07-28T10:00:0${i}.000Z`,
        withCode ? `h${i}` : null,
        withCode ? "04600000000017" : null,
        withCode ? `S${i}` : null,
      ],
    );
  }
}

describe("outbox", () => {
  it("reads in id order and never more than the limit", async () => {
    const exec = await migratedExec();
    await seed(exec, 5);
    const batch = await readBatch(exec, 3);
    expect(batch.map((i) => i.raw)).toEqual(["RAW1", "RAW2", "RAW3"]);
    expect(batch[0]!.id).toBeLessThan(batch[2]!.id);
  });

  it("shapes an accepted item with its code and a rejected one without", async () => {
    const exec = await migratedExec();
    await seed(exec, 1);
    await seed(exec, 1, false);
    const [accepted, rejected] = await readBatch(exec, 10);
    expect(accepted!.code).toEqual({ codeHash: "h1", gtin14: "04600000000017", serial: "S1" });
    expect(rejected!.code).toBeNull();
  });

  it("acknowledges exactly through the given id", async () => {
    const exec = await migratedExec();
    await seed(exec, 5);
    const batch = await readBatch(exec, 3);
    await ackThrough(exec, batch[2]!.id);
    expect((await readBatch(exec, 10)).map((i) => i.raw)).toEqual(["RAW4", "RAW5"]);
  });

  it("reports depth and the oldest queued timestamp", async () => {
    const exec = await migratedExec();
    expect(await outboxDepth(exec)).toBe(0);
    expect(await oldestQueuedAt(exec)).toBeNull();
    await seed(exec, 3);
    expect(await outboxDepth(exec)).toBe(3);
    expect(await oldestQueuedAt(exec)).toBe("2026-07-28T10:00:01.000Z");
  });

  it("leaves the queue intact when nothing is acknowledged", async () => {
    const exec = await migratedExec();
    await seed(exec, 4);
    await readBatch(exec, 4);
    expect(await outboxDepth(exec)).toBe(4);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @markiro/station exec vitest run outbox`
Expected: FAIL — `Failed to resolve import "../src/lib/outbox.js"`.

- [ ] **Step 3: Implement**

```ts
import type { SqlExecutor } from "./mirror.js";

/** One queued scan, shaped as the server's ingest endpoint expects it. */
export interface OutboxItem {
  id: number;
  shiftId: string;
  terminalId: string | null;
  raw: string;
  verdict: string;
  scannedAt: string;
  /** Present only for a scan this device accepted and stored. */
  code: { codeHash: string; gtin14: string; serial: string } | null;
}

interface OutboxRow {
  id: number;
  shift_id: string;
  terminal_id: string | null;
  raw: string;
  verdict: string;
  scanned_at: string;
  code_hash: string | null;
  gtin14: string | null;
  serial: string | null;
}

/**
 * The oldest `limit` queued scans, in insertion order. Order matters: the
 * acknowledgement deletes a contiguous range by id, so a batch must always be
 * a prefix of the queue.
 */
export async function readBatch(exec: SqlExecutor, limit: number): Promise<OutboxItem[]> {
  const rows = await exec.all<OutboxRow>(
    `SELECT id, shift_id, terminal_id, raw, verdict, scanned_at, code_hash, gtin14, serial
       FROM outbox ORDER BY id LIMIT ?`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    shiftId: r.shift_id,
    terminalId: r.terminal_id,
    raw: r.raw,
    verdict: r.verdict,
    scannedAt: r.scanned_at,
    code:
      r.code_hash !== null && r.gtin14 !== null && r.serial !== null
        ? { codeHash: r.code_hash, gtin14: r.gtin14, serial: r.serial }
        : null,
  }));
}

/**
 * Drops everything up to and including `id` — one statement, which is the
 * only atomic unit available on the device (see journal.ts on the
 * `tauri-plugin-sql` connection pool). Called only after the server has
 * confirmed the batch, so a crash before it simply resends.
 */
export async function ackThrough(exec: SqlExecutor, id: number): Promise<void> {
  await exec.run("DELETE FROM outbox WHERE id <= ?", [id]);
}

export async function outboxDepth(exec: SqlExecutor): Promise<number> {
  const rows = await exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM outbox");
  return rows[0]?.n ?? 0;
}

/** When the oldest still-queued scan happened, or null on an empty queue. */
export async function oldestQueuedAt(exec: SqlExecutor): Promise<string | null> {
  const rows = await exec.all<{ scanned_at: string }>(
    "SELECT scanned_at FROM outbox ORDER BY id LIMIT 1",
  );
  return rows[0]?.scanned_at ?? null;
}
```

- [ ] **Step 4: Run it green**

Run: `pnpm --filter @markiro/station exec vitest run outbox`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/station/src/lib/outbox.ts apps/station/test/outbox.test.ts
git commit -m "feat(station): read and acknowledge the outbox queue"
```

---

### Task 3: Server schema — batch keys and the late-data stamp

**Files:**

- Create: `packages/db/migrations/0011_station_sync.sql`
- Modify: `packages/db/migrations/meta/_journal.json`, `packages/db/src/schema/platform.ts`
- Test: `apps/api/test/station-scans.e2e.test.ts` (created in Task 4 — this task's verification is the migration applying cleanly)

**Interfaces:**

- Produces: table `sync_batches (tenant_id, batch_id, applied_at)` with `PRIMARY KEY (tenant_id, batch_id)`; column `shifts.late_data_at timestamptz`.

**Why a batch key and not per-row keys:** neither target table can express row idempotency. `scan_events` has no key at all, and `codes` has `PRIMARY KEY (tenant_id, code_hash, scanned_at)` where `scanned_at` is present only because Postgres requires the partition key in the primary key — so it does not constrain a code to one row.

- [ ] **Step 1: Write the migration**

`packages/db/migrations/0011_station_sync.sql`:

```sql
CREATE TABLE "sync_batches" (
  "tenant_id" text NOT NULL REFERENCES "organization"("id"),
  "batch_id" text NOT NULL,
  "applied_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "batch_id")
);
--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "late_data_at" timestamptz;
```

Deliberately unpartitioned: it holds one short row per accepted batch, and its whole job is a fast primary-key probe.

- [ ] **Step 2: Register it in the journal**

Append an entry to the `entries` array in `packages/db/migrations/meta/_journal.json`, following the existing shape exactly (`idx` 11, `version` "7", a `when` millisecond timestamp greater than the previous entry's, `tag` `"0011_station_sync"`, `breakpoints` true).

- [ ] **Step 3: Mirror it in the Drizzle schema**

In `packages/db/src/schema/platform.ts`, add `lateDataAt` to the `shifts` table definition, immediately after `closeReason`:

```ts
    /**
     * When scans first arrived for this shift AFTER it was closed. Set once
     * and never overwritten, so it marks the shift rather than tracking the
     * most recent straggler. The cabinet shows it, because a manager who has
     * already reported on a closed shift must find out that its totals moved.
     */
    lateDataAt: timestamp("late_data_at", { withTimezone: true }),
```

Add the new table in the same file, after `shifts`:

```ts
/**
 * Idempotency keys for station sync batches. A batch is applied and its key
 * recorded in ONE transaction, so a retried batch is a no-op in its entirety.
 */
export const syncBatches = pgTable(
  "sync_batches",
  {
    tenantId: text("tenant_id").notNull(),
    batchId: text("batch_id").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.batchId] })],
);
```

`primaryKey` is NOT currently in that file's `drizzle-orm/pg-core` import list — add it, keeping the list alphabetical as it already is.

- [ ] **Step 4: Verify the migration applies**

Run:

```bash
DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro pnpm --filter @markiro/db db:migrate
```

Expected: applies without error. Then confirm the shape:

```bash
psql postgres://markiro:markiro@localhost:5432/markiro -c '\d sync_batches' -c '\d shifts' | grep -E "late_data_at|batch_id|tenant_id"
```

Expected: `sync_batches` has the composite primary key and `shifts` has `late_data_at`.

- [ ] **Step 5: Run the db suite**

Run: `pnpm --filter @markiro/db test`
Expected: PASS — no drift between the schema file and the migrations.

- [ ] **Step 6: Commit**

```bash
git add packages/db/migrations/0011_station_sync.sql packages/db/migrations/meta/_journal.json packages/db/src/schema/platform.ts
git commit -m "feat(db): sync batch keys and the late-data stamp"
```

---

### Task 4: Server ingest endpoint

**Files:**

- Create: `apps/api/src/modules/station-scans/dto.ts`, `station-scans.service.ts`, `station-scans.controller.ts`, `station-scans.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/station-scans.e2e.test.ts`

**Interfaces:**

- Consumes: `sync_batches`, `shifts.late_data_at` (Task 3); `TenantGuard`/`RequestWithTenant` from `apps/api/src/tenancy/tenant.guard`; `DB` from `apps/api/src/auth/auth.module`.
- Produces: `POST /station/scans` accepting `{ batchId: string; items: ScanItemDto[] }` and returning `{ applied: number; alreadyApplied: boolean }`.

- [ ] **Step 1: Write the failing test**

`apps/api/test/station-scans.e2e.test.ts` — follow the setup block of `apps/api/test/employees.e2e.test.ts` verbatim (the same `describe.skipIf(!ready)`, `beforeAll` module compile, `mountAuth`, `express.json()`, and its local `signUpAndActivate`). Routes carry no global prefix; only Better Auth mounts under `/api/auth/*`.

```ts
async function deviceKey(agent: ReturnType<typeof request.agent>): Promise<string> {
  const device = await agent.post("/station-devices").send({ name: "Line 1" }).expect(201);
  return (device.body as { apiKey: string }).apiKey;
}

async function openShift(agent: ReturnType<typeof request.agent>): Promise<string> {
  const product = await agent
    .post("/products")
    .send({ name: "Cola", gtin14: "04600000000017" })
    .expect(201);
  const shift = await agent
    .post("/shifts")
    .send({ productId: (product.body as { id: string }).id, mode: "validation" })
    .expect(201);
  const id = (shift.body as { id: string }).id;
  await agent.post(`/shifts/${id}/open`).expect(200);
  return id;
}

function item(shiftId: string, n: number) {
  return {
    shiftId,
    terminalId: "t1",
    raw: `RAW${n}`,
    verdict: "ok",
    scannedAt: `2026-07-28T10:00:0${n}.000Z`,
    code: { codeHash: `h${n}`.padEnd(64, "0"), gtin14: "04600000000017", serial: `S${n}` },
  };
}

it("accepts a batch from a station api-key and stores codes and events", async () => {
  const agent = request.agent(app!.getHttpServer());
  await signUpAndActivate(agent);
  const apiKey = await deviceKey(agent);
  const shiftId = await openShift(agent);

  const res = await request(app!.getHttpServer())
    .post("/station/scans")
    .set("x-api-key", apiKey)
    .send({ batchId: "machine-1:200", items: [item(shiftId, 1), item(shiftId, 2)] })
    .expect(201);

  expect(res.body).toMatchObject({ applied: 2, alreadyApplied: false });
});

it("is idempotent: the same batchId applied twice stores one set of rows", async () => {
  const agent = request.agent(app!.getHttpServer());
  await signUpAndActivate(agent);
  const apiKey = await deviceKey(agent);
  const shiftId = await openShift(agent);
  const body = { batchId: "machine-1:200", items: [item(shiftId, 1)] };

  await request(app!.getHttpServer())
    .post("/station/scans")
    .set("x-api-key", apiKey)
    .send(body)
    .expect(201);
  const second = await request(app!.getHttpServer())
    .post("/station/scans")
    .set("x-api-key", apiKey)
    .send(body)
    .expect(201);

  expect(second.body).toMatchObject({ applied: 0, alreadyApplied: true });
});

it("accepts late data for a closed shift and stamps it", async () => {
  const agent = request.agent(app!.getHttpServer());
  await signUpAndActivate(agent);
  const apiKey = await deviceKey(agent);
  const shiftId = await openShift(agent);
  await agent.post(`/shifts/${shiftId}/close`).send({ closeReason: "done" }).expect(200);

  await request(app!.getHttpServer())
    .post("/station/scans")
    .set("x-api-key", apiKey)
    .send({ batchId: "machine-1:300", items: [item(shiftId, 1)] })
    .expect(201);

  const shift = await agent.get(`/shifts/${shiftId}`).expect(200);
  expect((shift.body as { lateDataAt: string | null }).lateDataAt).not.toBeNull();
});

it("rejects a shift id belonging to another tenant", async () => {
  const agent = request.agent(app!.getHttpServer());
  await signUpAndActivate(agent);
  const apiKey = await deviceKey(agent);

  const other = request.agent(app!.getHttpServer());
  await signUpAndActivate(other);
  const foreignShift = await openShift(other);

  await request(app!.getHttpServer())
    .post("/station/scans")
    .set("x-api-key", apiKey)
    .send({ batchId: "machine-1:400", items: [item(foreignShift, 1)] })
    .expect(400);
});

it("rejects an unauthenticated caller", async () => {
  await request(app!.getHttpServer())
    .post("/station/scans")
    .send({ batchId: "machine-1:500", items: [] })
    .expect(401);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173 pnpm --filter @markiro/api exec vitest run station-scans`
Expected: FAIL — 404 on `POST /station/scans`, the route does not exist.

- [ ] **Step 3: Write the DTO**

`apps/api/src/modules/station-scans/dto.ts`:

```ts
import { z } from "zod";

const scanItemSchema = z.object({
  shiftId: z.string().uuid(),
  terminalId: z.string().nullable(),
  raw: z.string().min(1),
  verdict: z.string().min(1),
  scannedAt: z.string().datetime(),
  code: z
    .object({
      codeHash: z.string().length(64),
      gtin14: z.string().length(14),
      serial: z.string().min(1),
    })
    .nullable(),
});

export const syncBatchSchema = z.object({
  // Device-generated and deterministic: "<machineId>:<highest outbox id>".
  // Stable across a retry AND across an app restart, which is what makes the
  // server's idempotency key actually protect a resend.
  batchId: z.string().min(1).max(200),
  // Bounded so a buggy or hostile device cannot submit an unbounded payload;
  // the station's own batch size is 200.
  items: z.array(scanItemSchema).max(500),
});

export type ScanItemDto = z.infer<typeof scanItemSchema>;
export type SyncBatchDto = z.infer<typeof syncBatchSchema>;

export interface SyncBatchResponseDto {
  applied: number;
  alreadyApplied: boolean;
}
```

- [ ] **Step 4: Write the service**

`apps/api/src/modules/station-scans/station-scans.service.ts`:

```ts
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type { SyncBatchDto, SyncBatchResponseDto } from "./dto";

@Injectable()
export class StationScansService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Applies one batch and records its key in a SINGLE transaction, so a
   * retried batch is a no-op in its entirety. This is the server side of the
   * device's at-least-once delivery: the station resends whenever it did not
   * see an acknowledgement, and correctness rests entirely on this being
   * all-or-nothing.
   */
  async applyBatch(tenantId: string, body: SyncBatchDto): Promise<SyncBatchResponseDto> {
    return this.db.transaction(async (tx) => {
      const claimed = await tx
        .insert(schema.syncBatches)
        .values({ tenantId, batchId: body.batchId })
        .onConflictDoNothing()
        .returning({ batchId: schema.syncBatches.batchId });

      // Someone already applied this batch — almost always this same device
      // retrying after a lost response. Report success so it acknowledges.
      if (claimed.length === 0) return { applied: 0, alreadyApplied: true };
      if (body.items.length === 0) return { applied: 0, alreadyApplied: false };

      const shiftIds = [...new Set(body.items.map((i) => i.shiftId))];
      const owned = await tx
        .select({ id: schema.shifts.id, status: schema.shifts.status })
        .from(schema.shifts)
        .where(and(eq(schema.shifts.tenantId, tenantId), inArray(schema.shifts.id, shiftIds)));

      // Tenant scoping is enforced in the statement above; anything missing
      // either does not exist or belongs to another tenant, and the caller
      // must not be able to tell those apart.
      if (owned.length !== shiftIds.length) {
        throw new BadRequestException("Unknown shift in batch");
      }

      const coded = body.items.filter((i) => i.code !== null);
      if (coded.length > 0) {
        await tx
          .insert(schema.codes)
          .values(
            coded.map((i) => ({
              tenantId,
              codeHash: i.code!.codeHash,
              shiftId: i.shiftId,
              gtin14: i.code!.gtin14,
              serial: i.code!.serial,
              scannedAt: new Date(i.scannedAt),
            })),
          )
          .onConflictDoNothing();
      }

      await tx.insert(schema.scanEvents).values(
        body.items.map((i) => ({
          tenantId,
          shiftId: i.shiftId,
          terminalId: i.terminalId,
          raw: i.raw,
          verdict: i.verdict,
          scannedAt: new Date(i.scannedAt),
        })),
      );

      // Stamp only shifts that were already closed, and only the first time:
      // the badge marks the shift, it does not track the latest straggler.
      const closed = owned.filter((s) => s.status === "closed").map((s) => s.id);
      if (closed.length > 0) {
        await tx
          .update(schema.shifts)
          .set({ lateDataAt: sql`now()` })
          .where(
            and(
              eq(schema.shifts.tenantId, tenantId),
              inArray(schema.shifts.id, closed),
              isNull(schema.shifts.lateDataAt),
            ),
          );
      }

      return { applied: body.items.length, alreadyApplied: false };
    });
  }
}
```

- [ ] **Step 5: Expose the stamp on the shift DTO**

The e2e above reads `lateDataAt` back from `GET /shifts/:id`, and the spec requires the cabinet to show it — neither works while the field stops at the database.

In `apps/api/src/modules/shifts/dto.ts`, add to the `ShiftDto` interface immediately after `closeReason`:

```ts
/** When scans first arrived after this shift was closed; null if never. */
lateDataAt: Date | null;
```

In `apps/api/src/modules/shifts/shifts.service.ts`, add `lateDataAt: row.lateDataAt` to the function that maps a `ShiftRow` to a `ShiftDto` — find it by searching for `closeReason:` and add the new field beside it, so every route returning a shift carries it.

- [ ] **Step 6: Write the controller and module**

`apps/api/src/modules/station-scans/station-scans.controller.ts`:

```ts
import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { syncBatchSchema, type SyncBatchDto, type SyncBatchResponseDto } from "./dto";
import { StationScansService } from "./station-scans.service";

/**
 * Station scan ingest. Deliberately `TenantGuard`-only, never
 * `SessionOnlyGuard`: delivering scans is the device's entire purpose, and
 * making this session-only would silently strand every station's data on its
 * own disk. Recorded in docs/device-key-surface.md and pinned by a positive
 * e2e regression test.
 */
@ApiTags("station")
@Controller("station")
@UseGuards(TenantGuard)
export class StationScansController {
  constructor(private readonly service: StationScansService) {}

  @Post("scans")
  async ingest(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(syncBatchSchema)) body: SyncBatchDto,
  ): Promise<SyncBatchResponseDto> {
    return this.service.applyBatch(req.tenantId!, body);
  }
}
```

`apps/api/src/modules/station-scans/station-scans.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { StationScansController } from "./station-scans.controller";
import { StationScansService } from "./station-scans.service";

@Module({
  controllers: [StationScansController],
  providers: [StationScansService],
})
export class StationScansModule {}
```

Register `StationScansModule` in `apps/api/src/app.module.ts` beside the other feature modules, following exactly how the neighbouring modules are listed.

- [ ] **Step 7: Run it green**

Run the Task 4 Step 2 command again.
Expected: PASS (5 tests), and confirm they ran rather than skipped.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/station-scans apps/api/src/modules/shifts/dto.ts apps/api/src/modules/shifts/shifts.service.ts apps/api/src/app.module.ts apps/api/test/station-scans.e2e.test.ts
git commit -m "feat(api): idempotent station scan ingest"
```

---

### Task 5: The drain loop

**Files:**

- Create: `apps/station/src/lib/sync.ts`
- Test: `apps/station/test/sync.test.ts`

**Interfaces:**

- Consumes: `readBatch`, `ackThrough`, `outboxDepth`, `oldestQueuedAt` (Task 2); `StationClient` from `apps/station/src/lib/api-client.ts`; `SqlExecutor`.
- Produces:
  - `interface SyncState { pending: number; lastSuccessAt: number | null; stuck: boolean }`
  - `createSyncEngine(deps: SyncEngineDeps): SyncEngine` where `SyncEngineDeps = { exec: SqlExecutor; client: Pick<StationClient, "post">; machineId: string; now?: () => number; onState(state: SyncState): void }`
  - `SyncEngine = { nudge(): void; stop(): void; idle(): Promise<void> }`
  - `const BATCH_SIZE = 200`, `const STUCK_AFTER_MS = 15 * 60 * 1000`

**Design notes the implementer must honour:**

- **One drain at a time.** Two concurrent drains would read overlapping batches and race their acknowledgements. Set the in-flight flag synchronously before the first `await`, exactly as `createScanQueue` sets `draining` — this codebase already learned that lesson.
- **`batchId` is `` `${machineId}:${maxId}` ``**, where `maxId` is the highest id in the batch. Deterministic, so a retry _and_ an app restart both resend the same key and the server's idempotency actually protects the resend. A random id per attempt would defeat it.
- `now` is injectable purely so tests can control the stuck clock without timers.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { BATCH_SIZE, createSyncEngine, STUCK_AFTER_MS } from "../src/lib/sync.js";

async function migratedExec(): Promise<SqlExecutor> {
  const db = new DatabaseSync(":memory:");
  const exec: SqlExecutor = {
    async run(sql, params = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
  };
  await applyMigrations(exec);
  return exec;
}

async function seed(exec: SqlExecutor, n: number): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await exec.run(
      `INSERT INTO outbox (shift_id, terminal_id, raw, verdict, scanned_at, code_hash, gtin14, serial)
       VALUES (?,?,?,?,?,?,?,?)`,
      ["s1", "t1", `RAW${i}`, "ok", "2026-07-28T10:00:00.000Z", `h${i}`, "04600000000017", `S${i}`],
    );
  }
}

describe("sync engine", () => {
  it("drains the queue and acknowledges what the server accepted", async () => {
    const exec = await migratedExec();
    await seed(exec, 3);
    const post = vi.fn().mockResolvedValue({ applied: 3, alreadyApplied: false });

    const engine = createSyncEngine({
      exec,
      client: { post },
      machineId: "m1",
      onState: () => {},
    });
    engine.nudge();
    await engine.idle();

    expect(post).toHaveBeenCalledTimes(1);
    const [path, body] = post.mock.calls[0]!;
    expect(path).toBe("/station/scans");
    expect((body as { items: unknown[] }).items).toHaveLength(3);
    const rows = await exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM outbox");
    expect(rows[0]!.n).toBe(0);
    engine.stop();
  });

  it("uses a deterministic batch id so a resend is the same key", async () => {
    const exec = await migratedExec();
    await seed(exec, 2);
    const post = vi.fn().mockResolvedValue({ applied: 2, alreadyApplied: false });

    const engine = createSyncEngine({ exec, client: { post }, machineId: "m1", onState: () => {} });
    engine.nudge();
    await engine.idle();

    expect((post.mock.calls[0]![1] as { batchId: string }).batchId).toBe("m1:2");
    engine.stop();
  });

  it("acknowledges an already-applied batch, so a lost response cannot wedge the queue", async () => {
    const exec = await migratedExec();
    await seed(exec, 2);
    const post = vi.fn().mockResolvedValue({ applied: 0, alreadyApplied: true });

    const engine = createSyncEngine({ exec, client: { post }, machineId: "m1", onState: () => {} });
    engine.nudge();
    await engine.idle();

    const rows = await exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM outbox");
    expect(rows[0]!.n).toBe(0);
    engine.stop();
  });

  it("leaves the queue intact when the send fails", async () => {
    const exec = await migratedExec();
    await seed(exec, 2);
    const post = vi.fn().mockRejectedValue(new Error("offline"));

    const engine = createSyncEngine({ exec, client: { post }, machineId: "m1", onState: () => {} });
    engine.nudge();
    await engine.idle();

    const rows = await exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM outbox");
    expect(rows[0]!.n).toBe(2);
    engine.stop();
  });

  it("runs one drain at a time even when nudged concurrently", async () => {
    const exec = await migratedExec();
    await seed(exec, 2);
    let inFlight = 0;
    let maxInFlight = 0;
    const post = vi.fn().mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { applied: 2, alreadyApplied: false };
    });

    const engine = createSyncEngine({ exec, client: { post }, machineId: "m1", onState: () => {} });
    engine.nudge();
    engine.nudge();
    engine.nudge();
    await engine.idle();

    expect(maxInFlight).toBe(1);
    engine.stop();
  });

  it("splits a long queue into batches of BATCH_SIZE", async () => {
    const exec = await migratedExec();
    await seed(exec, BATCH_SIZE + 5);
    const post = vi.fn().mockImplementation(async (_p: string, body: unknown) => ({
      applied: (body as { items: unknown[] }).items.length,
      alreadyApplied: false,
    }));

    const engine = createSyncEngine({ exec, client: { post }, machineId: "m1", onState: () => {} });
    engine.nudge();
    await engine.idle();

    expect(post).toHaveBeenCalledTimes(2);
    expect((post.mock.calls[0]![1] as { items: unknown[] }).items).toHaveLength(BATCH_SIZE);
    expect((post.mock.calls[1]![1] as { items: unknown[] }).items).toHaveLength(5);
    engine.stop();
  });

  it("reports stuck once nothing has synced for the threshold while work is queued", async () => {
    const exec = await migratedExec();
    await seed(exec, 1);
    const post = vi.fn().mockRejectedValue(new Error("offline"));
    const states: { pending: number; stuck: boolean }[] = [];
    let clock = 1_000_000;

    const engine = createSyncEngine({
      exec,
      client: { post },
      machineId: "m1",
      now: () => clock,
      onState: (s) => states.push({ pending: s.pending, stuck: s.stuck }),
    });
    engine.nudge();
    await engine.idle();
    expect(states.at(-1)).toMatchObject({ pending: 1, stuck: false });

    clock += STUCK_AFTER_MS + 1;
    engine.nudge();
    await engine.idle();
    expect(states.at(-1)).toMatchObject({ pending: 1, stuck: true });
    engine.stop();
  });

  it("is not stuck when the queue is empty, however long since the last sync", async () => {
    const exec = await migratedExec();
    const post = vi.fn();
    const states: { stuck: boolean }[] = [];
    let clock = 1_000_000;

    const engine = createSyncEngine({
      exec,
      client: { post },
      machineId: "m1",
      now: () => clock,
      onState: (s) => states.push({ stuck: s.stuck }),
    });
    clock += STUCK_AFTER_MS * 10;
    engine.nudge();
    await engine.idle();

    expect(post).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ stuck: false });
    engine.stop();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @markiro/station exec vitest run sync`
Expected: FAIL — `Failed to resolve import "../src/lib/sync.js"`.

- [ ] **Step 3: Implement**

```ts
import type { StationClient } from "./api-client.js";
import type { SqlExecutor } from "./mirror.js";
import { ackThrough, oldestQueuedAt, outboxDepth, readBatch, type OutboxItem } from "./outbox.js";

/** Scans per request. Small enough to survive a flaky link and to retry cheaply. */
export const BATCH_SIZE = 200;
/** How long a non-empty queue may stop moving before the operator is warned. */
export const STUCK_AFTER_MS = 15 * 60 * 1000;
const BACKOFF_START_MS = 2_000;
const BACKOFF_CAP_MS = 60_000;

export interface SyncState {
  pending: number;
  lastSuccessAt: number | null;
  /** The queue has work and has stopped moving — "the pipe is broken". */
  stuck: boolean;
}

export interface SyncEngineDeps {
  exec: SqlExecutor;
  client: Pick<StationClient, "post">;
  /** Always present in the station config; makes the batch id unique per device. */
  machineId: string;
  now?: () => number;
  onState(state: SyncState): void;
}

export interface SyncEngine {
  /** Ask for a drain. Safe to call from anywhere, any number of times. */
  nudge(): void;
  stop(): void;
  /** Resolves when no drain is in flight (tests await this instead of sleeping). */
  idle(): Promise<void>;
}

interface BatchResponse {
  applied: number;
  alreadyApplied: boolean;
}

function toPayload(items: OutboxItem[]) {
  return items.map((i) => ({
    shiftId: i.shiftId,
    terminalId: i.terminalId,
    raw: i.raw,
    verdict: i.verdict,
    scannedAt: i.scannedAt,
    code: i.code,
  }));
}

/**
 * Drains the device outbox to the server, one batch at a time.
 *
 * Delivery is at-least-once: a batch is acknowledged locally only after the
 * server confirms it, so a lost response resends. That is safe because the
 * batch id is deterministic — `<machineId>:<highest id in the batch>` — and
 * the server records it, so the resend is a no-op there. A random id per
 * attempt would silently turn every lost response into duplicated data.
 *
 * Exactly one drain runs at a time; `draining` is set synchronously before
 * the first await, the same discipline `createScanQueue` uses, because two
 * drains would read overlapping batches and race their acknowledgements.
 */
export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  const now = deps.now ?? (() => Date.now());
  let draining = false;
  let stopped = false;
  let requested = false;
  let lastSuccessAt: number | null = null;
  let backoffMs = BACKOFF_START_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let idleResolvers: (() => void)[] = [];

  function settleIdle() {
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  async function publishState(): Promise<void> {
    const pending = await outboxDepth(deps.exec);
    // Nothing queued is never "stuck", however long the link has been down.
    // On a device that has never synced there is no last-success time to
    // measure from, so the clock starts at the oldest queued scan — otherwise
    // a station offline since its very first scan would never warn.
    let stuck = false;
    if (pending > 0) {
      const since = lastSuccessAt ?? Date.parse((await oldestQueuedAt(deps.exec)) ?? "");
      stuck = Number.isFinite(since) && now() - since >= STUCK_AFTER_MS;
    }
    deps.onState({ pending, lastSuccessAt, stuck });
  }

  async function drain(): Promise<void> {
    if (draining || stopped) return;
    draining = true;
    try {
      for (;;) {
        if (stopped) break;
        const batch = await readBatch(deps.exec, BATCH_SIZE);
        if (batch.length === 0) break;

        const maxId = batch[batch.length - 1]!.id;
        try {
          const res = await deps.client.post<BatchResponse>("/station/scans", {
            batchId: `${deps.machineId}:${maxId}`,
            items: toPayload(batch),
          });
          // `alreadyApplied` is a success: this exact batch is on the server
          // already, so holding on to it would wedge the queue forever.
          void res;
          await ackThrough(deps.exec, maxId);
          lastSuccessAt = now();
          backoffMs = BACKOFF_START_MS;
        } catch (err) {
          console.error("station: sync batch failed", err);
          scheduleRetry();
          break;
        }
      }
      await publishState();
    } finally {
      draining = false;
      settleIdle();
      if (requested && !stopped) {
        requested = false;
        void drain();
      }
    }
  }

  function scheduleRetry(): void {
    if (stopped || retryTimer !== null) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, BACKOFF_CAP_MS);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void drain();
    }, delay);
  }

  return {
    nudge() {
      if (stopped) return;
      if (draining) requested = true;
      else void drain();
    },
    stop() {
      stopped = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    },
    idle() {
      if (!draining) return Promise.resolve();
      return new Promise<void>((resolve) => idleResolvers.push(resolve));
    },
  };
}
```

- [ ] **Step 4: Run it green**

Run: `pnpm --filter @markiro/station exec vitest run sync`
Expected: PASS (8 tests), output free of unhandled rejections.

- [ ] **Step 5: Commit**

```bash
git add apps/station/src/lib/sync.ts apps/station/test/sync.test.ts
git commit -m "feat(station): serialized outbox drain with backoff"
```

---

### Task 6: Sync indicator in the status bar

**Files:**

- Modify: `apps/station/src/ui/StatusBar.tsx`, `apps/station/src/ui/FloorShell.tsx`, `apps/station/src/i18n/en.json`, `apps/station/src/i18n/ru.json`
- Test: `apps/station/test/status-bar.test.tsx`

**Interfaces:**

- Consumes: `SyncState` from `apps/station/src/lib/sync.ts` (Task 5) — only its `pending` and `stuck` fields.
- Produces: `StatusBarProps` and `FloorShellProps` both gain `syncPending: number` and `syncStuck: boolean`.

The bar already carries a hardcoded `{t("shell.sync")}: 0` from 05a. This task makes it real. New i18n key under `shell`: `syncStuck`.

- [ ] **Step 1: Write the failing test**

Append to `apps/station/test/status-bar.test.tsx` (the file already scopes assertions through per-field `data-testid` hooks — follow that):

```tsx
it("shows the pending count", () => {
  render(
    <StatusBar
      online
      scanner="keyboard"
      printerConfigured={false}
      syncPending={42}
      syncStuck={false}
    />,
  );
  expect(screen.getByTestId("sync-status").textContent).toBe("42");
});

it("shows zero pending without a warning", () => {
  render(
    <StatusBar
      online
      scanner="keyboard"
      printerConfigured={false}
      syncPending={0}
      syncStuck={false}
    />,
  );
  expect(screen.getByTestId("sync-status").textContent).toBe("0");
});

it("warns when the queue has stopped moving", () => {
  render(
    <StatusBar online scanner="keyboard" printerConfigured={false} syncPending={7} syncStuck />,
  );
  expect(screen.getByTestId("sync-status").textContent).toBe("7 — Not syncing");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @markiro/station exec vitest run status-bar`
Expected: FAIL — `StatusBar` has no `syncPending`/`syncStuck` props, so TypeScript rejects the literals and no `sync-status` element exists.

- [ ] **Step 3: Implement**

In `apps/station/src/ui/StatusBar.tsx`, extend the props:

```tsx
export interface StatusBarProps {
  online: boolean;
  scanner: ScannerIndicator;
  printerConfigured: boolean;
  /** Scans queued on this device, not yet accepted by the server. */
  syncPending: number;
  /** The queue has work and has stopped moving — see sync.ts's STUCK_AFTER_MS. */
  syncStuck: boolean;
}
```

Replace the hardcoded sync span with:

```tsx
<span>
  {t("shell.sync")}:{" "}
  {/* A rising number while offline is information, not a problem — the
            station is offline-first. Only a queue that has STOPPED MOVING is
            worth an operator's attention. */}
  <span data-testid="sync-status">
    {syncStuck ? `${syncPending} — ${t("shell.syncStuck")}` : String(syncPending)}
  </span>
</span>
```

In `apps/station/src/ui/FloorShell.tsx`, add `syncPending: number` and `syncStuck: boolean` to `FloorShellProps` and pass both straight through to `StatusBar`.

- [ ] **Step 4: Add the i18n key to BOTH dictionaries**

`en.json`, inside `shell`: `"syncStuck": "Not syncing",`
`ru.json`, inside `shell`: `"syncStuck": "Не отправляется",`

- [ ] **Step 5: Keep `App.tsx` compiling**

`App.tsx` renders `<FloorShell>` and will not typecheck without the new props. Pass literal placeholders for now — `syncPending={0} syncStuck={false}` — so this commit stays green; Task 7 replaces them with the live engine state. Do NOT add the engine here.

- [ ] **Step 6: Run it green**

Run: `pnpm --filter @markiro/station test && pnpm --filter @markiro/station typecheck`
Expected: PASS — the three new cases, the existing status-bar tests, and the i18n parity test.

- [ ] **Step 7: Commit**

```bash
git add apps/station/src/ui/StatusBar.tsx apps/station/src/ui/FloorShell.tsx apps/station/src/i18n/en.json apps/station/src/i18n/ru.json apps/station/src/App.tsx apps/station/test/status-bar.test.tsx
git commit -m "feat(station): show the sync queue in the status bar"
```

---

### Task 7: Run the sync engine in the app

**Files:**

- Modify: `apps/station/src/App.tsx`
- Test: `apps/station/test/App.test.tsx`

**Interfaces:**

- Consumes: `createSyncEngine`, `SyncState` (Task 5); `tauriExecutor` from `apps/station/src/lib/sqlite.js`; the existing `client` memo and `config.machineId`.
- Produces: nothing later tasks consume.

**Triggers, all three required:** a scan just written (the work screen signals it), the browser `online` event, and a 15-second heartbeat as the safety net. `App.tsx` already installs an `online` listener for the roster retry — add the nudge there rather than a second listener.

- [ ] **Step 1: Write the failing test**

Append to `apps/station/test/App.test.tsx`, following the file's existing mocking of `@tauri-apps/api/core`, `@tauri-apps/plugin-sql` and `../src/lib/hardware.js`:

```tsx
it("drains queued scans once the app reaches the floor", async () => {
  // Arrange the app the way the existing floor-stage tests do, with one
  // outbox row already queued, then assert the ingest call went out.
  const posts: { path: string; body: unknown }[] = [];
  await renderAtFloorStage({ onPost: (path, body) => posts.push({ path, body }) });

  await waitFor(() => expect(posts.some((p) => p.path === "/station/scans")).toBe(true));
});

it("nudges the sync engine when the device comes back online", async () => {
  const posts: { path: string; body: unknown }[] = [];
  await renderAtFloorStage({ onPost: (path, body) => posts.push({ path, body }) });
  await waitFor(() => expect(posts.length).toBeGreaterThan(0));
  const before = posts.length;

  act(() => {
    window.dispatchEvent(new Event("online"));
  });

  await waitFor(() => expect(posts.length).toBeGreaterThan(before));
});
```

`renderAtFloorStage` is a helper you add to that file: it reuses the existing floor-stage scaffolding (the query-aware `invoke` mock, a real PBKDF2 operator hash, driving the PIN pad) and seeds one `outbox` row into the mocked SQLite. If the existing tests already expose such a helper under another name, use it rather than adding a second.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @markiro/station exec vitest run App`
Expected: FAIL — nothing ever posts to `/station/scans`; the engine does not exist in `App.tsx`.

- [ ] **Step 3: Implement**

Add to `App.tsx`, alongside the other hooks and BEFORE any early return (Rules of Hooks):

```tsx
const [syncState, setSyncState] = useState<SyncState>({
  pending: 0,
  lastSuccessAt: null,
  stuck: false,
});

// One engine for the life of the app: the outbox belongs to the DEVICE, not
// to a shift or an operator, so entering or leaving a shift must never stop
// the drain. Built only once a client exists — before enrollment there is
// nowhere to send.
const syncEngine = useMemo(() => {
  if (!client || !config) return null;
  return createSyncEngine({
    exec: tauriExecutor,
    client,
    machineId: config.machineId,
    onState: setSyncState,
  });
}, [client, config?.machineId]);

useEffect(() => {
  if (!syncEngine) return;
  syncEngine.nudge();
  const heartbeat = setInterval(() => syncEngine.nudge(), 15_000);
  return () => {
    clearInterval(heartbeat);
    syncEngine.stop();
  };
}, [syncEngine]);
```

In the existing `online` listener that retries the roster sync, add `syncEngine?.nudge()` beside the retry — one listener, two consumers.

Pass the live state into the shell, replacing Task 6's placeholders:

```tsx
      syncPending={syncState.pending}
      syncStuck={syncState.stuck}
```

Give `WorkScreen` a way to signal a fresh scan, so a queued scan does not wait for the heartbeat:

```tsx
          <WorkScreen
            ...
            onScanRecorded={() => syncEngine?.nudge()}
          />
```

- [ ] **Step 4: Accept the signal in `WorkScreen`**

In `apps/station/src/pages/WorkScreen.tsx`, add `onScanRecorded?: () => void` to `WorkScreenProps` and call it from `onOutcome`, through the same `live` ref the other changing values use — the queue memo must not gain a new dependency, for the reason its existing comment gives (a recreated queue would drain concurrently with the old one).

- [ ] **Step 5: Run it green**

Run: `pnpm --filter @markiro/station test && pnpm --filter @markiro/station lint && pnpm --filter @markiro/station typecheck`
Expected: PASS on all three.

- [ ] **Step 6: Commit**

```bash
git add apps/station/src/App.tsx apps/station/src/pages/WorkScreen.tsx apps/station/test/App.test.tsx
git commit -m "feat(station): run the sync engine for the life of the app"
```

---

### Task 8: Leave the shift

**Files:**

- Modify: `apps/station/src/pages/WorkScreen.tsx`, `apps/station/src/App.tsx`, `apps/station/src/i18n/en.json`, `apps/station/src/i18n/ru.json`
- Test: `apps/station/test/work-screen.test.tsx`

**Interfaces:**

- Consumes: `syncState.pending` (Task 7).
- Produces: `WorkScreenProps` gains `onExit: () => void` and `pendingSync: number`.

**Why this is here rather than in a later slice:** 05b-3 gave the operator an honest "no signal" alarm when a scanner dies mid-shift, and no way to act on it — `WorkScreen` has no exit at all, so the setup screen is unreachable once a shift starts.

Exit returns to shift selection. It does NOT close the shift: closing stays a cabinet action (`POST /shifts/:id/close` is `SessionOnlyGuard` by decision, recorded in `docs/device-key-surface.md`).

New i18n keys under `work`: `exit`, `exitPending`, `exitAnyway`, `stay`.

- [ ] **Step 1: Write the failing test**

```tsx
it("leaves the shift immediately when nothing is queued", async () => {
  const onExit = vi.fn();
  renderWorkScreen({ onExit, pendingSync: 0 });

  fireEvent.click(screen.getByRole("button", { name: "Leave shift" }));
  expect(onExit).toHaveBeenCalledTimes(1);
});

it("warns about queued scans before leaving, and leaves anyway on confirm", async () => {
  const onExit = vi.fn();
  renderWorkScreen({ onExit, pendingSync: 12 });

  fireEvent.click(screen.getByRole("button", { name: "Leave shift" }));
  expect(onExit).not.toHaveBeenCalled();
  expect(screen.getByText("12 scans have not reached the server yet.")).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "Leave anyway" }));
  expect(onExit).toHaveBeenCalledTimes(1);
});

it("stays on the shift when the operator cancels", async () => {
  const onExit = vi.fn();
  renderWorkScreen({ onExit, pendingSync: 12 });

  fireEvent.click(screen.getByRole("button", { name: "Leave shift" }));
  fireEvent.click(screen.getByRole("button", { name: "Stay" }));
  expect(onExit).not.toHaveBeenCalled();
});
```

`renderWorkScreen` is a helper in that file supplying the props `WorkScreen` already requires (`exec`, `shiftId`, `terminalId`, `expectedGtin14`, `productName`, `counterpartyName`, `source`, `sound`) plus the two new ones. If the file already has such a helper, extend it.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @markiro/station exec vitest run work-screen`
Expected: FAIL — there is no "Leave shift" button.

- [ ] **Step 3: Implement**

Add to `WorkScreenProps`:

```tsx
  /** Return to shift selection. Does NOT close the shift — that is a cabinet action. */
  onExit: () => void;
  /** Scans still queued on this device, shown before the operator walks away. */
  pendingSync: number;
```

Add the control and its confirmation. Keep it out of the scan path's way — the operator's eyes belong on the verdict, not on chrome:

```tsx
const [confirmExit, setConfirmExit] = useState(false);

function requestExit() {
  if (pendingSync > 0) setConfirmExit(true);
  else onExit();
}
```

```tsx
<Button type="button" variant="secondary" style={{ minHeight: 64 }} onClick={requestExit}>
  {t("work.exit")}
</Button>;
{
  confirmExit ? (
    <Alert tone="warn">
      <p>{t("work.exitPending", { count: pendingSync })}</p>
      <Button type="button" style={{ minHeight: 64 }} onClick={onExit}>
        {t("work.exitAnyway")}
      </Button>
      <Button
        type="button"
        variant="secondary"
        style={{ minHeight: 64 }}
        onClick={() => setConfirmExit(false)}
      >
        {t("work.stay")}
      </Button>
    </Alert>
  ) : null;
}
```

Leaving does not stop the drain: the engine lives in `App.tsx` for the life of the app, and the outbox belongs to the device.

- [ ] **Step 4: Wire it in `App.tsx`**

Pass `onExit={() => setShift(null)}` and `pendingSync={syncState.pending}` to `<WorkScreen>`. `setShift(null)` returns the floor stage to shift selection, which is the existing branch.

- [ ] **Step 5: Add the i18n keys to BOTH dictionaries**

`en.json`, under `work`:

```json
    "exit": "Leave shift",
    "exitPending": "{{count}} scans have not reached the server yet.",
    "exitAnyway": "Leave anyway",
    "stay": "Stay",
```

`ru.json`, under `work`:

```json
    "exit": "Выйти из смены",
    "exitPending": "{{count}} сканов ещё не дошли до сервера.",
    "exitAnyway": "Всё равно выйти",
    "stay": "Остаться",
```

If `work` does not exist in the dictionaries, add it in the same position in both.

- [ ] **Step 6: Run it green**

Run: `pnpm --filter @markiro/station test`
Expected: PASS — the three new cases, the existing work-screen and App tests, and the i18n parity test.

- [ ] **Step 7: Commit**

```bash
git add apps/station/src/pages/WorkScreen.tsx apps/station/src/App.tsx apps/station/src/i18n/en.json apps/station/src/i18n/ru.json apps/station/test/work-screen.test.tsx
git commit -m "feat(station): let the operator leave a shift"
```

---

### Task 9: Late-data badge in the cabinet

**Files:**

- Modify: `apps/admin/src/pages/shifts/api.ts`, `apps/admin/src/pages/shifts/index.tsx`, and the admin RU + EN dictionaries
- Test: `apps/admin/test/shifts.test.tsx` (extend the existing shifts page test; if the file has a different name, use whichever one already renders the shifts list)

**Interfaces:**

- Consumes: `ShiftDto.lateDataAt` from the API (Task 4, Step 5).
- Produces: nothing later tasks consume.

**Why this is required rather than nice to have:** the spec's whole justification for accepting late data is that a manager who has already reported on a closed shift _finds out its totals moved_. Accepting the data and not surfacing it would be the silent behaviour the decision explicitly rejected.

- [ ] **Step 1: Write the failing test**

Follow the file's existing idioms for stubbing the shifts list response.

```tsx
it("marks a shift that received data after it was closed", async () => {
  renderShiftsPage({
    items: [
      {
        id: "s1",
        status: "closed",
        productName: "Cola",
        closedAt: "2026-07-28T18:00:00.000Z",
        lateDataAt: "2026-07-28T19:30:00.000Z",
      },
    ],
  });

  expect(await screen.findByText("Data after close")).toBeDefined();
});

it("does not mark a shift that received nothing late", async () => {
  renderShiftsPage({
    items: [
      {
        id: "s1",
        status: "closed",
        productName: "Cola",
        closedAt: "2026-07-28T18:00:00.000Z",
        lateDataAt: null,
      },
    ],
  });

  expect(screen.queryByText("Data after close")).toBeNull();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @markiro/admin exec vitest run shifts`
Expected: FAIL — the copy does not render, and TypeScript rejects `lateDataAt` because the admin's own `ShiftDto` mirror lacks it.

- [ ] **Step 3: Implement**

In `apps/admin/src/pages/shifts/api.ts`, add to that file's `ShiftDto` interface, beside `closedAt`:

```ts
lateDataAt: string | null;
```

In `apps/admin/src/pages/shifts/index.tsx`, render a `warn`-toned marker beside the status when `lateDataAt` is set. Reuse the components the table already imports (`StatusChip` / `Badge`) rather than introducing a new one, and follow how the existing `status` column builds its cell.

- [ ] **Step 4: Add the i18n keys to BOTH admin dictionaries**

Add under the shifts page's table keys, matching the neighbouring naming:

- EN: `"lateData": "Data after close"`
- RU: `"lateData": "Данные после закрытия"`

Put them at the same position in both files — the admin has a key-parity test as well.

- [ ] **Step 5: Run it green**

Run: `pnpm --filter @markiro/admin test && pnpm --filter @markiro/admin lint && pnpm --filter @markiro/admin typecheck`
Expected: PASS on all three.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/pages/shifts apps/admin/src/i18n apps/admin/test
git commit -m "feat(admin): flag shifts that received data after close"
```

---

### Task 10: Docs and full verification

**Files:**

- Modify: `docs/device-key-surface.md`, `apps/station/README.md`, `docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md`
- Test: `apps/api/test/station-scans.e2e.test.ts`

- [ ] **Step 1: Record the new device-reachable route**

Add `POST /station/scans` to the "Reachable by a device key" table in `docs/device-key-surface.md`, with the reason: delivering scans is the device's entire purpose, and making it session-only would strand every station's data on its own disk. Follow the table's existing wording style.

- [ ] **Step 2: Pin it with a positive regression test**

Add to `apps/api/test/station-scans.e2e.test.ts`, matching the annotation style 05b-3 used on the routes the station depends on:

```ts
// Device-key surface regression guard: see docs/device-key-surface.md.
// If a future hardening pass makes this session-only, every station stops
// being able to deliver its scans at all.
it("stays reachable by a station api-key", async () => {
  const agent = request.agent(app!.getHttpServer());
  await signUpAndActivate(agent);
  const apiKey = await deviceKey(agent);

  await request(app!.getHttpServer())
    .post("/station/scans")
    .set("x-api-key", apiKey)
    .send({ batchId: "machine-1:900", items: [] })
    .expect(201);
});
```

- [ ] **Step 3: Document the sync in the station README**

Add a section covering: the outbox as a device-local transport queue separate from `codes_mirror` (and why — retention must not govern delivery); the deterministic batch id and what it protects; delivery being at-least-once with server-side idempotency; the drain's triggers, batch size and backoff; the stuck-warning rule; and that leaving a shift does not stop the drain and does not close the shift. Follow the file's existing structure and tone, and do not put line numbers in it.

- [ ] **Step 4: Update the roadmap**

In `docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md`, add a `06a` row marked done with today's date, following the convention the completed `05b-3` row uses, pointing at this plan file. Note in it that cross-terminal duplicate adjudication, SSCC and the box/pallet flow remain later slices of plan 06, and check whether row `07`'s "Depends on" still reads correctly now that 06 is partially delivered.

- [ ] **Step 5: Full verification**

```bash
pnpm format:check
pnpm turbo lint typecheck test build
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
```

Expected: every turbo task green. Report per-package test counts. API e2e need the env from Global Constraints — confirm they ran rather than skipped. If `format:check` flags a file, run `pnpm format` and re-check.

**Known flake, do not chase:** one API e2e file can fail intermittently under host CPU contention on a long serial run and passes in isolation (seen on `org-profile` and `products`). If you hit it, re-run that file alone and report BOTH results honestly. Do not change test infrastructure to make it go away.

- [ ] **Step 6: Commit**

```bash
git add docs/device-key-surface.md apps/station/README.md docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md apps/api/test/station-scans.e2e.test.ts
git commit -m "docs: station sync and the device-key surface"
```
