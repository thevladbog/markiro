import { ShiftsService } from "../src/modules/shifts/shifts.service";
import { StationInventoryAccessService } from "../src/modules/inventories/station-inventory-access.service";
import { EntitlementAdmissionService } from "../src/subscriptions/entitlement-admission.service";
import { assertDeviceReplacementNewWorkAllowed } from "../src/modules/device-licensing/device-replacement-admission";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DeviceReplacementReadinessRequest } from "@markiro/platform-contracts";
import { DeviceReplacementService } from "../src/modules/device-licensing/device-replacement.service";
import { DeviceReplacementReadinessService } from "../src/modules/device-licensing/device-replacement-readiness.service";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { transitionWorkingAssignment } from "../src/subscriptions/working-device-assignments";
import { createOrganization } from "./support/subscription-fixtures";

describe.skipIf(!process.env.DATABASE_URL)("replacement drain readiness", () => {
  const name = `replacement_readiness_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  const maintenance = createDb(url.toString());
  url.pathname = `/${name}`;
  const connection = createDb(url.toString());
  const db = connection.db;
  const entitlements = new EntitlementsService(db, "managed_only");
  const audit = new PlatformAuditService();
  const service = new DeviceReplacementService(db, entitlements, audit);
  const readiness = new DeviceReplacementReadinessService(db, entitlements, audit);
  let created = false;
  afterEach(() => vi.useRealTimers());
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
  async function fixture(kind: "station" | "handheld" = "station", credentialEpoch = 1) {
    const tenantId = await createOrganization(db);
    const id = randomUUID();
    await db.insert(schema.user).values({ id, name: "Owner", email: `${id}@example.invalid` });
    await db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: tenantId,
      userId: id,
      role: "owner",
      createdAt: new Date(),
    });
    const apiKeyId = randomUUID();
    await db.insert(schema.apikey).values({
      id: apiKeyId,
      configId: "station",
      referenceId: tenantId,
      key: "test-digest",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [device] = await db
      .insert(schema.stationDevices)
      .values({ tenantId, name: "Source", kind, apiKeyId, pairedAt: new Date(), credentialEpoch })
      .returning();
    if (!device) throw new Error("fixture");
    await db.transaction((tx) => transitionWorkingAssignment(tx, device));
    const actor = { domain: "cabinet" as const, id };
    const preview = await service.preview(
      tenantId,
      device.id,
      { requestId: randomUUID(), target: { name: "Target", kind }, reason: "replace" },
      actor,
    );
    const prepared = await service.confirm(
      tenantId,
      device.id,
      { requestId: preview.requestId, previewId: preview.id },
      actor,
    );
    return {
      tenantId,
      device,
      actor,
      prepared,
      identity: { tenantId, deviceId: device.id, kind, apiKeyId },
    };
  }
  async function drain(f: Awaited<ReturnType<typeof fixture>>) {
    const request = { requestId: randomUUID(), expectedRevision: 1 };
    const receipt = await readiness.requestDrain(
      f.tenantId,
      f.prepared.preparation.id,
      request,
      f.actor,
    );
    const intent = await readiness.currentIntent(f.identity);
    if (!intent) throw new Error("intent missing");
    const body: DeviceReplacementReadinessRequest = {
      requestId: randomUUID(),
      intentId: intent.intentId,
      credentialEpoch: f.device.credentialEpoch,
      reportSequence: 0,
      clientBuild: "test-v1",
      storageRevision: 1,
      pending: {
        scans: 0,
        inventories: 0,
        shiftClosures: 0,
        productLabels: 0,
        boxes: 0,
        exceptions: 0,
      },
      conflicts: 0,
      unknownPrints: 0,
      activeTasks: [],
      installedGrants: [],
      journal: { digest: "a".repeat(64), highestSequence: 0 },
    };
    return { request, receipt, intent, body };
  }
  it("projects exact stored channel measurements for cabinet and platform list consumers", async () => {
    const f = await fixture();
    const d = await drain(f);
    const body = {
      ...d.body,
      pending: { ...d.body.pending, scans: 7, exceptions: "unsupported" as const },
      storageRevision: 19,
      journal: { ...d.body.journal, highestSequence: 23 },
    };
    await readiness.report(f.identity, body);
    const list = await service.list(f.tenantId, f.actor);
    expect(list.items[0]?.preparation.readiness).toMatchObject({
      report: {
        pending: body.pending,
        conflicts: 0,
        unknownPrints: 0,
        activeTasks: [],
        installedGrants: [],
        storageRevision: 19,
        journal: body.journal,
      },
    });
    expect(JSON.stringify(list)).not.toContain('"requestId"');
  });
  it("creates one durable drain receipt with exact actor audit and preserves prepared admission", async () => {
    const f = await fixture();
    expect(await readiness.currentIntent(f.identity)).toBeNull();
    const d = await drain(f);
    expect(d.receipt.preparation).toMatchObject({ state: "draining", revision: 2 });
    expect(
      await readiness.requestDrain(f.tenantId, f.prepared.preparation.id, d.request, f.actor),
    ).toEqual(d.receipt);
    await expect(
      readiness.requestDrain(
        f.tenantId,
        f.prepared.preparation.id,
        { ...d.request, expectedRevision: 2 },
        f.actor,
      ),
    ).rejects.toMatchObject({ status: 409 });
    const intents = await db
      .select()
      .from(schema.workingDeviceReplacementReadinessIntents)
      .where(eq(schema.workingDeviceReplacementReadinessIntents.tenantId, f.tenantId));
    expect(intents).toHaveLength(1);
    const [event] = await db
      .select()
      .from(schema.workingDeviceEvents)
      .where(eq(schema.workingDeviceEvents.requestId, d.request.requestId));
    expect(event).toMatchObject({
      tenantId: f.tenantId,
      deviceId: f.device.id,
      actorDomain: "cabinet",
      actorId: f.actor.id,
      action: "replacement_drain_requested",
      response: d.receipt,
      before: f.prepared.preparation,
      after: d.receipt.preparation,
    });
    expect((await service.list(f.tenantId, f.actor)).items[0]?.preparation).toEqual(
      d.receipt.preparation,
    );
  });
  it.each(["station", "handheld"] as const)(
    "%s: fresh zero report becomes ready, exact replay survives and later blocked report regresses",
    async (kind) => {
      const f = await fixture(kind);
      const d = await drain(f);
      const response = await readiness.report(f.identity, d.body);
      expect(response.eligibility).toEqual({ status: "eligible", reasons: [] });
      expect(await readiness.report(f.identity, d.body)).toEqual(response);
      expect((await service.list(f.tenantId, f.actor)).items[0]?.preparation.state).toBe("ready");
      await expect(
        readiness.report(f.identity, { ...d.body, storageRevision: 2 }),
      ).rejects.toMatchObject({ status: 409 });
      const blocked = await readiness.report(f.identity, {
        ...d.body,
        requestId: randomUUID(),
        reportSequence: 1,
        pending: { ...d.body.pending, boxes: 1 },
      });
      expect(blocked.eligibility).toEqual({ status: "blocked", reasons: ["pending_boxes"] });
      expect((await service.list(f.tenantId, f.actor)).items[0]?.preparation.state).toBe(
        "draining",
      );
      const [auditRow] = await db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.requestId, d.body.requestId));
      expect(auditRow).toMatchObject({
        organizationId: f.tenantId,
        actorUserId: null,
        action: "device.replacement.readiness.reported",
        outcome: "success",
        targetType: "device_replacement_readiness_report",
        after: {
          actorDomain: "station_device",
          actorId: f.device.id,
          deviceKind: kind,
          credentialEpoch: f.device.credentialEpoch,
          intentId: d.intent.intentId,
          eligibility: response.eligibility,
        },
      });
    },
  );
  it("rejects cross-tenant, cross-device, wrong key/kind and credential epoch spoofing", async () => {
    const f = await fixture();
    const other = await fixture();
    const d = await drain(f);
    const peerKeyId = randomUUID();
    await db.insert(schema.apikey).values({
      id: peerKeyId,
      configId: "station",
      referenceId: f.tenantId,
      key: "peer-test-digest",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [peer] = await db
      .insert(schema.stationDevices)
      .values({
        tenantId: f.tenantId,
        name: "Peer",
        kind: "station",
        apiKeyId: peerKeyId,
        pairedAt: new Date(),
      })
      .returning();
    if (!peer) throw new Error("peer fixture missing");
    const peerIdentity = { ...f.identity, deviceId: peer.id, apiKeyId: peerKeyId };
    expect(await readiness.currentIntent(peerIdentity)).toBeNull();
    await expect(readiness.report(peerIdentity, d.body)).rejects.toMatchObject({ status: 404 });
    expect(await readiness.currentIntent(other.identity)).toBeNull();
    await expect(readiness.report(other.identity, d.body)).rejects.toMatchObject({ status: 404 });
    await expect(
      readiness.currentIntent({ ...f.identity, tenantId: other.tenantId }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      readiness.currentIntent({ ...f.identity, apiKeyId: other.identity.apiKeyId }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      readiness.currentIntent({ ...f.identity, kind: "handheld" }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      readiness.report(f.identity, { ...d.body, credentialEpoch: d.body.credentialEpoch + 1 }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      readiness.requestDrain(
        other.tenantId,
        f.prepared.preparation.id,
        { requestId: randomUUID(), expectedRevision: 1 },
        other.actor,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
  it.each([
    { patch: { conflicts: 1 }, reason: "conflicts" },
    { patch: { unknownPrints: "unsupported" }, reason: "client_upgrade_required" },
    { patch: { activeTasks: [{ taskId: randomUUID(), kind: "shift" }] }, reason: "active_tasks" },
    { patch: { installedGrants: [{ grantId: randomUUID() }] }, reason: "installed_grants" },
  ] satisfies Array<{ patch: Partial<DeviceReplacementReadinessRequest>; reason: string }>)(
    "keeps blocking evidence $reason",
    async ({ patch, reason }) => {
      const f = await fixture();
      const d = await drain(f);
      const response = await readiness.report(f.identity, { ...d.body, ...patch });
      expect(response.eligibility).toMatchObject({
        status: "blocked",
        reasons: expect.arrayContaining([reason]),
      });
    },
  );
  it("stores out-of-order evidence as stale without letting it establish readiness", async () => {
    const f = await fixture();
    const d = await drain(f);
    await readiness.report(f.identity, {
      ...d.body,
      requestId: randomUUID(),
      reportSequence: 2,
      conflicts: 1,
    });
    const stale = await readiness.report(f.identity, d.body);
    expect(stale.eligibility).toEqual({ status: "blocked", reasons: ["report_stale"] });
    expect(
      await db
        .select()
        .from(schema.workingDeviceReplacementReadinessReports)
        .where(eq(schema.workingDeviceReplacementReadinessReports.tenantId, f.tenantId)),
    ).toHaveLength(2);
    expect((await service.list(f.tenantId, f.actor)).items[0]?.preparation.state).toBe("draining");
  });
  it("fences online source work only after drain and releases it on cancellation", async () => {
    const f = await fixture();
    await db.transaction((tx) =>
      assertDeviceReplacementNewWorkAllowed(tx, f.tenantId, f.device.id),
    );
    const d = await drain(f);
    await expect(
      db.transaction((tx) => assertDeviceReplacementNewWorkAllowed(tx, f.tenantId, f.device.id)),
    ).rejects.toMatchObject({ status: 409, response: { code: "device_replacement_draining" } });
    await readiness.report(f.identity, d.body);
    await expect(
      db.transaction((tx) => assertDeviceReplacementNewWorkAllowed(tx, f.tenantId, f.device.id)),
    ).rejects.toMatchObject({ status: 409 });
    await service.cancel(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: randomUUID(), expectedRevision: 3 },
      f.actor,
    );
    expect(await readiness.currentIntent(f.identity)).toBeNull();
    await db.transaction((tx) =>
      assertDeviceReplacementNewWorkAllowed(tx, f.tenantId, f.device.id),
    );
  });
  it("does not present ready after facts change or the server report TTL expires", async () => {
    const f = await fixture();
    const d = await drain(f);
    await readiness.report(f.identity, d.body);
    await db
      .update(schema.stationDevices)
      .set({ name: "changed" })
      .where(eq(schema.stationDevices.id, f.device.id));
    const listed = (await service.list(f.tenantId, f.actor)).items[0]?.preparation;
    expect(listed).toMatchObject({
      state: "draining",
      readiness: { eligibility: { status: "blocked", reasons: ["facts_changed"] } },
    });
  });
  it("conflicts when an older report sequence is reused under a different request", async () => {
    const f = await fixture();
    const d = await drain(f);
    await readiness.report(f.identity, d.body);
    await readiness.report(f.identity, { ...d.body, requestId: randomUUID(), reportSequence: 2 });
    await expect(
      readiness.report(f.identity, { ...d.body, requestId: randomUUID(), reportSequence: 0 }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("uses authoritative grant expiry and binds the intent to configuration facts", async () => {
    const f = await fixture();
    const policyId = randomUUID();
    const approverId = randomUUID();
    const grantId = randomUUID();
    await db.insert(schema.platformUsers).values({
      id: approverId,
      name: "Approver",
      email: `${approverId}@example.invalid`,
      role: "platform_admin",
    });
    await db.insert(schema.entitlementLifecyclePolicies).values({
      id: policyId,
      policyKey: policyId,
      version: 1,
      status: "approved",
      payload: {},
      payloadHash: "a".repeat(64),
      decisionReference: "fixture",
      approvedAt: new Date(),
      approvedByPlatformUserId: approverId,
      createdByPlatformUserId: approverId,
    });
    await db.insert(schema.deviceGrantIssuances).values({
      grantId,
      tenantId: f.tenantId,
      ownerKind: "station",
      stationDeviceId: f.device.id,
      credentialEpoch: f.device.credentialEpoch,
      kindOfGrant: "device",
      policyId,
      policyRevision: "fixture",
      entitlementRevision: "fixture",
      requestIdentity: randomUUID(),
      headerKid: "fixture",
      compactJws: "header.payload.signature",
      payloadDigest: "b".repeat(64),
      issuedAt: new Date(Date.now() - 10_000),
      startNotAfter: new Date(Date.now() + 1_000),
    });
    const d = await drain(f);
    expect(
      (await readiness.report(f.identity, { ...d.body, installedGrants: [{ grantId }] }))
        .eligibility,
    ).toMatchObject({ status: "blocked", reasons: ["installed_grants"] });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2_000);
    expect(
      (
        await readiness.report(f.identity, {
          ...d.body,
          requestId: randomUUID(),
          reportSequence: 1,
          installedGrants: [{ grantId }],
        })
      ).eligibility.status,
    ).toBe("eligible");
    await db.insert(schema.deviceGrantConfigurations).values({
      tenantId: f.tenantId,
      ownerKind: "station",
      stationDeviceId: f.device.id,
      credentialEpoch: f.device.credentialEpoch,
      mode: "observe",
      policyId,
      policyRevision: "fixture",
      decisionReference: "fixture",
      issuedAt: new Date(),
    });
    expect((await service.list(f.tenantId, f.actor)).items[0]?.preparation.state).toBe("draining");
    expect(
      (
        await readiness.report(f.identity, {
          ...d.body,
          requestId: randomUUID(),
          reportSequence: 2,
        })
      ).eligibility,
    ).toMatchObject({ status: "blocked", reasons: ["facts_changed"] });
  });
  it("keeps heartbeat neutral, expires readiness by server time, and renews superseded intent", async () => {
    const f = await fixture();
    const d = await drain(f);
    await readiness.report(f.identity, d.body);
    await db
      .update(schema.stationDevices)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.stationDevices.id, f.device.id));
    expect((await service.list(f.tenantId, f.actor)).items[0]?.preparation.state).toBe("ready");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    expect((await service.list(f.tenantId, f.actor)).items[0]?.preparation).toMatchObject({
      state: "draining",
      readiness: { eligibility: { reasons: ["report_stale"] } },
    });
    vi.setSystemTime(Date.now() + 300_000);
    const stale = await readiness.report(f.identity, {
      ...d.body,
      requestId: randomUUID(),
      reportSequence: 1,
    });
    expect(stale.eligibility).toMatchObject({ status: "blocked", reasons: ["report_stale"] });
    const refreshed = await readiness.requestDrain(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: randomUUID(), expectedRevision: 3 },
      f.actor,
    );
    expect(refreshed.preparation.readiness?.intentId).not.toBe(d.intent.intentId);
    expect(
      (
        await readiness.report(f.identity, {
          ...d.body,
          requestId: randomUUID(),
          reportSequence: 2,
        })
      ).eligibility.status,
    ).toBe("blocked");
  });
  it("enforces the real online shift and inventory boundaries while preserving active shift entry", async () => {
    const f = await fixture();
    const productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId: f.tenantId,
      gtin14: "04680089900024",
      name: "Product",
      status: "active",
    });
    const shifts = new ShiftsService(
      db,
      {} as never,
      {} as never,
      entitlements,
      new EntitlementAdmissionService(db, entitlements),
    );
    const createdShift = await shifts.createShift(
      f.tenantId,
      { productId, mode: "validation", productionDate: "2026-09-16" },
      { domain: "station_device", id: f.device.id },
      "station",
    );
    await shifts.enterShift(f.tenantId, createdShift.id, f.device.id);
    await db.insert(schema.productLabelJobs).values({
      tenantId: f.tenantId,
      deviceId: f.device.id,
      jobId: randomUUID(),
      shiftId: createdShift.id,
      codeHash: "a".repeat(64),
      acceptedAt: new Date(),
      policyRevision: randomUUID(),
      templateDigest: "b".repeat(64),
      payloadDigest: "c".repeat(64),
      latestSequence: 1,
      projection: { status: "attention", attemptState: "delivery_unknown" },
    });
    const d = await drain(f);
    await expect(
      shifts.createShift(
        f.tenantId,
        { productId, mode: "validation", productionDate: "2026-09-16" },
        { domain: "station_device", id: f.device.id },
        "station",
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "device_replacement_draining" } });
    await expect(shifts.enterShift(f.tenantId, randomUUID(), f.device.id)).rejects.toMatchObject({
      status: 409,
      response: { code: "device_replacement_draining" },
    });
    await expect(
      shifts.enterShift(f.tenantId, createdShift.id, f.device.id),
    ).resolves.toMatchObject({ id: createdShift.id, status: "active" });
    const access = new StationInventoryAccessService(db, {} as never);
    await expect(
      access.join(f.tenantId, f.device.id, randomUUID(), "station", randomUUID(), {
        operatorId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 409, response: { code: "device_replacement_draining" } });
    expect((await readiness.report(f.identity, d.body)).eligibility).toMatchObject({
      status: "blocked",
      reasons: expect.arrayContaining(["active_tasks", "pending_product_labels", "unknown_prints"]),
    });
    await db
      .update(schema.productLabelJobs)
      .set({
        projection: {
          status: "completed",
          attemptState: "delivery_unknown",
          verificationOutcome: "verified",
        },
      })
      .where(eq(schema.productLabelJobs.tenantId, f.tenantId));
    expect(
      (
        await readiness.report(f.identity, {
          ...d.body,
          requestId: randomUUID(),
          reportSequence: 1,
        })
      ).eligibility,
    ).toEqual({ status: "blocked", reasons: ["active_tasks"] });
    await expect(
      shifts.closeShift(f.tenantId, createdShift.id, { reason: "Drained" }),
    ).resolves.toMatchObject({ status: "closed" });
    expect(
      (
        await readiness.report(f.identity, {
          ...d.body,
          requestId: randomUUID(),
          reportSequence: 2,
        })
      ).eligibility,
    ).toEqual({ status: "eligible", reasons: [] });
    expect((await readiness.currentIntent(f.identity))?.intentId).toBe(d.intent.intentId);
    expect((await service.list(f.tenantId, f.actor)).items[0]?.preparation.state).toBe("ready");
    // New server evidence must invalidate ready even when the authority is unchanged.
    await db
      .update(schema.productLabelJobs)
      .set({ projection: { status: "attention", attemptState: "delivery_unknown" } })
      .where(eq(schema.productLabelJobs.tenantId, f.tenantId));
    expect((await service.list(f.tenantId, f.actor)).items[0]?.preparation).toMatchObject({
      state: "draining",
      readiness: {
        eligibility: { status: "blocked", reasons: ["pending_product_labels", "unknown_prints"] },
      },
    });
    expect(
      (
        await readiness.report(f.identity, {
          ...d.body,
          requestId: randomUUID(),
          reportSequence: 3,
        })
      ).eligibility,
    ).toEqual({ status: "blocked", reasons: ["pending_product_labels", "unknown_prints"] });
  });
  it("rejects a readiness request ID already used for the drain command", async () => {
    const f = await fixture();
    const d = await drain(f);
    await expect(
      readiness.report(f.identity, { ...d.body, requestId: d.request.requestId }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("denies a source revoked after the HTTP credential check", async () => {
    const f = await fixture();
    await db
      .update(schema.stationDevices)
      .set({ revokedAt: new Date(), apiKeyId: null })
      .where(eq(schema.stationDevices.id, f.device.id));
    await expect(
      db.transaction((tx) => assertDeviceReplacementNewWorkAllowed(tx, f.tenantId, f.device.id)),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("projects draining when a newer report regresses the durable storage revision", async () => {
    const f = await fixture();
    const d = await drain(f);
    await readiness.report(f.identity, { ...d.body, storageRevision: 2 });
    expect(
      (
        await readiness.report(f.identity, {
          ...d.body,
          requestId: randomUUID(),
          reportSequence: 1,
        })
      ).eligibility,
    ).toEqual({ status: "blocked", reasons: ["report_stale"] });
    expect((await service.list(f.tenantId, f.actor)).items[0]?.preparation).toMatchObject({
      state: "draining",
      readiness: { eligibility: { status: "blocked", reasons: ["report_stale"] } },
    });
  });
  it("keeps the storage revision high-water mark across stale reports and exact retries", async () => {
    const f = await fixture();
    const d = await drain(f);
    const original = { ...d.body, storageRevision: 2 };
    const originalResponse = await readiness.report(f.identity, original);
    for (const reportSequence of [1, 2]) {
      const body = { ...d.body, requestId: randomUUID(), reportSequence, storageRevision: 1 };
      const response = await readiness.report(f.identity, body);
      expect(response.eligibility).toEqual({ status: "blocked", reasons: ["report_stale"] });
      expect(await readiness.report(f.identity, body)).toEqual(response);
      expect((await service.list(f.tenantId, f.actor)).items[0]?.preparation.state).toBe(
        "draining",
      );
    }
    expect(await readiness.report(f.identity, original)).toEqual(originalResponse);
    const caughtUp = await readiness.report(f.identity, {
      ...d.body,
      requestId: randomUUID(),
      reportSequence: 3,
      storageRevision: 2,
    });
    expect(caughtUp.eligibility).toEqual({ status: "eligible", reasons: [] });
    expect((await readiness.currentIntent(f.identity))?.intentId).toBe(d.intent.intentId);
    expect((await service.list(f.tenantId, f.actor)).items[0]?.preparation.state).toBe("ready");
    const rows = await db
      .select()
      .from(schema.workingDeviceReplacementReadinessReports)
      .where(eq(schema.workingDeviceReplacementReadinessReports.intentId, d.intent.intentId));
    expect(rows).toHaveLength(4);
  });

  it("preserves a higher storage revision observed in an out-of-order report", async () => {
    const f = await fixture();
    const d = await drain(f);
    await readiness.report(f.identity, { ...d.body, reportSequence: 2, storageRevision: 2 });
    expect(
      (
        await readiness.report(f.identity, {
          ...d.body,
          requestId: randomUUID(),
          reportSequence: 1,
          storageRevision: 4,
        })
      ).eligibility,
    ).toEqual({ status: "blocked", reasons: ["report_stale"] });
    expect((await service.list(f.tenantId, f.actor)).items[0]?.preparation.state).toBe("draining");
    expect(
      (
        await readiness.report(f.identity, {
          ...d.body,
          requestId: randomUUID(),
          reportSequence: 3,
          storageRevision: 3,
        })
      ).eligibility,
    ).toEqual({ status: "blocked", reasons: ["report_stale"] });
    expect(
      (
        await readiness.report(f.identity, {
          ...d.body,
          requestId: randomUUID(),
          reportSequence: 4,
          storageRevision: 4,
        })
      ).eligibility,
    ).toEqual({ status: "eligible", reasons: [] });
  });

  async function nativeReceipt(
    f: Awaited<ReturnType<typeof fixture>>,
    terminal?: {
      outcome: "accepted" | "duplicate" | "quarantined";
      status: "applied" | "rejected" | "not_applied";
    },
    deviceId = f.device.id,
  ) {
    const id = randomUUID();
    const batchId = randomUUID();
    const finalResponse = terminal
      ? {
          protocol: "offline-grants-v1",
          receiptId: id,
          batchId,
          outcome: terminal.outcome,
          reason: null,
          reconciliation: { status: terminal.status, statusCode: 200, result: null },
        }
      : null;
    await db.insert(schema.deviceGrantIngestReceipts).values({
      id,
      tenantId: f.tenantId,
      ownerKind: f.identity.kind,
      stationDeviceId: deviceId,
      credentialEpoch: f.device.credentialEpoch,
      identity: randomUUID().replaceAll("-", "").repeat(2),
      operation: "scans",
      batchId,
      payloadDigest: "a".repeat(64),
      envelopeDigest: "b".repeat(64),
      transportDigest: "c".repeat(64),
      retainedPayload: { retained: true },
      mode: "observe",
      receivedAt: new Date(),
      finalResponse,
      finalizedAt: terminal ? new Date() : null,
    });
    return { id, batchId };
  }
  it.each(["before drain", "after ready"])(
    "blocks native pending evidence %s and progresses on the same intent after reconciliation",
    async (when) => {
      const f = await fixture();
      const pending = when === "before drain" ? await nativeReceipt(f) : null;
      const d = await drain(f);
      if (!pending) {
        expect((await readiness.report(f.identity, d.body)).eligibility.status).toBe("eligible");
      }
      const receipt = pending ?? (await nativeReceipt(f));
      if (!pending)
        expect((await service.list(f.tenantId, f.actor)).items[0]?.preparation).toMatchObject({
          state: "draining",
          readiness: { eligibility: { status: "blocked", reasons: ["pending_exceptions"] } },
        });
      expect(
        (
          await readiness.report(f.identity, {
            ...d.body,
            requestId: randomUUID(),
            reportSequence: 1,
          })
        ).eligibility,
      ).toEqual({ status: "blocked", reasons: ["pending_exceptions"] });
      await db
        .update(schema.deviceGrantIngestReceipts)
        .set({
          finalizedAt: new Date(),
          finalResponse: {
            protocol: "offline-grants-v1",
            receiptId: receipt.id,
            batchId: receipt.batchId,
            outcome: "accepted",
            reason: null,
            reconciliation: { status: "applied", statusCode: 200, result: null },
          },
        })
        .where(eq(schema.deviceGrantIngestReceipts.id, receipt.id));
      expect(
        (
          await readiness.report(f.identity, {
            ...d.body,
            requestId: randomUUID(),
            reportSequence: 2,
          })
        ).eligibility,
      ).toEqual({ status: "eligible", reasons: [] });
      expect((await service.list(f.tenantId, f.actor)).items[0]?.preparation.state).toBe("ready");
      expect((await readiness.currentIntent(f.identity))?.intentId).toBe(d.intent.intentId);
    },
  );
  it.each([
    { outcome: "accepted" as const, status: "applied" as const, blocked: false },
    { outcome: "accepted" as const, status: "rejected" as const, blocked: false },
    { outcome: "duplicate" as const, status: "applied" as const, blocked: false },
    { outcome: "accepted" as const, status: "not_applied" as const, blocked: true },
    { outcome: "quarantined" as const, status: "not_applied" as const, blocked: true },
  ])(
    "treats native $outcome/$status with explicit resolved semantics",
    async ({ outcome, status, blocked }) => {
      const f = await fixture();
      await nativeReceipt(f, { outcome, status });
      const d = await drain(f);
      expect((await readiness.report(f.identity, d.body)).eligibility).toEqual(
        blocked
          ? { status: "blocked", reasons: ["pending_exceptions"] }
          : { status: "eligible", reasons: [] },
      );
      expect((await service.list(f.tenantId, f.actor)).items[0]?.preparation.state).toBe(
        blocked ? "draining" : "ready",
      );
    },
  );
  it("scopes native evidence to its tenant/device and retains old-epoch quarantine blockers", async () => {
    const f = await fixture("station", 2);
    const other = await fixture();
    const [peer] = await db
      .insert(schema.stationDevices)
      .values({ tenantId: f.tenantId, name: "Peer", kind: "station" })
      .returning();
    if (!peer) throw new Error("peer missing");
    await db.transaction((tx) => transitionWorkingAssignment(tx, peer));
    await nativeReceipt(other);
    await nativeReceipt(f, undefined, peer.id);
    const d = await drain(f);
    expect((await readiness.report(f.identity, d.body)).eligibility.status).toBe("eligible");
    const [evidence] = await db
      .insert(schema.deviceGrantEvidence)
      .values({
        tenantId: f.tenantId,
        ownerKind: "station",
        stationDeviceId: f.device.id,
        credentialEpoch: f.device.credentialEpoch - 1,
        evidenceIdentity: randomUUID(),
        payloadDigest: "a".repeat(64),
        payload: {},
        disposition: "quarantined",
        reason: "grant_missing_or_unrecognized",
      })
      .returning();
    if (!evidence) throw new Error("evidence missing");
    expect((await service.list(f.tenantId, f.actor)).items[0]?.preparation.state).toBe("draining");
    expect(
      (
        await readiness.report(f.identity, {
          ...d.body,
          requestId: randomUUID(),
          reportSequence: 1,
        })
      ).eligibility,
    ).toEqual({ status: "blocked", reasons: ["pending_exceptions"] });
  });
  it.each(["discarded", "replayed"] as const)(
    "blocks inventory quarantine behind a terminal receipt until it is %s",
    async (resolution) => {
      const f = await fixture();
      const inventoryId = randomUUID();
      const snapshotId = randomUUID();
      const productId = randomUUID();
      const lineId = randomUUID();
      await db
        .insert(schema.products)
        .values({ id: productId, tenantId: f.tenantId, name: "Product", gtin14: "04680089900024" });
      await db.insert(schema.lines).values({ id: lineId, tenantId: f.tenantId, name: "Line" });
      await db.insert(schema.inventories).values({
        id: inventoryId,
        tenantId: f.tenantId,
        number: "INV-1",
        productId,
        lineId,
        gtin14Snapshot: "04680089900024",
        mode: "check",
        productionDateFrom: "2026-09-16",
        productionDateTo: "2026-09-16",
        createdByUserId: f.actor.id,
      });
      await db.insert(schema.inventorySnapshots).values({
        id: snapshotId,
        tenantId: f.tenantId,
        inventoryId,
        combinedDigest: "a".repeat(64),
        productName: "Product",
        lineName: "Line",
        fixedByUserId: f.actor.id,
        emittedCount: 0,
        introducedCount: 0,
        appliedCount: 0,
        retiredCount: 0,
        writtenOffCount: 0,
        disaggregationCount: 0,
        protectedCount: 0,
        expectedCount: 0,
        packageCount: 0,
        looseCount: 0,
      });
      await db
        .update(schema.inventories)
        .set({
          status: "closed",
          activeSnapshotId: snapshotId,
          stationManifest: {},
          closedByUserId: f.actor.id,
          closedAt: new Date(),
        })
        .where(eq(schema.inventories.id, inventoryId));
      const receipt = await nativeReceipt(f, { outcome: "accepted", status: "rejected" });
      const d = await drain(f);
      expect((await readiness.report(f.identity, d.body)).eligibility.status).toBe("eligible");
      const [late] = await db
        .insert(schema.inventoryLateEvents)
        .values({
          tenantId: f.tenantId,
          inventoryId,
          deviceId: f.device.id,
          batchId: receipt.batchId,
          payload: {},
          payloadDigest: "a".repeat(64),
          closedRevision: 0,
          reason: "INVENTORY_CLOSED",
        })
        .returning();
      if (!late) throw new Error("late evidence missing");
      expect((await service.list(f.tenantId, f.actor)).items[0]?.preparation.state).toBe(
        "draining",
      );
      expect(
        (
          await readiness.report(f.identity, {
            ...d.body,
            requestId: randomUUID(),
            reportSequence: 1,
          })
        ).eligibility,
      ).toEqual({ status: "blocked", reasons: ["pending_exceptions"] });
      await db
        .update(schema.inventoryLateEvents)
        .set({ resolution, resolvedAt: new Date(), resolvedByUserId: f.actor.id })
        .where(eq(schema.inventoryLateEvents.id, late.id));
      expect(
        (
          await readiness.report(f.identity, {
            ...d.body,
            requestId: randomUUID(),
            reportSequence: 2,
          })
        ).eligibility,
      ).toEqual({ status: "eligible", reasons: [] });
      expect((await service.list(f.tenantId, f.actor)).items[0]?.preparation.state).toBe("ready");
    },
  );
  it("keeps an explicit cancellation tombstone until its source durably acknowledges it", async () => {
    const f = await fixture();
    const d = await drain(f);
    const cancelled = await service.cancel(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: randomUUID(), expectedRevision: d.receipt.preparation.revision },
      f.actor,
    );
    const tombstone = await readiness.currentIntentProjection(f.identity, d.intent.intentId);
    expect(tombstone).toMatchObject({
      version: 1,
      state: "cancelled",
      intentId: d.intent.intentId,
      preparationId: f.prepared.preparation.id,
      preparationRevision: cancelled.preparation.revision,
    });
    if (tombstone.state !== "cancelled") throw new Error("missing tombstone");
    const request = { requestId: randomUUID(), tombstone };
    const ack = await readiness.acknowledgeClosure(f.identity, request);
    const [auditRow] = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.requestId, request.requestId));
    expect(auditRow).toMatchObject({
      organizationId: f.tenantId,
      actorUserId: null,
      action: "device.replacement.closure.acknowledged",
      outcome: "success",
      targetType: "device_replacement_readiness_intent",
      targetId: d.intent.intentId,
      requestId: request.requestId,
      after: {
        actorDomain: "station_device",
        actorId: f.device.id,
        deviceKind: "station",
        credentialEpoch: 1,
        preparationId: f.prepared.preparation.id,
        preparationRevision: tombstone.preparationRevision,
        state: "cancelled",
        closedAt: tombstone.closedAt,
      },
    });
    expect(await readiness.acknowledgeClosure(f.identity, request)).toEqual(ack);
    const ackRows = await db
      .select()
      .from(schema.workingDeviceReplacementClosureAcknowledgements)
      .where(
        eq(schema.workingDeviceReplacementClosureAcknowledgements.requestId, request.requestId),
      );
    expect(ackRows).toHaveLength(1);
    await expect(
      db
        .update(schema.workingDeviceReplacementClosureAcknowledgements)
        .set({ requestHash: "f".repeat(64) })
        .where(
          eq(schema.workingDeviceReplacementClosureAcknowledgements.requestId, request.requestId),
        ),
    ).rejects.toThrow();
    await expect(
      readiness.report(f.identity, { ...d.body, requestId: request.requestId }),
    ).rejects.toMatchObject({ status: 409 });

    expect(await readiness.currentIntentProjection(f.identity, d.intent.intentId)).toEqual({
      version: 1,
      state: "none",
    });
    await expect(
      readiness.acknowledgeClosure(f.identity, {
        ...request,
        tombstone: { ...tombstone, preparationRevision: tombstone.preparationRevision + 1 },
      }),
    ).rejects.toMatchObject({ status: 409 });
    const other = await fixture();
    await expect(
      readiness.acknowledgeClosure(other.identity, { ...request, requestId: randomUUID() }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("delivers cancellation to an older saved intent that was superseded while the source was offline", async () => {
    const f = await fixture();
    const first = await drain(f);
    const newer = await readiness.requestDrain(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: randomUUID(), expectedRevision: first.receipt.preparation.revision },
      f.actor,
    );
    await service.cancel(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: randomUUID(), expectedRevision: newer.preparation.revision },
      f.actor,
    );
    expect(
      await readiness.currentIntentProjection(f.identity, first.intent.intentId),
    ).toMatchObject({
      state: "cancelled",
      intentId: first.intent.intentId,
      preparationRevision: newer.preparation.revision + 1,
    });
    const other = await fixture();
    expect(await readiness.currentIntentProjection(other.identity, first.intent.intentId)).toEqual({
      version: 1,
      state: "none",
    });
  });
});
