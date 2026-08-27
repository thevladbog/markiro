import { createHash, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { schema, type Db } from "@markiro/db";

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
  type InventoryDocumentGenerator,
} from "../src/modules/inventories/inventory-document-runner.service";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import { listenOnLoopback } from "./support/listen-loopback";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";
import { signUpAndActivate } from "./support/auth";

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

describe.skipIf(!ready)("inventory document endpoints with synthetic test registry", () => {
  let app: INestApplication | undefined;
  let db: Db;
  let document: OpenAPIObject;
  let runner: InventoryDocumentRunnerService;
  let registry = new InventoryDocumentGeneratorRegistry(syntheticGenerators);
  const enqueue = vi.fn(async () => "job-1");
  const objects = new Map<string, Buffer>();
  const storage = {
    putVerified: vi.fn(async (key: string, body: Buffer, _mime: string, sha256: string) => {
      expect(createHash("sha256").update(body).digest("hex")).toBe(sha256);
      objects.set(key, Buffer.from(body));
      return { byteSize: body.byteLength, sha256 };
    }),
    get: vi.fn(async (key: string) => ({ body: objects.get(key)!, contentType: null })),
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

  async function seedInventory(status: "draft" | "closed" = "closed") {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
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
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: GTIN,
      name: "Document product",
    });
    await db.insert(schema.lines).values({ id: lineId, tenantId, name: "Document line" });
    await db.insert(schema.inventories).values({
      id: inventoryId,
      tenantId,
      number: `INV-${randomUUID()}`,
      productId,
      gtin14Snapshot: GTIN,
      lineId,
      mode: "check",
      productionDateFrom: "2026-08-01",
      productionDateTo: "2026-08-31",
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
    return { agent, tenantId, userId: member.userId, inventoryId };
  }

  const createBody = (idempotencyKey = randomUUID()) => ({
    selectedFormats: [{ id: syntheticDescriptor.id, version: 1 }],
    idempotencyKey,
  });

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
