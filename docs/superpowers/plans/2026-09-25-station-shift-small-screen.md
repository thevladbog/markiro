# Station Shift Small-Screen Layout and Shift-Wide Total Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the box fill visible on a 1024×697 station window, replace the session-only counters with shift-scoped ones, and show the shift's accepted units across all terminals in a new shift band.

**Architecture:** A station-only API route counts `code_registry` rows of a shift (and the caller's share) over a new online-built index. The station sync engine fetches that answer for a "watched shift" after each drain, persists it in `station_meta`, and publishes it with the sync state; the work screen adds this terminal's live local count to the other terminals' last known share. The work screen gets a full-width shift band above two columns; the counters card becomes the head of the shift journal, whose error and duplicate counts come from the local journal.

**Tech Stack:** TypeScript, React 19, Vitest + Testing Library (jsdom, `node:sqlite`), NestJS, Drizzle/Postgres, station SQLite (`tauri-plugin-sql`), Zod, i18next.

**Spec:** `docs/superpowers/specs/2026-09-25-station-shift-small-screen-design.md` (design mock: pen.dev frames `11A`–`11C` in `pencil-new.pen`, variant A approved).

## Global Constraints

- Every interactive station element stays at least 64 px in both dimensions (the production browser contract measures this).
- Supported minimum viewport: 1024×690. At 1024×697 the box grid gets at least two rows (`minmax(96px, 1fr)`).
- Station stays offline-first: nothing on the work screen waits for the network; the progress fetch never schedules a sync retry and never marks sync as stuck.
- The shift total is `acceptedUnits − deviceAcceptedUnits + local`, where `local = COUNT(*) FROM station_processed_codes WHERE shift_id = ?`.
- «Ошибки» / «Дубли» are this terminal's shift counts from `scan_events_mirror`; duplicate-DM refusals (never journaled) are added for the session on top.
- The new route derives tenant and device from the credential, answers 404 for a foreign, unknown or malformed shift id, declares `@AllowSubscriptionRecovery("station")`, and must appear in the route inventory, device-key docs and the Station CORS surface.
- Postgres index `code_registry_tenant_shift_terminal_idx` is built `CONCURRENTLY` by `runtime-migrate.ts`; the journaled `.sql` keeps drizzle-kit's plain statement.
- Station SQLite DDL is appended to `packages/db/src/sqlite/migrations.ts` with `IF NOT EXISTS` (every statement re-runs on each boot); never reorder existing entries.
- i18n: RU and EN key sets stay identical; a missing key throws in tests. Do not pass a string option named `count` (it triggers plural lookup).
- TypeScript strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`: no `any`, no non-null assertions, no broad casts.
- Stage explicit paths only; do not touch `exports/`, `output/`, `screenshots/` or unrelated files. Do not push, release or deploy without user authorization. Rollout order when authorized: API first, then the station build.

## File map

| Unit                                                                                                                                     | Responsibility                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/db/src/schema/platform.ts`, `packages/db/migrations/0175_code_registry_shift_terminal_idx.sql` (+ snapshot, journal)           | Declares and records the `(tenant_id, shift_id, terminal_id)` index on `code_registry`. |
| `packages/db/src/runtime-migrate.ts`                                                                                                     | Builds that index concurrently before journaling migration 0175.                        |
| `packages/db/src/sqlite/migrations.ts`, `packages/db/src/sqlite/schema.ts`                                                               | Station indexes `scan_events_mirror(shift_id, verdict)` and `codes_mirror(shift_id)`.   |
| `apps/api/src/modules/shifts/station-shift-progress.{service,controller}.ts`, `dto.ts`, `shifts.module.ts`                               | `GET /station/shifts/:id/progress`.                                                     |
| `apps/api/src/cors.ts`, `tools/station-release/verify-api-cors.mjs`                                                                      | Station CORS surface and release preflights for the route.                              |
| `apps/station/src/lib/shift-progress.ts`                                                                                                 | Snapshot type, response parsing, persisted tracker, `shiftTotalView`.                   |
| `apps/station/src/lib/sync.ts`, `use-sync-engine.ts`                                                                                     | Watched-shift progress step and its publication.                                        |
| `apps/station/src/lib/journal.ts`, `use-shift-journal-counts.ts`                                                                         | Durable shift counts from the local journal.                                            |
| `apps/station/src/lib/shift-label.ts`                                                                                                    | Header shift label without the product name.                                            |
| `apps/station/src/ui/work/ShiftBand.tsx`                                                                                                 | Product identity + shift total band.                                                    |
| `apps/station/src/ui/work/ScanResultInstrument.tsx`                                                                                      | Verdict only.                                                                           |
| `apps/station/src/ui/work/BoxFillInstrument.tsx`, `components/PalletStrip.tsx`, `ui/work/RecentOperations.tsx`, `ui/work/WorkFooter.tsx` | One-row box head, compact pallet, journal head, three-button footer.                    |
| `apps/station/src/pages/WorkScreen.tsx`, `App.tsx`, `ui/work/work-labels.ts`, `i18n/{ru,en}.json`, `station.css`                         | Composition, wiring, copy and layout.                                                   |
| `apps/station/src/dev/gallery-fixtures.ts`, `dev/StationScreenGallery.tsx`                                                               | Gallery composition and the new `work-pallet-20` states.                                |

---

### Task 0: Prepare the worktree

No code and no commit. Run from the worktree root `/Users/thevladbog/PRSOME/q/.claude/worktrees/tsd-unbind-organization-f791ab`.

- [ ] **Step 1: Install dependencies once, outside the sandbox**

The Claude Code sandbox forbids writes to the global pnpm store; pnpm then creates a local store and reinstalls before every command. Run once with the sandbox disabled:

```bash
CI=true pnpm install --frozen-lockfile
```

If a `.pnpm-store/` directory appears in the worktree, delete it. Every later `pnpm` command in this plan carries `--config.verifyDepsBeforeRun=false`.

- [ ] **Step 2: Build workspace dependencies of the three consumers**

```bash
pnpm --config.verifyDepsBeforeRun=false turbo run build --filter='@markiro/station^...' --filter='@markiro/api^...'
```

Expected: `@markiro/domain`, `@markiro/db`, `@markiro/ui`, `@markiro/platform-contracts`, `@markiro/email` build successfully.

- [ ] **Step 3: Start a disposable Postgres for DB and API tests (sandbox disabled: docker)**

`.env` is not readable in this environment and the shared dev database drifts between branches. Use a throwaway container on a free port:

```bash
docker run -d --name markiro-shift-progress-postgres -e POSTGRES_USER=markiro -e POSTGRES_PASSWORD=markiro -e POSTGRES_DB=markiro -p 127.0.0.1:55437:5432 postgres:16-alpine
```

```bash
DATABASE_URL=postgres://markiro:markiro@127.0.0.1:55437/markiro pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db db:migrate
```

Write the API test environment (values from `.env.example`, secrets random) to `/tmp/markiro-shift-progress.env`:

```bash
cat > /tmp/markiro-shift-progress.env <<'EOF'
DATABASE_URL=postgres://markiro:markiro@127.0.0.1:55437/markiro
NODE_ENV=test
BETTER_AUTH_SECRET=shift-progress-better-auth-secret-0001
BETTER_AUTH_URL=http://localhost:3000
ADMIN_ORIGIN=http://localhost:5173
PLATFORM_AUTH_SECRET=shift-progress-platform-auth-secret-0002
PLATFORM_AUTH_URL=http://localhost:3000
SAAS_ADMIN_ORIGIN=http://localhost:5473
STATION_ORIGIN=http://tauri.localhost
KIOSK_ORIGIN=http://localhost:5373
PAIRING_CODE_PEPPER=shift-progress-pairing-pepper-0003
MAIL_PAYLOAD_ENCRYPTION_KEY=bW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW0=
EOF
```

DB and API test commands later in this plan are run with the sandbox disabled (docker, `listen` on 127.0.0.1) and prefixed by `set -a; source /tmp/markiro-shift-progress.env; set +a;`. If `loadEnv` rejects a variable, compare with `apps/api/src/env.ts` and `.env.example` and add it to the file; a ZodError there shows the whole API file as "skipped".

At the very end of the plan (Task 13) remove the container with `docker rm -f markiro-shift-progress-postgres`.

---

### Task 1: Online `code_registry (tenant_id, shift_id, terminal_id)` index

**Files:**

- Modify: `packages/db/src/schema/platform.ts:343-366`
- Create (generated): `packages/db/migrations/0175_code_registry_shift_terminal_idx.sql`, `packages/db/migrations/meta/0175_snapshot.json`
- Modify (generated): `packages/db/migrations/meta/_journal.json`
- Modify: `packages/db/src/runtime-migrate.ts` (dispatcher call ~line 66-78, `migrateWithOnlineOfferVariants` ~line 130-214, new functions after `prepareOnlineGrantReadiness`)
- Test: `packages/db/test/schema.test.ts`, create `packages/db/test/code-registry-shift-index-migration.test.ts`

**Interfaces:**

- Produces: Postgres index `code_registry_tenant_shift_terminal_idx` on `code_registry (tenant_id, shift_id, terminal_id)`, relied on by Task 3's counts.

- [ ] **Step 1: Write the failing schema test**

Add inside the top-level `describe` of `packages/db/test/schema.test.ts` (the file already imports `is`, `getTableConfig`, `IndexedColumn` and `codeRegistry`):

```ts
it("indexes code_registry by tenant, shift and terminal for shift progress reads", () => {
  const index = getTableConfig(codeRegistry).indexes.find(
    (item) => item.config.name === "code_registry_tenant_shift_terminal_idx",
  );
  expect(index, "missing code_registry (tenant, shift, terminal) index").toBeDefined();
  expect(index?.config.unique).toBe(false);
  expect(
    index?.config.columns.map((column) => (is(column, IndexedColumn) ? column.name : undefined)),
  ).toEqual(["tenant_id", "shift_id", "terminal_id"]);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db exec vitest run test/schema.test.ts -t "code_registry by tenant"`
Expected: FAIL — `missing code_registry (tenant, shift, terminal) index`.

- [ ] **Step 3: Declare the index**

In `packages/db/src/schema/platform.ts`, inside `codeRegistry`'s index callback, after `index("code_registry_tenant_scanned_idx").on(t.tenantId, t.scannedAt),` add:

```ts
      // GET /station/shifts/:id/progress (and the shift summary) count one
      // shift's current owners and one device's share of them.
      index("code_registry_tenant_shift_terminal_idx").on(t.tenantId, t.shiftId, t.terminalId),
```

- [ ] **Step 4: Run the schema test again**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db exec vitest run test/schema.test.ts -t "code_registry by tenant"`
Expected: PASS.

- [ ] **Step 5: Generate the migration and pin its bytes**

```bash
pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db db:generate --name code_registry_shift_terminal_idx
```

Check the output (all three must hold; stop and inspect otherwise):

```bash
cat packages/db/migrations/0175_code_registry_shift_terminal_idx.sql
shasum -a 256 packages/db/migrations/0175_code_registry_shift_terminal_idx.sql
git diff --stat packages/db/migrations/meta/_journal.json
```

Expected:

- the file is exactly `CREATE INDEX "code_registry_tenant_shift_terminal_idx" ON "code_registry" USING btree ("tenant_id","shift_id","terminal_id");` with no trailing newline;
- the hash is `ed69c199cc2487148f0057a1bbf186b4a33e1acc9daf6b5285394fd851f5f533`;
- the journal gains exactly one entry (`idx` 175, tag `0175_code_registry_shift_terminal_idx`, `when` greater than `1789900000007`), and `meta/0175_snapshot.json` differs from `0174_snapshot.json` only by the new index.

- [ ] **Step 6: Write the failing online-migration test**

Create `packages/db/test/code-registry-shift-index-migration.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRuntimeMigrations } from "../src/runtime-migrate.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const INDEX_DEFINITION =
  "CREATE INDEX code_registry_tenant_shift_terminal_idx ON public.code_registry USING btree (tenant_id, shift_id, terminal_id)";

describe.skipIf(!databaseUrl)("code registry shift index online migration", () => {
  const name = `markiro_registry_shift_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://invalid");
  url.pathname = `/${name}`;
  url.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: url.toString() });
  let created = false;
  let temporaryRoot = "";

  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-registry-shift-"));
    const legacy = join(temporaryRoot, "legacy");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: legacy,
      lastIncludedIndex: 174,
    });
    await migrate(drizzle(pool), { migrationsFolder: legacy });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE IF EXISTS "${name}"`);
    await maintenance.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("rebuilds an invalid leftover concurrently and journals migration 0175 once", async () => {
    // A cancelled concurrent build leaves an INVALID index behind.
    const blocker = await pool.connect();
    const builder = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE code_registry IN ROW EXCLUSIVE MODE");
      await builder.query("SET statement_timeout = '1s'");
      await expect(
        builder.query(
          "CREATE INDEX CONCURRENTLY code_registry_tenant_shift_terminal_idx ON public.code_registry (tenant_id, shift_id, terminal_id)",
        ),
      ).rejects.toMatchObject({ code: "57014" });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await builder.query("RESET statement_timeout");
      builder.release();
    }
    const leftover = await pool.query<{ indisvalid: boolean }>(
      "SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('public.code_registry_tenant_shift_terminal_idx')",
    );
    expect(leftover.rows).toEqual([{ indisvalid: false }]);

    await runRuntimeMigrations({
      databaseUrl: url.toString(),
      migrationsFolder,
      log: () => undefined,
    });

    const index = await pool.query<{ indisvalid: boolean; definition: string }>(
      "SELECT indisvalid, pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indexrelid = to_regclass('public.code_registry_tenant_shift_terminal_idx')",
    );
    expect(index.rows).toEqual([{ indisvalid: true, definition: INDEX_DEFINITION }]);
    const migration = readMigrationFiles({ migrationsFolder })[175];
    expect(migration).toBeDefined();
    const journal = await pool.query<{ hash: string }>(
      "SELECT hash FROM drizzle.__drizzle_migrations WHERE hash = $1",
      [migration?.hash],
    );
    expect(journal.rows).toHaveLength(1);

    await runRuntimeMigrations({
      databaseUrl: url.toString(),
      migrationsFolder,
      log: () => undefined,
    });
    const again = await pool.query("SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = $1", [
      migration?.hash,
    ]);
    expect(again.rowCount).toBe(1);
  }, 180_000);
});
```

- [ ] **Step 7: Run it and see it fail (sandbox disabled)**

Run: `set -a; source /tmp/markiro-shift-progress.env; set +a; pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db exec vitest run test/code-registry-shift-index-migration.test.ts`
Expected: FAIL — the plain journaled `CREATE INDEX` hits the leftover (`relation "code_registry_tenant_shift_terminal_idx" already exists`).

- [ ] **Step 8: Add the online stage to `runtime-migrate.ts`**

1. In the dispatcher call (the `migrateWithOnlineOfferVariants(` call ~line 70), append one argument after `packaged.indexOf("0169_validate_device_replacement_execution"),`:

```ts
          packaged.indexOf("0175_code_registry_shift_terminal_idx"),
```

Keep the literal `packaged.indexOf("0169_validate_device_replacement_execution")` untouched — `deploy/production/test/device-replacement-execution-contract.test.mjs` asserts it.

2. Add the parameter to `migrateWithOnlineOfferVariants` after `replacementValidationIndex: number,`:

```ts
  codeRegistryShiftIndex: number,
```

3. In its body, between the `if (replacementValidationIndex >= nextIndex) { ... }` block and the final `await dialect.migrate(migrations.slice(nextIndex), session, { migrationsFolder });`, insert:

```ts
if (codeRegistryShiftIndex >= nextIndex) {
  // code_registry takes every accepted scan: a plain CREATE INDEX would
  // block ingest for the whole build. The journaled .sql keeps drizzle-kit's
  // plain statement for tests that run migrate() directly; at runtime this
  // stage builds the index concurrently and journals the migration itself.
  await dialect.migrate(migrations.slice(nextIndex, codeRegistryShiftIndex), session, {
    migrationsFolder,
  });
  const shiftIndexMigration = migrations[codeRegistryShiftIndex];
  if (!shiftIndexMigration) throw new Error("Missing code registry shift index migration");
  await migrateWithOnlineCodeRegistryShiftIndex(client, shiftIndexMigration);
  nextIndex = codeRegistryShiftIndex + 1;
}
```

4. After `prepareOnlineGrantReadiness`, add:

```ts
async function migrateWithOnlineCodeRegistryShiftIndex(
  client: pg.PoolClient,
  migration: { hash: string; folderMillis: number; sql: string[] },
): Promise<void> {
  if (migration.hash !== "ed69c199cc2487148f0057a1bbf186b4a33e1acc9daf6b5285394fd851f5f533") {
    throw new Error("Online code registry shift index migration hash mismatch");
  }
  const latest = await client.query<{ created_at: string }>(
    "SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1",
  );
  if (Number(latest.rows[0]?.created_at ?? 0) >= migration.folderMillis) return;
  if (migration.sql.length !== 1) {
    throw new Error("Unexpected online code registry shift index migration");
  }
  // Runs under the session's statement_timeout; a cancelled build leaves an
  // INVALID index that the next run drops and rebuilds.
  await prepareOnlineCodeRegistryShiftIndex(client);
  const timeout = await client.query<{ lock_timeout: string }>("SHOW lock_timeout");
  const previousTimeout = timeout.rows[0]?.lock_timeout;
  if (!previousTimeout) throw new Error("Missing migration lock timeout");
  await client.query("SELECT set_config('lock_timeout', '5s', false)");
  try {
    await client.query("BEGIN");
    try {
      await client.query(
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
        [migration.hash, migration.folderMillis],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client.query("SELECT set_config('lock_timeout', $1, false)", [previousTimeout]);
  }
}

async function prepareOnlineCodeRegistryShiftIndex(client: pg.PoolClient): Promise<void> {
  const existing = await client.query<{ indisvalid: boolean; definition: string }>(
    `SELECT indisvalid, pg_get_indexdef(indexrelid) AS definition FROM pg_index
      WHERE indexrelid = to_regclass('public.code_registry_tenant_shift_terminal_idx')`,
  );
  const prepared = existing.rows[0];
  if (
    prepared &&
    prepared.definition !==
      "CREATE INDEX code_registry_tenant_shift_terminal_idx ON public.code_registry USING btree (tenant_id, shift_id, terminal_id)"
  )
    throw new Error("Unexpected prepared code registry shift index");
  // IF NOT EXISTS alone would silently reuse an INVALID leftover.
  if (prepared && !prepared.indisvalid)
    await client.query("DROP INDEX CONCURRENTLY public.code_registry_tenant_shift_terminal_idx");
  if (!prepared?.indisvalid)
    await client.query(`CREATE INDEX CONCURRENTLY code_registry_tenant_shift_terminal_idx
      ON public.code_registry (tenant_id, shift_id, terminal_id)`);
}
```

- [ ] **Step 9: Run the migration test and the DB package tests (sandbox disabled)**

Run: `set -a; source /tmp/markiro-shift-progress.env; set +a; pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db exec vitest run test/code-registry-shift-index-migration.test.ts test/schema.test.ts test/runtime-migrate.test.ts`
Expected: PASS.

Run: `set -a; source /tmp/markiro-shift-progress.env; set +a; pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db test && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db typecheck && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db lint && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db build`
Expected: all green; report any DB test skipped for infrastructure.

Run: `node --test deploy/production/test/device-replacement-execution-contract.test.mjs`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/db/src/schema/platform.ts packages/db/migrations/0175_code_registry_shift_terminal_idx.sql packages/db/migrations/meta/0175_snapshot.json packages/db/migrations/meta/_journal.json packages/db/src/runtime-migrate.ts packages/db/test/schema.test.ts packages/db/test/code-registry-shift-index-migration.test.ts
git commit -m "feat(db): index code_registry by shift and terminal online"
```

---

### Task 2: Station SQLite indexes for shift counters

**Files:**

- Modify: `packages/db/src/sqlite/migrations.ts` (append two entries at the end of `STATION_MIGRATIONS`, after the `scan_event_box_identity_from_outbox` trigger)
- Modify: `packages/db/src/sqlite/schema.ts` (`codesMirror` ~line 203, `scanEventsMirror` ~line 219)
- Test: create `packages/db/test/station-shift-counters-schema.test.ts`

**Interfaces:**

- Produces: indexes `scan_events_mirror_shift_verdict_idx` and `codes_mirror_shift_idx`, used by Task 7's counts.

- [ ] **Step 1: Write the failing test**

Create `packages/db/test/station-shift-counters-schema.test.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { STATION_MIGRATIONS } from "../src/sqlite/migrations.js";
import * as sqliteSchema from "../src/sqlite/schema.js";

function migrated(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const statement of STATION_MIGRATIONS) {
    try {
      db.exec(statement);
    } catch (error) {
      if (!/duplicate column name/i.test(String(error))) throw error;
    }
  }
  return db;
}

describe("station shift counter indexes", () => {
  it("installs both indexes idempotently", () => {
    const db = migrated();
    for (const statement of STATION_MIGRATIONS) {
      try {
        db.exec(statement);
      } catch (error) {
        if (!/duplicate column name/i.test(String(error))) throw error;
      }
    }
    const names = (table: string) =>
      (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map(
        (row) => row.name,
      );
    expect(names("scan_events_mirror")).toContain("scan_events_mirror_shift_verdict_idx");
    expect(names("codes_mirror")).toContain("codes_mirror_shift_idx");
  });

  it("answers the per-shift journal counts from the covering index", () => {
    const db = migrated();
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT SUM(CASE WHEN verdict = 'duplicate' THEN 1 ELSE 0 END) FROM scan_events_mirror WHERE shift_id = ?",
      )
      .all("s1") as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join("\n")).toContain(
      "COVERING INDEX scan_events_mirror_shift_verdict_idx",
    );
  });

  it("declares the indexes in the Drizzle SQLite schema for parity", () => {
    expect(
      getSqliteTableConfig(sqliteSchema.scanEventsMirror).indexes.map((item) => item.config.name),
    ).toContain("scan_events_mirror_shift_verdict_idx");
    expect(
      getSqliteTableConfig(sqliteSchema.codesMirror).indexes.map((item) => item.config.name),
    ).toContain("codes_mirror_shift_idx");
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db exec vitest run test/station-shift-counters-schema.test.ts`
Expected: FAIL on all three tests (indexes absent).

- [ ] **Step 3: Append the DDL**

At the very end of `STATION_MIGRATIONS` in `packages/db/src/sqlite/migrations.ts` (after the `scan_event_box_identity_from_outbox` trigger, before the closing `];`), append:

```ts
  // The work screen counts one shift's journal verdicts and accepted units
  // after every scan (design 2026-09-25); without these both reads scan the
  // device's whole history. IF NOT EXISTS: every statement re-runs on boot.
  `CREATE INDEX IF NOT EXISTS scan_events_mirror_shift_verdict_idx
     ON scan_events_mirror(shift_id,verdict);`,
  `CREATE INDEX IF NOT EXISTS codes_mirror_shift_idx
     ON codes_mirror(shift_id);`,
```

- [ ] **Step 4: Declare them in `schema.ts`**

Give `codesMirror` and `scanEventsMirror` a third argument (keep their column objects unchanged):

```ts
export const codesMirror = sqliteTable(
  "codes_mirror",
  {
    codeHash: text("code_hash").primaryKey(),
    shiftId: text("shift_id").notNull(),
    gtin14: text("gtin14").notNull(),
    serial: text("serial").notNull(),
    scannedAt: text("scanned_at").notNull(),
    boxId: text("box_id"),
  },
  (t) => [index("codes_mirror_shift_idx").on(t.shiftId)],
);
```

```ts
export const scanEventsMirror = sqliteTable(
  "scan_events_mirror",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    shiftId: text("shift_id").notNull(),
    terminalId: text("terminal_id"),
    raw: text("raw").notNull(),
    verdict: text("verdict").notNull(),
    scannedAt: text("scanned_at").notNull(),
    operatorId: text("operator_id"),
    codeHash: text("code_hash"),
    boxId: text("box_id"),
  },
  (t) => [index("scan_events_mirror_shift_verdict_idx").on(t.shiftId, t.verdict)],
);
```

(`index` is already imported from `drizzle-orm/sqlite-core` at the top of the file.)

- [ ] **Step 5: Run the tests**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db exec vitest run test/station-shift-counters-schema.test.ts test/sqlite-schema.test.ts test/station-sqlite-entry.test.ts`
Expected: PASS.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db typecheck && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db lint && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/db build`
Expected: green.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station exec vitest run test/mirror.test.ts`
Expected: PASS (the station applies the appended statements twice without error).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/sqlite/migrations.ts packages/db/src/sqlite/schema.ts packages/db/test/station-shift-counters-schema.test.ts
git commit -m "feat(db): index the station journal by shift for shift counters"
```

---

### Task 3: `GET /station/shifts/:id/progress`

**Files:**

- Create: `apps/api/src/modules/shifts/station-shift-progress.service.ts`
- Create: `apps/api/src/modules/shifts/station-shift-progress.controller.ts`
- Modify: `apps/api/src/modules/shifts/dto.ts` (append the DTO and OpenAPI schema)
- Modify: `apps/api/src/modules/shifts/shifts.module.ts:12-16`
- Modify: `apps/api/test/subscription-route-inventory.test.ts` (station recovery group ~line 520-541; guard-chain branch ~line 1125-1131)
- Modify: `apps/api/test/authorization-metadata.test.ts` (`STATION_ONLY_CONTROLLERS` ~line 351-366 and imports)
- Modify: `docs/device-key-surface.md` ("Reachable by a device key" table, ~lines 69-86)
- Test: create `apps/api/test/station-shift-progress.service.test.ts`, `apps/api/test/station-shift-progress.e2e.test.ts`

**Interfaces:**

- Consumes: Task 1's index (performance only).
- Produces: `GET /station/shifts/:id/progress` → `{ shiftId: string; acceptedUnits: number; deviceAcceptedUnits: number; asOf: string }`, consumed by Task 5.

- [ ] **Step 1: Write the failing service unit test**

Create `apps/api/test/station-shift-progress.service.test.ts`:

```ts
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@markiro/db";
import { StationShiftProgressService } from "../src/modules/shifts/station-shift-progress.service";

type QueryResult = { rows: Record<string, unknown>[] };

function progressService(results: QueryResult[]) {
  const dialect = new PgDialect();
  const queries: { sql: string; params: unknown[] }[] = [];
  const execute = vi.fn(async (query: SQL) => {
    const compiled = dialect.sqlToQuery(query);
    queries.push({ sql: compiled.sql, params: compiled.params });
    const result = results.shift();
    if (!result) throw new Error("Unexpected progress query");
    return result;
  });
  const transaction = vi.fn(async (run: (tx: { execute: typeof execute }) => Promise<unknown>) =>
    run({ execute }),
  );
  const service = new StationShiftProgressService({ transaction } as unknown as Db);
  return { service, transaction, queries };
}

const SHIFT = "8f14e45f-ceea-467a-9b3c-1c6a1c3f9b10";
const DEVICE = "c9f0f895-fb98-4b91-a9b5-9f1d5f6b2f11";

describe("StationShiftProgressService", () => {
  it("adds reprocessed units to registry owners in one read-only snapshot", async () => {
    const harness = progressService([
      {
        rows: [
          {
            asOf: new Date("2026-09-25T09:00:00.000Z"),
            registryUnits: "1200",
            deviceRegistryUnits: 300,
            reprocessedUnits: 2,
            deviceReprocessedUnits: "2",
          },
        ],
      },
    ]);
    await expect(harness.service.progress("tenant-1", SHIFT, DEVICE)).resolves.toEqual({
      shiftId: SHIFT,
      acceptedUnits: 1202,
      deviceAcceptedUnits: 302,
      asOf: "2026-09-25T09:00:00.000Z",
    });
    expect(harness.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
    const [query] = harness.queries;
    expect(query?.sql).toContain("from code_registry");
    expect(query?.sql).toContain("allow_previously_accepted_codes");
    expect(query?.params).toEqual(expect.arrayContaining(["tenant-1", SHIFT, DEVICE]));
  });

  it("answers 404 for a missing shift and for a malformed id without querying", async () => {
    const missing = progressService([{ rows: [] }]);
    await expect(missing.service.progress("tenant-1", SHIFT, DEVICE)).rejects.toMatchObject({
      status: 404,
    });
    const malformed = progressService([]);
    await expect(
      malformed.service.progress("tenant-1", "not-a-uuid", DEVICE),
    ).rejects.toMatchObject({ status: 404 });
    expect(malformed.transaction).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/station-shift-progress.service.test.ts`
Expected: FAIL — cannot resolve `station-shift-progress.service`.

- [ ] **Step 3: Add the DTO and OpenAPI schema**

Append to `apps/api/src/modules/shifts/dto.ts` (it already imports `SchemaObject` for `shiftSummaryOpenApiSchema`):

```ts
/** A shift's current code owners across every device, and the caller's share. */
export interface StationShiftProgressDto {
  shiftId: string;
  acceptedUnits: number;
  deviceAcceptedUnits: number;
  asOf: string;
}

export const stationShiftProgressOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["shiftId", "acceptedUnits", "deviceAcceptedUnits", "asOf"],
  properties: {
    shiftId: { type: "string", format: "uuid" },
    acceptedUnits: { type: "integer", minimum: 0 },
    deviceAcceptedUnits: { type: "integer", minimum: 0 },
    asOf: { type: "string", format: "date-time" },
  },
};
```

- [ ] **Step 4: Write the service**

Create `apps/api/src/modules/shifts/station-shift-progress.service.ts`:

```ts
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type { StationShiftProgressDto } from "./dto";

/**
 * The station work screen's shift-wide total (design 2026-09-25). One
 * read-only snapshot answers how many units the shift holds across every
 * device -- `code_registry` owners, which already exclude undone, cleared,
 * disassembled and lost codes, plus reprocessed units when the shift allows
 * previously accepted codes -- and how many of them the calling device owns.
 * The station adds its live local count to the difference.
 */
@Injectable()
export class StationShiftProgressService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async progress(
    tenantId: string,
    shiftId: string,
    deviceId: string,
  ): Promise<StationShiftProgressDto> {
    // A malformed id is just another shift this device cannot see.
    if (!z.uuid().safeParse(shiftId).success) throw new NotFoundException();
    return this.db.transaction(
      async (tx) => {
        const result = await tx.execute(sql`
          with target_shift as (
            select shift.tenant_id, shift.id, shift.allow_previously_accepted_codes
            from shifts shift
            where shift.tenant_id = ${tenantId}
              and shift.id = ${shiftId}
          )
          select
            transaction_timestamp() as "asOf",
            (
              select count(*)::int
              from code_registry registry
              where registry.tenant_id = target.tenant_id
                and registry.shift_id = target.id
            ) as "registryUnits",
            (
              select count(*)::int
              from code_registry registry
              where registry.tenant_id = target.tenant_id
                and registry.shift_id = target.id
                and registry.terminal_id = ${deviceId}
            ) as "deviceRegistryUnits",
            (
              select count(*)::int
              from validation_code_reprocessings reprocessing
              where target.allow_previously_accepted_codes
                and reprocessing.tenant_id = target.tenant_id
                and reprocessing.shift_id = target.id
            ) as "reprocessedUnits",
            (
              select count(*)::int
              from validation_code_reprocessings reprocessing
              where target.allow_previously_accepted_codes
                and reprocessing.tenant_id = target.tenant_id
                and reprocessing.shift_id = target.id
                and reprocessing.terminal_id = ${deviceId}
            ) as "deviceReprocessedUnits"
          from target_shift target
        `);
        const row = result.rows[0];
        if (!row) throw new NotFoundException();
        return {
          shiftId,
          acceptedUnits:
            countOf(row.registryUnits, "registry units") +
            countOf(row.reprocessedUnits, "reprocessed units"),
          deviceAcceptedUnits:
            countOf(row.deviceRegistryUnits, "device registry units") +
            countOf(row.deviceReprocessedUnits, "device reprocessed units"),
          asOf: isoOf(row.asOf),
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
}

function countOf(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid ${label}`);
  return parsed;
}

function isoOf(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new Error("Invalid progress timestamp");
  return parsed.toISOString();
}
```

- [ ] **Step 5: Run the unit test**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/station-shift-progress.service.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the controller and register it**

Create `apps/api/src/modules/shifts/station-shift-progress.controller.ts`:

```ts
import { Controller, ForbiddenException, Get, Param, Req, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { ApiHttpErrors, ApiStationAuth } from "../../lib/openapi";
import { AllowSubscriptionRecovery } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { StationOnlyGuard } from "../../tenancy/station-only.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { stationShiftProgressOpenApiSchema, type StationShiftProgressDto } from "./dto";
import { StationShiftProgressService } from "./station-shift-progress.service";

@ApiTags("station")
@Controller("station")
@UseGuards(TenantGuard, StationOnlyGuard, SubscriptionAccessGuard)
@ApiStationAuth()
export class StationShiftProgressController {
  constructor(private readonly service: StationShiftProgressService) {}

  @Get("shifts/:id/progress")
  @AllowSubscriptionRecovery("station")
  @ApiOperation({
    summary: "Read a shift's accepted-unit total",
    description:
      "Counts the shift's current code owners across every device and the calling device's share, so a station can add its own live count to the other devices' last known contribution. A foreign, unknown or malformed shift id answers 404.",
  })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ schema: stationShiftProgressOpenApiSchema })
  @ApiHttpErrors(401, 403, 404, 429)
  async progress(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<StationShiftProgressDto> {
    // TenantGuard and StationOnlyGuard set both; the check narrows them without `!`.
    if (!req.tenantId || !req.deviceId) {
      throw new ForbiddenException("Station device authentication required");
    }
    return this.service.progress(req.tenantId, id, req.deviceId);
  }
}
```

In `apps/api/src/modules/shifts/shifts.module.ts`, import both classes and register them:

```ts
import { StationShiftProgressController } from "./station-shift-progress.controller";
import { StationShiftProgressService } from "./station-shift-progress.service";
```

```ts
  controllers: [ShiftsController, StationProductImagesController, StationShiftProgressController],
  providers: [ShiftsService, StationShiftProgressService],
```

- [ ] **Step 7: Register the route in the inventory and metadata tests**

`apps/api/test/subscription-route-inventory.test.ts`: in the group `customerContract(STATION_GUARDS, { mode: "recovery", kind: "station" })`, add after the `"GET /station/inventories/:id/progress (StationInventoriesController.progress)",` line:

```ts
      "GET /station/shifts/:id/progress (StationShiftProgressController.progress)",
```

In the guard-chain branch (`route.controller.name === "StationScansController" || ...`), add:

```ts
                route.controller.name === "StationShiftProgressController" ||
```

`apps/api/test/authorization-metadata.test.ts`: import the controller next to the other shifts imports and add to `STATION_ONLY_CONTROLLERS`:

```ts
import { StationShiftProgressController } from "../src/modules/shifts/station-shift-progress.controller";
```

```ts
  [StationShiftProgressController, ["progress"]],
```

- [ ] **Step 8: Write the failing e2e test**

Create `apps/api/test/station-shift-progress.e2e.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import express from "express";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalizeKm, kmHash } from "@markiro/domain";
import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import type { ScanItemDto } from "../src/modules/station-scans/dto";
import { listenOnLoopback } from "./support/listen-loopback";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);
const VALID_GTIN14 = "04006381333931";
const codeHashFor = (label: string) => kmHash(canonicalizeKm(`01${VALID_GTIN14}21S-${label}`));

describe.skipIf(!ready)("GET /station/shifts/:id/progress", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const env = loadEnv();
    const setup = setupAuth(env);
    const module = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL })],
    }).compile();
    app = module.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  const http = () => request(app.getHttpServer());

  function scan(
    shiftId: string,
    label: string,
    terminalId: string,
    scannedAt: string,
    boxId: string,
  ): ScanItemDto {
    const raw = `01${VALID_GTIN14}21S-${label}`;
    const km = canonicalizeKm(raw);
    return {
      shiftId,
      terminalId,
      raw,
      verdict: "ok",
      scannedAt,
      code: { codeHash: kmHash(km), gtin14: km.gtin14, serial: km.serial },
      boxId,
      operatorId: null,
    };
  }

  function correction(
    kind: "undo" | "clear",
    shiftId: string,
    terminalId: string,
    codeHash: string | null,
    targetScannedAt: string | null,
  ) {
    return {
      kind,
      boxId: "b1",
      codeHash,
      targetScannedAt,
      shiftId,
      terminalId,
      operatorId: null,
      reason: null,
      occurredAt: new Date().toISOString(),
    };
  }

  async function post(apiKey: string, body: { items?: ScanItemDto[]; exceptions?: unknown[] }) {
    await http()
      .post("/station/scans")
      .set("x-api-key", apiKey)
      .send({ batchId: `shift-progress-${randomUUID()}`, items: [], boxes: [], ...body })
      .expect(201);
  }

  async function openValidationShift(agent: ReturnType<typeof request.agent>): Promise<string> {
    const product = await agent
      .post("/products")
      .send({
        name: "Cola",
        gtin: VALID_GTIN14,
        chzProductGroupCode: 8,
        boxCapacity: 10,
        palletBoxCapacity: 5,
      })
      .expect(201);
    const shift = await agent
      .post("/shifts")
      .send({ productId: (product.body as { id: string }).id, mode: "validation" })
      .expect(201);
    const shiftId = (shift.body as { id: string }).id;
    await agent.post(`/shifts/${shiftId}/open`).expect(200);
    return shiftId;
  }

  it("counts the whole shift and the caller's share, net of undone codes", async () => {
    const agent = request.agent(app.getHttpServer());
    await signUpAndActivate(agent);
    const station = await createTestStationDevice(app, agent, "Line 1");
    const handheld = await createTestStationDevice(app, agent, "ТСД 1", { kind: "handheld" });
    const shiftId = await openValidationShift(agent);

    await post(station.apiKey, {
      items: [
        scan(shiftId, "aa", station.deviceId, "2026-07-01T10:00:00.000Z", "b1"),
        scan(shiftId, "bb", station.deviceId, "2026-07-01T10:00:01.000Z", "b1"),
        scan(shiftId, "cc", station.deviceId, "2026-07-01T10:00:02.000Z", "b1"),
      ],
    });
    await post(handheld.apiKey, {
      items: [scan(shiftId, "dd", handheld.deviceId, "2026-07-01T10:00:03.000Z", "h1")],
    });
    await post(station.apiKey, {
      exceptions: [
        correction(
          "undo",
          shiftId,
          station.deviceId,
          codeHashFor("aa"),
          "2026-07-01T10:00:00.000Z",
        ),
      ],
    });

    const mine = await http()
      .get(`/station/shifts/${shiftId}/progress`)
      .set("x-api-key", station.apiKey)
      .expect(200);
    expect(mine.body).toEqual({
      shiftId,
      acceptedUnits: 3,
      deviceAcceptedUnits: 2,
      asOf: expect.any(String),
    });
    expect(Number.isNaN(Date.parse((mine.body as { asOf: string }).asOf))).toBe(false);

    const theirs = await http()
      .get(`/station/shifts/${shiftId}/progress`)
      .set("x-api-key", handheld.apiKey)
      .expect(200);
    expect(theirs.body).toMatchObject({ acceptedUnits: 3, deviceAcceptedUnits: 1 });
  });

  it("drops a cleared box from the total", async () => {
    const agent = request.agent(app.getHttpServer());
    await signUpAndActivate(agent);
    const station = await createTestStationDevice(app, agent, "Line 1");
    const shiftId = await openValidationShift(agent);
    await post(station.apiKey, {
      items: [
        scan(shiftId, "ee", station.deviceId, "2026-07-01T11:00:00.000Z", "b1"),
        scan(shiftId, "ff", station.deviceId, "2026-07-01T11:00:01.000Z", "b1"),
      ],
    });
    await post(station.apiKey, {
      exceptions: [correction("clear", shiftId, station.deviceId, null, null)],
    });
    const res = await http()
      .get(`/station/shifts/${shiftId}/progress`)
      .set("x-api-key", station.apiKey)
      .expect(200);
    expect(res.body).toMatchObject({ acceptedUnits: 0, deviceAcceptedUnits: 0 });
  });

  it("hides foreign, unknown and malformed shifts and refuses other credential kinds", async () => {
    const owner = request.agent(app.getHttpServer());
    await signUpAndActivate(owner);
    const shiftId = await openValidationShift(owner);
    const stranger = request.agent(app.getHttpServer());
    await signUpAndActivate(stranger);
    const strangerDevice = await createTestStationDevice(app, stranger, "Other line");

    await http()
      .get(`/station/shifts/${shiftId}/progress`)
      .set("x-api-key", strangerDevice.apiKey)
      .expect(404);
    await http()
      .get(`/station/shifts/${randomUUID()}/progress`)
      .set("x-api-key", strangerDevice.apiKey)
      .expect(404);
    await http()
      .get("/station/shifts/not-a-uuid/progress")
      .set("x-api-key", strangerDevice.apiKey)
      .expect(404);
    await owner.get(`/station/shifts/${shiftId}/progress`).expect(403);
    await http().get(`/station/shifts/${shiftId}/progress`).expect(401);
  });
});
```

- [ ] **Step 9: Run the API tests (sandbox disabled)**

Run: `set -a; source /tmp/markiro-shift-progress.env; set +a; pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/station-shift-progress.e2e.test.ts test/station-shift-progress.service.test.ts test/subscription-route-inventory.test.ts test/authorization-metadata.test.ts test/openapi-coverage.test.ts`
Expected: PASS. If the e2e file shows "skipped", read the `Failed Suites` tail for a `loadEnv` ZodError and fix `/tmp/markiro-shift-progress.env`.

- [ ] **Step 10: Document the device-key surface**

In `docs/device-key-surface.md`, table "Reachable by a device key", add a row after the `POST /station/conflicts/status` row:

```md
| `GET /station/shifts/:id/progress` | shows the work screen's shift-wide total: returns two counts (every current owner of the shift's codes, and the calling device's share) and a timestamp for a shift of the caller's own tenant; it identifies no code, operator or other device |
```

Then: `pnpm --config.verifyDepsBeforeRun=false exec prettier --write docs/device-key-surface.md`

- [ ] **Step 11: API gates (sandbox disabled) and commit**

Run: `set -a; source /tmp/markiro-shift-progress.env; set +a; pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api typecheck && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api lint`
Expected: green.

```bash
git add apps/api/src/modules/shifts/station-shift-progress.service.ts apps/api/src/modules/shifts/station-shift-progress.controller.ts apps/api/src/modules/shifts/dto.ts apps/api/src/modules/shifts/shifts.module.ts apps/api/test/station-shift-progress.service.test.ts apps/api/test/station-shift-progress.e2e.test.ts apps/api/test/subscription-route-inventory.test.ts apps/api/test/authorization-metadata.test.ts docs/device-key-surface.md
git commit -m "feat(api): read a shift's accepted-unit total from a station"
```

---

### Task 4: Station CORS surface and release preflights

**Files:**

- Modify: `apps/api/src/cors.ts:73-94` (the `return (...)` expression of `isStationRequest`)
- Modify: `apps/api/test/cors-station-surface.test.ts` (`documentedStationSurface` and the "does not leak" list)
- Modify: `tools/station-release/verify-api-cors.mjs` (`STATION_PREFLIGHTS`)
- Modify: `tools/station-release/test/verify-api-cors.test.mjs` (`expected`)
- Modify: `tools/station-release/test/workflow.test.mjs` (`expectedPreflights`)

**Interfaces:**

- Consumes: Task 3's route path.
- Produces: the Station origin may call `GET /station/shifts/:id/progress` (needed by Task 6 at runtime).

- [ ] **Step 1: Add the failing surface entries**

In `apps/api/test/cors-station-surface.test.ts`, add to `documentedStationSurface` right after `["GET", "/station/inventories/inventory-1/progress"],`:

```ts
  ["GET", "/station/shifts/shift-1/progress"],
```

and to the "does not leak STATION_ORIGIN onto adjacent" list:

```ts
    ["POST", "/station/shifts/shift-1/progress"],
    ["GET", "/station/shifts/shift-1/progress/extra"],
    ["GET", "/station/shifts/shift-1"],
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/cors-station-surface.test.ts`
Expected: FAIL — `GET /station/shifts/shift-1/progress` does not receive `STATION_ORIGIN`.

- [ ] **Step 3: Allow the route in `cors.ts`**

In `isStationRequest`, add a line to the final `return (` expression after the inventories progress line:

```ts
    (method === "GET" && /^\/station\/shifts\/[^/]+\/progress$/.test(path)) ||
```

- [ ] **Step 4: Run the API CORS test**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/api exec vitest run test/cors-station-surface.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the release preflight in all three ordered lists**

`tools/station-release/verify-api-cors.mjs`, in `STATION_PREFLIGHTS` between the `/station/inventories/cors-probe/leave` entry and the `/station/shift-closures` entry:

```js
  {
    path: "/station/shifts/cors-probe/progress",
    method: "GET",
    headers: "content-type,x-api-key,x-station-capabilities",
  },
```

`tools/station-release/test/verify-api-cors.test.mjs`, in `expected` at the same position (after the `/station/inventories/cors-probe/leave` item, before `["/station/shift-closures", ...]`):

```js
  ["/station/shifts/cors-probe/progress", "GET", "content-type,x-api-key,x-station-capabilities"],
```

`tools/station-release/test/workflow.test.mjs`, in `expectedPreflights` at the same position:

```js
    ["/station/shifts/cors-probe/progress", "GET", "content-type,x-api-key,x-station-capabilities"],
```

- [ ] **Step 6: Run the release contracts**

Run: `pnpm --config.verifyDepsBeforeRun=false test:station-release:contract`
Expected: PASS (the cross-check maps `/shift-1/` to `/cors-probe/`, so the API surface and `STATION_PREFLIGHTS` match).

Run: `pnpm --config.verifyDepsBeforeRun=false exec prettier --check apps/api/src/cors.ts apps/api/test/cors-station-surface.test.ts tools/station-release/verify-api-cors.mjs tools/station-release/test/verify-api-cors.test.mjs tools/station-release/test/workflow.test.mjs`
Expected: no differences.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/cors.ts apps/api/test/cors-station-surface.test.ts tools/station-release/verify-api-cors.mjs tools/station-release/test/verify-api-cors.test.mjs tools/station-release/test/workflow.test.mjs
git commit -m "feat(api): open station shift progress to the station origin"
```

---

### Task 5: Station shift-progress model and persisted tracker

**Files:**

- Create: `apps/station/src/lib/shift-progress.ts`
- Test: create `apps/station/test/shift-progress.test.ts`

**Interfaces:**

- Produces:
  - `interface ShiftProgressSnapshot { shiftId: string; acceptedUnits: number; deviceAcceptedUnits: number; asOf: string; fetchedAt: string }`
  - `interface ShiftTotalView { scope: "all" | "terminal"; total: number; planned: number | null; planRatio: number | null; terminal: number | null; othersAsOf: string | null }`
  - `function shiftTotalView(input: { shiftId: string; snapshot: ShiftProgressSnapshot | null; local: number; plannedQty: number | null | undefined; nowMs: number }): ShiftTotalView`
  - `interface ShiftProgressTracker { watch(shiftId: string | null): void; current(): Promise<ShiftProgressSnapshot | null>; refresh(stillCurrent: () => boolean): Promise<void> }`
  - `function createShiftProgressTracker(deps: { exec: SqlExecutor; client: Partial<Pick<StationClient, "get">>; now: () => number }): ShiftProgressTracker`
  - constants `SHIFT_PROGRESS_META_KEY = "shift_progress"`, `SHIFT_PROGRESS_INTERVAL_MS = 15_000`, `SHIFT_PROGRESS_UNSUPPORTED_RETRY_MS = 600_000`, `SHIFT_PROGRESS_STALE_AFTER_MS = 120_000`

- [ ] **Step 1: Write the failing tests**

Create `apps/station/test/shift-progress.test.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { StationApiError } from "../src/lib/api-client.js";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import {
  SHIFT_PROGRESS_INTERVAL_MS,
  SHIFT_PROGRESS_STALE_AFTER_MS,
  SHIFT_PROGRESS_UNSUPPORTED_RETRY_MS,
  createShiftProgressTracker,
  shiftTotalView,
  type ShiftProgressSnapshot,
} from "../src/lib/shift-progress.js";

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

const answer = {
  shiftId: "s1",
  acceptedUnits: 1302,
  deviceAcceptedUnits: 302,
  asOf: "2026-09-25T09:00:00.000Z",
};
const NOW = Date.parse("2026-09-25T09:00:30.000Z");
const snapshot = (overrides: Partial<ShiftProgressSnapshot> = {}): ShiftProgressSnapshot => ({
  ...answer,
  fetchedAt: "2026-09-25T09:00:01.000Z",
  ...overrides,
});

describe("shiftTotalView", () => {
  it("shows this terminal's own count before the first server answer", () => {
    expect(
      shiftTotalView({ shiftId: "s1", snapshot: null, local: 302, plannedQty: 9580, nowMs: NOW }),
    ).toEqual({
      scope: "terminal",
      total: 302,
      planned: 9580,
      planRatio: 302 / 9580,
      terminal: null,
      othersAsOf: null,
    });
  });

  it("adds the other terminals' last known share to the live local count", () => {
    expect(
      shiftTotalView({
        shiftId: "s1",
        snapshot: snapshot(),
        local: 310,
        plannedQty: 9580,
        nowMs: NOW,
      }),
    ).toEqual({
      scope: "all",
      total: 1310,
      planned: 9580,
      planRatio: 1310 / 9580,
      terminal: 310,
      othersAsOf: null,
    });
  });

  it("hides the terminal share when no other terminal is counted", () => {
    expect(
      shiftTotalView({
        shiftId: "s1",
        snapshot: snapshot({ acceptedUnits: 302 }),
        local: 305,
        plannedQty: null,
        nowMs: NOW,
      }),
    ).toEqual({
      scope: "all",
      total: 305,
      planned: null,
      planRatio: null,
      terminal: null,
      othersAsOf: null,
    });
  });

  it("marks a stale answer that includes other terminals", () => {
    const fetchedAt = new Date(NOW - SHIFT_PROGRESS_STALE_AFTER_MS - 1).toISOString();
    expect(
      shiftTotalView({
        shiftId: "s1",
        snapshot: snapshot({ fetchedAt }),
        local: 302,
        plannedQty: 9580,
        nowMs: NOW,
      }).othersAsOf,
    ).toBe(fetchedAt);
  });

  it("ignores an answer for another shift and caps the bar at the plan", () => {
    expect(
      shiftTotalView({ shiftId: "s2", snapshot: snapshot(), local: 5, plannedQty: 4, nowMs: NOW }),
    ).toEqual({
      scope: "terminal",
      total: 5,
      planned: 4,
      planRatio: 1,
      terminal: null,
      othersAsOf: null,
    });
  });
});

describe("createShiftProgressTracker", () => {
  it("fetches the watched shift, persists the answer and reloads it after a restart", async () => {
    const exec = await migratedExec();
    const get = vi.fn().mockResolvedValue(answer);
    const tracker = createShiftProgressTracker({ exec, client: { get }, now: () => 1_000_000 });
    tracker.watch("s1");
    await tracker.refresh(() => true);
    expect(get).toHaveBeenCalledWith("/station/shifts/s1/progress");
    expect(await tracker.current()).toMatchObject(answer);

    const restarted = createShiftProgressTracker({ exec, client: {}, now: () => 1_000_000 });
    restarted.watch("s1");
    expect(await restarted.current()).toMatchObject(answer);
    restarted.watch("s2");
    expect(await restarted.current()).toBeNull();
  });

  it("asks at most once per interval and never without a watched shift", async () => {
    const exec = await migratedExec();
    const get = vi.fn().mockResolvedValue(answer);
    let clock = 1_000_000;
    const tracker = createShiftProgressTracker({ exec, client: { get }, now: () => clock });
    await tracker.refresh(() => true);
    expect(get).not.toHaveBeenCalled();
    tracker.watch("s1");
    await tracker.refresh(() => true);
    clock += SHIFT_PROGRESS_INTERVAL_MS - 1;
    await tracker.refresh(() => true);
    expect(get).toHaveBeenCalledTimes(1);
    clock += 1;
    await tracker.refresh(() => true);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("keeps the last answer through failures and bad answers, and suspends on 404", async () => {
    const exec = await migratedExec();
    let clock = 1_000_000;
    const get = vi
      .fn()
      .mockResolvedValueOnce(answer)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ ...answer, shiftId: "s2" })
      .mockRejectedValueOnce(new StationApiError(404, "Not Found"));
    const tracker = createShiftProgressTracker({ exec, client: { get }, now: () => clock });
    tracker.watch("s1");
    await tracker.refresh(() => true);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      clock += SHIFT_PROGRESS_INTERVAL_MS;
      await tracker.refresh(() => true).catch(() => undefined);
    }
    expect(await tracker.current()).toMatchObject(answer);
    clock += SHIFT_PROGRESS_INTERVAL_MS;
    await tracker.refresh(() => true);
    expect(get).toHaveBeenCalledTimes(5);
    clock += SHIFT_PROGRESS_UNSUPPORTED_RETRY_MS - 1;
    await tracker.refresh(() => true);
    expect(get).toHaveBeenCalledTimes(5);
  });

  it("drops an answer that arrives after the engine stopped wanting it", async () => {
    const exec = await migratedExec();
    const tracker = createShiftProgressTracker({
      exec,
      client: { get: vi.fn().mockResolvedValue(answer) },
      now: () => 1_000_000,
    });
    tracker.watch("s1");
    await tracker.refresh(() => false);
    expect(await tracker.current()).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station exec vitest run test/shift-progress.test.ts`
Expected: FAIL — cannot resolve `../src/lib/shift-progress.js`.

- [ ] **Step 3: Write the module**

Create `apps/station/src/lib/shift-progress.ts`:

```ts
import { z } from "zod";
import { StationApiError, type StationClient } from "./api-client.js";
import type { SqlExecutor } from "./mirror.js";

/**
 * The shift-wide total of the work screen's band (design 2026-09-25). The
 * server answers how many units the whole shift holds and how many of them
 * belong to this device; this terminal's own count is always the live local
 * one, so own scans and corrections move the number immediately and the
 * other terminals arrive with the next answer.
 */
export interface ShiftProgressSnapshot {
  shiftId: string;
  acceptedUnits: number;
  deviceAcceptedUnits: number;
  /** Server transaction time of the answer. */
  asOf: string;
  /** Wall-clock time this station received the answer. */
  fetchedAt: string;
}

export const SHIFT_PROGRESS_META_KEY = "shift_progress";
export const SHIFT_PROGRESS_INTERVAL_MS = 15_000;
export const SHIFT_PROGRESS_UNSUPPORTED_RETRY_MS = 10 * 60_000;
export const SHIFT_PROGRESS_STALE_AFTER_MS = 2 * 60_000;

const count = z.number().int().nonnegative();
const answerSchema = z
  .object({
    shiftId: z.string().min(1),
    acceptedUnits: count,
    deviceAcceptedUnits: count,
    asOf: z.string().min(1),
  })
  .refine((value) => value.deviceAcceptedUnits <= value.acceptedUnits);
const snapshotSchema = z
  .object({
    shiftId: z.string().min(1),
    acceptedUnits: count,
    deviceAcceptedUnits: count,
    asOf: z.string().min(1),
    fetchedAt: z.string().min(1),
  })
  .refine((value) => value.deviceAcceptedUnits <= value.acceptedUnits);

export interface ShiftTotalView {
  /** "terminal" until a server answer for this shift exists. */
  scope: "all" | "terminal";
  total: number;
  planned: number | null;
  /** 0..1 for the plan bar; null without a plan. */
  planRatio: number | null;
  /** This terminal's count, shown only when other terminals contributed. */
  terminal: number | null;
  /** `fetchedAt` of an answer older than two minutes that counts other terminals. */
  othersAsOf: string | null;
}

export function shiftTotalView(input: {
  shiftId: string;
  snapshot: ShiftProgressSnapshot | null;
  local: number;
  plannedQty: number | null | undefined;
  nowMs: number;
}): ShiftTotalView {
  const planned =
    input.plannedQty !== null && input.plannedQty !== undefined && input.plannedQty > 0
      ? input.plannedQty
      : null;
  const ratio = (value: number) => (planned === null ? null : Math.min(1, value / planned));
  const snapshot = input.snapshot?.shiftId === input.shiftId ? input.snapshot : null;
  if (!snapshot) {
    return {
      scope: "terminal",
      total: input.local,
      planned,
      planRatio: ratio(input.local),
      terminal: null,
      othersAsOf: null,
    };
  }
  const others = Math.max(0, snapshot.acceptedUnits - snapshot.deviceAcceptedUnits);
  const total = others + input.local;
  const fetchedMs = Date.parse(snapshot.fetchedAt);
  const stale =
    Number.isFinite(fetchedMs) && input.nowMs - fetchedMs > SHIFT_PROGRESS_STALE_AFTER_MS;
  return {
    scope: "all",
    total,
    planned,
    planRatio: ratio(total),
    terminal: others > 0 ? input.local : null,
    othersAsOf: others > 0 && stale ? snapshot.fetchedAt : null,
  };
}

export interface ShiftProgressTracker {
  /** Which shift's total to keep fresh; null when no work screen is open. */
  watch(shiftId: string | null): void;
  /** The last answer for the watched shift, loaded from `station_meta` once. */
  current(): Promise<ShiftProgressSnapshot | null>;
  /**
   * One throttled fetch. A 404 suspends further attempts for ten minutes;
   * any other failure propagates to the caller and keeps the last answer.
   */
  refresh(stillCurrent: () => boolean): Promise<void>;
}

export function createShiftProgressTracker(deps: {
  exec: SqlExecutor;
  client: Partial<Pick<StationClient, "get">>;
  now: () => number;
}): ShiftProgressTracker {
  let watchedShiftId: string | null = null;
  let snapshot: ShiftProgressSnapshot | null = null;
  let loaded = false;
  let lastAttemptAt: number | null = null;
  let suspendedUntil: number | null = null;

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    loaded = true;
    const rows = await deps.exec.all<{ value: string | null }>(
      "SELECT value FROM station_meta WHERE key = ?",
      [SHIFT_PROGRESS_META_KEY],
    );
    const raw = rows[0]?.value;
    if (!raw) return;
    try {
      const parsed = snapshotSchema.safeParse(JSON.parse(raw));
      if (parsed.success) snapshot = parsed.data;
    } catch {
      // A damaged cache is no cache: the next answer replaces it.
    }
  }

  return {
    watch(shiftId) {
      if (shiftId === watchedShiftId) return;
      watchedShiftId = shiftId;
      lastAttemptAt = null;
    },
    async current() {
      await ensureLoaded();
      return watchedShiftId !== null && snapshot?.shiftId === watchedShiftId ? snapshot : null;
    },
    async refresh(stillCurrent) {
      const shiftId = watchedShiftId;
      if (shiftId === null || deps.client.get === undefined) return;
      const at = deps.now();
      if (suspendedUntil !== null && at < suspendedUntil) return;
      if (lastAttemptAt !== null && at - lastAttemptAt < SHIFT_PROGRESS_INTERVAL_MS) return;
      lastAttemptAt = at;
      let raw: unknown;
      try {
        raw = await deps.client.get(`/station/shifts/${encodeURIComponent(shiftId)}/progress`);
      } catch (error) {
        if (error instanceof StationApiError && error.status === 404) {
          suspendedUntil = at + SHIFT_PROGRESS_UNSUPPORTED_RETRY_MS;
          return;
        }
        throw error;
      }
      const parsed = answerSchema.safeParse(raw);
      if (!parsed.success || parsed.data.shiftId !== shiftId) return;
      if (!stillCurrent() || watchedShiftId !== shiftId) return;
      const next: ShiftProgressSnapshot = { ...parsed.data, fetchedAt: new Date().toISOString() };
      await deps.exec.run(
        `INSERT INTO station_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [SHIFT_PROGRESS_META_KEY, JSON.stringify(next)],
      );
      loaded = true;
      snapshot = next;
    },
  };
}
```

Run `pnpm --config.verifyDepsBeforeRun=false exec prettier --write apps/station/src/lib/shift-progress.ts` to wrap the long `answerSchema` line.

- [ ] **Step 4: Run the tests**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station exec vitest run test/shift-progress.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/station/src/lib/shift-progress.ts apps/station/test/shift-progress.test.ts
git commit -m "feat(station): track a watched shift's server total"
```

---

### Task 6: Watched-shift progress in the sync engine

**Files:**

- Modify: `apps/station/src/lib/sync.ts` (`SyncState` ~line 148, `SyncEngineDeps` ~line 233, `SyncEngine` ~line 246, `createSyncEngine` start ~line 1086, `publishState` ~line 1352, post-drain steps ~line 2130-2180, returned object ~line 2253)
- Modify: `apps/station/src/lib/use-sync-engine.ts`
- Test: `apps/station/test/sync.test.ts`, `apps/station/test/use-sync-engine.test.tsx`

**Interfaces:**

- Consumes: Task 5's `createShiftProgressTracker`, `ShiftProgressSnapshot`.
- Produces:
  - `SyncState.shiftProgress: ShiftProgressSnapshot | null`
  - `SyncEngine.watchShiftProgress(shiftId: string | null): void` (does not nudge)
  - `SyncEngineDeps.client: Pick<StationClient, "post"> & Partial<Pick<StationClient, "get">>`
  - `UseSyncEngineResult.watchShiftProgress: (shiftId: string | null) => void` (stable; nudges)

- [ ] **Step 1: Write the failing engine test**

Append to the main `describe` of `apps/station/test/sync.test.ts` (add `SHIFT_PROGRESS_INTERVAL_MS` to a new import from `../src/lib/shift-progress.js`):

```ts
it("publishes the watched shift's progress and never retries a failed fetch", async () => {
  const exec = await migratedExec();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const post = vi.fn();
  const get = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({
    shiftId: "s1",
    acceptedUnits: 12,
    deviceAcceptedUnits: 2,
    asOf: "2026-09-25T09:00:00.000Z",
  });
  let clock = 1_000_000;
  const states: Array<{ stuck: boolean; progress: unknown }> = [];
  const engine = createSyncEngine({
    exec,
    client: { post, get },
    machineId: "m1",
    now: () => clock,
    onState: (state) => states.push({ stuck: state.stuck, progress: state.shiftProgress }),
  });
  engine.watchShiftProgress("s1");
  engine.nudge();
  await engine.idle();
  expect(get).toHaveBeenCalledTimes(1);
  expect(states.at(-1)).toEqual({ stuck: false, progress: null });

  clock += SHIFT_PROGRESS_INTERVAL_MS;
  engine.nudge();
  await engine.idle();
  expect(get).toHaveBeenCalledTimes(2);
  expect(states.at(-1)?.progress).toMatchObject({
    shiftId: "s1",
    acceptedUnits: 12,
    deviceAcceptedUnits: 2,
  });

  engine.watchShiftProgress(null);
  engine.nudge();
  await engine.idle();
  expect(states.at(-1)?.progress).toBeNull();
  engine.stop();
});

it("takes the credential rejection path when the progress fetch is refused", async () => {
  const exec = await migratedExec();
  const onCredentialRejected = vi.fn();
  const engine = createSyncEngine({
    exec,
    client: {
      post: vi.fn(),
      get: vi
        .fn()
        .mockRejectedValue(new StationApiError(401, "rejected", "STATION_CREDENTIAL_REVOKED")),
    },
    machineId: "machine-1",
    onState: () => {},
    onCredentialRejected,
  });
  engine.watchShiftProgress("s1");
  engine.nudge();
  await engine.idle();
  expect(onCredentialRejected).toHaveBeenCalledOnce();
  expect(onCredentialRejected).toHaveBeenCalledWith(
    expect.objectContaining({ machineId: "machine-1" }),
  );
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station exec vitest run test/sync.test.ts -t "progress"`
Expected: FAIL — `engine.watchShiftProgress is not a function`.

- [ ] **Step 3: Wire the tracker into `sync.ts`**

1. Import next to the other `./` imports:

```ts
import { createShiftProgressTracker, type ShiftProgressSnapshot } from "./shift-progress.js";
```

2. Add to `SyncState` after `serialsLeft: number;`:

```ts
/**
 * The last server answer for the shift the work screen watches (null when
 * none is watched or none arrived yet). See `shift-progress.ts`.
 */
shiftProgress: ShiftProgressSnapshot | null;
```

3. Change `SyncEngineDeps.client`:

```ts
client: Pick<StationClient, "post"> & Partial<Pick<StationClient, "get">>;
```

4. Add to `SyncEngine` after `reconcileNow(): Promise<void>;`:

```ts
  /** Which shift's total to fetch after drains; null stops. Does not nudge. */
  watchShiftProgress(shiftId: string | null): void;
```

5. In `createSyncEngine`, right after `const productLabelOwnership = credentialGenerationOwnership(credentialGeneration);`:

```ts
const shiftProgress = createShiftProgressTracker({
  exec: deps.exec,
  client: deps.client,
  now,
});
```

6. In `publishState`, replace the final `deps.onState({ ... })` call with:

```ts
const progress = await shiftProgress.current();
deps.onState({
  pending,
  lastSuccessAt,
  stuck: stuck || evidenceNeedsRecovery,
  conflicts,
  serialsLeft,
  shiftProgress: progress,
});
```

7. In `drain()`, after the box-reconciliation `if (...) { try { ... } catch (err) { ... } }` block and before the outer `} catch (err) {` of the drain, add a last post-drain step:

```ts
if (!pauseInvalidated() && !credentialGeneration.sealed && retryTimer === null) {
  try {
    // Display-only: a failure keeps the last answer and never schedules
    // a retry or marks the queue stuck.
    await shiftProgress.refresh(() => !pauseInvalidated() && !credentialGeneration.sealed);
  } catch (err) {
    if (isStationCredentialRejection(err)) await rejectCredential();
    else console.warn("station: shift progress unavailable");
  }
}
```

8. In the returned engine object, add after `reconcileNow`:

```ts
    watchShiftProgress(shiftId) {
      shiftProgress.watch(shiftId);
    },
```

- [ ] **Step 4: Expose it from `use-sync-engine.ts`**

1. `UseSyncEngineDeps.client`:

```ts
client: (Pick<StationClient, "post"> & Partial<Pick<StationClient, "get">>) | null;
```

2. `UseSyncEngineResult` gains:

```ts
  /** Keep this shift's total fresh (the work screen's band); null stops. Stable identity. */
  watchShiftProgress: (shiftId: string | null) => void;
```

3. Initial state literal gains `shiftProgress: null,`.

4. Next to `pausedRef`: `const watchedShiftRef = useRef<string | null>(null);`

5. In the engine effect, right after `engineRef.current = engine;` and before `if (pausedRef.current) engine.pause();`:

```ts
if (watchedShiftRef.current !== null) engine.watchShiftProgress(watchedShiftRef.current);
```

6. Add the callback and return it:

```ts
const watchShiftProgress = useCallback((shiftId: string | null) => {
  watchedShiftRef.current = shiftId;
  const engine = engineRef.current;
  if (!engine) return;
  engine.watchShiftProgress(shiftId);
  if (!pausedRef.current) engine.nudge();
}, []);
```

```ts
return {
  state,
  nudge,
  pause,
  pauseAndWaitForIdle,
  resume,
  requestFullShiftAudit,
  reconcileNow,
  watchShiftProgress,
};
```

- [ ] **Step 5: Add the hook test**

Append to `apps/station/test/use-sync-engine.test.tsx` inside `describe("useSyncEngine", ...)`:

```ts
it("fetches a watched shift and keeps watching it across an engine rebuild", async () => {
  const exec = await migratedExec();
  const post = vi.fn().mockResolvedValue({});
  const first = {
    post,
    get: vi.fn().mockResolvedValue({
      shiftId: "s1",
      acceptedUnits: 3,
      deviceAcceptedUnits: 1,
      asOf: "2026-09-25T09:00:00.000Z",
    }),
  };
  const { result, rerender } = renderHook((deps: UseSyncEngineDeps) => useSyncEngine(deps), {
    initialProps: { exec, client: first, machineId: "m1" },
  });
  act(() => result.current.watchShiftProgress("s1"));
  await waitFor(() =>
    expect(result.current.state.shiftProgress).toMatchObject({ shiftId: "s1", acceptedUnits: 3 }),
  );
  const second = {
    post,
    get: vi.fn().mockResolvedValue({
      shiftId: "s1",
      acceptedUnits: 4,
      deviceAcceptedUnits: 1,
      asOf: "2026-09-25T09:01:00.000Z",
    }),
  };
  rerender({ exec, client: second, machineId: "m1" });
  await waitFor(() => expect(second.get).toHaveBeenCalledWith("/station/shifts/s1/progress"));
});
```

- [ ] **Step 6: Run the station sync suites**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station exec vitest run test/sync.test.ts test/use-sync-engine.test.tsx test/box-reconciliation.test.ts test/product-labels-sync.test.ts test/sync-pallets.test.ts`
Expected: PASS (existing `{ post }` clients still type-check because `get` is optional).

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station typecheck`
Expected: green. If `App.tsx` or another consumer builds a `SyncState` literal, add `shiftProgress: null` there.

- [ ] **Step 7: Commit**

```bash
git add apps/station/src/lib/sync.ts apps/station/src/lib/use-sync-engine.ts apps/station/test/sync.test.ts apps/station/test/use-sync-engine.test.tsx
git commit -m "feat(station): fetch the watched shift's total after each drain"
```

---

### Task 7: Durable shift counts from the local journal

**Files:**

- Modify: `apps/station/src/lib/journal.ts` (after `findLatestAcceptedOperation`)
- Create: `apps/station/src/lib/use-shift-journal-counts.ts`
- Test: `apps/station/test/journal.test.ts`, create `apps/station/test/use-shift-journal-counts.test.tsx`

**Interfaces:**

- Produces:
  - `interface ShiftJournalCounts { accepted: number; errors: number; duplicates: number }`
  - `function readShiftJournalCounts(exec: SqlExecutor, shiftId: string): Promise<ShiftJournalCounts>`
  - `function useShiftJournalCounts(exec: SqlExecutor, shiftId: string): { counts: ShiftJournalCounts; refresh: () => void }` (`refresh` stable per `exec`/`shiftId`, coalesces overlapping reads)

- [ ] **Step 1: Write the failing journal test**

Add `readShiftJournalCounts` to the `../src/lib/journal.js` import of `apps/station/test/journal.test.ts` and append:

```ts
describe("readShiftJournalCounts", () => {
  it("counts accepted units, duplicates and other rejections of one shift only", async () => {
    const exec = makeExec();
    const verdicts: Array<[string, string]> = [
      ["s1", "ok"],
      ["s1", "ok"],
      ["s1", "duplicate"],
      ["s1", "invalid"],
      ["s1", "wrong_gtin"],
      ["s2", "duplicate"],
    ];
    for (const [shiftId, verdict] of verdicts) {
      await exec.run(
        `INSERT INTO scan_events_mirror (shift_id, terminal_id, raw, verdict, scanned_at)
         VALUES (?, ?, ?, ?, ?)`,
        [shiftId, "t1", "RAW", verdict, "2026-09-25T09:00:00.000Z"],
      );
    }
    for (const [codeHash, shiftId] of [
      ["a".repeat(64), "s1"],
      ["b".repeat(64), "s1"],
      ["c".repeat(64), "s2"],
    ] as const) {
      await exec.run(
        `INSERT INTO codes_mirror (code_hash, shift_id, gtin14, serial, scanned_at)
         VALUES (?, ?, ?, ?, ?)`,
        [codeHash, shiftId, "04600000000015", codeHash.slice(0, 4), "2026-09-25T09:00:00.000Z"],
      );
    }
    expect(await readShiftJournalCounts(exec, "s1")).toEqual({
      accepted: 2,
      errors: 2,
      duplicates: 1,
    });
    expect(await readShiftJournalCounts(exec, "s3")).toEqual({
      accepted: 0,
      errors: 0,
      duplicates: 0,
    });
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station exec vitest run test/journal.test.ts -t "readShiftJournalCounts"`
Expected: FAIL — `readShiftJournalCounts` is not exported.

- [ ] **Step 3: Implement it in `journal.ts`**

```ts
/** A shift's durable counts on THIS device: what the work screen's band and journal head show. */
export interface ShiftJournalCounts {
  /** Units the shift holds here: the same view shift close and the plan prompt count. */
  accepted: number;
  /** Journal rows rejected for any reason other than a duplicate. */
  errors: number;
  duplicates: number;
}

export async function readShiftJournalCounts(
  exec: SqlExecutor,
  shiftId: string,
): Promise<ShiftJournalCounts> {
  const [verdicts, processed] = await Promise.all([
    exec.all<{ duplicates: number | null; errors: number | null }>(
      `SELECT SUM(CASE WHEN verdict = 'duplicate' THEN 1 ELSE 0 END) AS duplicates,
              SUM(CASE WHEN verdict NOT IN ('ok', 'duplicate') THEN 1 ELSE 0 END) AS errors
         FROM scan_events_mirror
        WHERE shift_id = ?`,
      [shiftId],
    ),
    exec.all<{ accepted: number }>(
      "SELECT COUNT(*) AS accepted FROM station_processed_codes WHERE shift_id = ?",
      [shiftId],
    ),
  ]);
  return {
    accepted: processed[0]?.accepted ?? 0,
    errors: verdicts[0]?.errors ?? 0,
    duplicates: verdicts[0]?.duplicates ?? 0,
  };
}
```

- [ ] **Step 4: Run the journal test**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station exec vitest run test/journal.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing hook test**

Create `apps/station/test/use-shift-journal-counts.test.tsx`:

```tsx
import { DatabaseSync } from "node:sqlite";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { STATION_MIGRATIONS } from "@markiro/db/station-sqlite";
import type { SqlExecutor } from "../src/lib/mirror.js";
import { useShiftJournalCounts } from "../src/lib/use-shift-journal-counts.js";

function makeExec(): SqlExecutor {
  const db = new DatabaseSync(":memory:");
  for (const statement of STATION_MIGRATIONS) {
    try {
      db.exec(statement);
    } catch (error) {
      if (!/duplicate column name/i.test(String(error))) throw error;
    }
  }
  return {
    run: async (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    all: async <T,>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
  };
}

describe("useShiftJournalCounts", () => {
  it("reads the shift's counts on mount and again on refresh", async () => {
    const exec = makeExec();
    const { result } = renderHook(() => useShiftJournalCounts(exec, "s1"));
    await waitFor(() =>
      expect(result.current.counts).toEqual({ accepted: 0, errors: 0, duplicates: 0 }),
    );
    await exec.run(
      `INSERT INTO scan_events_mirror (shift_id, terminal_id, raw, verdict, scanned_at)
       VALUES ('s1', 't1', 'RAW', 'duplicate', '2026-09-25T09:00:00.000Z')`,
    );
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.counts.duplicates).toBe(1));
  });
});
```

- [ ] **Step 6: Run it and see it fail**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station exec vitest run test/use-shift-journal-counts.test.tsx`
Expected: FAIL — cannot resolve the hook module.

- [ ] **Step 7: Write the hook**

Create `apps/station/src/lib/use-shift-journal-counts.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { readShiftJournalCounts, type ShiftJournalCounts } from "./journal.js";
import type { SqlExecutor } from "./mirror.js";

interface ReadState {
  mounted: boolean;
  active: boolean;
  trailing: boolean;
}

const EMPTY: ShiftJournalCounts = { accepted: 0, errors: 0, duplicates: 0 };

/**
 * The shift's durable counts, re-read on demand. Overlapping requests
 * coalesce into one trailing read -- the same discipline the work screen's
 * recent-operations read uses -- so a burst of scans never queues a read per
 * scan and an older snapshot is never published after a newer request.
 */
export function useShiftJournalCounts(
  exec: SqlExecutor,
  shiftId: string,
): { counts: ShiftJournalCounts; refresh: () => void } {
  const [counts, setCounts] = useState<ShiftJournalCounts>(EMPTY);
  const readState = useRef<ReadState>({ mounted: false, active: false, trailing: false });

  const refresh = useCallback((): void => {
    const state = readState.current;
    if (!state.mounted) return;
    if (state.active) {
      state.trailing = true;
      return;
    }
    state.active = true;
    void readShiftJournalCounts(exec, shiftId)
      .then((next) => {
        if (readState.current === state && state.mounted && !state.trailing) setCounts(next);
      })
      .catch((error: unknown) => {
        if (readState.current === state && state.mounted) {
          console.error("station: failed to read shift journal counts", error);
        }
      })
      .finally(() => {
        if (readState.current !== state || !state.mounted) return;
        state.active = false;
        if (state.trailing) {
          state.trailing = false;
          refresh();
        }
      });
  }, [exec, shiftId]);

  useEffect(() => {
    const state: ReadState = { mounted: true, active: false, trailing: false };
    readState.current = state;
    refresh();
    return () => {
      state.mounted = false;
      state.trailing = false;
    };
  }, [refresh]);

  return { counts, refresh };
}
```

- [ ] **Step 8: Run the tests and commit**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station exec vitest run test/use-shift-journal-counts.test.tsx test/journal.test.ts`
Expected: PASS.

```bash
git add apps/station/src/lib/journal.ts apps/station/src/lib/use-shift-journal-counts.ts apps/station/test/journal.test.ts apps/station/test/use-shift-journal-counts.test.tsx
git commit -m "feat(station): read durable shift counts from the local journal"
```

---

### Task 8: `ShiftBand` component

**Files:**

- Create: `apps/station/src/ui/work/ShiftBand.tsx`
- Modify: `apps/station/src/ui/work/ScanResultInstrument.tsx` (move `productMonogram` out, import it back)
- Modify: `apps/station/src/ui/ShiftCard.tsx:8` (import `productMonogram` from `./work/ShiftBand.js`)
- Test: create `apps/station/test/shift-band.test.tsx`

**Interfaces:**

- Consumes: Task 5's `ShiftTotalView`.
- Produces:
  - `interface ShiftBandLabels { gtin: string; counterpartyPrefix: string; totalAll: string; totalTerminal: string; planPercent: (percent: string) => string; terminalShare: (value: string) => string; othersAsOf: (time: string) => string }`
  - `function ShiftBand(props: { productName: string; counterpartyName: string | null; gtin?: string | null | undefined; exec?: SqlExecutor | undefined; productId?: string | undefined; image?: StationProductImageDescriptor | null | undefined; refreshKey?: number; total: ShiftTotalView; locale: string; labels: ShiftBandLabels })`
  - `function productMonogram(name: string): string` (moved here)
  - DOM contract: `section.work-shift-band[aria-label=productName][data-accent]`, `h2`, `.work-shift-band__chip`, `.work-shift-band__total[data-scope]`, `[data-testid="shift-total"]`, `[role="progressbar"]` only with a plan, `.work-shift-band__meta`.

- [ ] **Step 1: Write the failing tests**

Create `apps/station/test/shift-band.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { hueFromGtin, primeAccentHue } from "../src/lib/product-accent.js";
import type { SqlExecutor } from "../src/lib/mirror.js";
import type { ShiftTotalView } from "../src/lib/shift-progress.js";
import { ShiftBand, productMonogram } from "../src/ui/work/ShiftBand.js";

const labels = {
  gtin: "GTIN",
  counterpartyPrefix: "for:",
  totalAll: "In shift · all terminals",
  totalTerminal: "In shift · this terminal",
  planPercent: (percent: string) => `${percent} of plan`,
  terminalShare: (value: string) => `this terminal ${value}`,
  othersAsOf: (time: string) => `other terminals as of ${time}`,
};

const terminalOnly: ShiftTotalView = {
  scope: "terminal",
  total: 302,
  planned: null,
  planRatio: null,
  terminal: null,
  othersAsOf: null,
};

describe("ShiftBand", () => {
  it("names the product, prints GTIN and customer chips and the local total", () => {
    const { container } = render(
      <ShiftBand
        productName="Widget"
        counterpartyName="Plant North"
        gtin="04607000000042"
        total={terminalOnly}
        locale="en-US"
        labels={labels}
      />,
    );
    expect(screen.getByRole("heading", { name: "Widget" })).toBeDefined();
    const chips = [...container.querySelectorAll(".work-shift-band__chip")].map(
      (chip) => chip.textContent,
    );
    expect(chips).toEqual(["GTIN 04607000000042", "for: Plant North"]);
    expect(screen.getByText("In shift · this terminal")).toBeDefined();
    expect(screen.getByTestId("shift-total").textContent).toBe("302");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("shows every terminal against the plan with this terminal's share", () => {
    render(
      <ShiftBand
        productName="Widget"
        counterpartyName={null}
        total={{
          scope: "all",
          total: 1302,
          planned: 9580,
          planRatio: 1302 / 9580,
          terminal: 302,
          othersAsOf: null,
        }}
        locale="en-US"
        labels={labels}
      />,
    );
    expect(screen.getByText("In shift · all terminals")).toBeDefined();
    expect(screen.getByTestId("shift-total").textContent).toBe("1,302");
    expect(screen.getByText("/ 9,580")).toBeDefined();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("1302");
    expect(bar.getAttribute("aria-valuemax")).toBe("9580");
    expect(screen.getByText("14% of plan · this terminal 302")).toBeDefined();
  });

  it("replaces the share with the age of a stale answer", () => {
    const { container } = render(
      <ShiftBand
        productName="Widget"
        counterpartyName={null}
        total={{
          scope: "all",
          total: 1302,
          planned: null,
          planRatio: null,
          terminal: 302,
          othersAsOf: "2026-09-25T08:55:00.000Z",
        }}
        locale="en-US"
        labels={labels}
      />,
    );
    expect(container.querySelector(".work-shift-band__meta")?.textContent).toMatch(
      /^other terminals as of /,
    );
  });

  it("seeds the accent from the GTIN and falls back to a monogram without a photo", () => {
    const { container, rerender } = render(
      <ShiftBand
        productName="Ягодный морс"
        counterpartyName={null}
        total={terminalOnly}
        locale="ru-RU"
        labels={labels}
      />,
    );
    const band = () => container.querySelector<HTMLElement>(".work-shift-band");
    expect(band()?.getAttribute("data-accent")).toBeNull();
    expect(container.querySelector(".work-shift-band__monogram")?.textContent).toBe("Я");
    rerender(
      <ShiftBand
        productName="Ягодный морс"
        counterpartyName={null}
        gtin="04607000000042"
        total={terminalOnly}
        locale="ru-RU"
        labels={labels}
      />,
    );
    expect(band()?.getAttribute("data-accent")).toBe("true");
    expect(band()?.style.getPropertyValue("--product-hue")).toBe(
      String(hueFromGtin("04607000000042")),
    );
  });

  it("never reuses one image's extracted hue for another image", () => {
    const exec: SqlExecutor = { run: async () => undefined, all: async () => [] };
    const imageOf = (checksum: string) => ({
      checksum,
      contentType: "image/webp" as const,
      byteSize: 1,
      width: 1,
      height: 1,
    });
    primeAccentHue("band-accent-a", 200);
    const props = {
      productName: "Widget",
      counterpartyName: null,
      exec,
      productId: "p1",
      total: terminalOnly,
      locale: "en-US",
      labels,
    };
    const { container, rerender } = render(
      <ShiftBand {...props} image={imageOf("band-accent-a")} />,
    );
    const band = () => container.querySelector<HTMLElement>(".work-shift-band");
    expect(band()?.style.getPropertyValue("--product-hue")).toBe("200");
    rerender(<ShiftBand {...props} image={imageOf("band-accent-b")} />);
    expect(band()?.getAttribute("data-accent")).toBeNull();
  });

  it("derives a first-letter monogram", () => {
    expect(productMonogram("«Балтика 7»")).toBe("Б");
    expect(productMonogram("  ")).toBe("?");
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station exec vitest run test/shift-band.test.tsx`
Expected: FAIL — cannot resolve `ShiftBand.js`.

- [ ] **Step 3: Write `ShiftBand.tsx`**

Create `apps/station/src/ui/work/ShiftBand.tsx`:

```tsx
import type { CSSProperties } from "react";
import type { SqlExecutor, StationProductImageDescriptor } from "../../lib/mirror.js";
import { useProductAccentHue } from "../../lib/product-accent.js";
import type { ShiftTotalView } from "../../lib/shift-progress.js";
import { ProductImage } from "../ProductImage.js";

export interface ShiftBandLabels {
  gtin: string;
  counterpartyPrefix: string;
  totalAll: string;
  totalTerminal: string;
  planPercent: (percent: string) => string;
  terminalShare: (value: string) => string;
  othersAsOf: (time: string) => string;
}

export interface ShiftBandProps {
  productName: string;
  counterpartyName: string | null;
  /** Expected GTIN-14 of the shift's product; prints as a chip and seeds the fallback accent hue. */
  gtin?: string | null | undefined;
  exec?: SqlExecutor | undefined;
  productId?: string | undefined;
  image?: StationProductImageDescriptor | null | undefined;
  refreshKey?: number;
  total: ShiftTotalView;
  locale: string;
  labels: ShiftBandLabels;
}

/** «Балтика 7…» → «Б». The photo slot's stand-in when the product has no photo. */
export function productMonogram(name: string): string {
  const first = [...name.normalize("NFC")].find((character) => /[\p{L}\p{N}]/u.test(character));
  return first ? ([...first.toUpperCase()][0] ?? "?") : "?";
}

/**
 * What the shift makes and how much of it is made (design 2026-09-25): the
 * product identity on its tinted gradient, and the shift total across
 * terminals against the plan. It spans both work columns.
 */
export function ShiftBand({
  productName,
  counterpartyName,
  gtin,
  exec,
  productId,
  image,
  refreshKey,
  total,
  locale,
  labels,
}: ShiftBandProps) {
  const hue = useProductAccentHue({ exec, productId, image, gtin, refreshKey });
  const style = hue === null ? undefined : ({ "--product-hue": String(hue) } as CSSProperties);
  const number = new Intl.NumberFormat(locale);
  const scopeLabel = total.scope === "all" ? labels.totalAll : labels.totalTerminal;
  const percent =
    total.planned === null
      ? null
      : new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(
          total.total / total.planned,
        );
  const share =
    total.othersAsOf !== null
      ? labels.othersAsOf(
          new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(
            new Date(total.othersAsOf),
          ),
        )
      : total.terminal !== null
        ? labels.terminalShare(number.format(total.terminal))
        : null;
  const meta = [percent === null ? null : labels.planPercent(percent), share]
    .filter((part): part is string => part !== null)
    .join(" · ");
  return (
    <section
      className="work-shift-band"
      aria-label={productName}
      data-accent={hue === null ? undefined : "true"}
      style={style}
    >
      {productId && image !== null ? (
        <ProductImage
          exec={exec}
          productId={productId}
          productName={productName}
          image={image}
          refreshKey={refreshKey}
          className="work-shift-band__image"
        />
      ) : (
        <span aria-hidden="true" className="work-shift-band__image work-shift-band__monogram">
          {productMonogram(productName)}
        </span>
      )}
      <div className="work-shift-band__copy">
        <h2 title={productName}>{productName}</h2>
        <div className="work-shift-band__chips">
          {gtin ? (
            <span className="work-shift-band__chip work-shift-band__chip--mono">
              {`${labels.gtin} ${gtin}`}
            </span>
          ) : null}
          {counterpartyName ? (
            <span className="work-shift-band__chip" title={counterpartyName}>
              {`${labels.counterpartyPrefix} ${counterpartyName}`}
            </span>
          ) : null}
        </div>
      </div>
      <div
        className="work-shift-band__total"
        role="group"
        aria-label={scopeLabel}
        data-scope={total.scope}
      >
        <p className="work-shift-band__label">{scopeLabel}</p>
        <p className="work-shift-band__value">
          <strong data-testid="shift-total">{number.format(total.total)}</strong>
          {total.planned === null ? null : <span>{`/ ${number.format(total.planned)}`}</span>}
        </p>
        {total.planned === null || total.planRatio === null ? null : (
          <div
            className="work-shift-band__bar"
            role="progressbar"
            aria-label={scopeLabel}
            aria-valuemin={0}
            aria-valuemax={total.planned}
            aria-valuenow={Math.min(total.total, total.planned)}
            aria-valuetext={`${number.format(total.total)} / ${number.format(total.planned)}`}
          >
            <span style={{ width: `${Math.round(total.planRatio * 1000) / 10}%` }} />
          </div>
        )}
        {meta ? <p className="work-shift-band__meta">{meta}</p> : null}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Move `productMonogram`**

In `apps/station/src/ui/work/ScanResultInstrument.tsx`, delete the `productMonogram` function and its doc comment and add `import { productMonogram } from "./ShiftBand.js";` (the identity half still uses it until Task 10). In `apps/station/src/ui/ShiftCard.tsx` change the import to `import { productMonogram } from "./work/ShiftBand.js";`. In `apps/station/test/work-instruments.test.tsx` change line 7 to `import { ScanResultInstrument } from "../src/ui/work/ScanResultInstrument.js";`, add `import { productMonogram } from "../src/ui/work/ShiftBand.js";`.

- [ ] **Step 5: Run the tests and commit**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station exec vitest run test/shift-band.test.tsx test/work-instruments.test.tsx test/shift-card.test.tsx`
Expected: PASS.

```bash
git add apps/station/src/ui/work/ShiftBand.tsx apps/station/src/ui/work/ScanResultInstrument.tsx apps/station/src/ui/ShiftCard.tsx apps/station/test/shift-band.test.tsx apps/station/test/work-instruments.test.tsx
git commit -m "feat(station): add the shift band with product identity and shift total"
```

---

### Task 9: One-row box head and compact pallet strip

**Files:**

- Modify: `apps/station/src/ui/work/BoxFillInstrument.tsx` (render, ~lines 87-178)
- Modify: `apps/station/src/components/PalletStrip.tsx` (render, ~lines 40-104)
- Modify: `apps/station/src/i18n/ru.json`, `apps/station/src/i18n/en.json` (`pallet.lastBoxShort` added, `pallet.lastBox` removed)
- Test: `apps/station/test/work-instruments.test.tsx`, `apps/station/test/pallet-ui.test.tsx`

**Interfaces:**

- Props of both components are unchanged. DOM contract changes: `.work-box-fill__head` wraps the `h2` and `.work-box-fill__readout`; `PalletStrip` renders `h2` = `pallet.title`, `.pallet-strip__meta` with the remaining text in its own `span` and `.pallet-strip__last` with `pallet.lastBoxShort`.

- [ ] **Step 1: Write the failing tests**

Append to `describe("work instruments", ...)` in `apps/station/test/work-instruments.test.tsx`:

```tsx
it("puts the title, the count and the last serial in one head row", () => {
  const { container } = render(
    <BoxFillInstrument
      box={{ boxId: "b1", itemCount: 2 }}
      ordinal={416}
      acceptedToken={null}
      capacity={20}
      canUndo={false}
      labels={{ ...boxLabels, number: "Box no. 416" }}
      lastAccepted={{ serial: "5A)5>JE" }}
      verdictLabels={{ ok: "Accepted", waiting: "Waiting for a scan" }}
      onClose={vi.fn()}
      onUndo={vi.fn()}
      onClear={vi.fn()}
    />,
  );
  const head = container.querySelector(".work-box-fill__head");
  expect(head?.querySelector("h2")?.textContent).toBe("Box no. 416");
  expect(head?.querySelector('[data-testid="box-progress"]')?.textContent).toBe("2 / 20");
  expect(head?.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe(
    "Accepted: 5A)5>JE",
  );
  expect(container.querySelector(".work-box-fill__head + .work-box-fill__grid")).not.toBeNull();
});
```

Append to `describe("PalletStrip", ...)` in `apps/station/test/pallet-ui.test.tsx`:

```tsx
it("fits the pallet into one row: title, count, bar, remaining and last box", () => {
  const { container } = render(
    <PalletStrip
      boxCount={15}
      capacity={66}
      serials="available"
      lastBoxSscc="004601234560619998"
      onShowContents={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByRole("heading", { name: i18n.t("pallet.title") })).toBeDefined();
  const meta = container.querySelector(".pallet-strip__meta");
  expect(meta?.textContent).toBe(
    `${i18n.t("pallet.remaining", { count: 51 })} · ${i18n.t("pallet.lastBoxShort")} …619998`,
  );
  const actions = container.querySelector(".pallet-strip__actions");
  expect(actions?.querySelectorAll("button")).toHaveLength(2);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station exec vitest run test/work-instruments.test.tsx test/pallet-ui.test.tsx -t "one head row|one row"`
Expected: FAIL (no `.work-box-fill__head`; missing key `pallet.lastBoxShort` throws).

- [ ] **Step 3: Restructure `BoxFillInstrument`**

Replace the section's children (from `<h2 id="work-box-fill-title">` to the closing of the `box ? (...) : (...)` expression) with:

```tsx
<div className="work-box-fill__head">
  <h2 id="work-box-fill-title">{box && ordinal !== null ? labels.number : labels.title}</h2>
  {box ? (
    <div className="work-box-fill__readout">
      <strong data-testid="box-progress">
        {usableCapacity ? `${box.itemCount} / ${usableCapacity}` : box.itemCount}
      </strong>
      <span>{usableCapacity ? labels.count : labels.capacityUnknown}</span>
      {verdictLabels ? (
        <div
          className="work-box-fill__last"
          role="status"
          data-tone={lastAccepted ? "ok" : "neutral"}
          aria-label={lastAccepted ? `${verdictLabels.ok}: ${lastAccepted.serial}` : undefined}
        >
          {lastAccepted ? (
            <>
              <span aria-hidden="true">✓</span>
              <code data-semantic="accepted-serial">{lastAccepted.serial}</code>
            </>
          ) : (
            <span>{verdictLabels.waiting}</span>
          )}
        </div>
      ) : null}
    </div>
  ) : null}
</div>;
{
  box ? (
    <>
      {usableCapacity ? (
        <div
          className="work-box-fill__grid"
          data-dense={cells.length > 20}
          data-grouped={grouped}
          data-large={large ? "true" : undefined}
          style={{
            gridTemplateRows: `repeat(${rowCount}, minmax(0, 1fr))`,
            ...(large ? { gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` } : {}),
          }}
          role="progressbar"
          aria-label={labels.title}
          aria-valuemin={0}
          aria-valuemax={usableCapacity}
          aria-valuenow={fill}
          aria-valuetext={`${box.itemCount} / ${usableCapacity}`}
        >
          {cells.map((cell) => {
            const isLatest =
              acceptedToken !== null && fill > 0 && fill >= cell.from && fill <= cell.to;
            return (
              <span
                key={`${cell.from}:${isLatest ? acceptedToken : "stable"}`}
                className="work-box-fill__cell"
                data-state={cell.state}
                data-latest={isLatest ? "true" : undefined}
                aria-label={cell.from === cell.to ? `${cell.from}` : `${cell.from}–${cell.to}`}
                aria-hidden="true"
              >
                {large ? cell.from : null}
              </span>
            );
          })}
        </div>
      ) : null}
      {grouped ? <p className="work-box-fill__grouped">{labels.grouped}</p> : null}
      <div className="work-box-fill__actions">
        <Button size="floor" variant="secondary" disabled={closeDisabled} onClick={onClose}>
          {labels.close}
        </Button>
        {canUndo ? (
          <Button size="floor" variant="secondary" onClick={onUndo}>
            {labels.undo}
          </Button>
        ) : null}
        <Button size="floor" variant="secondary" onClick={onClear}>
          {labels.clear}
        </Button>
      </div>
    </>
  ) : (
    <p className="work-box-fill__empty">{labels.absent}</p>
  );
}
```

- [ ] **Step 4: Restructure `PalletStrip`**

Replace the `<div className="pallet-strip__summary">…</div>` element with:

```tsx
<div className="pallet-strip__summary">
  <div className="pallet-strip__readout">
    <h2>{t("pallet.title")}</h2>
    <strong
      key={highlight}
      data-highlight={highlight > 0 ? "true" : undefined}
      className="pallet-strip__progress"
    >
      {t("pallet.progress", { boxes: boxCount, capacity })}
    </strong>
    <span>{percent}</span>
  </div>
  <div
    className="pallet-strip__bar"
    role="progressbar"
    aria-label={t("pallet.current")}
    aria-valuemin={0}
    aria-valuemax={capacity}
    aria-valuenow={Math.min(boxCount, capacity)}
    aria-valuetext={t("pallet.progress", { boxes: boxCount, capacity })}
  >
    <span style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }} />
  </div>
  <p className="pallet-strip__meta">
    <span>{t("pallet.remaining", { count: Math.max(0, capacity - boxCount) })}</span>
    {lastBoxSscc ? (
      <span className="pallet-strip__last">
        {` · ${t("pallet.lastBoxShort")} `}
        <code>…{lastBoxSscc.slice(-6)}</code>
      </span>
    ) : null}
  </p>
</div>
```

- [ ] **Step 5: Update the pallet copy**

`ru.json` → `pallet`: remove `"lastBox": "Последний короб:"`, add `"lastBoxShort": "последний"`.
`en.json` → `pallet`: remove `"lastBox"`, add `"lastBoxShort": "last"`.
Confirm no other reader: `grep -rn "pallet.lastBox\b" apps/station/src apps/station/test` returns nothing.

- [ ] **Step 6: Run the tests and commit**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station exec vitest run test/work-instruments.test.tsx test/pallet-ui.test.tsx test/i18n.test.tsx test/screen-gallery.test.tsx`
Expected: PASS.

```bash
git add apps/station/src/ui/work/BoxFillInstrument.tsx apps/station/src/components/PalletStrip.tsx apps/station/src/i18n/ru.json apps/station/src/i18n/en.json apps/station/test/work-instruments.test.tsx apps/station/test/pallet-ui.test.tsx
git commit -m "feat(station): one-row box head and compact pallet strip"
```

---

### Task 10: Work screen composition, journal head and header label

**Files:**

- Modify: `apps/station/src/ui/work/ScanResultInstrument.tsx` (verdict only)
- Modify: `apps/station/src/ui/work/RecentOperations.tsx` (journal head, serial rows)
- Modify: `apps/station/src/ui/work/WorkFooter.tsx` (no `more`)
- Delete: `apps/station/src/ui/work/WorkCounters.tsx`
- Modify: `apps/station/src/ui/work/work-labels.ts`
- Modify: `apps/station/src/lib/scan-queue.ts` (`ScanOutcome.journaled`)
- Modify: `apps/station/src/components/ValidationProcessingStatus.tsx` (`onState` optional)
- Modify: `apps/station/src/pages/WorkScreen.tsx`
- Create: `apps/station/src/lib/shift-label.ts`
- Modify: `apps/station/src/App.tsx` (~lines 994-1009, 1887-1895, 2048-2152)
- Modify: `apps/station/src/i18n/ru.json`, `apps/station/src/i18n/en.json`
- Modify: `apps/station/src/dev/StationScreenGallery.tsx` (`WorkFixture`, imports)
- Test: `apps/station/test/work-instruments.test.tsx`, `recent-operations.test.tsx`, `work-screen.test.tsx`, `product-label-work-screen.test.tsx`, `pallet-ui.test.tsx`, `status-bar.test.tsx`, `screen-gallery.test.tsx`, create `apps/station/test/shift-label.test.ts`

**Interfaces:**

- Consumes: Task 5 `shiftTotalView`, `ShiftProgressSnapshot`; Task 6 `watchShiftProgress`, `SyncState.shiftProgress`; Task 7 `useShiftJournalCounts`; Task 8 `ShiftBand`, `ShiftBandLabels`.
- Produces:
  - `WorkScreenProps.shiftProgress?: ShiftProgressSnapshot | null`, `WorkScreenProps.onWatchShiftProgress?: (shiftId: string | null) => void`
  - `RecentOperationsProps { operations; counts: { errors: number; duplicates: number }; labels: { title; empty; invalidTime; errors; duplicates }; statusLabels; locale }` with `[data-testid="journal-errors"]` and `[data-testid="journal-duplicates"]`
  - `ScanResultInstrumentProps { operation: RecentOperation | null; labels: ScanResultLabels }`
  - `headerShiftLabel(context: { number: string | null; productName: string } | null, shiftId: string | null): string | null`

- [ ] **Step 1: Write the failing header-label test**

Create `apps/station/test/shift-label.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { headerShiftLabel } from "../src/lib/shift-label.js";

describe("headerShiftLabel", () => {
  it("names the shift by its number while the band names the product", () => {
    expect(headerShiftLabel({ number: "SEP26-021", productName: "Сидр" }, "s1")).toBe("SEP26-021");
  });

  it("falls back to the product, then the id, and stays empty outside a shift", () => {
    expect(headerShiftLabel({ number: null, productName: "Сидр" }, "s1")).toBe("Сидр");
    expect(headerShiftLabel(null, "s1")).toBe("s1");
    expect(headerShiftLabel(null, null)).toBeNull();
  });
});
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station exec vitest run test/shift-label.test.ts` → FAIL (module missing).

Create `apps/station/src/lib/shift-label.ts`:

```ts
/**
 * The status bar's shift label. The work screen's band already names the
 * product, so a numbered shift is named by its number alone; that width is
 * what keeps the line name from truncating on a 1024 px terminal.
 */
export function headerShiftLabel(
  context: { number: string | null; productName: string } | null,
  shiftId: string | null,
): string | null {
  if (shiftId === null) return null;
  if (!context) return shiftId;
  return context.number ? context.number : context.productName;
}
```

Run again → PASS.

- [ ] **Step 2: Rewrite the component tests first (they fail until Steps 3-6)**

In `apps/station/test/work-instruments.test.tsx`:

- delete the tests "shows the mirrored plan beside the product identity", "prints the expected GTIN as a chip and seeds the identity accent from it", "keeps a neutral hero and shows a monogram when there is no photo and no GTIN", "never reuses one image's extracted hue for another image or after the photo is gone", "omits the counterparty chip for a non-tolling shift", "renders identity only and hands the accepted readout to the box instrument" and "shows large counters and explicit synchronized or pending state" (their identity parts live in `shift-band.test.tsx` now);
- remove the `WorkCounters`, `hueFromGtin`, `primeAccentHue` and `SqlExecutor` imports if unused;
- in "derives a stable in-range hue from the GTIN and a first-letter monogram" keep only the `productMonogram` lines if `hueFromGtin` is no longer imported, or keep the import for the hue lines;
- rewrite "keeps a long product identity and a non-color-only latest result visible" to render the verdict alone:

```tsx
it("keeps a non-color-only latest result visible", () => {
  const { rerender } = render(<ScanResultInstrument operation={null} labels={labels} />);
  expect(screen.getByText("Waiting for a scan")).toBeDefined();

  rerender(
    <ScanResultInstrument
      operation={{
        verdict: "ok",
        scannedAt: "2026-08-06T10:00:00.000Z",
        codeSuffix: "…5Ab1",
        identity: {
          gtin14: "04600000000015",
          serial: "SERIAL-42",
          crypto: [
            { ai: "91", value: "KEY" },
            { ai: "92", value: "SIGNATURE" },
            { ai: "93", value: "TAIL" },
          ],
          normalized: "(01)04600000000015 (21)SERIAL-42 (91)KEY (92)SIGNATURE (93)TAIL",
        },
      }}
      labels={labels}
    />,
  );
  const status = screen.getByRole("status", {
    name: "Accepted: (01)04600000000015 (21)SERIAL-42",
  });
  const acceptedMarker = status.querySelector('[data-semantic="accepted-marker"]');
  expect(acceptedMarker?.textContent).toBe("✓");
  expect(acceptedMarker?.getAttribute("aria-hidden")).toBe("true");
  expect(status.querySelector('[data-semantic="normalized-code"]')?.textContent).toBe(
    "(01)04600000000015 (21)SERIAL-42",
  );
  expect(status.textContent).not.toContain("Crypto tail");
  expect(status.textContent).not.toContain("\u001d");
});
```

- replace "renders no more than six recent rows and labels malformed time safely" with:

```tsx
it("renders the shift journal: six rows, serials, and the shift's error counts", () => {
  render(
    <RecentOperations
      operations={Array.from({ length: 8 }, (_, index) => ({
        verdict: index === 0 ? "duplicate" : "ok",
        scannedAt: index === 0 ? null : `2026-08-06T10:0${index}:00.000Z`,
        codeSuffix: `…000${index}`,
        identity: {
          gtin14: "04600000000015",
          serial: `SERIAL-${index}`,
          crypto: [],
          normalized: `(01)04600000000015 (21)SERIAL-${index}`,
        },
      }))}
      counts={{ errors: 2, duplicates: 3 }}
      labels={{
        title: "Shift journal",
        empty: "No scans yet",
        invalidTime: "Time unknown",
        errors: "Errors",
        duplicates: "Duplicates",
      }}
      statusLabels={labels}
      locale="en-US"
    />,
  );
  expect(screen.getByRole("heading", { name: "Shift journal" })).toBeDefined();
  expect(screen.getByTestId("journal-errors").textContent).toBe("2");
  expect(screen.getByTestId("journal-duplicates").textContent).toBe("3");
  expect(screen.getByTestId("journal-duplicates").getAttribute("data-tone")).toBe("warn");
  expect(screen.getAllByRole("listitem")).toHaveLength(6);
  expect(screen.getByText("Duplicate")).toBeDefined();
  expect(screen.getByText("Time unknown")).toBeDefined();
  expect(screen.queryByText(/04600000000015/)).toBeNull();
  expect(screen.getByText("SERIAL-0")).toBeDefined();
  expect(screen.queryByText("SERIAL-7")).toBeNull();
});
```

Replace the whole body of `apps/station/test/recent-operations.test.tsx`'s `describe` with:

```tsx
describe("RecentOperations", () => {
  it("shows the serial, and the GTIN only on a wrong-GTIN row", () => {
    render(
      <RecentOperations
        operations={[
          {
            verdict: "wrong_gtin",
            scannedAt: "2026-08-13T10:00:01.000Z",
            codeSuffix: "…L-43",
            identity: {
              gtin14: "04600000000022",
              serial: "SERIAL-43",
              crypto: [],
              normalized: "(01)04600000000022 (21)SERIAL-43",
            },
          },
          {
            verdict: "ok",
            scannedAt: "2026-08-13T10:00:00.000Z",
            codeSuffix: "…L-42",
            identity: {
              gtin14: "04600000000015",
              serial: "SERIAL-42",
              crypto: [],
              normalized: "(01)04600000000015 (21)SERIAL-42",
            },
          },
        ]}
        counts={{ errors: 1, duplicates: 0 }}
        labels={{
          title: "Shift journal",
          empty: "No scans yet",
          invalidTime: "Time unknown",
          errors: "Errors",
          duplicates: "Duplicates",
        }}
        statusLabels={statusLabels}
        locale="en-US"
      />,
    );

    expect(screen.getByText("SERIAL-42").tagName).toBe("CODE");
    expect(screen.getByText("SERIAL-43").tagName).toBe("CODE");
    expect(screen.getByText("GTIN 04600000000022")).toBeDefined();
    expect(screen.queryByText(/04600000000015/)).toBeNull();
    expect(screen.getByTestId("journal-duplicates").getAttribute("data-tone")).toBeNull();
  });
});
```

- [ ] **Step 3: Make `ScanResultInstrument` verdict-only**

Replace everything in `ScanResultInstrument.tsx` from `export interface ScanResultInstrumentProps` to the end of the `ScanResultInstrument` function with:

```tsx
export interface ScanResultInstrumentProps {
  operation: RecentOperation | null;
  labels: ScanResultLabels;
}

/**
 * The validation verdict. Product identity lives in the shift band
 * (`ShiftBand.tsx`); aggregation shows its accepted serial in the box instrument.
 */
export function ScanResultInstrument({ operation, labels }: ScanResultInstrumentProps) {
  return (
    <section className="work-instrument work-scan-result">
      <ScanVerdict operation={operation} labels={labels} />
    </section>
  );
}
```

Remove the now-unused imports (`CSSProperties`, `SqlExecutor`, `StationProductImageDescriptor`, `useProductAccentHue`, `ProductImage`, `productMonogram`). Keep `ScanResultLabels`, `operationStatusLabel` and `ScanVerdict` as they are.

- [ ] **Step 4: Make `RecentOperations` the shift journal**

Replace the component in `RecentOperations.tsx`:

```tsx
import type { RecentOperation } from "../../lib/journal.js";
import { operationStatusLabel, type ScanResultLabels } from "./ScanResultInstrument.js";

export interface RecentOperationsProps {
  operations: RecentOperation[];
  /** This terminal's shift counts; duplicates include unjournaled duplicate-DM refusals. */
  counts: { errors: number; duplicates: number };
  labels: {
    title: string;
    empty: string;
    invalidTime: string;
    errors: string;
    duplicates: string;
  };
  statusLabels: ScanResultLabels;
  locale: string;
}

export function RecentOperations({
  operations,
  counts,
  labels,
  statusLabels,
  locale,
}: RecentOperationsProps) {
  const visible = operations.slice(0, 6);
  const number = new Intl.NumberFormat(locale);
  return (
    <section className="work-instrument work-recent" aria-labelledby="work-recent-title">
      <div className="work-recent__head">
        <h2 id="work-recent-title">{labels.title}</h2>
        <dl className="work-recent__quality">
          <div>
            <dt>{labels.errors}</dt>
            <dd data-testid="journal-errors">{number.format(counts.errors)}</dd>
          </div>
          <div>
            <dt>{labels.duplicates}</dt>
            <dd
              data-testid="journal-duplicates"
              data-tone={counts.duplicates > 0 ? "warn" : undefined}
            >
              {number.format(counts.duplicates)}
            </dd>
          </div>
        </dl>
      </div>
      {visible.length === 0 ? (
        <p className="work-recent__empty">{labels.empty}</p>
      ) : (
        <ol>
          {visible.map((operation, index) => (
            <li
              key={`${operation.scannedAt ?? "invalid"}:${index}`}
              data-tone={operation.verdict === "ok" ? "ok" : "error"}
            >
              <strong>{operationStatusLabel(operation.verdict, statusLabels)}</strong>
              {operation.identity ? (
                <span className="work-recent__identity">
                  <code
                    className="work-recent__serial"
                    title={`${statusLabels.serial}: ${operation.identity.serial}`}
                  >
                    {operation.identity.serial}
                  </code>
                  {operation.verdict === "wrong_gtin" ? (
                    <span className="work-recent__gtin">
                      {`${statusLabels.gtin} ${operation.identity.gtin14}`}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span>{operation.codeSuffix ?? "—"}</span>
              )}
              <time dateTime={operation.scannedAt ?? undefined}>
                {operation.scannedAt
                  ? new Intl.DateTimeFormat(locale, { timeStyle: "medium" }).format(
                      new Date(operation.scannedAt),
                    )
                  : labels.invalidTime}
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Footer, labels, copy, queue outcome, processing status**

`WorkFooter.tsx`: remove `more?: string` from `labels`, the `onMore` prop and its doc comment, `showMore`, the fourth button, and simplify `ariaLabel` to `` `${labels.exceptions}, ${labels.pause}, ${labels.close}` ``.

Delete `apps/station/src/ui/work/WorkCounters.tsx`.

`work-labels.ts` — replace the returned object's `counters`, `recent` and `footer` entries and add `band`:

```ts
    band: {
      gtin: t("work.gtin"),
      counterpartyPrefix: t("shifts.forCounterparty"),
      totalAll: t("work.shiftTotalAll"),
      totalTerminal: t("work.shiftTotalTerminal"),
      planPercent: (percent: string) => t("work.planPercent", { percent }),
      terminalShare: (value: string) => t("work.terminalShare", { value }),
      othersAsOf: (time: string) => t("work.othersAsOf", { time }),
    },
    recent: {
      title: t("work.journal"),
      empty: t("work.noRecentOperations"),
      invalidTime: t("work.timeUnknown"),
      errors: t("work.errors"),
      duplicates: t("work.duplicates"),
    },
    footer: {
      exceptions: t("work.exceptions"),
      pause: t("work.pause"),
      close: t("work.closeShift"),
    },
```

i18n (`work` block; keep RU and EN in lockstep):

| key                             | ru                               | en                               |
| ------------------------------- | -------------------------------- | -------------------------------- |
| `work.shiftTotalAll` (new)      | `В смене · все терминалы`        | `In shift · all terminals`       |
| `work.shiftTotalTerminal` (new) | `В смене · этот терминал`        | `In shift · this terminal`       |
| `work.planPercent` (new)        | `{{percent}} плана`              | `{{percent}} of plan`            |
| `work.terminalShare` (new)      | `этот терминал {{value}}`        | `this terminal {{value}}`        |
| `work.othersAsOf` (new)         | `другие терминалы — на {{time}}` | `other terminals as of {{time}}` |
| `work.journal` (new)            | `Журнал смены`                   | `Shift journal`                  |

Remove from both files, after `grep -rn` shows no remaining reader in `apps/station/src` and `apps/station/test`: `work.accepted`, `work.synchronized`, `work.pendingSync_one`, `work.pendingSync_few`, `work.pendingSync_many`, `work.pendingSync_other`, `work.more`, `work.recentOperations`. In `ru.json` change `shell.conflicts` to `Конфликты кодов` and `shell.conflictsShort` to `Конфликты` (EN already says `Conflicts`).

`scan-queue.ts` — add to `ScanOutcome` after `duplicateReason?`:

```ts
  /**
   * False when the verdict left no `scan_events_mirror` row: a duplicate-DM
   * refusal aborts its whole acceptance statement. The work screen counts
   * those for the session on top of the journal's counts.
   */
  journaled?: false;
```

`ValidationProcessingStatus.tsx` — make `onState` optional (`onState?: (...) => void;`) and call `onState?.(next);`.

- [ ] **Step 6: Recompose `WorkScreen.tsx`**

1. Imports: drop `WorkCounters` and the `readValidationProcessingState` type import (if only the removed state used it); add:

```ts
import { ShiftBand } from "../ui/work/ShiftBand.js";
import { shiftTotalView, type ShiftProgressSnapshot } from "../lib/shift-progress.js";
import { useShiftJournalCounts } from "../lib/use-shift-journal-counts.js";
```

2. `WorkScreenProps` — add after `pendingSync: number;`:

```ts
  /** The sync engine's last server answer for this shift's total; null before the first. */
  shiftProgress?: ShiftProgressSnapshot | null;
  /** Tells the sync engine which shift's total to keep fresh; null when leaving. */
  onWatchShiftProgress?: (shiftId: string | null) => void;
```

and destructure `shiftProgress = null, onWatchShiftProgress,` in the component signature.

3. Replace the session counters (`const [accepted, setAccepted] = useState(0);`, `duplicates`, `rejected`) and the `processingState` state with:

```ts
const { counts: journalTotals, refresh: refreshJournalCounts } = useShiftJournalCounts(
  exec,
  shiftId,
);
// Duplicate-DM refusals abort their acceptance statement and leave no
// journal row; they are counted for this session on top of the journal.
const [unjournaledDuplicates, setUnjournaledDuplicates] = useState(0);
const [nowMs, setNowMs] = useState(() => Date.now());
useEffect(() => {
  const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
  return () => window.clearInterval(timer);
}, []);
useEffect(() => {
  if (!onWatchShiftProgress) return;
  onWatchShiftProgress(shiftId);
  return () => onWatchShiftProgress(null);
}, [onWatchShiftProgress, shiftId]);
// A new sync answer can also mean a server release removed local codes.
useEffect(() => {
  refreshJournalCounts();
}, [refreshJournalCounts, shiftProgress]);
```

4. `live` ref: add `refreshJournalCounts` to both the initial object and the object assigned in the following effect.

5. In `process()`, the duplicate-DM refusal return gains `journaled: false`:

```ts
if (result.status === "duplicate")
  return {
    raw,
    verdict: { status: "duplicate", key: codeHash },
    firstSeen: await findFirstSeen(exec, codeHash),
    duplicateReason: await readValidationRejectionReason(exec, shiftId, codeHash),
    journaled: false,
  };
```

6. In `onOutcome`, replace the block that increments `setAccepted` / `setRejected` / `setDuplicates` with:

```ts
if (outcome.journaled === false && outcome.verdict.status === "duplicate")
  setUnjournaledDuplicates((n) => n + 1);
```

and next to `void live.current.refreshRecentOperations();` add `live.current.refreshJournalCounts();`. In `onError`, delete `setRejected((n) => n + 1);` (a failed write has no verdict to count; the «ОШИБКА ЗАПИСИ» signal stays).

7. In `enqueueExceptionJob`, after `await job();` add `live.current.refreshJournalCounts();`.

8. Remove the pallet overflow menu: the `palletMenuOpen` state, its three uses in the scan-blocking conditions and the dependency list, the `{palletMenuOpen ? (<Alert …>) : null}` overlay, and `WorkFooter`'s `onMore` spread. Change the doc comment of `enqueueManualPalletClose` from «The "Ещё" overflow action» to «The pallet strip's early-close action».

9. Compute the band total before `return (`:

```ts
const shiftTotal = shiftTotalView({
  shiftId,
  snapshot: shiftProgress,
  local: journalTotals.accepted,
  plannedQty,
  nowMs,
});
```

10. Replace the final `: ( <div className="work-screen__instruments"> … </div> )` branch of the content with:

```tsx
        ) : (
          <div className="work-screen__work">
            <ShiftBand
              productName={productName}
              counterpartyName={counterpartyName ?? null}
              gtin={expectedGtin14}
              exec={exec}
              productId={productId}
              image={productImage}
              refreshKey={imageRefreshKey}
              total={shiftTotal}
              locale={workLabels.locale}
              labels={workLabels.band}
            />
            <div className="work-screen__instruments">
              <div className="work-screen__primary">
                {issuerPrefix === null && !productLabels.work ? (
                  <ScanResultInstrument
                    operation={latestAcceptedOperation}
                    labels={workLabels.status}
                  />
                ) : null}
                {productLabels.work ? (
                  <>
                    <ValidationProcessingStatus
                      exec={exec}
                      shiftId={shiftId}
                      refreshKey={journalTotals.accepted + journalTotals.errors + journalTotals.duplicates}
                    />
                    <ProductLabelInstrument
                      job={productLabels.state.job}
                      busy={productLabels.state.busy}
                      verification={productLabels.verification}
                    />
                  </>
                ) : null}
                {issuerPrefix !== null ? (
                  <BoxFillInstrument
                    box={box}
                    ordinal={boxNumber}
                    acceptedToken={
                      lastScanned !== null && lastScanned.boxId === box?.boxId
                        ? `${lastScanned.codeHash}:${lastScanned.scannedAt}`
                        : null
                    }
                    capacity={boxCapacity}
                    canUndo={lastScanned?.boxId === box?.boxId}
                    closeDisabled={closing}
                    labels={workLabels.box}
                    lastAccepted={
                      latestAcceptedOperation?.identity
                        ? { serial: latestAcceptedOperation.identity.serial }
                        : null
                    }
                    verdictLabels={{
                      ok: workLabels.status.ok,
                      waiting: workLabels.status.waiting,
                    }}
                    onClose={enqueueManualClose}
                    onUndo={() => void handleUndo()}
                    onClear={() => setConfirmClear(true)}
                  />
                ) : null}
                {palletBoxCapacity !== null && issuerPrefix !== null ? (
                  <PalletStrip
                    key={pallet?.palletId ?? "empty-pallet"}
                    lastBoxSscc={pallet?.lastBoxSscc ?? null}
                    disabled={ordinaryScanBlockedRef.current || closing}
                    onShowContents={() => {
                      if (!pallet || ordinaryScanBlockedRef.current) return;
                      ordinaryScanBlockedRef.current = true;
                      setPalletContentsId(pallet.palletId);
                    }}
                    onClose={() => {
                      if (ordinaryScanBlockedRef.current) return;
                      ordinaryScanBlockedRef.current = true;
                      setPalletEarlyCloseConfirm(true);
                    }}
                    boxCount={pallet?.boxCount ?? 0}
                    capacity={palletBoxCapacity}
                    serials={palletNoSerials ? "empty" : "available"}
                  />
                ) : null}
              </div>
              <aside className="work-screen__secondary" aria-label={workLabels.summary}>
                <RecentOperations
                  operations={recentOperations}
                  counts={{
                    errors: journalTotals.errors,
                    duplicates: journalTotals.duplicates + unjournaledDuplicates,
                  }}
                  labels={workLabels.recent}
                  statusLabels={workLabels.status}
                  locale={workLabels.locale}
                />
              </aside>
            </div>
          </div>
        )}
```

The previous `refreshKey={accepted + rejected}` of `ValidationProcessingStatus` becomes the journal-count sum above, so it still re-reads after every recorded scan.

11. `WorkFooter` call: remove the `{...(palletBoxCapacity !== null && issuerPrefix !== null ? { onMore: … } : {})}` spread.

- [ ] **Step 7: Wire `App.tsx`**

1. Destructure `watchShiftProgress` from `useSyncEngine(...)`.
2. Replace the `shiftLabel={ shift ? … : null }` expression with:

```tsx
      shiftLabel={headerShiftLabel(shiftContext ?? null, shift ? shift.id : null)}
```

and import `headerShiftLabel` from `./lib/shift-label.js`. (`shiftContext` is `null` or a row with `number: string | null` and `productName: string`.) 3. On `<WorkScreen …>` add after `pendingSync={syncState.pending}`:

```tsx
              shiftProgress={syncState.shiftProgress}
              onWatchShiftProgress={watchShiftProgress}
```

- [ ] **Step 8: Update the gallery composition so it compiles**

In `apps/station/src/dev/StationScreenGallery.tsx`: drop the `WorkCounters` import, add `import { ShiftBand } from "../ui/work/ShiftBand.js";` and `import { shiftTotalView } from "../lib/shift-progress.js";`, and replace `WorkFixture`'s returned JSX content (everything inside `<div className="work-screen__content">`) with:

```tsx
<div className="work-screen__work">
  <ShiftBand
    exec={galleryProductImageExecutor}
    productId="gallery-product-berry-syrup"
    image={galleryProductImage}
    productName={productName}
    counterpartyName={ru ? "ООО «Тестовый производитель»" : "Sample Manufacturer Ltd"}
    gtin="04607000000042"
    total={total}
    locale={workLabels.locale}
    labels={workLabels.band}
  />
  <div className="work-screen__instruments">
    <div className="work-screen__primary">
      {!aggregation && !productLabel ? (
        <ScanResultInstrument
          operation={waiting ? null : (operations[0] ?? null)}
          labels={workLabels.status}
        />
      ) : null}
      {productLabel ? (
        <ProductLabelInstrument
          {...productLabel}
          verification={productLabel.job?.verification ?? "required"}
        />
      ) : null}
      {aggregation ? (
        <BoxFillInstrument
          box={{ boxId: "gallery-box-1", itemCount: boxItemCount }}
          ordinal={1}
          acceptedToken={boxFull ? "gallery-box-full" : "gallery-accepted-2"}
          capacity={boxCapacity}
          canUndo
          labels={workLabels.box}
          lastAccepted={
            waiting
              ? null
              : operations[0]?.identity
                ? { serial: operations[0].identity.serial }
                : null
          }
          verdictLabels={{ ok: workLabels.status.ok, waiting: workLabels.status.waiting }}
          onClose={() => undefined}
          onUndo={() => undefined}
          onClear={() => undefined}
        />
      ) : null}
      {mode === "aggregation-pallet" ? (
        <PalletStrip
          boxCount={42}
          capacity={66}
          serials="available"
          lastBoxSscc="004601234560000042"
          onShowContents={() => setShowPalletContents(true)}
          onClose={() => undefined}
        />
      ) : null}
    </div>
    <aside className="work-screen__secondary" aria-label={workLabels.summary}>
      <RecentOperations
        operations={operations}
        counts={{ errors: waiting ? 0 : 2, duplicates: waiting ? 0 : 1 }}
        labels={workLabels.recent}
        statusLabels={workLabels.status}
        locale={workLabels.locale}
      />
    </aside>
  </div>
</div>
```

with, near the other constants at the top of `WorkFixture`:

```tsx
const productName = ru ? "Тестовый товар А" : "Sample product A";
const total = shiftTotalView({
  shiftId: "gallery-shift",
  snapshot: null,
  local: waiting ? 0 : 1_248,
  plannedQty,
  nowMs: Date.now(),
});
```

and use `aria-label={productName}` on the `<main>`.

- [ ] **Step 9: Update the screen and flow tests**

`apps/station/test/work-screen.test.tsx`:

- `RenderWorkScreenOverrides` gains `shiftProgress?: ShiftProgressSnapshot | null; onWatchShiftProgress?: (shiftId: string | null) => void;` (import the type from `../src/lib/shift-progress.js`); `renderWorkScreen` destructures them and passes `{...(shiftProgress !== undefined ? { shiftProgress } : {})}` and `{...(onWatchShiftProgress ? { onWatchShiftProgress } : {})}`.
- Replace each bare counter wait:
  - "accepts a valid code, counts it and journals it" (`expect(await screen.findByText("1"))`) → `await waitFor(() => expect(screen.getByTestId("shift-total").textContent).toBe("1"));`
  - "flags the second scan of the same code as a duplicate" (`await screen.findByText("1");`) → the same `shift-total` wait; after the duplicate alert assertions add `await waitFor(() => expect(screen.getByTestId("journal-duplicates").textContent).toBe("1"));`
  - "accepts a code removed by background synchronization…" → the same `shift-total` wait.
  - "shows the system-error signal and counts the scan as rejected when the journal write throws" → rename to "shows the system-error signal and does not count a failed write as an error" and replace the counter line with `expect(screen.getByTestId("journal-errors").textContent).toBe("0");`
  - "keeps scanning after the initial code-key load fails…" → the same `shift-total` wait.
  - box block, "shows no box UI at all…" (`waitFor(() => expect(screen.getByText("1")).toBeDefined())`) → `await waitFor(() => expect(screen.getByTestId("shift-total").textContent).toBe("1"));`
- In the test asserting `getByRole("heading", { name: "Recent operations" })` change the name to `"Shift journal"`.
- Add, in the top-level `describe`:

```tsx
it("keeps the shift counts after the screen is reopened", async () => {
  const exec = makeExec();
  const source = manualSource();
  const view = renderWorkScreen({ source, exec });
  source.emit(KM);
  await waitFor(() => expect(screen.getByTestId("shift-total").textContent).toBe("1"));
  source.emit(KM);
  await waitFor(() => expect(screen.getByTestId("journal-duplicates").textContent).toBe("1"));
  view.unmount();
  renderWorkScreen({ source: manualSource(), exec });
  await waitFor(() => expect(screen.getByTestId("shift-total").textContent).toBe("1"));
  await waitFor(() => expect(screen.getByTestId("journal-duplicates").textContent).toBe("1"));
});

it("watches this shift's total and adds other terminals to the band", async () => {
  const onWatchShiftProgress = vi.fn();
  const source = manualSource();
  const view = renderWorkScreen({
    source,
    onWatchShiftProgress,
    shiftProgress: {
      shiftId: "s1",
      acceptedUnits: 10,
      deviceAcceptedUnits: 0,
      asOf: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
    },
  });
  expect(onWatchShiftProgress).toHaveBeenCalledWith("s1");
  source.emit(KM);
  await waitFor(() => expect(screen.getByTestId("shift-total").textContent).toBe("11"));
  expect(screen.getByText("In shift · all terminals")).toBeDefined();
  expect(screen.getByText("this terminal 1")).toBeDefined();
  view.unmount();
  expect(onWatchShiftProgress).toHaveBeenLastCalledWith(null);
});
```

`apps/station/test/product-label-work-screen.test.tsx`:

- "restores the main processed counter and pending confirmation after remount": replace the «Принято» `waitFor` with `await waitFor(() => expect(screen.getByTestId("shift-total").textContent).toBe("1"));` (keep the `summary` lookup and its `queryByText("Синхронизировано")` check).
- "keeps same-shift refusal and durable processing counts after skipping verification": keep the «Ошибки» / «Дубли» assertions; replace the post-remount «Принято» `waitFor` with the same `shift-total` wait.

`apps/station/test/pallet-ui.test.tsx`, "WorkScreen pallet early close": in all three tests replace the two clicks (`work.more`, then `pallet.earlyClose`) with one click on the strip's `pallet.closeCurrent` button. In the first test add `expect(screen.queryByRole("button", { name: "Ещё" })).toBeNull();` (use the literal: the key no longer exists).

`apps/station/test/status-bar.test.tsx`, "labels duplicate-code conflicts clearly in Russian": expect `Конфликты кодов` and `Конфликты` instead of `Дубли кодов` and `Дубли`.

`apps/station/test/screen-gallery.test.tsx`:

- `work-aggregation` test: replace the `.work-scan-result` assertions with:

```tsx
expect(view.container.querySelector(".work-scan-result")).toBeNull();
const band = view.container.querySelector<HTMLElement>(".work-shift-band");
expect(band).not.toBeNull();
if (!band) throw new Error("shift band was not rendered");
expect(within(band).getByRole("heading", { name: "Тестовый товар А" })).toBeDefined();
expect(within(band).getByText("В смене · этот терминал")).toBeDefined();
expect(within(band).getByTestId("shift-total").textContent).toBe(
  new Intl.NumberFormat("ru-RU").format(1248),
);
```

(keep the `.mk-signal-overlay` check and the box assertions).

- `box-full` test: `.work-scan-result` → `.work-shift-band`.

- [ ] **Step 10: Run the station suites**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station exec vitest run test/shift-label.test.ts test/work-instruments.test.tsx test/recent-operations.test.tsx test/work-screen.test.tsx test/product-label-work-screen.test.tsx test/pallet-ui.test.tsx test/status-bar.test.tsx test/screen-gallery.test.tsx test/i18n.test.tsx test/App.test.tsx test/floor-shell.test.tsx`
Expected: PASS.

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station test && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station typecheck && pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station lint`
Expected: green. (The layout is not styled yet; Task 11 does that.)

`App.test.tsx` fetch stubs answer every non-POST with `{ items: [] }`; the progress tracker rejects that shape silently. If an App test counts or whitelists requested URLs, allow `GET /station/shifts/<id>/progress` there instead of weakening any other assertion.

- [ ] **Step 11: Commit**

```bash
git add apps/station/src/ui/work/ScanResultInstrument.tsx apps/station/src/ui/work/RecentOperations.tsx apps/station/src/ui/work/WorkFooter.tsx apps/station/src/ui/work/WorkCounters.tsx apps/station/src/ui/work/work-labels.ts apps/station/src/lib/scan-queue.ts apps/station/src/lib/shift-label.ts apps/station/src/components/ValidationProcessingStatus.tsx apps/station/src/pages/WorkScreen.tsx apps/station/src/App.tsx apps/station/src/i18n/ru.json apps/station/src/i18n/en.json apps/station/src/dev/StationScreenGallery.tsx apps/station/test/shift-label.test.ts apps/station/test/work-instruments.test.tsx apps/station/test/recent-operations.test.tsx apps/station/test/work-screen.test.tsx apps/station/test/product-label-work-screen.test.tsx apps/station/test/pallet-ui.test.tsx apps/station/test/status-bar.test.tsx apps/station/test/screen-gallery.test.tsx
git commit -m "feat(station): compose the work screen around the shift band and journal"
```

(`git add` of the deleted `WorkCounters.tsx` stages its removal.)

---

### Task 11: Layout CSS

**Files:**

- Modify: `apps/station/src/station.css`
- Test: `apps/station/test/fixed-viewport-source.test.tsx` (tests "keeps the box cells and actions on one bounded instrument surface" and "gives box progress most of the work surface at 1024px without hiding the product photo", ~lines 119-172)

**Interfaces:**

- Consumes: the DOM classes produced by Tasks 8-10.

- [ ] **Step 1: Rewrite the CSS contract (failing)**

In `apps/station/test/fixed-viewport-source.test.tsx`, in "keeps the box cells and actions on one bounded instrument surface" change the two row assertions to:

```ts
expect(css).toMatch(
  /\.work-box-fill\s*\{[^}]*grid-template-rows:\s*auto minmax\(96px, 1fr\) minmax\(64px, auto\);/s,
);
expect(css).toMatch(
  /\.work-box-fill\[data-grouped="true"\]\s*\{[^}]*grid-template-rows:\s*auto minmax\(96px, 1fr\) auto minmax\(64px, auto\);/s,
);
```

Replace the whole test "gives box progress most of the work surface at 1024px without hiding the product photo" with:

```ts
it("puts the shift band above two work columns and never lets the box grid collapse", () => {
  const css = stationSource("station.css");
  expect(stationSource("pages/WorkScreen.tsx")).toContain('className="work-screen__work"');
  expect(css).toMatch(/\.work-screen__work\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);/s);
  expect(css).toMatch(
    /\.work-screen__instruments\s*\{[^}]*grid-template-columns:\s*minmax\(0, 3fr\) minmax\(340px, 2fr\);/s,
  );
  expect(css).toMatch(
    /\.work-screen__primary:has\(> \.pallet-strip\)\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\) auto;/s,
  );
  // The band's photo keeps its 3:4 portrait; at 1024 it shrinks to 60px wide.
  expect(css).toMatch(/\.work-shift-band__image\s*\{[^}]*aspect-ratio:\s*3 \/ 4;/s);
  expect(css).toMatch(
    /@media \(max-width:\s*1100px\), \(max-height:\s*767px\)[\s\S]*?\.work-shift-band__image\s*\{[^}]*width:\s*60px;/s,
  );
  // Both pallet actions sit side by side instead of stacking.
  expect(css).toMatch(/\.pallet-strip__actions\s*\{[^}]*grid-auto-flow:\s*column;/s);
  expect(css).not.toContain(".work-counters");
  expect(css).not.toContain("data-identity-only");
  expect(css).toMatch(
    /@media \(max-width:\s*1100px\), \(max-height:\s*767px\)[\s\S]*?\.work-scan-result__normalized\s*\{[^}]*-webkit-line-clamp:\s*3;/s,
  );
});
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station exec vitest run test/fixed-viewport-source.test.tsx`
Expected: FAIL.

- [ ] **Step 2: Replace the photo rules**

Replace the `.work-scan-result__image` and `.work-scan-result__monogram` rules (with their comments, ~lines 2328-2356) by:

```css
/*
 * The shift band's photo: 3:4 portrait, contained (a bottle is never cropped
 * into a square), on the light pad the catalogue shots are shot for.
 */
.work-shift-band__image {
  width: clamp(60px, 6.5vw, 120px);
  height: auto;
  flex: 0 0 auto;
  aspect-ratio: 3 / 4;
  margin: 0;
  border-radius: 10px;
  background: #f4f2ee;
  object-fit: contain;
}

/* The photo slot's stand-in when the product has no photo. */
.work-shift-band__monogram {
  display: grid;
  place-items: center;
  border: 2px solid rgb(255 255 255 / 18%);
  background: rgb(255 255 255 / 8%);
  color: rgb(255 255 255 / 70%);
  font: 700 clamp(28px, 2.6vw, 48px) / 1 var(--font-ui);
}
```

- [ ] **Step 3: Replace the work-screen skeleton and identity rules**

Delete the rules from `.work-screen__content, .work-screen__instruments, …, .work-instrument { min-width: 0; … }` through `.work-scan-result__chip--mono { … }` (~lines 3474-3624: skeleton, `.work-scan-result`, `[data-identity-only]` rules, `.work-screen__primary:has(> .work-scan-result[data-identity-only="true"])`, the identity gradient rules, `.work-scan-result__identity h2, … .work-counters__sync { margin: 0; }`, copy, h2, chips, chip, chip--mono). Insert in their place:

```css
.work-screen__content,
.work-screen__work,
.work-screen__instruments,
.work-screen__primary,
.work-screen__secondary,
.work-screen__exceptions,
.work-instrument {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.work-screen__content {
  padding: var(--sp-3);
}

/*
 * Design 2026-09-25 («лента смены»): the band names the product and carries
 * the shift total across both columns; the columns get every remaining pixel.
 */
.work-screen__work {
  display: grid;
  width: 100%;
  height: 100%;
  gap: var(--sp-3);
  grid-template-rows: auto minmax(0, 1fr);
}

.work-screen__instruments {
  display: grid;
  width: 100%;
  height: 100%;
  gap: var(--sp-3);
  grid-template-columns: minmax(0, 3fr) minmax(340px, 2fr);
}

.work-screen__primary,
.work-screen__secondary {
  display: grid;
  gap: var(--sp-3);
  grid-template-rows: minmax(0, 1fr);
}

/* The box keeps the flexible row; the pallet strip takes its content height. */
.work-screen__primary:has(> .pallet-strip) {
  grid-template-rows: minmax(0, 1fr) auto;
}

/* Duplicate-DM validation: the processing status above the print job. */
.work-screen__primary:has(> .work-product-label) {
  grid-template-rows: auto minmax(0, 1fr);
}

.work-instrument {
  border: 1px solid var(--line);
  border-radius: var(--r-3);
  background: var(--surface-card);
}

/*
 * The band's HUE comes from the product -- the photo's dominant colour, or a
 * GTIN hash when there is no photo (src/lib/product-accent.ts). Lightness is
 * clamped here so white text keeps contrast on every product.
 */
.work-shift-band {
  display: grid;
  min-width: 0;
  overflow: hidden;
  padding: var(--sp-3) var(--sp-4);
  gap: var(--sp-4);
  grid-template-columns: auto minmax(0, 1fr) minmax(240px, 320px);
  align-items: center;
  border-radius: var(--r-3);
  background: linear-gradient(305deg, #2c2b31, #1d1c21 55%, #141317);
}

.work-shift-band[data-accent="true"] {
  background: linear-gradient(
    305deg,
    hsl(var(--product-hue) 46% 21%),
    hsl(var(--product-hue) 42% 11%) 55%,
    hsl(var(--product-hue) 38% 6%)
  );
}

.work-shift-band__copy {
  display: grid;
  min-width: 0;
  gap: var(--sp-2);
}

.work-shift-band__copy h2 {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  color: #fff;
  font: 700 clamp(19px, 1.8vw, 34px) / 1.2 var(--font-ui);
  letter-spacing: -0.01em;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.work-shift-band__chips {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 8px;
}

.work-shift-band__chip {
  overflow: hidden;
  max-width: 100%;
  padding: 5px 12px;
  border-radius: 999px;
  background: rgb(255 255 255 / 10%);
  color: rgb(255 255 255 / 85%);
  font: 600 14px/1.2 var(--font-ui);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.work-shift-band__chip--mono {
  font-family: var(--font-mono);
  font-weight: 400;
}

.work-shift-band__total {
  display: grid;
  min-width: 0;
  padding-left: var(--sp-4);
  gap: 6px;
  border-left: 1px solid rgb(255 255 255 / 15%);
}

.work-shift-band__label,
.work-shift-band__meta {
  margin: 0;
  overflow: hidden;
  color: rgb(255 255 255 / 72%);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.work-shift-band__label {
  font: 600 14px/18px var(--font-ui);
}

.work-shift-band__meta {
  font: 500 13px/17px var(--font-ui);
}

.work-shift-band__value {
  display: flex;
  min-width: 0;
  margin: 0;
  gap: var(--sp-2);
  align-items: baseline;
  font-variant-numeric: tabular-nums;
}

.work-shift-band__value strong {
  color: #fff;
  font: 600 clamp(34px, 3vw, 56px) / 1 var(--font-mono);
}

.work-shift-band__value span {
  overflow: hidden;
  color: rgb(255 255 255 / 72%);
  font: 500 clamp(20px, 1.6vw, 30px) / 1.1 var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.work-shift-band__bar {
  height: 6px;
  overflow: hidden;
  border-radius: 3px;
  background: rgb(255 255 255 / 15%);
}

.work-shift-band__bar > span {
  display: block;
  height: 100%;
  background: var(--ok-solid);
}

.work-scan-result {
  display: grid;
  padding: var(--sp-4);
  grid-template-rows: minmax(0, 1fr);
}

.work-box-fill h2,
.work-recent h2,
.work-box-fill__empty,
.work-recent__empty {
  margin: 0;
}
```

Keep the existing `.work-scan-result__verdict …`, `.work-scan-result__accepted-marker`, `.work-scan-result__normalized` rules untouched.

- [ ] **Step 4: Box rows and head**

Replace the `.work-box-fill` and `.work-box-fill[data-grouped="true"]` rules and `.work-box-fill__readout` rule with:

```css
.work-box-fill {
  display: grid;
  padding: var(--sp-3);
  gap: var(--sp-2);
  grid-template-rows: auto minmax(96px, 1fr) minmax(64px, auto);
}

.work-box-fill[data-grouped="true"] {
  grid-template-rows: auto minmax(96px, 1fr) auto minmax(64px, auto);
}

/* Title, count and the last serial share one row: the grid keeps the height. */
.work-box-fill__head {
  display: flex;
  min-width: 0;
  gap: var(--sp-3);
  align-items: baseline;
}

.work-box-fill__head h2 {
  flex: 0 0 auto;
}

.work-box-fill__readout {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  gap: var(--sp-3);
  align-items: baseline;
}
```

and change `.work-box-fill__readout strong { font: var(--floor-title); … }` to `font: var(--floor-counter-sm);`.

- [ ] **Step 5: Compact pallet strip**

Replace the rules from `/* Pallet progress stays compact alongside the current box, even for 66+ boxes. */` through `.pallet-strip__warning { … }` (the two `.work-screen__primary:has(> .pallet-strip)` rules are now in Step 3's block) with:

```css
/* One row: the readout and its bar on the left, both actions side by side. */
.pallet-strip {
  display: grid;
  padding: var(--sp-3);
  gap: var(--sp-2) var(--sp-3);
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
}

.pallet-strip__summary {
  display: grid;
  min-width: 0;
  gap: 6px;
}

.pallet-strip__readout {
  display: flex;
  min-width: 0;
  gap: var(--sp-2);
  align-items: baseline;
  font-variant-numeric: tabular-nums;
}

.pallet-strip h2 {
  flex: 0 0 auto;
  margin: 0;
  color: var(--fg-2);
  font: var(--floor-body-strong);
}

.pallet-strip__progress {
  overflow: hidden;
  min-width: 0;
  color: var(--fg-1);
  font: 700 24px/30px var(--font-ui);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pallet-strip__progress[data-highlight="true"] {
  animation: pallet-count-added 300ms ease-out;
}

@keyframes pallet-count-added {
  50% {
    color: var(--ok-fg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .pallet-strip__progress[data-highlight="true"] {
    animation: none;
  }
}

.pallet-strip__readout > span {
  flex: 0 0 auto;
  color: var(--fg-2);
  font: var(--floor-body);
  white-space: nowrap;
}

.pallet-strip__bar {
  height: 8px;
  overflow: hidden;
  border-radius: var(--r-1);
  background: var(--surface-panel);
}

.pallet-strip__bar > span {
  display: block;
  height: 100%;
  background: var(--fg-2);
}

.pallet-strip__meta {
  margin: 0;
  overflow: hidden;
  color: var(--fg-2);
  font: 400 15px/20px var(--font-ui);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pallet-strip__meta code {
  color: var(--fg-1);
  font-family: var(--font-mono);
}

.pallet-strip__actions {
  display: grid;
  gap: var(--sp-2);
  grid-auto-flow: column;
  grid-auto-columns: 116px;
}

.pallet-strip__actions .mk-btn {
  min-width: 0 !important;
  padding-inline: var(--sp-2) !important;
  line-height: 1.15;
  white-space: normal;
}

.pallet-strip__warning {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--warn-fg);
  font: var(--floor-body);
}
```

- [ ] **Step 6: Journal head; drop the counters card**

Delete the `.work-counters`, `.work-counters dl`, `.work-counters dt`, `.work-counters dd`, `.work-counters__sync`, `.work-counters__sync[data-tone="ok"]` and `.work-counters__sync[data-tone="warn"]` rules. Replace the `.work-recent__identity`, `.work-recent__identity > div`, `.work-recent__identity dt, .work-recent__identity dd`, `.work-recent__identity dt` and `.work-recent__identity dt::after` rules with:

```css
.work-recent__head {
  display: flex;
  min-width: 0;
  gap: var(--sp-3);
  align-items: baseline;
  justify-content: space-between;
}

.work-recent__quality {
  display: flex;
  margin: 0;
  gap: var(--sp-4);
  align-items: baseline;
}

.work-recent__quality > div {
  display: flex;
  gap: 6px;
  align-items: baseline;
}

.work-recent__quality dt {
  color: var(--fg-2);
  font: var(--floor-body);
}

.work-recent__quality dd {
  margin: 0;
  font: 600 24px/1 var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.work-recent__quality dd[data-tone="warn"] {
  color: var(--warn-fg);
}

.work-recent__identity {
  display: grid;
  min-width: 0;
}

.work-recent__serial {
  overflow: hidden;
  color: var(--fg-1);
  font: 600 17px/22px var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.work-recent__gtin {
  overflow: hidden;
  color: var(--fg-2);
  font: var(--text-code);
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 7: Compact media query**

In `@media (max-width: 1100px), (max-height: 767px) { … }` (~line 5299) replace every work-screen rule (`.work-screen__primary`, `.work-scan-result`, `.work-screen__primary > .work-scan-result:only-child` with its comment, `.work-scan-result__identity`, `.work-scan-result__image` with its comment, `.work-scan-result__copy`, `.work-scan-result__identity h2`, `.work-scan-result__chips`, `.work-scan-result__chip`, `.work-scan-result__verdict[data-compact-success="true"]`, `.work-scan-result__verdict[data-tone="neutral"] strong`, `.work-scan-result__normalized`, `.work-box-fill__readout strong`) with:

```css
.work-shift-band {
  padding: var(--sp-2) var(--sp-3);
  gap: var(--sp-3);
  grid-template-columns: auto minmax(0, 1fr) minmax(220px, 280px);
}

.work-shift-band__image {
  width: 60px;
}

.work-shift-band__copy h2 {
  font: 700 19px/23px var(--font-ui);
}

.work-shift-band__chip {
  padding: 4px 10px;
  font-size: 13px;
}

.work-shift-band__value strong {
  font: 600 34px/1 var(--font-mono);
}

.work-shift-band__value span {
  font: 500 20px/1.1 var(--font-mono);
}

.work-scan-result {
  padding: var(--sp-3);
}

.work-scan-result__verdict[data-compact-success="true"] {
  padding: var(--sp-2);
}

.work-scan-result__verdict[data-tone="neutral"] strong {
  font: var(--floor-lg);
}

.work-scan-result__normalized {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}
```

- [ ] **Step 8: Run the contract and commit**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station exec vitest run test/fixed-viewport-source.test.tsx test/screen-gallery.test.tsx`
Expected: PASS. Then `grep -n "work-scan-result__identity\|work-scan-result__image\|work-counters" apps/station/src/station.css` returns nothing.

Run: `pnpm --config.verifyDepsBeforeRun=false exec prettier --check apps/station/src/station.css`
Expected: clean.

```bash
git add apps/station/src/station.css apps/station/test/fixed-viewport-source.test.tsx
git commit -m "feat(station): lay out the shift band, compact pallet and shift journal"
```

---

### Task 12: Gallery states and browser verification

**Files:**

- Modify: `apps/station/src/dev/gallery-fixtures.ts` (`VISUAL_STRESS_GALLERY_STATE_IDS`, `GALLERY_FIXTURES`)
- Modify: `apps/station/src/dev/StationScreenGallery.tsx` (`WorkFixture`)
- Test: `apps/station/test/screen-gallery.test.tsx`

**Interfaces:**

- Produces: gallery states `work-pallet-20` and `work-pallet-20-stale` (the owner's case: 20-place box with two items, pallet 15/66, total 1 302 / 9 580 with this terminal 302).

- [ ] **Step 1: Write the failing gallery test**

Append to `apps/station/test/screen-gallery.test.tsx`:

```tsx
it("shows the owner's small-screen case: a 20-place box, pallet 15/66 and the shift total", () => {
  const view = render(<StationScreenGallery request={{ state: "work-pallet-20", locale: "ru" }} />);
  const band = view.container.querySelector<HTMLElement>(".work-shift-band");
  if (!band) throw new Error("shift band was not rendered");
  const ru = new Intl.NumberFormat("ru-RU");
  expect(within(band).getByText("В смене · все терминалы")).toBeDefined();
  expect(within(band).getByTestId("shift-total").textContent).toBe(ru.format(1302));
  expect(within(band).getByText(`/ ${ru.format(9580)}`)).toBeDefined();
  expect(band.querySelector(".work-shift-band__meta")?.textContent).toContain("этот терминал 302");
  expect(view.container.querySelectorAll(".work-box-fill__cell")).toHaveLength(20);
  expect(within(view.container).getByText("15 / 66 коробов")).toBeDefined();
});

it("says how old the other terminals' share is when the answer is stale", () => {
  const view = render(
    <StationScreenGallery request={{ state: "work-pallet-20-stale", locale: "ru" }} />,
  );
  expect(view.container.querySelector(".work-shift-band__meta")?.textContent).toContain(
    "другие терминалы — на",
  );
});
```

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station exec vitest run test/screen-gallery.test.tsx -t "small-screen|stale"`
Expected: FAIL (unknown gallery state).

- [ ] **Step 2: Register the states**

`gallery-fixtures.ts`: add `"work-pallet-20",` and `"work-pallet-20-stale",` to `VISUAL_STRESS_GALLERY_STATE_IDS` after `"work-pallet-66",`, and to `GALLERY_FIXTURES` after the `work-pallet-66` entry:

```ts
  // The owner's 2026-09-25 photo: a 20-place box with two items on pallet
  // 15 of 66, the shift total counting another terminal.
  { id: "work-pallet-20", kind: "work", variant: "aggregation-pallet-20", source: "synthetic" },
  {
    id: "work-pallet-20-stale",
    kind: "work",
    variant: "aggregation-pallet-20-stale",
    source: "synthetic",
  },
```

- [ ] **Step 3: Render them in `WorkFixture`**

In `StationScreenGallery.tsx` add module constants above `WorkFixture`:

```tsx
const GALLERY_PROGRESS_NOW = Date.parse("2026-09-25T09:00:00.000Z");
```

and in `WorkFixture`:

```tsx
const pallet20 = mode.startsWith("aggregation-pallet-20");
const plannedQty = mode === "validation" ? 10_000 : pallet20 ? 9_580 : undefined;
const boxCapacity = boxFull ? 120 : pallet20 ? 20 : 10;
const total = shiftTotalView({
  shiftId: "gallery-shift",
  snapshot: pallet20
    ? {
        shiftId: "gallery-shift",
        acceptedUnits: 1_302,
        deviceAcceptedUnits: 302,
        asOf: "2026-09-25T08:54:00.000Z",
        fetchedAt:
          mode === "aggregation-pallet-20-stale"
            ? "2026-09-25T08:55:00.000Z"
            : "2026-09-25T08:59:50.000Z",
      }
    : null,
  local: waiting ? 0 : pallet20 ? 302 : 1_248,
  plannedQty,
  nowMs: pallet20 ? GALLERY_PROGRESS_NOW : Date.now(),
});
```

(replacing the earlier `plannedQty`, `boxCapacity` and `total` constants), and render the pallet strip for these modes too:

```tsx
{
  mode === "aggregation-pallet" ? (
    <PalletStrip
      boxCount={42}
      capacity={66}
      serials="available"
      lastBoxSscc="004601234560000042"
      onShowContents={() => setShowPalletContents(true)}
      onClose={() => undefined}
    />
  ) : pallet20 ? (
    <PalletStrip
      boxCount={15}
      capacity={66}
      serials="available"
      lastBoxSscc="004601234560619998"
      onShowContents={() => setShowPalletContents(true)}
      onClose={() => undefined}
    />
  ) : null;
}
```

- [ ] **Step 4: Run the gallery tests**

Run: `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station exec vitest run test/screen-gallery.test.tsx test/screen-gallery-bootstrap.test.tsx`
Expected: PASS (the loop over `EXPECTED_GALLERY_STATE_IDS` renders the new states too).

- [ ] **Step 5: Verify in the browser**

Start the station dev server (`.claude/launch.json` → `station`, port 5273; via the preview tool, or `pnpm --config.verifyDepsBeforeRun=false --filter @markiro/station dev` with the sandbox disabled). For each viewport `1024×697`, `1024×768`, `1280×800`, `1920×1080`, each locale `ru`, `en`, and each state `work-pallet-20`, `work-pallet-20-stale`, `work-pallet-66`, `work-aggregation`, `work-validation`, `box-full`, open `http://localhost:5273/?gallery=1&state=<state>&locale=<locale>` and run in the page:

```js
(() => {
  const root = document.querySelector("[data-testid='station-screen-gallery']");
  const grid = root.querySelector(".work-box-fill__grid");
  const rect = (el) => el.getBoundingClientRect();
  const targets = [...root.querySelectorAll("button, [role='button']")].filter((el) => {
    const r = rect(el);
    return r.width > 0 && r.height > 0;
  });
  const small = targets
    .filter((el) => rect(el).width < 63.5 || rect(el).height < 63.5)
    .map((el) => el.textContent.trim());
  const clipped = targets
    .filter((el) => {
      const r = rect(el);
      return r.bottom > innerHeight + 0.5 || r.right > innerWidth + 0.5;
    })
    .map((el) => el.textContent.trim());
  const cell = grid?.querySelector(".work-box-fill__cell");
  return {
    gridHeight: grid ? Math.round(rect(grid).height) : null,
    cellHeight: cell ? Math.round(rect(cell).height) : null,
    band: Math.round(rect(root.querySelector(".work-shift-band")).height),
    small,
    clipped,
  };
})();
```

Expected for every run: `small` and `clipped` are empty; for box states `gridHeight >= 96` (≈150 at 1024×697) and `cellHeight >= 40`; the band is ≤ 112 px at 1024×697. Take one screenshot of `work-pallet-20` (ru) at 1024×697 and one at 1920×1080 as evidence. Fix CSS if any expectation fails, re-run Task 11's contract test, and amend nothing — make a new commit.

If the product-labels browser suite can run locally (`tools/production-browser/product-labels-tests/station.spec.ts`, which opens `work-pallet-66`), run it; otherwise report it as not run.

- [ ] **Step 6: Commit**

```bash
git add apps/station/src/dev/gallery-fixtures.ts apps/station/src/dev/StationScreenGallery.tsx apps/station/test/screen-gallery.test.tsx
git commit -m "test(station): gallery states for the small-screen shift layout"
```

---

### Task 13: Final gates and cleanup

- [ ] **Step 1: Package gates**

Run (sandbox disabled for `api` and `db`):

```bash
set -a; source /tmp/markiro-shift-progress.env; set +a; pnpm --config.verifyDepsBeforeRun=false turbo run lint typecheck test build --filter=@markiro/db --filter=@markiro/api --filter=@markiro/station --concurrency=1 --force
```

Expected: green; list every skipped test file and its reason.

```bash
pnpm --config.verifyDepsBeforeRun=false test:station-release:contract
pnpm --config.verifyDepsBeforeRun=false test:production-bundle:contract
pnpm --config.verifyDepsBeforeRun=false format:check
git diff --check origin/main...HEAD
```

Expected: all pass.

- [ ] **Step 2: Review the branch diff against the spec**

```bash
git fetch origin main
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
```

Check every "Decisions" bullet of the spec against the diff; note anything intentionally deferred.

- [ ] **Step 3: Update the knowledge graph if present**

If `graphify-out/graph.json` exists: `graphify update .`

- [ ] **Step 4: Remove the disposable database**

```bash
docker rm -f markiro-shift-progress-postgres
```

- [ ] **Step 5: Report**

Report separately: behaviour changed; files/areas; automated checks with results (and skips); browser checks performed (viewports, locales, states, measured grid heights); checks not run — the Windows terminal in a maximized window, multi-terminal totals on production data, the concurrent index build on the production volume — and the rollout order: deploy the API first, then publish the station build.
