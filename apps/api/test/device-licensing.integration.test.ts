import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LinesService } from "../src/modules/lines/lines.service";
import { StationDevicesService } from "../src/modules/station-devices/station-devices.service";
import { DeviceLicensingService } from "../src/modules/device-licensing/device-licensing.service";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { createOrganization } from "./support/subscription-fixtures";

describe.skipIf(!process.env.DATABASE_URL)("device reservation cancellation", () => {
  const name = `device_licensing_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  const maintenance = createDb(url.toString());
  url.pathname = `/${name}`;
  const connection = createDb(url.toString());
  const db = connection.db;
  const entitlements = new EntitlementsService(db, "managed_only");
  const devices = new StationDevicesService(db, entitlements);
  const licensing = new DeviceLicensingService(db, entitlements, new PlatformAuditService());
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
  async function reservation() {
    const tenantId = await createOrganization(db);
    const userId = randomUUID();
    await db
      .insert(schema.user)
      .values({ id: userId, name: "Owner", email: `${userId}@example.invalid` });
    await db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: tenantId,
      userId,
      role: "owner",
      createdAt: new Date(),
    });
    const actor = { domain: "cabinet" as const, id: userId };
    const device = await devices.create(
      tenantId,
      { name: "Empty reservation", kind: "handheld", lineId: null },
      actor,
    );
    return { tenantId, actor, device, request: { requestId: randomUUID(), expectedRevision: 1 } };
  }
  async function stored(deviceId: string) {
    return db.select().from(schema.stationDevices).where(eq(schema.stationDevices.id, deviceId));
  }

  it("cancels once, preserves the device and replays the exact receipt", async () => {
    const { tenantId, actor, device, request } = await reservation();
    const before = await stored(device.id);
    await db.insert(schema.stationPairingCodes).values({
      tenantId,
      stationDeviceId: device.id,
      issuedByUserId: actor.id,
      codeHash: `fixture-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await licensing.inspect(tenantId, actor)).toMatchObject({
      usage: 1,
      integrity: "ready",
      canCancelReservations: true,
      devices: [{ state: "reserved", canCancel: true }],
    });
    const receipt = await licensing.cancel(tenantId, device.id, request, actor);
    expect(receipt).toMatchObject({
      requestId: request.requestId,
      deviceId: device.id,
      revision: 2,
      state: "released",
      releaseReason: "reservation_cancelled",
    });
    expect(await licensing.cancel(tenantId, device.id, request, actor)).toEqual(receipt);
    expect(await stored(device.id)).toEqual(before);
    expect((await entitlements.usage(tenantId)).stations).toBe(0);
    expect(await licensing.inspect(tenantId, actor)).toMatchObject({
      usage: 0,
      devices: [
        {
          state: "released",
          canCancel: false,
          slotOccupied: false,
          releaseReason: "reservation_cancelled",
        },
      ],
    });
    const events = await db
      .select()
      .from(schema.workingDeviceEvents)
      .where(
        and(
          eq(schema.workingDeviceEvents.tenantId, tenantId),
          eq(schema.workingDeviceEvents.requestId, request.requestId),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorDomain: "cabinet",
      actorId: actor.id,
      tenantId,
      deviceId: device.id,
      action: "reservation_cancelled",
      outcome: "success",
      before: { state: "reserved", revision: 1 },
      after: { state: "released", revision: 2 },
      response: receipt,
    });
    const codes = await db
      .select()
      .from(schema.stationPairingCodes)
      .where(eq(schema.stationPairingCodes.stationDeviceId, device.id));
    expect(codes).toHaveLength(1);
    expect(codes[0]?.usedAt).toBeInstanceOf(Date);
  });

  it("rejects changed request contents and stale assignment revision without releasing", async () => {
    const { tenantId, actor, device, request } = await reservation();
    await expect(
      licensing.cancel(tenantId, device.id, { ...request, expectedRevision: 2 }, actor),
    ).rejects.toMatchObject({ response: { code: "device_reservation_stale" } });
    expect((await entitlements.usage(tenantId)).stations).toBe(1);
    await licensing.cancel(tenantId, device.id, request, actor);
    await expect(
      licensing.cancel(tenantId, device.id, { ...request, expectedRevision: 2 }, actor),
    ).rejects.toMatchObject({ response: { code: "device_reservation_request_conflict" } });
  });

  it("revalidates membership for inspection, cancellation and receipt replay", async () => {
    const { tenantId, actor, device, request } = await reservation();
    await licensing.cancel(tenantId, device.id, request, actor);
    await db.delete(schema.member).where(eq(schema.member.userId, actor.id));
    await expect(licensing.inspect(tenantId, actor)).rejects.toMatchObject({ status: 403 });
    await expect(licensing.cancel(tenantId, device.id, request, actor)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("denies another tenant's device and actor", async () => {
    const a = await reservation();
    const b = await reservation();
    await expect(
      licensing.cancel(a.tenantId, b.device.id, a.request, a.actor),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      licensing.cancel(a.tenantId, a.device.id, a.request, b.actor),
    ).rejects.toMatchObject({ status: 403 });
    expect((await entitlements.usage(a.tenantId)).stations).toBe(1);
    expect((await entitlements.usage(b.tenantId)).stations).toBe(1);
  });

  it("never cancels a previously paired device, including a contradictory reservation", async () => {
    const { tenantId, actor, device, request } = await reservation();
    await db
      .update(schema.stationDevices)
      .set({ pairedAt: new Date() })
      .where(eq(schema.stationDevices.id, device.id));
    expect(await licensing.inspect(tenantId, actor)).toMatchObject({
      usage: 1,
      integrity: "inconsistent",
      canCancelReservations: false,
      devices: [{ canCancel: false, state: "inconsistent" }],
    });
    await expect(licensing.cancel(tenantId, device.id, request, actor)).rejects.toMatchObject({
      response: { code: "device_licensing_inconsistent" },
    });
    expect((await entitlements.usage(tenantId)).stations).toBe(1);
  });

  it("stops cancellation when any assignment is missing instead of silently repairing it", async () => {
    const { tenantId, actor, device, request } = await reservation();
    await db.insert(schema.stationDevices).values({ tenantId, name: "Untracked legacy write" });
    await expect(licensing.cancel(tenantId, device.id, request, actor)).rejects.toMatchObject({
      response: { code: "device_licensing_inconsistent" },
    });
    expect((await entitlements.usage(tenantId)).stations).toBe(2);
  });

  it("rejects cancellation when production history contradicts an empty reservation", async () => {
    const { tenantId, actor, device, request } = await reservation();
    await db.insert(schema.syncBatches).values({
      tenantId,
      batchId: randomUUID(),
      terminalId: device.id,
      payloadDigest: "a".repeat(64),
      result: {},
    });
    expect(await licensing.inspect(tenantId, actor)).toMatchObject({
      devices: [{ canCancel: false, blockedReason: "production_evidence" }],
    });
    await expect(licensing.cancel(tenantId, device.id, request, actor)).rejects.toMatchObject({
      response: { code: "device_reservation_not_empty" },
    });
    expect((await entitlements.usage(tenantId)).stations).toBe(1);
  });

  it.each(["shift_owner", "conflict_loser", "conflict_winner", "print_receipt"] as const)(
    "retains a reservation with historical %s evidence",
    async (source) => {
      const { tenantId, actor, device, request } = await reservation();
      if (source === "print_receipt") {
        await db.insert(schema.productLabelEventReceipts).values({
          tenantId,
          deviceId: device.id,
          eventId: randomUUID(),
          payloadDigest: "a".repeat(64),
          outcome: "quarantined",
          rejectionCode: "parent_missing",
        });
      } else {
        const [product] = await db
          .insert(schema.products)
          .values({ tenantId, name: "Historical product", gtin14: "00012345678901" })
          .returning();
        const [shift] = await db
          .insert(schema.shifts)
          .values({
            tenantId,
            productId: product!.id,
            mode: "validation",
            numberMonthKey: "SEP26",
            numberSeq: 1,
            ...(source === "shift_owner" ? { stationCloseOwnerDeviceId: device.id } : {}),
          })
          .returning();
        if (source !== "shift_owner")
          await db.insert(schema.codeConflicts).values({
            tenantId,
            codeHash: "a".repeat(64),
            losingShiftId: shift!.id,
            winningShiftId: shift!.id,
            losingScannedAt: new Date(),
            winningScannedAt: new Date(),
            ...(source === "conflict_loser"
              ? { losingTerminalId: device.id }
              : { winningTerminalId: device.id }),
          });
      }
      expect(await licensing.inspect(tenantId, actor)).toMatchObject({
        devices: [{ canCancel: false, blockedReason: "production_evidence" }],
      });
      await expect(licensing.cancel(tenantId, device.id, request, actor)).rejects.toMatchObject({
        response: { code: "device_reservation_not_empty" },
      });
      expect((await entitlements.usage(tenantId)).stations).toBe(1);
    },
  );

  it("releases line presence together with licensing while retaining the saved line", async () => {
    const { tenantId, actor, device, request } = await reservation();
    const [line] = await db.insert(schema.lines).values({ tenantId, name: "Packing" }).returning();
    await devices.update(tenantId, device.id, { lineId: line!.id }, actor);
    const lines = new LinesService(db, entitlements);
    expect(await lines.listPresence(tenantId)).toMatchObject({
      items: [{ lineId: line!.id, assignedStations: 1, onlineStations: 0 }],
    });
    await licensing.cancel(tenantId, device.id, { ...request, expectedRevision: 2 }, actor);
    expect(await lines.listPresence(tenantId)).toMatchObject({
      items: [{ lineId: line!.id, assignedStations: 0, onlineStations: 0 }],
    });
    expect(await stored(device.id)).toMatchObject([{ lineId: line!.id, revokedAt: null }]);
  });

  it("serializes duplicate concurrent confirmations into one event and release", async () => {
    const { tenantId, actor, device, request } = await reservation();
    const receipts = await Promise.all([
      licensing.cancel(tenantId, device.id, request, actor),
      licensing.cancel(tenantId, device.id, request, actor),
    ]);
    expect(receipts[0]).toEqual(receipts[1]);
    expect((await entitlements.usage(tenantId)).stations).toBe(0);
    expect(
      await db
        .select()
        .from(schema.workingDeviceEvents)
        .where(eq(schema.workingDeviceEvents.requestId, request.requestId)),
    ).toHaveLength(1);
  });
});
