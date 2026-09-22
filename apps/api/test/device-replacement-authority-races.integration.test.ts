import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { and, eq, isNull } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { replacementExecutionHarness } from "./support/device-replacement-execution-fixture";
import { StationShiftCloseService } from "../src/modules/station-shift-close/station-shift-close.service";
import { SecurityAuditService } from "../src/authorization/security-audit.service";
import { DeviceReplacementRecoveryService } from "../src/modules/device-licensing/device-replacement-recovery.service";
import { StationDevicesService } from "../src/modules/station-devices/station-devices.service";
import { quarantineReplacementSubmission } from "../src/modules/device-licensing/device-replacement-evidence";
import { redeemReplacementRecovery } from "../src/modules/station-pairing/replacement-recovery-pairing";

function signal() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!process.env.DATABASE_URL)("final review legacy cutover race", () => {
  const h = replacementExecutionHarness();
  it("does not apply unretained legacy evidence after emergency transfer wins", async () => {
    const f = await h.fixture("station", 1, true);
    const productId = randomUUID(),
      shiftId = randomUUID();
    await h.db.insert(schema.products).values({
      id: productId,
      tenantId: f.tenantId,
      gtin14: "04600682000013",
      name: "Review product",
      status: "active",
    });
    await h.db.insert(schema.shifts).values({
      id: shiftId,
      tenantId: f.tenantId,
      productId,
      mode: "validation",
      status: "active",
      openedAt: new Date(),
      numberMonthKey: "SEP26",
      numberSeq: 1,
      stationCloseOwnerDeviceId: f.device.id,
    });
    const close = new StationShiftCloseService(h.db, new SecurityAuditService());
    const entered = signal(),
      release = signal();
    const transaction = h.db.transaction.bind(h.db);
    // No execution exists at the preflight SELECT, so the first transaction
    // belongs to actual closure application, after the replacement preflight.
    vi.spyOn(h.db, "transaction").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return transaction(...args);
    });
    const eventId = randomUUID();
    const submitted = close.closeStationShift(f.tenantId, f.device.id, {
      eventId,
      shiftId,
      plannedQtySnapshot: null,
      actualQty: 0,
      closedBoxCount: 0,
      closedAt: new Date(),
    });
    await entered.promise;
    const preview = await h.execution.previewEmergency(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: randomUUID(), expectedRevision: 1, reason: "Review emergency" },
      f.actor,
    );
    const completed = await h.execution.executeEmergency(
      f.tenantId,
      f.prepared.preparation.id,
      {
        requestId: preview.requestId,
        expectedRevision: 1,
        previewId: preview.id,
        mode: "emergency",
      },
      f.actor,
    );
    expect(completed.preparation.state).toBe("completed");
    expect(
      await h.db
        .select()
        .from(schema.stationShiftCloseEvents)
        .where(eq(schema.stationShiftCloseEvents.eventId, eventId)),
    ).toHaveLength(0);
    release.resolve();
    const outcome = await submitted.then(
      (value) => ({ ok: true, value }),
      (error: unknown) => ({ ok: false, error }),
    );
    const [shift] = await h.db.select().from(schema.shifts).where(eq(schema.shifts.id, shiftId));
    const evidence = await h.db
      .select()
      .from(schema.deviceGrantEvidence)
      .where(eq(schema.deviceGrantEvidence.stationDeviceId, f.device.id));
    expect({ outcome, state: shift?.status, retained: evidence.length }).toMatchObject({
      outcome: { ok: false },
      state: "active",
      retained: 1,
    });
  });
  it("invalidates an outstanding recovery code on an explicit security revoke", async () => {
    const f = await h.fixture("station", 1, true);
    const preview = await h.execution.previewEmergency(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: randomUUID(), expectedRevision: 1, reason: "Review emergency" },
      f.actor,
    );
    const completed = await h.execution.executeEmergency(
      f.tenantId,
      f.prepared.preparation.id,
      {
        requestId: preview.requestId,
        expectedRevision: 1,
        previewId: preview.id,
        mode: "emergency",
      },
      f.actor,
    );
    const recovery = new DeviceReplacementRecoveryService(h.db, h.entitlements, h.audit);
    await recovery.issueReplacementRecoveryCode(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: randomUUID(), expectedRevision: completed.preparation.execution!.revision },
      f.actor,
    );
    const [candidate] = await h.db
      .select()
      .from(schema.stationPairingCodes)
      .where(eq(schema.stationPairingCodes.stationDeviceId, f.device.id));
    if (!candidate) throw new Error("Missing recovery code");
    await new StationDevicesService(h.db, h.entitlements).revoke(f.tenantId, f.device.id, f.actor);
    const redeemed = await redeemReplacementRecovery({
      db: h.db,
      entitlements: h.entitlements,
      candidate,
      station: {
        id: f.device.id,
        tenantId: f.tenantId,
        kind: "station",
        name: "Source",
        organizationName: "Review",
        lineId: null,
        lineName: null,
      },
    }).then(
      () => true,
      () => false,
    );
    expect(redeemed).toBe(false);
  });
  it("retains an unproven legacy submission after normal transfer too", async () => {
    const f = await h.ready();
    const p = await h.preview(f);
    await h.execution.executeNormal(f.tenantId, f.preparation.id, p.request, f.actor);
    await expect(
      quarantineReplacementSubmission(h.db, f.tenantId, f.device.id, "scans", randomUUID(), {
        items: ["late"],
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: "device_replacement_recovery", outcome: "quarantined" },
    });
  });
  async function completedSource() {
    const f = await h.fixture("station", 1, true);
    const p = await h.execution.previewEmergency(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: randomUUID(), expectedRevision: 1, reason: "Source unavailable" },
      f.actor,
    );
    await h.execution.executeEmergency(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: p.requestId, expectedRevision: 1, previewId: p.id, mode: "emergency" },
      f.actor,
    );
    return f;
  }
  const recovery = new DeviceReplacementRecoveryService(h.db, h.entitlements, h.audit);
  const devices = new StationDevicesService(h.db, h.entitlements);
  type Source = Awaited<ReturnType<typeof completedSource>>;
  async function state(f: Source) {
    const [device] = await h.db
      .select()
      .from(schema.stationDevices)
      .where(eq(schema.stationDevices.id, f.device.id));
    const [execution] = await h.db
      .select()
      .from(schema.workingDeviceReplacementExecutions)
      .where(eq(schema.workingDeviceReplacementExecutions.deviceId, f.device.id));
    if (!device || !execution) throw new Error("Missing source");
    return { device, execution };
  }
  async function issue(f: Source) {
    const { execution } = await state(f);
    await recovery.issueReplacementRecoveryCode(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: randomUUID(), expectedRevision: execution.revision },
      f.actor,
    );
    const [candidate] = await h.db
      .select()
      .from(schema.stationPairingCodes)
      .where(
        and(
          eq(schema.stationPairingCodes.stationDeviceId, f.device.id),
          isNull(schema.stationPairingCodes.usedAt),
        ),
      );
    if (!candidate) throw new Error("Missing recovery candidate");
    return candidate;
  }
  function redeem(f: Source, candidate: Awaited<ReturnType<typeof issue>>) {
    return redeemReplacementRecovery({
      db: h.db,
      entitlements: h.entitlements,
      candidate,
      station: {
        id: f.device.id,
        tenantId: f.tenantId,
        kind: "station",
        name: "Source",
        organizationName: "Test",
        lineId: null,
        lineName: null,
      },
    });
  }
  it("preserves historical release on repeated revoke and permits only fresh authorized re-issuance", async () => {
    const f = await completedSource();
    const original = await state(f);
    const [assignment] = await h.db
      .select()
      .from(schema.workingDeviceAssignments)
      .where(eq(schema.workingDeviceAssignments.deviceId, f.device.id));
    // No apiKeyId and no outstanding code is still a security generation boundary.
    for (let i = 1; i <= 2; i++) {
      await devices.revoke(f.tenantId, f.device.id, f.actor);
      const current = await state(f);
      expect(current.device).toMatchObject({
        apiKeyId: null,
        revokedAt: original.device.revokedAt,
        credentialEpoch: original.device.credentialEpoch + i,
        securityRevocationRevision: i,
      });
      expect(current.execution.revision).toBe(original.execution.revision + i);
    }
    expect(
      await h.db
        .select()
        .from(schema.workingDeviceAssignments)
        .where(eq(schema.workingDeviceAssignments.deviceId, f.device.id)),
    ).toEqual([assignment]);
    const audits = await h.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.targetId, f.device.id),
          eq(schema.tenantAuditEvents.action, "device.replacement.recovery_security_revoked"),
        ),
      );
    expect(audits).toHaveLength(2);
    for (const [index, audit] of audits
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .entries()) {
      expect(audit).toMatchObject({
        organizationId: f.tenantId,
        actorUserId: f.actor.id,
        action: "device.replacement.recovery_security_revoked",
        outcome: "success",
        targetType: "station_device",
        targetId: f.device.id,
        before: { credentialEpoch: original.device.credentialEpoch + (index + 1) - 1 },
        after: {
          actorDomain: "cabinet",
          actorId: f.actor.id,
          deviceId: f.device.id,
          credentialEpoch: original.device.credentialEpoch + (index + 1),
          retiredPairingCodeIds: [],
          revokedAt: original.device.revokedAt?.toISOString(),
        },
      });
    }
    await expect(
      recovery.issueReplacementRecoveryCode(
        f.tenantId,
        f.prepared.preparation.id,
        { requestId: randomUUID(), expectedRevision: original.execution.revision },
        f.actor,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await redeem(f, await issue(f));
    const active = await state(f);
    if (!active.device.apiKeyId) throw new Error("Missing active recovery key");
    await devices.revoke(f.tenantId, f.device.id, f.actor);
    const revoked = await state(f);
    expect(revoked.device).toMatchObject({
      apiKeyId: null,
      revokedAt: original.device.revokedAt,
      credentialEpoch: active.device.credentialEpoch + 1,
    });
    expect(
      await h.db.select().from(schema.apikey).where(eq(schema.apikey.id, active.device.apiKeyId)),
    ).toHaveLength(0);
    expect(
      await h.db
        .select()
        .from(schema.workingDeviceReplacementReadinessIntents)
        .where(
          and(
            eq(schema.workingDeviceReplacementReadinessIntents.deviceId, f.device.id),
            eq(schema.workingDeviceReplacementReadinessIntents.state, "active"),
          ),
        ),
    ).toHaveLength(0);
  });
  it.each(["issue", "redeem"] as const)(
    "revoke fences a queued %s even after an earlier explicit revoke",
    async (operation) => {
      const f = await completedSource();
      await devices.revoke(f.tenantId, f.device.id, f.actor);
      const candidate = operation === "redeem" ? await issue(f) : null;
      const { execution } = await state(f);
      const entered = signal(),
        release = signal();
      const transaction = h.db.transaction.bind(h.db);
      vi.spyOn(h.db, "transaction").mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return transaction(...args);
      });
      const pending = (
        candidate
          ? redeem(f, candidate)
          : recovery.issueReplacementRecoveryCode(
              f.tenantId,
              f.prepared.preparation.id,
              { requestId: randomUUID(), expectedRevision: execution.revision },
              f.actor,
            )
      ).then(
        () => "accepted",
        () => "refused",
      );
      await entered.promise;
      try {
        await devices.revoke(f.tenantId, f.device.id, f.actor);
      } finally {
        release.resolve();
      }
      expect(await pending).toBe("refused");
      expect((await state(f)).device.apiKeyId).toBeNull();
    },
  );
  it.each(["issue", "redeem"] as const)(
    "revoke retires a %s that wins the lock while revoke is in flight",
    async (operation) => {
      const f = await completedSource();
      const candidate = operation === "redeem" ? await issue(f) : null;
      const entered = signal(),
        release = signal();
      const transaction = h.db.transaction.bind(h.db);
      vi.spyOn(h.db, "transaction").mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return transaction(...args);
      });
      const pending = devices.revoke(f.tenantId, f.device.id, f.actor);
      await entered.promise;
      let mintedKeyId: string | null = null;
      try {
        if (candidate) {
          await redeem(f, candidate);
          mintedKeyId = (await state(f)).device.apiKeyId;
        } else await issue(f);
      } finally {
        release.resolve();
      }
      await pending;
      expect((await state(f)).device.apiKeyId).toBeNull();
      expect(
        await h.db
          .select()
          .from(schema.stationPairingCodes)
          .where(
            and(
              eq(schema.stationPairingCodes.stationDeviceId, f.device.id),
              isNull(schema.stationPairingCodes.usedAt),
            ),
          ),
      ).toHaveLength(0);
      if (mintedKeyId)
        expect(
          await h.db.select().from(schema.apikey).where(eq(schema.apikey.id, mintedKeyId)),
        ).toHaveLength(0);
    },
  );
});
