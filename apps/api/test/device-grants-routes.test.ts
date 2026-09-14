import { verifyGrant } from "@markiro/domain";
import { transitionWorkingAssignment } from "../src/subscriptions/working-device-assignments";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@markiro/db";
import {
  grantIssueResultSchema,
  grantConfigurationSchema,
  grantClientReadinessResponseSchema,
  grantKeysetSchema,
  kioskGrantReservationResultSchema,
} from "@markiro/platform-contracts";
import { AppModule } from "../src/app.module";
import { setupAuth, mountAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";
import { listenOnLoopback } from "./support/listen-loopback";
import { createPublishedPlan, createManagedSubscription } from "./support/subscription-fixtures";
import { seedGrantPolicy } from "./support/grant-policy-fixture";
import { hashDeviceToken } from "../src/pickup/device-token";
const ready = Boolean(process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET);
const negotiate = () => ({
  protocol: "offline-grants-v1",
  capability: "offline-grants-v1",
  requestId: randomUUID(),
});
describe.skipIf(!ready)("native grant route boundaries", () => {
  let app: INestApplication, setup: AuthSetup, db: Db;
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const origin = "https://api.example.invalid";
  beforeAll(async () => {
    const env = {
      ...loadEnv(),
      OFFLINE_GRANT_ORIGIN: origin,
      OFFLINE_GRANT_KID: "test",
      OFFLINE_GRANT_PRIVATE_KEY_PEM: key.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      OFFLINE_GRANT_KEYSET_JSON: JSON.stringify({
        protocol: "offline-grants-v1",
        origin,
        revision: "v1",
        keys: [{ kid: "test", jwk: key.publicKey.export({ format: "jwk" }) }],
        retiredKids: [],
      }),
    };
    setup = setupAuth(env);
    db = setup.db;
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    }).compile();
    app = ref.createNestApplication({ bodyParser: false });
    mountAuth(app.getHttpAdapter().getInstance(), setup.auth);
    app.use(express.json());
    await app.init();
    await listenOnLoopback(app);
  });
  afterAll(async () => {
    await app?.close();
  });
  it("does not register platform readiness routes without platform authentication", async () => {
    await request(app.getHttpServer()).get("/platform/offline-grants/readiness").expect(404);
    await request(app.getHttpServer())
      .post("/platform/offline-grants/readiness/preview")
      .send({})
      .expect(404);
  });
  async function fixture(policyConfigured = true) {
    const agent = request.agent(app.getHttpServer()),
      tenantId = await signUpAndActivate(agent);
    const device = await createTestStationDevice(app, agent, "Grant Station");
    const [row] = await db
      .select()
      .from(schema.stationDevices)
      .where(eq(schema.stationDevices.id, device.deviceId));
    if (!row) throw new Error("Device missing");
    await db.transaction((tx) => transitionWorkingAssignment(tx, row));
    const policy = policyConfigured
      ? await seedGrantPolicy(db, {
          pickup: { "pickup.complete.v1": { maxEvents: 1, maxUnits: 3, maxContainers: 1 } },
        })
      : null;
    const planVersionId = await createPublishedPlan(db, {
      maxLines: 3,
      maxStations: 3,
      maxKiosks: 3,
      maxCabinetUsers: 3,
      ...(policy ? { lifecyclePolicyId: policy.id } : {}),
    });
    await createManagedSubscription(db, { tenantId, planVersionId });
    return { agent, tenantId, ...device };
  }
  it("accepts only native credentials and explicit negotiation, never body origin/owner", async () => {
    const f = await fixture();
    await f.agent.post("/station/grants/v1/device").send(negotiate()).expect(403);
    await request(app.getHttpServer())
      .post("/station/grants/v1/device")
      .send(negotiate())
      .expect(401);
    const publicToken = `public-${randomUUID()}`;
    await db.insert(schema.apikey).values({
      id: randomUUID(),
      referenceId: f.tenantId,
      configId: "public",
      key: createHash("sha256").update(publicToken).digest("base64url"),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await request(app.getHttpServer())
      .post("/station/grants/v1/device")
      .set("x-api-key", publicToken)
      .send(negotiate())
      .expect(401);
    for (const patch of [
      { protocol: "offline-grants-v2" },
      { origin: "https://attacker.invalid" },
      { owner: { tenantId: f.tenantId } },
      { capabilities: ["pickup.start.v1"] },
    ]) {
      await request(app.getHttpServer())
        .post("/station/grants/v1/device")
        .set("x-api-key", f.apiKey)
        .send({ ...negotiate(), ...patch })
        .expect(400);
    }
    const result = await request(app.getHttpServer())
      .post("/station/grants/v1/device")
      .set("x-api-key", f.apiKey)
      .send(negotiate())
      .expect(200);
    expect(grantIssueResultSchema.parse(result.body)).toMatchObject({
      status: "issued",
      envelope: {
        mode: "observe",
        owner: { tenantId: f.tenantId, deviceId: f.deviceId },
        taskSnapshots: [],
      },
    });
    await request(app.getHttpServer())
      .get("/kiosk/grants/v1/keyset")
      .set("x-kiosk-token", f.apiKey)
      .expect(401);
  });
  it("keeps authenticated key recovery available after subscription expiry and denies new grants", async () => {
    const f = await fixture();
    await db
      .update(schema.tenantSubscriptions)
      .set({ startsAt: new Date(Date.now() - 20000), endsAt: new Date(Date.now() - 10000) })
      .where(eq(schema.tenantSubscriptions.tenantId, f.tenantId));
    const result = await request(app.getHttpServer())
      .get("/station/grants/v1/keyset")
      .set("x-api-key", f.apiKey)
      .expect(200);
    expect(grantKeysetSchema.parse(result.body)).toMatchObject({ origin, revision: "v1" });
    const configuration = await request(app.getHttpServer())
      .post("/station/grants/v1/configuration")
      .set("x-api-key", f.apiKey)
      .send(negotiate())
      .expect(200);
    expect(grantConfigurationSchema.parse(configuration.body)).toMatchObject({
      mode: "observe",
      owner: { tenantId: f.tenantId, deviceId: f.deviceId },
      keyset: { origin },
    });
    await request(app.getHttpServer())
      .post("/station/grants/v1/configuration")
      .set("x-api-key", f.apiKey)
      .send({ ...negotiate(), mode: "strict" })
      .expect(400);
    await f.agent.post("/station/grants/v1/configuration").send(negotiate()).expect(403);

    await request(app.getHttpServer())
      .post("/station/grants/v1/device")
      .set("x-api-key", f.apiKey)
      .send(negotiate())
      .expect(403);
  });
  it("accepts a strict readiness report only through the native station boundary", async () => {
    const f = await fixture();
    await request(app.getHttpServer())
      .post("/station/grants/v1/configuration")
      .set("x-api-key", f.apiKey)
      .send(negotiate())
      .expect(200);
    await request(app.getHttpServer())
      .post("/station/grants/v1/device")
      .set("x-api-key", f.apiKey)
      .send(negotiate())
      .expect(200);
    const [configuration] = await db
      .select()
      .from(schema.deviceGrantConfigurations)
      .where(eq(schema.deviceGrantConfigurations.tenantId, f.tenantId));
    const [issuance] = await db
      .select()
      .from(schema.deviceGrantIssuances)
      .where(eq(schema.deviceGrantIssuances.tenantId, f.tenantId));
    if (!configuration || !issuance) throw new Error("Readiness fixture was not issued");
    const body = {
      protocol: "offline-grants-v1",
      capability: "offline-grants-readiness-v1",
      requestId: randomUUID(),
      clientBuild: "station:test",
      storageRevision: 14,
      installed: {
        mode: configuration.mode,
        policyRevision: configuration.policyRevision,
        keysetRevision: "v1",
        verifiedGrantId: issuance.grantId,
      },
    };
    const result = await request(app.getHttpServer())
      .post("/station/grants/v1/readiness")
      .set("x-api-key", f.apiKey)
      .send(body)
      .expect(200);
    expect(grantClientReadinessResponseSchema.parse(result.body)).toMatchObject({
      requestId: body.requestId,
      accepted: true,
      matchesCurrentConfiguration: true,
      verifiedGrantMatched: true,
    });
    await f.agent.post("/station/grants/v1/readiness").send(body).expect(403);
    await request(app.getHttpServer())
      .post("/station/grants/v1/readiness")
      .set("x-api-key", f.apiKey)
      .send({ ...body, clientBuild: "station:changed" })
      .expect(409);
  });
  it("returns policy_not_configured without disturbing existing native reads", async () => {
    const f = await fixture(false);
    const result = await request(app.getHttpServer())
      .post("/station/grants/v1/device")
      .set("x-api-key", f.apiKey)
      .send(negotiate())
      .expect(200);
    expect(result.body).toEqual({ status: "denied", reason: "policy_not_configured" });
    await request(app.getHttpServer())
      .get("/station/grants/v1/keyset")
      .set("x-api-key", f.apiKey)
      .expect(200);
  });
  it("attests canonical kiosk scope before identity-only task issuance and returns matching bytes", async () => {
    const f = await fixture(),
      kioskId = randomUUID(),
      token = randomUUID(),
      productId = randomUUID();
    await db.insert(schema.kiosks).values({
      id: kioskId,
      tenantId: f.tenantId,
      name: "Grant kiosk",
      deviceTokenHash: hashDeviceToken(token),
    });
    await db.insert(schema.products).values({
      id: productId,
      tenantId: f.tenantId,
      gtin14: "04600682000013",
      name: "Kiosk product",
      status: "active",
    });
    await db.insert(schema.kioskProducts).values({ tenantId: f.tenantId, kioskId, productId });
    const order = {
      deviceSeq: 1,
      badgeDigest: Buffer.alloc(32, 1).toString("base64"),
      reason: "buy",
      items: [{ rawKm: "010460068200001321TESTSERIAL123\u001d93ABCD" }],
      admissionNonce: randomUUID(),
    };
    const reserved = await request(app.getHttpServer())
      .post("/kiosk/grants/v1/reservations")
      .set("x-kiosk-token", token)
      .send({ ...negotiate(), order })
      .expect(200);
    const result = kioskGrantReservationResultSchema.parse(reserved.body);
    if (result.status !== "reserved") throw new Error(`Reservation denied: ${result.reason}`);
    const body = { ...negotiate(), taskKind: "pickup", taskId: result.task.taskId };
    const issued = await request(app.getHttpServer())
      .post("/kiosk/grants/v1/tasks")
      .set("x-kiosk-token", token)
      .send(body)
      .expect(200);
    const parsed = grantIssueResultSchema.parse(issued.body);
    if (parsed.status !== "issued") throw new Error(`Issue denied: ${parsed.reason}`);
    const binding = parsed.envelope.taskSnapshots[0];
    expect(binding?.snapshotDigest).toBe(result.task.snapshotDigest);
    const verified = await verifyGrant(
      parsed.envelope.grants[0] ?? "",
      [{ kid: "test", origin, jwk: key.publicKey.export({ format: "jwk" }) }],
      origin,
    );
    expect(verified).toMatchObject({
      ok: true,
      grant: {
        kindOfGrant: "task",
        taskKind: "pickup",
        taskId: result.task.taskId,
        snapshotDigest: result.task.snapshotDigest,
        deviceId: kioskId,
        tenantId: f.tenantId,
      },
    });
    expect(
      createHash("sha256")
        .update(binding?.canonical ?? "")
        .digest("hex"),
    ).toBe(result.task.snapshotDigest);
    const [source] = await db
      .select()
      .from(schema.deviceGrantTaskSources)
      .where(
        and(
          eq(schema.deviceGrantTaskSources.tenantId, f.tenantId),
          eq(schema.deviceGrantTaskSources.taskId, result.task.taskId),
        ),
      );
    expect(JSON.parse(binding?.canonical ?? "{}")).toEqual({
      taskKind: "pickup",
      taskId: result.task.taskId,
      scope: source?.scope,
    });
    const replay = await request(app.getHttpServer())
      .post("/kiosk/grants/v1/tasks")
      .set("x-kiosk-token", token)
      .send(body)
      .expect(200);
    expect(replay.body.envelope.grants).toEqual(parsed.envelope.grants);
    expect(replay.body.envelope.taskSnapshots).toEqual(parsed.envelope.taskSnapshots);
    await request(app.getHttpServer())
      .post("/kiosk/grants/v1/tasks")
      .set("x-kiosk-token", token)
      .send({ ...body, taskId: randomUUID() })
      .expect(409);
    await request(app.getHttpServer())
      .post("/kiosk/grants/v1/tasks")
      .set("x-kiosk-token", token)
      .send({ ...body, bounds: { units: 999 } })
      .expect(400);
  });
});
