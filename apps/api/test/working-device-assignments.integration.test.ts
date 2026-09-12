import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StationDevicesService } from "../src/modules/station-devices/station-devices.service";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { createOrganization } from "./support/subscription-fixtures";

describe.skipIf(!process.env.DATABASE_URL)("working device assignment transitions", () => {
  const name = `device_assignments_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  const maintenance = createDb(url.toString());
  url.pathname = `/${name}`;
  const connection = createDb(url.toString());
  const db = connection.db;
  const entitlements = new EntitlementsService(db, "managed_only");
  const devices = new StationDevicesService(db, entitlements);
  let created = false;
  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(db, { migrationsFolder: join(__dirname, "../../../packages/db/migrations") });
  }, 120_000);
  afterAll(async () => {
    await connection.pool.end();
    if (created) await maintenance.pool.query(`DROP DATABASE "${name}"`);
    await maintenance.pool.end();
  });

  it.each(["station", "handheld"] as const)(
    "creates %s with an occupied reservation and exact history",
    async (kind) => {
      const tenantId = await createOrganization(db);
      const device = await devices.create(tenantId, { name: "Working device", lineId: null, kind });
      const rows = await connection.pool.query(
        "SELECT * FROM working_device_assignments WHERE tenant_id=$1 AND device_id=$2",
        [tenantId, device.id],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({
        tenant_id: tenantId,
        device_id: device.id,
        state: "reserved",
        revision: 1,
        provenance: "runtime",
        released_at: null,
        release_reason: null,
      });
      const events = await connection.pool.query(
        "SELECT * FROM working_device_events WHERE tenant_id=$1 AND device_id=$2",
        [tenantId, device.id],
      );
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0]).toMatchObject({
        tenant_id: tenantId,
        device_id: device.id,
        action: "reserved",
        actor_domain: "system",
        actor_id: null,
        outcome: "success",
        before: null,
        after: { state: "reserved", revision: 1 },
      });
      expect((await entitlements.usage(tenantId)).stations).toBe(1);
    },
  );

  it("releases a security-revoked reservation once without deleting the device", async () => {
    const tenantId = await createOrganization(db);
    const device = await devices.create(tenantId, { name: "Reservation", lineId: null });
    await devices.revoke(tenantId, device.id);
    await devices.revoke(tenantId, device.id);
    const rows = await connection.pool.query(
      "SELECT * FROM working_device_assignments WHERE tenant_id=$1 AND device_id=$2",
      [tenantId, device.id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      state: "released",
      release_reason: "security_revoked",
      revision: 2,
    });
    const events = await connection.pool.query(
      "SELECT action FROM working_device_events WHERE tenant_id=$1 AND device_id=$2 ORDER BY created_at,id",
      [tenantId, device.id],
    );
    expect(events.rows.map((event) => event.action)).toEqual(["reserved", "released"]);
    expect(
      (
        await db.select().from(schema.stationDevices).where(eq(schema.stationDevices.id, device.id))
      )[0]?.revokedAt,
    ).toBeInstanceOf(Date);
    expect((await entitlements.usage(tenantId)).stations).toBe(0);
  });

  it("updates a line-bound device with a single available database connection", async () => {
    const tenantId = await createOrganization(db);
    const [line] = await db.insert(schema.lines).values({ tenantId, name: "Packing" }).returning();
    const device = await devices.create(tenantId, { name: "Before", lineId: line!.id });
    const single = createDb(url.toString(), { max: 1 });
    single.pool.options.connectionTimeoutMillis = 500;
    try {
      const service = new StationDevicesService(
        single.db,
        new EntitlementsService(single.db, "managed_only"),
      );
      expect(await service.update(tenantId, device.id, { name: "After" })).toMatchObject({
        name: "After",
        lineId: line!.id,
        lineName: "Packing",
      });
    } finally {
      await single.pool.end();
    }
  });

  it("does not treat missing assignment data as a free place", async () => {
    const tenantId = await createOrganization(db);
    await db.insert(schema.stationDevices).values({ tenantId, name: "Legacy writer" });
    expect((await entitlements.usage(tenantId)).stations).toBe(1);
  });
});
