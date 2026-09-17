import { randomUUID, generateKeyPairSync } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { schema, type Auth } from "@markiro/db";
import { AUTH } from "../src/auth/auth.module";
import {
  inventorySnapshotContentDigest,
  canonicalizeKm,
  kmHash,
  productLabelValueDigest,
  inventoryEventBatchDigest,
} from "@markiro/domain";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { setupAuth } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { StationPairingService } from "../src/modules/station-pairing/station-pairing.service";
import { ShiftsService } from "../src/modules/shifts/shifts.service";
import {
  configureGrantSigning,
  GRANT_SIGNING_CONFIGURATION,
} from "../src/modules/device-grants/grant-keyset";
import { GrantEvidenceService } from "../src/modules/device-grants/grant-evidence.service";
import { quarantineReplacementSubmission } from "../src/modules/device-licensing/device-replacement-evidence";
import { GrantIssuerService } from "../src/modules/device-grants/grant-issuer.service";
import { replacementExecutionHarness } from "./support/device-replacement-execution-fixture";
import { createPublishedAddon } from "./support/subscription-fixtures";
import { listenOnLoopback } from "./support/listen-loopback";

const GTIN = "04600682000013";
const ready = Boolean(process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET);

describe.skipIf(!ready)("replacement productive route matrix", () => {
  // Close the app before the harness drops its isolated database.
  let app: INestApplication;
  const {
    db,
    connection,
    fixture,
    execution,
    entitlements,
    readiness,
    service: preparationService,
  } = replacementExecutionHarness();
  afterAll(async () => {
    await app?.close();
  });
  beforeAll(async () => {
    const env = { ...loadEnv(), DATABASE_URL: connection.pool.options.connectionString! };
    const setup = setupAuth(env);
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
    const module = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    })
      .overrideProvider(GRANT_SIGNING_CONFIGURATION)
      .useValue(signing)
      .overrideProvider(GrantEvidenceService)
      .useValue(new GrantEvidenceService(db, () => Date.now()))
      .overrideProvider(GrantIssuerService)
      .useValue(new GrantIssuerService(db, entitlements, signing, () => Date.now()))
      .compile();
    app = module.createNestApplication({ bodyParser: false });
    app.getHttpAdapter().getInstance().use(express.json());
    await app.init();
    await listenOnLoopback(app);
  });

  async function waitingTarget(kind: "station" | "handheld") {
    const f = await fixture(kind, 1, true, {
      shift: {
        "shift.scan.v1": { maxEvents: 100, maxUnits: 100 },
        "shift.close.v1": { maxEvents: 1 },
      },
    });
    const [subscription] = await db
      .select()
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, f.tenantId));
    if (!subscription) throw new Error("subscription missing");
    const addonVersionId = await createPublishedAddon(db, [
      { entitlementKey: "handheld" },
      { entitlementKey: "inventory" },
      { entitlementKey: "pallets" },
    ]);
    await db.insert(schema.subscriptionAddons).values({
      tenantId: f.tenantId,
      subscriptionId: subscription.id,
      addonVersionId,
      quantity: 1,
      source: "manual",
      status: "active",
      startsAt: new Date(Date.now() - 1000),
    });
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
    const code = await app.get(StationPairingService).issueCode(f.tenantId, targetId, f.actor.id);
    const paired = await request(app.getHttpServer())
      .post("/station/pair")
      .set(
        "x-station-capabilities",
        `replacement-boundary-v1${kind === "handheld" ? ",handheld-v1" : ""}`,
      )
      .send({ code: code.code })
      .expect(201);
    const credential = paired.body.credential as { apiKey: string };
    expect(paired.body.replacement.newWorkAllowedAt).toBe(Date.parse(p.newWorkAllowedAt));
    const lineId = randomUUID(),
      productId = randomUUID(),
      operatorId = randomUUID(),
      reasonId = randomUUID();
    await db.insert(schema.lines).values({ id: lineId, tenantId: f.tenantId, name: "Line" });
    await db
      .update(schema.stationDevices)
      .set({ lineId })
      .where(eq(schema.stationDevices.id, targetId));
    await db.insert(schema.products).values({
      id: productId,
      tenantId: f.tenantId,
      gtin14: GTIN,
      name: "Water",
      status: "active",
      boxCapacity: 12,
      palletBoxCapacity: 3,
    });
    await db
      .insert(schema.employees)
      .values({ id: operatorId, tenantId: f.tenantId, fullName: "Operator" });
    await db.insert(schema.operatorCredentials).values({
      tenantId: f.tenantId,
      employeeId: operatorId,
      login: "123456",
      pinHash: "fixture-hash",
    });
    await db.insert(schema.employeePickupPolicies).values({
      tenantId: f.tenantId,
      employeeId: operatorId,
      limitMode: "unlimited",
      canWriteoff: true,
    });
    await db
      .insert(schema.pickupTenantPolicies)
      .values({ tenantId: f.tenantId, limitsEnabled: false });
    await db
      .insert(schema.pickupOrderReasons)
      .values({ id: reasonId, tenantId: f.tenantId, name: "Damage" });
    const templateId = randomUUID();
    const template = { widthMm: 58, heightMm: 40, dpi: 203, language: "zpl", elements: [] };
    await db
      .insert(schema.labelTemplates)
      .values({ id: templateId, tenantId: f.tenantId, name: "Box", spec: template });
    await db.insert(schema.orgProfiles).values({
      tenantId: f.tenantId,
      gln: kind === "station" ? "4601112222005" : "4609876543008",
    });
    const shifts = app.get(ShiftsService);
    const create = (mode: "validation" | "aggregation") =>
      shifts.createShift(
        f.tenantId,
        {
          productId,
          lineId,
          mode,
          ...(mode === "aggregation" ? { boxLabelTemplateId: templateId } : {}),
        },
        { domain: "cabinet", id: f.actor.id },
      );
    const planned = await create("validation"),
      active = await create("validation"),
      aggregation = await create("aggregation");
    await shifts.openShift(f.tenantId, active.id, { domain: "cabinet", id: f.actor.id });
    await shifts.openShift(f.tenantId, aggregation.id, { domain: "cabinet", id: f.actor.id });
    // Pallet allocation is exercised through the same bundle transaction.
    await db
      .update(schema.shifts)
      .set({ palletsEnabled: true, palletBoxCapacity: 3, palletLabelTemplateId: templateId })
      .where(eq(schema.shifts.id, aggregation.id));
    const inventoryId = randomUUID(),
      inventoryNumber = `INV-${inventoryId.slice(0, 8)}`;
    await db.insert(schema.inventories).values({
      id: inventoryId,
      tenantId: f.tenantId,
      number: inventoryNumber,
      productId,
      gtin14Snapshot: GTIN,
      lineId,
      mode: "repack",
      boxLabelTemplateId: templateId,
      productionDateFrom: "2026-08-01",
      productionDateTo: "2026-08-31",
      createdByUserId: f.actor.id,
    });
    const [snapshot] = await db
      .insert(schema.inventorySnapshots)
      .values({
        tenantId: f.tenantId,
        inventoryId,
        revision: 1,
        combinedDigest: "a".repeat(64),
        productName: "Water",
        lineName: "Line",
        boxCapacity: 12,
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
        fixedByUserId: f.actor.id,
      })
      .returning();
    if (!snapshot) throw new Error("snapshot missing");
    await db
      .update(schema.inventories)
      .set({
        status: "running",
        activeSnapshotId: snapshot.id,
        startedByUserId: f.actor.id,
        startedAt: new Date(),
        stationManifest: {
          inventoryId,
          inventoryNumber,
          snapshotId: snapshot.id,
          snapshotRevision: 1,
          snapshotFixedAt: snapshot.fixedAt.toISOString(),
          combinedDigest: "a".repeat(64),
          contentDigest: inventorySnapshotContentDigest([]),
          codeCount: 0,
          productId,
          productName: "Water",
          productPrintName: null,
          egaisCode: null,
          shelfLifeDays: null,
          gtin14: GTIN,
          boxCapacity: 12,
          mode: "repack",
          lineId,
          lineName: "Line",
          productionDateFrom: "2026-08-01",
          productionDateTo: "2026-08-31",
          boxLabelTemplate: { id: templateId, name: "Box", spec: template },
          limits: { codePageSize: 200, eventBatchSize: 100, progressPageSize: 200 },
        },
      })
      .where(eq(schema.inventories.id, inventoryId));
    const post = (path: string, body: object) =>
      request(app.getHttpServer()).post(path).set("x-api-key", credential.apiKey).send(body);
    const get = (path: string) =>
      request(app.getHttpServer()).get(path).set("x-api-key", credential.apiKey);
    return {
      ...f,
      targetId,
      post,
      get,
      productId,
      planned,
      active,
      aggregation,
      inventoryId,
      operatorId,
      reasonId,
      boundary: Date.parse(p.newWorkAllowedAt),
    };
  }

  it.each(["station", "handheld"] as const)(
    "%s: fences all productive starts and allocations until the saved boundary",
    async (kind) => {
      const f = await waitingTarget(kind);
      const routes = [
        {
          name: "create validation/reprocessing scope",
          run: () => f.post("/shifts", { productId: f.productId, mode: "validation" }),
          status: 201,
        },
        {
          name: "open planned shift",
          run: () => f.post(`/shifts/${f.planned.id}/open`, {}),
          status: 200,
        },
        {
          name: "enter active shift",
          run: () => f.post(`/shifts/${f.active.id}/enter`, {}),
          status: 200,
        },
        {
          name: "allocate box and pallet ranges",
          run: () => f.get(`/shifts/${f.aggregation.id}/bundle`),
          status: 200,
        },
        {
          name: "join inventory",
          run: () =>
            f.post(`/station/inventories/${f.inventoryId}/join`, { operatorId: f.operatorId }),
          status: 200,
        },
      ];
      const writeoff = {
        deviceSeq: 1,
        operatorId: f.operatorId,
        writeoffReasonId: f.reasonId,
        items: [{ rawKm: `01${GTIN}21MATRIX123456789012${String.fromCharCode(29)}93Abcd` }],
        boxes: [],
        createdAt: new Date().toISOString(),
      };
      if (kind === "handheld")
        routes.push({
          name: "file fresh writeoff",
          run: () => f.post("/station/writeoffs", writeoff),
          status: 201,
        });
      for (const route of routes) {
        const response = await route.run();
        expect.soft(response.status, route.name).toBe(409);
        expect.soft(response.body.code, route.name).toBe("device_replacement_waiting");
      }
      const grant = () =>
        f.post("/station/grants/v1/device", {
          protocol: "offline-grants-v1",
          capability: "offline-grants-v1",
          requestId: randomUUID(),
        });
      expect((await grant().expect(200)).body).toMatchObject({
        status: "denied",
        reason: "not_entitled",
      });
      const taskGrant = () =>
        f.post("/station/grants/v1/tasks", {
          protocol: "offline-grants-v1",
          capability: "offline-grants-v1",
          requestId: randomUUID(),
          taskKind: "shift",
          taskId: f.active.id,
        });
      expect((await taskGrant().expect(200)).body).toMatchObject({
        status: "denied",
        reason: "not_entitled",
      });
      expect(
        await db.select().from(schema.ssccBlocks).where(eq(schema.ssccBlocks.deviceId, f.targetId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(schema.pickupOrders)
          .where(eq(schema.pickupOrders.stationDeviceId, f.targetId)),
      ).toHaveLength(0);
      // Reference, reconciliation and retained native data remain reachable.
      await f.get(`/shifts/${f.active.id}/reference-bundle`).expect(200);
      await f.get("/station/writeoff-bootstrap").expect(200);
      await f.post("/station/conflicts/status", { codeHashes: ["a".repeat(64)] }).expect(200);
      await f.post("/station/scans", { batchId: randomUUID(), items: [] }).expect(201);
      const configuration = await f
        .post("/station/grants/v1/configuration", {
          protocol: "offline-grants-v1",
          capability: "offline-grants-v1",
          requestId: randomUUID(),
        })
        .expect(200);
      expect(configuration.body.mode).toBe("strict");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(f.boundary + 1);
      writeoff.deviceSeq = 2;
      for (const route of routes) {
        const response = await route.run();
        expect(response.status, `${route.name}: ${JSON.stringify(response.body)}`).toBe(
          route.status,
        );
        if (route.name === "allocate box and pallet ranges") {
          expect(response.body.sscc).not.toBeNull();
          expect(response.body.palletSscc).not.toBeNull();
        }
      }
      expect((await grant().expect(200)).body.status).toBe("issued");
      expect((await taskGrant().expect(200)).body.status).toBe("issued");
      expect(
        (
          await f
            .post("/station/grants/v1/configuration", {
              protocol: "offline-grants-v1",
              capability: "offline-grants-v1",
              requestId: randomUUID(),
            })
            .expect(200)
        ).body.mode,
      ).toBe("observe");
      vi.setSystemTime(f.boundary - 1);
      expect(
        (await f.get(`/station/inventories/${f.inventoryId}/bundle/manifest`).expect(409)).body
          .code,
      ).toBe("device_replacement_waiting");
      vi.setSystemTime(f.boundary + 1);
      if (kind === "handheld") {
        const original = await f.post("/station/writeoffs", writeoff).expect(201);
        // A replay and recovery remain valid if an upstream fence is observed
        // again after a local clock correction; a fresh sequence is denied.
        vi.setSystemTime(f.boundary - 1);
        expect((await f.post("/station/writeoffs", writeoff).expect(201)).body).toEqual(
          original.body,
        );
        expect(
          (await f.post("/station/writeoffs", { ...writeoff, deviceSeq: 3 }).expect(409)).body.code,
        ).toBe("device_replacement_waiting");
      }
    },
    30_000,
  );
  it.each(["station", "handheld"] as const)(
    "%s: retains direct legacy and native submissions without business effects while waiting",
    async (kind) => {
      const f = await waitingTarget(kind);
      const occurredAt = new Date().toISOString();
      const raw = `01${GTIN}21FORGED123456789012${String.fromCharCode(29)}93Abcd`;
      const km = canonicalizeKm(raw),
        codeHash = kmHash(km);
      const item = {
        shiftId: f.active.id,
        terminalId: null,
        raw,
        verdict: "ok",
        scannedAt: occurredAt,
        code: { codeHash, gtin14: km.gtin14, serial: km.serial },
        boxId: null,
        operatorId: f.operatorId,
      };
      const label = {
        eventId: randomUUID(),
        jobId: randomUUID(),
        attemptId: randomUUID(),
        sequence: 1,
        shiftId: f.active.id,
        codeHash,
        acceptedAt: occurredAt,
        policyRevision: randomUUID(),
        templateDigest: "b".repeat(64),
        payloadDigest: "c".repeat(64),
        operatorId: f.operatorId,
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
              shiftId: f.aggregation.id,
              terminalId: null,
              sscc: "046011122200000019",
              closedAt: occurredAt,
              operatorId: f.operatorId,
            },
          ],
        },
        {
          batchId: randomUUID(),
          items: [],
          pallets: [
            {
              palletId: randomUUID(),
              shiftId: f.aggregation.id,
              terminalId: null,
              sscc: "146011122200000016",
              closedAt: occurredAt,
              operatorId: f.operatorId,
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
            operatorId: f.operatorId,
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
        shiftId: f.active.id,
        operatorId: f.operatorId,
        plannedQtySnapshot: null,
        actualQty: 0,
        closedBoxCount: 0,
        closedAt: occurredAt,
      };
      const legacy = [
        ...scans.map((payload) => ({ path: "/station/scans", payload })),
        { path: `/station/inventories/${f.inventoryId}/event-batches`, payload: inventory },
        { path: "/station/shift-closures", payload: close },
        ...(kind === "handheld"
          ? [
              {
                path: "/station/writeoffs",
                payload: {
                  deviceSeq: 7,
                  operatorId: f.operatorId,
                  writeoffReasonId: f.reasonId,
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
          code: "device_replacement_waiting",
          outcome: "quarantined",
          receiptId: expect.any(String),
        });
        legacyReceipts.push({ route, body: response.body });
      }
      const native = [
        ...scans.map((payload) => ({ path: "/station/grants/v1/evidence/scans", payload })),
        {
          path: `/station/grants/v1/evidence/inventories/${f.inventoryId}/event-batches`,
          payload: inventory,
        },
        { path: "/station/grants/v1/evidence/shift-closures", payload: close },
        {
          path: `/station/grants/v1/evidence/inventories/${f.inventoryId}/leave`,
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
          reason: "device_replacement_waiting",
          reconciliation: { status: "not_applied" },
        });
        const replay = await f.post(route.path, envelope);
        expect.soft(replay.body).toMatchObject({ ...response.body, outcome: "duplicate" });
      }
      expect(
        await db
          .select()
          .from(schema.scanEvents)
          .where(eq(schema.scanEvents.terminalId, f.targetId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(schema.productLabelJobs)
          .where(eq(schema.productLabelJobs.deviceId, f.targetId)),
      ).toHaveLength(0);
      expect(
        await db.select().from(schema.boxes).where(eq(schema.boxes.terminalId, f.targetId)),
      ).toHaveLength(0);
      expect(
        await db.select().from(schema.pallets).where(eq(schema.pallets.terminalId, f.targetId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(schema.inventoryScanEvents)
          .where(eq(schema.inventoryScanEvents.deviceId, f.targetId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(schema.pickupOrders)
          .where(eq(schema.pickupOrders.stationDeviceId, f.targetId)),
      ).toHaveLength(0);
      const retained = await db
        .select()
        .from(schema.deviceGrantEvidence)
        .where(eq(schema.deviceGrantEvidence.stationDeviceId, f.targetId));
      expect(retained).toHaveLength(legacy.length);
      for (const row of retained) {
        expect(row).toMatchObject({
          tenantId: f.tenantId,
          ownerKind: kind,
          disposition: "quarantined",
          reason: "device_replacement_waiting",
        });
        expect(row.payload.receipt).toMatchObject({
          receiptId: row.id,
          code: "device_replacement_waiting",
        });
        const [audit] = await db
          .select()
          .from(schema.tenantAuditEvents)
          .where(eq(schema.tenantAuditEvents.targetId, row.id));
        expect(audit).toMatchObject({
          organizationId: f.tenantId,
          actorUserId: null,
          action: "device.replacement.evidence_quarantined",
          outcome: "failure",
          targetType: "device_grant_evidence",
          after: {
            tenantId: f.tenantId,
            deviceId: f.targetId,
            credentialEpoch: row.credentialEpoch,
            payloadDigest: row.payloadDigest,
            reason: row.reason,
          },
        });
      }
      const nativeRetained = await db
        .select()
        .from(schema.deviceGrantIngestReceipts)
        .where(eq(schema.deviceGrantIngestReceipts.stationDeviceId, f.targetId));
      expect(nativeRetained).toHaveLength(native.length);
      expect(
        nativeRetained.every(
          (row) =>
            row.mode === "observe" && row.finalResponse?.reason === "device_replacement_waiting",
        ),
      ).toBe(true);
      const changed = await f
        .post("/station/scans", { ...scans[0], items: [{ ...item, operatorId: randomUUID() }] })
        .expect(409);
      expect(changed.body.code).toBe("device_replacement_evidence_conflict");
      await expect(
        quarantineReplacementSubmission(db, f.tenantId, f.targetId, "scans", randomUUID(), {
          data: "a".repeat(1_100_000),
        }),
      ).rejects.toMatchObject({ status: 413 });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(f.boundary + 1);
      for (const { route, body } of legacyReceipts)
        expect((await f.post(route.path, route.payload).expect(409)).body).toEqual(body);
      const fresh = await f
        .post("/station/scans", { batchId: randomUUID(), items: [item] })
        .expect(201);
      expect(fresh.body.applied).toBe(1);
      const payload = { batchId: randomUUID(), items: [item] };
      const admitted = await f
        .post("/station/grants/v1/evidence/scans", {
          protocol: "offline-grants-v1",
          batchId: randomUUID(),
          payloadDigest: productLabelValueDigest(payload),
          payload,
          grants: [],
          eventGrants: {},
        })
        .expect(200);
      expect(admitted.body).toMatchObject({
        outcome: "accepted",
        reconciliation: { status: "applied" },
      });
    },
    30_000,
  );
  it("keeps a draining source's legacy and native recovery ingestion available", async () => {
    const f = await fixture("station", 1, true);
    const key = await app.get<Auth>(AUTH).api.createApiKey({
      body: {
        configId: "station",
        organizationId: f.tenantId,
        userId: f.actor.id,
        name: "Recovery fixture",
        metadata: { kind: "station" },
      },
    });
    await db
      .update(schema.stationDevices)
      .set({ apiKeyId: key.id })
      .where(eq(schema.stationDevices.id, f.device.id));
    const productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId: f.tenantId,
      gtin14: GTIN,
      name: "Water",
      status: "active",
    });
    const shifts = app.get(ShiftsService);
    const shift = await shifts.createShift(
      f.tenantId,
      { productId, mode: "validation" },
      { domain: "cabinet", id: f.actor.id },
    );
    await shifts.openShift(f.tenantId, shift.id, { domain: "cabinet", id: f.actor.id });
    await readiness.requestDrain(
      f.tenantId,
      f.prepared.preparation.id,
      { requestId: randomUUID(), expectedRevision: 1 },
      f.actor,
    );
    const raw = `01${GTIN}21RECOVER12345678901${String.fromCharCode(29)}93Abcd`,
      km = canonicalizeKm(raw);
    const payload = {
      batchId: randomUUID(),
      items: [
        {
          shiftId: shift.id,
          terminalId: null,
          raw,
          verdict: "ok",
          scannedAt: new Date().toISOString(),
          code: { codeHash: kmHash(km), gtin14: km.gtin14, serial: km.serial },
          boxId: null,
          operatorId: null,
        },
      ],
    };
    const post = (path: string, body: object) =>
      request(app.getHttpServer()).post(path).set("x-api-key", key.key).send(body);
    expect((await post("/station/scans", payload).expect(201)).body.applied).toBe(1);
    const nativePayload = { ...payload, batchId: randomUUID() };
    const envelope = {
      protocol: "offline-grants-v1",
      batchId: randomUUID(),
      payloadDigest: productLabelValueDigest(nativePayload),
      payload: nativePayload,
      grants: [],
      eventGrants: {},
    };
    expect(
      (await post("/station/grants/v1/evidence/scans", envelope).expect(200)).body,
    ).toMatchObject({ outcome: "accepted", reconciliation: { status: "applied" } });
    expect(
      await db
        .select()
        .from(schema.deviceGrantEvidence)
        .where(eq(schema.deviceGrantEvidence.stationDeviceId, f.device.id)),
    ).toHaveLength(0);
  });

  it("replays the durable legacy quarantine receipt after its commit response is lost", async () => {
    const f = await waitingTarget("handheld");
    const body = {
      deviceSeq: 11,
      operatorId: f.operatorId,
      writeoffReasonId: f.reasonId,
      items: [{ rawKm: `01${GTIN}21AMBIGUOUS123456789${String.fromCharCode(29)}93Abcd` }],
      boxes: [],
      createdAt: new Date().toISOString(),
    };
    // The HTTP service uses setupAuth's pool; inject the lost response at the
    // common retention owner directly, then retry through the real HTTP route.
    const original = db.transaction.bind(db);
    const failure = vi.spyOn(db, "transaction").mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("quarantine commit response lost");
    });
    // Same normalized input that StationWriteoffsService passes to the owner.
    const persistedBody = { ...body, reason: "writeoff" };
    await expect(
      quarantineReplacementSubmission(db, f.tenantId, f.targetId, "writeoffs", "11", persistedBody),
    ).rejects.toThrow("quarantine commit response lost");
    failure.mockRestore();
    const [saved] = await db
      .select()
      .from(schema.deviceGrantEvidence)
      .where(eq(schema.deviceGrantEvidence.stationDeviceId, f.targetId));
    expect(saved).toBeDefined();
    const response = await f.post("/station/writeoffs", body).expect(409);
    expect(response.body).toEqual(saved?.payload.receipt);
    expect((await f.post("/station/writeoffs", body).expect(409)).body).toEqual(response.body);
    expect(
      await db
        .select()
        .from(schema.pickupOrders)
        .where(eq(schema.pickupOrders.stationDeviceId, f.targetId)),
    ).toHaveLength(0);
  });
  it("pins native quarantine at receipt commit even when the response is lost until after the boundary", async () => {
    const f = await waitingTarget("station");
    const payload = { batchId: randomUUID(), items: [] };
    const envelope = {
      protocol: "offline-grants-v1",
      batchId: randomUUID(),
      payloadDigest: productLabelValueDigest(payload),
      payload,
      grants: [],
      eventGrants: {},
    };
    const original = db.transaction.bind(db);
    const lost = vi.spyOn(db, "transaction").mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("native quarantine commit response lost");
    });
    await f.post("/station/grants/v1/evidence/scans", envelope).expect(500);
    lost.mockRestore();
    const [saved] = await db
      .select()
      .from(schema.deviceGrantIngestReceipts)
      .where(eq(schema.deviceGrantIngestReceipts.stationDeviceId, f.targetId));
    expect(saved?.finalResponse).toMatchObject({
      outcome: "quarantined",
      reason: "device_replacement_waiting",
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(f.boundary + 1);
    const replay = await f.post("/station/grants/v1/evidence/scans", envelope).expect(200);
    expect(replay.body).toMatchObject({
      ...saved?.finalResponse,
      outcome: "duplicate",
      reason: "device_replacement_waiting",
    });
  });
  it("retains an unproven first-delivery v1 write-off from a draining source and replays committed sequences", async () => {
    const f = await waitingTarget("handheld");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(f.boundary + 1);
    const body = {
      deviceSeq: 21,
      operatorId: f.operatorId,
      writeoffReasonId: f.reasonId,
      items: [{ rawKm: `01${GTIN}21PRE-DRAIN123456789${String.fromCharCode(29)}93Abcd` }],
      boxes: [],
      createdAt: new Date().toISOString(),
    };
    const committed = await f.post("/station/writeoffs", body).expect(201);
    const p = await preparationService.preview(
      f.tenantId,
      f.targetId,
      {
        requestId: randomUUID(),
        target: { name: "Another target", kind: "handheld" },
        reason: "Drain source",
      },
      f.actor,
    );
    const prepared = await preparationService.confirm(
      f.tenantId,
      f.targetId,
      { requestId: p.requestId, previewId: p.id },
      f.actor,
    );
    await readiness.requestDrain(
      f.tenantId,
      prepared.preparation.id,
      { requestId: randomUUID(), expectedRevision: 1 },
      f.actor,
    );
    expect((await f.post("/station/writeoffs", body).expect(201)).body).toEqual(committed.body);
    const unproven = {
      ...body,
      deviceSeq: 22,
      createdAt: new Date(f.boundary - 60_000).toISOString(),
      items: [{ rawKm: `01${GTIN}21UNPROVEN1234567890${String.fromCharCode(29)}93Abcd` }],
    };
    const held = await f.post("/station/writeoffs", unproven).expect(409);
    expect(held.body).toMatchObject({
      code: "device_replacement_draining",
      reason: "unproven_pre_drain_scope",
      outcome: "quarantined",
      receiptId: expect.any(String),
    });
    expect((await f.post("/station/writeoffs", unproven).expect(409)).body).toEqual(held.body);
    const rows = await db
      .select()
      .from(schema.deviceGrantEvidence)
      .where(eq(schema.deviceGrantEvidence.stationDeviceId, f.targetId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: held.body.receiptId,
      tenantId: f.tenantId,
      stationDeviceId: f.targetId,
      ownerKind: "handheld",
      disposition: "quarantined",
      reason: "unproven_pre_drain_scope",
      payload: {
        preparationId: prepared.preparation.id,
        receipt: held.body,
        request: { deviceSeq: 22, createdAt: unproven.createdAt },
      },
    });
    const [audit] = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.targetId, held.body.receiptId));
    expect(audit).toMatchObject({
      organizationId: f.tenantId,
      actorUserId: null,
      action: "device.replacement.evidence_quarantined",
      outcome: "failure",
      targetType: "device_grant_evidence",
      targetId: held.body.receiptId,
    });
    expect(audit?.after).toEqual({
      tenantId: f.tenantId,
      deviceId: f.targetId,
      credentialEpoch: rows[0]?.credentialEpoch,
      preparationId: prepared.preparation.id,
      operation: "writeoffs",
      submissionId: "22",
      payloadDigest: rows[0]?.payloadDigest,
      reason: "unproven_pre_drain_scope",
    });
    expect(
      await db
        .select()
        .from(schema.pickupOrders)
        .where(eq(schema.pickupOrders.stationDeviceId, f.targetId)),
    ).toHaveLength(1);
  });
  it("retains a v1 write-off when drain wins after its initial admission read", async () => {
    const f = await waitingTarget("handheld");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(f.boundary + 1);
    const p = await preparationService.preview(
      f.tenantId,
      f.targetId,
      {
        requestId: randomUUID(),
        target: { name: "Racing target", kind: "handheld" },
        reason: "Drain source",
      },
      f.actor,
    );
    const prepared = await preparationService.confirm(
      f.tenantId,
      f.targetId,
      { requestId: p.requestId, previewId: p.id },
      f.actor,
    );
    const body = {
      deviceSeq: 31,
      operatorId: f.operatorId,
      writeoffReasonId: f.reasonId,
      items: [{ rawKm: `01${GTIN}21DRAIN-RACE12345678${String.fromCharCode(29)}93Abcd` }],
      boxes: [],
      createdAt: new Date().toISOString(),
    };
    // Pause the real HTTP request at its transaction lock, after the initial
    // quarantine preflight has released its device lock but before insertion.
    const holder = await connection.pool.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `box-registry:${f.tenantId}`,
    ]);
    const pending = f.post("/station/writeoffs", body).then((response) => response);
    try {
      let blocked = false;
      for (let i = 0; i < 200 && !blocked; i++) {
        const result = await connection.pool.query(
          `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
        );
        blocked = result.rowCount === 1;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      await readiness.requestDrain(
        f.tenantId,
        prepared.preparation.id,
        { requestId: randomUUID(), expectedRevision: 1 },
        f.actor,
      );
    } finally {
      await holder.query("COMMIT");
      holder.release();
    }
    const response = await pending;
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: "device_replacement_draining",
      reason: "unproven_pre_drain_scope",
      outcome: "quarantined",
      receiptId: expect.any(String),
    });
    expect((await f.post("/station/writeoffs", body).expect(409)).body).toEqual(response.body);
    expect(
      await db
        .select()
        .from(schema.pickupOrders)
        .where(eq(schema.pickupOrders.stationDeviceId, f.targetId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.deviceGrantEvidence)
        .where(eq(schema.deviceGrantEvidence.stationDeviceId, f.targetId)),
    ).toHaveLength(1);
  });
  it("retains a waiting target write-off before validating its untrusted operator", async () => {
    const f = await waitingTarget("handheld");
    const body = {
      deviceSeq: 41,
      operatorId: randomUUID(),
      writeoffReasonId: f.reasonId,
      items: [{ rawKm: `01${GTIN}21FORGED-OP123456789${String.fromCharCode(29)}93Abcd` }],
      boxes: [],
      createdAt: new Date().toISOString(),
    };
    const held = await f.post("/station/writeoffs", body).expect(409);
    expect(held.body).toMatchObject({
      code: "device_replacement_waiting",
      outcome: "quarantined",
      receiptId: expect.any(String),
    });
    expect((await f.post("/station/writeoffs", body).expect(409)).body).toEqual(held.body);
    const [row] = await db
      .select()
      .from(schema.deviceGrantEvidence)
      .where(eq(schema.deviceGrantEvidence.stationDeviceId, f.targetId));
    expect(row?.payload.request).toMatchObject({ operatorId: body.operatorId });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(f.boundary + 1);
    await f.post("/station/writeoffs", { ...body, deviceSeq: 42 }).expect(403);
    expect(
      await db
        .select()
        .from(schema.pickupOrders)
        .where(eq(schema.pickupOrders.stationDeviceId, f.targetId)),
    ).toHaveLength(0);
  });
});
