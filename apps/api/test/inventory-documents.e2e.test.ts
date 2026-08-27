import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { and, eq } from "drizzle-orm";
import express from "express";
import { strFromU8, unzipSync } from "fflate";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { schema, type Db } from "@markiro/db";
import {
  buildSscc,
  canonicalizeKm,
  INVENTORY_CHZ_STATUSES,
  inventoryEventBatchDigest,
  kmHash,
  type InventoryChzStatus,
  type InventoryEvent,
  type InventoryEventBatchPayload,
} from "@markiro/domain";

import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { PgBossService } from "../src/jobs/jobs.module";

import {
  createInventoryDocumentRunSchema,
  inventoryDocumentRunResponseSchema,
  retryInventoryDocumentRunSchema,
} from "../src/modules/inventories/dto";
import {
  INVENTORY_DOCUMENT_GENERATOR_REGISTRY,
  InventoryDocumentGeneratorRegistry,
  InventoryDocumentRunnerService,
  productionInventoryDocumentGeneratorRegistry,
  type InventoryDocumentGenerator,
} from "../src/modules/inventories/inventory-document-runner.service";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import { listenOnLoopback } from "./support/listen-loopback";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";
import { createTestStationDevice, signUpAndActivate } from "./support/auth";

describe("inventory document request contracts", () => {
  it("requires one unique id/version pair and rejects unknown properties", () => {
    const valid = {
      selectedFormats: [{ id: "synthetic_stock", version: 1 }],
      idempotencyKey: "10000000-0000-4000-8000-000000000001",
    };
    expect(createInventoryDocumentRunSchema.parse(valid)).toEqual(valid);
    expect(() =>
      createInventoryDocumentRunSchema.parse({ ...valid, selectedFormats: [] }),
    ).toThrow();
    expect(() =>
      createInventoryDocumentRunSchema.parse({
        ...valid,
        selectedFormats: [valid.selectedFormats[0], valid.selectedFormats[0]],
      }),
    ).toThrow();
    expect(() => createInventoryDocumentRunSchema.parse({ ...valid, extra: true })).toThrow();
    expect(retryInventoryDocumentRunSchema.parse({})).toEqual({});
    expect(() => retryInventoryDocumentRunSchema.parse({ force: true })).toThrow();
  });

  it("strictly validates revision, publication, download, and invalidation evidence", () => {
    const response = {
      id: "20000000-0000-4000-8000-000000000001",
      inventoryId: "30000000-0000-4000-8000-000000000001",
      resultRevision: 7,
      selectedFormats: [{ id: "synthetic_stock", version: 1 }],
      status: "ready",
      errorCode: null,
      sourceSnapshotStartedAt: "2026-08-26T10:00:00.000Z",
      sourceSnapshotCompletedAt: "2026-08-26T10:00:01.000Z",
      completedAt: "2026-08-26T10:00:02.000Z",
      attemptCount: 1,
      createdAt: "2026-08-26T09:59:59.000Z",
      artifacts: [
        {
          id: "40000000-0000-4000-8000-000000000001",
          formatId: "synthetic_stock",
          formatVersion: 1,
          partNumber: 1,
          filename: "stock.csv",
          mimeType: "text/csv; charset=utf-8",
          rowCount: 1,
          codeCount: 1,
          boxCount: 0,
          byteSize: 25,
          sha256: "a0a8633b6b3779fd3c4d3210ef91daffaffe45313549ff82903217622ba61ee1",
          downloadedAt: null,
          invalidatedAt: null,
        },
      ],
    };
    expect(inventoryDocumentRunResponseSchema.parse(response)).toEqual(response);
    expect(() =>
      inventoryDocumentRunResponseSchema.parse({
        ...response,
        artifacts: [{ ...response.artifacts[0], objectKey: "tenants/private" }],
      }),
    ).toThrow();
  });
});

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);
const GTIN = "04600000000015";
const CHZ_SOURCE = readFileSync(join(__dirname, "fixtures/inventory/chz-introduced.csv"), "utf8");
const [INTRODUCED_FILTER = "", CHZ_HEADER = ""] = CHZ_SOURCE.split(/\r?\n/);
if (INTRODUCED_FILTER.length === 0 || CHZ_HEADER.length === 0) {
  throw new Error("Expected inventory CSV fixture header");
}
const syntheticDescriptor = {
  id: "synthetic_stock",
  version: 1,
  label: "Synthetic stock",
  extension: "csv",
  mimeType: "text/csv; charset=utf-8",
  requiredSourceCategories: ["verified"] as const,
  supportsParts: false,
  availability: "available" as const,
};
const syntheticBoxesDescriptor = {
  ...syntheticDescriptor,
  id: "synthetic_boxes",
  label: "Synthetic boxes",
  requiredSourceCategories: ["newBoxes"] as const,
};

const syntheticGenerators: readonly InventoryDocumentGenerator[] = [
  {
    descriptor: syntheticDescriptor,
    generate: async () => [
      {
        partNumber: 1,
        filename: "stock.csv",
        mimeType: syntheticDescriptor.mimeType,
        bytes: new TextEncoder().encode("code\r\nA\r\n"),
        rowCount: 1,
        codeCount: 1,
        boxCount: 0,
      },
    ],
  },
  {
    descriptor: syntheticBoxesDescriptor,
    generate: async () => [
      {
        partNumber: 1,
        filename: "boxes.csv",
        mimeType: syntheticBoxesDescriptor.mimeType,
        bytes: new TextEncoder().encode("box\r\n"),
        rowCount: 0,
        codeCount: 0,
        boxCount: 0,
      },
    ],
  },
];

interface ChzSourceRow {
  serial: string;
  state?: string;
  productionDate?: string;
  parentSscc?: string;
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function chzFilterLine(status: InventoryChzStatus): string {
  return INTRODUCED_FILTER.replace("INTRODUCED", status).replaceAll("04680089900383", GTIN);
}

function chzSourceRow(status: InventoryChzStatus, row: ChzSourceRow): string {
  const cells = Array.from({ length: 35 }, () => "");
  cells[0] = `01${GTIN}21${row.serial}`;
  cells[1] = GTIN;
  cells[5] = row.parentSscc ?? "";
  cells[15] = status;
  cells[16] = row.state ?? "";
  cells[19] = "UNIT";
  cells[27] = row.productionDate ?? "";
  return cells.map(csvCell).join(",");
}

function chzExport(status: InventoryChzStatus, rows: readonly ChzSourceRow[] = []): Buffer {
  const lines = [chzFilterLine(status), CHZ_HEADER];
  if (rows.length === 0) lines.push("errors", "5: Коды маркировки не найдены");
  else lines.push(...rows.map((row) => chzSourceRow(status, row)));
  return Buffer.from(`${lines.join("\n")}\n`);
}

describe.skipIf(!ready)("inventory document endpoints", () => {
  let app: INestApplication | undefined;
  let db: Db;
  let document: OpenAPIObject;
  let runner: InventoryDocumentRunnerService;
  let registry = new InventoryDocumentGeneratorRegistry(syntheticGenerators);
  const enqueue = vi.fn(async () => "job-1");
  const objects = new Map<string, Buffer>();
  const storage = {
    ensureBucket: vi.fn().mockResolvedValue(undefined),
    putVerified: vi.fn(async (key: string, body: Buffer, _mime: string, sha256: string) => {
      expect(createHash("sha256").update(body).digest("hex")).toBe(sha256);
      objects.set(key, Buffer.from(body));
      return { byteSize: body.byteLength, sha256 };
    }),
    get: vi.fn(async (key: string) => {
      const body = objects.get(key);
      if (!body) throw Object.assign(new Error("missing test object"), { name: "NoSuchKey" });
      return { body: Buffer.from(body), contentType: null };
    }),
    delete: vi.fn(async (key: string) => {
      objects.delete(key);
    }),
    presignRead: vi.fn(async (key: string) => `https://storage.test/${encodeURIComponent(key)}`),
  };

  beforeAll(async () => {
    const env = loadEnv({ ...process.env, ...PLATFORM_TEST_ENV });
    const setup: AuthSetup = setupAuth(env);
    db = setup.db;
    const registryProvider = {
      listAvailable: () => registry.listAvailable(),
      resolve: (id: string, version: number) => registry.resolve(id, version),
    } as InventoryDocumentGeneratorRegistry;
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    })
      .overrideProvider(PgBossService)
      .useValue({ enqueueInventoryDocumentRun: enqueue })
      .overrideProvider(INVENTORY_DOCUMENT_GENERATOR_REGISTRY)
      .useValue(registryProvider)
      .overrideProvider(ObjectStorageService)
      .useValue(storage)
      .compile();
    app = ref.createNestApplication({ bodyParser: false });
    app.useLogger(false);
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    runner = app.get(InventoryDocumentRunnerService);
    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("inventory documents").setVersion("test").build(),
    );
    await listenOnLoopback(app);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  async function seedInventory(
    status: "draft" | "closed" = "closed",
    mode: "check" | "repack" = "check",
  ) {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    await db
      .update(schema.organization)
      .set({ name: "ООО Документы" })
      .where(eq(schema.organization.id, tenantId));
    await db
      .insert(schema.orgProfiles)
      .values({ tenantId, inn: "9705119097" })
      .onConflictDoUpdate({ target: schema.orgProfiles.tenantId, set: { inn: "9705119097" } });
    const [member] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId))
      .limit(1);
    if (!member) throw new Error("Expected inventory document actor");
    const productId = randomUUID();
    const lineId = randomUUID();
    const inventoryId = randomUUID();
    const snapshotId = randomUUID();
    const boxLabelTemplateId = mode === "repack" ? randomUUID() : null;
    const inventoryNumber = `INV-${randomUUID()}`;
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: GTIN,
      name: "Document product",
    });
    await db.insert(schema.lines).values({ id: lineId, tenantId, name: "Document line" });
    if (boxLabelTemplateId !== null) {
      await db.insert(schema.labelTemplates).values({
        id: boxLabelTemplateId,
        tenantId,
        name: "Document box label",
        spec: {},
      });
    }
    await db.insert(schema.inventories).values({
      id: inventoryId,
      tenantId,
      number: inventoryNumber,
      productId,
      gtin14Snapshot: GTIN,
      lineId,
      mode,
      productionDateFrom: "2026-08-01",
      productionDateTo: "2026-08-31",
      boxLabelTemplateId,
      createdByUserId: member.userId,
    });
    if (status === "closed") {
      await db.insert(schema.inventorySnapshots).values({
        id: snapshotId,
        tenantId,
        inventoryId,
        combinedDigest: "a".repeat(64),
        productName: "Document product",
        lineName: "Document line",
        boxCapacity: mode === "repack" ? 20 : null,
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
        fixedByUserId: member.userId,
      });
      await db
        .update(schema.inventories)
        .set({
          status: "closed",
          activeSnapshotId: snapshotId,
          stationManifest: { snapshotRevision: 1 },
          resultRevision: 7,
          startedByUserId: member.userId,
          startedAt: new Date("2026-08-26T08:00:00.000Z"),
          closedByUserId: member.userId,
          closedAt: new Date("2026-08-26T09:00:00.000Z"),
        })
        .where(
          and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
        );
    }
    return {
      agent,
      tenantId,
      userId: member.userId,
      inventoryId,
      inventoryNumber,
      snapshotId,
      lineId,
    };
  }

  const createBody = (idempotencyKey = randomUUID()) => ({
    selectedFormats: [{ id: syntheticDescriptor.id, version: 1 }],
    idempotencyKey,
  });

  const productionBody = (idempotencyKey = randomUUID()) => ({
    selectedFormats: [
      { id: "inventory_xml_gismt_aggregation", version: 1 },
      { id: "inventory_xml_gismt_disaggregation", version: 1 },
    ],
    idempotencyKey,
  });

  async function uploadProductionImports(
    agent: ReturnType<typeof request.agent>,
    inventoryId: string,
    rows: Partial<Record<InventoryChzStatus, readonly ChzSourceRow[]>>,
  ): Promise<Record<InventoryChzStatus, string>> {
    const entries: Array<readonly [InventoryChzStatus, string]> = [];
    for (const status of INVENTORY_CHZ_STATUSES) {
      const response = await agent
        .post(`/inventories/${inventoryId}/imports/${status}`)
        .attach("file", chzExport(status, rows[status]), {
          filename: `${status.toLowerCase()}.csv`,
          contentType: "text/csv",
        })
        .expect(201);
      expect(response.body).toMatchObject({
        declaredStatus: status,
        parsedStatus: status,
      });
      entries.push([status, response.body.id as string]);
    }
    return Object.fromEntries(entries) as Record<InventoryChzStatus, string>;
  }

  async function runProductionJourneyToFirstClose() {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const [member] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId));
    if (!member) throw new Error("Expected production acceptance actor");
    await db
      .update(schema.organization)
      .set({ name: "ООО Непрерывная приёмка" })
      .where(eq(schema.organization.id, tenantId));
    await db.insert(schema.orgProfiles).values({
      tenantId,
      inn: "9705119097",
      gln: "4600000090007",
    });

    const productId = randomUUID();
    const lineId = randomUUID();
    const templateId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: GTIN,
      name: "Production acceptance water",
      boxCapacity: 2,
      status: "active",
    });
    await db.insert(schema.lines).values({ id: lineId, tenantId, name: "Acceptance line" });
    await db.insert(schema.labelTemplates).values({
      id: templateId,
      tenantId,
      name: "Acceptance box label",
      spec: {
        widthMm: 58,
        heightMm: 40,
        dpi: 203,
        language: "zpl",
        elements: [
          {
            id: "sscc",
            kind: "barcode",
            xMm: 4,
            yMm: 12,
            format: "code128",
            data: "sscc",
            sizeMm: 18,
          },
        ],
      },
    });

    const created = await agent
      .post("/inventories")
      .send({
        productId,
        lineId,
        mode: "repack",
        productionDateFrom: "2026-08-01",
        productionDateTo: "2026-08-31",
        boxLabelTemplateId: templateId,
      })
      .expect(201);
    const inventoryId = created.body.id as string;
    expect(created.body).toMatchObject({ id: inventoryId, status: "draft", mode: "repack" });

    const protectedSharedOldSscc = buildSscc(0, "460000009", 9001);
    const cleanOldSscc = buildSscc(0, "460000009", 9002);
    const sharedEligibleCanonical = canonicalizeKm(`01${GTIN}21ELIGIBLE-SHARED-PARENT`);
    const cleanEligibleCanonical = canonicalizeKm(`01${GTIN}21ELIGIBLE-CLEAN-PARENT`);
    const protectedCanonical = canonicalizeKm(`01${GTIN}21PROTECTED-CONTINUOUS`);
    const imports = await uploadProductionImports(agent, inventoryId, {
      INTRODUCED: [
        {
          serial: sharedEligibleCanonical.serial,
          productionDate: "2026-08-08",
          parentSscc: protectedSharedOldSscc,
        },
        {
          serial: protectedCanonical.serial,
          state: "MOVING_BY_UD",
          parentSscc: protectedSharedOldSscc,
        },
        {
          serial: cleanEligibleCanonical.serial,
          productionDate: "2026-08-09",
          parentSscc: cleanOldSscc,
        },
        { serial: "EXPECTED-LOOSE", productionDate: "2026-08-09" },
      ],
    });
    const snapshot = await agent
      .post(`/inventories/${inventoryId}/snapshots`)
      .send({ imports })
      .expect(201);
    expect(snapshot.body).toMatchObject({
      inventoryId,
      revision: 1,
      inputs: imports,
      counts: {
        emitted: 0,
        introduced: 4,
        applied: 0,
        retired: 0,
        writtenOff: 0,
        disaggregation: 0,
        protected: 1,
        expected: 3,
        packages: 2,
        loose: 1,
      },
    });
    const snapshotId = snapshot.body.id as string;
    const [frozenSnapshot] = await db
      .select({
        introduced: schema.inventorySnapshots.introducedCount,
        protected: schema.inventorySnapshots.protectedCount,
        expected: schema.inventorySnapshots.expectedCount,
        packages: schema.inventorySnapshots.packageCount,
        loose: schema.inventorySnapshots.looseCount,
      })
      .from(schema.inventorySnapshots)
      .where(eq(schema.inventorySnapshots.id, snapshotId));
    expect(frozenSnapshot).toEqual({
      introduced: 4,
      protected: 1,
      expected: 3,
      packages: 2,
      loose: 1,
    });
    expect(
      await db
        .select({ status: schema.inventorySnapshotInputs.status })
        .from(schema.inventorySnapshotInputs)
        .where(eq(schema.inventorySnapshotInputs.snapshotId, snapshotId)),
    ).toHaveLength(6);
    const [protectedSnapshotCode] = await db
      .select({
        sourceState: schema.inventorySnapshotCodes.sourceState,
        parentSscc: schema.inventorySnapshotCodes.parentSscc,
        expected: schema.inventorySnapshotCodes.expected,
        protected: schema.inventorySnapshotCodes.protected,
      })
      .from(schema.inventorySnapshotCodes)
      .where(
        and(
          eq(schema.inventorySnapshotCodes.tenantId, tenantId),
          eq(schema.inventorySnapshotCodes.snapshotId, snapshotId),
          eq(schema.inventorySnapshotCodes.codeHash, kmHash(protectedCanonical)),
        ),
      );
    expect(protectedSnapshotCode).toEqual({
      sourceState: "MOVING_BY_UD",
      parentSscc: protectedSharedOldSscc,
      expected: false,
      protected: true,
    });

    const started = await agent.post(`/inventories/${inventoryId}/start`).expect(201);
    expect(started.body).toMatchObject({
      inventoryId,
      snapshotId,
      snapshotRevision: 1,
      codeCount: 4,
      boxCapacity: 2,
      mode: "repack",
    });

    const operator = await agent
      .post("/employees")
      .send({ fullName: "Continuous acceptance operator" })
      .expect(201);
    const operatorId = operator.body.id as string;
    await agent
      .put(`/operators/${operatorId}`)
      .send({ login: String(Date.now()).slice(-6), pin: "1234" })
      .expect(200);
    const deviceA = await createTestStationDevice(app!, agent, "Acceptance station A");
    const deviceB = await createTestStationDevice(app!, agent, "Acceptance station B");
    await db
      .update(schema.stationDevices)
      .set({ lineId })
      .where(eq(schema.stationDevices.id, deviceA.deviceId));
    await db
      .update(schema.stationDevices)
      .set({ lineId })
      .where(eq(schema.stationDevices.id, deviceB.deviceId));

    const joinDevice = (device: { apiKey: string }) =>
      request(app!.getHttpServer())
        .post(`/station/inventories/${inventoryId}/join`)
        .set("x-api-key", device.apiKey)
        .send({ operatorId })
        .expect(200);
    const joinedA = await joinDevice(deviceA);
    const joinedB = await joinDevice(deviceB);
    expect(deviceA.deviceId).not.toBe(deviceB.deviceId);
    expect(joinedA.body).toMatchObject({ inventoryId, snapshotId, mode: "repack" });
    expect(joinedB.body).toMatchObject({ inventoryId, snapshotId, mode: "repack" });
    const ssccBlock = joinedA.body.sscc as {
      issuerPrefix: string;
      extensionDigit: number;
      fromSerial: number;
    } | null;
    if (!ssccBlock) throw new Error("Expected a repack SSCC block for station A");
    const protectedSharedNewSscc = buildSscc(
      ssccBlock.extensionDigit,
      ssccBlock.issuerPrefix,
      ssccBlock.fromSerial,
    );
    const cleanNewSscc = buildSscc(
      ssccBlock.extensionDigit,
      ssccBlock.issuerPrefix,
      ssccBlock.fromSerial + 1,
    );
    const protectedSharedBoxId = randomUUID();
    const cleanBoxId = randomUUID();

    const sendBatch = async (
      device: { apiKey: string },
      events: InventoryEvent[],
      openBoxCount: number,
    ) => {
      const lastEvent = events.at(-1);
      if (!lastEvent) throw new Error("Expected at least one event in an acceptance batch");
      const payload: InventoryEventBatchPayload = {
        snapshotId,
        snapshotRevision: 1,
        sequenceCeiling: lastEvent.deviceSequence,
        pendingEventCount: 0,
        openBoxCount,
        events,
      };
      return request(app!.getHttpServer())
        .post(`/station/inventories/${inventoryId}/event-batches`)
        .set("x-api-key", device.apiKey)
        .send({
          batchId: `acceptance-${randomUUID()}`,
          payloadDigest: inventoryEventBatchDigest(payload),
          ...payload,
        })
        .expect(200);
    };

    const protectedEvent: InventoryEvent = {
      eventId: randomUUID(),
      deviceSequence: 1,
      operatorId,
      scannedAt: "2026-08-26T08:00:00.000Z",
      kind: "item",
      normalizedIdentity: `item:${kmHash(protectedCanonical)}`,
      codeHash: kmHash(protectedCanonical),
      canonicalRaw: protectedCanonical.raw,
      activeProductionDate: "2026-08-08",
      localVerdict: "protected",
    };
    const protectedScan = await sendBatch(deviceB, [protectedEvent], 0);
    expect(protectedScan.body.outcomes).toEqual([
      expect.objectContaining({ eventId: protectedEvent.eventId, status: "applied" }),
    ]);

    const openProtectedSharedBox: InventoryEvent = {
      eventId: randomUUID(),
      deviceSequence: 1,
      operatorId,
      scannedAt: "2026-08-26T08:01:00.000Z",
      kind: "old_box",
      normalizedIdentity: `old_box:${protectedSharedOldSscc}`,
      codeHash: null,
      canonicalRaw: protectedSharedOldSscc,
      activeProductionDate: "2026-08-08",
      localVerdict: "expected",
      repack: {
        action: "open-box",
        boxId: protectedSharedBoxId,
        oldSscc: protectedSharedOldSscc,
        newSscc: protectedSharedNewSscc,
        capacity: 2,
        productionDate: "2026-08-08",
      },
    };
    await sendBatch(deviceA, [openProtectedSharedBox], 1);
    const addProtectedSharedEligibleItem: InventoryEvent = {
      eventId: randomUUID(),
      deviceSequence: 2,
      operatorId,
      scannedAt: "2026-08-26T08:02:00.000Z",
      kind: "item",
      normalizedIdentity: `item:${kmHash(sharedEligibleCanonical)}`,
      codeHash: kmHash(sharedEligibleCanonical),
      canonicalRaw: sharedEligibleCanonical.raw,
      activeProductionDate: "2026-08-08",
      localVerdict: "expected",
      repack: {
        action: "add-item",
        boxId: protectedSharedBoxId,
        itemId: randomUUID(),
        position: 1,
        closeBox: false,
      },
    };
    await sendBatch(deviceA, [addProtectedSharedEligibleItem], 1);

    const duplicateProtected: InventoryEvent = {
      ...protectedEvent,
      eventId: randomUUID(),
      deviceSequence: 3,
      scannedAt: "2026-08-26T08:03:00.000Z",
    };
    const conflict = await sendBatch(deviceA, [duplicateProtected], 1);
    expect(conflict.body.outcomes).toEqual([
      expect.objectContaining({
        eventId: duplicateProtected.eventId,
        status: "duplicate",
        conflictCount: 1,
      }),
    ]);
    const [conflictedResult] = await db
      .select({
        id: schema.inventoryCodeResults.id,
        classification: schema.inventoryCodeResults.classification,
        observedProductionDate: schema.inventoryCodeResults.observedProductionDate,
        firstAcceptedEventId: schema.inventoryCodeResults.firstAcceptedEventId,
        winningDeviceId: schema.inventoryCodeResults.winningDeviceId,
        updatedAt: schema.inventoryCodeResults.updatedAt,
      })
      .from(schema.inventoryCodeResults)
      .where(
        and(
          eq(schema.inventoryCodeResults.tenantId, tenantId),
          eq(schema.inventoryCodeResults.inventoryId, inventoryId),
          eq(schema.inventoryCodeResults.codeHash, kmHash(protectedCanonical)),
        ),
      );
    expect(conflictedResult).toMatchObject({
      classification: "protected",
      observedProductionDate: "2026-08-08",
      firstAcceptedEventId: protectedEvent.eventId,
      winningDeviceId: deviceB.deviceId,
    });
    if (!conflictedResult) throw new Error("Expected duplicate-conflict code result");

    const closedAt = "2026-08-26T08:04:00.000Z";
    const closeProtectedSharedBox: InventoryEvent = {
      eventId: randomUUID(),
      deviceSequence: 4,
      operatorId,
      scannedAt: closedAt,
      kind: "repack_action",
      normalizedIdentity: `repack_action:close-incomplete:${protectedSharedBoxId}`,
      codeHash: null,
      canonicalRaw: null,
      activeProductionDate: "2026-08-08",
      localVerdict: "repack-action",
      repack: { action: "close-incomplete", boxId: protectedSharedBoxId, changedAt: closedAt },
    };
    await sendBatch(deviceA, [closeProtectedSharedBox], 0);
    const printedAt = "2026-08-26T08:05:00.000Z";
    const printProtectedSharedBox: InventoryEvent = {
      eventId: randomUUID(),
      deviceSequence: 5,
      operatorId,
      scannedAt: printedAt,
      kind: "repack_action",
      normalizedIdentity: `repack_action:print-outcome:${protectedSharedBoxId}:1`,
      codeHash: null,
      canonicalRaw: null,
      activeProductionDate: "2026-08-08",
      localVerdict: "repack-action",
      repack: {
        action: "print-outcome",
        boxId: protectedSharedBoxId,
        sscc: protectedSharedNewSscc,
        attemptId: randomUUID(),
        attemptNumber: 1,
        result: "printed",
        errorCode: null,
        attemptedAt: "2026-08-26T08:04:30.000Z",
        completedAt: printedAt,
      },
    };
    await sendBatch(deviceA, [printProtectedSharedBox], 0);

    const openCleanBox: InventoryEvent = {
      eventId: randomUUID(),
      deviceSequence: 6,
      operatorId,
      scannedAt: "2026-08-26T08:06:00.000Z",
      kind: "old_box",
      normalizedIdentity: `old_box:${cleanOldSscc}`,
      codeHash: null,
      canonicalRaw: cleanOldSscc,
      activeProductionDate: "2026-08-09",
      localVerdict: "expected",
      repack: {
        action: "open-box",
        boxId: cleanBoxId,
        oldSscc: cleanOldSscc,
        newSscc: cleanNewSscc,
        capacity: 2,
        productionDate: "2026-08-09",
      },
    };
    await sendBatch(deviceA, [openCleanBox], 1);
    const addCleanEligibleItem: InventoryEvent = {
      eventId: randomUUID(),
      deviceSequence: 7,
      operatorId,
      scannedAt: "2026-08-26T08:07:00.000Z",
      kind: "item",
      normalizedIdentity: `item:${kmHash(cleanEligibleCanonical)}`,
      codeHash: kmHash(cleanEligibleCanonical),
      canonicalRaw: cleanEligibleCanonical.raw,
      activeProductionDate: "2026-08-09",
      localVerdict: "expected",
      repack: {
        action: "add-item",
        boxId: cleanBoxId,
        itemId: randomUUID(),
        position: 1,
        closeBox: false,
      },
    };
    await sendBatch(deviceA, [addCleanEligibleItem], 1);
    const cleanClosedAt = "2026-08-26T08:08:00.000Z";
    const closeCleanBox: InventoryEvent = {
      eventId: randomUUID(),
      deviceSequence: 8,
      operatorId,
      scannedAt: cleanClosedAt,
      kind: "repack_action",
      normalizedIdentity: `repack_action:close-incomplete:${cleanBoxId}`,
      codeHash: null,
      canonicalRaw: null,
      activeProductionDate: "2026-08-09",
      localVerdict: "repack-action",
      repack: { action: "close-incomplete", boxId: cleanBoxId, changedAt: cleanClosedAt },
    };
    await sendBatch(deviceA, [closeCleanBox], 0);
    const cleanPrintedAt = "2026-08-26T08:09:00.000Z";
    const printCleanBox: InventoryEvent = {
      eventId: randomUUID(),
      deviceSequence: 9,
      operatorId,
      scannedAt: cleanPrintedAt,
      kind: "repack_action",
      normalizedIdentity: `repack_action:print-outcome:${cleanBoxId}:1`,
      codeHash: null,
      canonicalRaw: null,
      activeProductionDate: "2026-08-09",
      localVerdict: "repack-action",
      repack: {
        action: "print-outcome",
        boxId: cleanBoxId,
        sscc: cleanNewSscc,
        attemptId: randomUUID(),
        attemptNumber: 1,
        result: "printed",
        errorCode: null,
        attemptedAt: "2026-08-26T08:08:30.000Z",
        completedAt: cleanPrintedAt,
      },
    };
    const cleanPrinted = await sendBatch(deviceA, [printCleanBox], 0);

    const projectionDigest = (classification: "protected" | "voided", updatedAt: string) =>
      createHash("sha256")
        .update(
          JSON.stringify({
            kind: "code_result",
            id: conflictedResult.id,
            classification,
            observedProductionDate: "2026-08-08",
            updatedAt,
          }),
          "utf8",
        )
        .digest("hex");
    const initialProjectionDigest = projectionDigest(
      "protected",
      conflictedResult.updatedAt.toISOString(),
    );
    const voidCorrection = await agent
      .post(`/inventories/${inventoryId}/corrections`)
      .send({
        action: "void_scan",
        target: { eventId: protectedEvent.eventId },
        reason: "Void accepted scan implicated in cross-device duplicate",
        expectedResultRevision: cleanPrinted.body.resultRevision,
        idempotencyKey: randomUUID(),
      })
      .expect(201);
    const voidedProjectionDigest = projectionDigest(
      "voided",
      voidCorrection.body.createdAt as string,
    );
    expect(voidCorrection.body).toMatchObject({
      action: "void_scan",
      target: {
        eventId: protectedEvent.eventId,
        codeResultId: conflictedResult.id,
        repackBoxId: null,
      },
      beforeProjectionDigest: initialProjectionDigest,
      afterProjectionDigest: voidedProjectionDigest,
      resultRevision: 4,
    });
    const [voidedResult] = await db
      .select({
        classification: schema.inventoryCodeResults.classification,
        updatedAt: schema.inventoryCodeResults.updatedAt,
      })
      .from(schema.inventoryCodeResults)
      .where(eq(schema.inventoryCodeResults.id, conflictedResult.id));
    expect(voidedResult).toEqual({
      classification: "voided",
      updatedAt: new Date(voidCorrection.body.createdAt as string),
    });

    const restoreCorrection = await agent
      .post(`/inventories/${inventoryId}/corrections`)
      .send({
        action: "restore_scan",
        target: { eventId: protectedEvent.eventId },
        reason: "Restore protected source after duplicate review",
        expectedResultRevision: voidCorrection.body.resultRevision,
        idempotencyKey: randomUUID(),
      })
      .expect(201);
    const restoredProjectionDigest = projectionDigest(
      "protected",
      restoreCorrection.body.createdAt as string,
    );
    expect(restoreCorrection.body).toMatchObject({
      action: "restore_scan",
      target: {
        eventId: protectedEvent.eventId,
        codeResultId: conflictedResult.id,
        repackBoxId: null,
      },
      beforeProjectionDigest: voidedProjectionDigest,
      afterProjectionDigest: restoredProjectionDigest,
      resultRevision: 5,
    });
    const [restoredResult] = await db
      .select({
        classification: schema.inventoryCodeResults.classification,
        updatedAt: schema.inventoryCodeResults.updatedAt,
      })
      .from(schema.inventoryCodeResults)
      .where(eq(schema.inventoryCodeResults.id, conflictedResult.id));
    expect(restoredResult).toEqual({
      classification: "protected",
      updatedAt: new Date(restoreCorrection.body.createdAt as string),
    });

    const correctionAudits = await db
      .select({
        actorUserId: schema.inventoryCorrections.actorUserId,
        action: schema.inventoryCorrections.action,
        targetEventId: schema.inventoryCorrections.targetEventId,
        targetCodeResultId: schema.inventoryCorrections.targetCodeResultId,
        targetRepackBoxId: schema.inventoryCorrections.targetRepackBoxId,
        beforeProjectionDigest: schema.inventoryCorrections.beforeProjectionDigest,
        afterProjectionDigest: schema.inventoryCorrections.afterProjectionDigest,
        resultRevision: schema.inventoryCorrections.resultRevision,
      })
      .from(schema.inventoryCorrections)
      .where(
        and(
          eq(schema.inventoryCorrections.tenantId, tenantId),
          eq(schema.inventoryCorrections.inventoryId, inventoryId),
        ),
      );
    expect(
      correctionAudits.sort((left, right) => left.resultRevision - right.resultRevision),
    ).toEqual([
      {
        actorUserId: member.userId,
        action: "void_scan",
        targetEventId: protectedEvent.eventId,
        targetCodeResultId: conflictedResult.id,
        targetRepackBoxId: null,
        beforeProjectionDigest: initialProjectionDigest,
        afterProjectionDigest: voidedProjectionDigest,
        resultRevision: 4,
      },
      {
        actorUserId: member.userId,
        action: "restore_scan",
        targetEventId: protectedEvent.eventId,
        targetCodeResultId: conflictedResult.id,
        targetRepackBoxId: null,
        beforeProjectionDigest: voidedProjectionDigest,
        afterProjectionDigest: restoredProjectionDigest,
        resultRevision: 5,
      },
    ]);
    const correctionProgress = await db
      .select({
        resultRevision: schema.inventoryProgressChanges.resultRevision,
        kind: schema.inventoryProgressChanges.kind,
        codeHash: schema.inventoryProgressChanges.codeHash,
        classification: schema.inventoryProgressChanges.classification,
        winningEventId: schema.inventoryProgressChanges.winningEventId,
        winningDeviceId: schema.inventoryProgressChanges.winningDeviceId,
        changedAt: schema.inventoryProgressChanges.changedAt,
      })
      .from(schema.inventoryProgressChanges)
      .where(
        and(
          eq(schema.inventoryProgressChanges.tenantId, tenantId),
          eq(schema.inventoryProgressChanges.inventoryId, inventoryId),
          eq(schema.inventoryProgressChanges.kind, "correction"),
        ),
      );
    expect(
      correctionProgress.sort((left, right) => left.resultRevision - right.resultRevision),
    ).toEqual([
      {
        resultRevision: 4,
        kind: "correction",
        codeHash: kmHash(protectedCanonical),
        classification: "voided",
        winningEventId: protectedEvent.eventId,
        winningDeviceId: deviceB.deviceId,
        changedAt: new Date(voidCorrection.body.createdAt as string),
      },
      {
        resultRevision: 5,
        kind: "correction",
        codeHash: kmHash(protectedCanonical),
        classification: "protected",
        winningEventId: protectedEvent.eventId,
        winningDeviceId: deviceB.deviceId,
        changedAt: new Date(restoreCorrection.body.createdAt as string),
      },
    ]);

    const leaveDevice = (device: { apiKey: string }) =>
      request(app!.getHttpServer())
        .post(`/station/inventories/${inventoryId}/leave`)
        .set("x-api-key", device.apiKey)
        .send({ pendingEventCount: 0, openBoxCount: 0 })
        .expect(200, { outcome: "left" });
    await leaveDevice(deviceA);
    await leaveDevice(deviceB);
    const closed = await agent.post(`/inventories/${inventoryId}/close`).send({}).expect(201);
    expect(closed.body).toMatchObject({
      inventoryId,
      status: "closed",
      resultRevision: restoreCorrection.body.resultRevision,
      blockers: [],
    });

    return {
      agent,
      tenantId,
      userId: member.userId,
      inventoryId,
      snapshotId,
      resultRevision: closed.body.resultRevision as number,
      sharedEligibleCanonical,
      cleanEligibleCanonical,
      protectedCanonical,
      protectedSharedOldSscc,
      cleanOldSscc,
      protectedSharedNewSscc,
      cleanNewSscc,
    };
  }

  async function verifyProductionRun(
    owner: Awaited<ReturnType<typeof runProductionJourneyToFirstClose>>,
    runId: string,
    resultRevision: number,
  ) {
    await runner.run(runId, { retryCount: 0, retryLimit: 0 });
    const history = await owner.agent
      .get(`/inventories/${owner.inventoryId}/document-runs`)
      .expect(200);
    const run = history.body.items.find((item: { id: string }) => item.id === runId) as
      | {
          id: string;
          resultRevision: number;
          status: string;
          artifacts: Array<{
            id: string;
            formatId: string;
            formatVersion: number;
            filename: string;
            mimeType: string;
            rowCount: number;
            codeCount: number;
            boxCount: number;
            byteSize: number;
            sha256: string;
          }>;
        }
      | undefined;
    if (!run) throw new Error(`Expected production revision ${resultRevision} run`);
    const artifacts = [...run.artifacts].sort((left, right) =>
      left.formatId.localeCompare(right.formatId),
    );
    expect(run).toMatchObject({ resultRevision, status: "ready" });
    expect(artifacts).toMatchObject([
      {
        formatId: "inventory_xml_gismt_aggregation",
        formatVersion: 1,
        mimeType: "application/xml; charset=utf-8",
        codeCount: 2,
        boxCount: 2,
      },
      {
        formatId: "inventory_xml_gismt_disaggregation",
        formatVersion: 1,
        mimeType: "application/xml; charset=utf-8",
        codeCount: 0,
        boxCount: 1,
      },
    ]);
    const storedArtifacts = await db
      .select({
        id: schema.inventoryDocumentArtifacts.id,
        formatId: schema.inventoryDocumentArtifacts.formatId,
        objectKey: schema.inventoryDocumentArtifacts.objectKey,
        sha256: schema.inventoryDocumentArtifacts.sha256,
      })
      .from(schema.inventoryDocumentArtifacts)
      .where(eq(schema.inventoryDocumentArtifacts.runId, runId));
    expect(storedArtifacts).toHaveLength(2);

    const verifyXml = (formatId: string, body: Buffer, sha256: string) => {
      expect(createHash("sha256").update(body).digest("hex")).toBe(sha256);
      const xml = body.toString("utf8");
      expect(xml).not.toContain(owner.protectedCanonical.serial);
      if (formatId === "inventory_xml_gismt_aggregation") {
        expect(xml).toContain(owner.sharedEligibleCanonical.serial);
        expect(xml).toContain(owner.cleanEligibleCanonical.serial);
        expect(xml).toContain(`00${owner.protectedSharedNewSscc}`);
        expect(xml).toContain(`00${owner.cleanNewSscc}`);
      } else {
        expect(xml).not.toContain(owner.protectedSharedOldSscc);
        expect(xml).toContain(owner.cleanOldSscc);
        expect(xml).not.toContain(owner.protectedSharedNewSscc);
        expect(xml).not.toContain(owner.cleanNewSscc);
      }
    };

    for (const artifact of storedArtifacts) {
      const body = objects.get(artifact.objectKey);
      if (!body) throw new Error(`Expected stored production artifact ${artifact.formatId}`);
      verifyXml(artifact.formatId, body, artifact.sha256);
      const individual = await owner.agent
        .get(`/inventory-document-runs/${runId}/artifacts/${artifact.id}/download`)
        .expect(200);
      expect(individual.body).toMatchObject({
        url: `https://storage.test/${encodeURIComponent(artifact.objectKey)}`,
        expiresInSeconds: 300,
      });
    }

    await owner.agent.get(`/inventory-document-runs/${runId}/download`).expect(200);
    const zipKey = `tenants/${owner.tenantId}/inventory-documents/${runId}/revision-${resultRevision}/package.zip`;
    const zip = objects.get(zipKey);
    if (!zip) throw new Error(`Expected production revision ${resultRevision} ZIP`);
    const archive = unzipSync(zip);
    const manifestEntry = archive["manifest.json"];
    if (!manifestEntry) throw new Error("Expected manifest.json in production ZIP");
    const manifest = JSON.parse(strFromU8(manifestEntry)) as {
      schemaVersion: number;
      runId: string;
      resultRevision: number;
      artifacts: Array<{
        name: string;
        bytes: number;
        sha256: string;
        formatId: string;
        formatVersion: number;
      }>;
    };
    expect(manifest).toMatchObject({ schemaVersion: 1, runId, resultRevision });
    expect(
      [...manifest.artifacts].sort((left, right) => left.formatId.localeCompare(right.formatId)),
    ).toEqual(
      artifacts.map((artifact) => ({
        name: artifact.filename,
        mimeType: artifact.mimeType,
        partNumber: 1,
        rowCount: artifact.rowCount,
        codeCount: artifact.codeCount,
        boxCount: artifact.boxCount,
        bytes: artifact.byteSize,
        sha256: artifact.sha256,
        formatId: artifact.formatId,
        formatVersion: 1,
      })),
    );
    for (const artifact of artifacts) {
      const archived = archive[artifact.filename];
      if (!archived) throw new Error(`Expected archived production artifact ${artifact.filename}`);
      verifyXml(artifact.formatId, Buffer.from(archived), artifact.sha256);
    }
    return { run, storedArtifacts };
  }

  async function seedReadySingleArtifact(
    owner: Awaited<ReturnType<typeof seedInventory>>,
    filename: string,
  ) {
    const created = await owner.agent
      .post(`/inventories/${owner.inventoryId}/document-runs`)
      .send(createBody())
      .expect(201);
    const objectKey = `tenants/${owner.tenantId}/inventory-documents/manual/${filename}`;
    const body = Buffer.from("code\r\nA\r\n");
    objects.set(objectKey, body);
    await db
      .update(schema.inventoryDocumentRuns)
      .set({ status: "ready", completedAt: new Date(), sourceSnapshotStartedAt: new Date() })
      .where(eq(schema.inventoryDocumentRuns.id, created.body.id));
    const [artifact] = await db
      .insert(schema.inventoryDocumentArtifacts)
      .values({
        tenantId: owner.tenantId,
        runId: created.body.id,
        formatId: syntheticDescriptor.id,
        formatVersion: 1,
        partNumber: 1,
        filename,
        mimeType: syntheticDescriptor.mimeType,
        rowCount: 1,
        codeCount: 1,
        boxCount: 0,
        byteSize: body.byteLength,
        sha256: createHash("sha256").update(body).digest("hex"),
        objectKey,
      })
      .returning({ id: schema.inventoryDocumentArtifacts.id });
    if (!artifact) throw new Error("Expected artifact");
    return { runId: created.body.id as string, artifactId: artifact.id };
  }

  it("publishes strict create/list/retry/individual/ZIP OpenAPI operations", () => {
    expect(document.paths["/inventories/{id}/document-runs"]?.post).toBeDefined();
    expect(document.paths["/inventories/{id}/document-runs"]?.get).toBeDefined();
    expect(document.paths["/inventory-document-runs/{runId}/retry"]?.post).toBeDefined();
    expect(
      document.paths["/inventory-document-runs/{runId}/artifacts/{artifactId}/download"]?.get,
    ).toBeDefined();
    expect(document.paths["/inventory-document-runs/{runId}/download"]?.get).toBeDefined();
    const requestBody = document.paths["/inventories/{id}/document-runs"]?.post?.requestBody;
    if (!requestBody || "$ref" in requestBody) throw new Error("Missing create request body");
    const requestSchema = requestBody.content["application/json"]?.schema;
    expect(requestSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["selectedFormats", "idempotencyKey"],
    });
  });

  it("creates only from a closed revision and replays an exact idempotent request", async () => {
    const draft = await seedInventory("draft");
    await draft.agent
      .post(`/inventories/${draft.inventoryId}/document-runs`)
      .send(createBody())
      .expect(409, { code: "INVENTORY_DOCUMENT_RUN_REQUIRES_CLOSED" });

    const closed = await seedInventory();
    const key = randomUUID();
    const first = await closed.agent
      .post(`/inventories/${closed.inventoryId}/document-runs`)
      .send(createBody(key))
      .expect(201);
    const replay = await closed.agent
      .post(`/inventories/${closed.inventoryId}/document-runs`)
      .send(createBody(key))
      .expect(201);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.resultRevision).toBe(7);
    expect(enqueue).toHaveBeenCalledWith(first.body.id);
    const [stored] = await db
      .select({
        organizationNameSnapshot: schema.inventoryDocumentRuns.organizationNameSnapshot,
        organizationInnSnapshot: schema.inventoryDocumentRuns.organizationInnSnapshot,
        inventoryNumberSnapshot: schema.inventoryDocumentRuns.inventoryNumberSnapshot,
        inventoryClosedAtSnapshot: schema.inventoryDocumentRuns.inventoryClosedAtSnapshot,
      })
      .from(schema.inventoryDocumentRuns)
      .where(eq(schema.inventoryDocumentRuns.id, first.body.id));
    expect(stored).toEqual({
      organizationNameSnapshot: "ООО Документы",
      organizationInnSnapshot: "9705119097",
      inventoryNumberSnapshot: closed.inventoryNumber,
      inventoryClosedAtSnapshot: new Date("2026-08-26T09:00:00.000Z"),
    });

    await closed.agent
      .post(`/inventories/${closed.inventoryId}/document-runs`)
      .send({
        ...createBody(key),
        selectedFormats: [{ id: syntheticBoxesDescriptor.id, version: 1 }],
      })
      .expect(409, { code: "INVENTORY_DOCUMENT_IDEMPOTENCY_CONFLICT" });

    await closed.agent
      .post(`/inventories/${closed.inventoryId}/document-runs`)
      .send({ ...createBody(), selectedFormats: [{ id: syntheticDescriptor.id, version: 2 }] })
      .expect(400, { code: "INVENTORY_DOCUMENT_FORMAT_SUPERSEDED" });
  });

  it("replays persisted idempotency independently of catalog changes but rejects a stale revision", async () => {
    const owner = await seedInventory();
    const key = randomUUID();
    const first = await owner.agent
      .post(`/inventories/${owner.inventoryId}/document-runs`)
      .send(createBody(key))
      .expect(201);

    try {
      await db
        .update(schema.inventoryDocumentRuns)
        .set({ status: "failed", errorCode: "QUEUE_FAILED", completedAt: new Date() })
        .where(eq(schema.inventoryDocumentRuns.id, first.body.id));
      registry = new InventoryDocumentGeneratorRegistry([]);
      const removedCatalogReplay = await owner.agent
        .post(`/inventories/${owner.inventoryId}/document-runs`)
        .send(createBody(key))
        .expect(201);
      expect(removedCatalogReplay.body.id).toBe(first.body.id);
      expect(removedCatalogReplay.body.status).toBe("queued");

      registry = new InventoryDocumentGeneratorRegistry([
        {
          ...syntheticGenerators[0]!,
          descriptor: { ...syntheticDescriptor, version: 2 },
        },
      ]);
      const changedVersionReplay = await owner.agent
        .post(`/inventories/${owner.inventoryId}/document-runs`)
        .send(createBody(key))
        .expect(201);
      expect(changedVersionReplay.body.id).toBe(first.body.id);
      await owner.agent
        .post(`/inventories/${owner.inventoryId}/document-runs`)
        .send(createBody())
        .expect(400, { code: "INVENTORY_DOCUMENT_FORMAT_SUPERSEDED" });

      await owner.agent.post(`/inventories/${owner.inventoryId}/reopen`).send({}).expect(201);
      await owner.agent.post(`/inventories/${owner.inventoryId}/close`).send({}).expect(201);
      await owner.agent
        .post(`/inventories/${owner.inventoryId}/document-runs`)
        .send(createBody(key))
        .expect(409, { code: "INVENTORY_DOCUMENT_RUN_STALE_REVISION" });
    } finally {
      registry = new InventoryDocumentGeneratorRegistry(syntheticGenerators);
    }
  });

  it("lists only tenant-owned runs and denies cross-tenant artifact downloads", async () => {
    const owner = await seedInventory();
    const created = await owner.agent
      .post(`/inventories/${owner.inventoryId}/document-runs`)
      .send(createBody())
      .expect(201);
    const artifactId = randomUUID();
    const objectKey = `tenants/${owner.tenantId}/inventory-documents/manual/stock.csv`;
    const body = Buffer.from("code\r\nA\r\n");
    objects.set(objectKey, body);
    await db
      .update(schema.inventoryDocumentRuns)
      .set({ status: "ready", completedAt: new Date(), sourceSnapshotStartedAt: new Date() })
      .where(eq(schema.inventoryDocumentRuns.id, created.body.id));
    await db.insert(schema.inventoryDocumentArtifacts).values({
      id: artifactId,
      tenantId: owner.tenantId,
      runId: created.body.id,
      formatId: syntheticDescriptor.id,
      formatVersion: 1,
      partNumber: 1,
      filename: "stock.csv",
      mimeType: syntheticDescriptor.mimeType,
      rowCount: 1,
      codeCount: 1,
      boxCount: 0,
      byteSize: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
      objectKey,
    });

    const history = await owner.agent
      .get(`/inventories/${owner.inventoryId}/document-runs`)
      .expect(200);
    expect(history.body.items).toHaveLength(1);
    expect(history.body.items[0].artifacts[0]).not.toHaveProperty("objectKey");

    const other = await seedInventory();
    await other.agent
      .get(`/inventory-document-runs/${created.body.id}/artifacts/${artifactId}/download`)
      .expect(404);
    await owner.agent
      .get(`/inventory-document-runs/${created.body.id}/artifacts/${artifactId}/download`)
      .expect(200);
  });

  it("retries only a safe failed current-revision run", async () => {
    const owner = await seedInventory();
    const created = await owner.agent
      .post(`/inventories/${owner.inventoryId}/document-runs`)
      .send(createBody())
      .expect(201);
    await db
      .update(schema.inventoryDocumentRuns)
      .set({ status: "failed", errorCode: "STORAGE_FAILED", completedAt: new Date() })
      .where(eq(schema.inventoryDocumentRuns.id, created.body.id));

    const retried = await owner.agent
      .post(`/inventory-document-runs/${created.body.id}/retry`)
      .send({})
      .expect(201);
    expect(retried.body.status).toBe("queued");

    await db
      .update(schema.inventoryDocumentRuns)
      .set({ status: "failed", errorCode: "STALE_RESULT_REVISION", completedAt: new Date() })
      .where(eq(schema.inventoryDocumentRuns.id, created.body.id));
    await owner.agent
      .post(`/inventory-document-runs/${created.body.id}/retry`)
      .send({})
      .expect(409, { code: "INVENTORY_DOCUMENT_RUN_NOT_RETRYABLE" });
  });

  it("downloads a deterministic verified ZIP and reopen invalidates its source artifacts", async () => {
    const owner = await seedInventory();
    const created = await owner.agent
      .post(`/inventories/${owner.inventoryId}/document-runs`)
      .send(createBody())
      .expect(201);
    const artifactId = randomUUID();
    const objectKey = `tenants/${owner.tenantId}/inventory-documents/manual/stock.csv`;
    const body = Buffer.from("code\r\nA\r\n");
    objects.set(objectKey, body);
    await db
      .update(schema.inventoryDocumentRuns)
      .set({ status: "ready", completedAt: new Date(), sourceSnapshotStartedAt: new Date() })
      .where(eq(schema.inventoryDocumentRuns.id, created.body.id));
    await db.insert(schema.inventoryDocumentArtifacts).values({
      id: artifactId,
      tenantId: owner.tenantId,
      runId: created.body.id,
      formatId: syntheticDescriptor.id,
      formatVersion: 1,
      partNumber: 1,
      filename: "stock.csv",
      mimeType: syntheticDescriptor.mimeType,
      rowCount: 1,
      codeCount: 1,
      boxCount: 0,
      byteSize: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
      objectKey,
    });

    await owner.agent.get(`/inventory-document-runs/${created.body.id}/download`).expect(200);
    const zipCalls = storage.putVerified.mock.calls.filter(
      ([, , mime]) => mime === "application/zip",
    );
    expect(zipCalls).toHaveLength(1);
    expect(zipCalls[0]![1]).toBeInstanceOf(Buffer);

    const reopened = await owner.agent
      .post(`/inventories/${owner.inventoryId}/reopen`)
      .send({})
      .expect(201);
    expect(reopened.body.invalidatedArtifactCount).toBe(1);
    const [invalidated] = await db
      .select({ invalidatedAt: schema.inventoryDocumentArtifacts.invalidatedAt })
      .from(schema.inventoryDocumentArtifacts)
      .where(eq(schema.inventoryDocumentArtifacts.id, artifactId));
    expect(invalidated?.invalidatedAt).toBeInstanceOf(Date);
    await owner.agent
      .get(`/inventory-document-runs/${created.body.id}/artifacts/${artifactId}/download`)
      .expect(404);
  });

  it("regenerates and completes revision 8 after reopening invalidates revision 7", async () => {
    const owner = await seedInventory();
    const firstKey = randomUUID();
    const first = await owner.agent
      .post(`/inventories/${owner.inventoryId}/document-runs`)
      .send(createBody(firstKey))
      .expect(201);
    expect(first.body.resultRevision).toBe(7);

    await runner.run(first.body.id as string, { retryCount: 0, retryLimit: 0 });
    const firstHistory = await owner.agent
      .get(`/inventories/${owner.inventoryId}/document-runs`)
      .expect(200);
    const firstRun = firstHistory.body.items.find(
      (run: { id: string }) => run.id === first.body.id,
    ) as { status: string; artifacts: Array<{ id: string; sha256: string }> } | undefined;
    if (!firstRun) throw new Error("Expected revision 7 document run");
    expect(firstRun).toMatchObject({
      status: "ready",
      artifacts: [{ id: expect.any(String), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }],
    });
    const firstArtifactId = firstRun.artifacts[0]!.id;
    await owner.agent
      .get(`/inventory-document-runs/${first.body.id}/artifacts/${firstArtifactId}/download`)
      .expect(200);
    await owner.agent.get(`/inventory-document-runs/${first.body.id}/download`).expect(200);

    const reopened = await owner.agent
      .post(`/inventories/${owner.inventoryId}/reopen`)
      .send({})
      .expect(201);
    expect(reopened.body).toMatchObject({
      inventoryId: owner.inventoryId,
      status: "running",
      resultRevision: 8,
      invalidatedArtifactCount: 1,
    });
    await owner.agent
      .get(`/inventory-document-runs/${first.body.id}/artifacts/${firstArtifactId}/download`)
      .expect(404);
    const [invalidated] = await db
      .select({ invalidatedAt: schema.inventoryDocumentArtifacts.invalidatedAt })
      .from(schema.inventoryDocumentArtifacts)
      .where(eq(schema.inventoryDocumentArtifacts.id, firstArtifactId));
    expect(invalidated?.invalidatedAt).toBeInstanceOf(Date);

    const closedAgain = await owner.agent
      .post(`/inventories/${owner.inventoryId}/close`)
      .send({})
      .expect(201);
    expect(closedAgain.body).toMatchObject({
      inventoryId: owner.inventoryId,
      status: "closed",
      resultRevision: 8,
    });

    const secondKey = randomUUID();
    expect(secondKey).not.toBe(firstKey);
    const second = await owner.agent
      .post(`/inventories/${owner.inventoryId}/document-runs`)
      .send(createBody(secondKey))
      .expect(201);
    expect(second.body).toMatchObject({ resultRevision: 8, status: "queued" });
    expect(second.body.id).not.toBe(first.body.id);

    await runner.run(second.body.id as string, { retryCount: 0, retryLimit: 0 });
    const secondHistory = await owner.agent
      .get(`/inventories/${owner.inventoryId}/document-runs`)
      .expect(200);
    const secondRun = secondHistory.body.items.find(
      (run: { id: string }) => run.id === second.body.id,
    ) as { status: string; artifacts: Array<{ id: string; sha256: string }> } | undefined;
    if (!secondRun) throw new Error("Expected revision 8 document run");
    expect(secondRun).toMatchObject({
      status: "ready",
      artifacts: [{ id: expect.any(String), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }],
    });
    const secondArtifactId = secondRun.artifacts[0]!.id;
    await owner.agent
      .get(`/inventory-document-runs/${second.body.id}/artifacts/${secondArtifactId}/download`)
      .expect(200);
    await owner.agent.get(`/inventory-document-runs/${second.body.id}/download`).expect(200);

    const completed = await owner.agent
      .post(`/inventories/${owner.inventoryId}/complete`)
      .send({ documentsDownloadedAndChecked: true })
      .expect(201);
    expect(completed.body).toMatchObject({
      inventoryId: owner.inventoryId,
      status: "completed",
      resultRevision: 8,
    });
  });

  it("runs one inventory continuously through preparation, two-station work, correction, both production XML revisions, and completion", async () => {
    registry = productionInventoryDocumentGeneratorRegistry;
    try {
      const owner = await runProductionJourneyToFirstClose();
      expect(owner.resultRevision).toBe(5);
      const first = await owner.agent
        .post(`/inventories/${owner.inventoryId}/document-runs`)
        .send(productionBody())
        .expect(201);
      expect(first.body).toMatchObject({
        resultRevision: owner.resultRevision,
        status: "queued",
      });
      const firstVerified = await verifyProductionRun(
        owner,
        first.body.id as string,
        owner.resultRevision,
      );

      const reopened = await owner.agent
        .post(`/inventories/${owner.inventoryId}/reopen`)
        .send({})
        .expect(201);
      const regeneratedRevision = owner.resultRevision + 1;
      expect(regeneratedRevision).toBe(6);
      expect(reopened.body).toMatchObject({
        inventoryId: owner.inventoryId,
        status: "running",
        resultRevision: regeneratedRevision,
        invalidatedArtifactCount: 2,
      });
      for (const artifact of firstVerified.storedArtifacts) {
        await owner.agent
          .get(`/inventory-document-runs/${first.body.id}/artifacts/${artifact.id}/download`)
          .expect(404);
      }

      const closedAgain = await owner.agent
        .post(`/inventories/${owner.inventoryId}/close`)
        .send({})
        .expect(201);
      expect(closedAgain.body).toMatchObject({
        inventoryId: owner.inventoryId,
        status: "closed",
        resultRevision: regeneratedRevision,
        blockers: [],
      });
      const second = await owner.agent
        .post(`/inventories/${owner.inventoryId}/document-runs`)
        .send(productionBody())
        .expect(201);
      expect(second.body).toMatchObject({
        resultRevision: regeneratedRevision,
        status: "queued",
      });
      expect(second.body.id).not.toBe(first.body.id);
      await verifyProductionRun(owner, second.body.id as string, regeneratedRevision);

      const completed = await owner.agent
        .post(`/inventories/${owner.inventoryId}/complete`)
        .send({ documentsDownloadedAndChecked: true })
        .expect(201);
      expect(completed.body).toMatchObject({
        inventoryId: owner.inventoryId,
        status: "completed",
        resultRevision: regeneratedRevision,
      });
    } finally {
      registry = new InventoryDocumentGeneratorRegistry(syntheticGenerators);
    }
  });
  it("does not record ZIP download evidence when presigning fails", async () => {
    const owner = await seedInventory();
    const seeded = await seedReadySingleArtifact(owner, "presign.csv");
    storage.presignRead.mockRejectedValueOnce(new Error("synthetic presign failure"));

    await owner.agent.get(`/inventory-document-runs/${seeded.runId}/download`).expect(500);

    const [stored] = await db
      .select({ downloadedAt: schema.inventoryDocumentArtifacts.downloadedAt })
      .from(schema.inventoryDocumentArtifacts)
      .where(eq(schema.inventoryDocumentArtifacts.id, seeded.artifactId));
    expect(stored?.downloadedAt).toBeNull();
    const successfulAudits = await db
      .select({ id: schema.tenantAuditEvents.id })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, owner.tenantId),
          eq(schema.tenantAuditEvents.targetId, seeded.runId),
          eq(schema.tenantAuditEvents.action, "inventory.document_run.zip_downloaded"),
          eq(schema.tenantAuditEvents.outcome, "success"),
        ),
      );
    expect(successfulAudits).toHaveLength(0);
  });

  it("does not record ZIP download evidence when an artifact is invalidated after presigning", async () => {
    const owner = await seedInventory();
    const seeded = await seedReadySingleArtifact(owner, "race.csv");
    storage.presignRead.mockImplementationOnce(async (key: string) => {
      await db
        .update(schema.inventoryDocumentArtifacts)
        .set({ invalidatedAt: new Date() })
        .where(eq(schema.inventoryDocumentArtifacts.id, seeded.artifactId));
      return `https://storage.test/${encodeURIComponent(key)}`;
    });

    await owner.agent
      .get(`/inventory-document-runs/${seeded.runId}/download`)
      .expect(409, { code: "INVENTORY_DOCUMENT_ARTIFACT_INVALIDATED" });

    const [stored] = await db
      .select({
        downloadedAt: schema.inventoryDocumentArtifacts.downloadedAt,
        invalidatedAt: schema.inventoryDocumentArtifacts.invalidatedAt,
      })
      .from(schema.inventoryDocumentArtifacts)
      .where(eq(schema.inventoryDocumentArtifacts.id, seeded.artifactId));
    expect(stored?.downloadedAt).toBeNull();
    expect(stored?.invalidatedAt).toBeInstanceOf(Date);
    const successfulAudits = await db
      .select({ id: schema.tenantAuditEvents.id })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, owner.tenantId),
          eq(schema.tenantAuditEvents.targetId, seeded.runId),
          eq(schema.tenantAuditEvents.action, "inventory.document_run.zip_downloaded"),
          eq(schema.tenantAuditEvents.outcome, "success"),
        ),
      );
    expect(successfulAudits).toHaveLength(0);
  });

  it("completes the latest ready selection without requiring every available format", async () => {
    const owner = await seedInventory();
    const created = await owner.agent
      .post(`/inventories/${owner.inventoryId}/document-runs`)
      .send(createBody())
      .expect(201);
    const now = new Date();
    await db
      .update(schema.inventoryDocumentRuns)
      .set({ status: "ready", completedAt: now, sourceSnapshotStartedAt: now })
      .where(eq(schema.inventoryDocumentRuns.id, created.body.id));
    await db.insert(schema.inventoryDocumentArtifacts).values({
      tenantId: owner.tenantId,
      runId: created.body.id,
      formatId: syntheticDescriptor.id,
      formatVersion: 1,
      partNumber: 1,
      filename: "selected-stock.csv",
      mimeType: syntheticDescriptor.mimeType,
      rowCount: 0,
      codeCount: 0,
      boxCount: 0,
      byteSize: 1,
      sha256: createHash("sha256").update("a").digest("hex"),
      objectKey: `tenants/${owner.tenantId}/inventory-documents/complete/selected-stock.csv`,
      downloadedAt: now,
      downloadedByUserId: owner.userId,
    });

    await owner.agent
      .post(`/inventories/${owner.inventoryId}/complete`)
      .send({ documentsDownloadedAndChecked: true })
      .expect(201);
  });

  it("does not combine artifacts from different ready runs", async () => {
    const owner = await seedInventory();
    const older = await owner.agent
      .post(`/inventories/${owner.inventoryId}/document-runs`)
      .send({
        selectedFormats: [{ id: syntheticBoxesDescriptor.id, version: 1 }],
        idempotencyKey: randomUUID(),
      })
      .expect(201);
    const latest = await owner.agent
      .post(`/inventories/${owner.inventoryId}/document-runs`)
      .send({
        selectedFormats: [
          { id: syntheticDescriptor.id, version: 1 },
          { id: syntheticBoxesDescriptor.id, version: 1 },
        ],
        idempotencyKey: randomUUID(),
      })
      .expect(201);
    const now = new Date();
    await db
      .update(schema.inventoryDocumentRuns)
      .set({
        status: "ready",
        completedAt: now,
        sourceSnapshotStartedAt: now,
        createdAt: new Date("2026-08-26T10:00:00.000Z"),
      })
      .where(eq(schema.inventoryDocumentRuns.id, older.body.id));
    await db
      .update(schema.inventoryDocumentRuns)
      .set({
        status: "ready",
        completedAt: now,
        sourceSnapshotStartedAt: now,
        createdAt: new Date("2026-08-26T10:01:00.000Z"),
      })
      .where(eq(schema.inventoryDocumentRuns.id, latest.body.id));
    await db.insert(schema.inventoryDocumentArtifacts).values([
      {
        tenantId: owner.tenantId,
        runId: older.body.id,
        formatId: syntheticBoxesDescriptor.id,
        formatVersion: 1,
        partNumber: 1,
        filename: "older-boxes.csv",
        mimeType: syntheticBoxesDescriptor.mimeType,
        rowCount: 0,
        codeCount: 0,
        boxCount: 0,
        byteSize: 1,
        sha256: createHash("sha256").update("b").digest("hex"),
        objectKey: `tenants/${owner.tenantId}/inventory-documents/complete/older-boxes.csv`,
        downloadedAt: now,
        downloadedByUserId: owner.userId,
      },
      {
        tenantId: owner.tenantId,
        runId: latest.body.id,
        formatId: syntheticDescriptor.id,
        formatVersion: 1,
        partNumber: 1,
        filename: "latest-stock.csv",
        mimeType: syntheticDescriptor.mimeType,
        rowCount: 0,
        codeCount: 0,
        boxCount: 0,
        byteSize: 1,
        sha256: createHash("sha256").update("a").digest("hex"),
        objectKey: `tenants/${owner.tenantId}/inventory-documents/complete/latest-stock.csv`,
        downloadedAt: now,
        downloadedByUserId: owner.userId,
      },
    ]);

    await owner.agent
      .post(`/inventories/${owner.inventoryId}/complete`)
      .send({ documentsDownloadedAndChecked: true })
      .expect(409, {
        code: "INVENTORY_DOCUMENT_ARTIFACTS_NOT_READY",
        missingFormats: [{ id: syntheticBoxesDescriptor.id, version: 1 }],
      });
  });

  it("completes only after current required artifacts are ready, downloaded, and acknowledged", async () => {
    const owner = await seedInventory();
    const created = await owner.agent
      .post(`/inventories/${owner.inventoryId}/document-runs`)
      .send({
        selectedFormats: [
          { id: syntheticDescriptor.id, version: 1 },
          { id: syntheticBoxesDescriptor.id, version: 1 },
        ],
        idempotencyKey: randomUUID(),
      })
      .expect(201);
    await owner.agent
      .post(`/inventories/${owner.inventoryId}/complete`)
      .send({ documentsDownloadedAndChecked: true })
      .expect(409, { code: "INVENTORY_DOCUMENT_RUNS_ACTIVE" });

    const now = new Date();
    await db
      .update(schema.inventoryDocumentRuns)
      .set({ status: "ready", completedAt: now, sourceSnapshotStartedAt: now })
      .where(eq(schema.inventoryDocumentRuns.id, created.body.id));
    await db.insert(schema.inventoryDocumentArtifacts).values([
      {
        tenantId: owner.tenantId,
        runId: created.body.id,
        formatId: syntheticDescriptor.id,
        formatVersion: 1,
        partNumber: 1,
        filename: "stock.csv",
        mimeType: syntheticDescriptor.mimeType,
        rowCount: 0,
        codeCount: 0,
        boxCount: 0,
        byteSize: 1,
        sha256: createHash("sha256").update("a").digest("hex"),
        objectKey: `tenants/${owner.tenantId}/inventory-documents/complete/stock.csv`,
      },
      {
        tenantId: owner.tenantId,
        runId: created.body.id,
        formatId: syntheticBoxesDescriptor.id,
        formatVersion: 1,
        partNumber: 1,
        filename: "boxes.csv",
        mimeType: syntheticBoxesDescriptor.mimeType,
        rowCount: 0,
        codeCount: 0,
        boxCount: 0,
        byteSize: 1,
        sha256: createHash("sha256").update("b").digest("hex"),
        objectKey: `tenants/${owner.tenantId}/inventory-documents/complete/boxes.csv`,
      },
    ]);
    await owner.agent
      .post(`/inventories/${owner.inventoryId}/complete`)
      .send({ documentsDownloadedAndChecked: true })
      .expect(409, { code: "INVENTORY_DOCUMENT_ARTIFACTS_NOT_READY", missingFormats: [] });

    await db
      .update(schema.inventoryDocumentArtifacts)
      .set({ downloadedAt: now, downloadedByUserId: owner.userId })
      .where(eq(schema.inventoryDocumentArtifacts.runId, created.body.id));
    const completed = await owner.agent
      .post(`/inventories/${owner.inventoryId}/complete`)
      .send({ documentsDownloadedAndChecked: true })
      .expect(201);
    expect(completed.body).toMatchObject({
      inventoryId: owner.inventoryId,
      status: "completed",
      resultRevision: 7,
    });
  });
});
