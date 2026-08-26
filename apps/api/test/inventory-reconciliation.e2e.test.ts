import { randomUUID } from "node:crypto";

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
import { InventoryReconciliationService } from "../src/modules/inventories/inventory-reconciliation.service";
import { listenOnLoopback } from "./support/listen-loopback";
import { setOnlyOrganizationMemberRole, signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);
const GTIN = "04600000000015";

type Agent = ReturnType<typeof request.agent>;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbTransactionConfig = Parameters<Db["transaction"]>[1];
type JsonSchema = {
  type?: string;
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};

describe.skipIf(!ready)("tenant inventory reconciliation endpoints", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;
  let document: OpenAPIObject;
  let agent: Agent;
  let foreignAgent: Agent;
  let tenantId: string;
  let foreignTenantId: string;
  let inventoryId: string;
  let userId: string;
  let snapshotId: string;
  let lineId: string;
  let operatorId: string;
  let terminalAId: string;
  let terminalBId: string;
  let terminalCId: string;
  let unknownEventId: string;
  let unknownResultId: string;

  const verifiedHash = "1".repeat(64);
  const missingHash = "2".repeat(64);
  const protectedFoundHash = "3".repeat(64);
  const protectedMissingHash = "4".repeat(64);
  const ineligibleHash = "5".repeat(64);
  const unknownHash = "6".repeat(64);
  const dateMismatchHash = "7".repeat(64);
  const voidedHash = "8".repeat(64);
  const sourceSscc = "046000000000000015";
  const invalidatedSscc = "146000000000000012";

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
      new DocumentBuilder().setTitle("inventory reconciliation").setVersion("test").build(),
    );

    agent = request.agent(app.getHttpServer());
    foreignAgent = request.agent(app.getHttpServer());
    tenantId = await signUpAndActivate(agent);
    foreignTenantId = await signUpAndActivate(foreignAgent);
    const [member] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId))
      .limit(1);
    if (!member) throw new Error("Expected inventory reconciliation actor fixture");
    userId = member.userId;
    inventoryId = randomUUID();
    snapshotId = randomUUID();
    lineId = randomUUID();
    operatorId = randomUUID();
    terminalAId = randomUUID();
    terminalBId = randomUUID();
    terminalCId = randomUUID();
    const productId = randomUUID();

    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: GTIN,
      name: "Reconciliation product",
    });
    await db.insert(schema.lines).values({ id: lineId, tenantId, name: "Reconciliation line" });
    await db.insert(schema.employees).values({
      id: operatorId,
      tenantId,
      fullName: "Reconciliation operator",
    });
    await db.insert(schema.stationDevices).values([
      { id: terminalAId, tenantId, name: "Terminal A", lineId },
      { id: terminalBId, tenantId, name: "Terminal B", lineId },
      { id: terminalCId, tenantId, name: "Terminal C", lineId },
    ]);
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
      createdByUserId: userId,
    });
    await db.insert(schema.inventorySnapshots).values({
      id: snapshotId,
      tenantId,
      inventoryId,
      combinedDigest: "d".repeat(64),
      emittedCount: 1,
      introducedCount: 7,
      appliedCount: 0,
      retiredCount: 1,
      writtenOffCount: 0,
      disaggregationCount: 0,
      protectedCount: 2,
      expectedCount: 4,
      packageCount: 1,
      looseCount: 6,
      fixedByUserId: userId,
    });
    await db.insert(schema.inventorySnapshotCodes).values([
      codeRow(verifiedHash, "VERIFIED", { expected: true, sourceProductionDate: "2026-08-05" }),
      codeRow(missingHash, "MISSING", { expected: true, sourceProductionDate: "2026-08-06" }),
      codeRow(protectedFoundHash, "PROTECTED-FOUND", {
        protected: true,
        sourceState: "MOVING_BY_UD",
      }),
      codeRow(protectedMissingHash, "PROTECTED-MISSING", {
        protected: true,
        sourceState: "MOVING_BY_UD",
      }),
      codeRow(ineligibleHash, "INELIGIBLE", { sourceStatus: "RETIRED" }),
      codeRow(dateMismatchHash, "DATE-MISMATCH", {
        expected: true,
        sourceProductionDate: "2026-08-07",
        parentSscc: sourceSscc,
      }),
      codeRow(voidedHash, "VOIDED", { expected: true, sourceProductionDate: "2026-08-08" }),
    ]);
    await db
      .update(schema.inventories)
      .set({
        status: "running",
        activeSnapshotId: snapshotId,
        stationManifest: { snapshotRevision: 1 },
        resultRevision: 8,
        startedByUserId: userId,
        startedAt: new Date("2026-08-20T09:00:00.000Z"),
      })
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );

    await db
      .insert(schema.inventoryScanBatches)
      .values([
        batch(terminalAId, "reconciliation-a", "e", 10n),
        batch(terminalBId, "reconciliation-b", "f", 10n),
      ]);
    const eventIds = {
      verified: randomUUID(),
      duplicate: randomUUID(),
      protected: randomUUID(),
      ineligible: randomUUID(),
      unknown: randomUUID(),
      dateMismatch: randomUUID(),
      voided: randomUUID(),
      oldBox: randomUUID(),
    };
    unknownEventId = eventIds.unknown;
    unknownResultId = randomUUID();
    await db.insert(schema.inventoryScanEvents).values([
      event(eventIds.verified, terminalAId, "reconciliation-a", 1n, verifiedHash),
      event(eventIds.duplicate, terminalBId, "reconciliation-b", 1n, verifiedHash, {
        scannedAt: new Date("2026-08-20T10:01:00.000Z"),
        authoritativeVerdict: "duplicate",
      }),
      event(eventIds.protected, terminalAId, "reconciliation-a", 2n, protectedFoundHash),
      event(eventIds.ineligible, terminalAId, "reconciliation-a", 3n, ineligibleHash),
      event(eventIds.unknown, terminalAId, "reconciliation-a", 4n, unknownHash),
      event(eventIds.dateMismatch, terminalAId, "reconciliation-a", 5n, dateMismatchHash, {
        activeProductionDate: "2026-08-09",
      }),
      event(eventIds.voided, terminalAId, "reconciliation-a", 6n, voidedHash),
      event(eventIds.oldBox, terminalBId, "reconciliation-b", 2n, null, {
        kind: "old_box",
        normalizedIdentity: `old_box:${sourceSscc}`,
        rawPayload: sourceSscc,
      }),
    ]);
    await db.insert(schema.inventoryCodeResults).values([
      result(eventIds.verified, verifiedHash, "expected", snapshotId, "2026-08-05"),
      result(eventIds.protected, protectedFoundHash, "protected", snapshotId, "2026-08-05"),
      result(eventIds.ineligible, ineligibleHash, "ineligible", snapshotId, "2026-08-05"),
      {
        ...result(eventIds.unknown, unknownHash, "unknown", null, "2026-08-05"),
        id: unknownResultId,
      },
      result(eventIds.dateMismatch, dateMismatchHash, "expected", snapshotId, "2026-08-09"),
      result(eventIds.voided, voidedHash, "voided", snapshotId, "2026-08-08", "expected"),
    ]);
    await db
      .insert(schema.inventoryEventClaimOutcomes)
      .values([
        claim(eventIds.verified, verifiedHash, "claimed", eventIds.verified, terminalAId),
        claim(eventIds.duplicate, verifiedHash, "duplicate", eventIds.verified, terminalAId),
      ]);
    await db.insert(schema.inventoryRepackBoxes).values({
      tenantId,
      inventoryId,
      newSscc: invalidatedSscc,
      ownerDeviceId: terminalBId,
      capacity: 12,
      productionDate: "2026-08-09",
      state: "invalidated",
      printState: "not_ready",
      invalidatedAt: new Date("2026-08-20T11:00:00.000Z"),
    });
    await db.insert(schema.inventoryDeviceParticipants).values([
      {
        tenantId,
        inventoryId,
        deviceId: terminalAId,
        operatorId,
        configuredLineId: lineId,
        joinMethod: "assigned_line",
        joinedAt: new Date(Date.now() - 300_000),
        heartbeatAt: new Date(),
        pendingEventCount: 3,
        openBoxCount: 1,
      },
      {
        tenantId,
        inventoryId,
        deviceId: terminalBId,
        operatorId,
        configuredLineId: lineId,
        joinMethod: "assigned_line",
        joinedAt: new Date(Date.now() - 300_000),
        heartbeatAt: new Date(Date.now() - 120_000),
        pendingEventCount: 0,
        openBoxCount: 0,
      },
      {
        tenantId,
        inventoryId,
        deviceId: terminalCId,
        operatorId,
        configuredLineId: lineId,
        joinMethod: "assigned_line",
        joinedAt: new Date(Date.now() - 300_000),
        heartbeatAt: new Date(Date.now() - 180_000),
        leftAt: new Date(Date.now() - 60_000),
        pendingEventCount: 0,
        openBoxCount: 0,
      },
    ]);
  });

  afterAll(async () => {
    await app?.close();
  });

  function codeRow(
    codeHash: string,
    serial: string,
    overrides: Partial<typeof schema.inventorySnapshotCodes.$inferInsert> = {},
  ): typeof schema.inventorySnapshotCodes.$inferInsert {
    return {
      tenantId,
      snapshotId,
      canonicalRaw: `01${GTIN}21${serial}`,
      codeHash,
      gtin14: GTIN,
      serial,
      sourceStatus: "INTRODUCED",
      sourceState: null,
      sourceProductionDate: null,
      parentSscc: null,
      expected: false,
      protected: false,
      ...overrides,
    };
  }

  function batch(deviceId: string, batchId: string, digestUnit: string, sequenceCeiling: bigint) {
    return {
      tenantId,
      inventoryId,
      deviceId,
      batchId,
      payloadDigest: digestUnit.repeat(64),
      sequenceCeiling,
      outcome: "applied" as const,
      result: {},
    };
  }

  function event(
    eventId: string,
    deviceId: string,
    batchId: string,
    deviceSequence: bigint,
    codeHash: string | null,
    overrides: Partial<typeof schema.inventoryScanEvents.$inferInsert> = {},
  ): typeof schema.inventoryScanEvents.$inferInsert {
    return {
      eventId,
      tenantId,
      inventoryId,
      batchId,
      deviceId,
      deviceSequence,
      operatorId,
      scannedAt: new Date("2026-08-20T10:00:00.000Z"),
      kind: "item",
      normalizedIdentity: `item:${codeHash}`,
      codeHash,
      rawPayload: codeHash === null ? null : `01${GTIN}21FOUND-${codeHash[0]}`,
      activeProductionDate: "2026-08-05",
      snapshotRevision: 1,
      localVerdict: "expected",
      authoritativeVerdict: "applied",
      ...overrides,
    };
  }

  function result(
    eventId: string,
    codeHash: string,
    classification: "expected" | "protected" | "ineligible" | "unknown" | "voided",
    resultSnapshotId: string | null,
    observedProductionDate: string,
    originClassification: "expected" | "protected" | "ineligible" | "unknown" = classification ===
    "voided"
      ? "expected"
      : classification,
  ): typeof schema.inventoryCodeResults.$inferInsert {
    return {
      tenantId,
      inventoryId,
      codeHash,
      snapshotId: resultSnapshotId,
      firstAcceptedEventId: eventId,
      winningDeviceId: terminalAId,
      winningScannedAt: new Date("2026-08-20T10:00:00.000Z"),
      observedProductionDate,
      classification,
      originClassification,
    };
  }

  function claim(
    sourceEventId: string,
    codeHash: string,
    status: "claimed" | "duplicate",
    winningEventId: string,
    winningDeviceId: string,
  ) {
    return {
      tenantId,
      inventoryId,
      sourceEventId,
      codeHash,
      status,
      winningEventId,
      winningDeviceId,
      winningScannedAt: new Date("2026-08-20T10:00:00.000Z"),
    };
  }

  it("returns set-based live counts without duplicating one code seen by several terminals", async () => {
    const response = await agent.get(`/inventories/${inventoryId}/progress`).expect(200);
    expect(response.body).toEqual({
      inventoryId,
      snapshotId,
      status: "running",
      resultRevision: 8,
      expectedCount: 4,
      verifiedCount: 2,
      missingCount: 1,
      protectedCount: 2,
      protectedFoundCount: 1,
      ineligibleCount: 1,
      unknownCount: 1,
      dateMismatchCount: 1,
      voidedCount: 1,
      oldBoxCount: 1,
      newBoxCount: 1,
      invalidatedBoxCount: 1,
      pendingEventCount: 3,
      openBoxCount: 1,
      boxTotal: 1,
      boxesTruncated: false,
      participants: [
        expect.objectContaining({
          deviceId: terminalAId,
          terminalName: "Terminal A",
          state: "active",
          pendingEventCount: 3,
          openBoxCount: 1,
        }),
        expect.objectContaining({
          deviceId: terminalBId,
          terminalName: "Terminal B",
          state: "stale",
          pendingEventCount: 0,
        }),
        expect.objectContaining({
          deviceId: terminalCId,
          terminalName: "Terminal C",
          state: "left",
          leftAt: expect.any(String),
        }),
      ],
      boxes: [
        expect.objectContaining({
          id: expect.any(String),
          sscc: invalidatedSscc,
          terminalId: terminalBId,
          terminalName: "Terminal B",
          state: "invalidated",
          printState: "not_ready",
          itemCount: 0,
        }),
      ],
      recentEvents: expect.arrayContaining([
        expect.objectContaining({
          eventId: unknownEventId,
          codeResultId: expect.any(String),
          terminalId: terminalAId,
          terminalName: "Terminal A",
          classification: "unknown",
        }),
      ]),
    });
  });

  it("pages, searches, and filters evidence while exposing actions only for current winners", async () => {
    const openBoxId = randomUUID();
    await db.insert(schema.inventoryRepackBoxes).values({
      id: openBoxId,
      tenantId,
      inventoryId,
      newSscc: "346000000000000016",
      ownerDeviceId: terminalAId,
      capacity: 12,
      productionDate: "2026-08-05",
      state: "open",
      printState: "not_ready",
    });
    await db.insert(schema.inventoryRepackItems).values({
      tenantId,
      inventoryId,
      boxId: openBoxId,
      resultId: unknownResultId,
      productionDate: "2026-08-05",
      activeObservedProductionDate: "2026-08-05",
    });

    const first = await agent
      .get(`/inventories/${inventoryId}/evidence?page=1&pageSize=3`)
      .expect(200);
    expect(first.body).toMatchObject({ page: 1, pageSize: 3, total: 8, hasMore: true });
    const duplicate = await agent
      .get(`/inventories/${inventoryId}/evidence?search=${verifiedHash}&pageSize=20`)
      .expect(200);
    expect(duplicate.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authoritativeVerdict: "duplicate",
          codeResultId: null,
          actions: [],
        }),
        expect.objectContaining({
          authoritativeVerdict: "applied",
          actions: ["void_scan", "change_date"],
        }),
      ]),
    );
    const actionableMember = await agent
      .get(`/inventories/${inventoryId}/evidence?classification=unknown&kind=item`)
      .expect(200);
    expect(actionableMember.body.items).toEqual([
      expect.objectContaining({
        eventId: unknownEventId,
        codeResultId: unknownResultId,
        actions: ["void_scan", "remove_item"],
      }),
    ]);
    await agent
      .get(`/inventories/${inventoryId}/evidence?page=0&pageSize=101&search=${"x".repeat(129)}`)
      .expect(400);
  });

  it("paginates audit-safe discrepancy rows in category, SSCC, and code-hash order", async () => {
    const first = await agent
      .get(`/inventories/${inventoryId}/discrepancies?page=1&pageSize=4`)
      .expect(200);
    expect(first.body).toMatchObject({ page: 1, pageSize: 4, total: 8, hasMore: true });
    expect(
      first.body.items.map((item: { category: string; codeHash: string | null }) => [
        item.category,
        item.codeHash,
      ]),
    ).toEqual([
      ["missing", missingHash],
      ["protected", protectedFoundHash],
      ["protected", protectedMissingHash],
      ["ineligible", ineligibleHash],
    ]);
    expect(first.body.items[1]).toMatchObject({
      displayIdentity: `01${GTIN}21PROTECTED-FOUND`,
      found: true,
      winner: {
        terminalId: terminalAId,
        terminalName: "Terminal A",
        scannedAt: "2026-08-20T10:00:00.000Z",
      },
    });
    expect(JSON.stringify(first.body)).not.toMatch(
      /rawPayload|canonicalRaw|objectKey|credential|apiKey|batchId|operatorId/i,
    );

    const filtered = await agent
      .get(`/inventories/${inventoryId}/discrepancies?category=date_mismatch`)
      .expect(200);
    expect(filtered.body.items).toEqual([
      expect.objectContaining({
        category: "date_mismatch",
        codeHash: dateMismatchHash,
        sscc: sourceSscc,
        sourceProductionDate: "2026-08-07",
        observedProductionDate: "2026-08-09",
      }),
    ]);
  });

  it("returns one discrepancy snapshot when a row commits between count and page reads", async () => {
    const concurrentSscc = "246000000000000019";
    let mutationRan = false;
    const mutateAfterCount = async () => {
      mutationRan = true;
      await db.insert(schema.inventoryRepackBoxes).values({
        tenantId,
        inventoryId,
        newSscc: concurrentSscc,
        ownerDeviceId: terminalBId,
        capacity: 12,
        productionDate: "2026-08-10",
        state: "invalidated",
        printState: "not_ready",
        invalidatedAt: new Date("2026-08-20T11:10:00.000Z"),
      });
    };
    const snapshotDb = withMutationAfterFirstExecute(db, mutateAfterCount);
    const reconciliation = new InventoryReconciliationService(snapshotDb);

    const response = await reconciliation.listDiscrepancies(tenantId, inventoryId, {
      page: 1,
      pageSize: 100,
    });

    expect(mutationRan).toBe(true);
    expect(response.total).toBe(8);
    expect(response.items).toHaveLength(8);
    expect(response.items.map((item) => item.sscc)).not.toContain(concurrentSscc);
  });

  it("denies cross-tenant UUID possession and malformed pagination", async () => {
    await foreignAgent.get(`/inventories/${inventoryId}/progress`).expect(404);
    await foreignAgent.get(`/inventories/${inventoryId}/discrepancies`).expect(404);
    await foreignAgent.get(`/inventories/${inventoryId}/evidence`).expect(404);
    await agent.get(`/inventories/${inventoryId}/discrepancies?page=0&pageSize=1000`).expect(400);
    expect(foreignTenantId).not.toBe(tenantId);
  });

  it("requires operations read permission on both routes", async () => {
    await setOnlyOrganizationMemberRole(db, tenantId, "member");
    await agent.get(`/inventories/${inventoryId}/progress`).expect(403);
    await agent.get(`/inventories/${inventoryId}/discrepancies`).expect(403);
    await agent.get(`/inventories/${inventoryId}/evidence`).expect(403);
  });

  it("documents exact closed response objects without private evidence fields", () => {
    const progress = responseSchema(document, "/inventories/{id}/progress");
    exactObject(progress, [
      "inventoryId",
      "snapshotId",
      "status",
      "resultRevision",
      "expectedCount",
      "verifiedCount",
      "missingCount",
      "protectedCount",
      "protectedFoundCount",
      "ineligibleCount",
      "unknownCount",
      "dateMismatchCount",
      "voidedCount",
      "oldBoxCount",
      "newBoxCount",
      "invalidatedBoxCount",
      "pendingEventCount",
      "openBoxCount",
      "boxTotal",
      "boxesTruncated",
      "participants",
      "boxes",
      "recentEvents",
    ]);
    const discrepancies = responseSchema(document, "/inventories/{id}/discrepancies");
    exactObject(discrepancies, ["page", "pageSize", "total", "hasMore", "items"]);
    exactObject(discrepancies.properties!.items!.items!, [
      "category",
      "displayIdentity",
      "codeHash",
      "sscc",
      "found",
      "sourceStatus",
      "sourceProductionDate",
      "observedProductionDate",
      "winner",
    ]);
    const evidence = responseSchema(document, "/inventories/{id}/evidence");
    exactObject(evidence, ["page", "pageSize", "total", "hasMore", "items"]);
    exactObject(evidence.properties!.items!.items!, [
      "eventId",
      "codeResultId",
      "kind",
      "displayIdentity",
      "authoritativeVerdict",
      "terminalId",
      "terminalName",
      "scannedAt",
      "classification",
      "observedProductionDate",
      "actions",
    ]);
    const serialized = JSON.stringify({ progress, discrepancies, evidence });
    expect(serialized).not.toMatch(
      /rawPayload|canonicalRaw|objectKey|credential|apiKey|batchId|operatorId/i,
    );
  });
});

function withMutationAfterFirstExecute(db: Db, mutate: () => Promise<void>): Db {
  let executed = false;
  const interceptExecute = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(current, property, receiver) {
        const value = Reflect.get(current, property, receiver);
        if (typeof value !== "function") return value;
        if (property !== "execute") return value.bind(current);
        return async (...args: unknown[]) => {
          const result: unknown = await Reflect.apply(value, current, args);
          if (!executed) {
            executed = true;
            await mutate();
          }
          return result;
        };
      },
    });

  return new Proxy(db, {
    get(current, property, receiver) {
      if (property === "transaction") {
        return <T>(
          callback: (tx: DbTransaction) => Promise<T>,
          config?: DbTransactionConfig,
        ): Promise<T> => current.transaction((tx) => callback(interceptExecute(tx)), config);
      }
      const value = Reflect.get(current, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "execute") return Reflect.get(interceptExecute(current), property);
      return value.bind(current);
    },
  });
}

function responseSchema(document: OpenAPIObject, path: string): JsonSchema {
  const operation = document.paths[path]?.get;
  expect(operation, `missing GET ${path}`).toBeDefined();
  const response = operation!.responses["200"];
  if (!response || "$ref" in response) throw new Error(`Missing inline 200 response for ${path}`);
  const schema = (response.content as Record<string, { schema?: JsonSchema }> | undefined)?.[
    "application/json"
  ]?.schema;
  if (!schema) throw new Error(`Missing JSON response for ${path}`);
  return schema;
}

function exactObject(schema: JsonSchema, fields: readonly string[]): void {
  expect(schema.type).toBe("object");
  expect(schema.additionalProperties).toBe(false);
  expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...fields].sort());
  expect([...(schema.required ?? [])].sort()).toEqual([...fields].sort());
}
