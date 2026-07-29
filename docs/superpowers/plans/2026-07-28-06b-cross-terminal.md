# Cross-Terminal Duplicates & Conflict Screen (06b) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every scanned code exactly one owner across all terminals, record every collision, tell an online station within seconds, and give the manager a screen to review before reporting a shift.

**Architecture:** A new unpartitioned `code_registry` keyed `(tenant_id, code_hash)` holds the scan that owns each code; the ingest reads the current owners, claims through a bulk upsert whose `WHERE` fires only for a strictly earlier `scanned_at`, and derives conflicts by comparing before and after. Losing scans in the batch come back in the sync response; every conflict lands in `code_conflicts` for the cabinet.

**Tech Stack:** NestJS 11 + Drizzle + Postgres (API), TypeScript/React 19 (station and admin), `tauri-plugin-sql` (device SQLite), vitest + supertest e2e against a real Postgres.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-28-cross-terminal-duplicates-design.md`. Every task's requirements implicitly include this section.
- **The earlier scan wins, by `scanned_at`** — the physical moment, never arrival order. Replaying the same data must produce the same owner.
- **The claim must not put a per-code query on the partitioned tables.** `codes`/`scan_events` are partitioned monthly; the registry exists precisely so the hot path is a primary-key probe.
- **The ingest transaction stays all-or-nothing**, guarded by `sync_batches`, so a retried batch is a no-op in its entirety and cannot duplicate conflict rows. The claim insert into `sync_batches` stays FIRST inside the transaction.
- **Multi-tenancy: every query is tenant-scoped in the SQL statement itself, mutations included.**
- **`POST /station/scans` stays reachable by a station api-key** — `TenantGuard` only, never `SessionOnlyGuard`.
- **On the station a conflict is never an alarm.** Design brief 04's floor rule: nothing competes with a scan verdict. No modal, no full-screen flash, no blocking.
- **Never introduce a device-side transaction** — `tauri-plugin-sql` pools connections, so a multi-call `BEGIN`/`COMMIT` is not a transaction; one statement is the only atomic unit.
- **Migrations are GENERATED, never hand-written.** Define the tables in `packages/db/src/schema/`, then run `db:generate`. drizzle snapshots are cumulative and drizzle decides what is applied by the journal's `when` versus the latest recorded `created_at` — a hand-written file drifts from the snapshot and a colliding timestamp is silently skipped rather than reported. Latest on this branch **at plan-writing time** was index 15 (`0015_wooden_terror`, when 1785242187683); this slice's own migration landed as index 16 in that plan's steps below, but by delivery `origin/main` had independently reached `0016_good_maverick`, so the collision was resolved by regenerating this slice's tables as `0017` (see the review notes and `code_registry_tenant_shift_fk`/`code_conflicts_tenant_*_shift_fk` added in review). The step numbers and the `0016_*` filename below are historical instructions, not what shipped — read them for intent, not for the exact index.
- **i18n RU + EN in lockstep** for both apps — each throws on a missing key in test mode and has a parity test.
- No new npm dependencies. Do NOT edit `.npmrc` (adding `minimumReleaseAgeExclude` is task failure).
- Conventional commits, English, no co-author lines.
- API e2e need Postgres on localhost:5432 and `DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173 PAIRING_CODE_PEPPER=insecure-dummy-ci-pepper-not-a-secret` — without them the suites silently skip, so confirm they ran.
- Run `lint` and `typecheck` for every package you touch, and `pnpm exec prettier --check` on every file, before committing.

## File Structure

| File                                                                   | Responsibility                                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/db/src/schema/platform.ts` (modify)                          | `codeRegistry`, `codeConflicts`                                            |
| `packages/db/migrations/0016_*` (generated)                            | Their DDL                                                                  |
| `apps/api/src/modules/station-scans/conflict-resolution.ts` (new)      | Pure: given the batch and the current owners, decide winners and conflicts |
| `apps/api/src/modules/station-scans/station-scans.service.ts` (modify) | Read owners, claim, persist conflicts, return the batch's losses           |
| `apps/api/src/modules/station-scans/dto.ts` (modify)                   | `conflicts` on the response                                                |
| `apps/api/src/modules/conflicts/` (new)                                | Cabinet-facing list and review endpoints                                   |
| `packages/db/src/sqlite/{schema,migrations}.ts` (modify)               | `conflicts_mirror` on the device                                           |
| `apps/station/src/lib/conflicts.ts` (new)                              | Record and read device-side conflicts                                      |
| `apps/station/src/lib/sync.ts` (modify)                                | Persist returned conflicts, surface the count                              |
| `apps/station/src/pages/ConflictList.tsx` (new)                        | The operator's reachable list                                              |
| `apps/admin/src/pages/conflicts/` (new)                                | The manager's per-shift view                                               |

---

### Task 1: Registry and conflict tables

**Files:**

- Modify: `packages/db/src/schema/platform.ts`
- Generate: `packages/db/migrations/0016_*.sql` + `meta/0016_snapshot.json` + the journal entry
- Test: `packages/db/test/sqlite-schema.test.ts` is unaffected; verification is the migration applying to a scratch database

**Interfaces:**

- Produces:
  - `codeRegistry` — `(tenantId, codeHash)` primary key, plus `shiftId`, `terminalId`, `scannedAt`, `updatedAt`.
  - `codeConflicts` — `id`, `tenantId`, `codeHash`, losing `shiftId`/`terminalId`/`scannedAt`, winning `shiftId`/`terminalId`/`scannedAt`, `detectedAt`, `reviewedAt`.

- [ ] **Step 1: Define both tables in the Drizzle schema**

In `packages/db/src/schema/platform.ts`, after `syncBatches`. Use the file's shared `tenantId()` helper — every other table does, and it carries the FK to `organization`:

```ts
/**
 * The scan that currently OWNS each code, across every terminal. Deliberately
 * unpartitioned and keyed by the code alone: `codes` cannot enforce one row
 * per code, because a unique index on a partitioned table must include the
 * partition key and `scanned_at` is it. This table is the authority, probed
 * by primary key so the ingest hot path never scans a partitioned table.
 *
 * Tenant-wide rather than shift-scoped, matching the device mirror: a KM
 * identifies one physical item, so the same code in two shifts is also an
 * error worth catching.
 */
export const codeRegistry = pgTable(
  "code_registry",
  {
    tenantId: tenantId(),
    codeHash: char("code_hash", { length: 64 }).notNull(),
    shiftId: uuid("shift_id").notNull(),
    terminalId: text("terminal_id"),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.codeHash] })],
);

/** One row per losing scan, in both directions — see conflict-resolution.ts. */
export const codeConflicts = pgTable(
  "code_conflicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    codeHash: char("code_hash", { length: 64 }).notNull(),
    losingShiftId: uuid("losing_shift_id").notNull(),
    losingTerminalId: text("losing_terminal_id"),
    losingScannedAt: timestamp("losing_scanned_at", { withTimezone: true }).notNull(),
    winningShiftId: uuid("winning_shift_id").notNull(),
    winningTerminalId: text("winning_terminal_id"),
    winningScannedAt: timestamp("winning_scanned_at", { withTimezone: true }).notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (t) => [index("code_conflicts_shift_idx").on(t.tenantId, t.losingShiftId)],
);
```

Add `char` and `index` to the `drizzle-orm/pg-core` import if they are not already there (`primaryKey`, `text`, `timestamp` and `uuid` are).

- [ ] **Step 2: Generate the migration**

```bash
DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro pnpm --filter @markiro/db db:generate
```

Expected: a new `0016_*.sql`, its snapshot, and a journal entry at index 16. Read the generated SQL and confirm it creates exactly these two tables and changes nothing else. If it proposes anything more, STOP and report it.

- [ ] **Step 3: Apply to a scratch database and inspect**

```bash
psql postgres://markiro:markiro@localhost:5432 -c "DROP DATABASE IF EXISTS markiro_06b" -c "CREATE DATABASE markiro_06b"
DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro_06b pnpm --filter @markiro/db db:migrate
psql postgres://markiro:markiro@localhost:5432/markiro_06b -c '\d code_registry' -c '\d code_conflicts'
```

Expected: the whole chain applies from empty; `code_registry` has the composite primary key and the FK to `organization`; `code_conflicts` has its index. Drop the scratch database afterwards.

- [ ] **Step 4: Apply to the dev database**

```bash
DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro pnpm --filter @markiro/db db:migrate
```

Expected: applies. Then `pnpm --filter @markiro/db test` passes.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/platform.ts packages/db/migrations
git commit -m "feat(db): code ownership registry and conflict records"
```

---

### Task 2: The resolution rule, as a pure function

**Files:**

- Create: `apps/api/src/modules/station-scans/conflict-resolution.ts`
- Test: `apps/api/test/conflict-resolution.test.ts`

**Interfaces:**

- Produces:
  - `interface OwnerRow { codeHash: string; shiftId: string; terminalId: string | null; scannedAt: Date }`
  - `interface ClaimItem { codeHash: string; shiftId: string; terminalId: string | null; scannedAt: Date }`
  - `interface ConflictRow { codeHash: string; losing: Omit<ClaimItem, "codeHash">; winning: Omit<ClaimItem, "codeHash"> }`
  - `interface Resolution { claims: ClaimItem[]; conflicts: ConflictRow[]; lostByThisBatch: ConflictRow[] }`
  - `resolveOwnership(items: ClaimItem[], owners: OwnerRow[]): Resolution`

**Why this is a pure function and not inline SQL:** the rule has four cases and two directions, and it is the one place where getting a comparison backwards silently corrupts ownership. Isolated, it is exhaustively testable without a database.

**The four cases:**

| Incumbent        | Incoming                            | Outcome                                                                                                                     |
| ---------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| none             | any                                 | clean claim, no conflict                                                                                                    |
| earlier or equal | later                               | incoming loses; conflict(loser = incoming, winner = incumbent); also reported to the sending station                        |
| later            | earlier                             | incoming wins and displaces; conflict(loser = incumbent, winner = incoming); NOT reported to the sending station, which won |
| —                | two items in the batch share a code | keep the earliest, treat the rest as losing to it                                                                           |

**Equal timestamps go to the incumbent.** The comparison is strictly `<`, so a tie leaves ownership where it is — deterministic, and re-applying the same batch cannot flip it.

**The batch must be collapsed by `codeHash` before any upsert.** Postgres raises "ON CONFLICT DO UPDATE command cannot affect row a second time" if one statement's values contain the same conflict key twice. `resolveOwnership` returns `claims` already collapsed.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  resolveOwnership,
  type ClaimItem,
  type OwnerRow,
} from "../src/modules/station-scans/conflict-resolution";

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);
const at = (iso: string) => new Date(iso);

function item(codeHash: string, terminalId: string, iso: string): ClaimItem {
  return { codeHash, shiftId: "s1", terminalId, scannedAt: at(iso) };
}
function owner(codeHash: string, terminalId: string, iso: string): OwnerRow {
  return { codeHash, shiftId: "s1", terminalId, scannedAt: at(iso) };
}

describe("resolveOwnership", () => {
  it("claims an unowned code with no conflict", () => {
    const r = resolveOwnership([item(HASH, "t1", "2026-07-28T10:00:00.000Z")], []);
    expect(r.claims).toHaveLength(1);
    expect(r.conflicts).toEqual([]);
    expect(r.lostByThisBatch).toEqual([]);
  });

  it("loses to an earlier incumbent and reports it to the sender", () => {
    const r = resolveOwnership(
      [item(HASH, "t2", "2026-07-28T10:00:05.000Z")],
      [owner(HASH, "t1", "2026-07-28T10:00:00.000Z")],
    );
    expect(r.claims).toEqual([]);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]!.losing.terminalId).toBe("t2");
    expect(r.conflicts[0]!.winning.terminalId).toBe("t1");
    expect(r.lostByThisBatch).toEqual(r.conflicts);
  });

  it("displaces a later incumbent and does NOT report that to the sender", () => {
    const r = resolveOwnership(
      [item(HASH, "t2", "2026-07-28T10:00:00.000Z")],
      [owner(HASH, "t1", "2026-07-28T10:00:05.000Z")],
    );
    expect(r.claims).toHaveLength(1);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]!.losing.terminalId).toBe("t1");
    expect(r.conflicts[0]!.winning.terminalId).toBe("t2");
    // The sender won; it must not be told its own scan is in trouble.
    expect(r.lostByThisBatch).toEqual([]);
  });

  it("leaves ownership with the incumbent on an exact tie", () => {
    const r = resolveOwnership(
      [item(HASH, "t2", "2026-07-28T10:00:00.000Z")],
      [owner(HASH, "t1", "2026-07-28T10:00:00.000Z")],
    );
    expect(r.claims).toEqual([]);
    expect(r.conflicts[0]!.winning.terminalId).toBe("t1");
  });

  it("collapses a code appearing twice in one batch, keeping the earliest", () => {
    const r = resolveOwnership(
      [item(HASH, "t1", "2026-07-28T10:00:05.000Z"), item(HASH, "t1", "2026-07-28T10:00:00.000Z")],
      [],
    );
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]!.scannedAt.toISOString()).toBe("2026-07-28T10:00:00.000Z");
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]!.losing.scannedAt.toISOString()).toBe("2026-07-28T10:00:05.000Z");
  });

  it("handles several codes independently", () => {
    const r = resolveOwnership(
      [item(HASH, "t2", "2026-07-28T10:00:05.000Z"), item(OTHER, "t2", "2026-07-28T10:00:06.000Z")],
      [owner(HASH, "t1", "2026-07-28T10:00:00.000Z")],
    );
    expect(r.claims.map((c) => c.codeHash)).toEqual([OTHER]);
    expect(r.conflicts.map((c) => c.codeHash)).toEqual([HASH]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @markiro/api exec vitest run conflict-resolution`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

```ts
/** A scan currently owning a code, as held by `code_registry`. */
export interface OwnerRow {
  codeHash: string;
  shiftId: string;
  terminalId: string | null;
  scannedAt: Date;
}

/** An accepted code from an incoming batch, competing for ownership. */
export interface ClaimItem {
  codeHash: string;
  shiftId: string;
  terminalId: string | null;
  scannedAt: Date;
}

export interface ConflictRow {
  codeHash: string;
  losing: Omit<ClaimItem, "codeHash">;
  winning: Omit<ClaimItem, "codeHash">;
}

export interface Resolution {
  /** Rows to upsert, already collapsed so one code appears at most once. */
  claims: ClaimItem[];
  /** Every losing scan, in both directions. */
  conflicts: ConflictRow[];
  /** The subset the SENDING station should be told about: its own losses. */
  lostByThisBatch: ConflictRow[];
}

function sideOf(x: ClaimItem | OwnerRow): Omit<ClaimItem, "codeHash"> {
  return { shiftId: x.shiftId, terminalId: x.terminalId, scannedAt: x.scannedAt };
}

/**
 * Decides who owns each code in a batch, and records every scan that lost.
 *
 * The rule is "the earlier scan wins", by `scannedAt` — the physical moment,
 * never arrival order — so a station that was offline does not lose an item
 * merely because its neighbour had a better link, and replaying a batch
 * cannot change the answer. A tie leaves ownership with the incumbent, since
 * the comparison is strict.
 *
 * Losing happens in two directions and they are told apart deliberately:
 * an incoming scan that loses to the incumbent is the sender's own problem
 * and comes back in the sync response; an incoming scan that DISPLACES the
 * incumbent makes some other terminal's earlier-acknowledged scan the loser,
 * and that station cannot be told through this response — the cabinet is the
 * backstop. `lostByThisBatch` is that distinction.
 */
export function resolveOwnership(items: ClaimItem[], owners: OwnerRow[]): Resolution {
  const conflicts: ConflictRow[] = [];
  const lostByThisBatch: ConflictRow[] = [];

  // Postgres refuses an ON CONFLICT DO UPDATE whose values name the same
  // conflict key twice, so the batch is collapsed first. The earliest scan
  // wins here for exactly the same reason it wins against an incumbent.
  const best = new Map<string, ClaimItem>();
  for (const item of items) {
    const held = best.get(item.codeHash);
    if (!held) {
      best.set(item.codeHash, item);
      continue;
    }
    const [winner, loser] = item.scannedAt < held.scannedAt ? [item, held] : [held, item];
    best.set(item.codeHash, winner);
    const row = { codeHash: item.codeHash, losing: sideOf(loser), winning: sideOf(winner) };
    conflicts.push(row);
    lostByThisBatch.push(row);
  }

  const ownerByHash = new Map(owners.map((o) => [o.codeHash, o]));
  const claims: ClaimItem[] = [];

  for (const item of best.values()) {
    const incumbent = ownerByHash.get(item.codeHash);
    if (!incumbent) {
      claims.push(item);
      continue;
    }
    if (item.scannedAt < incumbent.scannedAt) {
      claims.push(item);
      // The displaced scan belongs to a batch acknowledged long ago; its
      // station learns from the cabinet, not from this response.
      conflicts.push({
        codeHash: item.codeHash,
        losing: sideOf(incumbent),
        winning: sideOf(item),
      });
      continue;
    }
    const row = { codeHash: item.codeHash, losing: sideOf(item), winning: sideOf(incumbent) };
    conflicts.push(row);
    lostByThisBatch.push(row);
  }

  return { claims, conflicts, lostByThisBatch };
}
```

- [ ] **Step 4: Run it green**

Run: `pnpm --filter @markiro/api exec vitest run conflict-resolution`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/station-scans/conflict-resolution.ts apps/api/test/conflict-resolution.test.ts
git commit -m "feat(api): cross-terminal code ownership rule"
```

---

### Task 3: Claim ownership during ingest

**Files:**

- Modify: `apps/api/src/modules/station-scans/station-scans.service.ts`, `apps/api/src/modules/station-scans/dto.ts`
- Test: `apps/api/test/station-scans.e2e.test.ts`

**Interfaces:**

- Consumes: `resolveOwnership`, `ClaimItem`, `OwnerRow`, `ConflictRow` (Task 2); `codeRegistry`, `codeConflicts` (Task 1).
- Produces: `SyncBatchResponseDto` gains `conflicts: BatchConflictDto[]`, where `interface BatchConflictDto { codeHash: string; winningTerminalId: string | null; winningScannedAt: string }`.

**Ordering inside the existing transaction**, which must not change shape: the `sync_batches` claim stays first, then shift-ownership validation, then the `codes` and `scan_events` inserts, then — new — read the current owners, resolve, upsert the registry, insert the conflicts. Everything stays inside the one transaction, so a retried batch is a no-op and cannot duplicate conflict rows.

The owner read and the registry upsert are **one statement each per batch**, never per code.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/station-scans.e2e.test.ts`, reusing its existing helpers (`signUpAndActivate`, `deviceKey`, `openShift`, `item`):

```ts
it("gives an unowned code to the batch that sent it, with no conflict", async () => {
  const agent = request.agent(app!.getHttpServer());
  await signUpAndActivate(agent);
  const apiKey = await deviceKey(agent);
  const shiftId = await openShift(agent);

  const res = await request(app!.getHttpServer())
    .post("/station/scans")
    .set("x-api-key", apiKey)
    .send({ batchId: "m1:10", items: [item(shiftId, 1)] })
    .expect(201);

  expect((res.body as { conflicts: unknown[] }).conflicts).toEqual([]);
});

it("reports a later scan of an already-owned code back to the sender", async () => {
  const agent = request.agent(app!.getHttpServer());
  await signUpAndActivate(agent);
  const apiKey = await deviceKey(agent);
  const shiftId = await openShift(agent);

  const first = item(shiftId, 1);
  await request(app!.getHttpServer())
    .post("/station/scans")
    .set("x-api-key", apiKey)
    .send({ batchId: "m1:20", items: [{ ...first, terminalId: "t1" }] })
    .expect(201);

  const later = {
    ...first,
    terminalId: "t2",
    scannedAt: new Date(Date.parse(first.scannedAt) + 5000).toISOString(),
  };
  const res = await request(app!.getHttpServer())
    .post("/station/scans")
    .set("x-api-key", apiKey)
    .send({ batchId: "m1:21", items: [later] })
    .expect(201);

  const conflicts = (res.body as { conflicts: { codeHash: string; winningTerminalId: string }[] })
    .conflicts;
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]!.winningTerminalId).toBe("t1");
});

it("lets an earlier scan displace the incumbent, and does not report that to the sender", async () => {
  const agent = request.agent(app!.getHttpServer());
  await signUpAndActivate(agent);
  const apiKey = await deviceKey(agent);
  const shiftId = await openShift(agent);

  const late = { ...item(shiftId, 1), terminalId: "t1" };
  await request(app!.getHttpServer())
    .post("/station/scans")
    .set("x-api-key", apiKey)
    .send({ batchId: "m1:30", items: [late] })
    .expect(201);

  const earlier = {
    ...late,
    terminalId: "t2",
    scannedAt: new Date(Date.parse(late.scannedAt) - 5000).toISOString(),
  };
  const res = await request(app!.getHttpServer())
    .post("/station/scans")
    .set("x-api-key", apiKey)
    .send({ batchId: "m1:31", items: [earlier] })
    .expect(201);

  // The sender won, so nothing comes back to it — but a conflict exists.
  expect((res.body as { conflicts: unknown[] }).conflicts).toEqual([]);
});

it("is idempotent: replaying a batch changes neither ownership nor conflict count", async () => {
  const agent = request.agent(app!.getHttpServer());
  await signUpAndActivate(agent);
  const apiKey = await deviceKey(agent);
  const shiftId = await openShift(agent);

  const first = { ...item(shiftId, 1), terminalId: "t1" };
  await request(app!.getHttpServer())
    .post("/station/scans")
    .set("x-api-key", apiKey)
    .send({ batchId: "m1:40", items: [first] })
    .expect(201);

  const body = {
    batchId: "m1:41",
    items: [
      {
        ...first,
        terminalId: "t2",
        scannedAt: new Date(Date.parse(first.scannedAt) + 5000).toISOString(),
      },
    ],
  };
  await request(app!.getHttpServer())
    .post("/station/scans")
    .set("x-api-key", apiKey)
    .send(body)
    .expect(201);
  const replay = await request(app!.getHttpServer())
    .post("/station/scans")
    .set("x-api-key", apiKey)
    .send(body)
    .expect(201);

  expect((replay.body as { alreadyApplied: boolean }).alreadyApplied).toBe(true);
  expect((replay.body as { conflicts: unknown[] }).conflicts).toEqual([]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173 PAIRING_CODE_PEPPER=insecure-dummy-ci-pepper-not-a-secret pnpm --filter @markiro/api exec vitest run station-scans`
Expected: FAIL — the response has no `conflicts` field.

- [ ] **Step 3: Extend the response DTO**

In `apps/api/src/modules/station-scans/dto.ts`:

```ts
/** A code in THIS batch that lost ownership to an earlier scan elsewhere. */
export interface BatchConflictDto {
  codeHash: string;
  winningTerminalId: string | null;
  winningScannedAt: string;
}

export interface SyncBatchResponseDto {
  applied: number;
  alreadyApplied: boolean;
  /**
   * Only this batch's OWN losses. A scan of ours that displaced someone
   * else's is not here — that station's batch was acknowledged long ago and
   * the cabinet is its backstop.
   */
  conflicts: BatchConflictDto[];
}
```

Every existing `return` in the service must now include `conflicts` — the `alreadyApplied` short-circuit and the empty-batch path return `conflicts: []`.

- [ ] **Step 4: Claim inside the transaction**

In `station-scans.service.ts`, after the `scan_events` insert and before the late-data stamp, add:

```ts
// Ownership is settled last, on the codes this batch actually stored.
// One statement to read the incumbents, one to claim — never a query
// per code, and never against the partitioned tables.
const claimItems = coded.map((i) => ({
  codeHash: i.code!.codeHash,
  shiftId: i.shiftId,
  terminalId: i.terminalId,
  scannedAt: new Date(i.scannedAt),
}));

let batchConflicts: BatchConflictDto[] = [];
if (claimItems.length > 0) {
  const hashes = [...new Set(claimItems.map((c) => c.codeHash))];
  const owners = await tx
    .select({
      codeHash: schema.codeRegistry.codeHash,
      shiftId: schema.codeRegistry.shiftId,
      terminalId: schema.codeRegistry.terminalId,
      scannedAt: schema.codeRegistry.scannedAt,
    })
    .from(schema.codeRegistry)
    .where(
      and(
        eq(schema.codeRegistry.tenantId, tenantId),
        inArray(schema.codeRegistry.codeHash, hashes),
      ),
    );

  const resolution = resolveOwnership(claimItems, owners);

  if (resolution.claims.length > 0) {
    await tx
      .insert(schema.codeRegistry)
      .values(resolution.claims.map((c) => ({ tenantId, ...c })))
      .onConflictDoUpdate({
        target: [schema.codeRegistry.tenantId, schema.codeRegistry.codeHash],
        set: {
          shiftId: sql`excluded.shift_id`,
          terminalId: sql`excluded.terminal_id`,
          scannedAt: sql`excluded.scanned_at`,
          updatedAt: sql`now()`,
        },
        // The rule lives in the statement, not in application ordering:
        // ownership moves only for a strictly earlier scan, so two
        // concurrent batches cannot leave it dependent on who ran first.
        setWhere: sql`excluded.scanned_at < ${schema.codeRegistry.scannedAt}`,
      });
  }

  if (resolution.conflicts.length > 0) {
    await tx.insert(schema.codeConflicts).values(
      resolution.conflicts.map((c) => ({
        tenantId,
        codeHash: c.codeHash,
        losingShiftId: c.losing.shiftId,
        losingTerminalId: c.losing.terminalId,
        losingScannedAt: c.losing.scannedAt,
        winningShiftId: c.winning.shiftId,
        winningTerminalId: c.winning.terminalId,
        winningScannedAt: c.winning.scannedAt,
      })),
    );
  }

  batchConflicts = resolution.lostByThisBatch.map((c) => ({
    codeHash: c.codeHash,
    winningTerminalId: c.winning.terminalId,
    winningScannedAt: c.winning.scannedAt.toISOString(),
  }));
}
```

and return `{ applied: body.items.length, alreadyApplied: false, conflicts: batchConflicts }`.

Import `resolveOwnership` and the DTO type, and add `inArray`/`sql` to the `drizzle-orm` import if missing.

Note `coded` is the existing local holding the items that carry a code; reuse it rather than re-filtering.

- [ ] **Step 5: Run it green**

Run the Task 3 Step 2 command again.
Expected: PASS, and confirm the suite ran rather than skipped.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/station-scans apps/api/test/station-scans.e2e.test.ts
git commit -m "feat(api): claim code ownership and record conflicts on ingest"
```

---

### Task 4: Device-side conflict store

**Files:**

- Modify: `packages/db/src/sqlite/schema.ts`, `packages/db/src/sqlite/migrations.ts`, `packages/db/test/sqlite-schema.test.ts`
- Create: `apps/station/src/lib/conflicts.ts`
- Test: `apps/station/test/conflicts.test.ts`

**Interfaces:**

- Produces:
  - the `conflicts_mirror` table — `code_hash TEXT PRIMARY KEY`, `winning_terminal_id TEXT`, `winning_scanned_at TEXT NOT NULL`, `detected_at TEXT NOT NULL`
  - `interface DeviceConflict { codeHash: string; winningTerminalId: string | null; winningScannedAt: string; detectedAt: string; gtin14: string | null; serial: string | null }`
  - `recordConflicts(exec: SqlExecutor, rows: { codeHash: string; winningTerminalId: string | null; winningScannedAt: string }[], detectedAt: string): Promise<void>`
  - `readConflicts(exec: SqlExecutor): Promise<DeviceConflict[]>`
  - `conflictCount(exec: SqlExecutor): Promise<number>`

**Why the mirror joins `codes_mirror`:** the server sends a code hash, but a person needs to find a physical item. `codes_mirror` already holds that code's `gtin14` and `serial`, which identify the item on the floor far better than a hash. The join is left-outer, because retention could have purged the code row.

`code_hash` is the primary key, so re-reporting the same conflict is idempotent — one statement, no device transaction.

- [ ] **Step 1: Write the failing test**

```ts
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import { conflictCount, readConflicts, recordConflicts } from "../src/lib/conflicts.js";

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

const ROW = {
  codeHash: "h1",
  winningTerminalId: "t1",
  winningScannedAt: "2026-07-28T10:00:00.000Z",
};

describe("device conflicts", () => {
  it("records and reads back a conflict", async () => {
    const exec = await migratedExec();
    await recordConflicts(exec, [ROW], "2026-07-28T10:00:09.000Z");
    const rows = await readConflicts(exec);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ codeHash: "h1", winningTerminalId: "t1" });
    expect(await conflictCount(exec)).toBe(1);
  });

  it("is idempotent on the same code", async () => {
    const exec = await migratedExec();
    await recordConflicts(exec, [ROW], "2026-07-28T10:00:09.000Z");
    await recordConflicts(exec, [ROW], "2026-07-28T10:05:00.000Z");
    expect(await conflictCount(exec)).toBe(1);
  });

  it("carries the item's gtin and serial when the code is still mirrored", async () => {
    const exec = await migratedExec();
    await exec.run(
      `INSERT INTO codes_mirror (code_hash, shift_id, gtin14, serial, scanned_at) VALUES (?,?,?,?,?)`,
      ["h1", "s1", "04600000000017", "AB1", "2026-07-28T10:00:00.000Z"],
    );
    await recordConflicts(exec, [ROW], "2026-07-28T10:00:09.000Z");
    const [row] = await readConflicts(exec);
    expect(row).toMatchObject({ gtin14: "04600000000017", serial: "AB1" });
  });

  it("still reports a conflict whose code row is gone", async () => {
    const exec = await migratedExec();
    await recordConflicts(exec, [ROW], "2026-07-28T10:00:09.000Z");
    const [row] = await readConflicts(exec);
    expect(row).toMatchObject({ codeHash: "h1", gtin14: null, serial: null });
  });

  it("reports zero on an empty store", async () => {
    expect(await conflictCount(await migratedExec())).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @markiro/station exec vitest run conflicts`
Expected: FAIL — `no such table: conflicts_mirror`.

- [ ] **Step 3: Add the table**

Append to `STATION_MIGRATIONS` in `packages/db/src/sqlite/migrations.ts`, before the trailing `ALTER TABLE` statements:

```ts
  `CREATE TABLE IF NOT EXISTS conflicts_mirror (
     code_hash TEXT PRIMARY KEY,
     winning_terminal_id TEXT,
     winning_scanned_at TEXT NOT NULL,
     detected_at TEXT NOT NULL
   );`,
```

Mirror it in `packages/db/src/sqlite/schema.ts` beside the others, and raise the table count in `packages/db/test/sqlite-schema.test.ts` (adding a `toContain("conflicts_mirror")` assertion).

- [ ] **Step 4: Implement the store**

`apps/station/src/lib/conflicts.ts`:

```ts
import type { SqlExecutor } from "./mirror.js";

/** A code this device scanned that an earlier scan elsewhere already owns. */
export interface DeviceConflict {
  codeHash: string;
  winningTerminalId: string | null;
  winningScannedAt: string;
  detectedAt: string;
  /** From `codes_mirror`, so a person can find the physical item. */
  gtin14: string | null;
  serial: string | null;
}

/**
 * Records conflicts the server reported for a batch. Keyed by code, so the
 * same conflict arriving twice is one row — one statement per conflict, no
 * device transaction (the connection pool makes multi-call ones unsound).
 */
export async function recordConflicts(
  exec: SqlExecutor,
  rows: { codeHash: string; winningTerminalId: string | null; winningScannedAt: string }[],
  detectedAt: string,
): Promise<void> {
  for (const row of rows) {
    await exec.run(
      `INSERT INTO conflicts_mirror (code_hash, winning_terminal_id, winning_scanned_at, detected_at)
       VALUES (?,?,?,?)
       ON CONFLICT(code_hash) DO NOTHING`,
      [row.codeHash, row.winningTerminalId, row.winningScannedAt, detectedAt],
    );
  }
}

/**
 * Newest first. Left-outer against `codes_mirror` because retention may have
 * purged the code row, and a conflict must still be listable without it.
 */
export async function readConflicts(exec: SqlExecutor): Promise<DeviceConflict[]> {
  const rows = await exec.all<{
    code_hash: string;
    winning_terminal_id: string | null;
    winning_scanned_at: string;
    detected_at: string;
    gtin14: string | null;
    serial: string | null;
  }>(
    `SELECT c.code_hash, c.winning_terminal_id, c.winning_scanned_at, c.detected_at,
            m.gtin14, m.serial
       FROM conflicts_mirror c
       LEFT JOIN codes_mirror m ON m.code_hash = c.code_hash
      ORDER BY c.detected_at DESC`,
  );
  return rows.map((r) => ({
    codeHash: r.code_hash,
    winningTerminalId: r.winning_terminal_id,
    winningScannedAt: r.winning_scanned_at,
    detectedAt: r.detected_at,
    gtin14: r.gtin14,
    serial: r.serial,
  }));
}

export async function conflictCount(exec: SqlExecutor): Promise<number> {
  const rows = await exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM conflicts_mirror");
  return rows[0]?.n ?? 0;
}
```

- [ ] **Step 5: Run it green**

Run: `pnpm --filter @markiro/station test && pnpm --filter @markiro/db test`
Expected: PASS on both.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/sqlite packages/db/test/sqlite-schema.test.ts apps/station/src/lib/conflicts.ts apps/station/test/conflicts.test.ts
git commit -m "feat(station): device-side conflict store"
```

---

### Task 5: Surface conflicts through the sync engine

**Files:**

- Modify: `apps/station/src/lib/sync.ts`
- Test: `apps/station/test/sync.test.ts`

**Interfaces:**

- Consumes: `recordConflicts`, `conflictCount` (Task 4).
- Produces: `SyncState` gains `conflicts: number`.

**Do not weaken the response guard.** `isBatchResponse` currently requires `applied` a number and `alreadyApplied` a boolean before the acknowledgement deletes rows — that is what stops a captive portal's `200 {"status":"ok"}` from destroying scans. Extend it to tolerate a missing or malformed `conflicts` (treat it as empty) WITHOUT making the two existing fields optional.

Conflicts are recorded **before** the acknowledgement, so a crash between them resends the batch and the server — which already applied it — returns `alreadyApplied` with no conflicts; the ones already stored locally stay.

- [ ] **Step 1: Write the failing test**

```ts
it("records conflicts the server reports and counts them in the state", async () => {
  const exec = await migratedExec();
  await seed(exec, 1);
  const post = vi.fn().mockResolvedValue({
    applied: 1,
    alreadyApplied: false,
    conflicts: [
      { codeHash: "h1", winningTerminalId: "t9", winningScannedAt: "2026-07-28T10:00:00.000Z" },
    ],
  });
  const states: { conflicts: number }[] = [];

  const engine = createSyncEngine({
    exec,
    client: { post },
    machineId: "m1",
    onState: (s) => states.push({ conflicts: s.conflicts }),
  });
  engine.nudge();
  await engine.idle();

  expect(states.at(-1)!.conflicts).toBe(1);
  engine.stop();
});

it("still acknowledges when the response carries no conflicts field", async () => {
  const exec = await migratedExec();
  await seed(exec, 1);
  const post = vi.fn().mockResolvedValue({ applied: 1, alreadyApplied: false });

  const engine = createSyncEngine({ exec, client: { post }, machineId: "m1", onState: () => {} });
  engine.nudge();
  await engine.idle();

  const rows = await exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM outbox");
  expect(rows[0]!.n).toBe(0);
  engine.stop();
});

it("does not acknowledge when the response is not this endpoint's shape", async () => {
  const exec = await migratedExec();
  await seed(exec, 1);
  const post = vi.fn().mockResolvedValue({ status: "ok" });

  const engine = createSyncEngine({ exec, client: { post }, machineId: "m1", onState: () => {} });
  engine.nudge();
  await engine.idle();

  const rows = await exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM outbox");
  expect(rows[0]!.n).toBe(1);
  engine.stop();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @markiro/station exec vitest run sync`
Expected: FAIL — `SyncState` has no `conflicts`, and nothing records them.

- [ ] **Step 3: Implement**

Extend the response shape and its guard in `sync.ts`:

```ts
interface BatchConflict {
  codeHash: string;
  winningTerminalId: string | null;
  winningScannedAt: string;
}

interface BatchResponse {
  applied: number;
  alreadyApplied: boolean;
  conflicts?: BatchConflict[];
}

function isBatchConflict(value: unknown): value is BatchConflict {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return typeof c.codeHash === "string" && typeof c.winningScannedAt === "string";
}

/**
 * The two original fields stay REQUIRED: this guard is what stands between a
 * captive portal's `200 {"status":"ok"}` and an acknowledgement that
 * permanently deletes scans. `conflicts` is tolerated when absent or
 * malformed — a server that cannot describe conflicts must not cost the
 * device its delivery.
 */
function isBatchResponse(value: unknown): value is BatchResponse {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.applied === "number" && typeof r.alreadyApplied === "boolean";
}
```

In the drain, after the guard passes and **before** `ackThrough`:

```ts
const reported = Array.isArray(res.conflicts) ? res.conflicts.filter(isBatchConflict) : [];
if (reported.length > 0) {
  // Before the ack: if we crash between the two, the batch resends
  // and comes back `alreadyApplied` with no conflicts, so these
  // would otherwise be lost.
  await recordConflicts(deps.exec, reported, new Date(now()).toISOString());
}
```

Add `conflicts` to `SyncState` and populate it in `publishState` from `conflictCount(deps.exec)`.

- [ ] **Step 4: Run it green**

Run: `pnpm --filter @markiro/station test && pnpm --filter @markiro/station typecheck`
Expected: PASS — the three new cases and the existing suite. `App.tsx` consumes `SyncState`; if it destructures exhaustively, update it minimally to keep the package compiling.

- [ ] **Step 5: Commit**

```bash
git add apps/station/src/lib/sync.ts apps/station/test/sync.test.ts apps/station/src/App.tsx
git commit -m "feat(station): record conflicts reported by sync"
```

---

### Task 6: The operator's conflict list

**Files:**

- Create: `apps/station/src/pages/ConflictList.tsx`
- Modify: `apps/station/src/ui/StatusBar.tsx`, `apps/station/src/ui/FloorShell.tsx`, `apps/station/src/App.tsx`, both `apps/station/src/i18n/*.json`
- Test: `apps/station/test/conflict-list.test.tsx`, `apps/station/test/status-bar.test.tsx`

**Interfaces:**

- Consumes: `readConflicts`, `DeviceConflict` (Task 4); `syncState.conflicts` (Task 5).
- Produces: `ConflictListProps { exec: SqlExecutor; onBack: () => void }`; `StatusBarProps`/`FloorShellProps` gain `conflicts: number`.

**The floor rule is binding: this is not an alarm.** The operator was shown a green verdict for that scan minutes ago. A quiet count in the status bar, reachable from the shift-selection stage the way workstation setup is — never a modal, never a full-screen flash, never anything that appears while a verdict is on screen.

New i18n keys under `shell`: `conflicts`. Under a new `conflicts` namespace: `title`, `empty`, `wonBy`, `back`, `unknownItem`.

- [ ] **Step 1: Write the failing test**

```tsx
it("shows the conflict count in the status bar", () => {
  render(
    <StatusBar
      online
      scanner="keyboard"
      printerConfigured={false}
      syncPending={0}
      syncStuck={false}
      conflicts={3}
    />,
  );
  expect(screen.getByTestId("conflicts-status").textContent).toBe("3");
});

it("shows nothing to worry about at zero", () => {
  render(
    <StatusBar
      online
      scanner="keyboard"
      printerConfigured={false}
      syncPending={0}
      syncStuck={false}
      conflicts={0}
    />,
  );
  expect(screen.getByTestId("conflicts-status").textContent).toBe("0");
});
```

and in `apps/station/test/conflict-list.test.tsx`:

```tsx
it("lists an item by its gtin and serial", async () => {
  const exec = await migratedExec();
  await exec.run(
    `INSERT INTO codes_mirror (code_hash, shift_id, gtin14, serial, scanned_at) VALUES (?,?,?,?,?)`,
    ["h1", "s1", "04600000000017", "AB1", "2026-07-28T10:00:00.000Z"],
  );
  await recordConflicts(
    exec,
    [{ codeHash: "h1", winningTerminalId: "t9", winningScannedAt: "2026-07-28T10:00:00.000Z" }],
    "2026-07-28T10:00:09.000Z",
  );

  render(<ConflictList exec={exec} onBack={() => {}} />);

  expect(await screen.findByText(/04600000000017/)).toBeDefined();
  expect(screen.getByText(/AB1/)).toBeDefined();
});

it("falls back to the code when the item is no longer mirrored", async () => {
  const exec = await migratedExec();
  await recordConflicts(
    exec,
    [{ codeHash: "h1", winningTerminalId: "t9", winningScannedAt: "2026-07-28T10:00:00.000Z" }],
    "2026-07-28T10:00:09.000Z",
  );

  render(<ConflictList exec={exec} onBack={() => {}} />);
  expect(await screen.findByText("Item no longer on this device")).toBeDefined();
});

it("says so when there is nothing to review", async () => {
  render(<ConflictList exec={await migratedExec()} onBack={() => {}} />);
  expect(await screen.findByText("No conflicts")).toBeDefined();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @markiro/station exec vitest run conflict`
Expected: FAIL — no `conflicts` prop, no `ConflictList`.

- [ ] **Step 3: Implement**

Add `conflicts: number` to `StatusBarProps` and render it beside the sync count, with `data-testid="conflicts-status"`, following the existing per-field pattern. Thread it through `FloorShellProps`.

Create `ConflictList` as a floor-mode screen: it loads through `readConflicts` in an effect, renders each row as the item's GTIN and serial (falling back to `t("conflicts.unknownItem")`), the winning terminal and time, and a Back button with `style={{ minHeight: 64 }}` calling `onBack`.

In `App.tsx`, pass `conflicts={syncState.conflicts}` to `FloorShell`, and add a route to the list from the shift-selection stage, beside the workstation-setup entry.

- [ ] **Step 4: Add the i18n keys to BOTH dictionaries**

`en.json` — `shell.conflicts`: `"Conflicts"`; a new `conflicts` block: `title` `"Codes claimed elsewhere"`, `empty` `"No conflicts"`, `wonBy` `"Kept by {{terminal}} at {{time}}"`, `back` `"Back"`, `unknownItem` `"Item no longer on this device"`.

`ru.json` — `shell.conflicts`: `"Расхождения"`; `conflicts`: `title` `"Коды, занятые другим терминалом"`, `empty` `"Расхождений нет"`, `wonBy` `"Закреплён за {{terminal}} в {{time}}"`, `back` `"Назад"`, `unknownItem` `"Товара уже нет на этом устройстве"`.

Keep both files in matching key order.

- [ ] **Step 5: Run it green**

Run: `pnpm --filter @markiro/station test && pnpm --filter @markiro/station lint && pnpm --filter @markiro/station typecheck`
Expected: PASS on all three, i18n parity included.

- [ ] **Step 6: Commit**

```bash
git add apps/station/src apps/station/test
git commit -m "feat(station): quiet conflict count and reviewable list"
```

---

### Task 7: The manager's conflict view

**Files:**

- Create: `apps/api/src/modules/conflicts/{dto.ts,conflicts.service.ts,conflicts.controller.ts,conflicts.module.ts}`, `apps/admin/src/pages/conflicts/{api.ts,index.tsx}`
- Modify: `apps/api/src/app.module.ts`, `apps/admin/src/i18n/{en,ru}.json`, the admin router and navigation
- Test: `apps/api/test/conflicts.e2e.test.ts`, `apps/admin/test/conflicts.test.tsx`

**Interfaces:**

- Consumes: `codeConflicts` (Task 1).
- Produces: `GET /conflicts?shiftId=&reviewed=` returning `{ items: ConflictDto[] }`; `POST /conflicts/:id/review` returning the updated `ConflictDto`.

**Both routes are cabinet-only** — `@UseGuards(TenantGuard, SessionOnlyGuard)`, following `apps/api/src/modules/operators/operators.controller.ts`. A station has no business reading another terminal's conflicts, and `docs/device-key-surface.md` gains them in the cabinet-only table.

- [ ] **Step 1: Write the failing e2e**

`apps/api/test/conflicts.e2e.test.ts`, mirroring the setup block of `apps/api/test/employees.e2e.test.ts`:

```ts
it("lists a conflict for a shift and marks it reviewed", async () => {
  const agent = request.agent(app!.getHttpServer());
  await signUpAndActivate(agent);
  const apiKey = await deviceKey(agent);
  const shiftId = await openShift(agent);

  const first = { ...item(shiftId, 1), terminalId: "t1" };
  await request(app!.getHttpServer())
    .post("/station/scans")
    .set("x-api-key", apiKey)
    .send({ batchId: "m1:50", items: [first] })
    .expect(201);
  await request(app!.getHttpServer())
    .post("/station/scans")
    .set("x-api-key", apiKey)
    .send({
      batchId: "m1:51",
      items: [
        {
          ...first,
          terminalId: "t2",
          scannedAt: new Date(Date.parse(first.scannedAt) + 5000).toISOString(),
        },
      ],
    })
    .expect(201);

  const list = await agent.get(`/conflicts?shiftId=${shiftId}`).expect(200);
  const items = (list.body as { items: { id: string; reviewedAt: string | null }[] }).items;
  expect(items).toHaveLength(1);
  expect(items[0]!.reviewedAt).toBeNull();

  const reviewed = await agent.post(`/conflicts/${items[0]!.id}/review`).expect(200);
  expect((reviewed.body as { reviewedAt: string | null }).reviewedAt).not.toBeNull();
});

it("rejects a station api-key: conflicts are cabinet-only", async () => {
  const agent = request.agent(app!.getHttpServer());
  await signUpAndActivate(agent);
  const apiKey = await deviceKey(agent);

  await request(app!.getHttpServer()).get("/conflicts").set("x-api-key", apiKey).expect(403);
});

it("does not expose another tenant's conflicts", async () => {
  const agent = request.agent(app!.getHttpServer());
  await signUpAndActivate(agent);
  const other = request.agent(app!.getHttpServer());
  await signUpAndActivate(other);

  const list = await other.get("/conflicts").expect(200);
  expect((list.body as { items: unknown[] }).items).toEqual([]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run the API e2e command from Global Constraints with `vitest run conflicts`.
Expected: FAIL — 404, the routes do not exist.

- [ ] **Step 3: Implement the module**

`dto.ts` — a zod query schema (`shiftId` an optional uuid, `reviewed` an optional boolean-ish string) and:

```ts
export interface ConflictDto {
  id: string;
  codeHash: string;
  losingShiftId: string;
  losingTerminalId: string | null;
  losingScannedAt: Date;
  winningShiftId: string;
  winningTerminalId: string | null;
  winningScannedAt: Date;
  detectedAt: Date;
  reviewedAt: Date | null;
}
```

`conflicts.service.ts` — `listConflicts(tenantId, query)` selecting from `schema.codeConflicts` with `eq(tenantId)` plus the optional filters, newest `detectedAt` first; and `reviewConflict(tenantId, id)` doing a tenant-scoped `update ... set reviewedAt = now() ... returning`, throwing `NotFoundException` when nothing came back so one tenant cannot probe another's ids.

`conflicts.controller.ts` — `@Controller("conflicts")`, `@UseGuards(TenantGuard, SessionOnlyGuard)`, `@Get()` and `@Post(":id/review")` with `@HttpCode(200)`.

Register `ConflictsModule` in `apps/api/src/app.module.ts` beside the other feature modules.

- [ ] **Step 4: Implement the admin page**

`apps/admin/src/pages/conflicts/api.ts` — the fetch helpers and the admin's own `ConflictDto` mirror with `Date` fields as `string`.

`apps/admin/src/pages/conflicts/index.tsx` — a table following `apps/admin/src/pages/shifts/index.tsx`'s structure: columns for the item's code, the losing terminal and time, the winning terminal and time, and a Review action that calls the endpoint and refreshes. Add the route and a navigation entry the way the shifts page is registered.

- [ ] **Step 5: Add the i18n keys to BOTH admin dictionaries**

Under `pages.conflicts`: `title`, `table.code`, `table.losing`, `table.winning`, `table.detected`, `table.actions`, `review`, `reviewed`, `empty`. English and Russian, in matching positions.

- [ ] **Step 6: Run it green**

Run the API e2e command, then `pnpm --filter @markiro/admin test && pnpm --filter @markiro/admin lint && pnpm --filter @markiro/admin typecheck`.
Expected: PASS on all, and confirm the e2e ran rather than skipped.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/conflicts apps/api/src/app.module.ts apps/api/test/conflicts.e2e.test.ts apps/admin/src apps/admin/test
git commit -m "feat: cabinet conflict review"
```

---

### Task 8: Docs and full verification

**Files:**

- Modify: `docs/device-key-surface.md`, `apps/station/README.md`, `docs/superpowers/plans/2026-07-21-markiro-mvp-roadmap.md`

- [ ] **Step 1: Record the new routes**

Add `GET /conflicts` and `POST /conflicts/:id/review` to the **cabinet-only** table in `docs/device-key-surface.md`, with the reason: a station has no business reading another terminal's conflicts, and the e2e above pins the 403.

- [ ] **Step 2: Document the rule in the station README**

Add a section covering: that ownership is decided server-side by the earliest `scanned_at` and never by arrival order; that the registry exists because a partitioned table cannot enforce one row per code; that a station learns only about its OWN losses through the sync response, while a displaced scan's station learns from the cabinet; that conflicts are recorded before the acknowledgement so a crash between them cannot lose them; and that the count is deliberately quiet because nothing competes with a scan verdict. Follow the file's existing structure, no line numbers.

Also record the cost the spec names for plan 09: `code_registry` grows one row per code ever accepted and is unpartitioned, so it becomes as large as `codes` without sharing its retention story. Say why scoping it per shift was rejected — it would stop catching the same physical item across two shifts, which is a real error — so the next person weighs the same trade-off rather than re-deriving it.

- [ ] **Step 3: Update the roadmap**

Add a `06b` row marked done with today's date, pointing at this plan, and note that aggregation — boxes, pallets, SSCC — is unblocked by it and comes next.

- [ ] **Step 4: Full verification**

```bash
pnpm format:check
DATABASE_URL=postgres://markiro:markiro@localhost:5432/markiro BETTER_AUTH_SECRET=insecure-dummy-ci-placeholder-not-a-secret BETTER_AUTH_URL=http://localhost:3000 ADMIN_ORIGIN=http://localhost:5173 PAIRING_CODE_PEPPER=insecure-dummy-ci-pepper-not-a-secret pnpm turbo lint typecheck test build
cargo test --manifest-path apps/station/src-tauri/Cargo.toml
```

Report per-package test counts and confirm the API e2e ran rather than skipped.

**Known flake, do not chase:** an API e2e file can fail under load and pass in isolation — historically a different file each time. If you hit it, re-run that file alone and report BOTH results honestly. Do not change test infrastructure to make it go away.

- [ ] **Step 5: Commit**

```bash
git add docs apps/station/README.md
git commit -m "docs: cross-terminal ownership and the conflict surface"
```
