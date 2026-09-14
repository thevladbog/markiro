import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { schema, type Db } from "@markiro/db";
import {
  INVENTORY_CHZ_STATUSES,
  buildDuplicateLabelTemplate,
  PRODUCT_LABEL_PROTOCOL,
  assessCompletion,
  canonicalizeKm,
  kmHash,
  assessNewWork,
  grantEventCost,
  inventoryEventBatchDigest,
  productLabelValueDigest,
  verifyGrant,
  type GrantIntent,
  type InventoryEventBatchPayload,
} from "@markiro/domain";
import {
  grantEvidenceReceiptSchema,
  grantIssueResultSchema,
  kioskGrantReservationResultSchema,
} from "@markiro/platform-contracts";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { DB } from "../src/auth/auth.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { hashDeviceToken } from "../src/pickup/device-token";
import { loadEnv } from "../src/env";
import { grantEvidenceBodyParser } from "../src/modules/device-grants/evidence-body-parser";
import { GrantEvidenceService } from "../src/modules/device-grants/grant-evidence.service";
import { GrantIssuerService } from "../src/modules/device-grants/grant-issuer.service";
import {
  GRANT_SIGNING_CONFIGURATION,
  type GrantSigningConfiguration,
} from "../src/modules/device-grants/grant-keyset";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { transitionWorkingAssignment } from "../src/subscriptions/working-device-assignments";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";
import { seedGrantPolicy } from "./support/grant-policy-fixture";
import { listenOnLoopback } from "./support/listen-loopback";
import { createManagedSubscription, createPublishedPlan } from "./support/subscription-fixtures";

const ready = Boolean(process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET);
const negotiate = () => ({
  protocol: "offline-grants-v1",
  capability: "offline-grants-v1",
  requestId: randomUUID(),
});

describe.skipIf(!ready)("public preparation and bounded native execution workflow", () => {
  let app: INestApplication, setup: AuthSetup, db: Db;
  let now = Date.now();
  const origin = "https://api.example.invalid";
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const objects = new Map<string, Buffer>();
  const storage = {
    putVerified: vi.fn(async (name: string, bytes: Buffer, _mime: string, sha256: string) => {
      objects.set(name, Buffer.from(bytes));
      return { byteSize: bytes.length, sha256 };
    }),
    get: vi.fn(async (name: string) => {
      const body = objects.get(name);
      if (!body) throw new Error("Test object is absent");
      return { body, contentType: "text/csv" };
    }),
    delete: vi.fn(async (name: string) => {
      objects.delete(name);
    }),
  };

  beforeAll(async () => {
    const env = {
      ...loadEnv(),
      VALIDATION_DM_DUPLICATE_ENABLED: true,
      OFFLINE_GRANT_ORIGIN: origin,
      OFFLINE_GRANT_KID: "workflow-test",
      OFFLINE_GRANT_PRIVATE_KEY_PEM: key.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      OFFLINE_GRANT_KEYSET_JSON: JSON.stringify({
        protocol: "offline-grants-v1",
        origin,
        revision: "workflow-test-v1",
        keys: [{ kid: "workflow-test", jwk: key.publicKey.export({ format: "jwk" }) }],
        retiredKids: [],
      }),
    };
    setup = setupAuth(env);
    db = setup.db;
    const module = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    })
      .overrideProvider(ObjectStorageService)
      .useValue(storage)
      .overrideProvider(GrantIssuerService)
      .useFactory({
        inject: [DB, EntitlementsService, GRANT_SIGNING_CONFIGURATION],
        factory: (
          database: Db,
          entitlements: EntitlementsService,
          signing: GrantSigningConfiguration,
        ) => new GrantIssuerService(database, entitlements, signing, () => now),
      })
      .overrideProvider(GrantEvidenceService)
      .useFactory({
        inject: [DB],
        factory: (database: Db) => new GrantEvidenceService(database, () => now),
      })
      .compile();
    app = module.createNestApplication({ bodyParser: false });
    mountAuth(app.getHttpAdapter().getInstance(), setup.auth);
    app.use(grantEvidenceBodyParser);
    app.use(express.json({ limit: "2mb" }));
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("creates a public task, binds native authority and exhausts the frozen allowance", async () => {
    const cabinet = request.agent(app.getHttpServer());
    const tenantId = await signUpAndActivate(cabinet);
    const station = await createTestStationDevice(app, cabinet, "Workflow station");
    const productId = randomUUID(),
      lineId = randomUUID(),
      keyId = randomUUID(),
      publicKey = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: "04680089900383",
      name: "Workflow water",
      boxCapacity: 12,
      status: "active",
    });
    await db.insert(schema.lines).values({ id: lineId, tenantId, name: "Workflow line" });
    const [device] = await db
      .update(schema.stationDevices)
      .set({ lineId })
      .where(eq(schema.stationDevices.id, station.deviceId))
      .returning();
    if (!device) throw new Error("Workflow device is absent");
    await db.transaction((tx) => transitionWorkingAssignment(tx, device));
    const policy = await seedGrantPolicy(
      db,
      {
        inventoryCheck: {
          "inventory.scan.v1": { maxEvents: 1, maxUnits: 1 },
          "inventory.close.v1": { maxEvents: 1 },
        },
      },
      undefined,
      {
        protocol: "offline-grants-v1",
        mode: "strict",
        deviceIds: [station.deviceId],
        decisionReference: "TEST-ONLY",
      },
    );
    const planVersionId = await createPublishedPlan(db, {
      maxLines: 3,
      maxStations: 3,
      maxKiosks: 3,
      maxCabinetUsers: 3,
      publicApiEnabled: true,
      lifecyclePolicyId: policy.id,
    });
    const managed = await createManagedSubscription(db, { tenantId, planVersionId });
    const sourceId = randomUUID();
    await db.insert(schema.entitlementSources).values({
      id: sourceId,
      versionId: sourceId,
      tenantId,
      subscriptionId: managed.subscriptionId,
      kind: "compatibility",
      effects: [{ key: "inventory", featureEnabled: true }],
      operationIds: [
        "public.inventory.read.v1",
        "public.inventory.create.v1",
        "public.inventory.import.v1",
        "public.inventory.snapshot.v1",
        "public.inventory.start.v1",
        "native.inventory.start.v1",
      ],
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 600_000),
      reason: "Workflow test",
      decisionReference: "TEST-ONLY",
      requestId: randomUUID(),
      createdByPlatformUserId: policy.approvedByPlatformUserId,
    });
    await db.insert(schema.apikey).values({
      id: keyId,
      referenceId: tenantId,
      configId: "public",
      key: createHash("sha256").update(publicKey).digest("base64url"),
      enabled: true,
      rateLimitEnabled: false,
      metadata: JSON.stringify({
        kind: "public",
        scopes: ["catalog.products.read", "inventory.read", "inventory.prepare", "inventory.start"],
      }),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const http = request(app.getHttpServer());
    const created = await http
      .post("/public/v1/inventories")
      .set("x-api-key", publicKey)
      .set("Idempotency-Key", "workflow-create")
      .send({
        productId,
        lineId,
        mode: "check",
        productionDateFrom: "2026-08-01",
        productionDateTo: "2026-08-31",
        boxLabelTemplateId: null,
      })
      .expect(201);
    const inventoryId: string = created.body.id;
    const fixture = readFileSync(
      join(__dirname, "fixtures/inventory/chz-introduced.csv"),
      "utf8",
    ).replace('"MOVING_BY_UD"', '""');
    const dataRow = fixture.trimEnd().split(/\r?\n/).at(-1);
    if (!dataRow) throw new Error("Workflow source row is absent");
    const source = `${fixture.trimEnd()}\n${dataRow.replace("SYNTHETIC-001", "SYNTHETIC-002")}\n`;
    const [filter = "", header = ""] = source.split(/\r?\n/);
    const imports: Record<string, string> = {};
    for (const status of INVENTORY_CHZ_STATUSES) {
      const bytes = Buffer.from(
        status === "INTRODUCED"
          ? source
          : `${filter.replaceAll("INTRODUCED", status)}\n${header}\nerrors\n5: Коды маркировки не найдены\n`,
      );
      const imported = await http
        .post(`/public/v1/inventories/${inventoryId}/imports/${status}`)
        .set("x-api-key", publicKey)
        .set("Idempotency-Key", `workflow-${status}`)
        .attach("file", bytes, { filename: `${status}.csv`, contentType: "text/csv" })
        .expect(201);
      imports[status] = imported.body.id;
    }
    const fixed = await http
      .post(`/public/v1/inventories/${inventoryId}/snapshots`)
      .set("x-api-key", publicKey)
      .set("Idempotency-Key", "workflow-snapshot")
      .send({ imports })
      .expect(201);
    await http
      .post(`/public/v1/inventories/${inventoryId}/start`)
      .set("x-api-key", publicKey)
      .set("Idempotency-Key", "workflow-start")
      .send({})
      .expect(201);
    const employee = await cabinet
      .post("/employees")
      .send({ fullName: "Workflow operator" })
      .expect(201);
    const operatorId: string = employee.body.id;
    await cabinet
      .put(`/operators/${operatorId}`)
      .send({ login: "567890", pin: "1234" })
      .expect(200);
    const joined = await http
      .post(`/station/inventories/${inventoryId}/join`)
      .set("x-api-key", station.apiKey)
      .send({ operatorId })
      .expect(200);
    expect(joined.body.snapshotId).toBe(fixed.body.id);
    now = Date.now();
    const deviceResult = grantIssueResultSchema.parse(
      (
        await http
          .post("/station/grants/v1/device")
          .set("x-api-key", station.apiKey)
          .send(negotiate())
          .expect(200)
      ).body,
    );
    const taskResult = grantIssueResultSchema.parse(
      (
        await http
          .post("/station/grants/v1/tasks")
          .set("x-api-key", station.apiKey)
          .send({ ...negotiate(), taskKind: "inventory", taskId: inventoryId })
          .expect(200)
      ).body,
    );
    if (deviceResult.status !== "issued" || taskResult.status !== "issued")
      throw new Error(`Workflow grants denied: ${JSON.stringify([deviceResult, taskResult])}`);
    expect(taskResult.envelope.mode).toBe("strict");
    const keys = [{ kid: "workflow-test", origin, jwk: key.publicKey.export({ format: "jwk" }) }];
    const deviceToken = await verifyGrant(deviceResult.envelope.grants[0] ?? "", keys, origin);
    const taskToken = await verifyGrant(taskResult.envelope.grants[0] ?? "", keys, origin);
    if (
      !deviceToken.ok ||
      deviceToken.grant.kindOfGrant !== "device" ||
      !taskToken.ok ||
      taskToken.grant.kindOfGrant !== "task"
    )
      throw new Error("Workflow grants failed signature/type verification");
    const cost = grantEventCost("inventory.scan.v1", { units: 1 });
    if (!cost) throw new Error("Workflow event has no dimensions");
    const intent: GrantIntent = {
      owner: taskResult.envelope.owner,
      capability: "inventory.start.v1",
      taskId: inventoryId,
      snapshotDigest: taskToken.grant.snapshotDigest,
      eventId: randomUUID(),
      eventType: "inventory.scan.v1",
      cost,
    };
    now = deviceToken.grant.startNotAfter;
    expect(assessNewWork(deviceToken.grant, intent, now)).toEqual({
      allow: false,
      reason: "expired",
    });
    expect(assessCompletion(taskToken.grant, intent, now, {})).toEqual({ allow: true });
    expect(
      assessCompletion(taskToken.grant, { ...intent, eventId: randomUUID() }, now, cost),
    ).toEqual({ allow: false, reason: "budget_exhausted" });
    const [snapshot] = await db
      .select()
      .from(schema.inventorySnapshots)
      .where(
        and(
          eq(schema.inventorySnapshots.tenantId, tenantId),
          eq(schema.inventorySnapshots.id, fixed.body.id),
        ),
      );
    expect(snapshot).toMatchObject({ fixedByPublicKeyId: keyId, fixedByUserId: null });
    const expectedCodes = await db
      .select()
      .from(schema.inventorySnapshotCodes)
      .where(
        and(
          eq(schema.inventorySnapshotCodes.tenantId, tenantId),
          eq(schema.inventorySnapshotCodes.snapshotId, fixed.body.id),
          eq(schema.inventorySnapshotCodes.expected, true),
        ),
      )
      .limit(2);
    expect(expectedCodes).toHaveLength(2);
    const envelope = (index: number) => {
      const code = expectedCodes[index];
      if (!code) throw new Error("Workflow expected code is absent");
      const payload: InventoryEventBatchPayload = {
        snapshotId: fixed.body.id,
        snapshotRevision: 1,
        sequenceCeiling: index + 1,
        pendingEventCount: 0,
        openBoxCount: 0,
        events: [
          {
            eventId: randomUUID(),
            deviceSequence: index + 1,
            operatorId,
            scannedAt: new Date(now).toISOString(),
            kind: "item",
            normalizedIdentity: `item:${code.codeHash}`,
            codeHash: code.codeHash,
            canonicalRaw: code.canonicalRaw,
            activeProductionDate: "2026-08-20",
            localVerdict: "expected",
          },
        ],
      };
      const batchId = randomUUID();
      const native = { ...payload, batchId, payloadDigest: inventoryEventBatchDigest(payload) };
      return {
        protocol: "offline-grants-v1",
        batchId,
        payloadDigest: productLabelValueDigest(native),
        grants: taskResult.envelope.grants,
        eventGrants: { "/events/0#inventory.scan.v1": taskToken.grant.grantId },
        payload: native,
      };
    };
    const first = envelope(0);
    const firstWire = JSON.stringify(first, null, 2);
    const route = `/station/grants/v1/evidence/inventories/${inventoryId}/event-batches`;
    const accepted = grantEvidenceReceiptSchema.parse(
      (
        await http
          .post(route)
          .set("x-api-key", station.apiKey)
          .set("Content-Type", "application/json")
          .send(firstWire)
          .expect(200)
      ).body,
    );
    expect(accepted).toMatchObject({
      outcome: "accepted",
      reason: null,
      reconciliation: { status: "applied" },
    });
    const excess = grantEvidenceReceiptSchema.parse(
      (await http.post(route).set("x-api-key", station.apiKey).send(envelope(1)).expect(200)).body,
    );
    expect(excess).toMatchObject({
      outcome: "quarantined",
      reason: "budget_exceeded",
      reconciliation: { status: "not_applied" },
    });
    const withoutPublic = await createPublishedPlan(db, {
      maxLines: 3,
      maxStations: 3,
      maxKiosks: 3,
      maxCabinetUsers: 3,
      publicApiEnabled: false,
      lifecyclePolicyId: policy.id,
    });
    await db
      .update(schema.tenantSubscriptions)
      .set({ planVersionId: withoutPublic })
      .where(eq(schema.tenantSubscriptions.id, managed.subscriptionId));
    await http.get(`/public/v1/inventories/${inventoryId}`).set("x-api-key", publicKey).expect(403);
    await http
      .get(`/station/inventories/${inventoryId}/bundle/manifest`)
      .set("x-api-key", station.apiKey)
      .expect(200);
    now = taskToken.grant.completeNotAfter + 1;
    await db
      .update(schema.tenantSubscriptions)
      .set({ startsAt: new Date(Date.now() - 20_000), endsAt: new Date(Date.now() - 10_000) })
      .where(eq(schema.tenantSubscriptions.id, managed.subscriptionId));
    const replay = grantEvidenceReceiptSchema.parse(
      (await http.post(route).set("x-api-key", station.apiKey).send(first).expect(200)).body,
    );
    expect(replay).toEqual({ ...accepted, outcome: "duplicate" });
    const events = await db
      .select()
      .from(schema.inventoryScanEvents)
      .where(
        and(
          eq(schema.inventoryScanEvents.tenantId, tenantId),
          eq(schema.inventoryScanEvents.inventoryId, inventoryId),
        ),
      );
    expect(events).toHaveLength(1);
    const consumption = await db
      .select()
      .from(schema.deviceGrantConsumption)
      .where(eq(schema.deviceGrantConsumption.tenantId, tenantId));
    expect(consumption).toHaveLength(2);
    expect(
      consumption
        .map(({ budgetLineId, consumed }) => ({ budgetLineId, consumed }))
        .sort((a, b) => a.budgetLineId.localeCompare(b.budgetLineId)),
    ).toEqual([
      { budgetLineId: "inventory.scan.v1:events", consumed: 1 },
      { budgetLineId: "inventory.scan.v1:units", consumed: 1 },
    ]);
    const [receipt] = await db
      .select()
      .from(schema.deviceGrantIngestReceipts)
      .where(eq(schema.deviceGrantIngestReceipts.id, accepted.receiptId));
    expect(receipt?.retainedPayload.payload).toEqual(first.payload);
    expect(receipt?.transportDigest).toBe(createHash("sha256").update(firstWire).digest("hex"));
    const [saved] = await db
      .select()
      .from(schema.inventories)
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    expect(saved).toMatchObject({
      createdByPublicKeyId: keyId,
      createdByUserId: null,
      status: "running",
    });
  });
  it("reconciles real shift scans and closure through negotiated native owners", async () => {
    now = Date.now();
    const cabinet = request.agent(app.getHttpServer()),
      tenantId = await signUpAndActivate(cabinet);
    const station = await createTestStationDevice(app, cabinet, "Evidence shift station");
    const [device] = await db
      .select()
      .from(schema.stationDevices)
      .where(eq(schema.stationDevices.id, station.deviceId));
    if (!device) throw new Error("Shift device absent");
    await db.transaction((tx) => transitionWorkingAssignment(tx, device));
    const policy = await seedGrantPolicy(
      db,
      {
        shift: {
          "shift.scan.v1": { maxEvents: 1, maxUnits: 1 },
          "shift.close.v1": { maxEvents: 1 },
        },
      },
      undefined,
      {
        protocol: "offline-grants-v1",
        mode: "strict",
        deviceIds: [station.deviceId],
        decisionReference: "TEST-ONLY",
      },
    );
    const planVersionId = await createPublishedPlan(db, {
      maxLines: 3,
      maxStations: 3,
      maxKiosks: 3,
      maxCabinetUsers: 3,
      lifecyclePolicyId: policy.id,
    });
    await createManagedSubscription(db, { tenantId, planVersionId });
    const productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: "04680089900383",
      name: "Evidence product",
      status: "active",
    });
    const created = await cabinet
      .post("/shifts")
      .send({ productId, mode: "validation" })
      .expect(201);
    const shiftId: string = created.body.id;
    await request(app.getHttpServer())
      .post(`/shifts/${shiftId}/open`)
      .set("x-api-key", station.apiKey)
      .expect(200);
    now = Date.now();
    const issued = grantIssueResultSchema.parse(
      (
        await request(app.getHttpServer())
          .post("/station/grants/v1/tasks")
          .set("x-api-key", station.apiKey)
          .send({ ...negotiate(), taskKind: "shift", taskId: shiftId })
          .expect(200)
      ).body,
    );
    if (issued.status !== "issued") throw new Error(`Shift grant denied: ${issued.reason}`);
    const verified = await verifyGrant(
      issued.envelope.grants[0] ?? "",
      [{ kid: "workflow-test", origin, jwk: key.publicKey.export({ format: "jwk" }) }],
      origin,
    );
    if (!verified.ok || verified.grant.kindOfGrant !== "task")
      throw new Error("Shift grant invalid");
    const grantId = verified.grant.grantId;
    const body = (sequence: number) => {
      const raw = `010468008990038321EVIDENCE-${sequence}`,
        km = canonicalizeKm(raw);
      return {
        batchId: randomUUID(),
        items: [
          {
            shiftId,
            terminalId: station.deviceId,
            raw,
            verdict: "ok",
            scannedAt: new Date(now).toISOString(),
            code: { codeHash: kmHash(km), gtin14: km.gtin14, serial: km.serial },
            boxId: null,
            operatorId: null,
          },
        ],
      };
    };
    const evidence = (payload: Record<string, unknown>, pointer: string) => ({
      protocol: "offline-grants-v1",
      batchId: randomUUID(),
      payloadDigest: productLabelValueDigest(payload),
      grants: issued.envelope.grants,
      eventGrants: { [pointer]: grantId },
      payload,
    });
    const first = evidence(body(1), "/items/0#shift.scan.v1"),
      http = request(app.getHttpServer());
    const accepted = grantEvidenceReceiptSchema.parse(
      (
        await http
          .post("/station/grants/v1/evidence/scans")
          .set("x-api-key", station.apiKey)
          .send(first)
          .expect(200)
      ).body,
    );
    expect(accepted).toMatchObject({
      outcome: "accepted",
      reason: null,
      reconciliation: { status: "applied" },
    });
    const excess = grantEvidenceReceiptSchema.parse(
      (
        await http
          .post("/station/grants/v1/evidence/scans")
          .set("x-api-key", station.apiKey)
          .send(evidence(body(2), "/items/0#shift.scan.v1"))
          .expect(200)
      ).body,
    );
    expect(excess).toMatchObject({ outcome: "quarantined", reason: "budget_exceeded" });
    expect(
      await db
        .select()
        .from(schema.codes)
        .where(and(eq(schema.codes.tenantId, tenantId), eq(schema.codes.shiftId, shiftId))),
    ).toHaveLength(1);
    const closure = evidence(
      {
        eventId: randomUUID(),
        shiftId,
        operatorId: null,
        plannedQtySnapshot: null,
        actualQty: 1,
        closedBoxCount: 0,
        closedAt: new Date(now).toISOString(),
      },
      "/#shift.close.v1",
    );
    const closed = grantEvidenceReceiptSchema.parse(
      (
        await http
          .post("/station/grants/v1/evidence/shift-closures")
          .set("x-api-key", station.apiKey)
          .send(closure)
          .expect(200)
      ).body,
    );
    expect(closed).toMatchObject({
      outcome: "accepted",
      reason: null,
      reconciliation: { status: "applied", result: { outcome: "accepted" } },
    });
    const [saved] = await db.select().from(schema.shifts).where(eq(schema.shifts.id, shiftId));
    expect(saved?.status).toBe("closed");
    expect(
      (
        await http
          .post("/station/grants/v1/evidence/shift-closures")
          .set("x-api-key", station.apiKey)
          .send(closure)
          .expect(200)
      ).body,
    ).toEqual({ ...closed, outcome: "duplicate" });
  });

  it("reconciles a reserved kiosk pickup and preserves sanitized historical evidence", async () => {
    now = Date.now();
    const cabinet = request.agent(app.getHttpServer()),
      tenantId = await signUpAndActivate(cabinet);
    const kioskId = randomUUID(),
      token = randomUUID(),
      productId = randomUUID(),
      employeeId = randomUUID(),
      badgeCode = `fixture-${randomUUID()}`;
    const policy = await seedGrantPolicy(
      db,
      { pickup: { "pickup.complete.v1": { maxEvents: 1, maxUnits: 1, maxContainers: 0 } } },
      undefined,
      {
        protocol: "offline-grants-v1",
        mode: "strict",
        deviceIds: [kioskId],
        decisionReference: "TEST-ONLY",
      },
    );
    const planVersionId = await createPublishedPlan(db, {
      maxLines: 3,
      maxStations: 3,
      maxKiosks: 3,
      maxCabinetUsers: 3,
      lifecyclePolicyId: policy.id,
    });
    await createManagedSubscription(db, { tenantId, planVersionId });
    await db
      .insert(schema.employees)
      .values({ id: employeeId, tenantId, fullName: "Evidence employee" });
    await db.insert(schema.employeeBadges).values({ tenantId, employeeId, badgeCode });
    await db
      .insert(schema.employeePickupPolicies)
      .values({ tenantId, employeeId, limitMode: "unlimited", dayLimit: 1, canWriteoff: false });
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: "04600682000013",
      name: "Evidence pickup",
      status: "active",
    });
    await db.insert(schema.kiosks).values({
      id: kioskId,
      tenantId,
      name: "Evidence kiosk",
      deviceTokenHash: hashDeviceToken(token),
    });
    await db.insert(schema.kioskProducts).values({ tenantId, kioskId, productId });
    const http = request(app.getHttpServer());
    const order = {
      deviceSeq: 1,
      badgeCode,
      reason: "buy",
      items: [{ rawKm: "010460068200001321TESTSERIAL123\u001d93ABCD" }],
    };
    const reserved = kioskGrantReservationResultSchema.parse(
      (
        await http
          .post("/kiosk/grants/v1/reservations")
          .set("x-kiosk-token", token)
          .send({ ...negotiate(), order: { ...order, admissionNonce: randomUUID() } })
          .expect(200)
      ).body,
    );
    if (reserved.status !== "reserved")
      throw new Error(`Pickup reservation denied: ${reserved.reason}`);
    now = Date.now();
    const issued = grantIssueResultSchema.parse(
      (
        await http
          .post("/kiosk/grants/v1/tasks")
          .set("x-kiosk-token", token)
          .send({ ...negotiate(), taskKind: "pickup", taskId: reserved.task.taskId })
          .expect(200)
      ).body,
    );
    if (issued.status !== "issued") throw new Error(`Pickup grant denied: ${issued.reason}`);
    const verified = await verifyGrant(
      issued.envelope.grants[0] ?? "",
      [{ kid: "workflow-test", origin, jwk: key.publicKey.export({ format: "jwk" }) }],
      origin,
    );
    if (!verified.ok || verified.grant.kindOfGrant !== "task")
      throw new Error("Pickup grant invalid");
    const payload = {
      ...order,
      createdAt: reserved.admission.claimedAt,
      admissionProof: reserved.admission.admissionProof,
    };
    const envelope = {
      protocol: "offline-grants-v1",
      batchId: randomUUID(),
      payloadDigest: productLabelValueDigest(payload),
      grants: issued.envelope.grants,
      eventGrants: { "/#pickup.complete.v1": verified.grant.grantId },
      payload,
    };
    const accepted = grantEvidenceReceiptSchema.parse(
      (
        await http
          .post("/kiosk/grants/v1/evidence/orders")
          .set("x-kiosk-token", token)
          .send(envelope)
          .expect(200)
      ).body,
    );
    expect(accepted).toMatchObject({
      outcome: "accepted",
      reason: null,
      reconciliation: { status: "applied", result: { itemCount: 1, status: "pending" } },
    });
    now = verified.grant.completeNotAfter + 1;
    expect(
      (
        await http
          .post("/kiosk/grants/v1/evidence/orders")
          .set("x-kiosk-token", token)
          .send(envelope)
          .expect(200)
      ).body,
    ).toEqual({ ...accepted, outcome: "duplicate" });
    expect(
      await db.select().from(schema.pickupOrders).where(eq(schema.pickupOrders.tenantId, tenantId)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(schema.kioskOrderAdmissions)
        .where(eq(schema.kioskOrderAdmissions.tenantId, tenantId)),
    ).toHaveLength(0);
    const repeated = grantEvidenceReceiptSchema.parse(
      (
        await http
          .post("/kiosk/grants/v1/evidence/orders")
          .set("x-kiosk-token", token)
          .send({ ...envelope, batchId: randomUUID() })
          .expect(200)
      ).body,
    );
    expect(repeated).toMatchObject({
      outcome: "accepted",
      reason: null,
      reconciliation: accepted.reconciliation,
    });
    const effects = await db
      .select()
      .from(schema.deviceGrantEffects)
      .where(eq(schema.deviceGrantEffects.tenantId, tenantId));
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ taskKind: "pickup", taskId: reserved.task.taskId });
    expect(
      (
        await db
          .select()
          .from(schema.deviceGrantConsumption)
          .where(eq(schema.deviceGrantConsumption.tenantId, tenantId))
      )
        .map((row) => ({ line: row.budgetLineId, consumed: row.consumed }))
        .sort((a, b) => a.line.localeCompare(b.line)),
    ).toEqual([
      { line: "pickup.complete.v1:containers", consumed: 0 },
      { line: "pickup.complete.v1:events", consumed: 1 },
      { line: "pickup.complete.v1:units", consumed: 1 },
    ]);
    const [receipt] = await db
      .select()
      .from(schema.deviceGrantIngestReceipts)
      .where(eq(schema.deviceGrantIngestReceipts.id, accepted.receiptId));
    expect(receipt?.retainedPayload.payload).toMatchObject({
      items: order.items,
      badgeCodeHash: createHash("sha256").update(badgeCode).digest("hex"),
      admissionProofHash: createHash("sha256").update(payload.admissionProof).digest("hex"),
    });
    expect(receipt?.retainedPayload.payload).not.toHaveProperty("badgeCode");
    expect(receipt?.retainedPayload.payload).not.toHaveProperty("admissionProof");
  });
  it.each([false, true])(
    "charges native validation reprocessing once with a same-hash competing item=%s",
    async (competing) => {
      now = Date.now();
      const cabinet = request.agent(app.getHttpServer());
      const tenantId = await signUpAndActivate(cabinet);
      const station = await createTestStationDevice(app, cabinet, "Reprocessing evidence");
      const [device] = await db
        .select()
        .from(schema.stationDevices)
        .where(eq(schema.stationDevices.id, station.deviceId));
      if (!device) throw new Error("Device absent");
      await db.transaction((tx) => transitionWorkingAssignment(tx, device));
      const policy = await seedGrantPolicy(
        db,
        {
          shift: {
            "shift.scan.v1": { maxEvents: 1, maxUnits: 1 },
            "shift.close.v1": { maxEvents: 0 },
            "shift.label.prepare.v1": { maxEvents: 0, maxUnits: 0 },
          },
        },
        undefined,
        {
          protocol: "offline-grants-v1",
          mode: "strict",
          deviceIds: [station.deviceId],
          decisionReference: "TEST-ONLY",
        },
      );
      const planVersionId = await createPublishedPlan(db, {
        maxLines: 3,
        maxStations: 3,
        maxKiosks: 3,
        maxCabinetUsers: 3,
        lifecyclePolicyId: policy.id,
      });
      await createManagedSubscription(db, { tenantId, planVersionId });
      const productId = randomUUID(),
        templateId = randomUUID();
      await db.insert(schema.products).values({
        id: productId,
        tenantId,
        gtin14: "04600000000015",
        name: "Reprocessing",
        status: "active",
      });
      await db.insert(schema.labelTemplates).values({
        id: templateId,
        tenantId,
        name: "Duplicate",
        purpose: "product_duplicate",
        spec: buildDuplicateLabelTemplate(),
      });
      const headers = `${PRODUCT_LABEL_PROTOCOL},validation-reprocessing-v1,station-recovery-v1`;
      async function createShift(allowPreviouslyAcceptedCodes: boolean) {
        const response = await cabinet
          .post("/shifts")
          .send({
            productId,
            mode: "validation",
            validationPrint: {
              mode: "duplicate_dm",
              verification: "required",
              templateId,
              allowPreviouslyAcceptedCodes,
            },
          })
          .expect(201);
        const id: string = response.body.id;
        await cabinet.post(`/shifts/${id}/open`).expect(200);
        return id;
      }
      const sourceId = await createShift(false);
      const item = (shiftId: string, sequence: number) => {
        const raw = `]d2010460000000001521EVIDENCE${sequence}\u001d91Key1\u001d92Crypto`;
        const km = canonicalizeKm(raw);
        return {
          shiftId,
          terminalId: station.deviceId,
          raw,
          verdict: "ok",
          scannedAt: new Date(now).toISOString(),
          code: { codeHash: kmHash(km), gtin14: km.gtin14, serial: km.serial },
          boxId: null,
          operatorId: null,
        };
      };
      const original = [item(sourceId, 1), item(sourceId, 2)];
      await request(app.getHttpServer())
        .post("/station/scans")
        .set("x-api-key", station.apiKey)
        .set("x-station-capabilities", headers)
        .send({ batchId: randomUUID(), items: original })
        .expect(201);
      await cabinet.post(`/shifts/${sourceId}/close`).send({ reason: "completed" }).expect(200);
      const targetId = await createShift(false);
      await request(app.getHttpServer())
        .post(`/shifts/${targetId}/enter`)
        .set("x-api-key", station.apiKey)
        .set("x-station-capabilities", headers)
        .expect(200);
      now = Date.now();
      let issued = grantIssueResultSchema.parse(
        (
          await request(app.getHttpServer())
            .post("/station/grants/v1/tasks")
            .set("x-api-key", station.apiKey)
            .send({ ...negotiate(), taskKind: "shift", taskId: targetId })
            .expect(200)
        ).body,
      );
      if (issued.status !== "issued") throw new Error(`Grant denied: ${issued.reason}`);
      const verified = await verifyGrant(
        issued.envelope.grants[0] ?? "",
        [{ kid: "workflow-test", origin, jwk: key.publicKey.export({ format: "jwk" }) }],
        origin,
      );
      if (!verified.ok || verified.grant.kindOfGrant !== "task")
        throw new Error("Task grant invalid");
      let grantId = verified.grant.grantId;
      await db
        .update(schema.shifts)
        .set({ allowPreviouslyAcceptedCodes: true })
        .where(and(eq(schema.shifts.tenantId, tenantId), eq(schema.shifts.id, targetId)));
      const wrap = (sequence: number) => {
        if (issued.status !== "issued") throw new Error("Task grant unavailable");
        const winner = item(targetId, sequence);
        const items = competing
          ? [{ ...winner, scannedAt: new Date(now + 1).toISOString() }, winner]
          : [winner];
        const payload = { batchId: randomUUID(), items };
        return {
          protocol: "offline-grants-v1",
          batchId: randomUUID(),
          payloadDigest: productLabelValueDigest(payload),
          grants: issued.envelope.grants,
          eventGrants: Object.fromEntries(
            items.map((_item, index) => [`/items/${index}#shift.scan.v1`, grantId]),
          ),
          payload,
        };
      };
      const send = (body: object, capabilities = headers) =>
        request(app.getHttpServer())
          .post("/station/grants/v1/evidence/scans")
          .set("x-api-key", station.apiKey)
          .set("x-station-capabilities", capabilities)
          .send(body)
          .expect(200);
      const first = wrap(1);
      // Missing remote capability remains a native rejection and must not create an occurrence.
      const denied = grantEvidenceReceiptSchema.parse(
        (await send(first, "station-recovery-v1")).body,
      );
      expect(denied.reconciliation).toMatchObject({ status: "rejected", statusCode: 409 });
      expect(
        await db
          .select()
          .from(schema.validationCodeReprocessings)
          .where(eq(schema.validationCodeReprocessings.shiftId, targetId)),
      ).toHaveLength(0);
      // Native policy is now true, but the previously signed false scope cannot authorize reprocessing.
      const falseScope = grantEvidenceReceiptSchema.parse(
        (await send({ ...first, batchId: randomUUID() })).body,
      );
      expect(falseScope).toMatchObject({
        outcome: "quarantined",
        reason: "grant_snapshot_mismatch",
        reconciliation: { status: "not_applied" },
      });
      expect(
        await db
          .select()
          .from(schema.validationCodeReprocessings)
          .where(
            and(
              eq(schema.validationCodeReprocessings.tenantId, tenantId),
              eq(schema.validationCodeReprocessings.shiftId, targetId),
            ),
          ),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(schema.deviceGrantEffects)
          .where(
            and(
              eq(schema.deviceGrantEffects.tenantId, tenantId),
              eq(schema.deviceGrantEffects.taskId, targetId),
            ),
          ),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(schema.deviceGrantConsumption)
          .where(
            and(
              eq(schema.deviceGrantConsumption.tenantId, tenantId),
              eq(schema.deviceGrantConsumption.taskId, targetId),
            ),
          ),
      ).toHaveLength(0);
      const falseDigest = verified.grant.snapshotDigest;
      issued = grantIssueResultSchema.parse(
        (
          await request(app.getHttpServer())
            .post("/station/grants/v1/tasks")
            .set("x-api-key", station.apiKey)
            .send({ ...negotiate(), taskKind: "shift", taskId: targetId })
            .expect(200)
        ).body,
      );
      if (issued.status !== "issued") throw new Error(`True-scope grant denied: ${issued.reason}`);
      const current = await verifyGrant(
        issued.envelope.grants[0] ?? "",
        [{ kid: "workflow-test", origin, jwk: key.publicKey.export({ format: "jwk" }) }],
        origin,
      );
      if (!current.ok || current.grant.kindOfGrant !== "task")
        throw new Error("True-scope grant invalid");
      expect(current.grant.snapshotDigest).not.toBe(falseDigest);
      grantId = current.grant.grantId;
      const delivered = wrap(1);
      const accepted = grantEvidenceReceiptSchema.parse((await send(delivered)).body);
      expect(accepted).toMatchObject({
        outcome: "accepted",
        reason: null,
        reconciliation: {
          status: "applied",
          result: {
            validationOccurrences: expect.arrayContaining([
              expect.objectContaining({ shiftId: targetId, outcome: "reprocessed" }),
            ]),
          },
        },
      });
      if (competing) {
        expect(accepted.reconciliation.result).toMatchObject({
          validationOccurrences: expect.arrayContaining([
            expect.objectContaining({ shiftId: targetId, outcome: "conflict" }),
          ]),
          conflicts: [
            expect.objectContaining({ codeHash: delivered.payload.items[0]?.code.codeHash }),
          ],
        });
      }
      expect((await send(delivered)).body).toEqual({ ...accepted, outcome: "duplicate" });
      // New evidence outer batch must inspect the same retained native occurrence on native replay.
      expect((await send({ ...delivered, batchId: randomUUID() })).body).toMatchObject({
        outcome: "accepted",
        reason: null,
        reconciliation: { status: "applied", result: { alreadyApplied: true } },
      });
      // codes retains every coded native observation, including competing losers;
      // validationCodeReprocessings is the accepted-occurrence authority.
      const retainedCodes = await db
        .select()
        .from(schema.codes)
        .where(eq(schema.codes.shiftId, targetId));
      expect(retainedCodes).toHaveLength(competing ? 2 : 1);
      const excess = grantEvidenceReceiptSchema.parse((await send(wrap(2))).body);
      expect(excess).toMatchObject({
        outcome: "quarantined",
        reason: "budget_exceeded",
        reconciliation: { status: "not_applied" },
      });
      const repeats = await db
        .select()
        .from(schema.validationCodeReprocessings)
        .where(eq(schema.validationCodeReprocessings.shiftId, targetId));
      expect(repeats).toHaveLength(1);
      expect(repeats[0]).toMatchObject({
        tenantId,
        terminalId: station.deviceId,
        sourceShiftId: sourceId,
        codeHash: first.payload.items[0]?.code.codeHash,
      });
      expect(
        await db.select().from(schema.codes).where(eq(schema.codes.shiftId, targetId)),
      ).toEqual(retainedCodes);
      expect(
        await db
          .select()
          .from(schema.deviceGrantEffects)
          .where(
            and(
              eq(schema.deviceGrantEffects.tenantId, tenantId),
              eq(schema.deviceGrantEffects.taskId, targetId),
            ),
          ),
      ).toHaveLength(1);
      const counters = await db
        .select()
        .from(schema.deviceGrantConsumption)
        .where(
          and(
            eq(schema.deviceGrantConsumption.tenantId, tenantId),
            eq(schema.deviceGrantConsumption.taskId, targetId),
          ),
        );
      expect(counters.map((row) => [row.budgetLineId, row.consumed]).sort()).toEqual([
        ["shift.scan.v1:events", 1],
        ["shift.scan.v1:units", 1],
      ]);
      expect(
        (
          await db
            .select()
            .from(schema.codeRegistry)
            .where(
              and(
                eq(schema.codeRegistry.tenantId, tenantId),
                eq(schema.codeRegistry.codeHash, first.payload.items[0]?.code.codeHash ?? ""),
              ),
            )
        )[0]?.shiftId,
      ).toBe(sourceId);
    },
  );
});
