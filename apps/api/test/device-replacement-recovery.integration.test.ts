import {
  canonicalizeKm,
  kmHash,
  productLabelValueDigest,
  inventoryEventBatchDigest,
} from "@markiro/domain";
import { platformCapabilitiesForRole } from "@markiro/platform-contracts";
import { createPublishedAddon } from "./support/subscription-fixtures";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import express from "express";
import { AppModule } from "../src/app.module";
import { setupAuth } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";
import { randomUUID, createHash } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import { StationScansService } from "../src/modules/station-scans/station-scans.service";
import { DeviceReplacementRecoveryService } from "../src/modules/device-licensing/device-replacement-recovery.service";
import { replacementExecutionHarness } from "./support/device-replacement-execution-fixture";

describe.skipIf(!process.env.DATABASE_URL)("replacement evidence recovery", () => {
  let app: INestApplication;
  const h = replacementExecutionHarness();
  beforeEach(async () => {
    await h.db
      .update(schema.kioskPairAttempts)
      .set({ failures: 0 })
      .where(eq(schema.kioskPairAttempts.source, "127.0.0.1"));
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeAll(async () => {
    const env = {
      ...loadEnv(),
      SUBSCRIPTION_ENFORCEMENT_MODE: "all" as const,
      DATABASE_URL: h.connection.pool.options.connectionString!,
    };
    const module = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setupAuth(env), databaseUrl: env.DATABASE_URL, env })],
    }).compile();
    app = module.createNestApplication({ bodyParser: false });
    app.getHttpAdapter().getInstance().use(express.json());
    await app.init();
    await listenOnLoopback(app);
  });
  const recovery = new DeviceReplacementRecoveryService(h.db, h.entitlements, h.audit);
  async function emergency(
    kind: "station" | "handheld" = "station",
    existing?: Awaited<ReturnType<typeof h.fixture>>,
  ) {
    const f = existing ?? (await h.fixture(kind, 1, true));
    if (kind === "handheld") {
      const [subscription] = await h.db
        .select()
        .from(schema.tenantSubscriptions)
        .where(eq(schema.tenantSubscriptions.tenantId, f.tenantId));
      if (!subscription) throw new Error("subscription");
      const addonVersionId = await createPublishedAddon(h.db, [{ entitlementKey: "handheld" }]);
      await h.db.insert(schema.subscriptionAddons).values({
        tenantId: f.tenantId,
        subscriptionId: subscription.id,
        addonVersionId,
        quantity: 1,
        source: "manual",
        status: "active",
        startsAt: new Date(Date.now() - 1000),
      });
    }
    const p = await h.execution.previewEmergency(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: randomUUID(), expectedRevision: 1, reason: "Source disconnected" },
      f.actor,
    );
    const done = await h.execution.executeEmergency(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: p.requestId, expectedRevision: 1, previewId: p.id, mode: "emergency" },
      f.actor,
    );
    return { ...f, done };
  }
  it("issues only a hashed purpose-bound code against the execution revision without reopening the preparation", async () => {
    const f = await emergency();
    const before = await h.db
      .select()
      .from(schema.workingDeviceReplacementPreparations)
      .where(eq(schema.workingDeviceReplacementPreparations.id, f.prepared.preparation.id));
    const request = {
      requestId: randomUUID(),
      expectedRevision: f.done.preparation.execution!.revision,
    };
    const result = await recovery.issueReplacementRecoveryCode(
      f.tenantId,
      f.prepared.preparation.id,
      request,
      f.actor,
    );
    expect(result.code).toMatch(/^\d{8}$/);
    const [code] = await h.db
      .select()
      .from(schema.stationPairingCodes)
      .where(eq(schema.stationPairingCodes.stationDeviceId, f.device.id));
    expect(code).toMatchObject({ purpose: "replacement_recovery", usedAt: null });
    expect(code?.codeHash).not.toBe(result.code);
    expect(
      await h.db
        .select()
        .from(schema.workingDeviceReplacementPreparations)
        .where(eq(schema.workingDeviceReplacementPreparations.id, f.prepared.preparation.id)),
    ).toEqual(before);
    await expect(
      recovery.issueReplacementRecoveryCode(
        f.tenantId,
        f.prepared.preparation.id,
        request,
        f.actor,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      recovery.issueReplacementRecoveryCode(
        f.tenantId,
        f.prepared.preparation.id,
        { ...request, requestId: randomUUID() },
        f.actor,
      ),
    ).rejects.toMatchObject({ status: 409 });
    const [device] = await h.db
      .select()
      .from(schema.stationDevices)
      .where(eq(schema.stationDevices.id, f.device.id));
    expect(device?.revokedAt).not.toBeNull();
    const [assignment] = await h.db
      .select()
      .from(schema.workingDeviceAssignments)
      .where(eq(schema.workingDeviceAssignments.deviceId, f.device.id));
    expect(assignment).toMatchObject({
      state: "released",
      releaseReason: "replacement_transferred",
    });
  });
  it("administrative unavailable closure requires a reason, fences execution revision, audits, and never inserts readiness zero", async () => {
    const f = await emergency();
    const issued = await recovery.issueReplacementRecoveryCode(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: randomUUID(), expectedRevision: f.done.preparation.execution!.revision },
      f.actor,
    );
    const paired = await request(app.getHttpServer())
      .post("/station/pair/recovery")
      .set("x-station-capabilities", "replacement-evidence-recovery-v1")
      .send({
        version: 1,
        code: issued.code,
        expected: { tenantId: f.tenantId, deviceId: f.device.id, kind: "station" },
      })
      .expect(201);
    const input = {
      requestId: randomUUID(),
      expectedRevision: issued.preparation.execution!.revision + 1,
      reason: "Storage destroyed",
    };
    await expect(
      recovery.closeReplacementRecovery(
        f.tenantId,
        f.prepared.preparation.id,
        { ...input, expectedRevision: input.expectedRevision - 1 },
        f.actor,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      recovery.closeReplacementRecovery(
        f.tenantId,
        f.prepared.preparation.id,
        { ...input, reason: " " },
        f.actor,
      ),
    ).rejects.toMatchObject({ status: 400 });
    const result = await recovery.closeReplacementRecovery(
      f.tenantId,
      f.prepared.preparation.id,
      input,
      f.actor,
    );
    expect(result.preparation.recovery?.state).toBe("evidence_unavailable");
    await request(app.getHttpServer())
      .get("/station/identity")
      .set("x-api-key", paired.body.credential.apiKey)
      .expect(401);
    expect(
      await recovery.closeReplacementRecovery(
        f.tenantId,
        f.prepared.preparation.id,
        input,
        f.actor,
      ),
    ).toEqual(result);
    expect(
      await h.db
        .select()
        .from(schema.workingDeviceReplacementReadinessReports)
        .where(eq(schema.workingDeviceReplacementReadinessReports.deviceId, f.device.id)),
    ).toEqual([]);
    const audit = await h.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.requestId, input.requestId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      organizationId: f.tenantId,
      actorUserId: f.actor.id,
      action: "device.replacement.recovery_closed",
      outcome: "success",
      targetType: "device_replacement",
      targetId: f.prepared.preparation.id,
    });
    expect(audit[0]?.after).toMatchObject({
      reason: input.reason,
      recoveryState: "evidence_unavailable",
    });
  });
  it.each(["station", "handheld"] as const)(
    "%s redeems only for the sealed source owner and denies every productive route class",
    async (kind) => {
      const f = await emergency(kind);
      const capability =
        "replacement-evidence-recovery-v1" + (kind === "handheld" ? ",handheld-v1" : "");
      const issued = await recovery.issueReplacementRecoveryCode(
        f.tenantId,
        f.prepared.preparation.id,
        { requestId: randomUUID(), expectedRevision: f.done.preparation.execution!.revision },
        f.actor,
      );
      const expected = { tenantId: f.tenantId, deviceId: f.device.id, kind };
      await request(app.getHttpServer())
        .post("/station/pair")
        .send({ code: issued.code })
        .expect(401);
      for (const wrong of [
        { ...expected, tenantId: "wrong" },
        { ...expected, deviceId: f.done.preparation.execution!.targetDeviceId },
        { ...expected, kind: kind === "handheld" ? "station" : "handheld" },
      ]) {
        await request(app.getHttpServer())
          .post("/station/pair/recovery")
          .send({ version: 1, code: issued.code, expected: wrong })
          .expect(401);
      }
      const paired = await request(app.getHttpServer())
        .post("/station/pair/recovery")
        .set("x-station-capabilities", capability)
        .send({ version: 1, code: issued.code, expected })
        .expect(201);
      expect(paired.body.recovery).toMatchObject({
        purpose: "replacement_evidence_recovery",
        executionId: f.done.preparation.execution!.id,
      });
      const key = paired.body.credential.apiKey as string;
      for (const [method, path] of [
        ["post", "/shifts"],
        ["post", `/shifts/${randomUUID()}/open`],
        ["post", `/station/inventories/${randomUUID()}/join`],
        ["post", "/station/grants/v1/device"],
        ["post", "/station/grants/v1/tasks"],
        ["post", "/station/grants/v1/configuration"],
        ["post", `/station-devices/${f.device.id}/pairing-code`],
        ["post", "/products"],
        ["get", "/station/inventory-tasks"],
        ["get", `/shifts/${randomUUID()}/bundle`],
      ] as const) {
        await request(app.getHttpServer())[method](path).set("x-api-key", key).send({}).expect(403);
      }
      await request(app.getHttpServer()).get("/station/identity").set("x-api-key", key).expect(200);
      await request(app.getHttpServer())
        .get("/station/grants/v1/keyset")
        .set("x-api-key", key)
        .expect(200);
      await request(app.getHttpServer())
        .post("/station/scans")
        .set("x-api-key", key)
        .send({ batchId: randomUUID(), items: [] })
        .expect(201);
      await request(app.getHttpServer())
        .post("/station/pair/recovery")
        .set("x-station-capabilities", capability)
        .send({ version: 1, code: issued.code, expected })
        .expect(401);
      const report = {
        requestId: randomUUID(),
        intentId: paired.body.recovery.intentId,
        credentialEpoch: paired.body.recovery.credentialEpoch,
        reportSequence: 0,
        clientBuild: "recovery-test",
        storageRevision: 1,
        pending: {
          scans: 1,
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
      const blocked = await request(app.getHttpServer())
        .post("/station/replacement-recovery/readiness")
        .set("x-api-key", key)
        .send(report)
        .expect(200);
      expect(blocked.body.eligibility).toMatchObject({
        status: "blocked",
        reasons: ["pending_scans"],
      });
      const replay = await request(app.getHttpServer())
        .post("/station/replacement-recovery/readiness")
        .set("x-api-key", key)
        .send(report)
        .expect(200);
      expect(replay.body).toEqual(blocked.body);
      await request(app.getHttpServer())
        .post("/station/replacement-recovery/readiness")
        .set("x-api-key", key)
        .send({ ...report, pending: { ...report.pending, scans: 0 } })
        .expect(409);
      const observed = {
        ...report,
        requestId: randomUUID(),
        reportSequence: 2,
        storageRevision: 10,
      };
      await request(app.getHttpServer())
        .post("/station/replacement-recovery/readiness")
        .set("x-api-key", key)
        .send(observed)
        .expect(200);
      const stale = await request(app.getHttpServer())
        .post("/station/replacement-recovery/readiness")
        .set("x-api-key", key)
        .send({
          ...report,
          requestId: randomUUID(),
          reportSequence: 1,
          storageRevision: 9,
          pending: { ...report.pending, scans: 0 },
        })
        .expect(200);
      expect(stale.body.eligibility).toMatchObject({
        status: "blocked",
        reasons: ["report_stale"],
      });
      await request(app.getHttpServer())
        .post("/station/replacement-recovery/readiness")
        .set("x-api-key", key)
        .send({
          ...report,
          requestId: randomUUID(),
          reportSequence: 3,
          storageRevision: 11,
          pending: { ...report.pending, scans: 0 },
        })
        .expect(200);
      await request(app.getHttpServer()).get("/station/identity").set("x-api-key", key).expect(401);
      const [closed] = await h.db
        .select()
        .from(schema.workingDeviceReplacementExecutions)
        .where(eq(schema.workingDeviceReplacementExecutions.id, f.done.preparation.execution!.id));
      expect(closed?.recoveryState).toBe("completed");
      const [source] = await h.db
        .select()
        .from(schema.stationDevices)
        .where(eq(schema.stationDevices.id, f.device.id));
      expect(source?.revokedAt).not.toBeNull();
      expect(source?.credentialEpoch).toBeGreaterThan(f.device.credentialEpoch);
    },
  );

  it("expires recovery codes and rejects a generation changed after issuance", async () => {
    const f = await emergency();
    let issued = await recovery.issueReplacementRecoveryCode(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: randomUUID(), expectedRevision: f.done.preparation.execution!.revision },
      f.actor,
    );
    const expected = { tenantId: f.tenantId, deviceId: f.device.id, kind: "station" };
    await h.db
      .update(schema.stationPairingCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.stationPairingCodes.stationDeviceId, f.device.id));
    await request(app.getHttpServer())
      .post("/station/pair/recovery")
      .set("x-station-capabilities", "replacement-evidence-recovery-v1")
      .send({ version: 1, code: issued.code, expected })
      .expect(401);
    issued = await recovery.issueReplacementRecoveryCode(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: randomUUID(), expectedRevision: issued.preparation.execution!.revision },
      f.actor,
    );
    await h.db
      .update(schema.stationDevices)
      .set({ revokedAt: new Date() })
      .where(eq(schema.stationDevices.id, f.device.id));
    await request(app.getHttpServer())
      .post("/station/pair/recovery")
      .set("x-station-capabilities", "replacement-evidence-recovery-v1")
      .send({ version: 1, code: issued.code, expected })
      .expect(401);
  });
  it("retains first-delivery handheld write-off evidence and replays it under recovery without manufacturing a document", async () => {
    const f = await emergency("handheld");
    const issued = await recovery.issueReplacementRecoveryCode(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: randomUUID(), expectedRevision: f.done.preparation.execution!.revision },
      f.actor,
    );
    const pair = await request(app.getHttpServer())
      .post("/station/pair/recovery")
      .set("x-station-capabilities", "handheld-v1,replacement-evidence-recovery-v1")
      .send({
        version: 1,
        code: issued.code,
        expected: { tenantId: f.tenantId, deviceId: f.device.id, kind: "handheld" },
      })
      .expect(201);
    const body = {
      deviceSeq: 1,
      operatorId: randomUUID(),
      writeoffReasonId: randomUUID(),
      items: [{ rawKm: "raw-evidence" }],
      createdAt: new Date().toISOString(),
    };
    const first = await request(app.getHttpServer())
      .post("/station/writeoffs")
      .set("x-api-key", pair.body.credential.apiKey)
      .send(body)
      .expect(409);
    expect(first.body).toMatchObject({
      outcome: "quarantined",
      reason: "unproven_pre_drain_scope",
    });
    const replay = await request(app.getHttpServer())
      .post("/station/writeoffs")
      .set("x-api-key", pair.body.credential.apiKey)
      .send(body)
      .expect(409);
    expect(replay.body).toEqual(first.body);
  });
  it.each(["unmanaged", "expired"] as const)(
    "retains and acknowledges source evidence for %s subscription with enforcement all",
    async (access) => {
      const f = await emergency("handheld");
      const issued = await recovery.issueReplacementRecoveryCode(
        f.tenantId,
        f.prepared.preparation.id,
        { requestId: randomUUID(), expectedRevision: f.done.preparation.execution!.revision },
        f.actor,
      );
      const paired = await request(app.getHttpServer())
        .post("/station/pair/recovery")
        .set("x-station-capabilities", "handheld-v1,replacement-evidence-recovery-v1")
        .send({
          version: 1,
          code: issued.code,
          expected: { tenantId: f.tenantId, deviceId: f.device.id, kind: "handheld" },
        })
        .expect(201);
      if (access === "unmanaged") {
        await h.db
          .delete(schema.subscriptionAddons)
          .where(eq(schema.subscriptionAddons.tenantId, f.tenantId));
        await h.db
          .delete(schema.tenantSubscriptions)
          .where(eq(schema.tenantSubscriptions.tenantId, f.tenantId));
      } else
        await h.db
          .update(schema.tenantSubscriptions)
          .set({
            startsAt: new Date(Date.now() - 172800000),
            endsAt: new Date(Date.now() - 86400000),
            status: "expired",
          })
          .where(eq(schema.tenantSubscriptions.tenantId, f.tenantId));
      const key = paired.body.credential.apiKey;
      const body = {
        deviceSeq: 1,
        operatorId: randomUUID(),
        writeoffReasonId: randomUUID(),
        items: [{ rawKm: "retained-evidence" }],
        createdAt: new Date().toISOString(),
      };
      const first = await request(app.getHttpServer())
        .post("/station/writeoffs")
        .set("x-api-key", key)
        .send(body)
        .expect(409);
      expect(first.body).toMatchObject({
        outcome: "quarantined",
        reason: "unproven_pre_drain_scope",
      });
      const ack = await request(app.getHttpServer())
        .post("/station/writeoffs")
        .set("x-api-key", key)
        .send(body)
        .expect(409);
      expect(ack.body).toEqual(first.body);
      await request(app.getHttpServer()).get("/station/identity").set("x-api-key", key).expect(200);
      await request(app.getHttpServer())
        .get("/station/grants/v1/keyset")
        .set("x-api-key", key)
        .expect(200);
      for (const path of [
        "/shifts",
        "/station/grants/v1/device",
        "/station/grants/v1/tasks",
        "/station/grants/v1/configuration",
      ])
        await request(app.getHttpServer()).post(path).set("x-api-key", key).send({}).expect(403);
    },
  );

  it("redeems a code authorized by a platform principal without any cabinet membership", async () => {
    const f = await emergency();
    const userId = randomUUID();
    await h.db.insert(schema.platformUsers).values({
      id: userId,
      email: `${userId}@example.invalid`,
      name: "Platform",
      role: "platform_admin",
      status: "active",
      twoFactorEnabled: true,
    });
    await h.db
      .insert(schema.platformTwoFactors)
      .values({ id: randomUUID(), userId, secret: "test", backupCodes: "test", verified: true });
    const actor = {
      domain: "platform" as const,
      principal: {
        userId,
        role: "platform_admin" as const,
        capabilities: [...platformCapabilitiesForRole.platform_admin],
        twoFactorReady: true,
      },
    };
    const issued = await recovery.issueReplacementRecoveryCode(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: randomUUID(), expectedRevision: f.done.preparation.execution!.revision },
      actor,
    );
    const paired = await request(app.getHttpServer())
      .post("/station/pair/recovery")
      .set("x-station-capabilities", "replacement-evidence-recovery-v1")
      .send({
        version: 1,
        code: issued.code,
        expected: { tenantId: f.tenantId, deviceId: f.device.id, kind: "station" },
      })
      .expect(201);
    await request(app.getHttpServer())
      .get("/station/identity")
      .set("x-api-key", paired.body.credential.apiKey)
      .expect(200);
    const [audit] = await h.db
      .select()
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.requestId, issued.requestId));
    expect(audit).toMatchObject({
      tenantId: f.tenantId,
      actorPlatformUserId: userId,
      actorRole: "platform_admin",
      action: "device.replacement.recovery_code_issued",
      outcome: "success",
      targetType: "device_replacement",
      targetId: f.prepared.preparation.id,
    });
  });

  it.each(["station", "handheld"] as const)(
    "%s quarantines every fresh evidence channel after cutover, including native observe, with stable retries",
    async (kind) => {
      const source = await emergency(kind);
      const issued = await recovery.issueReplacementRecoveryCode(
        source.tenantId,
        source.prepared.preparation.id,
        { requestId: randomUUID(), expectedRevision: source.done.preparation.execution!.revision },
        source.actor,
      );
      const paired = await request(app.getHttpServer())
        .post("/station/pair/recovery")
        .set(
          "x-station-capabilities",
          `replacement-evidence-recovery-v1${kind === "handheld" ? ",handheld-v1" : ""}`,
        )
        .send({
          version: 1,
          code: issued.code,
          expected: { tenantId: source.tenantId, deviceId: source.device.id, kind },
        })
        .expect(201);
      const f = {
        ...source,
        post: (path: string, body: object) =>
          request(app.getHttpServer())
            .post(path)
            .set("x-api-key", paired.body.credential.apiKey)
            .send(body),
      };
      const shiftId = randomUUID(),
        productId = randomUUID(),
        operatorId = randomUUID(),
        inventoryId = randomUUID(),
        reasonId = randomUUID();
      await h.db
        .insert(schema.employees)
        .values({ id: operatorId, tenantId: f.tenantId, fullName: "Operator" });
      await h.db.insert(schema.products).values({
        id: productId,
        tenantId: f.tenantId,
        name: "Post-cutover product",
        gtin14: "04600682000013",
      });
      await h.db.insert(schema.shifts).values({
        id: shiftId,
        tenantId: f.tenantId,
        productId,
        mode: "validation",
        status: "active",
        numberMonthKey: "SEP26",
        numberSeq: 1,
        openedAt: new Date(),
      });
      await request(app.getHttpServer())
        .get("/station/operators")
        .set("x-api-key", paired.body.credential.apiKey)
        .expect(403);
      const occurredAt = new Date().toISOString();
      const raw = `01${"04600682000013"}21FORGED123456789012${String.fromCharCode(29)}93Abcd`;
      const km = canonicalizeKm(raw),
        codeHash = kmHash(km);
      const item = {
        shiftId: shiftId,
        terminalId: null,
        raw,
        verdict: "ok",
        scannedAt: occurredAt,
        code: { codeHash, gtin14: km.gtin14, serial: km.serial },
        boxId: null,
        operatorId: operatorId,
      };
      const label = {
        eventId: randomUUID(),
        jobId: randomUUID(),
        attemptId: randomUUID(),
        sequence: 1,
        shiftId: shiftId,
        codeHash,
        acceptedAt: occurredAt,
        policyRevision: randomUUID(),
        templateDigest: "b".repeat(64),
        payloadDigest: "c".repeat(64),
        operatorId: operatorId,
        occurredAt,
        kind: "prepared",
        attemptNo: 1,
        reason: null,
        language: "zpl",
        dpi: 203,
        bytesDigest: "d".repeat(64),
      };
      const scans = [
        { batchId: randomUUID(), items: [item] },
        { batchId: randomUUID(), items: [], productLabelEvents: [label] },
        {
          batchId: randomUUID(),
          items: [],
          boxes: [
            {
              boxId: randomUUID(),
              shiftId: shiftId,
              terminalId: null,
              sscc: "046011122200000019",
              closedAt: occurredAt,
              operatorId: operatorId,
            },
          ],
        },
        {
          batchId: randomUUID(),
          items: [],
          pallets: [
            {
              palletId: randomUUID(),
              shiftId: shiftId,
              terminalId: null,
              sscc: "146011122200000016",
              closedAt: occurredAt,
              operatorId: operatorId,
            },
          ],
        },
      ];
      const inventoryPayload = {
        snapshotId: randomUUID(),
        snapshotRevision: 1 as const,
        sequenceCeiling: 1,
        pendingEventCount: 0,
        openBoxCount: 0,
        events: [
          {
            eventId: randomUUID(),
            deviceSequence: 1,
            operatorId: operatorId,
            scannedAt: occurredAt,
            kind: "item" as const,
            normalizedIdentity: `km:${codeHash}`,
            codeHash,
            canonicalRaw: km.raw,
            activeProductionDate: "2026-08-01",
            localVerdict: "unknown" as const,
          },
        ],
      };
      const inventory = {
        ...inventoryPayload,
        batchId: randomUUID(),
        payloadDigest: inventoryEventBatchDigest(inventoryPayload),
      };
      const close = {
        eventId: randomUUID(),
        shiftId: shiftId,
        operatorId: operatorId,
        plannedQtySnapshot: null,
        actualQty: 0,
        closedBoxCount: 0,
        closedAt: occurredAt,
      };
      const legacy = [
        {
          path: `/station/inventories/${inventoryId}/leave`,
          payload: { requestId: randomUUID(), pendingEventCount: 0, openBoxCount: 0 },
        },
        ...scans.map((payload) => ({ path: "/station/scans", payload })),
        { path: `/station/inventories/${inventoryId}/event-batches`, payload: inventory },
        { path: "/station/shift-closures", payload: close },
        ...(kind === "handheld"
          ? [
              {
                path: "/station/writeoffs",
                payload: {
                  deviceSeq: 7,
                  operatorId: operatorId,
                  writeoffReasonId: reasonId,
                  items: [{ rawKm: raw }],
                  boxes: [],
                  createdAt: occurredAt,
                },
              },
            ]
          : []),
      ];
      const legacyReceipts: { route: (typeof legacy)[number]; body: object }[] = [];
      for (const route of legacy) {
        const response = await f.post(route.path, route.payload);
        expect.soft(response.status, route.path).toBe(409);
        expect.soft(response.body, route.path).toMatchObject({
          code:
            route.path === "/station/writeoffs"
              ? "device_replacement_draining"
              : "device_replacement_recovery",
          outcome: "quarantined",
          receiptId: expect.any(String),
        });
        legacyReceipts.push({ route, body: response.body });
        expect((await f.post(route.path, route.payload)).body).toEqual(response.body);
      }
      const native = [
        ...scans.map((payload) => ({ path: "/station/grants/v1/evidence/scans", payload })),
        {
          path: `/station/grants/v1/evidence/inventories/${inventoryId}/event-batches`,
          payload: inventory,
        },
        { path: "/station/grants/v1/evidence/shift-closures", payload: close },
        {
          path: `/station/grants/v1/evidence/inventories/${inventoryId}/leave`,
          payload: { pendingEventCount: 0, openBoxCount: 0 },
        },
      ];
      for (const route of native) {
        const envelope = {
          protocol: "offline-grants-v1",
          batchId: randomUUID(),
          payloadDigest: productLabelValueDigest(route.payload),
          grants: [],
          eventGrants: {},
          payload: route.payload,
        };
        const response = await f.post(route.path, envelope);
        expect.soft(response.status, route.path).toBe(200);
        expect.soft(response.body, route.path).toMatchObject({
          outcome: "quarantined",
          reason: "unproven_pre_replacement_evidence",
          reconciliation: { status: "not_applied" },
        });
        const replay = await f.post(route.path, envelope);
        expect.soft(replay.body).toMatchObject({ ...response.body, outcome: "duplicate" });
      }
      expect(
        await h.db
          .select()
          .from(schema.scanEvents)
          .where(eq(schema.scanEvents.terminalId, f.device.id)),
      ).toHaveLength(0);
      expect(
        await h.db
          .select()
          .from(schema.productLabelJobs)
          .where(eq(schema.productLabelJobs.deviceId, f.device.id)),
      ).toHaveLength(0);
      expect(
        await h.db.select().from(schema.boxes).where(eq(schema.boxes.terminalId, f.device.id)),
      ).toHaveLength(0);
      expect(
        await h.db.select().from(schema.pallets).where(eq(schema.pallets.terminalId, f.device.id)),
      ).toHaveLength(0);
      expect(
        await h.db
          .select()
          .from(schema.inventoryScanEvents)
          .where(eq(schema.inventoryScanEvents.deviceId, f.device.id)),
      ).toHaveLength(0);
      expect(
        await h.db
          .select()
          .from(schema.pickupOrders)
          .where(eq(schema.pickupOrders.stationDeviceId, f.device.id)),
      ).toHaveLength(0);

      expect(
        await h.db.select().from(schema.codes).where(eq(schema.codes.shiftId, shiftId)),
      ).toEqual([]);
      expect(
        await h.db
          .select()
          .from(schema.stationShiftCloseEvents)
          .where(eq(schema.stationShiftCloseEvents.deviceId, f.device.id)),
      ).toEqual([]);
      const [shift] = await h.db.select().from(schema.shifts).where(eq(schema.shifts.id, shiftId));
      expect(shift?.status).toBe("active");
      expect(
        await h.db
          .select()
          .from(schema.deviceGrantEvidence)
          .where(eq(schema.deviceGrantEvidence.stationDeviceId, f.device.id)),
      ).toHaveLength(legacy.length);
      const receipts = await h.db
        .select()
        .from(schema.deviceGrantIngestReceipts)
        .where(eq(schema.deviceGrantIngestReceipts.stationDeviceId, f.device.id));
      expect(receipts).toHaveLength(native.length);
      expect(
        receipts.every(
          (row) => row.mode === "observe" && row.finalResponse?.outcome === "quarantined",
        ),
      ).toBe(true);
    },
  );

  it.each(["legacy", "native_final", "native_pending"] as const)(
    "replays exact pre-cutover %s evidence and refuses changed bytes",
    async (transport) => {
      const f = await h.fixture("station", 1, true);
      const originalKey = randomUUID();
      await h.db
        .update(schema.apikey)
        .set({
          key: createHash("sha256").update(originalKey).digest("base64url"),
          metadata: JSON.stringify({ kind: "station" }),
        })
        .where(eq(schema.apikey.id, f.identity.apiKeyId));
      const productId = randomUUID(),
        shiftId = randomUUID();
      await h.db.insert(schema.products).values({
        id: productId,
        tenantId: f.tenantId,
        name: "Old product",
        gtin14: "04600682000013",
      });
      await h.db.insert(schema.shifts).values({
        id: shiftId,
        tenantId: f.tenantId,
        productId,
        mode: "validation",
        status: "active",
        numberMonthKey: "SEP26",
        numberSeq: 1,
        openedAt: new Date(),
      });
      const raw = `010460068200001321SAVED123456789012${String.fromCharCode(29)}93Abcd`;
      const km = canonicalizeKm(raw);
      const payload = {
        batchId: randomUUID(),
        items: [
          {
            shiftId,
            terminalId: f.device.id,
            raw,
            verdict: "ok",
            scannedAt: new Date().toISOString(),
            code: { codeHash: kmHash(km), gtin14: km.gtin14, serial: km.serial },
            boxId: null,
            operatorId: null,
          },
        ],
      };
      const body =
        transport === "legacy"
          ? payload
          : {
              protocol: "offline-grants-v1",
              batchId: randomUUID(),
              payloadDigest: productLabelValueDigest(payload),
              payload,
              grants: [],
              eventGrants: {},
            };
      const path = transport === "legacy" ? "/station/scans" : "/station/grants/v1/evidence/scans";
      const send = (key: string, input: object = body) =>
        request(app.getHttpServer()).post(path).set("x-api-key", key).send(input);
      if (transport === "native_pending")
        vi.spyOn(app.get(StationScansService), "applyBatch").mockRejectedValueOnce(
          new Error("pre-cutover receipt retained; native execution interrupted"),
        );
      const original = await send(originalKey).expect(
        transport === "native_pending" ? 500 : transport === "legacy" ? 201 : 200,
      );
      if (transport === "legacy") expect(original.body.applied).toBe(1);
      if (transport === "native_final")
        expect(original.body).toMatchObject({
          outcome: "accepted",
          reconciliation: { status: "applied", result: { applied: 1 } },
        });
      if (transport === "native_pending")
        expect(
          await h.db.select().from(schema.codes).where(eq(schema.codes.shiftId, shiftId)),
        ).toEqual([]);
      const replaced = await emergency("station", f);
      const issued = await recovery.issueReplacementRecoveryCode(
        f.tenantId,
        f.prepared.preparation.id,
        {
          requestId: randomUUID(),
          expectedRevision: replaced.done.preparation.execution!.revision,
        },
        f.actor,
      );
      const paired = await request(app.getHttpServer())
        .post("/station/pair/recovery")
        .set("x-station-capabilities", "replacement-evidence-recovery-v1")
        .send({
          version: 1,
          code: issued.code,
          expected: { tenantId: f.tenantId, deviceId: f.device.id, kind: "station" },
        })
        .expect(201);
      const recovered = await send(paired.body.credential.apiKey).expect(
        transport === "legacy" ? 201 : 200,
      );
      if (transport === "legacy")
        expect(recovered.body).toMatchObject({ applied: 0, alreadyApplied: true });
      else
        expect(recovered.body).toMatchObject({
          outcome: transport === "native_pending" ? "accepted" : "duplicate",
          reconciliation: { status: "applied", result: { applied: 1 } },
        });
      await send(
        paired.body.credential.apiKey,
        transport === "legacy"
          ? {
              ...payload,
              items: [
                { ...payload.items[0], scannedAt: new Date(Date.now() + 1000).toISOString() },
              ],
            }
          : { ...body, grants: ["changed"] },
      ).expect(409);
      await send(paired.body.credential.apiKey).expect(transport === "legacy" ? 201 : 200);
      expect(
        await h.db.select().from(schema.codes).where(eq(schema.codes.shiftId, shiftId)),
      ).toHaveLength(1);
    },
  );
});
