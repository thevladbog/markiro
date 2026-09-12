import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/** The last migration before `boxes.disassembly_received_at` exists. */
const LAST_LEGACY_INDEX = 132;

/**
 * Migration 0133 backfills `boxes.disassembly_received_at` -- the SERVER
 * instant the pallet list now orders against `pallets.closure_received_at` --
 * for boxes disassembled before the column existed.
 *
 * The instant is recovered from the `disassemble` exception's own
 * `recorded_at`, which every writer of `disassembled_at` inserts in the SAME
 * transaction as the retirement. `disassembled_at` itself is NOT the source
 * for those rows: on the station path it is the operator's device clock, which
 * is exactly what the column exists to stop being used for ordering.
 */
describe.skipIf(!databaseUrl)("box disassembly_received_at migration", () => {
  const databaseName = `markiro_disassembly_received_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let temporaryRoot = "";
  let created = false;

  const tenantId = "disassembly-tenant";
  const otherTenantId = "disassembly-other-tenant";
  const productId = randomUUID();
  const otherProductId = randomUUID();
  const shiftId = randomUUID();
  const otherShiftId = randomUUID();

  /** Station path: device clock a day BEHIND the server that received it. */
  const stationBox = randomUUID();
  /** The same, redelivered: a second audit row, but only one real retirement. */
  const redeliveredBox = randomUUID();
  /** Cabinet path: `disassembled_at` was already the server's own `now()`. */
  const cabinetBox = randomUUID();
  /** Retired with no `disassemble` audit row at all -- nothing to recover. */
  const orphanBox = randomUUID();
  /** Never disassembled. Must stay NULL, or it would look retired. */
  const liveBox = randomUUID();
  /** Another tenant's box, disassembled at a different instant. */
  const otherTenantBox = randomUUID();

  const DEVICE_CLAIM = "2026-09-09T05:00:00.000Z";
  const STATION_RECEIVED = "2026-09-10T12:00:00.000Z";
  const REDELIVERED_FIRST = "2026-09-10T13:00:00.000Z";
  const REDELIVERED_SECOND = "2026-09-10T13:00:05.000Z";
  const CABINET_RECEIVED = "2026-09-10T14:00:00.000Z";
  const ORPHAN_DEVICE_CLAIM = "2026-09-10T15:00:00.000Z";
  const OTHER_TENANT_RECEIVED = "2026-09-10T16:00:00.000Z";

  const hash = (seed: string): string => seed.repeat(64).slice(0, 64);

  async function receivedAt(boxId: string): Promise<string | null> {
    const { rows } = await pool.query<{ at: Date | null }>(
      "SELECT disassembly_received_at AS at FROM boxes WHERE id=$1",
      [boxId],
    );
    expect(rows).toHaveLength(1);
    const value = rows[0]?.at ?? null;
    return value === null ? null : value.toISOString();
  }

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-disassembly-received-"));
    const legacyMigrations = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: legacyMigrations,
      lastIncludedIndex: LAST_LEGACY_INDEX,
    });
    await migrate(drizzle(pool), { migrationsFolder: legacyMigrations });

    for (const id of [tenantId, otherTenantId]) {
      await pool.query(
        "INSERT INTO organization (id,name,slug,created_at) VALUES ($1,$1,$1,now())",
        [id],
      );
      await pool.query("INSERT INTO org_profiles (tenant_id) VALUES ($1)", [id]);
    }
    await pool.query(
      `INSERT INTO products (id,tenant_id,gtin14,name,box_capacity,status)
       VALUES ($1,$3,'04600682000013','Cola',20,'active'),
              ($2,$4,'04600682000020','Cola',20,'active')`,
      [productId, otherProductId, tenantId, otherTenantId],
    );
    await pool.query(
      `INSERT INTO shifts (id,tenant_id,product_id,mode,box_capacity,number_month_key,number_seq)
       VALUES ($1,$3,$5,'aggregation',20,'SEP26',1),
              ($2,$4,$6,'aggregation',20,'SEP26',1)`,
      [shiftId, otherShiftId, tenantId, otherTenantId, productId, otherProductId],
    );

    for (const [id, tenant, shift, disassembledAt] of [
      [stationBox, tenantId, shiftId, DEVICE_CLAIM],
      [redeliveredBox, tenantId, shiftId, DEVICE_CLAIM],
      [cabinetBox, tenantId, shiftId, CABINET_RECEIVED],
      [orphanBox, tenantId, shiftId, ORPHAN_DEVICE_CLAIM],
      [liveBox, tenantId, shiftId, null],
      [otherTenantBox, otherTenantId, otherShiftId, DEVICE_CLAIM],
    ] as const) {
      await pool.query(
        `INSERT INTO boxes (id,tenant_id,shift_id,device_box_id,closed_at,disassembled_at)
         VALUES ($1,$2,$3,$4,'2026-09-09T04:00:00.000Z',$5)`,
        [id, tenant, shift, `dev-${id}`, disassembledAt],
      );
    }

    // The items a disassembly released carry that transaction's server `now()`
    // -- the same value its audit row's `recorded_at` got. Seeded on the
    // station box, the one whose `disassembled_at` disagrees with both.
    await pool.query(
      `INSERT INTO box_items (tenant_id,box_id,code_hash,added_at,removed_at)
       VALUES ($1,$2,$3,'2026-09-09T03:00:00.000Z',$4)`,
      [tenantId, stationBox, hash("a"), STATION_RECEIVED],
    );

    for (const [tenant, box, shift, kind, reason, recorded] of [
      [tenantId, stationBox, shiftId, "disassemble", "переставлен", STATION_RECEIVED],
      [tenantId, redeliveredBox, shiftId, "disassemble", "переставлен", REDELIVERED_FIRST],
      [tenantId, redeliveredBox, shiftId, "disassemble", "переставлен", REDELIVERED_SECOND],
      [tenantId, cabinetBox, shiftId, "disassemble", "документ", CABINET_RECEIVED],
      // Not a disassembly: an `orphanBox` row of a different kind must not be
      // mistaken for one, or the column would carry an unrelated instant.
      [tenantId, orphanBox, shiftId, "clear", null, "2026-09-10T15:30:00.000Z"],
      [tenantId, liveBox, shiftId, "clear", null, "2026-09-10T15:30:00.000Z"],
      [otherTenantId, otherTenantBox, otherShiftId, "disassemble", "другой", OTHER_TENANT_RECEIVED],
    ] as const) {
      await pool.query(
        `INSERT INTO box_exceptions (tenant_id,kind,box_id,shift_id,reason,occurred_at,recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [tenant, kind, box, shift, reason, DEVICE_CLAIM, recorded],
      );
    }

    await migrate(drizzle(pool), { migrationsFolder });
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE "${databaseName}"`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("recovers the server instant from the disassemble exception, not the device clock", async () => {
    expect(await receivedAt(stationBox)).toBe(STATION_RECEIVED);
    // The operator's own account stays exactly as it was recorded.
    const { rows } = await pool.query<{ at: Date }>(
      "SELECT disassembled_at AS at FROM boxes WHERE id=$1",
      [stationBox],
    );
    expect(rows[0]?.at.toISOString()).toBe(DEVICE_CLAIM);
  });

  it("takes the FIRST audit row when a disassemble was redelivered", async () => {
    // The station's UPDATE is guarded by `disassembled_at IS NULL`, so the
    // second delivery wrote an audit row but never re-stamped the box.
    expect(await receivedAt(redeliveredBox)).toBe(REDELIVERED_FIRST);
  });

  it("gives a cabinet-applied disassembly the same instant it already had", async () => {
    expect(await receivedAt(cabinetBox)).toBe(CABINET_RECEIVED);
  });

  it("falls back to the device timestamp only when no disassemble row exists", async () => {
    // Preserves the answer the pallet list already gave for this box rather
    // than silently downgrading it to "nothing changed after close". The
    // `clear` row on this same box must not be read as a disassembly.
    expect(await receivedAt(orphanBox)).toBe(ORPHAN_DEVICE_CLAIM);
  });

  it("leaves a box that was never disassembled null", async () => {
    expect(await receivedAt(liveBox)).toBeNull();
  });

  it("keeps each tenant's boxes on their own instant", async () => {
    expect(await receivedAt(otherTenantBox)).toBe(OTHER_TENANT_RECEIVED);
    // Never fills a box from another tenant's exception row, and never leaves
    // one filled from a row that is not its own.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM boxes b
        WHERE b.disassembly_received_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM box_exceptions e
             WHERE e.tenant_id = b.tenant_id AND e.box_id = b.id AND e.kind = 'disassemble'
               AND e.recorded_at = b.disassembly_received_at)
          AND b.disassembly_received_at <> b.disassembled_at`,
    );
    expect(rows[0]?.n).toBe("0");
  });

  it("matches the removed_at of the items that disassembly released", async () => {
    // The predicate the box report uses to keep a disassembled box's contents
    // printable. Against `disassembled_at` it silently failed for every
    // station-originated disassembly.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM box_items i
         JOIN boxes b ON b.tenant_id = i.tenant_id AND b.id = i.box_id
        WHERE i.removed_at = b.disassembly_received_at`,
    );
    expect(rows[0]?.n).toBe("1");
  });
});
