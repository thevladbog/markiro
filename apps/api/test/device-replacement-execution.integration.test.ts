import { randomUUID, generateKeyPairSync } from "node:crypto";
import { schema } from "@markiro/db";
import { platformCapabilitiesForRole } from "@markiro/platform-contracts";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { DeviceReplacementExecutionService } from "../src/modules/device-licensing/device-replacement-execution.service";
import { GrantIssuerService } from "../src/modules/device-grants/grant-issuer.service";
import { configureGrantSigning } from "../src/modules/device-grants/grant-keyset";
import { assertDeviceReplacementNewWorkAllowed } from "../src/modules/device-licensing/device-replacement-admission";
import {
  transitionWorkingAssignment,
  countWorkingDeviceUsage,
} from "../src/subscriptions/working-device-assignments";
import { replacementExecutionHarness } from "./support/device-replacement-execution-fixture";
describe.skipIf(!process.env.DATABASE_URL)("replacement execution", () => {
  const {
    db,
    entitlements,
    audit,
    service,
    readiness,
    execution,
    repair,
    fixture,
    drain,
    ready,
    preview,
  } = replacementExecutionHarness();
  it("transfers exactly one occupied slot only after revocation and replays a stable receipt", async () => {
    const f = await ready();
    const p = await preview(f);
    const beforeUsage = await countWorkingDeviceUsage(db, f.tenantId);
    const receipt = await execution.executeNormal(f.tenantId, f.preparation.id, p.request, f.actor);
    expect(receipt.preparation).toMatchObject({
      state: "completed",
      revision: 5,
      observation: f.prepared.preparation.observation,
      execution: {
        mode: "normal",
        revision: 3,
        step: "transferred",
        recoveryState: "not_required",
      },
    });
    const targetId = receipt.preparation.execution!.targetDeviceId;
    expect(targetId).toEqual(expect.any(String));
    expect(await execution.executeNormal(f.tenantId, f.preparation.id, p.request, f.actor)).toEqual(
      receipt,
    );
    expect(await countWorkingDeviceUsage(db, f.tenantId)).toBe(beforeUsage);
    const devices = await db
      .select()
      .from(schema.stationDevices)
      .where(eq(schema.stationDevices.tenantId, f.tenantId));
    expect(devices).toHaveLength(2);
    expect(devices.find((d) => d.id === f.device.id)).toMatchObject({
      apiKeyId: null,
      revokedAt: expect.any(Date),
    });
    expect(devices.find((d) => d.id === targetId)).toMatchObject({
      name: "Target",
      kind: "station",
      apiKeyId: null,
      pairedAt: null,
    });
    expect(
      await db.select().from(schema.apikey).where(eq(schema.apikey.id, f.identity.apiKeyId)),
    ).toHaveLength(0);
    const assignments = await db
      .select()
      .from(schema.workingDeviceAssignments)
      .where(eq(schema.workingDeviceAssignments.tenantId, f.tenantId));
    expect(assignments.find((a) => a.deviceId === f.device.id)).toMatchObject({
      state: "released",
      releaseReason: "replacement_transferred",
    });
    expect(assignments.find((a) => a.deviceId === targetId)).toMatchObject({
      state: "reserved",
      releaseReason: null,
    });
    expect(
      await db
        .select()
        .from(schema.stationPairingCodes)
        .where(eq(schema.stationPairingCodes.tenantId, f.tenantId)),
    ).toHaveLength(0);
    const events = await db
      .select()
      .from(schema.workingDeviceEvents)
      .where(eq(schema.workingDeviceEvents.requestId, p.request.requestId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: f.tenantId,
      deviceId: f.device.id,
      actorDomain: "cabinet",
      actorId: f.actor.id,
      action: "replacement_transferred",
      response: receipt,
      after: receipt.preparation,
    });
    const audits = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.requestId, p.request.requestId));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      organizationId: f.tenantId,
      actorUserId: f.actor.id,
      action: "device.replacement.transferred",
      outcome: "success",
      targetType: "device_replacement",
      targetId: f.preparation.id,
      after: receipt.preparation,
    });
    expect((await service.list(f.tenantId, f.actor)).items[0]?.preparation).toEqual(
      receipt.preparation,
    );
    const intents = await db
      .select()
      .from(schema.workingDeviceReplacementReadinessIntents)
      .where(eq(schema.workingDeviceReplacementReadinessIntents.tenantId, f.tenantId));
    expect(intents[0]).toMatchObject({ state: "completed", closedAt: expect.any(Date) });
  });
  it("persists actor-bound previews across instances and rejects changed retries", async () => {
    const f = await ready();
    const p = await preview(f);
    const restarted = new DeviceReplacementExecutionService(db, entitlements, audit);
    expect(
      await restarted.previewExecution(
        f.tenantId,
        f.preparation.id,
        { requestId: p.request.requestId, expectedRevision: f.preparation.revision },
        f.actor,
      ),
    ).toEqual(p.p);
    await expect(
      restarted.executeNormal(
        f.tenantId,
        f.preparation.id,
        { ...p.request, requestId: randomUUID() },
        f.actor,
      ),
    ).rejects.toMatchObject({ status: 409 });
    const other = await fixture();
    await expect(
      restarted.executeNormal(other.tenantId, f.preparation.id, p.request, other.actor),
    ).rejects.toMatchObject({ status: 404 });
    await db
      .update(schema.member)
      .set({ role: "viewer" })
      .where(eq(schema.member.userId, f.actor.id));
    await expect(
      restarted.executeNormal(f.tenantId, f.preparation.id, p.request, f.actor),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("revalidates platform factors and writes exact platform execution audit", async () => {
    const f = await ready();
    const userId = randomUUID();
    const factorId = randomUUID();
    await db.insert(schema.platformUsers).values({
      id: userId,
      email: `${userId}@example.invalid`,
      name: "Operator",
      role: "platform_admin",
      status: "active",
      twoFactorEnabled: true,
    });
    await db
      .insert(schema.platformTwoFactors)
      .values({ id: factorId, userId, secret: "fixture", backupCodes: "fixture", verified: true });
    const actor = {
      domain: "platform" as const,
      principal: {
        userId,
        role: "platform_admin" as const,
        capabilities: platformCapabilitiesForRole.platform_admin,
        twoFactorReady: true,
      },
    };
    const input = { requestId: randomUUID(), expectedRevision: f.preparation.revision };
    const p = await execution.previewExecution(f.tenantId, f.preparation.id, input, actor);
    const command = { ...input, previewId: p.id, mode: "normal" as const };
    await db
      .update(schema.platformTwoFactors)
      .set({ verified: false })
      .where(eq(schema.platformTwoFactors.id, factorId));
    await expect(
      execution.executeNormal(f.tenantId, f.preparation.id, command, actor),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await db.select().from(schema.apikey).where(eq(schema.apikey.id, f.identity.apiKeyId)),
    ).toHaveLength(1);
    await db
      .update(schema.platformTwoFactors)
      .set({ verified: true })
      .where(eq(schema.platformTwoFactors.id, factorId));
    const receipt = await execution.executeNormal(f.tenantId, f.preparation.id, command, actor);
    const events = await db
      .select()
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.requestId, input.requestId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: f.tenantId,
      actorPlatformUserId: userId,
      actorRole: "platform_admin",
      action: "device.replacement.transferred",
      outcome: "success",
      targetType: "device_replacement",
      targetId: f.preparation.id,
      requestId: input.requestId,
      reason: null,
      before: { state: "executing" },
      after: {
        ...receipt.preparation,
        readiness: {
          intentId: f.d.intent.intentId,
          receivedAt: receipt.preparation.readiness?.receivedAt,
          eligibility: { status: "eligible", reasons: [] },
        },
      },
    });
    expect(events[0]?.after).not.toHaveProperty("readiness.credentialEpoch");
  });
  it("rejects authority changes and newly quarantined native evidence before revoking the key", async () => {
    for (const change of ["authority", "native_evidence"] as const) {
      const f = await ready();
      const p = await preview(f);
      if (change === "authority")
        await db
          .update(schema.stationDevices)
          .set({ revokedAt: new Date() })
          .where(eq(schema.stationDevices.id, f.device.id));
      else
        await db.insert(schema.deviceGrantEvidence).values({
          tenantId: f.tenantId,
          ownerKind: "station",
          stationDeviceId: f.device.id,
          credentialEpoch: 1,
          evidenceIdentity: randomUUID(),
          payloadDigest: "a".repeat(64),
          payload: {},
          disposition: "quarantined",
          reason: "grant_missing_or_unrecognized",
        });
      await expect(
        execution.executeNormal(f.tenantId, f.preparation.id, p.request, f.actor),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await db.select().from(schema.apikey).where(eq(schema.apikey.id, f.identity.apiKeyId)),
      ).toHaveLength(1);
    }
  });
  it("rechecks newly opened warehouse pallets before normal transfer revokes the source", async () => {
    const f = await ready();
    const p = await preview(f);
    const productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId: f.tenantId,
      gtin14: "04680089900024",
      name: "Product",
      status: "active",
    });
    await db.insert(schema.pallets).values({
      tenantId: f.tenantId,
      kind: "warehouse",
      productId,
      deviceId: f.device.id,
      terminalId: f.device.id,
      devicePalletId: "opened-after-preview",
    });
    await expect(
      execution.executeNormal(f.tenantId, f.preparation.id, p.request, f.actor),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await db.select().from(schema.apikey).where(eq(schema.apikey.id, f.identity.apiKeyId)),
    ).toHaveLength(1);
  });
  it("binds warehouse pallet changes into emergency execution preview facts", async () => {
    const f = await fixture("station", 1, true);
    const p = await execution.previewEmergency(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: randomUUID(), expectedRevision: 1, reason: "Source destroyed" },
      f.actor,
    );
    const productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId: f.tenantId,
      gtin14: "04680089900024",
      name: "Product",
      status: "active",
    });
    await db.insert(schema.pallets).values({
      tenantId: f.tenantId,
      kind: "warehouse",
      productId,
      deviceId: f.device.id,
      terminalId: f.device.id,
      devicePalletId: "opened-after-preview",
    });
    await expect(
      execution.executeEmergency(
        f.tenantId,
        f.prepared.preparation.id,
        { requestId: p.requestId, expectedRevision: 1, previewId: p.id, mode: "emergency" },
        f.actor,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await db.select().from(schema.apikey).where(eq(schema.apikey.id, f.identity.apiKeyId)),
    ).toHaveLength(1);
  });
  it("enforces execution preview immutability and tenant/source preparation identity in PostgreSQL", async () => {
    const f = await ready();
    const p = await preview(f);
    await expect(
      db
        .update(schema.workingDeviceReplacementExecutionPreviews)
        .set({ actorId: "other" })
        .where(eq(schema.workingDeviceReplacementExecutionPreviews.id, p.p.id)),
    ).rejects.toThrow();
    await expect(
      db
        .delete(schema.workingDeviceReplacementExecutionPreviews)
        .where(eq(schema.workingDeviceReplacementExecutionPreviews.id, p.p.id)),
    ).rejects.toThrow();
    const [stored] = await db
      .select()
      .from(schema.workingDeviceReplacementExecutionPreviews)
      .where(eq(schema.workingDeviceReplacementExecutionPreviews.id, p.p.id));
    if (!stored) throw new Error("preview missing");
    const foreign = await fixture();
    await expect(
      db.insert(schema.workingDeviceReplacementExecutionPreviews).values({
        ...stored,
        id: randomUUID(),
        requestId: randomUUID(),
        tenantId: foreign.tenantId,
        deviceId: foreign.device.id,
      }),
    ).rejects.toThrow();
  });
  it.each(["prepared", "draining"])("rejects %s normal execution", async (state) => {
    const f = await fixture();
    if (state === "draining") await drain(f);
    await expect(
      execution.previewExecution(
        f.tenantId,
        f.prepared.preparation.id,
        { requestId: randomUUID(), expectedRevision: state === "prepared" ? 1 : 2 },
        f.actor,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("invalidates a preview on a newer clean report, a storage high-water advance, or expired evidence", async () => {
    const f = await ready();
    const p = await preview(f);
    await readiness.report(f.identity, { ...f.d.body, requestId: randomUUID(), reportSequence: 1 });
    await expect(
      execution.executeNormal(f.tenantId, f.preparation.id, p.request, f.actor),
    ).rejects.toMatchObject({ status: 409 });
    const next = await preview(f);
    await readiness.report(f.identity, {
      ...f.d.body,
      requestId: randomUUID(),
      reportSequence: 2,
      storageRevision: 4,
    });
    await readiness.report(f.identity, {
      ...f.d.body,
      requestId: randomUUID(),
      reportSequence: 3,
      storageRevision: 1,
    });
    await expect(
      execution.executeNormal(f.tenantId, f.preparation.id, next.request, f.actor),
    ).rejects.toMatchObject({ status: 409 });
    const fresh = await ready();
    const expired = await preview(fresh);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    await expect(
      execution.executeNormal(fresh.tenantId, fresh.preparation.id, expired.request, fresh.actor),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("serializes duplicate execute and repair into a single target", async () => {
    const f = await ready();
    const p = await preview(f);
    const receipts = await Promise.all(
      Array.from({ length: 3 }, () =>
        execution.executeNormal(f.tenantId, f.preparation.id, p.request, f.actor),
      ),
    );
    expect(receipts[1]).toEqual(receipts[0]);
    expect(receipts[2]).toEqual(receipts[0]);
    expect(await repair.repairExecution(f.tenantId, f.preparation.id)).toEqual(receipts[0]);
    expect(
      await db
        .select()
        .from(schema.stationDevices)
        .where(eq(schema.stationDevices.tenantId, f.tenantId)),
    ).toHaveLength(2);
  });
  it("emergency boundary uses every issued device/task grant and denies target authority until it expires", async () => {
    const f = await fixture("station", 1, true);
    if (!f.policy) throw new Error("policy");
    const now = new Date();
    const deviceBoundary = new Date(now.getTime() + 60_000);
    const taskBoundary = new Date(now.getTime() + 120_000);
    const owner = {
      tenantId: f.tenantId,
      ownerKind: "station" as const,
      stationDeviceId: f.device.id,
      credentialEpoch: 1,
    };
    const sourceId = randomUUID();
    await db.insert(schema.deviceGrantTaskSources).values({
      id: sourceId,
      ...owner,
      taskKind: "shift",
      taskId: randomUUID(),
      snapshotDigest: "a".repeat(64),
      scope: {},
      eventTypes: ["shift.close.v1"],
      budget: [{ id: "close", unit: "event", maximum: 1 }],
      policyId: f.policy.id,
      policyRevision: f.policy.revision,
    });
    for (const kind of ["device", "task"] as const)
      await db.insert(schema.deviceGrantIssuances).values({
        ...owner,
        grantId: randomUUID(),
        kindOfGrant: kind,
        taskSourceId: kind === "task" ? sourceId : null,
        policyId: f.policy.id,
        policyRevision: f.policy.revision,
        entitlementRevision: "1:1",
        requestIdentity: randomUUID(),
        headerKid: "test",
        compactJws: "test-only-signed-bytes",
        payloadDigest: "b".repeat(64),
        issuedAt: now,
        startNotAfter: kind === "device" ? deviceBoundary : null,
        completeNotAfter: kind === "task" ? taskBoundary : null,
      });
    const p = await execution.previewEmergency(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: randomUUID(), expectedRevision: 1, reason: "Source destroyed" },
      f.actor,
    );
    expect(p.newWorkAllowedAt).toBe(taskBoundary.toISOString());
    const receipt = await execution.executeEmergency(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: p.requestId, expectedRevision: 1, previewId: p.id, mode: "emergency" },
      f.actor,
    );
    expect(receipt.preparation.execution).toMatchObject({
      mode: "emergency",
      newWorkAllowedAt: taskBoundary.toISOString(),
      recoveryState: "required",
    });
    const targetId = receipt.preparation.execution?.targetDeviceId;
    if (!targetId) throw new Error("target");
    const targetKey = randomUUID();
    await db.insert(schema.apikey).values({
      id: targetKey,
      configId: "station",
      referenceId: f.tenantId,
      key: "test-only-target",
      createdAt: now,
      updatedAt: now,
    });
    const [target] = await db
      .update(schema.stationDevices)
      .set({ apiKeyId: targetKey, pairedAt: new Date() })
      .where(eq(schema.stationDevices.id, targetId))
      .returning();
    if (!target) throw new Error("target");
    await db.transaction((tx) => transitionWorkingAssignment(tx, target));
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const signing = configureGrantSigning({
      OFFLINE_GRANT_ORIGIN: "https://example.invalid",
      OFFLINE_GRANT_KID: "test",
      OFFLINE_GRANT_PRIVATE_KEY_PEM: keys.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      OFFLINE_GRANT_KEYSET_JSON: JSON.stringify({
        protocol: "offline-grants-v1",
        origin: "https://example.invalid",
        revision: "1",
        keys: [{ kid: "test", jwk: keys.publicKey.export({ format: "jwk" }) }],
        retiredKids: [],
      }),
    });
    const issuer = new GrantIssuerService(db, entitlements, signing, () => Date.now());
    const identity = {
      tenantId: f.tenantId,
      deviceId: targetId,
      kind: "station" as const,
      apiKeyId: targetKey,
    };
    await expect(
      db.transaction((tx) => assertDeviceReplacementNewWorkAllowed(tx, f.tenantId, targetId)),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: "device_replacement_waiting",
        newWorkAllowedAt: taskBoundary.toISOString(),
      },
    });
    expect(await issuer.issueDevice(identity, randomUUID())).toMatchObject({
      status: "denied",
      reason: "not_entitled",
    });
    expect(await issuer.configuration(identity)).toMatchObject({
      mode: "strict",
      replacement: {
        executionId: receipt.preparation.execution?.id,
        newWorkAllowedAt: taskBoundary.getTime(),
      },
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(taskBoundary);
    await expect(
      db.transaction((tx) => assertDeviceReplacementNewWorkAllowed(tx, f.tenantId, targetId)),
    ).resolves.toBeUndefined();
    expect(await issuer.issueDevice(identity, randomUUID())).toMatchObject({ status: "issued" });
    expect((await issuer.configuration(identity)).replacement?.serverTime).toBe(
      taskBoundary.getTime(),
    );
  });
  it("unknown exact issuance uses approved policy maximum and never invents a policy", async () => {
    const f = await fixture("station", 1, true);
    const p = await execution.previewEmergency(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: randomUUID(), expectedRevision: 1, reason: "Disconnected" },
      f.actor,
    );
    expect(Date.parse(p.newWorkAllowedAt)).toBe(Date.parse(p.expiresAt) + 2000);
    const unconfigured = await fixture();
    await expect(
      execution.previewEmergency(
        unconfigured.tenantId,
        unconfigured.prepared.preparation.id,
        { requestId: randomUUID(), expectedRevision: 1, reason: "Disconnected" },
        unconfigured.actor,
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: "device_replacement_offline_boundary_unknown" },
    });
  });
});
