import { createHash, randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema, type Db } from "@markiro/db";

import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);
const GTIN = "04600000000015";

type Agent = ReturnType<typeof request.agent>;
type JsonSchema = {
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  oneOf?: JsonSchema[];
};

interface BatchFixture {
  agent: Agent;
  tenantId: string;
  userId: string;
  inventoryId: string;
  snapshotId: string;
  deviceId: string;
  boxEventId: string;
  itemEventId: string;
  boxResultIds: string[];
  itemResultId: string;
}

describe.skipIf(!ready)("inventory correction batches", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;
  let document: OpenAPIObject;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    db = setup.db;
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    }).compile();
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("inventory correction batches").setVersion("test").build(),
    );
  });

  afterAll(async () => {
    await app?.close();
  });

  async function seedFixture(): Promise<BatchFixture> {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const [member] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId))
      .limit(1);
    if (!member) throw new Error("Expected correction batch actor");
    const userId = member.userId;
    const productId = randomUUID();
    const lineId = randomUUID();
    const operatorId = randomUUID();
    const deviceId = randomUUID();
    const inventoryId = randomUUID();
    const snapshotId = randomUUID();
    const boxEventId = randomUUID();
    const itemEventId = randomUUID();
    const boxResultIds = [randomUUID(), randomUUID()];
    const itemResultId = randomUUID();
    const resultIds = [...boxResultIds, itemResultId];
    const hashes = resultIds.map((id) => createHash("sha256").update(id).digest("hex"));

    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: GTIN,
      name: "Batch correction product",
    });
    await db.insert(schema.lines).values({ id: lineId, tenantId, name: "Batch correction line" });
    await db.insert(schema.employees).values({
      id: operatorId,
      tenantId,
      fullName: "Batch correction operator",
    });
    await db.insert(schema.stationDevices).values({
      id: deviceId,
      tenantId,
      name: "Batch correction terminal",
      lineId,
    });
    await db.insert(schema.inventories).values({
      id: inventoryId,
      tenantId,
      number: `INV-BATCH-${randomUUID()}`,
      productId,
      gtin14Snapshot: GTIN,
      lineId,
      mode: "check",
      productionDateFrom: "2026-08-01",
      productionDateTo: "2026-08-31",
      createdByUserId: userId,
    });
    await db.insert(schema.inventorySnapshots).values({
      id: snapshotId,
      tenantId,
      inventoryId,
      combinedDigest: "a".repeat(64),
      productName: "Batch correction product",
      lineName: "Batch correction line",
      emittedCount: 0,
      introducedCount: 3,
      appliedCount: 0,
      retiredCount: 0,
      writtenOffCount: 0,
      disaggregationCount: 0,
      protectedCount: 0,
      expectedCount: 3,
      packageCount: 1,
      looseCount: 1,
      fixedByUserId: userId,
    });
    await db.insert(schema.inventorySnapshotCodes).values(
      hashes.map((codeHash, index) => ({
        tenantId,
        snapshotId,
        canonicalRaw: `01${GTIN}21BATCH-${index}`,
        codeHash,
        gtin14: GTIN,
        serial: `BATCH-${index}`,
        sourceStatus: "INTRODUCED" as const,
        sourceProductionDate: "2026-08-05",
        parentSscc: index < 2 ? "046000000000000015" : null,
        expected: true,
        protected: false,
      })),
    );
    await db
      .update(schema.inventories)
      .set({
        activeSnapshotId: snapshotId,
        stationManifest: { snapshotRevision: 1 },
        status: "running",
        resultRevision: 4,
        startedByUserId: userId,
        startedAt: new Date("2026-08-20T09:00:00.000Z"),
      })
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    await db.insert(schema.inventoryScanBatches).values({
      tenantId,
      inventoryId,
      deviceId,
      batchId: "bulk-correction-fixture",
      payloadDigest: "b".repeat(64),
      sequenceCeiling: 2n,
      outcome: "applied",
      result: {},
    });
    await db.insert(schema.inventoryScanEvents).values([
      {
        eventId: boxEventId,
        tenantId,
        inventoryId,
        batchId: "bulk-correction-fixture",
        deviceId,
        deviceSequence: 1n,
        operatorId,
        scannedAt: new Date("2026-08-20T10:00:00.000Z"),
        kind: "known_box",
        normalizedIdentity: "known_box:046000000000000015",
        codeHash: null,
        rawPayload: "046000000000000015",
        activeProductionDate: "2026-08-05",
        snapshotRevision: 1,
        localVerdict: "expected",
        authoritativeVerdict: "applied",
      },
      {
        eventId: itemEventId,
        tenantId,
        inventoryId,
        batchId: "bulk-correction-fixture",
        deviceId,
        deviceSequence: 2n,
        operatorId,
        scannedAt: new Date("2026-08-20T10:01:00.000Z"),
        kind: "item",
        normalizedIdentity: `item:${hashes[2]!}`,
        codeHash: hashes[2]!,
        rawPayload: `01${GTIN}21BATCH-2`,
        activeProductionDate: "2026-08-05",
        snapshotRevision: 1,
        localVerdict: "expected",
        authoritativeVerdict: "applied",
      },
    ]);
    await db.insert(schema.inventoryCodeResults).values(
      resultIds.map((id, index) => ({
        id,
        tenantId,
        inventoryId,
        codeHash: hashes[index]!,
        snapshotId,
        firstAcceptedEventId: index < 2 ? boxEventId : itemEventId,
        winningDeviceId: deviceId,
        winningScannedAt: new Date("2026-08-20T10:00:00.000Z"),
        observedProductionDate: "2026-08-05",
        classification: "expected" as const,
        originClassification: "expected" as const,
      })),
    );

    return {
      agent,
      tenantId,
      userId,
      inventoryId,
      snapshotId,
      deviceId,
      boxEventId,
      itemEventId,
      boxResultIds,
      itemResultId,
    };
  }

  function explicitBody(fixture: BatchFixture, overrides: Record<string, unknown> = {}) {
    return {
      action: "void_scan",
      selection: {
        mode: "explicit",
        eventIds: [fixture.boxEventId, fixture.itemEventId],
      },
      reason: "Verified bulk correction",
      expectedResultRevision: 4,
      idempotencyKey: randomUUID(),
      ...overrides,
    };
  }

  it("voids explicit events atomically with one revision and per-code audit", async () => {
    const fixture = await seedFixture();
    const response = await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections/batch`)
      .send(explicitBody(fixture))
      .expect(201);

    expect(response.body).toMatchObject({
      action: "void_scan",
      selectedEventCount: 2,
      affectedCodeCount: 3,
      resultRevision: 5,
    });
    const batches = await db
      .select()
      .from(schema.inventoryCorrectionBatches)
      .where(eq(schema.inventoryCorrectionBatches.inventoryId, fixture.inventoryId));
    const corrections = await db
      .select()
      .from(schema.inventoryCorrections)
      .where(eq(schema.inventoryCorrections.inventoryId, fixture.inventoryId));
    const changes = await db
      .select()
      .from(schema.inventoryProgressChanges)
      .where(eq(schema.inventoryProgressChanges.inventoryId, fixture.inventoryId));
    expect(batches).toHaveLength(1);
    expect(corrections).toHaveLength(3);
    expect(changes).toHaveLength(3);
    expect(corrections.every((row) => row.batchId === batches[0]!.id)).toBe(true);
    expect(corrections.every((row) => row.resultRevision === 5)).toBe(true);
    expect(changes.every((row) => row.resultRevision === 5)).toBe(true);
    const results = await db
      .select({ classification: schema.inventoryCodeResults.classification })
      .from(schema.inventoryCodeResults)
      .where(eq(schema.inventoryCodeResults.inventoryId, fixture.inventoryId));
    expect(results.every((row) => row.classification === "voided")).toBe(true);
  });

  it("applies all matching filters with exclusions and changes every child date", async () => {
    const fixture = await seedFixture();
    const response = await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections/batch`)
      .send({
        action: "change_date",
        selection: {
          mode: "all_matching",
          filter: { scope: "all", kind: "known_box" },
          excludedEventIds: [],
        },
        observedProductionDate: "2026-08-09",
        reason: "Correct box production date",
        expectedResultRevision: 4,
        idempotencyKey: randomUUID(),
      })
      .expect(201);

    expect(response.body).toMatchObject({ selectedEventCount: 1, affectedCodeCount: 2 });
    const results = await db
      .select({
        id: schema.inventoryCodeResults.id,
        observedProductionDate: schema.inventoryCodeResults.observedProductionDate,
      })
      .from(schema.inventoryCodeResults)
      .where(eq(schema.inventoryCodeResults.inventoryId, fixture.inventoryId));
    expect(
      results
        .filter((row) => fixture.boxResultIds.includes(row.id))
        .map((row) => row.observedProductionDate),
    ).toEqual(["2026-08-09", "2026-08-09"]);
    expect(results.find((row) => row.id === fixture.itemResultId)?.observedProductionDate).toBe(
      "2026-08-05",
    );
  });

  it("replays exactly and rejects a changed request under the same key", async () => {
    const fixture = await seedFixture();
    const body = explicitBody(fixture);
    const applied = await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections/batch`)
      .send(body)
      .expect(201);
    const replay = await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections/batch`)
      .send(body)
      .expect(201);
    expect(replay.body).toEqual(applied.body);
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections/batch`)
      .send({ ...body, reason: "Different correction" })
      .expect(409, { code: "INVENTORY_CORRECTION_IDEMPOTENCY_MISMATCH" });
  });

  it("rolls back the full date batch when any result belongs to an active box", async () => {
    const fixture = await seedFixture();
    const boxId = randomUUID();
    await db.insert(schema.inventoryRepackBoxes).values({
      id: boxId,
      tenantId: fixture.tenantId,
      inventoryId: fixture.inventoryId,
      newSscc: "146000000000000012",
      ownerDeviceId: fixture.deviceId,
      capacity: 12,
      productionDate: "2026-08-05",
    });
    await db.insert(schema.inventoryRepackItems).values({
      tenantId: fixture.tenantId,
      inventoryId: fixture.inventoryId,
      boxId,
      resultId: fixture.itemResultId,
      productionDate: "2026-08-05",
      activeObservedProductionDate: "2026-08-05",
    });

    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections/batch`)
      .send({
        ...explicitBody(fixture),
        action: "change_date",
        observedProductionDate: "2026-08-09",
      })
      .expect(409, { code: "INVENTORY_CORRECTION_ACTIVE_BOX_CONFLICT" });
    expect(
      await db
        .select()
        .from(schema.inventoryCorrectionBatches)
        .where(eq(schema.inventoryCorrectionBatches.inventoryId, fixture.inventoryId)),
    ).toHaveLength(0);
    const [inventory] = await db
      .select({ resultRevision: schema.inventories.resultRevision })
      .from(schema.inventories)
      .where(eq(schema.inventories.id, fixture.inventoryId));
    expect(inventory?.resultRevision).toBe(4);
  });

  it("rejects stale, changed, empty, cross-tenant, closed, and malformed selections", async () => {
    const fixture = await seedFixture();
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections/batch`)
      .send(explicitBody(fixture, { expectedResultRevision: 3 }))
      .expect(409, { code: "INVENTORY_CORRECTION_STALE_REVISION", resultRevision: 4 });
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections/batch`)
      .send(
        explicitBody(fixture, {
          selection: { mode: "explicit", eventIds: [fixture.boxEventId, randomUUID()] },
        }),
      )
      .expect(409, { code: "INVENTORY_CORRECTION_BATCH_SELECTION_CHANGED" });
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections/batch`)
      .send({
        ...explicitBody(fixture),
        selection: {
          mode: "all_matching",
          filter: { scope: "all", search: "never-matches" },
          excludedEventIds: [],
        },
      })
      .expect(409, { code: "INVENTORY_CORRECTION_BATCH_EMPTY" });
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections/batch`)
      .send(
        explicitBody(fixture, {
          selection: { mode: "explicit", eventIds: [fixture.boxEventId, fixture.boxEventId] },
        }),
      )
      .expect(400);
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections/batch`)
      .send(explicitBody(fixture, { unexpected: true }))
      .expect(400);

    const foreign = await seedFixture();
    await foreign.agent
      .post(`/inventories/${fixture.inventoryId}/corrections/batch`)
      .send(explicitBody(fixture))
      .expect(404);
    await db
      .update(schema.inventories)
      .set({ status: "closed", closedByUserId: fixture.userId, closedAt: new Date() })
      .where(eq(schema.inventories.id, fixture.inventoryId));
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/corrections/batch`)
      .send(explicitBody(fixture))
      .expect(409, { code: "INVENTORY_CORRECTION_NOT_RUNNING" });
  });

  it("documents strict batch request and response objects", () => {
    const operation = document.paths["/inventories/{id}/corrections/batch"]?.post;
    if (!operation) throw new Error("Missing correction batch operation");
    const requestSchema = (
      operation.requestBody && "$ref" in operation.requestBody
        ? undefined
        : operation.requestBody?.content["application/json"]?.schema
    ) as JsonSchema | undefined;
    if (!requestSchema) throw new Error("Missing correction batch request schema");
    expect(requestSchema.oneOf).toHaveLength(2);
    for (const branch of requestSchema.oneOf ?? []) {
      expect(branch.additionalProperties).toBe(false);
      expect(branch.required).toEqual(
        expect.arrayContaining([
          "action",
          "selection",
          "reason",
          "expectedResultRevision",
          "idempotencyKey",
        ]),
      );
      expect(branch.properties?.selection?.oneOf).toHaveLength(2);
      expect(
        branch.properties?.selection?.oneOf?.every(
          (selection) => selection.additionalProperties === false,
        ),
      ).toBe(true);
    }
    const response = operation.responses["201"];
    if (!response || "$ref" in response) throw new Error("Missing correction batch response");
    const responseSchema = response.content?.["application/json"]?.schema as JsonSchema | undefined;
    if (!responseSchema) throw new Error("Missing correction batch response schema");
    expect(responseSchema.additionalProperties).toBe(false);
    expect(Object.keys(responseSchema.properties ?? {}).sort()).toEqual(
      [
        "id",
        "action",
        "selectedEventCount",
        "affectedCodeCount",
        "resultRevision",
        "createdAt",
      ].sort(),
    );
  });
});
