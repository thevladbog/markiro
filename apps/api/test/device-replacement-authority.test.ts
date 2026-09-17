import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { StationDevicesService } from "../src/modules/station-devices/station-devices.service";
import { parseApprovedGrantPolicy } from "../src/modules/device-grants/grant-policy";
import { entitlementDigest } from "../src/subscriptions/entitlement-snapshot-reader";
import { StationWriteoffsService } from "../src/modules/station-writeoffs/station-writeoffs.service";
import { PickupOrdersService } from "../src/modules/pickup-orders/pickup-orders.service";
import { OperatorsService } from "../src/modules/operators/operators.service";
import { OrgProfileService } from "../src/modules/org-profile/org-profile.service";
import { assertDeviceReplacementNewWorkAllowed } from "../src/modules/device-licensing/device-replacement-admission";
import { DeviceReplacementExecutionService } from "../src/modules/device-licensing/device-replacement-execution.service";
import { replacementTargetFence } from "../src/modules/device-licensing/device-replacement-admission";
import { transitionWorkingAssignment } from "../src/subscriptions/working-device-assignments";
import { replacementExecutionHarness } from "./support/device-replacement-execution-fixture";
import { createPublishedAddon } from "./support/subscription-fixtures";

describe.skipIf(!process.env.DATABASE_URL)("Task 6 review: preserved offline authority", () => {
  const { db, connection, entitlements, audit, fixture, execution, service, drain, readiness } =
    replacementExecutionHarness();

  async function issuedDeviceGrant(
    f: Awaited<ReturnType<typeof fixture>>,
    end: Date,
    kind: "device" | "task" = "device",
  ) {
    if (!f.policy) throw new Error("policy missing");
    const [policyRow] = await db
      .select()
      .from(schema.entitlementLifecyclePolicies)
      .where(eq(schema.entitlementLifecyclePolicies.id, f.policy.id));
    if (!policyRow) throw new Error("policy row missing");
    const payload = {
      offlineGrant: {
        version: 1,
        maxOfflineMs: 1_200_000,
        maxCompletionMs: 1_200_000,
        taskBounds: {},
      },
    };
    const [historical] = await db
      .insert(schema.entitlementLifecyclePolicies)
      .values({
        ...policyRow,
        id: randomUUID(),
        policyKey: `prior-${randomUUID()}`,
        payload,
        payloadHash: entitlementDigest(payload),
      })
      .returning();
    const priorPolicy = parseApprovedGrantPolicy(historical);
    if (!priorPolicy) throw new Error("prior policy invalid");
    const taskSourceId = kind === "task" ? randomUUID() : null;
    if (taskSourceId)
      await db.insert(schema.deviceGrantTaskSources).values({
        id: taskSourceId,
        tenantId: f.tenantId,
        ownerKind: f.identity.kind,
        stationDeviceId: f.device.id,
        credentialEpoch: f.device.credentialEpoch,
        taskKind: "shift",
        taskId: randomUUID(),
        snapshotDigest: "a".repeat(64),
        scope: {},
        eventTypes: ["scan"],
        budget: [{ id: "events", unit: "event", maximum: 100 }],
        policyId: priorPolicy.id,
        policyRevision: priorPolicy.revision,
      });
    await db.insert(schema.deviceGrantIssuances).values({
      tenantId: f.tenantId,
      ownerKind: f.identity.kind,
      stationDeviceId: f.device.id,
      credentialEpoch: f.device.credentialEpoch,
      grantId: randomUUID(),
      kindOfGrant: kind,
      taskSourceId,
      policyId: priorPolicy.id,
      policyRevision: priorPolicy.revision,
      entitlementRevision: "1:1",
      requestIdentity: randomUUID(),
      headerKid: "test",
      compactJws: "review-fixture",
      payloadDigest: "b".repeat(64),
      issuedAt: new Date(),
      startNotAfter: kind === "device" ? end : null,
      completeNotAfter: kind === "task" ? end : null,
    });
  }

  it.each([
    ["revoke", "device"],
    ["revoke", "task"],
    ["rotate", "device"],
    ["rotate", "task"],
  ] as const)(
    "keeps %s historical %s authority despite a shorter current policy",
    async (change, kind) => {
      const f = await fixture("station", 1, true);
      // The original issuance is authoritative even after a shorter current policy
      // or a security revoke has made its credential epoch historical.
      const priorBoundary = new Date(Date.now() + 600_000);
      await issuedDeviceGrant(f, priorBoundary, kind);
      if (change === "revoke") {
        await new StationDevicesService(db, entitlements).revoke(f.tenantId, f.device.id, f.actor);
      } else {
        const keyId = randomUUID();
        await db.insert(schema.apikey).values({
          id: keyId,
          configId: "station",
          referenceId: f.tenantId,
          key: "rotated-test-digest",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        await db
          .update(schema.stationDevices)
          .set({ apiKeyId: keyId })
          .where(eq(schema.stationDevices.id, f.device.id));
      }
      const [revoked] = await db
        .select()
        .from(schema.stationDevices)
        .where(eq(schema.stationDevices.id, f.device.id));
      expect(revoked?.credentialEpoch).toBe(2);
      const p = await execution.previewEmergency(
        f.tenantId,
        f.prepared.preparation.id,
        {
          requestId: randomUUID(),
          expectedRevision: 1,
          reason: "Replace a lost, already revoked source",
        },
        f.actor,
      );
      expect(Date.parse(p.newWorkAllowedAt)).toBeGreaterThanOrEqual(priorBoundary.getTime());
    },
  );

  it.each(["normal", "emergency"] as const)(
    "carries upstream wait through %s replacement, restart and transfer repair",
    async (mode) => {
      const f = await fixture("station", 1, true);
      const originalBoundary = new Date(Date.now() + 600_000);
      await issuedDeviceGrant(f, originalBoundary);
      const p = await execution.previewEmergency(
        f.tenantId,
        f.prepared.preparation.id,
        { requestId: randomUUID(), expectedRevision: 1, reason: "Original source unavailable" },
        f.actor,
      );
      const first = await execution.executeEmergency(
        f.tenantId,
        f.prepared.preparation.id,
        { requestId: p.requestId, expectedRevision: 1, previewId: p.id, mode: "emergency" },
        f.actor,
      );
      const targetId = first.preparation.execution?.targetDeviceId;
      if (!targetId) throw new Error("target missing");
      // Pairing the waiting target is explicitly supported by Task 6.
      const keyId = randomUUID();
      await db.insert(schema.apikey).values({
        id: keyId,
        configId: "station",
        referenceId: f.tenantId,
        key: "review-target-digest",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const [target] = await db
        .update(schema.stationDevices)
        .set({ apiKeyId: keyId, pairedAt: new Date() })
        .where(eq(schema.stationDevices.id, targetId))
        .returning();
      if (!target) throw new Error("paired target missing");
      await db.transaction((tx) => transitionWorkingAssignment(tx, target));
      const nextPreview = await service.preview(
        f.tenantId,
        targetId,
        {
          requestId: randomUUID(),
          target: { name: "Next target", kind: "station" },
          reason: "Target also needs replacement",
        },
        f.actor,
      );
      const prepared = await service.confirm(
        f.tenantId,
        targetId,
        { requestId: nextPreview.requestId, previewId: nextPreview.id },
        f.actor,
      );
      const secondFixture = {
        ...f,
        device: target,
        prepared,
        identity: {
          tenantId: f.tenantId,
          deviceId: targetId,
          kind: "station" as const,
          apiKeyId: keyId,
        },
      };
      const d = await drain(secondFixture);
      expect((await readiness.report(secondFixture.identity, d.body)).eligibility.status).toBe(
        "eligible",
      );
      const preparation = (await service.list(f.tenantId, f.actor)).items.find(
        (item) => item.preparation.id === prepared.preparation.id,
      )?.preparation;
      if (!preparation) throw new Error("second preparation missing");
      const next = await (
        mode === "normal" ? execution.previewExecution : execution.previewEmergency
      ).call(
        execution,
        f.tenantId,
        preparation.id,
        {
          requestId: randomUUID(),
          expectedRevision: preparation.revision,
          ...(mode === "emergency" ? { reason: "Next source unavailable" } : {}),
        },
        f.actor,
      );
      expect(Date.parse(next.newWorkAllowedAt)).toBeGreaterThanOrEqual(originalBoundary.getTime());
      const restarted = new DeviceReplacementExecutionService(db, entitlements, audit);
      const input = {
        requestId: next.requestId,
        expectedRevision: preparation.revision,
        previewId: next.id,
        mode,
      };
      await connection.pool.query(
        `CREATE FUNCTION chain_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id = '${f.tenantId}' AND NEW.name = 'Next target' THEN RAISE EXCEPTION 'transfer interrupted'; END IF; RETURN NEW; END $$; CREATE TRIGGER chain_failure BEFORE INSERT ON station_devices FOR EACH ROW EXECUTE FUNCTION chain_failure()`,
      );
      try {
        await expect(
          (mode === "normal" ? restarted.executeNormal : restarted.executeEmergency).call(
            restarted,
            f.tenantId,
            preparation.id,
            input,
            f.actor,
          ),
        ).rejects.toThrow();
      } finally {
        await connection.pool.query(
          "DROP TRIGGER chain_failure ON station_devices; DROP FUNCTION chain_failure()",
        );
      }
      const receipt = await new DeviceReplacementExecutionService(
        db,
        entitlements,
        audit,
      ).repairExecution(f.tenantId, preparation.id);
      expect(await restarted.repairExecution(f.tenantId, preparation.id)).toEqual(receipt);
      const lastTarget = receipt.preparation.execution?.targetDeviceId;
      if (!lastTarget) throw new Error("last target missing");
      expect(
        await db.transaction((tx) => replacementTargetFence(tx, f.tenantId, lastTarget, 1)),
      ).toMatchObject({
        newWorkAllowedAt: Date.parse(receipt.preparation.execution!.newWorkAllowedAt),
      });
      expect(Date.parse(receipt.preparation.execution!.newWorkAllowedAt)).toBeGreaterThanOrEqual(
        originalBoundary.getTime(),
      );
      /* Original replay is stable after repair. */
      const replay = await (
        mode === "normal" ? restarted.executeNormal : restarted.executeEmergency
      ).call(
        restarted,
        f.tenantId,
        preparation.id,
        {
          requestId: next.requestId,
          expectedRevision: preparation.revision,
          previewId: next.id,
          mode,
        },
        f.actor,
      );
      expect(replay).toEqual(receipt);
      expect(Date.parse(receipt.preparation.execution!.newWorkAllowedAt)).toBeGreaterThanOrEqual(
        originalBoundary.getTime(),
      );
    },
  );

  it("refuses a fresh write-off from a target that has not reached its boundary", async () => {
    const f = await fixture("handheld", 1, true);
    const [subscription] = await db
      .select()
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, f.tenantId));
    if (!subscription) throw new Error("subscription missing");
    const addonVersionId = await createPublishedAddon(db, [{ entitlementKey: "handheld" }]);
    await db.insert(schema.subscriptionAddons).values({
      tenantId: f.tenantId,
      subscriptionId: subscription.id,
      addonVersionId,
      quantity: 1,
      source: "manual",
      status: "active",
      startsAt: new Date(Date.now() - 1000),
    });
    await issuedDeviceGrant(f, new Date(Date.now() + 600_000));
    const p = await execution.previewEmergency(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: randomUUID(), expectedRevision: 1, reason: "Source unavailable" },
      f.actor,
    );
    const receipt = await execution.executeEmergency(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: p.requestId, expectedRevision: 1, previewId: p.id, mode: "emergency" },
      f.actor,
    );
    const targetId = receipt.preparation.execution?.targetDeviceId;
    if (!targetId) throw new Error("target missing");
    const keyId = randomUUID();
    await db.insert(schema.apikey).values({
      id: keyId,
      configId: "station",
      referenceId: f.tenantId,
      key: "review-writeoff-target",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [paired] = await db
      .update(schema.stationDevices)
      .set({ apiKeyId: keyId, pairedAt: new Date() })
      .where(eq(schema.stationDevices.id, targetId))
      .returning();
    if (!paired) throw new Error("target missing");
    await db.transaction((tx) => transitionWorkingAssignment(tx, paired));
    await expect(
      db.transaction((tx) => assertDeviceReplacementNewWorkAllowed(tx, f.tenantId, targetId)),
    ).rejects.toMatchObject({ status: 409 });
    const operatorId = randomUUID(),
      reasonId = randomUUID();
    await db
      .insert(schema.pickupTenantPolicies)
      .values({ tenantId: f.tenantId, limitsEnabled: false })
      .onConflictDoNothing();
    await db
      .insert(schema.employees)
      .values({ id: operatorId, tenantId: f.tenantId, fullName: "Test operator" });
    await db.insert(schema.employeePickupPolicies).values({
      tenantId: f.tenantId,
      employeeId: operatorId,
      limitMode: "unlimited",
      canWriteoff: true,
    });
    await db
      .insert(schema.pickupOrderReasons)
      .values({ id: reasonId, tenantId: f.tenantId, name: "Damage" });
    await db
      .insert(schema.products)
      .values({ tenantId: f.tenantId, gtin14: "04600682000013", name: "Water" });
    const unexpectedExternalCall = async (): Promise<never> => {
      throw new Error("unexpected external service call");
    };
    const profiles = new OrgProfileService(
      db,
      { put: unexpectedExternalCall, get: unexpectedExternalCall, delete: unexpectedExternalCall },
      { counterState: unexpectedExternalCall, seedCounter: unexpectedExternalCall },
    );
    const writeoffs = new StationWriteoffsService(
      db,
      new PickupOrdersService(db, new OperatorsService(db), entitlements, profiles),
    );
    await expect(
      writeoffs.create(f.tenantId, targetId, {
        deviceSeq: 1,
        operatorId,
        writeoffReasonId: reasonId,
        items: [{ rawKm: `010460068200001321REVIEW123456789012${String.fromCharCode(29)}93Abcd` }],
        boxes: [],
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
