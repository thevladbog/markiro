# Station Exceptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator recover from the four most common floor mistakes — a mis-scan, a wrongly-packed open box, a damaged label, and a box that needs to be un-packed — without leaving the station app.

**Architecture:** Four new operator actions (undo, clear, reprint, disassemble) ride the same offline-first sync-batch protocol that already carries scans and box closures (06a/06c): a new `exceptions` array on `SyncBatchDto`, applied inside the same `applyBatch` transaction, backed by a new append-only `box_exceptions` audit table and two new nullable columns (`box_items.removed_at`, `boxes.disassembled_at`) that distinguish "the operator undid this" from 06b's `displaced_at` ("another terminal's claim won"). The device frees a corrected code locally the instant the operator acts, then queues the fact for eventual delivery through the exact read-unacked → send → ack cycle the outbox already uses.

**Tech Stack:** NestJS + Drizzle + Postgres (API), Tauri + React + `tauri-plugin-sql` SQLite (station), Zod (validation), Vitest (both sides).

## Global Constraints

- `.npmrc`/`pnpm-workspace.yaml` supply-chain guard (`minimumReleaseAge`) stays as committed. Never add `minimumReleaseAgeExclude` — that is an automatic task failure.
- Every new tenant-guarded API route must be classified in `docs/device-key-surface.md` (device-reachable or `SessionOnlyGuard`), per that doc's own "Rule for new routes" section.
- Station SQLite writes: `tauri-plugin-sql` pools connections, so a multi-statement transaction (`BEGIN`/`COMMIT` across separate `exec.run` calls) is **not atomic** — never introduce one. One statement is the only atomic unit on the device (see `journal.ts`'s module doc comment for the full story).
- `?` is the correct SQLite placeholder; server-side Postgres statements use Drizzle's query builder, matching the existing code in `station-scans.service.ts`.
- SSCC is retired forever on disassembly — never reused for different contents (spec decision 4). A re-packed box gets a brand-new SSCC through the existing `SsccService.allocate` path; this plan does not touch that method.
- TDD throughout: write the failing test before the implementation, in every task below.

---

### Task 1: Server schema — `removed_at`, `disassembled_at`, `box_exceptions`

**Files:**

- Modify: `packages/db/src/schema/platform.ts` (the `boxItems` and `boxes` table definitions, and add a new `boxExceptions` table near `codeConflicts`)
- Create: a new Drizzle migration (generated, not hand-written — see Step 4)
- Test: `packages/db/test/schema.test.ts` (or the closest existing schema round-trip test file — check `packages/db/test/` for the file that already covers `boxes`/`boxItems`/`codeConflicts` and add to it)

**Interfaces:**

- Produces: `schema.boxItems.removedAt`, `schema.boxes.disassembledAt`, `schema.boxExceptions` (Drizzle table), consumed by every later server task.

- [ ] **Step 1: Add `removed_at` to `box_items` and `disassembled_at` to `boxes`**

In `packages/db/src/schema/platform.ts`, find the `boxItems` table (`export const boxItems = pgTable("box_items", { ... })`) and add one column after `displacedAt`:

```typescript
  displacedAt: timestamp("displaced_at", { withTimezone: true }),
  /**
   * Set when the OPERATOR removed this item on purpose (an "undo" of a
   * single scan, or a "clear"/"disassemble" of the whole box) — distinct
   * from `displacedAt`, which means a different terminal's earlier scan won
   * the ownership race (06b). Kept separate because the two are different
   * facts for `contentsChangedAfterClose` and any later reporting: one is
   * an operator decision, the other is a race outcome neither terminal
   * controlled.
   */
  removedAt: timestamp("removed_at", { withTimezone: true }),
```

Find the `boxes` table and add one column after `printSkippedAt`:

```typescript
    printSkippedAt: timestamp("print_skipped_at", { withTimezone: true }),
    /**
     * Set when the operator disassembled this closed box. Once set, the box
     * is retired: excluded from "active" listings, and its `sscc` is never
     * reissued — a box re-packed after disassembly is a brand-new row with
     * a brand-new SSCC through the ordinary `SsccService.allocate` path.
     */
    disassembledAt: timestamp("disassembled_at", { withTimezone: true }),
```

- [ ] **Step 2: Add the `box_exceptions` audit table**

In the same file, add a new table after `codeConflicts` (reuse its imports — `pgTable`, `uuid`, `char`, `text`, `timestamp`, `foreignKey`, `index`, already imported at the top of the file):

```typescript
/**
 * The audit trail for every undo/clear/disassemble/reprint action, whether
 * or not it actually changed anything — a no-op (the code was already
 * released elsewhere, the box was already disassembled) is still a
 * recorded attempt, never silently dropped, matching how 06c's box-closure
 * handling treats a redelivered closure. `codeHash` is set only for `undo`
 * (a single-code action); `reason` is set for reprint and disassemble
 * (see the design spec's scope decision 5 for why undo alone is reasonless).
 */
export const boxExceptions = pgTable(
  "box_exceptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    kind: text("kind").notNull(),
    boxId: uuid("box_id").notNull(),
    codeHash: char("code_hash", { length: 64 }),
    shiftId: uuid("shift_id").notNull(),
    terminalId: text("terminal_id"),
    operatorId: uuid("operator_id"),
    reason: text("reason"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("box_exceptions_tenant_box_idx").on(t.tenantId, t.boxId, t.recordedAt),
    foreignKey({
      name: "box_exceptions_tenant_box_fk",
      columns: [t.tenantId, t.boxId],
      foreignColumns: [boxes.tenantId, boxes.id],
    }),
    foreignKey({
      name: "box_exceptions_tenant_shift_fk",
      columns: [t.tenantId, t.shiftId],
      foreignColumns: [shifts.tenantId, shifts.id],
    }),
  ],
);
```

- [ ] **Step 3: Write the failing schema round-trip test**

Find the existing test file covering `boxes`/`boxItems` (search `packages/db/test/` for `boxItems` or `codeConflicts` — likely `packages/db/test/schema.test.ts` or a file named after platform tables) and add:

```typescript
it("round-trips removedAt, disassembledAt, and a box_exceptions row", async () => {
  // ... reuse this file's existing tenant/shift/box fixture setup, then:
  await db
    .update(schema.boxItems)
    .set({ removedAt: new Date() })
    .where(and(eq(schema.boxItems.tenantId, tenantId), eq(schema.boxItems.boxId, boxId)));
  await db
    .update(schema.boxes)
    .set({ disassembledAt: new Date() })
    .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.id, boxId)));
  const [exception] = await db
    .insert(schema.boxExceptions)
    .values({
      tenantId,
      kind: "disassemble",
      boxId,
      shiftId,
      terminalId: null,
      operatorId: null,
      reason: "test reason",
      occurredAt: new Date(),
    })
    .returning();
  expect(exception?.kind).toBe("disassemble");

  const [row] = await db.select().from(schema.boxes).where(eq(schema.boxes.id, boxId));
  expect(row?.disassembledAt).not.toBeNull();
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @markiro/db exec vitest run schema -t "round-trips removedAt"`
Expected: FAIL — `schema.boxExceptions` does not exist / `removedAt`/`disassembledAt` are not recognised columns.

- [ ] **Step 5: Generate the migration and verify it**

```bash
pnpm --filter @markiro/db db:generate
```

Read the generated `packages/db/migrations/00NN_*.sql` — it must contain exactly: `ALTER TABLE "box_items" ADD COLUMN "removed_at" ...`, `ALTER TABLE "boxes" ADD COLUMN "disassembled_at" ...`, `CREATE TABLE "box_exceptions" (...)`, its index, and its two foreign keys. Nothing else. Confirm the new entry in `packages/db/migrations/meta/_journal.json` has a `when` timestamp greater than every prior entry (if it collides with a migration merged to `main` since this branch started, follow the established procedure: delete this migration + its meta snapshot + journal entry, regenerate on top of `main`'s).

- [ ] **Step 6: Apply to a scratch database and run the test**

```bash
docker exec q-postgres-1 psql -U markiro -d markiro -c "CREATE DATABASE scratch_exceptions;"
DATABASE_URL="postgres://markiro:markiro@localhost:5432/scratch_exceptions" pnpm --filter @markiro/db exec drizzle-kit migrate
DATABASE_URL="postgres://markiro:markiro@localhost:5432/scratch_exceptions" pnpm --filter @markiro/db exec vitest run schema -t "round-trips removedAt"
docker exec q-postgres-1 psql -U markiro -d postgres -c "DROP DATABASE scratch_exceptions;"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/platform.ts packages/db/migrations packages/db/test
git commit -m "feat(db): add box_items.removed_at, boxes.disassembled_at, box_exceptions table"
```

---

### Task 2: Station schema — mirror columns and the exceptions mirror table

**Files:**

- Modify: `packages/db/src/sqlite/migrations.ts` (append new `ALTER`/`CREATE` statements — never edit existing ones, this array is replayed on every boot)
- Modify: `packages/db/src/sqlite/schema.ts` (drizzle-sqlite parity file — must stay in sync with `migrations.ts`, per that file's own header comment)
- Test: `packages/db/test/sqlite-schema.test.ts`

**Interfaces:**

- Produces: `boxes_mirror.disassembled_at`, table `box_exceptions_mirror` (columns: `id`, `kind`, `box_id`, `code_hash`, `shift_id`, `terminal_id`, `operator_id`, `reason`, `at`) — consumed by Task 9 (station lib) and Task 12 (sync engine).

- [ ] **Step 1: Append the new DDL to `STATION_MIGRATIONS`**

In `packages/db/src/sqlite/migrations.ts`, add these two entries at the **end** of the array (after the existing `box_label_template_spec` ALTER):

```typescript
  // Station exceptions (undo/clear/reprint/disassemble): the box's own
  // retired flag. Upgrade path for devices enrolled before this slice --
  // same re-runnable idempotency as the `login` ALTER above (SQLite has no
  // `ADD COLUMN IF NOT EXISTS`, and applyMigrations swallows the resulting
  // "duplicate column name" once the column already exists).
  `ALTER TABLE boxes_mirror ADD COLUMN disassembled_at TEXT;`,
  // The device-local queue for exception facts, drained the same
  // read-unacked -> send -> ack-by-hard-delete way the outbox already is
  // (outbox.ts's readBatch/ackThrough) -- these rows are pure facts, never
  // updated in place after insert, so they need no boxes_mirror-style
  // acked_at flag or content signature: a plain monotonic id ceiling is
  // enough (see sync.ts's box-exceptions read/ack functions).
  `CREATE TABLE IF NOT EXISTS box_exceptions_mirror (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL,
     box_id TEXT NOT NULL,
     code_hash TEXT,
     shift_id TEXT NOT NULL,
     terminal_id TEXT,
     operator_id TEXT,
     reason TEXT,
     at TEXT NOT NULL
   );`,
```

- [ ] **Step 2: Mirror the same shape in the drizzle-sqlite parity file**

In `packages/db/src/sqlite/schema.ts`, find `boxesMirror` and add one field:

```typescript
export const boxesMirror = sqliteTable("boxes_mirror", {
  boxId: text("box_id").primaryKey(),
  shiftId: text("shift_id").notNull(),
  terminalId: text("terminal_id"),
  sscc: text("sscc"),
  openedAt: text("opened_at").notNull(),
  closedAt: text("closed_at"),
  closedBy: text("closed_by"),
  ackedAt: text("acked_at"),
  printVerifiedAt: text("print_verified_at"),
  printSkippedAt: text("print_skipped_at"),
  disassembledAt: text("disassembled_at"),
});
```

Add a new table after `conflictsMirror`:

```typescript
export const boxExceptionsMirror = sqliteTable("box_exceptions_mirror", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(),
  boxId: text("box_id").notNull(),
  codeHash: text("code_hash"),
  shiftId: text("shift_id").notNull(),
  terminalId: text("terminal_id"),
  operatorId: text("operator_id"),
  reason: text("reason"),
  at: text("at").notNull(),
});
```

- [ ] **Step 3: Write the failing round-trip test**

In `packages/db/test/sqlite-schema.test.ts`, find the pattern used for `boxesMirror`/`conflictsMirror` (a fresh `node:sqlite` connection, apply `STATION_MIGRATIONS`, insert via the drizzle-sqlite table, read back with the raw driver or vice versa) and add:

```typescript
it("round-trips boxes_mirror.disassembled_at and box_exceptions_mirror", () => {
  applyStationMigrations(db); // reuse this file's existing helper name
  db.exec(
    `INSERT INTO boxes_mirror (box_id, shift_id, opened_at, disassembled_at)
     VALUES ('b1', 's1', '2026-07-30T00:00:00.000Z', '2026-07-30T00:05:00.000Z')`,
  );
  const [box] = db
    .prepare("SELECT disassembled_at FROM boxes_mirror WHERE box_id = 'b1'")
    .all() as {
    disassembled_at: string;
  }[];
  expect(box?.disassembled_at).toBe("2026-07-30T00:05:00.000Z");

  db.exec(
    `INSERT INTO box_exceptions_mirror (kind, box_id, shift_id, at)
     VALUES ('clear', 'b1', 's1', '2026-07-30T00:06:00.000Z')`,
  );
  const rows = db.prepare("SELECT * FROM box_exceptions_mirror").all() as { id: number }[];
  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe(1);
});
```

(Match this file's actual helper names — read its existing tests first; the shape above is illustrative of the exact assertions needed, not a literal drop-in.)

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @markiro/db exec vitest run sqlite-schema -t "round-trips boxes_mirror.disassembled_at"`
Expected: FAIL — no such column/table.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @markiro/db exec vitest run sqlite-schema -t "round-trips boxes_mirror.disassembled_at"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/sqlite/migrations.ts packages/db/src/sqlite/schema.ts packages/db/test/sqlite-schema.test.ts
git commit -m "feat(db): station mirror schema for box exceptions"
```

---

### Task 3: Sync protocol — `exceptions` on `SyncBatchDto`

**Files:**

- Modify: `apps/api/src/modules/station-scans/dto.ts`
- Create: `apps/api/src/modules/station-scans/box-exceptions.ts`
- Test: `apps/api/test/box-exceptions.test.ts`

**Interfaces:**

- Consumes: nothing new (pure Zod + pure TS).
- Produces: `ExceptionDto` (exported type), `syncBatchSchema.exceptions` (zod), `sortExceptions(exceptions: ExceptionDto[]): ExceptionDto[]` — consumed by Task 4-7 (station-scans.service.ts).

- [ ] **Step 1: Write the failing test for the sort helper**

Create `apps/api/test/box-exceptions.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { sortExceptions, type ExceptionDto } from "../src/modules/station-scans/box-exceptions";

function ex(
  boxId: string,
  kind: ExceptionDto["kind"],
  codeHash: string | null = null,
): ExceptionDto {
  return {
    kind,
    boxId,
    codeHash,
    shiftId: "s1",
    terminalId: null,
    operatorId: null,
    reason: kind === "undo" ? null : "test",
    occurredAt: "2026-07-30T00:00:00.000Z",
  };
}

describe("sortExceptions", () => {
  it("orders deterministically by boxId, then kind, then codeHash", () => {
    const input = [
      ex("b2", "reprint"),
      ex("b1", "clear"),
      ex("b1", "undo", "hash2"),
      ex("b1", "undo", "hash1"),
    ];
    const sorted = sortExceptions(input);
    expect(sorted.map((e) => `${e.boxId}:${e.kind}:${e.codeHash ?? ""}`)).toEqual([
      "b1:clear:",
      "b1:undo:hash1",
      "b1:undo:hash2",
      "b2:reprint:",
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/api exec vitest run box-exceptions -t "orders deterministically"`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `box-exceptions.ts` with the DTO type and sort helper**

```typescript
/** One exception fact from a device's sync batch. */
export interface ExceptionDto {
  kind: "undo" | "clear" | "disassemble" | "reprint";
  boxId: string;
  /** Only set for "undo" -- the single code it targets. */
  codeHash: string | null;
  shiftId: string;
  terminalId: string | null;
  operatorId: string | null;
  /** Required for reprint and disassemble -- see the design spec, scope decision 5. */
  reason: string | null;
  occurredAt: string;
}

/**
 * Deterministic processing order: by boxId first (same 40P01-avoidance
 * reasoning the item upsert and box-closure loop already use -- concurrent
 * batches touching overlapping boxes must acquire them in the same order),
 * then kind, then codeHash so two "undo"s on the same box are stable too.
 */
export function sortExceptions(exceptions: ExceptionDto[]): ExceptionDto[] {
  return [...exceptions].sort((a, b) => {
    if (a.boxId !== b.boxId) return a.boxId.localeCompare(b.boxId);
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return (a.codeHash ?? "").localeCompare(b.codeHash ?? "");
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @markiro/api exec vitest run box-exceptions -t "orders deterministically"`
Expected: PASS.

- [ ] **Step 5: Add the Zod schema to `dto.ts`**

In `apps/api/src/modules/station-scans/dto.ts`, add after the `boxes` field of `syncBatchSchema` (before the closing `});`):

```typescript
  // Operator exceptions carried by this batch (undo/clear/disassemble/
  // reprint) -- see box-exceptions.ts. Independent of `items`/`boxes` for
  // the same reason boxes are: the fact a device queues can outlive the
  // scan or closure it corrects by an arbitrary number of batches.
  exceptions: z
    .array(
      z
        .object({
          kind: z.enum(["undo", "clear", "disassemble", "reprint"]),
          boxId: z.string().min(1).max(64),
          codeHash: z.string().length(64).nullable(),
          shiftId: z.string().uuid().toLowerCase(),
          terminalId: z.string().nullable(),
          operatorId: z.string().uuid().toLowerCase().nullable(),
          reason: z.string().min(1).max(500).nullable(),
          occurredAt: z.string().datetime(),
        })
        .superRefine((exception, ctx) => {
          const codeShapeValid =
            exception.kind === "undo" ? exception.codeHash !== null : exception.codeHash === null;
          const reasonShapeValid =
            exception.kind === "undo" || exception.kind === "clear"
              ? exception.reason === null
              : exception.reason !== null;
          if (!codeShapeValid) {
            ctx.addIssue({ code: "custom", path: ["codeHash"], message: "Invalid codeHash" });
          }
          if (!reasonShapeValid) {
            ctx.addIssue({ code: "custom", path: ["reason"], message: "Invalid reason" });
          }
        }),
    )
    .max(200)
    .default([]),
```

- [ ] **Step 6: Run the full station-scans DTO-adjacent test suite**

Run: `pnpm --filter @markiro/api exec vitest run station-scans`
Expected: PASS (no existing test constructs a `SyncBatchDto` literal that would break under a new `.default([])` field).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/station-scans/dto.ts apps/api/src/modules/station-scans/box-exceptions.ts apps/api/test/box-exceptions.test.ts
git commit -m "feat(api): exceptions array on SyncBatchDto + deterministic sort helper"
```

---

### Task 4: Server — apply "undo"

**Files:**

- Modify: `apps/api/src/modules/station-scans/station-scans.service.ts`
- Test: `apps/api/test/station-scans.e2e.test.ts`

**Interfaces:**

- Consumes: `ExceptionDto`, `sortExceptions` (Task 3).
- Produces: exception processing block inside `applyBatch`'s transaction, reused and extended by Tasks 5-7.

- [ ] **Step 1: Write the failing e2e test**

In `apps/api/test/station-scans.e2e.test.ts`, find this file's existing helpers (`signUpAndActivate`, `deviceKey`, `createActiveProduct`, and whatever helper opens a shift and posts a scan + box closure — reuse them) and add a new `describe("exceptions", ...)` block:

```typescript
describe("exceptions", () => {
  it("undo releases the code from the registry and marks the box item removed", async () => {
    const agent = request.agent(app!.getHttpAdapter().getInstance());
    await signUpAndActivate(agent);
    const key = await deviceKey(agent);
    const productId = await createActiveProduct(agent);
    // ... reuse this file's existing shift-open + first-scan-into-a-box helper
    // to get a shiftId, terminalId, boxId, and codeHash for one accepted,
    // still-open-box item -- copy the setup from an existing box-membership
    // test in this same file rather than re-deriving it here.

    const undoRes = await agent
      .post("/station/scans")
      .set("x-api-key", key)
      .send({
        batchId: `undo-test-${randomUUID()}`,
        items: [],
        boxes: [],
        exceptions: [
          {
            kind: "undo",
            boxId,
            codeHash,
            shiftId,
            terminalId,
            operatorId: null,
            reason: null,
            occurredAt: new Date().toISOString(),
          },
        ],
      })
      .expect(201);
    expect(undoRes.body.applied).toBe(0);

    const [registryRow] = await db
      .select()
      .from(schema.codeRegistry)
      .where(
        and(eq(schema.codeRegistry.tenantId, tenantId), eq(schema.codeRegistry.codeHash, codeHash)),
      );
    expect(registryRow).toBeUndefined();

    const [itemRow] = await db
      .select()
      .from(schema.boxItems)
      .where(
        and(
          eq(schema.boxItems.tenantId, tenantId),
          eq(schema.boxItems.boxId, boxId),
          eq(schema.boxItems.codeHash, codeHash),
        ),
      );
    expect(itemRow?.removedAt).not.toBeNull();

    const [auditRow] = await db
      .select()
      .from(schema.boxExceptions)
      .where(eq(schema.boxExceptions.tenantId, tenantId));
    expect(auditRow?.kind).toBe("undo");
  });

  it("undo on a code already displaced to another terminal is a harmless no-op", async () => {
    // Set up a code_registry row OWNED BY A DIFFERENT terminal/shift, then
    // send an "undo" from the ORIGINAL terminal/shift -- assert the
    // registry row is untouched and no error is thrown.
  });

  it("redelivering the same undo exception twice is idempotent", async () => {
    // Send the same batchId twice -- assert alreadyApplied on the second,
    // and exactly one box_exceptions row exists.
  });
});
```

(Fill in the box-membership setup by copying the exact pattern this file already uses for its existing box-closure tests — do not invent a new fixture shape.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/api exec vitest run station-scans.e2e -t "undo releases"`
Expected: FAIL — the server ignores `exceptions` entirely (Zod strips unknown behaviour is not the issue; the field is accepted but never applied), so `registryRow` still exists and `itemRow.removedAt` is null.

- [ ] **Step 3: Implement exception application in `station-scans.service.ts`**

Add the import at the top of `apps/api/src/modules/station-scans/station-scans.service.ts`:

```typescript
import { sortExceptions, type ExceptionDto } from "./box-exceptions";
```

Add a new private method to `StationScansService`, and call it from `applyBatch` right after the box-closures loop (after the `if (body.boxes.length > 0) { ... }` block, before `return { applied: ... }`):

```typescript
      if (body.exceptions.length > 0) {
        await this.applyExceptions(tx, tenantId, sortExceptions(body.exceptions));
      }

      return { applied: body.items.length, alreadyApplied: false, conflicts: batchConflicts };
    });
  }

  /**
   * Applies undo/clear/disassemble/reprint facts, one at a time in the
   * sorted order the caller already computed. Every kind writes its own
   * `box_exceptions` row regardless of whether anything else changed -- a
   * no-op (redelivery, a code already released elsewhere) is still a
   * recorded attempt (see box-exceptions.ts's doc comment).
   */
  private async applyExceptions(
    tx: Db,
    tenantId: string,
    exceptions: ExceptionDto[],
  ): Promise<void> {
    for (const ex of exceptions) {
      if (ex.kind === "undo" && ex.codeHash) {
        await this.releaseCode(tx, tenantId, ex.codeHash, ex.shiftId, ex.terminalId);
        await tx
          .update(schema.boxItems)
          .set({ removedAt: sql`now()` })
          .where(
            and(
              eq(schema.boxItems.tenantId, tenantId),
              eq(schema.boxItems.boxId, ex.boxId),
              eq(schema.boxItems.codeHash, ex.codeHash),
              isNull(schema.boxItems.displacedAt),
              isNull(schema.boxItems.removedAt),
            ),
          );
      }
      // "clear" and "disassemble" are added in Tasks 5-6; "reprint" writes
      // only the audit row below, added in Task 7.
      await tx.insert(schema.boxExceptions).values({
        tenantId,
        kind: ex.kind,
        boxId: ex.boxId,
        codeHash: ex.codeHash,
        shiftId: ex.shiftId,
        terminalId: ex.terminalId,
        operatorId: ex.operatorId,
        reason: ex.reason,
        occurredAt: new Date(ex.occurredAt),
      });
    }
  }

  /**
   * Releases a code claim, scoped to the EXACT scan that still holds it
   * (tenant + codeHash + shiftId + terminalId). If the code was displaced
   * to another terminal in the meantime (06b), this WHERE matches nothing
   * -- a harmless no-op, since the code was never really this device's to
   * release once displaced.
   */
  private async releaseCode(
    tx: Db,
    tenantId: string,
    codeHash: string,
    shiftId: string,
    terminalId: string | null,
  ): Promise<void> {
    const terminalCondition =
      terminalId === null
        ? isNull(schema.codeRegistry.terminalId)
        : eq(schema.codeRegistry.terminalId, terminalId);
    await tx
      .delete(schema.codeRegistry)
      .where(
        and(
          eq(schema.codeRegistry.tenantId, tenantId),
          eq(schema.codeRegistry.codeHash, codeHash),
          eq(schema.codeRegistry.shiftId, shiftId),
          terminalCondition,
        ),
      );
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @markiro/api exec vitest run station-scans.e2e -t "undo"`
Expected: PASS, all three.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/station-scans/station-scans.service.ts apps/api/test/station-scans.e2e.test.ts
git commit -m "feat(api): apply undo exceptions in the sync batch transaction"
```

---

### Task 5: Server — apply "clear"

**Files:**

- Modify: `apps/api/src/modules/station-scans/station-scans.service.ts`
- Test: `apps/api/test/station-scans.e2e.test.ts`

**Interfaces:**

- Consumes: `applyExceptions` (Task 4), extends its `switch`/`if` chain.
- Produces: nothing new for later tasks — this is the second of four kinds handled by the same method.

- [ ] **Step 1: Write the failing e2e test**

Add to the same `describe("exceptions", ...)` block:

```typescript
it("clear removes every active item from a still-open box, closes none of it", async () => {
  // Setup: an OPEN box (no closedAt) with 2 accepted items on this shift/terminal.
  await agent
    .post("/station/scans")
    .set("x-api-key", key)
    .send({
      batchId: `clear-test-${randomUUID()}`,
      items: [],
      boxes: [],
      exceptions: [
        {
          kind: "clear",
          boxId,
          codeHash: null,
          shiftId,
          terminalId,
          operatorId: null,
          reason: "wrong destination",
          occurredAt: new Date().toISOString(),
        },
      ],
    })
    .expect(201);

  const items = await db
    .select()
    .from(schema.boxItems)
    .where(and(eq(schema.boxItems.tenantId, tenantId), eq(schema.boxItems.boxId, boxId)));
  expect(items.every((i) => i.removedAt !== null)).toBe(true);

  const registryRows = await db
    .select()
    .from(schema.codeRegistry)
    .where(
      and(
        eq(schema.codeRegistry.tenantId, tenantId),
        inArray(schema.codeRegistry.codeHash, [codeHash1, codeHash2]),
      ),
    );
  expect(registryRows).toHaveLength(0);

  const [box] = await db.select().from(schema.boxes).where(eq(schema.boxes.id, boxId));
  expect(box?.closedAt).toBeNull();
  expect(box?.disassembledAt).toBeNull();
});

it("clear on an already-closed box is a no-op (guarded by closedAt IS NULL)", async () => {
  // Setup: a CLOSED box. Send "clear" against it, assert its items are
  // untouched (still not removed) and the box stays closed/not-disassembled.
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/api exec vitest run station-scans.e2e -t "clear removes"`
Expected: FAIL — `applyExceptions` does not yet handle `"clear"`.

- [ ] **Step 3: Implement "clear" in `applyExceptions`**

In `station-scans.service.ts`, extend the loop body added in Task 4, inserting a new branch before the existing `if (ex.kind === "undo" ...)`:

```typescript
      if (ex.kind === "clear" || ex.kind === "disassemble") {
        const guard =
          ex.kind === "clear" ? isNull(schema.boxes.closedAt) : sql`${schema.boxes.closedAt} IS NOT NULL`;
        const boxMatch = await tx
          .select({ id: schema.boxes.id })
          .from(schema.boxes)
          .where(
            and(
              eq(schema.boxes.tenantId, tenantId),
              eq(schema.boxes.id, ex.boxId),
              guard,
              isNull(schema.boxes.disassembledAt),
            ),
          );
        if (boxMatch.length > 0) {
          const activeItems = await tx
            .select({ codeHash: schema.boxItems.codeHash })
            .from(schema.boxItems)
            .where(
              and(
                eq(schema.boxItems.tenantId, tenantId),
                eq(schema.boxItems.boxId, ex.boxId),
                isNull(schema.boxItems.displacedAt),
                isNull(schema.boxItems.removedAt),
              ),
            );
          for (const item of activeItems) {
            await this.releaseCode(tx, tenantId, item.codeHash, ex.shiftId, ex.terminalId);
          }
          await tx
            .update(schema.boxItems)
            .set({ removedAt: sql`now()` })
            .where(
              and(
                eq(schema.boxItems.tenantId, tenantId),
                eq(schema.boxItems.boxId, ex.boxId),
                isNull(schema.boxItems.displacedAt),
                isNull(schema.boxItems.removedAt),
              ),
            );
          if (ex.kind === "disassemble") {
            await tx
              .update(schema.boxes)
              .set({ disassembledAt: sql`now()` })
              .where(and(eq(schema.boxes.tenantId, tenantId), eq(schema.boxes.id, ex.boxId)));
          }
        }
      } else if (ex.kind === "undo" && ex.codeHash) {
```

(Note: `boxId` in `ExceptionDto` is the device-local id, a string, whereas `schema.boxes.id` is the server's own UUID primary key — this needs a resolution step. Fix this before shipping: box closures in Task 10/13's code resolve a device box id to a server row via the four-column match `(tenantId, shiftId, terminalId, deviceBoxId)`, not `boxes.id` directly. Change every `eq(schema.boxes.id, ex.boxId)` above to the same four-column match `station-scans.service.ts`'s existing closures loop already uses: `eq(schema.boxes.shiftId, ex.shiftId)`, the `terminalCondition` pattern, and `eq(schema.boxes.deviceBoxId, ex.boxId)` — copy that exact three-condition shape from the closures loop above this method, and thread the resolved server `boxes.id` through to the `box_items`/`box_exceptions` writes, which key on it, not the device id.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @markiro/api exec vitest run station-scans.e2e -t "clear"`
Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/station-scans/station-scans.service.ts apps/api/test/station-scans.e2e.test.ts
git commit -m "feat(api): apply clear exceptions, guarded to still-open boxes"
```

---

### Task 6: Server — apply "disassemble" + SSCC-never-reused test

**Files:**

- Modify: `apps/api/src/modules/station-scans/station-scans.service.ts` (already handles `disassemble` structurally from Task 5's shared branch — this task verifies and locks it down with the compliance-critical test)
- Test: `apps/api/test/station-scans.e2e.test.ts`, `apps/api/test/sscc-settings.e2e.test.ts` (or wherever the existing `SsccService.allocate` e2e coverage lives — check for the file, likely under this name or `sscc.e2e.test.ts`)

**Interfaces:**

- Consumes: the shared `clear`/`disassemble` branch from Task 5.
- Produces: nothing new — this task is verification-only, closing the loop the spec calls out as the compliance-critical guarantee.

- [ ] **Step 1: Write the failing e2e test for disassemble on a closed box**

Add to `station-scans.e2e.test.ts`:

```typescript
it("disassemble retires a closed box: items released, box excluded from active listing", async () => {
  // Setup: a CLOSED box with an sscc already assigned, 2 items.
  await agent
    .post("/station/scans")
    .set("x-api-key", key)
    .send({
      batchId: `disassemble-test-${randomUUID()}`,
      items: [],
      boxes: [],
      exceptions: [
        {
          kind: "disassemble",
          boxId,
          codeHash: null,
          shiftId,
          terminalId,
          operatorId: null,
          reason: "packed for wrong customer",
          occurredAt: new Date().toISOString(),
        },
      ],
    })
    .expect(201);

  const [box] = await db.select().from(schema.boxes).where(eq(schema.boxes.id, boxId));
  expect(box?.disassembledAt).not.toBeNull();
  expect(box?.sscc).not.toBeNull(); // the sscc string itself is kept, historical -- only disassembledAt marks retirement

  const items = await db
    .select()
    .from(schema.boxItems)
    .where(and(eq(schema.boxItems.tenantId, tenantId), eq(schema.boxItems.boxId, boxId)));
  expect(items.every((i) => i.removedAt !== null)).toBe(true);
});
```

- [ ] **Step 2: Write the failing SSCC-never-reused e2e test**

Add to the SSCC e2e test file (find it via `grep -rl "allocateForBundle\|SsccService" apps/api/test`):

```typescript
it("a disassembled box's SSCC never reappears in a later allocation for the same prefix", async () => {
  // 1. Allocate a block, close a box with it (whatever this file's existing
  //    helper for driving SsccService.allocate + a box closure already is).
  // 2. Disassemble that box via POST /station/scans with a "disassemble" exception.
  // 3. Exhaust or otherwise force a fresh allocation for the SAME
  //    (tenantId, issuerPrefix, extensionDigit).
  // 4. Assert the disassembled box's own sscc string never appears as a
  //    `from_serial..to_serial` range or as any box's own `sscc` again.
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `pnpm --filter @markiro/api exec vitest run station-scans.e2e -t "disassemble retires"` and the SSCC file's new test.
Expected: the first FAILs if Task 5's branch has a bug in the box-id resolution fix called out in that task's Step 3 note; the second should already PASS once Task 5 lands correctly, since `SsccService.allocate` was never touched by this plan — this test exists to LOCK DOWN that guarantee, not to drive new production code.

- [ ] **Step 4: Fix any remaining issue from Task 5's box-id resolution note, then verify both pass**

Run the same two commands again.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/test/station-scans.e2e.test.ts apps/api/test/sscc-settings.e2e.test.ts
git commit -m "test(api): lock down disassemble's SSCC-never-reused guarantee"
```

---

### Task 7: Server — apply "reprint" + `listBoxes` corrections

**Files:**

- Modify: `apps/api/src/modules/station-scans/station-scans.service.ts`, `apps/api/src/modules/boxes/boxes.service.ts`, `apps/api/src/modules/boxes/dto.ts`
- Test: `apps/api/test/station-scans.e2e.test.ts`, `apps/api/test/boxes.e2e.test.ts`

**Interfaces:**

- Consumes: `applyExceptions` (Task 4-5).
- Produces: `BoxDto.disassembledAt` — consumed by Task 8's cabinet endpoint and any future cabinet UI.

- [ ] **Step 1: Write the failing e2e test for reprint**

```typescript
it("reprint writes only an audit row -- no box or item state changes", async () => {
  const before = await db.select().from(schema.boxes).where(eq(schema.boxes.id, boxId));
  await agent
    .post("/station/scans")
    .set("x-api-key", key)
    .send({
      batchId: `reprint-test-${randomUUID()}`,
      items: [],
      boxes: [],
      exceptions: [
        {
          kind: "reprint",
          boxId,
          codeHash: null,
          shiftId,
          terminalId,
          operatorId: null,
          reason: "label jammed",
          occurredAt: new Date().toISOString(),
        },
      ],
    })
    .expect(201);
  const after = await db.select().from(schema.boxes).where(eq(schema.boxes.id, boxId));
  expect(after).toEqual(before);
  const [audit] = await db
    .select()
    .from(schema.boxExceptions)
    .where(
      and(eq(schema.boxExceptions.tenantId, tenantId), eq(schema.boxExceptions.kind, "reprint")),
    );
  expect(audit?.reason).toBe("label jammed");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/api exec vitest run station-scans.e2e -t "reprint writes only"`
Expected: since `applyExceptions`'s loop (Task 4-5) already falls through to writing the audit row for ANY kind including `"reprint"` (no branch touches box/item state for it), this test should already PASS. If it does, this step confirms the existing implementation rather than driving new code — note that in the task report rather than adding a needless branch.

- [ ] **Step 3: Add `disassembledAt` to `BoxDto` and exclude removed items from `itemCount`**

In `apps/api/src/modules/boxes/dto.ts`, add one field to `BoxDto`:

```typescript
export interface BoxDto {
  id: string;
  sscc: string | null;
  terminalId: string | null;
  operatorId: string | null;
  itemCount: number;
  closedAt: Date | null;
  contentsChangedAfterClose: boolean;
  disassembledAt: Date | null;
}
```

In `apps/api/src/modules/boxes/boxes.service.ts`, update the `itemCount` aggregate to also exclude removed items (find the line `count(${schema.boxItems.codeHash}) filter (where ${schema.boxItems.displacedAt} is null)` and change it):

```typescript
        itemCount:
          sql<number>`count(${schema.boxItems.codeHash}) filter (where ${schema.boxItems.displacedAt} is null and ${schema.boxItems.removedAt} is null)`.mapWith(
            Number,
          ),
```

Add `disassembledAt: schema.boxes.disassembledAt` to the `select` object and to `BoxRow`/`toDto`.

- [ ] **Step 4: Write the failing test for the listBoxes correction**

In `apps/api/test/boxes.e2e.test.ts`, add:

```typescript
it("excludes operator-removed items from itemCount and surfaces disassembledAt", async () => {
  // Setup: a box with 2 items, one marked removedAt via a "clear"/"undo"
  // exception through POST /station/scans (reuse the pattern from
  // station-scans.e2e.test.ts's exceptions block).
  const res = await agent.get(`/boxes?shiftId=${shiftId}`).expect(200);
  const box = res.body.items.find((b: { id: string }) => b.id === boxId);
  expect(box.itemCount).toBe(1);
  expect(box.disassembledAt).toBeNull();
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @markiro/api exec vitest run boxes.e2e -t "excludes operator-removed"` and the reprint test from Step 1.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/boxes/dto.ts apps/api/src/modules/boxes/boxes.service.ts apps/api/test/boxes.e2e.test.ts apps/api/test/station-scans.e2e.test.ts
git commit -m "feat(api): reprint audit-only path, listBoxes excludes removed items"
```

---

### Task 8: Server — cabinet-only audit read endpoint

**Files:**

- Create: `apps/api/src/modules/box-exceptions/box-exceptions.controller.ts`, `apps/api/src/modules/box-exceptions/box-exceptions.service.ts`, `apps/api/src/modules/box-exceptions/box-exceptions.module.ts`, `apps/api/src/modules/box-exceptions/dto.ts`
- Modify: `apps/api/src/app.module.ts` (register the new module), `docs/device-key-surface.md`
- Test: `apps/api/test/box-exceptions.e2e.test.ts`

**Interfaces:**

- Consumes: `schema.boxExceptions` (Task 1).
- Produces: `GET /box-exceptions?shiftId=` — a manager-only read of the audit trail, mirroring `boxes.controller.ts`'s exact guard shape.

- [ ] **Step 1: Write the failing e2e test, including the 403 device-key regression test**

Create `apps/api/test/box-exceptions.e2e.test.ts` following the exact harness pattern of `boxes.e2e.test.ts` (copy its `beforeAll`/`signUpAndActivate`/`deviceKey` setup):

```typescript
describe.skipIf(!ready)("box-exceptions e2e", () => {
  // ... same beforeAll/afterAll as boxes.e2e.test.ts

  it("lists exceptions for a shift, newest first", async () => {
    // Setup: two exceptions recorded via POST /station/scans (reuse the
    // pattern from station-scans.e2e.test.ts's exceptions block), then:
    const res = await agent.get(`/box-exceptions?shiftId=${shiftId}`).expect(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].kind).toBeDefined();
  });

  it("rejects a station device api-key with 403", async () => {
    const key = await deviceKey(agent);
    await request(app!.getHttpAdapter().getInstance())
      .get(`/box-exceptions?shiftId=${shiftId}`)
      .set("x-api-key", key)
      .expect(403);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/api exec vitest run box-exceptions.e2e`
Expected: FAIL — 404, the route does not exist yet.

- [ ] **Step 3: Create the DTO**

`apps/api/src/modules/box-exceptions/dto.ts`:

```typescript
import { z } from "zod";

export const listBoxExceptionsQuerySchema = z.object({
  shiftId: z.string().uuid(),
});
export type ListBoxExceptionsQueryDto = z.infer<typeof listBoxExceptionsQuerySchema>;

export interface BoxExceptionDto {
  id: string;
  kind: string;
  boxId: string;
  codeHash: string | null;
  terminalId: string | null;
  operatorId: string | null;
  reason: string | null;
  occurredAt: Date;
  recordedAt: Date;
}

export interface ListBoxExceptionsResponseDto {
  items: BoxExceptionDto[];
}
```

- [ ] **Step 4: Create the service**

`apps/api/src/modules/box-exceptions/box-exceptions.service.ts`:

```typescript
import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type {
  BoxExceptionDto,
  ListBoxExceptionsQueryDto,
  ListBoxExceptionsResponseDto,
} from "./dto";

@Injectable()
export class BoxExceptionsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listBoxExceptions(
    tenantId: string,
    query: ListBoxExceptionsQueryDto,
  ): Promise<ListBoxExceptionsResponseDto> {
    const rows = await this.db
      .select()
      .from(schema.boxExceptions)
      .where(
        and(
          eq(schema.boxExceptions.tenantId, tenantId),
          eq(schema.boxExceptions.shiftId, query.shiftId),
        ),
      )
      .orderBy(desc(schema.boxExceptions.recordedAt));
    return {
      items: rows.map((r): BoxExceptionDto => ({
        id: r.id,
        kind: r.kind,
        boxId: r.boxId,
        codeHash: r.codeHash,
        terminalId: r.terminalId,
        operatorId: r.operatorId,
        reason: r.reason,
        occurredAt: r.occurredAt,
        recordedAt: r.recordedAt,
      })),
    };
  }
}
```

- [ ] **Step 5: Create the controller (copying `boxes.controller.ts`'s guard shape exactly)**

`apps/api/src/modules/box-exceptions/box-exceptions.controller.ts`:

```typescript
import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { SessionOnlyGuard } from "../../tenancy/session-only.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  listBoxExceptionsQuerySchema,
  type ListBoxExceptionsQueryDto,
  type ListBoxExceptionsResponseDto,
} from "./dto";
import { BoxExceptionsService } from "./box-exceptions.service";

/**
 * Manager-only, same reasoning as boxes.controller.ts: a station has no
 * business browsing the exception ledger, its own or another terminal's --
 * this is the audit trail a manager reviews, not a floor concern.
 */
@ApiTags("box-exceptions")
@Controller("box-exceptions")
@UseGuards(TenantGuard, SessionOnlyGuard)
export class BoxExceptionsController {
  constructor(private readonly boxExceptionsService: BoxExceptionsService) {}

  @Get()
  async listBoxExceptions(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listBoxExceptionsQuerySchema)) query: ListBoxExceptionsQueryDto,
  ): Promise<ListBoxExceptionsResponseDto> {
    return this.boxExceptionsService.listBoxExceptions(req.tenantId!, query);
  }
}
```

`apps/api/src/modules/box-exceptions/box-exceptions.module.ts`:

```typescript
import { Module } from "@nestjs/common";
import { BoxExceptionsController } from "./box-exceptions.controller";
import { BoxExceptionsService } from "./box-exceptions.service";

@Module({
  controllers: [BoxExceptionsController],
  providers: [BoxExceptionsService],
})
export class BoxExceptionsModule {}
```

- [ ] **Step 6: Register the module in `app.module.ts`**

Find `BoxesModule` in the `imports` array of `apps/api/src/app.module.ts` and add `BoxExceptionsModule` next to it (plus its import statement at the top).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @markiro/api exec vitest run box-exceptions.e2e`
Expected: PASS, both.

- [ ] **Step 8: Update `docs/device-key-surface.md`**

Add a row to the "Cabinet-only (`SessionOnlyGuard`)" table, next to `GET /boxes`:

```
| `GET /box-exceptions` | the undo/clear/reprint/disassemble audit trail — a manager-only ledger, same reasoning as `GET /boxes`; pinned by a 403 e2e test (`apps/api/test/box-exceptions.e2e.test.ts`) |
```

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/box-exceptions apps/api/src/app.module.ts apps/api/test/box-exceptions.e2e.test.ts docs/device-key-surface.md
git commit -m "feat(api): cabinet-only GET /box-exceptions audit endpoint"
```

---

### Task 9: Station lib — `box-exceptions-mirror.ts`

**Files:**

- Create: `apps/station/src/lib/box-exceptions-mirror.ts`
- Test: `apps/station/test/box-exceptions-mirror.test.ts`

**Interfaces:**

- Consumes: `SqlExecutor` (`mirror.ts`).
- Produces: `insertException`, `readExceptions`, `ackExceptionsThrough`, `PendingException` type — consumed by Task 10 (undo), Task 11 (clear/disassemble), Task 12 (sync engine).

- [ ] **Step 1: Write the failing test**

Create `apps/station/test/box-exceptions-mirror.test.ts`, modeling `apps/station/test/outbox.test.ts`'s exact setup (in-memory `node:sqlite`, `STATION_MIGRATIONS` applied):

```typescript
import { describe, expect, it, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { STATION_MIGRATIONS } from "@markiro/db";
import {
  insertException,
  readExceptions,
  ackExceptionsThrough,
} from "../src/lib/box-exceptions-mirror.js";
import type { SqlExecutor } from "../src/lib/mirror.js";

function makeExec(db: DatabaseSync): SqlExecutor {
  return {
    async run(sql, params = []) {
      db.prepare(sql).run(...params);
    },
    async all(sql, params = []) {
      return db.prepare(sql).all(...params) as never;
    },
  };
}

describe("box-exceptions-mirror", () => {
  let db: DatabaseSync;
  let exec: SqlExecutor;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    for (const stmt of STATION_MIGRATIONS) {
      try {
        db.exec(stmt);
      } catch {
        // idempotent re-runnable ALTERs, same tolerance mirror.ts's applyMigrations uses
      }
    }
    exec = makeExec(db);
  });

  it("inserts, reads oldest-first, and hard-deletes on ack", async () => {
    await insertException(exec, {
      kind: "undo",
      boxId: "b1",
      codeHash: "hash1",
      shiftId: "s1",
      terminalId: null,
      operatorId: null,
      reason: null,
      at: "2026-07-30T00:00:00.000Z",
    });
    await insertException(exec, {
      kind: "clear",
      boxId: "b1",
      codeHash: null,
      shiftId: "s1",
      terminalId: null,
      operatorId: null,
      reason: "wrong box",
      at: "2026-07-30T00:01:00.000Z",
    });

    const first = await readExceptions(exec, 1);
    expect(first).toHaveLength(1);
    expect(first[0]?.kind).toBe("undo");

    await ackExceptionsThrough(exec, first[0]!.id);
    const remaining = await readExceptions(exec, 10);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.kind).toBe("clear");
  });

  it("readExceptions respects a ceilingId, the same way outbox.readBatch does", async () => {
    await insertException(exec, {
      kind: "undo",
      boxId: "b1",
      codeHash: "h1",
      shiftId: "s1",
      terminalId: null,
      operatorId: null,
      reason: null,
      at: "t1",
    });
    const [firstRow] = await readExceptions(exec, 1);
    await insertException(exec, {
      kind: "undo",
      boxId: "b2",
      codeHash: "h2",
      shiftId: "s1",
      terminalId: null,
      operatorId: null,
      reason: null,
      at: "t2",
    });
    const pinned = await readExceptions(exec, 10, firstRow!.id);
    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.boxId).toBe("b1");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/station exec vitest run box-exceptions-mirror`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `box-exceptions-mirror.ts`**

```typescript
import type { SqlExecutor } from "./mirror.js";

export interface ExceptionInput {
  kind: "undo" | "clear" | "disassemble" | "reprint";
  boxId: string;
  codeHash: string | null;
  shiftId: string;
  terminalId: string | null;
  operatorId: string | null;
  reason: string | null;
  at: string;
}

export interface PendingException extends ExceptionInput {
  id: number;
}

interface ExceptionRow {
  id: number;
  kind: string;
  box_id: string;
  code_hash: string | null;
  shift_id: string;
  terminal_id: string | null;
  operator_id: string | null;
  reason: string | null;
  at: string;
}

export async function insertException(exec: SqlExecutor, e: ExceptionInput): Promise<void> {
  await exec.run(
    `INSERT INTO box_exceptions_mirror (kind, box_id, code_hash, shift_id, terminal_id, operator_id, reason, at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [e.kind, e.boxId, e.codeHash, e.shiftId, e.terminalId, e.operatorId, e.reason, e.at],
  );
}

/**
 * Oldest `limit` queued exceptions first -- the same shape as
 * `outbox.ts`'s `readBatch`. No signature/acked_at flag is needed here the
 * way `boxes_mirror`'s closure channel needs `boxSetSignature` (see
 * sync.ts): an exception row is a pure fact, written once and never
 * updated in place, so a plain monotonic id ceiling is enough to make a
 * retry re-read the exact same set.
 */
export async function readExceptions(
  exec: SqlExecutor,
  limit: number,
  ceilingId?: number | null,
): Promise<PendingException[]> {
  const rows =
    ceilingId != null
      ? await exec.all<ExceptionRow>(
          `SELECT id, kind, box_id, code_hash, shift_id, terminal_id, operator_id, reason, at
             FROM box_exceptions_mirror WHERE id <= ? ORDER BY id LIMIT ?`,
          [ceilingId, limit],
        )
      : await exec.all<ExceptionRow>(
          `SELECT id, kind, box_id, code_hash, shift_id, terminal_id, operator_id, reason, at
             FROM box_exceptions_mirror ORDER BY id LIMIT ?`,
          [limit],
        );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as ExceptionInput["kind"],
    boxId: r.box_id,
    codeHash: r.code_hash,
    shiftId: r.shift_id,
    terminalId: r.terminal_id,
    operatorId: r.operator_id,
    reason: r.reason,
    at: r.at,
  }));
}

/** Drops everything up to and including `id` -- one statement, ackThrough's own pattern. */
export async function ackExceptionsThrough(exec: SqlExecutor, id: number): Promise<void> {
  await exec.run("DELETE FROM box_exceptions_mirror WHERE id <= ?", [id]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @markiro/station exec vitest run box-exceptions-mirror`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/station/src/lib/box-exceptions-mirror.ts apps/station/test/box-exceptions-mirror.test.ts
git commit -m "feat(station): device-local exceptions queue (read/insert/ack)"
```

---

### Task 10: Station lib — undo in `journal.ts`

**Files:**

- Modify: `apps/station/src/lib/journal.ts`
- Test: `apps/station/test/journal.test.ts`

**Interfaces:**

- Consumes: `insertException` (Task 9).
- Produces: `undoLastScan(exec, input): Promise<void>` — consumed by Task 13 (WorkScreen UI).

- [ ] **Step 1: Write the failing test**

In `apps/station/test/journal.test.ts`, find this file's existing setup (reuse its `makeExec`/db fixture) and add:

```typescript
describe("undoLastScan", () => {
  it("deletes the code from codes_mirror, journals it as undone, and queues the exception fact", async () => {
    await recordScan(
      exec,
      {
        shiftId: "s1",
        terminalId: null,
        raw: "raw1",
        verdict: "ok",
        scannedAt: "t1",
        operatorId: null,
      },
      {
        codeHash: "hash1",
        shiftId: "s1",
        gtin14: "04006381333931",
        serial: "1",
        scannedAt: "t1",
        boxId: "b1",
      },
    );

    await undoLastScan(exec, {
      boxId: "b1",
      codeHash: "hash1",
      shiftId: "s1",
      terminalId: null,
      operatorId: null,
      at: "t2",
    });

    const codes = await exec.all("SELECT * FROM codes_mirror WHERE code_hash = ?", ["hash1"]);
    expect(codes).toHaveLength(0);

    const events = await exec.all<{ verdict: string }>(
      "SELECT verdict FROM scan_events_mirror ORDER BY id DESC LIMIT 1",
    );
    expect(events[0]?.verdict).toBe("undone");

    const pending = await exec.all("SELECT * FROM box_exceptions_mirror");
    expect(pending).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/station exec vitest run journal -t "deletes the code from codes_mirror, journals it as undone"`
Expected: FAIL — `undoLastScan` does not exist.

- [ ] **Step 3: Implement `undoLastScan`**

In `apps/station/src/lib/journal.ts`, add the import at the top:

```typescript
import { insertException } from "./box-exceptions-mirror.js";
```

Add the function after `recordScan`:

```typescript
export interface UndoScanInput {
  boxId: string;
  codeHash: string;
  shiftId: string;
  terminalId: string | null;
  operatorId: string | null;
  at: string;
}

/**
 * Undoes the single most recent scan into a still-open box: frees the code
 * hash immediately (so a rescan is never mistaken for a duplicate),
 * journals the correction, and queues the fact for the server to release
 * the same code from `code_registry` (see the design spec's "Releasing a
 * code" section).
 *
 * Three sequential writes, not a transaction (this pool cannot do
 * multi-call transactions -- see recordScan's own doc comment). A failure
 * partway through is a rare, logged edge case, not a silent data loss: the
 * worst case is the codes_mirror row is already gone (harmless -- the
 * operator can simply rescan) with a thinner audit trail for that one
 * event, never a lost or duplicated code.
 */
export async function undoLastScan(exec: SqlExecutor, input: UndoScanInput): Promise<void> {
  await exec.run("DELETE FROM codes_mirror WHERE code_hash = ?", [input.codeHash]);
  await appendScanEvent(exec, {
    shiftId: input.shiftId,
    terminalId: input.terminalId,
    raw: input.codeHash,
    verdict: "undone",
    scannedAt: input.at,
    operatorId: input.operatorId,
  });
  await insertException(exec, {
    kind: "undo",
    boxId: input.boxId,
    codeHash: input.codeHash,
    shiftId: input.shiftId,
    terminalId: input.terminalId,
    operatorId: input.operatorId,
    reason: null,
    at: input.at,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @markiro/station exec vitest run journal -t "deletes the code from codes_mirror, journals it as undone"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/station/src/lib/journal.ts apps/station/test/journal.test.ts
git commit -m "feat(station): undoLastScan releases a code and queues the exception fact"
```

---

### Task 11: Station lib — `clearBox` and `disassembleBox` in `boxes.ts`

**Files:**

- Modify: `apps/station/src/lib/boxes.ts`
- Test: `apps/station/test/boxes.test.ts`

**Interfaces:**

- Consumes: `insertException` (Task 9).
- Produces: `clearBox(exec, input): Promise<void>`, `disassembleBox(exec, input): Promise<void>`, `listClosedBoxes(exec, shiftId, terminalId): Promise<ClosedBoxSummary[]>` — consumed by Task 13-14 (WorkScreen UI, ShiftBoxesPanel).

- [ ] **Step 1: Write the failing tests**

In `apps/station/test/boxes.test.ts`, add:

```typescript
describe("clearBox", () => {
  it("frees every code in the box and leaves it open", async () => {
    await openBox(exec, "s1", "b1", "t0", null);
    await exec.run(
      "INSERT INTO codes_mirror (code_hash, shift_id, gtin14, serial, scanned_at, box_id) VALUES (?,?,?,?,?,?)",
      ["h1", "s1", "04006381333931", "1", "t1", "b1"],
    );
    await clearBox(exec, {
      boxId: "b1",
      shiftId: "s1",
      terminalId: null,
      operatorId: null,
      at: "t2",
    });

    const codes = await exec.all("SELECT * FROM codes_mirror WHERE box_id = ?", ["b1"]);
    expect(codes).toHaveLength(0);
    const box = await currentBox(exec, "s1");
    expect(box?.boxId).toBe("b1");
    expect(box?.itemCount).toBe(0);
    const pending = await exec.all("SELECT * FROM box_exceptions_mirror WHERE kind = 'clear'");
    expect(pending).toHaveLength(1);
  });
});

describe("disassembleBox", () => {
  it("marks a closed box disassembled and drops it from listClosedBoxes", async () => {
    await openBox(exec, "s1", "b1", "t0", null);
    await exec.run(
      "INSERT INTO codes_mirror (code_hash, shift_id, gtin14, serial, scanned_at, box_id) VALUES (?,?,?,?,?,?)",
      ["h1", "s1", "04006381333931", "1", "t1", "b1"],
    );
    await closeBox(exec, "b1", "123456789012345675", "t2", null);

    await disassembleBox(exec, {
      boxId: "b1",
      shiftId: "s1",
      terminalId: null,
      operatorId: null,
      reason: "wrong customer",
      at: "t3",
    });

    const listed = await listClosedBoxes(exec, "s1", null);
    expect(listed).toHaveLength(0);
    const codes = await exec.all("SELECT * FROM codes_mirror WHERE box_id = ?", ["b1"]);
    expect(codes).toHaveLength(0);
  });
});

describe("listClosedBoxes", () => {
  it("lists closed, not-yet-disassembled boxes for this shift and terminal, newest first", async () => {
    await openBox(exec, "s1", "b1", "t0", "term-1");
    await closeBox(exec, "b1", "123456789012345675", "t1", null);
    await openBox(exec, "s1", "b2", "t2", "term-1");
    await closeBox(exec, "b2", "123456789012345682", "t3", null);

    const listed = await listClosedBoxes(exec, "s1", "term-1");
    expect(listed.map((b) => b.boxId)).toEqual(["b2", "b1"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/station exec vitest run boxes -t "clearBox|disassembleBox|listClosedBoxes"`
Expected: FAIL — none of the three functions exist.

- [ ] **Step 3: Implement all three in `boxes.ts`**

Add the import at the top:

```typescript
import { insertException } from "./box-exceptions-mirror.js";
```

Add after `markPrintSkipped`:

```typescript
export interface ClearBoxInput {
  boxId: string;
  shiftId: string;
  terminalId: string | null;
  operatorId: string | null;
  at: string;
}

/**
 * Empties every code from a still-open box and queues the fact -- the
 * "start over without closing" shortcut (design spec's fourth action).
 * Does NOT touch closed_at/sscc/disassembled_at: the box stays open, ready
 * to be filled again. No reason is recorded (see the design spec, scope
 * decision 5) -- nothing has been printed or numbered yet.
 */
export async function clearBox(exec: SqlExecutor, input: ClearBoxInput): Promise<void> {
  await exec.run("DELETE FROM codes_mirror WHERE box_id = ?", [input.boxId]);
  await insertException(exec, {
    kind: "clear",
    boxId: input.boxId,
    codeHash: null,
    shiftId: input.shiftId,
    terminalId: input.terminalId,
    operatorId: input.operatorId,
    reason: null,
    at: input.at,
  });
}

export interface DisassembleBoxInput {
  boxId: string;
  shiftId: string;
  terminalId: string | null;
  operatorId: string | null;
  reason: string;
  at: string;
}

/**
 * Retires a closed box: frees every code it still held and marks the
 * mirror row disassembled, so it drops out of `listClosedBoxes` and can
 * never be reprinted or disassembled again. The server independently
 * voids the box's SSCC forever (see the design spec's scope decision 4) --
 * a re-packed box is a brand-new box row with a brand-new SSCC.
 */
export async function disassembleBox(exec: SqlExecutor, input: DisassembleBoxInput): Promise<void> {
  await exec.run("DELETE FROM codes_mirror WHERE box_id = ?", [input.boxId]);
  await exec.run("UPDATE boxes_mirror SET disassembled_at = ? WHERE box_id = ?", [
    input.at,
    input.boxId,
  ]);
  await insertException(exec, {
    kind: "disassemble",
    boxId: input.boxId,
    codeHash: null,
    shiftId: input.shiftId,
    terminalId: input.terminalId,
    operatorId: input.operatorId,
    reason: input.reason,
    at: input.at,
  });
}

export interface ClosedBoxSummary {
  boxId: string;
  sscc: string;
  itemCount: number;
  closedAt: string;
}

/**
 * Closed, not-yet-disassembled boxes for this shift and terminal, most
 * recently closed first -- the picker for the reprint/disassemble panel
 * (Task 14). Scoped to `terminalId` (Task 11's own scope decision 3): an
 * operator manages what physically closed at their own workstation.
 */
export async function listClosedBoxes(
  exec: SqlExecutor,
  shiftId: string,
  terminalId: string | null,
): Promise<ClosedBoxSummary[]> {
  const terminalClause = terminalId === null ? "terminal_id IS NULL" : "terminal_id = ?";
  const params = terminalId === null ? [shiftId] : [shiftId, terminalId];
  const rows = await exec.all<{
    box_id: string;
    sscc: string;
    closed_at: string;
    item_count: number;
  }>(
    `SELECT b.box_id AS box_id, b.sscc AS sscc, b.closed_at AS closed_at,
            (SELECT COUNT(*) FROM codes_mirror c WHERE c.box_id = b.box_id) AS item_count
       FROM boxes_mirror b
      WHERE b.shift_id = ? AND ${terminalClause}
        AND b.closed_at IS NOT NULL AND b.disassembled_at IS NULL
      ORDER BY b.closed_at DESC`,
    params,
  );
  return rows.map((r) => ({
    boxId: r.box_id,
    sscc: r.sscc,
    itemCount: Number(r.item_count),
    closedAt: r.closed_at,
  }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @markiro/station exec vitest run boxes -t "clearBox|disassembleBox|listClosedBoxes"`
Expected: PASS, all.

- [ ] **Step 5: Commit**

```bash
git add apps/station/src/lib/boxes.ts apps/station/test/boxes.test.ts
git commit -m "feat(station): clearBox, disassembleBox, listClosedBoxes"
```

---

### Task 12: Station — `scan-queue.ts` job support + sync engine wiring

**Files:**

- Modify: `apps/station/src/lib/scan-queue.ts`, `apps/station/src/lib/sync.ts`
- Test: `apps/station/test/scan-queue.test.ts`, `apps/station/test/sync.test.ts`

**Interfaces:**

- Consumes: `readExceptions`, `ackExceptionsThrough` (Task 9).
- Produces: `ScanQueue.enqueueJob(job): void` — consumed by Task 13 (Undo/Clear buttons must run through the same serial queue as scans, never interleaved).

- [ ] **Step 1: Write the failing test for `enqueueJob`**

In `apps/station/test/scan-queue.test.ts`, add:

```typescript
it("enqueueJob runs a side-channel job in strict order with buffered scans, never concurrently", async () => {
  const order: string[] = [];
  const queue = createScanQueue({
    async process(raw) {
      order.push(`scan:${raw}`);
      return { raw, verdict: { status: "ok" }, firstSeen: null };
    },
    onOutcome() {},
  });
  queue.enqueue("a");
  queue.enqueueJob(async () => {
    order.push("job");
  });
  queue.enqueue("b");
  await queue.idle();
  expect(order).toEqual(["scan:a", "job", "scan:b"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @markiro/station exec vitest run scan-queue -t "enqueueJob runs a side-channel job"`
Expected: FAIL — `enqueueJob` does not exist.

- [ ] **Step 3: Implement `enqueueJob` in `scan-queue.ts`**

Change the internal buffer to a tagged union and add the new method. In `apps/station/src/lib/scan-queue.ts`:

```typescript
export interface ScanQueue {
  enqueue(raw: string): void;
  /**
   * Runs an arbitrary async job strictly in order with buffered scans --
   * never concurrently with `process()`. This is what lets undo/clear
   * (Task 13) act without racing the very next scan's write, without a
   * second, parallel synchronization primitive.
   */
  enqueueJob(job: () => Promise<void>): void;
  idle(): Promise<void>;
  pending(): number;
}

type QueueEntry = { type: "scan"; raw: string } | { type: "job"; run: () => Promise<void> };

export function createScanQueue(deps: ScanQueueDeps): ScanQueue {
  const buffer: QueueEntry[] = [];
  let draining = false;
  let idleResolvers: (() => void)[] = [];

  function settleIdle() {
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (buffer.length > 0) {
        const entry = buffer.shift()!;
        if (entry.type === "job") {
          try {
            await entry.run();
          } catch (err) {
            console.error("station: scan-queue job failed", err);
          }
          continue;
        }
        // ... existing scan-processing body, unchanged, reading entry.raw
        // instead of a bare `raw` -- copy it exactly from the current file.
      }
    } finally {
      draining = false;
      settleIdle();
    }
  }

  return {
    enqueue(raw: string) {
      buffer.push({ type: "scan", raw });
      void drain();
    },
    enqueueJob(job: () => Promise<void>) {
      buffer.push({ type: "job", run: job });
      void drain();
    },
    idle(): Promise<void> {
      if (!draining && buffer.length === 0) return Promise.resolve();
      return new Promise((resolve) => idleResolvers.push(resolve));
    },
    pending(): number {
      return buffer.length;
    },
  };
}
```

(This changes `drain`'s internals — read the CURRENT full body of `drain` in `apps/station/src/lib/scan-queue.ts` first and preserve every existing line of the scan-processing branch unchanged, just gated under `entry.type === "scan"` and reading `entry.raw`.)

- [ ] **Step 4: Run the test to verify it passes, and the existing scan-queue suite still passes**

Run: `pnpm --filter @markiro/station exec vitest run scan-queue`
Expected: PASS, all (existing tests plus the new one).

- [ ] **Step 5: Write the failing sync engine test for exceptions**

In `apps/station/test/sync.test.ts`, find the existing box-closure drain test (search for `readClosedUnackedBoxes` or a test named around "closes and acks a box") and add a parallel test:

```typescript
it("drains queued exceptions alongside items and boxes, and acks them by deleting", async () => {
  await insertException(exec, {
    kind: "undo",
    boxId: "b1",
    codeHash: "h1",
    shiftId: "s1",
    terminalId: null,
    operatorId: null,
    reason: null,
    at: "t1",
  });
  const client = {
    post: vi.fn().mockResolvedValue({ applied: 0, alreadyApplied: false, conflicts: [] }),
  };
  const engine = createSyncEngine({
    exec,
    client,
    machineId: "m1" /* ...this file's other required deps */,
  });
  await engine.drainOnce(); // or however this file's existing tests drive one drain pass
  expect(client.post).toHaveBeenCalledWith(
    "/station/scans",
    expect.objectContaining({
      exceptions: [expect.objectContaining({ kind: "undo", boxId: "b1", codeHash: "h1" })],
    }),
  );
  const remaining = await readExceptions(exec, 10);
  expect(remaining).toHaveLength(0);
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm --filter @markiro/station exec vitest run sync -t "drains queued exceptions"`
Expected: FAIL — the drain loop never reads `box_exceptions_mirror`.

- [ ] **Step 7: Wire exceptions into the drain loop**

In `apps/station/src/lib/sync.ts`:

Add imports:

```typescript
import {
  readExceptions,
  ackExceptionsThrough,
  type PendingException,
} from "./box-exceptions-mirror.js";
```

Add a ceiling variable alongside `pendingCeiling`/`pendingBoxCeiling` (near their declarations in `createSyncEngine`):

```typescript
let pendingExceptionCeiling: number | null = null;
```

In `drain()`, alongside the existing `batch`/`boxes` reads:

```typescript
const exceptionCeiling = pendingExceptionCeiling;
const exceptions = await readExceptions(deps.exec, 200, exceptionCeiling);
```

Update the empty-check (`if (batch.length === 0 && boxes.length === 0)`) to also check `exceptions.length === 0`, and the ceiling-clearing branch inside it to also clear `pendingExceptionCeiling`.

Pin the new ceiling the same way `pendingBoxCeiling` is pinned (no `station_meta` persistence needed here -- unlike the outbox and box-closure ceilings, losing this ceiling on a crash mid-retry only risks resending a FEW already-synced exception rows, which the server's box-exceptions handling already treats as a safe no-op via its guard conditions; the outbox/box ceilings persist because losing THEM risks resending thousands of items, not a handful of rare operator corrections):

```typescript
const newExceptionCeiling = exceptions.length > 0 ? exceptions[exceptions.length - 1]!.id : null;
if (newExceptionCeiling !== null) {
  pendingExceptionCeiling = newExceptionCeiling;
}
```

Include `exceptions` in the POST body (find the `deps.client.post<BatchResponse>("/station/scans", { batchId, items: ..., boxes: ..., serialsLeft })` call):

```typescript
const res = await deps.client.post<BatchResponse>("/station/scans", {
  batchId,
  items: toPayload(batch),
  boxes: toBoxPayload(boxes),
  exceptions: toExceptionPayload(exceptions),
  serialsLeft,
});
```

Add the payload mapper near `toBoxPayload`:

```typescript
function toExceptionPayload(exceptions: PendingException[]) {
  return exceptions.map((e) => ({
    kind: e.kind,
    boxId: e.boxId,
    codeHash: e.codeHash,
    shiftId: e.shiftId,
    terminalId: e.terminalId,
    operatorId: e.operatorId,
    reason: e.reason,
    occurredAt: e.at,
  }));
}
```

After a successful send, alongside the existing `ackBoxes`/`ackThrough` calls:

```typescript
if (exceptions.length > 0) {
  await ackExceptionsThrough(deps.exec, newExceptionCeiling!);
  pendingExceptionCeiling = null;
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm --filter @markiro/station exec vitest run sync -t "drains queued exceptions"`
Expected: PASS.

- [ ] **Step 9: Run the full station-side test suite to catch any regression**

Run: `pnpm --filter @markiro/station exec vitest run`
Expected: PASS, all files.

- [ ] **Step 10: Commit**

```bash
git add apps/station/src/lib/scan-queue.ts apps/station/src/lib/sync.ts apps/station/test/scan-queue.test.ts apps/station/test/sync.test.ts
git commit -m "feat(station): drain exceptions alongside items/boxes; enqueueJob for serialized side-channel actions"
```

---

### Task 13: Station UI — Undo and Clear box on `WorkScreen`

**Files:**

- Modify: `apps/station/src/pages/WorkScreen.tsx`
- Test: `apps/station/test/work-screen.test.tsx` (or the existing WorkScreen test file — check the exact name under `apps/station/test/`)

**Interfaces:**

- Consumes: `undoLastScan` (Task 10), `clearBox` (Task 11), `ScanQueue.enqueueJob` (Task 12).
- Produces: two new buttons on the running work screen, gated on state this task introduces.

- [ ] **Step 1: Write the failing test for Undo**

Find this project's existing WorkScreen test file (search `apps/station/test/` for one rendering `WorkScreen` and simulating a scan) and add:

```typescript
it("shows an Undo action for the last scan into the open box, and removes it on click", async () => {
  // Render WorkScreen with a real in-memory exec (this file's existing
  // fixture), simulate one accepted scan into the current box via the
  // ScanSource test double this file already uses, then:
  const undoButton = await screen.findByRole("button", { name: /undo|отменить/i });
  await userEvent.click(undoButton);
  await waitFor(async () => {
    const codes = await exec.all("SELECT * FROM codes_mirror");
    expect(codes).toHaveLength(0);
  });
  expect(screen.queryByRole("button", { name: /undo|отменить/i })).not.toBeInTheDocument();
});

it("Clear box empties the current box after confirmation", async () => {
  // Simulate two accepted scans into the box, click "Очистить короб", confirm the dialog.
  const clearButton = await screen.findByRole("button", { name: /clear|очистить/i });
  await userEvent.click(clearButton);
  const confirmButton = await screen.findByRole("button", { name: /confirm|подтвердить/i });
  await userEvent.click(confirmButton);
  await waitFor(async () => {
    const codes = await exec.all("SELECT * FROM codes_mirror");
    expect(codes).toHaveLength(0);
  });
});
```

(Match this file's existing scan-simulation helper and translation-key lookup convention exactly — read the file first.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/station exec vitest run work-screen -t "Undo|Clear box"`
Expected: FAIL — neither button exists yet.

- [ ] **Step 3: Add state and handlers to `WorkScreen.tsx`**

Add imports:

```typescript
import { undoLastScan } from "../lib/journal.js";
import { clearBox } from "../lib/boxes.js";
```

Add state near `boxRef`'s declaration (after the `boxReady` ref, ~line 130):

```typescript
// The single most recent scan accepted into the currently open box, or
// null. Cleared the instant a new scan lands or the box changes/closes --
// strictly one level of undo, never a history stack (design spec's scope
// decision).
const [lastScanned, setLastScanned] = useState<{ boxId: string; codeHash: string } | null>(null);
const [confirmClear, setConfirmClear] = useState(false);
```

In the scan-processing `process()` function, right after the existing `if (codeHash) keys.current.add(codeHash);` line and before `if (codeHash && boxId !== null) { await live.current.refreshBox(boxId); }`, add:

```typescript
if (codeHash && boxId !== null) {
  setLastScanned({ boxId, codeHash });
}
```

Add handlers near `requestExit`:

```typescript
function handleUndo(): void {
  const target = lastScanned;
  if (!target) return;
  setLastScanned(null);
  queue.enqueueJob(async () => {
    try {
      await undoLastScan(exec, {
        boxId: target.boxId,
        codeHash: target.codeHash,
        shiftId,
        terminalId,
        operatorId: null,
        at: new Date().toISOString(),
      });
      keys.current.delete(target.codeHash);
      await refreshBoxAndMaybeClose(target.boxId);
      onScanRecorded?.();
    } catch (err) {
      console.error("station: undo failed", err);
    }
  });
}

function handleClearBox(): void {
  setConfirmClear(true);
}

function confirmClearBox(): void {
  setConfirmClear(false);
  const boxId = boxRef.current?.boxId;
  if (!boxId) return;
  setLastScanned(null);
  queue.enqueueJob(async () => {
    try {
      await clearBox(exec, {
        boxId,
        shiftId,
        terminalId,
        operatorId: null,
        at: new Date().toISOString(),
      });
      await refreshBoxAndMaybeClose(boxId);
      onScanRecorded?.();
    } catch (err) {
      console.error("station: clear box failed", err);
    }
  });
}
```

(`refreshBoxAndMaybeClose` on a now-empty box must not immediately re-trigger auto-close: check that function's existing `boxCapacity !== null && updated.itemCount >= boxCapacity` guard already handles `itemCount === 0` correctly — it does, since `0 >= boxCapacity` is false for any positive capacity — no change needed there.)

Clear `lastScanned` whenever the box itself changes to a different one or closes — in `refreshBoxAndMaybeClose`, after `updateBox(...)`:

```typescript
updateBox({ boxId: updated.boxId, itemCount: updated.itemCount });
setLastScanned((prev) => (prev && prev.boxId === updated.boxId ? prev : null));
```

- [ ] **Step 4: Render the two buttons and the confirm dialog**

In the JSX where the box's item count is displayed, add (matching this file's existing `Button`/`Alert` usage from `@markiro/ui`):

```tsx
{
  box && lastScanned && lastScanned.boxId === box.boxId && (
    <Button variant="secondary" onClick={handleUndo}>
      {t("work.undoLastScan", "Отменить последний скан")}
    </Button>
  );
}
{
  box && (
    <Button variant="secondary" onClick={handleClearBox}>
      {t("work.clearBox", "Очистить короб")}
    </Button>
  );
}
{
  confirmClear && (
    <Alert
      tone="warning"
      title={t("work.confirmClearTitle", "Очистить короб?")}
      detail={t("work.confirmClearDetail", "Все позиции текущего короба будут удалены.")}
      actions={
        <>
          <Button onClick={confirmClearBox}>{t("common.confirm", "Подтвердить")}</Button>
          <Button variant="secondary" onClick={() => setConfirmClear(false)}>
            {t("common.cancel", "Отмена")}
          </Button>
        </>
      }
    />
  );
}
```

(Match this file's actual `Alert`/`Button` prop shapes exactly — check their real signatures in `packages/ui` before finalizing; the confirm-exit dialog already in this file (`confirmExit` state) is the closest existing pattern to copy.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @markiro/station exec vitest run work-screen -t "Undo|Clear box"`
Expected: PASS.

- [ ] **Step 6: Run the full WorkScreen test file to catch regressions**

Run: `pnpm --filter @markiro/station exec vitest run work-screen`
Expected: PASS, all.

- [ ] **Step 7: Commit**

```bash
git add apps/station/src/pages/WorkScreen.tsx apps/station/test/work-screen.test.tsx
git commit -m "feat(station): Undo last scan and Clear box actions on WorkScreen"
```

---

### Task 14: Station UI — `ShiftBoxesPanel` (reprint / disassemble)

**Files:**

- Create: `apps/station/src/ui/ShiftBoxesPanel.tsx`
- Modify: `apps/station/src/pages/WorkScreen.tsx` (mount the panel, wire the reprint action)
- Test: `apps/station/test/shift-boxes-panel.test.tsx`

**Interfaces:**

- Consumes: `listClosedBoxes`, `disassembleBox` (Task 11), `printAndMaybeVerify` (existing, reused unchanged for reprint).
- Produces: a reachable panel listing this terminal's closed boxes with Reprint/Disassemble actions.

- [ ] **Step 1: Write the failing component test**

Create `apps/station/test/shift-boxes-panel.test.tsx`, following this project's existing component-test conventions (check `apps/station/test/` for an existing small-component test, e.g. covering `PrintVerification.tsx`, for the render/harness pattern):

```typescript
it("lists closed boxes and requires a reason before disassembling", async () => {
  const boxes = [{ boxId: "b1", sscc: "123456789012345675", itemCount: 3, closedAt: "2026-07-30T00:00:00.000Z" }];
  const onReprint = vi.fn();
  const onDisassemble = vi.fn();
  render(<ShiftBoxesPanel boxes={boxes} onReprint={onReprint} onDisassemble={onDisassemble} />);

  await userEvent.click(screen.getByRole("button", { name: /расформировать/i }));
  // Confirm button should be disabled until a reason is typed.
  const confirmButton = screen.getByRole("button", { name: /подтвердить/i });
  expect(confirmButton).toBeDisabled();
  await userEvent.type(screen.getByRole("textbox"), "wrong customer");
  expect(confirmButton).toBeEnabled();
  await userEvent.click(confirmButton);
  expect(onDisassemble).toHaveBeenCalledWith("b1", "wrong customer");
});

it("reprint requires a reason too", async () => {
  const boxes = [{ boxId: "b1", sscc: "123456789012345675", itemCount: 3, closedAt: "2026-07-30T00:00:00.000Z" }];
  const onReprint = vi.fn();
  render(<ShiftBoxesPanel boxes={boxes} onReprint={onReprint} onDisassemble={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: /перепечатать/i }));
  await userEvent.type(screen.getByRole("textbox"), "label jammed");
  await userEvent.click(screen.getByRole("button", { name: /подтвердить/i }));
  expect(onReprint).toHaveBeenCalledWith("b1", "label jammed");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @markiro/station exec vitest run shift-boxes-panel`
Expected: FAIL — the component does not exist.

- [ ] **Step 3: Implement `ShiftBoxesPanel.tsx`**

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Alert } from "@markiro/ui";
import type { ClosedBoxSummary } from "../lib/boxes.js";

export interface ShiftBoxesPanelProps {
  boxes: ClosedBoxSummary[];
  onReprint: (boxId: string, reason: string) => void;
  onDisassemble: (boxId: string, reason: string) => void;
}

/**
 * Lists this terminal's closed, not-yet-disassembled boxes for the current
 * shift, most recent first (see `listClosedBoxes`'s own doc comment for
 * why the scope stops at "this terminal"). Both actions require a
 * non-empty reason before their confirm button enables -- disassemble
 * additionally warns it is irreversible, matching the design spec.
 */
export function ShiftBoxesPanel({ boxes, onReprint, onDisassemble }: ShiftBoxesPanelProps) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<{ boxId: string; kind: "reprint" | "disassemble" } | null>(
    null,
  );
  const [reason, setReason] = useState("");

  function startAction(boxId: string, kind: "reprint" | "disassemble") {
    setPending({ boxId, kind });
    setReason("");
  }

  function confirm() {
    if (!pending || reason.trim().length === 0) return;
    if (pending.kind === "reprint") onReprint(pending.boxId, reason.trim());
    else onDisassemble(pending.boxId, reason.trim());
    setPending(null);
  }

  return (
    <div>
      <ul>
        {boxes.map((box) => (
          <li key={box.boxId}>
            <span>{box.sscc}</span>
            <span>{box.itemCount}</span>
            <span>{box.closedAt}</span>
            <Button variant="secondary" onClick={() => startAction(box.boxId, "reprint")}>
              {t("work.reprint", "Перепечатать")}
            </Button>
            <Button variant="secondary" onClick={() => startAction(box.boxId, "disassemble")}>
              {t("work.disassemble", "Расформировать")}
            </Button>
          </li>
        ))}
      </ul>
      {pending && (
        <Alert
          tone={pending.kind === "disassemble" ? "warning" : "info"}
          title={
            pending.kind === "disassemble"
              ? t("work.disassembleConfirmTitle", "Это необратимо")
              : t("work.reprintConfirmTitle", "Перепечатать этикетку")
          }
          detail={
            pending.kind === "disassemble"
              ? t("work.disassembleConfirmDetail", "Номер короба будет аннулирован навсегда.")
              : undefined
          }
          actions={
            <>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t("work.reasonPlaceholder", "Причина") ?? undefined}
              />
              <Button onClick={confirm} disabled={reason.trim().length === 0}>
                {t("common.confirm", "Подтвердить")}
              </Button>
              <Button variant="secondary" onClick={() => setPending(null)}>
                {t("common.cancel", "Отмена")}
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}
```

(Verify `Alert`'s and `Button`'s actual prop names in `packages/ui` before finalizing — copy the exact shape `PrintVerification.tsx` already uses for its own confirm-style prompt, since it is the closest existing precedent in this codebase.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @markiro/station exec vitest run shift-boxes-panel`
Expected: PASS.

- [ ] **Step 5: Mount the panel in `WorkScreen.tsx` and wire its two callbacks**

Add state and a loader near the other box-related state:

```typescript
const [closedBoxes, setClosedBoxes] = useState<ClosedBoxSummary[]>([]);
async function reloadClosedBoxes(): Promise<void> {
  try {
    setClosedBoxes(await listClosedBoxes(exec, shiftId, terminalId));
  } catch (err) {
    console.error("station: failed to list closed boxes", err);
  }
}
```

Call `reloadClosedBoxes()` once on mount (a small `useEffect([exec, shiftId, terminalId])`) and again after every successful close/disassemble/reprint (append the call to the end of `closeTheBox`'s success path, and to the two new handlers below).

Add the two handlers:

```typescript
function handleReprint(boxId: string, reason: string): void {
  queue.enqueueJob(async () => {
    const target = closedBoxes.find((b) => b.boxId === boxId);
    if (!target) return;
    await printAndMaybeVerify({ sscc: target.sscc, itemCount: target.itemCount }, boxId);
    await insertException(exec, {
      kind: "reprint",
      boxId,
      codeHash: null,
      shiftId,
      terminalId,
      operatorId: null,
      reason,
      at: new Date().toISOString(),
    });
  });
}

function handleDisassemble(boxId: string, reason: string): void {
  queue.enqueueJob(async () => {
    try {
      await disassembleBox(exec, {
        boxId,
        shiftId,
        terminalId,
        operatorId: null,
        reason,
        at: new Date().toISOString(),
      });
      await reloadClosedBoxes();
      onScanRecorded?.();
    } catch (err) {
      console.error("station: disassemble failed", err);
    }
  });
}
```

Add the import and mount the panel in the JSX, near the box display:

```typescript
import { ShiftBoxesPanel } from "../ui/ShiftBoxesPanel.js";
import { listClosedBoxes, disassembleBox, type ClosedBoxSummary } from "../lib/boxes.js";
import { insertException } from "../lib/box-exceptions-mirror.js";
```

```tsx
<ShiftBoxesPanel boxes={closedBoxes} onReprint={handleReprint} onDisassemble={handleDisassemble} />
```

- [ ] **Step 6: Run the full station test suite**

Run: `pnpm --filter @markiro/station exec vitest run`
Expected: PASS, all files.

- [ ] **Step 7: Commit**

```bash
git add apps/station/src/ui/ShiftBoxesPanel.tsx apps/station/src/pages/WorkScreen.tsx apps/station/test/shift-boxes-panel.test.tsx
git commit -m "feat(station): ShiftBoxesPanel for reprint and disassemble"
```

---

### Task 15: Docs and full verification

**Files:**

- Modify: `docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md` (mark this slice done once merged — leave as a note for the finishing step, not this task, since delivery date isn't known yet at planning time)
- Modify: `.superpowers/sdd/progress.md` ledger (gitignored, maintained automatically by subagent-driven-development)

- [ ] **Step 1: Run the full monorepo gate with a real environment**

```bash
set -a && source .env && set +a
pnpm turbo lint typecheck test build --concurrency=1
```

Expected: all packages green. Confirm the count of API e2e test files/tests actually run (not silently skipped for missing env — see the project's own recorded gotcha about this).

- [ ] **Step 2: Apply the new migration(s) to a scratch database from an empty schema, then to the shared dev database**

```bash
docker exec q-postgres-1 psql -U markiro -d markiro -c "CREATE DATABASE scratch_final;"
DATABASE_URL="postgres://markiro:markiro@localhost:5432/scratch_final" pnpm --filter @markiro/db exec drizzle-kit migrate
docker exec q-postgres-1 psql -U markiro -d postgres -c "DROP DATABASE scratch_final;"
DATABASE_URL="postgres://markiro:markiro@localhost:5432/markiro" pnpm --filter @markiro/db exec drizzle-kit migrate
```

Expected: clean apply both times.

- [ ] **Step 3: `pnpm format:check`**

Run: `pnpm format:check`
Expected: clean (format only the files this plan actually touched if it is not).

- [ ] **Step 4: Final whole-branch review**

Dispatch the final code-reviewer (per `superpowers:subagent-driven-development`) on the most capable available model — this slice again touches `code_registry` (06b) and the box/SSCC model (06c), the same two areas that needed a second, adversarial pass on both of those prior slices.

- [ ] **Step 5: Commit any final fixes and hand off**

```bash
git add -A
git commit -m "docs: final verification for station exceptions"
```

Then invoke `superpowers:finishing-a-development-branch`.

## Self-Review Notes

- **Spec coverage:** all four actions (undo, clear, reprint, disassemble) have a server task (4-7), a station-lib task (9-11), and a UI task (13-14); the audit table has both a write path (4-7) and a read path (8); the "SSCC never reused" guarantee has its own locked-down test (6); the device-key-surface doc is updated (8); the sync protocol's ordering guarantee (item before its own exception) is asserted in Task 4's implementation comment, not just the spec.
- **Known follow-up, not a gap:** Task 5's Step 3 explicitly calls out that `ex.boxId` (device-local id) must resolve to `boxes.id` (server UUID) via the same four-column match the existing closures loop uses — flagged inline rather than silently gotten wrong, since it is exactly the kind of mistake 06c's own review caught once already (Finding 3, box identity).
- **Type consistency check:** `ExceptionDto`/`PendingException`/the station's `ExceptionInput` all carry the same field set (`kind`, `boxId`, `codeHash`, `shiftId`, `terminalId`, `operatorId`, `reason`, `occurredAt`/`at`) end to end from Task 3 through Task 12 — verified by re-reading each task's produced/consumed interface list above.
