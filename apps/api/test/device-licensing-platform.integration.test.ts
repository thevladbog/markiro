import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema } from "@markiro/db";
import {
  platformCapabilitiesForRole,
  type PlatformPrincipal,
  type PlatformRole,
} from "@markiro/platform-contracts";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DeviceLicensingService } from "../src/modules/device-licensing/device-licensing.service";
import { StationDevicesService } from "../src/modules/station-devices/station-devices.service";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { createOrganization } from "./support/subscription-fixtures";

describe.skipIf(!process.env.DATABASE_URL)("platform device reservation cancellation", () => {
  const name = `device_licensing_platform_${randomUUID().replaceAll("-", "_")}`;
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

  async function platformActor(
    role: PlatformRole = "platform_admin",
    options: { twoFactorEnabled?: boolean; verifiedFactor?: boolean } = {},
  ): Promise<PlatformPrincipal> {
    const userId = randomUUID();
    const twoFactorEnabled = options.twoFactorEnabled ?? true;
    const verifiedFactor = options.verifiedFactor ?? true;
    await db.insert(schema.platformUsers).values({
      id: userId,
      email: `${userId}@example.invalid`,
      name: "Licensing operator",
      role,
      status: "active",
      twoFactorEnabled,
    });
    if (verifiedFactor) {
      await db.insert(schema.platformTwoFactors).values({
        id: randomUUID(),
        userId,
        secret: "test-only",
        backupCodes: "test-only",
        verified: true,
      });
    }
    return {
      userId,
      role,
      capabilities: platformCapabilitiesForRole[role],
      twoFactorReady: twoFactorEnabled && verifiedFactor,
    };
  }

  async function reservation() {
    const tenantId = await createOrganization(db);
    const cabinetUserId = randomUUID();
    await db.insert(schema.user).values({
      id: cabinetUserId,
      name: "Tenant owner",
      email: `${cabinetUserId}@example.invalid`,
    });
    await db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: tenantId,
      userId: cabinetUserId,
      role: "owner",
      createdAt: new Date(),
    });
    const device = await devices.create(
      tenantId,
      { name: "Platform cancellation fixture", kind: "station", lineId: null },
      { domain: "cabinet", id: cabinetUserId },
    );
    const [assignment] = await db
      .select()
      .from(schema.workingDeviceAssignments)
      .where(
        and(
          eq(schema.workingDeviceAssignments.tenantId, tenantId),
          eq(schema.workingDeviceAssignments.deviceId, device.id),
        ),
      );
    if (!assignment) throw new Error("Reservation assignment fixture missing");
    return {
      tenantId,
      device,
      assignment,
      request: { requestId: randomUUID(), expectedRevision: assignment.revision },
    };
  }

  it("serializes cancellation behind factor recovery without a user/factor deadlock", async () => {
    const principal = await platformActor();
    const { tenantId, device, request } = await reservation();
    const recovery = await connection.pool.connect();
    let cancellation: Promise<unknown> | undefined;
    try {
      await recovery.query("BEGIN");
      const pid = (await recovery.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!
        .pid;
      await recovery.query("delete from platform_two_factors where user_id = $1", [
        principal.userId,
      ]);
      cancellation = licensing
        .cancel(tenantId, device.id, request, { domain: "platform", principal })
        .catch((error: unknown) => error);
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < deadline) {
        const blocked = await connection.pool.query<{ waiting: boolean }>(
          "select exists(select 1 from pg_stat_activity where datname = current_database() and $1 = any(pg_blocking_pids(pid))) as waiting",
          [pid],
        );
        if (blocked.rows[0]?.waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await recovery.query("update platform_users set two_factor_enabled = false where id = $1", [
        principal.userId,
      ]);
      await recovery.query("COMMIT");
    } finally {
      await recovery.query("ROLLBACK");
      recovery.release();
    }
    expect(await cancellation).toMatchObject({ status: 403 });
    expect((await entitlements.usage(tenantId)).stations).toBe(1);
  });

  it("cancels with current platform authority and records exact journal and platform audit facts", async () => {
    const principal = await platformActor();
    const fixture = await reservation();

    const receipt = await licensing.cancel(fixture.tenantId, fixture.device.id, fixture.request, {
      domain: "platform",
      principal,
    });
    const before = {
      id: fixture.assignment.id,
      state: "reserved",
      revision: fixture.assignment.revision,
      releaseReason: null,
      releasedAt: null,
    };
    const after = {
      id: fixture.assignment.id,
      state: "released",
      revision: receipt.revision,
      releaseReason: "reservation_cancelled",
      releasedAt: receipt.releasedAt,
    };

    expect(
      await db
        .select({
          actorPlatformUserId: schema.platformAuditEvents.actorPlatformUserId,
          actorRole: schema.platformAuditEvents.actorRole,
          tenantId: schema.platformAuditEvents.tenantId,
          action: schema.platformAuditEvents.action,
          outcome: schema.platformAuditEvents.outcome,
          targetType: schema.platformAuditEvents.targetType,
          targetId: schema.platformAuditEvents.targetId,
          reason: schema.platformAuditEvents.reason,
          before: schema.platformAuditEvents.before,
          after: schema.platformAuditEvents.after,
          requestId: schema.platformAuditEvents.requestId,
        })
        .from(schema.platformAuditEvents)
        .where(eq(schema.platformAuditEvents.requestId, fixture.request.requestId)),
    ).toEqual([
      {
        actorPlatformUserId: principal.userId,
        actorRole: "platform_admin",
        tenantId: fixture.tenantId,
        action: "device.reservation.cancelled",
        outcome: "success",
        targetType: "station_device",
        targetId: fixture.device.id,
        reason: null,
        before,
        after,
        requestId: fixture.request.requestId,
      },
    ]);
    expect(
      await db
        .select({
          actorDomain: schema.workingDeviceEvents.actorDomain,
          actorId: schema.workingDeviceEvents.actorId,
          tenantId: schema.workingDeviceEvents.tenantId,
          deviceId: schema.workingDeviceEvents.deviceId,
          action: schema.workingDeviceEvents.action,
          outcome: schema.workingDeviceEvents.outcome,
          before: schema.workingDeviceEvents.before,
          after: schema.workingDeviceEvents.after,
          requestId: schema.workingDeviceEvents.requestId,
        })
        .from(schema.workingDeviceEvents)
        .where(eq(schema.workingDeviceEvents.requestId, fixture.request.requestId)),
    ).toEqual([
      {
        actorDomain: "platform",
        actorId: principal.userId,
        tenantId: fixture.tenantId,
        deviceId: fixture.device.id,
        action: "reservation_cancelled",
        outcome: "success",
        before,
        after,
        requestId: fixture.request.requestId,
      },
    ]);
  });

  it.each(["support", "accountant"] as const)(
    "allows %s inspection but refuses cancellation without both write capabilities",
    async (role) => {
      const principal = await platformActor(role);
      const fixture = await reservation();
      const actor = { domain: "platform" as const, principal };

      await expect(licensing.inspect(fixture.tenantId, actor)).resolves.toMatchObject({
        tenantId: fixture.tenantId,
        canCancelReservations: false,
        devices: [{ deviceId: fixture.device.id, canCancel: false }],
      });
      await expect(
        licensing.cancel(fixture.tenantId, fixture.device.id, fixture.request, actor),
      ).rejects.toMatchObject({ status: 403 });
    },
  );

  it.each([
    { label: "enabled 2FA without a verified factor", options: { verifiedFactor: false } },
    { label: "a verified factor with 2FA disabled", options: { twoFactorEnabled: false } },
  ])("requires current database-backed 2FA: $label", async ({ options }) => {
    const principal = await platformActor("platform_admin", options);
    const fixture = await reservation();
    const staleReadyPrincipal = { ...principal, twoFactorReady: true };

    await expect(
      licensing.inspect(fixture.tenantId, {
        domain: "platform",
        principal: staleReadyPrincipal,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it.each(["role", "factor"] as const)(
    "revalidates fresh platform %s before replaying a saved receipt",
    async (loss) => {
      const principal = await platformActor();
      const fixture = await reservation();
      const actor = { domain: "platform" as const, principal };
      const receipt = await licensing.cancel(
        fixture.tenantId,
        fixture.device.id,
        fixture.request,
        actor,
      );

      if (loss === "role") {
        await db
          .update(schema.platformUsers)
          .set({ role: "support" })
          .where(eq(schema.platformUsers.id, principal.userId));
      } else {
        await db
          .update(schema.platformTwoFactors)
          .set({ verified: false })
          .where(eq(schema.platformTwoFactors.userId, principal.userId));
      }

      await expect(
        licensing.cancel(fixture.tenantId, fixture.device.id, fixture.request, actor),
      ).rejects.toMatchObject({ status: 403 });
      expect(
        await db
          .select()
          .from(schema.platformAuditEvents)
          .where(eq(schema.platformAuditEvents.requestId, fixture.request.requestId)),
      ).toHaveLength(1);
      expect(receipt.state).toBe("released");
    },
  );

  it("does not resolve a device through another tenant", async () => {
    const principal = await platformActor();
    const first = await reservation();
    const second = await reservation();

    await expect(
      licensing.cancel(first.tenantId, second.device.id, first.request, {
        domain: "platform",
        principal,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect((await entitlements.usage(first.tenantId)).stations).toBe(1);
    expect((await entitlements.usage(second.tenantId)).stations).toBe(1);
  });

  it("binds a repeated request to the original platform actor", async () => {
    const firstActor = await platformActor();
    const changedActor = await platformActor();
    const fixture = await reservation();

    await licensing.cancel(fixture.tenantId, fixture.device.id, fixture.request, {
      domain: "platform",
      principal: firstActor,
    });
    await expect(
      licensing.cancel(fixture.tenantId, fixture.device.id, fixture.request, {
        domain: "platform",
        principal: changedActor,
      }),
    ).rejects.toMatchObject({ response: { code: "device_reservation_request_conflict" } });
    expect(
      await db
        .select()
        .from(schema.workingDeviceEvents)
        .where(eq(schema.workingDeviceEvents.requestId, fixture.request.requestId)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(schema.platformAuditEvents)
        .where(eq(schema.platformAuditEvents.requestId, fixture.request.requestId)),
    ).toHaveLength(1);
  });
});
