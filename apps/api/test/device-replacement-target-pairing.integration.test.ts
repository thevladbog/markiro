import { DeviceReplacementTargetPairingService } from "../src/modules/device-licensing/device-replacement-target-pairing.service";
import { replacementTargetWaiting } from "../src/modules/device-licensing/device-replacement-admission";
import {
  deviceReplacementRecoveryCodeResponseSchema,
  platformCapabilitiesForRole,
} from "@markiro/platform-contracts";
import { PLATFORM_AUTH, setupPlatformAuth } from "../src/platform-auth/platform-auth.setup";
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
import { replacementExecutionHarness } from "./support/device-replacement-execution-fixture";

describe.skipIf(!process.env.DATABASE_URL)("replacement target pairing", () => {
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
      imports: [
        AppModule.forRoot({
          ...setupAuth(env),
          ...setupPlatformAuth(env, h.db),
          databaseUrl: env.DATABASE_URL,
          env,
        }),
      ],
    })
      .overrideProvider(PLATFORM_AUTH)
      .useValue({
        api: {
          getSession: async ({ headers }: { headers: Headers }) => {
            const id = headers.get("x-test-platform-user");
            return id ? { user: { id } } : null;
          },
        },
      })
      .compile();
    app = module.createNestApplication({ bodyParser: false });
    app.getHttpAdapter().getInstance().use(express.json());
    await app.init();
    await listenOnLoopback(app);
  });
  const targetPairing = new DeviceReplacementTargetPairingService(h.db, h.entitlements, h.audit);
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
  async function platform() {
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
    return {
      domain: "platform" as const,
      principal: {
        userId,
        role: "platform_admin" as const,
        capabilities: [...platformCapabilitiesForRole.platform_admin],
        twoFactorReady: true,
      },
    };
  }
  async function issue(kind: "station" | "handheld" = "station") {
    const f = await emergency(kind);
    const actor = await platform();
    const body = {
      requestId: randomUUID(),
      expectedRevision: f.done.preparation.execution!.revision,
    };
    const issuedResponse = await request(app.getHttpServer())
      .post(
        `/platform/tenants/${f.tenantId}/device-licensing/replacements/${f.prepared.preparation.id}/target/code`,
      )
      .set("x-test-platform-user", actor.principal.userId)
      .send(body)
      .expect(200);
    expect(issuedResponse.headers["cache-control"]).toBe("no-store");
    const issued = deviceReplacementRecoveryCodeResponseSchema.parse(issuedResponse.body);
    return { ...f, actor, body, issued };
  }
  const pair = (code: string, capabilities = "replacement-boundary-v1") =>
    request(app.getHttpServer())
      .post("/station/pair")
      .set("x-station-capabilities", capabilities)
      .send({ code });
  it.each(["station", "handheld"] as const)(
    "platform issues a usable %s target code without cabinet impersonation and preserves server waiting fence",
    async (kind) => {
      const f = await issue(kind);
      const paired = await pair(
        f.issued.code,
        kind === "handheld" ? "handheld-v1,replacement-boundary-v1" : "replacement-boundary-v1",
      ).expect(201);
      expect(paired.body.device).toMatchObject({
        id: f.done.preparation.execution!.targetDeviceId,
        tenantId: f.tenantId,
        kind,
      });
      expect(paired.body.replacement).toMatchObject({
        executionId: f.done.preparation.execution!.id,
        newWorkAllowedAt: Date.parse(f.done.preparation.execution!.newWorkAllowedAt),
      });
      await request(app.getHttpServer())
        .get("/station/identity")
        .set("x-api-key", paired.body.credential.apiKey)
        .expect(200);
      const [device] = await h.db
        .select()
        .from(schema.stationDevices)
        .where(eq(schema.stationDevices.id, paired.body.device.id));
      const [key] = await h.db
        .select()
        .from(schema.apikey)
        .where(eq(schema.apikey.id, device!.apiKeyId!));
      expect(key).toMatchObject({
        referenceId: f.tenantId,
        configId: "station",
        key: createHash("sha256").update(paired.body.credential.apiKey).digest("base64url"),
      });
      expect(
        await h.db.transaction((tx) =>
          replacementTargetWaiting(
            tx,
            f.tenantId,
            paired.body.device.id,
            new Date(Date.parse(f.done.preparation.execution!.newWorkAllowedAt) - 1),
          ),
        ),
      ).toBeTruthy();
      expect(
        await h.db.transaction((tx) =>
          replacementTargetWaiting(
            tx,
            f.tenantId,
            paired.body.device.id,
            new Date(f.done.preparation.execution!.newWorkAllowedAt),
          ),
        ),
      ).toBeNull();
      await pair(f.issued.code).expect(401);
      const [audit] = await h.db
        .select()
        .from(schema.platformAuditEvents)
        .where(eq(schema.platformAuditEvents.requestId, f.body.requestId));
      expect(audit).toMatchObject({
        actorPlatformUserId: f.actor.principal.userId,
        actorRole: "platform_admin",
        tenantId: f.tenantId,
        action: "device.replacement.target_code_issued",
        targetType: "device_replacement",
        targetId: f.prepared.preparation.id,
        outcome: "success",
      });
      const [code] = await h.db
        .select()
        .from(schema.stationPairingCodes)
        .where(eq(schema.stationPairingCodes.stationDeviceId, device!.id));
      const [binding] = await h.db
        .select()
        .from(schema.workingDeviceEvents)
        .where(eq(schema.workingDeviceEvents.requestId, f.body.requestId));
      const expectedBinding = {
        operation: "issue_replacement_target_code",
        preparationId: f.prepared.preparation.id,
        executionId: f.done.preparation.execution!.id,
        targetDeviceId: device!.id,
        targetKind: kind,
        targetEpoch: 1,
        purpose: "normal",
        pairingCodeId: code!.id,
      };
      expect(audit?.after).toEqual(expectedBinding);
      expect(binding).toMatchObject({
        tenantId: f.tenantId,
        deviceId: device!.id,
        actorDomain: "platform",
        actorId: f.actor.principal.userId,
        action: "observed",
        after: expectedBinding,
      });
      const targetAudits = await h.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.targetId, f.prepared.preparation.id));
      expect(
        targetAudits.find((entry) => entry.action === "device.replacement.target_paired"),
      ).toMatchObject({
        organizationId: f.tenantId,
        actorUserId: null,
        outcome: "success",
        targetType: "device_replacement",
        targetId: f.prepared.preparation.id,
        after: {
          actorDomain: "station_device",
          actorId: device!.id,
          deviceKind: kind,
          executionId: f.done.preparation.execution!.id,
          credentialEpoch: device!.credentialEpoch,
          pairingCodeId: code!.id,
        },
      });
      expect(JSON.stringify({ audit, binding, targetAudits })).not.toContain(f.issued.code);
      const lineId = randomUUID(),
        productId = randomUUID();
      await h.db
        .insert(schema.lines)
        .values({ id: lineId, tenantId: f.tenantId, name: "Target line" });
      await h.db
        .update(schema.stationDevices)
        .set({ lineId })
        .where(eq(schema.stationDevices.id, device!.id));
      await h.db.insert(schema.products).values({
        id: productId,
        tenantId: f.tenantId,
        gtin14: "04680089900024",
        name: "Target product",
        status: "active",
        boxCapacity: 12,
      });
      const start = () =>
        request(app.getHttpServer())
          .post("/shifts")
          .set("x-api-key", paired.body.credential.apiKey)
          .send({ productId, mode: "validation" });
      expect((await start().expect(409)).body).toMatchObject({
        code: "device_replacement_waiting",
        newWorkAllowedAt: f.done.preparation.execution!.newWorkAllowedAt,
      });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.parse(f.done.preparation.execution!.newWorkAllowedAt) + 1);
      const started = await start().expect(201);
      expect(started.body).toMatchObject({ productId, status: "planned", lineId });
      const open = () =>
        request(app.getHttpServer())
          .post(`/shifts/${started.body.id}/open`)
          .set("x-api-key", paired.body.credential.apiKey)
          .send({});
      vi.setSystemTime(Date.parse(f.done.preparation.execution!.newWorkAllowedAt) - 1);
      expect((await open().expect(409)).body.code).toBe("device_replacement_waiting");
      vi.setSystemTime(Date.parse(f.done.preparation.execution!.newWorkAllowedAt) + 1);
      expect((await open().expect(200)).body).toMatchObject({
        id: started.body.id,
        productId,
        status: "active",
        lineId,
      });
    },
  );
  it("lost response requires a fresh issuance, retires the old code and rejects same request replay", async () => {
    const f = await issue();
    await expect(
      targetPairing.issueCode(f.tenantId, f.prepared.preparation.id, f.body, f.actor),
    ).rejects.toThrow();
    const next = await targetPairing.issueCode(
      f.tenantId,
      f.prepared.preparation.id,
      {
        ...f.body,
        requestId: randomUUID(),
        expectedRevision: f.issued.preparation.execution!.revision,
      },
      f.actor,
    );
    await pair(f.issued.code).expect(401);
    await pair(next.code).expect(201);
  });
  it.each(["kind", "expired", "target", "epoch"])(
    "rejects %s mismatch without creating an orphan key",
    async (mismatch) => {
      const f = await issue();
      const target = f.done.preparation.execution!.targetDeviceId!;
      if (mismatch === "expired")
        await h.db
          .update(schema.stationPairingCodes)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(schema.stationPairingCodes.stationDeviceId, target));
      if (mismatch === "target")
        await h.db
          .update(schema.stationPairingCodes)
          .set({ stationDeviceId: f.device.id })
          .where(eq(schema.stationPairingCodes.stationDeviceId, target));
      if (mismatch === "epoch")
        await h.db
          .update(schema.stationDevices)
          .set({ revokedAt: new Date() })
          .where(eq(schema.stationDevices.id, target));
      const before = await h.db.select({ id: schema.apikey.id }).from(schema.apikey);
      await pair(
        f.issued.code,
        mismatch === "kind" ? "handheld-v1,replacement-boundary-v1" : "replacement-boundary-v1",
      ).expect(401);
      expect(await h.db.select({ id: schema.apikey.id }).from(schema.apikey)).toEqual(before);
    },
  );
  it("denies other tenants, read-only and revoked platform authority before code issuance", async () => {
    const f = await issue();
    const other = await emergency();
    await expect(
      targetPairing.issueCode(
        other.tenantId,
        f.prepared.preparation.id,
        { ...f.body, requestId: randomUUID() },
        f.actor,
      ),
    ).rejects.toThrow();
    await h.db
      .update(schema.platformUsers)
      .set({ role: "support" })
      .where(eq(schema.platformUsers.id, f.actor.principal.userId));
    await expect(
      targetPairing.issueCode(
        f.tenantId,
        f.prepared.preparation.id,
        { ...f.body, requestId: randomUUID() },
        f.actor,
      ),
    ).rejects.toThrow();
    await h.db
      .update(schema.platformUsers)
      .set({ role: "platform_admin", status: "disabled" })
      .where(eq(schema.platformUsers.id, f.actor.principal.userId));
    await expect(
      targetPairing.issueCode(
        f.tenantId,
        f.prepared.preparation.id,
        { ...f.body, requestId: randomUUID() },
        f.actor,
      ),
    ).rejects.toThrow();
  });
  it("rolls back the one-time claim and candidate key when target publication fails", async () => {
    const f = await issue();
    const target = f.done.preparation.execution!.targetDeviceId!;
    const before = await h.db.select({ id: schema.apikey.id }).from(schema.apikey);
    await h.connection.pool.query(
      `CREATE FUNCTION reject_target_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${target}'::uuid THEN RAISE EXCEPTION 'test publication failure'; END IF; RETURN NEW; END $$`,
    );
    await h.connection.pool.query(
      `CREATE TRIGGER target_publication_failure BEFORE UPDATE ON station_devices FOR EACH ROW EXECUTE FUNCTION reject_target_publication()`,
    );
    try {
      await pair(f.issued.code).expect(500);
      expect(await h.db.select({ id: schema.apikey.id }).from(schema.apikey)).toEqual(before);
      const codes = await h.db
        .select()
        .from(schema.stationPairingCodes)
        .where(eq(schema.stationPairingCodes.stationDeviceId, target));
      expect(codes).toHaveLength(1);
      expect(codes[0]?.usedAt).toBeNull();
    } finally {
      await h.connection.pool.query("DROP TRIGGER target_publication_failure ON station_devices");
      await h.connection.pool.query("DROP FUNCTION reject_target_publication()");
    }
    await pair(f.issued.code).expect(201);
  });
  it("connects a normally replaced platform target through the legacy normal pairing shape", async () => {
    const base = await h.fixture("station", 1, true);
    const d = await h.drain(base);
    await h.readiness.report(base.identity, d.body);
    const preparation = (await h.service.list(base.tenantId, base.actor)).items[0]!.preparation;
    const f = { ...base, d, preparation };
    const p = await h.preview(f);
    const done = await h.execution.executeNormal(
      f.tenantId,
      f.prepared.preparation.id,
      p.request,
      f.actor,
    );
    const actor = await platform();
    const issued = await targetPairing.issueCode(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: randomUUID(), expectedRevision: done.preparation.execution!.revision },
      actor,
    );
    const paired = await pair(issued.code, "").expect(201);
    expect(paired.body.device.id).toBe(done.preparation.execution!.targetDeviceId);
    expect(paired.body).not.toHaveProperty("replacement");
  });
});
